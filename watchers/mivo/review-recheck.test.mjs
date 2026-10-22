// The pre-review is the only dispatcher of the server review. The watcher used to dispatch a recheck
// itself after a no-change repair; now the reviewer re-reviews once its threads are resolved and reads
// the ruling records in the replies, so a second dispatcher only duplicated runs (vigil#38).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as actions from './bin/mivo-pr-actions.mjs';

const HEAD = 'a'.repeat(40);

test('the watcher has no code path that dispatches a workflow run', () => {
  assert.equal(actions.planReviewRecheck, undefined);
  assert.equal(actions.requestReviewRecheck, undefined);
  const dir = new URL('./bin/', import.meta.url);
  const sources = fs.readdirSync(dir).filter((name) => /\.(?:mjs|py)$/.test(name));
  assert.ok(sources.includes('mivo-watcher.mjs') && sources.includes('mivo-pr-actions.mjs'));
  for (const name of sources) {
    const text = fs.readFileSync(new URL(name, dir), 'utf8');
    assert.doesNotMatch(text, /['"]workflow['"]\s*,\s*['"]run['"]/, `${name} dispatches a workflow`);
    assert.doesNotMatch(text, /gh workflow run/, `${name} dispatches a workflow`);
  }
});

test('recheck attempts recorded by older versions still settle and stop counting as pending', () => {
  const entry = { reviewRechecks: { [HEAD]: { attempts: [{ key: 'k1', status: 'sent', requestedAt: '2026-10-21T00:00:00Z' }] } } };
  assert.equal(actions.pendingActionDue(entry), true);
  const early = actions.reconcileReviewRecheck({ entry, snapshot: { pr: { headRefOid: HEAD } }, now: '2026-10-21T00:05:00Z' });
  assert.equal(early.reviewRechecks[HEAD].attempts[0].status, 'sent');
  const settled = actions.reconcileReviewRecheck({ entry, snapshot: { pr: { headRefOid: HEAD } }, now: '2026-10-21T00:11:00Z' });
  assert.equal(settled.reviewRechecks[HEAD].attempts[0].status, 'failed');
  assert.equal(actions.pendingActionDue(settled), false);
});
