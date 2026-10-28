import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { cloneWorktree, prepare, preservedRefFor, preserveWatchCheckout, repairPaths, REPO } from './bin/cindy-repair.mjs';
import { writePr } from './bin/cindy-state.mjs';

const DISPATCH = 'live-7-2026-10-28T01:02:03.000Z';
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull };

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Example User', '-c', 'user.email=example@example.invalid', ...args], {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], env: GIT_ENV,
  }).trim();
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-preserve-'));
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
  fs.mkdirSync(plugin);
  git(plugin, 'init', '-b', 'main');
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const task = {
    dispatchId: DISPATCH, nodeId: 'PR_7', number: 7, repo: REPO, headRepo: 'ExampleUser/cindy-fork',
    headOwner: 'ExampleUser', sessionId: 'sess-7', headRefOid: baseHead, headRefName: 'feature',
  };
  const taskPath = path.join(paths.tasks, DISPATCH + '.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(home, 'PR_7', { number: 7, nodeId: 'PR_7', sessionId: 'sess-7', activeTask: { dispatchId: DISPATCH } });
  const gitFn = (binary, args, options = {}) => execFileSync(binary, args, {
    encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'], ...options, env: options.env ?? GIT_ENV,
  }).trim();
  const env = { ...process.env, CINDY_WATCHER_REPO: plugin };
  const checkout = cloneWorktree(paths, task, gitFn, origin, origin, baseHead, env);
  return { root, origin, seed, plugin, home, paths, task, taskPath, baseHead, gitFn, env, checkout };
}

function withPlugin(t, plugin) {
  const before = process.env.CINDY_WATCHER_REPO;
  process.env.CINDY_WATCHER_REPO = plugin;
  t.after(() => { if (before === undefined) delete process.env.CINDY_WATCHER_REPO; else process.env.CINDY_WATCHER_REPO = before; });
}

test('prepare preserves local commits and dirty files, copies the ref to the plugin repo, then resets', (t) => {
  const f = fixture(t);
  withPlugin(t, f.plugin);
  const worktree = f.checkout.worktree;
  git(worktree, 'commit', '--allow-empty', '-m', 'unpushed round commit');
  const original = git(worktree, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'local only\n');
  const result = prepare({
    home: f.home, taskPath: f.taskPath, viewer: 'ExampleUser', originUrl: f.origin, gitFn: f.gitFn, keelRoot: '/tmp',
    ghFn: (binary, args) => JSON.stringify({ id: 'PR_7', state: 'OPEN', isDraft: false, headRefOid: f.baseHead,
      headRefName: 'feature', baseRefOid: f.baseHead }),
  });
  assert.equal(result.status, 'prepared');
  assert.equal(result.head, f.baseHead);
  assert.equal(result.preservation.originalHead, original);
  assert.equal(result.preservation.hadUncommitted, true);
  assert.equal(result.preservation.backupRef, preservedRefFor(DISPATCH));
  assert.equal(result.preservation.backupRepo, f.plugin);
  assert.equal(git(worktree, 'rev-parse', 'HEAD'), f.baseHead);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
  assert.match(git(f.plugin, 'log', '--format=%H', result.preservation.backupRef), new RegExp(original));
  assert.equal(git(f.plugin, 'show', result.preservation.backupRef + ':dirty.txt'), 'local only');
  fs.rmSync(worktree, { recursive: true, force: true });
  assert.match(git(f.plugin, 'log', '--format=%H', result.preservation.backupRef), new RegExp(original));
});

test('prepare is a no-op on a clean clone at the PR head', (t) => {
  const f = fixture(t);
  withPlugin(t, f.plugin);
  const result = prepare({
    home: f.home, taskPath: f.taskPath, viewer: 'ExampleUser', originUrl: f.origin, gitFn: f.gitFn, keelRoot: '/tmp',
    ghFn: () => JSON.stringify({ id: 'PR_7', state: 'OPEN', isDraft: false, headRefOid: f.baseHead,
      headRefName: 'feature', baseRefOid: f.baseHead }),
  });
  assert.equal(result.status, 'prepared');
  assert.equal(result.preservation, null);
  assert.equal(result.realigned, null);
});

test('preserving uses a private index: what the session had staged stays exactly as it was', (t) => {
  const f = fixture(t);
  const wt = f.checkout.worktree;
  fs.writeFileSync(path.join(wt, 's.txt'), 'staged\n');
  git(wt, 'add', 's.txt');
  fs.writeFileSync(path.join(wt, 'a.txt'), 'unstaged edit\n');
  fs.writeFileSync(path.join(wt, 'u.txt'), 'untracked\n');
  const head = git(wt, 'rev-parse', 'HEAD');
  const saved = preserveWatchCheckout({ task: f.task, worktree: wt, originalHead: head, remoteHead: head, gitFn: f.gitFn, env: f.env });
  assert.equal(git(wt, 'diff', '--cached', '--name-only'), 's.txt');
  assert.match(git(wt, 'show', saved.backupHead + ':u.txt'), /untracked/);
  assert.match(git(wt, 'show', saved.backupHead + ':a.txt'), /unstaged edit/);
});

test('a nested repository in the watch tree is refused and the tree is left untouched', (t) => {
  const f = fixture(t);
  const wt = f.checkout.worktree;
  // a non-ASCII name: Git quotes such paths unless status is read with -z
  const nested = path.join(wt, '嵌套仓');
  fs.mkdirSync(nested);
  git(nested, 'init', '-b', 'main');
  fs.writeFileSync(path.join(nested, 'n.txt'), 'nested work\n');
  git(nested, 'add', '.');
  git(nested, '-c', 'commit.gpgsign=false', 'commit', '-m', 'nested');
  const head = git(wt, 'rev-parse', 'HEAD');
  assert.throws(() => preserveWatchCheckout({ task: f.task, worktree: wt, originalHead: head, remoteHead: head, gitFn: f.gitFn, env: f.env }), /nested repository/);
  assert.equal(git(nested, 'log', '--format=%s', '-1'), 'nested');
  assert.throws(() => git(wt, 'rev-parse', '--verify', preservedRefFor(f.task.dispatchId)));
});
