import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { calculateMetrics } from './bin/metrics.mjs';
import { at, fixture, push, required } from './fixtures/guard/cases.mjs';

const since = '2026-01-01';
const repo = 'example-org/example-repo';

test('SC5: ten repair pushes give exact nearest ranks and rates', () => {
  const prs = [1, 1, 2, 2, 2, 3, 3, 4, 5, 6];
  const rounds = prs.map((number, index) => {
    const isRed = index < 2;
    return { ...push(index + 1, [required('unit', 'passed')], [required('unit', isRed ? 'failed' : 'passed')]),
      pr: `${repo}#${number}`, at: at((index + 1) * 2) };
  });
  const records = [...new Set(rounds.map(({ pr }) => pr))].map((pr) => ({
    pr, observations: Object.fromEntries(rounds.filter((round) => round.pr === pr).map(({ id }) => [id, { enteredAt: at(0) }])),
  }));
  const ignored = { ...push(11), at: at(22), before_classification: '没事' };
  const metrics = calculateMetrics({ rounds: [...rounds, ignored], records }, { since });
  assert.deepEqual(metrics.M1, { samples: 10, p50: 10, p75: 16, p90: 18, unknown: 0 });
  assert.equal(metrics.M2, 0.4);
  assert.equal(metrics.M3, 0.2);
  assert.equal(metrics.M4, 1);
});

test('SC6: empty CLI window emits null rates and ranks with exit 0', (t) => {
  const { env } = fixture(t);
  const result = spawnSync(process.execPath, ['watchers/steward/bin/steward-metrics.mjs', '--since', since], {
    env, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  const { M1, M2, M3, M6 } = JSON.parse(result.stdout);
  assert.deepEqual(M1, { samples: 0, p50: null, p75: null, p90: null, unknown: 0 });
  assert.equal(M2, null);
  assert.equal(M3, null);
  assert.deepEqual(M6, { samples: 0, p50: null, max: null, unknown: 0 });
});

test('M3 excludes unfinished required checks unless a regression is already known', () => {
  const passes = [required('unit', 'passed')];
  const pending = [required('unit', 'running')];
  const unfinished = push(1, passes, pending);
  const observed = push(2, passes, pending);
  const red = push(3, passes, [required('unit', 'failed'), required('build', 'running')]);
  const records = [{ pr: observed.pr, observations: { [observed.id]: { checks: passes } } }];
  const metrics = calculateMetrics({ rounds: [unfinished, observed, red], records }, { since });
  assert.equal(metrics.M3, 0.5);
  assert.equal(metrics.M3Unknown, 1);
  const noKnown = calculateMetrics({ rounds: [unfinished] }, { since });
  assert.equal(noKnown.M3, null);
  assert.equal(noKnown.M3Unknown, 1);
});

test('counts typed events and successful receipts; exposure excludes missing endpoints', () => {
  const pr = `${repo}#2`;
  const rounds = [
    { type: 'chore', pr, at: at(3), chore_type: 'ci_rerun' },
    { type: 'chore', pr: 'example-org/other#2', at: at(5), chore_type: 'ci_rerun' },
    { type: 'chore', pr, at: at(12), chore_type: 'ignored' },
    push(5),
  ];
  const orders = ['takeover', 'swap', 'stop_and_notify', 'pause_original', 'pause_original', 'pause_original']
    .map((type, index) => ({ id: String(index), pr, type, created_at: at(4) }));
  const receipts = {
    0: { result: 'created', at: at(5) },
    1: { result: 'failed', at: at(6) },
    3: { result: 'delivered', at: at(9) },
    4: { result: 'delivered', at: at(7) },
  };
  const metrics = calculateMetrics({ rounds, orders, receipts }, { since, until: at(10), repo: repo.toUpperCase() });
  assert.deepEqual(metrics.M5, { chores: { ci_rerun: 1 },
    orders: { takeover: 1, swap: 1, stop_and_notify: 1, pause_original: 3 }, takeovers: 1, swaps: 0, stops: 1 });
  assert.deepEqual(metrics.M6, { samples: 2, p50: 3, max: 5, unknown: 1 });
  assert.equal(metrics.M1.unknown, 1);
});
