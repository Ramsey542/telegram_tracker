import { Api, TelegramClient, utils } from 'teleproto';
import type { CallChannel } from '../domain.js';
import type { Store } from '../infra/store.js';
import { safeError } from '../infra/http.js';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'telegram.channels' });
export interface ChannelTarget {
  target: string;
  inviteHash: string | null;
  username: string | null;
}
export function channelTarget(input: string): ChannelTarget {
  const value = input.trim();
  if (/^@?[A-Za-z][A-Za-z0-9_]{0,31}$/.test(value)) {
    const username = value.replace(/^@/, '').toLowerCase();
    return { target: username, username, inviteHash: null };
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    throw new Error('Enter a Telegram channel username or t.me invite link');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !['t.me', 'telegram.me', 'www.t.me'].includes(url.hostname.toLowerCase())
  )
    throw new Error('Use a Telegram channel username or t.me link');
  const parts = url.pathname.split('/').filter(Boolean);
  const hash = parts[0]?.startsWith('+')
    ? parts[0].slice(1)
    : parts[0] === 'joinchat'
      ? parts[1]
      : null;
  if (hash && /^[A-Za-z0-9_-]+$/.test(hash))
    return { target: `https://t.me/+${hash}`, inviteHash: hash, username: null };
  if (parts.length === 1 && /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(parts[0] ?? ''))
    return channelTarget(parts[0]!);
  throw new Error('Use the channel link itself, not a message or group topic link');
}

