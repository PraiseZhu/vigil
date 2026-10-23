import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as repair from './bin/cindy-repair.mjs';
import * as watcher from './bin/cindy-watcher.mjs';
import { pendingEvents } from './bin/notify.mjs';
import { readPr, writePr } from './bin/cindy-state.mjs';

// KEEL reinstalled into a namespace (xd) moved the ledger and made `namespace:null` calls fail with
// GHOST_NOT_FOUND. Fixtures use placeholder ids only. New symbols are read off the module namespaces
// so a missing export fails one test, not the file.
const { KEEL_FLOW_VERSION, keelNamespace, prepare, repairPaths } = repair;
const { REPO, constrainRetryDispatch, dispatchParams, feedbackItems, newFeedback, pollFingerprint, processPr, reopenKeelBlocked, rulesVersion, scanOnce, watcherPaths } = watcher;
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
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
  withEnv(t, 'CINDY_KEEL_NAMESPACE', 'xd');
  const text = message();
  assert.match(text, /ghost_id=keel[^\n]*namespace="xd"/);
  assert.doesNotMatch(text, /省略 namespace/);
});

test('without keelNamespace the message says to omit namespace and never to pass null', t => {
  withEnv(t, 'CINDY_KEEL_NAMESPACE', undefined);
  const text = message();
  assert.match(text, /ghost_id=keel/);
  assert.match(text, /省略 namespace 参数/);
  assert.match(text, /不得传 namespace:null/);
  assert.doesNotMatch(text, /namespace="/);
});

// ---- SC-3: Jev unavailable agrees with the finalize gate ----
test('Jev unavailable blocks at once instead of logging a gap and pressing on', t => {
  withEnv(t, 'CINDY_KEEL_NAMESPACE', undefined);
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
    dispatchId: 'live-790', nodeId: 'PR_790', number: 790, repo: 'makecindy/cindy',
    sessionId: 'sess-a', headRefOid: HEAD, headRefName: 'fix/x',
    headRepo: 'ExampleUser/cindy-fork', headOwner: 'ExampleUser',
    keelFlow: true, keelFlowVersion: KEEL_FLOW_VERSION, ...extra,
  };
  const taskPath = path.join(paths.tasks, `${task.dispatchId}.json`);
  fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(home, 'PR_790', { number: 790, nodeId: 'PR_790', sessionId: 'sess-a', activeTask: { dispatchId: 'live-790' } });
  return { paths, taskPath };
}
const ghFn = (_bin, args) => {
  if (Array.isArray(args) && args[0] === 'api' && args[1] === 'user') return 'ExampleUser';
  return JSON.stringify({ state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'fix/x', baseRefOid: BASE });
};

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
function keelTask(paths, dispatchId, keys = ['comment:1'], nodeId = NODE) {
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, keelFlow: true, keelFlowVersion: KEEL_FLOW_VERSION, feedback: keys.map(key => ({ key })) }));
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

test('after 30 minutes it is reopened: feedback handed back, nothing spent until the dispatch goes out', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  keelTask(paths, dispatchIdAt(0));
  const previous = blockedEntry(dispatchIdAt(0));
  const out = reopenKeelBlocked({ previous, paths, now: minutesAfter(30) });
  assert.deepEqual(out.feedbackCursor, { 'comment:9': 's9' });
  assert.equal(out.eligibility, 'active');
  assert.equal(out.repairRounds, 2, 'the round is refunded only when the receipt is in');
  assert.equal(out.keelRetries, undefined, 'the reopen is counted only when the receipt is in');
  assert.equal(out.keelRetryIntent.dispatchId, dispatchIdAt(0));
  const again = reopenKeelBlocked({ previous: { ...out, eligibility: 'blocked' }, paths, now: minutesAfter(31) });
  assert.equal(again.eligibility, 'active', 'an undelivered reopen is offered again on the next scan');
});

test('a non-keel block on the current contract is never reopened by the back-off', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  keelTask(paths, dispatchIdAt(0));
  const previous = blockedEntry(dispatchIdAt(0), {
    activeTask: { dispatchId: dispatchIdAt(0), status: 'blocked', blockedKind: 'external', reason: 'required CI failed', observedAt: BLOCKED_AT } });
  assert.equal(reopenKeelBlocked({ previous, paths, now: minutesAfter(120) }), previous);
});

