import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPr, statePaths } from './bin/cindy-state.mjs';
import * as watcher from './bin/cindy-watcher.mjs';
import { keptReadStore, memoRepoReads, scanOnce, watcherPaths, watchGuideMessage } from './bin/cindy-watcher.mjs';
import { collectCindyCiSync, collectCindyCi } from './bin/cindy-ci.mjs';

// 反馈出现后尽快派发：整轮预算 / 派发预留 / 指纹闸 / 批量跟进 / CI 缓存（SC-1..SC-6）。
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const FORK = { sameRepository: false, isCrossRepository: true, author: { login: 'owner' },
  headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' } };
const REPO = 'example-org/example-app';
const listedPr = (number, extra = {}) => ({ number, id: `PR_${number}`, headRefOid: HEAD, headRefName: `fix/${number}`,
  title: 'fix', isDraft: false, labels: [], updatedAt: '2026-10-15T00:00:00Z', ...FORK, ...extra });

function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-fast-dispatch-'));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-fast-dispatch-plugin-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(plugin, { recursive: true, force: true }); });
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return { paths, plugin };
}

const failing = (listed) => ({
  pr: { id: listed.id, number: listed.number, state: 'OPEN', isDraft: false, ...FORK, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
  admissionVerified: true,
  checks: [{ name: 'unit', state: 'FAILURE', bucket: 'fail' }],
  ci: { status: 'failed', required: [{ context: 'unit', status: 'failed', evidence: { id: 1, runId: 2, attempt: 1 } }] },
  policy: { status: 'verified', required: [{ context: 'unit' }] },
  comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
});

// 没有任何反馈的 Ready PR：采集后只剩 no-new-feedback。
const quiet = (listed) => ({
  pr: { id: listed.id, number: listed.number, state: 'OPEN', isDraft: false, ...FORK, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
  admissionVerified: true,
  checks: [{ name: 'unit', state: 'PENDING', bucket: 'pending' }],
  ci: { status: 'pending', required: [{ context: 'unit', status: 'pending', evidence: { id: 1, runId: 2, attempt: 1 } }] },
  policy: { status: 'verified', required: [{ context: 'unit' }] },
  comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
});

function* ownership() {
  return { pr: { state: 'OPEN', isDraft: false, ...FORK, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' } };
}

const graphqlNode = (extra = {}) => ({
  state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { nodes: [] }, commits: { nodes: [] }, ...extra,
});

// 一次批量查询（gh api graphql search）返回的每个 open PR 的轻量指纹字段，含最新提交的 CI 汇总 state。
const batchNode = (pr, rollup = 'SUCCESS') => ({ id: pr.id, number: pr.number, isDraft: pr.isDraft === true, headRefOid: pr.headRefOid,
  updatedAt: pr.updatedAt, labels: { nodes: (pr.labels ?? []).map((name) => ({ name })) },
  commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] } });
const batchResponse = (prs, rollupFor = () => 'SUCCESS') => JSON.stringify({ data: { search: { issueCount: prs.length,
  nodes: prs.map((pr) => batchNode(pr, rollupFor(pr))) } } });
const isBatch = (args) => args[0] === 'api' && args[1] === 'graphql' && args.some((arg) => String(arg).includes('search('));
const isGate = (args) => args[0] === 'api' && args[1] === 'graphql' && !isBatch(args);

function run(t, options) {
  const { paths, plugin } = setup(t);
  return { paths, result: scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin }, ownershipSnapshot: ownership, ...options,
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
    gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin }, ownershipSnapshot: ownership,
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
    mode: 'discover', enabled: true, allowDispatch: true, paths, gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin },
    ownershipSnapshot: ownership, fullCollectMs: 1e12,
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
    mode: 'discover', enabled: true, allowDispatch: true, paths, gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin },
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

// ---- SC-4 / R3 / R4 ----
test('跟进间隔默认 15 秒', () => assert.equal(watcher.FOLLOW_INTERVAL_MS, 15000));

