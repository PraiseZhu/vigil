import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffPr, handoffReceipt, withAuthorHandoff, isChildPrList } from './handoff.fixture.mjs';
import * as watcher from './bin/mivo-watcher.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';
import { resolveThreadsWithApp } from './bin/mivo-app-token.mjs';
import { taskFeedbackDigest } from './bin/mivo-feedback-policy.mjs';

// A task frozen by a delivery the host did not confirm (pendingDispatch.status = retryable) is sent again later. Threads
// the App path took in between (switch on) must not reach the session that retry wakes up: they are cut from the
// message and from the task file, and a retry left with no feedback is cancelled. With the switch off the retry is
// exactly what it was. Everything runs through the real poll/processPr; GitHub is a recording fake.
const { scanOnceAsync, watcherPaths, constrainRetryDispatch } = watcher;
const REPO = process.env.MIVO_WATCHER_TARGET_REPO;
const SWITCH = 'MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP';
const NODE = 'PR_900';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FIRST = '2026-11-05T01:00:00.000Z';
const NOT_DUE = '2026-11-05T01:01:00.000Z';
const DUE = '2026-11-05T01:06:00.000Z';
const KEY = '0123456789ab';
const TOKEN = 'fake-installation-token-for-test';
const KEY_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const APP_ENV = { MIVO_WATCHER_HOME: path.join(os.tmpdir(), 'retry-app-handled-no-such-home'), MIVO_WATCHER_PRAISEBUILD_APP_ID: '12345',
  MIVO_WATCHER_PRAISEBUILD_INSTALLATION_ID: '67890', MIVO_WATCHER_PRAISEBUILD_PRIVATE_KEY_PATH: '/virtual/app-key' };

const reviewer = { login: 'ExampleReviewer', __typename: 'User' };
const finding = (id, key = KEY) => ({ id, author: reviewer, createdAt: '2026-11-05T00:00:00Z',
  body: `[P1] 空值未处理\n\n<!-- mivo-finding key=${key} round=1 head=1111111 -->` });
const fixedReply = (id) => ({ id, author: { login: 'praisebuild', __typename: 'Bot' }, createdAt: '2026-11-05T00:30:00Z',
  body: `<!-- mivo-review:thread-fixed key=${KEY} head=${HEAD} -->` });
const threadOf = (id, comments, extra = {}) => ({ id, isResolved: false, isOutdated: false, path: 'src/a.mjs', comments, ...extra });
const fixedThread = (n = 1, extra = {}) => threadOf(`PRRT_${n}`, [finding(`PRRC_${n}a`), fixedReply(`PRRC_${n}b`)], extra);
const openThread = (n = 2) => threadOf(`PRRT_${n}`, [finding(`PRRC_${n}a`, 'ffffffffffff')]);

const listed = () => handoffPr({ repo: REPO, id: NODE, number: 900, headRefOid: HEAD, baseRefOid: BASE, state: 'OPEN', isDraft: false,
  author: { login: 'owner' }, releaseEpoch: 'e', headRefName: 'fix/y' });
const snapshot = (threads) => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: FIRST, mergeable: 'MERGEABLE',
  labels: [], checkState: 'SUCCESS', commentCount: 0, reviewCount: 0, commentUpdatedAt: null, reviewUpdatedAt: null,
  unresolvedThreads: threads.filter((thread) => !thread.isResolved).length });

