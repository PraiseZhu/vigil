// #153：看板优先级打分。纯函数，事实由调用方传入；不联网、不读令牌、不读写看板。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyDebounce, RULES, scorePriority } from './bin/prio-score.mjs';

const T0 = Date.parse('2026-10-31T12:00:00Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

function facts(overrides = {}) {
  return {
    status: 'Todo',
    acceptance: null,
    labels: [],
    priority: null,
    heartbeatTimeout: false,
    hostFrozen: false,
    writeGateError: false,
    progressUpdatedAt: T0,
    roundOverLimit: false,
    prCiRed: false,
    prChangesRequested: false,
    hasPr: false,
    fixRequestedAt: T0,
    lastEventAt: T0,
    ...overrides,
  };
}

function scored(priority, rule, pinned = false) {
  return { priority, rule, pinned };
}

function blankState(overrides = {}) {
  return {
    priority: null,
    pending: null,
    pendingHeld: false,
    lastRecalcAt: null,
    consecutive: 0,
    changes: [],
    ...overrides,
  };
}

test('#153 SC1 规则表 S1–S6 的优先级，Done 或通过是清空', () => {
  assert.deepEqual(
    RULES.map((rule) => [rule.id, rule.priority]),
    [
      ['S1', 'P0'],
      ['S2', 'P0'],
      ['S3', 'P1'],
      ['S4', 'P1'],
      ['S5', 'P2'],
      ['S6', 'P3'],
      ['clear', null],
    ],
  );
});

test('#153 SC1 S1 心跳超时、host 冻结、写闸报错、blocker 标签都是 P0', () => {
  const cases = [
    { heartbeatTimeout: true },
    { hostFrozen: true },
    { writeGateError: true },
    { labels: ['bug', 'blocker'] },
  ];
  for (const extra of cases) {
    const result = scorePriority(facts(extra), T0);
    assert.equal(result.priority, 'P0', JSON.stringify(extra));
    assert.equal(result.rule, 'S1', JSON.stringify(extra));
    assert.equal(result.pinned, false);
  }
});

test('#153 SC1 S2 验收中且进度超过 30 分钟，或本轮超过上限，才是 P0', () => {
  const stale = scorePriority(
    facts({ acceptance: '验收中', progressUpdatedAt: T0 - 30 * MIN - 1, roundOverLimit: false }),
    T0,
  );
  assert.equal(stale.rule, 'S2');
  assert.equal(stale.priority, 'P0');

  const overLimit = scorePriority(
    facts({ acceptance: '验收中', progressUpdatedAt: T0, roundOverLimit: true }),
    T0,
  );
  assert.equal(overLimit.rule, 'S2');
  assert.equal(overLimit.priority, 'P0');

  // 「超过 30 分钟」不含整 30 分钟；进度时间缺失不算过期。
  const exact = scorePriority(facts({ acceptance: '验收中', progressUpdatedAt: T0 - 30 * MIN }), T0);
  assert.equal(exact.rule, 'S5');
  assert.equal(exact.priority, 'P2');

  const missingProgress = scorePriority(
    facts({ acceptance: '验收中', progressUpdatedAt: null, roundOverLimit: false }),
    T0,
  );
  assert.equal(missingProgress.rule, 'S5');

  // S2 只认「验收中」。修正中进度再旧也不是 S2。
  const fixing = scorePriority(
    facts({ acceptance: '修正中', progressUpdatedAt: T0 - 2 * HOUR, roundOverLimit: true }),
    T0,
  );
  assert.equal(fixing.rule, 'S5');
  assert.equal(fixing.priority, 'P2');
});

test('#153 SC1 S3 关联 PR 的 CI 失败、被要求修改，或要修超过 4 小时没开 PR，都是 P1', () => {
  for (const extra of [{ prCiRed: true }, { prChangesRequested: true }]) {
    const result = scorePriority(facts(extra), T0);
    assert.equal(result.rule, 'S3', JSON.stringify(extra));
    assert.equal(result.priority, 'P1', JSON.stringify(extra));
  }

  const waited = scorePriority(
    facts({ acceptance: '要修', hasPr: false, fixRequestedAt: T0 - 4 * HOUR - 1 }),
    T0,
  );
  assert.equal(waited.rule, 'S3');
  assert.equal(waited.priority, 'P1');

  const exact = scorePriority(
    facts({ acceptance: '要修', hasPr: false, fixRequestedAt: T0 - 4 * HOUR }),
    T0,
  );
  assert.equal(exact.rule, 'S6');
  assert.equal(exact.priority, 'P3');

  const opened = scorePriority(
    facts({ acceptance: '要修', hasPr: true, fixRequestedAt: T0 - 5 * HOUR }),
    T0,
  );
  assert.equal(opened.rule, 'S6');

  const noTimestamp = scorePriority(
    facts({ acceptance: '要修', hasPr: false, fixRequestedAt: null }),
    T0,
  );
  assert.equal(noTimestamp.rule, 'S6');
});

test('#153 SC1 S4 In Progress 且最近一次事件超过 24 小时是 P1', () => {
  const idle = scorePriority(
    facts({ status: 'In Progress', lastEventAt: T0 - 24 * HOUR - 1 }),
    T0,
  );
  assert.equal(idle.rule, 'S4');
  assert.equal(idle.priority, 'P1');

  const exact = scorePriority(facts({ status: 'In Progress', lastEventAt: T0 - 24 * HOUR }), T0);
  assert.equal(exact.rule, 'S6');

  const todo = scorePriority(facts({ status: 'Todo', lastEventAt: T0 - 48 * HOUR }), T0);
  assert.equal(todo.rule, 'S6');

  const missing = scorePriority(facts({ status: 'In Progress', lastEventAt: null }), T0);
  assert.equal(missing.rule, 'S6');
});

test('#153 SC1 S5 修正中或验收中且没有更高档是 P2', () => {
  for (const acceptance of ['修正中', '验收中']) {
    const result = scorePriority(facts({ acceptance, status: 'In Progress' }), T0);
    assert.equal(result.rule, 'S5', acceptance);
    assert.equal(result.priority, 'P2', acceptance);
  }
});

test('#153 SC1 S6 其它未完成项是 P3', () => {
  const todo = scorePriority(facts({ status: 'Todo', acceptance: null }), T0);
  assert.equal(todo.rule, 'S6');
  assert.equal(todo.priority, 'P3');

  const recentFix = scorePriority(
    facts({ acceptance: '要修', hasPr: false, fixRequestedAt: T0 - 4 * HOUR }),
    T0,
  );
  assert.equal(recentFix.rule, 'S6');
  assert.equal(recentFix.priority, 'P3');
});

test('#153 SC1 同时命中多档时取最高档', () => {
  const top = scorePriority(
    facts({
      status: 'In Progress',
      acceptance: '验收中',
      labels: ['blocker'],
      prCiRed: true,
      lastEventAt: T0 - 25 * HOUR,
      progressUpdatedAt: T0,
    }),
    T0,
  );
  assert.equal(top.rule, 'S1');
  assert.equal(top.priority, 'P0');

  // S3 和 S4 都是 P1，取档位更高的 S3。
  const sameRank = scorePriority(
    facts({ status: 'In Progress', prCiRed: true, lastEventAt: T0 - 25 * HOUR, acceptance: null }),
    T0,
  );
  assert.equal(sameRank.rule, 'S3');
  assert.equal(sameRank.priority, 'P1');

  // 验收中但进度卡住：S2 高于 S5。
  const stuck = scorePriority(
    facts({ acceptance: '验收中', progressUpdatedAt: T0 - 31 * MIN }),
    T0,
  );
  assert.equal(stuck.rule, 'S2');
  assert.equal(stuck.priority, 'P0');
});

test('#153 SC1 Done 或验收通过返回清空，压过其它命中', () => {
  const done = scorePriority(
    facts({ status: 'Done', acceptance: '验收中', labels: ['blocker'], prCiRed: true, heartbeatTimeout: true }),
    T0,
  );
  assert.deepEqual(done, { priority: null, rule: 'clear', pinned: false });

  const passed = scorePriority(
    facts({ status: 'In Progress', acceptance: '通过', lastEventAt: T0 - 48 * HOUR, prChangesRequested: true }),
    T0,
  );
  assert.deepEqual(passed, { priority: null, rule: 'clear', pinned: false });
});

test('#153 SC2 升级立刻写，空优先级升到有值也算升级', () => {
  const raised = applyDebounce(blankState({ priority: 'P2' }), scored('P0', 'S1'), T0);
  assert.equal(raised.action, 'write');
  assert.equal(raised.priority, 'P0');
  assert.equal(raised.alert, false);
  assert.equal(raised.next.pendingHeld, false);
  assert.deepEqual(raised.next.changes, [T0]);

  const filled = applyDebounce(blankState({ priority: null }), scored('P3', 'S6'), T0);
  assert.equal(filled.action, 'write');
  assert.equal(filled.priority, 'P3');

  const pending = applyDebounce(blankState({ priority: 'P2' }), scored('P3', 'S6'), T0);
  assert.equal(pending.action, 'skip');
  const interrupt = applyDebounce(pending.next, scored('P0', 'S1'), T0 + 1000);
  assert.equal(interrupt.action, 'write');
  assert.equal(interrupt.priority, 'P0');
  assert.equal(interrupt.next.pendingHeld, false);
  assert.equal(interrupt.next.consecutive, 0);
});

test('#153 SC2 降级要连续 2 次且间隔不少于 15 分钟', () => {
  const first = applyDebounce(blankState({ priority: 'P0' }), scored('P2', 'S5'), T0);
  assert.equal(first.action, 'skip');
  assert.equal(first.priority, 'P0');
  assert.equal(first.next.consecutive, 1);
  assert.equal(first.next.pending, 'P2');
  assert.equal(first.next.pendingHeld, true);
  assert.equal(first.next.lastRecalcAt, T0);
  assert.deepEqual(first.next.changes, []);

  const early = applyDebounce(first.next, scored('P2', 'S5'), T0 + 15 * MIN - 1);
  assert.equal(early.action, 'skip');
  assert.equal(early.priority, 'P0');
  assert.equal(early.next.consecutive, 2);
  assert.equal(early.next.lastRecalcAt, T0);

  const onTime = applyDebounce(early.next, scored('P2', 'S5'), T0 + 15 * MIN);
  assert.equal(onTime.action, 'write');
  assert.equal(onTime.priority, 'P2');
  assert.equal(onTime.rule, 'S5');
  assert.equal(onTime.next.pendingHeld, false);
  assert.equal(onTime.next.consecutive, 0);
  assert.deepEqual(onTime.next.changes, [T0 + 15 * MIN]);
});

test('#153 SC2 降级目标变了就重新计连续次数和起始时间', () => {
  const first = applyDebounce(blankState({ priority: 'P0' }), scored('P2', 'S5'), T0);
  const shifted = applyDebounce(first.next, scored('P3', 'S6'), T0 + 20 * MIN);
  assert.equal(shifted.action, 'skip');
  assert.equal(shifted.next.pending, 'P3');
  assert.equal(shifted.next.consecutive, 1);
  assert.equal(shifted.next.lastRecalcAt, T0 + 20 * MIN);

  const tooSoon = applyDebounce(shifted.next, scored('P3', 'S6'), T0 + 20 * MIN + 15 * MIN - 1);
  assert.equal(tooSoon.action, 'skip');
  const confirmed = applyDebounce(shifted.next, scored('P3', 'S6'), T0 + 20 * MIN + 15 * MIN);
  assert.equal(confirmed.action, 'write');
  assert.equal(confirmed.priority, 'P3');
});

test('#153 SC2 值没变不写，也不消耗每小时次数', () => {
  const input = blankState({ priority: 'P2', changes: [T0 - 2 * HOUR, T0 - 1000] });
  const snapshot = structuredClone(input);
  const decision = applyDebounce(input, scored('P2', 'S4'), T0);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.alert, false);
  assert.equal(decision.priority, 'P2');
  assert.equal(decision.next.consecutive, 0);
  assert.equal(decision.next.pendingHeld, false);
  assert.deepEqual(decision.next.changes, [T0 - 1000]);
  assert.deepEqual(input, snapshot);
});

