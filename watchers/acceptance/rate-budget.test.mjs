// #247 额度预算与真实剩余两道闸：判定入口的表驱动边界、预算、恢复期、分令牌记账、看板快照。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  BOARD_SKIP_REMAINING,
  COMPONENTS,
  IDENTITY_APP,
  IDENTITY_USER,
  MAX_CONSECUTIVE_SKIPS,
  PAUSE_REMAINING,
  RECOVERY_WINDOW_MS,
  TICK_SECONDS,
  boardSnapshotFile,
  budgetConfigFile,
  POLL_COMPONENT,
  chargeBudget,
  decideTick,
  emptyRateState,
  pollUsage,
  pollUsageLogLine,
  identityRecord,
  parseRemaining,
  parseReset,
  rateStateFile,
  readBoardSnapshot,
  readBudgetFile,
  readBudgets,
  readRateState,
  recordHeader,
  windowPhase,
  writeBoardSnapshot,
  writeRateState,
} from './bin/rate-budget.mjs';
import { hostPaths } from './host/paths.mjs';
import { tmpDir } from './fake-gh.fixture.mjs';

const NOW = Date.parse('2026-11-04T18:00:00.000Z');
const RESET_IN_10_MIN = String(Math.floor(NOW / 1000) + 600);
const RESET_ALREADY_PASSED = String(Math.floor(NOW / 1000) - 60);

function stateWith(remaining, { identity = IDENTITY_USER, reset = RESET_IN_10_MIN, at = NOW } = {}) {
  return recordHeader(emptyRateState(), { identity, remaining, reset, at });
}

function decide(options) {
  return decideTick({ component: 'loop', purpose: 'board', now: NOW, ...options });
}

test('#247 阈值常量集中在一处，数值就是 1500 / 800（严格小于）', () => {
  assert.equal(BOARD_SKIP_REMAINING, 1500);
  assert.equal(PAUSE_REMAINING, 800);
  assert.equal(TICK_SECONDS, 180);
  assert.equal(MAX_CONSECUTIVE_SKIPS, 5);
  assert.deepEqual([...COMPONENTS], ['loop', 'prio-run', 'board-live']);
});

test('#247 SC7 响应头剩余：缺失、非数字算未知，不猜成 0', () => {
  assert.deepEqual(parseRemaining('0'), { known: true, remaining: 0, raw: '0' });
  assert.deepEqual(parseRemaining(' 1500 '), { known: true, remaining: 1500, raw: '1500' });
  assert.deepEqual(parseRemaining(undefined), { known: false, remaining: null, raw: '' });
  assert.deepEqual(parseRemaining(''), { known: false, remaining: null, raw: '' });
  assert.deepEqual(parseRemaining('n/a'), { known: false, remaining: null, raw: 'n/a' });
  assert.deepEqual(parseReset('1700000000'), { known: true, resetAt: 1700000000000, raw: '1700000000' });
  assert.equal(parseReset('later').known, false);
});

