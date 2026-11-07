import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FOLLOW_INTERVAL_MS, scanOnce, watcherPaths } from './bin/mivo-watcher.mjs';
import { writePr } from './bin/mivo-state.mjs';
import { collectMergeStates, collectPrOwnership, collectPrSnapshotSync, readMergeState } from './bin/mivo-pr-snapshot.mjs';
import { updateBaseBranch } from './bin/mivo-pr-actions.mjs';
import { handoffPr, handoffReceipt, isFollowBatch, followBatchBody, isMergeBatch, mergeBatchBody, withAuthorHandoff } from './handoff.fixture.mjs';

// 2026-11-04: the gh router answers any read that selects mergeStateStatus as the personal account, and one query per
// PR in one burst (16-19 in a second) used up that account's rate limit. A round now reads merge state once.
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const TIP = 'c'.repeat(40);
const MOVED = 'd'.repeat(40);
const listedPr = (number, extra = {}) => ({ number, id: `PR_${number}`, headRefOid: HEAD, headRefName: `fix/${number}`,
  title: 'fix', isDraft: false, labels: [], updatedAt: '2026-10-15T00:00:00Z', ...extra });
const mentionsMergeState = (args) => args.some((arg) => String(arg).includes('mergeStateStatus'));
const isPollQuery = (args) => args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('timelineItems'));
const isTipQuery = (args) => args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('viewer{login} node(id:'));
const tipAnswer = (live) => JSON.stringify({ data: { node: { mergeStateStatus: live.status, baseRef: { name: 'main', target: { oid: live.tip ?? TIP } } } } });
const pollNode = (rollup = 'PENDING') => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup } } }] } });
const quiet = (listed, extra = {}) => withAuthorHandoff({
  pr: { id: listed.id, number: listed.number, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
    headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
  admissionVerified: true,
  checks: [{ name: 'unit', state: 'PENDING', bucket: 'pending' }],
  ci: { status: 'pending', required: [{ context: 'unit', status: 'pending', evidence: { id: 1, runId: 2, attempt: 1 } }] },
  policy: { status: 'verified', required: [{ context: 'unit' }] },
  comments: [], reviews: [], threads: [], labels: [], mergeReady: false, ...extra,
}, listed);
function* ownership({ pr }) {
  return { pr: handoffPr({ id: `PR_${pr.number}`, number: pr.number, state: 'OPEN', isDraft: false, sameRepository: true,
    author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' }) };
}
function run(gen) {
  let step = gen.next();
  while (!step.done) {
    try { step = gen.next(typeof step.value === 'function' ? step.value() : step.value); }
    catch (error) { step = gen.throw(error); }
  }
  return step.value;
}

// ---- the batched read itself ----
test('collectMergeStates reads every page of the viewer\'s open PRs with one query each', () => {
  const calls = [];
  const page = (nodes, next) => JSON.stringify({ data: { viewer: { login: 'owner' }, search: { pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null }, nodes } } });
  const node = (id, status, tip = TIP) => ({ id, mergeStateStatus: status, baseRef: { name: 'main', target: { oid: tip } } });
  const ghFn = (args) => {
    calls.push(args);
    return args.includes('after=cursor-1') ? page([node('PR_3', 'DIRTY')]) : page([node('PR_1', 'CLEAN'), node('PR_2', 'BEHIND'), node('PR_BAD', 'CLEAN', 'not-a-sha'), {}], 'cursor-1');
  };
  const index = run(collectMergeStates({ repo: 'example-org/example-plugin', viewer: 'owner', ghFn }));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(mentionsMergeState));
  assert.ok(calls[0].includes('q=repo:example-org/example-plugin is:pr is:open author:owner author:app/praise-qa'));
  assert.deepEqual([...index.keys()], ['PR_1', 'PR_2', 'PR_3'], 'a PR without a valid base tip is left out, not guessed');
  assert.deepEqual(index.get('PR_2'), { mergeStateStatus: 'BEHIND', baseTipOid: TIP });
});

test('collectMergeStates fails on a GraphQL error or an incomplete page instead of returning a partial index', () => {
  const bad = (payload) => () => run(collectMergeStates({ repo: 'example-org/example-plugin', viewer: 'owner', ghFn: () => JSON.stringify(payload) }));
  assert.throws(bad({ errors: [{ message: 'boom' }], data: null }), /GraphQL errors: boom/);
  assert.throws(bad({ data: { search: { nodes: [] } } }), /incomplete/);
  assert.throws(bad({ data: { node: {} } }), /incomplete/);
});

// ---- SC2 / SC3: a single PR's snapshot ----
function snapshotGh({ calls, live = { status: 'CLEAN' } }) {
  const basic = { id: 'PR_1', number: 1, title: 't', state: 'OPEN', isDraft: false, headRefOid: HEAD, headRefName: 'feature', baseRefOid: BASE,
    baseRefName: 'main', createdAt: '2026-09-09T00:00:00Z', author: { login: 'owner' }, isCrossRepository: false, mergeable: 'MERGEABLE' };
  const page = (nodes = []) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  return (args) => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify(basic);
    if (args[1] === 'checks') return '[]';
    if (String(args[1]).startsWith('repos/')) return '[[]]';
    if (isTipQuery(args)) return tipAnswer(live);
    const q = args.at(-1);
    const field = ['timelineItems', 'reviewThreads', 'reviews', 'labels'].find((f) => q.includes(f + '('));
    return JSON.stringify({ data: { node: { [field]: page() } } });
  };
}

test('SC2 gh pr view never asks for mergeStateStatus (snapshot and ownership guard)', () => {
  const calls = [];
  collectPrSnapshotSync({ pr: { number: 1 }, ghFn: snapshotGh({ calls }) });
  run(collectPrOwnership({ pr: { number: 1 }, ghFn: snapshotGh({ calls }) }));
  const views = calls.filter((args) => args[1] === 'view');
  assert.ok(views.length >= 4);
  for (const args of views) assert.doesNotMatch(args.join(' '), /mergeStateStatus/);
});

test('SC3 a snapshot with the round\'s merge state sends no merge-state query of its own', () => {
  const calls = [];
  const mergeIndex = new Map([['PR_1', { mergeStateStatus: 'BEHIND', baseTipOid: MOVED }]]);
  const s = collectPrSnapshotSync({ pr: { number: 1 }, ghFn: snapshotGh({ calls }), mergeIndex });
  assert.equal(calls.filter(mentionsMergeState).length, 0);
  assert.equal(s.mergeStateStatus, 'BEHIND');
  assert.equal(s.pr.mergeStateStatus, 'BEHIND');
  assert.equal(s.baseTipOid, MOVED);
  assert.equal(s.mergeStateSource, 'batch');
});

test('SC3 a PR the batch does not know (or no batch at all) falls back to its own query', () => {
  for (const mergeIndex of [new Map([['PR_OTHER', { mergeStateStatus: 'CLEAN', baseTipOid: TIP }]]), null]) {
    const calls = [];
    const s = collectPrSnapshotSync({ pr: { number: 1 }, ghFn: snapshotGh({ calls, live: { status: 'BEHIND' } }), mergeIndex });
    assert.equal(calls.filter(mentionsMergeState).length, 1);
    assert.equal(s.mergeStateStatus, 'BEHIND');
    assert.equal(s.mergeStateSource, 'query');
  }
});

test('SC3 an unreadable merge state stays UNKNOWN, as before the batch existed', () => {
  const ghFn = snapshotGh({ calls: [] });
  const s = collectPrSnapshotSync({ pr: { number: 1 }, ghFn: (args) => (isTipQuery(args)
    ? JSON.stringify({ data: { node: { baseRef: { name: 'main', target: { oid: TIP } } } } }) : ghFn(args)) });
  assert.equal(s.mergeStateStatus, 'UNKNOWN');
  assert.equal(s.baseTipOid, TIP);
});

// ---- SC1 / SC5: a whole discover round ----
function roundFixture(t, { numbers, bound = [], mergeBatch = (listing) => mergeBatchBody(listing), followMs = 0, listingFor = () => null, collect = (pr) => quiet(pr), live = { status: 'CLEAN' } } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-merge-state-'));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-merge-state-plugin-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(plugin, { recursive: true, force: true }); });
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  for (const number of bound) {
    const listed = listedPr(number);
    const handoff = handoffReceipt({ ...listed, releaseEpoch: 'e' });
    writePr(home, listed.id, { number, nodeId: listed.id, sessionId: `sess-${number}`, claimedAt: '2026-09-27T00:00:00Z',
      eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: handoff.releaseEpoch, handoff,
      activeTask: { status: 'complete' }, headRefName: listed.headRefName, title: 'fix' });
  }
  const queries = { merge: [], poll: [], tip: [], views: [] };
  let now = 0;
  const listing = () => numbers.map((n) => listedPr(n, listingFor(n, now) ?? {}));
  const ghFn = (args) => {
    if (args[0] === 'api' && args[1] === 'user') return 'owner';
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(listing());
    if (args[0] === 'pr' && args[1] === 'view') { queries.views.push(args); return JSON.stringify({}); }
    if (isMergeBatch(args)) { queries.merge.push(now); return mergeBatch(listing(), now); }
    if (isFollowBatch(args)) {
      return followBatchBody(listing().map((pr) => ({ id: pr.id, isDraft: false, headRefOid: HEAD,
        updatedAt: pr.updatedAt, labels: { nodes: [] }, commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } })));
    }
    if (isPollQuery(args)) { queries.poll.push(args); return JSON.stringify({ data: { node: pollNode() } }); }
    if (isTipQuery(args)) { queries.tip.push(args); return tipAnswer(live); }
    return '[]';
  };
  const scan = (stamp = '2026-10-15T00:00:00Z') => scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: stamp, clock: () => now, followMs, sleepFn: (ms) => { now += ms; },
    fullCollectMs: 1e12, gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin }, ownershipSnapshot: ownership, ghFn,
    collect, dispatchFn: () => { throw new Error('nothing to dispatch'); },
  });
  return { scan, queries };
}

