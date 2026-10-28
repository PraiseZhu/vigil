import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { alreadyFixedProof, assertDisputesAdjudicated, assertRepeatInventory, testDocFeedbackKeys } from './bin/cindy-repair.mjs';
import { dispatchParams, repeatFindingsFor } from './bin/cindy-watcher.mjs';

const HEAD = 'a'.repeat(40);
// A trusted reviewer's P2 on an inline thread: canChangeCode code-fix, like the live Greptile findings.
const finding = (key, thread) => ({ key, source: 'thread', nativeId: `${thread}:PRRC_1`, sha: HEAD,
  user: { login: 'greptile-apps[bot]', type: 'Bot' }, author: 'greptile-apps[bot]', body: '**P2**: concrete finding', category: 'actionable-fix' });
const taskWith = (items, threads) => ({ headRefOid: HEAD, feedback: items, prSnapshot: { unresolvedThreads: threads } });
const noChange = (key, evidence = ['checked']) => [{ id: 'SC-1', status: 'no-change', feedbackKeys: [key], evidence }];

test('C-T1 a finding on a test or docs file is test/doc; a product file is not', () => {
  const task = taskWith([finding('k-test', 'PRRT_a'), finding('k-doc', 'PRRT_b'), finding('k-src', 'PRRT_c')], [
    { id: 'PRRT_a', path: 'apps/desktop/src/main/foo.test.ts' }, { id: 'PRRT_b', path: 'docs/guide.md' }, { id: 'PRRT_c', path: 'apps/desktop/src/main/foo.ts' }]);
  assert.deepEqual([...testDocFeedbackKeys(task)].sort(), ['k-doc', 'k-test']);
});

test('C-T2 a test/doc finding cannot close as no-change, even with an arbiter; a proven already-fixed commit can', () => {
  const task = taskWith([finding('k-test', 'PRRT_a')], [{ id: 'PRRT_a', path: 'apps/desktop/src/main/foo.test.ts' }]);
  const arbiter = [{ purpose: 'adjudicate', agent: 'codex', model: 'm', effort: 'medium' }];
  assert.throws(() => assertDisputesAdjudicated({ scs: noChange('k-test'), workers: arbiter, task }), /TEST_DOC_MUST_FIX.*k-test/);
  assertDisputesAdjudicated({ scs: noChange('k-test', ['already-fixed: bbbbbbb']), workers: [], task, fixedAfterReview: (sha) => sha === 'bbbbbbb' });
  assert.throws(() => assertDisputesAdjudicated({ scs: noChange('k-test', ['already-fixed: ccccccc']), workers: [], task, fixedAfterReview: () => false }), /TEST_DOC_MUST_FIX/);
});

test('C-R1 a review thread fixed in an earlier task and raised again is a repeat; fixing it needs inventory and approach', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-repeat-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  for (const dir of ['tasks', 'results']) fs.mkdirSync(path.join(stateDir, dir), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'tasks', 'live-5-1.json'), JSON.stringify({ nodeId: 'PR_5', feedback: [finding('old', 'PRRT_x')] }));
  fs.writeFileSync(path.join(stateDir, 'results', 'live-5-1.json'), JSON.stringify({ scs: [{ id: 'SC-1', status: 'pass', feedbackKeys: ['old'] }] }));
  const repeat = repeatFindingsFor({ paths: { stateDir }, pr: { id: 'PR_5', number: 5 }, fresh: [{ ...finding('new', 'PRRT_x'), nativeId: 'PRRT_x:PRRC_2' }, finding('other', 'PRRT_y')] });
  assert.deepEqual(repeat.map((r) => [r.feedbackKey, r.threadId]), [['new', 'PRRT_x']]);
  const task = { repeatFindings: repeat };
  assert.throws(() => assertRepeatInventory({ scs: [{ id: 'SC-1', status: 'pass', feedbackKeys: ['new'], evidence: ['patched it'] }], task }), /REPEAT_INVENTORY_REQUIRED/);
  assertRepeatInventory({ scs: [{ id: 'SC-1', status: 'pass', feedbackKeys: ['new'], evidence: ['inventory: every caller path listed and handled now', 'approach: root change, validate at the single entry point'] }], task });
  const message = dispatchParams({ pr: { number: 5, id: 'PR_5', headRefOid: HEAD, title: 't' }, mapping: {}, fresh: [], now: '2026-10-28T00:00:00Z', repeatFindings: repeat }).message;
  assert.match(message, /deep-research/);
  assert.match(message, /测试、文档类意见直接修/);
  assert.match(message, /任务完成后，watcher 把本会话交给扫地僧归档/);
});

