// End-to-end close-out of verified P0/P1 review threads through the real pollWorkflow/processPr.
// Disk, GitHub and the CI recheck are replaced at their boundaries; all state lives in a Map.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pollWorkflow, watcherPaths, feedbackItems, newFeedback } from './bin/mivo-watcher.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';

const ROOT = '/virtual/vigil-thread-close';

function fixture({ kind = 'fixed', waiting = false, human = false, outdated = false, badCi = false, replyError = false } = {}) {
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
  const feedback = newFeedback({}, feedbackItems({ pr, reviews: [review], threads: [thread], receiptActor: 'owner' }));
  const item = feedback.fresh.find((x) => x.threadId === thread.id);
  assert.equal(item.repairPolicy.action, 'code-fix');
  const task = { dispatchId: 'sample-task', headRefOid: head, feedback: [item], repairPolicy: { items: [{ key: item.key, action: 'code-fix' }] } };
  const complete = {
    schemaVersion: 2, dispatchId: task.dispatchId, nodeId: pr.id, sessionId: 'sample-session', status: 'complete', head, receiptId: 'complete-receipt',
    ci: { requiredGreen: !badCi, head }, verification: { status: kind === 'fixed' ? 'pass' : 'not-required-no-change', head },
    scs: [{ id: 'SC-1', status: kind === 'fixed' ? 'pass' : 'no-change', feedbackKeys: [item.key], evidence: ['verified concrete trigger with focused tests'] }],
    feedbackCoverage: { dispositions: [{ key: item.key, disposition: kind === 'fixed' ? 'fixed' : 'no-change' }] },
  };
  const initial = waiting ? { ...complete, status: 'waiting-ci', receiptId: 'waiting-receipt', ci: { requiredGreen: false, head } } : complete;
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
    activeTask: { dispatchId: task.dispatchId, head, status: waiting ? 'waiting-ci' : 'accepted', evidenceVersion: 2 },
  }));
  // Pushing the fix can move the commented line: the thread turns outdated and its comment re-surfaces as fresh.
  if (outdated) thread.isOutdated = true;
  if (human) thread.comments.nodes.push({ id: 'PRRC_human', author: { login: 'ExampleMaintainer' }, body: 'The repair still exposes private records in the alternate branch. Keep this thread open.', createdAt: '2026-10-14T00:01:00Z' });
  const calls = [];
  const dispatches = [];
  let rechecks = 0;
  const snapshot = { state: 'OPEN', isDraft: false, headRefOid: head, baseRefOid: pr.baseRefOid, updatedAt: now, mergeable: 'MERGEABLE', labels: [], checkState: 'SUCCESS', commentCount: 1, reviewCount: 1, unresolvedThreads: 1 };
  const collectedValue = withAuthorHandoff({ pr, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] }, reviews: [review], threads: [thread], labels: [], comments: [], mergeReady: false, admissionVerified: true }, pr);
  function run() {
    const gen = pollWorkflow({
      paths, now, nodeId: pr.id, prNumber: pr.number, enabled: true, allowDispatch: true, budgetMs: 120000, clock: () => 0, snapshotFn: () => snapshot,
      ghFn: (args) => {
        if (args[0] === 'api' && args[1] === 'user') return 'owner';
        calls.push(args);
        if (replyError && args.some((a) => String(a).includes('addPullRequestReviewThreadReply'))) throw new Error('simulated reply transport failure');
        return '{}';
      },
      collect: () => collectedValue,
      dispatchFn: (params) => { dispatches.push(params); return { target_session_id: 'sample-session', dispatch_id: 'new-sample-task' }; },
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
  return { run, restore, calls, dispatches, head, snapshot, resolves, rechecks: () => rechecks, entry: () => JSON.parse(files.get(entryPath)) };
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

test('invalid complete CI evidence leaves the thread open', () => {
  const f = fixture({ badCi: true });
  try {
    f.run();
    assert.equal(f.calls.length, 0);
    assert.equal(f.entry().activeTask.blockedKind, 'invalid-result');
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
