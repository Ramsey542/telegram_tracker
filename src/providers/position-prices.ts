import { z } from 'zod';
import type { Config } from '../config.js';
import {
  chains,
  nativeDecimals,
  parseAmount,
  type Chain,
  type Position,
  type Quote,
} from '../domain.js';
import { HttpClient } from '../infra/http.js';
import { logger } from '../logging/logger.js';
import { NativePrices } from './native-prices.js';
import { evmNetworks } from '../chains/networks.js';

const SOL = 'So11111111111111111111111111111111111111112';
const log = logger.child({ component: 'trading.prices' });
const priceSchema = z.record(
  z.string(),
  z.object({
    usdPrice: z.number().positive().finite().max(1e12),
    blockId: z.number().int().nonnegative(),
    decimals: z.number().int().min(0).max(36),
  }),
);
const pairSchema = z.object({
  chainId: z.string(),
  baseToken: z.object({ address: z.string() }),
  quoteToken: z.object({ address: z.string() }),
  priceUsd: z.string().nullish(),
  priceNative: z.string().nullish(),
  liquidity: z.object({ usd: z.number().nonnegative().nullish() }).nullish(),
});
interface ReferencePrice {
  usd: number;
  nativeUsd: number;
  receivedAt: number;
  source: string;
}
const key = (chain: Chain, address: string): string =>
  `${chain}:${chain === 'solana' ? address : address.toLowerCase()}`;
const scaled = (value: number): bigint => parseAmount(value.toFixed(18), 18);

export class PositionPrices {
  private readonly cache = new Map<string, ReferencePrice>();
  private readonly pending = new Map<Chain, Promise<void>>();
  private readonly queued = new Map<Chain, Set<string>>();
  constructor(
    private readonly config: Config,
    private readonly http: HttpClient,
    private readonly nativePrices: NativePrices,
  ) {}
  async quotes(positions: readonly Position[]): Promise<Map<string, Quote>> {
    const results = await Promise.allSettled(
      chains.map(async (chain) => {
        const addresses = [
          ...new Set(
            positions
              .filter((p) => p.chain === chain)
              .map((p) => (chain === 'solana' ? p.address : p.address.toLowerCase())),
          ),
        ];
        if (!addresses.length) return;
        if (
          addresses.every(
            (address) =>
              Date.now() - (this.cache.get(key(chain, address))?.receivedAt ?? 0) <
              Math.min(1000, this.config.pollMs),
          )
        )
          return;
        const queued = this.queued.get(chain) ?? new Set<string>();
        for (const address of addresses) queued.add(address);
        this.queued.set(chain, queued);
        const existing = this.pending.get(chain);
        if (existing) return existing;
        const request = Promise.resolve().then(async () => {
          try {
            while (queued.size > 0) {
              const batch = [...queued];
              queued.clear();
              await this.fetch(chain, batch);
            }
          } finally {
            this.pending.delete(chain);
            this.queued.delete(chain);
          }
        });
        this.pending.set(chain, request);
        await request;
      }),
    );
    for (const [index, result] of results.entries())
      if (result.status === 'rejected')
        log.error('position.price_batch_failed', result.reason, { chain: chains[index] });
    const quotes = new Map<string, Quote>();
    for (const position of positions) {
      const price = this.cache.get(key(position.chain, position.address));
      if (!price || Date.now() - price.receivedAt > 5000) {
        log.warn('position.price_unavailable', {
          chain: position.chain,
          positionId: position.id,
          token: position.address,
        });
        continue;
      }
      if (
        ![price.usd, price.nativeUsd].every(
          (value) => Number.isFinite(value) && value > 0 && value <= 1e12,
        )
      ) {
        log.warn('position.price_invalid', {
          chain: position.chain,
          positionId: position.id,
          token: position.address,
          price,
        });
        continue;
      }
      const tokenUsd = scaled(price.usd);
      const nativeUsd = scaled(price.nativeUsd);
      if (tokenUsd <= 0n || nativeUsd <= 0n) continue;
      const output =
        (BigInt(position.remainingTokenRaw) *
          tokenUsd *
          10n ** BigInt(nativeDecimals[position.chain])) /
        (10n ** BigInt(position.decimals) * nativeUsd);
      quotes.set(position.id, {
        inputRaw: position.remainingTokenRaw,
        outputRaw: output.toString(),
        minOutputRaw: output.toString(),
        nativeUsd: price.nativeUsd,
        priceImpactPercent: null,
        receivedAt: price.receivedAt,
        source: price.source,
        estimated: true,
      });
    }
    return quotes;
  }
  private async fetch(chain: Chain, addresses: string[]): Promise<void> {
    const size = chain === 'solana' ? 49 : 30;
    for (let offset = 0; offset < addresses.length; offset += size) {
      const batch = addresses.slice(offset, offset + size);
      for (const address of batch) this.cache.delete(key(chain, address));
      if (chain === 'solana') {
        const ids = [...new Set([...batch, SOL])];
        const result = await this.http.json(
          'Jupiter batch prices',
          `https://api.jup.ag/price/v3?ids=${ids.join(',')}`,
          priceSchema,
          { headers: { 'x-api-key': this.config.jupiterKey }, retry: false },
        );
        const native = result[SOL];
        if (!native) throw new Error('Jupiter batch prices did not return a SOL price');
        for (const address of batch) {
          const price = result[address];
          if (!price) {
            log.warn('position.price_missing', {
              chain,
              token: address,
              service: 'Jupiter Price API V3',
            });
            continue;
          }
          const blockLag = native.blockId - price.blockId;
          if (blockLag > (this.config.priceMaxBlockLag ?? 150)) {
            log.warn('position.price_stale', {
              chain,
              token: address,
              service: 'Jupiter Price API V3',
              blockId: price.blockId,
              solBlockId: native.blockId,
              blockLag,
              maximumBlockLag: this.config.priceMaxBlockLag ?? 150,
            });
            continue;
          }
          this.cache.set(key(chain, address), {
            usd: price.usdPrice,
            nativeUsd: native.usdPrice,
            receivedAt: Date.now(),
            source: 'Jupiter Price API V3',
          });
        }
      } else {
        const result = await this.http.json(
          'DEX Screener batch prices',
          `https://api.dexscreener.com/tokens/v1/${evmNetworks[chain].dexChain}/${batch.join(',')}`,
          z.array(pairSchema),
          { retry: false },
        );
        for (const address of batch) {
          const pair = result
            .filter(
              (p) =>
                p.chainId === evmNetworks[chain].dexChain &&
                p.baseToken.address.toLowerCase() === address,
            )
            .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
          const usd = Number(pair?.priceUsd);
          if (!pair || !Number.isFinite(usd) || usd <= 0) continue;
          const native = Number(pair.priceNative);
          const nativeUsd =
            pair.quoteToken.address.toLowerCase() === evmNetworks[chain].wrappedNative &&
            Number.isFinite(native) &&
            native > 0
              ? usd / native
              : (await this.nativePrices.get(chain)).value;
          this.cache.set(key(chain, address), {
            usd,
            nativeUsd,
            receivedAt: Date.now(),
            source: 'DEX Screener',
          });
        }
      }
      log.info('position.price_batch_received', {
        chain,
        requested: batch.length,
        returned: batch.filter((address) => this.cache.has(key(chain, address))).length,
        prices: batch.map((address) => ({
          token: address,
          ...this.cache.get(key(chain, address)),
        })),
      });
    }
    if (this.cache.size > 2048)
      for (const [cacheKey, value] of this.cache)
        if (Date.now() - value.receivedAt > 5000) this.cache.delete(cacheKey);
  }
}
