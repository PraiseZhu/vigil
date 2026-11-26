const DEFAULTS = { checkpointAfter: 3, swapAfterRedPushes: 2, stopAfter: 6 };

function checkKey(check) {
  return JSON.stringify([check.name, check.appId ?? null]);
}

const failed = (check) => check.required !== false && check.result === 'failed' && check.infra !== true;
const passed = (check) => check.required !== false && check.result === 'passed';

export function repairPushes(rounds, observations = {}) {
  return rounds.filter(({ type, before_classification }) => type === 'push' && before_classification === '要修')
    .map((push) => {
      const observation = observations[push.id];
      const before = push.before_required_checks;
      const after = observation?.checks ?? push.after_required_checks;
      const checks = after ?? [];
      const previouslyPassing = new Set((before ?? []).filter(passed).map(checkKey));
      const red = observation?.red === true || checks.some((check) => failed(check) && previouslyPassing.has(checkKey(check)));
      const incomplete = !before || !after || checks.some((check) => check.required !== false && check.result === 'running');
      return {
        id: push.id, at: push.at, head: push.after_head,
        enteredAt: observation?.enteredAt ?? null,
        red: red || (incomplete ? null : false),
        failedChecks: checks.filter(failed).map(checkKey),
        threads: observation?.threads ?? [],
      };
    });
}

export function recurred(previous, current) {
  return Boolean(previous && (current.threads.some((id) => previous.threads.includes(id))
    || current.failedChecks.some((name) => previous.failedChecks.includes(name))));
}

function settings(config = {}) {
  return Object.fromEntries(Object.entries(DEFAULTS).map(([name, fallback]) => {
    const value = config[name] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`无效的 guard.${name}`);
    return [name, value];
  }));
}

export function decideGuard({ rounds, pushes, orders = [], receipts = {}, state, config }) {
  if (state?.classification !== '要修' || state.halted) return null;
  const { checkpointAfter, swapAfterRedPushes, stopAfter } = settings(config);
  const resumeIndex = rounds.findLastIndex(({ type }) => type === 'resume');
  const resume = rounds[resumeIndex];
  const cycleIds = new Set(rounds.slice(resumeIndex + 1).map(({ id }) => id));
  const cycle = pushes.filter(({ id }) => cycleIds.has(id));
  const latest = cycle.at(-1);
  if (!latest || latest.head !== state.head) return null;

  const result = (type, reason) => ({ type, reason, pushId: latest.id, cycle: resume?.id ?? 'initial' });
  if (cycle.length >= stopAfter) return result('stop_and_notify', `已修复推送 ${cycle.length} 次，仍要修`);

  const swap = orders.find(({ type }) => type === 'swap');
  const swapAttempted = state.guard?.swapped === true || ['created', 'failed'].includes(receipts[swap?.id]?.result);
  const boundary = cycle.findIndex(({ id }) => id === swap?.payload?.push_id);
  const candidates = cycle.slice(boundary + 1);
  const reds = candidates.slice(-swapAfterRedPushes);
  if (recurred(candidates.at(-2), candidates.at(-1) ?? latest)
    || (reds.length === swapAfterRedPushes && reds.every(({ red }) => red))) {
    if (swapAttempted) return result('stop_and_notify', '尝试换人后仍复发或连续改红');
    if (!swap) return result('swap', '同一问题复发或连续改红');
  }
  if (cycle.length >= checkpointAfter && !orders.some(({ type }) => type === 'checkpoint')) {
    return result('checkpoint', `已修复推送 ${cycle.length} 次，先核对根因`);
  }
  return null;
}
