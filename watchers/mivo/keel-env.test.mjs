import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';
import { KEEL_FLOW_VERSION, prepare, repairPaths } from './bin/mivo-repair.mjs';
import { REPO, dispatchParams, feedbackItems, newFeedback, processPr, reopenKeelBlocked, watcherPaths } from './bin/mivo-watcher.mjs';
import { pendingEvents } from './bin/notify.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';

// KEEL reinstalled into a namespace (xd) moved the ledger and made `namespace:null` calls fail with
// GHOST_NOT_FOUND. Fixtures use placeholder ids only.
const HEAD = 'a'.repeat(40);
const REMOTE = 'b'.repeat(40);
const NOW = '2026-10-24T12:00:00.000Z';

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function withEnv(t, name, value) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  t.after(() => { if (before === undefined) delete process.env[name]; else process.env[name] = before; });
}
function message(extra = {}) {
  return dispatchParams({
    pr: { number: 7, id: 'PR_7', headRefOid: HEAD, title: 't' }, mapping: {},
    fresh: [{ key: 'review:r1', source: 'review', nativeId: 'r1', revision: 't', sha: HEAD, body: '**P1** bug', category: 'actionable-fix' }],
    now: '2026-10-06T01:00:00Z', taskPath: '/tmp/home/state/tasks/live-7-2026-10-06T01:00:00.000Z.json', home: '/tmp/home', ...extra,
  }).message;
}

// ---- SC-1: keelNamespace in the dispatch message ----
test('a configured keelNamespace is named wherever the message tells the session to call Keel', t => {
  withEnv(t, 'MIVO_KEEL_NAMESPACE', 'xd');
  const text = message();
  assert.match(text, /ghost_id=keel[^\n]*namespace="xd"/);
  assert.doesNotMatch(text, /省略 namespace/);
});

test('without keelNamespace the message says to omit namespace and never to pass null', t => {
  withEnv(t, 'MIVO_KEEL_NAMESPACE', undefined);
  const text = message();
  assert.match(text, /ghost_id=keel/);
  assert.match(text, /省略 namespace 参数/);
  assert.match(text, /不得传 namespace:null/);
  assert.doesNotMatch(text, /namespace="/);
});

// ---- SC-3: Jev unavailable agrees with the finalize gate ----
test('Jev unavailable blocks at once instead of logging a gap and pressing on', t => {
  withEnv(t, 'MIVO_KEEL_NAMESPACE', undefined);
  const text = message();
  assert.match(text, /keel-jev-unavailable: <原文>/);
  assert.match(text, /JEV_NOT_CONFIGURED/);
  assert.match(text, /不先做修复、不跑 validate/);
  assert.doesNotMatch(text, /kind:"gap"/);
  assert.doesNotMatch(text, /Jev 不可用[^。\n]*不 blocked/);
  assert.doesNotMatch(text, /Jev 不可用而 blocked/);
});

// ---- SC-2: prepare checks the ledger before it builds a worktree ----
function writeTask(home, extra = {}) {
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const task = {
    dispatchId: 'live-790', nodeId: 'PR_790', number: 790, repo: REPO,
    sessionId: 'sess-a', headRefOid: HEAD, headRefName: 'fix/x', releaseEpoch: 'opened:PR_790:2026-10-01T00:00:00Z',
    handoff: { version: 1, id: 'handoff-fixture', repo: REPO, number: 790, nodeId: 'PR_790', head: HEAD,
      releaseEpoch: 'opened:PR_790:2026-10-01T00:00:00Z', author: 'ExampleUser' },
    keelFlow: true, keelFlowVersion: KEEL_FLOW_VERSION, ...extra,
  };
  const taskPath = path.join(paths.tasks, 'live-790.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', sessionId: 'sess-a', handoff: task.handoff, activeTask: { dispatchId: 'live-790' } });
  return { paths, taskPath };
}
const ghFn = (_bin, args) => args[1] === 'graphql'
  ? JSON.stringify({ data: { node: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false } } } } })
  : JSON.stringify({ id: 'PR_790', number: 790, createdAt: '2026-10-01T00:00:00Z', author: { login: 'ExampleUser' },
    isCrossRepository: false, baseRefName: 'main', headRepositoryOwner: { login: 'example-org' },
    headRepository: { name: 'example-plugin' }, state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'fix/x', baseRefOid: REMOTE });

