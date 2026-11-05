#!/usr/bin/env node
// 常驻事件拉取器：把 event-pull.mjs 的 runEventChannel 接成能长期跑的程序。
// 只读两个 600 文件（事件拉取令牌、Worker 的 /pull 地址）：路径先看环境变量，缺省是 ~/acceptance/secrets 下的约定名。
// 权限不是 600 就拒绝启动，日志里只写原因，绝不回显令牌内容。
//
// 事件路径只做「单条精确读写」：每条事件先定位到 owner/repo#number，再交给注入的 syncOne
// （缺省动态加载 bin/prio-item.mjs 的 syncEventItem，加载器在 ../prio-item-loader.mjs）。
// 整盘读看板要 72–131 秒，事件路径一次都不整盘读。
// 默认 dry-run（只算不写），--write 才真写。写锁只在 syncEventItem 内部抢（bin/prio-lock.mjs 的 withWriteLock，
// 和整盘同一把 /tmp/prio-write.lock）：挡住它的是整盘写阶段或另一个单条。抢不到它返回 ok:false，这条事件不确认，留在 Worker 里下次再拉。
//
// 三层回退：Worker 正常 → 每 2 秒拉事件；Worker 连续失败 pollAfterFailures 次（缺省 1 次：一次失败就兜底）→ 才跑 60 秒兜底轮询；
// 本进程整个挂掉 → 现有 30 分钟定时任务照旧收敛看板。兜底轮询补写「事件写过但没写成功」的单条目标，
// 并（Worker 失败期间）每 60 秒对授权仓做一次发现：每仓 1 次只读 GraphQL（DISCOVERY_QUERY）拿最近更新的 PR/issue，
// 把目标交给同一条单条写入路径。发现通道和整盘读共用 `prio-run` 这一格额度：发现前先过 decideTick
// （purpose=non-essential、cost=0、reserve=GRAPHQL_COST_PER_REQUEST × 具体授权仓数），reserve 只进预算比较、不记账，
// 闸不放行（超预算 / 剩余 <800 暂停）的这一拍一次都不发；每发一次实际请求用 chargeBudget 记账并写回 rate-budget.json
// （抛错也记）——一拍只在这一处记点，闸不再重复记。没设 ACCEPTANCE_WATCHER_HOME 就不启用闸，只记一行。
// 写失败的目标留在 pending 里，Worker 正常时也每 60 秒补写一拍（不跑发现）；补写通道按 60 秒 → 5 分钟 → 15 分钟退避，
// 第 4 次失败放弃（写一行日志，事件仍不 ack，交给 Worker 重投与 30 分钟整盘）。
// 本次故障期已处理的目标记在内存集合里（2 分钟重叠窗口内不重读），Worker 恢复（pull 成功）即清空。
// 发现和事件补写合并去重，同一目标一拍只写一次；不整盘读，也不替现有定时任务做对账。
//
// 两个停写开关都遵守：<stateDir>/disabled（自动写入已暂停）→ 事件只确认不写；
// <stateDir>/event-run.disabled（本拉取器停用）→ 连拉都不拉，空转并写日志说明。
// 「关联 PR」这类 link 字段的门控标记 <stateDir>/mac-mini-stopped 由 syncOne 通过 linkAllowed 收口，这里只负责如实传。
// 日志写 <home>/state/host/event-run.log（和宿主其它日志同一目录风格），人话中文，超过 5MB 截断保留尾部。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSecretFile, explicitWatcherHome, loadAcceptanceProfile, ProfileError } from './profile.mjs';
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
import { LOCK_RETRY_MS, LOCK_WAIT_MAX_MS, WRITE_LOCK_FILE } from './prio-lock.mjs';
import { createReadGithub } from './prio-sync.mjs';
import { hostFilesFromEnv, readAuthorizedRepos } from './prio-run.mjs';
import {
  GRAPHQL_COST_PER_REQUEST,
  chargeBudget,
  decideTick,
  readBudgetFile,
  readRateState,
  writeRateState,
} from './rate-budget.mjs';
import { SINGLE_ITEM_MODULE, loadSingleItemModule } from '../prio-item-loader.mjs';

/** 兜底轮询的门槛（缺省 1 次：一次失败就兜底）由 event-pull.mjs 定义，这里只是转发，免得两边各写一份。 */
export { DEFAULT_POLL_AFTER_FAILURES };

/** 只处理这四类事件（Worker 侧也只订阅这四类）。其它类型到了也只确认不写。 */
export const EVENT_TYPES = Object.freeze(['issues', 'issue_comment', 'pull_request', 'pull_request_review']);
/**
 * 写锁的共用锁文件、重试间隔、最长等待只在 bin/prio-lock.mjs 有一份实现，这里只把常量转出去。
 * 事件路径不自己抢锁：真写由 syncEventItem 内部 withWriteLock 收口。挡住它的是整盘写阶段或另一个单条（抢不到它返回 ok:false, skipped:'lock-busy'）。
 */
