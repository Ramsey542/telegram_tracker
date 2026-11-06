import type { Config } from '../config.js';
import {
  chains,
  chainLabel,
  emptyTrail,
  entryCostRaw,
  nativeDecimals,
  nativeSymbol,
  parseAmount,
  formatAmount,
  profitBps,
  PendingTrade,
  ReviewRequired,
  TradeRejected,
  type CallSignal,
  type Chain,
  type EvmChain,
  type ChainSettings,
  type Operation,
  type Position,
  type TokenInfo,
  type Quote,
} from '../domain.js';
import type { ChainAdapter } from '../chains/types.js';
import { Store } from '../infra/store.js';
import { ApiError, safeError } from '../infra/http.js';
import { RiskFilters } from '../providers/risk.js';
import { evaluateExits, evaluateTimeExit, timeExitDeadline, type ExitDecision } from './exits.js';
import { exitReasonLabel } from './exit-reason.js';
import { withdrawalAddress, withdrawalAmount } from './withdrawal.js';
import { logger, withLogContext } from '../logging/logger.js';
import { logTradeOutcome } from '../logging/trades.js';
import { PositionPrices } from '../providers/position-prices.js';
import { insufficientFunds } from './funds.js';
import { MarketData } from '../providers/market.js';

const log = logger.child({ component: 'trading.engine' });
const maxOperationRetries = 3;

function retryFailureReason(error: unknown): string {
  const summary = safeError(error);
  if (!(error instanceof ApiError)) return summary;
  let response = error.details.responseBody;
  if (typeof response === 'string') {
    try {
      response = JSON.parse(response);
    } catch {
      return summary;
    }
  }
  if (!response || typeof response !== 'object') return summary;
  const fields = response as Record<string, unknown>;
  for (const key of ['detail', 'message', 'error', 'errorCode'] as const) {
    const detail = fields[key];
    if (typeof detail === 'string' && detail.trim())
      return safeError(new Error(`${summary}: ${detail}`));
  }
  return summary;
}

