import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bigInt from 'big-integer';
import { Api, type TelegramClient } from 'teleproto';
import {
  chainSettingsSchema,
  PendingTrade,
  emptyTrail,
  type CallChannel,
  type CallSignal,
  type ChannelPost,
  type Operation,
  type Position,
  type TokenInfo,
  type ChainSettings,
} from '../src/domain.js';
import { Store } from '../src/infra/store.js';
import { parseGeneralCall, isUpdatePost } from '../src/telegram/generic-parser.js';
import { ChannelRegistry, channelTarget } from '../src/telegram/channel-registry.js';
import type { DexPair } from '../src/providers/market.js';
import { TradeEngine } from '../src/trading/engine.js';
import type { Config } from '../src/config.js';
import type { RiskFilters } from '../src/providers/risk.js';
import type { ChainAdapter } from '../src/chains/types.js';

const mint = '4U6QvbLXyTpJTiU9HbgaN9yGa6CQ7gXFnWL1HFaWpump';
const evm = '0xd086f891229cd123aadfcae7c4b40150a80fd9d7';
const pool = '0xdf3fbf9be296615d5ee32ccb4c2884599a93dd5dc91ad2b779dda99c7ce53bdd';
const weth = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const noLookup = async (): Promise<null> =>
  assert.fail('This call must not request external pair data');
function channel(id = 'general'): CallChannel {
  return {
    id,
    target: id,
    channelId: id === 'general' ? '-1001' : '-1002',
    title: id,
    username: id,
    mode: 'general',
    defaultChain: null,
    enabled: true,
    activatedAt: 0,
    status: 'ready',
    error: null,
    settings: {
      solana: chainSettingsSchema.parse({
        enabled: true,
        buySizeNative: '0.001',
        slippagePercent: 1,
      }),
      robinhood: chainSettingsSchema.parse({
        enabled: true,
        buySizeNative: '0.001',
        slippagePercent: 1,
      }),
    },
  };
}
function post(text: string, urls: string[] = []): ChannelPost {
  return { channelId: '-1001', messageId: 1, date: Date.now(), revision: 1, text, urls };
}
function pair(address = evm): DexPair {
  return {
    chainId: 'robinhood',
    pairAddress: pool,
    baseToken: { address, symbol: 'PIZZA' },
    quoteToken: { address: weth, symbol: 'WETH' },
  };
}
function database(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'call-channels-'));
  let store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    get store() {
      return store;
    },
    restart(before?: () => void) {
      store.close();
      before?.();
      store = new Store(directory);
    },
  };
}

test('generic extractor handles the PIZZA pool example and rejects a mismatched pair', async () => {
  const message = post(`$PIZZA 856K\n\n\`${evm.toUpperCase().replace('0X', '0x')}\``, [
    `https://dexscreener.com/robinhood/${pool}`,
  ]);
  const result = await parseGeneralCall(message, channel(), async (chain, address) => {
    assert.equal(chain, 'robinhood');
    assert.equal(address, pool);
    return pair();
  });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.signal.address, evm);
    assert.equal(result.signal.consistency, null);
    assert.equal(result.signal.mode, 'general');
    assert.equal(result.signal.tokenName, 'PIZZA');
  }
  const mismatch = await parseGeneralCall(message, channel(), async () =>
    pair('0x1111111111111111111111111111111111111111'),
  );
  assert.deepEqual(mismatch, {
    ok: false,
    reason: 'Chart pair does not contain the posted contract address',
  });
});

