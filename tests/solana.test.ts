import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { Config } from '../src/config.js';
import type { Wallets } from '../src/wallets.js';
import {
  chainSettingsSchema,
  PendingTrade,
  ReviewRequired,
  TradeRejected,
  type Operation,
  type SolanaStep,
} from '../src/domain.js';
import { HttpClient } from '../src/infra/http.js';
import { MarketData } from '../src/providers/market.js';
import { SOL_MINT, SolanaAdapter } from '../src/chains/solana.js';

// Offline fixtures only: no private keys, .env loading, real signatures, or network requests.
const rpcUrl = 'https://protected.solana.test.invalid/';
const owner = new PublicKey('11111111111111111111111111111111');
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const signature = bs58.encode(Buffer.alloc(64));
const jupiterProgram = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const config = {
  solanaRpc: rpcUrl,
  jupiterKey: 'offline-test-key',
  httpTimeoutMs: 1000,
} as Config;
const wallets = { solana: { publicKey: owner } } as Wallets;

function operation(kind: 'buy' | 'sell', mevProtection = true): Operation {
  return {
    id: 'offline-operation',
    chain: 'solana',
    address: mint,
    kind,
    status: 'active',
    positionId: null,
    signal: null,
    exitKey: null,
    amountRaw: kind === 'buy' ? '100000000' : '1000000',
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
    settings: chainSettingsSchema.parse({
      buySlippagePercent: 0.5,
      sellSlippagePercent: 0.5,
      maxNetworkFeeNative: '0.000005',
      mevProtection,
      // A saved Jito tip must not be added or reserved on the QuickNode route.
      jitoTipNative: '1',
    }),
    steps: [],
    quote: null,
    swapHash: null,
    outputRaw: null,
    minimumNativeRaw: null,
    createdAt: Date.now(),
    error: null,
  };
}

function savedStep(jito: boolean): SolanaStep {
  return {
    type: 'solana',
    key: 'swap',
    signature,
    serialized: Buffer.from('offline unsigned fixture').toString('base64'),
    lastValidBlockHeight: 1000,
    submittedAt: null,
    bundleId: null,
    jito,
  };
}

function harness(t: TestContext) {
  const calls: { url: string; method: string; params: unknown[] }[] = [];
  const builds: URL[] = [];
  let rejectSubmission = false;
  // Keep the production assembly path, but replace signing with a no-op.
  const signing = t.mock.method(VersionedTransaction.prototype, 'sign', () => {});
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.hostname === 'api.jup.ag' && url.pathname === '/swap/v2/build') {
        builds.push(url);
        const query = url.searchParams;
        return Response.json({
          inputMint: query.get('inputMint'),
          outputMint: query.get('outputMint'),
          inAmount: query.get('amount'),
          outAmount: '1000000',
          otherAmountThreshold: '995000',
          slippageBps: 50,
          transactionVersion: 0,
          computeBudgetInstructions: [],
          setupInstructions: [],
          otherInstructions: [],
          swapInstruction: { programId: jupiterProgram, accounts: [], data: '' },
          cleanupInstruction: null,
          tipInstruction: null,
          addressesByLookupTableAddress: null,
          blockhashWithMetadata: { blockhash: Array(32).fill(0), lastValidBlockHeight: 1000 },
          priceImpactPct: '0',
        });
      }
      assert.equal(url.href, rpcUrl, 'All RPC requests must use the configured endpoint');
      const request = JSON.parse(String(options?.body)) as {
        id: string | number;
        method: string;
        params: unknown[];
      };
      calls.push({ url: url.href, method: request.method, params: request.params });
      if (request.method === 'sendTransaction' && rejectSubmission)
        return Response.json({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: 'Protected RPC unavailable' },
        });
      const context = { slot: 1 };
      let result: unknown;
      switch (request.method) {
        case 'getGenesisHash':
          result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
          break;
        case 'getLatestBlockhash':
          result = { context, value: { blockhash: owner.toBase58(), lastValidBlockHeight: 1000 } };
          break;
        case 'getFeeForMessage':
          result = { context, value: 5000 };
          break;
        case 'simulateTransaction':
          result = { context, value: { err: null, logs: [], unitsConsumed: 100000 } };
          break;
        case 'getBalance':
          result = { context, value: 1_000_000_000_000 };
          break;
        case 'getTransaction':
          result = null;
          break;
        case 'getSignatureStatuses':
          result = { context, value: [null] };
          break;
        case 'getBlockHeight':
          result = 100;
          break;
        case 'sendTransaction':
          result = signature;
          break;
        default:
          assert.fail(`Unexpected RPC method: ${request.method}`);
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  );
  const http = new HttpClient(1000);
  const adapter = new SolanaAdapter(config, wallets, http, new MarketData(config, http));
  return {
    adapter,
    calls,
    builds,
    signing,
    setRejectSubmission(value: boolean) {
      rejectSubmission = value;
    },
  };
}

test('default Solana readiness does not require a Jito tip or separate endpoint', (t) => {
  const { adapter } = harness(t);
  assert.deepEqual(adapter.readiness(chainSettingsSchema.parse({})), []);
});

