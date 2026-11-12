// 修正轮防饿死：等待超过 1 小时的修正轮拿下一个空槽（优先于 pendingAcceptance），不固定留槽。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hostPaths } from './host/paths.mjs';
import {
  PRBOT_WAIT_MS,
  PRBOT_WAIT_VERSION,
  clearStarted,
  isStarved,
  readPrbotWait,
  rememberFound,
  starvedIssues,
  writePrbotWait,
} from './host/prbot-wait.mjs';
import { runTick } from './host/tick.mjs';
import { REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const NOW = Date.parse('2026-11-12T08:00:00.000Z');
const WAITING = `${REPO}#422`;
const FRESH = `${REPO}#10`;
const ACCEPT = `${REPO}#1`;

function enableGate(home) {
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.enabledFile, '1');
}

function writeHost(home) {
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'config', 'host.json'),
    JSON.stringify({ piCommand: ['pi'], prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } }),
  );
}

function occupySlots(paths, count, pid = process.pid) {
  fs.mkdirSync(paths.slotsDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    fs.writeFileSync(
      path.join(paths.slotsDir, `slot-${i}`),
      JSON.stringify({ pid, startedAt: '2026-11-12T00:00:00.000Z' }),
    );
  }
}

function writeWait(paths, issues, firstSeenAt) {
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const body = {
    version: PRBOT_WAIT_VERSION,
    issues: Object.fromEntries((Array.isArray(issues) ? issues : [issues]).map((issue) => [issue, { firstSeenAt }])),
  };
  fs.writeFileSync(paths.prbotWaitFile, `${JSON.stringify(body, null, 2)}\n`);
}

async function tickOnce(home, { now = NOW, entries = [], found = [], spawnRound, spawnPrbot } = {}) {
  const startedRounds = [];
  const startedPrbot = [];
  const heartbeat = await runTick({
    home,
    env: { ...process.env, ACCEPTANCE_WATCHER_HOME: home },
    run: async () => ({ code: 0, stdout: JSON.stringify(entries), stderr: '' }),
    spawnRound: spawnRound || ((issue) => {
      startedRounds.push(issue);
      return 900002;
    }),
    spawnPrbot: spawnPrbot || ((issue) => {
      startedPrbot.push(issue);
      return 900001;
    }),
    discoverPrbot: async () => found.map((issue) => ({ issue })),
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    now: () => now,
  });
  return { heartbeat, startedRounds, startedPrbot, paths: hostPaths(home) };
}

test('等待口径：刚好 1 小时不优先，刚过 1 小时才算饿住', () => {
  assert.equal(PRBOT_WAIT_MS, 60 * 60 * 1000);
  const firstSeen = new Date(NOW - PRBOT_WAIT_MS).toISOString();
  assert.equal(isStarved(firstSeen, NOW), false, '刚好 1 小时还没超过，不优先');
  assert.equal(isStarved(new Date(NOW - PRBOT_WAIT_MS - 1).toISOString(), NOW), true, '刚过 1 小时优先拿槽');
  assert.equal(isStarved(undefined, NOW), false);
  assert.equal(isStarved('not-a-date', NOW), false);
});

test('状态文件缺失或损坏按空处理，不清已有发现；起了或不再出现就清掉', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'prbot-wait.json');
  assert.deepEqual(readPrbotWait(file), { version: PRBOT_WAIT_VERSION, issues: {} });
  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(readPrbotWait(file), { version: PRBOT_WAIT_VERSION, issues: {} });
  fs.writeFileSync(file, JSON.stringify({ version: 99, issues: { [WAITING]: { firstSeenAt: '2026-11-12T00:00:00.000Z' } } }));
  assert.deepEqual(readPrbotWait(file), { version: PRBOT_WAIT_VERSION, issues: {} });
  fs.writeFileSync(file, JSON.stringify({ version: PRBOT_WAIT_VERSION, issues: 'bad' }));
  assert.deepEqual(readPrbotWait(file), { version: PRBOT_WAIT_VERSION, issues: {} });

  let state = rememberFound(readPrbotWait(file), [WAITING], NOW);
  assert.equal(state.issues[WAITING].firstSeenAt, new Date(NOW).toISOString());
  writePrbotWait(file, state);
  const again = rememberFound(readPrbotWait(file), [WAITING], NOW + 60_000);
  assert.equal(again.issues[WAITING].firstSeenAt, new Date(NOW).toISOString(), '再次发现保留首次时间');
  const dropped = rememberFound(again, [], NOW + 120_000);
  assert.deepEqual(dropped.issues, {}, '不再出现就清掉');
  const started = clearStarted(rememberFound(emptyFromNow(), [WAITING, FRESH], NOW), [WAITING]);
  assert.equal(started.issues[WAITING], undefined);
  assert.ok(started.issues[FRESH]);
});

function emptyFromNow() {
  return { version: PRBOT_WAIT_VERSION, issues: {} };
}

