import { parseAmount, TradeRejected } from '../domain.js';

export function solanaPriorityLamports(priorityFee: string): number {
  const lamports = parseAmount(priorityFee, 9);
  if (lamports < 0n || lamports > BigInt(Number.MAX_SAFE_INTEGER))
    throw new TradeRejected('Solana priority fee is outside the supported range');
  return Number(lamports);
}
export function robinhoodGasFees(
  baseFee: bigint,
  priorityFee: string | null | undefined,
  automatic: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null,
): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const priority =
    priorityFee == null ? automatic?.maxPriorityFeePerGas : parseAmount(priorityFee, 9);
  if (priority === undefined)
    throw new TradeRejected('Robinhood priority fee estimate is unavailable');
  const minimumCap = baseFee * 2n + priority;
  const automaticCap = priorityFee == null ? (automatic?.maxFeePerGas ?? 0n) : 0n;
  return {
    maxPriorityFeePerGas: priority,
    maxFeePerGas: automaticCap > minimumCap ? automaticCap : minimumCap,
  };
}
