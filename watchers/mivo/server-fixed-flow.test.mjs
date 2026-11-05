import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffPr, handoffReceipt, withAuthorHandoff, isChildPrList } from './handoff.fixture.mjs';
import * as watcher from './bin/mivo-watcher.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';
import { resolveThreadsWithApp } from './bin/mivo-app-token.mjs';

// A review thread the review server already re-checked and found fixed is resolved as the review App's bot and never
// reaches a repair session, when the switch is on. Failures keep it open without touching this account's gh.
// Everything runs through the real poll/processPr; GitHub is a recording fake and the key is generated per run.
const { scanOnceAsync, watcherPaths, feedbackItems, newFeedback } = watcher;
const REPO = process.env.MIVO_WATCHER_TARGET_REPO;
const SWITCH = 'MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP';
const NODE = 'PR_900';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const NOW = '2026-11-05T01:00:00.000Z';
const KEY = '0123456789ab';
const TOKEN = 'fake-installation-token-for-test';
const KEY_PEM = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const APP_ENV = { MIVO_WATCHER_HOME: path.join(os.tmpdir(), 'server-fixed-flow-no-such-home'), MIVO_WATCHER_PRAISEBUILD_APP_ID: '12345',
  MIVO_WATCHER_PRAISEBUILD_INSTALLATION_ID: '67890', MIVO_WATCHER_PRAISEBUILD_PRIVATE_KEY_PATH: '/virtual/app-key' };

const reviewer = { login: 'ExampleReviewer', __typename: 'User' };
const person = { login: 'SomeoneElse', __typename: 'User' };
const finding = (id, key = KEY) => ({ id, author: reviewer, createdAt: '2026-11-05T00:00:00Z',
  body: `[P1] 空值未处理\n\n<!-- mivo-finding key=${key} round=1 head=1111111 -->` });
const fixedReply = (id, extra = {}) => ({ id, author: { login: 'praisebuild', __typename: 'Bot' }, createdAt: '2026-11-05T00:30:00Z',
  body: `<!-- mivo-review:thread-fixed key=${KEY} head=${HEAD} -->`, ...extra });
const threadOf = (id, comments) => ({ id, isResolved: false, isOutdated: false, path: 'src/a.mjs', comments });
const fixedThread = (n = 1) => threadOf(`PRRT_${n}`, [finding(`PRRC_${n}a`), fixedReply(`PRRC_${n}b`)]);
const openThread = (n = 2) => threadOf(`PRRT_${n}`, [finding(`PRRC_${n}a`, 'ffffffffffff')]);

const listed = () => handoffPr({ repo: REPO, id: NODE, number: 900, headRefOid: HEAD, baseRefOid: BASE, state: 'OPEN', isDraft: false,
  author: { login: 'owner' }, releaseEpoch: 'e', headRefName: 'fix/y' });
const snapshot = (threads) => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: NOW, mergeable: 'MERGEABLE',
  labels: [], checkState: 'SUCCESS', commentCount: 0, reviewCount: 0, commentUpdatedAt: null, reviewUpdatedAt: null,
  unresolvedThreads: threads.filter((thread) => !thread.isResolved).length });

