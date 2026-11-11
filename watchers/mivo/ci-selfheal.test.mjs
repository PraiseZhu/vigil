// 2026-11-10: on a Ready PR a 4-second job that reads a branch got HTTP 500, the required format gate that needs it
// was skipped, and for 12 hours nothing happened: the repo's own gate re-run only re-runs failed gates, the pre-review
// waited for green, and this watcher read "skipped" as unknown, which produced no feedback and no notice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateMivoCi } from './bin/mivo-pr-policy.mjs';
import { applyCiTriage, triageText } from './bin/mivo-ci-triage.mjs';
import {
  resolveSkippedRequired, isInfraFailure, redRunsOnHead, superviseCiSelfHeal, heldBySelfHeal, ciSelfHealCheckDue, ciStall,
  CI_STALL_MS, CI_STALL_ROUND_MS, CI_STALL_ROUNDS, CI_STALL_NOTICE_MS, SELFHEAL_HOLD_MS,
} from './bin/mivo-ci-selfheal.mjs';
import { feedbackItems, ciStallCheckDue, CI_STALL_RECHECK_MS, collectPr, scanOnce, watcherPaths, REPO } from './bin/mivo-watcher.mjs';
import { pendingEvents } from './bin/notify.mjs';
import { handoffPr, handoffReceipt, withAuthorHandoff, isChildPrList } from './handoff.fixture.mjs';
import { noticeId, formatNoticeText } from './bin/notify.mjs';

const repo = 'example-org/example-plugin';
const head = 'a'.repeat(40);
const actions = { id: 15368, slug: 'github-actions' };
const job = (runId, id) => `https://github.com/${repo}/actions/runs/${runId}/job/${id}`;
const check = (name, conclusion, { id, runId, started = '2026-11-10T18:33:33Z', done = '2026-11-10T18:33:37Z', status = 'completed', attempt = 1 } = {}) => ({
  id, name, conclusion, status, app: actions, head_sha: head, started_at: started, completed_at: done, details_url: job(runId, id),
  workflowHeadSha: head, runId, runAttempt: attempt,
});
const GATE = 'pr-format-gate (title/body template)';
const policy = { status: 'verified', headSha: head, policyHash: 'p', required: [{ context: GATE, appId: null, sources: ['ruleset:1'] }, { context: 'verify', appId: null, sources: ['ruleset:1'] }] };
const pin = check('control-source / pin', 'failure', { id: 11, runId: 900 });
const gateSkipped = check(GATE, 'skipped', { id: 12, runId: 900 });
const verifyGreen = check('verify', 'success', { id: 13, runId: 901 });
const evaluate = (checks) => resolveSkippedRequired(evaluateMivoCi({ policy, headSha: head, checks, statuses: [] }), { checks, repo });

// Drives a supervisor generator with a fake gh; returns its result and the calls made.
function drive(iterator, respond) {
  const calls = [];
  let step = iterator.next();
  while (!step.done) {
    try {
      const value = step.value();
      step = iterator.next(value);
    } catch (error) { step = iterator.throw(error); }
  }
  return { result: step.value, calls };
}
function supervise({ ci, state = null, now = '2026-11-10T18:40:00Z', runs = {}, annotations = {}, dryRun = false, failPost = false }) {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args.join(' '));
    const path = args.at(-1);
    if (args.includes('POST')) { if (failPost) throw new Error('This workflow is already running'); return '{}'; }
    const run = /actions\/runs\/(\d+)$/.exec(path);
    if (run) return JSON.stringify(runs[run[1]] ?? { status: 'completed', run_attempt: 1 });
    const ann = /check-runs\/(\d+)\/annotations/.exec(path);
    if (ann) return JSON.stringify(annotations[ann[1]] ?? []);
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const { result } = drive(superviseCiSelfHeal({ ci, repo, headSha: head, state, ghFn, now, dryRun }));
  return { result, calls, posts: calls.filter((call) => call.includes('POST')) };
}

// --- a required check skipped behind a failed job ---

test('a skipped required check alone stays unknown, with its own reason', () => {
  const result = evaluate([gateSkipped, verifyGreen]);
  assert.equal(result.status, 'unknown');
  assert.equal(result.required.find((rule) => rule.context === GATE).reason, 'required-check-skipped');
});

