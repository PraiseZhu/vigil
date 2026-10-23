import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoRepoReads, REPO, runGhAsync, scanOnce, scanOnceAsync, watcherPaths } from './bin/mivo-watcher.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';
import { handoffPr, withAuthorHandoff } from './handoff.fixture.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const listedPr = (number, extra = {}) => ({ number, id: `PR_${number}`, headRefOid: HEAD, headRefName: `fix/${number}`,
  title: 'fix', isDraft: false, labels: [], updatedAt: '2026-10-15T00:00:00Z', ...extra });

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-follow-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

// Required CI failed: an admitted, unbound PR that needs a repair session.
function failing(listed) {
  return withAuthorHandoff({
    pr: { id: listed.id, number: listed.number, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
      headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true,
    checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
    ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
    policy: { status: 'verified', required: [{ context: 'unit' }] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  }, listed);
}

function* ownership({ pr }) {
  return { pr: handoffPr({ id: `PR_${pr.number}`, number: pr.number, state: 'OPEN', isDraft: false, sameRepository: true,
    author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' }) };
}

const delay = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

test('discover collects and dispatches every PR of a round at the same time', async (t) => {
  const paths = homeOf(t);
  const prs = [listedPr(801), listedPr(802), listedPr(803)];
  let active = 0;
  let peak = 0;
  const sent = [];
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-follow-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const started = Date.now();
  const result = await scanOnceAsync({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
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
    ownershipSnapshot: ownership,
  });
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
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-follow-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const result = await scanOnceAsync({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
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
    ownershipSnapshot: ownership,
  });
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
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-follow-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  const result = scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
    clock: () => now, followMs: 45000, sleepFn: (ms) => { now += ms; },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      const current = () => [listedPr(821, now >= 45000 ? { updatedAt: '2026-10-15T00:00:40Z' } : { isDraft: true })];
      if (isBatchQuery(args)) return batchBody(current());
      if (args[0] === 'pr' && args[1] === 'list') {
        listings.push(now);
        return JSON.stringify(current());
      }
      return '[]';
    },
    collect: (pr) => failing(pr),
    dispatchFn: (params) => { sent.push({ at: now, title: params.title }); return { target_session_id: 'sess-821' }; },
    ownershipSnapshot: ownership,
  });
  // Full listing at the start and once more when the batched query shows a change (no change, no listing).
  assert.deepEqual(listings, [0, 45000]);
  assert.deepEqual(sent.map((item) => item.at), [45000]);
  assert.deepEqual(result.prs.map((item) => [item.number, item.dispatch.reason ?? item.dispatch.attempted]),
    [[821, 'draft-author-owned'], [821, result.prs[1].dispatch.reason ?? true]]);
  assert.equal(result.prs[1].dispatch.attempted, true);
  assert.equal(readPr(paths.home, 'PR_821').sessionId, 'sess-821');
});

test('a follow listing with no change does not collect any PR again', (t) => {
  const paths = homeOf(t);
  let now = 0;
  let collected = 0;
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-follow-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
    clock: () => now, followMs: 45000, sleepFn: (ms) => { now += ms; },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([listedPr(831, { isDraft: true })]);
      return '[]';
    },
    collect: () => { collected += 1; throw new Error('a Draft is never collected'); },
    dispatchFn: () => { throw new Error('nothing to dispatch'); },
    ownershipSnapshot: ownership,
  });
  assert.equal(collected, 0);
});

