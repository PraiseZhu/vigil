import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as repair from './bin/cindy-repair.mjs';
import * as watcher from './bin/cindy-watcher.mjs';
import { readPr, writePr } from './bin/cindy-state.mjs';

// A repair round that blocked on "keel-..." never judged its feedback, yet the cursor had moved on
// and the round was charged. Fixtures use placeholder ids only. New symbols are read off the module
// namespaces so a missing export fails one test, not the file.
const { KEEL_FLOW_VERSION } = repair;
const { feedbackItems, newFeedback, pollFingerprint, reopenKeelBlocked, scanOnce, watcherPaths } = watcher;
const NODE = 'PR_example';
const FIRST = 'live-904-2026-10-11T05:15:00.992Z';
const SECOND = 'live-904-2026-10-11T07:00:00.928Z';
const KEEL_REASON = 'keel-unavailable: pstack_decide(op=log) returned RUN_NOT_FOUND';
const NOW = '2026-10-11T12:00:00.000Z';

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keel-reopen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}
function task(paths, dispatchId, { keys, version = 2, nodeId = NODE }) {
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, keelFlow: true, keelFlowVersion: version, feedback: keys.map(key => ({ key })) }));
}
function result(paths, dispatchId, { status = 'blocked', reason = KEEL_REASON } = {}) {
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${dispatchId}.json`), JSON.stringify({ dispatchId, status, reason }));
}
const entry = (extra = {}) => ({
  number: 904, nodeId: NODE, sessionId: 'session-1', eligibility: 'blocked', repairRounds: 2,
  feedbackCursor: { 'comment:1': 's1', 'comment:2': 's2', 'thread:9': 's3', 'review:other': 's4' },
  activeTask: { dispatchId: SECOND, status: 'blocked', blockedKind: 'external', reason: KEEL_REASON },
  ...extra,
});

test('a keel-blocked round on an older contract gives its feedback back and refunds the round', t => {
  const paths = watcherPaths(home(t));
  task(paths, SECOND, { keys: ['comment:2', 'thread:9'] });
  const out = reopenKeelBlocked({ previous: entry({ repairRounds: 1 }), paths, now: NOW });
  assert.deepEqual(out.feedbackCursor, { 'comment:1': 's1', 'review:other': 's4' });
  assert.equal(out.repairRounds, 0);
  assert.equal(out.eligibility, 'active');
  assert.deepEqual(out.keelReopened, [SECOND]);
  assert.equal(out.keelReopenedAt, NOW);
});

test('earlier rounds of the same PR blocked by the same incompatibility come back together', t => {
  const paths = watcherPaths(home(t));
  task(paths, FIRST, { keys: ['comment:1'] }); result(paths, FIRST);
  task(paths, SECOND, { keys: ['comment:2', 'thread:9'] }); result(paths, SECOND);
  const out = reopenKeelBlocked({ previous: entry(), paths, now: NOW });
  assert.deepEqual(out.feedbackCursor, { 'review:other': 's4' });
  assert.equal(out.repairRounds, 0);
  assert.deepEqual(out.keelReopened.sort(), [FIRST, SECOND]);
});

test('a refund never takes repairRounds below zero', t => {
  const paths = watcherPaths(home(t));
  task(paths, FIRST, { keys: ['comment:1'] }); result(paths, FIRST);
  task(paths, SECOND, { keys: ['comment:2'] });
  assert.equal(reopenKeelBlocked({ previous: entry({ repairRounds: 1 }), paths, now: NOW }).repairRounds, 0);
});

test('each dispatch id is given back once', t => {
  const paths = watcherPaths(home(t));
  task(paths, SECOND, { keys: ['comment:2'] });
  const once = reopenKeelBlocked({ previous: entry(), paths, now: NOW });
  assert.equal(reopenKeelBlocked({ previous: once, paths, now: '2026-10-11T12:05:00.000Z' }), once);
});

test('a task already on the current contract is not retried, so a broken Keel cannot loop', t => {
  const paths = watcherPaths(home(t));
  task(paths, SECOND, { keys: ['comment:2'], version: KEEL_FLOW_VERSION });
  const previous = entry();
  assert.equal(reopenKeelBlocked({ previous, paths, now: NOW }), previous);
});

test('only keel- reasons are given back; ordinary blocks stay blocked', t => {
  const paths = watcherPaths(home(t));
  task(paths, SECOND, { keys: ['comment:2'] });
  for (const reason of ['required CI failed: unit', 'external service down', 'not-keel-unavailable']) {
    const previous = entry({ activeTask: { dispatchId: SECOND, status: 'blocked', blockedKind: 'external', reason } });
    assert.equal(reopenKeelBlocked({ previous, paths, now: NOW }), previous);
  }
  const running = entry({ activeTask: { dispatchId: SECOND, status: 'running', reason: KEEL_REASON } });
  assert.equal(reopenKeelBlocked({ previous: running, paths, now: NOW }), running);
});

test('a keel-blocked round of another PR or an unreadable task is left alone', t => {
  const paths = watcherPaths(home(t));
  const previous = entry();
  assert.equal(reopenKeelBlocked({ previous, paths, now: NOW }), previous);
  task(paths, SECOND, { keys: ['comment:2'], nodeId: 'PR_other' });
  assert.equal(reopenKeelBlocked({ previous, paths, now: NOW }), previous);
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${SECOND}.json`), '{ not json');
  assert.equal(reopenKeelBlocked({ previous, paths, now: NOW }), previous);
  task(paths, FIRST, { keys: ['comment:1'] }); result(paths, FIRST);
  assert.equal(reopenKeelBlocked({ previous, paths, now: NOW }), previous, 'an earlier round alone does not trigger');
});

