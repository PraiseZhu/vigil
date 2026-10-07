import test from 'node:test';
import assert from 'node:assert/strict';
import { selectHandoff, isCurrentHandoff, runHandoff } from './bin/mivo-handoff.mjs';

const repo = 'example-org/example-plugin';
const createdAt = '2026-09-01T00:00:00Z';
const readyAt = '2026-09-02T00:00:00Z';
const basic = { id: 'PR_1', number: 1, repo, state: 'OPEN', isDraft: false,
  headRefOid: 'a'.repeat(40), headRefName: 'feature', baseRefOid: 'b'.repeat(40), baseRefName: 'main',
  createdAt, author: { login: 'ExampleUser' }, isCrossRepository: false, sameRepository: true,
  headRepository: { name: 'example-plugin' }, headRepositoryOwner: { login: 'example-org' },
  releaseEpoch: `ready:PR_1:READY_1:${readyAt}` };
const marker = (overrides = {}) => ({ version: 1, repo, number: 1, nodeId: basic.id,
  head: basic.headRefOid, releaseEpoch: basic.releaseEpoch, ...overrides });
const comment = (overrides = {}, payload = {}) => ({ id: 42, user: { login: 'ExampleUser', type: 'User' },
  created_at: '2026-09-02T00:01:00Z', body: `作者已交接。\n<!-- vigil-handoff ${JSON.stringify(marker(payload))} -->`, ...overrides });

test('only actual author comments with a complete current handoff are accepted', () => {
  const receipt = selectHandoff([comment()], basic);
  assert.deepEqual(receipt, { ...marker(), id: '42', author: 'ExampleUser' });
  assert.equal(isCurrentHandoff(receipt, basic), true);
  assert.ok(selectHandoff([comment({ user: { login: 'exampleuser' } })], basic));
  assert.ok(selectHandoff([comment({ author: { login: 'ExampleUser', __typename: 'User' }, createdAt: '2026-09-02T00:02:00Z' })], basic));
  for (const invalid of [comment({ user: { login: 'OtherUser' } }), comment({ user: { login: 'ExampleUser', type: 'Bot' } }),
    comment({ author: { login: 'ExampleUser', __typename: 'Bot' } }),
    comment({ id: null }), comment({ id: {} }), comment({ created_at: 'invalid' }),
    comment({ created_at: createdAt }), comment({}, { head: 'c'.repeat(40) }),
    comment({}, { releaseEpoch: `ready:PR_1:OLD:${createdAt}` }), comment({}, { nodeId: 'PR_OTHER' }),
    comment({}, { repo: 'example-org/other' }), comment({}, { number: 2 }), comment({}, { version: 2 }),
    comment({}, { releaseEpoch: null }), comment({ body: '<!-- vigil-handoff {} -->' }),
    comment({ body: `prefix <!-- vigil-handoff ${JSON.stringify(marker())} -->` }),
    comment({ body: `<!-- vigil-handoff ${JSON.stringify(marker())} --> suffix` }),
    comment({ body: `${comment().body}\n${comment().body}` })]) {
    assert.equal(selectHandoff([invalid], basic), null, JSON.stringify(invalid));
  }
});

test('draft, closed, forks, missing identity and new Ready epochs invalidate receipts', () => {
  const receipt = selectHandoff([comment()], basic);
  for (const patch of [{ isDraft: true }, { state: 'CLOSED' }, { sameRepository: false },
    { isCrossRepository: true }, { repo: undefined }, { author: { login: 'OtherUser' } },
    { releaseEpoch: `ready:PR_1:READY_2:${readyAt}` }]) {
    assert.equal(isCurrentHandoff(receipt, { ...basic, ...patch }, { allowHeadChange: true }), false);
    assert.equal(selectHandoff([comment()], { ...basic, ...patch }), null);
  }
  const next = { ...basic, headRefOid: 'c'.repeat(40) };
  assert.equal(isCurrentHandoff(receipt, next), false);
  assert.equal(isCurrentHandoff(receipt, next, { allowHeadChange: true }), true);
  assert.equal(isCurrentHandoff({ ...receipt, head: '' }, next, { allowHeadChange: true }), false);
});

