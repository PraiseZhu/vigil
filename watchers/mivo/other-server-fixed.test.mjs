import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO, FULL_COLLECT_MS, otherPrScanDue, readServerFixedState, scanOnceAsync, watcherPaths } from './bin/mivo-watcher.mjs';
import { listPrs } from './bin/mivo-state.mjs';
import { resolveThreadsWithApp } from './bin/mivo-app-token.mjs';
import { handoffPr, withAuthorHandoff, isFollowBatch, followBatchBody } from './handoff.fixture.mjs';

// The review server's "fixed" threads on PRs the viewer did not write (switch resolveFixedThreadsWithApp): the watcher
// closes them as the review App's bot and does nothing else with those PRs. The viewer's own PR (#801 here) goes
// through the normal discover path. GitHub is a recording fake and the App key is generated per run.
const SWITCH = 'MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OLD_HEAD = 'c'.repeat(40);
const NOW = '2026-11-05T01:00:00.000Z';
const LATER = new Date(Date.parse(NOW) + FULL_COLLECT_MS + 60000).toISOString();
const SOON = new Date(Date.parse(NOW) + 60000).toISOString();
const KEY = '0123456789ab';
const TOKEN = 'fake-installation-token-for-test';
const KEY_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const APP_ENV = { MIVO_WATCHER_HOME: path.join(os.tmpdir(), 'other-server-fixed-no-such-home'), MIVO_WATCHER_PRAISEBUILD_APP_ID: '12345',
  MIVO_WATCHER_PRAISEBUILD_INSTALLATION_ID: '67890', MIVO_WATCHER_PRAISEBUILD_PRIVATE_KEY_PATH: '/virtual/app-key' };

const reviewer = { login: 'ExampleReviewer', __typename: 'User' };
const reviewerBot = { login: 'praisebuild', __typename: 'Bot' };
const person = { login: 'SomeoneElse', __typename: 'User' };
const greptile = { login: 'greptile-apps', __typename: 'Bot' };
const finding = (id, extra = {}) => ({ id, author: reviewer, createdAt: '2026-11-05T00:00:00Z',
  body: `[P1] 空值未处理\n\n<!-- mivo-finding key=${KEY} round=1 head=1111111 -->`, ...extra });
const fixedReply = (id, extra = {}) => ({ id, author: reviewerBot, createdAt: '2026-11-05T00:30:00Z',
  body: `<!-- mivo-review:thread-fixed key=${KEY} head=${HEAD} -->`, ...extra });
const threadOf = (id, comments, extra = {}) => ({ id, isResolved: false, comments, ...extra });
const fixedThread = (n = 1) => threadOf(`PRRT_${n}`, [finding(`PRRC_${n}a`), fixedReply(`PRRC_${n}b`)]);
const openThread = (n = 2) => threadOf(`PRRT_${n}`, [finding(`PRRC_${n}a`, { body: '[P1] 另一个问题\n\n<!-- mivo-finding key=ffffffffffff round=1 head=1111111 -->' })]);

const OWN = 801;
const ownListed = (number = OWN) => ({ number, id: `PR_${number}`, headRefOid: HEAD, headRefName: `fix/${number}`, title: 'fix', isDraft: false, labels: [],
  url: `https://example.invalid/pull/${number}`, updatedAt: '2026-10-15T00:00:00Z', author: { login: 'owner' } });
const otherPr = (number, extra = {}) => ({ number, id: `PR_${number}`, headRefOid: HEAD, isDraft: false, author: { login: 'ExampleUser' }, updatedAt: '2026-10-15T00:00:00Z', ...extra });

const queryOf = (args) => String(args.find((arg) => String(arg).startsWith('query=')) ?? '');
const isOtherList = (args) => queryOf(args).includes('nodes{id number isDraft');
const threadReadOf = (args) => /node\(id:"([^"]+)"\)\{\.\.\. on PullRequest\{state isDraft headRefOid author\{login\} reviewThreads/.exec(queryOf(args))?.[1] ?? null;
const sideCalls = (calls) => calls.filter((args) => isOtherList(args) || threadReadOf(args));
const threadReads = (calls) => calls.map(threadReadOf).filter(Boolean);
const isWrite = (args) => args.some((arg) => /^(?:-X|--method|--input)$/.test(String(arg)) || /mutation/.test(String(arg)))
  || (['pr', 'issue'].includes(args[0]) && ['comment', 'review', 'edit', 'close', 'merge', 'ready', 'create', 'reopen'].includes(args[1]));
