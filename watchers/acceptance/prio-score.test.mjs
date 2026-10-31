// #153：看板优先级打分。纯函数，事实由调用方传入；不联网、不读令牌、不读写看板。
// 规则以 #62 为准：情形档按仓换算，机器信号只升不降，只有 issue 关闭才清空。
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
    issueState: 'open',
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

function assertBasis(result) {
  assert.equal(typeof result.basis, 'string');
  assert.ok(result.basis.trim().length > 0, `basis 为空：${JSON.stringify(result)}`);
}

test('#153 规则表：机器信号只剩 S1–S5，兜底是低置信 P2，清空只认 issue 关闭', () => {
  assert.deepEqual(
    RULES.map((rule) => [rule.id, rule.priority]),
    [
      ['S1', 'P0'],
      ['S2', 'P0'],
      ['S3', 'P1'],
      ['S4', 'P1'],
      ['S5', 'P2'],
      ['fallback', 'P2'],
      ['clear', null],
    ],
  );
  assert.equal(RULES.some((rule) => rule.id === 'S6'), false);
});

test('#153 情形档 × repoClass 全表，没有信号时不升档', () => {
  const table = {
    mivo: { P0: 'P0', P1: 'P1', P2: 'P2', P3: 'P3' },
    'daily-tool': { P0: 'P0', P1: 'P2', P2: 'P2', P3: 'P3' },
    idle: { P0: 'P0', P1: 'P3', P2: 'P3', P3: 'P3' },
  };
  for (const [repoClass, row] of Object.entries(table)) {
    for (const [situationTier, priority] of Object.entries(row)) {
      const result = scorePriority(facts({ situationTier, repoClass, issueState: 'open' }), T0);
      const label = `${repoClass} 情形档 ${situationTier}`;
      assert.equal(result.priority, priority, label);
      assert.equal(result.rule, 'situation', label);
      assert.equal(result.lowConfidence, false, label);
      assert.equal(result.pinned, false, label);
      assert.match(result.basis, new RegExp(`情形档 ${situationTier}`), label);
      assertBasis(result);
    }
  }
});

test('#153 basis 写明按仓降档；idle 的 P0 保持 P0，P1 及以下再低一档', () => {
  const daily = scorePriority(facts({ situationTier: 'P1', repoClass: 'daily-tool' }), T0);
  assert.equal(daily.priority, 'P2');
  assert.match(daily.basis, /情形档 P1/);
  assert.match(daily.basis, /daily-tool/);
  assert.match(daily.basis, /P2/);

  const idleTop = scorePriority(facts({ situationTier: 'P0', repoClass: 'idle' }), T0);
  assert.equal(idleTop.priority, 'P0');
  assert.equal(idleTop.rule, 'situation');
  assert.match(idleTop.basis, /情形档 P0/);
  assert.match(idleTop.basis, /idle/);
  assert.match(idleTop.basis, /保持 P0/);
  assert.doesNotMatch(idleTop.basis, /为 P1/);

  const idleMid = scorePriority(facts({ situationTier: 'P1', repoClass: 'idle' }), T0);
  assert.equal(idleMid.priority, 'P3');
  assert.match(idleMid.basis, /P3/);

  const idleFeature = scorePriority(facts({ situationTier: 'P2', repoClass: 'idle' }), T0);
  assert.equal(idleFeature.priority, 'P3');
  assert.equal(idleFeature.rule, 'situation');
});

test('#153 没给 repoClass 时不降档，和 mivo 一样', () => {
  const named = scorePriority(facts({ situationTier: 'P1', repoClass: 'mivo' }), T0);
  const omitted = scorePriority(facts({ situationTier: 'P1' }), T0);
  assert.equal(named.priority, 'P1');
  assert.equal(omitted.priority, 'P1');
  assert.equal(omitted.rule, 'situation');
});

