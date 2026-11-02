import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encodeAbiParameters } from 'viem';
import type { Config } from '../src/config.js';
import type { Wallets } from '../src/wallets.js';
import { chainSettingsSchema, type Operation } from '../src/domain.js';
import { Store } from '../src/infra/store.js';
import { HttpClient, HttpError } from '../src/infra/http.js';
import { MarketData } from '../src/providers/market.js';
import { ROBINHOOD_CHAIN_ID, ROBINHOOD_WETH, RobinhoodAdapter } from '../src/chains/robinhood.js';
import { applyField } from '../src/telegram/settings.js';

function trade(kind: 'buy' | 'sell'): Operation {
  return {
    id: 'offline-slippage-operation',
    chain: 'robinhood',
    address: '0x1111111111111111111111111111111111111111',
    kind,
    status: 'active',
    positionId: null,
    signal: null,
    exitKey: null,
    amountRaw: '1000000',
    token: {
      chain: 'robinhood',
      address: '0x1111111111111111111111111111111111111111',
      symbol: 'TEST',
      decimals: 6,
      marketCapUsd: null,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: Date.now(),
    },
    settings: chainSettingsSchema.parse({ slippagePercent: 3.25 }),
    steps: [],
    quote: null,
    swapHash: null,
    outputRaw: null,
    createdAt: Date.now(),
    error: null,
  };
}

test('legacy buy/sell slippage migrates to one value without raising either limit', () => {
  for (const [input, expected] of [
    [{}, null],
    [{ buySlippagePercent: 3, sellSlippagePercent: 1 }, 1],
    [{ buySlippagePercent: 0.5, sellSlippagePercent: 2 }, 0.5],
    [{ buySlippagePercent: null, sellSlippagePercent: 4 }, 4],
    [{ buySlippagePercent: 2, sellSlippagePercent: null }, 2],
    [{ buySlippagePercent: null, sellSlippagePercent: null }, null],
    [{ slippagePercent: 5, buySlippagePercent: 1, sellSlippagePercent: 2 }, 5],
    [{ slippagePercent: null, buySlippagePercent: 1, sellSlippagePercent: 2 }, null],
  ] as const) {
    const settings = chainSettingsSchema.parse(input);
    assert.equal(settings.slippagePercent, expected);
    assert.equal('buySlippagePercent' in settings, false);
    assert.equal('sellSlippagePercent' in settings, false);
  }
});

test('the shared slippage input retains validation and can be cleared after migration', () => {
  const legacy = chainSettingsSchema.parse({ buySlippagePercent: 1, sellSlippagePercent: 3 });
  for (const chain of ['solana', 'robinhood'] as const) {
    const updated = applyField(legacy, chain, 'slippage', '2.5');
    assert.equal(updated.slippagePercent, 2.5);
    assert.equal(applyField(updated, chain, 'slippage', 'off').slippagePercent, null);
    assert.throws(() => applyField(updated, chain, 'slippage', '0'));
    assert.throws(() => applyField(updated, chain, 'slippage', '50.01'));
  }
});

test('stored settings and pending operation snapshots migrate without changing saved transactions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-slippage-'));
  let store: Store | null = null;
  let db: DatabaseSync | null = null;
  const saved = {
    ...trade('buy'),
    settings: { buySlippagePercent: 8, sellSlippagePercent: 1.25, priorityFee: '0' },
    steps: [
      {
        type: 'evm',
        key: 'swap',
        hash: 'saved-offline-hash',
        serialized: 'opaque-saved-transaction',
        submittedAt: 12345,
        gasPaidRaw: null,
      },
    ],
  };
  try {
    store = new Store(directory);
    store.close();
    store = null;
    db = new DatabaseSync(join(directory, 'tracker.sqlite'));
    db.prepare('UPDATE configuration SET payload = ? WHERE id = 1').run(
      JSON.stringify({
        chains: {
          solana: { buySlippagePercent: 0.5, sellSlippagePercent: 3 },
          robinhood: { buySlippagePercent: 4, sellSlippagePercent: 2 },
        },
      }),
    );
    db.prepare(
      'INSERT INTO operations (id,chain,address,status,created_at,payload) VALUES (?,?,?,?,?,?)',
    ).run(
      saved.id,
      saved.chain,
      saved.address,
      saved.status,
      saved.createdAt,
      JSON.stringify(saved),
    );
    db.close();
    db = null;
    store = new Store(directory);
    assert.equal(store.settings().chains.solana.slippagePercent, 0.5);
    assert.equal(store.settings().chains.robinhood.slippagePercent, 2);
    for (const operation of [
      store.activeOperation('robinhood'),
      store.operation(saved.id),
      store.history()[0],
    ]) {
      assert.equal(operation?.settings.slippagePercent, 1.25);
      assert.equal(operation?.settings.priorityFee, '0');
      assert.deepEqual(operation?.steps, saved.steps);
    }
    store.updateSettings((settings) => {
      settings.chains.solana.slippagePercent = 2.75;
    });
    store.saveOperation(store.operation(saved.id)!);
    store.close();
    store = null;
    db = new DatabaseSync(join(directory, 'tracker.sqlite'));
    const configuration = String(db.prepare('SELECT payload FROM configuration').get()?.payload);
    const operation = String(db.prepare('SELECT payload FROM operations').get()?.payload);
    assert.doesNotMatch(configuration + operation, /buySlippagePercent|sellSlippagePercent/);
    assert.equal(JSON.parse(configuration).chains.solana.slippagePercent, 2.75);
    assert.deepEqual(JSON.parse(operation).steps, saved.steps);
  } finally {
    store?.close();
    db?.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'telegram-slippage-')));
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const kind of ['buy', 'sell'] as const) {
  test(`Robinhood ${kind} requests a quote with the shared slippage`, async (t) => {
    const rpc = 'https://robinhood.test.invalid/';
    const config = { robinhoodRpc: rpc, httpTimeoutMs: 1000 } as Config;
    const wallets = {
      robinhood: { address: '0x0000000000000000000000000000000000000001' },
    } as unknown as Wallets;
    const requests: Record<string, unknown>[] = [];
    // Abort at the quote response, before approvals, wrapping, signing, or submission.
    t.mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const body = JSON.parse(String(options?.body));
        if (url.href === rpc) {
          assert.equal(body.method, 'eth_chainId');
          return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x1237' });
        }
        assert.equal(url.href, 'https://trade-api.gateway.uniswap.org/v1/quote');
        requests.push(body);
        return Response.json(
          { error: 'Offline test stops after the quote request' },
          { status: 422 },
        );
      },
    );
    const http = new HttpClient(1000);
    const adapter = new RobinhoodAdapter(config, wallets, http, new MarketData(config, http));
    const operation = trade(kind);
    operation.wrapAmountRaw = '0';
    await assert.rejects(
      kind === 'buy'
        ? adapter.advance(
            operation,
            () => assert.fail('Unexpected persistence'),
            async () => {},
            () => assert.fail('Unexpected signing'),
          )
        : adapter.quoteSell(operation.address, operation.amountRaw, operation.settings),
      (error: unknown) => error instanceof HttpError && error.status === 422,
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.slippageTolerance, 3.25);
  });
}

