import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decideCoverage } from './bin/coverage-rules.mjs';
import { coverage } from './bin/stages/coverage.mjs';
import { readFollower, writeFollower } from './bin/followers.mjs';
import { makeOrder, readOrders, readReceipt, writeOrder } from './bin/outbox.mjs';
import { applyAck } from './bin/steward-ack.mjs';
import { lookupOwner } from './bin/steward-owner.mjs';
import { readPr, writePr } from './bin/state.mjs';

const PR = 'example-org/example-repo#7';
const HEAD = 'a'.repeat(40);
const BASE = new Date('2026-11-26T00:00:00.000Z');

function fact(overrides = {}) {
  return { pr: PR, repo: 'example-org/example-repo', number: 7, head: HEAD,
    classification: '要修', reasons: [{ code: 'required_check_failed' }], threads: [], ...overrides };
}

function state(enteredAt = BASE.toISOString(), overrides = {}) {
  return { halted: false, head: HEAD, coverage: { active: true, head: HEAD, entered_at: enteredAt }, ...overrides };
}

function follower(overrides = {}) {
  return { pr: PR, device: 'ExampleDevice', session: 'example-session', kind: 'original', takeover: false,
    status: 'following', followed_at: BASE.toISOString(), last_activity_at: BASE.toISOString(), ...overrides };
}

function order(fields) {
  const created = makeOrder({ pr: PR, head: HEAD, reason: fields.type, ...fields,
    payload: { dedupeKey: fields.dedupeKey, ...(fields.payload ?? {}) } });
  return { ...created, ...fields, payload: { dedupeKey: fields.dedupeKey, ...(fields.payload ?? {}) } };
}

test('SC1: ensure_follower is emitted once for an unowned PR', () => {
  const first = decideCoverage({ fact: fact(), state: state(), now: BASE });
  assert.deepEqual(first.map(({ type }) => type), ['ensure_follower']);
  const existing = order(first[0]);
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), orders: [existing], now: BASE }), []);
});

test('SC2: stall threshold ignores a new follower reply', () => {
  const atFour = new Date(BASE.getTime() + 4 * 60_000);
  const atFive = new Date(BASE.getTime() + 5 * 60_000);
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), follower: follower(), now: atFour }), []);
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), follower: follower(), now: atFive })
    .map(({ type }) => type), ['check_follower']);
  const replied = fact({ threads: [{ comments: [{ author: { login: 'ExampleSession' }, createdAt: atFive.toISOString() }] }] });
  assert.deepEqual(decideCoverage({ fact: replied, state: state(), follower: follower({ login: 'examplesession' }), now: atFive }), []);
});

test('SC3: offline takeover starts at 15 minutes and online recovery cancels it', () => {
  const offline = follower({ status: 'offline', offline_at: BASE.toISOString() });
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), follower: offline,
    now: new Date(BASE.getTime() + 14 * 60_000) }), []);
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), follower: offline,
    now: new Date(BASE.getTime() + 15 * 60_000) }).map(({ type }) => type), ['takeover']);
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), follower: follower({ status: 'online', online_at: BASE.toISOString() }),
    now: new Date(BASE.getTime() + 20 * 60_000) }), []);
});

test('SC5 and SC6: online escalation and delivery retries are time based', () => {
  const online = follower({ status: 'online', online_at: BASE.toISOString() });
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), follower: online,
    now: new Date(BASE.getTime() + 30 * 60_000) }).map(({ type }) => type), ['nudge']);
  const nudge = order({ type: 'nudge', dedupeKey: 'online:nudge' });
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), follower: online, orders: [nudge],
    now: new Date(BASE.getTime() + 60 * 60_000) }).map(({ type }) => type), ['notify_human']);

  const initial = order({ type: 'check_follower', dedupeKey: 'stall', created_at: BASE.toISOString(),
    delivered: true, attempts: 1, payload: { dedupeKey: 'stall', retryStartedAt: BASE.toISOString() } });
  const retry = decideCoverage({ fact: fact(), state: state(), follower: online, orders: [initial],
    now: new Date(BASE.getTime() + 10 * 60_000) });
  assert.deepEqual(retry.map(({ type, payload }) => [type, payload.attempt]), [['check_follower', 2]]);
});

test('SC7 and SC8: stage clears closed work and skips halted PRs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-coverage-'));
  const profile = { stateDir: directory };
  const now = () => BASE;
  try {
    writePr(directory, PR, { ...state(), classification: '要修' });
    writeFollower(directory, PR, follower());
    const pending = order({ type: 'check_follower', dedupeKey: 'stall' });
    writeOrder(directory, pending);
    await coverage({ profile, facts: [fact({ classification: '不管', reasons: [{ code: 'closed' }] })], now, log: () => {} });
    assert.equal(readFollower(directory, PR), null);
    assert.deepEqual(readOrders(directory), []);
    writePr(directory, PR, { ...state(), classification: '要修', halted: true });
    await coverage({ profile, facts: [fact()], now, log: () => {} });
    assert.deepEqual(readOrders(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SC4, SC10 and SC11: takeover receipt updates ownership and invalid receipts are inert', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-ack-'));
  try {
    writePr(directory, PR, { ...state(), classification: '要修' });
    writeFollower(directory, PR, follower());
    const takeover = order({ type: 'takeover', dedupeKey: 'takeover' });
    writeOrder(directory, takeover);
    await assert.rejects(applyAck({ stateDir: directory, orderId: takeover.id, result: 'created', now: BASE }), /必须同时/);
    assert.equal(readReceipt(directory, takeover.id), null);
    await applyAck({ stateDir: directory, orderId: takeover.id, result: 'created', device: 'ResidentDevice', session: 'dedicated-session', now: BASE });
    assert.deepEqual(readFollower(directory, PR), {
      ...follower(), kind: 'dedicated', takeover: true, device: 'ResidentDevice', session: 'dedicated-session',
      status: 'following', takeover_at: BASE.toISOString(), original: { device: 'ExampleDevice', session: 'example-session' }, original_paused_at: null,
    });
    const owner = lookupOwner({ stateDir: directory, pr: PR });
    assert.deepEqual(owner, { managed: true, state: '要修', follower: {
      device: 'ResidentDevice', session: 'dedicated-session', kind: 'dedicated', takeover: true,
    }, pending_orders: 0 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SC4 and SC9: restored original presence creates one pause order and blockers dedupe by head', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-pause-'));
  try {
    writePr(directory, PR, { ...state(), classification: '要修' });
    writeFollower(directory, PR, follower({
      kind: 'dedicated', takeover: true,
      original: { device: 'OriginalDevice', session: 'original-session' },
    }));
    const profile = { stateDir: directory, presence: { commands: { OriginalDevice: 'exit 0' } } };
    const blocked = fact({ falseGreen: { failed: [{ name: 'unit' }], skipped: [{ name: 'lint' }] },
      alerts: [{ number: 4, severity: 'high' }] });
    await coverage({ profile, facts: [blocked], now: () => BASE, log: () => {} });
    const first = readOrders(directory);
    assert.deepEqual(first.map(({ type }) => type).sort(), ['forward_blocker', 'forward_blocker', 'pause_original']);
    await coverage({ profile, facts: [blocked], now: () => BASE, log: () => {} });
    assert.equal(readOrders(directory).length, first.length);
    const pause = first.find(({ type }) => type === 'pause_original');
    await applyAck({ stateDir: directory, orderId: pause.id, result: 'delivered', now: BASE });
    assert.equal(readFollower(directory, PR).original_paused_at, BASE.toISOString());
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
