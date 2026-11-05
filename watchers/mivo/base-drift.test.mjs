import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanOnceAsync, watcherPaths, lastBaseSyncAt, baseSyncRetryDue } from './bin/mivo-watcher.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';
import {
  planBaseUpdate, readBaseDrift, updateBaseBranch, baseDriftDue,
  BASE_SYNC_MIN_BEHIND, BASE_SYNC_SPACING_MS,
} from './bin/mivo-pr-actions.mjs';
import { handoffPr, handoffReceipt, isFollowBatch, followBatchBody, isMergeBatch, mergeBatchBody, withAuthorHandoff } from './handoff.fixture.mjs';

// 2026-11-04: main's ruleset does not require branches to be up to date, so GitHub reports a main PR as BLOCKED or
// CLEAN however far behind it is, and the watcher's BEHIND-only sync never ran. Ready PRs sat 15-47 commits behind,
// one of them merge-ready at 36, and the pre-review stops reviewing a PR whose merge base is 3 days old.
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const NOW = '2026-11-04T12:00:00Z';
const hoursAgo = (hours) => new Date(Date.parse(NOW) - hours * 3600 * 1000).toISOString();

function run(gen) {
  let step = gen.next();
  while (!step.done) {
    try { step = gen.next(typeof step.value === 'function' ? step.value() : step.value); }
    catch (error) { step = gen.throw(error); }
  }
  return step.value;
}

function snapshot({ mergeStateStatus = 'BLOCKED', blockers = ['waiting-review'], baseRefName = 'main', ...extra } = {}) {
  return {
    pr: { id: 'PR_1', number: 7, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
      headRefOid: HEAD, headRefName: 'feat/x', baseRefOid: BASE, baseRefName, releaseEpoch: 'ready:e' },
    mergeable: 'MERGEABLE', mergeStateStatus, baseTipOid: TIP,
    reviewEvidence: { ready: false, reason: blockers[0], blockers, baseUpdateEligible: false },
    baseUpdateEligible: false, ...extra,
  };
}
const drift = (behindBy, mergeBaseAt = hoursAgo(1), extra = {}) => ({ head: HEAD, baseTip: TIP, behindBy, mergeBaseAt, ...extra });
const plan = (args) => planBaseUpdate({ snapshot: snapshot(), entry: {}, fresh: [], now: NOW, ...args });

test('a main PR far enough behind is synced although GitHub reports it BLOCKED, not BEHIND', () => {
  const due = plan({ drift: drift(BASE_SYNC_MIN_BEHIND) });
  assert.equal(due.eligible, true, due.reason);
  assert.equal(plan({ drift: drift(12), snapshot: snapshot({ mergeStateStatus: 'CLEAN', blockers: [] }) }).eligible, true,
    'merge-ready is not a reason to stay behind');
  assert.equal(plan({ drift: drift(3) }).reason, 'behind-below-threshold');
  assert.equal(plan({ drift: drift(0) }).reason, 'up-to-date');
  assert.equal(plan({}).reason, 'drift-unknown', 'no reading, no sync');
});

test('an old merge base is synced before the pre-review\'s 3-day stale-rebase gate, however few commits behind', () => {
  assert.equal(plan({ drift: drift(2, hoursAgo(49)) }).eligible, true);
  assert.equal(plan({ drift: drift(2, hoursAgo(47)) }).reason, 'behind-below-threshold');
  assert.equal(baseDriftDue({ drift: drift(0, hoursAgo(100)), now: NOW }), false, 'an old merge base that is not behind needs nothing');
});

test('a reading for another head or base tip does not count', () => {
  assert.equal(plan({ drift: drift(20, hoursAgo(1), { head: 'd'.repeat(40) }) }).reason, 'drift-unknown');
  assert.equal(plan({ drift: drift(20, hoursAgo(1), { baseTip: 'd'.repeat(40) }) }).reason, 'drift-unknown');
});

test('no sync while the reviewer reads the head, while a maintainer holds the PR, or while a repair owns it', () => {
  assert.equal(plan({ drift: drift(20), snapshot: snapshot({ blockers: ['review-in-progress'] }) }).reason, 'review-in-progress');
  assert.equal(plan({ drift: drift(20), snapshot: snapshot({ blockers: ['discussion-hold'] }) }).reason, 'discussion-hold');
  assert.equal(plan({ drift: drift(20), fresh: [{ key: 'x' }] }).reason, 'fresh-feedback');
  assert.equal(plan({ drift: drift(20), entry: { activeTask: { status: 'waiting-ci' } } }).reason, 'repair-in-flight');
  assert.equal(plan({ drift: drift(20), snapshot: snapshot({ mergeable: 'CONFLICTING' }) }).reason, 'not-mergeable',
    'a conflict goes to the repair session, update-branch cannot merge it');
});

