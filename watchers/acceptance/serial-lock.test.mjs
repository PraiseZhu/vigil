// 重仓同一时刻只跑一轮（host.json 的 serialRepos）：复用 mivo 测试锁那套锁逻辑（O_EXCL 锁文件、整轮持有、
// 认领之前拿锁、拿不到这一拍不认领、退出 3）。只有名单里的仓受影响；mivo 照旧占 mivo-test.lock；别的仓并发不变。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hostPaths, readAlerts, readLockPayload, releaseLock, tryAcquireLock } from './host/paths.mjs';
import { runHostRound, serialLockFiles, serialRepos } from './host/round.mjs';
import { runTick } from './host/tick.mjs';
import { REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const HEAVY = 'example-owner/heavy-app';
const MIVO = 'example-owner/mivo-plugin';

function writeHostJson(home, extra = {}) {
  const file = path.join(home, 'config', 'host.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ piCommand: ['pi', '--model', 'example/model'], ...extra }, null, 2));
}

function writeMeminfo() {
  const file = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(file, 'MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n');
  return file;
}

function homeWith(hostJson) {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state'), autoRepos: [REPO, HEAVY, MIVO] } });
  writeHostJson(home, hostJson);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.enabledFile, '1');
  return { home, paths };
}

test('serialRepos：只认 "owner/repo" 字符串数组，不分大小写；没配就是空', () => {
  assert.deepEqual(serialRepos({}), []);
  assert.deepEqual(serialRepos({ serialRepos: [] }), []);
  assert.deepEqual(serialRepos({ serialRepos: ['Example-Owner/Heavy-App'] }), ['example-owner/heavy-app']);
  for (const bad of ['example-owner/heavy-app', [''], ['heavy-app'], ['example-owner/*'], ['a/b/c'], [42], ['example-owner/heavy-app#1']]) {
    assert.throws(() => serialRepos({ serialRepos: bad }), /serialRepos/, JSON.stringify(bad));
  }
});

test('serialLockFiles：名单里的仓一把按仓的锁；mivo 照旧是 mivo-test.lock（配不配都一样）；别的仓不拿锁', () => {
  const paths = hostPaths(tmpDir());
  const config = { serialRepos: [HEAVY] };
  const heavy = serialLockFiles(paths, [HEAVY], config);
  assert.equal(heavy.length, 1);
  assert.equal(path.dirname(heavy[0]), paths.locksDir);
  assert.notEqual(heavy[0], paths.testLock, '不和 mivo 共用一把锁：mivo 和重仓互不挡');
  assert.deepEqual(serialLockFiles(paths, ['Example-Owner/Heavy-App'], config), heavy, '仓名不分大小写');
  assert.deepEqual(serialLockFiles(paths, [MIVO], config), [paths.testLock]);
  assert.deepEqual(serialLockFiles(paths, [MIVO], {}), [paths.testLock]);
  assert.deepEqual(serialLockFiles(paths, [REPO], config), []);
  assert.deepEqual(serialLockFiles(paths, [HEAVY], {}), [], '没配名单：重仓不拿锁（老行为）');
  assert.deepEqual(serialLockFiles(paths, [HEAVY, HEAVY, MIVO], config), [...heavy, paths.testLock].sort(), '去重');
});

/** 可控的验收轮：认领评论按 issue 回；pi 起来后等 release() 才退。 */
function controlledRound(home) {
  const calls = { round: [], pi: [], predeps: [] };
  const releases = new Map();
  const runRoundFake = async (argv) => {
    calls.round.push(argv);
    const issue = argv[argv.indexOf('--issue') + 1];
    if (argv[0] === 'start') {
      return { code: 0, stdout: `先读 SESSION.md\n${JSON.stringify({ issue, round: 1, commentId: 1001, bodyVersion: `sha256:${'c'.repeat(64)}` })}\n`, stderr: '' };
    }
    if (argv[0] === 'status') return { code: 0, stdout: `${JSON.stringify({ round: 1, status: '通过', stalled: false })}\n`, stderr: '' };
    return { code: 0, stdout: '{}\n', stderr: '' };
  };
  const startGateFake = async ({ socketPath }) => {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    fs.writeFileSync(socketPath, '');
    return { async stop() {} };
  };
  function round(issue) {
    let resolveExit;
    const exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    releases.set(issue, () => resolveExit({ code: 0 }));
    return runHostRound({
      home,
      issue,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      runRound: runRoundFake,
      startGate: startGateFake,
      prefetch: async () => [],
      predeps: async (options) => {
        calls.predeps.push(issue);
        return { mounts: [], deps: [] };
      },
      spawnPi: () => {
        calls.pi.push(issue);
        return { pid: 777001, stdin: { write() {}, end() {} }, kill() {}, exit };
      },
      meminfoPath: writeMeminfo(),
      statusIntervalMs: 5,
      log: () => {},
    });
  }
  const starts = () => calls.round.filter((argv) => argv[0] === 'start').map((argv) => argv[argv.indexOf('--issue') + 1]);
  return { calls, round, release: (issue) => releases.get(issue)(), starts };
}

async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('等不到');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('两个重仓轮同时到：第二个不认领（退出 3，不扣轮次、不算环境问题、不写提醒），锁放了才认领；别的仓照常并发', async () => {
  const { home, paths } = homeWith({ serialRepos: [HEAVY] });
  const lockFile = serialLockFiles(paths, [HEAVY], { serialRepos: [HEAVY] })[0];
  const world = controlledRound(home);

  const first = world.round(`${HEAVY}#1`);
  await until(() => world.calls.pi.includes(`${HEAVY}#1`));
  assert.equal(readLockPayload(lockFile)?.pid, process.pid, '第一轮整轮持锁');

  // 第二个重仓轮：锁被占，认领之前就退出 3。
  const second = await world.round(`${HEAVY}#2`);
  assert.equal(second, 3);
  assert.deepEqual(world.starts(), [`${HEAVY}#1`], '第二个没认领（issue 上不留评论、不算一轮）');
  assert.equal(world.calls.round.some((argv) => argv[0] === 'abort'), false, '不 abort');
  assert.deepEqual(world.calls.predeps, [`${HEAVY}#1`], '第二个不预装依赖（不会 deps-failed）');
  assert.deepEqual(readAlerts(paths), [], '不写任何提醒（没有 env-unverified / deps-failed / round-failed）');
  assert.equal(fs.existsSync(path.join(paths.slotsDir, 'slot-1')), false, '拿不到锁就把槽放回去');

  // 别的仓并发不变：重仓轮跑着时，普通仓照样占第二个槽认领。
  const other = world.round(`${REPO}#3`);
  await until(() => world.calls.pi.includes(`${REPO}#3`));
  world.release(`${REPO}#3`);
  assert.equal(await other, 0);
  assert.deepEqual(world.starts(), [`${HEAVY}#1`, `${REPO}#3`]);

  // 第一轮跑完放锁：第二个重仓轮这才认领。
  world.release(`${HEAVY}#1`);
  assert.equal(await first, 0);
  assert.equal(fs.existsSync(lockFile), false, '跑完放锁');
  const retried = world.round(`${HEAVY}#2`);
  await until(() => world.calls.pi.includes(`${HEAVY}#2`));
  world.release(`${HEAVY}#2`);
  assert.equal(await retried, 0);
  assert.deepEqual(world.starts(), [`${HEAVY}#1`, `${REPO}#3`, `${HEAVY}#2`]);
  assert.deepEqual(readAlerts(paths), []);
});

test('没配 serialRepos：两个重仓轮照旧同时跑（老行为）', async () => {
  const { home, paths } = homeWith({});
  const world = controlledRound(home);
  const first = world.round(`${HEAVY}#1`);
  await until(() => world.calls.pi.includes(`${HEAVY}#1`));
  const second = world.round(`${HEAVY}#2`);
  await until(() => world.calls.pi.includes(`${HEAVY}#2`));
  world.release(`${HEAVY}#1`);
  world.release(`${HEAVY}#2`);
  assert.deepEqual([await first, await second], [0, 0]);
  assert.ok(!fs.existsSync(paths.locksDir) || fs.readdirSync(paths.locksDir).length === 0, '不出现锁文件');
});

test('serialRepos 写错：不认领、不占槽，退出非 0（宁可不跑也不悄悄放开并发）', async () => {
  const { home, paths } = homeWith({ serialRepos: 'example-owner/heavy-app' });
  const world = controlledRound(home);
  await assert.rejects(world.round(`${HEAVY}#1`), /serialRepos/);
  assert.deepEqual(world.starts(), []);
  assert.equal(fs.existsSync(path.join(paths.slotsDir, 'slot-0')), false);
});

function tickWith(home, entries) {
  const started = [];
  const run = async () => ({ code: 0, stdout: JSON.stringify(entries), stderr: '' });
  return runTick({
    home,
    env: { ...process.env },
    run,
    spawnRound: (issue) => {
      started.push(issue);
      return 990000 + started.length;
    },
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: true, newUncertain: [] }),
    now: () => Date.parse('2026-10-28T18:00:00.000Z'),
  }).then((heartbeat) => ({ heartbeat, started }));
}

