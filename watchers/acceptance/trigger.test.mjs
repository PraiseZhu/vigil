import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldTrigger, stalledRounds, backoffUntil, lastFinal, BACKOFF_MINUTES } from './bin/trigger.mjs';
import { bodyVersion } from './bin/tasks.mjs';
import { OWNER, REPO, START_AT } from './fake-gh.fixture.mjs';

const nowAt = (iso) => () => Date.parse(iso);

function parentTask(extra = {}) {
  const body = extra.body ?? 'parent body';
  return {
    ref: `${REPO}#1`,
    repo: REPO,
    number: 1,
    kind: 'parent',
    tier: 'auto',
    fork: false,
    state: 'open',
    closedAt: null,
    body,
    bodyVersion: bodyVersion(body),
    children: extra.children ?? [{ ref: `${REPO}#2`, state: 'closed', closedAt: '2026-10-20T00:00:00.000Z' }],
    linkedPrs: extra.linkedPrs ?? [],
    rounds: extra.rounds ?? [],
    ...extra.rest,
  };
}

function standaloneTask(extra = {}) {
  const body = extra.body ?? 'standalone';
  return {
    ref: `${REPO}#3`,
    repo: REPO,
    number: 3,
    kind: extra.kind ?? 'standalone',
    tier: extra.tier ?? 'auto',
    fork: false,
    state: extra.state ?? 'open',
    closedAt: extra.closedAt ?? null,
    body,
    bodyVersion: bodyVersion(body),
    children: extra.children ?? [],
    linkedPrs: extra.linkedPrs ?? [{ ref: `${REPO}#9`, mergedAt: '2026-10-21T00:00:00.000Z' }],
    rounds: extra.rounds ?? [],
  };
}

test('SC3 总 issue 子 issue 全关且没有通过裁决时触发', () => {
  const task = parentTask();
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, true);
});

test('SC3 总 issue 修正子 issue 全关后再触发', () => {
  const body = 'parent body';
  const task = parentTask({
    children: [
      { ref: `${REPO}#2`, state: 'closed', closedAt: '2026-10-22T00:00:00.000Z' },
      { ref: `${REPO}#5`, state: 'closed', closedAt: '2026-10-23T00:00:00.000Z' },
    ],
    rounds: [
      {
        round: 1,
        status: '要修',
        bodyVersion: bodyVersion(body),
        finishedAt: '2026-10-21T00:00:00.000Z',
        createdAt: '2026-10-21T00:00:00.000Z',
      },
    ],
  });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, true);
  assert.equal(r.reason, 'children-closed-after-verdict');
});

test('SC3 正文版本和最近裁决不一致时旧裁决作废并触发', () => {
  const task = parentTask({
    body: 'new body',
    rounds: [
      {
        round: 1,
        status: '通过',
        bodyVersion: bodyVersion('old body'),
        finishedAt: '2026-10-21T00:00:00.000Z',
        createdAt: '2026-10-21T00:00:00.000Z',
      },
    ],
  });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, true);
  assert.equal(r.reason, 'body-changed');
});

test('SC3 还有子 issue 开着时不触发', () => {
  const task = parentTask({
    children: [{ ref: `${REPO}#2`, state: 'open', closedAt: null }],
  });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, false);
  assert.equal(r.reason, 'children-open');
});

test('SC3 最新一轮还在验收中时不触发', () => {
  const task = parentTask({
    rounds: [
      {
        round: 2,
        status: '验收中',
        createdAt: '2026-10-24T00:00:00.000Z',
        bodyVersion: bodyVersion('parent body'),
      },
    ],
  });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T01:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, false);
  assert.equal(r.reason, 'in-progress');
});

