import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PublicKey, type VersionedTransactionResponse } from '@solana/web3.js';
import { pumpFill, PumpRoutes, PUMP_PROGRAM_ID } from '../src/chains/pump.js';
import { SolanaAdapter, SOL_MINT } from '../src/chains/solana.js';
import { chainSettingsSchema, type Operation, type Quote } from '../src/domain.js';
import type { Config } from '../src/config.js';
import type { Wallets } from '../src/wallets.js';
import type { HttpClient } from '../src/infra/http.js';
import type { MarketData } from '../src/providers/market.js';

const owner = 'A4XFe2QskSVYV8n3BheMTMvzpcNsGxt8vhtHayR9FARc';
const mint = 'Hg2Rfhs38b4wyhVYFSJMAxQ6AWqEeWAazrZtskCxpump';
const nonPump = 'DY3o5SLKeZkhkyqJJL4bbxxHos86yLqoVD4wVVaHpiLL';
const tradeEvent =
  'vdt/007mYe73ukED58wXRkcj3RbQcdrHjYUmDG+7HZ44UZOQQ9bn3wYSDwAAAAAAAMg0xAMAAAABhqAhmU9K1THg/YGVoSrsqicv7j2r/WtaSl6V8sRTyAcYlfBqAAAAAEbkbFIKAAAAKcPqFGOUAgBGOElWAwAAACkr2MjRlQEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABfAAAAAAAAAKckAAAAAAAAr1W/hm2JfaTO59N2wQkjqlAQQmbI+yJcUzDop1kcgGoeAAAAAAAAAJMLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEgAAAGJ1eV9leGFjdF9xdW90ZV9pbgAAAAAAAAAAAAAAAAAAAAAAiBMAAAAAAABTEgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYSDwAAAAAARuRsUgoAAABGOElWAwAAAAAAAAAAAAAAAAAAAAAAAABIuSwAAAAAAAAAAAAAAAAA';

function receipt(event = tradeEvent, program = PUMP_PROGRAM_ID.toBase58()) {
  return {
    meta: {
      logMessages: [
        `Program ${program} invoke [1]`,
        'Program 11111111111111111111111111111111 invoke [2]',
        'Program 11111111111111111111111111111111 success',
        `Program data: ${event}`,
        `Program ${program} success`,
      ],
    },
  } as unknown as VersionedTransactionResponse;
}

test('confirmed curve receipt decodes the real buy that previously entered review', () => {
  assert.deepEqual(pumpFill(receipt(), owner, mint, 'pump', true), {
    native: 1000000n,
    tokens: 16176695296n,
  });
});

test('curve event decoder accepts older events without optional trailing fields', () => {
  const older = Buffer.from(tradeEvent, 'base64').subarray(0, -8).toString('base64');
  assert.deepEqual(pumpFill(receipt(older), owner, mint, 'pump', true), {
    native: 1000000n,
    tokens: 16176695296n,
  });
});

test('decoded events still require the expected program, mint, trader and direction', () => {
  assert.throws(() => pumpFill(receipt(), SOL_MINT, mint, 'pump', true), /unavailable/);
  assert.throws(() => pumpFill(receipt(), owner, SOL_MINT, 'pump', true), /unavailable/);
  assert.throws(() => pumpFill(receipt(), owner, mint, 'pump', false), /unavailable/);
  assert.throws(
    () => pumpFill(receipt(tradeEvent, SOL_MINT), owner, mint, 'pump', true),
    /unavailable/,
  );
});

function adapter(http: Pick<HttpClient, 'json'>) {
  return new SolanaAdapter(
    {
      solanaRpc: 'https://solana.test.invalid',
      jupiterKey: 'test-key',
      httpTimeoutMs: 1000,
    } as Config,
    { solana: { publicKey: new PublicKey(owner) } } as Wallets,
    http as HttpClient,
    {} as MarketData,
  );
}

test('pump suffix routes directly to the SDK with its old switch off and no network discovery', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No RPC discovery is allowed'));
  const quote: Quote = {
    inputRaw: '100',
    outputRaw: '200',
    minOutputRaw: '180',
    nativeUsd: null,
    priceImpactPercent: null,
    receivedAt: Date.now(),
  };
  const sdk = t.mock.method(PumpRoutes.prototype, 'quote', async () => ({
    venue: 'pump' as const,
    quote,
    instructions: [],
    token: {} as never,
  }));
  const instance = adapter({ json: async () => assert.fail('Pump routes must not call Jupiter') });
  const settings = chainSettingsSchema.parse({ directTradingEnabled: false, slippagePercent: 10 });
  assert.equal(await instance.quoteSell(mint, '100', settings), quote);
  assert.equal(sdk.mock.callCount(), 1);
  sdk.mock.restore();
  t.mock.method(PumpRoutes.prototype, 'quote', async () => null);
  await assert.rejects(
    instance.advance(
      { address: mint, kind: 'buy', amountRaw: '100', settings, steps: [] } as unknown as Operation,
      () => {},
      async () => {},
      () => assert.fail('Signing must not be reached'),
    ),
    /No supported Pump SDK route/,
  );
});

test('non-pump mint uses Jupiter even when direct trading is on and never probes the SDK', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('No network is allowed'));
  t.mock.method(PumpRoutes.prototype, 'quote', async () =>
    assert.fail('No Pump discovery is allowed'),
  );
  const instance = adapter({
    json: async (_service, url) => {
      const request = new URL(url);
      assert.equal(request.searchParams.get('inputMint'), nonPump);
      assert.equal(request.searchParams.get('outputMint'), SOL_MINT);
      return {
        inputMint: nonPump,
        outputMint: SOL_MINT,
        inAmount: '100',
        outAmount: '200',
        otherAmountThreshold: '180',
      } as never;
    },
  });
  const settings = chainSettingsSchema.parse({ directTradingEnabled: true, slippagePercent: 10 });
  assert.equal((await instance.quoteSell(nonPump, '100', settings)).outputRaw, '200');
});
