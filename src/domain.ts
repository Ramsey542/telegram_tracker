import { z } from 'zod';

export const chains = ['solana', 'robinhood', 'bnb'] as const;
export type Chain = (typeof chains)[number];
export type EvmChain = Exclude<Chain, 'solana'>;
export const chainLabel = {
  solana: 'Solana',
  robinhood: 'Robinhood',
  bnb: 'BNB Smart Chain',
} as const;
export const nativeSymbol = { solana: 'SOL', robinhood: 'ETH', bnb: 'BNB' } as const;
export const nativeDecimals = { solana: 9, robinhood: 18, bnb: 18 } as const;
const percent = z.number().finite().min(0).max(100);
const positivePercent = percent.positive();
const positive = z.number().finite().positive();
const amount = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  .refine((value) => /[1-9]/.test(value));

export const trailStageSchema = z.object({
  id: z.string().min(1),
  activationPercent: z.number().finite().min(0).max(1_000_000),
  drawdownPercent: positivePercent.max(99.99),
  sellPercent: z.union([positivePercent, z.literal('rest')]),
});
export const trailSchema = z
  .object({
    enabled: z.boolean().default(false),
    activationPercent: z.number().finite().min(0).nullable().default(null),
    drawdownPercent: positivePercent.max(99.99).nullable().default(null),
    sellPercent: positivePercent.nullable().default(null),
    stages: z.array(trailStageSchema).max(20).optional(),
  })
  .refine(
    (value) =>
      !value.enabled ||
      (value.stages?.length ?? 0) > 0 ||
      (value.activationPercent !== null &&
        value.drawdownPercent !== null &&
        value.sellPercent !== null),
    'Configure activation, drawdown and sell percentage before enabling trailing',
  )
  .superRefine((value, context) => {
    const activations = new Set<number>();
    const ids = new Set<string>();
    for (const stage of value.stages ?? []) {
      if (activations.has(stage.activationPercent) || ids.has(stage.id))
        context.addIssue({
          code: 'custom',
          message: 'Trailing stages must have distinct activation percentages and IDs',
        });
      activations.add(stage.activationPercent);
      ids.add(stage.id);
    }
  });

export const exitSchema = z
  .object({
    tpMode: z.enum(['hard', 'trailing']).optional(),
    slMode: z.enum(['hard', 'trailing']).optional(),
    timeExit: z
      .object({
        enabled: z.boolean().default(false),
        minutes: z.number().int().min(1).max(43200).nullable().default(null),
      })
      .default(() => ({ enabled: false, minutes: null })),
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
    if (value.timeExit.enabled && value.timeExit.minutes === null)
      context.addIssue({ code: 'custom', message: 'Set the time exit limit before enabling it' });
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
    buyOnlyFirstCaller: z.boolean().default(false),
    justLaunched: z.boolean().default(false),
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

export const chainSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    buySizeNative: amount.nullable().default(null),
    slippagePercent: positivePercent.max(50).nullable().optional(),
    // Unify saved slippage values using the lower configured percentage.
    buySlippagePercent: positivePercent.max(50).nullable().optional(),
    sellSlippagePercent: positivePercent.max(50).nullable().optional(),
    priorityFee: z
      .string()
      .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/)
      .nullable()
      .default(null),
    // Retained for compatibility with saved settings; Solana no longer adds Jito tips.
    jitoTipNative: amount.nullable().default(null),
    // Selects UniswapX on Robinhood. Solana protection is managed by its RPC provider.
    mevProtection: z.boolean().default(true),
    wrapMyEth: z.boolean().default(false),
    directTradingEnabled: z.boolean().default(false),
    consistency: z
      .object({
        overall: percent.default(30),
        recent: percent.default(30),
        chain: percent.default(30),
      })
      .default(() => ({ overall: 30, recent: 30, chain: 30 })),
    filters: filterSchema.default(() => filterSchema.parse({})),
    exits: exitSchema.default(() => exitSchema.parse({})),
  })
  .transform(({ buySlippagePercent, sellSlippagePercent, ...settings }) => {
    const legacy = [buySlippagePercent, sellSlippagePercent].filter(
      (value): value is number => typeof value === 'number',
    );
    return {
      ...settings,
      slippagePercent:
        settings.slippagePercent !== undefined
          ? settings.slippagePercent
          : legacy.length
            ? Math.min(...legacy)
            : null,
    };
  });

