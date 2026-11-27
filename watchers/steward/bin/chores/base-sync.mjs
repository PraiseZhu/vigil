// Brings a ready PR up to date with its base before a review gate that refuses old branches. Each sync restarts CI
// and review, so it waits until the branch is this far behind, or its merge base this old, or GitHub reports BEHIND.
export const BASE_SYNC_DEFAULTS = { minBehind: 10, maxAgeHours: 48 };
const HOUR = 60 * 60 * 1000;
// A refused update (missing permission, another 422) is not asked again for the same head before this.
export const BASE_SYNC_FAILED_COOLDOWN_MS = HOUR;

function compile(sources) {
  if (!Array.isArray(sources)) return [];
  try { return sources.filter((source) => typeof source === 'string' && source).map((source) => new RegExp(source, 'i')); }
  catch { return []; }
}

export function syncSettings(raw) {
  if (raw?.enabled !== true) return null;
  return {
    bases: compile(raw.bases),
    minBehind: raw.minBehind ?? BASE_SYNC_DEFAULTS.minBehind,
    maxAgeHours: raw.maxAgeHours ?? BASE_SYNC_DEFAULTS.maxAgeHours,
  };
}

export function baseSyncKey(fact) {
  return `${fact.head}:${fact.base}`;
}

// Why the PR is not synced, judged from facts already read; null when GitHub has to be asked. `follow` is the local
// coverage record: while a repair is in progress or an order is not answered, a merge commit pushed under the
// follower would put its local branch behind. A follower that is only registered does not hold the sync.
function hold(fact, state, settings, follow, now) {
  if (fact.draft === true) return 'draft';
  if (fact.crossRepository === true) return 'cross_repository';
  if (!settings.bases.some((pattern) => pattern.test(fact.baseBranch ?? ''))) return 'base_not_listed';
  if (fact.conflict) return 'conflict';
  if (fact.mergeable !== 'MERGEABLE') return 'not_mergeable';
  if (fact.classification === '要修') return 'needs_repair';
  if (follow.coverageActive) return 'repair_in_progress';
  if (follow.pendingOrders) return 'pending_dispatch';
  // A repair is in progress while its CI runs, also after coverage was cleared. A required check that never
  // reported (missing) is not running: a review gate that refuses old branches never starts its check.
  if ((fact.checks ?? []).some((check) => check.result === 'running' && check.missing !== true)) return 'checks_running';
  const last = state.baseSync;
  if (last?.result === 'failed' && last.head === fact.head) {
    const since = now.getTime() - Date.parse(last.at);
    if (!(since >= BASE_SYNC_FAILED_COOLDOWN_MS)) return 'failed_cooldown';
    return null;
  }
  if (last?.key === baseSyncKey(fact)) return `already_${last.result}`;
  return null;
}

export function driftDue({ fact, drift, settings, now }) {
  if (fact.mergeState === 'BEHIND') return true;
  if (!(drift.behindBy > 0)) return false;
  return drift.behindBy >= settings.minBehind || now.getTime() - Date.parse(drift.mergeBaseAt) >= settings.maxAgeHours * HOUR;
}

export async function planBaseSync({ fact, state, settings, reader, now, follow = {} }) {
  const held = hold(fact, state, settings, follow, now);
  if (held) return { reason: held };
  let drift;
  try { drift = await reader.compareBase(fact.repo, fact.base, fact.head); } catch { return { reason: 'drift_unavailable' }; }
  if (!driftDue({ fact, drift, settings, now })) {
    return { reason: drift.behindBy === 0 ? 'up_to_date' : 'below_threshold', drift };
  }
  // update-branch pushes a merge commit onto the head branch, which a branch taking changes only by PR refuses.
  if (!fact.headBranch) return { reason: 'head_rules_unavailable', drift };
  try {
    const rules = await reader.listBranchRules(fact.repo, fact.headBranch);
    if (!Array.isArray(rules)) return { reason: 'head_rules_unavailable', drift };
    if (rules.some((rule) => rule?.type === 'pull_request')) return { reason: 'head_requires_pr', drift };
  } catch {
    return { reason: 'head_rules_unavailable', drift };
  }
  return { reason: 'eligible', drift };
}

export async function syncBase({ fact, plan, state, app, currentPull, dryRun, log, now }) {
  const key = baseSyncKey(fact);
  if (dryRun) {
    log(`${fact.pr}：将更新分支，同步 ${fact.baseBranch}（落后 ${plan.drift.behindBy} 个提交）`);
    return 'planned';
  }
  if (!(await currentPull())) {
    log(`${fact.pr}：当前提交已变化，不更新分支`);
    return 'held';
  }
  try {
    await app.updateBranch(fact.repo, fact.number, fact.head);
  } catch (error) {
    if (error?.code !== 'HEAD_CHANGED') {
      state.baseSync = { key, head: fact.head, result: 'failed', at: now.toISOString() };
      throw error;
    }
    state.baseSync = { key, head: fact.head, result: 'held' };
    log(`${fact.pr}：GitHub 回报 head 已变化，不更新分支，也不重试`);
    return 'held';
  }
  state.baseSync = { key, head: fact.head, result: 'synced' };
  return 'synced';
}
