import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readFollower, writeFollower } from './bin/followers.mjs';
import { makeOrder, readOrders, readReceipt, writeOrder } from './bin/outbox.mjs';
import { loadProfile } from './bin/profile.mjs';
import { coverage } from './bin/stages/coverage.mjs';
import { applyAck } from './bin/steward-ack.mjs';
import { lookupOwner } from './bin/steward-owner.mjs';
import { runSteward } from './bin/steward.mjs';
import { withPrLock, writePr } from './bin/state.mjs';

const REPO = 'example-org/example-repo';
const PR = `${REPO}#7`;
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const START = Date.parse('2026-11-26T00:00:00Z');
const at = (minute) => new Date(START + minute * 60_000);
const recorded = { head: HEAD, classification: '要修' };
const original = { device: 'ExampleDevice', session: 'example-session', kind: 'original', takeover: false };
const dedicated = { device: 'DedicatedDevice', session: 'dedicated-session', kind: 'dedicated', takeover: true };
const noNetwork = 'data:text/javascript,' + encodeURIComponent(`
  import childProcess from 'node:child_process';
  import net from 'node:net';
  import { syncBuiltinESMExports } from 'node:module';
  function unexpectedCall() {
    process.stderr.write('unexpected network or external command call');
    throw new Error('unexpected network or external command call');
  }
  globalThis.fetch = unexpectedCall;
  net.Socket.prototype.connect = unexpectedCall;
  for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    childProcess[method] = unexpectedCall;
  }
  syncBuiltinESMExports();
`);

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({
    authors: ['ExampleUser'], repos: [REPO], stateDir: 'state',
    policies: { [REPO]: { chores: { followerLogin: 'ExampleUser' } } },
    presence: { commands: { ExampleDevice: 'exit 0' } },
  }));
  const profile = loadProfile({ file });
  const stateDir = profile.stateDir;
  const log = [];
  const tick = (minute, ...facts) => coverage({ profile, facts, now: () => at(minute), log: (line) => log.push(line) });
  const cli = (command, ...args) => spawnSync(process.execPath, [
    ...(command === 'steward-owner' ? ['--import', noNetwork] : []),
    `watchers/steward/bin/${command}.mjs`, ...args,
  ], {
    env: { STEWARD_PROFILE: file },
    encoding: 'utf8', timeout: 5_000,
  });
  const orders = (type) => readOrders(stateDir).filter((item) => !type || item.type === type);
  const addOrder = (type) => writeOrder(stateDir, makeOrder({
    type, pr: PR, head: HEAD, reason: 'fixture', created_at: at(0).toISOString(),
  }));
  const ack = (order, result, minute, target = {}) => applyAck({
    stateDir, orderId: order.id, result, now: at(minute), ...target,
  });
  return { stateDir, profile, log, tick, cli, orders, addOrder, ack };
}

function fact(number = 7, overrides = {}) {
  return { ...recorded, pr: `${REPO}#${number}`, repo: REPO, number, ...overrides };
}

for (const type of ['check_follower', 'nudge']) {
  test(`rule 5: ${type} gone allows exactly one fresh ensure on the same head`, async (t) => {
    const { stateDir, tick, orders, addOrder, ack } = setup(t);
    await tick(0, fact());
    await ack(orders('ensure_follower')[0], 'following', 1, original);
    await ack(await addOrder(type), 'gone', 2);
    assert.equal(readFollower(stateDir, PR), null);
    await tick(3, fact());
    await tick(4, fact());
    const ensure = orders('ensure_follower');
    assert.equal(ensure.length, 2);
    assert.ok(ensure.every(({ head }) => head === HEAD));
    assert.equal(lookupOwner({ stateDir, pr: PR }).pending_orders, 1);
  });
}

