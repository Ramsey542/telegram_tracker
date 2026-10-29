import { PublicKey } from '@solana/web3.js';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { nativeDecimals, parseAmount, type Chain } from '../domain.js';

export function withdrawalAddress(chain: Chain, value: string, sender: string): string {
  const address = value.trim();
  if (chain === 'solana') {
    const key = new PublicKey(address);
    if (!PublicKey.isOnCurve(key.toBytes())) throw new Error('Enter a Solana wallet address');
    if (key.toBase58() === sender)
      throw new Error('Destination must differ from the sending wallet');
    return key.toBase58();
  }
  if (!isAddress(address) || address.toLowerCase() === zeroAddress)
    throw new Error('Enter a valid Robinhood EVM address');
  if (address.toLowerCase() === sender.toLowerCase())
    throw new Error('Destination must differ from the sending wallet');
  return getAddress(address);
}

export function withdrawalAmount(chain: Chain, value: string): string {
  const amount = parseAmount(value.trim(), nativeDecimals[chain]);
  if (amount <= 0n) throw new Error('Withdrawal amount must be greater than zero');
  return amount.toString();
}
