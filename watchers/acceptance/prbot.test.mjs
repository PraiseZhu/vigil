// #60 修正轮：事件接口、发现、停止条件、盯 CI 空转、Ready 后 24 小时、清理、一次完整跑通。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion } from './bin/rounds.mjs';
import { hostPaths } from './host/paths.mjs';
import { appendPrbotEvent, readPrbotEvents } from './host/prbot-events.mjs';
import {
  MAX_REFIX,
  READY_STALL_MS,
  checkReadyStalled,
  cleanupWorktrees,
  correctionBranch,
  discoverCorrections,
  matchesForbidden,
  parseCorrectionRounds,
  pollDraft,
  runPrbotCorrection,
  stopReason,
} from './host/prbot.mjs';
import { PR_BY_BRANCH_QUERY, PR_STATUS_QUERY } from './host/write-gate.mjs';
import { runTick } from './host/tick.mjs';
import { createFakeGithub, createWorld, defaultTree } from './session.fixture.mjs';
import { clock, OWNER, REPO, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const CORRECTION_REF = `${REPO}#9`;
const CORRECTION_MARKER = `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC3 · 第 1 轮`;

function addCorrection(world) {
  const correction = world.addIssue({
    repo: REPO,
    number: 9,
    title: '修正：子任务 SC3',
    body: ['> 修正子 issue', '', CORRECTION_MARKER].join('\n'),
  });
  world.addChild(`${REPO}#1`, correction.ref);
  return correction;
}

// 收录盘任务树：把假 world 里的 issue 变成 INVENTORY_QUERY 需要的节点。
function inventoryNode(world, ref) {
  const issue = world.requireIssue(ref);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    url: issue.url,
    createdAt: issue.createdAt,
    closedAt: issue.closedAt,
    updatedAt: issue.createdAt,
    author: { login: issue.author },
    repository: { nameWithOwner: issue.repo },
    parent: issue.parent
      ? { number: world.requireIssue(issue.parent).number, repository: { nameWithOwner: issue.repo }, author: { login: OWNER } }
      : null,
    subIssues: {
      nodes: issue.subIssues.map((childRef) => ({
        number: world.requireIssue(childRef).number,
        title: world.requireIssue(childRef).title,
        state: world.requireIssue(childRef).state === 'closed' ? 'CLOSED' : 'OPEN',
        url: world.requireIssue(childRef).url,
        closedAt: world.requireIssue(childRef).closedAt,
        author: { login: OWNER },
        repository: { nameWithOwner: world.requireIssue(childRef).repo },
      })),
    },
    closedByPullRequestsReferences: { nodes: [] },
    comments: {
      nodes: issue.comments.map((comment) => ({
        id: comment.id,
        databaseId: comment.databaseId,
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
        author: { login: comment.author.login },
      })),
    },
  };
}

test('SC11 事件接口：六种 type、补 at、脱敏、目录 700 文件 600，读回坏行跳过', () => {
  const { home } = writeProfile(tmpDir());
  const paths = hostPaths(home);
  const now = () => Date.parse('2026-10-24T03:00:00.000Z');
  appendPrbotEvent(
    paths,
    { type: 'claimed', issue: CORRECTION_REF, root: `${REPO}#1`, detail: `Bearer not-a-real-token ${home}` },
    { now },
  );
  appendPrbotEvent(paths, { type: 'ready', issue: CORRECTION_REF, pr: 12 }, { now });
  assert.throws(() => appendPrbotEvent(paths, { type: 'pr.merge' }, { now }), /未知的修正轮事件类型/);

  fs.appendFileSync(paths.prbotEventsFile, 'not-json\n');
  const events = readPrbotEvents(paths);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'claimed');
  assert.equal(events[0].at, '2026-10-24T03:00:00.000Z');
  assert.equal(events[0].detail.includes('not-a-real-token'), false);
  assert.equal(events[0].detail.includes(home), false);
  assert.equal(fs.statSync(paths.prbotEventsFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.prbotDir).mode & 0o777, 0o700);
});

