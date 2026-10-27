import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { logger, type LogFields } from '../logging/logger.js';
import { redactText, safeEndpoint } from '../logging/redaction.js';

const log = logger.child({ component: 'api.http' });
export class ApiError extends Error {
  constructor(
    message: string,
    readonly details: LogFields,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}
export class HttpError extends ApiError {
  constructor(
    readonly service: string,
    readonly status: number,
    details: LogFields = {},
  ) {
    super(`${service} returned HTTP ${status}`, { service, status, ...details });
    this.name = 'HttpError';
  }
}
async function preview(response: Response): Promise<string> {
  const reader = response.clone().body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < 16_384) {
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks).toString('utf8');
      const chunk = next.value.subarray(0, 16_384 - bytes);
      chunks.push(chunk);
      bytes += chunk.byteLength;
    }
    return `${Buffer.concat(chunks).toString('utf8')}[response preview truncated]`;
  } finally {
    void reader
      .cancel()
      .catch((error: unknown) => log.debug('api.preview_cancel_failed', { error }));
  }
}
export class HttpClient {
  private readonly nextRequest = new Map<string, number>();
  private readonly responses = new WeakMap<Response, LogFields>();
  constructor(
    private readonly timeoutMs: number,
    private readonly jupiterRps = 1,
  ) {}
  async fetch(
    service: string,
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
    fields: LogFields = {},
    timeoutMs = this.timeoutMs,
  ): Promise<Response> {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    let requestBody: unknown = init?.body;
    if (typeof requestBody === 'string') {
      try {
        requestBody = JSON.parse(requestBody);
      } catch {
        requestBody = '[non-JSON request body]';
      }
    }
    const rpcMethod =
      requestBody && typeof requestBody === 'object' && 'method' in requestBody
        ? requestBody.method
        : undefined;
    const metadata = {
      ...fields,
      requestId: randomUUID(),
      service,
      endpoint: safeEndpoint(url),
      method:
        init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET'),
      rpcMethod,
    };
    const started = Date.now();
    log.debug('api.request', metadata);
    log.debug('api.request_payload', { ...metadata, body: requestBody });
    try {
      const signal = init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      const response = await fetch(input, { ...init, signal });
      const body = await preview(response);
      const details = {
        ...metadata,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - started,
        retryAfter: response.headers.get('retry-after'),
        providerRequestId:
          response.headers.get('x-request-id') ??
          response.headers.get('x-correlation-id') ??
          response.headers.get('cf-ray'),
      };
      this.responses.set(response, { ...details, responseBody: body });
      if (!response.ok)
        log.error(
          'api.http_failed',
          new HttpError(service, response.status, { ...details, responseBody: body }),
          details,
        );
      else {
        let rpcError: unknown;
        if (rpcMethod) {
          try {
            rpcError = (JSON.parse(body) as { error?: unknown }).error;
          } catch {
            rpcError = undefined;
          }
        }
        if (rpcError)
          log.error(
            'api.rpc_failed',
            new ApiError(`${service} RPC ${String(rpcMethod)} failed`, { ...details, rpcError }),
            details,
          );
        else log.debug('api.response', details);
        log.debug('api.response_payload', { ...details, responseBody: body });
      }
      return response;
    } catch (cause) {
      const error = new ApiError(
        `${service} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        metadata,
        { cause },
      );
      log.error('api.connection_failed', error, { ...metadata, durationMs: Date.now() - started });
      throw error;
    }
  }
  async json<T>(
    service: string,
    url: string,
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST';
      body?: unknown;
      headers?: Record<string, string>;
      retry?: boolean;
      timeoutMs?: number;
      beforeRequest?: () => void;
    } = {},
  ): Promise<T> {
    const tries = options.retry === false || options.method === 'POST' ? 1 : 3;
    for (let attempt = 0; attempt < tries; attempt++) {
      const endpoint = new URL(url);
      const hostname = endpoint.hostname;
      const rateKey =
        hostname === 'api.jup.ag' && endpoint.pathname === '/swap/v2/execute'
          ? `${hostname}/execute`
          : hostname;
      const gap =
        hostname === 'api.jup.ag'
          ? 1000 / this.jupiterRps
          : hostname === 'api.dexscreener.com'
            ? 210
            : hostname === 'api.rugcheck.xyz'
              ? 1000
              : 0;
      if (gap > 0) {
        const slot = Math.max(Date.now(), this.nextRequest.get(rateKey) ?? 0);
        this.nextRequest.set(rateKey, slot + gap);
        if (slot > Date.now()) {
          log.debug('api.rate_limit_wait', {
            service,
            endpoint: safeEndpoint(url),
            waitMs: slot - Date.now(),
          });
          await delay(Math.max(0, slot - Date.now()));
        }
      }
      options.beforeRequest?.();
      let response: Response;
      try {
        response = await this.fetch(
          service,
          url,
          {
            method: options.method ?? 'GET',
            headers: {
              Accept: 'application/json',
              ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
              ...options.headers,
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          },
          { attempt: attempt + 1, maxAttempts: tries },
          options.timeoutMs,
        );
      } catch (error) {
        if (attempt + 1 >= tries) throw error;
        const waitMs = 300 * 2 ** attempt;
        log.warn('api.retry_scheduled', {
          service,
          endpoint: safeEndpoint(url),
          attempt: attempt + 1,
          waitMs,
          error,
        });
        await delay(waitMs);
        continue;
      }
      if (!response.ok) {
        const details = this.responses.get(response) ?? { service, endpoint: safeEndpoint(url) };
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < tries) {
          const header = response.headers.get('retry-after');
          const seconds =
            header && /^\d+(\.\d+)?$/.test(header)
              ? Number(header)
              : header
                ? (Date.parse(header) - Date.now()) / 1000
                : 1;
          const waitMs = Number.isFinite(seconds)
            ? Math.max(0, Math.min(seconds, 10)) * 1000
            : 1000;
          log.warn('api.retry_scheduled', {
            ...details,
            status: response.status,
            attempt: attempt + 1,
            waitMs,
          });
          await delay(waitMs);
          continue;
        }
        throw new HttpError(service, response.status, details);
      }
      let data: unknown;
      try {
        data = await response.json();
      } catch (cause) {
        const error = new ApiError(
          `${service} returned invalid JSON`,
          this.responses.get(response) ?? {
            service,
            endpoint: safeEndpoint(url),
            status: response.status,
          },
          { cause },
        );
        log.error('api.invalid_json', error, this.responses.get(response));
        throw error;
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        const error = new ApiError(`${service} returned an unexpected response format`, {
          ...this.responses.get(response),
          service,
          endpoint: safeEndpoint(url),
          issues: parsed.error.issues,
          responseBody: data,
        });
        log.error('api.invalid_response', error, this.responses.get(response));
        throw error;
      }
      return parsed.data;
    }
    throw new Error(`${service} unavailable`);
  }
  async rpc<T>(
    service: string,
    url: string,
    method: string,
    params: unknown[],
    schema: z.ZodType<T>,
  ): Promise<T> {
    if (!url) throw new Error(`${service} endpoint is not configured`);
    const envelope = await this.json(
      service,
      url,
      z.object({
        result: z.unknown().optional(),
        error: z
          .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
          .optional(),
      }),
      { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, retry: false },
    );
    if (envelope.error)
      throw new ApiError(
        `${service} RPC ${method} failed (${envelope.error.code}): ${envelope.error.message}`,
        { service, endpoint: safeEndpoint(url), rpcMethod: method, rpcError: envelope.error },
      );
    const parsed = schema.safeParse(envelope.result);
    if (!parsed.success) {
      const error = new ApiError(`${service} RPC ${method} returned an unexpected result`, {
        service,
        endpoint: safeEndpoint(url),
        rpcMethod: method,
        issues: parsed.error.issues,
        responseBody: envelope.result,
      });
      log.error('api.invalid_rpc_result', error);
      throw error;
    }
    return parsed.data;
  }
}
export function safeError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : 'Unexpected operation failure').slice(
    0,
    400,
  );
}
