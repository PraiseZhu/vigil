import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { consumeResult, observeValidationContext, reopenInfraBlocked } from './bin/mivo-watcher.mjs';
import * as repair from './bin/mivo-repair.mjs';
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
