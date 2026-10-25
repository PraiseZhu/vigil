#!/usr/bin/env node
// 有争议条目的只读裁决运行（#46 SC8 / #43）：验收方和修正方各执一词时，宿主另起一个 pi 判一次。
//
// - 触发：poll 报出 `adjudicate: true` 的条目（最近一次裁决里有「有争议」、还没有裁决结果），tick 调
//   scheduleAdjudications 起一个后台进程 `host/adjudicate.mjs run`。同一任务同一轮同时只有一个（锁），
//   出过结果就不再起；和验收轮、修正轮共用两个槽和内存门（直接用 host/round.mjs 的导出）。
// - 运行：和验收轮同一个 bwrap 沙箱（host/sandbox.mjs 的公开函数；自己的网络命名空间，出网只经
//   host/egress-proxy.mjs 按 host.json egressAllow 放行，环境走 spawn 的 env），但**不给写闸 socket**：
//   沙箱里的 gh 直接拒绝、helper 读不到 profile，沙箱里也没有任何令牌，GitHub 一个字都写不了；
//   输入（争议条目、SC 原文、双方理由、相关 PR）由宿主在沙箱外只读收好，写进派发消息；代码和验收轮一样
//   由宿主预取（host/prefetch.mjs）、只读挂进沙箱。
// - 输出：pi 最后一行输出 `{"items":[{"ref","sc","ruling":"成立"|"不成立","why"}]}`；宿主校验后写进
//   <home>/state/host/adjudications/<roundKey>.json（宿主状态目录，沙箱里整个被遮掉，模型写不了）。
// - 卡死防护：总时长上限 host.json `adjudicateMaxMinutes`（默认 30），超时先结束进程再写提醒；
//   失败最多重试 2 次（一共 3 次），用完写 `adjudicate-needs-human` 提醒。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { createGithub } from '../bin/github.mjs';
import { collectTree } from '../bin/collect.mjs';
import { redact } from '../bin/redact.mjs';
import { acquireSlot, MEMORY_GATE_BYTES, readHostConfig, readMemAvailable } from './round.mjs';
import { buildBwrapArgs, defaultHomeAllow, maskList, probeBwrap, sandboxEnv } from './sandbox.mjs';
import { EGRESS_BRIDGE_PORT, bridgeCommand, startRoundEgress } from './egress-proxy.mjs';
import { prefetchCode } from './prefetch.mjs';
import { appendAlert, hostPaths, isAlive, readLockPayload, releaseLock, tryAcquireLock } from './paths.mjs';
import { run as procRun, spawnDetached, spawnProcess } from './proc.mjs';
import {
  RULINGS,
  adjudicationKey,
  adjudicationPaths,
  cleanWhy,
  readAdjudication,
  readJson,
  writeAdjudication,
  writeJsonAtomic,
} from './adjudication-store.mjs';

/** 默认总时长上限（分钟），host.json 的 adjudicateMaxMinutes 可改。 */
export const DEFAULT_MAX_MINUTES = 30;
/** 一共最多跑 3 次（第一次 + 重试 2 次）。 */
export const MAX_ATTEMPTS = 3;
/** 失败后至少隔这么久再试。 */
export const RETRY_DELAY_MS = 5 * 60 * 1000;
/** 没配 adjudicateCommand 的提醒一天一次。 */
export const NOT_CONFIGURED_EVERY_MS = 24 * 60 * 60 * 1000;
export const KILL_GRACE_MS = 10000;

const ISSUE_PATTERN = /^[\w.-]+\/[\w.-]+#\d+$/;
const ITEM_PATTERN = /^([\w.-]+\/[\w.-]+#\d+)\s*SC(\d+)$/;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** host.json 的 adjudicateCommand：非空字符串数组；没配（或形状不对）返回 null —— 不起裁决运行。 */
export function adjudicateCommandOf(hostConfig) {
  const command = hostConfig?.adjudicateCommand;
  if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string' || !item)) {
    return null;
  }
  return [...command];
}

export function maxMinutesOf(hostConfig) {
  const value = Number(hostConfig?.adjudicateMaxMinutes);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_MINUTES;
}

