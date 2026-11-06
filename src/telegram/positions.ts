import { formatAmount, nativeDecimals, nativeSymbol, type Position } from '../domain.js';
import { USD_SCALE } from '../pnl/accounting.js';
import type { PnlFill } from '../pnl/types.js';
import { InlineKeyboard } from 'grammy';

export function positionPage(positions: Position[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(positions.length / 10));
  const page = Math.min(
    Math.max(0, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0),
    pages - 1,
  );
  const visible = positions.slice(page * 10, page * 10 + 10);
  const keyboard = new InlineKeyboard();
  visible.forEach((position, index) => {
    const symbol = Array.from(position.symbol.replace(/[\x00-\x1f\x7f]/g, ' '))
      .slice(0, 18)
      .join('');
    const pnl =
      position.lastProfitPercent === null
        ? '--'
        : `${position.lastProfitPercent >= 0 ? '+' : ''}${position.lastProfitPercent.toFixed(1)}%`;
    keyboard.text(
      `🪙 ${symbol} (${nativeSymbol[position.chain]}) ${pnl}`,
      `position:${position.id}:${page}`,
    );
    if (index % 2 === 1) keyboard.row();
  });
  keyboard.row();
  if (page > 0) keyboard.text('⬅️ Previous', `positions:${page - 1}`);
  if (page + 1 < pages) keyboard.text('➡️ Next', `positions:${page + 1}`);
  keyboard.row().text('🔄 Refresh PNL', `positionsrefresh:${page}`).row().text('⬅️ Back', 'home');
  return { visible, page, pages, keyboard };
}

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
    (position.chain !== 'solana'
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

export function positionEntryMarketCap(
  snapshot: { value: number; afterBuy: boolean } | null,
): string {
  if (!snapshot || !Number.isFinite(snapshot.value) || snapshot.value <= 0) return 'Unavailable';
  return `${snapshot.afterBuy ? '~' : ''}${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(snapshot.value)}`;
}