test('SC1 发现：只认 auto 档、自己发的「要修」裁决、修正标记对得上的开着的修正子 issue', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const world = defaultTree({ roundStatus: '要修', roundCommentUrl: 'https://example.invalid/c' });
  addCorrection(world);
  world.addIssue({
    repo: REPO,
    number: 10,
    title: '关掉的修正',
    state: 'closed',
    body: `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC3 · 第 1 轮`,
  });
  world.addChild(`${REPO}#1`, `${REPO}#10`);

  const inventoryNodeRoot = inventoryNode(world, `${REPO}#1`);
  const github = {
    async graphql(query, variables) {
      if (query.includes('user(login')) {
        return {
          user: {
            open: { nodes: [inventoryNodeRoot], pageInfo: { hasNextPage: false, endCursor: null } },
            closed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      }
      return world.graphql({ query, variables });
    },
  };
  const found = await discoverCorrections({ github, profile });
  assert.deepEqual(found.map((entry) => entry.issue), [CORRECTION_REF]);
  assert.equal(found[0].root, `${REPO}#1`);
  assert.equal(found[0].sc, 3);
});

test('SC2/SC12 修正轮解析、分支名、禁改路径和停止条件都是纯函数', () => {
  const rounds = parseCorrectionRounds(
    [
      { body: '[修正机] 第 1 轮：修正中', databaseId: 1, createdAt: '2026-10-24T01:00:00.000Z', author: { login: OWNER } },
      { body: '[修正机] 第 2 轮：等 CI', databaseId: 2, createdAt: '2026-10-24T02:00:00.000Z', author: { login: OWNER } },
      { body: '[修正机] 第 3 轮：修正中', databaseId: 3, createdAt: '2026-10-24T03:00:00.000Z', author: { login: 'StrangerUser' } },
    ],
    OWNER,
  );
  assert.deepEqual(rounds.map((entry) => `${entry.round}:${entry.status}`), ['1:修正中', '2:等 CI']);
  assert.equal(correctionBranch({ root: `${REPO}#1`, item: `${REPO}#2`, sc: 3 }), 'acceptance/1-2-sc3');
  assert.equal(matchesForbidden('.github/workflows/ci.yml', ['.github/workflows/**']), true);
  assert.equal(matchesForbidden('src/app.mjs', ['.github/workflows/**']), false);

  assert.equal(stopReason({ ready: true }).reason, 'ready');
  assert.equal(stopReason({ gateCode: 4 }).needsHuman, true);
  assert.equal(stopReason({ refix: MAX_REFIX + 1 }).reason, 'limit-refix');
  assert.equal(stopReason({ mainRed: { check: 'ci' } }).reason, 'main-red');
  assert.equal(stopReason({ forbiddenPaths: ['.github/workflows/ci.yml'] }).reason, 'forbidden-path');
  assert.equal(stopReason({ secretFiles: ['config/a'] }).reason, 'secret-found');
  assert.equal(stopReason({ verdict: '通过' }).reason, 'verdict-not-fix');
  assert.equal(stopReason({ paused: true }).reason, 'paused');
  const old = { startedAt: '2026-10-24T00:00:00.000Z' };
  assert.equal(stopReason(old, { now: () => Date.parse('2026-10-24T04:00:00.000Z') }).reason, 'round-too-long');
  assert.equal(stopReason({}).stop, false);
});

test('SC7 盯 CI 空转：同一 head + 同一失败反复出现 -> 只计一次再修，最后需人工处理', async () => {
  const now = clock('2026-10-24T01:00:00.000Z');
  const status = {
    headRefOid: 'a'.repeat(40),
    isDraft: true,
    mergeStateStatus: 'CLEAN',
    commits: {
      nodes: [
        {
          commit: {
            checkSuites: { nodes: [{ checkRuns: { nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 1 }] } }] },
            statusCheckRollup: { contexts: { nodes: [] } },
          },
        },
      ],
    },
  };
  const state = { pr: { headSha: status.headRefOid }, refix: 0, failureSeen: [], rerunFingerprints: [] };
  const first = await pollDraft({ state, status, mainChecks: { names: new Set() }, now: now.now });
  assert.equal(first.action, 'refix');
  assert.equal(state.refix, 1);
  for (let i = 0; i < 5; i += 1) {
    const again = await pollDraft({ state, status, mainChecks: { names: new Set() }, now: now.now });
    assert.equal(again.action, 'needs-human');
    assert.equal(again.reason, 'same-head-same-failure');
  }
  assert.equal(state.refix, 1, '计数不暴涨');

  const red = await pollDraft({
    state: { pr: { headSha: status.headRefOid }, refix: 0, failureSeen: [], rerunFingerprints: [] },
    status,
    mainChecks: { names: new Set(['unit']), sha: 'b'.repeat(40) },
    now: now.now,
  });
  assert.equal(red.action, 'needs-human');
  assert.equal(red.reason, 'main-red');
  assert.equal(red.evidence.check, 'unit');
});

