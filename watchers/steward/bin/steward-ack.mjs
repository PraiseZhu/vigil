import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProfile } from './profile.mjs';
import { markDelivered, readOrder, readReceipt, writeReceipt } from './outbox.mjs';
import { clearFollower, readFollower, writeFollower } from './followers.mjs';
import { readPr, withPrLock, writePr } from './state.mjs';

const REQUIRED_SESSION_RESULTS = new Set(['following', 'started', 'created']);
const RESULTS = Object.freeze({
  ensure_follower: ['following', 'started', 'created', 'offline', 'failed'],
  check_follower: ['online', 'offline', 'gone'],
  takeover: ['created', 'online', 'failed'],
  pause_original: ['delivered', 'offline', 'failed'],
  nudge: ['delivered', 'gone', 'failed'],
  forward_blocker: ['delivered', 'gone', 'failed'],
  notify_human: ['delivered', 'failed'],
});

export function parseAckArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new Error(`非法参数: ${item}`);
    const key = item.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${key} 缺值`);
    if (Object.hasOwn(flags, key)) throw new Error(`参数重复: --${key}`);
    flags[key] = value;
    index += 1;
  }
  return flags;
}

function receiptFollower(order, flags, at) {
  const previous = readFollower(order.stateDir, order.pr);
  if (order.type === 'ensure_follower' && REQUIRED_SESSION_RESULTS.has(flags.result)) {
    return writeFollower(order.stateDir, order.pr, {
      ...(previous ?? {}), device: flags.device, session: flags.session,
      kind: flags.result === 'created' ? 'dedicated' : 'original', takeover: false,
      status: 'following', offline_at: null, followed_at: at, last_activity_at: at,
    });
  }
  if (order.type === 'ensure_follower' && flags.result === 'offline') {
    return writeFollower(order.stateDir, order.pr, {
      ...(previous ?? {}), device: previous?.device ?? null, session: previous?.session ?? null,
      kind: previous?.kind ?? 'original', takeover: previous?.takeover === true, status: 'offline',
      offline_at: previous?.offline_at ?? at,
    });
  }
  if (order.type === 'check_follower' && ['online', 'offline'].includes(flags.result) && previous) {
    return writeFollower(order.stateDir, order.pr, {
      ...previous, status: flags.result, online_at: flags.result === 'online' ? at : previous.online_at,
      offline_at: flags.result === 'offline' ? previous.offline_at ?? at : null,
      last_activity_at: flags.result === 'online' ? at : previous.last_activity_at,
    });
  }
  if (flags.result === 'gone') {
    const current = readPr(order.stateDir, order.pr);
    if (current) {
      writePr(order.stateDir, order.pr, {
        ...current, coverage: { ...current.coverage, lost_follower_order: order.id },
      });
    }
    clearFollower(order.stateDir, order.pr);
    return null;
  }
  if (order.type === 'takeover' && flags.result === 'created') {
    const original = previous?.original ?? previous;
    return writeFollower(order.stateDir, order.pr, {
      ...(previous ?? {}), device: flags.device, session: flags.session, kind: 'dedicated', takeover: true,
      status: 'following', offline_at: null, takeover_at: at, original: original ? {
        device: original.device ?? null, session: original.session ?? null,
      } : null,
      original_paused_at: previous?.original_paused_at ?? null,
    });
  }
  if (order.type === 'takeover' && flags.result === 'online' && previous) {
    return writeFollower(order.stateDir, order.pr, { ...previous, status: 'online', online_at: at, offline_at: null });
  }
  if (order.type === 'pause_original' && flags.result === 'delivered' && previous) {
    return writeFollower(order.stateDir, order.pr, { ...previous, original_paused_at: at });
  }
  return previous;
}

export async function applyAck({ stateDir, orderId, result, device, session, schedule, note, now = new Date() } = {}) {
  const order = readOrder(stateDir, orderId);
  if (!order) throw new Error('order not found');
  if (!RESULTS[order.type]?.includes(result)) throw new Error('unsupported receipt result for order');
  if (REQUIRED_SESSION_RESULTS.has(result) && (!device || !session)) {
    throw new Error(`${result} 必须同时传 --device 和 --session`);
  }
  const flags = { result, device, session };
  return withPrLock(stateDir, order.pr, async () => {
    const current = readOrder(stateDir, orderId);
    if (!current) throw new Error('order not found');
    const existing = readReceipt(stateDir, orderId);
    const receipt = await writeReceipt(stateDir, orderId, {
      result, device: device ?? null, session: session ?? null,
      schedule: schedule ?? null, note: note ?? null, at: now.toISOString(),
    });
    if (!existing) {
      if (!current.delivered) await markDelivered(stateDir, orderId);
      receiptFollower({ ...current, stateDir }, flags, now.toISOString());
    }
    return receipt;
  });
}

export async function runAckCli(argv, { env = process.env, output = console.log, log = console.error, now = new Date() } = {}) {
  try {
    const flags = parseAckArgs(argv);
    if (!flags.order || !flags.result) throw new Error('必须传 --order <id> 和 --result <result>');
    const profile = loadProfile({ env });
    const receipt = await applyAck({ stateDir: profile.stateDir, orderId: flags.order, result: flags.result,
      device: flags.device, session: flags.session, schedule: flags.schedule, note: flags.note, now });
    output(JSON.stringify(receipt));
    return 0;
  } catch (error) {
    log(`steward-ack: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await runAckCli(process.argv.slice(2));
}
