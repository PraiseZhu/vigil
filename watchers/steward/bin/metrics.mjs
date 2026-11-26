import fs from 'node:fs';
import path from 'node:path';
import { repairPushes, recurred } from './guard-rules.mjs';
import { readOrders, readReceipt } from './outbox.mjs';

export function files(directory, pattern) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map(({ name }) => path.join(directory, name)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function parseFlags(args, allowed) {
  const flags = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const name = flag.startsWith('--') ? flag.slice(2) : '';
    const value = args[index + 1];
    if (!allowed.includes(name) || Object.hasOwn(flags, name) || !value || value.startsWith('--')) {
      throw new Error(`非法或缺值参数：${flag}`);
    }
    flags[name] = value;
  }
  return flags;
}

function epoch(value) {
  if (typeof value !== 'string') return NaN;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return NaN;
  const day = Date.parse(value.slice(0, 10));
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
  return Date.parse(value);
}

export function timeWindow(since, until) {
  const start = epoch(since);
  const end = until === undefined ? Infinity : epoch(until) + (until.length === 10 ? 86_400_000 : 1);
  if (!Number.isFinite(start) || !(end > start)) throw new Error('必须提供有效的 --since，且 --until 不能早于它');
  return (at) => {
    const time = epoch(at);
    return time >= start && time < end;
  };
}

export function minutesBetween(start, end) {
  const duration = (epoch(end) - epoch(start)) / 60_000;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function distribution(samples, ranks, includeMax = false) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    ...Object.fromEntries(ranks.map((rank) => [`p${rank}`, sorted[Math.ceil(rank * sorted.length / 100) - 1] ?? null])),
    ...(includeMax ? { max: sorted.at(-1) ?? null } : {}),
  };
}

function counts(values) {
  const totals = new Map();
  for (const value of values) totals.set(value, (totals.get(value) ?? 0) + 1);
  return Object.fromEntries(totals);
}

export function calculateMetrics({ rounds, records = [], orders = [], receipts = {} }, { since, until, repo }) {
  const inWindow = timeWindow(since, until);
  const matches = (pr) => !repo || pr.split('#')[0] === repo.toLowerCase();
  const logs = Map.groupBy(rounds.filter(({ pr }) => matches(pr)), ({ pr }) => pr);
  const observed = new Map(records.map((record) => [record.pr, record]));
  const durations = [];
  let total = 0;
  let repeated = 0;
  let red = 0;
  let unknownRed = 0;
  let recurrences = 0;
  for (const [pr, log] of logs) {
    const pushes = repairPushes(log, observed.get(pr)?.observations);
    const windowPushes = pushes.filter(({ at }) => inWindow(at));
    total += windowPushes.length;
    repeated += Math.max(windowPushes.length - 1, 0);
    for (const [index, push] of pushes.entries()) {
      if (!inWindow(push.at)) continue;
      if (push.red) red += 1;
      if (push.red === null) unknownRed += 1;
      if (recurred(pushes[index - 1], push)) recurrences += 1;
      const duration = minutesBetween(push.enteredAt, push.at);
      if (duration !== null) durations.push(duration);
    }
  }

  const allOrders = new Map([...records.flatMap(({ issued }) => issued ?? []), ...orders].map((order) => [order.id, order]));
  const repoOrders = [...allOrders.values()].filter(({ pr }) => matches(pr));
  const windowOrders = repoOrders.filter(({ created_at }) => inWindow(created_at));
  const successful = (type) => repoOrders.filter(({ id, type: orderType }) => orderType === type
    && receipts[id]?.result === 'created' && inWindow(receipts[id].at)).length;
  const exposure = [];
  let unknownExposure = 0;
  for (const order of repoOrders.filter(({ type }) => type === 'pause_original')) {
    const receipt = receipts[order.id];
    if (!inWindow(receipt?.at) && !inWindow(order.created_at)) continue;
    const duration = receipt?.result === 'delivered' ? minutesBetween(order.created_at, receipt.at) : null;
    if (duration === null) unknownExposure += 1;
    else exposure.push(duration);
  }

  return {
    M1: { ...distribution(durations, [50, 75, 90]), unknown: total - durations.length },
    M2: total ? repeated / total : null,
    M3: total > unknownRed ? red / (total - unknownRed) : null,
    M3Unknown: unknownRed,
    M4: recurrences,
    M5: {
      chores: counts(rounds.filter(({ type, pr, at }) => type === 'chore' && matches(pr) && inWindow(at))
        .map(({ chore_type }) => chore_type)),
      orders: counts(windowOrders.map(({ type }) => type)),
      takeovers: successful('takeover'),
      swaps: successful('swap'),
      stops: windowOrders.filter(({ type }) => type === 'stop_and_notify').length,
    },
    M6: { ...distribution(exposure, [50], true), unknown: unknownExposure },
  };
}

export function readMetrics(directory) {
  const rounds = files(path.join(directory, 'rounds'), /^[a-f0-9]{64}\.jsonl$/).flatMap((file) => {
    const contents = fs.readFileSync(file, 'utf8');
    if (contents && !contents.endsWith('\n')) throw new Error('incomplete round log');
    return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  });
  const records = files(path.join(directory, 'guard'), /^[a-f0-9]{64}\.json$/)
    .map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
  const orders = readOrders(directory);
  return { rounds, records, orders, receipts: Object.fromEntries(orders.map(({ id }) => [id, readReceipt(directory, id)])) };
}
