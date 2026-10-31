import { PublicKey } from '@solana/web3.js';
import { normalizeAddress, type CallChannel, type Chain, type ChannelPost } from '../domain.js';
import type { DexPair } from '../providers/market.js';
import type { ParsedCall } from './parser.js';

export type PairResolver = (chain: string, address: string) => Promise<DexPair | null>;
const dexHosts = new Set(['dexscreener.com', 'www.dexscreener.com']);
const quoteAssets = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
]);
function chainHint(value: string): string {
  const name = value.toLowerCase();
  if (name === 'sol') return 'solana';
  if (['rh', 'rbh', '4663'].includes(name)) return 'robinhood';
  if (['eth', '1'].includes(name)) return 'ethereum';
  return name;
}

export function isUpdatePost(text: string): boolean {
  const plain = text.replace(/^[^\p{L}\p{N}$]+/u, '').trim();
  if (/^(?:update|recap|results?|performance|profit\s+update|pnl)\b/i.test(plain)) return true;
  return (
    /\b(?:already|our\s+(?:call|entry)|we\s+(?:called|posted)|since\s+(?:the|our)\s+(?:call|entry)|from\s+(?:the|our)\s+entry)\b/i.test(
      plain,
    ) && /(?:\b\d+(?:\.\d+)?\s*x\b|\+\s*\d+(?:\.\d+)?\s*%)/i.test(plain)
  );
}

function addresses(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/(?<![A-Za-z0-9])0x[a-fA-F0-9]{40}(?![A-Za-z0-9])/g))
    found.add(match[0].toLowerCase());
  for (const match of text.matchAll(
    /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{32,44}(?![A-Za-z0-9])/g,
  )) {
    try {
      if (new PublicKey(match[0]).toBase58() === match[0]) found.add(match[0]);
    } catch {
      continue;
    }
  }
  return [...found];
}

export async function parseGeneralCall(
  post: ChannelPost,
  channel: CallChannel,
  resolvePair: PairResolver,
): Promise<ParsedCall> {
  const skip = (reason: string): ParsedCall => ({ ok: false, reason });
  if (isUpdatePost(post.text)) return skip('Update or performance post');
  const candidates = new Set(addresses(post.text.replace(/https?:\/\/[^\s<>]+/gi, ' ')));
  const hints = new Set<string>();
  const plain = post.text.replace(/https?:\/\/[^\s<>]+/gi, ' ');
  if (/\b(?:solana|sol)\b/i.test(plain)) hints.add('solana');
  if (/\b(?:robinhood|rbh|rh)\b/i.test(plain)) hints.add('robinhood');
  for (const match of plain.matchAll(
    /\b(?:chain|network)\s*:\s*(ethereum|bsc|base|arbitrum|polygon)\b/gi,
  ))
    hints.add(match[1]!.toLowerCase());
  const links = new Set([
    ...post.urls,
    ...Array.from(post.text.matchAll(/https?:\/\/[^\s<>]+/gi), (match) => match[0]),
  ]);
  const pairs: { chain: string; address: string }[] = [];
  if (links.size > 30) return skip('Too many links to identify one call reliably');
  for (const raw of links) {
    let url: URL;
    try {
      url = new URL(raw.replace(/[)\],.]+$/, ''));
    } catch {
      continue;
    }
    if (!['https:', 'http:'].includes(url.protocol)) continue;
    const parts = url.pathname.split('/').filter(Boolean);
    if (dexHosts.has(url.hostname.toLowerCase())) {
      if (!parts[0] || !parts[1]) continue;
      hints.add(chainHint(parts[0]));
      pairs.push({ chain: chainHint(parts[0]), address: parts[1] });
      continue;
    }
    if (url.hostname.toLowerCase() === 'solscan.io' && parts[0] === 'token') hints.add('solana');
    const queryChain = url.searchParams.get('chain') ?? url.searchParams.get('chainId');
    if (queryChain) hints.add(chainHint(queryChain));
    let path = url.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      continue;
    }
    for (const address of addresses(path)) candidates.add(address);
    for (const key of ['outputMint', 'mint', 'token', 'address', 'ca', 'start']) {
      const value = url.searchParams.get(key);
      if (value) for (const address of addresses(value)) candidates.add(address);
    }
    if (['jup.ag', 'www.jup.ag'].includes(url.hostname.toLowerCase())) hints.add('solana');
  }
  if (hints.size > 1) return skip('Conflicting chain hints');
  const hint = [...hints][0];
  if (hint && hint !== 'solana' && hint !== 'robinhood') return skip(`Unsupported chain: ${hint}`);
  if (candidates.size > 1) for (const quoteAsset of quoteAssets) candidates.delete(quoteAsset);
  if (candidates.size > 1) return skip('Multiple token candidates; no unambiguous call');
  let candidate = [...candidates][0];
  const chain: Chain | undefined =
    (hint as Chain | undefined) ??
    (candidate && !candidate.startsWith('0x') ? 'solana' : (channel.defaultChain ?? undefined));
  if (!chain) return skip('Chain is unknown; configure a default chain for this channel');
  if (pairs.length > 5) return skip('Multiple chart links cannot be resolved reliably');
  for (const pairLink of pairs) {
    if (
      candidate &&
      normalizeAddress(chain, pairLink.address) === normalizeAddress(chain, candidate)
    )
      continue;
    const pair = await resolvePair(pairLink.chain, pairLink.address);
    if (!pair) return skip('Chart pair could not be resolved');
    const base = normalizeAddress(chain, pair.baseToken.address);
    const quote = normalizeAddress(chain, pair.quoteToken.address);
    if (candidate) {
      if (![base, quote].includes(normalizeAddress(chain, candidate)))
        return skip('Chart pair does not contain the posted contract address');
    } else {
      const choices = [base, quote].filter((address) => !quoteAssets.has(address));
      if (choices.length !== 1) return skip('Chart contains ambiguous token candidates');
      candidate = choices[0];
    }
  }
  if (!candidate) return skip('No complete contract address found');
  if ((chain === 'robinhood') !== candidate.startsWith('0x'))
    return skip('Contract address conflicts with the selected chain');
  if (quoteAssets.has(candidate)) return skip('Call points to a native or quote asset');
  return {
    ok: true,
    signal: {
      id: `${post.channelId}:${post.messageId}`,
      channelId: post.channelId,
      messageId: post.messageId,
      date: post.date,
      chain,
      address: normalizeAddress(chain, candidate),
      caller: channel.username?.toLowerCase() ?? channel.title,
      callerId: channel.channelId,
      consistency: null,
      advertisedMarketCapUsd: null,
      tokenName: /\$([A-Za-z][A-Za-z0-9_]{0,31})\b/.exec(post.text)?.[1] ?? candidate.slice(0, 8),
      mode: 'general',
      sourceId: channel.id,
      sourceName: channel.title,
    },
  };
}
