import { z } from 'zod';
import type { Config } from '../config.js';
import { HttpClient } from '../infra/http.js';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'trading.market' });

const nullableNumber = z.number().finite().nullable().optional();
const tokenSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(36),
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
export type DexPair = z.infer<typeof pairSchema>;
export class MarketData {
  constructor(
    private readonly config: Config,
    private readonly http: HttpClient,
  ) {}
  async pair(chain: string, address: string): Promise<DexPair | null> {
    const result = await this.http.json(
      'DEX Screener pair lookup',
      `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`,
      z.object({ pairs: z.array(pairSchema).nullable() }),
    );
    return (
      result.pairs?.find(
        (pair) =>
          pair.chainId === chain && pair.pairAddress.toLowerCase() === address.toLowerCase(),
      ) ?? null
    );
  }
  async solana(mint: string) {
    const tokens = await this.http.json(
      'Jupiter token data',
      `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
      z.array(tokenSchema),
      { headers: { 'x-api-key': this.config.jupiterKey } },
    );
    const token = tokens.find((token) => token.id === mint) ?? null;
    log.info('market.token_result', {
      service: 'Jupiter token data',
      chain: 'solana',
      token: mint,
      matched: token !== null,
      data: token,
    });
    return token;
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
    log.info('market.token_result', {
      service: 'DEX Screener',
      chain: 'robinhood',
      token: address,
      matched: matching.length > 0,
      pairCount: pairs.length,
      matchingPairs: matching.length,
      selectedPair: matching[0] ?? null,
    });
    return matching[0] ?? null;
  }
}
