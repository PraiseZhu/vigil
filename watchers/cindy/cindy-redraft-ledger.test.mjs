import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as watcher from './bin/cindy-watcher.mjs';
import { pendingEvents } from './bin/notify.mjs';
import { readPr, writePr } from './bin/cindy-state.mjs';

// Draft -> Ready used to forget every feedback key, so rounds the watcher had already judged "no change"
// were delivered again, and missing-result-limit had no way out. Fixtures use placeholder ids only; new
// symbols are read off the module namespace so a missing export fails one test, not the file.
const { feedbackItems, newFeedback, pollFingerprint, scanOnce, watcherPaths } = watcher;
const NODE = 'PR_790';
const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'c'.repeat(40);
const BASE = 'b'.repeat(40);
const NOW = '2026-10-20T12:00:00.000Z';
const OLD_TASK = 'live-790-2026-10-20T08:00:00.000Z';
const COMMENT = { id: 101, body: 'P1: example finding', user: { login: 'ExampleReviewer', type: 'User' }, updated_at: '2026-10-20T07:00:00Z' };
const EDITED = { ...COMMENT, body: 'P1: example finding, reworded', updated_at: '2026-10-20T11:00:00Z' };
const FAILED_CI = { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] };

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redraft-ledger-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  return dir;
}
const listed = (head = HEAD) => ({ id: NODE, number: 790, state: 'OPEN', isDraft: false, author: { login: 'owner' },
  headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: head, baseRefOid: BASE,
  releaseEpoch: 'e', isCrossRepository: true, headRefName: 'fix/x' });
const snapOf = (head = HEAD) => ({
  state: 'OPEN', isDraft: false, headRefOid: head, baseRefOid: BASE, updatedAt: NOW, mergeable: 'MERGEABLE',
  labels: [], checkState: 'SUCCESS', commentCount: 1, reviewCount: 0, commentUpdatedAt: NOW, reviewUpdatedAt: null, unresolvedThreads: 0,
});
function cursorFor({ comments = [COMMENT], ci = { status: 'green', required: [] }, head = HEAD } = {}) {
  return newFeedback({}, feedbackItems({ pr: { headRefOid: head }, comments, ci, receiptActor: 'owner' })).cursor;
}

// One poll of a PR whose state is `entry`; GitHub now shows `comments` / `ci` on `head`.
function poll(t, { entry, comments = [COMMENT], ci = { status: 'green', required: [] }, head = HEAD, now = NOW, prepare } = {}) {
  const paths = watcherPaths(home(t));
  fs.mkdirSync(paths.stateDir, { recursive: true });
  prepare?.(paths);
  const pr = listed(head);
  writePr(paths.home, NODE, {
    number: 790, nodeId: NODE, sessionId: 'sess-790', eligibilityInitialized: true, eligibility: 'active', admissionVerified: true,
    admissionEpoch: pr.releaseEpoch, headRefName: 'fix/x', title: 'fix',
    pollFingerprint: 'stale', repairRounds: 1, ...entry,
  });
  const sent = [];
  const outcome = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now, nodeId: NODE, prNumber: 790,
    snapshotFn: () => snapOf(head),
    ghFn: (args) => args[0] === 'api' ? 'owner' : '[]',
    collect: () => ({ pr, checks: [], requiredChecks: [], ci, comments, reviews: [], threads: [], labels: [],
      mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: ci.status === 'green', mergeReady: false,
      policy: { status: 'verified', required: [] } }),
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-790' }; },
    ownershipSnapshot: function* () { return { pr }; },
  });
  return { outcome, sent, paths, entry: readPr(paths.home, NODE) };
}
const ledgerOf = (cursor, extra = {}) => Object.fromEntries(Object.entries(cursor).map(([key, stamp]) =>
  [key, { stamp, disposition: 'no-change', resultHead: HEAD, dispatchId: OLD_TASK, ...extra }]));
const redrafted = (extra = {}) => ({ wasDraft: true, admissionVerified: false, admissionEpoch: null,
  activeTask: { dispatchId: OLD_TASK, status: 'complete', head: HEAD }, ...extra });

// ---- SC-1 / SC-2 / SC-3: what a Draft -> Ready round may forget ----

test('Draft -> Ready: feedback a finished round judged "no change" and whose content is unchanged is not delivered again', t => {
  const cursor = cursorFor();
  assert.deepEqual(Object.keys(cursor), ['comment:101']);
  const { sent, outcome } = poll(t, { entry: redrafted({ feedbackCursor: cursor, feedbackLedger: ledgerOf(cursor) }) });
  assert.equal(outcome.prs[0].fresh, 0);
  assert.equal(sent.length, 0);
});

