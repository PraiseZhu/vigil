// 修正轮「按 issue 挂起」：<home>/state/prbot/hold.json 里列的修正子 issue，prbot 不认领、不写 GitHub。
// 到期条件三种：time（到点解除）、merged（某分支合进某 base 后解除）、manual（一直挂着，人工移除）。
// 文件不存在或为空：和没有这个功能时完全一样（不读 GitHub、不写任何文件）。
// 文件读不出 / 格式不对：整份当「不挂起」，只报一次 prbot-hold-invalid 提醒（理由见 docs/acceptance-prbot.md）；
// 引用合法但条件写坏的单条：只把这一条当 manual 保守挂着，同样报一次提醒。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { decideTick, readRateState } from '../bin/rate-budget.mjs';
import { appendAlert } from './paths.mjs';

export const HOLD_FILE_VERSION = 1;
/** 同一个 merged 条件最多多久查一次 GitHub（查询失败也算查过一次）。 */
export const HOLD_MERGE_CHECK_MIN_MS = 15 * 60 * 1000;
export const HOLD_UNTIL_TYPES = Object.freeze(['time', 'merged', 'manual']);

const ISSUE_REF = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_NAME = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * merged 条件用的只读查询：base 上有没有从这个分支合进来的 PR（merge / squash / rebase 合并都算）。
 * 宿主直接读（和发现阶段其余只读同一个 github 对象，计入 loop 的本小时用量），不经写闸。每次 1 点。
 */
export const MERGED_PR_QUERY = `query ($owner: String!, $name: String!, $head: String!, $base: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 1, states: MERGED, headRefName: $head, baseRefName: $base) {
      nodes { number mergedAt }
    }
  }
}`;

export function holdFilePath(paths) {
  return path.join(paths.prbotDir, 'hold.json');
}

function seenFilePath(paths) {
  return path.join(paths.prbotDir, 'hold-seen.json');
}

export function holdLogPath(paths) {
  return path.join(paths.prbotDir, 'hold.log');
}

export function isIssueRef(ref) {
  return typeof ref === 'string' && ISSUE_REF.test(ref);
}

function sameRef(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function repoOf(ref) {
  const match = ISSUE_REF.exec(ref);
  return match ? `${match[1]}/${match[2]}` : null;
}

/** 校验到期条件；返回规范化后的条件或 { error }。 */
export function toUntil(raw, issue) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'until 应为对象' };
  if (raw.type === 'manual') return { until: { type: 'manual' } };
  if (raw.type === 'time') {
    const at = Date.parse(raw.at || '');
    if (typeof raw.at !== 'string' || !Number.isFinite(at)) return { error: `until.at 不是合法时间：${String(raw.at)}` };
    return { until: { type: 'time', at: raw.at } };
  }
  if (raw.type === 'merged') {
    const repo = raw.repo === undefined ? repoOf(issue) : raw.repo;
    const base = raw.base === undefined ? 'main' : raw.base;
    if (typeof repo !== 'string' || !REPO_NAME.test(repo)) return { error: `until.repo 应为 owner/repo，实际：${String(raw.repo)}` };
    for (const [name, value] of [['branch', raw.branch], ['base', base]]) {
      if (typeof value !== 'string' || !BRANCH_NAME.test(value) || value.includes('..')) return { error: `until.${name} 不是合法分支名：${String(value)}` };
    }
    return { until: { type: 'merged', repo, branch: raw.branch, base } };
  }
  return { error: `until.type 应为 ${HOLD_UNTIL_TYPES.join(' / ')}，实际：${String(raw.type)}` };
}

/**
 * 读 hold.json。返回 { entries, problems, digest }：
 * - 文件不存在 / 只有空白：entries 为空、problems 为空（等于没有这个功能）；
 * - 读不出、不是 JSON、结构不对：entries 为空，problems 写原因；
 * - 单条 issue 引用不合法：跳过并记 problem；引用合法但条件 / 原因坏：当 manual 挂着并记 problem。
 */
