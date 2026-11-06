import { PublicKey } from '@solana/web3.js';
import { normalizeAddress, type CallSignal, type Chain, type ChannelPost } from '../domain.js';

export type ParsedCall = { ok: true; signal: CallSignal } | { ok: false; reason: string };
export function parseCall(post: ChannelPost): ParsedCall {
  const addressMatch = /\bCA\s*:\s*([A-Za-z0-9]+)/i.exec(post.text);
  const callerMatch = /@([A-Za-z0-9_]+)\s+just\s+posted\b/i.exec(post.text);
  if (!addressMatch?.[1] || !callerMatch?.[1])
    return { ok: false, reason: 'Message is not a supported call' };
  const headings = new Set(
    post.text
      .slice(0, callerMatch.index)
      .normalize('NFKC')
      .replace(/[\u200b-\u200d\ufeff]/g, '')
      .split(/\r?\n/)
      .map((line) =>
        line
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
          .replace(/\s+/g, ' ')
          .toUpperCase(),
      ),
  );
  const chartChains = new Set<string>();
  const chartAddresses: string[] = [];
  for (const raw of post.urls) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (!['dexscreener.com', 'www.dexscreener.com'].includes(url.hostname.toLowerCase())) continue;
    const [chain, address] = url.pathname.split('/').filter(Boolean);
    if (chain && address) {
      chartChains.add(chain.toLowerCase());
      chartAddresses.push(address);
    }
  }
  if (chartChains.size !== 1) return { ok: false, reason: 'Missing or ambiguous chart chain' };
  const rawChainName = [...chartChains][0];
  const chainName = rawChainName === 'bsc' ? 'bnb' : rawChainName;
  if (chainName !== 'solana' && chainName !== 'robinhood' && chainName !== 'bnb')
    return { ok: false, reason: `Unsupported chain: ${chainName ?? 'unknown'}` };
  const chain: Chain = chainName;
  const address = normalizeAddress(chain, addressMatch[1]);
  try {
    if (chain === 'solana') {
      if (new PublicKey(address).toBase58() !== address) throw new Error();
    } else if (!/^0x[a-f0-9]{40}$/.test(address)) throw new Error();
  } catch {
    return { ok: false, reason: 'Invalid contract address' };
  }
  if (
    !chartAddresses.length ||
    chartAddresses.some((chartAddress) => normalizeAddress(chain, chartAddress) !== address)
  )
    return { ok: false, reason: 'Chart address does not match the contract address' };
  const section = /Caller\s+Consistency\s*:\s*([\s\S]*?)(?:Total\s+Calls|View\s+Call|$)/i.exec(
    post.text,
  )?.[1];
  if (!section) return { ok: false, reason: 'Caller consistency section is missing' };
  const values = ['Overall', 'Recent', 'Chain'].map((label) => {
    const match = new RegExp(`\\b${label}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*%`, 'i').exec(section);
    return match?.[1] === undefined ? null : Number(match[1]);
  });
  if (values.some((value) => value === null || value < 0 || value > 100))
    return { ok: false, reason: 'All three valid consistency percentages are required' };
  const [overall, recent, chainRate] = values as [number, number, number];
  const callerIds = new Set(
    post.urls
      .map((raw) => {
        try {
          const url = new URL(raw);
          if (
            !['t.me', 'telegram.me'].includes(url.hostname) ||
            url.pathname.toLowerCase() !== '/spydefi_bot'
          )
            return undefined;
          const match = /^tg([A-Za-z0-9_]+)telegram(-?\d+)$/.exec(
            url.searchParams.get('start') ?? '',
          );
          return match?.[1]?.toLowerCase() === callerMatch[1]!.toLowerCase() ? match[2] : undefined;
        } catch {
          return undefined;
        }
      })
      .filter((value): value is string => Boolean(value)),
  );
  if (callerIds.size > 1) return { ok: false, reason: 'Ambiguous caller identity' };
  const callerId = [...callerIds][0] ?? null;
  const marketCap = /\bat\s*\$([\d,.]+)\s*([KMB])?\s+marketcap/i.exec(post.text);
  const multiplier: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
  const advertisedMarketCapUsd = marketCap?.[1]
    ? Number(marketCap[1].replaceAll(',', '')) *
      (multiplier[marketCap[2]?.toUpperCase() ?? ''] ?? 1)
    : null;
  return {
    ok: true,
    signal: {
      id: `${post.channelId}:${post.messageId}`,
      channelId: post.channelId,
      messageId: post.messageId,
      date: post.date,
      chain,
      address,
      caller: callerMatch[1].toLowerCase(),
      callerId,
      consistency: { overall, recent, chain: chainRate },
      firstCaller: headings.has('FIRST CALLER'),
      justLaunched: headings.has('JUST LAUNCHED'),
      advertisedMarketCapUsd,
      tokenName: /\bjust\s+posted\s+([\s\S]+?)\s+at\s*\$/i
        .exec(post.text)?.[1]
        ?.replace(/[\x00-\x1f\x7f]/g, ' ')
        .trim()
        .slice(0, 64),
    },
  };
}