test('#153 没给情形档且没有机器信号时返回 P2，并标低置信', () => {
  for (const repoClass of ['mivo', 'daily-tool', 'idle', undefined]) {
    const result = scorePriority(facts({ repoClass, issueState: 'open', status: 'Todo' }), T0);
    assert.equal(result.priority, 'P2', String(repoClass));
    assert.equal(result.rule, 'fallback', String(repoClass));
    assert.equal(result.lowConfidence, true, String(repoClass));
    assert.match(result.basis, /低置信/);
    assert.match(result.basis, /P2/);
    assertBasis(result);
  }
});

test('#153 机器信号只升不降：低于情形档换算结果时保持换算结果', () => {
  const kept = scorePriority(
    facts({
      situationTier: 'P0',
      repoClass: 'mivo',
      acceptance: '验收中',
      prCiRed: true,
      status: 'In Progress',
      lastEventAt: T0 - 25 * HOUR,
    }),
    T0,
  );
  assert.equal(kept.priority, 'P0');
  assert.equal(kept.rule, 'situation');
  assert.equal(kept.lowConfidence, false);
  assert.match(kept.basis, /情形档 P0/);
  assert.match(kept.basis, /没有机器信号升档/);

  const dailyKept = scorePriority(
    facts({ situationTier: 'P0', repoClass: 'daily-tool', prChangesRequested: true }),
    T0,
  );
  assert.equal(dailyKept.priority, 'P0');
  assert.equal(dailyKept.rule, 'situation');
});

test('#153 机器信号能把换算结果往上升，取更高的那一档', () => {
  const raised = scorePriority(
    facts({ situationTier: 'P3', repoClass: 'mivo', heartbeatTimeout: true }),
    T0,
  );
  assert.equal(raised.priority, 'P0');
  assert.equal(raised.rule, 'S1');
  assert.equal(raised.lowConfidence, false);
  assert.match(raised.basis, /情形档 P3/);
  assert.match(raised.basis, /S1/);
  assert.match(raised.basis, /P0/);

  const aboveAdjusted = scorePriority(
    facts({ situationTier: 'P1', repoClass: 'daily-tool', prCiRed: true }),
    T0,
  );
  assert.equal(aboveAdjusted.priority, 'P1');
  assert.equal(aboveAdjusted.rule, 'S3');
  assert.match(aboveAdjusted.basis, /情形档 P1/);
  assert.match(aboveAdjusted.basis, /daily-tool/);
  assert.match(aboveAdjusted.basis, /S3/);

  const idleKept = scorePriority(
    facts({ situationTier: 'P0', repoClass: 'idle', labels: ['blocker'] }),
    T0,
  );
  assert.equal(idleKept.priority, 'P0');
  assert.equal(idleKept.rule, 'situation');

  const idleRaised = scorePriority(
    facts({ situationTier: 'P1', repoClass: 'idle', labels: ['blocker'] }),
    T0,
  );
  assert.equal(idleRaised.priority, 'P0');
  assert.equal(idleRaised.rule, 'S1');
});

test('#153 多条信号同时命中时用最高的那条升档', () => {
  const result = scorePriority(
    facts({
      situationTier: 'P3',
      repoClass: 'mivo',
      labels: ['blocker'],
      prCiRed: true,
      acceptance: '验收中',
      status: 'In Progress',
      lastEventAt: T0 - 25 * HOUR,
    }),
    T0,
  );
  assert.equal(result.priority, 'P0');
  assert.equal(result.rule, 'S1');
  assert.match(result.basis, /S1/);
});

test('#153 S1 心跳超时、host 冻结、写闸报错、blocker 标签都能升到 P0', () => {
  const cases = [
    { heartbeatTimeout: true },
    { hostFrozen: true },
    { writeGateError: true },
    { labels: ['bug', 'blocker'] },
  ];
  for (const extra of cases) {
    const result = scorePriority(facts({ situationTier: 'P3', repoClass: 'mivo', ...extra }), T0);
    assert.equal(result.priority, 'P0', JSON.stringify(extra));
    assert.equal(result.rule, 'S1', JSON.stringify(extra));
    assert.equal(result.lowConfidence, false);
  }
});

