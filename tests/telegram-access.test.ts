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
import { settingsCallback, unpackSettingsCallback } from '../src/telegram/settings-scope.js';
import { BotAccess, watcherUsernameSchema } from '../src/telegram/access.js';

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

test('wallet control requires the owner ID or the persisted watcher ID', () => {
  const store = metadataStore();
  const access = new BotAccess(123, 'watcher_name', store);
  assert.equal(access.canControl(123), true);
  assert.equal(access.canControl(456), false);
  access.role({ id: 456, username: 'watcher_name', is_bot: false }, 'private');
  assert.equal(access.canControl(456), true);
  assert.equal(new BotAccess(123, 'watcher_name', store).canControl(456), true);
  assert.equal(new BotAccess(123, 'different_user', store).canControl(456), false);
  for (const id of [789, 0, -1, NaN, Infinity, 123.5]) assert.equal(access.canControl(id), false);
  store.setMetadata('access:watcher:watcher_name', 'invalid');
  assert.equal(access.canControl(456), false);
});

function botFixture(t: TestContext) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Access tests must remain offline'));
  const metadata = metadataStore();
  const settings = settingsSchema.parse({});
  settings.chains.solana.consistency.overall = 42;
  const firstRules = structuredClone(settings.chains);
  const secondRules = structuredClone(settings.chains);
  const sources = new Map([
    [
      'first',
      {
        id: 'first',
        title: 'First channel',
        enabled: true,
        status: 'ready',
        channelId: '-1001',
        username: 'first_calls',
        defaultChain: null,
        target: 'first_calls',
        activatedAt: 0,
        error: null,
        mode: 'spydefi' as const,
        settingsKey: 'a1b2c3',
        settings: firstRules,
        blockedCallers: [] as string[],
      },
    ],
    [
      'second',
      {
        id: 'second',
        title: 'Second channel',
        enabled: false,
        status: 'ready',
        channelId: '-1002',
        username: 'second_calls',
        defaultChain: null,
        target: 'second_calls',
        activatedAt: 0,
        error: null,
        mode: 'general' as const,
        settingsKey: 'd4e5f6',
        settings: secondRules,
        blockedCallers: [] as string[],
      },
    ],
  ]);
  let writes = 0;
  let confirmationId = 0;
  const store = {
    ...metadata,
    newId: () => `confirmation-${++confirmationId}`,
    settings: () => structuredClone(settings),
    updateSettings: (change: (settings: Settings) => void) => {
      writes++;
      change(settings);
      return structuredClone(settings);
    },
    tradingSettings: (chain: 'solana' | 'robinhood', sourceId?: string) =>
      structuredClone(sourceId ? sources.get(sourceId)!.settings[chain] : settings.chains[chain]),
    callerBlocklist: (sourceId?: string) =>
      sourceId ? sources.get(sourceId)!.blockedCallers : settings.blockedCallers,
    callChannel: (id: string) => (sources.has(id) ? structuredClone(sources.get(id)) : null),
    callChannelForSettings: (key: string) =>
      structuredClone([...sources.values()].find((source) => source.settingsKey === key) ?? null),
    saveCallChannel: (source: { id: string; enabled: boolean }) => {
      writes++;
      Object.assign(sources.get(source.id)!, source);
    },
    removeCallChannel: (id: string) => {
      writes++;
      sources.delete(id);
    },
    updateChannelRules: (
      sourceId: string,
      chain: 'solana' | 'robinhood',
      change: (rules: Settings['chains']['solana']) => void,
    ) => {
      writes++;
      change(sources.get(sourceId)!.settings[chain]);
    },
    positions: () => [],
    callChannels: () => structuredClone([...sources.values()]),
    activeOperation: () => null,
  } as unknown as Store;
  const mutate = async () => {
    writes++;
    throw new Error('Unexpected trade mutation');
  };
  const tradeCalls: { kind: string; args: unknown[] }[] = [];
  const engine = {
    adapters: { bnb: { address: '0x2222222222222222222222222222222222222222' } },
    readiness: () => [],
    sell: mutate,
    unwrap: mutate,
    withdraw: async (...args: unknown[]) => {
      tradeCalls.push({ kind: 'withdraw', args });
      return 'withdrawal-operation';
    },
    wrap: async (...args: unknown[]) => {
      tradeCalls.push({ kind: 'wrap', args });
      return 'wrapping-operation';
    },
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
  return {
    send,
    store,
    requests,
    tradeCalls,
    settings: { ...settings, chains: firstRules },
    globals: settings,
    firstRules,
    secondRules,
    removeFirst: () => sources.delete('first'),
    writes: () => writes,
  };
}

