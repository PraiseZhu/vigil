import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFLICT_FEEDBACK_KEY, conflictDispatchDue, pollFingerprint, scanOnce, watcherPaths } from './bin/mivo-watcher.mjs';
import { readPr, writePr as writePrState } from './bin/mivo-state.mjs';
import { handoffPr, handoffReceipt, isChildPrList, withAuthorHandoff } from './handoff.fixture.mjs';

// 2026-11-05: #1746 stayed CONFLICTING while every round reported `fingerprint-unchanged`. The conflict had been
// delivered once (its cursor stamp is head + mergeable), the repair session then blocked, and nothing ever sent a
// repair for the still-open conflict again. A conflict is now a standing condition: it opens the fingerprint gate
// and is re-delivered once per head/base-tip pair.
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const MOVED = 'd'.repeat(40);
const now = '2026-11-05T00:00:00Z';
const nodeId = 'PR_1746';

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-dispatch-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { home, paths };
}

function snap(extra = {}) {
  return {
    state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: now,
    mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseTipOid: TIP,
    labels: [], checkState: 'SUCCESS', commentCount: 0, reviewCount: 0,
    commentUpdatedAt: null, reviewUpdatedAt: null, unresolvedThreads: 0, ...extra,
  };
}

// The cursor stamp the watcher writes for the conflict item: revision : digest({mergeable, baseTip}) : sha.
const conflictStamp = ({ baseTip = TIP } = {}) => {
  const hash = createHash('sha256').update(JSON.stringify({ mergeable: 'CONFLICTING', baseTip })).digest('hex');
  return `${HEAD}:${hash}:${HEAD}`;
};

function seed(paths, extra = {}) {
  const handoff = handoffReceipt({ id: nodeId, number: 1746, headRefOid: HEAD, releaseEpoch: 'e' });
  writePrState(paths.home, nodeId, {
    number: 1746, nodeId, sessionId: 'sess-1746', eligibilityInitialized: true, eligibility: 'blocked',
    admissionVerified: true, admissionEpoch: handoff.releaseEpoch, handoff,
    activeTask: {
      dispatchId: 'live-1746-old', sessionId: 'sess-1746', head: HEAD, status: 'blocked',
      blockedKind: 'external', reason: 'pre-push preflight could not produce a receipt',
    },
    lastDispatch: { dispatchId: 'live-1746-old', at: '2026-11-04T00:00:00Z', recoveryCount: 0 },
    headRefName: 'fix/1746', title: '#1746-恢复视频生成格丨1104', titleDate: '2026-11-04',
    feedbackCursor: { 'conflict:merge-conflict': conflictStamp() },
    pollFingerprint: pollFingerprint(snap()),
    ...extra,
  });
}

function collectedConflict(extra = {}) {
  return {
    pr: {
      id: nodeId, number: 1746, state: 'OPEN', isDraft: false, sameRepository: true,
      author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e',
    },
    mergeable: 'CONFLICTING', baseTipOid: TIP,
    admissionVerified: true,
    checks: [],
    ci: { status: 'green', required: [] },
    policy: { status: 'verified', required: [] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
    ...extra,
  };
}

// Every gh read the round makes is logged; the child-PR list and the head-rules read are answered as "none / no
// rules", like the other mivo tests, so a stub never holds a dispatch back by accident.
function ghStub(calls, { childPrs = '[[]]' } = {}) {
  return (args) => {
    calls.push(args);
    if (isChildPrList(args)) {
      if (childPrs instanceof Error) throw childPrs;
      return childPrs;
    }
    if (args[0] === 'api' && String(args[1] ?? '').includes('/rules/branches/')) return '[[]]';
    if (args[0] === 'api') return 'owner';
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: nodeId, state: 'OPEN' });
    return '[]';
  };
}

function poll(paths, { snapshot, collect, dispatchFn, enabled = true, allowDispatch = true, calls = [], childPrs }) {
  let collected = 0;
  const result = scanOnce({
    mode: 'poll', enabled, allowDispatch, paths, now, nodeId, prNumber: 1746,
    snapshotFn: () => snapshot,
    ghFn: ghStub(calls, { childPrs }),
    collect: (...args) => {
      collected += 1;
      return withAuthorHandoff(collect(...args), args[0]);
    },
    dispatchFn,
    ownershipSnapshot: function* () {
      return { pr: handoffPr({
        id: nodeId, number: 1746, state: 'OPEN', isDraft: false, sameRepository: true,
        author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e',
      }) };
    },
  });
  return { result, collected, entry: readPr(paths.home, nodeId) };
}

