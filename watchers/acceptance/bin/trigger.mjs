#!/usr/bin/env node
// 触发与退避：纯函数，now 由调用方注入。
import { parseMarker } from './collect.mjs';
import { isVerdictOnly } from './profile.mjs';
import { latestRound } from './rounds.mjs';

export const BACKOFF_MINUTES = Object.freeze([0, 5, 15, 60]);
/**
 * 环境问题（依赖装不上等，host/round.mjs 用这个前缀写「中断」原因）：不是代码问题，马上重试多半还是失败，
 * 白占槽位、在 issue 上刷「验收中 → 中断」。所以最近一次中断是环境问题时退避更长：30 分钟 → 2 小时 → 6 小时封顶。
 */
export const ENV_PROBLEM_PREFIX = '环境问题（不是代码不通过）：';
export const ENV_BACKOFF_MINUTES = Object.freeze([30, 120, 360]);

export function isEnvProblem(round) {
  return typeof round?.reason === 'string' && round.reason.startsWith(ENV_PROBLEM_PREFIX);
}

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
  const last = [...rounds].filter((round) => round.status === '中断').sort((a, b) => a.round - b.round).at(-1);
  const minutes = isEnvProblem(last)
    ? ENV_BACKOFF_MINUTES[Math.min(k, ENV_BACKOFF_MINUTES.length) - 1]
    : k === 1 ? BACKOFF_MINUTES[0] : k === 2 ? BACKOFF_MINUTES[1] : k === 3 ? BACKOFF_MINUTES[2] : BACKOFF_MINUTES[3];
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

/**
 * 最近一次裁决里有「有争议」（#46 SC8）：`task.dispute` 由 tasks.mjs 从那条轮次评论算出。
 * 没有裁决结果就等（宿主起只读裁决运行），有了就触发下一轮，按裁决定这些条目。
 */
function disputeOf(task, f) {
  const dispute = task?.dispute;
  if (!dispute || !f || dispute.round !== f.round || !(dispute.items || []).length) return null;
  return dispute;
}

/** 批准执行推进的任务，lead 交接之前最多等这么久（从子 issue 全关 / PR 合并算起），之后照常验（#140）。 */
export const LEAD_HANDOFF_WAIT_HOURS = 24;

function latestMs(stamps) {
  const ms = stamps.map((stamp) => Date.parse(stamp || '')).filter(Number.isFinite);
  return ms.length ? Math.max(...ms) : null;
}

/**
 * 总 issue 上有 ownerLogin 发的「批准执行登记」、还没有晚于最后一条登记的 lead 交接：先等 lead 验收总 issue、发交接。
 * 等满 LEAD_HANDOFF_WAIT_HOURS 照常验；已经出过晚于最后一条登记的裁决（等满后验过的那一轮）就不再等。
 */
function awaitingLeadHandoff(task, f, nowMs, readyAt) {
  const registered = Date.parse(task.leadHandoff?.registeredAt || '');
  if (!Number.isFinite(registered)) return false;
  if (Date.parse(task.leadHandoff.handoffAt || '') >= registered) return false;
  if (Date.parse(f?.finishedAt || '') >= registered) return false;
  if (readyAt === null) return false;
  return nowMs - readyAt < LEAD_HANDOFF_WAIT_HOURS * 60 * 60 * 1000;
}

/**
 * PR 的 GitHub mergedAt 是否严格晚于最后一次裁决轮次评论的 GitHub createdAt。
 * 不读正文「完成：」（那是验收机本机时钟）。解析不出的时间不算晚于；
 * 有一条能解析且严格更晚就是 after，否则只要有解析不出的时间就是 unknown。
 */
function prMergedVersusVerdict(merged, createdAt) {
  const createdMs = Date.parse(createdAt || '');
  if (!Number.isFinite(createdMs)) return 'unknown';
  let unknown = false;
  for (const pr of merged) {
    const mergedMs = Date.parse(pr.mergedAt || '');
    if (!Number.isFinite(mergedMs)) {
      unknown = true;
      continue;
    }
    if (mergedMs > createdMs) return 'after';
  }
  return unknown ? 'unknown' : 'not-after';
}

function issueClosed(state) {
  return state === 'closed' || state === 'CLOSED';
}

/**
 * PR 的合并目标分支相对仓库默认分支：'default'（合到默认分支）/ 'other'（合到别的分支）/ 'unknown'（字段没取到）。
 * 纯函数，只看传进来的字段。
 */
export function baseClassOf(pr, defaultBranch) {
  const base = typeof pr?.base === 'string' ? pr.base.trim() : '';
  if (!base) return 'unknown';
  return base === (defaultBranch || 'main') ? 'default' : 'other';
}

