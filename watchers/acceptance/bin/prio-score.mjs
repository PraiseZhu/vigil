// 看板优先级打分（#153）。纯函数：事实、当前时间和防抖状态都由调用方传入。
// 不联网、不读环境变量、不读写看板。返回 write 只表示「调用方可以写」；本模块自己不写。
//
// 未完成的 item 取命中的最高档（S1 高于 S6）。Done 或验收=通过则清空。
// 标签 prio:pin 时原样返回 facts.priority，不看其它信号。
//
// 防抖状态（上次重算时间 lastRecalcAt、连续次数 consecutive，以及 pending / changes）
// 由调用方保存并在下次传入。升级立刻生效。降级要同一目标连续出现至少 2 次，
// 且距离这条目标第一次出现不少于 15 分钟；中间更早的重算不把起始时间往后推。
// 值没变不记变更。滚动 1 小时内已经变更 4 次时，再变更返回 freeze 并 alert。

const MINUTE_MS = 60 * 1000;

export const PROGRESS_STALE_MS = 30 * MINUTE_MS;
export const FIX_WITHOUT_PR_MS = 4 * 60 * MINUTE_MS;
export const IDLE_EVENT_MS = 24 * 60 * MINUTE_MS;
export const DOWNGRADE_MIN_GAP_MS = 15 * MINUTE_MS;
export const CHANGE_WINDOW_MS = 60 * MINUTE_MS;
export const MAX_CHANGES_PER_HOUR = 4;

export const PIN_LABEL = 'prio:pin';
export const BLOCKER_LABEL = 'blocker';

export const RULES = Object.freeze([
  Object.freeze({ id: 'S1', priority: 'P0', when: '心跳超时、host 冻结、写闸报错，或带 blocker 标签' }),
  Object.freeze({ id: 'S2', priority: 'P0', when: '验收中，且进度超过 30 分钟没更新，或本轮超过上限' }),
  Object.freeze({ id: 'S3', priority: 'P1', when: '关联 PR 的 CI 失败或被要求修改，或要修超过 4 小时没开 PR' }),
  Object.freeze({ id: 'S4', priority: 'P1', when: 'In Progress，且最近一次事件超过 24 小时' }),
  Object.freeze({ id: 'S5', priority: 'P2', when: '验收为修正中或验收中' }),
  Object.freeze({ id: 'S6', priority: 'P3', when: '其它未完成项' }),
  Object.freeze({ id: 'clear', priority: null, when: 'Done 或验收通过' }),
]);

const RANK = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3],
]);

function priorityOf(id) {
  const found = RULES.find((rule) => rule.id === id);
  if (!found) throw new Error(`未知规则：${id}`);
  return found.priority;
}

function normalizePriority(value) {
  if (value == null) return null;
  if (RANK.has(value)) return value;
  throw new Error(`非法优先级：${value}`);
}

function rank(priority) {
  return priority == null ? RANK.size : RANK.get(priority);
}

function olderThan(at, nowMs, limitMs) {
  return Number.isFinite(at) && Number.isFinite(nowMs) && nowMs - at > limitMs;
}

/**
 * @param {object} facts 一条 item 的事实快照。进度时间、要修开始时间、最近事件时间缺了就不算「超过 N」。
 * @param {number} nowMs 本次重算的毫秒时间，由调用方传入。
 * @returns {{ priority: 'P0'|'P1'|'P2'|'P3'|null, rule: string, pinned: boolean }}
 */
