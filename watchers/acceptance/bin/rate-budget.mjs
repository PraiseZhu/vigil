#!/usr/bin/env node
// 额度预算与真实剩余两道闸（#247）。
//
// 两件事：
// 1. 预算：每个消费方（主循环、prio-run、看板读者）各有独立的小时预算，超了只有它自己跳过这一拍。
// 2. 真实剩余：只看最近一次只读 GraphQL 响应头 `x-ratelimit-remaining` 与 `x-ratelimit-reset`，
//    不看 `rate_limit` 表（实测能差出几千分）。剩余低就跳过看板读、再低就全面暂停非必要读。
//    过了 reset 时间按新窗口恢复，重置后有一段限速恢复期，避免重置瞬间集中补扫。
//
// 剩余额度按令牌身份分开记（用户令号令牌 / App 安装令牌各一份），互相不覆盖；缺哪一枚就写
// `rate-unknown`，不拿另一枚的数顶替。本文件不读任何凭据，只记响应头里的数字。
import fs from 'node:fs';
import path from 'node:path';

/** 消费方（预算、恢复期错开顺序都按这个名字排）。poll 不是消费方，不在这里。 */
export const COMPONENTS = Object.freeze(['loop', 'prio-run', 'board-live']);

/** 主循环每拍盘点的用量单独记在这一项，不计入 loop 的 500 点小时预算。 */
export const POLL_COMPONENT = 'poll';

/** 允许写入用量的名字：三个消费方，加上只记账、不参与预算判定的 poll。 */
const CHARGE_COMPONENTS = new Set([...COMPONENTS, POLL_COMPONENT]);

/** 一拍里的读用途：essential 只有主循环 poll；board 是看板整板读；non-essential 是其余只读。 */
export const PURPOSES = Object.freeze(['essential', 'board', 'non-essential']);

/** 令牌身份标记（SC9）：账号用户令牌与 App 安装令牌分开记账。 */
export const IDENTITY_USER = 'user';
export const IDENTITY_APP = 'app';
export const IDENTITIES = Object.freeze([IDENTITY_USER, IDENTITY_APP]);

/** 状态文件格式版本。 */
export const STATE_VERSION = 1;

/**
 * 剩余低于这个值就跳过本拍的看板读。严格小于：剩余恰好 1500 照读，1499 跳过。
 * 数值来自 #247 待定项（Inspector 定：1500 / 800 两档）。
 */
export const BOARD_SKIP_REMAINING = 1500;

/**
 * 剩余低于这个值就全面暂停非必要读，只保留主循环 poll（essential）。
 * 严格小于：剩余恰好 800 只跳过看板读，799 全面暂停。
 */
export const PAUSE_REMAINING = 800;

/** 窗口重置后的限速恢复期：重置后前 5 分钟（#247 SC8 的默认形态）。 */
export const RECOVERY_WINDOW_MS = 5 * 60 * 1000;

/** 恢复期内每拍最多几次非必要读（SC8）：1。 */
export const RECOVERY_READS_PER_TICK = 1;

/**
 * 恢复期的错开顺序：重置后每个拍只放一个消费方做非必要读，按这个顺序轮转，不集中补扫。
 * 顺序固定，测试可以直接断言某个拍该轮到谁。
 */
export const RECOVERY_ORDER = Object.freeze(['loop', 'prio-run', 'board-live']);

/** 连续「因额度跳过」的拍数上限（SC10 的 N=5）。超过就多记一行 streak，仍按跳过处理。 */
export const MAX_CONSECUTIVE_SKIPS = 5;

/** 一拍按 180 秒算（SC3 改后的主循环节奏），用来算快照新鲜度和恢复期拍号。 */
export const TICK_SECONDS = 180;

/** 只读 GraphQL 一次请求按 6 点记（实测口径：一页 3 组连接共 6 点）。只用于小时预算计数。 */
export const GRAPHQL_COST_PER_REQUEST = 6;

/** 一小时窗口（预算计数按 UTC 整点切）。 */
export const HOUR_MS = 60 * 60 * 1000;

