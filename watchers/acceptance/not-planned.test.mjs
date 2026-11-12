import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithub } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { INVENTORY_QUERY, collectTasks } from './bin/tasks.mjs';
import { REPO, childNode, createFakeRun, inventoryData, issueNode, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

// 按「不计划做」或「重复」关掉的 issue 是人决定不做了，不进验收：2026-11-12 一批 P3 按「不计划做」关掉后，
// 验收机把其中的总 issue 当成做完去验，验不过又开了 6 张修正子 issue，prbot 还会去改这些定了不做的事。

const mergedPr = (number) => ({ number, url: `https://github.com/${REPO}/pull/${number}`, mergedAt: '2026-10-20T00:00:00.000Z',
  baseRefName: 'main', repository: { nameWithOwner: REPO } });
const closed = (extra) => issueNode({ state: 'CLOSED', closedAt: '2026-10-21T00:00:00.000Z', prs: [mergedPr(100 + (extra.number || 1))], ...extra });

async function refsOf(nodes) {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const run = createFakeRun({ onGraphql: () => inventoryData({ closed: nodes }) });
  const tasks = await collectTasks(createGithub({ profile, run }), profile);
  return { refs: tasks.map((task) => task.ref).sort(), calls: run.calls.length };
}

test('盘点查询带上关闭原因（标量，不新增 connection）', () => {
  assert.match(INVENTORY_QUERY, /\bstate\s+stateReason\b/);
  assert.equal((INVENTORY_QUERY.match(/connection/gi) || []).length, 0);
});

test('按「不计划做」「重复」关掉的不进验收；做完关掉的、老数据没有关闭原因的照旧进', async () => {
  const nodes = [
    { ...closed({ number: 1 }), stateReason: 'NOT_PLANNED' },
    { ...closed({ number: 2 }), stateReason: 'DUPLICATE' },
    { ...closed({ number: 3 }), stateReason: 'COMPLETED' },
    closed({ number: 4 }),
  ];
  const { refs, calls } = await refsOf(nodes);
  assert.deepEqual(refs, [`${REPO}#3`, `${REPO}#4`]);
  assert.equal(calls, 1, '不新增请求');
});

test('按「不计划做」关掉的总 issue（子 issue 都关了）也不进验收', async () => {
  const parent = { ...closed({ number: 5, subIssues: [childNode({ number: 6 })] }), stateReason: 'NOT_PLANNED' };
  const child = { ...closed({ number: 6, parent: { number: 5, repository: { nameWithOwner: REPO }, author: { login: 'ExampleUser', __typename: 'User' } } }), stateReason: 'NOT_PLANNED' };
  const { refs } = await refsOf([parent, child]);
  assert.deepEqual(refs, []);
});