test('SC1 a round over bound and Ready PRs sends exactly one merge-state query', (t) => {
  const f = roundFixture(t, { numbers: [951, 952, 953, 954, 955, 956], bound: [951, 952, 953] });
  const result = f.scan();
  assert.equal(result.prs.length, 6);
  assert.equal(f.queries.merge.length, 1, 'one batched read for all six PRs');
  assert.equal(f.queries.tip.length, 0, 'no PR reads its own merge state');
  assert.equal(f.queries.poll.length, 6, 'each PR still has its own fingerprint query');
  for (const args of f.queries.poll) assert.doesNotMatch(args.join(' '), /mergeStateStatus/);
  for (const args of f.queries.views) assert.doesNotMatch(args.join(' '), /mergeStateStatus/);
  assert.deepEqual(result.mergeStates, { batched: 6, error: null });
});

test('SC1 the poll gate takes the merge state from the batch, so a base move still changes the fingerprint', (t) => {
  let status = 'CLEAN';
  const f = roundFixture(t, { numbers: [951, 952], bound: [951], mergeBatch: (listing) => mergeBatchBody(listing, { status: () => status }) });
  f.scan();
  const second = f.scan('2026-10-15T00:02:00Z');
  assert.deepEqual(second.prs.map((item) => item.dispatch?.reason), ['fingerprint-unchanged', 'fingerprint-unchanged']);
  status = 'BEHIND';
  const third = f.scan('2026-10-15T00:04:00Z');
  assert.equal(third.prs.some((item) => item.dispatch?.reason === 'fingerprint-unchanged'), false, 'BEHIND is a change, so every PR is looked at again');
});

