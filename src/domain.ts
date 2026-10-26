import { z } from 'zod';

export const chains = ['solana', 'robinhood'] as const;
export type Chain = (typeof chains)[number];
export const nativeSymbol = { solana: 'SOL', robinhood: 'ETH' } as const;
export const nativeDecimals = { solana: 9, robinhood: 18 } as const;
const percent = z.number().finite().min(0).max(100);
const positivePercent = percent.positive();
const positive = z.number().finite().positive();
const amount = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => /[1-9]/.test(value));

export const trailSchema = z
  .object({
    enabled: z.boolean().default(false),
    activationPercent: z.number().finite().min(0).nullable().default(null),
    drawdownPercent: positivePercent.max(99.99).nullable().default(null),
    sellPercent: positivePercent.nullable().default(null),
  })
  .refine(
    (value) =>
      !value.enabled ||
      (value.activationPercent !== null &&
        value.drawdownPercent !== null &&
        value.sellPercent !== null),
    'Configure activation, drawdown and sell percentage before enabling trailing',
  );

export const exitSchema = z
  .object({
    stopLoss: z
      .object({
        enabled: z.boolean().default(false),
        lossPercent: positivePercent.max(99.99).nullable().default(null),
      })
      .default(() => ({ enabled: false, lossPercent: null })),
    takeProfitEnabled: z.boolean().default(false),
    takeProfits: z
      .array(
        z.object({
          id: z.string(),
          profitPercent: positive.min(0.01).max(1_000_000),
          sellPercent: z.union([positivePercent, z.literal('rest')]),
        }),
      )
      .default(() => []),
    trailingSl: trailSchema.default(() => ({
      enabled: false,
      activationPercent: null,
      drawdownPercent: null,
      sellPercent: null,
    })),
    trailingTp: trailSchema.default(() => ({
      enabled: false,
      activationPercent: null,
      drawdownPercent: null,
      sellPercent: null,
    })),
  })
  .superRefine((value, context) => {
    if (value.stopLoss.enabled && value.stopLoss.lossPercent === null)
      context.addIssue({ code: 'custom', message: 'Set a stop loss before enabling it' });
    if (value.takeProfitEnabled && value.takeProfits.length === 0)
      context.addIssue({ code: 'custom', message: 'Add a take profit before enabling it' });
    const sorted = [...value.takeProfits].sort((a, b) => a.profitPercent - b.profitPercent);
    let total = 0;
    const targets = new Set<number>();
    sorted.forEach((tier, index) => {
      if (targets.has(tier.profitPercent))
        context.addIssue({ code: 'custom', message: 'Take profit targets must be distinct' });
      targets.add(tier.profitPercent);
      if (tier.sellPercent === 'rest') {
        if (index !== sorted.length - 1)
          context.addIssue({ code: 'custom', message: 'The remaining-token target must be last' });
      } else total += tier.sellPercent;
    });
    if (total > 100.000001)
      context.addIssue({
        code: 'custom',
        message: 'Take profit sales exceed 100% of the original tokens',
      });
  });

export const filterSchema = z
  .object({
    marketCapEnabled: z.boolean().default(false),
    minMarketCapUsd: positive.nullable().default(null),
    maxMarketCapUsd: positive.nullable().default(null),
    rugcheckEnabled: z.boolean().default(false),
    maxRugcheckScore: z.number().int().min(0).max(100).nullable().default(null),
    rejectMintAuthority: z.boolean().default(false),
    rejectFreezeAuthority: z.boolean().default(false),
    rejectTokenExtensions: z.boolean().default(false),
    rejectHoneypot: z.boolean().default(false),
    rejectBlacklist: z.boolean().default(false),
    rejectPausable: z.boolean().default(false),
    rejectProxy: z.boolean().default(false),
    maxTaxPercent: percent.nullable().default(null),
    minLiquidityUsd: positive.nullable().default(null),
    maxTopHoldersPercent: positivePercent.nullable().default(null),
    maxPriceImpactPercent: positivePercent.nullable().default(null),
  })
  .superRefine((value, context) => {
    if (value.marketCapEnabled && value.minMarketCapUsd === null && value.maxMarketCapUsd === null)
      context.addIssue({ code: 'custom', message: 'Set at least one market cap limit first' });
    if (
      value.minMarketCapUsd !== null &&
      value.maxMarketCapUsd !== null &&
      value.minMarketCapUsd > value.maxMarketCapUsd
    )
      context.addIssue({ code: 'custom', message: 'Minimum market cap exceeds maximum' });
    if (value.rugcheckEnabled && value.maxRugcheckScore === null)
      context.addIssue({ code: 'custom', message: 'Set the maximum Rugcheck score first' });
  });

export const chainSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  buySizeNative: amount.nullable().default(null),
  buySlippagePercent: positivePercent.max(50).nullable().default(null),
  sellSlippagePercent: positivePercent.max(50).nullable().default(null),
  maxNetworkFeeNative: amount.nullable().default(null),
  jitoTipNative: amount.nullable().default(null),
  mevProtection: z.boolean().default(true),
  consistency: z
    .object({
      overall: percent.default(30),
      recent: percent.default(30),
      chain: percent.default(30),
    })
    .default(() => ({ overall: 30, recent: 30, chain: 30 })),
  filters: filterSchema.default(() => filterSchema.parse({})),
  exits: exitSchema.default(() => exitSchema.parse({})),
});