test('SC4 独立 issue 关联 PR 合并晚于最近裁决时触发', () => {
  const body = 'standalone';
  const task = standaloneTask({
    linkedPrs: [{ ref: `${REPO}#9`, mergedAt: '2026-10-22T00:00:00.000Z' }],
    rounds: [
      {
        round: 1,
        status: '通过',
        bodyVersion: bodyVersion(body),
        finishedAt: '2026-10-21T00:00:00.000Z',
        createdAt: '2026-10-21T00:00:00.000Z',
      },
    ],
  });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, true);
});

test('SC4 没有子 issue 的总 issue 按独立 issue 处理', () => {
  const task = standaloneTask({ kind: 'standalone', children: [] });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, true);
});

test('SC4 watch 档也触发', () => {
  const task = standaloneTask({ tier: 'watch' });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, true);
});

test('SC4 startAt 之前已关闭的不补验', () => {
  const task = standaloneTask({
    closedAt: '2019-12-01T00:00:00.000Z',
    state: 'closed',
  });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, false);
  assert.equal(r.reason, 'closed-before-start');
});

test('SC4 没有关联已合并 PR 的独立 issue 不触发', () => {
  const task = standaloneTask({ linkedPrs: [] });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T00:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, false);
});

test('SC14 退避：第一次中断后立即可以重开', () => {
  const rounds = [
    { round: 1, status: '中断', finishedAt: '2026-10-24T01:00:00.000Z', createdAt: '2026-10-24T00:50:00.000Z' },
  ];
  assert.equal(backoffUntil(rounds), '2026-10-24T01:00:00.000Z');
  const task = parentTask({ rounds });
  const r = shouldTrigger(task, { now: nowAt('2026-10-24T01:00:00.000Z'), profile: { startAt: START_AT } });
  assert.equal(r.trigger, true);
});

test('SC14 退避：第二次中断后间隔 5 分钟', () => {
  const rounds = [
    { round: 1, status: '中断', finishedAt: '2026-10-24T01:00:00.000Z', createdAt: '2026-10-24T00:50:00.000Z' },
    { round: 2, status: '中断', finishedAt: '2026-10-24T02:00:00.000Z', createdAt: '2026-10-24T01:50:00.000Z' },
  ];
  const until = backoffUntil(rounds);
  assert.equal(Date.parse(until) - Date.parse('2026-10-24T02:00:00.000Z'), BACKOFF_MINUTES[1] * 60 * 1000);
  const task = parentTask({ rounds });
  assert.equal(
    shouldTrigger(task, { now: nowAt('2026-10-24T02:04:00.000Z'), profile: { startAt: START_AT } }).reason,
    'backoff',
  );
  assert.equal(
    shouldTrigger(task, { now: nowAt('2026-10-24T02:05:00.000Z'), profile: { startAt: START_AT } }).trigger,
    true,
  );
});

test('SC14 退避：第三次 15 分钟，之后每 60 分钟', () => {
  const three = [
    { round: 1, status: '中断', finishedAt: '2026-10-24T01:00:00.000Z', createdAt: '2026-10-24T00:50:00.000Z' },
    { round: 2, status: '中断', finishedAt: '2026-10-24T02:00:00.000Z', createdAt: '2026-10-24T01:50:00.000Z' },
    { round: 3, status: '中断', finishedAt: '2026-10-24T03:00:00.000Z', createdAt: '2026-10-24T02:50:00.000Z' },
  ];
  assert.equal(Date.parse(backoffUntil(three)) - Date.parse('2026-10-24T03:00:00.000Z'), 15 * 60 * 1000);
  const four = [...three, { round: 4, status: '中断', finishedAt: '2026-10-24T04:00:00.000Z', createdAt: '2026-10-24T03:50:00.000Z' }];
  assert.equal(Date.parse(backoffUntil(four)) - Date.parse('2026-10-24T04:00:00.000Z'), 60 * 60 * 1000);
});

test('lastFinal 取编号最高的通过或要修', () => {
  const rounds = [
    { round: 1, status: '通过' },
    { round: 2, status: '中断' },
    { round: 3, status: '要修' },
  ];
  assert.equal(lastFinal(rounds).round, 3);
});

