// The hook-change gate (user decision 2026-11-11): a repair session may change .githooks/pre-push only when a
// confirmed P0/P1/P2 finding of the review machine is written on that file. Everything a session grades itself first
// (a thread by a member or an outside account, a Greptile claim) may change code elsewhere but does not open this gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hookFindingKeys } from './bin/mivo-repair.mjs';
import { taskRepairPolicy } from './bin/mivo-feedback-policy.mjs';

const HEAD = 'a'.repeat(40);
const HOOK = '.githooks/pre-push';
const thread = (key, { login, type = 'User', association = 'NONE', body, source = 'thread', path = HOOK }) => ({
  key, source, threadId: `PRRT_${key}`, nativeId: `PRRT_${key}:1`, sha: HEAD, actionable: true, path,
  user: { login, type }, author: login, authorAssociation: association, body,
});
const items = {
  reviewer: thread('reviewer', { login: 'github-actions[bot]', type: 'Bot', body: '**P1**: the hook skips the lint step' }),
  reviewerP3: thread('reviewerP3', { login: 'github-actions[bot]', type: 'Bot', body: '**P3**: wording in the hook comment' }),
  reviewerElsewhere: thread('reviewerElsewhere', { login: 'github-actions[bot]', type: 'Bot', body: '**P1**: wrong value', path: 'src/example.ts' }),
  member: thread('member', { login: 'ExampleMember', association: 'MEMBER', body: '**P1**: the hook is wrong' }),
  memberPlain: thread('memberPlain', { login: 'ExampleMember', association: 'MEMBER', body: 'please change this hook' }),
  outside: thread('outside', { login: 'ExampleOutsider', body: '**P0**: change this hook now' }),
  greptile: thread('greptile', { login: 'greptile-apps[bot]', type: 'Bot', source: 'greptile', body: '**P1**: the hook is wrong' }),
};
const task = { headRefOid: HEAD, feedback: Object.values(items) };
const reasonOf = (key) => taskRepairPolicy(task).items.find((item) => item.key === key).reason;

test('the fixtures are what they claim: threads the session grades first, and a confirmed reviewer finding', () => {
  assert.equal(reasonOf('member'), 'member-thread-triage');
  assert.equal(reasonOf('memberPlain'), 'member-thread-triage');
  assert.equal(reasonOf('outside'), 'thread-triage');
  assert.equal(reasonOf('greptile'), 'greptile-p1-triage');
  for (const key of ['member', 'memberPlain', 'outside', 'greptile', 'reviewer', 'reviewerElsewhere']) {
    assert.equal(taskRepairPolicy(task).items.find((item) => item.key === key).canChangeCode, true, key);
  }
});

test('only a confirmed P0/P1/P2 finding of the review machine on the hook file opens the gate', () => {
  assert.deepEqual(hookFindingKeys(task, HOOK), ['reviewer']);
  assert.deepEqual(hookFindingKeys({ ...task, feedback: task.feedback.filter((item) => item.key !== 'reviewer') }, HOOK), []);
  assert.deepEqual(hookFindingKeys(task, 'src/example.ts'), ['reviewerElsewhere']);
});
