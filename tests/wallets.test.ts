import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWallets } from '../src/wallets.js';

test('wallet addresses remain unchanged across startup loads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tracker-wallet-check-'));
  try {
    const config = { dataDirectory: directory, walletEncryptionKey: '' };
    const first = openWallets(config);
    const second = openWallets(config);
    assert.equal(first.solana.publicKey.toBase58(), second.solana.publicKey.toBase58());
    assert.equal(first.robinhood.address, second.robinhood.address);
    const encrypted = readFileSync(join(directory, 'wallets.enc.json'), 'utf8');
    assert.equal(encrypted.includes(Buffer.from(first.solana.secretKey).toString('base64')), false);
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
