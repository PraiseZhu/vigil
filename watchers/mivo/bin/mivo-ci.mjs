import { createHash } from 'node:crypto';
import { collectMivoPolicySteps, evaluateMivoCi } from './mivo-pr-policy.mjs';
import { collectCodeScanningSteps } from './mivo-code-scanning.mjs';
import { AGGREGATES, applyCiTriage, failingJobsOnHead } from './mivo-ci-triage.mjs';

const parse = raw => typeof raw === 'string' ? JSON.parse(raw) : raw;
const check = (ok, reason) => { if (!ok) throw new Error(reason); };
// Starts every read before waiting for any: asynchronous transports run them side by side, synchronous ones in turn.
// A synchronous transport that throws throws here, synchronously, so the caller's try/catch turns it into `unknown`;
// a rejection is only created once an asynchronous read is already in flight, and then it reaches the awaiting caller.
export function readAll(ghFn, list) {
  const values = [];
  for (const args of list) {
    try { values.push(ghFn(args)); } catch (error) {
      if (!values.some(value => typeof value?.then === 'function')) throw error;
      values.push(Promise.reject(error));
    }
  }
  return values.some(value => typeof value?.then === 'function') ? Promise.all(values) : values;
}
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function* collectMivoCiSteps({ pr, ghFn, now = Date.now() }) {
  const policy = yield* collectMivoPolicySteps({ repo: pr.repo, number: pr.number, gh: ghFn });
  if (policy.status !== 'verified' || policy.prNodeId !== pr.id || policy.headSha !== pr.headRefOid
    || policy.baseSha !== pr.baseRefOid) return { policy, status: 'unknown', required: [], reason: 'policy-or-snapshot-unverified' };
  try {
    const pages = parse(yield () => ghFn(['api', `repos/${pr.repo}/commits/${pr.headRefOid}/check-runs?per_page=100&filter=all`, '--paginate', '--slurp']));
    check(Array.isArray(pages) && pages.every(p => Array.isArray(p.check_runs)), 'check pagination incomplete');
    const checks = pages.flatMap(p => p.check_runs);
    const jobs = new Map();
    const runs = new Map();
    const wanted = [];
    for (const item of checks) {
      check(item && item.head_sha === pr.headRefOid, 'check head drift');
      if (!policy.required.some(rule => rule.context === item.name && (rule.appId === null || rule.appId === item.app?.id))) continue;
      const time = Date.parse(item.started_at ?? item.created_at);
      if (Number.isFinite(time) && checks.some(other => other.name === item.name && other.app?.id === item.app?.id
        && Date.parse(other.started_at ?? other.created_at) > time)) continue;
      if (item.app?.slug !== 'github-actions') continue;
      const url = new URL(item.details_url);
      check(url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password, 'invalid check job URL');
      const match = new RegExp(`^/${pr.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/actions/runs/(\\d+)/job/(\\d+)/?$`).exec(url.pathname);
      check(match, 'Actions check has no bound job URL');
      wanted.push({ item, runId: match[1], jobId: match[2] });
    }
    // Every job and run of one head is independent of the others: read them at once. A completed job or run never
    // changes again, so those reads are kept per head (cache) and only unfinished ones are asked for every round.
    const ciCache = ghFn.ciCache;
    const keyOf = (kind, id) => `ci:${kind}:${pr.repo}:${pr.headRefOid}:${id}`;
    const fromCache = (kind, id) => { try { return ciCache?.get(keyOf(kind, id)); } catch { return undefined; } };
    const toLoad = [];
    for (const { runId, jobId } of wanted) {
      if (!jobs.has(jobId) && !toLoad.some(entry => entry.kind === 'jobs' && entry.id === jobId)) {
        const kept = fromCache('jobs', jobId);
        if (kept) jobs.set(jobId, kept); else toLoad.push({ kind: 'jobs', id: jobId });
      }
      if (!runs.has(runId) && !toLoad.some(entry => entry.kind === 'runs' && entry.id === runId)) {
        const kept = fromCache('runs', runId);
        if (kept) runs.set(runId, kept); else toLoad.push({ kind: 'runs', id: runId });
      }
    }
    const remember = (kind, id, value) => {
      if (value?.status === 'completed' && value?.head_sha === pr.headRefOid) { try { ciCache?.set(keyOf(kind, id), value); } catch { /* a cache write never fails the read */ } }
    };
    if (toLoad.length) {
      const loaded = yield () => readAll(ghFn, toLoad.map(entry => ['api', `repos/${pr.repo}/actions/${entry.kind}/${entry.id}`]));
      toLoad.forEach((entry, index) => {
        const value = parse(loaded[index]);
        (entry.kind === 'jobs' ? jobs : runs).set(entry.id, value);
        remember(entry.kind, entry.id, value);
      });
    }
    for (const { item, runId, jobId } of wanted) {
      const job = jobs.get(jobId);
      check(job.id === Number(jobId) && job.run_id === Number(runId) && job.head_sha === pr.headRefOid
        && job.check_run_url === `https://api.github.com/repos/${pr.repo}/check-runs/${item.id}`, 'Actions job/check mismatch');
      // A kept run that is older than the attempt the job reports was re-run since: read it again.
      if (fromCache('runs', runId) && Number.isSafeInteger(job.run_attempt) && job.run_attempt > runs.get(runId).run_attempt) {
        const fresh = parse(yield () => ghFn(['api', `repos/${pr.repo}/actions/runs/${runId}`]));
        runs.set(runId, fresh);
        remember('runs', runId, fresh);
      }
      const run = runs.get(runId);
      check(run.id === Number(runId) && run.repository?.full_name === pr.repo && run.head_sha === pr.headRefOid
        // A partial re-run (gh run rerun --failed) bumps the run's attempt, but jobs that were not re-run keep the
        // attempt that produced their check, so the job's attempt may be lower (2026-10-16: #1002 stayed unknown for 17 h).
        && Number.isSafeInteger(job.run_attempt) && job.run_attempt >= 1 && job.run_attempt <= run.run_attempt, 'Actions workflow/head/attempt mismatch');
      Object.assign(item, { workflowHeadSha: run.head_sha, runId: run.id, runAttempt: job.run_attempt });
    }
    const statusPages = parse(yield () => ghFn(['api', `repos/${pr.repo}/commits/${pr.headRefOid}/statuses?per_page=100`, '--paginate', '--slurp']));
    check(Array.isArray(statusPages) && statusPages.every(Array.isArray), 'status pagination incomplete');
    const statuses = statusPages.flat().map(s => ({ ...s, sha: pr.headRefOid }));
    const evaluated = evaluateMivoCi({ policy, headSha: pr.headRefOid, checks, statuses });
    // An aggregate (verify, Linux/Windows unit tests) is never the thing to fix: read the failed step of each
    // failed job below it so the repair session starts from the real cause. A failed read only drops the detail.
    if (evaluated.required?.some((rule) => rule.status === 'failed' && AGGREGATES.some((agg) => agg.context.test(rule.context)))) {
      const extra = [];
      for (const item of failingJobsOnHead(checks).slice(0, 12)) {
        const jobId = /\/actions\/runs\/\d+\/job\/(\d+)\/?$/.exec(String(item.details_url ?? ''))?.[1];
        if (!jobId || jobs.has(jobId)) continue;
        const kept = fromCache('jobs', jobId);
        if (kept) jobs.set(jobId, kept); else extra.push(jobId);
      }
      if (extra.length) {
        try {
          const loaded = yield () => readAll(ghFn, extra.map((id) => ['api', `repos/${pr.repo}/actions/jobs/${id}`]));
          extra.forEach((id, index) => { const value = parse(loaded[index]); jobs.set(id, value); remember('jobs', id, value); });
        } catch { /* triage keeps the job name without its failed step */ }
      }
    }
    const result = applyCiTriage(evaluated, { checks, jobsById: jobs, now, pr: pr.number });
    const codeScanning = yield* collectCodeScanningSteps({ pr, policy, ghFn });
    const rank = { failed: 4, unknown: 3, pending: 2, green: 1, 'not-required': 0 };
    const scanStatus = codeScanning.status === 'not-required' ? result.status : codeScanning.status;
    const status = (rank[result.status] ?? 3) >= (rank[scanStatus] ?? 3) ? result.status : scanStatus;
    const after = parse(yield () => ghFn(['pr', 'view', String(pr.number), '--repo', pr.repo, '--json', 'id,headRefOid,baseRefOid,state,isDraft']));
    check(after.id === pr.id && after.headRefOid === pr.headRefOid && after.baseRefOid === pr.baseRefOid
      && after.state === pr.state && after.isDraft === pr.isDraft, 'PR changed during CI collection');
    return { ...result, status, policy, checks, statuses, codeScanning, ciHash: digest({ required: result.required, scanning: codeScanning.scanHash }) };
  } catch (error) { return { status: 'unknown', policy, required: [], reason: error.message }; }
}

export function collectMivoCiSync(options) {
  const iterator = collectMivoCiSteps(options);
  let step = iterator.next();
  while (!step.done) {
    try {
      const value = step.value();
      if (value?.then) { value.catch?.(() => {}); throw new Error('async transport used with synchronous CI collection'); }
      step = iterator.next(value);
    } catch (error) { step = iterator.throw(error); }
  }
  return step.value;
}

export async function collectMivoCi(options) {
  const iterator = collectMivoCiSteps(options);
  let step = iterator.next();
  while (!step.done) {
    try { step = iterator.next(await step.value()); }
    catch (error) { step = iterator.throw(error); }
  }
  return step.value;
}