test('unconfigured accounts cannot invoke callbacks or edit settings while the watcher can', async (t) => {
  const fixture = botFixture(t);
  for (const action of [
    'enable:solana',
    'withdraw:solana',
    'withdrawconfirm:id',
    'wrap:bnb',
    'wrapconfirm:id',
    'unwrapyes',
    'sell:id:100',
    'reconcile:id',
    'channeltoggle:first',
    settingsCallback('a1b2c3', 'edit:solana:buySize'),
  ])
    await fixture.send(789, action, true);
  await fixture.send(789, '0.5');
  await fixture.send(789, '/settings');
  assert.equal(fixture.writes(), 0);
  assert.equal(fixture.requests.length, 0);
  await fixture.send(456, settingsCallback('a1b2c3', 'edit:solana:buySize'), true);
  await fixture.send(456, '0.1');
  assert.equal(fixture.firstRules.solana.buySizeNative, '0.1');
  assert.equal(fixture.writes(), 1);
});

test('watcher can withdraw and wrap with confirmations isolated from the owner', async (t) => {
  const fixture = botFixture(t);
  const confirmation = (prefix: string) => {
    const buttons = (
      fixture.requests.at(-1)!.payload.reply_markup as InlineKeyboard
    ).inline_keyboard.flat();
    const button = buttons.find(
      (entry) => 'callback_data' in entry && entry.callback_data.startsWith(prefix),
    );
    assert.ok(button && 'callback_data' in button);
    return button.callback_data;
  };
  await fixture.send(456, 'withdraw:bnb', true);
  assert.match(String(fixture.requests.at(-1)!.payload.text), /Withdraw BNB/);
  await fixture.send(456, '0x1111111111111111111111111111111111111111');
  await fixture.send(456, '0.01');
  const withdrawal = confirmation('withdrawconfirm:');
  await fixture.send(123, withdrawal, true);
  await fixture.send(789, withdrawal, true);
  assert.equal(fixture.tradeCalls.length, 0);
  await fixture.send(456, withdrawal, true);
  assert.deepEqual(fixture.tradeCalls, [
    { kind: 'withdraw', args: ['bnb', '0x1111111111111111111111111111111111111111', '0.01', 456] },
  ]);
  await fixture.send(456, withdrawal, true);
  assert.equal(fixture.tradeCalls.length, 1);
  await fixture.send(456, 'wrap:bnb', true);
  assert.match(String(fixture.requests.at(-1)!.payload.text), /Wrap BNB/);
  await fixture.send(456, '0.02');
  const wrapping = confirmation('wrapconfirm:');
  await fixture.send(123, wrapping, true);
  assert.equal(fixture.tradeCalls.length, 1);
  await fixture.send(456, wrapping, true);
  assert.deepEqual(fixture.tradeCalls[1], { kind: 'wrap', args: ['0.02', 'first', 'bnb'] });
});

