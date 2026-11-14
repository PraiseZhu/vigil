// 敏感部署的授予记录校验。不是密码学信任根：只把可检查的绑定做成失败关闭。
// 本轮唯一可信用户来源是父级可核实的 t710u + t711u，范围仅「独立验收通过后部署」。
const FULL_SHA = /^[0-9a-f]{40}$/;

export const GRANT_SCHEMA = 'vigil-deploy-grant/v1';
export const JASPER_DECISION = 'allow-deploy-after-independent-verification';
export const REQUIRED_VERIFIER = 'Grok4.7 xhigh';
export const FLEET_ROUND_DELEGATION = Object.freeze({
  ids: Object.freeze(['t710u', 't711u']),
  round: '2026-11-14-fleet-standard',
  scope: 'deploy-after-independent-verification',
  verifiableBy: 'parent-transcript',
  maxTtlMs: 14 * 24 * 60 * 60 * 1000,
});

function fail(code, reason, snapshot = null) {
  return { ok: false, code, reason, snapshot };
}

function ok(snapshot) {
  return { ok: true, code: 'ok', reason: '', snapshot };
}

function isFullSha(value) {
  return typeof value === 'string' && FULL_SHA.test(value);
}

function sameShaList(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((sha, index) => sha === right[index]);
}

function sameIdSet(got, expected) {
  if (!Array.isArray(got) || got.length !== expected.length) return false;
  const a = [...got].map(String).sort();
  const b = [...expected].map(String).sort();
  return a.every((id, index) => id === b[index]);
}

function snapshotOf(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  return {
    schema: record.schema ?? null,
    targetSha: record.targetSha ?? null,
    baseSha: record.baseSha ?? null,
    commits: Array.isArray(record.commits) ? [...record.commits] : null,
    ruleVersion: record.ruleVersion ?? null,
    grantSource: record.grantSource ?? null,
    jasperVerdict: record.jasperVerdict ?? null,
    independentVerification: record.independentVerification ?? null,
    expiresAt: record.expiresAt ?? null,
  };
}

function evidenceOk(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
  const commands = evidence.commands;
  if (!Array.isArray(commands) || commands.length === 0) return false;
  for (const row of commands) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (typeof row.cmd !== 'string' || !row.cmd.trim()) return false;
    if (row.exitCode !== 0) return false;
  }
  return true;
}

function kindOf(record) {
  return record.grantSource?.kind || record.kind || record.source?.kind || null;
}

/**
 * 校验一份授予记录是否允许把 HEAD=baseSha 快进到 targetSha。
 * ctx: { targetSha, baseSha, commits, ruleVersion, nowMs }
 */
