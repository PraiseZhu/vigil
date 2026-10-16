import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMivoPolicySync } from './bin/mivo-pr-policy.mjs';
import { collectMivoCiSync } from './bin/mivo-ci.mjs';

const REPO = 'example-org/example-plugin';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const rules = [[{ type: 'required_status_checks', ruleset_id: 7,
  parameters: { required_status_checks: [{ context: 'verify', integration_id: 15368 }] } }]];

function gh(protection) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_1', number: 5, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main' });
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${REPO}/rules/branches/main?per_page=100`) return JSON.stringify(rules);
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify(protection);
    if (endpoint === `repos/${REPO}/contents/docs/sync/required-checks.json?ref=${BASE}`) return JSON.stringify({
      type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['verify'], pr_only: [] })).toString('base64') });
    throw new Error(`unexpected call ${JSON.stringify(args)}`);
  };
}

// 2026-10-14: required checks moved to a ruleset; GitHub then dropped `required_status_checks` from the classic
// protection body, the watcher read every policy as unknown and stopped admitting any newly Ready PR.
test('classic protection without required_status_checks reads as no classic checks', () => {
  const policy = collectMivoPolicySync({ repo: REPO, number: 5, gh: gh({ url: `https://api.github.com/repos/${REPO}/branches/main/protection`, enforce_admins: { enabled: true } }) });
  assert.equal(policy.status, 'verified', policy.reason);
  assert.deepEqual(policy.required.map((rule) => [rule.context, rule.appId]), [['verify', 15368]]);
});

test('explicit null classic checks and real classic checks keep their meaning', () => {
  assert.equal(collectMivoPolicySync({ repo: REPO, number: 5, gh: gh({ url: 'x', required_status_checks: null }) }).status, 'verified');
  const classic = collectMivoPolicySync({ repo: REPO, number: 5, gh: gh({ url: 'x',
    required_status_checks: { contexts: ['lint'], checks: [{ context: 'lint', app_id: 9 }] } }) });
  assert.equal(classic.status, 'verified');
  assert.ok(classic.required.some((rule) => rule.context === 'lint' && rule.appId === 9));
});

test('a body that is not a protection object stays unknown', () => {
  const policy = collectMivoPolicySync({ repo: REPO, number: 5, gh: gh({ message: 'Something went wrong' }) });
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
  const ci = collectMivoCiSync({ pr, ghFn: ciGh(1, 2) });
  assert.notEqual(ci.status, 'unknown', ci.reason);
  assert.equal(ci.required[0].status, 'green');
  assert.equal(ci.required[0].evidence.attempt, 1);
});

test('a job claiming a later attempt than its workflow run is still rejected', () => {
  const ci = collectMivoCiSync({ pr, ghFn: ciGh(3, 2) });
  assert.equal(ci.status, 'unknown');
  assert.match(ci.reason, /attempt mismatch/);
});
