// CI states nobody repaired. Three chains wait for green checks (the pre-review, the merge partner and this watcher)
// and only this watcher makes them green, so a state it does not act on is a dead wait:
// - A required check that GitHub skipped because a job it needs failed. It reported neither success nor failure, the
//   watcher read it as "unknown", and unknown produced no feedback (2026-11-10: a branch read answered HTTP 500 in a
//   4-second job, the required format gate behind it was skipped, and a Ready PR waited 12 hours).
// - A job that died on infrastructure (server-side 5xx, a lost runner). A repair session cannot fix it; a re-run can.
// - CI that stays unknown after every check has finished. Nothing changes on GitHub any more, so nothing wakes the
//   watcher; ciStall turns that into a diagnosis task with a bounded number of rounds.
import { AGGREGATES, GATES, latestByName } from './mivo-ci-triage.mjs';
import { networkErrorPattern } from '../../acceptance/bin/net-errors.mjs';

export const SELFHEAL_INFRA_PATTERNS = [
  /\b(?:HTTP(?: status)?(?: code)?|status(?: code)?|response)\s*:?\s*5\d\d\b/i,
  /\b5\d\d (?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i,
  /The hosted runner(?:: [^\n]*)? lost communication with the server/i,
  /The runner has received a shutdown signal/i,
  /The job was not acquired by Runner/i,
  networkErrorPattern(['connReset', 'timedOut', 'dnsAgain', 'notFound'], { flags: '', wordBoundary: true }),
];
// GitHub refuses a fourth attempt of a run in practice long before its own limit matters here: three attempts of one
// run on one head is where a re-run stops being a cheap guess.
export const SELFHEAL_MAX_RUN_ATTEMPT = 3;
// A re-run that was accepted but never produced a new attempt must not hide the failure for good.
export const SELFHEAL_HOLD_MS = 45 * 60 * 1000;
const SELFHEAL_MAX_JOBS_READ = 8;

const GENERIC_FAILURE = /^Process completed with exit code \d+\.?$/;
const RED = new Set(['failure', 'timed_out', 'startup_failure', 'cancelled']);
const ANALYZE = /^Analyze \(/; // CodeQL jobs: mivo-codeql-infra.mjs
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const runIdOf = (item, repo) => new RegExp(`^https://github\\.com/${escapeRegExp(repo)}/actions/runs/(\\d+)/job/\\d+/?$`)
  .exec(String(item?.details_url ?? ''))?.[1] ?? null;
const lower = (value) => String(value ?? '').toLowerCase();
const isRed = (item) => lower(item?.status) === 'completed' && RED.has(lower(item?.conclusion));
const isGateOrAggregate = (name) => GATES.some((gate) => gate.context === name) || AGGREGATES.some((agg) => agg.context.test(name));

/** The latest attempt of every Actions job of one run on this head. */
function jobsOfRun(checks, repo, runId) {
  return latestByName((Array.isArray(checks) ? checks : [])
    .filter((item) => item?.app?.slug === 'github-actions' && runIdOf(item, repo) === String(runId)));
}

/**
 * A required check that was skipped while a job of the same run failed is a failure of that run, not an unknown:
 * the rule becomes failed, its evidence points at the failed job, and it keeps the name of the check that was skipped.
 * A skipped check with no failed job beside it (skipped by its own condition) is left as it was.
 */
export function resolveSkippedRequired(result, { checks = [], repo } = {}) {
  if (!result || !Array.isArray(result.required) || !repo) return result;
  let changed = false;
  const required = result.required.map((rule) => {
    if (rule.status !== 'unknown' || rule.reason !== 'required-check-skipped' || rule.evidence?.runId == null) return rule;
    const failed = jobsOfRun(checks, repo, rule.evidence.runId).filter(isRed).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!failed.length) return rule;
    changed = true;
    const names = failed.map((item) => item.name);
    return {
      ...rule, status: 'failed', reason: 'required-check-skipped-upstream-failed', skippedBy: names,
      evidence: { ...rule.evidence, id: failed[0].id, url: failed[0].details_url ?? rule.evidence.url ?? null, skippedCheckId: rule.evidence.id },
      triage: {
        kind: 'skipped-upstream', check: rule.context, step: null,
        hint: `这个必需检查没有运行：同一次运行里它依赖的 job（${names.join('、')}）失败了。先看那个 job 的日志：接口 5xx、runner 丢失这类环境故障用 gh run rerun ${rule.evidence.runId} --failed 重跑（会连带重跑被跳过的检查）；是本 PR 引起的失败就修代码。不要为被跳过的检查本身改代码。`,
      },
    };
  });
  if (!changed) return result;
  const status = required.some((item) => item.status === 'failed') ? 'failed'
    : required.some((item) => item.status === 'unknown') ? 'unknown'
      : required.some((item) => item.status === 'pending') ? 'pending' : 'green';
  return { ...result, required, status };
}

/** True when the job reported failure annotations and every one of them is a server-side or runner error. */
export function isInfraFailure(annotations) {
  // Every failed step also gets "Process completed with exit code N.": it says that a step failed, not why.
  const failures = (Array.isArray(annotations) ? annotations : [])
    .filter((a) => a?.annotation_level === 'failure' && !GENERIC_FAILURE.test(String(a.message ?? '').trim()));
  return failures.length > 0 && failures.every((a) => SELFHEAL_INFRA_PATTERNS.some((re) => re.test(String(a.message ?? ''))));
}

/** Red Actions checks on this head grouped by run: Map<runId, [{ name, checkId, conclusion }]>. CodeQL jobs are not ours. */
export function redRunsOnHead({ checks = [], repo, headSha }) {
  const runs = new Map();
  const mine = (Array.isArray(checks) ? checks : []).filter((item) => item?.app?.slug === 'github-actions' && item.head_sha === headSha);
  const byRun = new Map();
  for (const item of mine) {
    const runId = runIdOf(item, repo);
    if (runId) byRun.set(runId, [...(byRun.get(runId) ?? []), item]);
  }
  for (const [runId, items] of byRun) {
    const red = latestByName(items).filter((item) => isRed(item) && !ANALYZE.test(item.name ?? ''));
    if (red.length) runs.set(runId, red.map((item) => ({ name: item.name, checkId: item.id, conclusion: lower(item.conclusion) })));
  }
  return runs;
}

/**
 * One round for one PR. state = { head, runs: { <runId>: { action, at, attempt, checkIds } } }, kept per PR and reset
 * when the head moves. action is 'rerun' (this watcher re-ran the failed jobs), 'not-infra' (a real failure: the repair
 * session gets it) or 'attempts-exhausted'. A run is re-run once per head, in two cases only: a required check of it was
 * skipped behind a failed job (whatever that job's error was — one re-run is cheaper than a session, and a second
 * failure goes to a session), or every failed job of it reports nothing but infrastructure errors.
 * A run that is still going, or whose annotations cannot be read, is judged again on a later round.
 * Returns { state (null when nothing is recorded), reran: [runId], errors }.
 */
export function* superviseCiSelfHeal({ ci, repo, headSha, state, ghFn, now, dryRun = false }) {
  const current = state?.head === headSha ? { head: headSha, runs: { ...(state.runs ?? {}) } } : { head: headSha, runs: {} };
  const out = { reran: [], errors: [] };
  const skippedRuns = new Set((ci?.required ?? [])
    .filter((rule) => rule?.reason === 'required-check-skipped-upstream-failed' && rule.evidence?.runId != null)
    .map((rule) => String(rule.evidence.runId)));
  let read = 0;
  for (const [runId, jobs] of redRunsOnHead({ checks: ci?.checks, repo, headSha })) {
    const checkIds = jobs.map((job) => job.checkId);
    const seen = current.runs[runId];
    if (seen) {
      // Later attempts are looked at now, so the light poll does not force another collection for them.
      if (!dryRun) current.runs[runId] = { ...seen, seenIds: [...new Set([...(seen.seenIds ?? seen.checkIds ?? []), ...checkIds])] };
      continue;
    }
    const candidates = jobs.filter((job) => !isGateOrAggregate(job.name));
    const unconditional = skippedRuns.has(runId);
    if (!unconditional && !candidates.length) {
      if (!dryRun) current.runs[runId] = { action: 'not-infra', at: now, checkIds };
      continue;
    }
    if (read + candidates.length > SELFHEAL_MAX_JOBS_READ && !unconditional) continue;
    try {
      const run = JSON.parse(yield () => ghFn(['api', `repos/${repo}/actions/runs/${runId}`]));
      // GitHub refuses to re-run a run with a job still going, and its annotations may not all be there yet.
      if (run?.status !== 'completed') continue;
      const attempt = Number(run.run_attempt ?? 1);
      if (attempt >= SELFHEAL_MAX_RUN_ATTEMPT) {
        if (!dryRun) current.runs[runId] = { action: 'attempts-exhausted', at: now, attempt, checkIds };
        continue;
      }
      let infra = unconditional;
      if (!infra) {
        infra = true;
        for (const job of candidates) {
          if (job.conclusion === 'startup_failure') continue;
          read += 1;
          const annotations = JSON.parse(yield () => ghFn(['api', `repos/${repo}/check-runs/${job.checkId}/annotations?per_page=100`]));
          if (!isInfraFailure(annotations)) { infra = false; break; }
        }
      }
      if (!infra) {
        if (!dryRun) current.runs[runId] = { action: 'not-infra', at: now, attempt, checkIds };
        continue;
      }
      if (!dryRun) {
        yield () => ghFn(['api', '--method', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`]);
        current.runs[runId] = { action: 'rerun', at: now, attempt, checkIds, reason: unconditional ? 'skipped-upstream' : 'infra' };
      }
      out.reran.push(runId);
    } catch (error) {
      out.errors.push({ runId, error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { state: Object.keys(current.runs).length ? current : null, ...out };
}

/**
 * True while a CI failure belongs to a run this watcher just re-ran: the failure it reports is the attempt before the
 * re-run, so it is not sent to a repair session. The re-run's own result has a new check id and is delivered normally.
 */
export function heldBySelfHeal(state, item, now) {
  if (!state || item?.source !== 'ci' || state.head !== item.sha) return false;
  const proof = item.requiredFailure ?? item.optionalFailure;
  const entry = proof?.runId != null ? state.runs?.[String(proof.runId)] : null;
  if (entry?.action !== 'rerun') return false;
  if (!(entry.checkIds ?? []).some((id) => String(id) === String(proof.checkId))) return false;
  return Date.parse(now) - Date.parse(entry.at) < SELFHEAL_HOLD_MS;
}

/**
 * For the light poll: true when the snapshot lists a red Actions check on its head that no round has judged yet, so the
 * full collection runs even though the fingerprint did not change (a run that was still going, or an unreadable
 * annotation, when its failure was first collected). At most once per intervalMs.
 * snapshot is normalizePollSnapshot's (upper-case status and conclusion, check id kept).
 */
export function ciSelfHealCheckDue({ previous, snapshot, now, intervalMs }) {
  const red = (snapshot?.checks ?? []).filter((c) => !ANALYZE.test(c?.name ?? '') && isRed(c));
  if (!red.length) return false;
  const state = previous?.ciSelfHeal;
  const looked = new Set(state?.head === snapshot.headRefOid
    ? Object.values(state.runs ?? {}).flatMap((run) => [...(run?.checkIds ?? []), ...(run?.seenIds ?? [])]).map(String) : []);
  if (red.every((c) => looked.has(String(c.id)))) return false;
  const last = Date.parse(previous?.scanCheckedAt ?? '');
  return !Number.isFinite(last) || Date.parse(now) - last >= intervalMs;
}

// CI that is still unknown this long after its last check finished will not settle by itself.
export const CI_STALL_MS = 30 * 60 * 1000;
export const CI_STALL_ROUND_MS = 2 * 60 * 60 * 1000;
export const CI_STALL_ROUNDS = 3;
// After the diagnosis rounds are used up a person hears about it, once per head.
export const CI_STALL_NOTICE_MS = CI_STALL_MS + CI_STALL_ROUNDS * CI_STALL_ROUND_MS;

/**
 * { round, rules: [{ context, reason }], since } when the required checks of this head cannot be read as green, failed
 * or pending although every check on it finished CI_STALL_MS ago; null otherwise. round goes 0..CI_STALL_ROUNDS-1 with
 * the time since the last check finished, so the diagnosis is delivered at most CI_STALL_ROUNDS times per head and needs
 * no stored counter.
 */
export function ciStall({ ci, headSha, now }) {
  if (ci?.status !== 'unknown' || !Array.isArray(ci.checks) || !ci.checks.length || !Array.isArray(ci.required)) return null;
  const mine = ci.checks.filter((item) => item?.head_sha === headSha);
  if (!mine.length || mine.some((item) => lower(item.status) !== 'completed')) return null;
  const done = Math.max(...mine.map((item) => Date.parse(item.completed_at ?? item.started_at ?? '') || 0));
  const age = Date.parse(now) - done;
  if (!done || !(age >= CI_STALL_MS) || age >= CI_STALL_NOTICE_MS) return null;
  const rules = ci.required.filter((rule) => rule.status === 'unknown').map((rule) => ({ context: rule.context, reason: rule.reason ?? 'unknown' }));
  if (!rules.length) return null;
  return { round: Math.floor((age - CI_STALL_MS) / CI_STALL_ROUND_MS), rules, since: new Date(done).toISOString() };
}
