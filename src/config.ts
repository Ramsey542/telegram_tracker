import 'dotenv/config';
import { resolve } from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().regex(/^[a-fA-F0-9]{32}$/),
  TELEGRAM_PHONE: z.string().min(5),
  TELEGRAM_BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
  TELEGRAM_OWNER_ID: z.coerce.number().int().positive().safe(),
  TELEGRAM_SOURCE_CHANNEL: z
    .string()
    .regex(/^@?[A-Za-z][A-Za-z0-9_]{3,}$/)
    .default('SpyDefiLive'),
  DATA_DIRECTORY: z.string().default('.data'),
  POSITION_POLL_SECONDS: z.coerce.number().min(2).max(300).default(10),
  MAX_SIGNAL_AGE_SECONDS: z.coerce.number().min(10).max(3600).default(120),
  HTTP_TIMEOUT_SECONDS: z.coerce.number().min(3).max(120).default(15),
  JUPITER_REQUESTS_PER_SECOND: z.coerce.number().min(0.5).max(150).default(1),
});
export interface Config {
  telegramApiId: number;
  telegramApiHash: string;
  telegramPhone: string;
  botToken: string;
  ownerId: number;
  sourceChannel: string;
  dataDirectory: string;
  pollMs: number;
  maxSignalAgeMs: number;
  httpTimeoutMs: number;
  solanaRpc: string;
  robinhoodRpc: string;
  jupiterKey: string;
  uniswapKey: string;
  rugcheckKey: string;
  goplusToken: string;
  walletEncryptionKey: string;
  jupiterRps: number;
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
  return {
    telegramApiId: value.TELEGRAM_API_ID,
    telegramApiHash: value.TELEGRAM_API_HASH,
    telegramPhone: value.TELEGRAM_PHONE,
    botToken: value.TELEGRAM_BOT_TOKEN,
    ownerId: value.TELEGRAM_OWNER_ID,
    sourceChannel: value.TELEGRAM_SOURCE_CHANNEL.replace(/^@/, ''),
    dataDirectory: resolve(value.DATA_DIRECTORY),
    pollMs: value.POSITION_POLL_SECONDS * 1000,
    maxSignalAgeMs: value.MAX_SIGNAL_AGE_SECONDS * 1000,
    httpTimeoutMs: value.HTTP_TIMEOUT_SECONDS * 1000,
    solanaRpc,
    robinhoodRpc: url('QUICKNODE_ROBINHOOD_RPC_URL'),
    jupiterKey: process.env.JUPITER_API_KEY?.trim() ?? '',
    uniswapKey: process.env.UNISWAP_API_KEY?.trim() ?? '',
    rugcheckKey: process.env.RUGCHECK_API_KEY?.trim() ?? '',
    goplusToken: process.env.GOPLUS_ACCESS_TOKEN?.trim() ?? '',
    walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY?.trim() ?? '',
    jupiterRps: value.JUPITER_REQUESTS_PER_SECOND,
  };
}
