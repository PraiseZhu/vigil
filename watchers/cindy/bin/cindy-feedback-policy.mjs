// Local repair authority. Comment bodies are evidence, never standing permission.
// Code-fix is only confirmed P0/P1. Comment P2/P3 are reply-only; the watcher
// replies with the grading note and resolves, without opening a repair session.
export const FEEDBACK_POLICY_VERSION = 1;
const INFRA = new Set(['INCOMPLETE', 'CI-NOT-GREEN', 'SKIP-LLM', 'SKIP-LOCAL', 'REFUSE', 'WINDOW-CLOSED', 'PARSE-FAILED', 'HELPERS-MISSING', 'UNHEALTHY']);
const aliases = { P0: 'P0', CRITICAL: 'P0', P1: 'P1', HIGH: 'P1', P2: 'P2', MEDIUM: 'P2', P3: 'P3', LOW: 'P3' };
const TOKEN = '(P[0-3]|CRITICAL|HIGH|MEDIUM|LOW)';
const severityHeading = new RegExp('^(?:#{1,6}\\s+)?(?:[-*+]\\s+|\\d+[.)]\\s+)?(?:🤖 自动 Review\\s*·\\s*)?(?:\\*\\*|\\[)?' + TOKEN + '(?:\\*\\*|\\])?(?=\\s|:|：|[-—–]|$)(.*)$', 'i');
const verdictHeading = /^## 🤖 自动 Review 结论[：:]\s*(\S+)\s*$/m;
const AUTHORIZED = new Set(['P0', 'P1']);

export function isBotActor(author) {
  if (author == null) return false;
  if (typeof author === 'string') return author.endsWith('[bot]');
  if (author.__typename === 'Bot' || author.type === 'Bot') return true;
  return typeof author.login === 'string' && author.login.endsWith('[bot]');
}
export function normalizeActorLogin(author) {
  if (author == null) return null;
  if (typeof author === 'string') return author;
  const login = author.login;
  if (typeof login !== 'string' || !login) return null;
  if (isBotActor(author) && !login.endsWith('[bot]')) return `${login}[bot]`;
  return login;
}

