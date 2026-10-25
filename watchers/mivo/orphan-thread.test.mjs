import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';
import * as watcher from './bin/mivo-watcher.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';

// A bot review thread was delivered to a round that blocked before pushing; the next round was dispatched for
// newer feedback only and superseded it. The cursor said "delivered", the ledger held no judgement, and nothing
// handed the thread back: it stayed open and held the review check. Fixtures use placeholder ids only.
const { feedbackItems, newFeedback, scanOnce, watcherPaths } = watcher;
const REPO = process.env.MIVO_WATCHER_TARGET_REPO;
const NODE = 'PR_791';
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const NOW = '2026-10-25T01:00:00.000Z';
const OLD_TASK = 'live-791-2026-10-24T11:00:00.000Z';
const LAST_TASK = 'live-791-2026-10-24T23:30:00.000Z';

const botThread = (extra = {}) => ({ id: 'PRRT_bot1', isResolved: false, isOutdated: false, path: 'src/a.mjs',
  comments: [{ id: 'PRRC_bot1', author: { login: 'greptile-apps', __typename: 'Bot' }, body: 'P1: stale failure reopens early',
    createdAt: '2026-10-24T10:30:00Z' }], ...extra });
const memberThread = () => ({ id: 'PRRT_member1', isResolved: false, isOutdated: false, path: 'src/a.mjs',
  comments: [{ id: 'PRRC_member1', author: { login: 'ExampleReviewer', __typename: 'User' }, authorAssociation: 'MEMBER',
    body: 'please rename', createdAt: '2026-10-24T10:30:00Z' }] });

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-thread-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}
const listed = (head = HEAD) => handoffPr({ repo: REPO, id: NODE, number: 791, headRefOid: head, baseRefOid: BASE, state: 'OPEN',
  isDraft: false, author: { login: 'owner' }, releaseEpoch: 'e', headRefName: 'fix/y' });
const snapOf = (head, threads) => ({
  state: 'OPEN', isDraft: false, headRefOid: head, baseRefOid: BASE, updatedAt: NOW, mergeable: 'MERGEABLE',
  labels: [], checkState: 'SUCCESS', commentCount: 0, reviewCount: 0, commentUpdatedAt: null, reviewUpdatedAt: null,
  unresolvedThreads: threads.filter((thread) => !thread.isResolved).length,
});
// The cursor a round delivering `threads` on `head` leaves behind.
const cursorFor = (threads, head = HEAD) => newFeedback({}, feedbackItems({ pr: { headRefOid: head }, threads, ci: { status: 'green', required: [] },
  receiptActor: 'owner' })).cursor;
const writeTask = (paths, dispatchId, keys) => {
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId: NODE, number: 791, feedback: keys.map((key) => ({ key })) }));
};
const newTaskKeys = (paths, known) => {
  const files = fs.readdirSync(path.join(paths.stateDir, 'tasks')).filter((name) => !known.includes(name.replace(/\.json$/, '')));
  assert.equal(files.length, 1, 'exactly one new task is written');
  return JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'tasks', files[0]), 'utf8')).feedback.map((item) => item.key).sort();
};

function poll(t, { entry, threads = [botThread()], head = HEAD, tasks = {} } = {}) {
  const paths = watcherPaths(home(t));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  for (const [dispatchId, keys] of Object.entries(tasks)) writeTask(paths, dispatchId, keys);
  const pr = listed(head);
  writePr(paths.home, NODE, {
    number: 791, nodeId: NODE, sessionId: 'sess-791', eligibilityInitialized: true, eligibility: 'active', admissionVerified: true,
    admissionEpoch: pr.releaseEpoch, handoff: handoffReceipt(pr), headRefName: 'fix/y', title: 'fix',
    pollFingerprint: 'stale', repairRounds: 3, ...entry,
  });
  const sent = [];
  const outcome = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now: NOW, nodeId: NODE, prNumber: 791,
    snapshotFn: () => snapOf(head, threads),
    ghFn: (args) => args[0] === 'api' ? 'owner' : '[]',
    collect: (...args) => withAuthorHandoff({ pr, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, comments: [],
      reviews: [], threads, labels: [], mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: true, mergeReady: false,
      policy: { status: 'verified', required: [] } }, args[0]),
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-791' }; },
    ownershipSnapshot: function* () { return { pr }; },
  });
  return { outcome, sent, paths, entry: readPr(paths.home, NODE) };
}

