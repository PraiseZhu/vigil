import test from 'node:test';
import assert from 'node:assert/strict';
import { planReviewRecheck, requestReviewRecheck, threadsAllResolved } from './bin/mivo-pr-actions.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const now = '2026-10-21T00:00:00Z';

function task() {
  return {
    dispatchId: 'd1', headRefOid: HEAD,
    repairPolicy: { policyVersion: 2, items: [{ key: 'mivo-review:PRRT_1:c1', action: 'code-fix', reason: 'explicit-p0-p1-finding', canChangeCode: true }] },
    feedback: [{ key: 'mivo-review:PRRT_1:c1', source: 'mivo-review', nativeId: 'PRRT_1:c1', contentHash: 'h1', body: 'P1: x' }],
  };
}
function result(extra = {}) {
  return {
    schemaVersion: 2, dispatchId: 'd1', head: HEAD, status: 'complete', receiptId: 'rcpt-1',
    feedbackCoverage: { dispositions: [{ key: 'mivo-review:PRRT_1:c1', disposition: 'no-change' }] },
    scs: [{ id: 'SC1', status: 'no-change', feedbackKeys: ['mivo-review:PRRT_1:c1'], evidence: ['当前 head 无法复现'] }],
    ...extra,
  };
}
function snapshot(extra = {}) {
  return {
    pr: { id: 'PR_1', number: 9, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
      headRefOid: HEAD, headRefName: 'feat', baseRefOid: BASE, baseRefName: 'main', releaseEpoch: 'ready:e' },
    reviewReason: 'review-findings',
    reviewEvidence: { reason: 'review-findings', runId: 33, checkRunId: 5, reviewId: 'R2', tier: 'standard', findingIds: ['R2'] },
    ...extra,
  };
}
const observed = [{ key: 'mivo-review:PRRT_1:c1', source: 'mivo-review', nativeId: 'PRRT_1:c1', contentHash: 'h1', body: 'P1: x' }];

function run(gen, ghFn) {
  let step = gen.next();
  while (!step.done) {
    const fn = step.value;
    try { step = gen.next(typeof fn === 'function' ? fn() : fn); }
    catch (error) { step = gen.throw(error); }
  }
  return step.value;
}

test('planReviewRecheck requires complete no-change coverage on unchanged machine findings', () => {
  assert.equal(planReviewRecheck({ snapshot: snapshot(), entry: {}, task: task(), result: result(), observed }).eligible, true);
  assert.equal(planReviewRecheck({ snapshot: snapshot(), entry: {}, task: task(), result: result({ schemaVersion: 1 }), observed }).eligible, false);
  assert.equal(planReviewRecheck({ snapshot: { ...snapshot(), pr: { ...snapshot().pr, headRefOid: 'd'.repeat(40) } }, entry: {}, task: task(), result: result(), observed }).eligible, false);
  assert.equal(planReviewRecheck({ snapshot: snapshot(), entry: {}, task: task(), result: result({ feedbackCoverage: { dispositions: [{ key: 'mivo-review:PRRT_1:c1', disposition: 'fixed' }] } }), observed }).eligible, false);
  assert.equal(planReviewRecheck({ snapshot: snapshot(), entry: {}, task: task(), result: result(), observed: [{ ...observed[0], contentHash: 'edited' }] }).eligible, false);
});

test('human veto, greptile-only, and missing tier do not recheck', () => {
  assert.equal(planReviewRecheck({ snapshot: snapshot({ reviewReason: 'review-veto', reviewEvidence: { reason: 'review-veto', tier: 'standard' } }), entry: {}, task: task(), result: result(), observed }).eligible, false);
  const greptile = { ...task(), feedback: [{ key: 'greptile:1', source: 'greptile', nativeId: '1' }], repairPolicy: { policyVersion: 2, items: [{ key: 'greptile:1', action: 'code-fix', canChangeCode: true }] } };
  assert.equal(planReviewRecheck({ snapshot: snapshot(), entry: {}, task: greptile, result: result({ feedbackCoverage: { dispositions: [{ key: 'greptile:1', disposition: 'no-change' }] }, scs: [{ status: 'no-change', feedbackKeys: ['greptile:1'], evidence: ['x'] }] }), observed }).eligible, false);
  assert.equal(planReviewRecheck({ snapshot: snapshot({ reviewEvidence: { ...snapshot().reviewEvidence, tier: null } }), entry: {}, task: task(), result: result(), observed }).reason, 'review-tier-unknown');
});

test('no per-head cap, but the same result cannot ask twice', () => {
  const entry = { reviewRechecks: { [HEAD]: { attempts: [{ key: 'k1', resultReceiptId: 'rcpt-1', findingDigest: 'x', status: 'sent' }] } } };
  assert.equal(planReviewRecheck({ snapshot: snapshot(), entry, task: task(), result: result(), observed }).eligible, false);
  const other = { reviewRechecks: { [HEAD]: { attempts: [{ key: 'k1', resultReceiptId: 'other', findingDigest: 'x', status: 'sent' }, { key: 'k2', resultReceiptId: 'other2', status: 'sent' }] } } };
  assert.equal(planReviewRecheck({ snapshot: snapshot(), entry: other, task: task(), result: result({ receiptId: 'fresh' }), observed }).eligible, true);
});

