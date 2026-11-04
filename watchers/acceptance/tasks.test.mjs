import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTasks, repoTier, bodyVersion, INVENTORY_QUERY, LEAD_HANDOFF_COMMENT_WINDOW } from './bin/tasks.mjs';
import { createGithub } from './bin/github.mjs';
import { shouldTrigger } from './bin/trigger.mjs';
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
  pageInfo,
  roundComment,
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
  assert.match(INVENTORY_QUERY, /parent \{ number repository \{ nameWithOwner \} author \{ login __typename \} \}/);
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

const ROOT_TASK_KEYS = [
  'ref', 'repo', 'number', 'kind', 'tier', 'fork', 'state', 'closedAt', 'url', 'nodeId',
  'body', 'bodyVersion', 'children', 'linkedPrs', 'rounds', 'outOfScope', 'leadHandoff', 'dispute',
];

function prNode(number, mergedAt) {
  return {
    number,
    url: `https://example.test/pull/${number}`,
    mergedAt,
    repository: { nameWithOwner: REPO },
  };
}

function ownerParent(number, repo = REPO) {
  return { number, repository: { nameWithOwner: repo }, author: { login: OWNER } };
}

const CHILD_CLOSED = '2026-10-20T00:00:00.000Z';
const NOW = () => Date.parse('2026-10-24T00:00:00.000Z');

function correctionBody(root = `${REPO}#1`, item = `${REPO}#2`) {
  return `修正说明\n[验收机] 修正 · 总 ${root} · 项 ${item} SC3 · 第 1 轮\n`;
}

async function tasksFrom(open, closed = []) {
  const profile = profileWith();
  const run = createFakeRun({ onGraphql: () => inventoryData({ open, closed }) });
  const github = createGithub({ profile, run });
  const tasks = await collectTasks(github, profile);
  return { profile, run, tasks };
}

test('#224 SC1 已关闭且 PR 已合并、没有结论的子 issue 产出 kind child，父状态来自同一份清单', async () => {
  const parent = issueNode({
    number: 1,
    body: 'parent',
    subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: CHILD_CLOSED })],
  });
  const child = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    body: 'child body',
    parent: ownerParent(1),
    prs: [prNode(20, '2026-10-20T01:00:00.000Z')],
  });
  const { run, tasks, profile } = await tasksFrom([parent], [child]);
  assert.equal(run.calls.length, 1, '父轮次从同一份清单算，不额外发请求');
  const found = tasks.find((task) => task.ref === `${REPO}#2`);
  assert.ok(found);
  assert.equal(found.kind, 'child');
  assert.equal(found.parentRef, `${REPO}#1`);
  assert.equal(found.parentLatestStatus, null);
  assert.equal(found.parentFinalFinishedAt, null);
  assert.equal(found.linkedPrs[0].mergedAt, '2026-10-20T01:00:00.000Z');
  assert.deepEqual(shouldTrigger(found, { now: NOW, profile }), { trigger: true, reason: 'child-merged' });
});

test('#224 SC2 子 issue 未关闭时不产出任务，即使 PR 已合并', async () => {
  const parent = issueNode({
    number: 1,
    subIssues: [childNode({ number: 2, state: 'OPEN', closedAt: null })],
  });
  const child = issueNode({
    number: 2,
    state: 'OPEN',
    parent: ownerParent(1),
    prs: [prNode(20, '2026-10-20T01:00:00.000Z')],
  });
  const { tasks } = await tasksFrom([parent, child]);
  assert.deepEqual(tasks.map((task) => task.ref), [`${REPO}#1`]);
  assert.equal(tasks.some((task) => task.kind === 'child'), false);
});

test('#224 SC3 已关闭但没有已合并 PR 的子 issue 不产出任务', async () => {
  const parent = issueNode({
    number: 1,
    subIssues: [
      childNode({ number: 2, state: 'CLOSED', closedAt: CHILD_CLOSED }),
      childNode({ number: 3, state: 'CLOSED', closedAt: CHILD_CLOSED }),
    ],
  });
  const unmerged = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    parent: ownerParent(1),
    prs: [prNode(20, null)],
  });
  const noPr = issueNode({
    number: 3,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    parent: ownerParent(1),
    prs: [],
  });
  const { tasks } = await tasksFrom([parent], [unmerged, noPr]);
  assert.deepEqual(tasks.map((task) => task.ref), [`${REPO}#1`]);
});