// ---- SC-5: an unreadable ledger holds dispatch back without charging anything ----
const POLL_NODE = 'PR_790';
const COMMENT = { id: 101, body: 'P1: example finding', user: { login: 'ExampleReviewer', type: 'User' }, updated_at: '2026-10-24T06:00:00Z' };
const OWNER_PR = {
  state: 'OPEN', isDraft: false, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' },
  headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e', isCrossRepository: true,
};
const pollSnap = () => ({
  state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: NOW, mergeable: 'MERGEABLE',
  labels: [], checkState: 'SUCCESS', commentCount: 1, reviewCount: 0, commentUpdatedAt: NOW, reviewUpdatedAt: null, unresolvedThreads: 0,
});
function pollScan(t, { stale = true } = {}) {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const before = newFeedback({}, []).cursor;
  writePr(paths.home, POLL_NODE, {
    number: 790, nodeId: POLL_NODE, sessionId: 'sess-790', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: 'e', headRefName: 'fix/x', title: 'fix', url: 'https://github.com/makecindy/cindy/pull/790',
    pollFingerprint: stale ? 'stale' : pollFingerprint(pollSnap()), feedbackCursor: before, repairRounds: 1,
  });
  const sent = [];
  const outcome = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now: NOW, nodeId: POLL_NODE, prNumber: 790,
    snapshotFn: () => pollSnap(),
    ghFn: (args) => args[0] === 'api' ? 'owner' : '[]',
    collect: () => ({
      pr: { id: POLL_NODE, number: 790, ...OWNER_PR }, admissionVerified: true, mergeReady: false,
      comments: [COMMENT], reviews: [], threads: [], labels: [], mergeable: 'MERGEABLE',
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-790' }; },
    ownershipSnapshot: function* () { return { pr: OWNER_PR }; },
  });
  return { outcome, sent, paths, entry: readPr(paths.home, POLL_NODE) };
}

test('an unreadable ledger root skips dispatch, charges no round, and queues a notice', t => {
  withEnv(t, 'CINDY_KEEL_LEDGER_ROOT', path.join(tmp(t, 'keel-env-root-'), 'gone'));
  const { outcome, sent, paths, entry } = pollScan(t);
  assert.equal(sent.length, 0);
  assert.equal(outcome.prs[0].dispatch.attempted, false);
  assert.equal(outcome.prs[0].dispatch.reason, 'keel-ledger-unavailable');
  assert.equal(entry.repairRounds, 1);
  assert.equal(entry.pendingDispatch ?? null, null);
  assert.equal(Object.hasOwn(entry.feedbackCursor, 'comment:101'), false, 'the feedback stays undelivered');
  const notices = pendingEvents(paths.home);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'keel-unavailable');
  assert.equal(notices[0].number, 790);
});

test('the PR is looked at again on the next scan, and delivered once the ledger is back', t => {
  const root = path.join(tmp(t, 'keel-env-root-'), 'ledger');
  withEnv(t, 'CINDY_KEEL_LEDGER_ROOT', root);
  const first = pollScan(t);
  assert.equal(first.entry.collectRetry, true, 'the poll fingerprint must not swallow the retry');
  fs.mkdirSync(root, { recursive: true });
  const again = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths: first.paths, now: '2026-10-24T12:01:00.000Z', nodeId: POLL_NODE, prNumber: 790,
    snapshotFn: () => pollSnap(), ghFn: (args) => args[0] === 'api' ? 'owner' : '[]',
    collect: () => ({
      pr: { id: POLL_NODE, number: 790, ...OWNER_PR }, admissionVerified: true, mergeReady: false,
      comments: [COMMENT], reviews: [], threads: [], labels: [], mergeable: 'MERGEABLE',
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: () => ({ target_session_id: 'sess-790' }), ownershipSnapshot: function* () { return { pr: OWNER_PR }; },
  });
  assert.equal(again.prs[0].dispatch.attempted, true);
});