test('C-T3 already-fixed proof: in the validated head and not in the reviewed head; a missing head or a git error proves nothing', () => {
  const FIX = 'f'.repeat(40);
  const REVIEWED = 'e'.repeat(40);
  const gitFor = (answers) => (binary, args) => {
    const code = answers[`${args.at(-2)}..${args.at(-1)}`];
    if (code === 0) return '';
    throw Object.assign(new Error(`merge-base exit ${code}`), { status: code });
  };
  const proof = (answers) => alreadyFixedProof({ worktree: '/repo', validatedHead: HEAD, gitFn: gitFor(answers) });
  assert.equal(proof({ [`${FIX}..${HEAD}`]: 0, [`${FIX}..${REVIEWED}`]: 1 })(FIX, REVIEWED), true);
  assert.equal(proof({ [`${FIX}..${HEAD}`]: 0, [`${FIX}..${REVIEWED}`]: 0 })(FIX, REVIEWED), false, 'already in the reviewed head');
  assert.equal(proof({ [`${FIX}..${HEAD}`]: 0, [`${FIX}..${REVIEWED}`]: 128 })(FIX, REVIEWED), false, 'reviewed head unreadable');
  assert.equal(proof({ [`${FIX}..${HEAD}`]: 1, [`${FIX}..${REVIEWED}`]: 1 })(FIX, REVIEWED), false, 'not in the validated head');
  assert.equal(proof({ [`${FIX}..${HEAD}`]: 0 })(FIX, null), false, 'no reviewed head');
});

// SC6: a code finding already fixed after the reviewer saw it needs no arbiter; the
// reviewed version comes from the feedback item sha, not from an untyped body.
test('C-A1 a proven already-fixed commit lets a code P2 close without an arbiter', () => {
  const task = taskWith([finding('k-code', 'PRRT_code')], [{ id: 'PRRT_code', path: 'src/app.ts' }]);
  assertDisputesAdjudicated({ scs: noChange('k-code', ['already-fixed: ' + 'f'.repeat(40)]), workers: [], task,
    fixedAfterReview: (sha, reviewed) => sha.startsWith('f') && reviewed === HEAD });
});

test('C-A1 already-fixed does not exempt a commit outside HEAD, already in the reviewed version, or without a reviewed version', () => {
  const reviewedTask = taskWith([finding('k-code', 'PRRT_code')], [{ id: 'PRRT_code', path: 'src/app.ts' }]);
  const noVersion = taskWith([{ ...finding('k-code', 'PRRT_code'), sha: undefined }], [{ id: 'PRRT_code', path: 'src/app.ts' }]);
  const sc = noChange('k-code', ['already-fixed: ' + 'f'.repeat(40)]);
  assert.throws(() => assertDisputesAdjudicated({ scs: sc, workers: [], task: reviewedTask, fixedAfterReview: () => false }), /ADJUDICATE_REQUIRED/);
  assert.throws(() => assertDisputesAdjudicated({ scs: sc, workers: [], task: reviewedTask, fixedAfterReview: (sha, reviewed) => reviewed !== HEAD }), /ADJUDICATE_REQUIRED/);
  assert.throws(() => assertDisputesAdjudicated({ scs: sc, workers: [], task: noVersion, fixedAfterReview: (sha, reviewed) => reviewed !== null }), /ADJUDICATE_REQUIRED/);
});