// SC7 的表：每一行都是一个独立用例，断言「跳过 / 不跳过」「暂停 / 不暂停」「写什么日志」「抛不抛错」。
const CASES = [
  {
    name: '剩余 = 0：跳过看板读且全面暂停非必要读，写 remaining=0 的日志，不抛错',
    remaining: 0,
    purpose: 'board',
    expectAllowed: false,
    expectMode: 'paused',
    expectLogKind: 'rate-skip',
    expectLog: [/remaining=0/, /action=remaining-below-800/, /因额度跳过$/],
  },
  {
    name: '缺 X-Ratelimit-Remaining：写 rate-unknown，不跳过、不暂停',
    missing: true,
    purpose: 'board',
    expectAllowed: true,
    expectMode: 'rate-unknown',
    expectLogKind: 'rate-unknown',
    expectLog: [/remaining=unknown/, /raw=（缺失）/, /本拍不跳过$/],
  },
  {
    name: '头值非数字（n/a）：同缺头，写 rate-unknown 并带原始值',
    remaining: 'n/a',
    purpose: 'board',
    expectAllowed: true,
    expectMode: 'rate-unknown',
    expectLogKind: 'rate-unknown',
    expectLog: [/raw=n\/a/, /本拍不跳过$/],
  },
  {
    name: '剩余恰好 = 1500：不跳过看板读（阈值严格小于）',
    remaining: 1500,
    purpose: 'board',
    expectAllowed: true,
    expectMode: 'normal',
    expectLogKind: null,
  },
  {
    name: '剩余 1499：低于 1500 就跳过看板读',
    remaining: 1499,
    purpose: 'board',
    expectAllowed: false,
    expectMode: 'board-skipped',
    expectLogKind: 'rate-skip',
    expectLog: [/remaining=1499/, /action=remaining-below-1500/],
  },
  {
    name: '剩余恰好 = 800：跳过看板读，但其余非必要读不暂停',
    remaining: 800,
    purpose: 'board',
    expectAllowed: false,
    expectMode: 'board-skipped',
    expectLogKind: 'rate-skip',
  },
  {
    // 复审 rev-258 补的那一格：严格小于才算暂停，恰好 800 的非必要读要放行（原先只钉了看板读那一档）。
    name: '剩余恰好 = 800 且这一读是非必要（非看板）：放行（严格小于才暂停）',
    remaining: 800,
    purpose: 'non-essential',
    expectAllowed: true,
    expectMode: 'normal',
    expectLogKind: null,
  },
  {
    name: '剩余 799：全面暂停非必要读；主循环 poll（essential）照跑',
    remaining: 799,
    purpose: 'non-essential',
    expectAllowed: false,
    expectMode: 'paused',
    expectLogKind: 'rate-skip',
    expectLog: [/remaining=799/, /action=remaining-below-800/],
  },
  {
    name: '剩余 799 但这一读是 poll（essential）：放行',
    remaining: 799,
    purpose: 'essential',
    expectAllowed: true,
    expectMode: 'normal',
    expectLogKind: null,
  },
];

for (const item of CASES) {
  test(`#247 SC7 ${item.name}`, () => {
    const state = item.missing ? emptyRateState() : stateWith(item.remaining);
    let decided;
    assert.doesNotThrow(() => {
      decided = decide({ state, purpose: item.purpose });
    });
    assert.equal(decided.allowed, item.expectAllowed);
    assert.equal(decided.mode, item.expectMode);
    if (item.expectLogKind) {
      assert.equal(typeof decided.log, 'string');
      assert.match(decided.log, new RegExp(`^\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z ${item.expectLogKind} `));
      for (const pattern of item.expectLog || []) assert.match(decided.log, pattern);
    } else {
      assert.equal(decided.log, null);
    }
    // 跳过时不能抛错、也不能写失败：只返回 allowed=false。
    assert.equal(decided.identity, IDENTITY_USER);
  });
}

test('#247 SC7 reset 已过：不沿用旧窗口的暂停状态，恢复读取', () => {
  // 旧窗口剩余 0，但 reset 已过 1 分钟：这一拍照读（并在恢复期内按错开顺序限速）。
  const state = stateWith(0, { reset: RESET_ALREADY_PASSED });
  const decided = decide({ state, purpose: 'non-essential' });
  assert.equal(decided.allowed, true, 'reset 已过就不再按旧窗口的 0 暂停');
  assert.match(decided.log, /rate-recovery/);
  assert.match(decided.log, /重置后限速恢复/);
});

test('#247 SC7 恢复期过了但还没拿到新窗口响应头：旧剩余不参与判定（写 rate-unknown）', () => {
  // reset 已经过去 10 分钟：恢复期结束，旧窗口的 0 不能再拿来暂停。
  const state = stateWith(0, { reset: String(Math.floor((NOW - 10 * 60_000) / 1000)) });
  const decided = decideTick({
    component: 'prio-run',
    purpose: 'board',
    state,
    now: NOW,
  });
  assert.equal(decided.allowed, true);
  assert.equal(decided.mode, 'rate-unknown');
  assert.match(decided.log, /reason=window-reset/);
});

