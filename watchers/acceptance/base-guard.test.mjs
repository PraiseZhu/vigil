import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGithub } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { pollInventory } from './bin/poll.mjs';
import { EXIT, runRound } from './bin/round.mjs';
import { INVENTORY_QUERY, bodyVersion, collectTasks } from './bin/tasks.mjs';
import { mergedBaseDecision, shouldTrigger } from './bin/trigger.mjs';
import {
  OWNER,
  REPO,
  START_AT,
  childNode,
  createFakeRun,
  inventoryData,
  issueNode,
  pageInfo,
  roundComment,
  tmpDir,
  writeProfile,
} from './fake-gh.fixture.mjs';

// 「关联 PR 的目标分支不是默认分支就不验」的临时防护：盘点带上 baseRefName / defaultBranchRef，
// 触发判定里加一道 base-not-default / base-unknown，别的分支不出轮次、不开修正子单。

const NOW = () => Date.parse('2026-10-24T00:00:00.000Z');
const MERGED_AT = '2026-10-20T01:00:00.000Z';
const CLOSED_AT = '2026-10-20T00:00:00.000Z';

function profileWith(extra = {}) {
  const { home } = writeProfile(tmpDir(), extra);
  return { home, profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }) };
}

/** 模拟「字段没取到」：baseRefName 直接不出现在返回的节点里。 */
const NO_BASE = Symbol('no-base');

/** 盘点里的关联 PR 节点。`baseRefName` 传 NO_BASE 表示字段没取到（模拟老查询 / 被权限挡掉）。 */
function prNode(number, mergedAt = MERGED_AT, baseRefName = 'main', repo = REPO) {
  const node = {
    number,
    url: `https://example.test/pull/${number}`,
    mergedAt,
    repository: { nameWithOwner: repo },
  };
  if (baseRefName !== NO_BASE) node.baseRefName = baseRefName;
  return node;
}

async function tasksFrom(open, closed = [], extra = {}) {
  const { home, profile } = profileWith(extra);
  const run = createFakeRun({ onGraphql: () => inventoryData({ open, closed }) });
  const github = createGithub({ profile, run });
  const tasks = await collectTasks(github, profile);
  return { home, profile, run, tasks };
}

function taskOf(tasks, ref) {
  const found = tasks.find((task) => task.ref === ref);
  assert.ok(found, `没有盘点出 ${ref}`);
  return found;
}

// ── SC1 / SC2：目标分支是默认分支照常验，不是默认分支就不验 ──

test('SC1 合入默认分支的独立 issue 照常触发；合入集成分支的不触发，并说清是哪个 PR、合到哪', async () => {
  const onMain = issueNode({ number: 1, prs: [prNode(11)] });
  const onBranch = issueNode({ number: 2, prs: [prNode(12, MERGED_AT, 'integration/sample-feature')] });
  const { profile, tasks } = await tasksFrom([onMain, onBranch]);

  const good = shouldTrigger(taskOf(tasks, `${REPO}#1`), { now: NOW, profile });
  assert.deepEqual(good, { trigger: true, reason: 'no-verdict' });

  const blocked = shouldTrigger(taskOf(tasks, `${REPO}#2`), { now: NOW, profile });
  assert.equal(blocked.trigger, false);
  assert.equal(blocked.reason, 'base-not-default');
  assert.equal(blocked.base, 'integration/sample-feature');
  assert.equal(blocked.defaultBranch, 'main');
  assert.deepEqual(blocked.prs, [{ ref: `${REPO}#12`, base: 'integration/sample-feature' }]);
  assert.match(blocked.message, new RegExp(`${REPO}#12`), '说明里要有 PR');
  assert.match(blocked.message, /integration\/sample-feature/, '说明里要有 base');
  assert.match(blocked.message, /main/, '说明里要有默认分支');
});

