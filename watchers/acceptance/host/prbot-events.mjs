#!/usr/bin/env node
// 修正轮事件（#60 SC10 / SC11）。这是 #61 的接口：prbot 只写 <home>/state/prbot/events.jsonl，
// 绝不调 Slack、绝不读 Slack 令牌。
//
// 事件 schema（一行一条 JSON）：
//   type: 'claimed' | 'draft-opened' | 'ready' | 'needs-human' | 'interrupted-exhausted' | 'ready-stalled'
//   at: ISO-8601 时间（本模块补）
//   issue: 修正子 issue（owner/repo#n）
//   root: 总 issue（owner/repo#n）
//   item: 验收项出处（owner/repo#n）
//   sc: 修了哪几条 SC（number[]）
//   repo, pr, prUrl, headSha
//   checks: { green, total, url }
//   diff: { files, additions, deletions }
//   handoff: 'owner' | 'watcher'
//   reason/detail: 需人工处理或中断的原因（自由文本，写前脱敏）
//   readyAt: 仅 ready-stalled 用，转 Ready 的时间
//
// #61 只依赖 type + 上面这些字段；新增字段只能追加，不能改已有字段的含义。
import fs from 'node:fs';
import path from 'node:path';
import { redact } from '../bin/redact.mjs';

export const PRBOT_EVENT_TYPES = Object.freeze([
  'claimed',
  'draft-opened',
  'ready',
  'needs-human',
  'interrupted-exhausted',
  'ready-stalled',
]);

const TYPE_SET = new Set(PRBOT_EVENT_TYPES);

function eventsFile(paths) {
  if (typeof paths?.prbotEventsFile === 'string') return paths.prbotEventsFile;
  if (typeof paths?.home === 'string' && path.isAbsolute(paths.home)) {
    return path.join(paths.home, 'state', 'prbot', 'events.jsonl');
  }
  throw new Error('appendPrbotEvent 需要 hostPaths(home)（带 prbotEventsFile）');
}

function redactDeep(value, profile) {
  if (typeof value === 'string') return redact(value, profile);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, profile));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      out[key] = redactDeep(item, profile);
    }
    return out;
  }
  return value;
}

/** 追加一条事件：校验 type、补 at、脱敏、目录 700、文件 600。 */
export function appendPrbotEvent(paths, event, { now = () => Date.now(), profile } = {}) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw new Error('appendPrbotEvent 需要事件对象');
  }
  if (!TYPE_SET.has(event.type)) {
    throw new Error(`未知的修正轮事件类型：${event.type ?? '(空)'}`);
  }
  const at = typeof event.at === 'string' && event.at ? event.at : new Date(now()).toISOString();
  const payload = redactDeep({ ...event, at }, profile);
  const file = eventsFile(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 权限设置失败不改变事件内容；运维检查会看到。
  }
  return payload;
}

/** 读回事件（#61 和测试用）。坏行跳过，不抛错。 */
export function readPrbotEvents(paths) {
  let text;
  try {
    text = fs.readFileSync(eventsFile(paths), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) out.push(parsed);
    } catch {
      // 坏一行不影响其它事件。
    }
  }
  return out;
}
