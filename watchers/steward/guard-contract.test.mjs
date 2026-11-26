import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readFollower, writeFollower } from './bin/followers.mjs';
import { makeOrder, readOrders, readReceipt, writeOrder } from './bin/outbox.mjs';
import { loadProfile } from './bin/profile.mjs';
import { readRounds } from './bin/round-log.mjs';
import { readPr, withPrLock, writePr } from './bin/state.mjs';
import { runSteward } from './bin/steward.mjs';
import { at, fixture, head, PR } from './fixtures/guard/cases.mjs';
import { check, fixtureClient, pull, thread } from './fixtures/pulls.mjs';

function cli(command, env, ...args) {
  return spawnSync(process.execPath, [`watchers/steward/bin/${command}.mjs`, ...args], {
    env, encoding: 'utf8', timeout: 5000,
  });
}

test('SC4: tick stops at six pushes and resume clears halted and appends exactly once', async (t) => {
  const { env, stateDir } = fixture(t);
  const profile = loadProfile({ env });
  const logs = [];
  const tick = (index) => runSteward({
    command: 'tick', profile, now: () => new Date(at(index)), log: (message) => logs.push(message),
    client: fixtureClient({ get: () => pull(1, { head: head(index), checks: [check(`job-${index}`, 'FAILURE')] }) }),
  });
  for (let index = 0; index <= 5; index += 1) await tick(index);
  assert.equal(readPr(stateDir, PR).halted, false);
  assert.equal(readOrders(stateDir).filter(({ type }) => type === 'checkpoint').length, 1);
  assert.equal(readOrders(stateDir).filter(({ type }) => type === 'stop_and_notify').length, 0);
  await tick(6);
  assert.equal(readPr(stateDir, PR).halted, true);
  const orders = readOrders(stateDir);
  assert.equal(orders.filter(({ type }) => type === 'stop_and_notify').length, 1);
  await tick(6);
  await tick(7);
  assert.deepEqual(readOrders(stateDir), orders);

  const count = readRounds(stateDir, PR).length;
  for (const expected of [true, false]) {
    const resumed = cli('steward-resume', env, '--pr', PR);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).resumed, expected);
  }
  assert.equal(readPr(stateDir, PR).halted, false);
  assert.equal(readRounds(stateDir, PR).length, count + 1);
  assert.equal(readRounds(stateDir, PR).at(-1).type, 'resume');
  await tick(7);
  assert.equal(readPr(stateDir, PR).halted, false);
  assert.equal(readOrders(stateDir).filter(({ type }) => type === 'stop_and_notify').length, 1);
  assert.ok(logs.every((message) => !message.includes('处理失败')));
});

test('tick observes delayed failures on a repair head and uses them for swap and metrics', async (t) => {
  const { env, stateDir } = fixture(t);
  const profile = loadProfile({ env });
  const tick = (index, minute, checks, key) => runSteward({
    command: 'tick', profile, now: () => new Date(at(minute)), log: () => {},
    client: fixtureClient({ get: () => pull(1, {
      head: head(index), checks, threads: [thread('fix this', { author: { login: 'ExampleUser', __typename: 'User' } })]
        .map((item) => ({ ...item, id: key })),
    }) }),
  });
  await tick(0, 0, [check('unit', 'SUCCESS')], 'example-thread-0');
  await tick(1, 2, [check('unit', null, { status: 'IN_PROGRESS' }), check('build', 'SUCCESS')], 'example-thread-1');
  await tick(1, 3, [check('unit', 'FAILURE'), check('build', 'SUCCESS')], 'example-thread-1');
  await tick(2, 6, [check('build', null, { status: 'IN_PROGRESS' })], 'example-thread-2');
  assert.equal(readOrders(stateDir).some(({ type }) => type === 'swap'), false);
  await tick(2, 7, [check('build', 'FAILURE')], 'example-thread-2');
  assert.equal(readOrders(stateDir).filter(({ type }) => type === 'swap').length, 1);
  const result = cli('steward-metrics', env, '--since', '2026-01-01');
  assert.equal(result.status, 0, result.stderr);
  const { M1, M3 } = JSON.parse(result.stdout);
  assert.deepEqual(M1, { samples: 2, p50: 2, p75: 4, p90: 4, unknown: 0 });
  assert.equal(M3, 1);
});

test('guard ack CLI stores supported receipts; rejects invalid swap without changing follower', async (t) => {
  const { env, stateDir } = fixture(t);
  writePr(stateDir, PR, { halted: true });
  const original = writeFollower(stateDir, PR, { kind: 'original', takeover: false, device: 'example-old', session: 'example-before' });
  const orders = {};
  for (const type of ['checkpoint', 'swap', 'stop_and_notify']) {
    orders[type] = await writeOrder(stateDir, makeOrder({ type, pr: PR, head: head(1), reason: 'fixture' }));
  }
  const ack = (type, result, ...extra) => cli('steward-ack', env, '--order', orders[type].id, '--result', result, ...extra);
  for (const [type, result] of [['checkpoint', 'created'], ['swap', 'delivered'], ['swap', 'created'], ['stop_and_notify', 'gone']]) {
    const rejected = ack(type, result);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /unsupported receipt result|必须同时传/);
    assert.equal(readReceipt(stateDir, orders[type].id), null);
    assert.deepEqual(readFollower(stateDir, PR), original);
  }
  for (const [type, result, extra] of [
    ['checkpoint', 'gone', []],
    ['stop_and_notify', 'delivered', []],
    ['swap', 'created', ['--device', 'example-new', '--session', 'example-after']],
  ]) {
    const accepted = ack(type, result, ...extra);
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(readReceipt(stateDir, orders[type].id).result, result);
  }
  const follower = readFollower(stateDir, PR);
  assert.deepEqual([follower.kind, follower.device, follower.session], ['dedicated', 'example-new', 'example-after']);
  assert.equal(readPr(stateDir, PR).guard.swapped, true);
  assert.equal(readPr(stateDir, PR).halted, true);
  assert.equal(ack('swap', 'created', '--device', 'example-new', '--session', 'example-later').status, 0);
  assert.deepEqual(readFollower(stateDir, PR), follower);
});

test('a locked PR rejects resume with no change to halted state or rounds', async (t) => {
  const { env, stateDir } = fixture(t);
  writePr(stateDir, PR, { halted: true });
  await withPrLock(stateDir, PR, () => {
    const result = cli('steward-resume', env, '--pr', PR);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /state locked/);
    assert.deepEqual(readRounds(stateDir, PR), []);
    assert.equal(readPr(stateDir, PR).halted, true);
  });
});
