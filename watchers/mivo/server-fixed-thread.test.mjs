import test from 'node:test';
import assert from 'node:assert/strict';
import { isServerFixedThread, partitionServerFixedThreads, resolveServerFixedThreads, SERVER_FIXED_REASON } from './bin/mivo-review-resolve.mjs';

// Which review threads the review server already re-checked and found fixed, and what the watcher does with the
// App's answer. Logins come from test.env (the configured reviewer is ExampleReviewer); the App bot is the one
// the identity module names. Nothing here is a real account, repository or token.
const HEAD = 'a'.repeat(40);
const OTHER_HEAD = 'b'.repeat(40);
const KEY = '0123456789ab';
const REVIEWER = { login: 'ExampleReviewer', __typename: 'User' };
const BOT_GRAPHQL = { login: 'praisebuild', __typename: 'Bot' };

const findingBody = (key = KEY) => `[P1] 空值未处理\n\n<!-- mivo-finding key=${key} round=1 head=${'1'.repeat(7)} class=null-guard -->`;
const first = (extra = {}) => ({ id: 'PRRC_first', author: REVIEWER, body: findingBody(), createdAt: '2026-11-05T01:00:00Z', ...extra });
const oldText = (head = HEAD, key = KEY, { colon = ':', open = '(', close = ')' } = {}) =>
  `本轮在提交 ${head} 完成复核${colon}本轮复核未再发现该问题${open}key=${key}${close}。审查运行:https://example.test/runs/1。现由审查机代为 resolve;如仍有异议,可 unresolve 让审查机重看。`;
const marker = (head = HEAD, key = KEY) => `<!-- mivo-review:thread-fixed key=${key} head=${head} -->`;
const reply = (body, extra = {}) => ({ id: 'PRRC_reply', author: BOT_GRAPHQL, body, createdAt: '2026-11-05T02:00:00Z', ...extra });
const thread = (comments, extra = {}) => ({ id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'src/a.mjs', comments, ...extra });
const hit = (...args) => isServerFixedThread(thread([first(), reply(...args)]), HEAD);

test('the older sentence and the thread-fixed marker both mark a thread as fixed, from either bot form', () => {
  assert.deepEqual(hit(oldText()), { threadId: 'PRRT_1', key: KEY, head: HEAD, commentId: 'PRRC_reply' });
  assert.equal(hit(marker())?.key, KEY);
  assert.equal(hit(`${oldText()}\n${marker()}`)?.key, KEY, 'both forms in one reply must agree and may stand together');
  // REST names the bot praisebuild[bot] and puts the author under `user`; the configured human reviewer works too.
  assert.ok(isServerFixedThread(thread([first(), { id: 'PRRC_reply', user: { login: 'praisebuild[bot]', type: 'Bot' }, body: marker() }]), HEAD));
  assert.ok(isServerFixedThread(thread([first(), reply(marker(), { author: REVIEWER })]), HEAD));
  assert.ok(isServerFixedThread(thread([first({ author: BOT_GRAPHQL }), reply(marker())]), HEAD), 'the bot may have opened the thread');
});

test('full-width colon and brackets in the older sentence are accepted', () => {
  assert.ok(hit(oldText(HEAD, KEY, { colon: '：', open: '（', close: '）' })));
  assert.ok(hit(oldText(HEAD, KEY, { colon: ':', open: '（', close: ')' })));
});

test('the finding key is the last marker in the opening comment', () => {
  const body = `${findingBody('ffffffffffff')}\n${findingBody()}`;
  assert.ok(isServerFixedThread(thread([first({ body }), reply(marker())]), HEAD));
  assert.equal(isServerFixedThread(thread([first({ body: `${findingBody()}\n${findingBody('ffffffffffff')}` }), reply(marker())]), HEAD), null);
});

test('comments sort by time when every comment has one; otherwise API order stands', () => {
  const late = reply(marker(), { createdAt: '2026-11-05T09:00:00Z' });
  assert.ok(isServerFixedThread(thread([late, first()]), HEAD), 'listed out of order but chronologically a closing reply');
  const human = { id: 'PRRC_h', author: { login: 'someone', __typename: 'User' }, body: 'still broken', createdAt: '2026-11-05T10:00:00Z' };
  assert.equal(isServerFixedThread(thread([first(), late, human]), HEAD), null);
});

