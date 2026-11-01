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
  let beforeSigning: (() => void) | undefined;
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
      beforeSigning?.();
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
  const addSignal = (
    chain: Chain,
    messageId = 1,
    labels: Partial<Pick<CallSignal, 'firstCaller' | 'justLaunched' | 'mode' | 'consistency'>> = {},
  ): CallSignal => {
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
      ...labels,
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
    beforeSigning(change: () => void) {
      beforeSigning = change;
    },
    close() {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const chain of chains) {
  for (const [filter, label, reason] of [
    ['buyOnlyFirstCaller', 'firstCaller', 'FIRST CALLER label is missing'],
    ['justLaunched', 'justLaunched', 'JUST LAUNCHED label is missing'],
  ] as const) {
    test(`${chain} rejects a missing ${label} label before requests or token reservation`, async () => {
      for (const present of [false, undefined]) {
        const value = fixture(chain);
        try {
          value.store.updateSettings((settings) => {
            settings.chains[chain].filters[filter] = true;
          });
          const signal = value.addSignal(chain, 1, { [label]: present });
          value.engine.observeSignal(signal);
          assert.ok(value.store.signalHistory()[0]?.observation?.reason.includes(reason));
          await value.engine.tick();
          assert.ok(value.store.signalHistory()[0]?.reason?.includes(reason));
          assert.deepEqual(value.attempted, []);
          assert.deepEqual(value.reads(), { tokenReads: 0, balanceReads: 0, filterChecks: 0 });
          assert.equal(value.store.hasEntry(chain, signal.address), false);
        } finally {
          value.close();
        }
      }
    });

    test(`${chain} accepts ${label} without requiring the other disabled label`, async () => {
      const value = fixture(chain);
      try {
        value.store.updateSettings((settings) => {
          settings.chains[chain].filters[filter] = true;
        });
        value.addSignal(chain, 1, { [label]: true });
        await value.engine.tick();
        assert.deepEqual(value.signed, [chain]);
      } finally {
        value.close();
      }
    });

    test(`${chain} rechecks the ${label} requirement before signing`, async () => {
      const value = fixture(chain);
      try {
        const signal = value.addSignal(chain);
        value.beforeSigning(() =>
          value.store.updateSettings((settings) => {
            settings.chains[chain].filters[filter] = true;
          }),
        );
        await value.engine.tick();
        assert.deepEqual(value.signed, []);
        assert.ok(value.store.history()[0]?.error?.includes(reason));
        assert.equal(value.store.hasEntry(chain, signal.address), false);
      } finally {
        value.close();
      }
    });
  }

  test(`${chain} requires both SpyDefi labels when both filters are enabled`, async () => {
    for (const [firstCaller, justLaunched] of [
      [true, true],
      [true, false],
      [false, true],
    ]) {
      const value = fixture(chain);
      try {
        value.store.updateSettings((settings) => {
          settings.chains[chain].filters.buyOnlyFirstCaller = true;
          settings.chains[chain].filters.justLaunched = true;
        });
        value.addSignal(chain, 1, { firstCaller, justLaunched });
        await value.engine.tick();
        assert.deepEqual(value.signed, firstCaller && justLaunched ? [chain] : []);
      } finally {
        value.close();
      }
    }
  });

  test(`${chain} SpyDefi label filters do not bypass consistency or affect general calls`, async () => {
    for (const mode of ['spydefi', 'general'] as const) {
      const value = fixture(chain);
      try {
        value.store.updateSettings((settings) => {
          settings.chains[chain].filters.buyOnlyFirstCaller = true;
          settings.chains[chain].filters.justLaunched = true;
        });
        value.addSignal(chain, 1, {
          mode,
          firstCaller: mode === 'spydefi',
          justLaunched: mode === 'spydefi',
          consistency: mode === 'spydefi' ? { overall: 41, recent: 25, chain: 40 } : null,
        });
        await value.engine.tick();
        assert.deepEqual(value.signed, mode === 'general' ? [chain] : []);
        if (mode === 'spydefi')
          assert.match(value.store.signalHistory()[0]?.reason ?? '', /recent consistency/);
      } finally {
        value.close();
      }
    }
  });
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
