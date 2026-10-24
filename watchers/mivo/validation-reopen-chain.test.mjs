import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { handoffPr, handoffReceipt, withAuthorHandoff } from './handoff.fixture.mjs';
import { REPO, observeValidationContext, pollFingerprint, reopenExternalBlocked, reopenInfraBlocked, rulesVersion, scanOnce, watcherPaths } from './bin/mivo-watcher.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';

// 生产 state 条目没有 baseRefOid/baseRefName；当前 base 只来自 poll / 采集结果。
// 这里用真实 git 仓 + scanOnce 的真实调用链（快路径 canSkipCollection 与 processPr）验证，不往 previous 手工注入 baseRefOid。
const NODE = 'PR_790';
const NUMBER = 790;
const TASK = 'live-790-2026-10-24T00:00:00.000Z';
const NOW = '2026-10-24T12:00:00.000Z';
const REASON = 'local preflight failed';

function gitRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-chain-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'ExampleUser',
    GIT_AUTHOR_EMAIL: 'user@example.invalid', GIT_COMMITTER_NAME: 'ExampleUser', GIT_COMMITTER_EMAIL: 'user@example.invalid' };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
  const repo = path.join(dir, 'plugin');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(repo, '.githooks'));
  fs.writeFileSync(path.join(repo, '.githooks', 'pre-push'), '#!/usr/bin/env bash\nexit 0\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'base');
  const A = git(repo, 'rev-parse', 'HEAD');
  const watch = path.join(repo, '.worktrees', 'watch', `pr-${NUMBER}`);
  git(repo, 'worktree', 'add', '-q', '-b', `watch/pr-${NUMBER}`, watch, A);
  fs.writeFileSync(path.join(watch, 'feature.txt'), 'x\n');
  git(watch, 'add', '.');
  git(watch, 'commit', '-q', '-m', 'feature');
  const B = git(watch, 'rev-parse', 'HEAD');
  const advance = (name) => {
    fs.writeFileSync(path.join(repo, name), 'y\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', name);
    return git(repo, 'rev-parse', 'HEAD');
  };
  const mergeFeature = () => {
    git(repo, 'merge', '-q', '--no-ff', '-m', 'merge pr', `watch/pr-${NUMBER}`);
    return git(repo, 'rev-parse', 'HEAD');
  };
  return { dir, repo, watch, A, B, advance, mergeFeature };
}

const pollSnap = (head, base) => ({
  state: 'OPEN', isDraft: false, headRefOid: head, baseRefOid: base, updatedAt: NOW, mergeable: 'MERGEABLE',
  labels: [], checkState: 'SUCCESS', commentCount: 1, reviewCount: 0, commentUpdatedAt: NOW, reviewUpdatedAt: null, unresolvedThreads: 0,
});