for (const terminal of ['MERGED', 'CLOSED']) {
  test(`SC7: runSteward confirms ${terminal} before removing ownership and pending orders`, async (t) => {
    const { stateDir, profile, orders, addOrder } = setup(t);
    const unassigned = `${REPO}#8`;
    writePr(stateDir, unassigned, recorded);
    writePr(stateDir, PR, recorded);
    writeFollower(stateDir, PR, original);
    await addOrder('check_follower');
    const calls = [];
    let listFailed = true;
    let status;
    const client = {
      listOpenPulls: async () => {
        if (listFailed) throw new Error('discovery failed');
        return [];
      },
      getPull: async (repo, number) => {
        calls.push([repo, number]);
        if (listFailed) throw new Error('pull unavailable');
        return { number, state: status };
      },
    };
    const tick = () => runSteward({ command: 'tick', profile, client, now: () => at(0), log: () => {} });
    assert.equal((await tick()).discoveryErrors.length, 1);
    assert.equal(lookupOwner({ stateDir, pr: PR }).managed, true);
    listFailed = false;
    await tick();
    assert.equal(orders().length, 1);
    assert.ok(readFollower(stateDir, PR));
    status = terminal;
    await tick();
    assert.ok(calls.some(([repo, number]) => repo === REPO && number === 8));
    assert.deepEqual(orders(), []);
    assert.deepEqual(lookupOwner({ stateDir, pr: PR }),
      { managed: false, state: '不管', follower: null, pending_orders: 0 });
    assert.equal(lookupOwner({ stateDir, pr: unassigned }).managed, false);
  });
}

test('coverage reports a locked middle PR and still handles both neighbors', async (t) => {
  const { stateDir, tick, log, orders } = setup(t);
  await withPrLock(stateDir, `${REPO}#8`, () => tick(0, fact(), fact(8), fact(9)));
  assert.deepEqual(orders('ensure_follower').map(({ pr }) => pr).sort(), [PR, `${REPO}#9`]);
  assert.ok(log.some((line) => line.includes(`${REPO}#8`) && line.includes('state locked')));
});

test('SC2: a configured follower reply restarts the five-minute check timer', async (t) => {
  const { stateDir, tick, orders } = setup(t);
  writeFollower(stateDir, PR, original);
  await tick(0, fact());
  const reply = { author: { login: 'exampleuser' }, createdAt: at(4).toISOString() };
  await tick(5, fact(7, { threads: [{ comments: [reply] }] }));
  await tick(8, fact());
  assert.deepEqual(orders(), []);
  await tick(9, fact());
  assert.deepEqual(orders().map(({ type }) => type), ['check_follower']);
});

test('SC2: a new head restarts the five-minute check timer', async (t) => {
  const { stateDir, tick, orders } = setup(t);
  writeFollower(stateDir, PR, original);
  await tick(0, fact());
  await tick(4, fact(7, { head: NEXT }));
  await tick(8, fact(7, { head: NEXT }));
  assert.deepEqual(orders(), []);
  await tick(9, fact(7, { head: NEXT }));
  assert.deepEqual(orders().map(({ type, head }) => [type, head]), [['check_follower', NEXT]]);
});

for (const activity of ['push', 'reply']) {
  test(`SC5: ${activity} restarts online escalation at 30 and 60 minutes`, async (t) => {
    const { stateDir, tick, orders, ack } = setup(t);
    writeFollower(stateDir, PR, { ...original, status: 'online', online_at: at(0).toISOString() });
    await tick(0, fact());
    const head = activity === 'push' ? NEXT : HEAD;
    const reply = { author: { login: 'exampleuser' }, createdAt: at(25).toISOString() };
    await tick(25, fact(7, { head, threads: activity === 'reply' ? [{ comments: [reply] }] : [] }));
    await tick(30, fact(7, { head }));
    await tick(54, fact(7, { head }));
    assert.deepEqual(orders(), []);
    await tick(55, fact(7, { head }));
    assert.equal(orders('nudge').length, 1);
    await ack(orders('nudge')[0], 'delivered', 55);
    await tick(84, fact(7, { head }));
    assert.equal(orders('notify_human').length, 0);
    await tick(85, fact(7, { head }));
    assert.equal(orders('notify_human').length, 1);
  });
}

