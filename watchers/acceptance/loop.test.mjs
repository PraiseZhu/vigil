// #47 SC12：常驻循环的 contract 测试。真跑 host/loop（tick 换成假的），真跑 host/ensure.sh。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RateLimitError, createGithub } from './bin/github.mjs';
import { MAX_CONSECUTIVE_SKIPS } from './bin/rate-budget.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { runRound } from './bin/round.mjs';
import { hostPaths, isAlive, readAlerts } from './host/paths.mjs';
import { roundDirFor, runHostRound } from './host/round.mjs';
import { MAX_CHILD_CLAIMS_PER_TICK, runTick } from './host/tick.mjs';
import { TICK_INTERVAL_MAX_SECONDS, TICK_INTERVAL_SECONDS, tickIntervalSeconds } from './host/tick.mjs';
import { heartbeatMaxAgeMs } from './host/poll-beat.mjs';
import {
  FLOCK_SKIP,
  OWNER,
  REPO,
  childNode,
  createFakeRun,
  inventoryData,
  issueNode,
  tmpDir,
  writeProfile,
} from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_DIR = path.join(HERE, 'host');
const spawned = [];
const knownTickLogs = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 8000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(stepMs);
  }
  return false;
}

function killQuiet(pid, signal = 'SIGKILL') {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** 拷一份 host/ 到临时目录，把 tick.mjs 换成假 tick（记 ppid、写心跳、睡一会儿）。 */
function makeHostCopy(home, tickLog) {
  // 只拷 host/ 和 bin/（host/ 里的模块 import ../bin/*，只拷 host/ 会断）。
  // 不拷整个 watchers/acceptance：别的测试会同时在那里建 / 删 .xxx-real-test- 临时目录，整拷会偶发 ENOENT。
  const root = tmpDir('acceptance-host-copy-');
  for (const sub of ['host', 'bin']) {
    fs.cpSync(path.join(HERE, sub), path.join(root, 'acceptance', sub), {
      recursive: true,
      filter: (src) => !path.basename(src).startsWith('.') || src === path.join(HERE, sub),
    });
  }
  const dir = path.join(root, 'acceptance', 'host');
  fs.writeFileSync(
    path.join(dir, 'tick.mjs'),
    `#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const home = process.env.ACCEPTANCE_WATCHER_HOME;
fs.appendFileSync(${JSON.stringify(tickLog)}, process.ppid + ':' + process.pid + '\\n');
const stateHost = path.join(home, 'state', 'host');
fs.mkdirSync(stateHost, { recursive: true });
fs.writeFileSync(
  path.join(stateHost, 'heartbeat.json'),
  JSON.stringify({ at: new Date().toISOString(), pid: process.ppid, lastTick: { ok: true, started: [], stale: [] }, running: [] }),
);
// 测试开关：模拟 tick 拉起的长轮次（脱离出去、比 loop 活得久），把 pid 记到 rounds.log。
const roundSeconds = Number(process.env.FAKE_ROUND_SECONDS || 0);
if (roundSeconds > 0) {
  const round = spawn('sleep', [String(roundSeconds)], { detached: true, stdio: 'ignore' });
  fs.appendFileSync(${JSON.stringify(tickLog)} + '.rounds', round.pid + '\\n');
  round.unref();
}
setTimeout(() => process.exit(0), 3000);
`,
  );
  return dir;
}

function startLoop(hostCopy, home, tickSeconds = '1') {
  const child = spawn('sh', [path.join(hostCopy, 'loop')], {
    env: {
      ...process.env,
      ACCEPTANCE_WATCHER_HOME: home,
      // 不传就不设这个变量：专测「默认拍间隔」（#247 SC3）。
      ...(tickSeconds === null ? {} : { ACCEPTANCE_TICK_SECONDS: tickSeconds }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })));
  spawned.push(child);
  return { child, exited, get stderr() { return stderr; } };
}

function runScript(script, home, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('sh', [script], {
      env: { ...process.env, ACCEPTANCE_WATCHER_HOME: home, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function readSleeps(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function tickLines(tickLog) {
  try {
    return fs.readFileSync(tickLog, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

after(() => {
  // 真跑过 loop/ensure.sh：把 tick.log 里记到的 loop 和 tick 进程都收掉，别留下孤儿。
  for (const child of spawned) killQuiet(child.pid);
  for (const log of knownTickLogs) {
    for (const line of tickLines(log)) {
      const [loopPid, tickPid] = line.split(':');
      killQuiet(Number(tickPid));
      killQuiet(Number(loopPid));
    }
  }
});

test('SC12 loop 是单实例：第二个实例拿不到 flock 就退出，不跑 tick', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);

  const first = startLoop(hostCopy, home);
  try {
    assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), '第一个 loop 要跑 tick');
    const second = await runScript(path.join(hostCopy, 'loop'), home, { ACCEPTANCE_TICK_SECONDS: '1' });
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stderr, /loop 已在跑/);
    const before = tickLines(tickLog).length;
    await sleep(300);
    assert.equal(tickLines(tickLog).length, before, '第二个实例不该跑 tick');
  } finally {
    killQuiet(first.child.pid);
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    await first.exited;
  }
});

test('SC12 ensure.sh：心跳新鲜且 pid 活着 → 什么都不做、不写提醒', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const hostCopy = makeHostCopy(home, path.join(home, 'tick.log'));
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  fs.writeFileSync(
    paths.heartbeatFile,
    JSON.stringify({ at: new Date(nowMs).toISOString(), pid: process.pid, lastTick: { ok: true }, running: [] }),
  );
  const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(nowMs) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(paths.loopLog), false, '不该拉起循环');
  assert.deepEqual(readAlerts(paths), []);
});

test('#61 ensure.sh：心跳里有 slackFailing（Slack 发送重试用完）就在输出里报一行，循环正常也报', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const hostCopy = makeHostCopy(home, path.join(home, 'tick.log'));
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  const beat = { at: new Date(nowMs).toISOString(), pid: process.pid, lastTick: { ok: true }, running: [] };
  fs.writeFileSync(paths.heartbeatFile, JSON.stringify(beat));
  const clean = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(nowMs) });
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal(clean.stdout.includes('slack-failed'), false, '没有失败就不报');

  fs.writeFileSync(
    paths.heartbeatFile,
    JSON.stringify({
      ...beat,
      slackFailing: { since: '2026-10-24T01:00:00.000Z', lastAt: '2026-10-24T01:40:00.000Z', kind: 'blocked', error: 'http-500 <!channel>', count: 2 },
    }),
  );
  const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(nowMs) });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^slack-failed: since=2026-10-24T01:00:00.000Z last=2026-10-24T01:40:00.000Z kind=blocked error=http-500channel count=2$/m);
  assert.equal(fs.existsSync(paths.loopLog), false, '循环正常，不拉起');
  assert.deepEqual(readAlerts(paths), []);
});

test('SC12 ensure.sh：心跳过期的拉起循环并写一条提醒；连跑两次也只有一个循环', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
  fs.writeFileSync(
    paths.heartbeatFile,
    JSON.stringify({ at: new Date(staleMs).toISOString(), pid: process.pid, lastTick: { ok: true }, running: [] }),
  );

  // 冒充「现在」比心跳晚 10 分钟：心跳过期 → 拉起 loop。
  const first = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(staleMs + 600000) });
  assert.equal(first.code, 0, first.stderr);
  assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), 'ensure.sh 要拉起循环跑 tick');
  const alerts = readAlerts(paths).filter((entry) => entry.kind === 'loop-restarted');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].reason, 'heartbeat-stale');

  // 再跑一次：心跳已经新鲜（假 tick 写的）且 pid 活着 → 什么都不做。
  const second = await runScript(path.join(hostCopy, 'ensure.sh'), home);
  assert.equal(second.code, 0, second.stderr);
  const firstLoop = tickLines(tickLog)[0].split(':')[0];
  const loops = new Set(tickLines(tickLog).map((line) => line.split(':')[0]));
  assert.equal(loops.size, 1, `只该有一个 loop，实际 ${[...loops].join(',')}`);
  assert.equal(fs.readFileSync(paths.loopLog, 'utf8').length >= 0, true);

  // 杀掉 loop：心跳里的 pid 不在 → ensure.sh 重新拉起。
  killQuiet(Number(firstLoop));
  for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
  assert.ok(await waitFor(() => !isAlive(Number(firstLoop)), 3000), 'loop 进程要真的退出');
  const third = await runScript(path.join(hostCopy, 'ensure.sh'), home);
  assert.equal(third.code, 0, third.stderr);
  assert.ok(
    await waitFor(() => new Set(tickLines(tickLog).map((line) => line.split(':')[0])).size >= 2),
    '杀掉之后要重新拉起',
  );
  const restarted = readAlerts(paths).filter((entry) => entry.kind === 'loop-restarted');
  assert.ok(restarted.length >= 2);
  assert.ok(restarted.some((entry) => entry.reason === 'loop-not-running'), JSON.stringify(restarted));

  for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
  for (const pid of new Set(tickLines(tickLog).map((line) => line.split(':')[0]))) killQuiet(Number(pid));
});

