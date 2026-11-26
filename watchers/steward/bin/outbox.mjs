import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, prKey, readJson, storageKey, withLock } from './state.mjs';

const RESULTS = Object.freeze({
  ensure_follower: ['following', 'started', 'created', 'offline', 'failed'],
  check_follower: ['online', 'offline', 'gone'],
  takeover: ['created', 'online', 'failed'],
  pause_original: ['delivered', 'offline', 'failed'],
  nudge: ['delivered', 'gone', 'failed'],
  forward_blocker: ['delivered', 'gone', 'failed'],
  checkpoint: ['delivered', 'gone', 'failed'],
  swap: ['created', 'failed'],
  stop_and_notify: ['delivered', 'failed'],
  notify_human: ['delivered', 'failed'],
});

export const ORDER_TYPES = Object.freeze(Object.keys(RESULTS));
const ID = /^[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{40}$/i;

function validateOrder(order) {
  if (!Object.hasOwn(RESULTS, order.type)) throw new Error(`unsupported order type: ${order.type}`);
  if (!ID.test(order.id) || !HEAD.test(order.head) || prKey(order.pr) !== order.pr
    || typeof order.reason !== 'string' || !Number.isFinite(Date.parse(order.created_at))
    || !Number.isSafeInteger(order.attempts) || order.attempts < 0
    || typeof order.delivered !== 'boolean' || !Object.hasOwn(order, 'payload')) throw new Error('invalid order');
  return order;
}

export function makeOrder({ type, pr, head, dedupeKey = '', reason, payload = {}, created_at = new Date().toISOString() }) {
  if (typeof dedupeKey !== 'string' || typeof head !== 'string') throw new Error('invalid order dedupe key or head');
  const canonicalPr = prKey(pr);
  const canonicalHead = head.toLowerCase();
  const id = storageKey(JSON.stringify([canonicalPr, canonicalHead, type, dedupeKey]));
  return validateOrder({ id, type, pr: canonicalPr, head: canonicalHead, reason, created_at, attempts: 0, delivered: false, payload });
}

function orderFile(directory, id, folder = 'orders') {
  if (!ID.test(id)) throw new Error('invalid order id');
  return path.join(directory, 'outbox', folder, `${id}.json`);
}

function locked(directory, id, callback) {
  return withLock(path.join(directory, 'outbox', 'locks'), id, callback);
}

export function readOrder(directory, id) {
  const order = readJson(orderFile(directory, id));
  return order === null ? null : validateOrder(order);
}

export function readOrders(directory) {
  let files;
  try {
    files = fs.readdirSync(path.join(directory, 'outbox', 'orders'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return files.filter((file) => /^[a-f0-9]{64}\.json$/.test(file)).sort()
    .map((file) => readOrder(directory, file.slice(0, -5))).filter(Boolean);
}

export function writeOrder(directory, order) {
  validateOrder(order);
  const file = orderFile(directory, order.id);
  return locked(directory, order.id, () => {
    const current = readOrder(directory, order.id);
    if (current) return current;
    const { id, type, pr, head, reason, created_at, attempts, delivered, payload } = order;
    const record = { id, type, pr, head, reason, created_at, attempts, delivered, payload };
    atomicJson(file, record);
    return record;
  });
}

export function markDelivered(directory, id) {
  return locked(directory, id, () => {
    const order = readOrder(directory, id);
    if (!order) throw new Error('order not found');
    if (readReceipt(directory, id)) return order;
    const updated = { ...order, attempts: order.attempts + 1, delivered: true };
    atomicJson(orderFile(directory, id), updated);
    return updated;
  });
}

export function readReceipt(directory, id) {
  return readJson(orderFile(directory, id, 'receipts'));
}

export function writeReceipt(directory, id, receipt) {
  return locked(directory, id, () => {
    const order = readOrder(directory, id);
    if (!order) throw new Error('order not found');
    if (!RESULTS[order.type].includes(receipt?.result)) throw new Error('unsupported receipt result for order');
    const existing = readReceipt(directory, id);
    if (existing) return existing;
    const record = { ...receipt, id };
    atomicJson(orderFile(directory, id, 'receipts'), record);
    return record;
  });
}
