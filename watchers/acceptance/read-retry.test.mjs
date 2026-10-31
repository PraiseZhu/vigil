#!/usr/bin/env node
// T23：读 GitHub 挂住（平台快照恢复后连接半死）时，杀掉整个进程组、用新进程重试一次只读；写不加超时、不重试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hostPaths, isAlive, readAlerts } from './host/paths.mjs';
import { run as procRun } from './host/proc.mjs';
import {
  POLL_TIMEOUT_MS,
  TICK_READ_TIMEOUT_MS,
  runTick,
  withReadTimeout,
} from './host/tick.mjs';
import { POLL_STALL_S } from './host/poll-beat.mjs';
import { tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const READ_Q = JSON.stringify({ query: 'query { viewer { login } }' });

test('T23 proc.run killGroup：超时后整组（含忽略 SIGTERM 的孙进程）都被杀掉，不留孤儿', async () => {
  const dir = tmpDir();
  const pidFile = path.join(dir, 'grandchild.pid');
  // 父 shell 起一个忽略 SIGTERM 的孙进程，自己也忽略 SIGTERM，然后都挂住。
  const script = `trap '' TERM; sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' & while :; do sleep 1; done`;
  const started = Date.now();
  const result = await procRun('sh', ['-c', script], { timeoutMs: 300, killGroup: true });
  assert.equal(result.code, 124);
  assert.ok(Date.now() - started < 4000, '超时 + 2 秒 SIGKILL 内收尾');
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
  await sleepMs(200);
  assert.equal(isAlive(grandchild), false, `孙进程 ${grandchild} 应已被整组杀掉`);
});

test('T23 只读挂住：杀掉后用新进程重试一次，重试成功就照常返回（不算失败）', async () => {
  const calls = [];
  const wrapped = withReadTimeout(async (cmd, args, opts) => {
    calls.push(opts);
    if (calls.length === 1) return { code: 124, stdout: '', stderr: '' };
    return { code: 0, stdout: '{"data":{}}', stderr: '' };
  }, 200);
  const result = await wrapped('gh', ['api', 'graphql', '--input', '-'], { input: READ_Q });
  assert.equal(result.code, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((o) => o.timeoutMs === 200 && o.killGroup === true), '每次读都带超时、整组杀');
});

test('T23 只读重试仍挂住：按读失败收尾（124），文字注明已重试一次；只重试一次', async () => {
  let n = 0;
  const wrapped = withReadTimeout(async () => {
    n += 1;
    return new Promise(() => {});
  }, 50);
  const result = await wrapped('gh', ['api', 'repos/o/r'], {});
  assert.equal(n, 2);
  assert.equal(result.code, 124);
  assert.match(result.stderr, /已重试一次/);
  assert.match(result.stderr, /exit 124/);
});

test('T23 写不重试、不加超时：mutation、POST、带 --input 的 REST、git 各只跑一次', async () => {
  const calls = [];
  const wrapped = withReadTimeout(async (cmd, args, opts) => {
    calls.push(opts?.timeoutMs);
    return { code: 124, stdout: '', stderr: '' };
  }, 50);
  await wrapped('gh', ['api', 'graphql', '--input', '-'], { input: JSON.stringify({ query: 'mutation { x }' }) });
  await wrapped('gh', ['api', '-X', 'POST', 'repos/o/r/issues'], {});
  await wrapped('gh', ['api', 'repos/o/r/issues', '--input', '-'], { input: '{}' });
  await wrapped('git', ['push'], {});
  assert.deepEqual(calls, [undefined, undefined, undefined, undefined]);
});

test('T23 总耗时上限：单次读 ×2 + 兜底 < 180 秒；拉取 ×2 + SIGKILL 宽限 < 180 秒', () => {
  const guard = Math.min(5000, TICK_READ_TIMEOUT_MS);
  assert.ok(2 * (TICK_READ_TIMEOUT_MS + guard) < POLL_STALL_S * 1000, `读：${TICK_READ_TIMEOUT_MS}`);
  assert.ok(2 * (POLL_TIMEOUT_MS + 2000) < POLL_STALL_S * 1000, `拉取：${POLL_TIMEOUT_MS}`);
});

function pollTick(home, pollResults) {
  const seen = [];
  const promise = runTick({
    home,
    env: { ...process.env },
    run: async (cmd, args, opts = {}) => {
      if (cmd === 'node' && String(args[0]).endsWith('poll.mjs')) {
        seen.push(opts);
        return pollResults.shift() || { code: 0, stdout: '[]', stderr: '' };
      }
      return { code: 0, stdout: '[]', stderr: '' };
    },
    spawnRound: () => 1,
    spawnPrbot: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  return { promise, seen };
}

test('T23 拉取超时：整组杀、重试一次；重试成功不写 tick-failed', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const { promise, seen } = pollTick(home, [{ code: 124, stdout: '', stderr: '' }, { code: 0, stdout: '[]', stderr: '' }]);
  const beat = await promise;
  assert.equal(seen.length, 2);
  assert.ok(seen.every((o) => o.timeoutMs === POLL_TIMEOUT_MS && o.killGroup === true));
  assert.equal(beat.lastTick.ok, true);
  assert.equal(readAlerts(hostPaths(home)).filter((a) => a.kind === 'tick-failed').length, 0);
});

test('T23 拉取重试仍失败：只写一条 tick-failed，注明已重试一次；非超时的失败不重试', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const { promise, seen } = pollTick(home, [{ code: 124, stdout: '', stderr: '' }, { code: 124, stdout: '', stderr: '' }]);
  await promise;
  assert.equal(seen.length, 2);
  const alerts = readAlerts(hostPaths(home)).filter((a) => a.kind === 'tick-failed');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].detail, /退出码 124/);
  assert.match(alerts[0].detail, /已重试一次/);

  const { home: home2 } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state2') } });
  const second = pollTick(home2, [{ code: 1, stdout: '', stderr: 'boom' }]);
  await second.promise;
  assert.equal(second.seen.length, 1, '非超时失败（退出码 1）不重试');
});

test('T23 重试成功不告警，但在 loop.log 留一行：读取超时已重试成功、类别、耗时', async () => {
  const lines = [];
  const wrapped = withReadTimeout(
    async (cmd, args, opts) => (lines.length === 0 && !wrapped.done ? ((wrapped.done = true), { code: 124, stdout: '', stderr: '' }) : { code: 0, stdout: '{}', stderr: '' }),
    200,
    { onRetryOk: (info) => lines.push(info) },
  );
  await wrapped('gh', ['api', 'repos/o/r'], {});
  assert.equal(lines.length, 1);
  assert.ok(Number.isFinite(lines[0].totalMs));

  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const { promise } = pollTick(home, [{ code: 124, stdout: '', stderr: '' }, { code: 0, stdout: '[]', stderr: '' }]);
  await promise;
  const log = fs.readFileSync(hostPaths(home).loopLog, 'utf8');
  assert.match(log, /^\S+Z read-retry-ok kind=poll totalMs=\d+ 读取超时已重试成功$/m);
  assert.equal(readAlerts(hostPaths(home)).filter((a) => a.kind === 'tick-failed').length, 0);
});
