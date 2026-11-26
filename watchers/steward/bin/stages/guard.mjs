import path from 'node:path';
import { decideGuard, repairPushes } from '../guard-rules.mjs';
import { readFollower } from '../followers.mjs';
import { makeOrder, readOrders, readReceipt, writeOrder } from '../outbox.mjs';
import { readRounds } from '../round-log.mjs';
import { atomicJson, prKey, readJson, readPr, storageKey, withPrLock, writePr } from '../state.mjs';

export function guardFile(directory, pr) {
  return path.join(directory, 'guard', `${storageKey(prKey(pr))}.json`);
}

function observe(previous, fact, state, rounds, at) {
  const observations = { ...previous?.observations };
  const push = rounds.findLast(({ type }) => type === 'push');
  if (push?.after_head === fact.head && push.before_classification === '要修') {
    const existing = observations[push.id];
    const view = {
      enteredAt: existing?.enteredAt ?? (previous?.head === push.before_head ? previous.enteredAt : null),
      checks: (fact.requiredChecks ?? []).map(({ name, appId, result, infra }) => ({ name, appId, result, infra })),
      threads: (fact.reasons ?? []).filter(({ code }) => code === 'review_thread').map(({ id }) => id),
      red: existing?.red === true,
    };
    view.red = repairPushes([push], { [push.id]: view })[0].red === true;
    observations[push.id] = view;
  }
  let enteredAt = null;
  if (fact.classification === '要修') {
    const covered = state.coverage?.active && state.coverage.head === fact.head ? state.coverage.entered_at : null;
    enteredAt = previous?.head === fact.head && previous.enteredAt ? previous.enteredAt : covered ?? at;
  }
  return { pr: fact.pr, head: fact.head, enteredAt, observations, issued: previous?.issued ?? [] };
}

async function applyGuard(profile, fact, at) {
  const directory = profile.stateDir;
  const state = readPr(directory, fact.pr);
  if (!state || state.head !== fact.head || state.classification !== fact.classification) return;
  const file = guardFile(directory, fact.pr);
  const previous = readJson(file);
  const rounds = readRounds(directory, fact.pr);
  const record = observe(previous, fact, state, rounds, at);
  if (JSON.stringify(record) !== JSON.stringify(previous)) atomicJson(file, record);
  if (state.halted || fact.classification !== '要修') return;
  const orders = readOrders(directory).filter(({ pr }) => pr === fact.pr);
  const receipts = Object.fromEntries(orders.map(({ id }) => [id, readReceipt(directory, id)]));
  const byId = new Map([...record.issued, ...orders].map((order) => [order.id, order]));
  const action = decideGuard({ rounds, pushes: repairPushes(rounds, record.observations),
    orders: [...byId.values()], receipts, state,
    config: profile.policies?.[fact.repo?.toLowerCase()]?.guard ?? profile.guard });
  if (!action) return;

  const follower = readFollower(directory, fact.pr);
  const order = makeOrder({
    type: action.type, pr: fact.pr, head: fact.head, reason: action.reason, created_at: at,
    dedupeKey: action.type === 'stop_and_notify' ? action.cycle : action.type,
    payload: { push_id: action.pushId, target: follower ? {
      device: follower.device ?? null, session: follower.session ?? null,
      kind: follower.kind, takeover: follower.takeover === true,
    } : null },
  });
  const written = await writeOrder(directory, order);
  if (!record.issued.some(({ id }) => id === written.id)) {
    const { id, type, created_at, payload } = written;
    record.issued.push({ id, type, pr: fact.pr, created_at, payload: { push_id: payload.push_id } });
    atomicJson(file, record);
  }
  if (action.type === 'stop_and_notify') writePr(directory, fact.pr, { ...state, halted: true });
}

export async function guard({ profile, facts, dryRun, log = console.error, now = () => new Date() }) {
  if (dryRun) {
    log(facts.some(({ classification }) => classification === '要修') ? '守门：预览' : '守门：未启用');
    return;
  }
  for (const fact of facts) {
    if (['未知', '不管'].includes(fact.classification)) continue;
    try {
      await withPrLock(profile.stateDir, fact.pr, () => applyGuard(profile, fact, now().toISOString()));
    } catch (error) {
      log(`守门：${fact.pr} 处理失败：${error.message}`);
    }
  }
}
