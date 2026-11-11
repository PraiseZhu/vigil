// A session that stops with "I cannot solve this" gets the same feedback back once, with its own reason and the order
// to put it to an arbiter first; nobody is notified. The second stop on the same head is reported as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { blocked } from './bin/mivo-repair.mjs';
import { REPO, scanOnce, watcherPaths } from './bin/mivo-watcher.mjs';
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
  const feedback = { key: 'comment:501', source: 'comment', nativeId: '501', revision: '2026-11-11T09:00:00Z', contentHash: 'prior-content', sha: A, body: 'Please investigate this behavior.' };
  const paths = watcherPaths(HOME);
  const v2 = statePaths(HOME);
  fs.mkdirSync(v2.prsDir, { recursive: true });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(v2.indexPath, JSON.stringify({ version: 2, migratedAt: '2026-11-11T10:00:00.000Z' }));
  const url = 'https://example.invalid/pull/790';
  writePr(HOME, nodeId, {
    number, nodeId, url, sessionId: 'session-old', headRefOid: A, headRefName: 'fix/x', eligibility: 'active', eligibilityInitialized: true,
    admissionVerified: true, admissionEpoch: RELEASE, roundsEpoch: RELEASE, repairRounds: 2, handoff, trustedHead: { handoffId: handoff.id, head: A }, wasDraft: false,
    feedbackCursor: { [feedback.key]: 'old-stamp' },
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
    comments: [{ id: 501, body: feedback.body, author: { login: 'ExampleReviewer' }, user: { login: 'ExampleReviewer' }, authorAssociation: 'NONE', created_at: feedback.revision, updated_at: feedback.revision }],
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
  const scan = (now) => scanOnce({
    enabled: true, allowDispatch: true, paths, now, ghFn, collect: () => collected,
    ownershipSnapshot: function* () { return { pr: collected.pr }; },
    dispatchFn: (params) => { sent.push(params); return { target_session_id: params.target_session_id ?? 'session-new' }; },
    keelRoot: os.tmpdir(),
  });
  const tasks = () => fs.readdirSync(path.join(paths.stateDir, 'tasks')).map((name) => JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'tasks', name), 'utf8')));
  return { HOME, paths, repairGh, taskPathOf, scan, sent, tasks };
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