test('prepare reports keel-unavailable before it touches git when the ledger directory is missing', t => {
  const home = tmp(t, 'keel-env-home-');
  const { paths, taskPath } = writeTask(home);
  const gitCalls = [];
  const gitFn = (_bin, args) => { gitCalls.push(args); return ''; };
  const keelRoot = path.join(tmp(t, 'keel-env-root-'), 'gone');
  const result = prepare({ home, taskPath, ghFn, gitFn, keelRoot });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /^keel-unavailable/);
  assert.deepEqual(gitCalls, [], 'no worktree is built for a task that cannot finalize');
  const saved = JSON.parse(fs.readFileSync(path.join(paths.results, 'live-790.json'), 'utf8'));
  assert.equal(saved.status, 'blocked');
  assert.match(saved.reason, /^keel-unavailable/);
});

// ---- SC-4: keel- blocks come back on the current contract, with a back-off and a cap ----
const NODE = 'PR_example';
const BLOCKED_AT = '2026-10-24T10:00:00.000Z';
const KEEL_REASON = 'keel-unavailable: ledger root unreadable (ENOENT)';
const dispatchIdAt = n => `live-904-2026-10-24T10:0${n}:00.000Z`;
function keelTask(paths, dispatchId, keys = ['comment:1']) {
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId: NODE, keelFlow: true, keelFlowVersion: KEEL_FLOW_VERSION, feedback: keys.map(key => ({ key })) }));
}
const blockedEntry = (dispatchId, extra = {}) => ({
  number: 904, nodeId: NODE, sessionId: 'session-1', eligibility: 'blocked', repairRounds: 2, admissionEpoch: 'epoch-1',
  feedbackCursor: { 'comment:1': 's1', 'comment:9': 's9' },
  activeTask: { dispatchId, status: 'blocked', blockedKind: 'external', reason: KEEL_REASON, observedAt: BLOCKED_AT },
  ...extra,
});
const minutesAfter = n => new Date(Date.parse(BLOCKED_AT) + n * 60000).toISOString();

test('a keel- block on the current contract is not reopened before 30 minutes have passed', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  keelTask(paths, dispatchIdAt(0));
  const previous = blockedEntry(dispatchIdAt(0));
  assert.equal(reopenKeelBlocked({ previous, paths, now: minutesAfter(29) }), previous);
});

test('after 30 minutes it is reopened once: feedback handed back and the round refunded', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  keelTask(paths, dispatchIdAt(0));
  const previous = blockedEntry(dispatchIdAt(0));
  const out = reopenKeelBlocked({ previous, paths, now: minutesAfter(30) });
  assert.deepEqual(out.feedbackCursor, { 'comment:9': 's9' });
  assert.equal(out.repairRounds, 1);
  assert.equal(out.eligibility, 'active');
  assert.equal(out.keelRetries.length, 1);
  assert.equal(reopenKeelBlocked({ previous: out, paths, now: minutesAfter(90) }), out, 'the same dispatch id is reopened once');
});

test('at most 3 reopens per admission epoch, then it stays blocked', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  let previous = blockedEntry(dispatchIdAt(0));
  for (let n = 0; n < 3; n += 1) {
    const id = dispatchIdAt(n);
    keelTask(paths, id);
    previous = { ...previous, activeTask: { ...previous.activeTask, dispatchId: id, status: 'blocked' }, eligibility: 'blocked' };
    const out = reopenKeelBlocked({ previous, paths, now: minutesAfter(30 + n * 60) });
    assert.notEqual(out, previous, `reopen ${n + 1} happens`);
    previous = { ...out, eligibility: 'blocked' };
  }
  const id = dispatchIdAt(3);
  keelTask(paths, id);
  previous = { ...previous, activeTask: { ...previous.activeTask, dispatchId: id } };
  assert.equal(reopenKeelBlocked({ previous, paths, now: minutesAfter(400) }), previous, 'the 4th is refused');
  // a new admission epoch starts the count over
  const fresh = { ...previous, admissionEpoch: 'epoch-2' };
  assert.notEqual(reopenKeelBlocked({ previous: fresh, paths, now: minutesAfter(400) }), fresh);
});

