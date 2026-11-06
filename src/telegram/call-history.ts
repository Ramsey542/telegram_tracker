import type { CallHistoryItem } from '../domain.js';
import {
  bold,
  code,
  italic,
  joinMessages,
  link,
  message,
  type MessageText,
} from './presentation.js';

const clean = (value: string, limit = 80): string =>
  value
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, limit);
const reasons: Record<string, string> = {
  listen_only: 'Listen-only mode: this call was captured and checked; trading was disabled.',
  entries_paused:
    'The previous global trading switch was paused when this older call arrived. That switch has been removed.',
  chain_disabled: 'Entries for this chain were disabled when this call arrived.',
  queued_for_evaluation: 'Waiting for the trading engine to evaluate this call.',
};
function decision(item: CallHistoryItem, listenOnly: boolean): { title: string; reason: string } {
  if (item.operation) {
    const operation = item.operation;
    if (operation.status === 'confirmed')
      return { title: '✅ Bought', reason: 'Purchase confirmed on chain.' };
    if (operation.status === 'failed')
      return { title: '❌ Buy failed', reason: operation.error ?? 'The buy operation failed.' };
    if (operation.status === 'review')
      return {
        title: '⚠️ Review required',
        reason: operation.error ?? 'The trade outcome needs reconciliation.',
      };
    return {
      title: '⏳ Trade in progress',
      reason:
        operation.error ?? 'A buy operation is active; confirmation has not been recorded yet.',
    };
  }
  if (item.state === 'skipped')
    return { title: '⏭️ Skipped', reason: item.reason ?? 'This post was rejected.' };
  if (item.observation?.decision === 'skipped') {
    const reason = item.observation.reason;
    const below = /^(overall|recent|chain) consistency is below the threshold$/i.exec(reason);
    const rate = below?.[1]?.toLowerCase() as 'overall' | 'recent' | 'chain' | undefined;
    const detail =
      rate && item.signal?.consistency && item.observation.thresholds
        ? `${rate[0]!.toUpperCase()}${rate.slice(1)} consistency ${item.signal.consistency[rate]}% was below the ${item.observation.thresholds[rate]}% minimum at capture.`
        : (reasons[reason] ?? reason);
    return {
      title:
        reason === 'listen_only'
          ? '👀 Observed (listen-only)'
          : reason === 'entries_paused'
            ? '👀 Captured (previous pause)'
            : reason === 'chain_disabled'
              ? '⏸️ On hold'
              : '⏭️ Skipped',
      reason: detail,
    };
  }
  if (item.state === 'claimed')
    return {
      title: '🔒 Reserved for trading',
      reason:
        'This call was reserved by a trade operation; no confirmed purchase is recorded here.',
    };
  if (listenOnly)
    return {
      title: '👀 Captured (listen-only)',
      reason: 'Trading is currently disabled. No buy has been submitted for this call.',
    };
  const reason = item.observation?.reason ?? 'queued_for_evaluation';
  return { title: '⏳ Awaiting evaluation', reason: reasons[reason] ?? reason };
}
function chartChain(item: CallHistoryItem): string | null {
  if (item.signal) return item.signal.chain;
  const found = new Set<string>();
  for (const raw of item.post?.urls ?? []) {
    try {
      const url = new URL(raw);
      if (!['dexscreener.com', 'www.dexscreener.com'].includes(url.hostname.toLowerCase()))
        continue;
      const chain = url.pathname.split('/').filter(Boolean)[0];
      if (chain) found.add(chain.toLowerCase());
    } catch {
      continue;
    }
  }
  if (found.size === 1) return [...found][0]!;
  return /^Unsupported chain:\s*(.+)$/i.exec(item.reason ?? '')?.[1] ?? null;
}
function chainLabel(chain: string | null): string {
  if (chain === 'solana') return 'Solana (SOL)';
  if (chain === 'robinhood') return 'Robinhood (ETH)';
  if (chain === 'bnb' || chain === 'bsc') return 'BNB Smart Chain (BNB)';
  if (chain === 'ethereum') return 'Ethereum (unsupported)';
  return chain ? `${clean(chain)} (unsupported)` : 'Not identified';
}
export function recentCallMessage(
  item: CallHistoryItem,
  source: string,
  listenOnly: boolean,
): MessageText {
  const text = item.post?.text ?? '';
  const caller =
    item.signal?.caller ?? /@([A-Za-z0-9_]+)\s+just\s+posted\b/i.exec(text)?.[1] ?? null;
  const address = item.signal?.address ?? /\bCA\s*:\s*([A-Za-z0-9]+)/i.exec(text)?.[1] ?? null;
  const name =
    item.signal?.tokenName ??
    /@([A-Za-z0-9_]+)\s+just\s+posted\s+([\s\S]+?)\s+at\s*\$/i.exec(text)?.[2] ??
    item.operation?.symbol ??
    null;
  const section =
    /Caller\s+Consistency\s*:\s*([\s\S]*?)(?:Total\s+Calls|View\s+Call|$)/i.exec(text)?.[1] ?? '';
  const rates = (['overall', 'recent', 'chain'] as const).map((key) => {
    const raw =
      item.signal?.consistency?.[key] ??
      new RegExp(`\\b${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\s*%`, 'i').exec(section)?.[1];
    return raw === undefined ? 'Unknown' : `${raw}%`;
  });
  const status = decision(item, listenOnly);
  const date = item.signal?.date ?? item.post?.date;
  const general = item.signal?.mode === 'general' || item.post?.mode === 'general';
  const sourceName = item.signal?.sourceName ?? item.post?.sourceName ?? (source || item.channelId);
  const sourceUrl = source
    ? `https://t.me/${source}/${item.messageId}`
    : `https://t.me/c/${item.channelId.replace(/^-100/, '')}/${item.messageId}`;
  return joinMessages([
    message`🪙 ${bold(name ? clean(name, 64) : 'Token name unavailable')}`,
    message`👤 ${bold('Caller:')} ${general ? clean(caller ?? sourceName) : caller ? link(`@${clean(caller, 64)}`, `https://t.me/${caller}`) : 'Not identified'}`,
    message`${bold('Source:')} ${clean(sourceName)}`,
    message`⛓️ ${bold('Chain:')} ${chainLabel(chartChain(item))}`,
    general
      ? message`${bold('Consistency:')} Not required for general call channels`
      : message`🎯 ${bold('Consistency:')} Overall ${rates[0]!} · Recent ${rates[1]!} · Chain ${rates[2]!}`,
    ...(general
      ? []
      : [
          message`${bold('First Caller:')} ${item.signal?.firstCaller === undefined ? 'Unknown' : item.signal.firstCaller ? 'Yes' : 'No'} | ${bold('Just Launched:')} ${item.signal?.justLaunched === undefined ? 'Unknown' : item.signal.justLaunched ? 'Yes' : 'No'}`,
        ]),
    ...(address ? [message`${bold('CA:')} ${code(clean(address, 128))}`] : []),
    message`${bold(status.title)}`,
    message`${bold('Reason:')} ${clean(status.reason, 400)}`,
    ...(item.operation?.hash
      ? [message`${bold('Transaction:')} ${code(item.operation.hash)}`]
      : []),
    ...(date !== undefined && Number.isFinite(date)
      ? [italic(`Posted: ${new Date(date).toISOString().slice(0, 16).replace('T', ' ')} UTC`)]
      : []),
    link('🔗 View source post', sourceUrl),
  ]);
}