test('#247 SC8 重置后限速恢复：每拍最多一次非必要读，按错开顺序，5 分钟后回常态', () => {
  const resetAt = Math.floor(NOW / 1000) - 30; // 30 秒前刚重置
  let state = stateWith(0, { reset: String(resetAt) });
  const tick = (minute) => {
    const at = NOW + minute * 60_000;
    const tickId = `t${minute}`;
    const loop = decideTick({ component: 'loop', purpose: 'board', state, now: at, tickId });
    state = loop.state;
    const prio = decideTick({ component: 'prio-run', purpose: 'board', state, now: at, tickId });
    state = prio.state;
    return { loop, prio };
  };

  // 重置后第 1 分钟：轮到 loop 先恢复，prio-run 同一拍让路。
  const first = tick(1);
  assert.equal(first.loop.allowed, true, '排第一的消费方先恢复');
  assert.equal(first.prio.allowed, false, '同一拍不给第二个消费方');
  assert.equal(first.prio.reason, 'recovery-turn');
  assert.match(first.loop.log, /rate-recovery/);

  // 第 4 分钟（仍在 5 分钟窗口内）：轮到下一个消费方。
  const second = tick(4);
  assert.equal(second.loop.allowed, false, '轮转后 loop 让路');
  assert.equal(second.prio.allowed, true, 'prio-run 拿到这一拍的额度');
  assert.equal(second.prio.reason, '');

  // 第 6 分钟：恢复期结束，回到常态（两个都放行、不再写限速恢复日志）。
  const third = tick(6);
  assert.equal(third.loop.allowed, true);
  assert.equal(third.prio.allowed, true);
  assert.equal(third.loop.mode, 'rate-unknown');
  assert.equal(third.prio.mode, 'rate-unknown');
});

test('#247 SC8 恢复期不集中补扫：同一拍同一消费方只放一次', () => {
  const state = stateWith(0, { reset: String(Math.floor(NOW / 1000) - 30) });
  const first = decideTick({ component: 'loop', purpose: 'board', state, now: NOW, tickId: 'same-tick' });
  const second = decideTick({ component: 'loop', purpose: 'board', state: first.state, now: NOW, tickId: 'same-tick' });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'recovery-turn');
});

test('#247 SC5 预算配置：缺项、非正整数都报可诊断错误，不按默认猜', () => {
  assert.deepEqual(readBudgets({ loop: 500, 'prio-run': 300, 'board-live': 140 }), {
    loop: 500,
    'prio-run': 300,
    'board-live': 140,
  });
  assert.throws(() => readBudgets(null), /缺少额度预算配置/);
  assert.throws(() => readBudgets({ loop: 500, 'prio-run': 300 }), /额度预算缺少「board-live」/);
  for (const bad of [0, -1, 1.5, '500', null]) {
    assert.throws(() => readBudgets({ loop: bad, 'prio-run': 300, 'board-live': 140 }), /期望正整数/);
  }
  const file = path.join(tmpDir(), 'rate-budget.json');
  assert.throws(() => readBudgetFile(file), /读不到额度预算配置/);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ rateBudget: { loop: 500, 'prio-run': 300, 'board-live': 140 } }));
  assert.equal(readBudgetFile(file).loop, 500);
  // 文件在、但 JSON 非法（复审 rev-258 的测试缺口）：照旧报可诊断错误，不静默当成「没配预算」。
  fs.writeFileSync(file, '{ "rateBudget": { "loop": 500, ');
  assert.throws(() => readBudgetFile(file), /额度预算配置不是合法 JSON/);
});

test('#247 SC5 预算闸只约束非必要读：essential（主循环 poll）越预算也放行', () => {
  const budgets = { loop: 500, 'prio-run': 300, 'board-live': 140 };
  let state = stateWith(4000);
  state = chargeBudget(state, { component: 'loop', cost: 498, now: NOW });
  // 复审 rev-258 的 P1：`used` 只增不减、整点才切窗，拦 essential 会把这小时剩下的 poll/abort/派发一起停掉。
  const essential = decideTick({
    component: 'loop',
    purpose: 'essential',
    state,
    now: NOW,
    budgets,
    tickId: 't1',
    reserve: 6,
  });
  assert.equal(essential.allowed, true, 'essential 越预算也照跑');
  assert.equal(essential.mode, 'normal');
  assert.equal(essential.log, null, '放行就不写 rate-skip 日志');
  // 同一份状态、同一拍：非必要读照旧被预算闸拦住。
  const optional = decideTick({
    component: 'loop',
    purpose: 'non-essential',
    state,
    now: NOW,
    budgets,
    tickId: 't1',
    reserve: 6,
  });
  assert.equal(optional.allowed, false, '非必要读照样受预算闸约束');
  assert.equal(optional.mode, 'over-budget');
  assert.match(optional.log, /action=over-budget budget=500 used=498 cost=6/);
});

