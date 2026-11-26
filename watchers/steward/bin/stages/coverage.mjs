import fs from 'node:fs';
import path from 'node:path';
import { decideCoverage, latestFollowerActivity } from '../coverage-rules.mjs';
import { clearFollower, readFollower, writeFollower } from '../followers.mjs';
import { probePresence } from '../presence.mjs';
import { makeOrder, readOrders, readReceipt, writeOrder } from '../outbox.mjs';
import { readPr, withPrLock, writePr } from '../state.mjs';

function closed(fact) {
  return fact.classification === '不管' && fact.reasons?.some((reason) => reason.code === 'closed');
}

function removePending(directory, pr) {
  for (const order of readOrders(directory).filter((item) => item.pr === pr && !readReceipt(directory, item.id))) {
    fs.rmSync(path.join(directory, 'outbox', 'orders', `${order.id}.json`), { force: true });
  }
}

async function handleFact({ profile, fact, dryRun, now }) {
  if (!fact?.pr || fact.classification === '未知') return;
  const directory = profile.stateDir;
  const state = readPr(directory, fact.pr) ?? { pr: fact.pr, head: fact.head, halted: false };
  if (fact.classification !== '要修') {
    if (!dryRun) {
      removePending(directory, fact.pr);
      if (closed(fact)) clearFollower(directory, fact.pr);
      writePr(directory, fact.pr, { ...state, coverage: { ...state.coverage, active: false } });
    }
    return;
  }

  const previousCoverage = state.coverage ?? {};
  const currentHead = fact.head ?? state.head;
  const enteredAt = previousCoverage.active === true && previousCoverage.head === currentHead
    ? previousCoverage.entered_at : now.toISOString();
  const nextState = { ...state, coverage: { active: true, head: currentHead, entered_at: enteredAt } };
  let follower = readFollower(directory, fact.pr);
  const activityAt = latestFollowerActivity(fact, follower);
  if (!dryRun && follower && activityAt && (!follower.last_activity_at || Date.parse(follower.last_activity_at) < activityAt)) {
    follower = writeFollower(directory, fact.pr, { ...follower, last_activity_at: new Date(activityAt).toISOString() });
  }
  if (!dryRun) writePr(directory, fact.pr, nextState);
  const orders = readOrders(directory);
  const receipts = new Set(orders.filter((order) => readReceipt(directory, order.id)).map((order) => order.id));
  const originalDevice = follower?.original?.device;
  const presenceAvailable = follower?.takeover === true && Boolean(originalDevice)
    && probePresence({ profile, device: originalDevice });
  const actions = decideCoverage({ fact, state: nextState, follower, orders, receipts, now, presenceAvailable });
  if (dryRun) return;
  for (const action of actions) {
    const order = makeOrder({ type: action.type, pr: fact.pr, head: currentHead,
      dedupeKey: action.dedupeKey, reason: action.reason, payload: {
        ...action.payload, dedupeKey: action.dedupeKey, target: follower ? {
          device: follower.device ?? null, session: follower.session ?? null,
          kind: follower.kind, takeover: follower.takeover === true,
        } : null,
      }, created_at: now.toISOString() });
    await writeOrder(directory, order);
  }
}

export async function coverage(context) {
  const { profile, facts, dryRun = false, log = console.error, now = () => new Date() } = context;
  for (const fact of facts ?? []) {
    if (!fact?.pr) continue;
    const work = () => handleFact({ profile, fact, dryRun, now: now() });
    if (dryRun) await work();
    else await withPrLock(profile.stateDir, fact.pr, work);
  }
  log(`覆盖：${dryRun ? '预览' : '已执行'}`);
}
