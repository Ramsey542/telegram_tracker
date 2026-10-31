import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Config } from '../src/config.js';
import { exitSchema, type Chain, type Position } from '../src/domain.js';
import type { HttpClient } from '../src/infra/http.js';
import type { NativePrices } from '../src/providers/native-prices.js';
import { PositionPrices } from '../src/providers/position-prices.js';

const sol = 'So11111111111111111111111111111111111111112';
function position(address: string, chain: Chain = 'solana'): Position {
  return {
    id: address,
    chain,
    address,
    symbol: 'TEST',
    decimals: chain === 'solana' ? 6 : 18,
    caller: 'offline',
    originalTokenRaw: chain === 'solana' ? '100000000' : '100000000000000000000',
    remainingTokenRaw: chain === 'solana' ? '100000000' : '100000000000000000000',
    entryNativeRaw: '1000000000',
    entrySwapNativeRaw: '1000000000',
    entryFeeNativeRaw: '0',
    entryUsd: 100,
    realizedNativeRaw: '0',
    realizedFeeNativeRaw: '0',
    exits: exitSchema.parse({}),
    exitFills: {},
    trailingSl: { active: false, peakNativeRaw: '0', peakTokenRaw: '0', sold: false },
    trailingTp: { active: false, peakNativeRaw: '0', peakTokenRaw: '0', sold: false },
    openedAt: Date.now(),
    closedAt: null,
    lastProfitPercent: null,
    lastValueNativeRaw: null,
    lastValueUsd: null,
    lastError: null,
  };
}
function provider(reply: (url: URL) => unknown) {
  const requests: URL[] = [];
  const http = {
    json: async (_service: string, url: string) => {
      requests.push(new URL(url));
      return reply(new URL(url));
    },
  } as unknown as HttpClient;
  const native = {
    get: async () => assert.fail('Native price must come from the batch'),
  } as unknown as NativePrices;
  return {
    prices: new PositionPrices({ jupiterKey: 'offline', pollMs: 1000 } as Config, http, native),
    requests,
  };
}

test('Solana prices batch at most fifty mints including SOL and reuse a recent snapshot', async () => {
  const { prices, requests } = provider((url) =>
    Object.fromEntries(
      url.searchParams
        .get('ids')!
        .split(',')
        .map((mint) => [
          mint,
          { usdPrice: mint === sol ? 100 : 0.5, blockId: 1000, decimals: mint === sol ? 9 : 6 },
        ]),
    ),
  );
  const positions = Array.from({ length: 51 }, (_, index) => position(`offline-${index}`));
  const result = await prices.quotes(positions);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.searchParams.get('ids')!.split(',').length <= 50));
  assert.equal(result.size, 51);
  assert.equal(result.get('offline-0')!.outputRaw, '500000000');
  assert.equal(result.get('offline-0')!.nativeUsd, 100);
  assert.equal(result.get('offline-0')!.estimated, true);
  await prices.quotes(positions);
  assert.equal(requests.length, 2);
});

test('missing and stale prices cannot be interpreted as a zero-price stop loss', async () => {
  const { prices } = provider(() => ({
    [sol]: { usdPrice: 100, blockId: 1000, decimals: 9 },
    valid: { usdPrice: 1, blockId: 999, decimals: 6 },
    stale: { usdPrice: 1, blockId: 800, decimals: 6 },
  }));
  const result = await prices.quotes([position('valid'), position('missing'), position('stale')]);
  assert.equal(result.size, 1);
  assert.equal(result.get('valid')!.outputRaw, '1000000000');
});

test('concurrent position refreshes share one batch price request', async () => {
  const { prices, requests } = provider((url) =>
    Object.fromEntries(
      url.searchParams
        .get('ids')!
        .split(',')
        .map((mint) => [
          mint,
          { usdPrice: mint === sol ? 100 : 1, blockId: 1000, decimals: mint === sol ? 9 : 6 },
        ]),
    ),
  );
  const [first, second] = await Promise.all([
    prices.quotes([position('first')]),
    prices.quotes([position('second')]),
  ]);
  assert.equal(requests.length, 1);
  assert.ok(first.has('first'));
  assert.ok(second.has('second'));
});

test('Robinhood reference prices use a WETH pair to value holdings in ETH without a balance read', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  const { prices, requests } = provider(() => [
    {
      chainId: 'robinhood',
      baseToken: { address },
      quoteToken: { address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73' },
      priceUsd: '1',
      priceNative: '0.0005',
      liquidity: { usd: 10000 },
    },
  ]);
  const result = await prices.quotes([position(address, 'robinhood')]);
  assert.equal(requests.length, 1);
  assert.equal(result.get(address)!.nativeUsd, 2000);
  assert.equal(result.get(address)!.outputRaw, '50000000000000000');
});