const rejects = {
  'head in the older sentence is not the current head': () => hit(oldText(OTHER_HEAD)),
  'head in the marker is not the current head': () => hit(marker(OTHER_HEAD)),
  'older sentence and marker disagree on the head': () => hit(`${oldText()}\n${marker(OTHER_HEAD)}`),
  'a second marker names another head': () => hit(`${marker()}\n${marker(OTHER_HEAD)}`),
  'marker without a head': () => hit('<!-- mivo-review:thread-fixed key=0123456789ab -->'),
  'short head': () => hit(marker('a'.repeat(12))),
  'reply key differs from the finding key': () => hit(marker(HEAD, 'ffffffffffff')),
  'older sentence key differs from the finding key': () => hit(oldText(HEAD, 'ffffffffffff')),
  'reply says nothing about being fixed': () => hit('看过了，没问题。'),
  'sentence is cut off': () => hit(`本轮在提交 ${HEAD} 完成复核:本轮复核未再发现该问题(key=${KEY})。`),
  'marker is not closed': () => hit(`<!-- mivo-review:thread-fixed key=${KEY} head=${HEAD}`),
  'a person writes the marker': () => isServerFixedThread(thread([first(), reply(marker(), { author: { login: 'someone', __typename: 'User' } })]), HEAD),
  'a person with the App name as a plain user': () => isServerFixedThread(thread([first(), reply(marker(), { author: { login: 'praisebuild', __typename: 'User' } })]), HEAD),
  'a person comments after the closing reply': () => isServerFixedThread(thread([first(), reply(marker()),
    { id: 'PRRC_h', author: { login: 'someone', __typename: 'User' }, body: '这里还有问题', createdAt: '2026-11-05T03:00:00Z' }]), HEAD),
  'the opening comment is not the reviewer': () => isServerFixedThread(thread([first({ author: { login: 'someone', __typename: 'User' } }), reply(marker())]), HEAD),
  'the opening comment carries no finding marker': () => isServerFixedThread(thread([first({ body: '[P1] 没有标记' }), reply(marker())]), HEAD),
  'the finding marker has a short key': () => isServerFixedThread(thread([first({ body: '<!-- mivo-finding key=0123 round=1 head=1111111 -->' }), reply(marker())]), HEAD),
  'only one comment': () => isServerFixedThread(thread([first({ body: `${findingBody()}\n${marker()}` })]), HEAD),
  'no comments': () => isServerFixedThread(thread([]), HEAD),
  'thread already resolved': () => isServerFixedThread(thread([first(), reply(marker())], { isResolved: true }), HEAD),
  'comment list is incomplete (flag)': () => isServerFixedThread(thread([first(), reply(marker())], { commentsHasNextPage: true }), HEAD),
  'comment list is incomplete (page info)': () => isServerFixedThread({ id: 'PRRT_1', isResolved: false,
    comments: { nodes: [first(), reply(marker())], pageInfo: { hasNextPage: true } } }, HEAD),
  'thread has no id': () => isServerFixedThread({ ...thread([first(), reply(marker())]), id: undefined }, HEAD),
  'current head is unknown': () => isServerFixedThread(thread([first(), reply(marker())]), undefined),
  'current head is short': () => isServerFixedThread(thread([first(), reply(marker())]), HEAD.slice(0, 12)),
};
for (const [name, run] of Object.entries(rejects)) test(`not fixed: ${name}`, () => assert.equal(run(), null));

test('comments given as GraphQL nodes are read like a plain list', () => {
  assert.ok(isServerFixedThread({ id: 'PRRT_1', isResolved: false, comments: { nodes: [first(), reply(marker())], pageInfo: { hasNextPage: false } } }, HEAD));
});

