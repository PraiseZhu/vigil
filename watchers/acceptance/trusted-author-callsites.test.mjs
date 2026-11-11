// #273 复审：身份白名单（#271 的 isTrustedAuthor）在每个真鉴权调用点上的行为。
// 每处都断言三件事：名单里的 App bot 发的 → 认；名单外 bot 发的 → 不认；外部普通用户（User）发的 → 不认。
// 行号对应当前文件里的调用点：host/prbot.mjs、host/prbot-gate-check.mjs、bin/collect.mjs、bin/tasks.mjs。
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { collectTree } from './bin/collect.mjs';
import { collectTasks, leadHandoffOf } from './bin/tasks.mjs';
import { createGithub } from './bin/github.mjs';
import { parseCorrectionRounds } from './host/prbot.mjs';
import { createCorrectionCheck } from './host/prbot-gate-check.mjs';
import { createFakeGithub, createWorld } from './session.fixture.mjs';
import {
  OWNER,
  REPO,
  childNode,
  createFakeRun,
  inventoryData,
  issueNode,
  roundComment,
  tmpDir,
  writeProfile,
} from './fake-gh.fixture.mjs';

// 夹具里的 App bot 登录名用占位符：公开仓不写真实 App 编号 / 真实 bot 名。
const BOT = 'example-automation[bot]';
const OTHER_BOT = 'github-actions[bot]';
const STRANGER = 'StrangerUser';
const ROOT_REF = `${REPO}#1`;
const CORRECTION_REF = `${REPO}#9`;
const CORRECTION_BODY = `[验收机] 修正 · 总 ${ROOT_REF} · 项 ${REPO}#2 SC3 · 第 1 轮`;
const CHILD_CLOSED = '2026-10-20T00:00:00.000Z';

/** 作者对象：GraphQL 里 `author { login __typename }`，没给类型的老数据只有 login。 */
function authorOf(login, type) {
  return type ? { login, __typename: type } : { login };
}

function profileWith(logins = [BOT]) {
  const { home } = writeProfile(tmpDir(), { profile: { trustedBotLogins: logins } });
  return loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
}

function commentOf(body, author, createdAt, databaseId) {
  return { id: `IC_${databaseId}`, databaseId, body, createdAt, updatedAt: createdAt, url: `u${databaseId}`, author };
}

// ---- host/prbot.mjs：修正轮状态评论的作者（parseCorrectionRounds，调用点在 114 行）----

test('SC1 修正轮状态评论作者：名单里的 bot 认，名单外 bot 与外部用户不认（prbot.mjs:114）', () => {
  const at = (round) => `2026-10-24T0${round}:00:00.000Z`;
  const rounds = [
    commentOf('[修正机] 第 1 轮：修正中', authorOf(OWNER, 'User'), at(1), 1),
    commentOf('[修正机] 第 2 轮：等 CI', authorOf(BOT, 'Bot'), at(2), 2),
    commentOf('[修正机] 第 3 轮：修正中', authorOf(OTHER_BOT, 'Bot'), at(3), 3),
    commentOf('[修正机] 第 4 轮：修正中', authorOf(STRANGER, 'User'), at(4), 4),
  ];
  assert.deepEqual(
    parseCorrectionRounds(rounds, profileWith()).map((entry) => `${entry.round}:${entry.commentId}`),
    ['1:1', '2:2'],
  );
  // 没配名单：bot 发的和改动前一样不算，只剩本人
  assert.deepEqual(
    parseCorrectionRounds(rounds, profileWith([])).map((entry) => entry.round),
    [1],
  );
  // login 命中但作者自带类型是 User：冒充的 / 改名撞名的一律不放行
  assert.deepEqual(
    parseCorrectionRounds([commentOf('[修正机] 第 5 轮：修正中', authorOf(BOT, 'User'), at(5), 5)], profileWith()),
    [],
  );
  // 冒充串（名单项加后缀）同样不算
  assert.deepEqual(
    parseCorrectionRounds([commentOf('[修正机] 第 6 轮：修正中', authorOf(`${BOT}x`, 'Bot'), at(6), 6)], profileWith()),
    [],
  );
});

