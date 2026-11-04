import test from 'node:test';
import assert from 'node:assert/strict';
import { readBatch } from './bin/cindy-watcher.mjs';

// 2026-11-04: the follow beat's `search` root is answered by the gh router as the personal account (about 4 reads a
// minute, most of that account's non-per-PR GraphQL traffic). `nodes(ids:[...])` is served by the GitHub App instead,
// and a round with no PRs of its own has nothing to read.
const HEAD = 'a'.repeat(40);
const node = (id, extra = {}) => ({ id, isDraft: false, headRefOid: HEAD, updatedAt: '2026-10-15T00:00:00Z', labels: { nodes: [{ name: 'b' }, { name: 'a' }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] }, ...extra });
const body = (nodes) => JSON.stringify({ data: { nodes } });
function run(gen) {
  let step = gen.next();
  while (!step.done) {
    try { step = gen.next(typeof step.value === 'function' ? step.value() : step.value); }
    catch (error) { step = gen.throw(error); }
  }
  return step.value;
}
const queryOf = (args) => args.find((arg) => String(arg).startsWith('query='));

test('the follow read names the listed PRs by id: a nodes root, no search, no viewer, no merge state', () => {
  const calls = [];
  const signatures = run(readBatch({ ghFn: (args) => { calls.push(args); return body([node('PR_1'), node('PR_2')]); }, ids: ['PR_1', 'PR_2'] }));
  assert.equal(calls.length, 1);
  const query = queryOf(calls[0]);
  assert.match(query, /^query=query\{nodes\(ids:\["PR_1","PR_2"\]\)\{\.\.\. on PullRequest\{/);
  assert.doesNotMatch(query, /search\(|viewer|mergeStateStatus|reviewRequest|project|team|member|permission/i);
  assert.match(query, /statusCheckRollup\{state\}/);
  assert.doesNotMatch(query, /contexts|checkRuns|reviewThreads/);
  assert.deepEqual([...signatures.keys()], ['PR_1', 'PR_2']);
  assert.deepEqual(JSON.parse(signatures.get('PR_1')), [false, HEAD, '2026-10-15T00:00:00Z', ['a', 'b'], 'SUCCESS']);
});

test('no listed PRs means no read at all', () => {
  let calls = 0;
  const signatures = run(readBatch({ ghFn: () => { calls += 1; return body([]); }, ids: [] }));
  assert.equal(calls, 0);
  assert.equal(signatures.size, 0);
});

test('more than 100 PRs are read in chunks of 100, in order', () => {
  const ids = Array.from({ length: 230 }, (_, i) => `PR_${i}`);
  const asked = [];
  const ghFn = (args) => {
    const wanted = [...queryOf(args).matchAll(/"(PR_\d+)"/g)].map((m) => m[1]);
    asked.push(wanted.length);
    return body(wanted.map((id) => node(id)));
  };
  const signatures = run(readBatch({ ghFn, ids }));
  assert.deepEqual(asked, [100, 100, 30]);
  assert.equal(signatures.size, 230);
});

test('a PR the read no longer returns (deleted) is left out, not guessed', () => {
  const signatures = run(readBatch({ ghFn: () => body([node('PR_1'), null]), ids: ['PR_1', 'PR_gone'] }));
  assert.deepEqual([...signatures.keys()], ['PR_1']);
});

test('an incomplete answer fails instead of returning a partial map', () => {
  const bad = (payload) => () => run(readBatch({ ghFn: () => JSON.stringify(payload), ids: ['PR_1'] }));
  assert.throws(bad({ errors: [{ message: 'boom' }], data: null }), /incomplete/);
  assert.throws(bad({ data: { nodes: null } }), /incomplete/);
  assert.throws(bad({ data: {} }), /incomplete/);
});
