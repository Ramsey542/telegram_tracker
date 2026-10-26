import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
  ) {
    super(`${service} returned HTTP ${status}`);
  }
}
export class HttpClient {
  private readonly nextRequest = new Map<string, number>();
  constructor(
    private readonly timeoutMs: number,
    private readonly jupiterRps = 1,
  ) {}
  async json<T>(
    service: string,
    url: string,
    schema: z.ZodType<T>,
    options: {
      method?: 'GET' | 'POST';
      body?: unknown;
      headers?: Record<string, string>;
      retry?: boolean;
    } = {},
  ): Promise<T> {
    const tries = options.retry === false || options.method === 'POST' ? 1 : 3;
    for (let attempt = 0; attempt < tries; attempt++) {
      const hostname = new URL(url).hostname;
      const gap =
        hostname === 'api.jup.ag'
          ? 1000 / this.jupiterRps
          : hostname === 'api.dexscreener.com'
            ? 210
            : hostname === 'api.rugcheck.xyz'
              ? 1000
              : 0;
      if (gap > 0) {
        const slot = Math.max(Date.now(), this.nextRequest.get(hostname) ?? 0);
        this.nextRequest.set(hostname, slot + gap);
        if (slot > Date.now()) await delay(slot - Date.now());
      }
      let response: Response;
      try {
        response = await fetch(url, {
          method: options.method ?? 'GET',
          headers: {
            Accept: 'application/json',
            ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...options.headers,
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt + 1 < tries) {
          await delay(300 * 2 ** attempt);
          continue;
        }
        throw new Error(`${service} request timed out or could not connect`);
      }
      if (!response.ok) {
        await response.body?.cancel();
        if ((response.status === 429 || response.status >= 500) && attempt + 1 < tries) {
          await delay(Math.min(Number(response.headers.get('retry-after') ?? 1), 10) * 1000);
          continue;
        }
        throw new HttpError(service, response.status);
      }
      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) throw new Error(`${service} returned an unexpected response format`);
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
        error: z.object({ code: z.number(), message: z.string() }).optional(),
      }),
      { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params }, retry: false },
    );
    if (envelope.error) throw new Error(`${service} RPC ${method} failed (${envelope.error.code})`);
    return schema.parse(envelope.result);
  }
}
export function safeError(error: unknown): string {
  if (!(error instanceof Error)) return 'Unexpected operation failure';
  return error.message
    .replace(/https?:\/\/\S+/gi, '[endpoint]')
    .replace(/\b(?:jup_|sk-)[A-Za-z0-9_-]+/g, '[credential]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]+/g, '[credential]')
    .slice(0, 400);
}
