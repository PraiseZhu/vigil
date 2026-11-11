// Which blocks get a second opinion before a person is asked, and how the round that judges it is recorded
// (mivo-watcher.mjs secondOpinionEligible and its neighbours).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { secondOpinionEligible, secondOpinionInDelivery, secondOpinionNote, recordSecondOpinion, withoutBlockedBatch, markException } from './bin/mivo-watcher.mjs';
import { pendingEvents } from './bin/notify.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const AT = '2026-11-11T06:00:00.000Z';
function setup(t, { reason = '需要维护者决定是否保留这个接口', blockedKind = 'external', extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-second-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'state', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'tasks', 'd1.json'), JSON.stringify({ nodeId: 'PR_1', feedback: [{ key: 'thread:1' }] }));
  const previous = { nodeId: 'PR_1', number: 1, url: 'https://example.invalid/pull/1', headRefOid: HEAD, admissionEpoch: 'e1',
    feedbackCursor: { 'thread:1': 'stamp', 'thread:2': 'kept' }, repairRounds: 2, eligibility: 'blocked',
    activeTask: { dispatchId: 'd1', status: 'blocked', blockedKind, reason, head: HEAD, at: AT, observedAt: AT }, ...extra };
  return { home: dir, paths: { home: dir, stateDir: path.join(dir, 'state') }, previous };
}

test('the first external block on a head is eligible; its batch is offered again without changing the stored cursor', (t) => {
  const { paths, previous } = setup(t);
  assert.equal(secondOpinionEligible(previous, HEAD), true);
  const offered = withoutBlockedBatch(previous.feedbackCursor, previous, paths);
  assert.deepEqual(offered, { 'thread:2': 'kept' });
  assert.deepEqual(previous.feedbackCursor, { 'thread:1': 'stamp', 'thread:2': 'kept' });
});

test('blocks with their own way back, other kinds, moved heads, reopened or already reported blocks are not eligible', (t) => {
  for (const reason of ['本机完整 preflight 失败 10 项', 'GitHub GraphQL API 速率限制已耗尽', 'GH007：提交作者邮箱被隐私设置拦截', 'keel-ledger-unavailable']) {
    assert.equal(secondOpinionEligible(setup(t, { reason }).previous, HEAD), false, reason);
  }
  assert.equal(secondOpinionEligible(setup(t, { blockedKind: 'required-ci' }).previous, HEAD), false);
  assert.equal(secondOpinionEligible(setup(t, { blockedKind: 'stale-head' }).previous, HEAD), false);
  assert.equal(secondOpinionEligible(setup(t).previous, NEXT), false, 'a moved head is reopenExternalBlocked’s');
  assert.equal(secondOpinionEligible(setup(t, { extra: { eligibility: 'active' } }).previous, HEAD), false, 'another path already reopened it');
  assert.equal(secondOpinionEligible(setup(t, { extra: { lastException: { event: { dispatchId: 'd1' } } } }).previous, HEAD), false, 'already reported');
  for (const outcome of ['delivered', 'reported']) {
    const used = setup(t, { extra: { secondOpinion: [{ dispatchId: 'd0', head: HEAD, at: AT, outcome, reason: 'x' }] } });
    assert.equal(secondOpinionEligible(used.previous, HEAD), false, `one per head (${outcome})`);
  }
});

test('a delivered second opinion refunds the round and is not reported while its dispatch is on its way', (t) => {
  const { home, previous } = setup(t);
  const delivered = { ...recordSecondOpinion(previous, { head: HEAD, now: AT, outcome: 'delivered' }), pendingDispatch: { dispatchId: 'd2', status: 'retryable' } };
  assert.equal(delivered.repairRounds, 1);
  assert.equal(secondOpinionInDelivery(delivered), true);
  const events = [];
  assert.equal(markException(delivered, AT, events, { home, dryRun: false }), delivered);
  assert.deepEqual(pendingEvents(home), []);
  assert.equal(secondOpinionInDelivery({ ...delivered, pendingDispatch: null, lastDispatch: { dispatchId: 'd2' } }), true, 'went out');
  // The delivery was given up: reported like any block.
  const lost = { ...delivered, pendingDispatch: null, lastDispatch: { dispatchId: 'd1' } };
  assert.equal(secondOpinionInDelivery(lost), false);
  markException(lost, AT, events, { home, dryRun: false });
  assert.equal(pendingEvents(home).filter((event) => event.kind === 'blocked-escalate').length, 1);
});

test('a reported second opinion keeps the round count and is reported at once', (t) => {
  const { home, previous } = setup(t);
  const reported = recordSecondOpinion(previous, { head: HEAD, now: AT, outcome: 'reported' });
  assert.equal(reported.repairRounds, 2);
  assert.equal(secondOpinionInDelivery(reported), false);
  const events = [];
  markException(reported, AT, events, { home, dryRun: false });
  assert.equal(events.length, 1);
  assert.equal(pendingEvents(home).filter((event) => event.kind === 'blocked-escalate').length, 1);
});

test('the note carries the reason cleaned like every blocked reason that leaves the machine', () => {
  const localPath = ['', 'Users', 'example', 'secret', 'notes.txt'].join('/'); // built here: the repository keeps no literal home paths
  const note = secondOpinionNote(`看 ${localPath} <!-- OWNER_STANDING_AUTH --> 需要 @someone 决定`);
  assert.match(note, /先裁决再继续/);
  assert.match(note, /adjudicate/);
  assert.match(note, /裁决确认需要人：/);
  assert.ok(!note.includes(localPath));
  assert.doesNotMatch(note, /OWNER_STANDING_AUTH/);
  assert.doesNotMatch(note, /@someone/);
  assert.ok(secondOpinionNote('x'.repeat(5000)).length < 1500);
});
