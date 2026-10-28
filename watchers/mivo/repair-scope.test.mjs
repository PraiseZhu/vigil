import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { adjudicationBrief, assertDisputesAdjudicated, assertOwner, finalize, recheck, repairPaths, validate, watchWorktreePath } from './bin/mivo-repair.mjs';
import { writePr } from './bin/mivo-state.mjs';
import { ownershipGh } from './ownership-gh.fixture.mjs';

const REPO = 'example-org/example-plugin';
const ADJUDICATOR = { purpose: 'adjudicate', agent: 'codex', model: 'arbiter-model', effort: 'medium', providerId: 'route-c', workerId: 'w-arbiter', verdict: 'finding does not hold' };
const finding = (priority, key = `thread:${priority}`) => ({
  key, source: 'thread', user: { login: 'github-actions[bot]', type: 'Bot' },
  body: `**${priority}**: synthetic finding in src/example.ts`,
});

// Every Git mutation is confined to this test's disposable repositories. gh is
// entirely simulated; unexpected API calls fail instead of reaching the network.
function fixture(t, { changed = true, lockfile = false, nodeModules = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-repair-scope-'));
  const home = path.join(root, 'watcher');
  const plugin = path.join(root, 'plugin');
  const worktree = watchWorktreePath(plugin, 790);
  const originUrl = path.join(root, 'origin.git');
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  }).trim();
  const previousPlugin = process.env.MIVO_PLUGIN_REPO;
  const previousGh = process.env.GH_BIN;
  process.env.MIVO_PLUGIN_REPO = plugin;
  t.after(() => {
    if (previousPlugin === undefined) delete process.env.MIVO_PLUGIN_REPO;
    else process.env.MIVO_PLUGIN_REPO = previousPlugin;
    if (previousGh === undefined) delete process.env.GH_BIN;
    else process.env.GH_BIN = previousGh;
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(worktree, { recursive: true });
  git('init', '--bare', originUrl);
  git('init', '-b', 'watch/pr-790', worktree);
  git('-C', worktree, 'config', 'user.name', 'Repair scope fixture');
  git('-C', worktree, 'config', 'user.email', 'repair-scope@example.invalid');
  fs.mkdirSync(path.join(worktree, '.githooks'));
  fs.writeFileSync(path.join(worktree, '.githooks/pre-push'), '#!/bin/bash\nset -eu\nprintf "fixture checks passed\\n"\n');
  fs.writeFileSync(path.join(worktree, 'example.txt'), 'baseline\n');
  if (lockfile) {
    fs.writeFileSync(path.join(worktree, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
    fs.writeFileSync(path.join(worktree, 'package-lock.json'), JSON.stringify({
      name: 'fixture', lockfileVersion: 3, requires: true, packages: { '': { name: 'fixture' } },
    }));
    fs.writeFileSync(path.join(worktree, '.gitignore'), 'node_modules\n');
  }
  git('-C', worktree, 'add', '.');
  git('-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture baseline');
  if (nodeModules) fs.mkdirSync(path.join(worktree, 'node_modules'));
  if (nodeModules === true) fs.writeFileSync(path.join(worktree, 'node_modules', '.package-lock.json'), '{}');
  const sourceHead = git('-C', worktree, 'rev-parse', 'HEAD');
  git('-C', worktree, 'remote', 'add', 'origin', originUrl);
  git('-C', worktree, 'push', '-u', 'origin', 'HEAD:refs/heads/fix/scope');
  if (changed) {
    fs.writeFileSync(path.join(worktree, 'example.txt'), 'synthetic repair\n');
    git('-C', worktree, 'add', '.');
    git('-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture repair');
  }
  const head = git('-C', worktree, 'rev-parse', 'HEAD');
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const taskPath = path.join(paths.tasks, 'scope-dispatch.json');
  const task = { dispatchId: 'scope-dispatch', nodeId: 'PR_790', number: 790, repo: REPO,
    sessionId: 'scope-session', headRefOid: sourceHead, headRefName: 'fix/scope', feedback: [finding('P1')],
    releaseEpoch: 'opened:PR_790:2026-10-01T00:00:00Z' };
  task.handoff = { version: 1, id: 'handoff-fixture', repo: REPO, number: 790, nodeId: task.nodeId,
    head: sourceHead, releaseEpoch: task.releaseEpoch, author: 'ExampleUser' };
  const saveTask = (feedback) => {
    task.feedback = feedback;
    // A stale or forged cached policy must not override the underlying feedback.
    task.repairPolicy = { canChangeCode: true, allowedFeedbackKeys: feedback.map(item => item.key) };
    fs.writeFileSync(taskPath, JSON.stringify(task));
  };
  saveTask(task.feedback);
  process.env.GH_BIN = ownershipGh(root, taskPath, originUrl);
  writePr(home, task.nodeId, { number: task.number, nodeId: task.nodeId, sessionId: task.sessionId,
    handoff: task.handoff, activeTask: { dispatchId: task.dispatchId } });
  let remoteHead = sourceHead;
  let ciConclusionValue = 'success';
  const ciConclusion = () => ciConclusionValue;
  const pushCalls = [];
  const ghCalls = [];
  const gitFn = (_binary, args) => {
    if (args.includes('push')) {
      pushCalls.push(args);
      // Check the destination before delegating even a test-only push.
      assert.equal(git('-C', worktree, 'remote', 'get-url', 'origin'), originUrl);
    }
    const out = git(...args);
    if (args.includes('push')) remoteHead = git('--git-dir', originUrl, 'rev-parse', 'refs/heads/fix/scope');
    return out;
  };
  const pr = () => ({ id: task.nodeId, number: task.number, state: 'OPEN', isDraft: false,
    headRefOid: remoteHead, headRefName: task.headRefName, baseRefOid: sourceHead, baseRefName: 'main',
    createdAt: '2026-10-01T00:00:00Z', author: { login: 'ExampleUser' }, isCrossRepository: false,
    headRepositoryOwner: { login: 'example-org' }, headRepository: { name: 'example-plugin' } });
  const ghFn = (_binary, args) => {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr());
    const endpoint = args[1];
    if (endpoint === 'graphql') return JSON.stringify({ data: { node: { timelineItems: { nodes: [], pageInfo: { hasNextPage: false } } } } });
    if (endpoint === `repos/${REPO}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify({ required_status_checks: {
      contexts: ['verify'], checks: [{ context: 'verify', app_id: 123 }],
    } });
    if (endpoint === `repos/${REPO}/rules/branches/main?per_page=100`) return JSON.stringify([[]]);
    if (endpoint === `repos/${REPO}/contents/docs/sync/required-checks.json?ref=${sourceHead}`) return JSON.stringify({
      type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['verify'], pr_only: [] })).toString('base64'),
    });
    if (String(endpoint).startsWith(`repos/${REPO}/commits/${remoteHead}/check-runs`)) {
      const conclusion = ciConclusion();
      return JSON.stringify([{ check_runs: [{
        id: 101, name: 'verify', head_sha: remoteHead,
        status: conclusion === 'pending' ? 'in_progress' : 'completed', conclusion: conclusion === 'pending' ? null : conclusion,
        started_at: '2026-09-29T00:00:00Z', app: { id: 123, slug: 'github-actions' },
        details_url: `https://github.com/${REPO}/actions/runs/555/job/101`,
      }] }]);
    }
    if (endpoint === `repos/${REPO}/actions/jobs/101`) return JSON.stringify({
      id: 101, run_id: 555, head_sha: remoteHead, run_attempt: 1,
      check_run_url: `https://api.github.com/repos/${REPO}/check-runs/101`,
    });
    if (endpoint === `repos/${REPO}/actions/runs/555`) return JSON.stringify({
      id: 555, repository: { full_name: REPO }, head_sha: remoteHead, run_attempt: 1,
    });
    if (args[0] === 'run' && args[1] === 'rerun') return '';
    if (String(endpoint).startsWith(`repos/${REPO}/commits/${remoteHead}/statuses`)) return JSON.stringify([[]]);
    assert.fail(`unexpected GitHub call: ${JSON.stringify(args)}`);
  };
  const scReport = path.join(root, 'sc-report.json');
  // A no-change on a fixable review finding is a dispute; the default report carries the arbiter's ruling.
  const report = (scs, workers = [ADJUDICATOR]) => fs.writeFileSync(scReport, JSON.stringify({ scs, workers }));
  const sc = (status, feedbackKeys) => ({ id: `SC-${feedbackKeys.join('-') || 'empty'}`, status,
    feedbackKeys, evidence: ['synthetic fixture checked locally'] });
  const options = { home, taskPath, scReport, validatedHead: head, originUrl, gitFn, ghFn,
    env: { ...process.env, PREFLIGHT_SKIP: '0' } };
  return { task, paths, worktree, sourceHead, head, options, saveTask, report, sc, pushCalls, ghCalls,
    setCiConclusion: (value) => { ciConclusionValue = value; },
    remoteHead: () => git('--git-dir', originUrl, 'rev-parse', 'refs/heads/fix/scope'),
    validate: () => validate(options), finalize: () => finalize(options) };
}