// ---- host/prbot-gate-check.mjs：修正轮绑定上下文里的同一段解析（调用点在 162 行）----

function correctionContextWith(world, profile) {
  const { correctionContext } = createCorrectionCheck({
    github: createFakeGithub(world),
    profile,
    binding: { kind: 'correction', issue: CORRECTION_REF, round: 1, commentId: null },
    scopeOf: () => ({ tier: 'auto', fork: false }),
    // 与写闸里的 readIssueState 同形：{ issue: { body, comments: { nodes } } }
    readIssueState: async (ref) => {
      const issue = world.get(ref);
      if (!issue) return null;
      return { issue: { ...issue, comments: { nodes: issue.comments } } };
    },
    checkPrReady: async () => null,
    gateActions: {},
    reject: (reason, message) => ({ code: 4, body: { reason, message } }),
  });
  return correctionContext();
}

test('SC2 修正轮绑定上下文：名单里的 bot 发的状态评论算本轮，名单外 bot 与外部用户不算（prbot-gate-check.mjs:162）', async () => {
  const world = createWorld();
  const root = world.addIssue({ repo: REPO, number: 1, title: '总任务', body: '- [ ] SC1 总任务 验证：unit' });
  world.addComment(root.ref, { ...roundComment({ round: 1, status: '要修', databaseId: 9001 }) });
  const correction = world.addIssue({ repo: REPO, number: 9, title: '修正', body: CORRECTION_BODY });
  world.addChild(root.ref, correction.ref);
  world.addComment(correction.ref, { body: '[修正机] 第 1 轮：修正中', author: BOT, databaseId: 9101 });
  world.addComment(correction.ref, { body: '[修正机] 第 2 轮：修正中', author: OTHER_BOT, databaseId: 9102 });
  world.addComment(correction.ref, { body: '[修正机] 第 3 轮：修正中', author: STRANGER, databaseId: 9103 });

  const trusted = await correctionContextWith(world, profileWith());
  assert.ok(trusted, '上下文要能建起来');
  assert.deepEqual(
    trusted.rounds.map((entry) => `${entry.round}:${entry.commentId}`),
    ['1:9101'],
    '只有名单里的 bot 那一轮算，名单外 bot 与外部用户的两轮都不算',
  );
  assert.equal(trusted.latest.commentId, 9101);

  // 没配名单：三轮全不算，和改动前一致（bot 发的轮次评论当时也不认）
  const plain = await correctionContextWith(world, profileWith([]));
  assert.deepEqual(plain.rounds, []);
  assert.equal(plain.latest, null);
});

// ---- bin/collect.mjs：搜索到的修正子 issue 作者（调用点在 208 行）----

test('SC3 搜索到的修正子 issue 作者：名单里的 bot 建的收进 corrections，名单外 bot 与外部用户不收（collect.mjs:208）', async () => {
  const world = createWorld();
  world.addIssue({ repo: REPO, number: 1, title: '总任务', body: '- [ ] SC1 总任务 验证：unit' });
  // 三条都没挂成子 issue，只能靠搜索找到：覆盖的正是 208 行这一处
  world.addIssue({ repo: REPO, number: 20, title: 'bot 修正', body: CORRECTION_BODY, author: BOT });
  world.addIssue({ repo: REPO, number: 21, title: '别的 bot 修正', body: CORRECTION_BODY, author: OTHER_BOT });
  world.addIssue({ repo: REPO, number: 22, title: '外部用户修正', body: CORRECTION_BODY, author: STRANGER });
  const github = createFakeGithub(world);

  const trusted = await collectTree({ github, profile: profileWith(), ref: ROOT_REF });
  assert.deepEqual(trusted.corrections.map((entry) => entry.ref), [`${REPO}#20`]);
  assert.deepEqual(trusted.issues.map((entry) => entry.ref), [ROOT_REF], '没挂成子 issue 的不算树里的子任务');
  assert.equal(trusted.root.kind, 'standalone');

  const plain = await collectTree({ github, profile: profileWith([]), ref: ROOT_REF });
  assert.deepEqual(plain.corrections, [], '没配名单时一条修正子 issue 都不认');
});

