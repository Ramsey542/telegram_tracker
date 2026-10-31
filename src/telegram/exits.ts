import { InlineKeyboard } from 'grammy';
import { z } from 'zod';
import { type Chain, type ExitSettings, type TrailStage, trailStageSchema } from '../domain.js';
import { safeError } from '../infra/http.js';
import { bold, code, italic, joinMessages, message, type MessageText } from './presentation.js';

export type ExitKind = 'tp' | 'sl';
export type ExitMode = 'hard' | 'trailing';
export const exitKind = (value: string | undefined): ExitKind => {
  if (value !== 'tp' && value !== 'sl') throw new Error('Unknown exit type');
  return value;
};
export const exitMode = (value: string | undefined): ExitMode => {
  if (value !== 'hard' && value !== 'trailing') throw new Error('Unknown exit mode');
  return value;
};
const title = (kind: ExitKind): string => (kind === 'tp' ? 'Take profit' : 'Stop loss');
export const trailRule = (exits: ExitSettings, kind: ExitKind) =>
  kind === 'tp' ? exits.trailingTp : exits.trailingSl;
const hardEnabled = (exits: ExitSettings, kind: ExitKind): boolean =>
  kind === 'tp' ? exits.takeProfitEnabled : exits.stopLoss.enabled;
export const exitEnabled = (exits: ExitSettings, kind: ExitKind): boolean =>
  hardEnabled(exits, kind) || trailRule(exits, kind).enabled;
