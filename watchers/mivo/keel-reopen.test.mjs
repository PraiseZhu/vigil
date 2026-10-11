import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';
import { KEEL_FLOW_VERSION } from './bin/mivo-repair.mjs';
import { REPO, feedbackItems, newFeedback, processPr, reopenKeelBlocked, watcherPaths } from './bin/mivo-watcher.mjs';

// A repair round that blocked on "keel-..." never judged its feedback, yet the cursor had moved on
// and the round was charged. Fixtures use placeholder ids only.
const NODE = 'PR_example';
const FIRST = 'live-904-2026-10-11T05:15:00.992Z';
const SECOND = 'live-904-2026-10-11T07:00:00.928Z';
const KEEL_REASON = 'keel-ledger-unavailable: pstack_decide(op=log) returned RUN_NOT_FOUND';
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

test('an earlier round whose block was not a keel- one stays consumed', t => {
  const paths = watcherPaths(home(t));
  task(paths, FIRST, { keys: ['comment:1'] }); result(paths, FIRST, { reason: 'required CI failed: unit' });
  task(paths, SECOND, { keys: ['comment:2'] });
  const out = reopenKeelBlocked({ previous: entry(), paths, now: NOW });
  assert.equal(out.feedbackCursor['comment:1'], 's1');
  assert.ok(!('comment:2' in out.feedbackCursor));
  assert.equal(out.repairRounds, 1);
});

// End to end through processPr: the feedback that the blocked round swallowed is delivered again.
function scan(t, { reason }) {
  const dir = home(t);
  const paths = watcherPaths(dir);
  const sha = 'a'.repeat(40);
  const pr = handoffPr({ repo: REPO, id: NODE, number: 904, title: 'Fixture repair', url: `https://github.com/${REPO}/pull/904`,
    headRefOid: sha, baseRefOid: 'd'.repeat(40), headRefName: 'fix/fixture', state: 'OPEN', isDraft: false, author: { login: 'ExampleUser' } });
  const comment = { id: 101, body: 'P1: example finding', user: { login: 'ExampleReviewer', type: 'User' }, updated_at: '2026-10-11T06:00:00Z' };
  const items = feedbackItems({ pr, comments: [comment], receiptActor: 'ExampleUser' });
  assert.equal(items.length, 1);
  task(paths, SECOND, { keys: [`comment:${comment.id}`] });
  const entryState = {
    nodeId: NODE, number: 904, sessionId: 'existing-session', claimedAt: NOW, headRefOid: sha, eligibility: 'blocked',
    eligibilityInitialized: true, admissionVerified: true, admissionEpoch: pr.releaseEpoch, handoff: handoffReceipt(pr),
    wasDraft: false, feedbackCursor: newFeedback({}, items).cursor, repairRounds: 1,
    activeTask: { dispatchId: SECOND, status: 'blocked', blockedKind: 'external', reason, resultHeadCurrent: true },
  };
  const state = { version: 2, repo: REPO, prs: { [NODE]: entryState } };
  const snapshot = withAuthorHandoff({ pr, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, comments: [comment],
    reviews: [], threads: [], labels: [], mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: true, mergeReady: false,
    policy: { status: 'verified' } }, pr);
  const report = []; const events = [];
  const forbidden = () => { throw Error('external operation must not run in a fixture'); };
  const listed = { ...pr }; delete listed.state; delete listed.author;
  const run = processPr({ pr: listed, state, paths, now: NOW, events, report, viewer: 'ExampleUser', dryRun: true, dispatchFn: forbidden,
    collect: () => snapshot, ghFn: forbidden, recheckFn: forbidden, ownershipSnapshot: forbidden, maintenanceSessionId: null,
    remaining: () => 120000, deadline: Date.now() + 120000, clock: Date.now, resumeCursor: 0, allowCreate: false, forceCreate: false });
  let next = run.next(); while (!next.done) next = run.next(next.value());
  return { report, state };
}

test('processPr delivers the swallowed feedback again once, and charges no round for the blocked one', t => {
  const { report, state } = scan(t, { reason: KEEL_REASON });
  assert.equal(report[0].fresh, 1);
  assert.equal(report[0].dispatch.reason, 'dry-run');
  assert.equal(state.prs[NODE].repairRounds, 0);
  assert.deepEqual(state.prs[NODE].keelReopened, [SECOND]);
});

test('processPr keeps ordinary blocked feedback consumed', t => {
  const { report, state } = scan(t, { reason: 'required CI failed: unit' });
  assert.equal(report[0].fresh, 0);
  assert.equal(report[0].dispatch.reason, 'eligibility-blocked');
  assert.equal(state.prs[NODE].repairRounds, 1);
  assert.equal(state.prs[NODE].keelReopened, undefined);
});
