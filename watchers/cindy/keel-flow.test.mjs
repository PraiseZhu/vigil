import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ciErrorExcerpts, verifyKeelRun } from './bin/cindy-repair.mjs';
import { constrainRetryDispatch, dispatchParams } from './bin/cindy-watcher.mjs';

const HEAD = 'a'.repeat(40);
const REPO = 'makecindy/cindy';

function ledger(t, runId, rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-keel-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'runs', runId), { recursive: true });
  fs.writeFileSync(path.join(root, 'runs', runId, 'decisions.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  return root;
}

const task = { dispatchId: 'live-7-x', keelFlow: true, createdAt: '2026-10-06T01:00:00.000Z', repo: REPO };

const V2_TASK = { ...task, keelFlowVersion: 2, headRefOid: HEAD, feedback: [] };
const V2_VERIFICATION = { status: 'not-required-no-change', head: HEAD };
function flowRows() {
  const common = { run_id: 'run-flow', at: '2026-10-06T01:00:01.000Z' };
  return [
    { ...common, kind: 'step', summary: 'start investigation（user）depth=1' },
    { ...common, kind: 'step', summary: 'vigil task=live-7-x' },
    { ...common, row_id: 'run-flow#3', kind: 'decision', template: 'J4', state_sha256: 'b'.repeat(64), answer: 'no-change', policy: 'act' },
    { ...common, kind: 'evidence', evidence: { kind: 'vigil-flow', version: 2, taskId: 'live-7-x', head: HEAD,
      playbook: 'investigation', manualPath: 'pstack/skills/poteto-mode/playbooks/investigation.md',
      decisionRowIds: ['run-flow#3'], steps: { reproduce: 'Investigated the reported behavior', repair: 'No change required',
        verify: { status: 'not-run', reason: 'No code changed' } } } },
  ];
}
test('v2 rejects missing ledger root and marker-only runs', t => {
  assert.throws(() => verifyKeelRun({ task: V2_TASK, root: null }), /KEEL_RUN_REQUIRED/);
  const root = ledger(t, 'run-flow', flowRows().slice(0, 2));
  assert.throws(() => verifyKeelRun({ task: V2_TASK, root, runId: 'run-flow', validatedHead: HEAD, verification: V2_VERIFICATION }), /KEEL_RUN_REQUIRED/);
});
test('v2 accepts actual task decisions and no-change evidence', t => {
  const root = ledger(t, 'run-flow', flowRows());
  assert.equal(verifyKeelRun({ task: V2_TASK, root, runId: 'run-flow', validatedHead: HEAD, verification: V2_VERIFICATION }).contractVersion, 2);
});
for (const [name, mutate] of [
  ['wrong task marker', r => { r[1].summary += '-other'; }],
  ['wrong HEAD', r => { r[3].evidence.head = 'c'.repeat(40); }],
  ['only startup decision', r => { r[2].template = 'J2'; }],
  ['handwritten decision', r => { delete r[2].state_sha256; }],
  ['wrong run', r => { r[2].run_id = 'run-other'; }],
  ['empty investigation', r => { r[3].evidence.steps.reproduce = ''; }],
  ['no reason for skipped tests', r => { delete r[3].evidence.steps.verify.reason; }],
]) test('v2 rejects ' + name, t => {
  const rows = flowRows(); mutate(rows);
  const root = ledger(t, 'run-flow', rows);
  assert.throws(() => verifyKeelRun({ task: V2_TASK, root, runId: 'run-flow', validatedHead: HEAD, verification: V2_VERIFICATION }), /KEEL_RUN_REQUIRED/);
});
test('v2 code repair binds the helper validation receipt', t => {
  const codeTask = { ...V2_TASK, feedback: [{ key: 'r1', source: 'greptile', user: { login: 'greptile-apps', __typename: 'Bot' }, body: 'P1: broken', category: 'actionable-fix' }] };
  const rows = flowRows();
  rows[0].summary = 'start bug-fix（user）depth=1';
  Object.assign(rows[3].evidence, { playbook: 'bug-fix', manualPath: 'pstack/skills/poteto-mode/playbooks/bug-fix.md' });
  rows[3].evidence.steps.verify = { head: HEAD, receiptSha256: 'd'.repeat(64) };
  const root = ledger(t, 'run-flow', rows);
  const args = { task: codeTask, root, runId: 'run-flow', validatedHead: HEAD,
    verification: { status: 'pass', head: HEAD, receiptSha256: 'd'.repeat(64) } };
  assert.equal(verifyKeelRun(args).status, 'verified');
  assert.throws(() => verifyKeelRun({ ...args, verification: { ...args.verification, receiptSha256: 'e'.repeat(64) } }), /KEEL_RUN_REQUIRED/);
});


test('Keel gate reports disabled when no ledger root is configured', () => {
  assert.deepEqual(verifyKeelRun({ task, runId: undefined, root: null }), { status: 'disabled' });
});

test('Keel gate does not apply to tasks dispatched before the Keel prompt', (t) => {
  const root = ledger(t, 'run-x', []);
  assert.deepEqual(verifyKeelRun({ task: { ...task, keelFlow: undefined }, runId: undefined, root }), { status: 'not-required-legacy-task' });
});

test('Keel gate rejects a binding row written before the task existed', (t) => {
  const root = ledger(t, 'run-old', [{ at: '2026-10-06T00:59:59.000Z', kind: 'step', summary: 'vigil task=live-7-x' }]);
  assert.throws(() => verifyKeelRun({ task, runId: 'run-old', root }), /KEEL_RUN_REQUIRED.*after the task was created/);
});

test('Keel gate rejects run ids that could escape the ledger directory', (t) => {
  const root = ledger(t, 'run-a', []);
  assert.throws(() => verifyKeelRun({ task, runId: '../run-a', root }), /KEEL_RUN_REQUIRED/);
});

test('Keel gate accepts a run bound to this task and counts its decisions', (t) => {
  const root = ledger(t, 'run-ok', [
    { at: '2026-10-06T01:00:01.000Z', kind: 'decision', summary: 'J4 severity' },
    { at: '2026-10-06T01:00:02.000Z', kind: 'step', summary: 'vigil task=live-7-x' },
  ]);
  assert.deepEqual(verifyKeelRun({ task, runId: 'run-ok', root }), { status: 'verified', runId: 'run-ok', rows: 2, decisions: 1, contractVersion: 1 });
});

test('prepare CI excerpts keep only ##[error] lines, once per workflow run', () => {
  const calls = [];
  const ghFn = (_bin, args) => {
    calls.push(args);
    if (args[2] === '11') return 'unit\tstep\tok line\nunit\tstep\t##[error]expected 1 got 2\n';
    throw new Error('log expired');
  };
  const out = ciErrorExcerpts({ repo: REPO, prSnapshot: { failingChecks: [
    { name: 'unit', link: `https://github.com/${REPO}/actions/runs/11/job/1` },
    { name: 'lint', link: `https://github.com/${REPO}/actions/runs/11/job/2` },
    { name: 'e2e', link: `https://github.com/${REPO}/actions/runs/12/job/3` },
    { name: 'ext', link: 'https://example.invalid/check' },
  ] } }, ghFn);
  assert.deepEqual(calls, [['run', 'view', '11', '--repo', REPO, '--log-failed'], ['run', 'view', '12', '--repo', REPO, '--log-failed']]);
  assert.deepEqual(out, [{ runId: '11', errors: ['unit\tstep\t##[error]expected 1 got 2'] }, { runId: '12', error: 'log expired' }]);
});

test('dispatch message runs the Keel flow instead of the goal skill', () => {
  const message = dispatchParams({
    pr: { number: 7, id: 'PR_7', headRefOid: HEAD, title: 't' }, mapping: {},
    fresh: [{ key: 'review:r1', source: 'review', nativeId: 'r1', revision: 't', sha: HEAD, body: '**P1** bug', category: 'actionable-fix' }],
    now: '2026-10-06T01:00:00Z', taskPath: '/tmp/home/state/tasks/live-7-x.json', home: '/tmp/home',
  }).message;
  assert.match(message, /KEEL_FLOW/);
  assert.match(message, /summary:"vigil task=live-7-x"/);
  assert.match(message, /--keel-run <Keel run_id>/);
  assert.match(message, /禁止 pr_status、pr_wait、pr_reply/);
  assert.match(message, /ciErrors/);
  assert.doesNotMatch(message, /goal skill 执行|--until-sc|kind: pr-fix/);
});

test('retried dispatch keeps the Keel binding for the recomputed task', () => {
  const params = constrainRetryDispatch({ message: '旧消息\nOWNER_STANDING_AUTH: PR_PUSH_AND_REPLY' },
    { dispatchId: 'live-7-x', headRefOid: HEAD, feedback: [] });
  assert.match(params.message, /vigil task=live-7-x/);
  assert.doesNotMatch(params.message, /goal 修复流程/);
});
