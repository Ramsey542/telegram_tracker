import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'teleproto';
import {
  senderFilterSchema,
  chainSettingsSchema,
  type CallChannel,
  type ChannelPost,
  type CallSignal,
  type Operation,
} from '../src/domain.js';
import {
  senderFilterRejection,
  senderIdentity,
  senderUsernames,
} from '../src/telegram/sender-filter.js';
import { parseGeneralCall } from '../src/telegram/generic-parser.js';
import { ChannelRegistry } from '../src/telegram/channel-registry.js';
import { Store } from '../src/infra/store.js';
import { TradeEngine } from '../src/trading/engine.js';
import type { Config } from '../src/config.js';
import type { RiskFilters } from '../src/providers/risk.js';
import { senderFilterPanel } from '../src/telegram/channels.js';

const mint = '4U6QvbLXyTpJTiU9HbgaN9yGa6CQ7gXFnWL1HFaWpump';
const source = (id = 'group'): CallChannel => ({
  id,
  target: id,
  channelId: '-1001',
  title: id,
  username: id,
  mode: 'general',
  defaultChain: null,
  enabled: true,
  activatedAt: 0,
  status: 'ready',
  error: null,
  isGroup: true,
  senderFilter: { enabled: true, usernames: ['alice'] },
});
const post = (username: string | null): ChannelPost => ({
  channelId: '-1001',
  messageId: 1,
  date: Date.now(),
  revision: 1,
  text: `New call ${mint} @alice`,
  urls: [],
  senderId: '123',
  senderUsername: username,
});

test('sender lists normalize handles and reject empty, invalid and oversized enabled lists', () => {
  assert.deepEqual(senderUsernames(' @Alice, BOB\n@alice '), ['alice', 'bob']);
  assert.deepEqual(senderFilterSchema.parse({}), { enabled: false, usernames: [] });
  for (const value of ['', '@', 'https://t.me/alice', '12345', 'first-name'])
    assert.throws(() => senderUsernames(value));
  assert.throws(() => senderUsernames(Array.from({ length: 101 }, (_, i) => `user${i}`).join(',')));
  assert.equal(senderFilterSchema.safeParse({ enabled: true }).success, false);
});

test('only the actual message user can supply sender identity, regardless of forwarded names', () => {
  const message = new Api.Message({
    id: 1,
    peerId: new Api.PeerChannel({ channelId: bigInt(1) }),
    fromId: new Api.PeerUser({ userId: bigInt(123) }),
    date: 1,
    message: '@alice posted a token',
    fwdFrom: new Api.MessageFwdHeader({ date: 1, fromName: 'alice' }),
  });
  const user = new Api.User({ id: bigInt(123), username: 'Bob' });
  assert.deepEqual(senderIdentity(message, user), { senderId: '123', senderUsername: 'bob' });
  assert.deepEqual(senderIdentity(message, new Api.User({ id: bigInt(456), username: 'alice' })), {
    senderId: '123',
    senderUsername: null,
  });
  message.fromId = new Api.PeerChannel({ channelId: bigInt(1) });
  assert.deepEqual(senderIdentity(message, user), { senderId: null, senderUsername: null });
});

test('unwatched and unidentified senders are rejected before contract or chart lookups', async () => {
  const noLookup = async (): Promise<null> => assert.fail('Rejected senders must not fetch pairs');
  for (const username of ['bob', null]) {
    const rejected = await parseGeneralCall(
      { ...post(username), urls: ['https://dexscreener.com/solana/unresolved-pair'] },
      source(),
      noLookup,
    );
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.match(rejected.reason, /Sender filter/);
  }
  const accepted = await parseGeneralCall(post('alice'), source(), noLookup);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.signal.caller, 'alice');
    assert.equal(accepted.signal.callerId, '123');
    assert.equal(accepted.signal.senderUsername, 'alice');
  }
  assert.equal(
    senderFilterRejection(
      { ...source(), senderFilter: { enabled: false, usernames: [] } },
      post(null),
    ),
    null,
  );
});

test('sender filters persist separately per source and are rechecked before spending', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'sender-filter-'));
  let store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = source();
  store.saveCallChannel(first);
  store.updateChannelRules(first.id, 'solana', (rules) => {
    rules.enabled = true;
    rules.buySizeNative = '0.001';
    rules.slippagePercent = 1;
  });
  store.saveCallChannel({ ...source('other'), channelId: '-1002', senderFilter: undefined });
  store.close();
  store = new Store(directory);
  assert.equal(store.callChannel('other')!.senderFilter!.enabled, false);
  assert.deepEqual(store.callChannel(first.id)!.senderFilter!.usernames, ['alice']);
  const signal: CallSignal = {
    id: '-1001:1',
    sourceId: first.id,
    channelId: '-1001',
    messageId: 1,
    date: Date.now(),
    chain: 'solana',
    address: mint,
    caller: 'alice',
    callerId: '123',
    senderId: '123',
    senderUsername: 'alice',
    consistency: null,
    advertisedMarketCapUsd: null,
    mode: 'general',
  };
  const engine = new TradeEngine(
    { listenOnly: false, maxSignalAgeMs: 60_000 } as Config,
    store,
    {} as ConstructorParameters<typeof TradeEngine>[2],
    {} as RiskFilters,
  );
  const controls = engine as unknown as {
    validateSignal(signal: CallSignal, requireReady: boolean): unknown;
    ensureEntryActive(operation: Operation): void;
  };
  controls.validateSignal(signal, false);
  controls.ensureEntryActive({ kind: 'buy', chain: 'solana', address: mint, signal } as Operation);
  const updated = store.callChannel(first.id)!;
  updated.senderFilter = { enabled: true, usernames: ['bob'] };
  store.saveCallChannel(updated);
  assert.throws(() => controls.validateSignal(signal, false), /watch list/);
  assert.throws(
    () =>
      controls.ensureEntryActive({
        kind: 'buy',
        chain: 'solana',
        address: mint,
        signal,
      } as Operation),
    /watch list/,
  );
});

test('public supergroups resolve with disabled trading rules and sender filter controls', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'group-registry-'));
  const store = new Store(directory);
  const registry = new ChannelRegistry(store);
  t.after(async () => {
    await registry.stop();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  registry.attach({
    getEntity: async () =>
      new Api.Channel({
        id: bigInt(1),
        accessHash: bigInt(1),
        title: 'Public group',
        username: 'public_group',
        megagroup: true,
        photo: new Api.ChatPhotoEmpty(),
        date: 1,
      }),
    getMessages: async () => [{ id: 10 }],
  } as unknown as TelegramClient);
  const added = await registry.add('@public_group');
  await registry.idle();
  const saved = store.callChannel(added.id)!;
  assert.equal(saved.status, 'ready');
  assert.equal(saved.isGroup, true);
  assert.equal(saved.enabled, false);
  assert.deepEqual(saved.senderFilter, { enabled: false, usernames: [] });
  assert.deepEqual(saved.settings!.solana, chainSettingsSchema.parse({}));
  const actions = senderFilterPanel(saved).keyboard.inline_keyboard.flat();
  assert.ok(
    actions.some((button) => 'callback_data' in button && button.callback_data === 'senderset'),
  );
});