test('general extraction accepts bare Solana mints and chain defaults without extra requests', async () => {
  assert.equal(
    (await parseGeneralCall(post(`New call $TEST\n${mint}`), channel(), noLookup)).ok,
    true,
  );
  assert.equal((await parseGeneralCall(post(evm), channel(), noLookup)).ok, false);
  const result = await parseGeneralCall(
    post(evm),
    { ...channel(), defaultChain: 'robinhood' },
    noLookup,
  );
  assert.equal(result.ok && result.signal.chain, 'robinhood');
  assert.equal(
    (await parseGeneralCall(post(evm), { ...channel(), defaultChain: 'solana' }, noLookup)).ok,
    false,
  );
  assert.equal((await parseGeneralCall(post(`RBH\n${evm}`), channel(), noLookup)).ok, true);
  assert.equal(
    (
      await parseGeneralCall(
        post('', [`https://t.me/trade_bot?start=${mint}`]),
        channel(),
        noLookup,
      )
    ).ok,
    true,
  );
});

test('updates, conflicting chains, ambiguous CAs and long pool hashes do not become buys', async () => {
  for (const text of [
    `Update (RBH) pizza\nDid 2x already\n${evm}`,
    `Our call already did 5x\n${mint}`,
    `Results\n${mint}`,
  ]) {
    assert.equal(isUpdatePost(text), true);
    assert.equal((await parseGeneralCall(post(text), channel(), noLookup)).ok, false);
  }
  assert.equal(
    (
      await parseGeneralCall(
        post(`${evm}\n0x1111111111111111111111111111111111111111`),
        { ...channel(), defaultChain: 'robinhood' },
        noLookup,
      )
    ).ok,
    false,
  );
  assert.equal((await parseGeneralCall(post(`Solana RBH ${evm}`), channel(), noLookup)).ok, false);
  assert.equal(
    (
      await parseGeneralCall(
        post(evm, [`https://dexscreener.com/ethereum/${evm}`]),
        { ...channel(), defaultChain: 'robinhood' },
        noLookup,
      )
    ).ok,
    false,
  );
  assert.equal((await parseGeneralCall(post(`RBH ${pool}`), channel(), noLookup)).ok, false);
  const linkOnly = await parseGeneralCall(
    post('', [`https://dexscreener.com/robinhood/${pool}`]),
    channel(),
    async () => pair(),
  );
  assert.equal(linkOnly.ok && linkOnly.signal.address, evm);
});

function signal(time: number, source = channel(), id = 1): CallSignal {
  return {
    id: `${source.channelId}:${id}`,
    sourceId: source.id,
    sourceName: source.title,
    mode: source.mode,
    channelId: source.channelId!,
    messageId: id,
    date: time,
    detectedAt: time,
    chain: 'solana',
    address: mint,
    caller: source.title,
    callerId: source.channelId,
    consistency: source.mode === 'general' ? null : { overall: 99, recent: 99, chain: 99 },
    advertisedMarketCapUsd: null,
  };
}
function trade(id: string, call: CallSignal | null, kind: 'buy' | 'sell' = 'buy'): Operation {
  return {
    id,
    chain: 'solana',
    address: mint,
    kind,
    status: 'active',
    positionId: null,
    signal: call,
    exitKey: null,
    amountRaw: kind === 'buy' ? '1000000' : '50',
    token: {
      chain: 'solana',
      address: mint,
      symbol: 'TEST',
      decimals: 6,
      marketCapUsd: null,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: Date.now(),
    },
    settings: chainSettingsSchema.parse({}),
    steps: [],
    quote: null,
    swapHash: id,
    outputRaw: null,
    minimumNativeRaw: null,
    createdAt: Date.now(),
    error: null,
  };
}
function holding(id: string): Position {
  return {
    id,
    chain: 'solana',
    address: mint,
    symbol: 'TEST',
    decimals: 6,
    caller: 'caller',
    originalTokenRaw: '100',
    remainingTokenRaw: '100',
    entryNativeRaw: '1000100',
    entrySwapNativeRaw: '1000000',
    entryFeeNativeRaw: '100',
    entryUsd: 0.10001,
    realizedNativeRaw: '0',
    realizedFeeNativeRaw: '0',
    exits: chainSettingsSchema.parse({}).exits,
    exitFills: {},
    trailingSl: emptyTrail(),
    trailingTp: emptyTrail(),
    openedAt: Date.now(),
    closedAt: null,
    lastProfitPercent: null,
    lastValueNativeRaw: null,
    lastValueUsd: null,
    lastError: null,
  };
}

