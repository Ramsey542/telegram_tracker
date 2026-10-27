import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { configureLogging, logger, withLogContext, type LogLevel } from '../src/logging/logger.js';
import { redact, registerSecrets } from '../src/logging/redaction.js';
import { ApiError, HttpClient, HttpError } from '../src/infra/http.js';

function capture(level: LogLevel = 'debug') {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-logging-'));
  const restore = configureLogging({
    directory,
    level,
    console: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 2,
  });
  return {
    directory,
    read: (name: string) => readFileSync(join(directory, `${name}.jsonl`), 'utf8'),
    close: () => {
      restore();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('redaction preserves API diagnostics and public identifiers while removing credentials and signed payloads', () => {
  const credential = 'example-secret-credential-for-test';
  const payload = 'A'.repeat(200);
  registerSecrets([credential]);
  const error = new ApiError(
    'HTTP 401 unauthorized',
    {
      service: 'QuickNode Solana RPC',
      rpcMethod: 'sendTransaction',
      endpoint: 'https://test.quiknode.pro/private-rpc-key/',
      body: JSON.stringify({ method: 'sendTransaction', params: [payload] }),
      authorization: `Bearer ${credential}`,
      status: 401,
    },
    { cause: new Error(`Provider refused ${credential}`) },
  );
  const output = JSON.stringify(
    redact({
      error,
      mint: 'So11111111111111111111111111111111111111112',
      signature: '5'.repeat(88),
    }),
  );
  assert.match(output, /HTTP 401 unauthorized/);
  assert.match(output, /QuickNode Solana RPC/);
  assert.match(output, /test.quiknode.pro/);
  assert.match(output, /So11111111111111111111111111111111111111112/);
  assert.ok(output.includes('5'.repeat(88)));
  assert.ok(!output.includes(credential));
  assert.ok(!output.includes('private-rpc-key'));
  assert.ok(!output.includes(payload));
});

test('JSON logs retain asynchronous correlation, error causes and category files', async () => {
  const logs = capture();
  try {
    await Promise.all(
      ['first', 'second'].map((signalId) =>
        withLogContext({ signalId }, async () => {
          await Promise.resolve();
          logger
            .child({ component: 'trading.entries' })
            .info('entry.observed', { token: signalId });
        }),
      ),
    );
    logger
      .child({ component: 'api.http', service: 'Jupiter quote' })
      .error(
        'api.http_failed',
        new Error('HTTP 429 rate limit', { cause: new Error('quota exceeded') }),
      );
    const trades = logs
      .read('trades')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(trades.length, 3);
    const entries = trades.filter((record) => record.event === 'entry.observed');
    assert.equal(entries.length, 2);
    for (const record of entries) assert.equal(record.signalId, record.token);
    assert.match(logs.read('trades'), /quota exceeded/);
    assert.match(logs.read('errors'), /quota exceeded/);
    assert.match(logs.read('api'), /HTTP 429 rate limit/);
    assert.match(logs.read('app'), /entry.observed/);
  } finally {
    logs.close();
  }
});

test('info logging keeps successful provider requests quiet and retains exact provider failures in trade logs', async (context) => {
  const logs = capture('info');
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () =>
    ++requests === 1
      ? Response.json({ amount: '42' })
      : Response.json({ error: 'Unauthorized API key', code: 'INVALID_KEY' }, { status: 401 }),
  );
  try {
    const client = new HttpClient(1000);
    await client.json(
      'Jupiter quote',
      'https://example.invalid/quote',
      z.object({ amount: z.string() }),
    );
    assert.equal(existsSync(join(logs.directory, 'app.jsonl')), false);
    await assert.rejects(
      client.json(
        'Jupiter quote',
        'https://example.invalid/quote',
        z.object({ amount: z.string() }),
      ),
      HttpError,
    );
    const trades = logs.read('trades');
    assert.match(trades, /Jupiter quote/);
    assert.match(trades, /INVALID_KEY/);
    assert.match(trades, /401/);
    assert.ok(!trades.includes('"event":"api.request"'));
    assert.ok(!trades.includes('"event":"api.response"'));
  } finally {
    logs.close();
  }
});

test('rotation retains the configured backup count', () => {
  const logs = capture();
  const restore = configureLogging({
    directory: logs.directory,
    level: 'info',
    console: false,
    maxFileBytes: 1,
    maxFiles: 2,
  });
  try {
    for (let index = 0; index < 5; index++) logger.info('rotation.test', { index });
    assert.equal(existsSync(join(logs.directory, 'app.jsonl.1')), true);
    assert.equal(existsSync(join(logs.directory, 'app.jsonl.2')), true);
    assert.equal(existsSync(join(logs.directory, 'app.jsonl.3')), false);
    assert.match(logs.read('app'), /"index":4/);
  } finally {
    restore();
    logs.close();
  }
});

test('HTTP authorization failures retain the exact service, response, endpoint and request ID', async (context) => {
  const logs = capture();
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json(
      { error: 'API key is unauthorized', code: 'INVALID_KEY' },
      { status: 401 },
    );
  });
  try {
    await assert.rejects(
      new HttpClient(1000).json(
        'Jupiter quote',
        'https://example.invalid/quote',
        z.object({ amount: z.string() }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof HttpError);
        assert.equal(error.status, 401);
        assert.equal(error.service, 'Jupiter quote');
        assert.equal(typeof error.details.requestId, 'string');
        return true;
      },
    );
    assert.equal(requests, 1);
    const errors = logs.read('errors');
    assert.match(errors, /INVALID_KEY/);
    assert.match(errors, /example.invalid\/quote/);
    assert.match(errors, /Jupiter quote/);
  } finally {
    logs.close();
  }
});

