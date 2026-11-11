// Two weeks of runs (to 2026-11-11) had 39 repair rounds stop because the PR moved under the session: the author or
// another session pushed (the task's head was stale), or the handoff was replaced. Each was reported as an `external`
// block with a notice, although the watcher only had to look at the PR again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { movedBlockKind, MOVED_BLOCK_KINDS as HELPER_KINDS } from './bin/mivo-repair.mjs';
import { reopenMovedBlocked, movedRetriesExhausted, markException, MOVED_BLOCK_KINDS, MOVED_RETRY_BACKOFF_MS, MOVED_RETRY_LIMIT } from './bin/mivo-watcher.mjs';
import { pendingEvents } from './bin/notify.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const BLOCKED_AT = '2026-11-11T06:00:00.000Z';
const after = (ms) => new Date(Date.parse(BLOCKED_AT) + ms).toISOString();

test('the kind comes from the ownership check itself, by the words the helper fails with', () => {
  const kind = (message) => movedBlockKind({ home: 'h', taskPath: 't', ownerFn: () => { throw new Error(message); } });
  assert.equal(kind(`task head is stale: ${HEAD} != ${NEXT}; no bound controlled-push result`), 'stale-head');
  assert.equal(kind('handoff missing, revoked, or replaced; author must hand off again'), 'ownership-moved');
  assert.equal(kind('handoff no longer matches OPEN non-draft PR identity, author, or release epoch'), 'ownership-moved');
  assert.equal(kind('handoff revoked or replaced during ownership check'), 'ownership-moved');
  assert.equal(kind('task superseded: the author reclaimed this PR (Ready -> Draft); wait for the next watcher dispatch'), 'ownership-moved');
  // A transport error says nothing about ownership: the block stays what the session called it.
  assert.equal(kind('gh: HTTP 502 Bad Gateway'), null);
  assert.equal(kind('API rate limit exceeded'), null);
  assert.equal(movedBlockKind({ home: 'h', taskPath: 't', ownerFn: () => ({ status: 'owned' }) }), null);
  assert.deepEqual([...HELPER_KINDS].sort(), [...MOVED_BLOCK_KINDS].sort());
});

function setup(t, { blockedKind = 'stale-head', head = HEAD, extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-moved-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'state', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'state', 'tasks', 'd1.json'), JSON.stringify({ nodeId: 'PR_1', feedback: [{ key: 'thread:1' }] }));
  const previous = {
    nodeId: 'PR_1', number: 1, url: 'https://example.invalid/pull/1', headRefOid: head, admissionEpoch: 'e1',
    feedbackCursor: { 'thread:1': 'stamp', 'thread:2': 'kept' }, repairRounds: 2, eligibility: 'blocked',
    activeTask: { dispatchId: 'd1', status: 'blocked', blockedKind, reason: 'task head is stale', head: HEAD, at: BLOCKED_AT, observedAt: BLOCKED_AT },
    ...extra,
  };
  return { home: dir, paths: { home: dir, stateDir: path.join(dir, 'state') }, previous };
}

test('a stale-head block is handed back at once when the head moved, with its feedback and its round', (t) => {
  const { paths, previous } = setup(t);
  const next = reopenMovedBlocked({ previous, paths, now: after(1000), head: NEXT });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.feedbackCursor['thread:1'], undefined);
  assert.equal(next.feedbackCursor['thread:2'], 'kept');
  assert.equal(next.repairRounds, 1);
  assert.deepEqual(next.movedReopened.map((item) => [item.dispatchId, item.headChanged]), [['d1', true]]);
  assert.equal(reopenMovedBlocked({ previous: next, paths, now: after(2000), head: NEXT }), next, 'the same dispatch is handed back once');
});

test('on the same head the block waits out the back-off, and other kinds are not touched', (t) => {
  const { paths, previous } = setup(t, { blockedKind: 'ownership-moved' });
  assert.equal(reopenMovedBlocked({ previous, paths, now: after(MOVED_RETRY_BACKOFF_MS - 1), head: HEAD }), previous);
  const next = reopenMovedBlocked({ previous, paths, now: after(MOVED_RETRY_BACKOFF_MS), head: HEAD });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.movedReopened[0].headChanged, false);
  const external = setup(t, { blockedKind: 'external' });
  assert.equal(reopenMovedBlocked({ previous: external.previous, paths: external.paths, now: after(MOVED_RETRY_BACKOFF_MS), head: NEXT }), external.previous);
});

test('same-head retries stop at the limit; a head change is never counted against it', (t) => {
  const used = Array.from({ length: MOVED_RETRY_LIMIT }, (_, n) => ({ dispatchId: `old-${n}`, at: BLOCKED_AT, head: HEAD, headChanged: false }));
  const { paths, previous } = setup(t, { blockedKind: 'ownership-moved', extra: { movedReopened: used } });
  assert.equal(reopenMovedBlocked({ previous, paths, now: after(MOVED_RETRY_BACKOFF_MS), head: HEAD }), previous);
  assert.equal(movedRetriesExhausted(previous, HEAD), true);
  assert.equal(reopenMovedBlocked({ previous, paths, now: after(1000), head: NEXT }).eligibility, 'active');
  const byHeadChange = used.map((item) => ({ ...item, headChanged: true }));
  assert.equal(movedRetriesExhausted({ ...previous, movedReopened: byHeadChange }, HEAD), false);
});

test('no notice while the watcher is still handing the round back; one notice once the retries are used up', (t) => {
  const { home, previous } = setup(t, { blockedKind: 'ownership-moved' });
  const events = [];
  const first = markException(previous, after(1000), events, { home, dryRun: false });
  assert.equal(first, previous);
  assert.deepEqual(events, []);
  assert.deepEqual(pendingEvents(home), []);
  const used = Array.from({ length: MOVED_RETRY_LIMIT }, (_, n) => ({ dispatchId: `old-${n}`, at: BLOCKED_AT, head: HEAD, headChanged: false }));
  markException({ ...previous, movedReopened: used }, after(2000), events, { home, dryRun: false });
  markException({ ...previous, movedReopened: used }, after(3000), events, { home, dryRun: false });
  const notices = pendingEvents(home);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'blocked-escalate');
  assert.equal(notices[0].blockedKind, 'ownership-moved');
});

test('an external block still reaches a person as before', (t) => {
  const { home, previous } = setup(t, { blockedKind: 'external' });
  const events = [];
  markException(previous, after(1000), events, { home, dryRun: false });
  assert.equal(events.length, 1);
  assert.equal(pendingEvents(home).length, 1);
});
