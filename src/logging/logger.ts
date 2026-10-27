import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { redact } from './redaction.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export interface LogOptions {
  directory: string;
  level: LogLevel;
  console: boolean;
  maxFileBytes: number;
  maxFiles: number;
}
const ranks: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const context = new AsyncLocalStorage<LogFields>();
const runId = randomUUID();
let options: LogOptions | null = null;

export function configureLogging(value: LogOptions): () => void {
  mkdirSync(value.directory, { recursive: true, mode: 0o700 });
  const previous = options;
  options = value;
  return () => {
    options = previous;
  };
}
export function withLogContext<T>(fields: LogFields, action: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, action);
}
function append(name: string, line: string): void {
  if (!options) return;
  const path = join(options.directory, `${name}.jsonl`);
  if (existsSync(path) && statSync(path).size + Buffer.byteLength(line) > options.maxFileBytes) {
    const oldest = `${path}.${options.maxFiles}`;
    if (existsSync(oldest)) unlinkSync(oldest);
    for (let index = options.maxFiles - 1; index >= 1; index--) {
      const previous = `${path}.${index}`;
      if (existsSync(previous)) renameSync(previous, `${path}.${index + 1}`);
    }
    renameSync(path, `${path}.1`);
  }
  appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
}
export class Logger {
  constructor(private readonly fields: LogFields = {}) {}
  child(fields: LogFields): Logger {
    return new Logger({ ...this.fields, ...fields });
  }
  debug(event: string, fields: LogFields = {}): void {
    this.write('debug', event, fields);
  }
  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }
  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }
  error(event: string, error: unknown, fields: LogFields = {}): void {
    this.write('error', event, { ...fields, error });
  }
  private write(level: LogLevel, event: string, fields: LogFields): void {
    if (ranks[level] < ranks[options?.level ?? 'info']) return;
    const merged = { ...this.fields, ...context.getStore(), ...fields };
    const record = redact({
      ...merged,
      timestamp: new Date().toISOString(),
      runId,
      pid: process.pid,
      level,
      event,
    });
    const line = `${JSON.stringify(record)}\n`;
    try {
      append('app', line);
      if (level === 'warn' || level === 'error') append('errors', line);
      const component = String(merged.component ?? 'app');
      if (component.startsWith('api')) append('api', line);
      if (
        component.startsWith('trading') ||
        component.startsWith('risk') ||
        (component.startsWith('api') && !component.startsWith('api.telegram')) ||
        (component === 'telegram.reader' && (level === 'warn' || level === 'error'))
      )
        append('trades', line);
      if (component.startsWith('telegram')) append('telegram', line);
    } catch (error) {
      process.stderr.write(
        `${JSON.stringify(redact({ timestamp: new Date().toISOString(), level: 'error', event: 'logging.write_failed', error }))}\n`,
      );
    }
    if (!options || options.console || level === 'error')
      (level === 'error' ? process.stderr : process.stdout).write(line);
  }
}
export const logger = new Logger();
