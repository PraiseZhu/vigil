import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as watcher from './bin/mivo-watcher.mjs';
import { keptReadStore, memoRepoReads, scanOnce, watcherPaths, watchGuideMessage } from './bin/mivo-watcher.mjs';
import { collectMivoCiSync, collectMivoCi } from './bin/mivo-ci.mjs';
import { handoffPr, withAuthorHandoff } from './handoff.fixture.mjs';

// 反馈出现后尽快派发：整轮预算 / 派发预留 / 指纹闸 / 批量跟进 / CI 缓存（SC-1..SC-6）。
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const REPO = 'example-org/example-plugin';
const listedPr = (number, extra = {}) => ({ number, id: `PR_${number}`, headRefOid: HEAD, headRefName: `fix/${number}`,
  title: 'fix', isDraft: false, labels: [], updatedAt: '2026-10-15T00:00:00Z', ...extra });

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-dispatch-'));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-dispatch-plugin-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(plugin, { recursive: true, force: true }); });
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { paths, plugin };
}

function failing(listed) {
  return withAuthorHandoff({
    pr: { id: listed.id, number: listed.number, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
      headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true,
    checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
    ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
    policy: { status: 'verified', required: [{ context: 'unit' }] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  }, listed);
}

// 没有任何反馈的 Ready PR：采集后只剩 no-new-feedback。
function quiet(listed) {
  return withAuthorHandoff({
    pr: { id: listed.id, number: listed.number, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
      headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
    admissionVerified: true,
    checks: [{ name: 'unit', state: 'PENDING', bucket: 'pending' }],
    ci: { status: 'pending', required: [{ context: 'unit', status: 'pending', evidence: { id: 1, runId: 2, attempt: 1 } }] },
    policy: { status: 'verified', required: [{ context: 'unit' }] },
    comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
  }, listed);
}

function* ownership({ pr }) {
  return { pr: handoffPr({ id: `PR_${pr.number}`, number: pr.number, state: 'OPEN', isDraft: false, sameRepository: true,
    author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' }) };
}

const graphqlNode = (extra = {}) => ({
  state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { nodes: [] }, commits: { nodes: [] }, ...extra,
});

function run(t, options) {
  const { paths, plugin } = setup(t);
  return { paths, result: scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin }, ownershipSnapshot: ownership, ...options,
  }) };
}

// ---- SC-1 ----
test('默认整轮预算不超过宿主超时减 15 秒，派发预留不大于 25 秒', () => {
  assert.ok(watcher.ROUND_BUDGET_MS <= 180000 - 15000, `round budget ${watcher.ROUND_BUDGET_MS}`);
  assert.ok(watcher.DISPATCH_RESERVE_MS <= 25000, `dispatch reserve ${watcher.DISPATCH_RESERVE_MS}`);
});

for (const collectMs of [60000, 80000, 100000]) {
  test(`采集 ${collectMs / 1000}s 的 PR 有新反馈时本轮就派发`, (t) => {
    let now = 0;
    const sent = [];
    const { result } = run(t, {
      clock: () => now,
      ghFn: (args) => (args[0] === 'api' && args[1] === 'user' ? 'owner'
        : args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([listedPr(901)]) : '[]'),
      collect: (pr) => { now += collectMs; return failing(pr); },
      dispatchFn: (params) => { sent.push(params.title); return { target_session_id: 'sess-901' }; },
    });
    assert.equal(sent.length, 1);
    assert.equal(result.prs[0].dispatch.attempted, true, JSON.stringify(result.prs[0].dispatch));
  });
}

test('预算确实不足时仍推迟，下一轮优先处理被推迟的 PR', (t) => {
  const { paths, plugin } = setup(t);
  let now = 0;
  const order = [];
  const base = {
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin }, ownershipSnapshot: ownership,
    ghFn: (args) => (args[0] === 'api' && args[1] === 'user' ? 'owner'
      : args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([listedPr(911), listedPr(912)]) : '[]'),
  };
  const first = scanOnce({ ...base, clock: () => now,
    collect: (pr) => { if (pr.number === 912) now += watcher.ROUND_BUDGET_MS - 5000; return failing(pr); },
    dispatchFn: (params) => ({ target_session_id: `sess-${params.title.match(/#(\d+)/)[1]}` }) });
  const deferred = first.prs.filter((item) => item.dispatch.reason === 'dispatch-budget-deferred').map((item) => item.number);
  assert.ok(deferred.includes(912), JSON.stringify(first.prs));
  now = 0;
  scanOnce({ ...base, now: '2026-10-15T00:02:00Z', clock: () => now,
    collect: (pr) => { order.push(pr.number); return failing(pr); },
    dispatchFn: (params) => ({ target_session_id: `sess-${params.title.match(/#(\d+)/)[1]}` }) });
  assert.equal(order[0], 912, `deferred PR first: ${order}`);
});

// ---- SC-3 ----
test('没有修复会话的 Ready PR 指纹未变时跳过全量采集；任一变化都会重新采集', (t) => {
  const { paths, plugin } = setup(t);
  let collects = 0;
  let node = graphqlNode();
  const base = () => ({
    mode: 'discover', enabled: true, allowDispatch: true, paths, gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
    ownershipSnapshot: ownership,
    ghFn: (args) => (args[0] === 'api' && args[1] === 'user' ? 'owner'
      : args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([listedPr(921)])
        : args[0] === 'api' && args[1] === 'graphql' ? JSON.stringify({ data: { node } }) : '[]'),
    collect: (pr) => { collects += 1; return quiet(pr); },
    dispatchFn: () => { throw new Error('nothing to dispatch'); },
  });
  let n = 0;
  const round = () => scanOnce({ ...base(), now: new Date(Date.UTC(2026, 9, 15, 0, n++, 0)).toISOString() });
  round();
  assert.equal(collects, 1, 'first round collects');
  round();
  round();
  assert.equal(collects, 1, 'unchanged fingerprint: no full collection');
  const changes = [
    { comments: { totalCount: 1, nodes: [{ updatedAt: '2026-10-15T00:00:30Z' }] } },
    { reviews: { totalCount: 1, nodes: [{ updatedAt: '2026-10-15T00:00:31Z' }] } },
    { reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ updatedAt: '2026-10-15T00:00:32Z' }] } }] } },
    { headRefOid: 'c'.repeat(40) },
    { commits: { nodes: [{ commit: { checkSuites: { nodes: [{ checkRuns: { nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 7 }] } }] } } }] } },
  ];
  let expected = 1;
  for (const change of changes) {
    node = graphqlNode(change);
    round();
    expected += 1;
    assert.equal(collects, expected, `change ${Object.keys(change)[0]} triggers a collection`);
    round();
    assert.equal(collects, expected, 'and settles again');
  }
});

