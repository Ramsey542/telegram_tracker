import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseTransaction,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Config } from '../src/config.js';
import type { Wallets } from '../src/wallets.js';
import type { ChainAdapter } from '../src/chains/types.js';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_WETH, RobinhoodAdapter } from '../src/chains/robinhood.js';
import { chainSettingsSchema, type Operation } from '../src/domain.js';
import { HttpClient } from '../src/infra/http.js';
import { Store } from '../src/infra/store.js';
import { MarketData } from '../src/providers/market.js';
import { RiskFilters } from '../src/providers/risk.js';
import { TradeEngine } from '../src/trading/engine.js';

const require = createRequire(import.meta.url);
const { PERMIT2_MAPPING } = require('@uniswap/uniswapx-sdk');
const {
  UNIVERSAL_ROUTER_ADDRESS,
  UniversalRouterVersion,
} = require('@uniswap/universal-router-sdk');
const router = UNIVERSAL_ROUTER_ADDRESS(
  UniversalRouterVersion.V2_1_2,
  ROBINHOOD_CHAIN_ID,
) as Address;
const token = '0x1111111111111111111111111111111111111111' as const;
const wallet = privateKeyToAccount(`0x${'12'.repeat(32)}`);
const inputRaw = 2_000_000_000_000_000n;
const outputRaw = 1_000_000n;
const blockHash = `0x${'ab'.repeat(32)}`;
const rpcUrl = 'https://classic.test.invalid/';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-classic-'));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'telegram-classic-')));
    rmSync(directory, { recursive: true, force: true });
  });
  const config = { robinhoodRpc: rpcUrl, httpTimeoutMs: 1000, listenOnly: false } as Config;
  const operation: Operation = {
    id: 'classic-buy',
    chain: 'robinhood',
    address: token,
    kind: 'buy',
    status: 'active',
    positionId: null,
    signal: null,
    exitKey: null,
    amountRaw: inputRaw.toString(),
    token: {
      chain: 'robinhood',
      address: token,
      symbol: 'CALL',
      decimals: null,
      marketCapUsd: null,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: Date.now(),
    },
    settings: chainSettingsSchema.parse({
      enabled: true,
      buySizeNative: '0.002',
      slippagePercent: 2,
      mevProtection: false,
      wrapMyEth: true,
      filters: { rejectHoneypot: true },
    }),
    steps: [],
    quote: null,
    swapHash: null,
    outputRaw: null,
    createdAt: Date.now(),
    error: null,
  };
  store.updateSettings((settings) => {
    settings.chains.robinhood = operation.settings;
  });
  const quote = {
    routing: 'CLASSIC',
    permitData: null,
    quote: {
      input: { token: ROBINHOOD_WETH, amount: inputRaw.toString() },
      output: { token, amount: outputRaw.toString() },
      swapper: wallet.address,
      chainId: ROBINHOOD_CHAIN_ID,
      slippage: 2,
      priceImpact: 0.1,
      route: [
        [
          {
            tokenOut: {
              address: token,
              chainId: ROBINHOOD_CHAIN_ID,
              symbol: 'QUOTE',
              decimals: '6',
            },
          },
        ],
      ],
    },
  };
  const data = encodeFunctionData({
    abi: [
      {
        type: 'function',
        name: 'execute',
        stateMutability: 'payable',
        inputs: [
          { name: 'commands', type: 'bytes' },
          { name: 'inputs', type: 'bytes[]' },
          { name: 'deadline', type: 'uint256' },
        ],
        outputs: [],
      },
    ],
    functionName: 'execute',
    args: [
      '0x08',
      [
        encodeAbiParameters(
          [
            { type: 'address' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'address[]' },
            { type: 'bool' },
            { type: 'uint256[]' },
          ],
          [wallet.address, inputRaw, 980_000n, [ROBINHOOD_WETH, token], true, [0n]],
        ),
      ],
      BigInt(Math.floor(Date.now() / 1000) + 120),
    ],
  });
  const swap: Record<string, unknown> = {
    to: router,
    from: wallet.address,
    data,
    value: '0',
    chainId: ROBINHOOD_CHAIN_ID,
    gasLimit: '150000',
    maxFeePerGas: '3000000000',
    maxPriorityFeePerGas: '1000000000',
  };
  const calls: string[] = [];
  const builds: Record<string, unknown>[] = [];
  const sent: Hex[] = [];
  const signed: Hex[] = [];
  const quoteStarted = deferred();
  const securityStarted = deferred();
  const nonceStarted = deferred();
  const marketStarted = deferred();
  let quoteGate = Promise.resolve();
  let marketGate = Promise.resolve();
  let simulationError: string | null = null;
  let submissionError: 'funds' | 'gas' | 'timeout' | null = null;
  let receiptAvailable = true;
  let height = 101;
  let honeypot = '0';
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.href === rpcUrl) {
        const body = JSON.parse(String(init?.body));
        calls.push(body.method);
        const response = (result: unknown) =>
          Response.json({ jsonrpc: '2.0', id: body.id, result });
        switch (body.method) {
          case 'eth_chainId':
            return response('0x1237');
          case 'eth_getTransactionCount':
            assert.equal(body.params[1], 'pending');
            nonceStarted.resolve();
            return response('0x3');
          case 'eth_sendRawTransaction': {
            const saved = store.operation(operation.id)!;
            assert.equal(saved.steps[0]?.type, 'evm');
            assert.ok(saved.steps[0]?.submittedAt);
            sent.push(body.params[0]);
            if (submissionError === 'timeout') throw new TypeError('Offline broadcast timeout');
            if (submissionError === 'funds')
              return Response.json({
                jsonrpc: '2.0',
                id: body.id,
                error: { code: -32000, message: 'insufficient funds for gas * price + value' },
              });
            if (submissionError === 'gas')
              return Response.json({
                jsonrpc: '2.0',
                id: body.id,
                error: { code: -32000, message: 'intrinsic gas too low' },
              });
            return response(keccak256(body.params[0]));
          }
          case 'eth_getTransactionReceipt': {
            if (!receiptAvailable) return response(null);
            const hash = body.params[0];
            const transfer = (
              address: Address,
              from: Address,
              to: Address,
              value: bigint,
              index: number,
            ) => ({
              address,
              topics: encodeEventTopics({
                abi: erc20Abi,
                eventName: 'Transfer',
                args: { from, to },
              }),
              data: encodeAbiParameters([{ type: 'uint256' }], [value]),
              blockHash,
              blockNumber: '0x64',
              transactionHash: hash,
              transactionIndex: '0x0',
              logIndex: `0x${index}`,
              removed: false,
            });
            return response({
              transactionHash: hash,
              transactionIndex: '0x0',
              blockHash,
              blockNumber: '0x64',
              from: wallet.address,
              to: router,
              cumulativeGasUsed: '0x5208',
              gasUsed: '0x5208',
              effectiveGasPrice: '0x3b9aca00',
              contractAddress: null,
              status: '0x1',
              type: '0x2',
              logsBloom: `0x${'00'.repeat(256)}`,
              logs: [
                transfer(ROBINHOOD_WETH, wallet.address, router, inputRaw, 0),
                transfer(token, router, wallet.address, outputRaw, 1),
              ],
            });
          }
          case 'eth_blockNumber':
            return response(`0x${height.toString(16)}`);
          default:
            return assert.fail(`Unexpected Classic buy RPC: ${body.method}`);
        }
      }
      if (url.pathname === '/v1/quote') {
        calls.push('quote');
        quoteStarted.resolve();
        await quoteGate;
        return Response.json(quote);
      }
      if (url.pathname === '/v1/swap') {
        calls.push('swap');
        const body = JSON.parse(String(init?.body));
        assert.equal(body.simulateTransaction, true);
        assert.equal(body.refreshGasPrice, true);
        builds.push(body);
        if (simulationError) return Response.json({ detail: simulationError }, { status: 422 });
        return Response.json({ swap });
      }
      if (url.hostname === 'api.gopluslabs.io') {
        calls.push('goplus');
        securityStarted.resolve();
        return Response.json({ code: 1, result: { [token]: { is_honeypot: honeypot } } });
      }
      if (url.hostname === 'api.dexscreener.com') {
        calls.push('market');
        marketStarted.resolve();
        await marketGate;
        return Response.json([
          {
            chainId: 'robinhood',
            pairAddress: router,
            baseToken: { address: token, symbol: 'DEX' },
            quoteToken: { address: ROBINHOOD_WETH, symbol: 'WETH' },
            marketCap: 100000,
            liquidity: { usd: 50000 },
            priceUsd: '0.5',
          },
        ]);
      }
      return assert.fail(`Unexpected Classic buy API: ${url.href}`);
    },
  );
  const account = {
    ...wallet,
    signTransaction: async (...args: Parameters<typeof wallet.signTransaction>) => {
      const serialized = await wallet.signTransaction(...args);
      signed.push(serialized);
      return serialized;
    },
  };
  const http = new HttpClient(1000);
  const adapter = new RobinhoodAdapter(
    config,
    { robinhood: account } as Wallets,
    http,
    new MarketData(config, http),
  );
  const engine = new TradeEngine(
    config,
    store,
    { robinhood: adapter, solana: {} as ChainAdapter },
    new RiskFilters(config, http),
  );
  // Keep the unrelated chain idle without invoking a fake adapter.
  store.updateSettings((settings) => {
    settings.chains.solana.enabled = false;
  });
  return {
    store,
    operation,
    quote,
    swap,
    calls,
    builds,
    sent,
    signed,
    adapter,
    engine,
    quoteStarted,
    securityStarted,
    nonceStarted,
    marketStarted,
    claim() {
      assert.equal(store.claim(operation), true);
    },
    holdQuote(gate: Promise<void>) {
      quoteGate = gate;
    },
    holdMarket(gate: Promise<void>) {
      marketGate = gate;
    },
    simulationFailure(message: string) {
      simulationError = message;
    },
    submissionFailure(value: typeof submissionError) {
      submissionError = value;
    },
    receipt(value: boolean) {
      receiptAvailable = value;
    },
    block(value: number) {
      height = value;
    },
    rejectHoneypot() {
      honeypot = '1';
    },
  };
}