test('a required check skipped behind a failed job of the same run is a failure of that job', () => {
  const result = evaluate([pin, gateSkipped, verifyGreen]);
  assert.equal(result.status, 'failed');
  const rule = result.required.find((item) => item.context === GATE);
  assert.equal(rule.status, 'failed');
  assert.equal(rule.reason, 'required-check-skipped-upstream-failed');
  assert.deepEqual(rule.skippedBy, ['control-source / pin']);
  assert.equal(rule.evidence.id, 11);
  assert.equal(rule.evidence.runId, 900);
  assert.equal(rule.evidence.skippedCheckId, 12);
});

test('a failed job of another run does not explain the skip', () => {
  const other = check('control-source / pin', 'failure', { id: 21, runId: 950 });
  assert.equal(evaluate([other, gateSkipped, verifyGreen]).status, 'unknown');
});

test('the triage written where the skip was found survives applyCiTriage and tells the session what to do', () => {
  const triaged = applyCiTriage(evaluate([pin, gateSkipped, verifyGreen]), { checks: [pin, gateSkipped, verifyGreen] });
  const rule = triaged.required.find((item) => item.context === GATE);
  assert.equal(rule.status, 'failed');
  assert.equal(rule.triage.kind, 'skipped-upstream');
  const text = triageText(rule.triage);
  assert.match(text, /control-source \/ pin/);
  assert.match(text, /gh run rerun 900 --failed/);
});

test('the skipped-upstream failure reaches the session as a verified required-CI item', () => {
  const ci = { ...applyCiTriage(evaluate([pin, gateSkipped, verifyGreen]), { checks: [pin, gateSkipped, verifyGreen] }), optional: [] };
  const items = feedbackItems({ pr: { headRefOid: head }, ci }).filter((item) => item.source === 'ci');
  assert.equal(items.length, 1);
  assert.equal(items[0].repairPolicy.action, 'required-ci-fix');
  assert.equal(items[0].requiredFailure.runId, 900);
  assert.equal(items[0].requiredFailure.checkId, 11);
});

// --- the re-run ---

test('the run behind a skipped required check is re-run once, without reading annotations', () => {
  const checks = [pin, gateSkipped, verifyGreen];
  const ci = { ...evaluate(checks), checks };
  const first = supervise({ ci });
  assert.deepEqual(first.posts, [`api --method POST repos/${repo}/actions/runs/900/rerun-failed-jobs`]);
  assert.deepEqual(first.result.reran, ['900']);
  assert.equal(first.result.state.runs['900'].action, 'rerun');
  assert.equal(first.result.state.runs['900'].reason, 'skipped-upstream');
  assert.ok(!first.calls.some((call) => call.includes('annotations')));
  const second = supervise({ ci, state: first.result.state, now: '2026-11-10T18:44:00Z' });
  assert.deepEqual(second.posts, []);
});

test('a job that failed on a server error is re-run; a real failure is left to the repair session', () => {
  const unit = check('Linux unit shard (1/4)', 'failure', { id: 31, runId: 910 });
  const lint = check('lint + tsc + unit + logging', 'failure', { id: 32, runId: 911 });
  const ci = { status: 'failed', required: [], checks: [unit, lint] };
  const { result, posts } = supervise({ ci, annotations: {
    // The shape GitHub really reports: the error line plus the generic exit-code line of the failed step.
    31: [{ annotation_level: 'failure', message: 'Error: Unexpected HTTP response: 503' }, { annotation_level: 'failure', message: 'Process completed with exit code 1.' }, { annotation_level: 'warning', message: 'Node 20 is deprecated' }],
    32: [{ annotation_level: 'failure', message: "src/a.ts(3,1): error TS2322: Type 'string' is not assignable to type 'number'." }, { annotation_level: 'failure', message: 'Process completed with exit code 2.' }],
  } });
  assert.deepEqual(posts, [`api --method POST repos/${repo}/actions/runs/910/rerun-failed-jobs`]);
  assert.equal(result.state.runs['910'].action, 'rerun');
  assert.equal(result.state.runs['911'].action, 'not-infra');
});

