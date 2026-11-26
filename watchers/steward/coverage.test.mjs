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
import { runSteward } from './bin/steward.mjs';
import { loadProfile } from './bin/profile.mjs';
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
  const payload = { ...fields.payload, dedupeKey: fields.dedupeKey };
  const created = makeOrder({ pr: PR, head: HEAD, reason: fields.type, ...fields, payload });
  return { ...created, ...fields, payload };
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
      status: 'following', offline_at: null, takeover_at: BASE.toISOString(), original: { device: 'ExampleDevice', session: 'example-session' }, original_paused_at: null,
    });
    const owner = lookupOwner({ stateDir: directory, pr: PR });
    assert.deepEqual(owner, { managed: true, state: '要修', follower: {
      device: 'ResidentDevice', session: 'dedicated-session', kind: 'dedicated', takeover: true,
    }, pending_orders: 0 });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('SC6: orders retry at minutes 10 and 20 and notify exactly once at 30', () => {
  const initial = order({ type: 'check_follower', dedupeKey: 'stall', created_at: BASE.toISOString(),
    delivered: true, attempts: 1, payload: { dedupeKey: 'stall', retryStartedAt: BASE.toISOString() } });
  const orders = [initial];
  const decideAt = (minute, receipts = new Set()) => decideCoverage({
    fact: fact(), state: state(), follower: follower(), orders, receipts,
    now: new Date(BASE.getTime() + minute * 60_000),
  });
  for (const minute of [10, 20]) {
    assert.deepEqual(decideAt(minute - 1), []);
    const actions = decideAt(minute);
    assert.deepEqual(actions.map(({ type, payload }) => [type, payload.attempt]), [['check_follower', minute / 10 + 1]]);
    orders.push(order({ ...actions[0], created_at: new Date(BASE.getTime() + minute * 60_000).toISOString() }));
  }
  assert.deepEqual(decideAt(29), []);
  assert.deepEqual(decideAt(30, new Set([orders[1].id])), []);
  const actions = decideAt(30);
  assert.deepEqual(actions.map(({ type }) => type), ['notify_human']);
  orders.push(order(actions[0]));
  assert.deepEqual(decideAt(40), []);
});

test('dedupe and retries ignore orders for another PR sharing the same head', () => {
  const other = makeOrder({ type: 'ensure_follower', pr: 'other-org/other-repo#7', head: HEAD,
    dedupeKey: 'ensure', reason: 'other', payload: { dedupeKey: 'ensure' }, created_at: BASE.toISOString() });
  assert.deepEqual(decideCoverage({ fact: fact(), state: state(), orders: [other],
    now: new Date(BASE.getTime() + 30 * 60_000) })
    .map(({ type }) => type), ['ensure_follower']);
});

test('gone acknowledgment reopens ensure on the same head', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-gone-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tick = () => coverage({ profile: { stateDir: directory }, facts: [fact()], now: () => BASE, log: () => {} });
  await tick();
  const [ensure] = readOrders(directory);
  await applyAck({ stateDir: directory, orderId: ensure.id, result: 'following',
    device: 'ExampleDevice', session: 'example-session', now: BASE });
  const check = order({ type: 'check_follower', dedupeKey: 'stall' });
  await writeOrder(directory, check);
  await applyAck({ stateDir: directory, orderId: check.id, result: 'gone', now: BASE });
  assert.equal(readFollower(directory, PR), null);
  await tick();
  await tick();
  assert.equal(readOrders(directory).filter(({ type }) => type === 'ensure_follower').length, 2);
  assert.equal(lookupOwner({ stateDir: directory, pr: PR }).pending_orders, 1);
});

test('ensure created records a dedicated follower and clears stale offline state', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-created-'));
  try {
    const ensure = order({ type: 'ensure_follower', dedupeKey: 'ensure' });
    await writeOrder(directory, ensure);
    writeFollower(directory, PR, follower({ status: 'offline', offline_at: BASE.toISOString() }));
    await applyAck({ stateDir: directory, orderId: ensure.id, result: 'created', device: 'DedicatedDevice', session: 'dedicated-session', now: BASE });
    assert.equal(readFollower(directory, PR).kind, 'dedicated');
    assert.equal(readFollower(directory, PR).offline_at, null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('closed PRs missing from open discovery are cleaned, and one bad PR does not stop another', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-closed-'));
  try {
    const otherPr = 'other-org/other-repo#8';
    writeFollower(directory, PR, follower());
    writePr(directory, PR, { ...state(), classification: '要修' });
    await writeOrder(directory, order({ type: 'check_follower', dedupeKey: 'stall' }));
    const profile = { stateDir: directory, repos: ['example-org/example-repo'], authors: ['ExampleUser'], excludeRepos: [] };
    const tick = (readPull) => runSteward({ command: 'tick', profile, client: {
      listOpenPulls: async () => [], getPull: readPull,
    }, now: () => BASE, log: () => {} });
    await tick(async () => { throw new Error('no GitHub response'); });
    assert.ok(readFollower(directory, PR));
    await tick(async () => ({ state: 'MERGED' }));
    assert.equal(readFollower(directory, PR), null);
    assert.deepEqual(readOrders(directory), []);
    await coverage({ profile: { stateDir: directory }, facts: [
      { pr: 'invalid', classification: '要修', head: HEAD }, fact({ pr: otherPr, repo: 'other-org/other-repo', number: 8 }),
    ], now: () => BASE, log: () => {} });
    assert.equal(readOrders(directory).some((item) => item.pr === otherPr), true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('profile loads and validates presence commands used by the coverage stage', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-profile-'));
  const file = path.join(directory, 'profile.json');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const config = { authors: ['ExampleUser'], repos: ['example-org/example-repo'], stateDir: 'state',
    presence: { commands: { ExampleDevice: 'exit 0' } }, github: { mode: 'gh' },
    policies: { 'example-org/example-repo': { chores: { followerLogin: 'ExampleUser' } } } };
  fs.writeFileSync(file, JSON.stringify(config));
  const profile = loadProfile({ file });
  writeFollower(profile.stateDir, PR, follower({ kind: 'dedicated', takeover: true,
    original: { device: 'ExampleDevice', session: 'example-session' } }));
  await coverage({ profile, facts: [fact()], now: () => BASE, log: () => {} });
  assert.deepEqual(readOrders(profile.stateDir).map(({ type }) => type), ['pause_original']);
  fs.writeFileSync(file, JSON.stringify({ ...config, presence: { commands: { ExampleDevice: false } } }));
  assert.throws(() => loadProfile({ file }), /presence\.commands/);
});

test('SC2: new commits reset stall and replies from the configured follower avert a check', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-activity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = { stateDir: directory,
    policies: { 'example-org/example-repo': { chores: { followerLogin: 'ExampleUser' } } } };
  const at = (minute) => new Date(BASE.getTime() + minute * 60_000);
  const tick = (minute, current) => coverage({ profile, facts: [current], now: () => at(minute), log: () => {} });
  writeFollower(directory, PR, follower());
  await tick(0, fact());
  const next = fact({ head: 'b'.repeat(40) });
  await tick(4, next);
  await tick(5, next);
  assert.deepEqual(readOrders(directory), []);
  const threads = [{ comments: [{ author: { login: 'exampleuser' }, createdAt: at(8).toISOString() }] }];
  await tick(9, { ...next, threads });
  assert.deepEqual(readOrders(directory), []);
  assert.equal(readFollower(directory, PR).last_activity_at, at(8).toISOString());
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