for (const kind of ['buy', 'sell'] as const) {
  for (const mevProtection of [true, false]) {
    test(`${kind} uses the QuickNode RPC with saved MEV setting ${mevProtection}`, async (t) => {
      const { adapter, calls, builds, signing } = harness(t);
      const trade = operation(kind, mevProtection);
      let persisted = 0;
      await assert.rejects(
        adapter.advance(
          trade,
          () => persisted++,
          async () => {},
          () => {},
        ),
        PendingTrade,
      );
      assert.equal(builds.length, 1);
      assert.equal(builds[0]!.searchParams.get('forJitoBundle'), 'false');
      assert.equal(builds[0]!.searchParams.get('inputMint'), kind === 'buy' ? SOL_MINT : mint);
      assert.equal(builds[0]!.searchParams.get('outputMint'), kind === 'buy' ? mint : SOL_MINT);
      assert.equal(signing.mock.callCount(), 1, 'Signing was intercepted by the offline stub');
      const step = trade.steps[0] as SolanaStep;
      assert.equal(step.jito, false);
      assert.equal(step.bundleId, null);
      assert.equal(typeof step.submittedAt, 'number');
      assert.equal(persisted, 2);
      const sends = calls.filter((call) => call.method === 'sendTransaction');
      assert.equal(sends.length, 1);
      assert.equal(sends[0]!.params[0], step.serialized);
      const submission = sends[0]!.params[1] as Record<string, unknown>;
      assert.equal(submission.encoding, 'base64');
      assert.equal(submission.maxRetries, 0);
      assert.equal(submission.preflightCommitment, 'confirmed');
      assert.notEqual(submission.skipPreflight, true);
      const transaction = VersionedTransaction.deserialize(Buffer.from(step.serialized, 'base64'));
      assert.ok(transaction.signatures.every((value) => value.every((byte) => byte === 0)));
      const programs = transaction.message.compiledInstructions.map((instruction) =>
        transaction.message.staticAccountKeys[instruction.programIdIndex]!.toBase58(),
      );
      assert.deepEqual(programs, [ComputeBudgetProgram.programId.toBase58(), jupiterProgram]);
      assert.ok(!calls.some((call) => ['sendBundle', 'getTipAccounts'].includes(call.method)));
    });
  }
}

test('RPC failure keeps the same saved transaction and endpoint for retry', async (t) => {
  const { adapter, calls, builds, signing, setRejectSubmission } = harness(t);
  const trade = operation('sell');
  setRejectSubmission(true);
  await assert.rejects(
    adapter.advance(
      trade,
      () => {},
      async () => {},
      () => {},
    ),
    /Protected RPC unavailable/,
  );
  const step = trade.steps[0] as SolanaStep;
  assert.equal(step.submittedAt, null);
  const serialized = step.serialized;
  setRejectSubmission(false);
  await assert.rejects(
    adapter.advance(
      trade,
      () => {},
      async () => {},
      () => {},
    ),
    PendingTrade,
  );
  const sends = calls.filter((call) => call.method === 'sendTransaction');
  assert.equal(sends.length, 2);
  assert.ok(sends.every((call) => call.url === rpcUrl && call.params[0] === serialized));
  assert.equal(builds.length, 1);
  assert.equal(signing.mock.callCount(), 1);
});

test('Solana network fee cap still rejects an over-budget transaction before signing', async (t) => {
  const { adapter, calls, signing } = harness(t);
  const trade = operation('buy');
  trade.settings.maxNetworkFeeNative = '0.000004999';
  await assert.rejects(
    adapter.advance(
      trade,
      () => {},
      async () => {},
      () => {},
    ),
    (error: unknown) => error instanceof TradeRejected && /fee exceeds/.test(error.message),
  );
  assert.equal(signing.mock.callCount(), 0);
  assert.equal(trade.steps.length, 0);
  assert.ok(!calls.some((call) => call.method === 'sendTransaction'));
});

test('a saved Jito transaction is not silently rerouted through normal RPC', async (t) => {
  const { adapter, calls, builds, signing } = harness(t);
  const trade = operation('buy');
  trade.steps.push(savedStep(true));
  await assert.rejects(
    adapter.advance(
      trade,
      () => {},
      async () => {},
      () => {},
    ),
    ReviewRequired,
  );
  assert.equal(builds.length, 0);
  assert.equal(signing.mock.callCount(), 0);
  assert.ok(!calls.some((call) => ['sendTransaction', 'sendBundle'].includes(call.method)));
});

test('a confirmed legacy Jito transaction can still be reconciled', async (t) => {
  const { adapter, calls, signing } = harness(t);
  const receipt: VersionedTransactionResponse = {
    slot: 1,
    version: 0,
    transaction: {
      signatures: [signature],
      message: new TransactionMessage({
        payerKey: owner,
        recentBlockhash: owner.toBase58(),
        instructions: [],
      }).compileToV0Message(),
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [100_000_000],
      postBalances: [90_000_000],
      preTokenBalances: [],
      postTokenBalances: [
        {
          accountIndex: 0,
          mint,
          owner: owner.toBase58(),
          uiTokenAmount: { amount: '1000000', decimals: 6, uiAmount: 1 },
        },
      ],
    },
  };
  t.mock.method(Connection.prototype, 'getTransaction', async () => receipt);
  const trade = operation('buy');
  trade.steps.push(savedStep(true));
  const result = await adapter.advance(
    trade,
    () => {},
    async () => {},
    () => {},
  );
  assert.equal(result.tokenRaw, '1000000');
  assert.equal(result.nativeRaw, '10000000');
  assert.equal(result.signature, signature);
  assert.equal(signing.mock.callCount(), 0);
  assert.ok(!calls.some((call) => ['sendTransaction', 'sendBundle'].includes(call.method)));
});
