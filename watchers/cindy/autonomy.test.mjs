import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commitsMissingDco, blocked, repairPaths } from './bin/cindy-repair.mjs';
import { dispatchParams, pollFingerprint, normalizePollSnapshot, scanOnce, watcherPaths, rulesVersion, feedbackItems, newFeedback } from './bin/cindy-watcher.mjs';
import { acquireLock, readPr, writePr } from './bin/cindy-state.mjs';
import { pendingEvents } from './bin/notify.mjs';
import { feedbackRepairPolicy } from './bin/cindy-feedback-policy.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const nodeId = 'PR_790';
const now = '2026-09-28T00:30:00Z';
const listed = { number: 790, id: nodeId, headRefOid: HEAD, headRefName: 'fix/x', title: 'fix', isDraft: false, labels: [] };

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-autonomy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { home, paths };
}

function graphqlNode(extra = {}) {
  return {
    state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
    labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
    reviewThreads: { nodes: [] }, commits: { nodes: [] }, ...extra,
  };
}
const SNAP_FINGERPRINT = pollFingerprint(normalizePollSnapshot({ data: { node: graphqlNode() } }));

function seedBound(paths, extra = {}) {
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', claimedAt: '2026-09-27T00:00:00Z',
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: 'e',
    activeTask: { status: 'complete' }, headRefName: 'fix/x', title: 'fix', ...extra,
  });
}

function discover(paths, { collect, dispatchFn, now: at = now, node = graphqlNode(), recheckFn } = {}) {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-autonomy-plugin-'));
  const result = scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: at,
    gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([listed]);
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node } });
      return '[]';
    },
    collect, dispatchFn, recheckFn,
    ownershipSnapshot: function* () {
      return { pr: { state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' } };
    },
  });
  fs.rmSync(plugin, { recursive: true, force: true });
  return { result, entry: readPr(paths.home, nodeId) };
}

function writeTask(home, extra = {}) {
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const task = {
    dispatchId: 'live-790', nodeId, number: 790, repo: 'makecindy/cindy',
    sessionId: 'sess-790', headRefOid: HEAD, headRefName: 'fix/x',
    headRepo: 'ExampleUser/cindy-fork', headOwner: 'ExampleUser', ...extra,
  };
  const taskPath = path.join(paths.tasks, `${task.dispatchId}.json`);
  fs.writeFileSync(taskPath, JSON.stringify(task));
  return { paths, taskPath, task };
}

const MERGE = '1'.repeat(40);
const SIGNED = '2'.repeat(40);
const UNSIGNED = '3'.repeat(40);
const FROM = '0'.repeat(40);

test('SC1 commitsMissingDco ignores merge commits and still fails unsigned non-merges', () => {
  const gitFn = (_bin, args) => {
    const skipMerge = args.includes('--no-merges')
      || /%P/.test(String(args.find((item) => typeof item === 'string' && item.includes('%')) ?? ''));
    const parts = [];
    if (!skipMerge) parts.push(`${MERGE}\nMerge branch 'main' into fix\n`);
    parts.push(`${SIGNED}\nfix signed\n\nSigned-off-by: Example User <user@example.com>\n`);
    parts.push(`${UNSIGNED}\nfix unsigned\n`);
    return `${parts.join('\x1e')}\x1e`;
  };
  const missing = commitsMissingDco('/tmp/cindy-wt', FROM, UNSIGNED, gitFn);
  assert.equal(missing.includes(MERGE), false, 'merge commits do not require Signed-off-by');
  assert.deepEqual(missing, [UNSIGNED]);
});

