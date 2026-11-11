// The pre-push self-review pilot (preflightSelfReview). Off by default: nothing a session is sent, and nothing
// finalize asks for, changes until the switch is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchParams, SELF_REVIEW_RULE, selfReviewRequired, selfReviewConfigProblem, withConfigProblems } from './bin/mivo-watcher.mjs';
import { validateSelfReview } from './bin/mivo-repair.mjs';
import { preflightSelfReviewEnabled } from './bin/profile.mjs';

const HEAD = 'a'.repeat(40);
const pr = { id: 'PR_1', number: 1, headRefOid: HEAD, headRefName: 'fix/x', title: 't' };
const fixable = [{ key: 'greptile:1', source: 'greptile', nativeId: '1', sha: HEAD, body: '**P1** bug', category: 'actionable-fix' }];
const replyOnly = [{ key: 'greptile:2', source: 'greptile', nativeId: '2', sha: HEAD, body: '**P3** wording', category: 'reply-resolve' }];
const message = (fresh) => dispatchParams({ pr, mapping: {}, fresh, now: '2026-11-11T00:00:00Z', taskPath: 'state/tasks/task.json', home: 'watch-home' }).message;
function withSwitch(t, value) {
  const before = process.env.MIVO_PREFLIGHT_SELF_REVIEW;
  if (value === undefined) delete process.env.MIVO_PREFLIGHT_SELF_REVIEW; else process.env.MIVO_PREFLIGHT_SELF_REVIEW = value;
  t.after(() => { if (before === undefined) delete process.env.MIVO_PREFLIGHT_SELF_REVIEW; else process.env.MIVO_PREFLIGHT_SELF_REVIEW = before; });
}

test('the switch is off unless set, takes true/false only, and names the field when it is something else', () => {
  assert.equal(preflightSelfReviewEnabled({}), false);
  for (const on of ['true', '1']) assert.equal(preflightSelfReviewEnabled({ MIVO_PREFLIGHT_SELF_REVIEW: on }), true);
  for (const off of ['false', '0']) assert.equal(preflightSelfReviewEnabled({ MIVO_PREFLIGHT_SELF_REVIEW: off }), false);
  assert.throws(() => preflightSelfReviewEnabled({ MIVO_PREFLIGHT_SELF_REVIEW: 'yes' }), /preflightSelfReview.*MIVO_PREFLIGHT_SELF_REVIEW.*"yes"/);
});

test('off: the dispatch message is the same with the switch unset and set to false, and has no self-review rule', (t) => {
  withSwitch(t, undefined);
  const unset = message(fixable);
  process.env.MIVO_PREFLIGHT_SELF_REVIEW = 'false';
  assert.equal(message(fixable), unset);
  assert.ok(!unset.includes(SELF_REVIEW_RULE));
  assert.doesNotMatch(unset, /推送前自审/);
});

test('on: a round that may change code gets the rule (own diff only, at most 2 passes, the record to write); a no-code round does not', (t) => {
  withSwitch(t, 'true');
  const sent = message(fixable);
  assert.ok(sent.includes(SELF_REVIEW_RULE));
  assert.match(SELF_REVIEW_RULE, /范围只限 git diff <任务 head>\.\.HEAD/);
  assert.match(SELF_REVIEW_RULE, /最多 2 遍/);
  assert.match(SELF_REVIEW_RULE, /P3 不修/);
  assert.match(SELF_REVIEW_RULE, /selfReview:\{passes:/);
  assert.ok(!message(replyOnly).includes(SELF_REVIEW_RULE));
});

test('whether a round is asked is decided once at dispatch; a switch that is not a boolean counts as off and stops nothing', (t) => {
  withSwitch(t, 'true');
  assert.equal(selfReviewRequired({ headRefOid: HEAD, fresh: fixable }), true);
  assert.equal(selfReviewRequired({ headRefOid: HEAD, fresh: replyOnly }), false);
  process.env.MIVO_PREFLIGHT_SELF_REVIEW = 'yes';
  assert.equal(selfReviewRequired({ headRefOid: HEAD, fresh: fixable }), false);
  assert.ok(!message(fixable).includes(SELF_REVIEW_RULE), 'the scan goes on without the rule');
  assert.match(selfReviewConfigProblem(), /preflightSelfReview.*"yes"/, 'what the scan puts into its run result');
  process.env.MIVO_PREFLIGHT_SELF_REVIEW = 'true';
  assert.equal(selfReviewConfigProblem(), null);
});

test('finalize asks for the record only when the task asked for it and the round has commits', () => {
  const asked = { required: true, changed: true };
  assert.equal(validateSelfReview(undefined, { required: false, changed: true }), null, 'the task did not ask');
  assert.equal(validateSelfReview(undefined, { required: true, changed: false }), null, 'no commit: a title or body fix has no diff to review');
  assert.deepEqual(validateSelfReview({ passes: 2, found: 3, fixed: 3 }, asked), { passes: 2, found: 3, fixed: 3 });
  assert.deepEqual(validateSelfReview({ passes: 1, found: 0, fixed: 0 }, asked), { passes: 1, found: 0, fixed: 0 });
  assert.throws(() => validateSelfReview(undefined, asked), /\[SELF_REVIEW_MISSING\].*expected: selfReview.*actual: null/);
  for (const bad of [{ passes: 3, found: 1, fixed: 1 }, { passes: 1, found: 1, fixed: 2 }, { passes: 1, found: -1, fixed: 0 }, { passes: 1 }, 'done']) {
    assert.throws(() => validateSelfReview(bad, asked), /\[SELF_REVIEW_MISSING\]/, JSON.stringify(bad));
  }
});

test('a message rendered again for an existing task follows the task, not the switch as it is now', (t) => {
  const render = (selfReview) => dispatchParams({ pr, mapping: {}, fresh: fixable, now: '2026-11-11T00:00:00Z', taskPath: 'state/tasks/task.json', home: 'watch-home', selfReview }).message;
  withSwitch(t, 'false');
  assert.ok(render(true).includes(SELF_REVIEW_RULE), 'the task was asked while the switch was on');
  process.env.MIVO_PREFLIGHT_SELF_REVIEW = 'true';
  assert.ok(!render(false).includes(SELF_REVIEW_RULE), 'the task was not asked');
});

test('an unreadable switch is said in the run result of every mode, with the field name; a readable one adds nothing', (t) => {
  withSwitch(t, 'yes');
  for (const result of [{ mode: 'discover', prs: [], events: [] }, { mode: 'poll', prs: [] }, { mode: 'enabled', prs: [], events: [{ kind: 'other' }] }]) {
    const out = withConfigProblems(result);
    const event = out.events.at(-1);
    assert.deepEqual([event.kind, event.field, event.treatedAs], ['config-invalid', 'preflightSelfReview', 'off'], result.mode);
    assert.equal(out.events.length, (result.events?.length ?? 0) + 1);
  }
  process.env.MIVO_PREFLIGHT_SELF_REVIEW = 'true';
  const untouched = { mode: 'discover', prs: [], events: [] };
  assert.equal(withConfigProblems(untouched), untouched);
});
