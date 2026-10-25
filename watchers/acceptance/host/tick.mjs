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
import { appendAlert, hostPaths, isAlive, readAlerts, readLockPayload } from './paths.mjs';
import { run as procRun, spawnDetached } from './proc.mjs';
import { MAX_ROUNDS, readHostConfig } from './round.mjs';
import { checkReadyStalled, cleanupWorktrees, discoverCorrections } from './prbot.mjs';
import { NOTIFY_BUDGET_MS, notifySlack } from './slack-notify.mjs';

const SLOTS = ['slot-0', 'slot-1'];
const KILL_GRACE_MS = 10000;

/**
 * Slack 通知这一拍最多等多久（#70 复审）。slack-notify 自己有 NOTIFY_BUDGET_MS 的总预算、到点就停；
 * 这里再兜一层：超过 NOTIFY_WAIT_MS 不等了，心跳写 notify-timeout。上一拍的通知还没结束时这一拍不再起新的
 * （notify-busy），免得两份同时写账本、重发。
 */
export const NOTIFY_WAIT_MS = NOTIFY_BUDGET_MS + 5000;
let inflightNotify = null;

async function boundedNotify(fn, options, waitMs) {
  if (inflightNotify) return { ok: false, reason: 'notify-busy' };
  const pending = Promise.resolve().then(() => fn(options));
  inflightNotify = pending;
  pending
    .finally(() => {
      if (inflightNotify === pending) inflightNotify = null;
    })
    .catch(() => {});
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'notify-timeout' }), waitMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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

/** Slack 通知的结果（#61）统一成心跳里的形状，缺字段补 0 / 空数组。 */
function slackHeartbeat(result) {
  const value = result && typeof result === 'object' ? result : {};
  const out = {
    ok: value.ok === true,
    sent: Number(value.sent) || 0,
    digested: Number(value.digested) || 0,
    pending: Number(value.pending) || 0,
    deferred: Number(value.deferred) || 0,
    failed: Array.isArray(value.failed) ? value.failed : [],
  };
  if (value.reason) out.reason = String(value.reason);
  if (value.error) out.error = String(value.error);
  return out;
}

/** poll 报的 outOfScope / passedButOpen 提醒节流：同一任务同一种提醒 24 小时只写一次。 */
export const POLL_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * poll 报的两种「不派发、只提醒」条目（#46 / #47 首跑）：任务树里有名单外的仓（outOfScope）、
 * 最新裁决是通过但 issue 还开着（passedButOpen）。按 alerts.jsonl 里已有的同类提醒节流。返回这一拍新写的。
 */
export function remindPollNotices(paths, entries, { now = () => Date.now() } = {}) {
  const notices = (entries || []).filter((item) => item && !item.stale && (item.outOfScope || item.passedButOpen));
  if (!notices.length) return [];
  const recent = readAlerts(paths);
  const written = [];
  for (const entry of notices) {
    const kind = entry.outOfScope ? 'task-out-of-scope' : 'passed-but-open';
    const seen = recent.some(
      (alert) => alert.kind === kind && alert.issue === entry.issue && now() - Date.parse(alert.ts || 0) < POLL_NOTICE_WINDOW_MS,
    );
    if (seen) continue;
    const alert = entry.outOfScope
      ? {
          kind,
          issue: entry.issue,
          reason: '任务树里有不在任何名单里的仓，不派发',
          detail: (entry.outOfScope || []).join(', '),
        }
      : { kind, issue: entry.issue, round: entry.round, reason: '最新裁决是通过，issue 还开着（关单没走完）', detail: entry.url || undefined };
    written.push(appendAlert(paths, { ...alert, now }));
  }
  return written;
}

/** 读轮次登记目录：<roundsDir>/<owner>__<repo>__<issue 号>__<n>.json。坏文件跳过。 */
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