test('sender filter prompts, username lists and switches remain scoped to their source', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(123, settingsCallback('a1b2c3', 'sendertoggle'), true);
  assert.match(String(fixture.requests.at(-1)!.payload.text), /Set watched usernames/);
  await fixture.send(456, settingsCallback('d4e5f6', 'senderfilter'), true);
  await fixture.send(456, 'intruder');
  await fixture.send(123, '@Alice, BOB');
  const first = fixture.store.callChannel('first')!;
  assert.deepEqual(first.senderFilter, { enabled: true, usernames: ['alice', 'bob'] });
  assert.equal(fixture.store.callChannel('second')!.senderFilter?.enabled ?? false, false);
  await fixture.send(123, settingsCallback('a1b2c3', 'sendertoggle'), true);
  assert.equal(fixture.store.callChannel('first')!.senderFilter!.enabled, false);
  await fixture.send(123, settingsCallback('d4e5f6', 'senderset'), true);
  await fixture.send(123, 'charlie');
  assert.deepEqual(fixture.store.callChannel('second')!.senderFilter, {
    enabled: false,
    usernames: ['charlie'],
  });
  await fixture.send(123, settingsCallback('d4e5f6', 'sendertoggle'), true);
  assert.equal(fixture.store.callChannel('second')!.senderFilter!.enabled, true);
  const writes = fixture.writes();
  await fixture.send(456, settingsCallback('d4e5f6', 'sendertoggle'), true);
  await fixture.send(456, settingsCallback('d4e5f6', 'senderset'), true);
  await fixture.send(456, '@delta');
  assert.equal(fixture.writes(), writes + 2);
  assert.deepEqual(fixture.store.callChannel('second')!.senderFilter, {
    enabled: false,
    usernames: ['delta'],
  });
});

test('both controllers see all controls and retain separate pending inputs', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(456, 'menu:solana:consistency', true);
  const screen = fixture.requests.at(-1)!.payload;
  assert.doesNotMatch(String(screen.text), /read.only/i);
  assert.match(String(screen.text), /42/);
  const buttons = (screen.reply_markup as InlineKeyboard).inline_keyboard.flat();
  assert.ok(
    buttons.some((button) => 'callback_data' in button && button.callback_data.includes('edit:')),
  );
  await fixture.send(123, settingsCallback('a1b2c3', 'edit:solana:buySize'), true);
  await fixture.send(456, '/settings');
  await fixture.send(456, '0.9');
  assert.equal(fixture.writes(), 0);
  await fixture.send(123, '0.25');
  assert.equal(fixture.writes(), 1);
  assert.equal(fixture.settings.chains.solana.buySizeNative, '0.25');
  assert.equal(fixture.globals.chains.solana.buySizeNative, null);
});

test('channel settings buttons edit their original source rather than the last opened channel', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(123, settingsCallback('d4e5f6', 'menu:solana:buy'), true);
  await fixture.send(123, settingsCallback('a1b2c3', 'edit:solana:buySize'), true);
  await fixture.send(123, '0.12');
  assert.equal(fixture.firstRules.solana.buySizeNative, '0.12');
  assert.equal(fixture.secondRules.solana.buySizeNative, null);
  await fixture.send(123, settingsCallback('d4e5f6', 'edit:robinhood:buySize'), true);
  await fixture.send(123, '0.03');
  assert.equal(fixture.secondRules.robinhood.buySizeNative, '0.03');
  assert.equal(fixture.firstRules.robinhood.buySizeNative, null);
  assert.equal(fixture.globals.chains.solana.buySizeNative, null);
  fixture.removeFirst();
  await fixture.send(123, settingsCallback('a1b2c3', 'edit:solana:buySize'), true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /no longer exists/);
  assert.equal(fixture.writes(), 2);
});

test('both controllers can edit BNB settings independently by channel', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(123, '/start');
  const screen = fixture.requests.at(-1)!.payload;
  const callbacks = (screen.reply_markup as InlineKeyboard).inline_keyboard
    .flat()
    .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []));
  assert.ok(callbacks.includes(settingsCallback('a1b2c3', 'chain:bnb')));
  await fixture.send(123, settingsCallback('a1b2c3', 'edit:bnb:buySize'), true);
  await fixture.send(123, '0.02');
  assert.equal(fixture.firstRules.bnb.buySizeNative, '0.02');
  assert.equal(fixture.secondRules.bnb.buySizeNative, null);
  assert.equal(fixture.firstRules.robinhood.buySizeNative, null);
  await fixture.send(456, settingsCallback('a1b2c3', 'menu:bnb:buy'), true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /0.02/);
  await fixture.send(456, settingsCallback('a1b2c3', 'edit:bnb:buySize'), true);
  await fixture.send(456, '0.03');
  assert.equal(fixture.firstRules.bnb.buySizeNative, '0.03');
  assert.equal(fixture.secondRules.bnb.buySizeNative, null);
  assert.equal(fixture.writes(), 2);
});

