// #60 写闸 contract：修正轮绑定、两个 gate-action、watch 档拒绝、静态 guard、github 出口。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { createGithub } from './bin/github.mjs';
import {
  PR_HEAD_QUERY,
  PR_READY_QUERY,
  createGate,
} from './host/write-gate.mjs';
import { hostPaths } from './host/paths.mjs';
import { defaultTree } from './session.fixture.mjs';
import { HANDOFF_REPO, OWNER, REPO, createFakeRun, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import { PR_STATUS_QUERY } from './host/write-gate.mjs';
import { correctionPrBody, correctionPushRepo } from './host/prbot.mjs';
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
    body: [`任务 issue：${REPO}#1`, CORRECTION_MARKER].join('\n'),
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
    assert.equal(call.env.GIT_CONFIG_VALUE_0.includes(token), false, 'extraheader 里不是明文令牌');
    assert.equal(call.env.GH_TOKEN, undefined);
  }
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
      body: [`任务 issue：${FORK_UPSTREAM}#1`, marker].join('\n'),
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
});

test('SC5 prbot 自己拼的修正 PR 正文过得了真写闸：标记照抄修正子 issue（验收轮号，不是修正轮号）', async () => {
  const { home, profile, world } = setup();
  const github = correctionGithub(world, {
    onWrite: (action) => (action.type.startsWith('comment.') ? undefined : { pr: 12, url: `https://example.invalid/${REPO}/pull/12` }),
  });
  const gate = await claimedGate({ home, profile, world, github });
  const state = { root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 2 };
  const marker = { root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 1 };
  const body = correctionPrBody(state, marker);
  assert.equal(body.split('\n')[0], `任务 issue：${REPO}#1`);
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
