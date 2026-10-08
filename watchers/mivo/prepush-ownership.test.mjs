import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { finalize, repairPaths, validate, watchWorktreePath } from './bin/mivo-repair.mjs';
import { writePr } from './bin/mivo-state.mjs';
import { ownershipGh } from './ownership-gh.fixture.mjs';

function fixture(t, { revoke = false, hookFail = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil push fixture '));
  const home = path.join(root, 'watcher'), plugin = path.join(root, 'plugin');
  const tree = watchWorktreePath(plugin, 790), origin = path.join(root, 'origin.git');
  const signal = path.join(root, 'draft'), hookArgs = path.join(root, 'hook-args'), hookInput = path.join(root, 'hook-stdin');
  const referenceLog = path.join(root, 'reference-log');
  const oldPlugin = process.env.MIVO_PLUGIN_REPO;
  process.env.MIVO_PLUGIN_REPO = plugin;
  t.after(() => { if (oldPlugin === undefined) delete process.env.MIVO_PLUGIN_REPO; else process.env.MIVO_PLUGIN_REPO = oldPlugin;
    fs.rmSync(root, { recursive: true, force: true }); });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull,
    VIGIL_TEST_DRAFT: signal, VIGIL_TEST_ARGS: hookArgs, VIGIL_TEST_STDIN: hookInput,
    VIGIL_TEST_REFERENCES: referenceLog, VIGIL_TEST_REVOKE: revoke ? '1' : '0', VIGIL_TEST_HOOK_FAIL: hookFail ? '1' : '0' };
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  fs.mkdirSync(tree, { recursive: true });
  git('init', '--bare', origin); git('init', '-b', 'watch/pr-790', tree);
  git('-C', tree, 'config', 'user.name', 'Example User'); git('-C', tree, 'config', 'user.email', 'example@example.invalid');
  const hooks = path.join(tree, '.githooks'); fs.mkdirSync(hooks);
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\nset -eu\nif [ "$#" -gt 0 ]; then\n  printf '%s\\n' "$@" > "$VIGIL_TEST_ARGS"\n  cat > "$VIGIL_TEST_STDIN"\n  if [ "$VIGIL_TEST_REVOKE" = 1 ]; then : > "$VIGIL_TEST_DRAFT"; fi\n  if [ "$VIGIL_TEST_HOOK_FAIL" = 1 ]; then exit 42; fi\nfi\nprintf 'repository checks passed\\n'\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(hooks, 'reference-transaction'), '#!/bin/sh\nprintf "%s\\n" "$1" >> "$VIGIL_TEST_REFERENCES"\ncat >> "$VIGIL_TEST_REFERENCES"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(tree, 'example.txt'), 'before\n');
  git('-C', tree, 'add', '.'); git('-C', tree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline');
  const sourceHead = git('-C', tree, 'rev-parse', 'HEAD');
  git('-C', tree, 'remote', 'add', 'origin', origin); git('-C', tree, 'push', '-u', 'origin', 'HEAD:refs/heads/fix/fixture');
  fs.writeFileSync(path.join(tree, 'example.txt'), 'after\n'); git('-C', tree, 'add', '.');
  git('-C', tree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'repair');
  const head = git('-C', tree, 'rev-parse', 'HEAD');
  const task = { dispatchId: 'fixture-dispatch', nodeId: 'PR_790', number: 790, repo: 'example-org/example-plugin', sessionId: 'fixture-session',
    headRefOid: sourceHead, headRefName: 'fix/fixture', releaseEpoch: 'opened:PR_790:2026-10-01T00:00:00Z',
    feedback: [{ key: 'thread:one', source: 'thread', body: '**P1** core fixture failure', user: { login: 'github-actions[bot]', type: 'Bot' } }] };
  task.handoff = { version: 1, id: 'fixture-handoff', repo: task.repo, number: 790, nodeId: task.nodeId, head: sourceHead, releaseEpoch: task.releaseEpoch, author: 'ExampleUser' };
  const paths = repairPaths(home); fs.mkdirSync(paths.tasks, { recursive: true });
  const taskPath = path.join(paths.tasks, `${task.dispatchId}.json`); fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(home, task.nodeId, { nodeId: task.nodeId, number: 790, sessionId: task.sessionId, handoff: task.handoff, activeTask: { dispatchId: task.dispatchId } });
  env.GH_BIN = ownershipGh(root, taskPath, origin, signal);
  const ghFn = (_binary, args) => execFileSync(env.GH_BIN, args, { encoding: 'utf8', env });
  const commands = [];
  const gitFn = (_binary, args, options = {}) => { commands.push(args);
    return execFileSync('git', args, { encoding: 'utf8', timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'], ...options, env }).trim(); };
  const scReport = path.join(root, 'sc.json');
  fs.writeFileSync(scReport, JSON.stringify({ scs: [{ id: 'SC-1', status: 'pass', feedbackKeys: ['thread:one'], evidence: ['isolated repository fixture'] }] }));
  const options = { home, taskPath, scReport, validatedHead: head, ghFn, gitFn, originUrl: origin, env: { ...env, PREFLIGHT_SKIP: '0' } };
  assert.equal(validate(options).status, 'pass');
  git('-C', tree, 'config', 'core.hooksPath', '.githooks');
  return { root, tree, head, sourceHead, signal, hookArgs, hookInput, referenceLog, commands,
    finalize: () => finalize(options), remote: () => git('--git-dir', origin, 'rev-parse', 'refs/heads/fix/fixture'),
    config: () => git('-C', tree, 'config', '--get', 'core.hooksPath') };
}

function guardRemoved(f) {
  const setting = f.commands.find(args => args.includes('push'))?.find(arg => arg.startsWith('core.hooksPath='));
  assert.ok(setting, 'push must install its temporary ownership guard');
  assert.equal(fs.existsSync(setting.slice('core.hooksPath='.length)), false);
  assert.equal(f.config(), '.githooks');
}

test('Draft during the real pre-push hook prevents publication after repository checks', t => {
  const f = fixture(t, { revoke: true });
  assert.throws(f.finalize, /handoff|pre-push|non-draft/i);
  assert.equal(fs.existsSync(f.signal), true, 'the real repository hook ran');
  assert.equal(f.remote(), f.sourceHead, 'revoked ownership must not publish a commit');
  guardRemoved(f);
});

test('an authorized push preserves original hook arguments, stdin and other hooks', t => {
  const f = fixture(t);
  const result = f.finalize();
  assert.equal(result.pushed, true); assert.equal(f.remote(), f.head);
  assert.equal(fs.readFileSync(f.hookArgs, 'utf8').split('\n')[0], 'origin');
  assert.match(fs.readFileSync(f.hookInput, 'utf8'), new RegExp(`HEAD ${f.head} refs/heads/fix/fixture ${f.sourceHead}`));
  assert.match(fs.readFileSync(f.referenceLog, 'utf8'), /prepared[\s\S]*committed/);
  guardRemoved(f);
});

test('a failing original pre-push hook still rejects the push and restores configuration', t => {
  const f = fixture(t, { hookFail: true });
  assert.throws(f.finalize, /hook command failed|failed to push|pre-push/i);
  assert.equal(f.remote(), f.sourceHead);
  assert.equal(fs.existsSync(f.hookInput), true);
  guardRemoved(f);
});
