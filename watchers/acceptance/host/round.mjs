#!/usr/bin/env node
// 一轮验收（#47 SC11）：起 pi 的唯一入口。
// 顺序：内存门 → 槽/测试锁 → 认领（经写闸 exec）→ 起写闸 serve → bwrap 参数 + 出网代理 → 跑 pi → 收尾。
// bwrap 起不来就不跑模型，这一轮 abort 成「中断」并写提醒；没有任何开关能绕过沙箱。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { createGithub } from '../bin/github.mjs';
import { runRound as runRoundCommand } from '../bin/round.mjs';
import { parseRef } from '../bin/rounds.mjs';
import { appendAlert, hostPaths, releaseLock, tryAcquireLock } from './paths.mjs';
import { buildBwrapArgs, defaultHomeAllow, maskList, prepareSandboxProfile, probeBwrap, sandboxEnv } from './sandbox.mjs';
import { EGRESS_BRIDGE_PORT, bridgeCommand, startRoundEgress } from './egress-proxy.mjs';
import { run as procRun, spawnDetached, spawnProcess } from './proc.mjs';

/** 内存门：MemAvailable 低于 3 GiB 就不认领、不跑模型。常量，不可配。 */
export const MEMORY_GATE_BYTES = 3 * 1024 ** 3;
/** 同一时间最多 2 轮（验收轮 + 修正轮合计）。常量，不可配。 */
export const MAX_ROUNDS = 2;
/** 跑 pi 时多久看一次进度。 */
export const STATUS_INTERVAL_MS = 60000;
/** 卡住后先 SIGTERM，等这么久还没退再 SIGKILL。 */
export const KILL_GRACE_MS = 10000;
/** mivo 的仓名（`/` 后面那段）以 mivo 开头就占测试锁。 */
const TEST_LOCK_PATTERN = /^mivo/i;
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

async function defaultStartGate({ home, socketPath, binding, env, repoRoot, sleep }) {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const logFile = path.join(path.dirname(path.dirname(socketPath)), 'gate.log');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawnDetached(
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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
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
    await sleep(100);
  }
  try {
    process.kill(child.pid, 'SIGKILL');
  } catch {
    // 已经退了。
  }
  throw new Error('写闸 serve 没起来');
}

function defaultSpawnPi({ cmd, args, env, cwd, logFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, 'a');
  const child = spawnProcess(cmd, args, { env, cwd, stdio: ['pipe', logFd, logFd] });
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
 * 0 跑完（pi 正常退出）；1 出错（含沙箱起不来、卡住）；3 什么都不做（内存不够 / 槽满 / 测试锁被占 / 不该认领）；
 * 4 写闸拒绝（已写提醒）。
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
  now = () => Date.now(),
  meminfoPath = '/proc/meminfo',
  statusIntervalMs = STATUS_INTERVAL_MS,
  killGraceMs = KILL_GRACE_MS,
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

  let roundDir = null;
  let gateServer = null;
  let egressServer = null;
  let registryFile = null;
  // pi 一旦起来，离开只有三条路：正常退出、卡住、出错。卡住和出错两条都先 stopPi() 再 abort，
  // 所以收写闸（finally）之前 pi 一定已经结束。
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
    // 3. 认领（经写闸 exec）：退出码照抄；4 还要写一条提醒。
    const claimed = await callRound(['start', '--issue', issue]);
    if (claimed.code !== 0) {
      if (claimed.code === 4) {
        appendAlert(paths, { kind: 'write-rejected', issue, reason: '认领被写闸拒绝', detail: String(claimed.stderr || '').trim(), now, profile });
      }
      return claimed.code;
    }
    const claim = parseClaim(claimed.stdout);

    // 4. 轮次登记
    registryFile = path.join(paths.roundsDir, `${roundKey(issue, claim.round)}.json`);
    writeJsonAtomic(registryFile, {
      issue,
      round: claim.round,
      commentId: claim.commentId,
      pid: process.pid,
      piPid: null,
      startedAt: new Date(now()).toISOString(),
    });

    // 5. 写闸 serve：绑定本轮，socket 权限 600。
    roundDir = roundDirFor(paths, issue, claim.round);
    fs.mkdirSync(path.join(roundDir, 'tmp'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(roundDir, 'home'), { recursive: true, mode: 0o700 });
    const socketPath = path.join(roundDir, 'gate', 'gate.sock');
    try {
      gateServer = await startGate({
        home,
        socketPath,
        binding: { root: issue, round: claim.round, commentId: claim.commentId },
        env: { ...env, ACCEPTANCE_WATCHER_HOME: home },
        repoRoot: root,
        now,
        sleep,
      });
    } catch (error) {
      await callRound(['abort', '--issue', issue, '--round', String(claim.round), '--reason', '写闸起不来']);
      appendAlert(paths, {
        kind: 'gate-unavailable',
        issue,
        round: claim.round,
        reason: '写闸起不来',
        detail: String(error?.message || error),
        now,
        profile,
      });
      return 1;
    }

    // 6. 沙箱：bwrap 不在、或参数拼不出来，就不跑模型。
    let sandboxReady = false;
    try {
      const bwrapOk = await probeBwrap(run);
      if (!bwrapOk) throw new Error('bwrap 不可用（命令不在或起不来）');
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
        hostHome: env.HOME || process.env.HOME,
        homeAllow: defaultHomeAllow({ repoRoot: root, hostConfig: settings }),
      });
      // 出网代理：沙箱没有宿主网络，只经这个 socket 按 egressAllow 出网。起不来就不跑模型。
      egressServer = await startEgress({ home, hostConfig: settings, roundDir, issue, round: claim.round, profile, now });

      // 7. 起 pi（一定在 bwrap 里，先起出网桥再起 pi），派发消息从标准输入喂进去。
      sandboxReady = true;
      pi = spawnPi({
        cmd: 'bwrap',
        args: [...bwrapArgs, '--', ...bridgeCommand({ socketPath: egressServer.socketPath }), ...piCommand],
        env: sandboxEnvironment,
        cwd: roundDir,
        logFile: path.join(roundDir, 'pi.log'),
      });
      writeJsonAtomic(registryFile, {
        issue,
        round: claim.round,
        commentId: claim.commentId,
        pid: process.pid,
        piPid: pi.pid ?? null,
        startedAt: new Date(now()).toISOString(),
      });
      if (pi.stdin && typeof pi.stdin.write === 'function') {
        pi.stdin.write(claim.message);
        pi.stdin.write('\n');
        pi.stdin.end();
      }

      let finished = false;
      const exited = Promise.resolve(pi.exit).then((result) => {
        finished = true;
        piExited = true;
        return result;
      });

      while (!finished) {
        await sleep(statusIntervalMs);
        if (finished) break;
        const statusText = await callRound(['status', '--issue', issue, '--json']);
        const status = parseJsonLastLine(statusText.stdout);
        if (!status || !status.stalled) continue;
        // 卡住：先结束进程，等它退出，再 abort。
        await stopPi();
        const reason = `卡住：超过 stallMinutes 没有进度`;
        await callRound(['abort', '--issue', issue, '--round', String(claim.round), '--reason', reason]);
        appendAlert(paths, { kind: 'round-stalled', issue, round: claim.round, reason, now, profile });
        return 1;
      }

      const result = await exited;
      return result?.code === 0 ? 0 : 1;
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
