// #149：宿主读沙箱活动的两个信号（真 /proc、真目录）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { activityChange, newestMtimeMs, processTreeCpuTicks } from './host/activity.mjs';
import { tmpDir } from './fake-gh.fixture.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('#149 SC5 进程树 CPU：孙进程空转时根进程这棵树的时钟数在涨；进程没了返回 null', { timeout: 15000 }, async () => {
  // 根进程自己只 sleep，干活的是它的子进程（像 pi → bash → npm → vitest）。
  const inner = 'const end = Date.now() + 8000; while (Date.now() < end) {}';
  const outer = `const c = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(inner)}], { stdio: 'ignore' }); setTimeout(() => c.kill(), 9000);`;
  const root = spawn(process.execPath, ['-e', outer], { stdio: 'ignore' });
  try {
    await sleep(300);
    const first = processTreeCpuTicks(root.pid);
    assert.ok(Number.isInteger(first));
    await sleep(1200);
    const second = processTreeCpuTicks(root.pid);
    assert.ok(second > first, `子进程在吃 CPU，树的时钟数应变大：${first} → ${second}`);
  } finally {
    root.kill('SIGKILL');
  }
  await new Promise((resolve) => root.once('exit', resolve));
  assert.equal(processTreeCpuTicks(root.pid), null);
  assert.equal(processTreeCpuTicks(0), null);
});

test('#149 SC5 进程树 CPU：只数后代，不数别的进程；comm 带空格括号也能解析', () => {
  const proc = tmpDir();
  const stat = (pid, ppid, utime, comm = 'x') => {
    fs.mkdirSync(path.join(proc, String(pid)));
    fs.writeFileSync(path.join(proc, String(pid), 'stat'), `${pid} (${comm}) S ${ppid} 0 0 0 0 0 0 0 0 0 ${utime} 1 0 0 20 0 1 0 0`);
  };
  stat(10, 1, 5);
  stat(11, 10, 100, 'npm run (x) y');
  stat(12, 11, 1000);
  stat(20, 1, 99999);
  assert.equal(processTreeCpuTicks(10, { procDir: proc }), 5 + 1 + 100 + 1 + 1000 + 1);
});

test('#149 目录 mtime 浅扫：新文件让最新 mtime 变；目录不存在返回 null', async () => {
  const dir = tmpDir();
  assert.equal(newestMtimeMs([path.join(dir, 'nope')]), null);
  const before = newestMtimeMs([dir]);
  await sleep(20);
  fs.writeFileSync(path.join(dir, 'a.log'), 'x');
  assert.notEqual(newestMtimeMs([dir]), before);
});

test('#149 activityChange：第一拍只记基线；CPU 变大或文件 mtime 变才算', () => {
  assert.equal(activityChange(null, { cpuTicks: 1, filesMtimeMs: 1 }), null);
  assert.equal(activityChange({ cpuTicks: 1, filesMtimeMs: 1 }, { cpuTicks: 1, filesMtimeMs: 1 }), null);
  assert.equal(activityChange({ cpuTicks: 1, filesMtimeMs: 1 }, { cpuTicks: 2, filesMtimeMs: 1 }), 'cpu');
  assert.equal(activityChange({ cpuTicks: 1, filesMtimeMs: 1 }, { cpuTicks: 1, filesMtimeMs: 2 }), 'files');
  assert.equal(activityChange({ cpuTicks: null, filesMtimeMs: null }, { cpuTicks: null, filesMtimeMs: null }), null);
});