export function isGreptileAuthor(author) {
  if (!isBotActor(author)) return false;
  const login = normalizeActorLogin(author);
  return login === 'greptile-apps' || login === 'greptile-apps[bot]';
}
function trustedReviewer(item) {
  const author = item.user ?? item.author;
  if (!isBotActor(author)) return false;
  const login = normalizeActorLogin(author);
  return isGreptileAuthor(author) || login === 'github-actions' || login === 'github-actions[bot]';
}
// Review threads block the merge until resolved (required_review_thread_resolution), whoever wrote them. A thread
// from a maintainer (owner, member, collaborator), the PR author, or a known code-review app goes to the repair
// session for grading: its body grants nothing, only a confirmed must-fix finding changes code, anything else is
// answered with the session's evidence and resolved. Other people's threads still only get a triage note.
const MEMBER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const REVIEW_APPS = new Set(['chatgpt-codex-connector[bot]', 'coderabbitai[bot]', 'copilot-pull-request-reviewer[bot]']);
export function isTriageThread(item) {
  if (typeof item?.threadId !== 'string' || !item.threadId) return false;
  const author = item.user ?? item.author;
  if (isBotActor(author)) return REVIEW_APPS.has(normalizeActorLogin(author));
  const login = typeof author === 'string' ? author : author?.login;
  return typeof login === 'string' && login.length > 0
    && (item.fromPrAuthor === true || MEMBER_ASSOCIATIONS.has(String(item.authorAssociation ?? '').toUpperCase()));
}
const isGreptileSummary = (body) => /<!--\s*greptile_summary\s*-->/i.test(body);
function visibleLines(body) {
  const lines = body.replace(/<!--[^]*?-->/g, '').split(/\r?\n|\\n/);
  let fence = null;
  let agentPrompt = false;
  return lines.flatMap((line) => {
    const trimmed = line.trim();
    if (agentPrompt) { if (/<\/details>/i.test(trimmed)) agentPrompt = false; return []; }
    const marker = /^(?:`{3,}|~{3,})/.exec(trimmed)?.[0];
    if (marker) { if (!fence) fence = marker[0]; else if (marker[0] === fence) fence = null; return []; }
    if (fence || /^>/.test(trimmed)) return [];
    if (/prompt for (?:ai|coding)|ai (?:agent|coding).*prompt|修复提示词|prompt to fix with ai/i.test(trimmed)) { agentPrompt = true; return []; }
    return [trimmed];
  });
}
const result = (action, severities, reason) => ({
  policyVersion: FEEDBACK_POLICY_VERSION, action,
  canChangeCode: ['code-fix', 'required-ci-fix', 'conflict-fix'].includes(action), severities, reason,
});

function stripBadge(line) {
  return line
    .replace(/^(?:#{1,6}\s+)?(?:(?:[-*+]|\d+[.)])\s+)?(?:<a\b[^>]*>\s*)?<img\b[^>]*\balt=["'](P[0-3])(?: Badge)?["'][^>]*>\s*(?:<\/a>)?\s*(?:&nbsp;)?\s*/i, '$1: ')
    .replace(/^(#{1,6}\s*)?!\[(P[0-3])(?: Badge)?\]\([^)]*\)\s*/i, '$1$2: ')
    .replace(/^(#{1,6}\s*)?\*\*\[(P[0-3]|CRITICAL|HIGH|MEDIUM|LOW)\]\*\*/i, '$1$2:')
    .replace(/^(?:severity|priority|严重度|优先级)\s*[:：]\s*/i, '');
}

// Greptile's overview restates findings that arrive as their own graded inline threads. Unless it carries a
// must-fix finding of its own, it only opened a session with no authority (2026-10-15 #6120).
export function feedbackRepairPolicy(item = {}, options = {}) {
  const policy = itemRepairPolicy(item, options);
  if (!['code-fix', 'ignore-infra'].includes(policy.action) && trustedReviewer(item) && isGreptileSummary(String(item.body ?? ''))) {
    return result('ignore-infra', policy.severities, 'greptile-summary-inline-threads');
  }
  return policy;
}

function itemRepairPolicy(item = {}, { headSha } = {}) {
  if (!item || typeof item !== 'object') return result('needs-triage', [], 'invalid-feedback');
  if (item.actionable === false) return result('ignore-infra', [], 'non-actionable-or-resolved');
  // An unresolved review thread in the current snapshot stays live across later pushes: its
  // comment SHA is provenance (the commit it was written against), not a freshness bound.
  const liveThread = typeof item.threadId === 'string' && item.threadId.length > 0;
  if (headSha && item.sha && item.sha !== headSha && item.isOutdated !== true && !liveThread) return result('needs-triage', [], 'stale-head');
  if (item.source === 'ci' || item.source === 'conflict') {
    if (!headSha || item.sha !== headSha) return result('needs-triage', [], 'unbound-head');
    if (item.source === 'conflict') return result('conflict-fix', [], 'current-merge-conflict');
    const proof = item.requiredFailure;
    if (proof && (proof.verified !== true || proof.status !== 'failed' || proof.headSha !== headSha)) {
      return result('needs-triage', [], 'invalid-required-ci-evidence');
    }
    return result('required-ci-fix', [], proof ? 'verified-required-ci-failure' : 'legacy-required-ci-failure');
  }
  if (!trustedReviewer(item)) {
    if (isTriageThread(item)) return result('code-fix', [], 'review-thread-triage');
    // A status or summary comment from any other app (e.g. "Codex Review Summary: Failed") is not a review
    // finding and does not block the merge; it used to open a session with no authority (2026-10-15 #6120).
    if (isBotActor(item.user ?? item.author) && !item.threadId) return result('ignore-infra', [], 'untrusted-app-comment');
    return result('needs-triage', [], 'unverified-review-source');
  }
  const body = String(item.body ?? '');
  if (body.length > 256 * 1024) return result('needs-triage', [], 'feedback-too-large');
  const lines = visibleLines(body);
  const heading = verdictHeading.exec(lines.join('\n'))?.[1]?.toUpperCase();
  if (INFRA.has(heading)) return result('ignore-infra', [], 'review-infrastructure');
  const substantive = lines.filter((line) => line && !verdictHeading.test(line)
    && !/^(?:(?:cindy|mivo)-code-review depth=\S+ head_sha=[a-f0-9]{40}|review-complete head_sha=[a-f0-9]{40} base_sha=[a-f0-9]{40})$/.test(line));
  if (!substantive.length) return result('ignore-infra', [], 'review-marker-only');
  const severities = [];
  let summaryHigh = false;
  for (const line of substantive) {
    if (/三席聚合|(?:findings?|severity)\s*(?:counts?|summary)|汇总|统计/i.test(line)) {
      if (/(?:P[012]|CRITICAL|HIGH|MEDIUM)\s*[:：]?\s*[1-9]\d*/i.test(line)) summaryHigh = true;
      continue;
    }
    const findingLine = stripBadge(line);
    const match = severityHeading.exec(findingLine);
    if (!match) continue;
    const remainder = match[2].replace(/^[:：\s—–-]+/, '');
    if (/^(?:\d+(?:\s|$)|none\b|zero\b|no\b|无|没有|零)/i.test(remainder)) continue;
    if (/^\s*[:：]?\s*0\s*(?:findings?|issues?|项|个)?\s*$/i.test(remainder)) continue;
    const severity = aliases[match[1].toUpperCase()];
    if (!severities.includes(severity)) severities.push(severity);
  }
  const authorized = severities.some((s) => AUTHORIZED.has(s));
  const p3 = severities.includes('P3');
  if (authorized && heading === 'APPROVE') return result('needs-triage', severities, 'approve-conflicts-with-high-finding');
  const mixedOnSameLine = substantive.some((line) => {
    if (/三席聚合|(?:findings?|severity)\s*(?:counts?|summary)|汇总|统计/i.test(line)) return false;
    const tokens = line.match(/P[0-3]|CRITICAL|HIGH|MEDIUM|LOW/gi) ?? [];
    if (tokens.length < 2) return false;
    const mapped = tokens.map((t) => aliases[t.toUpperCase()]);
    return mapped.some((s) => AUTHORIZED.has(s)) && mapped.some((s) => s === 'P2' || s === 'P3');
  });
  if (mixedOnSameLine) return result('needs-triage', severities, 'mixed-severity-inseparable');
  if (authorized && p3) return result('code-fix', severities, 'mixed-severity-authorized-p3-no-change');
  if (summaryHigh && !authorized) return result('needs-triage', severities, 'high-summary-without-finding');
  if (authorized) return result('code-fix', severities, 'explicit-p0-p1-finding');
  if (p3 || severities.includes('P2')) return result('reply-only', severities, 'p2-p3-no-code-authority');
  // A Greptile overview scored 5/5 with no severity finding is a clean bill, not
  // a finding; its inline findings arrive as separate, graded items.
  if (/<!--\s*greptile_summary\s*-->/i.test(body) && /Confidence Score:\s*5\s*\/\s*5/i.test(body)) {
    return result('ignore-infra', [], 'greptile-summary-clean');
  }
  return result('needs-triage', [], 'severity-unconfirmed');
}

export function taskRepairPolicy(task = {}) {
  const feedback = Array.isArray(task.feedback) ? task.feedback : [];
  const items = feedback.map((item, index) => ({
    key: item?.key ?? `${item?.source ?? 'unknown'}:${item?.nativeId ?? index}`,
    ...(/^[a-f0-9]{40}$/.test(task.headRefOid ?? '')
      ? feedbackRepairPolicy(item, { headSha: task.headRefOid })
      : result('needs-triage', [], 'task-head-unbound')),
  }));
  return {
    policyVersion: FEEDBACK_POLICY_VERSION,
    canChangeCode: items.some((item) => item.canChangeCode),
    items,
    allowedFeedbackKeys: items.filter((item) => item.canChangeCode).map((item) => item.key),
  };
}
