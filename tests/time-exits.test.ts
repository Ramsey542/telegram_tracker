import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chains,
  chainSettingsSchema,
  emptyTrail,
  PendingTrade,
  type Chain,
  type Position,
} from '../src/domain.js';
import { evaluateTimeExit, timeExitDeadline } from '../src/trading/exits.js';
import { TradeEngine } from '../src/trading/engine.js';
import { Store } from '../src/infra/store.js';
import type { Config } from '../src/config.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { RiskFilters } from '../src/providers/risk.js';
import type { PositionPrices } from '../src/providers/position-prices.js';
import { exitReasonLabel } from '../src/trading/exit-reason.js';

const openedAt = 1_800_000_000_000;
function position(chain: Chain): Position {
  const settings = chainSettingsSchema.parse({
    slippagePercent: 5,
    exits: { timeExit: { enabled: true, minutes: 10 } },
  });
  return {
    id: `position-${chain}`,
    chain,
    address:
      chain === 'solana'
        ? 'So11111111111111111111111111111111111111112'
        : '0x1111111111111111111111111111111111111111',
    symbol: 'TEST',
    decimals: 6,
    caller: 'offline',
    originalTokenRaw: '1000000',
    remainingTokenRaw: '1000000',
    entryNativeRaw: '1000000000',
    entryFeeNativeRaw: '0',
    entryUsd: 100,
    realizedNativeRaw: '0',
    realizedFeeNativeRaw: '0',
    executionSettings: settings,
    exits: settings.exits,
    exitFills: {},
    trailingSl: emptyTrail(),
    trailingTp: emptyTrail(),
    openedAt,
    closedAt: null,
    lastProfitPercent: null,
    lastValueNativeRaw: null,
    lastValueUsd: null,
    lastError: null,
  };
}

for (const chain of chains) {
  test(`${chain} time exit respects the exact deadline and sells all remaining tokens regardless of profit`, () => {
    const value = position(chain);
    assert.equal(timeExitDeadline(value), openedAt + 600_000);
    assert.equal(evaluateTimeExit(value, openedAt + 599_999), null);
    for (const gain of [-90, 0, 200]) {
      value.lastProfitPercent = gain;
      assert.deepEqual(evaluateTimeExit(value, openedAt + 600_000), {
        key: 'time',
        amountRaw: '1000000',
      });
    }
    value.remainingTokenRaw = '250000';
    value.exitFills.manual = '750000';
    assert.deepEqual(evaluateTimeExit(value, openedAt + 900_000), {
      key: 'time',
      amountRaw: '250000',
    });
    for (const key of ['tp:first', 'sl', 'trail:tp:first', 'trail:sl']) {
      value.exitFills = { [key]: '1' };
      assert.equal(evaluateTimeExit(value, openedAt + 900_000), null);
    }
    assert.match(exitReasonLabel('time', value.exits), /10 minutes/);
  });

  test(`${chain} timed exits work after a restart without reference-price requests and reserve one sale`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tracker-time-exit-'));
    let store = new Store(directory);
    t.after(() => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    });
    t.mock.method(Date, 'now', () => openedAt + 600_001);
    store.savePosition(position(chain));
    store.close();
    store = new Store(directory);
    let executions = 0;
    const adapter = {
      advance: async () => {
        executions++;
        throw new PendingTrade('Offline confirmation pending');
      },
      quoteSell: async () => assert.fail('Timed exits must not request a monitoring quote'),
    } as unknown as ChainAdapter;
    const engine = new TradeEngine(
      { listenOnly: false, pollMs: 1000 } as Config,
      store,
      { solana: adapter, robinhood: adapter, bnb: adapter },
      {} as RiskFilters,
      undefined,
      {
        quotes: async (positions: readonly Position[]) => {
          assert.equal(positions.length, 0);
          return new Map();
        },
      } as unknown as PositionPrices,
    );
    await engine.tick(true);
    const operation = store.activeOperation(chain)!;
    assert.equal(operation.kind, 'sell');
    assert.equal(operation.exitKey, 'time');
    assert.equal(operation.amountRaw, '1000000');
    assert.equal(operation.settings.slippagePercent, 5);
    assert.equal(operation.quote, null);
    assert.equal(store.position(`position-${chain}`)?.timeExitOperationId, operation.id);
    await engine.tick();
    assert.equal(store.history().length, 1);
    assert.equal(executions, 2);
  });
}

test('a definitively failed time exit is not recreated on every monitoring tick', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tracker-time-failed-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  t.mock.method(Date, 'now', () => openedAt + 600_001);
  store.savePosition(position('solana'));
  const adapter = {
    advance: async () => {
      throw new Error('Offline route unavailable');
    },
  } as unknown as ChainAdapter;
  const engine = new TradeEngine(
    { listenOnly: false, pollMs: 1000 } as Config,
    store,
    { solana: adapter, robinhood: adapter, bnb: adapter },
    {} as RiskFilters,
  );
  await engine.tick();
  await engine.tick();
  assert.equal(store.history().length, 1);
  assert.equal(store.history()[0]?.status, 'failed');
  assert.match(store.position('position-solana')?.lastError ?? '', /Time exit failed/);
});

test('time exits are off for legacy settings and require a valid whole-minute limit before enabling', () => {
  assert.deepEqual(chainSettingsSchema.parse({}).exits.timeExit, { enabled: false, minutes: null });
  for (const minutes of [null, 0, -1, 1.5, 43201])
    assert.equal(
      chainSettingsSchema.safeParse({ exits: { timeExit: { enabled: true, minutes } } }).success,
      false,
    );
  const value = position('solana');
  value.timeExitOperationId = 'already-attempted';
  assert.equal(evaluateTimeExit(value, openedAt + 900_000), null);
});
