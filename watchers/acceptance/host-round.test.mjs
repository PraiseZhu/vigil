// #47 SC11 / SC13：host/round 的认领、卡住处理；tick 的 poll 在沙箱外跑、读得到夹具令牌。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { hostPaths, progressFileFor, readAlerts } from './host/paths.mjs';
import { roundDirFor, roundKey, runHostRound, startGateRelay } from './host/round.mjs';
import { runTick } from './host/tick.mjs';
import { run as procRun } from './host/proc.mjs';
import { OWNER, REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import { ENV_PROBLEM_PREFIX } from './bin/trigger.mjs';
import { appendCodePaths } from './bin/message.mjs';
import { appendDepsInfo } from './host/predeps.mjs';
import { collectBuildCiFacts } from './host/build-ci.mjs';

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

function roundFixture({ status, profile = {}, enabled = true } = {}) {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state'), ...profile } });
  writeHostJson(base.home);
  if (enabled) {
    fs.mkdirSync(hostPaths(base.home).gateDir, { recursive: true });
    fs.writeFileSync(hostPaths(base.home).enabledFile, '1');
  }
  const calls = { round: [], pi: [], gate: 0 };
  const claim = { issue: ROOT_REF, round: 1, commentId: 1001, bodyVersion: `sha256:${'b'.repeat(64)}` };
  const message = '先读 watchers/acceptance/SESSION.md，照里面的步骤做完这一轮验收。';

  const runRoundFake = async (argv) => {
    calls.round.push(argv);
    if (argv[0] === 'start') return { code: 0, stdout: `${message}\n${JSON.stringify(claim)}\n`, stderr: '' };
    if (argv[0] === 'status') {
      return { code: 0, stdout: `${JSON.stringify(status || { round: 1, status: '验收中', stalled: false })}\n`, stderr: '' };
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

  // 预取在真实路径测试里（round-lifecycle.test.mjs）测；这里只记下被调过。
  const prefetchFake = async (options) => {
    calls.prefetch = (calls.prefetch || 0) + 1;
    calls.prefetchOptions = options;
    return [];
  };

  return { home: base.home, calls, claim, message, runRoundFake, startGateFake, prefetchFake };
}

/** 一直不退的 pi。ignoreTerm：连 SIGTERM 都不理，只有 SIGKILL 才退。记下收到的信号和是否已退出。 */
function hangingPi(calls, { ignoreTerm = false } = {}) {
  const state = { killed: [], exited: false };
  const spawnPi = (options) => {
    calls.pi.push(options);
    let resolveExit;
    const exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    return {
      pid: 555001,
      stdin: { write() {}, end() {} },
      kill(signal) {
        state.killed.push(signal);
        if (signal === 'SIGKILL' || (signal === 'SIGTERM' && !ignoreTerm)) {
          state.exited = true;
          resolveExit({ code: 143, signal });
        }
      },
      exit,
    };
  };
  return { spawnPi, state };
}

test('SC11 认领之后 pi 在 bwrap 里跑；宿主侧判卡住（status 说没卡也不信）先杀进程再 abort，并写提醒', async () => {
  const fixture = roundFixture({ status: { round: 1, status: '验收中', stalled: false, lastProgressAt: '2099-01-01T00:00:00.000Z' }, profile: { stallMinutes: 0.001 } });
  const pi = hangingPi(fixture.calls);
  let abortSawPiRunning = null;
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    runRound: async (argv) => {
      if (argv[0] === 'abort') abortSawPiRunning = !pi.state.exited;
      return fixture.runRoundFake(argv);
    },
    spawnPi: pi.spawnPi,
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 5,
    killGraceMs: 20,
    log: () => {},
  });
  assert.notEqual(code, 0);
  assert.deepEqual(pi.state.killed, ['SIGTERM'], '卡住先 SIGTERM');
  assert.equal(abortSawPiRunning, false, 'abort 之前 pi 已经结束');
  assert.equal(fixture.calls.pi.length, 1);
  assert.equal(fixture.calls.pi[0].cmd, 'bwrap');
  const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
  assert.ok(abort, '卡住要 abort');
  assert.match(abort[abort.indexOf('--reason') + 1], /卡住：超过 stallMinutes 没有进度/);
  assert.ok(readAlerts(hostPaths(fixture.home)).some((entry) => entry.kind === 'round-stalled'));
  assert.equal(fixture.calls.gate, 1, '写闸 serve 收掉');
  assert.equal(fs.existsSync(hostPaths(fixture.home).roundsDir) && fs.readdirSync(hostPaths(fixture.home).roundsDir).length, 0);
});

test('SC11 卡住时 pi 不理 SIGTERM：等 killGraceMs 后升级 SIGKILL，退了才 abort', { timeout: 5000 }, async () => {
  const fixture = roundFixture({ profile: { stallMinutes: 0.001 } });
  const pi = hangingPi(fixture.calls, { ignoreTerm: true });
  let abortSawPiRunning = null;
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: async (argv) => {
      if (argv[0] === 'abort') abortSawPiRunning = !pi.state.exited;
      return fixture.runRoundFake(argv);
    },
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: pi.spawnPi,
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 5,
    killGraceMs: 20,
    log: () => {},
  });
  assert.notEqual(code, 0);
  assert.deepEqual(pi.state.killed, ['SIGTERM', 'SIGKILL'], 'SIGTERM 不管用就 SIGKILL');
  assert.equal(abortSawPiRunning, false, 'abort 之前 pi 已经结束');
  assert.equal(fixture.calls.gate, 1, '写闸 serve 收掉');
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
    prefetch: fixture.prefetchFake,
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

const BWRAP_OK = async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' });

/** 起来就退的 pi（退出码可选）。 */
function exitingPi(calls, code) {
  return (options) => {
    calls.pi.push(options);
    return { pid: 555010, stdin: { write() {}, end() {} }, kill() {}, exit: Promise.resolve({ code }) };
  };
}

for (const exitCode of [0, 1]) {
  test(`SC11 pi 以 ${exitCode} 退出但轮次还是「验收中」：立即 abort（原因写清退出码）+ round-failed 提醒`, async () => {
    const fixture = roundFixture();
    const code = await runHostRound({
      home: fixture.home,
      issue: ROOT_REF,
      run: BWRAP_OK,
      runRound: fixture.runRoundFake,
      startGate: fixture.startGateFake,
      prefetch: fixture.prefetchFake,
      spawnPi: exitingPi(fixture.calls, exitCode),
      meminfoPath: writeMeminfo(),
      statusIntervalMs: 60000,
      log: () => {},
    });
    assert.equal(code, 1);
    const commands = fixture.calls.round.map((argv) => argv[0]);
    assert.deepEqual(commands, ['start', 'status', 'abort'], '退出后先回读状态，再 abort（不等查进度的间隔）');
    const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
    assert.equal(abort[abort.indexOf('--reason') + 1], `pi 退出（code=${exitCode}）但没写裁决`);
    const alerts = readAlerts(hostPaths(fixture.home));
    assert.ok(alerts.some((entry) => entry.kind === 'round-failed' && entry.reason === `pi 退出（code=${exitCode}）但没写裁决`), JSON.stringify(alerts));
    assert.equal(fixture.calls.gate, 1);
  });
}

test('SC11 pi 退出时轮次已是终态：正常收尾，不 abort、不写提醒', async () => {
  const fixture = roundFixture({ status: { round: 1, status: '要修' } });
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: exitingPi(fixture.calls, 0),
    meminfoPath: writeMeminfo(),
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(fixture.calls.round.some((argv) => argv[0] === 'abort'), false);
  assert.deepEqual(readAlerts(hostPaths(fixture.home)), []);
});

test('SC11 裁决写完 pi 不退：宽限 verdictGraceMs 后 SIGTERM，收尾不 abort', { timeout: 5000 }, async () => {
  const fixture = roundFixture({ status: { round: 1, status: '通过' } });
  const pi = hangingPi(fixture.calls);
  const startedAt = Date.now();
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: pi.spawnPi,
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 5,
    verdictGraceMs: 150,
    killGraceMs: 20,
    log: () => {},
  });
  assert.equal(code, 0);
  assert.ok(Date.now() - startedAt >= 150, '先宽限');
  assert.deepEqual(pi.state.killed, ['SIGTERM']);
  assert.equal(fixture.calls.round.some((argv) => argv[0] === 'abort'), false);
  assert.equal(fixture.calls.gate, 1);
});