test('one real failure beside an infrastructure failure in the same run: no re-run', () => {
  const a = check('Linux unit shard (1/4)', 'failure', { id: 41, runId: 920 });
  const b = check('Linux unit shard (2/4)', 'failure', { id: 42, runId: 920 });
  const { result, posts } = supervise({ ci: { status: 'failed', required: [], checks: [a, b] }, annotations: {
    41: [{ annotation_level: 'failure', message: 'The hosted runner: GitHub Actions 7 lost communication with the server.' }],
    42: [{ annotation_level: 'failure', message: 'AssertionError: expected 1 to be 2' }],
  } });
  assert.deepEqual(posts, []);
  assert.equal(result.state.runs['920'].action, 'not-infra');
});

test('a run that is still going is judged later and nothing is recorded', () => {
  const checks = [pin, gateSkipped];
  const { result, posts } = supervise({ ci: { ...evaluate(checks), checks }, runs: { 900: { status: 'in_progress', run_attempt: 1 } } });
  assert.deepEqual(posts, []);
  assert.equal(result.state, null);
});

test('a run already on its third attempt is not re-run again', () => {
  const checks = [pin, gateSkipped];
  const { result, posts } = supervise({ ci: { ...evaluate(checks), checks }, runs: { 900: { status: 'completed', run_attempt: 3 } } });
  assert.deepEqual(posts, []);
  assert.equal(result.state.runs['900'].action, 'attempts-exhausted');
});

test('a refused re-run is reported and tried again on a later round', () => {
  const checks = [pin, gateSkipped];
  const { result } = supervise({ ci: { ...evaluate(checks), checks }, failPost: true });
  assert.equal(result.state, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /already running/);
  const retry = supervise({ ci: { ...evaluate(checks), checks }, state: result.state, now: '2026-11-10T18:44:00Z' });
  assert.equal(retry.posts.length, 1);
});

test('dry run asks for nothing and records nothing', () => {
  const checks = [pin, gateSkipped];
  const { result, posts } = supervise({ ci: { ...evaluate(checks), checks }, dryRun: true });
  assert.deepEqual(posts, []);
  assert.equal(result.state, null);
  assert.deepEqual(result.reran, ['900']);
});

test('gates, aggregates and CodeQL jobs are never the reason for a re-run', () => {
  const freshness = check('pr-ci-freshness', 'failure', { id: 51, runId: 930 });
  const verify = check('verify', 'failure', { id: 52, runId: 931 });
  const analyze = check('Analyze (python)', 'failure', { id: 53, runId: 932 });
  const { result, posts, calls } = supervise({ ci: { status: 'failed', required: [], checks: [freshness, verify, analyze] } });
  assert.deepEqual(posts, []);
  assert.deepEqual(calls, []);
  assert.equal(result.state.runs['930'].action, 'not-infra');
  assert.equal(result.state.runs['931'].action, 'not-infra');
  assert.equal(result.state.runs['932'], undefined);
  assert.equal(redRunsOnHead({ checks: [analyze], repo, headSha: head }).size, 0);
});

test('annotations: only failure-level lines count, and all of them must be infrastructure', () => {
  assert.equal(isInfraFailure([{ annotation_level: 'failure', message: 'HTTP status code: 502' }]), true);
  assert.equal(isInfraFailure([{ annotation_level: 'failure', message: 'connect ETIMEDOUT 140.82.112.5:443' }]), true);
  assert.equal(isInfraFailure([{ annotation_level: 'failure', message: 'Process completed with exit code 1.' }]), false);
  assert.equal(isInfraFailure([{ annotation_level: 'failure', message: 'HTTP status code: 502' }, { annotation_level: 'failure', message: 'Process completed with exit code 1.' }]), true);
  assert.equal(isInfraFailure([{ annotation_level: 'failure', message: 'expected 1 to be 2' }, { annotation_level: 'failure', message: 'HTTP 503' }]), false);
  assert.equal(isInfraFailure([{ annotation_level: 'warning', message: 'HTTP 503' }]), false);
  assert.equal(isInfraFailure([]), false);
});

// --- holding the failure back while the re-run is out ---

