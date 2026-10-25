// End-to-end close-out of verified P0/P1 review threads through the real pollWorkflow/processPr.
// Disk, GitHub and the CI recheck are replaced at their boundaries; all state lives in a Map.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pollWorkflow, watcherPaths, feedbackItems, newFeedback, pollFingerprint, normalizePollSnapshot } from './bin/mivo-watcher.mjs';
import { validateScs } from './bin/mivo-repair.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';

const ROOT = '/virtual/vigil-thread-close';

function fixture({ kind = 'fixed', waiting = false, human = false, unrelated = false, outdated = false, badCi = false, replyError = false, legacyIntent = false, frozen = null, deleteErrors = 0 } = {}) {
  const original = Object.fromEntries(['existsSync', 'readFileSync', 'mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync'].map((k) => [k, fs[k]]));
  const files = new Map();
  const dirs = new Set([ROOT, ROOT + '/state', ROOT + '/state/prs']);
  const scoped = (p) => String(p).startsWith(ROOT + '/') || p === ROOT;
  fs.existsSync = (p) => scoped(p) ? files.has(String(p)) || dirs.has(String(p)) : original.existsSync(p);
  fs.readFileSync = (p, ...args) => {
    if (!scoped(p)) return original.readFileSync(p, ...args);
    if (!files.has(String(p))) throw Object.assign(new Error('missing virtual file ' + p), { code: 'ENOENT' });
    return files.get(String(p));
  };
  fs.mkdirSync = (p) => { assert.ok(scoped(p), 'filesystem write must be virtual'); dirs.add(String(p)); };
  fs.writeFileSync = (p, value, options) => {
    assert.ok(scoped(p), 'filesystem write must be virtual');
    if (options?.flag === 'wx' && files.has(String(p))) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
    files.set(String(p), String(value));
  };
  fs.renameSync = (a, b) => { assert.ok(scoped(a) && scoped(b)); files.set(String(b), files.get(String(a))); files.delete(String(a)); };
  fs.unlinkSync = (p) => { assert.ok(scoped(p)); files.delete(String(p)); };
  const restore = () => Object.assign(fs, original);

  const head = 'a'.repeat(40);
  const now = '2026-10-14T00:00:00Z';
  const pr = handoffPr({ id: 'PR_sample', number: 7, headRefOid: head, baseRefOid: 'b'.repeat(40), headRefName: 'fix/sample', title: 'sample' });
  const review = { id: 'PRR_sample', author: { login: 'ExampleReviewer' }, body: `<!-- review-pr:findings head=${head} -->`, state: 'COMMENTED', commit: { oid: head }, submittedAt: now };
  const bot = { id: 'PRRC_bot', author: { login: 'ExampleReviewer' }, body: '**P1** concrete failure', pullRequestReview: { id: review.id }, createdAt: now };
  const thread = { id: 'PRRT_sample', isResolved: false, isOutdated: false, path: 'src/example.mjs', comments: { nodes: [bot] } };
  const threads = [thread];
  if (unrelated) {
    threads.push({ ...thread, id: 'PRRT_other', comments: { nodes: [{ ...bot, id: 'PRRC_other' }] } });
    threads.push({ ...thread, id: 'PRRT_resolved', isResolved: true, comments: { nodes: [{ ...bot, id: 'PRRC_resolved' }] } });
    thread.comments.nodes.push({ id: 'PRRC_receipt', author: { login: 'owner' }, body: '<!-- mivo-watcher-receipt task=prior-task -->', createdAt: now });
  }
  const feedback = newFeedback({}, feedbackItems({ pr, reviews: [review], threads, receiptActor: 'owner' }));
  const item = feedback.fresh.find((x) => x.threadId === thread.id);
  assert.equal(item.repairPolicy.action, 'code-fix');
  const task = { dispatchId: 'sample-task', headRefOid: head, feedback: [item], repairPolicy: { items: [{ key: item.key, action: 'code-fix' }] } };
  const complete = {
    schemaVersion: 2, dispatchId: task.dispatchId, nodeId: pr.id, sessionId: 'sample-session', status: 'complete', head, receiptId: 'complete-receipt',
    ci: { requiredGreen: !badCi, head }, verification: { status: kind === 'fixed' ? 'pass' : 'not-required-no-change', head },
    scs: [{ id: 'SC-1', status: kind === 'fixed' ? 'pass' : 'no-change', feedbackKeys: [item.key], evidence: ['verified concrete trigger with focused tests'] }],
    feedbackCoverage: { dispositions: [{ key: item.key, disposition: kind === 'fixed' ? 'fixed' : 'no-change' }] },
  };
  const legacyBlocked = { schemaVersion: 2, dispatchId: task.dispatchId, nodeId: pr.id, sessionId: 'sample-session', status: 'blocked', head,
    receiptId: 'legacy-intent-receipt', blockedKind: 'product-intent', reason: '旧版本：等维护者拍板' };
  const initial = legacyIntent && frozen !== 'complete' ? legacyBlocked : waiting ? { ...complete, status: 'waiting-ci', receiptId: 'waiting-receipt', ci: { requiredGreen: false, head } } : complete;
  const paths = watcherPaths(ROOT);
  const entryPath = ROOT + '/state/prs/' + pr.id + '.json';
  const resultPath = ROOT + '/state/results/sample-task.json';
  files.set(ROOT + '/state/index.json', '{}');
  files.set(ROOT + '/state/tasks/sample-task.json', JSON.stringify(task));
  files.set(resultPath, JSON.stringify(initial));
  files.set(entryPath, JSON.stringify({
    nodeId: pr.id, number: pr.number, sessionId: 'sample-session', headRefName: pr.headRefName, title: 'sample', headRefOid: head,
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: pr.releaseEpoch, handoff: handoffReceipt(pr),
    feedbackCursor: feedback.cursor, pollFingerprint: 'old',
    // The unrelated open thread was delivered and judged by an earlier round; without that judgement it would be
    // an orphaned bot thread and handed back on its own.
    ...(unrelated ? { feedbackLedger: Object.fromEntries(Object.entries(feedback.cursor).filter(([key]) => key.includes('PRRT_other'))
      .map(([key, stamp]) => [key, { stamp, disposition: 'no-change', resultHead: head, dispatchId: 'earlier-task' }])) } : {}),
    activeTask: { dispatchId: task.dispatchId, head, status: waiting ? 'waiting-ci' : 'accepted', evidenceVersion: 2 },
    ...(legacyIntent ? { blockedNotices: { legacy: { kind: 'product-intent', commentAt: now, labelAt: now, dispatchId: task.dispatchId, attempts: 1 } } } : {}),
  }));
  // Pushing the fix can move the commented line: the thread turns outdated and its comment re-surfaces as fresh.
  if (outdated) thread.isOutdated = true;
  if (human) thread.comments.nodes.push({ id: 'PRRC_human', author: { login: 'ExampleMaintainer' }, body: 'The repair still exposes private records in the alternate branch. Keep this thread open.', createdAt: '2026-10-14T00:01:00Z' });
  const calls = [];
  const dispatches = [];
  let rechecks = 0;
  const snapshot = { state: 'OPEN', isDraft: false, headRefOid: head, baseRefOid: pr.baseRefOid, updatedAt: now, mergeable: 'MERGEABLE', labels: [], checkState: 'SUCCESS', commentCount: 1, reviewCount: 1, unresolvedThreads: 1 };
  // Frozen: the older build's result was already consumed and nothing on GitHub changed since.
  if (frozen) {
    const entry = JSON.parse(files.get(entryPath));
    entry.pollFingerprint = pollFingerprint(normalizePollSnapshot(snapshot));
    entry.activeTask = frozen === 'blocked'
      ? { dispatchId: task.dispatchId, head, status: 'blocked', blockedKind: 'product-intent', receiptId: 'legacy-intent-receipt', evidenceVersion: 2 }
      : { dispatchId: task.dispatchId, head, status: 'complete', receiptId: 'complete-receipt', evidenceVersion: 2 };
    files.set(entryPath, JSON.stringify(entry));
  }
  const collectedValue = withAuthorHandoff({ pr, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] }, reviews: [review], threads, labels: [], comments: [], mergeReady: false, admissionVerified: true }, pr);
  function run() {
    const gen = pollWorkflow({
      paths, now, nodeId: pr.id, prNumber: pr.number, enabled: true, allowDispatch: true, budgetMs: 120000, clock: () => 0, snapshotFn: () => snapshot,
      ghFn: (args) => {
        if (args[0] === 'api' && args[1] === 'user') return 'owner';
        calls.push(args);
        if (replyError && args.some((a) => String(a).includes('addPullRequestReviewThreadReply'))) throw new Error('simulated reply transport failure');
        if (deleteErrors > 0 && args.includes('DELETE')) { deleteErrors--; throw new Error('HTTP 502: Bad Gateway'); }
        return '{}';
      },
      collect: () => collectedValue,
      dispatchFn: (params) => { dispatches.push(params); return { target_session_id: 'sample-session' }; },
      ownershipSnapshot: function* () { return { pr }; },
      recheckFn: () => { rechecks++; files.set(resultPath, JSON.stringify(complete)); return complete; },
    });
    let step = gen.next();
    while (!step.done) {
      try { const value = step.value(); step = gen.next(value); } catch (error) { step = gen.throw(error); }
    }
    return step.value;
  }
  const resolves = () => calls.filter((args) => args.some((a) => String(a).includes('resolveReviewThread'))).length;
  const entry = () => JSON.parse(files.get(entryPath));
  const activeTask = () => JSON.parse(files.get(ROOT + '/state/tasks/' + entry().activeTask.dispatchId + '.json'));
  function completeActiveTask() {
    const next = activeTask();
    const evidence = validateScs(next.feedback.map((item, index) => ({
      id: 'SC-' + index, status: item.repairPolicy.canChangeCode ? 'pass' : 'no-change',
      feedbackKeys: [item.key], evidence: ['verified concrete trigger with focused tests'],
    })), next);
    files.set(ROOT + '/state/results/' + next.dispatchId + '.json', JSON.stringify({
      ...complete, ...evidence, dispatchId: next.dispatchId, receiptId: 'second-complete-receipt',
    }));
    snapshot.commentCount++;
  }
  return { run, restore, calls, dispatches, head, snapshot, resolves, activeTask, completeActiveTask, rechecks: () => rechecks, entry };
}