test(
  'Classic buy overlaps quote, GoPlus and nonce and uses exactly four steady-state RPC calls',
  { timeout: 5000 },
  async (t) => {
    const value = harness(t);
    await value.adapter.verifyNetwork();
    value.calls.length = 0;
    const gate = deferred();
    t.after(gate.resolve);
    value.holdQuote(gate.promise);
    value.claim();
    const pending = value.engine.tick();
    await Promise.all([
      value.quoteStarted.promise,
      value.securityStarted.promise,
      value.nonceStarted.promise,
    ]);
    assert.equal(value.calls.includes('swap'), false);
    gate.resolve();
    await pending;
    assert.equal(value.signed.length, 1);
    const transaction = parseTransaction(value.signed[0]!);
    assert.equal(transaction.gas, 150000n);
    assert.equal(transaction.maxFeePerGas, 3000000000n);
    assert.equal(transaction.maxPriorityFeePerGas, 1000000000n);
    assert.equal(transaction.nonce, 3);
    await value.engine.tick();
    assert.equal(value.store.operation(value.operation.id)?.status, 'confirmed');
    const position = value.store.positions('robinhood')[0]!;
    assert.equal(position.symbol, 'QUOTE');
    assert.equal(position.decimals, 6);
    assert.equal(position.originalTokenRaw, outputRaw.toString());
    assert.deepEqual(
      value.calls.filter((call) => call.startsWith('eth_')),
      [
        'eth_getTransactionCount',
        'eth_sendRawTransaction',
        'eth_getTransactionReceipt',
        'eth_blockNumber',
      ],
    );
    assert.deepEqual(value.calls.filter((call) => !call.startsWith('eth_')).sort(), [
      'goplus',
      'quote',
      'swap',
    ]);
  },
);

