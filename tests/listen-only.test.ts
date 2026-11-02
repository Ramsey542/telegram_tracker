import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { RiskFilters } from '../src/providers/risk.js';
import { chainSettingsSchema, type CallSignal, type Operation } from '../src/domain.js';
import { Store } from '../src/infra/store.js';
import { TradeEngine } from '../src/trading/engine.js';

test('listen-only retains captured calls and pending operations while blocking every trade entry point', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-listen-only-'));
  const store = new Store(directory);
  const unexpected = async (): Promise<never> =>
    assert.fail('Trading adapter must not be invoked in listen-only mode');
  const adapter: ChainAdapter = {
    chain: 'solana',
    address: 'wallet',
    readiness: () => [],
    verifyNetwork: unexpected,
    balance: unexpected,
    tokenInfo: unexpected,
    quoteSell: unexpected,
    advance: unexpected,
  };
  const signal: CallSignal = {
    id: '-1001:1',
    channelId: '-1001',
    messageId: 1,
    date: Date.now(),
    chain: 'solana',
    address: 'So11111111111111111111111111111111111111112',
    caller: 'testcaller',
    callerId: null,
    consistency: { overall: 50, recent: 50, chain: 50 },
    advertisedMarketCapUsd: 100_000,
  };
  const operation: Operation = {
    id: 'existing-operation',
    chain: 'solana',
    address: signal.address,
    kind: 'sell',
    status: 'active',
    positionId: 'existing-position',
    signal: null,
    exitKey: 'sl',
    amountRaw: '100',
    token: {
      chain: 'solana',
      address: signal.address,
      symbol: 'TEST',
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
    createdAt: Date.now(),
    error: null,
  };
  try {
    store.updateSettings((settings) => {
      settings.chains.solana.enabled = true;
      settings.chains.robinhood.enabled = true;
    });
    store.recordPost(
      {
        channelId: signal.channelId,
        messageId: signal.messageId,
        date: signal.date,
        revision: 1,
        text: '',
        urls: [],
      },
      signal,
      null,
    );
    store.saveOperation(operation);
    const engine = new TradeEngine(
      { listenOnly: true, maxSignalAgeMs: 120_000 } as Config,
      store,
      { solana: adapter, robinhood: { ...adapter, chain: 'robinhood' } },
      { check: unexpected } as unknown as RiskFilters,
    );
    engine.observeSignal(signal);
    assert.equal(store.signalHistory()[0]?.observation?.reason, 'listen_only');
    await engine.tick();
    assert.equal(store.nextSignal('solana')?.id, signal.id);
    assert.equal(store.activeOperation('solana')?.status, 'active');
    assert.equal(store.hasEntry('solana', signal.address), false);
    await assert.rejects(engine.sell('existing-position', 100), /LISTEN_ONLY/);
    await assert.rejects(engine.unwrap(), /LISTEN_ONLY/);
    assert.throws(() => engine.reconcile(operation.id), /LISTEN_ONLY/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