for (const kind of ['fixed', 'refuted']) {
  test(`complete ${kind}: closes with evidence and stays idempotent`, () => {
    const f = fixture({ kind });
    try {
      f.run();
      assert.equal(f.calls.length, 2);
      const body = f.calls[0].find((a) => a.startsWith('body='));
      assert.match(body, /verified concrete trigger/);
      if (kind === 'fixed') assert.ok(body.includes(f.head.slice(0, 12)));
      assert.equal(f.entry().autoClosedThreads.PRRT_sample.reason, kind === 'fixed' ? 'fixed-p0-p1' : 'refuted-p0-p1');
      f.snapshot.commentCount++;
      f.run();
      assert.equal(f.calls.length, 2);
    } finally { f.restore(); }
  });

  test(`waiting-ci -> complete ${kind}: closes in the same poll the recheck completes`, () => {
    const f = fixture({ kind, waiting: true });
    try {
      f.run();
      assert.equal(f.rechecks(), 1);
      assert.equal(f.entry().activeTask.status, 'complete');
      assert.equal(f.resolves(), 1, 'completed CI recheck must close its verified thread');
      assert.equal(f.entry().autoClosedThreads.PRRT_sample.reason, kind === 'fixed' ? 'fixed-p0-p1' : 'refuted-p0-p1');
    } finally { f.restore(); }
  });
}

