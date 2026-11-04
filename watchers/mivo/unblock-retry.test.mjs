// 2026-11-03: PRs stopped for good on blocks the watcher could have recovered from.
// #1621/#1624/#1641 were refused by GitHub (GH007) because repair commits carried the checkout's private email;
// #1648/#1674 blocked on a GitHub rate limit and nothing handed them back once the quota returned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TRANSIENT_RETRY_BACKOFF_MS, isValidateClassBlock, reopenInfraBlocked } from './bin/mivo-watcher.mjs';
import { ensureCommitIdentity, privateIdentityCommits } from './bin/mivo-repair.mjs';

const BLOCKED_AT = '2026-11-03T06:40:00.000Z';
const GH007 = 'GitHub 拒绝了受控推送（GH007：提交作者邮箱被当前隐私设置拦截）。恢复条件：改用 noreply 邮箱重建提交，重新运行 helper validate 后 finalize。';
const RATE_LIMIT = 'GitHub GraphQL API 速率限制已耗尽，helper 读取 PR 元数据时失败。恢复条件：GitHub API 配额恢复后由 watcher 重投本任务。';

function setup(t, { reason, blockedKind = 'external', extra = {}, active = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-unblock-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'd1.json'), JSON.stringify({ nodeId: 'PR_1', feedback: [{ key: 'thread:1' }] }));
  const previous = {
    nodeId: 'PR_1', number: 1, headRefOid: 'a'.repeat(40), admissionEpoch: 'e1',
    feedbackCursor: { 'thread:1': 'stamp' }, repairRounds: 2, eligibility: 'blocked',
    activeTask: { dispatchId: 'd1', status: 'blocked', blockedKind, reason, head: 'a'.repeat(40), at: BLOCKED_AT, observedAt: BLOCKED_AT, ...active },
    ...extra,
  };
  return { paths: { stateDir: dir }, previous };
}
const after = (ms) => new Date(Date.parse(BLOCKED_AT) + ms).toISOString();

test('a GH007 push refusal is an environment fault, not a validate failure, and is handed back at once', (t) => {
  const { paths, previous } = setup(t, { reason: GH007 });
  assert.equal(isValidateClassBlock(previous.activeTask), false);
  const next = reopenInfraBlocked({ previous, paths, now: after(1000) });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.feedbackCursor['thread:1'], undefined);
  assert.equal(next.repairRounds, 1);
  assert.equal(next.infraReopened.length, 1);
  assert.equal(reopenInfraBlocked({ previous: next, paths, now: after(2000) }), next, 'the same dispatch is handed back once');
});

test('a rate-limit block waits out the back-off, then is handed back once', (t) => {
  const { paths, previous } = setup(t, { reason: RATE_LIMIT });
  assert.equal(reopenInfraBlocked({ previous, paths, now: after(TRANSIENT_RETRY_BACKOFF_MS - 1) }), previous);
  const next = reopenInfraBlocked({ previous, paths, now: after(TRANSIENT_RETRY_BACKOFF_MS) });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.feedbackCursor['thread:1'], undefined);
  assert.equal(next.infraReopened[0].dispatchId, 'd1');
  assert.equal(reopenInfraBlocked({ previous: next, paths, now: after(2 * TRANSIENT_RETRY_BACKOFF_MS) }), next);
});

test('rate-limit retries share the per-epoch infra limit', (t) => {
  const done = [1, 2, 3].map((n) => ({ dispatchId: `old-${n}`, epoch: 'e1', at: BLOCKED_AT }));
  const { paths, previous } = setup(t, { reason: RATE_LIMIT, extra: { infraReopened: done } });
  assert.equal(reopenInfraBlocked({ previous, paths, now: after(TRANSIENT_RETRY_BACKOFF_MS) }), previous);
});

test('gateway errors count as transient; other external blocks still wait for a person', (t) => {
  for (const reason of ['HTTP 504: 504 Gateway Timeout (https://api.github.com/graphql)', 'GitHub GraphQL API 限流，assert-owner 无法确认归属']) {
    const { paths, previous } = setup(t, { reason });
    assert.equal(reopenInfraBlocked({ previous, paths, now: after(TRANSIENT_RETRY_BACKOFF_MS) }).eligibility, 'active', reason);
  }
  const { paths, previous } = setup(t, { reason: '缺少目标仓写权限，需要维护者授权' });
  assert.equal(reopenInfraBlocked({ previous, paths, now: after(10 * TRANSIENT_RETRY_BACKOFF_MS) }), previous);
});

// 2026-11-04: #1621 and #1741 had their fixes committed locally but sat blocked for 8-20 hours, because the
// sessions wrote "配额用尽" and "pre-push 互斥锁" instead of "rate limit" and the retry never matched.
test('an exhausted GraphQL quota or a busy pre-push lock is transient too', (t) => {
  for (const reason of [
    'GitHub GraphQL API 配额用尽（预计 2026-11-03T19:45Z 重置），helper 的 gh pr view 调用失败，本轮无法完成收口。本地修复已提交，commit 尚未推送。',
    'GitHub GraphQL 配额与仓库级 pre-push 互斥锁被并行修复会话长期占满：本轮 validate 需要的 assert-owner 与 .githooks/pre-push 连续 2 小时以上拿不到，无法完成受控推送。',
    'pre-push.flock 一直被其他会话持有，受控推送排不上',
  ]) {
    const { paths, previous } = setup(t, { reason });
    assert.equal(isValidateClassBlock(previous.activeTask), false, reason);
    assert.equal(reopenInfraBlocked({ previous, paths, now: after(TRANSIENT_RETRY_BACKOFF_MS - 1) }), previous, reason);
    assert.equal(reopenInfraBlocked({ previous, paths, now: after(TRANSIENT_RETRY_BACKOFF_MS) }).eligibility, 'active', reason);
  }
});

