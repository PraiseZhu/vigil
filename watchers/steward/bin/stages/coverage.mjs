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

function knownPrs(directory) {
  const known = new Set(readOrders(directory)
    .filter((order) => !readReceipt(directory, order.id)).map((order) => order.pr));
  const directoryPath = path.join(directory, 'followers');
  let files = [];
  try { files = fs.readdirSync(directoryPath); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    try {
      const follower = JSON.parse(fs.readFileSync(path.join(directoryPath, file), 'utf8'));
      if (typeof follower?.pr === 'string') known.add(follower.pr);
    } catch {
      continue;
    }
  }
  return [...known];
}

function parsePr(pr) {
  const match = /^(.+)#([1-9]\d*)$/.exec(pr);
  return match ? { repo: match[1], number: Number(match[2]) } : null;
}

async function cleanupClosedMissing({ profile, client, facts, dryRun, now, log }) {
  if (dryRun || !client?.getPull) return;
  const seen = new Set((facts ?? []).map((fact) => fact?.pr).filter(Boolean));
  for (const pr of knownPrs(profile.stateDir).filter((item) => !seen.has(item))) {
    const identity = parsePr(pr);
    if (!identity) continue;
    try {
      const pull = await client.getPull(identity.repo, identity.number);
      if (!['CLOSED', 'MERGED'].includes(pull?.state)) continue;
      await withPrLock(profile.stateDir, pr, () => handleFact({ profile, fact: {
        pr, repo: identity.repo, number: identity.number, classification: '不管',
        reasons: [{ code: 'closed' }],
      }, dryRun, now }));
    } catch (error) {
      log(`覆盖：${pr} 关闭状态探测失败：${error.message}`);
    }
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
      if (closed(fact) || state.coverage?.active) {
        writePr(directory, fact.pr, { ...state, classification: fact.classification,
          coverage: { ...state.coverage, active: false } });
      }
    }
    return;
  }

  const previousCoverage = state.coverage ?? {};
  const currentHead = fact.head ?? state.head;
  const enteredAt = previousCoverage.active === true && previousCoverage.head === currentHead
    ? previousCoverage.entered_at : now.toISOString();
  const nextState = { ...state, coverage: {
    ...previousCoverage, active: true, head: currentHead, entered_at: enteredAt,
  } };
  let follower = readFollower(directory, fact.pr);
  const configuredLogin = profile.policies?.[fact.repo?.toLowerCase()]?.chores?.followerLogin;
  if (follower && !follower.login && typeof configuredLogin === 'string' && configuredLogin) {
    follower = { ...follower, login: configuredLogin };
  }
  const activityAt = latestFollowerActivity(fact, follower);
  if (!dryRun && follower && activityAt && (!follower.last_activity_at || Date.parse(follower.last_activity_at) < activityAt)) {
    follower = writeFollower(directory, fact.pr, { ...follower, last_activity_at: new Date(activityAt).toISOString() });
  }
  if (!dryRun) writePr(directory, fact.pr, nextState);
  const orders = readOrders(directory);
  const receipts = new Set(orders.filter((order) => readReceipt(directory, order.id)).map((order) => order.id));
  const originalDevice = follower?.original?.device;
  const presenceAvailable = !dryRun && !state.halted && follower?.takeover === true
    && !follower.original_paused_at && Boolean(originalDevice)
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
  const { profile, client, facts, dryRun = false, log = console.error, now = () => new Date() } = context;
  for (const fact of facts ?? []) {
    if (!fact?.pr) continue;
    const work = () => handleFact({ profile, fact, dryRun, now: now() });
    try {
      if (dryRun) await work();
      else await withPrLock(profile.stateDir, fact.pr, work);
    } catch (error) {
      log(`覆盖：${fact.pr} 处理失败：${error.message}`);
    }
  }
  try { await cleanupClosedMissing({ profile, client, facts, dryRun, now: now(), log }); }
  catch (error) { log(`覆盖：关闭 PR 清理失败：${error.message}`); }
  log(`覆盖：${dryRun ? '预览' : '已执行'}`);
}