test('采集失败或预算推迟的无会话 PR 下一轮仍会重新采集', (t) => {
  const { paths, plugin } = setup(t);
  let collects = 0;
  let fail = true;
  const base = () => ({
    mode: 'discover', enabled: true, allowDispatch: true, paths, gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin },
    ownershipSnapshot: ownership,
    ghFn: (args) => (args[0] === 'api' && args[1] === 'user' ? 'owner'
      : args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([listedPr(931)])
        : args[0] === 'api' && args[1] === 'graphql' ? JSON.stringify({ data: { node: graphqlNode() } }) : '[]'),
    collect: (pr) => { collects += 1; if (fail) throw new Error('GitHub 502'); return quiet(pr); },
    dispatchFn: () => { throw new Error('nothing to dispatch'); },
  });
  scanOnce({ ...base(), now: '2026-10-15T00:00:00Z' });
  fail = false;
  scanOnce({ ...base(), now: '2026-10-15T00:01:00Z' });
  assert.equal(collects, 2, 'a failed collection is retried although nothing changed on GitHub');
});

// ---- SC-4 ----
test('跟进间隔默认 15 秒', () => assert.equal(watcher.FOLLOW_INTERVAL_MS, 15000));

function tickFixture(t, { listFor, followMs = 15000 }) {
  let now = 0;
  const lists = [];
  const sent = [];
  const { result } = run(t, {
    clock: () => now, followMs, sleepFn: (ms) => { now += ms; },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') { lists.push(now); return listFor(now); }
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node: graphqlNode() } });
      return '[]';
    },
    collect: (pr) => failing(pr),
    dispatchFn: (params) => { sent.push({ at: now, title: params.title }); return { target_session_id: 'sess-941' }; },
  });
  return { result, lists, sent };
}

