import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chainSettingsSchema, emptyTrail, type Operation, type Position } from '../src/domain.js';
import { Store } from '../src/infra/store.js';
import { HttpClient } from '../src/infra/http.js';
import { NativePrices } from '../src/providers/native-prices.js';
import { pnlFill, summarizePnl, usdValue } from '../src/pnl/accounting.js';
import { pnlWindow } from '../src/pnl/periods.js';
import type { PnlFill } from '../src/pnl/types.js';
import { pnlMessage, usdText } from '../src/telegram/pnl.js';
import { positionEntryPrice } from '../src/telegram/positions.js';
import { PnlTracker } from '../src/pnl/tracker.js';
import type { Config } from '../src/config.js';
import type { ChainAdapter } from '../src/chains/types.js';

const now = Date.parse('2026-10-28T18:00:00Z');
const yesterday = Date.parse('2026-10-27T12:00:00Z');
const day = pnlWindow('day', 0, 'UTC', now);
const dollar = (value: string) => usdValue(value, 0, 1)!;

function fill(values: Partial<PnlFill> = {}): PnlFill {
  return {
    operationId: 'buy',
    positionId: 'position',
    chain: 'solana',
    symbol: 'TEST',
    kind: 'buy',
    tokenRaw: '100',
    swapNativeRaw: '1000000000',
    walletNativeRaw: '1001000000',
    feeNativeRaw: '1000000',
    nativeUsd: 100,
    usdSource: 'swap_quote',
    usdAt: yesterday,
    confirmedAt: yesterday,
    legacy: false,
    ...values,
  };
}

function position(): Position {
  return {
    id: 'position',
    chain: 'solana',
    address: 'mint',
    symbol: 'TEST',
    decimals: 6,
    caller: 'caller',
    originalTokenRaw: '100',
    remainingTokenRaw: '100',
    entryNativeRaw: '1001000000',
    entrySwapNativeRaw: '1000000000',
    entryFeeNativeRaw: '1000000',
    entryUsd: 100.1,
    realizedNativeRaw: '0',
    realizedFeeNativeRaw: '0',
    exits: chainSettingsSchema.parse({}).exits,
    exitFills: {},
    trailingSl: emptyTrail(),
    trailingTp: emptyTrail(),
    openedAt: yesterday,
    closedAt: null,
    lastProfitPercent: null,
    lastValueNativeRaw: null,
    lastValueUsd: null,
    lastError: null,
  };
}

function operation(kind: 'buy' | 'sell' = 'buy'): Operation {
  return {
    id: kind,
    chain: 'solana',
    address: 'mint',
    kind,
    status: 'active',
    positionId: kind === 'sell' ? 'position' : null,
    signal: null,
    exitKey: null,
    amountRaw: kind === 'buy' ? '1000000000' : '100',
    token: {
      chain: 'solana',
      address: 'mint',
      symbol: 'TEST',
      decimals: 6,
      marketCapUsd: null,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: yesterday,
    },
    settings: chainSettingsSchema.parse({}),
    steps: [],
    swapHash: 'signature',
    outputRaw: null,
    quote: {
      inputRaw: '1000000000',
      outputRaw: '100',
      minOutputRaw: '100',
      nativeUsd: 100,
      priceImpactPercent: 0,
      receivedAt: yesterday,
    },
    minimumNativeRaw: null,
    createdAt: yesterday,
    error: null,
  };
}

test('USD accounting uses exact native units for SOL and ETH and rejects absent rates', () => {
  assert.equal(usdValue('1000000', 9, 100), 10_000_000n);
  assert.equal(usdValue('1000000000000000000', 18, 2000), 200_000_000_000n);
  assert.equal(usdValue('1000000000', 9, null), null);
  assert.equal(usdValue('1000000000', 9, Number.NaN), null);
});

test('entry price uses original acquired tokens and swap cost, independently of fees and remaining holdings', () => {
  const value = position();
  value.originalTokenRaw = '1000000000';
  value.remainingTokenRaw = '100000000';
  value.entryNativeRaw = '9000000000';
  const entry = fill({ tokenRaw: value.originalTokenRaw });
  const price = positionEntryPrice(value, entry);
  assert.equal(price, '0.001 SOL/token (approximately $0.1/token)');
  value.remainingTokenRaw = '1';
  assert.equal(positionEntryPrice(value, entry), price);
  assert.equal(positionEntryPrice(value, { ...entry, nativeUsd: null }), '0.001 SOL/token');
  assert.equal(positionEntryPrice(value, { ...entry, positionId: 'other' }), '0.001 SOL/token');
});

