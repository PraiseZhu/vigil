#!/usr/bin/env node
// 一拍调度（#47 SC12 / SC13）：常驻循环每分钟调一次。
// 1) poll.mjs 在沙箱外跑（只读盘点，可以读 GitHub 令牌），不进 bwrap；2) 卡住的轮次先杀进程再 abort；
// 3) 按空槽起新的 round；4) 写心跳。任何错误都只落进心跳和 alerts.jsonl，绝不抛出循环。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { createGithub } from '../bin/github.mjs';
import { runRound as runRoundCommand } from '../bin/round.mjs';
import { appendAlert, hostPaths, isAlive, readLockPayload } from './paths.mjs';
import { run as procRun, spawnDetached } from './proc.mjs';
import { MAX_ROUNDS } from './round.mjs';

const SLOTS = ['slot-0', 'slot-1'];
const KILL_GRACE_MS = 10000;

function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 读轮次登记目录：<roundsDir>/<owner>__<repo>__<n>.json。坏文件跳过。 */
export function readRegistry(paths) {
  let names = [];
  try {
    names = fs.readdirSync(paths.roundsDir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(paths.roundsDir, name), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.issue) out.push(parsed);
    } catch {
      // 半截文件（正在写）跳过。
    }
  }
  return out;
}

function liveSlotCount(paths) {
  let count = 0;
  for (const name of SLOTS) {
    const lock = readLockPayload(path.join(paths.slotsDir, name));
    if (lock && isAlive(Number(lock.pid))) count += 1;
  }
  return count;
}

async function waitGone(pid, timeoutMs, sleep) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

/** 心跳里的 pid：常驻循环的进程号（loop 是 tick 的父进程），不是这一拍的短命进程。 */
function loopPid(env) {
  const explicit = Number(env?.ACCEPTANCE_LOOP_PID);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  if (Number.isInteger(process.ppid) && process.ppid > 0) return process.ppid;
  return process.pid;
}

function defaultAbort({ home, env, now, root }) {
  return async (argv) => {
    const profile = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
    const hostProfile = {
      ...profile,
      writeCommand: [
        process.execPath,
        path.join(root, 'watchers', 'acceptance', 'host', 'write-gate.mjs'),
        'exec',
        '--home',
        home,
      ],
    };
    const github = createGithub({ profile: hostProfile, run: procRun });
    const out = sink();
    const err = sink();
    const code = await runRoundCommand(argv, { github, profile: hostProfile, now, stdout: out, stderr: err });
    return { code, stdout: out.text, stderr: err.text };
  };
}

function defaultSpawnRound({ home, env, root }) {
  return (issue) => {
    const logFd = fs.openSync(path.join(hostPaths(home).hostDir, 'rounds.log'), 'a');
    try {
      const child = spawnDetached(
        process.execPath,
        [path.join(root, 'watchers', 'acceptance', 'host', 'round.mjs'), '--issue', issue],
        { env: { ...env, ACCEPTANCE_WATCHER_HOME: home }, cwd: home, stdio: ['ignore', logFd, logFd] },
      );
      return child.pid;
    } finally {
      fs.closeSync(logFd);
    }
  };
}

/**
 * 跑一拍。返回写下去的心跳（测试直接断言它，也读文件）。
 * `run` 只用来跑 poll（在沙箱外）；`spawnRound` 起下一轮；`runRound` 用来 abort。
 */
