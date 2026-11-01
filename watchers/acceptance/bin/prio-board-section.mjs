// 看板优先级只读节（#205）。给看板页调用：读 prio 状态目录，调 viewPrio，
// 滤掉已关闭和排除表里的 item，跨 UTC 日把前一天的运行日志拼在当天前面。
// 只用文件系统读。单个文件超过上限时只读末尾。目录缺失或读失败时返回降级文案，不抛错。
import fs from 'node:fs';
import path from 'node:path';
import { formatPrioClock, viewPrio } from './prio-view.mjs';

const PACIFIC = 'America/Los_Angeles';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const TITLE = '### 看板优先级（只读）';
const DIR_UNREADABLE = 'prio 状态目录读不到，其余部分照常';
const DAY_MS = 24 * 60 * 60 * 1000;

const FILE_SPECS = [
  { name: 'changes.jsonl', key: 'changes', label: '变更日志' },
  { name: 'debounce.json', key: 'debounce', label: '防抖状态' },
  { name: 'reminded.jsonl', key: 'reminded', label: '提醒记录' },
  { name: 'latency.jsonl', key: 'latency', label: '延迟日志' },
  { name: 'repo-class.json', key: 'repoClass', label: '分类表' },
];

function tokenPattern() {
  const pat = ['github', 'pat'].join('_');
  return new RegExp(
    `gh[pousr]_[A-Za-z0-9]{20,}|${pat}_[A-Za-z0-9_]+|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}`,
    'g',
  );
}

function redactLine(line) {
  return String(line).replace(tokenPattern(), '[redacted]');
}

function limitLabel(maxBytes) {
  if (maxBytes === DEFAULT_MAX_BYTES) return '2MB';
  const mb = maxBytes / (1024 * 1024);
  if (Number.isInteger(mb) && mb > 0) return `${mb}MB`;
  return `${maxBytes}B`;
}

function utcDay(ms) {
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 10);
}

function directoryReadable(fsImpl, dir) {
  try {
    const stat = fsImpl.statSync(dir);
    return Boolean(stat && typeof stat.isDirectory === 'function' && stat.isDirectory());
  } catch {
    return false;
  }
}

function dropPartialFirstLine(text) {
  const nl = text.indexOf('\n');
  if (nl < 0) return '';
  return text.slice(nl + 1);
}

function readCapped(fsImpl, file, maxBytes) {
  let stat;
  try {
    stat = fsImpl.statSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { text: '' };
    return { text: '', unreadable: true };
  }
  if (!stat || typeof stat.isDirectory !== 'function' || stat.isDirectory()) {
    return { text: '', unreadable: true };
  }
  const size = Number(stat.size);
  try {
    if (Number.isFinite(size) && size > maxBytes) {
      const fd = fsImpl.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const n = fsImpl.readSync(fd, buf, 0, maxBytes, size - maxBytes);
        return { text: dropPartialFirstLine(buf.subarray(0, n).toString('utf8')), truncated: true };
      } finally {
        try {
          fsImpl.closeSync(fd);
        } catch {
          // 句柄关掉失败时，已经读到的末尾仍然可用。
        }
      }
    }
    const raw = fsImpl.readFileSync(file, 'utf8');
    return { text: typeof raw === 'string' ? raw : String(raw ?? '') };
  } catch {
    return { text: '', unreadable: true };
  }
}

function noteFor(spec, result, maxBytes, notices) {
  if (result.unreadable) {
    notices.push(`读不到 ${spec.name}`);
    return;
  }
  if (result.truncated) notices.push(`${spec.label}过大，只读最近 ${limitLabel(maxBytes)}`);
}

function readExclude(text) {
  if (!text.trim()) return { repos: new Set(), bad: false };
  try {
    const parsed = JSON.parse(text);
    const list = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed.exclude : null;
    if (!Array.isArray(list)) return { repos: new Set(), bad: false };
    const repos = new Set();
    for (const entry of list) {
      if (typeof entry === 'string' && entry.trim()) repos.add(entry.trim().toLowerCase());
    }
    return { repos, bad: false };
  } catch {
    return { repos: new Set(), bad: true };
  }
}

function refOf(entry) {
  if (!entry || typeof entry !== 'object') return '';
  if (typeof entry.item === 'string' && entry.item.trim()) return entry.item.trim();
  const repo = typeof entry.repo === 'string' ? entry.repo.trim() : '';
  const number = Number(entry.number);
  if (!repo || !Number.isInteger(number) || number <= 0) return '';
  return `${repo}#${number}`;
}

