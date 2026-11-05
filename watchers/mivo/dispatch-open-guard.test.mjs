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

// Same contract as the watcher's own driver: an effect that throws is thrown back into the generator.
function drive(gen) {
  let step = gen.next();
  while (!step.done) {
    let value;
    try { value = step.value(); } catch (error) { step = gen.throw(error); continue; }
    step = gen.next(value);
  }
  return step.value;
}

test('readDispatchGate fails closed on MERGED, CLOSED, invalid JSON and identity mismatch', () => {
  const pr = { id: 'PR_790', number: 790 };
  assert.deepEqual(drive(readDispatchGate({ pr, ghFn: () => JSON.stringify({ id: 'PR_790', state: 'MERGED' }) })),
    { ok: false, reason: 'pr-not-open-before-dispatch', state: 'MERGED' });
  assert.equal(drive(readDispatchGate({ pr, ghFn: () => JSON.stringify({ id: 'PR_790', state: 'CLOSED' }) })).state, 'CLOSED');
  assert.equal(drive(readDispatchGate({ pr, ghFn: () => 'not json' })).reason, 'pr-state-unavailable-before-dispatch');
  assert.equal(drive(readDispatchGate({ pr, ghFn: () => JSON.stringify({ id: 'PR_OTHER', state: 'OPEN' }) })).reason, 'pr-state-unavailable-before-dispatch');
  assert.deepEqual(drive(readDispatchGate({ pr, ghFn: () => JSON.stringify({ id: 'PR_790', state: 'OPEN' }) })), { ok: true, state: 'OPEN' });
});

// childPrs: what `repos/<repo>/pulls?state=open&base=<head branch>` lists; childPrList 'error' makes that read throw.
function harness(t, { collectedState = 'MERGED', includeCollectedPr = true, gateState = 'CLOSED', childPrs = [], childPrList = 'ok' } = {}) {
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
  const childPrReads = [];
  const gen = processPr({ pr, state, paths, now: '2026-10-28T07:00:00Z', events, report, viewer: 'owner', dryRun: false,
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-790' }; },
    collect: () => collected, recheckFn: () => {},
    ghFn: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_790', state: gateState });
      if (args[0] === 'api' && String(args[1]).startsWith(`repos/${REPO}/pulls?state=open&base=`)) {
        childPrReads.push(args);
        if (childPrList === 'error') throw new Error('HTTP 502');
        return JSON.stringify(childPrList === 'malformed' ? { message: 'not a list' } : [childPrs]);
      }
      return '{}';
    },
    ownershipSnapshot: function* () { return { pr: { ...pr, author: { login: 'owner' } } }; },
    remaining: () => 120000, deadline: Date.now() + 120000, clock: Date.now, allowCreate: false, keelRoot: '/tmp' });
  drive(gen);
  return { sent, report, entry: state.prs.PR_790, feedback, childPrReads };
}

// Shape of one item of the REST pulls listing, as far as the guard reads it.
const childPr = (number, overrides = {}) => ({ number, html_url: `https://github.com/${REPO}/pull/${number}`,
  head: { ref: 'vigil/pr-790-fix-aaaaaaaaaaaa', sha: HEAD, repo: { full_name: REPO } }, base: { ref: 'fix/x' }, ...overrides });

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

// 2026-11-05: a stage PR got a second, third ... fix PR for the same finding because every scan with unconsumed
// feedback dispatched again while the first child PR (vigil/pr-<N>-fix-*) was still open.
test('processPr holds the dispatch while a child PR into this head branch is open, and keeps the cursor', (t) => {
  const h = harness(t, { collectedState: 'OPEN', gateState: 'OPEN', childPrs: [childPr(801)] });
  assert.equal(h.sent.length, 0);
  assert.equal(h.report[0].dispatch.attempted, false);
  assert.equal(h.report[0].dispatch.reason, 'child-pr-open');
  assert.deepEqual(h.report[0].dispatch.childPrs, [801]);
  assert.equal(h.entry.lastDispatchGuard.reason, 'child-pr-open');
  assert.deepEqual(h.entry.feedbackCursor, {});
  assert.equal(Boolean(h.entry.pendingDispatch), false);
  assert.equal(h.childPrReads.length, 1);
  assert.equal(h.childPrReads[0][1].includes('base=fix%2Fx'), true);
});

test('processPr dispatches as usual when no child PR is open, and reads the list once', (t) => {
  const h = harness(t, { collectedState: 'OPEN', gateState: 'OPEN', childPrs: [] });
  assert.equal(h.sent.length, 1);
  assert.equal(h.report[0].dispatch.attempted, true);
  assert.equal(h.childPrReads.length, 1);
});

test('processPr ignores open PRs that are not this PR\'s child PRs', (t) => {
  const h = harness(t, { collectedState: 'OPEN', gateState: 'OPEN', childPrs: [
    childPr(802, { head: { ref: 'vigil/pr-791-fix-aaaaaaaaaaaa', sha: HEAD, repo: { full_name: REPO } } }),
    childPr(803, { head: { ref: 'feature/other', sha: HEAD, repo: { full_name: REPO } } }),
    childPr(804, { base: { ref: 'main' } }),
    childPr(805, { head: { ref: 'vigil/pr-790-fix-aaaaaaaaaaaa', sha: HEAD, repo: { full_name: 'example-fork/example-plugin' } } }),
    childPr(806, { head: { ref: 'vigil/pr-790-fix-bbbbbbbbbbbb', sha: HEAD, repo: null } }),
  ] });
  assert.equal(h.sent.length, 1);
  assert.equal(h.report[0].dispatch.attempted, true);
});

for (const childPrList of ['error', 'malformed']) {
  test(`processPr holds the dispatch when the child PR list is unreadable (${childPrList})`, (t) => {
    const h = harness(t, { collectedState: 'OPEN', gateState: 'OPEN', childPrList });
    assert.equal(h.sent.length, 0);
    assert.equal(h.report[0].dispatch.attempted, false);
    assert.equal(h.report[0].dispatch.reason, 'child-pr-check-unavailable');
    assert.equal(h.entry.lastDispatchGuard.reason, 'child-pr-check-unavailable');
    assert.deepEqual(h.entry.feedbackCursor, {});
    assert.equal(Boolean(h.entry.pendingDispatch), false);
  });
}