test('integration branches are synced too; other bases are not', () => {
  assert.equal(plan({ drift: drift(16), snapshot: snapshot({ baseRefName: 'integration/canvas-s2', mergeStateStatus: 'BEHIND' }) }).eligible, true);
  assert.equal(plan({ drift: drift(16), snapshot: snapshot({ baseRefName: 'release/0.9' }) }).reason, 'base-not-syncable');
  assert.equal(plan({ drift: drift(16), snapshot: snapshot({ baseRefName: 'integration/../main' }) }).reason, 'base-not-syncable');
});

test('one sync per spacing window across the watcher, and a refused sync waits an hour', () => {
  const spaced = plan({ drift: drift(20), lastSyncAt: new Date(Date.parse(NOW) - 60_000).toISOString() });
  assert.equal(spaced.reason, 'spacing');
  assert.equal(spaced.retryAt, new Date(Date.parse(NOW) - 60_000 + BASE_SYNC_SPACING_MS).toISOString());
  assert.equal(plan({ drift: drift(20), lastSyncAt: new Date(Date.parse(NOW) - BASE_SYNC_SPACING_MS).toISOString() }).eligible, true);
  assert.equal(plan({ drift: drift(20), lastSyncAt: new Date(Date.parse(NOW) + 3_600_000).toISOString() }).eligible, true, 'a last sync in the future does not hold it off');
  const key = plan({ drift: drift(20) }).key;
  const refused = { baseUpdate: { key, head: HEAD, status: 'failed', requestedAt: hoursAgo(0.5), checkedAt: hoursAgo(0.5) } };
  assert.equal(plan({ drift: drift(20), entry: refused }).reason, 'failed-cooldown');
  assert.equal(plan({ drift: drift(20), entry: { baseUpdate: { ...refused.baseUpdate, checkedAt: hoursAgo(2) } } }).eligible, true);
  // main moved on since the refusal: a new base tip, the same head. A token without the workflow scope is refused again.
  const movedTip = 'd'.repeat(40);
  const onNewTip = planBaseUpdate({ snapshot: snapshot({ baseTipOid: movedTip }), entry: { baseUpdate: { ...refused.baseUpdate, head: HEAD } },
    fresh: [], now: NOW, drift: drift(25, hoursAgo(1), { baseTip: movedTip }) });
  assert.equal(onNewTip.reason, 'failed-cooldown', 'the cooldown is per head, not per base tip');
});

test('a postponed sync forces a collection only near its retry time, not forever', () => {
  const entry = { baseSyncRetryAt: NOW };
  const at = (minutes) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
  assert.equal(baseSyncRetryDue(entry, at(-1)), false, 'not before it');
  assert.equal(baseSyncRetryDue(entry, at(0)), true);
  assert.equal(baseSyncRetryDue(entry, at(14)), true);
  assert.equal(baseSyncRetryDue(entry, at(16)), false, 'a stale value left by a PR that went back to Draft');
  assert.equal(baseSyncRetryDue({}, NOW), false);
});

test('lastBaseSyncAt takes the newest sync any PR sent, a refused one included', () => {
  const state = { prs: {
    a: { baseUpdate: { status: 'updated', requestedAt: hoursAgo(3) } },
    b: { baseUpdate: { status: 'accepted', requestedAt: hoursAgo(1) } },
    c: { baseUpdate: { status: 'failed', requestedAt: hoursAgo(0) } },
    d: {},
  } };
  assert.equal(lastBaseSyncAt(state), hoursAgo(0), 'a refusal that repeats takes its share of the spacing too');
  delete state.prs.c;
  assert.equal(lastBaseSyncAt(state), hoursAgo(1));
  assert.equal(lastBaseSyncAt({ prs: {} }), null);
});

