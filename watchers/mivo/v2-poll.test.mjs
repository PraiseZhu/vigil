import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePollSnapshot, pollFingerprint, scanOnce, watcherPaths, watchDispatchConflictMessage } from './bin/mivo-watcher.mjs';
import { planSessionTitle, repairSessionTitle } from './bin/session-title.mjs';
import { readPr, writePr as writePrState } from './bin/mivo-state.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const now = '2026-09-28T00:00:00Z';
const nodeId = 'PR_790';

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-poll-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { home, paths };
}

function snap(extra = {}) {
  return {
    state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: now,
    mergeable: 'MERGEABLE', labels: [], checkState: 'SUCCESS', commentCount: 1, reviewCount: 0,
    commentUpdatedAt: now, reviewUpdatedAt: null, unresolvedThreads: 0, ...extra,
  };
}

function seed(paths, extra = {}) {
  const handoff = handoffReceipt({ id: nodeId, number: 790, headRefOid: HEAD, releaseEpoch: 'e' });
  writePrState(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: handoff.releaseEpoch, handoff, activeTask: { status: 'complete' },
    headRefName: 'fix/x', title: 'fix', ...extra,
  });
}

// Closedown runs git cleanup; tests must never touch the real plugin repo.
function fakeGit(t, { status = '' } = {}) {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-poll-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const calls = [];
  const gitFn = (_bin, args) => { calls.push(args); if (args.includes('status')) return status; return ''; };
  return { plugin, calls, gitFn, env: { MIVO_PLUGIN_REPO: plugin } };
}

function poll(paths, { snapshot, collect, dispatchFn, enabled = true, recheckFn, git, budgetMs, clock, ownershipSnapshot, authorHandoff = true } = {}) {
  let collected = 0;
  const result = scanOnce({
    mode: 'poll', enabled, allowDispatch: true, paths, now, nodeId, prNumber: 790,
    snapshotFn: () => snapshot,
    ghFn: (args) => args[0] === 'api' ? 'owner' : '[]',
    collect: (...args) => {
      collected += 1;
      if (typeof collect === 'function') {
        const value = collect(...args);
        return authorHandoff ? withAuthorHandoff(value, args[0]) : value;
      }
      throw new Error('collect should not run');
    },
    dispatchFn, recheckFn, clock,
    ...(budgetMs ? { budgetMs } : {}),
    ...(git ? { gitFn: git.gitFn, env: git.env } : {}),
    ownershipSnapshot: ownershipSnapshot ?? function* () {
      return { pr: handoffPr({ id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' }) };
    },
  });
  return { result, collected, entry: readPr(paths.home, nodeId) };
}

test('same SHA pending to failed changes fingerprint', () => {
  const pending = pollFingerprint(snap({
    checks: [{ name: 'unit', status: 'IN_PROGRESS', conclusion: null, id: 21, detailsUrl: 'https://github.com/x/y/runs/21/attempts/1' }],
  }));
  const failed = pollFingerprint(snap({
    checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', id: 21, detailsUrl: 'https://github.com/x/y/runs/21/attempts/1' }],
  }));
  assert.notEqual(pending, failed);
});

test('rerun with new attempt changes fingerprint', () => {
  const first = pollFingerprint(snap({
    checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', id: 21, detailsUrl: 'https://github.com/x/y/runs/21/attempts/1' }],
  }));
  const rerun = pollFingerprint(snap({
    checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', id: 21, detailsUrl: 'https://github.com/x/y/runs/21/attempts/2' }],
  }));
  assert.notEqual(first, rerun);
});

test('new unresolved thread changes fingerprint', () => {
  const none = pollFingerprint(snap({
    reviewThreads: [], unresolvedThreads: 0,
  }));
  const added = pollFingerprint(normalizePollSnapshot({
    ...snap(),
    reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ updatedAt: '2026-09-28T03:00:00Z' }] } }] },
  }));
  assert.notEqual(none, added);
});

test('label page overflow plus collect opt-out skips dispatch', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { pollFingerprint: pollFingerprint(snap()) });
  const { result, entry } = poll(paths, {
    snapshot: snap({ overflow: true, labels: [] }),
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, labels: ['mivo-watch:off'], mergeReady: false,
      checks: [], comments: [], reviews: [], threads: [],
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: () => { throw new Error('should not dispatch'); },
  });
  assert.equal(result.prs[0].dispatch.reason, 'opt-out');
  assert.equal(entry.optOut, true);
});