test('Draft -> Ready: a ledger entry judged "fixed" is still delivered again (first version stays conservative)', t => {
  const cursor = cursorFor();
  const { sent, outcome } = poll(t, { entry: redrafted({ feedbackCursor: cursor, feedbackLedger: ledgerOf(cursor, { disposition: 'fixed' }) }) });
  assert.equal(outcome.prs[0].fresh, 1);
  assert.equal(sent.length, 1);
});

test('Draft -> Ready: edited content is delivered again even though the ledger says "no change" for the old words', t => {
  const cursor = cursorFor();
  const { sent, outcome } = poll(t, { comments: [EDITED], entry: redrafted({ feedbackCursor: cursor, feedbackLedger: ledgerOf(cursor) }) });
  assert.equal(outcome.prs[0].fresh, 1);
  assert.equal(sent.length, 1);
});

test('Draft -> Ready: a CI failure on a new head is delivered again even though the old head was judged "no change"', t => {
  const old = cursorFor({ ci: FAILED_CI });
  const ciKey = Object.keys(old).find((key) => key.startsWith('ci:'));
  assert.ok(ciKey, 'fixture must produce a ci feedback key');
  const { sent, outcome } = poll(t, { ci: FAILED_CI, head: NEXT_HEAD, comments: [],
    entry: redrafted({ headRefOid: HEAD, feedbackCursor: { [ciKey]: old[ciKey] }, feedbackLedger: ledgerOf({ [ciKey]: old[ciKey] }) }) });
  assert.equal(outcome.prs[0].fresh, 1);
  assert.equal(sent.length, 1);
});

test('Draft -> Ready: a task the author took back (revoked) delivers its feedback again', t => {
  const cursor = cursorFor();
  const { sent, outcome } = poll(t, { entry: redrafted({ feedbackCursor: cursor,
    activeTask: { dispatchId: OLD_TASK, status: 'blocked', blockedKind: 'author-reclaimed', head: HEAD },
    authorReclaimed: { at: NOW, dispatchId: OLD_TASK } }) });
  assert.equal(outcome.prs[0].fresh, 1);
  assert.equal(sent.length, 1);
});

test('Draft -> Ready: a blocked round without coverage delivers its feedback again', t => {
  const cursor = cursorFor();
  const { sent, outcome } = poll(t, { entry: redrafted({ feedbackCursor: cursor, eligibility: 'blocked',
    activeTask: { dispatchId: OLD_TASK, status: 'blocked', blockedKind: 'external', reason: 'needs a human decision', head: HEAD } }) });
  assert.equal(outcome.prs[0].fresh, 1);
  assert.equal(sent.length, 1);
});

test('a ledger entry for a key whose in-flight delivery is newer than the ledger does not suppress it', t => {
  const cursor = cursorFor();
  const stale = ledgerOf({ 'comment:101': 'older-stamp' });
  const { outcome } = poll(t, { entry: redrafted({ feedbackCursor: cursor, feedbackLedger: stale }) });
  assert.equal(outcome.prs[0].fresh, 1);
});

test('consumeResult records every covered key of a finished round in the coverage ledger', () => {
  assert.equal(typeof watcher.consumeResult, 'function');
  const cursor = cursorFor();
  const previous = { feedbackCursor: cursor, activeTask: { dispatchId: OLD_TASK, status: 'accepted' } };
  const result = { schemaVersion: 2, dispatchId: OLD_TASK, sessionId: 'sess-790', status: 'waiting-ci', head: HEAD,
    feedbackCoverage: { dispositions: [{ key: 'comment:101', disposition: 'no-change' }] } };
  const out = watcher.consumeResult(previous, result, NOW);
  assert.deepEqual(out.feedbackLedger['comment:101'],
    { stamp: cursor['comment:101'], disposition: 'no-change', resultHead: HEAD, dispatchId: OLD_TASK });
  const blocked = watcher.consumeResult(previous, { ...result, status: 'blocked', reason: 'x' }, NOW);
  assert.equal(blocked.feedbackLedger?.['comment:101'], undefined, 'a blocked round covered nothing');
});

// ---- SC-4: missing-result-limit leaves its terminal state by itself ----

const limited = (extra = {}) => ({ eligibility: 'blocked', feedbackCursor: cursorFor(),
  lastDispatch: { dispatchId: OLD_TASK, at: '2026-10-20T08:00:00.000Z', recoveryCount: 3 },
  missingResult: { head: HEAD, ci: 'green', at: '2026-10-20T10:00:00.000Z' },
  activeTask: { dispatchId: OLD_TASK, status: 'blocked', blockedKind: 'missing-result-limit', head: HEAD,
    reason: 'No result after three bounded recovery deliveries; inspect the existing session before resuming.' }, ...extra });
