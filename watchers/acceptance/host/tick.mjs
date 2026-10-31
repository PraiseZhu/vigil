#!/usr/bin/env node
// 一拍调度（#47 SC12 / SC13）：常驻循环每分钟调一次。
// 1) poll.mjs 在沙箱外跑（只读盘点，可以读 GitHub 令牌），不进 bwrap；2) 卡住的轮次先杀进程再 abort；
// 3) 按空槽起新的 round；4) 写心跳。任何错误都只落进心跳和 alerts.jsonl，绝不抛出循环。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { createGithub } from '../bin/github.mjs';
import { runRound as runRoundCommand } from '../bin/round.mjs';
import { appendAlert, hostPaths, isAlive, readAlerts, readLockPayload } from './paths.mjs';
import { run as procRun, spawnBackground } from './proc.mjs';
import { MAX_ROUNDS, readHostConfig, serialLockFiles } from './round.mjs';
import { checkReadyStalled, cleanupWorktrees, discoverCorrections } from './prbot.mjs';
import { NOTIFY_BUDGET_MS, notifySlack } from './slack-notify.mjs';
import { defaultSpawnAdjudicate, scheduleAdjudications } from './adjudicate.mjs';
import { runGateAudit } from './gate-audit.mjs';
import { POLL_BEAT_MS, startTickBeat } from './poll-beat.mjs';
import { isReadOnlyGraphql } from '../bin/github.mjs';

/**
 * 这一拍里单次读 GitHub 的超时（T20 定 120 秒，T23 降到 45 秒）。正常一次读不到 1 秒；挂住的读是平台快照恢复后
 * 连接半死（对端不回也不断），等多久都不会回来，所以早掐、用新进程重试一次更划算。
 * 总耗时上限：(45 + 5 兜底) × 2 次 = 100 秒 < 体检 180 秒。超时退出码 124、没有「瞬时故障」字样，
 * github.mjs 自己的读重试（只认 502/503/504、连接重置等）不会再叠一层。
 */
export const TICK_READ_TIMEOUT_MS = 45000;

/**
 * 拉取（poll.mjs 整盘点）的单次超时（T23）：60 秒。实测正常一次约 7 秒（2026-10-31 连跑 3 次共 21 秒），
 * 60 秒约 8 倍余量；挂住时整组杀掉（poll 的 node 和它起的 gh 一起）、重试一次。
 * 总耗时上限：(60 + 2 SIGKILL 宽限) × 2 次 = 124 秒 < 体检 180 秒。
 */
export const POLL_TIMEOUT_MS = 60000;

const RETRIED = '（已重试一次）';

/** gh 这条命令是不是只读：只读 GraphQL 查询，或 gh api 不带 -X / -X GET。拿不准一律当写，不加超时。 */
function isGhRead(cmd, args, opts) {
  if (cmd !== 'gh' || !Array.isArray(args) || args[0] !== 'api') return false;
  if (args[1] === 'graphql') {
    try {
      return isReadOnlyGraphql(JSON.parse(String(opts?.input ?? '')).query);
    } catch {
      return false;
    }
  }
  const x = args.indexOf('-X');
  const method = x >= 0 ? String(args[x + 1] || '').toUpperCase() : 'GET';
  return method === 'GET' && !args.includes('--input');
}

/**
 * 给传进 createGithub 的 run 包一层（T20 / T23）：只给读加超时，写（含经写闸的）原样放过、不加超时、不重试。
 * 读超时（退出码 124）时：proc.run 已对整个进程组 SIGTERM、2 秒后 SIGKILL（killGroup，不留 gh 孤儿），
 * 再用新进程（新连接）重试一次；重试也超时才按读失败收尾，文字注明已重试一次。读是幂等的，重试不会多写任何东西。
 * 再兜一层计时：run 自己不认超时时也按 124 收尾。onRead 在每次读（含重试）开始时调用（刷新心跳阶段）。
 */
