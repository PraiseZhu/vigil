// The pre-push self-review pilot (preflightSelfReview). Off by default: nothing a session is sent, and nothing
// finalize asks for, changes until the switch is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchParams, SELF_REVIEW_RULE } from './bin/mivo-watcher.mjs';
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

test('finalize asks for the record only when the switch is on and the round changed code', () => {
  const changed = { scs: [{ id: 'SC1', status: 'pass' }] };
  const unchanged = { scs: [{ id: 'SC1', status: 'no-change' }] };
  assert.equal(validateSelfReview(changed, { enabled: false }), null);
  assert.equal(validateSelfReview(unchanged, { enabled: true }), null);
  assert.deepEqual(validateSelfReview({ ...changed, selfReview: { passes: 2, found: 3, fixed: 3 } }, { enabled: true }), { passes: 2, found: 3, fixed: 3 });
  assert.deepEqual(validateSelfReview({ ...changed, selfReview: { passes: 1, found: 0, fixed: 0 } }, { enabled: true }), { passes: 1, found: 0, fixed: 0 });
  assert.throws(() => validateSelfReview(changed, { enabled: true }), /\[SELF_REVIEW_MISSING\].*expected: selfReview.*actual: null/);
  for (const bad of [{ passes: 3, found: 1, fixed: 1 }, { passes: 1, found: 1, fixed: 2 }, { passes: 1, found: -1, fixed: 0 }, { passes: 1 }, 'done']) {
    assert.throws(() => validateSelfReview({ ...changed, selfReview: bad }, { enabled: true }), /\[SELF_REVIEW_MISSING\]/, JSON.stringify(bad));
  }
  assert.throws(() => validateSelfReview([{ id: 'SC1', status: 'pass' }], { enabled: true }), /\[SELF_REVIEW_MISSING\]/, 'a bare array has nowhere to carry the record');
});