export function parseItem(text) {
  const match = ITEM_PATTERN.exec(String(text || '').trim());
  return match ? { ref: match[1], sc: Number(match[2]) } : null;
}

/** 「有争议」行里的双方理由：`… · 验收方：A · 修正方：B`。 */
export function parseSides(line) {
  const text = String(line || '');
  const acceptance = /验收方：(.*?)(?:\s*·\s*修正方：|$)/.exec(text);
  const correction = /修正方：(.*)$/.exec(text);
  return {
    acceptance: acceptance ? acceptance[1].trim() : '',
    correction: correction ? correction[1].trim() : '',
  };
}

/**
 * 从任务树（bin/collect.mjs 的 collectTree，只读）里给每条争议找 SC 原文、双方理由、相关 PR。
 * `required` 是 ['owner/repo#n SC<k>', …]。
 */
export function buildInputs(tree, required, profile) {
  const out = [];
  for (const key of required) {
    const item = parseItem(key);
    if (!item) continue;
    const issue = (tree?.issues || []).find((entry) => entry.ref === item.ref);
    const sc = (issue?.items || []).find((entry) => entry.sc === item.sc);
    const lines = (tree?.disputed || []).filter((entry) => entry.item === `${item.ref} SC${item.sc}`);
    const sides = { acceptance: [], correction: [] };
    for (const entry of lines) {
      const parsed = parseSides(entry.text);
      if (parsed.acceptance) sides.acceptance.push(parsed.acceptance);
      if (parsed.correction) sides.correction.push(parsed.correction);
    }
    out.push({
      ref: item.ref,
      sc: item.sc,
      text: redact(sc?.text || '（原文没找到）', profile),
      acceptance: redact(sides.acceptance.join('；') || '（没写）', profile),
      correction: redact(sides.correction.join('；') || '（没写）', profile),
      lines: lines.map((entry) => ({ source: entry.source, text: redact(entry.text, profile), url: entry.url })),
      prs: (issue?.prs || []).map((pr) => ({ ref: pr.ref, url: pr.url, merged: Boolean(pr.mergedAt) })),
    });
  }
  return out;
}

/** 给裁决 pi 的消息（从标准输入喂进去）。 */
export function buildAdjudicationMessage({ issue, round, inputs, codeDirs = [] }) {
  const example = JSON.stringify({ items: [{ ref: 'owner/repo#12', sc: 3, ruling: '成立', why: '一两句理由' }] });
  return [
    '你是验收机的只读裁决运行。验收方和修正方对下面几条验收项各执一词，请判断「要修」是否成立。',
    '',
    `任务：${issue}（第 ${round} 轮裁决里的有争议条目）`,
    '',
    '规则：',
    '- 只读：不写 GitHub（不调 gh 写、不跑 helper.mjs 的任何命令），不改任何仓库文件；临时文件只写 $TMPDIR。',
    '- 只按证据判：验收项原文、双方理由、相关 PR 和代码。',
    codeDirs.length
      ? `- 代码：宿主替你检出好了各仓最新 main（只读）：${codeDirs.join('、')}；要改着试就拷到 $TMPDIR 里。`
      : '- 代码：这一次没有预取到代码，只按原文、理由和 PR 判。',
    '- 每条只给一个结论：「成立」= 验收方对（这一条要修）；「不成立」= 修正方对（这一条通过）。',
    '- 每一条都要给结论，理由一两句、不写本机路径和令牌。',
    `- 最后一行只输出一个单行 JSON（不要代码块），形如：${example}`,
    '',
    '条目（JSON）：',
    JSON.stringify(inputs, null, 2),
  ].join('\n');
}

