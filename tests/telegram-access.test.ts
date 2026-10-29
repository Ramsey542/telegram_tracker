import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InlineKeyboard } from 'grammy';
import type { Update } from 'grammy/types';
import type { Config } from '../src/config.js';
import { settingsSchema, type Settings } from '../src/domain.js';
import { Store } from '../src/infra/store.js';
import type { TradeEngine } from '../src/trading/engine.js';
import { ControlBot } from '../src/telegram/bot.js';
import {
  BotAccess,
  watcherCallbackAllowed,
  watcherCommandAllowed,
  watcherKeyboard,
  watcherUsernameSchema,
} from '../src/telegram/access.js';

function metadataStore() {
  const values = new Map<string, string>();
  return {
    metadata: (key: string) => values.get(key) ?? null,
    setMetadata: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test('one owner has automatic access and only the configured watcher is admitted in private chats', () => {
  const store = metadataStore();
  const access = new BotAccess(123, '@Watcher_Name', store);
  const owner = { id: 123, is_bot: false };
  const watcher = { id: 456, username: 'WATCHER_NAME', is_bot: false };
  assert.equal(access.role(owner, 'private'), 'owner');
  assert.equal(access.role(owner, 'group'), null);
  assert.equal(access.role(watcher, 'supergroup'), null);
  assert.equal(access.watcherId(), null);
  assert.equal(access.role({ id: 789, username: 'outsider', is_bot: false }, 'private'), null);
  assert.equal(access.role(watcher, 'private'), 'watcher');
  assert.deepEqual(access.recipients(), [123, 456]);
  const restarted = new BotAccess(123, 'watcher_name', store);
  assert.equal(
    restarted.role({ id: 456, username: 'renamed_user', is_bot: false }, 'private'),
    'watcher',
  );
  assert.equal(restarted.role({ ...watcher, id: 789 }, 'private'), null);
  assert.equal(new BotAccess(123, '', store).role(watcher, 'private'), null);
  assert.equal(new BotAccess(123, 'different_user', store).role(watcher, 'private'), null);
});

test('watcher configuration rejects invalid usernames and corrupted identity bindings deny access', () => {
  assert.equal(watcherUsernameSchema.parse(undefined), '');
  assert.equal(watcherUsernameSchema.parse(' @Watcher_Name '), 'watcher_name');
  for (const value of ['@', '123456', 'one,two', 'one two', 'https://t.me/watcher_name'])
    assert.equal(watcherUsernameSchema.safeParse(value).success, false);
  const store = metadataStore();
  store.setMetadata('access:watcher:watcher_name', 'invalid');
  const access = new BotAccess(123, 'watcher_name', store);
  assert.equal(access.role({ id: 456, username: 'watcher_name', is_bot: false }, 'private'), null);
  assert.equal(access.role({ id: 123, is_bot: false }, 'private'), 'owner');
});

test('watcher keyboards retain navigation and explorer links while removing every write action', () => {
  const original = new InlineKeyboard()
    .text('View settings', 'chain:solana')
    .text('Enable entries', 'enable:solana')
    .row()
    .text('Sell', 'sell:position:100')
    .text('Withdraw', 'withdraw:solana')
    .row()
    .text('View exits', 'exit:solana:tp')
    .url('Explorer', 'https://solscan.io/tx/example');
  const filtered = watcherKeyboard(original);
  const callbacks = filtered.inline_keyboard
    .flat()
    .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []));
  assert.deepEqual(callbacks, ['chain:solana', 'exit:solana:tp']);
  assert.equal(original.inline_keyboard.flat().length, 6);
  assert.equal(
    filtered.inline_keyboard.flat().some((button) => 'url' in button),
    true,
  );
  for (const data of [
    'sell:id:100',
    'confirm:id:100',
    'withdrawconfirm:id',
    'unwrapyes',
    'reconcile:id',
    'applyyes:id',
    'exitmode:solana:tp:hard',
    'edit:solana:buySize',
    'unknown',
  ])
    assert.equal(watcherCallbackAllowed(data), false);
  assert.equal(watcherCommandAllowed('/settings'), true);
  assert.equal(watcherCommandAllowed('/pnl@tracker_bot'), true);
  assert.equal(watcherCommandAllowed('0.1'), false);
  assert.equal(watcherCommandAllowed('/withdraw'), false);
});