function showActual(value) {
  if (value === undefined) return '（缺失）';
  if (value === null) return '（null）';
  if (typeof value === 'number') return String(value);
  return JSON.stringify(String(value));
}

function isoAt(ms) {
  return new Date(Number(ms)).toISOString();
}

function finiteMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : null;
}

/** 空状态：没有任何一枚令牌的记录、没有任何组件用量、没有恢复期。 */
export function emptyRateState() {
  return { version: STATE_VERSION, identities: {}, components: {}, recovery: null, skips: { count: 0, lastAt: null, byKey: {} } };
}

/** 从响应头原始值里读剩余额度。缺失、空、非数字一律算「未知」，不猜成 0。 */
export function parseRemaining(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (!/^\d+$/.test(text)) return { known: false, remaining: null, raw: text };
  return { known: true, remaining: Number(text), raw: text };
}

/** 从 `x-ratelimit-reset`（Unix 秒）读出窗口重置时间（毫秒）。缺失或不合法算未知。 */
export function parseReset(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (!/^\d+$/.test(text)) return { known: false, resetAt: null, raw: text };
  return { known: true, resetAt: Number(text) * 1000, raw: text };
}

/**
 * 记一次响应头。只改这一枚令牌格子的内容，另一枚原样保留（SC9）。
 * 头值不是数字也照记：`known: false` + 原始值，调用方据此写 rate-unknown。
 */
export function recordHeader(state, { identity, remaining, reset, at, source = 'graphql' } = {}) {
  if (!IDENTITIES.includes(identity)) throw new Error(`未知的令牌身份：${showActual(identity)}`);
  const when = finiteMs(at);
  if (when === null) throw new Error('recordHeader 需要合法的时间');
  const parseRemainingResult = parseRemaining(remaining);
  const parseResetResult = parseReset(reset);
  const base = state && typeof state === 'object' && !Array.isArray(state) ? state : emptyRateState();
  return {
    ...base,
    version: STATE_VERSION,
    identities: {
      ...(base.identities || {}),
      [identity]: {
        identity,
        known: parseRemainingResult.known,
        remaining: parseRemainingResult.remaining,
        remainingRaw: parseRemainingResult.raw,
        reset: parseResetResult.known ? isoAt(parseResetResult.resetAt) : null,
        resetRaw: parseResetResult.raw,
        at: isoAt(when),
        source,
      },
    },
  };
}

/** 读额度状态文件；没有、坏了、版本不认都当空状态（不拿旧数据当依据）。 */
export function readRateState(file) {
  if (!file) return emptyRateState();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyRateState();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== STATE_VERSION) {
    return emptyRateState();
  }
  return {
    version: STATE_VERSION,
    identities: parsed.identities && typeof parsed.identities === 'object' ? parsed.identities : {},
    components: parsed.components && typeof parsed.components === 'object' ? parsed.components : {},
    recovery: parsed.recovery && typeof parsed.recovery === 'object' ? parsed.recovery : null,
    skips: parsed.skips && typeof parsed.skips === 'object' ? parsed.skips : { count: 0, lastAt: null, byKey: {} },
  };
}

