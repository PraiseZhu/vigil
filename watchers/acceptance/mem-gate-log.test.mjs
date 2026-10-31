// #147：内存门「这一拍不认领」那行带 UTC 时间和可 grep 的标记，方便统计近 24 小时推迟次数。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runHostRound } from './host/round.mjs';

const ROOT_REF = 'PraiseZhu/vigil#1';
const FIXED = Date.parse('2026-10-31T20:00:00.000Z');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mg-')); }

async function gate(meminfoPath) {
  const home = tmp();
  const lines = [];
  const calls = [];
  const code = await runHostRound({
    home,
    issue: ROOT_REF,
    hostConfig: { piCommand: ['pi'] },
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runRound: async () => { calls.push('round'); return 0; },
    startGate: async () => { calls.push('gate'); return { stop() {} }; },
    prefetch: async () => { calls.push('prefetch'); },
    spawnPi: () => { calls.push('pi'); },
    meminfoPath,
    now: () => FIXED,
    log: (m) => lines.push(m),
  });
  return { code, lines, calls };
}

test('#147 SC1 内存不够：一行以 ISO 时间开头、带 mem-gate-defer availKiB，原中文说明保留，退出 3 不认领', async () => {
  const f = path.join(tmp(), 'meminfo');
  fs.writeFileSync(f, 'MemTotal: 16777216 kB\nMemAvailable: 1024 kB\n');
  const r = await gate(f);
  assert.equal(r.code, 3);
  assert.deepEqual(r.calls, []);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^2026-10-31T20:00:00\.000Z mem-gate-defer availKiB=1024 内存门：MemAvailable 1048576 字节 < 3221225472，这一拍不认领$/);
});

test('#147 SC2 读不到 MemAvailable：同样一行，availKiB=unknown', async () => {
  const r = await gate(path.join(tmp(), 'missing'));
  assert.equal(r.code, 3);
  assert.equal(r.lines.length, 1);
  assert.match(r.lines[0], /^2026-10-31T20:00:00\.000Z mem-gate-defer availKiB=unknown 内存门：读不到 MemAvailable，按不够处理$/);
});
