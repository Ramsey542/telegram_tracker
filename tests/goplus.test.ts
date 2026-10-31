import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GoPlusClient } from '../src/providers/goplus.js';
import { ApiError, HttpClient } from '../src/infra/http.js';
import { redact } from '../src/logging/redaction.js';

const address = '0x787873c9ae96855bdb032f6ff1ef76a5e1fc8adc';
const credentials = {
  goplusAppKey: 'test-app-key',
  goplusAppSecret: 'test-app-secret',
  goplusToken: '',
};
function harness(context: TestContext) {
  const grants: { app_key: string; time: number; sign: string }[] = [];
  const authorizations: (string | null)[] = [];
  let lifetime = 3600;
  let rejectToken = false;
  let authError: number | null = null;
  let securityError: number | null = null;
  let securityStatus = 200;
  let retryAfter: string | null = null;
  context.mock.method(
    globalThis,
    'fetch',
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      assert.ok(url.startsWith('https://api.gopluslabs.io/'));
      if (url === 'https://api.gopluslabs.io/api/v1/token') {
        grants.push(JSON.parse(String(init?.body)) as (typeof grants)[number]);
        if (authError !== null)
          return Response.json({ code: authError, message: null, result: null });
        return Response.json({
          code: 1,
          message: 'OK',
          result: { access_token: `issued-access-token-${grants.length}`, expires_in: lifetime },
        });
      }
      authorizations.push(new Headers(init?.headers).get('authorization'));
      if (rejectToken) {
        rejectToken = false;
        return Response.json({ code: 4023, message: 'Access token not found' });
      }
      if (securityError !== null || securityStatus !== 200)
        return Response.json(
          { code: securityError ?? 4029, message: 'Request rejected' },
          {
            status: securityStatus,
            headers: retryAfter === null ? {} : { 'Retry-After': retryAfter },
          },
        );
      const tokenAddress = new URL(url).searchParams.get('contract_addresses')!;
      return Response.json({
        code: 1,
        message: 'OK',
        result: {
          [tokenAddress]: { is_honeypot: '0', is_mintable: '0', buy_tax: '0', sell_tax: '0' },
        },
      });
    },
  );
  return {
    client: new GoPlusClient(credentials, new HttpClient(1000)),
    grants,
    authorizations,
    setLifetime(value: number) {
      lifetime = value;
    },
    rejectNextToken() {
      rejectToken = true;
    },
    setAuthError(value: number) {
      authError = value;
    },
    setSecurityError(value: number | null) {
      securityError = value;
    },
    setSecurityStatus(value: number, header: string | null = null) {
      securityStatus = value;
      retryAfter = header;
    },
  };
}

test('concurrent security checks share a report request and SHA1-authenticated access token', async (context) => {
  const { client, grants, authorizations } = harness(context);
  const results = await Promise.all([client.security(address), client.security(address)]);
  assert.equal(results[0]?.is_honeypot, '0');
  assert.equal(grants.length, 1);
  const grant = grants[0]!;
  assert.equal(grant.app_key, credentials.goplusAppKey);
  assert.equal(
    grant.sign,
    createHash('sha1')
      .update(`${credentials.goplusAppKey}${grant.time}${credentials.goplusAppSecret}`)
      .digest('hex'),
  );
  assert.deepEqual(authorizations, ['issued-access-token-1']);
});

test('access tokens are renewed after expiration', async (context) => {
  let now = 1_790_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const { client, grants, authorizations, setLifetime } = harness(context);
  setLifetime(10);
  await client.security(address);
  now += 31_000;
  await client.security(address);
  assert.equal(grants.length, 2);
  assert.deepEqual(authorizations, ['issued-access-token-1', 'issued-access-token-2']);
});

test('a rejected access token is refreshed once with a unique authentication timestamp', async (context) => {
  context.mock.method(Date, 'now', () => 1_790_000_000_000);
  const { client, grants, authorizations, rejectNextToken } = harness(context);
  rejectNextToken();
  await client.security(address);
  assert.equal(grants.length, 2);
  assert.ok(grants[1]!.time > grants[0]!.time);
  assert.deepEqual(authorizations, ['issued-access-token-1', 'issued-access-token-2']);
});

test('invalid app credentials fail with the provider code without making an anonymous security request', async (context) => {
  const { client, grants, authorizations, setAuthError } = harness(context);
  setAuthError(4010);
  await assert.rejects(
    client.security(address),
    (error: unknown) =>
      error instanceof ApiError &&
      error.details.code === 4010 &&
      error.message.includes('App key does not exist'),
  );
  assert.equal(grants.length, 1);
  assert.equal(authorizations.length, 0);
});