test('partial sales block duplicates; a full bot exit permits only fresh calls, with independent positions after restart', (t) => {
  const db = database(t);
  let now = 10_000;
  t.mock.method(Date, 'now', () => now);
  const general = channel();
  const spy = { ...channel('spy'), mode: 'spydefi' as const };
  db.store.saveCallChannel(general);
  db.store.saveCallChannel(spy);
  const firstCall = signal(now, general);
  db.store.recordPost(post(mint), firstCall, null);
  const buy = trade('first-buy', firstCall);
  assert.equal(db.store.claim(buy), true);
  const position = holding('first-position');
  db.store.completeBuy(buy, position, {
    tokenRaw: '100',
    nativeRaw: '1000100',
    swapNativeRaw: '1000000',
    feeNativeRaw: '100',
    signature: 'first-buy',
    nativeUsd: 100,
  });
  now = 20_000;
  const staleCall = signal(now, spy, 2);
  assert.equal(db.store.claim(trade('duplicate', staleCall)), false);
  const partial = trade('partial', null, 'sell');
  partial.positionId = position.id;
  assert.equal(db.store.claim(partial), true);
  db.store.completeSell(partial, position, {
    tokenRaw: '50',
    nativeRaw: '599900',
    swapNativeRaw: '600000',
    feeNativeRaw: '100',
    signature: 'partial',
    nativeUsd: 100,
  });
  assert.equal(db.store.hasEntry('solana', mint), true);
  now = 30_000;
  const full = trade('full', null, 'sell');
  full.positionId = position.id;
  assert.equal(db.store.claim(full), true);
  db.store.completeSell(full, position, {
    tokenRaw: '50',
    nativeRaw: '699900',
    swapNativeRaw: '700000',
    feeNativeRaw: '100',
    signature: 'full',
    nativeUsd: 100,
  });
  assert.equal(db.store.hasEntry('solana', mint), false);
  assert.match(db.store.entryRejection(staleCall)!, /posted after/);
  assert.equal(db.store.claim(trade('stale-buy', staleCall)), false);
  now = 40_000;
  const fresh = signal(now, spy, 3);
  assert.equal(db.store.entryRejection(fresh), null);
  const second = trade('second-buy', fresh);
  assert.equal(db.store.claim(second), true);
  const secondPosition = holding('second-position');
  db.store.completeBuy(second, secondPosition, {
    tokenRaw: '100',
    nativeRaw: '1000100',
    swapNativeRaw: '1000000',
    feeNativeRaw: '100',
    signature: 'second-buy',
    nativeUsd: 100,
  });
  db.restart();
  assert.equal(db.store.operation('first-buy')?.positionId, 'first-position');
  assert.equal(db.store.operation('second-buy')?.positionId, 'second-position');
  assert.deepEqual(
    db.store
      .pnlFills()
      .filter((fill) => fill.kind === 'buy')
      .map((fill) => fill.positionId),
    ['first-position', 'second-position'],
  );
  assert.equal(db.store.positions().length, 1);
  assert.equal(db.store.hasEntry('solana', mint), true);
  assert.equal(
    db.store.recordPost({ ...post(mint), revision: 20 }, { ...firstCall, date: now }, null),
    false,
  );
});

