// #47 SC12：常驻循环的 contract 测试。真跑 host/loop（tick 换成假的），真跑 host/ensure.sh。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hostPaths, isAlive, readAlerts } from './host/paths.mjs';
import { runTick } from './host/tick.mjs';
import { tmpDir, writeProfile } from './fake-gh.fixture.mjs';

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
  // 整个 watchers/acceptance 拷一份（host/ 里的模块 import ../bin/*，只拷 host/ 会断）。
  const root = tmpDir('acceptance-host-copy-');
  fs.cpSync(HERE, path.join(root, 'acceptance'), { recursive: true });
  const dir = path.join(root, 'acceptance', 'host');
  fs.writeFileSync(
    path.join(dir, 'tick.mjs'),
    `#!/usr/bin/env node
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
setTimeout(() => process.exit(0), 3000);
`,
  );
  return dir;
}

function startLoop(hostCopy, home, tickSeconds = '1') {
  const child = spawn('sh', [path.join(hostCopy, 'loop')], {
    env: { ...process.env, ACCEPTANCE_WATCHER_HOME: home, ACCEPTANCE_TICK_SECONDS: tickSeconds },
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

test('SC12 loop 是单实例：第二个实例拿不到 flock 就退出，不跑 tick', async () => {
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

test('SC12 ensure.sh：心跳过期的拉起循环并写一条提醒；连跑两次也只有一个循环', async () => {
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

test('SC12 tick 写心跳：时间、pid、上一拍结果、在跑的轮次', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(heartbeat.at, '2026-10-24T02:00:00.000Z');
  assert.ok(Number.isInteger(heartbeat.pid));
  assert.deepEqual(heartbeat.lastTick, { ok: true, started: [], stale: [], error: null });
  assert.deepEqual(heartbeat.running, []);
  const onDisk = JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
  assert.equal(onDisk.at, heartbeat.at);
  assert.equal(onDisk.pid, heartbeat.pid);
  assert.deepEqual(onDisk.lastTick, heartbeat.lastTick);
  assert.deepEqual(onDisk.running, []);
});
