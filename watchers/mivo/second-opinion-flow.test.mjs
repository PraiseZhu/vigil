// A session that stops with "I cannot solve this" gets the same feedback back once, with its own reason and the order
// to put it to an arbiter first; nobody is notified. The second stop on the same head is reported as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blocked } from './bin/mivo-repair.mjs';
import { REPO, scanOnce, watcherPaths, feedbackItems, newFeedback } from './bin/mivo-watcher.mjs';
import { pendingEvents } from './bin/notify.mjs';
import { statePaths, writePr } from './bin/mivo-state.mjs';
import { handoffReceipt, isChildPrList } from './handoff.fixture.mjs';


const A = 'a'.repeat(40);
const BASE = 'c'.repeat(40);
const RELEASE = 'opened:PR_790:2026-11-01T00:00:00Z';
const nodeId = 'PR_790';
const number = 790;
const REASON = '需要维护者决定：这条意见要求改动的接口在另一个仓库，本会话没有那个仓库的写权限。';

function world(t) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-second-opinion-'));
  t.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
  const handoff = { version: 1, id: 'handoff-fixture', repo: REPO, number, nodeId, head: A, releaseEpoch: RELEASE, author: 'owner' };
  // The delivered feedback carries the stamp the watcher itself computes: without the hand-back the same comment is
  // not new, so a dispatch in this test can only come from the hand-back.
  const comment = { id: 501, body: 'Please investigate this behavior.', author: { login: 'ExampleReviewer' }, user: { login: 'ExampleReviewer' },
    authorAssociation: 'NONE', created_at: '2026-11-11T09:00:00Z', updated_at: '2026-11-11T09:00:00Z' };
  const delivered = newFeedback({}, feedbackItems({ pr: { headRefOid: A }, comments: [comment], receiptActor: 'owner' }));
  const feedback = delivered.fresh[0];
  const paths = watcherPaths(HOME);
  const v2 = statePaths(HOME);
  fs.mkdirSync(v2.prsDir, { recursive: true });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(v2.indexPath, JSON.stringify({ version: 2, migratedAt: '2026-11-11T10:00:00.000Z' }));
  const url = 'https://example.invalid/pull/790';
  writePr(HOME, nodeId, {
    number, nodeId, url, sessionId: 'session-old', headRefOid: A, headRefName: 'fix/x', eligibility: 'active', eligibilityInitialized: true,
    admissionVerified: true, admissionEpoch: RELEASE, roundsEpoch: RELEASE, repairRounds: 2, handoff, trustedHead: { handoffId: handoff.id, head: A }, wasDraft: false,
    feedbackCursor: delivered.cursor,
    activeTask: { dispatchId: 'live-790', status: 'accepted', head: A, at: '2026-11-11T10:00:00.000Z', observedAt: '2026-11-11T10:00:00.000Z' },
  });
  const taskPathOf = (dispatchId) => path.join(paths.stateDir, 'tasks', `${dispatchId}.json`);
  fs.writeFileSync(taskPathOf('live-790'), JSON.stringify({ dispatchId: 'live-790', nodeId, number, repo: REPO, sessionId: 'session-old',
    headRefOid: A, headRefName: 'fix/x', releaseEpoch: RELEASE, handoff, feedback: [feedback] }));
  const view = { id: nodeId, number, title: 'fixture', body: '', url, state: 'OPEN', isDraft: false, headRefOid: A, headRefName: 'fix/x', baseRefOid: BASE,
    baseRefName: 'feature-base', createdAt: '2026-11-01T00:00:00Z', author: { login: 'owner' }, isCrossRepository: false, mergeable: 'MERGEABLE', reviewDecision: null };
  const repairGh = (_bin, args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(view);
    throw new Error(`unexpected helper gh call: ${args.join(' ')}`);
  };
  const collected = {
    pr: { ...view, repo: REPO, sameRepository: true, releaseEpoch: RELEASE },
    handoff: handoffReceipt({ ...view, repo: REPO, sameRepository: true, releaseEpoch: RELEASE }),
    comments: [comment],
    reviews: [], threads: [], labels: [], ci: { status: 'green', required: [], checks: [] },
    admissionVerified: true, admissionReason: 'fixture', mergeReady: false, mergeable: 'MERGEABLE',
  };
  const listed = { id: nodeId, number, headRefOid: A, headRefName: 'fix/x', isDraft: false, labels: [], url, updatedAt: '2026-11-11T10:00:00.000Z', title: 'fixture' };
  const ghFn = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([listed]);
    if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('search('))) return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: nodeId, state: 'OPEN' });
    if (isChildPrList(args)) return '[[]]';
    if (args[0] === 'api' && String(args[1]).includes('/rules/branches/')) return '[[]]';
    throw new Error(`unexpected watcher gh call: ${args.join(' ')}`);
  };
  const sent = [];
  let failure = null;
  const failNext = (message) => { failure = message; };
  const scan = (now) => scanOnce({
    enabled: true, allowDispatch: true, paths, now, ghFn, collect: () => collected,
    ownershipSnapshot: function* () { return { pr: collected.pr }; },
    dispatchFn: (params) => {
      if (failure) { const message = failure; failure = null; throw new Error(message); }
      sent.push(params); return { target_session_id: params.target_session_id ?? 'session-new' };
    },
    keelRoot: os.tmpdir(),
  });
  const tasks = () => fs.readdirSync(path.join(paths.stateDir, 'tasks')).map((name) => JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'tasks', name), 'utf8')));
  return { HOME, paths, repairGh, taskPathOf, scan, sent, tasks, collected, failNext };
}

