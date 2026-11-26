import assert from 'node:assert/strict';
import test from 'node:test';
import { decideGuard, repairPushes } from './bin/guard-rules.mjs';
import { head, push, required } from './fixtures/guard/cases.mjs';

function action(rounds, { observations, orders, receipts, config } = {}) {
  return decideGuard({
    rounds, pushes: repairPushes(rounds, observations), orders, receipts, config,
    state: { classification: '要修', head: rounds.at(-1).after_head },
  })?.type ?? null;
}

test('SC1: checkpoint triggers once after the third repair push', () => {
  const rounds = [1, 2, 3, 4].map((index) => push(index));
  assert.equal(action(rounds.slice(0, 2)), null);
  assert.equal(action(rounds.slice(0, 3)), 'checkpoint');
  assert.equal(action(rounds, { orders: [{ type: 'checkpoint' }] }), null);
  assert.equal(action(rounds.slice(0, 2), { config: { checkpointAfter: 2 } }), 'checkpoint');
});

test('SC2: repeated thread swaps once; fresh recurrence after successful swap stops', () => {
  const rounds = [1, 2, 3, 4].map((index) => push(index));
  const observations = Object.fromEntries(rounds.map(({ id }) => [id, { threads: ['example-thread'] }]));
  assert.equal(action(rounds.slice(0, 2), { observations }), 'swap');
  const swapped = {
    observations, orders: [{ id: 'swap-example', type: 'swap', payload: { push_id: 'push:2' } }],
    receipts: { 'swap-example': { result: 'created' } },
  };
  assert.equal(action(rounds.slice(0, 2), swapped), null);
  assert.equal(action(rounds, swapped), 'stop_and_notify');
});

test('failed swap stops on the next recurrence without issuing another swap', () => {
  const rounds = [1, 2, 3, 4].map((index) => push(index));
  const observations = Object.fromEntries(rounds.map(({ id }) => [id, { threads: ['example-thread'] }]));
  const attempted = {
    observations, orders: [{ id: 'swap-example', type: 'swap', payload: { push_id: 'push:2' } }],
    receipts: { 'swap-example': { result: 'failed' } },
  };
  assert.equal(action(rounds.slice(0, 2), attempted), null);
  assert.equal(action(rounds.slice(0, 3), attempted), 'checkpoint');
  assert.equal(action(rounds, attempted), 'stop_and_notify');
});

test('SC3: consecutive regressions swap; a clean push or infrastructure failure breaks the streak', () => {
  const first = push(1, [required('unit', 'passed')], [required('unit', 'failed')]);
  const second = push(2, [required('build', 'passed')], [required('build', 'failed')]);
  assert.equal(action([first, second]), 'swap');
  const third = { ...second, id: 'push:3', after_head: head(3) };
  const config = { checkpointAfter: 10 };
  assert.equal(action([first, push(2), third], { config }), null);
  assert.equal(action([first, { ...second, after_required_checks: [required('build', 'failed', true)] }]), null);
  assert.equal(action([first, push(2, [required('unit', 'failed')], [required('unit', 'failed')])]), 'swap');
});