test('readBaseDrift compares against the base tip SHA and rejects an incomplete answer', () => {
  const calls = [];
  const answer = (body) => (args) => { calls.push(args); return JSON.stringify(body); };
  const read = (body) => run(readBaseDrift({ repo: 'example-org/example-plugin', baseTip: TIP, head: HEAD, ghFn: answer(body) }));
  assert.deepEqual(read({ behind_by: 12, merge_base_date: hoursAgo(5) }), { head: HEAD, baseTip: TIP, behindBy: 12, mergeBaseAt: hoursAgo(5) });
  assert.equal(calls[0][1], `repos/example-org/example-plugin/compare/${TIP}...${HEAD}?per_page=1`);
  assert.throws(() => read({ behind_by: null, merge_base_date: hoursAgo(5) }), /behind_by expected a non-negative integer/);
  assert.throws(() => read({ behind_by: 3 }), /merge base date missing/);
  assert.throws(() => run(readBaseDrift({ repo: 'example-org/example-plugin', baseTip: 'main', head: HEAD, ghFn: answer({}) })), /full SHA/);
});

test('a drift sync goes ahead when the live re-read says BLOCKED, and stops only on a conflict', () => {
  const sync = (status) => {
    const calls = [];
    const s = snapshot({ mergeStateSource: 'batch' });
    const ghFn = (args) => {
      calls.push(args);
      if (args.some((arg) => String(arg).includes('viewer{login} node(id:'))) {
        return JSON.stringify({ data: { node: { mergeStateStatus: status, baseRef: { name: 'main', target: { oid: TIP } } } } });
      }
      return '{}';
    };
    const result = run(updateBaseBranch({ pr: s.pr, entry: {}, snapshot: s, ghFn, ownershipSnapshot: function* () { return { pr: s.pr }; },
      save: () => {}, now: NOW, viewer: 'owner', repo: 'example-org/example-plugin', drift: drift(12) }));
    return { result, put: calls.some((args) => args.join(' ').includes('update-branch')) };
  };
  assert.equal(sync('BLOCKED').put, true);
  assert.equal(sync('CLEAN').put, true);
  const dirty = sync('DIRTY');
  assert.equal(dirty.put, false);
  assert.equal(dirty.result.action.reason, 'merge-state-changed');
});

// ---- a whole discover round ----
// Each PR's current head; an accepted update-branch moves it to SYNCED, as GitHub's merge commit would.
const SYNCED = 'e'.repeat(40);
let heads = {};
const headOf = (number) => heads[number] ?? HEAD;
const listedPr = (number) => ({ number, id: `PR_${number}`, headRefOid: headOf(number), headRefName: `fix/${number}`,
  title: 'fix', isDraft: false, labels: [], updatedAt: '2026-11-04T00:00:00Z' });
const isPollQuery = (args) => args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('timelineItems'));
const pollNode = (number) => ({ state: 'OPEN', isDraft: false, headRefOid: headOf(number), baseRefOid: BASE, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } });
const ownerFields = (number) => ({ id: `PR_${number}`, number, state: 'OPEN', isDraft: false, sameRepository: true,
  author: { login: 'owner' }, headRefOid: headOf(number), headRefName: `fix/${number}`, baseRefOid: BASE, baseRefName: 'main', releaseEpoch: 'e' });
// The author handed off once, at HEAD; the receipt stays bound to that head when the head moves later.
const waitingReview = (listed) => {
  const collected = withAuthorHandoff(waitingReviewBody(listed.number), { ...listed, headRefOid: HEAD });
  return { ...collected, pr: { ...collected.pr, headRefOid: headOf(listed.number) } };
};
const waitingReviewBody = (number) => ({
  pr: { ...ownerFields(number), headRefOid: HEAD },
  admissionVerified: true,
  checks: [{ name: 'unit', state: 'PENDING', bucket: 'pending' }],
  ci: { status: 'pending', required: [{ context: 'unit', status: 'pending', evidence: { id: 1, runId: 2, attempt: 1 } }] },
  policy: { status: 'verified', required: [{ context: 'unit' }] },
  comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', mergeStateSource: 'query', baseTipOid: TIP,
  reviewReason: 'waiting-review', reviewEvidence: { ready: false, reason: 'waiting-review', blockers: ['waiting-review', 'waiting-ci', 'blocked'], baseUpdateEligible: false },
});