for (const status of ['pass', 'no-change']) {
  test(`P3-only changed HEAD cannot finalize ${status}, even with a valid prior validation receipt`, async (t) => {
    const f = fixture(t);
    assert.equal((await f.validate()).status, 'pass');
    f.saveTask([{ ...finding('P3'), category: 'actionable-fix', priority: 'P1',
      repairPolicy: { action: 'code-fix', canChangeCode: true } }]);
    f.report([f.sc(status, ['thread:P3'])]);
    assert.throws(f.finalize, /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限/i);
    assert.equal(f.pushCalls.length, 0);
    assert.equal(f.remoteHead(), f.sourceHead);
    assert.equal(fs.existsSync(path.join(f.paths.results, `${f.task.dispatchId}.json`)), false);
  });
}

test('P2-only unchanged HEAD closes the complete no-change flow without validation or push', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P2')]);
  f.report([f.sc('no-change', ['thread:P2'])]);
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.equal(result.pushed, false);
  assert.equal(result.verification.status, 'not-required-no-change');
  assert.equal(result.feedbackCoverage.dispositions[0].disposition, 'no-change');
  assert.equal(result.ci.requiredGreen, true);
  assert.ok(f.ghCalls.some(args => args[1]?.includes('/check-runs?')));
  assert.equal(f.pushCalls.length, 0);
});

test('a P1 in the same task does not authorize an SC marking P3 fixed', async (t) => {
  const f = fixture(t);
  f.saveTask([finding('P1'), finding('P3')]);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1']), f.sc('pass', ['thread:P3'])]);
  assert.throws(f.finalize, /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限|no.change/i);
  assert.equal(f.pushCalls.length, 0);
  assert.equal(f.remoteHead(), f.sourceHead);
});

for (const kind of ['P1', 'P2', 'required-ci']) {
  test(`${kind} authorized repair can validate, push to fixture origin and close against current-head CI`, async (t) => {
    const f = fixture(t);
    const feedback = kind === 'required-ci' ? {
      key: 'ci:verify', source: 'ci', sha: f.sourceHead,
      requiredFailure: { verified: true, status: 'failed', headSha: f.sourceHead },
    } : finding(kind);
    f.saveTask([feedback]);
    assert.equal((await f.validate()).status, 'pass');
    f.report([f.sc('pass', [feedback.key])]);
    const result = f.finalize();
    assert.equal(result.status, 'complete');
    assert.equal(result.pushed, true);
    assert.equal(result.verification.status, 'pass');
    assert.equal(result.ci.requiredGreen, true);
    assert.equal(f.pushCalls.length, 1);
    assert.equal(f.remoteHead(), f.head);
  });
}

for (const kind of ['P2', 'P3', 'unknown', 'empty']) {
  test(`${kind} feedback cannot publish a changed HEAD through no-change SCs`, async (t) => {
    const f = fixture(t);
    assert.equal((await f.validate()).status, 'pass');
    const feedback = kind === 'empty' ? [] : kind === 'unknown'
      ? [{ ...finding('P1'), key: 'thread:unknown', body: 'Please consider this improvement.' }]
      : [finding(kind)];
    f.saveTask(feedback);
    f.report([f.sc('no-change', feedback.map(item => item.key))]);
    assert.throws(f.finalize, /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限/i);
    assert.equal(f.pushCalls.length, 0);
    assert.equal(f.remoteHead(), f.sourceHead);
  });
}

test('SC3 validate heartbeat refreshes activity during a blocking preflight', async (t) => {
  const previous = process.env.VIGIL_ACTIVITY_HEARTBEAT_MS;
  process.env.VIGIL_ACTIVITY_HEARTBEAT_MS = '1000';
  t.after(() => {
    if (previous === undefined) delete process.env.VIGIL_ACTIVITY_HEARTBEAT_MS;
    else process.env.VIGIL_ACTIVITY_HEARTBEAT_MS = previous;
  });
  const { validate } = await import(`./bin/mivo-repair.mjs?heartbeat=${Date.now()}`);
  const f = fixture(t);
  const file = path.join(f.paths.home, 'state', 'activity', `${f.task.dispatchId}.json`);
  const result = await validate({
    ...f.options,
    runFn: () => {
      const first = JSON.parse(fs.readFileSync(file, 'utf8')).at;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
      assert.notEqual(JSON.parse(fs.readFileSync(file, 'utf8')).at, first);
      return 'passed\n';
    },
  });
  assert.equal(result.status, 'pass');
});

test('SC7 no-change required-CI failure reruns failed jobs once, then escalates', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P2')]);
  f.report([f.sc('no-change', ['thread:P2'])]);
  f.setCiConclusion('failure');
  const first = f.finalize();
  assert.equal(first.status, 'waiting-ci');
  assert.equal(first.ciRetrigger.method, 'gh-rerun');
  assert.deepEqual(first.ciRetrigger.runIds, ['555']);
  assert.equal(f.ghCalls.filter((args) => args[0] === 'run' && args[1] === 'rerun').length, 1);
  const second = f.finalize();
  assert.equal(second.status, 'blocked');
  assert.equal(second.blockedKind, 'external');
  assert.equal(f.ghCalls.filter((args) => args[0] === 'run' && args[1] === 'rerun').length, 1);
});

