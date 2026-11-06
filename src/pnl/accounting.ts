import { nativeDecimals, type Operation, type Position, type SwapResult } from '../domain.js';
import type { PnlChain, PnlFill, PnlMark, PnlSummary, PnlWindow } from './types.js';

export const USD_SCALE = 100_000_000n;
export const USD_CAPTURE_WINDOW_MS = 120_000;
export const PNL_QUOTE_MAX_AGE_MS = 300_000;

export function usdValue(
  raw: string | bigint,
  decimals: number,
  nativeUsd: number | null,
): bigint | null {
  if (nativeUsd === null || !Number.isFinite(nativeUsd) || nativeUsd <= 0) return null;
  const scaled = Math.round(nativeUsd * Number(USD_SCALE));
  if (!Number.isSafeInteger(scaled) || scaled <= 0) return null;
  return (BigInt(raw) * BigInt(scaled)) / 10n ** BigInt(decimals);
}

export function pnlFill(
  operation: Operation,
  position: Position,
  result: SwapResult | null,
  confirmedAt: number,
  legacy = false,
): PnlFill {
  if (operation.kind !== 'buy' && operation.kind !== 'sell')
    throw new Error('Only buys and sells are trade fills');
  const buy = operation.kind === 'buy';
  const step = operation.steps.find((candidate) => candidate.type === 'jupiter');
  const amounts = step?.executionAmounts;
  let swapNativeRaw =
    result?.swapNativeRaw ?? (amounts ? (buy ? amounts.inputRaw : amounts.outputRaw) : null);
  let walletNativeRaw = result?.nativeRaw ?? (buy ? position.entryNativeRaw : null);
  let feeNativeRaw = result?.feeNativeRaw ?? (buy ? position.entryFeeNativeRaw : null);
  if (buy) swapNativeRaw ??= position.entrySwapNativeRaw ?? operation.amountRaw;
  if (operation.chain !== 'solana') {
    swapNativeRaw ??= buy ? operation.amountRaw : operation.outputRaw;
    feeNativeRaw ??= operation.steps
      .reduce(
        (sum, candidate) =>
          sum + (candidate.type === 'evm' ? BigInt(candidate.gasPaidRaw ?? '0') : 0n),
        0n,
      )
      .toString();
    if (swapNativeRaw !== null)
      walletNativeRaw ??= (
        buy
          ? BigInt(swapNativeRaw) + BigInt(feeNativeRaw)
          : BigInt(swapNativeRaw) - BigInt(feeNativeRaw)
      ).toString();
  }
  const quote = operation.quote;
  const rate =
    result?.nativeUsd ??
    (quote && Math.abs(confirmedAt - quote.receivedAt) <= USD_CAPTURE_WINDOW_MS
      ? quote.nativeUsd
      : null);
  const nativeUsd = usdValue('1', 0, rate) === null ? null : rate;
  return {
    operationId: operation.id,
    positionId: position.id,
    chain: operation.chain,
    symbol: position.symbol,
    kind: operation.kind,
    tokenRaw: result?.tokenRaw ?? (buy ? position.originalTokenRaw : operation.amountRaw),
    swapNativeRaw,
    walletNativeRaw,
    feeNativeRaw,
    nativeUsd,
    usdSource: nativeUsd === null ? null : 'swap_quote',
    usdAt: nativeUsd === null ? null : (quote?.receivedAt ?? confirmedAt),
    confirmedAt,
    legacy,
  };
}

interface Lot {
  quantity: bigint;
  costUsd: bigint | null;
  incomplete: boolean;
}

