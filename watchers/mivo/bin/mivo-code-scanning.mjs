import { createHash } from 'node:crypto';

const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const ALERT_RANK = { none: 0, errors: 1, errors_and_warnings: 2, all: 3 };
const SECURITY_RANK = { none: 0, critical: 1, high_or_higher: 2, medium_or_higher: 3, all: 4 };
const PR_REF = (number) => new RegExp(`^refs/pull/${Number(number)}/(head|merge)$`);

export function mergeCodeScanningRules(rules = []) {
  const byTool = new Map();
  for (const rule of rules) {
    if (!rule || typeof rule.tool !== 'string' || !rule.tool) continue;
    const alerts = ALERT_RANK[rule.alertsThreshold] == null ? null : rule.alertsThreshold;
    const security = SECURITY_RANK[rule.securityAlertsThreshold] == null ? null : rule.securityAlertsThreshold;
    const current = byTool.get(rule.tool) ?? { tool: rule.tool, alertsThreshold: 'none', securityAlertsThreshold: 'none', sources: [] };
    if (alerts && ALERT_RANK[alerts] > ALERT_RANK[current.alertsThreshold]) current.alertsThreshold = alerts;
    if (security && SECURITY_RANK[security] > SECURITY_RANK[current.securityAlertsThreshold]) current.securityAlertsThreshold = security;
    for (const source of rule.sources ?? (rule.source ? [rule.source] : [])) {
      if (!current.sources.includes(source)) current.sources.push(source);
    }
    byTool.set(rule.tool, current);
  }
  return [...byTool.values()].map((item) => ({ ...item, sources: [...item.sources].sort() }))
    .sort((a, b) => a.tool.localeCompare(b.tool));
}

function toolName(value) {
  if (typeof value === 'string') return value;
  return value?.name ?? value?.guid ?? '';
}

function analysisConfigKey(analysis) {
  return [toolName(analysis.tool), analysis.analysis_key ?? '', analysis.environment ?? '', analysis.category ?? ''].join('|');
}

function latestAnalyses(analyses = []) {
  const grouped = new Map();
  for (const analysis of analyses) {
    const key = analysisConfigKey(analysis);
    const time = Date.parse(analysis.created_at ?? analysis.committed_at ?? analysis.timestamp ?? 0);
    const current = grouped.get(key);
    if (!current || time > Date.parse(current.created_at ?? current.committed_at ?? current.timestamp ?? 0) || analysis.id > current.id) {
      grouped.set(key, analysis);
    }
  }
  return [...grouped.values()];
}

function ordinaryBlocks(severity, threshold) {
  const rank = ALERT_RANK[threshold] ?? 0;
  const level = String(severity ?? '').toLowerCase();
  if (rank <= ALERT_RANK.none) return false;
  if (rank >= ALERT_RANK.all) return ['error', 'warning', 'note'].includes(level);
  if (rank >= ALERT_RANK.errors_and_warnings) return level === 'error' || level === 'warning';
  return level === 'error';
}

function securityBlocks(level, threshold) {
  const rank = SECURITY_RANK[threshold] ?? 0;
  const value = String(level ?? '').toLowerCase();
  if (rank <= SECURITY_RANK.none) return false;
  if (rank >= SECURITY_RANK.all) return ['low', 'medium', 'high', 'critical'].includes(value);
  if (rank >= SECURITY_RANK.medium_or_higher) return ['medium', 'high', 'critical'].includes(value);
  if (rank >= SECURITY_RANK.high_or_higher) return value === 'high' || value === 'critical';
  return value === 'critical';
}

function matchingInstance(alert, instances, { number, headSha, mergeCommitSha, analyses }) {
  const candidates = (instances ?? []).length ? instances : [alert.most_recent_instance].filter(Boolean);
  const refs = PR_REF(number);
  return candidates.find((instance) => {
    if (!instance || instance.state !== 'open') return false;
    const ref = String(instance.ref ?? alert.ref ?? '');
    if (!refs.test(ref)) return false;
    const commit = instance.commit_sha ?? instance.commit?.sha ?? alert.commit_sha;
    if (commit === headSha) return true;
    if (mergeCommitSha && commit === mergeCommitSha) {
      return analyses.some((analysis) => analysis.commit_sha === mergeCommitSha || analysis.commit_sha === headSha);
    }
    return false;
  }) ?? null;
}

function mergeCommitProven(commits, { headSha, baseSha, mergeCommitSha }) {
  if (!mergeCommitSha || !sha(mergeCommitSha)) return false;
  const commit = commits?.[mergeCommitSha] ?? commits?.find?.((item) => item.sha === mergeCommitSha);
  const parents = (commit?.parents ?? []).map((item) => item.sha ?? item);
  // GitHub re-creates refs/pull/N/merge against the moving base, so the base parent need not equal
  // the PR's recorded base; a two-parent merge of the current head is what binds it.
  return parents.length >= 2 && parents.includes(headSha);
}