test('repository-wide reads are shared within a round; PR reads and writes are not', () => {
  const calls = [];
  const ghFn = memoRepoReads((args) => { calls.push(args.join(' ')); return `r${calls.length}`; });
  const protection = ['api', `repos/${REPO}/branches/main/protection`];
  const rules = ['api', `repos/${REPO}/rules/branches/main?per_page=100`, '--paginate', '--slurp'];
  const pinned = ['api', `repos/${REPO}/contents/docs/sync/required-checks.json?ref=${'c'.repeat(40)}`];
  assert.equal(ghFn(protection), ghFn(protection));
  assert.equal(ghFn(rules), ghFn(rules));
  assert.equal(ghFn(pinned), ghFn(pinned));
  assert.equal(ghFn(['api', 'user', '-q', '.login']), ghFn(['api', 'user', '-q', '.login']));
  assert.equal(calls.length, 4);
  ghFn(['api', `repos/${REPO}/issues/5/comments?per_page=100`]);
  ghFn(['api', `repos/${REPO}/issues/5/comments?per_page=100`]);
  ghFn(['api', `repos/${REPO}/actions/variables/MIVO_REVIEW_MODE`, '-X', 'PATCH', '-f', 'value=live']);
  ghFn(['api', `repos/${REPO}/actions/variables/MIVO_REVIEW_MODE`, '-X', 'PATCH', '-f', 'value=live']);
  ghFn(['api', `repos/${REPO}/contents/docs/sync/required-checks.json?ref=main`]);
  ghFn(['api', `repos/${REPO}/contents/docs/sync/required-checks.json?ref=main`]);
  ghFn(['pr', 'view', '5', '--repo', REPO]);
  ghFn(['pr', 'view', '5', '--repo', REPO]);
  assert.equal(calls.length, 12);
});

test('a failed shared read is retried by the next caller', async () => {
  let calls = 0;
  const ghFn = memoRepoReads(async () => { calls += 1; if (calls === 1) throw new Error('502'); return 'ok'; });
  const protection = ['api', `repos/${REPO}/branches/main/protection`];
  await assert.rejects(ghFn(protection), /502/);
  assert.equal(await ghFn(protection), 'ok');
  assert.equal(calls, 2);
});

test('runGhAsync keeps the JSON gh prints with a failing or pending check', async () => {
  const runner = (stdout, code) => (_bin, _args, _options, callback) => {
    const error = Object.assign(new Error(`exit ${code}`), { code });
    setImmediate(() => callback(error, stdout, ''));
    return { stdin: { end() {} } };
  };
  assert.equal(await runGhAsync(['pr', 'checks', '5', '--json', 'name'], 1000, runner('[{"name":"unit"}]', 8)), '[{"name":"unit"}]');
  await assert.rejects(runGhAsync(['pr', 'view', '5'], 1000, runner('', 1)), /exit 1/);
  const ok = (_bin, _args, _options, callback) => { setImmediate(() => callback(null, 'fine', '')); return {}; };
  assert.equal(await runGhAsync(['api', 'user'], 1000, ok), 'fine');
});

// One-query poll snapshot a bound PR gets inside discover.
const graphqlNode = (extra = {}) => ({
  state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { nodes: [] }, commits: { nodes: [] }, ...extra,
});

// One batched query (gh api graphql search) per follow beat: the light fingerprint fields of every open PR.
const batchBody = (prs) => JSON.stringify({ data: { search: { issueCount: prs.length, nodes: prs.map((pr) => ({ id: pr.id, number: pr.number,
  isDraft: pr.isDraft === true, headRefOid: pr.headRefOid, updatedAt: pr.updatedAt, labels: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } })) } } });
const isBatchQuery = (args) => args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('search('));

test('a PR dispatched again in the follow pass gets its own task, not the first task id', (t) => {
  const paths = homeOf(t);
  let now = 0;
  let round = 1;
  const sent = [];
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'parallel-follow-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
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
      if (isBatchQuery(args)) return batchBody([listedPr(841, { updatedAt: `2026-10-15T00:00:0${round}Z` })]);
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node: graphqlNode({ comments: { totalCount: round, nodes: [] } }) } });
      return '[]';
    },
    collect: (pr) => {
      const value = failing(pr);
      return { ...value, ci: { ...value.ci, required: [{ context: 'unit', status: 'failed', evidence: { id: round, runId: 10 + round, attempt: 1 } }] } };
    },
    dispatchFn: (params) => { sent.push(params.target_session_id ?? 'create'); return { target_session_id: 'sess-841' }; },
    ownershipSnapshot: ownership,
  });
  assert.deepEqual(sent, ['create', 'sess-841']);
  const tasks = fs.readdirSync(path.join(paths.stateDir, 'tasks')).filter((name) => name.endsWith('.json')).sort();
  assert.deepEqual(tasks, ['live-841-2026-10-15T00:00:00Z.json', 'live-841-2026-10-15T00:00:45.000Z.json']);
  assert.equal(readPr(paths.home, 'PR_841').lastDispatch.dispatchId, 'live-841-2026-10-15T00:00:45.000Z');
});
