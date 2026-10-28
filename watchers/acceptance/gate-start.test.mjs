// 起写闸 serve 时等多久、等不到时怎么说（写闸起不来）：等待上限可注入，默认 60 秒；
// 等不到 socket 时分清「等待超时」和「子进程已经退出」，后者带退出码和 gate.log 末几行（令牌抹掉）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnDetached } from './host/proc.mjs';
import { GATE_START_TIMEOUT_MS, defaultStartGate } from './host/round.mjs';
import { tmpDir } from './fake-gh.fixture.mjs';

const FAKE_TOKEN = `ghp_${'A'.repeat(36)}`;

/** 不起真的 write-gate.mjs，换成一段脚本（stdio 照样写进 gate.log）。 */
function spawnScript(script) {
  return (cmd, args, options) => spawnDetached(process.execPath, ['-e', script], options);
}

function gateOptions(extra = {}) {
  const base = tmpDir();
  return {
    home: base,
    socketPath: path.join(base, 's', 'g.sock'),
    logFile: path.join(base, 'gate.log'),
    binding: { root: 'owner/repo#1', round: 1, commentId: 1 },
    env: process.env,
    repoRoot: base,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ...extra,
  };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('写闸启动等待上限默认 60 秒', () => {
  assert.equal(GATE_START_TIMEOUT_MS, 60000);
});

test('不传等待上限时按 60 秒等；等满还没 socket → 写明「等了 60 秒没等到 socket（等待超时）」并杀掉子进程', async () => {
  let fakeNow = 1_000_000;
  let pid;
  const spawn = (cmd, args, options) => {
    const child = spawnScript('setTimeout(() => {}, 600000)')(cmd, args, options);
    pid = child.pid;
    return child;
  };
  const started = Date.now();
  await assert.rejects(
    defaultStartGate(
      gateOptions({
        spawn,
        clock: () => fakeNow,
        // 假时钟：每次「睡」都把时钟往前拨，不真等 60 秒。
        sleep: async (ms) => {
          fakeNow += ms;
          await new Promise((resolve) => setImmediate(resolve));
        },
      }),
    ),
    (error) => {
      assert.match(error.message, /写闸 serve 没起来/);
      assert.match(error.message, /等了 60 秒没等到/);
      assert.match(error.message, /等待超时/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10000, '不应真的等 60 秒');
  const until = Date.now() + 3000;
  while (isAlive(pid) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isAlive(pid), false, '超时后子进程应被杀掉');
});

test('等待上限可注入：startTimeoutMs=300 时 0.3 秒就放弃', async () => {
  await assert.rejects(
    defaultStartGate(gateOptions({ spawn: spawnScript('setTimeout(() => {}, 600000)'), startTimeoutMs: 300 })),
    /等了 0\.3 秒没等到 socket（等待超时）/,
  );
});

test('子进程先退出了 → 不等满上限，写明已经退出、退出码和 gate.log 末几行，令牌被抹掉', async () => {
  const script = [
    "console.error('第一行');",
    `console.error('写闸启动失败：Post "https://api.github.com/graphql": net/http: TLS handshake timeout ${FAKE_TOKEN}');`,
    'process.exit(3);',
  ].join('\n');
  const started = Date.now();
  await assert.rejects(
    defaultStartGate(gateOptions({ spawn: spawnScript(script) })),
    (error) => {
      assert.match(error.message, /写闸 serve 没起来/);
      assert.match(error.message, /子进程已经退出（退出码 3）/);
      assert.match(error.message, /TLS handshake timeout/);
      assert.doesNotMatch(error.message, /ghp_/);
      assert.doesNotMatch(error.message, /等待超时/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10000, '子进程退出后应马上放弃，不等满 60 秒');
});

test('socket 出现就算起来了，stop() 能停掉子进程', async () => {
  const options = gateOptions({});
  const script = `require('node:net').createServer().listen(${JSON.stringify(options.socketPath)});`;
  const gate = await defaultStartGate({ ...options, spawn: spawnScript(script) });
  assert.equal(gate.socketPath, options.socketPath);
  assert.equal(isAlive(gate.pid), true);
  await gate.stop();
  assert.equal(isAlive(gate.pid), false);
});
