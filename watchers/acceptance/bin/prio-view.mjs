// 看板优先级只读视图（#199）。调用方把 .prio 里的文件内容传进来。
// 不读文件、不读环境变量、不联网、不写看板。坏行跳过，不让一处脏数据拖垮整页。
//
// changes.jsonl / debounce.json / reminded.jsonl / run-YYYY-MM-DD.log 的形状
// 与 prio-sync.mjs 的 appendChange、saveDebounce、remindOnce、main 运行头一致。
// latency.jsonl 的形状与 event-pull.mjs 追加的行一致；没有样本时 p50/p95 显示「无数据」。
// 已关闭、已排除的 item 本函数不判断，由调用方过滤。
// 运行日志跨 UTC 日时，调用方要把前一天的日志拼在前面。
//
// 停更：最后一个运行头距 nowMs 超过阈值才报。默认 10 分钟（cron 两个周期）。
// 恰好等于阈值不报。这是待 Issue Inspector 改定的默认值，调用方可以传 staleAfterMs。
// 运行头是读完看板之后才写入的，红条只说明这段时间没有新的一拍开始，不说明上一拍成功。
//
// 冻结只数 CHANGE_WINDOW_MS（1 小时）内、且不晚于 nowMs 的 changes。
// prio-sync 有几处会把没过滤的旧数组原样存回去，所以这里不能直接看数组长度。

import { CHANGE_WINDOW_MS, MAX_CHANGES_PER_HOUR } from './prio-score.mjs';

/** 停更阈值默认值。待 Issue Inspector 改定。 */
export const DEFAULT_STALE_MS = 10 * 60 * 1000;

/** 与 prio-score.mjs 的 MAX_CHANGES_PER_HOUR 相同。窗口用那边的 CHANGE_WINDOW_MS。 */
export const FREEZE_AT_CHANGES = MAX_CHANGES_PER_HOUR;

const RUN_HEADER = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (dry-run|apply) (\d+)$/;

function tokenPattern() {
  const pat = ['github', 'pat'].join('_');
  return new RegExp(
    `gh[pousr]_[A-Za-z0-9]{20,}|${pat}_[A-Za-z0-9_]+|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}`,
    'g',
  );
}

function redact(value) {
  if (typeof value !== 'string' || !value) return value;
  return value.replace(tokenPattern(), '[redacted]');
}

function show(value) {
  if (value == null || value === '') return '（空）';
  return String(value);
}

function parseJsonl(text) {
  const rows = [];
  let bad = 0;
  if (typeof text !== 'string' || !text) return { rows, bad };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        bad += 1;
        continue;
      }
      rows.push(parsed);
    } catch {
      bad += 1;
    }
  }
  return { rows, bad };
}

function readDebounce(text) {
  if (typeof text !== 'string' || !text.trim()) return { items: {}, bad: false };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { items: {}, bad: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { items: {}, bad: true };
  const items = parsed.items;
  if (items == null) return { items: {}, bad: false };
  if (typeof items !== 'object' || Array.isArray(items)) return { items: {}, bad: true };
  return { items, bad: false };
}

function lastRunOf(text) {
  if (typeof text !== 'string' || !text) return null;
  let last = null;
  for (const raw of text.split('\n')) {
    const match = RUN_HEADER.exec(raw.trim());
    if (!match) continue;
    if (!Number.isFinite(Date.parse(match[1]))) continue;
    last = { at: match[1], mode: match[2] };
  }
  return last;
}

/** 与 prio-score recentChanges 同一条：有限、不晚于现在、距现在严格小于 1 小时。 */
function recentChangeTimes(changes, nowMs) {
  if (!Array.isArray(changes) || !Number.isFinite(nowMs)) return [];
  return changes.filter((at) => Number.isFinite(at) && at <= nowMs && nowMs - at < CHANGE_WINDOW_MS);
}

function clock(ms) {
  const date = new Date(ms);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function freezeText(changes, nowMs) {
  const recent = recentChangeTimes(changes, nowMs).sort((left, right) => left - right);
  if (recent.length < FREEZE_AT_CHANGES) return '';
  const oldestStillNeeded = recent[recent.length - FREEZE_AT_CHANGES];
  return `冻结（1 小时内 ${recent.length} 次，约 ${clock(oldestStillNeeded + CHANGE_WINDOW_MS)} 解冻）`;
}

function percentiles(rows) {
  const values = [];
  for (const row of rows) {
    const value = row?.latencyMs;
    if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
  }
  values.sort((left, right) => left - right);
  if (!values.length) return { p50: null, p95: null, n: 0 };
  const at = (p) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))];
  return { p50: at(0.5), p95: at(0.95), n: values.length };
}

function latencyLine(stats) {
  const p50 = stats.p50 == null ? '无数据' : String(stats.p50);
  const p95 = stats.p95 == null ? '无数据' : String(stats.p95);
  return `关联 PR 延迟 p50 ${p50} p95 ${p95}`;
}

function basisText(basis) {
  if (typeof basis !== 'string' || !basis.trim()) return '（无）';
  return basis;
}

function reminderText(record) {
  if (record.kind !== 'manual') return record.text;
  const field = typeof record.field === 'string' && record.field ? record.field : '优先级';
  return `${field}（目标 ${show(record.target)}）：${record.text}`;
}

function rowLine(row, mode) {
  const parts = [`${row.item} 优先级 ${show(row.priority)} 依据：${basisText(row.basis)}`];
  if (row.freezeText) parts.push(row.freezeText);
  if (row.pendingHeld) {
    const drill = mode === 'dry-run' ? '（演练）' : '';
    parts.push(`待降级到 ${show(row.pending)}${drill}`);
  }
  if (row.reminders.length) parts.push(`提醒：${row.reminders.join('；')}`);
  return parts.join(' ');
}

