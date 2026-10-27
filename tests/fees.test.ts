import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chainSettingsSchema } from '../src/domain.js';
import { applyField } from '../src/telegram/settings.js';
import { robinhoodGasFees, solanaPriorityLamports } from '../src/chains/fees.js';

test('legacy fee caps are discarded without turning them into a priority override', () => {
  const settings = chainSettingsSchema.parse({ maxNetworkFeeNative: '1' });
  assert.equal(settings.priorityFee, null);
  assert.equal('maxNetworkFeeNative' in settings, false);
});
test('priority input is optional, accepts zero, and can return to automatic mode', () => {
  let settings = chainSettingsSchema.parse({});
  settings = applyField(settings, 'solana', 'solPriorityFee', '0.00001');
  assert.equal(settings.priorityFee, '0.00001');
  settings = applyField(settings, 'solana', 'solPriorityFee', '0');
  assert.equal(settings.priorityFee, '0');
  assert.equal(applyField(settings, 'solana', 'solPriorityFee', 'auto').priorityFee, null);
  assert.throws(() => applyField(settings, 'solana', 'solPriorityFee', '-1'));
  assert.throws(() => applyField(settings, 'solana', 'solPriorityFee', '0.0000000001'));
});
test('Solana priority converts SOL to an exact supported Jupiter lamport amount', () => {
  assert.equal(solanaPriorityLamports('0.00001'), 10_000);
  assert.equal(solanaPriorityLamports('0'), 0);
  assert.equal(solanaPriorityLamports('0.000000001'), 1);
  assert.throws(() => solanaPriorityLamports('10000000'));
  assert.throws(() => solanaPriorityLamports('-1'));
});
test('Robinhood manual gwei overrides the tip while preserving a separate base-fee allowance', () => {
  const automatic = { maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 100_000_000_000n };
  const manual = robinhoodGasFees(10_000_000_000n, '2.5', automatic);
  assert.equal(manual.maxPriorityFeePerGas, 2_500_000_000n);
  assert.equal(manual.maxFeePerGas, 22_500_000_000n);
  assert.equal(robinhoodGasFees(10n, '0', null).maxPriorityFeePerGas, 0n);
  assert.deepEqual(robinhoodGasFees(10_000_000_000n, null, automatic), automatic);
});
