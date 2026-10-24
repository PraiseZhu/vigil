import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCiTriage, triageText } from './bin/cindy-ci-triage.mjs';
import { feedbackItems } from './bin/cindy-watcher.mjs';

const NOW = Date.parse('2026-10-25T08:00:00Z');
let nextId = 2000;
const check = (name, { status = 'completed', conclusion = 'success', slug = 'github-actions', id = nextId++ } = {}) => ({
  id, name, status, conclusion: status === 'completed' ? conclusion : null, started_at: '2026-10-25T07:00:00Z',
  completed_at: status === 'completed' ? '2026-10-25T07:20:00Z' : null, app: { id: slug === 'github-actions' ? 15368 : 1861, slug },
  details_url: `https://github.com/example-org/example-client/actions/runs/1/job/${id}`,
});
const job = (id, failedStep) => ({ id, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: failedStep, conclusion: 'failure' }] });
const rule = (item) => ({ context: item.name, appId: item.app.id, status: 'failed', reason: 'required-check-failed',
  evidence: { kind: 'check', id: item.id, sha: 'b'.repeat(40), runId: 1, attempt: 1, url: item.details_url } });
const resultOf = (rules) => ({ status: 'failed', required: rules, headSha: 'b'.repeat(40) });

test('verify 汇总门红：下钻到 verify-checks 的失败步骤并给出 pnpm 命令', () => {
  const verify = check('verify', { conclusion: 'failure' });
  const checks = check('verify-checks', { conclusion: 'failure' });
  const jobsById = new Map([[String(checks.id), job(checks.id, 'Check i18n key consistency')]]);
  const out = applyCiTriage(resultOf([rule(verify)]), { checks: [verify, checks], jobsById, now: NOW });
  assert.equal(out.status, 'failed');
  assert.equal(out.required[0].triage.kind, 'aggregate');
  assert.deepEqual(out.required[0].triage.children.map((c) => [c.name, c.step, c.command]), [['verify-checks', 'Check i18n key consistency', 'pnpm check:i18n']]);
  const [item] = feedbackItems({ pr: { headRefOid: 'b'.repeat(40) }, ci: out }).filter((i) => i.source === 'ci');
  assert.match(item.body, /分类：aggregate/);
  assert.match(item.body, /pnpm check:i18n/);
});

test('Windows unit tests 汇总门与 Windows unit tests (n/4) 分片不混淆', () => {
  const agg = check('Windows unit tests', { conclusion: 'failure' });
  const shard = check('Windows unit tests (3/4)', { conclusion: 'failure' });
  const out = applyCiTriage(resultOf([rule(agg)]), { checks: [agg, shard], jobsById: new Map(), now: NOW });
  assert.equal(out.required[0].triage.kind, 'aggregate');
  assert.deepEqual(out.required[0].triage.children.map((c) => c.name), ['Windows unit tests (3/4)']);
});

test('DCO 红：分类 format，提示不 force push', () => {
  const dco = check('DCO', { conclusion: 'failure', slug: 'dco' });
  const out = applyCiTriage(resultOf([rule(dco)]), { checks: [dco], jobsById: new Map(), now: NOW });
  assert.equal(out.required[0].triage.kind, 'format');
  assert.match(triageText(out.required[0].triage), /force push/);
});

test('Cindy 的 infra 提示遵守不许 gh run rerun 的规则', () => {
  const verify = check('verify', { conclusion: 'cancelled' });
  const out = applyCiTriage(resultOf([rule(verify)]), { checks: [verify], jobsById: new Map(), now: NOW });
  const text = triageText(out.required[0].triage);
  assert.equal(out.required[0].triage.kind, 'infra');
  assert.match(text, /SC=no-change/);
  assert.doesNotMatch(text, /gh run rerun <run-id>/);
});

test('Cindy 没有等上游的门：失败的必需检查不会被暂缓', () => {
  const verify = check('verify', { conclusion: 'failure' });
  const pending = check('Windows unit tests (1/4)', { status: 'in_progress' });
  const out = applyCiTriage(resultOf([rule(verify)]), { checks: [verify, pending], jobsById: new Map(), now: NOW });
  assert.equal(out.required[0].status, 'failed');
});
