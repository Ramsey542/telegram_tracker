import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWallets } from '../src/wallets.js';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

test('wallet addresses remain unchanged across startup loads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tracker-wallet-check-'));
  try {
    const config = { dataDirectory: directory, walletEncryptionKey: '' };
    const first = openWallets(config);
    const second = openWallets(config);
    assert.equal(first.solana.publicKey.toBase58(), second.solana.publicKey.toBase58());
    assert.equal(first.robinhood.address, second.robinhood.address);
    assert.equal(first.bnb.address, second.bnb.address);
    assert.notEqual(first.bnb.address, first.robinhood.address);
    const encrypted = readFileSync(join(directory, 'wallets.enc.json'), 'utf8');
    assert.equal(encrypted.includes(Buffer.from(first.solana.secretKey).toString('base64')), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('adding BNB preserves both legacy wallets and saves an encrypted recovery copy', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tracker-wallet-migration-'));
  try {
    const config = { dataDirectory: directory, walletEncryptionKey: '' };
    const original = openWallets(config);
    const key = readFileSync(join(directory, 'wallet-master.key'));
    const path = join(directory, 'wallets.enc.json');
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const payload = JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8'),
    );
    delete payload.bnb;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf8'),
      cipher.final(),
    ]);
    const legacy = JSON.stringify({
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    });
    writeFileSync(path, legacy);
    const migrated = openWallets(config);
    assert.equal(migrated.solana.publicKey.toBase58(), original.solana.publicKey.toBase58());
    assert.equal(migrated.robinhood.address, original.robinhood.address);
    assert.notEqual(migrated.bnb.address, migrated.robinhood.address);
    assert.equal(readFileSync(join(directory, 'wallets.pre-bnb.enc.json'), 'utf8'), legacy);
    assert.equal(openWallets(config).bnb.address, migrated.bnb.address);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('an incorrect encryption key never replaces the persisted wallets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tracker-wallet-check-'));
  try {
    openWallets({ dataDirectory: directory, walletEncryptionKey: '' });
    const original = readFileSync(join(directory, 'wallets.enc.json'), 'utf8');
    assert.throws(() =>
      openWallets({
        dataDirectory: directory,
        walletEncryptionKey: Buffer.alloc(32, 7).toString('base64'),
      }),
    );
    assert.equal(readFileSync(join(directory, 'wallets.enc.json'), 'utf8'), original);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('a missing wallet alongside an existing trading database halts startup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tracker-wallet-check-'));
  try {
    writeFileSync(join(directory, 'tracker.sqlite'), 'existing database');
    assert.throws(() => openWallets({ dataDirectory: directory, walletEncryptionKey: '' }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
