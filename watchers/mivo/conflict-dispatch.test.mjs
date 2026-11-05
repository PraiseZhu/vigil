import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CONFLICT_FEEDBACK_KEY, conflictDispatchDue, pollFingerprint, scanOnce, watcherPaths } from './bin/mivo-watcher.mjs';
import { readPr, writePr as writePrState } from './bin/mivo-state.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';

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

function poll(paths, { snapshot, collect, dispatchFn }) {
  let collected = 0;
  const result = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now, nodeId, prNumber: 1746,
    snapshotFn: () => snapshot,
    ghFn: (args) => (args[0] === 'api' ? 'owner' : args[0] === 'pr' && args[1] === 'view' ? JSON.stringify({ id: nodeId, state: 'OPEN' }) : '[]'),
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

test('a repair that is running, a pending delivery or a dispatch conflict closes the conflict gate', () => {
  assert.equal(conflictDispatchDue({
    previous: { activeTask: { status: 'accepted' } }, snapshot: snap(), now,
  }), false, 'a running repair must not have its head moved under it');
  assert.equal(conflictDispatchDue({
    previous: { activeTask: { status: 'waiting-ci' } }, snapshot: snap(), now,
  }), true, 'a repair waiting for CI can take a conflict task');
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
  // would swallow it. A due conflict is new information and must be delivered anyway (#1746).
  seed(paths);
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