test(
  'enabled market filters fetch data alongside GoPlus without metadata RPCs',
  { timeout: 5000 },
  async (t) => {
    const value = harness(t);
    value.operation.settings.filters.marketCapEnabled = true;
    value.operation.settings.filters.minMarketCapUsd = 1000;
    value.operation.settings.filters.minLiquidityUsd = 1000;
    const gate = deferred();
    t.after(gate.resolve);
    value.holdMarket(gate.promise);
    value.claim();
    const pending = value.engine.tick();
    await Promise.all([
      value.marketStarted.promise,
      value.securityStarted.promise,
      value.quoteStarted.promise,
    ]);
    assert.equal(value.calls.includes('swap'), false);
    gate.resolve();
    await pending;
    assert.equal(value.sent.length, 1);
    assert.equal(value.calls.filter((call) => call === 'market').length, 1);
  },
);

for (const invalid of [
  'missing decimals',
  'wrong chain',
  'invalid decimals',
  'missing symbol',
] as const) {
  test(`Classic buy rejects ${invalid} before signing without a metadata fallback`, async (t) => {
    const value = harness(t);
    const metadata = value.quote.quote.route[0]![0]!.tokenOut;
    if (invalid === 'missing decimals') Reflect.deleteProperty(metadata, 'decimals');
    if (invalid === 'wrong chain') metadata.chainId = 1;
    if (invalid === 'invalid decimals') metadata.decimals = '37';
    if (invalid === 'missing symbol') Reflect.deleteProperty(metadata, 'symbol');
    value.claim();
    await value.engine.tick();
    assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
    assert.match(value.store.operation(value.operation.id)?.error ?? '', /output token metadata/);
    assert.equal(value.signed.length, 0);
    assert.equal(value.calls.includes('swap'), false);
  });
}

