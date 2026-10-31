import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { RiskFilters } from '../src/providers/risk.js';
import {
  chains,
  settingsSchema,
  PendingTrade,
  type Chain,
  type CallSignal,
} from '../src/domain.js';
import { Store } from '../src/infra/store.js';
import { TradeEngine } from '../src/trading/engine.js';

function fixture(enabled: Chain) {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-chain-switch-'));
  const store = new Store(directory);
  const settings = settingsSchema.parse({
    tradingEnabled: false,
    chains: Object.fromEntries(
      chains.map((chain) => [
        chain,
        {
          enabled: chain === enabled,
          buySizeNative: '0.1',
          slippagePercent: 1,
        },
      ]),
    ),
  });
  store.saveSettings(settings);
  const attempted: Chain[] = [];
  const signed: Chain[] = [];
  let tokenReads = 0;
  let balanceReads = 0;
  let filterChecks = 0;
  let disableBeforeSigning = false;
  const adapter = (chain: Chain): ChainAdapter => ({
    chain,
    address: 'offline-wallet',
    readiness: () => [],
    verifyNetwork: async () => {},
    balance: async () => {
      balanceReads++;
      return { nativeRaw: '100000000000000000000', wrappedRaw: null };
    },
    tokenInfo: async (address) => {
      tokenReads++;
      return {
        chain,
        address,
        symbol: 'TEST',
        decimals: 9,
        marketCapUsd: 1000,
        liquidityUsd: 1000,
        usdPrice: 1,
        fetchedAt: Date.now(),
      };
    },
    quoteSell: async () => assert.fail('No positions should be monitored in this fixture'),
    advance: async (_operation, _persist, beforeSwap, beforeSpend) => {
      attempted.push(chain);
      await beforeSwap();
      if (disableBeforeSigning)
        store.updateSettings((value) => {
          value.chains[chain].enabled = false;
        });
      beforeSpend();
      signed.push(chain);
      throw new PendingTrade('Waiting for an offline fixture receipt');
    },
  });
  const engine = new TradeEngine(
    { listenOnly: false, maxSignalAgeMs: 120_000 } as Config,
    store,
    { solana: adapter('solana'), robinhood: adapter('robinhood') },
    {
      check: async () => {
        filterChecks++;
      },
    } as unknown as RiskFilters,
  );
  const addSignal = (chain: Chain, messageId = 1): CallSignal => {
    const signal: CallSignal = {
      id: `-1001:${messageId}`,
      channelId: '-1001',
      messageId,
      date: Date.now(),
      chain,
      address:
        chain === 'solana'
          ? 'So11111111111111111111111111111111111111112'
          : '0x787873c9ae96855bdb032f6ff1ef76a5e1fc8adc',
      caller: 'testcaller',
      callerId: null,
      consistency: { overall: 50, recent: 50, chain: 50 },
      advertisedMarketCapUsd: 1000,
    };
    store.recordPost(
      {
        channelId: signal.channelId,
        messageId,
        date: signal.date,
        revision: 1,
        text: '',
        urls: [],
      },
      signal,
      null,
    );
    return signal;
  };
  return {
    store,
    engine,
    attempted,
    signed,
    addSignal,
    reads: () => ({ tokenReads, balanceReads, filterChecks }),
    disableBeforeSigning() {
      disableBeforeSigning = true;
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const enabled of chains) {
  test(`${enabled} can enter directly when its chain is enabled, regardless of the removed legacy global flag`, async () => {
    const value = fixture(enabled);
    try {
      assert.equal('tradingEnabled' in value.store.settings(), false);
      const signal = value.addSignal(enabled);
      value.engine.observeSignal(signal);
      assert.equal(value.store.signalHistory()[0]?.observation?.decision, 'pending');
      await value.engine.tick();
      assert.deepEqual(value.attempted, [enabled]);
      assert.deepEqual(value.signed, [enabled]);
      assert.equal(value.store.activeOperation(enabled)?.status, 'active');
      if (enabled === 'solana')
        assert.deepEqual(value.reads(), { tokenReads: 0, balanceReads: 0, filterChecks: 1 });
      else assert.deepEqual(value.reads(), { tokenReads: 1, balanceReads: 0, filterChecks: 1 });
    } finally {
      value.close();
    }
  });
}

test('chain switches are independent and a disabled chain does not enter', async () => {
  const value = fixture('robinhood');
  try {
    const solana = value.addSignal('solana', 1);
    value.addSignal('robinhood', 2);
    value.engine.observeSignal(solana);
    assert.equal(
      value.store.signalHistory().find((call) => call.id === solana.id)?.observation?.reason,
      'chain_disabled',
    );
    await value.engine.tick();
    assert.deepEqual(value.attempted, ['robinhood']);
    assert.equal(value.store.hasEntry('solana', solana.address), false);
  } finally {
    value.close();
  }
});

test('one slippage setting gates both entry and exit readiness on either chain', () => {
  for (const chain of chains) {
    const value = fixture(chain);
    try {
      value.store.updateSettings((settings) => {
        settings.chains[chain].slippagePercent = null;
      });
      assert.deepEqual(value.engine.readiness(chain), ['slippage']);
      assert.deepEqual(value.engine.readiness(chain, false), ['slippage']);
      value.store.updateSettings((settings) => {
        settings.chains[chain].slippagePercent = 2.5;
      });
      assert.deepEqual(value.engine.readiness(chain), []);
      assert.deepEqual(value.engine.readiness(chain, false), []);
    } finally {
      value.close();
    }
  }
});

test('enabled Solana market checks fetch token data once without a balance preflight', async () => {
  const value = fixture('solana');
  try {
    value.store.updateSettings((settings) => {
      settings.chains.solana.filters.marketCapEnabled = true;
      settings.chains.solana.filters.minMarketCapUsd = 100;
      settings.chains.solana.filters.maxTopHoldersPercent = 20;
    });
    value.addSignal('solana');
    await value.engine.tick();
    assert.deepEqual(value.reads(), { tokenReads: 1, balanceReads: 0, filterChecks: 1 });
    assert.deepEqual(value.signed, ['solana']);
  } finally {
    value.close();
  }
});

test('disabling the chain during preparation prevents signing a new buy', async () => {
  const value = fixture('solana');
  try {
    const signal = value.addSignal('solana');
    value.disableBeforeSigning();
    await value.engine.tick();
    assert.deepEqual(value.signed, []);
    assert.equal(value.store.history()[0]?.status, 'failed');
    assert.match(
      value.store.history()[0]?.error ?? '',
      /Chain entries were disabled before signing/,
    );
    assert.equal(value.store.hasEntry('solana', signal.address), false);
  } finally {
    value.close();
  }
});
