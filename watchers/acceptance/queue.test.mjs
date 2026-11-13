// #62 认领队列排序：纯函数 + 一拍盘点的顺序。优先级读本地看板快照，不新增 GraphQL 读。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createGithub } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { orderForClaim, poll, pollInventory } from './bin/poll.mjs';
import { normalizePriority, priorityRank, priorityMapFromItems, readQueuePriorities, sortTaskQueue } from './bin/queue.mjs';
import { hostPaths } from './host/paths.mjs';
import { writeBoardSnapshot } from './bin/rate-budget.mjs';
import { REPO, createFakeRun, inventoryData, issueNode, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const NOW = Date.parse('2026-11-01T12:00:00.000Z');

function task(ref, createdAt, extra = {}) {
  const [repo, number] = ref.split('#');
  return { ref, repo, number: Number(number), kind: 'standalone', createdAt, ...extra };
}

function refs(tasks) {
  return tasks.map((item) => item.ref);
}

function prioritySource(entries, reason = '') {
  return { byRef: new Map(Object.entries(entries)), reason };
}

test('#62 SC1 认不出的看板值都按 P2 算；P0..P3 认得出', () => {
  assert.equal(normalizePriority('P0'), 'P0');
  assert.equal(normalizePriority(' p3 '), 'P3');
  for (const value of [null, undefined, '', '  ', 'P4', 'p1x', 'high', 1, {}, []]) {
    assert.equal(normalizePriority(value), null, `认不出的值：${JSON.stringify(value)}`);
  }
  assert.equal(priorityRank(null), 2, '没有优先级当 P2');
  assert.equal(priorityRank('high'), 2, '认不出的值当 P2');
  assert.equal(priorityRank('P0'), 0);
});

test('#62 SC1 无优先级（=P2）排在 P1 后、P3 前', () => {
  const tasks = [
    task(`${REPO}#3`, '2026-10-03T00:00:00.000Z'),
    task(`${REPO}#1`, '2026-10-01T00:00:00.000Z'),
    task(`${REPO}#2`, '2026-10-02T00:00:00.000Z'),
  ];
  const priorityOf = (item) => ({ [`${REPO}#1`]: 'P1', [`${REPO}#2`]: 'P3' })[item.ref] ?? null;
  assert.deepEqual(refs(sortTaskQueue(tasks, { priorityOf })), [`${REPO}#1`, `${REPO}#3`, `${REPO}#2`]);
});

test('#62 SC1 混合 P0~P3 与未知识别：未知值按 P2，档内按 createdAt 旧的先', () => {
  const tasks = [
    task(`${REPO}#10`, '2026-10-10T00:00:00.000Z'),
    task(`${REPO}#11`, '2026-10-09T00:00:00.000Z'),
    task(`${REPO}#12`, '2026-10-08T00:00:00.000Z'),
    task(`${REPO}#13`, '2026-10-07T00:00:00.000Z'),
    task(`${REPO}#14`, '2026-10-06T00:00:00.000Z'),
    task(`${REPO}#15`, '2026-10-05T00:00:00.000Z'),
    task(`${REPO}#16`, '2026-10-04T00:00:00.000Z'),
  ];
  const priorityOf = (item) => ({
    [`${REPO}#10`]: 'P3',
    [`${REPO}#11`]: 'P0',
    [`${REPO}#12`]: 'P2',
    [`${REPO}#13`]: 'P9', // 认不出 → P2
    [`${REPO}#14`]: 'P1',
    [`${REPO}#15`]: null, // 空 → P2
    [`${REPO}#16`]: 'urgent', // 认不出 → P2
  })[item.ref];
  assert.deepEqual(refs(sortTaskQueue(tasks, { priorityOf })), [
    `${REPO}#11`, // P0
    `${REPO}#14`, // P1
    `${REPO}#16`, // P2，建得最早（10-04）
    `${REPO}#15`, // P2，10-05
    `${REPO}#13`, // P2，10-06
    `${REPO}#12`, // P2，10-07
    `${REPO}#10`, // P3
  ]);
});

test('#62 SC1 同档同创建时间：按 repo+号升序，顺序不随输入顺序变', () => {
  const at = '2026-10-01T00:00:00.000Z';
  const forward = [task(`${REPO}#7`, at), task(`${REPO}#5`, at), task(`${REPO}#6`, at)];
  const backward = [task(`${REPO}#6`, at), task(`${REPO}#5`, at), task(`${REPO}#7`, at)];
  const priorityOf = () => null;
  assert.deepEqual(refs(sortTaskQueue(forward, { priorityOf })), [`${REPO}#5`, `${REPO}#6`, `${REPO}#7`]);
  assert.deepEqual(refs(sortTaskQueue(backward, { priorityOf })), [`${REPO}#5`, `${REPO}#6`, `${REPO}#7`]);
});

test('#62 SC1 创建时间读不到排在同档最后，不顶到最前', () => {
  const tasks = [task(`${REPO}#1`, null), task(`${REPO}#2`, '2026-10-09T00:00:00.000Z')];
  assert.deepEqual(refs(sortTaskQueue(tasks, { priorityOf: () => 'P2' })), [`${REPO}#2`, `${REPO}#1`]);
});

test('#62 SC2 快照条目 → 优先级表；不在看板上的任务给不出值', () => {
  const map = priorityMapFromItems([
    { repo: REPO, number: 3, priority: 'P0' },
    { repo: REPO, number: 4, priority: null },
    { repo: '', number: 5, priority: 'P1' },
    { repo: REPO, number: 0, priority: 'P1' },
  ]);
  assert.equal(map.get(`${REPO}#3`), 'P0');
  assert.equal(map.get(`${REPO}#4`), null);
  assert.equal(map.has(`${REPO}#5`), false, '拿不到仓名的条目不算一条优先级');
});

test('#62 SC2 新鲜快照直接用；过期 / 坏掉 / 缺失都算读不到，并按 P2 排且记一行日志', () => {
  const { home } = writeProfile(tmpDir());
  const paths = hostPaths(home);
  const tasks = [task(`${REPO}#1`, '2026-10-01T00:00:00.000Z'), task(`${REPO}#2`, '2026-10-02T00:00:00.000Z')];

  // 缺失：目录都还没有。
  const lines = [];
  const missing = orderForClaim(tasks, { home, now: () => NOW, log: (text) => lines.push(text) });
  assert.deepEqual(refs(missing), [`${REPO}#1`, `${REPO}#2`]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /queue-priority-fallback reason=missing/);

  // 新鲜：按优先级排，不记日志。
  writeBoardSnapshot(paths.boardSnapshot, {
    at: NOW - 30 * 1000,
    items: [
      { repo: REPO, number: 1, priority: 'P3' },
      { repo: REPO, number: 2, priority: 'P0' },
    ],
  });
  const fresh = readQueuePriorities({ home, now: () => NOW });
  assert.equal(fresh.reason, '');
  const freshLines = [];
  const sorted = orderForClaim(tasks, { home, now: () => NOW, log: (text) => freshLines.push(text) });
  assert.deepEqual(refs(sorted), [`${REPO}#2`, `${REPO}#1`]);
  assert.deepEqual(freshLines, [], '读得到就不记降级日志');

  // 过期（超过一个拍间隔）：整份不用，回到 P2 + createdAt。
  const staleLines = [];
  const later = NOW + 181 * 1000;
  const staleSorted = orderForClaim(tasks, { home, now: () => later, log: (text) => staleLines.push(text) });
  assert.deepEqual(refs(staleSorted), [`${REPO}#1`, `${REPO}#2`]);
  assert.equal(staleSorted.length, 2, '读不到不影响条目数量');
  assert.match(staleLines[0], /queue-priority-fallback reason=stale/);

  // 坏文件：算读不到，不抛。
  fs.writeFileSync(paths.boardSnapshot, '{not json');
  const brokenLines = [];
  const broken = orderForClaim(tasks, { home, now: () => NOW, log: (text) => brokenLines.push(text) });
  assert.deepEqual(refs(broken), [`${REPO}#1`, `${REPO}#2`]);
  assert.match(brokenLines[0], /queue-priority-fallback reason=corrupt/);
});

test('#62 SC2 看板值认不出：按 P2 排并记一行带 ref 的日志', () => {
  const lines = [];
  const tasks = [task(`${REPO}#1`, '2026-10-01T00:00:00.000Z'), task(`${REPO}#2`, '2026-10-02T00:00:00.000Z')];
  const sorted = orderForClaim(tasks, {
    home: '/nonexistent-home',
    now: () => NOW,
    priorities: prioritySource({ [`${REPO}#2`]: 'P1', [`${REPO}#1`]: 'P9' }),
    log: (text) => lines.push(text),
  });
  assert.deepEqual(refs(sorted), [`${REPO}#2`, `${REPO}#1`]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /reason=unrecognized tasks=1/);
  assert.match(lines[0], new RegExp(`${REPO}#1=P9`));
});

test('#62 SC3 一拍盘点：认领条目按优先级排，且不新增 GraphQL 读', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const mergedPr = (number) => [{ number: 90 + number, url: `https://github.com/${REPO}/pull/${90 + number}`, mergedAt: '2026-10-20T00:00:00.000Z', baseRefName: 'main', repository: { nameWithOwner: REPO } }];
  const nodes = [
    issueNode({ number: 1, createdAt: '2026-10-03T00:00:00.000Z', prs: mergedPr(1) }),
    issueNode({ number: 2, createdAt: '2026-10-02T00:00:00.000Z', prs: mergedPr(2) }),
    issueNode({ number: 3, createdAt: '2026-10-01T00:00:00.000Z', prs: mergedPr(3) }),
  ];
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: nodes }) });
  const github = createGithub({ profile, run });
  const priorities = prioritySource({
    [`${REPO}#1`]: 'P0',
    [`${REPO}#2`]: 'P3',
    // #3 不在看板上 → P2
  });
  const { entries, tasks, reads } = await pollInventory({
    github,
    profile,
    now: () => Date.parse('2026-10-24T00:00:00.000Z'),
    priorities,
    queueLog: () => {},
  });
  assert.deepEqual(entries.map((entry) => entry.issue), [`${REPO}#1`, `${REPO}#3`, `${REPO}#2`]);
  assert.deepEqual(tasks.map((item) => item.ref), [`${REPO}#1`, `${REPO}#3`, `${REPO}#2`], '任务清单同一份顺序');
  const graphqlCalls = run.calls.filter((call) => call.args.includes('graphql')).length;
  assert.equal(readCount(reads), graphqlCalls, '排序不额外发读请求');
});