test('tiny entry prices stay nonzero and unknown swap costs stay unavailable', () => {
  const value = position();
  value.entrySwapNativeRaw = '1';
  value.originalTokenRaw = '1000000000';
  assert.equal(positionEntryPrice(value, null), '0.000000000001 SOL/token');
  delete value.entrySwapNativeRaw;
  assert.equal(positionEntryPrice(value, null), 'Unavailable');
  value.chain = 'robinhood';
  value.decimals = 18;
  value.originalTokenRaw = '10000000000000000000000';
  value.entryNativeRaw = '1005000000000000000';
  value.entryFeeNativeRaw = '5000000000000000';
  assert.equal(positionEntryPrice(value, null), '0.0001 ETH/token');
});

test('partial exits allocate historical USD cost, include network fees once, and use each sale exchange rate', () => {
  const first = fill({
    operationId: 'sell-1',
    kind: 'sell',
    tokenRaw: '25',
    swapNativeRaw: '500000000',
    walletNativeRaw: '499000000',
    nativeUsd: 120,
    confirmedAt: now - 2000,
  });
  const second = fill({
    operationId: 'sell-2',
    kind: 'sell',
    tokenRaw: '75',
    swapNativeRaw: '1000000000',
    walletNativeRaw: '999000000',
    nativeUsd: 90,
    confirmedAt: now - 1000,
  });
  const summary = summarizePnl([second, fill(), first], [], [], day, 'all', now);
  assert.equal(summary.buys, 0);
  assert.equal(summary.sells, 2);
  assert.equal(summary.pricedSales, 2);
  assert.equal(summary.allocatedCostUsd, 10_010_000_000n);
  assert.equal(summary.proceedsUsd, 14_979_000_000n);
  assert.equal(summary.realizedUsd, 4_969_000_000n);
  assert.equal(summary.networkFeesUsd, 21_000_000n);
  assert.equal(summary.winningSales, 2);
});

test('account funding remains separate from trade PNL and duplicate fill IDs are counted once', () => {
  const buy = fill({ confirmedAt: now - 3000, walletNativeRaw: '1500000000' });
  const sell = fill({
    operationId: 'sell',
    kind: 'sell',
    confirmedAt: now - 1000,
    swapNativeRaw: '1100000000',
    walletNativeRaw: '1099000000',
  });
  const summary = summarizePnl([buy, sell, { ...sell }], [], [], day, 'solana', now);
  assert.equal(summary.sells, 1);
  assert.equal(summary.realizedUsd, 980_000_000n);
  assert.equal(summary.networkFeesUsd, 20_000_000n);
  assert.equal(summary.fundingUsd, -4_990_000_000n);
});

test('missing USD rates or unknown sale amounts produce unavailable PNL instead of a zero or invented gain', () => {
  for (const missing of [
    { nativeUsd: null },
    { swapNativeRaw: null },
    { feeNativeRaw: null },
  ] as const) {
    const sale = fill({ operationId: 'sell', kind: 'sell', confirmedAt: now - 1000, ...missing });
    const summary = summarizePnl([fill(), sale], [], [], day, 'all', now);
    assert.equal(summary.realizedUsd, null);
    assert.equal(summary.pricedSales, 0);
    assert.equal(summary.sells, 1);
    assert.match(pnlMessage(summary).text, /Known realized PNL: Unavailable/);
    assert.match(pnlMessage(summary).text, /1 sale\(s\) excluded/);
  }
});

test('sales with incomplete entry history cannot create cost-free profits', () => {
  const sale = fill({
    operationId: 'sell',
    kind: 'sell',
    tokenRaw: '101',
    confirmedAt: now - 1000,
  });
  assert.equal(summarizePnl([fill(), sale], [], [], day, 'all', now).realizedUsd, null);
  assert.equal(summarizePnl([sale], [], [], day, 'all', now).realizedUsd, null);
});

test('open PNL uses remaining cost and a recent quote for exactly the tracked quantity', () => {
  const current = position();
  current.remainingTokenRaw = '75';
  const sale = fill({
    operationId: 'sell',
    kind: 'sell',
    tokenRaw: '25',
    confirmedAt: now - 2000,
    swapNativeRaw: '300000000',
  });
  const mark = {
    positionId: current.id,
    tokenRaw: '75',
    outputRaw: '900000000',
    nativeUsd: 100,
    receivedAt: now - 1000,
  };
  const summary = summarizePnl([fill(), sale], [current], [mark], day, 'all', now);
  assert.equal(summary.unrealizedUsd, 1_492_500_000n);
  assert.equal(summary.valuedPositions, 1);
  for (const invalid of [
    { ...mark, tokenRaw: '100' },
    { ...mark, receivedAt: now - 300_001 },
  ]) {
    const stale = summarizePnl([fill(), sale], [current], [invalid], day, 'all', now);
    assert.equal(stale.unrealizedUsd, null);
    assert.equal(stale.valuedPositions, 0);
  }
});

