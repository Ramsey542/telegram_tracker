import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import type { Config } from './config.js';

const payloadSchema = z.object({
  version: z.literal(1),
  solana: z.string(),
  robinhood: z.string().regex(/^0x[0-9a-f]{64}$/),
  bnb: z
    .string()
    .regex(/^0x[0-9a-f]{64}$/)
    .optional(),
});
const envelopeSchema = z.object({
  version: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
});
export function atomicWrite(path: string, value: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  if (process.platform !== 'win32') chmodSync(path, 0o600);
}
export function openWallets(config: Pick<Config, 'dataDirectory' | 'walletEncryptionKey'>) {
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  const walletPath = join(config.dataDirectory, 'wallets.enc.json');
  const keyPath = join(config.dataDirectory, 'wallet-master.key');
  if (!existsSync(walletPath) && existsSync(join(config.dataDirectory, 'tracker.sqlite')))
    throw new Error(
      'Trading database exists but its wallet file is missing; restore the original wallet backup',
    );
  let key: Buffer;
  if (config.walletEncryptionKey) key = Buffer.from(config.walletEncryptionKey, 'base64');
  else if (existsSync(keyPath)) key = readFileSync(keyPath);
  else {
    if (existsSync(walletPath))
      throw new Error('Wallet encryption key is missing; existing wallets will not be replaced');
    key = randomBytes(32);
    writeFileSync(keyPath, key, { flag: 'wx', mode: 0o600 });
  }
  if (key.length !== 32) throw new Error('WALLET_ENCRYPTION_KEY must decode to 32 bytes');
  let payload: z.infer<typeof payloadSchema>;
  let migrate = false;
  if (existsSync(walletPath)) {
    const envelope = envelopeSchema.parse(JSON.parse(readFileSync(walletPath, 'utf8')));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    payload = payloadSchema.parse(JSON.parse(plaintext.toString('utf8')));
    plaintext.fill(0);
    if (!payload.bnb) {
      const backup = join(config.dataDirectory, 'wallets.pre-bnb.enc.json');
      if (!existsSync(backup))
        writeFileSync(backup, readFileSync(walletPath), { flag: 'wx', mode: 0o600 });
      payload.bnb = generatePrivateKey();
      migrate = true;
    }
  } else {
    payload = {
      version: 1,
      solana: Buffer.from(Keypair.generate().secretKey).toString('base64'),
      robinhood: generatePrivateKey(),
      bnb: generatePrivateKey(),
    };
  }
  if (migrate || !existsSync(walletPath)) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const encrypted = JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
    if (migrate) atomicWrite(walletPath, encrypted);
    else writeFileSync(walletPath, encrypted, { flag: 'wx', mode: 0o600 });
  }
  const solana = Keypair.fromSecretKey(Buffer.from(payload.solana, 'base64'));
  const robinhood = privateKeyToAccount(payload.robinhood as `0x${string}`);
  const bnb = privateKeyToAccount(payload.bnb as `0x${string}`);
  return { solana, robinhood, bnb, encryptionKey: key };
}
export type Wallets = ReturnType<typeof openWallets>;
export function readWalletAddresses(config: Pick<Config, 'dataDirectory' | 'walletEncryptionKey'>) {
  const walletPath = join(config.dataDirectory, 'wallets.enc.json');
  const keyPath = join(config.dataDirectory, 'wallet-master.key');
  if (!existsSync(walletPath)) throw new Error('Existing encrypted wallet file was not found');
  if (!config.walletEncryptionKey && !existsSync(keyPath))
    throw new Error('Existing wallet encryption key was not found');
  const key = config.walletEncryptionKey
    ? Buffer.from(config.walletEncryptionKey, 'base64')
    : readFileSync(keyPath);
  let plaintext: Buffer | undefined;
  try {
    if (key.length !== 32) throw new Error('Wallet encryption key must contain 32 bytes');
    const envelope = envelopeSchema.parse(JSON.parse(readFileSync(walletPath, 'utf8')));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const payload = payloadSchema.parse(JSON.parse(plaintext.toString('utf8')));
    const secret = Buffer.from(payload.solana, 'base64');
    let solana: string;
    try {
      solana = Keypair.fromSecretKey(secret).publicKey.toBase58();
    } finally {
      secret.fill(0);
    }
    return {
      solana,
      robinhood: privateKeyToAccount(payload.robinhood as `0x${string}`).address,
      bnb: payload.bnb ? privateKeyToAccount(payload.bnb as `0x${string}`).address : undefined,
    };
  } finally {
    plaintext?.fill(0);
    key.fill(0);
  }
}
