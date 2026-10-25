// #47 SC11 / SC13：host/round 的认领、卡住处理；tick 的 poll 在沙箱外跑、读得到夹具令牌。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { runHostRound } from './host/round.mjs';
import { runTick } from './host/tick.mjs';
import { run as procRun } from './host/proc.mjs';
import { OWNER, REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const ROOT_REF = `${REPO}#1`;

function writeHostJson(home) {
  const file = path.join(home, 'config', 'host.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({ piCommand: ['pi', '--model', 'example/model', '--thinking', 'max'] }, null, 2),
  );
}

function writeMeminfo() {
  const file = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(file, 'MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n');
  return file;
}

function roundFixture({ status } = {}) {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  writeHostJson(base.home);
  const calls = { round: [], pi: [], gate: 0 };
  const claim = { issue: ROOT_REF, round: 1, commentId: 1001, bodyVersion: `sha256:${'b'.repeat(64)}` };
  const message = '先读 watchers/acceptance/SESSION.md，照里面的步骤做完这一轮验收。';

  const runRoundFake = async (argv) => {
    calls.round.push(argv);
    if (argv[0] === 'start') return { code: 0, stdout: `${message}\n${JSON.stringify(claim)}\n`, stderr: '' };
    if (argv[0] === 'status') {
      return { code: 0, stdout: `${JSON.stringify(status || { stalled: false })}\n`, stderr: '' };
    }
    return { code: 0, stdout: '{}\n', stderr: '' };
  };

  const startGateFake = async ({ socketPath }) => {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    fs.writeFileSync(socketPath, '');
    return {
      async stop() {
        calls.gate += 1;
      },
    };
  };

  return { home: base.home, calls, claim, message, runRoundFake, startGateFake };
}

function hangingPi(calls) {
  return (options) => {
    calls.pi.push(options);
    let resolveExit;
    const exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    return {
      pid: 555001,
      stdin: { write() {}, end() {} },
      kill(signal) {
        if (signal === 'SIGTERM') resolveExit({ code: 143, signal: 'SIGTERM' });
      },
      exit,
    };
  };
}

test('SC11 认领之后 pi 在 bwrap 里跑；卡住先杀进程再 abort，并写提醒', async () => {
  const fixture = roundFixture({ status: { stalled: true } });
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    spawnPi: hangingPi(fixture.calls),
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 5,
    killGraceMs: 20,
    log: () => {},
  });
  assert.notEqual(code, 0);
  assert.equal(fixture.calls.pi.length, 1);
  assert.equal(fixture.calls.pi[0].cmd, 'bwrap');
  const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
  assert.ok(abort, '卡住要 abort');
  assert.match(abort[abort.indexOf('--reason') + 1], /卡住：超过 stallMinutes 没有进度/);
  assert.ok(readAlerts(hostPaths(fixture.home)).some((entry) => entry.kind === 'round-stalled'));
  assert.equal(fixture.calls.gate, 1, '写闸 serve 收掉');
  assert.equal(fs.existsSync(hostPaths(fixture.home).roundsDir) && fs.readdirSync(hostPaths(fixture.home).roundsDir).length, 0);
});

test('SC11 pi 跑着时宿主出错（查进度抛异常）：先结束 pi，再 abort、收写闸', async () => {
  const fixture = roundFixture();
  const killed = [];
  let exited = false;
  let abortSawPiRunning = null;
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: async (argv) => {
      fixture.calls.round.push(argv);
      if (argv[0] === 'status') throw new Error('查进度失败');
      if (argv[0] === 'abort') abortSawPiRunning = !exited;
      return fixture.runRoundFake(argv);
    },
    startGate: async (options) => {
      const gate = await fixture.startGateFake(options);
      return {
        async stop() {
          assert.equal(exited, true, '写闸收掉之前 pi 必须已经结束');
          await gate.stop();
        },
      };
    },
    spawnPi: (options) => {
      fixture.calls.pi.push(options);
      let resolveExit;
      const exit = new Promise((resolve) => {
        resolveExit = resolve;
      });
      return {
        pid: 555002,
        stdin: { write() {}, end() {} },
        kill(signal) {
          killed.push(signal);
          if (signal === 'SIGTERM') {
            exited = true;
            resolveExit({ code: 143, signal });
          }
        },
        exit,
      };
    },
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 5,
    killGraceMs: 20,
    log: () => {},
  });
  assert.equal(code, 1);
  assert.deepEqual(killed, ['SIGTERM'], 'pi 被结束');
  assert.equal(abortSawPiRunning, false, 'abort 之前 pi 已经结束');
  const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
  assert.match(abort[abort.indexOf('--reason') + 1], /宿主出错：查进度失败/);
  assert.equal(fixture.calls.gate, 1);
});

