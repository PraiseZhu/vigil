import { optionalConfigStrict, requireConfig } from './profile.mjs';

export const SESSION_TITLE_TIME_ZONE = 'Asia/Shanghai';
// Optional marker in front of the `#N-` part, e.g. `修PR#1704-task丨1104`. Off by default so the title
// format stays exactly what users know; a repo opts in through the environment or profile config.
export const SESSION_TITLE_PREFIX_ENV = 'MIVO_SESSION_TITLE_PREFIX';
// Any printable marker (Chinese included); the separators and whitespace are reserved by the title shape.
const SESSION_TITLE_PREFIX_PATTERN = /^[^\s#丨:]{1,16}$/u;
// Both the old (`#N-…`) and the prefixed (`修PR#N-…`) shape are canonical: titles written before the
// prefix existed, or under a different prefix, are kept as they are, never renamed or regenerated.
const SESSION_TITLE_SHAPE = /^(?:[^\s#丨:]{1,16})?#(\d+)-(.+)丨(\d{4})$/u;
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

/** Title prefix configured for this watcher; `''` (the default) keeps the historical `#N-task丨MMDD` form. */
export function sessionTitlePrefix(env = process.env) {
  const value = optionalConfigStrict('sessionTitlePrefix', { envVar: SESSION_TITLE_PREFIX_ENV, env, fallback: '' });
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !SESSION_TITLE_PREFIX_PATTERN.test(value)) {
    throw new Error(`会话标题前缀无效：${SESSION_TITLE_PREFIX_ENV} 须为 1–16 位且不含空白、#、丨、冒号；留空表示不加前缀`);
  }
  return value;
}

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
  // 丨 (U+4E28) is a Han ideograph, but the title reserves it as the date separator: a stored title fed back as
  // the task source (`#790-任务丨0928`) must not put a second 丨 into the generated name.
  const chinese = (text.match(/\p{Script=Han}+/gu) ?? []).join('').replace(/丨/g, '');
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

export function repairSessionTitle({ task, prNumber, createdAt, repo, prefix = sessionTitlePrefix() } = {}) {
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new Error('session title requires a PR number');
  const date = sessionDate(createdAt);
  const taskName = shortTaskName({ task, prNumber, repo });
  return `${prefix}#${prNumber}-${taskName}丨${date.slice(5).replace('-', '')}`;
}

export function planSessionTitle({ pr, existing = {}, createdAt, repo, prefix = sessionTitlePrefix() } = {}) {
  if (!pr || typeof pr !== 'object') throw new Error('PR metadata is required');
  const nodeId = pr.id ?? pr.nodeId;
  if (existing.nodeId && existing.nodeId !== nodeId) throw new Error('session mapping drifted');
  // Legacy UTC title suffixes cannot establish the session's local creation date.
  const titleDate = sessionDate(existing.titleDate ?? existing.sessionCreatedAt ?? createdAt);
  const mmdd = titleDate.slice(5).replace('-', '');
  // A title already carrying the PR number and this session's date is kept verbatim, prefixed or not:
  // turning the prefix on (or off) must not rewrite sessions that already exist.
  const parsed = typeof existing.title === 'string' ? SESSION_TITLE_SHAPE.exec(existing.title) : null;
  if (parsed && Number(parsed[1]) === Number(pr.number) && parsed[3] === mmdd) {
    const taskName = parsed[2];
    if (han.test(taskName) && Array.from(taskName).length <= MAX_TASK_LENGTH
        && !/[丨\r\n:#]/u.test(taskName) && !/\bPR\s*\d+/i.test(taskName)) {
      return { title: existing.title, titleDate, taskName };
    }
  }
  const taskName = shortTaskName({ task: pr.title, prNumber: pr.number, repo });
  return { title: repairSessionTitle({ task: pr.title, prNumber: pr.number, createdAt: titleDate, repo, prefix }), titleDate, taskName };
}

// A title describes the session it was written for. A session that is being created now (the previous one was
// retired, or a retry dispatch creates instead of resuming) gets a freshly built title with the current prefix;
// carrying the stored text over is how #1772's replacement sessions kept an unprefixed title after the prefix was
// configured. Only the date is carried over, so the `丨MMDD` suffix still marks when the PR's repair started.
export function newSessionTitle({ pr, existing = {}, createdAt, repo, prefix = sessionTitlePrefix() } = {}) {
  if (!pr || typeof pr !== 'object') throw new Error('PR metadata is required');
  const titleDate = sessionDate(existing.titleDate ?? existing.sessionCreatedAt ?? createdAt);
  const taskName = shortTaskName({ task: pr.title, prNumber: pr.number, repo });
  return {
    title: repairSessionTitle({ task: pr.title, prNumber: pr.number, createdAt: titleDate, repo, prefix }),
    titleDate,
    taskName,
  };
}
