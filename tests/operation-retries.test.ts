import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chainSettingsSchema, PendingTrade, type Chain, type Operation } from '../src/domain.js';
import type { Config } from '../src/config.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { RiskFilters } from '../src/providers/risk.js';
import { HttpError } from '../src/infra/http.js';
import { Store } from '../src/infra/store.js';
import { TradeEngine } from '../src/trading/engine.js';

function fixture(t: TestContext, prepared = true) {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Retry checks must remain offline'));
  const directory = mkdtempSync(join(tmpdir(), 'telegram-operation-retries-'));
  let store = new Store(directory);
  let attempts = 0;
  let error: Error = new HttpError('Uniswap swap build', 404, {
    responseBody: JSON.stringify({
      errorCode: 'NotFound',
      detail: 'Simulation failed: 0x39d35496',
    }),
  });
  const operation: Operation = {
    id: 'offline-operation',
    chain: 'robinhood',
    address: '0x1111111111111111111111111111111111111111',
    kind: 'buy',
    status: 'active',
    positionId: null,
    signal: null,
    exitKey: null,
    amountRaw: '2000000000000000',
    token: {
      chain: 'robinhood',
      address: '0x1111111111111111111111111111111111111111',
      symbol: 'TEST',
      decimals: 18,
      marketCapUsd: null,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: Date.now(),
    },
    settings: chainSettingsSchema.parse({
      enabled: true,
      buySizeNative: '0.002',
      slippagePercent: 2,
    }),
    steps: prepared
      ? [
          {
            type: 'evm',
            key: 'wrap',
            hash: `0x${'1'.repeat(64)}`,
            serialized: '0x00',
            submittedAt: Date.now(),
            gasPaidRaw: '100',
          },
        ]
      : [],
    quote: null,
    swapHash: null,
    outputRaw: null,
    createdAt: Date.now(),
    error: null,
  };
  assert.equal(store.claim(operation), true);
  const adapter = (chain: Chain): ChainAdapter => ({
    chain,
    address: 'offline-wallet',
    readiness: () => [],
    verifyNetwork: async () => {},
    balance: async () => ({ nativeRaw: '1000000000000000000', wrappedRaw: null }),
    tokenInfo: async () => structuredClone(operation.token),
    quoteSell: async () => assert.fail('No positions should be quoted'),
    advance: async () => {
      attempts++;
      throw error;
    },
  });
  const createEngine = () =>
    new TradeEngine(
      { listenOnly: false } as Config,
      store,
      { solana: adapter('solana'), robinhood: adapter('robinhood'), bnb: adapter('bnb') },
      {} as RiskFilters,
    );
  let engine = createEngine();
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get engine() {
      return engine;
    },
    get store() {
      return store;
    },
    get attempts() {
      return attempts;
    },
    operation,
    setError(value: Error) {
      error = value;
    },
    restart() {
      store.close();
      store = new Store(directory);
      engine = createEngine();
    },
  };
}

test('insufficient Robinhood funds stop immediately and disable new entries without retrying', async (t) => {
  const value = fixture(t);
  value.store.updateSettings((settings) => {
    settings.chains.robinhood.enabled = true;
  });
  value.setError(
    new HttpError('Uniswap swap build', 422, {
      responseBody: { errorCode: 'InsufficientBalanceError', detail: 'Insufficient WETH balance' },
    }),
  );
  await value.engine.tick();
  assert.equal(value.attempts, 1);
  assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
  assert.equal(value.store.operation(value.operation.id)?.retryCount ?? 0, 0);
  assert.equal(value.store.settings().chains.robinhood.enabled, false);
  await value.engine.tick();
  assert.equal(value.attempts, 1);
});