export const settingsSchema = z.object({
  blockedCallers: z.array(z.string()).default(() => []),
  chains: z
    .object({
      solana: chainSettingsSchema,
      robinhood: chainSettingsSchema,
      bnb: chainSettingsSchema.default(() => chainSettingsSchema.parse({ mevProtection: false })),
    })
    .default(() => ({
      solana: chainSettingsSchema.parse({}),
      robinhood: chainSettingsSchema.parse({}),
      bnb: chainSettingsSchema.parse({ mevProtection: false }),
    })),
});
export type Settings = z.infer<typeof settingsSchema>;
export type ChainSettings = z.infer<typeof chainSettingsSchema>;
export const channelRulesSchema = z.object({
  solana: chainSettingsSchema.default(() => chainSettingsSchema.parse({})),
  robinhood: chainSettingsSchema.default(() => chainSettingsSchema.parse({})),
  bnb: chainSettingsSchema.default(() => chainSettingsSchema.parse({ mevProtection: false })),
});
export type ChannelRules = z.infer<typeof channelRulesSchema>;
export type ExitSettings = z.infer<typeof exitSchema>;
export type TrailRule = z.infer<typeof trailSchema>;
export type TrailStage = z.infer<typeof trailStageSchema>;
export type ChannelMode = 'spydefi' | 'general';
export const senderFilterSchema = z
  .object({
    enabled: z.boolean().default(false),
    usernames: z
      .array(
        z
          .string()
          .trim()
          .transform((value) => value.replace(/^@/, '').toLowerCase())
          .pipe(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/)),
      )
      .max(100)
      .transform((values) => [...new Set(values)])
      .default([]),
  })
  .refine((value) => !value.enabled || value.usernames.length > 0, {
    message: 'Set at least one username before enabling the sender filter',
  });
export interface CallChannel {
  id: string;
  target: string;
  channelId: string | null;
  title: string;
  username: string | null;
  mode: ChannelMode;
  defaultChain: Chain | null;
  enabled: boolean;
  activatedAt: number;
  status: 'unresolved' | 'ready' | 'pending' | 'error';
  error: string | null;
  settingsKey?: string;
  settings?: ChannelRules;
  blockedCallers?: string[];
  isGroup?: boolean;
  senderFilter?: z.infer<typeof senderFilterSchema>;
}
export interface SourceInfo {
  sourceId?: string;
  sourceName?: string;
  mode?: ChannelMode;
  senderId?: string | null;
  senderUsername?: string | null;
}
export interface ConsistencyRates {
  overall: number;
  recent: number;
  chain: number;
}

