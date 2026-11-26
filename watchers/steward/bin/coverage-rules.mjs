const DEFAULTS = Object.freeze({
  stallMinutes: 5,
  offlineTakeoverMinutes: 15,
  nudgeMinutes: 30,
  notifyMinutes: 60,
  timeoutMinutes: 30,
  retryMinutes: 10,
  maxAttempts: 3,
});

const RETRYABLE = new Set([
  'ensure_follower', 'check_follower', 'takeover', 'pause_original',
  'nudge', 'forward_blocker',
]);

function timestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function minutesSince(value, now) {
  const start = timestamp(value);
  const end = timestamp(now);
  if (start === null || end === null || end < start) return 0;
  return (end - start) / 60_000;
}

function orderKey(order) {
  return order?.payload?.dedupeKey ?? null;
}

function hasOrder(orders, { pr, type, head, dedupeKey }) {
  return orders.some((order) => order.pr === pr && order.type === type && order.head === head
    && (dedupeKey === undefined || orderKey(order) === dedupeKey));
}

function hasEpisodeOrder(orders, { pr, type, head }, key, start) {
  return orders.some((order) => order.pr === pr && order.type === type && order.head === head
    && (orderKey(order) === `${key}:${start}`
      || (orderKey(order) === key && timestamp(order.created_at) >= start)));
}

function commentLogin(comment) {
  const login = comment?.author?.login ?? comment?.author?.user?.login ?? comment?.login;
  return typeof login === 'string' ? login.toLowerCase() : null;
}

function commentTime(comment) {
  return timestamp(comment?.createdAt ?? comment?.created_at ?? comment?.submittedAt ?? comment?.updatedAt);
}

