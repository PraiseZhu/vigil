// CodeQL Analyze jobs that died before analysing anything. GitHub's CodeQL / Code Quality workflows download the
// CodeQL bundle first; when that download fails (HTTP 5xx from the release host) the job goes red with no finding.
// Mivo's pre-review admits a PR only when every check is green, and its own CI retry only covers jobs that never
// reported; failedOptionalActions (mivo-ci.mjs) leaves Analyze (*) to code scanning. So such a PR waited for a re-run
// nobody started (2026-11-08: two Ready PRs sat on a 504 for hours). The watcher re-runs the failed jobs of such a run
// once per head, only when every failed Analyze job of that run reports nothing but infrastructure errors, and tells a
// person if the re-run is red again.
export const CODEQL_INFRA_PATTERNS = [
  /Unable to download and extract CodeQL\b/i,
  /Failed to download (?:and extract )?CodeQL bundle/i,
  /\b(?:Unexpected HTTP response|HTTP status code)\s*:?\s*5\d\d\b/i,
];
const ANALYZE = /^Analyze \(/;
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The latest attempt of each Analyze job on this head that ended red: [{ name, checkId, runId, startedAt, url }]. */
export function selectFailedCodeqlJobs({ checks = [], repo, headSha }) {
  const jobUrl = new RegExp(`^https://github\\.com/${escapeRegExp(repo)}/actions/runs/(\\d+)/job/(\\d+)/?$`);
  const latest = new Map();
  for (const item of Array.isArray(checks) ? checks : []) {
    if (item?.app?.slug !== 'github-actions' || item.head_sha !== headSha || !ANALYZE.test(item.name ?? '')) continue;
    const match = jobUrl.exec(String(item.details_url ?? ''));
    if (!match) continue;
    // Keyed by run and job name: the CodeQL and Code Quality workflows both have an "Analyze (python)", and a
    // re-run adds a later attempt of the same job to the same run.
    const key = `${match[1]}\n${item.name}`;
    const time = Date.parse(item.started_at ?? item.created_at) || 0;
    if (!latest.has(key) || time > latest.get(key).time) latest.set(key, { item, runId: match[1], time });
  }
  return [...latest.values()]
    .filter(({ item }) => item.status === 'completed' && FAILED.has(item.conclusion))
    .map(({ item, runId, time }) => ({ name: item.name, checkId: item.id, runId, startedAt: time, url: item.details_url }))
    .sort((a, b) => a.runId.localeCompare(b.runId) || a.name.localeCompare(b.name));
}

/** True when the job reported failure annotations and every one of them is a download or server-side error. */
export function isCodeqlInfraFailure(annotations) {
  const failures = (Array.isArray(annotations) ? annotations : []).filter((a) => a?.annotation_level === 'failure');
  return failures.length > 0 && failures.every((a) => CODEQL_INFRA_PATTERNS.some((re) => re.test(String(a.message ?? ''))));
}

/**
 * For the light poll: true when the snapshot lists a red Analyze job on its head that no round has looked at yet, so
 * the full collection runs even though the fingerprint did not change (a PR already stuck when this shipped, or a run
 * that was still going when its last change was collected). At most once per intervalMs, like scanRecheckDue.
 * snapshot is normalizePollSnapshot's (GraphQL: upper-case status and conclusion, no job URL, check id kept).
 */
export function codeqlInfraCheckDue({ previous, snapshot, now, intervalMs }) {
  const failed = (snapshot?.checks ?? []).filter((c) => ANALYZE.test(c?.name ?? '')
    && String(c.status ?? '').toLowerCase() === 'completed' && FAILED.has(String(c.conclusion ?? '').toLowerCase()));
  if (!failed.length) return false;
  const state = previous?.codeqlInfraRerun;
  const looked = new Set(state?.head === snapshot.headRefOid
    ? Object.values(state.runs ?? {}).flatMap((run) => run?.checkIds ?? []).map(String) : []);
  if (failed.every((c) => looked.has(String(c.id)))) return false;
  const last = Date.parse(previous?.scanCheckedAt ?? '');
  return !Number.isFinite(last) || Date.parse(now) - last >= intervalMs;
}

/**
 * One round for one PR. state = { head, runs: { <runId>: { action, at, checkIds } }, notified }, kept per PR and reset
 * when the head moves; action is 'rerun' (this watcher re-ran it), 'not-infra' (a real failure, left alone) or
 * 'rerun-by-other' (the run already had a later attempt); checkIds are the failed checks already looked at.
 * A run whose annotations or status cannot be read is tried again next round.
 * Returns { state (null when nothing is recorded), reran: [runId], stillRed: [job name], notify, errors }.
 */
export function* superviseCodeqlInfra({ ci, repo, headSha, state, ghFn, now, dryRun = false }) {
  const current = state?.head === headSha
    ? { head: headSha, runs: { ...(state.runs ?? {}) }, notified: state.notified === true }
    : { head: headSha, runs: {}, notified: false };
  const out = { reran: [], stillRed: [], notify: false, errors: [] };
  const byRun = new Map();
  for (const job of selectFailedCodeqlJobs({ checks: ci?.checks, repo, headSha })) {
    byRun.set(job.runId, [...(byRun.get(job.runId) ?? []), job]);
  }
  for (const [runId, jobs] of byRun) {
    const checkIds = jobs.map((job) => job.checkId);
    const seen = current.runs[runId];
    if (seen) {
      // Red again after the re-run: a failed attempt that started after it was asked for.
      if (seen.action === 'rerun' && jobs.some((job) => job.startedAt > Date.parse(seen.at))) out.stillRed.push(...jobs.map((job) => job.name));
      // A later attempt is looked at now: the light poll does not force another collection for it.
      if (!dryRun) current.runs[runId] = { ...seen, checkIds: [...new Set([...(seen.checkIds ?? []), ...checkIds])] };
      continue;
    }
    try {
      const run = JSON.parse(yield () => ghFn(['api', `repos/${repo}/actions/runs/${runId}`]));
      // A run with a job still going is judged later, nothing recorded: GitHub refuses to re-run it, and its
      // annotations may not all be there yet.
      if (run?.status !== 'completed') continue;
      if (Number(run.run_attempt ?? 1) > 1) { current.runs[runId] = { action: 'rerun-by-other', at: now, checkIds }; continue; }
      let infra = true;
      for (const job of jobs) {
        const annotations = JSON.parse(yield () => ghFn(['api', `repos/${repo}/check-runs/${job.checkId}/annotations?per_page=100`]));
        if (!isCodeqlInfraFailure(annotations)) { infra = false; break; }
      }
      if (!infra) { current.runs[runId] = { action: 'not-infra', at: now, checkIds }; continue; }
      if (!dryRun) {
        yield () => ghFn(['api', '--method', 'POST', `repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`]);
        current.runs[runId] = { action: 'rerun', at: now, checkIds };
      }
      out.reran.push(runId);
    } catch (error) {
      out.errors.push({ runId, error: String(error?.message ?? error).slice(0, 200) });
    }
  }
  if (out.stillRed.length && !current.notified) {
    out.notify = true;
    if (!dryRun) current.notified = true;
  }
  const empty = !Object.keys(current.runs).length && !current.notified;
  return { state: empty ? null : current, ...out };
}
