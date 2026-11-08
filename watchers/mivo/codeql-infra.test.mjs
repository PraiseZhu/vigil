// A CodeQL Analyze job that died downloading the CodeQL bundle (HTTP 504) kept two Ready PRs out of pre-review for
// hours (2026-11-08): pre-review waits for every check to be green, its own retry covers missing jobs only, and the
// watcher left Analyze (*) to code scanning. The watcher now re-runs such a run once per head and tells a person if
// it is red again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectFailedCodeqlJobs, isCodeqlInfraFailure, superviseCodeqlInfra, codeqlInfraCheckDue } from './bin/mivo-codeql-infra.mjs';
import { collectPr, scanOnce, watcherPaths, pollFingerprint, normalizePollSnapshot, REPO } from './bin/mivo-watcher.mjs';
import { readPr, writePr } from './bin/mivo-state.mjs';
import { pendingEvents, formatNoticeText, noticeId } from './bin/notify.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff, isChildPrList } from './handoff.fixture.mjs';

const repo = 'example-org/example-plugin';
const head = 'a'.repeat(40);
const next = 'c'.repeat(40);
const actions = { id: 15368, slug: 'github-actions' };
const job = (runId, id) => `https://github.com/${repo}/actions/runs/${runId}/job/${id}`;
const check = (name, conclusion, { id, runId, started = '2026-11-08T10:05:00Z', sha = head, status = 'completed', app = actions } = {}) => ({
  id, name, conclusion, status, app, head_sha: sha, started_at: started, details_url: job(runId, id),
});
// The two runs GitHub starts for one push: CodeQL (passes) and Code Quality (its download hit a 504).
const codeqlPass = check('Analyze (python)', 'success', { id: 1, runId: 500 });
const qualityFail = check('Analyze (python)', 'failure', { id: 2, runId: 600 });
const qualityPass = check('Analyze (javascript-typescript)', 'success', { id: 3, runId: 600 });
const infraAnnotations = [
  { annotation_level: 'warning', message: 'Failed to download and extract CodeQL bundle using streaming with error: Failed to download CodeQL bundle from https://example.invalid/codeql-bundle.tar.zst. HTTP status code: 504.' },
  { annotation_level: 'failure', message: 'Unable to download and extract CodeQL CLI: Unexpected HTTP response: 504\n\nDetails: Error: Unexpected HTTP response: 504' },
  { annotation_level: 'notice', message: 'The ubuntu-latest label will migrate.' },
];
const realAnnotations = [{ annotation_level: 'failure', message: 'CodeQL detected code written in Python but could not process any of it.' }];

// --- pure parts ---

test('the failed attempt of an Analyze job is found per run, even when the same job name passed in another run', () => {
  const checks = [
    codeqlPass, qualityFail, qualityPass,
    check('verify', 'failure', { id: 4, runId: 700 }), // not an Analyze job
    check('Analyze (actions)', 'failure', { id: 5, runId: 600, sha: 'b'.repeat(40) }), // older head
    check('Analyze (go)', null, { id: 6, runId: 600, status: 'in_progress' }),
    check('Analyze (ruby)', 'failure', { id: 7, runId: 600, app: { id: 9, slug: 'other-app' } }),
    { ...check('Analyze (java)', 'failure', { id: 8, runId: 600 }), details_url: 'https://example.invalid/elsewhere' },
    check('Analyze (swift)', 'timed_out', { id: 9, runId: 800 }),
  ];
  const jobs = selectFailedCodeqlJobs({ checks, repo, headSha: head });
  assert.deepEqual(jobs.map(({ name, checkId, runId }) => ({ name, checkId, runId })), [
    { name: 'Analyze (python)', checkId: 2, runId: '600' },
    { name: 'Analyze (swift)', checkId: 9, runId: '800' },
  ]);
});

test('a later attempt of the same job in the same run replaces the failed one', () => {
  const rerunPassed = check('Analyze (python)', 'success', { id: 12, runId: 600, started: '2026-11-08T12:00:00Z' });
  assert.deepEqual(selectFailedCodeqlJobs({ checks: [qualityFail, rerunPassed], repo, headSha: head }), []);
  const rerunFailed = check('Analyze (python)', 'failure', { id: 13, runId: 600, started: '2026-11-08T12:00:00Z' });
  assert.deepEqual(selectFailedCodeqlJobs({ checks: [qualityFail, rerunFailed], repo, headSha: head }).map((j) => j.checkId), [13]);
});