test('SC11 总时长上限（host.json maxRoundMinutes，宿主墙钟）：到点停 pi、abort、round-timeout', { timeout: 5000 }, async () => {
  const fixture = roundFixture();
  fs.writeFileSync(
    path.join(fixture.home, 'config', 'host.json'),
    JSON.stringify({ piCommand: ['pi'], maxRoundMinutes: 0.005 }),
  );
  const pi = hangingPi(fixture.calls);
  const startedAt = Date.now();
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: pi.spawnPi,
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 5,
    killGraceMs: 20,
    log: () => {},
  });
  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt >= 300);
  assert.deepEqual(pi.state.killed, ['SIGTERM']);
  const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
  assert.equal(abort[abort.indexOf('--reason') + 1], '超过总时长上限（0.005 分钟）');
  assert.ok(readAlerts(hostPaths(fixture.home)).some((entry) => entry.kind === 'round-timeout'));
});

test('SC11 pi.log 在长就刷新宿主侧进度（写在 <home>/state/host/progress），不判卡住；停了才判', { timeout: 10000 }, async () => {
  const fixture = roundFixture({ profile: { stallMinutes: 0.003 } });
  const paths = hostPaths(fixture.home);
  const progress = progressFileFor(paths, ROOT_REF, 1);
  assert.ok(progress.startsWith(path.join(fixture.home, 'state', 'host')), '宿主进度在 <home>/state/host 下');
  const seen = [];
  let timer;
  const pi = hangingPi(fixture.calls);
  const spawnPi = (options) => {
    const handle = pi.spawnPi(options);
    let n = 0;
    // 写 600 毫秒的输出（卡住阈值 180 毫秒），然后不再写。
    timer = setInterval(() => {
      n += 1;
      if (n <= 20) fs.appendFileSync(options.logFile, `line ${n}\n`);
      try {
        seen.push(JSON.parse(fs.readFileSync(progress, 'utf8')));
      } catch {
        // 还没写。
      }
    }, 30);
    return handle;
  };
  const startedAt = Date.now();
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi,
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 10,
    killGraceMs: 20,
    log: () => {},
  });
  clearInterval(timer);
  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt >= 600 + 180, `卡住判得太早：${Date.now() - startedAt}ms`);
  assert.ok(seen.length > 0);
  assert.ok(seen.at(-1).piLogBytes > 0, '宿主记下了 pi.log 的长度');
  assert.ok(Date.parse(seen.at(-1).lastActivityAt) - startedAt >= 400, '最近活动跟着 pi.log 往后走');
  const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
  assert.match(abort[abort.indexOf('--reason') + 1], /卡住：超过 stallMinutes 没有进度/);
  assert.equal(fs.existsSync(progress), false, '收尾删掉');
});

