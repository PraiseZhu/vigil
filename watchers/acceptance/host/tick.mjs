#!/usr/bin/env node
// 一拍调度（#47 SC12 / SC13）：常驻循环每 180 秒调一次（#247 SC3：60 → 180）。
// 1) poll.mjs 在沙箱外跑（只读盘点，可以读 GitHub 令牌），不进 bwrap；2) 卡住的轮次先杀进程再 abort；
// 3) 按空槽起新的 round；4) 写心跳。任何错误都只落进心跳和 alerts.jsonl，绝不抛出循环。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { RateLimitError, createGithub } from '../bin/github.mjs';
import { runRound as runRoundCommand } from '../bin/round.mjs';
import { appendAlert, hostPaths, isAlive, readAlerts, readLockPayload } from './paths.mjs';
import { run as procRun, spawnBackground } from './proc.mjs';
import { MAX_ROUNDS, readHostConfig, serialLockFiles } from './round.mjs';
import { checkReadyStalled, cleanupWorktrees, discoverCorrections } from './prbot.mjs';
import { clearStarted, readPrbotWait, rememberFound, starvedIssues, writePrbotWait } from './prbot-wait.mjs';
import { NOTIFY_BUDGET_MS, notifySlack } from './slack-notify.mjs';
import { defaultSpawnAdjudicate, scheduleAdjudications } from './adjudicate.mjs';
import { runGateAudit } from './gate-audit.mjs';
import { reportBasePending } from './base-pending.mjs';
import { HEARTBEAT_TICK_MAX_S, POLL_BEAT_MS, startTickBeat } from './poll-beat.mjs';
import { isReadOnlyGraphql } from '../bin/github.mjs';
import { classifyNetError } from '../bin/net-errors.mjs';
import {
  GRAPHQL_COST_PER_REQUEST,
  appendRateLog,
  chargeBudget,
  decideTick,
  defaultIdentity,
  identityRecord,
  rateLogLine,
  readBudgetFile,
  readRateState,
  recordHeader,
  writeRateState,
} from '../bin/rate-budget.mjs';

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

/**
 * 已合并子 issue 的补验限速（#224）：每一拍最多新认领 1 个 kind=child。
 * 槽位满或 runHostRound 内存门拦住时不起新轮、不写评论、不算一轮，下一拍再试。这里不另写提醒。
 */
export const MAX_CHILD_CLAIMS_PER_TICK = 1;

const RETRIED = '（已重试一次）';

/**
 * 主循环的拍间隔（秒，#247 SC3）：60 → 180。改完看板更新延迟仍在几分钟内（实测门槛见
 * docs/acceptance-operations.md）。`host/loop` 用同一个默认值，并通过 `ACCEPTANCE_TICK_SECONDS`
 * 把生效值告诉这一拍，心跳里写成 `tickIntervalS` 供体检和测试替身读。
 */
export const TICK_INTERVAL_SECONDS = 180;

/**
 * 拍间隔的上界（秒，#247 P2-B）：与心跳年龄上限同源。`host/loop` 真正 sleep 的也是这个值，写进心跳的不能比它大，
 * 也不能大到一个看门狗判不了（例如误填毫秒 180000 → 上限 50 小时、86400 → 一天）。
 */
export const TICK_INTERVAL_MAX_SECONDS = HEARTBEAT_TICK_MAX_S;

/** 这一拍生效的拍间隔（秒）：`host/loop` 注入的 ACCEPTANCE_TICK_SECONDS，不合法或超出 1..3600 就用默认 180。 */
export function tickIntervalSeconds(env = {}) {
  const raw = Number(env?.ACCEPTANCE_TICK_SECONDS);
  return Number.isInteger(raw) && raw > 0 && raw <= TICK_INTERVAL_MAX_SECONDS ? raw : TICK_INTERVAL_SECONDS;
}