test('SC1 已关闭子 issue 的 PR 合入集成分支时同样不触发（不开子单的轮次）', async () => {
  const parent = issueNode({ number: 1, subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: CLOSED_AT })] });
  const child = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CLOSED_AT,
    parent: { number: 1, repository: { nameWithOwner: REPO }, author: { login: OWNER } },
    prs: [prNode(20, MERGED_AT, 'integration/sample-feature')],
  });
  const { profile, tasks } = await tasksFrom([parent], [child]);
  const childTask = taskOf(tasks, `${REPO}#2`);
  assert.equal(childTask.kind, 'child');
  assert.equal(shouldTrigger(childTask, { now: NOW, profile }).reason, 'base-not-default');
});

// ── SC2：多个 PR 混合 —— 只看「有没有一个合入默认分支的 PR」 ──

test('SC2 多个已合并 PR 里有一个合入默认分支就照常验；全是非默认分支才跳过', async () => {
  const mixed = [
    { ref: `${REPO}#21`, mergedAt: MERGED_AT, base: 'main' },
    { ref: `${REPO}#22`, mergedAt: MERGED_AT, base: 'integration/sample-feature' },
  ];
  assert.deepEqual(mergedBaseDecision(mixed, 'main'), { ok: true });

  const allBranch = [
    { ref: `${REPO}#21`, mergedAt: MERGED_AT, base: 'integration/sample-feature' },
    { ref: `${REPO}#22`, mergedAt: MERGED_AT, base: 'release/next' },
  ];
  const decision = mergedBaseDecision(allBranch, 'main');
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'base-not-default');
  assert.equal(decision.base, 'integration/sample-feature、release/next');

  const issue = issueNode({ number: 3, prs: [prNode(30), prNode(31, MERGED_AT, 'integration/sample-feature')] });
  const { profile, tasks } = await tasksFrom([issue]);
  assert.deepEqual(shouldTrigger(taskOf(tasks, `${REPO}#3`), { now: NOW, profile }), {
    trigger: true,
    reason: 'no-verdict',
  });
});

// ── SC2：baseRefName 字段缺失 → 保守跳过 ──

test('SC2 baseRefName 取不到时保守跳过（base-unknown），说明里写明不知道是不是默认分支', async () => {
  const noBase = issueNode({ number: 4, prs: [prNode(40, MERGED_AT, NO_BASE)] });
  const { profile, tasks } = await tasksFrom([noBase]);
  const decision = shouldTrigger(taskOf(tasks, `${REPO}#4`), { now: NOW, profile });
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, 'base-unknown');
  assert.equal(decision.base, null);
  assert.deepEqual(decision.prs, [{ ref: `${REPO}#40`, base: null }]);
  assert.match(decision.message, /没取到目标分支/);
});

// ── SC2：默认分支不叫 main 的仓 ──

test('SC2 默认分支叫 trunk 的仓：合到 trunk 照常验，合到 main 才跳过', async () => {
  const otherRepo = 'example-owner/trunk-repo';
  const onTrunk = issueNode({
    repo: otherRepo,
    number: 5,
    defaultBranch: 'trunk',
    prs: [prNode(50, MERGED_AT, 'trunk', otherRepo)],
  });
  const onMain = issueNode({
    repo: otherRepo,
    number: 6,
    defaultBranch: 'trunk',
    prs: [prNode(60, MERGED_AT, 'main', otherRepo)],
  });
  const { profile, tasks } = await tasksFrom([onTrunk, onMain], [], {
    profile: { autoRepos: [`${OWNER}/*`, otherRepo, REPO] },
  });
  const good = shouldTrigger(taskOf(tasks, `${otherRepo}#5`), { now: NOW, profile });
  assert.equal(good.trigger, true);
  const blocked = shouldTrigger(taskOf(tasks, `${otherRepo}#6`), { now: NOW, profile });
  assert.equal(blocked.reason, 'base-not-default');
  assert.equal(blocked.defaultBranch, 'trunk');
  assert.match(blocked.message, /trunk/);
});

test('SC2 默认分支字段取不到时才退回 main', async () => {
  const noDefault = issueNode({ number: 7, defaultBranch: null, prs: [prNode(70)] });
  const { profile, tasks } = await tasksFrom([noDefault]);
  const task = taskOf(tasks, `${REPO}#7`);
  assert.equal(task.defaultBranch, 'main');
  assert.deepEqual(shouldTrigger(task, { now: NOW, profile }), { trigger: true, reason: 'no-verdict' });
});