test('SC4: after takeover and recovery, renewed repair targets the dedicated session', async (t) => {
  const { stateDir, tick, orders, ack } = setup(t);
  writeFollower(stateDir, PR, original);
  await tick(0, fact());
  await tick(5, fact());
  await ack(orders('check_follower')[0], 'offline', 5);
  await tick(20, fact());
  await ack(orders('takeover')[0], 'created', 20, dedicated);
  await tick(21, fact());
  const pause = orders('pause_original');
  assert.equal(pause.length, 1);
  assert.equal(pause[0].payload.original.session, original.session);
  await ack(pause[0], 'delivered', 21);
  await tick(22, fact(7, { classification: '没事' }));
  await tick(23, fact());
  await tick(28, fact());
  await tick(29, fact());
  assert.equal(orders('pause_original').length, 1);
  const checks = orders('check_follower').filter((item) => !readReceipt(stateDir, item.id));
  assert.equal(checks.length, 1);
  assert.deepEqual(checks[0].payload.target, dedicated);
  assert.equal(Object.hasOwn(checks[0].payload, 'original'), false);
});

test('takeover created starts a fresh 15-minute clock for the next offline episode', async (t) => {
  const { stateDir, tick, orders, ack } = setup(t);
  writeFollower(stateDir, PR, { ...original, status: 'offline', offline_at: at(0).toISOString() });
  await tick(15, fact());
  await ack(orders('takeover')[0], 'created', 15, dedicated);
  assert.equal(readFollower(stateDir, PR).offline_at, null);
  await tick(20, fact());
  await ack(orders('check_follower')[0], 'offline', 20);
  assert.equal(readFollower(stateDir, PR).offline_at, at(20).toISOString());
  await tick(34, fact());
  assert.equal(orders('takeover').length, 1);
  await tick(35, fact());
  assert.equal(orders('takeover').length, 2);
});

test('SC10: ack CLI rejects unknown, incomplete, and incompatible results without mutating state', async (t) => {
  const { stateDir, addOrder, cli } = setup(t);
  writeFollower(stateDir, PR, original);
  const before = readFollower(stateDir, PR);
  const ensure = await addOrder('ensure_follower');
  const check = await addOrder('check_follower');
  const cases = [
    [ensure, ['--result', 'unsupported'], /unsupported receipt/],
    [ensure, ['--result', 'following', '--device', original.device], /--session/],
    [check, ['--result', 'created', '--device', dedicated.device, '--session', dedicated.session], /unsupported receipt/],
  ];
  for (const [order, args, message] of cases) {
    const result = cli('steward-ack', '--order', order.id, ...args);
    assert.equal(result.error, undefined);
    assert.equal(typeof result.status, 'number');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
    assert.equal(readReceipt(stateDir, order.id), null);
    assert.deepEqual(readFollower(stateDir, PR), before);
  }
});

test('SC11: owner CLI distinguishes assigned, unassigned, and unmanaged PRs without network calls', async (t) => {
  const { stateDir, addOrder, cli } = setup(t);
  writePr(stateDir, PR, recorded);
  writePr(stateDir, `${REPO}#8`, recorded);
  writeFollower(stateDir, PR, original);
  await addOrder('check_follower');
  for (const [pr, expected] of [
    [PR, { managed: true, state: '要修', follower: original, pending_orders: 1 }],
    [`${REPO}#8`, { managed: true, state: '要修', follower: null, pending_orders: 0 }],
    [`${REPO}#9`, { managed: false, state: '不管', follower: null, pending_orders: 0 }],
  ]) {
    const result = cli('steward-owner', '--pr', pr);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), expected);
  }
});