// ---- a due retry must not be spent while the ledger is still unreadable ----
const POLL_TASK = 'live-790-2026-10-24T10:00:00.000Z';
function blockedPoll(t) {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const cursor = newFeedback({}, feedbackItems({ pr: { headRefOid: HEAD }, comments: [COMMENT], receiptActor: 'owner' })).cursor;
  keelTask(paths, POLL_TASK, ['comment:101'], POLL_NODE);
  writePr(paths.home, POLL_NODE, {
    number: 790, nodeId: POLL_NODE, sessionId: 'sess-790', eligibilityInitialized: true, eligibility: 'blocked',
    admissionVerified: true, admissionEpoch: 'e', headRefName: 'fix/x', title: 'fix', url: 'https://github.com/makecindy/cindy/pull/790',
    pollFingerprint: pollFingerprint(pollSnap()), feedbackCursor: cursor, repairRounds: 1,
    activeTask: { dispatchId: POLL_TASK, status: 'blocked', blockedKind: 'external', reason: KEEL_REASON, head: HEAD, observedAt: BLOCKED_AT },
  });
  const sent = [];
  const scan = now => scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now, nodeId: POLL_NODE, prNumber: 790,
    snapshotFn: () => pollSnap(), ghFn: args => args[0] === 'api' ? 'owner' : '[]',
    collect: () => ({
      pr: { id: POLL_NODE, number: 790, ...OWNER_PR }, admissionVerified: true, mergeReady: false,
      comments: [COMMENT], reviews: [], threads: [], labels: [], mergeable: 'MERGEABLE',
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: params => { sent.push(params); return { target_session_id: 'sess-790' }; },
    ownershipSnapshot: function* () { return { pr: OWNER_PR }; },
  });
  return { sent, scan, entry: () => readPr(paths.home, POLL_NODE) };
}

test('a due keel- retry is left alone while the ledger is unreadable, and costs no reopen', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  keelTask(paths, dispatchIdAt(0));
  const previous = blockedEntry(dispatchIdAt(0));
  const gone = path.join(tmp(t, 'keel-env-root-'), 'gone');
  assert.equal(reopenKeelBlocked({ previous, paths, now: minutesAfter(31), keelRoot: gone }), previous);
  const out = reopenKeelBlocked({ previous, paths, now: minutesAfter(31), keelRoot: tmp(t, 'keel-env-root-') });
  assert.equal(out.keelRetries.length, 1, 'with a readable ledger the same retry is taken');
});

test('a blocked PR whose ledger comes back after the back-off is reopened and delivered on the next scan', t => {
  const root = path.join(tmp(t, 'keel-env-root-'), 'ledger');
  withEnv(t, 'CINDY_KEEL_LEDGER_ROOT', root);
  const harness = blockedPoll(t);
  const early = harness.scan(minutesAfter(31));
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.entry().keelRetries, undefined, 'nothing is spent while the ledger is still gone');
  assert.equal(harness.entry().repairRounds, 1);
  assert.notEqual(early.prs[0].dispatch.attempted, true);
  fs.mkdirSync(root, { recursive: true });
  const later = harness.scan(minutesAfter(32));
  assert.equal(harness.sent.length, 1, 'the feedback is delivered once the ledger is back');
  assert.equal(later.prs[0].dispatch.attempted, true);
  assert.equal(harness.entry().keelRetries.length, 1);
});

// ---- an illegal keelNamespace fails loudly instead of being read as "not configured" ----
test('keelNamespace: unset is null, a legal value is returned as is', () => {
  assert.equal(keelNamespace({}), null);
  assert.equal(keelNamespace({ CINDY_KEEL_NAMESPACE: '' }), null);
  assert.equal(keelNamespace({ CINDY_KEEL_NAMESPACE: 'xd' }), 'xd');
  assert.equal(keelNamespace({ CINDY_KEEL_NAMESPACE: 'Org_1-b' }), 'Org_1-b');
});