test('SC10 Ready 满 24 小时没人接：只追加一条 ready-stalled（假时钟）', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  fs.mkdirSync(paths.prbotReadyDir, { recursive: true });
  const readyAt = '2026-10-24T00:00:00.000Z';
  fs.writeFileSync(
    path.join(paths.prbotReadyDir, 'example-owner__example-repo__9.json'),
    JSON.stringify({
      issue: CORRECTION_REF,
      root: `${REPO}#1`,
      repo: REPO,
      pr: 12,
      prUrl: `https://example.invalid/${REPO}/pull/12`,
      headSha: 'a'.repeat(40),
      readyAt,
      handoff: 'watcher',
      stalledAt: null,
    }),
  );
  const github = {
    async graphql(query, variables) {
      assert.equal(query.includes('pullRequest'), true);
      return {
        repository: {
          pullRequest: {
            number: variables.number,
            url: `https://example.invalid/${REPO}/pull/12`,
            headRefOid: 'a'.repeat(40),
            reviews: { nodes: [] },
            comments: { nodes: [] },
            commits: { nodes: [{ commit: { checkSuites: { nodes: [{ checkRuns: { nodes: [] } }] } } }] },
          },
        },
      };
    },
  };
  const early = await checkReadyStalled({
    home,
    profile,
    github,
    now: () => Date.parse(readyAt) + READY_STALL_MS - 1000,
  });
  assert.equal(early.length, 0);
  const stalled = await checkReadyStalled({ home, profile, github, now: () => Date.parse(readyAt) + READY_STALL_MS + 1000 });
  assert.equal(stalled.length, 1);
  const again = await checkReadyStalled({ home, profile, github, now: () => Date.parse(readyAt) + READY_STALL_MS + 2000 });
  assert.equal(again.length, 0, '同一 PR 只追加一次');
  assert.deepEqual(readPrbotEvents(paths).map((event) => event.type), ['ready-stalled']);
});

test('SC11 清理：只回收带 prbot .acc-owned.json 的工作树', () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const root = path.join(profile.worktreeDir, 'prbot');
  const owned = path.join(root, 'example-owner__example-repo__9-r1');
  const foreign = path.join(root, 'example-owner__example-repo__9-r2');
  const noMarker = path.join(root, 'somebody-else');
  for (const dir of [owned, foreign, noMarker]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(owned, '.acc-owned.json'), JSON.stringify({ kind: 'prbot' }));
  fs.writeFileSync(path.join(foreign, '.acc-owned.json'), JSON.stringify({ kind: 'somebody-else' }));
  const removed = cleanupWorktrees({ home, profile });
  assert.deepEqual(removed, [owned]);
  assert.equal(fs.existsSync(owned), false);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.existsSync(noMarker), true);
});