test('R4 replacing a required-CI task on the same head must not retrigger again', async (t) => {
  const f = fixture(t, { changed: false });
  const ci = (head) => ({
    key: 'ci:verify', source: 'ci', nativeId: 'verify', sha: head,
    requiredFailure: { verified: true, status: 'failed', headSha: head },
  });
  f.saveTask([ci(f.sourceHead)]);
  f.report([f.sc('no-change', ['ci:verify'])]);
  f.setCiConclusion('failure');
  const first = f.finalize();
  assert.equal(first.status, 'waiting-ci');
  const nextHead = f.remoteHead();
  const task = {
    ...f.task, dispatchId: 'second-dispatch', headRefOid: nextHead,
    feedback: [ci(nextHead), finding('P1', 'thread:new')],
  };
  if (task.handoff) task.handoff = { ...task.handoff, head: nextHead };
  const taskPath = path.join(f.paths.tasks, 'second-dispatch.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(f.paths.home, task.nodeId, {
    number: task.number, nodeId: task.nodeId, sessionId: task.sessionId,
    handoff: task.handoff, activeTask: { dispatchId: task.dispatchId },
  });
  f.report([f.sc('no-change', ['ci:verify', 'thread:new'])]);
  const second = finalize({ ...f.options, taskPath, validatedHead: nextHead });
  assert.notEqual(second.status, 'waiting-ci');
  assert.equal(second.status, 'blocked');
  assert.equal(second.blockedKind, 'external');
  assert.equal(f.ghCalls.filter((args) => args[0] === 'run' && args[1] === 'rerun').length, 1);
});

test('R3-4 a repeated finalize while the rerun is pending keeps the one-retry quota for the head', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P2')]);
  f.report([f.sc('no-change', ['thread:P2'])]);
  const reruns = () => f.ghCalls.filter((args) => args[0] === 'run' && args[1] === 'rerun').length;
  f.setCiConclusion('failure');
  assert.equal(f.finalize().status, 'waiting-ci');
  assert.equal(reruns(), 1);
  f.setCiConclusion('pending');
  const pending = f.finalize();
  assert.equal(pending.status, 'waiting-ci');
  assert.equal(pending.ciRetrigger?.method, 'gh-rerun', 'a later receipt must keep the recorded retrigger');
  f.setCiConclusion('failure');
  const again = f.finalize();
  assert.equal(again.status, 'blocked');
  assert.equal(again.blockedKind, 'external');
  assert.equal(reruns(), 1, 'the same head must not be rerun twice');
});

test('R3-4 the retrigger quota survives a lost result file for the same head', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P2')]);
  f.report([f.sc('no-change', ['thread:P2'])]);
  f.setCiConclusion('failure');
  assert.equal(f.finalize().status, 'waiting-ci');
  fs.rmSync(path.join(f.paths.results, `${f.task.dispatchId}.json`));
  const again = f.finalize();
  assert.equal(again.status, 'blocked');
  assert.equal(f.ghCalls.filter((args) => args[0] === 'run' && args[1] === 'rerun').length, 1);
});

test('R3-2 the validate heartbeat stops once its helper process is gone', async (t) => {
  const previous = process.env.VIGIL_ACTIVITY_HEARTBEAT_MS;
  process.env.VIGIL_ACTIVITY_HEARTBEAT_MS = '1000';
  t.after(() => {
    if (previous === undefined) delete process.env.VIGIL_ACTIVITY_HEARTBEAT_MS;
    else process.env.VIGIL_ACTIVITY_HEARTBEAT_MS = previous;
  });
  const { startActivityHeartbeat } = await import(`./bin/mivo-repair.mjs?orphan=${Date.now()}`);
  const f = fixture(t);
  const file = path.join(f.paths.home, 'state', 'activity', `${f.task.dispatchId}.json`);
  // A helper that dies without running its cleanup: the heartbeat watches this pid instead of ours.
  const helper = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(helper.stdout);
  startActivityHeartbeat(f.paths, f.task, 'validate', { parentPid: deadPid });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const first = fs.readFileSync(file, 'utf8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'an orphaned heartbeat must not keep the task looking active');
});

test('mixed task can fix P1 while explicitly leaving P2 unchanged', async (t) => {
  const f = fixture(t);
  f.saveTask([finding('P1'), finding('P2')]);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1']), f.sc('no-change', ['thread:P2'])]);
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.equal(f.pushCalls.length, 1);
  assert.deepEqual(result.feedbackCoverage.dispositions.map(item => [item.key, item.disposition]),
    [['thread:P1', 'fixed'], ['thread:P2', 'no-change']]);
});

test('P3-only validation rejects a changed HEAD before running preflight', async (t) => {
  const f = fixture(t);
  f.saveTask([finding('P3')]);
  let preflightRuns = 0;
  await assert.rejects(() => validate({ ...f.options, runFn: () => { preflightRuns++; return 'passed'; } }),
    /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限/i);
  assert.equal(preflightRuns, 0);
  assert.equal(f.pushCalls.length, 0);
});

test('recheck cannot certify a changed HEAD after its feedback loses repair authority', async (t) => {
  const f = fixture(t);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  assert.equal(f.finalize().status, 'complete');
  f.saveTask([{ ...finding('P3'), key: 'thread:P1' }]);
  const pushesBefore = f.pushCalls.length;
  assert.throws(() => recheck(f.options), /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限|no.change/i);
  assert.equal(f.pushCalls.length, pushesBefore);
});

test('v2 finalize never pushes with missing config or only a task registration', async t => {
  const f = fixture(t);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  f.task.keelFlow = true;
  f.task.keelFlowVersion = 2;
  f.task.createdAt = '2026-10-06T00:00:00Z';
  f.saveTask(f.task.feedback);
  assert.throws(() => finalize({ ...f.options, keelRoot: null }), /KEEL_RUN_REQUIRED/);
  const keelRoot = keelLedger(t, 'run-v2', [{run_id:'run-v2',at:'2026-10-06T00:00:01Z',kind:'step',summary:'vigil task=scope-dispatch'}]);
  assert.throws(() => finalize({ ...f.options, keelRoot, keelRun:'run-v2' }), /KEEL_RUN_REQUIRED/);
  assert.equal(f.pushCalls.length, 0);
  assert.equal(f.remoteHead(), f.sourceHead);
});

function keelLedger(t, runId, rows) {


  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-keel-ledger-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runs', runId), { recursive: true });
  fs.writeFileSync(path.join(root, 'runs', runId, 'decisions.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return root;
}

test('finalize with a Keel ledger root refuses to push without a bound Keel run', async (t) => {
  const f = fixture(t);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  f.task.keelFlow = true;
  f.saveTask(f.task.feedback);
  const keelRoot = keelLedger(t, 'run-1', [{ at: '2026-10-06T00:00:00Z', kind: 'step', summary: 'unrelated run' }]);
  assert.throws(() => finalize({ ...f.options, keelRoot }), /KEEL_RUN_REQUIRED.*--keel-run/);
  assert.throws(() => finalize({ ...f.options, keelRoot, keelRun: 'run-1' }), /KEEL_RUN_REQUIRED.*task=scope-dispatch/);
  assert.equal(f.pushCalls.length, 0);
  assert.equal(f.remoteHead(), f.sourceHead);
});

test('finalize pushes once the Keel run carries this task binding and reports it', async (t) => {
  const f = fixture(t);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  f.task.keelFlow = true;
  f.saveTask(f.task.feedback);
  const keelRoot = keelLedger(t, 'run-2', [
    { at: '2026-10-06T00:00:00Z', kind: 'decision', summary: 'J2 depth' },
    { at: '2026-10-06T00:00:01Z', kind: 'step', summary: 'vigil task=scope-dispatch' },
  ]);
  const result = finalize({ ...f.options, keelRoot, keelRun: 'run-2' });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.keel, { status: 'verified', runId: 'run-2', rows: 2, decisions: 1, contractVersion: 1 });
  assert.equal(f.remoteHead(), f.head);
});

test('finalize keeps closing tasks dispatched before the Keel prompt', async (t) => {
  const f = fixture(t);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  const keelRoot = keelLedger(t, 'run-3', []);
  const result = finalize({ ...f.options, keelRoot });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.keel, { status: 'not-required-legacy-task' });
});


test('assert-owner refuses tasks without explicit handoff and stale GitHub heads', async t => {
  const f = fixture(t);
  assert.equal(assertOwner(f.options).status, 'owned');
  assert.throws(() => assertOwner({ ...f.options, ownershipFn: () => { throw Error('network unavailable'); } }), /network unavailable/);
  const { handoff } = f.task;
  delete f.task.handoff;
  f.saveTask(f.task.feedback);
  assert.throws(() => assertOwner(f.options), /handoff/i);
  f.task.handoff = handoff;
  f.saveTask(f.task.feedback);
  assert.throws(() => assertOwner({ ...f.options, ownershipFn: () => ({ repo: REPO, number: 790,
    id: f.task.nodeId, state: 'OPEN', isDraft: false, sameRepository: true, identityVerified: true,
    createdAt: '2026-10-01T00:00:00Z', author: { login: 'ExampleUser' }, headRefName: f.task.headRefName, headRefOid: 'f'.repeat(40),
    releaseEpoch: f.task.releaseEpoch }) }), /head/i);
});

for (const loss of ['draft', 'epoch', 'reclaimed', 'network']) {
  test(`validate refuses a pass receipt when ownership changes during preflight: ${loss}`, async t => {
    const f = fixture(t);
    let after = false;
    const ghFn = (binary, args) => {
      if (after && loss === 'network') throw Error('network unavailable');
      const value = JSON.parse(f.options.ghFn(binary, args));
      if (after && loss === 'draft' && args[0] === 'pr') value.isDraft = true;
      if (after && loss === 'epoch' && args[1] === 'graphql') value.data.node.timelineItems.nodes = [
        { __typename: 'ReadyForReviewEvent', id: 'new-release', createdAt: '2026-10-02T00:00:00Z' },
      ];
      return JSON.stringify(value);
    };
    const result = await validate({ ...f.options, ghFn, runFn: () => {
      after = true;
      if (loss === 'reclaimed') writePr(f.options.home, f.task.nodeId, { sessionId: f.task.sessionId,
        handoff: null, activeTask: { dispatchId: f.task.dispatchId } });
      return 'checks passed';
    } });
    assert.equal(result.status, 'fail');
    assert.match(JSON.parse(fs.readFileSync(result.receiptPath)).reason, /handoff|OPEN|draft|epoch|network/i);
    assert.equal(f.pushCalls.length, 0);
  });
}

test('finalize rechecks ownership immediately before any push', async t => {
  const f = fixture(t);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  let checks = 0;
  const ghFn = (binary, args) => {
    const value = JSON.parse(f.options.ghFn(binary, args));
    if (args[0] === 'pr' && args[1] === 'view') {
      checks++;
      if (checks >= 3) value.isDraft = true;
    }
    return JSON.stringify(value);
  };
  assert.throws(() => finalize({ ...f.options, ghFn }), /OPEN|draft|handoff/i);
  assert.equal(f.pushCalls.length, 0);
});


test('only recorded controlled pushes let finalize and recheck retain the task ownership', async t => {
  const f = fixture(t);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  assert.equal(f.finalize().pushed, true);
  // A bare write checkpoint never opts in to the validated-head recovery path.
  assert.throws(() => assertOwner(f.options), /head is stale/);
  assert.equal(recheck(f.options).status, 'complete');
  assert.equal(f.finalize().pushed, true);
  assert.equal(recheck(f.options).status, 'complete');
  assert.equal(f.pushCalls.length, 1);
});

test('assert-owner refuses superseded tasks and changed handoff binding at the same head', async t => {
  const f = fixture(t);
  const base = { sessionId: f.task.sessionId, handoff: f.task.handoff,
    activeTask: { dispatchId: f.task.dispatchId } };
  for (const entry of [
    { ...base, activeTask: null },
    { ...base, activeTask: { dispatchId: 'new-task' } },
    { ...base, handoff: { ...f.task.handoff, id: 'replacement' } },
    { ...base, handoff: { ...f.task.handoff, releaseEpoch: 'another-release' } },
  ]) {
    writePr(f.options.home, f.task.nodeId, entry);
    assert.throws(() => assertOwner(f.options), /handoff|dispatch/);
  }
});

test('W-1 finalize keeps the workers the session reported', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P2')]);
  const workers = [
    { purpose: 'review', agent: 'claude-code', model: 'review-model', effort: 'max', providerId: 'route-a', workerId: 'w-review', verdict: 'PASS' },
    { purpose: 'consult', agent: 'codex', model: 'consult-model', effort: 'medium', providerId: 'route-b', workerId: 'w-consult', verdict: 'suggested fix' },
    ADJUDICATOR,
  ];
  fs.writeFileSync(f.options.scReport, JSON.stringify({ scs: [f.sc('no-change', ['thread:P2'])], workers }));
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.workers, workers);
});