test('the failure of a run that was just re-run is held back; the result of the re-run is not', () => {
  const state = { head, runs: { 900: { action: 'rerun', at: '2026-11-10T18:40:00Z', attempt: 1, checkIds: [11] } } };
  const item = (checkId) => ({ source: 'ci', sha: head, requiredFailure: { verified: true, status: 'failed', headSha: head, checkId, runId: 900 } });
  assert.equal(heldBySelfHeal(state, item(11), '2026-11-10T18:44:00Z'), true);
  assert.equal(heldBySelfHeal(state, item(99), '2026-11-10T18:44:00Z'), false);
  assert.equal(heldBySelfHeal(state, { source: 'ci', sha: head, optionalFailure: { checkId: 11, runId: 900 } }, '2026-11-10T18:44:00Z'), true);
  const late = new Date(Date.parse('2026-11-10T18:40:00Z') + SELFHEAL_HOLD_MS).toISOString();
  assert.equal(heldBySelfHeal(state, item(11), late), false);
  assert.equal(heldBySelfHeal({ ...state, runs: { 900: { ...state.runs[900], action: 'not-infra' } } }, item(11), '2026-11-10T18:44:00Z'), false);
  assert.equal(heldBySelfHeal(state, { ...item(11), sha: 'b'.repeat(40) }, '2026-11-10T18:44:00Z'), false);
  assert.equal(heldBySelfHeal(null, item(11), '2026-11-10T18:44:00Z'), false);
});

test('light poll: a red check no round has judged forces one full collection per interval', () => {
  const snapshot = { headRefOid: head, checks: [{ id: 11, name: 'control-source / pin', status: 'COMPLETED', conclusion: 'FAILURE' }] };
  const base = { previous: { scanCheckedAt: '2026-11-10T18:00:00Z' }, snapshot, now: '2026-11-10T18:10:00Z', intervalMs: 300000 };
  assert.equal(ciSelfHealCheckDue(base), true);
  assert.equal(ciSelfHealCheckDue({ ...base, now: '2026-11-10T18:02:00Z' }), false);
  const judged = { scanCheckedAt: '2026-11-10T18:00:00Z', ciSelfHeal: { head, runs: { 900: { action: 'not-infra', checkIds: [11] } } } };
  assert.equal(ciSelfHealCheckDue({ ...base, previous: judged }), false);
  assert.equal(ciSelfHealCheckDue({ ...base, snapshot: { headRefOid: head, checks: [{ id: 5, name: 'verify', status: 'COMPLETED', conclusion: 'SUCCESS' }] } }), false);
});

// --- CI that stays unknown after everything finished ---

const missingRule = { context: 'verify', appId: null, status: 'unknown', reason: 'required-check-missing', evidence: null };
const stalledCi = { status: 'unknown', required: [missingRule], optional: [], checks: [gateSkipped] };
const after = (ms) => new Date(Date.parse(gateSkipped.completed_at) + ms).toISOString();

test('CI is not stalled before the wait is over, while a check still runs, or when it is not unknown', () => {
  assert.equal(ciStall({ ci: stalledCi, headSha: head, now: after(CI_STALL_MS - 1000) }), null);
  const running = { ...stalledCi, checks: [gateSkipped, check('verify', null, { id: 14, runId: 901, status: 'in_progress', done: null })] };
  assert.equal(ciStall({ ci: running, headSha: head, now: after(CI_STALL_MS) }), null);
  assert.equal(ciStall({ ci: { ...stalledCi, status: 'failed' }, headSha: head, now: after(CI_STALL_MS) }), null);
  assert.equal(ciStall({ ci: { status: 'unknown', required: [], reason: 'policy-or-snapshot-unverified' }, headSha: head, now: after(CI_STALL_MS) }), null);
});

test('a stall is diagnosed a bounded number of times per head, then it is a notice', () => {
  const rounds = [];
  for (let ms = CI_STALL_MS; ms < CI_STALL_NOTICE_MS + CI_STALL_ROUND_MS; ms += 15 * 60 * 1000) {
    const stall = ciStall({ ci: stalledCi, headSha: head, now: after(ms) });
    if (stall) rounds.push(stall.round);
  }
  assert.deepEqual([...new Set(rounds)], [...Array(CI_STALL_ROUNDS).keys()]);
  assert.equal(ciStall({ ci: stalledCi, headSha: head, now: after(CI_STALL_NOTICE_MS) }), null);
});

