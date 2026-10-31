import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insufficientFunds } from '../src/trading/funds.js';

test('nested RPC and API funds errors are permanent while unrelated provider failures are not', () => {
  assert.equal(insufficientFunds(new Error('insufficient funds for gas * price + value')), true);
  assert.equal(
    insufficientFunds({ details: { responseBody: { errorCode: 'InsufficientBalanceError' } } }),
    true,
  );
  assert.equal(
    insufficientFunds({ cause: { message: 'ERC20: transfer amount exceeds balance' } }),
    true,
  );
  assert.equal(
    insufficientFunds({ details: { responseBody: { detail: 'BALANCE_NOT_SUFFICIENT' } } }),
    true,
  );
  assert.equal(insufficientFunds(new Error('V3TooLittleReceived')), false);
  assert.equal(insufficientFunds(new Error('API account has insufficient credits')), false);
  assert.equal(insufficientFunds({ status: 429, message: 'Too many requests' }), false);
  const cyclic: { cause?: unknown } = {};
  cyclic.cause = cyclic;
  assert.equal(insufficientFunds(cyclic), false);
});