test('general calls bypass consistency only; disabled sources are rejected and rejected calls reserve nothing', (t) => {
  const db = database(t);
  const source = channel();
  db.store.saveCallChannel(source);
  const call = signal(Date.now(), source);
  const engine = new TradeEngine(
    { listenOnly: true, maxSignalAgeMs: 120_000 } as Config,
    db.store,
    {} as TradeEngine['adapters'],
    {} as RiskFilters,
  );
  const message = post(mint);
  message.date = call.date;
  db.store.recordPost(message, call, null);
  engine.observeSignal(call);
  assert.equal(db.store.signalHistory()[0]!.observation?.reason, 'listen_only');
  assert.equal(db.store.signalHistory()[0]!.observation?.thresholds, null);
  assert.equal(db.store.hasEntry('solana', mint), false);
  source.enabled = false;
  db.store.saveCallChannel(source);
  assert.match(db.store.entryRejection(call)!, /disabled/);
  const missingConsistency = { ...call, mode: 'spydefi' as const };
  engine.observeSignal(missingConsistency);
  assert.match(db.store.signalHistory()[0]!.observation!.reason, /consistency is missing/);
});

test('migration links legacy entries and releases only a confirmed full bot sale', (t) => {
  const db = database(t);
  const position = holding('legacy-position');
  const buy = trade('legacy-buy', null);
  assert.equal(db.store.claim(buy), true);
  db.store.completeBuy(buy, position, {
    tokenRaw: '100',
    nativeRaw: '1000100',
    swapNativeRaw: '1000000',
    feeNativeRaw: '100',
    signature: 'legacy-buy',
    nativeUsd: 100,
  });
  const sell = trade('legacy-sell', null, 'sell');
  sell.positionId = position.id;
  assert.equal(db.store.claim(sell), true);
  db.store.completeSell(sell, position, {
    tokenRaw: '100',
    nativeRaw: '1200000',
    swapNativeRaw: '1200100',
    feeNativeRaw: '100',
    signature: 'legacy-sell',
    nativeUsd: 100,
  });
  db.restart(() => {
    const sql = new DatabaseSync(join(db.directory, 'tracker.sqlite'));
    sql.exec(
      "UPDATE positions SET payload = json_remove(payload, '$.entryOperationId'); UPDATE operations SET payload = json_set(payload, '$.positionId', NULL) WHERE id = 'legacy-buy'; INSERT INTO token_entries (chain,address,operation_id,bought) VALUES ('solana','" +
        mint +
        "','legacy-buy',1); DELETE FROM token_exits; PRAGMA user_version = 4;",
    );
    sql.close();
  });
  assert.equal(db.store.position(position.id)?.entryOperationId, buy.id);
  assert.equal(db.store.hasEntry('solana', mint), false);
  assert.ok(db.store.lastExit('solana', mint));
});

test('channel registry keeps cursors separate, refuses groups and records pending private access', async (t) => {
  const db = database(t);
  const entities = new Map(
    ['alpha', 'beta'].map((name, index) => [
      name,
      new Api.Channel({
        id: bigInt(index + 1),
        accessHash: bigInt(1),
        title: name,
        username: name,
        broadcast: true,
        photo: new Api.ChatPhotoEmpty(),
        date: 1,
      }),
    ]),
  );
  const reads: string[] = [];
  const client = {
    getEntity: async (name: string) => entities.get(name),
    getMessages: async (entity: Api.Channel) => {
      reads.push(entity.title);
      return [{ id: entity.title === 'alpha' ? 10 : 90 }];
    },
    invoke: async () => {
      throw new Error('INVITE_REQUEST_SENT');
    },
  } as unknown as TelegramClient;
  const registry = new ChannelRegistry(db.store);
  registry.attach(client);
  const alpha = await registry.add('@alpha');
  const beta = await registry.add('https://t.me/beta');
  await registry.idle();
  assert.equal(alpha.enabled, false);
  assert.equal(db.store.callChannel(alpha.id)?.channelId, '-1001');
  assert.equal(db.store.metadata('cursor:-1001'), '10');
  assert.equal(db.store.metadata('cursor:-1002'), '90');
  alpha.enabled = true;
  db.store.saveCallChannel(alpha);
  await registry.refresh();
  assert.equal(registry.list().length, 1);
  assert.ok(reads.includes('beta'));
  const pending = await registry.add('https://t.me/+privateInviteHash');
  await registry.idle();
  assert.equal(db.store.callChannel(pending.id)?.status, 'pending');
  assert.equal(
    channelTarget('https://t.me/joinchat/privateInviteHash').inviteHash,
    'privateInviteHash',
  );
  assert.throws(() => channelTarget('https://example.com/channel'));
  assert.throws(() => channelTarget('https://t.me/c/123/456'));
  const entity = entities.get('beta')!;
  entity.broadcast = false;
  await registry.retry(beta.id);
  await registry.idle();
  assert.equal(db.store.callChannel(beta.id)?.status, 'error');
  db.store.removeCallChannel(alpha.id);
  await registry.refresh();
  assert.equal(registry.list().length, 0);
});