for (const field of ['gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas']) {
  test(`Classic buy rejects missing ${field} without RPC estimates`, async (t) => {
    const value = harness(t);
    delete value.swap[field];
    value.claim();
    await value.engine.tick();
    assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
    assert.match(value.store.operation(value.operation.id)?.error ?? '', /invalid gas fields/);
    assert.equal(value.signed.length, 0);
    assert.equal(value.sent.length, 0);
  });
}

test('GoPlus rejection blocks swap construction and signing', async (t) => {
  const value = harness(t);
  value.rejectHoneypot();
  value.claim();
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
  assert.match(value.store.operation(value.operation.id)?.error ?? '', /Honeypot: detected/);
  assert.equal(value.calls.includes('swap'), false);
  assert.equal(value.signed.length, 0);
});

test('simulation failure reports the provider cause once without wrapping or approval', async (t) => {
  const value = harness(t);
  value.simulationFailure('Insufficient WETH balance');
  value.claim();
  await value.engine.tick();
  await value.engine.tick();
  const operation = value.store.operation(value.operation.id)!;
  assert.equal(operation.status, 'failed');
  assert.equal(operation.retryCount ?? 0, 0);
  assert.match(operation.error ?? '', /Insufficient WETH balance/);
  assert.match(
    value.store
      .notifications()
      .map((item) => item.text)
      .join('\n'),
    /Insufficient WETH balance/,
  );
  assert.equal(value.builds.length, 1);
  assert.equal(value.signed.length, 0);
  assert.equal(operation.steps.length, 0);
});

test('insufficient ETH at broadcast fails and reports the funds error', async (t) => {
  const value = harness(t);
  value.submissionFailure('funds');
  value.claim();
  await value.engine.tick();
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
  assert.match(value.store.operation(value.operation.id)?.error ?? '', /insufficient funds/);
  assert.equal(value.sent.length, 1);
});