export { LOCK_RETRY_MS, LOCK_WAIT_MAX_MS, WRITE_LOCK_FILE };
/** 单条读写模块（W4-d 提供，可能还没部署）。加载器在 ../prio-item-loader.mjs，这里只转出去。 */
export { SINGLE_ITEM_MODULE, loadSingleItemModule };
export const EVENT_RUN_LOG_MAX_BYTES = 5 * 1024 * 1024;
/** 停用 / 空转这类重复日志最多每 60 秒一条。 */
const QUIET_LOG_MS = 60 * 1000;
/** 汇总一条目标的跳过原因时，每条最多留这么多字符（不把整条响应写进日志）。 */
const SKIP_REASON_MAX = 160;
/** 预算配置读失败后的重读间隔：补写/发现通道的拍间隔就是 60 秒，失败后下一拍重读（不永久 null）。 */
export const BUDGET_CONFIG_RETRY_MS = 60 * 1000;
/**
 * 补写通道的退避（毫秒）：写失败后第 1 次补写在 60 秒后，第 2 次 5 分钟后，第 3 次 15 分钟后，第 4 次失败放弃。
 * 只在内存、不落盘（与 handled 同口径）；只拦补写通道（source: 'poll'），事件路径照旧不受影响。
 */
export const RETRY_BACKOFF_MS = Object.freeze([60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000]);
/** 兜底发现的时间水位：还没成功发现过（刚启动）回看 10 分钟；之后按上次成功发现减 2 分钟。 */
export const DISCOVERY_LOOKBACK_MS = 10 * 60 * 1000;
export const DISCOVERY_OVERLAP_MS = 2 * 60 * 1000;

export class EventRunConfigError extends Error {
  constructor(message, code = 'EVENT_RUN_CONFIG') {
    super(message);
    this.name = 'EventRunConfigError';
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
  const hostFiles = explicitWatcherHome(env) ? hostFilesFromEnv(env) : null;
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
    // 额度状态与预算配置走宿主路径（和整盘 prio-run 同一份，不按 --state-dir 猜）：
    // 没设 ACCEPTANCE_WATCHER_HOME 时是 null，调用方按「额度闸未启用」处理。
    rateStateFile: hostFiles?.rateState ?? null,
    rateBudgetConfigFile: hostFiles?.rateBudgetConfig ?? null,
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
    // 补写退避表（小写 ref → { attempts, nextAtMs, lastReason }）：形状与 pending 分开，pending 的值类型不变
    // （仍是一个目标）。attempts = 已经重试过的次数，nextAtMs = 下一次允许补写的时刻。只在内存，不落盘。
    retries: new Map(),
    // 本次故障期已处理的目标（小写 ref → 当时写进去的 updatedAt 毫秒）：2 分钟重叠窗口里同一个 updatedAt 不再重复写；
    // 目标之后又有更新（updatedAt 更大）照样重写。只在内存，Worker 恢复即清空。
    handled: new Map(),
    logged: new Set(),
  };
}

/**
 * 发现用的 GitHub 读取依赖，形状：
 *   listRecent({ repo, sinceMs }) => [{ repo, number, kind: 'pull'|'issue', updatedAt, body?, headRef? }]
 * 缺省实现走现有只读 GraphQL 通道（见下面的 createGraphqlListRecent）：每仓每分钟 1 次调用，
 * 低于「授权仓数 × 2」的上限（Worker 失败期间每 60 秒才一拍）。
 * updatedAt 早于 sinceMs 的行丢弃（按客户端过滤）。
 */

/**
 * 发现用的具名只读 query：一次拿一仓最近更新的 PR 与 issue。
 * `issues` 连接按 GraphQL 语义同时返回 PR，所以节点带 __typename，建行时跳过 PullRequest，
 * 否则同一个 PR 会被当成「issue 号」写一遍。
 */
export const DISCOVERY_QUERY = `query DiscoveryRecent($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, orderBy: {field: UPDATED_AT, direction: DESC}, states: [OPEN, MERGED, CLOSED]) {
      nodes { __typename number updatedAt headRefName body }
    }
    issues(first: 50, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { __typename number updatedAt }
    }
  }
}`;

