import { z } from 'zod';
import bs58 from 'bs58';
import {
  Connection,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  type TransactionInstruction,
  SendTransactionError,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { Config } from '../config.js';
import type { Wallets } from '../wallets.js';
import { withdrawalAddress } from '../trading/withdrawal.js';
import {
  PendingTrade,
  ReviewRequired,
  TradeRejected,
  type ChainSettings,
  type JupiterStep,
  type Operation,
  type Quote,
  type SolanaStep,
  type SwapResult,
  type TokenInfo,
  type Position,
} from '../domain.js';
import { ApiError, HttpClient, safeError } from '../infra/http.js';
import { MarketData } from '../providers/market.js';
import type { ChainAdapter } from './types.js';
import { solanaPriorityLamports } from './fees.js';
import { logger } from '../logging/logger.js';
import { PumpRoutes, pumpFill, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID } from './pump.js';
import { solanaSwapProvider } from './solana-routing.js';
import { NativePrices } from '../providers/native-prices.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';

const log = logger.child({ component: 'trading.solana', chain: 'solana' });
const baseUrl = 'https://api.jup.ag/swap/v2';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const unsignedRaw = z.string().regex(/^\d+$/);
const orderSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: unsignedRaw,
  outAmount: unsignedRaw,
  otherAmountThreshold: unsignedRaw,
  inUsdValue: z.number().finite().nullish(),
  outUsdValue: z.number().finite().nullish(),
  swapUsdValue: z.number().finite().nullish(),
  priceImpact: z.number().finite().nullish(),
  priceImpactPct: z.string().nullish(),
  router: z.string().optional(),
});
const executableOrderSchema = orderSchema.extend({
  transaction: z.string().nullable(),
  requestId: z.string().min(1),
  slippageBps: z.number().int().min(0).max(10_000),
  transactionVersion: z.number().optional(),
  taker: z.string().nullish(),
  lastValidBlockHeight: z.coerce.number().int().positive().safe().nullish(),
  expireAt: z.string().nullish(),
  errorCode: z.number().nullish(),
  errorMessage: z.string().nullish(),
  error: z.string().nullish(),
  prioritizationFeeLamports: z.number().int().nonnegative().safe().nullish(),
  signatureFeeLamports: z.number().int().nonnegative().safe().nullish(),
  rentFeeLamports: z.number().int().nonnegative().safe().nullish(),
  feeBps: z.number().nullish(),
  feeMint: z.string().nullish(),
});
export async function requestJupiterOrder(
  http: HttpClient,
  apiKey: string,
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  taker: string,
  settings: Pick<ChainSettings, 'slippagePercent' | 'priorityFee'>,
) {
  if (!apiKey) throw new TradeRejected('JUPITER_API_KEY is missing for this Jupiter route');
  if (settings.slippagePercent === null) throw new TradeRejected('Set slippage before trading');
  const query = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountRaw,
    taker,
    slippageBps: String(Math.round(settings.slippagePercent * 100)),
    maxSupportedTransactionVersion: '0',
  });
  if (settings.priorityFee !== null) {
    query.set('priorityFeeLamports', String(solanaPriorityLamports(settings.priorityFee)));
    query.set('broadcastFeeType', 'exactFee');
  }
  return http.json('Jupiter order', `${baseUrl}/order?${query}`, executableOrderSchema, {
    headers: { 'x-api-key': apiKey },
  });
}
const executionSchema = z.object({
  status: z.enum(['Success', 'Failed']).optional(),
  signature: z.string().nullish(),
  code: z.number().int().optional(),
  error: z.string().nullish(),
  totalInputAmount: unsignedRaw.nullish(),
  totalOutputAmount: unsignedRaw.nullish(),
});

function priceImpact(order: z.infer<typeof orderSchema>): number | null {
  const value =
    order.priceImpact ?? (order.priceImpactPct == null ? null : Number(order.priceImpactPct) * 100);
  return value !== null && Number.isFinite(value) ? Math.abs(value) : null;
}
function validSignature(value: string): boolean {
  try {
    const bytes = bs58.decode(value);
    return bytes.length === 64 && bytes.some((byte) => byte !== 0);
  } catch {
    return false;
  }
}

export function solanaTokenDelta(
  receipt: VersionedTransactionResponse,
  mint: string,
  owner: string,
): bigint {
  const before = receipt.meta?.preTokenBalances ?? [];
  const after = receipt.meta?.postTokenBalances ?? [];
  const owned = new Set(
    [...before, ...after]
      .filter((balance) => balance.mint === mint && balance.owner === owner)
      .map((balance) => balance.accountIndex),
  );
  const sum = (balances: typeof before): bigint =>
    balances
      .filter((balance) => balance.mint === mint && owned.has(balance.accountIndex))
      .reduce((total, balance) => total + BigInt(balance.uiTokenAmount.amount), 0n);
  return sum(after) - sum(before);
}

