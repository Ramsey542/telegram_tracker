import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  TransactionInstruction,
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
  type JupiterStep,
  type Operation,
  type SolanaStep,
} from '../src/domain.js';
import { HttpClient } from '../src/infra/http.js';
import { MarketData } from '../src/providers/market.js';
import { SOL_MINT, SolanaAdapter } from '../src/chains/solana.js';

const rpcUrl = 'https://protected.solana.test.invalid/';
const owner = new PublicKey('11111111111111111111111111111111');
const marketMaker = new PublicKey(new Uint8Array(32).fill(2));
const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const signature = bs58.encode(new Uint8Array(64).fill(7));
const makerSignature = bs58.encode(new Uint8Array(64).fill(3));
const config = {
  solanaRpc: rpcUrl,
  jupiterKey: 'offline-test-key',
  httpTimeoutMs: 1000,
} as Config;
const wallets = { solana: { publicKey: owner } } as Wallets;

function operation(kind: 'buy' | 'sell' = 'buy'): Operation {
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
      decimals: null,
      marketCapUsd: null,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: Date.now(),
    },
    settings: chainSettingsSchema.parse({ slippagePercent: 0.5 }),
    steps: [],
    quote: null,
    swapHash: null,
    outputRaw: null,
    createdAt: Date.now(),
    error: null,
  };
}
function fixtureTransaction(sponsored = false): VersionedTransaction {
  return new VersionedTransaction(
    new TransactionMessage({
      payerKey: sponsored ? marketMaker : owner,
      recentBlockhash: owner.toBase58(),
      instructions: [
        new TransactionInstruction({
          programId: new PublicKey('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'),
          keys: [{ pubkey: owner, isSigner: true, isWritable: true }],
          data: Buffer.alloc(0),
        }),
      ],
    }).compileToV0Message(),
  );
}
function receipt(kind: 'buy' | 'sell' = 'buy'): VersionedTransactionResponse {
  const balance = (amount: string) => ({
    accountIndex: 1,
    mint,
    owner: owner.toBase58(),
    uiTokenAmount: { amount, decimals: 6, uiAmount: Number(amount) / 1e6 },
  });
  return {
    slot: 1,
    version: 0,
    transaction: { signatures: [signature], message: fixtureTransaction().message },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1_000_000_000, 0],
      postBalances: [kind === 'buy' ? 899_995_000 : 1_099_995_000, 0],
      preTokenBalances: [balance(kind === 'buy' ? '0' : '1000000')],
      postTokenBalances: [balance(kind === 'buy' ? '1000000' : '0')],
    },
  };
}
function harness(t: TestContext) {
  const events: string[] = [];
  const orders: URL[] = [];
  const executions: { requestId: string; signedTransaction: string }[] = [];
  const snapshots: Operation[] = [];
  let tradeReceipt: VersionedTransactionResponse | null = null;
  let sponsored = false;
  let retainMakerSignature = false;
  let rejectExecution = false;
  let height = 100;
  let orderOverride: Record<string, unknown> = {};
  let executionOverride: Record<string, unknown> = {};
  const signing = t.mock.method(
    VersionedTransaction.prototype,
    'sign',
    function (this: VersionedTransaction) {
      const index = this.message.staticAccountKeys
        .slice(0, this.message.header.numRequiredSignatures)
        .findIndex((key) => key.equals(owner));
      this.signatures[index] = new Uint8Array(64).fill(7);
    },
  );
  t.mock.method(Connection.prototype, 'getTransaction', async () => {
    events.push('getTransaction');
    return tradeReceipt;
  });
  t.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      );
      if (url.hostname === 'api.jup.ag' && url.pathname === '/swap/v2/order') {
        events.push('order');
        orders.push(url);
        const tx = fixtureTransaction(sponsored);
        if (sponsored && retainMakerSignature) tx.signatures[0] = new Uint8Array(64).fill(3);
        const output = url.searchParams.get('inputMint') === SOL_MINT ? '1000000' : '100000000';
        return Response.json({
          inputMint: url.searchParams.get('inputMint'),
          outputMint: url.searchParams.get('outputMint'),
          inAmount: url.searchParams.get('amount'),
          outAmount: output,
          otherAmountThreshold: String((BigInt(output) * 995n) / 1000n),
          slippageBps: 50,
          transaction: Buffer.from(tx.serialize()).toString('base64'),
          transactionVersion: 0,
          requestId: 'offline-order',
          router: sponsored ? 'jupiterz' : 'metis',
          taker: owner.toBase58(),
          lastValidBlockHeight: '1000',
          inUsdValue: 20,
          outUsdValue: 20,
          priceImpact: -0.1,
          ...orderOverride,
        });
      }
      if (url.hostname === 'api.jup.ag' && url.pathname === '/swap/v2/execute') {
        events.push('execute');
        assert.equal(snapshots.at(-1)?.steps[0]?.type, 'jupiter');
        assert.equal((snapshots.at(-1)?.steps[0] as JupiterStep).status, 'submitted');
        executions.push(JSON.parse(String(options?.body)));
        if (rejectExecution) throw new Error('Offline Jupiter timeout');
        return Response.json({
          status: 'Success',
          code: 0,
          signature: sponsored ? makerSignature : signature,
          totalInputAmount: orders.at(-1)!.searchParams.get('amount'),
          totalOutputAmount:
            orders.at(-1)!.searchParams.get('inputMint') === SOL_MINT ? '1000000' : '100000000',
          ...executionOverride,
        });
      }
      assert.equal(url.href, rpcUrl, 'Only the configured QuickNode RPC may be read');
      const request = JSON.parse(String(options?.body)) as { id: number; method: string };
      events.push(request.method);
      let result: unknown;
      switch (request.method) {
        case 'getGenesisHash':
          result = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
          break;
        case 'getSignatureStatuses':
          result = { context: { slot: 1 }, value: [null] };
          break;
        case 'getBlockHeight':
          result = height;
          break;
        default:
          assert.fail(`Unexpected RPC method: ${request.method}`);
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  );
  const http = new HttpClient(1000, 150);
  const adapter = new SolanaAdapter(config, wallets, http, new MarketData(config, http));
  return {
    adapter,
    events,
    orders,
    executions,
    snapshots,
    signing,
    persist(trade: Operation) {
      snapshots.push(structuredClone(trade));
    },
    setReceipt(value: VersionedTransactionResponse | null) {
      tradeReceipt = value;
    },
    setSponsored(value: boolean, keepSignature = false) {
      sponsored = value;
      retainMakerSignature = keepSignature;
    },
    setRejectExecution(value: boolean) {
      rejectExecution = value;
    },
    setHeight(value: number) {
      height = value;
    },
    setOrder(value: Record<string, unknown>) {
      orderOverride = value;
    },
    setExecution(value: Record<string, unknown>) {
      executionOverride = value;
    },
  };
}
async function advance(
  value: ReturnType<typeof harness>,
  trade: Operation,
  beforeSwap = async () => {},
  beforeSpend = () => {},
) {
  return value.adapter.advance(trade, () => value.persist(trade), beforeSwap, beforeSpend);
}