/** 原子写回额度状态文件。 */
export function writeRateState(file, state) {
  if (!file) throw new Error('writeRateState 需要文件路径');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** 某一枚令牌最近一次记录；没有返回 null（调用方写 rate-unknown，不拿另一枚顶替）。 */
export function identityRecord(state, identity) {
  if (!IDENTITIES.includes(identity)) throw new Error(`未知的令牌身份：${showActual(identity)}`);
  const record = state?.identities?.[identity];
  if (!record || typeof record !== 'object') return null;
  return record;
}

/** 组件默认看的令牌身份：主循环和 prio-run 用账号令牌，看板读者默认走 App 安装令牌。 */
export function defaultIdentity(component) {
  return component === 'board-live' ? IDENTITY_APP : IDENTITY_USER;
}

/**
 * 判定此刻是不是「窗口已重置」：取所有已知记录里最晚的 reset 时间。
 * - reset 还没到：normal（当前窗口还在）；
 * - reset 已过：recovery（进入或沿用这一轮恢复期），超过 RECOVERY_WINDOW_MS 后回 normal。
 * 只用本地状态文件里的响应头时间，不发任何探测请求。
 */
export function windowPhase({ state, now } = {}) {
  const at = finiteMs(now);
  if (at === null) throw new Error('windowPhase 需要合法的时间');
  const resets = IDENTITIES.map((identity) => finiteMs(state?.identities?.[identity]?.reset)).filter(
    (value) => value !== null,
  );
  if (resets.length === 0) return { phase: 'normal', recovery: null, resetAt: null };
  const resetAt = Math.max(...resets);
  // 时钟回拨（NTP 步进、快照恢复）会让旧窗口的 reset 跑到一个小时以后：GitHub 的窗口只有一小时，
  // 超过一个窗口就是「这台机器的钟和记下来的时间对不上」，旧窗口的剩余不能再用（P2-5）。
  if (resetAt - at > HOUR_MS) return { phase: 'clock-skew', recovery: null, resetAt: isoAt(resetAt) };
  if (resetAt > at) return { phase: 'normal', recovery: null, resetAt: isoAt(resetAt) };
  const previous = state?.recovery;
  const sameWindow = previous && finiteMs(previous.resetAt) === resetAt;
  // 恢复期从窗口重置那一刻算起（不是从第一次看到它算起）：这样才能在很久之后才跑的一拍上
  // 直接判「恢复期已过」，不用先白等 5 分钟。
  const recovery = sameWindow
    ? previous
    : { resetAt: isoAt(resetAt), startedAt: isoAt(resetAt), turn: 0, lastTick: null };
  const elapsed = at - finiteMs(recovery.startedAt);
  return {
    phase: elapsed < RECOVERY_WINDOW_MS ? 'recovery' : 'normal',
    recovery: elapsed < RECOVERY_WINDOW_MS ? recovery : null,
    resetAt: isoAt(resetAt),
  };
}

/**
 * 校验一份预算配置：三个组件都要有值，每个值必须是正整数。
 * 缺项、非整数、非正数都报可诊断错误，不按默认值猜（SC5）。
 */
export function readBudgets(source) {
  if (source == null) throw new Error('缺少额度预算配置（rateBudget），不按默认值猜');
  if (typeof source !== 'object' || Array.isArray(source)) {
    throw new Error(`额度预算配置期望对象，实际：${showActual(source)}`);
  }
  const out = {};
  for (const component of COMPONENTS) {
    const value = source[component];
    if (!Object.hasOwn(source, component) || value === undefined) {
      throw new Error(`额度预算缺少「${component}」，不按默认值猜`);
    }
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`额度预算「${component}」期望正整数，实际：${showActual(value)}`);
    }
    out[component] = value;
  }
  return out;
}

/** 从配置文件读预算：文件里可以是 `{rateBudget: {...}}` 或直接三段。 */
export function readBudgetFile(file) {
  if (!file) throw new Error('readBudgetFile 需要文件路径');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`读不到额度预算配置 ${path.basename(file)}`);
    throw new Error(`额度预算配置不是合法 JSON：${error.message}`);
  }
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.rateBudget !== undefined
    ? parsed.rateBudget
    : parsed;
  return readBudgets(source);
}

function componentUsage(state, component, hourKey) {
  const usage = state?.components?.[component];
  if (!usage || typeof usage !== 'object') return { hourKey, used: 0 };
  if (Number(usage.hourKey) !== hourKey) return { hourKey, used: 0 };
  const used = Number(usage.used);
  return { hourKey, used: Number.isFinite(used) && used > 0 ? used : 0 };
}

/** 把一次读的实际花费记进这个组件的本小时用量（按 UTC 整点切窗）。判定前没有实际花费时用 0。 */
export function chargeBudget(state, { component, cost, now } = {}) {
  if (!CHARGE_COMPONENTS.has(component)) throw new Error(`未知的消费方：${showActual(component)}`);
  const at = finiteMs(now);
  if (at === null) throw new Error('chargeBudget 需要合法的时间');
  const amount = Number.isFinite(cost) && cost > 0 ? Number(cost) : 0;
  const hours = Math.floor(at / HOUR_MS);
  const usage = componentUsage(state, component, hours);
  if (amount === 0) return state;
  return {
    ...state,
    version: STATE_VERSION,
    components: { ...(state?.components || {}), [component]: { hourKey: hours, used: usage.used + amount, updatedAt: isoAt(at) } },
  };
}