test('#153 S2 验收中且进度超过 30 分钟，或本轮超过上限，升到 P0', () => {
  const stale = scorePriority(
    facts({
      situationTier: 'P3',
      repoClass: 'mivo',
      acceptance: '验收中',
      progressUpdatedAt: T0 - 30 * MIN - 1,
      roundOverLimit: false,
    }),
    T0,
  );
  assert.equal(stale.rule, 'S2');
  assert.equal(stale.priority, 'P0');

  const overLimit = scorePriority(
    facts({ situationTier: 'P3', repoClass: 'mivo', acceptance: '验收中', roundOverLimit: true }),
    T0,
  );
  assert.equal(overLimit.rule, 'S2');
  assert.equal(overLimit.priority, 'P0');

  const exact = scorePriority(
    facts({
      situationTier: 'P3',
      repoClass: 'mivo',
      acceptance: '验收中',
      progressUpdatedAt: T0 - 30 * MIN,
    }),
    T0,
  );
  assert.equal(exact.rule, 'S5');
  assert.equal(exact.priority, 'P2');

  const missingProgress = scorePriority(
    facts({
      situationTier: 'P3',
      repoClass: 'mivo',
      acceptance: '验收中',
      progressUpdatedAt: null,
      roundOverLimit: false,
    }),
    T0,
  );
  assert.equal(missingProgress.rule, 'S5');
  assert.equal(missingProgress.priority, 'P2');

  const fixing = scorePriority(
    facts({
      situationTier: 'P3',
      repoClass: 'mivo',
      acceptance: '修正中',
      progressUpdatedAt: T0 - 2 * HOUR,
      roundOverLimit: true,
    }),
    T0,
  );
  assert.equal(fixing.rule, 'S5');
  assert.equal(fixing.priority, 'P2');
});

test('#153 S3 关联 PR 的 CI 失败、被要求修改，或要修超过 4 小时没开 PR，升到 P1', () => {
  for (const extra of [{ prCiRed: true }, { prChangesRequested: true }]) {
    const result = scorePriority(facts({ situationTier: 'P3', repoClass: 'mivo', ...extra }), T0);
    assert.equal(result.rule, 'S3', JSON.stringify(extra));
    assert.equal(result.priority, 'P1', JSON.stringify(extra));
  }

  const waited = scorePriority(
    facts({
      situationTier: 'P3',
      repoClass: 'mivo',
      acceptance: '要修',
      hasPr: false,
      fixRequestedAt: T0 - 4 * HOUR - 1,
    }),
    T0,
  );
  assert.equal(waited.rule, 'S3');
  assert.equal(waited.priority, 'P1');

  const exact = scorePriority(
    facts({
      situationTier: 'P3',
      repoClass: 'idle',
      acceptance: '要修',
      hasPr: false,
      fixRequestedAt: T0 - 4 * HOUR,
    }),
    T0,
  );
  assert.equal(exact.priority, 'P3');
  assert.equal(exact.rule, 'situation');

  const opened = scorePriority(
    facts({
      situationTier: 'P3',
      repoClass: 'mivo',
      acceptance: '要修',
      hasPr: true,
      fixRequestedAt: T0 - 5 * HOUR,
    }),
    T0,
  );
  assert.equal(opened.rule, 'situation');
  assert.equal(opened.priority, 'P3');
});

test('#153 S4 In Progress 且最近一次事件超过 24 小时升到 P1；没超过就不升', () => {
  const idleEvent = scorePriority(
    facts({ situationTier: 'P3', repoClass: 'mivo', status: 'In Progress', lastEventAt: T0 - 24 * HOUR - 1 }),
    T0,
  );
  assert.equal(idleEvent.rule, 'S4');
  assert.equal(idleEvent.priority, 'P1');

  const exact = scorePriority(
    facts({ situationTier: 'P3', repoClass: 'mivo', status: 'In Progress', lastEventAt: T0 - 24 * HOUR }),
    T0,
  );
  assert.equal(exact.rule, 'situation');
  assert.equal(exact.priority, 'P3');

  const todo = scorePriority(
    facts({ situationTier: 'P2', repoClass: 'mivo', status: 'Todo', lastEventAt: T0 - 48 * HOUR }),
    T0,
  );
  assert.equal(todo.priority, 'P2');
  assert.equal(todo.rule, 'situation');
});

