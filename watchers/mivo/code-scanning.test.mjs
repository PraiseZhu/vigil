import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCodeScanning, mergeCodeScanningRules, codeScanningFeedbackItems, collectCodeScanningSteps } from './bin/mivo-code-scanning.mjs';
import { feedbackRepairPolicy } from './bin/mivo-feedback-policy.mjs';
import { collectMivoPolicySync } from './bin/mivo-pr-policy.mjs';
import { policyCiResult } from './bin/mivo-repair.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const REPO = 'example-org/example-plugin';

const policy = {
  status: 'verified', headSha: HEAD, policyHash: 'p1',
  codeScanningRules: [{ tool: 'CodeQL', alertsThreshold: 'errors_and_warnings', securityAlertsThreshold: 'medium_or_higher', sources: ['ruleset:1'] }],
};

function analysis(extra = {}) {
  return { id: 11, tool: { name: 'CodeQL' }, ref: 'refs/pull/7/head', commit_sha: HEAD, created_at: '2026-10-21T00:00:00Z', analysis_key: 'js', category: '/javascript-typescript', ...extra };
}

test('no rules means not-required and does not invent alerts', () => {
  const result = evaluateCodeScanning({ pr: { number: 7, headRefOid: HEAD }, policy: { ...policy, codeScanningRules: [] }, analyses: [], alerts: [] });
  assert.equal(result.status, 'not-required');
});

test('missing analysis is unknown, not green', () => {
  const result = evaluateCodeScanning({ pr: { number: 7, headRefOid: HEAD }, policy, analyses: [], alerts: [] });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'code-scanning-analysis-missing');
});

test('open warning on current head is blocking under errors_and_warnings', () => {
  const alerts = [{ number: 42, state: 'open', tool: { name: 'CodeQL' }, rule: { id: 'js/example', severity: 'warning' }, html_url: 'https://example.invalid/42',
    most_recent_instance: { state: 'open', ref: 'refs/pull/7/head', commit_sha: HEAD, location: { path: 'src/a.ts', start_line: 12 }, message: { text: 'x' } } }];
  const result = evaluateCodeScanning({ pr: { number: 7, headRefOid: HEAD }, policy, analyses: [analysis()], alerts });
  assert.equal(result.status, 'failed');
  assert.equal(result.blockingAlerts[0].alertNumber, 42);
  const items = codeScanningFeedbackItems({ pr: { headRefOid: HEAD }, scanning: result });
  assert.equal(items[0].source, 'code-scanning');
  const repair = feedbackRepairPolicy(items[0], { headSha: HEAD });
  assert.equal(repair.action, 'required-ci-fix');
  assert.equal(repair.reason, 'verified-code-scanning-failure');
});

test('security low does not bypass medium_or_higher; ordinary note does not bypass errors_and_warnings', () => {
  const low = [{ number: 1, state: 'open', tool: { name: 'CodeQL' }, rule: { id: 'js/sec', severity: 'warning', security_severity_level: 'low' },
    most_recent_instance: { state: 'open', ref: 'refs/pull/7/head', commit_sha: HEAD, location: { path: 'a.js', start_line: 1 } } }];
  const note = [{ number: 2, state: 'open', tool: { name: 'CodeQL' }, rule: { id: 'js/note', severity: 'note' },
    most_recent_instance: { state: 'open', ref: 'refs/pull/7/head', commit_sha: HEAD, location: { path: 'a.js', start_line: 2 } } }];
  assert.equal(evaluateCodeScanning({ pr: { number: 7, headRefOid: HEAD }, policy, analyses: [analysis()], alerts: low }).status, 'green');
  assert.equal(evaluateCodeScanning({ pr: { number: 7, headRefOid: HEAD }, policy, analyses: [analysis()], alerts: note }).status, 'green');
});

