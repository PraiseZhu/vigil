import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDispatchGate, feedbackItems, newFeedback, processPr, rulesVersion, watcherPaths, REPO } from './bin/mivo-watcher.mjs';
import { handoffPr, handoffReceipt } from './handoff.fixture.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const COMMENT = { id: 101, body: 'P1: example finding', user: { login: 'ExampleReviewer', type: 'User' }, updated_at: '2026-10-28T06:00:00Z' };

function drive(gen) { let step = gen.next(); while (!step.done) step = gen.next(step.value()); return step.value; }

test('readDispatchGate fails closed on MERGED, CLOSED, invalid JSON and identity mismatch', () => {
  const pr = { id: 'PR_790', number: 790 };
  assert.deepEqual(drive(readDispatchGate({ pr, ghFn: () => JSON.stringify({ id: 'PR_790', state: 'MERGED' }) })),
    { ok: false, reason: 'pr-not-open-before-dispatch', state: 'MERGED' });
  assert.equal(drive(readDispatchGate({ pr, ghFn: () => JSON.stringify({ id: 'PR_790', state: 'CLOSED' }) })).state, 'CLOSED');
  assert.equal(drive(readDispatchGate({ pr, ghFn: () => 'not json' })).reason, 'pr-state-unavailable-before-dispatch');
  assert.equal(drive(readDispatchGate({ pr, ghFn: () => JSON.stringify({ id: 'PR_OTHER', state: 'OPEN' }) })).reason, 'pr-state-unavailable-before-dispatch');
  assert.deepEqual(drive(readDispatchGate({ pr, ghFn: () => JSON.stringify({ id: 'PR_790', state: 'OPEN' }) })), { ok: true, state: 'OPEN' });
});

function harness(t, { collectedState = 'MERGED', includeCollectedPr = true, gateState = 'CLOSED' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-gate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  const pr = handoffPr({ id: 'PR_790', number: 790, headRefOid: HEAD, headRefName: 'fix/x', releaseEpoch: 'e' });
  const items = feedbackItems({ pr, comments: [COMMENT] });
  const feedback = newFeedback({}, items).fresh;
  const previous = { number: 790, nodeId: 'PR_790', sessionId: 'sess-790', eligibility: 'active', eligibilityInitialized: true,
    admissionVerified: true, admissionEpoch: pr.releaseEpoch, wasDraft: false, headRefOid: HEAD, headRefName: 'fix/x',
    rulesVersion: rulesVersion(), url: 'u', feedbackCursor: {}, handoff: handoffReceipt(pr) };
  const state = { version: 2, repo: REPO, prs: { PR_790: previous } };
  const collected = { pr: { ...pr, state: collectedState }, admissionVerified: true, mergeReady: false,
    comments: [COMMENT], reviews: [], threads: [], labels: [], checks: [], requiredChecks: [],
    ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] }, mergeable: 'MERGEABLE' };
  if (!includeCollectedPr) delete collected.pr;
  const sent = [];
  const report = [];
  const events = [];
  const gen = processPr({ pr, state, paths, now: '2026-10-28T07:00:00Z', events, report, viewer: 'owner', dryRun: false,
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-790' }; },
    collect: () => collected, recheckFn: () => {},
    ghFn: (args) => args[0] === 'pr' && args[1] === 'view' ? JSON.stringify({ id: 'PR_790', state: gateState }) : '{}',
    ownershipSnapshot: function* () { return { pr: { ...pr, author: { login: 'owner' } } }; },
    remaining: () => 120000, deadline: Date.now() + 120000, clock: Date.now, allowCreate: false, keelRoot: '/tmp' });
  drive(gen);
  return { sent, report, entry: state.prs.PR_790, feedback };
}

test('processPr does not dispatch when the freshly collected PR is MERGED or CLOSED', (t) => {
  for (const state of ['MERGED', 'CLOSED']) {
    const h = harness(t, { collectedState: state });
    assert.equal(h.sent.length, 0);
    assert.equal(h.report[0].dispatch.reason, 'ownership-no-longer-released');
    assert.equal(h.report[0].dispatch.attempted, false);
    assert.deepEqual(h.entry.feedbackCursor, {});
    assert.equal(Boolean(h.entry.pendingDispatch), false);
  }
});

test('processPr still dispatches an OPEN PR', (t) => {
  const open = harness(t, { collectedState: 'OPEN', gateState: 'OPEN' });
  assert.equal(open.sent.length, 1);
  assert.equal(open.report[0].dispatch.attempted, true);
});