test('SC1 a batch that failed for another reason is not an error: each PR reads its own merge state, as before the batch existed', (t) => {
  const f = roundFixture(t, { numbers: [951, 952, 953], bound: [951], mergeBatch: () => { throw new Error('gh: HTTP 502 Bad Gateway'); } });
  const result = f.scan();
  assert.equal(result.prs.length, 3);
  assert.equal(f.queries.merge.length, 1);
  assert.equal(f.queries.tip.length, 3, 'one fallback read per PR');
  assert.match(result.mergeStates.error, /502/);
});

test('SC1 a rate-limited batch does not fan out into one read per PR: the PRs wait for the next round', (t) => {
  let limited = true;
  const f = roundFixture(t, { numbers: [951, 952, 953, 954], bound: [951, 952], mergeBatch: (listing) => {
    if (limited) throw new Error('gh: API rate limit already exceeded for user ID 1 (HTTP 403)');
    return mergeBatchBody(listing);
  } });
  const first = f.scan();
  assert.equal(first.prs.length, 4, 'the round still ends normally and reports every PR');
  assert.deepEqual([...new Set(first.prs.map((item) => item.dispatch.reason))], ['merge-state-unavailable']);
  assert.equal(f.queries.merge.length, 1);
  assert.equal(f.queries.tip.length, 0, 'no per-PR merge-state read');
  assert.equal(f.queries.poll.length, 0, 'and no per-PR fingerprint query either');
  assert.match(first.mergeStates.error, /rate limit/);
  limited = false;
  const second = f.scan('2026-10-15T00:02:00Z');
  assert.equal(second.prs.some((item) => item.dispatch.reason === 'merge-state-unavailable'), false, 'the next round handles them');
  assert.equal(f.queries.poll.length, 4);
});