// One PR home that keeps its state between polls, so a second poll sees what the first one left behind.
function world(t, { entry = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-fixed-flow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = watcherPaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const pr = listed();
  writePr(paths.home, NODE, { number: 900, nodeId: NODE, sessionId: 'sess-900', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: pr.releaseEpoch, handoff: handoffReceipt(pr), headRefName: 'fix/y', title: 'fix', repairRounds: 0, ...entry });
  const state = () => readPr(paths.home, NODE);
  async function poll({ threads, switchValue, appResolveFn } = {}) {
    writePr(paths.home, NODE, { ...state(), pollFingerprint: 'stale' });
    const previousSwitch = process.env[SWITCH];
    if (switchValue === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = switchValue;
    const sent = [];
    const calls = [];
    try {
      const out = await scanOnceAsync({
        mode: 'poll', enabled: true, allowDispatch: true, paths, now: NOW, nodeId: NODE, prNumber: 900,
        snapshotFn: () => snapshot(threads),
        ghFn: (args) => { calls.push(args); return isChildPrList(args) ? '[[]]' : args[0] === 'api' ? 'owner' : '[]'; },
        collect: (...args) => withAuthorHandoff({ pr, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, comments: [], reviews: [],
          threads, labels: [], mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: true, mergeReady: false,
          policy: { status: 'verified', required: [] } }, args[0]),
        dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-900' }; },
        ownershipSnapshot: function* () { return { pr }; },
        ...(appResolveFn ? { appResolveFn } : {}),
      });
      return { out, report: out.prs[0], events: out.events ?? [], sent, calls, entry: state() };
    } finally {
      if (previousSwitch === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = previousSwitch;
    }
  }
  return { poll, state, paths, dir };
}
const resolvesThrough = (calls) => calls.filter((args) => args.some((arg) => /resolveReviewThread|addPullRequestReviewThreadReply/.test(String(arg))));
const spy = (answer) => { const log = []; const fn = (args) => { log.push(args); return typeof answer === 'function' ? answer(args) : answer; }; return Object.assign(fn, { log }); };
const sentKeys = (sent) => [...new Set(sent.flatMap((params) => [...params.message.matchAll(/"key":"([^"]+)"/g)].map((match) => match[1])))];

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

// SC5: switch off
const normalize = (run, dir) => JSON.parse(JSON.stringify({ report: run.report, events: run.events, sent: run.sent, calls: run.calls, entry: run.entry }).replaceAll(dir, '<home>'));

test('switch off (unset, 0, false, empty): the thread is dispatched exactly as without the feature, and the App is never asked', async (t) => {
  const threads = [fixedThread(1), openThread(2)];
  const plain = world(t);
  const baseline = await plain.poll({ threads });
  assert.equal(baseline.sent.length, 1);
  assert.deepEqual(sentKeys(baseline.sent).sort(), ['thread:PRRT_1:PRRC_1a', 'thread:PRRT_1:PRRC_1b', 'thread:PRRT_2:PRRC_2a'], 'the fixed thread goes to a session like any other');
  assert.equal(baseline.events.filter((event) => /server-fixed/.test(event.kind)).length, 0);
  assert.equal(baseline.report.autoClosed, undefined);
  for (const switchValue of [undefined, '0', 'false', '']) {
    const other = world(t);
    const asked = spy({ resolved: ['PRRT_1'], failures: [] });
    const run = await other.poll({ threads, switchValue, appResolveFn: asked });
    assert.equal(asked.log.length, 0, `switch ${JSON.stringify(switchValue)} must not reach the App`);
    assert.deepEqual(normalize(run, other.dir), normalize(baseline, plain.dir), `switch ${JSON.stringify(switchValue)}: dispatch, report, state and gh calls are identical`);
  }
});

test('switch on, nothing recognized: no App call and the same dispatch as with the switch off', async (t) => {
  const threads = [openThread(2), threadOf('PRRT_3', [finding('PRRC_3a'), fixedReply('PRRC_3b'), { id: 'PRRC_3c', author: person, body: '这里还有问题', createdAt: '2026-11-05T01:00:00Z' }])];
  const off = world(t);
  const baseline = await off.poll({ threads });
  const on = world(t);
  const asked = spy({ resolved: [], failures: [] });
  const run = await on.poll({ threads, switchValue: '1', appResolveFn: asked });
  assert.equal(asked.log.length, 0);
  assert.deepEqual(sentKeys(run.sent), sentKeys(baseline.sent));
  assert.ok(sentKeys(run.sent).includes('thread:PRRT_3:PRRC_3c'), 'a person speaking after the closing reply keeps the thread with the repair path');
});

test('switch on: a recognized thread is resolved by the App in one call, never dispatched, and gets a receipt', async (t) => {
  const w = world(t);
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  const run = await w.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: asked });
  assert.deepEqual(asked.log, [{ threadIds: ['PRRT_1'], repo: REPO }]);
  assert.equal(run.sent.length, 0, 'no repair session');
  assert.equal(run.report.fresh, 0);
  assert.deepEqual(run.report.autoClosed, [{ threadId: 'PRRT_1', key: KEY, reason: 'server-review-fixed' }]);
  assert.deepEqual(run.entry.autoClosedThreads.PRRT_1, { at: NOW, key: KEY, reason: 'server-review-fixed', head: HEAD, commentId: 'PRRC_1b' });
  assert.equal(resolvesThrough(run.calls).length, 0, 'this account is not used to resolve');
  assert.deepEqual(run.events.filter((event) => /server-fixed/.test(event.kind)), []);
  const again = await w.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: asked });
  assert.equal(asked.log.length, 1, 'the same closing reply is not resolved twice');
  assert.equal(again.sent.length, 0, 'and its thread still does not reach a session');
});

test('switch on, mixed: only the recognized thread leaves the dispatch; the rest is delivered as before', async (t) => {
  const w = world(t);
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  const run = await w.poll({ threads: [fixedThread(1), openThread(2)], switchValue: '1', appResolveFn: asked });
  assert.deepEqual(asked.log, [{ threadIds: ['PRRT_1'], repo: REPO }]);
  assert.equal(run.sent.length, 1);
  assert.deepEqual(sentKeys(run.sent), ['thread:PRRT_2:PRRC_2a']);
  assert.ok(!run.sent[0].message.includes('PRRT_1'));
  assert.equal(run.report.fresh, 1);
  assert.equal(run.entry.autoClosedThreads.PRRT_1.reason, 'server-review-fixed');
});

test('switch on, several recognized threads share one App call', async (t) => {
  const w = world(t);
  const asked = spy({ resolved: ['PRRT_1', 'PRRT_4'], failures: [] });
  const run = await w.poll({ threads: [fixedThread(1), fixedThread(4)], switchValue: 'true', appResolveFn: asked });
  assert.deepEqual(asked.log, [{ threadIds: ['PRRT_1', 'PRRT_4'], repo: REPO }]);
  assert.equal(run.sent.length, 0);
  assert.deepEqual(run.report.autoClosed.map((x) => x.threadId), ['PRRT_1', 'PRRT_4']);
});

test('the profile can turn the switch on too', async (t) => {
  const w = world(t);
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  fs.mkdirSync(path.join(w.dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(w.dir, 'config', 'profile.json'), JSON.stringify({ resolveFixedThreadsWithApp: true }));
  // The profile is found through MIVO_WATCHER_HOME; point it at this world's home for the run.
  const previousHome = process.env.MIVO_WATCHER_HOME;
  process.env.MIVO_WATCHER_HOME = w.dir;
  try {
    const run = await w.poll({ threads: [fixedThread(1)], appResolveFn: asked });
    assert.equal(asked.log.length, 1);
    assert.equal(run.sent.length, 0);
  } finally { process.env.MIVO_WATCHER_HOME = previousHome; }
});

// SC4: failures. The App module is the real one over a fake GitHub.
// `requests` is what the fake GitHub saw, in order (the installation id is dropped from the mint path).
const failurePlans = {
  'the token is refused (422)': { plan: { mint: () => ({ status: 422, json: async () => ({ message: `Validation Failed ${TOKEN}` }) }) },
    event: { phase: 'mint', expected: 'http 201', actual: 'http 422' }, requests: ['/access_tokens'] },
  'the resolve is refused (403)': { plan: { resolve: () => ({ status: 403, json: async () => ({ message: TOKEN }) }) },
    event: { phase: 'resolve', expected: 'http 200 with isResolved=true', actual: 'http 403' }, requests: ['/access_tokens', '/graphql', '/installation/token'] },
  'GitHub answers the resolve with an error': { plan: { resolve: () => ({ status: 200, json: async () => ({ errors: [{ type: 'FORBIDDEN', message: TOKEN }] }) }) },
    event: { phase: 'resolve', expected: 'http 200 with isResolved=true', actual: 'http 200 graphql error FORBIDDEN' }, requests: ['/access_tokens', '/graphql', '/installation/token'] },
};
for (const [name, { plan, event, requests }] of Object.entries(failurePlans)) {
  test(`switch on, ${name}: the thread stays open, no gh resolve, no session, the log has expected and actual, no token`, async (t) => {
    const w = world(t);
    const net = github(plan);
    const run = await w.poll({ threads: [fixedThread(1), openThread(2)], switchValue: '1', appResolveFn: net.appResolveFn });
    assert.equal(run.entry.autoClosedThreads?.PRRT_1, undefined, 'no receipt for a thread that was not resolved');
    assert.equal(resolvesThrough(run.calls).length, 0, 'never falls back to this account');
    assert.ok(!run.calls.some((args) => args.includes('graphql')), 'not even a graphql read or write from this account');
    assert.deepEqual(sentKeys(run.sent), ['thread:PRRT_2:PRRC_2a'], 'the failed thread is not given to a session; the other thread is');
    assert.deepEqual(run.events.filter((e) => /server-fixed/.test(e.kind)), [{ kind: 'server-fixed-thread-resolve-failed', number: 900, threadId: 'PRRT_1', ...event }]);
    assert.deepEqual(net.calls.map((c) => c.url.replace('https://api.github.com', '').replace(/^\/app\/installations\/\d+/, '')), requests);
    const everything = JSON.stringify({ run, state: fs.readdirSync(w.paths.stateDir, { recursive: true }).filter((f) => f.endsWith('.json'))
      .map((f) => fs.readFileSync(path.join(w.paths.stateDir, f), 'utf8')) });
    assert.ok(!everything.includes(TOKEN), 'the token is nowhere in the output, state or tasks');
    assert.ok(!everything.includes(net.calls[0].auth.replace('Bearer ', '')), 'nor is the App JWT');
  });
}

test('switch on, App settings missing: config failure with expected and actual, nothing sent, nothing resolved', async (t) => {
  const w = world(t);
  const empty = (args) => resolveThreadsWithApp({ ...args, env: { MIVO_WATCHER_HOME: APP_ENV.MIVO_WATCHER_HOME }, fetchImpl: () => { throw new Error('no request expected'); } });
  const run = await w.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: empty });
  assert.equal(run.sent.length, 0);
  assert.equal(resolvesThrough(run.calls).length, 0);
  assert.equal(run.entry.autoClosedThreads?.PRRT_1, undefined);
  assert.deepEqual(run.events.filter((e) => /server-fixed/.test(e.kind)),
    [{ kind: 'server-fixed-thread-resolve-failed', number: 900, threadId: 'PRRT_1', phase: 'config', expected: 'praisebuildAppId set', actual: 'missing' }]);
});

test('switch on, App function throws: the thread stays open and the round goes on', async (t) => {
  const w = world(t);
  const run = await w.poll({ threads: [fixedThread(1), openThread(2)], switchValue: '1', appResolveFn: () => { throw new RangeError('boom'); } });
  assert.deepEqual(sentKeys(run.sent), ['thread:PRRT_2:PRRC_2a']);
  assert.deepEqual(run.events.filter((e) => /server-fixed/.test(e.kind)).map((e) => [e.phase, e.actual]), [['resolve', 'threw RangeError']]);
  assert.equal(resolvesThrough(run.calls).length, 0);
});

test('a revoke that fails is logged on its own and the resolved thread stays resolved', async (t) => {
  const w = world(t);
  const net = github({ revoke: () => ({ status: 500 }) });
  const run = await w.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: net.appResolveFn });
  assert.equal(run.entry.autoClosedThreads.PRRT_1.reason, 'server-review-fixed');
  assert.equal(run.sent.length, 0);
  assert.deepEqual(run.events.filter((e) => /server-fixed/.test(e.kind)), [{ kind: 'server-fixed-thread-token-revoke-failed', number: 900, phase: 'revoke', expected: 'http 204', actual: 'http 500' }]);
});

