// 等无轮次空档再快进部署。临时仓不走网络：origin 配成公开地址，再用 insteadOf 指回本地 bare。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './fake-gh.fixture.mjs';
import {
  BUSY_PROCESS_RE,
  EXIT,
  classifyChecks,
  defaultRunGit,
  formatResult,
  lagState,
  parseAddedLines,
  repoFromOrigin,
  runDeploy,
} from './deploy-ff.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(HERE, 'deploy-ff.mjs');
const DOC = path.join(ROOT, 'docs', 'acceptance-operations.md');
const ORIGIN_URL = 'https://github.com/example-org/demo-repo.git';
const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function git(cwd, args, date) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.GIT_AUTHOR_NAME = 'ExampleUser';
  env.GIT_AUTHOR_EMAIL = 'example-user@example.com';
  env.GIT_COMMITTER_NAME = 'ExampleUser';
  env.GIT_COMMITTER_EMAIL = 'example-user@example.com';
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} → ${result.status}\n${result.stderr}`);
  }
  return (result.stdout || '').trim();
}

function configureRepo(dir, hooks) {
  git(dir, ['config', 'user.email', 'example-user@example.com']);
  git(dir, ['config', 'user.name', 'ExampleUser']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.hooksPath', hooks]);
}

function makeWorld() {
  const root = tmpDir('deploy-ff-');
  const bare = path.join(root, 'origin.git');
  const worker = path.join(root, 'worker');
  const deploy = path.join(root, 'deploy');
  const host = path.join(root, 'hoststate');
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(host, { recursive: true });
  fs.mkdirSync(path.join(host, 'rounds'), { recursive: true });
  fs.mkdirSync(path.join(host, 'locks'), { recursive: true });
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  spawnSync('git', ['init', '-b', 'main', worker], { encoding: 'utf8' });
  configureRepo(worker, hooks);
  git(worker, ['remote', 'add', 'origin', bare]);
  fs.writeFileSync(path.join(worker, 'README.md'), 'base\n');
  git(worker, ['add', 'README.md']);
  git(worker, ['commit', '-m', 'base']);
  git(worker, ['push', 'origin', 'HEAD:main']);
  spawnSync('git', ['clone', bare, deploy], { encoding: 'utf8' });
  configureRepo(deploy, hooks);
  git(deploy, ['remote', 'set-url', 'origin', ORIGIN_URL]);
  git(deploy, ['config', `url.${bare}/.insteadOf`, ORIGIN_URL]);
  git(deploy, ['fetch', 'origin']);
  const doctor = path.join(root, 'doctor-ok.mjs');
  fs.writeFileSync(doctor, 'process.stdout.write("ok\\n");\nprocess.exit(0);\n');
  return {
    root,
    bare,
    worker,
    deploy,
    host,
    doctor,
    selfLock: path.join(root, 'run', 'self.lock'),
    prioLock: path.join(root, 'run', 'prio.lock'),
    stateFile: path.join(root, 'run', 'state.json'),
    alertsFile: path.join(host, 'alerts.jsonl'),
    approvalFile: path.join(root, 'approval.txt'),
  };
}

function commitAndPush(world, entries, message, date) {
  for (const entry of entries) {
    const full = path.join(world.worker, entry.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.content);
    git(world.worker, ['add', '--', entry.path], date);
  }
  git(world.worker, ['commit', '-m', message], date);
  git(world.worker, ['push', 'origin', 'HEAD:main'], date);
  return git(world.worker, ['rev-parse', 'HEAD']);
}

function fastForward(world) {
  git(world.deploy, ['fetch', 'origin']);
  git(world.deploy, ['merge', '--ff-only', 'origin/main']);
}

function readAlerts(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function assertRun(result, status) {
  const parts = result.stdout.split('\n');
  assert.equal(parts.length, 3, result.stdout);
  assert.equal(parts[2], '');
  const json = JSON.parse(parts[0]);
  assert.equal(json.status, status);
  assert.equal(result.code, EXIT[status]);
  for (const key of ['status', 'head', 'target', 'behind', 'lagging', 'reportLag', 'files', 'reason', 'ts']) {
    assert.equal(Object.hasOwn(json, key), true, key);
  }
  assert.equal(parts[0], JSON.stringify(json));
  return json;
}

function neverFetch() {
  return async () => {
    throw new Error('不应该去读检查');
  };
}

function green(sha, extra = {}) {
  const runs = extra.runs || [
    { status: 'completed', conclusion: 'success', head_sha: sha },
    { status: 'completed', conclusion: 'neutral', head_sha: sha },
    { status: 'completed', conclusion: 'skipped', head_sha: sha },
  ];
  return async (url, init) => {
    if (extra.bag) {
      extra.bag.url = url;
      extra.bag.init = init;
    }
    if (extra.hang) return new Promise(() => {});
    if (extra.throwError) throw new Error('timeout');
    if (extra.status && extra.status !== 200) {
      return { ok: false, status: extra.status, json: async () => ({}) };
    }
    if (extra.payload) return { ok: true, status: 200, json: async () => extra.payload };
    return { ok: true, status: 200, json: async () => ({ total_count: runs.length, check_runs: runs }) };
  };
}

function red(sha) {
  return green(sha, { runs: [{ status: 'completed', conclusion: 'failure', head_sha: sha }] });
}

async function deploy(world, extra = {}) {
  const calls = [];
  const runGit = extra.runGit || ((cwd, args) => {
    calls.push(args);
    return defaultRunGit(cwd, args);
  });
  const before = git(world.deploy, ['rev-parse', 'HEAD']);
  const result = await runDeploy({
    deployDir: world.deploy,
    hostStateDir: extra.hostStateDir || world.host,
    selfLock: world.selfLock,
    prioLock: world.prioLock,
    stateFile: world.stateFile,
    alertsFile: world.alertsFile,
    approvalFile: extra.approvalFile ?? null,
    approve: extra.approve ?? null,
    doctorScript: extra.doctorScript || world.doctor,
    doctorArgs: extra.doctorArgs || [],
    now: extra.now || (() => Date.now()),
    fetchImpl: extra.fetchImpl || neverFetch(),
    listProcesses: extra.listProcesses || (() => []),
    runGit,
    runDoctor: extra.runDoctor,
    runCheck: extra.runCheck,
    timeoutMs: extra.timeoutMs ?? 15_000,
  });
  return { ...result, before, after: git(world.deploy, ['rev-parse', 'HEAD']), calls };
}

function mutations(calls) {
  const verbs = new Set(['fetch', 'merge', 'reset', 'checkout', 'clean', 'commit', 'restore', 'switch', 'rebase']);
  return calls.filter((args) => verbs.has(args[0]));
}

function cliArgs(world, extra = []) {
  return [
    SCRIPT,
    '--deploy-dir', world.deploy,
    '--host-state', world.host,
    '--self-lock', world.selfLock,
    '--prio-lock', world.prioLock,
    '--state-file', world.stateFile,
    '--alerts', world.alertsFile,
    '--doctor-script', world.doctor,
    ...extra,
  ];
}

function spawnCli(world, env = process.env, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cliArgs(world, extra), { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function holdLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, 'a'));
  const child = spawn('flock', [file, 'sleep', '30'], { stdio: 'ignore', detached: true });
  const started = Date.now();
  let held = false;
  while (Date.now() - started < 3000) {
    const probe = spawnSync('flock', ['-n', file, 'true']);
    if (probe.status !== 0) {
      held = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!held) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    throw new Error('没能占住锁');
  }
  return () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }
  };
}

test('#215 仓名只从 github 的 origin 地址推', () => {
  assert.equal(repoFromOrigin(ORIGIN_URL), 'example-org/demo-repo');
  assert.equal(repoFromOrigin('https://github.com/example-org/demo-repo'), 'example-org/demo-repo');
  assert.equal(repoFromOrigin('git@github.com:example-org/demo-repo.git'), 'example-org/demo-repo');
  assert.equal(repoFromOrigin('/tmp/not-a-remote'), null);
  assert.equal(repoFromOrigin('https://example.invalid/example-org/demo-repo'), null);
});

test('#215 新增行解析忽略文件头和删除行', () => {
  const diff = [
    'diff --git a/docs/note.md b/docs/note.md',
    '--- a/docs/note.md',
    '+++ b/docs/note.md',
    '@@ -1,2 +1,2 @@',
    '-process.env',
    '+plain',
    ' context',
  ].join('\n');
  const lines = parseAddedLines(diff);
  assert.deepEqual(lines.map((row) => row.text), ['plain']);
  assert.equal(CONTENT_HITS(lines), false);
});

function CONTENT_HITS(lines) {
  return lines.some((row) => /process\.env|secrets\/|token/i.test(row.text));
}

test('#215 SC4 落后阈值：超过 5 个或超过 2 小时，同一 HEAD 只报一次', () => {
  const head = 'a'.repeat(40);
  const recent = '2026-11-02T11:00:00.000Z';
  assert.equal(lagState({ behind: 5, oldestIso: recent, nowMs: NOW, head, reportedFor: null }).lagging, false);
  assert.equal(lagState({ behind: 6, oldestIso: recent, nowMs: NOW, head, reportedFor: null }).reportLag, true);
  assert.equal(lagState({ behind: 6, oldestIso: recent, nowMs: NOW, head, reportedFor: head }).reportLag, false);
  assert.equal(lagState({ behind: 6, oldestIso: recent, nowMs: NOW, head, reportedFor: head }).lagging, true);
  assert.equal(lagState({ behind: 1, oldestIso: '2026-11-02T09:59:00.000Z', nowMs: NOW, head, reportedFor: null }).lagging, true);
  assert.equal(lagState({ behind: 1, oldestIso: '2026-11-02T10:00:00.000Z', nowMs: NOW, head, reportedFor: null }).lagging, false);
});

test('#215 SC9 每种状态两行，退出码和运维说明一致', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  for (const [status, code] of Object.entries(EXIT)) {
    const text = formatResult({
      status,
      head: 'a'.repeat(40),
      target: 'b'.repeat(40),
      behind: 0,
      lagging: false,
      reportLag: false,
      files: [],
      lines: [],
      reason: '原因',
      ts: '2026-11-02T12:00:00.000Z',
    });
    const parts = text.split('\n');
    assert.equal(parts.length, 3, status);
    const json = JSON.parse(parts[0]);
    assert.equal(json.status, status);
    assert.match(doc, new RegExp(`\\|\\s*\`${status}\`\\s*\\|\\s*${code}\\s*\\|`));
    assert.equal(code, EXIT[status]);
  }
  assert.match(doc, /本 issue 不安装调度，安装需 lead \/ Praise 批准/);
  assert.equal(EXIT.waiting, EXIT['ci-pending']);
});