test('SC11 写闸总开关关着：不认领、不写 write-rejected 提醒、不跑模型，退出 3', async () => {
  const fixture = roundFixture({ enabled: false });
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: hangingPi(fixture.calls).spawnPi,
    meminfoPath: writeMeminfo(),
    log: () => {},
  });
  assert.equal(code, 3);
  assert.deepEqual(fixture.calls.round, [], '没认领');
  assert.equal(fixture.calls.pi.length, 0);
  assert.deepEqual(readAlerts(hostPaths(fixture.home)), []);
  assert.equal(fs.existsSync(path.join(hostPaths(fixture.home).slotsDir, 'slot-0')), false, '槽放回去');
});

test('SC11 写闸转发：沙箱那一侧的 socket 原样转给内层写闸，每条连接记一次活动，权限 600', async () => {
  const dir = tmpDir();
  const innerPath = path.join(dir, 'inner.sock');
  const publicPath = path.join(dir, 'public', 'gate.sock');
  const inner = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) socket.end(`${JSON.stringify({ code: 0, body: { echo: JSON.parse(buffer) } })}\n`);
    });
  });
  await new Promise((resolve) => inner.listen(innerPath, resolve));
  let requests = 0;
  const relay = await startGateRelay({ publicPath, innerPath, onRequest: () => (requests += 1) });
  try {
    assert.equal(fs.statSync(publicPath).mode & 0o777, 0o600);
    const ask = (payload) =>
      new Promise((resolve, reject) => {
        const socket = net.connect(publicPath);
        let reply = '';
        socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
        socket.on('data', (chunk) => (reply += chunk));
        socket.on('end', () => resolve(JSON.parse(reply)));
        socket.on('error', reject);
      });
    assert.deepEqual(await ask({ type: 'probe' }), { code: 0, body: { echo: { type: 'probe' } } });
    assert.deepEqual(await ask({ type: 'read.graphql' }), { code: 0, body: { echo: { type: 'read.graphql' } } });
    assert.equal(requests, 2);
  } finally {
    await relay.close();
    await new Promise((resolve) => inner.close(resolve));
  }
  assert.equal(fs.existsSync(publicPath), false);
});

