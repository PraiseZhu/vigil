import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackItems } from './bin/mivo-watcher.mjs';
import { isAutoCloseEligible, partitionAutoClose, autoCloseThreads, autoCloseReplyText, closeRefutedThreads, refutedReplyText, refutedThreads } from './bin/mivo-review-resolve.mjs';

const HEAD = 'a'.repeat(40);
const PR = { headRefOid: HEAD };
const GREPTILE_AUTHOR = { login: 'greptile-apps[bot]' };
const HUMAN_AUTHOR = { login: 'some-human' };

function threadItems({ threadId = 't1', isResolved = false, body, author = GREPTILE_AUTHOR, commentId = 'c1' } = {}) {
  const threads = [{
    id: threadId, isResolved, isOutdated: false, path: 'src/a.ts',
    comments: [{ id: commentId, author, body, createdAt: '2026-09-10T00:00:00Z' }],
  }];
  return feedbackItems({ pr: PR, threads });
}

test('P2 greptile thread item is auto-close eligible', () => {
  const [item] = threadItems({ body: 'P2: naming nit, consider renaming' });
  assert.equal(item.category, 'reply-resolve');
  assert.equal(item.repairPolicy.action, 'reply-only');
  assert.equal(item.threadId, 't1');
  assert.equal(isAutoCloseEligible(item), true);
});

test('P0/P1 thread item is never auto-close eligible', () => {
  const [item] = threadItems({ body: 'P0: crash on null input, must fix before merge' });
  assert.equal(item.category, 'actionable-fix');
  assert.equal(isAutoCloseEligible(item), false);
});

test('severity-unconfirmed thread item is not auto-close eligible', () => {
  const [item] = threadItems({ body: 'thanks for the update, looks fine to me' });
  assert.equal(item.repairPolicy.reason, 'severity-unconfirmed');
  assert.equal(isAutoCloseEligible(item), false);
});

test('untrusted-source P2-looking thread item is not auto-close eligible', () => {
  const [item] = threadItems({ body: 'P2: naming nit', author: HUMAN_AUTHOR });
  assert.equal(item.repairPolicy.reason, 'unverified-review-source');
  assert.equal(isAutoCloseEligible(item), false);
});

test('mixed P0+P2 on same line is not auto-close eligible (needs-triage)', () => {
  const [item] = threadItems({ body: 'P0 crash here, also P2 naming nit on the same line' });
  assert.equal(item.repairPolicy.action, 'needs-triage');
  assert.equal(isAutoCloseEligible(item), false);
});

test('partitionAutoClose splits eligible P2 threads from everything else', () => {
  const items = [
    ...threadItems({ threadId: 't-p2', body: 'P2: naming nit' }),
    ...threadItems({ threadId: 't-p0', body: 'P0: crash on null input' }),
  ];
  const { eligible, remaining } = partitionAutoClose(items);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].threadId, 't-p2');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].threadId, 't-p0');
});

test('autoCloseReplyText does not restate a specific bot original verbatim', () => {
  const text = autoCloseReplyText();
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
  assert.ok(!text.includes('naming nit'));
});

function collectYields(gen) {
  const calls = [];
  let step = gen.next();
  while (!step.done) {
    calls.push(step.value());
    step = gen.next();
  }
  return { calls, result: step.value };
}

test('autoCloseThreads posts a reply then resolves, and records a durable receipt', () => {
  const [item] = threadItems({ threadId: 't-p2', body: 'P2: naming nit' });
  const ghCalls = [];
  const ghFn = (args) => { ghCalls.push(args); return '{}'; };
  const { calls, result } = collectYields(autoCloseThreads({ eligible: [item], previous: {}, ghFn, now: '2026-09-29T00:00:00Z' }));
  assert.equal(calls.length, 2);
  assert.ok(ghCalls[0].some((a) => typeof a === 'string' && a.startsWith('query=') && a.includes('addPullRequestReviewThreadReply')));
  assert.ok(ghCalls[1].some((a) => typeof a === 'string' && a.startsWith('query=') && a.includes('resolveReviewThread')));
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].threadId, 't-p2');
  assert.ok(result.previous.autoClosedThreads['t-p2']);
});

test('autoCloseThreads is idempotent: already-closed thread is skipped on a re-run', () => {
  const [item] = threadItems({ threadId: 't-p2', body: 'P2: naming nit' });
  const previous = { autoClosedThreads: { 't-p2': { at: '2026-09-28T00:00:00Z', key: null, nativeId: null } } };
  const ghFn = () => { throw new Error('must not call GitHub for an already-closed thread'); };
  const { calls, result } = collectYields(autoCloseThreads({ eligible: [item], previous, ghFn, now: '2026-09-29T00:00:00Z' }));
  assert.equal(calls.length, 0);
  assert.equal(result.closed.length, 0);
  assert.ok(result.previous.autoClosedThreads['t-p2']);
});

