import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { makeOrder, markDelivered, ORDER_TYPES, readOrder, readOrders, readReceipt, writeOrder, writeReceipt } from './bin/outbox.mjs';
import { HEAD, REPO } from './fixtures/pulls.mjs';

test('SC8: identical dedupe identity is stable and unsupported types cannot enter the outbox', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-outbox-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fields = { type: 'ensure_follower', pr: `${REPO}#1`, head: HEAD, dedupeKey: 'example', reason: 'example' };
  const first = makeOrder(fields);
  const second = makeOrder({ ...fields, reason: 'different' });
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, makeOrder({ ...fields, dedupeKey: 'other' }).id);
  assert.equal(ORDER_TYPES.length, 10);
  assert.throws(() => writeOrder(directory, { ...first, type: 'not_an_order' }), /unsupported order type/);
  assert.deepEqual(readOrders(directory), []);
  await writeOrder(directory, first);
  await markDelivered(directory, first.id);
  await writeOrder(directory, second);
  assert.deepEqual(readOrders(directory), [{ ...first, delivered: true, attempts: 1 }]);
  await assert.rejects(writeReceipt(directory, first.id, { result: 'gone' }), /unsupported receipt/);
  assert.equal(readReceipt(directory, first.id), null);
  assert.deepEqual(await writeReceipt(directory, first.id, { result: 'following' }), { id: first.id, result: 'following' });
  await markDelivered(directory, first.id);
  assert.equal(readOrder(directory, first.id).attempts, 1);
});
