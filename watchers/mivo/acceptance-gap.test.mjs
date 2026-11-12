import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handoffPr, handoffReceipt, withAuthorHandoff, isChildPrList } from './handoff.fixture.mjs';
import { scanOnceAsync, watcherPaths, scriptNoChangePolicy, withManualTestResults } from './bin/mivo-watcher.mjs';
import { feedbackRepairPolicy } from './bin/mivo-feedback-policy.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';
import { pendingEvents, formatNoticeText } from './bin/notify.mjs';

// #386: a finding only a person can close (class=acceptance-gap: a real device, a paid account, a manual test) is not a
// code task. Alone it wakes no session and the owner gets one notice; next to ordinary findings the session gets the
// code part and the gap is still a notice; with the owner's manual result on the PR the session writes it back.
const REPO = process.env.MIVO_WATCHER_TARGET_REPO;
const NODE = 'PR_910';
const NUMBER = 910;
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const NOW = '2026-11-12T01:00:00.000Z';
const LATER = '2026-11-12T01:05:00.000Z';
const GAP_KEY = 'aaaaaaaaaaaa';
const CODE_KEY = 'bbbbbbbbbbbb';

// The trusted reviewer as GitHub Actions posts it (GraphQL form).
const reviewer = { login: 'github-actions', __typename: 'Bot' };
const reviewerComment = (id, body) => ({ id, author: reviewer, createdAt: '2026-11-12T00:00:00Z', body });
const gapBody = '[P2] GIF 真实平台验收（SC3/SC9）仍未完成\n\n在真机执行并补录结果。\n\n'
  + `<!-- mivo-finding key=${GAP_KEY} round=1 head=1111111 class=acceptance-gap -->`;
const codeBody = `[P1] 空值未处理\n\n<!-- mivo-finding key=${CODE_KEY} round=1 head=1111111 class=null-check -->`;
const threadOf = (n, body) => ({ id: `PRRT_${n}`, isResolved: false, isOutdated: false, path: 'src/a.mjs', comments: [reviewerComment(`PRRC_${n}`, body)] });
const gapThread = () => threadOf(1, gapBody);
const codeThread = () => threadOf(2, codeBody);
const manualResult = (result = 'pass', { login = 'owner', pr = NUMBER } = {}) => ({
  id: 'IC_manual', author: { login, __typename: 'User' }, createdAt: '2026-11-12T00:30:00Z',
  body: `手测结论：${result === 'pass' ? '通过' : '不通过'}\n测试包 build-42，SC3 通过，SC9 通过\n\n`
    + `<!-- manual-test-result:v1 issue=12 pr=${pr} head=${HEAD} result=${result} -->`,
});

const listed = () => handoffPr({ repo: REPO, id: NODE, number: NUMBER, headRefOid: HEAD, baseRefOid: BASE, state: 'OPEN', isDraft: false,
  author: { login: 'owner' }, releaseEpoch: 'e', headRefName: 'fix/gap' });
const snapshot = (threads) => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, updatedAt: NOW, mergeable: 'MERGEABLE',
  labels: [], checkState: 'SUCCESS', commentCount: 0, reviewCount: 0, commentUpdatedAt: null, reviewUpdatedAt: null,
  unresolvedThreads: threads.length });

function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-acceptance-gap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = watcherPaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const pr = listed();
  writePr(paths.home, NODE, { number: NUMBER, nodeId: NODE, sessionId: 'sess-910', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: pr.releaseEpoch, handoff: handoffReceipt(pr), headRefName: 'fix/gap', title: 'fix', repairRounds: 0 });
  const state = () => readPr(paths.home, NODE);
  async function poll({ threads, comments = [], now = NOW } = {}) {
    writePr(paths.home, NODE, { ...state(), pollFingerprint: 'stale' });
    const sent = [];
    const out = await scanOnceAsync({
      mode: 'poll', enabled: true, allowDispatch: true, paths, now, nodeId: NODE, prNumber: NUMBER,
      snapshotFn: () => snapshot(threads),
      ghFn: (args) => (isChildPrList(args) ? '[[]]' : args[0] === 'api' ? 'owner' : '[]'),
      collect: (...args) => withAuthorHandoff({ pr, checks: [], requiredChecks: [], ci: { status: 'green', required: [] }, comments, reviews: [],
        threads, labels: [], mergeable: 'MERGEABLE', admissionVerified: true, requiredChecksGreen: true, mergeReady: false,
        policy: { status: 'verified', required: [] } }, args[0]),
      dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-910' }; },
      ownershipSnapshot: function* () { return { pr }; },
    });
    const entry = state();
    const taskId = entry.activeTask?.dispatchId ?? entry.pendingDispatch?.dispatchId;
    const task = taskId ? JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'tasks', `${taskId}.json`), 'utf8')) : null;
    return { report: out.prs[0], sent, entry, task, notices: pendingEvents(paths.home).filter((event) => event.kind === 'acceptance-gap') };
  }
  return { poll };
}

const trusted = (body, extra = {}) => ({ key: 'thread:x', source: 'mivo-review', threadId: 'PRRT_x', user: reviewer, body, ...extra });

