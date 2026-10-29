import { randomUUID } from 'node:crypto';
import type { Transformer } from 'grammy';
import { logger, type LogFields } from '../logging/logger.js';

const apiLog = logger.child({ component: 'api.telegram', service: 'Telegram Bot API' });
const controlLog = logger.child({ component: 'telegram.control', service: 'Telegram Bot API' });

export function telegramTiming(timeoutMs: number): {
  requestTimeoutSeconds: number;
  pollingTimeoutSeconds: number;
} {
  const requestTimeoutSeconds = timeoutMs / 1000;
  return {
    requestTimeoutSeconds,
    pollingTimeoutSeconds: Math.max(1, Math.min(10, Math.floor(requestTimeoutSeconds) - 5)),
  };
}

export function telegramApiLogging(timeoutMs: number, stopping: () => boolean): Transformer {
  let outage: { startedAt: number; failures: number } | null = null;
  const failed = (error: unknown, fields: LogFields): void => {
    if (fields.apiMethod !== 'getUpdates' || stopping()) return;
    const firstFailure = outage === null;
    outage ??= { startedAt: Date.now(), failures: 0 };
    outage.failures++;
    if (firstFailure)
      controlLog.warn('control.polling_unavailable', {
        ...fields,
        requestTimeoutMs: timeoutMs,
        reason: 'getUpdates_failed',
        error,
      });
  };
  return async (prev, method, payload, signal) => {
    const fields = { apiMethod: method, requestId: randomUUID() };
    const started = Date.now();
    apiLog.debug('api.request', fields);
    try {
      const response = await prev(method, payload, signal);
      const details = { ...fields, durationMs: Date.now() - started };
      if (!response.ok) {
        apiLog.error('api.telegram_failed', response, details);
        failed(response, details);
      } else {
        const updateCount =
          method === 'getUpdates' && Array.isArray(response.result)
            ? response.result.length
            : undefined;
        apiLog.debug('api.response', { ...details, updateCount });
        if (method === 'getUpdates' && outage !== null) {
          if (!stopping())
            controlLog.info('control.polling_recovered', {
              ...details,
              outageDurationMs: Date.now() - outage.startedAt,
              failedRequests: outage.failures,
              updateCount,
            });
          outage = null;
        }
      }
      return response;
    } catch (error) {
      const details = { ...fields, durationMs: Date.now() - started };
      if (stopping() && signal?.aborted) apiLog.debug('api.telegram_cancelled', details);
      else {
        apiLog.error('api.telegram_failed', error, details);
        failed(error, details);
      }
      throw error;
    }
  };
}