test('#224 SC6 父最新轮次验收中时，子任务带上这个状态', async () => {
  const parent = issueNode({
    number: 1,
    body: 'parent',
    comments: [roundComment({ round: 2, status: '验收中', createdAt: '2026-10-23T00:00:00.000Z' })],
    subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: CHILD_CLOSED })],
  });
  const child = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    body: 'child body',
    parent: ownerParent(1),
    prs: [prNode(20, '2026-10-20T01:00:00.000Z')],
  });
  const { tasks, profile } = await tasksFrom([parent], [child]);
  const found = tasks.find((task) => task.kind === 'child');
  assert.equal(found.parentLatestStatus, '验收中');
  assert.deepEqual(shouldTrigger(found, { now: NOW, profile }), { trigger: false, reason: 'parent-in-progress' });
});

test('#224 SC7 父结论完成时间晚于子 issue 关闭则记在任务上；早于则照常可触发', async () => {
  const lateParent = issueNode({
    number: 1,
    body: 'parent',
    comments: [roundComment({
      round: 1,
      status: '通过',
      bodyVersion: bodyVersion('parent'),
      finishedAt: '2026-10-21T00:00:00.000Z',
      createdAt: '2026-10-21T00:00:00.000Z',
    })],
    subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: CHILD_CLOSED })],
  });
  const lateChild = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    body: 'child body',
    parent: ownerParent(1),
    prs: [prNode(20, '2026-10-20T01:00:00.000Z')],
  });
  const late = await tasksFrom([lateParent], [lateChild]);
  const covered = late.tasks.find((task) => task.kind === 'child');
  assert.equal(covered.parentFinalFinishedAt, '2026-10-21T00:00:00.000Z');
  assert.deepEqual(shouldTrigger(covered, { now: NOW, profile: late.profile }), { trigger: false, reason: 'parent-covered' });

  const earlyParent = issueNode({
    number: 1,
    body: 'parent',
    comments: [roundComment({
      round: 1,
      status: '要修',
      bodyVersion: bodyVersion('parent'),
      finishedAt: '2026-10-19T00:00:00.000Z',
      createdAt: '2026-10-19T00:00:00.000Z',
    })],
    subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: CHILD_CLOSED })],
  });
  const earlyChild = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    body: 'child body',
    parent: ownerParent(1),
    prs: [prNode(20, '2026-10-20T01:00:00.000Z')],
  });
  const early = await tasksFrom([earlyParent], [earlyChild]);
  const openRound = early.tasks.find((task) => task.kind === 'child');
  assert.equal(openRound.parentFinalFinishedAt, '2026-10-19T00:00:00.000Z');
  assert.deepEqual(shouldTrigger(openRound, { now: NOW, profile: early.profile }), { trigger: true, reason: 'child-merged' });
});

test('#224 SC8 回归：parent 和 standalone 的字段与触发不变，startAt 之前的子 issue 仍不收', async () => {
  const parent = issueNode({
    number: 1,
    subIssues: [
      childNode({ number: 2, state: 'OPEN' }),
      childNode({ number: 3, state: 'CLOSED', closedAt: CHILD_CLOSED }),
    ],
  });
  const openChild = issueNode({
    number: 2,
    state: 'OPEN',
    parent: ownerParent(1),
  });
  const mergedChild = issueNode({
    number: 3,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    body: 'merged child',
    parent: ownerParent(1),
    prs: [prNode(30, '2026-10-20T02:00:00.000Z')],
  });
  const standalone = issueNode({ number: 8, body: 'alone' });
  const adopted = issueNode({
    number: 9,
    parent: { number: 100, repository: { nameWithOwner: REPO }, author: { login: 'SomeoneElse' } },
  });
  const tooOld = issueNode({
    number: 4,
    state: 'CLOSED',
    closedAt: '2019-01-01T00:00:00.000Z',
    parent: ownerParent(1),
    prs: [prNode(40, '2019-01-02T00:00:00.000Z')],
  });
  const { tasks, profile } = await tasksFrom([parent, openChild, standalone, adopted], [mergedChild, tooOld]);
  const byRef = Object.fromEntries(tasks.map((task) => [task.ref, task]));
  assert.equal(byRef[`${REPO}#1`].kind, 'parent');
  assert.deepEqual(Object.keys(byRef[`${REPO}#1`]).sort(), [...ROOT_TASK_KEYS].sort());
  assert.deepEqual(byRef[`${REPO}#1`].children.map((child) => child.ref), [`${REPO}#2`, `${REPO}#3`]);
  assert.deepEqual(shouldTrigger(byRef[`${REPO}#1`], { now: NOW, profile }), { trigger: false, reason: 'children-open' });
  assert.equal(byRef[`${REPO}#8`].kind, 'standalone');
  assert.deepEqual(Object.keys(byRef[`${REPO}#8`]).sort(), [...ROOT_TASK_KEYS].sort());
  assert.equal(byRef[`${REPO}#9`].kind, 'standalone');
  assert.equal(byRef[`${REPO}#4`], undefined);
  assert.equal(byRef[`${REPO}#3`].kind, 'child');
});

