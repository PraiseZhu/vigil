import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackItems } from './bin/mivo-watcher.mjs';
import { isAutoCloseEligible, partitionAutoClose, autoCloseThreads, autoCloseReplyText, closeRefutedThreads, refutedReplyText, refutedThreads, fixedReplyText, fixedThreads, coveredThreadItems } from './bin/mivo-review-resolve.mjs';

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

test('P3 greptile thread item is auto-close eligible', () => {
  const [item] = threadItems({ body: 'P3: naming nit, consider renaming' });
  assert.equal(item.category, 'reply-resolve');
  assert.equal(item.repairPolicy.action, 'reply-only');
  assert.equal(item.threadId, 't1');
  assert.equal(isAutoCloseEligible(item), true);
});
test('P2 greptile thread item is never auto-close eligible', () => {
  const [item] = threadItems({ body: 'P2: must-fix this PR' });
  assert.equal(item.category, 'actionable-fix');
  assert.equal(item.repairPolicy.action, 'code-fix');
  assert.equal(isAutoCloseEligible(item), false);
});
test('contradictory reply-only policy with P2 severities is not auto-closed', () => {
  const item = { category: 'reply-resolve', repairPolicy: { action: 'reply-only', severities: ['P2'] }, threadId: 't-fake' };
  assert.equal(isAutoCloseEligible(item), false);
});

test('P0/P1 thread item is never auto-close eligible', () => {
  const [item] = threadItems({ body: 'P0: crash on null input, must fix before merge' });
  assert.equal(item.category, 'actionable-fix');
  assert.equal(isAutoCloseEligible(item), false);
});

test('severity-unconfirmed thread item is not auto-close eligible', () => {
  const [item] = threadItems({ body: 'thanks for the update, looks fine to me' });
  assert.equal(item.repairPolicy.reason, 'thread-triage', 'graded by the session, not left open');
  assert.equal(isAutoCloseEligible(item), false);
});

test('untrusted-source P2-looking thread item is not auto-close eligible', () => {
  const [item] = threadItems({ body: 'P2: naming nit', author: HUMAN_AUTHOR });
  assert.equal(item.repairPolicy.reason, 'thread-triage', 'graded by the session, not left open');
  assert.equal(isAutoCloseEligible(item), false);
});

test('mixed P0+P2 on same line is code-fix, not auto-close', () => {
  const [item] = threadItems({ body: 'P0 crash here, also P2 naming nit on the same line' });
  assert.equal(item.repairPolicy.action, 'code-fix');
  assert.equal(isAutoCloseEligible(item), false);
});

test('partitionAutoClose splits eligible P3 threads from everything else', () => {
  const items = [
    ...threadItems({ threadId: 't-p3', body: 'P3: naming nit' }),
    ...threadItems({ threadId: 't-p0', body: 'P0: crash on null input' }),
  ];
  const { eligible, remaining } = partitionAutoClose(items);
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].threadId, 't-p3');
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
  const [item] = threadItems({ threadId: 't-p3', body: 'P3: naming nit' });
  const ghCalls = [];
  const ghFn = (args) => { ghCalls.push(args); return '{}'; };
  const { calls, result } = collectYields(autoCloseThreads({ eligible: [item], previous: {}, ghFn, now: '2026-09-29T00:00:00Z' }));
  assert.equal(calls.length, 2);
  assert.ok(ghCalls[0].some((a) => typeof a === 'string' && a.startsWith('query=') && a.includes('addPullRequestReviewThreadReply')));
  assert.ok(ghCalls[1].some((a) => typeof a === 'string' && a.startsWith('query=') && a.includes('resolveReviewThread')));
  assert.equal(result.closed.length, 1);
  assert.equal(result.closed[0].threadId, 't-p3');
  assert.ok(result.previous.autoClosedThreads['t-p3']);
});