test('#247 SC5 某组件超预算只让它自己跳过这一拍，别的组件照常跑', () => {
  const budgets = { loop: 500, 'prio-run': 300, 'board-live': 140 };
  let state = stateWith(4000);
  state = chargeBudget(state, { component: 'loop', cost: 498, now: NOW });
  const loop = decideTick({ component: 'loop', purpose: 'non-essential', state, now: NOW, budgets, cost: 6 });
  assert.equal(loop.allowed, false);
  assert.equal(loop.mode, 'over-budget');
  assert.match(loop.log, /action=over-budget/);
  assert.match(loop.log, /budget=500 used=498 cost=6/);
  // 同一时刻别的组件不受影响。
  const prio = decideTick({ component: 'prio-run', purpose: 'board', state, now: NOW, budgets, cost: 8 });
  assert.equal(prio.allowed, true);
  const boardLive = decideTick({
    component: 'board-live',
    purpose: 'non-essential',
    state,
    now: NOW,
    budgets,
    cost: 1,
  });
  assert.equal(boardLive.allowed, true);
});

test('#247 SC5 预算按小时切窗：上一小时的用量不算这一小时', () => {
  const budgets = { loop: 500, 'prio-run': 300, 'board-live': 140 };
  let state = stateWith(4000);
  state = chargeBudget(state, { component: 'loop', cost: 999, now: NOW - 2 * 60 * 60 * 1000 });
  const decided = decideTick({ component: 'loop', purpose: 'essential', state, now: NOW, budgets, cost: 6 });
  assert.equal(decided.allowed, true);
});

test('#247 SC9 两枚令牌分开记账、互不覆盖；只有一枚有记录时另一枚写 rate-unknown', () => {
  let state = recordHeader(emptyRateState(), {
    identity: IDENTITY_USER,
    remaining: '438',
    reset: RESET_IN_10_MIN,
    at: NOW,
  });
  state = recordHeader(state, { identity: IDENTITY_APP, remaining: '4990', reset: RESET_IN_10_MIN, at: NOW + 1000 });
  assert.equal(identityRecord(state, IDENTITY_USER).remaining, 438);
  assert.equal(identityRecord(state, IDENTITY_APP).remaining, 4990);
  assert.equal(identityRecord(state, IDENTITY_USER).identity, IDENTITY_USER);

  // 用户令牌只有 438（低于 800）：看板读要跳过。
  const user = decideTick({ component: 'prio-run', purpose: 'board', state, now: NOW, identity: IDENTITY_USER });
  assert.equal(user.allowed, false);
  assert.equal(user.identity, IDENTITY_USER);
  // App 安装令牌还有 4990：同一个判定入口不拿用户的数顶替。
  const app = decideTick({ component: 'board-live', purpose: 'non-essential', state, now: NOW });
  assert.equal(app.identity, IDENTITY_APP);
  assert.equal(app.allowed, true);

  // 缺 App 那枚记录：写 rate-unknown，不拿用户令牌的数顶替。
  const onlyUser = recordHeader(emptyRateState(), {
    identity: IDENTITY_USER,
    remaining: '4000',
    reset: RESET_IN_10_MIN,
    at: NOW,
  });
  const missingApp = decideTick({ component: 'board-live', purpose: 'non-essential', state: onlyUser, now: NOW });
  assert.equal(missingApp.identity, IDENTITY_APP);
  assert.equal(missingApp.mode, 'rate-unknown');
  assert.equal(missingApp.remaining, null, '不许回落到另一枚令牌的剩余');
  assert.match(missingApp.log, /rate-unknown .*identity=app/);

  // 状态文件写读一轮：两枚都留着。
  const file = rateStateFile(tmpDir());
  writeRateState(file, state);
  const back = readRateState(file);
  assert.equal(identityRecord(back, IDENTITY_USER).remaining, 438);
  assert.equal(identityRecord(back, IDENTITY_APP).remaining, 4990);
  assert.deepEqual(readRateState(path.join(path.dirname(file), 'nope.json')), emptyRateState());
});

