#!/usr/bin/env node
// 看板优先级的持续运行入口（一拍一次，不自带循环，也不安装 cron）。
// 默认 dry-run。--write 只自动写「空 → P1/P2」，并且只写授权清单里的仓。
// 每拍先看停写开关，再看每拍 / 每小时上限，然后调 prio-sync，写完一条就回读。
// 降级、改空、白名单外、排除档、回读不一致、小时上限，都是写 .prio/disabled 并记一条告警。
// 告警只追加 alerts.jsonl，不推到别处。文案不带令牌、主机名、仓的全名。
// `--only-field`：只让指定字段进写闸（取值只认「优先级」「关联 PR」）。只有「关联 PR」时持续模式才放行 link，
// 仍受逐条回读、停写开关、每小时 50 条上限约束；其余取值（含不带）link 照旧 skip。
// 带「关联 PR」时，优先级侧的降级/改空按「本拍不可写字段」排除：不停写、不建开关、不发 prio-downgrade。
// 不能和 `--only-empty-to-p2` 同用，同时给就在读令牌之前报错退出。
// `--only-empty-to-p2`：只写「空 → P2」这一子集，计划里的降级、改空、升级、空 → P1、关联 PR 静默排除，
// 不 abort、不建停写开关、不发告警，只在 run 日志里记一行排除计数（分四类）。不带这个开关时行为不变。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './redact.mjs';
import { explicitWatcherHome, loadAcceptanceProfile } from './profile.mjs';
import { hostPaths } from '../host/paths.mjs';
import {
  TICK_SECONDS,
  appendRateLog,
  decideTick,
  readBoardSnapshot,
  readBudgetFile,
  readRateState,
  writeBoardSnapshot,
  writeRateState,
} from './rate-budget.mjs';
import {
  ITEM_FIELD_QUERY,
  ONLY_FIELD_NAMES,
  PRIO_HOURLY_MAX,
  PRIO_HOURLY_WINDOW_MS,
  PRIO_LIMIT_MAX,
  classifyPrioChange,
  countRecentChanges,
  createPriorityGithub,
  createReadGithub,
  defaultStateDir,
  loadBoardItems,
  loadPullRequests,
  priorityTokenPath,
  readChangeLog,
  readFieldValue,
  readPriorityWriterToken,
  readRepoClassTable,
  runPrioSync,
} from './prio-sync.mjs';

export const PRIO_TICK_DEFAULT = 10;
/** 一次整板读的估计点数（实测单页 2 点、一次约 8 点）：只用来记 prio-run 的小时用量。 */
export const BOARD_READ_COST = 8;
const PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);
const FAIL_STREAK_LIMIT = 3;

export class PrioRunError extends Error {
  constructor(message, code = 'config') {
    super(message);
    this.name = 'PrioRunError';
    this.code = code;
  }
}

export function isRetriableGithubError(error) {
  const text = error instanceof Error ? String(error.message || '') : String(error ?? '');
  if (/\bNOT_FOUND\b/.test(text)) return true;
  if (/\bHTTP\s+5\d\d\b/.test(text)) return true;
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 500 && status <= 599;
}

export function parseMaxPerTick(raw) {
  const actual = raw == null || raw === '' ? '（空）' : String(raw);
  const parsed = typeof raw === 'number' ? raw : (/^-?\d+$/.test(String(raw)) ? Number(raw) : Number.NaN);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > PRIO_LIMIT_MAX) {
    throw new PrioRunError(`每拍上限期望 1 到 ${PRIO_LIMIT_MAX} 的整数，实际：${actual}`, 'config');
  }
  return parsed;
}