// ── SC3：父单 ──

test('SC3 子单的 PR 合入集成分支时父单不触发；数据来自同一份盘点，不额外发请求', async () => {
  const parent = issueNode({
    number: 1,
    subIssues: [
      childNode({ number: 2, state: 'CLOSED', closedAt: CLOSED_AT }),
      childNode({ number: 3, state: 'CLOSED', closedAt: CLOSED_AT }),
    ],
  });
  const branchChild = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CLOSED_AT,
    parent: { number: 1, repository: { nameWithOwner: REPO }, author: { login: OWNER } },
    prs: [prNode(20, MERGED_AT, 'integration/sample-feature')],
  });
  const mainChild = issueNode({
    number: 3,
    state: 'CLOSED',
    closedAt: CLOSED_AT,
    parent: { number: 1, repository: { nameWithOwner: REPO }, author: { login: OWNER } },
    prs: [prNode(30)],
  });
  const { run, profile, tasks } = await tasksFrom([parent], [branchChild, mainChild]);
  assert.equal(run.calls.length, 1, '父单的 PR 目标分支来自同一份盘点，不额外发请求');
  const decision = shouldTrigger(taskOf(tasks, `${REPO}#1`), { now: NOW, profile });
  assert.equal(decision.trigger, false);
  assert.equal(decision.reason, 'base-not-default');
  assert.equal(decision.child, `${REPO}#2`, '说明里点出是哪个子单');
  assert.equal(decision.base, 'integration/sample-feature');
});

test('SC3 子单的 PR 都合入默认分支时父单照常触发', async () => {
  const parent = issueNode({ number: 1, subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: CLOSED_AT })] });
  const child = issueNode({
    number: 2,
    state: 'CLOSED',
    closedAt: CLOSED_AT,
    parent: { number: 1, repository: { nameWithOwner: REPO }, author: { login: OWNER } },
    prs: [prNode(20)],
  });
  const { profile, tasks } = await tasksFrom([parent], [child]);
  assert.deepEqual(shouldTrigger(taskOf(tasks, `${REPO}#1`), { now: NOW, profile }), {
    trigger: true,
    reason: 'no-verdict',
  });
});

test('SC3 盘点里没有这个子单的 PR 数据时父单不拦（老子单不能因此永久卡住）', async () => {
  const parent = issueNode({
    number: 1,
    subIssues: [
      childNode({ number: 2, state: 'CLOSED', closedAt: CLOSED_AT }),
      childNode({ number: 3, state: 'CLOSED', closedAt: CLOSED_AT }),
    ],
  });
  // 子单 #2 早于 startAt 关闭，不在这一次盘点里；#3 合入默认分支。
  const child = issueNode({
    number: 3,
    state: 'CLOSED',
    closedAt: CLOSED_AT,
    parent: { number: 1, repository: { nameWithOwner: REPO }, author: { login: OWNER } },
    prs: [prNode(30)],
  });
  const { profile, tasks } = await tasksFrom([parent], [child]);
  const parentTask = taskOf(tasks, `${REPO}#1`);
  assert.equal(parentTask.children.find((c) => c.ref === `${REPO}#2`).prBase, null);
  assert.deepEqual(shouldTrigger(parentTask, { now: NOW, profile }), { trigger: true, reason: 'no-verdict' });
});

// ── SC4：已有轮次记录的任务不受影响 ──

