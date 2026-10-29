// #47 SC12：常驻循环的 contract 测试。真跑 host/loop（tick 换成假的），真跑 host/ensure.sh。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

test('ensure.sh：心跳过期但原循环进程还在、锁还占着 → 只记「心跳延迟」，不补起新循环、不发 loop-restarted', async () => {
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

test('ensure.sh：心跳过期且原循环进程已不在 → 照常拉起并发 loop-restarted(heartbeat-stale)', async () => {
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

test('ensure.sh：心跳过期、pid 碰巧活着但锁没人占（pid 被别的进程复用）→ 保守起见照常拉起', async () => {
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

test('部署重启：stop.sh 留标记 → ensure.sh 拉起时记 loop-deploy-restarted（不是 loop-restarted），标记用完即删；新循环起来也清标记', async () => {
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

test('部署重启：标记超过 2 小时就不算，按意外重启发 loop-restarted 并删掉旧标记', async () => {
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

test('SC12 停掉 loop 后，残留的子进程（在跑的轮次、sleep）不占单实例锁：ensure.sh 马上能拉起新循环', async () => {
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

test('#T9 ensure.sh：墙钟过期 2000 秒、uptime 只差 30 秒、pid 活着锁占着 → 记 host-frozen，不补起', async () => {
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

test('#T9 ensure.sh：不设 ACCEPTANCE_UPTIME_S 时用机器真实 uptime 判冻结（正式部署走这条）', async () => {
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

test('#T9 ensure.sh：墙钟过期 2000 秒、uptime 也差 2000 秒（真慢）、pid 活着锁占着 → 仍是 heartbeat-delayed', async () => {
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

test('#T9 ensure.sh：墙钟过期 2000 秒、uptime 差 30 秒、pid 已死 → 拉起并记 heartbeat-stale-after-freeze', async () => {
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

test('#T9 ensure.sh：旧心跳没有 uptimeS、pid 已死 → 仍是 loop-restarted(heartbeat-stale)', async () => {
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

test('#T9 loop 收到 SIGTERM：2 秒内 loop.log 记下退出，锁立刻释放，ensure.sh 能拉起新循环', async () => {
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
    // 写闸账本旁路审计（空账本：建基线，不报）：这一拍核对了 0 行、没有新拿不准。
    gateAudit: { checked: 0, found: 0, sinceBaseline: 0, uncertain: 0 },
  });
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
