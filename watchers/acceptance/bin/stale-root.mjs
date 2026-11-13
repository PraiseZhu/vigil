#!/usr/bin/env node
// 老根单每日汇总（#62）：开着超过 7 天、从来没进过验收的根 issue，靠 trigger 自己的 reason 说清「为什么不会开始」。
// 这些单子不会自己动：shouldTrigger() 一直返回不触发（最常见的是没有已合并的 PR），没有轮次记录，
// 也不会出现在任何别的提醒里——挂了 16 天没人知道。
//
// 这里只做两件事：
// 1. 纯判断：哪些根 issue 属于「超过 7 天、没进过验收、这一拍也不触发」，以及给人看的原因；
// 2. 每日一次：同一 issue 每个本机日只报一次，报进现成的摘要路径（alerts.jsonl → Slack 摘要），
//    **不发实时通知**、不新增实时告警路径、不写看板、不额外发 GraphQL（只用盘点已经在手里的 tasks）。
import fs from 'node:fs';
import path from 'node:path';
import { shouldTrigger } from './trigger.mjs';

/** 天数阈值：超过 7×24 小时才算（正好 7 天不算），留出「第 7 天还没动」的余量。 */
export const STALE_ROOT_DAYS = 7;
export const STALE_ROOT_MS = STALE_ROOT_DAYS * 24 * 60 * 60 * 1000;

/** 本地状态文件格式版本。 */
export const STALE_ROOT_STATE_VERSION = 1;

/** 状态文件名：`<home>/state/host/stale-root-digest.json`（记每个 issue 上次是哪天报的）。只在本机读写。 */
export const STALE_ROOT_STATE_FILE = 'stale-root-digest.json';

/**
 * 不触发原因 → 人话。这是给人看的报警正文，所以不写 reason 代码本身。
 * 表里没有的 reason 用 fallback，把代码附在括号里，方便对着 trigger.mjs 查。
 */
export const STALE_ROOT_REASON_TEXT = Object.freeze({
  'no-merged-pr': '没有已合并的 PR，验收机不会自动开始验收',
  'children-open': '子 issue 还没全部关闭，验收机要等子 issue 都关了才验总 issue',
  'awaiting-lead-handoff': '在等 lead 交接验收，交接之前不开轮',
  'awaiting-adjudication': '有争议的条目在等裁决结果',
  'in-progress': '上一轮还标着「验收中」，等那一轮结束',
  backoff: '上一轮中断过，还在退避，没到重试时间',
  'correction-issue': '正文带修正标记，不开轮',
  'parent-in-progress': '父 issue 有一轮正在验收中',
  'parent-covered': '父 issue 的结论已经覆盖了这张子 issue',
  'merged-after-verdict-unknown': 'PR 合并时间读不出来，不敢判断有没有新东西要验',
  'up-to-date': '已有结论，之后没有新变化',
});

/** 原因的人话；认不出的 reason 也返回一句人话，不返回空串。 */
export function staleRootReasonText(reason) {
  const key = typeof reason === 'string' ? reason : '';
  const found = STALE_ROOT_REASON_TEXT[key];
  if (found) return found;
  return `验收机这一拍没开始验收（原因代码：${key || '未知'}）`;
}

/** 根 issue：没有可信父 issue 的 parent / standalone。子 issue（kind='child'）不算。 */
export function isRootTask(task) {
  return task?.kind === 'parent' || task?.kind === 'standalone';
}

/**
 * 是否属于「开着超过 7 天、从没进过验收、这一拍也不触发」的根 issue。
 * 返回 null（不算）或 { ref, repo, number, url, ageDays, reason, text }。
 *
 * 边界（单测固定下来）：
 * - 年龄严格大于 7×24 小时才报：正好 7 天不报，7 天 + 1 毫秒就报；
 * - 有轮次记录（进过验收）不报；
 * - 子 issue（有父）不报；
 * - 已关闭不报；
 * - 这一拍会触发（马上会被认领）不报——那不是漏单。
 */
export function staleRootOf(task, { now, profile, nowMs } = {}) {
  if (!isRootTask(task)) return null;
  if (task.state !== 'open') return null;
  if ((task.rounds || []).length > 0) return null;
  const current = Number.isFinite(nowMs) ? nowMs : Number(now?.());
  if (!Number.isFinite(current)) return null;
  const createdMs = Date.parse(task.createdAt || '');
  if (!Number.isFinite(createdMs)) return null;
  const age = current - createdMs;
  if (age <= STALE_ROOT_MS) return null;
  const decision = shouldTrigger(task, { now: () => current, profile });
  if (decision?.trigger) return null;
  return {
    ref: task.ref,
    repo: task.repo,
    number: task.number,
    url: task.url || null,
    ageDays: Math.floor(age / (24 * 60 * 60 * 1000)),
    reason: decision?.reason || 'unknown',
    text: staleRootReasonText(decision?.reason),
  };
}

/** 这一拍该进汇总的根 issue：按建得最早（年龄最大）在前，同龄按 ref 升序，保证顺序确定。 */
export function staleRootDigest(tasks, { now, profile, nowMs } = {}) {
  const out = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const row = staleRootOf(task, { now, profile, nowMs });
    if (row) out.push(row);
  }
  return out.sort((left, right) => {
    if (left.ageDays !== right.ageDays) return right.ageDays - left.ageDays;
    if (left.ref === right.ref) return 0;
    return left.ref < right.ref ? -1 : 1;
  });
}

// ── 每日一次 ──

/** 本机日期（YYYY-MM-DD）：和 Slack 每日上限同一口径，按本机零点切。 */
export function digestDay(nowMs) {
  const date = new Date(nowMs);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 读「这个 issue 上次是哪天报的」。文件不在、坏了都当第一次（不抛）。 */
export function readStaleRootState(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { version: STALE_ROOT_STATE_VERSION, days: {} };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { version: STALE_ROOT_STATE_VERSION, days: {} };
  }
  const days = {};
  const source = parsed.days && typeof parsed.days === 'object' && !Array.isArray(parsed.days) ? parsed.days : {};
  for (const [ref, day] of Object.entries(source)) {
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) days[ref] = day;
  }
  return { version: STALE_ROOT_STATE_VERSION, days };
}

/** 原子写（同目录临时文件 + rename）：读的人要么看到旧内容，要么看到新内容。目录不在就建。 */
export function writeStaleRootState(file, { days = {} } = {}) {
  const payload = { version: STALE_ROOT_STATE_VERSION, days };
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

/**
 * 这一拍要报哪些、报完的状态是什么。
 * - 今天还没报过的报；今天报过的不再报（同一个 issue 一天一条，不刷屏）；
 * - 不再符合条件的（已验证、已关、已有 PR）从状态里删掉，之后重新符合条件可以当天再报一次。
 * 返回 { due, next }：`due` 是要报的行，`next` 是要落盘的状态（只留这一拍仍符合条件的 ref）。
 */
export function selectDueStaleRoots(rows, state, day) {
  const list = Array.isArray(rows) ? rows : [];
  const previous = state?.days && typeof state.days === 'object' && !Array.isArray(state.days) ? state.days : {};
  const next = {};
  const due = [];
  for (const row of list) {
    if (!row?.ref) continue;
    if (previous[row.ref] === day) {
      next[row.ref] = day;
      continue;
    }
    next[row.ref] = day;
    due.push(row);
  }
  return { due, next };
}