test('SC4 已有结论、之后没有新合并的任务仍是 up-to-date；结论后合入默认分支的 PR 仍照常再验一轮', async () => {
  const verdict = roundComment({
    round: 1,
    status: '通过',
    bodyVersion: bodyVersion('task'),
    createdAt: '2026-10-22T00:00:00.000Z',
    finishedAt: '2026-10-22T01:00:00.000Z',
  });
  const closed = { state: 'CLOSED', closedAt: '2026-10-22T02:00:00.000Z' };
  const settled = issueNode({ number: 8, body: 'task', prs: [prNode(80, '2026-10-21T00:00:00.000Z')], comments: [verdict], ...closed });
  const reopened = issueNode({ number: 9, body: 'task', prs: [prNode(90, '2026-10-23T00:00:00.000Z')], comments: [verdict], ...closed });
  const { profile, tasks } = await tasksFrom([settled, reopened]);
  assert.deepEqual(shouldTrigger(taskOf(tasks, `${REPO}#8`), { now: NOW, profile }), {
    trigger: false,
    reason: 'up-to-date',
  });
  assert.deepEqual(shouldTrigger(taskOf(tasks, `${REPO}#9`), { now: NOW, profile }), {
    trigger: true,
    reason: 'pr-merged-after-verdict',
  });
});

test('SC4 已有结论但之后只有集成分支的合并：不再重开轮次（要修的复验也停在这里，日志里能查到）', async () => {
  const verdict = roundComment({
    round: 1,
    status: '要修',
    bodyVersion: bodyVersion('task'),
    createdAt: '2026-10-22T00:00:00.000Z',
    finishedAt: '2026-10-22T01:00:00.000Z',
  });
  const issue = issueNode({
    number: 10,
    body: 'task',
    prs: [prNode(100, '2026-10-23T00:00:00.000Z', 'integration/sample-feature')],
    comments: [verdict],
  });
  const { profile, tasks } = await tasksFrom([issue]);
  assert.equal(shouldTrigger(taskOf(tasks, `${REPO}#10`), { now: NOW, profile }).reason, 'base-not-default');
});

// ── SC5：盘点不新增请求（点数不变），查询里确实带上了两个新字段 ──

test('SC5 盘点查询带上 baseRefName 与 defaultBranchRef（都是标量/单对象，不新增 connection）', () => {
  assert.match(INVENTORY_QUERY, /closedByPullRequestsReferences\(first: 10, includeClosedPrs: true\)\s*\{\s*nodes\s*\{[^}]*baseRefName/);
  assert.match(INVENTORY_QUERY, /repository \{ nameWithOwner defaultBranchRef \{ name \} \}/);
  assert.equal((INVENTORY_QUERY.match(/connection/gi) || []).length, 0);
});

test('SC5 每拍的盘点请求数只随页数增长：1 页 1 次、2 页 2 次，与加字段前一致', async () => {
  const onePage = issueNode({ number: 11, prs: [prNode(110)] });
  const { profile: p1 } = profileWith();
  const runOne = createFakeRun({ onGraphql: () => inventoryData({ open: [onePage] }) });
  const one = await pollInventory({ github: createGithub({ profile: p1, run: runOne }), profile: p1, now: NOW, loopLog: false });
  assert.equal(one.reads, 1);
  assert.equal(runOne.calls.length, 1);

  const first = issueNode({ number: 12, prs: [prNode(120, MERGED_AT, 'integration/sample-feature')] });
  const second = issueNode({ number: 13, prs: [prNode(130)] });
  const { profile: p2 } = profileWith();
  const runTwo = createFakeRun({
    onGraphql: (payload) => {
      if (!payload.variables.openAfter) return inventoryData({ open: [first], openPage: pageInfo(true, 'open-cursor-1') });
      return inventoryData({ open: [second], openPage: pageInfo(false, null) });
    },
  });
  const two = await pollInventory({ github: createGithub({ profile: p2, run: runTwo }), profile: p2, now: NOW, loopLog: false });
  assert.equal(two.reads, 2, '两页盘点两次只读请求');
  assert.equal(runTwo.calls.length, 2);
  // 两页合起来：一个合入默认分支、一个合入集成分支。
  assert.deepEqual(two.entries.map((entry) => entry.issue).sort(), [`${REPO}#13`]);
  assert.deepEqual(two.baseSkipped.map((entry) => entry.issue), [`${REPO}#12`]);
});

// ── SC6：poll 的可见性（本地 loop.log 一行，不发通知、不写 GitHub） ──

test('SC6 poll 把 base-not-default / base-unknown 各记一行 loop.log，且不进 entries、不写 GitHub', async () => {
  const onBranch = issueNode({ number: 14, prs: [prNode(140, MERGED_AT, 'integration/sample-feature')] });
  const unknownBase = issueNode({ number: 15, prs: [prNode(150, MERGED_AT, NO_BASE)] });
  const onMain = issueNode({ number: 16, prs: [prNode(160)] });
  const { home, profile } = profileWith();
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [onBranch, unknownBase, onMain] }) });
  const result = await pollInventory({ github: createGithub({ profile, run }), profile, now: NOW });

  assert.deepEqual(result.entries.map((entry) => entry.issue), [`${REPO}#16`]);
  assert.deepEqual(result.baseSkipped.map((entry) => entry.issue).sort(), [`${REPO}#14`, `${REPO}#15`]);
  assert.deepEqual(result.baseSkipped.map((entry) => entry.reason).sort(), ['base-not-default', 'base-unknown']);

  const log = fs.readFileSync(path.join(home, 'state', 'host', 'loop.log'), 'utf8').trim().split('\n');
  // 认领排序（#62）在同一份 loop.log 里可能多一行 queue-priority-fallback（本夹具没有看板快照）。
  // 本用例只断言 base-not-default / base-unknown 各一行，不把「文件里只有这两行」当成约定。
  const baseLines = log.filter((line) => / base-(?:not-default|unknown) /.test(line));
  assert.equal(baseLines.length, 2, `loop.log 里 base-not-default / base-unknown 应各一行，实际：${log.join(' | ')}`);
  assert.match(baseLines[0], /^\d{4}-\d\d-\d\dT[\d:.]+Z base-not-default issue=example-owner\/example-repo#14 /);
  assert.match(baseLines[0], /base=integration\/sample-feature/);
  assert.match(baseLines[0], new RegExp(`prs=${REPO}#140@integration/sample-feature`));
  assert.match(baseLines[1], /base-unknown issue=example-owner\/example-repo#15 /);
  assert.match(baseLines[1], /base=unknown/);
  // 只读：没有任何写调用（gh api / 非 graphql 的 gh）
  assert.deepEqual(run.calls.filter((call) => call.cmd !== 'gh' || !call.args.includes('graphql')), []);
});