test('SC17 stalledRounds 超过 stallMinutes 才标 stale', () => {
  const task = parentTask({
    rounds: [{ round: 2, status: '验收中', createdAt: '2026-10-24T01:00:00.000Z', commentId: 22 }],
  });
  const profile = { startAt: START_AT, stallMinutes: 30 };
  assert.equal(
    stalledRounds(task, { now: nowAt('2026-10-24T01:29:00.000Z'), profile, lastProgressAt: '2026-10-24T01:00:00.000Z' }),
    null,
  );
  const stale = stalledRounds(task, {
    now: nowAt('2026-10-24T01:31:00.000Z'),
    profile,
    lastProgressAt: '2026-10-24T01:00:00.000Z',
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.round, 2);
  assert.equal(stale.issue, `${REPO}#1`);
});

test('SC11 stalledRounds 以宿主时间为准：stateDir 里伪造的 lastProgressAt 延不了期，宿主活动才延', () => {
  const task = parentTask({
    rounds: [{ round: 2, status: '验收中', createdAt: '2026-10-24T01:00:00.000Z', commentId: 22 }],
  });
  const profile = { startAt: START_AT, stallMinutes: 30 };
  // 模型把缓存里的进度写到了未来：照样按评论创建时间算，31 分钟后判卡死。
  const forged = stalledRounds(task, {
    now: nowAt('2026-10-24T01:31:00.000Z'),
    profile,
    lastProgressAt: '2099-01-01T00:00:00.000Z',
  });
  assert.equal(forged?.stale, true);
  assert.equal(forged.lastProgressAt, '2026-10-24T01:00:00.000Z');
  assert.equal(forged.modelProgressAt, '2099-01-01T00:00:00.000Z', '模型时间只作参考带出来');
  // 宿主 01:20 看到过活动：01:31 还不算卡死，01:51 才算。
  const hostProgressAt = '2026-10-24T01:20:00.000Z';
  assert.equal(stalledRounds(task, { now: nowAt('2026-10-24T01:31:00.000Z'), profile, hostProgressAt }), null);
  const later = stalledRounds(task, { now: nowAt('2026-10-24T01:51:00.000Z'), profile, hostProgressAt });
  assert.equal(later.stale, true);
  assert.equal(later.lastProgressAt, hostProgressAt);
  // 宿主时间不会把轮次延到未来（按 now 截断）。
  const future = stalledRounds(task, { now: nowAt('2026-10-24T01:31:00.000Z'), profile, hostProgressAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(future, null);
});

void OWNER;

test('通过但没关：同一份正文只通过过一次 → 再触发一轮收尾；通过两次还没关 → 不再触发；verdictOnly / watch / 已关 不触发', () => {
  const body = 'parent body';
  const version = bodyVersion(body);
  const pass = (round, finishedAt) => ({ round, status: '通过', bodyVersion: version, createdAt: finishedAt, finishedAt });
  const profile = { startAt: START_AT };
  const now = nowAt('2026-10-24T00:00:00.000Z');
  const once = parentTask({ rounds: [pass(1, '2026-10-23T00:00:00.000Z')] });
  assert.deepEqual(shouldTrigger(once, { now, profile }), { trigger: true, reason: 'passed-but-open' });
  const twice = parentTask({ rounds: [pass(1, '2026-10-22T00:00:00.000Z'), pass(2, '2026-10-23T00:00:00.000Z')] });
  assert.equal(shouldTrigger(twice, { now, profile }).trigger, false);
  const verdictOnly = { ...profile, verdictOnlyIssues: [once.ref] };
  assert.equal(shouldTrigger(once, { now, profile: verdictOnly }).trigger, false);
  assert.equal(shouldTrigger({ ...once, tier: 'watch' }, { now, profile }).trigger, false);
  assert.equal(shouldTrigger({ ...once, state: 'closed', closedAt: '2026-10-23T01:00:00.000Z' }, { now, profile }).trigger, false);
});