/** 把 DISCOVERY_QUERY 的返回变成 listRecent 约定的行（还没按 sinceMs 过滤）。 */
export function graphqlRecentRows({ repo, data, sinceMs = null } = {}) {
  const repository = data?.repository;
  if (!repository) return [];
  const rows = [];
  for (const node of repository.pullRequests?.nodes || []) {
    rows.push({
      repo,
      number: node?.number,
      kind: 'pull',
      updatedAt: node?.updatedAt,
      body: node?.body,
      headRef: node?.headRefName,
    });
  }
  for (const node of repository.issues?.nodes || []) {
    // issues 连接同时返回 PR：PR 已经在上面按 pr-link 反查过，这里跳过，免得往 PR 号上写。
    if (node?.__typename === 'PullRequest') continue;
    rows.push({ repo, number: node?.number, kind: 'issue', updatedAt: node?.updatedAt });
  }
  return rows.filter((row) => {
    const updatedMs = Date.parse(String(row.updatedAt ?? ''));
    return !Number.isFinite(sinceMs) || !Number.isFinite(updatedMs) || updatedMs >= sinceMs;
  });
}

/**
 * 缺省的发现通道：用现有只读通道（prio-sync.mjs 的 createReadGithub().ownerGraphql）。
 * 只发只读 query，不新建令牌、不读环境变量里的令牌、不起子进程、不加动态 import。
 * reader 懒创建：第一次 poll 才 loadAcceptanceProfile 并建通道；profile / reader / 构造器都可注入，测试里不碰真网络。
 */
export function createGraphqlListRecent({
  reader = null,
  profile = null,
  loadProfile = loadAcceptanceProfile,
  createReader = createReadGithub,
  rateStateFile = null,
  cost = GRAPHQL_COST_PER_REQUEST,
  component = 'prio-run',
  now = () => Date.now(),
  logger = () => {},
} = {}) {
  let cached = reader;
  // 发一次记一笔：不管成败都记（抛错的那次请求点数是真花出去的），写回文件而不是只改内存。
  function chargeOnce() {
    if (!rateStateFile) return;
    try {
      const state = readRateState(rateStateFile);
      writeRateState(rateStateFile, chargeBudget(state, { component, cost, now: now() }));
    } catch (error) {
      logger(`额度记账失败（不影响发现）：${summarize(error)}`);
    }
  }
  return async function listRecent({ repo, sinceMs }) {
    if (!cached) {
      const loaded = profile || loadProfile();
      cached = createReader({ profile: loaded });
    }
    const [owner, name] = String(repo || '').split('/');
    if (!owner || !name) return [];
    let data;
    try {
      data = await cached.ownerGraphql(DISCOVERY_QUERY, { owner, name });
    } finally {
      chargeOnce();
    }
    return graphqlRecentRows({ repo, data, sinceMs });
  };
}

/**
 * 把发现通道返回的一页目标变回 owner/repo#number。
 * PR 跟事件路径一样走 pr-link 反查任务 issue（正文「任务 issue：」行、Closes 行、acceptance/<号> 分支等），
 * 反查不到就跳过：宁可不写，也不往 PR 号上写认领字段。
 * updatedAt 早于 sinceMs 的一律丢掉（pulls 接口没有 since，只能客户端过滤）。
 */
export function discoveryTargets({ repo, rows = [], sinceMs = null } = {}) {
  const found = new Map();
  const add = (rawRepo, rawNumber, via, updatedMs) => {
    const name = String(rawRepo || '').trim();
    const number = numberOrNull(rawNumber);
    if (!name.includes('/') || !number) return;
    const ref = `${name}#${number}`;
    const existing = found.get(ref.toLowerCase());
    if (existing) {
      if (Number.isFinite(updatedMs) && !(existing.updatedMs >= updatedMs)) existing.updatedMs = updatedMs;
      return;
    }
    const target = { repo: name, issue: number, ref, via };
    if (Number.isFinite(updatedMs)) target.updatedMs = updatedMs;
    found.set(ref.toLowerCase(), target);
  };
  for (const row of rows || []) {
    const name = String(row?.repo || repo || '').trim();
    const number = numberOrNull(row?.number);
    if (!name.includes('/') || !number) continue;
    const updatedMs = Date.parse(String(row?.updatedAt ?? ''));
    if (Number.isFinite(sinceMs) && Number.isFinite(updatedMs) && updatedMs < sinceMs) continue;
    if (String(row?.kind) === 'pull') {
      for (const ref of prIssueRefs({
        repo: name,
        number,
        body: row.body,
        title: row.title,
        headRefName: row.headRef,
      })) {
        const at = ref.lastIndexOf('#');
        if (at > 0) add(ref.slice(0, at), ref.slice(at + 1), 'discover-pr', updatedMs);
      }
    } else if (String(row?.kind) === 'issue') {
      add(name, number, 'discover-issue', updatedMs);
    }
  }
  return [...found.values()];
}