export function summarizePnl(
  fills: readonly PnlFill[],
  positions: readonly Position[],
  marks: readonly PnlMark[],
  window: PnlWindow,
  chain: PnlChain,
  now = Date.now(),
): PnlSummary {
  const summary: PnlSummary = {
    window,
    chain,
    buys: 0,
    sells: 0,
    pricedSales: 0,
    winningSales: 0,
    losingSales: 0,
    realizedUsd: 0n,
    allocatedCostUsd: 0n,
    proceedsUsd: 0n,
    networkFeesUsd: 0n,
    unpricedFees: 0,
    fundingUsd: 0n,
    unpricedFunding: 0,
    estimatedFills: 0,
    openPositions: 0,
    valuedPositions: 0,
    unrealizedUsd: 0n,
    oldestQuoteAt: null,
  };
  const lots = new Map<string, Lot>();
  const incomplete = new Set<string>();
  const seen = new Set<string>();
  const ordered = [...fills].sort(
    (a, b) => a.confirmedAt - b.confirmedAt || (a.kind === b.kind ? 0 : a.kind === 'buy' ? -1 : 1),
  );
  for (const fill of ordered) {
    if (
      (chain !== 'all' && fill.chain !== chain) ||
      seen.has(fill.operationId) ||
      fill.confirmedAt > now
    )
      continue;
    seen.add(fill.operationId);
    const inPeriod = fill.confirmedAt >= window.start && fill.confirmedAt < window.end;
    const decimals = nativeDecimals[fill.chain];
    const swap = fill.swapNativeRaw === null ? null : BigInt(fill.swapNativeRaw);
    const fee = fill.feeNativeRaw === null ? null : BigInt(fill.feeNativeRaw);
    const quantity = BigInt(fill.tokenRaw);
    const pricedFee =
      fee === null ? null : fee === 0n ? 0n : usdValue(fee, decimals, fill.nativeUsd);
    const funding =
      swap === null || fee === null || fill.walletNativeRaw === null
        ? null
        : fill.kind === 'buy'
          ? swap + fee - BigInt(fill.walletNativeRaw)
          : BigInt(fill.walletNativeRaw) - (swap - fee);
    if (inPeriod) {
      if (fill.kind === 'buy') summary.buys++;
      else summary.sells++;
      if (fill.legacy) summary.estimatedFills++;
      if (pricedFee === null) summary.unpricedFees++;
      else summary.networkFeesUsd += pricedFee;
      const fundingUsd =
        funding === null ? null : funding === 0n ? 0n : usdValue(funding, decimals, fill.nativeUsd);
      if (fundingUsd === null) summary.unpricedFunding++;
      else summary.fundingUsd += fundingUsd;
    }
    if (fill.kind === 'buy') {
      const cost =
        swap === null || fee === null ? null : usdValue(swap + fee, decimals, fill.nativeUsd);
      const existing = lots.get(fill.positionId);
      lots.set(fill.positionId, {
        quantity: quantity + (existing?.quantity ?? 0n),
        costUsd:
          cost === null || existing?.costUsd === null ? null : cost + (existing?.costUsd ?? 0n),
        incomplete:
          quantity <= 0n || incomplete.has(fill.positionId) || (existing?.incomplete ?? false),
      });
      continue;
    }
    const lot = lots.get(fill.positionId);
    if (!lot || lot.incomplete || quantity <= 0n || quantity > lot.quantity) {
      incomplete.add(fill.positionId);
      if (lot) lot.incomplete = true;
      continue;
    }
    const allocated = lot.costUsd === null ? null : (lot.costUsd * quantity) / lot.quantity;
    lot.quantity -= quantity;
    if (allocated !== null) lot.costUsd = lot.costUsd! - allocated;
    const proceeds =
      swap === null || fee === null ? null : usdValue(swap - fee, decimals, fill.nativeUsd);
    if (!inPeriod || allocated === null || proceeds === null) continue;
    const gain = proceeds - allocated;
    summary.pricedSales++;
    summary.realizedUsd = summary.realizedUsd! + gain;
    summary.allocatedCostUsd += allocated;
    summary.proceedsUsd += proceeds;
    if (gain > 0n) summary.winningSales++;
    if (gain < 0n) summary.losingSales++;
  }
  if (summary.sells > 0 && summary.pricedSales === 0) summary.realizedUsd = null;
  for (const position of positions) {
    if (position.closedAt !== null || (chain !== 'all' && position.chain !== chain)) continue;
    summary.openPositions++;
    const lot = lots.get(position.id);
    if (
      !lot ||
      lot.incomplete ||
      lot.costUsd === null ||
      lot.quantity !== BigInt(position.remainingTokenRaw)
    )
      continue;
    const mark = marks.find(
      (value) => value.positionId === position.id && value.tokenRaw === position.remainingTokenRaw,
    );
    if (!mark || mark.receivedAt > now || now - mark.receivedAt > PNL_QUOTE_MAX_AGE_MS) continue;
    const valueUsd = usdValue(mark.outputRaw, nativeDecimals[position.chain], mark.nativeUsd);
    if (valueUsd === null) continue;
    summary.valuedPositions++;
    summary.unrealizedUsd = summary.unrealizedUsd! + valueUsd - lot.costUsd;
    summary.oldestQuoteAt = Math.min(summary.oldestQuoteAt ?? mark.receivedAt, mark.receivedAt);
  }
  if (summary.openPositions > 0 && summary.valuedPositions === 0) summary.unrealizedUsd = null;
  return summary;
}
