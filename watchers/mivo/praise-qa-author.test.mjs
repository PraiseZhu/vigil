import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WATCHED_BOT_APP, isSameAuthor, isWatchedAuthor } from './bin/mivo-identity.mjs';
import { implicitHandoff, isCurrentHandoff, selectHandoff } from './bin/mivo-handoff.mjs';
import { assertActionOwner } from './bin/mivo-pr-actions.mjs';
import { REPO, listWatchedPrs, scanOnceAsync, watcherPaths } from './bin/mivo-watcher.mjs';
import { readPr } from './bin/mivo-state.mjs';
import { handoffPr } from './handoff.fixture.mjs';

// vigil#360: the watcher also looks after the Ready PRs the praise-qa GitHub App opens. The test viewer is `owner`
// (test.env VIGIL_GH_LOGIN).
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
// How the GitHub APIs spell the App as an author: gh pr list/view, REST, GraphQL.
const APP = { login: 'app/praise-qa', is_bot: true };
const APP_SPELLINGS = [APP, { login: 'praise-qa[bot]', type: 'Bot' }, { login: 'praise-qa', __typename: 'Bot' }];
// Not the App: a person who happens to be called praise-qa, and other Apps.
const NOT_APP = [{ login: 'praise-qa', __typename: 'User' }, { login: 'praise-qa', is_bot: false }, { login: 'app/other', is_bot: true },
  { login: 'other[bot]', type: 'Bot' }];

function run(gen) {
  let step = gen.next();
  while (!step.done) {
    try { step = gen.next(step.value()); } catch (error) { step = gen.throw(error); }
  }
  return step.value;
}

test('SC1 the watched authors are the configured account and the praise-qa App, however GitHub spells the App', () => {
  const env = { VIGIL_GH_LOGIN: 'PraiseZhu' };
  assert.equal(WATCHED_BOT_APP, 'praise-qa');
  for (const author of ['PraiseZhu', { login: 'praisezhu', __typename: 'User' }, 'app/praise-qa', 'praise-qa[bot]', ...APP_SPELLINGS]) {
    assert.equal(isWatchedAuthor(author, env), true, JSON.stringify(author));
  }
  for (const author of ['other-user', 'other[bot]', 'praise-qa', { login: 'PraiseZhu', __typename: 'Bot' }, ...NOT_APP, null, '', { login: '' }]) {
    assert.equal(isWatchedAuthor(author, env), false, JSON.stringify(author));
  }
  for (const a of APP_SPELLINGS) for (const b of APP_SPELLINGS) assert.equal(isSameAuthor(a, b), true, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
  for (const other of NOT_APP) assert.equal(isSameAuthor(APP, other), false, JSON.stringify(other));
  assert.equal(isSameAuthor(null, null), false);
});

const listedPr = (number, extra = {}) => ({ number, id: `PR_${number}`, headRefOid: HEAD, headRefName: `qa/${number}`,
  title: 'fix', isDraft: false, labels: [], updatedAt: '2026-10-15T00:00:00Z', ...extra });

test('SC2 one listing of the viewer\'s PRs and one of the praise-qa App\'s, merged by node id', () => {
  const calls = [];
  const ghFn = (args) => { calls.push(args); return JSON.stringify(args.includes('--app') ? [listedPr(852), listedPr(853)] : [listedPr(851), listedPr(852)]); };
  assert.deepEqual(run(listWatchedPrs({ ghFn, viewer: 'owner' })).map((pr) => pr.number), [851, 852, 853]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((args) => [args[args.indexOf('--repo') + 1], ...args.slice(4, 6)]), [[REPO, '--author', 'owner'], [REPO, '--app', 'praise-qa']]);
  for (const args of calls) assert.ok(!args.includes('--search'), 'the gh router refuses --search');
  // A listing at the safety bound is handed back whole, so the caller refuses it instead of claiming full coverage.
  const full = Array.from({ length: 1000 }, (_, i) => listedPr(i + 1));
  const bounded = [];
  assert.equal(run(listWatchedPrs({ ghFn: (args) => { bounded.push(args); return JSON.stringify(full); }, viewer: 'owner' })).length, 1000);
  assert.equal(bounded.length, 1);
  assert.throws(() => run(listWatchedPrs({ ghFn: () => '{}', viewer: 'owner' })), /not an array/);
});

// Required CI failed on a Ready PR written by `author`: it needs a repair session. No handoff comment: the App never
// writes one, being Ready is the handoff.
function failingBy(author) {
  const pr = (listed) => handoffPr({ ...listed, state: 'OPEN', isDraft: false, sameRepository: true, author,
    headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' });
  return {
    collect: (listed) => ({
      pr: pr(listed), admissionVerified: true,
      checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
      ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
      policy: { status: 'verified', required: [{ context: 'unit' }] },
      comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
    }),
    ownership: function* ({ pr: asked }) { return { pr: pr({ id: `PR_${asked.number}`, number: asked.number, headRefName: `qa/${asked.number}` }) }; },
  };
}

async function discoverAppListing(t, author) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'praise-qa-author-'));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'praise-qa-author-plugin-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(plugin, { recursive: true, force: true }); });
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const sent = [];
  const { collect, ownership } = failingBy(author);
  const result = await scanOnceAsync({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
    ghFn: async (args) => (args[0] === 'pr' && args[1] === 'list' ? JSON.stringify(args.includes('--app') ? [listedPr(851)] : []) : '[]'),
    collect: async (pr) => collect(pr),
    dispatchFn: async (params) => { sent.push(params.title); return { target_session_id: 'sess-851' }; },
    ownershipSnapshot: ownership,
  });
  return { result, sent, paths };
}

