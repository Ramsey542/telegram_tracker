import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chainSettingsSchema,
  emptyTrail,
  parseAmount,
  settingsSchema,
  type ChannelPost,
  type Operation,
  type Position,
  type Quote,
} from '../src/domain.js';
import { parseCall } from '../src/telegram/parser.js';
import { evaluateExits } from '../src/trading/exits.js';
import { Store } from '../src/infra/store.js';

const mint = '4U6QvbLXyTpJTiU9HbgaN9yGa6CQ7gXFnWL1HFaWpump';
function post(): ChannelPost {
  return {
    channelId: '-1001',
    messageId: 7,
    date: Date.now(),
    revision: 1,
    text: `HIGH CONSISTENCY CALLER (99%)\n@callername just posted Example at $405K marketcap.\nCA: ${mint}\nCaller Consistency:\nOverall: 44% | Recent: 35% | Chain: 43%\nTotal Calls For Project: 31`,
    urls: [
      `https://dexscreener.com/solana/${mint}`,
      'https://t.me/SpyDefi_bot?start=tgcallernametelegram-1001551999484',
    ],
  };
}
function position(): Position {
  return {
    id: 'position',
    chain: 'solana',
    address: mint,
    symbol: 'TEST',
    decimals: 6,
    caller: 'callername',
    originalTokenRaw: '1000000000',
    remainingTokenRaw: '1000000000',
    entryNativeRaw: '1000000000',
    entryFeeNativeRaw: '5000',
    entryUsd: null,
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
function quote(nativeRaw: string, tokenRaw = '1000000000'): Quote {
  return {
    inputRaw: tokenRaw,
    outputRaw: nativeRaw,
    minOutputRaw: nativeRaw,
    nativeUsd: null,
    priceImpactPercent: 0,
    receivedAt: Date.now(),
  };
}
test('consistency extraction uses the labeled section instead of the banner', () => {
  const parsed = parseCall(post());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.signal.consistency, { overall: 44, recent: 35, chain: 43 });
  assert.equal(parsed.signal.callerId, '-1001551999484');
  assert.equal(parsed.signal.tokenName, 'Example');
});
test('an EVM address and a footer cannot imply Robinhood', () => {
  const value = post();
  value.text = value.text.replace(mint, '0x787873c9ae96855bdb032f6ff1ef76a5e1fc8adc');
  value.urls = [
    'https://t.me/SpyDefiLiveRH',
    'https://dexscreener.com/ethereum/0x787873c9ae96855bdb032f6ff1ef76a5e1fc8adc',
  ];
  assert.equal(parseCall(value).ok, false);
});
test('missing consistency fails instead of turning into zero', () => {
  const value = post();
  value.text = value.text.replace('Chain: 43%', 'Chain: N/A');
  assert.equal(parseCall(value).ok, false);
});
test('a chart for a different token is rejected', () => {
  const value = post();
  value.urls[0] = 'https://dexscreener.com/solana/So11111111111111111111111111111111111111112';
  assert.equal(parseCall(value).ok, false);
});
test('money parsing retains exact 18 decimal precision', () => {
  assert.equal(parseAmount('0.123456789123456789', 18), 123456789123456789n);
  assert.throws(() => parseAmount('1e-9', 9));
  assert.throws(() => parseAmount('0.0000000001', 9));
});
test('exits and entry filters have no active defaults', () => {
  const settings = settingsSchema.parse({});
  for (const chain of ['solana', 'robinhood'] as const) {
    const value = settings.chains[chain];
    assert.equal(value.buySizeNative, null);
    assert.equal(value.filters.marketCapEnabled, false);
    assert.equal(value.exits.takeProfitEnabled, false);
    assert.equal(value.exits.stopLoss.enabled, false);
    assert.equal(value.exits.trailingSl.enabled, false);
    assert.deepEqual(value.consistency, { overall: 30, recent: 30, chain: 30 });
  }
});
test('incomplete exit rules cannot be enabled', () => {
  assert.throws(() =>
    chainSettingsSchema.parse({ exits: { stopLoss: { enabled: true, lossPercent: null } } }),
  );
  assert.throws(() => chainSettingsSchema.parse({ exits: { trailingTp: { enabled: true } } }));
});
test('TP percentages use the original entry and never repeat a completed tier', () => {
  const value = position();
  value.exits.takeProfitEnabled = true;
  value.exits.takeProfits = [
    { id: 'first', profitPercent: 50, sellPercent: 90 },
    { id: 'moon', profitPercent: 1000, sellPercent: 'rest' },
  ];
  const decision = evaluateExits(value, quote('1500000000'));
  assert.equal(decision?.amountRaw, '900000000');
  value.remainingTokenRaw = '100000000';
  value.exitFills['tp:first'] = '900000000';
  assert.equal(evaluateExits(value, quote('150000000', value.remainingTokenRaw)), null);
  assert.equal(
    evaluateExits(value, quote('1100000000', value.remainingTokenRaw))?.amountRaw,
    '100000000',
  );
});
test('confirmed entry fees are included when assessing the take profit trigger', () => {
  const value = position();
  value.exits.takeProfitEnabled = true;
  value.exits.takeProfits = [{ id: 'first', profitPercent: 50, sellPercent: 90 }];
  value.entryNativeRaw = '1010000000';
  assert.equal(evaluateExits(value, quote('1500000000')), null);
});
test('SL takes precedence and sells the whole remaining position', () => {
  const value = position();
  value.remainingTokenRaw = '100000000';
  value.exits.stopLoss = { enabled: true, lossPercent: 20 };
  assert.equal(
    evaluateExits(value, quote('80000000', value.remainingTokenRaw))?.amountRaw,
    '100000000',
  );
});
test('trailing TP activates, records a high watermark, and sells the configured remainder share', () => {
  const value = position();
  value.exits.trailingTp = {
    enabled: true,
    activationPercent: 50,
    drawdownPercent: 20,
    sellPercent: 50,
  };
  assert.equal(evaluateExits(value, quote('1400000000')), null);
  assert.equal(value.trailingTp.active, false);
  assert.equal(evaluateExits(value, quote('2000000000')), null);
  assert.equal(evaluateExits(value, quote('1590000000'))?.amountRaw, '500000000');
});
test('slippage bounds do not create an artificial stop loss', () => {
  const value = position();
  value.exits.stopLoss = { enabled: true, lossPercent: 20 };
  const current = quote('1000000000');
  current.minOutputRaw = '500000000';
  assert.equal(evaluateExits(value, current), null);
});
test('take profit follows the quoted gain rather than the worst slippage outcome', () => {
  const value = position();
  value.exits.takeProfitEnabled = true;
  value.exits.takeProfits = [{ id: 'first', profitPercent: 50, sellPercent: 90 }];
  const current = quote('1500000000');
  current.minOutputRaw = '1200000000';
  assert.equal(evaluateExits(value, current)?.amountRaw, '900000000');
});
test('a rejected caller does not reserve a token and an in-flight buy is durable across restarts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-tracker-check-'));
  let store: Store | null = null;
  try {
    store = new Store(directory);
    const parsed = parseCall(post());
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    store.recordPost(post(), parsed.signal, null);
    store.skipSignal(parsed.signal.id, 'Recent consistency below threshold');
    assert.equal(store.hasEntry('solana', mint), false);
    const operation: Operation = {
      id: 'buy',
      chain: 'solana',
      address: mint,
      kind: 'buy',
      status: 'active',
      positionId: null,
      signal: parsed.signal,
      exitKey: null,
      amountRaw: '100000000',
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
      swapHash: null,
      outputRaw: null,
      minimumNativeRaw: null,
      createdAt: Date.now(),
      error: null,
    };
    assert.equal(store.claim(operation), true);
    store.close();
    store = new Store(directory);
    assert.equal(store.hasEntry('solana', mint), true);
    assert.equal(store.claim({ ...operation, id: 'duplicate' }), false);
    store.failOperation(operation, 'Confirmed transaction failure', false);
    assert.equal(store.hasEntry('solana', mint), false);
    assert.equal(store.claim({ ...operation, id: 'later', status: 'active' }), true);
    const held = store.activeOperation('solana')!;
    store.failOperation(held, 'Unknown signature outcome', true);
    assert.equal(store.hasEntry('solana', mint), true);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