test('SC11 tick：写闸总开关关着 → 验收轮、修正轮都不起，不 abort、不写提醒，心跳记 gate: disabled', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  fs.writeFileSync(
    path.join(home, 'config', 'host.json'),
    JSON.stringify({ piCommand: ['pi'], prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } }),
  );
  const startedPrbot = [];
  const started = [];
  const aborted = [];
  const poll = [
    { issue: ROOT_REF, kind: 'standalone', tier: 'auto', fork: false, nextRound: 2, bodyVersion: `sha256:${'c'.repeat(64)}` },
    { issue: `${REPO}#9`, round: 1, stale: true, lastProgressAt: '2026-10-24T01:00:00.000Z' },
  ];
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async () => ({ code: 0, stdout: JSON.stringify(poll), stderr: '' }),
    spawnRound: (issue) => {
      started.push(issue);
      return 1;
    },
    runRound: async (argv) => {
      aborted.push(argv);
      return { code: 4, stdout: '', stderr: 'gate-disabled' };
    },
    spawnPrbot: (issue) => {
      startedPrbot.push(issue);
      return 2;
    },
    discoverPrbot: async () => [{ issue: `${REPO}#10` }],
    checkPrbotStalled: async () => [],
    cleanupPrbot: () => [],
    notify: async () => ({ ok: true }),
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(heartbeat.gate, 'disabled');
  assert.deepEqual(startedPrbot, [], '修正轮也不起');
  assert.equal(heartbeat.lastTick.ok, true);
  assert.deepEqual(started, []);
  assert.deepEqual(aborted, []);
  assert.deepEqual(heartbeat.lastTick.started, []);
  assert.equal(heartbeat.lastTick.stale[0]?.aborted, false);
  assert.deepEqual(readAlerts(hostPaths(home)), []);
});