export function evaluateCodeScanning({
  pr, policy, analyses = [], alerts = [], instances = {}, commits = {}, mergeCommitSha = null,
} = {}) {
  const headSha = pr?.headRefOid ?? policy?.headSha;
  const tools = mergeCodeScanningRules(policy?.codeScanningRules ?? []);
  const policyHash = policy?.policyHash ?? digest({ tools, headSha });
  const checkedAt = new Date().toISOString();
  const base = { headSha, policyHash, tools, blockingAlerts: [], scanHash: digest({ tools, headSha }), checkedAt };
  if (!tools.length) return { ...base, status: 'not-required', reason: 'code-scanning-not-required' };
  if (!sha(headSha) || policy?.status !== 'verified' || policy.headSha !== headSha) {
    return { ...base, status: 'unknown', reason: 'unverified-policy-or-head' };
  }
  if (!Array.isArray(analyses) || !Array.isArray(alerts)) {
    return { ...base, status: 'unknown', reason: 'incomplete-code-scanning-pages' };
  }
  const applicable = latestAnalyses(analyses).filter((analysis) => tools.some((tool) => tool.tool === toolName(analysis.tool)));
  if (!applicable.length) return { ...base, status: 'unknown', reason: 'code-scanning-analysis-missing' };
  if (applicable.some((analysis) => analysis.error || analysis.environment === 'error')) {
    return { ...base, status: 'unknown', reason: 'code-scanning-analysis-error' };
  }
  const pending = applicable.some((analysis) => ['pending', 'queued', 'in_progress'].includes(String(analysis.status ?? '').toLowerCase()));
  if (pending) return { ...base, status: 'pending', reason: 'code-scanning-pending' };
  const refs = PR_REF(pr.number);
  const bound = applicable.filter((analysis) => {
    const ref = String(analysis.ref ?? '');
    if (!refs.test(ref)) return false;
    if (analysis.commit_sha === headSha) return true;
    return mergeCommitSha && analysis.commit_sha === mergeCommitSha && mergeCommitProven(commits, {
      headSha, baseSha: pr.baseRefOid ?? policy.baseSha, mergeCommitSha,
    });
  });
  if (!bound.length) return { ...base, status: 'unknown', reason: 'code-scanning-head-unbound' };
  const blocking = [];
  for (const alert of alerts) {
    if (!alert || alert.state !== 'open') continue;
    const tool = toolName(alert.tool);
    const rule = tools.find((item) => item.tool === tool);
    if (!rule) continue;
    const alertInstances = instances[alert.number] ?? instances[String(alert.number)] ?? [];
    const instance = matchingInstance(alert, alertInstances, {
      number: pr.number, headSha, mergeCommitSha, analyses: bound,
    });
    if (!instance) continue;
    const security = alert.rule?.security_severity_level ?? instance.rule?.security_severity_level ?? null;
    const severity = alert.rule?.severity ?? instance.rule?.severity ?? alert.severity ?? null;
    const blocks = security
      ? securityBlocks(security, rule.securityAlertsThreshold)
      : ordinaryBlocks(severity, rule.alertsThreshold);
    if (!blocks) continue;
    const location = instance.location ?? alert.most_recent_instance?.location ?? {};
    blocking.push({
      alertNumber: alert.number,
      tool,
      ruleId: alert.rule?.id ?? instance.rule?.id ?? null,
      ref: instance.ref ?? alert.ref ?? null,
      analysisId: bound.find((analysis) => analysisConfigKey(analysis).startsWith(tool))?.id ?? null,
      analysisCommitSha: instance.commit_sha ?? alert.commit_sha ?? null,
      analysisKey: bound.find((analysis) => toolName(analysis.tool) === tool)?.analysis_key ?? null,
      category: bound.find((analysis) => toolName(analysis.tool) === tool)?.category ?? null,
      severity,
      securitySeverity: security,
      blockingThreshold: security ? rule.securityAlertsThreshold : rule.alertsThreshold,
      location: { path: location.path ?? null, startLine: location.start_line ?? location.startLine ?? null },
      htmlUrl: alert.html_url ?? instance.html_url ?? null,
      message: alert.rule?.description ?? instance.message?.text ?? alert.message ?? '',
    });
  }
  const scanHash = digest({
    tools, headSha, analyses: bound.map((item) => ({ id: item.id, commit: item.commit_sha, key: analysisConfigKey(item) })),
    alerts: blocking,
  });
  if (blocking.length) {
    return { ...base, status: 'failed', reason: 'code-scanning-failed', blockingAlerts: blocking, scanHash };
  }
  return { ...base, status: 'green', reason: 'code-scanning-clean', scanHash };
}

