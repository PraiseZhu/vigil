#!/usr/bin/env node
// 触发与退避：纯函数，now 由调用方注入。
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
    return { trigger: false, reason: 'up-to-date' };
  }

  const merged = (task.linkedPrs || []).filter((pr) => pr.mergedAt);
  if (!merged.length) return { trigger: false, reason: 'no-merged-pr' };
  if (!f) return { trigger: true, reason: 'no-verdict' };
  if (merged.some((pr) => f.finishedAt && Date.parse(pr.mergedAt) > Date.parse(f.finishedAt))) {
    return { trigger: true, reason: 'pr-merged-after-verdict' };
  }
  if (f.bodyVersion !== task.bodyVersion) return { trigger: true, reason: 'body-changed' };
  return { trigger: false, reason: 'up-to-date' };
}

export function stalledRounds(task, { now, profile, lastProgressAt }) {
  const latest = latestRound(task.rounds);
  if (!latest || latest.status !== '验收中') return null;
  const progressAt = lastProgressAt || latest.createdAt;
  if (!progressAt) return null;
  const stallMs = (profile.stallMinutes ?? 30) * 60 * 1000;
  if (now() - Date.parse(progressAt) <= stallMs) return null;
  return {
    issue: task.ref,
    round: latest.round,
    stale: true,
    lastProgressAt: progressAt,
    commentId: latest.commentId,
  };
}