function roundFixture(t, { numbers, behindBy }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-base-drift-'));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-base-drift-plugin-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(plugin, { recursive: true, force: true }); });
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  heads = {};
  for (const number of numbers) {
    const listed = listedPr(number);
    const handoff = handoffReceipt({ ...listed, releaseEpoch: 'e' });
    writePr(home, listed.id, { number, nodeId: listed.id, sessionId: `sess-${number}`, claimedAt: '2026-10-27T00:00:00Z',
      eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: handoff.releaseEpoch, handoff,
      activeTask: { status: 'complete' }, headRefName: listed.headRefName, title: 'fix' });
  }
  const writes = [];
  const compares = [];
  const ghFn = (args) => {
    if (args[0] === 'api' && args[1] === 'user') return 'owner';
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(numbers.map(listedPr));
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({});
    if (isMergeBatch(args)) return mergeBatchBody(numbers.map(listedPr), { status: () => 'BLOCKED' });
    if (isFollowBatch(args)) {
      return followBatchBody(numbers.map(listedPr).map((pr) => ({ id: pr.id, isDraft: false, headRefOid: pr.headRefOid,
        updatedAt: pr.updatedAt, labels: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } })));
    }
    if (isPollQuery(args)) {
      const number = Number(/id=PR_(\d+)/.exec(args.join(' '))?.[1]);
      return JSON.stringify({ data: { node: pollNode(number) } });
    }
    if (String(args[1] ?? '').includes('/compare/')) {
      compares.push(args);
      return JSON.stringify({ behind_by: String(args[1]).includes(`...${SYNCED}`) ? 0 : behindBy, merge_base_date: hoursAgo(5) });
    }
    if (args.join(' ').includes('update-branch')) {
      writes.push(args);
      heads[Number(/pulls\/(\d+)\/update-branch/.exec(args.join(' '))[1])] = SYNCED;
      return '{}';
    }
    return '[]';
  };
  let clock = 0;
  // The async driver, as discover runs in production: the round's PRs really interleave at each gh call.
  const scan = (stamp) => scanOnceAsync({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: stamp, clock: () => clock, followMs: 0, sleepFn: (ms) => { clock += ms; },
    fullCollectMs: 1e12, gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin }, ghFn,
    // One extra step before the answer, as a real gh call would take: the round's PRs interleave here.
    ownershipSnapshot: function* ({ pr }) { yield () => new Promise((resolve) => setTimeout(resolve, 5)); return { pr: handoffPr(ownerFields(pr.number)) }; },
    collect: (pr) => waitingReview(listedPr(pr.number)), dispatchFn: () => { throw new Error('nothing to dispatch'); },
  });
  const synced = () => writes.map((args) => Number(/pulls\/(\d+)\/update-branch/.exec(args.join(' '))?.[1]));
  return { scan, synced, compares, entry: (number) => readPr(home, `PR_${number}`), push: (number, head) => { heads[number] = head; } };
}

test('a round brings a main PR that is 12 behind up to date, one PR per spacing window', async (t) => {
  const f = roundFixture(t, { numbers: [981, 982], behindBy: 12 });
  const first = await f.scan(NOW);
  assert.equal(f.synced().length, 1, 'the BLOCKED main PR is synced, and only one of the two PRs running in parallel this round');
  const reasons = first.prs.map((item) => item.dispatch?.reason);
  assert.ok(reasons.includes('base-update-accepted'), `reasons: ${reasons}`);
  // Nothing on GitHub changes in the fixture; the waiting PR is still collected again once the window has passed.
  await f.scan(new Date(Date.parse(NOW) + 60_000).toISOString());
  assert.equal(f.synced().length, 1, 'not inside the spacing window');
  await f.scan(new Date(Date.parse(NOW) + BASE_SYNC_SPACING_MS + 60_000).toISOString());
  assert.deepEqual(f.synced().sort(), [981, 982]);
});

test('a round leaves a PR that is only a few commits behind alone', async (t) => {
  const f = roundFixture(t, { numbers: [983], behindBy: 3 });
  await f.scan(NOW);
  assert.equal(f.compares.length, 1, 'the drift is read');
  assert.deepEqual(f.synced(), []);
  await f.scan(new Date(Date.parse(NOW) + 60_000).toISOString());
  assert.equal(f.compares.length, 1, 'and not read again while the head and base tip stay the same');
});

test('the head a sync produced is not taken for the author pushing; an author push afterwards still is', async (t) => {
  const f = roundFixture(t, { numbers: [984], behindBy: 12 });
  const at = (minutes) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
  await f.scan(NOW);
  assert.deepEqual(f.synced(), [984]);
  await f.scan(at(1));
  const synced = f.entry(984);
  assert.equal(synced.baseUpdate.status, 'updated');
  assert.equal(synced.trustedHead.head, SYNCED, 'the merge commit becomes the trusted head');
  assert.equal(synced.handoff.head, HEAD, 'the author\'s handoff stays: the watcher\'s own merge commit is not an author push');
  f.push(984, 'f'.repeat(40));
  await f.scan(at(2));
  assert.equal(f.entry(984).handoff.head, 'f'.repeat(40), 'the author\'s own push afterwards is still handled as one (new handoff)');
});