test('SC2 waiting-ci is not in-flight: new review feedback dispatches in the same round', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, {
    pollFingerprint: 'old',
    lastDispatch: { dispatchId: 'live-wait', at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: 'live-wait', head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', 'live-wait.json'), JSON.stringify({
    dispatchId: 'live-wait', nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'old' },
    feedback: [{ key: 'ci:unit', source: 'ci', nativeId: 'unit' }],
  }));
  const calls = [];
  const { result } = discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [],
      threads: [{ id: 'PRRT_new', isResolved: false, isOutdated: false, path: 'src/a.ts', comments: [{ id: 'c-new', author: { login: 'greptile-apps[bot]' }, body: '**P1** still broken', createdAt: now }] }],
      labels: [], mergeReady: false, ci: { status: 'pending', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
    recheckFn: () => ({}),
  });
  assert.equal(calls.length, 1, 'waiting-ci must not block a new-feedback dispatch');
  assert.notEqual(result.prs[0].dispatch.reason, 'waiting-ci');
  assert.equal(result.prs[0].dispatch.attempted, true);
});

test('SC2 deferred recheck still rechecks on an unchanged fingerprint', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, {
    pollFingerprint: SNAP_FINGERPRINT,
    recheckDeferredAt: '2026-09-28T00:00:00Z',
    lastDispatch: { dispatchId: 'live-wait', at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: 'live-wait', head: HEAD, sessionId: 'sess-790' },
  });
  const rechecks = [];
  discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'pending', required: [{ context: 'unit', status: 'pending' }] }, policy: { status: 'verified', required: [{ context: 'unit' }] },
    }),
    dispatchFn: () => { throw new Error('should not dispatch'); },
    recheckFn: (args) => { rechecks.push(args); return {}; },
  });
  assert.equal(rechecks.length, 1);
});