test('#215 SC1 已跟踪改动输出 blocked-dirty，连续跑不新增提醒', async () => {
  const world = makeWorld();
  fs.appendFileSync(path.join(world.deploy, 'README.md'), 'changed\n');
  const first = await deploy(world);
  const json = assertRun(first, 'blocked-dirty');
  assert.equal(first.after, first.before);
  assert.match(fs.readFileSync(path.join(world.deploy, 'README.md'), 'utf8'), /changed/);
  assert.equal(json.lagging, false);
  assert.equal(mutations(first.calls).length, 0);
  const second = await deploy(world);
  assertRun(second, 'blocked-dirty');
  const third = await deploy(world);
  assertRun(third, 'blocked-dirty');
  const rows = readAlerts(world.alertsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'deploy-blocked-dirty');
  assert.equal(rows[0].head, first.before);
});

test('#215 SC1 未忽略的未跟踪文件输出 blocked-dirty', async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.deploy, 'UNTRACKED.txt'), 'x\n');
  const result = await deploy(world);
  assertRun(result, 'blocked-dirty');
  assert.equal(result.after, result.before);
  assert.equal(fs.existsSync(path.join(world.deploy, 'UNTRACKED.txt')), true);
  assert.equal(mutations(result.calls).some((args) => args[0] === 'fetch'), false);
});