test('conflictDispatchDue tracks the head/base-tip pair and the 60-minute head cooldown', () => {
  const at = (value) => ({ head: HEAD, baseTip: TIP, at: value });
  assert.equal(conflictDispatchDue({ previous: {}, snapshot: snap(), now }), true, 'a new conflict is due at once');
  assert.equal(conflictDispatchDue({ previous: { conflictDispatch: at('2026-11-04T23:00:00Z') }, snapshot: snap(), now }), false,
    'the same head and base tip is sent once');
  assert.equal(conflictDispatchDue({
    previous: { conflictDispatch: at('2026-11-04T23:30:00Z') }, snapshot: snap({ baseTipOid: MOVED }), now,
  }), false, 'a moved base inside the cooldown waits');
  assert.equal(conflictDispatchDue({
    previous: { conflictDispatch: at('2026-11-04T22:00:00Z') }, snapshot: snap({ baseTipOid: MOVED }), now,
  }), true, 'a moved base after the cooldown is due again');
  assert.equal(conflictDispatchDue({
    previous: { conflictDispatch: at('2026-11-04T23:59:00Z') }, snapshot: snap({ headRefOid: MOVED }), now,
  }), true, 'a new head is due at once');
  assert.equal(conflictDispatchDue({ previous: {}, snapshot: snap({ mergeable: 'MERGEABLE' }), now }), false);
  assert.equal(conflictDispatchDue({ previous: {}, snapshot: snap({ baseTipOid: null }), now }), false);
});

test('the 60-minute cooldown is exact, and bad shas or times never make a conflict due', () => {
  const moved = snap({ baseTipOid: MOVED });
  const sent = (at) => ({ conflictDispatch: { head: HEAD, baseTip: TIP, at } });
  assert.equal(conflictDispatchDue({ previous: sent('2026-11-04T23:00:00.001Z'), snapshot: moved, now }), false, '59:59.999 waits');
  assert.equal(conflictDispatchDue({ previous: sent('2026-11-04T23:00:00.000Z'), snapshot: moved, now }), true, 'exactly 60:00 is due');
  assert.equal(conflictDispatchDue({ previous: sent('not a time'), snapshot: moved, now }), false, 'an unreadable time is not due');
  assert.equal(conflictDispatchDue({ previous: {}, snapshot: snap({ headRefOid: 'abc' }), now }), false);
  assert.equal(conflictDispatchDue({ previous: {}, snapshot: snap({ baseTipOid: 'z'.repeat(40) }), now }), false);
});

test('a repair that is running, a pending delivery or a dispatch conflict closes the conflict gate', () => {
  assert.equal(conflictDispatchDue({
    previous: { activeTask: { status: 'accepted' } }, snapshot: snap(), now,
  }), false, 'a running repair must not have its head moved under it');
  assert.equal(conflictDispatchDue({
    previous: { activeTask: { status: 'queued' } }, snapshot: snap(), now,
  }), false, 'a queued repair is running too');
  assert.equal(conflictDispatchDue({
    previous: { activeTask: { status: 'waiting-ci' } }, snapshot: snap(), now,
  }), true, 'a repair waiting for CI can take a conflict task');
  assert.equal(conflictDispatchDue({
    previous: { activeTask: { status: 'blocked', blockedKind: 'external' } }, snapshot: snap(), now,
  }), true, 'a blocked repair is not running');
  assert.equal(conflictDispatchDue({
    previous: { pendingDispatch: { dispatchId: 'x' } }, snapshot: snap(), now,
  }), false);
  assert.equal(conflictDispatchDue({
    previous: { dispatchConflict: { at: now } }, snapshot: snap(), now,
  }), false);
});

test('a conflict already in the cursor is still collected and dispatched', (t) => {
  const { paths } = homeOf(t);
  seed(paths);
  let params;
  const { result, collected, entry } = poll(paths, {
    snapshot: snap(),
    collect: collectedConflict,
    dispatchFn: (value) => { params = value; return { target_session_id: 'sess-1746' }; },
  });
  assert.equal(collected, 1, 'the fingerprint gate must not skip a due conflict');
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.equal(result.prs[0].dispatch.bound, true);
  assert.match(params.message, /"key":"conflict:merge-conflict"/);
  assert.match(params.message, /git merge origin\/main/);
  assert.deepEqual(
    { head: entry.conflictDispatch.head, baseTip: entry.conflictDispatch.baseTip, dispatchId: entry.conflictDispatch.dispatchId },
    { head: HEAD, baseTip: TIP, dispatchId: entry.lastDispatch.dispatchId },
  );
});