function itemOrder(item) {
  const text = String(item);
  const hash = text.lastIndexOf('#');
  if (hash < 0) return { repo: text, issue: Number.POSITIVE_INFINITY };
  const issue = Number(text.slice(hash + 1));
  return {
    repo: text.slice(0, hash),
    issue: Number.isInteger(issue) && issue > 0 ? issue : Number.POSITIVE_INFINITY,
  };
}

function compareItems(left, right) {
  const a = itemOrder(left.item);
  const b = itemOrder(right.item);
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
  if (a.issue !== b.issue) return a.issue - b.issue;
  if (left.item === right.item) return 0;
  return left.item < right.item ? -1 : 1;
}

/**
 * @param {object} [input]
 * @param {string} [input.changes] changes.jsonl 全文
 * @param {string} [input.debounce] debounce.json 全文
 * @param {string} [input.reminded] reminded.jsonl 全文
 * @param {string} [input.runLog] 运行日志全文。跨 UTC 日时把前一天拼在前面，取最后一个运行头。
 * @param {string} [input.latency] latency.jsonl 全文。缺省或没有样本时 p50/p95 为「无数据」。
 * @param {number} input.nowMs 当前时间（毫秒）。调用方传入，本函数不调用 Date.now。
 * @param {number} [input.staleAfterMs] 停更阈值。默认 10 分钟。距离恰好等于阈值不算停更。
 */
export function viewPrio({
  changes = '',
  debounce = '',
  reminded = '',
  runLog = '',
  latency = '',
  nowMs,
  staleAfterMs = DEFAULT_STALE_MS,
} = {}) {
  const notices = [];
  const byItem = new Map();

  function ensure(item) {
    if (typeof item !== 'string' || !item) return null;
    let row = byItem.get(item);
    if (!row) {
      row = {
        item,
        priority: null,
        basis: '',
        prioritySeen: false,
        pendingHeld: false,
        pending: null,
        frozen: false,
        freezeText: '',
        reminders: [],
      };
      byItem.set(item, row);
    }
    return row;
  }

  const changeLog = parseJsonl(changes);
  if (changeLog.bad) notices.push(`变更日志有 ${changeLog.bad} 行坏数据`);
  for (const record of changeLog.rows) {
    const row = ensure(record.item);
    if (!row) continue;
    if (record.field !== '优先级') continue;
    row.priority = record.new ?? null;
    row.basis = typeof record.basis === 'string' ? record.basis : '';
    row.prioritySeen = true;
  }

  const saved = readDebounce(debounce);
  if (saved.bad) notices.push('防抖状态不是合法 JSON');
  for (const [ref, state] of Object.entries(saved.items)) {
    if (!state || typeof state !== 'object' || Array.isArray(state)) continue;
    const row = ensure(ref);
    if (!row) continue;
    if (!row.prioritySeen && 'priority' in state) row.priority = state.priority ?? null;
    row.pendingHeld = state.pendingHeld === true;
    row.pending = state.pending ?? null;
    row.freezeText = freezeText(state.changes, nowMs);
    row.frozen = row.freezeText !== '';
  }

  const reminderLog = parseJsonl(reminded);
  if (reminderLog.bad) notices.push(`提醒记录有 ${reminderLog.bad} 行坏数据`);
  for (const record of reminderLog.rows) {
    if (record.kind !== 'stale' && record.kind !== 'manual') continue;
    if (typeof record.text !== 'string') continue;
    const row = ensure(record.item);
    if (!row) continue;
    row.reminders.push(reminderText(record));
  }

  const latencyLog = parseJsonl(latency);
  if (latencyLog.bad) notices.push(`延迟日志有 ${latencyLog.bad} 行坏数据`);
  const latencyStats = percentiles(latencyLog.rows);

  const run = lastRunOf(runLog);
  const lastRunAt = run ? run.at : null;
  const lastRunMode = run ? run.mode : null;
  const limit = Number.isFinite(staleAfterMs) ? staleAfterMs : DEFAULT_STALE_MS;
  let stale = false;
  if (!Number.isFinite(nowMs)) {
    notices.push('缺少当前时间');
  } else if (!lastRunAt) {
    stale = true;
  } else {
    stale = nowMs - Date.parse(lastRunAt) > limit;
  }

  const rows = [...byItem.values()]
    .map((row) => ({
      item: redact(row.item),
      priority: typeof row.priority === 'string' ? redact(row.priority) : row.priority,
      basis: redact(row.basis) || '',
      pendingHeld: row.pendingHeld,
      pending: typeof row.pending === 'string' ? redact(row.pending) : row.pending,
      frozen: row.frozen,
      freezeText: redact(row.freezeText) || '',
      reminders: row.reminders.map((text) => redact(text)),
    }))
    .sort(compareItems);

  const lines = [];
  if (stale) {
    lines.push(lastRunAt ? `停更红条：最近运行头 ${lastRunAt}` : '停更红条：没有运行头');
  }
  for (const row of rows) lines.push(rowLine(row, lastRunMode));
  lines.push(latencyLine(latencyStats));
  for (const notice of notices) lines.push(notice);

  return {
    lines: lines.map((line) => redact(line)),
    rows,
    lastRunAt,
    lastRunMode,
    stale,
    staleAfterMs: limit,
    latency: latencyStats,
    notices: notices.map((notice) => redact(notice)),
  };
}