test('#224 SC15 带修正标记的已关闭且 PR 已合并子 issue 不产出；不带标记的照常产出', async () => {
  const parent = issueNode({
    number: 1,
    subIssues: [
      childNode({ number: 2, state: 'CLOSED', closedAt: CHILD_CLOSED }),
      childNode({ number: 3, state: 'CLOSED', closedAt: CHILD_CLOSED }),
    ],
  });
  const marked = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    body: correctionBody(),
    parent: ownerParent(1),
    prs: [prNode(20, '2026-10-20T01:00:00.000Z')],
  });
  const plain = issueNode({
    number: 3,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    body: '普通子 issue',
    parent: ownerParent(1),
    prs: [prNode(21, '2026-10-20T01:00:00.000Z')],
  });
  const { tasks } = await tasksFrom([parent], [marked, plain]);
  assert.equal(tasks.some((task) => task.ref === `${REPO}#2`), false);
  const found = tasks.find((task) => task.ref === `${REPO}#3`);
  assert.equal(found.kind, 'child');
});

// ── #247 SC1：一拍只发一遍盘点（请求数只随页数增长），且回归项不变 ──

test('#247 SC1 盘点请求数只随页数增长；已关单有变化仍被拉到', async () => {
  const profile = profileWith();
  const open1 = issueNode({ repo: REPO, number: 20, author: OWNER });
  const closedChanged = issueNode({
    repo: REPO,
    number: 21,
    author: OWNER,
    state: 'CLOSED',
    closedAt: '2026-10-25T00:00:00.000Z',
    updatedAt: '2026-10-25T00:00:00.000Z',
    prs: [{ number: 5, url: `https://github.com/${REPO}/pull/5`, mergedAt: '2026-10-25T01:00:00.000Z', repository: { nameWithOwner: REPO } }],
  });
  const seenOpenCursors = [];
  const calls = [];
  const run = createFakeRun({
    onGraphql: (payload) => {
      calls.push(payload.variables);
      seenOpenCursors.push(payload.variables.openAfter);
      if (!payload.variables.openAfter) {
        return inventoryData({
          open: [open1],
          closed: [closedChanged],
          openPage: pageInfo(true, 'open-cursor-1'),
          closedPage: pageInfo(false, null),
        });
      }
      return inventoryData({ open: [], closed: [], openPage: pageInfo(false, null), closedPage: pageInfo(false, null) });
    },
  });
  const github = createGithub({ profile, run, fetchImpl: async () => ({ token: 'nope' }) });
  const tasks = await collectTasks(github, profile);
  assert.equal(calls.length, 2, `两页就该只发两次请求，实际 ${calls.length}`);
  assert.deepEqual(seenOpenCursors, [null, 'open-cursor-1']);
  // closed 那一遍翻完了就不再翻（同一页里两次查询合成一次请求，不重复拉）。
  assert.equal(calls.every((variables) => variables.since === profile.startAt), true, '已关单按 startAt 之后的变化拉');
  const closed = tasks.find((task) => task.ref === `${REPO}#21`);
  assert.ok(closed, '已关单有变化（更新过）仍要进盘点');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.linkedPrs.length, 1);
});

test('#247 SC1 回归：评论窗口仍是 50 条（不改小），评论多的任务照样能进盘点', () => {
  assert.match(INVENTORY_QUERY, /comments\(last: 50\)/);
  assert.equal(LEAD_HANDOFF_COMMENT_WINDOW, 50);
});