test('keelNamespace: an illegal value throws and names the field and the variable, not a path', t => {
  for (const value of ['xd.corp', 'my org', '-xd', ' xd', 'a'.repeat(129)]) {
    assert.throws(() => keelNamespace({ CINDY_KEEL_NAMESPACE: value }), error => {
      assert.match(error.message, /keelNamespace/);
      assert.match(error.message, /CINDY_KEEL_NAMESPACE/);
      assert.doesNotMatch(error.message, /\/(?:tmp|Users|home)\//);
      return true;
    }, JSON.stringify(value));
  }
  const home = tmp(t, 'keel-env-home-');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'profile.json'), JSON.stringify({ keelNamespace: 5 }));
  assert.throws(() => keelNamespace({ CINDY_WATCHER_HOME: home }), /keelNamespace/);
});

test('an illegal keelNamespace stops the dispatch message instead of silently dropping the namespace', t => {
  withEnv(t, 'CINDY_KEEL_NAMESPACE', 'xd.corp');
  assert.throws(() => message(), /keelNamespace/);
});

// ---- F1: a reopen is spent only when its dispatch really went out ----
const F_ID = 'live-790-2026-10-24T10:00:00.000Z';
const F_COMMENT = { id: 101, body: 'P1: example finding', user: { login: 'ExampleReviewer', type: 'User' }, updated_at: '2026-10-24T06:00:00Z' };
// blocked=true: the PR sits blocked on a keel- result file that is re-read on every scan. blocked=false: fresh feedback.
function processHarness(t, { blocked = true } = {}) {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  const raw = { id: 'PR_790', number: 790, repo: REPO, state: 'OPEN', isDraft: false, title: 'Fixture', url: 'https://example.invalid/pull/790',
    headRefOid: HEAD, baseRefOid: BASE, headRefName: 'fix/fixture', author: { login: 'owner' }, releaseEpoch: 'e',
    isCrossRepository: true, sameRepository: false, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'example-fork' } };
  const pr = raw;
  const comments = [F_COMMENT];
  const feedback = newFeedback({}, feedbackItems({ pr, comments, receiptActor: 'owner' })).fresh;
  const writeBlocked = (dispatchId, observedAt) => {
    fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
      dispatchId, nodeId: 'PR_790', number: 790, repo: REPO, sessionId: 's1', headRefOid: HEAD, headRefName: 'fix/fixture',
      keelFlow: true, keelFlowVersion: KEEL_FLOW_VERSION, feedback }));
    const result = { schemaVersion: 2, dispatchId, nodeId: 'PR_790', sessionId: 's1', status: 'blocked', blockedKind: 'external',
      reason: KEEL_REASON, head: HEAD, sourceHead: HEAD, observedAt, receiptId: `receipt-${dispatchId}` };
    fs.writeFileSync(path.join(paths.stateDir, 'results', `${dispatchId}.json`), JSON.stringify(result));
    return result;
  };
  const result = blocked ? writeBlocked(F_ID, BLOCKED_AT) : null;
  const previous = {
    number: 790, nodeId: 'PR_790', sessionId: 's1', eligibility: blocked ? 'blocked' : 'active', eligibilityInitialized: true,
    admissionVerified: true, admissionEpoch: pr.releaseEpoch, wasDraft: false, headRefOid: HEAD, headRefName: pr.headRefName, repairRounds: 1,
    rulesVersion: rulesVersion(), url: pr.url, feedbackCursor: blocked ? newFeedback({}, feedback).cursor : {},
    ...(blocked ? { activeTask: { ...result } } : {}), 
  };
  const state = { version: 2, repo: REPO, prs: { PR_790: previous } };
  const raw2 = { pr, admissionVerified: true, mergeReady: false, comments, reviews: [], threads: [], labels: [], checks: [], requiredChecks: [],
    ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] }, mergeable: 'MERGEABLE' };
  const collected = raw2;
  const sent = [];
  const okRoot = tmp(t, 'keel-env-root-');
  const run = ({ remainingMs = 120000, keelRoot = okRoot, time, liveAuthor = 'owner' }) => {
    const report = []; const events = [];
    const gen = processPr({ pr, state, paths, now: time, events, report, viewer: 'owner', dryRun: false,
      dispatchFn: params => { sent.push(params); return { target_session_id: 's1' }; },
      collect: () => collected, ghFn: () => '{}', recheckFn: () => {},
      ownershipSnapshot: function* () { return { pr: { ...pr, author: { login: liveAuthor } } }; },
      remaining: () => remainingMs, deadline: Date.now() + 120000, clock: Date.now, allowCreate: false, keelRoot });
    let next = gen.next(); while (!next.done) next = gen.next(next.value());
    return { report, entry: state.prs.PR_790 };
  };
  return { paths, sent, run, writeBlocked, okRoot, entry: () => state.prs.PR_790 };
}

