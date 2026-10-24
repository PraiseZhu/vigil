#!/usr/bin/env node
// validate 的运行时：配置、并发槽位、流式日志、无输出看门狗。与 cindy 侧同名模块各自独立实现。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { _resetProfileCacheForTests, optionalConfigStrict, watcherHome } from './profile.mjs';

const MAX_TIMER_MS = 2_147_483_647;
const SLOT_INIT_GRACE_MS = 30_000;
const KILL_GRACE_MS = 5_000;

function positiveNumber(value, key, { integer = false } = {}) {
  let number;
  if (typeof value === 'number') number = value;
  else if (typeof value === 'string' && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) number = Number(value.trim());
  else number = NaN;
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isSafeInteger(number))) {
    throw new Error(`${key} must be a ${integer ? 'positive integer' : 'finite number greater than 0'}`);
  }
  return number;
}

function minutesToMs(value, key) {
  const ms = Math.round(positiveNumber(value, key) * 60_000);
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > MAX_TIMER_MS) throw new Error(`${key} must convert to 1..${MAX_TIMER_MS} milliseconds`);
  return ms;
}

/** 并发上限、无输出阈值、总超时。非法值 fail-closed，缺失才取默认。 */
export function validationConfig({ env = process.env, fresh = false } = {}) {
  if (fresh) _resetProfileCacheForTests();
  const concurrency = positiveNumber(optionalConfigStrict('validateConcurrency', {
    env, envVar: 'MIVO_VALIDATE_CONCURRENCY', fallback: 2,
  }), 'validateConcurrency', { integer: true });
  const stallMs = minutesToMs(optionalConfigStrict('validateStallMinutes', {
    env, envVar: 'MIVO_VALIDATE_STALL_MINUTES', fallback: 10,
  }), 'validateStallMinutes');
  const timeoutMs = minutesToMs(optionalConfigStrict('preflightTimeoutMinutes', {
    env, envVar: 'MIVO_PREFLIGHT_TIMEOUT_MINUTES', fallback: 60,
  }), 'preflightTimeoutMinutes');
  return { concurrency, stallMs, timeoutMs };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function groupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid < 2) return false;
  try { process.kill(-pgid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function killGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid < 2) return;
  try { process.kill(-pgid, signal); } catch {}
}

function readSlot(file) {
  try { return { slot: JSON.parse(fs.readFileSync(file, 'utf8')), mtimeMs: fs.statSync(file).mtimeMs }; }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch {}
    return { slot: null, mtimeMs };
  }
}

// 持有者进程已死：先终止它遗留的进程组，确认整组消失后才回收槽位文件。
async function reclaimIfStale(file) {
  const read = readSlot(file);
  if (!read) return true;
  const { slot, mtimeMs } = read;
  if (!slot) return Date.now() - mtimeMs > SLOT_INIT_GRACE_MS && removeSlot(file, null);
  if (pidAlive(slot.pid)) return false;
  if (groupAlive(slot.pgid)) {
    killGroup(slot.pgid, 'SIGTERM');
    const deadline = Date.now() + KILL_GRACE_MS;
    while (groupAlive(slot.pgid) && Date.now() < deadline) await sleep(50);
    if (groupAlive(slot.pgid)) killGroup(slot.pgid, 'SIGKILL');
    await sleep(50);
    if (groupAlive(slot.pgid)) return false;
  }
  return removeSlot(file, slot.token);
}

// rename 是原子的：只有一个回收者能拿到文件；拿到后确认 token 仍是被判死的那个，不是则放回。
function removeSlot(file, token) {
  const stash = `${file}.reclaim-${randomUUID()}`;
  try { fs.renameSync(file, stash); } catch { return true; }
  let moved = null;
  try { moved = JSON.parse(fs.readFileSync(stash, 'utf8')); } catch {}
  if (token !== null && moved?.token !== token) {
    try { if (!fs.existsSync(file)) fs.renameSync(stash, file); else fs.rmSync(stash, { force: true }); } catch {}
    return false;
  }
  fs.rmSync(stash, { force: true });
  return true;
}

/**
 * 占用 validate 槽位；无空位就等待（排队不是失败）。同 home 活跃槽位数不超过 limit。
 * 返回 { release(), setGroup(pgid) }。release 只在 token 相符时删除。
 */
export async function acquireValidationSlot({ home, limit, pollMs = 250, signal } = {}) {
  const dir = path.join(home, 'state', 'validations', 'slots');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  for (;;) {
    if (signal?.aborted) throw new Error('validate slot wait aborted');
    const files = fs.readdirSync(dir).filter((name) => /^slot-\d+\.json$/.test(name));
    let live = 0;
    for (const name of files) { if (!(await reclaimIfStale(path.join(dir, name)))) live++; }
    if (live < limit) {
      for (let index = 0; index < limit; index++) {
        const file = path.join(dir, `slot-${index}.json`);
        try {
          fs.writeFileSync(file, JSON.stringify({ pid: process.pid, pgid: null, token, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if (error.code === 'EEXIST') continue;
          throw error;
        }
        const write = (patch) => {
          const read = readSlot(file);
          if (read?.slot?.token !== token) return;
          fs.writeFileSync(file, JSON.stringify({ ...read.slot, ...patch }), { mode: 0o600 });
        };
        return {
          file, token,
          setGroup: (pgid) => write({ pgid }),
          release: () => { if (readSlot(file)?.slot?.token === token) fs.rmSync(file, { force: true }); },
        };
      }
    }
    await sleep(pollMs + Math.floor(Math.random() * Math.min(pollMs, 50)));
  }
}

/**
 * 在独立进程组里运行命令，stdout/stderr 按到达顺序流式写入 0600 日志。
 * 任一字节输出刷新无输出计时；超过 stallMs 判 validate-stalled，超过 timeoutMs 判 validate-timeout，
 * 两者都终止整个进程组。正常的非零退出作为结果返回而不是抛错。
 */
export function runStreaming(binary, args, { cwd, env, logPath, stallMs, timeoutMs, onGroup } = {}) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(logPath, 'wx', 0o600);
  return new Promise((resolve) => {
    let failureKind = null;
    let settled = false;
    let ioError = null;
    const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const pgid = child.pid;
    if (onGroup && pgid) onGroup(pgid);
    const terminate = (kind) => {
      if (failureKind) return;
      failureKind = kind;
      killGroup(pgid, 'SIGTERM');
      setTimeout(() => killGroup(pgid, 'SIGKILL'), KILL_GRACE_MS).unref();
    };
    let stallTimer;
    const armStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => terminate('validate-stalled'), stallMs);
    };
    const totalTimer = setTimeout(() => terminate('validate-timeout'), timeoutMs);
    armStall();
    const write = (chunk) => {
      armStall();
      try { fs.writeSync(fd, chunk); }
      catch (error) { ioError ??= error; terminate('validate-spawn-error'); }
    };
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    const finish = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer); clearTimeout(totalTimer);
      // 命令本身退出后，组内遗留的孙进程也一并收掉，避免占着槽位外的 CPU。
      killGroup(pgid, 'SIGKILL');
      try { fs.closeSync(fd); } catch {}
      resolve({
        exitCode: failureKind || spawnError || ioError ? (exitCode === 0 ? null : exitCode) : exitCode,
        signal: signal ?? null,
        failureKind: spawnError ? 'validate-spawn-error' : failureKind,
        logPath, error: spawnError?.message ?? ioError?.message ?? null,
      });
    };
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}

export { watcherHome };