export function parsePrioRunArgs(argv) {
  const out = { write: false, dryRun: false, onlyEmptyToP2: false, stateDir: null, maxPerTick: null, alertsFile: null };
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
    if (arg === '--only-empty-to-p2') {
      // 重复传是幂等的（还是「开」），不做布尔翻转。
      out.onlyEmptyToP2 = true;
      continue;
    }
    if (arg === '--only-field') {
      if (out.onlyField != null) throw new PrioRunError('重复的参数：--only-field', 'config');
      const value = argv[i + 1];
      if (typeof value !== 'string' || value.startsWith('--')) {
        throw new PrioRunError('缺少 --only-field 的取值', 'config');
      }
      if (!ONLY_FIELD_NAMES.includes(value)) {
        throw new PrioRunError(
          `--only-field 期望「关联 PR」或「优先级」，实际：${value === '' ? '（空）' : value}`,
          'config',
        );
      }
      out.onlyField = value;
      i += 1;
      continue;
    }
    if (arg === '--state-dir' || arg === '--max-per-tick' || arg === '--alerts-file') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) {
        throw new PrioRunError(`缺少 ${arg} 的取值`, 'config');
      }
      if (arg === '--state-dir') out.stateDir = value;
      else if (arg === '--alerts-file') out.alertsFile = value;
      else out.maxPerTick = value;
      i += 1;
      continue;
    }
    throw new PrioRunError(`无法识别的参数：${arg}`, 'config');
  }
  if (out.write && out.dryRun) throw new PrioRunError('不能同时传 --dry-run 和 --write', 'config');
  if (out.onlyField != null && out.onlyEmptyToP2) {
    throw new PrioRunError('--only-empty-to-p2 不能和 --only-field 同用', 'config');
  }
  return out;
}

export function resolveMaxPerTick({ explicit = null, file = null } = {}) {
  if (explicit != null) return parseMaxPerTick(explicit);
  if (file && fs.existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new PrioRunError('持续运行配置不是合法 JSON', 'config');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.hasOwn(parsed, 'maxPerTick')) {
      throw new PrioRunError('持续运行配置缺少 maxPerTick', 'config');
    }
    return parseMaxPerTick(parsed.maxPerTick);
  }
  return PRIO_TICK_DEFAULT;
}

export function readAuthorizedRepos(file) {
  if (!file || !fs.existsSync(file)) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new PrioRunError('授权清单不是合法 JSON', 'config');
  }
  const repos = Array.isArray(parsed) ? parsed : parsed?.repos;
  if (!Array.isArray(repos)) throw new PrioRunError('授权清单期望 repos 数组', 'config');
  for (const repo of repos) {
    if (typeof repo !== 'string' || !repo.includes('/')) {
      throw new PrioRunError('授权清单里的仓名必须是 owner/repo', 'config');
    }
  }
  return repos;
}

function changeKey(change) {
  return `${change?.item || ''}\0${change?.field || ''}`;
}

function compareChange(left, right) {
  const repoA = String(left?.repo || '').toLowerCase();
  const repoB = String(right?.repo || '').toLowerCase();
  if (repoA < repoB) return -1;
  if (repoA > repoB) return 1;
  const issue = Number(left?.issue) - Number(right?.issue);
  if (issue !== 0) return issue;
  const fieldA = String(left?.field || '');
  const fieldB = String(right?.field || '');
  if (fieldA < fieldB) return -1;
  if (fieldA > fieldB) return 1;
  return 0;
}

function priorityWord(value) {
  if (value == null || value === '') return '空';
  if (PRIORITIES.has(value)) return value;
  return '未知';
}

/**
 * 看整份计划，决定这一拍是整拍停写，还是只自动写授权仓里的空 → P1/P2。
 * 每拍名额和小时名额都按仓名、issue 号、字段名排好再取前面的，和 --limit 同一顺序。
 *
 * `onlyEmptyToP2`：只留「空 → P2」这一子集。其它行（降级/改空、升级到任何值、空 → P1、关联 PR）
 * 静默排除，不 abort、不建停写开关、不进 nonAuto（因此不会发 prio-downgrade / prio-nonempty 告警）；
 * 排除条数按四类累计，由调用方写进 run 日志。范围外（白名单字段、排除档仓）不在这个开关的授权里，
 * 仍旧整拍停写——那是配置或字段错了，需要人看，不属于「授权只放宽到空 → P2」的范围。
 *
 * `onlyField`：只把指定字段当作可写。`'关联 PR'` 时 link 也走 allow，和空 → P1/P2 同一条路（授权仓、
 * 每拍与每小时名额、逐条回读、停写开关），优先级侧的降级/改空按「本拍不可写字段」排除、不 abort；
 * 其余取值（含不带）link 照旧 skip。
 */
