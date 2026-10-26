// #60 写闸 contract：修正轮绑定、两个 gate-action、watch 档拒绝、静态 guard、github 出口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { MIRROR_GIT_HARDENING, createGithub } from './bin/github.mjs';
import {
  PR_HEAD_QUERY,
  PR_READY_QUERY,
  createGate,
} from './host/write-gate.mjs';
import { hostPaths } from './host/paths.mjs';
import { defaultTree } from './session.fixture.mjs';
import { HANDOFF_REPO, OWNER, REPO, createFakeRun, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import { PR_STATUS_QUERY } from './host/write-gate.mjs';
import { correctionIssueDetails, correctionIssueFacts, correctionPrBody, correctionPushRepo } from './host/prbot.mjs';
import { correctionBody } from './bin/correct.mjs';
import { bodyVersion } from './bin/rounds.mjs';

const HERE_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host');
const CORRECTION_MARKER = `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC3 · 第 1 轮`;
const BRANCH = 'acceptance/1-2-sc3';
const HEAD = 'a'.repeat(40);

function setup({ roundStatus = '要修' } = {}) {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.enabledFile, '1');
  const world = defaultTree({ roundStatus });
  const correction = world.addIssue({ repo: REPO, number: 9, title: '修正', body: CORRECTION_MARKER });
  world.addChild(`${REPO}#1`, correction.ref);
  return { home, profile, paths, world, correction };
}

function correctionGithub(world, { prHead, onWrite } = {}) {
  const pr = {
    number: 12,
    url: `https://example.invalid/${REPO}/pull/12`,
    isDraft: true,
    headRefName: BRANCH,
    headRefOid: HEAD,
    headRepository: { nameWithOwner: REPO },
    isCrossRepository: false,
    baseRefName: 'main',
    mergeStateStatus: 'CLEAN',
    changedFiles: 1,
    additions: 2,
    deletions: 0,
    commits: {
      nodes: [
        {
          commit: {
            checkSuites: {
              nodes: [
                {
                  checkRuns: {
                    nodes: [
                      {
                        name: 'unit',
                        status: 'COMPLETED',
                        conclusion: 'SUCCESS',
                        databaseId: 1,
                        checkSuite: { workflowRun: { databaseId: 77 } },
                      },
                    ],
                  },
                },
              ],
            },
            statusCheckRollup: { contexts: { nodes: [] } },
          },
        },
      ],
    },
    ...prHead,
  };
  return {
    async graphql(query, variables) {
      if (query === PR_HEAD_QUERY || query === PR_READY_QUERY || query === PR_STATUS_QUERY) {
        return { repository: { pullRequest: { ...pr, number: variables.number } } };
      }
      return world.graphql({ query, variables });
    },
    async write(action) {
      if (onWrite) {
        const override = await onWrite(action);
        if (override !== undefined) return override;
      }
      return world.write(action);
    },
  };
}

function makeGate({ home, profile, github, binding }) {
  return createGate({
    home,
    profile,
    github,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    binding,
    which: async () => false,
  });
}

test('SC1/SC11 修正轮认领：第 1 轮可以，第 2 轮/第 3 轮按顺序；改评论只改同一条', async () => {
  const { home, profile, world } = setup();
  const issue = `${REPO}#9`;
  const claimGate = makeGate({
    home,
    profile,
    github: correctionGithub(world),
    binding: { kind: 'correction', issue, round: 1, commentId: null },
  });
  const wrong = await claimGate.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 9,
    body: '[修正机] 第 2 轮：修正中',
    dedupeKey: 'claim-wrong',
  });
  assert.equal(wrong.code, 4);
  assert.equal(wrong.body.reason, 'not-current-round');

  const claim = await claimGate.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 9,
    body: '[修正机] 第 1 轮：修正中',
    dedupeKey: 'claim-1',
  });
  assert.equal(claim.code, 0, JSON.stringify(claim));
  const commentId = claim.body.commentId;

  const gate = makeGate({
    home,
    profile,
    github: correctionGithub(world),
    binding: { kind: 'correction', issue, round: 1, commentId },
  });
  const update = await gate.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 9,
    commentId,
    body: '[修正机] 第 1 轮：Draft 已开',
    dedupeKey: 'update-1',
  });
  assert.equal(update.code, 0, JSON.stringify(update));
  const badStatus = await gate.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 9,
    commentId,
    body: '[修正机] 第 1 轮：乱写',
    dedupeKey: 'update-bad',
  });
  assert.equal(badStatus.body.reason, 'not-allowed');
  const otherComment = await gate.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 9,
    commentId: 424242,
    body: '[修正机] 第 1 轮：等 CI',
    dedupeKey: 'update-other',
  });
  assert.equal(otherComment.body.reason, 'not-allowed');

  const claim2 = (key) =>
    makeGate({
      home,
      profile,
      github: correctionGithub(world),
      binding: { kind: 'correction', issue, round: 2, commentId: null },
    }).handle({ type: 'comment.create', repo: REPO, issue: 9, body: '[修正机] 第 2 轮：修正中', dedupeKey: key });
  // 第 1 修正轮还在进行：不能认领第 2 轮。
  const busy = await claim2('claim-2-busy');
  assert.equal(busy.code, 4);
  assert.equal(busy.body.reason, 'round-in-progress');

  const finish = await gate.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 9,
    commentId,
    body: '[修正机] 第 1 轮：已 Ready',
    dedupeKey: 'update-finish',
  });
  assert.equal(finish.code, 0, JSON.stringify(finish));
  // 第 1 轮收尾了，但总 issue 之后还没有新的「要修」裁决：不开第 2 轮。
  const stale = await claim2('claim-2-stale');
  assert.equal(stale.code, 4);
  assert.equal(stale.body.reason, 'not-current-round');

  world.addComment(`${REPO}#1`, {
    ...roundComment({
      round: 2,
      status: '要修',
      bodyVersion: bodyVersion(world.requireIssue(`${REPO}#1`).body),
      startedAt: '2026-10-25T01:00:00.000Z',
      databaseId: 1002,
    }),
  });
  const second = await claim2('claim-2');
  assert.equal(second.code, 0, JSON.stringify(second));

  const gate2 = makeGate({
    home,
    profile,
    github: correctionGithub(world),
    binding: { kind: 'correction', issue, round: 2, commentId: second.body.commentId },
  });
  const finish2 = await gate2.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 9,
    commentId: second.body.commentId,
    body: '[修正机] 第 2 轮：需人工处理',
    dedupeKey: 'update-finish-2',
  });
  assert.equal(finish2.code, 0, JSON.stringify(finish2));
  world.addComment(`${REPO}#1`, {
    ...roundComment({
      round: 3,
      status: '要修',
      bodyVersion: bodyVersion(world.requireIssue(`${REPO}#1`).body),
      startedAt: '2026-10-26T01:00:00.000Z',
      databaseId: 1003,
    }),
  });
  // 第 2 轮收尾、总 issue 又出了新的「要修」：仍然不开第 3 修正轮（上限 2）。
  const third = await makeGate({
    home,
    profile,
    github: correctionGithub(world),
    binding: { kind: 'correction', issue, round: 3, commentId: null },
  }).handle({
    type: 'comment.create',
    repo: REPO,
    issue: 9,
    body: '[修正机] 第 3 轮：修正中',
    dedupeKey: 'claim-3',
  });
  assert.equal(third.code, 4);
  assert.equal(third.body.reason, 'not-current-round');
});

