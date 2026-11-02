import {
  bps,
  emptyTrail,
  entryCostRaw,
  profitBps,
  type Position,
  type Quote,
  type TrailRule,
  type TrailState,
} from '../domain.js';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'trading.exits' });

export interface ExitDecision {
  key: string;
  amountRaw: string;
}

function trailing(
  rule: TrailRule,
  state: TrailState,
  key: string,
  native: bigint,
  quantity: bigint,
  profit: bigint,
  entryValue: bigint,
): ExitDecision | null {
  if (
    !rule.enabled ||
    state.sold ||
    rule.activationPercent === null ||
    rule.drawdownPercent === null ||
    rule.sellPercent === null
  ) {
    log.info('exit.trailing_check', {
      key,
      decision: 'wait',
      reason: !rule.enabled ? 'disabled' : state.sold ? 'already_sold' : 'not_configured',
      rule,
      state,
    });
    return null;
  }
  if (!state.active && (rule.activationPercent === 0 || profit >= bps(rule.activationPercent))) {
    state.active = true;
    state.peakNativeRaw = (
      rule.activationPercent === 0 && entryValue > native ? entryValue : native
    ).toString();
    state.peakTokenRaw = quantity.toString();
    log.info('exit.trailing_activated', { key, profitPercent: Number(profit) / 100, rule, state });
  }
  if (!state.active) {
    log.info('exit.trailing_check', {
      key,
      decision: 'wait',
      reason: 'activation_threshold_not_met',
      profitPercent: Number(profit) / 100,
      rule,
    });
    return null;
  }
  if (native * BigInt(state.peakTokenRaw) > BigInt(state.peakNativeRaw) * quantity) {
    state.peakNativeRaw = native.toString();
    state.peakTokenRaw = quantity.toString();
  }
  if (
    native * BigInt(state.peakTokenRaw) * 10_000n >
    BigInt(state.peakNativeRaw) * quantity * (10_000n - bps(rule.drawdownPercent))
  ) {
    log.info('exit.trailing_check', {
      key,
      decision: 'wait',
      reason: 'drawdown_threshold_not_met',
      nativeRaw: native,
      quantityRaw: quantity,
      rule,
      state,
    });
    return null;
  }
  const amount = (quantity * bps(rule.sellPercent)) / 10_000n;
  log.info('exit.trailing_check', {
    key,
    decision: amount > 0n ? 'sell' : 'wait',
    reason: amount > 0n ? 'drawdown_threshold_met' : 'sell_amount_rounds_to_zero',
    nativeRaw: native,
    quantityRaw: quantity,
    amountRaw: amount,
    rule,
    state,
  });
  if (amount <= 0n) return null;
  return { key, amountRaw: amount.toString() };
}

function trailingStages(
  position: Position,
  kind: 'sl' | 'tp',
  native: bigint,
  quantity: bigint,
  profit: bigint,
): ExitDecision | null {
  const rule = kind === 'sl' ? position.exits.trailingSl : position.exits.trailingTp;
  const entryValue = (entryCostRaw(position) * quantity) / BigInt(position.originalTokenRaw);
  if (!rule.stages?.length)
    return trailing(
      rule,
      kind === 'sl' ? position.trailingSl : position.trailingTp,
      `trail:${kind}`,
      native,
      quantity,
      profit,
      entryValue,
    );
  position.trailingStages ??= {};
  let decision: ExitDecision | null = null;
  for (const stage of [...rule.stages].sort((a, b) => a.activationPercent - b.activationPercent)) {
    const key = `trail:${kind}:${stage.id}`;
    const state = (position.trailingStages[key] ??= {
      ...emptyTrail(),
      sold:
        BigInt(
          position.exitFills[key] ??
            (stage.id === `saved-${kind}` ? position.exitFills[`trail:${kind}`] : undefined) ??
            '0',
        ) > 0n,
    });
    const candidate = trailing(
      {
        enabled: rule.enabled,
        activationPercent: stage.activationPercent,
        drawdownPercent: stage.drawdownPercent,
        sellPercent: stage.sellPercent === 'rest' ? 100 : stage.sellPercent,
      },
      state,
      key,
      native,
      quantity,
      profit,
      entryValue,
    );
    decision ??= candidate;
  }
  return decision;
}

