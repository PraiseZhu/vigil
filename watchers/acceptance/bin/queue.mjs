#!/usr/bin/env node
// 认领队列排序（#62）：槽位只有 MAX_ROUNDS 个，先认谁由「看板优先级」决定，不再只看 issue 的 UPDATED_AT。
// 排序键：优先级 P0 → P1 → P2 → P3；同档按 issue createdAt 旧的先；再相同按 repo+号升序，保证同一份输入每次排出来的顺序一样。
// 无优先级（issue 不在看板上、或看板「优先级」是空的）按 P2 算；优先级读不到（快照缺失 / 过期 / 坏掉 / 值认不出）
// 也按 P2 算，只记一行日志，不让这一拍失败。
//
// 优先级从哪来：不新增任何 GraphQL 读。prio-run 每拍会把整板读的结果写进 <home>/state/host/board-snapshot.json，
// 这里用 rate-budget.mjs 的 readBoardSnapshot 读那一份（新鲜度规则与仓外读者一致：超过一个拍间隔就当过期）。
// 快照过期 / 缺失时这一拍全部按 P2 排（顺序退化成 createdAt + 号），并发一行日志。
// 看板只读：本文件不写看板、不发请求。
import { TICK_SECONDS, readBoardSnapshot } from './rate-budget.mjs';
import { hostPaths } from '../host/paths.mjs';

/** 没有优先级时用的档位：看板上空着、issue 不在看板上、读不到，都按它算。 */
export const PRIORITY_FALLBACK = 'P2';

/** 优先级档位，从前到后就是认领顺序。 */
export const PRIORITIES = Object.freeze(['P0', 'P1', 'P2', 'P3']);

const RANK = new Map(PRIORITIES.map((name, index) => [name, index]));

/** 认得出的档位返回 'P0'..'P3'，其余（null、空串、别的写法）返回 null。只看 trim + 大小写，不改写别的值。 */
export function normalizePriority(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim().toUpperCase();
  return RANK.has(text) ? text : null;
}

/** 排序用的档位序号（0 最优先）。认不出的值按 fallback 档算。 */
export function priorityRank(value) {
  const normalized = normalizePriority(value);
  return RANK.has(normalized) ? RANK.get(normalized) : RANK.get(PRIORITY_FALLBACK);
}

/** 快照里的条目 → ref → 优先级（原样保留看板值，没填就是 null）。ref 用 repo#号，与任务清单一致。 */
export function priorityMapFromItems(items = []) {
  const out = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const repo = item?.repo;
    const number = Number(item?.number);
    if (typeof repo !== 'string' || !repo || !Number.isInteger(number) || number <= 0) continue;
    out.set(`${repo}#${number}`, item?.priority ?? null);
  }
  return out;
}

/** 一条任务的创建时间（毫秒）：解析不出按「最新」算，让它排在同时段的后面，而不是顶到最前。 */
function createdMsOf(task) {
  const ms = Date.parse(task?.createdAt || '');
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function refOf(task) {
  return typeof task?.ref === 'string' && task.ref ? task.ref : `${task?.repo ?? ''}#${task?.number ?? 0}`;
}

/**
 * 排序：优先级档位 → createdAt 旧的先 → ref 升序。
 * `priorityOf(task)` 返回这条任务的看板优先级原值（不必先规整，这里会规整）；给不出就返回 null / undefined。
 * 纯函数：不改入参，返回新数组。
 */
export function sortTaskQueue(tasks, { priorityOf = () => null } = {}) {
  const list = Array.isArray(tasks) ? tasks : [];
  return list
    .map((task, index) => ({ task, index, rank: priorityRank(priorityOf(task)), createdMs: createdMsOf(task), ref: refOf(task) }))
    .sort((left, right) => {
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (left.createdMs !== right.createdMs) return left.createdMs < right.createdMs ? -1 : 1;
      if (left.ref !== right.ref) return left.ref < right.ref ? -1 : 1;
      // 同一份输入里 ref 与时间都相同（不该有，但别让它不稳定）：按原顺序。
      return left.index - right.index;
    })
    .map((row) => row.task);
}

/**
 * 读这一拍用的优先级表。只读本地快照，零 GraphQL。
 * 返回 { byRef, reason, from }：`reason` 非空表示这份优先级表不能用（快照 missing / stale / corrupt / clock-skew），
 * 调用方据此记日志；此时 byRef 是空表，全部任务按 P2 排。
 * `readSnapshot` 只给测试注入，默认 readBoardSnapshot。
 */
export function readQueuePriorities({ home, now = () => Date.now(), tickSeconds = TICK_SECONDS, readSnapshot = readBoardSnapshot } = {}) {
  if (typeof home !== 'string' || !home) return { byRef: new Map(), reason: 'no-home' };
  let file;
  try {
    file = hostPaths(home).boardSnapshot;
  } catch {
    return { byRef: new Map(), reason: 'no-home' };
  }
  let snapshot;
  try {
    snapshot = readSnapshot(file, { now: now(), tickSeconds });
  } catch {
    // 读快照自己出错（文件权限、不是文件……）：按「读不到」处理，不抛。
    return { byRef: new Map(), reason: 'error' };
  }
  if (!snapshot || snapshot.ok !== true) {
    return { byRef: new Map(), reason: String(snapshot?.reason || 'unknown') };
  }
  return { byRef: priorityMapFromItems(snapshot.items), reason: '' };
}

/**
 * 这一拍要记日志的降级说明：哪些任务因为「看板值认不出」被当成 P2。
 * 快照整份读不到时不算逐条的「值认不出」，由调用方按 reason 记一行（不逐个 issue 刷日志）。
 */
export function unrecognizedPriorities(tasks, priorityOf) {
  const out = [];
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const raw = priorityOf(task);
    if (typeof raw !== 'string' || !raw.trim()) continue;
    if (normalizePriority(raw) === null) out.push({ ref: refOf(task), value: raw });
  }
  return out;
}
