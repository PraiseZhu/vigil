import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { blocked, repairPaths } from './bin/mivo-repair.mjs';
import { dispatchParams, pollFingerprint, normalizePollSnapshot, scanOnce, watcherPaths, rulesVersion, feedbackItems, newFeedback } from './bin/mivo-watcher.mjs';
import { acquireLock, readPr, writePr } from './bin/mivo-state.mjs';
import { pendingEvents } from './bin/notify.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const nodeId = 'PR_790';
const now = '2026-09-28T00:30:00Z';
const listed = { number: 790, id: nodeId, headRefOid: HEAD, headRefName: 'fix/x', title: 'fix', isDraft: false, labels: [] };

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-autonomy-'));
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
  const handoff = handoffReceipt({ ...listed, releaseEpoch: 'e' });
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', claimedAt: '2026-09-27T00:00:00Z',
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: handoff.releaseEpoch, handoff,
    activeTask: { status: 'complete' }, headRefName: 'fix/x', title: 'fix', ...extra,
  });
}

function discover(paths, { collect, dispatchFn, now: at = now, node = graphqlNode(), recheckFn } = {}) {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-autonomy-plugin-'));
  const result = scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: at,
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([listed]);
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node } });
      return '[]';
    },
    collect: (...args) => withAuthorHandoff(collect(...args), args[0]),
    dispatchFn, recheckFn,
    ownershipSnapshot: function* () {
      return { pr: handoffPr({ id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' }) };
    },
  });
  fs.rmSync(plugin, { recursive: true, force: true });
  return { result, entry: readPr(paths.home, nodeId) };
}

function writeTask(home, extra = {}) {
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const task = {
    dispatchId: 'live-790', nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO,
    sessionId: 'sess-790', headRefOid: HEAD, headRefName: 'fix/x', ...extra,
  };
  const taskPath = path.join(paths.tasks, `${task.dispatchId}.json`);
  fs.writeFileSync(taskPath, JSON.stringify(task));
  return { paths, taskPath, task };
}

