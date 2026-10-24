import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { consumeResult, observeValidationContext, reopenInfraBlocked } from './bin/mivo-watcher.mjs';
import * as repair from './bin/mivo-repair.mjs';
import { PARSER_VERSION } from './bin/mivo-validation-evidence.mjs';
const validationMergeBase = (...args) => repair.validationMergeBase(...args);

const BLOCK = {
  validatedHead: 'a'.repeat(40), policySha256: 'p'.repeat(64), runtimeSha256: 'r'.repeat(64),
  failureSetState: 'parsed', failureSetSha256: 'f'.repeat(64), receiptSha256: '1'.repeat(64),
  remoteHead: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), mergeBase: 'm'.repeat(40),
};
const CURRENT = { mergeBase: BLOCK.mergeBase, policySha256: BLOCK.policySha256, runtimeSha256: BLOCK.runtimeSha256, receiptSha256: BLOCK.receiptSha256,
  failureSetState: 'parsed', failureSetSha256: BLOCK.failureSetSha256 };

function setup(t, { block = BLOCK, reason = 'local preflight failed', extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-reopen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { stateDir: dir };
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'd1.json'), JSON.stringify({ nodeId: 'PR_1', feedback: [{ key: 'thread:1' }] }));
  const previous = {
    nodeId: 'PR_1', number: 1, headRefOid: BLOCK.remoteHead, baseRefOid: BLOCK.baseRefOid, admissionEpoch: 'e1',
    feedbackCursor: { 'thread:1': 'stamp' }, repairRounds: 2, eligibility: 'blocked',
    activeTask: { dispatchId: 'd1', status: 'blocked', blockedKind: 'external', reason, head: BLOCK.remoteHead, ...(block ? { validationBlock: block } : {}) },
    ...extra,
  };
  return { paths, previous };
}

test('SC7 全部未变：零派发，previous 原样返回、计数不变，反复调用也不消耗每代次上限', (t) => {
  const { paths, previous } = setup(t);
  const snapshot = structuredClone(previous);
  for (let i = 0; i < 5; i++) {
    const next = reopenInfraBlocked({ previous, paths, now: '2026-10-24T00:00:00Z', observe: () => ({ ...CURRENT }) });
    assert.equal(next, previous);
  }
  assert.deepEqual(previous, snapshot);
  assert.equal(previous.infraReopened, undefined);
});

for (const [name, mutate] of [
  ['远端 head', (ctx) => ({ ...ctx, previousPatch: { headRefOid: 'c'.repeat(40) } })],
  ['merge-base', (ctx) => ({ ...ctx, mergeBase: 'n'.repeat(40) })],
  ['policy sha256', (ctx) => ({ ...ctx, policySha256: 'q'.repeat(64) })],
  ['运行指纹', (ctx) => ({ ...ctx, runtimeSha256: 's'.repeat(64) })],
  ['失败集合', (ctx) => ({ ...ctx, receiptSha256: '2'.repeat(64), failureSetSha256: 'e'.repeat(64) })],
  ['新的 unparsed 失败证据', (ctx) => ({ ...ctx, receiptSha256: '3'.repeat(64), failureSetState: 'unparsed', failureSetSha256: null })],
]) {
  test(`SC7 ${name}变化：照常重开（清游标、退还一轮、记录 infraReopened）`, (t) => {
    const { paths, previous } = setup(t);
    const { previousPatch, ...observed } = mutate({ ...CURRENT });
    const next = reopenInfraBlocked({ previous: { ...previous, ...previousPatch }, paths, now: '2026-10-24T00:00:00Z', observe: () => observed });
    assert.equal(next.eligibility, 'active', name);
    assert.equal(next.infraReopened.length, 1);
    assert.equal(next.repairRounds, 1);
    assert.equal(next.feedbackCursor['thread:1'], undefined);
  });
}

test('SC7 新失败收据但失败集合完全相同：仍视为未变', (t) => {
  const { paths, previous } = setup(t);
  const next = reopenInfraBlocked({ previous, paths, now: '2026-10-24T00:00:00Z', observe: () => ({ ...CURRENT, receiptSha256: '9'.repeat(64) }) });
  assert.equal(next, previous);
});

