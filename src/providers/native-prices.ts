import { z } from 'zod';
import type { Chain } from '../domain.js';
import { HttpClient } from '../infra/http.js';
import { logger } from '../logging/logger.js';
import { evmNetworks } from '../chains/networks.js';

export interface NativeUsdRate {
  value: number;
  observedAt: number;
}

const responseSchema = z.object({
  data: z.object({
    currency: z.literal('USD'),
    amount: z.coerce.number().positive().finite().max(1_000_000_000),
  }),
});
const log = logger.child({ component: 'trading.pnl' });

export class NativePrices {
  private readonly cache = new Map<Chain, NativeUsdRate>();
  private readonly pending = new Map<Chain, Promise<NativeUsdRate>>();
  constructor(private readonly http: HttpClient) {}

  async get(chain: Chain): Promise<NativeUsdRate> {
    const cached = this.cache.get(chain);
    if (cached && Date.now() - cached.observedAt < 30_000) return cached;
    const existing = this.pending.get(chain);
    if (existing) return existing;
    const action = this.fetch(chain);
    this.pending.set(chain, action);
    try {
      return await action;
    } finally {
      this.pending.delete(chain);
    }
  }

  private async fetch(chain: Chain): Promise<NativeUsdRate> {
    if (chain === 'bnb') {
      const pairs = await this.http.json(
        'DEX Screener BNB/USD price',
        `https://api.dexscreener.com/token-pairs/v1/bsc/${evmNetworks.bnb.wrappedNative}`,
        z.array(
          z.object({
            chainId: z.string(),
            baseToken: z.object({ address: z.string() }),
            priceUsd: z.string().nullish(),
            liquidity: z.object({ usd: z.number().nullish() }).nullish(),
          }),
        ),
        { retry: false },
      );
      const pair = pairs
        .filter(
          (pair) =>
            pair.chainId === 'bsc' &&
            pair.baseToken.address.toLowerCase() === evmNetworks.bnb.wrappedNative &&
            Number(pair.priceUsd) > 0 &&
            Number.isFinite(Number(pair.priceUsd)),
        )
        .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
      if (!pair) throw new Error('BNB/USD price is unavailable');
      const rate = { value: Number(pair.priceUsd), observedAt: Date.now() };
      this.cache.set(chain, rate);
      log.info('pnl.usd_rate_received', {
        chain,
        nativeUsd: rate.value,
        observedAt: rate.observedAt,
        service: 'DEX Screener',
      });
      return rate;
    }
    const symbol = chain === 'solana' ? 'SOL' : 'ETH';
    const result = await this.http.json(
      `Coinbase ${symbol}/USD spot price`,
      `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`,
      responseSchema,
      { retry: false },
    );
    const rate = { value: result.data.amount, observedAt: Date.now() };
    this.cache.set(chain, rate);
    log.info('pnl.usd_rate_received', {
      chain,
      nativeUsd: rate.value,
      observedAt: rate.observedAt,
      service: 'Coinbase spot price',
    });
    return rate;
  }
}
