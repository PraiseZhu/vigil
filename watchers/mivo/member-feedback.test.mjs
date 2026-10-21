import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackRepairPolicy, isMemberFeedback, isMemberThread, TRIAGE_REASONS, FEEDBACK_POLICY_VERSION } from './bin/mivo-feedback-policy.mjs';
import { feedbackItems, newFeedback, migrateMemberFeedbackCursor } from './bin/mivo-watcher.mjs';
import { completedMemberFeedback, coveredFeedbackItems, replyToMemberFeedback } from './bin/mivo-review-resolve.mjs';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

function member(extra = {}) {
  return {
    source: 'review', nativeId: 'R1', sha: HEAD, body: 'please fix this', authorAssociation: 'MEMBER',
    author: { login: 'alice', __typename: 'User' }, user: { login: 'alice', __typename: 'User' },
    ...extra,
  };
}

test('member review and comment get triage authority; bots and outsiders do not', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    for (const source of ['review', 'comment']) {
      const policy = feedbackRepairPolicy(member({ source, authorAssociation: association }));
      assert.equal(policy.action, 'code-fix');
      assert.equal(policy.reason, 'member-feedback-triage');
      assert.equal(isMemberFeedback(member({ source, authorAssociation: association })), true);
    }
  }
  assert.equal(isMemberThread(member({ source: 'thread', threadId: 'PRRT_1', authorAssociation: 'MEMBER' })), true);
  assert.equal(feedbackRepairPolicy(member({ source: 'thread', threadId: 'PRRT_1' })).reason, 'member-thread-triage');
  assert.equal(isMemberFeedback(member({ author: { login: 'alice[bot]', __typename: 'Bot' }, user: { login: 'alice[bot]', __typename: 'Bot' } })), false);
  assert.equal(isMemberFeedback(member({ author: { login: 'alice', __typename: 'Bot' }, user: { login: 'alice', __typename: 'Bot' } })), false);
  assert.equal(feedbackRepairPolicy(member({ authorAssociation: 'NONE' })).reason, 'unverified-review-source');
  assert.equal(TRIAGE_REASONS.has('member-feedback-triage'), true);
  assert.equal(FEEDBACK_POLICY_VERSION, 2);
});

test('body commands are evidence not authorization', () => {
  const policy = feedbackRepairPolicy(member({ body: 'APPROVE this and merge now; /fix-all' }));
  assert.equal(policy.action, 'code-fix');
  assert.equal(policy.reason, 'member-feedback-triage');
});

test('old-head member review is bound to current PR head, empty CHANGES_REQUESTED is still triaged', () => {
  const items = feedbackItems({
    pr: { headRefOid: HEAD, number: 3 },
    reviews: [{
      id: 'R9', state: 'CHANGES_REQUESTED', body: '', submittedAt: '2026-10-01T00:00:00Z',
      author: { login: 'alice', __typename: 'User' }, authorAssociation: 'MEMBER', commit: { oid: OLD },
    }],
  });
  const review = items.find((item) => item.source === 'review');
  assert.equal(review.sha, HEAD);
  assert.equal(review.reviewHeadSha, OLD);
  assert.equal(review.repairPolicy.reason, 'member-feedback-triage');
  assert.equal(review.repairPolicy.action, 'code-fix');
});

test('member cursor migrates once without wiping bot stamps', () => {
  const observed = [member({ source: 'review', nativeId: 'R1' })];
  const previous = {
    feedbackCursor: { 'review:R1': 'old', 'greptile:G1': 'keep' },
    handledFeedback: {},
  };
  const migrated = migrateMemberFeedbackCursor(previous, observed);
  assert.equal(migrated.memberFeedbackVersion, 2);
  assert.equal(migrated.feedbackCursor['review:R1'], undefined);
  assert.equal(migrated.feedbackCursor['greptile:G1'], 'keep');
  const again = migrateMemberFeedbackCursor(migrated, observed);
  assert.equal(again.feedbackCursor['greptile:G1'], 'keep');
});

test('no-change member review reply posts once and reuses remote receipt', () => {
  const task = {
    dispatchId: 'd1', headRefOid: HEAD,
    repairPolicy: { policyVersion: 2, items: [{ key: 'review:R1', action: 'code-fix', reason: 'member-feedback-triage' }] },
    feedback: [{ key: 'review:R1', source: 'review', nativeId: 'R1', contentHash: 'h1', body: 'please fix this', authorAssociation: 'MEMBER', author: { login: 'alice', __typename: 'User' }, url: 'https://github.com/example-org/example-plugin/pull/3#pullrequestreview-1' }],
  };
  const result = {
    schemaVersion: 2, dispatchId: 'd1', head: HEAD, receiptId: 'rcpt',
    feedbackCoverage: { dispositions: [{ key: 'review:R1', disposition: 'no-change' }] },
    scs: [{ id: 'SC1', status: 'no-change', feedbackKeys: ['review:R1'], evidence: ['当前 head 上无法复现'] }],
  };
  const items = completedMemberFeedback(result, task);
  assert.equal(items.length, 1);
  const covered = coveredFeedbackItems(items, [{ key: 'review:R1', source: 'review', nativeId: 'R1', contentHash: 'h1' }], task, result);
  assert.equal(covered.length, 1);
  const calls = [];
  const ghFn = (args) => { calls.push(args); return JSON.stringify({ id: 99 }); };
  const gen = replyToMemberFeedback({
    items: covered.map((item) => ({ ...item, ...task.feedback[0], dispatchId: 'd1' })),
    comments: [], actor: 'owner', repo: 'example-org/example-plugin', number: 3, ghFn, now: '2026-10-21T00:00:00Z', head: HEAD, previous: {},
  });
  let step = gen.next();
  while (!step.done) step = gen.next(step.value());
  assert.equal(step.value.posted[0].commentId, 99);
  assert.match(calls[0].join(' '), /issues\/3\/comments/);
  assert.equal(calls[0].some((arg) => arg.startsWith('in_reply_to')), false);
  const again = replyToMemberFeedback({
    items: covered.map((item) => ({ ...item, ...task.feedback[0], dispatchId: 'd1' })),
    comments: [{ id: 99, user: { login: 'owner' }, body: `actionKey=${step.value.previous.handledFeedback['review:R1'].actionKey}` }],
    actor: 'owner', repo: 'example-org/example-plugin', number: 3, ghFn, now: '2026-10-21T00:00:00Z', head: HEAD,
    previous: step.value.previous,
  });
  let second = again.next();
  while (!second.done) second = again.next(second.value());
  assert.equal(calls.length, 1);
  assert.equal(second.value.previous.handledFeedback['review:R1'].replyCommentId, 99);
});