function fixture({ existing = [], login = 'ExampleUser', drift = false, epochDrift = false, postFailure = false, reclaimFailure = false } = {}) {
  const calls = []; let posted = false; let draft = false;
  const ghFn = args => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'user') return JSON.stringify({ login, type: 'User' });
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ ...basic,
      isDraft: draft, ...(posted && drift ? { headRefOid: 'c'.repeat(40) } : {}) });
    if (args[1] === 'graphql') return JSON.stringify({ data: { node: { timelineItems: {
      nodes: [{ __typename: draft ? 'ConvertToDraftEvent' : 'ReadyForReviewEvent', id: draft ? 'DRAFT_1' : posted && epochDrift ? 'READY_2' : 'READY_1', createdAt: readyAt }],
      pageInfo: { hasNextPage: false, endCursor: null } } } } });
    if (args[0] === 'pr' && args[1] === 'ready') { if (!reclaimFailure) draft = true; return ''; }
    if (args.includes('POST')) {
      posted = true;
      if (postFailure) throw new Error('network timeout after POST');
      return JSON.stringify(comment({ body: args[args.indexOf('-f') + 1].slice('body='.length) }));
    }
    if (args[1].startsWith('repos/')) return JSON.stringify([existing]);
    throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
  };
  return { ghFn, calls, options: { command: 'handoff', repo, number: 1, ghFn } };
}

test('handoff posts once, verifies current ownership and returns receipt; repeats are idempotent', () => {
  const f = fixture();
  const result = runHandoff(f.options);
  assert.equal(result.status, 'handed-off');
  assert.equal(isCurrentHandoff(result.receipt, basic), true);
  assert.equal(f.calls.filter(args => args.includes('POST')).length, 1);
  const repeat = fixture({ existing: [comment()] });
  assert.equal(runHandoff(repeat.options).status, 'already-handed-off');
  assert.equal(repeat.calls.some(args => args.includes('POST')), false);
});

test('handoff rejects another account, unknown POST outcome and post-write head drift', () => {
  const wrong = fixture({ login: 'OtherUser' });
  assert.throws(() => runHandoff(wrong.options), /author/);
  assert.equal(wrong.calls.some(args => args.includes('POST')), false);
  const unknown = fixture({ postFailure: true });
  assert.throws(() => runHandoff(unknown.options), /network timeout/);
  assert.equal(unknown.calls.filter(args => args.includes('POST')).length, 1);
  assert.throws(() => runHandoff(fixture({ drift: true }).options), /changed/);
});

test('reclaim uses ready undo and verifies Draft before declaring author-owned', () => {
  const f = fixture();
  assert.equal(runHandoff({ ...f.options, command: 'reclaim' }).status, 'author-owned');
  assert.ok(f.calls.some(args => args.join(' ') === `pr ready 1 --repo ${repo} --undo`));
  assert.throws(() => runHandoff({ ...fixture({ reclaimFailure: true }).options, command: 'reclaim' }), /Draft/);
});

test('same-head Ready epoch changes after POST are rejected and query errors never trigger a POST', () => {
  assert.throws(() => runHandoff(fixture({ epochDrift: true }).options), /changed/);
  const f = fixture();
  assert.throws(() => runHandoff({ ...f.options, ghFn: args => {
    if (args.includes('--paginate')) throw new Error('comments unavailable');
    return f.ghFn(args);
  } }), /comments unavailable/);
  assert.equal(f.calls.some(args => args.includes('POST')), false);
});

test('opened-ready PRs use their opened epoch and no incomplete epoch is accepted', () => {
  const opened = { ...basic, releaseEpoch: `opened:${basic.id}:${createdAt}` };
  assert.ok(selectHandoff([comment({}, { releaseEpoch: opened.releaseEpoch })], opened));
  assert.equal(selectHandoff([comment({}, { releaseEpoch: 'ready:PR_1' })], { ...basic, releaseEpoch: 'ready:PR_1' }), null);
});