export function selectedMode(exits: ExitSettings, kind: ExitKind): ExitMode {
  return (
    (kind === 'tp' ? exits.tpMode : exits.slMode) ??
    (!hardEnabled(exits, kind) && trailRule(exits, kind).enabled ? 'trailing' : 'hard')
  );
}
export function exitReady(
  exits: ExitSettings,
  kind: ExitKind,
  mode = selectedMode(exits, kind),
): boolean {
  if (mode === 'hard')
    return kind === 'tp' ? exits.takeProfits.length > 0 : exits.stopLoss.lossPercent !== null;
  const rule = trailRule(exits, kind);
  return (
    (rule.stages?.length ?? 0) > 0 ||
    (rule.activationPercent !== null && rule.drawdownPercent !== null && rule.sellPercent !== null)
  );
}
export function setExitEnabled(exits: ExitSettings, kind: ExitKind, enabled: boolean): void {
  const mode = selectedMode(exits, kind);
  if (enabled && !exitReady(exits, kind, mode))
    throw new Error(
      mode === 'hard'
        ? `Set the ${title(kind).toLowerCase()} percentage first`
        : 'Add a trailing stage first',
    );
  trailRule(exits, kind).enabled = enabled && mode === 'trailing';
  if (kind === 'tp') exits.takeProfitEnabled = enabled && mode === 'hard';
  else exits.stopLoss.enabled = enabled && mode === 'hard';
}
export function setExitMode(exits: ExitSettings, kind: ExitKind, mode: ExitMode): void {
  const enabled = exitEnabled(exits, kind);
  if (kind === 'tp') exits.tpMode = mode;
  else exits.slMode = mode;
  setExitEnabled(exits, kind, enabled && exitReady(exits, kind, mode));
}
function number(value: string | undefined, name: string): number {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) throw new Error(`Enter a valid ${name}`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Enter a valid ${name}`);
  return parsed;
}
export function saveHardExit(
  exits: ExitSettings,
  kind: ExitKind,
  input: string,
  id: string,
  append = false,
): void {
  const values = input.trim().toLowerCase().split(/\s+/);
  if (values.length > (kind === 'tp' ? 2 : 1))
    throw new Error(
      kind === 'tp'
        ? 'Enter a profit percentage, optionally followed by a sell percentage or rest'
        : 'Enter one stop-loss percentage',
    );
  const percentage = number(values[0], 'percentage');
  if (kind === 'sl') {
    if (percentage < 0.01 || percentage > 99.99)
      throw new Error('Stop loss must be between 0.01% and 99.99%');
    exits.stopLoss.lossPercent = percentage;
  } else {
    if (percentage < 0.01 || percentage > 1_000_000)
      throw new Error('Take profit must be between 0.01% and 1000000%');
    const sale = !values[1] || values[1] === 'rest' ? 'rest' : number(values[1], 'sell percentage');
    if (sale !== 'rest' && (sale <= 0 || sale > 100))
      throw new Error('Sell percentage must be greater than 0 and at most 100');
    const target: ExitSettings['takeProfits'][number] = {
      id,
      profitPercent: percentage,
      sellPercent: sale,
    };
    exits.takeProfits = append ? [...exits.takeProfits, target] : [target];
  }
}
export function saveTrailingStage(
  exits: ExitSettings,
  kind: ExitKind,
  input: string,
  id: string,
): void {
  const [activation, distance, sale, extra] = input.trim().toLowerCase().split(/\s+/);
  if (!activation || !distance || !sale || extra)
    throw new Error(
      'Enter three values: activation profit %, trailing distance %, and sell % (or rest)',
    );
  const stage = trailStageSchema.parse({
    id,
    activationPercent: number(activation, 'activation percentage'),
    drawdownPercent: number(distance, 'trailing distance'),
    sellPercent: sale === 'rest' ? 'rest' : number(sale, 'sell percentage'),
  });
  const rule = trailRule(exits, kind);
  const stages: TrailStage[] = [...(rule.stages ?? [])];
  if (
    !stages.length &&
    rule.activationPercent !== null &&
    rule.drawdownPercent !== null &&
    rule.sellPercent !== null
  )
    stages.push({
      id: `saved-${kind}`,
      activationPercent: rule.activationPercent,
      drawdownPercent: rule.drawdownPercent,
      sellPercent: rule.sellPercent,
    });
  rule.stages = [...stages, stage];
}
export function removeTrailingStage(exits: ExitSettings, kind: ExitKind, id: string): void {
  const rule = trailRule(exits, kind);
  rule.stages = (rule.stages ?? []).filter((stage) => stage.id !== id);
  rule.activationPercent = null;
  rule.drawdownPercent = null;
  rule.sellPercent = null;
  if (!rule.stages.length) rule.enabled = false;
}
export function settingsError(error: unknown): string {
  return error instanceof z.ZodError
    ? [...new Set(error.issues.map((issue) => issue.message))].join('\n')
    : safeError(error);
}
export function exitSummary(exits: ExitSettings, kind: ExitKind): string {
  const mode = selectedMode(exits, kind);
  const modeLabel =
    hardEnabled(exits, kind) && trailRule(exits, kind).enabled
      ? 'Hard + trailing'
      : mode === 'hard'
        ? 'Hard'
        : 'Trailing';
  return `${title(kind)}: ${exitEnabled(exits, kind) ? 'On' : 'Off'} / ${modeLabel}`;
}
export function exitPlanLines(exits: ExitSettings, kind: ExitKind, mode?: ExitMode): string[] {
  const lines: string[] = [];
  const showHard = mode !== 'trailing' || hardEnabled(exits, kind);
  if (showHard && kind === 'sl' && exits.stopLoss.lossPercent !== null)
    lines.push(`Hard SL: -${exits.stopLoss.lossPercent}%, sell all remaining.`);
  if (showHard && kind === 'tp')
    for (const target of [...exits.takeProfits].sort((a, b) => a.profitPercent - b.profitPercent))
      lines.push(
        `Hard TP: +${target.profitPercent}%, sell ${target.sellPercent === 'rest' ? 'remaining tokens' : `${target.sellPercent}% of original`}.`,
      );
  const rule = trailRule(exits, kind);
  if (mode === 'hard' && !rule.enabled) return lines;
  const stages = rule.stages?.length
    ? rule.stages
    : rule.activationPercent !== null && rule.drawdownPercent !== null && rule.sellPercent !== null
      ? [
          {
            activationPercent: rule.activationPercent,
            drawdownPercent: rule.drawdownPercent,
            sellPercent: rule.sellPercent,
          },
        ]
      : [];
  for (const stage of [...stages].sort((a, b) => a.activationPercent - b.activationPercent))
    lines.push(
      `Trailing ${kind.toUpperCase()}: activate +${stage.activationPercent}%, distance ${stage.drawdownPercent}%, sell ${stage.sellPercent === 'rest' ? 'remaining tokens' : `${stage.sellPercent}% of remaining`}.`,
    );
  return lines;
}
export function exitPanel(
  chain: Chain,
  exits: ExitSettings,
  kind: ExitKind,
): { text: MessageText; keyboard: InlineKeyboard } {
  const mode = selectedMode(exits, kind);
  const keyboard = new InlineKeyboard()
    .text(exitEnabled(exits, kind) ? '🔴 Disable' : '🟢 Enable', `exittoggle:${chain}:${kind}`)
    .row()
    .text(`🎯 ${mode === 'hard' ? '> ' : ''}Hard`, `exitmode:${chain}:${kind}:hard`)
    .text(`📈 ${mode === 'trailing' ? '> ' : ''}Trailing`, `exitmode:${chain}:${kind}:trailing`)
    .row();
  const lines: (string | MessageText)[] = [
    bold(title(kind)),
    chain === 'solana' ? 'Solana / SOL' : 'Robinhood / ETH',
    exitSummary(exits, kind),
    '',
  ];
  if (mode === 'hard') {
    if (kind === 'sl')
      lines.push(
        exits.stopLoss.lossPercent === null
          ? 'Loss percentage: not set'
          : `Sell all remaining tokens at -${exits.stopLoss.lossPercent}%.`,
      );
    else {
      if (!exits.takeProfits.length) lines.push('Profit percentage: not set');
      for (const target of [...exits.takeProfits].sort(
        (a, b) => a.profitPercent - b.profitPercent,
      )) {
        lines.push(
          `+${target.profitPercent}%: ${target.sellPercent === 'rest' ? 'sell remaining tokens' : `sell ${target.sellPercent}% of original tokens`}`,
        );
        if (exits.takeProfits.length > 1)
          keyboard.text(`➖ Remove +${target.profitPercent}%`, `deltp:${chain}:${target.id}`).row();
      }
    }
    keyboard.text('✏️ Set percentage', `exitset:${chain}:${kind}`).row();
    if (kind === 'tp' && exits.takeProfits.length)
      keyboard.text('➕ Add another target', `exitaddhard:${chain}:tp`).row();
  } else {
    const rule = trailRule(exits, kind);
    if (rule.stages?.length) {
      for (const [index, stage] of [...rule.stages]
        .sort((a, b) => a.activationPercent - b.activationPercent)
        .entries()) {
        lines.push(
          message`${bold(`Stage ${index + 1}:`)} activate +${stage.activationPercent}%, trail ${stage.drawdownPercent}%, sell ${stage.sellPercent === 'rest' ? 'remaining tokens' : `${stage.sellPercent}% of remaining`}`,
        );
        keyboard.text(`➖ Remove stage ${index + 1}`, `exitdel:${chain}:${kind}:${stage.id}`).row();
      }
    } else if (exitReady(exits, kind, 'trailing')) {
      lines.push(
        `Saved stage: activate +${rule.activationPercent}%, trail ${rule.drawdownPercent}%, sell ${rule.sellPercent}% of remaining.`,
      );
      keyboard.text('➖ Remove saved stage', `exitdel:${chain}:${kind}:saved`).row();
    } else lines.push('No trailing stages yet.');
    keyboard.text('➕ Add stage', `exitset:${chain}:${kind}`).row();
    lines.push(
      '',
      italic(
        'Each stage tracks its own peak after activation and sells once after the configured retreat.',
      ),
    );
  }
  if (hardEnabled(exits, kind) && trailRule(exits, kind).enabled)
    lines.push(
      '',
      italic(
        'Your saved plan has both modes enabled. Selecting a mode keeps only that mode active.',
      ),
    );
  lines.push(
    '',
    italic(
      'Applies to new positions. Use Apply current exit settings on an open position to update it.',
    ),
  );
  return { text: joinMessages(lines), keyboard: keyboard.text('⬅️ Back', `menu:${chain}:exits`) };
}
export function exitPrompt(kind: ExitKind, mode: ExitMode, append = false): MessageText {
  if (mode === 'trailing')
    return joinMessages([
      bold(`Add a trailing ${title(kind).toLowerCase()} stage`),
      '',
      'Send activation profit %, trailing distance %, and sell %:',
      code('50 20 90'),
      'Activate at +50%, trail the highest observed price by 20%, and sell 90% of the remaining tokens.',
      message`Use ${code('1000 10 rest')} to trail all remaining tokens after +1000%.`,
      'Activation 0 starts trailing at entry. A stage triggers on a retreat, not when activation is first reached.',
      '',
      italic('Send /cancel to cancel.'),
    ]);
  return joinMessages([
    bold(`${append ? 'Add' : 'Set'} hard ${title(kind).toLowerCase()}`),
    '',
    kind === 'sl'
      ? 'Send the loss percentage, for example 20. At -20%, sell all remaining tokens.'
      : 'Send the profit percentage, for example 50. At +50%, sell the remaining tokens.',
    ...(kind === 'tp'
      ? [
          'To customize the sale amount, send 50 90 to sell 90% of the original entry at +50%.',
          ...(append ? [] : ['This replaces the current hard TP targets.']),
        ]
      : []),
    '',
    italic('Send /cancel to cancel.'),
  ]);
}