function candidateJsons(text) {
  const out = [];
  const lines = String(text || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim().replace(/^`+|`+$/g, '').trim();
    if (line.startsWith('{') && line.includes('"items"')) out.push(line);
  }
  // 多行 JSON（模型没按单行写）：从最后一个 {"items" 开始截到末尾，去掉代码块收尾。
  const at = String(text || '').lastIndexOf('{"items"');
  if (at !== -1) out.push(String(text).slice(at).replace(/`+\s*$/g, '').trim());
  return out;
}

/**
 * 解析 pi 的输出：取最后一个带 items 的 JSON，逐条校验。每条争议都要有结论（「成立」/「不成立」），
 * 多出来的条目丢掉，理由过 redact、压成一行。
 */
export function parseRulings(text, required, profile) {
  const wanted = required.map(parseItem).filter(Boolean);
  for (const candidate of candidateJsons(text)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!parsed || !Array.isArray(parsed.items)) continue;
    const items = [];
    for (const want of wanted) {
      const found = parsed.items.find(
        (item) => item && String(item.ref || '').trim() === want.ref && Number(item.sc) === want.sc && RULINGS.includes(item.ruling),
      );
      if (!found) return { ok: false, error: `缺 ${want.ref} SC${want.sc} 的结论` };
      items.push({ ref: want.ref, sc: want.sc, ruling: found.ruling, why: cleanWhy(redact(String(found.why ?? ''), profile)) });
    }
    return { ok: true, items };
  }
  return { ok: false, error: '输出里没有裁决 JSON' };
}

function readRun(paths, issue, round) {
  const data = readJson(paths.runFile(issue, round));
  return data && typeof data === 'object' ? data : {};
}

function writeRun(paths, issue, round, data) {
  writeJsonAtomic(paths.runFile(issue, round), { issue, round, ...data });
}

/**
 * tick 调这里：给每条「等裁决」的条目起一个后台裁决进程。返回 `{ started, skipped, free }`。
 * - 没配 adjudicateCommand：一个都不起，写一条 `adjudicate-not-configured` 提醒（一天一次）。
 * - 已有结果 / 次数用完 / 正在跑 / 还没到重试时间 / 没有空槽的跳过。
 */
export function scheduleAdjudications({ home, entries, hostConfig, spawn, now = () => Date.now(), free = 1, profile }) {
  const paths = adjudicationPaths(home);
  const hp = hostPaths(home);
  const started = [];
  const skipped = [];
  const wanted = (entries || []).filter(
    (entry) => entry && entry.adjudicate && ISSUE_PATTERN.test(String(entry.issue)) && Number.isInteger(entry.round),
  );
  if (!wanted.length) return { started, skipped, free };

  if (!adjudicateCommandOf(hostConfig)) {
    const last = Date.parse(readJson(paths.notConfiguredFile)?.lastAlertAt ?? '');
    if (!Number.isFinite(last) || now() - last >= NOT_CONFIGURED_EVERY_MS) {
      appendAlert(hp, {
        kind: 'adjudicate-not-configured',
        issue: wanted[0].issue,
        round: wanted[0].round,
        reason: `有 ${wanted.length} 个任务的有争议条目在等裁决，但 host.json 没配 adjudicateCommand`,
        now,
        profile,
      });
      writeJsonAtomic(paths.notConfiguredFile, { lastAlertAt: new Date(now()).toISOString() });
    }
    for (const entry of wanted) skipped.push({ issue: entry.issue, round: entry.round, reason: 'not-configured' });
    return { started, skipped, free };
  }

  for (const entry of wanted) {
    const { issue, round } = entry;
    const skip = (reason) => skipped.push({ issue, round, reason });
    if (readAdjudication(home, issue, round)) {
      skip('done');
      continue;
    }
    const state = readRun(paths, issue, round);
    if (state.givenUp || (Number(state.attempts) || 0) >= MAX_ATTEMPTS) {
      skip('given-up');
      continue;
    }
    const lock = readLockPayload(paths.lockFile(issue, round));
    if ((lock && isAlive(Number(lock.pid))) || isAlive(Number(state.spawnedPid))) {
      skip('running');
      continue;
    }
    const nextAt = Date.parse(state.nextAttemptAt ?? '');
    if (Number.isFinite(nextAt) && now() < nextAt) {
      skip('retry-later');
      continue;
    }
    if (free <= 0) {
      skip('no-slot');
      continue;
    }
    const items = (entry.items || []).filter((item) => parseItem(item));
    if (!items.length) {
      skip('no-items');
      continue;
    }
    const pid = spawn({ issue, round, items });
    writeRun(paths, issue, round, { ...state, spawnedPid: pid ?? null, spawnedAt: new Date(now()).toISOString() });
    started.push({ issue, round, pid: pid ?? null });
    free -= 1;
  }
  return { started, skipped, free };
}

export function defaultSpawnAdjudicate({ home, env = process.env, root }) {
  const repoRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  return ({ issue, round, items }) => {
    const logFd = fs.openSync(path.join(hostPaths(home).hostDir, 'adjudicate.log'), 'a');
    try {
      const args = [path.join(repoRoot, 'watchers', 'acceptance', 'host', 'adjudicate.mjs'), 'run', '--issue', issue, '--round', String(round)];
      for (const item of items) args.push('--item', item);
      const child = spawnDetached(process.execPath, args, {
        env: { ...env, ACCEPTANCE_WATCHER_HOME: home },
        cwd: home,
        stdio: ['ignore', logFd, logFd],
      });
      return child.pid;
    } finally {
      fs.closeSync(logFd);
    }
  };
}

function defaultSpawnPi({ cmd, args, env, cwd, stdoutFile, logFile }) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const outFd = fs.openSync(stdoutFile, 'w');
  const logFd = fs.openSync(logFile, 'a');
  const child = spawnProcess(cmd, args, { env, cwd, stdio: ['pipe', outFd, logFd] });
  fs.closeSync(outFd);
  fs.closeSync(logFd);
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

/** 除日志外清掉裁决目录（tmp / home）。 */
function cleanDir(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'pi.log' || name === 'out.log') continue;
    try {
      fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    } catch {
      // 清不掉不影响结果。
    }
  }
}

/**
 * 裁决运行在宿主上的工作目录（沙箱里唯一可写的地方）：<home>/run/adj-<roundKey 的 sha256 前 12 位>。
 * 不直接用 roundKey：出网代理的 unix socket 放在这下面，路径超过 108 字节就监听不了，仓名长一点就会撞上。
 */
export function adjudicationRunDir(home, issue, round) {
  const digest = crypto.createHash('sha256').update(adjudicationKey(issue, round), 'utf8').digest('hex').slice(0, 12);
  return path.join(hostPaths(home).roundRunDir, `adj-${digest}`);
}

/**
 * 跑一次裁决。返回退出码：0 出了结果；1 这一次失败（算一次尝试，已写提醒）；
 * 3 什么都没做（没配命令 / 已有结果 / 次数用完 / 正在跑 / 内存门 / 没有空槽，不算尝试）。
 */
export async function runAdjudication({
  home,
  issue,
  round,
  items,
  env = process.env,
  run = procRun,
  spawnPi = defaultSpawnPi,
  startEgress = startRoundEgress,
  prefetch = prefetchCode,
  github,
  now = () => Date.now(),
  meminfoPath = '/proc/meminfo',
  sleep = defaultSleep,
  killGraceMs = KILL_GRACE_MS,
  hostConfig,
  repoRoot,
  log = (message) => process.stderr.write(`${message}\n`),
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('runAdjudication 需要绝对路径的 home');
  if (typeof issue !== 'string' || !ISSUE_PATTERN.test(issue)) throw new Error('issue 应为 owner/repo#编号');
  if (!Number.isInteger(round) || round <= 0) throw new Error('round 应为正整数');
  const required = (items || []).filter((item) => parseItem(item));
  if (!required.length) throw new Error('至少要一条争议条目（owner/repo#n SC<k>）');

  const root = repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const hp = hostPaths(home);
  const paths = adjudicationPaths(home);
  const settings = hostConfig || readHostConfig(hp.hostConfig);
  const command = adjudicateCommandOf(settings);
  if (!command) {
    log('host.json 没配 adjudicateCommand，不起裁决运行');
    return 3;
  }
  if (readAdjudication(home, issue, round)) return 3;
  if ((Number(readRun(paths, issue, round).attempts) || 0) >= MAX_ATTEMPTS) return 3;

  // 资源门和验收轮一样：内存门 → 槽。都放在任何工作之前，不够就等下一拍（不算一次尝试）。
  const available = readMemAvailable(meminfoPath);
  if (available == null || available < MEMORY_GATE_BYTES) {
    log(`内存门：MemAvailable ${available ?? '读不到'}，这一拍不起裁决`);
    return 3;
  }
  const lockFile = paths.lockFile(issue, round);
  if (!tryAcquireLock(lockFile, { now })) {
    log('这一轮的裁决已经在跑');
    return 3;
  }
  const slot = acquireSlot(hp, now);
  if (!slot) {
    releaseLock(lockFile);
    log('槽位已满，这一拍不起裁决');
    return 3;
  }

  const before = readRun(paths, issue, round);
  const attempts = (Number(before.attempts) || 0) + 1;
  writeRun(paths, issue, round, { ...before, attempts, pid: process.pid, startedAt: new Date(now()).toISOString() });

  let profile;
  const dir = adjudicationRunDir(home, issue, round);
  let pi = null;
  let piExited = false;
  let egressServer = null;
  async function stopPi() {
    if (!pi || piExited) return;
    pi.kill('SIGTERM');
    const raced = await Promise.race([Promise.resolve(pi.exit).then(() => 'exited'), sleep(killGraceMs).then(() => 'timeout')]);
    if (raced === 'timeout') {
      pi.kill('SIGKILL');
      await Promise.resolve(pi.exit);
    }
    piExited = true;
  }

  const failed = (kind, reason, detail) => {
    const exhausted = attempts >= MAX_ATTEMPTS;
    writeRun(paths, issue, round, {
      ...readRun(paths, issue, round),
      attempts,
      pid: null,
      lastError: redact(reason, profile),
      failedAt: new Date(now()).toISOString(),
      nextAttemptAt: exhausted ? null : new Date(now() + RETRY_DELAY_MS).toISOString(),
      givenUp: exhausted,
    });
    appendAlert(hp, { kind, issue, round, reason, detail, attempt: attempts, now, profile });
    if (exhausted) {
      appendAlert(hp, {
        kind: 'adjudicate-needs-human',
        issue,
        round,
        reason: `裁决运行 ${attempts} 次都没出结果，需要人工裁决：${required.join('、')}`,
        detail: reason,
        now,
        profile,
      });
    }
    return 1;
  };

  try {
    try {
      profile = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
    } catch (error) {
      return failed('adjudicate-failed', '裁决运行读不到 profile', String(error?.message || error));
    }

    // 1. 输入：在沙箱外只读收集（只暴露 graphql 和取代码的 fetchBranch，没有 write）。
    fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'home'), { recursive: true, mode: 0o700 });
    let inputs;
    const reader = github || createGithub({ profile: { ...profile, writeCommand: undefined }, run });
    const readOnly = {
      graphql: (query, variables) => reader.graphql(query, variables),
      fetchBranch: typeof reader.fetchBranch === 'function' ? (options) => reader.fetchBranch(options) : undefined,
    };
    try {
      const tree = await collectTree({ github: readOnly, profile, ref: issue });
      inputs = buildInputs(tree, required, profile);
    } catch (error) {
      return failed('adjudicate-failed', '裁决运行收集争议条目失败', String(error?.message || error));
    }
    // 代码：和验收轮一样由宿主预取各仓 main（凭证不进沙箱），只读挂进去。
    let code;
    try {
      code = await prefetch({ home, profile, github: readOnly, run, issue, roundDir: dir, env, now, sleep });
    } catch (error) {
      return failed('adjudicate-failed', `裁决运行代码预取失败：${String(error?.message || error)}`);
    }
    const codeDirs = (code || []).map((entry) => entry.path).filter((item) => typeof item === 'string' && path.isAbsolute(item));

    // 2. 沙箱：和验收轮同一套公开函数；不传 socketPath —— 沙箱里没有写闸，gh 和 helper 都写不了。
    //    环境只走 spawn 的 env（不进 bwrap 参数）；出网和验收轮一样只经出网代理。
    let sandboxEnvironment;
    let bwrapArgs;
    try {
      if (!(await probeBwrap(run))) throw new Error('bwrap 不可用（命令不在或起不来）');
      const rawProfile = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
      const masks = maskList({
        rawProfile,
        profile,
        hostConfig: settings,
        env: { ...process.env, HOME: env.HOME || process.env.HOME },
        home,
      });
      const sandboxBin = path.join(root, 'watchers', 'acceptance', 'host', 'sandbox-bin');
      sandboxEnvironment = sandboxEnv({ base: env, roundDir: dir, sandboxBin, egressPort: EGRESS_BRIDGE_PORT });
      bwrapArgs = buildBwrapArgs({
        home,
        profile,
        roundDir: dir,
        masks,
        binds: [],
        readOnlyBinds: codeDirs,
        hostHome: env.HOME || process.env.HOME,
        homeAllow: defaultHomeAllow({ repoRoot: root, hostConfig: settings }),
      });
      egressServer = await startEgress({ home, hostConfig: settings, roundDir: dir, issue, round, profile, now });
    } catch (error) {
      return failed('adjudicate-failed', `裁决运行沙箱起不来：${String(error?.message || error)}`);
    }

    // 3. 起 pi（一定在 bwrap 里），总时长有上限。
    const message = buildAdjudicationMessage({ issue, round, inputs, codeDirs });
    const stdoutFile = path.join(dir, 'out.log');
    pi = spawnPi({
      cmd: 'bwrap',
      args: [...bwrapArgs, '--', ...bridgeCommand({ socketPath: egressServer.socketPath }), ...command],
      env: sandboxEnvironment,
      cwd: dir,
      stdoutFile,
      logFile: path.join(dir, 'pi.log'),
    });
    if (pi.stdin && typeof pi.stdin.write === 'function') {
      pi.stdin.write(message);
      pi.stdin.write('\n');
      pi.stdin.end();
    }
    const maxMs = maxMinutesOf(settings) * 60000;
    let timer;
    const outcome = await Promise.race([
      Promise.resolve(pi.exit).then((result) => {
        piExited = true;
        return { result };
      }),
      new Promise((resolve) => {
        // 真定时器、跑完就清：出了结果不能让进程再挂 30 分钟。
        timer = setTimeout(() => resolve({ timeout: true }), maxMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome.timeout) {
      await stopPi();
      return failed('adjudicate-timeout', `裁决运行超过 ${maxMinutesOf(settings)} 分钟没结束，已结束进程`);
    }
    if (outcome.result?.code !== 0) {
      return failed('adjudicate-failed', `裁决 pi 退出码 ${outcome.result?.code ?? '未知'}`);
    }

    // 4. 解析结果，写进宿主状态目录。
    let text = '';
    try {
      text = fs.readFileSync(stdoutFile, 'utf8');
    } catch {
      text = '';
    }
    const parsed = parseRulings(text, required, profile);
    if (!parsed.ok) return failed('adjudicate-failed', `裁决输出不合格：${parsed.error}`);
    const file = writeAdjudication(home, issue, round, { items: parsed.items, at: new Date(now()).toISOString() });
    writeRun(paths, issue, round, { ...readRun(paths, issue, round), attempts, pid: null, done: true, doneAt: new Date(now()).toISOString() });
    log(`裁决结果写进 ${path.basename(file)}`);
    return 0;
  } catch (error) {
    await stopPi();
    return failed('adjudicate-failed', `裁决运行出错：${String(error?.message || error)}`);
  } finally {
    if (egressServer) {
      try {
        await egressServer.stop();
      } catch {
        // 收尾失败不影响结果。
      }
    }
    cleanDir(dir);
    releaseLock(slot.file);
    releaseLock(lockFile);
  }
}

function parseArgs(argv) {
  const out = { items: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--issue') out.issue = argv[++i];
    else if (arg === '--round') out.round = Number(argv[++i]);
    else if (arg === '--item') out.items.push(argv[++i]);
  }
  return out;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const home = process.env.ACCEPTANCE_WATCHER_HOME;
  if (command !== 'run' || !home || !args.issue || !Number.isInteger(args.round) || !args.items.length) {
    process.stderr.write(
      '用法：ACCEPTANCE_WATCHER_HOME=<home> node host/adjudicate.mjs run --issue <owner/repo#n> --round <n> --item "<owner/repo#n> SC<k>" [...]\n',
    );
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runAdjudication({ home, issue: args.issue, round: args.round, items: args.items, env: process.env });
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
