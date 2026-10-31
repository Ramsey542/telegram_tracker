import type { Chain, ChainSettings, Operation, Quote, SwapResult, TokenInfo } from '../domain.js';

export interface ChainAdapter {
  readonly chain: Chain;
  readonly address: string;
  readiness(settings: ChainSettings): string[];
  verifyNetwork(): Promise<void>;
  balance(): Promise<{ nativeRaw: string; wrappedRaw: string | null }>;
  tokenInfo(address: string, settings?: ChainSettings): Promise<TokenInfo>;
  quoteSell(address: string, amountRaw: string, settings: ChainSettings): Promise<Quote>;
  advance(
    operation: Operation,
    persist: () => void,
    beforeSwap: () => Promise<void>,
    beforeSpend: () => void,
  ): Promise<SwapResult>;
}
