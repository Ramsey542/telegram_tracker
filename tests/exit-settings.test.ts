import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainSettingsSchema, exitSchema } from '../src/domain.js';
import {
  exitEnabled,
  exitReady,
  exitPanel,
  saveHardExit,
  saveTrailingStage,
  removeTrailingStage,
  selectedMode,
  setExitEnabled,
  setExitMode,
  settingsError,
} from '../src/telegram/exits.js';
import { renderMessage } from '../src/telegram/presentation.js';
import { exitReasonLabel } from '../src/trading/exit-reason.js';

test('exit notifications use readable targets instead of internal rule IDs', () => {
  const exits = exitSchema.parse({
    stopLoss: { enabled: true, lossPercent: 30 },
    takeProfitEnabled: true,
    takeProfits: [{ id: 'target-id', profitPercent: 70, sellPercent: 'rest' }],
    trailingSl: { enabled: true, activationPercent: 0, drawdownPercent: 20, sellPercent: 100 },
    trailingTp: {
      enabled: true,
      stages: [
        { id: 'moon-id', activationPercent: 1000, drawdownPercent: 10, sellPercent: 'rest' },
      ],
    },
  });
  assert.equal(exitReasonLabel('tp:target-id', exits), 'Take profit at +70%');
  assert.equal(exitReasonLabel('sl', exits), 'Stop loss at -30%');
  assert.equal(exitReasonLabel('manual', exits), 'Manual sale');
  assert.equal(
    exitReasonLabel('trail:sl', exits),
    'Trailing stop loss: 20% below peak (active from entry)',
  );
  assert.equal(
    exitReasonLabel('trail:tp:moon-id', exits),
    'Trailing take profit: 10% below peak (activated at +1000%)',
  );
  assert.equal(exitReasonLabel('tp:removed-id', exits), 'Take profit');
  assert.equal(exitReasonLabel('unknown-internal-id', exits), 'Automatic exit');
});

test('an unset stop loss requests configuration before it can be enabled', () => {
  const exits = exitSchema.parse({});
  assert.equal(exitReady(exits, 'sl'), false);
  assert.equal(exitEnabled(exits, 'sl'), false);
  saveHardExit(exits, 'sl', '20', 'unused');
  setExitEnabled(exits, 'sl', true);
  assert.equal(exitSchema.parse(exits).stopLoss.enabled, true);
  assert.equal(exits.stopLoss.lossPercent, 20);
  setExitEnabled(exits, 'sl', false);
  assert.equal(exits.stopLoss.lossPercent, 20);
});
test('hard TP accepts one percentage and preserves optional custom sale allocations', () => {
  const exits = exitSchema.parse({});
  saveHardExit(exits, 'tp', '50', 'single');
  assert.equal(exits.takeProfits[0]?.sellPercent, 'rest');
  saveHardExit(exits, 'tp', '50 90', 'first');
  saveHardExit(exits, 'tp', '1000 rest', 'last', true);
  setExitEnabled(exits, 'tp', true);
  assert.equal(exitSchema.parse(exits).takeProfits.length, 2);
  assert.throws(() => saveHardExit(exits, 'sl', '20 50', 'unused'));
});
test('changing modes preserves saved values and enables only the configured mode', () => {
  const exits = exitSchema.parse({});
  saveHardExit(exits, 'tp', '50 90', 'hard');
  setExitEnabled(exits, 'tp', true);
  setExitMode(exits, 'tp', 'trailing');
  assert.equal(exitEnabled(exits, 'tp'), false);
  saveTrailingStage(exits, 'tp', '50 20 90', 'first');
  saveTrailingStage(exits, 'tp', '1000 10 rest', 'last');
  setExitEnabled(exits, 'tp', true);
  assert.equal(exits.takeProfitEnabled, false);
  assert.equal(exits.trailingTp.enabled, true);
  setExitMode(exits, 'tp', 'hard');
  assert.equal(exits.takeProfitEnabled, true);
  assert.equal(exits.trailingTp.enabled, false);
  assert.equal(exits.trailingTp.stages?.length, 2);
});
test('removing the last trailing stage disables it without resurrecting the saved legacy rule', () => {
  const exits = exitSchema.parse({
    trailingSl: { enabled: true, activationPercent: 0, drawdownPercent: 20, sellPercent: 100 },
  });
  assert.equal(selectedMode(exits, 'sl'), 'trailing');
  saveTrailingStage(exits, 'sl', '50 10 50', 'second');
  assert.equal(exits.trailingSl.stages?.length, 2);
  removeTrailingStage(exits, 'sl', 'saved-sl');
  removeTrailingStage(exits, 'sl', 'second');
  assert.equal(exits.trailingSl.enabled, false);
  assert.equal(exitReady(exits, 'sl', 'trailing'), false);
});
test('invalid stages return a readable validation message', () => {
  const exits = exitSchema.parse({});
  saveTrailingStage(exits, 'tp', '50 20 90', 'first');
  saveTrailingStage(exits, 'tp', '50 10 rest', 'duplicate');
  const result = exitSchema.safeParse(exits);
  assert.equal(result.success, false);
  if (result.success) return;
  const text = settingsError(result.error);
  assert.match(text, /distinct activation/);
  assert.equal(text.includes('"code"'), false);
  assert.throws(() => saveTrailingStage(exitSchema.parse({}), 'tp', '50 100 90', 'bad'));
});
test('the panel exposes one enable switch and the two exit modes', () => {
  const settings = chainSettingsSchema.parse({});
  const panel = exitPanel('solana', settings.exits, 'sl');
  const buttons = panel.keyboard.inline_keyboard.flat();
  assert.equal(
    buttons.filter(
      (button) => 'callback_data' in button && button.callback_data.startsWith('exittoggle:'),
    ).length,
    1,
  );
  assert.ok(buttons.some((button) => button.text.includes('Hard')));
  assert.ok(buttons.some((button) => button.text.includes('Trailing')));
  assert.match(renderMessage(panel.text).text, /not set/);
});