export function withReadTimeout(run, timeoutMs = TICK_READ_TIMEOUT_MS, { onRead } = {}) {
  const message = () => `读 GitHub 超过 ${Math.round(timeoutMs / 1000)} 秒没返回，已掐掉（exit 124）`;
  const once = async (cmd, args, opts) => {
    try {
      onRead?.();
    } catch {
      // 心跳刷新失败不影响读。
    }
    let timer;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ code: 124, stdout: '', stderr: message() }), timeoutMs + Math.min(5000, timeoutMs));
      // 不 unref：兜底计时本身要撑住这一拍，读真挂住时也一定按时以读失败收尾（finally 里会清掉）。
    });
    try {
      const result = await Promise.race([Promise.resolve(run(cmd, args, { ...opts, timeoutMs, killGroup: true })), guard]);
      if (result && result.code === 124 && !String(result.stderr || '').trim()) return { ...result, stderr: message() };
      return result;
    } finally {
      clearTimeout(timer);
    }
  };
  return async (cmd, args, opts = {}) => {
    if (!isGhRead(cmd, args, opts) || Number(opts?.timeoutMs) > 0) return run(cmd, args, opts);
    const first = await once(cmd, args, opts);
    if (!first || first.code !== 124) return first;
    const second = await once(cmd, args, opts);
    if (second && second.code === 124) return { ...second, stderr: `${String(second.stderr || '').trim()}${RETRIED}` };
    return second;
  };
}

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
  // 没配 slackChannelId = Slack 通报已关闭（告警只写 alerts.jsonl），是正常状态，不算失败。
  const disabled = value.reason === 'not-configured';
  const out = {
    ok: value.ok === true || disabled,
    sent: Number(value.sent) || 0,
    digested: Number(value.digested) || 0,
    pending: Number(value.pending) || 0,
    deferred: Number(value.deferred) || 0,
    failed: Array.isArray(value.failed) ? value.failed : [],
  };
  if (value.reason) out.reason = String(value.reason);
  if (value.error) out.error = String(value.error);
  if (Number(value.capped) > 0) out.capped = Number(value.capped);
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