function defaultSpawnPrbot({ home, env, root }) {
  return (issue) => {
    const logFd = fs.openSync(path.join(hostPaths(home).hostDir, 'prbot.log'), 'a');
    try {
      const child = spawnDetached(
        process.execPath,
        [path.join(root, 'watchers', 'acceptance', 'host', 'prbot.mjs'), 'run', '--issue', issue],
        { env: { ...env, ACCEPTANCE_WATCHER_HOME: home }, cwd: home, stdio: ['ignore', logFd, logFd] },
      );
      return child.pid;
    } finally {
      fs.closeSync(logFd);
    }
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
  spawnPrbot,
  discoverPrbot,
  checkPrbotStalled,
  cleanupPrbot,
  now = () => Date.now(),
  sleep = defaultSleep,
  root,
  killGraceMs = KILL_GRACE_MS,
  notify = notifySlack,
  notifyOptions = {},
  notifyWaitMs = NOTIFY_WAIT_MS,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('runTick 需要绝对路径的 home');
  const repoRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const paths = hostPaths(home);
  const abortRound = runRoundFn || defaultAbort({ home, env, now, root: repoRoot });
  const startRound = spawnRound || defaultSpawnRound({ home, env, root: repoRoot });
  const startPrbot = spawnPrbot || defaultSpawnPrbot({ home, env, root: repoRoot });

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


    // 3b. 修正轮（#60）：只在 host.json 配了 prbot 时跑，失败不拖垮验收拍。
    let prbotSettings = null;
    try {
      const settings = readHostConfig(paths.hostConfig);
      if (settings.prbot) prbotSettings = settings;
    } catch (error) {
      heartbeat.lastTick.prbotError = String(error?.message || error);
    }
    if (prbotSettings) {
      heartbeat.lastTick.prbotStarted = [];
      heartbeat.lastTick.prbotStalled = [];
      heartbeat.lastTick.prbotCleaned = [];
      try {
        const prbotProfile = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
        const prbotGithub = createGithub({ profile: { ...prbotProfile, writeCommand: undefined }, run });
        const discover = discoverPrbot || ((options) => discoverCorrections({ ...options, github: prbotGithub, profile: prbotProfile }));
        const found = await discover({ now, home });
        for (const entry of found || []) {
          const lockFile = path.join(paths.prbotLocksDir, `${entry.issue.replace(/[^\w.-]+/g, '__')}.lock`);
          const held = readLockPayload(lockFile);
          if (held && isAlive(Number(held.pid))) continue;
          const pid = startPrbot(entry.issue);
          heartbeat.lastTick.prbotStarted.push({ issue: entry.issue, pid: pid ?? null });
        }
        const checkStalled = checkPrbotStalled || ((options) => checkReadyStalled({ ...options, github: prbotGithub, profile: prbotProfile }));
        const stalled = await checkStalled({ home, now, reviewCheckPattern: prbotSettings.reviewCheckPattern });
        heartbeat.lastTick.prbotStalled = (stalled || []).map((entry) => ({ issue: entry.issue, pr: entry.pr }));
        const clean = cleanupPrbot || ((options) => cleanupWorktrees({ ...options, profile: prbotProfile }));
        heartbeat.lastTick.prbotCleaned = clean({ home }) || [];
      } catch (error) {
        heartbeat.lastTick.prbotError = String(error?.message || error);
        try {
          appendAlert(paths, { kind: 'prbot-tick-failed', reason: '修正轮这一拍出错', detail: String(error?.message || error), now });
        } catch {
          // 提醒写不下去就只留心跳。
        }
      }
    }

    // 2b. 不派发、只提醒的条目（outOfScope / passedButOpen）：写提醒（节流），出错不拖垮这一拍。
    try {
      remindPollNotices(paths, entries, { now });
    } catch (error) {
      heartbeat.lastTick.noticeError = String(error?.message || error);
    }

    // 3. 该开始的任务：已在跑的不重开，最多占到空槽数。
    let free = Math.max(0, MAX_ROUNDS - liveSlotCount(paths));
    for (const entry of entries.filter((item) => item && !item.stale && !item.outOfScope && !item.passedButOpen)) {
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

  // 4. Slack 通知（#61）：放在验收调度之后（#70 复审：Slack 卡住不能拖慢验收），这一拍新写的提醒也一起发。
  //    总时长有上限（boundedNotify），整个调用 try/catch：出错只进心跳，绝不影响这一拍。
  try {
    heartbeat.slack = slackHeartbeat(
      await boundedNotify(notify, { home, env: { ...env, ACCEPTANCE_WATCHER_HOME: home }, now, ...notifyOptions }, notifyWaitMs),
    );
  } catch (error) {
    // 异常文字不进心跳（万一里面带了请求头之类的东西），只记原因。
    heartbeat.slack = slackHeartbeat({ ok: false, reason: 'notify-error', error: String(error?.name || 'unknown') });
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