for (const [label, workers] of [
  ['a third consult worker', [1, 2, 3].map((n) => ({ purpose: 'consult', agent: 'codex', model: `m${n}`, effort: 'medium' }))],
  ['a consult worker at max effort', [{ purpose: 'consult', agent: 'codex', model: 'm', effort: 'max' }]],
]) {
  test(`W-2 finalize rejects ${label} before any push`, async (t) => {
    const f = fixture(t, { changed: false });
    f.saveTask([finding('P2')]);
    fs.writeFileSync(f.options.scReport, JSON.stringify({ scs: [f.sc('no-change', ['thread:P2'])], workers }));
    assert.throws(f.finalize, /consult/);
    assert.equal(f.pushCalls.length, 0);
    assert.equal(fs.existsSync(path.join(f.paths.results, `${f.task.dispatchId}.json`)), false);
  });
}

test('validate runs npm ci before preflight when lockfile exists and node_modules is missing', async (t) => {
  const f = fixture(t, { lockfile: true });
  const calls = [];
  const result = await validate({
    ...f.options,
    runFn: (binary, args, options) => {
      calls.push({ binary, args: [...args], timeout: options.timeout });
      if (binary === 'npm') return 'added 0 packages\n';
      return 'fixture checks passed\n';
    },
  });
  assert.equal(result.status, 'pass');
  assert.deepEqual(calls.map((item) => [item.binary, ...item.args]), [['npm', 'ci'], ['/bin/bash', '.githooks/pre-push']]);
  assert.equal(calls[0].timeout, 3_600_000);
  const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.dependencyInstall.status, 'ok');
  assert.deepEqual(receipt.dependencyInstall.command, { binary: 'npm', args: ['ci'] });
  assert.equal(receipt.command.binary, '/bin/bash');
});

test('validate reinstalls when node_modules is left partial by an earlier failed npm ci', async (t) => {
  const f = fixture(t, { lockfile: true, nodeModules: 'partial' });
  const calls = [];
  const result = await validate({
    ...f.options,
    runFn: (binary, args) => { calls.push(binary); return binary === 'npm' ? 'added 0 packages\n' : 'fixture checks passed\n'; },
  });
  assert.equal(result.status, 'pass');
  assert.equal(calls[0], 'npm');
});

test('validate skips npm ci when node_modules already exists or lockfile is absent', async (t) => {
  for (const options of [{ lockfile: true, nodeModules: true }, { lockfile: false, nodeModules: false }, { lockfile: false, nodeModules: true }]) {
    const f = fixture(t, options);
    const calls = [];
    const result = await validate({
      ...f.options,
      runFn: (binary, args) => { calls.push([binary, ...args]); return 'fixture checks passed\n'; },
    });
    assert.equal(result.status, 'pass', JSON.stringify(options));
    assert.deepEqual(calls, [['/bin/bash', '.githooks/pre-push']]);
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    assert.equal(receipt.dependencyInstall, undefined);
  }
});