test('the same head and base tip is not dispatched twice', (t) => {
  const { paths } = homeOf(t);
  seed(paths);
  let dispatches = 0;
  const dispatchFn = () => { dispatches += 1; return { target_session_id: 'sess-1746' }; };
  poll(paths, { snapshot: snap(), collect: collectedConflict, dispatchFn });
  const second = poll(paths, { snapshot: snap(), collect: collectedConflict, dispatchFn });
  assert.equal(dispatches, 1);
  assert.equal(second.collected, 0, 'the recorded pair closes the gate again');
  assert.equal(second.result.prs[0].dispatch.reason, 'fingerprint-unchanged');
});

test('a moved base tip dispatches the conflict again even with an unchanged head', (t) => {
  const { paths } = homeOf(t);
  seed(paths, {
    eligibility: 'active',
    activeTask: { dispatchId: 'live-1746-old', sessionId: 'sess-1746', head: HEAD, status: 'complete' },
    conflictDispatch: { head: HEAD, baseTip: TIP, at: '2026-11-04T00:00:00Z', dispatchId: 'live-1746-old' },
    pollFingerprint: pollFingerprint(snap()),
  });
  let params;
  const { collected, entry } = poll(paths, {
    snapshot: snap({ baseTipOid: MOVED }),
    collect: () => collectedConflict({ baseTipOid: MOVED }),
    dispatchFn: (value) => { params = value; return { target_session_id: 'sess-1746' }; },
  });
  assert.equal(collected, 1);
  assert.match(params.message, /"key":"conflict:merge-conflict"/);
  assert.equal(entry.conflictDispatch.baseTip, MOVED);
});

test('a due conflict reaches a blocked external session even with the same feedback text', (t) => {
  const { paths } = homeOf(t);
  // The blocked task already carries this exact conflict (same content hash), so the "same blocked cause" guard
  // would swallow it. A due conflict is new information and must be delivered anyway (#1746). The block reason is
  // not an infra or transient one, so nothing else reopens the PR and only the conflict can get it dispatched.
  seed(paths, { activeTask: {
    dispatchId: 'live-1746-old', sessionId: 'sess-1746', head: HEAD, status: 'blocked',
    blockedKind: 'external', reason: 'the session needs a product decision from the owner',
  } });
  const hash = createHash('sha256').update(JSON.stringify({ mergeable: 'CONFLICTING', baseTip: TIP })).digest('hex');
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', 'live-1746-old.json'), JSON.stringify({
    dispatchId: 'live-1746-old', nodeId, number: 1746,
    feedback: [{
      key: 'conflict:merge-conflict', source: 'conflict', nativeId: 'merge-conflict',
      revision: HEAD, sha: HEAD, body: 'PR has merge conflicts with its base branch.', contentHash: hash,
    }],
  }));
  let params;
  const { result, entry } = poll(paths, {
    snapshot: snap(),
    collect: collectedConflict,
    dispatchFn: (value) => { params = value; return { target_session_id: 'sess-1746' }; },
  });
  assert.equal(result.prs[0].dispatch.bound, true);
  assert.match(params.message, /"key":"conflict:merge-conflict"/);
  assert.deepEqual({ head: entry.conflictDispatch.head, baseTip: entry.conflictDispatch.baseTip }, { head: HEAD, baseTip: TIP });
});

