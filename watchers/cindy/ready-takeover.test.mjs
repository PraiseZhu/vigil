import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { feedbackRepairPolicy, isTriageThread } from './bin/cindy-feedback-policy.mjs';
import { refutedThreads, closeRefutedThreads } from './bin/cindy-review-resolve.mjs';
import { alignWatchWorktree, command } from './bin/cindy-repair.mjs';
import { reopenInfraBlocked, INFRA_REOPEN_LIMIT } from './bin/cindy-watcher.mjs';

const HEAD = 'a'.repeat(40);
const thread = (extra) => ({ source: 'thread', threadId: 'PRRT_example', nativeId: 'PRRT_example:1', sha: HEAD,
  body: '这里切回本机后还会失败吗？', user: { login: 'ExampleMaintainer', __typename: 'User' }, ...extra });

// Every unresolved review thread blocks the merge; the ones nobody handled kept fork PRs stuck.
test('maintainer, author and review-app threads go to the session for grading; others do not', () => {
  for (const extra of [{ authorAssociation: 'MEMBER' }, { authorAssociation: 'OWNER' }, { authorAssociation: 'CONTRIBUTOR', fromPrAuthor: true },
    { user: { login: 'chatgpt-codex-connector', __typename: 'Bot' } }]) {
    const policy = feedbackRepairPolicy(thread(extra), { headSha: HEAD });
    assert.equal(policy.action, 'code-fix', JSON.stringify(extra));
    assert.equal(policy.reason, 'review-thread-triage');
  }
  assert.equal(feedbackRepairPolicy(thread({ authorAssociation: 'CONTRIBUTOR' }), { headSha: HEAD }).action, 'needs-triage');
  assert.equal(feedbackRepairPolicy(thread({ user: { login: 'random-app', __typename: 'Bot' } }), { headSha: HEAD }).action, 'needs-triage');
  assert.equal(isTriageThread(thread({ authorAssociation: 'MEMBER', threadId: undefined })), false);
});