test('SC2 waiting-ci is not in-flight: new review feedback dispatches in the same round', (t) => {
  const { paths } = homeOf(t);
  seedBound(paths, {
    pollFingerprint: 'old',
    lastDispatch: { dispatchId: 'live-wait', at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: 'live-wait', head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', 'live-wait.json'), JSON.stringify({
    dispatchId: 'live-wait', nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'old' },
    feedback: [{ key: 'ci:unit', source: 'ci', nativeId: 'unit' }],
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
  }));
  const calls = [];
  const { result } = discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
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

test('SC2 deferred recheck still rechecks on an unchanged fingerprint (needsCiRecheck)', (t) => {
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
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
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
  const handoff = handoffReceipt({ ...listed, releaseEpoch: 'e' });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' }, feedback: [], handoff,
  }));
  const activityDir = path.join(paths.stateDir, 'activity');
  fs.mkdirSync(activityDir, { recursive: true });
  fs.writeFileSync(path.join(activityDir, `${dispatchId}.json`), JSON.stringify({ at: '2026-09-28T00:29:00Z', op: 'validate' }));
  const recoveries = [];
  discover(paths, {
    now: '2026-09-28T00:31:00Z',
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: (params) => { recoveries.push(params); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(recoveries.length, 0, 'recent helper activity must not be recovered');

  fs.rmSync(path.join(activityDir, `${dispatchId}.json`), { force: true });
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${dispatchId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'mivo-repair-result', dispatchId, nodeId, sessionId: 'sess-790', number: 790,
    repo: process.env.MIVO_WATCHER_TARGET_REPO, status: 'blocked', blockedKind: 'external',
    reason: 'no-permission', receiptId: 'r1', head: HEAD,
  }));
  const later = [];
  discover(paths, {
    now: '2026-09-28T01:10:00Z',
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
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
  const handoff = handoffReceipt({ ...listed, releaseEpoch: 'e' });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' }, feedback: [], handoff,
  }));
  const recoveries = [];
  const { result } = discover(paths, {
    now: '2026-09-28T00:31:00Z',
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
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
  const { taskPath } = writeTask(home, { handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }) });
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
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
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
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
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
  const handoff = handoffReceipt({ ...listed, releaseEpoch: 'e' });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' }, handoff,
    feedback: [{ key: 'greptile:PRRT_1:c1', source: 'greptile', nativeId: 'PRRT_1:c1', body: '**P1** x' }],
  }));
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${dispatchId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'mivo-repair-result', dispatchId, nodeId, sessionId: 'sess-790',
    status: 'blocked', blockedKind: 'external', reason: 'no-permission: missing secret', receiptId: 'r-block', head: HEAD,
  }));
  const calls = [];
  discover(paths, {
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
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
    events: [{ kind: 'merge-ready', number: 790, head: HEAD, url: 'https://github.com/example-org/example-plugin/pull/790' }],
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

test('SC9 dispatch text requires sibling-check, history, and no user questions', () => {
  const message = dispatchParams({
    pr: { number: 790, id: nodeId, headRefOid: HEAD, title: 't' },
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
    pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true, checks: [], comments: [], reviews: [], labels: [], mergeReady: false,
    ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    ...extra,
  };
}

test('SC2 superseded waiting-ci thread evidence is closed after later complete', (t) => {
  const { paths, home } = homeOf(t);
  const waitId = 'live-wait';
  const handoff = handoffReceipt({ ...listed, releaseEpoch: 'e' });
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId: waitId, at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: waitId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  const oldKey = 'greptile:PRRT_old:c-old';
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${waitId}.json`), JSON.stringify({
    dispatchId: waitId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'old' }, handoff,
    feedback: [{ key: oldKey, source: 'greptile', nativeId: 'PRRT_old:c-old' }],
    repairPolicy: { items: [{ key: oldKey, action: 'code-fix' }] },
  }));
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${waitId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'mivo-repair-result', dispatchId: waitId, nodeId, sessionId: 'sess-790',
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
    schemaVersion: 2, kind: 'mivo-repair-result', dispatchId: nextId, nodeId, sessionId: 'sess-790',
    status: 'complete', head: HEAD, receiptId: 'r-done', ci: { requiredGreen: true, head: HEAD },
    verification: { status: 'pass' },
    scs: [{ status: 'pass', feedbackKeys: ['greptile:PRRT_new:c-new'], evidence: ['fixed new'] }],
    feedbackCoverage: { dispositions: [{ key: 'greptile:PRRT_new:c-new', disposition: 'fixed' }] },
  }));
  discover(paths, {
    collect: () => collectBase({ threads: [oldThread, newThread], mergeReady: true }),
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
    dispatchId: waitId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'old' },
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
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
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' }, feedback: [],
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
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
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
    feedback: [{ key: 'greptile:PRRT_1:c1', source: 'greptile', nativeId: 'PRRT_1:c1', body: '**P1** x' }],
  });
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(), sessionId: 'sess-790',
    lastDispatch: { dispatchId: 'live-790', at: now },
    activeTask: { status: 'accepted', dispatchId: 'live-790', head: HEAD, sessionId: 'sess-790' },
  });
  const receipt = blocked({ home, taskPath, reason: 'credential missing' });
  assert.equal(receipt.head, HEAD);
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
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' },
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
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
    dispatchId: waitId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'old' },
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
    feedback: [{ key: oldKey, source: 'greptile', nativeId: 'PRRT_old:c-old', path: 'src/a.ts', body: '**P1** old leak' }],
    repairPolicy: { items: [{ key: oldKey, action: 'code-fix' }] },
  }));
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${waitId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'mivo-repair-result', dispatchId: waitId, nodeId, sessionId: 'sess-790',
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
    schemaVersion: 2, kind: 'mivo-repair-result', dispatchId: nextId, nodeId, sessionId: 'sess-790',
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

function writeResult(paths, dispatchId, extra) {
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', `${dispatchId}.json`), JSON.stringify({
    schemaVersion: 2, kind: 'mivo-repair-result', dispatchId, nodeId, sessionId: 'sess-790', head: HEAD,
    receiptId: `r-${dispatchId}-${extra.status}`, ...extra,
  }));
}

test('R4-1 the newest evidence for a thread replaces older pending evidence and closes it once CI is green', (t) => {
  const { home, paths, oldKey } = seedWaitingCi(t);
  const calls = [];
  const track = (params) => { calls.push(params); return { target_session_id: 'sess-790' }; };
  // Round 1: the comment is edited while the first fix waits for CI; a second task picks up the new words.
  discover(paths, { collect: () => collectBase({ threads: [editedOldThread], ci: { status: 'pending', required: [] } }), dispatchFn: track, recheckFn: () => ({}) });
  assert.equal(calls.length, 1);
  const second = readPr(home, nodeId).activeTask.dispatchId;
  writeResult(paths, second, {
    status: 'waiting-ci', feedbackCoverage: { dispositions: [{ key: oldKey, disposition: 'fixed' }] },
    scs: [{ status: 'pass', feedbackKeys: [oldKey], evidence: ['fixed the retry path in src/a.ts'] }],
  });
  // Round 2: an unrelated thread arrives while the second fix waits for CI.
  discover(paths, { now: '2026-09-28T00:40:00Z', collect: () => collectBase({ threads: [editedOldThread, newThread], ci: { status: 'pending', required: [] } }), dispatchFn: track, recheckFn: () => ({}) });
  assert.equal(calls.length, 2);
  const third = readPr(home, nodeId).activeTask.dispatchId;
  writeResult(paths, third, {
    status: 'complete', ci: { requiredGreen: true, head: HEAD }, verification: { status: 'pass' },
    feedbackCoverage: { dispositions: [{ key: 'greptile:PRRT_new:c-new', disposition: 'fixed' }] },
    scs: [{ status: 'pass', feedbackKeys: ['greptile:PRRT_new:c-new'], evidence: ['fixed new'] }],
  });
  // Round 3: CI is green; both threads were fixed for the words they now show.
  discover(paths, { now: '2026-09-28T00:50:00Z', collect: () => collectBase({ threads: [editedOldThread, newThread], mergeReady: true }), dispatchFn: () => { throw new Error('no dispatch after complete'); }, recheckFn: () => ({}) });
  const closed = readPr(home, nodeId).autoClosedThreads ?? {};
  assert.ok(closed.PRRT_new, 'the third task closes its own thread');
  assert.ok(closed.PRRT_old, 'the second task evidence for the edited comment must close it');
});

test('R4-2 exhausted recoveries with no result reach missing-result-limit even when GitHub is unchanged', (t) => {
  const { home, paths } = homeOf(t);
  const dispatchId = 'live-790-silent';
  seedBound(paths, {
    pollFingerprint: SNAP_FINGERPRINT, rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z', recoveryCount: 3, lastRecoveryAt: '2026-09-28T01:30:00Z' },
    activeTask: { status: 'accepted', dispatchId, head: HEAD, sessionId: 'sess-790' },
  });
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' }, feedback: [],
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
  }));
  discover(paths, { now: '2026-09-28T02:05:00Z', collect: () => collectBase(), dispatchFn: () => { throw new Error('no fourth delivery'); }, recheckFn: () => ({}) });
  const entry = readPr(home, nodeId);
  assert.equal(entry.activeTask.blockedKind, 'missing-result-limit');
  assert.ok(pendingEvents(home).some((event) => event.kind === 'missing-result-limit'), 'the person must be told');
});

const mixedThread = {
  id: 'PRRT_mix', isResolved: false, isOutdated: false, path: 'src/m.ts',
  comments: [
    { id: 'c-p1', author: { login: 'greptile-apps[bot]' }, body: '**P1** crash on empty input', createdAt: now },
    { id: 'c-p2', author: { login: 'greptile-apps[bot]' }, body: '**P2** naming could be clearer', createdAt: now },
  ],
};

test('R4-3 a thread with a fixed P1 and an answered P2 closes after a complete green result', (t) => {
  const { home, paths } = homeOf(t);
  const dispatchId = 'live-mixed';
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'accepted', dispatchId, head: HEAD, sessionId: 'sess-790' },
  });
  const p1 = 'greptile:PRRT_mix:c-p1';
  const p2 = 'greptile:PRRT_mix:c-p2';
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' },
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
    feedback: [
      { key: p1, source: 'greptile', nativeId: 'PRRT_mix:c-p1', path: 'src/m.ts', body: mixedThread.comments[0].body },
      { key: p2, source: 'greptile', nativeId: 'PRRT_mix:c-p2', path: 'src/m.ts', body: mixedThread.comments[1].body },
    ],
    repairPolicy: { items: [{ key: p1, action: 'code-fix' }, { key: p2, action: 'reply-only' }] },
  }));
  writeResult(paths, dispatchId, {
    status: 'complete', ci: { requiredGreen: true, head: HEAD }, verification: { status: 'pass' },
    feedbackCoverage: { dispositions: [{ key: p1, disposition: 'fixed' }, { key: p2, disposition: 'no-change' }] },
    scs: [
      { status: 'pass', feedbackKeys: [p1], evidence: ['guarded empty input in src/m.ts'] },
      { status: 'no-change', feedbackKeys: [p2], evidence: ['P2 naming suggestion recorded, not changed'] },
    ],
  });
  discover(paths, { collect: () => collectBase({ threads: [mixedThread], mergeReady: true }), dispatchFn: () => { throw new Error('no dispatch after complete'); }, recheckFn: () => ({}) });
  assert.ok(readPr(home, nodeId).autoClosedThreads?.PRRT_mix, 'a fully handled mixed thread must close');
});

test('R5-2 a reopened thread handled again by a later task is answered and resolved again', (t) => {
  const { home, paths } = homeOf(t);
  const dispatchId = 'live-second';
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'accepted', dispatchId, head: HEAD, sessionId: 'sess-790' },
    autoClosedThreads: { PRRT_mix: { at: '2026-09-27T12:00:00Z', key: 'greptile:PRRT_mix:c-p1', reason: 'fixed', dispatchId: 'live-first' } },
  });
  const p1 = 'greptile:PRRT_mix:c-p1';
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' },
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
    feedback: [
      { key: p1, source: 'greptile', nativeId: 'PRRT_mix:c-p1', path: 'src/m.ts', body: mixedThread.comments[0].body },
    ],
    repairPolicy: { items: [{ key: p1, action: 'code-fix' }] },
  }));
  writeResult(paths, dispatchId, {
    status: 'complete', ci: { requiredGreen: true, head: HEAD }, verification: { status: 'pass' },
    feedbackCoverage: { dispositions: [{ key: p1, disposition: 'fixed' }] },
    scs: [
      { status: 'pass', feedbackKeys: [p1], evidence: ['guarded empty input in src/m.ts'] },
    ],
  });
  discover(paths, { collect: () => collectBase({ threads: [{ ...mixedThread, comments: [mixedThread.comments[0]] }], mergeReady: true }), dispatchFn: () => { throw new Error('no dispatch after complete'); }, recheckFn: () => ({}) });
  const receipt = readPr(home, nodeId).autoClosedThreads?.PRRT_mix;
  assert.equal(receipt?.dispatchId, 'live-second', 'the second fix must close the reopened thread');
});

test('R5-2 the same task never answers a thread twice', (t) => {
  const { home, paths } = homeOf(t);
  const dispatchId = 'live-second';
  seedBound(paths, {
    pollFingerprint: 'old', rulesVersion: rulesVersion(),
    lastDispatch: { dispatchId, at: '2026-09-28T00:00:00Z' },
    activeTask: { status: 'accepted', dispatchId, head: HEAD, sessionId: 'sess-790' },
    autoClosedThreads: { PRRT_mix: { at: '2026-09-27T12:00:00Z', key: 'greptile:PRRT_mix:c-p1', reason: 'fixed', dispatchId: dispatchId } },
  });
  const p1 = 'greptile:PRRT_mix:c-p1';
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 790, repo: process.env.MIVO_WATCHER_TARGET_REPO, sessionId: 'sess-790',
    headRefOid: HEAD, headRefName: 'fix/x', params: { message: 'fix' },
    handoff: handoffReceipt({ ...listed, releaseEpoch: 'e' }),
    feedback: [
      { key: p1, source: 'greptile', nativeId: 'PRRT_mix:c-p1', path: 'src/m.ts', body: mixedThread.comments[0].body },
    ],
    repairPolicy: { items: [{ key: p1, action: 'code-fix' }] },
  }));
  writeResult(paths, dispatchId, {
    status: 'complete', ci: { requiredGreen: true, head: HEAD }, verification: { status: 'pass' },
    feedbackCoverage: { dispositions: [{ key: p1, disposition: 'fixed' }] },
    scs: [
      { status: 'pass', feedbackKeys: [p1], evidence: ['guarded empty input in src/m.ts'] },
    ],
  });
  discover(paths, { collect: () => collectBase({ threads: [{ ...mixedThread, comments: [mixedThread.comments[0]] }], mergeReady: true }), dispatchFn: () => { throw new Error('no dispatch after complete'); }, recheckFn: () => ({}) });
  const receipt = readPr(home, nodeId).autoClosedThreads?.PRRT_mix;
  assert.equal(receipt?.at, '2026-09-27T12:00:00Z', 'a thread this task already closed is left alone');
});

test('R4-4 a notice lock left by a killed process is reclaimed', (t) => {
  const { home } = homeOf(t);
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.mkdirSync(path.join(home, 'state', 'notices'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'notices', 'pending.lock'), String(Number(dead.stdout)));
  const bin = fileURLToPath(new URL('./bin/notify.mjs', import.meta.url));
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import { enqueueNotice } from ${JSON.stringify(bin)}; enqueueNotice(process.env.NOTICE_HOME, { kind: 'merge-ready', number: 791, head: 'h' });`], {
    encoding: 'utf8', env: { ...process.env, NOTICE_HOME: home },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(Date.now() - started < 5000, 'a dead holder must not make writers wait out the timeout');
  assert.ok(pendingEvents(home).some((event) => event.number === 791));
  assert.equal(fs.existsSync(path.join(home, 'state', 'notices', 'pending.lock')), false);
});

test('R5-1 a reclaimer that saw a dead lock cannot delete a newer live lock', async (t) => {
  const { home } = homeOf(t);
  const notices = path.join(home, 'state', 'notices');
  fs.mkdirSync(notices, { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  fs.writeFileSync(path.join(notices, 'pending.lock'), String(Number(dead.stdout)));
  fs.writeFileSync(path.join(notices, 'pending.json'), JSON.stringify({ events: [] }));
  const bin = fileURLToPath(new URL('./bin/notify.mjs', import.meta.url));
  const common = `import fs from 'node:fs'; import path from 'node:path'; import { enqueueNotice } from ${JSON.stringify(bin)};
    const home = ${JSON.stringify(home)}; const read = fs.readFileSync;
    const flag = (name) => path.join(home, name);
    const wait = (name) => { const start = Date.now(); while (!fs.existsSync(flag(name))) { if (Date.now() - start > 6000) throw new Error('timeout ' + name); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); } };`;
  const child = (source) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    proc.stderr.on('data', (chunk) => { err += chunk; });
    t.after(() => proc.kill('SIGKILL'));
    return new Promise((resolve) => proc.once('exit', (code) => resolve({ code, err })));
  };
  const until = async (name) => { const start = Date.now(); while (!fs.existsSync(path.join(home, name))) { if (Date.now() - start > 6000) throw new Error(`timeout ${name}`); await new Promise((r) => setTimeout(r, 5)); } };
  // A pauses right after its second look at the dead lock, the moment before it would remove it.
  const a = child(common + `let reads = 0; fs.readFileSync = function (file, ...rest) { const value = read.call(this, file, ...rest);
    if (String(file).endsWith('/pending.lock') && ++reads === 2) { fs.writeFileSync(flag('a-paused'), ''); wait('release-a'); } return value; };
    enqueueNotice(home, { kind: 'merge-ready', number: 20, head: 'h' });`);
  await until('a-paused');
  // B pauses while holding the lock, after reading the queue.
  const b = child(common + `fs.readFileSync = function (file, ...rest) { const value = read.call(this, file, ...rest);
    if (String(file).endsWith('/pending.json')) { fs.readFileSync = read; fs.writeFileSync(flag('b-locked'), ''); wait('release-b'); } return value; };
    enqueueNotice(home, { kind: 'merge-ready', number: 21, head: 'h' });`);
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(home, 'release-a'), '');
  const ar = await a;
  fs.writeFileSync(path.join(home, 'release-b'), '');
  const br = await b;
  assert.equal(ar.code, 0, ar.err);
  assert.equal(br.code, 0, br.err);
  assert.deepEqual(pendingEvents(home).map((event) => event.number).sort(), [20, 21], 'both queued notices must survive');
});
