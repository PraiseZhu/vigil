// The whole way for a task whose head went stale: the helper's `blocked` writes the kind it read from the ownership
// check, and the next watcher round hands the feedback to a new repair round on the current head without a notice.
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

test('helper to watcher: a stale task head is reported as stale-head and repaired again on the new head, with no notice', (t) => {
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-moved-flow-'));
t.after(() => fs.rmSync(HOME, { recursive: true, force: true }));
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const NOW = '2026-11-11T10:00:00.000Z';
const RELEASE = 'opened:PR_790:2026-11-01T00:00:00Z';
const nodeId = 'PR_790';
const number = 790;
const handoff = { version: 1, id: 'handoff-fixture', repo: REPO, number, nodeId, head: A, releaseEpoch: RELEASE, author: 'owner' };
const feedback = {
  key: 'comment:501', source: 'comment', nativeId: '501', revision: '2026-11-11T09:00:00Z',
  contentHash: 'prior-content', sha: A, body: 'Please investigate this behavior.',
};
const paths = watcherPaths(HOME);
const v2 = statePaths(HOME);
fs.mkdirSync(v2.prsDir, { recursive: true });
fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
fs.writeFileSync(v2.indexPath, JSON.stringify({ version: 2, migratedAt: NOW }));
const previous = {
  number, nodeId, url: 'https://example.invalid/pull/790', sessionId: 'session-old',
  headRefOid: A, headRefName: 'fix/x', eligibility: 'active', eligibilityInitialized: true,
  admissionVerified: true, admissionEpoch: RELEASE, roundsEpoch: RELEASE, repairRounds: 2,
  handoff, trustedHead: { handoffId: handoff.id, head: A }, wasDraft: false,
  feedbackCursor: { [feedback.key]: 'old-stamp' },
  activeTask: { dispatchId: 'live-790', status: 'accepted', head: A, at: NOW, observedAt: NOW },
};
writePr(HOME, nodeId, previous);
const taskPath = path.join(paths.stateDir, 'tasks', 'live-790.json');
fs.writeFileSync(taskPath, JSON.stringify({
  dispatchId: 'live-790', nodeId, number, repo: REPO, sessionId: previous.sessionId,
  headRefOid: A, headRefName: 'fix/x', releaseEpoch: RELEASE, handoff, feedback: [feedback],
}));

const viewAtB = {
  id: nodeId, number, title: 'fixture', body: '', url: previous.url, state: 'OPEN', isDraft: false,
  headRefOid: B, headRefName: 'fix/x', baseRefOid: BASE, baseRefName: 'feature-base',
  createdAt: '2026-11-01T00:00:00Z', author: { login: 'owner' }, isCrossRepository: false,
  mergeable: 'MERGEABLE', reviewDecision: null,
};
const repairGh = (_bin, args) => {
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(viewAtB);
  if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node: {
    timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  } } });
  throw new Error(`unexpected helper gh call: ${args.join(' ')}`);
};

const blockedResult = blocked({ home: HOME, taskPath, reason: 'task submission expired before this round completed', ghFn: repairGh });
const landed = JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'results', 'live-790.json'), 'utf8'));
assert.equal(blockedResult.blockedKind, 'stale-head');
assert.equal(landed.blockedKind, 'stale-head');

const listed = {
  id: nodeId, number, headRefOid: B, headRefName: 'fix/x', isDraft: false,
  labels: [], url: previous.url, updatedAt: NOW, title: 'fixture',
};
const collected = {
  pr: { ...viewAtB, repo: REPO, sameRepository: true, releaseEpoch: RELEASE },
  handoff: handoffReceipt({ ...viewAtB, repo: REPO, sameRepository: true, releaseEpoch: RELEASE }),
  comments: [{ id: 501, body: feedback.body, author: { login: 'ExampleReviewer' }, user: { login: 'ExampleReviewer' },
    authorAssociation: 'NONE', created_at: feedback.revision, updated_at: feedback.revision }],
  reviews: [], threads: [], labels: [], ci: { status: 'green', required: [], checks: [] },
  admissionVerified: true, admissionReason: 'fixture', mergeReady: false, mergeable: 'MERGEABLE',
};
const ghFn = (args) => {
  if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([listed]);
  if (args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('search('))) {
    return JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } });
  }
  if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: nodeId, state: 'OPEN' });
  if (isChildPrList(args)) return '[[]]';
  if (args[0] === 'api' && String(args[1]).includes('/rules/branches/')) return '[[]]';
  throw new Error(`unexpected watcher gh call: ${args.join(' ')}`);
};
const sent = [];
const report = scanOnce({
  enabled: true, allowDispatch: true, paths, now: '2026-11-11T10:01:00.000Z', ghFn,
  collect: () => collected,
  ownershipSnapshot: function* () { return { pr: collected.pr }; },
  dispatchFn: (params) => { sent.push(params); return { target_session_id: params.target_session_id ?? 'session-new' }; },
  keelRoot: os.tmpdir(),
});
const dispatched = report.prs.find((item) => item.number === number)?.dispatch;
const notices = pendingEvents(HOME);
const freshTask = fs.readdirSync(path.join(paths.stateDir, 'tasks'))
  .filter((name) => name !== 'live-790.json')
  .map((name) => JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'tasks', name), 'utf8')))
  .find((item) => item.headRefOid === B);
assert.equal(dispatched?.attempted, true);
assert.equal(sent.length, 1);
assert.deepEqual(freshTask?.feedback?.map((item) => item.key), [feedback.key]);
assert.deepEqual(notices.filter((event) => event.kind === 'blocked-escalate'), []);
});
