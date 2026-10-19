import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRANCH_POLICY_TTL_MS, VIEWER_TTL_MS, keptReadStore, memoRepoReads, scanOnce, watcherPaths } from './bin/cindy-watcher.mjs';

const REPO = 'makecindy/cindy';
const VIEWER = ['api', 'user', '-q', '.login'];
const RULES = ['api', `repos/${REPO}/rules/branches/main?per_page=100`, '--paginate', '--slurp'];
const BRANCH = ['api', `repos/${REPO}/branches/main`];
const PROTECTION = ['api', `repos/${REPO}/branches/main/protection`];
const VARIABLE = ['api', `repos/${REPO}/actions/variables/MODE`];

function stateDirOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-kept-reads-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return watcherPaths(home);
}

function counting(output = (args) => `out:${args[1]}`) {
  const calls = [];
  const ghFn = (args) => { calls.push(args.join(' ')); return output(args); };
  return { ghFn, count: (args) => calls.filter((call) => call === args.join(' ')).length };
}

test('the login is read once across rounds and again after 6 hours', (t) => {
  const { stateDir } = stateDirOf(t);
  let now = 1_000_000;
  const gh = counting(() => 'ExampleUser\n');
  const round = () => memoRepoReads(gh.ghFn, keptReadStore(stateDir, () => now))(VIEWER);
  assert.equal(round(), 'ExampleUser\n');
  now += 2 * 60 * 1000;
  assert.equal(round(), 'ExampleUser\n');
  assert.equal(gh.count(VIEWER), 1);
  now += VIEWER_TTL_MS;
  round();
  assert.equal(gh.count(VIEWER), 2);
});

test('branch rules, branch and protection are kept for 10 minutes; other reads only within a round', (t) => {
  const { stateDir } = stateDirOf(t);
  let now = 5_000_000;
  const gh = counting();
  const round = () => {
    const ghFn = memoRepoReads(gh.ghFn, keptReadStore(stateDir, () => now));
    for (const args of [RULES, BRANCH, PROTECTION, VARIABLE, RULES]) ghFn(args);
  };
  round();
  now += BRANCH_POLICY_TTL_MS - 1;
  round();
  for (const args of [RULES, BRANCH, PROTECTION]) assert.equal(gh.count(args), 1, args[1]);
  assert.equal(gh.count(VARIABLE), 2);
  now += 1;
  round();
  for (const args of [RULES, BRANCH, PROTECTION]) assert.equal(gh.count(args), 2, args[1]);
});

test('writes, failures and empty output are never kept', async (t) => {
  const { stateDir } = stateDirOf(t);
  const now = 9_000_000;
  const write = ['api', `repos/${REPO}/branches/main/protection`, '--method', 'PUT'];
  const writes = counting();
  for (let i = 0; i < 2; i += 1) memoRepoReads(writes.ghFn, keptReadStore(stateDir, () => now))(write);
  assert.equal(writes.count(write), 2);

  let calls = 0;
  const failing = () => { calls += 1; return Promise.reject(new Error('HTTP 502')); };
  await assert.rejects(memoRepoReads(failing, keptReadStore(stateDir, () => now))(PROTECTION), /502/);
  await assert.rejects(memoRepoReads(failing, keptReadStore(stateDir, () => now))(PROTECTION), /502/);
  assert.equal(calls, 2);

  const empty = counting(() => '  \n');
  for (let i = 0; i < 2; i += 1) memoRepoReads(empty.ghFn, keptReadStore(stateDir, () => now))(VIEWER);
  assert.equal(empty.count(VIEWER), 2);
});

test('async output is kept once it resolves', async (t) => {
  const { stateDir } = stateDirOf(t);
  const now = 12_000_000;
  let calls = 0;
  const ghFn = async () => { calls += 1; return 'ExampleUser\n'; };
  assert.equal(await memoRepoReads(ghFn, keptReadStore(stateDir, () => now))(VIEWER), 'ExampleUser\n');
  assert.equal(await memoRepoReads(ghFn, keptReadStore(stateDir, () => now))(VIEWER), 'ExampleUser\n');
  assert.equal(calls, 1);
});

test('a corrupt or future-dated store is ignored', (t) => {
  const { stateDir } = stateDirOf(t);
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, 'kept-reads.json');
  fs.writeFileSync(file, '{not json');
  const gh = counting(() => 'ExampleUser\n');
  memoRepoReads(gh.ghFn, keptReadStore(stateDir, () => 1000))(VIEWER);
  fs.writeFileSync(file, JSON.stringify({ version: 1, entries: { [JSON.stringify(VIEWER)]: { at: 5000, ttl: VIEWER_TTL_MS, value: 'Stale\n' } } }));
  assert.equal(memoRepoReads(gh.ghFn, keptReadStore(stateDir, () => 1000))(VIEWER), 'ExampleUser\n');
  assert.equal(gh.count(VIEWER), 2);
});

test('two discover rounds in the same home ask GitHub for the login once', (t) => {
  const paths = stateDirOf(t);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const gh = counting((args) => (args[0] === 'api' && args[1] === 'user' ? 'ExampleUser\n' : '[]'));
  const listArgs = [];
  const ghFn = (args) => {
    if (args[0] === 'pr' && args[1] === 'list') listArgs.push(args);
    return gh.ghFn(args);
  };
  for (const now of ['2026-10-19T00:00:00Z', '2026-10-19T00:02:00Z']) {
    const result = scanOnce({ mode: 'discover', enabled: false, paths, now, ghFn });
    assert.equal(result.viewer, 'ExampleUser');
  }
  assert.equal(gh.count(VIEWER), 1);
  assert.equal(listArgs.length, 2);
  for (const args of listArgs) {
    assert.equal(args[args.indexOf('--author') + 1], 'ExampleUser');
    assert.doesNotMatch(args.join(' '), /headRepository/);
  }
});

test('only the login read is kept; a full /user read stays live', (t) => {
  const { stateDir } = stateDirOf(t);
  const now = 15_000_000;
  const full = ['api', 'user'];
  const gh = counting(() => '{"login":"ExampleUser"}');
  for (let i = 0; i < 2; i += 1) memoRepoReads(gh.ghFn, keptReadStore(stateDir, () => now))(full);
  assert.equal(gh.count(full), 2);
});