export function scorePriority(facts, nowMs) {
  const item = facts && typeof facts === 'object' ? facts : {};
  const labels = Array.isArray(item.labels) ? item.labels : [];
  if (labels.includes(PIN_LABEL)) {
    return { priority: normalizePriority(item.priority), rule: 'pin', pinned: true };
  }
  const status = item.status ?? null;
  const acceptance = item.acceptance ?? null;
  if (status === 'Done' || acceptance === '通过') {
    return { priority: null, rule: 'clear', pinned: false };
  }

  const matched = [];
  if (
    item.heartbeatTimeout === true ||
    item.hostFrozen === true ||
    item.writeGateError === true ||
    labels.includes(BLOCKER_LABEL)
  ) {
    matched.push('S1');
  }
  const progressStale = olderThan(item.progressUpdatedAt, nowMs, PROGRESS_STALE_MS);
  if (acceptance === '验收中' && (progressStale || item.roundOverLimit === true)) matched.push('S2');
  const waitingWithoutPr =
    acceptance === '要修' && item.hasPr !== true && olderThan(item.fixRequestedAt, nowMs, FIX_WITHOUT_PR_MS);
  if (item.prCiRed === true || item.prChangesRequested === true || waitingWithoutPr) matched.push('S3');
  if (status === 'In Progress' && olderThan(item.lastEventAt, nowMs, IDLE_EVENT_MS)) matched.push('S4');
  if (acceptance === '修正中' || acceptance === '验收中') matched.push('S5');
  matched.push('S6');

  const rule = matched[0];
  return { priority: priorityOf(rule), rule, pinned: false };
}

function recentChanges(changes, nowMs) {
  if (!Array.isArray(changes)) return [];
  return changes.filter((at) => Number.isFinite(at) && at <= nowMs && nowMs - at < CHANGE_WINDOW_MS);
}

function emptyHold(priority, changes) {
  return {
    priority,
    pending: null,
    pendingHeld: false,
    lastRecalcAt: null,
    consecutive: 0,
    changes,
  };
}

/**
 * @param {object} state 调用方保存的防抖状态：priority、pending、pendingHeld、lastRecalcAt、consecutive、changes。
 * @param {{ priority: 'P0'|'P1'|'P2'|'P3'|null, rule: string, pinned: boolean }} scored scorePriority 的结果。
 * @param {number} nowMs 本次重算时间。
 * @returns {{ action: 'write'|'skip'|'freeze', priority: 'P0'|'P1'|'P2'|'P3'|null, rule: string, alert: boolean, next: object }}
 */
export function applyDebounce(state, scored, nowMs) {
  const current = normalizePriority(state?.priority);
  const changes = recentChanges(state?.changes, nowMs);
  const desired = normalizePriority(scored?.priority);
  const rule = scored?.rule ?? null;
  const pinned = scored?.pinned === true;

  if (pinned || desired === current) {
    return {
      action: 'skip',
      priority: pinned ? desired : current,
      rule,
      alert: false,
      next: emptyHold(pinned ? desired : current, changes),
    };
  }

  const upgrading = rank(desired) < rank(current);
  let downgrade = null;
  if (!upgrading) {
    const pendingHeld = state?.pendingHeld === true;
    const pending = pendingHeld ? normalizePriority(state.pending) : null;
    const since = Number.isFinite(state?.lastRecalcAt) ? state.lastRecalcAt : null;
    const seen = Number.isInteger(state?.consecutive) && state.consecutive > 0 ? state.consecutive : 0;
    const same = pendingHeld && pending === desired && since != null;
    downgrade = {
      priority: current,
      pending: desired,
      pendingHeld: true,
      lastRecalcAt: same ? since : nowMs,
      consecutive: same ? seen + 1 : 1,
      changes,
    };
    const gap = nowMs - downgrade.lastRecalcAt;
    const confirmed = same && downgrade.consecutive >= 2 && gap >= DOWNGRADE_MIN_GAP_MS;
    if (!confirmed) {
      return { action: 'skip', priority: current, rule, alert: false, next: downgrade };
    }
  }

  if (changes.length >= MAX_CHANGES_PER_HOUR) {
    return {
      action: 'freeze',
      priority: current,
      rule,
      alert: true,
      next: downgrade ?? emptyHold(current, changes),
    };
  }

  return {
    action: 'write',
    priority: desired,
    rule,
    alert: false,
    next: emptyHold(desired, [...changes, nowMs]),
  };
}
