// Mivo pre-review sends a PR to review only when every check is green, required or not (2026-08-04).
// 2026-11-03 #1641: an optional check failed and the watcher, which looked at required checks only, never repaired it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { failedOptionalActions } from './bin/mivo-ci.mjs';
import { collectPr, scanOnce, watcherPaths, REPO } from './bin/mivo-watcher.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff, isChildPrList } from './handoff.fixture.mjs';

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

// The cases below walk the production path: collectPr → collectPublicReview → collectMivoCiSteps for the CI
// snapshot, then scanOnce → feedbackItems for the repair dispatch. Handing `optionalCi` or `ci.optional` to
// evaluatePublicReview/feedbackItems directly (what the first version of these cases did) misses both wiring points.
const base = 'b'.repeat(40);
const releaseEpoch = 'ready:PR_10:EV_READY:2026-11-01T00:00:00Z';
const view = () => ({
  id: 'PR_10', number: 10, title: 't', body: '', url: 'https://example.invalid/pull/10', state: 'OPEN', isDraft: false,
  headRefOid: head, headRefName: 'fix/x', baseRefOid: base, baseRefName: 'main', createdAt: '2026-11-01T00:00:00Z',
  author: { login: 'owner' }, isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
});
function gh({ optional = [run('pr-handoff-gate', 'failure', { id: 21 })] } = {}) {
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  return (args) => {
    const endpoint = args[1];
    if (endpoint === 'view') return JSON.stringify(view());
    if (endpoint === 'checks') return '[]';
    if (endpoint === `repos/${repo}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${repo}/rules/branches/main?per_page=100`) return JSON.stringify([[]]);
    if (endpoint === `repos/${repo}/branches/main/protection`) return JSON.stringify({ url: 'x', required_status_checks: null });
    if (endpoint === `repos/${repo}/contents/docs/sync/required-checks.json?ref=${base}`) {
      return JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['verify'], pr_only: [] })).toString('base64') });
    }
    if (endpoint === `repos/${repo}/commits/${head}/check-runs?per_page=100&filter=all`) return JSON.stringify([{ check_runs: optional }]);
    if (endpoint === `repos/${repo}/commits/${head}/statuses?per_page=100`) {
      return JSON.stringify([[{ id: 3, context: 'verify', state: 'success', created_at: '2026-11-03T10:10:00Z' }]]);
    }
    if (endpoint === `repos/${repo}/actions/workflows/review-pr.yml`) return JSON.stringify({ path: '.github/workflows/review-pr.yml', state: 'active' });
    if (endpoint === `repos/${repo}/actions/variables/MIVO_REVIEW_MODE`) return JSON.stringify({ name: 'MIVO_REVIEW_MODE', value: 'live' });
    if (endpoint === 'graphql') {
      const query = String(args.at(-1));
      if (query.includes('mergeStateStatus')) return JSON.stringify({ data: { node: { mergeStateStatus: 'CLEAN', baseRef: { name: 'main', target: { oid: base } } } } });
      if (query.includes('timelineItems(')) return JSON.stringify({ data: { node: { timelineItems: page([{ __typename: 'ReadyForReviewEvent', id: 'EV_READY', createdAt: '2026-11-01T00:00:00Z' }]) } } });
      const field = ['reviewThreads', 'comments', 'reviews', 'labels'].find((name) => query.includes(`${name}(`)) ?? 'labels';
      return JSON.stringify({ data: { node: { [field]: page([]) } } });
    }
    return '[]';
  };
}
const listedPr = (extra = {}) => handoffPr({ number: 10, id: 'PR_10', headRefOid: head, baseRefOid: base, headRefName: 'fix/x', title: 't', isDraft: false, releaseEpoch, ...extra });
const prRef = { number: 10, id: 'PR_10', headRefOid: head, baseRefOid: base };

// SC4: the merge-ready verdict reads the optional failures the collector put into `snapshot.optionalCi`.
test('a red optional check keeps the PR from being merge-ready', () => {
  const collected = collectPr(prRef, { ghFn: gh() });
  assert.deepEqual(collected.ci.optional.map((item) => item.context), ['pr-handoff-gate']);
  assert.equal(collected.ci.status, 'green', collected.ci.reason);
  assert.equal(collected.mergeReady, false);
  assert.ok(collected.reviewEvidence.blockers.includes('optional-ci-failed'), String(collected.reviewEvidence.blockers));
});
test('a green optional check adds no optional-ci blocker', () => {
  const collected = collectPr(prRef, { ghFn: gh({ optional: [run('pr-handoff-gate', 'success', { id: 21 })] }) });
  assert.deepEqual(collected.ci.optional, []);
  assert.ok(!collected.reviewEvidence.blockers.includes('optional-ci-failed'), String(collected.reviewEvidence.blockers));
});

function dispatchHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-ci-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const listed = listedPr();
  fs.writeFileSync(paths.statePath, JSON.stringify({ version: 2, repo: REPO, prs: { PR_10: {
    number: 10, nodeId: 'PR_10', sessionId: 's1', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: listed.releaseEpoch, handoff: handoffReceipt(listed), activeTask: { status: 'complete' },
  } } }));
  return { paths, listed };
}

// SC2/SC3 wiring: the failure is identified by collectMivoCiSteps, turned into feedback by the watcher's own
// collection, and dispatched as a repair round. Removing `optional` from the collector's result breaks this case.
test('a red optional check collected from check-runs is dispatched as repair feedback', (t) => {
  const { paths, listed } = dispatchHome(t);
  const collected = collectPr(prRef, { ghFn: gh() });
  const sent = [];
  const result = scanOnce({
    enabled: true, allowDispatch: true, paths, now: '2026-11-03T11:00:00Z',
    ghFn: (args) => isChildPrList(args) ? '[[]]' : args[0] === 'api' ? 'owner' : JSON.stringify([listed]),
    collect: () => withAuthorHandoff(collected, listed),
    ownershipSnapshot: function* () { return { pr: handoffPr(listed) }; },
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 's1' }; },
  });
  assert.equal(result.prs[0].dispatch.attempted, true, JSON.stringify(result.prs[0].dispatch));
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /"key":"ci:optional:pr-handoff-gate"/);
  assert.match(sent[0].message, /"reason":"verified-optional-ci-failure"/);
  assert.match(sent[0].message, /OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY/);
});