test('only download and 5xx failure annotations count as infrastructure', () => {
  assert.equal(isCodeqlInfraFailure(infraAnnotations), true);
  assert.equal(isCodeqlInfraFailure([{ annotation_level: 'failure', message: 'Failed to download CodeQL bundle: HTTP status code: 503' }]), true);
  assert.equal(isCodeqlInfraFailure(realAnnotations), false);
  assert.equal(isCodeqlInfraFailure([...infraAnnotations, ...realAnnotations]), false, 'a real failure next to a 504 is not re-run');
  assert.equal(isCodeqlInfraFailure([{ annotation_level: 'failure', message: 'Unexpected HTTP response: 404' }]), false);
  assert.equal(isCodeqlInfraFailure(infraAnnotations.filter((a) => a.annotation_level !== 'failure')), false, 'warnings alone prove nothing');
  assert.equal(isCodeqlInfraFailure([]), false);
  assert.equal(isCodeqlInfraFailure(null), false);
});

// --- one round, with gh faked ---

function drive(gen) {
  let step = gen.next();
  while (!step.done) {
    try { step = gen.next(step.value()); } catch (error) { step = gen.throw(error); }
  }
  return step.value;
}
function fakeGh({ annotations = infraAnnotations, run = { status: 'completed', run_attempt: 1 }, failAnnotations = false } = {}) {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args.join(' '));
    if (args[1] === '--method' && args[2] === 'POST') return '';
    if (/\/check-runs\/\d+\/annotations/.test(args[1])) {
      if (failAnnotations) throw new Error('HTTP 502');
      return JSON.stringify(annotations);
    }
    if (/\/actions\/runs\/\d+$/.test(args[1])) return JSON.stringify(run);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { ghFn, calls };
}
const round = ({ checks, state = null, gh = fakeGh(), now = '2026-11-08T11:00:00Z', headSha = head, dryRun = false }) =>
  ({ ...drive(superviseCodeqlInfra({ ci: { checks }, repo, headSha, state, ghFn: gh.ghFn, now, dryRun })), calls: gh.calls });
const POST = `api --method POST repos/${repo}/actions/runs/600/rerun-failed-jobs`;

test('first round: a 504 run is re-run once; later rounds with the old attempt still listed do nothing', () => {
  const first = round({ checks: [codeqlPass, qualityFail, qualityPass] });
  assert.deepEqual(first.reran, ['600']);
  assert.ok(first.calls.includes(POST), first.calls.join('\n'));
  assert.deepEqual(first.state, { head, runs: { 600: { action: 'rerun', at: '2026-11-08T11:00:00Z', checkIds: [2] } }, notified: false });
  assert.equal(first.notify, false);
  const again = round({ checks: [codeqlPass, qualityFail, qualityPass], state: first.state, now: '2026-11-08T11:03:00Z' });
  assert.deepEqual(again.calls, []);
  assert.deepEqual(again.reran, []);
  assert.equal(again.notify, false);
});

test('red again after the re-run: notify once, never re-run a second time', () => {
  const first = round({ checks: [qualityFail] });
  const redAgain = check('Analyze (python)', 'failure', { id: 22, runId: 600, started: '2026-11-08T11:01:00Z' });
  const second = round({ checks: [qualityFail, redAgain], state: first.state, now: '2026-11-08T11:10:00Z' });
  assert.deepEqual(second.calls, []);
  assert.equal(second.notify, true);
  assert.deepEqual(second.stillRed, ['Analyze (python)']);
  assert.equal(second.state.notified, true);
  const third = round({ checks: [qualityFail, redAgain], state: second.state, now: '2026-11-08T11:20:00Z' });
  assert.equal(third.notify, false);
  assert.deepEqual(third.calls, []);
});

test('a real CodeQL failure is left alone and its annotations are read only once per head', () => {
  const first = round({ checks: [qualityFail], gh: fakeGh({ annotations: realAnnotations }) });
  assert.deepEqual(first.reran, []);
  assert.ok(!first.calls.some((call) => call.includes('POST')));
  assert.equal(first.state.runs[600].action, 'not-infra');
  const again = round({ checks: [qualityFail], state: first.state });
  assert.deepEqual(again.calls, []);
});

