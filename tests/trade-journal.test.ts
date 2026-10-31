import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../src/config.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { RiskFilters } from '../src/providers/risk.js';
import { PendingTrade, TradeRejected, type CallSignal, type ChannelPost } from '../src/domain.js';
import { configureLogging } from '../src/logging/logger.js';
import { Store } from '../src/infra/store.js';
import { TradeEngine } from '../src/trading/engine.js';

const firstSeen = Date.parse('2026-10-28T09:00:00.000Z');
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-trade-journal-'));
  const logDirectory = join(directory, 'logs');
  const restore = configureLogging({
    directory: logDirectory,
    level: 'info',
    console: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 2,
  });
  let now = firstSeen;
  let reject = false;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Journal tests must remain offline'));
  let store = new Store(directory);
  store.updateSettings((settings) => {
    settings.chains.solana.enabled = true;
    settings.chains.solana.buySizeNative = '0.1';
    settings.chains.solana.slippagePercent = 1;
  });
  let attempts = 0;
  const adapter: ChainAdapter = {
    chain: 'solana',
    address: 'offline-wallet',
    readiness: () => [],
    verifyNetwork: async () => {},
    balance: async () => ({ nativeRaw: '10000000000', wrappedRaw: null }),
    tokenInfo: async () => assert.fail('No external token data is needed for this fixture'),
    quoteSell: async () => assert.fail('No exit should be quoted in this fixture'),
    advance: async (operation, persist, beforeSwap, beforeSpend) => {
      attempts++;
      if (reject) throw new TradeRejected('Rejected by the offline fixture');
      if (operation.steps.length === 0) {
        await beforeSwap();
        operation.token.decimals = 6;
        now = firstSeen + 400;
        beforeSpend();
        operation.steps.push({
          type: 'solana',
          key: 'swap',
          signature: 'offline-receipt',
          serialized: 'opaque-offline-fixture',
          lastValidBlockHeight: 1000,
          submittedAt: now,
          bundleId: null,
          jito: false,
        });
        persist();
        throw new PendingTrade('Waiting for an offline fixture receipt');
      }
      return {
        tokenRaw: '1000000',
        nativeRaw: '100005000',
        swapNativeRaw: '100000000',
        feeNativeRaw: '5000',
        signature: 'offline-receipt',
        nativeUsd: 200,
      };
    },
  };
  const makeEngine = () =>
    new TradeEngine(
      { listenOnly: false, maxSignalAgeMs: 120000 } as Config,
      store,
      { solana: adapter, robinhood: { ...adapter, chain: 'robinhood' } },
      { check: async () => {} } as unknown as RiskFilters,
    );
  let engine = makeEngine();
  const post: ChannelPost = {
    channelId: '-1001',
    messageId: 1,
    date: firstSeen - 5000,
    revision: 1,
    text: 'Original offline signal message',
    urls: [],
  };
  const signal = (): CallSignal => ({
    id: '-1001:1',
    channelId: post.channelId,
    messageId: post.messageId,
    date: post.date,
    chain: 'solana',
    address: 'So11111111111111111111111111111111111111112',
    caller: 'offlinecaller',
    callerId: null,
    consistency: { overall: 50, recent: 50, chain: 50 },
    advertisedMarketCapUsd: 1000,
    tokenName: 'Offline token',
  });
  return {
    get store() {
      return store;
    },
    post,
    signal,
    attempts: () => attempts,
    setNow(offset: number) {
      now = firstSeen + offset;
    },
    rejectTrade() {
      reject = true;
    },
    tick: () => engine.tick(),
    restart() {
      store.close();
      store = new Store(directory);
      engine = makeEngine();
    },
    records(): Record<string, unknown>[] {
      const path = join(logDirectory, 'trades.jsonl');
      return existsSync(path)
        ? readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    },
    close() {
      store.close();
      restore();
      assert.ok(directory.startsWith(join(tmpdir(), 'telegram-trade-journal-')));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('first signal detection is logged once and survives duplicates, edits and a restart', (t) => {
  const value = fixture(t);
  try {
    const signal = value.signal();
    assert.equal(value.store.recordPost(value.post, signal, null), true);
    assert.equal(signal.detectedAt, firstSeen);
    value.setNow(1000);
    assert.equal(value.store.recordPost(value.post, value.signal(), null), false);
    const edited = { ...value.post, revision: 2, text: 'Edited offline signal' };
    const revised = { ...value.signal(), consistency: { overall: 60, recent: 50, chain: 50 } };
    assert.equal(value.store.recordPost(edited, revised, null), true);
    assert.equal(revised.detectedAt, firstSeen);
    value.setNow(2000);
    assert.equal(
      value.store.recordPost({ ...edited, revision: 3 }, null, 'Temporarily incomplete'),
      true,
    );
    value.restart();
    value.setNow(3000);
    assert.equal(value.store.recordPost({ ...edited, revision: 4 }, value.signal(), null), true);
    assert.equal(value.store.nextSignal('solana')?.detectedAt, firstSeen);
    assert.equal(value.records().length, 1);
    assert.equal(value.records()[0]!.event, 'signal.detected');
    assert.equal(value.records()[0]!.detectedAt, new Date(firstSeen).toISOString());
    assert.equal(value.records()[0]!.message, value.post.text);
  } finally {
    value.close();
  }
});

test('trade outcome measures from first local detection through submission and confirmation across restart', async (t) => {
  const value = fixture(t);
  try {
    value.store.recordPost(value.post, value.signal(), null);
    value.setNow(100);
    await value.tick();
    assert.equal(value.records().length, 1, 'Pending polling must not clutter the trade journal');
    value.restart();
    value.setNow(1500);
    await value.tick();
    const records = value.records();
    assert.deepEqual(
      records.map((record) => record.event),
      ['signal.detected', 'trade.confirmed'],
    );
    const outcome = records[1]!;
    assert.equal(outcome.signalId, records[0]!.signalId);
    assert.equal(outcome.detectedAt, new Date(firstSeen).toISOString());
    assert.equal(outcome.submittedAt, new Date(firstSeen + 400).toISOString());
    assert.equal(outcome.confirmedAt, new Date(firstSeen + 1500).toISOString());
    assert.equal(outcome.detectionToSubmissionMs, 400);
    assert.equal(outcome.detectionToConfirmationMs, 1500);
    assert.equal(outcome.executionMs, 1100);
    assert.equal(outcome.operationDurationMs, 1400);
    assert.equal(outcome.signature, 'offline-receipt');
    assert.equal(outcome.nativeRaw, '100005000');
    assert.equal(outcome.swapNativeRaw, '100000000');
    assert.equal(value.store.positions('solana')[0]!.entryNativeRaw, '100005000');
    assert.equal(value.store.positions('solana')[0]!.entrySwapNativeRaw, '100000000');
    assert.equal(
      outcome.reason,
      null,
      'A successful fill must not retain a previous pending reason',
    );
    await value.tick();
    assert.equal(value.records().length, 2);
  } finally {
    value.close();
  }
});

test('a failed trade gets one concise outcome with a detection-to-failure duration', async (t) => {
  const value = fixture(t);
  try {
    value.store.recordPost(value.post, value.signal(), null);
    value.rejectTrade();
    value.setNow(250);
    await value.tick();
    const records = value.records();
    assert.deepEqual(
      records.map((record) => record.event),
      ['signal.detected', 'trade.failed'],
    );
    assert.equal(records[1]!.detectionToDecisionMs, 250);
    assert.equal(records[1]!.detectionToConfirmationMs, null);
    assert.equal(records[1]!.reason, 'Rejected by the offline fixture');
  } finally {
    value.close();
  }
});

test('a filtered-out signal gets one skipped outcome without executing a trade', async (t) => {
  const value = fixture(t);
  try {
    const signal = value.signal();
    signal.consistency!.recent = 0;
    value.store.recordPost(value.post, signal, null);
    value.setNow(300);
    await value.tick();
    const records = value.records();
    assert.deepEqual(
      records.map((record) => record.event),
      ['signal.detected', 'trade.skipped'],
    );
    assert.equal(records[1]!.detectionToDecisionMs, 300);
    assert.match(String(records[1]!.reason), /recent consistency/);
    assert.equal(value.attempts(), 0);
  } finally {
    value.close();
  }
});