test('only external blocks are retried as transient, and a failed validation receipt keeps its own rules', (t) => {
  const kinds = setup(t, { reason: RATE_LIMIT, blockedKind: 'required-ci' });
  assert.equal(reopenInfraBlocked({ previous: kinds.previous, paths: kinds.paths, now: after(TRANSIENT_RETRY_BACKOFF_MS) }), kinds.previous);
  const receipt = setup(t, { reason: `local preflight failed: ${RATE_LIMIT}`, active: { validationBlock: { remoteHead: 'a'.repeat(40) } } });
  assert.equal(isValidateClassBlock(receipt.previous.activeTask), true);
});

// #1741 on 2026-11-04: validate could not get the shared pre-push lock, the receipt said "failed", and the block
// was held to the strict validate rules even though nothing had failed.
test('a validation receipt that only timed out on the pre-push lock is retried as transient', (t) => {
  const { paths, previous } = setup(t, {
    reason: '本轮 validate 等不到共用的 pre-push 锁，修复已本地提交未推送。',
    active: { validationBlock: { remoteHead: 'a'.repeat(40), failureKind: 'preflight-lock-busy' } },
  });
  assert.equal(isValidateClassBlock(previous.activeTask), false);
  assert.equal(reopenInfraBlocked({ previous, paths, now: after(TRANSIENT_RETRY_BACKOFF_MS - 1) }), previous);
  assert.equal(reopenInfraBlocked({ previous, paths, now: after(TRANSIENT_RETRY_BACKOFF_MS) }).eligibility, 'active');
});

// identity

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } }).trim();
}
function identityRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const plugin = path.join(root, 'plugin');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', plugin]);
  git(plugin, 'config', 'user.name', 'Example Person');
  git(plugin, 'config', 'user.email', 'person@example.invalid');
  fs.writeFileSync(path.join(plugin, 'a.txt'), 'a\n');
  git(plugin, 'add', 'a.txt');
  git(plugin, 'commit', '-q', '-m', 'base');
  git(plugin, 'remote', 'add', 'origin', origin);
  git(plugin, 'push', '-q', 'origin', 'main');
  git(plugin, 'fetch', '-q', 'origin');
  const worktree = path.join(plugin, '.worktrees', 'watch', 'pr-1');
  git(plugin, 'worktree', 'add', '-q', '-b', 'watch/pr-1', worktree, 'origin/main');
  return { plugin, worktree };
}
const gitFn = (_bin, args) => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull } }).trim();
const ghUser = { login: 'ExampleUser', id: 42 };
const commit = (worktree, file, extraEnv = {}) => {
  fs.writeFileSync(path.join(worktree, file), `${file}\n`);
  git(worktree, 'add', file);
  execFileSync('git', ['-C', worktree, 'commit', '-q', '-m', file], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, ...extraEnv } });
  return git(worktree, 'rev-parse', 'HEAD');
};

test('prepare identity: the watch worktree commits with the noreply identity, the main checkout keeps its own', (t) => {
  const { plugin, worktree } = identityRepo(t);
  assert.deepEqual(ensureCommitIdentity({ worktree, gitFn, identity: ghUser }), { configured: true });
  assert.equal(git(worktree, 'config', 'user.email'), '42+ExampleUser@users.noreply.github.com');
  assert.equal(git(plugin, 'config', 'user.email'), 'person@example.invalid');
  const head = commit(worktree, 'b.txt');
  assert.equal(git(worktree, 'log', '-1', '--format=%ae %ce'), '42+ExampleUser@users.noreply.github.com 42+ExampleUser@users.noreply.github.com');
  assert.deepEqual(privateIdentityCommits({ worktree, head, gitFn }), []);
});

test('validate guard: an unpushed commit carrying the inherited email is reported, pushed history is not', (t) => {
  const { worktree } = identityRepo(t);
  ensureCommitIdentity({ worktree, gitFn, identity: ghUser });
  const leaked = commit(worktree, 'c.txt', { GIT_AUTHOR_EMAIL: 'person@example.invalid' });
  const clean = commit(worktree, 'd.txt');
  assert.deepEqual(privateIdentityCommits({ worktree, head: clean, gitFn }), [leaked]);
  git(worktree, '-c', 'core.editor=true', 'rebase', '-q', '-r', '--exec', 'git commit --amend -q --no-edit --reset-author', `${leaked}^`);
  assert.deepEqual(privateIdentityCommits({ worktree, head: git(worktree, 'rev-parse', 'HEAD'), gitFn }), [], 'the suggested rebase fixes it');
});

test('prepare identity is skipped, not guessed, when the configured account has no user id', (t) => {
  const { worktree } = identityRepo(t);
  assert.deepEqual(ensureCommitIdentity({ worktree, gitFn, identity: { login: 'ExampleUser', id: null } }), { configured: false, reason: 'gh-user-unavailable' });
  assert.deepEqual(ensureCommitIdentity({ worktree, gitFn, identity: { login: 'bad name', id: 1 } }), { configured: false, reason: 'gh-user-invalid' });
  assert.equal(git(worktree, 'config', 'user.email'), 'person@example.invalid');
  const head = commit(worktree, 'e.txt');
  assert.deepEqual(privateIdentityCommits({ worktree, head, gitFn }), [], 'an unconfigured checkout is not checked');
});
