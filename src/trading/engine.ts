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
    await Promise.all(chains.map((chain) => this.tickChain(chain)));
  }
  readiness(chain: Chain, buying = true): string[] {
    const settings = this.store.settings().chains[chain];
    const missing = this.adapters[chain].readiness(settings);
    if (buying && !settings.buySizeNative) missing.push('buy size');
    if (buying && settings.buySlippagePercent === null) missing.push('buy slippage');
    if (settings.sellSlippagePercent === null) missing.push('sell slippage');
    if (!settings.maxNetworkFeeNative) missing.push('maximum network fee');
    if (settings.buySizeNative) parseAmount(settings.buySizeNative, nativeDecimals[chain]);
    return missing;
  }
  async resume(): Promise<void> {
    const enabled = chains.filter((chain) => this.store.settings().chains[chain].enabled);
    if (enabled.length === 0) throw new Error('Enable at least one configured chain first');
    for (const chain of enabled) {
      const missing = this.readiness(chain);
      if (missing.length) throw new Error(`${chain}: configure ${missing.join(', ')}`);
      await this.adapters[chain].verifyNetwork();
    }
    this.store.updateSettings((settings) => {
      settings.tradingEnabled = true;
    });
  }
  pause(): void {
    this.store.updateSettings((settings) => {
      settings.tradingEnabled = false;
    });
  }
  private async tickChain(chain: Chain): Promise<void> {
    if (this.busy.has(chain)) return;
    this.busy.add(chain);
    try {
      const operation = this.store.activeOperation(chain);
      if (operation) {
        if (operation.status === 'active') await this.advance(operation);
        return;
      }
      if (await this.monitor(chain)) return;
      const global = this.store.settings();
      if (!global.tradingEnabled || !global.chains[chain].enabled) return;
      for (let index = 0; index < 25; index++) {
        const signal = this.store.nextSignal(chain);
        if (!signal) return;
        let settings: ChainSettings;
        try {
          settings = this.validateSignal(signal);
        } catch (error) {
          this.store.skipSignal(signal.id, safeError(error));
          continue;
        }
        try {
          await this.consider(signal, settings);
        } catch (error) {
          this.store.skipSignal(signal.id, safeError(error));
        }
        return;
      }
    } catch (error) {
      this.store.notify(
        `engine:${chain}:${Math.floor(Date.now() / 300_000)}`,
        `${chain} monitoring issue: ${safeError(error)}`,
      );
    } finally {
      this.busy.delete(chain);
    }
  }
  private validateSignal(signal: CallSignal): ChainSettings {
    const global = this.store.settings();
    const settings = global.chains[signal.chain];
    const age = Date.now() - signal.date;
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
    const missing = this.readiness(signal.chain);
    if (missing.length) throw new TradeRejected(`Configure ${missing.join(', ')}`);
    return settings;
  }
  private async consider(signal: CallSignal, settings: ChainSettings): Promise<void> {
    const token = await this.adapters[signal.chain].tokenInfo(signal.address);
    await this.filters.check(token, settings);
    const amountRaw = parseAmount(settings.buySizeNative!, nativeDecimals[signal.chain]);
    if (amountRaw <= 0n) throw new TradeRejected('Buy size rounds to zero');
    const balance = await this.adapters[signal.chain].balance();
    if (
      BigInt(balance.nativeRaw) <=
      amountRaw + 2n * parseAmount(settings.maxNetworkFeeNative!, nativeDecimals[signal.chain])
    )
      throw new TradeRejected('Insufficient balance for the buy and entry/exit fee reserves');
    const operation = this.operation(signal.chain, token, 'buy', amountRaw.toString());
    operation.signal = signal;
    operation.settings = structuredClone(settings);
    if (!this.store.claim(operation)) {
      this.store.skipSignal(signal.id, 'Another operation reserved this token');
      return;
    }
    await this.advance(operation);
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
    try {
      const result = await this.adapters[operation.chain].advance(
        operation,
        () => this.store.saveOperation(operation),
        async () => {
          if (operation.kind !== 'buy') return;
          this.ensureEntryActive(operation);
          const token = await this.adapters[operation.chain].tokenInfo(operation.address);
          await this.filters.check(token, operation.settings);
          operation.token = token;
        },
        () => this.ensureEntryActive(operation),
      );
      if (operation.kind === 'buy') {
        if (BigInt(result.tokenRaw) <= 0n || BigInt(result.nativeRaw) <= 0n)
          throw new ReviewRequired('Confirmed purchase accounting is invalid');
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
              : Number(
                  formatAmount(result.tokenRaw, operation.token.decimals, operation.token.decimals),
                ) * operation.token.usdPrice;
        const position: Position = {
          id: this.store.newId(),
          chain: operation.chain,
          address: operation.address,
          symbol: operation.token.symbol,
          decimals: operation.token.decimals,
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
        this.store.notify(
          `fill:${operation.id}`,
          `${operation.token.symbol}: ${formatAmount(result.tokenRaw, operation.token.decimals)} tokens received for ${formatAmount(result.nativeRaw, nativeDecimals[operation.chain])} ${nativeSymbol[operation.chain]}${position.entryUsd === null ? '' : ` (approximately $${position.entryUsd.toFixed(2)})`}.`,
        );
      } else if (operation.kind === 'sell') {
        const position = operation.positionId ? this.store.position(operation.positionId) : null;
        if (!position) throw new ReviewRequired('Confirmed sale has no matching position');
        this.store.completeSell(operation, position, result);
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
        operation.error = error.message;
        this.store.saveOperation(operation);
        return;
      }
      if (
        !(error instanceof TradeRejected) &&
        !(error instanceof ReviewRequired) &&
        operation.steps.length > 0
      ) {
        operation.error = safeError(error);
        this.store.saveOperation(operation);
        this.store.notify(
          `pending:${operation.id}`,
          `${operation.chain} operation is awaiting reconciliation: ${safeError(error)}`,
        );
        return;
      }
      this.store.failOperation(
        operation,
        safeError(error),
        error instanceof ReviewRequired || operation.swapHash !== null,
      );
    }
  }
  private ensureEntryActive(operation: Operation): void {
    if (operation.kind !== 'buy') return;
    if (this.stopped) throw new TradeRejected('Bot is shutting down before swap submission');
    const global = this.store.settings();
    if (!global.tradingEnabled || !global.chains[operation.chain].enabled)
      throw new TradeRejected('Entries were paused before signing');
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
    for (const position of this.store.positions(chain)) {
      if (
        !position.exits.stopLoss.enabled &&
        !position.exits.takeProfitEnabled &&
        !position.exits.trailingSl.enabled &&
        !position.exits.trailingTp.enabled
      )
        continue;
      try {
        const quote = await this.adapters[chain].quoteSell(
          position.address,
          position.remainingTokenRaw,
          settings,
        );
        const decision = evaluateExits(position, quote);
        const quotedValue = BigInt(quote.outputRaw);
        position.lastValueNativeRaw = quotedValue.toString();
        position.lastValueUsd =
          quote.nativeUsd === null
            ? null
            : Number(formatAmount(quotedValue, nativeDecimals[chain])) * quote.nativeUsd;
        position.lastError = null;
        this.store.savePosition(position);
        if (!decision) continue;
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
          await this.advance(operation);
          return true;
        }
      } catch (error) {
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
      position.lastError = safeError(error);
    }
    this.store.savePosition(position);
    return position;
  }
  async sell(positionId: string, percentage: number): Promise<void> {
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
    const operation = this.store.operation(id);
    if (!operation || operation.status !== 'review')
      throw new Error('No matching operation awaiting review');
    operation.settings.maxNetworkFeeNative =
      this.store.settings().chains[operation.chain].maxNetworkFeeNative;
    operation.status = 'active';
    operation.error = null;
    this.store.saveOperation(operation);
    void this.tick();
  }
}