/** 起一个占着 loop.lock 的假「原循环」（flock 持锁再 sleep），返回它的 pid。 */
async function holdLoopLock(paths, seconds = 30) {
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const lockFile = path.join(paths.hostDir, 'loop.lock');
  const child = spawn('flock', [lockFile, 'sleep', String(seconds)], { stdio: 'ignore' });
  spawned.push(child);
  const held = await waitFor(() => spawnSync('flock', ['-n', lockFile, 'true']).status !== 0, 3000);
  assert.ok(held, '前提：假原循环要占住 loop.lock');
  return child.pid;
}

function loopLogText(paths) {
  return fs.existsSync(paths.loopLog) ? fs.readFileSync(paths.loopLog, 'utf8') : '';
}

test('ensure.sh：心跳过期但原循环进程还在、锁还占着 → 只记「心跳延迟」，不补起新循环、不发 loop-restarted', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  const holder = await holdLoopLock(paths);
  try {
    const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
    fs.writeFileSync(
      paths.heartbeatFile,
      JSON.stringify({ at: new Date(staleMs).toISOString(), pid: holder, lastTick: { ok: true }, running: [] }),
    );
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(staleMs + 600000) });
    assert.equal(result.code, 0, result.stderr);
    await sleep(1500);
    assert.deepEqual(tickLines(tickLog), [], '不该拉起新循环跑 tick');
    const alerts = readAlerts(paths);
    assert.equal(alerts.filter((entry) => entry.kind === 'loop-restarted').length, 0, JSON.stringify(alerts));
    const delayed = alerts.filter((entry) => entry.kind === 'heartbeat-delayed');
    assert.equal(delayed.length, 1, JSON.stringify(alerts));
    assert.equal(delayed[0].reason, 'delay-600s');
    assert.match(loopLogText(paths), /心跳延迟 600 秒，但原循环进程还在、单实例锁也还占着/);
    assert.ok(isAlive(holder), '原循环不该被动');
  } finally {
    killQuiet(holder);
  }
});

test('ensure.sh：心跳过期且原循环进程已不在 → 照常拉起并发 loop-restarted(heartbeat-stale)', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const gone = spawnSync('sh', ['-c', 'echo $$']);
  const deadPid = Number(String(gone.stdout).trim());
  assert.ok(!isAlive(deadPid), '前提：pid 已不在');
  const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
  fs.writeFileSync(
    paths.heartbeatFile,
    JSON.stringify({ at: new Date(staleMs).toISOString(), pid: deadPid, lastTick: { ok: true }, running: [] }),
  );
  try {
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(staleMs + 600000) });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), '要拉起循环');
    const alerts = readAlerts(paths);
    assert.deepEqual(alerts.map((entry) => [entry.kind, entry.reason]), [['loop-restarted', 'heartbeat-stale']]);
    assert.equal(alerts.some((entry) => entry.kind === 'heartbeat-delayed'), false);
  } finally {
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    for (const pid of new Set(tickLines(tickLog).map((line) => line.split(':')[0]))) killQuiet(Number(pid));
  }
});

test('ensure.sh：心跳过期、pid 碰巧活着但锁没人占（pid 被别的进程复用）→ 保守起见照常拉起', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  fs.writeFileSync(path.join(paths.hostDir, 'loop.lock'), '');
  const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
  fs.writeFileSync(
    paths.heartbeatFile,
    JSON.stringify({ at: new Date(staleMs).toISOString(), pid: process.pid, lastTick: { ok: true }, running: [] }),
  );
  try {
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(staleMs + 600000) });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), '锁没人占就要拉起');
    assert.deepEqual(readAlerts(paths).map((entry) => entry.kind), ['loop-restarted']);
  } finally {
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    for (const pid of new Set(tickLines(tickLog).map((line) => line.split(':')[0]))) killQuiet(Number(pid));
  }
});

test('部署重启：stop.sh 留标记 → ensure.sh 拉起时记 loop-deploy-restarted（不是 loop-restarted），标记用完即删；新循环起来也清标记', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  const marker = path.join(paths.hostDir, 'planned-stop.json');
  try {
    const first = await runScript(path.join(hostCopy, 'ensure.sh'), home);
    assert.equal(first.code, 0, first.stderr);
    assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), '先拉起一个循环');
    const firstLoop = Number(tickLines(tickLog)[0].split(':')[0]);

    const stopped = await runScript(path.join(hostCopy, 'stop.sh'), home);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.ok(fs.existsSync(marker), 'stop.sh 要留「主动停」标记');
    assert.equal(JSON.parse(fs.readFileSync(marker, 'utf8')).by, 'stop.sh');
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    assert.ok(await waitFor(() => !isAlive(firstLoop), 3000), 'loop 要真的退出');

    const again = await runScript(path.join(hostCopy, 'ensure.sh'), home);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(
      await waitFor(() => new Set(tickLines(tickLog).map((line) => line.split(':')[0])).size >= 2),
      '部署后要拉起新循环',
    );
    const kinds = readAlerts(paths).map((entry) => [entry.kind, entry.reason]);
    assert.deepEqual(kinds.slice(-1), [['loop-deploy-restarted', 'planned-stop']], JSON.stringify(kinds));
    assert.equal(fs.existsSync(marker), false, '标记用一次就删');
    assert.match(loopLogText(paths), /按部署重启记录/);
  } finally {
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    for (const pid of new Set(tickLines(tickLog).map((line) => line.split(':')[0]))) killQuiet(Number(pid));
  }

  // 手动起循环（不经 ensure）也会清掉残留标记，免得以后真挂了被当成部署重启。
  fs.writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), by: 'stop.sh', pid: 1 }));
  const manual = startLoop(hostCopy, home, '30');
  assert.ok(await waitFor(() => !fs.existsSync(marker), 3000), '循环起来要清标记');
  killQuiet(manual.child.pid);
  await manual.exited;
});

test('部署重启：标记超过 2 小时就不算，按意外重启发 loop-restarted 并删掉旧标记', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const marker = path.join(paths.hostDir, 'planned-stop.json');
  const nowMs = Date.parse('2026-10-24T05:00:00.000Z');
  fs.writeFileSync(marker, JSON.stringify({ at: new Date(nowMs - 3 * 3600000).toISOString(), by: 'stop.sh', pid: 1 }));
  try {
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(nowMs) });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readAlerts(paths).map((entry) => [entry.kind, entry.reason]), [['loop-restarted', 'heartbeat-stale']]);
    assert.equal(fs.existsSync(marker), false, '过期标记也要删');
    assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), '要拉起循环');
  } finally {
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    for (const pid of new Set(tickLines(tickLog).map((line) => line.split(':')[0]))) killQuiet(Number(pid));
  }
});

test('SC12 停掉 loop 后，残留的子进程（在跑的轮次、sleep）不占单实例锁：ensure.sh 马上能拉起新循环', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  const roundsLog = `${tickLog}.rounds`;
  const roundPids = () => tickLines(roundsLog).map(Number);
  try {
    // 用 ensure.sh 起（和部署一样是 setsid 起的），假 tick 每拍拉起一个活 30 秒的「轮次」。
    const first = await runScript(path.join(hostCopy, 'ensure.sh'), home, { FAKE_ROUND_SECONDS: '30' });
    assert.equal(first.code, 0, first.stderr);
    assert.ok(await waitFor(() => roundPids().length >= 1), '假 tick 要拉起一个轮次');
    const firstLoop = Number(tickLines(tickLog)[0].split(':')[0]);

    // 照 stop.sh 的做法停：只杀心跳里的 loop pid。轮次和 tick 都还活着。
    const stopped = await runScript(path.join(hostCopy, 'stop.sh'), home);
    assert.equal(stopped.code, 0, stopped.stderr);
    assert.ok(await waitFor(() => !isAlive(firstLoop), 3000), 'loop 要真的退出');
    assert.ok(isAlive(roundPids()[0]), '前提：轮次还在跑');

    const again = await runScript(path.join(hostCopy, 'ensure.sh'), home);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(
      await waitFor(() => new Set(tickLines(tickLog).map((line) => line.split(':')[0])).size >= 2, 2500),
      `轮次还在跑时新循环也要起得来；loop.log：${fs.existsSync(paths.loopLog) ? fs.readFileSync(paths.loopLog, 'utf8') : ''}`,
    );
  } finally {
    for (const pid of roundPids()) killQuiet(pid);
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    for (const pid of new Set(tickLines(tickLog).map((line) => line.split(':')[0]))) killQuiet(Number(pid));
  }
});

test('#T9 ensure.sh：墙钟过期 2000 秒、uptime 只差 30 秒、pid 活着锁占着 → 记 host-frozen，不补起', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  const holder = await holdLoopLock(paths);
  try {
    const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
    fs.writeFileSync(
      paths.heartbeatFile,
      JSON.stringify({
        at: new Date(staleMs).toISOString(),
        pid: holder,
        uptimeS: 1000,
        lastTick: { ok: true },
        running: [],
      }),
    );
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, {
      ACCEPTANCE_NOW_MS: String(staleMs + 2000000),
      ACCEPTANCE_UPTIME_S: '1030',
    });
    assert.equal(result.code, 0, result.stderr);
    await sleep(1500);
    assert.deepEqual(tickLines(tickLog), [], '不该拉起新循环跑 tick');
    const alerts = readAlerts(paths);
    const frozen = alerts.filter((entry) => entry.kind === 'host-frozen');
    assert.equal(frozen.length, 1, JSON.stringify(alerts));
    assert.match(frozen[0].reason, /^frozen-1970s$/);
    assert.equal(alerts.some((entry) => entry.kind === 'heartbeat-delayed'), false, JSON.stringify(alerts));
    assert.equal(alerts.some((entry) => entry.kind === 'loop-restarted'), false, JSON.stringify(alerts));
    assert.match(loopLogText(paths), /整机冻结/);
    assert.ok(isAlive(holder), '原循环不该被动');
  } finally {
    killQuiet(holder);
  }
});