test('#153 验收通过或 Done 但 issue 仍开着时不清空', () => {
  const passed = scorePriority(
    facts({
      status: 'Done',
      acceptance: '通过',
      issueState: 'open',
      situationTier: 'P3',
      repoClass: 'mivo',
      prCiRed: true,
    }),
    T0,
  );
  assert.equal(passed.priority, 'P1');
  assert.equal(passed.rule, 'S3');
  assert.equal(passed.lowConfidence, false);
  assertBasis(passed);

  const quiet = scorePriority(
    facts({ status: 'Done', acceptance: '通过', issueState: 'open', situationTier: 'P2', repoClass: 'daily-tool' }),
    T0,
  );
  assert.equal(quiet.priority, 'P2');
  assert.equal(quiet.rule, 'situation');
  assert.notEqual(quiet.priority, null);
});

test('#153 只有 issue 关闭才清空，压过情形档和机器信号', () => {
  const closed = scorePriority(
    facts({
      issueState: 'closed',
      status: 'Done',
      acceptance: '通过',
      situationTier: 'P0',
      repoClass: 'mivo',
      heartbeatTimeout: true,
      labels: ['blocker'],
    }),
    T0,
  );
  assert.equal(closed.priority, null);
  assert.equal(closed.rule, 'clear');
  assert.equal(closed.pinned, false);
  assert.equal(closed.lowConfidence, false);
  assert.match(closed.basis, /关闭/);
  assertBasis(closed);

  const notClosed = scorePriority(
    facts({ issueState: 'CLOSED', situationTier: 'P1', repoClass: 'mivo' }),
    T0,
  );
  assert.equal(notClosed.priority, 'P1');
  assert.equal(notClosed.rule, 'situation');
});

test('#153 SC2 升级立刻写，空优先级升到有值也算升级', () => {
  const raised = applyDebounce(blankState({ priority: 'P2' }), scored('P0', 'S1'), T0);
  assert.equal(raised.action, 'write');
  assert.equal(raised.priority, 'P0');
  assert.equal(raised.alert, false);
  assert.equal(raised.next.pendingHeld, false);
  assert.deepEqual(raised.next.changes, [T0]);

  const filled = applyDebounce(blankState({ priority: null }), scored('P3', 'situation'), T0);
  assert.equal(filled.action, 'write');
  assert.equal(filled.priority, 'P3');

  const pending = applyDebounce(blankState({ priority: 'P2' }), scored('P3', 'situation'), T0);
  assert.equal(pending.action, 'skip');
  const interrupt = applyDebounce(pending.next, scored('P0', 'S1'), T0 + 1000);
  assert.equal(interrupt.action, 'write');
  assert.equal(interrupt.priority, 'P0');
  assert.equal(interrupt.next.pendingHeld, false);
  assert.equal(interrupt.next.consecutive, 0);
});

test('#153 SC2 降级要连续 2 次且间隔不少于 15 分钟', () => {
  const first = applyDebounce(blankState({ priority: 'P0' }), scored('P2', 'situation'), T0);
  assert.equal(first.action, 'skip');
  assert.equal(first.priority, 'P0');
  assert.equal(first.next.consecutive, 1);
  assert.equal(first.next.pending, 'P2');
  assert.equal(first.next.pendingHeld, true);
  assert.equal(first.next.lastRecalcAt, T0);
  assert.deepEqual(first.next.changes, []);

  const early = applyDebounce(first.next, scored('P2', 'situation'), T0 + 15 * MIN - 1);
  assert.equal(early.action, 'skip');
  assert.equal(early.priority, 'P0');
  assert.equal(early.next.consecutive, 2);
  assert.equal(early.next.lastRecalcAt, T0);

  const onTime = applyDebounce(early.next, scored('P2', 'situation'), T0 + 15 * MIN);
  assert.equal(onTime.action, 'write');
  assert.equal(onTime.priority, 'P2');
  assert.equal(onTime.rule, 'situation');
  assert.equal(onTime.next.pendingHeld, false);
  assert.equal(onTime.next.consecutive, 0);
  assert.deepEqual(onTime.next.changes, [T0 + 15 * MIN]);
});