test('#215 SC1 被忽略的未跟踪文件不挡快进', async () => {
  const world = makeWorld();
  fs.mkdirSync(path.join(world.deploy, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(world.deploy, '.git', 'info', 'exclude'), 'ignored.txt\n');
  fs.writeFileSync(path.join(world.deploy, 'ignored.txt'), 'nope\n');
  const result = await deploy(world);
  assertRun(result, 'up-to-date');
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC1 分叉输出 blocked-diverged 且不动', async () => {
  const world = makeWorld();
  commitAndPush(world, [{ path: 'docs/remote.md', content: 'remote\n' }], 'remote');
  fs.writeFileSync(path.join(world.deploy, 'local.md'), 'local\n');
  git(world.deploy, ['add', 'local.md']);
  git(world.deploy, ['commit', '-m', 'local']);
  const before = git(world.deploy, ['rev-parse', 'HEAD']);
  const result = await deploy(world);
  assertRun(result, 'blocked-diverged');
  assert.equal(result.after, before);
  assert.equal(fs.readFileSync(path.join(world.deploy, 'local.md'), 'utf8'), 'local\n');
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
  const again = await deploy(world);
  assertRun(again, 'blocked-diverged');
  assert.equal(readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-blocked-diverged').length, 1);
});

test('#215 SC1 本地超前输出 blocked-diverged', async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.deploy, 'local.md'), 'ahead\n');
  git(world.deploy, ['add', 'local.md']);
  git(world.deploy, ['commit', '-m', 'ahead']);
  const result = await deploy(world);
  assertRun(result, 'blocked-diverged');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'fetch'), true);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
});

test('#215 SC2 检查失败不拉', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/a.md', content: 'a\n' }], 'a');
  const result = await deploy(world, { fetchImpl: red(sha) });
  const json = assertRun(result, 'ci-red');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
  assert.equal(json.head, result.before);
  assert.equal(readAlerts(world.alertsFile).some((row) => row.kind === 'deploy-ci-red'), true);
});

test('#215 SC2 检查还在跑就等待且不写提醒', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/a.md', content: 'a\n' }], 'a');
  const result = await deploy(world, {
    fetchImpl: green(sha, { runs: [{ status: 'in_progress', conclusion: null, head_sha: sha }] }),
  });
  assertRun(result, 'ci-pending');
  assert.equal(result.code, EXIT.waiting);
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC2 读检查报错、超时、零条、格式不认得都不拉', async () => {
  const cases = [
    ['throw', { throwError: true }],
    ['hang', { hang: true, timeoutMs: 40 }],
    ['empty', { runs: [] }],
    ['shape', { payload: { nope: true } }],
    ['http', { status: 500 }],
  ];
  for (const [label, extra] of cases) {
    const world = makeWorld();
    const sha = commitAndPush(world, [{ path: 'docs/a.md', content: `${label}\n` }], label);
    const result = await deploy(world, { fetchImpl: green(sha, extra), timeoutMs: extra.timeoutMs });
    assertRun(result, 'ci-unknown');
    assert.equal(result.after, result.before, label);
    assert.equal(result.calls.some((args) => args[0] === 'merge'), false, label);
    assert.equal(readAlerts(world.alertsFile).some((row) => row.kind === 'deploy-ci-unknown'), true, label);
  }
});

test('#215 SC2 success、neutral、skipped 都算绿并部署', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/ok.md', content: 'ok\n' }], 'ok');
  const result = await deploy(world, { fetchImpl: green(sha) });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC3 rounds 不空就等待，不 fetch', async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.host, 'rounds', 'active.json'), '{}\n');
  const result = await deploy(world);
  assertRun(result, 'waiting');
  assert.equal(result.code, EXIT.waiting);
  assert.equal(result.after, result.before);
  assert.equal(mutations(result.calls).length, 0);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC3 locks 不空就等待', async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.host, 'locks', 'round.lock'), '{}\n');
  const result = await deploy(world);
  assertRun(result, 'waiting');
  assert.equal(mutations(result.calls).length, 0);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC3 验收进程在跑就等待', async () => {
  for (const name of ['round', 'prbot', 'adjudicate']) {
    const world = makeWorld();
    const result = await deploy(world, {
      listProcesses: () => [`node /opt/app/host/${name}.mjs --issue example-org/demo-repo#1`],
    });
    assertRun(result, 'waiting');
    assert.equal(BUSY_PROCESS_RE.test(`/host/${name}.mjs`), true);
    assert.equal(mutations(result.calls).length, 0);
  }
  const world = makeWorld();
  const quiet = await deploy(world, { listProcesses: () => ['node /opt/app/host/doctor.mjs'] });
  assertRun(quiet, 'up-to-date');
});