test('only the unbroken run of keel- blocks before the active round comes back', t => {
  const paths = watcherPaths(home(t));
  const OLDEST = 'live-904-2026-10-11T03:00:00.000Z';
  task(paths, OLDEST, { keys: ['review:other'] }); result(paths, OLDEST);
  task(paths, FIRST, { keys: ['comment:1'] }); result(paths, FIRST, { status: 'complete', reason: null });
  task(paths, SECOND, { keys: ['comment:2'] });
  const out = reopenKeelBlocked({ previous: entry(), paths, now: NOW });
  // a completed round sits between them: whatever the oldest one carried was handled since
  assert.equal(out.feedbackCursor['review:other'], 's4');
  assert.equal(out.feedbackCursor['comment:1'], 's1');
  assert.ok(!('comment:2' in out.feedbackCursor));
  assert.deepEqual(out.keelReopened, [SECOND]);
});

test('an earlier round whose block was not a keel- one stays consumed', t => {
  const paths = watcherPaths(home(t));
  task(paths, FIRST, { keys: ['comment:1'] }); result(paths, FIRST, { reason: 'required CI failed: unit' });
  task(paths, SECOND, { keys: ['comment:2'] });
  const out = reopenKeelBlocked({ previous: entry(), paths, now: NOW });
  assert.equal(out.feedbackCursor['comment:1'], 's1');
  assert.ok(!('comment:2' in out.feedbackCursor));
  assert.equal(out.repairRounds, 1);
});