/**
 * 限流（poll 退出码 75，#247 SC6）：这一拍跳过，不写 tick-failed、不让看门狗停循环。
 * poll 已经把「因额度跳过」写进 loop.log。
 */
export const POLL_RATE_LIMITED_CODE = 75;

/**
 * 是不是限流错误（#247 P2-1）：本仓的 RateLimitError，或任何带 RATE_LIMITED 错误码的错误。
 * 限流不当普通失败：这一段跳过、不写 tick-failed / prbot-tick-failed。
 */
export function isRateLimitError(error) {
  return error instanceof RateLimitError || error?.code === 'RATE_LIMITED';
}

/**
 * 重试成功不写告警，只在 loop.log 留一行（T23），方便统计超时次数。格式固定：
 * `<UTC ISO 时间> read-retry-ok kind=<poll|prbot-read> totalMs=<两次合计毫秒> 读取超时已重试成功`
 */
export function logReadRetryOk(paths, kind, totalMs, now = () => Date.now()) {
  try {
    fs.appendFileSync(paths.loopLog, `${new Date(now()).toISOString()} read-retry-ok kind=${kind} totalMs=${Math.round(totalMs)} 读取超时已重试成功\n`);
  } catch {
    // 日志写不下去不影响这一拍。
  }
}

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
/** 一拍里 tick 自己替只读请求（含 poll）重试的总次数上限（#238，Issue Inspector 2026-11-03 定）。 */
export const MAX_TICK_READ_RETRIES = 3;
export function readRetryBudget(left = MAX_TICK_READ_RETRIES) {
  return { left };
}

/**
 * poll 这次失败值不值得用新进程再拉一次（#238）：超时（124）、网络类瞬时错误（限流 75 除外，它跳过这一拍），
 * 以及退出码 0 但输出截断、乱码解析不了的。业务错误不重试。
 */
export function pollRetryable(poll) {
  if (!poll) return false;
  if (poll.code === 0) {
    try {
      JSON.parse(poll.stdout || '[]');
      return false;
    } catch {
      return true;
    }
  }
  if (poll.code === POLL_RATE_LIMITED_CODE) return false;
  return poll.code === 124 || classifyNetError(poll).transient;
}

