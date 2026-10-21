import test from 'node:test';
import assert from 'node:assert/strict';
import { planBaseUpdate, assertActionOwner, updateBaseBranch, reconcileBaseUpdate } from './bin/mivo-pr-actions.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const now = '2026-10-21T00:00:00Z';

function snapshot(extra = {}) {
  return {
    pr: { id: 'PR_1', number: 7, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
      headRefOid: HEAD, headRefName: 'feat/x', baseRefOid: BASE, baseRefName: 'main', releaseEpoch: 'ready:e' },
    mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', baseTipOid: TIP,
    reviewEvidence: { ready: false, reason: 'behind', blockers: ['behind'], baseUpdateEligible: true },
    baseUpdateEligible: true, ...extra,
  };
}

function run(gen) {
  let step = gen.next();
  while (!step.done) {
    const fn = step.value;
    try { step = gen.next(typeof fn === 'function' ? fn() : fn); }
    catch (error) { step = gen.throw(error); }
  }
  return step.value;
}

test('planBaseUpdate allows only BEHIND + other gates', () => {
  assert.equal(planBaseUpdate({ snapshot: snapshot(), entry: {}, fresh: [], now }).eligible, true);
  assert.equal(planBaseUpdate({ snapshot: snapshot({ mergeStateStatus: 'CLEAN', baseUpdateEligible: false, reviewEvidence: { baseUpdateEligible: false, reason: 'current-approve' } }), entry: {}, fresh: [], now }).eligible, false);
  assert.equal(planBaseUpdate({ snapshot: snapshot(), entry: {}, fresh: [{ key: 'x' }], now }).eligible, false);
  assert.equal(planBaseUpdate({ snapshot: snapshot({ pr: { ...snapshot().pr, baseRefName: 'develop' } }), entry: {}, fresh: [], now }).eligible, false);
});

test('assertActionOwner rejects draft, author change and head drift', () => {
  const live = { pr: snapshot().pr };
  assert.equal(assertActionOwner({ live, snapshot: snapshot(), entry: {}, viewer: 'owner', expected: { nodeId: 'PR_1', head: HEAD } }), true);
  assert.throws(() => assertActionOwner({ live: { pr: { ...snapshot().pr, isDraft: true } }, snapshot: snapshot(), entry: {}, viewer: 'owner' }), /inactive/);
  assert.throws(() => assertActionOwner({ live, snapshot: snapshot(), entry: {}, viewer: 'other' }), /author-mismatch/);
  assert.throws(() => assertActionOwner({ live, snapshot: snapshot(), entry: {}, viewer: 'owner', expected: { head: 'd'.repeat(40) } }), /head-mismatch/);
});

test('updateBaseBranch persists reservation before PUT and records accepted', () => {
  const saves = [];
  const calls = [];
  const ghFn = (args) => { calls.push(args); return '{}'; };
  const ownershipSnapshot = function* () { return { pr: snapshot().pr }; };
  const result = run(updateBaseBranch({
    pr: snapshot().pr, entry: {}, snapshot: snapshot(), ghFn, ownershipSnapshot,
    save: (entry) => saves.push(JSON.parse(JSON.stringify(entry))), now, viewer: 'owner', repo: 'example-org/example-plugin',
  }), ghFn);
  assert.equal(result.action.reason, 'accepted');
  assert.equal(saves[0].baseUpdate.status, 'reserved');
  assert.equal(saves[1].baseUpdate.status, 'accepted');
  assert.equal(calls.some((args) => args.join(' ').includes('update-branch') && args.join(' ').includes(`expected_head_sha=${HEAD}`)), true);
  assert.equal(calls.some((args) => args.includes('rebase')), false);
});

test('dry-run does not persist or call GitHub write', () => {
  const saves = [];
  const calls = [];
  const ghFn = (args) => { calls.push(args); return '{}'; };
  const ownershipSnapshot = function* () { return { pr: snapshot().pr }; };
  const result = run(updateBaseBranch({
    pr: snapshot().pr, entry: {}, snapshot: snapshot(), ghFn, ownershipSnapshot,
    save: (entry) => saves.push(entry), now, dryRun: true, viewer: 'owner', repo: 'example-org/example-plugin',
  }), ghFn);
  assert.equal(result.action.reason, 'dry-run');
  assert.equal(saves.length, 0);
  assert.equal(calls.some((args) => args.includes('update-branch')), false);
});

test('422 with new head is superseded; 403 fails closed', () => {
  let reads = 0;
  const ownershipSnapshot = function* () {
    reads += 1;
    return { pr: { ...snapshot().pr, headRefOid: reads === 1 ? HEAD : 'd'.repeat(40) } };
  };
  const gh422 = (args) => {
    if (args.join(' ').includes('update-branch')) { const error = new Error('expected head mismatch'); error.status = 422; throw error; }
    return '{}';
  };
  const superseded = run(updateBaseBranch({
    pr: snapshot().pr, entry: {}, snapshot: snapshot(), ghFn: gh422, ownershipSnapshot,
    save: () => {}, now, viewer: 'owner', repo: 'example-org/example-plugin',
  }), gh422);
  assert.equal(superseded.action.reason, 'superseded');

  const live = function* () { return { pr: snapshot().pr }; };
  const gh403 = (args) => {
    if (args.join(' ').includes('update-branch')) { const error = new Error('forbidden'); error.status = 403; throw error; }
    return '{}';
  };
  const failed = run(updateBaseBranch({
    pr: snapshot().pr, entry: {}, snapshot: snapshot(), ghFn: gh403, ownershipSnapshot: live,
    save: () => {}, now, viewer: 'owner', repo: 'example-org/example-plugin',
  }), gh403);
  assert.equal(failed.action.reason, 'failed');
});

test('reconcileBaseUpdate marks updated when head advances and unconfirmed after 5 minutes', () => {
  const entry = { baseUpdate: { key: 'k', head: HEAD, status: 'accepted', requestedAt: '2026-10-21T00:00:00Z' } };
  const updated = reconcileBaseUpdate({ snapshot: { pr: { headRefOid: 'd'.repeat(40) } }, entry, now: '2026-10-21T00:01:00Z' });
  assert.equal(updated.baseUpdate.status, 'updated');
  const stuck = reconcileBaseUpdate({ snapshot: { pr: { headRefOid: HEAD } }, entry, now: '2026-10-21T00:06:00Z' });
  assert.equal(stuck.baseUpdate.status, 'failed');
  assert.equal(stuck.baseUpdate.error, 'base-update-unconfirmed');
});