test('#62 SC5 多页盘点：只读请求数仍等于盘点页数（点数 = 页数 × 6，与改前一致）', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const PAGE = 100;
  const PAGES = 3;
  const nodesOf = (page) => {
    const nodes = [];
    for (let i = 0; i < PAGE; i += 1) {
      const number = page * PAGE + i + 1;
      nodes.push(
        issueNode({
          number,
          createdAt: '2026-10-01T00:00:00.000Z',
          prs: [
            {
              number: 5000 + number,
              url: `https://github.com/${REPO}/pull/${5000 + number}`,
              mergedAt: '2026-10-20T00:00:00.000Z',
              baseRefName: 'main',
              repository: { nameWithOwner: REPO },
            },
          ],
        }),
      );
    }
    return nodes;
  };
  const run = createFakeRun({
    onGraphql: (payload) => {
      const page = payload.variables?.openAfter ? Number(payload.variables.openAfter) : 0;
      const last = page + 1 >= PAGES;
      return {
        user: {
          open: { nodes: nodesOf(page), pageInfo: { hasNextPage: !last, endCursor: last ? null : String(page + 1) } },
          closed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      };
    },
  });
  const github = createGithub({ profile, run });
  // 优先级表整份塞满，确认读表不额外发请求、排序也不发请求。
  const priorities = prioritySource(
    Object.fromEntries(Array.from({ length: PAGE * PAGES }, (_, index) => [`${REPO}#${index + 1}`, ['P3', 'P0', 'P1', 'P2'][index % 4]])),
  );
  const { entries, reads } = await pollInventory({
    github,
    profile,
    now: () => Date.parse('2026-10-24T00:00:00.000Z'),
    priorities,
    queueLog: () => {},
  });
  const graphqlCalls = run.calls.filter((call) => call.args.includes('graphql')).length;
  assert.equal(entries.length, PAGE * PAGES);
  assert.equal(reads, PAGES, `只读请求数 = 盘点页数（${PAGES}）`);
  assert.equal(graphqlCalls, PAGES, '假 gh 实际收到的 graphql 调用数也等于页数');
  assert.equal(run.calls.length - graphqlCalls, 0, '没有别的请求（看板快照是本地文件读）');
  assert.equal(reads * 6, PAGES * 6, '点数按 tick 的口径算仍是页数 × 6，与改前相同');
  // 排序生效：300 条按档位单调不减（P0 全在 P1 前，P1 全在 P2 前……），同档内 createdAt 相同故按 ref 升序。
  // 夹具里第 n 条的档位：priorityRank 与 sortTaskQueue 用的是同一个函数。
  const rankOfNumber = (number) => priorityRank(['P3', 'P0', 'P1', 'P2'][(number - 1) % 4]);
  const ranks = entries.map((entry) => rankOfNumber(Number(entry.issue.split('#')[1])));
  assert.deepEqual([...ranks].sort((left, right) => left - right), ranks, '档位顺序单调不减');
});

