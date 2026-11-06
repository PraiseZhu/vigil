import test from 'node:test';
import assert from 'node:assert/strict';
import { readBatch, readOpenPrNodes } from './bin/mivo-watcher.mjs';
import { followBatchBody } from './handoff.fixture.mjs';

// 2026-11-04: the follow beat's `search` root is answered by the gh router as the personal account (about 4 reads a
// minute, most of that account's non-per-PR GraphQL traffic). A repository read is served by the GitHub App instead.
const REPO = 'example-org/example-plugin';
const HEAD = 'a'.repeat(40);
const node = (id, extra = {}) => ({ id, isDraft: false, headRefOid: HEAD, updatedAt: '2026-10-15T00:00:00Z', labels: { nodes: [{ name: 'b' }, { name: 'a' }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...extra });
function run(gen) {
  let step = gen.next();
  while (!step.done) {
    try { step = gen.next(typeof step.value === 'function' ? step.value() : step.value); }
    catch (error) { step = gen.throw(error); }
  }
  return step.value;
}
const queryOf = (args) => args.find((arg) => String(arg).startsWith('query='));

test('the follow read is a repository read the router can serve as the App: no search root, no viewer, no merge state', () => {
  const calls = [];
  run(readBatch({ ghFn: (args) => { calls.push(args); return followBatchBody([]); }, viewer: 'owner', repo: REPO }));
  assert.equal(calls.length, 1);
  const query = queryOf(calls[0]);
  assert.match(query, /repository\(owner:"example-org",name:"example-plugin"\)\{pullRequests\(states:OPEN,first:100\)/);
  assert.doesNotMatch(query, /search\(|viewer|mergeStateStatus|reviewRequest|project|team|member|permission/i);
  assert.match(query, /statusCheckRollup\{state\}/);
  assert.doesNotMatch(query, /contexts|checkRuns|reviewThreads/);
});

test('only the viewer\'s own PRs are kept, matched without regard to case', () => {
  const body = followBatchBody([node('PR_1'), node('PR_2', { author: { login: 'someone-else' } }), node('PR_3', { author: { login: 'OWNER' } }), node('PR_4', { author: null })]);
  const signatures = run(readBatch({ ghFn: () => body, viewer: 'owner', repo: REPO }));
  assert.deepEqual([...signatures.keys()], ['PR_1', 'PR_3']);
  assert.deepEqual(JSON.parse(signatures.get('PR_1')), [false, HEAD, '2026-10-15T00:00:00Z', ['a', 'b'], 'SUCCESS']);
});

test('every page is read, each with the cursor of the page before', () => {
  const queries = [];
  const ghFn = (args) => {
    queries.push(queryOf(args));
    return queries.length === 1 ? followBatchBody([node('PR_1')], { hasNextPage: true, endCursor: 'c1' }) : followBatchBody([node('PR_2')]);
  };
  const signatures = run(readBatch({ ghFn, viewer: 'owner', repo: REPO }));
  assert.deepEqual([...signatures.keys()], ['PR_1', 'PR_2']);
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[0], /after:/);
  assert.match(queries[1], /first:100,after:"c1"/);
});

test('an incomplete answer fails instead of returning a partial map', () => {
  const bad = (payload) => () => run(readBatch({ ghFn: () => JSON.stringify(payload), viewer: 'owner', repo: REPO }));
  assert.throws(bad({ errors: [{ message: 'boom' }], data: null }), /incomplete/);
  assert.throws(bad({ data: { repository: { pullRequests: { nodes: [] } } } }), /incomplete/);
  assert.throws(bad({ data: { repository: null } }), /incomplete/);
  assert.throws(() => run(readBatch({ ghFn: () => followBatchBody([node('PR_1')], { hasNextPage: true, endCursor: null }), viewer: 'owner', repo: REPO })), /cursor missing/);
  assert.throws(() => run(readBatch({ ghFn: () => followBatchBody([node('PR_1')], { hasNextPage: true, endCursor: 'again' }), viewer: 'owner', repo: REPO })), /too many pages/);
});

// The other-authors path reads the same open-PR list without the viewer filter (watcher: readOpenPrNodes).
test('readOpenPrNodes returns every open PR whoever wrote it, across pages, and fails on an incomplete answer', () => {
  const queries = [];
  const ghFn = (args) => {
    queries.push(queryOf(args));
    return queries.length === 1
      ? followBatchBody([node('PR_1'), node('PR_2', { author: { login: 'someone-else' } })], { hasNextPage: true, endCursor: 'c1' })
      : followBatchBody([node('PR_3', { author: null })]);
  };
  const nodes = run(readOpenPrNodes({ ghFn, repo: REPO }));
  assert.deepEqual(nodes.map((item) => item.id), ['PR_1', 'PR_2', 'PR_3']);
  assert.match(queries[1], /first:100,after:"c1"/);
  assert.throws(() => run(readOpenPrNodes({ ghFn: () => JSON.stringify({ errors: [{ message: 'boom' }], data: null }), repo: REPO })), /incomplete/);
  assert.throws(() => run(readOpenPrNodes({ ghFn: () => followBatchBody([node('PR_1')], { hasNextPage: true, endCursor: 'again' }), repo: REPO })), /too many pages/);
});

test('readOpenPrNodes asks for the fields of the query it is given', () => {
  const calls = [];
  const queryFor = (repo, after) => `query{marker(repo:${JSON.stringify(repo)},after:${JSON.stringify(after)})}`;
  run(readOpenPrNodes({ ghFn: (args) => { calls.push(args); return followBatchBody([]); }, repo: REPO, queryFor }));
  assert.deepEqual(calls, [['api', 'graphql', '-f', `query=query{marker(repo:"${REPO}",after:null)}`]]);
});