// listFor(now) 给出此刻的 open PR 列表；rollupFor(pr, now) 给出最新提交的 CI 汇总 state。
function tickFixture(t, { listFor, rollupFor = () => 'SUCCESS', followMs = 15000, collect = (pr) => failing(pr), gate = () => graphqlNode(), extra = {} }) {
  let now = 0;
  const lists = [];
  const batches = [];
  const gates = [];
  const sent = [];
  const { result } = run(t, {
    clock: () => now, followMs, sleepFn: (ms) => { now += ms; },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') { lists.push(now); return listFor(now); }
      if (isBatch(args)) { batches.push(now); return batchResponse(JSON.parse(listFor(now)), (pr) => rollupFor(pr, now)); }
      if (isGate(args)) { gates.push(now); return JSON.stringify({ data: { node: gate(now) } }); }
      return '[]';
    },
    collect,
    dispatchFn: (params) => { sent.push({ at: now, title: params.title }); return { target_session_id: 'sess-941' }; },
    ...extra,
  });
  return { result, lists, batches, gates, sent, elapsed: () => now };
}

test('第 20 秒出现的变化在下一个 15 秒间隔内被处理', (t) => {
  const { batches, sent } = tickFixture(t, {
    listFor: (now) => JSON.stringify([listedPr(941, now >= 20000 ? { updatedAt: '2026-10-15T00:00:20Z' } : { isDraft: true })]),
  });
  assert.deepEqual(sent.map((item) => item.at), [30000]);
  assert.ok(batches.slice(1).every((at, i) => at - batches[i] >= 15000), `batches ${batches}`);
});

test('无变化时每个间隔只发一次批量查询，并一直查到整轮预算末尾（最后一拍在 150–165 秒内，一轮约 150–160 秒结束）', (t) => {
  const { batches, lists, result, elapsed } = tickFixture(t, { listFor: () => JSON.stringify([listedPr(942, { isDraft: true })]) });
  for (let i = 1; i < batches.length; i += 1) assert.equal(batches[i] - batches[i - 1], 15000);
  assert.equal(lists.length, 1, 'only the opening listing uses gh pr list');
  const budget = watcher.ROUND_BUDGET_MS;
  assert.ok(batches.at(-1) >= budget - 15000 && batches.at(-1) <= budget, `last batch ${batches.at(-1)} of ${budget}`);
  assert.ok(elapsed() >= budget - 15000 && elapsed() <= budget, `the quiet round ran ${elapsed()} ms of ${budget}`);
  assert.equal(result.prs.length, 1);
});

test('批量查询报错或限流时退避并正常结束本轮', (t) => {
  const { batches, result } = tickFixture(t, {
    listFor: (now) => { if (now > 0) throw new Error('gh: API rate limit exceeded (HTTP 403)'); return JSON.stringify([listedPr(943, { isDraft: true })]); },
  });
  assert.ok(result, 'round still returns');
  const gaps = batches.slice(1).map((at, i) => at - batches[i]);
  assert.ok(gaps.length >= 1 && gaps.length <= 4, `bounded attempts ${gaps}`);
  assert.ok(gaps.every((gap, i) => i === 0 || gap > gaps[i - 1]), `backoff grows ${gaps}`);
});

test('批量查询带最新提交的 CI 汇总 state（只取 state，不拉 contexts），纯 CI 变化当轮触发采集并派发', (t) => {
  let collects = 0;
  const { sent } = tickFixture(t, {
    // 第 20 秒 CI 由 PENDING 变 FAILURE；head、updatedAt、标签、Draft 都没变。
    listFor: () => JSON.stringify([listedPr(944)]),
    rollupFor: (_pr, now) => (now >= 20000 ? 'FAILURE' : 'PENDING'),
    gate: (now) => graphqlNode(now >= 20000 ? { commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } } : {}),
    collect: (pr) => { collects += 1; return collects === 1 ? quiet(pr) : failing(pr); },
  });
  assert.deepEqual(sent.map((item) => item.at), [30000], 'the CI failure at 20 s is delivered at the next 15 s beat');
});