test('#215 SC3 演练锁被占就等待', async () => {
  const world = makeWorld();
  const release = await holdLock(world.prioLock);
  try {
    const result = await deploy(world);
    assertRun(result, 'waiting');
    assert.equal(result.calls.some((args) => args[0] === 'fetch'), false);
    assert.equal(readAlerts(world.alertsFile).length, 0);
  } finally {
    release();
  }
});

test('#215 SC8 本脚本的锁被占时直接 locked 且不跑 git', async () => {
  const world = makeWorld();
  const release = await holdLock(world.selfLock);
  try {
    const result = await deploy(world);
    assertRun(result, 'locked');
    assert.equal(result.calls.length, 0);
    assert.equal(result.after, result.before);
    assert.equal(fs.existsSync(world.alertsFile), false);
  } finally {
    release();
  }
});

test('#215 SC4 落后 6 个提交只在第一次 reportLag，部署成功后重新计', async () => {
  const world = makeWorld();
  let sha = '';
  for (let i = 0; i < 6; i += 1) {
    sha = commitAndPush(world, [{ path: `docs/lag-${i}.md`, content: `n${i}\n` }], `lag ${i}`, '2026-11-02T11:00:00Z');
  }
  const first = await deploy(world, { fetchImpl: red(sha), now: () => NOW });
  const json = assertRun(first, 'ci-red');
  assert.equal(json.behind, 6);
  assert.equal(json.lagging, true);
  assert.equal(json.reportLag, true);
  assert.match(first.stdout, /请 lead/);
  const second = await deploy(world, { fetchImpl: red(sha), now: () => NOW });
  const again = assertRun(second, 'ci-red');
  assert.equal(again.lagging, true);
  assert.equal(again.reportLag, false);
  const lagRows = readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-lagging');
  assert.equal(lagRows.length, 1);
  assert.equal(lagRows[0].head, first.before);
  const state = JSON.parse(fs.readFileSync(world.stateFile, 'utf8'));
  assert.equal(state.lagReportedFor, first.before);
  const deployed = await deploy(world, { fetchImpl: green(sha), now: () => NOW });
  assertRun(deployed, 'deployed');
  assert.deepEqual(JSON.parse(fs.readFileSync(world.stateFile, 'utf8')), { lagReportedFor: null, alerted: [] });
  let next = '';
  for (let i = 0; i < 6; i += 1) {
    next = commitAndPush(world, [{ path: `docs/again-${i}.md`, content: `a${i}\n` }], `again ${i}`, '2026-11-02T11:30:00Z');
  }
  const fresh = await deploy(world, { fetchImpl: red(next), now: () => NOW });
  const freshJson = assertRun(fresh, 'ci-red');
  assert.equal(freshJson.reportLag, true);
  assert.equal(freshJson.lagging, true);
});

test('#215 SC4 最早未部署提交超过 2 小时算落后，正好 2 小时或正好 5 个不算', async () => {
  const oldWorld = makeWorld();
  const oldSha = commitAndPush(
    oldWorld,
    [{ path: 'docs/old.md', content: 'old\n' }],
    'old',
    '2026-11-02T09:59:00Z',
  );
  const old = await deploy(oldWorld, { fetchImpl: red(oldSha), now: () => NOW });
  const oldJson = assertRun(old, 'ci-red');
  assert.equal(oldJson.behind, 1);
  assert.equal(oldJson.lagging, true);
  assert.equal(oldJson.reportLag, true);

  const exactWorld = makeWorld();
  const exactSha = commitAndPush(
    exactWorld,
    [{ path: 'docs/exact.md', content: 'exact\n' }],
    'exact',
    '2026-11-02T10:00:00Z',
  );
  const exact = await deploy(exactWorld, { fetchImpl: red(exactSha), now: () => NOW });
  const exactJson = assertRun(exact, 'ci-red');
  assert.equal(exactJson.lagging, false);
  assert.equal(exactJson.reportLag, false);

  const five = makeWorld();
  let sha = '';
  for (let i = 0; i < 5; i += 1) {
    sha = commitAndPush(five, [{ path: `docs/five-${i}.md`, content: `f${i}\n` }], `five ${i}`, '2026-11-02T11:00:00Z');
  }
  const fiveResult = await deploy(five, { fetchImpl: red(sha), now: () => NOW });
  const fiveJson = assertRun(fiveResult, 'ci-red');
  assert.equal(fiveJson.behind, 5);
  assert.equal(fiveJson.lagging, false);
});