test('graphql overflow forces full collect', (t) => {
  const { paths } = homeOf(t);
  const fingerprint = pollFingerprint(snap({ overflow: true }));
  seed(paths, { pollFingerprint: fingerprint });
  const { collected } = poll(paths, {
    snapshot: snap({ overflow: true }),
    collect: () => { throw new Error('forced collect'); },
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
  });
  assert.equal(collected, 1);
});

test('unchanged fingerprint writes heartbeat and skips collect', (t) => {
  const { paths } = homeOf(t);
  const fingerprint = pollFingerprint(snap());
  seed(paths, { pollFingerprint: fingerprint });
  const { result, collected, entry } = poll(paths, { snapshot: snap() });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.equal(entry.heartbeatAt, now);
});

test('a repair result written after the last poll is read even when the PR fingerprint is unchanged', (t) => {
  const { paths } = homeOf(t);
  seedInFlight(paths);
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', 'live-790-old.json'), JSON.stringify({
    schemaVersion: 2, dispatchId: 'live-790-old', nodeId, sessionId: 'sess-790', status: 'complete', head: HEAD,
    receiptId: 'r-new', ci: { requiredGreen: true, head: HEAD }, verification: { status: 'not-required-no-change' }, scs: [],
  }));
  const { collected } = poll(paths, { snapshot: snap(), collect: () => { throw new Error('forced collect'); } });
  assert.equal(collected, 1);
});

test('dispatch-conflict still polls owner and alerts only once', (t) => {
  const { paths } = homeOf(t);
  seed(paths, {
    pollFingerprint: pollFingerprint(snap()),
    dispatchConflict: {
      bindSession: 'sess-790', receiptSession: 'sess-other', dispatchId: 'live-790-x', at: now,
    },
  });
  const calls = [];
  const collectFailCi = () => ({
    pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true,
    checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
    ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
    policy: { status: 'verified', required: [{ context: 'unit' }] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  });
  const first = poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T01:00:00Z', commentCount: 2 }),
    collect: collectFailCi,
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(first.collected, 1);
  assert.equal(calls[0].target_session_id, 'sess-790');
  assert.match(calls[0].message, /回执冲突/);
  assert.equal(first.entry.dispatchConflict.notifiedAt, now);
  assert.match(watchDispatchConflictMessage({
    prNumber: 790, bindSession: 'sess-790', receiptSession: 'sess-other', dispatchId: 'live-790-x',
  }), /人工归档多余 session/);
  const later = poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T02:00:00Z', commentCount: 3 }),
    collect: collectFailCi,
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(later.collected, 1);
  assert.equal(calls.filter((p) => /回执冲突/.test(p.message)).length, 1);
  assert.equal(calls.at(-1).target_session_id, 'sess-790');
  assert.doesNotMatch(calls.at(-1).message, /回执冲突/);
});

test('dispatch-conflict without persisted title falls back to repairSessionTitle', (t) => {
  const { paths } = homeOf(t);
  seed(paths, {
    title: undefined,
    pollFingerprint: pollFingerprint(snap()),
    dispatchConflict: {
      bindSession: 'sess-790', receiptSession: 'sess-other', dispatchId: 'live-790-x', at: now,
    },
  });
  const calls = [];
  const collectFailCi = () => ({
    pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true,
    checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
    ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
    policy: { status: 'verified', required: [{ context: 'unit' }] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  });
  poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T01:00:00Z', commentCount: 2 }),
    collect: collectFailCi,
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  // pollWorkflow only has { number } in scope at this call site, never a title.
  assert.equal(calls[0].title, repairSessionTitle({ prNumber: 790, createdAt: now }));
});

test('poll resets closedHandled when OPEN after close', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { closedHandled: true, pollFingerprint: pollFingerprint(snap()) });
  const { entry, collected } = poll(paths, {
    snapshot: snap(),
    dispatchFn: () => { throw new Error('should not dispatch'); },
  });
  assert.equal(collected, 0);
  assert.equal(entry.closedHandled, false);
  assert.equal(entry.reopenedAt, now);
});

test('fingerprint change dispatches to bound session', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { pollFingerprint: pollFingerprint(snap()) });
  let params;
  const { result, collected } = poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T01:00:00Z', commentCount: 2 }),
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true,
      checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
      ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
      policy: { status: 'verified', required: [{ context: 'unit' }] },
      comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
    }),
    dispatchFn: (p) => { params = p; return { target_session_id: 'sess-790' }; },
  });
  assert.equal(collected, 1);
  assert.equal(params.target_session_id, 'sess-790');
  assert.equal(result.prs[0].dispatch.attempted, true);
});

