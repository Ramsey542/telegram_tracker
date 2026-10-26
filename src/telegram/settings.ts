import {
  chainSettingsSchema,
  nativeDecimals,
  parseAmount,
  type Chain,
  type ChainSettings,
} from '../domain.js';

export interface EditableField {
  label: string;
  hint: string;
  group: 'buy' | 'consistency' | 'filters' | 'exits' | 'execution';
  value: (settings: ChainSettings) => string | number | null;
  set: (settings: ChainSettings, value: string) => void;
  chains?: Chain[];
}
const numeric = (
  value: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | null => {
  if (value.toLowerCase() === 'off') return null;
  if (!/^\d+(?:\.\d+)?$/.test(value))
    throw new Error('Enter a positive number, or off to clear this limit');
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`Enter a value between ${minimum} and ${maximum}`);
  return parsed;
};
const amount = (value: string): string | null => {
  if (value.toLowerCase() === 'off') return null;
  if (parseAmount(value, 18) <= 0n) throw new Error('Amount must be greater than zero');
  return value;
};
export const editableFields: Record<string, EditableField> = {
  buySize: {
    label: 'Buy size',
    hint: 'Enter the native coin amount to spend per new token.',
    group: 'buy',
    value: (s) => s.buySizeNative,
    set: (s, v) => {
      s.buySizeNative = amount(v);
    },
  },
  overall: {
    label: 'Overall consistency',
    hint: 'Enter the minimum overall consistency from 0 to 100.',
    group: 'consistency',
    value: (s) => s.consistency.overall,
    set: (s, v) => {
      s.consistency.overall = numeric(v, 0, 100) ?? 30;
    },
  },
  recent: {
    label: 'Recent consistency',
    hint: 'Enter the minimum recent consistency from 0 to 100.',
    group: 'consistency',
    value: (s) => s.consistency.recent,
    set: (s, v) => {
      s.consistency.recent = numeric(v, 0, 100) ?? 30;
    },
  },
  chainRate: {
    label: 'Chain consistency',
    hint: 'Enter the minimum chain consistency from 0 to 100.',
    group: 'consistency',
    value: (s) => s.consistency.chain,
    set: (s, v) => {
      s.consistency.chain = numeric(v, 0, 100) ?? 30;
    },
  },
  buySlippage: {
    label: 'Buy slippage (%)',
    hint: 'Enter buy slippage in percent, greater than 0 and at most 50.',
    group: 'execution',
    value: (s) => s.buySlippagePercent,
    set: (s, v) => {
      s.buySlippagePercent = numeric(v, 0.01, 50);
    },
  },
  sellSlippage: {
    label: 'Sell slippage (%)',
    hint: 'Enter sell slippage in percent, greater than 0 and at most 50.',
    group: 'execution',
    value: (s) => s.sellSlippagePercent,
    set: (s, v) => {
      s.sellSlippagePercent = numeric(v, 0.01, 50);
    },
  },
  maxFee: {
    label: 'Maximum network fee',
    hint: 'Enter the total native coin fee budget per trade, including transaction fees, approvals and wrapping.',
    group: 'execution',
    value: (s) => s.maxNetworkFeeNative,
    set: (s, v) => {
      s.maxNetworkFeeNative = amount(v);
    },
  },
  minMc: {
    label: 'Minimum current MC ($)',
    hint: 'Enter a minimum current market cap in USD, or off. Enable the market cap filter after setting the range.',
    group: 'filters',
    value: (s) => s.filters.minMarketCapUsd,
    set: (s, v) => {
      s.filters.minMarketCapUsd = numeric(v, 0.01);
      if (s.filters.minMarketCapUsd === null && s.filters.maxMarketCapUsd === null)
        s.filters.marketCapEnabled = false;
    },
  },
  maxMc: {
    label: 'Maximum current MC ($)',
    hint: 'Enter a maximum current market cap in USD, or off.',
    group: 'filters',
    value: (s) => s.filters.maxMarketCapUsd,
    set: (s, v) => {
      s.filters.maxMarketCapUsd = numeric(v, 0.01);
      if (s.filters.minMarketCapUsd === null && s.filters.maxMarketCapUsd === null)
        s.filters.marketCapEnabled = false;
    },
  },
  rugScore: {
    label: 'Maximum Rugcheck score',
    hint: 'Enter the maximum normalized risk score from 0 to 100. Lower scores are stricter. Then enable Rugcheck.',
    group: 'filters',
    chains: ['solana'],
    value: (s) => s.filters.maxRugcheckScore,
    set: (s, v) => {
      s.filters.maxRugcheckScore = numeric(v, 0, 100);
      if (s.filters.maxRugcheckScore === null) s.filters.rugcheckEnabled = false;
    },
  },
  liquidity: {
    label: 'Minimum liquidity ($)',
    hint: 'Enter minimum liquidity in USD. This limit becomes active when set; send off to disable it.',
    group: 'filters',
    value: (s) => s.filters.minLiquidityUsd,
    set: (s, v) => {
      s.filters.minLiquidityUsd = numeric(v, 0.01);
    },
  },
  holders: {
    label: 'Maximum top holder concentration (%)',
    hint: 'Enter the maximum aggregate top holder percentage, or off.',
    group: 'filters',
    chains: ['solana'],
    value: (s) => s.filters.maxTopHoldersPercent,
    set: (s, v) => {
      s.filters.maxTopHoldersPercent = numeric(v, 0.01, 100);
    },
  },
  tax: {
    label: 'Maximum token tax (%)',
    hint: 'Enter the maximum buy and sell tax percentage, or off.',
    group: 'filters',
    chains: ['robinhood'],
    value: (s) => s.filters.maxTaxPercent,
    set: (s, v) => {
      s.filters.maxTaxPercent = numeric(v, 0, 100);
    },
  },
  impact: {
    label: 'Maximum buy price impact (%)',
    hint: 'Enter the maximum buy price impact percentage, or off. Unknown impact is rejected while enabled.',
    group: 'filters',
    value: (s) => s.filters.maxPriceImpactPercent,
    set: (s, v) => {
      s.filters.maxPriceImpactPercent = numeric(v, 0.01, 100);
    },
  },
  sl: {
    label: 'Stop loss (%)',
    hint: 'Enter the loss percentage from entry. It sells all remaining tokens when enabled. Send off to remove it.',
    group: 'exits',
    value: (s) => s.exits.stopLoss.lossPercent,
    set: (s, v) => {
      s.exits.stopLoss.lossPercent = numeric(v, 0.01, 99.99);
      if (s.exits.stopLoss.lossPercent === null) s.exits.stopLoss.enabled = false;
    },
  },
  tslActivation: {
    label: 'Trailing SL activation (%)',
    hint: 'Enter the profit percentage that activates the trailing stop, including 0 to start at entry.',
    group: 'exits',
    value: (s) => s.exits.trailingSl.activationPercent,
    set: (s, v) => {
      s.exits.trailingSl.activationPercent = numeric(v, 0, 1_000_000);
      if (s.exits.trailingSl.activationPercent === null) s.exits.trailingSl.enabled = false;
    },
  },
  tslDrawdown: {
    label: 'Trailing SL distance (%)',
    hint: 'Enter the percentage retreat from the highest observed value. Trailing SL sells all remaining tokens.',
    group: 'exits',
    value: (s) => s.exits.trailingSl.drawdownPercent,
    set: (s, v) => {
      s.exits.trailingSl.drawdownPercent = numeric(v, 0.01, 99.99);
      if (s.exits.trailingSl.drawdownPercent === null) s.exits.trailingSl.enabled = false;
      s.exits.trailingSl.sellPercent = s.exits.trailingSl.drawdownPercent === null ? null : 100;
    },
  },
  ttpActivation: {
    label: 'Trailing TP activation (%)',
    hint: 'Enter the profit percentage that activates trailing take profit.',
    group: 'exits',
    value: (s) => s.exits.trailingTp.activationPercent,
    set: (s, v) => {
      s.exits.trailingTp.activationPercent = numeric(v, 0, 1_000_000);
      if (s.exits.trailingTp.activationPercent === null) s.exits.trailingTp.enabled = false;
    },
  },
  ttpDrawdown: {
    label: 'Trailing TP distance (%)',
    hint: 'Enter the percentage retreat from the highest value after activation.',
    group: 'exits',
    value: (s) => s.exits.trailingTp.drawdownPercent,
    set: (s, v) => {
      s.exits.trailingTp.drawdownPercent = numeric(v, 0.01, 99.99);
      if (s.exits.trailingTp.drawdownPercent === null) s.exits.trailingTp.enabled = false;
    },
  },
  ttpSell: {
    label: 'Trailing TP sell (%)',
    hint: 'Enter the percentage of the remaining balance to sell when trailing TP triggers.',
    group: 'exits',
    value: (s) => s.exits.trailingTp.sellPercent,
    set: (s, v) => {
      s.exits.trailingTp.sellPercent = numeric(v, 0.01, 100);
      if (s.exits.trailingTp.sellPercent === null) s.exits.trailingTp.enabled = false;
    },
  },
};
export function applyField(
  settings: ChainSettings,
  chain: Chain,
  field: string,
  value: string,
): ChainSettings {
  const definition = editableFields[field];
  if (!definition || (definition.chains && !definition.chains.includes(chain)))
    throw new Error('Unknown setting');
  const updated = structuredClone(settings);
  definition.set(updated, value.trim());
  for (const native of [updated.buySizeNative, updated.maxNetworkFeeNative])
    if (native !== null) parseAmount(native, nativeDecimals[chain]);
  return chainSettingsSchema.parse(updated);
}
export const toggles: Record<
  string,
  {
    label: string;
    group: EditableField['group'];
    chains?: Chain[];
    value: (s: ChainSettings) => boolean;
    change: (s: ChainSettings) => void;
  }