test('第 20 秒出现的变化在下一个 15 秒间隔内被处理', (t) => {
  const { lists, sent } = tickFixture(t, {
    listFor: (now) => JSON.stringify([listedPr(941, now >= 20000 ? { updatedAt: '2026-10-15T00:00:20Z' } : { isDraft: true })]),
  });
  assert.deepEqual(sent.map((item) => item.at), [30000]);
  assert.ok(lists.slice(1).every((at, i) => at - lists[i] >= 15000), `lists ${lists}`);
});

test('无变化时每个间隔只发一次批量查询', (t) => {
  const { lists, result } = tickFixture(t, { listFor: () => JSON.stringify([listedPr(942, { isDraft: true })]) });
  assert.ok(lists.length >= 8, `ticks ${lists}`);
  for (let i = 1; i < lists.length; i += 1) assert.equal(lists[i] - lists[i - 1], 15000);
  assert.ok(lists.at(-1) <= watcher.ROUND_BUDGET_MS, 'ticks stay inside the round budget');
  assert.equal(result.prs.length, 1);
});

test('批量查询报错或限流时退避并正常结束本轮', (t) => {
  const { lists, result } = tickFixture(t, {
    listFor: (now) => { if (now > 0) throw new Error('gh: API rate limit exceeded (HTTP 403)'); return JSON.stringify([listedPr(943, { isDraft: true })]); },
  });
  assert.ok(result, 'round still returns');
  const gaps = lists.slice(1).map((at, i) => at - lists[i]);
  assert.ok(gaps.length >= 1 && gaps.length <= 4, `bounded attempts ${gaps}`);
  assert.ok(gaps.every((gap, i) => i === 0 || gap > gaps[i - 1]), `backoff grows ${gaps}`);
});

// ---- SC-5 ----
test('派工消息不再写每分钟 / 45 秒', () => {
  const text = watchGuideMessage({ prNumber: 5 });
  assert.doesNotMatch(text, /每分钟|45\s*秒|every minute|45\s*s\b/i);
});

// ---- SC-2 ----
const rules = [[{ type: 'required_status_checks', ruleset_id: 7,
  parameters: { required_status_checks: [{ context: 'a', integration_id: 15368 }, { context: 'b', integration_id: 15368 }, { context: 'c', integration_id: 15368 }] } }]];