test('removing and re-adding SpyDefi never bypasses its consistency mode', async (t) => {
  const db = database(t);
  db.store.seedCallChannels('SpyDefiLive');
  assert.equal(db.store.callChannels()[0]!.mode, 'spydefi');
  db.store.removeCallChannel('spydefi');
  db.restart();
  db.store.seedCallChannels('SpyDefiLive');
  assert.equal(db.store.callChannels().length, 0);
  const registry = new ChannelRegistry(db.store);
  const restored = await registry.add('@SpyDefiLive');
  assert.equal(restored.mode, 'spydefi');
  assert.equal(restored.enabled, false);
});

test('legacy channels receive independent snapshots that remain isolated across edits and restarts', (t) => {
  const db = database(t);
  db.store.updateSettings((settings) => {
    settings.chains.solana.enabled = true;
    settings.chains.solana.buySizeNative = '0.25';
    settings.chains.solana.slippagePercent = 3;
    settings.blockedCallers = ['legacy_blocked'];
  });
  const first = channel();
  const second = channel('other');
  db.store.saveCallChannel(first);
  db.store.saveCallChannel(second);
  db.restart(() => {
    const sql = new DatabaseSync(join(db.directory, 'tracker.sqlite'));
    sql.exec(
      "UPDATE call_channels SET settings_key = NULL, payload = json_remove(payload, '$.settings', '$.settingsKey', '$.blockedCallers'); PRAGMA user_version = 5;",
    );
    sql.close();
  });
  const key = db.store.callChannel(first.id)!.settingsKey!;
  assert.equal(db.store.tradingSettings('solana', first.id).buySizeNative, '0.25');
  assert.equal(db.store.tradingSettings('solana', second.id).buySizeNative, '0.25');
  db.store.updateChannelRules(first.id, 'solana', (settings) => {
    settings.buySizeNative = '0.75';
    settings.priorityFee = '0.0001';
    settings.exits.stopLoss = { enabled: true, lossPercent: 12 };
  });
  db.store.updateSettings((settings) => {
    settings.chains.solana.buySizeNative = '9';
    settings.chains.solana.enabled = false;
  });
  db.restart();
  assert.equal(db.store.tradingSettings('solana', first.id).buySizeNative, '0.75');
  assert.equal(db.store.tradingSettings('solana', second.id).buySizeNative, '0.25');
  assert.equal(db.store.tradingSettings('solana', second.id).exits.stopLoss.enabled, false);
  assert.equal(db.store.tradingSettings('robinhood', first.id).buySizeNative, null);
  assert.equal(db.store.callChannel(first.id)!.settingsKey, key);
  assert.equal(db.store.callChannelForSettings(key)?.id, first.id);
  assert.equal(db.store.entriesEnabled('solana'), true);
  db.store.removeCallChannel(first.id);
  const replacement = channel('replacement');
  replacement.settingsKey = key;
  db.store.saveCallChannel(replacement);
  assert.notEqual(db.store.callChannel(replacement.id)!.settingsKey, key);
  assert.equal(db.store.callChannelForSettings(key), null);
});

