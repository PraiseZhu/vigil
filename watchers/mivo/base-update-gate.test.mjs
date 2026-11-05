import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pollFingerprint, scanOnce, watcherPaths } from './bin/mivo-watcher.mjs';
import { readPr, writePr as writePrState } from './bin/mivo-state.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';

// A quiet, stale PR never changes its GitHub fingerprint, so the old gate skipped it forever and the
// behind-threshold base update never ran. The gate now opens one collection per head/base tip (with an hourly
// expiry), and the check record keeps a declined plan (review in progress, merge-ready) from collecting every round.
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const MOVED = 'd'.repeat(40);
const now = '2026-11-05T06:00:00Z';
const nodeId = 'PR_790';

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'base-gate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { home, paths };
}

function snap(extra = {}) {
  return {
    state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: now,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseTipOid: TIP,
    labels: [], checkState: 'SUCCESS', commentCount: 0, reviewCount: 0,
    commentUpdatedAt: null, reviewUpdatedAt: null, unresolvedThreads: 0, ...extra,
  };
}

function seed(paths, extra = {}) {
  const handoff = handoffReceipt({ id: nodeId, number: 790, headRefOid: HEAD, releaseEpoch: 'e' });
  writePrState(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: handoff.releaseEpoch, handoff,
    activeTask: { dispatchId: 'live-790-old', sessionId: 'sess-790', head: HEAD, status: 'complete' },
    lastDispatch: { dispatchId: 'live-790-old', at: '2026-11-05T00:00:00Z', recoveryCount: 0 },
    headRefName: 'fix/x', title: 'fix', pollFingerprint: pollFingerprint(snap()), ...extra,
  });
}

function collected() {
  return {
    pr: {
      id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true,
      author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e',
    },
    mergeable: 'MERGEABLE', baseTipOid: TIP,
    admissionVerified: true,
    checks: [],
    ci: { status: 'green', required: [] },
    policy: { status: 'verified', required: [] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  };
}

function behind(behindBy = 46, extra = {}) {
  const entry = { mergeStateStatus: 'CLEAN', baseTipOid: TIP, behindBy, ...extra };
  return new Map([[nodeId, entry]]);
}

function poll(paths, { snapshot, collect, dispatchFn, mergeIndex }) {
  let collectedCount = 0;
  const result = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now, nodeId, prNumber: 790,
    snapshotFn: () => snapshot,
    mergeIndex,
    ghFn: (args) => (args[0] === 'api' ? 'owner' : args[0] === 'pr' && args[1] === 'view' ? JSON.stringify({ id: nodeId, state: 'OPEN' }) : '[]'),
    collect: (...args) => {
      collectedCount += 1;
      return withAuthorHandoff(collect(...args), args[0]);
    },
    dispatchFn,
    ownershipSnapshot: function* () {
      return { pr: handoffPr({
        id: nodeId, number: 790, state: 'OPEN', isDraft: false, sameRepository: true,
        author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e',
      }) };
    },
  });
  return { result, collectedCount, entry: readPr(paths.home, nodeId) };
}

function withThreshold(t, value) {
  const saved = process.env.MIVO_BASE_UPDATE_BEHIND_THRESHOLD;
  if (value === undefined) delete process.env.MIVO_BASE_UPDATE_BEHIND_THRESHOLD;
  else process.env.MIVO_BASE_UPDATE_BEHIND_THRESHOLD = String(value);
  t.after(() => {
    if (saved === undefined) delete process.env.MIVO_BASE_UPDATE_BEHIND_THRESHOLD;
    else process.env.MIVO_BASE_UPDATE_BEHIND_THRESHOLD = saved;
  });
}

const noDispatch = () => { throw new Error('this round must not dispatch'); };

test('a behind-threshold PR is collected even with an unchanged fingerprint', (t) => {
  withThreshold(t, 10);
  const { paths } = homeOf(t);
  seed(paths);
  const { collectedCount, entry } = poll(paths, {
    snapshot: snap(), collect: collected, dispatchFn: noDispatch, mergeIndex: behind(46),
  });
  assert.equal(collectedCount, 1, 'the threshold gate must open a collection');
  assert.deepEqual(entry.baseUpdateCheck, { head: HEAD, baseTip: TIP, at: now });
});

test('the same head/base tip is not collected again (hourly recheck)', (t) => {
  withThreshold(t, 10);
  const { paths } = homeOf(t);
  seed(paths);
  poll(paths, { snapshot: snap(), collect: collected, dispatchFn: noDispatch, mergeIndex: behind(46) });
  const second = poll(paths, {
    snapshot: snap(), collect: () => { throw new Error('must not collect inside the recheck window'); },
    dispatchFn: noDispatch, mergeIndex: behind(46),
  });
  assert.equal(second.collectedCount, 0);
  assert.equal(second.result.prs[0].dispatch.reason, 'fingerprint-unchanged');
});

test('an expired check record opens the gate again', (t) => {
  withThreshold(t, 10);
  const { paths } = homeOf(t);
  seed(paths, { baseUpdateCheck: { head: HEAD, baseTip: TIP, at: '2026-11-05T04:30:00Z' } });
  const { collectedCount } = poll(paths, {
    snapshot: snap(), collect: collected, dispatchFn: noDispatch, mergeIndex: behind(46),
  });
  assert.equal(collectedCount, 1);
});

test('the gate stays closed below the threshold or when it is off', (t) => {
  const { paths } = homeOf(t);
  withThreshold(t, 10);
  seed(paths);
  const low = poll(paths, {
    snapshot: snap(), collect: () => { throw new Error('must not collect below the threshold'); },
    dispatchFn: noDispatch, mergeIndex: behind(9),
  });
  assert.equal(low.collectedCount, 0);
  assert.equal(low.result.prs[0].dispatch.reason, 'fingerprint-unchanged');

  withThreshold(t, undefined);
  const { paths: home2 } = homeOf(t);
  seed(home2);
  const off = poll(home2, {
    snapshot: snap(), collect: () => { throw new Error('must not collect with the gate off'); },
    dispatchFn: noDispatch, mergeIndex: behind(46),
  });
  assert.equal(off.collectedCount, 0);
});

test('a running repair or a handled head/base tip keeps the gate closed', (t) => {
  withThreshold(t, 10);
  const { paths } = homeOf(t);
  seed(paths, {
    activeTask: { dispatchId: 'live-790-run', sessionId: 'sess-790', head: HEAD, status: 'accepted' },
    lastDispatch: { dispatchId: 'live-790-run', at: now, recoveryCount: 0 },
  });
  const running = poll(paths, {
    snapshot: snap(), collect: () => { throw new Error('must not collect while a repair is running'); },
    dispatchFn: noDispatch, mergeIndex: behind(46),
  });
  assert.equal(running.collectedCount, 0);

  const { paths: home2 } = homeOf(t);
  seed(home2, { baseUpdate: { key: 'k', head: HEAD, baseTip: TIP, status: 'updated', requestedAt: now } });
  const handled = poll(home2, {
    snapshot: snap(), collect: () => { throw new Error('must not collect an already updated head'); },
    dispatchFn: noDispatch, mergeIndex: behind(46),
  });
  assert.equal(handled.collectedCount, 0);
  assert.equal(handled.result.prs[0].dispatch.reason, 'fingerprint-unchanged');
});