test('SC3 active helper heartbeat blocks recovery; existing result is consumed not recovered', (t) => {
  const { paths, home } = homeOf(t);
  const dispatchId = 'live-790-run';
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z', recoveryCount: 0 },
    activeTask: { status: 'accepted', dispatchId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' }, feedback: [],
  }));
  const activityDir = path.join(paths.stateDir, 'activity');
  fs.mkdirSync(activityDir, { recursive: true });
  fs.writeFileSync(path.join(activityDir, `${dispatchId}.json`), JSON.stringify({ at: '2026-09-28T00:29:00Z', op: 'validate' }));
  const recoveries = [];
  discover(paths, {
    now: '2026-09-28T00:31:00Z',
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (params) => { recoveries.push(params); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(recoveries.length, 0, 'recent helper activity must not be recovered');

  fs.rmSync(path.join(activityDir, `${dispatchId}.json`), { force: true });
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${dispatchId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'cindy-repair-result', dispatchId, nodeId, sessionId: 'sess-790', number: 790, repo: 'makecindy/cindy',
    status: 'blocked', blockedKind: 'external', reason: 'no-permission', receiptId: 'r1', head: HEAD,
  }));
  const later = [];
  discover(paths, {
    now: '2026-09-28T01:10:00Z',
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (params) => { later.push(params); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(later.length, 0, 'existing result must be consumed, not recovered');
  assert.equal(readPr(home, nodeId).activeTask.status, 'blocked');
});

test('SC3 idle task with no result is recovered once after 30 minutes', (t) => {
  const { paths } = homeOf(t);
  const dispatchId = 'live-790-idle';
  seedBound(paths, {
    pollFingerprint: 'old',
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z', recoveryCount: 0 },
    activeTask: { status: 'accepted', dispatchId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' }, feedback: [],
  }));
  const recoveries = [];
  const { result } = discover(paths, {
    now: '2026-09-28T00:31:00Z',
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (params) => { recoveries.push(params); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(recoveries.length, 1);
  assert.equal(result.prs[0].dispatch.reason, 'missing-result-recovery');
});

test('SC4 blocked writes the result while the PR lock is held and the next poll consumes it once', (t) => {
  const { home, paths } = homeOf(t);
  const { taskPath } = writeTask(home);
  writePr(home, nodeId, { number: 790, nodeId, sessionId: 'sess-790', activeTask: { dispatchId: 'live-790' } });
  const lock = acquireLock(home, `pr-${nodeId}`);
  t.after(() => { try { lock.release(); } catch {} });
  assert.equal(lock.held, false);
  const held = acquireLock(home, `pr-${nodeId}`);
  t.after(() => { try { held.release(); } catch {} });
  assert.equal(held.held, true);
  const result = blocked({ home, taskPath, reason: '缺权限：无法读上游 workflow' });
  assert.equal(result.status, 'blocked');
  assert.equal(fs.existsSync(path.join(paths.stateDir, 'results', 'live-790.json')), true);
  held.release();
  lock.release();

  seedBound(paths, {
    pollFingerprint: 'old', sessionId: 'sess-790',
    lastDispatch: { dispatchId: 'live-790', at: now },
    activeTask: { status: 'accepted', dispatchId: 'live-790', head: HEAD, sessionId: 'sess-790' },
  });
  discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: () => { throw new Error('should consume, not dispatch'); },
  });
  const first = readPr(home, nodeId);
  assert.equal(first.activeTask.status, 'blocked');
  const receipt = first.activeTask.receiptId;
  discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: () => { throw new Error('second consume must not redispatch'); },
  });
  assert.equal(readPr(home, nodeId).activeTask.receiptId, receipt);
});

test('SC5 same blocked cause does not redispatch; it writes one escalate notice per head', (t) => {
  const { paths, home } = homeOf(t);
  const dispatchId = 'live-790-ext';
  seedBound(paths, {
    pollFingerprint: 'old', eligibility: 'blocked', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'blocked', blockedKind: 'external', reason: 'no-permission: missing secret', dispatchId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' },
    feedback: [{ key: 'greptile:PRRT_1:c1', source: 'greptile', nativeId: 'PRRT_1:c1', body: '**P1** x' }],
  }));
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${dispatchId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'cindy-repair-result', dispatchId, nodeId, sessionId: 'sess-790',
    status: 'blocked', blockedKind: 'external', reason: 'no-permission: missing secret', receiptId: 'r-block', head: HEAD,
  }));
  const calls = [];
  discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [],
      threads: [{ id: 'PRRT_1', isResolved: false, comments: [{ id: 'c1', author: { login: 'greptile-apps[bot]' }, body: '**P1** x' }] }],
      labels: [], mergeReady: false, ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(calls.length, 0);
  const notices = fs.readdirSync(path.join(home, 'state', 'notices')).filter((name) => name.endsWith('.json'));
  assert.ok(notices.length >= 1);
});

test('SC6 notify.mjs check/emit: pending events exit 0, empty exit 2, emit once', (t) => {
  const { home } = homeOf(t);
  const bin = fileURLToPath(new URL('./bin/notify.mjs', import.meta.url));
  assert.equal(fs.existsSync(bin), true);
  const empty = spawnSync(process.execPath, [bin, 'check', '--home', home], { encoding: 'utf8' });
  assert.equal(empty.status, 2);
  assert.match(empty.stdout, /CINDY_PRECHECK_OK/);
  fs.mkdirSync(path.join(home, 'state', 'notices'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'notices', 'pending.json'), `${JSON.stringify({
    events: [{ kind: 'merge-ready', number: 790, head: HEAD, url: 'https://github.com/makecindy/cindy/pull/790' }],
  }, null, 2)}\n`);
  const ready = spawnSync(process.execPath, [bin, 'check', '--home', home], { encoding: 'utf8' });
  assert.equal(ready.status, 0);
  assert.match(ready.stdout, /CINDY_PRECHECK_OK/);
  const emit = spawnSync(process.execPath, [bin, 'emit', '--home', home], { encoding: 'utf8' });
  assert.equal(emit.status, 0);
  const frame = JSON.parse(emit.stdout.trim().split('\n').at(-1));
  assert.equal(frame.type, 'complete');
  assert.match(frame.resultText, /790/);
  assert.match(frame.resultText, /可以点合并|合并/);
  const again = spawnSync(process.execPath, [bin, 'emit', '--home', home], { encoding: 'utf8' });
  assert.doesNotMatch(again.stdout + again.stderr, /可以点合并/);
});