export function assessContinuousPlan(plan, {
  maxPerTick,
  hourlyUsed = 0,
  hourlyMax = PRIO_HOURLY_MAX,
  allowRepos = [],
  table = null,
  onlyEmptyToP2 = false,
  onlyField = null,
} = {}) {
  const rows = (Array.isArray(plan) ? plan : []).map((change) => ({
    change,
    ...classifyPrioChange(change, { table }),
  }));
  const outOfScope = rows.filter((row) => row.kind === 'out-of-scope');
  const downgrades = rows.filter((row) => row.kind === 'downgrade' || row.kind === 'clear');
  const nonAuto = [];
  if (onlyEmptyToP2) {
    if (outOfScope.length > 0) {
      return {
        abort: true,
        reason: 'out-of-scope',
        outOfScope,
        downgrades: [],
        nonAuto,
        hourlyStop: false,
        onlyEmptyToP2: true,
        excludedTotal: 0,
        exclusions: { downgradeClear: 0, upgradeToP1: 0, emptyToP1: 0, link: 0 },
        wouldWrite: [],
        allow() { return 'skip'; },
      };
    }
    const allowSet = new Set((allowRepos || []).map((repo) => String(repo).toLowerCase()));
    // 四类只为了日志可读：降级/清空、升 P1（含同值、未知值）、空 → P1（含空 → P3）、关联 PR。
    // 授权清单以外的空 → P2 不写，但它不是被开关排除的，不进这四类，也不进 excludedTotal。
    const exclusions = { downgradeClear: 0, upgradeToP1: 0, emptyToP1: 0, link: 0 };
    let excludedTotal = 0;
    const eligible = [];
    for (const row of rows) {
      const change = row.change;
      if (row.kind === 'fill' && change?.new === 'P2') {
        if (allowSet.has(String(change?.repo || '').toLowerCase())) eligible.push(change);
        continue;
      }
      excludedTotal += 1;
      if (row.kind === 'link') exclusions.link += 1;
      else if (row.kind === 'clear' || row.kind === 'downgrade') exclusions.downgradeClear += 1;
      else if (row.kind === 'fill' || row.kind === 'fill-other') exclusions.emptyToP1 += 1;
      else exclusions.upgradeToP1 += 1;
    }
    const sorted = eligible.sort(compareChange);
    const room = Math.max(0, Number(hourlyMax) - Number(hourlyUsed));
    const quota = Math.min(Number(maxPerTick) || 0, room);
    const picked = sorted.slice(0, quota);
    const chosen = new Set(picked.map(changeKey));
    const hourlyStop = sorted.length > room;
    return {
      abort: false,
      reason: '',
      outOfScope,
      downgrades: [],
      nonAuto,
      hourlyStop,
      onlyEmptyToP2: true,
      excludedTotal,
      exclusions,
      wouldWrite: picked,
      chosen,
      allow(change) {
        const found = classifyPrioChange(change, { table });
        if (found.kind !== 'fill' || change?.new !== 'P2') return 'skip';
        if (!allowSet.has(String(change?.repo || '').toLowerCase())) return 'skip';
        if (chosen.has(changeKey(change))) return 'write';
        return 'defer';
      },
    };
  }
  // `--only-field "关联 PR"` 时，优先级侧的降级/改空是本拍不可写字段：不 abort、不建停写开关、不发降级告警
  // （降级告警由不带这个参数的那一段 cron 负责）。范围外变更仍整拍停写；其它取值（含不带）行为不变。
  const blocking = onlyField === '关联 PR'
    ? downgrades.filter((row) => row.change?.field === onlyField)
    : downgrades;
  if (outOfScope.length > 0 || blocking.length > 0) {
    return {
      abort: true,
      reason: outOfScope.length > 0 ? 'out-of-scope' : 'downgrade',
      outOfScope,
      downgrades: blocking,
      nonAuto,
      hourlyStop: false,
      allow() { return 'skip'; },
    };
  }
  const allowSet = new Set((allowRepos || []).map((repo) => String(repo).toLowerCase()));
  const linkWritable = onlyField === '关联 PR';
  const targets = rows
    .filter((row) => (row.kind === 'fill' || (linkWritable && row.kind === 'link'))
      && (onlyField == null || row.change?.field === onlyField)
      && allowSet.has(String(row.change?.repo || '').toLowerCase()))
    .map((row) => row.change)
    .sort(compareChange);
  const room = Math.max(0, Number(hourlyMax) - Number(hourlyUsed));
  const quota = Math.min(Number(maxPerTick) || 0, room);
  const chosen = new Set(targets.slice(0, quota).map(changeKey));
  const hourlyStop = targets.length > room;
  return {
    abort: false,
    reason: '',
    outOfScope,
    downgrades,
    nonAuto,
    hourlyStop,
    allow(change) {
      // 本拍不可写字段（`--only-field` 以外的字段）静默排除：不写、不进 nonAuto，因此不发 prio-nonempty。
      if (onlyField != null && change?.field !== onlyField) return 'skip';
      const kind = classifyPrioChange(change, { table }).kind;
      if (kind === 'link') {
        if (!linkWritable) return 'skip';
      } else if (kind !== 'fill') {
        nonAuto.push(change);
        return 'skip';
      }
      if (!allowSet.has(String(change?.repo || '').toLowerCase())) return 'skip';
      if (chosen.has(changeKey(change))) return 'write';
      return 'defer';
    },
  };
}