test('#T9 ensure.sh：不设 ACCEPTANCE_UPTIME_S 时用机器真实 uptime 判冻结（正式部署走这条）', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  const holder = await holdLoopLock(paths);
  try {
    const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
    fs.writeFileSync(
      paths.heartbeatFile,
      JSON.stringify({
        at: new Date(staleMs).toISOString(),
        pid: holder,
        uptimeS: Math.max(0, os.uptime() - 30),
        lastTick: { ok: true },
        running: [],
      }),
    );
    const env = { ACCEPTANCE_NOW_MS: String(staleMs + 2000000) };
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, env);
    assert.equal(result.code, 0, result.stderr);
    const alerts = readAlerts(paths);
    const frozen = alerts.filter((entry) => entry.kind === 'host-frozen');
    assert.equal(frozen.length, 1, JSON.stringify(alerts));
    assert.ok(Number(/^frozen-(\d+)s$/.exec(frozen[0].reason)?.[1]) >= 1800, frozen[0].reason);
    assert.equal(alerts.some((entry) => entry.kind === 'heartbeat-delayed'), false, JSON.stringify(alerts));
  } finally {
    killQuiet(holder);
  }
});

test('#T9 ensure.sh：墙钟过期 2000 秒、uptime 也差 2000 秒（真慢）、pid 活着锁占着 → 仍是 heartbeat-delayed', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  const holder = await holdLoopLock(paths);
  try {
    const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
    fs.writeFileSync(
      paths.heartbeatFile,
      JSON.stringify({
        at: new Date(staleMs).toISOString(),
        pid: holder,
        uptimeS: 1000,
        lastTick: { ok: true },
        running: [],
      }),
    );
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, {
      ACCEPTANCE_NOW_MS: String(staleMs + 2000000),
      ACCEPTANCE_UPTIME_S: '3000',
    });
    assert.equal(result.code, 0, result.stderr);
    await sleep(1500);
    assert.deepEqual(tickLines(tickLog), [], '不该拉起新循环跑 tick');
    const alerts = readAlerts(paths);
    assert.equal(alerts.some((entry) => entry.kind === 'host-frozen'), false, JSON.stringify(alerts));
    const delayed = alerts.filter((entry) => entry.kind === 'heartbeat-delayed');
    assert.equal(delayed.length, 1, JSON.stringify(alerts));
    assert.equal(delayed[0].reason, 'delay-2000s');
    assert.match(loopLogText(paths), /心跳延迟 2000 秒/);
  } finally {
    killQuiet(holder);
  }
});

test('#T9 ensure.sh：墙钟过期 2000 秒、uptime 差 30 秒、pid 已死 → 拉起并记 heartbeat-stale-after-freeze', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const gone = spawnSync('sh', ['-c', 'echo $$']);
  const deadPid = Number(String(gone.stdout).trim());
  assert.ok(!isAlive(deadPid), '前提：pid 已不在');
  const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
  fs.writeFileSync(
    paths.heartbeatFile,
    JSON.stringify({
      at: new Date(staleMs).toISOString(),
      pid: deadPid,
      uptimeS: 1000,
      lastTick: { ok: true },
      running: [],
    }),
  );
  try {
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, {
      ACCEPTANCE_NOW_MS: String(staleMs + 2000000),
      ACCEPTANCE_UPTIME_S: '1030',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), '要拉起循环');
    const alerts = readAlerts(paths);
    assert.deepEqual(alerts.map((entry) => [entry.kind, entry.reason]), [['loop-restarted', 'heartbeat-stale-after-freeze']]);
    assert.match(loopLogText(paths), /整机冻结 1970 秒后原循环已不在，已补起新循环/);
  } finally {
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    for (const pid of new Set(tickLines(tickLog).map((line) => line.split(':')[0]))) killQuiet(Number(pid));
  }
});

test('#T9 ensure.sh：旧心跳没有 uptimeS、pid 已死 → 仍是 loop-restarted(heartbeat-stale)', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const gone = spawnSync('sh', ['-c', 'echo $$']);
  const deadPid = Number(String(gone.stdout).trim());
  assert.ok(!isAlive(deadPid), '前提：pid 已不在');
  const staleMs = Date.parse('2026-10-24T02:00:00.000Z');
  fs.writeFileSync(
    paths.heartbeatFile,
    JSON.stringify({ at: new Date(staleMs).toISOString(), pid: deadPid, lastTick: { ok: true }, running: [] }),
  );
  try {
    const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, {
      ACCEPTANCE_NOW_MS: String(staleMs + 2000000),
      ACCEPTANCE_UPTIME_S: '1030',
    });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), '要拉起循环');
    const alerts = readAlerts(paths);
    assert.deepEqual(alerts.map((entry) => [entry.kind, entry.reason]), [['loop-restarted', 'heartbeat-stale']]);
    assert.equal(alerts.some((entry) => entry.kind === 'host-frozen'), false);
    assert.doesNotMatch(loopLogText(paths), /整机冻结/);
  } finally {
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
    for (const pid of new Set(tickLines(tickLog).map((line) => line.split(':')[0]))) killQuiet(Number(pid));
  }
});

test('#T9 loop 收到 SIGTERM：2 秒内 loop.log 记下退出，锁立刻释放，ensure.sh 能拉起新循环', { skip: FLOCK_SKIP }, async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  const first = startLoop(hostCopy, home);
  try {
    assert.ok(await waitFor(() => tickLines(tickLog).length >= 1), '先要跑一拍');
    const loopPid = Number(tickLines(tickLog)[0].split(':')[0]);
    assert.ok(loopPid > 0);
    killQuiet(loopPid, 'SIGTERM');
    assert.ok(
      await waitFor(() => {
        const text = loopLogText(paths);
        return text.includes('调度循环退出') && text.includes('TERM');
      }, 2000),
      `2 秒内 loop.log 要记下 TERM 退出；实际：${loopLogText(paths)}`,
    );
    const again = await runScript(path.join(hostCopy, 'ensure.sh'), home);
    assert.equal(again.code, 0, again.stderr);
    assert.ok(
      await waitFor(() => new Set(tickLines(tickLog).map((line) => line.split(':')[0])).size >= 2, 2500),
      `ensure.sh 要马上拉起新循环（锁已释放）；loop.log：${loopLogText(paths)}`,
    );
  } finally {
    killQuiet(first.child.pid);
    for (const line of tickLines(tickLog)) {
      killQuiet(Number(line.split(':')[1]));
      killQuiet(Number(line.split(':')[0]));
    }
    await first.exited;
  }
});

test('SC12 tick 写心跳：时间、pid、上一拍结果、在跑的轮次', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
    uptime: () => 12345.6,
  });
  assert.equal(heartbeat.at, '2026-10-24T02:00:00.000Z');
  assert.ok(Number.isInteger(heartbeat.pid));
  assert.equal(heartbeat.uptimeS, 12345.6);
  assert.deepEqual(heartbeat.lastTick, {
    ok: true,
    started: [],
    stale: [],
    error: null,
    // 额度预算配置（#247 SC5）：测试 home 里没放 rate-budget.json，只记原因、不猜默认值。
    rateBudgetError: '读不到额度预算配置 rate-budget.json',
    // 写闸账本旁路审计（空账本：建基线，不报）：这一拍核对了 0 行、没有新拿不准。
    gateAudit: { checked: 0, found: 0, sinceBaseline: 0, uncertain: 0 },
  });
  assert.equal(heartbeat.tickIntervalS, 180, '默认拍间隔是 180 秒（#247 SC3）');
  assert.deepEqual(heartbeat.running, []);
  const onDisk = JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
  assert.equal(onDisk.at, heartbeat.at);
  assert.equal(onDisk.pid, heartbeat.pid);
  assert.equal(onDisk.uptimeS, 12345.6);
  assert.deepEqual(onDisk.lastTick, heartbeat.lastTick);
  assert.deepEqual(onDisk.running, []);
});

test('SC12 tick 起的后台进程要放手（unref）：起了一个要跑很久的子进程，父进程照样马上退出，常驻循环不停拍', async () => {
  const procUrl = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'host', 'proc.mjs')).href;
  const script = `const { spawnBackground } = await import(${JSON.stringify(procUrl)});
    const child = spawnBackground(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    process.stdout.write(String(child.pid));`;
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20000 });
  const elapsed = Date.now() - started;
  const pid = Number(result.stdout);
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsed < 10000, `父进程等了子进程 ${elapsed}ms 才退`);
    assert.ok(pid > 0);
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退了。
    }
  }
});