test('requestReviewRecheck uses empty prev_run_id and does not write on dry-run', () => {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args);
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }], pageInfo: { hasNextPage: false } } } } } });
    if (args[1]?.includes('workflows/review-pr.yml') && !args.includes('workflow')) return JSON.stringify({ path: '.github/workflows/review-pr.yml', state: 'active' });
    if (args[1]?.includes('MIVO_REVIEW_MODE')) return JSON.stringify({ name: 'MIVO_REVIEW_MODE', value: 'live' });
    if (args[1]?.includes('actions/runs')) return JSON.stringify({ workflow_runs: [] });
    return '';
  };
  const ownershipSnapshot = function* () { return { pr: snapshot().pr }; };
  const dry = run(requestReviewRecheck({
    pr: snapshot().pr, snapshot: snapshot(), entry: {}, task: task(), result: result(), observed, ghFn, ownershipSnapshot,
    save: () => {}, now, dryRun: true, viewer: 'owner', repo: 'example-org/example-plugin',
  }), ghFn);
  assert.equal(dry.action.reason, 'dry-run');
  const liveCalls = [];
  const liveGh = (args) => {
    liveCalls.push(args.join(' '));
    return ghFn(args);
  };
  const sent = run(requestReviewRecheck({
    pr: snapshot().pr, snapshot: snapshot(), entry: {}, task: task(), result: result(), observed, ghFn: liveGh, ownershipSnapshot,
    save: () => {}, now, dryRun: false, viewer: 'owner', repo: 'example-org/example-plugin',
  }), liveGh);
  assert.equal(sent.action.reason, 'sent');
  assert.ok(liveCalls.some((line) => line.includes('workflow run review-pr.yml') && line.includes('prev_run_id=') && line.includes('mode=live')));
});

test('many earlier attempts on the same head do not block a new result', () => {
  const attempts = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, resultReceiptId: `old${i}`, status: i % 2 ? 'failed' : 'sent' }));
  const entry = { reviewRechecks: { [HEAD]: { attempts } } };
  assert.equal(planReviewRecheck({ snapshot: snapshot(), entry, task: task(), result: result({ receiptId: 'fresh' }), observed }).eligible, true);
});

function recheckGh({ threads = [{ isResolved: true }], hasNextPage = false, calls = [] } = {}) {
  return (args) => {
    calls.push(args.join(' '));
    if (args[1] === 'graphql') return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: threads, pageInfo: { hasNextPage, endCursor: hasNextPage ? null : 'end' } } } } } });
    if (args[1]?.includes('workflows/review-pr.yml') && !args.includes('workflow')) return JSON.stringify({ path: '.github/workflows/review-pr.yml', state: 'active' });
    if (args[1]?.includes('MIVO_REVIEW_MODE')) return JSON.stringify({ name: 'MIVO_REVIEW_MODE', value: 'live' });
    if (args[1]?.includes('actions/runs')) return JSON.stringify({ workflow_runs: [] });
    return '';
  };
}

for (const [name, opts] of [['an open conversation', { threads: [{ isResolved: true }, { isResolved: false }] }], ['a second page without a cursor', { hasNextPage: true }]]) {
  test(`${name} makes the recheck wait without dispatching or recording an attempt`, () => {
    const calls = [];
    const ghFn = recheckGh({ ...opts, calls });
    let saved = 0;
    const res = run(requestReviewRecheck({
      pr: snapshot().pr, snapshot: snapshot(), entry: {}, task: task(), result: result(), observed, ghFn,
      ownershipSnapshot: function* () { return { pr: snapshot().pr }; }, save: () => { saved += 1; }, now, dryRun: false, viewer: 'owner', repo: 'example-org/example-plugin',
    }), ghFn);
    assert.equal(res.action.reason, 'threads-unresolved');
    assert.equal(res.action.attempted, false);
    assert.equal(saved, 0);
    assert.equal(res.entry.reviewRechecks, undefined);
    assert.ok(!calls.some((line) => line.startsWith('workflow run')));
  });
}

test('threadsAllResolved reads every page: closed history beyond 100 passes, an open thread on page 2 waits', () => {
  const page = (nodes, hasNextPage, endCursor) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo: { hasNextPage, endCursor } } } } } });
  const closed = Array.from({ length: 100 }, () => ({ isResolved: true }));
  const make = (second) => (args) => (args.includes('after=c1') ? page(second, false, null) : page(closed, true, 'c1'));
  assert.equal(run(threadsAllResolved({ repo: 'example-org/example-plugin', number: 9, ghFn: make([{ isResolved: true }]) })), true);
  assert.equal(run(threadsAllResolved({ repo: 'example-org/example-plugin', number: 9, ghFn: make([{ isResolved: false }]) })), false);
});