/**
 * 读本小时 poll 用量。状态里没有 `components.poll`、或 hourKey 对不上这一小时，都按 0，
 * 并给出一行日志（老格式兼容：不清空既有计数）。
 */
export function pollUsage(state, now) {
  const at = finiteMs(now);
  if (at === null) throw new Error('pollUsage 需要合法的时间');
  const hourKey = Math.floor(at / HOUR_MS);
  const raw = state?.components?.[POLL_COMPONENT];
  const present = Boolean(raw && typeof raw === 'object' && Number(raw.hourKey) === hourKey);
  const used = present ? componentUsage(state, POLL_COMPONENT, hourKey).used : 0;
  const log = present
    ? null
    : `${isoAt(at)} rate-poll component=poll used=0 reason=missing 老格式状态没有 poll 项，按 0 处理`;
  return { hourKey, used, present, log };
}

/** 记一笔 poll 用量的运维日志行（不进 loop 预算）。 */
export function pollUsageLogLine({ now, used, cost, hourKey } = {}) {
  const at = finiteMs(now) ?? Date.now();
  const hours = hourKey == null ? Math.floor(at / HOUR_MS) : hourKey;
  return `${isoAt(at)} rate-poll component=poll used=${Number(used) || 0} cost=${Number(cost) || 0} hourKey=${hours} 本小时 poll 用量（不计入 loop 预算）`;
}

/**
 * 一拍一次的判定入口（SC5 / SC6 / SC7 / SC8）。
 *
 * 输入：
 * - component：消费方名字（COMPONENTS 之一）；
 * - purpose：这一读的用途（essential / board / non-essential）；
 * - state：readRateState() 的结果；
 * - now：毫秒时间；tickId：这一拍的标识（默认按 TICK_SECONDS 折算，同一拍传同一个值）；
 * - budgets：readBudgets() 的结果（null 表示没配预算，只走响应头闸）；
 * - cost：这次读要记多少点（0 表示不记用量，例如只是判定）；
 * - reserve：只在预算比较里预留的点数（这次读还没发生，不记账；用来在预算边界上提前止步）；
 * - identity：这枚读用的是哪一枚令牌（默认按组件取）。
 *
 * 返回：{ allowed, mode, reason, identity, remaining, raw, resetAt, skipStreak, escalate, state, log }。
 * `log` 是运维日志行（null 表示不用记）。判定只看响应头与本地状态，不看 `rate_limit` 表。
 */
