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
      return Response.json({
        code: 1,
        message: 'OK',
        result: { [address]: { is_honeypot: '0', is_mintable: '0', buy_tax: '0', sell_tax: '0' } },
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
  };
}

test('app credentials are exchanged using GoPlus SHA1 signing and a shared cached raw authorization token', async (context) => {
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
  assert.deepEqual(authorizations, ['issued-access-token-1', 'issued-access-token-1']);
});

test('access tokens are renewed after expiration', async (context) => {
  let now = 1_790_000_000_000;
  context.mock.method(Date, 'now', () => now);
  const { client, grants, authorizations, setLifetime } = harness(context);
  setLifetime(10);
  await client.security(address);
  now += 11_000;
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
