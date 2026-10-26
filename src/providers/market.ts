import { z } from 'zod';
import type { Config } from '../config.js';
import { HttpClient } from '../infra/http.js';

const nullableNumber = z.number().finite().nullable().optional();
const tokenSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  decimals: z.number().int(),
  mcap: nullableNumber,
  usdPrice: nullableNumber,
  liquidity: nullableNumber,
  updatedAt: z.string().optional(),
  audit: z.object({ topHoldersPercentage: nullableNumber }).optional(),
});
const pairSchema = z.object({
  chainId: z.string(),
  pairAddress: z.string(),
  baseToken: z.object({ address: z.string(), symbol: z.string() }),
  quoteToken: z.object({ address: z.string(), symbol: z.string() }),
  priceUsd: z.string().nullable().optional(),
  marketCap: nullableNumber,
  fdv: nullableNumber,
  liquidity: z.object({ usd: nullableNumber }).nullable().optional(),
});
export class MarketData {
  constructor(
    private readonly config: Config,
    private readonly http: HttpClient,
  ) {}
  async solana(mint: string) {
    const tokens = await this.http.json(
      'Jupiter token data',
      `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      z.array(tokenSchema),
      { headers: { 'x-api-key': this.config.jupiterKey } },
    );
    return tokens.find((token) => token.id === mint) ?? null;
  }
  async robinhood(address: string) {
    const pairs = await this.http.json(
      'DEX Screener',
      `https://api.dexscreener.com/token-pairs/v1/robinhood/${address}`,
      z.array(pairSchema),
    );
    const matching = pairs.filter(
      (pair) =>
        pair.chainId === 'robinhood' &&
        pair.baseToken.address.toLowerCase() === address.toLowerCase(),
    );
    matching.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    return matching[0] ?? null;
  }
}