export function evaluateGrant(record, ctx = {}) {
  const snap = () => snapshotOf(record);
  if (record == null) return fail('missing-record', '缺授予记录：敏感快进不能只靠本地 SHA 文件或命令行针脚');

  if (typeof record === 'string') {
    const text = record.trim();
    if (isFullSha(text)) return fail('sha-only', '完整 SHA 文本不是授予记录，旧批准文件不能单独放行');
    if (/^approved$/i.test(text)) return fail('self-approved-text', '自写 approved 文本不是授予记录');
    return fail('invalid-schema', '授予记录必须是对象');
  }

  if (typeof record !== 'object' || Array.isArray(record)) {
    return fail('invalid-schema', '授予记录必须是对象');
  }

  const kind = kindOf(record);
  if (kind === 'bot-comment' || record.authorType === 'Bot' || record.user?.type === 'Bot') {
    return fail('bot-comment', 'bot 评论不能当作授予', snap());
  }
  if (kind === 'github-comment' || kind === 'github-user' || (record.schema !== GRANT_SCHEMA && record.login && record.type === 'User')) {
    return fail('github-user-login-only', 'GitHub 登录名加 User 类型不能单独证明人亲自批准', snap());
  }
  if (kind === 'legacy-sha-file' || kind === 'bootstrap' || record.provesLegacy === true) {
    return fail('bootstrap-self-proof', '新机制不能自行证明旧门禁批准', snap());
  }
  if (record.approved === true && record.schema !== GRANT_SCHEMA) {
    return fail('self-approved-text', '自写 approved 不是授予记录', snap());
  }
  if (record.schema !== GRANT_SCHEMA) {
    return fail('invalid-schema', `schema 必须是 ${GRANT_SCHEMA}`, snap());
  }

  const source = record.grantSource;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return fail('untrusted-source', '缺 grantSource', snap());
  }
  if (source.kind !== 'user-delegation') {
    return fail('untrusted-source', 'grantSource.kind 必须是 user-delegation', snap());
  }
  if (source.round !== FLEET_ROUND_DELEGATION.round || source.verifiableBy !== FLEET_ROUND_DELEGATION.verifiableBy) {
    return fail('untrusted-source', '授予来源不是本轮父级可核实的用户委托', snap());
  }
  if (!sameIdSet(source.ids, FLEET_ROUND_DELEGATION.ids)) {
    const extra = Array.isArray(source.ids) && source.ids.some((id) => !FLEET_ROUND_DELEGATION.ids.includes(id));
    return fail(extra ? 'scope-exceeded' : 'untrusted-source', extra
      ? '授予来源超出本轮 t710u+t711u'
      : '授予来源必须同时包含 t710u 和 t711u', snap());
  }
  if (source.scope !== FLEET_ROUND_DELEGATION.scope) {
    return fail('scope-exceeded', '授予范围必须是 deploy-after-independent-verification', snap());
  }
  if (record.allowsFuture === true || record.unbounded === true || source.unbounded === true) {
    return fail('scope-exceeded', '不能把本轮委托扩成未来全部敏感操作', snap());
  }

  if (!isFullSha(record.targetSha) || !isFullSha(record.baseSha)) {
    return fail('short-sha', 'targetSha 和 baseSha 必须是完整 40 位小写十六进制', snap());
  }
  if (!Array.isArray(record.commits) || record.commits.length === 0 || record.commits.some((sha) => !isFullSha(sha))) {
    return fail('short-sha', 'commits 必须是非空的完整 SHA 列表', snap());
  }
  if (!Array.isArray(ctx.commits) || ctx.commits.length === 0) {
    return fail('commits-mismatch', '实际提交区间为空或读不出', snap());
  }
  if (record.targetSha !== ctx.targetSha) {
    return fail(record.targetSha.length === 40 && ctx.targetSha && record.targetSha !== ctx.targetSha ? 'target-mismatch' : 'target-mismatch',
      '授予记录的目标 SHA 与 origin/main 不一致', snap());
  }
  if (record.baseSha !== ctx.baseSha) {
    return fail('base-mismatch', '授予记录的 base SHA 与当前 HEAD 不一致', snap());
  }
  if (!sameShaList(record.commits, ctx.commits)) {
    return fail('commits-mismatch', '授予记录的提交区间与 git rev-list --reverse HEAD..target 不一致', snap());
  }
  if (typeof ctx.ruleVersion !== 'string' || !ctx.ruleVersion || record.ruleVersion !== ctx.ruleVersion) {
    return fail('rule-version-mismatch', '敏感规则版本与当前脚本不一致', snap());
  }

  const verdict = record.jasperVerdict;
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict)) {
    return fail('jasper-mismatch', '缺 Jasper 对精确 SHA 的裁决', snap());
  }
  if (verdict.targetSha !== record.targetSha || verdict.decision !== JASPER_DECISION) {
    return fail('jasper-mismatch', 'Jasper 裁决必须点名本枚完整 SHA 且决定为独立验收通过后部署', snap());
  }
  const decidedAtMs = Date.parse(verdict.decidedAt);
  if (!Number.isFinite(decidedAtMs)) {
    return fail('jasper-mismatch', 'Jasper 裁决时间无效', snap());
  }

  const verification = record.independentVerification;
  if (!verification || typeof verification !== 'object' || Array.isArray(verification)) {
    return fail('missing-independent-verification', '缺独立验收证据', snap());
  }
  if (verification.verifier !== REQUIRED_VERIFIER) {
    return fail('missing-independent-verification', `独验人必须是 ${REQUIRED_VERIFIER}`, snap());
  }
  if (verification.fast !== false) {
    return fail('verification-fast', '独验 Fast 必须为 false', snap());
  }
  if (verification.result !== 'pass') {
    return fail('verification-not-pass', '独验结果必须是 pass', snap());
  }
  if (verification.headSha !== record.targetSha) {
    return fail('target-mismatch', '独验 headSha 必须等于目标完整 SHA', snap());
  }
  if (!evidenceOk(verification.evidence)) {
    return fail('empty-evidence', '独验证据必须有非空命令且退出码为 0', snap());
  }

  const nowMs = Number(ctx.nowMs);
  if (!Number.isFinite(nowMs)) return fail('expired', '缺少当前时间，不能判断是否过期', snap());
  const expiresAtMs = Date.parse(record.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return fail('expired', '缺过期时间', snap());
  if (nowMs >= expiresAtMs) return fail('expired', '授予记录已过期', snap());
  if (expiresAtMs - decidedAtMs > FLEET_ROUND_DELEGATION.maxTtlMs) {
    return fail('ttl-exceeded', '授予有效期超过 14 天，视为把委托扩成无限期', snap());
  }
  if (decidedAtMs - nowMs > 5 * 60 * 1000) {
    return fail('jasper-mismatch', 'Jasper 裁决时间在未来', snap());
  }

  return ok(snapshotOf(record));
}
