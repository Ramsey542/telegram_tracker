import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { logger } from '../logging/logger.js';
import {
  settingsSchema,
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
} from '../domain.js';

type Row = Record<string, unknown>;
const decode = <T>(row: Row | undefined, key = 'payload'): T | null =>
  row && typeof row[key] === 'string' ? (JSON.parse(row[key]) as T) : null;
export class Store {
  private readonly db: DatabaseSync;
  constructor(directory: string) {
    this.db = new DatabaseSync(join(directory, 'tracker.sqlite'));
    const version = this.db.prepare('PRAGMA user_version').get();
    if (Number(version?.user_version ?? 0) > 2)
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
      CREATE TABLE IF NOT EXISTS notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, event_key TEXT UNIQUE NOT NULL, text TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
    `);
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(signals)').all();
      if (!columns.some((column) => column.name === 'source_post'))
        this.db.exec('ALTER TABLE signals ADD COLUMN source_post TEXT');
      if (!columns.some((column) => column.name === 'observation'))
        this.db.exec('ALTER TABLE signals ADD COLUMN observation TEXT');
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS operations_by_signal ON operations (json_extract(payload, '$.signal.id'), created_at DESC)",
      );
      this.db.exec('PRAGMA user_version = 2');
    });
    if (!this.db.prepare('SELECT id FROM configuration WHERE id = 1').get())
      this.saveSettings(settingsSchema.parse({}));
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
  recordPost(post: ChannelPost, signal: CallSignal | null, reason: string | null): boolean {
    const id = `${post.channelId}:${post.messageId}`;
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
        JSON.stringify(signal ?? post),
        Date.now(),
        JSON.stringify(post),
      );
    return Number(result.changes) > 0;
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
    this.db
      .prepare("UPDATE signals SET state = 'skipped', reason = ? WHERE id = ?")
      .run(reason, id);
    logger.child({ component: 'trading.entries' }).info('entry.skipped', { signalId: id, reason });
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
        const operation = decode<Operation>(row, 'operation');
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
        .prepare('SELECT 1 FROM token_entries WHERE chain = ? AND address = ?')
        .get(chain, normalizeAddress(chain, address)),
    );
  }
  activeOperation(chain: Chain): Operation | null {
    return decode(
      this.db
        .prepare(
          "SELECT payload FROM operations WHERE chain = ? AND status IN ('active','review') LIMIT 1",
        )
        .get(chain),
    );
  }
  operation(id: string): Operation | null {
    return decode(this.db.prepare('SELECT payload FROM operations WHERE id = ?').get(id));
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
      swapHash: operation.swapHash,
      quote: operation.quote,
      reason: operation.error,
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
        (operation.kind === 'buy' && this.hasEntry(operation.chain, operation.address))
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
  completeBuy(operation: Operation, position: Position): void {
    this.transaction(() => {
      operation.status = 'confirmed';
      this.saveOperation(operation);
      this.savePosition(position);
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
        const state = operation.exitKey === 'trail:sl' ? position.trailingSl : position.trailingTp;
        if (sold >= BigInt(operation.amountRaw)) state.sold = true;
      }
      if (BigInt(position.remainingTokenRaw) === 0n) position.closedAt = Date.now();
      position.lastError = null;
      operation.status = 'confirmed';
      this.savePosition(position);
      this.saveOperation(operation);
      this.notify(
        `trade:${operation.id}`,
        `Sold ${position.symbol} on ${position.chain}.\nReason: ${operation.exitKey ?? 'manual'}\nTransaction: ${result.signature}`,
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
  }
  positions(chain?: Chain): Position[] {
    return (
      chain
        ? this.db.prepare('SELECT payload FROM positions WHERE chain = ? AND closed = 0').all(chain)
        : this.db.prepare('SELECT payload FROM positions WHERE closed = 0').all()
    )
      .map((row) => decode<Position>(row)!)
      .filter(Boolean);
  }
  position(id: string): Position | null {
    return decode(this.db.prepare('SELECT payload FROM positions WHERE id = ?').get(id));
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
      .map((row) => decode<Operation>(row)!)
      .filter(Boolean);
  }
  notify(eventKey: string, text: string): void {
    this.db
      .prepare('INSERT OR IGNORE INTO notifications (event_key,text) VALUES (?,?)')
      .run(eventKey, text);
  }
  notifications(): { id: number; text: string }[] {
    return this.db
      .prepare('SELECT id,text FROM notifications WHERE delivered = 0 ORDER BY id LIMIT 3')
      .all()
      .map((row) => ({ id: Number(row.id), text: String(row.text) }));
  }
  delivered(id: number): void {
    this.db.prepare('UPDATE notifications SET delivered = 1 WHERE id = ?').run(id);
  }
  close(): void {
    this.db.close();
  }
  newId(): string {
    return randomUUID();
  }
}