test('#386 policy: a graded acceptance gap from the reviewer needs a person; the owner\'s pass result makes it a write-back task', () => {
  const gap = feedbackRepairPolicy(trusted(gapBody), { headSha: HEAD });
  assert.equal(gap.action, 'human-acceptance');
  assert.equal(gap.canChangeCode, false);
  assert.equal(gap.reason, 'acceptance-gap');
  const withResult = feedbackRepairPolicy(trusted(gapBody, { manualTestResult: { result: 'pass' } }), { headSha: HEAD });
  assert.deepEqual([withResult.action, withResult.reason, withResult.canChangeCode], ['code-fix', 'acceptance-gap-manual-result', true]);
  const failed = feedbackRepairPolicy(trusted(gapBody, { manualTestResult: { result: 'fail' } }), { headSha: HEAD });
  assert.equal(failed.action, 'human-acceptance', 'a failed manual run is still for a person');
  const p3 = feedbackRepairPolicy(trusted(gapBody.replace('[P2]', '[P3]')), { headSha: HEAD });
  assert.equal(p3.action, 'reply-only', 'a P3 gap stays P3');
  const ordinary = feedbackRepairPolicy(trusted(codeBody), { headSha: HEAD });
  assert.equal(ordinary.action, 'code-fix', 'other classes are untouched');
  assert.ok(scriptNoChangePolicy({ headRefOid: HEAD }, [trusted(gapBody)]), 'a batch of only acceptance gaps needs no session');
});

test('#386 only an acceptance gap: no session, one notice to the owner, not repeated on the next poll', async (t) => {
  const w = world(t);
  const first = await w.poll({ threads: [gapThread()] });
  assert.equal(first.sent.length, 0, 'no repair session is woken');
  assert.equal(first.report.dispatch.reason, 'script-no-change');
  assert.equal(first.notices.length, 1);
  assert.equal(first.notices[0].id, `acceptance-gap:${NUMBER}:${GAP_KEY}`);
  const text = formatNoticeText(first.notices);
  assert.match(text, /GIF 真实平台验收/);
  assert.match(text, /补手测/);
  assert.match(text, /明确豁免，交独立 QA/);
  assert.match(text, /manual-test-result:v1/);
  const again = await w.poll({ threads: [gapThread()], now: LATER });
  assert.equal(again.sent.length, 0);
  assert.equal(again.notices.length, 1, 'the same finding is one notice');
});

test('#386 an acceptance gap next to an ordinary finding: the code part goes to a session, the gap is still a notice', async (t) => {
  const w = world(t);
  const run = await w.poll({ threads: [gapThread(), codeThread()] });
  assert.equal(run.sent.length, 1, 'the ordinary P1 is dispatched');
  const byReason = Object.fromEntries(run.task.repairPolicy.items.map((item) => [item.reason, item]));
  assert.equal(byReason['acceptance-gap'].canChangeCode, false);
  assert.equal(byReason['explicit-p0-p1-finding'].canChangeCode, true);
  assert.equal(run.task.repairPolicy.allowedFeedbackKeys.length, 1, 'only the ordinary finding grants code changes');
  assert.match(run.sent[0].message, /reason=acceptance-gap/);
  assert.equal(run.notices.length, 1, 'the gap goes to the owner on its own');
});

test('#386 the owner\'s manual result on the PR goes into the task; the session writes it back, no notice', async (t) => {
  const w = world(t);
  const run = await w.poll({ threads: [gapThread()], comments: [manualResult('pass')] });
  assert.equal(run.sent.length, 1, 'a session writes the result into the acceptance docs');
  const item = run.task.feedback.find((row) => row.threadId === 'PRRT_1');
  assert.equal(item.manualTestResult.result, 'pass');
  assert.equal(item.manualTestResult.head, HEAD);
  assert.match(item.manualTestResult.body, /SC3 通过/);
  assert.deepEqual(run.task.repairPolicy.items.map((row) => row.reason), ['acceptance-gap-manual-result'],
    'the result comment itself is a record, not feedback for the session to grade');
  assert.match(run.sent[0].message, /不把它改标「未执行」/);
  assert.equal(run.notices.length, 0);
});

test('#386 a manual result only counts from the PR author, for this PR', () => {
  const pr = { number: NUMBER, author: { login: 'owner' } };
  const fresh = [trusted(gapBody)];
  assert.equal(withManualTestResults(fresh, { pr, comments: [manualResult('pass', { login: 'someone-else' })] })[0].manualTestResult, undefined);
  assert.equal(withManualTestResults(fresh, { pr, comments: [manualResult('pass', { pr: 999 })] })[0].manualTestResult, undefined);
  assert.equal(withManualTestResults(fresh, { pr, comments: [manualResult('pass')] })[0].manualTestResult.result, 'pass');
  const ordinary = [trusted(codeBody)];
  assert.equal(withManualTestResults(ordinary, { pr, comments: [manualResult('pass')] }), ordinary, 'nothing to attach without a gap');
});
