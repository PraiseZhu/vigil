#!/usr/bin/env node
// 宿主状态文件的位置和锁（#47）：路径只在这里拼，锁只在这里拿。
// 锁文件用 O_EXCL 建，内容 {pid, startedAt}；pid 不在（kill(pid,0) 报 ESRCH）就算陈旧，删掉重来。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../bin/redact.mjs';

/** home 下所有宿主文件的位置。`home` 是验收机的 home（ACCEPTANCE_WATCHER_HOME）。 */
export function hostPaths(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) {
    throw new Error('hostPaths 需要绝对路径的 home');
  }
  const stateRoot = path.join(home, 'state');
  const gateDir = path.join(stateRoot, 'write-gate');
  const hostDir = path.join(stateRoot, 'host');
  return {
    home,
    stateRoot,
    gateDir,
    enabledFile: path.join(gateDir, 'enabled'),
    ledgerFile: path.join(gateDir, 'ledger.jsonl'),
    execLock: path.join(gateDir, 'exec.lock'),
    hostDir,
    alertsFile: path.join(hostDir, 'alerts.jsonl'),
    heartbeatFile: path.join(hostDir, 'heartbeat.json'),
    loopLock: path.join(hostDir, 'loop.lock'),
    roundsDir: path.join(hostDir, 'rounds'),
    slotsDir: path.join(hostDir, 'slots'),
    testLock: path.join(hostDir, 'locks', 'mivo-test.lock'),
    hostConfig: path.join(home, 'config', 'host.json'),
    loopLog: path.join(hostDir, 'loop.log'),
    roundRunDir: path.join(home, 'run'),
  };
}

/** 进程还活着吗。EPERM 表示进程在、只是不是我的，也算活。 */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 锁读不出内容时按「被占用」处理（fail-closed），不让两个进程同时进。 */
function clearStaleLock(file) {
  const lock = readLock(file);
  if (lock && isAlive(Number(lock.pid))) return false;
  if (!lock) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** 试一次拿锁：拿到返回 true；被活进程占着返回 false。 */
export function tryAcquireLock(file, { now = () => Date.now() } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date(now()).toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!clearStaleLock(file)) return false;
    }
  }
  return false;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等锁：最多等 waitMs（写闸执行锁用 30 秒）。等不到返回 false，调用方回 75。 */
export async function acquireLock(
  file,
  { now = () => Date.now(), waitMs = 0, sleep = defaultSleep, pollMs = 50 } = {},
) {
  const deadline = now() + Math.max(0, waitMs);
  for (;;) {
    if (tryAcquireLock(file, { now })) return true;
    const left = deadline - now();
    if (left <= 0) return false;
    await sleep(Math.min(pollMs, left));
  }
}

export function releaseLock(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 锁不在了就算释放。
  }
}

export function readLockPayload(file) {
  return readLock(file);
}

/**
 * 追加一条提醒（一行一条 JSON）。只写进本机的 alerts.jsonl，不调任何外发服务。
 * reason/detail 一律过 bin/redact.mjs，令牌、私钥、本机路径不会落进提醒文件。
 */
export function appendAlert(
  paths,
  { kind, issue, round, reason, detail, now = () => Date.now(), profile, ...rest } = {},
) {
  if (typeof kind !== 'string' || !kind) throw new Error('appendAlert 需要 kind');
  const entry = { ts: new Date(now()).toISOString(), kind };
  if (issue) entry.issue = String(issue);
  if (round !== undefined && round !== null) entry.round = Number(round);
  entry.reason = redact(String(reason ?? ''), profile);
  if (detail !== undefined && detail !== null && String(detail) !== '') {
    entry.detail = redact(String(detail), profile);
  }
  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined || value === null) continue;
    entry[key] = typeof value === 'string' ? redact(value, profile) : value;
  }
  fs.mkdirSync(path.dirname(paths.alertsFile), { recursive: true, mode: 0o700 });
  fs.appendFileSync(paths.alertsFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  return entry;
}

/** 读回提醒（测试和运维查看用）。坏行跳过，不抛错。 */
export function readAlerts(paths) {
  let text;
  try {
    text = fs.readFileSync(paths.alertsFile, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // 提醒文件坏一行不影响别的行。
    }
  }
  return out;
}

/** CLI：只给 shell 脚本用 `node paths.mjs alert <kind> <reason>`（ensure.sh 写 loop-restarted）。 */
async function main(argv) {
  const [command, kind, reason] = argv;
  if (command !== 'alert' || !kind) {
    process.stderr.write('用法：ACCEPTANCE_WATCHER_HOME=<home> node host/paths.mjs alert <kind> [reason]\n');
    process.exitCode = 1;
    return;
  }
  const home = process.env.ACCEPTANCE_WATCHER_HOME;
  if (!home) {
    process.stderr.write('需要 ACCEPTANCE_WATCHER_HOME\n');
    process.exitCode = 1;
    return;
  }
  const nowMs = Number(process.env.ACCEPTANCE_NOW_MS);
  appendAlert(hostPaths(home), {
    kind,
    reason: reason || '',
    now: Number.isFinite(nowMs) && nowMs > 0 ? () => nowMs : undefined,
  });
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