test('SC5 修正轮只允许这条分支的 Draft PR；别的分支 / 非 Draft 一律 4', async () => {
  const { home, profile, world } = setup();
  const issue = `${REPO}#9`;
  const claim = await makeGate({
    home,
    profile,
    github: correctionGithub(world),
    binding: { kind: 'correction', issue, round: 1, commentId: null },
  }).handle({ type: 'comment.create', repo: REPO, issue: 9, body: '[修正机] 第 1 轮：修正中', dedupeKey: 'claim' });
  const gate = makeGate({
    home,
    profile,
    github: correctionGithub(world, { onWrite: () => ({ pr: 12, url: `https://example.invalid/${REPO}/pull/12` }) }),
    binding: { kind: 'correction', issue, round: 1, commentId: claim.body.commentId },
  });
  const draft = await gate.handle({
    type: 'pr.create',
    repo: REPO,
    head: BRANCH,
    base: 'main',
    draft: true,
    title: '修正',
    body: [`任务 issue：${REPO}#1`, 'Closes #9', CORRECTION_MARKER].join('\n'),
    dedupeKey: 'pr-ok',
  });
  assert.equal(draft.code, 0, JSON.stringify(draft));

  const notDraft = await gate.handle({
    type: 'pr.create',
    repo: REPO,
    head: BRANCH,
    base: 'main',
    draft: false,
    title: '修正',
    body: CORRECTION_MARKER,
    dedupeKey: 'pr-not-draft',
  });
  assert.equal(notDraft.body.reason, 'not-allowed');
  const wrongBranch = await gate.handle({
    type: 'pr.create',
    repo: REPO,
    head: 'acceptance/1-2-sc4',
    base: 'main',
    draft: true,
    title: '修正',
    body: CORRECTION_MARKER,
    dedupeKey: 'pr-wrong-branch',
  });
  assert.equal(wrongBranch.body.reason, 'not-allowed');
  const foreignBody = await gate.handle({
    type: 'pr.create',
    repo: REPO,
    head: BRANCH,
    base: 'main',
    draft: true,
    title: '修正',
    body: `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC3 · 第 2 轮`,
    dedupeKey: 'pr-other-marker',
  });
  assert.equal(foreignBody.body.reason, 'not-allowed');
  // 非 fork 档：head 不许带任何仓前缀（别人的、我自己的都不行）。
  for (const prefixed of [`StrangerUser:${BRANCH}`, `${OWNER}:${BRANCH}`]) {
    const outcome = await gate.handle({
      type: 'pr.create',
      repo: REPO,
      head: prefixed,
      base: 'main',
      draft: true,
      title: '修正',
      body: [`任务 issue：${REPO}#1`, CORRECTION_MARKER].join('\n'),
      dedupeKey: `pr-prefixed-${prefixed}`,
    });
    assert.equal(outcome.code, 4, prefixed);
    assert.equal(outcome.body.reason, 'not-allowed', prefixed);
  }
});

