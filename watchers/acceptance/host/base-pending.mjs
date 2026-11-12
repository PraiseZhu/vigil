// 合入非默认分支、久等不到默认分支的任务（#380）：进每日汇总，不发实时、不发 GitHub 请求。
// 验收机只按默认分支验代码（#379 起是长期口径，见 docs/acceptance-pr-base-branch.md），关联 PR 合进集成分支的任务
// 先不验。集成分支被放弃、或合回默认分支的 PR 不引用这些 issue 时，任务就永远等不到验收，这里兜底：
// 距最近一次非默认分支合并严格超过 3 天的，每天（UTC 日期）报一次，后来合入默认分支（不再出现在 baseSkipped 里）就自动清掉。
import fs from 'node:fs';
import path from 'node:path';
import { appendAlert } from './paths.mjs';

export const BASE_PENDING_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
export const BASE_PENDING_KIND = 'base-not-default';
const STATE_FILE = 'base-pending.json';

/**
 * 这条跳过记录该不该进汇总：只看 base-not-default（目标分支已知、确实不是默认分支）；
 * 已关闭的 issue 不报（关了就是有人处理过了）；mergedAt 解析不出不报；严格大于 3×24 小时才报。
 */
export function basePendingOverdue(record, nowMs) {
  if (record?.reason !== BASE_PENDING_KIND) return false;
  if (record.state === 'closed') return false;
  const at = Date.parse(record.mergedAt ?? '');
  return Number.isFinite(at) && nowMs - at > BASE_PENDING_AFTER_MS;
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * 从这一拍 poll 的 baseSkipped 里挑今天要报的。state = { reported: { <issue>: <最后一次报的 UTC 日期> } }。
 * 返回的 next 只留这一拍仍然超期的条目：不再符合条件的（合入默认分支了、issue 关了）自动清掉。
 */
export function selectDueBasePending({ baseSkipped = [], state = {}, nowMs }) {
  const today = dayOf(nowMs);
  const reported = state && typeof state.reported === 'object' && state.reported ? state.reported : {};
  const overdue = (Array.isArray(baseSkipped) ? baseSkipped : []).filter((record) => basePendingOverdue(record, nowMs));
  const due = overdue.filter((record) => reported[record.issue] !== today);
  const dueIssues = new Set(due.map((record) => record.issue));
  const next = { reported: Object.fromEntries(overdue.map((record) => [record.issue, dueIssues.has(record.issue) ? today : reported[record.issue]])) };
  return { due, next };
}

function prUrl(ref) {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(String(ref ?? ''));
  return match ? `https://github.com/${match[1]}/pull/${match[2]}` : null;
}

/** 人话原因：哪个 issue、合进了哪个分支、等了几天、该怎么办。不出现内部 reason 代码。 */
export function basePendingReason(record, nowMs) {
  const days = Math.floor((nowMs - Date.parse(record.mergedAt)) / (24 * 60 * 60 * 1000));
  const branch = record.base || '非默认分支';
  return `关联 PR 合进了 ${branch}，已经 ${days} 天没合入默认分支 ${record.defaultBranch || 'main'}；验收机只按默认分支验，这个任务一直没验。`
    + '请把工作合回默认分支、关掉 issue，或人工点名验一次。';
}

/** 写进提醒文件，按日去重。状态文件写不下去时照样抛出，由 tick 记进心跳。 */
export function reportBasePending({ paths, baseSkipped, now = () => Date.now() }) {
  const file = path.join(paths.hostDir, STATE_FILE);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { state = {}; }
  const nowMs = now();
  const { due, next } = selectDueBasePending({ baseSkipped, state, nowMs });
  for (const record of due) {
    appendAlert(paths, {
      kind: BASE_PENDING_KIND,
      issue: record.issue,
      reason: basePendingReason(record, nowMs),
      url: record.url || null,
      base: record.base || null,
      defaultBranch: record.defaultBranch || null,
      mergedAt: record.mergedAt,
      prs: (record.prs || []).map((pr) => ({ ref: pr.ref, base: pr.base ?? null, url: prUrl(pr.ref) })),
      ...(record.child ? { child: record.child } : {}),
      now,
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return { reported: due.map((record) => record.issue) };
}