test('helper to watcher: the first external block is handed back with its reason and no notice; the second one on the same head is reported', (t) => {
  const w = world(t);
  assert.equal(blocked({ home: w.HOME, taskPath: w.taskPathOf('live-790'), reason: REASON, ghFn: w.repairGh }).blockedKind, 'external');

  w.scan('2026-11-11T10:01:00.000Z');
  assert.equal(w.sent.length, 1, 'the same feedback goes out again');
  const message = JSON.stringify(w.sent[0]);
  assert.match(message, /先裁决再继续/);
  assert.ok(message.includes('另一个仓库'), 'the handed-back round is told why the last one stopped');
  assert.deepEqual(pendingEvents(w.HOME).filter((event) => event.kind === 'blocked-escalate'), []);

  const second = w.tasks().find((task) => task.dispatchId !== 'live-790');
  assert.deepEqual(second.feedback.map((item) => item.key), ['comment:501']);
  blocked({ home: w.HOME, taskPath: w.taskPathOf(second.dispatchId), reason: `裁决确认需要人：${REASON}`, ghFn: w.repairGh });
  w.scan('2026-11-11T10:41:00.000Z');
  assert.equal(w.sent.length, 1, 'no third round on the same head');
  const notices = pendingEvents(w.HOME).filter((event) => event.kind === 'blocked-escalate');
  assert.equal(notices.length, 1);
  assert.match(notices[0].cause, /裁决确认需要人/);
});

test('helper to watcher: nothing to send for the second opinion → the block is reported in that same round and never handed back later', (t) => {
  const w = world(t);
  blocked({ home: w.HOME, taskPath: w.taskPathOf('live-790'), reason: REASON, ghFn: w.repairGh });
  const comments = w.collected.comments;
  w.collected.comments = []; // the comment the block was about is not there
  w.scan('2026-11-11T10:01:00.000Z');
  assert.equal(w.sent.length, 0);
  assert.equal(pendingEvents(w.HOME).filter((event) => event.kind === 'blocked-escalate').length, 1, 'reported at once, not a round later');
  w.collected.comments = comments; // it shows up again: the block was reported, so it is not handed back with a false note
  w.scan('2026-11-11T10:21:00.000Z');
  assert.equal(w.sent.length, 0);
});

test('helper to watcher: a delivery that fails and is retried is not reported in the retry window, and the retry still carries the note', (t) => {
  const w = world(t);
  blocked({ home: w.HOME, taskPath: w.taskPathOf('live-790'), reason: REASON, ghFn: w.repairGh });
  w.failNext('HOST_NOT_READY: host is starting');
  w.scan('2026-11-11T10:01:00.000Z');
  assert.equal(w.sent.length, 0);
  w.scan('2026-11-11T10:03:00.000Z');
  assert.deepEqual(pendingEvents(w.HOME).filter((event) => event.kind === 'blocked-escalate'), []);
  w.scan('2026-11-11T10:08:00.000Z');
  assert.equal(w.sent.length, 1);
  assert.match(JSON.stringify(w.sent[0]), /先裁决再继续/);
  assert.deepEqual(pendingEvents(w.HOME).filter((event) => event.kind === 'blocked-escalate'), []);
});