export class SolanaAdapter implements ChainAdapter {
  readonly chain = 'solana' as const;
  readonly address: string;
  private readonly connection: Connection | null;
  private networkVerification: Promise<void> | null = null;
  private pump: PumpRoutes | null = null;
  private readonly nativePrices: NativePrices;
  private pumpRoutes(): PumpRoutes {
    return (this.pump ??= new PumpRoutes(this.rpc(), this.wallets.solana.publicKey));
  }
  constructor(
    private readonly config: Config,
    private readonly wallets: Wallets,
    private readonly http: HttpClient,
    private readonly market: MarketData,
  ) {
    this.address = wallets.solana.publicKey.toBase58();
    this.nativePrices = new NativePrices(http);
    this.connection = config.solanaRpc
      ? new Connection(config.solanaRpc, {
          commitment: 'confirmed',
          disableRetryOnRateLimit: true,
          confirmTransactionInitialTimeout: config.httpTimeoutMs,
          fetch: (input, init) => this.http.fetch('QuickNode Solana RPC', input, init),
        })
      : null;
  }
  private rpc(): Connection {
    if (!this.connection) throw new Error('QUICKNODE_SOLANA_RPC_URL is missing');
    return this.connection;
  }
  readiness(_settings: ChainSettings): string[] {
    const missing: string[] = [];
    if (!this.config.solanaRpc) missing.push('QUICKNODE_SOLANA_RPC_URL');
    return missing;
  }
  async verifyNetwork(): Promise<void> {
    this.networkVerification ??= this.rpc()
      .getGenesisHash()
      .then((hash) => {
        if (hash !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
          throw new Error('QuickNode endpoint is not Solana mainnet');
      })
      .catch((error: unknown) => {
        this.networkVerification = null;
        throw error;
      });
    await this.networkVerification;
  }
  async balance(): Promise<{ nativeRaw: string; wrappedRaw: null }> {
    return {
      nativeRaw: (
        await this.rpc().getBalance(this.wallets.solana.publicKey, 'confirmed')
      ).toString(),
      wrappedRaw: null,
    };
  }
  async tokenInfo(address: string, settings?: ChainSettings): Promise<TokenInfo> {
    new PublicKey(address);
    if (solanaSwapProvider(address) === 'pump') {
      const rate = await this.nativePrices.get('solana');
      const direct = await this.pumpRoutes().tokenInfo(address, rate.value);
      if (direct) {
        if (settings?.filters.maxTopHoldersPercent != null) {
          const data = await this.market.solana(address);
          direct.topHoldersPercent = data?.audit?.topHoldersPercentage ?? null;
        }
        return direct;
      }
    }
    const data = await this.market.solana(address);
    return {
      chain: this.chain,
      address,
      symbol: data?.symbol ?? address.slice(0, 8),
      decimals: data?.decimals ?? null,
      marketCapUsd: data?.mcap ?? null,
      liquidityUsd: data?.liquidity ?? null,
      usdPrice: data?.usdPrice ?? null,
      topHoldersPercent: data?.audit?.topHoldersPercentage ?? null,
      fetchedAt: Date.now(),
    };
  }
  async quoteSell(address: string, amountRaw: string, settings: ChainSettings): Promise<Quote> {
    if (settings.slippagePercent === null) throw new Error('Slippage is not configured');
    if (solanaSwapProvider(address) === 'pump') {
      const direct = await this.pumpRoutes().quote(
        address,
        BigInt(amountRaw),
        false,
        settings.slippagePercent,
        false,
      );
      if (direct) return direct.quote;
      throw new TradeRejected(
        'No supported Pump SDK route is available for this pump-suffix token',
      );
    }
    if (!this.config.jupiterKey)
      throw new TradeRejected('JUPITER_API_KEY is missing for this Jupiter route');
    const query = new URLSearchParams({
      inputMint: address,
      outputMint: SOL_MINT,
      amount: amountRaw,
      slippageBps: String(Math.round(settings.slippagePercent * 100)),
      maxSupportedTransactionVersion: '0',
    });
    const order = await this.http.json('Jupiter quote', `${baseUrl}/order?${query}`, orderSchema, {
      headers: { 'x-api-key': this.config.jupiterKey },
      retry: false,
    });
    if (
      order.inputMint !== address ||
      order.outputMint !== SOL_MINT ||
      order.inAmount !== amountRaw ||
      BigInt(order.outAmount) <= 0n
    )
      throw new Error('Jupiter quote does not match the requested sale');
    const nativeUsdValue = order.outUsdValue ?? order.swapUsdValue;
    const quote: Quote = {
      inputRaw: amountRaw,
      outputRaw: order.outAmount,
      minOutputRaw: order.otherAmountThreshold,
      nativeUsd:
        typeof nativeUsdValue === 'number' && nativeUsdValue > 0
          ? nativeUsdValue / (Number(order.outAmount) / 1e9)
          : null,
      priceImpactPercent: priceImpact(order),
      receivedAt: Date.now(),
    };
    return quote;
  }
  async advance(
    operation: Operation,
    persist: () => void,
    beforeSwap: () => Promise<void>,
    beforeSpend: () => void,
  ): Promise<SwapResult> {
    if (this.config.listenOnly)
      throw new TradeRejected('LISTEN_ONLY=true: Solana execution is blocked');
    if (operation.kind === 'withdraw')
      return this.advanceWithdrawal(operation, persist, beforeSpend);
    const legacy = operation.steps.find((step): step is SolanaStep => step.type === 'solana');
    if (legacy) return this.advanceLegacy(operation, legacy, persist);
    if (
      solanaSwapProvider(operation.address) === 'pump' &&
      operation.steps.length === 0 &&
      !operation.preparedQuote
    ) {
      const route = await this.pumpRoutes().quote(
        operation.address,
        BigInt(operation.amountRaw),
        operation.kind === 'buy',
        operation.settings.slippagePercent!,
        true,
      );
      if (route) {
        await beforeSwap();
        const limit = operation.settings.filters.maxPriceImpactPercent;
        if (
          operation.kind === 'buy' &&
          limit !== null &&
          (route.quote.priceImpactPercent === null || route.quote.priceImpactPercent > limit)
        )
          throw new TradeRejected('Pump price impact exceeds the configured limit');
        operation.token = { ...operation.token, decimals: route.token.decimals };
        operation.quote = route.quote;
        const step = await this.preparePump(
          operation,
          route.instructions,
          route.venue,
          beforeSpend,
        );
        operation.steps.push(step);
        persist();
        beforeSpend();
        step.submittedAt = Date.now();
        persist();
        try {
          const signature = await this.rpc().sendRawTransaction(
            Buffer.from(step.serialized, 'base64'),
            { skipPreflight: false, maxRetries: 0 },
          );
          if (signature !== step.signature)
            throw new ReviewRequired('QuickNode returned an unexpected Pump transaction signature');
        } catch (error) {
          if (error instanceof ReviewRequired) throw error;
          if (error instanceof SendTransactionError)
            throw new TradeRejected(`Pump transaction simulation rejected: ${safeError(error)}`);
          log.error('transaction.pump_submission_uncertain', error, {
            operationId: operation.id,
            signature: step.signature,
          });
          throw new PendingTrade(
            'Pump submission outcome is uncertain; the saved transaction will be reconciled',
          );
        }
        throw new PendingTrade('Waiting for Pump transaction confirmation');
      }
      throw new TradeRejected(
        'No supported Pump SDK route is available for this pump-suffix token',
      );
    }
    let step = operation.steps.find(
      (candidate): candidate is JupiterStep => candidate.type === 'jupiter',
    );
    if (!step) {
      step = await this.prepare(operation, beforeSwap, beforeSpend);
      operation.steps.push(step);
      persist();
    } else {
      const result = await this.reconcile(operation, step);
      if (result) return result;
      if (step.status === 'prepared') await beforeSwap();
    }
    if (step.status === 'confirmed')
      throw new PendingTrade('Jupiter confirmed the swap; waiting for its QuickNode receipt');
    if (step.status === 'failed')
      throw new PendingTrade(
        `Jupiter execution failed (${step.executionCode}): ${step.executionError}; reconciling the saved transaction`,
      );
    if (step.lastAttemptAt !== null && Date.now() - step.lastAttemptAt < 15_000)
      throw new PendingTrade('Waiting before checking the same Jupiter execution again');
    const savedStep = step;
    const result = await this.http.json('Jupiter execute', `${baseUrl}/execute`, executionSchema, {
      method: 'POST',
      body: {
        signedTransaction: step.serialized,
        requestId: step.requestId,
        ...(step.lastValidBlockHeight === null
          ? {}
          : { lastValidBlockHeight: String(step.lastValidBlockHeight) }),
      },
      headers: { 'x-api-key': this.config.jupiterKey },
      retry: false,
      timeoutMs: Math.max(60_000, this.config.httpTimeoutMs),
      beforeRequest: () => {
        if (savedStep.submittedAt === null) {
          if (
            Date.now() - savedStep.createdAt > 30_000 ||
            (savedStep.expiresAt !== null && Date.now() >= savedStep.expiresAt) ||
            (operation.kind === 'buy' && Date.now() - operation.token.fetchedAt > 30_000)
          )
            throw new TradeRejected('Jupiter order or entry filter data expired before submission');
          beforeSpend();
        }
        savedStep.submittedAt ??= Date.now();
        savedStep.lastAttemptAt = Date.now();
        savedStep.status = 'submitted';
        persist();
        log.info('transaction.execute_started', {
          operationId: operation.id,
          service: 'Jupiter execute',
          jupiterRequestId: savedStep.requestId,
          router: savedStep.router,
          signature: savedStep.signature,
          elapsedMs: Date.now() - savedStep.createdAt,
        });
      },
    });
    if (result.signature) {
      if (
        !validSignature(result.signature) ||
        (step.signature !== null && step.signature !== result.signature)
      )
        throw new ReviewRequired('Jupiter returned an unexpected transaction signature');
      step.signature = result.signature;
    }
    step.executionCode = result.code ?? null;
    step.executionError = result.error ?? null;
    step.status = result.status === 'Success' && result.code === 0 ? 'confirmed' : 'failed';
    if (
      step.status === 'confirmed' &&
      (result.totalInputAmount != null || result.totalOutputAmount != null)
    )
      step.executionAmounts = {
        inputRaw: result.totalInputAmount ?? '0',
        outputRaw: result.totalOutputAmount ?? '0',
      };
    persist();
    if (step.status === 'confirmed') {
      log.info('transaction.execute_confirmed', {
        operationId: operation.id,
        jupiterRequestId: step.requestId,
        signature: step.signature,
        executionAmounts: step.executionAmounts,
        durationMs: Date.now() - (step.lastAttemptAt ?? step.createdAt),
      });
      if (step.signature === null)
        throw new ReviewRequired('Jupiter reported success without a transaction signature');
    } else {
      log.error(
        'transaction.execute_failed',
        new ApiError(
          `Jupiter execute failed (${step.executionCode}): ${step.executionError ?? 'Unknown execution result'}`,
          {
            service: 'Jupiter execute',
            endpoint: `${baseUrl}/execute`,
            responseBody: result,
            jupiterRequestId: step.requestId,
            router: step.router,
          },
        ),
      );
    }
    const receipt = await this.reconcile(operation, step);
    if (receipt) return receipt;
    throw new PendingTrade('Waiting for the saved Jupiter transaction to be reconciled');
  }
  private async prepare(
    operation: Operation,
    beforeSwap: () => Promise<void>,
    beforeSpend: () => void,
  ): Promise<JupiterStep> {
    const slippage = operation.settings.slippagePercent;
    if (slippage === null) throw new TradeRejected('Set slippage before trading');
    new PublicKey(operation.address);
    const inputMint = operation.kind === 'buy' ? SOL_MINT : operation.address;
    const outputMint = operation.kind === 'buy' ? operation.address : SOL_MINT;
    const slippageBps = Math.round(slippage * 100);
    const priority = operation.settings.priorityFee;
    const started = Date.now();
    log.info('transaction.order_requested', {
      service: 'Jupiter order',
      operationId: operation.id,
      inputMint,
      outputMint,
      amountRaw: operation.amountRaw,
      slippageBps,
      requestedPriorityFeeSol: priority,
    });
    const [orderResult, filterResult] = await Promise.allSettled([
      requestJupiterOrder(
        this.http,
        this.config.jupiterKey,
        inputMint,
        outputMint,
        operation.amountRaw,
        this.address,
        operation.settings,
      ).then((order) => ({ order, receivedAt: Date.now() })),
      beforeSwap(),
    ]);
    if (filterResult.status === 'rejected') throw filterResult.reason;
    if (orderResult.status === 'rejected') throw orderResult.reason;
    const { order, receivedAt } = orderResult.value;
    if (
      order.error ||
      order.errorMessage ||
      (order.errorCode != null && order.errorCode !== 0) ||
      !order.transaction
    ) {
      const error = new TradeRejected(
        `Jupiter order rejected (${order.router ?? 'unknown'} / ${order.errorCode ?? 'unknown'}): ${order.errorMessage ?? order.error ?? 'No executable transaction'}`,
      );
      log.error('transaction.order_rejected', error, {
        service: 'Jupiter order',
        jupiterRequestId: order.requestId,
        responseBody: order,
      });
      throw error;
    }
    if (
      order.inputMint !== inputMint ||
      order.outputMint !== outputMint ||
      order.inAmount !== operation.amountRaw ||
      order.transactionVersion === 1 ||
      (order.taker != null && order.taker !== this.address) ||
      order.slippageBps > slippageBps ||
      BigInt(order.outAmount) <= 0n ||
      BigInt(order.otherAmountThreshold) <= 0n ||
      BigInt(order.otherAmountThreshold) <
        (BigInt(order.outAmount) * BigInt(10_000 - slippageBps)) / 10_000n
    )
      throw new TradeRejected('Jupiter order does not match the configured trade');
    const impact = priceImpact(order);
    const maximumImpact = operation.settings.filters.maxPriceImpactPercent;
    if (
      operation.kind === 'buy' &&
      maximumImpact !== null &&
      (impact === null || impact > maximumImpact)
    )
      throw new TradeRejected('Price impact is unknown or exceeds the configured limit');
    const expiresAt = order.expireAt == null ? null : Date.parse(order.expireAt);
    if (
      (expiresAt !== null && (!Number.isFinite(expiresAt) || Date.now() >= expiresAt)) ||
      Date.now() - receivedAt > 30_000 ||
      Date.now() - operation.token.fetchedAt > 30_000
    )
      throw new TradeRejected('Jupiter order or entry filter data expired before signing');
    const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, 'base64'));
    if (transaction.version !== 0 || transaction.serialize().length > 1232)
      throw new TradeRejected('Unsupported Jupiter transaction version or size');
    const signers = transaction.message.staticAccountKeys.slice(
      0,
      transaction.message.header.numRequiredSignatures,
    );
    if (
      !signers.some((key) => key.equals(this.wallets.solana.publicKey)) ||
      transaction.signatures.length !== signers.length
    )
      throw new TradeRejected('Wallet is not a valid required signer in the Jupiter transaction');
    beforeSpend();
    transaction.sign([this.wallets.solana]);
    const firstSignature = transaction.signatures[0];
    const signature = firstSignature?.some((byte) => byte !== 0)
      ? bs58.encode(firstSignature)
      : null;
    const nativeValue =
      (operation.kind === 'buy' ? order.inUsdValue : order.outUsdValue) ?? order.swapUsdValue;
    const nativeRaw = operation.kind === 'buy' ? order.inAmount : order.outAmount;
    operation.quote = {
      inputRaw: order.inAmount,
      outputRaw: order.outAmount,
      minOutputRaw: order.otherAmountThreshold,
      nativeUsd:
        typeof nativeValue === 'number' && nativeValue > 0 && BigInt(nativeRaw) > 0n
          ? nativeValue / (Number(nativeRaw) / 1e9)
          : (operation.quote?.nativeUsd ?? null),
      priceImpactPercent: impact,
      receivedAt,
    };
    log.info('transaction.order_prepared', {
      operationId: operation.id,
      service: 'Jupiter order',
      jupiterRequestId: order.requestId,
      router: order.router,
      durationMs: Date.now() - started,
      quote: operation.quote,
      priorityFeeLamports: order.prioritizationFeeLamports,
      signatureFeeLamports: order.signatureFeeLamports,
      rentFeeLamports: order.rentFeeLamports,
      feeBps: order.feeBps,
      feeMint: order.feeMint,
    });
    return {
      type: 'jupiter',
      key: 'swap',
      requestId: order.requestId,
      router: order.router ?? 'unknown',
      serialized: Buffer.from(transaction.serialize()).toString('base64'),
      signature,
      lastValidBlockHeight: order.lastValidBlockHeight ?? null,
      expiresAt,
      createdAt: receivedAt,
      submittedAt: null,
      lastAttemptAt: null,
      status: 'prepared',
      executionCode: null,
      executionError: null,
    };
  }
  private async reconcile(operation: Operation, step: JupiterStep): Promise<SwapResult | null> {
    if (step.signature !== null) {
      await this.verifyNetwork();
      const receipt = await this.rpc().getTransaction(step.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      if (receipt?.meta)
        return this.accountReceipt(operation, step.signature, receipt, step.executionAmounts);
      if (
        step.submittedAt !== null &&
        (Date.now() - step.submittedAt > 30_000 || step.status === 'failed')
      ) {
        const status = (
          await this.rpc().getSignatureStatuses([step.signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        if (status?.err) throw new TradeRejected('Solana swap failed on chain');
        if (!status && step.status !== 'confirmed' && step.lastValidBlockHeight !== null) {
          const height = await this.rpc().getBlockHeight('finalized');
          if (height > step.lastValidBlockHeight + 32)
            throw new TradeRejected('Jupiter transaction expired without an on-chain execution');
        }
        log.info('transaction.confirmation_check', {
          operationId: operation.id,
          signature: step.signature,
          status,
          jupiterRequestId: step.requestId,
          executionStatus: step.status,
        });
        if (status && Date.now() - step.submittedAt > 120_000)
          throw new ReviewRequired(
            'Solana signature exists but transaction accounting is unavailable',
          );
      }
    }
    if (
      step.status === 'confirmed' &&
      step.lastAttemptAt !== null &&
      Date.now() - step.lastAttemptAt > 120_000
    )
      throw new ReviewRequired(
        'Jupiter confirmed the swap but its QuickNode receipt is still unavailable',
      );
    if (step.status === 'failed' && step.signature === null)
      throw new ReviewRequired(
        `Jupiter execution failed (${step.executionCode}): ${step.executionError ?? 'No transaction signature was returned'}; verify before retrying`,
      );
    if (
      step.submittedAt !== null &&
      step.lastValidBlockHeight === null &&
      Date.now() - step.submittedAt > 120_000
    )
      throw new ReviewRequired(
        'Jupiter execution outcome is unresolved; no new order will be created',
      );
    return null;
  }
  async directReference(position: Position): Promise<Quote> {
    return this.pumpRoutes().reference(position.address, position.remainingTokenRaw);
  }
  private async preparePump(
    operation: Operation,
    instructions: TransactionInstruction[],
    venue: 'pump' | 'pump-amm',
    beforeSpend: () => void,
  ): Promise<SolanaStep> {
    const allowed = new Set(
      [
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
        PUMP_PROGRAM_ID,
        PUMP_AMM_PROGRAM_ID,
        ComputeBudgetProgram.programId,
      ].map((key) => key.toBase58()),
    );
    if (
      !instructions.length ||
      instructions.some(
        (instruction) =>
          !allowed.has(instruction.programId.toBase58()) ||
          instruction.keys.some(
            (key) => key.isSigner && !key.pubkey.equals(this.wallets.solana.publicKey),
          ),
      )
    )
      throw new TradeRejected('Pump SDK returned unexpected instructions or signers');
    const limit = 600_000;
    let microLamports: bigint;
    if (operation.settings.priorityFee !== null)
      microLamports =
        (BigInt(solanaPriorityLamports(operation.settings.priorityFee)) * 1_000_000n) /
        BigInt(limit);
    else {
      const fees = await this.rpc().getRecentPrioritizationFees();
      const sorted = fees
        .map((fee) => fee.prioritizationFee)
        .filter((fee) => Number.isSafeInteger(fee) && fee >= 0)
        .sort((a, b) => a - b);
      microLamports = BigInt(sorted[Math.floor(sorted.length * 0.75)] ?? 0);
    }
    const block = await this.rpc().getLatestBlockhash('confirmed');
    const transaction = new VersionedTransaction(
      new TransactionMessage({
        payerKey: this.wallets.solana.publicKey,
        recentBlockhash: block.blockhash,
        instructions: [
          ComputeBudgetProgram.setComputeUnitLimit({ units: limit }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
          ...instructions,
        ],
      }).compileToV0Message(),
    );
    if (!operation.quote || Date.now() - operation.quote.receivedAt > 30_000)
      throw new TradeRejected('Pump quote expired before signing');
    beforeSpend();
    transaction.sign([this.wallets.solana]);
    log.info('transaction.pump_prepared', {
      operationId: operation.id,
      venue,
      computeUnits: limit,
      microLamports: microLamports.toString(),
      inputRaw: operation.amountRaw,
      quote: operation.quote,
    });
    return {
      type: 'solana',
      venue,
      key: 'swap',
      signature: bs58.encode(transaction.signatures[0]!),
      serialized: Buffer.from(transaction.serialize()).toString('base64'),
      lastValidBlockHeight: block.lastValidBlockHeight,
      submittedAt: null,
      bundleId: null,
      jito: false,
    };
  }
  private accountReceipt(
    operation: Operation,
    signature: string,
    receipt: VersionedTransactionResponse,
    executionAmounts?: JupiterStep['executionAmounts'],
  ): SwapResult {
    const meta = receipt.meta!;
    if (meta.err) {
      log.error('transaction.reverted', meta.err, {
        operationId: operation.id,
        signature,
        logs: meta.logMessages,
      });
      throw new TradeRejected('Solana swap reverted on chain');
    }
    operation.swapHash = signature;
    const tokenDelta = solanaTokenDelta(receipt, operation.address, this.address);
    const keys = receipt.transaction.message.getAccountKeys({
      accountKeysFromLookups: meta.loadedAddresses,
    });
    let walletIndex = -1;
    for (let index = 0; index < keys.length; index++)
      if (keys.get(index)?.toBase58() === this.address) walletIndex = index;
    const before = meta.preBalances[walletIndex];
    const after = meta.postBalances[walletIndex];
    if (
      before === undefined ||
      after === undefined ||
      !Number.isSafeInteger(before) ||
      !Number.isSafeInteger(after)
    )
      throw new ReviewRequired('Could not reconcile the confirmed Solana balance change');
    const decimals = new Set(
      [...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])]
        .filter((balance) => balance.mint === operation.address && balance.owner === this.address)
        .map((balance) => balance.uiTokenAmount.decimals),
    );
    const precision = [...decimals][0];
    if (
      decimals.size !== 1 ||
      precision === undefined ||
      !Number.isInteger(precision) ||
      precision < 0 ||
      precision > 36
    )
      throw new ReviewRequired('Could not reconcile the confirmed token decimals');
    operation.token.decimals = precision;
    const nativeDelta = BigInt(after) - BigInt(before);
    const tokenRaw = operation.kind === 'buy' ? tokenDelta : -tokenDelta;
    const nativeRaw = operation.kind === 'buy' ? -nativeDelta : nativeDelta;
    if (tokenRaw <= 0n || (operation.kind === 'buy' && nativeRaw <= 0n))
      throw new ReviewRequired('Confirmed Solana swap has unexpected balance changes');
    let swapNativeRaw: string | undefined;
    if (executionAmounts) {
      const input = BigInt(executionAmounts.inputRaw);
      const output = BigInt(executionAmounts.outputRaw);
      if (input <= 0n || output <= 0n || tokenRaw !== (operation.kind === 'buy' ? output : input))
        throw new ReviewRequired(
          'Jupiter execution amounts do not match the confirmed token receipt',
        );
      swapNativeRaw = (operation.kind === 'buy' ? input : output).toString();
    } else if (operation.kind === 'buy') {
      if (BigInt(operation.amountRaw) <= 0n)
        throw new ReviewRequired('Confirmed exact-input swap amount is unavailable');
      swapNativeRaw = operation.amountRaw;
    }
    const direct = operation.steps.find(
      (step): step is SolanaStep => step.type === 'solana' && step.venue !== undefined,
    );
    if (direct?.venue) {
      const fill = pumpFill(
        receipt,
        this.address,
        operation.address,
        direct.venue,
        operation.kind === 'buy',
      );
      if (
        fill.tokens !== tokenRaw ||
        (operation.kind === 'buy' && fill.native > BigInt(operation.amountRaw))
      )
        throw new ReviewRequired(
          'Pump fill events disagree with the confirmed token receipt or buy budget',
        );
      swapNativeRaw = fill.native.toString();
    }
    const feeNativeRaw = keys.get(0)?.toBase58() === this.address ? meta.fee.toString() : '0';
    log.info('transaction.accounted', {
      operationId: operation.id,
      kind: operation.kind,
      signature,
      tokenRaw: tokenRaw.toString(),
      swapNativeRaw,
      walletNativeRaw: nativeRaw.toString(),
      feeNativeRaw,
      priceSource: executionAmounts
        ? 'jupiter_execution'
        : operation.kind === 'buy'
          ? 'confirmed_exact_input'
          : 'unavailable',
    });
    return {
      tokenRaw: tokenRaw.toString(),
      nativeRaw: nativeRaw.toString(),
      swapNativeRaw,
      feeNativeRaw,
      signature,
      nativeUsd: operation.quote?.nativeUsd ?? null,
    };
  }
  private async advanceWithdrawal(
    operation: Operation,
    persist: () => void,
    beforeSpend: () => void,
  ): Promise<SwapResult> {
    await this.verifyNetwork();
    if (!operation.withdrawal) throw new TradeRejected('Withdrawal destination is missing');
    const recipient = withdrawalAddress('solana', operation.withdrawal.recipient, this.address);
    const amount = BigInt(operation.amountRaw);
    if (amount <= 0n) throw new TradeRejected('Withdrawal amount must be greater than zero');
    let step = operation.steps.find(
      (candidate): candidate is SolanaStep =>
        candidate.type === 'solana' && candidate.key === 'withdraw',
    );
    if (!step) {
      const latest = await this.rpc().getLatestBlockhash('confirmed');
      const transaction = new Transaction({
        feePayer: this.wallets.solana.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      if (operation.settings.priorityFee != null) {
        const units = 5_000;
        const lamports = BigInt(solanaPriorityLamports(operation.settings.priorityFee));
        transaction.add(
          ComputeBudgetProgram.setComputeUnitLimit({ units }),
          ComputeBudgetProgram.setComputeUnitPrice({
            microLamports: (lamports * 1_000_000n + BigInt(units) - 1n) / BigInt(units),
          }),
        );
      }
      transaction.add(
        SystemProgram.transfer({
          fromPubkey: this.wallets.solana.publicKey,
          toPubkey: new PublicKey(recipient),
          lamports: amount,
        }),
      );
      const fee = (await this.rpc().getFeeForMessage(transaction.compileMessage(), 'confirmed'))
        .value;
      if (fee === null || !Number.isSafeInteger(fee) || fee < 0)
        throw new TradeRejected('Solana withdrawal fee is unavailable');
      const balance = await this.rpc().getBalance(this.wallets.solana.publicKey, 'confirmed');
      if (!Number.isSafeInteger(balance) || BigInt(balance) < amount + BigInt(fee))
        throw new TradeRejected('Insufficient SOL for the withdrawal and network fee');
      beforeSpend();
      transaction.sign(this.wallets.solana);
      if (!transaction.signature) throw new TradeRejected('Withdrawal signature is missing');
      step = {
        type: 'solana',
        key: 'withdraw',
        signature: bs58.encode(transaction.signature),
        serialized: transaction.serialize().toString('base64'),
        lastValidBlockHeight: latest.lastValidBlockHeight,
        submittedAt: null,
        bundleId: null,
        jito: false,
      };
      operation.swapHash = step.signature;
      operation.steps.push(step);
      persist();
    }
    const receipt = await this.rpc().getTransaction(step.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (receipt?.meta) {
      if (receipt.meta.err) throw new TradeRejected('Solana withdrawal failed on chain');
      return {
        tokenRaw: '0',
        nativeRaw: (amount + BigInt(receipt.meta.fee)).toString(),
        feeNativeRaw: receipt.meta.fee.toString(),
        signature: step.signature,
        nativeUsd: null,
      };
    }
    const status = (
      await this.rpc().getSignatureStatuses([step.signature], {
        searchTransactionHistory: true,
      })
    ).value[0];
    if (status?.err) throw new TradeRejected('Solana withdrawal failed on chain');
    if (status && step.submittedAt !== null && Date.now() - step.submittedAt > 120_000)
      throw new ReviewRequired(
        'Solana withdrawal signature exists but its confirmed receipt is unavailable',
      );
    const height = await this.rpc().getBlockHeight('confirmed');
    if (height > step.lastValidBlockHeight + 32 && !status)
      throw new ReviewRequired(
        'Withdrawal expired without a confirmed receipt; inspect the saved signature before retrying',
      );
    if (
      !status &&
      height <= step.lastValidBlockHeight &&
      (step.submittedAt === null || Date.now() - step.submittedAt > 15_000)
    ) {
      beforeSpend();
      step.submittedAt = Date.now();
      persist();
      const signature = await this.rpc().sendRawTransaction(
        Buffer.from(step.serialized, 'base64'),
        {
          skipPreflight: false,
          preflightCommitment: 'confirmed',
          maxRetries: 0,
        },
      );
      if (signature !== step.signature)
        throw new ReviewRequired('RPC returned an unexpected withdrawal signature');
    }
    throw new PendingTrade('Waiting for Solana withdrawal confirmation');
  }
  private async advanceLegacy(
    operation: Operation,
    step: SolanaStep,
    persist: () => void,
  ): Promise<SwapResult> {
    if (!step.venue) await this.verifyNetwork();
    let receipt: VersionedTransactionResponse | null;
    try {
      receipt = await this.rpc().getTransaction(step.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
    } catch (error) {
      if (!step.venue) throw error;
      log.error('transaction.pump_receipt_failed', error, {
        operationId: operation.id,
        signature: step.signature,
      });
      throw new PendingTrade(
        'Pump receipt lookup failed; the saved transaction will be reconciled',
      );
    }
    if (receipt?.meta) return this.accountReceipt(operation, step.signature, receipt);
    if (step.venue && step.submittedAt !== null && Date.now() - step.submittedAt < 90_000)
      throw new PendingTrade('Waiting for Pump transaction confirmation');
    try {
      const status = (
        await this.rpc().getSignatureStatuses([step.signature], { searchTransactionHistory: true })
      ).value[0];
      if (status?.err) throw new TradeRejected('Solana swap failed on chain');
      const height = await this.rpc().getBlockHeight('confirmed');
      if (height > step.lastValidBlockHeight + 32) {
        if (status)
          throw new ReviewRequired(
            'Solana signature exists but transaction accounting is unavailable',
          );
        throw new TradeRejected('Solana transaction expired without confirmation');
      }
      if (step.submittedAt === null || Date.now() - step.submittedAt > 15_000) {
        if (height > step.lastValidBlockHeight)
          throw new PendingTrade('Waiting for expired Solana transaction reconciliation');
        if (step.jito)
          throw new ReviewRequired(
            'Saved Solana transaction uses legacy Jito routing; review its signature before retrying',
          );
        await this.rpc().sendRawTransaction(Buffer.from(step.serialized, 'base64'), {
          skipPreflight: false,
          maxRetries: 0,
        });
        step.submittedAt = Date.now();
        persist();
      }
    } catch (error) {
      if (
        !step.venue ||
        error instanceof PendingTrade ||
        error instanceof TradeRejected ||
        error instanceof ReviewRequired
      )
        throw error;
      log.error('transaction.pump_reconciliation_failed', error, {
        operationId: operation.id,
        signature: step.signature,
      });
      throw new PendingTrade(
        'Pump RPC reconciliation failed; the saved signature remains reserved',
      );
    }
    throw new PendingTrade('Waiting for legacy Solana confirmation');
  }
}