test('validate does not start preflight when npm ci fails', async (t) => {
  const f = fixture(t, { lockfile: true });
  const calls = [];
  const result = await validate({
    ...f.options,
    runFn: (binary, args) => {
      calls.push([binary, ...args]);
      if (binary === 'npm') {
        const error = new Error('npm ci failed');
        error.status = 1;
        error.stdout = '';
        error.stderr = 'lock mismatch';
        throw error;
      }
      throw new Error('preflight must not start');
    },
  });
  assert.equal(result.status, 'fail');
  assert.deepEqual(calls, [['npm', 'ci']]);
  const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
  assert.equal(receipt.reason, 'dependency install failed');
  assert.equal(receipt.command, null);
  assert.equal(receipt.dependencyInstall.status, 'fail');
  assert.equal(receipt.dependencyInstall.exitCode, 1);
});

test('validate fails when npm ci dirties tracked files', async (t) => {
  const f = fixture(t, { lockfile: true });
  const result = await validate({
    ...f.options,
    runFn: (binary, args) => {
      if (binary === 'npm') {
        fs.appendFileSync(path.join(f.worktree, 'example.txt'), 'from npm\n');
        return 'added 0 packages\n';
      }
      return 'fixture checks passed\n';
    },
  });
  assert.equal(result.status, 'fail');
  const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
  assert.match(receipt.reason, /dirty/);
  assert.equal(receipt.dependencyInstall.status, 'ok');
});

test('W-3 finalize accepts omitted or empty workers with skip evidence', async (t) => {
  for (const workers of [undefined, []]) {
    const f = fixture(t, { changed: false });
    f.saveTask([finding('P2')]);
    const sc = {
      id: 'SC-thread:P2', status: 'no-change', feedbackKeys: ['thread:P2'],
      evidence: [
        'thread does not require a code change',
        'review skipped: missing-routing; routing.json not present; local review worker was not started; required CI and server review still apply',
        'e2e skipped: no-tool; start_team was not repeated; local e2e worker was not started',
        'adjudicate-skipped: no-tool; no adjudicate worker could be opened',
      ],
    };
    fs.writeFileSync(f.options.scReport, JSON.stringify(workers === undefined ? { scs: [sc] } : { scs: [sc], workers }));
    const result = f.finalize();
    assert.equal(result.status, 'complete');
    if (workers === undefined) assert.equal(result.workers, undefined);
    else assert.deepEqual(result.workers, []);
    assert.equal(f.pushCalls.length, 0);
  }
});

test('A-1 a P0/P1/P2 review finding closed as no-change without an arbiter is rejected before any push', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P2')]);
  f.report([f.sc('no-change', ['thread:P2'])], []);
  assert.throws(f.finalize, /ADJUDICATE_REQUIRED/);
  assert.equal(f.pushCalls.length, 0);
});

test('A-2 adjudicate workers are accepted and kept in the result', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P1')]);
  f.report([f.sc('no-change', ['thread:P1'])]);
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.workers, [ADJUDICATOR]);
});

test('A-3 P3 no-change needs no arbiter', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P3')]);
  f.report([f.sc('no-change', ['thread:P3'])], []);
  assert.equal(f.finalize().status, 'complete');
});

// Without the reviewer's unified severity standard the session cannot grade the reviewer's own finding the
// way the reviewer does: it must fix it, an arbiter does not change that (vigil#37).
const reviewerFinding = (priority) => ({ ...finding(priority, `mivo-review:${priority}`), source: 'mivo-review' });

test('A-4 task without the severity standard: reviewer P0/P1/P2 closed as no-change is rejected even with an arbiter', async (t) => {
  const f = fixture(t, { changed: false });
  f.task.severityStandard = { loaded: false, reason: '未配置 severityStandardPath' };
  f.saveTask([reviewerFinding('P2')]);
  f.report([f.sc('no-change', ['mivo-review:P2'])]);
  assert.throws(f.finalize, /SEVERITY_STANDARD_MISSING.*未配置 severityStandardPath/);
  assert.equal(f.pushCalls.length, 0);
});

for (const [name, severityStandard, feedback, key] of [
  ['other sources keep the arbiter rule when the standard is missing', { loaded: false, reason: 'x' }, () => finding('P2'), 'thread:P2'],
  ['a task that had the standard keeps the arbiter rule', { loaded: true, version: 'abcdef012345' }, () => reviewerFinding('P2'), 'mivo-review:P2'],
  ['a task dispatched before the field existed keeps the arbiter rule', undefined, () => reviewerFinding('P2'), 'mivo-review:P2'],
]) {
  test(`A-5 ${name}`, async (t) => {
    const f = fixture(t, { changed: false });
    if (severityStandard) f.task.severityStandard = severityStandard;
    f.saveTask([feedback()]);
    f.report([f.sc('no-change', [key])]);
    assert.equal(f.finalize().status, 'complete');
  });
}

// Tasks dispatched with the structured ruling contract (vigil#38): the arbiter rules per item, a valid
// ruling must be fixed, and a no-change needs an invalid/p3 ruling for that very item.
const STANDARD = { loaded: true, version: 'abcdef012345', text: '## 分级(示例)\n\n| P2 | 含误导性的测试 | 报 |' };
const ruled = (rulings) => ({ ...ADJUDICATOR, rulings });
function structured(t, feedback = [reviewerFinding('P2')]) {
  const f = fixture(t, { changed: false });
  f.task.severityStandard = STANDARD;
  f.task.adjudicationRecord = 1;
  f.saveTask(feedback);
  return f;
}

test('A-6 a valid ruling must be fixed: no-change is rejected before any push', async (t) => {
  const f = structured(t);
  f.report([f.sc('no-change', ['mivo-review:P2'])], [ruled([{ feedbackKey: 'mivo-review:P2', verdict: 'valid', reason: 'reachable from the save path' }])]);
  assert.throws(f.finalize, /\[ADJUDICATED_VALID\].*mivo-review:P2/);
  assert.equal(f.pushCalls.length, 0);
});

for (const [name, workers] of [
  ['an arbiter without rulings', [ADJUDICATOR]],
  ['a ruling for another item', [ruled([{ feedbackKey: 'thread:P1', verdict: 'invalid', reason: 'x' }])]],
  ['no arbiter at all', []],
]) {
  test(`A-6 no-change with ${name} is rejected: each disputed item needs its own ruling`, async (t) => {
    const f = structured(t);
    f.report([f.sc('no-change', ['mivo-review:P2'])], workers);
    assert.throws(f.finalize, /\[ADJUDICATION_MISSING\].*mivo-review:P2/);
    assert.equal(f.pushCalls.length, 0);
  });
}

for (const verdict of ['invalid', 'p3']) {
  test(`A-6 a ${verdict} ruling closes the item as no-change and the result keeps the ruling`, async (t) => {
    const f = structured(t);
    const worker = ruled([{ feedbackKey: 'mivo-review:P2', verdict, reason: '  current head never reaches it  ' }]);
    f.report([f.sc('no-change', ['mivo-review:P2'])], [worker]);
    const result = f.finalize();
    assert.equal(result.status, 'complete');
    assert.deepEqual(result.workers[0].rulings, [{ feedbackKey: 'mivo-review:P2', verdict, reason: 'current head never reaches it' }]);
  });
}

