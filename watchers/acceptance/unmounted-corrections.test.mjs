import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithub } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion, collectTasks } from './bin/tasks.mjs';
import { shouldTrigger } from './bin/trigger.mjs';
import { REPO, childNode, createFakeRun, inventoryData, issueNode, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

// #402：修正子 issue 没挂到任务下（fork 档本来就不挂；非 fork 档在建单之后、挂载之前中断的孤儿）时，
// 触发层也要看见它：开着就等，验收结论之后关闭就开下一轮，不再一直 up-to-date。

const FORK_REPO = 'makecindy/cindy';
const BODY = 'standalone task body';
const VERDICT_AT = '2026-10-24T02:00:00.000Z';
const NOW = () => Date.parse('2026-10-26T00:00:00.000Z');
const marker = (item, round = 1) => `[验收机] 修正 · 总 ${item} · 项 ${item} SC3 · 第 ${round} 轮`;
const mergedPr = (number, repo = REPO) => ({ number, url: `https://github.com/${repo}/pull/${number}`, mergedAt: '2026-10-20T00:00:00.000Z',
  baseRefName: 'main', repository: { nameWithOwner: repo } });

function taskNode({ repo = REPO, number = 1, subIssues = [] } = {}) {
  return issueNode({
    repo, number, body: BODY, state: 'CLOSED', closedAt: '2026-10-21T00:00:00.000Z', subIssues,
    prs: [mergedPr(100 + number, repo)],
    comments: [roundComment({ round: 1, status: '要修', bodyVersion: bodyVersion(BODY), startedAt: '2026-10-24T01:00:00.000Z', finishedAt: VERDICT_AT })],
  });
}
function correctionNode({ repo = REPO, number = 9, item, state = 'CLOSED', closedAt = '2026-10-25T00:00:00.000Z' } = {}) {
  return issueNode({ repo, number, body: `> 修正子 issue\n\n${marker(item)}\n`, state, closedAt });
}

async function decide(nodes, ref) {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const open = nodes.filter((node) => node.state === 'OPEN');
  const closed = nodes.filter((node) => node.state !== 'OPEN');
  const github = createGithub({ profile, run: createFakeRun({ onGraphql: () => inventoryData({ open, closed }) }) });
  const tasks = await collectTasks(github, profile);
  const task = tasks.find((item) => item.ref === ref);
  assert.ok(task, `没有盘点出 ${ref}`);
  return { task, decision: shouldTrigger(task, { now: NOW, profile }) };
}

test('#402 SC1 SC3 非 fork 档孤儿：修正子已关闭、标记指向该任务、没挂上 → 开下一轮', async () => {
  const { task, decision } = await decide([taskNode(), correctionNode({ item: `${REPO}#1` })], `${REPO}#1`);
  assert.equal(task.kind, 'standalone', '没挂上，所以还是独立任务');
  assert.deepEqual(task.children, [], '不进这一轮要验的树');
  assert.deepEqual(task.unmountedCorrections.map((item) => item.ref), [`${REPO}#9`]);
  assert.deepEqual([decision.trigger, decision.reason], [true, 'children-closed-after-verdict']);
});

test('#402 SC2 fork 档：修正子开在别的仓、不挂到任务下，关闭后任务开下一轮', async () => {
  const { decision } = await decide([taskNode({ repo: FORK_REPO, number: 7 }), correctionNode({ repo: REPO, number: 11, item: `${FORK_REPO}#7` })], `${FORK_REPO}#7`);
  assert.deepEqual([decision.trigger, decision.reason], [true, 'children-closed-after-verdict']);
});

test('#402 修正子在验收结论之前就关了：不因它再开一轮', async () => {
  const { decision } = await decide([taskNode(), correctionNode({ item: `${REPO}#1`, closedAt: '2026-10-23T00:00:00.000Z' })], `${REPO}#1`);
  assert.equal(decision.reason, 'up-to-date');
});

test('#402 SC4 修正子还开着：没挂上的和挂着的一样都拦开轮', async () => {
  const unmounted = await decide([taskNode(), correctionNode({ item: `${REPO}#1`, state: 'OPEN', closedAt: null })], `${REPO}#1`);
  assert.deepEqual([unmounted.decision.trigger, unmounted.decision.reason], [false, 'children-open']);
  const mounted = await decide([taskNode({ subIssues: [childNode({ number: 9, state: 'OPEN', closedAt: null })] })], `${REPO}#1`);
  assert.deepEqual([mounted.decision.trigger, mounted.decision.reason], [false, 'children-open']);
});

test('#402 已经挂着的修正子不重复记；别人发的带标记 issue 不算', async () => {
  const mountedClosed = childNode({ number: 9, closedAt: '2026-10-25T00:00:00.000Z' });
  const { task } = await decide([taskNode({ subIssues: [mountedClosed] }), correctionNode({ item: `${REPO}#1` })], `${REPO}#1`);
  assert.equal(task.unmountedCorrections, undefined, '挂着的那条只在 children 里');
  const stranger = issueNode({ number: 12, body: marker(`${REPO}#1`), state: 'CLOSED', closedAt: '2026-10-25T00:00:00.000Z', author: 'someone-else' });
  const { decision } = await decide([taskNode(), stranger], `${REPO}#1`);
  assert.equal(decision.reason, 'up-to-date');
});