const SENSITIVE_CASES = [
  ['#215 SC5 host 目录下的文件需要批准', 'watchers/acceptance/host/note.mjs', 'export const n = 1;\n'],
  ['#215 SC5 写闸文件需要批准', 'watchers/acceptance/host/write-gate.mjs', 'export const gate = 1;\n'],
  ['#215 SC5 trigger 需要批准', 'watchers/acceptance/bin/trigger.mjs', 'export const t = 1;\n'],
  ['#215 SC5 profile 需要批准', 'watchers/acceptance/bin/profile.mjs', 'export const p = 1;\n'],
  ['#215 SC5 github 需要批准', 'watchers/acceptance/bin/github.mjs', 'export const g = 1;\n'],
  ['#215 SC5 redact 需要批准', 'watchers/acceptance/bin/redact.mjs', 'export const r = 1;\n'],
  ['#215 SC5 secretscan 需要批准', 'watchers/acceptance/bin/secretscan.mjs', 'export const s = 1;\n'],
  ['#215 SC5 脚本自身需要批准', 'watchers/acceptance/deploy-ff.mjs', 'export const self = 1;\n'],
  ['#215 SC15 prio-sync 需要批准', 'watchers/acceptance/bin/prio-sync.mjs', 'export const sync = 1;\n'],
  ['#215 SC15 仓根 package.json 需要批准', 'package.json', '{"private":true}\n'],
  ['#215 SC15 子目录 package-lock.json 需要批准', 'deps/package-lock.json', '{"name":"demo"}\n'],
  ['#215 SC15 npm-shrinkwrap.json 需要批准', 'deps/npm-shrinkwrap.json', '{"name":"demo"}\n'],
  ['#215 SC15 yarn.lock 需要批准', 'deps/yarn.lock', 'demo-lock\n'],
  ['#215 SC15 pnpm-lock.yaml 需要批准', 'deps/pnpm-lock.yaml', 'lockfileVersion: 1\n'],
  ['#215 SC15 仓根 run-ensure.sh 需要批准', 'run-ensure.sh', 'echo ok\n'],
];

for (const [name, file, content] of SENSITIVE_CASES) {
  test(name, async () => {
    const world = makeWorld();
    const sha = commitAndPush(world, [{ path: file, content }], 'sensitive');
    const result = await deploy(world, { fetchImpl: green(sha) });
    const json = assertRun(result, 'needs-approval');
    assert.equal(result.after, result.before);
    assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
    assert.ok(json.files.includes(file), json.files.join(','));
    assert.match(json.reason, new RegExp(sha));
  });
}

test('#215 SC5 只改文档会继续部署', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/guide.md', content: 'hello\n' }], 'docs');
  const seen = {};
  const result = await deploy(world, {
    fetchImpl: green(sha, { bag: seen }),
    doctorArgs: ['--dry-run'],
    runDoctor: (input) => {
      seen.doctorArgs = input.args;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.deepEqual(seen.doctorArgs, ['--dry-run']);
  assert.match(seen.url, /example-org\/demo-repo/);
  assert.match(seen.url, new RegExp(sha));
});

test('#215 SC15 子目录的 package.json 和 run-ensure.sh 不算仓根', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [
    { path: 'sub/package.json', content: '{"name":"sub"}\n' },
    { path: 'sub/run-ensure.sh', content: 'echo sub\n' },
  ], 'nested');
  const result = await deploy(world, { fetchImpl: green(sha) });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
});

test('#215 SC6 完整且相等的 --approve 才放行，用过的批准文件会删', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  fs.writeFileSync(world.approvalFile, `${sha}\n`);
  const result = await deploy(world, { fetchImpl: green(sha), approvalFile: world.approvalFile });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.equal(fs.existsSync(world.approvalFile), false);
});

test('#215 SC6 sha 不匹配、短 sha、旧批准都不放行', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/bin/trigger.mjs', content: 'export const t = 1;\n' }], 'gate');
  const mismatch = await deploy(world, { fetchImpl: green(sha), approve: 'b'.repeat(40) });
  assertRun(mismatch, 'needs-approval');
  assert.equal(mismatch.after, mismatch.before);
  const short = await deploy(world, { fetchImpl: green(sha), approve: sha.slice(0, 7) });
  assertRun(short, 'needs-approval');
  fs.writeFileSync(world.approvalFile, `${'c'.repeat(40)}\n`);
  const stale = await deploy(world, { fetchImpl: green(sha), approvalFile: world.approvalFile });
  assertRun(stale, 'needs-approval');
  assert.equal(fs.readFileSync(world.approvalFile, 'utf8').trim(), 'c'.repeat(40));
});

test('#215 SC6 仓库里的同名文件和提交说明都不算批准', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [
    { path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' },
    { path: 'approval.txt', content: `${'d'.repeat(40)}\n` },
  ], 'approved');
  const real = git(world.worker, ['rev-parse', 'HEAD']);
  assert.equal(real, sha);
  const result = await deploy(world, { fetchImpl: green(sha) });
  assertRun(result, 'needs-approval');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
});

test('#215 SC6 批准文件指向部署目录内部时忽略，待拉提交里的副本也不算', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [
    { path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' },
    { path: 'approve-me.txt', content: `${'f'.repeat(40)}\n` },
  ], 'approved');
  const result = await deploy(world, {
    fetchImpl: green(sha),
    approvalFile: path.join(world.deploy, 'approve-me.txt'),
  });
  assertRun(result, 'needs-approval');
  assert.equal(result.after, result.before);
});

test('#215 SC6 命令行批准放行时，内容对不上的批准文件留着', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'package.json', content: '{"private":true}\n' }], 'pkg');
  fs.writeFileSync(world.approvalFile, `${'e'.repeat(40)}\n`);
  const result = await deploy(world, {
    fetchImpl: green(sha),
    approve: sha,
    approvalFile: world.approvalFile,
  });
  assertRun(result, 'deployed');
  assert.equal(fs.readFileSync(world.approvalFile, 'utf8').trim(), 'e'.repeat(40));
});

test('#215 SC6 检查没过时不删除已用的批准文件，也不回退', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  fs.writeFileSync(world.approvalFile, `${sha}\n`);
  const result = await deploy(world, {
    fetchImpl: green(sha),
    approvalFile: world.approvalFile,
    runDoctor: () => ({ code: 1, stdout: '检查没过\n', stderr: '' }),
  });
  assertRun(result, 'doctor-failed');
  assert.equal(result.after, sha);
  assert.equal(fs.existsSync(world.approvalFile), true);
  assert.equal(result.calls.some((args) => args[0] === 'reset'), false);
});

