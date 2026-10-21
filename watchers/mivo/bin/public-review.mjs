// Consume-only: do not invoke or mutate the production review publisher contract.
// Returning already-collected `ci` is pass-through of this collector's own CI snapshot.
//
// Review signals (review-pr flow: a pre-review coordinator dispatches the `review-pr.yml` workflow):
// - the reviewer account submits the report as a PR review: APPROVE for other authors, or COMMENT
//   carrying `<!-- mivo-review:report head=<sha> -->` when the author is the reviewer account itself;
//   findings come as a review with `<!-- review-pr:findings head=<sha> ... -->` plus inline threads;
// - every round writes a `review-pr` check run (GitHub Actions) on the PR head; the latest one is the
//   current verdict for that head.
import { collectPrSnapshot } from './mivo-pr-snapshot.mjs';
import { collectMivoCiSteps } from './mivo-ci.mjs';
import { requireConfig } from './profile.mjs';

// 目标仓库与审查账号在 import 时从 profile/env 求值；缺失时 fail-closed（不回退到任何个人默认值）。
const REPO = requireConfig('targetRepo', {
  envVar: 'MIVO_WATCHER_TARGET_REPO',
  hint: '示例："your-org/your-repo"。',
});
export const REVIEWER = requireConfig('reviewerLogin', {
  envVar: 'MIVO_WATCHER_REVIEWER_LOGIN',
  hint: '审查流程提交 review 的 GitHub 账号，示例："ExampleUser"。',
});
export const REVIEW_CHECK = 'review-pr';
const REVIEW_WORKFLOW = '.github/workflows/review-pr.yml';
const ACTIONS_APP_ID = 15368;
// Review infrastructure checks belong to the review maintainer, never a business repair owner.
const REVIEW_INFRA_CHECKS = [REVIEW_CHECK, 'gate', 'seat1', 'seat2', 'seat3', 'publish', 'native_attestation', 'control_attestation'];
const parse = v => typeof v === 'string' ? JSON.parse(v) : v;
const at = c => Date.parse(c.created_at ?? c.createdAt);
const HEADER = /^> Mivo 自动审查 · .*?head `([a-f0-9]{12})` · base `([a-f0-9]{12})`/m;

/** A review submitted by the reviewer account, parsed; null for anything else. */
export function reviewerReport(review) {
  if (review?.author?.login !== REVIEWER) return null;
  const body = String(review.body ?? '');
  const header = HEADER.exec(body);
  const findings = /<!-- review-pr:findings head=([a-f0-9]{40})\b/.exec(body)?.[1] ?? null;
  const reported = [...body.matchAll(/<!-- mivo-review:report head=([a-f0-9]{40}) -->/g)].map(m => m[1]);
  const overall = /^## Overall\s*\n+\s*(pass|changes-requested)\b/m.exec(body)?.[1] ?? null;
  return { id: review.id, state: review.state, commit: review.commit?.oid ?? null, at: Date.parse(review.submittedAt),
    headShort: header?.[1] ?? null, baseShort: header?.[2] ?? null, findings, reported, overall, report: Boolean(header) };
}

/** Clean report for exactly this head/base: an APPROVE, or a COMMENT sealed with the report marker. */
function cleanReportFor(report, head, base) {
  return report.report && report.commit === head && report.headShort === head.slice(0, 12) && report.baseShort === base.slice(0, 12)
    && report.overall === 'pass' && !report.findings
    && (report.state === 'APPROVED' || (report.state === 'COMMENTED' && report.reported.length === 1 && report.reported[0] === head));
}

/** Node ids of reviewer reviews that carry findings for the given head (their inline threads are findings). */
export function reviewerFindingReviewIds(reviews = [], head) {
  return new Set(reviews.map(reviewerReport).filter(r => r && r.findings && (!head || r.findings === head)).map(r => r.id));
}

/** True when the review is the reviewer's own clean report: a verdict, not feedback. */
export function isReviewerCleanReport(review) {
  const report = reviewerReport(review);
  return Boolean(report && report.report && report.overall === 'pass' && !report.findings);
}

const reviewChecks = (checks = [], head) => checks.filter(c => c?.name === REVIEW_CHECK && c.app?.id === ACTIONS_APP_ID && c.head_sha === head)
  .sort((a, b) => Date.parse(b.started_at ?? b.created_at) - Date.parse(a.started_at ?? a.created_at) || b.id - a.id);
// GitHub rewrites details_url of API-created Actions checks to the check page; only external_id survives.
// review-pr.yml writes its own run URL there, so the producing run is read from external_id and must be in REPO.
const RUN_PATH_RE = new RegExp(`^/${REPO.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/actions/runs/(\\d+)/?$`);
function runIdOf(check) {
  try {
    const url = new URL(check.external_id);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password) return null;
    return RUN_PATH_RE.exec(url.pathname)?.[1] ?? null;
  } catch { return null; }
}