test('#153 SC2 每小时变化超过 4 次返回冻结；满 1 小时的旧变化不再计数', () => {
  let current = blankState({ priority: null });
  const steps = [
    ['P3', 0],
    ['P2', 1000],
    ['P1', 2000],
    ['P0', 3000],
  ];
  for (const [priority, at] of steps) {
    const decision = applyDebounce(current, scored(priority, 'S1'), T0 + at);
    assert.equal(decision.action, 'write', priority);
    assert.equal(decision.alert, false);
    current = decision.next;
  }
  assert.equal(current.changes.length, 4);
  assert.equal(current.priority, 'P0');

  const seen = applyDebounce(current, scored('P1', 'S3'), T0 + 3000);
  assert.equal(seen.action, 'skip');
  const frozen = applyDebounce(seen.next, scored('P1', 'S3'), T0 + 3000 + 15 * MIN);
  assert.equal(frozen.action, 'freeze');
  assert.equal(frozen.alert, true);
  assert.equal(frozen.priority, 'P0');
  assert.equal(frozen.next.priority, 'P0');
  assert.equal(frozen.next.changes.length, 4);

  // 最早一次写入正好满 1 小时，滑出窗口，已确认的降级可以写。
  const resumed = applyDebounce(frozen.next, scored('P1', 'S3'), T0 + HOUR);
  assert.equal(resumed.action, 'write');
  assert.equal(resumed.alert, false);
  assert.equal(resumed.priority, 'P1');
});