export function decideTick({
  component,
  purpose = 'non-essential',
  state,
  now,
  tickId,
  budgets = null,
  cost = 0,
  reserve = 0,
  identity,
} = {}) {
  if (!COMPONENTS.includes(component)) throw new Error(`未知的消费方：${showActual(component)}`);
  if (!PURPOSES.includes(purpose)) throw new Error(`未知的读用途：${showActual(purpose)}`);
  const at = finiteMs(now);
  if (at === null) throw new Error('decideTick 需要合法的时间');
  const who = identity || defaultIdentity(component);
  if (!IDENTITIES.includes(who)) throw new Error(`未知的令牌身份：${showActual(identity)}`);
  const amount = Number.isFinite(cost) && cost > 0 ? Number(cost) : 0;
  // 只在预算比较时预留的点数（#247 P3-2）：这一读还没发生，不记账，但要算进「这一拍会不会超预算」。
  const reserved = Number.isFinite(reserve) && reserve > 0 ? Number(reserve) : 0;
  const tickKey = tickId === undefined || tickId === null ? String(Math.floor(at / (TICK_SECONDS * 1000))) : String(tickId);

  let next = {
    ...emptyRateState(),
    ...(state && typeof state === 'object' ? state : {}),
    identities: { ...(state?.identities || {}) },
    components: { ...(state?.components || {}) },
    skips: {
      count: Number(state?.skips?.count) > 0 ? Number(state.skips.count) : 0,
      lastAt: state?.skips?.lastAt ?? null,
      byKey: state?.skips?.byKey && typeof state.skips.byKey === 'object' ? state.skips.byKey : {},
    },
  };

  const hourKey = Math.floor(at / HOUR_MS);
  const usage = componentUsage(next, component, hourKey);
  // 连跳节数按「组件 + 用途」分开数（#247 P2-3）：同一拍里 essential 放行会把全局计数清零，
  // 那样非必要读的连续跳过永远数不到 1 以上，SC10 也就观察不到。
  const skipKey = `${component}:${purpose}`;
  const previousEntry = next.skips.byKey?.[skipKey];
  const previousSkip = Number(previousEntry?.count) > 0 ? Number(previousEntry.count) : 0;
  // 连跳数按「拍」数，不按「判定次数」数（#247 P2-b）：同一拍里同一个 key 可能判两次（loop 的修正轮发现
  // 与卡住检查共用 `loop:non-essential`），这一拍已经记过一次就不再累加，提醒也不会在同一拍写两条。
  const sameTick = previousEntry?.lastTick != null && String(previousEntry.lastTick) === tickKey;
  // 只有「刚跨过阈值」那一次提醒（#247 P2-b）：越过之后每一拍都还跳过，但提醒不重复写，
  // 恢复（allowed）或切窗后被清零才重新计。
  const alreadyEscalated = Boolean(previousEntry?.escalated);
  const result = (patch) => {
    const skipStreak = patch.allowed ? 0 : sameTick ? previousSkip : previousSkip + 1;
    const escalate = !patch.allowed && skipStreak > MAX_CONSECUTIVE_SKIPS && !alreadyEscalated;
    next.skips = {
      count: skipStreak,
      lastAt: isoAt(at),
      byKey: {
        ...next.skips.byKey,
        [skipKey]: {
          count: skipStreak,
          lastAt: isoAt(at),
          lastTick: patch.allowed ? null : tickKey,
          escalated: !patch.allowed && (alreadyEscalated || skipStreak > MAX_CONSECUTIVE_SKIPS),
          reason: patch.allowed ? '' : patch.reason || '',
        },
      },
    };
    if (patch.allowed && amount > 0) {
      next.components[component] = { hourKey, used: usage.used + amount, updatedAt: isoAt(at) };
    }
    const record = identityRecord(next, who);
    return {
      identity: who,
      remaining: record?.known ? record.remaining : null,
      raw: record?.remainingRaw ?? '',
      resetAt: record?.reset ?? null,
      skipStreak,
      escalate,
      state: next,
      scope: patch.scope || 'this-tick',
      ...patch,
    };
  };

  // 1. 预算闸：只影响这个组件自己，而且只约束非必要读（#247 P1 / 复审 rev-258）。
  //    essential（主循环 poll）直接放行：`used` 只增不减、UTC 整点才切窗，一旦越过预算，拦它就会把这一小时
  //    剩余的 poll 连同心跳之外的 abort / 派发一起停掉，而心跳仍是 ok:true。用量照记，超预算只影响非必要读。
  if (budgets && purpose !== 'essential') {
    const budget = budgets[component];
    if (!Number.isInteger(budget) || budget <= 0) {
      throw new Error(`额度预算「${component}」期望正整数，实际：${showActual(budget)}`);
    }
    if (usage.used + amount + reserved > budget) {
      const line = rateLogLine({
        kind: 'rate-skip',
        now: at,
        component,
        identity: who,
        remaining: identityRecord(next, who)?.remaining ?? null,
        action: 'over-budget',
        extra: `budget=${budget} used=${usage.used} cost=${amount + reserved}`,
      });
      return result({ allowed: false, mode: 'over-budget', reason: 'over-budget', log: line });
    }
  }

  // 2. 窗口 / 恢复期：reset 已过就不再沿用上一个窗口的暂停状态。
  const phase = windowPhase({ state: next, now: at });
  next.recovery = phase.recovery;
  const record = identityRecord(next, who);
  let log = null;
  let allowed = true;
  let mode = 'normal';
  let reason = '';

  if (!record) {
    // 这枚令牌还没有任何响应头：写 rate-unknown，不跳过、不暂停、也不拿另一枚的数顶替。
    mode = 'rate-unknown';
    reason = 'missing-header';
    log = rateLogLine({ kind: 'rate-unknown', now: at, component, identity: who, raw: '', extra: 'reason=no-record' });
  } else if (!record.known) {
    mode = 'rate-unknown';
    reason = 'unparsable-header';
    log = rateLogLine({ kind: 'rate-unknown', now: at, component, identity: who, raw: record.remainingRaw, extra: 'reason=not-a-number' });
  } else if (phase.phase === 'clock-skew') {
    // 时钟回拨：记下来的 reset 比现在还晚一个窗口以上，旧窗口的剩余不能拿来下结论（P2-5）。
    mode = 'rate-unknown';
    reason = 'clock-skew';
    log = rateLogLine({ kind: 'rate-unknown', now: at, component, identity: who, raw: record.remainingRaw, extra: 'reason=clock-skew' });
  } else if (phase.phase === 'recovery') {
    // 旧窗口的剩余已经不算数：进恢复期，按错开顺序放行非必要读。
    log = rateLogLine({
      kind: 'rate-recovery',
      now: at,
      component,
      identity: who,
      remaining: record.remaining,
      resetAt: phase.resetAt,
    });
  } else if (finiteMs(record.reset) !== null && finiteMs(record.reset) <= at) {
    // 窗口已经重置、恢复期也过了，但还没拿到新窗口的响应头：旧窗口的剩余不能再用。
    mode = 'rate-unknown';
    reason = 'window-reset';
    log = rateLogLine({
      kind: 'rate-unknown',
      now: at,
      component,
      identity: who,
      raw: record.remainingRaw,
      extra: 'reason=window-reset',
    });
  } else if (record.remaining < PAUSE_REMAINING) {
    // 剩余不到 800：非必要读一律停（含看板读），只有主循环 poll（essential）照跑。
    if (purpose === 'essential') {
      mode = 'normal';
    } else {
      mode = 'paused';
      allowed = false;
      reason = 'remaining-below-800';
    }
  } else if (record.remaining < BOARD_SKIP_REMAINING && purpose === 'board') {
    // 剩余不到 1500（但还有 800 以上）：只跳看板读，其余非必要读照跑。
    mode = 'board-skipped';
    allowed = false;
    reason = 'remaining-below-1500';
  }

  // 3. 恢复期闸：每拍最多放 RECOVERY_READS_PER_TICK 次非必要读，按 RECOVERY_ORDER 轮转。
  if (allowed && phase.phase === 'recovery' && purpose !== 'essential') {
    const order = RECOVERY_ORDER;
    const turn = Number(next.recovery?.turn) || 0;
    const current = order[turn % order.length];
    if (RECOVERY_READS_PER_TICK < 1 || current !== component || next.recovery?.lastTick === tickKey) {
      allowed = false;
      mode = 'paused';
      reason = 'recovery-turn';
    } else {
      next.recovery = { ...next.recovery, lastTick: tickKey, turn: (turn + 1) % order.length };
    }
  }

  if (!allowed && !log) {
    log = rateLogLine({
      kind: 'rate-skip',
      now: at,
      component,
      identity: who,
      remaining: record?.known ? record.remaining : null,
      action: reason,
    });
  }
  const streakAfter = sameTick ? previousSkip : previousSkip + 1;
  if (!allowed && streakAfter > MAX_CONSECUTIVE_SKIPS) {
    log = `${log ?? ''} streak=${streakAfter}`;
  }
  return result({ allowed, mode, reason, log });
}

