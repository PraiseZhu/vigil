import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTasks, repoTier, bodyVersion, INVENTORY_QUERY } from './bin/tasks.mjs';
import { createGithub } from './bin/github.mjs';
import {
  OWNER,
  REPO,
  OTHER_REPO,
  HANDOFF_REPO,
  START_AT,
  childNode,
  createFakeRun,
  inventoryData,
  issueNode,
  sha256Body,
  tmpDir,
  writeProfile,
} from './fake-gh.fixture.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';

function profileWith(homeExtra = {}) {
  const { home } = writeProfile(tmpDir(), homeExtra);
  return loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
}

test('SC1 只收我建的 issue，跨仓子 issue 进同一棵树', async () => {
  const profile = profileWith();
  const parent = issueNode({
    repo: REPO,
    number: 10,
    author: OWNER,
    subIssues: [
      childNode({ repo: OTHER_REPO, number: 3, author: OWNER, state: 'CLOSED' }),
      childNode({ repo: REPO, number: 4, author: 'SomeoneElse', state: 'CLOSED' }),
    ],
  });
  const stranger = issueNode({ repo: REPO, number: 11, author: 'SomeoneElse' });
  const run = createFakeRun({
    onGraphql: () => inventoryData({ open: [parent, stranger] }),
  });
  const github = createGithub({ profile, run, fetchImpl: async () => ({ token: 'nope' }) });
  const tasks = await collectTasks(github, profile);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].ref, `${REPO}#10`);
  assert.equal(tasks[0].kind, 'parent');
  assert.deepEqual(
    tasks[0].children.map((c) => c.ref),
    [`${OTHER_REPO}#3`],
  );
});

test('SC1 别人建的父 issue 下我建的子 issue 当根', async () => {
  const profile = profileWith();
  const mine = issueNode({
    repo: REPO,
    number: 8,
    author: OWNER,
    parent: { number: 1, repository: { nameWithOwner: REPO }, author: { login: 'SomeoneElse' } },
  });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [mine] }) });
  const github = createGithub({ profile, run });
  const tasks = await collectTasks(github, profile);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].ref, `${REPO}#8`);
  assert.equal(tasks[0].kind, 'standalone');
});

test('SC2 分档：autoRepos 支持 owner/*，forkRepos 为 auto+fork，watchRepos 为 watch，其余不收', () => {
  const profile = {
    ownerLogin: OWNER,
    autoRepos: [`${OWNER}/*`],
    forkRepos: ['makecindy/cindy'],
    watchRepos: [HANDOFF_REPO],
  };
  assert.deepEqual(repoTier(`${OWNER}/plugins`, profile), { tier: 'auto', fork: false });
  assert.deepEqual(repoTier('makecindy/cindy', profile), { tier: 'auto', fork: true });
  assert.deepEqual(repoTier(HANDOFF_REPO, profile), { tier: 'watch', fork: false });
  assert.equal(repoTier('someone/else', profile), null);
});

test('SC2 没配 autoRepos 时只有 ownerLogin/* 是 auto', () => {
  const profile = profileWith({ profile: { autoRepos: undefined } });
  // loadAcceptanceProfile 会填默认 [`${ownerLogin}/*`]
  assert.deepEqual(repoTier(`${OWNER}/anything`, profile), { tier: 'auto', fork: false });
  assert.equal(repoTier('other-owner/repo', profile), null);
});

test('SC2 collectTasks 丢掉三个名单都不在的仓', async () => {
  const profile = profileWith();
  const keep = issueNode({ repo: `${OWNER}/mine`, number: 1, author: OWNER });
  const drop = issueNode({ repo: 'other-owner/secret', number: 2, author: OWNER });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [keep, drop] }) });
  const github = createGithub({ profile, run });
  const tasks = await collectTasks(github, profile);
  assert.deepEqual(
    tasks.map((t) => t.ref),
    [`${OWNER}/mine#1`],
  );
});

test('bodyVersion 去掉行尾空白后再哈希', () => {
  assert.equal(bodyVersion('a  \n b\t\n'), sha256Body('a  \n b\t\n'));
  assert.equal(bodyVersion(null), sha256Body(''));
});

test('startAt 之前已关闭的根 issue 不收', async () => {
  const profile = profileWith();
  const old = issueNode({
    repo: REPO,
    number: 9,
    author: OWNER,
    state: 'CLOSED',
    closedAt: '2019-01-01T00:00:00.000Z',
  });
  const run = createFakeRun({ onGraphql: () => inventoryData({ closed: [old] }) });
  const github = createGithub({ profile, run });
  const tasks = await collectTasks(github, profile);
  assert.equal(tasks.length, 0);
  const vars = JSON.parse(run.calls[0].input).variables;
  assert.equal(vars.since, START_AT);
});

test('SC1 我建的总 issue 下我建的子 issue 不单独成任务（查询带父 issue 作者）', async () => {
  assert.match(INVENTORY_QUERY, /parent \{ number repository \{ nameWithOwner \} author \{ login \} \}/);
  const profile = profileWith();
  const parent = issueNode({
    repo: REPO,
    number: 20,
    author: OWNER,
    subIssues: [childNode({ repo: REPO, number: 21, author: OWNER, state: 'OPEN' })],
  });
  const child = issueNode({
    repo: REPO,
    number: 21,
    author: OWNER,
    parent: { number: 20, repository: { nameWithOwner: REPO }, author: { login: OWNER } },
  });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [parent, child] }) });
  const github = createGithub({ profile, run });
  const tasks = await collectTasks(github, profile);
  assert.deepEqual(tasks.map((t) => t.ref), [`${REPO}#20`]);
});