test('#215 SC7 语法检查失败时 doctor-failed 且不回退', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/broken.mjs', content: 'export function (\n' }], 'bad');
  const result = await deploy(world, {
    fetchImpl: green(sha),
    runDoctor: () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
  });
  const json = assertRun(result, 'doctor-failed');
  assert.equal(result.after, sha);
  assert.notEqual(result.after, result.before);
  assert.match(json.reason, /broken\.mjs/);
  assert.equal(result.calls.some((args) => args[0] === 'reset'), false);
  const rows = readAlerts(world.alertsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'deploy-doctor-failed');
  assert.equal(rows[0].head, sha);
  assert.equal(rows[0].target, sha);
  assert.ok(rows[0].ts && rows[0].reason);
});

test('#215 SC7 doctor 非 0 时 doctor-failed 且不回退', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/ok-note.mjs', content: 'export const ok = 1;\n' }], 'ok');
  let checked = [];
  const result = await deploy(world, {
    fetchImpl: green(sha),
    runCheck: async (file) => {
      checked.push(file);
      return { code: 0, stdout: '', stderr: '' };
    },
    runDoctor: () => ({ code: 2, stdout: '✗ 配置\n', stderr: '' }),
  });
  const json = assertRun(result, 'doctor-failed');
  assert.equal(result.after, sha);
  assert.match(json.reason, /doctor 退出 2/);
  assert.ok(checked.some((file) => file.endsWith('ok-note.mjs')));
  assert.equal(result.calls.some((args) => args[0] === 'reset'), false);
});

test('#215 SC7 语法和 doctor 都过才是 deployed', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/ok-note.mjs', content: 'export const ok = 1;\n' }], 'ok');
  let checked = 0;
  let doctored = 0;
  const result = await deploy(world, {
    fetchImpl: green(sha),
    runCheck: async () => {
      checked += 1;
      return { code: 0, stdout: '', stderr: '' };
    },
    runDoctor: () => {
      doctored += 1;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.equal(checked, 1);
  assert.equal(doctored, 1);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC13 检查全绿但 sha 不是目标完整 sha 时不拉，请求不带身份头', async () => {
  const world = makeWorld();
  const parent = git(world.deploy, ['rev-parse', 'HEAD']);
  const sha = commitAndPush(world, [{ path: 'docs/ci.md', content: 'ci\n' }], 'ci');
  const bag = {};
  const previous = await deploy(world, {
    fetchImpl: green(sha, {
      bag,
      runs: [{ status: 'completed', conclusion: 'success', head_sha: parent }],
    }),
  });
  assertRun(previous, 'ci-unknown');
  assert.equal(previous.after, parent);
  const keys = Object.keys(bag.init.headers).map((key) => key.toLowerCase());
  assert.equal(keys.includes('authorization'), false);
  assert.equal(JSON.stringify(bag.init.headers).toLowerCase().includes('authorization'), false);
  const short = await deploy(world, {
    fetchImpl: green(sha, { runs: [{ status: 'completed', conclusion: 'success', head_sha: sha.slice(0, 12) }] }),
  });
  assertRun(short, 'ci-unknown');
  assert.equal(short.after, parent);
  const ok = await deploy(world, { fetchImpl: green(sha, { bag }) });
  assertRun(ok, 'deployed');
  assert.equal(ok.after, sha);
  assert.match(bag.url, new RegExp(`/repos/example-org/demo-repo/commits/${sha}/check-runs`));
});

test('#215 SC13 合并状态的 sha 对不上就不拉，对得上才部署', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/status.md', content: 's\n' }], 'status');
  const bad = await deploy(world, {
    fetchImpl: green(sha, { payload: { sha: 'a'.repeat(40), state: 'success', statuses: [{ state: 'success' }] } }),
  });
  assertRun(bad, 'ci-unknown');
  assert.equal(bad.after, bad.before);
  const good = await deploy(world, {
    fetchImpl: green(sha, { payload: { sha, state: 'success', statuses: [{ state: 'success', context: 'ci' }] } }),
  });
  assertRun(good, 'deployed');
});

test('#215 SC14 needs-approval 连续 3 次只有 1 行，目标变了再写 1 行', async () => {
  const world = makeWorld();
  const firstSha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'one');
  for (let i = 0; i < 3; i += 1) {
    const result = await deploy(world, { fetchImpl: green(firstSha) });
    assertRun(result, 'needs-approval');
  }
  const rows = readAlerts(world.alertsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'deploy-needs-approval');
  assert.equal(rows[0].head, git(world.deploy, ['rev-parse', 'HEAD']));
  assert.equal(rows[0].target, firstSha);
  for (const key of ['ts', 'kind', 'reason', 'head', 'target']) assert.ok(rows[0][key]);
  const secondSha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 2;\n' }], 'two');
  const again = await deploy(world, { fetchImpl: green(secondSha) });
  assertRun(again, 'needs-approval');
  const more = readAlerts(world.alertsFile);
  assert.equal(more.length, 2);
  assert.equal(more[1].target, secondSha);
  assert.equal(more[1].kind, 'deploy-needs-approval');
});

test('#215 SC14 waiting、up-to-date、deployed 不写提醒', async () => {
  const waiting = makeWorld();
  fs.writeFileSync(path.join(waiting.host, 'rounds', 'x.json'), '{}\n');
  await deploy(waiting);
  assert.equal(readAlerts(waiting.alertsFile).length, 0);
  const same = makeWorld();
  const quiet = await deploy(same);
  assertRun(quiet, 'up-to-date');
  assert.equal(readAlerts(same.alertsFile).length, 0);
  const shipped = makeWorld();
  const sha = commitAndPush(shipped, [{ path: 'docs/ship.md', content: 'ship\n' }], 'ship');
  const done = await deploy(shipped, { fetchImpl: green(sha) });
  assertRun(done, 'deployed');
  assert.equal(readAlerts(shipped.alertsFile).length, 0);
});