// One PR home that keeps its state between polls, so a later poll sees the frozen task an earlier one left behind.
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-app-handled-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = watcherPaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const pr = listed();
  writePr(paths.home, NODE, { number: 900, nodeId: NODE, sessionId: 'sess-900', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: pr.releaseEpoch, handoff: handoffReceipt(pr), headRefName: 'fix/y', title: 'fix', repairRounds: 0 });
  const state = () => readPr(paths.home, NODE);
  const taskFile = (dispatchId) => path.join(paths.stateDir, 'tasks', `${dispatchId}.json`);
  const task = (dispatchId) => JSON.parse(fs.readFileSync(taskFile(dispatchId), 'utf8'));
  async function poll({ threads, now = FIRST, switchValue, appResolveFn, dispatchFn } = {}) {
    writePr(paths.home, NODE, { ...state(), pollFingerprint: 'stale' });
    const previousSwitch = process.env[SWITCH];
    if (switchValue === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = switchValue;
    const sent = [];
    try {
      const out = await scanOnceAsync({
        mode: 'poll', enabled: true, allowDispatch: true, paths, now, nodeId: NODE, prNumber: 900,
        snapshotFn: () => snapshot(threads),
        ghFn: (args) => (isChildPrList(args) ? '[[]]' : args[0] === 'api' ? 'owner' : '[]'),
        collect: (...args) => withAuthorHandoff({ pr, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, comments: [], reviews: [],
          threads, labels: [], mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: true, mergeReady: false,
          policy: { status: 'verified', required: [] } }, args[0]),
        dispatchFn: (params) => { sent.push(params); return dispatchFn ? dispatchFn(params) : { target_session_id: 'sess-900' }; },
        ownershipSnapshot: function* () { return { pr }; },
        ...(appResolveFn ? { appResolveFn } : {}),
      });
      return { out, report: out.prs[0], events: out.events ?? [], sent, entry: state() };
    } finally {
      if (previousSwitch === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = previousSwitch;
    }
  }
  // The first delivery: the host is not ready, so the task stays frozen as retryable with its real task file.
  async function freeze(threads) {
    const run = await poll({ threads, dispatchFn: () => { throw new Error('HOST_NOT_READY: companion is starting'); } });
    assert.equal(run.sent.length, 1, 'the first delivery was attempted');
    assert.equal(run.entry.pendingDispatch?.status, 'retryable');
    return run.entry.pendingDispatch;
  }
  return { poll, freeze, state, task, taskFile, paths, dir };
}

const spy = (answer) => { const log = []; const fn = (args) => { log.push(args); return answer; }; return Object.assign(fn, { log }); };
const keysIn = (message) => [...new Set([...message.matchAll(/"key":"([^"]+)"/g)].map((match) => match[1]))].sort();
const THREAD_1 = ['thread:PRRT_1:PRRC_1a', 'thread:PRRT_1:PRRC_1b'];
const THREAD_2 = ['thread:PRRT_2:PRRC_2a'];
const mentionsThread1 = (text) => /PRRT_1|PRRC_1/.test(text);

function github(plan = {}) {
  const fetchImpl = async (url) => {
    if (url.endsWith('/access_tokens')) return plan.mint?.() ?? { status: 201, json: async () => ({ token: TOKEN }) };
    if (url.endsWith('/graphql')) return { status: 200, json: async () => ({ data: { resolveReviewThread: { thread: { id: 'x', isResolved: true } } } }) };
    return { status: 204 };
  };
  return (args) => resolveThreadsWithApp({ ...args, env: APP_ENV, fetchImpl, readFile: () => KEY_PEM });
}

test('SC1 switch on: a frozen task is retried without the thread the App closed this round; the other feedback goes out as before', async (t) => {
  const w = world(t);
  const frozen = await w.freeze([fixedThread(1), openThread(2)]);
  assert.deepEqual(keysIn(frozen.params.message), [...THREAD_1, ...THREAD_2], 'the frozen message carried both threads');
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  const run = await w.poll({ threads: [fixedThread(1), openThread(2)], now: DUE, switchValue: '1', appResolveFn: asked });
  assert.deepEqual(asked.log, [{ threadIds: ['PRRT_1'], repo: REPO }]);
  assert.equal(run.sent.length, 1, 'the retry still goes out for the remaining feedback');
  const [params] = run.sent;
  assert.deepEqual(keysIn(params.message), THREAD_2);
  assert.ok(!mentionsThread1(params.message), 'nothing of the closed thread is left anywhere in the message');
  assert.match(params.message, /^fresh=1$/m);
  assert.equal(params.target_session_id, 'sess-900');
  const task = w.task(frozen.dispatchId);
  assert.deepEqual(task.feedback.map((item) => item.key), THREAD_2, 'the task file the session reads is cut too');
  assert.deepEqual(task.repairPolicy.items.map((item) => item.key), THREAD_2);
  assert.ok(!mentionsThread1(JSON.stringify(task.repairPolicy)) && !mentionsThread1(JSON.stringify(task.params)));
  assert.equal(run.report.dispatch.reason, 'confirmed-nondelivery-retry');
  assert.equal(run.entry.pendingDispatch, null);
  assert.equal(run.entry.activeTask.dispatchId, frozen.dispatchId, 'same dispatch, so the Keel run and the helper paths stay valid');
  assert.deepEqual(run.events.filter((event) => event.kind === 'retry-feedback-claimed-by-app'),
    [{ kind: 'retry-feedback-claimed-by-app', number: 900, dispatchId: frozen.dispatchId, threadIds: ['PRRT_1'], remaining: 1 }]);
});

test('SC1 a thread the App closed in an earlier round (retry not yet due) is cut as well', async (t) => {
  const w = world(t);
  const frozen = await w.freeze([fixedThread(1), openThread(2)]);
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  const early = await w.poll({ threads: [fixedThread(1), openThread(2)], now: NOT_DUE, switchValue: '1', appResolveFn: asked });
  assert.equal(early.sent.length, 0, 'the retry is not due yet');
  assert.equal(early.entry.autoClosedThreads.PRRT_1.reason, 'server-review-fixed');
  const run = await w.poll({ threads: [fixedThread(1, { isResolved: true }), openThread(2)], now: DUE, switchValue: '1', appResolveFn: asked });
  assert.equal(asked.log.length, 1, 'the App is not asked again');
  assert.equal(run.sent.length, 1);
  assert.deepEqual(keysIn(run.sent[0].message), THREAD_2);
  assert.ok(!mentionsThread1(run.sent[0].message));
  assert.deepEqual(w.task(frozen.dispatchId).feedback.map((item) => item.key), THREAD_2);
});

test('SC1 a thread the App path took but failed to resolve is not given to the session either, and its cursor stays unmarked', async (t) => {
  const w = world(t);
  await w.freeze([fixedThread(1), openThread(2)]);
  const run = await w.poll({ threads: [fixedThread(1), openThread(2)], now: DUE, switchValue: '1',
    appResolveFn: github({ mint: () => ({ status: 422, json: async () => ({}) }) }) });
  assert.equal(run.sent.length, 1);
  assert.deepEqual(keysIn(run.sent[0].message), THREAD_2, 'same as a new delivery: the App path owns the thread while the switch is on');
  const cursor = Object.keys(run.entry.feedbackCursor ?? {});
  assert.ok(cursor.some((key) => key.includes('PRRT_2')), 'the delivered thread is marked');
  assert.ok(!cursor.some((key) => key.includes('PRRT_1')), 'the held thread is not, so a build with the switch off still delivers it');
});

test('SC2 switch on, every frozen feedback taken by the App: no retry, the pending dispatch is cleared, no session is woken', async (t) => {
  const w = world(t);
  const frozen = await w.freeze([fixedThread(1)]);
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  const run = await w.poll({ threads: [fixedThread(1)], now: DUE, switchValue: '1', appResolveFn: asked });
  assert.equal(run.sent.length, 0, 'the repair session is not woken');
  assert.equal(run.entry.pendingDispatch, null);
  assert.equal(run.entry.dispatchError ?? null, null);
  assert.deepEqual(run.report.dispatch, { attempted: false, bound: false, reason: 'retry-feedback-claimed-by-app' });
  assert.deepEqual(run.report.autoClosed.map((item) => item.threadId), ['PRRT_1'], 'the round still reports what the App closed');
  assert.ok(run.entry.abandonedDispatches.includes(frozen.dispatchId));
  assert.equal(run.entry.activeTask, undefined, 'no task became active');
  const later = await w.poll({ threads: [fixedThread(1, { isResolved: true })], now: '2026-11-05T01:12:00.000Z', switchValue: '1', appResolveFn: asked });
  assert.equal(later.sent.length, 0, 'and it does not come back on the next round');
  assert.equal(later.entry.pendingDispatch, null);
});

test('SC3 switch off: the retry is exactly the frozen message with the recomputed policy, and the task file is untouched', async (t) => {
  const w = world(t);
  const frozen = await w.freeze([fixedThread(1), openThread(2)]);
  const taskBefore = fs.readFileSync(w.taskFile(frozen.dispatchId), 'utf8');
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  const run = await w.poll({ threads: [fixedThread(1), openThread(2)], now: DUE, appResolveFn: asked });
  assert.equal(asked.log.length, 0, 'the App is never asked');
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0].message, constrainRetryDispatch({ ...frozen.params, title: run.sent[0].title }, JSON.parse(taskBefore)).message);
  assert.deepEqual(keysIn(run.sent[0].message), [...THREAD_1, ...THREAD_2]);
  assert.equal(fs.readFileSync(w.taskFile(frozen.dispatchId), 'utf8'), taskBefore);
  assert.equal(run.report.dispatch.reason, 'confirmed-nondelivery-retry');
  assert.equal(run.events.filter((event) => event.kind === 'retry-feedback-claimed-by-app').length, 0);
});

test('SC3 switch off with an App receipt left from an earlier switch-on period: still the whole frozen task', async (t) => {
  const w = world(t);
  const frozen = await w.freeze([fixedThread(1), openThread(2)]);
  const taskBefore = fs.readFileSync(w.taskFile(frozen.dispatchId), 'utf8');
  writePr(w.paths.home, NODE, { ...w.state(), autoClosedThreads: { PRRT_1: { at: FIRST, key: KEY, reason: 'server-review-fixed', head: HEAD, commentId: 'PRRC_1b' } } });
  const run = await w.poll({ threads: [fixedThread(1, { isResolved: true }), openThread(2)], now: DUE });
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0].message, constrainRetryDispatch({ ...frozen.params, title: run.sent[0].title }, JSON.parse(taskBefore)).message);
  assert.equal(fs.readFileSync(w.taskFile(frozen.dispatchId), 'utf8'), taskBefore);
});