test('SC5 PRs that change in a follow beat share one refreshed batch read', (t) => {
  const numbers = [961, 962, 963];
  const f = roundFixture(t, { numbers, followMs: FOLLOW_INTERVAL_MS,
    listingFor: (n, now) => (now >= 20000 ? { updatedAt: '2026-10-15T00:00:20Z' } : null) });
  const result = f.scan();
  assert.ok(result.prs.length >= numbers.length);
  // One read when the round starts, one when the beat finds the three changed PRs together - not one per changed PR.
  assert.equal(f.queries.merge.length, 2, `merge reads at ${f.queries.merge}`);
  assert.equal(f.queries.tip.length, 0);
});

// ---- SC4: the last-moment re-read before an action that writes to GitHub ----
function baseUpdateSnapshot(extra = {}) {
  return {
    pr: { id: 'PR_1', number: 7, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
      headRefOid: HEAD, headRefName: 'feat/x', baseRefOid: BASE, baseRefName: 'main', releaseEpoch: 'ready:e' },
    mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND', baseTipOid: TIP, mergeStateSource: 'batch',
    reviewEvidence: { ready: false, reason: 'behind', blockers: ['behind'], baseUpdateEligible: true },
    baseUpdateEligible: true, ...extra,
  };
}
function baseUpdate({ live, snapshot = baseUpdateSnapshot() }) {
  const calls = [];
  const ghFn = (args) => { calls.push(args); return isTipQuery(args) ? tipAnswer(live) : '{}'; };
  const result = run(updateBaseBranch({
    pr: snapshot.pr, entry: {}, snapshot, ghFn, ownershipSnapshot: function* () { return { pr: snapshot.pr }; },
    save: () => {}, now: '2026-10-21T00:00:00Z', viewer: 'owner', repo: 'example-org/example-plugin',
  }));
  return { result, put: calls.some((args) => args.join(' ').includes('update-branch')), reads: calls.filter(isTipQuery).length };
}