// T18：拉取（poll）慢时心跳照常刷新，另记「正在拉取、已多久」；拉取超过上限就不再刷新，真卡死照样露出来。
function slowPollTick({ home, clock, pollBeatMs = 15 }) {
  let release;
  const pollDone = new Promise((resolve) => { release = resolve; });
  const tick = runTick({
    home,
    env: { ...process.env },
    run: async (_cmd, args) => {
      if (args.some((arg) => String(arg).endsWith('poll.mjs'))) {
        await pollDone;
      }
      return { code: 0, stdout: '[]', stderr: '' };
    },
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => clock.wall,
    uptime: () => clock.up,
    pollBeatMs,
  });
  return { tick, release: () => release() };
}

const readBeat = (home) => JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('T18 慢拉取期间心跳照常刷新、带「正在拉取、已多久」，上一拍结果保留；拉完收尾心跳不再带拉取状态', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const T0 = Date.parse('2026-10-24T02:00:00.000Z');
  const clock = { wall: T0, up: 1000 };
  fs.mkdirSync(hostPaths(home).hostDir, { recursive: true });
  fs.writeFileSync(hostPaths(home).heartbeatFile, JSON.stringify({ at: new Date(T0 - 60000).toISOString(), lastTick: { ok: true, marker: 'prev' }, running: [] }));
  const { tick, release } = slowPollTick({ home, clock });
  try {
    await sleepMs(60);
    clock.wall = T0 + 95000;
    clock.up = 1095;
    await sleepMs(80);
    const beat = readBeat(home);
    assert.equal(beat.at, new Date(T0 + 95000).toISOString(), '拉取中心跳时间要跟着刷新');
    assert.equal(beat.uptimeS, 1095);
    assert.deepEqual(beat.lastTick, { ok: true, marker: 'prev' }, '上一拍结果不能被抹掉');
    assert.ok(beat.polling, '心跳要带拉取状态');
    assert.equal(beat.polling.startedAt, new Date(T0).toISOString());
    assert.equal(beat.polling.elapsedS, 95);
  } finally {
    release();
  }
  const done = await tick;
  const final = readBeat(home);
  assert.equal(final.polling, undefined, '拉完收尾心跳不带拉取状态');
  assert.equal(done.polling, undefined);
  assert.equal(final.at, new Date(T0 + 95000).toISOString(), '收尾心跳时间取写入时刻，不能比拉取中刷新的还旧');
});

test('T18 拉取超过上限（180 秒）就不再刷新心跳：真卡死照样表现为心跳过期', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const T0 = Date.parse('2026-10-24T02:00:00.000Z');
  const clock = { wall: T0, up: 1000 };
  const { tick, release } = slowPollTick({ home, clock });
  try {
    await sleepMs(60);
    clock.wall = T0 + 170000;
    clock.up = 1170;
    await sleepMs(80);
    assert.equal(readBeat(home).polling.elapsedS, 170);
    clock.wall = T0 + 400000;
    clock.up = 1400;
    await sleepMs(80);
    const beat = readBeat(home);
    assert.equal(beat.at, new Date(T0 + 170000).toISOString(), '超过上限后心跳停在最后一次刷新');
    assert.equal(beat.polling.elapsedS, 170);
  } finally {
    release();
  }
  await tick;
});

// T20：修正轮（prbot）阶段读 GitHub 挂住时，读取要被超时掐掉、这一拍以读失败收尾；心跳在整拍内都刷新并带当前阶段。
function prbotHangTick({ home, clock, pollBeatMs = 15, prbotReadTimeoutMs = 300, onGh }) {
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config', 'host.json'),
    JSON.stringify({ prbot: { piCommand: ['pi'], repos: { 'example-owner/example-repo': { handoff: 'owner' } } } }),
  );
  return runTick({
    home,
    env: { ...process.env },
    run: async (cmd, args, opts = {}) => {
      if (cmd === 'gh') return onGh(args, opts);
      return { code: 0, stdout: '[]', stderr: '' };
    },
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async ({ github }) => {
      await github.graphql('query { viewer { login } }', {});
      return [];
    },
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
    now: () => clock.wall,
    uptime: () => clock.up,
    pollBeatMs,
    prbotReadTimeoutMs,
  });
}

test('T20 修正轮读取挂住：超时被掐掉，这一拍记 prbotError 收尾；挂住期间心跳刷新且阶段是 prbot、不再残留拉取状态', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const T0 = Date.parse('2026-10-30T18:47:00.000Z');
  const clock = { wall: T0, up: 5000 };
  const seen = [];
  const tick = prbotHangTick({
    home,
    clock,
    onGh: (args, opts) => {
      seen.push(opts.timeoutMs);
      return new Promise(() => {}); // 对端不回包：永远不返回
    },
  });
  await sleepMs(80);
  clock.wall = T0 + 40000;
  clock.up = 5040;
  await sleepMs(80);
  const mid = readBeat(home);
  assert.equal(mid.polling, undefined, '拉取已结束，心跳不能再残留拉取状态');
  assert.equal(mid.phase?.name, 'prbot', '心跳要带当前阶段 prbot');
  assert.equal(mid.phase.elapsedS, 40);
  assert.equal(mid.at, new Date(T0 + 40000).toISOString(), '修正轮阶段心跳照常刷新');
  const done = await tick;
  assert.ok(seen.length >= 1 && seen.every((ms) => ms === 300), `读取要带超时：${seen}`);
  assert.match(String(done.lastTick.prbotError || ''), /124|超时/);
  assert.equal(done.phase, undefined, '拍尾心跳不带阶段');
});

test('T20 修正轮阶段超过上限（180 秒）就停刷心跳，真卡死照样露出来', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const T0 = Date.parse('2026-10-30T18:47:00.000Z');
  const clock = { wall: T0, up: 5000 };
  let release;
  const tick = prbotHangTick({
    home,
    clock,
    prbotReadTimeoutMs: 60000,
    onGh: () => new Promise((resolve) => { release = () => resolve({ code: 0, stdout: '{"data":{}}', stderr: '' }); }),
  });
  try {
    await sleepMs(80);
    clock.wall = T0 + 170000;
    clock.up = 5170;
    await sleepMs(80);
    assert.equal(readBeat(home).phase.elapsedS, 170);
    clock.wall = T0 + 400000;
    clock.up = 5400;
    await sleepMs(80);
    const beat = readBeat(home);
    assert.equal(beat.at, new Date(T0 + 170000).toISOString(), '超过上限后心跳停在最后一次刷新');
    assert.equal(beat.phase.name, 'prbot');
  } finally {
    release?.();
  }
  await tick;
});

