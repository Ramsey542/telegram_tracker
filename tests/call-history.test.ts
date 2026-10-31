import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallHistoryItem, ChannelPost } from '../src/domain.js';
import { Store } from '../src/infra/store.js';
import { parseCall } from '../src/telegram/parser.js';
import { recentCallMessage } from '../src/telegram/call-history.js';

const mint = 'So11111111111111111111111111111111111111112';
function post(): ChannelPost {
  return {
    channelId: '-1003923634690',
    messageId: 34300,
    date: 1793091600000,
    revision: 1,
    text: `@OnyxxGems just posted GROKLET at $405K marketcap.\nCA: ${mint}\nCaller Consistency:\nOverall: 44% | Recent: 35% | Chain: 43%\nTotal Calls For Project: 31`,
    urls: [`https://dexscreener.com/solana/${mint}`],
  };
}
function history(): CallHistoryItem {
  const source = post();
  const parsed = parseCall(source);
  if (!parsed.ok) throw new Error(parsed.reason);
  return {
    id: `${source.channelId}:${source.messageId}`,
    channelId: source.channelId,
    messageId: source.messageId,
    state: 'pending',
    reason: null,
    post: source,
    signal: parsed.signal,
    operation: null,
    observation: {
      decision: 'skipped',
      reason: 'listen_only',
      observedAt: source.date,
      thresholds: { overall: 30, recent: 30, chain: 30 },
    },
  };
}

test('recent calls show identity, all consistency rates, the recorded reason and a source link instead of the internal identifier', () => {
  const item = history();
  const result = recentCallMessage(item, 'SpyDefiLive', true);
  assert.match(result.text, /GROKLET/);
  assert.match(result.text, /@onyxxgems/i);
  assert.match(result.text, /Solana \(SOL\)/);
  assert.match(result.text, /Overall 44%.*Recent 35%.*Chain 43%/);
  assert.match(result.text, /Observed \(listen-only\)/);
  assert.match(result.text, /trading was disabled/);
  assert.ok(!result.text.includes(item.id));
  assert.ok(
    result.entities.some(
      (entity) => entity.type === 'text_link' && entity.url === 'https://t.me/SpyDefiLive/34300',
    ),
  );
});

test('unsupported-chain posts retain caller and token details even though trading parsing rejected them', () => {
  const item = history();
  item.post = {
    ...post(),
    text: post().text.replace(mint, '0x787873c9ae96855bdb032f6ff1ef76a5e1fc8adc'),
    urls: ['https://dexscreener.com/ethereum/0x787873c9ae96855bdb032f6ff1ef76a5e1fc8adc'],
  };
  item.signal = null;
  item.observation = null;
  item.state = 'skipped';
  item.reason = 'Unsupported chain: ethereum';
  const result = recentCallMessage(item, 'SpyDefiLive', true);
  assert.match(result.text, /GROKLET/);
  assert.match(result.text, /@OnyxxGems/);
  assert.match(result.text, /Ethereum \(unsupported\)/);
  assert.match(result.text, /Skipped/);
  assert.match(result.text, /Unsupported chain: ethereum/);
});

test('actual purchase outcomes take precedence over capture observations', () => {
  const item = history();
  item.state = 'claimed';
  item.operation = {
    status: 'confirmed',
    symbol: 'GROKLET',
    error: null,
    hash: 'confirmed-signature',
  };
  assert.match(recentCallMessage(item, 'SpyDefiLive', true).text, /Bought/);
  item.operation.status = 'failed';
  item.operation.error = 'Simulation rejected the swap';
  const failed = recentCallMessage(item, 'SpyDefiLive', true).text;
  assert.match(failed, /Buy failed/);
  assert.match(failed, /Simulation rejected the swap/);
});

test('filter rejection reasons use the threshold recorded when the call arrived', () => {
  const item = history();
  item.observation!.reason = 'recent consistency is below the threshold';
  item.observation!.thresholds!.recent = 40;
  const result = recentCallMessage(item, 'SpyDefiLive', true).text;
  assert.match(result, /Skipped/);
  assert.match(result, /Recent consistency 35% was below the 40% minimum at capture/);
});

test('an older queued record is not presented as an in-flight buy in listen-only mode', () => {
  const item = history();
  item.post = null;
  item.observation = null;
  const result = recentCallMessage(item, 'SpyDefiLive', true).text;
  assert.match(result, /Captured \(listen-only\)/);
  assert.match(result, /No buy has been submitted/);
  assert.ok(!result.includes('Trade in progress'));
});

test('migrating legacy history preserves the queue and backfills source details without reprocessing the call', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-call-history-'));
  let store: Store | null = null;
  const item = history();
  try {
    const legacy = new DatabaseSync(join(directory, 'tracker.sqlite'));
    legacy.exec(
      'CREATE TABLE signals (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id INTEGER NOT NULL, revision INTEGER NOT NULL, chain TEXT, state TEXT NOT NULL, reason TEXT, payload TEXT NOT NULL, received_at INTEGER NOT NULL); PRAGMA user_version = 1;',
    );
    legacy
      .prepare('INSERT INTO signals VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        item.id,
        item.channelId,
        item.messageId,
        1,
        'solana',
        'pending',
        null,
        JSON.stringify(item.signal),
        Date.now(),
      );
    legacy.close();
    store = new Store(directory);
    assert.equal(store.nextSignal('solana')?.id, item.id);
    assert.equal(store.signalHistory()[0]?.post, null);
    store.saveSourcePost({ ...post(), revision: 2 });
    assert.equal(store.signalHistory()[0]?.post, null);
    store.saveSourcePost(post());
    store.recordObservation(item.id, item.observation!);
    assert.equal(store.signalHistory()[0]?.post?.text, post().text);
    assert.equal(store.signalHistory()[0]?.observation?.reason, 'listen_only');
    assert.equal(store.nextSignal('solana')?.id, item.id);
    assert.equal(store.hasEntry('solana', mint), false);
    store.close();
    store = new Store(directory);
    assert.equal(store.signalHistory()[0]?.observation?.reason, 'listen_only');
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