for (const exitKey of ['sl', 'tp:first', 'trail:sl', 'trail:tp']) {
  test(`Robinhood ${exitKey} builds a swap below the trigger quote and ignores saved target floors`, async (t) => {
    const rpc = 'https://robinhood-exit.test.invalid/';
    const config = { robinhoodRpc: rpc, httpTimeoutMs: 1000 } as Config;
    const address = '0x0000000000000000000000000000000000000001';
    const wallets = { robinhood: { address } } as unknown as Wallets;
    const operation = Object.assign(trade('sell'), { minimumNativeRaw: '150000000' });
    operation.settings.mevProtection = false;
    operation.exitKey = exitKey;
    operation.quote = {
      inputRaw: operation.amountRaw,
      outputRaw: '150000000',
      minOutputRaw: '150000000',
      nativeUsd: null,
      priceImpactPercent: null,
      receivedAt: Date.now(),
      estimated: true,
    };
    const calls: string[] = [];
    t.mock.method(
      globalThis,
      'fetch',
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        const body = JSON.parse(String(init?.body));
        if (url.href === rpc) {
          calls.push(body.method);
          let result: string;
          if (body.method === 'eth_chainId') result = '0x1237';
          else {
            assert.equal(body.method, 'eth_call');
            result =
              body.params[0].to.toLowerCase() === operation.address
                ? encodeAbiParameters([{ type: 'uint256' }], [BigInt(operation.amountRaw)])
                : encodeAbiParameters(
                    [{ type: 'uint160' }, { type: 'uint48' }, { type: 'uint48' }],
                    [BigInt(operation.amountRaw), Math.floor(Date.now() / 1000) + 3600, 0],
                  );
          }
          return Response.json({ jsonrpc: '2.0', id: body.id, result });
        }
        assert.equal(url.hostname, 'trade-api.gateway.uniswap.org');
        calls.push(url.pathname);
        if (url.pathname === '/v1/quote') {
          assert.equal(body.slippageTolerance, 3.25);
          return Response.json({
            routing: 'CLASSIC',
            quote: {
              input: { token: operation.address, amount: operation.amountRaw },
              output: { token: ROBINHOOD_WETH, amount: '100000000' },
              swapper: address,
              chainId: ROBINHOOD_CHAIN_ID,
              slippage: 3.25,
            },
          });
        }
        assert.equal(url.pathname, '/v1/swap');
        assert.equal(body.quote.output.amount, '100000000');
        return Response.json(
          { error: 'Offline test stops after swap construction' },
          { status: 422 },
        );
      },
    );
    const http = new HttpClient(1000);
    const adapter = new RobinhoodAdapter(config, wallets, http, new MarketData(config, http));
    await assert.rejects(
      adapter.advance(
        operation,
        () => {},
        async () => {},
        () => assert.fail('No transaction should be signed in this fixture'),
      ),
      (error: unknown) => error instanceof HttpError && error.status === 422,
    );
    assert.equal(calls.filter((call) => call === '/v1/quote').length, 1);
    assert.equal(calls.filter((call) => call === '/v1/swap').length, 1);
    assert.equal(operation.quote.outputRaw, '100000000');
  });
}
