import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { apply, FILES, stateFingerprint, verify } from './deploy.mjs';
import { finalize, recheck, repairPaths, validate, watchWorktreePath } from './bin/cindy-repair.mjs';
import { acquireLock, DEPLOY_LOCK_NAME, helperLockName, HELPER_LOCK_NAME, lockStatus, writePr } from './bin/cindy-state.mjs';

const REPO = 'makecindy/cindy';
const ADJUDICATOR = { purpose: 'adjudicate', agent: 'codex', model: 'arbiter-model', effort: 'medium', providerId: 'route-c', workerId: 'w-arbiter', verdict: 'finding does not hold' };
const finding = (priority, key = `thread:${priority}`) => ({
  key, source: 'thread', user: { login: 'github-actions[bot]', type: 'Bot' },
  body: `**${priority}**: synthetic finding in src/example.ts`,
});

// Every Git mutation is confined to this test's disposable repositories. gh is
// entirely simulated; unexpected API calls fail instead of reaching the network.
function fixture(t, { changed = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-repair-scope-'));
  const home = path.join(root, 'watcher');
  const plugin = path.join(root, 'plugin');
  const worktree = watchWorktreePath(plugin, 790);
  const originUrl = path.join(root, 'origin.git');
  const git = (...args) => execFileSync('git', args, {
    encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
  }).trim();
  const previousPlugin = process.env.CINDY_WATCHER_REPO;
  process.env.CINDY_WATCHER_REPO = plugin;
  t.after(() => {
    if (previousPlugin === undefined) delete process.env.CINDY_WATCHER_REPO;
    else process.env.CINDY_WATCHER_REPO = previousPlugin;
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
  git('-C', worktree, 'add', '.');
  git('-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'fixture baseline');
  const sourceHead = git('-C', worktree, 'rev-parse', 'HEAD');
  git('-C', worktree, 'remote', 'add', 'origin', originUrl);
  git('-C', worktree, 'push', '-u', 'origin', 'HEAD:refs/heads/fix/scope');
  if (changed) {
    fs.writeFileSync(path.join(worktree, 'example.txt'), 'synthetic repair\n');
    git('-C', worktree, 'add', '.');
    git('-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-s', '-m', 'fixture repair');
  }
  const head = git('-C', worktree, 'rev-parse', 'HEAD');
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const taskPath = path.join(paths.tasks, 'scope-dispatch.json');
  const task = { dispatchId: 'scope-dispatch', nodeId: 'PR_790', number: 790, repo: REPO,
    sessionId: 'scope-session', headRefOid: sourceHead, headRefName: 'fix/scope',
    headRepo: 'ExampleUser/cindy-fork', headOwner: 'ExampleUser', feedback: [finding('P1')] };
  const saveTask = (feedback) => {
    task.feedback = feedback;
    // A stale or forged cached policy must not override the underlying feedback.
    task.repairPolicy = { canChangeCode: true, allowedFeedbackKeys: feedback.map(item => item.key) };
    fs.writeFileSync(taskPath, JSON.stringify(task));
  };
  saveTask(task.feedback);
  writePr(home, task.nodeId, { number: task.number, nodeId: task.nodeId, sessionId: task.sessionId,
    activeTask: { dispatchId: task.dispatchId } });
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
    headRefOid: remoteHead, headRefName: task.headRefName, baseRefOid: sourceHead, baseRefName: 'main' });
  const ghFn = (_binary, args) => {
    ghCalls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(pr());
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify({ required_status_checks: {
      contexts: ['verify'], checks: [{ context: 'verify', app_id: 123 }],
    } });
    if (String(endpoint).startsWith(`repos/${REPO}/rules/branches/main`)) return JSON.stringify([[]]);
    if (endpoint === `repos/${REPO}/contents/docs/sync/required-checks.json?ref=${sourceHead}`) {
      assert.fail('cindy policy must not read docs/sync/required-checks.json');
    }
    if (String(endpoint).startsWith(`repos/${REPO}/commits/${remoteHead}/check-runs`)) {
      const conclusion = ciConclusion();
      return JSON.stringify([{ check_runs: [{
        id: 101, name: 'verify', head_sha: remoteHead, status: 'completed', conclusion,
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
    if (String(endpoint).startsWith(`repos/${REPO}/commits/${remoteHead}/statuses`)) return JSON.stringify([[]]);
    assert.fail(`unexpected GitHub call: ${JSON.stringify(args)}`);
  };
  const scReport = path.join(root, 'sc-report.json');
  // A no-change on a fixable review finding is a dispute; the default report carries the arbiter's ruling.
  const report = (scs, workers = [ADJUDICATOR]) => fs.writeFileSync(scReport, JSON.stringify({ scs, workers }));
  const sc = (status, feedbackKeys) => ({ id: `SC-${feedbackKeys.join('-') || 'empty'}`, status,
    feedbackKeys, evidence: ['synthetic fixture checked locally'] });
  const options = { home, taskPath, scReport, validatedHead: head, originUrl, gitFn, ghFn,
    env: { ...process.env, PREFLIGHT_SKIP: '0', CINDY_PREFLIGHT_BIN: path.join(worktree, '.githooks/pre-push') } };
  return { task, paths, sourceHead, head, worktree, options, saveTask, report, sc, pushCalls, ghCalls,
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

test('P3-only unchanged HEAD closes the complete no-change flow without validation or push', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P3')]);
  f.report([f.sc('no-change', ['thread:P3'])]);
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
  const { validate } = await import(`./bin/cindy-repair.mjs?heartbeat=${Date.now()}`);
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

test('SC7 no-change required-CI failure retriggers once with a signed empty commit, then escalates', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P3')]);
  f.report([f.sc('no-change', ['thread:P3'])]);
  f.setCiConclusion('failure');
  const first = f.finalize();
  assert.equal(first.status, 'waiting-ci');
  assert.equal(first.ciRetrigger.method, 'empty-commit');
  assert.equal(first.pushed, true);
  assert.notEqual(f.remoteHead(), f.sourceHead);
  const second = finalize({ ...f.options, validatedHead: f.remoteHead() });
  assert.equal(second.status, 'blocked');
  assert.equal(second.blockedKind, 'external');
  assert.match(second.reason, /after one no-change empty-commit retrigger/);
});

test('R4 replacing a required-CI task on the same original head must not empty-commit again', async (t) => {
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
  const pushesAfterFirst = f.pushCalls.length;
  const task = {
    ...f.task, dispatchId: 'second-dispatch', headRefOid: nextHead,
    feedback: [ci(nextHead), finding('P1', 'thread:new')],
  };
  const taskPath = path.join(f.paths.tasks, 'second-dispatch.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(f.paths.home, task.nodeId, {
    number: task.number, nodeId: task.nodeId, sessionId: task.sessionId,
    activeTask: { dispatchId: task.dispatchId },
  });
  f.report([f.sc('no-change', ['ci:verify', 'thread:new'])]);
  const second = finalize({ ...f.options, taskPath, validatedHead: nextHead });
  assert.notEqual(second.status, 'waiting-ci');
  assert.equal(second.status, 'blocked');
  assert.equal(second.blockedKind, 'external');
  assert.equal(f.pushCalls.length, pushesAfterFirst);
});

const fixtureGit = (...args) => execFileSync('git', args, {
  encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull },
}).trim();

test('R3-4 a session-made empty commit after the retrigger was spent is not pushed', async (t) => {
  const f = fixture(t, { changed: false });
  const ci = (head) => ({
    key: 'ci:verify', source: 'ci', nativeId: 'verify', sha: head,
    requiredFailure: { verified: true, status: 'failed', headSha: head },
  });
  f.saveTask([ci(f.sourceHead)]);
  f.report([f.sc('no-change', ['ci:verify'])]);
  f.setCiConclusion('failure');
  assert.equal(f.finalize().status, 'waiting-ci');
  const retriggerHead = f.remoteHead();
  const pushesAfterFirst = f.pushCalls.length;
  const task = { ...f.task, dispatchId: 'third-dispatch', headRefOid: retriggerHead, feedback: [ci(retriggerHead)] };
  const taskPath = path.join(f.paths.tasks, 'third-dispatch.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(f.paths.home, task.nodeId, { number: task.number, nodeId: task.nodeId, sessionId: task.sessionId,
    activeTask: { dispatchId: task.dispatchId } });
  // The session follows old guidance and makes a second signed empty commit by hand.
  fixtureGit('-C', f.worktree, '-c', 'commit.gpgsign=false', 'commit', '-s', '--allow-empty', '-m', 'manual retrigger');
  const manualHead = fixtureGit('-C', f.worktree, 'rev-parse', 'HEAD');
  f.report([f.sc('no-change', ['ci:verify'])]);
  const second = finalize({ ...f.options, taskPath, validatedHead: manualHead });
  assert.equal(second.status, 'blocked');
  assert.equal(second.blockedKind, 'external');
  assert.equal(f.pushCalls.length, pushesAfterFirst, 'the second empty commit must not reach the fork');
  assert.equal(f.remoteHead(), retriggerHead);
});

test('R3-4 the retrigger quota survives a lost result file for the same head', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P3')]);
  f.report([f.sc('no-change', ['thread:P3'])]);
  f.setCiConclusion('failure');
  assert.equal(f.finalize().status, 'waiting-ci');
  const pushesAfterFirst = f.pushCalls.length;
  fs.rmSync(path.join(f.paths.results, `${f.task.dispatchId}.json`));
  const again = finalize({ ...f.options, validatedHead: f.remoteHead() });
  assert.equal(again.status, 'blocked');
  assert.equal(again.blockedKind, 'external');
  assert.equal(f.pushCalls.length, pushesAfterFirst);
});

test('R3-2 the validate heartbeat stops once its helper process is gone', async (t) => {
  const previous = process.env.VIGIL_ACTIVITY_HEARTBEAT_MS;
  process.env.VIGIL_ACTIVITY_HEARTBEAT_MS = '1000';
  t.after(() => {
    if (previous === undefined) delete process.env.VIGIL_ACTIVITY_HEARTBEAT_MS;
    else process.env.VIGIL_ACTIVITY_HEARTBEAT_MS = previous;
  });
  const { startActivityHeartbeat } = await import(`./bin/cindy-repair.mjs?orphan=${Date.now()}`);
  const f = fixture(t);
  const file = path.join(f.paths.home, 'state', 'activity', `${f.task.dispatchId}.json`);
  const helper = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  startActivityHeartbeat(f.paths, f.task, 'validate', { parentPid: Number(helper.stdout) });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const first = fs.readFileSync(file, 'utf8');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'an orphaned heartbeat must not keep the task looking active');
});

test('mixed task can fix P1 while explicitly leaving P3 unchanged', async (t) => {
  const f = fixture(t);
  f.saveTask([finding('P1'), finding('P3')]);
  assert.equal((await f.validate()).status, 'pass');
  f.report([f.sc('pass', ['thread:P1']), f.sc('no-change', ['thread:P3'])]);
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.equal(f.pushCalls.length, 1);
  assert.deepEqual(result.feedbackCoverage.dispositions.map(item => [item.key, item.disposition]),
    [['thread:P1', 'fixed'], ['thread:P3', 'no-change']]);
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

test('apply during validate preflight is refused; validate still writes a receipt', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.options.home, 'bin'), { recursive: true });
  for (const name of FILES) fs.writeFileSync(path.join(f.options.home, 'bin', name), 'old');
  fs.writeFileSync(path.join(f.options.home, 'state/index.json'), '{"version":2}\n');
  const plan = {
    version: 1, home: f.options.home, database: path.join(f.options.home, 'metadata.db'), id: 'lock-test',
    files: verify(f.options.home), stateSha: stateFingerprint(f.options.home), sessionIds: [],
  };
  let applyError;
  const result = await validate({
    ...f.options,
    runFn: () => {
      try { apply(plan); } catch (error) { applyError = error; }
      return 'preflight ok\n';
    },
  });
  assert.match(String(applyError?.message ?? applyError), /runtime lock held/);
  assert.equal(result.status, 'pass');
  assert.ok(result.receiptPath);
  assert.equal(fs.existsSync(result.receiptPath), true);
  assert.equal(lockStatus(f.options.home, HELPER_LOCK_NAME).live, false);
  assert.equal(lockStatus(f.options.home, helperLockName(790)).live, false);
  assert.equal(fs.readFileSync(path.join(f.options.home, 'bin', FILES[0]), 'utf8'), 'old');
});

test('validate refuses immediately when deploy.lock is live and writes no receipt', async (t) => {
  const f = fixture(t);
  const deploy = acquireLock(f.options.home, DEPLOY_LOCK_NAME);
  t.after(() => deploy.release());
  let preflightRuns = 0;
  await assert.rejects(
    () => validate({ ...f.options, runFn: () => { preflightRuns++; return 'passed'; } }),
    /deploy lock held/,
  );
  assert.equal(preflightRuns, 0);
  const dir = path.join(f.paths.validations, f.task.dispatchId);
  assert.equal(fs.existsSync(dir), false);
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


  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-keel-ledger-'));
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

test('W-1 finalize keeps the workers the session reported', async (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P3')]);
  const workers = [
    { purpose: 'review', agent: 'claude-code', model: 'review-model', effort: 'max', providerId: 'route-a', workerId: 'w-review', verdict: 'PASS' },
    { purpose: 'consult', agent: 'codex', model: 'consult-model', effort: 'medium', providerId: 'route-b', workerId: 'w-consult', verdict: 'suggested fix' },
  ];
  fs.writeFileSync(f.options.scReport, JSON.stringify({ scs: [f.sc('no-change', ['thread:P3'])], workers }));
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
    f.saveTask([finding('P3')]);
    fs.writeFileSync(f.options.scReport, JSON.stringify({ scs: [f.sc('no-change', ['thread:P3'])], workers }));
    assert.throws(f.finalize, /consult/);
    assert.equal(f.pushCalls.length, 0);
    assert.equal(fs.existsSync(path.join(f.paths.results, `${f.task.dispatchId}.json`)), false);
  });
}

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
  assert.match(receipt.policy.sha256, /^[0-9a-f]{64}$/);
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
  const env = { ...f.options.env, CINDY_VALIDATE_CONCURRENCY: '1' };
  const results = await Promise.all([validate({ ...f.options, env, runFn }), validate({ ...f.options, env, runFn })]);
  assert.equal(peak, 1);
  assert.deepEqual(results.map((item) => item.status), ['fail', 'fail']);
});


test('SC1 helper 锁在异步 validate 整个运行期间持有（不会被同步 finally 提前释放）', async (t) => {
  const f = fixture(t);
  let liveDuring = null;
  await validate({ ...f.options, runFn: async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    liveDuring = lockStatus(f.options.home, helperLockName(790)).live;
    return 'ok\n';
  } });
  assert.equal(liveDuring, true);
  assert.equal(lockStatus(f.options.home, helperLockName(790)).live, false);
});