test('SC8 Cindy P2 is reply-only; unknown severity is not an automatic block', () => {
  const p2 = feedbackRepairPolicy({
    source: 'thread', user: { login: 'greptile-apps[bot]', type: 'Bot' },
    body: '**P2** must-fix this PR', sha: HEAD,
  }, { headSha: HEAD });
  assert.equal(p2.action, 'reply-only');
  assert.equal(p2.canChangeCode, false);
  const message = dispatchParams({
    pr: { number: 790, id: nodeId, headRefOid: HEAD, title: 't', headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' } },
    mapping: {}, fresh: [{ key: 'review:r1', source: 'review', nativeId: 'r1', revision: 't', sha: HEAD, body: 'maybe a bug', category: 'other' }],
    now, taskPath: '/tmp/home/state/tasks/live-790.json', home: '/tmp/home',
  }).message;
  assert.match(message, /确认不了的按不成立|no-change/);
  assert.doesNotMatch(message, /未知严重度一律 blocked/);
});

test('SC9 dispatch text requires sibling-check, history, and no user questions', () => {
  const message = dispatchParams({
    pr: { number: 790, id: nodeId, headRefOid: HEAD, title: 't', headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' } },
    mapping: {},
    fresh: [{ key: 'review:r1', source: 'review', nativeId: 'r1', revision: 't', sha: HEAD, body: '**P1** null deref', category: 'actionable-fix' }],
    now, taskPath: '/tmp/home/state/tasks/live-790.json', home: '/tmp/home',
    handledFindings: [{ key: 'review:old', file: 'src/a.ts', summary: '上一轮已修空指针' }],
  }).message;
  assert.match(message, /同一函数|调用方/);
  assert.match(message, /review:old/);
  assert.match(message, /上一轮已修空指针/);
  assert.match(message, /不向用户提问|不等用户确认/);
});

const oldThread = {
  id: 'PRRT_old', isResolved: false, isOutdated: false, path: 'src/a.ts',
  comments: [{ id: 'c-old', author: { login: 'greptile-apps[bot]' }, body: '**P1** old leak', createdAt: now }],
};
const newThread = {
  id: 'PRRT_new', isResolved: false, isOutdated: false, path: 'src/b.ts',
  comments: [{ id: 'c-new', author: { login: 'greptile-apps[bot]' }, body: '**P1** still broken', createdAt: now }],
};
function collectBase(extra = {}) {
  return {
    pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: false, isCrossRepository: true, author: { login: 'owner' }, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true, checks: [], comments: [], reviews: [], labels: [], mergeReady: false,
    ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    ...extra,
  };
}

test('SC2 superseded waiting-ci thread evidence is closed after later complete', (t) => {
  const { paths, home } = homeOf(t);
  const waitId = 'live-wait';
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId: waitId, at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: waitId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  const oldKey = 'greptile:PRRT_old:c-old';
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${waitId}.json`), JSON.stringify({
    dispatchId: waitId, nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'old' },
    feedback: [{ key: oldKey, source: 'greptile', nativeId: 'PRRT_old:c-old' }],
    repairPolicy: { items: [{ key: oldKey, action: 'code-fix' }] },
  }));
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${waitId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'cindy-repair-result', dispatchId: waitId, nodeId, sessionId: 'sess-790',
    status: 'waiting-ci', head: HEAD, receiptId: 'r-wait',
    feedbackCoverage: { dispositions: [{ key: oldKey, disposition: 'fixed' }] },
    scs: [{ status: 'pass', feedbackKeys: [oldKey], evidence: ['fixed in src/a.ts'] }],
  }));
  const calls = [];
  discover(paths, {
    collect: () => collectBase({ threads: [oldThread, newThread], mergeReady: false, ci: { status: 'pending', required: [] } }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
    recheckFn: () => ({}),
  });
  assert.equal(calls.length, 1);
  const afterDispatch = readPr(home, nodeId);
  assert.equal((afterDispatch.pendingThreadClose ?? []).some((item) => item.threadId === 'PRRT_old'), true);
  const nextId = afterDispatch.activeTask.dispatchId;
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${nextId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'cindy-repair-result', dispatchId: nextId, nodeId, sessionId: 'sess-790',
    status: 'complete', head: HEAD, receiptId: 'r-done', ci: { requiredGreen: true, head: HEAD },
    verification: { status: 'pass' },
    scs: [{ status: 'pass', feedbackKeys: ['greptile:PRRT_new:c-new'], evidence: ['fixed new'] }],
    feedbackCoverage: { dispositions: [{ key: 'greptile:PRRT_new:c-new', disposition: 'fixed' }] },
  }));
  discover(paths, {
    collect: () => collectBase({ threads: [{ ...oldThread }, { ...newThread, isResolved: false }], mergeReady: true }),
    dispatchFn: () => { throw new Error('should not dispatch after complete'); },
    recheckFn: () => ({}),
  });
  assert.ok(readPr(home, nodeId).autoClosedThreads?.PRRT_old);
});

test('SC2 waiting-ci revision/outdated flip does not redispatch the same keys', (t) => {
  const { paths } = homeOf(t);
  const waitId = 'live-wait';
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId: waitId, at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: waitId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${waitId}.json`), JSON.stringify({
    dispatchId: waitId, nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'old' },
    feedback: [{ key: 'greptile:PRRT_old:c-old', source: 'greptile', nativeId: 'PRRT_old:c-old' }],
  }));
  const calls = [];
  const { result } = discover(paths, {
    collect: () => collectBase({
      threads: [{ ...oldThread, isOutdated: true }],
      ci: { status: 'pending', required: [{ context: 'unit', status: 'pending' }] },
    }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
    recheckFn: () => ({}),
  });
  assert.equal(calls.length, 0);
  assert.equal(result.prs[0].dispatch.reason, 'waiting-ci');
});

