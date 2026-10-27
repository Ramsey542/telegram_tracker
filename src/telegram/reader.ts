import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Api, TelegramClient, utils, Logger as TelegramLogger } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import {
  NewMessage,
  EditedMessage,
  type NewMessageEvent,
  type EditedMessageEvent,
} from 'teleproto/events';
import type { Config } from '../config.js';
import { chains, type ChannelPost, type CallSignal } from '../domain.js';
import type { Wallets } from '../wallets.js';
import { atomicWrite } from '../wallets.js';
import { Store } from '../infra/store.js';
import { safeError } from '../infra/http.js';
import { parseCall } from './parser.js';
import { logger, withLogContext } from '../logging/logger.js';

const log = logger.child({ component: 'telegram.reader', service: 'Telegram MTProto' });
const signalLog = logger.child({ component: 'trading.signals' });
const apiLog = logger.child({ component: 'api.telegram_mtproto', service: 'Telegram MTProto' });

export class ChannelReader {
  private client: TelegramClient | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private ready = false;
  constructor(
    private readonly config: Config,
    private readonly wallets: Wallets,
    private readonly store: Store,
    private readonly wake: (signal?: CallSignal) => void,
  ) {}
  private async request<T>(clientMethod: string, action: () => Promise<T>): Promise<T> {
    const fields = { requestId: randomUUID(), clientMethod, source: this.config.sourceChannel };
    const started = Date.now();
    apiLog.debug('api.request', fields);
    try {
      const result = await action();
      apiLog.debug('api.response', { ...fields, durationMs: Date.now() - started });
      return result;
    } catch (error) {
      apiLog.error('api.mtproto_failed', error, { ...fields, durationMs: Date.now() - started });
      throw error;
    }
  }
  async start(): Promise<void> {
    log.debug('reader.starting', {
      source: this.config.sourceChannel,
      listenOnly: this.config.listenOnly,
    });
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
    log.debug('reader.session', { reused: saved.length > 0 });
    const baseLogger = new TelegramLogger(
      'info' as ConstructorParameters<typeof TelegramLogger>[0],
    );
    baseLogger.handler = (record) => {
      const fields = { message: record.message, error: record.error };
      if (record.level === 'error')
        log.error('reader.transport_error', record.error ?? record.message, fields);
      else if (record.level === 'warn') log.warn('reader.transport_warning', fields);
      else if (record.level === 'debug') log.debug('reader.transport', fields);
      else log.debug('reader.transport', fields);
    };
    const client = new TelegramClient(
      session,
      this.config.telegramApiId,
      this.config.telegramApiHash,
      { connectionRetries: 5, autoReconnect: true, baseLogger },
    );
    client.onConnect(() => log.debug('reader.connected'));
    client.onDisconnect(() => log.warn('reader.disconnected'));
    client.onReconnecting(() => log.warn('reader.reconnecting'));
    client.onReconnect(() => log.debug('reader.reconnected'));
    client.onError = async (error) => {
      log.error('reader.client_failed', error);
    };
    this.client = client;
    const input = createInterface({ input: stdin, output: stdout });
    const prompt = async (label: string): Promise<string> => {
      if (!stdin.isTTY) throw new Error('First Telegram login requires an interactive terminal');
      return (await input.question(label)).trim();
    };
    try {
      await this.request('start', () =>
        client.start({
          phoneNumber: this.config.telegramPhone,
          phoneCode: () => prompt('Telegram login code: '),
          password: () => prompt('Telegram two-step verification password: '),
          onError: (error) => {
            log.error('reader.login_failed', error);
            throw error;
          },
        }),
      );
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
    const entity = await this.request('getEntity', () =>
      client.getEntity(this.config.sourceChannel),
    );
    if (!(entity instanceof Api.Channel) || !entity.broadcast)
      throw new Error('Configured Telegram source is not a broadcast channel');
    if (entity.left)
      await this.request('channels.JoinChannel', () =>
        client.invoke(new Api.channels.JoinChannel({ channel: utils.getInputChannel(entity) })),
      );
    const channelId = utils.getPeerId(entity).toString();
    this.ready = true;
    log.debug('reader.channel_resolved', { channelId, source: this.config.sourceChannel });
    const ingest = async (event: NewMessageEvent | EditedMessageEvent): Promise<void> => {
      if (event.message.peerId && utils.getPeerId(event.message.peerId).toString() === channelId) {
        try {
          this.record(event.message, channelId);
        } catch (error) {
          log.error('reader.ingest_failed', error, { channelId, messageId: event.message.id });
          throw error;
        }
      }
    };
    client.addEventHandler(ingest, new NewMessage({ chats: [entity] }));
    client.addEventHandler(ingest, new EditedMessage({ chats: [entity] }));
    const cursorKey = `cursor:${channelId}`;
    if (this.store.metadata(cursorKey) === null) {
      const messages = await this.request('getMessages', () =>
        client.getMessages(entity, { limit: 1 }),
      );
      this.store.setMetadata(cursorKey, String(messages[0]?.id ?? 0));
      log.debug('reader.cursor_initialized', {
        channelId,
        cursor: messages[0]?.id ?? 0,
        reason: 'start_with_new_posts_only',
      });
    }
    const poll = async (): Promise<void> => {
      if (this.polling) return;
      this.polling = true;
      const started = Date.now();
      let captured = 0;
      try {
        let cursor = Number(this.store.metadata(cursorKey) ?? '0');
        for (let page = 0; page < 5; page++) {
          const messages = await this.request('getMessages', () =>
            client.getMessages(entity, {
              minId: cursor,
              reverse: true,
              limit: 100,
            }),
          );
          for (const message of messages) {
            if (!(message instanceof Api.Message) || message.id <= cursor) continue;
            this.record(message, channelId);
            captured++;
            cursor = message.id;
            this.store.setMetadata(cursorKey, String(cursor));
          }
          if (messages.length < 100) break;
        }
        this.store.setMetadata('reader:last-success', String(Date.now()));
        log.debug('reader.poll_success', {
          channelId,
          cursor,
          captured,
          durationMs: Date.now() - started,
        });
      } catch (error) {
        log.error('reader.poll_failed', error, {
          channelId,
          source: this.config.sourceChannel,
          durationMs: Date.now() - started,
        });
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
    const enabled = chains
      .filter((chain) => this.store.settings().chains[chain].enabled)
      .map((chain) => (chain === 'solana' ? 'Solana' : 'Robinhood'));
    this.store.notify(
      `reader-start:${process.pid}`,
      `Connected to ${this.config.sourceChannel}. ${this.config.listenOnly ? 'LISTEN ONLY: all trading is blocked.' : `Enabled buy chains: ${enabled.join(', ') || 'none'}. Each chain is controlled in its own settings.`}`,
    );
  }
  private sourcePost(message: Api.Message, channelId: string): ChannelPost {
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
    return {
      channelId,
      messageId: message.id,
      date: message.date * 1000,
      text: message.message,
      urls,
      revision: message.editDate ?? message.date,
    };
  }
  async hydrateHistory(messageIds: number[]): Promise<void> {
    const client = this.client;
    if (!client || !this.ready || messageIds.length === 0) return;
    const messages = await this.request('getMessages', () =>
      client.getMessages(this.config.sourceChannel, { ids: messageIds }),
    );
    for (const message of messages) {
      if (!(message instanceof Api.Message) || !message.peerId) continue;
      this.store.saveSourcePost(
        this.sourcePost(message, utils.getPeerId(message.peerId).toString()),
      );
    }
  }
  private record(message: Api.Message, channelId: string): void {
    const post = this.sourcePost(message, channelId);
    const parsed = parseCall(post);
    const changed = this.store.recordPost(
      post,
      parsed.ok ? parsed.signal : null,
      parsed.ok ? null : parsed.reason,
    );
    withLogContext(
      {
        source: this.config.sourceChannel,
        channelId,
        messageId: message.id,
        signalId: `${channelId}:${message.id}`,
      },
      () => {
        if (!changed) {
          log.debug('reader.message_duplicate', { revision: post.revision });
          return;
        }
        signalLog.info('signal.received', {
          date: new Date(post.date).toISOString(),
          revision: post.revision,
          urls: post.urls,
          textLength: post.text.length,
        });
        signalLog.debug('signal.content', { text: post.text });
        if (parsed.ok) signalLog.info('signal.parsed', { signal: parsed.signal });
        else
          signalLog.info('signal.skipped', {
            decision: 'skipped',
            reason: parsed.reason,
            text: post.text,
          });
        this.wake(parsed.ok ? parsed.signal : undefined);
      },
    );
  }
  async stop(): Promise<void> {
    this.ready = false;
    log.debug('reader.stopping');
    if (this.timer) clearInterval(this.timer);
    await this.client?.disconnect();
    while (this.polling) await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
