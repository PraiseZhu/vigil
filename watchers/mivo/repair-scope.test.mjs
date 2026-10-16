import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { assertOwner, finalize, recheck, repairPaths, validate, watchWorktreePath } from './bin/mivo-repair.mjs';
import { writePr } from './bin/mivo-state.mjs';
import { ownershipGh } from './ownership-gh.fixture.mjs';

const REPO = 'example-org/example-plugin';
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
  git('-C', worktree, 'add', '.');
  git('-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture baseline');
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
  const report = scs => fs.writeFileSync(scReport, JSON.stringify({ scs }));
  const sc = (status, feedbackKeys) => ({ id: `SC-${feedbackKeys.join('-') || 'empty'}`, status,
    feedbackKeys, evidence: ['synthetic fixture checked locally'] });
  const options = { home, taskPath, scReport, validatedHead: head, originUrl, gitFn, ghFn,
    env: { ...process.env, PREFLIGHT_SKIP: '0' } };
  return { task, paths, sourceHead, head, options, saveTask, report, sc, pushCalls, ghCalls,
    setCiConclusion: (value) => { ciConclusionValue = value; },
    remoteHead: () => git('--git-dir', originUrl, 'rev-parse', 'refs/heads/fix/scope'),
    validate: () => validate(options), finalize: () => finalize(options) };
}

for (const status of ['pass', 'no-change']) {
  test(`P2-only changed HEAD cannot finalize ${status}, even with a valid prior validation receipt`, (t) => {
    const f = fixture(t);
    assert.equal(f.validate().status, 'pass');
    f.saveTask([{ ...finding('P2'), category: 'actionable-fix', priority: 'P1',
      repairPolicy: { action: 'code-fix', canChangeCode: true } }]);
    f.report([f.sc(status, ['thread:P2'])]);
    assert.throws(f.finalize, /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限/i);
    assert.equal(f.pushCalls.length, 0);
    assert.equal(f.remoteHead(), f.sourceHead);
    assert.equal(fs.existsSync(path.join(f.paths.results, `${f.task.dispatchId}.json`)), false);
  });
}