export class TradeEngine {
  private readonly busy = new Set<Chain>();
  private readonly entryWake = new Set<Chain>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly transactionTimers = new Map<Chain, ReturnType<typeof setTimeout>>();
  private stopped = false;
  private readonly metadataWork = new Set<Promise<void>>();
  private readonly timeExitTimers = new Map<Chain, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    readonly adapters: Record<Chain, ChainAdapter>,
    private readonly filters: RiskFilters,
    private readonly onFill?: () => void,
    private readonly prices?: PositionPrices,
    private readonly market?: MarketData,
  ) {}
  start(): void {
    log.debug('engine.started', {
      listenOnly: this.config.listenOnly,
      pollMs: this.config.pollMs,
      settings: this.store.settings(),
    });
    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.pollMs);
    void this.tick();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    for (const timer of this.transactionTimers.values()) clearTimeout(timer);
    this.transactionTimers.clear();
    for (const timer of this.timeExitTimers.values()) clearTimeout(timer);
    this.timeExitTimers.clear();
    while (this.busy.size > 0) await new Promise((resolve) => setTimeout(resolve, 100));
    await Promise.allSettled([...this.metadataWork]);
  }
  async tick(preferEntries = false): Promise<void> {
    if (this.stopped) return;
    await withLogContext({ signalId: undefined, channelId: undefined, messageId: undefined }, () =>
      Promise.all(
        chains.map((chain) =>
          withLogContext({ chain }, () => this.tickChain(chain, preferEntries)),
        ),
      ),
    );
  }
  readiness(chain: Chain, buying = true, settings = this.store.settings().chains[chain]): string[] {
    const missing = this.adapters[chain].readiness(settings);
    if (buying && !settings.buySizeNative) missing.push('buy size');
    if (settings.slippagePercent === null) missing.push('slippage');
    if (settings.buySizeNative) parseAmount(settings.buySizeNative, nativeDecimals[chain]);
    return missing;
  }
  private ensureTradingAllowed(): void {
    if (this.config.listenOnly)
      throw new TradeRejected(
        'LISTEN_ONLY=true: trading, signing and submission are blocked. Change .env and restart to trade.',
      );
  }
  observeSignal(signal: CallSignal): void {
    const settings = signal.sourceId
      ? this.store.callChannel(signal.sourceId)?.settings?.[signal.chain]
      : this.store.settings().chains[signal.chain];
    try {
      if (!settings) throw new TradeRejected('Source channel no longer exists');
      this.validateSignal(signal, false);
      const blockedReason = this.config.listenOnly
        ? 'listen_only'
        : !settings.enabled
          ? 'chain_disabled'
          : null;
      this.store.recordObservation(signal.id, {
        decision: blockedReason ? 'skipped' : 'pending',
        reason: blockedReason ?? 'queued_for_evaluation',
        observedAt: Date.now(),
        thresholds:
          signal.mode === 'general' || !settings ? null : structuredClone(settings.consistency),
      });
      log.info('entry.observed', {
        signalId: signal.id,
        chain: signal.chain,
        token: signal.address,
        caller: signal.caller,
        decision: blockedReason ? 'skipped' : 'pending',
        reason: blockedReason ?? 'queued_for_evaluation',
        consistency: signal.consistency,
        thresholds: signal.mode === 'general' ? null : (settings?.consistency ?? null),
        filters: settings.filters,
        marketData: 'not_fetched_at_capture',
        buySizeNative: settings.buySizeNative,
      });
    } catch (error) {
      this.store.recordObservation(signal.id, {
        decision: 'skipped',
        reason: safeError(error),
        observedAt: Date.now(),
        thresholds:
          signal.mode === 'general' || !settings ? null : structuredClone(settings.consistency),
      });
      log.info('entry.observed', {
        signalId: signal.id,
        chain: signal.chain,
        token: signal.address,
        caller: signal.caller,
        decision: 'skipped',
        reason: safeError(error),
        error: error instanceof TradeRejected ? undefined : error,
        consistency: signal.consistency,
        thresholds: signal.mode === 'general' ? null : (settings?.consistency ?? null),
      });
    }
  }
  private async tickChain(chain: Chain, preferEntries = false): Promise<void> {
    if (this.stopped) return;
    if (this.busy.has(chain)) {
      if (preferEntries) this.entryWake.add(chain);
      return;
    }
    this.busy.add(chain);
    try {
      const operation = this.store.activeOperation(chain);
      if (this.config.listenOnly) {
        log.debug('engine.listen_only', {
          chain,
          reason: 'all_trade_execution_disabled',
          operationId: operation?.id,
          operationStatus: operation?.status,
          openPositions: this.store.positions(chain).length,
          positionMonitoring: 'suspended',
          nextSignalId: this.store.nextSignal(chain)?.id,
        });
        return;
      }
      if (operation) {
        if (
          operation.status === 'review' &&
          (operation.retryCount ?? 0) >= maxOperationRetries &&
          operation.error?.startsWith(
            `Automatic retry limit reached (${maxOperationRetries} retries). Manual review required.`,
          )
        ) {
          this.store.failOperation(
            operation,
            operation.error.replace(' Manual review required.', ''),
            false,
          );
          return;
        }
        log.debug('operation.poll', {
          chain,
          operationId: operation.id,
          positionId: operation.positionId,
          token: operation.address,
          status: operation.status,
          reason: operation.error,
        });
        if (operation.status === 'active')
          await withLogContext(
            {
              chain,
              operationId: operation.id,
              signalId: operation.signal?.id,
              token: operation.address,
              positionId: operation.positionId,
            },
            () => this.advance(operation),
          );
        return;
      }
      if (await this.monitorTimeExits(chain)) return;
      if (!preferEntries && (await this.monitor(chain))) return;
      if (!this.store.entriesEnabled(chain)) {
        if (preferEntries) await this.monitor(chain);
        log.debug('entries.waiting', {
          chain,
          reason: 'chain_disabled',
        });
        return;
      }
      for (let index = 0; index < 25; index++) {
        const signal = this.store.nextSignal(chain);
        if (!signal) {
          if (preferEntries) await this.monitor(chain);
          log.debug('entries.waiting', { chain, reason: 'no_pending_calls' });
          return;
        }
        let settings: ChainSettings;
        try {
          settings = this.validateSignal(signal);
        } catch (error) {
          log.info('entry.rejected', {
            signalId: signal.id,
            chain,
            token: signal.address,
            reason: safeError(error),
            consistency: signal.consistency,
            thresholds:
              signal.mode === 'general'
                ? null
                : signal.sourceId
                  ? (this.store.callChannel(signal.sourceId)?.settings?.[chain].consistency ?? null)
                  : this.store.settings().chains[chain].consistency,
            error: error instanceof TradeRejected ? undefined : error,
          });
          this.store.skipSignal(signal.id, safeError(error));
          continue;
        }
        try {
          await withLogContext(
            { signalId: signal.id, chain, token: signal.address, caller: signal.caller },
            () => this.consider(signal, settings),
          );
        } catch (error) {
          log.error('entry.evaluation_failed', error, {
            signalId: signal.id,
            chain,
            token: signal.address,
          });
          this.store.skipSignal(signal.id, safeError(error));
        }
        return;
      }
    } catch (error) {
      log.error('engine.monitoring_failed', error, { chain });
      this.store.notify(
        `engine:${chain}:${Math.floor(Date.now() / 300_000)}`,
        `${chain} monitoring issue: ${safeError(error)}`,
      );
    } finally {
      this.busy.delete(chain);
      this.scheduleTimeExit(chain);
      if (this.entryWake.delete(chain) && !this.stopped)
        void withLogContext({ chain }, () => this.tickChain(chain, true)).catch((error) =>
          log.error('entry.wake_failed', error, { chain }),
        );
    }
  }
  private validateSpyDefiLabels(signal: CallSignal, settings: ChainSettings): void {
    if (signal.mode === 'general') return;
    if (settings.filters.buyOnlyFirstCaller && signal.firstCaller !== true)
      throw new TradeRejected('Buy Only First Caller is enabled: FIRST CALLER label is missing');
    if (settings.filters.justLaunched && signal.justLaunched !== true)
      throw new TradeRejected('Just Launched is enabled: JUST LAUNCHED label is missing');
  }
  private validateSignal(signal: CallSignal, requireReady = true): ChainSettings {
    if (signal.sourceId && !this.store.callChannel(signal.sourceId))
      throw new TradeRejected('Source channel no longer exists');
    const settings = this.store.tradingSettings(signal.chain, signal.sourceId);
    const blockedCallers = this.store.callerBlocklist(signal.sourceId);
    const age = Date.now() - signal.date;
    log.debug('entry.filter_check', {
      signalId: signal.id,
      chain: signal.chain,
      token: signal.address,
      caller: signal.caller,
      callerId: signal.callerId,
      ageMs: age,
      maxAgeMs: this.config.maxSignalAgeMs,
      consistency: signal.consistency,
      thresholds: signal.mode === 'general' ? null : settings.consistency,
      source: signal.sourceName,
      sourceMode: signal.mode ?? 'spydefi',
      firstCaller: signal.firstCaller ?? false,
      justLaunched: signal.justLaunched ?? false,
      blockedCallers,
      duplicate:
        this.store.hasEntry(signal.chain, signal.address) ||
        this.store.hasPurchased(signal.chain, signal.address, signal.channelId),
    });
    if (age > this.config.maxSignalAgeMs || age < -30_000)
      throw new TradeRejected('Call is outside the allowed age window');
    if (
      blockedCallers.some(
        (caller) =>
          caller === signal.caller ||
          caller === `@${signal.caller}` ||
          (signal.callerId !== null && caller === signal.callerId),
      )
    )
      throw new TradeRejected('Caller is blocked');
    if (signal.mode !== 'general') {
      this.validateSpyDefiLabels(signal, settings);
      if (!signal.consistency) throw new TradeRejected('Caller consistency is missing');
      for (const name of ['overall', 'recent', 'chain'] as const)
        if (signal.consistency[name] < settings.consistency[name])
          throw new TradeRejected(`${name} consistency is below the threshold`);
    }
    const rejection = this.store.entryRejection(signal);
    if (rejection) throw new TradeRejected(rejection);
    if (requireReady && !settings.enabled)
      throw new TradeRejected('Entries for this channel and chain are disabled');
    const missing = requireReady ? this.readiness(signal.chain, true, settings) : [];
    if (missing.length) throw new TradeRejected(`Configure ${missing.join(', ')}`);
    return settings;
  }
  private async consider(signal: CallSignal, settings: ChainSettings): Promise<void> {
    this.ensureTradingAllowed();
    log.info('entry.evaluating', {
      signalId: signal.id,
      token: signal.address,
      chain: signal.chain,
      buySizeNative: settings.buySizeNative,
    });
    const token: TokenInfo = {
      chain: signal.chain,
      address: signal.address,
      symbol: signal.tokenName || signal.address.slice(0, 8),
      decimals: null,
      marketCapUsd: null,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: Date.now(),
    };
    const amountRaw = parseAmount(settings.buySizeNative!, nativeDecimals[signal.chain]);
    if (amountRaw <= 0n) throw new TradeRejected('Buy size rounds to zero');
    const operation = this.operation(signal.chain, token, 'buy', amountRaw.toString());
    operation.signal = signal;
    operation.settings = structuredClone(settings);
    if (!this.store.claim(operation)) {
      this.store.skipSignal(signal.id, 'Another operation reserved this token');
      return;
    }
    log.info('entry.claimed', { operationId: operation.id, signalId: signal.id, amountRaw });
    await withLogContext({ operationId: operation.id }, () => this.advance(operation));
  }
  private operation(
    chain: Chain,
    token: TokenInfo,
    kind: Operation['kind'],
    amountRaw: string,
  ): Operation {
    return {
      id: this.store.newId(),
      chain,
      address: token.address,
      kind,
      status: 'active',
      positionId: null,
      signal: null,
      exitKey: null,
      amountRaw,
      token,
      settings: structuredClone(this.store.settings().chains[chain]),
      steps: [],
      quote: null,
      swapHash: null,
      outputRaw: null,
      createdAt: Date.now(),
      error: null,
    };
  }
  private async advance(operation: Operation): Promise<void> {
    this.ensureTradingAllowed();
    log.info('operation.advancing', {
      operationId: operation.id,
      chain: operation.chain,
      token: operation.address,
      kind: operation.kind,
      amountRaw: operation.amountRaw,
      retryCount: operation.retryCount ?? 0,
      maxRetries: maxOperationRetries,
    });
    try {
      const result = await this.adapters[operation.chain].advance(
        operation,
        () => {
          if (
            operation.chain !== 'solana' &&
            operation.kind === 'buy' &&
            BigInt(operation.wrapAmountRaw ?? '0') > 0n &&
            !operation.wrapWarningSent
          ) {
            operation.wrapWarningSent = true;
            this.store.notify(
              `wrapping:${operation.id}`,
              `Wrapped ${nativeSymbol[operation.chain]} is below the buy size. Auto-wrap is enabled: wrapping ${formatAmount(operation.wrapAmountRaw!, 18)} ${nativeSymbol[operation.chain]} before this buy. This adds a separate transaction and network fee.`,
            );
          }
          this.store.saveOperation(operation);
        },
        async () => {
          this.ensureTradingAllowed();
          if (operation.kind !== 'buy') return;
          this.ensureEntryActive(operation);
          const filters = operation.settings.filters;
          const needsMarket =
            operation.chain !== 'solana' ||
            filters.marketCapEnabled ||
            filters.minLiquidityUsd !== null ||
            filters.maxTopHoldersPercent !== null;
          const tokenRequest = needsMarket
            ? this.adapters[operation.chain].tokenInfo(operation.address, operation.settings)
            : Promise.resolve({ ...operation.token, fetchedAt: Date.now() });
          const classicBuy = operation.chain !== 'solana' && !operation.settings.mevProtection;
          const token = classicBuy
            ? (
                await Promise.all([
                  tokenRequest,
                  this.filters.check(operation.token, operation.settings, tokenRequest),
                ])
              )[0]
            : await tokenRequest;
          log.info('entry.market_data', {
            token,
            source: needsMarket ? 'current_api_data' : 'call_and_order',
            enabledFiltersOnly: operation.chain === 'solana',
          });
          if (!classicBuy) await this.filters.check(token, operation.settings);
          operation.token = token;
        },
        () => this.ensureEntryActive(operation),
      );
      log.info('operation.confirmed', {
        operationId: operation.id,
        chain: operation.chain,
        kind: operation.kind,
        result,
      });
      if (operation.kind === 'buy') {
        if (BigInt(result.tokenRaw) <= 0n || BigInt(result.nativeRaw) <= 0n)
          throw new ReviewRequired('Confirmed purchase accounting is invalid');
        const decimals = operation.token.decimals;
        if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
          throw new ReviewRequired('Confirmed purchase token decimals are unavailable');
        const entryNative = Number(
          formatAmount(
            result.nativeRaw,
            nativeDecimals[operation.chain],
            nativeDecimals[operation.chain],
          ),
        );
        const usd =
          result.nativeUsd !== null
            ? entryNative * result.nativeUsd
            : operation.token.usdPrice === null
              ? null
              : Number(formatAmount(result.tokenRaw, decimals, decimals)) *
                operation.token.usdPrice;
        const position: Position = {
          id: this.store.newId(),
          chain: operation.chain,
          address: operation.address,
          symbol: operation.token.symbol,
          decimals,
          caller: operation.signal?.caller ?? '',
          originalTokenRaw: result.tokenRaw,
          remainingTokenRaw: result.tokenRaw,
          entryNativeRaw: result.nativeRaw,
          entrySwapNativeRaw:
            operation.chain === 'solana'
              ? (result.swapNativeRaw ?? operation.amountRaw)
              : undefined,
          entryFeeNativeRaw: result.feeNativeRaw,
          entryUsd: usd !== null && Number.isFinite(usd) ? usd : null,
          realizedNativeRaw: '0',
          realizedFeeNativeRaw: '0',
          exits: structuredClone(operation.settings.exits),
          exitFills: {},
          trailingSl: emptyTrail(),
          trailingTp: emptyTrail(),
          openedAt: Date.now(),
          closedAt: null,
          lastProfitPercent: null,
          lastValueNativeRaw: null,
          lastValueUsd: null,
          lastError: null,
        };
        operation.swapHash = result.signature;
        this.store.completeBuy(operation, position, result);
        if (!position.entryMarketCapUsd && this.market) {
          const task = this.captureEntryMarketCap(position);
          this.metadataWork.add(task);
          void task.finally(() => this.metadataWork.delete(task));
        }
        this.onFill?.();
        log.info('position.opened', {
          positionId: position.id,
          operationId: operation.id,
          position,
        });
        this.store.notify(
          `fill:${operation.id}`,
          operation.chain === 'solana'
            ? `${operation.token.symbol}: ${formatAmount(result.tokenRaw, decimals)} tokens received.\nSwap input: ${formatAmount(position.entrySwapNativeRaw!, nativeDecimals[operation.chain])} ${nativeSymbol[operation.chain]}.\nWallet spending: ${formatAmount(result.nativeRaw, nativeDecimals[operation.chain])} ${nativeSymbol[operation.chain]}${position.entryUsd === null ? '' : ` (approximately $${position.entryUsd.toFixed(2)})`}.`
            : `${operation.token.symbol}: ${formatAmount(result.tokenRaw, decimals)} tokens received for ${formatAmount(result.nativeRaw, nativeDecimals[operation.chain])} ${nativeSymbol[operation.chain]}${position.entryUsd === null ? '' : ` (approximately $${position.entryUsd.toFixed(2)})`}.`,
        );
      } else if (operation.kind === 'sell') {
        const position = operation.positionId ? this.store.position(operation.positionId) : null;
        if (!position) throw new ReviewRequired('Confirmed sale has no matching position');
        this.store.completeSell(operation, position, result);
        if (result.fundsError) {
          this.fundsFailed(operation, result.fundsError);
          this.store.notify(
            `unwrap-funds:${operation.id}`,
            `The ${position.symbol} sale is confirmed. Its proceeds remain wrapped because there was insufficient ${nativeSymbol[operation.chain]} to finish unwrapping. The confirmed sale has been recorded; it will not be sent again.`,
          );
        }
        this.onFill?.();
        log.info('position.sold', {
          positionId: position.id,
          operationId: operation.id,
          exitKey: operation.exitKey,
          result,
        });
        this.store.notify(
          `proceeds:${operation.id}`,
          `Net sale proceeds: ${formatAmount(result.nativeRaw, nativeDecimals[operation.chain])} ${nativeSymbol[operation.chain]}.`,
        );
      } else if (operation.kind === 'withdraw') {
        this.store.completeWithdrawal(operation, result);
        logTradeOutcome(operation, { ...result, recipient: operation.withdrawal?.recipient });
      } else {
        operation.status = 'confirmed';
        this.store.saveOperation(operation);
        logTradeOutcome(operation, { ...result });
        this.store.notify(
          `${operation.kind}:${operation.id}`,
          operation.kind === 'wrap'
            ? `Wrapped ${formatAmount(operation.amountRaw, 18)} ${nativeSymbol[operation.chain]} into W${nativeSymbol[operation.chain]}.\nTransaction: ${result.signature}`
            : `Unwrapped ${formatAmount(operation.amountRaw, 18)} W${nativeSymbol[operation.chain]} to ${nativeSymbol[operation.chain]}.\nTransaction: ${result.signature}`,
        );
      }
    } catch (error) {
      if (operation.chain !== 'solana' && insufficientFunds(error)) {
        const reason = retryFailureReason(error);
        log.error('operation.insufficient_funds', error, { operationId: operation.id, reason });
        this.store.failOperation(operation, reason, false);
        this.fundsFailed(operation, reason);
        return;
      }
      if (error instanceof PendingTrade) {
        log.info('operation.pending', {
          operationId: operation.id,
          chain: operation.chain,
          reason: error.message,
          swapHash: operation.swapHash,
        });
        operation.error = error.message;
        this.store.saveOperation(operation);
        if (error.message.includes('submission outcome is uncertain'))
          this.store.notify(`submission-uncertain:${operation.id}`, error.message);
        if (this.timer && !this.stopped && !this.transactionTimers.has(operation.chain)) {
          const timer = setTimeout(() => {
            this.transactionTimers.delete(operation.chain);
            void withLogContext({ chain: operation.chain }, () =>
              this.tickChain(operation.chain),
            ).catch((error) =>
              log.error('operation.confirmation_poll_failed', error, {
                chain: operation.chain,
                operationId: operation.id,
              }),
            );
          }, this.config.transactionPollMs ?? 300);
          this.transactionTimers.set(operation.chain, timer);
        }
        return;
      }
      if (
        !(error instanceof TradeRejected) &&
        !(error instanceof ReviewRequired) &&
        operation.steps.length > 0
      ) {
        const retryCount = operation.retryCount ?? 0;
        if (retryCount >= maxOperationRetries) {
          log.error('operation.retry_limit_reached', error, {
            operationId: operation.id,
            chain: operation.chain,
            retryCount,
            maxRetries: maxOperationRetries,
          });
          this.store.failOperation(
            operation,
            `Automatic retry limit reached (${maxOperationRetries} retries). Last error: ${retryFailureReason(error)}`,
            false,
          );
          return;
        }
        operation.retryCount = retryCount + 1;
        log.warn('operation.retry_scheduled', {
          operationId: operation.id,
          chain: operation.chain,
          retryCount: operation.retryCount,
          maxRetries: maxOperationRetries,
          error,
        });
        operation.error = safeError(error);
        this.store.saveOperation(operation);
        this.store.notify(
          `pending:${operation.id}`,
          `${operation.chain} operation will retry automatically (${operation.retryCount}/${maxOperationRetries}): ${safeError(error)}`,
        );
        return;
      }
      log.error('operation.failed', error, {
        operationId: operation.id,
        chain: operation.chain,
        requiresReview: error instanceof ReviewRequired || operation.swapHash !== null,
      });
      this.store.failOperation(
        operation,
        retryFailureReason(error),
        error instanceof ReviewRequired || operation.swapHash !== null,
      );
    }
  }
  private ensureEntryActive(operation: Operation): void {
    this.ensureTradingAllowed();
    if (operation.kind !== 'buy') return;
    if (
      this.store.hasPurchased(operation.chain, operation.address, operation.signal?.channelId ?? '')
    )
      throw new TradeRejected('Token was already purchased for this channel');
    if (this.stopped) throw new TradeRejected('Bot is shutting down before swap submission');
    if (operation.signal?.sourceId) {
      const source = this.store.callChannel(operation.signal.sourceId);
      if (
        !source?.enabled ||
        source.status !== 'ready' ||
        source.channelId !== operation.signal.channelId ||
        operation.signal.date < source.activatedAt
      )
        throw new TradeRejected('Source channel was disabled or changed before signing');
    }
    const settings = this.store.tradingSettings(operation.chain, operation.signal?.sourceId);
    if (!settings.enabled) throw new TradeRejected('Channel entries were disabled before signing');
    if (operation.signal) this.validateSpyDefiLabels(operation.signal, settings);
    if (operation.signal && Date.now() - operation.signal.date > this.config.maxSignalAgeMs)
      throw new TradeRejected('Call expired before swap submission');
    if (
      operation.signal &&
      this.store
        .callerBlocklist(operation.signal.sourceId)
        .some(
          (caller) =>
            caller.replace(/^@/, '') === operation.signal!.caller ||
            caller === operation.signal!.callerId,
        )
    )
      throw new TradeRejected('Caller was blocked before signing');
  }
  private fundsFailed(operation: Operation, reason: string): void {
    const position = operation.positionId ? this.store.position(operation.positionId) : null;
    const sourceId =
      operation.signal?.sourceId ?? position?.sourceId ?? operation.funding?.sourceId;
    if (position && BigInt(position.remainingTokenRaw) > 0n) {
      position.fundsError = reason;
      this.store.savePosition(position);
    }
    if (sourceId && this.store.callChannel(sourceId))
      this.store.updateChannelRules(sourceId, operation.chain, (settings) => {
        settings.enabled = false;
      });
    else if (!sourceId) {
      const settings = this.store.settings();
      settings.chains[operation.chain].enabled = false;
      this.store.saveSettings(settings);
    }
    this.store.notify(
      `funds:${operation.id}`,
      `${chainLabel[operation.chain]} funds error: ${reason}\nNew ${chainLabel[operation.chain]} buys for ${sourceId ? (this.store.callChannel(sourceId)?.title ?? 'this channel') : 'the default configuration'} are disabled. Position price monitoring continues. No automatic retry will be made for this operation.${position && BigInt(position.remainingTokenRaw) > 0n ? '\nFund the wallet, then use Resume exits after funding on this position to allow another automatic sale.' : ''}`,
    );
  }
  resumeExits(positionId: string): void {
    const position = this.store.position(positionId);
    if (!position || position.closedAt !== null) throw new Error('Position is no longer open');
    if (this.store.activeOperation(position.chain))
      throw new Error('This chain has an operation in progress');
    position.fundsError = undefined;
    position.timeExitOperationId = undefined;
    position.lastError = null;
    this.store.savePosition(position);
    void this.tick();
  }
  private async captureEntryMarketCap(position: Position): Promise<void> {
    try {
      const value =
        position.chain === 'solana'
          ? (await this.market!.solana(position.address))?.mcap
          : (await this.market!.evm(position.chain, position.address, false))?.marketCap;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        throw new Error('Entry market cap is unavailable from the market data provider');
      const current = this.store.position(position.id);
      if (!current || current.entryMarketCapUsd) return;
      current.entryMarketCapUsd = value;
      current.entryMarketCapCapturedAt = Date.now();
      current.entryMarketCapAfterBuy = true;
      this.store.savePosition(current);
      log.info('position.entry_market_cap_captured', {
        chain: current.chain,
        positionId: current.id,
        token: current.address,
        entryMarketCapUsd: value,
        capturedAfterBuy: true,
      });
    } catch (error) {
      log.error('position.entry_market_cap_failed', error, {
        chain: position.chain,
        positionId: position.id,
        token: position.address,
      });
    }
  }
  private scheduleTimeExit(chain: Chain): void {
    const previous = this.timeExitTimers.get(chain);
    if (previous) clearTimeout(previous);
    this.timeExitTimers.delete(chain);
    if (!this.timer || this.stopped || this.config.listenOnly) return;
    const deadlines = this.store
      .positions(chain)
      .filter((position) => !position.fundsError)
      .map(timeExitDeadline)
      .filter((value): value is number => value !== null);
    if (!deadlines.length) return;
    const remaining = Math.min(...deadlines) - Date.now();
    const delay =
      remaining > 0 ? Math.min(remaining, 2_000_000_000) : Math.max(this.config.pollMs, 1000);
    this.timeExitTimers.set(
      chain,
      setTimeout(() => {
        this.timeExitTimers.delete(chain);
        void withLogContext({ chain }, () => this.tickChain(chain)).catch((error) =>
          log.error('exit.time_tick_failed', error, { chain }),
        );
      }, delay),
    );
  }
  private async monitorTimeExits(chain: Chain): Promise<boolean> {
    for (const position of this.store.positions(chain)) {
      if (!position.exits.timeExit?.enabled) continue;
      const decision = withLogContext(
        { chain, positionId: position.id, token: position.address },
        () => evaluateTimeExit(position),
      );
      if (
        decision &&
        (await this.executeExit(position, this.store.positionSettings(position), decision))
      )
        return true;
    }
    return false;
  }
  private async executeExit(
    position: Position,
    settings: ChainSettings,
    decision: ExitDecision,
    quote?: Quote,
  ): Promise<boolean> {
    if (position.fundsError) {
      log.info('exit.waiting', {
        chain: position.chain,
        positionId: position.id,
        token: position.address,
        reason: 'funds_error_requires_owner_resume',
        error: position.fundsError,
      });
      return false;
    }
    log.info('exit.triggered', {
      chain: position.chain,
      positionId: position.id,
      token: position.address,
      profitPercent: position.lastProfitPercent,
      decision,
    });
    const token: TokenInfo = {
      chain: position.chain,
      address: position.address,
      symbol: position.symbol,
      decimals: position.decimals,
      marketCapUsd: null,
      liquidityUsd: null,
      usdPrice: null,
      fetchedAt: Date.now(),
    };
    const operation = this.operation(position.chain, token, 'sell', decision.amountRaw);
    operation.approvalAmountRaw = position.remainingTokenRaw;
    operation.settings = structuredClone(settings);
    operation.settings.exits = structuredClone(position.exits);
    operation.positionId = position.id;
    operation.exitKey = decision.key;
    operation.exitDescription = exitReasonLabel(decision.key, position.exits);
    operation.quote = quote ?? null;
    if (this.store.claim(operation)) {
      if (decision.key === 'time') {
        position.timeExitOperationId = operation.id;
        this.store.savePosition(position);
      }
      await withLogContext(
        {
          chain: position.chain,
          positionId: position.id,
          token: position.address,
          operationId: operation.id,
        },
        () => this.advance(operation),
      );
      if (decision.key === 'time' && operation.status === 'failed') {
        const current = this.store.position(position.id);
        if (current && current.closedAt === null) {
          current.lastError = `Time exit failed: ${operation.error ?? 'Unknown error'}. Sell manually or apply current exit settings to retry.`;
          this.store.savePosition(current);
        }
      }
      return true;
    }
    log.info('exit.waiting', {
      chain: position.chain,
      positionId: position.id,
      token: position.address,
      reason: 'chain_operation_already_reserved',
    });
    return false;
  }
  private async monitor(chain: Chain): Promise<boolean> {
    const positions = this.store.positions(chain);
    log.debug('positions.poll', { chain, count: positions.length });
    const active = positions.filter(
      (position) =>
        position.exits.stopLoss.enabled ||
        position.exits.takeProfitEnabled ||
        position.exits.trailingSl.enabled ||
        position.exits.trailingTp.enabled,
    );
    const referenceQuotes = this.prices ? await this.prices.quotes(active) : null;
    for (const position of positions) {
      const settings = this.store.positionSettings(position);
      if (
        !position.exits.stopLoss.enabled &&
        !position.exits.takeProfitEnabled &&
        !position.exits.trailingSl.enabled &&
        !position.exits.trailingTp.enabled
      ) {
        log.debug('position.waiting', {
          chain,
          positionId: position.id,
          token: position.address,
          reason: 'price_exits_disabled',
        });
        continue;
      }
      try {
        entryCostRaw(position);
        const quote = await withLogContext(
          { chain, positionId: position.id, token: position.address },
          async () => {
            if (!referenceQuotes)
              return this.adapters[chain].quoteSell(
                position.address,
                position.remainingTokenRaw,
                settings,
              );
            const quote = referenceQuotes.get(position.id);
            if (!quote)
              throw new Error(
                'Current reference price is missing or stale; this exit evaluation was skipped',
              );
            return quote;
          },
        );
        log.info('position.quote_received', {
          chain,
          positionId: position.id,
          token: position.address,
          quote,
          entryNativeRaw: position.entryNativeRaw,
          entrySwapNativeRaw: position.entrySwapNativeRaw,
          originalTokenRaw: position.originalTokenRaw,
          remainingTokenRaw: position.remainingTokenRaw,
        });
        const decision = withLogContext(
          { chain, positionId: position.id, token: position.address },
          () => evaluateExits(position, quote),
        );
        const quotedValue = BigInt(quote.outputRaw);
        position.lastValueNativeRaw = quotedValue.toString();
        position.lastValueUsd =
          quote.nativeUsd === null
            ? null
            : Number(formatAmount(quotedValue, nativeDecimals[chain])) * quote.nativeUsd;
        position.lastError = null;
        this.store.savePnlMark({
          positionId: position.id,
          tokenRaw: quote.inputRaw,
          outputRaw: quote.outputRaw,
          nativeUsd: quote.nativeUsd,
          receivedAt: quote.receivedAt,
        });
        this.store.savePosition(position);
        if (!decision) {
          log.info('position.waiting', {
            chain,
            positionId: position.id,
            token: position.address,
            profitPercent: position.lastProfitPercent,
            reason: 'no_exit_triggered',
          });
          continue;
        }
        if (await this.executeExit(position, settings, decision, quote)) return true;
      } catch (error) {
        log.error('position.monitoring_failed', error, {
          chain,
          positionId: position.id,
          token: position.address,
        });
        position.lastError = safeError(error);
        this.store.savePosition(position);
        this.store.notify(
          `position:${position.id}:${Math.floor(Date.now() / 300_000)}`,
          `Cannot evaluate ${position.symbol} exits: ${position.lastError}`,
        );
      }
    }
    return false;
  }
  async refresh(position: Position): Promise<Position> {
    const snapshot = this.store.position(position.id);
    if (!snapshot) throw new Error('Position no longer exists');
    if (
      this.stopped ||
      snapshot.closedAt !== null ||
      this.busy.has(snapshot.chain) ||
      this.store.activeOperation(snapshot.chain)
    ) {
      log.info('position.refresh_skipped', {
        chain: snapshot.chain,
        positionId: snapshot.id,
        token: snapshot.address,
        reason: 'closed_position_or_trade_in_progress',
      });
      return snapshot;
    }
    position = snapshot;
    const settings = this.store.positionSettings(position);
    try {
      const quote = this.prices
        ? (await this.prices.quotes([position])).get(position.id)
        : await this.adapters[position.chain].quoteSell(
            position.address,
            position.remainingTokenRaw,
            settings,
          );
      if (!quote) throw new Error('Current reference price is missing or stale');
      const current = this.store.position(position.id);
      if (!current || this.stopped) return current ?? position;
      if (
        current.closedAt !== null ||
        current.remainingTokenRaw !== quote.inputRaw ||
        this.busy.has(current.chain) ||
        this.store.activeOperation(current.chain)
      ) {
        log.info('position.refresh_skipped', {
          chain: current.chain,
          positionId: current.id,
          token: current.address,
          reason: 'holdings_changed_or_trade_in_progress',
        });
        return current;
      }
      position = current;
      const quotedValue = BigInt(quote.outputRaw);
      position.lastProfitPercent =
        Number(profitBps(quotedValue, BigInt(position.remainingTokenRaw), position)) / 100;
      position.lastValueNativeRaw = quotedValue.toString();
      position.lastValueUsd =
        quote.nativeUsd === null
          ? null
          : Number(formatAmount(quotedValue, nativeDecimals[position.chain])) * quote.nativeUsd;
      position.lastError = null;
      this.store.savePnlMark({
        positionId: position.id,
        tokenRaw: quote.inputRaw,
        outputRaw: quote.outputRaw,
        nativeUsd: quote.nativeUsd,
        receivedAt: quote.receivedAt,
      });
      log.info('position.refresh_quote', {
        chain: position.chain,
        positionId: position.id,
        token: position.address,
        quote,
        profitPercent: position.lastProfitPercent,
      });
    } catch (error) {
      log.error('position.refresh_failed', error, {
        chain: position.chain,
        positionId: position.id,
        token: position.address,
      });
      const current = this.store.position(position.id);
      if (
        !current ||
        current.closedAt !== null ||
        current.remainingTokenRaw !== position.remainingTokenRaw ||
        this.stopped ||
        this.busy.has(current.chain) ||
        this.store.activeOperation(current.chain)
      )
        return current ?? position;
      position = current;
      position.lastError = safeError(error);
    }
    this.store.savePosition(position);
    return position;
  }
  async sell(positionId: string, percentage: number): Promise<void> {
    this.ensureTradingAllowed();
    const position = this.store.position(positionId);
    if (!position || position.closedAt !== null) throw new Error('Position is no longer open');
    if (!(percentage > 0 && percentage <= 100))
      throw new Error('Sell percentage must be between 0 and 100');
    if (this.busy.has(position.chain) || this.store.activeOperation(position.chain))
      throw new Error('This chain already has an operation in progress');
    const settings = this.store.positionSettings(position);
    const missing = this.readiness(position.chain, false, settings);
    if (missing.length) throw new Error(`Configure ${missing.join(', ')}`);
    const amount =
      (BigInt(position.remainingTokenRaw) * BigInt(Math.round(percentage * 100))) / 10_000n;
    if (amount <= 0n) throw new Error('Sell amount rounds to zero');
    const operation = this.operation(
      position.chain,
      {
        chain: position.chain,
        address: position.address,
        symbol: position.symbol,
        decimals: position.decimals,
        marketCapUsd: null,
        liquidityUsd: null,
        usdPrice: null,
        fetchedAt: Date.now(),
      },
      'sell',
      amount.toString(),
    );
    operation.positionId = position.id;
    operation.approvalAmountRaw = position.remainingTokenRaw;
    operation.settings = structuredClone(settings);
    operation.settings.exits = structuredClone(position.exits);
    operation.exitKey = 'manual';
    operation.exitDescription = exitReasonLabel('manual', position.exits);
    if (!this.store.claim(operation))
      throw new Error('This chain already has an operation in progress');
    void this.tick();
  }
  async unwrap(chain: EvmChain = 'robinhood'): Promise<void> {
    this.ensureTradingAllowed();
    if (this.busy.has(chain) || this.store.activeOperation(chain))
      throw new Error(`${chainLabel[chain]} has an operation in progress`);
    const balance = await this.adapters[chain].balance();
    if (!balance.wrappedRaw || BigInt(balance.wrappedRaw) <= 0n)
      throw new Error(`There is no idle W${nativeSymbol[chain]} to unwrap`);
    const operation = this.operation(
      chain,
      {
        chain: chain,
        address: this.adapters[chain].address,
        symbol: `W${nativeSymbol[chain]}`,
        decimals: 18,
        marketCapUsd: null,
        liquidityUsd: null,
        usdPrice: null,
        fetchedAt: Date.now(),
      },
      'unwrap',
      balance.wrappedRaw,
    );
    if (!this.store.claim(operation))
      throw new Error(`${chainLabel[chain]} has an operation in progress`);
    void this.tick();
  }
  async wrap(amount: string, sourceId?: string, chain: EvmChain = 'robinhood'): Promise<string> {
    this.ensureTradingAllowed();
    if (this.stopped) throw new Error('Bot is shutting down');
    if (this.busy.has(chain) || this.store.activeOperation(chain))
      throw new Error(`${chainLabel[chain]} has an operation in progress`);
    const amountRaw = parseAmount(amount, 18);
    if (amountRaw <= 0n) throw new Error('Wrap amount must be greater than zero');
    const operation = this.operation(
      chain,
      {
        chain: chain,
        address: this.adapters[chain].address,
        symbol: `W${nativeSymbol[chain]}`,
        decimals: 18,
        marketCapUsd: null,
        liquidityUsd: null,
        usdPrice: null,
        fetchedAt: Date.now(),
      },
      'wrap',
      amountRaw.toString(),
    );
    operation.settings = structuredClone(this.store.tradingSettings(chain, sourceId));
    operation.funding = { sourceId };
    if (!this.store.claim(operation))
      throw new Error(`${chainLabel[chain]} has an operation in progress`);
    void this.tick();
    return operation.id;
  }
  async withdraw(
    chain: Chain,
    recipient: string,
    amount: string,
    requestedBy: number,
  ): Promise<string> {
    this.ensureTradingAllowed();
    if (requestedBy !== this.config.ownerId) throw new Error('Only the owner can withdraw funds');
    if (this.stopped) throw new Error('Bot is shutting down');
    if (this.busy.has(chain) || this.store.activeOperation(chain))
      throw new Error('This chain already has an operation in progress');
    const address = withdrawalAddress(chain, recipient, this.adapters[chain].address);
    const amountRaw = withdrawalAmount(chain, amount);
    const operation = this.operation(
      chain,
      {
        chain,
        address,
        symbol: nativeSymbol[chain],
        decimals: nativeDecimals[chain],
        marketCapUsd: null,
        liquidityUsd: null,
        usdPrice: null,
        fetchedAt: Date.now(),
      },
      'withdraw',
      amountRaw,
    );
    operation.withdrawal = { recipient: address, requestedBy };
    if (!this.store.claim(operation))
      throw new Error('This chain already has an operation in progress');
    log.info('withdrawal.queued', {
      chain,
      operationId: operation.id,
      recipient: address,
      amountRaw,
      requestedBy,
    });
    void this.tick().catch((error) =>
      log.error('withdrawal.tick_failed', error, { chain, operationId: operation.id }),
    );
    return operation.id;
  }
  reconcile(id: string): void {
    this.ensureTradingAllowed();
    const operation = this.store.operation(id);
    if (!operation || operation.status !== 'review')
      throw new Error('No matching operation awaiting review');
    const position = operation.positionId ? this.store.position(operation.positionId) : null;
    const source = operation.signal?.sourceId
      ? this.store.callChannel(operation.signal.sourceId)
      : null;
    operation.settings.priorityFee = position
      ? this.store.positionSettings(position).priorityFee
      : source
        ? this.store.tradingSettings(operation.chain, source.id).priorityFee
        : operation.settings.priorityFee;
    operation.status = 'active';
    operation.error = null;
    operation.retryCount = 0;
    this.store.saveOperation(operation);
    void this.tick();
  }
}