export function withReadTimeout(run, timeoutMs = TICK_READ_TIMEOUT_MS, { onRead, onRetryOk, budget } = {}) {
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
    const startedAt = Date.now();
    const first = await once(cmd, args, opts);
    // 超时（124）和网络类瞬时错误（分类表见 bin/net-errors.mjs，#238）都用新进程重试一次；业务错误不重试。
    if (!first || first.code === 0 || !(first.code === 124 || classifyNetError(first).transient)) return first;
    if (budget) {
      if (budget.left <= 0) return first;
      budget.left -= 1;
    }
    const second = await once(cmd, args, opts);
    // retried：里层已经重试过，github.mjs 的 runRead 不再重试（单个请求最多重试一次）。
    if (second && second.code !== 0) return { ...second, retried: true, stderr: `${String(second.stderr || '').trim()}${RETRIED}` };
    try {
      onRetryOk?.({ totalMs: Date.now() - startedAt });
    } catch {
      // 留日志失败不影响读。
    }
    return second && { ...second, retried: true };
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

  const readRetries = readRetryBudget();
  const heartbeat = {
    at: new Date(now()).toISOString(),
    pid: loopPid(env),
    uptimeS: uptime(),
    // 生效的拍间隔（秒）：`host/loop` 注入的 ACCEPTANCE_TICK_SECONDS，没注入就用默认 180。
    tickIntervalS: tickIntervalSeconds(env),
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

    // 额度两道闸（#247 SC5-6-8-9）：预算从 <home>/config/rate-budget.json 读，剩余只看响应头记录。
    // 预算配置缺了或不对：只记进心跳、不猜默认值（这一拍照跑，但完全不带预算闸）。
    let rateBudgets = null;
    try {
      rateBudgets = readBudgetFile(paths.rateBudgetConfig);
    } catch (error) {
      heartbeat.lastTick.rateBudgetError = String(error?.message || error);
    }

    /** 判定一次读能不能发；日志行（因额度跳过 / rate-unknown / 重置后限速）写 loop.log。 */
    // 同一拍里的多次判定共用一个拍标识：连跳按「拍」数，越过阈值那一次只写一条提醒（#247 P2-b）。
    const tickGateId = String(now());
    const rateGate = ({ component, purpose = 'non-essential', cost = 0, reserve = 0, tickId } = {}) => {
      try {
        const decided = decideTick({
          component,
          purpose,
          state: readRateState(paths.rateState),
          now: now(),
          tickId: tickId ?? tickGateId,
          budgets: rateBudgets,
          cost,
          reserve,
        });
        appendRateLog(paths.loopLog, decided.log);
        writeRateState(paths.rateState, decided.state);
        return decided;
      } catch (error) {
        // 判定自身出错不把这一拍弄挂，但必须留痕（#247 P3-1）：心跳 + loop.log，不然 SC5/SC6 整条链断了没人知道。
        const message = String(error?.message || error);
        heartbeat.lastTick.rateGateError = message;
        appendRateLog(
          paths.loopLog,
          `${new Date(now()).toISOString()} rate-unknown component=${component} identity=${defaultIdentity(component)} remaining=unknown reason=rate-gate-error 判定或写状态出错，这一拍放行`,
        );
        return { allowed: true, reason: 'rate-gate-error', error: message };
      }
    };

    /**
     * 记一次「因额度跳过」（#247 SC6 / P2-3）：心跳只写一个字段名（`rateSkipped`），
     * 连续跳过超过 N 拍时再写一条提醒——心跳 ok:true 不会让看门狗发现「整小时没在推进」。
     */
    const noteRateSkip = (decided, { component, purpose }) => {
      if (!decided) return;
      if (!decided.allowed) heartbeat.lastTick.rateSkipped = decided.reason || 'rate-skip';
      if (!decided.escalate) return;
      try {
        appendAlert(paths, {
          kind: 'rate-skip-escalate',
          reason: `连续 ${decided.skipStreak} 拍因额度跳过`,
          detail: [component, purpose, decided.reason].filter(Boolean).join(' '),
          count: decided.skipStreak,
          component,
          now,
        });
      } catch {
        // 提醒写不下去就只留日志。
      }
    };

    /**
     * 限流（#247 SC6 / P2-1）：这一段这一拍跳过，不当成普通失败写 tick-failed / prbot-tick-failed。
     * 限流带上来的响应头也记进状态文件，下一拍的闸才看得见真实剩余。
     */
    const noteRateLimited = (stage, error) => {
      const identity = error?.identity === 'app' ? 'app' : defaultIdentity('loop');
      try {
        // 只有真的拿到了剩余才记（#247 复审 P3）：`remaining` 缺失时照记会把已知剩余抹成 unknown，
        // 恰好是最需要退避的时刻。github 侧同一类守卫也是「没有剩余就不记」。
        if (error?.remaining != null) {
          writeRateState(
            paths.rateState,
            recordHeader(readRateState(paths.rateState), {
              identity,
              remaining: error.remaining ?? null,
              reset: error.reset ?? null,
              at: now(),
              source: 'graphql',
            }),
          );
        }
      } catch {
        // 记不下不挡这一拍。
      }
      const record = identityRecord(readRateState(paths.rateState), identity);
      appendRateLog(
        paths.loopLog,
        rateLogLine({
          kind: 'rate-skip',
          now: now(),
          component: 'loop',
          identity,
          remaining: record?.known ? record.remaining : null,
          action: 'github-rate-limited',
        }),
      );
      // 跳过原因统一一个值（外部只认一个字段、一个词），具体是哪一段看 rateSkippedStage。
      heartbeat.lastTick.rateSkipped = 'github-rate-limited';
      heartbeat.lastTick.rateSkippedStage = stage;
    };

    // 主循环 poll 是必要读（低额度 / 超预算时都照跑，#247 SC5 / 复审 P1）：预算闸对 essential 直接放行，
    // 剩余低于 800 也只暂停非必要读。`reserve` 只在预算比较时算上这一次读的估计点数（对 essential 不生效）。
    const pollGate = rateGate({ component: 'loop', purpose: 'essential', reserve: GRAPHQL_COST_PER_REQUEST });
    noteRateSkip(pollGate, { component: 'loop', purpose: 'essential' });
    if (!pollGate.allowed) {
      tickBeat.stop();
      return writeHeartbeat();
    }
    // T23：拉取是只读盘点。超时（124）时 proc.run 整组杀掉 poll 和它起的 gh（不留孤儿），再用新进程重试一次；
    // 重试成功不写提醒，重试也超时才按这一拍失败处理。其余失败（非 124）不重试，照旧。
    const pollOnce = () =>
      run('node', [path.join(repoRoot, 'watchers', 'acceptance', 'bin', 'poll.mjs'), '--json', '--with-inventory'], {
        env: { ...env, ACCEPTANCE_WATCHER_HOME: home },
        timeoutMs: POLL_TIMEOUT_MS,
        killGroup: true,
      });
    const pollStartedAt = Date.now();
    let poll = await pollOnce();
    let pollRetried = false;
    if (pollRetryable(poll) && readRetries.left > 0) {
      readRetries.left -= 1;
      pollRetried = true;
      poll = await pollOnce();
      if (poll && poll.code === 0) logReadRetryOk(paths, 'poll', Date.now() - pollStartedAt, now);
    }
    if (poll && poll.code === POLL_RATE_LIMITED_CODE) {
      // 限流（#247 SC6）：这一拍跳过，不写 tick-failed。心跳照旧写，看门狗不会停循环。
      // 日志里的剩余用 poll 刚记下的真实值（P3-2），不写死 unknown。
      noteRateLimited('poll', { identity: defaultIdentity('loop') });
      tickBeat.stop();
      return writeHeartbeat();
    }
    if (!poll || poll.code !== 0) {
      throw new Error(
        `poll 失败（退出码 ${poll?.code ?? '未知'}）${pollRetried ? RETRIED : ''}：${String(poll?.stderr || '').trim().split('\n')[0] || ''}`,
      );
    }
    let entries;
    let inventoryTasks = null;
    let baseSkipped = [];
    let pollReads = 1;
    try {
      const parsedPoll = JSON.parse(poll.stdout || '[]');
      // poll --with-inventory 给 `{entries, tasks, reads}`；老形状（数组）也照旧认。
      if (Array.isArray(parsedPoll)) entries = parsedPoll;
      else if (parsedPoll && Array.isArray(parsedPoll.entries)) {
        entries = parsedPoll.entries;
        inventoryTasks = Array.isArray(parsedPoll.tasks) ? parsedPoll.tasks : null;
        baseSkipped = Array.isArray(parsedPoll.baseSkipped) ? parsedPoll.baseSkipped : [];
        // reads=0 是「这一拍没发只读请求」，照实记 0；缺这个字段才按老形状当 1 次（P2-2）。
        if (Number.isInteger(parsedPoll.reads) && parsedPoll.reads >= 0) pollReads = parsedPoll.reads;
      } else throw new Error('poll 输出不是数组，也不是 {entries, tasks}');
    } catch (error) {
      throw new Error(`poll 输出不是 JSON：${error.message}`);
    }
    if (!Array.isArray(entries)) throw new Error('poll 输出不是数组');

    // 这一拍的实际花费记进 loop 组件的本小时用量（#247 SC5）：按响应头个数 × 单次点数。
    try {
      const charged = chargeBudget(readRateState(paths.rateState), {
        component: 'loop',
        cost: pollReads * GRAPHQL_COST_PER_REQUEST,
        now: now(),
      });
      writeRateState(paths.rateState, charged);
    } catch (error) {
      heartbeat.lastTick.rateError = String(error?.message || error);
    }

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
    // 这一拍因「等待超过 1 小时」优先起的修正轮数：验收轮的空槽要让出这么多，避免总数超过 MAX_ROUNDS。
    let starvedStarted = 0;
    if (prbotSettings) {
      tickBeat.setPhase('prbot');
      heartbeat.lastTick.prbotStarted = [];
      heartbeat.lastTick.prbotStalled = [];
      heartbeat.lastTick.prbotCleaned = [];
      try {
        const prbotProfile = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
        // T20：这一段读 GitHub 原先没有超时，对端不回包时整拍挂住（2026-10-30 卡了约 14 分钟）。只给读加超时，
        // 每次读开始重新记阶段时长（T23：一次读最多约 50 秒，连同重试最多约 100 秒，远小于 180 秒上限）。
        const prbotRun = withReadTimeout(run, prbotReadTimeoutMs, {
          budget: readRetries,
          onRead: () => tickBeat.setPhase('prbot'),
          onRetryOk: ({ totalMs }) => logReadRetryOk(paths, 'prbot-read', totalMs, now),
        });
        const prbotGithub = createGithub({
          profile: { ...prbotProfile, writeCommand: undefined },
          run: prbotRun,
          // 修正轮的每次只读也把响应头记进同一份分令牌账（#247 SC9），并计入 loop 组件的本小时用量。
          onRateLimit: (sample) => {
            try {
              const recorded = recordHeader(readRateState(paths.rateState), sample);
              writeRateState(
                paths.rateState,
                chargeBudget(recorded, { component: 'loop', cost: GRAPHQL_COST_PER_REQUEST, now: now() }),
              );
            } catch {
              // 记不下不挡这次读。
            }
          },
        });
        const discover =
          discoverPrbot || ((options) => discoverCorrections({ ...options, github: prbotGithub, profile: prbotProfile, hostConfig: prbotSettings }));
        // 修正轮发现与卡住检查都是非必要读（#247 SC6）：真实剩余低于暂停线时这一拍不拉、不查，只写一行日志。
        let found = [];
        let discoveredThisTick = false;
        const discoverGate = rateGate({ component: 'loop', purpose: 'non-essential', reserve: GRAPHQL_COST_PER_REQUEST });
        noteRateSkip(discoverGate, { component: 'loop', purpose: 'non-essential' });
        if (discoverGate.allowed) {
          try {
            found = await discover({ now, home, github: prbotGithub, tasks: inventoryTasks });
            discoveredThisTick = true;
          } catch (error) {
            // 限流（#247 P2-1）：这一拍跳过发现，不写 prbot-tick-failed。
            if (!isRateLimitError(error)) throw error;
            noteRateLimited('prbot-discover', error);
            found = [];
          }
        }
        // 修正轮和验收轮共用 2 个槽：默认先给这一拍该开始的验收轮留位（同仓锁被占、起不来的 mivo / serialRepos 验收轮不算），剩下的才给修正轮。
        // 某个修正轮等待已经超过 1 小时：下一个空槽优先给它（不预留验收位），不固定留槽；没超过或刚好 1 小时仍走原口径。
        const pendingAcceptance = entries.filter((item) => {
          if (!item || item.stale) return false;
          const record = byIssue.get(item.issue);
          if (record && isAlive(Number(record.pid))) return false;
          return !lockFilesFor(item.issue).some(lockHeld);
        }).length;
        const eligible = [];
        for (const entry of found || []) {
          const lockFile = path.join(paths.prbotLocksDir, `${entry.issue.replace(/[^\w.-]+/g, '__')}.lock`);
          const held = readLockPayload(lockFile);
          if (held && isAlive(Number(held.pid))) continue;
          eligible.push(entry);
        }
        // 发现被额度闸或限流跳过时不改等待账，免得把还在等的 issue 清掉。
        let waitState = discoveredThisTick
          ? rememberFound(readPrbotWait(paths.prbotWaitFile), eligible.map((entry) => entry.issue), now())
          : readPrbotWait(paths.prbotWaitFile);
        const starved = new Set(starvedIssues(waitState, eligible.map((entry) => entry.issue), now()));
        // 写闸总开关关着：修正轮的写同样全被拒，起了只会白跑，所以也不起（饿住也不例外）。
        let remaining = gateEnabled ? Math.max(0, MAX_ROUNDS - liveSlotCount(paths)) : 0;
        const startedIssues = [];
        const startOne = (entry) => {
          if (remaining <= 0) return false;
          remaining -= 1;
          const pid = startPrbot(entry.issue);
          heartbeat.lastTick.prbotStarted.push({ issue: entry.issue, pid: pid ?? null });
          startedIssues.push(entry.issue);
          return true;
        };
        for (const entry of eligible) {
          if (!starved.has(entry.issue)) continue;
          if (!startOne(entry)) break;
        }
        starvedStarted = startedIssues.length;
        for (const entry of eligible) {
          if (starved.has(entry.issue)) continue;
          if (remaining - pendingAcceptance <= 0) break;
          startOne(entry);
        }
        if (discoveredThisTick) {
          try {
            writePrbotWait(paths.prbotWaitFile, clearStarted(waitState, startedIssues));
          } catch {
            // 等待账写不下去不挡这一拍。
          }
        }
        const checkStalled = checkPrbotStalled || ((options) => checkReadyStalled({ ...options, github: prbotGithub, profile: prbotProfile }));
        // 卡住检查也是非必要读（#247 P2-1）：低额度 / 超预算时同样跳过，不当成「没卡住」。
        const stalledGate = rateGate({ component: 'loop', purpose: 'non-essential' });
        noteRateSkip(stalledGate, { component: 'loop', purpose: 'non-essential' });
        let stalled = [];
        if (stalledGate.allowed) {
          try {
            stalled = await checkStalled({ home, now, github: prbotGithub, reviewCheckPattern: prbotSettings.reviewCheckPattern });
          } catch (error) {
            if (!isRateLimitError(error)) throw error;
            noteRateLimited('prbot-stalled', error);
            stalled = [];
          }
        }
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
    // 2c. 合入非默认分支、超过 3 天还没合入默认分支的任务（#380）：用这一拍 poll 的 baseSkipped，不发 GitHub 请求；
    //     按日去重进提醒文件，只进每日汇总。出错只写心跳，不让这一拍失败。
    try {
      const pending = reportBasePending({ paths, baseSkipped, now });
      if (pending.reported.length) heartbeat.lastTick.basePending = pending.reported;
    } catch (error) {
      heartbeat.lastTick.basePendingError = String(error?.message || error);
    }

    // 3. 该开始的任务：已在跑的不重开，最多占到空槽数；总开关关着就一个都不起。
    //    同仓最多 1 轮的仓：锁被占着、或这一拍已经给同一把锁起过一轮的，记进 serialWaiting，等锁放了再起（不认领、不写提醒）。
    // 饿住的修正轮已经优先占了槽：验收轮让出同样数量，总数不超过 MAX_ROUNDS。没有饿住起步时口径与原来一样。
    let free = gateEnabled ? Math.max(0, MAX_ROUNDS - liveSlotCount(paths) - starvedStarted) : 0;
    const serialWaiting = [];
    const claimedThisTick = new Set();
    let childClaims = 0;
    for (const entry of entries.filter((item) => item && !item.stale && !item.outOfScope && !item.passedButOpen && !item.adjudicate)) {
      if (free <= 0) break;
      const isChild = entry.kind === 'child';
      if (isChild && childClaims >= MAX_CHILD_CLAIMS_PER_TICK) continue;
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
      if (isChild) childClaims += 1;
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
