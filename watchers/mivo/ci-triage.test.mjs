import test from 'node:test';
import assert from 'node:assert/strict';
import { applyCiTriage, triageText, GATE_RERUN_GRACE_MS } from './bin/mivo-ci-triage.mjs';
import { feedbackItems } from './bin/mivo-watcher.mjs';

const NOW = Date.parse('2026-10-25T08:00:00Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
let nextId = 1000;
const check = (name, { status = 'completed', conclusion = 'success', started = ago(40 * 60e3), completed = ago(30 * 60e3), id = nextId++ } = {}) => ({
  id, name, status, conclusion: status === 'completed' ? conclusion : null, started_at: started,
  completed_at: status === 'completed' ? completed : null, app: { id: 15368, slug: 'github-actions' },
  details_url: `https://github.com/example-org/example-plugin/actions/runs/1/job/${id}`,
});
const job = (id, failedStep) => ({ id, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: failedStep, conclusion: 'failure' }] });
const rule = (item, { status = 'failed', attempt = 1 } = {}) => ({
  context: item.name, appId: 15368, status, reason: `required-check-${status}`, evidence: { kind: 'check', id: item.id, sha: 'a'.repeat(40), runId: 1, attempt, url: item.details_url },
});
const resultOf = (rules) => ({ status: rules.some((r) => r.status === 'failed') ? 'failed' : 'green', required: rules, headSha: 'a'.repeat(40) });

test('#1254: pr-ci-freshness 在 verify 还没跑完时红，暂缓派发而不是派修复', () => {
  const freshness = check('pr-ci-freshness', { conclusion: 'failure' });
  const verify = check('verify', { status: 'in_progress' });
  const jobsById = new Map([[String(freshness.id), job(freshness.id, '合并前 stale-green 校验')]]);
  const out = applyCiTriage(resultOf([rule(freshness), rule(verify, { status: 'pending' })]), { checks: [freshness, verify], jobsById, now: NOW });
  const gate = out.required.find((r) => r.context === 'pr-ci-freshness');
  assert.equal(gate.status, 'pending');
  assert.equal(gate.reason, 'gate-waiting-upstream');
  assert.equal(out.status, 'pending');
  assert.deepEqual(feedbackItems({ pr: { headRefOid: 'a'.repeat(40) }, ci: out }).filter((i) => i.source === 'ci'), []);
});

test('pr-format-gate 的 Windows 证据步在 Windows 分片还在跑时红，暂缓派发', () => {
  const gate = check('pr-format-gate (title/body template)', { conclusion: 'failure' });
  const shard = check('Windows unit shard (2/4)', { status: 'in_progress' });
  const jobsById = new Map([[String(gate.id), job(gate.id, 'Validate platform evidence using trusted base code')]]);
  const out = applyCiTriage(resultOf([rule(gate)]), { checks: [gate, shard], jobsById, now: NOW });
  assert.equal(out.required[0].status, 'pending');
  assert.equal(out.required[0].reason, 'gate-waiting-upstream');
  assert.deepEqual(out.required[0].triage.upstream.pending, ['Windows unit shard (2/4)']);
});

test('pr-format-gate 的标题正文步红时立即派发，分类 format，给出 gh pr edit', () => {
  const gate = check('pr-format-gate (title/body template)', { conclusion: 'failure' });
  const shard = check('Windows unit shard (2/4)', { status: 'in_progress' });
  const jobsById = new Map([[String(gate.id), job(gate.id, 'Validate PR title/body against pr-rules.json template')]]);
  const out = applyCiTriage(resultOf([rule(gate)]), { checks: [gate, shard], jobsById, now: NOW });
  assert.equal(out.required[0].status, 'failed');
  assert.equal(out.required[0].triage.kind, 'format');
  const [item] = feedbackItems({ pr: { headRefOid: 'a'.repeat(40) }, ci: out }).filter((i) => i.source === 'ci');
  assert.match(item.body, /分类：format/);
  assert.match(item.body, /gh pr edit/);
  assert.equal(item.ciTriage.kind, 'format');
});