test('prepared operations fail after three retries, release their reservation and notify the final cause', async (t) => {
  const value = fixture(t);
  for (let retry = 1; retry <= 3; retry++) {
    await value.engine.tick();
    assert.equal(value.store.operation(value.operation.id)?.status, 'active');
    assert.equal(value.store.operation(value.operation.id)?.retryCount, retry);
  }
  await value.engine.tick();
  const exhausted = value.store.operation(value.operation.id)!;
  assert.equal(value.attempts, 4);
  assert.equal(exhausted.status, 'failed');
  assert.match(exhausted.error!, /Automatic retry limit reached \(3 retries\)/);
  assert.match(exhausted.error!, /Simulation failed: 0x39d35496/);
  assert.doesNotMatch(exhausted.error!, /Manual review required/);
  assert.equal(exhausted.steps.length, 1);
  assert.equal(exhausted.steps[0]!.key, 'wrap');
  assert.equal(value.store.hasEntry(exhausted.chain, exhausted.address), false);
  assert.equal(value.store.activeOperation(exhausted.chain), null);
  await value.engine.tick();
  await value.engine.tick();
  assert.equal(value.attempts, 4);
  assert.throws(
    () => value.engine.reconcile(exhausted.id),
    /No matching operation awaiting review/,
  );
  const failures = value.store
    .notifications()
    .filter((notification) => notification.text.startsWith('Trade failed'));
  assert.equal(failures.length, 1);
  assert.match(failures[0]!.text, /Simulation failed: 0x39d35496/);
});

test('automatic retry counts survive a database restart', async (t) => {
  const value = fixture(t);
  await value.engine.tick();
  await value.engine.tick();
  value.restart();
  assert.equal(value.store.operation(value.operation.id)?.retryCount, 2);
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.retryCount, 3);
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
  assert.equal(value.attempts, 4);
});

test('receipt polling neither consumes nor resets the failed-execution retry budget', async (t) => {
  const value = fixture(t);
  await value.engine.tick();
  value.setError(new PendingTrade('Waiting for an offline receipt'));
  for (let poll = 0; poll < 8; poll++) await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'active');
  assert.equal(value.store.operation(value.operation.id)?.retryCount, 1);
  value.setError(new HttpError('Uniswap swap build', 404));
  for (let retry = 0; retry < 3; retry++) await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
});

test('an explicit reconciliation starts a new retry budget', async (t) => {
  const value = fixture(t);
  const held = value.store.operation(value.operation.id)!;
  held.retryCount = 3;
  value.store.failOperation(held, 'Unknown transaction outcome', true);
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'review');
  assert.equal(value.attempts, 0);
  value.engine.reconcile(value.operation.id);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(value.attempts, 1);
  assert.equal(value.store.operation(value.operation.id)?.status, 'active');
  assert.equal(value.store.operation(value.operation.id)?.retryCount, 1);
});

test('old retry-limit reviews become failed after restart without executing another attempt', async (t) => {
  const value = fixture(t);
  const held = value.store.operation(value.operation.id)!;
  held.retryCount = 3;
  value.store.failOperation(
    held,
    'Automatic retry limit reached (3 retries). Manual review required. Last error: Uniswap swap build returned HTTP 404',
    true,
  );
  value.restart();
  await value.engine.tick();
  const failed = value.store.operation(held.id)!;
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.error!, /Manual review required/);
  assert.match(failed.error!, /Uniswap swap build returned HTTP 404/);
  assert.equal(failed.steps.length, 1);
  assert.equal(value.store.activeOperation(failed.chain), null);
  assert.equal(value.store.hasEntry(failed.chain, failed.address), false);
  assert.equal(value.attempts, 0);
});

test('an unreadable provider error body still fails and sends the HTTP reason', async (t) => {
  const value = fixture(t);
  value.setError(
    new HttpError('Uniswap swap build', 502, { responseBody: '<html>Bad Gateway</html>' }),
  );
  for (let attempt = 0; attempt < 4; attempt++) await value.engine.tick();
  const failed = value.store.operation(value.operation.id)!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /Uniswap swap build returned HTTP 502/);
  assert.equal(value.store.activeOperation(failed.chain), null);
});

test('an error before any preparation transaction still fails without leaving a reservation', async (t) => {
  const value = fixture(t, false);
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
  assert.equal(value.store.hasEntry(value.operation.chain, value.operation.address), false);
  assert.equal(value.attempts, 1);
});