test('both controllers can configure scoped time exits', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(123, settingsCallback('a1b2c3', 'toggle:solana:timeExit'), true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Enable time exit/);
  assert.equal(fixture.firstRules.solana.exits.timeExit.enabled, false);
  await fixture.send(123, '10');
  assert.deepEqual(fixture.firstRules.solana.exits.timeExit, { enabled: true, minutes: 10 });
  assert.deepEqual(fixture.secondRules.solana.exits.timeExit, { enabled: false, minutes: null });
  await fixture.send(456, settingsCallback('a1b2c3', 'menu:solana:timeExit'), true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /10/);
  await fixture.send(456, settingsCallback('a1b2c3', 'toggle:solana:timeExit'), true);
  assert.equal(fixture.firstRules.solana.exits.timeExit.enabled, false);
  await fixture.send(123, settingsCallback('a1b2c3', 'toggle:solana:timeExit'), true);
  assert.deepEqual(fixture.firstRules.solana.exits.timeExit, { enabled: true, minutes: 10 });
});

test('SpyDefi label switches are scoped and editable by both controllers', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(123, settingsCallback('a1b2c3', 'menu:solana:filters'), true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Buy Only First Caller/);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Just Launched/);
  await fixture.send(123, settingsCallback('a1b2c3', 'toggle:solana:firstCaller'), true);
  await fixture.send(123, settingsCallback('a1b2c3', 'toggle:solana:justLaunched'), true);
  assert.equal(fixture.firstRules.solana.filters.buyOnlyFirstCaller, true);
  assert.equal(fixture.firstRules.solana.filters.justLaunched, true);
  assert.equal(fixture.firstRules.robinhood.filters.buyOnlyFirstCaller, false);
  assert.equal(fixture.firstRules.robinhood.filters.justLaunched, false);
  assert.equal(fixture.writes(), 2);
  await fixture.send(456, settingsCallback('a1b2c3', 'menu:solana:filters'), true);
  const watcherScreen = fixture.requests.at(-1)!.payload;
  assert.match(String(watcherScreen.text), /Buy Only First Caller/);
  assert.ok(
    (watcherScreen.reply_markup as InlineKeyboard).inline_keyboard
      .flat()
      .some((button) => 'callback_data' in button && button.callback_data.includes('toggle:')),
  );
  await fixture.send(456, settingsCallback('a1b2c3', 'toggle:solana:firstCaller'), true);
  assert.equal(fixture.firstRules.solana.filters.buyOnlyFirstCaller, false);
  assert.equal(fixture.writes(), 3);
  await fixture.send(123, settingsCallback('d4e5f6', 'menu:solana:filters'), true);
  assert.doesNotMatch(String(fixture.requests.at(-1)?.payload.text), /Buy Only First Caller/);
  assert.doesNotMatch(String(fixture.requests.at(-1)?.payload.text), /Just Launched/);
  for (const filter of ['firstCaller', 'justLaunched']) {
    await fixture.send(123, settingsCallback('d4e5f6', `toggle:solana:${filter}`), true);
    assert.match(String(fixture.requests.at(-1)?.payload.text), /only available for SpyDefi/);
  }
  assert.equal(fixture.secondRules.solana.filters.buyOnlyFirstCaller, false);
  assert.equal(fixture.secondRules.solana.filters.justLaunched, false);
  assert.equal(fixture.writes(), 3);
});

