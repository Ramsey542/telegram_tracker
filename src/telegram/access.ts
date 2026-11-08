import type { User } from 'grammy/types';
import { z } from 'zod';
import type { Store } from '../infra/store.js';

export const watcherUsernameSchema = z
  .string()
  .trim()
  .refine((value) => value !== '@')
  .transform((value) => value.replace(/^@/, '').toLowerCase())
  .pipe(z.string().regex(/^(?:[a-z][a-z0-9_]{0,31})?$/))
  .default('');

export type AccessRole = 'owner' | 'watcher';

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
  canControl(userId: number): boolean {
    return (
      Number.isSafeInteger(userId) &&
      userId > 0 &&
      (userId === this.ownerId || userId === this.watcherId())
    );
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