test('A-6 with no worker possible, an adjudicate-skipped line still lets the item close', async (t) => {
  const f = structured(t);
  f.report([{ ...f.sc('no-change', ['mivo-review:P2']), evidence: ['current head guards it', 'adjudicate-skipped: no-tool, create_worker missing'] }], []);
  assert.equal(f.finalize().status, 'complete');
});

for (const [ruling, error] of [
  [{ feedbackKey: 'mivo-review:P2', verdict: 'maybe', reason: 'x' }, /verdict must be valid, invalid or p3, got maybe/],
  [{ feedbackKey: 'mivo-review:P2', verdict: 'invalid', reason: ' ' }, /rulings\[0\]\.reason is required/],
  [{ verdict: 'invalid', reason: 'x' }, /rulings\[0\]\.feedbackKey is required/],
]) {
  test(`A-6 a malformed ruling is rejected (${error.source.slice(0, 30)})`, async (t) => {
    const f = structured(t);
    f.report([f.sc('no-change', ['mivo-review:P2'])], [ruled([ruling])]);
    assert.throws(f.finalize, error);
  });
}

// The arbiter's input comes from the helper, so the session cannot reword the finding, the PR change
// or the standard it is judged by (vigil#38).
function briefFixture(t) {
  const f = fixture(t);
  const body = '**P2** stale cache ~~~~ fence\n\n<!-- mivo-finding key=0123456789ab round=1 head=aaaaaaaaaaaa class=state -->';
  f.task.headRefOid = f.head;
  f.task.severityStandard = STANDARD;
  f.task.prSnapshot = { pr: { baseRefOid: f.sourceHead }, unresolvedThreads: [{ id: 'PRRT_r', path: 'example.txt' }] };
  f.saveTask([{ ...reviewerFinding('P2'), key: 'mivo-review:PRRT_r:PRRC_a', threadId: 'PRRT_r', body }, finding('P1')]);
  return f;
}