test('a status comment from an untrusted app no longer opens a session', () => {
  const comment = { source: 'comment', nativeId: '9', sha: HEAD, body: 'Codex Review Summary: Failed', user: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' } };
  assert.equal(feedbackRepairPolicy(comment, { headSha: HEAD }).action, 'ignore-infra');
  assert.equal(feedbackRepairPolicy({ ...comment, user: { login: 'ExampleMaintainer' } }, { headSha: HEAD }).action, 'needs-triage');
});

test('a triaged thread graded no-change is answered as a triage, with the receipt marker', () => {
  const key = 'thread:PRRT_example:1';
  const task = { dispatchId: 'task-1', repairPolicy: { items: [{ key, action: 'code-fix', reason: 'review-thread-triage' }] } };
  const result = { schemaVersion: 2, status: 'complete', dispatchId: 'task-1',
    feedbackCoverage: { dispositions: [{ key, disposition: 'no-change' }] },
    scs: [{ status: 'no-change', feedbackKeys: [key], evidence: ['这是命名建议，不影响行为。'] }] };
  const items = refutedThreads(result, task);
  assert.equal(items[0].triage, true);
  const calls = [];
  const run = closeRefutedThreads({ items, dispatchId: 'task-1', previous: {}, ghFn: args => { calls.push(args); return {}; }, now: 'n' });
  let next = run.next(); while (!next.done) next = run.next(next.value());
  const body = calls[0].find(arg => arg.startsWith('body=')).slice(5);
  assert.match(body, /按仓库统一分级核实/);
  assert.match(body, /cindy-watcher-receipt task=task-1/);
  assert.equal(next.value.previous.autoClosedThreads.PRRT_example.reason, 'review-thread-no-change');
});

function gitRepos(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-align-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Example User', '-c', 'user.email=example@example.invalid', ...args], { encoding: 'utf8' }).trim();
  const fork = path.join(root, 'fork.git');
  const seed = path.join(root, 'seed');
  const watch = path.join(root, 'watch');
  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(plugin);
  git(root, 'init', '--bare', '-b', 'main', fork);
  git(root, 'init', '-b', 'feature', seed);
  git(seed, 'commit', '--allow-empty', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', fork);
  git(seed, 'push', 'origin', 'feature');
  git(root, 'clone', '--branch', 'feature', fork, watch);
  git(watch, 'checkout', '-B', 'watch/pr-7');
  return { root, git, fork, seed, watch, plugin };
}
const gitFn = (binary, args) => command(binary, args);

test('a watch tree behind the fork fast-forwards; one ahead keeps its commits', t => {
  const r = gitRepos(t);
  r.git(r.seed, 'commit', '--allow-empty', '-m', 'author push');
  r.git(r.seed, 'push', 'origin', 'feature');
  const remoteHead = r.git(r.seed, 'rev-parse', 'HEAD');
  const task = { number: 7, headRefName: 'feature' };
  const behind = alignWatchWorktree({ task, checkout: { worktree: r.watch, head: r.git(r.watch, 'rev-parse', 'HEAD'), created: false }, remoteHead, gitFn, env: { CINDY_WATCHER_REPO: r.plugin } });
  assert.equal(behind.head, remoteHead);
  assert.equal(behind.realigned.backup, null);
  r.git(r.watch, 'commit', '--allow-empty', '-m', 'this round, not pushed yet');
  const local = r.git(r.watch, 'rev-parse', 'HEAD');
  const ahead = alignWatchWorktree({ task, checkout: { worktree: r.watch, head: local, created: false }, remoteHead, gitFn, env: { CINDY_WATCHER_REPO: r.plugin } });
  assert.equal(ahead.head, local);
  assert.equal(ahead.realigned, null);
});

// 2026-10-15 #6077: an earlier round's unpushed commit and the author's own push diverged, and every later round
// blocked on "worktree HEAD does not match validated-head".
test('a watch tree that diverged from the fork is backed up and rebuilt from the fork head', t => {
  const r = gitRepos(t);
  r.git(r.watch, 'commit', '--allow-empty', '-m', 'stale round commit');
  const stale = r.git(r.watch, 'rev-parse', 'HEAD');
  r.git(r.seed, 'commit', '--allow-empty', '-m', 'author push');
  r.git(r.seed, 'push', 'origin', 'feature');
  const remoteHead = r.git(r.seed, 'rev-parse', 'HEAD');
  const aligned = alignWatchWorktree({ task: { number: 7, headRefName: 'feature' }, checkout: { worktree: r.watch, head: stale, created: false },
    remoteHead, gitFn, now: '2026-10-15T00:00:00Z', env: { CINDY_WATCHER_REPO: r.plugin } });
  assert.equal(aligned.head, remoteHead);
  assert.equal(aligned.realigned.from, stale);
  assert.ok(fs.existsSync(aligned.realigned.backup), 'the stale commit is kept in a bundle');
  assert.match(r.git(r.root, 'bundle', 'list-heads', aligned.realigned.backup), new RegExp(stale));
});

test('an environment block hands its feedback back with the round refunded, a bounded number of times', t => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-infra-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(stateDir, 'tasks'));
  const write = (id) => fs.writeFileSync(path.join(stateDir, 'tasks', `${id}.json`), JSON.stringify({ nodeId: 'PR_7', feedback: [{ key: 'greptile:PRRT_x:1' }] }));
  const entry = (id, reason, extra = {}) => ({ nodeId: 'PR_7', admissionEpoch: 'ready:PR_7:R1:2026-10-15T00:00:00Z', repairRounds: 2, eligibility: 'blocked',
    feedbackCursor: { 'greptile:PRRT_x:1': 'seen', other: 'kept' }, activeTask: { status: 'blocked', blockedKind: 'external', dispatchId: id, reason }, ...extra });
  write('t1');
  const reopened = reopenInfraBlocked({ previous: entry('t1', 'preflight exit 1: pathspec cindy-protocol did not match'), paths: { stateDir }, now: 'n' });
  assert.equal(reopened.eligibility, 'active');
  assert.equal(reopened.repairRounds, 1);
  assert.deepEqual(reopened.feedbackCursor, { other: 'kept' });
  assert.equal(reopenInfraBlocked({ previous: reopened, paths: { stateDir }, now: 'n' }), reopened, 'same task only once');
  const real = entry('t1', 'required CI failed: unit');
  assert.equal(reopenInfraBlocked({ previous: real, paths: { stateDir }, now: 'n' }), real, 'a real failure stays blocked');
  const spent = Array.from({ length: INFRA_REOPEN_LIMIT }, (_, i) => ({ dispatchId: `old-${i}`, epoch: 'ready:PR_7:R1:2026-10-15T00:00:00Z' }));
  const limited = entry('t1', 'worktree HEAD does not match validated-head', { infraReopened: spent });
  assert.equal(reopenInfraBlocked({ previous: limited, paths: { stateDir }, now: 'n' }), limited, 'bounded per Ready epoch');
});