test('partition keeps the threads apart, once each, and leaves a thread this path already resolved on the same reply', () => {
  const a = thread([first(), reply(marker())], { id: 'PRRT_a' });
  const b = thread([first(), reply(marker())], { id: 'PRRT_b' });
  const noise = thread([first({ body: 'no marker' }), reply(marker())], { id: 'PRRT_noise' });
  const done = thread([first(), reply(marker())], { id: 'PRRT_done', isResolved: true });
  const out = partitionServerFixedThreads([a, a, noise, done, b], HEAD);
  assert.deepEqual(out.eligible.map((x) => x.threadId), ['PRRT_a', 'PRRT_b']);
  assert.deepEqual(out.skipped, []);
  const receipts = { autoClosedThreads: { PRRT_a: { reason: SERVER_FIXED_REASON, commentId: 'PRRC_reply' } } };
  const again = partitionServerFixedThreads([a, b], HEAD, receipts);
  assert.deepEqual(again.eligible.map((x) => x.threadId), ['PRRT_b']);
  assert.deepEqual(again.skipped.map((x) => x.threadId), ['PRRT_a']);
  // A different closing reply, or a receipt from another path, does not hold the thread back.
  const fresher = thread([first(), reply(marker(), { id: 'PRRC_newer' })], { id: 'PRRT_a' });
  assert.equal(partitionServerFixedThreads([fresher], HEAD, receipts).eligible.length, 1);
  assert.equal(partitionServerFixedThreads([a], HEAD, { autoClosedThreads: { PRRT_a: { reason: 'auto-close', commentId: 'PRRC_reply' } } }).eligible.length, 1);
});

function drive(generator) {
  let step = generator.next();
  while (!step.done) {
    let value;
    try { value = step.value(); } catch (error) { step = generator.throw(error); continue; }
    step = generator.next(value);
  }
  return step.value;
}
const hits = (...ids) => ids.map((id) => ({ threadId: id, key: KEY, head: HEAD, commentId: `${id}-reply` }));
const run = (answer, eligible = hits('PRRT_a', 'PRRT_b'), previous = { autoClosedThreads: { PRRT_old: { reason: 'auto-close' } } }) => {
  const calls = [];
  const out = drive(resolveServerFixedThreads({ eligible, previous, repo: 'example-org/example-plugin', now: 'NOW',
    appResolveFn: (args) => { calls.push(args); if (answer instanceof Error) throw answer; return answer; } }));
  return { out, calls };
};

test('one App call carries every hit thread; each resolved thread gets a receipt tied to its closing reply', () => {
  const { out, calls } = run({ resolved: ['PRRT_a', 'PRRT_b'], failures: [] });
  assert.deepEqual(calls, [{ threadIds: ['PRRT_a', 'PRRT_b'], repo: 'example-org/example-plugin' }]);
  assert.deepEqual(out.closed, [{ threadId: 'PRRT_a', key: KEY, reason: SERVER_FIXED_REASON }, { threadId: 'PRRT_b', key: KEY, reason: SERVER_FIXED_REASON }]);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.previous.autoClosedThreads.PRRT_a, { at: 'NOW', key: KEY, reason: SERVER_FIXED_REASON, head: HEAD, commentId: 'PRRT_a-reply' });
  assert.deepEqual(out.previous.autoClosedThreads.PRRT_old, { reason: 'auto-close' }, 'other receipts are kept');
});

test('a thread the App did not confirm gets no receipt and a failure with the phase, expectation and actual answer', () => {
  const { out } = run({ resolved: ['PRRT_a'], failures: [{ threadId: 'PRRT_b', phase: 'resolve', expected: 'http 200 with isResolved=true', actual: 'http 403' }] });
  assert.deepEqual(out.closed.map((x) => x.threadId), ['PRRT_a']);
  assert.deepEqual(out.failed, [{ threadId: 'PRRT_b', key: KEY, phase: 'resolve', expected: 'http 200 with isResolved=true', actual: 'http 403' }]);
  assert.equal(out.previous.autoClosedThreads.PRRT_b, undefined);
});