test('#62 SC3 poll 只用本地快照：快照新鲜时按优先级出条目', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  writeBoardSnapshot(hostPaths(home).boardSnapshot, {
    at: NOW - 10 * 1000,
    items: [
      { repo: REPO, number: 1, priority: 'P3' },
      { repo: REPO, number: 2, priority: 'P0' },
    ],
  });
  const run = createFakeRun({
    onGraphql: () =>
      inventoryData({
        open: [
          issueNode({
            number: 1,
            createdAt: '2026-10-01T00:00:00.000Z',
            prs: [{ number: 91, url: `https://github.com/${REPO}/pull/91`, mergedAt: '2026-10-20T00:00:00.000Z', baseRefName: 'main', repository: { nameWithOwner: REPO } }],
          }),
          issueNode({
            number: 2,
            createdAt: '2026-10-02T00:00:00.000Z',
            prs: [{ number: 92, url: `https://github.com/${REPO}/pull/92`, mergedAt: '2026-10-20T00:00:00.000Z', baseRefName: 'main', repository: { nameWithOwner: REPO } }],
          }),
        ],
      }),
  });
  const github = createGithub({ profile, run });
  const entries = await poll({ github, profile, now: () => NOW });
  assert.deepEqual(entries.map((entry) => entry.issue), [`${REPO}#2`, `${REPO}#1`]);
});

function readCount(reads) {
  assert.equal(Number.isInteger(reads), true, 'reads 必须是整数');
  return reads;
}
