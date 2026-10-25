// #60 修正轮写闸：prbot-gate-check.mjs 里每条守卫一个测试。
// 每条都带对照：只改被测的那一个条件，同一个动作应放行（code 0），证明拒绝来自这条守卫。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion } from './bin/rounds.mjs';
import { PR_HEAD_QUERY, PR_READY_QUERY, PR_STATUS_QUERY, createGate } from './host/write-gate.mjs';
import { hostPaths } from './host/paths.mjs';
import { defaultTree } from './session.fixture.mjs';
import {
  HANDOFF_REPO,
  OTHER_REPO,
  OWNER,
  REPO,
  roundComment,
  tmpDir,
  writeProfile,
} from './fake-gh.fixture.mjs';

const BRANCH = 'acceptance/1-2-sc3';
const HEAD = 'a'.repeat(40);
const AUTO_REPOS = [`${OWNER}/*`, REPO];

function markerFor(rootRepo) {
  return `[验收机] 修正 · 总 ${rootRepo}#1 · 项 ${rootRepo}#2 SC3 · 第 1 轮`;
}

/** 假 world + 打开的修正子 issue（正文带修正标记，挂在总 issue 下）。 */
function setup({
  rootRepo = REPO,
  correctionRepo = REPO,
  correctionNumber = 9,
  roundStatus = '要修',
  profile: profileOverride,
} = {}) {
  const { home } = writeProfile(tmpDir(), {
    profile: {
      stateDir: path.join(tmpDir(), 'acc-state'),
      ...(profileOverride || {}),
    },
  });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.enabledFile, '1');
  const world = defaultTree({ roundStatus, rootRepo });
  const marker = markerFor(rootRepo);
  const correction = world.addIssue({ repo: correctionRepo, number: correctionNumber, title: '修正', body: marker });
  world.addChild(`${rootRepo}#1`, correction.ref);
  return { home, profile, paths, world, correction, marker, rootRef: `${rootRepo}#1`, correctionRef: correction.ref };
}

/** 标准假 PR：本仓、main、非跨仓、队首检查全绿。 */
function prFor(repo, overrides = {}) {
  return {
    number: 12,
    url: `https://example.invalid/${repo}/pull/12`,
    isDraft: true,
    headRefName: BRANCH,
    headRefOid: HEAD,
    mergeStateStatus: 'CLEAN',
    changedFiles: 1,
    additions: 2,
    deletions: 0,
    isCrossRepository: false,
    headRepository: { nameWithOwner: repo },
    baseRefName: 'main',
    body: '',
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
    ...overrides,
  };
}

