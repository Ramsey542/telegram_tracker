import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeFunctionResult,
  decodeFunctionData,
  zeroAddress,
  type Address,
  type PublicClient,
  erc20Abi,
  encodeAbiParameters,
  encodeEventTopics,
} from 'viem';
import { DirectEvmRoutes, directNetworks, portalAbi } from '../src/chains/direct-evm.js';
import { tracedNativeDelta } from '../src/chains/native-flow.js';
import { EvmAdapter } from '../src/chains/evm.js';
import { HttpClient } from '../src/infra/http.js';
import { MarketData } from '../src/providers/market.js';
import { chainSettingsSchema, ReviewRequired, type Operation } from '../src/domain.js';
import type { Config } from '../src/config.js';
import type { Wallets } from '../src/wallets.js';

const owner: Address = '0x1111111111111111111111111111111111111111';
const token: Address = '0x2222222222222222222222222222222222222222';
const quoteToken: Address = '0x3333333333333333333333333333333333333333';
const router: Address = '0x4444444444444444444444444444444444444444';
const state = {
  status: 1,
  reserve: 1000n,
  circulatingSupply: 1000n,
  price: 1n,
  tokenVersion: 2,
  r: 1n,
  h: 1n,
  k: 1n,
  dexSupplyThresh: 10000n,
  quoteTokenAddress: quoteToken,
  nativeToQuoteSwapEnabled: true,
  extensionID: `0x${'0'.repeat(64)}`,
  taxRate: 0n,
  pool: zeroAddress,
  progress: 1n,
  lpFeeProfile: 0,
  dexId: 0,
};