test('SC3 recoveryCount=3 with recent helper activity is not missing-result-limit', (t) => {
  const { paths, home } = homeOf(t);
  const dispatchId = 'live-790-run';
  seedBound(paths, {
    pollFingerprint: 'old',
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z', recoveryCount: 3, lastRecoveryAt: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'accepted', dispatchId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' }, feedback: [],
  }));
  fs.mkdirSync(path.join(paths.stateDir, 'activity'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'activity', `${dispatchId}.json`), JSON.stringify({ at: '2026-09-28T00:29:00Z', op: 'validate' }));
  discover(paths, {
    now: '2026-09-28T00:30:00Z',
    collect: () => collectBase(),
    dispatchFn: () => { throw new Error('recent activity must not recover or stop'); },
  });
  assert.notEqual(readPr(home, nodeId).activeTask.blockedKind, 'missing-result-limit');
  assert.equal(readPr(home, nodeId).activeTask.status, 'accepted');
});

test('SC5 real blocked() receipt is not redispatched for the same cause', (t) => {
  const { home, paths } = homeOf(t);
  const { taskPath } = writeTask(home, {
    feedback: [{ key: 'greptile:PRRT_1:c1', source: 'greptile', nativeId: 'PRRT_1:c1', body: '**P1** x' }],
  });
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(), sessionId: 'sess-790',
    lastDispatch: { dispatchId: 'live-790', at: now },
    activeTask: { status: 'accepted', dispatchId: 'live-790', head: HEAD, sessionId: 'sess-790' },
  });
  const receipt = blocked({ home, taskPath, reason: 'credential missing' });
  assert.equal(receipt.head, HEAD);
  assert.equal(receipt.sourceHead, HEAD);
  discover(paths, {
    collect: () => collectBase({ threads: [{ id: 'PRRT_1', isResolved: false, comments: [{ id: 'c1', author: { login: 'greptile-apps[bot]' }, body: '**P1** x' }] }] }),
    dispatchFn: () => { throw new Error('consume must not dispatch'); },
  });
  const calls = [];
  discover(paths, {
    collect: () => collectBase({ threads: [{ id: 'PRRT_1', isResolved: false, comments: [{ id: 'c1', author: { login: 'greptile-apps[bot]' }, body: '**P1** x' }] }] }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(calls.length, 0);
  assert.equal(readPr(home, nodeId).activeTask.status, 'blocked');
});

test('SC5 rules refresh redispatches an external blocked task', (t) => {
  const { paths } = homeOf(t);
  const dispatchId = 'live-790-ext';
  seedBound(paths, {
    pollFingerprint: SNAP_FINGERPRINT, eligibility: 'blocked', rulesVersion: 'deadbeefdead',
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'blocked', blockedKind: 'external', reason: 'credential missing', dispatchId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' },
    feedback: [{ key: 'greptile:PRRT_1:c1', source: 'greptile', nativeId: 'PRRT_1:c1', body: '**P1** x' }],
  }));
  const calls = [];
  discover(paths, {
    collect: () => collectBase({ threads: [{ id: 'PRRT_1', isResolved: false, comments: [{ id: 'c1', author: { login: 'greptile-apps[bot]' }, body: '**P1** x' }] }] }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(calls.length, 1);
});

test('SC6 concurrent enqueue keeps both notice events', (t) => {
  const { home } = homeOf(t);
  const bin = fileURLToPath(new URL('./bin/notify.mjs', import.meta.url));
  const script = `
    import { enqueueNotice } from ${JSON.stringify(bin)};
    enqueueNotice(process.env.NOTICE_HOME, JSON.parse(process.env.NOTICE_EVENT));
  `;
  const run = (event) => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { ...process.env, NOTICE_HOME: home, NOTICE_EVENT: JSON.stringify(event) },
  });
  const a = run({ kind: 'needs-human', number: 790, head: HEAD });
  const b = run({ kind: 'merge-ready', number: 790, head: HEAD });
  assert.equal(a.status, 0, a.stderr);
  assert.equal(b.status, 0, b.stderr);
  const pending = JSON.parse(fs.readFileSync(path.join(home, 'state', 'notices', 'pending.json'), 'utf8'));
  assert.equal(pending.events.length, 2);
});

function seedWaitingCi(t, { status = 'waiting-ci', blockedKind, reason, coverage = true, consumeCursor = false } = {}) {
  const { home, paths } = homeOf(t);
  const waitId = 'live-wait';
  const oldKey = 'greptile:PRRT_old:c-old';
  const cursor = consumeCursor
    ? newFeedback({}, feedbackItems({ ...collectBase({ threads: [oldThread] }), receiptActor: 'owner' })).cursor
    : undefined;
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId: waitId, at: '2026-09-28T00:00:00Z' },
    activeTask: {
      status, evidenceVersion: 2, dispatchId: waitId, head: HEAD, sessionId: 'sess-790',
      ...(blockedKind ? { blockedKind, reason } : {}),
    },
    ...(status === 'blocked' ? { eligibility: 'blocked' } : {}),
    ...(cursor ? { feedbackCursor: cursor } : {}),
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${waitId}.json`), JSON.stringify({
    dispatchId: waitId, nodeId, number: 790, repo: 'makecindy/cindy', sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'old' },
    feedback: [{ key: oldKey, source: 'greptile', nativeId: 'PRRT_old:c-old', path: 'src/a.ts', body: '**P1** old leak' }],
    repairPolicy: { items: [{ key: oldKey, action: 'code-fix' }] },
  }));
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${waitId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'cindy-repair-result', dispatchId: waitId, nodeId, sessionId: 'sess-790',
    status, head: HEAD, receiptId: 'r-wait',
    ...(blockedKind ? { blockedKind, reason } : {}),
    ...(coverage ? {
      feedbackCoverage: { dispositions: [{ key: oldKey, disposition: 'fixed' }] },
      scs: [{ status: 'pass', feedbackKeys: [oldKey], evidence: ['fixed in src/a.ts'] }],
    } : {}),
  }));
  return { home, paths, waitId, oldKey };
}

test('R1 waiting-ci body edit of the same comment key dispatches in the same round', (t) => {
  const { paths } = seedWaitingCi(t);
  const calls = [];
  const edited = {
    ...oldThread,
    comments: [{ ...oldThread.comments[0], body: '**P1** correction: a second reachable failure remains', updatedAt: '2026-09-28T00:31:00Z' }],
  };
  const { result } = discover(paths, {
    collect: () => collectBase({ threads: [edited], ci: { status: 'pending', required: [] } }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
    recheckFn: () => ({}),
  });
  assert.equal(calls.length, 1, 'edited P1 body must dispatch even while waiting-ci');
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.match(calls[0].message, /second reachable failure/);
});

test('R2 new P1 reply on a pending-close thread stays open after later complete', (t) => {
  const { home, paths } = seedWaitingCi(t);
  const reply = {
    ...oldThread,
    comments: [
      ...oldThread.comments,
      { id: 'c-second', author: { login: 'greptile-apps[bot]' }, body: '**P1** correction: still broken', createdAt: '2026-09-28T00:31:00Z' },
    ],
  };
  const calls = [];
  discover(paths, {
    collect: () => collectBase({ threads: [reply], ci: { status: 'pending', required: [] } }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
    recheckFn: () => ({}),
  });
  assert.equal(calls.length, 1);
  const afterDispatch = readPr(home, nodeId);
  const nextId = afterDispatch.activeTask.dispatchId;
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${nextId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'cindy-repair-result', dispatchId: nextId, nodeId, sessionId: 'sess-790',
    status: 'complete', head: HEAD, receiptId: 'r-done', ci: { requiredGreen: true, head: HEAD },
    verification: { status: 'pass' },
    scs: [{ status: 'pass', feedbackKeys: ['greptile:PRRT_old:c-second'], evidence: ['fixed reply'] }],
    feedbackCoverage: { dispositions: [{ key: 'greptile:PRRT_old:c-second', disposition: 'fixed' }] },
  }));
  discover(paths, {
    collect: () => collectBase({ threads: [reply], mergeReady: true }),
    dispatchFn: () => { throw new Error('should not dispatch after complete'); },
    recheckFn: () => ({}),
  });
  assert.equal(Boolean(readPr(home, nodeId).autoClosedThreads?.PRRT_old), false,
    'thread with an uncovered new P1 reply must stay open');
});

test('R3 consumed external blocked still queues escalate when GitHub is unchanged', (t) => {
  const { home, paths } = seedWaitingCi(t, {
    status: 'blocked', blockedKind: 'external', reason: 'credential missing', coverage: false, consumeCursor: true,
  });
  for (let i = 0; i < 3; i += 1) {
    discover(paths, {
      now: `2026-09-28T00:3${i}:00Z`,
      collect: () => collectBase({ threads: [oldThread], ci: { status: 'pending', required: [] } }),
      dispatchFn: () => { throw new Error('unexpected dispatch'); },
      recheckFn: () => ({}),
    });
  }
  assert.ok(pendingEvents(home).some((event) => event.kind === 'blocked-escalate'),
    'external blocked must reach the notice queue without a GitHub fingerprint change');
});

test('SC8 explicit member P2 is reply-only; unlabeled member thread still opens a session', (t) => {
  const labeled = feedbackRepairPolicy({
    source: 'thread', threadId: 'PRRT_low', nativeId: 'PRRT_low:c-low',
    user: { login: 'ExampleMaintainer' }, authorAssociation: 'MEMBER',
    body: '**P2** small localized defect', sha: HEAD,
  }, { headSha: HEAD });
  assert.equal(labeled.action, 'reply-only');
  assert.equal(labeled.canChangeCode, false);
  const unlabeled = feedbackRepairPolicy({
    source: 'thread', threadId: 'PRRT_ask', nativeId: 'PRRT_ask:c-ask',
    user: { login: 'ExampleMaintainer' }, authorAssociation: 'MEMBER',
    body: 'please look at this path', sha: HEAD,
  }, { headSha: HEAD });
  assert.equal(unlabeled.action, 'code-fix');
  assert.equal(unlabeled.reason, 'review-thread-triage');
});

test('SC9 history line includes the finding file from the prior task when evidence has none', (t) => {
  const { home, paths } = homeOf(t);
  seedBound(paths, { pollFingerprint: 'old', rulesVersion: rulesVersion() });
  const prior = writeTask(home, {
    dispatchId: 'old-complete',
    feedback: [{ key: 'greptile:PRRT_past:c-past', source: 'greptile', nativeId: 'PRRT_past:c-past', path: 'src/leak.ts', body: '**P1** src/leak.ts leaks sockets' }],
  });
  fs.mkdirSync(prior.paths.results, { recursive: true });
  fs.writeFileSync(path.join(prior.paths.results, 'old-complete.json'), JSON.stringify({
    nodeId, dispatchId: 'old-complete', schemaVersion: 2, status: 'complete',
    scs: [{ status: 'pass', feedbackKeys: ['greptile:PRRT_past:c-past'], evidence: ['npm test: all passed'] }],
  }));
  const calls = [];
  discover(paths, {
    collect: () => collectBase({ threads: [newThread] }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(calls.length, 1);
  const history = calls[0].message.split('\n').find((line) => line.startsWith('此前各轮已处理 finding：'));
  assert.match(history, /src\/leak\.ts/);
});

const editedOldThread = {
  ...oldThread,
  comments: [{ ...oldThread.comments[0], body: '**P1** correction: the leak also happens on the retry path', updatedAt: '2026-09-28T00:31:00Z' }],
};

test('R3-1 old waiting-ci evidence does not close a comment edited before CI turns green', (t) => {
  const { home, paths } = seedWaitingCi(t);
  const calls = [];
  discover(paths, {
    collect: () => collectBase({ threads: [editedOldThread] }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
    recheckFn: () => ({}),
  });
  assert.equal(Boolean(readPr(home, nodeId).autoClosedThreads?.PRRT_old), false,
    'evidence for the old body must not resolve the edited P1');
  assert.equal(calls.length, 1, 'the edited P1 must be dispatched');
  assert.match(calls[0].message, /retry path/);
});

test('R3-3 editing the blocked feedback is new feedback, not the same blocked cause', (t) => {
  const { paths } = seedWaitingCi(t, {
    status: 'blocked', blockedKind: 'external', reason: 'credential missing', coverage: false, consumeCursor: true,
  });
  const calls = [];
  discover(paths, {
    collect: () => collectBase({ threads: [editedOldThread], ci: { status: 'pending', required: [] } }),
    dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
    recheckFn: () => ({}),
  });
  assert.equal(calls.length, 1, 'an edited comment after an external block must wake the session');
});

test('R3-5 discover queues one notice for a PR that needs a person', (t) => {
  const { home, paths } = homeOf(t);
  seedBound(paths, { needsHuman: { reason: 'owner-unknown', at: now } });
  for (let i = 0; i < 2; i += 1) {
    discover(paths, {
      collect: () => collectBase(),
      dispatchFn: () => { throw new Error('needs-human PR must not dispatch'); },
    });
  }
  const events = pendingEvents(home).filter((event) => event.kind === 'owner-unknown');
  assert.equal(events.length, 1, 'one notice per PR and state');
});