test('a non-keel block on the current contract is never reopened by the back-off', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  keelTask(paths, dispatchIdAt(0));
  const previous = blockedEntry(dispatchIdAt(0), {
    activeTask: { dispatchId: dispatchIdAt(0), status: 'blocked', blockedKind: 'external', reason: 'required CI failed', observedAt: BLOCKED_AT } });
  assert.equal(reopenKeelBlocked({ previous, paths, now: minutesAfter(120) }), previous);
});

// ---- SC-5: an unreadable ledger holds dispatch back without charging anything ----
function runProcessPr(t, { keelRoot, dispatched }) {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  const pr = handoffPr({ repo: REPO, id: NODE, number: 904, title: 'Fixture repair', url: `https://github.com/${REPO}/pull/904`,
    headRefOid: HEAD, baseRefOid: 'd'.repeat(40), headRefName: 'fix/fixture', state: 'OPEN', isDraft: false, author: { login: 'ExampleUser' } });
  const comment = { id: 101, body: 'P1: example finding', user: { login: 'ExampleReviewer', type: 'User' }, updated_at: '2026-10-24T06:00:00Z' };
  assert.equal(feedbackItems({ pr, comments: [comment], receiptActor: 'ExampleUser' }).length, 1);
  const entryState = {
    nodeId: NODE, number: 904, sessionId: 'existing-session', claimedAt: NOW, headRefOid: HEAD, eligibility: 'active',
    eligibilityInitialized: true, admissionVerified: true, admissionEpoch: pr.releaseEpoch, handoff: handoffReceipt(pr),
    wasDraft: false, feedbackCursor: newFeedback({}, []).cursor, repairRounds: 1, url: pr.url,
  };
  const state = { version: 2, repo: REPO, prs: { [NODE]: entryState } };
  const snapshot = withAuthorHandoff({ pr, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, comments: [comment],
    reviews: [], threads: [], labels: [], mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: true, mergeReady: false,
    policy: { status: 'verified' } }, pr);
  const report = []; const events = [];
  const forbidden = () => { throw Error('external operation must not run in a fixture'); };
  const listed = { ...pr }; delete listed.state; delete listed.author;
  const run = processPr({ pr: listed, state, paths, now: NOW, events, report, viewer: 'ExampleUser', dryRun: false,
    dispatchFn: (...args) => { dispatched.push(args); return forbidden(); },
    collect: () => snapshot, ghFn: forbidden, recheckFn: forbidden, ownershipSnapshot: forbidden, maintenanceSessionId: null,
    remaining: () => 120000, deadline: Date.now() + 120000, clock: Date.now, resumeCursor: 0, allowCreate: false, forceCreate: false,
    keelRoot });
  let next = run.next(); while (!next.done) next = run.next(next.value());
  return { report, state, paths };
}

test('an unreadable ledger root skips dispatch, charges no round, and queues a notice', t => {
  const dispatched = [];
  const { report, state, paths } = runProcessPr(t, { keelRoot: path.join(tmp(t, 'keel-env-root-'), 'gone'), dispatched });
  assert.equal(dispatched.length, 0);
  assert.equal(report[0].dispatch.attempted, false);
  assert.equal(report[0].dispatch.reason, 'keel-ledger-unavailable');
  const entry = state.prs[NODE];
  assert.equal(entry.repairRounds, 1);
  assert.equal(entry.pendingDispatch ?? null, null);
  assert.equal(Object.hasOwn(entry.feedbackCursor, 'comment:101'), false, 'the feedback stays undelivered');
  const notices = pendingEvents(paths.home);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'keel-unavailable');
  assert.equal(notices[0].number, 904);
});

test('the PR is retried on the next scan once the ledger is back', t => {
  const { report } = runProcessPr(t, { keelRoot: path.join(tmp(t, 'keel-env-root-'), 'gone'), dispatched: [] });
  assert.equal(report[0].dispatch.reason, 'keel-ledger-unavailable');
  assert.ok(report.every(item => item.dispatch?.attempted !== true));
});