/**
 * 窄写入函数：事件路径与发现路径都只从这里写。payload 形状固定为
 * { repo, issue, ref, event, source, linkAllowed, now }，交给 syncOne 的 ctx 只有状态目录 { dir: stateDir }。
 * syncOne 是 #319 的 syncEventItem：它自己 withWriteLock 抢整盘写阶段那把 `.item`，所以这里不再抢第二道锁。
 * syncOne 返回 result 时：ok === false 表示没写成功（整盘写阶段或另一个单条占着、回读不一致等）——抛错（reason 进错误信息），
 * 调用方因此不 ack、不推进水位；mode === 'disabled' 且 ok 为 true 表示停写开关生效、这一条没写：
 * 不抛，由调用方决定可以 ack。written 只认 result.written > 0（真写进看板且回读一致）。
 */
export function createWriteTarget({ syncOne, stateDir, stdout = null }) {
  // stdout 是日志 sink：syncEventItem 把「额度不够」「写锁被占」这类静默跳过写到这里，由调用方按 ref 汇总成一行。
  const ctx = stdout ? { dir: stateDir, stdout } : { dir: stateDir };
  return async function writeTarget(payload) {
    const result = await syncOne(payload, ctx);
    if (result && result.ok === false) {
      const reason = summarize(result.reason || '没写成功，调用方没给原因');
      throw new Error(`单条读写失败：${payload?.ref || '目标未知'}（${reason}）`);
    }
    return result || {};
  };
}

/**
 * 事件处理与兜底轮询共用的一段逻辑：定位目标 → 过白名单与开关 → 交给 syncOne 单条读写。
 * syncOne 是注入的依赖（缺省由 runEventRun 经 ../prio-item-loader.mjs 加载 bin/prio-item.mjs 的 syncEventItem）。
 * 没有它就不写、也不假装写过。写锁不由这里拿：syncEventItem 内部自己 withWriteLock。
 * listRecent 是发现通道的读取依赖（形状见上方 DISCOVERY_QUERY 前面的注释）；不传就只补写 pending。
 * 单条读写模块没部署、syncOne 自己报错（含抢不到锁）都会让这条事件不确认。
 */