test('#247 SC6 连续跳过记 streak：超过 N=5 时日志带上拍数，仍然只是跳过，且只在跨过阈值那一次提醒', () => {
  const state = stateWith(0);
  let current = state;
  let last = null;
  const escalations = [];
  for (let i = 0; i < MAX_CONSECUTIVE_SKIPS + 3; i += 1) {
    last = decideTick({ component: 'prio-run', purpose: 'board', state: current, now: NOW + i * 1000, tickId: `t${i}` });
    current = last.state;
    if (last.escalate) escalations.push(i);
  }
  assert.equal(last.allowed, false);
  assert.equal(last.skipStreak, MAX_CONSECUTIVE_SKIPS + 3, '连跳按拍数一直累加');
  assert.deepEqual(escalations, [MAX_CONSECUTIVE_SKIPS], '只有刚跨过阈值那一拍 escalate（#247 复审 P2-b）');
  assert.match(last.log, /streak=8/);
});

// 复审 rev-258 P2-b：同一拍里同一个 key 判两次（loop 的发现 + 卡住检查）只算一拍，提醒也只写一条。
test('#247 P2-b 连跳按拍去重：同一拍两个非必要闸只算一拍，提醒恰好一条', () => {
  const ticks = 2 * MAX_CONSECUTIVE_SKIPS + 3;
  let current = stateWith(4000, { reset: String(Math.floor(NOW / 1000) + 3300) }); // 剩余充足、窗口不重置：只让预算闸拦
  const budgets = { loop: 500, 'prio-run': 300, 'board-live': 140 };
  current = chargeBudget(current, { component: 'loop', cost: 500, now: NOW });
  const perTick = [];
  for (let i = 0; i < ticks; i += 1) {
    const tickId = `t${i}`;
    const at = NOW + i * TICK_SECONDS * 1000;
    const first = decideTick({ component: 'loop', purpose: 'non-essential', state: current, now: at, tickId, budgets, reserve: 6 });
    const second = decideTick({ component: 'loop', purpose: 'non-essential', state: first.state, now: at, tickId, budgets, reserve: 6 });
    current = second.state;
    perTick.push({ skipStreak: second.skipStreak, escalate: [first.escalate, second.escalate] });
  }
  const escalated = perTick.flatMap((entry, index) => entry.escalate.map((value, slot) => (value ? `${index}:${slot}` : null)).filter(Boolean));
  assert.deepEqual(escalated, [`${MAX_CONSECUTIVE_SKIPS}:0`], `跑 ${ticks} 拍（每拍两次判定）只该有 1 次提醒`);
  assert.equal(perTick.at(-1).skipStreak, ticks, '连跳数是拍数，不是判定次数');
  assert.equal(current.skips.byKey['loop:non-essential'].count, ticks, 'byKey 也按拍数记');
  assert.equal(current.skips.byKey['loop:non-essential'].escalated, true, '跨过阈值后记着已提醒过，不再重复');
});

test('#247 窗口相位：reset 还在前面是 normal，过了就是 recovery', () => {
  assert.equal(windowPhase({ state: stateWith(4000), now: NOW }).phase, 'normal');
  const passed = windowPhase({ state: stateWith(4000, { reset: RESET_ALREADY_PASSED }), now: NOW });
  assert.equal(passed.phase, 'recovery');
  assert.equal(passed.recovery.turn, 0);
  // 过了恢复期就回 normal。
  const state = recordHeader(emptyRateState(), {
    identity: IDENTITY_USER,
    remaining: '4000',
    reset: String(Math.floor((NOW - 10 * 60_000) / 1000)),
    at: NOW - 10 * 60_000,
  });
  assert.equal(windowPhase({ state, now: NOW }).phase, 'normal');
});

