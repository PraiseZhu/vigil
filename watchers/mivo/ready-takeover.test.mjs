import test from 'node:test';
import assert from 'node:assert/strict';
import { feedbackRepairPolicy, isMemberThread } from './bin/mivo-feedback-policy.mjs';
import { refutedThreads, closeRefutedThreads } from './bin/mivo-review-resolve.mjs';
import { implicitHandoff, isCurrentHandoff } from './bin/mivo-handoff.mjs';
import { ciUnknownRecheckDue, watcherPaths } from './bin/mivo-watcher.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HEAD = 'a'.repeat(40);
const thread = (extra) => ({ source: 'thread', threadId: 'PRRT_example', nativeId: 'PRRT_example:1', sha: HEAD,
  body: '这里会丢数据吗？', user: { login: 'ExampleMember' }, ...extra });

// A member's review thread blocks the merge and the pre-review until resolved; it used to stay open forever.
test('a member review thread goes to the session for grading; other open threads are graded too', () => {
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    const policy = feedbackRepairPolicy(thread({ authorAssociation: association }), { headSha: HEAD });
    assert.equal(policy.action, 'code-fix', association);
    assert.equal(policy.reason, 'member-thread-triage');
  }
  // An outsider's or a bot's open thread also blocks the merge; the session grades it rather than a person.
  assert.equal(feedbackRepairPolicy(thread({ authorAssociation: 'NONE' }), { headSha: HEAD }).reason, 'thread-triage');
  assert.equal(feedbackRepairPolicy(thread({ authorAssociation: 'MEMBER', user: { login: 'helper[bot]' } }), { headSha: HEAD }).reason, 'thread-triage');
  assert.equal(feedbackRepairPolicy(thread({ authorAssociation: 'MEMBER', threadId: undefined }), { headSha: HEAD }).action, 'needs-triage', 'an issue comment does not block the merge');
  assert.equal(isMemberThread(thread({ authorAssociation: 'member' })), true);
});

test('a member thread the session graded as no-change is answered as a triage, not as a refuted P0/P1', () => {
  const key = 'thread:PRRT_example:1';
  const task = { dispatchId: 'task-1', prAuthor: 'ExampleMember', feedback: [{ key, author: 'ExampleMember' }],
    repairPolicy: { items: [{ key, action: 'code-fix', reason: 'member-thread-triage' }] } };
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


test('a Greptile P1 is re-graded before code changes; the reviewer account\'s P1 is not', () => {
  const body = '**P1** reload loses handwritten text';
  const greptile = feedbackRepairPolicy({ source: 'greptile', sha: HEAD, body, user: { login: 'greptile-apps[bot]' } }, { headSha: HEAD });
  assert.equal(greptile.action, 'code-fix');
  assert.equal(greptile.reason, 'greptile-p1-triage');
  const reviewer = feedbackRepairPolicy({ source: 'mivo-review', sha: HEAD, body, user: { login: 'ExampleReviewer' } }, { headSha: HEAD });
  assert.equal(reviewer.reason, 'explicit-p0-p1-finding');
  assert.equal(feedbackRepairPolicy({ source: 'greptile', sha: HEAD, body: '**P2** naming', user: { login: 'greptile-apps[bot]' } }, { headSha: HEAD }).action, 'reply-only');
  const key = 'greptile:PRRT_g:1';
  const task = { dispatchId: 'task-3', prAuthor: 'ExampleAuthor', feedback: [{ key, author: 'greptile-apps[bot]' }],
    repairPolicy: { items: [{ key, action: 'code-fix', reason: 'greptile-p1-triage' }] } };
  const result = { schemaVersion: 2, status: 'complete', dispatchId: 'task-3',
    feedbackCoverage: { dispositions: [{ key, disposition: 'no-change' }] },
    scs: [{ status: 'no-change', feedbackKeys: [key], evidence: ['只在隐藏的 server 模式下触发，按统一分级是 P3。'] }] };
  const [item] = refutedThreads(result, task);
  assert.equal(item.triage, true);
});


// The owner wants PRs pushed to mergeable without a person in the loop (2026-10-15): a member's thread graded
// no-change is answered and resolved like any other, even with the author's reply on the same thread.
test('a member thread graded no-change is answered and resolved, together with the author reply on it', () => {
  const memberKey = 'thread:PRRT_mixed:1';
  const authorKey = 'thread:PRRT_mixed:2';
  const task = { dispatchId: 'task-4', prAuthor: 'ExampleAuthor',
    feedback: [{ key: memberKey, author: 'ExampleMaintainer' }, { key: authorKey, author: 'ExampleAuthor' }],
    repairPolicy: { items: [memberKey, authorKey].map((key) => ({ key, action: 'code-fix', reason: 'member-thread-triage' })) } };
  const result = { schemaVersion: 2, status: 'complete', dispatchId: 'task-4',
    feedbackCoverage: { dispositions: [{ key: memberKey, disposition: 'no-change' }, { key: authorKey, disposition: 'no-change' }] },
    scs: [{ status: 'no-change', feedbackKeys: [memberKey, authorKey], evidence: ['PR 正文「产品意图」写明保留这个菜单，按设计不改。'] }] };
  const calls = [];
  const run = closeRefutedThreads({ items: refutedThreads(result, task), dispatchId: 'task-4', previous: {}, ghFn: args => { calls.push(args); return '{}'; }, now: 'n', head: HEAD });
  let next = run.next(); while (!next.done) next = run.next(next.value());
  assert.equal(calls.filter(args => args.some(arg => String(arg).includes('resolveReviewThread'))).length, 1, 'resolved once');
  assert.equal(calls.filter(args => args.some(arg => String(arg).includes('addPullRequestReviewThreadReply'))).length, 1, 'answered once');
  assert.match(calls[0].find(arg => arg.startsWith('body=')), /产品意图/);
  assert.equal(next.value.previous.autoClosedThreads.PRRT_mixed.reason, 'member-thread-no-change');
});

// 2026-10-16: #1002 kept a recheck result that could not read CI; its CI had finished, nothing on GitHub changed again, and
// the watcher never rechecked it, so the task stayed waiting-ci (and blocked new feedback) for 17 hours.
test('a waiting-ci task whose last recheck could not read CI is rechecked on its own, at most every 5 minutes', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-ci-unknown-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(path.join(paths.stateDir, 'results'), { recursive: true });
  const write = (missing) => fs.writeFileSync(path.join(paths.stateDir, 'results', 'task-1.json'), JSON.stringify({
    dispatchId: 'task-1', nodeId: 'PR_1', sessionId: 'session-1', status: 'waiting-ci', ci: { missing, pending: [] } }));
  const entry = (observedAt, status = 'waiting-ci') => ({ nodeId: 'PR_1', sessionId: 'session-1',
    activeTask: { dispatchId: 'task-1', status, evidenceVersion: 2, observedAt } });
  const now = '2026-10-16T10:30:00Z';
  write(['required-policy-unknown']);
  assert.equal(ciUnknownRecheckDue(entry('2026-10-15T17:24:00Z'), paths, now), true);
  assert.equal(ciUnknownRecheckDue(entry('2026-10-16T10:27:00Z'), paths, now), false, 'rechecked 3 minutes ago');
  assert.equal(ciUnknownRecheckDue(entry('2026-10-15T17:24:00Z', 'complete'), paths, now), false);
  write([]);
  assert.equal(ciUnknownRecheckDue(entry('2026-10-15T17:24:00Z'), paths, now), false, 'pending or failing CI moves the fingerprint itself');
});