test('#215 SC16 新增行含 process.env 需要批准并列出行', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/note.md', content: 'const x = process.env.PATH\n' }], 'env');
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.files.includes('docs/note.md'));
  assert.ok(json.lines.some((row) => row.file === 'docs/note.md' && row.text.includes('process.env')));
  assert.equal(result.after, result.before);
});

test('#215 SC16 新增行含 secrets/ 需要批准', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/note.md', content: 'see secrets/demo\n' }], 'path');
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.lines.some((row) => row.text.includes('secrets/')));
  assert.equal(result.after, result.before);
});

test('#215 SC16 新增行含 TOKEN 需要批准', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/note.md', content: 'const NAME = "TOKEN"\n' }], 'word');
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.lines.some((row) => row.text.includes('TOKEN')));
  assert.equal(result.after, result.before);
});

test('#215 SC16 这些词只出现在删除行时照常部署', async () => {
  const world = makeWorld();
  commitAndPush(world, [{ path: 'docs/note.md', content: 'process.env\nsecrets/\nTOKEN\n' }], 'add words');
  fastForward(world);
  const sha = commitAndPush(world, [{ path: 'docs/note.md', content: 'plain\n' }], 'drop words');
  const result = await deploy(world, { fetchImpl: green(sha) });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
});

test('#215 SC17 把写闸改名挪走仍然需要批准', async () => {
  const world = makeWorld();
  commitAndPush(world, [{ path: 'watchers/acceptance/host/write-gate.mjs', content: 'export const gate = 1;\n' }], 'seed');
  fastForward(world);
  fs.mkdirSync(path.join(world.worker, 'docs'), { recursive: true });
  git(world.worker, ['mv', 'watchers/acceptance/host/write-gate.mjs', 'docs/moved-gate.mjs']);
  git(world.worker, ['commit', '-m', 'move gate']);
  git(world.worker, ['push', 'origin', 'HEAD:main']);
  const sha = git(world.worker, ['rev-parse', 'HEAD']);
  const before = git(world.deploy, ['rev-parse', 'HEAD']);
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.files.includes('watchers/acceptance/host/write-gate.mjs'));
  assert.equal(result.after, before);
});

test('#215 SC17 把 trigger 改名挪走仍然需要批准', async () => {
  const world = makeWorld();
  commitAndPush(world, [{ path: 'watchers/acceptance/bin/trigger.mjs', content: 'export const t = 1;\n' }], 'seed');
  fastForward(world);
  fs.mkdirSync(path.join(world.worker, 'docs'), { recursive: true });
  git(world.worker, ['mv', 'watchers/acceptance/bin/trigger.mjs', 'docs/moved-trigger.mjs']);
  git(world.worker, ['commit', '-m', 'move trigger']);
  git(world.worker, ['push', 'origin', 'HEAD:main']);
  const sha = git(world.worker, ['rev-parse', 'HEAD']);
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.files.includes('watchers/acceptance/bin/trigger.mjs'));
  assert.equal(result.after, result.before);
});

test('#215 拉取远端失败不写提醒也不改 HEAD', async () => {
  const world = makeWorld();
  const result = await deploy(world, {
    runGit: (cwd, args) => {
      if (args[0] === 'fetch') return { ok: false, status: 1, stdout: '', stderr: 'could not fetch' };
      return defaultRunGit(cwd, args);
    },
  });
  assertRun(result, 'fetch-failed');
  assert.equal(result.after, result.before);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 快进失败写提醒且不动 HEAD', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/ff.md', content: 'ff\n' }], 'ff');
  const result = await deploy(world, {
    fetchImpl: green(sha),
    runGit: (cwd, args) => {
      if (args[0] === 'merge') return { ok: false, status: 1, stdout: '', stderr: 'not ff' };
      return defaultRunGit(cwd, args);
    },
  });
  assertRun(result, 'pull-failed');
  assert.equal(result.after, result.before);
  assert.equal(readAlerts(world.alertsFile)[0].kind, 'deploy-pull-failed');
});

test('#215 SC8 两个进程抢同一把锁，只有一个进入检查', async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.deploy, 'UNTRACKED.txt'), 'dirty\n');
  const log = path.join(world.root, 'git.log');
  const bin = path.join(world.root, 'fakebin');
  fs.mkdirSync(bin);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_LOG"
for arg in "$@"; do
  if [ "$arg" = "status" ] && [ ! -f "$GIT_LOG.slept" ]; then
    touch "$GIT_LOG.slept"
    sleep 3
  fi
done
exec "$REAL_GIT" "$@"
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_LOG: log, REAL_GIT: realGit };
  const [left, right] = await Promise.all([spawnCli(world, env), spawnCli(world, env)]);
  const statuses = [left, right].map((item) => JSON.parse(item.stdout.split('\n')[0]).status).sort();
  assert.deepEqual(statuses, ['blocked-dirty', 'locked'], `${left.stderr}\n${right.stderr}\n${left.stdout}\n${right.stdout}`);
  const text = fs.readFileSync(log, 'utf8');
  assert.equal(text.includes('fetch'), false, text);
  assert.match(text, /status/);
});