/** 上一拍心跳里的 Slack 失败标记（发送重试用完）：这一拍没读到账本时原样留着，直到下一次发送成功才清。 */
function previousSlackFailing(paths) {
  try {
    const previous = JSON.parse(fs.readFileSync(paths.heartbeatFile, 'utf8'));
    return previous?.slackFailing && typeof previous.slackFailing === 'object' ? previous.slackFailing : null;
  } catch {
    return null;
  }
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
      const child = spawnBackground(
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
      const child = spawnBackground(
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
  spawnAdjudicate,
  discoverPrbot,
  checkPrbotStalled,
  cleanupPrbot,
  now = () => Date.now(),
  uptime = () => os.uptime(),
  sleep = defaultSleep,
  root,
  killGraceMs = KILL_GRACE_MS,
  notify = notifySlack,
  notifyOptions = {},
  notifyWaitMs = NOTIFY_WAIT_MS,
  gateAudit = (options) => runGateAudit(options),
  pollBeatMs = POLL_BEAT_MS,
  prbotReadTimeoutMs = TICK_READ_TIMEOUT_MS,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('runTick 需要绝对路径的 home');
  const repoRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const paths = hostPaths(home);
  const abortRound = runRoundFn || defaultAbort({ home, env, now, root: repoRoot });
  const startRound = spawnRound || defaultSpawnRound({ home, env, root: repoRoot });
  const startPrbot = spawnPrbot || defaultSpawnPrbot({ home, env, root: repoRoot });
  const startAdjudicate = spawnAdjudicate || defaultSpawnAdjudicate({ home, env, root: repoRoot });

  const heartbeat = {
    at: new Date(now()).toISOString(),
    pid: loopPid(env),
    uptimeS: uptime(),
    lastTick: { ok: true, started: [], stale: [], error: null },
    running: [],
  };

  function aliveRunning() {
    return readRegistry(paths)
      .filter((entry) => isAlive(Number(entry.pid)))
      .map((entry) => ({ issue: entry.issue, round: entry.round }));
  }

  function writeHeartbeat() {
    heartbeat.running = aliveRunning();
    // 拍尾心跳的时间取写入时刻（T18）：拉取期间已经刷新过更晚的时间，拍尾不能倒回拍头。
    heartbeat.at = new Date(now()).toISOString();
    heartbeat.uptimeS = uptime();
    writeJsonAtomic(paths.heartbeatFile, heartbeat);
    return heartbeat;
  }

  /**
   * 拍中心跳（T18 拉取期间，T20 扩到整拍）：沿用上一拍心跳（上一拍结果、Slack 状态），只刷新时间/pid/在跑轮次，
   * 并带上当前阶段 phase；拉取阶段另带旧字段 polling（兼容旧体检），其它阶段把残留的 polling 去掉。
   */
  function phaseBeat(phase) {
    let previous = {};
    try {
      previous = JSON.parse(fs.readFileSync(paths.heartbeatFile, 'utf8')) || {};
    } catch {
      previous = {};
    }
    const { polling: _oldPolling, phase: _oldPhase, ...rest } = previous;
    const out = {
      ...rest,
      at: new Date(now()).toISOString(),
      pid: heartbeat.pid,
      uptimeS: uptime(),
      gate: heartbeat.gate,
      running: aliveRunning(),
      phase,
    };
    if (phase?.name === 'poll') {
      const { name: _name, ...polling } = phase;
      out.polling = polling;
    }
    return out;
  }

  const tickBeat = startTickBeat({
    now,
    uptime,
    beatMs: pollBeatMs,
    buildBeat: phaseBeat,
    write: (beat) => writeJsonAtomic(paths.heartbeatFile, beat),
  });

  try {
    fs.mkdirSync(paths.hostDir, { recursive: true, mode: 0o700 });
    // 写闸总开关（#47 SC11）：关着时不起新轮次、不 abort（abort 也是写，必被拒），只在心跳里记一笔，
    // 不写 write-rejected 提醒（只读期每拍都会碰到，写提醒就是刷屏）。
    const gateEnabled = fs.existsSync(paths.enabledFile);
    heartbeat.gate = gateEnabled ? 'enabled' : 'disabled';
    tickBeat.setPhase('poll');
    // T23：拉取是只读盘点。超时（124）时 proc.run 整组杀掉 poll 和它起的 gh（不留孤儿），再用新进程重试一次；
    // 重试成功不写提醒，重试也超时才按这一拍失败处理。其余失败（非 124）不重试，照旧。
    const pollOnce = () =>
      run('node', [path.join(repoRoot, 'watchers', 'acceptance', 'bin', 'poll.mjs'), '--json'], {
        env: { ...env, ACCEPTANCE_WATCHER_HOME: home },
        timeoutMs: POLL_TIMEOUT_MS,
        killGroup: true,
      });
    let poll = await pollOnce();
    let pollRetried = false;
    if (poll && poll.code === 124) {
      pollRetried = true;
      poll = await pollOnce();
    }
    if (!poll || poll.code !== 0) {
      throw new Error(
        `poll 失败（退出码 ${poll?.code ?? '未知'}）${pollRetried ? RETRIED : ''}：${String(poll?.stderr || '').trim().split('\n')[0] || ''}`,
      );
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

    // 同仓最多 1 轮的锁（mivo 测试锁 + host.json serialRepos）：锁被活着的轮次占着的仓，这一拍不起它的验收轮
    // （起了也只会在认领前退出 3，白占这一拍的空槽）。host.json 读不了 / 名单写错：这里按「只有 mivo」算，
    // round.mjs 自己会在认领前报错、不认领。
    let tickHostConfig = {};
    try {
      tickHostConfig = readHostConfig(paths.hostConfig);
      serialLockFiles(paths, [], tickHostConfig);
    } catch {
      tickHostConfig = {};
    }
    const lockFilesFor = (issue) => {
      try {
        return serialLockFiles(paths, [String(issue || '').split('#')[0]], tickHostConfig);
      } catch {
        return [];
      }
    };
    const lockHeld = (file) => {
      const held = readLockPayload(file);
      return Boolean(held && isAlive(Number(held.pid)));
    };

    // 2. 卡住的轮次（poll 按宿主侧进度时间判定）：有活进程先杀，等它退出，再 abort。
    const staleEntries = entries.filter((item) => item?.stale);
    if (staleEntries.length > 0) tickBeat.setPhase('abort');
    for (const entry of staleEntries) {
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
      if (!gateEnabled) {
        heartbeat.lastTick.stale.push({ issue: entry.issue, round: entry.round, reason, aborted: false });
        continue;
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
      tickBeat.setPhase('prbot');
      heartbeat.lastTick.prbotStarted = [];
      heartbeat.lastTick.prbotStalled = [];
      heartbeat.lastTick.prbotCleaned = [];
      try {
        const prbotProfile = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
        // T20：这一段读 GitHub 原先没有超时，对端不回包时整拍挂住（2026-10-30 卡了约 14 分钟）。只给读加超时，
        // 每次读开始重新记阶段时长（T23：一次读最多约 50 秒，连同重试最多约 100 秒，远小于 180 秒上限）。
        const prbotRun = withReadTimeout(run, prbotReadTimeoutMs, { onRead: () => tickBeat.setPhase('prbot') });
        const prbotGithub = createGithub({ profile: { ...prbotProfile, writeCommand: undefined }, run: prbotRun });
        const discover =
          discoverPrbot || ((options) => discoverCorrections({ ...options, github: prbotGithub, profile: prbotProfile, hostConfig: prbotSettings }));
        const found = await discover({ now, home, github: prbotGithub });
        // 修正轮和验收轮共用 2 个槽：先给这一拍该开始的验收轮留位（同仓锁被占、起不来的 mivo / serialRepos 验收轮不算），剩下的才给修正轮。
        const pendingAcceptance = entries.filter((item) => {
          if (!item || item.stale) return false;
          const record = byIssue.get(item.issue);
          if (record && isAlive(Number(record.pid))) return false;
          return !lockFilesFor(item.issue).some(lockHeld);
        }).length;
        // 写闸总开关关着：修正轮的写（推分支、开 PR、写评论）同样全被拒，起了只会白跑、白耗重试次数，所以也不起。
        let prbotFree = gateEnabled ? Math.max(0, MAX_ROUNDS - liveSlotCount(paths) - pendingAcceptance) : 0;
        for (const entry of found || []) {
          const lockFile = path.join(paths.prbotLocksDir, `${entry.issue.replace(/[^\w.-]+/g, '__')}.lock`);
          const held = readLockPayload(lockFile);
          if (held && isAlive(Number(held.pid))) continue;
          if (prbotFree <= 0) break;
          prbotFree -= 1;
          const pid = startPrbot(entry.issue);
          heartbeat.lastTick.prbotStarted.push({ issue: entry.issue, pid: pid ?? null });
        }
        const checkStalled = checkPrbotStalled || ((options) => checkReadyStalled({ ...options, github: prbotGithub, profile: prbotProfile }));
        const stalled = await checkStalled({ home, now, github: prbotGithub, reviewCheckPattern: prbotSettings.reviewCheckPattern });
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

    tickBeat.setPhase('dispatch');
    // 2b. 不派发、只提醒的条目（outOfScope / passedButOpen）：写提醒（节流），出错不拖垮这一拍。
    try {
      remindPollNotices(paths, entries, { now });
    } catch (error) {
      heartbeat.lastTick.noticeError = String(error?.message || error);
    }

    // 3. 该开始的任务：已在跑的不重开，最多占到空槽数；总开关关着就一个都不起。
    //    同仓最多 1 轮的仓：锁被占着、或这一拍已经给同一把锁起过一轮的，记进 serialWaiting，等锁放了再起（不认领、不写提醒）。
    let free = gateEnabled ? Math.max(0, MAX_ROUNDS - liveSlotCount(paths)) : 0;
    const serialWaiting = [];
    const claimedThisTick = new Set();
    for (const entry of entries.filter((item) => item && !item.stale && !item.outOfScope && !item.passedButOpen && !item.adjudicate)) {
      if (free <= 0) break;
      const record = byIssue.get(entry.issue);
      if (record && isAlive(Number(record.pid))) continue;
      const lockFiles = lockFilesFor(entry.issue);
      if (lockFiles.some((file) => claimedThisTick.has(file) || lockHeld(file))) {
        serialWaiting.push({ issue: entry.issue });
        continue;
      }
      for (const file of lockFiles) claimedThisTick.add(file);
      const pid = startRound(entry.issue);
      heartbeat.lastTick.started.push({ issue: entry.issue, pid: pid ?? null });
      free -= 1;
    }
    // 只在有 issue 等同仓锁时才写进心跳（心跳的形状平时不变）。
    if (serialWaiting.length > 0) heartbeat.lastTick.serialWaiting = serialWaiting;

    // 3c. 有争议、等裁决（#46 SC8）：剩下的空槽给只读裁决运行；出错不拖垮这一拍。
    if (entries.some((item) => item?.adjudicate)) {
      try {
        const scheduled = scheduleAdjudications({
          home,
          entries,
          hostConfig: readHostConfig(paths.hostConfig),
          spawn: startAdjudicate,
          now,
          free,
        });
        free = scheduled.free;
        heartbeat.lastTick.adjudicate = { started: scheduled.started, skipped: scheduled.skipped };
      } catch (error) {
        heartbeat.lastTick.adjudicateError = String(error?.message || error);
      }
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

  // 3d. 写闸账本旁路审计：只读本地账本，不查 GitHub（每拍都查 GitHub 就太重了，doctor / 命令行才查）。
  //     放在 Slack 通知之前：这一拍新发现的违规提醒同一拍就发出去。单独 try/catch：出错只进心跳，
  //     绝不让这一拍失败、绝不写 tick-failed（审计坏了不是验收坏了）。
  tickBeat.setPhase('audit');
  try {
    const auditProfile = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
    const audited = await gateAudit({ home, profile: auditProfile, now, github: null });
    heartbeat.lastTick.gateAudit = {
      checked: audited.checkedLines,
      found: audited.newViolations.length,
      sinceBaseline: audited.sinceBaseline,
      uncertain: audited.newUncertain?.length || 0,
    };
  } catch (error) {
    heartbeat.lastTick.gateAuditError = String(error?.message || error);
  }

  // 4. Slack 通知（#61）：放在验收调度之后（#70 复审：Slack 卡住不能拖慢验收），这一拍新写的提醒也一起发。
  //    总时长有上限（boundedNotify），整个调用 try/catch：出错只进心跳，绝不影响这一拍。
  tickBeat.setPhase('notify');
  let slackFailing = previousSlackFailing(paths);
  try {
    const result = await boundedNotify(notify, { home, env: { ...env, ACCEPTANCE_WATCHER_HOME: home }, now, ...notifyOptions }, notifyWaitMs);
    heartbeat.slack = slackHeartbeat(result);
    // 读到了账本才知道失败标记的最新状态；没读到（没配、令牌坏、超时）就沿用上一拍的。
    if (result && typeof result === 'object' && Object.hasOwn(result, 'failing')) slackFailing = result.failing || null;
    // 通报已关闭：不会再有「发送失败」，上一拍留下的失败标记一并清掉（ensure 不再报 slack-failed）。
    if (result?.reason === 'not-configured') slackFailing = null;
  } catch (error) {
    // 异常文字不进心跳（万一里面带了请求头之类的东西），只记原因。
    heartbeat.slack = slackHeartbeat({ ok: false, reason: 'notify-error', error: String(error?.name || 'unknown') });
  }
  if (slackFailing) heartbeat.slackFailing = slackFailing;

  tickBeat.stop();
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