const spy = (answer) => { const log = []; const fn = (args) => { log.push(args); return typeof answer === 'function' ? answer(args) : answer; }; return Object.assign(fn, { log }); };
const resolving = () => spy(({ threadIds }) => ({ resolved: threadIds, failures: [] }));

// The viewer's own PR needs a repair session (required CI failed), so a normal round has real work to do and shows what
// the other authors' path must not touch.
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

// A fake GitHub. `others` are the open PRs of other authors, `threads` their review threads by PR node id, `live`
// what a per-PR read answers when it differs from the listing (a PR that moved between the two reads).
function world(t, { others = [], threads = {}, live = {}, failList = false, onThreadRead = null, own = [ownListed()] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'other-server-fixed-'));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'other-server-fixed-plugin-'));
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(plugin, { recursive: true, force: true }); });
  const paths = watcherPaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const calls = [];
  const nodeOf = (pr) => ({ id: pr.id, number: pr.number, isDraft: pr.isDraft, headRefOid: pr.headRefOid, updatedAt: pr.updatedAt, author: pr.author });
  const ghFn = (args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(own.map(({ author, ...rest }) => rest));
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: `PR_${args[2]}`, state: 'OPEN' });
    if (args[0] === 'api' && args[1] === 'graphql') {
      if (isOtherList(args)) {
        if (failList) throw new Error('GraphQL: API rate limit exceeded');
        return followBatchBody([...own, ...others].map(nodeOf));
      }
      const id = threadReadOf(args);
      if (id) {
        const pr = [...own, ...others].find((item) => item.id === id);
        onThreadRead?.(id);
        const spec = { state: 'OPEN', isDraft: pr?.isDraft ?? false, headRefOid: pr?.headRefOid ?? HEAD, author: pr?.author, ...live[id] };
        return JSON.stringify({ data: { node: { ...spec, reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null },
          nodes: (threads[id] ?? []).map(({ moreComments, comments, ...thread }) => ({ ...thread,
            comments: { pageInfo: { hasNextPage: moreComments === true, endCursor: null }, nodes: comments } })) } } } });
      }
      if (isFollowBatch(args)) return followBatchBody(own.map(nodeOf));
    }
    return args[0] === 'api' && args[1] === 'user' ? 'owner' : '[]';
  };
  return { dir, paths, calls, ghFn, plugin };
}

// One discover round. The switch is set for the run only (null: not set at all). `calls` are the viewer account's gh calls of this round.
async function round(w, { now = NOW, switchValue = '1', appResolveFn = resolving(), enabled = true, withDispatch = true, ...extra } = {}) {
  const previousSwitch = process.env[SWITCH];
  if (switchValue === null) delete process.env[SWITCH]; else process.env[SWITCH] = switchValue;
  const from = w.calls.length;
  const sent = [];
  const collected = [];
  const owned = [];
  try {
    const out = await scanOnceAsync({
      mode: 'discover', enabled, allowDispatch: true, paths: w.paths, now, gitFn: () => '', env: { MIVO_PLUGIN_REPO: w.plugin },
      ghFn: w.ghFn,
      collect: (pr) => { collected.push(pr.number); return failing(pr); },
      dispatchFn: withDispatch ? (params) => { sent.push(params); return { target_session_id: `sess-${params.title.match(/#(\d+)/)[1]}` }; } : null,
      ownershipSnapshot: function* (args) { owned.push(args.pr.number); return yield* ownership(args); },
      appResolveFn,
      ...extra,
    });
    return { out, events: out.events, sent, collected, owned, calls: w.calls.slice(from), asked: appResolveFn };
  } finally {
    if (previousSwitch === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = previousSwitch;
  }
}
const otherEvents = (run) => run.events.filter((event) => event.scope === 'other-pr');
const prFiles = (w) => listPrs(w.paths.home).map((entry) => entry.nodeId).sort();

// A fake GitHub for the real App module: mint, resolve and revoke, each answerable.
function github(plan = {}) {
  const calls = [];
  const reply = (status, body) => ({ status, json: async () => body });
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization });
    if (url.endsWith('/access_tokens')) return plan.mint?.() ?? reply(201, { token: TOKEN });
    if (url.endsWith('/graphql')) {
      const tid = JSON.parse(init.body).variables.tid;
      return plan.resolve?.(tid) ?? reply(200, { data: { resolveReviewThread: { thread: { id: tid, isResolved: true } } } });
    }
    return plan.revoke?.() ?? { status: 204 };
  };
  const appResolveFn = (args) => resolveThreadsWithApp({ ...args, env: APP_ENV, fetchImpl, readFile: () => KEY_PEM });
  return { calls, appResolveFn };
}

