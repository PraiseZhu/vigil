import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ciErrorExcerpts, verifyKeelRun } from './bin/mivo-repair.mjs';
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
  assert.deepEqual(verifyKeelRun({ task, runId: 'run-ok', root }), { status: 'verified', runId: 'run-ok', rows: 2, decisions: 1 });
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