// fingerprintMatches=true：poll 指纹与当前快照一致，只有重开判定能把这一轮送进 processPr（快路径 canSkipCollection）。
// false：指纹不同，本轮必然走 processPr。
function scan(t, { world, currentBase, fingerprintMatches, reason = REASON, withBlock = true, extra = {}, snapshotPatch = {}, entryPatch = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-chain-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', `${TASK}.json`), JSON.stringify({ dispatchId: TASK, nodeId: NODE, feedback: [{ key: 'thread:1' }] }));
  const listed = handoffPr({ repo: REPO, id: NODE, number: NUMBER, headRefOid: world.B, baseRefOid: currentBase, baseRefName: 'main', state: 'OPEN',
    isDraft: false, author: { login: 'owner' }, releaseEpoch: 'e' });
  const handoff = handoffReceipt(listed);
  const snapshot = { ...pollSnap(world.B, currentBase), ...snapshotPatch };
  // 记录阻塞时的观测：以阻塞当时的 base（A，没有 base 前进）算 merge-base / policy / 运行指纹。
  const at = observeValidationContext({ previous: { number: NUMBER, headRefOid: world.B, baseRefOid: world.A, activeTask: { dispatchId: TASK, validationBlock: { validatedHead: world.B } } },
    paths, env: { MIVO_PLUGIN_REPO: world.repo } });
  assert.equal(at.mergeBase, world.A);
  const validationBlock = { validatedHead: world.B, remoteHead: world.B, baseRefOid: world.A, mergeBase: at.mergeBase,
    policySha256: at.policySha256, runtimeSha256: at.runtimeSha256, failureSetState: 'parsed', failureSetSha256: 'f'.repeat(64), receiptSha256: '1'.repeat(64) };
  writePr(paths.home, NODE, {
    number: NUMBER, nodeId: NODE, sessionId: 'sess-790', eligibilityInitialized: true, eligibility: 'blocked', admissionVerified: true,
    admissionEpoch: handoff.releaseEpoch, handoff, headRefName: 'fix/x', headRefOid: world.B, title: 'fix',
    pollFingerprint: fingerprintMatches ? pollFingerprint(snapshot) : 'stale', rulesVersion: rulesVersion(),
    feedbackCursor: { 'thread:1': 'stamp' }, repairRounds: 2, admissionEpoch: 'e',
    activeTask: { dispatchId: TASK, status: 'blocked', blockedKind: 'external', reason, head: world.B, observedAt: NOW, ...(withBlock ? { validationBlock } : {}) },
    ...extra, ...entryPatch,
  });
  const before = readPr(paths.home, NODE);
  assert.equal(before.baseRefOid, undefined, '生产 state 形态：条目里没有 baseRefOid');
  assert.equal(before.baseRefName, undefined);
  const saved = process.env.MIVO_PLUGIN_REPO;
  process.env.MIVO_PLUGIN_REPO = world.repo;
  let collected = 0;
  let outcome;
  try {
    outcome = scanOnce({
      mode: 'poll', enabled: true, allowDispatch: true, paths, now: NOW, nodeId: NODE, prNumber: NUMBER,
      snapshotFn: () => snapshot,
      ghFn: (args) => args[0] === 'api' ? 'owner' : '[]',
      collect: (...args) => {
        collected += 1;
        return withAuthorHandoff({ pr: listed, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, comments: [], reviews: [], threads: [],
          labels: [], mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: true, mergeReady: false, policy: { status: 'verified' } }, args[0]);
      },
      dispatchFn: () => ({ target_session_id: 'sess-790' }),
      ownershipSnapshot: function* () { return { pr: listed }; },
    });
  } finally {
    if (saved === undefined) delete process.env.MIVO_PLUGIN_REPO; else process.env.MIVO_PLUGIN_REPO = saved;
  }
  return { outcome, collected, entry: readPr(paths.home, NODE), paths, listed };
}

test('F1 快路径（canSkipCollection）：生产 state 形态下 merge-base 变化 → 重开', (t) => {
  const world = gitRepo(t);
  const merged = world.mergeFeature(); // PR 已并入 base：merge-base(B, base) 由 A 变为 B
  const { collected, entry } = scan(t, { world, currentBase: merged, fingerprintMatches: true });
  assert.equal(collected, 1, '指纹未变，但 merge-base 变了，必须进入 processPr');
  assert.equal(entry.infraReopened?.length, 1);
});

test('F1 快路径：base tip 前进但 merge-base 不变 → 不重开、不进入采集', (t) => {
  const world = gitRepo(t);
  const tip = world.advance('unrelated.txt');
  const { outcome, collected, entry } = scan(t, { world, currentBase: tip, fingerprintMatches: true });
  assert.equal(collected, 0);
  assert.equal(outcome.prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.equal(entry.infraReopened, undefined);
  assert.equal(entry.repairRounds, 2);
});

test('F1 processPr 全量路径：生产 state 形态下 merge-base 变化 → 重开；tip 前进 → 不重开', (t) => {
  const world = gitRepo(t);
  const tip = world.advance('unrelated.txt');
  const moved = scan(t, { world, currentBase: tip, fingerprintMatches: false });
  assert.equal(moved.collected, 1);
  assert.equal(moved.entry.infraReopened, undefined, 'tip 前进、merge-base 不变不重开');
  const merged = world.mergeFeature();
  const changed = scan(t, { world, currentBase: merged, fingerprintMatches: false });
  assert.equal(changed.entry.infraReopened?.length, 1, 'merge-base 变化重开');
});

test('F1 采集结果里的 base 持久化进 state 条目，下一轮即可比较', (t) => {
  const world = gitRepo(t);
  const tip = world.advance('unrelated.txt');
  const { entry } = scan(t, { world, currentBase: tip, fingerprintMatches: false });
  assert.equal(entry.baseRefOid, tip);
  assert.equal(entry.baseRefName, 'main');
});

test('F2 带 validationBlock 的环境故障（pathspec/submodule/worktree HEAD）：按原有 infra 规则重开；validate 失败五要素不变不重开', (t) => {
  const block = { validatedHead: 'a'.repeat(40), remoteHead: 'a'.repeat(40), mergeBase: 'm'.repeat(40), policySha256: 'p'.repeat(64), runtimeSha256: 'r'.repeat(64),
    failureSetState: 'parsed', failureSetSha256: 'f'.repeat(64), receiptSha256: '1'.repeat(64) };
  const unchanged = { mergeBase: block.mergeBase, policySha256: block.policySha256, runtimeSha256: block.runtimeSha256, receiptSha256: block.receiptSha256,
    failureSetState: 'parsed', failureSetSha256: block.failureSetSha256 };
  const make = (reason) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-f2-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'tasks'));
    fs.writeFileSync(path.join(dir, 'tasks', 'd1.json'), JSON.stringify({ nodeId: 'PR_1', feedback: [] }));
    return { paths: { stateDir: dir }, previous: { nodeId: 'PR_1', number: 1, headRefOid: block.remoteHead, repairRounds: 2, eligibility: 'blocked', admissionEpoch: 'e1',
      activeTask: { dispatchId: 'd1', status: 'blocked', blockedKind: 'external', reason, head: block.remoteHead, validationBlock: block } } };
  };
  for (const reason of ['preflight exit 1: pathspec example-protocol did not match', 'preflight could not start: submodule update failed', 'preflight refused: worktree HEAD does not match validated-head']) {
    const { paths, previous } = make(reason);
    const next = reopenInfraBlocked({ previous, paths, now: 'n', observe: () => ({ ...unchanged }) });
    assert.equal(next.eligibility, 'active', reason);
    assert.equal(next.infraReopened.length, 1, reason);
  }
  const { paths, previous } = make('local preflight failed');
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => ({ ...unchanged }) }), previous);
});