// ---- bin/tasks.mjs：交接评论作者（调用点在 132 行）----

test('SC4 交接评论 / 登记作者：名单里的 bot 的登记与交接照算，名单外 bot 与外部用户不算（tasks.mjs:132）', () => {
  const comments = [
    commentOf(`批准执行登记：2026-10-22 ${REPO}#11 → 会话 s1（x）claim c1`, authorOf(OWNER, 'User'), '2026-10-22T00:00:00.000Z', 1),
    commentOf('[批准执行] 交接验收 · 第 1 次', authorOf(OTHER_BOT, 'Bot'), '2026-10-23T00:00:00.000Z', 2),
    commentOf('[批准执行] 交接验收 · 第 2 次', authorOf(STRANGER, 'User'), '2026-10-23T01:00:00.000Z', 3),
  ];
  const trusted = leadHandoffOf(comments, profileWith());
  assert.equal(trusted.registeredAt, '2026-10-22T00:00:00.000Z');
  assert.equal(trusted.handoff, null, '名单外 bot 与外部用户发的交接都不算');

  const withBot = [
    ...comments,
    commentOf('[批准执行] 交接验收 · 第 3 次\n## 请重点查\n1. 白名单调用点', authorOf(BOT, 'Bot'), '2026-10-23T02:00:00.000Z', 4),
    commentOf('[批准执行] 交接验收 · 第 4 次', authorOf(`${BOT}x`, 'Bot'), '2026-10-23T03:00:00.000Z', 5),
  ];
  const bot = leadHandoffOf(withBot, profileWith());
  assert.equal(bot.handoff.n, 3, '冒充串（名单项加后缀）发的第 4 次不算');
  assert.deepEqual(bot.handoff.focus, ['白名单调用点']);

  const plain = leadHandoffOf(withBot, profileWith([]));
  assert.equal(plain.handoff, null, '没配名单时交接照旧只认本人');
});

// ---- bin/tasks.mjs：任务作者 231 行、子 issue 作者 237 行 ----

async function tasksFrom(nodes, profile, closed = []) {
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: nodes, closed }) });
  const github = createGithub({ profile, run });
  return collectTasks(github, profile);
}

test('SC5 任务与子 issue 作者：名单里的 bot 建的任务 / 子 issue 都收，名单外 bot 与外部用户的不收（tasks.mjs:231 / 237）', async () => {
  const parent = issueNode({
    repo: REPO,
    number: 10,
    author: OWNER,
    subIssues: [
      childNode({ repo: REPO, number: 11, author: BOT, state: 'OPEN' }),
      childNode({ repo: REPO, number: 12, author: OTHER_BOT, state: 'OPEN' }),
      childNode({ repo: REPO, number: 13, author: STRANGER, state: 'OPEN' }),
    ],
  });
  const botTask = issueNode({ repo: REPO, number: 20, author: BOT });
  const otherBotTask = issueNode({ repo: REPO, number: 21, author: OTHER_BOT });
  const strangerTask = issueNode({ repo: REPO, number: 22, author: STRANGER });
  const nodes = [parent, botTask, otherBotTask, strangerTask];

  const trusted = await tasksFrom(nodes, profileWith());
  assert.deepEqual(trusted.map((task) => task.ref), [`${REPO}#10`, `${REPO}#20`], '231 行：任务作者只认本人 + 名单里的 bot');
  assert.deepEqual(trusted[0].children.map((child) => child.ref), [`${REPO}#11`], '237 行：子 issue 作者同理');
  assert.equal(trusted[0].kind, 'parent');

  const plain = await tasksFrom(nodes, profileWith([]));
  assert.deepEqual(plain.map((task) => task.ref), [`${REPO}#10`], '没配名单：bot 建的任务不收');
  assert.deepEqual(plain[0].children, [], '没配名单：bot 建的子 issue 不收，与改动前一致');
  assert.equal(plain[0].kind, 'standalone');
});