test('autoCloseThreads never touches non-eligible items even if forced into eligible list', () => {
  // Defensive: eligible list should only ever contain reply-resolve items in production
  // (enforced by partitionAutoClose), but the generator itself must not assume threadId shape.
  const [item] = threadItems({ threadId: 't-p2', body: 'P2: naming nit' });
  const ghCalls = [];
  const ghFn = (args) => { ghCalls.push(args); return '{}'; };
  const { result } = collectYields(autoCloseThreads({ eligible: [item, item], previous: {}, ghFn, now: '2026-09-29T00:00:00Z' }));
  // Duplicate same threadId within one round must only be closed once.
  assert.equal(ghCalls.length, 2);
  assert.equal(result.closed.length, 1);
});

const refutedTask = { dispatchId: 'live-851', repairPolicy: { items: [
  { key: 'thread:PRRT_p1:PRRC_a', action: 'code-fix' },
  { key: 'greptile:PRRT_g1:PRRC_b', action: 'code-fix' },
  { key: 'thread:PRRT_p2:PRRC_c', action: 'reply-only' },
  { key: 'thread:PRRT_fixed:PRRC_d', action: 'code-fix' },
  { key: 'thread:PRRT_noevidence:PRRC_e', action: 'code-fix' },
  { key: 'comment:9', action: 'code-fix' },
] } };
const refutedResult = (extra = {}) => ({
  schemaVersion: 2, status: 'complete', dispatchId: 'live-851',
  scs: [
    { id: 'SC-1', status: 'no-change', feedbackKeys: ['thread:PRRT_p1:PRRC_a', 'comment:9'], evidence: ['git show origin/main:scripts/x.mjs -> flag consumed; source /home/ci/repo/x.mjs'] },
    { id: 'SC-2', status: 'no-change', feedbackKeys: ['greptile:PRRT_g1:PRRC_b', 'thread:PRRT_p2:PRRC_c'], evidence: ['existing guard covers it'] },
    { id: 'SC-3', status: 'pass', feedbackKeys: ['thread:PRRT_fixed:PRRC_d'], evidence: ['fixed'] },
    { id: 'SC-4', status: 'no-change', feedbackKeys: ['thread:PRRT_noevidence:PRRC_e'], evidence: [' '] },
  ],
  feedbackCoverage: { dispositions: [
    { key: 'thread:PRRT_p1:PRRC_a', disposition: 'no-change' }, { key: 'greptile:PRRT_g1:PRRC_b', disposition: 'no-change' },
    { key: 'thread:PRRT_p2:PRRC_c', disposition: 'no-change' }, { key: 'thread:PRRT_fixed:PRRC_d', disposition: 'fixed' },
    { key: 'thread:PRRT_noevidence:PRRC_e', disposition: 'no-change' }, { key: 'comment:9', disposition: 'no-change' },
  ] }, ...extra,
});

test('only verified no-change P0/P1 review threads with evidence are closed as refuted', () => {
  assert.deepEqual(refutedThreads(refutedResult(), refutedTask).map((item) => item.threadId), ['PRRT_p1', 'PRRT_g1']);
  for (const extra of [{ status: 'waiting-ci' }, { schemaVersion: 1 }, { dispatchId: 'other' }]) {
    assert.deepEqual(refutedThreads(refutedResult(extra), refutedTask), []);
  }
});

test('refuted reply shows the evidence without local paths and carries the self-trigger receipt', () => {
  const text = refutedReplyText(['see /home/ci/repo/x.mjs line 3'], 'live-851');
  assert.match(text, /要不要改代码/);
  assert.match(text, /<本机路径>/);
  assert.doesNotMatch(text, /\/home\//);
  assert.match(text, /mivo-watcher-receipt task=live-851/);
});

test('refuted closure replies then resolves once per thread and is idempotent', () => {
  const calls = [];
  const items = refutedThreads(refutedResult(), refutedTask);
  const run = (previous) => {
    const gen = closeRefutedThreads({ items, dispatchId: 'live-851', previous, ghFn: (args) => { calls.push(args); return '{}'; }, now: 't' });
    let step = gen.next();
    while (!step.done) { step.value(); step = gen.next(); }
    return step.value;
  };
  const first = run({});
  assert.equal(calls.length, 4);
  assert.ok(calls[0].some((arg) => arg.includes('addPullRequestReviewThreadReply')) && calls[1].some((arg) => arg.includes('resolveReviewThread')));
  assert.deepEqual(first.closed.map((item) => item.threadId), ['PRRT_p1', 'PRRT_g1']);
  calls.length = 0;
  assert.deepEqual(run(first.previous).closed, []);
  assert.equal(calls.length, 0);
});
