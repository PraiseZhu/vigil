import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGithub } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { pollInventory } from './bin/poll.mjs';
import { collectTasks } from './bin/tasks.mjs';
import { shouldTrigger } from './bin/trigger.mjs';
import { BASE_PENDING_AFTER_MS, basePendingOverdue, reportBasePending, selectDueBasePending } from './host/base-pending.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { runTick } from './host/tick.mjs';
import { REPO, createFakeRun, inventoryData, issueNode, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

// #380：关联 PR 合进非默认分支的任务先不验（长期口径）；距最近一次非默认分支合并严格超过 3 天还没合入默认分支的，
// 每天进一次每日汇总，用这一拍 poll 已有的 baseSkipped，不发 GitHub 请求。

const MERGED_AT = '2026-11-01T00:00:00.000Z';
const mergedMs = Date.parse(MERGED_AT);
const DAY = 24 * 60 * 60 * 1000;
const record = (extra = {}) => ({
  issue: `${REPO}#21`, kind: 'standalone', state: 'open', url: `https://github.com/${REPO}/issues/21`, mergedAt: MERGED_AT,
  reason: 'base-not-default', base: 'integration/sample-feature', defaultBranch: 'main',
  prs: [{ ref: `${REPO}#210`, base: 'integration/sample-feature' }], child: null, message: '', ...extra,
});

function profileWith() {
  const { home } = writeProfile(tmpDir());
  return { home, profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }) };
}
function prNode(number, mergedAt, baseRefName) {
  return { number, url: `https://github.com/${REPO}/pull/${number}`, mergedAt, baseRefName, repository: { nameWithOwner: REPO } };
}

test('#380 SC1 超期判定的临界值：3×24h−1s 与正好 3×24h 不报，3×24h+1s 报', () => {
  assert.equal(BASE_PENDING_AFTER_MS, 3 * DAY);
  assert.equal(basePendingOverdue(record(), mergedMs + 3 * DAY - 1000), false);
  assert.equal(basePendingOverdue(record(), mergedMs + 3 * DAY), false);
  assert.equal(basePendingOverdue(record(), mergedMs + 3 * DAY + 1000), true);
});

test('#380 SC1 不报的几种：mergedAt 解析不出、issue 已关闭、目标分支未知、已合入默认分支（不在 baseSkipped 里）', () => {
  const later = mergedMs + 10 * DAY;
  assert.equal(basePendingOverdue(record({ mergedAt: null }), later), false);
  assert.equal(basePendingOverdue(record({ mergedAt: 'not-a-date' }), later), false);
  assert.equal(basePendingOverdue(record({ state: 'closed' }), later), false);
  assert.equal(basePendingOverdue(record({ reason: 'base-unknown' }), later), false);
  assert.deepEqual(selectDueBasePending({ baseSkipped: [], state: {}, nowMs: later }).due, []);
});

test('#380 SC2 同一任务同一天只报一次，跨日再报；不再符合条件的自动清掉', () => {
  const day1 = mergedMs + 4 * DAY;
  const first = selectDueBasePending({ baseSkipped: [record()], state: {}, nowMs: day1 });
  assert.deepEqual(first.due.map((item) => item.issue), [`${REPO}#21`]);
  const sameDay = selectDueBasePending({ baseSkipped: [record()], state: first.next, nowMs: day1 + 3 * 60 * 60 * 1000 });
  assert.deepEqual(sameDay.due, [], '同一天不再报');
  const nextDay = selectDueBasePending({ baseSkipped: [record()], state: sameDay.next, nowMs: day1 + DAY });
  assert.deepEqual(nextDay.due.map((item) => item.issue), [`${REPO}#21`], '跨日再报一次');
  const merged = selectDueBasePending({ baseSkipped: [], state: nextDay.next, nowMs: day1 + DAY + 60000 });
  assert.deepEqual(merged.next, { reported: {} }, '后来合入默认分支：状态里清掉');
});