test('autoCloseThreads is idempotent: already-closed thread is skipped on a re-run', () => {
  const [item] = threadItems({ threadId: 't-p3', body: 'P3: naming nit' });
  const previous = { autoClosedThreads: { 't-p3': { at: '2026-09-28T00:00:00Z', key: null, nativeId: null } } };
  const ghFn = () => { throw new Error('must not call GitHub for an already-closed thread'); };
  const { calls, result } = collectYields(autoCloseThreads({ eligible: [item], previous, ghFn, now: '2026-09-29T00:00:00Z' }));
  assert.equal(calls.length, 0);
  assert.equal(result.closed.length, 0);
  assert.ok(result.previous.autoClosedThreads['t-p3']);
});

test('autoCloseThreads never touches non-eligible items even if forced into eligible list', () => {
  // Defensive: eligible list should only ever contain reply-resolve items in production
  // (enforced by partitionAutoClose), but the generator itself must not assume threadId shape.
  const [item] = threadItems({ threadId: 't-p3', body: 'P3: naming nit' });
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
  assert.deepEqual(refutedThreads(refutedResult({ status: 'waiting-ci' }), refutedTask).map((item) => item.threadId), ['PRRT_p1', 'PRRT_g1']);
  for (const extra of [{ schemaVersion: 1 }, { dispatchId: 'other' }]) {
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

test('refutedThreads recognizes mivo-review keys from the new review machine', () => {
  const task = { dispatchId: 'live-851', repairPolicy: { items: [
    { key: 'mivo-review:PRRT_new:PRRC_z', action: 'code-fix' },
  ] } };
  const result = {
    schemaVersion: 2, status: 'complete', dispatchId: 'live-851',
    scs: [
      { id: 'SC-1', status: 'no-change', feedbackKeys: ['mivo-review:PRRT_new:PRRC_z'], evidence: ['current head already guards null'] },
    ],
    feedbackCoverage: { dispositions: [
      { key: 'mivo-review:PRRT_new:PRRC_z', disposition: 'no-change' },
    ] },
  };
  assert.deepEqual(refutedThreads(result, task).map((item) => item.threadId), ['PRRT_new']);
});

test('fixedThreads recognizes verified fixed P0/P1 review threads with pass evidence', () => {
  const task = { dispatchId: 'live-851', repairPolicy: { items: [
    { key: 'mivo-review:PRRT_fix:PRRC_a', action: 'code-fix' },
    { key: 'thread:PRRT_legacy:PRRC_b', action: 'code-fix' },
    { key: 'thread:PRRT_noevidence:PRRC_c', action: 'code-fix' },
    { key: 'thread:PRRT_reply:PRRC_d', action: 'reply-only' },
    { key: 'comment:9', action: 'code-fix' },
  ] } };
  const result = {
    schemaVersion: 2, status: 'complete', dispatchId: 'live-851', head: 'c'.repeat(40),
    scs: [
      { id: 'SC-1', status: 'pass', feedbackKeys: ['mivo-review:PRRT_fix:PRRC_a'], evidence: ['git show abcdef123456:src/a.ts covers the null path'] },
      { id: 'SC-2', status: 'pass', feedbackKeys: ['thread:PRRT_legacy:PRRC_b'], evidence: ['added guard'] },
      { id: 'SC-3', status: 'pass', feedbackKeys: ['thread:PRRT_noevidence:PRRC_c'], evidence: [' '] },
      { id: 'SC-4', status: 'pass', feedbackKeys: ['thread:PRRT_reply:PRRC_d'], evidence: ['should not close reply-only'] },
      { id: 'SC-5', status: 'pass', feedbackKeys: ['comment:9'], evidence: ['not a thread'] },
    ],
    feedbackCoverage: { dispositions: [
      { key: 'mivo-review:PRRT_fix:PRRC_a', disposition: 'fixed' },
      { key: 'thread:PRRT_legacy:PRRC_b', disposition: 'fixed' },
      { key: 'thread:PRRT_noevidence:PRRC_c', disposition: 'fixed' },
      { key: 'thread:PRRT_reply:PRRC_d', disposition: 'fixed' },
      { key: 'comment:9', disposition: 'fixed' },
    ] },
  };
  assert.deepEqual(fixedThreads(result, task).map((item) => item.threadId), ['PRRT_fix', 'PRRT_legacy']);
  assert.deepEqual(fixedThreads({ ...result, status: 'waiting-ci' }, task).map((item) => item.threadId), ['PRRT_fix', 'PRRT_legacy']);
  for (const extra of [{ schemaVersion: 1 }, { dispatchId: 'other' }]) {
    assert.deepEqual(fixedThreads({ ...result, ...extra }, task), []);
  }
});

test('coveredThreadItems keeps a thread open when it carries a reply outside the completed task', () => {
  const task = { feedback: [{ key: 'mivo-review:PRRT_a:PRRC_bot' }, { key: 'mivo-review:PRRT_b:PRRC_bot' }] };
  const items = [{ key: 'mivo-review:PRRT_a:PRRC_bot', threadId: 'PRRT_a' }, { key: 'mivo-review:PRRT_b:PRRC_bot', threadId: 'PRRT_b' }];
  const observed = [
    { source: 'mivo-review', nativeId: 'PRRT_a:PRRC_bot', threadId: 'PRRT_a' },
    { source: 'mivo-review', nativeId: 'PRRT_b:PRRC_bot', threadId: 'PRRT_b' },
    { source: 'thread', nativeId: 'PRRT_b:PRRC_human', threadId: 'PRRT_b' },
    { source: 'thread', nativeId: 'PRRT_a:PRRC_old', threadId: 'PRRT_a', actionable: false },
  ];
  assert.deepEqual(coveredThreadItems(items, observed, task).map((item) => item.threadId), ['PRRT_a']);
  assert.deepEqual(coveredThreadItems(items, [], task).map((item) => item.threadId), ['PRRT_a', 'PRRT_b']);
});

test('fixed reply names the repair head, sanitizes paths, and carries the receipt', () => {
  const text = fixedReplyText(['see /home/ci/repo/x.mjs line 3'], 'abcdef1234567890', 'live-851');
  assert.match(text, /发生了什么/);
  assert.match(text, /abcdef123456/);
  assert.match(text, /要不要改代码/);
  assert.match(text, /已改/);
  assert.match(text, /<本机路径>/);
  assert.doesNotMatch(text, /\/home\//);
  assert.match(text, /mivo-watcher-receipt task=live-851/);
});

test('closeRefutedThreads replies once per thread using kind-specific text and receipts', () => {
  const calls = [];
  const items = [
    { key: 'mivo-review:PRRT_fix:PRRC_a', threadId: 'PRRT_fix', evidence: ['guard added'], kind: 'fixed' },
    { key: 'mivo-review:PRRT_no:PRRC_b', threadId: 'PRRT_no', evidence: ['already guarded'], kind: 'refuted' },
  ];
  const run = (previous) => {
    const gen = closeRefutedThreads({
      items, dispatchId: 'live-851', previous, head: 'abcdef1234567890',
      ghFn: (args) => { calls.push(args); return '{}'; }, now: 't',
    });
    let step = gen.next();
    while (!step.done) { step.value(); step = gen.next(); }
    return step.value;
  };
  const first = run({});
  assert.equal(calls.length, 4);
  const fixedBody = calls[0].find((arg) => arg.startsWith('body='));
  const refutedBody = calls[2].find((arg) => arg.startsWith('body='));
  assert.match(fixedBody, /已改/);
  assert.match(fixedBody, /abcdef123456/);
  assert.match(refutedBody, /不改/);
  assert.equal(first.previous.autoClosedThreads.PRRT_fix.reason, 'fixed-p0-p1');
  assert.equal(first.previous.autoClosedThreads.PRRT_no.reason, 'refuted-p0-p1');
  assert.deepEqual(first.closed.map((item) => item.threadId), ['PRRT_fix', 'PRRT_no']);
  calls.length = 0;
  assert.deepEqual(run(first.previous).closed, []);
  assert.equal(calls.length, 0);
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
test('same thread mixed P2+P3 is not auto-closed', () => {
  const thread = {
    id: 't-mix', isResolved: false, isOutdated: false, path: 'src/a.ts',
    comments: [
      { id: 'c-p2', author: GREPTILE_AUTHOR, body: 'P2: must-fix this PR', createdAt: '2026-09-10T00:00:00Z' },
      { id: 'c-p3', author: GREPTILE_AUTHOR, body: 'P3: naming nit', createdAt: '2026-09-10T00:01:00Z' },
    ],
  };
  const items = feedbackItems({ pr: PR, threads: [thread] });
  const { eligible, remaining } = partitionAutoClose(items, { allItems: items, threads: [thread] });
  assert.equal(eligible.length, 0);
  assert.equal(remaining.length, items.length);
});

test('old P2 plus new P3 on the same thread is not auto-closed', () => {
  const thread = {
    id: 't-old', isResolved: false, isOutdated: false, path: 'src/a.ts',
    comments: [
      { id: 'c-p2', author: GREPTILE_AUTHOR, body: 'P2: must-fix this PR', createdAt: '2026-09-10T00:00:00Z' },
      { id: 'c-p3', author: GREPTILE_AUTHOR, body: 'P3: naming nit', createdAt: '2026-09-10T00:01:00Z' },
    ],
  };
  const allItems = feedbackItems({ pr: PR, threads: [thread] });
  const p3 = allItems.filter((item) => item.repairPolicy?.severities?.includes('P3'));
  const { eligible, remaining } = partitionAutoClose(p3, { allItems, threads: [thread] });
  assert.equal(eligible.length, 0);
  assert.equal(remaining.length, p3.length);
});

test('incomplete thread comment pagination is fail-closed', () => {
  const thread = {
    id: 't-page', isResolved: false, isOutdated: false, path: 'src/a.ts', commentsHasNextPage: true,
    comments: [{ id: 'c-p3', author: GREPTILE_AUTHOR, body: 'P3: naming nit', createdAt: '2026-09-10T00:00:00Z' }],
  };
  const items = feedbackItems({ pr: PR, threads: [thread] });
  const { eligible } = partitionAutoClose(items, { allItems: items, threads: [thread] });
  assert.equal(eligible.length, 0);
});

test('autoCloseReplyText is P3-class and keeps the mivo receipt marker', () => {
  const text = autoCloseReplyText();
  assert.match(text, /P3 级/);
  assert.match(text, /<!-- mivo-watcher-receipt task=auto-close -->/);
  assert.doesNotMatch(text, /P2 级/);
});

test('old auto-close receipt without dispatchId does not block a later P2 fix resolve', () => {
  const calls = [];
  const items = [{ key: 'thread:PRRT_reopen:PRRC_a', threadId: 'PRRT_reopen', evidence: ['fixed the P2 defect'], kind: 'fixed' }];
  const previous = { autoClosedThreads: { PRRT_reopen: { at: '2026-09-01T00:00:00Z', key: 'thread:PRRT_reopen:PRRC_a', reason: 'auto-close' } } };
  const gen = closeRefutedThreads({
    items, dispatchId: 'fix-p2-later', previous, head: 'abcdef1234567890',
    ghFn: (args) => { calls.push(args); return '{}'; }, now: 't',
  });
  let step = gen.next();
  while (!step.done) { step.value(); step = gen.next(); }
  assert.equal(calls.length, 2);
  assert.equal(step.value.closed[0].threadId, 'PRRT_reopen');
  assert.equal(step.value.previous.autoClosedThreads.PRRT_reopen.dispatchId, 'fix-p2-later');
});

test('same-task refuted rerun stays idempotent when receipt has matching dispatchId', () => {
  const calls = [];
  const items = [{ key: 'thread:PRRT_same:PRRC_a', threadId: 'PRRT_same', evidence: ['already guarded'], kind: 'refuted' }];
  const previous = { autoClosedThreads: { PRRT_same: { at: 't0', key: items[0].key, reason: 'refuted-p0-p1', dispatchId: 'live-851' } } };
  const gen = closeRefutedThreads({
    items, dispatchId: 'live-851', previous,
    ghFn: (args) => { calls.push(args); return '{}'; }, now: 't',
  });
  let step = gen.next();
  while (!step.done) { step.value(); step = gen.next(); }
  assert.equal(calls.length, 0);
  assert.deepEqual(step.value.closed, []);
});