test('uncertain broadcast is reported and reconciled across restart without rebuilding or rebroadcasting', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const value = harness(t);
  value.submissionFailure('timeout');
  value.receipt(false);
  value.claim();
  await value.engine.tick();
  assert.match(
    value.store
      .notifications()
      .map((item) => item.text)
      .join('\n'),
    /submission outcome is uncertain/,
  );
  const restored = value.store.operation(value.operation.id)!;
  const config = { robinhoodRpc: rpcUrl, httpTimeoutMs: 1000, listenOnly: false } as Config;
  const http = new HttpClient(1000);
  const adapter = new RobinhoodAdapter(
    config,
    { robinhood: wallet } as Wallets,
    http,
    new MarketData(config, http),
  );
  now += 31000;
  await assert.rejects(
    adapter.advance(
      restored,
      () => value.store.saveOperation(restored),
      async () => assert.fail('A saved swap must not repeat risk checks'),
      () => assert.fail('A saved swap must not be signed or rebroadcast'),
    ),
    /Waiting for Robinhood confirmation/,
  );
  value.receipt(true);
  const result = await adapter.advance(
    restored,
    () => value.store.saveOperation(restored),
    async () => assert.fail('A saved swap must not request another quote'),
    () => {},
  );
  assert.equal(result.tokenRaw, outputRaw.toString());
  assert.equal(value.sent.length, 1);
  assert.equal(value.signed.length, 1);
  assert.equal(value.builds.length, 1);
  assert.equal(result.signature, keccak256(value.sent[0]!));
});

test('confirmation reads a fresh height on consecutive polls', async (t) => {
  const value = harness(t);
  value.block(100);
  value.claim();
  await value.engine.tick();
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'active');
  value.block(101);
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'confirmed');
  assert.equal(value.calls.filter((call) => call === 'eth_blockNumber').length, 2);
  assert.equal(value.sent.length, 1);
});

test('configured zero tip is preserved without fetching RPC gas fees', async (t) => {
  const value = harness(t);
  value.operation.settings.priorityFee = '0';
  value.claim();
  await value.engine.tick();
  assert.deepEqual(value.builds[0]?.urgency, {
    level: 'normal',
    overrides: { maxPriorityFeePerGas: '0' },
  });
  assert.equal(parseTransaction(value.signed[0]!).maxPriorityFeePerGas ?? 0n, 0n);
});

test('an explicit RPC gas rejection fails without retrying the broadcast', async (t) => {
  const value = harness(t);
  value.submissionFailure('gas');
  value.claim();
  await value.engine.tick();
  await value.engine.tick();
  assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
  assert.match(value.store.operation(value.operation.id)?.error ?? '', /intrinsic gas too low/);
  assert.equal(value.sent.length, 1);
});

test('an exact Permit2 permission is signed locally and forwarded without allowance RPCs', async (t) => {
  const signing = t.mock.method(wallet, 'signTypedData');
  const value = harness(t);
  const permitData = {
    domain: {
      name: 'Permit2',
      chainId: ROBINHOOD_CHAIN_ID,
      verifyingContract: PERMIT2_MAPPING[ROBINHOOD_CHAIN_ID],
    },
    types: {
      PermitDetails: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint160' },
        { name: 'expiration', type: 'uint48' },
        { name: 'nonce', type: 'uint48' },
      ],
      PermitSingle: [
        { name: 'details', type: 'PermitDetails' },
        { name: 'spender', type: 'address' },
        { name: 'sigDeadline', type: 'uint256' },
      ],
    },
    values: {
      details: {
        token: ROBINHOOD_WETH,
        amount: inputRaw.toString(),
        expiration: String(Math.floor(Date.now() / 1000) + 3600),
        nonce: '0',
      },
      spender: router,
      sigDeadline: String(Math.floor(Date.now() / 1000) + 120),
    },
  };
  Reflect.set(value.quote, 'permitData', permitData);
  value.claim();
  await value.engine.tick();
  assert.equal(signing.mock.callCount(), 1);
  assert.match(String(value.builds[0]?.signature), /^0x[0-9a-f]{130}$/i);
  assert.deepEqual(value.builds[0]?.permitData, permitData);
  assert.equal(value.sent.length, 1);
});

for (const fields of [{ gasLimit: '0' }, { maxFeePerGas: '1', maxPriorityFeePerGas: '2' }]) {
  test(`invalid Uniswap gas values reject before signing: ${JSON.stringify(fields)}`, async (t) => {
    const value = harness(t);
    Object.assign(value.swap, fields);
    value.claim();
    await value.engine.tick();
    assert.equal(value.store.operation(value.operation.id)?.status, 'failed');
    assert.match(value.store.operation(value.operation.id)?.error ?? '', /invalid gas fields/);
    assert.equal(value.signed.length, 0);
    assert.equal(value.sent.length, 0);
  });
}