function handledComment(comment, handledFeedback, head) {
  const records = Array.isArray(handledFeedback) ? handledFeedback : Object.values(handledFeedback ?? {});
  const id = String(comment.id ?? comment.node_id ?? '');
  const keys = [`comment:${id}`, `review:${id}`];
  const body = comment.body ?? '';
  const updated = comment.updatedAt ?? comment.updated_at ?? comment.createdAt ?? comment.created_at;
  return records.some((record) => {
    if (!record || record.resultHead !== head) return false;
    if (record.replyCommentId && String(record.replyCommentId) === id) return true;
    if (!keys.includes(record.key) && record.nativeId !== id) return false;
    if (record.contentHash && comment.contentHash) return record.contentHash === comment.contentHash;
    return record.body == null || record.body === body;
  });
}

export function evaluatePublicReview({ snapshot: s, comments = s.comments, checks = [], runs = {}, handledFeedback = [] }) {
  const blockers = [];
  const no = (reason, extra = {}) => ({ ready: false, reason, blockers: blockers.length ? blockers : [reason], baseUpdateEligible: false, ...extra });
  if (s.pr.state !== 'OPEN' || s.pr.isDraft || !s.pr.sameRepository) return no('inactive');
  const head = s.pr.headRefOid, base = s.pr.baseRefOid;
  const latestCheck = reviewChecks(checks, head)[0];
  let run = null;
  let current = null;
  let reports = [];
  if (!latestCheck) blockers.push('waiting-review');
  else {
    run = runs[runIdOf(latestCheck)];
    const producerOk = run && run.path === REVIEW_WORKFLOW && run.event === 'workflow_dispatch' && run.repository?.full_name === REPO;
    if (latestCheck.status !== 'completed') blockers.push('review-in-progress');
    else if (!producerOk) blockers.push('producer-unverified');
    else if (latestCheck.conclusion !== 'success') blockers.push(`review-${String(latestCheck.conclusion ?? 'unknown').toLowerCase()}`);
    reports = (s.reviews ?? []).map(reviewerReport).filter(Boolean).filter(r => r.commit === head).sort((a, b) => b.at - a.at);
    current = reports.find(r => cleanReportFor(r, head, base));
    if (latestCheck.status === 'completed' && producerOk && latestCheck.conclusion === 'success') {
      if (!current) blockers.push(reports.some(r => r.findings) ? 'review-findings' : 'review-report-missing');
      else if (reports.some(r => r.findings && r.at > current.at)) blockers.push('review-findings');
      const epoch = /(\d{4}-\d\d-\d\dT[^:]+:\d\d:[^:]+)$/.exec(s.pr.releaseEpoch ?? '')?.[1];
      if (current && (!epoch || current.at < Date.parse(epoch))) blockers.push('review-before-release');
    } else if (producerOk && reports.some(r => r.findings)) {
      if (!blockers.includes('review-findings') && latestCheck.conclusion !== 'success') {
        /* keep the check conclusion as the primary blocker; findings remain in evidence */
      }
    }
  }
  const scanning = s.ci?.codeScanning ?? s.codeScanning;
  if (!s.requiredChecksGreen) blockers.push(s.ci?.status === 'failed' || scanning?.status === 'failed' ? 'waiting-ci' : 'waiting-ci');
  if (scanning && !['green', 'not-required'].includes(scanning.status) && s.requiredChecksGreen) {
    blockers.push(scanning.status === 'failed' ? 'code-scanning-failed' : scanning.status === 'pending' ? 'code-scanning-pending' : 'code-scanning-unknown');
  }
  if (s.mergeable !== 'MERGEABLE') blockers.push('merge-conflict-or-unknown');
  const mergeState = String(s.mergeStateStatus ?? s.pr.mergeStateStatus ?? 'UNKNOWN').toUpperCase();
  if (mergeState === 'BEHIND') blockers.push('behind');
  else if (mergeState === 'BLOCKED') blockers.push('blocked');
  else if (mergeState === 'DIRTY') blockers.push('dirty');
  else if (mergeState === 'DRAFT') blockers.push('draft');
  else if (mergeState === 'UNSTABLE') {
    if (!s.requiredChecksGreen) blockers.push('unstable');
  } else if (mergeState !== 'CLEAN') blockers.push('merge-state-unknown');
  if ((s.threads ?? []).some(t => !t.isResolved)) blockers.push('unresolved-threads');
  const latest = new Map();
  for (const r of s.reviews ?? []) {
    const key = r.author?.login;
    if (!key) { blockers.push('review-author-unknown'); break; }
    if (!latest.has(key) || Date.parse(r.submittedAt) > Date.parse(latest.get(key).submittedAt)) latest.set(key, r);
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED' || [...latest.values()].some(r => r.state === 'CHANGES_REQUESTED')) blockers.push('review-veto');
  if ((s.labels ?? []).includes('awaiting-discussion')) blockers.push('discussion-hold');
  if (current && comments.some(c => at(c) > current.at && c.user?.login !== s.pr.author.login && c.body?.trim() && !handledComment(c, handledFeedback, head))) {
    blockers.push('new-feedback');
  }
  const evidence = {
    reviewId: current?.id ?? reports.find(r => r.findings)?.id ?? null,
    checkRunId: latestCheck?.id ?? null,
    runId: run?.id ?? null,
    head, base,
    findingIds: reports.filter(r => r.findings).map(r => r.id),
    blockingFindingIds: reports.filter(r => r.findings).map(r => r.id),
    tier: /档位\s+(light|standard|heavy)/.exec(current ? String(s.reviews?.find(r => r.id === current.id)?.body ?? '') : String(s.reviews?.find(r => reviewerReport(r)?.findings)?.body ?? ''))?.[1] ?? null,
    mergeStateStatus: mergeState,
    producerUnverified: blockers.includes('producer-unverified'),
  };
  const unique = [...new Set(blockers)];
  const behindOnly = unique.length === 1 && unique[0] === 'behind';
  const baseUpdateEligible = behindOnly && s.pr.baseRefName === 'main' && s.mergeable === 'MERGEABLE';
  if (!unique.length) {
    return { ready: true, reason: current.state === 'APPROVED' ? 'current-approve' : 'current-report', blockers: [], baseUpdateEligible: false, ...evidence };
  }
  return { ready: false, reason: unique[0], blockers: unique, baseUpdateEligible, ...evidence };
}

/** The review flow is live for this repository: dispatch workflow active and the mode variable set to live. */
function* reviewSystemLive(ghFn) {
  try {
    const workflow = parse(yield () => ghFn(['api', `repos/${REPO}/actions/workflows/review-pr.yml`]));
    const mode = parse(yield () => ghFn(['api', `repos/${REPO}/actions/variables/MIVO_REVIEW_MODE`]));
    return workflow?.path === REVIEW_WORKFLOW && workflow.state === 'active' && mode?.name === 'MIVO_REVIEW_MODE' && mode.value === 'live';
  } catch { return false; }
}

export function* collectPublicReview(pr, ghFn, { handledFeedback = [] } = {}) {
  const snapshot = yield* collectPrSnapshot({pr: {...pr, repo: REPO}, ghFn});
  const ci = yield* collectMivoCiSteps({pr:snapshot.pr, ghFn});
  snapshot.requiredChecksGreen = ci.status === 'green';
  const checks = Array.isArray(ci.checks) ? ci.checks : [];
  const latestCheck = reviewChecks(checks, snapshot.pr.headRefOid)[0];
  const runs = {};
  const runId = latestCheck?.status === 'completed' ? runIdOf(latestCheck) : null;
  if (runId) runs[runId] = parse(yield () => ghFn(['api', `repos/${REPO}/actions/runs/${runId}`]));
  const verdict = evaluatePublicReview({snapshot, checks, runs, handledFeedback});
  // Ingress: the coordinator takes every Ready PR in while the review flow is live; Draft PRs are skipped.
  const reviewIngress = yield* reviewSystemLive(ghFn);
  const latest = parse(yield () => ghFn(['pr','view',String(pr.number),'--repo',REPO,'--json','id,state,isDraft,headRefOid,baseRefOid,author']));
  if (['id','state','isDraft','headRefOid','baseRefOid'].some(k=>latest[k] !== snapshot.pr[k]) || latest.author?.login !== snapshot.pr.author.login) throw Error('PR changed during review collection');
  // Admission no longer waits for green CI: a Ready PR is taken in as soon as the review flow is live, and a
  // red required check becomes repair feedback (failedRequiredCiItems). Pending CI only delays CI repairs.
  // The reason tells a real red apart from a policy the watcher could not read (2026-10-15: both showed as
  // "required-ci-not-green" while CI was green).
  const ciReason = { green: 'required-ci-and-review-ingress', failed: 'required-ci-failed', pending: 'required-ci-pending' }[ci.status] ?? 'required-policy-unknown';
  return {...snapshot,
    checks: snapshot.checks.filter(c => !REVIEW_INFRA_CHECKS.includes(c.name)),
    ci,
    admissionVerified: reviewIngress,
    admissionReason: reviewIngress ? ciReason : 'review-ingress-missing',
    mergeReady: verdict.ready, reviewReason: verdict.reason, reviewEvidence: verdict,
    mergeStateStatus: snapshot.mergeStateStatus ?? snapshot.pr.mergeStateStatus ?? 'UNKNOWN',
    baseTipOid: snapshot.baseTipOid ?? null,
    baseUpdateEligible: verdict.baseUpdateEligible === true,
    reviewRuns: runs};
}
