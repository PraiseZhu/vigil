import { ACTIONS_APP_ID } from './chores/ci-rerun.mjs';
import { actorKey, scopeReasons } from './discover.mjs';

const SHA = /^[a-f0-9]{40}$/i;
const RUNNING = new Set(['EXPECTED', 'IN_PROGRESS', 'PENDING', 'QUEUED', 'REQUESTED', 'WAITING']);
const FAILED = new Set(['ACTION_REQUIRED', 'CANCELLED', 'ERROR', 'FAILURE', 'STALE', 'STARTUP_FAILURE', 'TIMED_OUT']);
const LEVELS = ['low', 'medium', 'high', 'critical'];
const OTHER_SEVERITIES = { note: 'low', warning: 'medium', error: 'high' };
const OPTIONAL_FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE']);

function requireFact(condition, message) {
  if (!condition) throw new Error(message);
}

function complete(connection, name) {
  requireFact(Array.isArray(connection?.nodes) && connection.pageInfo?.hasNextPage === false
    && connection.totalCount === connection.nodes.length && connection.nodes.every(Boolean),
  `${name}: missing or truncated`);
  return connection.nodes;
}

function normalizeCheck(check, policy) {
  const isRun = check.__typename === 'CheckRun';
  requireFact(isRun || check.__typename === 'StatusContext', 'unknown check type');
  const name = isRun ? check.name : check.context;
  const conclusion = isRun ? (check.status === 'COMPLETED' ? check.conclusion : check.status) : check.state;
  const result = RUNNING.has(conclusion) ? 'running'
    : FAILED.has(conclusion) ? 'failed'
      : conclusion === 'SKIPPED' ? 'skipped'
        : ['SUCCESS', 'NEUTRAL'].includes(conclusion) ? 'passed' : null;
  requireFact(typeof name === 'string' && name && result && typeof check.isRequired === 'boolean',
    'check result or requirement unknown');
  const description = [check.title, check.summary, check.text, check.description].filter(Boolean).join('\n');
  // Download and server errors of some jobs (a code scanning bundle download) are written only in annotations.
  const annotations = isRun && result === 'failed' && check.annotations !== undefined
    ? complete(check.annotations, 'check annotations').filter((item) => item.annotationLevel === 'FAILURE')
      .map((item) => String(item.message ?? '')) : [];
  const infraPatterns = policy.infraPatterns ?? [];
  const matches = (text) => infraPatterns.some((pattern) => pattern.test(text));
  const infra = result === 'failed' && (policy.infraRequiresAllAnnotations === true && annotations.length
    ? annotations.every(matches) : matches([description, ...annotations].join('\n')));
  return {
    name, result, conclusion, required: check.isRequired, infra,
    id: check.databaseId ?? null,
    appId: check.checkSuite?.app?.databaseId ?? null,
    url: check.detailsUrl ?? check.targetUrl ?? null,
    startedAt: isRun ? check.startedAt ?? null : null,
    description,
  };
}

// The latest attempt of each optional GitHub Actions check that ended red, unless its name is ignored by policy.
export function failedOptionalChecks(checks, policy) {
  const ignore = policy.optionalChecks?.ignorePatterns ?? [];
  const time = (check) => Date.parse(check.startedAt ?? '');
  const latest = new Map();
  checks.forEach((check, index) => {
    if (check.required || check.appId !== ACTIONS_APP_ID || ignore.some((pattern) => pattern.test(check.name))) return;
    const key = JSON.stringify([check.name, check.appId]);
    const current = latest.get(key);
    const newer = !current || (Number.isFinite(time(check)) && Number.isFinite(time(current.check))
      ? time(check) >= time(current.check) : index > current.index);
    if (newer) latest.set(key, { check, index });
  });
  return [...latest.values()].map(({ check }) => check)
    .filter((check) => check.result === 'failed' && OPTIONAL_FAILED.has(check.conclusion));
}

function missingRequired(checks, classicContexts, rules) {
  requireFact(Array.isArray(classicContexts) && Array.isArray(rules), 'required check policy unknown');
  const requirements = classicContexts.map((name) => ({ name, appId: null }));
  for (const rule of rules) {
    requireFact(typeof rule?.type === 'string', 'invalid branch rule');
    if (rule.type !== 'required_status_checks') continue;
    const entries = rule.parameters?.required_status_checks;
    requireFact(Array.isArray(entries), 'invalid required checks rule');
    for (const entry of entries) requirements.push({ name: entry.context, appId: entry.integration_id ?? null });
  }
  const distinct = new Map();
  for (const item of requirements) {
    requireFact(typeof item.name === 'string' && item.name, 'invalid required check name');
    distinct.set(JSON.stringify([item.name, item.appId]), item);
  }
  return [...distinct.values()].filter(({ name, appId }) => !checks.some((check) => check.required
    && check.name === name && (appId === null || check.appId === appId))).map(({ name, appId }) => ({
    name, appId, result: 'running', conclusion: 'EXPECTED', required: true, infra: false, id: null, url: null,
    description: '', missing: true,
  }));
}