test('old head or dismissed alerts are not current-head failures', () => {
  const old = [{ number: 3, state: 'open', tool: { name: 'CodeQL' }, rule: { id: 'js/old', severity: 'error' },
    most_recent_instance: { state: 'open', ref: 'refs/pull/7/head', commit_sha: BASE, location: { path: 'a.js', start_line: 1 } } }];
  const dismissed = [{ number: 4, state: 'dismissed', tool: { name: 'CodeQL' }, rule: { id: 'js/d', severity: 'error' },
    most_recent_instance: { state: 'dismissed', ref: 'refs/pull/7/head', commit_sha: HEAD, location: { path: 'a.js', start_line: 1 } } }];
  assert.equal(evaluateCodeScanning({ pr: { number: 7, headRefOid: HEAD }, policy, analyses: [analysis()], alerts: old }).status, 'green');
  assert.equal(evaluateCodeScanning({ pr: { number: 7, headRefOid: HEAD }, policy, analyses: [analysis()], alerts: dismissed }).status, 'green');
});

test('newer failed analysis is not hidden by older success on the same config', () => {
  const analyses = [
    analysis({ id: 1, created_at: '2026-10-20T00:00:00Z' }),
    analysis({ id: 2, created_at: '2026-10-21T00:00:00Z', error: 'failed' }),
  ];
  const result = evaluateCodeScanning({ pr: { number: 7, headRefOid: HEAD }, policy, analyses, alerts: [] });
  assert.equal(result.status, 'unknown');
});

test('most strict threshold wins when merging rules', () => {
  const merged = mergeCodeScanningRules([
    { tool: 'CodeQL', alertsThreshold: 'errors', securityAlertsThreshold: 'critical', sources: ['a'] },
    { tool: 'CodeQL', alertsThreshold: 'all', securityAlertsThreshold: 'high_or_higher', sources: ['b'] },
  ]);
  assert.equal(merged[0].alertsThreshold, 'all');
  assert.equal(merged[0].securityAlertsThreshold, 'high_or_higher');
});

test('policy collector records code scanning rules and scanning failures block helper completion', () => {
  const rules = [[{ type: 'required_status_checks', ruleset_id: 7,
    parameters: { required_status_checks: [{ context: 'verify', integration_id: 15368 }] } },
    { type: 'code_scanning', ruleset_id: 8, parameters: { code_scanning_tools: [{ tool: 'CodeQL', alerts_threshold: 'errors_and_warnings', security_alerts_threshold: 'medium_or_higher' }] } }]];
  const gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_1', number: 5, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main' });
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${REPO}/rules/branches/main?per_page=100`) return JSON.stringify(rules);
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify({ url: 'x', required_status_checks: null });
    if (endpoint === `repos/${REPO}/contents/docs/sync/required-checks.json?ref=${BASE}`) return JSON.stringify({
      type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['verify'], pr_only: [] })).toString('base64') });
    throw new Error(`unexpected ${JSON.stringify(args)}`);
  };
  const collected = collectMivoPolicySync({ repo: REPO, number: 5, gh });
  assert.equal(collected.status, 'verified');
  assert.equal(collected.codeScanningRules[0].tool, 'CodeQL');
  const ci = policyCiResult({
    status: 'failed', policyHash: collected.policyHash, required: [{ context: 'verify', status: 'green', evidence: { sha: HEAD } }],
    codeScanning: { status: 'failed', reason: 'code-scanning-failed', blockingAlerts: [{ alertNumber: 42 }] },
  }, HEAD);
  assert.equal(ci.requiredGreen, false);
  assert.ok(ci.requiredChecks.some((item) => item.kind === 'code-scanning' && item.bucket === 'fail' && item.runId == null));
});

test('collectCodeScanningSteps binds the default refs/pull/N/merge analysis through the merge commit parents', () => {
  const MERGE = 'c'.repeat(40);
  const ghFn = (args) => {
    const url = args[1];
    if (url.includes('/code-scanning/analyses')) return JSON.stringify([[analysis({ ref: 'refs/pull/7/merge', commit_sha: MERGE })]]);
    if (url.includes('/code-scanning/alerts')) return JSON.stringify([[]]);
    if (url.endsWith(`/commits/${MERGE}`)) return JSON.stringify({ sha: MERGE, parents: [{ sha: 'd'.repeat(40) }, { sha: HEAD }] });
    throw new Error(`unexpected ${url}`);
  };
  const gen = collectCodeScanningSteps({ pr: { repo: REPO, number: 7, headRefOid: HEAD, baseRefOid: BASE }, policy, ghFn });
  let step = gen.next();
  while (!step.done) step = gen.next(step.value());
  assert.equal(step.value.status, 'green');
});