function prLabel(pr) {
  return pr.base ? `${pr.ref}（base ${pr.base}）` : `${pr.ref}（目标分支未知）`;
}

/**
 * 已合并 PR 的合并目标判定（#379 加、#380 定为长期口径）：只看「有没有合入默认分支的 PR」。
 * 不按 PR 的目标分支检出代码验（取舍见 docs/acceptance-pr-base-branch.md）；久等不到默认分支的，
 * 由 host/base-pending.mjs 超过 3 天进每日汇总。
 * - 至少一条合入默认分支 → 按默认分支验（其余不拦：工作已经进默认分支了）；
 * - 一条都没有、但有已知的非默认分支 → 跳过（base-not-default）；
 * - 一条都没有、目标分支又全取不到 → 也跳过（base-unknown）：宁可不验，也不拿错分支的代码开「要修」。
 */
export function mergedBaseDecision(merged, defaultBranch = 'main') {
  const rows = (merged || []).map((pr) => ({ pr, kind: baseClassOf(pr, defaultBranch) }));
  if (!rows.length) return { ok: true };
  if (rows.some((row) => row.kind === 'default')) return { ok: true };
  const known = rows.filter((row) => row.kind === 'other').map((row) => row.pr);
  const unknown = rows.filter((row) => row.kind === 'unknown').map((row) => row.pr);
  const prs = [...known, ...unknown].map((pr) => ({ ref: pr.ref, base: pr.base || null }));
  if (!known.length) {
    return {
      ok: false,
      reason: 'base-unknown',
      base: null,
      defaultBranch,
      prs,
      message: `合并的 PR ${unknown.map(prLabel).join('、')} 没取到目标分支，不知道是不是默认分支 ${defaultBranch}；验收机先不验（下一拍再查）。`,
    };
  }
  return {
    ok: false,
    reason: 'base-not-default',
    base: [...new Set(known.map((pr) => pr.base))].join('、'),
    defaultBranch,
    prs,
    message: `PR ${[...known, ...unknown].map(prLabel).join('、')} 合入的不是默认分支 ${defaultBranch}；验收机只按默认分支验代码，等它合入 ${defaultBranch} 后再验。`,
  };
}

/** 把合并目标判定包成 shouldTrigger 的返回形状（人话说明一起带出去）。 */
function blockedByBase(decision) {
  return {
    trigger: false,
    reason: decision.reason,
    base: decision.base ?? null,
    defaultBranch: decision.defaultBranch,
    prs: decision.prs,
    message: decision.message,
  };
}

/**
 * 父单用：任一子单的已合并 PR 全都不在它自己仓的默认分支上（或者全取不到目标分支）就不验——
 * 子单的工作还在集成分支上，按默认分支验必然误判。
 * 盘点里没有这个子单的 PR 数据（`prBase` 为 null）时不拦：拦了会把老父单永久卡住，比漏一次更糟。
 */
function parentBaseBlock(task) {
  for (const child of task.children || []) {
    const info = child?.prBase;
    if (!info || !Array.isArray(info.mergedPrs) || !info.mergedPrs.length) continue;
    const decision = mergedBaseDecision(info.mergedPrs, info.defaultBranch || task.defaultBranch);
    if (!decision.ok) return { ...blockedByBase(decision), child: child.ref };
  }
  return null;
}

/**
 * 已关闭且 PR 已合并的子 issue（kind=child）。
 * 未关闭、修正标记、没有已合并 PR、父轮次进行中、父结论晚于子 issue 关闭，都不开轮。
 * 其余和独立 issue 同一套：没结论开一轮（reason 用 child-merged），结论后又合并了 PR 再开一轮。
 */
