import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTrail, exitSchema, type Position, type Quote } from '../src/domain.js';
import { evaluateExits } from '../src/trading/exits.js';

function fixture(): Position {
  return {
    id: 'offline',
    chain: 'solana',
    address: 'offline-token',
    symbol: 'TEST',
    decimals: 6,
    caller: 'offline',
    originalTokenRaw: '100000000',
    remainingTokenRaw: '100000000',
    entryNativeRaw: '1010000000',
    entrySwapNativeRaw: '1000000000',
    entryFeeNativeRaw: '10000000',
    entryUsd: 100,
    realizedNativeRaw: '0',
    realizedFeeNativeRaw: '0',
    exits: exitSchema.parse({
      takeProfitEnabled: true,
      takeProfits: [{ id: 'first', profitPercent: 50, sellPercent: 90 }],
      stopLoss: { enabled: true, lossPercent: 20 },
    }),
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
const quote = (outputRaw: string): Quote => ({
  inputRaw: '100000000',
  outputRaw,
  minOutputRaw: outputRaw,
  nativeUsd: 100,
  priceImpactPercent: null,
  receivedAt: Date.now(),
  estimated: true,
});

test('a partial hard TP triggers at its target without setting an execution price floor', () => {
  const decision = evaluateExits(fixture(), quote('1500000000'))!;
  assert.equal(decision.amountRaw, '90000000');
  assert.deepEqual(decision, { key: 'tp:first', amountRaw: '90000000' });
  assert.equal(evaluateExits(fixture(), quote('1499900000')), null);
});

for (const chain of ['solana', 'robinhood'] as const) {
  test(`${chain} stop loss sells all remaining tokens without setting an execution price floor`, () => {
    const value = fixture();
    value.chain = chain;
    value.entryNativeRaw = '1000000000';
    const decision = evaluateExits(value, quote('790000000'))!;
    assert.equal(decision.key, 'sl');
    assert.equal(decision.amountRaw, '100000000');
    assert.deepEqual(decision, { key: 'sl', amountRaw: '100000000' });
    assert.equal(evaluateExits(value, quote('800100000')), null);
    value.remainingTokenRaw = '10000000';
    const partial = evaluateExits(value, {
      ...quote('79000000'),
      inputRaw: value.remainingTokenRaw,
    })!;
    assert.equal(partial.amountRaw, '10000000');
    assert.deepEqual(partial, { key: 'sl', amountRaw: '10000000' });
  });

  test(`${chain} trailing stop loss triggers on drawdown without setting an execution price floor`, () => {
    const value = fixture();
    value.chain = chain;
    value.entryNativeRaw = '1000000000';
    value.exits.stopLoss.enabled = false;
    value.exits.takeProfitEnabled = false;
    value.exits.trailingSl = {
      enabled: true,
      activationPercent: 0,
      drawdownPercent: 20,
      sellPercent: 100,
    };
    assert.equal(evaluateExits(value, quote('1500000000')), null);
    const decision = evaluateExits(value, quote('1190000000'))!;
    assert.equal(decision.key, 'trail:sl');
    assert.equal(decision.amountRaw, '100000000');
    assert.deepEqual(decision, { key: 'trail:sl', amountRaw: '100000000' });
  });
}
