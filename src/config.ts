import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { LogLevel } from './logging/logger.js';
import { watcherUsernameSchema } from './telegram/access.js';

const envSchema = z.object({
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().regex(/^[a-fA-F0-9]{32}$/),
  TELEGRAM_PHONE: z.string().min(5),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive().safe(),
  TELEGRAM_WATCHER_USERNAME: watcherUsernameSchema,
  TELEGRAM_SOURCE_CHANNEL: z
    .string()
    .regex(/^@?[A-Za-z][A-Za-z0-9_]{3,}$/)
    .default('SpyDefiLive'),
  DATA_DIRECTORY: z.string().default('.data'),
  POSITION_POLL_SECONDS: z.coerce.number().min(0.5).max(300).default(10),
  PRICE_MAX_BLOCK_LAG: z.coerce.number().int().min(1).max(10000).default(150),
  TRANSACTION_POLL_MILLISECONDS: z.coerce.number().int().min(100).max(5000).default(300),
  MAX_SIGNAL_AGE_SECONDS: z.coerce.number().min(10).max(3600).default(120),
  HTTP_TIMEOUT_SECONDS: z.coerce.number().min(3).max(120).default(15),
  JUPITER_REQUESTS_PER_SECOND: z.coerce.number().min(0.5).max(150).default(1),
  PNL_TIMEZONE: z
    .string()
    .default('UTC')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
  LISTEN_ONLY: z.enum(['true', 'false']).default('false'),
  LOG_DIRECTORY: z.string().min(1).default('logs'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_CONSOLE: z.enum(['true', 'false']).default('true'),
  LOG_MAX_FILE_MB: z.coerce.number().int().min(1).max(1024).default(10),
  LOG_MAX_FILES: z.coerce.number().int().min(1).max(100).default(5),
});
export interface Config {
  telegramApiId: number;
  telegramApiHash: string;
  telegramPhone: string;
  botToken: string;
  ownerId: number;
  watcherUsername: string;
  sourceChannel: string;
  dataDirectory: string;
  pollMs: number;
  priceMaxBlockLag?: number;
  transactionPollMs?: number;
  maxSignalAgeMs: number;
  httpTimeoutMs: number;
  solanaRpc: string;
  robinhoodRpc: string;
  jupiterKey: string;
  uniswapKey: string;
  rugcheckKey: string;
  goplusToken: string;
  goplusAppKey: string;
  goplusAppSecret: string;
  walletEncryptionKey: string;
  jupiterRps: number;
  pnlTimeZone: string;
  listenOnly: boolean;
  logDirectory: string;
  logLevel: LogLevel;
  logConsole: boolean;
  logMaxFileBytes: number;
  logMaxFiles: number;
}
export function loadConfig(): Config {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(clean);
  if (!parsed.success)
    throw new Error(
      `Missing or invalid environment variables: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const value = parsed.data;
  const url = (key: string): string => {
    const raw = process.env[key]?.trim() ?? '';
    if (raw && new URL(raw).protocol !== 'https:') throw new Error(`${key} must use HTTPS`);
    return raw;
  };
  const solanaRpc = url('QUICKNODE_SOLANA_RPC_URL');
  const goplusAppKey = process.env.GOPLUS_APP_KEY?.trim() ?? '';
  const goplusAppSecret = process.env.GOPLUS_APP_SECRET?.trim() ?? '';
  if (Boolean(goplusAppKey) !== Boolean(goplusAppSecret))
    throw new Error('Set both GOPLUS_APP_KEY and GOPLUS_APP_SECRET, or leave both empty');
  return {
    telegramApiId: value.TELEGRAM_API_ID,
    telegramApiHash: value.TELEGRAM_API_HASH,
    telegramPhone: value.TELEGRAM_PHONE,
    botToken: value.TELEGRAM_BOT_TOKEN,
    ownerId: value.TELEGRAM_OWNER_ID,
    watcherUsername: value.TELEGRAM_WATCHER_USERNAME,
    sourceChannel: value.TELEGRAM_SOURCE_CHANNEL.replace(/^@/, ''),
    dataDirectory: resolve(value.DATA_DIRECTORY),
    pollMs: value.POSITION_POLL_SECONDS * 1000,
    priceMaxBlockLag: value.PRICE_MAX_BLOCK_LAG,
    transactionPollMs: value.TRANSACTION_POLL_MILLISECONDS,
    maxSignalAgeMs: value.MAX_SIGNAL_AGE_SECONDS * 1000,
    httpTimeoutMs: value.HTTP_TIMEOUT_SECONDS * 1000,
    solanaRpc,
    robinhoodRpc: url('QUICKNODE_ROBINHOOD_RPC_URL'),
    jupiterKey: process.env.JUPITER_API_KEY?.trim() ?? '',
    uniswapKey: process.env.UNISWAP_API_KEY?.trim() ?? '',
    rugcheckKey: process.env.RUGCHECK_API_KEY?.trim() ?? '',
    goplusToken: process.env.GOPLUS_ACCESS_TOKEN?.trim() ?? '',
    goplusAppKey,
    goplusAppSecret,
    walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY?.trim() ?? '',
    jupiterRps: value.JUPITER_REQUESTS_PER_SECOND,
    pnlTimeZone: value.PNL_TIMEZONE,
    listenOnly: value.LISTEN_ONLY === 'true',
    logDirectory: resolve(value.LOG_DIRECTORY),
    logLevel: value.LOG_LEVEL,
    logConsole: value.LOG_CONSOLE === 'true',
    logMaxFileBytes: value.LOG_MAX_FILE_MB * 1024 * 1024,
    logMaxFiles: value.LOG_MAX_FILES,
  };
}
