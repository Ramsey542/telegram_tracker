import type { Config } from '../config.js';
import {
  chains,
  emptyTrail,
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
  type ChainSettings,
  type Operation,
  type Position,
  type TokenInfo,
} from '../domain.js';
import type { ChainAdapter } from '../chains/types.js';
import { Store } from '../infra/store.js';
import { safeError } from '../infra/http.js';
import { RiskFilters } from '../providers/risk.js';
import { evaluateExits } from './exits.js';
import { logger, withLogContext } from '../logging/logger.js';

const log = logger.child({ component: 'trading.engine' });

export class TradeEngine {
  private readonly busy = new Set<Chain>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    readonly adapters: Record<Chain, ChainAdapter>,
    private readonly filters: RiskFilters,
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
    while (this.busy.size > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  async tick(): Promise<void> {
    if (this.stopped) return;
    await withLogContext({ signalId: undefined, channelId: undefined, messageId: undefined }, () =>
      Promise.all(chains.map((chain) => withLogContext({ chain }, () => this.tickChain(chain)))),
    );
  }
  readiness(chain: Chain, buying = true): string[] {
    const settings = this.store.settings().chains[chain];
    const missing = this.adapters[chain].readiness(settings);
    if (buying && !settings.buySizeNative) missing.push('buy size');
    if (buying && settings.buySlippagePercent === null) missing.push('buy slippage');
    if (settings.sellSlippagePercent === null) missing.push('sell slippage');
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
    const global = this.store.settings();
    const settings = global.chains[signal.chain];
    try {
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
        thresholds: structuredClone(settings.consistency),
      });
      log.info('entry.observed', {
        signalId: signal.id,
        chain: signal.chain,
        token: signal.address,
        caller: signal.caller,
        decision: blockedReason ? 'skipped' : 'pending',
        reason: blockedReason ?? 'queued_for_evaluation',
        consistency: signal.consistency,
        thresholds: settings.consistency,
        filters: settings.filters,
        marketData: 'not_fetched_at_capture',
        buySizeNative: settings.buySizeNative,
      });
    } catch (error) {
      this.store.recordObservation(signal.id, {
        decision: 'skipped',
        reason: safeError(error),
        observedAt: Date.now(),
        thresholds: structuredClone(settings.consistency),
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
        thresholds: settings.consistency,
      });
    }
  }
  private async tickChain(chain: Chain): Promise<void> {
    if (this.busy.has(chain)) return;
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
        log.debug('operation.poll', {
          chain,
          operationId: operation.id,
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
      if (await this.monitor(chain)) return;
      const global = this.store.settings();
      if (!global.chains[chain].enabled) {
        log.debug('entries.waiting', {
          chain,
          reason: 'chain_disabled',
        });
        return;
      }
      for (let index = 0; index < 25; index++) {
        const signal = this.store.nextSignal(chain);
        if (!signal) {
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
            thresholds: this.store.settings().chains[chain].consistency,
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
    }
  }
  private validateSignal(signal: CallSignal, requireReady = true): ChainSettings {
    const global = this.store.settings();
    const settings = global.chains[signal.chain];
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
      thresholds: settings.consistency,
      blockedCallers: global.blockedCallers,
      duplicate: this.store.hasEntry(signal.chain, signal.address),
    });
    if (age > this.config.maxSignalAgeMs || age < -30_000)
      throw new TradeRejected('Call is outside the allowed age window');
    if (
      global.blockedCallers.some(
        (caller) =>
          caller === signal.caller ||
          caller === `@${signal.caller}` ||
          (signal.callerId !== null && caller === signal.callerId),
      )
    )
      throw new TradeRejected('Caller is blocked');
    for (const name of ['overall', 'recent', 'chain'] as const)
      if (signal.consistency[name] < settings.consistency[name])
        throw new TradeRejected(`${name} consistency is below the threshold`);
    if (this.store.hasEntry(signal.chain, signal.address))
      throw new TradeRejected('Token is already purchased or reserved');
    const missing = requireReady ? this.readiness(signal.chain) : [];
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
    const token: TokenInfo =
      signal.chain === 'solana'
        ? {
            chain: signal.chain,
            address: signal.address,
            symbol: signal.tokenName || signal.address.slice(0, 8),
            decimals: null,
            marketCapUsd: null,
            liquidityUsd: null,
            usdPrice: null,
            fetchedAt: Date.now(),
          }
        : await this.adapters[signal.chain].tokenInfo(signal.address);
    if (signal.chain !== 'solana') {
      log.info('entry.market_data', { token });
      await this.filters.check(token, settings);
    }
    const amountRaw = parseAmount(settings.buySizeNative!, nativeDecimals[signal.chain]);
    if (amountRaw <= 0n) throw new TradeRejected('Buy size rounds to zero');
    if (signal.chain !== 'solana') {
      const balance = await this.adapters[signal.chain].balance();
      log.info('entry.balance_check', {
        nativeRaw: balance.nativeRaw,
        amountRaw,
        priorityFee: settings.priorityFee,
      });
      if (BigInt(balance.nativeRaw) <= amountRaw)
        throw new TradeRejected('Insufficient native balance for the buy and network fees');
    }
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
      minimumNativeRaw: null,
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
    });
    try {
      const result = await this.adapters[operation.chain].advance(
        operation,
        () => this.store.saveOperation(operation),
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
          const token = needsMarket
            ? await this.adapters[operation.chain].tokenInfo(operation.address)
            : { ...operation.token, fetchedAt: Date.now() };
          log.info('entry.market_data', {
            token,
            source: needsMarket ? 'current_api_data' : 'call_and_order',
            enabledFiltersOnly: operation.chain === 'solana',
          });
          await this.filters.check(token, operation.settings);
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
        this.store.completeBuy(operation, position);
        log.info('position.opened', {
          positionId: position.id,
          operationId: operation.id,
          position,
        });
        this.store.notify(
          `fill:${operation.id}`,
          `${operation.token.symbol}: ${formatAmount(result.tokenRaw, decimals)} tokens received for ${formatAmount(result.nativeRaw, nativeDecimals[operation.chain])} ${nativeSymbol[operation.chain]}${position.entryUsd === null ? '' : ` (approximately $${position.entryUsd.toFixed(2)})`}.`,
        );
      } else if (operation.kind === 'sell') {
        const position = operation.positionId ? this.store.position(operation.positionId) : null;
        if (!position) throw new ReviewRequired('Confirmed sale has no matching position');
        this.store.completeSell(operation, position, result);
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
      } else {
        operation.status = 'confirmed';
        this.store.saveOperation(operation);
        this.store.notify(
          `unwrap:${operation.id}`,
          `Unwrapped ${formatAmount(operation.amountRaw, 18)} WETH to ETH.`,
        );
      }
    } catch (error) {
      if (error instanceof PendingTrade) {
        log.info('operation.pending', {
          operationId: operation.id,
          chain: operation.chain,
          reason: error.message,
          swapHash: operation.swapHash,
        });
        operation.error = error.message;
        this.store.saveOperation(operation);
        return;
      }
      if (
        !(error instanceof TradeRejected) &&
        !(error instanceof ReviewRequired) &&
        operation.steps.length > 0
      ) {
        log.error('operation.reconciliation_pending', error, {
          operationId: operation.id,
          chain: operation.chain,
        });
        operation.error = safeError(error);
        this.store.saveOperation(operation);
        this.store.notify(
          `pending:${operation.id}`,
          `${operation.chain} operation is awaiting reconciliation: ${safeError(error)}`,
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
        safeError(error),
        error instanceof ReviewRequired || operation.swapHash !== null,
      );
    }
  }
  private ensureEntryActive(operation: Operation): void {
    this.ensureTradingAllowed();
    if (operation.kind !== 'buy') return;
    if (this.stopped) throw new TradeRejected('Bot is shutting down before swap submission');
    const global = this.store.settings();
    if (!global.chains[operation.chain].enabled)
      throw new TradeRejected('Chain entries were disabled before signing');
    if (operation.signal && Date.now() - operation.signal.date > this.config.maxSignalAgeMs)
      throw new TradeRejected('Call expired before swap submission');
    if (
      operation.signal &&
      global.blockedCallers.some(
        (caller) =>
          caller.replace(/^@/, '') === operation.signal!.caller ||
          caller === operation.signal!.callerId,
      )
    )
      throw new TradeRejected('Caller was blocked before signing');
  }
  private async monitor(chain: Chain): Promise<boolean> {
    const settings = this.store.settings().chains[chain];
    log.debug('positions.poll', { chain, count: this.store.positions(chain).length });
    for (const position of this.store.positions(chain)) {
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
          reason: 'all_exits_disabled',
        });
        continue;
      }
      try {
        const quote = await withLogContext(
          { chain, positionId: position.id, token: position.address },
          () =>
            this.adapters[chain].quoteSell(position.address, position.remainingTokenRaw, settings),
        );
        log.info('position.quote_received', {
          chain,
          positionId: position.id,
          token: position.address,
          quote,
          entryNativeRaw: position.entryNativeRaw,
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
        this.store.savePosition(position);
        if (!decision) {
          log.info('position.waiting', {
            chain,
            positionId: position.id,
            profitPercent: position.lastProfitPercent,
            reason: 'no_exit_triggered',
          });
          continue;
        }
        log.info('exit.triggered', {
          chain,
          positionId: position.id,
          profitPercent: position.lastProfitPercent,
          decision,
        });
        const token: TokenInfo = {
          chain,
          address: position.address,
          symbol: position.symbol,
          decimals: position.decimals,
          marketCapUsd: null,
          liquidityUsd: null,
          usdPrice: null,
          fetchedAt: Date.now(),
        };
        const operation = this.operation(chain, token, 'sell', decision.amountRaw);
        operation.positionId = position.id;
        operation.exitKey = decision.key;
        operation.minimumNativeRaw = decision.minimumNativeRaw;
        operation.quote = quote;
        if (this.store.claim(operation)) {
          await withLogContext(
            { chain, positionId: position.id, token: position.address, operationId: operation.id },
            () => this.advance(operation),
          );
          return true;
        }
        log.info('exit.waiting', {
          chain,
          positionId: position.id,
          reason: 'chain_operation_already_reserved',
        });
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
    const settings = this.store.settings().chains[position.chain];
    try {
      const quote = await this.adapters[position.chain].quoteSell(
        position.address,
        position.remainingTokenRaw,
        settings,
      );
      const quotedValue = BigInt(quote.outputRaw);
      position.lastProfitPercent =
        Number(profitBps(quotedValue, BigInt(position.remainingTokenRaw), position)) / 100;
      position.lastValueNativeRaw = quotedValue.toString();
      position.lastValueUsd =
        quote.nativeUsd === null
          ? null
          : Number(formatAmount(quotedValue, nativeDecimals[position.chain])) * quote.nativeUsd;
      position.lastError = null;
    } catch (error) {
      log.error('position.refresh_failed', error, {
        chain: position.chain,
        positionId: position.id,
        token: position.address,
      });
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
    const missing = this.readiness(position.chain, false);
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
    operation.exitKey = 'manual';
    if (!this.store.claim(operation))
      throw new Error('This chain already has an operation in progress');
    void this.tick();
  }
  async unwrap(): Promise<void> {
    this.ensureTradingAllowed();
    if (this.busy.has('robinhood') || this.store.activeOperation('robinhood'))
      throw new Error('Robinhood has an operation in progress');
    const balance = await this.adapters.robinhood.balance();
    if (!balance.wrappedRaw || BigInt(balance.wrappedRaw) <= 0n)
      throw new Error('There is no idle WETH to unwrap');
    const operation = this.operation(
      'robinhood',
      {
        chain: 'robinhood',
        address: this.adapters.robinhood.address,
        symbol: 'WETH',
        decimals: 18,
        marketCapUsd: null,
        liquidityUsd: null,
        usdPrice: null,
        fetchedAt: Date.now(),
      },
      'unwrap',
      balance.wrappedRaw,
    );
    if (!this.store.claim(operation)) throw new Error('Robinhood has an operation in progress');
    void this.tick();
  }
  reconcile(id: string): void {
    this.ensureTradingAllowed();
    const operation = this.store.operation(id);
    if (!operation || operation.status !== 'review')
      throw new Error('No matching operation awaiting review');
    operation.settings.priorityFee = this.store.settings().chains[operation.chain].priorityFee;
    operation.status = 'active';
    operation.error = null;
    this.store.saveOperation(operation);
    void this.tick();
  }
}
