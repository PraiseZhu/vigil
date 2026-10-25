// 写闸动作：重跑一次失败 job（#60 SC6，偶发失败只重跑一次）。
// 只给 auto / fork 档；watch 档由写闸回 4 tier-not-allowed。
export const type = 'ci.rerun';
export const tiers = Object.freeze(['auto', 'fork']);

export function check(action, { tier } = {}) {
  if (!tiers.includes(tier)) return { ok: false, reason: 'tier-not-allowed' };
  if (!action || typeof action.repo !== 'string' || !action.repo) {
    return { ok: false, reason: 'bad-action' };
  }
  if (!Number.isInteger(Number(action.pr)) || Number(action.pr) <= 0) {
    return { ok: false, reason: 'bad-action' };
  }
  if (!Number.isInteger(Number(action.runId)) || Number(action.runId) <= 0) {
    return { ok: false, reason: 'bad-action' };
  }
  return { ok: true };
}

export function toWrite(action) {
  return {
    type,
    repo: action.repo,
    pr: Number(action.pr),
    runId: Number(action.runId),
  };
}