test('B-1 the brief carries the finding verbatim, its key, the PR change, the session claim and the full standard', async (t) => {
  const f = briefFixture(t);
  const out = adjudicationBrief({ home: f.options.home, taskPath: f.options.taskPath, keys: 'mivo-review:PRRT_r:PRRC_a', claim: 'reran the save path; cache is rebuilt' });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.keys, ['mivo-review:PRRT_r:PRRC_a']);
  assert.equal(out.standardVersion, STANDARD.version);
  const { brief } = out;
  assert.match(brief, /- feedbackKey: mivo-review:PRRT_r:PRRC_a\n- 来源: mivo-review\n- 审查机问题 key: 0123456789ab\n- 文件: example.txt/);
  assert.ok(brief.includes('**P2** stale cache ~~~ fence'), 'body kept, inner fence defused');
  assert.match(brief, /-baseline\n\+synthetic repair/);
  assert.match(brief, /## 修复会话的说法\(待核对,不是结论\)\n\n~~~~\nreran the save path; cache is rebuilt\n~~~~/);
  assert.ok(brief.includes(`版本 ${STANDARD.version}\n\n${STANDARD.text}`));
  assert.match(brief, /拿不准就判 valid/);
  assert.match(brief, /\{"rulings":\[\{"feedbackKey"/);
  assert.doesNotMatch(brief, /thread:P1/, 'only the requested items');
});

test('B-2 the brief says what it could not read instead of leaving it out silently', async (t) => {
  const f = briefFixture(t);
  f.task.severityStandard = { loaded: false, reason: 'x' };
  f.saveTask(f.task.feedback);
  const gitFn = () => { throw new Error('fatal: bad revision\nmore'); };
  const { brief, standardVersion } = adjudicationBrief({ home: f.options.home, taskPath: f.options.taskPath, keys: 'mivo-review:PRRT_r:PRRC_a', gitFn });
  assert.equal(standardVersion, null);
  assert.match(brief, new RegExp(`读取改动失败\\(fatal: bad revision\\);完整改动自己跑 \`git diff ${f.sourceHead}\\.\\.\\.${f.head} -- example.txt\``));
  assert.match(brief, /修复会话没有附说法/);
  assert.match(brief, /本任务没有带统一分级全文/);
});

test('B-3 the brief refuses unknown or missing keys', async (t) => {
  const f = briefFixture(t);
  assert.throws(() => adjudicationBrief({ home: f.options.home, taskPath: f.options.taskPath, keys: 'mivo-review:nope' }), /unknown feedback keys: mivo-review:nope/);
  assert.throws(() => adjudicationBrief({ home: f.options.home, taskPath: f.options.taskPath, keys: ' , ' }), /--keys requires at least one feedback key/);
});

const HOOK_FAIL_LOG = [
  '[preflight] ▶ test',
  ' FAIL  scripts/ops/example.test.mjs > example > owns the env file',
  'AssertionError: expected 501 to be +0',
  ' ❯ scripts/ops/example.test.mjs:12:5',
  '      Tests  1 failed | 10 passed (11)',
  '[preflight] ❌ test 失败',
].join('\n');
const failing = (stdout, extra = {}) => () => { throw Object.assign(new Error('Command failed'), { status: 1, stdout, stderr: '', ...extra }); };
const readReceipt = (verification) => JSON.parse(fs.readFileSync(verification.receiptPath, 'utf8'));

test('SC2 同条件第二次 validate 复用通过收据：零次调用 runFn，新收据绑定当前身份并指向原收据', async (t) => {
  const f = fixture(t);
  let runs = 0;
  const first = await validate({ ...f.options, runFn: () => { runs++; return 'ok\n'; } });
  assert.equal(first.status, 'pass');
  assert.equal(runs, 1);
  const second = await validate({ ...f.options, runFn: () => { runs++; return 'must not run\n'; } });
  assert.equal(runs, 1, '复用时不再运行 validate');
  assert.equal(second.status, 'pass');
  assert.notEqual(second.receiptPath, first.receiptPath);
  const receipt = readReceipt(second);
  assert.equal(receipt.reusedFrom.receiptPath, first.receiptPath);
  assert.equal(receipt.reusedFrom.receiptSha256, first.receiptSha256);
  assert.equal(receipt.dispatchId, f.task.dispatchId);
  assert.equal(receipt.exitCode, 0);
});

test('SC2 日志被篡改时不复用，重新运行', async (t) => {
  const f = fixture(t);
  let runs = 0;
  const runFn = () => { runs++; return 'ok\n'; };
  const first = await validate({ ...f.options, runFn });
  fs.appendFileSync(readReceipt(first).logPath, 'tampered');
  await validate({ ...f.options, runFn });
  assert.equal(runs, 2, '日志篡改后必须重跑');
});

test('SC5 子进程环境注入 TMPDIR=realpath(os.tmpdir())，policy 哈希不变', async (t) => {
  const f = fixture(t);
  const seen = [];
  const before = await validate({ ...f.options, env: { ...f.options.env, TMPDIR: '/var/tmp/not-real-link' },
    runFn: (_bin, _args, opts) => { seen.push(opts.env.TMPDIR); return 'ok\n'; } });
  assert.deepEqual(seen, [fs.realpathSync(os.tmpdir())]);
  const receipt = readReceipt(before);
  assert.equal(receipt.runtime.tmpdir, fs.realpathSync(os.tmpdir()));
  assert.equal(receipt.policy.sha256, createHash('sha256').update(fs.readFileSync(path.join(f.worktree, '.githooks/pre-push'), 'utf8').trim()).digest('hex'));
});

test('SC4 收据记录日志哈希与失败集合；解析不出时标记 unparsed', async (t) => {
  const f = fixture(t);
  const failed = await validate({ ...f.options, runFn: failing(HOOK_FAIL_LOG) });
  assert.equal(failed.status, 'fail');
  const receipt = readReceipt(failed);
  assert.equal(receipt.validationEvidenceVersion, 1);
  assert.equal(receipt.logSha256, createHash('sha256').update(fs.readFileSync(receipt.logPath)).digest('hex'));
  assert.equal(receipt.failureSetState, 'parsed');
  assert.deepEqual(receipt.failureSet.map((item) => [item.step, item.file, item.test]), [['test', 'scripts/ops/example.test.mjs', 'example > owns the env file']]);
  assert.match(receipt.failureSetSha256, /^[0-9a-f]{64}$/);
  assert.equal(fs.statSync(receipt.logPath).mode & 0o777, 0o600);
  const g = fixture(t);
  const odd = await validate({ ...g.options, runFn: failing('lint exploded') });
  const oddReceipt = readReceipt(odd);
  assert.equal(oddReceipt.failureSetState, 'unparsed');
  assert.equal(oddReceipt.failureSetSha256, null);
});

test('SC3 无输出看门狗：stalled 以独立原因记录，不当作测试失败', async (t) => {
  const f = fixture(t);
  const stalled = await validate({ ...f.options, runFn: failing('', { status: null, failureKind: 'validate-stalled' }) });
  assert.equal(stalled.status, 'fail');
  const receipt = readReceipt(stalled);
  assert.equal(receipt.failureKind, 'validate-stalled');
  assert.equal(receipt.exitCode, null);
  assert.equal(receipt.failureSetState, 'unparsed');
});

test('SC1 并发上限：上限 1 时两个 validate 争用同一 home，runFn 峰值为 1，排队的不记为失败', async (t) => {
  const f = fixture(t);
  let running = 0;
  let peak = 0;
  const runFn = async () => {
    running++; peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, 150));
    running--;
    throw Object.assign(new Error('Command failed'), { status: 1, stdout: HOOK_FAIL_LOG, stderr: '' });
  };
  const env = { ...f.options.env, MIVO_VALIDATE_CONCURRENCY: '1' };
  const results = await Promise.all([validate({ ...f.options, env, runFn }), validate({ ...f.options, env, runFn })]);
  assert.equal(peak, 1);
  assert.deepEqual(results.map((item) => item.status), ['fail', 'fail']);
});

// ---- SC-6 仅基线失败的受控通过 ----
const failLog = (...tests) => ['[preflight] ▶ test', ...tests.flatMap(([name, message]) => [
  ` FAIL  scripts/ops/example.test.mjs > example > ${name}`, `AssertionError: ${message}`, ' ❯ scripts/ops/example.test.mjs:12:5', '']),
`      Tests  ${tests.length} failed | 10 passed (${tests.length + 10})`, '[preflight] ❌ test 失败'].join('\n');
const A = ['owns the env file', 'expected 501 to be +0'];
const B = ['reads the mode', 'expected 420 to be 384'];

function baselineFixture(t) {
  const f = fixture(t);
  execFileSync('git', ['-C', f.worktree, 'push', 'origin', `${f.sourceHead}:refs/heads/main`], { stdio: 'ignore' });
  const baselineRuns = [];
  const route = ({ pr, base }) => (_binary, _args, opts) => {
    if (opts.cwd === f.worktree) return pr();
    baselineRuns.push(opts.cwd);
    return base();
  };
  const outcome = (log) => () => { throw Object.assign(new Error('Command failed'), { status: 1, stdout: log, stderr: '' }); };
  const passes = () => 'ok\n';
  const worktreesLeft = () => {
    const dir = path.join(f.paths.validations, 'baseline-worktrees');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  return { f, baselineRuns, route, outcome, passes, worktreesLeft };
}

test('SC6 PR 失败集合 ⊆ 基线失败集合：产出 baseline-only-failure（保留真实 exit 1），基线 worktree 被清理，可受控 push 并 finalize', async (t) => {
  const { f, route, outcome, baselineRuns, worktreesLeft } = baselineFixture(t);
  const verification = await validate({ ...f.options, runFn: route({ pr: outcome(failLog(A)), base: outcome(failLog(A, B)) }) });
  assert.equal(verification.status, 'baseline-only-failure');
  const receipt = readReceipt(verification);
  assert.equal(receipt.exitCode, 1);
  assert.equal(receipt.failureKind, 'test-failure');
  assert.equal(receipt.baseline.mergeBase, f.sourceHead);
  assert.equal(receipt.baseline.policySha256, receipt.policy.sha256);
  assert.equal(receipt.baseline.runtimeSha256, receipt.runtimeSha256);
  assert.equal(baselineRuns.length, 1);
  assert.deepEqual(worktreesLeft(), []);
  assert.doesNotMatch(execFileSync('git', ['-C', f.worktree, 'worktree', 'list'], { encoding: 'utf8' }), /baseline-worktrees/);
  f.report([f.sc('pass', ['thread:P1'])]);
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.equal(result.verification.status, 'baseline-only-failure');
  assert.equal(result.ci.requiredGreen, true, '远端必需 CI 仍要求全绿');
  assert.equal(f.pushCalls.length, 1);
});

for (const [name, pr, base] of [
  ['PR 比基线多一个失败', failLog(A, B), failLog(A)],
  ['同名失败但 errorSha 不同', failLog([A[0], 'expected 502 to be +0']), failLog(A)],
  ['基线通过（PR 独有的失败）', failLog(A), null],
  ['基线输出无法解析', failLog(A), 'lint exploded'],
  ['PR 输出无法解析', 'lint exploded', failLog(A)],
]) {
  test(`SC6 ${name} → fail，不得受控通过`, async (t) => {
    const { f, route, outcome, passes } = baselineFixture(t);
    const verification = await validate({ ...f.options, runFn: route({
      pr: pr === 'lint exploded' ? outcome(pr) : outcome(pr), base: base === null ? passes : outcome(base) }) });
    assert.equal(verification.status, 'fail');
  });
}

test('SC6 stalled / timeout 不跑基线；同键基线只跑一次（缓存命中）', async (t) => {
  const { f, route, outcome, baselineRuns, worktreesLeft } = baselineFixture(t);
  const stalled = await validate({ ...f.options, runFn: route({
    pr: () => { throw Object.assign(new Error('stalled'), { status: null, failureKind: 'validate-stalled', stdout: '' }); }, base: outcome(failLog(A)) }) });
  assert.equal(stalled.status, 'fail');
  assert.equal(baselineRuns.length, 0);
  const options = { ...f.options, runFn: route({ pr: outcome(failLog(A)), base: outcome(failLog(A)) }) };
  assert.equal((await validate(options)).status, 'baseline-only-failure');
  assert.equal((await validate(options)).status, 'baseline-only-failure');
  assert.equal(baselineRuns.length, 1, '同 mergeBase/policy/指纹的基线结果被缓存');
  assert.deepEqual(worktreesLeft(), []);
});

test('SC6 并发的两个 validate 对同一基线键只跑一次基线', async (t) => {
  const { f, route, outcome, baselineRuns } = baselineFixture(t);
  const slowBase = async () => { await new Promise((resolve) => setTimeout(resolve, 200)); return outcome(failLog(A))(); };
  const options = { ...f.options, slotPollMs: 20, runFn: route({ pr: outcome(failLog(A)), base: slowBase }) };
  const results = await Promise.all([validate(options), validate(options)]);
  assert.deepEqual(results.map((item) => item.status), ['baseline-only-failure', 'baseline-only-failure']);
  assert.equal(baselineRuns.length, 1);
});

// Findings about tests, docs, the PR body or handoff files are fixed, not disputed or adjudicated; the only
// no-change is a commit after the reviewed head that already fixed it.
const docFinding = (key = 'thread:doc', head = 'bbbbbbbbbbbb') => ({ ...finding('P2', key), path: 'docs/pr/790/qa.md',
  body: `**P2**: qa.md still binds the old head\n<!-- mivo-finding key=aaaaaaaaaaaa round=2 head=${head} class=verification-evidence-mismatch -->` });

test('T-1 a test/doc finding closed as no-change is rejected even with an arbiter ruling', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([docFinding()]);
  f.report([f.sc('no-change', ['thread:doc'])], [ruled([{ feedbackKey: 'thread:doc', verdict: 'p3', reason: 'only wording' }])]);
  assert.throws(f.finalize, /\[TEST_DOC_MUST_FIX\].*thread:doc/);
  assert.equal(f.pushCalls.length, 0);
});

test('T-2 a test/doc finding closes as no-change when already-fixed names a commit in HEAD after the reviewed head', async (t) => {
  const f = fixture(t, { changed: false });
  // the head the reviewer saw: a commit that does not contain the fixing commit
  const reviewed = execFileSync('git', ['-C', f.worktree, '-c', 'user.name=r', '-c', 'user.email=r@example.invalid',
    'commit-tree', `${f.head}^{tree}`, '-m', 'reviewed head'], { encoding: 'utf8' }).trim();
  f.saveTask([docFinding('thread:doc', reviewed)]);
  f.report([{ ...f.sc('no-change', ['thread:doc']), evidence: ['qa.md names the current head', `already-fixed: ${f.head}`] }], []);
  assert.equal(f.finalize().status, 'complete');
});

test('T-5 already-fixed is rejected when the reviewed head cannot be resolved, or is the fixing commit itself', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([docFinding('thread:doc', 'b'.repeat(12))]);
  f.report([{ ...f.sc('no-change', ['thread:doc']), evidence: ['claimed fixed', `already-fixed: ${f.head}`] }], []);
  assert.throws(f.finalize, /\[TEST_DOC_MUST_FIX\]/);
  f.saveTask([docFinding('thread:doc', f.head)]);
  assert.throws(f.finalize, /\[TEST_DOC_MUST_FIX\]/);
});