// ---- bin/tasks.mjs：父作者判断 158 行、子任务的子 issue 作者 178 行 ----

function closedChild({ number, author, parentNumber, parentAuthor, subIssues = [] }) {
  return issueNode({
    repo: REPO,
    number,
    author,
    state: 'CLOSED',
    closedAt: CHILD_CLOSED,
    body: 'child body',
    parent: { number: parentNumber, repository: { nameWithOwner: REPO }, author: parentAuthor },
    prs: [{ number: 40, url: 'https://example.test/pull/40', mergedAt: '2026-10-20T01:00:00.000Z', baseRefName: 'main' }],
    subIssues,
  });
}

test('SC6 父作者判断：父 issue 是名单里的 bot 建的按子任务算，名单外的人建的当根（tasks.mjs:158 / 178）', async () => {
  const botParent = issueNode({
    repo: REPO,
    number: 30,
    author: BOT,
    subIssues: [childNode({ repo: REPO, number: 31, author: OWNER, state: 'CLOSED' })],
  });
  const mineUnderBot = closedChild({
    number: 31,
    author: OWNER,
    parentNumber: 30,
    parentAuthor: authorOf(BOT, 'Bot'),
    subIssues: [
      childNode({ repo: REPO, number: 32, author: BOT, state: 'OPEN' }),
      childNode({ repo: REPO, number: 33, author: STRANGER, state: 'OPEN' }),
    ],
  });
  const strangerParent = issueNode({
    repo: REPO,
    number: 50,
    author: STRANGER,
    subIssues: [childNode({ repo: REPO, number: 51, author: OWNER, state: 'CLOSED' })],
  });
  const mineUnderStranger = closedChild({
    number: 51,
    author: OWNER,
    parentNumber: 50,
    parentAuthor: authorOf(STRANGER, 'User'),
  });
  const nodes = [botParent, strangerParent];
  const closed = [mineUnderBot, mineUnderStranger];

  // 父作者是名单里的 bot：158 行判「不是根」，走子任务路径（178 行只收名单里的 bot 建的孙 issue）
  const trusted = await tasksFrom(nodes, profileWith(), closed);
  const child = trusted.find((task) => task.ref === `${REPO}#31`);
  assert.ok(child, '父 issue 是名单里的 bot 时，我的子 issue 按子任务收');
  assert.equal(child.kind, 'child');
  assert.equal(child.parentRef, `${REPO}#30`);
  assert.deepEqual(child.children.map((entry) => entry.ref), [`${REPO}#32`], '178 行：孙 issue 只收名单里的 bot 建的');

  // 父作者是外部用户：158 行判「是根」，子 issue 自己成任务
  const mineRoot = trusted.find((task) => task.ref === `${REPO}#51`);
  assert.ok(mineRoot, '父是外部用户时我的子 issue 当根');
  assert.notEqual(mineRoot.kind, 'child');

  // 没配名单：bot 父作者也当外人 → 我的 issue 成根，不再算子任务
  const plain = await tasksFrom(nodes, profileWith([]), closed);
  const plainChild = plain.find((task) => task.ref === `${REPO}#31`);
  assert.ok(plainChild);
  assert.notEqual(plainChild.kind, 'child');
  assert.equal(plainChild.children.length, 0, '没配名单：名单里的 bot 建的孙 issue 也不收');
  assert.equal(plain.some((task) => task.ref === `${REPO}#30`), false, '没配名单：bot 建的父 issue 本身也不当任务');
});