const NEW_COMMENT = { id: 202, body: 'P1: another finding', user: { login: 'ExampleReviewer', type: 'User' }, updated_at: '2026-10-20T11:30:00Z' };

test('missing-result-limit + new feedback: the PR leaves the terminal state and the new feedback is delivered', t => {
  const { sent, entry } = poll(t, { comments: [COMMENT, NEW_COMMENT], entry: limited() });
  assert.equal(sent.length, 1);
  assert.notEqual(entry.activeTask.blockedKind, 'missing-result-limit');
});

test('missing-result-limit + a new head with a CI failure: the PR leaves the terminal state and is delivered', t => {
  const { sent } = poll(t, { comments: [COMMENT], ci: FAILED_CI, head: NEXT_HEAD, entry: limited({ headRefOid: HEAD }) });
  assert.equal(sent.length, 1);
});

test('missing-result-limit with nothing changed stays terminal and sends nothing', t => {
  const { sent, entry } = poll(t, { entry: limited() });
  assert.equal(sent.length, 0);
  assert.equal(entry.activeTask.blockedKind, 'missing-result-limit');
});

test('missing-result-limit resets at most three times per admission epoch, then keeps the terminal state and says so', t => {
  const resets = [1, 2, 3].map((n) => ({ dispatchId: `live-790-earlier-${n}`, epoch: listed().releaseEpoch, at: NOW }));
  const { sent, entry, paths } = poll(t, { comments: [COMMENT, NEW_COMMENT], entry: limited({ missingResultResets: resets }) });
  assert.equal(sent.length, 0);
  assert.equal(entry.activeTask.blockedKind, 'missing-result-limit');
  assert.ok(pendingEvents(paths.home).some((event) => event.kind === 'missing-result-reset-limit' && event.number === 790));
});

test('missing-result-limit resets recorded in an earlier admission epoch do not count', t => {
  const resets = [1, 2, 3].map((n) => ({ dispatchId: `live-790-earlier-${n}`, epoch: 'ready:PR_790:old:2026-09-01T00:00:00Z', at: NOW }));
  const { sent } = poll(t, { comments: [COMMENT, NEW_COMMENT], entry: limited({ missingResultResets: resets }) });
  assert.equal(sent.length, 1);
});

// ---- the dead task's feedback comes back with the reset (nothing it was handed may be silently dropped) ----

const deadTask = (keys) => (paths) => {
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${OLD_TASK}.json`), JSON.stringify({
    dispatchId: OLD_TASK, nodeId: NODE, number: 790, feedback: keys.map((key) => ({ key })) }));
};
const newTaskKeys = (paths) => {
  const dir = path.join(paths.stateDir, 'tasks');
  const files = fs.readdirSync(dir).filter((name) => name !== `${OLD_TASK}.json`);
  assert.equal(files.length, 1, 'exactly one new task is written');
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8')).feedback.map((item) => item.key).sort();
};

test('missing-result-limit reset delivers the dead task\'s feedback together with the new feedback', t => {
  const { sent, paths } = poll(t, { comments: [COMMENT, NEW_COMMENT], prepare: deadTask(['comment:101']), entry: limited() });
  assert.equal(sent.length, 1);
  assert.deepEqual(newTaskKeys(paths), ['comment:101', 'comment:202']);
});

test('missing-result-limit reset on a new head alone still delivers what the dead task was handed', t => {
  const { sent, paths } = poll(t, { comments: [COMMENT], head: NEXT_HEAD, prepare: deadTask(['comment:101']), entry: limited({ headRefOid: HEAD }) });
  assert.equal(sent.length, 1);
  assert.deepEqual(newTaskKeys(paths), ['comment:101']);
});

test('reaching missing-result-limit and resetting in one scan still writes the limit notice and delivers both', t => {
  const { sent, paths, entry } = poll(t, { comments: [COMMENT, NEW_COMMENT], prepare: deadTask(['comment:101']),
    entry: { eligibility: 'active', feedbackCursor: cursorFor(),
      lastDispatch: { dispatchId: OLD_TASK, at: '2026-10-20T08:00:00.000Z', recoveryCount: 3 },
      activeTask: { dispatchId: OLD_TASK, status: 'accepted', head: HEAD } } });
  assert.ok(pendingEvents(paths.home).some((event) => event.kind === 'missing-result-limit' && event.number === 790),
    'the person is still told that the session returned nothing');
  assert.equal(sent.length, 1);
  assert.deepEqual(newTaskKeys(paths), ['comment:101', 'comment:202']);
  assert.equal(entry.missingResultResets.length, 1);
});
