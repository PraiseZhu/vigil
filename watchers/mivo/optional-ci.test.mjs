// Mivo pre-review sends a PR to review only when every check is green, required or not (2026-08-04).
// 2026-11-03 #1641: an optional check failed and the watcher, which looked at required checks only, never repaired it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { failedOptionalActions } from './bin/mivo-ci.mjs';
import { evaluatePublicReview } from './bin/public-review.mjs';

const repo = 'example-org/example-plugin';
const head = 'a'.repeat(40);
const job = (run, id) => `https://github.com/${repo}/actions/runs/${run}/job/${id}`;
const actions = { id: 15368, slug: 'github-actions' };
const run = (name, conclusion, { id = 1, started = '2026-11-03T10:00:00Z', app = actions, sha = head, status = 'completed' } = {}) => ({
  id, name, conclusion, status, app, head_sha: sha, started_at: started, details_url: job(100 + id, 200 + id),
});
const policy = { required: [{ context: 'verify', appId: null }] };

test('only the latest failed optional Actions run on this head is reported', () => {
  const checks = [
    run('pr-handoff-gate', 'failure', { id: 1 }),
    run('lifeline spec (TLA+)', 'failure', { id: 2, started: '2026-11-03T10:00:00Z' }),
    run('lifeline spec (TLA+)', 'success', { id: 3, started: '2026-11-03T10:05:00Z' }), // re-run passed
    run('verify', 'failure', { id: 4 }), // required: handled by the required path
    run('review-pr', 'failure', { id: 5 }), // review infrastructure
    run('Analyze (javascript-typescript)', 'failure', { id: 6 }), // CodeQL goes through code scanning
    run('Greptile Review', 'failure', { id: 7, app: { id: 9, slug: 'greptile-apps' } }), // not an Actions check
    run('Windows unit shard (1/4)', 'cancelled', { id: 8 }), // cancelled is not a failure
    run('old head check', 'failure', { id: 9, sha: 'b'.repeat(40) }),
    run('still running', null, { id: 10, status: 'in_progress' }),
  ];
  const out = failedOptionalActions({ checks, policy, repo, headSha: head });
  assert.deepEqual(out.map((item) => item.context), ['pr-handoff-gate']);
  assert.deepEqual(out[0].evidence, { id: 1, sha: head, runId: 101, url: job(101, 201) });
});

test('timed out and startup failures count, a check without a job URL does not', () => {
  const checks = [
    run('a', 'timed_out', { id: 11 }),
    run('b', 'startup_failure', { id: 12 }),
    { ...run('c', 'failure', { id: 13 }), details_url: 'https://example.invalid/elsewhere' },
  ];
  assert.deepEqual(failedOptionalActions({ checks, policy, repo, headSha: head }).map((item) => item.context), ['a', 'b']);
});

test('a red optional check keeps the PR from being merge-ready', () => {
  const h = head, b = 'b'.repeat(40);
  const snapshot = {
    pr: { state: 'OPEN', isDraft: false, sameRepository: true, number: 10, headRefOid: h, baseRefOid: b, baseRefName: 'main', releaseEpoch: 'ready:2026-09-10T00:00:00Z', author: { login: 'owner' }, mergeStateStatus: 'CLEAN' },
    comments: [], requiredChecksGreen: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', threads: [], labels: [],
    reviews: [], optionalCi: [{ context: 'pr-handoff-gate', status: 'failed' }],
  };
  const v = evaluatePublicReview({ snapshot, checks: [], runs: {} });
  assert.equal(v.ready, false);
  assert.ok(v.blockers.includes('optional-ci-failed'));
});