for (const kind of ['buy', 'sell'] as const) {
  test(`${kind} orders, signs and executes before any RPC reads`, async (t) => {
    const value = harness(t);
    const trade = operation(kind);
    trade.settings.slippagePercent = 1.25;
    value.setOrder({ slippageBps: 125 });
    value.setReceipt(receipt(kind));
    const result = await advance(value, trade);
    assert.equal(result.signature, signature);
    assert.equal(result.tokenRaw, '1000000');
    assert.equal(result.nativeRaw, kind === 'buy' ? '100005000' : '99995000');
    assert.equal(result.swapNativeRaw, '100000000');
    assert.equal(trade.token.decimals, 6);
    assert.deepEqual(value.events, ['order', 'execute', 'getGenesisHash', 'getTransaction']);
    assert.equal(value.orders[0]!.searchParams.get('taker'), owner.toBase58());
    assert.equal(value.orders[0]!.searchParams.get('slippageBps'), '125');
    assert.equal(value.orders[0]!.searchParams.get('excludeRouters'), null);
    assert.equal(value.signing.mock.callCount(), 1);
    assert.equal((trade.steps[0] as JupiterStep).status, 'confirmed');
  });
}
test('confirmed fill amounts exclude wallet overhead and replace the estimated token quantity', async (t) => {
  const value = harness(t);
  const trade = operation();
  trade.amountRaw = '1000000';
  value.setOrder({ outAmount: '3739457655', otherAmountThreshold: '3720760366' });
  value.setExecution({ totalInputAmount: '1000000', totalOutputAmount: '3739460179' });
  const actual = receipt();
  actual.meta!.fee = 7204;
  actual.meta!.postBalances[0] = 997478956;
  actual.meta!.postTokenBalances![0]!.uiTokenAmount.amount = '3739460179';
  value.setReceipt(actual);
  const result = await advance(value, trade);
  assert.equal(result.swapNativeRaw, '1000000');
  assert.equal(result.nativeRaw, '2521044');
  assert.equal(result.feeNativeRaw, '7204');
  assert.equal(result.tokenRaw, '3739460179');
  assert.deepEqual((value.snapshots.at(-1)!.steps[0] as JupiterStep).executionAmounts, {
    inputRaw: '1000000',
    outputRaw: '3739460179',
  });
  assert.deepEqual(value.events, ['order', 'execute', 'getGenesisHash', 'getTransaction']);
});

