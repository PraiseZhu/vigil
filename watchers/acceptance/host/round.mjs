#!/usr/bin/env node
// 一轮验收（#47 SC11）：起 pi 的唯一入口。
// 顺序：内存门 → 槽/测试锁 → 写闸总开关 → bwrap 探针 → 认领（经写闸 exec）→ 预取代码 → 预装依赖 → 起写闸 serve
// → bwrap 参数 + 出网代理 → 跑 pi → 收尾。总开关关着、bwrap 探针不过都不认领；认领之后沙箱参数拼不出来
// 就不跑模型，这一轮 abort 成「中断」并写提醒；没有任何开关能绕过沙箱。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { createGithub } from '../bin/github.mjs';
import { runRound as runRoundCommand } from '../bin/round.mjs';
import { parseRef } from '../bin/rounds.mjs';
import { appendCodePaths } from '../bin/message.mjs';
import { appendAlert, hostPaths, progressFileFor, releaseLock, tryAcquireLock, writeRoundProgress } from './paths.mjs';
import { buildBwrapArgs, defaultHomeAllow, maskList, prepareSandboxProfile, probeBwrap, sandboxEnv } from './sandbox.mjs';
import { EGRESS_BRIDGE_PORT, bridgeCommand, startRoundEgress } from './egress-proxy.mjs';
import { run as procRun, spawnDetached, spawnProcess } from './proc.mjs';
// prefetch.mjs → prbot.mjs → 本文件成环：两边都只在函数里用对方的导出，模块求值顺序不受影响。
import { prefetchCode } from './prefetch.mjs';
import { appendDepsInfo, prepareDeps } from './predeps.mjs';
import { ENV_PROBLEM_PREFIX } from '../bin/trigger.mjs';
import { redact } from '../bin/redact.mjs';

/** 内存门：MemAvailable 低于 3 GiB 就不认领、不跑模型。常量，不可配。 */
export const MEMORY_GATE_BYTES = 3 * 1024 ** 3;
/** 同一时间最多 2 轮（验收轮 + 修正轮合计）。常量，不可配。 */
export const MAX_ROUNDS = 2;
/** 跑 pi 时多久看一次进度。 */
export const STATUS_INTERVAL_MS = 60000;
/** 卡住后先 SIGTERM，等这么久还没退再 SIGKILL。 */
export const KILL_GRACE_MS = 10000;
/** 裁决已写（轮次是终态）之后 pi 还不退，宽限这么久再结束它。 */
export const VERDICT_GRACE_MS = 2 * 60 * 1000;
/** 一轮的总时长上限（宿主墙钟，从认领算起）：host.json 的 maxRoundMinutes，默认 120。 */
export const DEFAULT_MAX_ROUND_MINUTES = 120;
/** 沙箱坏了（bwrap 探针不过）时 sandbox-down 提醒的节流窗口。 */
export const SANDBOX_DOWN_ALERT_MS = 60 * 60 * 1000;
/** mivo 的仓名（`/` 后面那段）以 mivo 开头就占测试锁。 */
export const TEST_LOCK_PATTERN = /^mivo/i;
const ISSUE_PATTERN = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;

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

