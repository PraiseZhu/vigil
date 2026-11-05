#!/usr/bin/env node
// 常驻事件拉取器：把 event-pull.mjs 的 runEventChannel 接成能长期跑的程序。
// 只读两个 600 文件（事件拉取令牌、Worker 的 /pull 地址）：路径先看环境变量，缺省是 ~/acceptance/secrets 下的约定名。
// 权限不是 600 就拒绝启动，日志里只写原因，绝不回显令牌内容。
//
// 事件路径只做「单条精确读写」：每条事件先定位到 owner/repo#number，再交给注入的 syncOne
// （缺省动态加载 bin/prio-item.mjs，加载器在 ../prio-item-loader.mjs）。
// 整盘读看板要 72–131 秒，事件路径一次都不整盘读。
// 默认 dry-run（只算不写），--write 才真写。真写之前探测 /tmp/prio-write.lock：
// 抢不到每 2 秒重试、最多 10 秒，仍抢不到就抛错，本次事件不确认，留在 Worker 里下次再拉。
//
// 三层回退：Worker 正常 → 每 2 秒拉事件；Worker 连续失败 pollAfterFailures 次（缺省 3）→ 才跑 60 秒兜底轮询；
// 本进程整个挂掉 → 现有 30 分钟定时任务照旧收敛看板。兜底轮询只补写「事件写过但没写成功」的单条目标，
// 不整盘读，也不替现有定时任务做对账。
//
// 两个停写开关都遵守：<stateDir>/disabled（自动写入已暂停）→ 事件只确认不写；
// <stateDir>/event-run.disabled（本拉取器停用）→ 连拉都不拉，空转并写日志说明。
// 「关联 PR」这类 link 字段的门控标记 <stateDir>/mac-mini-stopped 由 syncOne 通过 linkAllowed 收口，这里只负责如实传。
// 日志写 <home>/state/host/event-run.log（和宿主其它日志同一目录风格），人话中文，超过 5MB 截断保留尾部。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSecretFile, explicitWatcherHome, ProfileError } from './profile.mjs';
import {
  DEFAULT_POLL_AFTER_FAILURES,
  POLL_INTERVAL_MS,
  PULL_INTERVAL_MS,
  confirmPulledEvents,
  pullFromWorker,
  reportEventFailure,
  runEventChannel,
} from './event-pull.mjs';
import { prIssueRefs } from './pr-link.mjs';
import { readAuthorizedRepos } from './prio-run.mjs';
import { SINGLE_ITEM_MODULE, loadSingleItemModule } from '../prio-item-loader.mjs';

/** 兜底轮询的门槛（缺省 3 次）由 event-pull.mjs 定义，这里只是转发，免得两边各写一份。 */
export { DEFAULT_POLL_AFTER_FAILURES };

/** 只处理这四类事件（Worker 侧也只订阅这四类）。其它类型到了也只确认不写。 */
export const EVENT_TYPES = Object.freeze(['issues', 'issue_comment', 'pull_request', 'pull_request_review']);
/** 现有写入入口共用的写锁。事件路径只借它，不改它的持有者。 */
export const WRITE_LOCK_FILE = '/tmp/prio-write.lock';
export const LOCK_RETRY_MS = 2000;
export const LOCK_WAIT_MAX_MS = 10000;
/** 单条读写模块（W4-d 提供，可能还没部署）。加载器在 ../prio-item-loader.mjs，这里只转出去。 */
export { SINGLE_ITEM_MODULE, loadSingleItemModule };
export const EVENT_RUN_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** 停用 / 空转这类重复日志最多每 60 秒一条。 */
const QUIET_LOG_MS = 60 * 1000;

export class EventRunConfigError extends Error {
  constructor(message, code = 'EVENT_RUN_CONFIG') {
    super(message);
    this.name = 'EventRunConfigError';
    this.code = code;
  }
}

export class WriteLockBusyError extends Error {
  constructor(message, code = 'WRITE_LOCK_BUSY') {
    super(message);
    this.name = 'WriteLockBusyError';
    this.code = code;
  }
}

function summarize(error) {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.slice(0, 200);
}

/** 日志行前面的时间戳。用注入时钟，测试里不读真实时间。 */
function stamp(now) {
  return new Date(now()).toISOString();
}

/**
 * 日志文件超过上限就截断，只保留尾部：从尾部取一半，去掉开头那半行，前面加一行说明。
 * 写坏日志不能挡住主流程，所以调用方把异常都吞掉。
 */
