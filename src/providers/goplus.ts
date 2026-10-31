import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import { ApiError, HttpClient, HttpError } from '../infra/http.js';
import { logger } from '../logging/logger.js';
import { registerSecrets } from '../logging/redaction.js';

const log = logger.child({ component: 'api.goplus', service: 'GoPlus' });
const envelopeSchema = z.object({
  code: z.number(),
  message: z.string().nullish(),
  result: z.unknown().optional(),
});
type Envelope = z.infer<typeof envelopeSchema>;
const statusMessages: Record<number, string> = {
  4010: 'App key does not exist',
  4011: 'Authentication signature expired or was already used',
  4012: 'Invalid authentication signature',
  4023: 'Access token not found',
  4029: 'Request limit reached',
};
const accessSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive().safe(),
});
const flag = z.string().optional();
const securitySchema = z.object({
  is_honeypot: flag,
  is_mintable: flag,
  is_blacklisted: flag,
  transfer_pausable: flag,
  is_proxy: flag,
  buy_tax: flag,
  sell_tax: flag,
});
const reportsSchema = z.record(z.string(), securitySchema);
type SecurityReport = z.infer<typeof securitySchema>;
const reportLifetimeMs = 30_000;
const rateLimitCooldownMs = 60_000;

export class GoPlusClient {
  private cached: { token: string; refreshAt: number } | null = null;
  private issuing: Promise<string> | null = null;
  private lastTimestamp = 0;
  private cooldownUntil = 0;
  private readonly reports = new Map<string, { report: SecurityReport; fetchedAt: number }>();
  private readonly pendingReports = new Map<string, Promise<SecurityReport>>();
  private readonly appKey: string;
  private readonly appSecret: string;
  constructor(
    private readonly config: Pick<Config, 'goplusAppKey' | 'goplusAppSecret' | 'goplusToken'>,
    private readonly http: HttpClient,
  ) {
    this.appKey = config.goplusAppKey ?? '';
    this.appSecret = config.goplusAppSecret ?? '';
    if (Boolean(this.appKey) !== Boolean(this.appSecret))
      throw new Error('Set both GOPLUS_APP_KEY and GOPLUS_APP_SECRET');
    registerSecrets([this.appKey, this.appSecret, config.goplusToken ?? ''].filter(Boolean));
  }
  private failure(endpoint: string, response: Envelope): ApiError {
    const error = new ApiError(
      `GoPlus returned code ${response.code}: ${response.message?.trim() || statusMessages[response.code] || 'Request failed'}`,
      { service: 'GoPlus', endpoint, code: response.code, responseBody: response },
    );
    if (response.code === 4029) this.deferRequests(error);
    log.error('api.provider_failed', error, { endpoint, code: response.code });
    return error;
  }
  private deferRequests(error: ApiError): void {
    const now = Date.now();
    const retryAfter = error.details.retryAfter;
    const value = typeof retryAfter === 'string' ? retryAfter.trim() : '';
    const providerRetryAt = /^\d+(?:\.\d+)?$/.test(value)
      ? now + Number(value) * 1000
      : Date.parse(value);
    this.cooldownUntil = Math.max(
      this.cooldownUntil,
      now + rateLimitCooldownMs,
      Number.isFinite(providerRetryAt) ? providerRetryAt : 0,
    );
    error.details.retryAt = this.cooldownUntil;
    log.warn('goplus.cooldown_started', {
      endpoint: error.details.endpoint,
      status: error.details.status,
      code: error.details.code,
      retryAt: this.cooldownUntil,
      cooldownMs: this.cooldownUntil - now,
    });
  }
  private async request(
    service: string,
    endpoint: string,
    options: { method?: 'GET' | 'POST'; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Envelope> {
    if (Date.now() < this.cooldownUntil)
      throw new ApiError(
        `GoPlus requests paused after rate limiting; retry in ${Math.ceil((this.cooldownUntil - Date.now()) / 1000)} seconds`,
        { service, endpoint, code: 4029, retryAt: this.cooldownUntil },
      );
    let response: Envelope;
    try {
      response = await this.http.json(service, endpoint, envelopeSchema, {
        ...options,
        retry: false,
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 429) this.deferRequests(error);
      throw error;
    }
    if (response.code === 4029) throw this.failure(endpoint, response);
    return response;
  }
  private async issueToken(): Promise<string> {
    const endpoint = 'https://api.gopluslabs.io/api/v1/token';
    const time = Math.max(Math.floor(Date.now() / 1000), this.lastTimestamp + 1);
    this.lastTimestamp = time;
    const sign = createHash('sha1').update(`${this.appKey}${time}${this.appSecret}`).digest('hex');
    registerSecrets([sign]);
    const response = await this.request('GoPlus authentication', endpoint, {
      method: 'POST',
      body: { app_key: this.appKey, time, sign },
    });
    if (response.code !== 1) throw this.failure(endpoint, response);
    const parsed = accessSchema.safeParse(response.result);
    if (!parsed.success) {
      const error = new ApiError('GoPlus authentication returned an invalid token or expiration', {
        service: 'GoPlus authentication',
        endpoint,
        issues: parsed.error.issues,
        responseBody: response,
      });
      log.error('api.invalid_auth_response', error);
      throw error;
    }
    const { access_token: token, expires_in: lifetime } = parsed.data;
    registerSecrets([token]);
    const margin = Math.min(60, Math.floor(lifetime / 10));
    this.cached = { token, refreshAt: Date.now() + (lifetime - margin) * 1000 };
    log.debug('goplus.token_refreshed', { expiresInSeconds: lifetime });
    return token;
  }
  private async token(): Promise<string> {
    if (!this.appKey) {
      const token = (this.config.goplusToken ?? '').replace(/^Bearer\s+/i, '').trim();
      registerSecrets([token]);
      return token;
    }
    if (this.cached && this.cached.refreshAt > Date.now()) return this.cached.token;
    if (!this.issuing)
      this.issuing = this.issueToken().finally(() => {
        this.issuing = null;
      });
    return this.issuing;
  }
  private invalidate(token: string): void {
    if (this.cached?.token === token) this.cached = null;
  }
  async security(address: string): Promise<SecurityReport> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address))
      throw new Error('GoPlus requires a valid Robinhood token address');
    address = address.toLowerCase();
    const now = Date.now();
    for (const [token, saved] of this.reports)
      if (now - saved.fetchedAt >= reportLifetimeMs) this.reports.delete(token);
    const saved = this.reports.get(address);
    if (saved) {
      log.info('goplus.report_reused', {
        token: address,
        networkRequest: false,
        ageMs: now - saved.fetchedAt,
        validForMs: reportLifetimeMs - (now - saved.fetchedAt),
      });
      return structuredClone(saved.report);
    }
    let pending = this.pendingReports.get(address);
    if (!pending) {
      pending = this.fetchSecurity(address)
        .then((report) => {
          this.reports.set(address, { report, fetchedAt: Date.now() });
          log.info('goplus.report_received', {
            token: address,
            networkRequest: true,
            validForMs: reportLifetimeMs,
          });
          return report;
        })
        .finally(() => this.pendingReports.delete(address));
      this.pendingReports.set(address, pending);
    }
    return structuredClone(await pending);
  }
  private async fetchSecurity(address: string): Promise<SecurityReport> {
    const endpoint = `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${address}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token();
      let response: Envelope;
      try {
        response = await this.request('GoPlus token security', endpoint, {
          headers: token ? { Authorization: token } : {},
        });
      } catch (error) {
        if (this.appKey && attempt === 0 && error instanceof HttpError && error.status === 401) {
          this.invalidate(token);
          continue;
        }
        throw error;
      }
      if (response.code === 4023 && this.appKey && attempt === 0) {
        log.warn('goplus.token_rejected', {
          endpoint,
          code: response.code,
          message: response.message,
          action: 'refresh_and_retry_once',
        });
        this.invalidate(token);
        continue;
      }
      if (response.code !== 1) throw this.failure(endpoint, response);
      const reports = reportsSchema.safeParse(response.result);
      if (!reports.success) {
        const error = new ApiError('GoPlus security response is incomplete', {
          service: 'GoPlus token security',
          endpoint,
          issues: reports.error.issues,
          responseBody: response,
        });
        log.error('api.invalid_security_response', error);
        throw error;
      }
      const report = reports.data[address.toLowerCase()];
      if (!report)
        throw new ApiError('GoPlus has no analysis for this token', {
          service: 'GoPlus token security',
          endpoint,
          token: address,
        });
      return report;
    }
    throw new Error('GoPlus authentication could not be refreshed');
  }
}