function fakeGithub(world, { pr, onWrite } = {}) {
  const pullRequest = pr || prFor(REPO);
  return {
    async graphql(query, variables) {
      if (query === PR_HEAD_QUERY || query === PR_READY_QUERY || query === PR_STATUS_QUERY) {
        return { repository: { pullRequest: { ...pullRequest, number: variables.number } } };
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

function makeGate({ home, profile, github, binding, run }) {
  return createGate({
    home,
    profile,
    github,
    run: run || (async () => ({ code: 0, stdout: '', stderr: '' })),
    binding,
    which: async () => false,
  });
}

function gateFor(s, binding, { pr, onWrite, run } = {}) {
  return makeGate({
    home: s.home,
    profile: s.profile,
    github: fakeGithub(s.world, { pr, onWrite }),
    binding,
    run,
  });
}

function claimAction({ issue = 9, round = 1, body, repo = REPO, dedupeKey }) {
  return {
    type: 'comment.create',
    repo,
    issue,
    body: body ?? `[修正机] 第 ${round} 轮：修正中`,
    dedupeKey,
  };
}

/** 在修正子 issue 上加一条轮次评论（作者是我），返回评论。 */
function addCorrectionRound(world, ref, { round, status, createdAt, databaseId }) {
  return world.addComment(ref, {
    body: `[修正机] 第 ${round} 轮：${status}\n开始：${createdAt}`,
    createdAt,
    databaseId: databaseId ?? 2000 + round,
  });
}

/** 在总 issue 上加一条验收轮次评论。 */
function addRootRound(world, rootRef, { round, status, createdAt, databaseId }) {
  return world.addComment(rootRef, {
    ...roundComment({
      round,
      status,
      bodyVersion: bodyVersion(world.requireIssue(rootRef).body),
      startedAt: createdAt,
      databaseId: databaseId ?? 1000 + round,
    }),
  });
}

/** branch.push 放行的对照用：假 git 只回一个合法提交号，其余命令当成功。 */
function pushRun() {
  return async (cmd, args) => {
    if (cmd === 'git' && args.includes('rev-parse')) return { code: 0, stdout: `${HEAD}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
}

function pushBundle() {
  const file = path.join(tmpDir('acceptance-push-'), 'push.bundle');
  fs.writeFileSync(file, 'fake bundle');
  return file;
}

test('守卫 1 verdict-not-fix：总 issue 最新轮次不是「要修」/ 没有轮次都拒绝认领', async () => {
  const passed = setup({ roundStatus: '通过' });
  const passedOutcome = await gateFor(passed, {
    kind: 'correction',
    issue: `${REPO}#9`,
    round: 1,
    commentId: null,
  }).handle(claimAction({ dedupeKey: 'verdict-passed' }));
  assert.equal(passedOutcome.code, 4);
  assert.equal(passedOutcome.body.reason, 'verdict-not-fix');

  const none = setup();
  none.world.requireIssue(`${REPO}#1`).comments.length = 0;
  const noneOutcome = await gateFor(none, {
    kind: 'correction',
    issue: `${REPO}#9`,
    round: 1,
    commentId: null,
  }).handle(claimAction({ dedupeKey: 'verdict-none' }));
  assert.equal(noneOutcome.code, 4);
  assert.equal(noneOutcome.body.reason, 'verdict-not-fix');

  // 对照：只把最新轮次换回「要修」。
  const fixing = setup({ roundStatus: '要修' });
  const ok = await gateFor(fixing, {
    kind: 'correction',
    issue: `${REPO}#9`,
    round: 1,
    commentId: null,
  }).handle(claimAction({ dedupeKey: 'verdict-fixing' }));
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 2 tier-not-allowed：总 issue 的 tree 不是 auto 档（watch 仓）就拒绝', async () => {
  // 总 issue 在 watch 档仓 HANDOFF_REPO，修正子 issue 在 auto 档仓 REPO。
  const watchTree = setup({ rootRepo: HANDOFF_REPO, correctionRepo: REPO });
  const rejected = await gateFor(watchTree, {
    kind: 'correction',
    issue: `${REPO}#9`,
    round: 1,
    commentId: null,
  }).handle(claimAction({ dedupeKey: 'tree-watch' }));
  assert.equal(rejected.code, 4);
  assert.equal(rejected.body.reason, 'tier-not-allowed');

  // 对照：只把总 issue 换到 auto 档仓 REPO。
  const autoTree = setup({ rootRepo: REPO, correctionRepo: REPO });
  const ok = await gateFor(autoTree, {
    kind: 'correction',
    issue: `${REPO}#9`,
    round: 1,
    commentId: null,
  }).handle(claimAction({ dedupeKey: 'tree-auto' }));
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 3 tier-not-allowed：修正子 issue 所在仓不是 auto 档（watch 仓）就拒绝', async () => {
  // tree 是 auto 档（总 issue 在 REPO），但修正子 issue 在 watch 档仓 HANDOFF_REPO。
  const watchCorrection = setup({ rootRepo: REPO, correctionRepo: HANDOFF_REPO, correctionNumber: 31 });
  const rejected = await gateFor(watchCorrection, {
    kind: 'correction',
    issue: `${HANDOFF_REPO}#31`,
    round: 1,
    commentId: null,
  }).handle(claimAction({ repo: HANDOFF_REPO, issue: 31, dedupeKey: 'correction-repo-watch' }));
  assert.equal(rejected.code, 4);
  assert.equal(rejected.body.reason, 'tier-not-allowed');

  // 对照：只把修正子 issue 换到 auto 档仓 REPO。
  const autoCorrection = setup({ rootRepo: REPO, correctionRepo: REPO });
  const ok = await gateFor(autoCorrection, {
    kind: 'correction',
    issue: `${REPO}#9`,
    round: 1,
    commentId: null,
  }).handle(claimAction({ repo: REPO, issue: 9, dedupeKey: 'correction-repo-auto' }));
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 4 not-current-round：commentId 为 null 的绑定只能新建评论，别的动作一律拒绝', async () => {
  const s = setup();
  // 修正子 issue 上先有一条普通评论：comment.update 若绕过守卫会真的写成功。
  const existing = s.world.addComment(s.correctionRef, {
    body: '占位评论',
    createdAt: '2026-10-24T00:30:00.000Z',
  });
  const gate = gateFor(s, { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: null });
  const actions = [
    // 首行和认领评论一模一样，但动作是「改评论」而不是「新建评论」。
    { type: 'comment.update', repo: REPO, issue: 9, commentId: existing.databaseId, body: '[修正机] 第 1 轮：修正中' },
    { type: 'comment.update', repo: REPO, issue: 9, commentId: existing.databaseId, body: '[修正机] 第 1 轮：等 CI' },
    { type: 'issue.edit', repo: REPO, issue: 9, body: '- [ ] SC3 x' },
    { type: 'branch.push', repo: REPO, branch: BRANCH, bundlePath: path.join(tmpDir(), 'x.bundle') },
  ];
  for (const [index, action] of actions.entries()) {
    const outcome = await gate.handle({ ...action, dedupeKey: `claim-only-new-${index}-${action.type}` });
    assert.equal(outcome.code, 4, `${index} ${action.type}`);
    assert.equal(outcome.body.reason, 'not-current-round', `${index} ${action.type}`);
  }

  // 对照：同一条绑定换成 comment.create。
  const ok = await gate.handle(claimAction({ dedupeKey: 'claim-only-new-create' }));
  assert.equal(ok.code, 0, JSON.stringify(ok));
  assert.ok(ok.body.commentId);
});

test('守卫 5 not-current-round：认领只能发在修正子 issue 上，发到总 issue 拒绝', async () => {
  const s = setup();
  const gate = gateFor(s, { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: null });
  const wrong = await gate.handle(claimAction({ repo: REPO, issue: 1, dedupeKey: 'claim-root-issue' }));
  assert.equal(wrong.code, 4);
  assert.equal(wrong.body.reason, 'not-current-round');

  // 对照：只把评论发到修正子 issue。
  const ok = await gate.handle(claimAction({ repo: REPO, issue: 9, dedupeKey: 'claim-correction-issue' }));
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 6 not-current-round：认领轮号必须是 max+1，且绑定轮号和评论里的轮号要一致', async () => {
  const s = setup({ roundStatus: '要修' });
  // 已有第 1 修正轮（终态），之后总 issue 又出了新的「要修」。
  addCorrectionRound(s.world, s.correctionRef, { round: 1, status: '已 Ready', createdAt: '2026-10-24T02:00:00.000Z' });
  addRootRound(s.world, s.rootRef, { round: 2, status: '要修', createdAt: '2026-10-24T03:00:00.000Z' });

  const claimAs = (round, body, dedupeKey) =>
    gateFor(s, { kind: 'correction', issue: `${REPO}#9`, round, commentId: null }).handle(
      claimAction({ body, dedupeKey }),
    );

  const first = await claimAs(1, '[修正机] 第 1 轮：修正中', 'round-1-again');
  assert.equal(first.code, 4);
  assert.equal(first.body.reason, 'not-current-round');

  const third = await claimAs(3, '[修正机] 第 3 轮：修正中', 'round-3-claim');
  assert.equal(third.code, 4);
  assert.equal(third.body.reason, 'not-current-round');

  const mismatch = await claimAs(2, '[修正机] 第 1 轮：修正中', 'round-binding-mismatch');
  assert.equal(mismatch.code, 4);
  assert.equal(mismatch.body.reason, 'not-current-round');

  // 对照：只把轮号改成 max+1（第 2 轮），绑定轮号也一致。
  const second = await claimAs(2, '[修正机] 第 2 轮：修正中', 'round-2-claim');
  assert.equal(second.code, 0, JSON.stringify(second));
});

test('守卫 7 not-current-round：终态轮次（已 Ready / 需人工处理 / 中断）不能再写', async () => {
  for (const status of ['已 Ready', '需人工处理', '中断']) {
    const s = setup();
    const round = addCorrectionRound(s.world, s.correctionRef, {
      round: 1,
      status,
      createdAt: '2026-10-24T02:00:00.000Z',
    });
    const gate = gateFor(s, {
      kind: 'correction',
      issue: `${REPO}#9`,
      round: 1,
      commentId: round.databaseId,
    });
    const update = await gate.handle({
      type: 'comment.update',
      repo: REPO,
      issue: 9,
      commentId: round.databaseId,
      body: '[修正机] 第 1 轮：等 CI',
      dedupeKey: `terminal-${status}-update`,
    });
    assert.equal(update.code, 4, status);
    assert.equal(update.body.reason, 'not-current-round', status);
    const push = await gate.handle({
      type: 'branch.push',
      repo: REPO,
      branch: BRANCH,
      bundlePath: path.join(tmpDir(), 'x.bundle'),
      dedupeKey: `terminal-${status}-push`,
    });
    assert.equal(push.code, 4, status);
    assert.equal(push.body.reason, 'not-current-round', status);
  }

  // 对照：只把最新一轮换成进行中的状态。
  const s = setup();
  const running = addCorrectionRound(s.world, s.correctionRef, {
    round: 1,
    status: '修正中',
    createdAt: '2026-10-24T02:00:00.000Z',
  });
  const gate = gateFor(s, {
    kind: 'correction',
    issue: `${REPO}#9`,
    round: 1,
    commentId: running.databaseId,
  });
  const ok = await gate.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 9,
    commentId: running.databaseId,
    body: '[修正机] 第 1 轮：等 CI',
    dedupeKey: 'terminal-control-update',
  });
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 8 not-allowed：branch.push 只能推 acceptance/<总>-<项>-sc<k>', async () => {
  const s = setup();
  const round = addCorrectionRound(s.world, s.correctionRef, {
    round: 1,
    status: '修正中',
    createdAt: '2026-10-24T02:00:00.000Z',
  });
  const binding = { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: round.databaseId };
  const bundlePath = pushBundle();
  const gate = gateFor(s, binding, { run: pushRun() });
  const wrong = await gate.handle({
    type: 'branch.push',
    repo: REPO,
    branch: 'acceptance/1-2-sc4',
    bundlePath,
    dedupeKey: 'push-wrong-branch',
  });
  assert.equal(wrong.code, 4);
  assert.equal(wrong.body.reason, 'not-allowed');

  // 对照：只把分支名改成 acceptance/1-2-sc3。
  const ok = await gate.handle({
    type: 'branch.push',
    repo: REPO,
    branch: BRANCH,
    bundlePath,
    dedupeKey: 'push-right-branch',
  });
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 9 not-allowed：branch.push 不能推到不相干的仓（分支名对也不行）', async () => {
  const s = setup({ profile: { autoRepos: [...AUTO_REPOS, OTHER_REPO] } });
  const round = addCorrectionRound(s.world, s.correctionRef, {
    round: 1,
    status: '修正中',
    createdAt: '2026-10-24T02:00:00.000Z',
  });
  const binding = { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: round.databaseId };
  const bundlePath = pushBundle();
  const gate = gateFor(s, binding, { run: pushRun() });
  const wrong = await gate.handle({
    type: 'branch.push',
    repo: OTHER_REPO,
    branch: BRANCH,
    bundlePath,
    dedupeKey: 'push-foreign-repo',
  });
  assert.equal(wrong.code, 4);
  assert.equal(wrong.body.reason, 'not-allowed');

  // 对照：只把仓改成修正子 issue 所在的 REPO。
  const ok = await gate.handle({
    type: 'branch.push',
    repo: REPO,
    branch: BRANCH,
    bundlePath,
    dedupeKey: 'push-own-repo',
  });
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 10 not-allowed：pr.create 正文必须带同一个修正标记（root/item/sc/round 任一不同都拒）', async () => {
  const s = setup();
  const round = addCorrectionRound(s.world, s.correctionRef, {
    round: 1,
    status: '修正中',
    createdAt: '2026-10-24T02:00:00.000Z',
  });
  const binding = { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: round.databaseId };
  const gate = gateFor(s, binding, { onWrite: () => ({ pr: 12, url: `https://example.invalid/${REPO}/pull/12` }) });
  const create = (body, dedupeKey) =>
    gate.handle({
      type: 'pr.create',
      repo: REPO,
      head: BRANCH,
      base: 'main',
      draft: true,
      title: '修正',
      body,
      dedupeKey,
    });

  for (const [label, body] of [
    ['无标记', `任务 issue：${REPO}#1`],
    ['root 不同', markerFor(OTHER_REPO)],
    // #70 复审：只有 root 不同（item / sc / round 都和本轮一样）也要拒。
    ['只有 root 不同', `[验收机] 修正 · 总 ${REPO}#99 · 项 ${REPO}#2 SC3 · 第 1 轮`],
    ['item 不同', `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#7 SC3 · 第 1 轮`],
    ['sc 不同', `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC4 · 第 1 轮`],
    ['round 不同', `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC3 · 第 2 轮`],
  ]) {
    const outcome = await create(body, `pr-marker-${label}`);
    assert.equal(outcome.code, 4, label);
    assert.equal(outcome.body.reason, 'not-allowed', label);
  }

  // 对照：只把正文换成同一个修正标记。
  const ok = await create(s.marker, 'pr-marker-right');
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 11 not-allowed：pr.create 不能开在别的仓', async () => {
  const s = setup({ profile: { autoRepos: [...AUTO_REPOS, OTHER_REPO] } });
  const round = addCorrectionRound(s.world, s.correctionRef, {
    round: 1,
    status: '修正中',
    createdAt: '2026-10-24T02:00:00.000Z',
  });
  const binding = { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: round.databaseId };
  const gate = gateFor(s, binding, {
    onWrite: () => ({ pr: 12, url: `https://example.invalid/${REPO}/pull/12` }),
  });
  const create = (repo, dedupeKey) =>
    gate.handle({
      type: 'pr.create',
      repo,
      head: BRANCH,
      base: 'main',
      draft: true,
      title: '修正',
      body: s.marker,
      dedupeKey,
    });

  const wrong = await create(OTHER_REPO, 'pr-foreign-repo');
  assert.equal(wrong.code, 4);
  assert.equal(wrong.body.reason, 'not-allowed');

  // 对照：只把仓改成修正子 issue 所在的 REPO。
  const ok = await create(REPO, 'pr-own-repo');
  assert.equal(ok.code, 0, JSON.stringify(ok));
});

test('守卫 12 not-allowed：pr.ready / pr.update-branch / ci.rerun 都要核对 PR 的 head 分支名', async () => {
  const cases = [
    ['pr.ready', (dedupeKey) => ({ type: 'pr.ready', repo: REPO, pr: 12, headSha: HEAD, dedupeKey })],
    [
      'pr.update-branch',
      (dedupeKey) => ({
        type: 'pr.update-branch',
        repo: REPO,
        pr: 12,
        headSha: HEAD,
        expectedHeadSha: HEAD,
        dedupeKey,
      }),
    ],
    ['ci.rerun', (dedupeKey) => ({ type: 'ci.rerun', repo: REPO, pr: 12, runId: 77, headSha: HEAD, dedupeKey })],
  ];
  const onWrite = (action) => (action.type.startsWith('comment.') ? undefined : { ok: true, type: action.type });

  for (const [label, build] of cases) {
    // PR 的 head 分支是别的分支。
    const moved = setup();
    const movedRound = addCorrectionRound(moved.world, moved.correctionRef, {
      round: 1,
      status: '修正中',
      createdAt: '2026-10-24T02:00:00.000Z',
    });
    const movedGate = gateFor(
      moved,
      { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: movedRound.databaseId },
      {
        pr: prFor(REPO, { headRefName: 'acceptance/1-2-sc4', body: moved.marker }),
        onWrite,
      },
    );
    const rejected = await movedGate.handle(build(`head-mismatch-${label}`));
    assert.equal(rejected.code, 4, label);
    assert.equal(rejected.body.reason, 'not-allowed', label);

    // 对照：只把 head 分支名改成 acceptance/1-2-sc3。
    const aligned = setup();
    const alignedRound = addCorrectionRound(aligned.world, aligned.correctionRef, {
      round: 1,
      status: '修正中',
      createdAt: '2026-10-24T02:00:00.000Z',
    });
    const alignedGate = gateFor(
      aligned,
      { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: alignedRound.databaseId },
      { pr: prFor(REPO, { body: aligned.marker }), onWrite },
    );
    const ok = await alignedGate.handle(build(`head-aligned-${label}`));
    assert.equal(ok.code, 0, `${label}: ${JSON.stringify(ok)}`);
  }
});

// ---- #68 第四轮复审补的守卫 ----

function claimedRound(s) {
  const round = addCorrectionRound(s.world, s.correctionRef, { round: 1, status: '修正中', createdAt: '2026-10-24T02:00:00.000Z' });
  return { kind: 'correction', issue: `${REPO}#9`, round: 1, commentId: round.databaseId };
}

test('守卫 13 not-allowed：pr.update-branch / ci.rerun 要核对 PR 的 head 所在仓（别人 fork 里的同名分支不认）', async () => {
  const onWrite = (action) => (action.type.startsWith('comment.') ? undefined : { ok: true, type: action.type });
  const builds = [
    ['pr.update-branch', (key) => ({ type: 'pr.update-branch', repo: REPO, pr: 12, expectedHeadSha: HEAD, dedupeKey: key })],
    ['ci.rerun', (key) => ({ type: 'ci.rerun', repo: REPO, pr: 12, runId: 77, headSha: HEAD, dedupeKey: key })],
  ];
  const strangerFork = `StrangerUser/${REPO.split('/')[1]}`;
  for (const [label, build] of builds) {
    for (const headRepo of [strangerFork, OTHER_REPO]) {
      const s = setup();
      const pr = prFor(REPO, { headRepository: { nameWithOwner: headRepo }, isCrossRepository: true, body: s.marker });
      const outcome = await gateFor(s, claimedRound(s), { pr, onWrite }).handle(build(`head-repo-${label}-${headRepo}`));
      assert.equal(outcome.code, 4, `${label} ${headRepo}`);
      assert.equal(outcome.body.reason, 'not-allowed', `${label} ${headRepo}`);
    }
    // 对照：只把 head 所在仓改回本仓。
    const s = setup();
    const ok = await gateFor(s, claimedRound(s), { pr: prFor(REPO, { body: s.marker }), onWrite }).handle(build(`head-repo-ok-${label}`));
    assert.equal(ok.code, 0, `${label}: ${JSON.stringify(ok)}`);
  }
});

test('守卫 14 not-allowed：pr.create 的 base 只能是 main；已开 PR 的 base 不是 main 也不更新 / 重跑 / 转 Ready', async () => {
  const s = setup();
  const gate = gateFor(s, claimedRound(s), { onWrite: (action) => (action.type.startsWith('comment.') ? undefined : { pr: 12, url: `https://example.invalid/${REPO}/pull/12` }) });
  const create = (base, key) =>
    gate.handle({ type: 'pr.create', repo: REPO, head: BRANCH, ...(base === undefined ? {} : { base }), draft: true, title: '修正', body: s.marker, dedupeKey: key });
  for (const base of ['release', 'main2', '']) {
    const outcome = await create(base, `base-${base || 'empty'}`);
    assert.equal(outcome.code, 4, base);
    assert.equal(outcome.body.reason, 'not-allowed', base);
  }
  assert.equal((await create('main', 'base-main')).code, 0);
  assert.equal((await create(undefined, 'base-default')).code, 0, '不写 base 就是 main');

  const onWrite = (action) => (action.type.startsWith('comment.') ? undefined : { ok: true, type: action.type });
  for (const action of [
    { type: 'pr.update-branch', repo: REPO, pr: 12, expectedHeadSha: HEAD },
    { type: 'ci.rerun', repo: REPO, pr: 12, runId: 77, headSha: HEAD },
    { type: 'pr.ready', repo: REPO, pr: 12, headSha: HEAD },
  ]) {
    const bad = setup();
    const pr = prFor(REPO, { baseRefName: 'release', body: bad.marker });
    const outcome = await gateFor(bad, claimedRound(bad), { pr, onWrite }).handle({ ...action, dedupeKey: `pr-base-${action.type}` });
    assert.equal(outcome.code, 4, action.type);
    assert.equal(outcome.body.reason, 'not-allowed', action.type);
    const good = setup();
    const ok = await gateFor(good, claimedRound(good), { pr: prFor(REPO, { body: good.marker }), onWrite }).handle({ ...action, dedupeKey: `pr-base-ok-${action.type}` });
    assert.equal(ok.code, 0, `${action.type}: ${JSON.stringify(ok)}`);
  }
});