test('F1: a reopen deferred for budget spends nothing, and the next scan still delivers it', t => {
  const h = processHarness(t);
  const first = h.run({ remainingMs: 10000, time: minutesAfter(31) });
  assert.equal(first.report[0].dispatch.reason, 'dispatch-budget-deferred');
  assert.equal(h.sent.length, 0);
  assert.equal(h.entry().keelRetries, undefined, 'no reopen is counted before a receipt');
  assert.equal(h.entry().repairRounds, 1, 'no round is refunded before a receipt');
  const second = h.run({ time: minutesAfter(32) });
  assert.equal(second.report[0].dispatch.attempted, true);
  assert.equal(h.sent.length, 1, 'the deferred reopen is delivered on the next scan');
  assert.equal(h.entry().keelRetries.length, 1, 'counted once the receipt is in');
  assert.equal(h.entry().repairRounds, 1, 'the refunded round is the one the new delivery uses');
});

test('F1: a ledger hold or an ownership stop between two scans spends nothing either', t => {
  const h = processHarness(t);
  h.run({ remainingMs: 10000, time: minutesAfter(31) });
  const held = h.run({ keelRoot: path.join(h.okRoot, 'gone'), time: minutesAfter(32) });
  assert.equal(held.report[0].dispatch.reason, 'keel-ledger-unavailable');
  const stopped = h.run({ liveAuthor: 'someone-else', time: minutesAfter(33) });
  assert.equal(stopped.report[0].dispatch.reason, 'ownership-changed-before-dispatch');
  assert.equal(h.sent.length, 0);
  assert.equal(h.entry().keelRetries, undefined);
  const delivered = h.run({ time: minutesAfter(34) });
  assert.equal(delivered.report[0].dispatch.attempted, true);
  assert.equal(h.sent.length, 1);
  assert.equal(h.entry().keelRetries.length, 1);
});

test('F1: only delivered reopens count, and the cap of 3 per admission epoch still holds', t => {
  const h = processHarness(t);
  let observed = BLOCKED_AT;
  for (let n = 1; n <= 3; n += 1) {
    const at = new Date(Date.parse(observed) + 31 * 60000).toISOString();
    const out = h.run({ time: at });
    assert.equal(out.report[0].dispatch.attempted, true, `reopen ${n} is delivered`);
    assert.equal(h.entry().keelRetries.length, n);
    h.writeBlocked(h.entry().activeTask.dispatchId, at);
    observed = at;
  }
  const fourth = h.run({ time: new Date(Date.parse(observed) + 31 * 60000).toISOString() });
  assert.notEqual(fourth.report[0].dispatch.attempted, true, 'the 4th reopen in the same epoch is refused');
  assert.equal(h.sent.length, 3);
  assert.equal(h.entry().keelRetries.length, 3);
});

// ---- F2: an unconfigured ledger root is as unusable as an unreadable one ----
test('F2: prepare blocks a Keel task when keelLedgerRoot is not configured, before any git call', t => {
  const home = tmp(t, 'keel-env-home-');
  const { paths, taskPath } = writeTask(home);
  const gitCalls = [];
  const result = prepare({ home, taskPath, ghFn, gitFn: (_bin, args) => { gitCalls.push(args); return ''; }, keelRoot: null });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /^keel-unavailable: keelLedgerRoot not configured/);
  assert.deepEqual(gitCalls, []);
  assert.match(JSON.parse(fs.readFileSync(path.join(paths.results, 'live-790.json'), 'utf8')).reason, /^keel-unavailable/);
});

