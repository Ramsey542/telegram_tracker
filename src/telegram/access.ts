import { InlineKeyboard } from 'grammy';
import type { User } from 'grammy/types';
import { z } from 'zod';
import type { Store } from '../infra/store.js';
import { unpackSettingsCallback } from './settings-scope.js';

export const watcherUsernameSchema = z
  .string()
  .trim()
  .refine((value) => value !== '@')
  .transform((value) => value.replace(/^@/, '').toLowerCase())
  .pipe(z.string().regex(/^(?:[a-z][a-z0-9_]{0,31})?$/))
  .default('');

export type AccessRole = 'owner' | 'watcher';
const watcherActions = new Set([
  'home',
  'chain',
  'menu',
  'exit',
  'wallets',
  'positions',
  'positionsrefresh',
  'position',
  'refresh',
  'history',
  'pnl',
  'pnlquotes',
  'blocklist',
  'recent',
  'channels',
  'channelpick',
  'channelview',
]);
const watcherCommands = new Set([
  'start',
  'settings',
  'wallets',
  'positions',
  'history',
  'pnl',
  'cancel',
  'help',
  'channels',
]);

export function watcherCallbackAllowed(data: string): boolean {
  return watcherActions.has(unpackSettingsCallback(data).data.split(':')[0] ?? '');
}

export function watcherCommandAllowed(text: string): boolean {
  const command = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s|$)/i.exec(text)?.[1]?.toLowerCase();
  return command !== undefined && watcherCommands.has(command);
}

export function watcherKeyboard(keyboard: InlineKeyboard): InlineKeyboard {
  return new InlineKeyboard(
    keyboard.inline_keyboard
      .map((row) =>
        row.filter(
          (button) => !('callback_data' in button) || watcherCallbackAllowed(button.callback_data),
        ),
      )
      .filter((row) => row.length > 0),
  );
}

export class BotAccess {
  private readonly watcherUsername: string;
  constructor(
    private readonly ownerId: number,
    watcherUsername: string,
    private readonly store: Pick<Store, 'metadata' | 'setMetadata'>,
  ) {
    this.watcherUsername = watcherUsernameSchema.parse(watcherUsername);
  }
  watcherId(): number | null {
    if (!this.watcherUsername) return null;
    const stored = this.store.metadata(`access:watcher:${this.watcherUsername}`);
    const id = stored && /^\d+$/.test(stored) ? Number(stored) : null;
    return id !== null && Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  role(
    user: Pick<User, 'id' | 'username' | 'is_bot'> | undefined,
    chatType: string | undefined,
  ): AccessRole | null {
    if (
      !user ||
      user.is_bot ||
      !Number.isSafeInteger(user.id) ||
      user.id <= 0 ||
      chatType !== 'private'
    )
      return null;
    if (user.id === this.ownerId) return 'owner';
    if (!this.watcherUsername) return null;
    const boundId = this.watcherId();
    if (this.store.metadata(`access:watcher:${this.watcherUsername}`) !== null)
      return user.id === boundId ? 'watcher' : null;
    if (user.username?.toLowerCase() !== this.watcherUsername) return null;
    this.store.setMetadata(`access:watcher:${this.watcherUsername}`, String(user.id));
    return 'watcher';
  }
  recipients(): number[] {
    const watcherId = this.watcherId();
    return watcherId === null || watcherId === this.ownerId
      ? [this.ownerId]
      : [this.ownerId, watcherId];
  }
}
