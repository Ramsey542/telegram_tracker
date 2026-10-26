import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { openWallets } from './wallets.js';
import { HttpClient, safeError } from './infra/http.js';
import { Store } from './infra/store.js';
import { acquireProcessLock } from './infra/process-lock.js';
import { MarketData } from './providers/market.js';
import { RiskFilters } from './providers/risk.js';
import { SolanaAdapter } from './chains/solana.js';
import { RobinhoodAdapter } from './chains/robinhood.js';
import { TradeEngine } from './trading/engine.js';
import { ChannelReader } from './telegram/reader.js';
import { ControlBot } from './telegram/bot.js';

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  const unlock = acquireProcessLock(config.dataDirectory);
  let store: Store | null = null;
  let reader: ChannelReader | null = null;
  let control: ControlBot | null = null;
  let engine: TradeEngine | null = null;
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await reader?.stop();
    await engine?.stop();
    await control?.stop();
    store?.close();
    unlock();
  };
  process.once('SIGINT', () => {
    void shutdown().catch((error) => {
      console.error(safeError(error));
      process.exitCode = 1;
    });
  });
  process.once('SIGTERM', () => {
    void shutdown().catch((error) => {
      console.error(safeError(error));
      process.exitCode = 1;
    });
  });
  try {
    const wallets = openWallets(config);
    store = new Store(config.dataDirectory);
    const http = new HttpClient(config.httpTimeoutMs, config.jupiterRps);
    const market = new MarketData(config, http);
    const filters = new RiskFilters(config, http, market);
    engine = new TradeEngine(
      config,
      store,
      {
        solana: new SolanaAdapter(config, wallets, http, market),
        robinhood: new RobinhoodAdapter(config, wallets, http, market),
      },
      filters,
    );
    const activeEngine = engine;
    reader = new ChannelReader(config, wallets, store, () => {
      void activeEngine.tick();
    });
    control = new ControlBot(config, store, engine);
    console.info(
      JSON.stringify({
        event: 'wallets_ready',
        solana: wallets.solana.publicKey.toBase58(),
        robinhood: wallets.robinhood.address,
      }),
    );
    await control.start();
    await reader.start();
    if (!closing) engine.start();
  } catch (error) {
    await shutdown();
    throw error;
  }
}

void main().catch((error) => {
  console.error(JSON.stringify({ event: 'startup_failed', message: safeError(error) }));
  process.exitCode = 1;
});