function childDecision(task, { now, profile, f, dispute }) {
  if (!issueClosed(task.state)) return { trigger: false, reason: 'child-open' };
  if (parseMarker(task.body) != null) return { trigger: false, reason: 'correction-issue' };
  const merged = (task.linkedPrs || []).filter((pr) => pr.mergedAt);
  if (!merged.length) return { trigger: false, reason: 'no-merged-pr' };
  const baseDecision = mergedBaseDecision(merged, task.defaultBranch);
  if (!baseDecision.ok) return blockedByBase(baseDecision);
  if (task.parentLatestStatus === '验收中') return { trigger: false, reason: 'parent-in-progress' };
  const coveredAt = Date.parse(task.parentFinalFinishedAt || '');
  const closedAt = Date.parse(task.closedAt || '');
  if (Number.isFinite(coveredAt) && Number.isFinite(closedAt) && coveredAt > closedAt) {
    return { trigger: false, reason: 'parent-covered' };
  }
  if (awaitingLeadHandoff(task, f, now(), latestMs(merged.map((pr) => pr.mergedAt)))) {
    return { trigger: false, reason: 'awaiting-lead-handoff' };
  }
  if (!f) return { trigger: true, reason: 'child-merged' };
  if (dispute) return { trigger: true, reason: 'adjudicated' };
  const mergedVersusVerdict = prMergedVersusVerdict(merged, f.createdAt);
  if (mergedVersusVerdict === 'after') return { trigger: true, reason: 'pr-merged-after-verdict' };
  if (f.bodyVersion !== task.bodyVersion) return { trigger: true, reason: 'body-changed' };
  const openRetry = passedButOpenRetry(task, f, profile);
  if (openRetry) return openRetry;
  if (mergedVersusVerdict === 'unknown') return { trigger: false, reason: 'merged-after-verdict-unknown' };
  return { trigger: false, reason: 'up-to-date' };
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
  const dispute = disputeOf(task, f);
  if (dispute && !dispute.adjudication) return { trigger: false, reason: 'awaiting-adjudication', dispute };

  if (task.kind === 'child') return childDecision(task, { now, profile, f, dispute });

  // 重验任务（#363）带的是父 issue 的轮次：父还在验，子不能另开一轮。parent / standalone 都拦。
  if (task.parentLatestStatus === '验收中') return { trigger: false, reason: 'parent-in-progress' };

  // 没挂到任务下的修正子 issue（#402）：和挂着的子 issue 一样，开着就等，验收结论之后关闭就开下一轮。
  const unmounted = task.unmountedCorrections || [];
  const closedAfterVerdict = (child) => child.closedAt && f?.finishedAt && Date.parse(child.closedAt) > Date.parse(f.finishedAt);
  if (unmounted.some(childOpen)) return { trigger: false, reason: 'children-open' };

  if (isParent) {
    if ((task.children || []).some(childOpen)) return { trigger: false, reason: 'children-open' };
    const ownMerged = (task.linkedPrs || []).filter((pr) => pr.mergedAt);
    if (ownMerged.length) {
      const ownBase = mergedBaseDecision(ownMerged, task.defaultBranch);
      if (!ownBase.ok) return blockedByBase(ownBase);
    }
    const baseBlock = parentBaseBlock(task);
    if (baseBlock) return baseBlock;
    if (awaitingLeadHandoff(task, f, now(), latestMs((task.children || []).map((child) => child.closedAt)))) {
      return { trigger: false, reason: 'awaiting-lead-handoff' };
    }
    if (!f) return { trigger: true, reason: 'no-verdict' };
    if (dispute) return { trigger: true, reason: 'adjudicated' };
    if (f.bodyVersion !== task.bodyVersion) return { trigger: true, reason: 'body-changed' };
    if ([...(task.children || []), ...unmounted].some(closedAfterVerdict)) {
      return { trigger: true, reason: 'children-closed-after-verdict' };
    }
    return passedButOpenRetry(task, f, profile) || { trigger: false, reason: 'up-to-date' };
  }

  const merged = (task.linkedPrs || []).filter((pr) => pr.mergedAt);
  if (!merged.length) return { trigger: false, reason: 'no-merged-pr' };
  const baseDecision = mergedBaseDecision(merged, task.defaultBranch);
  if (!baseDecision.ok) return blockedByBase(baseDecision);
  if (awaitingLeadHandoff(task, f, now(), latestMs(merged.map((pr) => pr.mergedAt)))) {
    return { trigger: false, reason: 'awaiting-lead-handoff' };
  }
  if (!f) return { trigger: true, reason: 'no-verdict' };
  if (dispute) return { trigger: true, reason: 'adjudicated' };
  const mergedVersusVerdict = prMergedVersusVerdict(merged, f.createdAt);
  if (mergedVersusVerdict === 'after') return { trigger: true, reason: 'pr-merged-after-verdict' };
  if (f.bodyVersion !== task.bodyVersion) return { trigger: true, reason: 'body-changed' };
  if (unmounted.some(closedAfterVerdict)) return { trigger: true, reason: 'children-closed-after-verdict' };
  const openRetry = passedButOpenRetry(task, f, profile);
  if (openRetry) return openRetry;
  if (mergedVersusVerdict === 'unknown') return { trigger: false, reason: 'merged-after-verdict-unknown' };
  return { trigger: false, reason: 'up-to-date' };
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