test('MERGED is cleaned up by the script once, without waking the session', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { scheduleId: 'sched-legacy' });
  const git = fakeGit(t);
  const calls = [];
  const first = poll(paths, { snapshot: snap({ state: 'MERGED' }), dispatchFn: (p) => { calls.push(p); return {}; }, git });
  assert.equal(calls.length, 0);
  assert.equal(first.result.prs[0].dispatch.reason, 'closedown-script');
  assert.equal(first.entry.closedHandled, true);
  assert.equal(first.entry.autoCleanup.removed, true);
  assert.ok(git.calls.some((args) => args.includes('branch') && args.includes('watch/pr-790')));
  // A legacy per-PR schedule cannot be deleted by a script, so it is listed for a human.
  assert.equal(first.entry.closedownManual.scheduleId, 'sched-legacy');
  const second = poll(paths, { snapshot: snap({ state: 'MERGED' }), dispatchFn: (p) => { calls.push(p); return {}; }, git });
  assert.equal(calls.length, 0);
  assert.equal(second.result.prs[0].dispatch.reason, 'closed-handled');
});

test('MERGED with a dirty watch worktree keeps it and records it for a human', (t) => {
  const { paths } = homeOf(t);
  seed(paths);
  const git = fakeGit(t, { status: ' M src/a.ts' });
  fs.mkdirSync(path.join(git.plugin, '.worktrees', 'watch', 'pr-790'), { recursive: true });
  const { entry } = poll(paths, { snapshot: snap({ state: 'MERGED' }), dispatchFn: () => { throw new Error('must not dispatch'); }, git });
  assert.equal(entry.closedHandled, true);
  assert.equal(entry.autoCleanup.removed, false);
  assert.equal(entry.closedownManual.reason, 'dirty');
  assert.ok(!git.calls.some((args) => args.includes('remove')));
});

test('CLOSED without merge keeps the worktree and runs no git', (t) => {
  const { paths } = homeOf(t);
  seed(paths);
  const git = fakeGit(t);
  const { entry, result } = poll(paths, { snapshot: snap({ state: 'CLOSED' }), dispatchFn: () => { throw new Error('must not dispatch'); }, git });
  assert.equal(result.prs[0].dispatch.reason, 'closedown-script');
  assert.equal(entry.closedHandled, true);
  assert.equal(entry.closedownManual.reason, 'closed-unmerged-kept');
  assert.equal(git.calls.length, 0);
});

test('mivo-watch:off does not dispatch', (t) => {
  const { paths } = homeOf(t);
  seed(paths);
  let sent = 0;
  const { result, collected, entry } = poll(paths, {
    snapshot: snap({ labels: ['mivo-watch:off'] }),
    dispatchFn: () => { sent += 1; return { target_session_id: 'sess-790' }; },
  });
  assert.equal(sent, 0);
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'opt-out');
  assert.equal(entry.optOut, true);
  assert.equal(entry.heartbeatAt, now);
});

test('recheck failure does not commit fingerprint', (t) => {
  const { paths } = homeOf(t);
  const oldFp = pollFingerprint(snap());
  seed(paths, {
    pollFingerprint: oldFp,
    activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: 'd1', head: HEAD },
    lastDispatch: { dispatchId: 'd1' },
  });
  const { entry } = poll(paths, {
    snapshot: snap({ commentCount: 8, commentUpdatedAt: '2026-09-28T05:00:00Z' }),
    collect: () => ({
      pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
      admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
      ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
    }),
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
    recheckFn: () => { throw new Error('PR 状态锁占用，请稍后重试写结果'); },
  });
  assert.equal(entry.pollFingerprint, oldFp);
  assert.equal(entry.collectRetry, true);
  assert.equal(entry.lastRecheckError.at, now);
});