test('T-6 already-fixed is rejected when the finding carries no reviewed head', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([{ ...finding('P2', 'thread:spec'), path: 'src/canvas/example.test.tsx' }]);
  f.report([{ ...f.sc('no-change', ['thread:spec']), evidence: ['claimed fixed', `already-fixed: ${f.head}`] }], []);
  assert.throws(f.finalize, /\[TEST_DOC_MUST_FIX\]/);
});

test('T-3 already-fixed naming a commit that is not in HEAD is rejected', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([docFinding()]);
  f.report([{ ...f.sc('no-change', ['thread:doc']), evidence: ['claimed fixed', `already-fixed: ${'c'.repeat(40)}`] }], []);
  assert.throws(f.finalize, /\[TEST_DOC_MUST_FIX\]/);
});

test('T-4 a finding on a test file path is test/doc even without a reviewer class', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([{ ...finding('P2', 'thread:spec'), path: 'src/canvas/example.test.tsx' }]);
  f.report([f.sc('no-change', ['thread:spec'])]);
  assert.throws(f.finalize, /\[TEST_DOC_MUST_FIX\].*thread:spec/);
});

test('T-7 the reviewer class counts as test/doc only by whole words: claim-integrity on product code still goes to the arbiter', async (t) => {
  const f = fixture(t, { changed: false });
  const product = { ...finding('P2', 'thread:claim'), path: 'src/canvas/store.ts',
    body: '**P2**: the claim check accepts a stale owner\n<!-- mivo-finding key=cccccccccccc round=1 head=bbbbbbbbbbbb class=claim-integrity -->' };
  f.saveTask([product]);
  f.report([f.sc('no-change', ['thread:claim'])], [ruled([{ feedbackKey: 'thread:claim', verdict: 'p3', reason: 'only wording' }])]);
  assert.equal(f.finalize().status, 'complete');
});

// SC6: a code finding already fixed after the version the reviewer saw needs no arbiter.
const SC6_HEAD = 'a'.repeat(40);
const codeFinding = (extra = {}) => ({ key: 'thread:code', source: 'mivo-review', sha: SC6_HEAD,
  user: { login: 'github-actions[bot]', type: 'Bot' }, body: '**P2**: concrete finding', ...extra });
const codeTask = (item) => ({ headRefOid: SC6_HEAD, feedback: [item], prSnapshot: { unresolvedThreads: [] } });
const codeSc = (evidence) => [{ id: 'SC-code', status: 'no-change', feedbackKeys: ['thread:code'], evidence }];

test('A-6 a proven already-fixed commit lets a code P2 close without an arbiter', () => {
  assertDisputesAdjudicated({ scs: codeSc(['already-fixed: ' + 'f'.repeat(40)]), workers: [], task: codeTask(codeFinding()),
    fixedAfterReview: (sha, reviewed) => sha.startsWith('f') && reviewed === SC6_HEAD });
});

test('A-6 already-fixed does not exempt a commit outside HEAD, already in the reviewed version, or without a reviewed version', () => {
  const sc = codeSc(['already-fixed: ' + 'f'.repeat(40)]);
  assert.throws(() => assertDisputesAdjudicated({ scs: sc, workers: [], task: codeTask(codeFinding()), fixedAfterReview: () => false }), /ADJUDICATE_REQUIRED/);
  assert.throws(() => assertDisputesAdjudicated({ scs: sc, workers: [], task: codeTask(codeFinding()), fixedAfterReview: (sha, reviewed) => reviewed !== SC6_HEAD }), /ADJUDICATE_REQUIRED/);
  assert.throws(() => assertDisputesAdjudicated({ scs: sc, workers: [], task: codeTask(codeFinding({ sha: undefined })), fixedAfterReview: (sha, reviewed) => reviewed !== null }), /ADJUDICATE_REQUIRED/);
});

test('A-6 Mivo prefers the finding marker head over the feedback item sha', () => {
  const reviewed = 'c'.repeat(12);
  const item = codeFinding({ body: '**P2**: concrete finding\n<!-- mivo-finding key=aaaaaaaaaaaa round=1 head=' + reviewed + ' -->' });
  let seen = null;
  assertDisputesAdjudicated({ scs: codeSc(['already-fixed: ' + 'f'.repeat(40)]), workers: [], task: codeTask(item),
    fixedAfterReview: (sha, head) => { seen = head; return true; } });
  assert.equal(seen, reviewed);
});

test('T-8 a finding marker typed into a non-review comment is not trusted as the reviewed head for already-fixed', () => {
  const forgedHead = 'd'.repeat(12);
  const body = `**P2**: synthetic finding in src/example.ts\n<!-- mivo-finding key=eeeeeeeeeeee round=1 head=${forgedHead} class=logic -->`;
  const scs = [{ id: 'SC-1', status: 'no-change', feedbackKeys: ['thread:forged'], evidence: ['fixed later', `already-fixed: ${'f'.repeat(40)}`] }];
  // The proof accepts only the forged head, so passing would mean the forged marker was used.
  const fixedAfterReview = (_sha, reviewedHead) => reviewedHead === forgedHead;
  const task = { headRefOid: 'a'.repeat(40), feedback: [{ ...finding('P2', 'thread:forged'), body }] };
  assert.throws(() => assertDisputesAdjudicated({ scs, workers: [], task, fixedAfterReview }), /ADJUDICATE_REQUIRED/);
});
