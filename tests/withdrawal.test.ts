import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  Connection,
  Keypair,
  Transaction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { Config } from '../src/config.js';
import type { Wallets } from '../src/wallets.js';
import { chainSettingsSchema, PendingTrade, type Operation } from '../src/domain.js';
import { SolanaAdapter } from '../src/chains/solana.js';
import { HttpClient } from '../src/infra/http.js';
import { MarketData } from '../src/providers/market.js';
import { withdrawalAddress, withdrawalAmount } from '../src/trading/withdrawal.js';

const sender = Keypair.fromSeed(new Uint8Array(32).fill(1));
const recipient = Keypair.fromSeed(new Uint8Array(32).fill(2)).publicKey.toBase58();

function withdrawal(): Operation {
  return {
    id: 'withdrawal',
    chain: 'solana',
    address: recipient,
    kind: 'withdraw',
    status: 'active',
    positionId: null,
    signal: null,
    exitKey: null,
    amountRaw: '1000000',
    withdrawal: { recipient, requestedBy: 123 },
    token: {
      chain: 'solana',
      address: recipient,
      symbol: 'SOL',
      decimals: 9,
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
}

function harness(t: TestContext, balance = 10_000_000) {
  const config = {
    solanaRpc: 'https://withdrawal.test.invalid',
    httpTimeoutMs: 1000,
    listenOnly: false,
  } as Config;
  const http = new HttpClient(1000);
  t.mock.method(globalThis, 'fetch', async () =>
    assert.fail('Withdrawal tests must remain offline'),
  );
  t.mock.method(
    Connection.prototype,
    'getGenesisHash',
    async () => '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  );
  const blockhash = t.mock.method(Connection.prototype, 'getLatestBlockhash', async () => ({
    blockhash: sender.publicKey.toBase58(),
    lastValidBlockHeight: 200,
  }));
  t.mock.method(Connection.prototype, 'getFeeForMessage', async () => ({
    context: { slot: 100 },
    value: 5000,
  }));
  t.mock.method(Connection.prototype, 'getBalance', async () => balance);
  t.mock.method(Connection.prototype, 'getTransaction', async () => null);
  t.mock.method(Connection.prototype, 'getSignatureStatuses', async () => ({
    context: { slot: 100 },
    value: [null],
  }));
  t.mock.method(Connection.prototype, 'getBlockHeight', async () => 100);
  const sends: Buffer[] = [];
  t.mock.method(
    Connection.prototype,
    'sendRawTransaction',
    async (raw: Parameters<Connection['sendRawTransaction']>[0]) => {
      const bytes = Buffer.from(raw);
      sends.push(bytes);
      const transaction = Transaction.from(bytes);
      const { default: bs58 } = await import('bs58');
      return bs58.encode(transaction.signature!);
    },
  );
  const makeAdapter = () =>
    new SolanaAdapter(config, { solana: sender } as Wallets, http, new MarketData(config, http));
  return { config, makeAdapter, sends, blockhash };
}

test('withdrawal input rejects invalid destinations and imprecise amounts', () => {
  assert.equal(withdrawalAddress('solana', recipient, sender.publicKey.toBase58()), recipient);
  assert.throws(() =>
    withdrawalAddress('solana', sender.publicKey.toBase58(), sender.publicKey.toBase58()),
  );
  assert.throws(() =>
    withdrawalAddress('solana', '11111111111111111111111111111111', sender.publicKey.toBase58()),
  );
  assert.throws(() =>
    withdrawalAddress(
      'robinhood',
      '0x0000000000000000000000000000000000000000',
      '0x1111111111111111111111111111111111111111',
    ),
  );
  assert.equal(withdrawalAmount('robinhood', '0.123456789123456789'), '123456789123456789');
  for (const amount of ['0', '-1', '1e-9', '0.0000000001'])
    assert.throws(() => withdrawalAmount('solana', amount));
});

test('SOL withdrawal persists one signed transaction and reuses it after restart', async (t) => {
  const value = harness(t);
  const operation = withdrawal();
  let persisted: Operation | null = null;
  await assert.rejects(
    value.makeAdapter().advance(
      operation,
      () => {
        persisted = structuredClone(operation);
      },
      async () => assert.fail('Withdrawals do not request swaps'),
      () => {},
    ),
    PendingTrade,
  );
  assert.equal(value.sends.length, 1);
  assert.ok(persisted);
  const restored = JSON.parse(JSON.stringify(persisted)) as Operation;
  restored.steps[0]!.submittedAt = Date.now() - 30_000;
  await assert.rejects(
    value.makeAdapter().advance(
      restored,
      () => {},
      async () => assert.fail('Withdrawals do not request swaps'),
      () => {},
    ),
    PendingTrade,
  );
  assert.equal(value.blockhash.mock.callCount(), 1);
  assert.equal(value.sends.length, 2);
  assert.deepEqual(value.sends[0], value.sends[1]);
  assert.equal(restored.swapHash, operation.swapHash);
});

test('SOL withdrawals reserve network fees and LISTEN_ONLY prevents signing', async (t) => {
  const value = harness(t, 1_000_000);
  const operation = withdrawal();
  await assert.rejects(
    value.makeAdapter().advance(
      operation,
      () => {},
      async () => {},
      () => {},
    ),
    /Insufficient SOL/,
  );
  assert.equal(operation.steps.length, 0);
  assert.equal(value.sends.length, 0);
  value.config.listenOnly = true;
  await assert.rejects(
    value.makeAdapter().advance(
      operation,
      () => {},
      async () => {},
      () => {},
    ),
    /LISTEN_ONLY/,
  );
  assert.equal(operation.steps.length, 0);
});

test('SOL withdrawal is completed only from its saved transaction receipt', async (t) => {
  const value = harness(t);
  const operation = withdrawal();
  const adapter = value.makeAdapter();
  await assert.rejects(
    adapter.advance(
      operation,
      () => {},
      async () => {},
      () => {},
    ),
    PendingTrade,
  );
  t.mock.method(
    Connection.prototype,
    'getTransaction',
    async () => ({ meta: { err: null, fee: 5000 } }) as VersionedTransactionResponse,
  );
  const result = await adapter.advance(
    operation,
    () => {},
    async () => {},
    () => {},
  );
  assert.equal(result.signature, operation.swapHash);
  assert.equal(result.nativeRaw, '1005000');
  assert.equal(result.feeNativeRaw, '5000');
  assert.equal(value.sends.length, 1);
});