test('confirmed execution amounts survive receipt delays and process recovery', async (t) => {
  const value = harness(t);
  const trade = operation();
  value.setExecution({ totalInputAmount: '99000000', totalOutputAmount: '1100000' });
  await assert.rejects(advance(value, trade), PendingTrade);
  const restored = structuredClone(value.snapshots.at(-1)!);
  const actual = receipt();
  actual.meta!.postTokenBalances![0]!.uiTokenAmount.amount = '1100000';
  value.setReceipt(actual);
  const result = await advance(value, restored);
  assert.equal(result.swapNativeRaw, '99000000');
  assert.equal(result.tokenRaw, '1100000');
  assert.equal(value.executions.length, 1);
  assert.equal(value.orders.length, 1);
});

test('a lost execution response recovers the confirmed exact input without using the wallet debit', async (t) => {
  const value = harness(t);
  value.setRejectExecution(true);
  const trade = operation();
  await assert.rejects(advance(value, trade), /Offline Jupiter timeout/);
  value.setReceipt(receipt());
  const result = await advance(value, structuredClone(trade));
  assert.equal(result.swapNativeRaw, trade.amountRaw);
  assert.equal(result.nativeRaw, '100005000');
  assert.equal(value.executions.length, 1);
});

for (const amounts of [
  { totalInputAmount: '0', totalOutputAmount: '1000000' },
  { totalInputAmount: '100000000', totalOutputAmount: '999999' },
  { totalInputAmount: '100000000', totalOutputAmount: null },
]) {
  test(`inconsistent confirmed fill amounts require review: ${JSON.stringify(amounts)}`, async (t) => {
    const value = harness(t);
    value.setExecution(amounts);
    value.setReceipt(receipt());
    const trade = operation();
    await assert.rejects(advance(value, trade), ReviewRequired);
    assert.equal((trade.steps[0] as JupiterStep).status, 'confirmed');
    assert.equal(value.executions.length, 1);
  });
}