test('SC4 update-branch is sent only if the PR is still BEHIND the same base tip', () => {
  const still = baseUpdate({ live: { status: 'BEHIND' } });
  assert.equal(still.put, true);
  assert.equal(still.reads, 1);
  const cleaned = baseUpdate({ live: { status: 'CLEAN' } });
  assert.equal(cleaned.put, false, 'someone already updated the branch');
  assert.equal(cleaned.result.action.reason, 'merge-state-changed');
  const moved = baseUpdate({ live: { status: 'BEHIND', tip: MOVED } });
  assert.equal(moved.put, false, 'the base moved again, so the plan is stale');
  assert.equal(moved.result.action.reason, 'merge-state-changed');
});

test('SC4 a snapshot that was just read with its own query is not read a second time', () => {
  const fresh = baseUpdate({ live: { status: 'CLEAN' }, snapshot: baseUpdateSnapshot({ mergeStateSource: 'query' }) });
  assert.equal(fresh.reads, 0);
  assert.equal(fresh.put, true);
});

test('SC4 readMergeState returns the live merge state and base tip', () => {
  const live = run(readMergeState({ id: 'PR_1', ghFn: () => tipAnswer({ status: 'DIRTY' }) }));
  assert.deepEqual(live, { mergeStateStatus: 'DIRTY', baseTipOid: TIP, source: 'query' });
});

test('SC4 the merge-ready notice is sent only if a re-read still matches the snapshot, otherwise the PR is collected again next round', (t) => {
  const ready = (source) => (pr) => quiet(pr, { mergeReady: true, mergeStateStatus: 'CLEAN', baseTipOid: TIP, mergeStateSource: source, labels: ['review:merge-ready'] });
  const noticed = (result) => result.events.filter((event) => event.kind === 'merge-ready').map((event) => event.number);
  // What the round's batch read saw, and what the PR looks like when the notice is about to go out.
  const batch = { status: 'CLEAN', tip: TIP };
  const live = { status: 'BEHIND', tip: TIP };
  const f = roundFixture(t, { numbers: [971], collect: ready('batch'), live, mergeBatch: (listing) => mergeBatchBody(listing, batch) });
  const first = f.scan('2026-10-15T00:00:00Z');
  assert.deepEqual(noticed(first), [], 'the merge state moved after the batch read');
  assert.equal(first.prs[0].dispatch.reason, 'merge-ready-unconfirmed');
  // Nothing else changed on GitHub (the batch looks the same again), but the PR is still collected: the notice is owed.
  Object.assign(live, { status: 'CLEAN', tip: MOVED });
  assert.deepEqual(noticed(f.scan('2026-10-15T00:02:00Z')), [], 'the base tip moved after the batch read');
  Object.assign(live, { status: 'CLEAN', tip: TIP });
  assert.deepEqual(noticed(f.scan('2026-10-15T00:04:00Z')), [971], 'the next round confirms it and sends the notice once');
  assert.deepEqual(noticed(f.scan('2026-10-15T00:06:00Z')), [], 'and not again');
  const own = roundFixture(t, { numbers: [972], collect: ready('query'), live: { status: 'BEHIND', tip: MOVED } });
  assert.deepEqual(noticed(own.scan()), [972], 'a snapshot read with its own query is trusted as it is');
});

test('a bare 403 is not read as a rate limit: the PRs fall back to their own reads instead of waiting forever', (t) => {
  const f = roundFixture(t, { numbers: [951, 952], mergeBatch: () => { throw new Error('gh: HTTP 403: Resource not accessible by integration'); } });
  const result = f.scan();
  assert.equal(result.prs.some((item) => item.dispatch?.reason === 'merge-state-unavailable'), false);
  assert.equal(f.queries.tip.length, 2);
});

test('a blocked index stops every path that would read a PR\'s own merge state, not only the two skips', () => {
  const blocked = Object.assign(new Map(), { blocked: 'rate limit' });
  const calls = [];
  assert.throws(() => collectPrSnapshotSync({ pr: { number: 1 }, ghFn: snapshotGh({ calls }), mergeIndex: blocked }), /merge-state-unavailable/);
  assert.equal(calls.filter(mentionsMergeState).length, 0);
});