export interface ChannelPost extends SourceInfo {
  channelId: string;
  messageId: number;
  date: number;
  text: string;
  urls: string[];
  revision: number;
}
export interface CallSignal extends SourceInfo {
  id: string;
  channelId: string;
  messageId: number;
  date: number;
  // First local detection time, independent of Telegram's publication time.
  detectedAt?: number;
  chain: Chain;
  address: string;
  caller: string;
  callerId: string | null;
  consistency: ConsistencyRates | null;
  firstCaller?: boolean;
  justLaunched?: boolean;
  advertisedMarketCapUsd: number | null;
  tokenName?: string;
}
export interface CallObservation {
  decision: 'pending' | 'skipped';
  reason: string;
  observedAt: number;
  thresholds: ConsistencyRates | null;
}
export interface CallHistoryItem {
  id: string;
  channelId: string;
  messageId: number;
  state: string;
  reason: string | null;
  signal: CallSignal | null;
  post: ChannelPost | null;
  observation: CallObservation | null;
  operation: {
    status: OperationStatus;
    error: string | null;
    hash: string | null;
    symbol: string;
  } | null;
}
export interface TokenInfo {
  chain: Chain;
  address: string;
  symbol: string;
  decimals: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  usdPrice: number | null;
  fetchedAt: number;
  topHoldersPercent?: number | null;
  marketSource?: string;
}
export interface Quote {
  inputRaw: string;
  outputRaw: string;
  minOutputRaw: string;
  nativeUsd: number | null;
  priceImpactPercent: number | null;
  receivedAt: number;
  source?: string;
  estimated?: boolean;
}
export interface PreparedQuote {
  provider: 'jupiter' | 'uniswap';
  response: unknown;
  receivedAt: number;
  inputRaw: string;
  slippagePercent: number;
  priorityFee: string | null;
}
export interface DirectEvmPlan {
  venue: 'flap' | 'pancake-v2' | 'pancake-v3' | 'pancake-infinity';
  to: string;
  spender: string | null;
  inputToken: string;
  outputToken: string;
  value: string;
  data: string;
  outputRaw: string;
  minimumRaw: string;
  permit2?: string;
  permitSigned?: boolean;
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
  entryOperationId?: string;
  sourceId?: string;
  sourceName?: string;
  executionSettings?: ChainSettings;
  directVenue?: 'pump' | 'pump-amm' | DirectEvmPlan['venue'];
  chain: Chain;
  address: string;
  symbol: string;
  decimals: number;
  caller: string;
  originalTokenRaw: string;
  remainingTokenRaw: string;
  entryNativeRaw: string;
  entrySwapNativeRaw?: string;
  entryFeeNativeRaw: string;
  entryUsd: number | null;
  entryMarketCapUsd?: number | null;
  entryMarketCapCapturedAt?: number;
  entryMarketCapAfterBuy?: boolean;
  timeExitOperationId?: string;
  realizedNativeRaw: string;
  realizedFeeNativeRaw: string;
  exits: ExitSettings;
  exitFills: Record<string, string>;
  trailingSl: TrailState;
  trailingTp: TrailState;
  trailingStages?: Record<string, TrailState>;
  openedAt: number;
  closedAt: number | null;
  lastProfitPercent: number | null;
  lastValueNativeRaw: string | null;
  lastValueUsd: number | null;
  lastError: string | null;
  fundsError?: string;
}
export interface SwapResult {
  tokenRaw: string;
  nativeRaw: string;
  swapNativeRaw?: string;
  feeNativeRaw: string;
  signature: string;
  nativeUsd: number | null;
  fundsError?: string;
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
  venue?: 'pump' | 'pump-amm';
  key: string;
  signature: string;
  serialized: string;
  lastValidBlockHeight: number;
  submittedAt: number | null;
  // Legacy fields allow saved Jito transactions to be reconciled without rerouting them.
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
export interface JupiterStep {
  type: 'jupiter';
  key: string;
  requestId: string;
  router: string;
  serialized: string;
  signature: string | null;
  lastValidBlockHeight: number | null;
  expiresAt: number | null;
  createdAt: number;
  submittedAt: number | null;
  lastAttemptAt: number | null;
  status: 'prepared' | 'submitted' | 'confirmed' | 'failed';
  executionCode: number | null;
  executionError: string | null;
  executionAmounts?: { inputRaw: string; outputRaw: string };
}
export type TradeStep = EvmStep | SolanaStep | OrderStep | JupiterStep;
export interface Operation {
  id: string;
  chain: Chain;
  address: string;
  kind: 'buy' | 'sell' | 'wrap' | 'unwrap' | 'withdraw';
  status: OperationStatus;
  positionId: string | null;
  signal: CallSignal | null;
  exitKey: string | null;
  exitDescription?: string;
  withdrawal?: { recipient: string; requestedBy: number };
  amountRaw: string;
  token: TokenInfo;
  approvalAmountRaw?: string;
  settings: ChainSettings;
  steps: TradeStep[];
  quote: Quote | null;
  preparedQuote?: PreparedQuote;
  directEvmPlan?: DirectEvmPlan;
  wrapAmountRaw?: string;
  wrapWarningSent?: boolean;
  funding?: { sourceId?: string };
  swapHash: string | null;
  outputRaw: string | null;
  createdAt: number;
  error: string | null;
  retryCount?: number;
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
  return chain === 'solana' ? address : address.toLowerCase();
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
export function entryCostRaw(position: Position): bigint {
  const amount =
    position.chain === 'solana' ? position.entrySwapNativeRaw : position.entryNativeRaw;
  if (amount === undefined)
    throw new ReviewRequired('Confirmed swap entry cost is unavailable; automatic exits must wait');
  return BigInt(amount);
}
export function profitBps(nativeRaw: bigint, tokenRaw: bigint, position: Position): bigint {
  const cost = entryCostRaw(position) * tokenRaw;
  if (cost <= 0n) throw new Error('Position has no valid entry cost');
  return ((nativeRaw * BigInt(position.originalTokenRaw) - cost) * 10_000n) / cost;
}