test('SC6 auto 档可以 pr.update-branch / ci.rerun；watch 档两个都 4 tier-not-allowed', async () => {
  const { home, profile, world } = setup();
  const issue = `${REPO}#9`;
  const claim = await makeGate({
    home,
    profile,
    github: correctionGithub(world),
    binding: { kind: 'correction', issue, round: 1, commentId: null },
  }).handle({ type: 'comment.create', repo: REPO, issue: 9, body: '[修正机] 第 1 轮：修正中', dedupeKey: 'claim' });
  const written = [];
  const gate = makeGate({
    home,
    profile,
    github: correctionGithub(world, {
      onWrite: (action) => {
        written.push(action);
        return { ok: true, type: action.type };
      },
    }),
    binding: { kind: 'correction', issue, round: 1, commentId: claim.body.commentId },
  });
  const updated = await gate.handle({
    type: 'pr.update-branch',
    repo: REPO,
    pr: 12,
    headSha: HEAD,
    expectedHeadSha: HEAD,
    dedupeKey: 'update-branch-1',
  });
  assert.equal(updated.code, 0, JSON.stringify(updated));
  assert.equal(written[0].type, 'pr.update-branch');
  assert.equal(written[0].expectedHeadSha, HEAD);

  const rerun = await gate.handle({
    type: 'ci.rerun',
    repo: REPO,
    pr: 12,
    runId: 77,
    headSha: HEAD,
    dedupeKey: 'rerun-1',
  });
  assert.equal(rerun.code, 0, JSON.stringify(rerun));
  assert.equal(written[1].type, 'ci.rerun');
  assert.equal(written[1].runId, 77);

  // runId 必须是这个 PR 当前 head 上的 workflow run：别的 run 一律不重跑。
  const foreignRun = await gate.handle({
    type: 'ci.rerun',
    repo: REPO,
    pr: 12,
    runId: 78,
    headSha: HEAD,
    dedupeKey: 'rerun-foreign',
  });
  assert.equal(foreignRun.code, 4);
  assert.equal(foreignRun.body.reason, 'not-allowed');
  assert.equal(written.length, 2);

  const moved = await gate.handle({
    type: 'pr.update-branch',
    repo: REPO,
    pr: 12,
    headSha: 'b'.repeat(40),
    dedupeKey: 'update-branch-moved',
  });
  assert.equal(moved.body.reason, 'head-moved');

  // watch 档：修正子 issue 在 watchRepos 的仓里，整个修正轮不认领 / 不写。
  const watchWorld = defaultTree({ roundStatus: '要修' });
  const watchCorrection = watchWorld.addIssue({
    repo: HANDOFF_REPO,
    number: 31,
    title: '修正',
    body: `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC3 · 第 1 轮`,
  });
  watchWorld.addChild(`${REPO}#1`, watchCorrection.ref);
  for (const type of ['pr.update-branch', 'ci.rerun']) {
    const watchGate = makeGate({
      home,
      profile,
      github: correctionGithub(watchWorld),
      binding: { kind: 'correction', issue: `${HANDOFF_REPO}#31`, round: 1, commentId: null },
    });
    const outcome = await watchGate.handle({ type, repo: HANDOFF_REPO, pr: 12, headSha: HEAD, runId: 1, dedupeKey: `watch-${type}` });
    assert.equal(outcome.code, 4, type);
    assert.equal(outcome.body.reason, 'tier-not-allowed', type);
  }
});

test('SC9 静态：写闸、gate-actions、prbot 没有判门规则和 pr.merge', () => {
  const files = [
    path.join(HERE_HOST, 'write-gate.mjs'),
    ...fs.readdirSync(path.join(HERE_HOST, 'gate-actions')).map((name) => path.join(HERE_HOST, 'gate-actions', name)),
    ...fs
      .readdirSync(HERE_HOST)
      .filter((name) => /^prbot.*\.mjs$/.test(name))
      .map((name) => path.join(HERE_HOST, name)),
  ];
  const banned = ['gates.mjs', 'pr.merge', 'maintainer', '维护者', '受保护路径', 'protected', 'approve'];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const word of banned) {
      assert.equal(source.toLowerCase().includes(word.toLowerCase()), false, `${path.basename(file)} 含 ${word}`);
    }
  }
});