export async function runTick({
  home,
  env = process.env,
  run = procRun,
  spawnRound,
  runRound: runRoundFn,
  now = () => Date.now(),
  sleep = defaultSleep,
  root,
  killGraceMs = KILL_GRACE_MS,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('runTick 需要绝对路径的 home');
  const repoRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const paths = hostPaths(home);
  const abortRound = runRoundFn || defaultAbort({ home, env, now, root: repoRoot });
  const startRound = spawnRound || defaultSpawnRound({ home, env, root: repoRoot });

  const heartbeat = {
    at: new Date(now()).toISOString(),
    pid: loopPid(env),
    lastTick: { ok: true, started: [], stale: [], error: null },
    running: [],
  };

  function writeHeartbeat() {
    const registry = readRegistry(paths);
    heartbeat.running = registry
      .filter((entry) => isAlive(Number(entry.pid)))
      .map((entry) => ({ issue: entry.issue, round: entry.round }));
    writeJsonAtomic(paths.heartbeatFile, heartbeat);
    return heartbeat;
  }

  try {
    fs.mkdirSync(paths.hostDir, { recursive: true, mode: 0o700 });
    const poll = await run('node', [path.join(repoRoot, 'watchers', 'acceptance', 'bin', 'poll.mjs'), '--json'], {
      env: { ...env, ACCEPTANCE_WATCHER_HOME: home },
      timeoutMs: 120000,
    });
    if (!poll || poll.code !== 0) {
      throw new Error(`poll 失败（退出码 ${poll?.code ?? '未知'}）：${String(poll?.stderr || '').trim().split('\n')[0] || ''}`);
    }
    let entries;
    try {
      entries = JSON.parse(poll.stdout || '[]');
    } catch (error) {
      throw new Error(`poll 输出不是 JSON：${error.message}`);
    }
    if (!Array.isArray(entries)) throw new Error('poll 输出不是数组');

    const registry = readRegistry(paths);
    const byIssue = new Map(registry.map((entry) => [entry.issue, entry]));

    // 2. 卡住的轮次：有活进程先杀，等它退出，再 abort。
    for (const entry of entries.filter((item) => item?.stale)) {
      const record = byIssue.get(entry.issue);
      const piPid = Number(record?.piPid);
      let reason = '卡死：进程不在';
      if (isAlive(piPid)) {
        try {
          process.kill(piPid, 'SIGTERM');
        } catch {
          // 已经退了。
        }
        if (!(await waitGone(piPid, killGraceMs, sleep))) {
          try {
            process.kill(piPid, 'SIGKILL');
          } catch {
            // 已经退了。
          }
          await waitGone(piPid, 2000, sleep);
        }
        reason = '卡死：已结束进程';
      }
      const aborted = await abortRound([
        'abort',
        '--issue',
        entry.issue,
        '--round',
        String(entry.round),
        '--reason',
        reason,
      ]);
      appendAlert(paths, {
        kind: 'round-stale',
        issue: entry.issue,
        round: entry.round,
        reason,
        detail: aborted?.code && aborted.code !== 0 ? String(aborted.stderr || '').trim() : undefined,
        now,
      });
      heartbeat.lastTick.stale.push({ issue: entry.issue, round: entry.round, reason });
    }

    // 3. 该开始的任务：已在跑的不重开，最多占到空槽数。
    let free = Math.max(0, MAX_ROUNDS - liveSlotCount(paths));
    for (const entry of entries.filter((item) => item && !item.stale)) {
      if (free <= 0) break;
      const record = byIssue.get(entry.issue);
      if (record && isAlive(Number(record.pid))) continue;
      const pid = startRound(entry.issue);
      heartbeat.lastTick.started.push({ issue: entry.issue, pid: pid ?? null });
      free -= 1;
    }
  } catch (error) {
    heartbeat.lastTick.ok = false;
    heartbeat.lastTick.error = String(error?.message || error);
    try {
      appendAlert(paths, {
        kind: 'tick-failed',
        reason: '这一拍出错',
        detail: String(error?.message || error),
        now,
      });
    } catch {
      // 提醒也写不下去就只留心跳。
    }
  }

  try {
    return writeHeartbeat();
  } catch {
    return heartbeat;
  }
}

async function main() {
  const home = process.env.ACCEPTANCE_WATCHER_HOME;
  if (!home) {
    process.stderr.write('需要 ACCEPTANCE_WATCHER_HOME\n');
    process.exitCode = 1;
    return;
  }
  const heartbeat = await runTick({ home, env: process.env });
  if (!heartbeat.lastTick.ok) process.stderr.write(`这一拍出错：${heartbeat.lastTick.error}\n`);
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main();
}