test('a failed resolve leaves the feedback undelivered: a later poll with the switch off still hands it to a session', async (t) => {
  const w = world(t);
  const net = github({ mint: () => ({ status: 422, json: async () => ({}) }) });
  const failed = await w.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: net.appResolveFn });
  assert.equal(failed.sent.length, 0);
  assert.ok(!Object.keys(failed.entry.feedbackCursor ?? {}).some((key) => key.includes('PRRT_1')), 'the cursor does not mark the held thread as delivered');
  const later = await w.poll({ threads: [fixedThread(1)] });
  assert.deepEqual(sentKeys(later.sent).sort(), ['thread:PRRT_1:PRRC_1a', 'thread:PRRT_1:PRRC_1b']);
});

test('a thread this path resolved is not delivered again, and a thread a person unresolved after the same reply stays with them', async (t) => {
  const w = world(t);
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  await w.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: asked });
  const unresolved = await w.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: asked });
  assert.equal(asked.log.length, 1);
  assert.equal(unresolved.sent.length, 0);
  // A later closing reply is a new word from the review server and is resolved again.
  const newer = threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b'), fixedReply('PRRC_1c', { createdAt: '2026-11-05T00:45:00Z' })]);
  const renewed = await w.poll({ threads: [newer], switchValue: '1', appResolveFn: asked });
  assert.equal(asked.log.length, 2);
  assert.equal(renewed.entry.autoClosedThreads.PRRT_1.commentId, 'PRRC_1c');
});