test('SC6 github 出口：update-branch / rerun 走 REST；fetchBranch 的令牌只在 GIT_CONFIG_* 环境里', async () => {
  const { home, profile } = writeProfile(tmpDir(), {
    tokenContent: 'fixture-token-not-real-1234567890',
    profile: { stateDir: path.join(tmpDir(), 'acc-state') },
  });
  const token = fs.readFileSync(path.join(home, 'secrets', 'github.token'), 'utf8');
  const apiCalls = [];
  const gitCalls = [];
  const run = createFakeRun({
    onApi: (args) => {
      apiCalls.push(args);
      return { ok: true };
    },
    onGit: (args, { env }) => {
      gitCalls.push({ args, env });
      if (args.includes('init')) fs.mkdirSync(args.at(-1), { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const github = createGithub({ profile, run });
  await github.write({ type: 'pr.update-branch', repo: REPO, pr: 12, expectedHeadSha: HEAD, dedupeKey: 'u' });
  assert.equal(apiCalls[0][1], '-X');
  assert.equal(apiCalls[0][2], 'PUT');
  assert.match(apiCalls[0][3], /\/pulls\/12\/update-branch$/);
  await github.write({ type: 'ci.rerun', repo: REPO, pr: 12, runId: 77, dedupeKey: 'r' });
  assert.equal(apiCalls[1][2], 'POST');
  assert.match(apiCalls[1][3], /\/actions\/runs\/77\/rerun-failed-jobs$/);

  const dir = path.join(tmpDir(), 'clone');
  await github.fetchBranch({ repo: REPO, branch: 'main', dir });
  assert.ok(gitCalls.length >= 2);
  for (const call of gitCalls) {
    assert.equal(call.args.join(' ').includes(token), false, '令牌不进 argv');
    assert.equal(String(call.env.GIT_CONFIG_VALUE_0 || '').includes(token), false, 'extraheader 里不是明文令牌');
    assert.equal(call.env.GH_TOKEN, undefined);
    // 宿主镜像上的 git：钩子关掉、不读系统 / 全局配置、--git-dir 指向镜像。
    assert.deepEqual(call.args.slice(0, MIRROR_GIT_HARDENING.length), MIRROR_GIT_HARDENING);
    assert.equal(call.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
  }
  const fetchCall = gitCalls.find((call) => call.args.includes('fetch'));
  assert.equal(fetchCall.args[fetchCall.args.indexOf('--git-dir') + 1], path.join(dir, '.git'));
  assert.ok(MIRROR_GIT_HARDENING.includes('core.hooksPath=/dev/null'));
  // 默认浅取 50；depth: 0 = 全量（修正轮的宿主镜像用它）。
  assert.ok(gitCalls.some((call) => call.args.includes('fetch') && call.args.includes('--depth=50')));
  gitCalls.length = 0;
  await github.fetchBranch({ repo: REPO, branch: 'main', dir, depth: 0 });
  const full = gitCalls.find((call) => call.args.includes('fetch'));
  assert.ok(full);
  assert.equal(full.args.some((arg) => arg.startsWith('--depth')), false);
});

async function claimedGate({ home, profile, world, github }) {
  const claim = await makeGate({
    home,
    profile,
    github,
    binding: { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: null },
  }).handle({ type: 'comment.create', repo: REPO, issue: 9, body: '[修正机] 第 1 轮：修正中', dedupeKey: 'claim' });
  assert.equal(claim.code, 0, JSON.stringify(claim));
  return makeGate({
    home,
    profile,
    github,
    binding: { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: claim.body.commentId },
  });
}

test('SC8 修正轮 pr.ready：本仓、这条分支、带同一修正标记、检查全绿才转；fork 来的 PR 拒绝', async () => {
  const { home, profile, world } = setup();
  const written = [];
  const github = correctionGithub(world, {
    prHead: { isCrossRepository: false, headRepository: { nameWithOwner: REPO }, body: CORRECTION_MARKER },
    onWrite: (action) => {
      if (action.type.startsWith('comment.')) return undefined;
      written.push(action);
      return { pr: 12, repo: REPO };
    },
  });
  const gate = await claimedGate({ home, profile, world, github });
  const ready = await gate.handle({ type: 'pr.ready', repo: REPO, pr: 12, headSha: HEAD, dedupeKey: 'ready-ok' });
  assert.equal(ready.code, 0, JSON.stringify(ready));
  assert.deepEqual(written.map((action) => action.type), ['pr.ready']);

  for (const [label, prHead] of [
    ['跨仓', { isCrossRepository: true, headRepository: { nameWithOwner: 'StrangerUser/example-repo' } }],
    ['字段缺失', { isCrossRepository: undefined }],
  ]) {
    const { home: h2, profile: p2, world: w2 } = setup();
    const foreign = correctionGithub(w2, {
      prHead: { body: CORRECTION_MARKER, ...prHead },
      onWrite: (action) => {
        if (action.type.startsWith('comment.')) return undefined;
        throw new Error('不该写');
      },
    });
    const g2 = await claimedGate({ home: h2, profile: p2, world: w2, github: foreign });
    const outcome = await g2.handle({ type: 'pr.ready', repo: REPO, pr: 12, headSha: HEAD, dedupeKey: `ready-${label}` });
    assert.equal(outcome.code, 4, label);
    assert.equal(outcome.body.reason, 'not-in-tree', label);
  }
});

test('SC5 fork 模式：只推 ownerLogin 名下的 fork；pr.ready 只认从这个 fork 来的跨仓 PR', async () => {
  const FORK_UPSTREAM = 'makecindy/cindy';
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  fs.mkdirSync(hostPaths(home).gateDir, { recursive: true });
  fs.writeFileSync(hostPaths(home).enabledFile, '1');
  const world = defaultTree({ roundStatus: '要修', rootRepo: FORK_UPSTREAM });
  const marker = `[验收机] 修正 · 总 ${FORK_UPSTREAM}#1 · 项 ${FORK_UPSTREAM}#2 SC3 · 第 1 轮`;
  const correction = world.addIssue({ repo: FORK_UPSTREAM, number: 9, title: '修正', body: marker });
  world.addChild(`${FORK_UPSTREAM}#1`, correction.ref);
  const forkRepo = correctionPushRepo({
    issue: correction.ref,
    marker: { root: `${FORK_UPSTREAM}#1` },
    fork: true,
    ownerLogin: profile.ownerLogin,
  });
  assert.equal(forkRepo, `${OWNER}/cindy`);
  // forkTargets 写了对照就推到对照的 fork（名字可以和上游不同）。
  assert.equal(
    correctionPushRepo({
      issue: correction.ref,
      marker: { root: `${FORK_UPSTREAM}#1` },
      fork: true,
      ownerLogin: profile.ownerLogin,
      forkTargets: { [FORK_UPSTREAM]: `${OWNER}/cindy-fork` },
    }),
    `${OWNER}/cindy-fork`,
  );

  let prHead = { isCrossRepository: true, headRepository: { nameWithOwner: forkRepo }, body: marker };
  const written = [];
  const github = {
    async graphql(query, variables) {
      if (query === PR_HEAD_QUERY || query === PR_READY_QUERY || query === PR_STATUS_QUERY) {
        return {
          repository: {
            pullRequest: {
              number: variables.number,
              isDraft: true,
              headRefName: BRANCH,
              headRefOid: HEAD,
              baseRefName: 'main',
              commits: {
                nodes: [
                  {
                    commit: {
                      checkSuites: { nodes: [{ checkRuns: { nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] } }] },
                      statusCheckRollup: { contexts: { nodes: [] } },
                    },
                  },
                ],
              },
              ...prHead,
            },
          },
        };
      }
      return world.graphql({ query, variables });
    },
    async write(action) {
      if (action.type === 'comment.create' || action.type === 'comment.update') return world.write(action);
      written.push(action);
      return { ok: true };
    },
  };
  const issue = correction.ref;
  const claim = await makeGate({ home, profile, github, binding: { kind: 'correction', issue, round: 1, commentId: null } }).handle({
    type: 'comment.create',
    repo: FORK_UPSTREAM,
    issue: 9,
    body: '[修正机] 第 1 轮：修正中',
    dedupeKey: 'fork-claim',
  });
  assert.equal(claim.code, 0, JSON.stringify(claim));
  const gate = makeGate({ home, profile, github, binding: { kind: 'correction', issue, round: 1, commentId: claim.body.commentId } });

  const ready = await gate.handle({ type: 'pr.ready', repo: FORK_UPSTREAM, pr: 5, headSha: HEAD, dedupeKey: 'fork-ready' });
  assert.equal(ready.code, 0, JSON.stringify(ready));

  prHead = { isCrossRepository: true, headRepository: { nameWithOwner: 'StrangerUser/cindy' }, body: marker };
  const stranger = await gate.handle({ type: 'pr.ready', repo: FORK_UPSTREAM, pr: 6, headSha: HEAD, dedupeKey: 'fork-stranger' });
  assert.equal(stranger.code, 4);
  assert.equal(stranger.body.reason, 'not-in-tree');

  const upstreamPush = await gate.handle({
    type: 'branch.push',
    repo: FORK_UPSTREAM,
    branch: BRANCH,
    bundlePath: '/nonexistent.bundle',
    dedupeKey: 'fork-upstream-push',
  });
  assert.equal(upstreamPush.code, 4);
  assert.equal(upstreamPush.body.reason, 'not-allowed');

  // fork 模式开 PR：head 只能是 ownerLogin:<分支>；不带前缀、别人的前缀、空前缀一律 4。
  const forkPr = (head, key) =>
    gate.handle({
      type: 'pr.create',
      repo: FORK_UPSTREAM,
      head,
      base: 'main',
      draft: true,
      title: '修正',
      // fork 档：修正子 issue 开在上游仓、PR 也开在上游 —— 同仓写法 Closes #n，合并进上游 main 时关掉。
      body: [`任务 issue：${FORK_UPSTREAM}#1`, 'Closes #9', marker].join('\n'),
      dedupeKey: key,
    });
  for (const bad of [BRANCH, `StrangerUser:${BRANCH}`, `:${BRANCH}`]) {
    const outcome = await forkPr(bad, `fork-pr-${bad}`);
    assert.equal(outcome.code, 4, bad);
    assert.equal(outcome.body.reason, 'not-allowed', bad);
  }
  const own = await forkPr(`${OWNER}:${BRANCH}`, 'fork-pr-own');
  assert.equal(own.code, 0, JSON.stringify(own));
  assert.deepEqual(written.map((action) => action.type), ['pr.ready', 'pr.create']);

  // 更新分支 / 重跑：head 必须在我自己的 fork；上游仓里、别人 fork 里的同名分支都不认（#68 复审）。
  const update = (key) =>
    gate.handle({ type: 'pr.update-branch', repo: FORK_UPSTREAM, pr: 5, expectedHeadSha: HEAD, dedupeKey: key });
  for (const headRepo of [FORK_UPSTREAM, 'StrangerUser/cindy']) {
    prHead = { isCrossRepository: headRepo !== FORK_UPSTREAM, headRepository: { nameWithOwner: headRepo }, mergeStateStatus: 'BEHIND', body: marker };
    const outcome = await update(`fork-update-${headRepo}`);
    assert.equal(outcome.code, 4, headRepo);
    assert.equal(outcome.body.reason, 'not-allowed', headRepo);
  }
  prHead = { isCrossRepository: true, headRepository: { nameWithOwner: forkRepo }, mergeStateStatus: 'BEHIND', body: marker };
  const mine = await update('fork-update-own');
  assert.equal(mine.code, 0, JSON.stringify(mine));
});

test('SC5 prbot 自己拼的修正 PR 正文过得了真写闸：标记照抄修正子 issue（验收轮号，不是修正轮号）', async () => {
  const { home, profile, world } = setup();
  const github = correctionGithub(world, {
    onWrite: (action) => (action.type.startsWith('comment.') ? undefined : { pr: 12, url: `https://example.invalid/${REPO}/pull/12` }),
  });
  const gate = await claimedGate({ home, profile, world, github });
  const state = {
    issue: `${REPO}#9`,
    prRepo: REPO,
    root: `${REPO}#1`,
    item: `${REPO}#2`,
    sc: 3,
    round: 2,
    correctionFacts: { scText: 'SC1 导出按钮在空列表时禁用。验证：unit', why: '空列表时仍可点击' },
    changedFiles: ['src/export.js', 'test/export.test.js'],
    preflight: { ok: true, commands: ['npm test'] },
    disputes: [{ ref: `${REPO}#2`, sc: 4, acceptance: '文案不对', reason: '文案由产品定' }],
  };
  const marker = { root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 1 };
  const body = correctionPrBody(state, marker);
  assert.equal(body.split('\n')[0], `任务 issue：${REPO}#1`);
  assert.equal(body.split('\n')[1], 'Closes #9', '修正 PR 合并后关掉修正子 issue（trigger 才会再验）');
  // 跨仓（修正子 issue 和 PR 不在同一个仓）写全名。
  assert.equal(correctionPrBody({ ...state, prRepo: 'example-owner/other-repo' }, marker).split('\n')[1], `Closes ${REPO}#9`);
  const created = await gate.handle({
    type: 'pr.create',
    repo: REPO,
    head: BRANCH,
    base: 'main',
    draft: true,
    title: '修正',
    body,
    dedupeKey: 'pr-from-prbot',
  });
  assert.equal(created.code, 0, JSON.stringify(created));
});

test('#93 SC1 SC2 SC4 修正 PR 正文按 task-pr/v1 和修正子 issue 逐段对应', () => {
  const issueBody = correctionBody({
    root: `${REPO}#1`,
    rootUrl: '',
    item: `${REPO}#2`,
    text: '导出按钮在空列表时禁用 | 不报错。验证：unit',
    why: '空列表时仍可点击',
    sc: 3,
    round: 1,
    fork: false,
  });
  const facts = correctionIssueFacts(issueBody);
  assert.equal(facts.scText, 'SC1 导出按钮在空列表时禁用 | 不报错。验证：unit');
  assert.equal(facts.why, '空列表时仍可点击');
  assert.deepEqual(correctionIssueDetails(issueBody), {
    scope: `修好 ${REPO}#2 SC3 所需的最小代码改动和复现测试，限原属 issue 的范围内（目标仓禁改路径照旧不碰）`,
    notDo: `不改 ${REPO}#2 的其它验收项，不扩大原属 issue 的范围`,
    dependencies: '无，随时可开工。',
  });
  // #96 之前开的修正子 issue 被复用时还是旧模板（「## 没过的原因」）：两种都读得出。
  const legacy = ['> 修正子 issue', '## 没过的验收项', '导出按钮', '## 没过的原因', '旧原因', '## 验收标准', '- [ ] SC1 导出按钮。验证：unit'].join('\n');
  assert.deepEqual(correctionIssueFacts(legacy), { scText: 'SC1 导出按钮。验证：unit', why: '旧原因' });
  // 旧模板没有这三段时留空，正文退回原来的写法。
  assert.deepEqual(correctionIssueDetails(legacy), { scope: '', notDo: '', dependencies: '' });
  const marker = { root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 1 };
  const base = { issue: `${REPO}#9`, prRepo: REPO, root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 1, correctionFacts: facts };
  const sectionsOf = (body) => {
    const out = new Map();
    let current = null;
    for (const line of body.split('\n')) {
      if (line.startsWith('## ')) out.set((current = line.slice(3)), []);
      else if (current) out.get(current).push(line);
    }
    return out;
  };

  const passed = correctionPrBody(
    {
      ...base,
      changedFiles: ['src/export.js', 'test/export.test.js'],
      preflight: { ok: true, commands: ['npm test', 'npm run lint'] },
      disputes: [{ ref: `${REPO}#2`, sc: 4, acceptance: '文案不对', reason: '文案由产品定' }],
    },
    marker,
  );
  const sections = sectionsOf(passed);
  assert.deepEqual([...sections.keys()], ['改了什么', '范围对照', '验收对照', '定下的决定', '未执行的验证', '风险与回滚']);
  for (const [name, lines] of sections) assert.ok(lines.some((line) => line.trim()), `「${name}」段不能是空的`);
  const rows = sections.get('验收对照').filter((line) => /^\|\s*SC\d+/.test(line));
  assert.equal(rows.length, 1, '只对修正子 issue 的 SC1');
  const cells = rows[0].split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());
  assert.equal(cells[0], 'SC1 导出按钮在空列表时禁用 \\| 不报错。验证：unit', 'SC 原文照抄，竖线转义');
  assert.equal(cells[1], '通过');
  assert.match(cells[2], /`npm test`、`npm run lint` 在沙箱通过/);
  assert.match(sections.get('改了什么').join('\n'), /本 PR 改了：`src\/export\.js`、`test\/export\.test\.js`/);
  assert.match(sections.get('范围对照').join('\n'), /`src\/export\.js`、`test\/export\.test\.js`/);
  assert.match(sections.get('定下的决定').join('\n'), /争议未修：.*#2 SC4/);
  assert.ok(!passed.split('\n').some((line) => /^\s*-\s*(有争议|要修)：/.test(line)), '不用验收机会解析的行头');
  assert.ok(!passed.split('\n').some((line) => /^\s*[-*]\s*\[[ xX]\]/.test(line)), '验收项不用勾选框');

  const noPreflight = correctionPrBody({ ...base, preflightNote: '没有配置预检，跳过' }, marker);
  const row = noPreflight.split('\n').find((line) => /^\|\s*SC1/.test(line));
  assert.match(row, /\| 待验证 \| — \|$/);
  assert.match(sectionsOf(noPreflight).get('未执行的验证').join('\n'), /没有配置预检/);
  assert.match(sectionsOf(noPreflight).get('范围对照').join('\n'), /见本 PR 的改动文件/);

  const unknown = correctionPrBody({ ...base, correctionFacts: { scText: '', why: '' } }, marker);
  assert.match(unknown, /^\| SC1 example-owner\/[\w.-]+#2 SC3 重新验收通过 \| 待验证 \| — \|$/m, '读不出 SC 原文时退回写验收项编号');
});

test('#93 SC1 修正 PR 正文的范围对照也逐段对应修正子 issue 的可改范围 / 不做 / 依赖', () => {
  const marker = { root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 1 };
  const base = {
    issue: `${REPO}#9`,
    prRepo: REPO,
    root: `${REPO}#1`,
    item: `${REPO}#2`,
    sc: 3,
    round: 1,
    changedFiles: ['src/export.js'],
    preflight: { ok: true, commands: ['npm test'] },
    correctionDetails: {
      scope: `- 修好 ${REPO}#2 SC3 所需的最小代码改动和复现测试，限原属 issue 的范围内`,
      notDo: `- 不改 ${REPO}#2 的其它验收项，不扩大原属 issue 的范围`,
      dependencies: '无，随时可开工。',
    },
  };
  const body = correctionPrBody(base, marker);
  const lines = body.slice(body.indexOf('## 范围对照'), body.indexOf('## 验收对照'));
  assert.match(lines, /范围（可改）：.*最小代码改动和复现测试/);
  assert.match(lines, /不做：.*不改 .*#2 的其它验收项/);
  assert.match(lines, /依赖：无，随时可开工。/);
});

test('#93 SC5 未执行的验证写清开 PR 时 CI 还没跑、SC1 合并后再验，不预写 CI 结论', () => {
  const marker = { root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 1 };
  const base = {
    issue: `${REPO}#9`,
    prRepo: REPO,
    root: `${REPO}#1`,
    item: `${REPO}#2`,
    sc: 3,
    round: 1,
    correctionFacts: { scText: 'SC1 导出按钮在空列表时禁用。验证：unit', why: '空列表时仍可点击' },
    changedFiles: ['src/export.js'],
    preflight: { ok: true, commands: ['npm test'] },
  };
  const sectionOf = (body) => body.slice(body.indexOf('## 未执行的验证'), body.indexOf('## 风险与回滚'));
  const section = sectionOf(correctionPrBody(base, marker));
  assert.match(section, /开 PR 时 CI 还没跑完/, '正文只写一次，不能把还没跑的 CI 写成结论');
  assert.match(section, /CI 结果看本 PR 的检查/, 'CI 结果指向 PR 的检查页');
  assert.match(section, /build \/ typecheck \/ test/, '必需检查也还没跑');
  assert.match(section, /SC1 由验收机在本 PR 合并、修正子 issue 关闭后再验/, 'SC1 等合并后由验收机再验');
  assert.doesNotMatch(section, /CI (?:已)?(?:通过|绿)|检查(?:已)?(?:全部)?通过/, '不能预写 CI 结论');

  const noPreflight = sectionOf(correctionPrBody({ ...base, preflight: undefined, preflightNote: '没有配置预检，跳过' }, marker));
  assert.match(noPreflight, /没有配置预检/);
  assert.match(noPreflight, /开 PR 时 CI 还没跑完/);
});

test('#60 修正 github 出口：branch.push 带租约只对 acceptance/ 分支生效（--force-with-lease=<分支>:<上次已知 head>），不带就不强推', async () => {
  const { home, profile } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const gitCalls = [];
  const run = createFakeRun({
    onGit: (args) => {
      gitCalls.push(args);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const github = createGithub({ profile, run });
  const bundlePath = path.join(tmpDir(), 'push.bundle');
  fs.writeFileSync(bundlePath, 'x');
  const pushArgs = () => gitCalls.find((args) => args.includes('push'));

  await github.write({ type: 'branch.push', repo: REPO, branch: BRANCH, bundlePath, dedupeKey: 'plain' });
  assert.equal(pushArgs().some((arg) => String(arg).startsWith('--force')), false, '不带租约就是普通推送');
  assert.equal(pushArgs().includes('+refs/heads/' + BRANCH), false);

  gitCalls.length = 0;
  await github.write({ type: 'branch.push', repo: REPO, branch: BRANCH, bundlePath, forceWithLease: HEAD, dedupeKey: 'lease' });
  assert.ok(pushArgs().includes(`--force-with-lease=refs/heads/${BRANCH}:${HEAD}`));
  gitCalls.length = 0;
  await github.write({ type: 'branch.push', repo: REPO, branch: BRANCH, bundlePath, forceWithLease: '', dedupeKey: 'lease-empty' });
  assert.ok(pushArgs().includes(`--force-with-lease=refs/heads/${BRANCH}:`), '空租约 = 远端必须还没有这条分支');

  // 别的分支、乱写的租约：一条 git 都不跑就拒。
  gitCalls.length = 0;
  await assert.rejects(github.write({ type: 'branch.push', repo: REPO, branch: 'main', bundlePath, forceWithLease: HEAD, dedupeKey: 'main' }), /acceptance\//);
  await assert.rejects(github.write({ type: 'branch.push', repo: REPO, branch: BRANCH, bundlePath, forceWithLease: 'HEAD~1', dedupeKey: 'bad' }), /SHA/);
  assert.equal(gitCalls.length, 0);
  assert.ok(home);
});

test('#60 修正 pr.ready：fork 仓名大小写不同也认；workflow 还在排队（suite 有了、run 还没有）不算全绿', async () => {
  const FORK_UPSTREAM = 'makecindy/cindy';
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  fs.mkdirSync(hostPaths(home).gateDir, { recursive: true });
  fs.writeFileSync(hostPaths(home).enabledFile, '1');
  const world = defaultTree({ roundStatus: '要修', rootRepo: FORK_UPSTREAM });
  const marker = `[验收机] 修正 · 总 ${FORK_UPSTREAM}#1 · 项 ${FORK_UPSTREAM}#2 SC3 · 第 1 轮`;
  const correction = world.addIssue({ repo: FORK_UPSTREAM, number: 9, title: '修正', body: marker });
  world.addChild(`${FORK_UPSTREAM}#1`, correction.ref);
  const green = { checkRuns: { nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }] } };
  let suites = [green];
  const written = [];
  const github = {
    async graphql(query, variables) {
      if (query === PR_HEAD_QUERY || query === PR_READY_QUERY || query === PR_STATUS_QUERY) {
        return {
          repository: {
            pullRequest: {
              number: variables.number,
              isDraft: true,
              headRefName: BRANCH,
              headRefOid: HEAD,
              baseRefName: 'main',
              isCrossRepository: true,
              // GitHub 返回的大小写和配置里的不一样。
              headRepository: { nameWithOwner: `${OWNER.toLowerCase()}/Cindy` },
              body: marker,
              commits: { nodes: [{ commit: { checkSuites: { nodes: suites }, statusCheckRollup: { contexts: { nodes: [] } } } }] },
            },
          },
        };
      }
      return world.graphql({ query, variables });
    },
    async write(action) {
      if (action.type.startsWith('comment.')) return world.write(action);
      written.push(action);
      return { ok: true };
    },
  };
  const claim = await makeGate({ home, profile, github, binding: { kind: 'correction', issue: correction.ref, round: 1, commentId: null } }).handle({
    type: 'comment.create',
    repo: FORK_UPSTREAM,
    issue: 9,
    body: '[修正机] 第 1 轮：修正中',
    dedupeKey: 'claim',
  });
  assert.equal(claim.code, 0, JSON.stringify(claim));
  const gate = makeGate({ home, profile, github, binding: { kind: 'correction', issue: correction.ref, round: 1, commentId: claim.body.commentId } });

  // 另一个 workflow 已经排上队，但一个 job 都还没出来：只看 check run 会当成全绿。
  suites = [green, { status: 'QUEUED', conclusion: null, workflowRun: { databaseId: 91 }, checkRuns: { nodes: [] } }];
  const queued = await gate.handle({ type: 'pr.ready', repo: FORK_UPSTREAM, pr: 5, headSha: HEAD, dedupeKey: 'ready-queued' });
  assert.equal(queued.code, 4);
  assert.equal(queued.body.reason, 'ready-precondition');
  assert.match(queued.body.detail, /workflow 91=QUEUED/);
  // workflow 起不来（没有 job 就失败了）也不算绿。
  suites = [green, { status: 'COMPLETED', conclusion: 'STARTUP_FAILURE', workflowRun: { databaseId: 92 }, checkRuns: { nodes: [] } }];
  const broken = await gate.handle({ type: 'pr.ready', repo: FORK_UPSTREAM, pr: 5, headSha: HEAD, dedupeKey: 'ready-broken' });
  assert.equal(broken.body.reason, 'ready-precondition');
  // 别的 App 自动建、永远不出 run 的 suite（没有 workflowRun）不挡。
  suites = [green, { status: 'QUEUED', conclusion: null, workflowRun: null, checkRuns: { nodes: [] } }];
  const ready = await gate.handle({ type: 'pr.ready', repo: FORK_UPSTREAM, pr: 5, headSha: HEAD, dedupeKey: 'ready-ok' });
  assert.equal(ready.code, 0, JSON.stringify(ready));
  assert.deepEqual(written.map((action) => action.type), ['pr.ready']);
});