test('fixed thread that turned outdated is closed without re-dispatching its comment', () => {
  const f = fixture({ kind: 'fixed', waiting: true, outdated: true });
  try {
    f.run();
    assert.equal(f.resolves(), 1);
    assert.equal(f.dispatches.length, 0, 'a thread closed this poll is not new work');
  } finally { f.restore(); }
});

test('new unhandled human reply keeps the whole thread open and goes to dispatch', () => {
  const f = fixture({ human: true });
  try {
    f.run();
    assert.equal(f.resolves(), 0, 'human feedback outside the completed task must stay unresolved');
    assert.equal(f.entry().autoClosedThreads?.PRRT_sample, undefined);
    assert.equal(f.dispatches.length, 1);
  } finally { f.restore(); }
});

test('a later repair round covers the whole open thread and closes it once', () => {
  const f = fixture({ human: true, unrelated: true });
  try {
    f.run();
    assert.equal(f.resolves(), 0, 'the first result cannot close the new reply');
    assert.equal(f.dispatches.length, 1);
    const task = f.activeTask();
    assert.deepEqual(task.feedback.map((item) => item.nativeId).sort(), [
      'PRRT_sample:PRRC_bot', 'PRRT_sample:PRRC_human',
    ], 'carry the consumed finding alongside its new reply, excluding other threads and watcher receipts');
    assert.deepEqual(task.repairPolicy.items.map((item) => item.key).sort(), task.feedback.map((item) => item.key).sort());
    assert.match(f.dispatches[0].message, /PRRT_sample:PRRC_bot/);
    assert.match(f.dispatches[0].message, /PRRT_sample:PRRC_human/);
    f.completeActiveTask();
    f.run();
    assert.equal(f.resolves(), 1, 'the second complete result closes all verified comments');
    assert.equal(f.calls.length, 2, 'reply and resolve exactly once');
    assert.equal(f.dispatches.length, 1, 'completed comments do not cause a third repair');
    f.snapshot.commentCount++;
    f.run();
    assert.equal(f.calls.length, 2);
    assert.equal(f.dispatches.length, 1);
  } finally { f.restore(); }
});