test('dry run: nothing is recognized, asked or written', async (t) => {
  const w = world(t);
  const asked = spy({ resolved: ['PRRT_1'], failures: [] });
  const previousSwitch = process.env[SWITCH];
  process.env[SWITCH] = '1';
  try {
    const out = await scanOnceAsync({ mode: 'poll', enabled: true, allowDispatch: false, paths: w.paths, now: NOW, nodeId: NODE, prNumber: 900,
      snapshotFn: () => snapshot([fixedThread(1)]), ghFn: (args) => isChildPrList(args) ? '[[]]' : args[0] === 'api' ? 'owner' : '[]',
      collect: (...args) => withAuthorHandoff({ pr: listed(), checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, comments: [], reviews: [],
        threads: [fixedThread(1)], labels: [], mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: true, mergeReady: false,
        policy: { status: 'verified', required: [] } }, args[0]),
      dispatchFn: () => assert.fail('dry run must not dispatch'), ownershipSnapshot: function* () { return { pr: listed() }; }, appResolveFn: asked });
    assert.equal(out.mode, 'poll');
  } finally { if (previousSwitch === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = previousSwitch; }
  assert.equal(asked.log.length, 0);
});

// A completed repair task that already covers a thread: the closing path of that task must not answer a thread the
// App path took (resolved or failed) with this account.
function taskCovering(t, threads) {
  const w = world(t);
  const items = feedbackItems({ pr: { headRefOid: HEAD }, threads, ci: { status: 'green', required: [] }, receiptActor: 'owner' });
  const { fresh, cursor } = newFeedback({}, items);
  const keys = fresh.map((item) => item.key);
  fs.mkdirSync(path.join(w.paths.stateDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(w.paths.stateDir, 'results'), { recursive: true });
  fs.writeFileSync(path.join(w.paths.stateDir, 'tasks', 'T1.json'), JSON.stringify({ dispatchId: 'T1', nodeId: NODE, number: 900, headRefOid: HEAD, feedback: fresh,
    repairPolicy: { items: keys.map((key) => ({ key, action: 'code-fix' })) } }));
  fs.writeFileSync(path.join(w.paths.stateDir, 'results', 'T1.json'), JSON.stringify({ schemaVersion: 2, dispatchId: 'T1', nodeId: NODE, sessionId: 'sess-900', status: 'complete',
    head: HEAD, receiptId: 'receipt-1', ci: { requiredGreen: true, head: HEAD }, verification: { status: 'pass', head: HEAD },
    scs: [{ id: 'SC-1', status: 'pass', feedbackKeys: keys, evidence: ['verified with a focused test'] }],
    feedbackCoverage: { dispositions: keys.map((key) => ({ key, disposition: 'fixed' })) } }));
  writePr(w.paths.home, NODE, { ...w.state(), feedbackCursor: cursor, activeTask: { dispatchId: 'T1', head: HEAD, status: 'accepted', evidenceVersion: 2 } });
  return w;
}

test('a completed task that covers the thread closes it with this account when the switch is off (the existing path)', async (t) => {
  const w = taskCovering(t, [fixedThread(1)]);
  const run = await w.poll({ threads: [fixedThread(1)] });
  assert.equal(resolvesThrough(run.calls).length, 2, 'reply and resolve, as before');
});

test('a completed task that covers the thread does not make this account answer a thread the App path took', async (t) => {
  const resolved = taskCovering(t, [fixedThread(1)]);
  const ok = await resolved.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: spy({ resolved: ['PRRT_1'], failures: [] }) });
  assert.equal(resolvesThrough(ok.calls).length, 0);
  assert.equal(ok.entry.autoClosedThreads.PRRT_1.reason, 'server-review-fixed');
  const failed = taskCovering(t, [fixedThread(1)]);
  const bad = await failed.poll({ threads: [fixedThread(1)], switchValue: '1', appResolveFn: spy({ resolved: [], failures: [{ phase: 'mint', expected: 'http 201', actual: 'http 422' }] }) });
  assert.equal(resolvesThrough(bad.calls).length, 0, 'a failed App resolve is not finished by this account');
  assert.equal(bad.entry.autoClosedThreads?.PRRT_1, undefined);
});