test('SC7 本机观测不到 policy/运行指纹（unknown）：保持 blocked，不重投', (t) => {
  const { paths, previous } = setup(t);
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null }), previous);
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => ({ ...CURRENT, policySha256: null }) }), previous);
});

test('SC7 旧 blocked 没有 validationBlock：head 没变不重投，head 变了才重开', (t) => {
  const { paths, previous } = setup(t, { block: null });
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null }), previous);
  const next = reopenInfraBlocked({ previous: { ...previous, headRefOid: 'c'.repeat(40) }, paths, now: 'n', observe: () => null });
  assert.equal(next.eligibility, 'active');
});

test('SC7 非 validate 类的 infra 阻塞保持原有重开规则', (t) => {
  const { paths, previous } = setup(t, { block: null, reason: 'submodule update failed' });
  const next = reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.infraReopened.length, 1);
});

test('SC7 consumeResult 把验证阻塞上下文连同当时的远端 head/base 带进 activeTask', () => {
  const previous = { nodeId: 'PR_1', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), activeTask: { dispatchId: 'd1' } };
  const { remoteHead, baseRefOid, ...block } = BLOCK;
  const next = consumeResult(previous, { schemaVersion: 2, status: 'blocked', blockedKind: 'external', reason: 'local preflight failed',
    dispatchId: 'd1', sessionId: 's', head: 'a'.repeat(40), validationBlock: block }, 'now');
  assert.deepEqual(next.activeTask.validationBlock, { ...block, remoteHead: 'a'.repeat(40), baseRefOid: 'b'.repeat(40) });
});

test('SC7 仅 base 分支 tip 前进而 merge-base 不变：不重开、计数不变', (t) => {
  const { paths, previous } = setup(t);
  const moved = { ...previous, baseRefOid: 'd'.repeat(40) };
  const snapshot = structuredClone(moved);
  assert.equal(reopenInfraBlocked({ previous: moved, paths, now: 'n', observe: () => ({ ...CURRENT }) }), moved);
  assert.deepEqual(moved, snapshot);
});

test('SC7 取不到 merge-base（本次观测或记录里缺失）：该项按 unknown 处理，不重开，其他项变化仍重开', (t) => {
  const { paths, previous } = setup(t);
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => ({ ...CURRENT, mergeBase: null }) }), previous);
  const { mergeBase, ...legacy } = BLOCK;
  const old = setup(t, { block: legacy });
  assert.equal(reopenInfraBlocked({ previous: old.previous, paths: old.paths, now: 'n', observe: () => ({ ...CURRENT }) }), old.previous);
  const changed = reopenInfraBlocked({ previous: old.previous, paths: old.paths, now: 'n', observe: () => ({ ...CURRENT, policySha256: 'q'.repeat(64) }) });
  assert.equal(changed.eligibility, 'active');
});

function gitRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-mergebase-'));
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
  git(repo, 'worktree', 'add', '-q', '-b', 'watch/pr-1', path.join(repo, '.worktrees', 'watch', 'pr-1'), A);
  const watch = path.join(repo, '.worktrees', 'watch', 'pr-1');
  fs.writeFileSync(path.join(watch, 'feature.txt'), 'x\n');
  git(watch, 'add', '.');
  git(watch, 'commit', '-q', '-m', 'feature');
  const B = git(watch, 'rev-parse', 'HEAD');
  return { dir, repo, watch, git, A, B, env: { MIVO_PLUGIN_REPO: repo } };
}

test('SC7 validationMergeBase 与 observeValidationContext：base tip 前进 merge-base 不变，PR 合入 base 后 merge-base 才变', (t) => {
  const { dir, repo, watch, git, A, B, env } = gitRepo(t);
  assert.equal(validationMergeBase({ worktree: watch, validatedHead: B, baseRefOid: A, baseRefName: 'main' }), A);
  const paths = { stateDir: path.join(dir, 'state') };
  const previous = { nodeId: 'PR_1', number: 1, headRefOid: B, baseRefOid: A,
    activeTask: { dispatchId: 'd1', validationBlock: { validatedHead: B } } };
  assert.equal(observeValidationContext({ previous, paths, env }).mergeBase, A);

  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'y\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'unrelated base progress');
  const C = git(repo, 'rev-parse', 'HEAD');
  assert.notEqual(C, A);
  assert.equal(observeValidationContext({ previous: { ...previous, baseRefOid: C }, paths, env }).mergeBase, A, 'base tip 前进但 merge-base 不变');

  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge pr', 'watch/pr-1');
  const D = git(repo, 'rev-parse', 'HEAD');
  assert.equal(observeValidationContext({ previous: { ...previous, baseRefOid: D }, paths, env }).mergeBase, B, 'PR 已并入 base，merge-base 变化');
});