test('a failure with no thread (config, mint) applies to every unresolved thread; a revoke failure to none of them', () => {
  const { out } = run({ resolved: [], failures: [{ phase: 'revoke', expected: 'http 204', actual: 'http 500' }, { phase: 'mint', expected: 'http 201', actual: 'http 422' }] });
  assert.deepEqual(out.failed.map((x) => [x.threadId, x.phase, x.expected, x.actual]),
    [['PRRT_a', 'mint', 'http 201', 'http 422'], ['PRRT_b', 'mint', 'http 201', 'http 422']]);
  assert.deepEqual(out.revokeFailures, [{ phase: 'revoke', expected: 'http 204', actual: 'http 500' }]);
  assert.deepEqual(out.closed, []);
  const resolvedOnly = run({ resolved: ['PRRT_a', 'PRRT_b'], failures: [{ phase: 'revoke', expected: 'http 204', actual: 'http 500' }] }).out;
  assert.equal(resolvedOnly.closed.length, 2, 'a token that could not be revoked does not undo the resolves');
  assert.equal(resolvedOnly.revokeFailures.length, 1);
});

test('a thread the App left for lack of time is deferred: no receipt, no failure; canContinue reaches the App only when one is given', () => {
  const repo = 'example-org/example-plugin';
  const canContinue = () => true;
  const calls = [];
  const answer = { resolved: ['PRRT_a'], failures: [
    { threadId: 'PRRT_b', phase: 'budget', expected: 'time left in the round', actual: 'round budget spent' },
    { phase: 'revoke', expected: 'http 204', actual: 'http 500' }] };
  const out = drive(resolveServerFixedThreads({ eligible: hits('PRRT_a', 'PRRT_b'), previous: {}, repo, now: 'NOW', canContinue,
    appResolveFn: (args) => { calls.push(args); return answer; } }));
  assert.deepEqual(calls, [{ threadIds: ['PRRT_a', 'PRRT_b'], repo, canContinue }]);
  assert.deepEqual(out.closed.map((x) => x.threadId), ['PRRT_a']);
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.deferred, [{ threadId: 'PRRT_b', key: KEY }]);
  assert.equal(out.previous.autoClosedThreads.PRRT_b, undefined);
  assert.equal(out.revokeFailures.length, 1, 'a revoke failure is still reported');
  assert.deepEqual(run({ resolved: ['PRRT_a', 'PRRT_b'], failures: [] }).out.deferred, [], 'nothing is deferred when the App closed them all');
});

test('an App function that throws or answers nonsense resolves nothing', () => {
  const thrown = run(new TypeError('secret-looking detail')).out;
  assert.deepEqual(thrown.closed, []);
  assert.deepEqual(thrown.failed.map((x) => [x.phase, x.actual]), [['resolve', 'threw TypeError'], ['resolve', 'threw TypeError']]);
  assert.ok(!JSON.stringify(thrown).includes('secret-looking detail'), 'the error message is not copied');
  for (const answer of [undefined, null, 'ok', { resolved: 'PRRT_a' }, { resolved: ['PRRT_other'], failures: [] }]) {
    const { out } = run(answer);
    assert.deepEqual(out.closed, [], JSON.stringify(answer));
    assert.equal(out.failed.length, 2);
    assert.ok(out.failed.every((x) => x.expected && x.actual), 'every failure names what was expected and what happened');
  }
});

// The reply must be the review server's own words, not a comment that quotes or extends them: the older sentence
// stands alone (HTML comments aside), and the marker ends the reply.
test('the marker-ending reply of the newer server wording is a fixed thread', () => {
  const newer = `本轮在提交 \`${HEAD}\` 完成复核:本轮复核未再发现该问题(key=\`${KEY}\`)。已修复，由盯梢关闭；如仍有异议，可在此回复。审查运行:\`https://example.test/runs/1\`。\n\n${marker()}\n`;
  assert.equal(hit(newer)?.key, KEY);
});
const notTheServerWords = {
  'the older sentence quoted, then a word that it is still broken': () => hit(`> ${oldText()}\n\n这个还是没修好`),
  'the older sentence with words added after it': () => hit(`${oldText()}\n还是没修好`),
  'the older sentence with words before it': () => hit(`看下面：${oldText()}`),
  'the older sentence only as a quote': () => hit(`> ${oldText()}`),
  'words after the marker': () => hit(`${marker()}\n还是没修好`),
  'the older sentence and a marker that does not end the reply': () => hit(`${oldText()}\n${marker()}\n还是没修好`),
};
for (const [name, run] of Object.entries(notTheServerWords)) test(`not fixed: ${name}`, () => assert.equal(run(), null));