test('read requests log rate limiting, retry and subsequent success', async (context) => {
  const logs = capture();
  let requests = 0;
  context.mock.method(globalThis, 'fetch', async () =>
    ++requests === 1
      ? Response.json(
          { message: 'Quota exceeded' },
          { status: 429, headers: { 'retry-after': '0' } },
        )
      : Response.json({ amount: '42' }),
  );
  try {
    assert.deepEqual(
      await new HttpClient(1000).json(
        'Test provider',
        'https://example.invalid/data',
        z.object({ amount: z.string() }),
      ),
      { amount: '42' },
    );
    assert.equal(requests, 2);
    assert.match(logs.read('api'), /api.retry_scheduled/);
    assert.match(logs.read('api'), /api.response/);
    assert.match(logs.read('errors'), /Quota exceeded/);
  } finally {
    logs.close();
  }
});

test('signed RPC writes are never automatically retried and their payload is absent from debug logs', async (context) => {
  const logs = capture();
  let requests = 0;
  const signed = 'sensitive-signed-payload-for-test';
  context.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return Response.json({ message: 'Unavailable' }, { status: 503 });
  });
  try {
    await assert.rejects(
      new HttpClient(1000).rpc(
        'QuickNode Solana RPC',
        'https://example.invalid/rpc',
        'sendTransaction',
        [signed],
        z.string(),
      ),
    );
    assert.equal(requests, 1);
    assert.ok(!logs.read('app').includes(signed));
  } finally {
    logs.close();
  }
});

test('HTTP 200 RPC errors preserve provider code, message and data', async (context) => {
  const logs = capture();
  context.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      jsonrpc: '2.0',
      error: { code: -32005, message: 'Node is behind', data: { slotsBehind: 23 } },
      id: 1,
    }),
  );
  try {
    await assert.rejects(
      new HttpClient(1000).rpc(
        'QuickNode Solana RPC',
        'https://example.invalid/rpc',
        'getBalance',
        [],
        z.number(),
      ),
      /-32005.*Node is behind/,
    );
    assert.match(logs.read('errors'), /slotsBehind/);
    assert.match(logs.read('errors'), /getBalance/);
  } finally {
    logs.close();
  }
});