function showCount(rows, one) {
  return rows.length === 1 ? one(rows[0]) : null;
}

export function alertTextFor(reason, { downgrades = [], nonAuto = [], written = 0, paused = false, streak = 0 } = {}) {
  if (reason === 'downgrade') {
    const single = showCount(downgrades, (row) => {
      const label = row.kind === 'clear' ? '改空' : '降级';
      const from = priorityWord(row.change?.old);
      const to = priorityWord(row.change?.new);
      return `看板优先级自动写入已暂停：有 1 条要把 ${from} 改成 ${to}（${label}），按规则不自动写。看板没有被改动。需要人看一下这条是否该改，确认后删除停写开关即可恢复。`;
    });
    return single || `看板优先级自动写入已暂停：有 ${downgrades.length} 条要把已有优先级改低或改空，按规则不自动写。看板没有被改动。需要人看一下这些是不是该改，确认后删除停写开关即可恢复。`;
  }
  if (reason === 'out-of-scope') {
    return '看板优先级自动写入已暂停：计划里有变更落在白名单以外的字段，或者落在排除档的仓。按规则这一拍一条都没写。看板没有被改动。需要人核对字段和仓分类，确认后删除停写开关即可恢复。';
  }
  if (reason === 'readback') {
    return '看板优先级自动写入已暂停：有一条写入后读回来的值和要写的不一致。已经停下这一拍剩下的写入，没有自动重试。需要人核对看板，确认后删除停写开关即可恢复。';
  }
  if (reason === 'hourly') {
    if (written > 0) {
      return `看板优先级自动写入已暂停：最近 1 小时的写入已经到 ${PRIO_HOURLY_MAX} 条上限。这一拍只写到上限为止，多出来的没有写。需要人看一下是不是写得太多，确认后删除停写开关即可恢复。`;
    }
    return `看板优先级自动写入已暂停：最近 1 小时已经写了 ${PRIO_HOURLY_MAX} 条，再写就超过上限。这一拍没有新的写入。需要人看一下是不是写得太多，确认后删除停写开关即可恢复。`;
  }
  if (reason === 'nonempty') {
    const n = nonAuto.length;
    return `看板优先级这一拍有 ${n} 条不是「空到 P1 或 P2」（含已有优先级改成别的值，例如升级）。按规则这些不自动写。看板这几条没有被改动。需要人确认要不要改，确认后手动写。`;
  }
  if (reason === 'github') {
    if (paused) {
      return '看板优先级自动写入已暂停：连续 3 拍访问看板都失败（找不到或服务器错误）。这一拍没有继续写。需要人检查网络和权限，确认后删除停写开关即可恢复。';
    }
    return `这一拍访问看板失败：GitHub 返回找不到或服务器错误。这一拍没有继续写。下一拍会再试。连续失败还没到 3 拍（当前第 ${streak} 拍），所以没有暂停。先不用处理，下一拍会自己再试。`;
  }
  return '看板优先级自动写入遇到没有写明的情况。这一拍没有继续写。需要人看一下状态目录里的停写开关和告警。';
}