export interface ActiveChannel {
  channel: CallChannel;
  entity: Api.Channel;
}
export class ChannelRegistry {
  private client: TelegramClient | null = null;
  private readonly active = new Map<string, ActiveChannel>();
  private readonly retryAt = new Map<string, number>();
  private syncing: Promise<void> | null = null;
  private stopped = false;
  private readonly work = new Set<Promise<void>>();
  constructor(private readonly store: Store) {}
  attach(client: TelegramClient): void {
    this.client = client;
  }
  source(channelId: string): ActiveChannel | null {
    const entry = [...this.active.values()].find((value) => value.channel.channelId === channelId);
    if (!entry) return null;
    const current = this.store.callChannel(entry.channel.id);
    return current?.enabled &&
      current.status === 'ready' &&
      current.activatedAt === entry.channel.activatedAt
      ? { ...entry, channel: current }
      : null;
  }
  list(): ActiveChannel[] {
    return [...this.active.values()].flatMap((entry) => {
      const channel = this.store.callChannel(entry.channel.id);
      return channel?.enabled &&
        channel.status === 'ready' &&
        channel.activatedAt === entry.channel.activatedAt
        ? [{ ...entry, channel }]
        : [];
    });
  }
  async add(input: string): Promise<CallChannel> {
    const target = channelTarget(input);
    if (this.store.callChannels().some((channel) => channel.target === target.target))
      throw new Error('This channel is already configured');
    const channel: CallChannel = {
      id: this.store.newId(),
      target: target.target,
      channelId: null,
      title: target.username ?? 'Private channel',
      username: target.username,
      mode:
        target.target === this.store.metadata('channels:spydefi-target') ? 'spydefi' : 'general',
      defaultChain: null,
      enabled: false,
      activatedAt: Date.now(),
      status: 'unresolved',
      error: null,
    };
    this.store.saveCallChannel(channel);
    if (this.client) this.schedule(channel);
    return channel;
  }
  refresh(): Promise<void> {
    this.syncing ??= this.synchronize().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }
  async retry(id: string): Promise<void> {
    this.active.delete(id);
    this.retryAt.delete(id);
    const channel = this.store.callChannel(id);
    if (channel) {
      channel.status = 'unresolved';
      channel.error = null;
      this.store.saveCallChannel(channel);
      this.schedule(channel);
    }
  }
  private schedule(channel: CallChannel): void {
    const operation = this.resolve(channel);
    this.work.add(operation);
    void operation
      .catch((error) => log.error('channel.resolve_failed', error, { source: channel.title }))
      .finally(() => this.work.delete(operation));
  }
  async idle(): Promise<void> {
    await Promise.allSettled([...this.work, ...(this.syncing ? [this.syncing] : [])]);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }
  private async synchronize(): Promise<void> {
    const channels = this.store.callChannels();
    for (const id of this.active.keys())
      if (!channels.some((channel) => channel.id === id && channel.enabled)) this.active.delete(id);
    for (const channel of channels) {
      if (this.stopped) break;
      if (!channel.enabled || Date.now() < (this.retryAt.get(channel.id) ?? 0)) continue;
      const current = this.active.get(channel.id);
      if (
        current &&
        current.channel.activatedAt === channel.activatedAt &&
        channel.status === 'ready'
      )
        continue;
      await this.resolve(channel);
    }
  }
  private async resolve(channel: CallChannel): Promise<void> {
    const client = this.client;
    if (!client || this.stopped) return;
    this.active.delete(channel.id);
    try {
      const target = channelTarget(channel.target);
      let entity;
      if (target.inviteHash) {
        let invite = await client.invoke(
          new Api.messages.CheckChatInvite({ hash: target.inviteHash }),
        );
        if (!(invite instanceof Api.ChatInviteAlready)) {
          if (invite instanceof Api.ChatInvite && !invite.broadcast)
            throw new Error('Only broadcast channels are supported');
          if (
            invite instanceof Api.ChatInvitePeek &&
            (!(invite.chat instanceof Api.Channel) || !invite.chat.broadcast)
          )
            throw new Error('Only broadcast channels are supported');
          await client.invoke(new Api.messages.ImportChatInvite({ hash: target.inviteHash }));
          invite = await client.invoke(
            new Api.messages.CheckChatInvite({ hash: target.inviteHash }),
          );
        }
        if (!(invite instanceof Api.ChatInviteAlready))
          throw new Error('Channel access is not ready');
        entity = invite.chat;
      } else entity = await client.getEntity(target.username!);
      if (!(entity instanceof Api.Channel) || !entity.broadcast)
        throw new Error('Only broadcast channels are supported');
      const channelId = utils.getPeerId(entity).toString();
      if (
        this.store
          .callChannels()
          .some((other) => other.id !== channel.id && other.channelId === channelId)
      )
        throw new Error('This channel is already configured under another link');
      if (entity.left)
        await client.invoke(
          new Api.channels.JoinChannel({ channel: utils.getInputChannel(entity) }),
        );
      let current = this.store.callChannel(channel.id);
      if (!current || this.stopped) return;
      const cursorKey = `cursor:${channelId}`;
      const activationKey = `channel:activation:${current.id}`;
      if (
        this.store.metadata(cursorKey) === null ||
        (this.store.metadata(activationKey) !== String(current.activatedAt) &&
          current.activatedAt !== 0)
      ) {
        const latest = await client.getMessages(entity, { limit: 1 });
        const fresh = this.store.callChannel(current.id);
        if (
          !fresh ||
          fresh.enabled !== current.enabled ||
          fresh.activatedAt !== current.activatedAt ||
          fresh.defaultChain !== current.defaultChain
        )
          return;
        current = fresh;
        this.store.setMetadata(cursorKey, String(latest[0]?.id ?? 0));
      }
      current.channelId = channelId;
      if (current.mode === 'spydefi') this.store.setMetadata('channels:spydefi-id', channelId);
      else if (this.store.metadata('channels:spydefi-id') === channelId) current.mode = 'spydefi';
      current.title = entity.title;
      current.username = entity.username?.toLowerCase() ?? null;
      this.store.setMetadata(activationKey, String(current.activatedAt));
      current.status = 'ready';
      current.error = null;
      this.store.saveCallChannel(current);
      if (current.enabled) this.active.set(current.id, { channel: current, entity });
      this.store.notify(
        `channel-ready:${current.id}:${current.activatedAt}`,
        `Channel ready: ${current.title}. Monitoring: ${current.enabled ? 'enabled' : 'disabled; review the channel settings before enabling'}.`,
      );
      log.info('channel.ready', {
        channelId,
        source: current.title,
        enabled: current.enabled,
        mode: current.mode,
      });
    } catch (error) {
      const current = this.store.callChannel(channel.id);
      if (!current) return;
      const pending = /INVITE_REQUEST_SENT/.test(safeError(error));
      current.status = pending ? 'pending' : 'error';
      current.error = pending
        ? 'Join request sent; waiting for channel approval'
        : safeError(error);
      this.store.saveCallChannel(current);
      this.retryAt.set(current.id, Date.now() + 30_000);
      if (pending) log.info('channel.access_pending', { source: current.title });
      else
        log.error('channel.access_failed', error, {
          source: current.title,
          channelId: current.channelId,
          service: 'Telegram MTProto',
        });
    }
  }
}