test('a run with a job still going, or already re-run by someone else, is not re-run', () => {
  const running = round({ checks: [qualityFail], gh: fakeGh({ run: { status: 'in_progress', run_attempt: 1 } }) });
  assert.deepEqual(running.reran, []);
  assert.equal(running.state, null, 'nothing recorded: the next round asks again');
  const other = round({ checks: [qualityFail], gh: fakeGh({ run: { status: 'completed', run_attempt: 2 } }) });
  assert.deepEqual(other.reran, []);
  assert.ok(!other.calls.some((call) => call.includes('POST')));
  assert.equal(other.state.runs[600].action, 'rerun-by-other');
});

test('a run already re-run and red again from infrastructure tells a person once; a real failure there does not', () => {
  const other = round({ checks: [qualityFail], gh: fakeGh({ run: { status: 'completed', run_attempt: 2 } }) });
  assert.deepEqual(other.stillRed, ['Analyze (python)']);
  assert.equal(other.notify, true);
  assert.equal(other.state.notified, true);
  const again = round({ checks: [qualityFail], state: other.state });
  assert.equal(again.notify, false, 'once per head');
  assert.deepEqual(again.calls, []);
  const real = round({ checks: [qualityFail], gh: fakeGh({ annotations: realAnnotations, run: { status: 'completed', run_attempt: 2 } }) });
  assert.equal(real.notify, false);
  assert.equal(real.state.runs[600].action, 'not-infra');
  const dry = round({ checks: [qualityFail], gh: fakeGh({ run: { status: 'completed', run_attempt: 2 } }), dryRun: true });
  assert.equal(dry.notify, true);
  assert.equal(dry.state, null, 'dry-run records nothing');
  const live = round({ checks: [qualityFail], state: dry.state, gh: fakeGh({ run: { status: 'completed', run_attempt: 2 } }) });
  assert.equal(live.notify, true, 'the real round after a dry-run still notifies');
});

test('a run still going is judged only once it finished, even when its annotations do not look like infrastructure yet', () => {
  for (const annotations of [[], realAnnotations]) {
    const running = round({ checks: [qualityFail], gh: fakeGh({ annotations, run: { status: 'in_progress', run_attempt: 1 } }) });
    assert.equal(running.state, null, 'nothing recorded while the run is going');
    assert.ok(!running.calls.some((call) => call.includes('/annotations')), 'annotations are read after the run finished');
    const finished = round({ checks: [qualityFail], state: running.state });
    assert.deepEqual(finished.reran, ['600'], 'the 504 annotations that arrived later still count');
  }
});

test('an unreadable annotation list is an error for this round only', () => {
  const failed = round({ checks: [qualityFail], gh: fakeGh({ failAnnotations: true }) });
  assert.deepEqual(failed.reran, []);
  assert.equal(failed.errors.length, 1);
  assert.equal(failed.state, null);
  const retried = round({ checks: [qualityFail], state: failed.state });
  assert.deepEqual(retried.reran, ['600']);
});

test('a new head starts over; a green head with no record keeps no state; dry-run posts nothing', () => {
  const first = round({ checks: [qualityFail] });
  const moved = round({ checks: [{ ...qualityFail, head_sha: next, id: 30, details_url: job(900, 30) }], state: first.state, headSha: next });
  assert.equal(moved.state.head, next);
  assert.deepEqual(moved.reran, ['900']);
  const green = round({ checks: [codeqlPass], state: first.state, headSha: next });
  assert.equal(green.state, null);
  assert.deepEqual(green.calls, []);
  const dry = round({ checks: [qualityFail], dryRun: true });
  assert.deepEqual(dry.reran, ['600']);
  assert.ok(!dry.calls.some((call) => call.includes('POST')));
  assert.equal(dry.state, null);
});

// --- the production path: collectPr → processPr (scanOnce) ---