test('#153 SC2 降级目标变了就重新计连续次数和起始时间', () => {
  const first = applyDebounce(blankState({ priority: 'P0' }), scored('P2', 'situation'), T0);
  const shifted = applyDebounce(first.next, scored('P3', 'situation'), T0 + 20 * MIN);
  assert.equal(shifted.action, 'skip');
  assert.equal(shifted.next.pending, 'P3');
  assert.equal(shifted.next.consecutive, 1);
  assert.equal(shifted.next.lastRecalcAt, T0 + 20 * MIN);

  const tooSoon = applyDebounce(shifted.next, scored('P3', 'situation'), T0 + 20 * MIN + 15 * MIN - 1);
  assert.equal(tooSoon.action, 'skip');
  const confirmed = applyDebounce(shifted.next, scored('P3', 'situation'), T0 + 20 * MIN + 15 * MIN);
  assert.equal(confirmed.action, 'write');
  assert.equal(confirmed.priority, 'P3');
});

test('#153 SC2 值没变不写，也不消耗每小时次数', () => {
  const input = blankState({ priority: 'P2', changes: [T0 - 2 * HOUR, T0 - 1000] });
  const snapshot = structuredClone(input);
  const decision = applyDebounce(input, scored('P2', 'situation'), T0);
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

  const resumed = applyDebounce(frozen.next, scored('P1', 'S3'), T0 + HOUR);
  assert.equal(resumed.action, 'write');
  assert.equal(resumed.alert, false);
  assert.equal(resumed.priority, 'P1');
});

test('#153 关闭 issue 的清空按降级防抖', () => {
  const cleared = scorePriority(
    facts({ issueState: 'closed', situationTier: 'P1', repoClass: 'mivo', heartbeatTimeout: true }),
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
      situationTier: 'P0',
      repoClass: 'mivo',
      heartbeatTimeout: true,
      issueState: 'closed',
    }),
    T0,
  );
  assert.equal(pinned.priority, 'P3');
  assert.equal(pinned.rule, 'pin');
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.lowConfidence, false);
  assert.match(pinned.basis, /prio:pin/);
  assertBasis(pinned);

  const pinnedEmpty = scorePriority(facts({ labels: ['prio:pin'], priority: null, prCiRed: true }), T0);
  assert.equal(pinnedEmpty.priority, null);
  assert.equal(pinnedEmpty.pinned, true);

  const notPin = scorePriority(
    facts({ labels: ['prio:pinned'], priority: 'P3', situationTier: 'P3', repoClass: 'mivo', heartbeatTimeout: true }),
    T0,
  );
  assert.equal(notPin.rule, 'S1');
  assert.equal(notPin.priority, 'P0');
  assert.equal(notPin.pinned, false);
});

test('#153 SC3 钉住的条目防抖也不写', () => {
  const pinned = scorePriority(
    facts({ labels: ['prio:pin'], priority: 'P2', heartbeatTimeout: true, situationTier: 'P0' }),
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
    const withEnv = scorePriority(facts({ labels: ['blocker'], situationTier: 'P3', repoClass: 'mivo' }), T0);
    delete process.env.GITHUB_TOKEN;
    const withoutEnv = scorePriority(facts({ labels: ['blocker'], situationTier: 'P3', repoClass: 'mivo' }), T0);
    assert.deepEqual(withEnv, withoutEnv);
    assert.equal(withEnv.priority, 'P0');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test('#153 打分不改传入的事实', () => {
  const input = facts({ labels: ['blocker'], priority: 'P2', situationTier: 'P1', repoClass: 'daily-tool' });
  const snapshot = structuredClone(input);
  scorePriority(input, T0);
  assert.deepEqual(input, snapshot);
});