test('new channels start with fresh disabled rules even when legacy defaults are enabled', async (t) => {
  const db = database(t);
  db.store.updateSettings((settings) => {
    settings.chains.solana.enabled = true;
    settings.chains.solana.buySizeNative = '1';
    settings.chains.solana.slippagePercent = 15;
    settings.chains.solana.exits.stopLoss = { enabled: true, lossPercent: 50 };
  });
  const registry = new ChannelRegistry(db.store);
  const added = await registry.add('@new_calls');
  const rules = db.store.tradingSettings('solana', added.id);
  assert.equal(rules.enabled, false);
  assert.equal(rules.buySizeNative, null);
  assert.equal(rules.slippagePercent, null);
  assert.equal(rules.exits.stopLoss.enabled, false);
  assert.deepEqual(db.store.callerBlocklist(added.id), []);
});

test('channel access resolution preserves rules edited while Telegram is responding', async (t) => {
  const db = database(t);
  const registry = new ChannelRegistry(db.store);
  const source = await registry.add('@independent_calls');
  registry.attach({
    getEntity: async () =>
      new Api.Channel({
        id: bigInt(1),
        accessHash: bigInt(1),
        title: 'Independent calls',
        username: 'independent_calls',
        broadcast: true,
        photo: new Api.ChatPhotoEmpty(),
        date: 1,
      }),
    getMessages: async () => {
      db.store.updateChannelRules(source.id, 'solana', (settings) => {
        settings.buySizeNative = '0.07';
        settings.slippagePercent = 2;
      });
      return [{ id: 10 }];
    },
  } as unknown as TelegramClient);
  await registry.retry(source.id);
  await registry.idle();
  assert.equal(db.store.callChannel(source.id)?.status, 'ready');
  assert.equal(db.store.tradingSettings('solana', source.id).buySizeNative, '0.07');
  assert.equal(db.store.tradingSettings('solana', source.id).slippagePercent, 2);
  assert.equal(db.store.tradingSettings('robinhood', source.id).buySizeNative, null);
});

test('buy routing uses the calling channel size and filters while other channel and legacy rules differ', async (t) => {
  const db = database(t);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('Channel execution tests must remain offline'),
  );
  const first = channel();
  const second = channel('other');
  first.settings!.solana.buySizeNative = '0.01';
  first.settings!.solana.filters.marketCapEnabled = true;
  first.settings!.solana.filters.minMarketCapUsd = 5000;
  second.settings!.solana.buySizeNative = '0.02';
  second.settings!.solana.slippagePercent = 2;
  second.settings!.solana.filters.marketCapEnabled = true;
  second.settings!.solana.filters.minMarketCapUsd = 10000;
  db.store.saveCallChannel(first);
  db.store.saveCallChannel(second);
  db.store.updateSettings((settings) => {
    settings.chains.solana.enabled = false;
    settings.chains.solana.buySizeNative = '9';
    settings.blockedCallers = ['general', 'other'];
  });
  const amounts: string[] = [];
  const limits: number[] = [];
  const adapter: ChainAdapter = {
    chain: 'solana',
    address: 'offline-wallet',
    verifyNetwork: async () => {},
    balance: async () => ({ nativeRaw: '1000000000', wrappedRaw: null }),
    quoteSell: async () => assert.fail('No open position should be quoted'),
    readiness: () => [],
    tokenInfo: async () => ({
      chain: 'solana',
      address: mint,
      symbol: 'TEST',
      decimals: 6,
      marketCapUsd: 50000,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: Date.now(),
    }),
    advance: async (operation, _persist, beforeSwap, beforeSpend) => {
      await beforeSwap();
      beforeSpend();
      amounts.push(operation.amountRaw);
      throw new PendingTrade('Offline receipt pending');
    },
  };
  const engine = new TradeEngine(
    { listenOnly: false, maxSignalAgeMs: 120000 } as Config,
    db.store,
    { solana: adapter, robinhood: adapter },
    {
      check: async (_token: TokenInfo, settings: ChainSettings) => {
        limits.push(settings.filters.minMarketCapUsd!);
      },
    } as unknown as RiskFilters,
  );
  for (const [index, source] of [first, second].entries()) {
    const call = signal(Date.now(), source, index + 1);
    db.store.recordPost(
      { ...post(mint), channelId: call.channelId, messageId: call.messageId, date: call.date },
      call,
      null,
    );
  }
  await engine.tick();
  assert.equal(db.store.activeOperation('solana')!.settings.buySizeNative, '0.01');
  db.store.failOperation(
    db.store.activeOperation('solana')!,
    'Offline buy cancelled before submission',
    false,
  );
  db.store.updateChannelRules(first.id, 'solana', (settings) => {
    settings.enabled = false;
  });
  await engine.tick();
  assert.equal(db.store.activeOperation('solana')!.settings.slippagePercent, 2);
  assert.deepEqual(amounts, ['10000000', '20000000']);
  assert.deepEqual(limits, [5000, 10000]);
});