test('invalid complete CI evidence leaves the thread open', () => {
  const f = fixture({ badCi: true });
  try {
    f.run();
    assert.equal(f.resolves(), 0);
    assert.ok(!f.calls.flat().some((a) => String(a).includes('addPullRequestReviewThreadReply')));
    assert.equal(f.entry().activeTask.blockedKind, 'invalid-result');
    // The stuck PR is announced on the PR itself, once.
    const notices = f.calls.filter((args) => /\/issues\/7\/comments$/.test(String(args[1])));
    assert.equal(notices.length, 1);
    assert.match(notices[0].find((a) => a.startsWith('body=')), /对不上本 PR 或缺少验证证据[^]*mivo-watcher-receipt task=blocked-notice kind=invalid-result/);
    f.snapshot.commentCount++;
    f.run();
    assert.equal(f.calls.filter((args) => /\/issues\/7\/comments$/.test(String(args[1]))).length, 1, 'same blocked state is not announced twice');
  } finally { f.restore(); }
});

test('failed reply never resolves or records a closed receipt', () => {
  const f = fixture({ replyError: true });
  try {
    assert.throws(() => f.run(), /simulated reply transport failure/);
    assert.equal(f.calls.length, 1);
    assert.equal(f.entry().autoClosedThreads?.PRRT_sample, undefined);
  } finally { f.restore(); }
});

// A finding that asks to undo the PR's written intent is answered with that intent and resolved; nothing waits
// for a person and no hold label appears (2026-10-15).
test('intent conflict: the finding is refuted with the PR intent, answered and resolved, no block or label', () => {
  const f = fixture({ kind: 'refuted' });
  try {
    f.run();
    assert.equal(f.resolves(), 1);
    assert.equal(f.entry().activeTask.status, 'complete');
    assert.ok(!f.calls.some((args) => /\/issues\/7\/(?:comments|labels)/.test(String(args[1]))), 'no notice, no label');
  } finally { f.restore(); }
});

// Upgrade from the 2026-10-15 builds that held a PR on a product-intent conflict: the round is handed back
// once and redelivered, the watcher removes the awaiting-discussion label it put there, and no "stuck" notice goes out.
test('legacy product-intent hold: feedback is redelivered once, the watcher\'s own label comes off, no notice', () => {
  const f = fixture({ legacyIntent: true });
  try {
    f.run();
    const labelDeletes = () => f.calls.filter((args) => args.includes('DELETE') && /\/issues\/7\/labels\/awaiting-discussion$/.test(String(args.at(-1)))).length;
    assert.equal(f.dispatches.length, 1, 'the held feedback goes to a new round');
    assert.equal(labelDeletes(), 1);
    assert.ok(!f.calls.some((args) => /\/issues\/7\/comments$/.test(String(args[1]))), 'no stuck notice for a reopened hold');
    assert.ok(Object.values(f.entry().blockedNotices).every((notice) => notice.labelReleasedAt));
    assert.equal(f.entry().intentReopened.length, 1);
    f.snapshot.commentCount++;
    f.run();
    assert.equal(f.dispatches.length, 1, 'reopened once');
    assert.equal(labelDeletes(), 1, 'label removed once');
  } finally { f.restore(); }
});

// The same upgrade with nothing changed on GitHub since the older build: the fingerprint fast path must not hide it.
const labelDeleteCount = (f) => f.calls.filter((args) => args.includes('DELETE') && /\/issues\/7\/labels\/awaiting-discussion$/.test(String(args.at(-1)))).length;
test('legacy product-intent hold with an unchanged fingerprint is still reopened and its label removed', () => {
  const f = fixture({ legacyIntent: true, frozen: 'blocked' });
  try {
    const first = f.run();
    assert.notEqual(first.prs?.[0]?.dispatch?.reason, 'fingerprint-unchanged');
    assert.equal(f.dispatches.length, 1);
    assert.equal(labelDeleteCount(f), 1);
    assert.deepEqual(f.entry().intentReopened, ['sample-task']);
  } finally { f.restore(); }
});

test('a completed PR still holding the legacy label gets it removed although its fingerprint is unchanged', () => {
  const f = fixture({ kind: 'refuted', legacyIntent: true, frozen: 'complete' });
  try {
    f.run();
    assert.equal(labelDeleteCount(f), 1);
    assert.ok(f.entry().blockedNotices.legacy.labelReleasedAt);
    const before = f.calls.length;
    const again = f.run();
    assert.equal(again.prs?.[0]?.dispatch?.reason, 'fingerprint-unchanged', 'done once, then quiet');
    assert.equal(f.calls.length, before);
  } finally { f.restore(); }
});

test('a failed label removal is retried on the next poll even when nothing changed on GitHub', () => {
  const f = fixture({ kind: 'refuted', legacyIntent: true, frozen: 'complete', deleteErrors: 1 });
  try {
    f.run();
    assert.equal(labelDeleteCount(f), 1);
    assert.match(f.entry().blockedNotices.legacy.releaseError, /502/);
    assert.equal(f.entry().blockedNotices.legacy.labelReleasedAt, undefined);
    f.run();
    assert.equal(labelDeleteCount(f), 2, 'retried without any GitHub change');
    assert.ok(f.entry().blockedNotices.legacy.labelReleasedAt);
  } finally { f.restore(); }
});