export function readMemAvailable(file = '/proc/meminfo') {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const match = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

/** <home>/config/host.json：可缺；缺了也照跑，但 piCommand 必须由 requirePiCommand 兜住。 */
export function readHostConfig(file) {
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`host.json 不是合法 JSON：${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('host.json 应为对象');
  return parsed;
}

/** host.json 的 maxRoundMinutes：正数才认，缺了或不合法用默认 120。 */
export function maxRoundMinutes(hostConfig) {
  const value = hostConfig?.maxRoundMinutes;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_ROUND_MINUTES;
}

export function requirePiCommand(hostConfig) {
  const command = hostConfig?.piCommand;
  if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string' || !item)) {
    throw new Error('host.json 缺少 piCommand（非空字符串数组）');
  }
  return [...command];
}

/** 占一个槽（slot-0 / slot-1）：都占着就返回 null。 */
export function acquireSlot(paths, now = () => Date.now()) {
  for (const name of ['slot-0', 'slot-1']) {
    const file = path.join(paths.slotsDir, name);
    if (tryAcquireLock(file, { now })) return { name, file };
  }
  return null;
}

/**
 * 一轮在宿主上的名字：<owner>__<repo>__<issue 号>__<轮次>。必须带 issue 号——同一个仓的两个总 issue
 * 各自的第 1 轮会同时跑（两个槽），不带号就共用 roundDir、写闸 socket 和登记文件，pi.log 也互相覆盖。
 */
export function roundKey(issue, round) {
  const { owner, name, number } = parseRef(issue);
  return `${owner}__${name}__${number}__${round}`;
}

export function roundDirFor(paths, issue, round) {
  return path.join(paths.roundRunDir, roundKey(issue, round));
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function parseClaim(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) throw new Error('start 没有输出');
  let info;
  try {
    info = JSON.parse(lines.at(-1));
  } catch {
    throw new Error('start 的最后一行不是 JSON');
  }
  if (!info || typeof info !== 'object' || !Number.isInteger(info.round) || info.commentId == null) {
    throw new Error('start 的 JSON 缺字段（round / commentId）');
  }
  return { ...info, message: lines.slice(0, -1).join('\n') };
}

function parseJsonLastLine(text) {
  const lines = String(text || '')
    .split('\n')
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines.at(-1));
  } catch {
    return null;
  }
}

/** 清掉 roundDir 里除 pi.log 之外的东西（日志留给人事后看）。 */
function cleanRoundDir(roundDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(roundDir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'pi.log') continue;
    try {
      fs.rmSync(path.join(roundDir, name), { recursive: true, force: true });
    } catch {
      // 清不掉不影响这一轮的结果。
    }
  }
}

/**
 * 起写闸 serve 后最多等多久看到 socket（可注入，只给测试）。serve 开 socket 前要先读一次任务树
 * （总 issue 1 条查询 + 修正子 issue 搜索 1+forkRepos 条，逐条串行）；每条读遇瞬时故障会等 4 秒重试一次
 * （bin/github.mjs），gh 的 TLS 握手超时约 10 秒，一条最坏约 25 秒。原来只等 20 秒，GitHub 慢时一条读重试
 * 就超了，轮次被放弃。60 秒够三条各重试一次；重试也失败时 serve 自己会退出，下面会立刻发现、不等满。
 */
export const GATE_START_TIMEOUT_MS = 60000;

/** gate.log 末几行（写进提醒用）：只取最后几行、限长，令牌和本机路径先抹掉。 */
function gateLogTail(file, { lines = 5, maxChars = 600 } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const tail = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .join(' / ');
  return redact(tail).slice(-maxChars);
}

function formatSeconds(ms) {
  return `${Number((ms / 1000).toFixed(1))} 秒`;
}

export async function defaultStartGate({
  home,
  socketPath,
  binding,
  env,
  repoRoot,
  sleep,
  logFile: gateLog,
  startTimeoutMs = GATE_START_TIMEOUT_MS,
  spawn = spawnDetached,
  clock = Date.now,
}) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const logFile = gateLog || path.join(path.dirname(path.dirname(socketPath)), 'gate.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [
      path.join(repoRoot, 'watchers', 'acceptance', 'host', 'write-gate.mjs'),
      'serve',
      '--socket',
      socketPath,
      '--issue',
      binding.root,
      '--round',
      String(binding.round),
      '--comment-id',
      String(binding.commentId),
      '--home',
      home,
    ],
    { env, stdio: ['ignore', logFd, logFd] },
  );
  fs.closeSync(logFd);
  // 子进程先退了（比如读任务树失败）就不必等满上限。
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  const deadline = clock() + startTimeoutMs;
  while (clock() < deadline) {
    if (fs.existsSync(socketPath)) {
      return {
        socketPath,
        pid: child.pid,
        async stop() {
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // 已经退了。
          }
          const until = Date.now() + 5000;
          while (Date.now() < until) {
            try {
              process.kill(child.pid, 0);
            } catch {
              return;
            }
            await sleep(50);
          }
          try {
            process.kill(child.pid, 'SIGKILL');
          } catch {
            // 已经退了。
          }
        },
      };
    }
    if (exited) break;
    await sleep(100);
  }
  if (!exited) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch {
      // 已经退了。
    }
  }
  const tail = gateLogTail(logFile);
  const why = exited
    ? `子进程已经退出（${exited.signal ? `信号 ${exited.signal}` : `退出码 ${exited.code}`}）`
    : `等了 ${formatSeconds(startTimeoutMs)}没等到 socket（等待超时）`;
  throw new Error(`写闸 serve 没起来：${why}${tail ? `；gate.log 末几行：${tail}` : ''}`);
}

/**
 * 写闸转发（#47 SC11）：沙箱里看到的 socket 是宿主这一层，每条连接原样转给内层的写闸 serve，
 * 顺手记一次「本轮有活动」。转发不看内容、不改内容，放行与否仍然只由写闸决定。
 */
export async function startGateRelay({ publicPath, innerPath, onRequest = () => {} }) {
  fs.mkdirSync(path.dirname(publicPath), { recursive: true, mode: 0o700 });
  fs.rmSync(publicPath, { force: true });
  const sockets = new Set();
  const server = net.createServer((client) => {
    try {
      onRequest();
    } catch {
      // 记活动失败不影响转发。
    }
    const upstream = net.connect(innerPath);
    sockets.add(client);
    sockets.add(upstream);
    const close = () => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    client.on('error', close);
    upstream.on('error', close);
    client.on('close', () => sockets.delete(client));
    upstream.on('close', () => sockets.delete(upstream));
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(publicPath, resolve);
  });
  fs.chmodSync(publicPath, 0o600);
  return {
    socketPath: publicPath,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      fs.rmSync(publicPath, { force: true });
    },
  };
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** status --json 说这一轮已经是终态（通过 / 要修 / 中断）了吗。 */
/** 本轮被 helper 按裁决防线标成「中断」（环境问题 / 未验证）：必需检查因环境没跑，不能判通过。 */
function isEnvUnverified(status, round) {
  return (
    isTerminalFor(status, round) &&
    status.status === '中断' &&
    typeof status.reason === 'string' &&
    status.reason.startsWith(ENV_PROBLEM_PREFIX)
  );
}

function isTerminalFor(status, round) {
  return Boolean(status) && Number(status.round) === round && typeof status.status === 'string' && status.status !== '验收中';
}

/** 沙箱坏了：节流写 sandbox-down（一个窗口一条），不认领、不在 issue 上留评论。 */
function noteSandboxDown(paths, { issue, now, profile, log }) {
  let last = null;
  try {
    last = Date.parse(JSON.parse(fs.readFileSync(paths.sandboxDownFile, 'utf8')).lastAlertAt);
  } catch {
    last = null;
  }
  if (Number.isFinite(last) && now() - last < SANDBOX_DOWN_ALERT_MS) {
    log('沙箱起不来（bwrap 探针没过）：不认领；这个窗口里已写过提醒');
    return;
  }
  appendAlert(paths, { kind: 'sandbox-down', issue, reason: '沙箱起不来（bwrap 探针没过），不认领', now, profile });
  writeJsonAtomic(paths.sandboxDownFile, { lastAlertAt: new Date(now()).toISOString() });
  log('沙箱起不来（bwrap 探针没过）：不认领，已写 sandbox-down 提醒');
}

function defaultSpawnPi({ cmd, args, env, cwd, logFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, 'a');
  const child = spawnProcess(cmd, args, { env, cwd, stdio: ['pipe', logFd, logFd] });
  fs.closeSync(logFd);
  // pi 早退时再写 stdin 会 EPIPE：吞掉，退出由 exit 交代。
  child.stdin?.on('error', () => {});
  const exit = new Promise((resolve) => {
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal: signal || undefined }));
    child.on('error', (error) => resolve({ code: 1, error: String(error?.message || error) }));
  });
  return {
    pid: child.pid,
    stdin: child.stdin,
    kill(signal) {
      try {
        child.kill(signal);
      } catch {
        // 已经退了。
      }
    },
    exit,
  };
}

/**
 * 跑一轮验收。返回退出码：
 * 0 跑完（裁决已写）；1 出错（含沙箱起不来、卡住、超时、pi 退出但没写裁决）；
 * 3 什么都不做（内存不够 / 槽满 / 测试锁被占 / 写闸总开关关着 / 不该认领）；4 写闸拒绝（已写提醒）。
 */
export async function runHostRound({
  home,
  issue,
  env = process.env,
  run = procRun,
  spawnPi = defaultSpawnPi,
  runRound: runRoundFn,
  startGate = defaultStartGate,
  startEgress = startRoundEgress,
  prefetch = prefetchCode,
  predeps = prepareDeps,
  now = () => Date.now(),
  meminfoPath = '/proc/meminfo',
  statusIntervalMs = STATUS_INTERVAL_MS,
  killGraceMs = KILL_GRACE_MS,
  verdictGraceMs = VERDICT_GRACE_MS,
  sleep = defaultSleep,
  log = (message) => process.stderr.write(`${message}\n`),
  hostConfig,
  repoRoot,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('runHostRound 需要绝对路径的 home');
  if (typeof issue !== 'string' || !ISSUE_PATTERN.test(issue)) throw new Error('issue 应为 owner/repo#编号');

  const root = repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const paths = hostPaths(home);
  const settings = hostConfig || readHostConfig(paths.hostConfig);
  const piCommand = requirePiCommand(settings);
  const maxRoundMs = maxRoundMinutes(settings) * 60 * 1000;

  // 1. 内存门：放在认领之前，不够就什么都不写。
  const available = readMemAvailable(meminfoPath);
  if (available == null) {
    log('内存门：读不到 MemAvailable，按不够处理');
    return 3;
  }
  if (available < MEMORY_GATE_BYTES) {
    log(`内存门：MemAvailable ${available} 字节 < ${MEMORY_GATE_BYTES}，这一拍不认领`);
    return 3;
  }

  // 2. 槽 + mivo 测试锁
  const slot = acquireSlot(paths, now);
  if (!slot) {
    log(`槽位已满（最多 ${MAX_ROUNDS} 轮），这一拍不认领`);
    return 3;
  }
  const { repo } = parseRef(issue);
  const needTestLock = TEST_LOCK_PATTERN.test(repo.split('/')[1] || '');
  let testLockHeld = false;
  if (needTestLock) {
    if (!tryAcquireLock(paths.testLock, { now })) {
      releaseLock(slot.file);
      log('测试锁被占（mivo 同时只跑一轮），这一拍不认领');
      return 3;
    }
    testLockHeld = true;
  }

  const profile = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
  const hostProfile = {
    ...profile,
    // 写闸的 home 用参数带过去：writeCommand 的环境是 github.mjs 的最小环境，没有 ACCEPTANCE_WATCHER_HOME。
    writeCommand: [
      process.execPath,
      path.join(root, 'watchers', 'acceptance', 'host', 'write-gate.mjs'),
      'exec',
      '--home',
      home,
    ],
  };
  const github = createGithub({ profile: hostProfile, run });

  async function callRound(argv) {
    if (typeof runRoundFn === 'function') return runRoundFn(argv);
    const out = sink();
    const err = sink();
    const code = await runRoundCommand(argv, { github, profile: hostProfile, now, stdout: out, stderr: err });
    return { code, stdout: out.text, stderr: err.text };
  }

  // 跑 pi 时的等待：pi 一退就醒（不等满一个间隔）。默认 sleep 用可清掉的定时器，收尾后进程不会被它拖住。
  async function waitTick(ms, until) {
    if (sleep !== defaultSleep) {
      await Promise.race([sleep(ms), until]);
      return;
    }
    let timer;
    await Promise.race([new Promise((resolve) => (timer = setTimeout(resolve, ms))), until]);
    clearTimeout(timer);
  }

  let roundDir = null;
  let gateServer = null;
  let egressServer = null;
  let gateRelay = null;
  let registryFile = null;
  let progressFile = null;
  // pi 一旦起来，离开只有这几条路：退出后收尾、裁决后宽限到点、卡住、超时、出错。除了「退出后收尾」，
  // 都先 stopPi() 再 abort，所以收写闸（finally）之前 pi 一定已经结束。
  let pi = null;
  let piExited = false;
  async function stopPi() {
    if (!pi || piExited) return;
    try {
      pi.kill('SIGTERM');
    } catch {
      // 已经退了。
    }
    const raced = await Promise.race([
      Promise.resolve(pi.exit).then(() => 'exited'),
      sleep(killGraceMs).then(() => 'timeout'),
    ]);
    if (raced === 'timeout') {
      try {
        pi.kill('SIGKILL');
      } catch {
        // 已经退了。
      }
      await Promise.resolve(pi.exit);
    }
    piExited = true;
  }
  try {
    // 3. 写闸总开关关着：不认领、不写提醒（只读期每拍都会走到这里，写提醒就是刷屏）。心跳由 tick 记 gate: disabled。
    if (!fs.existsSync(paths.enabledFile)) {
      log('写闸总开关关着：不认领');
      return 3;
    }
    // 4. 沙箱探针放在认领之前：bwrap 起不来就不认领，issue 上不留「验收中 → 中断」的评论对。
    if (!(await probeBwrap(run))) {
      noteSandboxDown(paths, { issue, now, profile, log });
      return 1;
    }

    // 5. 认领（经写闸 exec）：退出码照抄；4 还要写一条提醒。
    const claimed = await callRound(['start', '--issue', issue]);
    if (claimed.code !== 0) {
      if (claimed.code === 4) {
        appendAlert(paths, { kind: 'write-rejected', issue, reason: '认领被写闸拒绝', detail: String(claimed.stderr || '').trim(), now, profile });
      }
      return claimed.code;
    }
    const claim = parseClaim(claimed.stdout);
    const roundStartedMs = now();
    const startedAt = new Date(roundStartedMs).toISOString();

    // 宿主侧进度（卡住判定以它为准）：认领时算一次，之后宿主看到 pi 输出增长、本轮写闸请求、预取进展就刷新。
    // 文件在 <home>/state/host/progress 下，沙箱看不见；stateDir 里模型写的 lastProgressAt 只作参考。
    const activity = { lastActivityMs: roundStartedMs, piLogBytes: 0, gateRequests: 0 };
    progressFile = progressFileFor(paths, issue, claim.round);
    function saveProgress() {
      try {
        writeRoundProgress(paths, {
          issue,
          round: claim.round,
          startedAt,
          lastActivityAt: new Date(activity.lastActivityMs).toISOString(),
          piLogBytes: activity.piLogBytes,
          gateRequests: activity.gateRequests,
        });
      } catch {
        // 写不下去不影响这一轮；tick 会回落到轮次评论的创建时间。
      }
    }
    function touch() {
      activity.lastActivityMs = now();
      saveProgress();
    }
    saveProgress();

    // 6. 轮次登记
    registryFile = path.join(paths.roundsDir, `${roundKey(issue, claim.round)}.json`);
    writeJsonAtomic(registryFile, {
      issue,
      round: claim.round,
      commentId: claim.commentId,
      pid: process.pid,
      piPid: null,
      startedAt,
    });

    async function abortWithAlert(kind, reason, detail) {
      const aborted = await callRound(['abort', '--issue', issue, '--round', String(claim.round), '--reason', reason]);
      appendAlert(paths, {
        kind,
        issue,
        round: claim.round,
        reason,
        detail: detail ?? (aborted?.code && aborted.code !== 0 ? String(aborted.stderr || '').trim() : undefined),
        now,
        profile,
      });
      return aborted;
    }

    roundDir = roundDirFor(paths, issue, claim.round);
    fs.mkdirSync(path.join(roundDir, 'tmp'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(roundDir, 'home'), { recursive: true, mode: 0o700 });

    // 7. 代码预取：宿主替这一轮检出任务树里每个仓的 main（凭证不进沙箱），之后只读挂进去。
    let code;
    try {
      code = await prefetch({ home, profile: hostProfile, github, run, issue, roundDir, env, now, sleep, touch });
    } catch (error) {
      await abortWithAlert('prefetch-failed', `代码预取失败：${String(error?.message || error)}`);
      return 1;
    }
    const codeDirs = (code || []).map((entry) => entry.path);

    // 7b. 依赖预装（方案 B）：宿主在模型沙箱之外按 lockfile 跑 npm ci --ignore-scripts，只读挂进去。
    //     装不上是环境问题：中止本轮（GitHub 上标「中断」并写明原因），不出任何代码结论，按退避稍后重试。
    let deps;
    try {
      deps = await predeps({ home, profile: hostProfile, hostConfig: settings, code: code || [], roundDir, env, run, repoRoot: root, touch, issue, round: claim.round });
    } catch (error) {
      await abortWithAlert('deps-failed', `${ENV_PROBLEM_PREFIX}依赖预装失败：${String(error?.message || error).slice(0, 300)}`, error?.detail);
      return 1;
    }
    const message = appendDepsInfo(appendCodePaths(claim.message, code || []), deps?.deps || []);

    // 8. 写闸 serve：绑定本轮，socket 权限 600。沙箱看到的是宿主转发的那个 socket（记本轮活动）。
    const socketPath = path.join(roundDir, 'gate', 'gate.sock');
    const innerSocket = path.join(paths.gateSocketsDir, `${slot.name}.sock`);
    try {
      gateServer = await startGate({
        home,
        socketPath: innerSocket,
        logFile: path.join(roundDir, 'gate.log'),
        binding: { root: issue, round: claim.round, commentId: claim.commentId },
        env: { ...env, ACCEPTANCE_WATCHER_HOME: home },
        repoRoot: root,
        now,
        sleep,
      });
      gateRelay = await startGateRelay({
        publicPath: socketPath,
        innerPath: innerSocket,
        onRequest: () => {
          activity.gateRequests += 1;
          touch();
        },
      });
    } catch (error) {
      await abortWithAlert('gate-unavailable', '写闸起不来', String(error?.message || error));
      return 1;
    }

    // 9. 沙箱：参数拼不出来就不跑模型。
    let sandboxReady = false;
    try {
      const rawProfile = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
      prepareSandboxProfile({ profile, roundDir, repoRoot: root, socketPath });
      for (const dir of [profile.stateDir, profile.worktreeDir]) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const masks = maskList({
        rawProfile,
        profile,
        hostConfig: settings,
        env: { ...process.env, HOME: env.HOME || process.env.HOME },
        home,
      });
      const sandboxBin = path.join(root, 'watchers', 'acceptance', 'host', 'sandbox-bin');
      // 环境只走 spawn 的 env（bwrap 原样传给 pi），不进 bwrap 参数：LLM key 不出现在 cmdline 里。
      const sandboxEnvironment = sandboxEnv({ base: env, roundDir, socketPath, sandboxBin, egressPort: EGRESS_BRIDGE_PORT });
      const bwrapArgs = buildBwrapArgs({
        home,
        profile,
        roundDir,
        masks,
        binds: [profile.stateDir, profile.worktreeDir],
        readOnlyBinds: [...codeDirs, ...(deps?.readOnlyBinds || [])],
        readOnlyMounts: deps?.mounts || [],
        tmpfsDirs: deps?.tmpfs || [],
        hostHome: env.HOME || process.env.HOME,
        homeAllow: defaultHomeAllow({ repoRoot: root, hostConfig: settings }),
      });
      // 出网代理：沙箱没有宿主网络，只经这个 socket 按 egressAllow 出网。起不来就不跑模型。
      egressServer = await startEgress({ home, hostConfig: settings, roundDir, issue, round: claim.round, profile, now });

      // 10. 起 pi（一定在 bwrap 里，先起出网桥再起 pi），派发消息从标准输入喂进去。
      sandboxReady = true;
      const piLog = path.join(roundDir, 'pi.log');
      pi = spawnPi({
        cmd: 'bwrap',
        args: [...bwrapArgs, '--', ...bridgeCommand({ socketPath: egressServer.socketPath }), ...piCommand],
        env: sandboxEnvironment,
        cwd: roundDir,
        logFile: piLog,
      });
      writeJsonAtomic(registryFile, {
        issue,
        round: claim.round,
        commentId: claim.commentId,
        pid: process.pid,
        piPid: pi.pid ?? null,
        startedAt,
      });
      if (pi.stdin && typeof pi.stdin.write === 'function') {
        pi.stdin.write(message);
        pi.stdin.write('\n');
        pi.stdin.end();
      }
      activity.piLogBytes = fileSize(piLog);

      // 裁决防线（helper 退出码 6）：模型把本轮标成「环境问题 / 未验证」时，宿主写一条 env-unverified 提醒（只写一次）。
      let envAlerted = false;
      const noteEnvUnverified = (status) => {
        if (envAlerted || !isEnvUnverified(status, claim.round)) return;
        envAlerted = true;
        appendAlert(paths, { kind: 'env-unverified', issue, round: claim.round, reason: status.reason, now, profile });
      };

      let finished = false;
      const exited = Promise.resolve(pi.exit).then((result) => {
        finished = true;
        piExited = true;
        return result;
      });

      // 11. 看着 pi：总时长上限 → 裁决已写还不退 → 宿主侧卡住判定。
      const stallMs = (profile.stallMinutes ?? 30) * 60 * 1000;
      let verdictSeenMs = null;
      while (!finished) {
        await waitTick(statusIntervalMs, exited);
        if (finished) break;
        const size = fileSize(piLog);
        if (size !== activity.piLogBytes) {
          activity.piLogBytes = size;
          touch();
        }
        if (now() - roundStartedMs >= maxRoundMs) {
          await stopPi();
          await abortWithAlert('round-timeout', `超过总时长上限（${maxRoundMinutes(settings)} 分钟）`);
          return 1;
        }
        const statusText = await callRound(['status', '--issue', issue, '--json']);
        const status = parseJsonLastLine(statusText.stdout);
        if (isTerminalFor(status, claim.round)) {
          noteEnvUnverified(status);
          if (verdictSeenMs === null) verdictSeenMs = now();
          if (now() - verdictSeenMs >= verdictGraceMs) {
            await stopPi();
            log(`第 ${claim.round} 轮已是「${status.status}」，pi 宽限后仍不退出：已结束进程`);
            return 0;
          }
          continue;
        }
        if (now() - activity.lastActivityMs > stallMs) {
          // 卡住：先结束进程，等它退出，再 abort。
          await stopPi();
          await abortWithAlert('round-stalled', '卡住：超过 stallMinutes 没有进度');
          return 1;
        }
      }

      // 12. pi 退出（任何退出码）：回读本轮状态。还是第 n 轮「验收中」就 abort 并写提醒；已是终态就正常收尾。
      const result = await exited;
      const exitCode = Number.isInteger(result?.code) ? result.code : 1;
      let status = null;
      try {
        status = parseJsonLastLine((await callRound(['status', '--issue', issue, '--json'])).stdout);
      } catch {
        status = null;
      }
      if (isTerminalFor(status, claim.round)) {
        noteEnvUnverified(status);
        return exitCode === 0 ? 0 : 1;
      }
      const reason = `pi 退出（code=${exitCode}${result?.signal ? `，${result.signal}` : ''}）但没写裁决`;
      const aborted = await callRound(['abort', '--issue', issue, '--round', String(claim.round), '--reason', reason]);
      // 3 = 已不是第 n 轮「验收中」（回读之后刚好写完裁决）：不算失败。
      if (aborted?.code === 3) return exitCode === 0 ? 0 : 1;
      appendAlert(paths, {
        kind: 'round-failed',
        issue,
        round: claim.round,
        reason,
        detail: aborted?.code && aborted.code !== 0 ? String(aborted.stderr || '').trim() : undefined,
        now,
        profile,
      });
      return 1;
    } catch (error) {
      const detail = String(error?.message || error);
      // 先停模型再 abort；pi 已经起来过就不是「沙箱起不来」，而是这一轮跑的时候出错。
      await stopPi();
      const reason = sandboxReady ? `宿主出错：${detail}` : `沙箱起不来：${detail}`;
      await callRound(['abort', '--issue', issue, '--round', String(claim.round), '--reason', reason]);
      appendAlert(paths, {
        kind: sandboxReady ? 'round-failed' : 'sandbox-unavailable',
        issue,
        round: claim.round,
        reason,
        now,
        profile,
      });
      return 1;
    }
  } finally {
    if (gateRelay) {
      try {
        await gateRelay.close();
      } catch {
        // 收尾失败不影响结果。
      }
    }
    if (gateServer) {
      try {
        await gateServer.stop();
      } catch {
        // 收尾失败不影响结果。
      }
    }
    if (egressServer) {
      try {
        await egressServer.stop();
      } catch {
        // 收尾失败不影响结果。
      }
    }
    if (registryFile) fs.rmSync(registryFile, { force: true });
    if (progressFile) fs.rmSync(progressFile, { force: true });
    if (roundDir) cleanRoundDir(roundDir);
    if (testLockHeld) releaseLock(paths.testLock);
    releaseLock(slot.file);
  }
}

async function main(argv) {
  const at = argv.indexOf('--issue');
  const issue = at === -1 ? undefined : argv[at + 1];
  const home = process.env.ACCEPTANCE_WATCHER_HOME;
  if (!issue || !home) {
    process.stderr.write('用法：ACCEPTANCE_WATCHER_HOME=<home> node host/round.mjs --issue <owner/repo#n>\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runHostRound({
    home,
    issue,
    env: process.env,
    // 内存门只读 /proc/meminfo，没有能改数据源的环境变量（测试通过参数注入）。
    meminfoPath: '/proc/meminfo',
  });
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
