import type { CallSignal, ChannelPost, Operation } from '../domain.js';
import { logger, type LogFields } from './logger.js';

const log = logger.child({ component: 'trading.journal' });
const iso = (time: number | undefined | null): string | null =>
  typeof time === 'number' && Number.isFinite(time) ? new Date(time).toISOString() : null;
const elapsed = (
  start: number | undefined | null,
  end: number | undefined | null,
): number | null =>
  typeof start === 'number' && typeof end === 'number' ? Math.max(0, end - start) : null;

export function logSignalDetected(signal: CallSignal, post: ChannelPost): void {
  log.info('signal.detected', {
    signalId: signal.id,
    channelId: signal.channelId,
    messageId: signal.messageId,
    chain: signal.chain,
    token: signal.address,
    symbol: signal.tokenName ?? null,
    caller: signal.caller,
    senderId: signal.senderId ?? null,
    senderUsername: signal.senderUsername ?? null,
    source: signal.sourceName ?? null,
    sourceMode: signal.mode ?? 'spydefi',
    detectedAt: iso(signal.detectedAt),
    publishedAt: iso(signal.date),
    revision: post.revision,
    consistency: signal.consistency,
    firstCaller: signal.mode === 'general' ? null : (signal.firstCaller ?? false),
    justLaunched: signal.mode === 'general' ? null : (signal.justLaunched ?? false),
    advertisedMarketCapUsd: signal.advertisedMarketCapUsd,
    message: post.text,
  });
}

export function logSignalSkipped(signal: CallSignal, reason: string): void {
  const completedAt = Date.now();
  log.info('trade.skipped', {
    signalId: signal.id,
    chain: signal.chain,
    token: signal.address,
    caller: signal.caller,
    reason,
    detectedAt: iso(signal.detectedAt),
    completedAt: iso(completedAt),
    detectionToDecisionMs: elapsed(signal.detectedAt, completedAt),
  });
}

export function logTradeOutcome(operation: Operation, fields: LogFields = {}): void {
  const completedAt = Date.now();
  const step =
    operation.steps.find((candidate) => candidate.key === 'swap') ?? operation.steps.at(-1);
  const submittedAt = step?.submittedAt;
  const detectedAt = operation.signal?.detectedAt;
  const confirmed = operation.status === 'confirmed';
  log.info(confirmed ? 'trade.confirmed' : 'trade.failed', {
    signalId: operation.signal?.id ?? null,
    operationId: operation.id,
    positionId: operation.positionId,
    chain: operation.chain,
    token: operation.address,
    symbol: operation.token.symbol,
    caller: operation.signal?.caller ?? null,
    senderId: operation.signal?.senderId ?? null,
    senderUsername: operation.signal?.senderUsername ?? null,
    kind: operation.kind,
    venue:
      operation.directEvmPlan?.venue ??
      operation.steps.find((step) => step.type === 'solana')?.venue ??
      null,
    status: operation.status,
    signature: operation.swapHash,
    reason: confirmed ? operation.exitKey : operation.error,
    ...fields,
    detectedAt: iso(detectedAt),
    submittedAt: iso(submittedAt),
    completedAt: iso(completedAt),
    confirmedAt: confirmed ? iso(completedAt) : null,
    detectionToSubmissionMs: elapsed(detectedAt, submittedAt),
    detectionToConfirmationMs: confirmed ? elapsed(detectedAt, completedAt) : null,
    detectionToDecisionMs: elapsed(detectedAt, completedAt),
    executionMs: elapsed(submittedAt, completedAt),
    operationDurationMs: elapsed(operation.createdAt, completedAt),
  });
}