test('SC11 认领被写闸拒绝（4）：不跑模型，写一条提醒', async () => {
  const fixture = roundFixture();
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    prefetch: fixture.prefetchFake,
    runRound: async (argv) => {
      fixture.calls.round.push(argv);
      return { code: 4, stdout: '', stderr: '写闸拒绝：gate-disabled' };
    },
    startGate: fixture.startGateFake,
    spawnPi: hangingPi(fixture.calls).spawnPi,
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
  fs.mkdirSync(hostPaths(home).gateDir, { recursive: true });
  fs.writeFileSync(hostPaths(home).enabledFile, '1');
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
  assert.equal(heartbeat.gate, 'enabled');
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

test('SC11 同一个仓两个总 issue 的同号轮次：roundDir、登记文件名各不相同（不会共用 socket、互相覆盖 pi.log）', () => {
  const paths = hostPaths(tmpDir());
  const first = `${REPO}#1`;
  const second = `${REPO}#2`;
  assert.notEqual(roundKey(first, 1), roundKey(second, 1));
  assert.notEqual(roundDirFor(paths, first, 1), roundDirFor(paths, second, 1));
  assert.notEqual(roundDirFor(paths, first, 1), roundDirFor(paths, first, 2));
  assert.match(path.basename(roundDirFor(paths, second, 1)), /__2__1$/);
});

test('裁决防线：pi 退出时这一轮是「中断」且原因是环境问题（必需检查没跑）→ 写一条 env-unverified 提醒，不 abort', async () => {
  const reason = `${ENV_PROBLEM_PREFIX}必需检查因环境原因没跑：测试。这一轮未验证，不判「通过」`;
  const fixture = roundFixture({ status: { round: 1, status: '中断', reason } });
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: exitingPi(fixture.calls, 0),
    meminfoPath: writeMeminfo(),
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(fixture.calls.round.some((argv) => argv[0] === 'abort'), false);
  const alerts = readAlerts(hostPaths(fixture.home));
  assert.equal(alerts.length, 1, JSON.stringify(alerts));
  assert.equal(alerts[0].kind, 'env-unverified');
  assert.equal(alerts[0].issue, ROOT_REF);
  assert.equal(alerts[0].reason, reason);
});

test('裁决防线：别的原因的「中断」（不是环境问题）不写 env-unverified', async () => {
  const fixture = roundFixture({ status: { round: 1, status: '中断', reason: '写闸拒绝：denied' } });
  await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: exitingPi(fixture.calls, 0),
    meminfoPath: writeMeminfo(),
    log: () => {},
  });
  assert.equal(readAlerts(hostPaths(fixture.home)).some((a) => a.kind === 'env-unverified'), false);
});

// build 项 CI 口径（host/build-ci.mjs）接进派发消息：口径关着时消息一字不差；开着时追加宿主只读查到的 CI 事实。
function recordingPi(calls, written) {
  return (options) => {
    calls.pi.push(options);
    return {
      pid: 555020,
      stdin: {
        write(chunk) {
          written.push(String(chunk));
        },
        end() {},
      },
      kill() {},
      exit: Promise.resolve({ code: 0 }),
    };
  };
}

test('build 项 CI 口径没配：派发消息和以前一字不差，也不多查 GitHub', async () => {
  const fixture = roundFixture({ status: { round: 1, status: '要修' } });
  const written = [];
  const seen = [];
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    buildCi: async (options) => {
      seen.push(options);
      return collectBuildCiFacts({ ...options, github: { graphql: async () => assert.fail('不该查 GitHub') } });
    },
    spawnPi: recordingPi(fixture.calls, written),
    meminfoPath: writeMeminfo(),
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].issue, ROOT_REF);
  // 和接入口径之前的拼法完全一样：appendDepsInfo(appendCodePaths(...))，再加 pi 输入末尾的换行。
  assert.equal(written.join(''), `${appendDepsInfo(appendCodePaths(fixture.message, []), [])}\n`);
});

