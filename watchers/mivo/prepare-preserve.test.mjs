import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepare, preservedRefFor, preserveWatchCheckout, repairPaths } from './bin/mivo-repair.mjs';
import { writePr } from './bin/mivo-state.mjs';
import { handoffPr, handoffReceipt } from './handoff.fixture.mjs';

const REPO = process.env.MIVO_WATCHER_TARGET_REPO;
const DISPATCH = 'live-7-2026-10-28T01:02:03.000Z';
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Example User', '-c', 'user.email=example@example.invalid', ...args], {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV,
  }).trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-preserve-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const plugin = path.join(root, 'plugin');
  const home = path.join(root, 'home');
  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'init', '-b', 'feature', seed);
  fs.writeFileSync(path.join(seed, 'a.txt'), 'base\n');
  git(seed, 'add', '.');
  git(seed, '-c', 'commit.gpgsign=false', 'commit', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', 'origin', 'feature');
  const baseHead = git(seed, 'rev-parse', 'HEAD');
  git(root, 'clone', origin, plugin);
  git(plugin, 'fetch', 'origin', '+refs/heads/feature:refs/remotes/origin/feature');
  const worktree = path.join(plugin, '.worktrees', 'watch', 'pr-7');
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(plugin, 'worktree', 'add', '-B', 'watch/pr-7', worktree, 'origin/feature');
  git(worktree, 'branch', '--set-upstream-to', 'origin/feature');
  const pr = handoffPr({ id: 'PR_7', number: 7, headRefOid: baseHead, headRefName: 'feature', releaseEpoch: 'e' });
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const task = {
    dispatchId: DISPATCH, nodeId: 'PR_7', number: 7, repo: REPO, sessionId: 'sess-7',
    headRefOid: baseHead, headRefName: 'feature', handoff: handoffReceipt(pr), releaseEpoch: pr.releaseEpoch,
  };
  const taskPath = path.join(paths.tasks, DISPATCH + '.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(home, 'PR_7', { number: 7, nodeId: 'PR_7', sessionId: 'sess-7', handoff: task.handoff, activeTask: { dispatchId: DISPATCH } });
  const gitFn = (binary, args, options = {}) => execFileSync(binary, args, {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], ...options, env: options.env ?? GIT_ENV,
  }).trim();
  return { root, origin, seed, plugin, home, worktree, baseHead, task, taskPath, pr, paths, gitFn };
}

function withPlugin(t, plugin) {
  const before = process.env.MIVO_PLUGIN_REPO;
  process.env.MIVO_PLUGIN_REPO = plugin;
  t.after(() => { if (before === undefined) delete process.env.MIVO_PLUGIN_REPO; else process.env.MIVO_PLUGIN_REPO = before; });
}

test('prepare preserves a dirty ahead watch worktree, then resets to the PR head', (t) => {
  const f = fixture(t);
  withPlugin(t, f.plugin);
  git(f.worktree, 'commit', '--allow-empty', '-m', 'unpushed round commit');
  const original = git(f.worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(f.worktree, 'dirty.txt'), 'local only\n');
  fs.writeFileSync(path.join(f.worktree, 'a.txt'), 'staged version\n');
  git(f.worktree, 'add', 'a.txt');
  fs.writeFileSync(path.join(f.worktree, 'a.txt'), 'worktree version\n');
  const result = prepare({
    home: f.home, taskPath: f.taskPath, ownershipFn: () => f.pr, ghFn: () => '{}',
    cloneUrl: f.origin, originUrl: f.origin, gitFn: f.gitFn, keelRoot: '/tmp',
  });
  assert.equal(result.status, 'prepared');
  assert.equal(result.head, f.baseHead);
  assert.equal(result.needsSync, false);
  assert.equal(result.preservation.originalHead, original);
  assert.equal(result.preservation.hadUncommitted, true);
  assert.equal(result.preservation.backupRef, preservedRefFor(DISPATCH));
  assert.match(result.preservation.backupRef, /%3A/);
  assert.equal(git(f.worktree, 'rev-parse', 'HEAD'), f.baseHead);
  assert.equal(git(f.worktree, 'status', '--porcelain'), '');
  const log = git(f.plugin, 'log', '--format=%H', result.preservation.backupRef);
  assert.match(log, new RegExp(original));
  assert.match(log, new RegExp(f.baseHead));
  assert.equal(git(f.plugin, 'show', result.preservation.backupRef + ':dirty.txt'), 'local only');
  assert.equal(git(f.plugin, 'show', result.preservation.backupRef + ':a.txt'), 'worktree version');
  const versions = git(f.plugin, 'rev-list', result.preservation.backupRef).split('\n').map((sha) => {
    try { return git(f.plugin, 'show', sha + ':a.txt'); } catch { return null; }
  });
  assert.ok(versions.includes('staged version'), 'the staged version stays reachable in the backup chain');
  assert.ok(versions.includes('worktree version'));
  git(f.plugin, 'worktree', 'remove', '--force', f.worktree);
  assert.match(git(f.plugin, 'log', '--format=%H', result.preservation.backupRef), new RegExp(original));
});

test('prepare is a no-op on a clean watch worktree already at the PR head', (t) => {
  const f = fixture(t);
  withPlugin(t, f.plugin);
  const result = prepare({
    home: f.home, taskPath: f.taskPath, ownershipFn: () => f.pr, ghFn: () => '{}',
    cloneUrl: f.origin, originUrl: f.origin, gitFn: f.gitFn, keelRoot: '/tmp',
  });
  assert.equal(result.status, 'prepared');
  assert.equal(result.preservation, null);
  assert.equal(result.realigned, null);
});

test('a nested repository in the watch tree is refused and the tree is left untouched', (t) => {
  const f = fixture(t);
  withPlugin(t, f.plugin);
  const nested = path.join(f.worktree, 'nested');
  fs.mkdirSync(nested);
  git(nested, 'init', '-b', 'main');
  fs.writeFileSync(path.join(nested, 'n.txt'), 'nested work\n');
  git(nested, 'add', '.');
  git(nested, '-c', 'commit.gpgsign=false', 'commit', '-m', 'nested');
  const head = git(f.worktree, 'rev-parse', 'HEAD');
  assert.throws(() => preserveWatchCheckout({ task: f.task, worktree: f.worktree, originalHead: head, remoteHead: head, gitFn: f.gitFn,
    env: { ...process.env, MIVO_PLUGIN_REPO: f.plugin } }), /nested repository/);
  assert.equal(git(nested, 'log', '--format=%s', '-1'), 'nested');
  assert.throws(() => git(f.worktree, 'rev-parse', '--verify', preservedRefFor(f.task.dispatchId)));
});