test('SC7 validationMergeBase 取不到时返回 null：对象缺失、base 为空', (t) => {
  const { watch, B } = gitRepo(t);
  assert.equal(validationMergeBase({ worktree: watch, validatedHead: B, baseRefOid: 'e'.repeat(40), baseRefName: null }), null);
  assert.equal(validationMergeBase({ worktree: watch, validatedHead: B, baseRefOid: null, baseRefName: null }), null);
  assert.equal(validationMergeBase({ worktree: path.join(watch, 'missing'), validatedHead: B, baseRefOid: B, baseRefName: 'main' }), null);
});

test('SC7 reason 含 preflight 但属环境/配置故障（pathspec、submodule、worktree HEAD）：沿用原有重开规则，不被 validate 判据拦住', (t) => {
  for (const reason of ['preflight exit 1: pathspec example-protocol did not match', 'preflight could not start: submodule update failed', 'preflight refused: worktree HEAD does not match validated-head']) {
    const { paths, previous } = setup(t, { block: null, reason });
    const next = reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null });
    assert.equal(next.eligibility, 'active', reason);
    assert.equal(next.infraReopened.length, 1, reason);
  }
  const { paths, previous } = setup(t, { block: null, reason: 'local preflight failed' });
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null }), previous, '真正的 validate 失败仍走五要素判据');
});

test('比对规则升级：旧解析器版本判定的测试失败重开一次，当前版本、无版本的旧收据、非测试失败都不重开', (t) => {
  const { paths, previous } = setup(t);
  const older = { ...CURRENT, receiptParserVersion: 1, receiptFailureKind: 'test-failure' };
  const next = reopenInfraBlocked({ previous, paths, now: 'n', observe: () => older });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.infraReopened.length, 1);
  assert.equal(next.repairRounds, 1);
  for (const [name, observed] of [
    ['当前版本', { ...CURRENT, receiptParserVersion: PARSER_VERSION, receiptFailureKind: 'test-failure' }],
    ['无版本的旧收据', { ...CURRENT, receiptParserVersion: null, receiptFailureKind: null }],
    ['无输出挂起', { ...CURRENT, receiptParserVersion: 1, receiptFailureKind: 'stalled' }],
  ]) assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => observed }), previous, name);
  assert.equal(reopenInfraBlocked({ previous: next, paths, now: 'n', observe: () => older }), next, '同一 dispatch 只重开一次');
});

test('比对规则升级：observeValidationContext 从最新失败收据读出解析器版本与失败类型，默认观测下也能重开', (t) => {
  const { paths, previous } = setup(t);
  const dir = path.join(paths.stateDir, 'validations', 'd1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${'a'.repeat(40)}-00000000-0000-4000-8000-000000000000.json`), JSON.stringify({
    status: 'fail', exitCode: 1, parserVersion: 1, failureKind: 'test-failure', failureSetState: 'parsed', failureSetSha256: BLOCK.failureSetSha256,
  }));
  const env = { ...process.env, MIVO_PLUGIN_REPO: path.join(paths.stateDir, 'missing-repo') };
  const observed = observeValidationContext({ previous, paths, env });
  assert.equal(observed.receiptParserVersion, 1);
  assert.equal(observed.receiptFailureKind, 'test-failure');
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => observed }).eligibility, 'active');
});