export function readHolds(paths, { fsImpl = fs } = {}) {
  const file = holdFilePath(paths);
  let text;
  try {
    text = fsImpl.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { entries: [], problems: [], digest: null };
    return { entries: [], problems: [`hold.json 读不出：${error?.code || error?.message || error}`], digest: `read:${error?.code || 'error'}` };
  }
  if (text.trim() === '') return { entries: [], problems: [], digest: null };
  const digest = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { entries: [], problems: [`hold.json 不是合法 JSON：${String(error?.message || error).split('\n')[0]}`], digest };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.holds)) {
    return { entries: [], problems: ['hold.json 应为 { "version": 1, "holds": [...] }'], digest };
  }
  if (parsed.version !== HOLD_FILE_VERSION) {
    return { entries: [], problems: [`hold.json 的 version 应为 ${HOLD_FILE_VERSION}，实际：${String(parsed.version)}`], digest };
  }
  const entries = [];
  const problems = [];
  parsed.holds.forEach((raw, index) => {
    const issue = raw?.issue;
    if (!isIssueRef(issue)) {
      problems.push(`第 ${index + 1} 条的 issue 不是 owner/repo#n：${String(issue)}（这条忽略）`);
      return;
    }
    const checked = toUntil(raw.until, issue);
    const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim() : null;
    if (checked.error || !reason) {
      problems.push(`${issue} 的${checked.error ? ` ${checked.error}` : ' reason 为空'}（这条按人工解除保守挂着）`);
    }
    entries.push({
      issue,
      reason: reason || '(未写原因)',
      until: checked.until || { type: 'manual' },
      addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : null,
      invalid: Boolean(checked.error || !reason),
    });
  });
  return { entries, problems, digest };
}

/** 一条挂起记录的稳定标识：同一条（issue + 条件 + 添加时间）不重复记日志，解除也只记一次。 */
export function holdKey(entry) {
  return crypto.createHash('sha256').update(`${entry.issue.toLowerCase()}|${JSON.stringify(entry.until)}|${entry.addedAt || ''}`).digest('hex').slice(0, 16);
}

/** 人读的到期条件。 */
export function describeUntil(until) {
  if (until?.type === 'time') return `到 ${until.at} 自动解除`;
  if (until?.type === 'merged') return `${until.repo} 的 ${until.branch} 合进 ${until.base} 后自动解除`;
  return '人工移除前一直挂着';
}

function readSeen(paths) {
  try {
    const parsed = JSON.parse(fs.readFileSync(seenFilePath(paths), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { logged: {}, released: {}, checks: {}, alerted: {}, ...parsed };
    }
  } catch {
    // 没有或读不出：当第一次见。
  }
  return { logged: {}, released: {}, checks: {}, alerted: {} };
}

function writeSeen(paths, seen) {
  const file = seenFilePath(paths);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seen, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 去重记录写不下：最坏多记一行日志、多查一次，不挡发现。
  }
}