test('build 项 CI 口径开着：派发消息末尾追加 CI 事实；查 CI 出错不影响本轮，按「取不到」写', async () => {
  for (const mode of ['green', 'throws']) {
    const fixture = roundFixture({ status: { round: 1, status: '要修' } });
    const hostFile = path.join(fixture.home, 'config', 'host.json');
    const host = JSON.parse(fs.readFileSync(hostFile, 'utf8'));
    host.buildCiPolicy = {
      [REPO]: { bundleStep: 'node scripts/bundle.mjs', ciChecks: { build: ['verify-checks'], test: ['verify'] } },
    };
    fs.writeFileSync(hostFile, JSON.stringify(host));
    const written = [];
    const code = await runHostRound({
      home: fixture.home,
      issue: ROOT_REF,
      run: BWRAP_OK,
      runRound: fixture.runRoundFake,
      startGate: fixture.startGateFake,
      prefetch: fixture.prefetchFake,
      buildCi: async (options) => {
        assert.deepEqual(options.hostConfig.buildCiPolicy, host.buildCiPolicy);
        if (mode === 'throws') throw new Error('意外出错');
        return {
          repo: REPO,
          bundleStep: 'node scripts/bundle.mjs',
          ciChecks: { build: ['verify-checks'], test: ['verify'] },
          prs: [],
          status: 'green',
        };
      },
      spawnPi: recordingPi(fixture.calls, written),
      meminfoPath: writeMeminfo(),
      log: () => {},
    });
    assert.equal(code, 0, mode);
    const message = written.join('');
    assert.ok(message.startsWith(fixture.message), mode);
    assert.match(message, /build 项 CI 口径/);
    assert.match(message, mode === 'green' ? /CI 结论：绿/ : /CI 结论：取不到/);
    if (mode === 'throws') assert.match(message, /意外出错/);
  }
});

// #149：pi.log 不长、写闸没请求，但沙箱里在跑长命令（npm → vitest）时不该判卡住。
function stallRun(fixture, { spawnPi, probeActivity, statusIntervalMs = 10, now, runRound = fixture.runRoundFake }) {
  return runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: BWRAP_OK,
    runRound,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi,
    probeActivity,
    now,
    meminfoPath: writeMeminfo(),
    statusIntervalMs,
    killGraceMs: 20,
    log: () => {},
  });
}

function watchProgress(fixture) {
  const progress = progressFileFor(hostPaths(fixture.home), ROOT_REF, 1);
  const seen = [];
  const timer = setInterval(() => {
    try {
      seen.push(JSON.parse(fs.readFileSync(progress, 'utf8')));
    } catch {
      // 还没写或已删。
    }
  }, 15);
  return { seen, stop: () => clearInterval(timer) };
}

test('#149 SC1 pi.log 不长、写闸没请求，但 pi 进程树 CPU 在涨：不判卡住，activitySource=cpu；CPU 停了才判（#158：假时钟，不靠墙钟）', { timeout: 10000 }, async () => {
  const fixture = roundFixture({ profile: { stallMinutes: 0.003 } });
  const pi = hangingPi(fixture.calls);
  // #158：以前按墙钟断言「至少 600+180ms」，最后一拍可能落在 600ms 前一个间隔（如 591ms），
  // CI 稍慢就会 773/778ms < 780ms 偶发红。这里让注入时钟只在探针里走，最后一拍和 stallMinutes
  // 都按同一套逻辑时间算，和 CI 调度快慢无关。
  let clock = Date.parse('2026-11-01T00:00:00.000Z');
  let activeTicks = 0;
  let lastActiveMs = null;
  let abortedMs = null;
  const progressFile = progressFileFor(hostPaths(fixture.home), ROOT_REF, 1);
  const sources = new Set();
  let lastProgress = null;
  const probeActivity = ({ piPid }) => {
    assert.equal(piPid, 555001);
    clock += 10;
    try {
      const written = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      lastProgress = written;
      if (written.activitySource) sources.add(written.activitySource);
    } catch {
      // 这一拍还没写（第一拍只记基线）。
    }
    if (activeTicks < 50) {
      activeTicks += 1;
      lastActiveMs = clock;
      return { cpuTicks: activeTicks, filesMtimeMs: 1 };
    }
    return { cpuTicks: activeTicks, filesMtimeMs: 1 };
  };
  const runRound = async (argv) => {
    if (argv[0] === 'abort') abortedMs = clock;
    return fixture.runRoundFake(argv);
  };
  const code = await stallRun(fixture, { spawnPi: pi.spawnPi, probeActivity, now: () => clock, runRound });
  assert.equal(code, 1);
  assert.ok(sources.has('cpu'), '进度文件记了活动来源 cpu');
  assert.equal(lastProgress?.piLogBytes, 0);
  assert.equal(lastProgress?.gateRequests, 0);
  assert.ok(lastActiveMs != null, '探针看到过 CPU 活动');
  assert.ok(abortedMs != null, 'CPU 停了之后要判卡住');
  assert.ok(abortedMs - lastActiveMs > 180, `最后活动后超过 stallMinutes 才判卡住：${abortedMs - lastActiveMs}ms`);
  const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
  assert.match(abort[abort.indexOf('--reason') + 1], /卡住：超过 stallMinutes 没有进度/);
  assert.ok(readAlerts(hostPaths(fixture.home)).some((entry) => entry.kind === 'round-stalled'));
});

