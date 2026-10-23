import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoRepoReads, REPO, runGhAsync, scanOnce, scanOnceAsync, watcherPaths } from './bin/cindy-watcher.mjs';
import { readPr, writePr } from './bin/cindy-state.mjs';
import { autoCloseThreads, closeRefutedThreads } from './bin/cindy-review-resolve.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FORK = { sameRepository: false, isCrossRepository: true, author: { login: 'owner' },
  headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' } };
const listedPr = (number, extra = {}) => ({ number, id: `PR_${number}`, headRefOid: HEAD, headRefName: `fix/${number}`,
  title: 'fix', isDraft: false, labels: [], updatedAt: '2026-10-15T00:00:00Z', ...FORK, ...extra });

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-parallel-follow-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

// Required CI failed: an admitted, unbound PR that needs a repair session.
const failing = (listed) => ({
  pr: { id: listed.id, number: listed.number, state: 'OPEN', isDraft: false, ...FORK, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
  admissionVerified: true,
  checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
  ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
  policy: { status: 'verified', required: [{ context: 'unit' }] },
  comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
});

function* ownership() {
  return { pr: { state: 'OPEN', isDraft: false, ...FORK, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' } };
}

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

function options(t, paths, extra) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-parallel-follow-repo-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  return { mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { CINDY_WATCHER_REPO: repo }, ownershipSnapshot: ownership, ...extra };
}

test('discover collects and dispatches every PR of a round at the same time', async (t) => {
  const paths = homeOf(t);
  const prs = [listedPr(801), listedPr(802), listedPr(803)];
  let active = 0;
  let peak = 0;
  const sent = [];
  const started = Date.now();
  const result = await scanOnceAsync(options(t, paths, {
    ghFn: async (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      return '[]';
    },
    collect: async (pr) => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(300);
      active -= 1;
      return failing(pr);
    },
    dispatchFn: async (params) => { sent.push(params.title); await delay(200); return { target_session_id: `sess-${params.title.match(/#(\d+)/)[1]}` }; },
  }));
  const elapsed = Date.now() - started;
  assert.equal(peak, 3, 'all three PRs were collected at once');
  assert.equal(sent.length, 3);
  assert.deepEqual(result.prs.map((item) => [item.number, item.dispatch.attempted]), [[801, true], [802, true], [803, true]]);
  assert.ok(elapsed < 1200, `one round took ${elapsed} ms; three PRs in turn take at least 1500 ms`);
  for (const pr of prs) assert.equal(readPr(paths.home, pr.id).sessionId, `sess-${pr.number}`);
});

test('one PR whose collection fails does not hold up the others', async (t) => {
  const paths = homeOf(t);
  const prs = [listedPr(811), listedPr(812)];
  const sent = [];
  const result = await scanOnceAsync(options(t, paths, {
    ghFn: async (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      return '[]';
    },
    collect: async (pr) => {
      if (pr.number === 811) { await delay(200); throw new Error('GitHub 502'); }
      return failing(pr);
    },
    dispatchFn: async (params) => { sent.push(params.title); return { target_session_id: 'sess-812' }; },
  }));
  assert.deepEqual(result.prs.map((item) => [item.number, item.dispatch.reason ?? item.dispatch.attempted]),
    [[811, 'collection-failed'], [812, true]]);
  assert.equal(sent.length, 1);
  assert.equal(readPr(paths.home, 'PR_812').sessionId, 'sess-812');
});

test('after the full round, a PR that turns Ready is followed at the next follow interval', (t) => {
  const paths = homeOf(t);
  let now = 0;
  const listings = [];
  const sent = [];
  const result = scanOnce(options(t, paths, {
    clock: () => now, followMs: 45000, sleepFn: (ms) => { now += ms; },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') {
        listings.push(now);
        const ready = now >= 45000;
        return JSON.stringify([listedPr(821, ready ? { updatedAt: '2026-10-15T00:00:40Z' } : { isDraft: true })]);
      }
      return '[]';
    },
    collect: (pr) => failing(pr),
    dispatchFn: (params) => { sent.push({ at: now, title: params.title }); return { target_session_id: 'sess-821' }; },
  }));
  // Listing at start, then every 45 s here (followMs): +135 s leaves less than a collection plus the dispatch reserve
  // before the 165 s round budget ends.
  assert.deepEqual(listings, [0, 45000, 90000]);
  assert.deepEqual(sent.map((item) => item.at), [45000]);
  assert.equal(result.prs.at(-1).dispatch.attempted, true);
  assert.equal(readPr(paths.home, 'PR_821').sessionId, 'sess-821');
});