function appendHoldLog(paths, line) {
  try {
    fs.mkdirSync(paths.prbotDir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(holdLogPath(paths), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // 日志写不下不挡发现。
  }
}

/**
 * merged 查询能不能发：复用主循环那道剩余闸。只拦 remaining-below-800；
 * 没有状态文件、头未知、判定出错都放行（不把闸本身的故障变成误挂）。不写回额度状态。
 */
function allowMergedQuery(paths, nowMs) {
  try {
    if (!paths?.rateState) return true;
    const decided = decideTick({
      component: 'loop',
      purpose: 'non-essential',
      state: readRateState(paths.rateState),
      now: nowMs,
    });
    return decided.reason !== 'remaining-below-800';
  } catch {
    return true;
  }
}

/**
 * 一拍用一个：读一次 hold.json；isHeld(issue) 判断这个修正子 issue 现在是否挂起。
 * merged 条件同一拍内同一条件只查一次，跨拍至少隔 HOLD_MERGE_CHECK_MIN_MS；查询失败照旧挂着。
 * 剩余低于 800（decideTick 的 remaining-below-800，与主循环非必要读同一道闸）时不发查询，继续挂着，也不记成已查过。
 * 没有 hold.json（或为空）时不碰 GitHub、不写任何文件。
 */
export function createHoldChecker({ paths, github, now = () => Date.now(), profile } = {}) {
  const { entries, problems, digest } = readHolds(paths);
  let seen = null;
  let dirty = false;
  const loadSeen = () => {
    if (!seen) seen = readSeen(paths);
    return seen;
  };
  if (problems.length > 0) {
    const state = loadSeen();
    if (!Object.hasOwn(state.alerted, digest)) {
      try {
        appendAlert(paths, { kind: 'prbot-hold-invalid', reason: 'hold-file-invalid', detail: problems.join('；'), now, profile });
      } catch {
        // 提醒写不下不挡发现。
      }
      state.alerted = { [digest]: new Date(now()).toISOString() };
      dirty = true;
    }
  }
  const mergeCache = new Map();

  async function merged(until) {
    const condKey = `${until.repo}|${until.branch}|${until.base}`.toLowerCase();
    if (mergeCache.has(condKey)) return mergeCache.get(condKey);
    const state = loadSeen();
    const nowMs = now();
    const last = Date.parse(state.checks[condKey] || '');
    let result = false;
    const due = !(Number.isFinite(last) && last <= nowMs && nowMs - last < HOLD_MERGE_CHECK_MIN_MS) && github?.graphql;
    // 低于 800 全面暂停非必要读：这条查询不发、不记成已查过，下一次额度够了再查。判定自身出错则放行，和主循环 rateGate 一致。
    if (due && !allowMergedQuery(paths, nowMs)) {
      mergeCache.set(condKey, false);
      return false;
    }
    if (due) {
      state.checks[condKey] = new Date(nowMs).toISOString();
      dirty = true;
      try {
        const [owner, name] = until.repo.split('/');
        const data = await github.graphql(MERGED_PR_QUERY, { owner, name, head: until.branch, base: until.base });
        const nodes = data?.repository?.pullRequests?.nodes;
        result = Array.isArray(nodes) && nodes.some((node) => node && node.mergedAt);
      } catch {
        // 查不到不误解除：这一条继续挂着，下次到点再查。
        result = false;
      }
    }
    mergeCache.set(condKey, result);
    return result;
  }

  async function active(entry) {
    const key = holdKey(entry);
    const state = loadSeen();
    if (Object.hasOwn(state.released, key)) return false;
    if (entry.until.type === 'manual') return true;
    if (entry.until.type === 'time') {
      if (now() < Date.parse(entry.until.at)) return true;
    } else if (entry.until.type === 'merged') {
      if (!(await merged(entry.until))) return true;
    }
    state.released[key] = new Date(now()).toISOString();
    dirty = true;
    appendHoldLog(paths, { at: new Date(now()).toISOString(), event: 'released', issue: entry.issue, key, until: describeUntil(entry.until) });
    return false;
  }

  async function isHeld(issue) {
    if (entries.length === 0) return false;
    let held = false;
    for (const entry of entries) {
      if (!sameRef(entry.issue, issue)) continue;
      if (!(await active(entry))) continue;
      held = true;
      const key = holdKey(entry);
      const state = loadSeen();
      if (!Object.hasOwn(state.logged, key)) {
        state.logged[key] = new Date(now()).toISOString();
        dirty = true;
        appendHoldLog(paths, { at: state.logged[key], event: 'held', issue: entry.issue, key, reason: entry.reason, until: describeUntil(entry.until) });
      }
    }
    flush();
    return held;
  }

  function flush() {
    if (!dirty || !seen) return;
    writeSeen(paths, seen);
    dirty = false;
  }

  flush();
  return { entries, problems, isHeld, flush };
}

/** doctor 和 CLI list 用：列出当前条目和状态（不查 GitHub）。 */
export function describeHolds(paths, { now = () => Date.now() } = {}) {
  const { entries, problems } = readHolds(paths);
  const seen = entries.length > 0 ? readSeen(paths) : null;
  const rows = entries.map((entry) => {
    const key = holdKey(entry);
    let status = '挂起中';
    if (seen && Object.hasOwn(seen.released, key)) status = '已解除';
    else if (entry.until.type === 'time' && now() >= Date.parse(entry.until.at)) status = '已到期（下一拍解除）';
    return { ...entry, key, status, untilText: describeUntil(entry.until) };
  });
  return { rows, problems };
}