test('#380 SC2 reportBasePending 写进提醒文件并按日去重（状态文件在 state/host 下）', () => {
  const { home } = profileWith();
  const paths = hostPaths(home);
  const now = () => mergedMs + 4 * DAY;
  assert.deepEqual(reportBasePending({ paths, baseSkipped: [record()], now }).reported, [`${REPO}#21`]);
  assert.deepEqual(reportBasePending({ paths, baseSkipped: [record()], now }).reported, []);
  const alerts = readAlerts(paths).filter((alert) => alert.kind === 'base-not-default');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].url, `https://github.com/${REPO}/issues/21`);
  assert.equal(alerts[0].base, 'integration/sample-feature');
  assert.deepEqual(alerts[0].prs, [{ ref: `${REPO}#210`, base: 'integration/sample-feature', url: `https://github.com/${REPO}/pull/210` }]);
  assert.match(alerts[0].reason, /合进了 integration\/sample-feature，已经 4 天没合入默认分支 main/);
  assert.doesNotMatch(alerts[0].reason, /base-not-default/);
  assert.ok(fs.existsSync(path.join(paths.hostDir, 'base-pending.json')));
});

test('#380 SC4 tick 用这一拍 poll 的 baseSkipped：只起一次 poll.mjs，不发别的读，超期的进提醒', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    return { code: 0, stdout: JSON.stringify({ entries: [], reads: 1, baseSkipped: [record()] }), stderr: '' };
  };
  const heartbeat = await runTick({
    home, env: { ...process.env }, run, spawnRound: () => 1, runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    discoverPrbot: async () => [], checkPrbotStalled: async () => [], cleanupPrbot: () => [],
    notify: async () => ({ ok: true, sent: 0, digested: 0 }), now: () => mergedMs + 4 * DAY, uptime: () => 1,
  });
  assert.equal(heartbeat.lastTick.ok, true, heartbeat.lastTick.error);
  assert.deepEqual(heartbeat.lastTick.basePending, [`${REPO}#21`]);
  assert.equal(heartbeat.lastTick.basePendingError, undefined);
  assert.equal(calls.length, 1, `这一拍只该有一次子进程调用：${JSON.stringify(calls)}`);
  assert.equal(calls[0][0], 'node');
  assert.match(calls[0][1], /watchers\/acceptance\/bin\/poll\.mjs$/);
  assert.equal(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'base-not-default').length, 1);
});

test('#380 SC5 baseSkipped 每条的字段集合固定，带 mergedAt（最近一次非默认分支合并）；盘点仍是 1 页 1 次请求', async () => {
  const issue = issueNode({ number: 31, prs: [prNode(310, '2026-11-01T00:00:00.000Z', 'integration/a'), prNode(311, '2026-11-02T06:00:00.000Z', 'integration/a')] });
  const { profile } = profileWith();
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [issue] }) });
  const result = await pollInventory({ github: createGithub({ profile, run }), profile, now: () => Date.parse('2026-11-10T00:00:00Z'), loopLog: false });
  assert.equal(result.reads, 1);
  assert.equal(run.calls.length, 1);
  assert.equal(result.baseSkipped.length, 1);
  const [skipped] = result.baseSkipped;
  assert.deepEqual(Object.keys(skipped).sort(),
    ['base', 'child', 'defaultBranch', 'issue', 'kind', 'mergedAt', 'message', 'prs', 'reason', 'state', 'url'].sort());
  assert.equal(skipped.mergedAt, '2026-11-02T06:00:00.000Z', '取最近一次非默认分支合并');
  assert.equal(skipped.state, 'open');
});

test('#380 SC6 合入默认分支之后自动恢复验收：先只有非默认分支合并 → 后来有合入默认分支的合并', async () => {
  const before = issueNode({ number: 41, prs: [prNode(410, '2026-11-01T00:00:00.000Z', 'integration/a')] });
  const after = issueNode({ number: 41, prs: [prNode(410, '2026-11-01T00:00:00.000Z', 'integration/a'), prNode(411, '2026-11-05T00:00:00.000Z', 'main')] });
  const now = () => Date.parse('2026-11-10T00:00:00Z');
  for (const [node, expected] of [[before, { trigger: false, skipped: 1 }], [after, { trigger: true, skipped: 0 }]]) {
    const { profile } = profileWith();
    const github = createGithub({ profile, run: createFakeRun({ onGraphql: () => inventoryData({ open: [node] }) }) });
    const [task] = await collectTasks(github, profile);
    assert.equal(shouldTrigger(task, { now, profile }).trigger, expected.trigger);
    const again = createGithub({ profile, run: createFakeRun({ onGraphql: () => inventoryData({ open: [node] }) }) });
    const result = await pollInventory({ github: again, profile, now, loopLog: false });
    assert.equal(result.baseSkipped.length, expected.skipped);
  }
});