const ciPr = { repo: REPO, number: 5, id: 'PR_1', headRefOid: HEAD, baseRefOid: BASE, state: 'OPEN', isDraft: false };
function ciGh({ completed = true } = {}) {
  const calls = [];
  const fn = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_1', number: 5, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main', state: 'OPEN', isDraft: false });
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${REPO}/rules/branches/main?per_page=100`) return JSON.stringify(rules);
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify({ url: 'x', required_status_checks: null });
    if (endpoint === `repos/${REPO}/contents/docs/sync/required-checks.json?ref=${BASE}`) return JSON.stringify({
      type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['a', 'b', 'c'], pr_only: [] })).toString('base64') });
    if (endpoint === `repos/${REPO}/commits/${HEAD}/check-runs?per_page=100&filter=all`) return JSON.stringify([{ check_runs: ['a', 'b', 'c'].map((name, i) => ({
      id: 11 + i, name, head_sha: HEAD, app: { id: 15368, slug: 'github-actions' }, status: 'completed', conclusion: 'success', started_at: '2026-10-15T10:00:00Z',
      details_url: `https://github.com/${REPO}/actions/runs/${100 + i}/job/${200 + i}` })) }]);
    const job = /actions\/jobs\/(\d+)$/.exec(endpoint ?? '');
    if (job) return JSON.stringify({ id: Number(job[1]), run_id: Number(job[1]) - 100, head_sha: HEAD, run_attempt: 1,
      status: completed ? 'completed' : 'in_progress', check_run_url: `https://api.github.com/repos/${REPO}/check-runs/${Number(job[1]) - 189}` });
    const runMatch = /actions\/runs\/(\d+)$/.exec(endpoint ?? '');
    if (runMatch) return JSON.stringify({ id: Number(runMatch[1]), repository: { full_name: REPO }, head_sha: HEAD, run_attempt: 1,
      status: completed ? 'completed' : 'in_progress' });
    if (endpoint === `repos/${REPO}/commits/${HEAD}/statuses?per_page=100`) return JSON.stringify([[]]);
    if (endpoint?.startsWith(`repos/${REPO}/commits/${HEAD}/check-suites`) || endpoint?.includes('code-scanning')) return JSON.stringify([[]]);
    return '[]';
  };
  const detail = () => calls.filter((call) => /actions\/(jobs|runs)\//.test(call)).length;
  return { fn, calls, detail };
}
function cache() {
  const map = new Map();
  return { get: (key) => map.get(key), set: (key, value) => { map.set(key, value); }, map };
}

test('同一 head 已完成的 job/run 不重复调用 gh，未终态的每轮都查', () => {
  const done = ciGh();
  const store = cache();
  done.fn.ciCache = store;
  const first = collectMivoCiSync({ pr: ciPr, ghFn: done.fn });
  assert.equal(first.status, 'green', first.reason);
  assert.equal(done.detail(), 6);
  collectMivoCiSync({ pr: ciPr, ghFn: done.fn });
  assert.equal(done.detail(), 6, 'second round: completed runs and jobs come from the cache');

  const live = ciGh({ completed: false });
  live.fn.ciCache = cache();
  collectMivoCiSync({ pr: ciPr, ghFn: live.fn });
  collectMivoCiSync({ pr: ciPr, ghFn: live.fn });
  assert.equal(live.detail(), 12, 'non-terminal runs are queried every round');
});

test('多个 required check 的 job/run 查询并发执行，结果不变', async () => {
  const sequential = ciGh();
  const expected = collectMivoCiSync({ pr: ciPr, ghFn: sequential.fn });
  const inner = ciGh();
  let active = 0;
  let peak = 0;
  const fn = async (args) => {
    const detail = /actions\/(jobs|runs)\//.test(args[1] ?? '');
    if (detail) { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 20)); active -= 1; }
    return inner.fn(args);
  };
  const result = await collectMivoCi({ pr: ciPr, ghFn: fn });
  assert.ok(peak >= 3, `peak concurrency ${peak}`);
  assert.deepEqual(result.required.map((r) => [r.context, r.status]), expected.required.map((r) => [r.context, r.status]));
  assert.equal(result.ciHash, expected.ciHash);
});

test('已完成 run/job 的缓存写进 watcher state，下一轮（新的 memoRepoReads）直接复用', (t) => {
  const { paths } = setup(t);
  const first = ciGh();
  const one = collectMivoCiSync({ pr: ciPr, ghFn: memoRepoReads(first.fn, keptReadStore(paths.stateDir, () => 1000)) });
  assert.equal(one.status, 'green', one.reason);
  assert.equal(first.detail(), 6);
  const second = ciGh();
  const two = collectMivoCiSync({ pr: ciPr, ghFn: memoRepoReads(second.fn, keptReadStore(paths.stateDir, () => 61000)) });
  assert.equal(two.status, 'green', two.reason);
  assert.equal(second.detail(), 0, 'a later round reads no completed job or run again');
  assert.deepEqual(two.required.map((item) => item.evidence), one.required.map((item) => item.evidence));
});