test('SC11 认领被写闸拒绝（4）：不跑模型，写一条提醒', async () => {
  const fixture = roundFixture();
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runRound: async (argv) => {
      fixture.calls.round.push(argv);
      return { code: 4, stdout: '', stderr: '写闸拒绝：gate-disabled' };
    },
    startGate: fixture.startGateFake,
    spawnPi: hangingPi(fixture.calls),
    meminfoPath: writeMeminfo(),
    log: () => {},
  });
  assert.equal(code, 4);
  assert.equal(fixture.calls.pi.length, 0);
  assert.ok(readAlerts(hostPaths(fixture.home)).some((entry) => entry.kind === 'write-rejected'));
});

function writeFakeGh(binDir, tokenLog) {
  fs.mkdirSync(binDir, { recursive: true });
  const file = path.join(binDir, 'gh');
  const issue = {
    id: 'I_1',
    number: 1,
    title: '独立任务',
    body: '- [ ] SC1 看一眼 验证：unit',
    state: 'OPEN',
    url: `https://example.invalid/${REPO}/issues/1`,
    createdAt: '2026-02-01T00:00:00.000Z',
    closedAt: null,
    updatedAt: '2026-02-01T00:00:00.000Z',
    author: { login: OWNER },
    repository: { nameWithOwner: REPO },
    parent: null,
    subIssues: { nodes: [] },
    closedByPullRequestsReferences: {
      nodes: [
        {
          number: 2,
          url: `https://example.invalid/${REPO}/pull/2`,
          mergedAt: '2026-10-20T00:00:00.000Z',
          repository: { nameWithOwner: REPO },
        },
      ],
    },
    comments: { nodes: [] },
  };
  fs.writeFileSync(
    file,
    String.raw`#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
fs.writeFileSync(${JSON.stringify(tokenLog)}, JSON.stringify({ token: process.env.GH_TOKEN || null, args }));
const payload = JSON.parse(input || '{}');
const query = String(payload.query || '');
if (query.includes('user(login')) {
  process.stdout.write(JSON.stringify({
    data: {
      user: {
        open: { nodes: [${JSON.stringify(issue)}], pageInfo: { hasNextPage: false, endCursor: null } },
        closed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      },
    },
  }));
  process.exit(0);
}
process.stdout.write(JSON.stringify({ data: { repository: { issue: null } } }));
process.exit(0);
`,
  );
  fs.chmodSync(file, 0o700);
  fs.writeFileSync(tokenLog, '');
  return file;
}

test('SC13 tick 在沙箱外跑 poll（不进 bwrap），poll 读的是夹具令牌文件', async () => {
  const base = writeProfile(tmpDir(), {
    tokenContent: 'fixture-token-not-real-000123',
    profile: { stateDir: path.join(tmpDir(), 'acc-state') },
  });
  const home = base.home;
  const binDir = path.join(home, 'bin');
  const tokenLog = path.join(home, 'gh-token.log');
  writeFakeGh(binDir, tokenLog);

  const started = [];
  const runCalls = [];
  const run = (cmd, args, options) => {
    runCalls.push({ cmd, args });
    return procRun(cmd, args, options);
  };
  const env = {
    ...process.env,
    PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    TOKEN_LOG: tokenLog,
  };
  const heartbeat = await runTick({
    home,
    env,
    run,
    spawnRound: (issue) => {
      started.push(issue);
      return 999001;
    },
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });

  assert.equal(runCalls.length, 1, JSON.stringify(runCalls));
  assert.equal(runCalls[0].cmd, 'node');
  assert.match(runCalls[0].args[0], /bin[/\\]poll\.mjs$/);
  assert.equal(runCalls.some((call) => String(call.cmd).includes('bwrap')), false, 'poll 不进 bwrap');

  const recorded = JSON.parse(fs.readFileSync(tokenLog, 'utf8'));
  assert.equal(recorded.token, 'fixture-token-not-real-000123', 'poll 经 github.mjs 读到夹具令牌');

  assert.deepEqual(started, [ROOT_REF], '该开始的任务被起了一轮');
  const onDisk = JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
  assert.equal(onDisk.at, '2026-10-24T02:00:00.000Z');
  assert.ok(Number.isInteger(onDisk.pid));
  assert.equal(onDisk.lastTick.ok, true);
  assert.deepEqual(onDisk.lastTick.started.map((entry) => entry.issue), [ROOT_REF]);
  assert.ok(Array.isArray(onDisk.running));
  assert.equal(heartbeat.lastTick.ok, true);
});

test('SC13 tick 里 poll 出错：心跳记 ok=false + 一条提醒，不抛出', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async () => ({ code: 1, stdout: '', stderr: '配置无效' }),
    spawnRound: () => {
      throw new Error('不该起轮次');
    },
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
  });
  assert.equal(heartbeat.lastTick.ok, false);
  assert.match(heartbeat.lastTick.error, /poll 失败/);
  assert.ok(readAlerts(hostPaths(home)).some((entry) => entry.kind === 'tick-failed'));
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  assert.ok(profile.ownerLogin);
});