test('a moved base inside the cooldown is collected once, held back, then skipped', (t) => {
  const { paths } = homeOf(t);
  seed(paths, {
    eligibility: 'active',
    activeTask: { dispatchId: 'live-1746-old', sessionId: 'sess-1746', head: HEAD, status: 'complete' },
    conflictDispatch: { head: HEAD, baseTip: TIP, at: '2026-11-04T23:30:00Z', dispatchId: 'live-1746-old' },
    pollFingerprint: pollFingerprint(snap()),
  });
  let dispatches = 0;
  const dispatchFn = () => { dispatches += 1; return { target_session_id: 'sess-1746' }; };
  const first = poll(paths, {
    snapshot: snap({ baseTipOid: MOVED }),
    collect: () => collectedConflict({ baseTipOid: MOVED }),
    dispatchFn,
  });
  assert.equal(first.collected, 1);
  assert.equal(dispatches, 0, 'the cooldown holds the conflict back');
  assert.equal(first.result.prs[0].dispatch.reason, 'no-new-feedback');
  assert.equal(first.entry.feedbackCursor[CONFLICT_FEEDBACK_KEY], conflictStamp(), 'the conflict stays pending');
  const second = poll(paths, {
    snapshot: snap({ baseTipOid: MOVED }),
    collect: () => { throw new Error('must not collect while the gate is closed'); },
    dispatchFn,
  });
  assert.equal(second.collected, 0, 'a held-back conflict does not force a full collection every round');
  assert.equal(second.result.prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.equal(dispatches, 0);
});

test('a running repair closes the gate instead of forcing a collection every round', (t) => {
  const { paths } = homeOf(t);
  seed(paths, {
    activeTask: { dispatchId: 'live-1746-run', sessionId: 'sess-1746', head: HEAD, status: 'accepted' },
    lastDispatch: { dispatchId: 'live-1746-run', at: '2026-11-05T00:00:00Z', recoveryCount: 0 },
    pollFingerprint: pollFingerprint(snap()),
  });
  const { result, collected } = poll(paths, {
    snapshot: snap(),
    collect: () => { throw new Error('must not collect while a repair is running'); },
    dispatchFn: () => { throw new Error('must not dispatch while a repair is running'); },
  });
  assert.equal(collected, 0);
  assert.equal(result.prs[0].dispatch.reason, 'fingerprint-unchanged');
});

test('a dry run does not persist a pending dispatch', (t) => {
  const { paths } = homeOf(t);
  seed(paths);
  const tasksDir = path.join(paths.stateDir, 'tasks');
  const before = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).sort() : [];
  let calls = 0;
  const { result, entry } = poll(paths, {
    snapshot: snap(),
    collect: collectedConflict,
    dispatchFn: () => { calls += 1; throw new Error('a dry run must not dispatch'); },
    allowDispatch: false,
  });
  assert.equal(calls, 0);
  assert.equal(result.prs[0].dispatch.reason, 'dry-run');
  assert.ok(!entry.pendingDispatch, 'a dry run must not leave a pending dispatch in state');
  const after = fs.existsSync(tasksDir) ? fs.readdirSync(tasksDir).sort() : [];
  assert.deepEqual(after, before, 'a dry run must not write a task file');
});

test('a leftover dry pending dispatch is cleared and does not block the conflict gate', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { pendingDispatch: { dispatchId: 'dry-1746-old', params: {}, at: now } });
  let params;
  const { result, entry } = poll(paths, {
    snapshot: snap(),
    collect: collectedConflict,
    dispatchFn: (value) => { params = value; return { target_session_id: 'sess-1746' }; },
  });
  assert.equal(result.prs[0].dispatch.attempted, true);
  assert.equal(result.prs[0].dispatch.bound, true);
  assert.match(params.message, /"key":"conflict:merge-conflict"/);
  assert.ok(entry.conflictDispatch);
  assert.notEqual(entry.pendingDispatch?.dispatchId, 'dry-1746-old');
});

const ciFailure = () => ({
  checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
  ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
});

