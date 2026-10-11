import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KEEL_FLOW_VERSION, ciErrorExcerpts, keelRunIdFor, verifyKeelRun } from './bin/mivo-repair.mjs';
import { constrainRetryDispatch, dispatchParams } from './bin/mivo-watcher.mjs';

const HEAD = 'a'.repeat(40);
const REPO = 'example-org/example-plugin';

function ledger(t, runId, rows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-keel-'));
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

// ---- Keel flow v3: fixed run_id, ledger created by the first pstack_decide(op:"decide") ----
// The rows below have the shape current Keel writes: row_id "<run>#<n>", a decision row that
// carries template/state_sha256/answer/policy, and a hand-written step/evidence via op:"log".
const V3_ID = 'live-7-2026-10-06T01:00:00.000Z';
const V3_TASK = { ...task, dispatchId: V3_ID, keelFlowVersion: 3, headRefOid: HEAD, feedback: [] };
const V3_RUN = keelRunIdFor(V3_ID);
function v3Rows() {
  const row = (second, extra) => ({ run_id: V3_RUN, at: `2026-10-06T01:00:0${second}.000Z`, ...extra });
  return [
    row(1, { row_id: `${V3_RUN}#1`, kind: 'decision', summary: 'J4 审查发现统一分级：act P2', template: 'J4',
      state_sha256: 'b'.repeat(64), answer: 'P2', confidence: 0.9, policy: 'act' }),
    row(2, { row_id: `${V3_RUN}#2`, kind: 'step', summary: `vigil task=${V3_ID}` }),
    row(3, { row_id: `${V3_RUN}#3`, kind: 'evidence', summary: `vigil flow task=${V3_ID}`,
      evidence: { kind: 'vigil-flow', version: 3, taskId: V3_ID, head: HEAD, playbook: 'investigation',
        manualPath: 'pstack/skills/poteto-mode/playbooks/investigation.md', decisionRowIds: [`${V3_RUN}#1`],
        steps: { reproduce: 'Investigated the reported behavior', repair: 'No change required',
          verify: { status: 'not-run', reason: 'No code changed' } } } }),
  ];
}
const v3Args = (root, extra = {}) => ({ task: V3_TASK, root, runId: V3_RUN, validatedHead: HEAD, verification: V2_VERIFICATION, ...extra });

test('Keel flow version is 3 and new tasks are keyed to it', () => {
  assert.equal(KEEL_FLOW_VERSION, 3);
});

test('keelRunIdFor is stable, Keel-shaped and unique per task', () => {
  assert.equal(keelRunIdFor(V3_ID), keelRunIdFor(V3_ID));
  assert.match(keelRunIdFor(V3_ID), /^run-20261006010000-[a-f0-9]{6}$/);
  assert.notEqual(keelRunIdFor(V3_ID), keelRunIdFor('live-7-2026-10-06T01:00:00.001Z'));
  assert.notEqual(keelRunIdFor('live-7-2026-10-06T01:00:00.000Z'), keelRunIdFor('dry-7-2026-10-06T01:00:00.000Z'));
  assert.match(keelRunIdFor('live-7-x'), /^run-vigil-[a-f0-9]{6}$/);
  assert.match(keelRunIdFor('live-1234-2026-10-11T07:00:00.928Z'), /^run-20261011070000-[a-f0-9]{6}$/);
});

test('v3 accepts a ledger shaped like current Keel output: decide creates it, no start row', t => {
  const root = ledger(t, V3_RUN, v3Rows());
  const out = verifyKeelRun(v3Args(root));
  assert.deepEqual(out, { status: 'verified', runId: V3_RUN, rows: 3, decisions: 1, contractVersion: 3 });
});

test('v3 does not require the pstack_start row that v2 needed', t => {
  const rows = v3Rows();
  assert.ok(!rows.some(row => String(row.summary).startsWith('start ')));
  assert.equal(verifyKeelRun(v3Args(ledger(t, V3_RUN, rows))).status, 'verified');
});

test('v3 rejects a missing ledger root and a run id other than the task fixed one', t => {
  assert.throws(() => verifyKeelRun({ task: V3_TASK, root: null }), /KEEL_RUN_REQUIRED/);
  const root = ledger(t, 'run-other', v3Rows().map(row => ({ ...row, run_id: 'run-other' })));
  assert.throws(() => verifyKeelRun(v3Args(root, { runId: 'run-other' })), /KEEL_RUN_REQUIRED.*run_id must be/);
});

const NO_BINDING = /KEEL_RUN_REQUIRED.*exact task binding row is required/;
const BAD_DECISION = /KEEL_RUN_REQUIRED.*referenced task decision is missing or incomplete/;
const BAD_EVIDENCE = /KEEL_RUN_REQUIRED.*current HEAD flow evidence and playbook are required/;
for (const [name, mutate, reason] of [
  ['a missing task binding', r => { r.splice(1, 1); }, NO_BINDING],
  ['a binding for another task', r => { r[1].summary += '-other'; }, NO_BINDING],
  ['a hand-written decision (no state hash)', r => { delete r[0].state_sha256; }, BAD_DECISION],
  ['a decision without an answer (Jev failed)', r => { r[0].answer = null; }, BAD_DECISION],
  ['only a startup decision (J2)', r => { r[0].template = 'J2'; }, BAD_DECISION],
  ['evidence for another HEAD', r => { r[2].evidence.head = 'c'.repeat(40); }, BAD_EVIDENCE],
  ['v2 evidence on a v3 task', r => { r[2].evidence.version = 2; }, BAD_EVIDENCE],
  ['evidence that predates the binding', r => { r[2].at = '2026-10-06T01:00:01.500Z'; }, /KEEL_RUN_REQUIRED.*flow evidence predates task binding/],
  ['a decision written after the evidence', r => { r[0].at = '2026-10-06T01:00:09.000Z'; }, BAD_DECISION],
  ['a decision row that is not in this run', r => { r[0].run_id = 'run-other'; }, BAD_DECISION],
  ['rows written before the task existed', r => { for (const row of r) row.at = '2026-10-06T00:59:00.000Z'; }, NO_BINDING],
  ['empty investigation evidence', r => { r[2].evidence.steps.reproduce = ''; }, /KEEL_RUN_REQUIRED.*reproduction\/investigation and disposition evidence are required/],
  ['skipped tests without a reason', r => { delete r[2].evidence.steps.verify.reason; }, /KEEL_RUN_REQUIRED.*no-change flow must explain why local tests were not run/],
]) test('v3 rejects ' + name, t => {
  const rows = v3Rows(); mutate(rows);
  assert.throws(() => verifyKeelRun(v3Args(ledger(t, V3_RUN, rows))), reason);
});

test('v3 code repair binds the helper validation receipt', t => {
  const codeTask = { ...V3_TASK, feedback: [{ key: 'r1', source: 'greptile', user: { login: 'greptile-apps', __typename: 'Bot' }, body: 'P1: broken', category: 'actionable-fix' }] };
  const rows = v3Rows();
  Object.assign(rows[2].evidence, { playbook: 'bug-fix', manualPath: 'pstack/skills/poteto-mode/playbooks/bug-fix.md' });
  rows[2].evidence.steps.verify = { head: HEAD, receiptSha256: 'd'.repeat(64) };
  const root = ledger(t, V3_RUN, rows);
  const args = v3Args(root, { task: codeTask, verification: { status: 'pass', head: HEAD, receiptSha256: 'd'.repeat(64) } });
  assert.equal(verifyKeelRun(args).contractVersion, 3);
  assert.throws(() => verifyKeelRun({ ...args, verification: { ...args.verification, receiptSha256: 'e'.repeat(64) } }), /KEEL_RUN_REQUIRED/);
});

test('v1 and v2 tasks keep their own contract after v3 exists', t => {
  const root = ledger(t, 'run-flow', flowRows());
  assert.equal(verifyKeelRun({ task: V2_TASK, root, runId: 'run-flow', validatedHead: HEAD, verification: V2_VERIFICATION }).contractVersion, 2);
  // only v3 pins the run id; a v1 task may keep any run id
  assert.equal(verifyKeelRun({ task: { ...task, keelFlowVersion: undefined }, runId: 'run-ok', root: ledger(t, 'run-ok', [
    { at: '2026-10-06T01:00:02.000Z', kind: 'step', summary: 'vigil task=live-7-x' }]) }).contractVersion, 1);
});

test('default dispatch message is the v3 flow: fixed run_id, decide first, no pstack_start or pstack_ledger', () => {
  const message = dispatchParams({
    pr: { number: 7, id: 'PR_7', headRefOid: HEAD, title: 't' }, mapping: {},
    fresh: [{ key: 'review:r1', source: 'review', nativeId: 'r1', revision: 't', sha: HEAD, body: '**P1** bug', category: 'actionable-fix' }],
    now: '2026-10-06T01:00:00Z', taskPath: '/tmp/home/state/tasks/live-7-2026-10-06T01:00:00.000Z.json', home: '/tmp/home',
  }).message;
  assert.match(message, /KEEL_FLOW_VERSION=3/);
  assert.ok(message.includes(`Keel run_id 固定为 ${V3_RUN}`));
  assert.ok(message.includes(`--keel-run ${V3_RUN}`));
  assert.match(message, /pstack_decide\(\{op:"decide",template:"J4"/);
  assert.match(message, /不能先 log/);
  assert.match(message, /summary:"vigil task=live-7-2026-10-06T01:00:00.000Z"/);
  assert.match(message, /version:3/);
  assert.match(message, /keel-unavailable/);
  assert.doesNotMatch(message, /pstack_ledger/);
  assert.doesNotMatch(message, /pstack_start\(/);
  assert.doesNotMatch(message, /start_team/);
  // the tools that would spawn a worktree or a graph run are named only to be forbidden
  assert.match(message, /不要调用 pstack_start、keel_run、keel_report、keel_wait、keel_gate、keel_status/);
});

test('a v2 dispatch keeps its original wording so cached prompts and tests stay valid', () => {
  const message = dispatchParams({
    pr: { number: 7, id: 'PR_7', headRefOid: HEAD, title: 't' }, mapping: {},
    fresh: [{ key: 'review:r1', source: 'review', nativeId: 'r1', revision: 't', sha: HEAD, body: '**P1** bug', category: 'actionable-fix' }],
    now: '2026-10-06T01:00:00Z', taskPath: '/tmp/home/state/tasks/live-7-x.json', home: '/tmp/home', keelVersion: 2,
  }).message;
  assert.match(message, /KEEL_FLOW_VERSION=2/);
  assert.match(message, /pstack_ledger\(\{op:"log"/);
  assert.match(message, /--keel-run <Keel run_id>/);
});

test('a retried v3 task keeps its fixed run id', () => {
  const params = constrainRetryDispatch({ message: '旧消息\nOWNER_STANDING_AUTH: PR_PUSH_AND_REPLY' },
    { dispatchId: V3_ID, keelFlowVersion: 3, headRefOid: HEAD, feedback: [] });
  assert.ok(params.message.includes(`Keel run_id 固定为 ${V3_RUN}`));
  assert.doesNotMatch(params.message, /pstack_ledger/);
});