const base = 'b'.repeat(40);
const releaseEpoch = 'ready:PR_10:EV_READY:2026-11-01T00:00:00Z';
const view = () => ({
  id: 'PR_10', number: 10, title: 't', body: '', url: 'https://example.invalid/pull/10', state: 'OPEN', isDraft: false,
  headRefOid: head, headRefName: 'fix/x', baseRefOid: base, baseRefName: 'main', createdAt: '2026-11-01T00:00:00Z',
  author: { login: 'owner' }, isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
});
function collectGh(checkRuns) {
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  return (args) => {
    const endpoint = args[1];
    if (endpoint === 'view') return JSON.stringify(view());
    if (endpoint === 'checks') return '[]';
    if (endpoint === `repos/${repo}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${repo}/rules/branches/main?per_page=100`) return JSON.stringify([[]]);
    if (endpoint === `repos/${repo}/branches/main/protection`) return JSON.stringify({ url: 'x', required_status_checks: null });
    if (endpoint === `repos/${repo}/contents/docs/sync/required-checks.json?ref=${base}`) {
      return JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['verify'], pr_only: [] })).toString('base64') });
    }
    if (endpoint === `repos/${repo}/commits/${head}/check-runs?per_page=100&filter=all`) return JSON.stringify([{ check_runs: checkRuns }]);
    if (endpoint === `repos/${repo}/commits/${head}/statuses?per_page=100`) {
      return JSON.stringify([[{ id: 3, context: 'verify', state: 'success', created_at: '2026-11-08T10:10:00Z' }]]);
    }
    if (endpoint === `repos/${repo}/actions/workflows/review-pr.yml`) return JSON.stringify({ path: '.github/workflows/review-pr.yml', state: 'active' });
    if (endpoint === `repos/${repo}/actions/variables/MIVO_REVIEW_MODE`) return JSON.stringify({ name: 'MIVO_REVIEW_MODE', value: 'live' });
    if (endpoint === 'graphql') {
      const query = String(args.at(-1));
      if (query.includes('mergeStateStatus')) return JSON.stringify({ data: { node: { mergeStateStatus: 'CLEAN', baseRef: { name: 'main', target: { oid: base } } } } });
      if (query.includes('timelineItems(')) return JSON.stringify({ data: { node: { timelineItems: page([{ __typename: 'ReadyForReviewEvent', id: 'EV_READY', createdAt: '2026-11-01T00:00:00Z' }]) } } });
      const field = ['reviewThreads', 'comments', 'reviews', 'labels'].find((name) => query.includes(`${name}(`)) ?? 'labels';
      return JSON.stringify({ data: { node: { [field]: page([]) } } });
    }
    return '[]';
  };
}
const listedPr = () => handoffPr({ number: 10, id: 'PR_10', headRefOid: head, baseRefOid: base, headRefName: 'fix/x', title: 't', isDraft: false, releaseEpoch });
const prRef = { number: 10, id: 'PR_10', headRefOid: head, baseRefOid: base };
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeql-infra-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = watcherPaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  const listed = listedPr();
  fs.writeFileSync(paths.statePath, JSON.stringify({ version: 2, repo: REPO, prs: { PR_10: {
    number: 10, nodeId: 'PR_10', sessionId: 's1', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: listed.releaseEpoch, handoff: handoffReceipt(listed), activeTask: { status: 'complete' },
  } } }));
  return { paths, listed };
}
function scan({ paths, listed, collected, now, sent = [], posts = [] }) {
  const ghFn = (args) => {
    if (isChildPrList(args)) return '[[]]';
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') { posts.push(args[3]); return ''; }
    if (args[0] === 'api' && /\/check-runs\/\d+\/annotations/.test(args[1])) return JSON.stringify(infraAnnotations);
    if (args[0] === 'api' && /\/actions\/runs\/\d+$/.test(args[1])) return JSON.stringify({ status: 'completed', run_attempt: 1 });
    return args[0] === 'api' ? 'owner' : JSON.stringify([listed]);
  };
  return scanOnce({
    enabled: true, allowDispatch: true, paths, now, ghFn,
    collect: () => withAuthorHandoff(collected, listed),
    ownershipSnapshot: function* () { return { pr: handoffPr(listed) }; },
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 's1' }; },
  });
}

test('watcher round: the 504 Code Quality run is re-run, no repair session; red again → one notice', (t) => {
  const { paths, listed } = home(t);
  const collected = collectPr(prRef, { ghFn: collectGh([codeqlPass, qualityFail, qualityPass]) });
  assert.deepEqual(collected.ci.optional, [], 'Analyze stays out of the optional repair path');
  const sent = [];
  const posts = [];
  scan({ paths, listed, collected, now: '2026-11-08T11:00:00Z', sent, posts });
  assert.deepEqual(posts, [`repos/${repo}/actions/runs/600/rerun-failed-jobs`]);
  assert.deepEqual(sent, []);
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).prs.PR_10.codeqlInfraRerun.runs[600].action, 'rerun');
  assert.deepEqual(pendingEvents(paths.home), []);

  const redAgain = check('Analyze (python)', 'failure', { id: 22, runId: 600, started: '2026-11-08T11:01:00Z' });
  const later = collectPr(prRef, { ghFn: collectGh([codeqlPass, qualityFail, redAgain, qualityPass]) });
  const morePosts = [];
  scan({ paths, listed, collected: later, now: '2026-11-08T11:10:00Z', posts: morePosts });
  assert.deepEqual(morePosts, []);
  const events = pendingEvents(paths.home);
  assert.equal(events.length, 1);
  assert.equal(noticeId(events[0]), `codeql-infra-still-red:10:${head}`);
  assert.match(formatNoticeText(events), /盯梢已自动重跑一次，仍然是红的/);
  assert.match(formatNoticeText(events), /Analyze \(python\)/);
});