const waitingCollect = () => ({
  pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
  admissionVerified: true, checks: [], comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] },
});
test('a recheck is not started on a budget too small to finish; it is deferred without an error', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { pollFingerprint: 'old', activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: 'd1', head: HEAD }, lastDispatch: { dispatchId: 'd1' } });
  const calls = [];
  const { entry } = poll(paths, { snapshot: snap(), collect: waitingCollect, budgetMs: 30000,
    dispatchFn: () => ({ target_session_id: 'sess-790' }), recheckFn: (args) => { calls.push(args); return {}; } });
  assert.equal(calls.length, 0);
  assert.equal(entry.recheckDeferredAt, now);
  assert.equal(entry.lastRecheckError, undefined);
});
test('a recheck with enough budget runs with room beyond the old 30s cap', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { pollFingerprint: 'old', activeTask: { status: 'waiting-ci', evidenceVersion: 2, dispatchId: 'd1', head: HEAD }, lastDispatch: { dispatchId: 'd1' } });
  const calls = [];
  poll(paths, { snapshot: snap(), collect: waitingCollect,
    dispatchFn: () => ({ target_session_id: 'sess-790' }), recheckFn: (args) => { calls.push(args); return {}; } });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].timeoutMs > 30000 && calls[0].timeoutMs <= 60000);
});

test('collect failure does not commit fingerprint and retries next round', (t) => {
  const { paths } = homeOf(t);
  const oldFp = pollFingerprint(snap());
  seed(paths, { pollFingerprint: oldFp });
  const changed = snap({ commentCount: 9, commentUpdatedAt: '2026-09-28T04:00:00Z' });
  const first = poll(paths, {
    snapshot: changed,
    collect: () => { throw new Error('gh timeout'); },
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
  });
  assert.equal(first.result.prs[0].dispatch.reason, 'collection-failed');
  assert.equal(first.entry.pollFingerprint, oldFp);
  assert.equal(first.entry.collectRetry, true);
  let collected = 0;
  const second = poll(paths, {
    snapshot: changed,
    collect: () => {
      collected += 1;
      throw new Error('gh timeout again');
    },
    dispatchFn: () => ({ target_session_id: 'sess-790' }),
  });
  assert.equal(collected, 1);
  assert.equal(second.entry.pollFingerprint, oldFp);
});

for (const gate of [
  { name: '65s collection reserve', collectMs: 56000, ownershipMs: 0, ownershipCalls: 0 },
  { name: '61s ownership reserve', collectMs: 20000, ownershipMs: 40000, ownershipCalls: 1 },
]) {
  for (const retryAlreadyPending of [false, true]) {
    test(`budget-deferred poll at ${gate.name} retries unchanged feedback${retryAlreadyPending ? ' with an existing retry marker' : ''}`, (t) => {
      const { paths } = homeOf(t);
      const snapshot = snap({ commentCount: 9, commentUpdatedAt: '2026-09-28T04:00:00Z' });
      const previousFingerprint = retryAlreadyPending ? pollFingerprint(snapshot) : pollFingerprint(snap());
      const feedbackCursor = { prior: 'observed' };
      seed(paths, { pollFingerprint: previousFingerprint, collectRetry: retryAlreadyPending, feedbackCursor, repairRounds: 2 });
      const calls = [];
      let elapsed = 0;
      let slow = true;
      let ownershipCalls = 0;
      const options = {
        snapshot, budgetMs: 120000, clock: () => elapsed,
        collect: () => { elapsed += slow ? gate.collectMs : 0; return collectFailedCi(); },
        ownershipSnapshot: function* () {
          ownershipCalls += 1;
          elapsed += slow ? gate.ownershipMs : 0;
          return { pr: handoffPr({ id: nodeId, number: 790, ...collectFailedCi().pr }) };
        },
        dispatchFn: (params) => { calls.push(params); return { target_session_id: 'sess-790' }; },
      };
      // An already pending retry must survive consecutive rounds with too little time.
      for (let round = 0; round < (retryAlreadyPending ? 2 : 1); round += 1) {
        const deferred = poll(paths, options);
        assert.equal(deferred.result.prs[0].dispatch.reason, 'dispatch-budget-deferred');
        assert.equal(deferred.collected, 1);
        assert.equal(ownershipCalls, gate.ownershipCalls * (round + 1));
        assert.equal(calls.length, 0);
        assert.deepEqual(deferred.entry.feedbackCursor, feedbackCursor);
        assert.equal(deferred.entry.repairRounds, 2);
        assert.equal(deferred.entry.activeTask.status, 'complete');
        assert.equal(deferred.entry.pollFingerprint, previousFingerprint);
        assert.equal(deferred.entry.collectRetry, true);
      }
      slow = false;
      const delivered = poll(paths, options);
      assert.equal(delivered.collected, 1);
      assert.equal(delivered.result.prs[0].dispatch.attempted, true);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].target_session_id, 'sess-790');
      assert.equal(delivered.entry.repairRounds, 3);
      assert.notDeepEqual(delivered.entry.feedbackCursor, feedbackCursor);
      assert.equal(delivered.entry.pollFingerprint, pollFingerprint(snapshot));
      assert.equal(delivered.entry.collectRetry, false);
      const unchanged = poll(paths, options);
      assert.equal(unchanged.collected, 0);
      assert.equal(unchanged.result.prs[0].dispatch.reason, 'fingerprint-unchanged');
      assert.equal(unchanged.entry.repairRounds, 3);
      assert.equal(calls.length, 1);
    });
  }
}