test('a stall becomes one repair item whose revision only changes with the round', () => {
  const pr = { headRefOid: head };
  const first = feedbackItems({ pr, ci: stalledCi, now: after(CI_STALL_MS) }).filter((item) => item.source === 'ci');
  assert.equal(first.length, 1);
  assert.equal(first[0].nativeId, 'stall');
  assert.equal(first[0].repairPolicy.action, 'required-ci-fix');
  assert.equal(first[0].repairPolicy.reason, 'verified-ci-stall');
  assert.match(first[0].body, /verify: required-check-missing/);
  const sameRound = feedbackItems({ pr, ci: stalledCi, now: after(CI_STALL_MS + 20 * 60 * 1000) }).find((item) => item.nativeId === 'stall');
  assert.equal(sameRound.revision, first[0].revision);
  assert.equal(sameRound.contentHash, first[0].contentHash);
  const nextRound = feedbackItems({ pr, ci: stalledCi, now: after(CI_STALL_MS + CI_STALL_ROUND_MS) }).find((item) => item.nativeId === 'stall');
  assert.notEqual(nextRound.revision, first[0].revision);
  assert.equal(feedbackItems({ pr, ci: stalledCi }).filter((item) => item.source === 'ci').length, 0);
});

test('light poll: unknown CI is collected in full again once the stall wait is over', () => {
  const since = '2026-11-10T18:33:39Z';
  const at = (ms) => new Date(Date.parse(since) + ms).toISOString();
  assert.equal(ciStallCheckDue({ policyUnknownSince: since, scanCheckedAt: since }, at(CI_STALL_MS - 1000)), false);
  assert.equal(ciStallCheckDue({ policyUnknownSince: since, scanCheckedAt: since }, at(CI_STALL_MS)), true);
  assert.equal(ciStallCheckDue({ policyUnknownSince: since, scanCheckedAt: at(CI_STALL_MS) }, at(CI_STALL_MS + CI_STALL_RECHECK_MS - 1000)), false);
  assert.equal(ciStallCheckDue({ policyUnknownSince: null, scanCheckedAt: since }, at(CI_STALL_NOTICE_MS)), false);
});

test('the stall notice is sent once per head and says what is missing', () => {
  const event = { kind: 'ci-stalled', number: 7, head, url: 'https://github.com/example-org/example-plugin/pull/7', since: '2026-11-10T18:33:39Z', checks: ['verify: required-check-missing'] };
  assert.equal(noticeId(event), `ci-stalled:7:${head}`);
  const text = formatNoticeText([event]);
  assert.match(text, /PR #7/);
  assert.match(text, /verify: required-check-missing/);
});

// --- the production path: collectPr → processPr (scanOnce) ---

const base = 'b'.repeat(40);
const releaseEpoch = 'ready:PR_10:EV_READY:2026-11-01T00:00:00Z';
const view = () => ({
  id: 'PR_10', number: 10, title: 't', body: '', url: 'https://example.invalid/pull/10', state: 'OPEN', isDraft: false,
  headRefOid: head, headRefName: 'fix/x', baseRefOid: base, baseRefName: 'main', createdAt: '2026-11-01T00:00:00Z',
  author: { login: 'owner' }, isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', reviewDecision: null,
});
// What REST returns for a check run: no run fields, they are read from the job and the run.
const rest = ({ workflowHeadSha, runId, runAttempt, ...item }) => item;
function collectGh(checkRuns, { attempt = 1 } = {}) {
  const page = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  return (args) => {
    const endpoint = args[1];
    if (endpoint === 'view') return JSON.stringify(view());
    if (endpoint === 'checks') return '[]';
    if (endpoint === `repos/${repo}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${repo}/rules/branches/main?per_page=100`) return JSON.stringify([[]]);
    if (endpoint === `repos/${repo}/branches/main/protection`) return JSON.stringify({ url: 'x', required_status_checks: null });
    if (endpoint === `repos/${repo}/contents/docs/sync/required-checks.json?ref=${base}`) {
      return JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: [GATE], pr_only: [] })).toString('base64') });
    }
    if (endpoint === `repos/${repo}/commits/${head}/check-runs?per_page=100&filter=all`) return JSON.stringify([{ check_runs: checkRuns.map(rest) }]);
    if (endpoint === `repos/${repo}/commits/${head}/statuses?per_page=100`) return JSON.stringify([[]]);
    const jobRead = new RegExp(`^repos/${repo}/actions/jobs/(\\d+)$`).exec(endpoint ?? '');
    if (jobRead) {
      const item = checkRuns.find((entry) => String(entry.id) === jobRead[1]);
      return JSON.stringify({ id: item.id, run_id: item.runId, head_sha: head, run_attempt: attempt, status: 'completed', conclusion: item.conclusion,
        check_run_url: `https://api.github.com/repos/${repo}/check-runs/${item.id}`, steps: [] });
    }
    const runRead = new RegExp(`^repos/${repo}/actions/runs/(\\d+)$`).exec(endpoint ?? '');
    if (runRead) return JSON.stringify({ id: Number(runRead[1]), repository: { full_name: repo }, head_sha: head, run_attempt: attempt, status: 'completed' });
    if (endpoint === `repos/${repo}/actions/workflows/review-pr.yml`) return JSON.stringify({ path: '.github/workflows/review-pr.yml', state: 'active' });
    if (endpoint === `repos/${repo}/actions/variables/MIVO_REVIEW_MODE`) return JSON.stringify({ name: 'MIVO_REVIEW_MODE', value: 'live' });
    if (endpoint === 'graphql') {
      const query = String(args.at(-1));
      if (query.includes('mergeStateStatus')) return JSON.stringify({ data: { node: { mergeStateStatus: 'BLOCKED', baseRef: { name: 'main', target: { oid: base } } } } });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-selfheal-'));
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
function scan({ paths, listed, collected, now, sent = [], posts = [], runAttempt = 1 }) {
  const ghFn = (args) => {
    if (isChildPrList(args)) return '[[]]';
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') { posts.push(args[3]); return ''; }
    if (args[0] === 'api' && /\/actions\/runs\/\d+$/.test(args[1])) return JSON.stringify({ status: 'completed', run_attempt: runAttempt });
    return args[0] === 'api' ? 'owner' : JSON.stringify([listed]);
  };
  return scanOnce({
    enabled: true, allowDispatch: true, paths, now, ghFn,
    collect: () => withAuthorHandoff(collected, listed),
    ownershipSnapshot: function* () { return { pr: handoffPr(listed) }; },
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 's1' }; },
  });
}