function closedRefs(items) {
  const refs = new Set();
  if (!Array.isArray(items)) return refs;
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') continue;
    const state = String(entry.issueState ?? entry.state ?? '').trim().toLowerCase();
    if (entry.closed !== true && state !== 'closed') continue;
    const ref = refOf(entry);
    if (ref) refs.add(redactLine(ref));
  }
  return refs;
}

function repoOf(item) {
  const text = String(item);
  const hash = text.lastIndexOf('#');
  return (hash > 0 ? text.slice(0, hash) : text).toLowerCase();
}

function lineHidden(line, hidden) {
  for (const item of hidden) {
    if (line === item || line.startsWith(`${item} `)) return true;
  }
  return false;
}

function concatText(parts) {
  let out = '';
  for (const part of parts) {
    if (!part) continue;
    if (out && !out.endsWith('\n')) out += '\n';
    out += part;
  }
  return out;
}

/**
 * 渲染「看板优先级（只读）」这一节。
 * items 是看板上的条目，用来识别已关闭；排除表读状态目录里的 repo-class.json。
 * @param {object} [options]
 * @param {string} [options.stateDir]
 * @param {Array<object>} [options.items]
 * @param {number} [options.nowMs]
 * @param {number} [options.staleAfterMs] 停更阈值，默认 10 分钟。
 * @param {number} [options.maxBytes] 单文件读取上限，默认 2MB，只读末尾。
 * @param {object} [options.fs]
 */
export function renderPrioBoardSection(options = {}) {
  const fsImpl = options.fs || fs;
  const stateDir = options.stateDir;
  if (typeof stateDir !== 'string' || !stateDir || !directoryReadable(fsImpl, stateDir)) {
    return `${TITLE}\n${DIR_UNREADABLE}`;
  }
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const maxBytes = Number.isInteger(options.maxBytes) && options.maxBytes > 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const notices = [];
  const loaded = {};
  for (const spec of FILE_SPECS) {
    const result = readCapped(fsImpl, path.join(stateDir, spec.name), maxBytes);
    loaded[spec.key] = result.text;
    noteFor(spec, result, maxBytes, notices);
  }
  const exclude = readExclude(loaded.repoClass || '');
  if (exclude.bad) notices.push('分类表不是合法 JSON');

  const today = utcDay(nowMs);
  const yesterday = utcDay(nowMs - DAY_MS);
  const runParts = [];
  for (const day of [yesterday, today]) {
    if (!day) continue;
    const name = `run-${day}.log`;
    const result = readCapped(fsImpl, path.join(stateDir, name), maxBytes);
    noteFor({ name, label: '运行日志' }, result, maxBytes, notices);
    runParts.push(result.text);
  }

  const view = viewPrio({
    changes: loaded.changes || '',
    debounce: loaded.debounce || '',
    reminded: loaded.reminded || '',
    runLog: concatText(runParts),
    latency: loaded.latency || '',
    nowMs,
    ...(Number.isFinite(options.staleAfterMs) ? { staleAfterMs: options.staleAfterMs } : {}),
    timeZone: PACIFIC,
  });

  const closed = closedRefs(options.items);
  let closedCount = 0;
  let excludedCount = 0;
  const hidden = new Set();
  for (const row of view.rows) {
    if (exclude.repos.has(repoOf(row.item))) {
      excludedCount += 1;
      hidden.add(row.item);
      continue;
    }
    if (closed.has(row.item)) {
      closedCount += 1;
      hidden.add(row.item);
    }
  }

  const fetched = formatPrioClock(nowMs, PACIFIC);
  const lastRun = view.lastRunAt ? formatPrioClock(Date.parse(view.lastRunAt), PACIFIC) : '无';
  const lines = [
    TITLE,
    `数据源：changes.jsonl、debounce.json、reminded.jsonl、latency.jsonl、运行日志｜取数时间：${fetched}｜最近运行：${lastRun}`,
  ];
  if (closedCount > 0 || excludedCount > 0) {
    lines.push(`已隐藏：已关闭 ${closedCount}、已排除 ${excludedCount}`);
  }
  for (const line of view.lines) {
    if (lineHidden(line, hidden)) continue;
    lines.push(line);
  }
  lines.push(...notices);
  return lines.map((line) => redactLine(line)).join('\n');
}