test('verify 已红时 freshness 只是跟着红：不单独派；verify 下钻到失败分片的步骤和本地命令', () => {
  const freshness = check('pr-ci-freshness', { conclusion: 'failure' });
  const verify = check('verify', { conclusion: 'failure' });
  const shard = check('Linux unit shard (2/4)', { conclusion: 'failure' });
  const lint = check('lint + tsc + unit + logging', { conclusion: 'success' });
  const jobsById = new Map([
    [String(freshness.id), job(freshness.id, '合并前 stale-green 校验')],
    [String(shard.id), job(shard.id, 'Run unit shard')],
  ]);
  const out = applyCiTriage(resultOf([rule(freshness), rule(verify)]), { checks: [freshness, verify, shard, lint], jobsById, now: NOW });
  const gate = out.required.find((r) => r.context === 'pr-ci-freshness');
  const agg = out.required.find((r) => r.context === 'verify');
  assert.equal(gate.status, 'pending');
  assert.equal(gate.reason, 'gate-upstream-failed');
  assert.equal(out.status, 'failed');
  assert.equal(agg.triage.kind, 'aggregate');
  assert.deepEqual(agg.triage.children.map((c) => [c.name, c.step, c.command]), [['Linux unit shard (2/4)', 'Run unit shard', 'npm run test:unit -- --shard=2/4']]);
  const items = feedbackItems({ pr: { headRefOid: 'a'.repeat(40) }, ci: out }).filter((i) => i.source === 'ci');
  assert.deepEqual(items.map((i) => i.requiredFailure.context), ['verify']);
  assert.match(items[0].body, /Linux unit shard \(2\/4\) · 步骤 Run unit shard/);
});

test('上游刚转绿且 pr-gate-rerun 还有次数：给自动重跑留时间；过了宽限或次数用完才派发', () => {
  const run = (completedAgo, attempt) => {
    const freshness = check('pr-ci-freshness', { conclusion: 'failure' });
    const verify = check('verify', { conclusion: 'success', completed: ago(completedAgo) });
    const jobsById = new Map([[String(freshness.id), job(freshness.id, '合并前 stale-green 校验')]]);
    return applyCiTriage(resultOf([rule(freshness, { attempt }), rule(verify, { status: 'green' })]), { checks: [freshness, verify], jobsById, now: NOW }).required[0];
  };
  assert.equal(run(2 * 60e3, 1).reason, 'gate-rerun-expected');
  assert.equal(run(GATE_RERUN_GRACE_MS + 60e3, 1).status, 'failed');
  assert.equal(run(2 * 60e3, 3).status, 'failed');
});

test('读不到门的失败步骤时不暂缓，分类 unknown，交给日志判断', () => {
  const freshness = check('pr-ci-freshness', { conclusion: 'failure' });
  const verify = check('verify', { status: 'in_progress' });
  const out = applyCiTriage(resultOf([rule(freshness)]), { checks: [freshness, verify], jobsById: new Map(), now: NOW });
  assert.equal(out.required[0].status, 'failed');
  assert.equal(out.required[0].triage.kind, 'unknown');
});

test('必需检查被取消：分类 infra，不改代码', () => {
  const build = check('cindyplugin build', { conclusion: 'cancelled' });
  const out = applyCiTriage(resultOf([rule(build)]), { checks: [build], jobsById: new Map(), now: NOW });
  assert.equal(out.required[0].triage.kind, 'infra');
  assert.match(triageText(out.required[0].triage), /不改代码/);
});

test('code 检查按失败步骤给出本地命令', () => {
  const lint = check('lint + tsc + unit + logging', { conclusion: 'failure' });
  const jobsById = new Map([[String(lint.id), job(lint.id, 'Verify i18n four-locale parity')]]);
  const out = applyCiTriage(resultOf([rule(lint)]), { checks: [lint], jobsById, now: NOW });
  assert.equal(out.required[0].triage.kind, 'code');
  assert.equal(out.required[0].triage.command, 'npm run verify:i18n');
});

test('unknown 状态不做分诊，原样返回', () => {
  const input = { status: 'unknown', required: [], reason: 'x' };
  assert.equal(applyCiTriage(input, { checks: [] }), input);
});
