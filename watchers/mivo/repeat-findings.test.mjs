import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertRepeatInventory } from './bin/mivo-repair.mjs';
import { repeatFindingsFor, repeatFindingRule } from './bin/mivo-watcher.mjs';

// A reviewer finding that comes back after an earlier task fixed it (same key, or same class) must be inventoried
// as a class and fixed with a stated approach, not patched at the one reported spot again.
const marker = (key, cls) => `<!-- mivo-finding key=${key} round=1 head=aaaaaaaaaaaa class=${cls} -->`;
const item = (key, findingKey, cls) => ({ key, source: 'mivo-review', body: `[P2] guard bypass\n${marker(findingKey, cls)}` });

function home(t, earlier) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repeat-findings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  for (const dir of ['tasks', 'results']) fs.mkdirSync(path.join(stateDir, dir), { recursive: true });
  for (const [name, task, result] of earlier) {
    fs.writeFileSync(path.join(stateDir, 'tasks', name), JSON.stringify(task));
    fs.writeFileSync(path.join(stateDir, 'results', name), JSON.stringify(result));
  }
  return { stateDir };
}
const pr = { id: 'PR_9', number: 9 };

test('R-1 a finding key fixed in an earlier task is a same-key repeat; a class fixed earlier is a same-class repeat', (t) => {
  const paths = home(t, [['live-9-1.json',
    { nodeId: 'PR_9', feedback: [item('mivo-review:a', '111111111111', 'static-analysis-false-negative')] },
    { scs: [{ id: 'SC-1', status: 'pass', feedbackKeys: ['mivo-review:a'] }] }]]);
  const repeat = repeatFindingsFor({ paths, pr, fresh: [
    item('mivo-review:b', '111111111111', 'static-analysis-false-negative'),
    item('mivo-review:c', '222222222222', 'static-analysis-false-negative'),
    item('mivo-review:d', '333333333333', 'naming'),
  ] });
  assert.deepEqual(repeat.map((r) => [r.feedbackKey, r.reason]), [['mivo-review:b', 'same-key'], ['mivo-review:c', 'same-class']]);
  assert.match(repeatFindingRule(repeat), /deep-research/);
});

test('R-2 a finding only disputed (no-change) or from another PR earlier is not a repeat', (t) => {
  const paths = home(t, [
    ['live-9-1.json', { nodeId: 'PR_9', feedback: [item('mivo-review:a', '111111111111', 'x')] },
      { scs: [{ id: 'SC-1', status: 'no-change', feedbackKeys: ['mivo-review:a'] }] }],
    ['live-10-1.json', { nodeId: 'PR_10', feedback: [item('mivo-review:z', '222222222222', 'y')] },
      { scs: [{ id: 'SC-1', status: 'pass', feedbackKeys: ['mivo-review:z'] }] }],
  ]);
  assert.deepEqual(repeatFindingsFor({ paths, pr, fresh: [item('k1', '111111111111', 'x'), item('k2', '222222222222', 'y')] }), []);
});

test('R-3 fixing a repeated finding needs inventory and approach evidence', () => {
  const task = { repeatFindings: [{ feedbackKey: 'mivo-review:b', reason: 'same-key' }] };
  const sc = (evidence) => [{ id: 'SC-1', status: 'pass', feedbackKeys: ['mivo-review:b'], evidence }];
  assert.throws(() => assertRepeatInventory({ scs: sc(['patched the reported form']), task }), /REPEAT_INVENTORY_REQUIRED/);
  assert.throws(() => assertRepeatInventory({ scs: sc(['inventory: destructuring, getters, spread, class fields all handled']), task }), /REPEAT_INVENTORY_REQUIRED/);
  assertRepeatInventory({ scs: sc([
    'inventory: destructuring, getters, spread, class fields, dynamic keys: unresolved forms now fail closed',
    'approach: root change - any unresolved call form counts as over budget instead of patching each form',
  ]), task });
  assertRepeatInventory({ scs: sc(['no repeat key here']), task: {} });
});
