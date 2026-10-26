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
  beijingIso,
  handoffFor,
  preflightCommands,
  checkReadyStalled,
  cleanupWorktrees,
  defaultPrepareWorktree,
  HOST_GIT_HARDENING,
  bundleHead,
  correctionBranch,
  discoverCorrections,
  matchesForbidden,
  mirrorPathFor,
  parseCorrectionRounds,
  pollDraft,
  prbotStatePath,
  runPrbotCorrection,
  stopReason,
} from './host/prbot.mjs';
import { PR_BY_BRANCH_QUERY, PR_STATUS_QUERY, createGate } from './host/write-gate.mjs';
import { runTick } from './host/tick.mjs';
import { createFakeGithub, createWorld, defaultTree } from './session.fixture.mjs';
import { clock, OWNER, REPO, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import { spawnRun } from './bin/localgit.mjs';

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
  // 同一 head、同一失败：不再起 pi（不是 refix），但「这个 head 已修过」也计一次。
  const second = await pollDraft({ state, status, mainChecks: { names: new Set() }, now: now.now });
  assert.equal(second.action, 'wait');
  assert.equal(state.refix, 2);
  for (let i = 0; i < 5; i += 1) {
    const again = await pollDraft({ state, status, mainChecks: { names: new Set() }, now: now.now });
    assert.equal(again.action, 'needs-human');
    assert.equal(again.reason, 'same-head-same-failure');
  }
  assert.equal(state.refix, MAX_REFIX + 1, '计数不暴涨');
  assert.equal(stopReason(state).reason, 'limit-refix');

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

function checkStatus({ head = 'a'.repeat(40), mergeStateStatus = 'CLEAN', runs = [] } = {}) {
  return {
    headRefOid: head,
    isDraft: true,
    mergeStateStatus,
    commits: {
      nodes: [{ commit: { checkSuites: { nodes: [{ checkRuns: { nodes: runs } }] }, statusCheckRollup: { contexts: { nodes: [] } } } }],
    },
  };
}

test('SC6 盯 CI：还在跑的检查只等，不重跑也不再修；落后 main 先更新分支；冲突交给 pi 合 main，最多 3 轮', async () => {
  const now = clock('2026-10-24T01:00:00.000Z');
  const fresh = () => ({ pr: { headSha: 'a'.repeat(40) }, refix: 0, conflict: 0, failureSeen: [], rerunFingerprints: [] });
  const main = { names: new Set() };

  const pendingState = fresh();
  const pending = await pollDraft({
    state: pendingState,
    status: checkStatus({
      runs: [
        { name: 'unit', status: 'IN_PROGRESS', conclusion: null, checkSuite: { workflowRun: { databaseId: 5 } } },
        { name: 'lint', status: 'QUEUED', conclusion: null },
      ],
    }),
    mainChecks: main,
    now: now.now,
  });
  assert.equal(pending.action, 'wait');
  assert.equal(pendingState.refix, 0);
  assert.deepEqual(pendingState.rerunFingerprints, []);

  // 有一条真失败、另一条还在跑：等全部检查结束再动手（和文档一致），不先重跑。
  const mixedState = fresh();
  const mixedRuns = (lint) => [
    { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', checkSuite: { workflowRun: { databaseId: 5 } } },
    lint,
  ];
  const mixed = await pollDraft({
    state: mixedState,
    status: checkStatus({ runs: mixedRuns({ name: 'lint', status: 'IN_PROGRESS', conclusion: null }) }),
    mainChecks: main,
    now: now.now,
  });
  assert.equal(mixed.action, 'wait');
  assert.deepEqual(mixedState.rerunFingerprints, []);
  assert.equal(mixedState.refix, 0);
  const done = await pollDraft({
    state: mixedState,
    status: checkStatus({ runs: mixedRuns({ name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }) }),
    mainChecks: main,
    now: now.now,
  });
  assert.equal(done.action, 'rerun', '全部结束后失败那条先重跑一次');
  assert.equal(done.runId, 5);

  // workflow 排上队、job 还没出来（suite 有了、run 一条没有）：也算还在跑。
  const queuedSuite = await pollDraft({
    state: fresh(),
    status: {
      headRefOid: 'a'.repeat(40),
      isDraft: true,
      mergeStateStatus: 'CLEAN',
      commits: {
        nodes: [
          {
            commit: {
              checkSuites: {
                nodes: [
                  { checkRuns: { nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] } },
                  { status: 'QUEUED', conclusion: null, workflowRun: { databaseId: 8 }, checkRuns: { nodes: [] } },
                ],
              },
              statusCheckRollup: { contexts: { nodes: [] } },
            },
          },
        ],
      },
    },
    mainChecks: main,
    now: now.now,
  });
  assert.equal(queuedSuite.action, 'wait', '排队中的 workflow 不放行 Ready');

  const behindState = fresh();
  const green = [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const behind = await pollDraft({ state: behindState, status: checkStatus({ mergeStateStatus: 'BEHIND', runs: green }), mainChecks: main, now: now.now });
  assert.equal(behind.action, 'update-branch');
  assert.equal(behindState.conflict, 1);
  const behindPending = await pollDraft({
    state: fresh(),
    status: checkStatus({ mergeStateStatus: 'BEHIND', runs: [{ name: 'unit', status: 'IN_PROGRESS' }] }),
    mainChecks: main,
    now: now.now,
  });
  assert.equal(behindPending.action, 'wait', '检查没跑完先不动分支');

  const dirtyState = fresh();
  for (let i = 1; i <= 3; i += 1) {
    const head = String(i).repeat(40);
    const dirty = await pollDraft({ state: dirtyState, status: checkStatus({ head, mergeStateStatus: 'DIRTY', runs: green }), mainChecks: main, now: now.now });
    assert.equal(dirty.action, 'resolve-conflict', `第 ${i} 次`);
    const sameHead = await pollDraft({ state: dirtyState, status: checkStatus({ head, mergeStateStatus: 'DIRTY', runs: green }), mainChecks: main, now: now.now });
    assert.equal(sameHead.action, 'wait', '同一 head 不重复叫 pi');
  }
  const limit = await pollDraft({ state: dirtyState, status: checkStatus({ head: '4'.repeat(40), mergeStateStatus: 'DIRTY', runs: green }), mainChecks: main, now: now.now });
  assert.equal(limit.action, 'needs-human');
  assert.equal(limit.reason, 'limit-conflict');
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

test('SC11 清理：只回收带 prbot .acc-owned.json、且这一修正轮已收尾的工作树；还在跑 / 没收尾的不动', () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  const root = path.join(profile.worktreeDir, 'prbot');
  const issueFor = (n) => `${REPO}#${n}`;
  const dirs = {
    done: path.join(root, 'example-owner__example-repo__9-r1'),
    active: path.join(root, 'example-owner__example-repo__10-r1'),
    unfinished: path.join(root, 'example-owner__example-repo__11-r1'),
    foreign: path.join(root, 'example-owner__example-repo__12-r1'),
    noMarker: path.join(root, 'somebody-else'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const own = (dir, n) => fs.writeFileSync(path.join(dir, '.acc-owned.json'), JSON.stringify({ kind: 'prbot', issue: issueFor(n), round: 1 }));
  own(dirs.done, 9);
  own(dirs.active, 10);
  own(dirs.unfinished, 11);
  fs.writeFileSync(path.join(dirs.foreign, '.acc-owned.json'), JSON.stringify({ kind: 'somebody-else', issue: issueFor(12), round: 1 }));
  fs.mkdirSync(paths.prbotRoundsDir, { recursive: true });
  const writeState = (n, status) =>
    fs.writeFileSync(
      path.join(paths.prbotRoundsDir, `example-owner__example-repo__${n}.json`),
      JSON.stringify({ issue: issueFor(n), round: 1, status }),
    );
  writeState(9, '已 Ready');
  writeState(10, '需人工处理');
  writeState(11, '等 CI');
  writeState(12, '已 Ready');
  // #10 的进程还拿着锁（就是当前进程）。
  fs.mkdirSync(paths.prbotLocksDir, { recursive: true });
  fs.writeFileSync(
    path.join(paths.prbotLocksDir, 'example-owner__example-repo__10.lock'),
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }),
  );
  // 宿主镜像在 <home>/state/prbot/mirrors/<工作树名>：跟着工作树一起回收，没收尾的不动。
  for (const key of ['done', 'active']) fs.mkdirSync(mirrorPathFor(home, dirs[key]), { recursive: true });
  const removed = cleanupWorktrees({ home, profile });
  assert.deepEqual(removed, [dirs.done]);
  for (const key of ['active', 'unfinished', 'foreign', 'noMarker']) assert.equal(fs.existsSync(dirs[key]), true, key);
  assert.equal(fs.existsSync(mirrorPathFor(home, dirs.done)), false, '收尾的镜像删了');
  assert.equal(fs.existsSync(mirrorPathFor(home, dirs.active)), true, '还在跑的镜像不动');
  assert.ok(mirrorPathFor(home, dirs.done).startsWith(path.join(home, 'state', 'prbot', 'mirrors') + path.sep));
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
  const runs = [];
  const code = await runPrbotCorrection({
    home,
    issue: CORRECTION_REF,
    profile,
    hostConfig: { prbot: { piCommand: ['pi', '--model', 'example/model'], repos: { [REPO]: { handoff: 'owner' } } } },
    github,
    now: now.now,
    meminfoPath: meminfo,
    sleep: async () => {},
    makeGate: () => fakeGate,
    prepareWorktree: () => ({ worktree, mirror: path.join(tmpDir(), 'mirror') }),
    piRunner: async () => ({ ok: true, stdout: '', code: 0 }),
    bundleFactory: async () => ({ bundlePath: '/tmp/fake.bundle', headSha: 'c'.repeat(40), cleanup() {} }),
    run: async (cmd, args) => {
      runs.push({ cmd, args });
      return { code: 0, stdout: args.includes('diff') ? 'src/app.mjs\n' : '', stderr: '' };
    },
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
  const prCreate = actions.find((action) => action.type === 'pr.create');
  assert.equal(prCreate.body.split('\n')[0], `任务 issue：${REPO}#1`);
  assert.equal(prCreate.body.includes(CORRECTION_MARKER), true, 'PR 正文照抄修正子 issue 的标记');
  // #93：正文按 task-pr/v1 逐段对应修正子 issue；范围对照写的是真正要推的 bundle 里的改动文件。
  for (const heading of ['改了什么', '范围对照', '验收对照', '定下的决定', '未执行的验证', '风险与回滚']) {
    assert.match(prCreate.body, new RegExp(`^## ${heading}$`, 'm'), heading);
  }
  assert.match(prCreate.body, /^- 本 PR 改了：`src\/app\.mjs`/m);
  assert.equal(prCreate.body.split('\n').filter((line) => /^\|\s*SC\d+/.test(line)).length, 1);
  // 宿主上对 pi 写过的工作树跑 git：钩子和 fsmonitor 关掉，环境里没有令牌。
  const diffRun = runs.find((entry) => entry.args.includes('diff'));
  assert.ok(diffRun);
  assert.deepEqual(diffRun.args.slice(0, 4), ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']);
  // 看改动在宿主镜像里（--git-dir 指向镜像），不在 pi 写过的工作树里。
  assert.equal(diffRun.args.includes('-C'), false);
  assert.match(diffRun.args[diffRun.args.indexOf('--git-dir') + 1], /mirror[/\\]\.git$/);
  assert.equal(runs.some((entry) => entry.args.includes(worktree)), false);
});

test('SC1 tick 每一拍调用修正轮发现、ready-stalled 和清理；同一修正子 issue 已在跑就不重开', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const configDir = path.join(home, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'host.json'),
    JSON.stringify({ piCommand: ['pi', '--model', 'example/model'], prbot: { piCommand: ['pi', '--model', 'example/model'] } }),
  );
  // 写闸总开关开着才起修正轮（关着时 tick 什么轮次都不起）。
  fs.mkdirSync(path.join(home, 'state', 'write-gate'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state', 'write-gate', 'enabled'), '1');
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

// ---- 一次修正轮的小 harness：假写闸 + 按顺序吐出的 PR 状态 ----
function greenRun(name = 'unit') {
  return { name, status: 'COMPLETED', conclusion: 'SUCCESS', databaseId: 1 };
}

function prStatus(head, runs, extra = {}) {
  return {
    number: 12,
    url: `https://example.invalid/${REPO}/pull/12`,
    isDraft: true,
    headRefOid: head,
    mergeStateStatus: 'CLEAN',
    changedFiles: 1,
    additions: 1,
    deletions: 0,
    commits: { nodes: [{ commit: { checkSuites: { nodes: [{ checkRuns: { nodes: runs } }] }, statusCheckRollup: { contexts: { nodes: [] } } } }] },
    ...extra,
  };
}

async function runOnce({
  world,
  statuses = [],
  heads = ['c'.repeat(40)],
  diff = 'src/app.mjs\n',
  piCalls = [],
  byBranch = [],
  hostConfig = { prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } },
  preflightRunner,
  hostRuns = [],
  dirty = '',
  onPush,
  onAction,
  issue = CORRECTION_REF,
  home: givenHome,
  profileExtra = {},
  overrides = {},
} = {}) {
  const home = givenHome || writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state'), ...profileExtra } }).home;
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  const actions = [];
  const gate = {
    async handle(action) {
      actions.push(action);
      if (onAction) {
        const override = await onAction(action);
        if (override !== undefined) return override;
      }
      // 轮次评论写进假 GitHub：下一拍的只读检查看得到（多拍的测试要用）。
      if (action.type === 'comment.create' || action.type === 'comment.update') return { code: 0, body: world.write(action) };
      if (action.type === 'read.graphql') {
        if (action.query === PR_BY_BRANCH_QUERY) return { code: 0, body: { data: { repository: { pullRequests: { nodes: byBranch } } } } };
        return { code: 0, body: { data: {} } };
      }
      if (action.type === 'pr.create') return { code: 0, body: { pr: 12, url: `https://example.invalid/${REPO}/pull/12` } };
      if (action.type === 'branch.push' && onPush) return onPush(action);
      return { code: 0, body: {} };
    },
  };
  const worktree = path.join(tmpDir(), 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  const meminfo = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(meminfo, 'MemAvailable: 8388608 kB\n');
  let bundles = 0;
  let polls = 0;
  const code = await runPrbotCorrection({
    home,
    issue,
    profile,
    hostConfig,
    preflightRunner,
    github: createFakeGithub(world),
    now: clock('2026-10-24T04:00:00.000Z').now,
    meminfoPath: meminfo,
    sleep: async () => {},
    makeGate: () => gate,
    prepareWorktree: (options) => {
      piCalls.push({ refresh: options.refresh });
      return { worktree, mirror: path.join(tmpDir(), 'mirror') };
    },
    piRunner: async ({ prompt }) => {
      piCalls.at(-1).prompt = prompt;
      return { ok: true, stdout: '', code: 0 };
    },
    bundleFactory: async () => {
      const headSha = heads[Math.min(bundles, heads.length - 1)];
      bundles += 1;
      return { bundlePath: '/tmp/fake.bundle', headSha, cleanup() {} };
    },
    run: async (cmd, args) => {
      hostRuns.push({ cmd, args });
      if (args.includes('diff')) return { code: 0, stdout: diff, stderr: '' };
      if (args.includes('status')) return { code: 0, stdout: dirty, stderr: '' };
      // 宿主在镜像里打 main.bundle：假装打出一个文件。
      if (args.includes('bundle') && args.includes('create')) fs.writeFileSync(args[args.indexOf('create') + 1], 'fake main bundle');
      return { code: 0, stdout: '', stderr: '' };
    },
    statusProvider: async () => statuses[Math.min(polls++, statuses.length - 1)],
    mainChecksProvider: async () => ({ names: new Set(), sha: 'd'.repeat(40) }),
    ...overrides,
  });
  return { code, actions, events: readPrbotEvents(paths).map((event) => event.type), allEvents: readPrbotEvents(paths), paths, home, profile };
}

test('SC6/SC7 一次修正轮：检查没跑完只等；真失败 -> 再修 -> 推到同一个 PR -> 全绿转 Ready；draft-opened 只发一次', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const first = 'c'.repeat(40);
  const second = 'e'.repeat(40);
  const piCalls = [];
  const result = await runOnce({
    world,
    heads: [first, second],
    piCalls,
    statuses: [
      prStatus(first, [{ name: 'unit', status: 'IN_PROGRESS', conclusion: null }]),
      prStatus(first, [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }]),
      prStatus(second, [greenRun()]),
    ],
  });
  assert.equal(result.code, 0, JSON.stringify(result.actions.map((action) => action.type)));
  assert.equal(piCalls.length, 2, '再修一次 = pi 跑两次');
  assert.equal(result.actions.filter((action) => action.type === 'pr.create').length, 1);
  assert.equal(result.actions.filter((action) => action.type === 'branch.push').length, 2);
  assert.equal(result.actions.some((action) => action.type === 'ci.rerun'), false, '没有 run id 的失败不重跑');
  assert.deepEqual(result.events, ['claimed', 'draft-opened', 'ready']);
  const ready = result.actions.find((action) => action.type === 'pr.ready');
  assert.equal(ready.headSha, second);
});

test('SC7 冲突：pi 先取回最新 main 再合（prepareWorktree refresh + 提示里写明合 main）', async () => {
  const sandboxed = [];
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const first = 'c'.repeat(40);
  const second = 'e'.repeat(40);
  const piCalls = [];
  const result = await runOnce({
    world,
    heads: [first, second],
    piCalls,
    statuses: [prStatus(first, [greenRun()], { mergeStateStatus: 'DIRTY' }), prStatus(second, [greenRun()])],
    preflightRunner: async ({ commands }) => {
      sandboxed.push(commands);
      return { ok: true, runs: [] };
    },
  });
  assert.equal(result.code, 0, JSON.stringify(result.actions.map((action) => action.type)));
  // 最新 main 由宿主取进镜像；导进工作树这一步在沙箱里跑，而且只在解决冲突那一次。
  assert.equal(sandboxed.length, 1);
  assert.deepEqual(sandboxed[0][0].slice(0, 3), ['git', 'fetch', '-q']);
  // 沙箱只拿到复制进轮次目录的 main.bundle，看不见宿主镜像本身。
  assert.match(sandboxed[0][0][3], /[/]run[/]prbot[/][^/]+-r1-main[/]main\.bundle$/);
  assert.doesNotMatch(sandboxed[0][0][3], /mirror/);
  assert.equal(sandboxed[0][0][4], '+refs/remotes/origin/main:refs/remotes/origin/main');
  assert.equal(piCalls.length, 2);
  assert.equal(piCalls[0].refresh, false);
  assert.equal(piCalls[1].refresh, true);
  assert.match(piCalls[1].prompt, /git merge origin\/main/);
  assert.doesNotMatch(piCalls[0].prompt, /git merge origin\/main/);
});

test('SC12 pi 一个文件都没改：不推、不开 PR，需人工处理（no-change）', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const result = await runOnce({ world, diff: '' });
  assert.equal(result.code, 1);
  assert.equal(result.actions.some((action) => action.type === 'branch.push' || action.type === 'pr.create'), false);
  const human = result.allEvents.find((event) => event.type === 'needs-human');
  assert.equal(human.reason, 'no-change');
});

test('SC1 本地状态丢了：接手 GitHub 上进行中的同一条修正轮评论，不再认领新一轮', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  const correction = addCorrection(world);
  const existing = world.addComment(correction.ref, { body: '[修正机] 第 1 轮：等 CI', databaseId: 6001 });
  const result = await runOnce({ world, statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(result.code, 0, JSON.stringify(result.actions.map((action) => action.type)));
  assert.equal(result.actions.some((action) => action.type === 'comment.create'), false);
  const updates = result.actions.filter((action) => action.type === 'comment.update');
  assert.ok(updates.length > 0);
  assert.ok(updates.every((action) => action.commentId === existing.databaseId));
  assert.ok(updates.every((action) => /^\[修正机\] 第 1 轮：/.test(action.body)));
});

test('SC1 上一修正轮已收尾、总 issue 之后没有新「要修」：这一拍什么都不写；有了新裁决才开第 2 轮', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  const correction = addCorrection(world);
  world.addComment(correction.ref, { body: '[修正机] 第 1 轮：已 Ready', databaseId: 6001, createdAt: '2026-10-24T03:00:00.000Z' });
  const idle = await runOnce({ world });
  assert.equal(idle.code, 0);
  assert.deepEqual(idle.actions, []);

  world.addComment(`${REPO}#1`, {
    ...roundComment({
      round: 2,
      status: '要修',
      bodyVersion: bodyVersion(world.requireIssue(`${REPO}#1`).body),
      startedAt: '2026-10-25T01:00:00.000Z',
      databaseId: 1002,
    }),
  });
  const next = await runOnce({ world, statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(next.code, 0, JSON.stringify(next.actions.map((action) => action.type)));
  const claim = next.actions.find((action) => action.type === 'comment.create');
  assert.match(claim.body, /^\[修正机\] 第 2 轮：修正中/);
});

test('SC5 找已有 PR 只认从我们推的仓来的：别人 fork 里同名分支的 PR 不沿用', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const stranger = {
    number: 99,
    url: `https://example.invalid/${REPO}/pull/99`,
    headRefName: 'acceptance/1-2-sc3',
    headRepository: { nameWithOwner: 'StrangerUser/example-repo' },
  };
  const result = await runOnce({ world, byBranch: [stranger], statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(result.code, 0);
  assert.equal(result.actions.filter((action) => action.type === 'pr.create').length, 1);
  assert.equal(result.actions.find((action) => action.type === 'pr.ready').pr, 12);

  const ours = { ...stranger, number: 13, headRepository: { nameWithOwner: REPO } };
  const reuse = await runOnce({ world: (() => { const w = defaultTree({ roundStatus: '要修' }); addCorrection(w); return w; })(), byBranch: [stranger, ours], statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(reuse.actions.some((action) => action.type === 'pr.create'), false);
  assert.equal(reuse.actions.find((action) => action.type === 'pr.ready').pr, 13);
});

test('SC4 handoffNew 生成的交接文件：add / commit 在沙箱里跑，宿主上不对 pi 的工作树跑 add / commit', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const sandboxed = [];
  const hostRuns = [];
  const result = await runOnce({
    world,
    dirty: '?? handoff/12.md\n',
    hostRuns,
    heads: ['c'.repeat(40), 'e'.repeat(40)],
    hostConfig: { prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner', handoffNew: ['node', 'scripts/handoff.mjs', '{pr}'] } } } },
    preflightRunner: async ({ commands }) => {
      sandboxed.push(commands);
      const status = commands[0]?.[1] === 'status';
      return { ok: true, runs: [{ command: commands[0], code: 0, stdout: status ? '?? handoff/12.md\n' : '' }] };
    },
    statuses: [prStatus('e'.repeat(40), [greenRun()])],
  });
  assert.equal(result.code, 0, JSON.stringify(result.actions.map((action) => action.type)));
  assert.deepEqual(sandboxed[0], [['node', 'scripts/handoff.mjs', '12']]);
  assert.deepEqual(sandboxed[1], [['git', 'status', '--porcelain']], 'status 也在沙箱里看');
  assert.deepEqual(sandboxed[2], [['git', 'add', '-A'], ['git', 'commit', '-q', '-s', '-m', 'chore: handoff files']]);
  assert.equal(hostRuns.some((entry) => entry.args.includes('add') || entry.args.includes('commit') || entry.args.includes('status')), false);
  assert.equal(result.actions.filter((action) => action.type === 'branch.push').length, 2);
});

// SC5 准备工作树（镜像位置、沙箱里建工作树、复用 / 重取、fork 上游）见 prbot-mirror.test.mjs。

// ---- #68 第三轮复审：宿主绝不在 pi 写过的工作树里跑（带令牌的）git ----

const FAKE_TOKEN = 'fake-token-value-not-real';

/** 测试里的「沙箱」：真 git，但带 IN_SANDBOX=1；植入的钩子只在宿主上（没有这个变量）留痕。 */
function sandboxEnv() {
  const env = { PATH: process.env.PATH, HOME: tmpDir(), IN_SANDBOX: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  return env;
}

async function git(args, options = {}) {
  const result = await spawnRun('git', args, { env: sandboxEnv(), ...options });
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return String(result.stdout).trim();
}

async function hostileSetup({ forbiddenPaths } = {}) {
  const up = path.join(tmpDir(), 'upstream');
  await git(['init', '-q', '-b', 'main', up]);
  fs.mkdirSync(path.join(up, 'src'));
  fs.writeFileSync(path.join(up, 'src', 'app.mjs'), 'export const x = 1;\n');
  await git(['-C', up, 'add', '-A']);
  await git(['-C', up, '-c', 'user.name=u', '-c', 'user.email=u@example.invalid', 'commit', '-q', '-m', 'init']);
  const upstreamMain = await git(['-C', up, 'rev-parse', 'HEAD']);

  const marks = path.join(tmpDir(), 'marks');
  fs.mkdirSync(marks);
  const evil = path.join(tmpDir(), 'evil.sh');
  fs.writeFileSync(evil, `#!/bin/sh\n[ -n "$IN_SANDBOX" ] || env > "${marks}/hit.$$"\nexit 0\n`, { mode: 0o755 });

  const fetches = [];
  const hostRuns = [];
  let worktree = null;
  // 真的 fetchBranch 带令牌；这里同样把假令牌放进环境，看它会不会进到钩子里。
  const fetchBranch = async ({ repo, branch, dir, depth }) => {
    fetches.push({ repo, branch, dir, depth });
    const env = { ...sandboxEnv(), IN_SANDBOX: '', EXAMPLE_ACCESS_TOKEN: FAKE_TOKEN };
    delete env.IN_SANDBOX;
    fs.mkdirSync(dir, { recursive: true });
    for (const args of [['init', '-q', dir], ['-C', dir, 'fetch', '-q', up, `+refs/heads/${branch}:refs/remotes/origin/${branch}`]]) {
      const result = await spawnRun('git', args, { env });
      assert.equal(result.code, 0, result.stderr);
    }
  };
  const run = async (cmd, args, options = {}) => {
    hostRuns.push({ cmd, args, env: options.env, cwd: options.cwd });
    return spawnRun(cmd, args, options);
  };
  // pi：在「沙箱」里改文件、提交，然后植入钩子和恶意配置，并把工作树里的 origin/main 挪到自己的提交上。
  const piRunner = async ({ worktree: dir }) => {
    worktree = dir;
    fs.mkdirSync(path.join(dir, 'ci'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'ci', 'deploy.yml'), 'x: 1\n');
    fs.writeFileSync(path.join(dir, 'src', 'app.mjs'), 'export const x = 2;\n');
    await git(['-C', dir, 'add', '-A']);
    await git(['-C', dir, '-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-s', '-m', 'fix']);
    await git(['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
    const hooks = path.join(dir, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    for (const name of ['reference-transaction', 'post-checkout', 'pre-commit', 'post-merge', 'pre-auto-gc', 'fsmonitor-watchman', 'post-rewrite']) {
      fs.copyFileSync(evil, path.join(hooks, name));
      fs.chmodSync(path.join(hooks, name), 0o755);
    }
    // 旧镜像位置（#68 第四轮复审前）：模型想把宿主对它的 fetch 改道到自己的程序。
    const mirror = path.join(path.dirname(dir), '.mirror', path.basename(dir));
    fs.appendFileSync(
      path.join(dir, '.git', 'config'),
      [
        '[core]',
        `\tfsmonitor = ${evil}`,
        `\thooksPath = ${hooks}`,
        `\tsshCommand = ${evil}`,
        `\tpager = ${evil}`,
        `\talternateRefsCommand = ${evil}`,
        '[credential]',
        `\thelper = !${evil}`,
        '[http]',
        '\tproxy = http://127.0.0.1:9',
        '\tsslVerify = false',
        '[alias]',
        `\tfetch = !${evil}`,
        `\tbundle = !${evil}`,
        '[protocol "ext"]',
        '\tallow = always',
        `[url "ext::${evil} %S"]`,
        `\tinsteadOf = ${mirror}`,
        `[remote "${mirror}"]`,
        `\tuploadpack = ${evil}`,
        '[diff]',
        `\texternal = ${evil}`,
        '',
      ].join('\n'),
    );
    return { ok: true, stdout: '', code: 0 };
  };
  // 预检 / 打包 / 导 main 都是「沙箱」里跑的：真 git，但 IN_SANDBOX=1。
  const sandboxed = [];
  const preflightRunner = async ({ commands, worktree: dir }) => {
    const runs = [];
    for (const command of commands) {
      sandboxed.push(command);
      const result = await spawnRun(command[0], command.slice(1), { cwd: dir, env: sandboxEnv() });
      runs.push({ command, code: result.code, stdout: String(result.stdout) });
      if (result.code !== 0) return { ok: false, code: result.code, runs };
    }
    return { ok: true, code: 0, runs };
  };
  const pushed = [];
  const hostConfig = { prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner', ...(forbiddenPaths ? { forbiddenPaths } : {}) } } } };
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const fakeGithub = createFakeGithub(world);
  const github = new Proxy(fakeGithub, { get: (target, key) => (key === 'fetchBranch' ? fetchBranch : target[key]) });
  process.env.EXAMPLE_ACCESS_TOKEN = FAKE_TOKEN;
  let result;
  try {
    result = await runOnce({
      world,
      hostConfig,
      onPush: async (action) => {
        // 写闸会把 bundle 导进一个空仓：这里同样验证它自带全部对象，再停下（4）。
        const bare = path.join(tmpDir(), 'gate.git');
        await git(['init', '-q', '--bare', bare]);
        await git(['--git-dir', bare, 'fetch', '-q', action.bundlePath, `refs/heads/${action.branch}:refs/heads/${action.branch}`]);
        pushed.push({ action, head: await git(['--git-dir', bare, 'rev-parse', `refs/heads/${action.branch}`]) });
        return { code: 4, body: { reason: 'test-stop' } };
      },
      overrides: {
        github,
        run,
        piRunner,
        preflightRunner,
        bundleFactory: undefined,
        prepareWorktree: defaultPrepareWorktree,
      },
    });
  } finally {
    delete process.env.EXAMPLE_ACCESS_TOKEN;
  }
  return { result, marks, fetches, hostRuns, sandboxed, pushed, worktree: () => worktree, upstreamMain };
}

function assertHostClean({ marks, fetches, hostRuns, worktree }) {
  assert.deepEqual(fs.readdirSync(marks), [], '植入的钩子 / 配置命令一个都没在宿主上跑');
  const dir = worktree();
  assert.ok(dir, 'pi 跑过');
  for (const fetch of fetches) {
    assert.equal(fetch.dir === dir || fetch.dir.startsWith(dir + path.sep), false, `带令牌的 fetch 不在工作树里跑：${fetch.dir}`);
    assert.equal(fetch.depth, 0, '镜像取全量历史');
  }
  // pi 跑过之后宿主上的 git：没有一条指向工作树（-C / --git-dir / cwd），环境里没有令牌。
  const after = hostRuns.filter((entry) => entry.cmd === 'git');
  const touchesWorktree = (entry) =>
    [entry.cwd, ...entry.args].some((arg) => typeof arg === 'string' && (arg === dir || arg.startsWith(dir + path.sep)));
  const late = after.filter((entry) => !(entry.args.includes('init') || entry.args.includes('checkout') || entry.args.includes('config') || (entry.args.includes('fetch') && entry.args.includes('-C'))));
  for (const entry of late) {
    assert.equal(touchesWorktree(entry), false, `宿主 git 碰了工作树：${entry.args.join(' ')}`);
    assert.deepEqual(entry.args.slice(0, HOST_GIT_HARDENING.length), HOST_GIT_HARDENING);
  }
  for (const entry of hostRuns) {
    assert.equal(Object.keys(entry.env || {}).some((key) => /TOKEN/i.test(key)), false, '宿主 git 的环境里没有令牌');
    assert.equal(Object.values(entry.env || {}).includes(FAKE_TOKEN), false);
  }
}

test('SC3/SC5 pi 植入钩子 + 恶意 .git/config + 挪 origin/main：宿主上什么都不跑、令牌不外泄；打包在沙箱、基准用宿主镜像', async () => {
  const setup = await hostileSetup();
  // 测试里的写闸收到推送后回 4 停下（宿主记「需人工处理」，返回 1）。
  assert.equal(setup.result.code, 1, JSON.stringify(setup.result.actions.map((action) => action.type)));
  assertHostClean(setup);
  // 打包、看 status 这些碰工作树 .git 的都在沙箱里。
  assert.ok(setup.sandboxed.some((command) => command[0] === 'git' && command[1] === 'bundle' && command[2] === 'create'));
  // pi 把工作树里的 origin/main 挪到了自己的提交上，改动检查照样看得到改动（基准是宿主镜像），照样推。
  assert.equal(setup.pushed.length, 1, '推了一次');
  const head = await git(['-C', setup.worktree(), 'rev-parse', 'refs/heads/' + setup.pushed[0].action.branch]);
  assert.equal(setup.pushed[0].head, head, 'bundle 里的提交就是 pi 的提交，空仓也能导入');
  // 推之后宿主还要用 pi 写过的工作树吗？不用：所有宿主 git 都在镜像里。
  const mirrorRuns = setup.hostRuns.filter((entry) => entry.args.includes('--git-dir'));
  assert.ok(mirrorRuns.some((entry) => entry.args.includes('diff')));
  for (const entry of mirrorRuns) {
    assert.equal(entry.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(entry.env.GIT_CONFIG_NOSYSTEM, '1');
  }
  // 对照：要是宿主像以前那样在工作树里 fetch，植入的东西真的会在宿主上跑（说明上面的「没留痕」不是假象）。
  const dir = setup.worktree();
  const env = { ...sandboxEnv() };
  delete env.IN_SANDBOX;
  await spawnRun('git', ['-C', dir, 'fetch', '-q', dir, '+HEAD:refs/remotes/origin/control'], { env });
  assert.ok(fs.readdirSync(setup.marks).length > 0, '对照组：宿主在工作树里跑 git 会触发植入的钩子 / 配置');
});

test('SC12 禁改路径对着宿主镜像的 main 比：pi 挪了工作树的 origin/main 也藏不住改动，不推', async () => {
  const setup = await hostileSetup({ forbiddenPaths: ['ci/**'] });
  assert.equal(setup.result.code, 1);
  assert.equal(setup.pushed.length, 0, '碰了禁改路径不推');
  assert.equal(setup.result.actions.some((action) => action.type === 'branch.push'), false);
  assertHostClean(setup);
});

test('SC3 bundle 头只用纯 JS 读：只认自带全部对象的 bundle，有前置提交 / 格式不对 / 没这条分支都不认', () => {
  const sha = 'a'.repeat(40);
  const ok = Buffer.from(`# v2 git bundle\n${sha} refs/heads/acceptance/1-2-sc3\n\nPACK`, 'latin1');
  assert.equal(bundleHead(ok, 'acceptance/1-2-sc3'), sha);
  assert.equal(bundleHead(Buffer.from(`# v3 git bundle\n@object-format=sha1\n${sha} refs/heads/b\n\nPACK`), 'b'), sha);
  assert.equal(bundleHead(ok, 'other'), null);
  assert.equal(bundleHead(Buffer.from(`# v2 git bundle\n-${'b'.repeat(40)} base\n${sha} refs/heads/b\n\nPACK`), 'b'), null);
  assert.equal(bundleHead(Buffer.from(`not a bundle\n${sha} refs/heads/b\n\n`), 'b'), null);
  assert.equal(bundleHead(Buffer.from(`# v2 git bundle\n${sha} refs/heads/b`), 'b'), null);
});

test('SC3 沙箱产出的 push.bundle 超过大小上限（512 MiB）：宿主不读、不推，bundle-failed', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const result = await runOnce({
    world,
    preflightRunner: async ({ commands, roundDir }) => {
      if (commands[0][1] === 'bundle') {
        const file = path.join(roundDir, 'push.bundle');
        fs.writeFileSync(file, `# v2 git bundle\n${'a'.repeat(40)} refs/heads/acceptance/1-2-sc3\n\n`);
        // 稀疏文件：不真占盘，大小超过上限。
        fs.truncateSync(file, 512 * 1024 ** 2 + 1);
      }
      return { ok: true, runs: [] };
    },
    overrides: { bundleFactory: undefined },
  });
  assert.equal(result.code, 1);
  assert.equal(result.actions.some((action) => action.type === 'branch.push'), false);
  const state = JSON.parse(fs.readFileSync(prbotStatePath(result.paths, CORRECTION_REF), 'utf8'));
  assert.equal(state.failureReason, 'bundle-failed');
});

test('SC3 沙箱把 push.bundle 换成指向宿主文件的符号链接：宿主不跟链接、不推，bundle-failed', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const secret = path.join(tmpDir(), 'host-secret.txt');
  fs.writeFileSync(secret, `# v2 git bundle\n${'a'.repeat(40)} refs/heads/acceptance/1-2-sc3\n\n`);
  const result = await runOnce({
    world,
    preflightRunner: async ({ commands, roundDir }) => {
      if (commands[0][1] === 'bundle') fs.symlinkSync(secret, path.join(roundDir, 'push.bundle'));
      return { ok: true, runs: [] };
    },
    overrides: { bundleFactory: undefined },
  });
  assert.equal(result.code, 1);
  assert.equal(result.actions.some((action) => action.type === 'branch.push'), false);
  const state = JSON.parse(fs.readFileSync(prbotStatePath(result.paths, CORRECTION_REF), 'utf8'));
  assert.equal(state.failureReason, 'bundle-failed');
});

// ---- #60 修正轮闭环修复 ----

test('#60 修正 1/7：修正 PR 正文带「Closes #n」；PR 开出后看板写「修正中」（修正子 issue + 总 issue）', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const result = await runOnce({ world, statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(result.code, 0, JSON.stringify(result.actions.map((action) => action.type)));
  const prCreate = result.actions.find((action) => action.type === 'pr.create');
  const lines = prCreate.body.split('\n');
  assert.equal(lines[0], `任务 issue：${REPO}#1`);
  assert.equal(lines[1], 'Closes #9');
  assert.equal(lines.at(-1), CORRECTION_MARKER);
  const board = result.actions.filter((action) => action.type === 'project.field.set');
  assert.deepEqual(board.map((action) => `${action.repo}#${action.issue}`), [CORRECTION_REF, `${REPO}#1`]);
  for (const action of board) assert.deepEqual(action.fields, { 验收: '修正中' });
  // 看板在 PR 开出之后才写。
  const at = (type) => result.actions.findIndex((action) => action.type === type);
  assert.ok(at('pr.create') < at('project.field.set'));
});

test('#60 修正 2：preflight 写成 [".githooks/pre-push"]（文档写法）照样跑；写错了需人工处理一次，进程不崩', async () => {
  assert.deepEqual(preflightCommands({ preflight: ['.githooks/pre-push', ['npm', 'test']] }), [['.githooks/pre-push'], ['npm', 'test']]);
  assert.deepEqual(preflightCommands({}), []);
  for (const bad of ['.githooks/pre-push', [1], [[]], [['npm', 2]], [''], { a: 1 }]) assert.equal(preflightCommands({ preflight: bad }), null, JSON.stringify(bad));

  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const sandboxed = [];
  const ok = await runOnce({
    world,
    hostConfig: { prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner', preflight: ['.githooks/pre-push'] } } } },
    preflightRunner: async ({ commands }) => {
      sandboxed.push(commands);
      return { ok: true, runs: [] };
    },
    statuses: [prStatus('c'.repeat(40), [greenRun()])],
  });
  assert.equal(ok.code, 0, JSON.stringify(ok.actions.map((action) => action.type)));
  assert.deepEqual(sandboxed[0], [['.githooks/pre-push']]);

  const badWorld = defaultTree({ roundStatus: '要修' });
  addCorrection(badWorld);
  const hostConfig = { prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner', preflight: '.githooks/pre-push' } } } };
  const first = await runOnce({ world: badWorld, hostConfig });
  assert.equal(first.code, 1);
  assert.deepEqual(first.allEvents.filter((event) => event.type === 'needs-human').map((event) => event.reason), ['preflight-config-invalid']);
  assert.equal(first.actions.some((action) => action.type === 'branch.push'), false);
});

test('#60 修正 3：写闸关着时认领 -> 安静停（3），不发需人工处理、不留状态；开闸后认领成功不会立刻「需人工处理」（真写闸）', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const paths = hostPaths(home);
  const realGate = ({ binding, profile }) =>
    createGate({ home, profile, github: createFakeGithub(world), run: async () => ({ code: 0, stdout: '', stderr: '' }), binding, which: async () => false });
  const run = (extra = {}) =>
    runOnce({
      world,
      home,
      overrides: {
        makeGate: realGate,
        // 沙箱起不来：认领之后这一轮记「中断」停下（只为看认领前后的行为）。
        piRunner: async () => ({ ok: false, unavailable: true }),
        ...extra,
      },
    });
  for (let tick = 0; tick < 3; tick += 1) {
    const closed = await run();
    assert.equal(closed.code, 3, `第 ${tick + 1} 拍`);
  }
  assert.deepEqual(readPrbotEvents(paths), [], '总开关关着：一条需人工处理都不发');
  assert.equal(fs.existsSync(prbotStatePath(paths, CORRECTION_REF)), false, '不留 gateCode 之类的状态');
  assert.equal(world.requireIssue(CORRECTION_REF).comments.length, 0, 'GitHub 上什么都没写');

  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.enabledFile, '1');
  const opened = await run();
  assert.equal(opened.code, 1);
  assert.deepEqual(readPrbotEvents(paths).map((event) => event.type), ['claimed'], '开闸后认领成功，没有立刻需人工处理');
  const comments = world.requireIssue(CORRECTION_REF).comments;
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /^\[修正机\] 第 1 轮：中断/);
});

test('#60 修正 3：PAUSED 在开跑前就在 -> 安静停；上一拍留下的 paused / gateCode 标志在条件消失后清掉，接着跑到 Ready', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  const correction = addCorrection(world);
  const existing = world.addComment(correction.ref, { body: '[修正机] 第 1 轮：等 CI', databaseId: 6101 });
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const paths = hostPaths(home);
  fs.mkdirSync(paths.prbotDir, { recursive: true });
  fs.writeFileSync(path.join(paths.prbotDir, 'PAUSED'), '');
  const paused = await runOnce({ world, home, statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(paused.code, 3);
  assert.deepEqual(paused.actions, []);
  fs.rmSync(path.join(paths.prbotDir, 'PAUSED'));
  // 旧版本留下的状态：paused / gateCode / gateBusyExhausted 都还在。
  fs.mkdirSync(paths.prbotRoundsDir, { recursive: true });
  fs.writeFileSync(
    prbotStatePath(paths, CORRECTION_REF),
    JSON.stringify({
      issue: CORRECTION_REF,
      root: `${REPO}#1`,
      item: `${REPO}#2`,
      sc: 3,
      round: 1,
      claimCommentId: existing.databaseId,
      stage: 'assess',
      status: '等 CI',
      steps: [],
      startedAt: new Date(Date.parse('2026-10-24T03:30:00.000Z')).toISOString(),
      mustFix: [],
      fixed: [],
      disputes: [],
      manual: [],
      paused: true,
      gateCode: 4,
      gateBusyExhausted: true,
      prRepo: REPO,
      pushRepo: REPO,
    }),
  );
  const resumed = await runOnce({ world, home, statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(resumed.code, 0, JSON.stringify(resumed.actions.map((action) => action.type)));
  assert.deepEqual(resumed.events, ['draft-opened', 'ready']);
  // 旧格式（UTC「Z」）的开始时间照样认：没算成超过 3 小时。
  assert.equal(resumed.allEvents.some((event) => event.reason === 'round-too-long'), false);
});

test('#60 修正 3：两轮用完又来了新的「要修」-> 只报一次需人工处理，不认领、不占槽；发现阶段之后也不再起进程', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  const correction = addCorrection(world);
  world.addComment(correction.ref, { body: '[修正机] 第 1 轮：需人工处理', databaseId: 6001, createdAt: '2026-10-24T02:00:00.000Z' });
  world.addComment(correction.ref, { body: '[修正机] 第 2 轮：需人工处理', databaseId: 6002, createdAt: '2026-10-24T03:00:00.000Z' });
  world.addComment(`${REPO}#1`, {
    ...roundComment({ round: 2, status: '要修', bodyVersion: bodyVersion(world.requireIssue(`${REPO}#1`).body), startedAt: '2026-10-25T01:00:00.000Z', databaseId: 1002 }),
  });
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const paths = hostPaths(home);
  // 两个槽都被占着：报需人工处理不需要槽。
  fs.mkdirSync(paths.slotsDir, { recursive: true });
  for (const name of ['slot-0', 'slot-1']) fs.writeFileSync(path.join(paths.slotsDir, name), JSON.stringify({ pid: process.pid }));
  for (let tick = 0; tick < 3; tick += 1) {
    const result = await runOnce({ world, home });
    assert.equal(result.code, 1);
    assert.deepEqual(result.actions, [], 'GitHub 上不写（修正轮绑定只认第 1、2 轮的认领）');
  }
  const events = readPrbotEvents(paths);
  assert.deepEqual(events.map((event) => `${event.type}:${event.reason}`), ['needs-human:limit-correction-rounds'], '每拍都跑，只报一次');
  assert.match(events[0].at, /\+08:00$/, '事件时间是北京时间');
  // 换一条更新的「要修」裁决：还是同一个原因、同一个修正，不再报。
  world.addComment(`${REPO}#1`, {
    ...roundComment({ round: 3, status: '要修', bodyVersion: bodyVersion(world.requireIssue(`${REPO}#1`).body), startedAt: '2026-10-26T01:00:00.000Z', databaseId: 1003 }),
  });
  await runOnce({ world, home });
  assert.equal(readPrbotEvents(paths).length, 1);
});

test('#60 修正 3：写闸忙（75）重试用完 -> 记「中断」（gate-busy），不是「需人工处理 / correction-rounds」', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  let pushes = 0;
  const result = await runOnce({
    world,
    onPush: () => {
      pushes += 1;
      return { code: 75, body: { reason: 'busy' } };
    },
  });
  assert.equal(result.code, 1);
  assert.equal(pushes, 7, '1 次 + 6 次重试');
  assert.deepEqual(result.allEvents.map((event) => `${event.type}:${event.reason || ''}`), ['claimed:', 'interrupted-exhausted:gate-busy']);
  const comment = world.requireIssue(CORRECTION_REF).comments.at(-1);
  assert.match(comment.body, /^\[修正机\] 第 1 轮：中断/);
  assert.match(comment.body, /写闸忙/);
});

test('#60 修正 3：同一原因同一修正只发一次需人工处理（终态评论没写上、下一拍再停也不重发）', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  // 「需人工处理」那条评论写不上（写闸拒绝）：GitHub 上这一轮还停在进行中，下一拍会再停一次。
  const onAction = (action) =>
    action.type === 'comment.update' && /：需人工处理/.test(action.body.split('\n')[0]) ? { code: 4, body: { reason: 'not-current-round' } } : undefined;
  for (let tick = 0; tick < 3; tick += 1) {
    const result = await runOnce({ world, home, diff: '', onAction });
    assert.equal(result.code, 1);
  }
  const human = readPrbotEvents(hostPaths(home)).filter((event) => event.type === 'needs-human');
  assert.deepEqual(human.map((event) => event.reason), ['no-change']);
});

test('#60 修正 4：推送带租约 —— 第一次是远端已知 head，再修重推是上一次推上去的 head', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const remote = 'f'.repeat(40);
  const first = 'c'.repeat(40);
  const second = 'e'.repeat(40);
  const worktree = path.join(tmpDir(), 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  const prepared = [];
  const result = await runOnce({
    world,
    heads: [first, second],
    statuses: [prStatus(first, [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE' }]), prStatus(second, [greenRun()])],
    overrides: {
      prepareWorktree: (options) => {
        prepared.push({ remoteHead: options.state.remoteHead, hasRemoteBranch: typeof options.remoteBranch === 'function' });
        // 第一次：远端已有这条分支（PR 关了还在 / 上一轮留下的）；之后：工作树就是上一次推的。
        return { worktree, mirror: path.join(tmpDir(), 'mirror'), remoteHead: prepared.length === 1 ? remote : options.state.remoteHead };
      },
      piRunner: async () => ({ ok: true, stdout: '', code: 0 }),
    },
  });
  assert.equal(result.code, 0, JSON.stringify(result.allEvents));
  assert.ok(prepared.every((entry) => entry.hasRemoteBranch), 'prepareWorktree 拿得到远端分支查询');
  const pushes = result.actions.filter((action) => action.type === 'branch.push');
  assert.deepEqual(pushes.map((action) => action.forceWithLease), [remote, first]);
  assert.equal(prepared[1].remoteHead, first);
});

test('#60 修正 5：Mivo 仓的修正轮整轮持测试锁（不看 host.json 的 testLock）；锁被验收轮占着就不认领', async () => {
  const MIVO = 'example-owner/mivo-app';
  const world = defaultTree({ roundStatus: '要修', rootRepo: MIVO });
  const correction = world.addIssue({ repo: MIVO, number: 9, title: '修正', body: `[验收机] 修正 · 总 ${MIVO}#1 · 项 ${MIVO}#2 SC3 · 第 1 轮` });
  world.addChild(`${MIVO}#1`, correction.ref);
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state'), autoRepos: [`${OWNER}/*`, REPO, MIVO] } });
  const paths = hostPaths(home);
  const hostConfig = { prbot: { piCommand: ['pi'], repos: { [MIVO]: { handoff: 'watcher' } } } };
  const seen = [];
  const lockHolder = () => {
    try {
      return JSON.parse(fs.readFileSync(paths.testLock, 'utf8')).pid;
    } catch {
      return null;
    }
  };
  const result = await runOnce({
    world,
    home,
    issue: correction.ref,
    hostConfig,
    statuses: [prStatus('c'.repeat(40), [greenRun()])],
    preflightRunner: async () => ({ ok: true, runs: [] }),
    onAction: (action) => {
      seen.push({ type: action.type, holder: lockHolder() });
      return undefined;
    },
  });
  assert.equal(result.code, 0, JSON.stringify(result.actions.map((action) => action.type)));
  assert.ok(seen.length > 3);
  assert.ok(seen.every((entry) => entry.holder === process.pid), '从认领到转 Ready 一直拿着测试锁');
  assert.equal(fs.existsSync(paths.testLock), false, '跑完放锁');

  // 验收轮（活着的进程）占着测试锁：修正轮这一拍不认领，返回 3。
  const other = defaultTree({ roundStatus: '要修', rootRepo: MIVO });
  const otherCorrection = other.addIssue({ repo: MIVO, number: 9, title: '修正', body: `[验收机] 修正 · 总 ${MIVO}#1 · 项 ${MIVO}#2 SC3 · 第 1 轮` });
  other.addChild(`${MIVO}#1`, otherCorrection.ref);
  fs.mkdirSync(path.dirname(paths.testLock), { recursive: true });
  fs.writeFileSync(paths.testLock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const blocked = await runOnce({ world: other, home, issue: otherCorrection.ref, hostConfig });
  assert.equal(blocked.code, 3);
  assert.deepEqual(blocked.actions, []);
  assert.equal(fs.existsSync(paths.testLock), true, '别人的锁不动');
  fs.rmSync(paths.testLock);
  // 不是 mivo 的仓不拿测试锁（锁文件不出现）。
  const plain = defaultTree({ roundStatus: '要修' });
  addCorrection(plain);
  const plainSeen = [];
  await runOnce({ world: plain, statuses: [prStatus('c'.repeat(40), [greenRun()])], onAction: () => void plainSeen.push(lockHolder()) });
  assert.ok(plainSeen.every((holder) => holder === null));
});

test('#60 修正 6：交接方式没在 host.json 显式配置 -> 不认领，需人工处理只报一次；进行中的轮次不转 Ready', async () => {
  assert.equal(handoffFor({ prbot: { repos: { [REPO]: { handoff: 'watcher' } } } }, REPO), 'watcher');
  assert.equal(handoffFor({ prbot: { repos: { [REPO.toUpperCase()]: { handoff: 'owner' } } } }, REPO), 'owner', '仓名不分大小写');
  assert.equal(handoffFor({ prbot: { repos: { [REPO]: {} } } }, REPO), null);
  assert.equal(handoffFor({ prbot: { repos: { [REPO]: { handoff: 'someone' } } } }, REPO), null);

  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const unconfigured = { prbot: { piCommand: ['pi'] } };
  for (let tick = 0; tick < 3; tick += 1) {
    const result = await runOnce({ world, home, hostConfig: unconfigured });
    assert.equal(result.code, 1);
    assert.deepEqual(result.actions, [], '不认领、不开 PR');
  }
  const events = readPrbotEvents(hostPaths(home));
  assert.deepEqual(events.map((event) => `${event.type}:${event.reason}`), ['needs-human:handoff-unconfigured']);

  // 已经在进行中的轮次（配置被删了）：一路走到转 Ready 前停下，需人工处理，不发 ready。
  const running = defaultTree({ roundStatus: '要修' });
  const correction = addCorrection(running);
  running.addComment(correction.ref, { body: '[修正机] 第 1 轮：等 CI', databaseId: 6201 });
  const result = await runOnce({ world: running, hostConfig: unconfigured, statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(result.code, 1);
  assert.equal(result.actions.some((action) => action.type === 'pr.ready'), false);
  assert.deepEqual(result.allEvents.filter((event) => event.type === 'needs-human').map((event) => event.reason), ['handoff-unconfigured']);
});

test('#60 修正 8：ready-stalled 只算 Ready 之后的人类活动；有人接了 / PR 已合并就不再查', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  fs.mkdirSync(paths.prbotReadyDir, { recursive: true });
  const readyAt = '2026-10-24T08:00:00.000+08:00';
  const write = (n) =>
    fs.writeFileSync(
      path.join(paths.prbotReadyDir, `example-owner__example-repo__${n}.json`),
      JSON.stringify({ issue: `${REPO}#${n}`, root: `${REPO}#1`, repo: REPO, pr: n, headSha: 'a'.repeat(40), readyAt, handoff: 'watcher', stalledAt: null }),
    );
  for (const n of [21, 22, 23]) write(n);
  const before = '2026-10-23T23:00:00.000Z';
  const after = '2026-10-24T01:00:00.000Z';
  const prs = {
    // 只有机器人评论、和 Ready 之前的人类评论：不算有人接，照样 ready-stalled。
    21: { state: 'OPEN', comments: [{ createdAt: after, author: { __typename: 'Bot', login: 'github-actions' } }, { createdAt: after, author: { login: 'ci-helper[bot]' } }, { createdAt: before, author: { __typename: 'User', login: OWNER } }] },
    // Ready 之后有人评论：有人接了。
    22: { state: 'OPEN', comments: [{ createdAt: after, author: { __typename: 'User', login: 'ReviewerUser' } }] },
    // 已合并。
    23: { state: 'MERGED', comments: [] },
  };
  const calls = [];
  const github = {
    async graphql(query, variables) {
      calls.push(variables.number);
      const pr = prs[variables.number];
      return {
        repository: {
          pullRequest: {
            number: variables.number,
            state: pr.state,
            reviews: { nodes: [] },
            comments: { nodes: pr.comments },
            commits: { nodes: [{ commit: { checkSuites: { nodes: [] } } }] },
          },
        },
      };
    },
  };
  const later = () => Date.parse(readyAt) + READY_STALL_MS + 1000;
  const stalled = await checkReadyStalled({ home, profile, github, now: later });
  assert.deepEqual(stalled.map((entry) => entry.pr), [21]);
  const entry = (n) => JSON.parse(fs.readFileSync(path.join(paths.prbotReadyDir, `example-owner__example-repo__${n}.json`), 'utf8'));
  assert.ok(entry(22).pickedUpAt);
  assert.ok(entry(23).closedAt);
  calls.length = 0;
  for (let tick = 0; tick < 3; tick += 1) await checkReadyStalled({ home, profile, github, now: () => later() + tick * 60000 });
  assert.deepEqual(calls, [], '有人接了 / 已合并 / 已报过的都不再每拍重查');
  assert.deepEqual(readPrbotEvents(paths).map((event) => `${event.type}:${event.pr}`), ['ready-stalled:21']);
});

test('#60 修正 8：发现阶段跳过已收尾的修正（不再每分钟起进程）；tick 先给验收轮留槽', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const world = defaultTree({ roundStatus: '要修', roundCommentUrl: 'https://example.invalid/c' });
  const correction = addCorrection(world);
  const github = {
    async graphql(query, variables) {
      if (query.includes('user(login')) {
        return {
          user: {
            open: { nodes: [inventoryNode(world, `${REPO}#1`)], pageInfo: { hasNextPage: false, endCursor: null } },
            closed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      }
      return world.graphql({ query, variables });
    },
  };
  const hostConfig = { prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } };
  assert.deepEqual((await discoverCorrections({ github, profile, home, hostConfig })).map((entry) => entry.issue), [CORRECTION_REF]);
  // 上一修正轮收尾了、总 issue 之后没有更新的「要修」：不起进程。
  world.addComment(correction.ref, { body: '[修正机] 第 1 轮：已 Ready', databaseId: 6301, createdAt: '2026-10-24T05:00:00.000Z' });
  assert.deepEqual(await discoverCorrections({ github, profile, home, hostConfig }), []);
  // 不传 hostConfig（老调用方）：照旧只看 GitHub 上的裁决。
  assert.equal((await discoverCorrections({ github, profile })).length, 1);

  // tick：这一拍有 1 个该开始的验收轮、2 个修正轮 —— 修正轮只起 1 个，给验收轮留 1 个槽。
  const tickHome = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } }).home;
  // 写闸总开关开着才起轮次（总开关关着时验收轮和修正轮都不起，见 host-round.test.mjs）。
  fs.mkdirSync(path.join(tickHome, 'state', 'write-gate'), { recursive: true });
  fs.writeFileSync(path.join(tickHome, 'state', 'write-gate', 'enabled'), '1');
  fs.writeFileSync(
    path.join(tickHome, 'config', 'host.json'),
    JSON.stringify({ piCommand: ['pi'], prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } }),
  );
  const startedPrbot = [];
  const startedRounds = [];
  await runTick({
    home: tickHome,
    env: { ...process.env, ACCEPTANCE_WATCHER_HOME: tickHome },
    run: async () => ({ code: 0, stdout: JSON.stringify([{ issue: `${REPO}#1`, kind: 'parent', tier: 'auto', nextRound: 2 }]), stderr: '' }),
    spawnRound: (issue) => {
      startedRounds.push(issue);
      return 900002;
    },
    spawnPrbot: (issue) => {
      startedPrbot.push(issue);
      return 900001;
    },
    discoverPrbot: async () => [{ issue: CORRECTION_REF }, { issue: `${REPO}#10` }],
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => Date.parse('2026-10-24T05:00:00.000Z'),
  });
  assert.deepEqual(startedPrbot, [CORRECTION_REF]);
  assert.deepEqual(startedRounds, [`${REPO}#1`]);
});

test('#60 修正 8：轮次 / 事件时间写北京时间 +08:00（旧的 UTC 格式照样能读）', async () => {
  assert.equal(beijingIso(Date.parse('2026-10-24T16:30:00.000Z')), '2026-10-25T00:30:00+08:00');
  assert.equal(Date.parse(beijingIso(Date.parse('2026-10-24T16:30:00.000Z'))), Date.parse('2026-10-24T16:30:00.000Z'));
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const result = await runOnce({ world, statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(result.code, 0);
  for (const event of result.allEvents) assert.match(event.at, /\+08:00$/, event.type);
  const state = JSON.parse(fs.readFileSync(prbotStatePath(result.paths, CORRECTION_REF), 'utf8'));
  for (const key of ['startedAt', 'updatedAt', 'readyAt']) assert.match(state[key], /\+08:00$/, key);
  assert.match(world.requireIssue(CORRECTION_REF).comments[0].body, /^开始：.*\+08:00$/m);
});

test('#60 修正 9：「有争议」写成单行（- 有争议：<ref> SC<k> · 验收方：… · 修正方：…），collect 认得出', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  // 最新裁决里写了这一条的原因：争议行的「验收方」照抄它。
  world.addComment(`${REPO}#1`, {
    ...roundComment({
      round: 2,
      status: '要修',
      bodyVersion: bodyVersion(world.requireIssue(`${REPO}#1`).body),
      startedAt: '2026-10-24T03:00:00.000Z',
      databaseId: 1002,
      detail: `- 要修：${REPO}#2 SC3 · 原因：看板没写`,
    }),
  });
  const result = await runOnce({
    world,
    statuses: [prStatus('c'.repeat(40), [greenRun()])],
    overrides: { piRunner: async () => ({ ok: true, stdout: `有争议：${REPO}#2 SC3：看板本来就写了 · 见截图\n`, code: 0 }) },
  });
  assert.equal(result.code === 0 || result.code === 1, true);
  const body = world.requireIssue(CORRECTION_REF).comments[0].body;
  const lines = body.split('\n').filter((line) => line.startsWith('- 有争议'));
  assert.deepEqual(lines, [`- 有争议：${REPO}#2 SC3 · 验收方：看板没写 · 修正方：看板本来就写了 / 见截图`]);
  // collect（DISPUTE_ITEM）在同一行里取条目。
  assert.match(lines[0], /([\w.-]+\/[\w.-]+#\d+)\s*SC(\d+)/);
});

test('#60 修正 3：异常不弄崩进程 —— 报一次需人工处理（internal-error），下一拍再试', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  for (let tick = 0; tick < 2; tick += 1) {
    const result = await runOnce({
      world,
      home,
      overrides: {
        statusProvider: async () => {
          throw new Error('假的读失败');
        },
      },
    });
    assert.equal(result.code, 1);
  }
  const human = readPrbotEvents(hostPaths(home)).filter((event) => event.type === 'needs-human');
  assert.deepEqual(human.map((event) => event.reason), ['internal-error']);
  assert.match(human[0].detail, /假的读失败/);
});

test('#60 修正（#79 遗留）：修正轮写动作的 dedupeKey 带修正子 issue + 认领评论 id；改评论的 key 带正文摘要，同号重放不吞新内容', async () => {
  const world = defaultTree({ roundStatus: '要修' });
  addCorrection(world);
  const result = await runOnce({ world, statuses: [prStatus('c'.repeat(40), [greenRun()])] });
  assert.equal(result.code, 0);
  const claim = result.actions.find((action) => action.type === 'comment.create');
  assert.match(claim.dedupeKey, new RegExp(`^prbot:${CORRECTION_REF}:r1:s\\d+:claim$`), '认领带本次开始时间');
  const commentId = world.requireIssue(CORRECTION_REF).comments[0].databaseId;
  const writes = result.actions.filter((action) => action.type !== 'read.graphql' && action.type !== 'comment.create');
  assert.ok(writes.length > 5);
  for (const action of writes) assert.ok(action.dedupeKey.startsWith(`prbot:${CORRECTION_REF}:r1:c${commentId}:`), action.dedupeKey);
  const updates = result.actions.filter((action) => action.type === 'comment.update');
  assert.equal(new Set(updates.map((action) => action.dedupeKey)).size, updates.length);
  // 同一个 commentSeq、不同正文：key 不同（本地状态丢了从头数也不会撞上旧结果）。
  const seqOf = (key) => key.split(':comment:')[1].split(':')[0];
  assert.ok(updates.every((action) => /:comment:\d+:[0-9a-f]{16}$/.test(action.dedupeKey)));
  assert.equal(seqOf(updates[0].dedupeKey), '1');
});
