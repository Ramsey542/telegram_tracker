import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { logger } from '../logging/logger.js';
import { logSignalDetected, logSignalSkipped, logTradeOutcome } from '../logging/trades.js';
import { pnlFill, USD_CAPTURE_WINDOW_MS } from '../pnl/accounting.js';
import type { PnlFill, PnlMark } from '../pnl/types.js';
import { exitReasonLabel } from '../trading/exit-reason.js';
import {
  chainSettingsSchema,
  chains,
  chainLabel,
  exitSchema,
  channelRulesSchema,
  senderFilterSchema,
  settingsSchema,
  emptyTrail,
  formatAmount,
  nativeDecimals,
  nativeSymbol,
  normalizeAddress,
  type CallSignal,
  type CallObservation,
  type CallHistoryItem,
  type Chain,
  type ChannelPost,
  type Operation,
  type Position,
  type Settings,
  type SwapResult,
  type CallChannel,
  type ChainSettings,
} from '../domain.js';

type Row = Record<string, unknown>;
const decode = <T>(row: Row | undefined, key = 'payload'): T | null =>
  row && typeof row[key] === 'string' ? (JSON.parse(row[key]) as T) : null;
const decodeOperation = (row: Row | undefined, key = 'payload'): Operation | null => {
  const operation = decode<Operation>(row, key);
  if (operation) operation.settings = chainSettingsSchema.parse(operation.settings);
  return operation;
};
const decodePosition = (row: Row | undefined): Position | null => {
  const position = decode<Position>(row);
  if (position) position.exits = exitSchema.parse(position.exits);
  return position;
};
export class Store {
  private readonly db: DatabaseSync;
  constructor(directory: string) {
    this.db = new DatabaseSync(join(directory, 'tracker.sqlite'));
    const version = this.db.prepare('PRAGMA user_version').get();
    if (Number(version?.user_version ?? 0) > 11)
      throw new Error('Database was created by a newer version of this bot');
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS configuration (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS signals (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, message_id INTEGER NOT NULL, revision INTEGER NOT NULL, chain TEXT, state TEXT NOT NULL, reason TEXT, payload TEXT NOT NULL, received_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS pending_signals ON signals (chain, state, received_at);
      CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, closed INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS open_positions ON positions (chain, closed);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, chain TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_operation ON operations (chain) WHERE status IN ('active', 'review');
      CREATE TABLE IF NOT EXISTS token_entries (chain TEXT NOT NULL, address TEXT NOT NULL, operation_id TEXT NOT NULL, bought INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (chain, address));
      CREATE TABLE IF NOT EXISTS purchased_tokens (channel_id TEXT NOT NULL, chain TEXT NOT NULL, address TEXT NOT NULL, operation_id TEXT NOT NULL, PRIMARY KEY (channel_id, chain, address));
      CREATE TABLE IF NOT EXISTS token_exits (chain TEXT NOT NULL, address TEXT NOT NULL, closed_at INTEGER NOT NULL, position_id TEXT NOT NULL, PRIMARY KEY (chain, address));
      CREATE TABLE IF NOT EXISTS call_channels (id TEXT PRIMARY KEY, channel_id TEXT UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS notification_deliveries (notification_id INTEGER NOT NULL REFERENCES notifications(id), recipient_id INTEGER NOT NULL, PRIMARY KEY (notification_id, recipient_id));
      CREATE TABLE IF NOT EXISTS pnl_fills (operation_id TEXT PRIMARY KEY, position_id TEXT NOT NULL, chain TEXT NOT NULL, confirmed_at INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS pnl_fills_by_time ON pnl_fills (confirmed_at, chain);
      CREATE INDEX IF NOT EXISTS pnl_fills_by_position ON pnl_fills (position_id, confirmed_at);
    `);
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(signals)').all();
      if (!columns.some((column) => column.name === 'source_post'))
        this.db.exec('ALTER TABLE signals ADD COLUMN source_post TEXT');
      if (!columns.some((column) => column.name === 'observation'))
        this.db.exec('ALTER TABLE signals ADD COLUMN observation TEXT');
      const channelColumns = this.db.prepare('PRAGMA table_info(call_channels)').all();
      if (!channelColumns.some((column) => column.name === 'settings_key'))
        this.db.exec('ALTER TABLE call_channels ADD COLUMN settings_key TEXT');
      this.db.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS channel_settings_keys ON call_channels (settings_key) WHERE settings_key IS NOT NULL',
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS operations_by_signal ON operations (json_extract(payload, '$.signal.id'), created_at DESC)",
      );
      if (Number(version?.user_version ?? 0) < 5) this.restoreEntryLinks();
      if (Number(version?.user_version ?? 0) < 6) this.restoreChannelRules();
      if (Number(version?.user_version ?? 0) < 7)
        this.db.exec(`
          INSERT OR IGNORE INTO purchased_tokens (channel_id,chain,address,operation_id)
          SELECT COALESCE(json_extract(payload, '$.signal.channelId'), ''), chain,
            CASE WHEN chain != 'solana' THEN lower(address) ELSE address END, id
          FROM operations
          WHERE status = 'confirmed' AND json_extract(payload, '$.kind') = 'buy'
          ORDER BY created_at;
        `);
      this.restoreSolanaEntryPrices();
      this.restorePnlFills();
      this.db.exec('PRAGMA user_version = 11');
    });
    if (!this.db.prepare('SELECT id FROM configuration WHERE id = 1').get())
      this.saveSettings(settingsSchema.parse({}));
  }
  private decodeChannel(row: Row | undefined): CallChannel | null {
    const channel = decode<CallChannel>(row);
    if (channel) {
      channel.settings = channelRulesSchema.parse(channel.settings ?? {});
      channel.blockedCallers ??= [];
      channel.senderFilter = senderFilterSchema.parse(channel.senderFilter ?? {});
    }
    return channel;
  }
  private restoreChannelRules(): void {
    const rows = this.db.prepare('SELECT payload FROM call_channels').all();
    const previous = rows.length ? this.settings() : null;
    for (const row of rows) {
      const channel = decode<CallChannel>(row)!;
      channel.settings ??= structuredClone(previous!.chains);
      channel.blockedCallers ??= [...previous!.blockedCallers];
      this.saveCallChannel(channel);
    }
    for (const row of this.db.prepare('SELECT payload FROM positions').all()) {
      const position = decode<Position>(row)!;
      const buyId = position.entryOperationId ?? this.positionEntryFill(position.id)?.operationId;
      const buy = buyId ? this.operation(buyId) : null;
      if (!buy) continue;
      position.sourceId ??= buy.signal?.sourceId ?? (buy.signal ? 'spydefi' : undefined);
      position.sourceName ??= buy.signal?.sourceName;
      position.executionSettings ??= structuredClone(buy.settings);
      this.db
        .prepare('UPDATE positions SET payload = ? WHERE id = ?')
        .run(JSON.stringify(position), position.id);
    }
  }
  private restoreEntryLinks(): void {
    for (const row of this.db.prepare('SELECT payload FROM positions').all()) {
      const position = decode<Position>(row)!;
      let operationId = position.entryOperationId;
      if (!operationId) {
        const linked = this.db
          .prepare(
            "SELECT id FROM operations WHERE status = 'confirmed' AND json_extract(payload, '$.kind') = 'buy' AND json_extract(payload, '$.positionId') = ?",
          )
          .all(position.id);
        if (linked.length === 1) operationId = String(linked[0]!.id);
      }
      if (!operationId) {
        const fills = this.db
          .prepare(
            "SELECT operation_id FROM pnl_fills WHERE position_id = ? AND json_extract(payload, '$.kind') = 'buy'",
          )
          .all(position.id);
        if (fills.length === 1) operationId = String(fills[0]!.operation_id);
        else {
          const positions = this.db
            .prepare('SELECT id FROM positions WHERE chain = ? AND address = ?')
            .all(position.chain, position.address);
          const buys = this.db
            .prepare(
              "SELECT id FROM operations WHERE chain = ? AND address = ? AND status = 'confirmed' AND json_extract(payload, '$.kind') = 'buy'",
            )
            .all(position.chain, position.address);
          if (positions.length === 1 && buys.length === 1) operationId = String(buys[0]!.id);
        }
      }
      if (!operationId) continue;
      const operation = this.operation(operationId);
      if (
        !operation ||
        operation.kind !== 'buy' ||
        operation.status !== 'confirmed' ||
        operation.chain !== position.chain ||
        operation.address !== position.address ||
        (operation.positionId !== null && operation.positionId !== position.id)
      )
        continue;
      position.entryOperationId = operationId;
      operation.positionId = position.id;
      this.db
        .prepare('UPDATE positions SET payload = ? WHERE id = ?')
        .run(JSON.stringify(position), position.id);
      this.db
        .prepare('UPDATE operations SET payload = ? WHERE id = ?')
        .run(JSON.stringify(operation), operation.id);
      if (position.closedAt !== null && BigInt(position.remainingTokenRaw) === 0n) {
        const sold = this.db
          .prepare(
            "SELECT 1 FROM operations WHERE status = 'confirmed' AND json_extract(payload, '$.kind') = 'sell' AND json_extract(payload, '$.positionId') = ?",
          )
          .get(position.id);
        if (sold) this.releaseEntry(position);
      }
    }
  }
  seedCallChannels(source: string): void {
    if (!this.metadata('channels:spydefi-target'))
      this.setMetadata('channels:spydefi-target', source.toLowerCase());
    if (this.metadata('channels:initialized')) return;
    this.transaction(() => {
      this.saveCallChannel({
        id: 'spydefi',
        target: source,
        channelId: null,
        title: source,
        username: source,
        mode: 'spydefi',
        defaultChain: null,
        enabled: true,
        activatedAt: 0,
        status: 'unresolved',
        error: null,
        settings: structuredClone(this.settings().chains),
        blockedCallers: [...this.settings().blockedCallers],
      });
      this.db
        .prepare(
          "UPDATE signals SET payload = json_set(payload, '$.sourceId', 'spydefi', '$.mode', 'spydefi') WHERE state = 'pending' AND json_extract(payload, '$.sourceId') IS NULL",
        )
        .run();
      this.db
        .prepare(
          "UPDATE operations SET payload = json_set(payload, '$.signal.sourceId', 'spydefi', '$.signal.mode', 'spydefi') WHERE status IN ('active','review') AND json_extract(payload, '$.kind') = 'buy' AND json_type(payload, '$.signal') = 'object' AND json_extract(payload, '$.signal.sourceId') IS NULL",
        )
        .run();
      this.setMetadata('channels:initialized', 'true');
    });
  }
  callChannels(): CallChannel[] {
    return this.db
      .prepare('SELECT payload FROM call_channels ORDER BY rowid')
      .all()
      .map((row) => this.decodeChannel(row)!);
  }
  callChannel(id: string): CallChannel | null {
    return this.decodeChannel(
      this.db.prepare('SELECT payload FROM call_channels WHERE id = ?').get(id),
    );
  }
  callChannelForSettings(key: string): CallChannel | null {
    return this.decodeChannel(
      this.db.prepare('SELECT payload FROM call_channels WHERE settings_key = ?').get(key),
    );
  }
  saveCallChannel(channel: CallChannel): void {
    const existing = this.callChannel(channel.id);
    channel.settings = channelRulesSchema.parse(channel.settings ?? existing?.settings ?? {});
    channel.blockedCallers ??= existing?.blockedCallers ?? [];
    channel.senderFilter = senderFilterSchema.parse(
      channel.senderFilter ?? existing?.senderFilter ?? {},
    );
    channel.settingsKey ??= existing?.settingsKey;
    while (
      !channel.settingsKey ||
      this.db
        .prepare('SELECT id FROM call_channels WHERE settings_key = ? AND id != ?')
        .get(channel.settingsKey, channel.id) ||
      (this.metadata(`channel-settings-key:${channel.settingsKey}`) !== null &&
        this.metadata(`channel-settings-key:${channel.settingsKey}`) !== channel.id)
    )
      channel.settingsKey = randomBytes(3).toString('hex');
    this.setMetadata(`channel-settings-key:${channel.settingsKey}`, channel.id);
    this.db
      .prepare(
        'INSERT INTO call_channels (id,channel_id,settings_key,payload) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET channel_id=excluded.channel_id,settings_key=excluded.settings_key,payload=excluded.payload',
      )
      .run(channel.id, channel.channelId, channel.settingsKey, JSON.stringify(channel));
  }
  tradingSettings(chain: Chain, sourceId?: string): ChainSettings {
    if (!sourceId) return this.settings().chains[chain];
    const channel = this.callChannel(sourceId);
    if (!channel) throw new Error('Source channel no longer exists');
    return channel.settings![chain];
  }
  callerBlocklist(sourceId?: string): string[] {
    if (!sourceId) return this.settings().blockedCallers;
    const channel = this.callChannel(sourceId);
    if (!channel) throw new Error('Source channel no longer exists');
    return channel.blockedCallers!;
  }
  updateChannelRules(
    sourceId: string,
    chain: Chain,
    action: (settings: ChainSettings) => void,
  ): void {
    this.transaction(() => {
      const channel = this.callChannel(sourceId);
      if (!channel) throw new Error('Channel no longer exists');
      const settings = structuredClone(channel.settings![chain]);
      action(settings);
      channel.settings![chain] = chainSettingsSchema.parse(settings);
      this.saveCallChannel(channel);
    });
    logger
      .child({ component: 'trading.settings' })
      .debug('channel.settings_updated', { sourceId, chain });
  }
  entriesEnabled(chain: Chain): boolean {
    const channels = this.callChannels();
    if (!channels.length && !this.metadata('channels:initialized'))
      return this.settings().chains[chain].enabled;
    return channels.some(
      (channel) =>
        channel.enabled && channel.status === 'ready' && channel.settings![chain].enabled,
    );
  }
  disableAllEntries(): void {
    this.transaction(() => {
      const defaults = this.settings();
      for (const chain of chains) defaults.chains[chain].enabled = false;
      this.saveSettings(defaults);
      for (const channel of this.callChannels()) {
        for (const chain of chains) channel.settings![chain].enabled = false;
        this.saveCallChannel(channel);
      }
    });
  }
  positionSettings(position: Position): ChainSettings {
    const source = position.sourceId ? this.callChannel(position.sourceId) : null;
    if (source) return source.settings![position.chain];
    if (position.executionSettings) return chainSettingsSchema.parse(position.executionSettings);
    const buyId = position.entryOperationId ?? this.positionEntryFill(position.id)?.operationId;
    const buy = buyId ? this.operation(buyId) : null;
    return buy ? structuredClone(buy.settings) : this.settings().chains[position.chain];
  }
  removeCallChannel(id: string): void {
    this.transaction(() => {
      const channel = this.callChannel(id);
      if (channel) {
        for (const row of this.db
          .prepare(
            "SELECT payload FROM positions WHERE closed = 0 AND json_extract(payload, '$.sourceId') = ?",
          )
          .all(id)) {
          const position = decode<Position>(row)!;
          position.executionSettings = structuredClone(channel.settings![position.chain]);
          position.executionSettings.exits = structuredClone(position.exits);
          this.savePosition(position);
        }
      }
      this.db.prepare('DELETE FROM call_channels WHERE id = ?').run(id);
      for (const row of this.db
        .prepare(
          "SELECT id FROM signals WHERE state = 'pending' AND json_extract(payload, '$.sourceId') = ?",
        )
        .all(id))
        this.skipSignal(String(row.id), 'Source channel was removed');
    });
  }
  lastExit(chain: Chain, address: string): number | null {
    const row = this.db
      .prepare('SELECT closed_at FROM token_exits WHERE chain = ? AND address = ?')
      .get(chain, normalizeAddress(chain, address));
    return row ? Number(row.closed_at) : null;
  }
  entryRejection(signal: CallSignal): string | null {
    if (signal.sourceId) {
      const channel = this.callChannel(signal.sourceId);
      if (!channel?.enabled || channel.status !== 'ready' || channel.channelId !== signal.channelId)
        return 'Source channel is disabled, removed or unavailable';
      if (!channel.settings![signal.chain].enabled)
        return 'Entries for this channel and chain are disabled';
      if (signal.date < channel.activatedAt) return 'Call predates channel activation';
    }
    if (this.hasPurchased(signal.chain, signal.address, signal.channelId))
      return 'Token was already purchased for this channel';
    if (this.hasEntry(signal.chain, signal.address))
      return 'Token is already purchased or reserved';
    const closedAt = this.lastExit(signal.chain, signal.address);
    if (
      closedAt !== null &&
      (signal.date <= closedAt ||
        (signal.detectedAt !== undefined && signal.detectedAt <= closedAt))
    )
      return 'Re-entry requires a new call posted after the last confirmed full exit';
    return null;
  }
  private releaseEntry(position: Position): void {
    const address = normalizeAddress(position.chain, position.address);
    this.db
      .prepare(
        'INSERT INTO token_exits (chain,address,closed_at,position_id) VALUES (?,?,?,?) ON CONFLICT(chain,address) DO UPDATE SET closed_at=MAX(token_exits.closed_at,excluded.closed_at),position_id=CASE WHEN excluded.closed_at >= token_exits.closed_at THEN excluded.position_id ELSE token_exits.position_id END',
      )
      .run(position.chain, address, position.closedAt!, position.id);
    this.db
      .prepare(
        'DELETE FROM token_entries WHERE chain = ? AND address = ? AND bought = 1 AND operation_id = ?',
      )
      .run(position.chain, address, position.entryOperationId ?? '');
  }
  private restorePnlFills(): void {
    const rows = this.db
      .prepare(
        "SELECT operations.payload FROM operations LEFT JOIN pnl_fills ON pnl_fills.operation_id = operations.id WHERE operations.status = 'confirmed' AND json_extract(operations.payload, '$.kind') IN ('buy', 'sell') AND pnl_fills.operation_id IS NULL ORDER BY operations.created_at",
      )
      .all();
    for (const row of rows) {
      const operation = decodeOperation(row)!;
      const position = operation.positionId ? this.position(operation.positionId) : null;
      if (!position) continue;
      this.savePnlFill(
        pnlFill(
          operation,
          position,
          null,
          operation.kind === 'buy' ? position.openedAt : operation.createdAt,
          true,
        ),
      );
    }
  }
  private restoreSolanaEntryPrices(): void {
    const rows = this.db
      .prepare("SELECT payload FROM positions WHERE chain = 'solana' AND closed = 0")
      .all();
    for (const row of rows) {
      const position = decode<Position>(row)!;
      if (position.entrySwapNativeRaw !== undefined) continue;
      const operation = decodeOperation(
        this.db
          .prepare(
            "SELECT payload FROM operations WHERE chain = 'solana' AND address = ? AND status = 'confirmed' AND json_extract(payload, '$.kind') = 'buy' AND json_extract(payload, '$.positionId') = ? LIMIT 1",
          )
          .get(position.address, position.id),
      );
      const step = operation?.steps.find((candidate) => candidate.type === 'jupiter');
      const amount = step?.executionAmounts?.inputRaw ?? operation?.amountRaw;
      const log = logger.child({
        component: 'trading.positions',
        chain: 'solana',
        positionId: position.id,
        token: position.address,
      });
      if (!amount || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
        log.warn('position.entry_price_unavailable', {
          reason: 'confirmed_buy_amount_missing',
        });
        continue;
      }
      position.entrySwapNativeRaw = amount;
      position.lastProfitPercent = null;
      if (amount !== position.entryNativeRaw) {
        position.trailingSl = { ...emptyTrail(), sold: position.trailingSl.sold };
        position.trailingTp = { ...emptyTrail(), sold: position.trailingTp.sold };
        for (const [key, state] of Object.entries(position.trailingStages ?? {}))
          position.trailingStages![key] = { ...emptyTrail(), sold: state.sold };
      }
      this.savePosition(position);
      log.info('position.entry_price_restored', {
        operationId: operation?.id,
        entryNativeRaw: position.entryNativeRaw,
        entrySwapNativeRaw: amount,
        source: step?.executionAmounts ? 'jupiter_execution' : 'confirmed_exact_input',
      });
    }
  }
  transaction<T>(action: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      logger.child({ component: 'storage' }).error('storage.transaction_failed', error);
      throw error;
    }
  }
  settings(): Settings {
    return settingsSchema.parse(
      decode(this.db.prepare('SELECT payload FROM configuration WHERE id = 1').get()),
    );
  }
  saveSettings(settings: Settings): void {
    this.db
      .prepare(
        'INSERT INTO configuration (id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
      )
      .run(JSON.stringify(settingsSchema.parse(settings)));
  }
  updateSettings(action: (settings: Settings) => void): Settings {
    const updated = this.transaction(() => {
      const settings = this.settings();
      action(settings);
      this.saveSettings(settings);
      return settings;
    });
    logger
      .child({ component: 'trading.settings' })
      .debug('settings.updated', { settings: updated });
    return updated;
  }
  metadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key);
    return typeof row?.value === 'string' ? row.value : null;
  }
  setMetadata(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO metadata (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
  recordPost(
    post: ChannelPost,
    signal: CallSignal | null,
    reason: string | null,
    receivedAt = Date.now(),
  ): boolean {
    const id = `${post.channelId}:${post.messageId}`;
    const previous = this.db
      .prepare('SELECT payload,chain,received_at FROM signals WHERE id = ?')
      .get(id);
    const previousPayload = decode<Partial<CallSignal>>(previous);
    const previousDetection =
      previousPayload?.detectedAt ?? (previous?.chain ? Number(previous.received_at) : undefined);
    const detectedAt = previousDetection ?? (signal ? receivedAt : undefined);
    if (signal) signal.detectedAt = detectedAt;
    const payload = detectedAt === undefined ? post : { ...(signal ?? post), detectedAt };
    const result = this.db
      .prepare(
        `INSERT INTO signals (id,channel_id,message_id,revision,chain,state,reason,payload,received_at,source_post) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,chain=excluded.chain,state=excluded.state,reason=excluded.reason,payload=excluded.payload,received_at=excluded.received_at,source_post=excluded.source_post,observation=NULL
      WHERE signals.state != 'claimed' AND excluded.revision >= signals.revision AND excluded.payload != signals.payload`,
      )
      .run(
        id,
        post.channelId,
        post.messageId,
        post.revision,
        signal?.chain ?? null,
        signal ? 'pending' : 'skipped',
        reason,
        JSON.stringify(payload),
        receivedAt,
        JSON.stringify(post),
      );
    const changed = Number(result.changes) > 0;
    if (changed && signal && previousDetection === undefined) logSignalDetected(signal, post);
    return changed;
  }
  alreadyRecorded(post: ChannelPost): boolean {
    const row = this.db
      .prepare('SELECT state,source_post FROM signals WHERE id = ?')
      .get(`${post.channelId}:${post.messageId}`);
    return row?.state === 'claimed' || row?.source_post === JSON.stringify(post);
  }
  nextSignal(chain: Chain): CallSignal | null {
    return decode(
      this.db
        .prepare(
          "SELECT payload FROM signals WHERE chain = ? AND state = 'pending' ORDER BY received_at,message_id LIMIT 1",
        )
        .get(chain),
    );
  }
  skipSignal(id: string, reason: string): void {
    const signal = decode<CallSignal>(
      this.db.prepare('SELECT payload FROM signals WHERE id = ?').get(id),
    );
    const result = this.db
      .prepare(
        "UPDATE signals SET state = 'skipped', reason = ? WHERE id = ? AND state = 'pending'",
      )
      .run(reason, id);
    logger.child({ component: 'trading.entries' }).info('entry.skipped', { signalId: id, reason });
    if (Number(result.changes) > 0 && signal) logSignalSkipped(signal, reason);
  }
  recordObservation(id: string, observation: CallObservation): void {
    this.db
      .prepare("UPDATE signals SET observation = ? WHERE id = ? AND state = 'pending'")
      .run(JSON.stringify(observation), id);
  }
  saveSourcePost(post: ChannelPost): void {
    this.db
      .prepare(
        'UPDATE signals SET source_post = ? WHERE id = ? AND revision = ? AND source_post IS NULL',
      )
      .run(JSON.stringify(post), `${post.channelId}:${post.messageId}`, post.revision);
  }
  signalHistory(): CallHistoryItem[] {
    return this.db
      .prepare(
        `SELECT signals.*,
        (SELECT payload FROM operations WHERE json_extract(payload, '$.signal.id') = signals.id ORDER BY created_at DESC LIMIT 1) AS operation
        FROM signals ORDER BY received_at DESC, message_id DESC LIMIT 10`,
      )
      .all()
      .map((row) => {
        const payload = decode<CallSignal | ChannelPost>(row);
        const operation = decodeOperation(row, 'operation');
        return {
          id: String(row.id),
          channelId: String(row.channel_id),
          messageId: Number(row.message_id),
          state: String(row.state),
          reason: row.reason === null ? null : String(row.reason),
          signal: payload && 'caller' in payload ? payload : null,
          post:
            decode<ChannelPost>(row, 'source_post') ??
            (payload && 'text' in payload ? payload : null),
          observation: decode<CallObservation>(row, 'observation'),
          operation: operation
            ? {
                status: operation.status,
                error: operation.error,
                hash: operation.swapHash,
                symbol: operation.token.symbol,
              }
            : null,
        };
      });
  }
  hasEntry(chain: Chain, address: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM token_entries WHERE chain = ? AND address = ? UNION ALL SELECT 1 FROM positions WHERE chain = ? AND address = ? AND closed = 0 LIMIT 1',
        )
        .get(chain, normalizeAddress(chain, address), chain, normalizeAddress(chain, address)),
    );
  }
  hasPurchased(chain: Chain, address: string, channelId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          'SELECT 1 FROM purchased_tokens WHERE channel_id = ? AND chain = ? AND address = ?',
        )
        .get(channelId, chain, normalizeAddress(chain, address)),
    );
  }
  activeOperation(chain: Chain): Operation | null {
    return decodeOperation(
      this.db
        .prepare(
          "SELECT payload FROM operations WHERE chain = ? AND status IN ('active','review') LIMIT 1",
        )
        .get(chain),
    );
  }
  operation(id: string): Operation | null {
    return decodeOperation(this.db.prepare('SELECT payload FROM operations WHERE id = ?').get(id));
  }
  saveOperation(operation: Operation): void {
    this.db
      .prepare(
        'INSERT INTO operations (id,chain,address,status,created_at,payload) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
      )
      .run(
        operation.id,
        operation.chain,
        operation.address,
        operation.status,
        operation.createdAt,
        JSON.stringify(operation),
      );
    logger.child({ component: 'trading.operations' }).info('operation.saved', {
      operationId: operation.id,
      chain: operation.chain,
      token: operation.address,
      kind: operation.kind,
      status: operation.status,
      positionId: operation.positionId,
      signalId: operation.signal?.id,
      amountRaw: operation.amountRaw,
      exitKey: operation.exitKey,
      exitDescription: operation.exitDescription,
      withdrawal: operation.withdrawal,
      swapHash: operation.swapHash,
      quote: operation.quote,
      reason: operation.error,
      retryCount: operation.retryCount ?? 0,
      steps: operation.steps.map((step) => {
        if (step.type === 'jupiter')
          return {
            type: step.type,
            key: step.key,
            jupiterRequestId: step.requestId,
            router: step.router,
            signature: step.signature,
            submittedAt: step.submittedAt,
            status: step.status,
            executionCode: step.executionCode,
            executionError: step.executionError,
            executionAmounts: step.executionAmounts,
          };
        if (step.type === 'solana')
          return {
            type: step.type,
            key: step.key,
            signature: step.signature,
            submittedAt: step.submittedAt,
            lastValidBlockHeight: step.lastValidBlockHeight,
          };
        if (step.type === 'evm')
          return {
            type: step.type,
            key: step.key,
            hash: step.hash,
            submittedAt: step.submittedAt,
            gasPaidRaw: step.gasPaidRaw,
          };
        return {
          type: step.type,
          key: step.key,
          orderId: step.orderId,
          txHash: step.txHash,
          deadline: step.deadline,
          submittedAt: step.submittedAt,
        };
      }),
    });
  }
  claim(operation: Operation): boolean {
    return this.transaction(() => {
      if (
        this.activeOperation(operation.chain) ||
        (operation.kind === 'buy' &&
          (this.hasEntry(operation.chain, operation.address) ||
            this.hasPurchased(
              operation.chain,
              operation.address,
              operation.signal?.channelId ?? '',
            ) ||
            (operation.signal && this.entryRejection(operation.signal))))
      )
        return false;
      this.saveOperation(operation);
      if (operation.kind === 'buy') {
        this.db
          .prepare('INSERT INTO token_entries (chain,address,operation_id,bought) VALUES (?,?,?,0)')
          .run(operation.chain, normalizeAddress(operation.chain, operation.address), operation.id);
        if (operation.signal)
          this.db
            .prepare("UPDATE signals SET state = 'claimed', reason = NULL WHERE id = ?")
            .run(operation.signal.id);
      }
      return true;
    });
  }
  completeBuy(operation: Operation, position: Position, result: SwapResult): void {
    this.transaction(() => {
      operation.positionId = position.id;
      position.entryOperationId = operation.id;
      position.sourceId = operation.signal?.sourceId;
      position.sourceName = operation.signal?.sourceName;
      position.executionSettings = structuredClone(operation.settings);
      const marketCap = operation.token.marketCapUsd;
      if (typeof marketCap === 'number' && Number.isFinite(marketCap) && marketCap > 0) {
        position.entryMarketCapUsd = marketCap;
        position.entryMarketCapCapturedAt = operation.token.fetchedAt;
      }
      operation.status = 'confirmed';
      this.saveOperation(operation);
      this.savePosition(position);
      this.db
        .prepare(
          'INSERT OR IGNORE INTO purchased_tokens (channel_id,chain,address,operation_id) VALUES (?,?,?,?)',
        )
        .run(
          operation.signal?.channelId ?? '',
          operation.chain,
          normalizeAddress(operation.chain, operation.address),
          operation.id,
        );
      this.savePnlFill(pnlFill(operation, position, result, position.openedAt));
      this.db
        .prepare(
          'UPDATE token_entries SET bought = 1 WHERE chain = ? AND address = ? AND operation_id = ?',
        )
        .run(operation.chain, normalizeAddress(operation.chain, operation.address), operation.id);
      this.notify(
        `trade:${operation.id}`,
        `Bought ${position.symbol.replace(/[\x00-\x1f]/g, ' ').slice(0, 60)} on ${position.chain}.\nTransaction: ${operation.swapHash ?? ''}`,
      );
    });
    logTradeOutcome(operation, {
      positionId: position.id,
      tokenRaw: position.originalTokenRaw,
      nativeRaw: position.entryNativeRaw,
      swapNativeRaw: position.entrySwapNativeRaw,
      feeNativeRaw: position.entryFeeNativeRaw,
    });
  }
  completeSell(operation: Operation, position: Position, result: SwapResult): void {
    this.transaction(() => {
      const sold = BigInt(result.tokenRaw);
      const remaining = BigInt(position.remainingTokenRaw);
      if (sold <= 0n || sold > remaining)
        throw new Error('Confirmed sale does not match the tracked position');
      position.remainingTokenRaw = (remaining - sold).toString();
      position.realizedNativeRaw = (
        BigInt(position.realizedNativeRaw) + BigInt(result.nativeRaw)
      ).toString();
      position.realizedFeeNativeRaw = (
        BigInt(position.realizedFeeNativeRaw) + BigInt(result.feeNativeRaw)
      ).toString();
      if (operation.exitKey)
        position.exitFills[operation.exitKey] = (
          BigInt(position.exitFills[operation.exitKey] ?? '0') + sold
        ).toString();
      if (operation.exitKey?.startsWith('trail:')) {
        const parts = operation.exitKey.split(':');
        const state =
          parts.length > 2
            ? position.trailingStages?.[operation.exitKey]
            : operation.exitKey === 'trail:sl'
              ? position.trailingSl
              : position.trailingTp;
        if (state && sold >= BigInt(operation.amountRaw)) state.sold = true;
      }
      if (BigInt(position.remainingTokenRaw) === 0n) position.closedAt = Date.now();
      this.db.prepare('DELETE FROM metadata WHERE key = ?').run(`pnl:mark:${position.id}`);
      position.lastError = null;
      position.fundsError = undefined;
      operation.swapHash = result.signature.trim() || operation.swapHash;
      operation.status = 'confirmed';
      this.savePosition(position);
      this.saveOperation(operation);
      if (position.closedAt !== null) this.releaseEntry(position);
      this.savePnlFill(pnlFill(operation, position, result, Date.now()));
      this.notify(
        `trade:${operation.id}`,
        [
          `Sold ${position.symbol.replace(/[\x00-\x1f]/g, ' ').slice(0, 60)} on ${chainLabel[position.chain]}.`,
          `Reason: ${operation.exitDescription ?? exitReasonLabel(operation.exitKey, position.exits)}`,
          `Sold: ${formatAmount(result.tokenRaw, position.decimals)} tokens`,
          `Remaining: ${formatAmount(position.remainingTokenRaw, position.decimals)} tokens`,
          `Net proceeds: ${formatAmount(result.nativeRaw, nativeDecimals[position.chain])} ${nativeSymbol[position.chain]}`,
          ...(operation.swapHash ? [`Transaction: ${operation.swapHash}`] : []),
        ].join('\n'),
      );
    });
    logTradeOutcome(operation, { ...result, positionId: position.id, exitKey: operation.exitKey });
  }
  completeWithdrawal(operation: Operation, result: SwapResult): void {
    if (operation.kind !== 'withdraw' || !operation.withdrawal || !result.signature.trim())
      throw new Error('Confirmed withdrawal details are missing');
    this.transaction(() => {
      operation.status = 'confirmed';
      operation.swapHash = result.signature;
      this.saveOperation(operation);
      this.notify(
        `withdraw:${operation.id}`,
        `Withdrawal confirmed on ${chainLabel[operation.chain]}.\nAmount: ${formatAmount(operation.amountRaw, nativeDecimals[operation.chain])} ${nativeSymbol[operation.chain]}\nDestination: ${operation.withdrawal!.recipient}\nNetwork fee: ${formatAmount(result.feeNativeRaw, nativeDecimals[operation.chain])} ${nativeSymbol[operation.chain]}\nTransaction: ${result.signature}`,
      );
    });
  }
  failOperation(operation: Operation, reason: string, review: boolean): void {
    this.transaction(() => {
      operation.status = review ? 'review' : 'failed';
      operation.error = reason;
      this.saveOperation(operation);
      if (!review && operation.kind === 'buy')
        this.db
          .prepare(
            'DELETE FROM token_entries WHERE chain = ? AND address = ? AND operation_id = ? AND bought = 0',
          )
          .run(operation.chain, normalizeAddress(operation.chain, operation.address), operation.id);
      this.notify(
        `failure:${operation.id}:${review}`,
        `${review ? 'Review required' : 'Trade failed'} on ${operation.chain}: ${reason}\nOperation: ${operation.id}`,
      );
    });
    logTradeOutcome(operation);
  }
  positions(chain?: Chain): Position[] {
    return (
      chain
        ? this.db.prepare('SELECT payload FROM positions WHERE chain = ? AND closed = 0').all(chain)
        : this.db.prepare('SELECT payload FROM positions WHERE closed = 0').all()
    )
      .map((row) => decodePosition(row)!)
      .filter(Boolean);
  }
  position(id: string): Position | null {
    return decodePosition(this.db.prepare('SELECT payload FROM positions WHERE id = ?').get(id));
  }
  positionEntryMarketCap(position: Position): { value: number; afterBuy: boolean } | null {
    const entryId = position.entryOperationId ?? this.positionEntryFill(position.id)?.operationId;
    const stored = entryId ? this.operation(entryId) : null;
    const value =
      position.entryMarketCapUsd ??
      (stored?.kind === 'buy' && stored.status === 'confirmed' ? stored.token.marketCapUsd : null);
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? { value, afterBuy: position.entryMarketCapAfterBuy ?? false }
      : null;
  }
  savePosition(position: Position): void {
    this.db
      .prepare(
        'INSERT INTO positions (id,chain,address,closed,payload) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET closed=excluded.closed,payload=excluded.payload',
      )
      .run(
        position.id,
        position.chain,
        position.address,
        position.closedAt === null ? 0 : 1,
        JSON.stringify(position),
      );
  }
  history(): Operation[] {
    return this.db
      .prepare('SELECT payload FROM operations ORDER BY created_at DESC LIMIT 10')
      .all()
      .map((row) => decodeOperation(row)!)
      .filter(Boolean);
  }
  private savePnlFill(fill: PnlFill): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO pnl_fills (operation_id,position_id,chain,confirmed_at,payload) VALUES (?,?,?,?,?)',
      )
      .run(fill.operationId, fill.positionId, fill.chain, fill.confirmedAt, JSON.stringify(fill));
  }
  pnlFills(): PnlFill[] {
    return this.db
      .prepare('SELECT payload FROM pnl_fills ORDER BY confirmed_at, operation_id')
      .all()
      .map((row) => decode<PnlFill>(row)!);
  }
  positionEntryFill(positionId: string): PnlFill | null {
    return decode<PnlFill>(
      this.db
        .prepare(
          "SELECT payload FROM pnl_fills WHERE position_id = ? AND json_extract(payload, '$.kind') = 'buy' ORDER BY confirmed_at LIMIT 1",
        )
        .get(positionId),
    );
  }
  pnlPendingRates(now = Date.now()): PnlFill[] {
    return this.db
      .prepare(
        "SELECT payload FROM pnl_fills WHERE confirmed_at >= ? AND confirmed_at <= ? AND json_extract(payload, '$.nativeUsd') IS NULL AND json_extract(payload, '$.legacy') = 0 ORDER BY confirmed_at",
      )
      .all(now - USD_CAPTURE_WINDOW_MS, now)
      .map((row) => decode<PnlFill>(row)!);
  }
  pricePnlFill(operationId: string, nativeUsd: number, observedAt: number): void {
    const row = this.db
      .prepare('SELECT payload FROM pnl_fills WHERE operation_id = ?')
      .get(operationId);
    const fill = decode<PnlFill>(row);
    if (!fill || fill.nativeUsd !== null) return;
    if (
      !Number.isFinite(nativeUsd) ||
      nativeUsd <= 0 ||
      Math.abs(observedAt - fill.confirmedAt) > USD_CAPTURE_WINDOW_MS
    )
      throw new Error('USD price is unavailable near the fill time');
    fill.nativeUsd = nativeUsd;
    fill.usdSource = fill.chain === 'bnb' ? 'dexscreener' : 'coinbase_spot';
    fill.usdAt = observedAt;
    this.db
      .prepare('UPDATE pnl_fills SET payload = ? WHERE operation_id = ?')
      .run(JSON.stringify(fill), operationId);
  }
  savePnlMark(mark: PnlMark): void {
    this.setMetadata(`pnl:mark:${mark.positionId}`, JSON.stringify(mark));
  }
  pnlMarks(): PnlMark[] {
    return this.db
      .prepare("SELECT value FROM metadata WHERE key LIKE 'pnl:mark:%'")
      .all()
      .map((row) => decode<PnlMark>(row, 'value')!);
  }
  notify(eventKey: string, text: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO notifications (event_key,text) VALUES (?,?)')
      .run(eventKey, text);
  }
  notifications(recipientId?: number): {
    id: number;
    text: string;
    solanaSignature: string | null;
    robinhoodHash: string | null;
    bnbHash: string | null;
  }[] {
    return this.db
      .prepare(
        'SELECT id,event_key,text FROM notifications WHERE delivered = 0 AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM notification_deliveries WHERE notification_id = notifications.id AND recipient_id = ?)) ORDER BY id LIMIT 3',
      )
      .all(recipientId ?? null, recipientId ?? null)
      .map((row) => {
        const operationId = /^(?:trade|fill|proceeds|withdraw|wrap|unwrap):([^:]+)$/.exec(
          String(row.event_key),
        )?.[1];
        const operation = operationId
          ? this.db
              .prepare(
                "SELECT chain,json_extract(payload, '$.swapHash') AS signature FROM operations WHERE id = ? AND status = 'confirmed'",
              )
              .get(operationId)
          : undefined;
        const signature =
          typeof operation?.signature === 'string' && operation.signature.length > 0
            ? operation.signature
            : null;
        return {
          id: Number(row.id),
          text: String(row.text),
          solanaSignature: operation?.chain === 'solana' ? signature : null,
          robinhoodHash: operation?.chain === 'robinhood' ? signature : null,
          bnbHash: operation?.chain === 'bnb' ? signature : null,
        };
      });
  }
  delivered(id: number, recipientId: number, recipients: readonly number[]): void {
    this.transaction(() => {
      this.db
        .prepare(
          'INSERT OR IGNORE INTO notification_deliveries (notification_id,recipient_id) VALUES (?,?)',
        )
        .run(id, recipientId);
      if (
        recipients.length > 0 &&
        recipients.every((recipient) =>
          this.db
            .prepare(
              'SELECT 1 FROM notification_deliveries WHERE notification_id = ? AND recipient_id = ?',
            )
            .get(id, recipient),
        )
      )
        this.db.prepare('UPDATE notifications SET delivered = 1 WHERE id = ?').run(id);
    });
  }
  close(): void {
    this.db.close();
  }
  newId(): string {
    return randomUUID();
  }
}
