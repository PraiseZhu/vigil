import { requireConfig } from './profile.mjs';

export const SESSION_TITLE_TIME_ZONE = 'Asia/Shanghai';
// 目标仓库在 import 时从 profile/env 求值；缺失时 fail-closed（不回退到任何个人默认值）。
const MIVO_REPO = requireConfig('targetRepo', {
  envVar: 'MIVO_WATCHER_TARGET_REPO',
  hint: '示例："your-org/your-repo"。',
});
const MAX_TASK_LENGTH = 20;
const han = /\p{Script=Han}/u;

// 固定 PR 号 → 任务短名的映射表仅用于加速少数常见修复场景的标题生成，是可选的本地化优化；
// 这里不内置任何真实项目的 PR 号与内容，默认留空。可按需在 fork 里追加自己的映射。
export const MIVO_TASK_NAMES = Object.freeze({});

export function sessionDate(createdAt) {
  if (typeof createdAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(createdAt)) {
    const date = new Date(`${createdAt}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== createdAt) {
      throw new Error('session creation date is invalid');
    }
    return createdAt;
  }
  if (!(createdAt instanceof Date) && typeof createdAt !== 'number'
      && !(typeof createdAt === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(createdAt))) {
    throw new Error('session creation timestamp with timezone is required');
  }
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) throw new Error('session creation date is invalid');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SESSION_TITLE_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function shortTaskName({ task, prNumber, repo = MIVO_REPO } = {}) {
  if (repo === MIVO_REPO && Object.hasOwn(MIVO_TASK_NAMES, prNumber)) return MIVO_TASK_NAMES[prNumber];
  const text = String(task ?? '').normalize('NFKC')
    .replace(/^(?:feat|fix|chore|docs|test|refactor|perf|build|ci)(?:\([^)]*\))?!?:\s*/i, '')
    .replace(/(?:\bPR\s*#?\s*|#)\d+\b/gi, '');
  const chinese = (text.match(/\p{Script=Han}+/gu) ?? []).join('');
  if (chinese.length >= 2) return Array.from(chinese).slice(0, MAX_TASK_LENGTH).join('');
  const source = String(task ?? '').toLowerCase();
  if (/changelog|release.notes/.test(source)) return '更新日志修复';
  if (/bug.doctor|terminal|receipt/.test(source)) return '终态回执修复';
  if (/generation|image.slot/.test(source)) return '生成摘要修复';
  if (/camera|viewport|viewed|reopen/.test(source)) return '画布视图修复';
  if (/canvas|asset|image/.test(source)) return '画布反馈修复';
  if (/^docs\b|documentation/.test(source)) return '文档反馈修复';
  if (/^test\b|regression/.test(source)) return '测试反馈修复';
  return '审查反馈修复';
}

export function repairSessionTitle({ task, prNumber, createdAt, repo } = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('session title requires a PR number');
  const date = sessionDate(createdAt);
  const taskName = shortTaskName({ task, prNumber, repo });
  return `#${prNumber}-${taskName}丨${date.slice(5).replace('-', '')}`;
}

export function planSessionTitle({ pr, existing = {}, createdAt, repo } = {}) {
  if (!pr || typeof pr !== 'object') throw new Error('PR metadata is required');
  const nodeId = pr.id ?? pr.nodeId;
  if (existing.nodeId && existing.nodeId !== nodeId) throw new Error('session mapping drifted');
  // Legacy UTC title suffixes cannot establish the session's local creation date.
  const titleDate = sessionDate(existing.titleDate ?? existing.sessionCreatedAt ?? createdAt);
  const mmdd = titleDate.slice(5).replace('-', '');
  const prefix = `#${pr.number}-`;
  const suffix = `丨${mmdd}`;
  if (typeof existing.title === 'string' && existing.title.startsWith(prefix) && existing.title.endsWith(suffix)) {
    const taskName = existing.title.slice(prefix.length, -suffix.length);
    if (han.test(taskName) && Array.from(taskName).length <= MAX_TASK_LENGTH
        && !/[丨\r\n:#]/u.test(taskName) && !/\bPR\s*\d+/i.test(taskName)) {
      return { title: existing.title, titleDate, taskName };
    }
  }
  const taskName = shortTaskName({ task: pr.title, prNumber: pr.number, repo });
  return { title: repairSessionTitle({ task: pr.title, prNumber: pr.number, createdAt: titleDate, repo }), titleDate, taskName };
}