export const settingsSchema = z.object({
  tradingEnabled: z.boolean().default(false),
  blockedCallers: z.array(z.string()).default(() => []),
  chains: z.object({ solana: chainSettingsSchema, robinhood: chainSettingsSchema }).default(() => ({
    solana: chainSettingsSchema.parse({}),
    robinhood: chainSettingsSchema.parse({}),
  })),
});
export type Settings = z.infer<typeof settingsSchema>;
export type ChainSettings = z.infer<typeof chainSettingsSchema>;
export type ExitSettings = z.infer<typeof exitSchema>;
export type TrailRule = z.infer<typeof trailSchema>;

export interface ChannelPost {
  channelId: string;
  messageId: number;
  date: number;
  text: string;
  urls: string[];
  revision: number;
}
export interface CallSignal {
  id: string;
  channelId: string;
  messageId: number;
  date: number;
  chain: Chain;
  address: string;
  caller: string;
  callerId: string | null;
  consistency: { overall: number; recent: number; chain: number };
  advertisedMarketCapUsd: number | null;
}
export interface TokenInfo {
  chain: Chain;
  address: string;
  symbol: string;
  decimals: number;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  usdPrice: number | null;
  fetchedAt: number;
}
export interface Quote {
  inputRaw: string;
  outputRaw: string;
  minOutputRaw: string;
  nativeUsd: number | null;
  priceImpactPercent: number | null;
  receivedAt: number;
}
export interface TrailState {
  active: boolean;
  peakNativeRaw: string;
  peakTokenRaw: string;
  sold: boolean;
}
export interface Position {
  id: string;
  chain: Chain;
  address: string;
  symbol: string;
  decimals: number;
  caller: string;
  originalTokenRaw: string;
  remainingTokenRaw: string;
  entryNativeRaw: string;
  entryFeeNativeRaw: string;
  entryUsd: number | null;
  realizedNativeRaw: string;
  realizedFeeNativeRaw: string;
  exits: ExitSettings;
  exitFills: Record<string, string>;
  trailingSl: TrailState;
  trailingTp: TrailState;
  openedAt: number;
  closedAt: number | null;
  lastProfitPercent: number | null;
  lastValueNativeRaw: string | null;
  lastValueUsd: number | null;
  lastError: string | null;
}
export interface SwapResult {
  tokenRaw: string;
  nativeRaw: string;
  feeNativeRaw: string;
  signature: string;
  nativeUsd: number | null;
}
export type OperationStatus = 'active' | 'confirmed' | 'failed' | 'review';
export interface EvmStep {
  type: 'evm';
  key: string;
  hash: string;
  serialized: string;
  submittedAt: number | null;
  gasPaidRaw: string | null;
}
export interface SolanaStep {
  type: 'solana';
  key: string;
  signature: string;
  serialized: string;
  lastValidBlockHeight: number;
  submittedAt: number | null;
  bundleId: string | null;
  jito: boolean;
}
export interface OrderStep {
  type: 'order';
  key: string;
  orderId: string;
  body: Record<string, unknown>;
  deadline: number;
  submittedAt: number | null;
  txHash: string | null;
}
export type TradeStep = EvmStep | SolanaStep | OrderStep;
export interface Operation {
  id: string;
  chain: Chain;
  address: string;
  kind: 'buy' | 'sell' | 'unwrap';
  status: OperationStatus;
  positionId: string | null;
  signal: CallSignal | null;
  exitKey: string | null;
  amountRaw: string;
  token: TokenInfo;
  settings: ChainSettings;
  steps: TradeStep[];
  quote: Quote | null;
  swapHash: string | null;
  outputRaw: string | null;
  minimumNativeRaw: string | null;
  createdAt: number;
  error: string | null;
}

export class PendingTrade extends Error {
  override name = 'PendingTrade';
}
export class ReviewRequired extends Error {
  override name = 'ReviewRequired';
}
export class TradeRejected extends Error {
  override name = 'TradeRejected';
}
export const emptyTrail = (): TrailState => ({
  active: false,
  peakNativeRaw: '0',
  peakTokenRaw: '1',
  sold: false,
});

export function normalizeAddress(chain: Chain, address: string): string {
  return chain === 'robinhood' ? address.toLowerCase() : address;
}
export function parseAmount(value: string, decimals: number): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))
    throw new Error('Enter a decimal number without commas or exponent notation');
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}
export function formatAmount(raw: bigint | string, decimals: number, digits = decimals): string {
  const value = BigInt(raw);
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const fraction = (absolute % scale)
    .toString()
    .padStart(decimals, '0')
    .slice(0, digits)
    .replace(/0+$/, '');
  return `${sign}${absolute / scale}${fraction ? `.${fraction}` : ''}`;
}
export const bps = (value: number): bigint => BigInt(Math.round(value * 100));
export function profitBps(nativeRaw: bigint, tokenRaw: bigint, position: Position): bigint {
  const cost = BigInt(position.entryNativeRaw) * tokenRaw;
  if (cost <= 0n) throw new Error('Position has no valid entry cost');
  return ((nativeRaw * BigInt(position.originalTokenRaw) - cost) * 10_000n) / cost;
}