test('automatic exits use their position source and retain the correct execution rules after source removal', async (t) => {
  const db = database(t);
  const source = channel();
  const other = channel('other');
  source.settings!.solana.priorityFee = '0.00001';
  source.settings!.solana.exits.takeProfitEnabled = true;
  source.settings!.solana.exits.takeProfits = [
    { id: 'target', profitPercent: 50, sellPercent: 'rest' },
  ];
  other.settings!.solana.slippagePercent = 49;
  db.store.saveCallChannel(source);
  db.store.saveCallChannel(other);
  const buy = trade('source-buy', signal(Date.now(), source));
  buy.settings = db.store.tradingSettings('solana', source.id);
  const position = holding('source-position');
  position.exits = structuredClone(buy.settings.exits);
  assert.equal(db.store.claim(buy), true);
  db.store.completeBuy(buy, position, {
    tokenRaw: '100',
    nativeRaw: '1000100',
    swapNativeRaw: '1000000',
    feeNativeRaw: '100',
    signature: 'offline-buy',
    nativeUsd: 100,
  });
  db.store.updateChannelRules(source.id, 'solana', (settings) => {
    settings.slippagePercent = 3;
    settings.priorityFee = '0.00005';
    settings.exits.takeProfits[0]!.profitPercent = 1000;
  });
  const adapter: ChainAdapter = {
    chain: 'solana',
    address: 'offline-wallet',
    readiness: () => [],
    verifyNetwork: async () => {},
    balance: async () => ({ nativeRaw: '1000000000', wrappedRaw: null }),
    tokenInfo: async () => assert.fail('No buy should be considered during the exit'),
    quoteSell: async (_address, amountRaw) => ({
      inputRaw: amountRaw,
      outputRaw: '1600000',
      minOutputRaw: '1500000',
      nativeUsd: 100,
      priceImpactPercent: null,
      receivedAt: Date.now(),
    }),
    advance: async () => {
      throw new PendingTrade('Offline exit pending');
    },
  };
  const engine = new TradeEngine(
    { listenOnly: false } as Config,
    db.store,
    { solana: adapter, robinhood: adapter },
    {} as RiskFilters,
  );
  await engine.tick();
  const sale = db.store.activeOperation('solana')!;
  assert.equal(sale.kind, 'sell');
  assert.equal(sale.settings.slippagePercent, 3);
  assert.equal(sale.settings.priorityFee, '0.00005');
  assert.equal(sale.settings.exits.takeProfits[0]!.profitPercent, 50);
  db.store.removeCallChannel(source.id);
  db.restart();
  const restored = db.store.position(position.id)!;
  assert.equal(db.store.positionSettings(restored).slippagePercent, 3);
  assert.equal(db.store.positionSettings(restored).priorityFee, '0.00005');
  assert.equal(restored.exits.takeProfits[0]!.profitPercent, 50);
});