// The review server's maintainer-confirmation notice used to open a repair session that could only end no-change.
const gateNotice = {
  id: 6001, user: { login: 'review-app[bot]', type: 'Bot' }, author_association: 'NONE', created_at: '2026-11-08T11:30:00Z', updated_at: '2026-11-08T11:30:00Z',
  body: '本 PR 命中维护者确认门（触发类别：技术架构调整）。作者在豁免名单内，确认门不拦，PR 照常进入自动审查。\n\n<!-- review-pr:product-gate kind=arch issue=https://example.invalid/issues/1 -->',
};
test('watcher round: the maintainer-confirmation notice opens no repair session; another bot comment still does', (t) => {
  const { paths, listed } = home(t);
  const green = collectPr(prRef, { ghFn: collectGh([codeqlPass]) });
  const sent = [];
  scan({ paths, listed, collected: { ...green, comments: [gateNotice] }, now: '2026-11-08T11:40:00Z', sent });
  assert.deepEqual(sent, []);

  const control = home(t);
  const other = { ...gateNotice, id: 6002, body: '本 PR 的某个行为看起来不对，请确认。' };
  const controlSent = [];
  scan({ paths: control.paths, listed: control.listed, collected: { ...green, comments: [other] }, now: '2026-11-08T11:40:00Z', sent: controlSent });
  assert.equal(controlSent.length, 1, 'without the marker the same bot comment is still delivered');
});

// --- the light poll of a bound PR: an unchanged fingerprint must not hide a red Analyze job nobody looked at ---

const pollNow = '2026-11-08T12:30:00Z';
const pollSnap = (checks) => ({
  state: 'OPEN', isDraft: false, headRefOid: head, baseRefOid: base, updatedAt: '2026-11-08T11:34:54Z',
  mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', baseTipOid: base, labels: [], commentCount: 0, reviewCount: 0,
  commentUpdatedAt: null, reviewUpdatedAt: null, unresolvedThreads: 0, checks,
});
// GraphQL form of the poll snapshot: upper-case, no job URL.
const redAnalyze = { name: 'Analyze (python)', status: 'COMPLETED', conclusion: 'FAILURE', id: 2 };
const greenAnalyze = { name: 'Analyze (python)', status: 'COMPLETED', conclusion: 'SUCCESS', id: 1 };

test('codeqlInfraCheckDue: a red Analyze job nobody looked at opens the gate at most every interval', () => {
  const snapshot = pollSnap([greenAnalyze, redAnalyze]);
  const interval = 5 * 60 * 1000;
  assert.equal(codeqlInfraCheckDue({ previous: {}, snapshot, now: pollNow, intervalMs: interval }), true, 'never collected');
  assert.equal(codeqlInfraCheckDue({ previous: { scanCheckedAt: '2026-11-08T12:00:00Z' }, snapshot, now: pollNow, intervalMs: interval }), true);
  assert.equal(codeqlInfraCheckDue({ previous: { scanCheckedAt: '2026-11-08T12:27:00Z' }, snapshot, now: pollNow, intervalMs: interval }), false, 'collected 3 minutes ago');
  const looked = { scanCheckedAt: '2026-11-08T12:00:00Z', codeqlInfraRerun: { head, runs: { 600: { action: 'rerun', at: 'x', checkIds: [2] } } } };
  assert.equal(codeqlInfraCheckDue({ previous: looked, snapshot, now: pollNow, intervalMs: interval }), false, 'already looked at');
  assert.equal(codeqlInfraCheckDue({ previous: looked, snapshot: pollSnap([{ ...redAnalyze, id: 22 }]), now: pollNow, intervalMs: interval }), true, 'a new failed attempt');
  assert.equal(codeqlInfraCheckDue({ previous: { ...looked, codeqlInfraRerun: { ...looked.codeqlInfraRerun, head: next } }, snapshot, now: pollNow, intervalMs: interval }), true, 'records of another head do not count');
  assert.equal(codeqlInfraCheckDue({ previous: {}, snapshot: pollSnap([greenAnalyze, { name: 'verify', status: 'COMPLETED', conclusion: 'FAILURE', id: 5 }]), now: pollNow, intervalMs: interval }), false);
});

