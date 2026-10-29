import type { ExitSettings } from '../domain.js';

export function exitReasonLabel(key: string | null, exits: ExitSettings): string {
  if (key === null || key === 'manual') return 'Manual sale';
  if (key === 'sl')
    return exits.stopLoss.lossPercent === null
      ? 'Stop loss'
      : `Stop loss at -${exits.stopLoss.lossPercent}%`;
  if (key === 'tp' || key.startsWith('tp:')) {
    const target = exits.takeProfits.find((tier) => `tp:${tier.id}` === key);
    return target ? `Take profit at +${target.profitPercent}%` : 'Take profit';
  }
  if (
    key === 'trail:sl' ||
    key.startsWith('trail:sl:') ||
    key === 'trail:tp' ||
    key.startsWith('trail:tp:')
  ) {
    const kind = key.startsWith('trail:sl') ? 'sl' : 'tp';
    const title = kind === 'sl' ? 'Trailing stop loss' : 'Trailing take profit';
    const rule = kind === 'sl' ? exits.trailingSl : exits.trailingTp;
    const id = key.slice(`trail:${kind}:`.length);
    const stage =
      key === `trail:${kind}` ? rule : rule.stages?.find((candidate) => candidate.id === id);
    if (!stage || stage.activationPercent === null || stage.drawdownPercent === null) return title;
    const activation =
      stage.activationPercent === 0
        ? 'active from entry'
        : `activated at +${stage.activationPercent}%`;
    return `${title}: ${stage.drawdownPercent}% below peak (${activation})`;
  }
  return 'Automatic exit';
}