function rotateLog(file, { maxBytes }) {
  const keep = Math.max(1, Math.floor(maxBytes / 2));
  const data = fs.readFileSync(file);
  let tail = data.subarray(Math.max(0, data.length - keep));
  const firstBreak = tail.indexOf(0x0a);
  if (firstBreak >= 0 && firstBreak < tail.length - 1) tail = tail.subarray(firstBreak + 1);
  const header = Buffer.from(`（日志超过 ${maxBytes} 字节，已截断较早内容，只保留最近的部分）\n`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat([header, tail]), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 追加一行日志；超过上限先写完再截断。返回是否写成功（写不下去也不抛）。 */
export function appendEventRunLog(file, text, { maxBytes = EVENT_RUN_LOG_MAX_BYTES } = {}) {
  const body = String(text ?? '');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, body.endsWith('\n') ? body : `${body}\n`, { mode: 0o600 });
    if (fs.statSync(file).size > maxBytes) rotateLog(file, { maxBytes });
    return true;
  } catch {
    return false;
  }
}

/** 日志函数：一行一条，带时间戳，写进文件；交互式跑（stdout 是终端）时同时打到终端。 */
export function makeEventRunLogger(file, { now = () => Date.now(), stdout = null, maxBytes = EVENT_RUN_LOG_MAX_BYTES } = {}) {
  const out = stdout === null ? (process.stdout.isTTY ? process.stdout : null) : stdout;
  return function log(text) {
    const line = `${stamp(now)} ${text}`;
    if (out) out.write(`${line}\n`);
    appendEventRunLog(file, line, { maxBytes });
  };
}

/**
 * 事件拉取器用到的所有路径。环境变量只收绝对路径（相对路径按配置错误处理，不猜）。
 * home 的推导和宿主其它文件一致：ACCEPTANCE_WATCHER_HOME，没设就用 <homedir>/acceptance/home。
 */
export function eventRunPaths({ env = process.env, homeDir = os.homedir(), stateDir = null, logFile = null } = {}) {
  const absolute = (key, value) => {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !path.isAbsolute(value)) {
      throw new EventRunConfigError(`配置无效「${key}」：应为绝对路径，实际：${value === '' ? '（空）' : value}`);
    }
    return value;
  };
  const home = explicitWatcherHome(env) || path.join(homeDir, 'acceptance', 'home');
  const secretsDir = absolute('EVENT_RUN_SECRETS_DIR', env.EVENT_RUN_SECRETS_DIR)
    || path.join(homeDir, 'acceptance', 'secrets');
  const prioDir = absolute('EVENT_RUN_STATE_DIR', env.EVENT_RUN_STATE_DIR)
    || absolute('--state-dir', stateDir)
    || path.join(homeDir, 'acceptance', 'tools', '.prio');
  return {
    home,
    secretsDir,
    pullTokenFile: absolute('EVENT_PULL_TOKEN_FILE', env.EVENT_PULL_TOKEN_FILE)
      || path.join(secretsDir, 'event-pull-token'),
    workerUrlFile: absolute('EVENT_WORKER_URL_FILE', env.EVENT_WORKER_URL_FILE)
      || path.join(secretsDir, 'event-worker-url'),
    stateDir: prioDir,
    logFile: absolute('--log-file', logFile) || path.join(home, 'state', 'host', 'event-run.log'),
    disabledFile: path.join(prioDir, 'event-run.disabled'),
    prioDisabledFile: path.join(prioDir, 'disabled'),
    markerFile: path.join(prioDir, 'mac-mini-stopped'),
    authorizedReposFile: path.join(prioDir, 'authorized-repos.json'),
    latencyFile: path.join(prioDir, 'latency.jsonl'),
  };
}

/** 读一个 600 文件的内容。权限 / 存在性 / 属主由 checkSecretFile 判，错误信息只点名和原因。 */
function readSecretValue(file, key) {
  try {
    checkSecretFile(file, key);
  } catch (error) {
    if (error instanceof ProfileError) throw new EventRunConfigError(error.message);
    throw error;
  }
  let value = '';
  try {
    value = fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new EventRunConfigError(`配置无效「${key}」：读不到这个文件。`);
  }
  if (!value) throw new EventRunConfigError(`配置无效「${key}」：文件是空的。`);
  return value;
}