test('#247 SC2 看板快照：新鲜可直接用；缺失、过期、坏文件都报原因，不静默用旧数据', () => {
  const dir = tmpDir();
  const file = boardSnapshotFile(path.join(dir, 'state', 'host'));
  assert.equal(file.endsWith(path.join('state', 'host', 'board-snapshot.json')), true);
  assert.deepEqual(readBoardSnapshot(file, { now: NOW }), { ok: false, reason: 'missing', at: null, ageMs: null });

  writeBoardSnapshot(file, {
    at: NOW,
    items: [{ id: 'PVTI_1', repo: 'example-owner/example-repo', issue: 1 }],
    excludedCount: 2,
    nullContent: 1,
  });
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['at', 'excludedCount', 'items', 'nullContent', 'version']);
  assert.equal(stored.at, new Date(NOW).toISOString());

  const fresh = readBoardSnapshot(file, { now: NOW + 1000 });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.items.length, 1);
  assert.equal(fresh.excludedCount, 2);
  assert.equal(fresh.nullContent, 1);

  // 超过一个拍间隔就报过期：读者要么重拉并覆盖，要么报「快照过期」，不许静默用旧数据。
  const stale = readBoardSnapshot(file, { now: NOW + (TICK_SECONDS + 1) * 1000 });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.items.length, 1, '过期快照里有什么照实回报，由调用方决定重拉');

  fs.writeFileSync(file, '{坏');
  assert.equal(readBoardSnapshot(file, { now: NOW }).reason, 'corrupt');
});

test('#247 预算配置默认位置在 <home>/config/rate-budget.json', () => {
  const hostDir = path.join(tmpDir(), 'acceptance', 'state', 'host');
  assert.equal(budgetConfigFile(hostDir), path.join(path.dirname(path.dirname(hostDir)), 'config', 'rate-budget.json'));
  assert.equal(rateStateFile(hostDir), path.join(hostDir, 'rate-budget.json'));
});

test('#247 P3-3 预算 / 状态 / 快照路径与 host/paths.mjs 是同一组（不许两处各推一份）', () => {
  const home = path.join(tmpDir(), 'acceptance-home');
  const paths = hostPaths(home);
  assert.equal(paths.hostDir, path.join(home, 'state', 'host'));
  assert.equal(budgetConfigFile(paths.hostDir), paths.rateBudgetConfig, '预算配置要和主循环读的是同一个文件');
  assert.equal(rateStateFile(paths.hostDir), paths.rateState, '额度状态要和主循环写的是同一个文件');
  assert.equal(boardSnapshotFile(paths.hostDir), paths.boardSnapshot, '看板快照要和仓外读者读的是同一个文件');
});

test('#247 P2-5 快照「过期」判定不接受负年龄：时钟回拨后不许把旧快照当新鲜', () => {
  const file = boardSnapshotFile(path.join(tmpDir(), 'state', 'host'));
  writeBoardSnapshot(file, { at: NOW, items: [{ id: 'PVTI_1' }] });
  const back = readBoardSnapshot(file, { now: NOW - 60 * 60 * 1000 });
  assert.equal(back.ageMs, -3600000, '负年龄照实回报');
  assert.equal(back.ok, false, '墙钟往回跳一小时（负年龄）不许当新鲜');
  assert.equal(back.reason, 'clock-skew');
});

test('#247 P2-5 窗口相位：reset 比现在还晚一个窗口以上（时钟回拨）→ 旧窗口的剩余不能再用', () => {
  const reset = String(Math.floor((NOW + 2 * 60 * 60 * 1000) / 1000));
  const state = stateWith(4000, { reset });
  assert.equal(windowPhase({ state, now: NOW }).phase, 'clock-skew');
  const decided = decideTick({ component: 'prio-run', purpose: 'board', state, now: NOW });
  assert.equal(decided.mode, 'rate-unknown', '时钟对不上时不拿旧窗口的剩余下结论');
  assert.equal(decided.allowed, true, 'rate-unknown 的语义仍是「这一拍不跳过」');
  assert.match(decided.log, /reason=clock-skew/);
});