test('#215 SC9 命令行入口标准输出恰好两行', async () => {
  const world = makeWorld();
  const result = await spawnCli(world);
  assert.equal(result.code, EXIT['up-to-date']);
  const parts = result.stdout.split('\n');
  assert.equal(parts.length, 3, `${result.stdout}\n${result.stderr}`);
  const json = JSON.parse(parts[0]);
  assert.equal(json.status, 'up-to-date');
  assert.equal(parts[2], '');
});

test('#215 SC10 SC14 SC17 源码静态约束', () => {
  const hostImport = spawnSync('grep', ['-nE', String.raw`from '\./host/|from '\.\./host/|host/[a-z-]+\.mjs`, SCRIPT], { encoding: 'utf8' });
  assert.equal(hostImport.status, 1, hostImport.stdout);
  const banned = spawnSync('grep', ['-niE', 'crontab|systemctl|--write|authorization|slack', SCRIPT], { encoding: 'utf8' });
  assert.equal(banned.status, 1, banned.stdout);
  const renames = spawnSync('grep', ['-n', '--', '--no-renames', SCRIPT], { encoding: 'utf8' });
  assert.equal(renames.status, 0, renames.stderr);
  assert.match(renames.stdout, /--no-renames/);
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /renameSync/);
  const expected = [
    'docs/acceptance-operations.md',
    'watchers/acceptance/deploy-ff.mjs',
    'watchers/acceptance/deploy-ff.test.mjs',
  ];
  // 不读 origin/main：CI 的 checkout 往往只有一个提交，没有远端引用。
  // 父提交在本地时，用 HEAD 和它的父提交比；浅克隆没有父提交时，改查工作区里这三份文件。
  const parent = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^'], { cwd: ROOT, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(untracked.status, 0);
  assert.equal(untracked.stdout.trim(), '');
  if (parent.status === 0) {
    const diff = spawnSync('git', ['diff', '--name-only', 'HEAD^', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(diff.status, 0, diff.stderr);
    const files = diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
    assert.deepEqual(files, expected);
  } else {
    for (const file of expected) {
      assert.equal(fs.existsSync(path.join(ROOT, file)), true, file);
      const tracked = spawnSync('git', ['cat-file', '-e', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(tracked.status, 0, `${file} 不在这次提交里`);
    }
  }
});

test('#215 M1 检查期间远端又前进时只合并第一次的目标提交', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/m1.md', content: 'first\n' }], 'first');
  const result = await deploy(world, {
    fetchImpl: async (url, init) => {
      commitAndPush(world, [{ path: 'docs/m1-later.md', content: 'later\n' }], 'later');
      git(world.deploy, ['fetch', 'origin']);
      return green(sha)(url, init);
    },
  });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.notEqual(git(world.worker, ['rev-parse', 'HEAD']), sha);
});

test('#215 M2 合并前 rounds 出现文件就等待且 HEAD 不动', async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/m2.md', content: 'm2\n' }], 'm2');
  const result = await deploy(world, {
    fetchImpl: async (url, init) => {
      fs.writeFileSync(path.join(world.host, 'rounds', 'appeared.json'), '{}\n');
      return green(sha)(url, init);
    },
  });
  assertRun(result, 'waiting');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
});

test('#215 L1 宿主状态目录不存在就等待', async () => {
  const world = makeWorld();
  const result = await deploy(world, { hostStateDir: path.join(world.root, 'no-such-host') });
  assertRun(result, 'waiting');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'fetch'), false);
});

test('#215 L2 相对路径启动的轮次进程也算非空档', async () => {
  for (const name of ['round', 'prbot', 'adjudicate']) {
    const world = makeWorld();
    const result = await deploy(world, { listProcesses: () => [`node ${name}.mjs`] });
    assertRun(result, 'waiting');
    assert.equal(result.after, result.before);
  }
  const world = makeWorld();
  const self = await deploy(world, {
    listProcesses: () => [
      'node watchers/acceptance/deploy-ff.mjs --deploy-dir /tmp/deploy',
      'node watchers/acceptance/deploy-ff.test.mjs',
    ],
  });
  assertRun(self, 'up-to-date');
});

test('#215 L2 列不出进程就等待', async () => {
  const world = makeWorld();
  const result = await deploy(world, { listProcesses: () => null });
  assertRun(result, 'waiting');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'fetch'), false);
});

test('#215 L3 新增行内容以两个加号开头仍要批准', async () => {
  const diff = [
    'diff --git a/docs/plus.md b/docs/plus.md',
    '--- /dev/null',
    '+++ b/docs/plus.md',
    '@@ -0,0 +1 @@',
    '+++ process.env.X',
  ].join('\n');
  const parsed = parseAddedLines(diff);
  assert.ok(parsed.some((row) => row.text === '++ process.env.X'), JSON.stringify(parsed));
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/plus.md', content: '++ process.env.X\n' }], 'plus');
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.equal(result.after, result.before);
  assert.ok(json.lines.some((row) => row.file === 'docs/plus.md' && row.text.includes('process.env')));
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /--no-ext-diff/);
  assert.match(src, /--no-textconv/);
});

test('#215 SC11 新增文件没有本机绝对路径和邮箱', () => {
  for (const file of [SCRIPT, path.join(HERE, 'deploy-ff.test.mjs'), DOC]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/\/Users\/[A-Za-z0-9._-]+/.test(text), false, file);
    assert.equal(/@users\.noreply\.github\.com/.test(text), false, file);
  }
  assert.equal(classifyChecks(null, 'a'.repeat(40)), 'ci-unknown');
  assert.equal(classifyChecks({ total_count: 0, check_runs: [] }, 'a'.repeat(40)), 'ci-unknown');
});
