import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  validationConfig, acquireValidationSlot, runStreaming,
} from './bin/mivo-validation-runtime.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('validationConfig: 默认值、env 覆盖、非法值 fail-closed', (t) => {
  const home = tmp(t);
  const env = { MIVO_WATCHER_HOME: home };
  assert.deepEqual(validationConfig({ env }), { concurrency: 2, stallMs: 600_000, timeoutMs: 3_600_000 });
  assert.equal(validationConfig({ env: { ...env, MIVO_VALIDATE_CONCURRENCY: '3' } }).concurrency, 3);
  assert.equal(validationConfig({ env: { ...env, MIVO_VALIDATE_STALL_MINUTES: '0.5' } }).stallMs, 30_000);
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    assert.throws(() => validationConfig({ env: { ...env, MIVO_VALIDATE_CONCURRENCY: bad } }), /validateConcurrency/, bad);
  }
  for (const bad of ['0', '-2', 'x', '']) {
    assert.throws(() => validationConfig({ env: { ...env, MIVO_VALIDATE_STALL_MINUTES: bad } }), /validateStallMinutes/, bad);
  }
});

test('validationConfig: profile 键被读取，显式空值与错误类型报错', (t) => {
  const home = tmp(t);
  fs.mkdirSync(path.join(home, 'config'));
  const write = (value) => fs.writeFileSync(path.join(home, 'config', 'profile.json'), JSON.stringify(value));
  const env = { MIVO_WATCHER_HOME: home };
  write({ validateConcurrency: 4, validateStallMinutes: 2 });
  const cfg = validationConfig({ env: { ...env, MIVO_WATCHER_HOME: home }, fresh: true });
  assert.equal(cfg.concurrency, 4);
  assert.equal(cfg.stallMs, 120_000);
  write({ validateConcurrency: '' });
  assert.throws(() => validationConfig({ env, fresh: true }), /validateConcurrency/);
  write({ validateConcurrency: null });
  assert.throws(() => validationConfig({ env, fresh: true }), /validateConcurrency/);
  write({ validateConcurrency: true });
  assert.throws(() => validationConfig({ env, fresh: true }), /validateConcurrency/);
});

test('并发 3 个 validate 争用同一 home、上限 2：峰值 2，第三个等槽位释放后运行', async (t) => {
  const home = tmp(t);
  let running = 0;
  let peak = 0;
  const order = [];
  const job = async (name, holdMs) => {
    const slot = await acquireValidationSlot({ home, limit: 2, pollMs: 20 });
    running++; peak = Math.max(peak, running); order.push(`start:${name}`);
    await sleep(holdMs);
    running--; order.push(`end:${name}`);
    slot.release();
  };
  await Promise.all([job('a', 150), job('b', 250), job('c', 50)]);
  assert.equal(peak, 2);
  assert.deepEqual(order.slice(0, 2), ['start:a', 'start:b']);
  assert.ok(order.indexOf('start:c') > order.indexOf('end:a'), order.join(','));
});

test('持有者进程已死的槽位会被回收，并杀掉遗留的进程组', async (t) => {
  const home = tmp(t);
  const slots = path.join(home, 'state', 'validations', 'slots');
  fs.mkdirSync(slots, { recursive: true });
  const dead = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => dead.on('exit', resolve));
  const orphan = spawn('/bin/sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' });
  orphan.unref();
  t.after(() => { try { process.kill(-orphan.pid, 'SIGKILL'); } catch {} });
  for (const index of [0, 1]) {
    fs.writeFileSync(path.join(slots, `slot-${index}.json`), JSON.stringify({
      pid: dead.pid, pgid: index === 0 ? orphan.pid : null, token: `old-${index}`, startedAt: new Date().toISOString(),
    }));
  }
  const a = await acquireValidationSlot({ home, limit: 2, pollMs: 20 });
  const b = await acquireValidationSlot({ home, limit: 2, pollMs: 20 });
  a.release(); b.release();
  await sleep(100);
  assert.equal(alive(orphan.pid), false, '遗留进程组应被终止');
});

test('runStreaming：持续输出不被杀，日志 0600 且完整保存 stdout 与 stderr', async (t) => {
  const dir = tmp(t);
  const logPath = path.join(dir, 'job.log');
  const script = "let i=0;const t=setInterval(()=>{process.stdout.write('out'+i+'\\n');process.stderr.write('err'+i+'\\n');if(++i>=6){clearInterval(t);}},100)";
  const result = await runStreaming(process.execPath, ['-e', script], { cwd: dir, env: process.env, logPath, stallMs: 400, timeoutMs: 10_000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.failureKind, null);
  const log = fs.readFileSync(logPath, 'utf8');
  for (let i = 0; i < 6; i++) { assert.match(log, new RegExp(`out${i}\\n`)); assert.match(log, new RegExp(`err${i}\\n`)); }
  assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
});

test('runStreaming：静默超过阈值被终止，原因是 validate-stalled 而非测试失败', async (t) => {
  const dir = tmp(t);
  const logPath = path.join(dir, 'stall.log');
  const result = await runStreaming(process.execPath, ['-e', "process.stdout.write('hello\\n');setTimeout(()=>{},60000)"],
    { cwd: dir, env: process.env, logPath, stallMs: 300, timeoutMs: 30_000 });
  assert.equal(result.failureKind, 'validate-stalled');
  assert.notEqual(result.exitCode, 0);
  assert.match(fs.readFileSync(logPath, 'utf8'), /hello/);
});

test('runStreaming：总超时独立记 validate-timeout，且整个进程组（含孙进程）被终止', async (t) => {
  const dir = tmp(t);
  const pidFile = path.join(dir, 'grandchild.pid');
  const script = `const {spawn}=require('child_process');const c=spawn('sleep',['60'],{stdio:'ignore'});require('fs').writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>process.stdout.write('.'),50)`;
  const result = await runStreaming(process.execPath, ['-e', script],
    { cwd: dir, env: process.env, logPath: path.join(dir, 't.log'), stallMs: 5_000, timeoutMs: 600 });
  assert.equal(result.failureKind, 'validate-timeout');
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  await sleep(200);
  assert.equal(alive(grandchild), false);
});
