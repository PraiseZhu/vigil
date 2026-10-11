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
function runIdOf(check) {
  try { return /\/actions\/runs\/(\d+)(?:\/job\/\d+)?\/?$/.exec(new URL(check.details_url).pathname)?.[1] ?? null; }
  catch { return null; }
}

export function evaluatePublicReview({ snapshot: s, comments = s.comments, checks = [], runs = {} }) {
  const no = reason => ({ ready: false, reason });
  if (s.pr.state !== 'OPEN' || s.pr.isDraft || !s.pr.sameRepository) return no('inactive');
  const head = s.pr.headRefOid, base = s.pr.baseRefOid;
  const latestCheck = reviewChecks(checks, head)[0];
  if (!latestCheck) return no('waiting-review');
  if (latestCheck.status !== 'completed') return no('review-in-progress');
  if (latestCheck.conclusion !== 'success') return no(`review-${String(latestCheck.conclusion ?? 'unknown').toLowerCase()}`);
  // GitHub Actions authored the check; bind it to a run of the trusted dispatch workflow in this repository.
  const run = runs[runIdOf(latestCheck)];
  if (!run || run.path !== REVIEW_WORKFLOW || run.event !== 'workflow_dispatch' || run.repository?.full_name !== REPO) return no('producer-unverified');
  const reports = (s.reviews ?? []).map(reviewerReport).filter(Boolean).filter(r => r.commit === head).sort((a, b) => b.at - a.at);
  const current = reports.find(r => cleanReportFor(r, head, base));
  if (!current) return no(reports.some(r => r.findings) ? 'review-findings' : 'review-report-missing');
  if (reports.some(r => r.findings && r.at > current.at)) return no('review-findings');
  const epoch = /(\d{4}-\d\d-\d\dT[^:]+:\d\d:[^:]+)$/.exec(s.pr.releaseEpoch ?? '')?.[1];
  if (!epoch || current.at < Date.parse(epoch)) return no('review-before-release');
  if (!s.requiredChecksGreen) return no('waiting-ci');
  if (s.mergeable !== 'MERGEABLE') return no('merge-conflict-or-unknown');
  if (s.threads.some(t => !t.isResolved)) return no('unresolved-threads');
  const latest = new Map();
  for (const r of s.reviews) {
    const key = r.author?.login;
    if (!key) return no('review-author-unknown');
    if (!latest.has(key) || Date.parse(r.submittedAt) > Date.parse(latest.get(key).submittedAt)) latest.set(key,r);
  }
  if (s.reviewDecision === 'CHANGES_REQUESTED' || [...latest.values()].some(r => r.state === 'CHANGES_REQUESTED')) return no('review-veto');
  if (s.labels.includes('awaiting-discussion')) return no('discussion-hold');
  if (comments.some(c => at(c) > current.at && c.user?.login !== s.pr.author.login && c.body?.trim())) return no('new-feedback');
  return { ready: true, reason: current.state === 'APPROVED' ? 'current-approve' : 'current-report', reviewId: current.id,
    checkRunId: latestCheck.id, runId: run.id };
}

/** The review flow is live for this repository: dispatch workflow active and the mode variable set to live. */
function* reviewSystemLive(ghFn) {
  try {
    const workflow = parse(yield () => ghFn(['api', `repos/${REPO}/actions/workflows/review-pr.yml`]));
    const mode = parse(yield () => ghFn(['api', `repos/${REPO}/actions/variables/MIVO_REVIEW_MODE`]));
    return workflow?.path === REVIEW_WORKFLOW && workflow.state === 'active' && mode?.name === 'MIVO_REVIEW_MODE' && mode.value === 'live';
  } catch { return false; }
}

export function* collectPublicReview(pr, ghFn) {
  const snapshot = yield* collectPrSnapshot({pr: {...pr, repo: REPO}, ghFn});
  const ci = yield* collectMivoCiSteps({pr:snapshot.pr, ghFn});
  snapshot.requiredChecksGreen = ci.status === 'green';
  const checks = Array.isArray(ci.checks) ? ci.checks : [];
  const latestCheck = reviewChecks(checks, snapshot.pr.headRefOid)[0];
  const runs = {};
  const runId = latestCheck?.status === 'completed' ? runIdOf(latestCheck) : null;
  if (runId) runs[runId] = parse(yield () => ghFn(['api', `repos/${REPO}/actions/runs/${runId}`]));
  const verdict = evaluatePublicReview({snapshot, checks, runs});
  // Ingress: the coordinator takes every Ready PR in while the review flow is live; Draft PRs are skipped.
  const reviewIngress = yield* reviewSystemLive(ghFn);
  const latest = parse(yield () => ghFn(['pr','view',String(pr.number),'--repo',REPO,'--json','id,state,isDraft,headRefOid,baseRefOid,author']));
  if (['id','state','isDraft','headRefOid','baseRefOid'].some(k=>latest[k] !== snapshot.pr[k]) || latest.author?.login !== snapshot.pr.author.login) throw Error('PR changed during review collection');
  return {...snapshot,
    checks: snapshot.checks.filter(c => !REVIEW_INFRA_CHECKS.includes(c.name)),
    ci,
    admissionVerified: snapshot.requiredChecksGreen && reviewIngress,
    admissionReason: snapshot.requiredChecksGreen ? (reviewIngress ? 'required-ci-and-review-ingress' : 'review-ingress-missing') : 'required-ci-not-green',
    mergeReady: verdict.ready, reviewReason: verdict.reason, reviewEvidence: verdict};
}