/**
 * 启动配置：拉取令牌与 Worker 的 /pull 地址都从 600 文件读。
 * 权限不是 600、文件不在、内容是空的、地址不是合法 http(s) URL，都直接抛 EventRunConfigError，不带出内容。
 */
export function readEventRunConfig({ env = process.env, homeDir = os.homedir(), paths = null, stateDir = null, logFile = null } = {}) {
  const resolved = paths || eventRunPaths({ env, homeDir, stateDir, logFile });
  const pullToken = readSecretValue(resolved.pullTokenFile, '事件拉取令牌');
  const workerUrl = readSecretValue(resolved.workerUrlFile, 'Worker 地址');
  let parsed;
  try {
    parsed = new URL(workerUrl);
  } catch {
    throw new EventRunConfigError('配置无效「Worker 地址」：文件内容不是合法 URL。');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new EventRunConfigError(`配置无效「Worker 地址」：只接受 http(s)，实际协议：${parsed.protocol}`);
  }
  return { pullToken, workerUrl, paths: resolved };
}

/** 一条 /proc/locks 行的设备号写法：major:minor 各自 %02x。 */
function deviceKey(stat) {
  const value = BigInt(stat.dev);
  const major = ((value >> 8n) & 0xfffn).toString(16).padStart(2, '0');
  const minor = ((value & 0xffn) | ((value >> 12n) & ~0xffn)).toString(16).padStart(2, '0');
  return `${major}:${minor}:${stat.ino}`;
}

/** /proc/locks 里是否已经列了这一条（file 形式的 flock 会列出来）。 */
function listedInProcLocks(stat, { procLocksFile, fsImpl }) {
  let text;
  try {
    text = fsImpl.readFileSync(procLocksFile, 'utf8');
  } catch {
    return null;
  }
  const key = deviceKey(stat);
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/);
    // 一行形如「12: FLOCK ADVISORY WRITE 3456 fe:10:7307 0 EOF」
    if (parts.length < 6) continue;
    if (parts[5] === key) return true;
  }
  return false;
}

/**
 * 有进程把这个锁文件开着吗：扫 /proc/<pid>/fd 的软链接。
 * 本机实测：`exec 8>锁文件; flock -n 8` 这种 fd 形式的 flock **不会**出现在 /proc/locks 里，
 * 但持锁进程一定开着这个 fd，所以这一路能把现有定时写入的锁看回来。
 * 代价：把「开着文件但没加锁」也算成忙（宁可少写一次，也不少锁一次）。
 */