test('比对规则升级：本轮没跑验证就停下时，退回读同一 PR 最近的验证收据；每份旧收据只触发一次重开', (t) => {
  const { paths, previous: base } = setup(t, { block: null, reason: 'helper validate 全量单测 5 个未修改用例失败' });
  const previous = { ...base, number: 7, activeTask: { ...base.activeTask, dispatchId: 'd1' } };
  const write = (dir, body) => {
    fs.mkdirSync(path.join(paths.stateDir, 'validations', dir), { recursive: true });
    fs.writeFileSync(path.join(paths.stateDir, 'validations', dir, `${'b'.repeat(40)}-00000000-0000-4000-8000-000000000001.json`), JSON.stringify(body));
  };
  write('live-7-2026-10-24T11:51:00.000Z', { nodeId: 'PR_1', status: 'fail', parserVersion: 1, failureKind: 'test-failure', failureSetState: 'parsed' });
  write('live-70-2026-10-24T12:00:00.000Z', { nodeId: 'PR_70', status: 'fail', parserVersion: 1, failureKind: 'test-failure', failureSetState: 'parsed' });
  const env = { ...process.env, MIVO_PLUGIN_REPO: path.join(paths.stateDir, 'missing-repo') };
  const observed = observeValidationContext({ previous, paths, env });
  assert.equal(observed.receiptParserVersion, 1, '退回读同一 PR 的上一份收据');
  assert.match(observed.parserReceiptSha256, /^[0-9a-f]{64}$/);
  const next = reopenInfraBlocked({ previous, paths, now: 'n', observe: () => observed });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.infraReopened.at(-1).parserReceipt, observed.parserReceiptSha256, '记下触发重开的旧收据');
  const again = { ...next, eligibility: 'blocked', activeTask: { ...previous.activeTask, dispatchId: 'd2' } };
  fs.writeFileSync(path.join(paths.stateDir, 'tasks', 'd2.json'), JSON.stringify({ nodeId: 'PR_1', feedback: [] }));
  assert.equal(reopenInfraBlocked({ previous: again, paths, now: 'n', observe: () => observed }), again, '同一份旧收据不再触发重开');
  const other = observeValidationContext({ previous: { ...previous, number: 70, nodeId: 'PR_X' }, paths, env });
  assert.equal(other.receiptParserVersion ?? null, null, '不读别的 PR 的收据');
});

test('本轮没跑 validate 就以验证失败停下：重开一次；观测不到时不重开', (t) => {
  const { paths, previous } = setup(t, { block: null, reason: '上一轮 helper validate 对同一 HEAD 已失败' });
  const next = reopenInfraBlocked({ previous, paths, now: 'n', observe: () => ({ ...CURRENT, ownReceipt: false }) });
  assert.equal(next.eligibility, 'active');
  assert.equal(reopenInfraBlocked({ previous: next, paths, now: 'n', observe: () => ({ ...CURRENT, ownReceipt: false }) }), next, '同一 dispatch 只重开一次');
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => ({ ...CURRENT, ownReceipt: true }) }), previous, '本轮跑过 validate 的不因此重开');
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null }), previous);
});

test('没有版本号、退出码 1 的旧测试失败收据：也按比对规则升级重开一次；默认观测能识别', (t) => {
  const { paths, previous } = setup(t, { block: null, reason: 'helper validate 失败：5 项未改动用例' });
  const dir = path.join(paths.stateDir, 'validations', 'd1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${'a'.repeat(40)}-00000000-0000-4000-8000-000000000002.json`), JSON.stringify({ nodeId: 'PR_1', status: 'fail', exitCode: 1 }));
  const env = { ...process.env, MIVO_PLUGIN_REPO: path.join(paths.stateDir, 'missing-repo') };
  const observed = observeValidationContext({ previous, paths, env });
  assert.equal(observed.ownReceipt, true);
  const next = reopenInfraBlocked({ previous, paths, now: 'n', observe: () => observed });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.infraReopened.at(-1).parserReceipt, observed.parserReceiptSha256);
  fs.writeFileSync(path.join(dir, `${'a'.repeat(40)}-00000000-0000-4000-8000-000000000002.json`), JSON.stringify({ nodeId: 'PR_1', status: 'fail', exitCode: 2 }));
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => observeValidationContext({ previous, paths, env }) }), previous, '退出码不是 1 的旧收据不触发');
});