// #247 P3-1（复审 rev-247b）：连跳节数按「组件 + 用途」分开数，同一拍里 essential 放行不能把
// 非必要读的连跳清零——否则「整小时不推进」永远数不到 N，SC10 也观察不到。文档第 14 节这么写的。
test('#247 P3-1 同一拍里 essential 放行不清非必要读的连跳（skips.byKey 分开数）', () => {
  let current = stateWith(700); // 低于 800：essential 放行、非必要读暂停
  const steps = [];
  // 每步用一个新拍标识：连跳按「拍」数，同一拍重复判定不再累加（复审 rev-258 P2-b）。
  let tick = 0;
  for (const purpose of ['non-essential', 'essential', 'non-essential', 'non-essential']) {
    tick += 1;
    const decision = decideTick({ component: 'loop', purpose, state: current, now: NOW, tickId: `t${tick}` });
    current = decision.state;
    steps.push({ purpose, allowed: decision.allowed, skipStreak: decision.skipStreak });
  }
  assert.deepEqual(
    steps.map((step) => [step.purpose, step.allowed, step.skipStreak]),
    [
      ['non-essential', false, 1],
      ['essential', true, 0],
      ['non-essential', false, 2],
      ['non-essential', false, 3],
    ],
    '非必要读的连跳要接着数，不被中间放行的 essential 清零',
  );
  assert.equal(current.skips.byKey['loop:non-essential'].count, 3, 'byKey 记着非必要读的连跳');
  assert.equal(current.skips.byKey['loop:essential'].count, 0, 'essential 自己那一档是 0');

  // 另一个组件、同一拍：各算各的。
  const other = decideTick({ component: 'prio-run', purpose: 'non-essential', state: current, now: NOW, tickId: 't4' });
  assert.equal(other.skipStreak, 1, '别的组件第一次跳过是 1，不接着 loop 的连跳');
  assert.equal(other.state.skips.byKey['loop:non-essential'].count, 3, '动别人不清 loop 的连跳');
});

const BUDGETS = { loop: 500, 'prio-run': 300, 'board-live': 140 };

// #P1 poll 单独记账：先写这些边界再改实现（Inspector 定）。
test('poll 用量不再计入 loop 后，非必要读不再因 poll 用量被跳', () => {
  let state = stateWith(4000);
  state = chargeBudget(state, { component: POLL_COMPONENT, cost: 600, now: NOW });
  assert.equal(state.components.poll.used, 600);
  assert.equal(state.components.loop, undefined, 'poll 点数不出现在 loop.used');
  const decided = decideTick({
    component: 'loop',
    purpose: 'non-essential',
    state,
    now: NOW,
    budgets: BUDGETS,
    reserve: 6,
  });
  assert.equal(decided.allowed, true, '只有 poll 用量时非必要读仍放行');
  assert.notEqual(decided.reason, 'over-budget');
  // 对照：同样 600 点如果记在 loop 上，现有判定会跳过。
  const oldStyle = chargeBudget(stateWith(4000), { component: 'loop', cost: 600, now: NOW });
  const skipped = decideTick({
    component: 'loop',
    purpose: 'non-essential',
    state: oldStyle,
    now: NOW,
    budgets: BUDGETS,
    reserve: 6,
  });
  assert.equal(skipped.allowed, false);
  assert.equal(skipped.reason, 'over-budget');
});

test('非 poll 读刚好 500 不跳，再多就跳（used + cost + reserve > 500 才 over-budget）', () => {
  let atCap = chargeBudget(stateWith(4000), { component: 'loop', cost: 500, now: NOW });
  const exact = decideTick({
    component: 'loop',
    purpose: 'non-essential',
    state: atCap,
    now: NOW,
    budgets: BUDGETS,
    cost: 0,
    reserve: 0,
  });
  assert.equal(exact.allowed, true, 'loop.used 刚好 500 且本拍不再加点时不跳');
  const next = decideTick({
    component: 'loop',
    purpose: 'non-essential',
    state: atCap,
    now: NOW,
    budgets: BUDGETS,
    reserve: 6,
  });
  assert.equal(next.allowed, false, '已经 500，再预留一次非必要读（6 点）就跳');
  assert.equal(next.reason, 'over-budget');
  assert.match(next.log, /action=over-budget budget=500 used=500 cost=6/);
  // 494 + reserve 6 = 500：等于预算，不跳。
  const under = decideTick({
    component: 'loop',
    purpose: 'non-essential',
    state: chargeBudget(stateWith(4000), { component: 'loop', cost: 494, now: NOW }),
    now: NOW,
    budgets: BUDGETS,
    reserve: 6,
  });
  assert.equal(under.allowed, true, '494 + 6 = 500，按现有 > 才跳的口径放行');
});