const botKey = () => Object.keys(cursorFor([botThread()]))[0];
// The round after the superseding one finished: the bot thread is still open, delivered, and never judged.
const afterSupersede = (extra = {}) => ({ feedbackCursor: cursorFor([botThread()]),
  activeTask: { dispatchId: LAST_TASK, status: 'complete', head: HEAD }, ...extra });

test('a delivered but never judged bot thread whose task was superseded is delivered again', t => {
  assert.match(botKey(), /^greptile:PRRT_bot1:/);
  const { sent, paths, entry } = poll(t, { entry: afterSupersede(), tasks: { [OLD_TASK]: [botKey()], [LAST_TASK]: ['mivo-review:other'] } });
  assert.equal(sent.length, 1);
  assert.deepEqual(newTaskKeys(paths, [OLD_TASK, LAST_TASK]), [botKey()]);
  assert.ok(entry.orphanRedelivery?.[botKey()], 'the redelivery is remembered');
});

test('the same orphaned thread is handed back once per head', t => {
  const stamp = cursorFor([botThread()])[botKey()];
  const once = { [botKey()]: `${stamp}@${HEAD}` };
  assert.equal(poll(t, { entry: afterSupersede({ orphanRedelivery: once }) }).sent.length, 0);
  assert.equal(poll(t, { head: NEXT_HEAD, entry: afterSupersede({ orphanRedelivery: once, headRefOid: HEAD }) }).sent.length, 1,
    'a new head may hand it back again');
});

test('a bot thread the ledger judged under the same stamp is not handed back', t => {
  const cursor = cursorFor([botThread()]);
  const ledger = { [botKey()]: { stamp: cursor[botKey()], disposition: 'no-change', resultHead: HEAD, dispatchId: LAST_TASK } };
  assert.equal(poll(t, { entry: afterSupersede({ feedbackLedger: ledger }) }).sent.length, 0);
});

test('a resolved bot thread is not handed back', t => {
  const resolved = botThread({ isResolved: true });
  const { sent, outcome } = poll(t, { threads: [resolved], entry: afterSupersede({ feedbackCursor: cursorFor([resolved]) }) });
  assert.equal(sent.length, 0);
  assert.equal(outcome.prs[0].fresh, 0);
});

test('a member thread is left to the person and not handed back', t => {
  assert.equal(poll(t, { threads: [memberThread()], entry: afterSupersede({ feedbackCursor: cursorFor([memberThread()]) }) }).sent.length, 0);
});

test('a bot thread held by the current blocked task is left to the blocked-task reopen paths', t => {
  const { sent, outcome } = poll(t, { tasks: { [OLD_TASK]: [botKey()] }, entry: afterSupersede({ eligibility: 'blocked',
    activeTask: { dispatchId: OLD_TASK, status: 'blocked', blockedKind: 'external', reason: 'pre-push failed', head: HEAD } }) });
  assert.equal(sent.length, 0);
  assert.equal(outcome.prs[0].fresh, 0, 'not counted as new feedback either');
});

test('nothing is handed back while a task is still running', t => {
  const { sent, outcome } = poll(t, { tasks: { [LAST_TASK]: ['mivo-review:other'] }, entry: afterSupersede({
    activeTask: { dispatchId: LAST_TASK, status: 'accepted', head: HEAD }, lastDispatch: { dispatchId: LAST_TASK, at: NOW, recoveryCount: 0 } }) });
  assert.equal(sent.length, 0);
  assert.equal(outcome.prs[0].fresh, 0, 'not counted as new feedback either');
});

test('a bot thread already queued for closing is not handed back', t => {
  const { sent, outcome } = poll(t, { entry: afterSupersede({ pendingThreadClose: [{ threadId: 'PRRT_bot1', dispatchId: LAST_TASK, head: HEAD }] }) });
  assert.equal(sent.length, 0);
  assert.equal(outcome.prs[0].fresh, 0);
});