const ALERT_KIND = {
  downgrade: 'prio-downgrade',
  'out-of-scope': 'prio-out-of-scope',
  readback: 'prio-readback',
  hourly: 'prio-hourly',
  nonempty: 'prio-nonempty',
  github: 'prio-github',
};

function readAlerts(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 坏行不影响后面的告警。
    }
  }
  return rows;
}

function appendAlert(file, { ts, reason, text }) {
  const safe = redact(text);
  const kind = ALERT_KIND[reason] || 'prio-unknown';
  if (readAlerts(file).some((row) => row.kind === kind && row.text === safe)) {
    return { ts, kind, text: safe, duplicated: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ts, kind, text: safe })}\n`, { mode: 0o600 });
  return { ts, kind, text: safe, duplicated: false };
}

function writeDisabled(dir, reason) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'disabled');
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${reason}\n`);
}

function readStreak(dir) {
  try {
    const n = Number(fs.readFileSync(path.join(dir, 'fail-streak'), 'utf8').trim());
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeStreak(dir, n) {
  const file = path.join(dir, 'fail-streak');
  if (n <= 0) {
    try { fs.unlinkSync(file); } catch { /* 本来就没有 */ }
    return;
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${n}\n`);
}

function teeStdout(stdout, file) {
  return {
    write(text) {
      stdout.write(text);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text, { mode: 0o600 });
      try { fs.chmodSync(file, 0o600); } catch { /* 权限改不了也不挡住这一拍 */ }
    },
  };
}

function emitAlert(stdout, file, nowMs, reason, extra) {
  const text = alertTextFor(reason, extra);
  const saved = appendAlert(file, { ts: new Date(nowMs).toISOString(), reason, text });
  if (!saved.duplicated) stdout.write(`${saved.text}\n`);
  return saved;
}

async function loadBoard(deps, profile, table) {
  if (deps.loadItems) {
    const items = await deps.loadItems();
    const prs = deps.loadPrs ? await deps.loadPrs() : [];
    return { items: items || [], prs: prs || [], excludedCount: 0, nullContent: 0, reader: null, source: 'injected' };
  }
  const reader = createReadGithub({ profile, run: deps.run, fetchImpl: deps.fetchImpl });
  const board = await loadBoardItems(reader, profile, table);
  const repos = [...new Set((board.items || []).map((entry) => entry.repo))];
  const prs = await loadPullRequests(reader, repos, table);
  return {
    items: board.items,
    prs,
    excludedCount: board.excludedCount,
    nullContent: board.skipped?.nullContent || 0,
    reader,
    source: 'fetched',
  };
}

/**
 * 这一拍的宿主状态文件（看板快照、额度状态、预算配置）：直接问 host/paths.mjs，不按 `--state-dir` 的布局猜（#247 P1-1）。
 * 部署里 `--state-dir` 是 `<home>/tools/.prio`，宿主状态在 `$ACCEPTANCE_WATCHER_HOME/state/host`，两者不同级；
 * 早先「上两级 + state/host」的推导会写到 <home>/state/host（没人读的目录），看板快照与分令牌账都落到错的地方。
 * 没设 `ACCEPTANCE_WATCHER_HOME` 时返回 null：不猜路径，调用方按「额度闸未启用」处理。
 */
export function hostFilesFromEnv(env) {
  const home = explicitWatcherHome(env);
  return home ? hostPaths(home) : null;
}

/**
 * 这一拍的看板数据（#247 SC2）：整板只读一次。
 * - 本地快照还新（at 距今不超过一个拍间隔）：直接用，不再发整板 GraphQL；dry-run、写入、仓外读者共用这一份；
 * - 快照过期或缺失：重拉一次并覆盖，不静默用旧数据。
 * 重拉只覆盖整板读，PR 搜索不属于快照，照旧每次都拉。
 */
async function resolveBoard(deps, profile, table, { snapshot, snapshotFile, now, tickSeconds, onSnapshotError }) {
  if (deps.loadItems) return loadBoard(deps, profile, table);
  const reader = createReadGithub({ profile, run: deps.run, fetchImpl: deps.fetchImpl });
  if (snapshot && snapshot.ok) {
    const repos = [...new Set((snapshot.items || []).map((entry) => entry.repo))];
    const prs = deps.loadPrs ? await deps.loadPrs() : await loadPullRequests(reader, repos, table);
    return {
      items: snapshot.items,
      prs: prs || [],
      excludedCount: snapshot.excludedCount || 0,
      nullContent: snapshot.nullContent || 0,
      reader,
      source: 'snapshot',
      snapshotAt: snapshot.at,
    };
  }
  const board = await loadBoard(deps, profile, table);
  if (snapshotFile) {
    try {
      writeBoardSnapshot(snapshotFile, {
        at: now,
        items: board.items,
        excludedCount: board.excludedCount,
        nullContent: board.nullContent,
      });
    } catch (error) {
      // 快照写不下去（位置被目录占着、磁盘满、权限不对）不挡这一拍：这一拍照常用刚拉到的数据，
      // 只留痕（#247 复审 P2-a，与 host/tick.mjs 的 rateGate 同一口径：判定/写盘自己出错就放行）。
      if (typeof onSnapshotError === 'function') onSnapshotError(error);
    }
  }
  return { ...board, snapshotReason: snapshot?.reason || 'missing' };
}

export async function runContinuous(argv = [], deps = {}) {
  const args = parsePrioRunArgs(argv);
  const dir = args.stateDir || deps.dir || defaultStateDir();
  const maxPerTick = resolveMaxPerTick({ explicit: args.maxPerTick, file: path.join(dir, 'run.json') });
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const rawStdout = deps.stdout || process.stdout;
  const stdout = teeStdout(rawStdout, path.join(dir, `run-${new Date(now).toISOString().slice(0, 10)}.log`));
  const alertsFile = args.alertsFile || path.join(dir, 'alerts.jsonl');
  const disabledAtStart = fs.existsSync(path.join(dir, 'disabled'));
  const wantWrite = args.write === true && !disabledAtStart;
  if (args.write && disabledAtStart) stdout.write('已停写\n');

  // 上限已经在上面核对过。真写的令牌在任何看板读取之前读；失败就退出，不去访问网络。
  let token = null;
  if (wantWrite) {
    const file = deps.tokenPath || priorityTokenPath();
    token = typeof deps.readToken === 'function' ? deps.readToken() : readPriorityWriterToken(file);
  }

  try {
    const profile = deps.loadProfile ? deps.loadProfile() : loadAcceptanceProfile();
    const table = deps.table || readRepoClassTable(path.join(dir, 'repo-class.json'));
    const allowRepos = wantWrite || args.onlyEmptyToP2
      ? readAuthorizedRepos(path.join(dir, 'authorized-repos.json'))
      : [];
    const hourlyUsed = countRecentChanges(readChangeLog(dir), now, PRIO_HOURLY_WINDOW_MS);
    // 额度两道闸（#247 SC5 / SC6）：先看预算与响应头剩余，不够就这一拍不读看板、不写，也不报错。
    // 状态文件用 host/paths.mjs 的那一组（P1-1）；没给 home 又没显式给文件时不做额度闸（不猜路径）。
    const hostFiles = deps.hostFiles || hostFilesFromEnv(deps.env);
    const snapshotFile = deps.snapshotFile || hostFiles?.boardSnapshot || null;
    const rateFile = deps.rateFile || hostFiles?.rateState || null;
    const budgetFile = deps.budgetFile || hostFiles?.rateBudgetConfig || null;
    let budgets = deps.budgets || null;
    let budgetError = null;
    if (!budgets && budgetFile) {
      try {
        budgets = readBudgetFile(budgetFile);
      } catch (error) {
        // 配置缺了或值不对：报出来、不猜默认值，只走响应头闸。
        budgetError = String(error?.message || error);
        stdout.write(`额度预算配置无法使用：${budgetError}\n`);
      }
    }
    if (!rateFile) {
      stdout.write('额度闸未启用：没设 ACCEPTANCE_WATCHER_HOME，也没有显式给出额度状态文件\n');
    }
    const tickSeconds = deps.tickSeconds || TICK_SECONDS;
    // 快照先读：已经能用的快照不发整板读，这一拍就不该按整板读记点数（#247 P3-6）。
    const snapshot = snapshotFile ? readBoardSnapshot(snapshotFile, { now, tickSeconds }) : null;
    const willFetchBoard = !deps.loadItems && !snapshot?.ok;
    let gate = { allowed: true, state: null, log: null, remaining: null, skipStreak: 0, reason: '' };
    let gateError = null;
    let snapshotError = null;
    if (rateFile) {
      try {
        gate = decideTick({
          component: 'prio-run',
          purpose: 'board',
          state: readRateState(rateFile),
          now,
          budgets,
          cost: willFetchBoard ? BOARD_READ_COST : 0,
        });
        writeRateState(rateFile, gate.state);
      } catch (error) {
        // 额度判定或写状态自己出错（状态文件位置被目录占着、读不出来、写不下去）：这一拍照常跑（放行）并留痕。
        // 与 host/tick.mjs 的 rateGate 同一口径（#247 复审 P2-a）：要么放行 + 留痕，要么就不算 fail-open。
        gateError = String(error?.message || error);
        gate = { allowed: true, state: null, log: null, remaining: null, skipStreak: 0, reason: 'rate-gate-error' };
        stdout.write(
          `${new Date(now).toISOString()} rate-unknown component=prio-run identity=user remaining=unknown reason=rate-gate-error ${gateError} 判定或写状态出错，这一拍照常跑\n`,
        );
      }
      if (gate.log) {
        appendRateLog(path.join(dir, `run-${new Date(now).toISOString().slice(0, 10)}.log`), gate.log);
        stdout.write(`${gate.log}\n`);
      }
      if (!gate.allowed) {
        // 因额度跳过（SC6）：不抛错、不发起整板读，这一拍什么也不写。
        return {
          written: 0,
          exitCode: 0,
          disabled: disabledAtStart,
          alertsFile,
          skipped: gate.reason,
          stop: 'rate-budget',
          remaining: gate.remaining,
          skipStreak: gate.skipStreak,
          budgetError,
          gateError,
        };
      }
    }
    const board = await resolveBoard(deps, profile, table, {
      snapshot,
      snapshotFile,
      now,
      tickSeconds,
      onSnapshotError: (error) => {
        snapshotError = String(error?.message || error);
        stdout.write(
          `${new Date(now).toISOString()} board-snapshot-error component=prio-run reason=write-failed ${snapshotError} 快照写不下去，这一拍照常跑\n`,
        );
      },
    });
    let writeFn = deps.write || null;
    if (wantWrite && !writeFn) {
      const writer = createPriorityGithub({ profile, token, run: deps.run, fetchImpl: deps.fetchImpl });
      writeFn = (action) => writer.write(action);
    }
    const readBack = !wantWrite
      ? null
      : (deps.readBack || (board.reader
        ? async (change) => {
          if (typeof change?.itemId !== 'string' || !change.itemId) return null;
          const data = await board.reader.ownerGraphql(ITEM_FIELD_QUERY, { id: change.itemId });
          return readFieldValue(data?.node, change.field);
        }
        : async () => null));
    const sync = deps.sync || runPrioSync;
    let assessment = null;
    const result = await sync({
      dir,
      items: board.items,
      prs: board.prs,
      nowMs: now,
      apply: wantWrite,
      ownerLogin: profile.ownerLogin,
      projectNumber: profile.projectNumber,
      write: writeFn,
      stdout,
      table,
      excludedCount: board.excludedCount,
      nullContent: board.nullContent,
      onlyField: args.onlyField ?? null,
      // 写入时按闸放行；只带 --only-empty-to-p2 的 dry-run 也算一遍（只数不写，不动停写开关）。
      onPlan: wantWrite || args.onlyEmptyToP2
        ? (plan) => {
          assessment = assessContinuousPlan(plan, {
            maxPerTick,
            hourlyUsed,
            hourlyMax: PRIO_HOURLY_MAX,
            allowRepos,
            table,
            onlyEmptyToP2: args.onlyEmptyToP2,
            onlyField: args.onlyField ?? null,
          });
          if (assessment.onlyEmptyToP2) {
            const x = assessment.exclusions;
            stdout.write(
              `按 --only-empty-to-p2 排除 ${assessment.excludedTotal} 条（降级/清空 ${x.downgradeClear}、升 P1 ${x.upgradeToP1}、空→P1 ${x.emptyToP1}、关联 PR ${x.link}）\n`,
            );
            if (!wantWrite) {
              const list = assessment.wouldWrite.map((change) => `${change.item} ${change.field} ${priorityWord(change.old)} → ${priorityWord(change.new)}`);
              stdout.write(
                `按 --only-empty-to-p2 会写 ${list.length} 条：${list.length ? list.join('、') : '无'}\n`,
              );
            }
          }
          if (!wantWrite) return null;
          if (assessment.abort) return { abort: true, reason: assessment.reason };
          return { allow: assessment.allow };
        }
        : null,
      readBack,
    });
    writeStreak(dir, 0);
    const base = {
      written: result.written || 0,
      exitCode: 0,
      disabled: disabledAtStart || fs.existsSync(path.join(dir, 'disabled')),
      alertsFile,
      assessment,
      result,
      boardSource: board.source,
      boardSnapshotReason: board.snapshotReason || '',
      budgetError,
      gateError,
      snapshotError,
    };
    if (result.readbackMismatch) {
      writeDisabled(dir, '回读不一致，持续写入已暂停');
      emitAlert(stdout, alertsFile, now, 'readback', {});
      return { ...base, disabled: true, stop: 'readback' };
    }
    if (result.stoppedByDisabled) return { ...base, stop: 'disabled' };
    // 下面这些停写/告警只属于真写：dry-run（哪怕带了 --only-empty-to-p2）绝不建停写开关、不发告警。
    if (!wantWrite) return { ...base, stop: disabledAtStart ? 'disabled' : '' };
    if (result.outOfScopeHit || assessment?.reason === 'out-of-scope') {
      writeDisabled(dir, '范围外变更，持续写入已暂停');
      emitAlert(stdout, alertsFile, now, 'out-of-scope', {});
      return { ...base, disabled: true, stop: 'out-of-scope' };
    }
    if (assessment?.reason === 'downgrade') {
      writeDisabled(dir, '降级或改空，持续写入已暂停');
      emitAlert(stdout, alertsFile, now, 'downgrade', { downgrades: assessment.downgrades });
      return { ...base, disabled: true, stop: 'downgrade' };
    }
    if (assessment?.hourlyStop) {
      writeDisabled(dir, '每小时写入上限，持续写入已暂停');
      emitAlert(stdout, alertsFile, now, 'hourly', { written: result.written || 0 });
      return { ...base, disabled: true, stop: 'hourly' };
    }
    if (assessment?.nonAuto?.length) {
      emitAlert(stdout, alertsFile, now, 'nonempty', { nonAuto: assessment.nonAuto });
      return { ...base, stop: 'nonempty' };
    }
    return { ...base, stop: disabledAtStart ? 'disabled' : '' };
  } catch (error) {
    if (!isRetriableGithubError(error)) throw error;
    const streak = readStreak(dir) + 1;
    writeStreak(dir, streak);
    const paused = streak >= FAIL_STREAK_LIMIT;
    if (paused) writeDisabled(dir, '连续失败，持续写入已暂停');
    emitAlert(stdout, alertsFile, now, 'github', { paused, streak });
    return {
      written: 0,
      exitCode: 1,
      disabled: paused || disabledAtStart,
      alertsFile,
      stop: paused ? 'github-paused' : 'github',
      streak,
      error,
    };
  }
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  try {
    const result = await runContinuous(argv, deps);
    if (!deps.capture && result?.exitCode) process.exitCode = result.exitCode;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    (deps.stderr || process.stderr).write(`${message}\n`);
    if (!deps.capture) process.exitCode = 1;
    return { exitCode: 1, error, written: 0 };
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (invoked && here === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}
