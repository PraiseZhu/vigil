// 看板优先级打分（#153，规则以 #62 为准）。纯函数：事实、当前时间和防抖状态都由调用方传入。
// 不联网、不读环境变量、不读写看板。返回 write 只表示「调用方可以写」；本模块自己不写。
//
// 情形档 situationTier（P0–P3）由调用方按四条语义给出。再按 repoClass 换算：
// mivo 用情形档；daily-tool 低半档（P0 不变，P1 记成 P2，P2 和 P3 不变）；
// idle 的情形档 P0 保持 P0（已确认：线上坏了、数据或安全问题不因项目闲置降档）。
// 情形档 P1 及以下才在 daily-tool 的结果上再低一档，最低 P3。
// 机器信号 S1–S5 只能升档。最终档是换算结果和信号档里更高的那个，信号不能把档降下来。
// 没给情形档、也没有信号时，低置信记 P2。
// 只有 issueState === 'closed' 才清空。Done 或验收通过但 issue 仍开着时，保留算出来的档。
// 标签 prio:pin 原样返回当前优先级。
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
  Object.freeze({ id: 'S1', priority: 'P0', when: '心跳超时、host 冻结、写闸报错，或带 blocker 标签。只升档' }),
  Object.freeze({ id: 'S2', priority: 'P0', when: '验收中，且进度超过 30 分钟没更新，或本轮超过上限。只升档' }),
  Object.freeze({ id: 'S3', priority: 'P1', when: '关联 PR 的 CI 失败或被要求修改，或要修超过 4 小时没开 PR。只升档' }),
  Object.freeze({ id: 'S4', priority: 'P1', when: 'In Progress，且最近一次事件超过 24 小时。只升档' }),
  Object.freeze({ id: 'S5', priority: 'P2', when: '验收为修正中或验收中。只升档' }),
  Object.freeze({ id: 'fallback', priority: 'P2', when: '没给情形档，也没有机器信号，低置信' }),
  Object.freeze({ id: 'clear', priority: null, when: 'issue 已关闭才清空' }),
]);

const RANK = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3],
]);

// daily-tool 比 mivo 低半档：P0 保持，P1 记成 P2，P2 和 P3 不变。
const DAILY_TOOL = Object.freeze({ P0: 'P0', P1: 'P2', P2: 'P2', P3: 'P3' });
// 再低一档，最低 P3。idle 只对情形档 P1 及以下使用，并且用在 daily-tool 的结果上。
const STEP_DOWN = Object.freeze({ P0: 'P1', P1: 'P2', P2: 'P3', P3: 'P3' });

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

function normalizeSituation(value) {
  if (value == null || value === '') return null;
  if (RANK.has(value)) return value;
  throw new Error(`非法情形档：${value}`);
}

function rank(priority) {
  return priority == null ? RANK.size : RANK.get(priority);
}

function moreUrgent(left, right) {
  return rank(left) < rank(right);
}

function olderThan(at, nowMs, limitMs) {
  return Number.isFinite(at) && Number.isFinite(nowMs) && nowMs - at > limitMs;
}

function adjustTier(situation, repoClass) {
  if (repoClass === 'daily-tool') return DAILY_TOOL[situation];
  if (repoClass === 'idle') {
    if (situation === 'P0') return 'P0';
    return STEP_DOWN[DAILY_TOOL[situation]];
  }
  return situation;
}

function describeRepo(situation, repoClass, adjusted) {
  if (repoClass === 'daily-tool') {
    return adjusted === situation ? `daily-tool 不降档，仍是 ${adjusted}` : `daily-tool 降半档为 ${adjusted}`;
  }
  if (repoClass === 'idle') {
    if (situation === 'P0') return 'idle 的 P0 保持 P0';
    const daily = DAILY_TOOL[situation];
    return adjusted === daily
      ? `idle 再低一档，最低仍是 ${adjusted}`
      : `idle 在每天在用的结果 ${daily} 上再低一档为 ${adjusted}`;
  }
  return '不按仓降档';
}

function signalOf(id) {
  return { id, priority: priorityOf(id) };
}

function highestSignal(item, labels, nowMs) {
  if (
    item.heartbeatTimeout === true ||
    item.hostFrozen === true ||
    item.writeGateError === true ||
    labels.includes(BLOCKER_LABEL)
  ) {
    return signalOf('S1');
  }
  const progressStale = olderThan(item.progressUpdatedAt, nowMs, PROGRESS_STALE_MS);
  if (item.acceptance === '验收中' && (progressStale || item.roundOverLimit === true)) return signalOf('S2');
  const waitingWithoutPr =
    item.acceptance === '要修' && item.hasPr !== true && olderThan(item.fixRequestedAt, nowMs, FIX_WITHOUT_PR_MS);
  if (item.prCiRed === true || item.prChangesRequested === true || waitingWithoutPr) return signalOf('S3');
  if (item.status === 'In Progress' && olderThan(item.lastEventAt, nowMs, IDLE_EVENT_MS)) return signalOf('S4');
  if (item.acceptance === '修正中' || item.acceptance === '验收中') return signalOf('S5');
  return null;
}

function result(priority, rule, { pinned = false, lowConfidence = false, basis }) {
  return { priority, rule, pinned, lowConfidence, basis };
}

/**
 * @param {object} facts 一条 item 的事实快照。情形档、仓类别和 issue 开关由调用方给出。
 * @param {number} nowMs 本次重算的毫秒时间，由调用方传入。
 * @returns {{ priority: 'P0'|'P1'|'P2'|'P3'|null, rule: string, pinned: boolean, lowConfidence: boolean, basis: string }}
 */
export function scorePriority(facts, nowMs) {
  const item = facts && typeof facts === 'object' ? facts : {};
  const labels = Array.isArray(item.labels) ? item.labels : [];
  if (labels.includes(PIN_LABEL)) {
    return result(normalizePriority(item.priority), 'pin', {
      pinned: true,
      basis: '标签 prio:pin，保持原值',
    });
  }
  if (item.issueState === 'closed') {
    return result(null, 'clear', { basis: 'issue 已关闭，清空优先级' });
  }

  const signal = highestSignal(item, labels, nowMs);
  const situation = normalizeSituation(item.situationTier);
  if (situation == null) {
    if (!signal) {
      const priority = priorityOf('fallback');
      return result(priority, 'fallback', {
        lowConfidence: true,
        basis: `没给情形档，也没有机器信号，低置信记 ${priority}`,
      });
    }
    return result(signal.priority, signal.id, {
      basis: `没给情形档，机器信号 ${signal.id} 升到 ${signal.priority}`,
    });
  }

  const adjusted = adjustTier(situation, item.repoClass);
  const raised = Boolean(signal) && moreUrgent(signal.priority, adjusted);
  const priority = raised ? signal.priority : adjusted;
  const repo = describeRepo(situation, item.repoClass, adjusted);
  const signalText = raised ? `机器信号 ${signal.id} 升到 ${signal.priority}` : '没有机器信号升档';
  return result(priority, raised ? signal.id : 'situation', {
    basis: `情形档 ${situation}，${repo}，${signalText}`,
  });
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