test('watcher round: the run behind a skipped required check is re-run and no session is opened; red again → a repair session', (t) => {
  assert.equal(REPO, repo);
  const { paths, listed } = home(t);
  const collected = collectPr(prRef, { ghFn: collectGh([pin, gateSkipped]) });
  assert.equal(collected.ci.status, 'failed', 'the skip behind a failed job is a failure, not an unknown');
  assert.deepEqual(collected.ci.optional.map((rule) => rule.context), ['control-source / pin']);
  const sent = [];
  const posts = [];
  scan({ paths, listed, collected, now: '2026-11-10T18:40:00Z', sent, posts });
  assert.deepEqual(posts, [`repos/${repo}/actions/runs/900/rerun-failed-jobs`]);
  assert.deepEqual(sent, [], 'the failure of the attempt that was just re-run is held back');
  const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).prs.PR_10;
  assert.equal(state.ciSelfHeal.runs[900].action, 'rerun');
  assert.deepEqual(pendingEvents(paths.home), []);

  // The re-run failed the same way: new check ids, the next attempt of the same run.
  const pinAgain = check('control-source / pin', 'failure', { id: 111, runId: 900, started: '2026-11-10T18:41:00Z', done: '2026-11-10T18:41:05Z', attempt: 2 });
  const gateAgain = check(GATE, 'skipped', { id: 112, runId: 900, started: '2026-11-10T18:41:05Z', done: '2026-11-10T18:41:05Z', attempt: 2 });
  const later = collectPr(prRef, { ghFn: collectGh([pin, gateSkipped, pinAgain, gateAgain], { attempt: 2 }) });
  const morePosts = [];
  scan({ paths, listed, collected: later, now: '2026-11-10T18:48:00Z', sent, posts: morePosts, runAttempt: 2 });
  assert.deepEqual(morePosts, [], 'one re-run per run and head');
  assert.equal(sent.length, 1, 'the second failure goes to a repair session');
});

