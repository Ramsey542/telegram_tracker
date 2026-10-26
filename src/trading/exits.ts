import {
  bps,
  profitBps,
  type Position,
  type Quote,
  type TrailRule,
  type TrailState,
} from '../domain.js';

export interface ExitDecision {
  key: string;
  amountRaw: string;
  minimumNativeRaw: string | null;
}
const minimum = (cost: bigint, quantity: bigint, original: bigint, profit: number): string =>
  (
    (cost * quantity * (10_000n + bps(profit)) + original * 10_000n - 1n) /
    (original * 10_000n)
  ).toString();

function trailing(
  rule: TrailRule,
  state: TrailState,
  key: string,
  native: bigint,
  quantity: bigint,
  profit: bigint,
): ExitDecision | null {
  if (
    !rule.enabled ||
    state.sold ||
    rule.activationPercent === null ||
    rule.drawdownPercent === null ||
    rule.sellPercent === null
  )
    return null;
  if (!state.active && profit >= bps(rule.activationPercent)) {
    state.active = true;
    state.peakNativeRaw = native.toString();
    state.peakTokenRaw = quantity.toString();
  }
  if (!state.active) return null;
  if (native * BigInt(state.peakTokenRaw) > BigInt(state.peakNativeRaw) * quantity) {
    state.peakNativeRaw = native.toString();
    state.peakTokenRaw = quantity.toString();
  }
  if (
    native * BigInt(state.peakTokenRaw) * 10_000n >
    BigInt(state.peakNativeRaw) * quantity * (10_000n - bps(rule.drawdownPercent))
  )
    return null;
  const amount = (quantity * bps(rule.sellPercent)) / 10_000n;
  return amount > 0n ? { key, amountRaw: amount.toString(), minimumNativeRaw: null } : null;
}

export function evaluateExits(position: Position, quote: Quote): ExitDecision | null {
  const quantity = BigInt(position.remainingTokenRaw);
  if (
    quantity <= 0n ||
    quote.inputRaw !== quantity.toString() ||
    Date.now() - quote.receivedAt > 30_000
  )
    return null;
  const native = BigInt(quote.outputRaw);
  const profit = profitBps(native, quantity, position);
  position.lastProfitPercent = Number(profit) / 100;
  const settings = position.exits;
  if (
    settings.stopLoss.enabled &&
    settings.stopLoss.lossPercent !== null &&
    profit <= -bps(settings.stopLoss.lossPercent)
  )
    return { key: 'sl', amountRaw: quantity.toString(), minimumNativeRaw: null };
  const trailingSl = trailing(
    settings.trailingSl,
    position.trailingSl,
    'trail:sl',
    native,
    quantity,
    profit,
  );
  if (trailingSl) return trailingSl;
  if (settings.takeProfitEnabled) {
    for (const tier of [...settings.takeProfits].sort(
      (a, b) => a.profitPercent - b.profitPercent,
    )) {
      if (profit < bps(tier.profitPercent)) continue;
      const key = `tp:${tier.id}`;
      const target =
        tier.sellPercent === 'rest'
          ? quantity
          : (BigInt(position.originalTokenRaw) * bps(tier.sellPercent)) / 10_000n -
            BigInt(position.exitFills[key] ?? '0');
      const amount = target < quantity ? target : quantity;
      if (amount > 0n)
        return {
          key,
          amountRaw: amount.toString(),
          minimumNativeRaw: minimum(
            BigInt(position.entryNativeRaw),
            amount,
            BigInt(position.originalTokenRaw),
            tier.profitPercent,
          ),
        };
    }
  }
  return trailing(settings.trailingTp, position.trailingTp, 'trail:tp', native, quantity, profit);
}