test('F2: a task from before the Keel flow (v1, or no keelFlow) is still prepared without a ledger root', t => {
  for (const extra of [{ keelFlow: true, keelFlowVersion: undefined }, { keelFlow: undefined, keelFlowVersion: undefined }]) {
    const home = tmp(t, 'keel-env-home-');
    const { taskPath } = writeTask(home, extra);
    let gitCalls = 0;
    try { prepare({ home, taskPath, ghFn, gitFn: () => { gitCalls += 1; throw new Error('GIT_REACHED'); }, keelRoot: null }); } catch {}
    assert.ok(gitCalls > 0, JSON.stringify(extra));
  }
});

test('F2: the dispatch gate holds delivery when keelLedgerRoot is not configured, and says why in the notice', t => {
  const h = processHarness(t, { blocked: false });
  const out = h.run({ keelRoot: null, time: NOW });
  assert.equal(out.report[0].dispatch.reason, 'keel-ledger-unavailable');
  assert.equal(h.sent.length, 0);
  assert.equal(h.entry().repairRounds, 1);
  const notices = pendingEvents(h.paths.home);
  assert.equal(notices.length, 1);
  assert.match(notices[0].cause, /keelLedgerRoot not configured/);
});

test('F2: an unconfigured root does not start a keel- retry that could not be delivered', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  keelTask(paths, dispatchIdAt(0));
  const previous = blockedEntry(dispatchIdAt(0));
  assert.equal(reopenKeelBlocked({ previous, paths, now: minutesAfter(31), keelRoot: null }), previous);
});

// ---- F3: v2 retries carry the namespace and the Jev stop rule; the old-contract reopen respects the ledger ----
const retryMessage = version => constrainRetryDispatch({ message: 'cached task' },
  { dispatchId: 'live-7-2026-10-06T01:00:00.000Z', keelFlow: true, keelFlowVersion: version, headRefOid: HEAD, feedback: [] }).message;

test('F3: a v2 retry names the configured namespace and stops at once when Jev is unavailable', t => {
  withEnv(t, 'CINDY_KEEL_NAMESPACE', 'xd');
  const text = retryMessage(2);
  assert.match(text, /ghost_id=keel[^\n]*namespace="xd"/);
  assert.match(text, /keel-jev-unavailable: <原文>/);
  assert.match(text, /JEV_NOT_CONFIGURED/);
  assert.doesNotMatch(text, /Jev 不可用时记 JEV_UNAVAILABLE/);
  assert.match(text, /pstack_ledger/, 'the rest of the v2 wording is unchanged');
});

test('F3: without a namespace a v2 or v1 retry says to omit it and never to pass null', t => {
  withEnv(t, 'CINDY_KEEL_NAMESPACE', undefined);
  for (const version of [2, 1]) {
    const text = retryMessage(version);
    assert.match(text, /省略 namespace 参数/);
    assert.match(text, /不得传 namespace:null/);
    assert.doesNotMatch(text, /namespace="/);
  }
});

test('F3: a v1 retry names the namespace but keeps its original Jev wording (v1 finalize does not need a Jev answer)', t => {
  withEnv(t, 'CINDY_KEEL_NAMESPACE', 'xd');
  const text = retryMessage(1);
  assert.match(text, /ghost_id=keel[^\n]*namespace="xd"/);
  assert.match(text, /Jev 不可用时记 JEV_UNAVAILABLE/);
  assert.doesNotMatch(text, /keel-jev-unavailable/);
});

test('F3: the old-contract reopen is held back while the ledger is unreadable, and costs nothing', t => {
  const paths = watcherPaths(tmp(t, 'keel-env-home-'));
  const OLD = 'live-904-2026-10-11T07:00:00.000Z';
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${OLD}.json`), JSON.stringify({
    dispatchId: OLD, nodeId: NODE, keelFlow: true, keelFlowVersion: 2, feedback: [{ key: 'comment:1' }] }));
  const previous = blockedEntry(OLD);
  const gone = path.join(tmp(t, 'keel-env-root-'), 'gone');
  assert.equal(reopenKeelBlocked({ previous, paths, now: NOW, keelRoot: gone }), previous);
  const out = reopenKeelBlocked({ previous, paths, now: NOW, keelRoot: tmp(t, 'keel-env-root-') });
  assert.deepEqual(out.keelReopened, [OLD]);
  assert.deepEqual(out.feedbackCursor, { 'comment:9': 's9' });
});