test('missing sessionId records needsOwner and does not create', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { sessionId: null });
  let sent = 0;
  const { result, collected, entry } = poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T02:00:00Z' }),
    dispatchFn: () => { sent += 1; return { target_session_id: 'new' }; },
  });
  assert.equal(sent, 0);
  assert.equal(collected, 0);
  assert.equal(result.prs[0].needsOwner, true);
  assert.equal(entry.needsOwner, true);
  assert.equal(entry.sessionId, null);
});

test('repairSessionTitle uses #N-task format without project prefix', () => {
  assert.equal(
    repairSessionTitle({ task: '终态回执修复', prNumber: 558, createdAt: '2026-09-28' }),
    '#558-终态回执修复丨0928',
  );
});

test('planSessionTitle keeps new titles and rewrites old titles', () => {
  const pr = { id: 'PR_558', number: 558, title: '终态回执修复' };
  const kept = planSessionTitle({
    pr, existing: { title: '#558-终态回执修复丨0928', titleDate: '2026-09-28' }, createdAt: '2026-09-28',
  });
  assert.equal(kept.title, '#558-终态回执修复丨0928');
  const rewritten = planSessionTitle({
    pr, existing: { title: 'MivoPlugin-#558-终态回执修复丨 0928', titleDate: '2026-09-28' }, createdAt: '2026-09-28',
  });
  assert.equal(rewritten.title, '#558-终态回执修复丨0928');
});

test('maintenance script treats only the new title as canonical', () => {
  const src = fs.readFileSync(new URL('./bin/session-title-maintenance.py', import.meta.url), 'utf8');
  const match = src.match(/if not re\.fullmatch\(r"([^"]+)",\s*change\.get\("title"/);
  assert.ok(match);
  const re = new RegExp(`^${match[1]}$`, 'u');
  assert.equal(re.test('#558-终态回执修复丨0928'), true);
  assert.equal(re.test('MivoPlugin-#558-终态回执修复丨 0928'), false);
});

function collectFailedCi() {
  return {
    pr: { id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true,
    checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
    ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
    policy: { status: 'verified', required: [{ context: 'unit' }] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  };
}

function seedInFlight(paths, extra = {}) {
  seed(paths, {
    pollFingerprint: pollFingerprint(snap()),
    activeTask: { dispatchId: 'live-790-old', sessionId: 'sess-790', head: HEAD, status: 'accepted' },
    lastDispatch: { dispatchId: 'live-790-old', at: '2026-09-27T00:00:00Z', recoveryCount: 0 },
    ...extra,
  });
}

test('Ready -> Draft supersedes the in-flight task without an incident event', (t) => {
  const { paths } = homeOf(t);
  seedInFlight(paths);
  const { result, entry } = poll(paths, {
    snapshot: snap({ isDraft: true, updatedAt: '2026-09-28T01:00:00Z' }),
    dispatchFn: () => { throw new Error('draft must not dispatch'); },
  });
  assert.equal(result.prs[0].dispatch.reason, 'draft');
  assert.equal(entry.activeTask.status, 'blocked');
  assert.equal(entry.activeTask.blockedKind, 'author-reclaimed');
  assert.deepEqual(entry.authorReclaimed, { at: now, dispatchId: 'live-790-old' });
  assert.equal(entry.wasDraft, true);
  assert.equal(entry.lastException, undefined);
  assert.equal((result.events ?? []).length, 0);
});

test('staying Draft does not re-stamp the reclaim', (t) => {
  const { paths } = homeOf(t);
  seedInFlight(paths, {
    wasDraft: true,
    activeTask: { dispatchId: 'live-790-old', status: 'blocked', blockedKind: 'author-reclaimed', at: '2026-09-27T12:00:00Z' },
    authorReclaimed: { at: '2026-09-27T12:00:00Z', dispatchId: 'live-790-old' },
  });
  const { entry } = poll(paths, {
    snapshot: snap({ isDraft: true, updatedAt: '2026-09-28T01:00:00Z' }),
    dispatchFn: () => { throw new Error('draft must not dispatch'); },
  });
  assert.equal(entry.authorReclaimed.at, '2026-09-27T12:00:00Z');
});

test('completed task is not superseded by a later Draft', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { pollFingerprint: pollFingerprint(snap()), activeTask: { dispatchId: 'live-790-done', status: 'complete' } });
  const { entry } = poll(paths, {
    snapshot: snap({ isDraft: true, updatedAt: '2026-09-28T01:00:00Z' }),
    dispatchFn: () => { throw new Error('draft must not dispatch'); },
  });
  assert.equal(entry.activeTask.status, 'complete');
  assert.equal(entry.authorReclaimed, undefined);
});

