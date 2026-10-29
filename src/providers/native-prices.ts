import { z } from 'zod';
import type { Chain } from '../domain.js';
import { HttpClient } from '../infra/http.js';
import { logger } from '../logging/logger.js';

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