test('switch on but the App took none of the frozen threads: the retry is exactly the frozen message', async (t) => {
  const w = world(t);
  const frozen = await w.freeze([openThread(2)]);
  const taskBefore = fs.readFileSync(w.taskFile(frozen.dispatchId), 'utf8');
  const run = await w.poll({ threads: [openThread(2), fixedThread(1)], now: DUE, switchValue: '1', appResolveFn: spy({ resolved: ['PRRT_1'], failures: [] }) });
  assert.equal(run.sent.length, 1);
  assert.equal(run.sent[0].message, constrainRetryDispatch({ ...frozen.params, title: run.sent[0].title }, JSON.parse(taskBefore)).message);
  assert.equal(fs.readFileSync(w.taskFile(frozen.dispatchId), 'utf8'), taskBefore);
});

test('a retry of a missing-result recovery is left alone: it re-sends a task the session already holds', async (t) => {
  const w = world(t);
  const frozen = await w.freeze([fixedThread(1), openThread(2)]);
  writePr(w.paths.home, NODE, { ...w.state(), pendingDispatch: { ...w.state().pendingDispatch, recovery: true } });
  const run = await w.poll({ threads: [fixedThread(1), openThread(2)], now: DUE, switchValue: '1', appResolveFn: spy({ resolved: ['PRRT_1'], failures: [] }) });
  assert.equal(run.sent.length, 1);
  assert.deepEqual(keysIn(run.sent[0].message), [...THREAD_1, ...THREAD_2]);
  assert.equal(w.task(frozen.dispatchId).feedback.length, 3);
});

test('#397 the feedback fingerprint follows the task file: recorded at dispatch, renewed when a retry cuts feedback, kept on bind', async (t) => {
  const w = world(t);
  const frozen = await w.freeze([fixedThread(1), openThread(2)]);
  assert.equal(frozen.feedbackDigest, taskFeedbackDigest(w.task(frozen.dispatchId).feedback), 'recorded with the first delivery');
  const run = await w.poll({ threads: [fixedThread(1), openThread(2)], now: DUE, switchValue: '1',
    appResolveFn: spy({ resolved: ['PRRT_1'], failures: [] }) });
  const cut = w.task(frozen.dispatchId).feedback;
  assert.deepEqual(cut.map((item) => item.key), THREAD_2);
  assert.notEqual(run.entry.activeTask.feedbackDigest, frozen.feedbackDigest, 'the cut task has a new fingerprint');
  assert.equal(run.entry.activeTask.feedbackDigest, taskFeedbackDigest(cut), 'the bound task carries the fingerprint of the file the session reads');
});