for (const priority of [null, '0', '0.00001'] as const) {
  test(`priority override ${priority ?? 'auto'} is passed in the Jupiter order`, async (t) => {
    const value = harness(t);
    const trade = operation();
    trade.settings.priorityFee = priority;
    await assert.rejects(advance(value, trade), PendingTrade);
    assert.equal(
      value.orders[0]!.searchParams.get('priorityFeeLamports'),
      priority === null ? null : priority === '0' ? '0' : '10000',
    );
    assert.equal(
      value.orders[0]!.searchParams.get('broadcastFeeType'),
      priority === null ? null : 'exactFee',
    );
  });
}
test('JupiterZ keeps the other signature slot and only signs the wallet slot', async (t) => {
  const value = harness(t);
  value.setSponsored(true, true);
  const trade = operation();
  await assert.rejects(advance(value, trade), PendingTrade);
  const tx = VersionedTransaction.deserialize(
    Buffer.from(value.executions[0]!.signedTransaction, 'base64'),
  );
  assert.deepEqual([...tx.signatures[0]!], Array(64).fill(3));
  assert.deepEqual([...tx.signatures[1]!], Array(64).fill(7));
});
test('a missing market-maker signature is preserved until Jupiter execute fills it', async (t) => {
  const value = harness(t);
  value.setSponsored(true);
  const trade = operation();
  await assert.rejects(advance(value, trade), PendingTrade);
  assert.equal((value.snapshots[0]!.steps[0] as JupiterStep).signature, null);
  assert.equal((trade.steps[0] as JupiterStep).signature, makerSignature);
  const tx = VersionedTransaction.deserialize(
    Buffer.from(value.executions[0]!.signedTransaction, 'base64'),
  );
  assert.ok(tx.signatures[0]!.every((byte) => byte === 0));
});
test('filter failures prevent signing and submission while the order is requested immediately', async (t) => {
  const value = harness(t);
  const trade = operation();
  let checked = false;
  await assert.rejects(
    advance(value, trade, async () => {
      checked = true;
      throw new TradeRejected('Current market cap is too high');
    }),
    /Current market cap is too high/,
  );
  assert.equal(checked, true);
  assert.equal(value.orders.length, 1);
  assert.equal(value.executions.length, 0);
  assert.equal(value.signing.mock.callCount(), 0);
  assert.equal(trade.steps.length, 0);
});
test('an interrupted execution resumes with the same durable order and signed bytes', async (t) => {
  const value = harness(t);
  value.setRejectExecution(true);
  const trade = operation();
  await assert.rejects(advance(value, trade), /Offline Jupiter timeout/);
  const step = trade.steps[0] as JupiterStep;
  assert.equal(step.status, 'submitted');
  assert.notEqual(step.submittedAt, null);
  step.lastAttemptAt = Date.now() - 16_000;
  const restored = structuredClone(trade);
  value.setRejectExecution(false);
  await assert.rejects(advance(value, restored), PendingTrade);
  assert.equal(value.orders.length, 1);
  assert.equal(value.signing.mock.callCount(), 1);
  assert.equal(value.executions.length, 2);
  assert.deepEqual(value.executions[0], value.executions[1]);
});
test('a confirmed receipt after a lost execute response prevents resubmission', async (t) => {
  const value = harness(t);
  value.setRejectExecution(true);
  const trade = operation();
  await assert.rejects(advance(value, trade));
  value.setReceipt(receipt());
  const result = await advance(value, structuredClone(trade));
  assert.equal(result.tokenRaw, '1000000');
  assert.equal(value.executions.length, 1);
  assert.equal(value.orders.length, 1);
});
test('Jupiter success waits for the real receipt without creating another order', async (t) => {
  const value = harness(t);
  const trade = operation();
  await assert.rejects(advance(value, trade), PendingTrade);
  await assert.rejects(advance(value, trade), PendingTrade);
  assert.equal(value.executions.length, 1);
  assert.equal(value.events.filter((event) => event === 'getGenesisHash').length, 1);
  value.setReceipt(receipt());
  const result = await advance(value, trade);
  assert.equal(result.nativeRaw, '100005000');
  assert.equal(value.orders.length, 1);
});
test('Jupiter-confirmed execution cannot be treated as an expired unexecuted buy', async (t) => {
  const value = harness(t);
  const trade = operation();
  await assert.rejects(advance(value, trade), PendingTrade);
  const step = trade.steps[0] as JupiterStep;
  step.submittedAt = Date.now() - 130_000;
  step.lastAttemptAt = Date.now() - 130_000;
  value.setHeight(1100);
  await assert.rejects(advance(value, trade), ReviewRequired);
  assert.equal(step.status, 'confirmed');
  assert.equal(value.events.includes('getBlockHeight'), false);
  assert.equal(value.orders.length, 1);
});
test('buy price impact limits prevent signing an unsuitable order', async (t) => {
  const value = harness(t);
  const buy = operation();
  buy.settings.filters.maxPriceImpactPercent = 0.05;
  await assert.rejects(advance(value, buy), /Price impact/);
  assert.equal(value.signing.mock.callCount(), 0);
  assert.equal(value.executions.length, 0);
});