function openedBySomeProcess(file, { procDir, fsImpl }) {
  let target;
  try {
    target = fsImpl.realpathSync(file);
  } catch {
    return null;
  }
  let pids;
  try {
    pids = fsImpl.readdirSync(procDir);
  } catch {
    return null;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    const fdDir = path.join(procDir, pid, 'fd');
    let fds;
    try {
      fds = fsImpl.readdirSync(fdDir);
    } catch {
      // 别人的进程读不到 fd 目录，跳过。
      continue;
    }
    for (const fd of fds) {
      let link;
      try {
        link = fsImpl.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      if (link === target) return true;
    }
  }
  return false;
}

/**
 * 写锁探测：锁文件不存在 = 空闲；/proc/locks 列了它 = 被占；有进程开着它 = 被占。
 * 两条都读不到（非 Linux）时返回 known:false，由调用方自己决定怎么说。
 *
 * 局限（过滤不了，只能如实写在这里）：Node 没有 flock 接口，bin/ 下又不许起子进程，
 * 所以本文件只能「探测」而不能「持有」这把锁。探测到空闲到真写之间有很窄的窗口，
 * 现有定时写入可能正好在这时拿到锁。这个窗口的代价是两边各写一次同一个白名单字段，
 * 不是数据错乱；要真互斥得让持锁的一方换实现，不在本次改动范围。
 */
export function writeLockHeld({ file = WRITE_LOCK_FILE, procLocksFile = '/proc/locks', procDir = '/proc', fsImpl = fs } = {}) {
  let stat;
  try {
    stat = fsImpl.statSync(file);
  } catch {
    // 锁文件还不存在：没有持有者，也没人开始占。
    return { held: false, known: true, reason: 'missing' };
  }
  const listed = listedInProcLocks(stat, { procLocksFile, fsImpl });
  if (listed === true) return { held: true, known: true, reason: 'proc-locks' };
  const opened = openedBySomeProcess(file, { procDir, fsImpl });
  if (opened === true) return { held: true, known: true, reason: 'open-fd' };
  if (listed === null && opened === null) return { held: false, known: false, reason: 'no-proc' };
  return { held: false, known: true, reason: 'free' };
}

/**
 * 抢写锁：每 retryMs 重试一次，总共最多等 maxWaitMs。仍被别人占着就抛 WriteLockBusyError，
 * 调用方因此不确认这条事件，留在 Worker 里下次再拉。
 * probe / sleep / now 都可注入，测试里用假时钟。
 */
export async function acquireWriteLock({
  file = WRITE_LOCK_FILE,
  retryMs = LOCK_RETRY_MS,
  maxWaitMs = LOCK_WAIT_MAX_MS,
  probe = () => writeLockHeld({ file }),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  let waited = 0;
  for (;;) {
    const state = probe() || { held: false, known: true };
    if (!state.held) return { waitedMs: waited, known: state.known !== false };
    if (waited >= maxWaitMs) break;
    const step = Math.min(retryMs, maxWaitMs - waited);
    await sleep(step);
    waited += step;
  }
  throw new WriteLockBusyError(
    `写锁一直被占用：等了 ${Math.round((now() - startedAt) / 1000)} 秒还没抢到（${file}）。这条事件先不确认，留在 Worker 里下次再拉。`,
  );
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * 一条事件能定位到的 owner/repo#number。定位不到就返回空数组（调用方只确认、不写）。
 * - issues / issue_comment：仓库 + issue 号直接定位；评论挂在 PR 上时按 PR 处理（见下）。
 * - pull_request / pull_request_review：按 pr-link.mjs 的现有规则反查任务 issue（正文「任务 issue：」行、
 *   Closes 行、acceptance/<号> 分支等），定位到几条就写几条。
 * 事件正文被 Worker 省略时只能用事件自带的 repo/number，只有 issues 这类能直接用。
 */
export function eventTargets(event) {
  const type = String(event?.event || '');
  const payload = event?.payload || null;
  const repo = String(payload?.repository?.full_name || event?.repo || '').trim();
  if (!repo.includes('/')) return [];
  const found = new Map();
  const add = (rawRepo, rawNumber, via) => {
    const name = String(rawRepo || '').trim();
    const number = numberOrNull(rawNumber);
    if (!name.includes('/') || !number) return;
    const ref = `${name}#${number}`;
    if (found.has(ref.toLowerCase())) return;
    found.set(ref.toLowerCase(), { repo: name, issue: number, ref, via });
  };
  const addRefs = (refs, via) => {
    for (const ref of refs || []) {
      const at = ref.lastIndexOf('#');
      if (at <= 0) continue;
      add(ref.slice(0, at), ref.slice(at + 1), via);
    }
  };

  if (type === 'issues') {
    add(repo, payload?.issue?.number ?? event?.number, 'issue');
  } else if (type === 'issue_comment') {
    const issue = payload?.issue || null;
    // 评论挂在 PR 上：payload.issue.number 是 PR 号，直接当 issue 号会写到不存在的条目上。
    if (issue && issue.pull_request) {
      addRefs(prIssueRefs({ repo, number: issue.number, body: issue.body, title: issue.title }), 'pr-comment');
    } else {
      add(repo, issue?.number ?? event?.number, 'comment');
    }
  } else if (type === 'pull_request' || type === 'pull_request_review') {
    const pr = payload?.pull_request || null;
    if (pr) {
      addRefs(
        prIssueRefs({
          repo,
          number: pr.number,
          body: pr.body,
          title: pr.title,
          headRefName: pr.head?.ref,
          state: pr.state,
          merged: pr.merged,
        }),
        'pr-link',
      );
    }
  }
  return [...found.values()];
}

/** 一次运行的共享状态：授权仓、每个目标的事件时间水位、没写成功的目标、只记一次的日志键。 */
export function createEventRunState({ allowedRepos = [] } = {}) {
  return {
    allowedRepos: new Set((allowedRepos || []).map((repo) => String(repo).toLowerCase())),
    watermarks: new Map(),
    pending: new Map(),
    logged: new Set(),
  };
}

/**
 * 事件处理与兜底轮询共用的一段逻辑：定位目标 → 过白名单与开关 → 抢锁 → 交给 syncOne 单条读写。
 * syncOne 是注入的依赖（缺省由 runEventRun 经 ../prio-item-loader.mjs 加载 bin/prio-item.mjs）。
 * 没有它就不写、也不假装写过。
 * 抛错的三种情况都会让这条事件不确认：抢不到写锁、单条读写模块没部署、syncOne 自己报错。
 */
export function createEventPipeline({
  state,
  paths,
  write = false,
  syncOne = null,
  lock = acquireWriteLock,
  logger = () => {},
  now = () => Date.now(),
  exists = (file) => fs.existsSync(file),
} = {}) {
  if (!state || !paths) throw new EventRunConfigError('事件处理需要 state 和 paths');

  let lastQuietAt = -Infinity;
  function logQuiet(text) {
    const at = now();
    if (at - lastQuietAt < QUIET_LOG_MS) return;
    lastQuietAt = at;
    logger(text);
  }
  function logOnce(key, text) {
    if (state.logged.has(key)) return;
    state.logged.add(key);
    logger(text);
  }

  function watermarkOf(ref) {
    return state.watermarks.get(String(ref).toLowerCase()) ?? null;
  }

  async function writeTarget(target, { event = null, createdMs = null, source = 'event' } = {}) {
    await lock();
    const linkAllowed = exists(paths.markerFile);
    if (!linkAllowed) logQuiet('没有 mac-mini-stopped 标记：「关联 PR」这类 link 字段交给 syncOne 扣住，这里不绕过');
    await syncOne({
      repo: target.repo,
      issue: target.issue,
      ref: target.ref,
      event,
      source,
      linkAllowed,
      now: now(),
    });
    if (Number.isFinite(createdMs)) state.watermarks.set(String(target.ref).toLowerCase(), createdMs);
  }

  async function onEvent(event) {
    const type = String(event?.event || '');
    if (!EVENT_TYPES.includes(type)) {
      logOnce(`type:${type}`, `不处理「${type}」这类事件（只订阅 issues、issue_comment、pull_request、pull_request_review），这条只确认不写`);
      return;
    }
    const targets = eventTargets(event);
    if (!targets.length) {
      logOnce(`nowhere:${type}`, `有一条 ${type} 事件定位不到 owner/repo#number（正文可能被 Worker 省略），这条只确认不写`);
      return;
    }
    const allowed = targets.filter((target) => state.allowedRepos.has(String(target.repo).toLowerCase()));
    if (!allowed.length) {
      logOnce(`repo:${targets[0].repo.toLowerCase()}`, `事件所属的仓（${targets[0].repo}）不在授权清单里，这条只确认不写`);
      return;
    }
    if (exists(paths.prioDisabledFile)) {
      logQuiet('.prio/disabled 存在，自动写入已暂停：这条事件只确认不写');
      return;
    }
    if (!write) {
      for (const target of allowed) {
        logger(`dry-run：本应单条读写 ${target.ref}（${target.via}），没有写；要真写请加 --write`);
      }
      return;
    }
    if (typeof syncOne !== 'function') {
      // 不确认：留在 Worker 里，模块部署后自动接着处理。连续失败到上限后由 Worker 放弃并留痕。
      logger('单条读写模块未部署，这条事件不确认、退回轮询（模块部署后自动补上）');
      throw new Error('单条读写模块未部署');
    }
    const createdMs = Date.parse(String(event?.created_at || ''));
    for (const target of allowed) {
      const key = String(target.ref).toLowerCase();
      const mark = watermarkOf(target.ref);
      if (Number.isFinite(createdMs) && Number.isFinite(mark) && createdMs < mark) {
        logger(
          `乱序：${target.ref} 的旧事件晚到（事件时间 ${event.created_at}，已经处理到 ${new Date(mark).toISOString()}），跳过、不覆盖`,
        );
        continue;
      }
      state.pending.set(key, target);
      try {
        await writeTarget(target, { event, createdMs, source: 'event' });
        state.pending.delete(key);
      } catch (error) {
        // 留在 pending 里，等兜底轮询再补一次；同时把错误抛出去，让这条事件保持不确认。
        throw error;
      }
    }
  }

  /**
   * 兜底轮询：Worker 连续失败时才被调用。只补写事件路径没写成功的目标（每条一次单条读写），
   * 不整盘读看板，也不返回事件（返回空数组）。
   */
  async function poll() {
    const pending = [...state.pending.values()];
    if (!pending.length) {
      logQuiet('Worker 连续失败，兜底轮询这一拍没有待补的单条目标（看板收敛交给现有的定时任务）');
      return [];
    }
    if (typeof syncOne !== 'function') {
      logQuiet('单条读写模块未部署，兜底轮询这一拍补不了：等模块部署后再说');
      return [];
    }
    for (const target of pending) {
      try {
        await writeTarget(target, { source: 'poll' });
        state.pending.delete(String(target.ref).toLowerCase());
        logger(`兜底轮询补写 ${target.ref} 完成`);
      } catch (error) {
        logger(`兜底轮询补写 ${target.ref} 失败：${summarize(error)}`);
      }
    }
    return [];
  }

  return { onEvent, poll };
}

/** 读授权仓清单（和 prio-run 共用一份文件与解析）。读不出来就当作空清单，宁可不写。 */
function readAllowedRepos(file, logger) {
  try {
    return readAuthorizedRepos(file);
  } catch (error) {
    logger(`授权清单读不出来（${summarize(error)}），事件只确认不写`);
    return [];
  }
}

/**
 * 跑常驻拉取循环。所有网络、锁、同步函数都可注入，测试里不碰真 Worker、不碰真看板。
 * 返回值就是 runEventChannel 的返回值（没有）。
 */
export async function runEventRun({
  config,
  write = config?.write === true,
  pollAfterFailures = config?.pollAfterFailures ?? DEFAULT_POLL_AFTER_FAILURES,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  fetchImpl = fetch,
  syncOne,
  loadModule = loadSingleItemModule,
  logger = null,
  channel = runEventChannel,
  until = null,
  signal,
  lock = acquireWriteLock,
  exists = (file) => fs.existsSync(file),
  state = null,
} = {}) {
  if (!config?.paths) throw new EventRunConfigError('事件拉取器缺少路径配置');
  const paths = config.paths;
  const log = logger || makeEventRunLogger(paths.logFile, { now });
  const shared = state || createEventRunState({ allowedRepos: readAllowedRepos(paths.authorizedReposFile, log) });
  const syncOneImpl = syncOne !== undefined ? syncOne : await loadModule();
  if (write && typeof syncOneImpl !== 'function') {
    log('单条读写模块未部署：事件只会被确认前先失败，不会写任何东西；等模块部署后再开 --write');
  }

  const disabled = () => exists(paths.disabledFile);
  let lastDisabledAt = -Infinity;
  const pull = async () => {
    if (disabled()) {
      const at = now();
      if (at - lastDisabledAt >= QUIET_LOG_MS) {
        lastDisabledAt = at;
        log('事件拉取已停用（event-run.disabled 存在）：这一拍不拉事件，事件留在 Worker 队列里，删掉这个文件后会自动补拉');
      }
      return [];
    }
    return pullFromWorker({ url: config.workerUrl, token: config.pullToken, fetchImpl });
  };

  const pipeline = createEventPipeline({
    state: shared,
    paths,
    write,
    syncOne: typeof syncOneImpl === 'function' ? syncOneImpl : null,
    lock,
    logger: log,
    now,
    exists,
  });

  const poll = async () => {
    if (disabled()) {
      const at = now();
      if (at - lastDisabledAt >= QUIET_LOG_MS) {
        lastDisabledAt = at;
        log('事件拉取已停用（event-run.disabled 存在）：兜底轮询这一拍也不跑');
      }
      return [];
    }
    return pipeline.poll();
  };

  return channel({
    now,
    sleep,
    until,
    signal,
    pull,
    poll,
    confirm: (ids) => confirmPulledEvents({ url: config.workerUrl, token: config.pullToken, ids, fetchImpl }),
    reportFailure: (event, error) => reportEventFailure({
      url: config.workerUrl,
      token: config.pullToken,
      id: event?.deliveryId,
      error: summarize(error),
      fetchImpl,
    }),
    onEvent: pipeline.onEvent,
    latencyFile: paths.latencyFile,
    pollAfterFailures,
  });
}

export function parsePollAfterFailures(raw) {
  const text = raw == null || raw === '' ? '（空）' : String(raw);
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new EventRunConfigError(`--poll-after-failures 期望 0 到 1000 的整数，实际：${text}`);
  }
  return parsed;
}

/** 命令行参数。默认 dry-run；`--write` 与 `--dry-run` 不能同时给。 */
export function parseEventRunArgs(argv = []) {
  const out = { write: false, dryRun: false, once: false, pollAfterFailures: null, stateDir: null, logFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      out.write = true;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--once') {
      out.once = true;
      continue;
    }
    if (arg === '--poll-after-failures' || arg === '--state-dir' || arg === '--log-file') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) {
        throw new EventRunConfigError(`缺少 ${arg} 的取值`);
      }
      if (arg === '--poll-after-failures') out.pollAfterFailures = parsePollAfterFailures(value);
      else if (arg === '--state-dir') out.stateDir = value;
      else out.logFile = value;
      i += 1;
      continue;
    }
    throw new EventRunConfigError(`无法识别的参数：${arg}`);
  }
  if (out.write && out.dryRun) throw new EventRunConfigError('不能同时传 --dry-run 和 --write');
  return out;
}