> = {
  mc: {
    label: 'Market cap filter',
    group: 'filters',
    value: (s) => s.filters.marketCapEnabled,
    change: (s) => {
      s.filters.marketCapEnabled = !s.filters.marketCapEnabled;
    },
  },
  rug: {
    label: 'Rugcheck',
    group: 'filters',
    chains: ['solana'],
    value: (s) => s.filters.rugcheckEnabled,
    change: (s) => {
      s.filters.rugcheckEnabled = !s.filters.rugcheckEnabled;
    },
  },
  mint: {
    label: 'Reject mint authority',
    group: 'filters',
    value: (s) => s.filters.rejectMintAuthority,
    change: (s) => {
      s.filters.rejectMintAuthority = !s.filters.rejectMintAuthority;
    },
  },
  freeze: {
    label: 'Reject freeze authority',
    group: 'filters',
    chains: ['solana'],
    value: (s) => s.filters.rejectFreezeAuthority,
    change: (s) => {
      s.filters.rejectFreezeAuthority = !s.filters.rejectFreezeAuthority;
    },
  },
  extensions: {
    label: 'Reject privileged token extensions',
    group: 'filters',
    chains: ['solana'],
    value: (s) => s.filters.rejectTokenExtensions,
    change: (s) => {
      s.filters.rejectTokenExtensions = !s.filters.rejectTokenExtensions;
    },
  },
  honeypot: {
    label: 'Reject honeypots',
    group: 'filters',
    chains: ['robinhood'],
    value: (s) => s.filters.rejectHoneypot,
    change: (s) => {
      s.filters.rejectHoneypot = !s.filters.rejectHoneypot;
    },
  },
  blacklist: {
    label: 'Reject blacklist capability',
    group: 'filters',
    chains: ['robinhood'],
    value: (s) => s.filters.rejectBlacklist,
    change: (s) => {
      s.filters.rejectBlacklist = !s.filters.rejectBlacklist;
    },
  },
  pausable: {
    label: 'Reject pausable transfers',
    group: 'filters',
    chains: ['robinhood'],
    value: (s) => s.filters.rejectPausable,
    change: (s) => {
      s.filters.rejectPausable = !s.filters.rejectPausable;
    },
  },
  proxy: {
    label: 'Reject upgradeable contracts',
    group: 'filters',
    chains: ['robinhood'],
    value: (s) => s.filters.rejectProxy,
    change: (s) => {
      s.filters.rejectProxy = !s.filters.rejectProxy;
    },
  },
  mev: {
    label: 'Require UniswapX protection',
    group: 'execution',
    chains: ['robinhood'],
    value: (s) => s.mevProtection,
    change: (s) => {
      s.mevProtection = !s.mevProtection;
    },
  },
  sl: {
    label: 'Fixed stop loss',
    group: 'exits',
    value: (s) => s.exits.stopLoss.enabled,
    change: (s) => {
      s.exits.stopLoss.enabled = !s.exits.stopLoss.enabled;
    },
  },
  tp: {
    label: 'Take profit stages',
    group: 'exits',
    value: (s) => s.exits.takeProfitEnabled,
    change: (s) => {
      s.exits.takeProfitEnabled = !s.exits.takeProfitEnabled;
    },
  },
  tsl: {
    label: 'Trailing stop loss',
    group: 'exits',
    value: (s) => s.exits.trailingSl.enabled,
    change: (s) => {
      s.exits.trailingSl.enabled = !s.exits.trailingSl.enabled;
    },
  },
  ttp: {
    label: 'Trailing take profit',
    group: 'exits',
    value: (s) => s.exits.trailingTp.enabled,
    change: (s) => {
      s.exits.trailingTp.enabled = !s.exits.trailingTp.enabled;
    },
  },
};
