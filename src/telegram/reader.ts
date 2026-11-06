import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Api, TelegramClient, utils, Logger as TelegramLogger } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { type NewMessageEvent, type EditedMessageEvent } from 'teleproto/events';
import { channelEvents } from './channel-events.js';
import type { Config } from '../config.js';
import {
  chains,
  chainLabel,
  type ChannelPost,
  type CallSignal,
  type CallChannel,
} from '../domain.js';
import { ChannelRegistry } from './channel-registry.js';
import { parseGeneralCall } from './generic-parser.js';
import { senderFilterRejection, senderIdentity } from './sender-filter.js';
import type { MarketData } from '../providers/market.js';
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
  private stopped = false;
  private readonly ingesting = new Set<Promise<void>>();
  private readonly pollRetryAt = new Map<string, number>();
  readonly channels: ChannelRegistry;
  constructor(
    private readonly config: Config,
    private readonly wallets: Wallets,
    private readonly store: Store,
    private readonly wake: (signal?: CallSignal) => void,
    private readonly market?: MarketData,
  ) {
    this.store.seedCallChannels(config.sourceChannel);
    this.channels = new ChannelRegistry(store);
  }
  private async request<T>(
    clientMethod: string,
    action: () => Promise<T>,
    source = this.config.sourceChannel,
  ): Promise<T> {
    const fields = { requestId: randomUUID(), clientMethod, source };
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
    const account = await this.request('getMe', () => client.getMe());
    if (account.id.toString() !== String(this.config.ownerId))
      throw new Error(
        'Telegram channel reader is logged into a different account. Set TELEGRAM_PHONE to the owner phone, back up the Telegram session file, and log in again.',
      );
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
    this.channels.attach(client);
    this.ready = true;
    const ingest = async (event: NewMessageEvent | EditedMessageEvent): Promise<void> => {
      if (!event.message.peerId || this.stopped) return;
      const source = this.channels.source(utils.getPeerId(event.message.peerId).toString());
      if (!source) return;
      const work = this.record(event.message, source.channel);
      this.ingesting.add(work);
      try {
        await work;
      } catch (error) {
        log.error('reader.ingest_failed', error, {
          channelId: source.channel.channelId,
          messageId: event.message.id,
        });
      } finally {
        this.ingesting.delete(work);
      }
    };
    for (const event of channelEvents()) client.addEventHandler(ingest, event);
    const poll = async (): Promise<void> => {
      if (this.polling || this.stopped) return;
      this.polling = true;
      try {
        await this.channels.refresh();
        for (const source of this.channels.list()) {
          if (this.stopped) break;
          if (Date.now() < (this.pollRetryAt.get(source.channel.id) ?? 0)) continue;
          const channelId = source.channel.channelId!;
          const cursorKey = `cursor:${channelId}`;
          let cursor = Number(this.store.metadata(cursorKey) ?? '0');
          try {
            for (let page = 0; page < 5 && !this.stopped; page++) {
              const messages = await this.request(
                'getMessages',
                () =>
                  client.getMessages(source.entity, { minId: cursor, reverse: true, limit: 100 }),
                source.channel.title,
              );
              for (const message of messages) {
                if (!(message instanceof Api.Message) || message.id <= cursor || this.stopped)
                  continue;
                await this.record(message, source.channel);
                cursor = message.id;
                this.store.setMetadata(cursorKey, String(cursor));
              }
              if (messages.length < 100) break;
            }
            this.store.setMetadata(`reader:last-success:${source.channel.id}`, String(Date.now()));
            this.store.setMetadata('reader:last-success', String(Date.now()));
            this.pollRetryAt.delete(source.channel.id);
            const current = this.store.callChannel(source.channel.id);
            if (current?.error) {
              current.error = null;
              this.store.saveCallChannel(current);
            }
          } catch (error) {
            this.pollRetryAt.set(source.channel.id, Date.now() + 30_000);
            const current = this.store.callChannel(source.channel.id);
            if (current) {
              current.error = safeError(error);
              this.store.saveCallChannel(current);
            }
            log.error('reader.poll_failed', error, { channelId, source: source.channel.title });
            this.store.notify(
              `reader:${source.channel.id}:${Math.floor(Date.now() / 300_000)}`,
              `Cannot read ${source.channel.title}: ${safeError(error)}`,
            );
          }
        }
      } catch (error) {
        log.error('reader.refresh_failed', error);
      } finally {
        this.polling = false;
      }
    };
    await poll();
    this.timer = setInterval(() => {
      void poll();
    }, 10_000);
    const enabled = chains
      .filter((chain) => this.store.entriesEnabled(chain))
      .map((chain) => chainLabel[chain]);
    this.store.notify(
      `reader-start:${process.pid}`,
      `Telegram reader connected. Monitored channels: ${this.channels.list().length}. ${this.config.listenOnly ? 'LISTEN ONLY: all trading is blocked.' : `Enabled buy chains: ${enabled.join(', ') || 'none'}. Each chain is controlled in its own settings.`}`,
    );
  }
  private sourcePost(message: Api.Message, source: CallChannel): ChannelPost {
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
      channelId: source.channelId!,
      sourceId: source.id,
      sourceName: source.title,
      mode: source.mode,
      messageId: message.id,
      date: message.date * 1000,
      text: message.message,
      urls,
      revision: message.editDate ?? message.date,
      ...senderIdentity(message),
    };
  }
  async hydrateHistory(references: { channelId: string; messageId: number }[]): Promise<void> {
    const client = this.client;
    if (!client || !this.ready || references.length === 0) return;
    for (const channelId of new Set(references.map((ref) => ref.channelId))) {
      const source = this.channels.source(channelId);
      if (!source) continue;
      const messages = await this.request(
        'getMessages',
        () =>
          client.getMessages(source.entity, {
            ids: references
              .filter((ref) => ref.channelId === channelId)
              .map((ref) => ref.messageId),
          }),
        source.channel.title,
      );
      for (const message of messages)
        if (message instanceof Api.Message)
          this.store.saveSourcePost(this.sourcePost(message, source.channel));
    }
  }
  private async record(message: Api.Message, source: CallChannel): Promise<void> {
    const detectedAt = Date.now();
    const post = this.sourcePost(message, source);
    if (this.store.alreadyRecorded(post)) return;
    if (post.senderId && !post.senderUsername) {
      try {
        Object.assign(post, senderIdentity(message, await message.getSender()));
      } catch (error) {
        signalLog.error('signal.sender_lookup_failed', error, {
          source: source.title,
          channelId: post.channelId,
          messageId: post.messageId,
          senderId: post.senderId,
        });
      }
    }
    const current = this.store.callChannel(source.id);
    if (!current) return;
    source = current;
    let parsed;
    try {
      const senderRejection = senderFilterRejection(source, post);
      parsed = senderRejection
        ? { ok: false as const, reason: senderRejection }
        : source.mode === 'spydefi'
          ? parseCall(post)
          : await parseGeneralCall(post, source, (chain, address) => {
              if (!this.market) throw new Error('Pair lookup is unavailable');
              return this.market.pair(chain, address);
            });
    } catch (error) {
      signalLog.error('signal.extraction_failed', error, {
        source: source.title,
        channelId: source.channelId,
        messageId: post.messageId,
      });
      parsed = { ok: false as const, reason: `Contract extraction failed: ${safeError(error)}` };
    }
    if (this.stopped) return;
    if (parsed.ok)
      Object.assign(parsed.signal, {
        sourceId: source.id,
        sourceName: source.title,
        mode: source.mode,
        senderId: post.senderId,
        senderUsername: post.senderUsername,
      });
    withLogContext(
      {
        source: source.title,
        channelId: source.channelId!,
        messageId: message.id,
        signalId: `${source.channelId}:${message.id}`,
        senderId: post.senderId,
        senderUsername: post.senderUsername,
      },
      () => {
        const changed = this.store.recordPost(
          post,
          parsed.ok ? parsed.signal : null,
          parsed.ok ? null : parsed.reason,
          detectedAt,
        );
        if (!changed) {
          log.debug('reader.message_duplicate', { revision: post.revision });
          return;
        }
        signalLog.info('signal.received', {
          date: new Date(post.date).toISOString(),
          revision: post.revision,
          urls: post.urls,
          textLength: post.text.length,
          senderId: post.senderId,
          senderUsername: post.senderUsername,
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
    this.stopped = true;
    this.ready = false;
    log.debug('reader.stopping');
    if (this.timer) clearInterval(this.timer);
    await this.client?.disconnect();
    await this.channels.stop();
    while (this.polling || this.ingesting.size > 0)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