// ── SC7：手动 start 也不认领 ──

async function runStart(issue) {
  const { home, profile } = profileWith();
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [issue] }) });
  const github = createGithub({ profile, run });
  let stdout = '';
  let stderr = '';
  const code = await runRound(['start', '--issue', `${REPO}#${issue.number}`], {
    github,
    profile,
    now: NOW,
    stdout: { write: (chunk) => { stdout += chunk; return true; } },
    stderr: { write: (chunk) => { stderr += chunk; return true; } },
  });
  return { home, code, stdout, stderr, run };
}

test('SC7 bin/round.mjs start 遇到 base-not-default 返回「没事可做」并说清原因，不写评论', async () => {
  const onBranch = issueNode({ number: 17, prs: [prNode(170, MERGED_AT, 'integration/sample-feature')] });
  const result = await runStart(onBranch);
  assert.equal(result.code, EXIT.NOTHING);
  assert.match(result.stderr, /base-not-default/);
  assert.match(result.stderr, /integration\/sample-feature/);
  assert.match(result.stderr, /main/);
  assert.equal(result.stdout, '');
  assert.deepEqual(result.run.calls.filter((call) => call.cmd !== 'gh' || !call.args.includes('graphql')), []);
});

// ── 回归：其它不触发原因不受影响 ──

test('回归：没有已合并 PR 的任务仍是 no-merged-pr（base 判定不抢这个原因）', async () => {
  const noPr = issueNode({ number: 18, prs: [] });
  const unmerged = issueNode({ number: 19, prs: [prNode(190, null, 'integration/sample-feature')] });
  const { profile, tasks } = await tasksFrom([noPr, unmerged]);
  for (const ref of [`${REPO}#18`, `${REPO}#19`]) {
    assert.deepEqual(shouldTrigger(taskOf(tasks, ref), { now: NOW, profile }), {
      trigger: false,
      reason: 'no-merged-pr',
    });
  }
});