test('tick：刚好 1 小时的修正轮不优先，验收轮仍拿满预留的槽', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  enableGate(home);
  writeHost(home);
  writeWait(hostPaths(home), WAITING, new Date(NOW - PRBOT_WAIT_MS).toISOString());
  const result = await tickOnce(home, {
    entries: [
      { issue: ACCEPT, kind: 'parent', tier: 'auto', nextRound: 1 },
      { issue: `${REPO}#2`, kind: 'parent', tier: 'auto', nextRound: 1 },
    ],
    found: [WAITING],
  });
  assert.deepEqual(result.startedPrbot, [], '刚好 1 小时仍给验收轮留足 2 个槽，不起修正轮');
  assert.deepEqual(result.startedRounds, [ACCEPT, `${REPO}#2`]);
  const wait = readPrbotWait(result.paths.prbotWaitFile);
  assert.equal(wait.issues[WAITING].firstSeenAt, new Date(NOW - PRBOT_WAIT_MS).toISOString(), '没起就保留首次等待时间');
});

test('tick：刚过 1 小时的修正轮优先拿下一个空槽，验收轮再拿剩下的', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  enableGate(home);
  writeHost(home);
  writeWait(hostPaths(home), WAITING, new Date(NOW - PRBOT_WAIT_MS - 1).toISOString());
  const result = await tickOnce(home, {
    entries: [
      { issue: ACCEPT, kind: 'parent', tier: 'auto', nextRound: 1 },
      { issue: `${REPO}#2`, kind: 'parent', tier: 'auto', nextRound: 1 },
    ],
    found: [WAITING],
  });
  assert.deepEqual(result.startedPrbot, [WAITING], '刚过 1 小时优先拿槽');
  assert.deepEqual(result.startedRounds, [ACCEPT], '剩下一个槽给验收轮，不超出 MAX_ROUNDS=2');
  const wait = readPrbotWait(result.paths.prbotWaitFile);
  assert.equal(wait.issues[WAITING], undefined, '起了就清掉等待记录');
});

test('tick：没有修正轮时验收轮吞吐不变，pendingAcceptance 照常拿满 2 槽', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  enableGate(home);
  writeHost(home);
  const result = await tickOnce(home, {
    entries: [
      { issue: ACCEPT, kind: 'parent', tier: 'auto', nextRound: 1 },
      { issue: `${REPO}#2`, kind: 'parent', tier: 'auto', nextRound: 1 },
    ],
    found: [],
  });
  assert.deepEqual(result.startedPrbot, []);
  assert.deepEqual(result.startedRounds, [ACCEPT, `${REPO}#2`]);
});

test('tick：两个槽都被活轮次占着时不抢、不中止，只继续记等待', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  enableGate(home);
  writeHost(home);
  const paths = hostPaths(home);
  occupySlots(paths, 2);
  const firstSeen = new Date(NOW - PRBOT_WAIT_MS - 1).toISOString();
  writeWait(paths, WAITING, firstSeen);
  const result = await tickOnce(home, {
    entries: [{ issue: ACCEPT, kind: 'parent', tier: 'auto', nextRound: 1 }],
    found: [WAITING],
  });
  assert.deepEqual(result.startedPrbot, []);
  assert.deepEqual(result.startedRounds, []);
  assert.equal(result.heartbeat.lastTick.ok, true);
  const wait = readPrbotWait(paths.prbotWaitFile);
  assert.equal(wait.issues[WAITING].firstSeenAt, firstSeen, '没起就保留等待时间，不中止活轮次');
});

test('tick：写闸关着时即使已饿住也不起修正轮', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  writeHost(home);
  writeWait(hostPaths(home), WAITING, new Date(NOW - PRBOT_WAIT_MS - 1).toISOString());
  const result = await tickOnce(home, {
    entries: [{ issue: ACCEPT, kind: 'parent', tier: 'auto', nextRound: 1 }],
    found: [WAITING],
  });
  assert.equal(result.heartbeat.gate, 'disabled');
  assert.deepEqual(result.startedPrbot, []);
  assert.deepEqual(result.startedRounds, []);
});

test('starvedIssues 只挑等待超过 1 小时的发现项', () => {
  const state = rememberFound({ version: PRBOT_WAIT_VERSION, issues: {
    [WAITING]: { firstSeenAt: new Date(NOW - PRBOT_WAIT_MS - 1).toISOString() },
    [FRESH]: { firstSeenAt: new Date(NOW - PRBOT_WAIT_MS).toISOString() },
  } }, [WAITING, FRESH], NOW);
  // rememberFound keeps firstSeen
  assert.deepEqual(starvedIssues({ version: PRBOT_WAIT_VERSION, issues: {
    [WAITING]: { firstSeenAt: new Date(NOW - PRBOT_WAIT_MS - 1).toISOString() },
    [FRESH]: { firstSeenAt: new Date(NOW - PRBOT_WAIT_MS).toISOString() },
  } }, [WAITING, FRESH], NOW), [WAITING]);
});