export function evaluateExits(position: Position, quote: Quote): ExitDecision | null {
  const quantity = BigInt(position.remainingTokenRaw);
  if (
    quantity <= 0n ||
    quote.inputRaw !== quantity.toString() ||
    Date.now() - quote.receivedAt > 30_000
  ) {
    log.warn('exit.quote_rejected', {
      positionId: position.id,
      remainingTokenRaw: position.remainingTokenRaw,
      inputRaw: quote.inputRaw,
      quoteAgeMs: Date.now() - quote.receivedAt,
      reason:
        quantity <= 0n
          ? 'empty_position'
          : quote.inputRaw !== quantity.toString()
            ? 'quote_quantity_mismatch'
            : 'quote_stale',
    });
    return null;
  }
  const native = BigInt(quote.outputRaw);
  const profit = profitBps(native, quantity, position);
  position.lastProfitPercent = Number(profit) / 100;
  const settings = position.exits;
  log.info('exit.evaluating', {
    positionId: position.id,
    profitPercent: position.lastProfitPercent,
    quote,
    entryNativeRaw: position.entryNativeRaw,
    entrySwapNativeRaw: position.entrySwapNativeRaw,
    originalTokenRaw: position.originalTokenRaw,
    remainingTokenRaw: quantity,
    settings,
    exitFills: position.exitFills,
  });
  const stopLossHit =
    settings.stopLoss.enabled &&
    settings.stopLoss.lossPercent !== null &&
    profit <= -bps(settings.stopLoss.lossPercent);
  log.info('exit.stop_loss_check', {
    enabled: settings.stopLoss.enabled,
    lossPercent: settings.stopLoss.lossPercent,
    profitPercent: position.lastProfitPercent,
    decision: stopLossHit ? 'sell_all' : 'wait',
    reason: !settings.stopLoss.enabled
      ? 'disabled'
      : settings.stopLoss.lossPercent === null
        ? 'not_configured'
        : stopLossHit
          ? 'threshold_met'
          : 'threshold_not_met',
  });
  if (
    settings.stopLoss.enabled &&
    settings.stopLoss.lossPercent !== null &&
    profit <= -bps(settings.stopLoss.lossPercent)
  )
    return {
      key: 'sl',
      amountRaw: quantity.toString(),
    };
  const trailingSl = trailingStages(position, 'sl', native, quantity, profit);
  const trailingTp = trailingStages(position, 'tp', native, quantity, profit);
  if (trailingSl) return trailingSl;
  if (settings.takeProfitEnabled) {
    for (const tier of [...settings.takeProfits].sort(
      (a, b) => a.profitPercent - b.profitPercent,
    )) {
      if (profit < bps(tier.profitPercent)) {
        log.info('exit.take_profit_check', {
          tier,
          profitPercent: position.lastProfitPercent,
          decision: 'wait',
          reason: 'threshold_not_met',
        });
        continue;
      }
      const key = `tp:${tier.id}`;
      const target =
        tier.sellPercent === 'rest'
          ? quantity
          : (BigInt(position.originalTokenRaw) * bps(tier.sellPercent)) / 10_000n -
            BigInt(position.exitFills[key] ?? '0');
      const amount = target < quantity ? target : quantity;
      log.info('exit.take_profit_check', {
        key,
        tier,
        profitPercent: position.lastProfitPercent,
        amountRaw: amount,
        alreadyFilledRaw: position.exitFills[key] ?? '0',
        decision: amount > 0n ? 'sell' : 'wait',
        reason: amount > 0n ? 'threshold_met' : 'allocation_already_sold_or_rounds_to_zero',
      });
      if (amount > 0n)
        return {
          key,
          amountRaw: amount.toString(),
        };
    }
  } else log.info('exit.take_profit_check', { decision: 'wait', reason: 'disabled' });
  return trailingTp;
}