function seedBound(paths, checks) {
  const handoff = handoffReceipt({ id: 'PR_10', number: 10, headRefOid: head, releaseEpoch: 'e' });
  writePr(paths.home, 'PR_10', {
    number: 10, nodeId: 'PR_10', sessionId: 'sess-10', eligibilityInitialized: true, eligibility: 'active',
    admissionVerified: true, admissionEpoch: handoff.releaseEpoch, handoff, headRefOid: head, headRefName: 'fix/x',
    activeTask: { dispatchId: 'live-10-old', sessionId: 'sess-10', head, status: 'complete' },
    lastDispatch: { dispatchId: 'live-10-old', at: '2026-11-08T11:36:00Z', recoveryCount: 0 },
    title: '#10-t丨1108', titleDate: '2026-11-08', scanCheckedAt: '2026-11-08T12:00:00Z',
    pollFingerprint: pollFingerprint(normalizePollSnapshot(pollSnap(checks))),
  });
}
function pollBound(paths, { snapshot, checkRuns, now = pollNow, posts = [] }) {
  let collected = 0;
  const ghFn = (args) => {
    if (isChildPrList(args)) return '[[]]';
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') { posts.push(args[3]); return ''; }
    if (args[0] === 'api' && /\/check-runs\/\d+\/annotations/.test(args[1])) return JSON.stringify(infraAnnotations);
    if (args[0] === 'api' && /\/actions\/runs\/\d+$/.test(args[1])) return JSON.stringify({ status: 'completed', run_attempt: 1 });
    if (args[0] === 'api' && String(args[1] ?? '').includes('/rules/branches/')) return '[[]]';
    if (args[0] === 'api') return 'owner';
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_10', state: 'OPEN' });
    return '[]';
  };
  const pr = { id: 'PR_10', number: 10, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
    headRefOid: head, baseRefOid: base, releaseEpoch: 'e' };
  const result = scanOnce({
    mode: 'poll', enabled: true, allowDispatch: true, paths, now, nodeId: 'PR_10', prNumber: 10,
    snapshotFn: () => snapshot, ghFn,
    collect: (...args) => {
      collected += 1;
      return withAuthorHandoff({ pr, mergeable: 'MERGEABLE', admissionVerified: true, checks: [],
        ci: { status: 'green', required: [], checks: checkRuns }, policy: { status: 'verified', required: [] },
        comments: [], reviews: [], threads: [], labels: [], mergeReady: false }, args[0]);
    },
    dispatchFn: () => { throw new Error('no repair session expected'); },
    ownershipSnapshot: function* () { return { pr: handoffPr(pr) }; },
  });
  return { result, collected, posts, entry: readPr(paths.home, 'PR_10') };
}
function pollHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codeql-infra-poll-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = watcherPaths(dir);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

test('bound PR on the light poll: an unchanged fingerprint still collects once and re-runs the 504 run', (t) => {
  const paths = pollHome(t);
  const checks = [greenAnalyze, redAnalyze];
  seedBound(paths, checks);
  const first = pollBound(paths, { snapshot: pollSnap(checks), checkRuns: [codeqlPass, qualityFail, qualityPass] });
  assert.equal(first.collected, 1, 'the gate must open for a red Analyze job nobody looked at');
  assert.deepEqual(first.posts, [`repos/${repo}/actions/runs/600/rerun-failed-jobs`]);
  assert.deepEqual(first.entry.codeqlInfraRerun.runs[600].checkIds, [2]);
  const later = pollBound(paths, { snapshot: pollSnap(checks), checkRuns: [codeqlPass, qualityFail, qualityPass], now: '2026-11-08T12:45:00Z' });
  assert.equal(later.collected, 0, 'looked at: the gate stays shut');
  assert.equal(later.result.prs[0].dispatch.reason, 'fingerprint-unchanged');
  assert.deepEqual(later.posts, []);
});

test('bound PR on the light poll: no red Analyze job keeps the gate shut', (t) => {
  const paths = pollHome(t);
  const checks = [greenAnalyze];
  seedBound(paths, checks);
  const out = pollBound(paths, { snapshot: pollSnap(checks), checkRuns: [codeqlPass] });
  assert.equal(out.collected, 0);
  assert.equal(out.result.prs[0].dispatch.reason, 'fingerprint-unchanged');
});