test('manual access tokens remain supported without an app credential exchange', async (context) => {
  const { grants, authorizations } = harness(context);
  const client = new GoPlusClient(
    { goplusAppKey: '', goplusAppSecret: '', goplusToken: 'manual-access-token' },
    new HttpClient(1000),
  );
  await client.security(address);
  assert.equal(grants.length, 0);
  assert.deepEqual(authorizations, ['manual-access-token']);
});

test('security reports are isolated by address, reused for 30 seconds and returned as independent values', async (context) => {
  let now = 1_790_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const { client, grants, authorizations } = harness(context);
  const first = await client.security(address);
  first.is_honeypot = '1';
  now += 29_999;
  const reused = await client.security(`0x${address.slice(2).toUpperCase()}`);
  assert.equal(reused.is_honeypot, '0');
  assert.equal(authorizations.length, 1);
  await client.security('0x1111111111111111111111111111111111111111');
  assert.equal(authorizations.length, 2);
  now += 1;
  await client.security(address);
  assert.equal(authorizations.length, 3);
  assert.equal(grants.length, 1);
});

test('failed refreshes never return an expired report or cache a provider failure', async (context) => {
  let now = 1_790_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const { client, authorizations, setSecurityError } = harness(context);
  await client.security(address);
  now += 30_000;
  setSecurityError(5000);
  await assert.rejects(
    client.security(address),
    (error: unknown) => error instanceof ApiError && error.details.code === 5000,
  );
  assert.equal(authorizations.length, 2);
  setSecurityError(null);
  assert.equal((await client.security(address)).is_honeypot, '0');
  assert.equal(authorizations.length, 3);
});

test('GoPlus quota errors pause new security requests across tokens for 60 seconds', async (context) => {
  let now = 1_790_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const { client, authorizations, grants, setSecurityError } = harness(context);
  setSecurityError(4029);
  await assert.rejects(
    client.security(address),
    (error: unknown) => error instanceof ApiError && error.details.retryAt === now + 60_000,
  );
  setSecurityError(null);
  await assert.rejects(
    client.security('0x1111111111111111111111111111111111111111'),
    /requests paused/,
  );
  now += 59_999;
  await assert.rejects(client.security(address), /requests paused/);
  assert.equal(authorizations.length, 1);
  assert.equal(grants.length, 1);
  now += 1;
  assert.equal((await client.security(address)).is_honeypot, '0');
  assert.equal(authorizations.length, 2);
});

test('HTTP 429 is not retried immediately and honors a longer Retry-After header', async (context) => {
  let now = 1_790_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const { client, authorizations, setSecurityStatus } = harness(context);
  setSecurityStatus(429, '120');
  await assert.rejects(
    client.security(address),
    (error: unknown) => error instanceof ApiError && error.details.retryAt === now + 120_000,
  );
  assert.equal(authorizations.length, 1);
  setSecurityStatus(200);
  now += 60_000;
  await assert.rejects(client.security(address), /requests paused/);
  assert.equal(authorizations.length, 1);
  now += 60_000;
  await client.security(address);
  assert.equal(authorizations.length, 2);
});

test('only unexpired reports remain usable during a provider cooldown', async (context) => {
  let now = 1_790_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const { client, authorizations, setSecurityError } = harness(context);
  await client.security(address);
  now += 1000;
  setSecurityError(4029);
  await assert.rejects(client.security('0x1111111111111111111111111111111111111111'));
  assert.equal((await client.security(address)).is_honeypot, '0');
  assert.equal(authorizations.length, 2);
  now += 29_000;
  await assert.rejects(client.security(address), /requests paused/);
  assert.equal(authorizations.length, 2);
});

test('authentication quota errors pause token issuance without anonymous security requests', async (context) => {
  let now = 1_790_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const { client, authorizations, grants, setAuthError } = harness(context);
  setAuthError(4029);
  await assert.rejects(
    client.security(address),
    (error: unknown) => error instanceof ApiError && error.details.code === 4029,
  );
  now += 10_000;
  await assert.rejects(client.security(address), /requests paused/);
  assert.equal(grants.length, 1);
  assert.equal(authorizations.length, 0);
});

test('app credentials, authentication signatures and access tokens are removed from diagnostic payloads', () => {
  const result = JSON.stringify(
    redact({
      app_key: 'sensitive-app-key',
      app_secret: 'sensitive-secret',
      sign: 'sensitive-auth-signature',
      result: { access_token: 'sensitive-token', expires_in: 3600 },
    }),
  );
  assert.ok(!result.includes('sensitive-'));
  assert.match(result, /3600/);
});