/**
 * 运维日志行（一律带 UTC 时间、组件名、令牌身份、剩余，SC6/SC9）。
 * 缺头 / 头值不是数字写 `rate-unknown` 并带原始值；跳过写 `rate-skip` 且以「因额度跳过」结尾。
 */
export function rateLogLine({ kind, now, component, identity, remaining = null, raw = '', action = '', resetAt = null, extra = '' } = {}) {
  const tail = extra ? ` ${extra}` : '';
  const stamp = `${isoAt(finiteMs(now) ?? Date.now())}`;
  const who = `component=${component} identity=${identity}`;
  if (kind === 'rate-unknown') {
    return `${stamp} rate-unknown ${who} remaining=unknown raw=${raw ? raw : '（缺失）'}${tail} 响应头缺失或不合法，本拍不跳过`;
  }
  if (kind === 'rate-recovery') {
    return `${stamp} rate-recovery ${who} remaining=${remaining ?? 'unknown'} resetAt=${resetAt ?? 'unknown'}${tail} 重置后限速恢复：每拍最多 ${RECOVERY_READS_PER_TICK} 次非必要读`;
  }
  return `${stamp} rate-skip ${who} remaining=${remaining ?? 'unknown'} action=${action}${tail} 因额度跳过`;
}

/** 把一拍的判定结论写成一行日志（追加到指定文件；写不下去不抛错）。 */
export function appendRateLog(file, line) {
  if (!file || !line) return null;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    return null;
  }
  return line;
}