test('SC1/SC2/SC5/SC11 一次完整跑通：认领 → 评估 → 修复 → Draft → 等 CI → Ready，评论就地改、事件按接口写', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const github = createFakeGithub(world);
  const now = clock('2026-10-24T04:00:00.000Z');
  const actions = [];
  const comments = new Map();
  let nextComment = 700;

  const fakeGate = {
    async handle(action) {
      actions.push(action);
      if (action.type === 'comment.create') {
        const id = (nextComment += 1);
        comments.set(id, action.body);
        return { code: 0, body: { commentId: id, url: 'https://example.invalid/c' } };
      }
      if (action.type === 'comment.update') {
        comments.set(action.commentId, action.body);
        return { code: 0, body: { commentId: action.commentId } };
      }
      if (action.type === 'read.graphql') {
        if (action.query === PR_BY_BRANCH_QUERY) return { code: 0, body: { data: { repository: { pullRequests: { nodes: [] } } } } };
        if (action.query === PR_STATUS_QUERY) {
          return {
            code: 0,
            body: {
              data: {
                repository: {
                  pullRequest: {
                    number: 12,
                    url: `https://example.invalid/${REPO}/pull/12`,
                    isDraft: true,
                    headRefOid: 'c'.repeat(40),
                    mergeStateStatus: 'CLEAN',
                    changedFiles: 3,
                    additions: 10,
                    deletions: 2,
                    commits: {
                      nodes: [
                        {
                          commit: {
                            checkSuites: {
                              nodes: [{ checkRuns: { nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', databaseId: 1 }] } }],
                            },
                            statusCheckRollup: { contexts: { nodes: [] } },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          };
        }
        return { code: 0, body: { data: { repository: { ref: { target: { oid: 'd'.repeat(40), checkSuites: { nodes: [] } } } } } } };
      }
      if (action.type === 'pr.create') return { code: 0, body: { pr: 12, url: `https://example.invalid/${REPO}/pull/12` } };
      if (action.type === 'pr.ready') return { code: 0, body: { pr: 12, repo: REPO } };
      return { code: 0, body: {} };
    },
  };

  const worktree = path.join(tmpDir(), 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  const meminfo = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(meminfo, 'MemAvailable: 8388608 kB\n');
  const code = await runPrbotCorrection({
    home,
    issue: CORRECTION_REF,
    profile,
    hostConfig: { prbot: { piCommand: ['pi', '--model', 'example/model'] } },
    github,
    now: now.now,
    meminfoPath: meminfo,
    sleep: async () => {},
    makeGate: () => fakeGate,
    prepareWorktree: () => ({ worktree }),
    piRunner: async () => ({ ok: true, stdout: '', code: 0 }),
    bundleFactory: async () => ({ bundlePath: '/tmp/fake.bundle', headSha: 'c'.repeat(40), cleanup() {} }),
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    statusProvider: async () => ({
      number: 12,
      url: `https://example.invalid/${REPO}/pull/12`,
      isDraft: true,
      headRefOid: 'c'.repeat(40),
      mergeStateStatus: 'CLEAN',
      changedFiles: 3,
      additions: 10,
      deletions: 2,
      commits: {
        nodes: [
          {
            commit: {
              checkSuites: {
                nodes: [{ checkRuns: { nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', databaseId: 1 }] } }],
              },
              statusCheckRollup: { contexts: { nodes: [] } },
            },
          },
        ],
      },
    }),
    mainChecksProvider: async () => ({ names: new Set(), sha: 'd'.repeat(40) }),
  });
  assert.equal(code, 0, JSON.stringify(actions.map((action) => action.type)));
  const creates = actions.filter((action) => action.type === 'comment.create');
  assert.equal(creates.length, 1, '一轮只有一条轮次评论');
  assert.match(creates[0].body, /^\[修正机\] 第 1 轮：修正中/);
  const updates = actions.filter((action) => action.type === 'comment.update');
  assert.ok(updates.length >= 3);
  assert.equal(new Set(updates.map((action) => action.commentId)).size, 1, '一直改同一条');
  const finalBody = comments.get(updates.at(-1).commentId);
  assert.match(finalBody.split('\n')[0], /^\[修正机\] 第 1 轮：已 Ready$/);
  assert.match(finalBody, /PR：https:\/\/example\.invalid\/example-owner\/example-repo\/pull\/12/);

  const eventTypes = readPrbotEvents(paths).map((event) => event.type);
  assert.deepEqual(eventTypes, ['claimed', 'draft-opened', 'ready']);
  const readyEvent = readPrbotEvents(paths).find((event) => event.type === 'ready');
  assert.equal(readyEvent.handoff, 'owner');
  assert.deepEqual(readyEvent.sc, [3]);
  assert.equal(readyEvent.headSha, 'c'.repeat(40));
  assert.deepEqual(readyEvent.diff, { files: 3, additions: 10, deletions: 2 });
  assert.equal(actions.some((action) => action.type === 'pr.merge'), false);
});

test('SC1 tick 每一拍调用修正轮发现、ready-stalled 和清理；同一修正子 issue 已在跑就不重开', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'host.json'),
    JSON.stringify({ piCommand: ['pi', '--model', 'example/model'], prbot: { piCommand: ['pi', '--model', 'example/model'] } }),
  );
  const started = [];
  const heartbeat = await runTick({
    home,
    env: { ...process.env, ACCEPTANCE_WATCHER_HOME: home },
    run: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    spawnRound: () => {
      throw new Error('不该起验收轮');
    },
    spawnPrbot: (issue) => {
      started.push(issue);
      return 900001;
    },
    discoverPrbot: async () => [{ issue: CORRECTION_REF }],
    checkPrbotStalled: async () => [{ issue: CORRECTION_REF, pr: 12 }],
    cleanupPrbot: () => ['/tmp/owned-worktree'],
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => Date.parse('2026-10-24T05:00:00.000Z'),
  });
  assert.deepEqual(started, [CORRECTION_REF]);
  assert.deepEqual(heartbeat.lastTick.prbotStarted.map((entry) => entry.issue), [CORRECTION_REF]);
  assert.deepEqual(heartbeat.lastTick.prbotStalled, [{ issue: CORRECTION_REF, pr: 12 }]);
  assert.deepEqual(heartbeat.lastTick.prbotCleaned, ['/tmp/owned-worktree']);
});
