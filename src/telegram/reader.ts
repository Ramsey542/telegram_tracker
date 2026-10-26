import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Api, TelegramClient, utils } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import {
  NewMessage,
  EditedMessage,
  type NewMessageEvent,
  type EditedMessageEvent,
} from 'teleproto/events';
import type { Config } from '../config.js';
import type { ChannelPost } from '../domain.js';
import type { Wallets } from '../wallets.js';
import { atomicWrite } from '../wallets.js';
import { Store } from '../infra/store.js';
import { safeError } from '../infra/http.js';
import { parseCall } from './parser.js';

export class ChannelReader {
  private client: TelegramClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  constructor(
    private readonly config: Config,
    private readonly wallets: Wallets,
    private readonly store: Store,
    private readonly wake: () => void,
  ) {}
  async start(): Promise<void> {
    const sessionPath = join(this.config.dataDirectory, 'telegram.session.enc.json');
    let saved = '';
    if (existsSync(sessionPath)) {
      const value = JSON.parse(readFileSync(sessionPath, 'utf8')) as {
        iv: string;
        tag: string;
        ciphertext: string;
      };
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.wallets.encryptionKey,
        Buffer.from(value.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      saved = Buffer.concat([
        decipher.update(Buffer.from(value.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
    }
    const session = new StringSession(saved);
    const client = new TelegramClient(
      session,
      this.config.telegramApiId,
      this.config.telegramApiHash,
      { connectionRetries: 5, autoReconnect: true },
    );
    client.setLogLevel('none' as Parameters<TelegramClient['setLogLevel']>[0]);
    this.client = client;
    const input = createInterface({ input: stdin, output: stdout });
    const prompt = async (label: string): Promise<string> => {
      if (!stdin.isTTY) throw new Error('First Telegram login requires an interactive terminal');
      return (await input.question(label)).trim();
    };
    try {
      await client.start({
        phoneNumber: this.config.telegramPhone,
        phoneCode: () => prompt('Telegram login code: '),
        password: () => prompt('Telegram two-step verification password: '),
        onError: () => {
          throw new Error('Telegram login failed');
        },
      });
    } finally {
      input.close();
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.wallets.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(session.save(), 'utf8'), cipher.final()]);
    atomicWrite(
      sessionPath,
      JSON.stringify({
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64'),
      }),
    );
    const entity = await client.getEntity(this.config.sourceChannel);
    if (!(entity instanceof Api.Channel) || !entity.broadcast)
      throw new Error('Configured Telegram source is not a broadcast channel');
    if (entity.left)
      await client.invoke(new Api.channels.JoinChannel({ channel: utils.getInputChannel(entity) }));
    const channelId = utils.getPeerId(entity).toString();
    const ingest = async (event: NewMessageEvent | EditedMessageEvent): Promise<void> => {
      if (event.message.peerId && utils.getPeerId(event.message.peerId).toString() === channelId)
        this.record(event.message, channelId);
    };
    client.addEventHandler(ingest, new NewMessage({ chats: [entity] }));
    client.addEventHandler(ingest, new EditedMessage({ chats: [entity] }));
    const cursorKey = `cursor:${channelId}`;
    if (this.store.metadata(cursorKey) === null) {
      const messages = await client.getMessages(entity, { limit: 1 });
      this.store.setMetadata(cursorKey, String(messages[0]?.id ?? 0));
    }
    const poll = async (): Promise<void> => {
      if (this.polling) return;
      this.polling = true;
      try {
        let cursor = Number(this.store.metadata(cursorKey) ?? '0');
        for (let page = 0; page < 5; page++) {
          const messages = await client.getMessages(entity, {
            minId: cursor,
            reverse: true,
            limit: 100,
          });
          for (const message of messages) {
            if (!(message instanceof Api.Message) || message.id <= cursor) continue;
            this.record(message, channelId);
            cursor = message.id;
            this.store.setMetadata(cursorKey, String(cursor));
          }
          if (messages.length < 100) break;
        }
        this.store.setMetadata('reader:last-success', String(Date.now()));
      } catch (error) {
        this.store.notify(
          `reader:${Math.floor(Date.now() / 300_000)}`,
          `Telegram reader issue: ${safeError(error)}`,
        );
      } finally {
        this.polling = false;
      }
    };
    await poll();
    this.timer = setInterval(() => {
      void poll();
    }, 10_000);
    this.store.notify(
      `reader-start:${process.pid}`,
      `Connected to ${this.config.sourceChannel}. New entry trading is ${this.store.settings().tradingEnabled ? 'enabled' : 'paused'}.`,
    );
  }
  private record(message: Api.Message, channelId: string): void {
    const urls: string[] = [];
    for (const entity of message.entities ?? []) {
      if (entity instanceof Api.MessageEntityTextUrl) urls.push(entity.url);
      else if (entity instanceof Api.MessageEntityUrl)
        urls.push(message.message.slice(entity.offset, entity.offset + entity.length));
    }
    if (message.replyMarkup instanceof Api.ReplyInlineMarkup)
      for (const row of message.replyMarkup.rows)
        for (const button of row.buttons)
          if (button.type instanceof Api.InlineButtonTypeUrl) urls.push(button.type.url);
    const post: ChannelPost = {
      channelId,
      messageId: message.id,
      date: message.date * 1000,
      text: message.message,
      urls,
      revision: message.editDate ?? message.date,
    };
    const parsed = parseCall(post);
    this.store.recordPost(post, parsed.ok ? parsed.signal : null, parsed.ok ? null : parsed.reason);
    this.wake();
  }
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.client?.disconnect();
    while (this.polling) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