// ── 看板快照（SC2：每拍整板读一次，dry-run、写入和仓外读者共用这一份） ──

/** `<home>/state/host/board-snapshot.json`。 */
export function boardSnapshotFile(hostDir) {
  return path.join(hostDir, 'board-snapshot.json');
}

/** `<home>/state/host/rate-budget.json`（响应头剩余、组件用量、恢复期、连续跳过节数）。 */
export function rateStateFile(hostDir) {
  return path.join(hostDir, 'rate-budget.json');
}

/** `<home>/config/rate-budget.json`：预算配置（从 <home>/state/host 往上推两级）。 */
export function budgetConfigFile(hostDir) {
  return path.resolve(hostDir, '..', '..', 'config', 'rate-budget.json');
}

/**
 * `at` 是这一份快照的抓取时间。同名的 `items` 是已过滤好的看板条目，
 * `excludedCount` / `nullContent` 是这一拍过滤掉的条数（分档排除、content 为 null）。
 */
export function writeBoardSnapshot(file, { at, items = [], excludedCount = 0, nullContent = 0 } = {}) {
  const when = finiteMs(at);
  if (when === null) throw new Error('writeBoardSnapshot 需要合法的抓取时间');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = {
    version: STATE_VERSION,
    at: isoAt(when),
    items: Array.isArray(items) ? items : [],
    excludedCount: Number(excludedCount) || 0,
    nullContent: Number(nullContent) || 0,
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return payload;
}

/**
 * 读快照。读者只有两条路（SC2）：新鲜的直接用；过期或缺失就自己重拉一次并覆盖，
 * 或者报「快照过期」——不许静默用旧数据。这里只回答「能不能用」，不重拉。
 * 返回 { ok, reason, at, ageMs, items, excludedCount, nullContent }。
 */
export function readBoardSnapshot(file, { now, tickSeconds = TICK_SECONDS } = {}) {
  const at = finiteMs(now);
  if (at === null) throw new Error('readBoardSnapshot 需要合法的时间');
  const maxAgeMs = Math.max(1, Number(tickSeconds) || TICK_SECONDS) * 1000;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'corrupt', at: null, ageMs: null };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.items)) {
    return { ok: false, reason: 'corrupt', at: null, ageMs: null };
  }
  const snapshotAt = finiteMs(parsed.at);
  if (snapshotAt === null) return { ok: false, reason: 'corrupt', at: null, ageMs: null };
  const ageMs = at - snapshotAt;
  const base = {
    at: isoAt(snapshotAt),
    ageMs,
    items: parsed.items,
    excludedCount: Number(parsed.excludedCount) || 0,
    nullContent: Number(parsed.nullContent) || 0,
  };
  // 负年龄 = 墙钟往回跳（NTP 步进、快照恢复）：不能说它「还新」，否则旧快照会一直用到时钟追上（P2-5）。
  if (ageMs < 0) return { ok: false, reason: 'clock-skew', ...base };
  if (ageMs >= maxAgeMs) return { ok: false, reason: 'stale', ...base };
  return { ok: true, reason: '', ...base };
}
