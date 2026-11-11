// Which blocks get a second opinion before a person is asked (mivo-watcher.mjs secondOpinionEligible).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reopenForSecondOpinion, secondOpinionEligible, secondOpinionGiven, secondOpinionNote, markException } from './bin/mivo-watcher.mjs';
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

test('the first external block on a head is handed back once, with its feedback, its round and its reason', (t) => {
  const { paths, previous } = setup(t);
  const next = reopenForSecondOpinion({ previous, paths, now: AT, head: HEAD });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.feedbackCursor['thread:1'], undefined);
  assert.equal(next.feedbackCursor['thread:2'], 'kept');
  assert.equal(next.repairRounds, 1);
  assert.equal(next.secondOpinion[0].reason, '需要维护者决定是否保留这个接口');
  assert.equal(secondOpinionGiven(next), true);
  assert.equal(reopenForSecondOpinion({ previous: next, paths, now: AT, head: HEAD }), next, 'once per head');
  const note = secondOpinionNote(next);
  assert.match(note, /需要维护者决定是否保留这个接口/);
  assert.match(note, /adjudicate/);
  assert.match(note, /裁决确认需要人：/);
  assert.equal(secondOpinionNote(previous), '');
});

test('blocks with their own way back, other kinds and moved heads are not handed back here', (t) => {
  for (const reason of ['本机完整 preflight 失败 10 项', 'GitHub GraphQL API 速率限制已耗尽', 'GH007：提交作者邮箱被隐私设置拦截', 'keel-ledger-unavailable']) {
    const { previous } = setup(t, { reason });
    assert.equal(secondOpinionEligible(previous, HEAD), false, reason);
  }
  assert.equal(secondOpinionEligible(setup(t, { blockedKind: 'required-ci' }).previous, HEAD), false);
  assert.equal(secondOpinionEligible(setup(t, { blockedKind: 'stale-head' }).previous, HEAD), false);
  assert.equal(secondOpinionEligible(setup(t).previous, NEXT), false, 'a moved head is reopenExternalBlocked’s');
  const used = setup(t, { extra: { secondOpinion: [{ dispatchId: 'd0', head: HEAD, at: AT, reason: 'x' }] } });
  assert.equal(secondOpinionEligible(used.previous, HEAD), false, 'one per head');
});

test('no notice for the block that was handed back; the next block on the same head is reported', (t) => {
  const { home, paths, previous } = setup(t);
  const handedBack = reopenForSecondOpinion({ previous, paths, now: AT, head: HEAD });
  const events = [];
  assert.equal(markException(handedBack, AT, events, { home, dryRun: false }), handedBack);
  assert.deepEqual(events, []);
  assert.deepEqual(pendingEvents(home), []);
  const again = { ...handedBack, eligibility: 'blocked', activeTask: { ...handedBack.activeTask, dispatchId: 'd2', reason: '裁决确认需要人：要维护者拍板' } };
  assert.equal(secondOpinionGiven(again), false);
  markException(again, AT, events, { home, dryRun: false });
  assert.equal(events.length, 1);
  assert.equal(pendingEvents(home).filter((event) => event.kind === 'blocked-escalate').length, 1);
});