test('T20 读超时只加在读上：只读 graphql、GET 带超时；mutation、POST/PATCH 不加（写不改）', async () => {
  const { withReadTimeout } = await import('./host/tick.mjs');
  const calls = [];
  const wrapped = withReadTimeout(async (cmd, args, opts) => {
    calls.push(opts?.timeoutMs);
    return { code: 0, stdout: '{}', stderr: '' };
  }, 120000);
  await wrapped('gh', ['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: 'query { viewer { login } }' }) });
  await wrapped('gh', ['api', 'repos/o/r/issues/1'], {});
  await wrapped('gh', ['api', '-X', 'GET', 'repos/o/r'], {});
  await wrapped('gh', ['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: 'mutation { x }' }) });
  await wrapped('gh', ['api', '-X', 'POST', 'repos/o/r/issues'], {});
  await wrapped('gh', ['api', '-X', 'PATCH', 'repos/o/r/issues/1'], {});
  await wrapped('git', ['push'], {});
  assert.deepEqual(calls, [120000, 120000, 120000, undefined, undefined, undefined, undefined]);
});

function enableGate(home) {
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.enabledFile, '1\n');
  return paths;
}

function childPollEntry(number) {
  return {
    issue: `${REPO}#${number}`,
    kind: 'child',
    tier: 'auto',
    fork: false,
    nextRound: 1,
    bodyVersion: 'sha256:abc',
  };
}

function rememberRunning(home, issue) {
  const paths = hostPaths(home);
  fs.mkdirSync(paths.roundsDir, { recursive: true });
  const name = `${issue.replace(/[^\w.-]+/g, '__')}.json`;
  fs.writeFileSync(path.join(paths.roundsDir, name), JSON.stringify({ issue, pid: process.pid, round: 1 }));
}

function tickPoll(home, entries, spawnRound) {
  return runTick({
    home,
    env: { ...process.env },
    run: async () => ({ code: 0, stdout: JSON.stringify(entries), stderr: '' }),
    spawnRound,
    runRound: async () => {
      throw new Error('不该写轮次评论');
    },
    notify: async () => ({ ok: true, reason: 'not-configured' }),
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
}

test('#224 SC4 同一子 issue 连续多拍不重开', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  enableGate(home);
  const entry = childPollEntry(2);
  const started = [];
  const spawnRound = (issue) => {
    started.push(issue);
    rememberRunning(home, issue);
    return process.pid;
  };
  for (let n = 0; n < 3; n += 1) {
    const heartbeat = await tickPoll(home, [entry], spawnRound);
    assert.equal(heartbeat.lastTick.ok, true);
  }
  assert.deepEqual(started, [entry.issue]);
  assert.equal(readAlerts(hostPaths(home)).length, 0);
});

test('#224 SC9 34 个存量子 issue 每拍只开 1 个，N 拍正好开 N 个', async () => {
  assert.equal(MAX_CHILD_CLAIMS_PER_TICK, 1);
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  enableGate(home);
  const entries = Array.from({ length: 34 }, (_, index) => childPollEntry(index + 2));
  const started = [];
  const spawnRound = (issue) => {
    started.push(issue);
    rememberRunning(home, issue);
    return process.pid;
  };
  const ticks = 3;
  for (let n = 0; n < ticks; n += 1) {
    const heartbeat = await tickPoll(home, entries, spawnRound);
    assert.equal(heartbeat.lastTick.started.length, 1, `第 ${n + 1} 拍只能开 1 个`);
    assert.equal(heartbeat.lastTick.started[0].issue, entries[n].issue);
  }
  assert.equal(started.length, ticks);
  assert.equal(new Set(started).size, ticks);
  assert.equal(readAlerts(hostPaths(home)).length, 0, '限速跳过的不写提醒');
});

test('#224 SC9 槽满时不认领、不写评论；下一拍槽空了再开', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const paths = enableGate(home);
  fs.mkdirSync(paths.slotsDir, { recursive: true });
  for (const name of ['slot-0', 'slot-1']) {
    fs.writeFileSync(path.join(paths.slotsDir, name), JSON.stringify({ pid: process.pid, startedAt: '2026-10-24T00:00:00.000Z' }));
  }
  const started = [];
  const blocked = await tickPoll(home, [childPollEntry(2), childPollEntry(3)], (issue) => {
    started.push(issue);
    return process.pid;
  });
  assert.deepEqual(started, []);
  assert.deepEqual(blocked.lastTick.started, []);
  assert.equal(readAlerts(paths).length, 0);

  for (const name of ['slot-0', 'slot-1']) fs.rmSync(path.join(paths.slotsDir, name), { force: true });
  const retried = await tickPoll(home, [childPollEntry(2), childPollEntry(3)], (issue) => {
    started.push(issue);
    rememberRunning(home, issue);
    return process.pid;
  });
  assert.deepEqual(started, [`${REPO}#2`]);
  assert.deepEqual(retried.lastTick.started.map((entry) => entry.issue), [`${REPO}#2`]);
});

test('#224 SC9 内存门拦住时不写评论、不算一轮，下一拍再试', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  enableGate(home);
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'host.json'), JSON.stringify({ piCommand: ['pi'] }));
  const meminfo = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(meminfo, ['MemTotal: 16384 kB', 'MemAvailable: 1024 kB', ''].join('\n'));
  const ghCalls = [];
  const roundCalls = [];
  const logs = [];
  const code = await runHostRound({
    home,
    issue: `${REPO}#2`,
    run: async (cmd, args) => {
      ghCalls.push({ cmd, args });
      return { code: 0, stdout: '', stderr: '' };
    },
    runRound: async (argv) => {
      roundCalls.push(argv);
      return { code: 0, stdout: '', stderr: '' };
    },
    meminfoPath: meminfo,
    log: (message) => logs.push(message),
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(code, 3);
  assert.deepEqual(roundCalls, [], '内存门在认领之前，不写轮次评论');
  assert.deepEqual(ghCalls, [], '内存门不发 gh，也没有 PR 写调用');
  assert.match(logs.join('\n'), /mem-gate-defer/);
  assert.equal(readAlerts(hostPaths(home)).length, 0, '被拦不另写提醒');

  const started = [];
  const heartbeat = await tickPoll(home, [childPollEntry(2), childPollEntry(3)], (issue) => {
    started.push(issue);
    return process.pid;
  });
  assert.deepEqual(started, [`${REPO}#2`]);
  assert.equal(heartbeat.lastTick.started.length, 1);
});

test('#228 SC5 kind=child 夹具认领成功后创建 roundDir', async () => {
  const home = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } }).home;
  enableGate(home);
  fs.writeFileSync(path.join(home, 'config', 'host.json'), JSON.stringify({ piCommand: ['pi'] }));
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const body = '- [ ] SC1 子项 验证：unit';
  const childRef = `${REPO}#2`;
  let child = issueNode({
    repo: REPO,
    number: 2,
    title: 'child task',
    body,
    state: 'CLOSED',
    closedAt: '2026-10-20T00:00:00.000Z',
    author: OWNER,
    parent: { number: 1, repository: { nameWithOwner: REPO }, author: { login: OWNER } },
    prs: [
      {
        number: 9,
        url: 'https://example.test/pull/9',
        mergedAt: '2026-10-20T01:00:00.000Z',
        repository: { nameWithOwner: REPO },
      },
    ],
    subIssues: [],
  });
  const parent = issueNode({
    repo: REPO,
    number: 1,
    body: '- [ ] SC1 父清单 验证：unit',
    author: OWNER,
    subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: '2026-10-20T00:00:00.000Z' })],
  });
  let commentSeq = 7000;
  const run = createFakeRun({
    onGraphql: (payload) => {
      const query = String(payload.query || '');
      if (query.includes('user(login')) return inventoryData({ open: [parent], closed: [child] });
      if (query.includes('repository(owner')) return { repository: { issue: child } };
      return {};
    },
    onApi: (args, { input }) => {
      const request = input ? JSON.parse(input) : {};
      const apiPath = args.find((item) => String(item).startsWith('repos/')) || '';
      if (args.includes('POST') && /issues\/\d+\/comments$/.test(apiPath)) {
        const id = ++commentSeq;
        const stamp = '2026-10-24T02:00:00.000Z';
        child.comments.nodes.push({
          id: `IC_${id}`,
          databaseId: id,
          body: request.body,
          createdAt: stamp,
          updatedAt: stamp,
          url: `https://example.test/issues/2#issuecomment-${id}`,
          author: { login: OWNER },
        });
        return { id, html_url: `https://example.test/issues/2#issuecomment-${id}` };
      }
      if (args.includes('PATCH') && /issues\/comments\/\d+$/.test(apiPath)) {
        const id = Number(apiPath.split('/').pop());
        const found = child.comments.nodes.find((comment) => comment.databaseId === id);
        if (found) found.body = request.body;
        return { id, html_url: `https://example.test/issues/2#issuecomment-${id}` };
      }
      return { id: 1 };
    },
  });
  const github = createGithub({ profile, run });
  const meminfo = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(meminfo, 'MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n');
  const code = await runHostRound({
    home,
    issue: childRef,
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: async (argv) => {
      let stdout = '';
      let stderr = '';
      const exit = await runRound(argv, {
        github,
        profile,
        now: () => Date.parse('2026-10-24T02:00:00.000Z'),
        stdout: { write(chunk) { stdout += chunk; return true; } },
        stderr: { write(chunk) { stderr += chunk; return true; } },
      });
      return { code: exit, stdout, stderr };
    },
    prefetch: async () => {
      throw new Error('stop-after-round-dir');
    },
    meminfoPath: meminfo,
    log: () => {},
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  const dir = roundDirFor(hostPaths(home), childRef, 1);
  assert.equal(fs.existsSync(dir), true, `roundDir 没创建，start 输出：${code}`);
  assert.equal(code, 1, '预取被夹具打断，目录已经建好');
  const alerts = readAlerts(hostPaths(home));
  assert.equal(alerts.some((entry) => entry.kind === 'claim-failed'), false, JSON.stringify(alerts));
  assert.ok(alerts.some((entry) => entry.kind === 'prefetch-failed'), JSON.stringify(alerts));
});

// ── #247 SC1 / SC3：一拍只盘点一次；主循环拍间隔 60 → 180 秒 ──

test('#247 SC1 一拍只盘点一次：poll 的清单交给修正轮发现，不再第二次全量盘点', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config', 'host.json'),
    JSON.stringify({ prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } }),
  );
  const tasks = [
    { ref: `${REPO}#1`, repo: REPO, number: 1, kind: 'standalone', tier: 'auto', state: 'open', rounds: [] },
    { ref: `${REPO}#2`, repo: REPO, number: 2, kind: 'standalone', tier: 'auto', state: 'open', rounds: [] },
  ];
  const pollArgs = [];
  const discovered = [];
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async (cmd, args) => {
      pollArgs.push(args);
      // poll --with-inventory 的新形状：条目 + 这一拍的任调清单 + 读了几次。
      return { code: 0, stdout: JSON.stringify({ entries: [], tasks, reads: 3 }), stderr: '' };
    },
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async (options) => {
      discovered.push(options);
      return [];
    },
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });

  assert.equal(pollArgs.length, 1, '一拍只起一次 poll');
  assert.ok(pollArgs[0].includes('--with-inventory'), `poll 要带 --with-inventory：${pollArgs[0]}`);
  assert.equal(discovered.length, 1);
  assert.deepEqual(discovered[0].tasks, tasks, '修正轮发现直接拿到这一拍的盘点清单');
  assert.equal(heartbeat.lastTick.ok, true);
  assert.deepEqual(heartbeat.lastTick.prbotStarted, []);

  // 读数是 poll 交出来的真实请求次数（生产端契约见 poll.test.mjs 的「pollInventory 交出这一拍真的发了几次只读请求」）；
  // 这里只验消费端：reads × 6 点记进 loop 组件的本小时用量。
  const rateState = JSON.parse(fs.readFileSync(hostPaths(home).rateState, 'utf8'));
  assert.equal(rateState.components.loop.used, 3 * 6);
});