test('main-menu channel selection survives navigation and keeps edits scoped to the named channel', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(123, '/start');
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Selected channel: First channel/);
  await fixture.send(123, 'channelpick:second', true);
  await fixture.send(123, '/settings');
  const screen = fixture.requests.at(-1)!.payload;
  assert.match(String(screen.text), /Selected channel: Second channel/);
  assert.match(String(screen.text), /2 total · 1 on · 1 off/);
  const callbacks = (screen.reply_markup as InlineKeyboard).inline_keyboard
    .flat()
    .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []));
  assert.ok(callbacks.includes(settingsCallback('d4e5f6', 'chain:solana')));
  assert.ok(callbacks.includes(settingsCallback('d4e5f6', 'chain:robinhood')));
  assert.ok(callbacks.includes('channeltoggle:second'));
  assert.equal(fixture.writes(), 0);
  await fixture.send(123, settingsCallback('a1b2c3', 'edit:solana:buySize'), true);
  await fixture.send(123, '0.14');
  assert.equal(fixture.firstRules.solana.buySizeNative, '0.14');
  assert.equal(fixture.secondRules.solana.buySizeNative, null);
  await fixture.send(123, 'home', true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Selected channel: First channel/);
  fixture.removeFirst();
  await fixture.send(123, '/settings');
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Selected channel: Second channel/);
});

test('channel toggles and removal are available to both controllers with independent selections', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(123, 'channelpick:second', true);
  await fixture.send(456, '/settings');
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Selected channel: First channel/);
  await fixture.send(456, 'channelpick:second', true);
  const screen = fixture.requests.at(-1)!.payload;
  assert.match(String(screen.text), /Selected channel: Second channel/);
  const callbacks = (screen.reply_markup as InlineKeyboard).inline_keyboard
    .flat()
    .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []));
  assert.ok(callbacks.includes('channeltoggle:second'));
  await fixture.send(456, 'channeltoggle:second', true);
  await fixture.send(456, 'channelremovechoose:0', true);
  assert.equal(fixture.writes(), 1);
  await fixture.send(123, 'channeltoggle:first', true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /2 total · 1 on · 1 off/);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Selected channel: First channel/);
  await fixture.send(123, 'channelremovechoose:0', true);
  const removal = fixture.requests.at(-1)!.payload;
  const removalActions = (removal.reply_markup as InlineKeyboard).inline_keyboard
    .flat()
    .flatMap((button) => ('callback_data' in button ? [button.callback_data] : []));
  assert.ok(removalActions.includes('channelremove:second'));
  assert.ok(!removalActions.includes('channelpick:second'));
  await fixture.send(123, 'channelremove:second', true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Second channel/);
  await fixture.send(123, 'channelrmconfirm:second', true);
  await fixture.send(456, '/settings');
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Selected channel: First channel/);
});

test('watcher edits channel rules without changing another source', async (t) => {
  const fixture = botFixture(t);
  await fixture.send(456, settingsCallback('d4e5f6', 'menu:solana:buy'), true);
  assert.match(String(fixture.requests.at(-1)?.payload.text), /Second channel settings/);
  await fixture.send(456, settingsCallback('d4e5f6', 'edit:solana:buySize'), true);
  await fixture.send(456, '0.2');
  await fixture.send(456, settingsCallback('d4e5f6', 'enable:solana'), true);
  assert.equal(fixture.writes(), 2);
  assert.equal(fixture.secondRules.solana.buySizeNative, '0.2');
  assert.equal(fixture.secondRules.solana.enabled, true);
  assert.equal(fixture.firstRules.solana.buySizeNative, null);
  assert.equal(fixture.firstRules.solana.enabled, false);
});

test('channel context fits the longest trailing-stage callback in Telegram without losing its source', () => {
  const action = 'exitdel:robinhood:sl:12345678-1234-1234-1234-123456789012';
  const encoded = settingsCallback('a1b2c3', action);
  assert.equal(Buffer.byteLength(encoded, 'utf8'), 64);
  assert.deepEqual(unpackSettingsCallback(encoded), { key: 'a1b2c3', data: action });
  assert.throws(() => settingsCallback('a1b2c3', `${action}x`), /too long/);
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