// SC1: closing
test('switch on: another author\'s open PR gets its server-fixed thread resolved by the App, with a receipt, and the same reply is not resolved twice', async (t) => {
  const w = world(t, { others: [otherPr(900)], threads: { PR_900: [fixedThread(1), openThread(2)] } });
  const first = await round(w);
  assert.deepEqual(first.asked.log, [{ threadIds: ['PRRT_1'], repo: REPO }], 'one App call, for the recognized thread only');
  assert.deepEqual(readServerFixedState(w.paths).prs.PR_900, { number: 900, lastScannedAt: NOW, lastFailures: {},
    autoClosedThreads: { PRRT_1: { at: NOW, key: KEY, reason: 'server-review-fixed', head: HEAD, commentId: 'PRRC_1b' } } });
  assert.deepEqual(otherEvents(first), [{ kind: 'server-fixed-thread-resolved', scope: 'other-pr', number: 900, threadId: 'PRRT_1', key: KEY }]);
  assert.deepEqual(first.out.otherPrs, { scanned: 1, closed: 1, deferred: 0 });
  // Inside fullCollectMs the PR is not looked at again.
  const soon = await round(w, { now: SOON, appResolveFn: first.asked });
  assert.deepEqual(threadReads(soon.calls), []);
  assert.equal(first.asked.log.length, 1);
  // After it, the thread is read again; the closing reply it carries already has a receipt, so the App is not asked.
  const later = await round(w, { now: LATER, appResolveFn: first.asked });
  assert.deepEqual(threadReads(later.calls), ['PR_900']);
  assert.equal(first.asked.log.length, 1, 'the same closing reply is not resolved twice');
  assert.equal(readServerFixedState(w.paths).prs.PR_900.lastScannedAt, LATER);
  // A newer closing reply from the review server is new and is resolved again (a person had unresolved the thread).
  const renewed = { PR_900: [threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b'), fixedReply('PRRC_1c', { createdAt: '2026-11-05T00:45:00Z' })])] };
  const w2 = world(t, { others: [otherPr(900)], threads: renewed });
  fs.writeFileSync(path.join(w2.paths.stateDir, 'server-fixed.json'), JSON.stringify({ version: 1, repo: REPO, prs: { PR_900: { number: 900, lastScannedAt: NOW,
    autoClosedThreads: { PRRT_1: { at: NOW, key: KEY, reason: 'server-review-fixed', head: HEAD, commentId: 'PRRC_1b' } } } } }));
  const again = await round(w2, { now: LATER });
  assert.equal(again.asked.log.length, 1);
  assert.equal(readServerFixedState(w2.paths).prs.PR_900.autoClosedThreads.PRRT_1.commentId, 'PRRC_1c');
});

test('switch on: each other PR gets its own App call, oldest scan first, never-scanned PRs before all', async (t) => {
  const w = world(t, { others: [otherPr(31), otherPr(30), otherPr(32), otherPr(33)],
    threads: { PR_30: [fixedThread(1)], PR_31: [fixedThread(2)], PR_32: [fixedThread(3)], PR_33: [fixedThread(4)] } });
  const minutes = (n) => new Date(Date.parse(NOW) - n * 60000).toISOString();
  fs.writeFileSync(path.join(w.paths.stateDir, 'server-fixed.json'), JSON.stringify({ version: 1, repo: REPO, prs: {
    PR_30: { number: 30, lastScannedAt: minutes(30) }, PR_31: { number: 31, lastScannedAt: minutes(20) }, PR_33: { number: 33, lastScannedAt: minutes(5) } } }));
  const run = await round(w);
  assert.deepEqual(threadReads(run.calls), ['PR_32', 'PR_30', 'PR_31'], 'never scanned first, then the oldest; #33 was looked at 5 minutes ago');
  assert.deepEqual(run.asked.log.map((call) => call.threadIds), [['PRRT_3'], ['PRRT_1'], ['PRRT_2']]);
});

// SC2: the viewer does not take over other authors' PRs
test('another author\'s PR is never dispatched, collected, owned, saved as a PR, or written to, even with more feedback on it', async (t) => {
  const mixed = [fixedThread(1), openThread(2), threadOf('PRRT_3', [{ id: 'PRRC_3a', author: person, createdAt: '2026-11-05T00:00:00Z', body: '这里需要改' }]),
    threadOf('PRRT_4', [{ id: 'PRRC_4a', author: greptile, createdAt: '2026-11-05T00:00:00Z', body: 'P1: possible null dereference' }])];
  const w = world(t, { others: [otherPr(900)], threads: { PR_900: mixed } });
  const run = await round(w);
  assert.deepEqual(run.asked.log, [{ threadIds: ['PRRT_1'], repo: REPO }]);
  assert.deepEqual(run.sent.map((params) => params.title.match(/#(\d+)/)[1]), [`${OWN}`], 'only the viewer\'s own PR reached a session');
  assert.deepEqual(run.collected, [OWN]);
  assert.deepEqual(run.owned, [OWN]);
  assert.deepEqual(prFiles(w), ['PR_801'], 'no state/prs/ entry for the other PR');
  assert.deepEqual(run.calls.filter(isWrite), [], 'this account made no write call');
  assert.ok(sideCalls(run.calls).every((args) => args.length === 4 && args[0] === 'api' && args[1] === 'graphql' && args[2] === '-f' && queryOf(args).startsWith('query=query{')),
    'the other-PR calls are plain GraphQL queries');
  assert.ok(!JSON.stringify(run.sent).includes('PR_900') && !JSON.stringify(run.sent).includes('PRRT_'), 'nothing of the other PR in any delivery');
  const files = fs.readdirSync(w.paths.stateDir, { recursive: true }).filter((name) => name.endsWith('.json'));
  const mentioning = files.filter((name) => fs.readFileSync(path.join(w.paths.stateDir, name), 'utf8').includes('PR_900'));
  assert.deepEqual(mentioning, ['server-fixed.json'], 'the other PR appears in no task, result or per-PR file, only in its own record');
});

test('a dispatch function that throws is never reached by another author\'s PR', async (t) => {
  const w = world(t, { own: [], others: [otherPr(900)], threads: { PR_900: [fixedThread(1), openThread(2)] } });
  const run = await round(w, { dispatchFn: () => assert.fail('another author\'s PR must not be dispatched') });
  assert.equal(run.asked.log.length, 1);
  assert.deepEqual(run.out.prs, []);
  assert.deepEqual(prFiles(w), []);
});

test('the viewer\'s own PR is not part of the other authors\' path, whatever the case of its login', async (t) => {
  const w = world(t, { others: [otherPr(900, { author: { login: 'OWNER' } }), otherPr(901, { author: { login: 'Owner' } }), otherPr(902, { author: null }), otherPr(903, { author: { login: '' } })],
    threads: { PR_900: [fixedThread(1)], PR_901: [fixedThread(2)], PR_902: [fixedThread(3)], PR_903: [fixedThread(4)], PR_801: [fixedThread(5)] } });
  const run = await round(w);
  assert.deepEqual(threadReads(run.calls), []);
  assert.equal(run.asked.log.length, 0);
  assert.deepEqual(run.out.otherPrs, { scanned: 0, closed: 0, deferred: 0 });
});

test('a Draft PR of another author is not read', async (t) => {
  const w = world(t, { others: [otherPr(900, { isDraft: true }), otherPr(901)], threads: { PR_900: [fixedThread(1)], PR_901: [fixedThread(2)] } });
  const run = await round(w);
  assert.deepEqual(threadReads(run.calls), ['PR_901']);
  assert.deepEqual(run.asked.log, [{ threadIds: ['PRRT_2'], repo: REPO }]);
});

// SC3: threads that do not qualify are never closed
const notClosed = {
  'opened by a person, closed with the server\'s marker': threadOf('PRRT_1', [finding('PRRC_1a', { author: person }), fixedReply('PRRC_1b')]),
  'opened by Greptile': threadOf('PRRT_1', [finding('PRRC_1a', { author: greptile }), fixedReply('PRRC_1b')]),
  'the closing reply is a person quoting the marker': threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b', { author: person })]),
  'the closing reply names an older head': threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b', { body: `<!-- mivo-review:thread-fixed key=${KEY} head=${OLD_HEAD} -->` })]),
  'someone commented after the closing reply': threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b'), { id: 'PRRC_1c', author: person, body: '还是有问题', createdAt: '2026-11-05T00:50:00Z' }]),
  'the server itself spoke again after the closing reply, without the marker': threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b'), { id: 'PRRC_1c', author: reviewerBot, body: '补充一点', createdAt: '2026-11-05T00:50:00Z' }]),
  'the first comment has no finding marker': threadOf('PRRT_1', [finding('PRRC_1a', { body: '[P1] 没有标记' }), fixedReply('PRRC_1b')]),
  'the closing reply is for another finding': threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b', { body: `<!-- mivo-review:thread-fixed key=ffffffffffff head=${HEAD} -->` })]),
  'already resolved': threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b')], { isResolved: true }),
  'more comments than one page': threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b')], { moreComments: true }),
  'only the finding, no reply': threadOf('PRRT_1', [finding('PRRC_1a')]),
};
for (const [name, thread] of Object.entries(notClosed)) {
  test(`switch on, thread ${name}: the App is not asked and nothing is recorded as closed`, async (t) => {
    const w = world(t, { others: [otherPr(900)], threads: { PR_900: [thread] } });
    const run = await round(w);
    assert.equal(run.asked.log.length, 0);
    assert.deepEqual(threadReads(run.calls), ['PR_900'], 'the PR was looked at');
    assert.deepEqual(readServerFixedState(w.paths).prs.PR_900.autoClosedThreads ?? {}, {});
    assert.deepEqual(otherEvents(run), []);
  });
}

test('switch on: a PR that closed, went Draft, changed hands or moved its head between the listing and its read is left alone and not stamped', async (t) => {
  const changes = {
    'went Draft': { isDraft: true },
    'closed': { state: 'CLOSED' },
    'changed hands to the viewer': { author: { login: 'owner' } },
    'moved its head': { headRefOid: OLD_HEAD },
  };
  for (const [name, change] of Object.entries(changes)) {
    const w = world(t, { others: [otherPr(900)], threads: { PR_900: [fixedThread(1)] }, live: { PR_900: change } });
    const run = await round(w);
    assert.equal(run.asked.log.length, 0, name);
    assert.equal(readServerFixedState(w.paths).prs.PR_900, undefined, `${name}: not stamped, so it is looked at again next round`);
  }
});

// SC4: App failures
const failurePlans = {
  'the token is refused (422)': { plan: { mint: () => ({ status: 422, json: async () => ({ message: `Validation Failed ${TOKEN}` }) }) },
    event: { phase: 'mint', expected: 'http 201', actual: 'http 422' } },
  'the resolve is refused (403)': { plan: { resolve: () => ({ status: 403, json: async () => ({ message: TOKEN }) }) },
    event: { phase: 'resolve', expected: 'http 200 with isResolved=true', actual: 'http 403' } },
  'GitHub answers the resolve with an error': { plan: { resolve: () => ({ status: 200, json: async () => ({ errors: [{ type: 'FORBIDDEN', message: TOKEN }] }) }) },
    event: { phase: 'resolve', expected: 'http 200 with isResolved=true', actual: 'http 200 graphql error FORBIDDEN' } },
};
for (const [name, { plan, event }] of Object.entries(failurePlans)) {
  test(`switch on, ${name}: the thread stays open, an event has expected and actual, no gh fallback, no token anywhere`, async (t) => {
    const w = world(t, { others: [otherPr(900)], threads: { PR_900: [fixedThread(1)] } });
    const net = github(plan);
    const run = await round(w, { appResolveFn: net.appResolveFn });
    assert.deepEqual(otherEvents(run), [{ kind: 'server-fixed-thread-resolve-failed', scope: 'other-pr', number: 900, threadId: 'PRRT_1', ...event }]);
    const record = readServerFixedState(w.paths).prs.PR_900;
    assert.deepEqual(record.autoClosedThreads, {}, 'no receipt for a thread that was not resolved');
    assert.deepEqual(record.lastFailures, { PRRT_1: { at: NOW, ...event } }, 'only the cleaned fields are kept');
    assert.deepEqual(run.calls.filter(isWrite), [], 'never falls back to this account');
    assert.deepEqual(prFiles(w), ['PR_801']);
    const everything = JSON.stringify({ out: run.out, files: fs.readdirSync(w.paths.stateDir, { recursive: true }).filter((name) => name.endsWith('.json'))
      .map((name) => fs.readFileSync(path.join(w.paths.stateDir, name), 'utf8')) });
    assert.ok(!everything.includes(TOKEN), 'the token is nowhere in the output or the state');
    assert.ok(!everything.includes(net.calls[0].auth.replace('Bearer ', '')), 'nor is the App JWT');
    assert.ok(!everything.includes('/virtual/app-key'), 'nor the key path');
    // The next look, after fullCollectMs, asks again; once GitHub answers the thread is closed and the failure is gone.
    const healthy = github();
    const retry = await round(w, { now: LATER, appResolveFn: healthy.appResolveFn });
    assert.deepEqual(otherEvents(retry).map((item) => item.kind), ['server-fixed-thread-resolved']);
    const after = readServerFixedState(w.paths).prs.PR_900;
    assert.equal(after.autoClosedThreads.PRRT_1.commentId, 'PRRC_1b');
    assert.deepEqual(after.lastFailures, {});
  });
}

test('switch on, App settings missing: a config failure with expected and actual, nothing resolved', async (t) => {
  const w = world(t, { others: [otherPr(900)], threads: { PR_900: [fixedThread(1)] } });
  const empty = (args) => resolveThreadsWithApp({ ...args, env: { MIVO_WATCHER_HOME: APP_ENV.MIVO_WATCHER_HOME }, fetchImpl: () => { throw new Error('no request expected'); } });
  const run = await round(w, { appResolveFn: empty });
  assert.deepEqual(otherEvents(run), [{ kind: 'server-fixed-thread-resolve-failed', scope: 'other-pr', number: 900, threadId: 'PRRT_1', phase: 'config', expected: 'praisebuildAppId set', actual: 'missing' }]);
  assert.deepEqual(run.calls.filter(isWrite), []);
});

test('switch on, App function throws: the thread stays open and the round goes on', async (t) => {
  const w = world(t, { others: [otherPr(900), otherPr(901)], threads: { PR_900: [fixedThread(1)], PR_901: [fixedThread(2)] } });
  const run = await round(w, { appResolveFn: () => { throw new RangeError('boom'); } });
  assert.deepEqual(otherEvents(run).map((event) => [event.number, event.phase, event.actual]), [[900, 'resolve', 'threw RangeError'], [901, 'resolve', 'threw RangeError']]);
  assert.deepEqual(run.sent.map((params) => params.title.match(/#(\d+)/)[1]), [`${OWN}`], 'the viewer\'s own PR is delivered as usual');
});

test('a revoke that fails is reported on its own and the resolved thread stays resolved', async (t) => {
  const w = world(t, { others: [otherPr(900)], threads: { PR_900: [fixedThread(1)] } });
  const net = github({ revoke: () => ({ status: 500 }) });
  const run = await round(w, { appResolveFn: net.appResolveFn });
  assert.deepEqual(otherEvents(run).map((event) => event.kind), ['server-fixed-thread-resolved', 'server-fixed-thread-token-revoke-failed']);
  assert.deepEqual(otherEvents(run)[1], { kind: 'server-fixed-thread-token-revoke-failed', scope: 'other-pr', number: 900, phase: 'revoke', expected: 'http 204', actual: 'http 500' });
  assert.equal(readServerFixedState(w.paths).prs.PR_900.autoClosedThreads.PRRT_1.reason, 'server-review-fixed');
});

test('a failed list or thread read is an event, and the viewer\'s own PRs are delivered as before', async (t) => {
  const w = world(t, { others: [otherPr(900)], threads: { PR_900: [fixedThread(1)] }, failList: true });
  const run = await round(w);
  assert.deepEqual(otherEvents(run), [{ kind: 'other-server-fixed-scan-failed', scope: 'other-pr', stage: 'list', reason: 'GraphQL: API rate limit exceeded' }]);
  assert.deepEqual(run.sent.map((params) => params.title.match(/#(\d+)/)[1]), [`${OWN}`]);
  assert.equal(run.asked.log.length, 0);
  const broken = world(t, { others: [otherPr(900), otherPr(901)], threads: { PR_901: [fixedThread(2)] },
    onThreadRead: (id) => { if (id === 'PR_900') throw new Error('gh: HTTP 502'); } });
  const second = await round(broken);
  assert.deepEqual(otherEvents(second).filter((event) => event.kind === 'other-server-fixed-scan-failed'),
    [{ kind: 'other-server-fixed-scan-failed', scope: 'other-pr', stage: 'scan', number: 900, reason: 'gh: HTTP 502' }]);
  assert.deepEqual(second.asked.log, [{ threadIds: ['PRRT_2'], repo: REPO }], 'one PR failing does not stop the next');
  assert.equal(readServerFixedState(broken.paths).prs.PR_900, undefined, 'a failed read is not stamped');
});

// time budget
test('a PR the round has no time for is not scanned or stamped, and is the first one next round', async (t) => {
  let now = 1_000_000;
  const w = world(t, { others: [otherPr(10), otherPr(11)], threads: { PR_10: [openThread(1)], PR_11: [fixedThread(2)] },
    onThreadRead: (id) => { if (id === 'PR_10') now += 130000; } });
  const run = await round(w, { clock: () => now, budgetMs: 120000, dispatchReserveMs: 20000 });
  assert.deepEqual(threadReads(run.calls), ['PR_10']);
  assert.equal(run.asked.log.length, 0);
  assert.deepEqual(otherEvents(run), [{ kind: 'other-server-fixed-scan-deferred', scope: 'other-pr', reason: 'budget', remaining: 1 }]);
  assert.deepEqual(run.out.otherPrs, { scanned: 1, closed: 0, deferred: 1 });
  assert.deepEqual(Object.keys(readServerFixedState(w.paths).prs), ['PR_10']);
  const next = await round(w, { now: SOON, clock: () => now + 500000, budgetMs: 120000, dispatchReserveMs: 20000 });
  assert.deepEqual(threadReads(next.calls), ['PR_11'], '#10 was scanned a minute ago; #11 never');
  assert.deepEqual(next.asked.log, [{ threadIds: ['PRRT_2'], repo: REPO }]);
});

test('a round with no time left before the other PRs start reads nothing of them', async (t) => {
  let now = 1_000_000;
  const w = world(t, { others: [otherPr(10)], threads: { PR_10: [fixedThread(1)] } });
  const run = await round(w, { clock: () => now, budgetMs: 120000, dispatchReserveMs: 20000,
    collect: (pr) => { now += 130000; return failing(pr); } });
  assert.deepEqual(sideCalls(run.calls), []);
  assert.deepEqual(otherEvents(run), [{ kind: 'other-server-fixed-scan-deferred', scope: 'other-pr', reason: 'budget' }]);
});

// state
test('a PR that is no longer open takes its record with it; a broken file starts empty', async (t) => {
  const w = world(t, { others: [otherPr(900)], threads: { PR_900: [] } });
  fs.writeFileSync(path.join(w.paths.stateDir, 'server-fixed.json'), JSON.stringify({ version: 1, repo: REPO, prs: {
    PR_900: { number: 900, lastScannedAt: NOW }, PR_77: { number: 77, lastScannedAt: NOW, autoClosedThreads: { PRRT_9: { commentId: 'x' } } } } }));
  await round(w, { now: SOON });
  assert.deepEqual(Object.keys(readServerFixedState(w.paths).prs), ['PR_900']);
  fs.writeFileSync(path.join(w.paths.stateDir, 'server-fixed.json'), '{not json');
  assert.deepEqual(readServerFixedState(w.paths), { version: 1, repo: REPO, prs: {} });
  fs.writeFileSync(path.join(w.paths.stateDir, 'server-fixed.json'), JSON.stringify({ version: 1, repo: 'other-org/other-repo', prs: { PR_900: { number: 900 } } }));
  assert.deepEqual(readServerFixedState(w.paths), { version: 1, repo: REPO, prs: {} }, 'a record of another repository is not trusted');
  const run = await round(w);
  assert.deepEqual(threadReads(run.calls), ['PR_900'], 'a PR without a record is due');
});

test('otherPrScanDue: never scanned is due; otherwise after fullCollectMs and not before', () => {
  assert.equal(otherPrScanDue(undefined, NOW, 600000), true);
  assert.equal(otherPrScanDue({}, NOW, 600000), true);
  assert.equal(otherPrScanDue({ lastScannedAt: 'not a time' }, NOW, 600000), true);
  assert.equal(otherPrScanDue({ lastScannedAt: '2026-11-05T00:50:01.000Z' }, NOW, 600000), false);
  assert.equal(otherPrScanDue({ lastScannedAt: '2026-11-05T00:50:00.000Z' }, NOW, 600000), true);
});

// SC5: switch off, and dry run
const normalize = (run, w) => JSON.parse(JSON.stringify({ prs: run.out.prs, events: run.events, sent: run.sent, calls: run.calls,
  state: listPrs(w.paths.home), keys: Object.keys(run.out).sort(), mergeStates: run.out.mergeStates }).replaceAll(w.dir, '<home>').replaceAll(w.plugin, '<plugin>'));
const withOthers = () => ({ others: [otherPr(900), otherPr(901, { isDraft: true })], threads: { PR_900: [fixedThread(1), openThread(2)] } });

for (const switchValue of [null, '0', 'false', '']) {
  test(`switch off (${JSON.stringify(switchValue)}): other authors' PRs cost nothing — the viewer's round, state and gh calls are the same as on a repository without them`, async (t) => {
    const alone = world(t);
    const baseline = await round(alone, { switchValue });
    const crowded = world(t, withOthers());
    const run = await round(crowded, { switchValue });
    assert.deepEqual(normalize(run, crowded), normalize(baseline, alone));
    assert.equal(baseline.sent.length, 1, 'the viewer\'s own PR has real work, so this compares something');
    assert.deepEqual(sideCalls(run.calls), [], 'no read of the other PRs');
    assert.equal(run.asked.log.length, 0);
    assert.equal(run.out.otherPrs, undefined);
    assert.equal(fs.existsSync(path.join(crowded.paths.stateDir, 'server-fixed.json')), false, 'no state file is created');
  });
}

test('switch off, follow mode: the follow beats read exactly what they read before, and nothing of the other PRs', async (t) => {
  const follow = async (w) => {
    let now = 1_000_000;
    return round(w, { switchValue: null, clock: () => now, sleepFn: async (ms) => { now += ms; }, followMs: 1000, followUntilMs: 2500 });
  };
  const alone = world(t);
  const baseline = await follow(alone);
  const crowded = world(t, withOthers());
  const run = await follow(crowded);
  assert.deepEqual(normalize(run, crowded), normalize(baseline, alone));
  const batches = run.calls.filter(isFollowBatch);
  assert.ok(batches.length >= 3, 'the baseline read and at least two beats');
  assert.ok(batches.every((args) => queryOf(args).includes('nodes{id isDraft headRefOid updatedAt author{login} labels(first:30){nodes{name}} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}')),
    'every beat is the follow query as it was');
  assert.deepEqual(sideCalls(run.calls), []);
});

test('switch on but a dry run (not enabled, or no dispatch function): the other PRs are not read, asked or written', async (t) => {
  for (const mode of [{ enabled: false }, { withDispatch: false }]) {
    const w = world(t, withOthers());
    const run = await round(w, mode);
    assert.deepEqual(sideCalls(run.calls), [], JSON.stringify(mode));
    assert.equal(run.asked.log.length, 0);
    assert.equal(fs.existsSync(path.join(w.paths.stateDir, 'server-fixed.json')), false);
  }
});

test('switch on: the viewer\'s own round is unchanged by the other authors\' path', async (t) => {
  const off = world(t, withOthers());
  const baseline = await round(off, { switchValue: null });
  const on = world(t, withOthers());
  const run = await round(on);
  const own = (value, w) => ({ ...JSON.parse(JSON.stringify({ prs: value.out.prs, sent: value.sent, state: listPrs(w.paths.home) }).replaceAll(w.dir, '<home>').replaceAll(w.plugin, '<plugin>')) });
  assert.deepEqual(own(run, on), own(baseline, off));
  assert.deepEqual(run.calls.filter((args) => !sideCalls([args]).length), baseline.calls);
});