function normalizeThread(thread, policy) {
  requireFact(typeof thread.id === 'string' && typeof thread.isOutdated === 'boolean', 'invalid review thread');
  const comments = complete(thread.comments, 'review comments');
  const root = comments[0];
  const key = actorKey(root?.author);
  requireFact(key && typeof root.body === 'string', 'review thread author or body unknown');
  const trusted = key.startsWith('app/') && (policy.trustedReviewers ?? []).some((login) =>
    login.toLowerCase().replace(/^app\//, '').replace(/\[bot\]$/, '') === key.slice(4));
  const severity = trusted ? ['P0', 'P1', 'P2', 'P3'].find((level) =>
    (policy.severityPatterns?.[level] ?? []).some((pattern) => pattern.test(root.body))) ?? 'ungraded' : null;
  return {
    id: thread.id, outdated: thread.isOutdated, path: thread.path, line: thread.line,
    source: trusted ? 'trusted_bot' : key.startsWith('app/') ? 'other_bot' : 'human',
    severity, comments,
  };
}

async function currentAlerts(client, pr, head, threshold) {
  const alerts = await client.listAlerts(pr.repo, pr.number);
  requireFact(Array.isArray(alerts), 'code scanning alerts incomplete');
  const bindings = new Map();
  const result = [];
  for (const alert of alerts) {
    requireFact(Number.isSafeInteger(alert?.number) && typeof alert.state === 'string', 'invalid code scanning alert');
    if (alert.state !== 'open') continue;
    const severity = alert.rule?.security_severity_level ?? OTHER_SEVERITIES[alert.rule?.severity];
    requireFact(LEVELS.includes(severity), 'code scanning severity unknown');
    if (LEVELS.indexOf(severity) < LEVELS.indexOf(threshold)) continue;
    const instances = await client.listAlertInstances(pr.repo, pr.number, alert.number);
    requireFact(Array.isArray(instances) && instances.length, 'code scanning alert instances unavailable');
    for (const instance of instances) {
      requireFact(typeof instance?.state === 'string' && typeof instance.ref === 'string', 'invalid code scanning instance');
      if (instance.state !== 'open') continue;
      const headRef = `refs/pull/${pr.number}/head`;
      const mergeRef = `refs/pull/${pr.number}/merge`;
      if (![headRef, mergeRef].includes(instance.ref)) continue;
      const commit = instance.commit_sha;
      requireFact(SHA.test(commit), 'code scanning commit unknown');
      if (commit !== head && instance.ref === mergeRef && !bindings.has(commit)) {
        const parents = await client.alertCommitParents(pr.repo, commit);
        requireFact(Array.isArray(parents) && parents.length === 2 && parents.every((parent) => SHA.test(parent?.sha)),
          'code scanning merge parents unknown');
        bindings.set(commit, parents[1].sha === head);
      }
      if (commit !== head && !(instance.ref === mergeRef && bindings.get(commit))) continue;
      result.push({ number: alert.number, severity, url: alert.html_url ?? null, commit });
      break;
    }
  }
  return result;
}

export function classify({ ignored = [], checks = [], threads = [], conflict, alerts = [], awaitingHuman, mergeState,
  requiresConversationResolution, optionalFailed = [], syncBase = false }) {
  const requiredChecks = checks.filter((check) => check.required);
  const failedRequired = requiredChecks.filter((check) => check.result === 'failed');
  const skipped = requiredChecks.filter((check) => check.result === 'skipped');
  const failed = checks.filter((check) => check.result === 'failed');
  const falseGreen = skipped.length && failed.length ? { skipped, failed } : null;
  const reasons = [];
  for (const check of failedRequired.filter((item) => !item.infra)) reasons.push({ code: 'required_check_failed', name: check.name });
  for (const check of optionalFailed.filter((item) => !item.infra)) reasons.push({ code: 'optional_check_failed', name: check.name });
  if (falseGreen) reasons.push({ code: 'false_green', checks: skipped.map((check) => check.name) });
  for (const thread of threads) {
    if (thread.source === 'human' || (thread.source === 'trusted_bot' && thread.severity !== 'P3')) {
      reasons.push({ code: 'review_thread', id: thread.id, source: thread.source, severity: thread.severity });
    }
  }
  if (conflict) reasons.push({ code: 'merge_conflict' });
  for (const alert of alerts) reasons.push({ code: 'code_scanning_alert', number: alert.number, severity: alert.severity });
  if (ignored.length) return { classification: '不管', reasons: ignored.map((code) => ({ code })) };
  if (reasons.length) return { classification: '要修', reasons, falseGreen, requiredChecks };
  const waiting = [
    ...requiredChecks.filter((check) => check.result === 'running').map((check) => ({ code: 'required_check_running', name: check.name })),
    ...failedRequired.map((check) => ({ code: 'infra', name: check.name })),
    ...optionalFailed.map((check) => ({ code: 'infra', name: check.name })),
  ];
  if (waiting.length) return { classification: '等待中', reasons: waiting, falseGreen, requiredChecks };
  if (awaitingHuman) return { classification: '等人', reasons: [{ code: 'manual_approval_or_merge' }], falseGreen, requiredChecks };
  const onlyNonblockingThreads = mergeState === 'BLOCKED' && requiresConversationResolution
    && threads.length > 0 && threads.every((thread) =>
      thread.source === 'other_bot' || (thread.source === 'trusted_bot' && thread.severity === 'P3'));
  // GitHub requires this branch to be brought up to date: the base sync chore does it when enabled, else the follower.
  if (mergeState === 'BEHIND') {
    return { classification: syncBase ? '等待中' : '要修', reasons: [{ code: 'behind_base' }], falseGreen, requiredChecks };
  }
  if (!onlyNonblockingThreads && ['BLOCKED', 'UNKNOWN'].includes(mergeState)) {
    throw new Error(`merge status not explained: ${mergeState}`);
  }
  return { classification: '没事', reasons: [], falseGreen, requiredChecks };
}

export function unknown(pr, error) {
  return { pr: pr.pr, repo: pr.repo, number: pr.number, source: pr.source, classification: '未知',
    reasons: [{ code: 'read_failed', detail: error.message }] };
}

export async function readFacts(client, profile, pr, branchRules = new Map()) {
  const identity = { pr: pr.pr, repo: pr.repo, number: pr.number, source: pr.source };
  try {
    if (pr.ignored.length) return { ...identity, ...classify({ ignored: pr.ignored }) };
    const pull = await client.getPull(pr.repo, pr.number);
    requireFact(pull?.number === pr.number && ['OPEN', 'CLOSED', 'MERGED'].includes(pull.state)
      && typeof pull.isDraft === 'boolean', 'pull request unavailable');
    const ignored = scopeReasons({ ...identity, state: pull.state.toLowerCase(), draft: pull.isDraft, author: pull.author }, profile);
    if (ignored.length) return { ...identity, ...classify({ ignored }) };
    const head = pull.headRefOid;
    requireFact(SHA.test(head) && SHA.test(pull.baseRefOid) && pull.baseRefName, 'pull request head or base unknown');
    const commit = pull.commits?.nodes?.[0]?.commit;
    requireFact(commit?.oid === head && Object.hasOwn(commit, 'statusCheckRollup'), 'check rollup does not belong to current head');
    const policy = profile.policies[pr.repo.toLowerCase()] ?? {};
    const checks = (commit.statusCheckRollup === null ? [] : complete(commit.statusCheckRollup.contexts, 'check rollup'))
      .map((check) => normalizeCheck(check, policy));
    requireFact(pull.baseRef && Object.hasOwn(pull.baseRef, 'refUpdateRule'), 'base branch policy unavailable');
    const classic = pull.baseRef.refUpdateRule === null ? [] : pull.baseRef.refUpdateRule.requiredStatusCheckContexts;
    const branch = JSON.stringify([pr.repo.toLowerCase(), pull.baseRefName]);
    if (!branchRules.has(branch)) branchRules.set(branch, client.listBranchRules(pr.repo, pull.baseRefName));
    const rules = await branchRules.get(branch);
    checks.push(...missingRequired(checks, classic, rules));
    const requiresConversationResolution = pull.baseRef.refUpdateRule?.requiresConversationResolution === true
      || rules.some((rule) => rule.type === 'pull_request' && rule.parameters?.required_review_thread_resolution === true);
    const threads = complete(pull.reviewThreads, 'review threads').filter((thread) => {
      requireFact(typeof thread.isResolved === 'boolean', 'review thread resolution unknown');
      return !thread.isResolved;
    }).map((thread) => normalizeThread(thread, policy));
    const alerts = policy.codeScanning?.enabled
      ? await currentAlerts(client, pr, head, policy.codeScanning.threshold) : [];
    const mergeState = pull.mergeStateStatus;
    requireFact(['BEHIND', 'BLOCKED', 'CLEAN', 'DIRTY', 'HAS_HOOKS', 'UNKNOWN', 'UNSTABLE'].includes(mergeState)
      && ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'].includes(pull.mergeable), 'merge status unavailable');
    const conflict = pull.mergeable === 'CONFLICTING' || mergeState === 'DIRTY';
    const awaitingHuman = ['REVIEW_REQUIRED', 'CHANGES_REQUESTED'].includes(pull.reviewDecision)
      || (['CLEAN', 'HAS_HOOKS'].includes(mergeState) && !pull.autoMergeRequest && !pull.isInMergeQueue && threads.length === 0);
    const optionalFailed = policy.optionalChecks?.block === true ? failedOptionalChecks(checks, policy) : [];
    return {
      ...identity, head, base: pull.baseRefOid, baseBranch: pull.baseRefName,
      headBranch: pull.headRefName ?? null, crossRepository: pull.isCrossRepository === true, mergeable: pull.mergeable,
      checks, threads, conflict, alerts, mergeState, author: pull.author,
      ...classify({ checks, threads, conflict, alerts, awaitingHuman, requiresConversationResolution, optionalFailed,
        syncBase: policy.chores?.syncBase?.enabled === true,
        mergeState: pull.mergeable === 'UNKNOWN' ? 'UNKNOWN' : mergeState }),
    };
  } catch (error) {
    return unknown(pr, error);
  }
}