test('#153 SC2 清空优先级按降级防抖', () => {
  const cleared = scorePriority(
    facts({ status: 'Done', priority: 'P1', labels: ['blocker'], heartbeatTimeout: true }),
    T0,
  );
  assert.equal(cleared.priority, null);
  assert.equal(cleared.rule, 'clear');

  const first = applyDebounce(blankState({ priority: 'P1' }), cleared, T0);
  assert.equal(first.action, 'skip');
  assert.equal(first.priority, 'P1');
  assert.equal(first.next.pending, null);
  assert.equal(first.next.pendingHeld, true);

  const second = applyDebounce(first.next, cleared, T0 + 15 * MIN);
  assert.equal(second.action, 'write');
  assert.equal(second.priority, null);
  assert.equal(second.rule, 'clear');
});

test('#153 SC3 带 prio:pin 永远返回原值', () => {
  const pinned = scorePriority(
    facts({
      labels: ['prio:pin', 'blocker'],
      priority: 'P3',
      status: 'In Progress',
      heartbeatTimeout: true,
      hostFrozen: true,
      writeGateError: true,
      prCiRed: true,
    }),
    T0,
  );
  assert.deepEqual(pinned, { priority: 'P3', rule: 'pin', pinned: true });

  const pinnedDone = scorePriority(
    facts({ labels: ['prio:pin'], priority: 'P1', status: 'Done', acceptance: '通过' }),
    T0,
  );
  assert.deepEqual(pinnedDone, { priority: 'P1', rule: 'pin', pinned: true });

  const pinnedEmpty = scorePriority(facts({ labels: ['prio:pin'], priority: null, prCiRed: true }), T0);
  assert.deepEqual(pinnedEmpty, { priority: null, rule: 'pin', pinned: true });

  // 标签要整段相等，前缀不算钉住。
  const notPin = scorePriority(facts({ labels: ['prio:pinned'], priority: 'P3', heartbeatTimeout: true }), T0);
  assert.equal(notPin.rule, 'S1');
  assert.equal(notPin.priority, 'P0');
  assert.equal(notPin.pinned, false);
});