test('#247 SC1 poll 还是老形状（数组）时，修正轮仍自己拉，不被当成「有清单」', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config', 'host.json'),
    JSON.stringify({ prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } }),
  );
  const discovered = [];
  await runTick({
    home,
    env: { ...process.env },
    run: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async (options) => {
      discovered.push(options);
      return [];
    },
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].tasks, null, '老形状没有清单：留给 discoverCorrections 自己拉');
});

test('#247 SC3 默认拍间隔 180 秒；注入小间隔后 sleep 序列跟着变', async () => {
  // 静态：脚本默认值就是 180，不再是 60。
  const script = fs.readFileSync(path.join(HOST_DIR, 'loop'), 'utf8');
  assert.match(script, /ACCEPTANCE_TICK_SECONDS:-180/);
  assert.doesNotMatch(script, /ACCEPTANCE_TICK_SECONDS:-60/);
  assert.equal(TICK_INTERVAL_SECONDS, 180);
  assert.equal(tickIntervalSeconds({}), 180);
  assert.equal(tickIntervalSeconds({ ACCEPTANCE_TICK_SECONDS: '60' }), 60);
  assert.equal(tickIntervalSeconds({ ACCEPTANCE_TICK_SECONDS: 'abc' }), 180, '不合法的注入值回落默认');

  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  // 假 sleep：把 loop 每次传给 sleep 的秒数记下来（不真睡），顺便把 tick 换成只记一行的假进程。
  const sleepLog = path.join(home, 'sleep.log');
  const bin = path.join(home, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'sleep'), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(sleepLog)}\n`, { mode: 0o755 });
  // 假 tick：占 200 毫秒就退出，免得「假 sleep 立刻返回」把循环变成空转。
  fs.writeFileSync(path.join(hostCopy, 'tick.mjs'), '#!/usr/bin/env node\nsetTimeout(() => {}, 200);\n');

  const loopWith = (seconds) => {
    const child = spawn('sh', [path.join(hostCopy, 'loop')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ACCEPTANCE_WATCHER_HOME: home,
        ...(seconds === null ? {} : { ACCEPTANCE_TICK_SECONDS: seconds }),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    spawned.push(child);
    return child;
  };

  const first = loopWith(null);
  try {
    assert.ok(await waitFor(() => readSleeps(sleepLog).length >= 1, 5000), `默认间隔要落成 sleep 参数：${loopLogText(hostPaths(home))}`);
    assert.deepEqual(readSleeps(sleepLog).slice(0, 1), ['180'], '不给注入值就用默认 180 秒');
  } finally {
    killQuiet(first.pid);
  }

  fs.rmSync(sleepLog, { force: true });
  const second = loopWith('1');
  try {
    assert.ok(await waitFor(() => readSleeps(sleepLog).length >= 2, 5000), `注入 1 秒后要连着睡 1 秒：${readSleeps(sleepLog)}`);
    assert.deepEqual(readSleeps(sleepLog).slice(0, 2), ['1', '1']);
  } finally {
    killQuiet(second.pid);
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
  }
});

// ── #247 SC6：低额度时跳过非必要读；限流拍不写 tick-failed ──

function hostWithPrbot(home) {
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config', 'host.json'),
    JSON.stringify({ prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } }),
  );
}

test('#247 SC6 剩余低于 800：这一拍跳过修正轮发现（非必要读），写「因额度跳过」，不写 tick-failed', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  hostWithPrbot(home);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  fs.writeFileSync(
    paths.rateState,
    JSON.stringify({
      version: 1,
      identities: {
        user: {
          identity: 'user',
          known: true,
          remaining: 0,
          remainingRaw: '0',
          reset: new Date(nowMs + 600_000).toISOString(),
          at: new Date(nowMs).toISOString(),
          source: 'graphql',
        },
      },
      components: {},
      recovery: null,
      skips: { count: 0, lastAt: null },
    }),
  );
  const discovered = [];
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async () => ({ code: 0, stdout: JSON.stringify({ entries: [], tasks: [], reads: 1 }), stderr: '' }),
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async (options) => {
      discovered.push(options);
      return [];
    },
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
    now: () => nowMs,
  });
  assert.equal(discovered.length, 0, '低额度时这一拍不拉修正轮发现');
  assert.equal(heartbeat.lastTick.rateSkipped, 'remaining-below-800');
  assert.equal(heartbeat.lastTick.ok, true, '跳过不是失败');
  assert.equal(readAlerts(paths).filter((entry) => entry.kind === 'tick-failed').length, 0, '不写 tick-failed');
  assert.match(fs.readFileSync(paths.loopLog, 'utf8'), /rate-skip component=loop identity=user remaining=0 action=remaining-below-800 因额度跳过/);
});

test('#247 SC6 poll 遇限流（退出码 75）：这一拍跳过，心跳照写、不写 tick-failed', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const paths = hostPaths(home);
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async () => ({ code: 75, stdout: '', stderr: '触发 GitHub 限流（响应头剩余 0）' }),
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(heartbeat.lastTick.rateSkipped, 'github-rate-limited');
  assert.equal(heartbeat.lastTick.skipped, undefined, '跳过只写一个字段名（P2-3），不再两处各写一个');
  assert.equal(heartbeat.lastTick.ok, true, '限流不算这一拍失败');
  assert.equal(heartbeat.lastTick.error, null);
  assert.equal(readAlerts(paths).filter((entry) => entry.kind === 'tick-failed').length, 0);
  assert.match(fs.readFileSync(paths.loopLog, 'utf8'), /rate-skip component=loop identity=user remaining=unknown action=github-rate-limited 因额度跳过/);
  // 心跳写下去了、且新鲜（看门狗不会停循环）。
  const beat = JSON.parse(fs.readFileSync(paths.heartbeatFile, 'utf8'));
  assert.equal(beat.lastTick.rateSkipped, 'github-rate-limited');
});

// ── 复审 #247 第二轮：P2-1 / P2-2 / P2-3 / P3-1 / P3-2 / P2-6 ──

/** 写一份额度状态文件（响应头剩余按 user 这一枚记）。 */
function writeRateStateFile(paths, { remaining = 4000, resetInMs = 600000, used = null, skips = { count: 0, lastAt: null }, nowMs = Date.now() } = {}) {
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const hourKey = Math.floor(nowMs / (60 * 60 * 1000));
  fs.writeFileSync(
    paths.rateState,
    JSON.stringify({
      version: 1,
      identities: {
        user: {
          identity: 'user',
          known: true,
          remaining,
          remainingRaw: String(remaining),
          reset: new Date(nowMs + resetInMs).toISOString(),
          at: new Date(nowMs).toISOString(),
          source: 'graphql',
        },
      },
      components: used === null ? {} : { loop: { hourKey, used, updatedAt: new Date(nowMs).toISOString() } },
      recovery: null,
      skips,
    }),
  );
}

function writeBudgetConfig(home, rateBudget) {
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'rate-budget.json'), JSON.stringify({ rateBudget }));
}

test('#247 P2-1 修正轮发现遇限流：不写 prbot-tick-failed，心跳照写 ok，只记一行「因额度跳过」', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  hostWithPrbot(home);
  const paths = hostPaths(home);
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  writeRateStateFile(paths, { remaining: 4000, nowMs });
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    now: () => nowMs,
    run: async () => ({ code: 0, stdout: JSON.stringify({ entries: [], tasks: [], reads: 1 }), stderr: '' }),
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async () => {
      throw new RateLimitError('触发 GitHub 限流（响应头剩余 0）', { remaining: '0', reset: '1762299600', identity: 'user' });
    },
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(heartbeat.lastTick.ok, true, '限流不算这一拍失败');
  assert.equal(heartbeat.lastTick.prbotError, undefined, '限流不该写成修正轮出错');
  assert.equal(readAlerts(paths).filter((entry) => entry.kind === 'prbot-tick-failed').length, 0, '不许写 prbot-tick-failed');
  assert.equal(heartbeat.lastTick.rateSkipped, 'github-rate-limited');
  assert.equal(heartbeat.lastTick.rateSkippedStage, 'prbot-discover', '哪一段跳过写在同一条心跳里');
  assert.match(fs.readFileSync(paths.loopLog, 'utf8'), /rate-skip component=loop identity=user remaining=0 action=github-rate-limited 因额度跳过/);
  // 限流那次的响应头也记下来：下一拍的闸才看得见真实剩余。
  const state = JSON.parse(fs.readFileSync(paths.rateState, 'utf8'));
  assert.equal(state.identities.user.remaining, 0);
});

test('#247 P2-1 剩余低于 800：修正轮的「卡住检查」也跳过（非必要读不放过）', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  hostWithPrbot(home);
  const paths = hostPaths(home);
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  writeRateStateFile(paths, { remaining: 0, nowMs });
  const stalledCalls = [];
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    now: () => nowMs,
    run: async () => ({ code: 0, stdout: JSON.stringify({ entries: [], tasks: [], reads: 1 }), stderr: '' }),
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async () => [],
    checkPrbotStalled: async (options) => {
      stalledCalls.push(options);
      return [];
    },
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(stalledCalls.length, 0, '低额度时卡住检查也是非必要读，要跳过');
  assert.deepEqual(heartbeat.lastTick.prbotStalled, []);
  assert.equal(heartbeat.lastTick.ok, true);
});

test('#247 P2-2 poll 没给 reads 时按 1 记；给了 0（这一拍没发请求）就不记用量', async () => {
  const runOnce = async (stdout) => {
    const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
    const paths = hostPaths(home);
    await runTick({
      home,
      env: { ...process.env },
      run: async () => ({ code: 0, stdout, stderr: '' }),
      spawnRound: () => 1,
      spawnPrbot: () => 1,
      runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
      checkPrbotStalled: async () => [],
      cleanupPrbot: () => [],
      gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
      notify: async () => ({ ok: false, reason: 'not-configured' }),
    });
    return paths;
  };
  const legacy = await runOnce(JSON.stringify({ entries: [], tasks: [] }));
  assert.equal(JSON.parse(fs.readFileSync(legacy.rateState, 'utf8')).components.loop.used, 6, '老形状没 reads：按一次请求算');
  const zero = await runOnce(JSON.stringify({ entries: [], tasks: [], reads: 0 }));
  const state = JSON.parse(fs.readFileSync(zero.rateState, 'utf8'));
  assert.equal(state.components.loop, undefined, 'reads=0 表示这一拍没发请求，不记用量');
});

test('#247 P1 预算越线时 essential 照跑（poll/abort/派发），只有非必要读被跳过', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  hostWithPrbot(home);
  enableGate(home);
  const paths = hostPaths(home);
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  writeBudgetConfig(home, { loop: 500, 'prio-run': 300, 'board-live': 140 });
  // 本小时已经用满（used 500）：非必要读全部跳过，但 essential 不受预算闸约束（复审 rev-258 的 P1）。
  writeRateStateFile(paths, { remaining: 4000, resetInMs: 3000 * 1000, used: 500, nowMs });
  const polled = [];
  const aborted = [];
  const started = [];
  const discovered = [];
  const stalled = [];
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    now: () => nowMs,
    run: async (cmd, args) => {
      polled.push(args);
      // 一条卡住的轮次（要 abort）+ 一条该派发的条目（要起轮）。
      return {
        code: 0,
        stdout: JSON.stringify({
          entries: [
            { issue: `${REPO}#9`, round: 1, stale: true, lastProgressAt: '2026-10-24T01:00:00.000Z' },
            { issue: `${REPO}#10`, kind: 'standalone', tier: 'auto', fork: false, nextRound: 1, bodyVersion: 'sha256:abc' },
          ],
          tasks: [],
          reads: 1,
        }),
        stderr: '',
      };
    },
    spawnRound: (issue) => {
      started.push(issue);
      return 1;
    },
    spawnPrbot: () => 1,
    runRound: async (argv) => {
      aborted.push(argv);
      return { code: 0, stdout: '', stderr: '' };
    },
    discoverPrbot: async () => {
      discovered.push('discover');
      return [];
    },
    checkPrbotStalled: async () => {
      stalled.push('stalled');
      return [];
    },
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(heartbeat.lastTick.ok, true, '心跳照旧 ok');
  assert.equal(polled.length, 1, 'essential（主循环 poll）越预算也照跑，不然这一小时剩下的 poll 全停');
  assert.deepEqual(aborted.map((argv) => argv[0]), ['abort'], '卡住的轮次照样 abort（心跳 ok 之外的唯一推进动作）');
  assert.ok(aborted[0].includes(`${REPO}#9`), `abort 带上卡住的 issue：${aborted[0]}`);
  assert.deepEqual(started, [`${REPO}#10`], '该派发的条目照样派发');
  assert.deepEqual(discovered, [], '非必要读（修正轮发现）被预算闸跳过');
  assert.deepEqual(stalled, [], '非必要读（卡住检查）被预算闸跳过');
  assert.equal(heartbeat.lastTick.rateSkipped, 'over-budget', '跳过原因写进心跳（外部只认这一个字段）');
  const log = fs.readFileSync(paths.loopLog, 'utf8');
  assert.match(log, /rate-skip component=loop identity=user remaining=4000 action=over-budget budget=500 used=506 cost=6 因额度跳过/);
  const alerts = readAlerts(paths).filter((entry) => entry.kind === 'rate-skip-escalate');
  assert.equal(alerts.length, 0, '只跳过 1 拍（两个非必要闸算一拍）不该提醒');
});

