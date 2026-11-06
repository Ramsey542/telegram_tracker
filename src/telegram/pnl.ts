import type { PnlChain, PnlPeriod, PnlSummary } from '../pnl/types.js';
import { USD_SCALE } from '../pnl/accounting.js';
import { bold, italic, joinMessages, message, type MessageText } from './presentation.js';

export function pnlPeriod(value: string | undefined): PnlPeriod {
  if (value === undefined) return 'day';
  if (value !== 'day' && value !== 'week' && value !== 'month')
    throw new Error('Unknown PNL period');
  return value;
}

export function pnlChain(value: string | undefined): PnlChain {
  if (value === undefined) return 'all';
  if (value !== 'all' && value !== 'solana' && value !== 'robinhood' && value !== 'bnb')
    throw new Error('Unknown PNL chain');
  return value;
}

export function usdText(value: bigint | null, signed = false): string {
  if (value === null) return 'Unavailable';
  const absolute = value < 0n ? -value : value;
  const sign = value < 0n ? '-' : signed && value > 0n ? '+' : '';
  const cents = (absolute * 100n + USD_SCALE / 2n) / USD_SCALE;
  if (absolute > 0n && cents === 0n) return `${sign}<$0.01`;
  const whole = new Intl.NumberFormat('en-US').format(cents / 100n);
  return `${sign}$${whole}.${String(cents % 100n).padStart(2, '0')}`;
}

export function pnlMessage(summary: PnlSummary, updating = false): MessageText {
  const period = { day: 'Daily', week: 'Weekly', month: 'Monthly' }[summary.window.period];
  const chain = {
    all: 'All chains',
    solana: 'Solana',
    robinhood: 'Robinhood',
    bnb: 'BNB Smart Chain',
  }[summary.chain];
  const roi =
    summary.allocatedCostUsd > 0n && summary.realizedUsd !== null
      ? `${(Number((summary.realizedUsd * 10_000n) / summary.allocatedCostUsd) / 100).toFixed(2)}%`
      : 'Unavailable';
  const missing = summary.sells - summary.pricedSales;
  const missingQuotes = summary.openPositions - summary.valuedPositions;
  const fills = summary.buys + summary.sells;
  const fees = fills > 0 && summary.unpricedFees === fills ? null : summary.networkFeesUsd;
  const funding = fills > 0 && summary.unpricedFunding === fills ? null : summary.fundingUsd;
  return joinMessages([
    message`📊 ${bold(`USD PNL - ${period}`)}`,
    `${summary.window.label} | ${summary.window.timeZone}`,
    chain,
    '',
    message`💰 ${bold(missing ? 'Known realized PNL: ' : 'Realized PNL: ')}${usdText(summary.realizedUsd, true)}`,
    `Return on realized cost: ${roi}`,
    `Priced sale proceeds: ${summary.sells > 0 && !summary.pricedSales ? 'Unavailable' : usdText(summary.proceedsUsd)}`,
    `Allocated entry cost: ${summary.sells > 0 && !summary.pricedSales ? 'Unavailable' : usdText(summary.allocatedCostUsd)}`,
    '',
    `Confirmed buys: ${summary.buys} | Sells: ${summary.sells}`,
    `Priced exits: ${summary.pricedSales}/${summary.sells}`,
    `Profitable exits: ${summary.winningSales} | Losing exits: ${summary.losingSales}`,
    '',
    `Network fees paid: ${usdText(fees)}${summary.unpricedFees && fees !== null ? ' (partial)' : ''}`,
    `Other wallet movements: ${usdText(funding, true)}${summary.unpricedFunding && funding !== null ? ' (partial)' : ''}`,
    italic(
      'Realized PNL includes swap and recorded network fees. Other wallet movements are separate.',
    ),
    '',
    message`📈 ${bold(missingQuotes ? 'Known open PNL now: ' : 'Open PNL now: ')}${usdText(summary.unrealizedUsd, true)}`,
    `Open positions valued: ${summary.valuedPositions}/${summary.openPositions}`,
    ...(summary.oldestQuoteAt === null
      ? []
      : [`Oldest quote: ${new Date(summary.oldestQuoteAt).toISOString()}`]),
    italic('Open PNL includes allocated entry fees; future sell network fees are excluded.'),
    italic('Open values use reference prices; actual sale proceeds can differ.'),
    ...(!summary.buys && !summary.sells ? ['', 'No confirmed trades in this period.'] : []),
    ...(missing
      ? ['', `${missing} sale(s) excluded: missing fill amounts, USD rates or entry history.`]
      : []),
    ...(summary.estimatedFills
      ? [`${summary.estimatedFills} legacy fill(s); historical timestamps may be approximate.`]
      : []),
    ...(missingQuotes ? ['Use Update open quotes to value missing or stale positions.'] : []),
    ...(updating ? ['', 'USD rates or open quotes are updating. Use Refresh view shortly.'] : []),
    '',
    italic(
      'Confirmed bot trades only. USD rates are saved per fill; closed trades are not revalued at current prices.',
    ),
  ]);
}