test('#149 SC2 沙箱 home/.npm/_logs 有新文件（默认探针、真目录）：不判卡住，activitySource=files', { timeout: 10000 }, async () => {
  const fixture = roundFixture({ profile: { stallMinutes: 0.003 } });
  const pi = hangingPi(fixture.calls);
  let timer;
  const spawnPi = (options) => {
    const handle = pi.spawnPi(options);
    const logs = path.join(options.cwd, 'home', '.npm', '_logs');
    fs.mkdirSync(logs, { recursive: true });
    let n = 0;
    timer = setInterval(() => {
      n += 1;
      if (n <= 20) fs.writeFileSync(path.join(logs, `debug-${n}.log`), 'x');
    }, 30);
    return handle;
  };
  const watch = watchProgress(fixture);
  const startedAt = Date.now();
  const code = await stallRun(fixture, { spawnPi, probeActivity: undefined });
  clearInterval(timer);
  watch.stop();
  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt >= 600 + 180, `卡住判得太早：${Date.now() - startedAt}ms`);
  assert.ok(watch.seen.some((entry) => entry.activitySource === 'files'), '进度文件记了活动来源 files');
});

test('#149 SC3 所有信号都不变：仍按 stallMinutes 判卡住、停 pi、abort、round-stalled', { timeout: 5000 }, async () => {
  const fixture = roundFixture({ profile: { stallMinutes: 0.003 } });
  const pi = hangingPi(fixture.calls);
  const startedAt = Date.now();
  const code = await stallRun(fixture, { spawnPi: pi.spawnPi, probeActivity: () => ({ cpuTicks: 42, filesMtimeMs: 7 }) });
  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt < 2000, '静止时按时判卡住');
  assert.deepEqual(pi.state.killed, ['SIGTERM']);
  assert.ok(readAlerts(hostPaths(fixture.home)).some((entry) => entry.kind === 'round-stalled'));
});

test('#149 SC4 CPU 一直在涨（空转）也挡不住总时长上限：到点 round-timeout', { timeout: 5000 }, async () => {
  const fixture = roundFixture({ profile: { stallMinutes: 0.003 } });
  fs.writeFileSync(path.join(fixture.home, 'config', 'host.json'), JSON.stringify({ piCommand: ['pi'], maxRoundMinutes: 0.01 }));
  const pi = hangingPi(fixture.calls);
  let ticks = 0;
  const startedAt = Date.now();
  const code = await stallRun(fixture, { spawnPi: pi.spawnPi, probeActivity: () => ({ cpuTicks: (ticks += 1), filesMtimeMs: 1 }) });
  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt >= 600);
  const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
  assert.equal(abort[abort.indexOf('--reason') + 1], '超过总时长上限（0.01 分钟）');
  const kinds = readAlerts(hostPaths(fixture.home)).map((entry) => entry.kind);
  assert.ok(kinds.includes('round-timeout'));
  assert.ok(!kinds.includes('round-stalled'));
});

test('#149 探针抛异常：不影响这一轮，静止时照常判卡住', { timeout: 5000 }, async () => {
  const fixture = roundFixture({ profile: { stallMinutes: 0.003 } });
  const pi = hangingPi(fixture.calls);
  const code = await stallRun(fixture, { spawnPi: pi.spawnPi, probeActivity: () => { throw new Error('boom'); } });
  assert.equal(code, 1);
  assert.ok(readAlerts(hostPaths(fixture.home)).some((entry) => entry.kind === 'round-stalled'));
});
