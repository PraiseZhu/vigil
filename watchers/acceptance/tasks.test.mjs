import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTasks, repoTier, bodyVersion, INVENTORY_QUERY, LEAD_HANDOFF_COMMENT_WINDOW } from './bin/tasks.mjs';
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

test('#140 SC1/SC3 盘点从总 issue 评论算出登记与交接时间：只认我发的，别人发的同样首行不算', async () => {
  const profile = profileWith();
  const comment = (author, body, createdAt, databaseId) => ({ id: `IC_${databaseId}`, databaseId, body, createdAt, updatedAt: createdAt, url: `u${databaseId}`, author: { login: author } });
  const parent = issueNode({
    repo: REPO,
    number: 10,
    author: OWNER,
    subIssues: [childNode({ repo: REPO, number: 11, author: OWNER, state: 'CLOSED' })],
    comments: [
      comment(OWNER, `批准执行登记：2026-10-22 ${REPO}#11 → 会话 s1（x）claim c1`, '2026-10-22T00:00:00.000Z', 1),
      comment(OWNER, '[批准执行] 交接验收 · 第 1 次\n总 issue：x', '2026-10-23T00:00:00.000Z', 2),
      comment('SomeoneElse', '[批准执行] 交接验收 · 第 2 次', '2026-10-24T00:00:00.000Z', 3),
      comment('SomeoneElse', `批准执行登记：2026-10-25 ${REPO}#11 → 会话 s9（x）claim c9`, '2026-10-25T00:00:00.000Z', 4),
    ],
  });
  const plain = issueNode({ repo: REPO, number: 20, author: OWNER, subIssues: [childNode({ repo: REPO, number: 21, author: OWNER })] });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [parent, plain] }) });
  const github = createGithub({ profile, run });
  const tasks = await collectTasks(github, profile);
  const byRef = Object.fromEntries(tasks.map((t) => [t.ref, t]));
  assert.deepEqual(byRef[`${REPO}#10`].leadHandoff, { registeredAt: '2026-10-22T00:00:00.000Z', handoffAt: '2026-10-23T00:00:00.000Z' });
  assert.deepEqual(byRef[`${REPO}#20`].leadHandoff, { registeredAt: null, handoffAt: null }, '没有登记的任务两项都是 null');
});

test('#140 反例（review-pr141）：交接早于最后一条登记（之后又派了会话）就不算；评论窗口和盘点查询一致', async () => {
  assert.ok(INVENTORY_QUERY.includes(`comments(last: ${LEAD_HANDOFF_COMMENT_WINDOW})`), '窗口常量要和盘点查询的条数一致');
  const profile = profileWith();
  const comment = (body, createdAt, databaseId) => ({ id: `IC_${databaseId}`, databaseId, body, createdAt, updatedAt: createdAt, url: `u${databaseId}`, author: { login: OWNER } });
  const parent = issueNode({
    repo: REPO,
    number: 10,
    author: OWNER,
    subIssues: [childNode({ repo: REPO, number: 11, author: OWNER, state: 'CLOSED' })],
    comments: [
      comment(`批准执行登记：2026-10-22 ${REPO}#11 → 会话 s1（x）claim c1`, '2026-10-22T00:00:00.000Z', 1),
      comment('[批准执行] 交接验收 · 第 1 次', '2026-10-23T00:00:00.000Z', 2),
      comment(`批准执行登记：2026-10-24 ${REPO}#12 → 会话 s2（x）claim c2`, '2026-10-24T00:00:00.000Z', 3),
    ],
  });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [parent] }) });
  const tasks = await collectTasks(createGithub({ profile, run }), profile);
  assert.deepEqual(tasks[0].leadHandoff, { registeredAt: '2026-10-24T00:00:00.000Z', handoffAt: null });
});