test('calendar periods use Monday weeks, correct month rollover, and local midnight across DST', () => {
  assert.equal(new Date(day.start).toISOString(), '2026-10-28T00:00:00.000Z');
  const week = pnlWindow('week', 0, 'UTC', now);
  assert.equal(new Date(week.start).toISOString(), '2026-10-26T00:00:00.000Z');
  const month = pnlWindow('month', 1, 'UTC', Date.parse('2027-01-15T12:00:00Z'));
  assert.equal(new Date(month.start).toISOString(), '2026-12-01T00:00:00.000Z');
  assert.equal(new Date(month.end).toISOString(), '2027-01-01T00:00:00.000Z');
  const spring = pnlWindow('day', 0, 'Europe/Berlin', Date.parse('2026-03-29T12:00:00Z'));
  assert.equal(spring.end - spring.start, 23 * 60 * 60 * 1000);
  const fall = pnlWindow('day', 0, 'Europe/Berlin', Date.parse('2026-10-25T12:00:00Z'));
  assert.equal(fall.end - fall.start, 25 * 60 * 60 * 1000);
  assert.throws(() => pnlWindow('day', -1), /Invalid PNL period/);
});

test('daily boundaries and chain filtering do not mix periods or native currencies', () => {
  const sale = fill({
    operationId: 'sell',
    kind: 'sell',
    confirmedAt: day.start,
    swapNativeRaw: '1100000000',
    walletNativeRaw: '1099000000',
  });
  const outside = { ...sale, operationId: 'later', confirmedAt: day.end };
  const summary = summarizePnl([fill(), sale, outside], [], [], day, 'solana', day.end + 1000);
  assert.equal(summary.sells, 1);
  assert.equal(summarizePnl([fill(), sale], [], [], day, 'robinhood', now).sells, 0);
});

test('fill conversion handles Robinhood gross proceeds without counting network fees twice', () => {
  const trade = operation('sell');
  trade.chain = 'robinhood';
  const result = pnlFill(
    trade,
    position(),
    {
      tokenRaw: '100',
      nativeRaw: '999000000',
      feeNativeRaw: '1000000',
      nativeUsd: 100,
      signature: 'signature',
    },
    now,
  );
  assert.equal(result.swapNativeRaw, null);
  trade.outputRaw = '1000000000';
  const known = pnlFill(
    trade,
    position(),
    {
      tokenRaw: '100',
      nativeRaw: '999000000',
      feeNativeRaw: '1000000',
      nativeUsd: 100,
      signature: 'signature',
    },
    now,
  );
  assert.equal(known.swapNativeRaw, '1000000000');
  assert.equal(known.walletNativeRaw, '999000000');
  assert.equal(known.feeNativeRaw, '1000000');
});

test('fill ledger and USD snapshots survive restarts and cannot be repriced using later spot prices', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-pnl-'));
  let store: Store | null = null;
  try {
    store = new Store(directory);
    const trade = operation();
    trade.quote!.nativeUsd = null;
    const current = position();
    assert.equal(store.claim(trade), true);
    store.completeBuy(trade, current, {
      tokenRaw: '100',
      nativeRaw: current.entryNativeRaw,
      swapNativeRaw: current.entrySwapNativeRaw,
      feeNativeRaw: current.entryFeeNativeRaw,
      nativeUsd: null,
      signature: 'signature',
    });
    assert.equal(store.pnlFills().length, 1);
    assert.equal(store.pnlPendingRates(yesterday + 1000).length, 1);
    assert.equal(store.pnlPendingRates(yesterday + 120_001).length, 0);
    assert.throws(
      () => store!.pricePnlFill(trade.id, 200, yesterday + 120_001),
      /near the fill time/,
    );
    store.pricePnlFill(trade.id, 100, yesterday + 10_000);
    store.pricePnlFill(trade.id, 999, yesterday + 20_000);
    store.close();
    store = new Store(directory);
    assert.equal(store.pnlFills().length, 1);
    assert.equal(store.pnlFills()[0]!.nativeUsd, 100);
    assert.equal(store.pnlFills()[0]!.usdSource, 'coinbase_spot');
    const sale = operation('sell');
    sale.createdAt = now - 1000;
    sale.quote!.receivedAt = now - 1000;
    store.claim(sale);
    store.completeSell(sale, current, {
      tokenRaw: '100',
      nativeRaw: '1099000000',
      swapNativeRaw: '1100000000',
      feeNativeRaw: '1000000',
      nativeUsd: 100,
      signature: 'sale-signature',
    });
    assert.equal(store.pnlFills().length, 2);
    assert.equal(store.pnlFills()[1]!.walletNativeRaw, '1099000000');
    const sold = store.notifications().find((value) => value.text.startsWith('Sold '))!;
    assert.match(sold.text, /Reason: Manual sale/);
    assert.match(sold.text, /Sold: 0\.0001 tokens/);
    assert.match(sold.text, /Remaining: 0 tokens/);
    assert.match(sold.text, /Net proceeds: 1\.099 SOL/);
    assert.match(sold.text, /Transaction: sale-signature/);
    assert.equal(sold.solanaSignature, 'sale-signature');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('native USD fallback uses public spot prices and shares cached in-flight requests', async (context) => {
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    requests++;
    assert.equal(String(input), 'https://api.coinbase.com/v2/prices/ETH-USD/spot');
    return Response.json({ data: { amount: '2500.25', currency: 'USD' } });
  });
  const prices = new NativePrices(new HttpClient(1000));
  const values = await Promise.all([prices.get('robinhood'), prices.get('robinhood')]);
  assert.equal(values[0]!.value, 2500.25);
  assert.equal(values[1]!.value, 2500.25);
  await prices.get('robinhood');
  assert.equal(requests, 1);
});

