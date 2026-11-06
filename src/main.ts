import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { openWallets } from './wallets.js';
import { HttpClient } from './infra/http.js';
import { Store } from './infra/store.js';
import { acquireProcessLock } from './infra/process-lock.js';
import { MarketData } from './providers/market.js';
import { PositionPrices } from './providers/position-prices.js';
import { NativePrices } from './providers/native-prices.js';
import { PnlTracker } from './pnl/tracker.js';
import { RiskFilters } from './providers/risk.js';
import { SolanaAdapter } from './chains/solana.js';
import { RobinhoodAdapter } from './chains/robinhood.js';
import { BnbAdapter } from './chains/bnb.js';
import { TradeEngine } from './trading/engine.js';
import { ChannelReader } from './telegram/reader.js';
import { ControlBot } from './telegram/bot.js';
import { configureLogging, logger } from './logging/logger.js';
import { registerSecrets } from './logging/redaction.js';

const log = logger.child({ component: 'app' });

async function main(): Promise<void> {
  registerSecrets(
    [
      'TELEGRAM_API_HASH',
      'TELEGRAM_PHONE',
      'TELEGRAM_BOT_TOKEN',
      'QUICKNODE_SOLANA_RPC_URL',
      'QUICKNODE_ROBINHOOD_RPC_URL',
      'QUICKNODE_BNB_RPC_URL',
      'JUPITER_API_KEY',
      'UNISWAP_API_KEY',
      'RUGCHECK_API_KEY',
      'GOPLUS_ACCESS_TOKEN',
      'GOPLUS_APP_KEY',
      'GOPLUS_APP_SECRET',
      'WALLET_ENCRYPTION_KEY',
    ]
      .map((key) => process.env[key] ?? '')
      .filter(Boolean),
  );
  configureLogging({
    directory: resolve(process.env.LOG_DIRECTORY?.trim() || 'logs'),
    level: 'info',
    console: process.env.LOG_CONSOLE !== 'false',
    maxFileBytes: 10 * 1024 * 1024,
    maxFiles: 5,
  });
  const config = loadConfig();
  registerSecrets(
    [
      config.telegramApiHash,
      config.telegramPhone,
      config.botToken,
      config.solanaRpc,
      config.robinhoodRpc,
      config.bnbRpc,
      config.jupiterKey,
      config.uniswapKey,
      config.rugcheckKey,
      config.goplusToken,
      config.goplusAppKey,
      config.goplusAppSecret,
      config.walletEncryptionKey,
    ].filter(Boolean),
  );
  configureLogging({
    directory: config.logDirectory,
    level: config.logLevel,
    console: config.logConsole,
    maxFileBytes: config.logMaxFileBytes,
    maxFiles: config.logMaxFiles,
  });
  log.debug('app.starting', {
    mode: config.listenOnly ? 'listen_only' : 'trading',
    source: config.sourceChannel,
    logDirectory: config.logDirectory,
    logLevel: config.logLevel,
  });
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  const unlock = acquireProcessLock(config.dataDirectory);
  let store: Store | null = null;
  let reader: ChannelReader | null = null;
  let control: ControlBot | null = null;
  let engine: TradeEngine | null = null;
  let pnl: PnlTracker | null = null;
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    log.debug('app.stopping');
    for (const [component, close] of [
      ['reader', async () => reader?.stop()],
      ['pnl', async () => pnl?.stop()],
      ['engine', async () => engine?.stop()],
      ['control', async () => control?.stop()],
      ['store', async () => store?.close()],
      ['process_lock', async () => unlock()],
    ] as const) {
      try {
        await close();
      } catch (error) {
        log.error('app.shutdown_failed', error, { closingComponent: component });
        process.exitCode = 1;
      }
    }
    log.debug('app.stopped');
  };
  process.once('SIGINT', () => {
    void shutdown().catch((error) => {
      log.error('app.signal_shutdown_failed', error);
      process.exitCode = 1;
    });
  });
  process.once('SIGTERM', () => {
    void shutdown().catch((error) => {
      log.error('app.signal_shutdown_failed', error);
      process.exitCode = 1;
    });
  });
  const fatal = (event: string, error: unknown): void => {
    log.error(event, error);
    process.exitCode = 1;
    void shutdown().catch((failure) => log.error('app.fatal_shutdown_failed', failure));
  };
  process.once('unhandledRejection', (error) => fatal('app.unhandled_rejection', error));
  process.once('uncaughtException', (error) => fatal('app.uncaught_exception', error));
  try {
    const wallets = openWallets(config);
    store = new Store(config.dataDirectory);
    const http = new HttpClient(config.httpTimeoutMs, config.jupiterRps);
    const market = new MarketData(config, http);
    const nativePrices = new NativePrices(http);
    const positionPrices = new PositionPrices(config, http, nativePrices);
    const filters = new RiskFilters(config, http);
    engine = new TradeEngine(
      config,
      store,
      {
        solana: new SolanaAdapter(config, wallets, http, market),
        robinhood: new RobinhoodAdapter(config, wallets, http, market),
        bnb: new BnbAdapter(config, wallets, http, market),
      },
      filters,
      () => pnl?.refreshRates(),
      positionPrices,
      market,
    );
    const activeEngine = engine;
    pnl = new PnlTracker(config, store, engine.adapters, nativePrices, positionPrices);
    reader = new ChannelReader(
      config,
      wallets,
      store,
      (signal) => {
        if (signal) activeEngine.observeSignal(signal);
        void activeEngine
          .tick(Boolean(signal))
          .catch((error) => log.error('engine.tick_failed', error));
      },
      market,
    );
    const activeReader = reader;
    control = new ControlBot(
      config,
      store,
      engine,
      (references) => activeReader.hydrateHistory(references),
      pnl,
      activeReader.channels,
    );
    log.debug('wallets.ready', {
      solana: wallets.solana.publicKey.toBase58(),
      robinhood: wallets.robinhood.address,
      bnb: wallets.bnb.address,
    });
    await control.start();
    await reader.start();
    if (!closing) {
      engine.start();
      pnl.start();
    }
    log.debug('app.ready', {
      mode: config.listenOnly ? 'listen_only' : 'trading',
      source: config.sourceChannel,
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

void main().catch((error) => {
  log.error('app.startup_failed', error);
  process.exitCode = 1;
});
