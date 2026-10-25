#!/usr/bin/env node
// 触发与退避：纯函数，now 由调用方注入。
import { isVerdictOnly } from './profile.mjs';
import { latestRound } from './rounds.mjs';

export const BACKOFF_MINUTES = Object.freeze([0, 5, 15, 60]);

function trailingInterruptCount(rounds) {
  const ordered = [...(rounds || [])].sort((a, b) => a.round - b.round);
  let k = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    if (ordered[i].status === '中断') k += 1;
    else break;
  }
  return k;
}

/** 最近连续「中断」轮次对应的退避截止时间；k=0 表示没有退避。 */
export function backoffUntil(rounds) {
  const k = trailingInterruptCount(rounds);
  if (k === 0) return null;
  const minutes = k === 1 ? BACKOFF_MINUTES[0] : k === 2 ? BACKOFF_MINUTES[1] : k === 3 ? BACKOFF_MINUTES[2] : BACKOFF_MINUTES[3];
  const last = [...rounds].filter((round) => round.status === '中断').sort((a, b) => a.round - b.round).at(-1);
  const from = last?.finishedAt || last?.createdAt;
  if (!from) return null;
  return new Date(Date.parse(from) + minutes * 60 * 1000).toISOString();
}

/** 编号最高的通过/要修轮次。 */
export function lastFinal(rounds) {
  return [...(rounds || [])]
    .filter((round) => round.status === '通过' || round.status === '要修')
    .sort((a, b) => a.round - b.round)
    .at(-1) || null;
}

function childOpen(child) {
  return child.state !== 'closed' && child.state !== 'CLOSED';
}

/**
 * 最新裁决「通过」、issue 却还开着（不在 verdictOnlyIssues、不是 watch 档）：关单那一步没走完。
 * 重跑一轮把收尾（勾选、看板、关单）做完；同一份正文最多重跑一次，再不关就只留 passedButOpen 提醒给人。
 */
function passedButOpenRetry(task, f, profile) {
  if (f?.status !== '通过' || task.state !== 'open' || task.tier === 'watch') return null;
  if (isVerdictOnly(profile, task.ref)) return null;
  const passes = (task.rounds || []).filter((round) => round.status === '通过' && round.bodyVersion === f.bodyVersion);
  if (passes.length >= 2) return null;
  return { trigger: true, reason: 'passed-but-open' };
}

export function shouldTrigger(task, { now, profile }) {
  if (!task?.tier) return { trigger: false, reason: 'no-tier' };
  if (task.closedAt && Date.parse(task.closedAt) < Date.parse(profile.startAt)) {
    return { trigger: false, reason: 'closed-before-start' };
  }
  const latest = latestRound(task.rounds);
  if (latest?.status === '验收中') return { trigger: false, reason: 'in-progress' };
  const until = backoffUntil(task.rounds);
  if (until && now() < Date.parse(until)) return { trigger: false, reason: 'backoff' };

  const isParent = task.kind === 'parent' && (task.children || []).length >= 1;
  const f = lastFinal(task.rounds);

  if (isParent) {
    if ((task.children || []).some(childOpen)) return { trigger: false, reason: 'children-open' };
    if (!f) return { trigger: true, reason: 'no-verdict' };
    if (f.bodyVersion !== task.bodyVersion) return { trigger: true, reason: 'body-changed' };
    if ((task.children || []).some((child) => child.closedAt && f.finishedAt && Date.parse(child.closedAt) > Date.parse(f.finishedAt))) {
      return { trigger: true, reason: 'children-closed-after-verdict' };
    }
    return passedButOpenRetry(task, f, profile) || { trigger: false, reason: 'up-to-date' };
  }

  const merged = (task.linkedPrs || []).filter((pr) => pr.mergedAt);
  if (!merged.length) return { trigger: false, reason: 'no-merged-pr' };
  if (!f) return { trigger: true, reason: 'no-verdict' };
  if (merged.some((pr) => f.finishedAt && Date.parse(pr.mergedAt) > Date.parse(f.finishedAt))) {
    return { trigger: true, reason: 'pr-merged-after-verdict' };
  }
  if (f.bodyVersion !== task.bodyVersion) return { trigger: true, reason: 'body-changed' };
  return passedButOpenRetry(task, f, profile) || { trigger: false, reason: 'up-to-date' };
}

/**
 * 卡死判定（#47 SC11）：以宿主观察到的活动为准。
 * - `hostProgressAt`：宿主写在 <home>/state/host/progress 下的最近活动时间（pi 输出增长、本轮写闸请求），
 *   沙箱看不到也写不了那个目录。
 * - `lastProgressAt`：模型经 helper progress 写进 stateDir 缓存的时间。stateDir 对沙箱可写、能被伪造，
 *   **只作参考，不能把轮次往后延**：起算点取轮次评论的创建时间和宿主时间里较晚的那个。
 * 宿主时间晚于 now（不该发生）按 now 算，不让它把轮次延到未来。
 */
export function stalledRounds(task, { now, profile, hostProgressAt, lastProgressAt } = {}) {
  const latest = latestRound(task.rounds);
  if (!latest || latest.status !== '验收中') return null;
  const nowMs = now();
  let effective = null;
  for (const stamp of [latest.createdAt, hostProgressAt]) {
    const ms = Date.parse(stamp || '');
    if (!Number.isFinite(ms)) continue;
    const clamped = Math.min(ms, nowMs);
    if (effective === null || clamped > effective) effective = clamped;
  }
  if (effective === null) return null;
  const stallMs = (profile.stallMinutes ?? 30) * 60 * 1000;
  if (nowMs - effective <= stallMs) return null;
  return {
    issue: task.ref,
    round: latest.round,
    stale: true,
    lastProgressAt: new Date(effective).toISOString(),
    hostProgressAt: hostProgressAt || null,
    modelProgressAt: lastProgressAt || null,
    commentId: latest.commentId,
  };
}