// The self-review pilot (self-review.test.mjs): what a round is asked is written into its task file at dispatch, and
// the helper goes by the task. Checked on a real dispatch, because nothing else reads the file the watcher writes.
test('watcher round: with the self-review switch on, the task of a round that may change code says so; with it off, the field is absent', (t) => {
  const before = process.env.MIVO_PREFLIGHT_SELF_REVIEW;
  t.after(() => { if (before === undefined) delete process.env.MIVO_PREFLIGHT_SELF_REVIEW; else process.env.MIVO_PREFLIGHT_SELF_REVIEW = before; });
  const lint = check('lint + tsc + unit + logging', 'failure', { id: 61, runId: 960 });
  const dispatchedTask = (value) => {
    if (value === undefined) delete process.env.MIVO_PREFLIGHT_SELF_REVIEW; else process.env.MIVO_PREFLIGHT_SELF_REVIEW = value;
    const { paths, listed } = home(t);
    const gh = collectGh([lint]);
    const collected = collectPr(prRef, { ghFn: (args) => (args[1] === `repos/${repo}/contents/docs/sync/required-checks.json?ref=${base}`
      ? JSON.stringify({ type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['lint + tsc + unit + logging'], pr_only: [] })).toString('base64') }) : gh(args)) });
    assert.equal(collected.ci.status, 'failed');
    const sent = [];
    scan({ paths, listed, collected, now: '2026-11-10T18:40:00Z', sent });
    assert.equal(sent.length, 1);
    const dir = path.join(paths.stateDir, 'tasks');
    return JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'utf8'));
  };
  assert.equal(dispatchedTask('true').selfReviewRequired, true);
  assert.equal(Object.hasOwn(dispatchedTask(undefined), 'selfReviewRequired'), false);
});

test('watcher round: the stall notice needs 6.5 hours of unknown on this head with every check finished; a push starts the clock again', (t) => {
  const { paths, listed } = home(t);
  const seedSince = (extra) => {
    const state = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
    state.prs.PR_10 = { ...state.prs.PR_10, ...extra };
    fs.writeFileSync(paths.statePath, JSON.stringify(state));
  };
  // The gate was skipped by its own condition: no failed job beside it, so CI is unknown.
  const collected = collectPr(prRef, { ghFn: collectGh([gateSkipped]) });
  assert.equal(collected.ci.status, 'unknown');
  const now = '2026-11-11T02:00:00Z';
  // Unknown for 7 hours, but that clock was started on another head.
  seedSince({ policyUnknownSince: '2026-11-10T19:00:00Z', policyUnknownHead: 'd'.repeat(40) });
  scan({ paths, listed, collected, now });
  assert.deepEqual(pendingEvents(paths.home).filter((event) => event.kind === 'ci-stalled'), []);
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).prs.PR_10.policyUnknownSince, now);
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8')).prs.PR_10.policyUnknownHead, head);
  // On this head for 7 hours, but a check started a while ago is still running: not a stall yet.
  const running = (started) => ({ ...collected, ci: { ...collected.ci, checks: [...collected.ci.checks, { ...rest(check('Linux unit shard (1/4)', null, { id: 77, runId: 990, started, done: null, status: 'in_progress' })) }] } });
  seedSince({ policyUnknownSince: '2026-11-10T19:00:00Z', policyUnknownHead: head });
  scan({ paths, listed, collected: running('2026-11-11T01:30:00Z'), now: '2026-11-11T02:02:00Z' });
  assert.deepEqual(pendingEvents(paths.home).filter((event) => event.kind === 'ci-stalled'), []);
  // The same check "running" for the whole notice period will not finish by itself: a person hears about it.
  scan({ paths, listed, collected: running('2026-11-10T19:00:00Z'), now: '2026-11-11T02:03:00Z' });
  assert.equal(pendingEvents(paths.home).filter((event) => event.kind === 'ci-stalled').length, 1);
  // The same 7 hours on this head.
  seedSince({ policyUnknownSince: '2026-11-10T19:00:00Z', policyUnknownHead: head });
  scan({ paths, listed, collected, now: '2026-11-11T02:04:00Z' });
  // Every check finished: the notice is the same one (one per head), with the time the unknown started.
  const events = pendingEvents(paths.home).filter((event) => event.kind === 'ci-stalled');
  assert.equal(events.length, 1);
  assert.equal(events[0].since, '2026-11-10T19:00:00Z');
});