test('#153 SC3 钉住的条目防抖也不写', () => {
  const pinned = scorePriority(
    facts({ labels: ['prio:pin'], priority: 'P2', heartbeatTimeout: true }),
    T0,
  );
  const input = blankState({ priority: 'P0', changes: [T0 - 1000] });
  const snapshot = structuredClone(input);
  const decision = applyDebounce(input, pinned, T0);
  assert.equal(decision.action, 'skip');
  assert.equal(decision.alert, false);
  assert.equal(decision.priority, 'P2');
  assert.equal(decision.rule, 'pin');
  assert.equal(decision.next.priority, 'P2');
  assert.deepEqual(decision.next.changes, [T0 - 1000]);
  assert.deepEqual(input, snapshot);
});

test('#153 SC4 模块不含网络调用、不读环境变量里的令牌', () => {
  const source = readFileSync(fileURLToPath(new URL('./bin/prio-score.mjs', import.meta.url)), 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false);
  assert.equal(source.includes('process.env'), false);
  assert.equal(source.includes('fetch('), false);
  assert.equal(source.includes('Date.now'), false);
  assert.equal(/node:(?:https?|net|dns|tls|http2|child_process|fs)\b/.test(source), false);
  assert.equal(/\b(?:graphql|WebSocket|XMLHttpRequest|child_process)\b/.test(source), false);
  assert.equal(/\b(?:GITHUB_TOKEN|GH_TOKEN|Authorization|Bearer)\b/.test(source), false);

  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'present';
  try {
    const withEnv = scorePriority(facts({ labels: ['blocker'] }), T0);
    delete process.env.GITHUB_TOKEN;
    const withoutEnv = scorePriority(facts({ labels: ['blocker'] }), T0);
    assert.deepEqual(withEnv, withoutEnv);
    assert.equal(withEnv.priority, 'P0');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test('#153 打分不改传入的事实', () => {
  const input = facts({ labels: ['blocker'], priority: 'P2' });
  const snapshot = structuredClone(input);
  scorePriority(input, T0);
  assert.deepEqual(input, snapshot);
});