test('tick：两个重仓 issue 同一拍待认领 → 只起一个，另一个记进心跳 serialWaiting；空出的槽照样给别的仓', async () => {
  const { home, paths } = homeWith({ serialRepos: [HEAVY] });
  const entries = [{ issue: `${HEAVY}#1` }, { issue: `${HEAVY}#2` }, { issue: `${REPO}#3` }];
  const { heartbeat, started } = await tickWith(home, entries);
  assert.equal(heartbeat.lastTick.ok, true, heartbeat.lastTick.error);
  assert.deepEqual(started, [`${HEAVY}#1`, `${REPO}#3`]);
  assert.deepEqual(heartbeat.lastTick.serialWaiting, [{ issue: `${HEAVY}#2` }]);
  assert.deepEqual(readAlerts(paths), [], '等锁不写提醒');
});

test('tick：重仓锁被活着的轮次占着 → 重仓一个都不起（不白起进程），别的仓照起；锁放了下一拍就起', async () => {
  const { home, paths } = homeWith({ serialRepos: [HEAVY] });
  const lockFile = serialLockFiles(paths, [HEAVY], { serialRepos: [HEAVY] })[0];
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  assert.equal(tryAcquireLock(lockFile), true);
  const entries = [{ issue: `${HEAVY}#2` }, { issue: `${REPO}#3` }];
  try {
    const { heartbeat, started } = await tickWith(home, entries);
    assert.deepEqual(started, [`${REPO}#3`]);
    assert.deepEqual(heartbeat.lastTick.serialWaiting, [{ issue: `${HEAVY}#2` }]);
  } finally {
    releaseLock(lockFile);
  }
  const next = await tickWith(home, entries);
  assert.deepEqual(next.started, [`${HEAVY}#2`, `${REPO}#3`]);
  assert.equal(next.heartbeat.lastTick.serialWaiting, undefined, '没人等锁：心跳不多这个字段');
  assert.deepEqual(readAlerts(paths), []);
});

test('tick：没配 serialRepos 时两个重仓 issue 照旧同一拍都起（老行为）', async () => {
  const { home } = homeWith({});
  const { started } = await tickWith(home, [{ issue: `${HEAVY}#1` }, { issue: `${HEAVY}#2` }]);
  assert.deepEqual(started, [`${HEAVY}#1`, `${HEAVY}#2`]);
});