function slurp(raw, label) {
  const value = parse(raw);
  if (!Array.isArray(value)) throw new Error(`incomplete ${label}`);
  if (value.every(Array.isArray)) return value.flat();
  if (value.every((item) => item && typeof item === 'object')) return value;
  throw new Error(`incomplete ${label}`);
}

export function* collectCodeScanningSteps({ pr, policy, ghFn, mergeCommitSha = null, commits = {} }) {
  const tools = mergeCodeScanningRules(policy?.codeScanningRules ?? []);
  if (!tools.length) {
    return evaluateCodeScanning({ pr, policy, analyses: [], alerts: [] });
  }
  try {
    const analyses = slurp(yield () => ghFn([
      'api', `repos/${pr.repo}/code-scanning/analyses?pr=${pr.number}&per_page=100`, '--paginate', '--slurp',
    ]), 'code-scanning analyses');
    const alerts = slurp(yield () => ghFn([
      'api', `repos/${pr.repo}/code-scanning/alerts?pr=${pr.number}&per_page=100&state=open`, '--paginate', '--slurp',
    ]), 'code-scanning alerts');
    // Default CodeQL analyses refs/pull/N/merge; bind the newest merge commit whose parents include the head.
    if (!mergeCommitSha) {
      const mergeRef = new RegExp(`^refs/pull/${Number(pr.number)}/merge$`);
      const candidates = [...new Set(analyses.filter((analysis) => mergeRef.test(String(analysis?.ref ?? ''))
        && sha(analysis.commit_sha) && analysis.commit_sha !== pr.headRefOid).map((analysis) => analysis.commit_sha))];
      commits = { ...commits };
      for (const candidate of candidates) {
        const commit = parse(yield () => ghFn(['api', `repos/${pr.repo}/commits/${candidate}`]));
        commits[candidate] = { parents: (commit?.parents ?? []).map((item) => item?.sha ?? item) };
        if (commits[candidate].parents.includes(pr.headRefOid)) { mergeCommitSha = candidate; break; }
      }
    }
    const instances = {};
    for (const alert of alerts) {
      if (!alert?.number) continue;
      instances[alert.number] = slurp(yield () => ghFn([
        'api', `repos/${pr.repo}/code-scanning/alerts/${alert.number}/instances?pr=${pr.number}&per_page=100`,
        '--paginate', '--slurp',
      ]), `code-scanning alert ${alert.number} instances`);
    }
    return evaluateCodeScanning({ pr, policy, analyses, alerts, instances, commits, mergeCommitSha });
  } catch (error) {
    const status = /403|404|API rate|permission/i.test(String(error.message)) ? 'unknown' : 'unknown';
    return {
      status,
      headSha: pr.headRefOid,
      policyHash: policy?.policyHash ?? null,
      tools,
      blockingAlerts: [],
      scanHash: digest({ error: String(error.message).slice(0, 200) }),
      checkedAt: new Date().toISOString(),
      reason: error.status === 403 || /403/.test(String(error.message)) ? 'code-scanning-permission-missing' : error.message,
    };
  }
}

export function codeScanningFeedbackItems({ pr, scanning }) {
  if (!scanning || scanning.status !== 'failed' || !Array.isArray(scanning.blockingAlerts)) return [];
  return scanning.blockingAlerts.map((alert) => {
    const location = alert.location ?? {};
    const body = [
      `${alert.tool} ${alert.ruleId ?? ''} ${alert.message ?? ''}`.trim(),
      location.path ? `${location.path}:${location.startLine ?? ''}`.replace(/:$/, '') : '',
      alert.htmlUrl ?? '',
    ].filter(Boolean).join('\n');
    const revision = digest({
      alert: alert.alertNumber, rule: alert.ruleId, location, message: alert.message,
      threshold: alert.blockingThreshold, head: pr.headRefOid,
    });
    return {
      source: 'code-scanning',
      nativeId: `alert:${alert.alertNumber}`,
      sha: pr.headRefOid,
      revision,
      contentHash: revision,
      body,
      codeScanningFailure: {
        verified: true,
        status: 'failed',
        headSha: pr.headRefOid,
        alertNumber: alert.alertNumber,
        tool: alert.tool,
        ruleId: alert.ruleId,
        ref: alert.ref,
        analysisId: alert.analysisId,
        analysisCommitSha: alert.analysisCommitSha,
        analysisKey: alert.analysisKey,
        category: alert.category,
        policyHash: scanning.policyHash,
        severity: alert.severity,
        securitySeverity: alert.securitySeverity,
        blockingThreshold: alert.blockingThreshold,
        location,
      },
    };
  });
}