test('批量查询文本只要汇总 state', (t) => {
  const seen = [];
  tickFixture(t, {
    listFor: () => JSON.stringify([listedPr(945, { isDraft: true })]),
    extra: { ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([listedPr(945, { isDraft: true })]);
      if (isBatch(args)) { seen.push(args.join(' ')); return batchResponse([listedPr(945, { isDraft: true })]); }
      return '[]';
    } },
  });
  assert.ok(seen.length > 0, 'a batch query ran');
  assert.match(seen[0], /statusCheckRollup\{state\}/);
  assert.doesNotMatch(seen[0], /contexts|checkRuns|reviewThreads/);
});

// R3：慢采集不能挡住轮内检测（真实异步，缩小时间尺度：整轮 3000ms、预留 400ms、节拍 100ms）。
test('一个 PR 慢采集期间，另一个 PR 的变化在下一个节拍内被处理', async (t) => {
  const started = Date.now();
  const sent = [];
  const { paths, plugin } = setup(t);
  const result = await watcher.scanOnceAsync({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-15T00:00:00Z',
    gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin }, ownershipSnapshot: ownership,
    budgetMs: 3000, followUntilMs: 3000, dispatchReserveMs: 400, minCollectMs: 100, followMs: 100, fullCollectMs: 1e12,
    ghFn: async (args) => {
      const elapsed = Date.now() - started;
      const listing = () => [listedPr(951), listedPr(952, elapsed >= 300 ? { updatedAt: '2026-10-15T00:00:30Z' } : { isDraft: true })];
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(listing());
      if (isBatch(args)) return batchResponse(listing());
      if (isGate(args)) return JSON.stringify({ data: { node: graphqlNode() } });
      return '[]';
    },
    collect: async (pr) => { if (pr.number === 951) await new Promise((resolve) => setTimeout(resolve, 1500)); return failing(pr); },
    dispatchFn: async (params) => { sent.push({ number: Number(params.title.match(/#(\d+)/)[1]), at: Date.now() - started }); return { target_session_id: `sess-${params.title.match(/#(\d+)/)[1]}` }; },
  });
  const second = sent.find((item) => item.number === 952);
  assert.ok(second, `PR 952 was delivered: ${JSON.stringify(result.prs.map((item) => [item.number, item.dispatch.reason ?? item.dispatch.attempted]))}`);
  assert.ok(second.at < 1000, `PR 952 delivered at ${second.at} ms; the slow PR 951 needs 1500 ms`);
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
    if (endpoint === `repos/${REPO}/rules/branches/main`) return JSON.stringify(rules);
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify({ url: 'x', required_status_checks: null });
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
  const first = collectCindyCiSync({ pr: ciPr, ghFn: done.fn });
  assert.equal(first.status, 'green', first.reason);
  assert.equal(done.detail(), 6);
  collectCindyCiSync({ pr: ciPr, ghFn: done.fn });
  assert.equal(done.detail(), 6, 'second round: completed runs and jobs come from the cache');

  const live = ciGh({ completed: false });
  live.fn.ciCache = cache();
  collectCindyCiSync({ pr: ciPr, ghFn: live.fn });
  collectCindyCiSync({ pr: ciPr, ghFn: live.fn });
  assert.equal(live.detail(), 12, 'non-terminal runs are queried every round');
});

test('多个 required check 的 job/run 查询并发执行，结果不变', async () => {
  const sequential = ciGh();
  const expected = collectCindyCiSync({ pr: ciPr, ghFn: sequential.fn });
  const inner = ciGh();
  let active = 0;
  let peak = 0;
  const fn = async (args) => {
    const detail = /actions\/(jobs|runs)\//.test(args[1] ?? '');
    if (detail) { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 20)); active -= 1; }
    return inner.fn(args);
  };
  const result = await collectCindyCi({ pr: ciPr, ghFn: fn });
  assert.ok(peak >= 3, `peak concurrency ${peak}`);
  assert.deepEqual(result.required.map((r) => [r.context, r.status]), expected.required.map((r) => [r.context, r.status]));
  assert.equal(result.ciHash, expected.ciHash);
});

test('已完成 run/job 的缓存写进 watcher state，下一轮（新的 memoRepoReads）直接复用', (t) => {
  const { paths } = setup(t);
  const first = ciGh();
  const one = collectCindyCiSync({ pr: ciPr, ghFn: memoRepoReads(first.fn, keptReadStore(paths.stateDir, () => 1000)) });
  assert.equal(one.status, 'green', one.reason);
  assert.equal(first.detail(), 6);
  const second = ciGh();
  const two = collectCindyCiSync({ pr: ciPr, ghFn: memoRepoReads(second.fn, keptReadStore(paths.stateDir, () => 61000)) });
  assert.equal(two.status, 'green', two.reason);
  assert.equal(second.detail(), 0, 'a later round reads no completed job or run again');
  assert.deepEqual(two.required.map((item) => item.evidence), one.required.map((item) => item.evidence));
});

// ---- R1：采集不完整时不得收口 ----
const unknownCi = (listed) => ({ ...quiet(listed), checks: [],
  ci: { status: 'unknown', required: [], reason: 'HTTP 503 fixture' }, policy: { status: 'verified', required: [{ context: 'unit' }] } });

test('R1 无会话 PR 遇到 CI unknown 后保留旧指纹，API 恢复后下一轮重新采集并派发', (t) => {
  const { paths, plugin } = setup(t);
  let collects = 0;
  const sent = [];
  const base = () => ({
    mode: 'discover', enabled: true, allowDispatch: true, paths, gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin },
    ownershipSnapshot: ownership, fullCollectMs: 1e12,
    ghFn: (args) => (args[0] === 'api' && args[1] === 'user' ? 'owner'
      : args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([listedPr(961)])
        : args[0] === 'api' && args[1] === 'graphql' ? JSON.stringify({ data: { node: graphqlNode() } }) : '[]'),
    collect: (pr) => { collects += 1; return collects === 1 ? unknownCi(pr) : failing(pr); },
    dispatchFn: (params) => { sent.push(params.title); return { target_session_id: 'sess-961' }; },
  });
  scanOnce({ ...base(), now: '2026-10-15T00:00:00Z' });
  assert.equal(collects, 1);
  scanOnce({ ...base(), now: '2026-10-15T00:05:00Z' });
  assert.equal(collects, 2, 'the incomplete collection is retried although GitHub did not change');
  assert.equal(sent.length, 1, 'and the recovered required CI failure reaches a repair session');
});

// ---- R2：指纹覆盖全量采集会读到的变化 + 兜底全量 ----
const richNode = (mutate = (node) => node) => mutate({
  ...graphqlNode(), updatedAt: '2026-10-15T00:00:00Z',
  comments: { totalCount: 3, nodes: [{ id: 'c1', updatedAt: '2026-10-15T00:00:01Z' }, { id: 'c2', updatedAt: '2026-10-15T00:00:02Z' }, { id: 'c3', updatedAt: '2026-10-15T00:00:03Z' }] },
  reviews: { totalCount: 3, nodes: [{ id: 'r1', updatedAt: '2026-10-15T00:00:01Z' }, { id: 'r2', updatedAt: '2026-10-15T00:00:02Z' }, { id: 'r3', updatedAt: '2026-10-15T00:00:03Z' }] },
  reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ id: 't1', updatedAt: '2026-10-15T00:00:01Z' }, { id: 't2', updatedAt: '2026-10-15T00:00:02Z' }, { id: 't3', updatedAt: '2026-10-15T00:00:03Z' }] } }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' }, status: { state: 'PENDING', contexts: [{ context: 'legacy', state: 'PENDING' }] },
    checkSuites: { nodes: [] } } }] },
});