test('#247 P2-b 预算越线连跑 2N+3 拍：提醒恰好 1 条，连跳按「拍」数', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  hostWithPrbot(home);
  const paths = hostPaths(home);
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  writeBudgetConfig(home, { loop: 500, 'prio-run': 300, 'board-live': 140 });
  // 窗口重置在 55 分钟后：这一段都算同一个窗口，不会切进恢复期（那样连跳会被清零）。
  writeRateStateFile(paths, { remaining: 4000, resetInMs: 55 * 60 * 1000, used: 500, nowMs });
  const ticks = 2 * MAX_CONSECUTIVE_SKIPS + 3;
  const polled = [];
  const discovered = [];
  const stalled = [];
  let heartbeat = null;
  for (let i = 0; i < ticks; i += 1) {
    heartbeat = await runTick({
      home,
      env: { ...process.env },
      now: () => nowMs + i * TICK_INTERVAL_SECONDS * 1000,
      run: async () => {
        polled.push(i);
        return { code: 0, stdout: JSON.stringify({ entries: [], tasks: [], reads: 1 }), stderr: '' };
      },
      spawnRound: () => 1,
      spawnPrbot: () => 1,
      runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
      discoverPrbot: async () => {
        discovered.push(i);
        return [];
      },
      checkPrbotStalled: async () => {
        stalled.push(i);
        return [];
      },
      cleanupPrbot: () => [],
      gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
      notify: async () => ({ ok: false, reason: 'not-configured' }),
    });
    assert.equal(heartbeat.lastTick.ok, true, `第 ${i + 1} 拍心跳仍是 ok`);
  }
  assert.equal(polled.length, ticks, '每一拍都 poll（essential 不受预算闸约束）');
  assert.deepEqual(discovered, [], '每一拍的非必要读都被跳过');
  assert.deepEqual(stalled, [], '每一拍的非必要读都被跳过');
  const alerts = readAlerts(paths).filter((entry) => entry.kind === 'rate-skip-escalate');
  assert.equal(alerts.length, 1, `连跳 ${ticks} 拍只该有 1 条提醒（原先每拍 2 条）`);
  assert.equal(alerts[0].count, MAX_CONSECUTIVE_SKIPS + 1, '提醒写的是刚跨过阈值时的拍数');
  assert.equal(alerts[0].component, 'loop');
  const state = JSON.parse(fs.readFileSync(paths.rateState, 'utf8'));
  assert.equal(state.skips.byKey['loop:non-essential'].count, ticks, '连跳按拍数（同一拍两个非必要闸只算一拍）');
  const log = fs.readFileSync(paths.loopLog, 'utf8');
  assert.match(log, /rate-skip component=loop identity=user remaining=4000 action=over-budget budget=500 used=506 cost=6 因额度跳过/);
});


test('#247 P3-1 额度闸自己出错（状态文件写不下去）：仍然放行，但心跳和日志都留痕', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const paths = hostPaths(home);
  // 状态文件位置被一个目录占着：写不进去 → rateGate 内部抛错。
  fs.mkdirSync(paths.rateState, { recursive: true });
  const polled = [];
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async (cmd, args) => {
      polled.push(args);
      return { code: 0, stdout: '[]', stderr: '' };
    },
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(polled.length, 1, '判定出错就放行，不把这一拍弄挂');
  assert.match(String(heartbeat.lastTick.rateGateError || ''), /EISDIR|directory|illegal/i, '心跳要能看见闸自己出错');
  assert.match(fs.readFileSync(paths.loopLog, 'utf8'), /rate-unknown .*reason=rate-gate-error/, '日志要留一行可查的痕迹');
});

test('#247 P3-2 poll 遇限流那行日志写真实剩余（poll 已经把响应头记进状态文件）', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const paths = hostPaths(home);
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  writeRateStateFile(paths, { remaining: 37, nowMs });
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    now: () => nowMs,
    run: async () => ({ code: 75, stdout: '', stderr: '触发 GitHub 限流（响应头剩余 37）' }),
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(heartbeat.lastTick.rateSkipped, 'github-rate-limited', '和 rateSkipped 是同一个字段名');
  assert.match(
    fs.readFileSync(paths.loopLog, 'utf8'),
    /rate-skip component=loop identity=user remaining=37 action=github-rate-limited 因额度跳过/,
  );
});

test('#247 P2-6 ensure.sh：180 秒拍、心跳 200 秒（睡眠段+启动）不拉起循环、不写心跳延迟提醒', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const hostCopy = makeHostCopy(home, path.join(home, 'tick.log'));
  const paths = hostPaths(home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  fs.writeFileSync(
    paths.heartbeatFile,
    JSON.stringify({
      at: new Date(nowMs - 200000).toISOString(),
      pid: process.pid,
      tickIntervalS: 180,
      uptimeS: os.uptime() - 200,
      lastTick: { ok: true },
      running: [],
    }),
  );
  const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(nowMs) });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(paths.loopLog), false, '200 秒 < 拍间隔 + 余量：不该拉起循环，也不该记心跳延迟');
  assert.deepEqual(readAlerts(paths), []);
});