export function latestFollowerActivity(fact, follower) {
  const login = follower?.login?.toLowerCase();
  if (!login) return timestamp(follower?.last_activity_at);
  let latest = timestamp(follower.last_activity_at);
  for (const thread of fact?.threads ?? []) {
    for (const comment of thread.comments ?? []) {
      if (commentLogin(comment) !== login) continue;
      const at = commentTime(comment);
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
  }
  return latest;
}

function sequence(order) {
  const attempt = order?.payload?.attempt;
  return Number.isSafeInteger(attempt) && attempt > 0 ? attempt : order?.attempts ?? 0;
}

function retryActions({ orders, receipts, pr, head, now, settings }) {
  const groups = new Map();
  const settled = new Set();
  for (const order of orders) {
    if (order.pr !== pr || order.head !== head || !RETRYABLE.has(order.type)) continue;
    const root = order.payload?.retryRoot ?? order.id;
    if (receipts.has(order.id)) settled.add(root);
    const current = groups.get(root);
    if (!current || sequence(order) > sequence(current) || Date.parse(order.created_at) > Date.parse(current.created_at)) {
      groups.set(root, order);
    }
  }
  const actions = [];
  for (const [root, order] of groups) {
    if (settled.has(root)) continue;
    const elapsed = minutesSince(order.payload?.retryStartedAt ?? order.created_at, now);
    const attempt = Math.max(1, sequence(order));
    if (elapsed >= settings.timeoutMinutes) {
      const dedupeKey = `notify:timeout:${root}`;
      if (!hasOrder(orders, { pr, type: 'notify_human', head, dedupeKey })) {
        actions.push({
          type: 'notify_human', dedupeKey,
          reason: `${order.type} 已满 ${settings.timeoutMinutes} 分钟仍无回执`,
          payload: { ...order.payload, retryRoot: root, attempt },
        });
      }
    } else if (attempt < settings.maxAttempts && elapsed >= attempt * settings.retryMinutes) {
      const nextAttempt = attempt + 1;
      const dedupeKey = `retry:${root}:${nextAttempt}`;
      if (!hasOrder(orders, { pr, type: order.type, head, dedupeKey })) {
        actions.push({
          type: order.type,
          dedupeKey,
          reason: `${order.type} ${settings.retryMinutes * attempt} 分钟未收到回执，重发第 ${nextAttempt} 次`,
          payload: { ...order.payload, retryRoot: root, attempt: nextAttempt,
            retryStartedAt: order.payload?.retryStartedAt ?? order.created_at },
        });
      }
    }
  }
  return actions;
}

function blockerActions(fact, pr, head, orders, follower) {
  if (!follower) return [];
  const blockers = [];
  if (fact.falseGreen) blockers.push({
    key: `false_green:${(fact.falseGreen.failed ?? []).map((item) => item.name).sort().join(',')}`,
    reason: '重跑后仍存在假绿灯',
    payload: { falseGreen: fact.falseGreen },
  });
  for (const alert of fact.alerts ?? []) blockers.push({
    key: `code_scanning_alert:${alert.number}`,
    reason: `代码扫描告警达到阈值：${alert.number}`,
    payload: { alert },
  });
  return blockers.filter(({ key }) => !hasOrder(orders, { pr, type: 'forward_blocker', head, dedupeKey: key }))
    .map(({ key, reason, payload }) => ({ type: 'forward_blocker', dedupeKey: key, reason, payload }));
}

export function decideCoverage({
  fact, state = {}, follower = null, orders = [], receipts = new Set(), now = new Date(),
  settings: overrides = {}, presenceAvailable = false,
} = {}) {
  const settings = { ...DEFAULTS, ...overrides };
  const pr = fact?.pr;
  const head = (fact?.head ?? state?.head ?? '').toLowerCase();
  if (fact?.classification !== '要修' || state?.halted === true || !/^[a-f0-9]{40}$/.test(head)) return [];

  const actions = retryActions({ orders, receipts, pr, head, now, settings });
  const activityAt = latestFollowerActivity(fact, follower);
  const enteredAt = timestamp(state?.coverage?.entered_at ?? fact?.observed_at ?? now);

  if (!follower) {
    const dedupeKey = state.coverage?.lost_follower_order
      ? `ensure:after:${state.coverage.lost_follower_order}` : 'ensure';
    if (!hasOrder(orders, { pr, type: 'ensure_follower', head, dedupeKey })) {
      actions.push({ type: 'ensure_follower', dedupeKey, reason: '要修 PR 没有跟进方',
        payload: { pr: fact.pr, repo: fact.repo, number: fact.number, reasons: fact.reasons ?? [] } });
    }
    return actions;
  }

  const followerPayload = { follower: {
    device: follower.device ?? null, session: follower.session ?? null,
    kind: follower.kind, takeover: follower.takeover === true,
  } };
  const status = follower.status ?? 'following';
  const followCycle = Math.max(enteredAt ?? 0, timestamp(follower.takeover_at ?? follower.followed_at) ?? 0);
  const lastMovement = Math.max(followCycle, activityAt ?? 0);
  if (status === 'offline') {
    const offlineAt = timestamp(follower.offline_at ?? now);
    if (minutesSince(offlineAt, now) >= settings.offlineTakeoverMinutes
      && !hasEpisodeOrder(orders, { pr, type: 'takeover', head }, 'takeover', offlineAt)) {
      actions.push({ type: 'takeover', dedupeKey: `takeover:${offlineAt}`, reason: '跟进方离线已满 15 分钟',
        payload: { ...followerPayload, original: follower } });
    }
  } else if (status === 'online') {
    const idleSince = Math.max(lastMovement, timestamp(follower.online_at) ?? 0);
    if (minutesSince(idleSince, now) >= settings.notifyMinutes
      && !hasOrder(orders, { pr, type: 'notify_human', head })
      && !actions.some(({ type }) => type === 'notify_human')) {
      actions.push({ type: 'notify_human', dedupeKey: 'online:notify', reason: '跟进方在线但 60 分钟没有动静',
        payload: { ...followerPayload } });
    } else if (minutesSince(idleSince, now) >= settings.nudgeMinutes
      && !hasOrder(orders, { pr, type: 'nudge', head })
      && !actions.some(({ type }) => type === 'nudge')) {
      actions.push({ type: 'nudge', dedupeKey: 'online:nudge', reason: '跟进方在线但 30 分钟没有动静',
        payload: { ...followerPayload } });
    }
  } else if (minutesSince(lastMovement, now) >= settings.stallMinutes
    && !hasEpisodeOrder(orders, { pr, type: 'check_follower', head }, 'stall', followCycle)) {
    actions.push({ type: 'check_follower', dedupeKey: `stall:${followCycle}`, reason: '要修 PR 停滞已满 5 分钟',
      payload: { ...followerPayload } });
  }

  if (follower.takeover === true && follower.original && presenceAvailable
    && !follower.original_paused_at
    && !hasOrder(orders, { pr, type: 'pause_original', head, dedupeKey: 'pause:original' })) {
    actions.push({ type: 'pause_original', dedupeKey: 'pause:original', reason: '原电脑已恢复，暂停原跟进方',
      payload: { ...followerPayload, original: follower.original } });
  }
  actions.push(...blockerActions(fact, pr, head, orders, follower));
  return actions;
}

export const coverageRules = decideCoverage;
export { DEFAULTS as COVERAGE_DEFAULTS };
