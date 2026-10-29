import type { Chain } from '../domain.js';

export interface PnlFill {
  operationId: string;
  positionId: string;
  chain: Chain;
  symbol: string;
  kind: 'buy' | 'sell';
  tokenRaw: string;
  swapNativeRaw: string | null;
  walletNativeRaw: string | null;
  feeNativeRaw: string | null;
  nativeUsd: number | null;
  usdSource: 'swap_quote' | 'coinbase_spot' | null;
  usdAt: number | null;
  confirmedAt: number;
  legacy: boolean;
}

export interface PnlMark {
  positionId: string;
  tokenRaw: string;
  outputRaw: string;
  nativeUsd: number | null;
  receivedAt: number;
}

export type PnlPeriod = 'day' | 'week' | 'month';
export type PnlChain = Chain | 'all';

export interface PnlWindow {
  period: PnlPeriod;
  offset: number;
  start: number;
  end: number;
  label: string;
  timeZone: string;
}

export interface PnlSummary {
  window: PnlWindow;
  chain: PnlChain;
  buys: number;
  sells: number;
  pricedSales: number;
  winningSales: number;
  losingSales: number;
  realizedUsd: bigint | null;
  allocatedCostUsd: bigint;
  proceedsUsd: bigint;
  networkFeesUsd: bigint;
  unpricedFees: number;
  fundingUsd: bigint;
  unpricedFunding: number;
  estimatedFills: number;
  openPositions: number;
  valuedPositions: number;
  unrealizedUsd: bigint | null;
  oldestQuoteAt: number | null;
}
