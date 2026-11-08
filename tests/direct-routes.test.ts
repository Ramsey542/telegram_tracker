import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFunctionData,
  encodeFunctionResult,
  zeroAddress,
  type PublicClient,
  type Address,
} from 'viem';
import {
  DirectEvmRoutes,
  directMinimum,
  directNetworks,
  portalAbi,
} from '../src/chains/direct-evm.js';
import { chainSettingsSchema, type Position, type Quote } from '../src/domain.js';
import { PositionPrices } from '../src/providers/position-prices.js';
import type { Config } from '../src/config.js';
import type { HttpClient } from '../src/infra/http.js';
import type { NativePrices } from '../src/providers/native-prices.js';
import type { ChainAdapter } from '../src/chains/types.js';
import { pumpFill } from '../src/chains/pump.js';
import type { VersionedTransactionResponse } from '@solana/web3.js';

const owner: Address = '0x1111111111111111111111111111111111111111';
const token: Address = '0x2222222222222222222222222222222222222222';
const state = {
  status: 1,
  reserve: 10n ** 18n,
  circulatingSupply: 1000n,
  price: 1n,
  tokenVersion: 2,
  r: 1n,
  h: 1n,
  k: 1n,
  dexSupplyThresh: 10000n,
  quoteTokenAddress: zeroAddress,
  nativeToQuoteSwapEnabled: false,
  extensionID: `0x${'0'.repeat(64)}` as const,
  taxRate: 0n,
  pool: zeroAddress,
  progress: 1n,
  lpFeeProfile: 0,
  dexId: 0,
};

test('direct routes default on and quote floors preserve the configured spend budget', () => {
  assert.equal(chainSettingsSchema.parse({}).directTradingEnabled, true);
  assert.equal(directMinimum(1000n, 10), 900n);
  for (const slippage of [-1, 101, NaN, Infinity])
    assert.throws(() => directMinimum(1000n, slippage));
  assert.throws(() => directMinimum(1n, 100));
});

test('Flap buys and sells use the correct chain portal, wallet-specific quote and original input amount', async () => {
  for (const chain of ['bnb', 'robinhood'] as const) {
    let quotes = 0;
    const routes = new DirectEvmRoutes(
      chain,
      {
        readContract: async () => state,
        call: async (request: { account: string; to: string; data: `0x${string}` }) => {
          assert.equal(request.account, owner);
          assert.equal(request.to, directNetworks[chain].portal);
          const decoded = decodeFunctionData({ abi: portalAbi, data: request.data });
          assert.equal(decoded.functionName, 'quoteExactInput');
          quotes++;
          return {
            data: encodeFunctionResult({
              abi: portalAbi,
              functionName: 'quoteExactInput',
              result: 1000n,
            }),
          };
        },
      } as unknown as PublicClient,
      owner,
    );
    const buy = await routes.quote(token, 100n, true, 10);
    assert.equal(buy!.value, '100');
    assert.equal(buy!.spender, null);
    const decoded = decodeFunctionData({ abi: portalAbi, data: buy!.data as `0x${string}` });
    assert.equal(decoded.functionName, 'swapExactInput');
    if (decoded.functionName === 'swapExactInput') {
      assert.equal(decoded.args[0].inputAmount, 100n);
      assert.equal(decoded.args[0].minOutputAmount, 900n);
      assert.equal(decoded.args[0].inputToken, zeroAddress);
      assert.equal(decoded.args[0].outputToken.toLowerCase(), token);
    }
    const sell = await routes.quote(token, 40n, false, 10);
    assert.equal(sell!.value, '0');
    assert.equal(sell!.spender, directNetworks[chain].portal);
    assert.equal(sell!.inputToken, token);
    assert.equal(sell!.outputToken, zeroAddress);
    assert.equal(quotes, 2);
  }
});

test('Flap inactive states and unsupported settlement assets fail before any transaction is built', async () => {
  for (const changed of [{ status: 5 }, { quoteTokenAddress: token }]) {
    const routes = new DirectEvmRoutes(
      'bnb',
      {
        readContract: async () => ({ ...state, ...changed }),
        call: async () => assert.fail('Unsupported Flap tokens must not quote or submit'),
      } as unknown as PublicClient,
      owner,
    );
    await assert.rejects(routes.quote(token, 100n, true, 10), /not tradable|native-asset quote/);
  }
});

test('Pancake routing batches candidates and chooses the larger executable output', async (t) => {
  let batches = 0;
  const routes = new DirectEvmRoutes(
    'bnb',
    {
      readContract: async () => ({ ...state, status: 0 }),
      multicall: async (request: { contracts: { functionName: string }[] }) => {
        batches++;
        return request.contracts.map((contract, index) =>
          index === 0
            ? {
                status: 'success',
                result:
                  contract.functionName === 'getAmountsOut' ? [100n, 1000n] : [1500n, [], [], 0n],
              }
            : { status: 'failure', error: new Error('Pool not available') },
        );
      },
    } as unknown as PublicClient,
    owner,
  );
  t.mock.method(routes as unknown as { infinity(): Promise<null> }, 'infinity', async () => null);
  const plan = await routes.quote(token, 100n, true, 10);
  assert.equal(plan!.venue, 'pancake-v3');
  assert.equal(plan!.to, directNetworks.bnb.smart);
  assert.equal(plan!.outputRaw, '1500');
  assert.equal(plan!.minimumRaw, '1350');
  assert.equal(plan!.value, '0');
  assert.equal(batches, 2);
});

test('direct position price polling bypasses external token prices and tolerates missing USD rates', async () => {
  const quote: Quote = {
    inputRaw: '100',
    outputRaw: '200',
    minOutputRaw: '200',
    nativeUsd: null,
    priceImpactPercent: null,
    receivedAt: Date.now(),
    source: 'direct:flap',
    estimated: true,
  };
  const prices = new PositionPrices(
    { pollMs: 1000 } as Config,
    {
      json: async () => assert.fail('Direct positions must not request external token prices'),
    } as unknown as HttpClient,
    {
      peek: () => null,
      get: async () => {
        throw new Error('USD service unavailable');
      },
    } as unknown as NativePrices,
    { bnb: { directReference: async () => quote } } as unknown as Record<
      'solana' | 'robinhood' | 'bnb',
      ChainAdapter
    >,
  );
  const result = await prices.quotes([
    {
      id: 'direct-position',
      chain: 'bnb',
      address: token,
      remainingTokenRaw: '100',
      decimals: 18,
      directVenue: 'flap',
    } as Position,
  ]);
  assert.equal(result.get('direct-position')!.outputRaw, '200');
  assert.equal(result.get('direct-position')!.nativeUsd, null);
});

test('Pump accounting refuses events without the expected program and wallet identity', () => {
  const receipt = {
    meta: {
      logMessages: [
        'Program 11111111111111111111111111111111 invoke [1]',
        'Program data: aW52YWxpZA==',
        'Program 11111111111111111111111111111111 success',
      ],
    },
  } as unknown as VersionedTransactionResponse;
  assert.throws(
    () => pumpFill(receipt, 'owner', 'mint', 'pump', true),
    /fill events are unavailable/,
  );
});