export function createEventPipeline({
  state,
  paths,
  write = false,
  syncOne = null,
  logger = () => {},
  now = () => Date.now(),
  exists = (file) => fs.existsSync(file),
  listRecent = null,
  discoveryLookbackMs = DISCOVERY_LOOKBACK_MS,
  discoveryOverlapMs = DISCOVERY_OVERLAP_MS,
  // 额度闸：缺省用 paths 里的宿主文件（与整盘 prio-run 同一份），测试可单独注入。
  rateStateFile = paths?.rateStateFile ?? null,
  budgetConfigFile = paths?.rateBudgetConfigFile ?? null,
  budgets = undefined,
  discoveryCost = GRAPHQL_COST_PER_REQUEST,
} = {}) {
  if (!state || !paths) throw new EventRunConfigError('事件处理需要 state 和 paths');
  // 调用方自己拼的 state（不是 createEventRunState）也要有「本次故障期已处理」集合。
  if (!(state.handled instanceof Map)) state.handled = new Map();
  // 补写退避表同理：形状和 pending 分开，pending 里仍然只放目标本身。
  if (!(state.retries instanceof Map)) state.retries = new Map();

  // syncEventItem 写回来的几条静默跳过先进这里，写完由 flushSkips 按 ref 汇总成一行。
  let skipSink = null;
  const stdoutSink = {
    write(chunk) {
      return skipSink ? skipSink.write(chunk) : true;
    },
  };

  // 事件路径和发现路径共用的窄写入函数；模块未部署时为空，调用方先判过再进来。
  const writeTarget = typeof syncOne === 'function'
    ? createWriteTarget({ syncOne, stateDir: paths.stateDir, stdout: stdoutSink })
    : null;

  // 上次成功发现的时间：只存内存，进程重启后回到「回看 10 分钟」。
  let lastDiscoveryMs = null;

  // 静默日志按类别各自去重：同一拍里多仓读失败、额度不够、开关类互不吞掉（单仓读失败按仓名分开）。
  const lastQuietAt = new Map();
  function logQuiet(key, text) {
    const at = now();
    const prev = lastQuietAt.get(key) ?? -Infinity;
    if (at - prev < QUIET_LOG_MS) return;
    lastQuietAt.set(key, at);
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

  /**
   * 把一条目标这一拍攒下的跳过原因汇总成一行日志：含 ref 与原因关键字，不逐行照抄，也不带令牌 / 整条响应。
   * 这些行都是 syncEventItem 报 ok:true 的静默跳过（额度不够、每小时上限、关联 PR 不回退、写锁被占）。
   */
  function flushSkips(ref, lines) {
    const reasons = [];
    for (const line of lines) {
      const text = String(line).trim().replace(/。$/, '').slice(0, SKIP_REASON_MAX);
      if (text && !reasons.includes(text)) reasons.push(text);
    }
    if (!reasons.length) return;
    logger(`单条读写跳过 ${ref}：${reasons.join('；')}`);
  }

  /**
   * 单条写入：拼 payload → 走窄写入函数（写锁在 syncEventItem 里）。
   * 返回 { written, mode, reason }：written > 0 才算真写进看板；written === 0 的静默跳过（额度不够、每小时上限、
   * 无变化）把 result.reason 带回去，由调用方决定算不算处理完成。
   * 先把目标记进 pending：写失败（含意外抛错）就留到下一拍补写通道，写成功才移出。
   */
  async function writeOne(target, { event = null, createdMs = null, source = 'event' } = {}) {
    if (!writeTarget) throw new Error('单条读写模块未部署');
    const key = String(target.ref).toLowerCase();
    state.pending.set(key, target);
    const linkAllowed = exists(paths.markerFile);
    if (!linkAllowed) logQuiet('marker:link', '没有 mac-mini-stopped 标记：「关联 PR」这类 link 字段交给 syncOne 扣住，这里不绕过');
    const collected = [];
    skipSink = {
      write(chunk) {
        for (const line of String(chunk ?? '').split('\n')) {
          const text = line.trim();
          if (text) collected.push(text);
        }
        return true;
      },
    };
    let result;
    let failure = null;
    try {
      result = await writeTarget({
        repo: target.repo,
        issue: target.issue,
        ref: target.ref,
        event,
        source,
        linkAllowed,
        now: now(),
      });
    } catch (error) {
      failure = error;
    } finally {
      skipSink = null;
    }
    if (failure) {
      // 失败（含 syncOne 抛错、ok:false）在这里统一登记补写计划：没有记录的就排到「失败时刻 + 60 秒」，
      // 已有记录的（补写通道的一次重试）只更新原因、不动次数与下次时间——次数由 poll() 推进。
      const failedAt = summarize(failure);
      const planned = state.retries.get(key);
      state.retries.set(
        key,
        planned
          ? { ...planned, lastReason: failedAt }
          : { attempts: 0, nextAtMs: now() + RETRY_BACKOFF_MS[0], lastReason: failedAt },
      );
      // 一条都没写（含抛错）：stdout 上攒的跳过原因才按 ref 汇总成一行。
      flushSkips(target.ref, collected);
      throw failure;
    }
    // 停写开关在 syncOne 里生效（mode: 'disabled'）：没有写，也不推进事件水位，但这一条可以 ack。
    if (result.mode === 'disabled') {
      state.pending.delete(key);
      state.retries.delete(key);
      return { written: 0, mode: 'disabled', reason: summarize(result?.reason || '') };
    }
    if (Number.isFinite(createdMs)) state.watermarks.set(key, createdMs);
    state.pending.delete(key);
    state.retries.delete(key);
    const written = Number(result?.written);
    const count = Number.isFinite(written) && written > 0 ? written : 0;
    // 成功写入时 stdout 上的行是额度闸自己的日志（rate-recovery / rate-unknown 等），不是跳过：不汇总。
    if (count === 0) flushSkips(target.ref, collected);
    return { written: count, mode: result.mode, reason: summarize(result?.reason || '') };
  }

  /** 处理一条事件。返回值 { written } 给延迟行用：只有真写进看板且回读成功才是 true。 */
  async function onEvent(event) {
    const type = String(event?.event || '');
    if (!EVENT_TYPES.includes(type)) {
      logOnce(`type:${type}`, `不处理「${type}」这类事件（只订阅 issues、issue_comment、pull_request、pull_request_review），这条只确认不写`);
      return { written: false };
    }
    const targets = eventTargets(event);
    if (!targets.length) {
      logOnce(`nowhere:${type}`, `有一条 ${type} 事件定位不到 owner/repo#number（正文可能被 Worker 省略），这条只确认不写`);
      return { written: false };
    }
    const allowed = targets.filter((target) => state.allowedRepos.has(String(target.repo).toLowerCase()));
    if (!allowed.length) {
      logOnce(`repo:${targets[0].repo.toLowerCase()}`, `事件所属的仓（${targets[0].repo}）不在授权清单里，这条只确认不写`);
      return { written: false };
    }
    if (exists(paths.prioDisabledFile)) {
      logQuiet('prio:disabled', '.prio/disabled 存在，自动写入已暂停：这条事件只确认不写');
      return { written: false };
    }
    if (!write) {
      for (const target of allowed) {
        logger(`dry-run：本应单条读写 ${target.ref}（${target.via}），没有写；要真写请加 --write`);
      }
      return { written: false };
    }
    if (typeof syncOne !== 'function') {
      // 不确认：留在 Worker 里，模块部署后自动接着处理。连续失败到上限后由 Worker 放弃并留痕。
      logger('单条读写模块未部署，这条事件不确认、退回轮询（模块部署后自动补上）');
      throw new Error('单条读写模块未部署');
    }
    const createdMs = Date.parse(String(event?.created_at || ''));
    let written = 0;
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
        written += (await writeOne(target, { event, createdMs, source: 'event' })).written;
        state.pending.delete(key);
      } catch (error) {
        // 留在 pending 里（writeOne 已经放好了），等兜底轮询再补一次；同时把错误抛出去，让这条事件保持不确认。
        throw error;
      }
    }
    return { written: written > 0 };
  }

  /** 上一次成功发现的时间 → 这一拍要回看的起点。没成功过就回看 10 分钟。 */
  function discoverySinceMs() {
    return lastDiscoveryMs == null ? now() - discoveryLookbackMs : lastDiscoveryMs - discoveryOverlapMs;
  }

  let budgetConfig = budgets;

  /**
   * 这一拍用的预算配置：注入的（或已经读到过的）直接用；读文件失败不写缓存，下一拍（约 60 秒后）无条件重读，
   * 一次临时读失败不会让预算闸在这个进程里永久失效。没给文件路径就当没有预算，只按响应头剩余判定。
   */
  function budgetConfigForGate() {
    if (budgetConfig !== undefined) return budgetConfig;
    if (!budgetConfigFile) {
      budgetConfig = null;
      return null;
    }
    try {
      budgetConfig = readBudgetFile(budgetConfigFile);
      return budgetConfig;
    } catch (error) {
      logOnce(
        `rate:budget:${summarize(error)}`,
        `额度预算配置无法使用（${summarize(error)}）：发现只按响应头剩余判定，${Math.round(BUDGET_CONFIG_RETRY_MS / 1000)} 秒后的下一拍重读`,
      );
      return null;
    }
  }

  /** 发现通道真正会发请求的授权仓数：含 `*` 的条目发现时跳过（口径同 discover()），不计入 reserve。 */
  function discoverableRepoCount() {
    let count = 0;
    for (const repo of state.allowedRepos) {
      if (!String(repo).includes('*')) count += 1;
    }
    return count;
  }

  /**
   * 发现前的额度闸（与整盘 prio-run 同一格预算，不另开组件名）。
   * 判定用 cost: 0 + reserve: 每仓一次请求的点数 × 具体授权仓数：reserve 只进预算比较、不记账，
   * 点数只在每仓实际请求后由 createGraphqlListRecent 的 chargeOnce 记一次（否则一拍多记 6 点）。
   * 缺 ACCEPTANCE_WATCHER_HOME 时不启用，只记一行，不猜路径。
   * 闸自己出错就放行 + 留痕（与 prio-run / prio-item 同一口径，不算静默 fail-open）。
   */
  function discoveryGate() {
    if (!rateStateFile) {
      logOnce('rate:disabled', '额度闸未启用：没设 ACCEPTANCE_WATCHER_HOME，也没有显式给出额度状态文件；兜底发现这一拍照跑');
      return { allowed: true, enabled: false, reason: '' };
    }
    try {
      const gate = decideTick({
        component: 'prio-run',
        purpose: 'non-essential',
        state: readRateState(rateStateFile),
        now: now(),
        budgets: budgetConfigForGate(),
        cost: 0,
        reserve: discoveryCost * discoverableRepoCount(),
      });
      writeRateState(rateStateFile, gate.state);
      if (gate.log) logger(gate.log);
      return { allowed: gate.allowed, enabled: true, reason: gate.reason || 'rate-gate' };
    } catch (error) {
      logger(
        `rate-unknown component=prio-run identity=user remaining=unknown reason=rate-gate-error ${summarize(error)} 判定或写状态出错，这一拍照常发现`,
      );
      return { allowed: true, enabled: true, reason: 'rate-gate-error' };
    }
  }

  /**
   * 对每个授权仓列一次最近更新的 PR/issue，变回待写目标。
   * 单仓读失败只记一行并跳过该仓，不把一个仓的错误变成整拍的失败；
   * lastDiscoveryMs 只在至少一仓成功时推进。含 `*` 的授权项不支持通配，发现时跳过（事件路径不受影响）。
   */
  async function discover() {
    const repos = [...state.allowedRepos];
    if (!repos.length) {
      logQuiet('discovery:no-repo', 'Worker 连续失败，兜底发现这一拍没有授权仓，跳过');
      return [];
    }
    const sinceMs = discoverySinceMs();
    const targets = [];
    let succeeded = 0;
    for (const repo of repos) {
      if (String(repo).includes('*')) {
        logOnce(`star:${repo}`, `授权清单里的「${repo}」带 * 通配：发现通道只支持具体仓名，这一条跳过（事件路径照旧）`);
        continue;
      }
      try {
        const rows = await listRecent({ repo, sinceMs });
        targets.push(...discoveryTargets({ repo, rows, sinceMs }));
        succeeded += 1;
      } catch (error) {
        // 单仓读失败按仓名分别去重：两仓同拍都失败时各出一行。
        logQuiet(`discovery:read-fail:${repo}`, `兜底发现这一拍 ${repo} 读失败（${summarize(error)}）：跳过这个仓，其它仓照常`);
      }
    }
    if (succeeded > 0) lastDiscoveryMs = now();
    return targets;
  }

  /**
   * 兜底轮询：Worker 连续失败时才被调用。两路来源合并去重：事件路径没写成功的目标 + 这一拍发现到的目标，
   * 同一目标一拍只写一次，都走 writeTarget。待补目标按 60 秒 → 5 分钟 → 15 分钟退避补写，第 4 次失败放弃。
   * 不整盘读看板，也不返回事件（返回空数组）。
   * 停写开关（.prio/disabled）存在时发现照跑、一个都不写，日志写明；dry-run 同样不写。
   * 发现通道报错（包括缺省「未配置」）先把待补目标写掉，再把错误抛出去：错误由调用方记日志，循环不退出。
   */
  async function poll({ workerFailing = true } = {}) {
    const queue = new Map();
    // 待补目标进队列：它们是写失败留下的，不受「已处理」集合约束；
    // 退避没到期的这一拍先跳过（退避只拦补写通道，事件路径不受影响）。
    for (const [key, target] of state.pending) {
      const planned = state.retries.get(key);
      if (planned && planned.nextAtMs > now()) continue;
      queue.set(key, target);
    }
    let discoveryError = null;
    // 闸拒绝时已经单独记过一行原因，不再打「没有待补目标」那类会误导的文案。
    let gateRejected = false;
    if (workerFailing && typeof listRecent === 'function') {
      const gate = discoveryGate();
      if (!gate.allowed) {
        gateRejected = true;
        logQuiet('rate:not-allowed', `额度不够（${gate.reason}）：这一拍不做兜底发现，待补目标照旧补写，发现留给下一拍`);
      } else {
        try {
          const found = await discover();
          for (const target of found) {
            const key = String(target.ref).toLowerCase();
            if (queue.has(key)) continue;
            // 退避同样拦发现来源：同一个目标退避没到期，这一拍不重写（否则每秒都“发现→失败”，退避形同虚设）。
            const planned = state.retries.get(key);
            if (planned && planned.nextAtMs > now()) continue;
            // 2 分钟重叠窗口里同一个 updatedAt 不重写；目标之后又有更新（updatedAt 更大）照样写。
            const doneAt = state.handled.get(key);
            if (doneAt !== undefined && !(Number.isFinite(target.updatedMs) && target.updatedMs > doneAt)) continue;
            queue.set(key, target);
          }
          if (found.length) logger(`兜底发现到 ${found.length} 个目标：${found.map((target) => target.ref).join('、')}`);
        } catch (error) {
          discoveryError = error;
          logQuiet('discovery:failed', `兜底发现这一拍失败：${summarize(error)}`);
        }
      }
    }
    const targets = [...queue.values()];
    if (!targets.length) {
      // 「已经补完」只在 pending 真的空了才写：非空只是退避没到期。
      if (!discoveryError && !gateRejected && state.pending.size === 0) {
        if (!workerFailing) logQuiet('poll:idle', 'Worker 正常，这一拍待补的单条目标已经补完');
        else logQuiet('poll:no-target', 'Worker 连续失败，兜底轮询这一拍没有待补的单条目标（看板收敛交给现有的定时任务）');
      }
    } else if (exists(paths.prioDisabledFile)) {
      logQuiet('poll:prio-disabled', `.prio/disabled 存在，自动写入已暂停：兜底这一拍有 ${targets.length} 个目标，只发现不写`);
    } else if (!write) {
      logQuiet('poll:dry-run', `dry-run：兜底这一拍有 ${targets.length} 个目标，没有写；要真写请加 --write`);
    } else if (typeof syncOne !== 'function') {
      logQuiet('poll:no-module', '单条读写模块未部署，兜底轮询这一拍补不了：等模块部署后再说');
    } else {
      for (const target of targets) {
        const key = String(target.ref).toLowerCase();
        // 写入前的退避记录：有记录说明这一拍就是补写通道的一次重试，失败才推进次数与下次时间；
        // 没记录的（这一拍刚发现 / 刚失败）由 writeOne 记下第一次补写时间（失败时刻 + 60 秒）。
        const planned = state.retries.get(key) ?? null;
        try {
          const outcome = await writeOne(target, { source: 'poll' });
          state.pending.delete(key);
          state.retries.delete(key);
          if (outcome.written > 0 || outcome.mode === 'disabled') {
            state.handled.set(key, Number.isFinite(target.updatedMs) ? target.updatedMs : now());
            logger(`兜底轮询补写 ${target.ref} 完成`);
          } else {
            // 一条都没写（额度不够、每小时上限、无变化）：不算完成、不进 handled，
            // 下一拍靠 2 分钟重叠窗口重新发现再试（目标仍从 pending 移出，不留在这里重试）。
            logger(`兜底轮询跳过 ${target.ref}（${outcome.reason || '没写任何目标'}）`);
          }
        } catch (error) {
          const reason = summarize(error);
          if (!planned) {
            logger(`兜底轮询补写 ${target.ref} 失败：${reason}（${Math.round(RETRY_BACKOFF_MS[0] / 1000)} 秒后再补）`);
            continue;
          }
          const attempts = planned.attempts + 1;
          if (attempts >= RETRY_BACKOFF_MS.length) {
            // 上限：从 pending 与退避表里都移除，只写一行放弃日志（同一个 key 只一行）；事件仍不 ack。
            state.pending.delete(key);
            state.retries.delete(key);
            logOnce(
              `abandon:${key}`,
              `放弃补写 ${target.ref}：已重试 ${RETRY_BACKOFF_MS.length} 次，最后一次原因 ${reason}，这条不再自动补写（事件仍不 ack，交给 Worker 重投与 30 分钟整盘）`,
            );
          } else {
            const waitMs = RETRY_BACKOFF_MS[attempts];
            state.retries.set(key, { attempts, nextAtMs: now() + waitMs, lastReason: reason });
            logger(`兜底轮询补写 ${target.ref} 失败：${reason}（${Math.round(waitMs / 60000)} 分钟后再补）`);
          }
        }
      }
    }
    if (discoveryError) throw discoveryError;
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
  exists = (file) => fs.existsSync(file),
  state = null,
  // 发现通道：缺省用只读 GraphQL（每仓 1 次调用）；profile / reader 可注入，测试里不碰真网络。
  listRecent = null,
  profile = null,
  reader = null,
} = {}) {
  if (!config?.paths) throw new EventRunConfigError('事件拉取器缺少路径配置');
  const paths = config.paths;
  const log = logger || makeEventRunLogger(paths.logFile, { now });
  const shared = state || createEventRunState({ allowedRepos: readAllowedRepos(paths.authorizedReposFile, log) });
  const syncOneImpl = syncOne !== undefined ? syncOne : await loadModule();
  // 懒创建在 createGraphqlListRecent 里：这里只把构造参数传进去，不读 profile、不建通道。
  // 每发一次发现请求按 GRAPHQL_COST_PER_REQUEST 记进 rate-budget.json（与整盘 prio-run 同一格）。
  const discoverRecent = listRecent || createGraphqlListRecent({
    reader,
    profile,
    rateStateFile: paths.rateStateFile ?? null,
    now,
    logger: log,
  });
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
    return pullFromWorker({ url: config.workerUrl, token: config.pullToken, fetchImpl }).then((events) => {
      // Worker 恢复（这一拍拉到了）：本次故障期「已处理」的集合清空，下一拍照常重新发现。
      if (shared.handled?.size) shared.handled.clear();
      return events;
    });
  };

  const pipeline = createEventPipeline({
    state: shared,
    paths,
    write,
    syncOne: typeof syncOneImpl === 'function' ? syncOneImpl : null,
    logger: log,
    now,
    exists,
    listRecent: discoverRecent,
  });

  const poll = async (options = {}) => {
    if (disabled()) {
      const at = now();
      if (at - lastDisabledAt >= QUIET_LOG_MS) {
        lastDisabledAt = at;
        log('事件拉取已停用（event-run.disabled 存在）：兜底轮询这一拍也不跑');
      }
      return [];
    }
    return pipeline.poll(options);
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
    // 有待补目标就跑一拍补写（Worker 正常也跑）；发现仍只在 Worker 失败时跑。
    hasPending: () => shared.pending.size > 0,
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
      syncOne: deps.syncOne,
      loadModule: deps.loadModule || loadSingleItemModule,
      listRecent: deps.listRecent || null,
      profile: deps.profile || null,
      reader: deps.reader || null,
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