function botFixture(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Access tests must remain offline'));
  const metadata = metadataStore();
  const settings = settingsSchema.parse({});
  settings.chains.solana.consistency.overall = 42;
  let writes = 0;
  const store = {
    ...metadata,
    settings: () => structuredClone(settings),
    updateSettings: (change: (settings: Settings) => void) => {
      writes++;
      change(settings);
      return structuredClone(settings);
    },
    positions: () => [],
    activeOperation: () => null,
  } as unknown as Store;
  const mutate = async () => {
    writes++;
    throw new Error('Unexpected trade mutation');
  };
  const engine = {
    readiness: () => [],
    sell: mutate,
    unwrap: mutate,
    withdraw: mutate,
    reconcile: mutate,
  } as unknown as TradeEngine;
  const config = {
    ownerId: 123,
    watcherUsername: 'watcher_name',
    botToken: '1000:offline_token',
    httpTimeoutMs: 15000,
    sourceChannel: 'SpyDefiLive',
    listenOnly: false,
  } as Config;
  const control = new ControlBot(config, store, engine);
  control.bot.botInfo = {
    id: 1000,
    username: 'tracker_bot',
    is_bot: true,
    first_name: 'Tracker',
    can_join_groups: false,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  const requests: { method: string; payload: Record<string, unknown> }[] = [];
  control.bot.api.config.use(async (_prev, method, payload) => {
    requests.push({ method, payload });
    return { ok: true, result: true as never };
  });
  let updateId = 0;
  const send = async (userId: number, text: string, callback = false) => {
    const from = {
      id: userId,
      is_bot: false,
      first_name: 'Account',
      username: userId === 456 ? 'watcher_name' : 'other_account',
    };
    const message = {
      message_id: ++updateId,
      date: 1,
      chat: { id: userId, type: 'private' as const, first_name: 'Account' },
      from,
      text,
      ...(text.startsWith('/')
        ? {
            entities: [
              { type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]!.length },
            ],
          }
        : {}),
    };
    const update: Update = callback
      ? {
          update_id: updateId,
          callback_query: {
            id: `query-${updateId}`,
            from,
            chat_instance: 'offline',
            data: text,
            message,
          },
        }
      : { update_id: updateId, message };
    await control.bot.handleUpdate(update);
  };
  return { send, requests, settings, writes: () => writes };
}

test('forged watcher callbacks and text never reach trade or settings handlers', async (t) => {
  const fixture = botFixture(t);
  for (const action of [
    'enable:solana',
    'toggle:solana:mc',
    'edit:solana:buySize',
    'exittoggle:solana:tp',
    'exitmode:solana:tp:hard',
    'exitset:solana:tp',
    'exitdel:solana:tp:stage',
    'addtp:solana',
    'deltp:solana:target',
    'block:add',
    'sell:id:100',
    'confirm:id:100',
    'apply:id',
    'applyyes:id',
    'withdraw:solana',
    'withdrawconfirm:id',
    'unwrap',
    'unwrapyes',
    'reconcile:id',
    'resume',
    'unknown',
  ]) {
    await fixture.send(456, action, true);
  }
  await fixture.send(456, '0.5');
  assert.equal(fixture.writes(), 0);
  const denials = fixture.requests.filter((request) => request.method === 'answerCallbackQuery');
  assert.equal(denials.length, 21);
  assert.ok(denials.every((request) => request.payload.show_alert === true));
  assert.match(String(fixture.requests.at(-1)?.payload.text), /read.only/i);
  const requestCount = fixture.requests.length;
  await fixture.send(789, '/settings');
  assert.equal(fixture.requests.length, requestCount);
});

test('watcher views use current owner settings and cannot consume the owner pending input', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(456, 'menu:solana:consistency', true);
  const screen = fixture.requests.at(-1)!.payload;
  assert.match(String(screen.text), /Watcher access: read only/);
  assert.match(String(screen.text), /42/);
  const buttons = (screen.reply_markup as InlineKeyboard).inline_keyboard.flat();
  assert.ok(
    buttons.every(
      (button) => !('callback_data' in button) || watcherCallbackAllowed(button.callback_data),
    ),
  );
  await fixture.send(123, 'edit:solana:buySize', true);
  await fixture.send(456, '/settings');
  await fixture.send(456, '0.9');
  assert.equal(fixture.writes(), 0);
  await fixture.send(123, '0.25');
  assert.equal(fixture.writes(), 1);
  assert.equal(fixture.settings.chains.solana.buySizeNative, '0.25');
});

test('notification receipts survive restarts and a slow watcher does not block owner delivery', () => {
  const directory = mkdtempSync(join(tmpdir(), 'watcher-delivery-'));
  let store = new Store(directory);
  try {
    store.notify('first', 'First notification');
    const first = store.notifications(123)[0]!;
    store.delivered(first.id, 123, [123, 456]);
    assert.equal(store.notifications(123).length, 0);
    assert.equal(store.notifications(456).length, 1);
    store.notify('second', 'Second notification');
    const second = store.notifications(123)[0]!;
    assert.equal(second.text, 'Second notification');
    store.delivered(second.id, 123, [123, 456]);
    store.close();
    store = new Store(directory);
    assert.equal(store.notifications(123).length, 0);
    assert.equal(store.notifications(456).length, 2);
    for (const notification of store.notifications(456))
      store.delivered(notification.id, 456, [123, 456]);
    assert.equal(store.notifications().length, 0);
    store.notify('owner-only', 'Owner only');
    store.delivered(store.notifications(123)[0]!.id, 123, [123]);
    assert.equal(store.notifications().length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