function externalFixture(t, { reason = REASON, block = true, head = 'a'.repeat(40) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-f3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'd1.json'), JSON.stringify({ nodeId: 'PR_1', feedback: [{ key: 'thread:1' }] }));
  const validationBlock = { validatedHead: head, remoteHead: head, mergeBase: 'm'.repeat(40), policySha256: 'p'.repeat(64), runtimeSha256: 'r'.repeat(64),
    failureSetState: 'parsed', failureSetSha256: 'f'.repeat(64), receiptSha256: '1'.repeat(64) };
  return { paths: { stateDir: dir }, validationBlock, previous: { nodeId: 'PR_1', number: 1, headRefOid: head, repairRounds: 2, eligibility: 'blocked', admissionEpoch: 'e1',
    rulesVersion: 'older-rules-version', feedbackCursor: { 'thread:1': 'stamp' },
    activeTask: { dispatchId: 'd1', status: 'blocked', blockedKind: 'external', reason, head, ...(block ? { validationBlock } : {}) } } };
}

test('F3 rulesVersion 变化 + validate 阻塞五要素不变：不重开、不耗轮次；head 变化仍重开；非 validate external 仍随 rulesVersion 重开', (t) => {
  const { paths, previous } = externalFixture(t);
  assert.notEqual(previous.rulesVersion, rulesVersion());
  const kept = reopenExternalBlocked({ previous, paths, now: 'n', head: previous.headRefOid });
  assert.equal(kept, previous);
  assert.equal(kept.externalReopened, undefined);
  assert.equal(kept.repairRounds, 2);

  const headMoved = reopenExternalBlocked({ previous, paths, now: 'n', head: 'c'.repeat(40) });
  assert.equal(headMoved.eligibility, 'active');
  assert.equal(headMoved.externalReopened.length, 1);

  const plain = externalFixture(t, { reason: 'author asked to wait for the design review', block: false });
  const rules = reopenExternalBlocked({ previous: plain.previous, paths: plain.paths, now: 'n', head: plain.previous.headRefOid });
  assert.equal(rules.eligibility, 'active');
  assert.equal(rules.externalReopened.length, 1);
});

