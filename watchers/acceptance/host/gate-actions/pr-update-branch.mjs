// 写闸动作：把 PR 分支更新到最新 main（#60 SC6）。
// 只给 auto / fork 档；watch 档由写闸回 4 tier-not-allowed。
export const type = 'pr.update-branch';
export const tiers = Object.freeze(['auto', 'fork']);

const SHA = /^[0-9a-f]{40,64}$/;

export function check(action, { tier } = {}) {
  if (!tiers.includes(tier)) return { ok: false, reason: 'tier-not-allowed' };
  if (!action || typeof action.repo !== 'string' || !action.repo) {
    return { ok: false, reason: 'bad-action' };
  }
  if (!Number.isInteger(Number(action.pr)) || Number(action.pr) <= 0) {
    return { ok: false, reason: 'bad-action' };
  }
  const head = action.expectedHeadSha || action.headSha;
  if (typeof head !== 'string' || !SHA.test(head)) {
    return { ok: false, reason: 'bad-action' };
  }
  return { ok: true };
}

export function toWrite(action) {
  return {
    type,
    repo: action.repo,
    pr: Number(action.pr),
    expectedHeadSha: action.expectedHeadSha || action.headSha,
  };
}
