import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FOLLOW_INTERVAL_MS, scanOnce, watcherPaths } from './bin/mivo-watcher.mjs';
import { handoffPr, withAuthorHandoff } from './handoff.fixture.mjs';

// SC-6：同一夹具（5 个 open PR、其中 1 个有新反馈）下，一整轮 discover 的 gh 调用次数。
// collect 桩按真实采集量（约 42 次 gh 调用：快照、CI、评论、线程、策略）通过传入的 ghFn 计数。
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const COLLECT_CALLS = 42;
const listedPr = (number, extra = {}) => ({ number, id: `PR_${number}`, headRefOid: HEAD, headRefName: `fix/${number}`,
  title: 'fix', isDraft: false, labels: [], updatedAt: '2026-10-15T00:00:00Z', ...extra });
const quiet = (listed) => withAuthorHandoff({
  pr: { id: listed.id, number: listed.number, state: 'OPEN', isDraft: false, sameRepository: true, author: { login: 'owner' },
    headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' },
  admissionVerified: true,
  checks: [{ name: 'unit', state: 'PENDING', bucket: 'pending' }],
  ci: { status: 'pending', required: [{ context: 'unit', status: 'pending', evidence: { id: 1, runId: 2, attempt: 1 } }] },
  policy: { status: 'verified', required: [{ context: 'unit' }] },
  comments: [], reviews: [], threads: [], labels: [], mergeReady: false,
}, listed);
function* ownership({ pr }) {
  return { pr: handoffPr({ id: `PR_${pr.number}`, number: pr.number, state: 'OPEN', isDraft: false, sameRepository: true,
    author: { login: 'owner' }, headRefOid: HEAD, baseRefOid: BASE, releaseEpoch: 'e' }) };
}
const node = (comments = 0) => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, comments: { totalCount: comments, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { nodes: [] }, commits: { nodes: [] } });

test('5 个 open PR 的一整轮：无变化与 1 个新反馈的 gh 调用次数', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-call-budget-'));
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-call-budget-plugin-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(plugin, { recursive: true, force: true }); });
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  let calls = 0;
  let now = 0;
  let commentOn = null;
  const listing = () => JSON.stringify([951, 952, 953, 954, 955].map((n) => listedPr(n,
    commentOn === n ? { updatedAt: '2026-10-15T00:05:00Z' } : {})));
  const round = (stamp) => {
    calls = 0;
    now = 0;
    return scanOnce({
      mode: 'discover', enabled: true, allowDispatch: true, paths, now: stamp, clock: () => now,
      followMs: FOLLOW_INTERVAL_MS, sleepFn: (ms) => { now += ms; },
      gitFn: () => '', env: { MIVO_PLUGIN_REPO: plugin }, ownershipSnapshot: ownership,
      ghFn: (args) => {
        calls += 1;
        if (args[0] === 'api' && args[1] === 'user') return 'owner';
        if (args[0] === 'pr' && args[1] === 'list') return listing();
        if (args[0] === 'api' && args[1] === 'graphql') {
          const id = Number(String(args.at(-1)).replace(/\D/g, ''));
          return JSON.stringify({ data: { node: node(commentOn === id ? 1 : 0) } });
        }
        return '[]';
      },
      collect: (pr, { ghFn }) => { for (let i = 0; i < COLLECT_CALLS; i += 1) ghFn(['api', `repos/x/y/pulls/${pr.number}/probe${i}`]); return quiet(pr); },
      dispatchFn: () => ({ target_session_id: 'sess' }),
    });
  };
  round('2026-10-15T00:00:00Z');
  round('2026-10-15T00:02:00Z');
  const none = calls;
  commentOn = 955;
  round('2026-10-15T00:04:00Z');
  const one = calls;
  console.log(`CALL_BUDGET none-changed=${none} one-feedback=${one}`);
  // 无变化：5 次指纹查询 + 1 次登录 + 1 次列表 + 每 15 秒一次批量查询，不再全量采集。
  assert.ok(none <= 20, `no-change round used ${none} gh calls`);
  assert.ok(one <= 20 + COLLECT_CALLS + 4, `one-feedback round used ${one} gh calls`);
});