test('legacy records without actual sale amounts remain visible and unavailable after migration', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-pnl-legacy-'));
  let store: Store | null = null;
  try {
    store = new Store(directory);
    const current = position();
    current.closedAt = now;
    current.remainingTokenRaw = '0';
    store.savePosition(current);
    const buy = operation();
    buy.status = 'confirmed';
    store.saveOperation(buy);
    const sale = operation('sell');
    sale.status = 'confirmed';
    sale.createdAt = now - 1000;
    sale.quote!.receivedAt = now - 1000;
    store.saveOperation(sale);
    store.close();
    store = new Store(directory);
    const fills = store.pnlFills();
    assert.equal(fills.length, 2);
    assert.equal(fills.find((value) => value.kind === 'sell')!.swapNativeRaw, null);
    const summary = summarizePnl(fills, [], [], day, 'all', now);
    assert.equal(summary.sells, 1);
    assert.equal(summary.realizedUsd, null);
    assert.equal(summary.estimatedFills, 1);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const scenario of ['quotes', 'listen-only', 'trade-active'] as const) {
  test(`background PNL refresh respects ${scenario} and never executes a trade`, async (context) => {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-pnl-tracker-'));
    const store = new Store(directory);
    let quotes = 0;
    const adapter: ChainAdapter = {
      chain: 'solana',
      address: 'offline-wallet',
      readiness: () => [],
      verifyNetwork: async () => {},
      balance: async () => ({ nativeRaw: '0', wrappedRaw: null }),
      tokenInfo: async () => assert.fail('Token data must not be requested'),
      advance: async () => assert.fail('PNL must never execute a trade'),
      quoteSell: async (_address, amount) => {
        quotes++;
        return {
          inputRaw: amount,
          outputRaw: '1100000000',
          minOutputRaw: '1000000000',
          nativeUsd: 100,
          priceImpactPercent: 0,
          receivedAt: Date.now(),
        };
      },
    };
    context.mock.method(globalThis, 'fetch', async () =>
      assert.fail('These refreshes need no external requests'),
    );
    const tracker = new PnlTracker(
      { listenOnly: scenario === 'listen-only' } as Config,
      store,
      { solana: adapter, robinhood: { ...adapter, chain: 'robinhood' } },
      new NativePrices(new HttpClient(1000)),
    );
    try {
      const current = position();
      store.savePosition(current);
      if (scenario === 'trade-active') store.claim({ ...operation(), address: 'other-token' });
      if (scenario === 'listen-only') assert.throws(() => tracker.requestQuotes(), /listen-only/);
      else {
        tracker.requestQuotes();
        assert.equal(tracker.updating, true);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      assert.equal(quotes, scenario === 'quotes' ? 1 : 0);
      assert.equal(store.pnlMarks().length, scenario === 'quotes' ? 1 : 0);
      assert.equal(store.position(current.id)!.remainingTokenRaw, current.remainingTokenRaw);
      assert.deepEqual(store.position(current.id)!.trailingTp, current.trailingTp);
    } finally {
      await tracker.stop();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('USD display preserves sign, sub-cent results and Telegram text styles', () => {
  assert.equal(usdText(dollar('10'), true), '+$10.00');
  assert.equal(usdText(-1n, true), '-<$0.01');
  const summary = summarizePnl([], [], [], day, 'all', now);
  const rendered = pnlMessage(summary);
  assert.match(rendered.text, /USD PNL - Daily/);
  assert.match(rendered.text, /Realized PNL: \$0.00/);
  assert.ok(rendered.entities.some((entity) => entity.type === 'bold'));
  assert.doesNotMatch(rendered.text, /NaN|Infinity/);
});