// ── #247 P2-B：心跳年龄上限要有上界（写入侧 clamp + 读取侧回落 + ensure.sh 同一把尺） ──

test('#247 P2-B 拍间隔写进心跳前也有上界：ACCEPTANCE_TICK_SECONDS 离谱就落到默认 180 秒', () => {
  assert.equal(TICK_INTERVAL_MAX_SECONDS, 3600);
  for (const [value, expected] of [
    ['1', 1],
    ['60', 60],
    ['180', 180],
    ['3600', 3600],
  ]) {
    assert.equal(tickIntervalSeconds({ ACCEPTANCE_TICK_SECONDS: value }), expected, `合法值 ${value} 照用`);
  }
  for (const value of ['3601', '86400', '180000', '0', '-60', '1.5', 'abc', '']) {
    assert.equal(tickIntervalSeconds({ ACCEPTANCE_TICK_SECONDS: value }), 180, `离谱值 ${JSON.stringify(value)} 回落默认 180 秒`);
  }
});

test('#247 P2-B ensure.sh 与 doctor 用同一把尺：tickIntervalS 只认 1..3600，超出回落 240 秒', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const paths = hostPaths(home);
  const holder = await holdLoopLock(paths);
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  const ageMs = 300000;
  try {
    // 第三列是「300 秒前的心跳在 240 秒口径下算健康还是过期」——按规矩写死，不从实现反推，
    // 这样两边一起改宽（实现 + 期望）也不会假绿。
    const rows = [
      ['缺失', undefined, false],
      ['null', null, false],
      ['0', 0, false],
      ['负数', -60, false],
      ['非整数', 1.5, false],
      ['字符串', '600', false],
      ['下限内 600', 600, true],
      ['上限边界 3600', 3600, true],
      ['上限 + 1', 3601, false],
      ['一天', 86400, false],
    ];
    for (const [label, value, expectedHealthy] of rows) {
      fs.rmSync(paths.alertsFile, { force: true });
      fs.rmSync(paths.loopLog, { force: true });
      const heartbeat = { at: new Date(nowMs - ageMs).toISOString(), pid: holder, lastTick: { ok: true }, running: [] };
      if (value !== undefined) heartbeat.tickIntervalS = value;
      fs.writeFileSync(paths.heartbeatFile, JSON.stringify(heartbeat));
      const result = await runScript(path.join(hostCopy, 'ensure.sh'), home, { ACCEPTANCE_NOW_MS: String(nowMs) });
      assert.equal(result.code, 0, `${label}: ${result.stderr}`);
      const delayed = readAlerts(paths).filter((entry) => entry.kind === 'heartbeat-delayed');
      assert.equal(
        delayed.length,
        expectedHealthy ? 0 : 1,
        `${label}：心跳 ${ageMs} ms，上限要么是拍间隔 + 60 秒、要么回落 240 秒 → ${
          expectedHealthy ? '健康（不该记心跳延迟）' : '过期（该记心跳延迟）'
        }；实际 alerts=${JSON.stringify(readAlerts(paths))}`,
      );
      if (!expectedHealthy) assert.equal(delayed[0].reason, 'delay-300s', label);
      // ensure.sh 与 doctor 必须同一把尺：同一条心跳不能一个绿一个红。
      const doctorHealthy = ageMs <= heartbeatMaxAgeMs({ tickIntervalS: value });
      assert.equal(doctorHealthy, expectedHealthy, `${label}：doctor 的判据要和 ensure.sh 一致`);
      assert.deepEqual(tickLines(tickLog), [], `${label}：pid 活着且锁占着，不许拉起新循环`);
    }
  } finally {
    killQuiet(holder);
  }
});

test('#247 P2-B host/loop 不拿离谱的注入值去 sleep：非法值按默认 180 秒睡', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tickLog = path.join(home, 'tick.log');
  knownTickLogs.add(tickLog);
  const hostCopy = makeHostCopy(home, tickLog);
  const sleepLog = path.join(home, 'sleep.log');
  const bin = path.join(home, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'sleep'), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(sleepLog)}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(hostCopy, 'tick.mjs'), '#!/usr/bin/env node\nsetTimeout(() => {}, 200);\n');

  const loopWith = (seconds) =>
    spawn('sh', [path.join(hostCopy, 'loop')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ACCEPTANCE_WATCHER_HOME: home, ACCEPTANCE_TICK_SECONDS: seconds },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  try {
    for (const [injected, expected] of [
      ['abc', '180'],
      ['180000', '180'],
      // 超过 4 位（超出 shell 整数比较范围，[ -gt ] 会报错并非零退出、原值被留下来）：按长度直接回落。
      ['99999999999999999999', '180'],
      ['000180', '180'],
      ['0', '180'],
      ['7', '7'],
    ]) {
      fs.rmSync(sleepLog, { force: true });
      const child = loopWith(injected);
      spawned.push(child);
      try {
        assert.ok(
          await waitFor(() => readSleeps(sleepLog).length >= 1, 5000),
          `注入 ${injected} 后要睡一拍：${loopLogText(hostPaths(home))}`,
        );
        assert.deepEqual(readSleeps(sleepLog).slice(0, 1), [expected], `注入 ${injected} 时 sleep 参数`);
      } finally {
        killQuiet(child.pid);
        await sleep(100);
      }
    }
  } finally {
    for (const line of tickLines(tickLog)) killQuiet(Number(line.split(':')[1]));
  }
});

// #247 P3-3（复审 rev-247b）：卡住检查这段的限流 catch 之前没有用例——P2-1 的「绕过闸门」那半修了，
// 但只有修正轮发现一侧被验证。这条补上「卡住检查遇限流」这一支。
test('#247 P3-3 卡住检查遇限流：这一拍跳过不写 prbot-tick-failed，只记一行「因额度跳过」', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  hostWithPrbot(home);
  const paths = hostPaths(home);
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  writeRateStateFile(paths, { remaining: 4000, nowMs });
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    now: () => nowMs,
    run: async () => ({ code: 0, stdout: JSON.stringify({ entries: [], tasks: [], reads: 1 }), stderr: '' }),
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async () => [],
    checkPrbotStalled: async () => {
      throw new RateLimitError('触发 GitHub 限流（响应头剩余 0）', { remaining: '0', reset: '1762299600', identity: 'user' });
    },
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(heartbeat.lastTick.ok, true, '限流不算这一拍失败');
  assert.equal(heartbeat.lastTick.prbotError, undefined, '限流不该写成修正轮出错');
  assert.equal(readAlerts(paths).filter((entry) => entry.kind === 'prbot-tick-failed').length, 0);
  assert.deepEqual(heartbeat.lastTick.prbotStalled, [], '跳过就当这一拍没做卡住检查');
  assert.equal(heartbeat.lastTick.rateSkipped, 'github-rate-limited');
  assert.equal(heartbeat.lastTick.rateSkippedStage, 'prbot-stalled', '哪一段跳过写在同一条心跳里');
  assert.match(fs.readFileSync(paths.loopLog, 'utf8'), /rate-skip component=loop identity=user remaining=0 action=github-rate-limited 因额度跳过/);
  const state = JSON.parse(fs.readFileSync(paths.rateState, 'utf8'));
  assert.equal(state.identities.user.remaining, 0, '限流带的响应头也要记下来');
});

// 复审 rev-258 顺手项：tick 侧记限流响应头时只看 `remaining`。只有 reset、没有 remaining 的头块
// （中间代理改写、老版本 gh）不能把已知剩余记成 unknown——那恰好是最需要退避的时刻。
test('#247 限流响应头只有 reset 没有 remaining：不把已知剩余抹成 unknown', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  hostWithPrbot(home);
  const paths = hostPaths(home);
  const nowMs = Date.parse('2026-10-24T02:00:00.000Z');
  // 1200：高于 800，非必要读（修正轮发现）不被响应头闸跳过，才会走到「限流上报的头块只有 reset」这一支。
  writeRateStateFile(paths, { remaining: 1200, nowMs });
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    now: () => nowMs,
    run: async () => ({ code: 0, stdout: JSON.stringify({ entries: [], tasks: [], reads: 1 }), stderr: '' }),
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async () => {
      throw new RateLimitError('触发 GitHub 限流', { remaining: null, reset: '1762299600', identity: 'user' });
    },
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(heartbeat.lastTick.ok, true);
  assert.equal(heartbeat.lastTick.rateSkipped, 'github-rate-limited');
  const state = JSON.parse(fs.readFileSync(paths.rateState, 'utf8'));
  assert.equal(state.identities.user.remaining, 1200, '只有 reset 的头块不许把已知剩余覆盖成 unknown');
  assert.equal(state.identities.user.known, true);
  assert.match(fs.readFileSync(paths.loopLog, 'utf8'), /rate-skip component=loop identity=user remaining=1200 action=github-rate-limited 因额度跳过/);
});