test('other feedback delivered while a conflict is held keeps the held conflict pending', (t) => {
  const { paths } = homeOf(t);
  const held = { head: HEAD, baseTip: TIP, at: '2026-11-04T23:30:00Z', dispatchId: 'live-1746-old' };
  seed(paths, {
    eligibility: 'active',
    activeTask: { dispatchId: 'live-1746-old', sessionId: 'sess-1746', head: HEAD, status: 'complete' },
    conflictDispatch: held,
  });
  let params;
  const { result, entry } = poll(paths, {
    snapshot: snap({ baseTipOid: MOVED }),
    collect: () => collectedConflict({ baseTipOid: MOVED, ...ciFailure() }),
    dispatchFn: (value) => { params = value; return { target_session_id: 'sess-1746' }; },
  });
  assert.equal(result.prs[0].dispatch.bound, true);
  assert.match(params.message, /"key":"ci:/);
  assert.doesNotMatch(params.message, /"key":"conflict:merge-conflict"/, 'the held conflict is not in the batch');
  assert.equal(entry.feedbackCursor[CONFLICT_FEEDBACK_KEY], conflictStamp(), 'the delivered batch must not mark it delivered');
  assert.deepEqual(entry.conflictDispatch, held, 'only a delivered conflict writes the record');
});

test('feedback without a conflict writes no conflict record', (t) => {
  const { paths } = homeOf(t);
  seed(paths, {
    eligibility: 'active', feedbackCursor: {},
    activeTask: { dispatchId: 'live-1746-old', sessionId: 'sess-1746', head: HEAD, status: 'complete' },
  });
  const { result, entry } = poll(paths, {
    snapshot: snap({ mergeable: 'MERGEABLE' }),
    collect: () => collectedConflict({ mergeable: 'MERGEABLE', ...ciFailure() }),
    dispatchFn: () => ({ target_session_id: 'sess-1746' }),
  });
  assert.equal(result.prs[0].dispatch.bound, true);
  assert.equal(entry.conflictDispatch, undefined);
});

test('a failed delivery writes no conflict record and the conflict stays due', (t) => {
  const { paths } = homeOf(t);
  seed(paths);
  const { result, entry } = poll(paths, {
    snapshot: snap(), collect: collectedConflict,
    dispatchFn: () => { throw new Error('HOST_NOT_READY'); },
  });
  assert.equal(result.prs[0].dispatch.bound, false);
  assert.equal(entry.conflictDispatch, undefined, 'nothing was delivered, so nothing is recorded');
});

test('an open child PR or an unreadable child PR list holds the conflict and records nothing', (t) => {
  for (const childPrs of [new Error('gh: HTTP 502'), JSON.stringify([[{
    number: 99, html_url: `https://github.com/${process.env.MIVO_WATCHER_TARGET_REPO}/pull/99`, base: { ref: 'fix/1746' },
    head: { ref: 'vigil/pr-1746-fix-aaaaaaaaaaaa', sha: HEAD, repo: { full_name: process.env.MIVO_WATCHER_TARGET_REPO } },
  }]])]) {
    const { paths } = homeOf(t);
    seed(paths);
    const { result, entry } = poll(paths, {
      snapshot: snap(), collect: collectedConflict, childPrs,
      dispatchFn: () => { throw new Error('a held conflict must not dispatch'); },
    });
    assert.equal(result.prs[0].dispatch.attempted, false);
    assert.match(result.prs[0].dispatch.reason, /child-pr/);
    assert.equal(entry.conflictDispatch, undefined);
  }
});

test('a conflicting PR never triggers a compare or update-branch call', (t) => {
  const { paths } = homeOf(t);
  seed(paths, {
    eligibility: 'active',
    activeTask: { dispatchId: 'live-1746-old', sessionId: 'sess-1746', head: HEAD, status: 'complete' },
    conflictDispatch: { head: HEAD, baseTip: TIP, at: '2026-11-04T23:30:00Z', dispatchId: 'live-1746-old' },
  });
  const calls = [];
  poll(paths, {
    snapshot: snap({ baseTipOid: MOVED }), collect: () => collectedConflict({ baseTipOid: MOVED }), calls,
    dispatchFn: () => { throw new Error('inside the cooldown'); },
  });
  const text = calls.map((args) => args.join(' ')).join('\n');
  assert.doesNotMatch(text, /\/compare\/|update-branch/);
});

test('a retried delivery records the pair its original task carried, not the base tip seen now', (t) => {
  const { paths } = homeOf(t);
  seed(paths, { eligibility: 'active', activeTask: { dispatchId: 'live-1746-old', sessionId: 'sess-1746', head: HEAD, status: 'complete' } });
  const handoff = readPr(paths.home, nodeId).handoff;
  const dispatchId = 'live-1746-retry';
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${dispatchId}.json`), JSON.stringify({
    dispatchId, nodeId, number: 1746, repo: handoff.repo, headRefOid: HEAD, headRefName: 'fix/1746',
    handoff, releaseEpoch: handoff.releaseEpoch,
    feedback: [{ key: CONFLICT_FEEDBACK_KEY, source: 'conflict', nativeId: 'merge-conflict', revision: HEAD, sha: HEAD, body: 'conflict' }],
    prSnapshot: { pr: { headRefOid: HEAD, baseTipOid: TIP } },
  }));
  writePrState(paths.home, nodeId, { ...readPr(paths.home, nodeId), pendingDispatch: {
    dispatchId, status: 'retryable', attempts: 1, retryAt: '2026-11-04T00:00:00Z',
    params: { title: '#1746-恢复视频生成格丨1104', message: 'stale', target_session_id: 'sess-1746' },
  } });
  let calls = 0;
  const { result, entry } = poll(paths, {
    snapshot: snap({ baseTipOid: MOVED }),
    collect: () => collectedConflict({ baseTipOid: MOVED }),
    dispatchFn: () => { calls += 1; return { target_session_id: 'sess-1746' }; },
  });
  assert.equal(calls, 1);
  assert.equal(result.prs[0].dispatch.reason, 'confirmed-nondelivery-retry');
  assert.deepEqual(
    { head: entry.conflictDispatch.head, baseTip: entry.conflictDispatch.baseTip, dispatchId: entry.conflictDispatch.dispatchId },
    { head: HEAD, baseTip: TIP, dispatchId },
    'the record describes what was sent, so the moved base is not marked as delivered',
  );
});
