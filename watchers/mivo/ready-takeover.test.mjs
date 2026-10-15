import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackRepairPolicy, isMemberThread } from './bin/mivo-feedback-policy.mjs';
import { refutedThreads, closeRefutedThreads } from './bin/mivo-review-resolve.mjs';
import { implicitHandoff, isCurrentHandoff } from './bin/mivo-handoff.mjs';

const HEAD = 'a'.repeat(40);
const thread = (extra) => ({ source: 'thread', threadId: 'PRRT_example', nativeId: 'PRRT_example:1', sha: HEAD,
  body: '这里会丢数据吗？', user: { login: 'ExampleMember' }, ...extra });

// A member's review thread blocks the merge and the pre-review until resolved; it used to stay open forever.
test('a member review thread goes to the session for grading; outsiders and bots do not', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const policy = feedbackRepairPolicy(thread({ authorAssociation: association }), { headSha: HEAD });
    assert.equal(policy.action, 'code-fix', association);
    assert.equal(policy.reason, 'member-thread-triage');
  }
  assert.equal(feedbackRepairPolicy(thread({ authorAssociation: 'NONE' }), { headSha: HEAD }).action, 'needs-triage');
  assert.equal(feedbackRepairPolicy(thread({ authorAssociation: 'MEMBER', user: { login: 'helper[bot]' } }), { headSha: HEAD }).action, 'needs-triage');
  assert.equal(feedbackRepairPolicy(thread({ authorAssociation: 'MEMBER', threadId: undefined }), { headSha: HEAD }).action, 'needs-triage', 'an issue comment does not block the merge');
  assert.equal(isMemberThread(thread({ authorAssociation: 'member' })), true);
});

test('a member thread the session graded as no-change is answered as a triage, not as a refuted P0/P1', () => {
  const key = 'thread:PRRT_example:1';
  const task = { dispatchId: 'task-1', repairPolicy: { items: [{ key, action: 'code-fix', reason: 'member-thread-triage' }] } };
  const result = { schemaVersion: 2, status: 'complete', dispatchId: 'task-1',
    feedbackCoverage: { dispositions: [{ key, disposition: 'no-change' }] },
    scs: [{ status: 'no-change', feedbackKeys: [key], evidence: ['这是命名建议（P3），不影响行为。'] }] };
  const items = refutedThreads(result, task);
  assert.equal(items.length, 1);
  assert.equal(items[0].triage, true);
  const calls = [];
  const run = closeRefutedThreads({ items, dispatchId: 'task-1', previous: {}, ghFn: args => { calls.push(args); return '{}'; }, now: 'n', head: HEAD });
  let next = run.next(); while (!next.done) next = run.next(next.value());
  const body = calls[0].find(arg => arg.startsWith('body=')).slice(5);
  assert.match(body, /按仓库统一分级核实/);
  assert.doesNotMatch(body, /P0\/P1 意见/);
  assert.equal(next.value.previous.autoClosedThreads.PRRT_example.reason, 'member-thread-no-change');
});

test('the implicit handoff binds the Ready epoch and head and passes the ownership check', () => {
  const pr = { repo: 'example-org/example-plugin', number: 3, id: 'PR_3', state: 'OPEN', isDraft: false, sameRepository: true,
    headRefOid: HEAD, createdAt: '2026-09-01T00:00:00Z', author: { login: 'ExampleUser' },
    releaseEpoch: 'ready:PR_3:READY_1:2026-09-02T00:00:00Z' };
  const receipt = implicitHandoff(pr);
  assert.equal(receipt.implicit, true);
  assert.equal(isCurrentHandoff(receipt, pr), true);
  assert.notEqual(implicitHandoff({ ...pr, headRefOid: 'b'.repeat(40) }).id, receipt.id);
  assert.equal(implicitHandoff({ ...pr, isDraft: true }), null);
  assert.equal(implicitHandoff({ ...pr, author: { login: 'helper[bot]' } }), null);
});
