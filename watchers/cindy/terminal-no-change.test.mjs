import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalize, repairPaths, REPO } from './bin/cindy-repair.mjs';
import { consumeResult, isTerminalNoChangeResult } from './bin/cindy-watcher.mjs';
import { fixedThreads, refutedThreads } from './bin/cindy-review-resolve.mjs';
import { writePr } from './bin/cindy-state.mjs';

const HEAD = 'a'.repeat(40);
const DISPATCH = 'live-7-terminal';

function fixture(t, prState) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-terminal-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = repairPaths(home);
  fs.mkdirSync(paths.tasks, { recursive: true });
  const task = { dispatchId: DISPATCH, nodeId: 'PR_7', number: 7, repo: REPO,
    headRepo: 'ExampleUser/cindy-fork', headOwner: 'ExampleUser', sessionId: 'sess-7',
    headRefOid: HEAD, headRefName: 'fix/x', feedback: [] };
  const taskPath = path.join(paths.tasks, DISPATCH + '.json');
  fs.writeFileSync(taskPath, JSON.stringify(task));
  writePr(home, 'PR_7', { number: 7, nodeId: 'PR_7', sessionId: 'sess-7', activeTask: { dispatchId: DISPATCH } });
  const scReport = path.join(home, 'sc.json');
  fs.writeFileSync(scReport, JSON.stringify({ scs: [{ id: 'SC1', status: 'no-change', evidence: ['PR 已关闭，未修改'], feedbackKeys: [] }], workers: null }));
  const calls = [];
  const ghFn = (binary, args) => {
    calls.push(args.join(' '));
    return JSON.stringify({ id: 'PR_7', state: prState, isDraft: false, headRefOid: HEAD, headRefName: 'fix/x', baseRefOid: 'b'.repeat(40) });
  };
  return { home, paths, task, taskPath, scReport, calls, ghFn };
}

test('finalize closes an all-no-change task after the PR closed, without pushing or rerunning CI', (t) => {
  const f = fixture(t, 'CLOSED');
  const result = finalize({ home: f.home, taskPath: f.taskPath, scReport: f.scReport, validatedHead: HEAD,
    ghFn: f.ghFn, gitFn: () => '', keelRoot: '/tmp' });
  assert.equal(result.status, 'complete');
  assert.equal(result.completionKind, 'pr-terminal-no-change');
  assert.equal(result.terminalPr.state, 'CLOSED');
  assert.equal(result.terminalPr.checkout, 'missing-after-close');
  assert.equal(result.ci.status, 'not-run');
  assert.equal(result.pushed, false);
  assert.equal(result.reason, 'pr-closed-no-change');
  assert.equal(f.calls.some((call) => /push|rerun|comment|resolve/.test(call)), false);
  const consumed = consumeResult({ nodeId: 'PR_7', sessionId: 'sess-7', activeTask: { dispatchId: DISPATCH, sessionId: 'sess-7' } }, result, 'now');
  assert.equal(consumed.activeTask.status, 'complete');
  assert.equal(consumed.activeTask.completionKind, 'pr-terminal-no-change');
  assert.equal(consumed.feedbackLedger, undefined);
  assert.deepEqual(fixedThreads(result, { dispatchId: DISPATCH, repairPolicy: { items: [] } }), []);
  assert.deepEqual(refutedThreads(result, { dispatchId: DISPATCH, repairPolicy: { items: [] } }), []);
});

test('terminal finalize rejects a pass SC and consumeResult rejects a forged terminal receipt', (t) => {
  const f = fixture(t, 'MERGED');
  const bad = path.join(f.home, 'bad-sc.json');
  fs.writeFileSync(bad, JSON.stringify({ scs: [{ id: 'SC1', status: 'pass', evidence: ['fixed'], feedbackKeys: [] }] }));
  assert.throws(() => finalize({ home: f.home, taskPath: f.taskPath, scReport: bad, validatedHead: HEAD,
    ghFn: f.ghFn, gitFn: () => '', keelRoot: '/tmp' }), /REPAIR_SCOPE_NO_CODE|TERMINAL_NO_CHANGE_ONLY/);
  const forged = {
    schemaVersion: 2, kind: 'cindy-repair-result', status: 'complete', completionKind: 'pr-terminal-no-change',
    dispatchId: DISPATCH, nodeId: 'PR_7', number: 7, repo: REPO, sessionId: 'sess-7',
    head: HEAD, sourceHead: HEAD, verification: { status: 'not-required-no-change', head: HEAD, localTests: 'not-run', reason: 'x' },
    terminalPr: { nodeId: 'PR_7', number: 7, repo: REPO, state: 'MERGED', head: HEAD, checkedAt: new Date().toISOString(), checkout: 'missing-after-close' },
    ci: { status: 'not-run', head: HEAD, requiredGreen: false, reason: 'pr-terminal' },
    scs: [{ status: 'pass' }], feedbackCoverage: { complete: true }, pushed: false, prReady: false, reason: 'pr-merged-no-change',
  };
  assert.equal(isTerminalNoChangeResult(forged), false);
  assert.throws(() => consumeResult({ nodeId: 'PR_7', sessionId: 'sess-7' }, forged, 'now'), /terminal completion receipt is invalid/);
});