test('ERC20-quoted Flap buys preserve native budgets on both chains and sells request native output', async () => {
  for (const chain of ['bnb', 'robinhood'] as const) {
    const routes = new DirectEvmRoutes(
      chain,
      {
        readContract: async () => state,
        call: async (request: { account: string; data: `0x${string}` }) => {
          assert.equal(request.account, owner);
          const decoded = decodeFunctionData({ abi: portalAbi, data: request.data });
          assert.equal(decoded.functionName, 'quoteExactInput');
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
    assert.equal(buy!.flapQuoteToken, quoteToken);
    assert.equal(buy!.value, '100');
    assert.equal(buy!.inputToken, zeroAddress);
    assert.equal(buy!.spender, null);
    const built = decodeFunctionData({ abi: portalAbi, data: buy!.data as `0x${string}` });
    assert.equal(built.functionName, 'swapExactInput');
    if (built.functionName === 'swapExactInput') {
      assert.equal(built.args[0].inputAmount, 100n);
      assert.equal(built.args[0].minOutputAmount, 900n);
    }
    const sell = await routes.quote(token, 50n, false, 10);
    assert.equal(sell!.outputToken, zeroAddress);
    assert.equal(sell!.value, '0');
    assert.equal(sell!.spender, directNetworks[chain].portal);
  }
});

test('disabled native-to-quote conversion rejects a buy before quoting but permits native-output sell quotes', async () => {
  let calls = 0;
  const routes = new DirectEvmRoutes(
    'bnb',
    {
      readContract: async () => ({ ...state, nativeToQuoteSwapEnabled: false }),
      call: async () => {
        calls++;
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
  await assert.rejects(routes.quote(token, 100n, true, 10), /native conversion is disabled/);
  assert.equal(calls, 0);
  assert.equal((await routes.quote(token, 100n, false, 10))!.outputToken, zeroAddress);
  assert.equal(calls, 1);
});

test('native fill accounting includes refunds and excludes delegate-call inherited values and reverted branches', () => {
  const trace = {
    type: 'CALL',
    from: owner,
    to: router,
    value: '0x64',
    calls: [
      {
        type: 'DELEGATECALL',
        from: router,
        to: token,
        value: '0x64',
        calls: [{ type: 'CALL', from: router, to: owner, value: '0x14' }],
      },
      {
        type: 'CALL',
        from: owner,
        to: token,
        value: '0x32',
        error: 'execution reverted',
        calls: [{ type: 'CALL', from: token, to: owner, value: '0x32' }],
      },
    ],
  };
  assert.equal(tracedNativeDelta(trace, owner, router, '100'), -80n);
});

test('native sell proceeds come from successful native payouts instead of ERC20 quote units', () => {
  const trace = {
    type: 'CALL',
    from: owner,
    to: router,
    value: '0x0',
    calls: [
      { type: 'CALL', from: router, to: quoteToken, value: '0x0' },
      { type: 'CALL', from: router, to: owner, value: '0xc8' },
      { type: 'DELEGATECALL', from: router, to: owner, value: '0x64' },
    ],
  };
  assert.equal(tracedNativeDelta(trace, owner, router, '0'), 200n);
});

test('incomplete, reverted or mismatched native traces require reconciliation', () => {
  const valid = { type: 'CALL', from: owner, to: router, value: '0x64', calls: [] };
  for (const trace of [
    null,
    { ...valid, calls: undefined },
    { ...valid, from: token },
    { ...valid, value: '0x65' },
    { ...valid, error: 'execution reverted' },
  ])
    assert.throws(() => tracedNativeDelta(trace, owner, router, '100'), /trace/);
});

test('confirmed ERC20-quoted fills record actual native cost and preserve the signature if tracing fails', async (t) => {
  const hash = `0x${'1'.repeat(64)}`;
  const portal = directNetworks.bnb.portal;
  let failTrace = false;
  const methods: string[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = JSON.parse(String(init?.body));
      methods.push(request.method);
      let result: unknown;
      if (request.method === 'eth_chainId') result = '0x38';
      else if (request.method === 'eth_blockNumber') result = '0x3';
      else if (request.method === 'eth_getTransactionReceipt')
        result = {
          transactionHash: hash,
          blockHash: hash,
          blockNumber: '0x1',
          transactionIndex: '0x0',
          cumulativeGasUsed: '0xa',
          gasUsed: '0xa',
          effectiveGasPrice: '0x2',
          status: '0x1',
          type: '0x0',
          from: owner,
          to: portal,
          contractAddress: null,
          logs: [
            {
              address: token,
              topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: 'Transfer',
                args: { from: zeroAddress, to: owner },
              }),
              data: encodeAbiParameters([{ type: 'uint256' }], [1000n]),
              blockNumber: '0x1',
              transactionHash: hash,
              blockHash: hash,
              transactionIndex: '0x0',
              logIndex: '0x0',
              removed: false,
            },
          ],
        };
      else if (
        request.method === 'debug_traceTransaction' ||
        request.method === 'debug_traceCall'
      ) {
        if (failTrace)
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: { code: -32601, message: 'Tracing unavailable' },
            }),
          );
        result = {
          type: 'CALL',
          from: owner,
          to: portal,
          value: '0x64',
          calls: [{ type: 'CALL', from: portal, to: owner, value: '0x14' }],
        };
      } else assert.fail(`Unexpected RPC method: ${request.method}`);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    },
  );
  const config = { bnbRpc: 'https://bnb.test.invalid', httpTimeoutMs: 1000 } as Config;
  const http = new HttpClient(1000);
  const account = {
    address: owner,
    signTransaction: async () => assert.fail('No signing is allowed'),
  };
  const adapter = new EvmAdapter(
    config,
    { bnb: account } as unknown as Wallets,
    http,
    new MarketData(config, http),
    'bnb',
  );
  const operation = (): Operation =>
    ({
      id: 'test-operation',
      chain: 'bnb',
      kind: 'buy',
      address: token,
      amountRaw: '100',
      swapHash: null,
      settings: chainSettingsSchema.parse({ directTradingEnabled: true, mevProtection: false }),
      steps: [
        { type: 'evm', key: 'swap', hash, serialized: '0x', submittedAt: 1, gasPaidRaw: null },
      ],
      directEvmPlan: {
        venue: 'flap',
        to: portal,
        spender: null,
        inputToken: zeroAddress,
        outputToken: token,
        value: '100',
        data: '0x',
        outputRaw: '1000',
        minimumRaw: '900',
        receivedAt: Date.now(),
        flapQuoteToken: quoteToken,
      },
    }) as Operation;
  const result = await adapter.advance(
    operation(),
    () => {},
    async () => assert.fail('Saved swap must only reconcile'),
    () => assert.fail('No spending is allowed'),
  );
  assert.equal(result.swapNativeRaw, '80');
  assert.equal(result.feeNativeRaw, '20');
  assert.equal(result.nativeRaw, '100');
  assert.equal(result.tokenRaw, '1000');
  failTrace = true;
  const pending = operation();
  await assert.rejects(
    adapter.advance(
      pending,
      () => {},
      async () => {},
      () => assert.fail('No spending is allowed'),
    ),
    ReviewRequired,
  );
  assert.equal(pending.swapHash, hash);
  const fresh = operation();
  fresh.steps = [];
  const start = methods.length;
  await assert.rejects(
    adapter.advance(
      fresh,
      () => {},
      async () => assert.fail('Unsupported tracing must fail before filters or spending'),
      () => assert.fail('No spending is allowed'),
    ),
    /require QuickNode debug tracing/,
  );
  assert.deepEqual(methods.slice(start), ['debug_traceCall']);
});