// End to end through the poll workflow. The PR is blocked on a keel- reason; its comment was consumed
// by the blocked round (cursor already holds it) and nothing changed on GitHub since.
const POLL_NODE = 'PR_790';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const POLL_TASK = 'live-790-2026-10-11T07:00:00.000Z';
const COMMENT = { id: 101, body: 'P1: example finding', user: { login: 'ExampleReviewer', type: 'User' }, updated_at: '2026-10-11T06:00:00Z' };
const OWNER_PR = {
  state: 'OPEN', isDraft: false, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' },
  headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e', isCrossRepository: true,
};
const pollSnap = () => ({
  state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: NOW, mergeable: 'MERGEABLE',
  labels: [], checkState: 'SUCCESS', commentCount: 1, reviewCount: 0, commentUpdatedAt: NOW, reviewUpdatedAt: null, unresolvedThreads: 0,
});
function pollScan(t, { reason, version = 2, stale = false }) {
  const dir = home(t);
  const paths = watcherPaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const cursor = newFeedback({}, feedbackItems({ pr: { headRefOid: HEAD }, comments: [COMMENT], receiptActor: 'owner' })).cursor;
  task(paths, POLL_TASK, { keys: ['comment:101'], version, nodeId: POLL_NODE });
  writePr(paths.home, POLL_NODE, {
    number: 790, nodeId: POLL_NODE, sessionId: 'sess-790', eligibilityInitialized: true, eligibility: 'blocked',
    admissionVerified: true, admissionEpoch: 'e', headRefName: 'fix/x', title: 'fix',
    pollFingerprint: stale ? 'stale' : pollFingerprint(pollSnap()), feedbackCursor: cursor, repairRounds: 1,
    activeTask: { dispatchId: POLL_TASK, status: 'blocked', blockedKind: 'external', reason, head: HEAD },
  });
  let collected = 0;
  const sent = [];
  const outcome = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now: NOW, nodeId: POLL_NODE, prNumber: 790,
    snapshotFn: () => pollSnap(),
    ghFn: (args) => args[0] === 'api' ? 'owner' : '[]',
    collect: () => {
      collected += 1;
      return {
        pr: { id: POLL_NODE, number: 790, ...OWNER_PR }, admissionVerified: true, mergeReady: false,
        comments: [COMMENT], reviews: [], threads: [], labels: [], mergeable: 'MERGEABLE',
        ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
      };
    },
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-790' }; },
    ownershipSnapshot: function* () { return { pr: OWNER_PR }; },
  });
  return { outcome, collected, sent, entry: readPr(paths.home, POLL_NODE) };
}

test('a frozen PR with an unchanged poll fingerprint still gets its swallowed feedback back', t => {
  const { outcome, collected, entry: saved } = pollScan(t, { reason: KEEL_REASON });
  assert.equal(collected, 1, 'the scan must reach collection instead of stopping at the fingerprint gate');
  assert.notEqual(outcome.prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.deepEqual(saved.keelReopened, [POLL_TASK]);
  assert.ok(!('comment:101' in saved.feedbackCursor) || saved.activeTask.dispatchId !== POLL_TASK,
    'the feedback is either pending again or already delivered in a new task');
});

test('a changed PR gets the swallowed feedback delivered again once, and the blocked round is not charged', t => {
  const { sent, entry: saved } = pollScan(t, { reason: KEEL_REASON, stale: true });
  assert.equal(sent.length, 1, 'the feedback is delivered again');
  assert.match(sent[0].message, /comment:101/);
  assert.deepEqual(saved.keelReopened, [POLL_TASK]);
  assert.equal(saved.repairRounds, 1, 'refunded round is spent by the new delivery, not left charged twice');
});

test('ordinary blocked feedback stays consumed even when the PR changed', t => {
  const { sent, entry: saved } = pollScan(t, { reason: 'required CI failed: unit', stale: true });
  assert.equal(sent.length, 0);
  assert.equal(saved.repairRounds, 1);
  assert.equal(saved.keelReopened, undefined);
});

test('an unchanged fingerprint still short-circuits for ordinary blocks and v3 blocks', t => {
  for (const options of [{ reason: 'required CI failed: unit' }, { reason: KEEL_REASON, version: KEEL_FLOW_VERSION }]) {
    const { outcome, collected, entry: saved } = pollScan(t, options);
    assert.equal(collected, 0);
    assert.equal(outcome.prs[0].dispatch.reason, 'fingerprint-unchanged');
    assert.equal(saved.keelReopened, undefined);
  }
});
