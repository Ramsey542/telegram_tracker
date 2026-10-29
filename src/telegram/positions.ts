import { formatAmount, nativeDecimals, nativeSymbol, type Position } from '../domain.js';
import { USD_SCALE } from '../pnl/accounting.js';
import type { PnlFill } from '../pnl/types.js';

function priceRatio(numerator: bigint, denominator: bigint): string {
  const whole = numerator / denominator;
  const decimals =
    whole > 0n
      ? Math.max(0, 8 - whole.toString().length)
      : 8 + Math.max(0, denominator.toString().length - numerator.toString().length);
  const scaled = (numerator * 10n ** BigInt(decimals) + denominator / 2n) / denominator;
  return formatAmount(scaled, decimals);
}

export function positionEntryPrice(position: Position, entry: PnlFill | null): string {
  const fill =
    entry?.positionId === position.id && entry.kind === 'buy' && entry.chain === position.chain
      ? entry
      : null;
  const cost =
    position.entrySwapNativeRaw ??
    fill?.swapNativeRaw ??
    (position.chain === 'robinhood'
      ? (BigInt(position.entryNativeRaw) - BigInt(position.entryFeeNativeRaw)).toString()
      : null);
  if (cost === null || BigInt(cost) <= 0n || BigInt(position.originalTokenRaw) <= 0n)
    return 'Unavailable';
  const numerator = BigInt(cost) * 10n ** BigInt(position.decimals);
  const denominator =
    BigInt(position.originalTokenRaw) * 10n ** BigInt(nativeDecimals[position.chain]);
  const native = `${priceRatio(numerator, denominator)} ${nativeSymbol[position.chain]}/token`;
  if (fill?.nativeUsd == null || !Number.isFinite(fill.nativeUsd) || fill.nativeUsd <= 0)
    return native;
  const rate = Math.round(fill.nativeUsd * Number(USD_SCALE));
  if (!Number.isSafeInteger(rate) || rate <= 0) return native;
  return `${native} (approximately $${priceRatio(numerator * BigInt(rate), denominator * USD_SCALE)}/token)`;
}
