import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbortController } from 'abort-controller';
import type { ApiCallFn } from 'grammy';
import type { TelegramClient } from 'teleproto';
import type { NewMessageEvent } from 'teleproto/events';
import { channelEvents } from '../src/telegram/channel-events.js';
import { telegramApiLogging, telegramTiming } from '../src/telegram/control-api.js';
import { configureLogging } from '../src/logging/logger.js';

function capture() {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-transport-'));
  const restore = configureLogging({
    directory,
    level: 'debug',
    console: false,
    maxFileBytes: 1024 * 1024,
    maxFiles: 1,
  });
  return {
    read(name: string): { event: string; [key: string]: unknown }[] {
      const path = join(directory, `${name}.jsonl`);
      return existsSync(path)
        ? readFileSync(path, 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [];
    },
    close() {
      restore();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const response = (value: unknown): ApiCallFn => (async () => value) as ApiCallFn;

test('new and edited channel subscriptions resolve numeric IDs without entity lookups and reject other chats', async () => {
  const channelId = '-1003923634690';
  const client = {
    getInputEntity: async () =>
      assert.fail('Numeric event filters must not resolve an object or username'),
  } as unknown as TelegramClient;
  for (const builder of channelEvents(channelId)) {
    await builder.resolve(client);
    assert.equal(builder.resolved, true);
    const matching = {
      chatId: { toString: () => channelId },
      message: {},
    } as unknown as NewMessageEvent;
    const other = {
      chatId: { toString: () => '-1001234567890' },
      message: {},
    } as unknown as NewMessageEvent;
    assert.equal(builder.filter(matching), matching);
    assert.equal(builder.filter(other), undefined);
  }
});

test('long polling fits within the configured Telegram request deadline', () => {
  assert.deepEqual(telegramTiming(15_000), {
    requestTimeoutSeconds: 15,
    pollingTimeoutSeconds: 10,
  });
  for (const timeoutMs of [3000, 3500, 5000, 15000, 120000]) {
    const timing = telegramTiming(timeoutMs);
    assert.equal(timing.requestTimeoutSeconds * 1000, timeoutMs);
    assert.ok(timing.pollingTimeoutSeconds >= 1);
    assert.ok(timing.pollingTimeoutSeconds < timing.requestTimeoutSeconds);
  }
});

test('repeated gateway failures log one outage and the successful poll logs one recovery', async () => {
  const logs = capture();
  const transform = telegramApiLogging(15_000, () => false);
  try {
    const failure = { ok: false, error_code: 502, description: 'Bad Gateway' };
    await transform(response(failure), 'getUpdates', {});
    await transform(response(failure), 'getUpdates', {});
    await transform(response({ ok: true, result: { id: 1 } }), 'getMe', {});
    assert.equal(
      logs.read('telegram').filter((row) => row.event === 'control.polling_recovered').length,
      0,
    );
    await transform(response({ ok: true, result: [{ update_id: 42 }] }), 'getUpdates', {});
    await transform(response({ ok: true, result: [] }), 'getUpdates', {});
    const records = logs.read('telegram');
    assert.equal(records.filter((row) => row.event === 'control.polling_unavailable').length, 1);
    const recovered = records.filter((row) => row.event === 'control.polling_recovered');
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.failedRequests, 2);
    assert.equal(recovered[0]?.updateCount, 1);
    assert.equal(logs.read('api').filter((row) => row.event === 'api.telegram_failed').length, 2);
    assert.deepEqual(logs.read('trades'), []);
  } finally {
    logs.close();
  }
});

test('request exceptions remain visible and a subsequent successful poll reports recovery', async () => {
  const logs = capture();
  const transform = telegramApiLogging(15_000, () => false);
  const timeout = new Error('Telegram request timed out');
  try {
    await assert.rejects(
      transform(
        async () => {
          throw timeout;
        },
        'getUpdates',
        {},
      ),
      (error) => error === timeout,
    );
    await transform(response({ ok: true, result: [] }), 'getUpdates', {});
    assert.equal(
      logs.read('telegram').filter((row) => row.event === 'control.polling_recovered').length,
      1,
    );
    assert.ok(JSON.stringify(logs.read('errors')).includes('Telegram request timed out'));
  } finally {
    logs.close();
  }
});

test('normal shutdown cancellation is not logged as a Telegram outage', async () => {
  const logs = capture();
  const transform = telegramApiLogging(15_000, () => true);
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      transform(
        async () => {
          throw new Error('Request aborted');
        },
        'getUpdates',
        {},
        controller.signal,
      ),
    );
    assert.equal(logs.read('errors').length, 0);
    assert.equal(logs.read('telegram').length, 0);
    assert.equal(
      logs.read('api').filter((row) => row.event === 'api.telegram_cancelled').length,
      1,
    );
  } finally {
    logs.close();
  }
});

test('failed reply requests are not retried by logging or treated as a polling outage', async () => {
  const logs = capture();
  const transform = telegramApiLogging(15_000, () => false);
  let requests = 0;
  const prev = (async () => {
    requests++;
    return { ok: false, error_code: 503, description: 'Unavailable' };
  }) as ApiCallFn;
  try {
    const result = await transform(prev, 'sendMessage', { chat_id: 1, text: 'Offline test' });
    assert.equal(result.ok, false);
    assert.equal(requests, 1);
    assert.equal(logs.read('telegram').length, 0);
    assert.equal(logs.read('api').filter((row) => row.event === 'api.telegram_failed').length, 1);
  } finally {
    logs.close();
  }
});