test('P2-only unchanged HEAD closes the complete no-change flow without validation or push', (t) => {
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

test('a P1 in the same task does not authorize an SC marking P2 fixed', (t) => {
  const f = fixture(t);
  f.saveTask([finding('P1'), finding('P2')]);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1']), f.sc('pass', ['thread:P2'])]);
  assert.throws(f.finalize, /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限|no.change/i);
  assert.equal(f.pushCalls.length, 0);
  assert.equal(f.remoteHead(), f.sourceHead);
});

for (const kind of ['P1', 'required-ci']) {
  test(`${kind} authorized repair can validate, push to fixture origin and close against current-head CI`, (t) => {
    const f = fixture(t);
    const feedback = kind === 'P1' ? finding('P1') : {
      key: 'ci:verify', source: 'ci', sha: f.sourceHead,
      requiredFailure: { verified: true, status: 'failed', headSha: f.sourceHead },
    };
    f.saveTask([feedback]);
    assert.equal(f.validate().status, 'pass');
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

for (const kind of ['P3', 'unknown', 'empty']) {
  test(`${kind} feedback cannot publish a changed HEAD through no-change SCs`, (t) => {
    const f = fixture(t);
    assert.equal(f.validate().status, 'pass');
    const feedback = kind === 'empty' ? [] : kind === 'unknown'
      ? [{ ...finding('P1'), key: 'thread:unknown', body: 'Please consider this improvement.' }]
      : [finding('P3')];
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
  const result = validate({
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

test('SC7 no-change required-CI failure reruns failed jobs once, then escalates', (t) => {
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

test('R4 replacing a required-CI task on the same head must not retrigger again', (t) => {
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

test('R3-4 a repeated finalize while the rerun is pending keeps the one-retry quota for the head', (t) => {
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

test('R3-4 the retrigger quota survives a lost result file for the same head', (t) => {
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

test('mixed task can fix P1 while explicitly leaving P2 unchanged', (t) => {
  const f = fixture(t);
  f.saveTask([finding('P1'), finding('P2')]);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1']), f.sc('no-change', ['thread:P2'])]);
  const result = f.finalize();
  assert.equal(result.status, 'complete');
  assert.equal(f.pushCalls.length, 1);
  assert.deepEqual(result.feedbackCoverage.dispositions.map(item => [item.key, item.disposition]),
    [['thread:P1', 'fixed'], ['thread:P2', 'no-change']]);
});

test('P2-only validation rejects a changed HEAD before running preflight', (t) => {
  const f = fixture(t);
  f.saveTask([finding('P2')]);
  let preflightRuns = 0;
  assert.throws(() => validate({ ...f.options, runFn: () => { preflightRuns++; return 'passed'; } }),
    /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限/i);
  assert.equal(preflightRuns, 0);
  assert.equal(f.pushCalls.length, 0);
});

test('recheck cannot certify a changed HEAD after its feedback loses repair authority', (t) => {
  const f = fixture(t);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  assert.equal(f.finalize().status, 'complete');
  f.saveTask([{ ...finding('P2'), key: 'thread:P1' }]);
  const pushesBefore = f.pushCalls.length;
  assert.throws(() => recheck(f.options), /repair.scope|code.*authority|scope.*code|P0\/P1|P0.*P1|代码权限|无.*权限|no.change/i);
  assert.equal(f.pushCalls.length, pushesBefore);
});

test('v2 finalize never pushes with missing config or only a task registration', t => {
  const f = fixture(t);
  assert.equal(f.validate().status, 'pass');
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

test('finalize with a Keel ledger root refuses to push without a bound Keel run', (t) => {
  const f = fixture(t);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  f.task.keelFlow = true;
  f.saveTask(f.task.feedback);
  const keelRoot = keelLedger(t, 'run-1', [{ at: '2026-10-06T00:00:00Z', kind: 'step', summary: 'unrelated run' }]);
  assert.throws(() => finalize({ ...f.options, keelRoot }), /KEEL_RUN_REQUIRED.*--keel-run/);
  assert.throws(() => finalize({ ...f.options, keelRoot, keelRun: 'run-1' }), /KEEL_RUN_REQUIRED.*task=scope-dispatch/);
  assert.equal(f.pushCalls.length, 0);
  assert.equal(f.remoteHead(), f.sourceHead);
});

test('finalize pushes once the Keel run carries this task binding and reports it', (t) => {
  const f = fixture(t);
  assert.equal(f.validate().status, 'pass');
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

test('finalize keeps closing tasks dispatched before the Keel prompt', (t) => {
  const f = fixture(t);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  const keelRoot = keelLedger(t, 'run-3', []);
  const result = finalize({ ...f.options, keelRoot });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.keel, { status: 'not-required-legacy-task' });
});


test('assert-owner refuses tasks without explicit handoff and stale GitHub heads', t => {
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
  test(`validate refuses a pass receipt when ownership changes during preflight: ${loss}`, t => {
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
    const result = validate({ ...f.options, ghFn, runFn: () => {
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

test('finalize rechecks ownership immediately before any push', t => {
  const f = fixture(t);
  assert.equal(f.validate().status, 'pass');
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


test('only recorded controlled pushes let finalize and recheck retain the task ownership', t => {
  const f = fixture(t);
  assert.equal(f.validate().status, 'pass');
  f.report([f.sc('pass', ['thread:P1'])]);
  assert.equal(f.finalize().pushed, true);
  // A bare write checkpoint never opts in to the validated-head recovery path.
  assert.throws(() => assertOwner(f.options), /head is stale/);
  assert.equal(recheck(f.options).status, 'complete');
  assert.equal(f.finalize().pushed, true);
  assert.equal(recheck(f.options).status, 'complete');
  assert.equal(f.pushCalls.length, 1);
});

test('assert-owner refuses superseded tasks and changed handoff binding at the same head', t => {
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

test('W-1 finalize keeps the workers the session reported', (t) => {
  const f = fixture(t, { changed: false });
  f.saveTask([finding('P2')]);
  const workers = [
    { purpose: 'review', agent: 'claude-code', model: 'review-model', effort: 'max', providerId: 'route-a', workerId: 'w-review', verdict: 'PASS' },
    { purpose: 'consult', agent: 'codex', model: 'consult-model', effort: 'medium', providerId: 'route-b', workerId: 'w-consult', verdict: 'suggested fix' },
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
  test(`W-2 finalize rejects ${label} before any push`, (t) => {
    const f = fixture(t, { changed: false });
    f.saveTask([finding('P2')]);
    fs.writeFileSync(f.options.scReport, JSON.stringify({ scs: [f.sc('no-change', ['thread:P2'])], workers }));
    assert.throws(f.finalize, /consult/);
    assert.equal(f.pushCalls.length, 0);
    assert.equal(fs.existsSync(path.join(f.paths.results, `${f.task.dispatchId}.json`)), false);
  });
}