test('账号余量暂停线行为不变：恰好 800/1500 不触发，低于才触发；poll 用量不影响这两档', () => {
  assert.equal(PAUSE_REMAINING, 800);
  assert.equal(BOARD_SKIP_REMAINING, 1500);
  const withPoll = (remaining) => chargeBudget(stateWith(remaining), { component: POLL_COMPONENT, cost: 600, now: NOW });
  const at800 = decideTick({ component: 'loop', purpose: 'non-essential', state: withPoll(800), now: NOW, budgets: BUDGETS, reserve: 6 });
  assert.equal(at800.allowed, true);
  assert.notEqual(at800.reason, 'remaining-below-800');
  const below800 = decideTick({ component: 'loop', purpose: 'non-essential', state: withPoll(799), now: NOW, budgets: BUDGETS, reserve: 6 });
  assert.equal(below800.allowed, false);
  assert.equal(below800.reason, 'remaining-below-800');
  const at1500 = decideTick({ component: 'prio-run', purpose: 'board', state: withPoll(1500), now: NOW, budgets: BUDGETS });
  assert.equal(at1500.allowed, true);
  assert.notEqual(at1500.reason, 'remaining-below-1500');
  const below1500 = decideTick({ component: 'prio-run', purpose: 'board', state: withPoll(1499), now: NOW, budgets: BUDGETS });
  assert.equal(below1500.allowed, false);
  assert.equal(below1500.reason, 'remaining-below-1500');
});

test('只有 poll 在读时 poll 项有数值；doctor 用的 pollUsage 能读出；并写出 component=poll 的日志行', () => {
  let state = chargeBudget(stateWith(4000), { component: POLL_COMPONENT, cost: 42, now: NOW });
  const usage = pollUsage(state, NOW);
  assert.equal(usage.present, true);
  assert.equal(usage.used, 42);
  assert.equal(usage.log, null);
  const line = pollUsageLogLine({ now: NOW, used: usage.used, cost: 42, hourKey: usage.hourKey });
  assert.match(line, /rate-poll component=poll used=42 cost=42/);
  assert.equal(state.components.loop, undefined);
  const decided = decideTick({ component: 'loop', purpose: 'non-essential', state, now: NOW, budgets: BUDGETS, reserve: 6 });
  assert.equal(decided.allowed, true);
});

test('老格式状态文件没有 poll 项：按 0 处理并记一行日志，不清空既有计数', () => {
  let state = chargeBudget(stateWith(4000), { component: 'loop', cost: 120, now: NOW });
  state = chargeBudget(state, { component: 'prio-run', cost: 8, now: NOW });
  assert.equal(state.components.poll, undefined);
  const file = rateStateFile(tmpDir());
  writeRateState(file, state);
  const back = readRateState(file);
  assert.equal(back.components.loop.used, 120, '既有 loop 计数还在');
  assert.equal(back.components['prio-run'].used, 8, '既有 prio-run 计数还在');
  const usage = pollUsage(back, NOW);
  assert.equal(usage.present, false);
  assert.equal(usage.used, 0);
  assert.match(usage.log, /rate-poll component=poll used=0/);
  assert.match(usage.log, /没有 poll 项，按 0 处理/);
});

test('prio-run / event-run 计费仍记 prio-run，不进 poll，也不改 loop', () => {
  let state = chargeBudget(stateWith(4000), { component: 'prio-run', cost: 8, now: NOW });
  assert.equal(state.components['prio-run'].used, 8);
  assert.equal(state.components.poll, undefined);
  assert.equal(state.components.loop, undefined);
  const decided = decideTick({
    component: 'prio-run',
    purpose: 'board',
    state,
    now: NOW,
    budgets: BUDGETS,
    reserve: 8,
  });
  assert.equal(decided.allowed, true, 'prio-run 预算 300，记 8 点后仍放行');
  // poll 用量不影响 prio-run 预算闸
  state = chargeBudget(state, { component: POLL_COMPONENT, cost: 600, now: NOW });
  const afterPoll = decideTick({
    component: 'prio-run',
    purpose: 'board',
    state,
    now: NOW,
    budgets: BUDGETS,
    reserve: 8,
  });
  assert.equal(afterPoll.allowed, true);
  assert.equal(afterPoll.state.components['prio-run'].used, 8);
});

test('文档 §14 写清 poll 单独记、不计入 loop 预算、在 doctor 和日志里看', () => {
  const docs = fs.readFileSync(new URL('../../docs/acceptance-operations.md', import.meta.url), 'utf8');
  const section = docs.slice(docs.indexOf('## 14.'), docs.indexOf('## 15.'));
  assert.match(section, /components\.poll/);
  assert.match(section, /不计入 loop/);
  assert.match(section, /doctor/);
  assert.match(section, /component=poll/);
});