test('F3 同一轮 infra 与 external 都命中时只退一轮（repairRounds 3→2，不是 3→1）', (t) => {
  const { paths, previous } = externalFixture(t);
  const start = { ...previous, repairRounds: 3 };
  const changed = 'c'.repeat(40);
  const afterInfra = reopenInfraBlocked({ previous: { ...start, headRefOid: changed }, paths, now: 'n', observe: () => ({ mergeBase: start.activeTask.validationBlock.mergeBase,
    policySha256: start.activeTask.validationBlock.policySha256, runtimeSha256: start.activeTask.validationBlock.runtimeSha256 }) });
  assert.equal(afterInfra.infraReopened.length, 1);
  assert.equal(afterInfra.repairRounds, 2);
  const afterExternal = reopenExternalBlocked({ previous: afterInfra, paths, now: 'n', head: changed });
  assert.equal(afterExternal.repairRounds, 2);
  assert.equal(afterExternal.externalReopened, undefined);
});

// validate 类阻塞的唯一分类：原因不属于环境故障，且（带 validationBlock 或原因指向 preflight/validate）。
// 下面两条原因不含 INFRA_BLOCK_REASON 的任何关键词（preflight/submodule/…），线上同形文字占多数。
const VALIDATE_ONLY_REASONS = [
  'helper validate 的完整 pre-push 仍以 exit 1 失败，原因是未修改的 scripts/example.test.mjs',
  'helper validate DCO fails on example-commit',
];

test('F3 infra 入口：reason 不含 INFRA 关键词的 validate 类阻塞（有/无 validationBlock）也走五要素判据', (t) => {
  for (const reason of VALIDATE_ONLY_REASONS) {
    const withBlock = externalFixture(t, { reason });
    const b = withBlock.validationBlock;
    const unchanged = { mergeBase: b.mergeBase, policySha256: b.policySha256, runtimeSha256: b.runtimeSha256, receiptSha256: b.receiptSha256,
      failureSetState: 'parsed', failureSetSha256: b.failureSetSha256 };
    assert.equal(reopenInfraBlocked({ previous: withBlock.previous, paths: withBlock.paths, now: 'n', observe: () => ({ ...unchanged }) }), withBlock.previous, `${reason}：五要素不变不重开`);
    const changed = reopenInfraBlocked({ previous: withBlock.previous, paths: withBlock.paths, now: 'n', observe: () => ({ ...unchanged, mergeBase: 'n'.repeat(40) }) });
    assert.equal(changed.eligibility, 'active', `${reason}：五要素变化重开`);
    assert.equal(changed.infraReopened.length, 1);
    assert.equal(changed.repairRounds, 1);

    const legacy = externalFixture(t, { reason, block: false });
    assert.equal(reopenInfraBlocked({ previous: legacy.previous, paths: legacy.paths, now: 'n' }), legacy.previous, `${reason}：legacy head 未变不重开`);
    const moved = reopenInfraBlocked({ previous: { ...legacy.previous, headRefOid: 'c'.repeat(40) }, paths: legacy.paths, now: 'n' });
    assert.equal(moved.eligibility, 'active', `${reason}：legacy head 变化重开`);
    assert.equal(moved.infraReopened.length, 1);
  }
});

test('F3 external 入口：reason 不含 INFRA 关键词的 validate 类阻塞不因 rulesVersion 变化重投；head 变化仍重开且同一 dispatch 只退一轮', (t) => {
  for (const reason of VALIDATE_ONLY_REASONS) {
    for (const block of [true, false]) {
      const { paths, previous } = externalFixture(t, { reason, block });
      assert.notEqual(previous.rulesVersion, rulesVersion());
      const kept = reopenExternalBlocked({ previous, paths, now: 'n', head: previous.headRefOid });
      assert.equal(kept, previous, `${reason} block=${block}：部署新版不重投`);
      assert.equal(kept.repairRounds, 2);

      const moved = reopenExternalBlocked({ previous, paths, now: 'n', head: 'c'.repeat(40) });
      assert.equal(moved.eligibility, 'active', `${reason} block=${block}：head 变化重开`);
      assert.equal(moved.externalReopened.length, 1);

      const start = { ...previous, repairRounds: 3, headRefOid: 'c'.repeat(40) };
      const afterInfra = reopenInfraBlocked({ previous: start, paths, now: 'n', observe: () => ({ mergeBase: 'n'.repeat(40) }) });
      assert.equal(afterInfra.infraReopened?.length, 1);
      const afterExternal = reopenExternalBlocked({ previous: afterInfra, paths, now: 'n', head: 'c'.repeat(40) });
      assert.equal(afterExternal.repairRounds, 2, `${reason} block=${block}：infra+external 只退一轮`);
    }
  }
});