test('repository-wide reads are shared within a round; PR reads and writes are not', () => {
  const calls = [];
  const ghFn = memoRepoReads((args) => { calls.push(args.join(' ')); return `r${calls.length}`; });
  const protection = ['api', `repos/${REPO}/branches/main/protection`];
  assert.equal(ghFn(protection), ghFn(protection));
  assert.equal(ghFn(['api', 'user', '-q', '.login']), ghFn(['api', 'user', '-q', '.login']));
  assert.equal(calls.length, 2);
  ghFn(['api', `repos/${REPO}/issues/5/comments?per_page=100`]);
  ghFn(['api', `repos/${REPO}/issues/5/comments?per_page=100`]);
  ghFn(['api', `repos/${REPO}/actions/variables/X`, '-X', 'PATCH', '-f', 'value=1']);
  ghFn(['api', `repos/${REPO}/actions/variables/X`, '-X', 'PATCH', '-f', 'value=1']);
  ghFn(['api', 'repos/someone/cindy-fork/branches/main/protection']);
  ghFn(['api', 'repos/someone/cindy-fork/branches/main/protection']);
  assert.equal(calls.length, 8);
});

test('runGhAsync keeps the JSON gh prints with a failing or pending check', async () => {
  const runner = (stdout, code) => (_bin, _args, _options, callback) => {
    const error = Object.assign(new Error(`exit ${code}`), { code });
    setImmediate(() => callback(error, stdout, ''));
    return { stdin: { end() {} } };
  };
  assert.equal(await runGhAsync(['pr', 'checks', '5', '--json', 'name'], 1000, runner('[{"name":"unit"}]', 8)), '[{"name":"unit"}]');
  await assert.rejects(runGhAsync(['pr', 'view', '5'], 1000, runner('', 1)), /exit 1/);
});

const graphqlNode = (extra = {}) => ({
  state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { nodes: [] }, commits: { nodes: [] }, ...extra,
});

test('a PR dispatched again in the follow pass gets its own task, not the first task id', (t) => {
  const paths = homeOf(t);
  let now = 0;
  let round = 1;
  const sent = [];
  scanOnce(options(t, paths, {
    clock: () => now, followMs: 45000,
    sleepFn: (ms) => {
      now += ms;
      // The first repair finished while CI stayed red; a new CI run failed before the follow listing.
      const entry = readPr(paths.home, 'PR_841');
      writePr(paths.home, 'PR_841', { ...entry, activeTask: { ...entry.activeTask, status: 'complete' } });
      round = 2;
    },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([listedPr(841, { updatedAt: `2026-10-15T00:00:0${round}Z` })]);
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node: graphqlNode({ comments: { totalCount: round, nodes: [] } }) } });
      return '[]';
    },
    collect: (pr) => {
      const value = failing(pr);
      return { ...value, ci: { ...value.ci, required: [{ context: 'unit', status: 'failed', evidence: { id: round, runId: 10 + round, attempt: 1 } }] } };
    },
    dispatchFn: (params) => { sent.push(params.target_session_id ?? 'create'); return { target_session_id: 'sess-841' }; },
  }));
  assert.deepEqual(sent, ['create', 'sess-841']);
  const tasks = fs.readdirSync(path.join(paths.stateDir, 'tasks')).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(tasks, ['live-841-2026-10-15T00:00:00Z.json', 'live-841-2026-10-15T00:00:45.000Z.json']);
  assert.equal(readPr(paths.home, 'PR_841').lastDispatch.dispatchId, 'live-841-2026-10-15T00:00:45.000Z');
});

async function driveAsync(iterator) {
  let step = iterator.next();
  while (!step.done) {
    let value;
    try { value = await step.value(); } catch (error) { step = iterator.throw(error); continue; }
    step = iterator.next(value);
  }
  return step.value;
}

test('a denied reply or resolve still degrades when gh answers with a promise', async () => {
  const denied = async () => { throw Object.assign(new Error('Resource not accessible by integration (HTTP 403)'), { status: 1, stderr: 'HTTP 403' }); };
  const auto = await driveAsync(autoCloseThreads({ eligible: [{ threadId: 'T1', key: 'k1' }], ghFn: denied, now: 'n' }));
  assert.deepEqual(auto.closed.map((item) => [item.threadId, item.degraded, item.reason]), [['T1', true, 'permission-denied']]);
  const refuted = await driveAsync(closeRefutedThreads({ items: [{ threadId: 'T2', key: 'k2', evidence: ['不成立'] }], dispatchId: 'd', ghFn: denied, now: 'n' }));
  assert.deepEqual(refuted.closed.map((item) => [item.threadId, item.degraded, item.reason]), [['T2', true, 'permission-denied']]);
  await assert.rejects(driveAsync(autoCloseThreads({ eligible: [{ threadId: 'T3' }], ghFn: async () => { throw new Error('HTTP 502'); }, now: 'n' })), /502/);
});
