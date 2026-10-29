import type { Config } from '../config.js';
import type { ChainAdapter } from '../chains/types.js';
import { chains, type Chain } from '../domain.js';
import { Store } from '../infra/store.js';
import { logger, withLogContext } from '../logging/logger.js';
import { NativePrices } from '../providers/native-prices.js';
import { USD_CAPTURE_WINDOW_MS } from './accounting.js';

const log = logger.child({ component: 'trading.pnl' });

export class PnlTracker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private work: Promise<void> | null = null;
  private stopped = false;
  private requestedQuotes = false;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly adapters: Record<Chain, ChainAdapter>,
    private readonly prices: NativePrices,
  ) {}

  get updating(): boolean {
    return this.work !== null;
  }

  start(): void {
    this.timer = setInterval(() => this.run(), 15_000);
    this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.work;
  }

  requestQuotes(): void {
    if (this.config.listenOnly)
      throw new Error('Open-position quotes are disabled in listen-only mode');
    this.requestedQuotes = true;
    this.run();
  }
  refreshRates(): void {
    this.run();
  }

  private run(): void {
    if (this.stopped || this.work) return;
    this.work = this.update()
      .catch((error: unknown) => log.error('pnl.update_failed', error))
      .finally(() => {
        this.work = null;
        if (this.requestedQuotes && !this.stopped) this.run();
      });
  }

  private async update(): Promise<void> {
    const now = Date.now();
    const fills = this.store.pnlPendingRates(now);
    await Promise.all(
      chains.map(async (chain) => {
        const pending = fills.filter((fill) => fill.chain === chain);
        if (!pending.length) return;
        try {
          const rate = await this.prices.get(chain);
          for (const fill of pending) {
            if (Math.abs(rate.observedAt - fill.confirmedAt) > USD_CAPTURE_WINDOW_MS) continue;
            this.store.pricePnlFill(fill.operationId, rate.value, rate.observedAt);
            log.info('pnl.fill_priced', {
              chain,
              operationId: fill.operationId,
              positionId: fill.positionId,
              nativeUsd: rate.value,
              observedAt: rate.observedAt,
            });
          }
        } catch (error) {
          log.error('pnl.usd_price_failed', error, { chain });
        }
      }),
    );
    if (!this.requestedQuotes || this.stopped) return;
    this.requestedQuotes = false;
    if (this.config.listenOnly) return;
    for (const position of this.store.positions()) {
      if (this.stopped) return;
      if (this.store.activeOperation(position.chain)) {
        log.info('pnl.quote_skipped', {
          chain: position.chain,
          positionId: position.id,
          token: position.address,
          reason: 'trade_in_progress',
        });
        continue;
      }
      await withLogContext(
        { chain: position.chain, positionId: position.id, token: position.address },
        async () => {
          try {
            const settings = this.store.settings().chains[position.chain];
            const quote = await this.adapters[position.chain].quoteSell(
              position.address,
              position.remainingTokenRaw,
              settings,
            );
            const nativeUsd = quote.nativeUsd ?? (await this.prices.get(position.chain)).value;
            const current = this.store.position(position.id);
            if (
              !current ||
              current.closedAt !== null ||
              current.remainingTokenRaw !== quote.inputRaw
            )
              return;
            this.store.savePnlMark({
              positionId: position.id,
              tokenRaw: quote.inputRaw,
              outputRaw: quote.outputRaw,
              nativeUsd,
              receivedAt: quote.receivedAt,
            });
            log.info('pnl.quote_received', { quote, nativeUsd });
          } catch (error) {
            log.error('pnl.quote_failed', error);
          }
        },
      );
    }
  }
}