test('SC2 a Ready PR of the praise-qa App is collected and dispatched like the viewer\'s own, on its Ready handoff', async (t) => {
  const { result, sent, paths } = await discoverAppListing(t, APP);
  assert.deepEqual(result.prs.map((item) => [item.number, item.dispatch.reason ?? item.dispatch.attempted]), [[851, true]]);
  assert.equal(sent.length, 1);
  assert.equal(readPr(paths.home, 'PR_851').sessionId, 'sess-851');
});

test('SC2 a PR in the App listing that someone else wrote is not taken over', async (t) => {
  for (const author of [{ login: 'praise-qa', is_bot: false }, { login: 'app/other', is_bot: true }, { login: 'SomeoneElse' }]) {
    const { result, sent } = await discoverAppListing(t, author);
    assert.deepEqual(result.prs.map((item) => [item.number, item.dispatch.reason ?? item.dispatch.attempted]), [[851, 'ownership-no-longer-released']], JSON.stringify(author));
    assert.equal(sent.length, 0);
  }
});

test('SC3 the App\'s Ready PR is handed off by being Ready; another App\'s is not, and a comment by the App is never a handoff', () => {
  const pr = handoffPr({ id: 'PR_1', number: 1, headRefOid: HEAD, headRefName: 'qa/1', baseRefOid: BASE, author: APP });
  const receipt = implicitHandoff(pr);
  assert.equal(receipt?.implicit, true);
  // The receipt holds whichever API later reads the PR again.
  for (const author of APP_SPELLINGS) assert.equal(isCurrentHandoff(receipt, { ...pr, author }), true, JSON.stringify(author));
  for (const author of NOT_APP) assert.equal(isCurrentHandoff(receipt, { ...pr, author }), false, JSON.stringify(author));
  for (const author of [{ login: 'app/other', is_bot: true }, { login: 'other[bot]', type: 'Bot' }]) assert.equal(implicitHandoff({ ...pr, author }), null);
  const marker = { version: 1, repo: pr.repo, number: 1, nodeId: 'PR_1', head: HEAD, releaseEpoch: pr.releaseEpoch };
  const comment = (user) => ({ id: 42, user, created_at: '2026-09-02T00:00:00Z', body: `<!-- vigil-handoff ${JSON.stringify(marker)} -->` });
  // The same comment from the PR's human author is a handoff, so only the App authorship makes it none.
  assert.ok(selectHandoff([comment({ login: 'owner', type: 'User' })], { ...pr, author: { login: 'owner' } }));
  for (const user of [{ login: 'praise-qa[bot]', type: 'Bot' }, APP, { login: 'praise-qa', __typename: 'Bot' }]) {
    assert.equal(selectHandoff([comment(user)], pr), null, JSON.stringify(user));
  }
});

test('SC4 the watcher may act on the App\'s PR; anyone else\'s is still author-mismatch', () => {
  const live = (author) => ({ pr: { id: 'PR_1', number: 7, state: 'OPEN', isDraft: false, sameRepository: true, author,
    headRefOid: HEAD, headRefName: 'qa/7', baseRefOid: BASE, baseRefName: 'main', releaseEpoch: 'ready:e' } });
  for (const author of [{ login: 'owner' }, ...APP_SPELLINGS]) {
    assert.equal(assertActionOwner({ live: live(author), snapshot: live(author), entry: {}, viewer: 'owner', expected: { nodeId: 'PR_1', head: HEAD } }), true, JSON.stringify(author));
  }
  for (const author of [...NOT_APP, { login: 'SomeoneElse' }, null]) {
    assert.throws(() => assertActionOwner({ live: live(author), snapshot: live(author), entry: {}, viewer: 'owner' }), /author-mismatch/, JSON.stringify(author));
  }
});
