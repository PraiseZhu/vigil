import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCindyPolicySync } from './bin/cindy-pr-policy.mjs';
import { collectCindyCiSync } from './bin/cindy-ci.mjs';

const REPO = 'example-org/example-app';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const rules = [[{ type: 'required_status_checks', ruleset_id: 7,
  parameters: { required_status_checks: [{ context: 'verify', integration_id: 15368 }] } }]];

function gh(protection) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_1', number: 5, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main' });
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/rules/branches/main`) return JSON.stringify(rules);
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify(protection);
    throw new Error(`unexpected call ${JSON.stringify(args)}`);
  };
}

// Same shape that broke the sibling watcher on 2026-10-14: a protected branch whose classic required checks were
// removed comes back without the `required_status_checks` key at all.
test('classic protection without required_status_checks reads as no classic checks', () => {
  const policy = collectCindyPolicySync({ repo: REPO, number: 5, gh: gh({ url: `https://api.github.com/repos/${REPO}/branches/main/protection`, enforce_admins: { enabled: false } }) });
  assert.equal(policy.status, 'verified', policy.reason);
  assert.deepEqual(policy.required.map((rule) => [rule.context, rule.appId]), [['verify', 15368]]);
});

test('a body that is not a protection object stays unknown', () => {
  const policy = collectCindyPolicySync({ repo: REPO, number: 5, gh: gh({ message: 'Something went wrong' }) });
  assert.equal(policy.status, 'unknown');
  assert.match(policy.reason, /unknown classic protection/);
});

// 2026-10-16: `gh run rerun --failed` raised the run to attempt 2 while the jobs that were not re-run kept attempt 1,
// so every required check failed the attempt match and #1002 read as CI unknown for 17 hours.
function ciGh(jobAttempt, runAttempt) {
  const base = gh({ url: 'x', required_status_checks: null });
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ ...JSON.parse(base(args)), state: 'OPEN', isDraft: false });
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&filter=all`) return JSON.stringify([{ check_runs: [{ id: 11, name: 'verify',
      head_sha: HEAD, app: { id: 15368, slug: 'github-actions' }, status: 'completed', conclusion: 'success', started_at: '2026-10-15T10:00:00Z',
      details_url: `https://github.com/${REPO}/actions/runs/100/job/200` }] }]);
    if (endpoint === `repos/${REPO}/actions/jobs/200`) return JSON.stringify({ id: 200, run_id: 100, head_sha: HEAD, run_attempt: jobAttempt,
      check_run_url: `https://api.github.com/repos/${REPO}/check-runs/11` });
    if (endpoint === `repos/${REPO}/actions/runs/100`) return JSON.stringify({ id: 100, repository: { full_name: REPO }, head_sha: HEAD, run_attempt: runAttempt });
    if (endpoint === `repos/${REPO}/commits/${HEAD}/statuses?per_page=100`) return JSON.stringify([[]]);
    return base(args);
  };
}
const pr = { repo: REPO, number: 5, id: 'PR_1', headRefOid: HEAD, baseRefOid: BASE, state: 'OPEN', isDraft: false };

test('a check kept from an earlier attempt of a partially re-run workflow still counts', () => {
  const ci = collectCindyCiSync({ pr, ghFn: ciGh(1, 2) });
  assert.notEqual(ci.status, 'unknown', ci.reason);
  assert.equal(ci.required[0].status, 'green');
  assert.equal(ci.required[0].evidence.attempt, 1);
});

test('a job claiming a later attempt than its workflow run is still rejected', () => {
  const ci = collectCindyCiSync({ pr, ghFn: ciGh(3, 2) });
  assert.equal(ci.status, 'unknown');
  assert.match(ci.reason, /attempt mismatch/);
});

// The real #1002 shape: the jobs a partial re-run skipped are copied into the new attempt with new check ids and the
// same timestamps. Same-time checks from different runs stay ambiguous.
function copiesGh(secondRun) {
  const base = ciGh(1, 2);
  const check = (id, job, run) => ({ id, name: 'verify', head_sha: HEAD, app: { id: 15368, slug: 'github-actions' }, status: 'completed',
    conclusion: 'success', started_at: '2026-10-15T10:00:00Z', details_url: `https://github.com/${REPO}/actions/runs/${run}/job/${job}` });
  const jobs = { 200: [100, 1], 201: [secondRun, secondRun === 100 ? 2 : 1] };
  return (args) => {
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&filter=all`) return JSON.stringify([{ check_runs: [check(11, 200, 100), check(12, 201, secondRun)] }]);
    const job = /actions\/jobs\/(\d+)$/.exec(endpoint ?? '');
    if (job) { const [run, attempt] = jobs[job[1]]; return JSON.stringify({ id: Number(job[1]), run_id: run, head_sha: HEAD, run_attempt: attempt,
      check_run_url: `https://api.github.com/repos/${REPO}/check-runs/${job[1] === '200' ? 11 : 12}` }); }
    const run = /actions\/runs\/(\d+)$/.exec(endpoint ?? '');
    if (run) return JSON.stringify({ id: Number(run[1]), repository: { full_name: REPO }, head_sha: HEAD, run_attempt: run[1] === '100' ? 2 : 1 });
    return base(args);
  };
}

test('a re-run copy of a skipped job is the later attempt, not an ambiguous check', () => {
  const ci = collectCindyCiSync({ pr, ghFn: copiesGh(100) });
  assert.equal(ci.status, 'green', JSON.stringify(ci.required));
  assert.equal(ci.required[0].evidence.attempt, 2);
  const other = collectCindyCiSync({ pr, ghFn: copiesGh(101) });
  assert.equal(other.required[0].reason, 'ambiguous-check-attempt');
});