/** 入口：读配置，起常驻循环。启动阶段出错就把原因写进日志和 stderr，退出码 1。 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const env = deps.env || process.env;
  const homeDir = deps.homeDir || os.homedir();
  const stderr = deps.stderr || process.stderr;
  const now = deps.now || (() => Date.now());
  let paths;
  try {
    paths = deps.paths || eventRunPaths({ env, homeDir });
    const options = parseEventRunArgs(argv);
    const config = deps.config || readEventRunConfig({
      env,
      homeDir,
      paths: deps.paths || eventRunPaths({ env, homeDir, stateDir: options.stateDir, logFile: options.logFile }),
    });
    const log = deps.logger || makeEventRunLogger(config.paths.logFile, { now, stdout: deps.stdout ?? null });
    log(
      `事件拉取器启动：每 ${PULL_INTERVAL_MS / 1000} 秒拉一次；Worker 连续失败 ${options.pollAfterFailures ?? DEFAULT_POLL_AFTER_FAILURES} 次后才跑 ${POLL_INTERVAL_MS / 1000} 秒兜底轮询；${options.write ? '--write 真写' : 'dry-run 只算不写'}`,
    );
    // `--once` 只跑一拍：给 until 留半个拉取间隔（1 秒）的窗口，而不是 now()+1 毫秒——
    // 后者到循环真正开始时已经过期，一拍都跑不到（箱上自测碰到过）。第一拍跑完 nextAt 就是 2 秒后，必定退出。
    const until = options.once ? now() + PULL_INTERVAL_MS / 2 : null;
    await runEventRun({
      config: { ...config, write: options.write, pollAfterFailures: options.pollAfterFailures ?? DEFAULT_POLL_AFTER_FAILURES },
      write: options.write,
      pollAfterFailures: options.pollAfterFailures ?? DEFAULT_POLL_AFTER_FAILURES,
      logger: log,
      now,
      until,
      signal: deps.signal,
      lock: deps.lock || acquireWriteLock,
      syncOne: deps.syncOne,
      loadModule: deps.loadModule || loadSingleItemModule,
      channel: deps.channel || runEventChannel,
      fetchImpl: deps.fetchImpl || fetch,
      sleep: deps.sleep,
      state: deps.state || null,
      exists: deps.exists || ((file) => fs.existsSync(file)),
    });
    log('事件拉取器已退出');
    return { exitCode: 0, paths: config.paths };
  } catch (error) {
    const text = `启动失败：${summarize(error)}`;
    if (paths?.logFile) appendEventRunLog(paths.logFile, `${stamp(now)} ${text}`);
    stderr.write(`${text}\n`);
    if (!deps.capture) process.exitCode = 1;
    return { exitCode: 1, error };
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (invoked && here === invoked) {
  const controller = new AbortController();
  // 收到 SIGINT / SIGTERM：先记一行，再让循环自己收尾退出。路径解析失败也不挡退出。
  const noteExit = (text) => {
    try {
      appendEventRunLog(eventRunPaths().logFile, `${new Date().toISOString()} ${text}`);
    } catch {
      // 日志写不下去不影响退出。
    }
  };
  for (const name of ['SIGINT', 'SIGTERM']) {
    process.on(name, () => {
      noteExit(`收到 ${name}，拉取器退出`);
      controller.abort();
    });
  }
  main(process.argv.slice(2), { signal: controller.signal }).catch((error) => {
    process.stderr.write(`${summarize(error)}\n`);
    process.exitCode = 1;
  });
}
