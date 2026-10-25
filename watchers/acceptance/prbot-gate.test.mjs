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
import { HANDOFF_REPO, REPO, createFakeRun, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

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
                    nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', databaseId: 1 }],
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
      if (query === PR_HEAD_QUERY || query === PR_READY_QUERY) {
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

  const second = await makeGate({
    home,
    profile,
    github: correctionGithub(world),
    binding: { kind: 'correction', issue, round: 2, commentId: null },
  }).handle({
    type: 'comment.create',
    repo: REPO,
    issue: 9,
    body: '[修正机] 第 2 轮：修正中',
    dedupeKey: 'claim-2',
  });
  assert.equal(second.code, 0, JSON.stringify(second));

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
});