const coverage = [
  ['PR updatedAt', (node) => ({ ...node, updatedAt: '2026-10-15T00:00:09Z' })],
  ['旧评论被编辑（最新评论不变）', (node) => ({ ...node, comments: { ...node.comments, nodes: [node.comments.nodes[0], { id: 'c2', updatedAt: '2026-10-15T00:00:08Z' }, node.comments.nodes[2]] } })],
  ['旧 review 被编辑', (node) => ({ ...node, reviews: { ...node.reviews, nodes: [node.reviews.nodes[0], { id: 'r2', updatedAt: '2026-10-15T00:00:08Z' }, node.reviews.nodes[2]] } })],
  ['线程里较早的评论被编辑', (node) => ({ ...node, reviewThreads: { nodes: [{ isResolved: false, comments: { nodes: [{ id: 't1', updatedAt: '2026-10-15T00:00:01Z' }, { id: 't2', updatedAt: '2026-10-15T00:00:08Z' }, { id: 't3', updatedAt: '2026-10-15T00:00:03Z' }] } }] } })],
  ['statusCheckRollup.state', (node) => ({ ...node, commits: { nodes: [{ commit: { ...node.commits.nodes[0].commit, statusCheckRollup: { state: 'FAILURE' } } }] } })],
  ['legacy commit status context', (node) => ({ ...node, commits: { nodes: [{ commit: { ...node.commits.nodes[0].commit, status: { state: 'FAILURE', contexts: [{ context: 'legacy', state: 'FAILURE' }] } } }] } })],
  ['CheckRun 状态', (node) => ({ ...node, commits: { nodes: [{ commit: { ...node.commits.nodes[0].commit, checkSuites: { nodes: [{ checkRuns: { nodes: [{ name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', databaseId: 7 }] } }] } } }] } })],
];

for (const [name, mutate] of coverage) {
  test(`R2 指纹闸覆盖：${name} 真实触发采集并派发`, (t) => {
    const { paths, plugin } = setup(t);
    let collects = 0;
    const sent = [];
    let node = richNode();
    const round = (minute) => scanOnce({
      mode: 'discover', enabled: true, allowDispatch: true, paths, gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin },
      ownershipSnapshot: ownership, fullCollectMs: 1e12, now: new Date(Date.UTC(2026, 9, 15, 0, minute, 0)).toISOString(),
      ghFn: (args) => (args[0] === 'api' && args[1] === 'user' ? 'owner'
        : args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([listedPr(971)])
          : args[0] === 'api' && args[1] === 'graphql' ? JSON.stringify({ data: { node } }) : '[]'),
      // 变化之前 PR 没有任何待处理反馈；变化之后全量采集读到一条必需 CI 失败，这才是该变化背后的真实反馈。
      collect: (pr) => { collects += 1; return collects === 1 ? quiet(pr) : failing(pr); },
      dispatchFn: (params) => { sent.push(params.title); return { target_session_id: 'sess-971' }; },
    });
    round(0);
    round(1);
    assert.equal(collects, 1, 'unchanged: one collection only');
    assert.equal(sent.length, 0, 'unchanged: nothing delivered');
    node = richNode(mutate);
    const changed = round(2);
    assert.equal(collects, 2, `${name} changes the fingerprint`);
    assert.equal(sent.length, 1, `${name}: the feedback behind the change is delivered to a repair session`);
    assert.equal(changed.prs.at(-1).dispatch.attempted, true);
  });
}

test('R2 兜底：指纹没变，距上次全量采集超过上限也强制全量一次', (t) => {
  const { paths, plugin } = setup(t);
  let collects = 0;
  const round = (minute) => scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin },
    ownershipSnapshot: ownership, fullCollectMs: 10 * 60 * 1000, now: new Date(Date.UTC(2026, 9, 15, 0, minute, 0)).toISOString(),
    ghFn: (args) => (args[0] === 'api' && args[1] === 'user' ? 'owner'
      : args[0] === 'pr' && args[1] === 'list' ? JSON.stringify([listedPr(972)])
        : args[0] === 'api' && args[1] === 'graphql' ? JSON.stringify({ data: { node: richNode() } }) : '[]'),
    collect: (pr) => { collects += 1; return quiet(pr); },
    dispatchFn: () => { throw new Error('nothing to dispatch'); },
  });
  round(0);
  round(5);
  assert.equal(collects, 1, 'inside the limit: skipped');
  round(11);
  assert.equal(collects, 2, 'past the limit: one forced full collection');
  round(12);
  assert.equal(collects, 2, 'and the clock restarts from it');
});

test('R2 默认兜底上限为 10 分钟', () => assert.equal(watcher.FULL_COLLECT_MS, 10 * 60 * 1000));

// ---- R5：同步入口遇到 gh 错误必须同步返回 unknown ----
test('R5 collectCindyCiSync 遇到 gh 抛错：返回 unknown，进程不因未处理拒绝退出', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const ciUrl = pathToFileURL(path.join(here, 'bin', 'cindy-ci.mjs')).href;
  const script = `
    import { collectCindyCiSync } from ${JSON.stringify(ciUrl)};
    const head = 'a'.repeat(40), base = 'b'.repeat(40), repo = ${JSON.stringify(REPO)};
    const rules = [[{ type: 'required_status_checks', ruleset_id: 7, parameters: { required_status_checks: [{ context: 'a', integration_id: 15368 }, { context: 'b', integration_id: 15368 }] } }]];
    const ghFn = (args) => {
      const e = args[1] ?? '';
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_1', number: 5, headRefOid: head, baseRefOid: base, baseRefName: 'main', state: 'OPEN', isDraft: false });
      if (e === 'repos/' + repo + '/rules/branches/main') return JSON.stringify(rules);
      if (e === 'repos/' + repo + '/branches/main/protection') return JSON.stringify({ url: 'x', required_status_checks: null });
      if (e === 'repos/' + repo + '/commits/' + head + '/check-runs?per_page=100&filter=all') return JSON.stringify([{ check_runs: ['a', 'b'].map((name, i) => ({ id: 11 + i, name, head_sha: head, app: { id: 15368, slug: 'github-actions' }, status: 'completed', conclusion: 'success', started_at: '2026-10-15T10:00:00Z', details_url: 'https://github.com/' + repo + '/actions/runs/' + (100 + i) + '/job/' + (200 + i) })) }]);
      if (/actions\\/(jobs|runs)\\//.test(e)) throw new Error('HTTP 503 fixture');
      return '[]';
    };
    const result = collectCindyCiSync({ pr: { repo, number: 5, id: 'PR_1', headRefOid: head, baseRefOid: base, state: 'OPEN', isDraft: false }, ghFn });
    console.log('STATUS=' + result.status);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    console.log('PROCESS_SURVIVED');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env } });
  assert.match(child.stdout, /STATUS=unknown/, child.stderr);
  assert.match(child.stdout, /PROCESS_SURVIVED/, child.stderr);
  assert.equal(child.status, 0, child.stderr);
});

// ---- F1：任何一次采集（含轮末跟进启动的）都受整轮截止时间约束 ----
// 采集由许多次 gh 调用组成；桩里每次调用推进假时钟 5 秒，采集 60 秒 = 12 次调用，100 秒 = 20 次。
function lateChangeFixture(t, { changeAtMs, collectMs }) {
  const { paths, plugin } = setup(t);
  let now = 0;
  const sent = [];
  const order = [];
  let firstDone = false;
  const options = (stamp) => ({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: stamp, clock: () => now,
    followMs: 15000, sleepFn: (ms) => { now += ms; }, fullCollectMs: 1e12,
    gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin }, ownershipSnapshot: ownership,
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      const changed = now >= changeAtMs;
      const listing = () => [listedPr(981, changed ? { updatedAt: '2026-10-15T00:02:10Z' } : {})];
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(listing());
      if (isBatch(args)) return batchResponse(listing());
      if (isGate(args)) return JSON.stringify({ data: { node: graphqlNode({ comments: { totalCount: changed ? 1 : 0, nodes: [] } }) } });
      if (args[1]?.startsWith('probe')) { now += 5000; return '{}'; }
      return '[]';
    },
    collect: (pr, { ghFn }) => {
      order.push(pr.number);
      // The very first collection (nothing to deliver yet) is quick; every later one takes collectMs.
      if (!firstDone) { firstDone = true; return quiet(pr); }
      for (let i = 0; i < collectMs / 5000; i += 1) ghFn(['api', `probe${i}`]);
      return failing(pr);
    },
    dispatchFn: (params) => { sent.push(params.title); return { target_session_id: 'sess-981' }; },
  });
  return { paths, options, sent, order, reset: () => { now = 0; }, elapsed: () => now };
}

for (const changeAtMs of [100000, 130000, 150000]) {
  for (const collectMs of [60000, 100000]) {
    test(`F1 第 ${changeAtMs / 1000} 秒出现变化 + ${collectMs / 1000}s 采集：整轮不超预算，该 PR 标 collectRetry，下一轮优先并派发`, (t) => {
      const fx = lateChangeFixture(t, { changeAtMs, collectMs });
      // 第一轮：PR 0 秒时已有一次完整采集并收口；变化出现在轮末，由跟进循环发现
      const first = scanOnce(fx.options('2026-10-15T00:00:00Z'));
      assert.ok(first, 'first run ends');
      assert.ok(fx.elapsed() <= watcher.ROUND_BUDGET_MS, `round ran ${fx.elapsed()} ms of ${watcher.ROUND_BUDGET_MS}`);
      assert.equal(fx.sent.length, 0);
      const entry = readPr(fx.paths.home, 'PR_981');
      assert.equal(entry.collectRetry, true, 'the PR is marked for another collection');
      const index = JSON.parse(fs.readFileSync(statePaths(fx.paths.home).indexPath, 'utf8'));
      assert.deepEqual(index.deferredNumbers, [981], 'and goes first next run');
      // 下一轮：新的假时钟，变化已在 GitHub 上，该 PR 优先被采集并派发
      fx.reset();
      fx.order.length = 0;
      scanOnce({ ...fx.options('2026-10-15T00:03:00Z') });
      assert.equal(fx.order[0], 981);
      assert.equal(fx.sent.length, 1, 'delivered next run');
    });
  }
}

// ---- P2-b：截止发生在 CI job/run 查询阶段（真实 collectXxxCiSync 把异常吞成 unknown）----
test('P2-b CI 阶段被整轮截止切断：不当作无反馈，进入 deferredNumbers，下一轮最先处理并派发', (t) => {
  const { paths, plugin } = setup(t);
  let now = 0;
  const sent = [];
  const order = [];
  let firstDone = false;
  const ciFx = ciGh();
  const options = (stamp) => ({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: stamp, clock: () => now,
    followMs: 15000, sleepFn: (ms) => { now += ms; }, fullCollectMs: 1e12,
    gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin }, ownershipSnapshot: ownership,
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      const changed = now >= 100000;
      const listing = () => [listedPr(982, changed ? { updatedAt: '2026-10-15T00:02:10Z' } : {})];
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(listing());
      if (isBatch(args)) return batchResponse(listing());
      if (isGate(args)) return JSON.stringify({ data: { node: graphqlNode({ comments: { totalCount: changed ? 1 : 0, nodes: [] } }) } });
      // The CI collection: every gh call takes 5 s, so a collection started late runs into the round's deadline.
      if (args[1]?.startsWith('repos/') || (args[0] === 'pr' && args[1] === 'view')) { now += 5000; return ciFx.fn(args); }
      return '[]';
    },
    collect: (pr, { ghFn }) => {
      order.push(pr.number);
      if (!firstDone) { firstDone = true; return quiet(pr); }
      // The real CI collector: it turns any error into `unknown` instead of throwing.
      const ci = collectCindyCiSync({ pr: ciPr, ghFn });
      // Cut off → the collector reports CI unknown (nothing else is known); finished → the PR has a failing check to repair.
      return ci.status === 'unknown' ? { ...quiet(pr), ci: { ...ci, required: [] } } : failing(pr);
    },
    dispatchFn: (params) => { sent.push(params.title); return { target_session_id: 'sess-982' }; },
  });
  scanOnce(options('2026-10-15T00:00:00Z'));
  assert.ok(now <= watcher.ROUND_BUDGET_MS, `round ran ${now} ms`);
  assert.equal(sent.length, 0, 'the cut-off collection delivers nothing');
  assert.equal(readPr(paths.home, 'PR_982').collectRetry, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePaths(paths.home).indexPath, 'utf8')).deferredNumbers, [982]);
  now = 0;
  order.length = 0;
  scanOnce(options('2026-10-15T00:03:00Z'));
  assert.equal(order[0], 982);
  assert.equal(sent.length, 1, 'delivered next run');
});