test('re-Ready after reclaim dispatches fresh work with the reset note, not a recovery', (t) => {
  const { paths } = homeOf(t);
  seedInFlight(paths);
  poll(paths, {
    snapshot: snap({ isDraft: true, updatedAt: '2026-09-28T01:00:00Z' }),
    dispatchFn: () => { throw new Error('draft must not dispatch'); },
  });
  // A stale pre-draft result for the superseded task must not revive it.
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', 'live-790-old.json'), JSON.stringify({
    dispatchId: 'live-790-old', nodeId, sessionId: 'sess-790', status: 'waiting-ci', head: HEAD, schemaVersion: 2,
  }));
  const calls = [];
  const { result, entry } = poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T02:00:00Z', commentCount: 2 }),
    collect: collectFailedCi,
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target_session_id, 'sess-790');
  assert.match(calls[0].message, /作者收回过本 PR/);
  assert.match(calls[0].message, /git reset --hard origin\/fix\/x/);
  assert.match(calls[0].message, /live-790-old/);
  assert.notEqual(entry.lastDispatch.dispatchId, 'live-790-old');
  const later = poll(paths, {
    snapshot: snap({ updatedAt: '2026-09-28T03:00:00Z', commentCount: 3 }),
    collect: () => ({ ...collectFailedCi(), ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 9, runId: 9, attempt: 1 } }] } }),
    dispatchFn: (p) => { calls.push(p); return { target_session_id: 'sess-790' }; },
  });
  assert.ok(later);
  for (const p of calls.slice(1)) assert.doesNotMatch(p.message, /作者收回过本 PR/);
});

test('a pushed HEAD waits for its late result without revoking the author handoff', (t) => {
  const { paths } = homeOf(t);
  seedInFlight(paths);
  const nextHead = 'c'.repeat(40);
  const original = withAuthorHandoff(collectFailedCi(), { id: nodeId, number: 790, headRefOid: HEAD });
  const collected = { ...original, pr: { ...original.pr, headRefOid: nextHead }, checks: [],
    ci: { status: 'pending', required: [] } };
  const snapshot = snap({ headRefOid: nextHead });
  const options = { snapshot, authorHandoff: false, collect: () => collected,
    dispatchFn: () => { throw new Error('unconfirmed HEAD must not create another writer'); } };
  const first = poll(paths, options);
  assert.equal(first.result.prs[0].dispatch.reason, 'head-change-unconfirmed');
  assert.equal(first.entry.activeTask.status, 'accepted');
  assert.equal(first.entry.handoff.head, HEAD);
  assert.equal(first.entry.authorReclaimed, undefined);
  assert.equal(poll(paths, options).collected, 0);

  const late = { schemaVersion: 2, kind: 'mivo-repair-result', dispatchId: 'live-790-old',
    nodeId, number: 790, repo: original.pr.repo, sessionId: 'sess-790', head: nextHead,
    status: 'waiting-ci', pushed: true, verification: { status: 'pass', head: nextHead }, receiptId: 'late-push-result' };
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'results', 'live-790-old.json'), JSON.stringify(late));
  const resumed = poll(paths, { ...options, recheckFn: () => late });
  assert.equal(resumed.collected, 1, 'a result must be consumed even without a new PR fingerprint');
  assert.equal(resumed.entry.activeTask.status, 'waiting-ci');
  assert.equal(resumed.entry.activeTask.head, nextHead);
  assert.equal(resumed.entry.handoff.id, first.entry.handoff.id);
  assert.equal(resumed.entry.authorReclaimed, undefined);

  const draft = poll(paths, { snapshot: snap({ headRefOid: nextHead, isDraft: true }),
    dispatchFn: options.dispatchFn });
  assert.equal(draft.entry.activeTask.blockedKind, 'author-reclaimed');
  assert.equal(draft.entry.handoff, null);
});