for (const exitKey of ['sl', 'tp:first', 'trail:sl', 'trail:tp']) {
  test(`${exitKey} executes a Solana sale below the original trigger quote and ignores saved target floors`, async (t) => {
    const value = harness(t);
    const sell = Object.assign(operation('sell'), { minimumNativeRaw: '150000000' });
    sell.exitKey = exitKey;
    sell.quote = {
      inputRaw: sell.amountRaw,
      outputRaw: '150000000',
      minOutputRaw: '150000000',
      nativeUsd: null,
      priceImpactPercent: null,
      receivedAt: Date.now(),
      estimated: true,
    };
    value.setReceipt(receipt('sell'));
    const result = await advance(value, sell);
    assert.equal(result.nativeRaw, '99995000');
    assert.equal(value.orders.length, 1);
    assert.equal(value.orders[0]!.searchParams.get('slippageBps'), '50');
    assert.equal(value.signing.mock.callCount(), 1);
    assert.equal(value.executions.length, 1);
  });
}
for (const mismatch of [
  { inputMint: mint },
  { inAmount: '999' },
  { slippageBps: 100 },
  { otherAmountThreshold: '1' },
  { transaction: '' },
  { errorCode: 2, errorMessage: 'Insufficient SOL for gas' },
]) {
  test(`invalid order is rejected before signing: ${JSON.stringify(mismatch)}`, async (t) => {
    const value = harness(t);
    value.setOrder(mismatch);
    await assert.rejects(advance(value, operation()), TradeRejected);
    assert.equal(value.signing.mock.callCount(), 0);
    assert.equal(value.executions.length, 0);
  });
}
test('failed Jupiter execution with no usable signature stays reserved for review', async (t) => {
  const value = harness(t);
  value.setSponsored(true);
  value.setExecution({ status: 'Failed', code: -1, signature: null, error: 'Order expired' });
  const trade = operation();
  await assert.rejects(advance(value, trade), ReviewRequired);
  assert.equal((trade.steps[0] as JupiterStep).executionCode, -1);
  assert.equal(value.orders.length, 1);
});
test('a failed execution with a known signature is rejected only after chain expiry is established', async (t) => {
  const value = harness(t);
  value.setExecution({ status: 'Failed', code: -1000, error: 'Failed to land' });
  value.setHeight(1100);
  await assert.rejects(advance(value, operation()), /expired without an on-chain execution/);
});
test('a disabling guard is checked again immediately before execution', async (t) => {
  const value = harness(t);
  const trade = operation();
  let checks = 0;
  await assert.rejects(
    advance(
      value,
      trade,
      async () => {},
      () => {
        if (++checks === 2) throw new TradeRejected('Chain entries were disabled before signing');
      },
    ),
    /Chain entries were disabled/,
  );
  assert.equal(value.executions.length, 0);
  assert.equal((trade.steps[0] as JupiterStep).submittedAt, null);
});
test('listen-only blocks orders, signing and all RPC access', async (t) => {
  const value = harness(t);
  const http = new HttpClient(1000, 150);
  const adapter = new SolanaAdapter(
    { ...config, listenOnly: true },
    wallets,
    http,
    new MarketData(config, http),
  );
  await assert.rejects(
    adapter.advance(
      operation(),
      () => {},
      async () => {},
      () => {},
    ),
    /LISTEN_ONLY/,
  );
  assert.deepEqual(value.events, []);
});
test('legacy saved Jito trades can reconcile and cannot become Jupiter orders', async (t) => {
  const value = harness(t);
  const trade = operation();
  const step: SolanaStep = {
    type: 'solana',
    key: 'swap',
    signature,
    serialized: 'offline-legacy',
    lastValidBlockHeight: 1000,
    submittedAt: null,
    bundleId: null,
    jito: true,
  };
  trade.steps.push(step);
  await assert.rejects(advance(value, trade), ReviewRequired);
  assert.equal(value.orders.length, 0);
  value.setReceipt(receipt());
  assert.equal((await advance(value, trade)).tokenRaw, '1000000');
  assert.equal(value.executions.length, 0);
});