test('a thread the App path took is not brought back by a missing-result recovery of an older task', async (t) => {
  const threads = [fixedThread(1), openThread(2)];
  const w = world(t);
  const { fresh } = newFeedback({}, feedbackItems({ pr: { headRefOid: HEAD }, threads, ci: { status: 'green', required: [] }, receiptActor: 'owner' }));
  fs.mkdirSync(path.join(w.paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(w.paths.stateDir, 'tasks', 'T1.json'), JSON.stringify({ dispatchId: 'T1', nodeId: NODE, number: 900, headRefOid: HEAD, feedback: fresh }));
  writePr(w.paths.home, NODE, { ...w.state(), activeTask: { dispatchId: 'T1', head: HEAD, status: 'blocked', blockedKind: 'missing-result-limit' },
    eligibility: 'blocked', missingResult: { head: HEAD, ci: 'green' } });
  const off = await w.poll({ threads });
  assert.deepEqual(sentKeys(off.sent).sort(), ['thread:PRRT_1:PRRC_1a', 'thread:PRRT_1:PRRC_1b', 'thread:PRRT_2:PRRC_2a'], 'without the switch the recovery hands the whole older task back');
  const again = world(t);
  fs.mkdirSync(path.join(again.paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(again.paths.stateDir, 'tasks', 'T1.json'), JSON.stringify({ dispatchId: 'T1', nodeId: NODE, number: 900, headRefOid: HEAD, feedback: fresh }));
  writePr(again.paths.home, NODE, { ...again.state(), activeTask: { dispatchId: 'T1', head: HEAD, status: 'blocked', blockedKind: 'missing-result-limit' },
    eligibility: 'blocked', missingResult: { head: HEAD, ci: 'green' } });
  const on = await again.poll({ threads, switchValue: '1', appResolveFn: spy({ resolved: ['PRRT_1'], failures: [] }) });
  assert.deepEqual(sentKeys(on.sent).sort(), ['thread:PRRT_2:PRRC_2a']);
});

test('a failed resolve stays undelivered even when another thread is dispatched in the same round', async (t) => {
  const w = world(t);
  const net = github({ mint: () => ({ status: 422, json: async () => ({}) }) });
  const failed = await w.poll({ threads: [fixedThread(1), openThread(2)], switchValue: '1', appResolveFn: net.appResolveFn });
  assert.deepEqual(sentKeys(failed.sent), ['thread:PRRT_2:PRRC_2a']);
  assert.ok(!Object.keys(failed.entry.feedbackCursor ?? {}).some((key) => key.includes('PRRT_1')), 'the bound dispatch does not mark the held thread as delivered');
  const later = await w.poll({ threads: [fixedThread(1), openThread(2)] });
  assert.equal(later.report.dispatch.reason, 'task-in-flight', 'the session working on the other thread holds the round');
  assert.equal(later.report.fresh, 2, 'with the switch off the held thread comes back as fresh feedback, not as delivered');
});

test('a thread the App resolved earlier and a person reopened is closed again by the existing path once a task covers it', async (t) => {
  const reopened = threadOf('PRRT_1', [finding('PRRC_1a'), fixedReply('PRRC_1b'), { id: 'PRRC_1c', author: person, body: '还是有问题', createdAt: '2026-11-05T00:50:00Z' }]);
  for (const switchValue of [undefined, '1']) {
    const w = taskCovering(t, [reopened]);
    writePr(w.paths.home, NODE, { ...w.state(), autoClosedThreads: { PRRT_1: { at: NOW, key: KEY, reason: 'server-review-fixed', head: HEAD, commentId: 'PRRC_1b' } } });
    const asked = spy({ resolved: [], failures: [] });
    const run = await w.poll({ threads: [reopened], switchValue, appResolveFn: asked });
    assert.equal(asked.log.length, 0, 'a person spoke last: not a server-fixed thread');
    assert.equal(resolvesThrough(run.calls).length, 2, `switch ${JSON.stringify(switchValue)}: the covered thread is answered and resolved as before`);
  }
});
