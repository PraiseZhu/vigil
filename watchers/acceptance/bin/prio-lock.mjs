#!/usr/bin/env node
// 看板写入的共用锁：单条精确写入（bin/prio-item.mjs）与整盘持续写入共用同一个锁文件。
// 锁路径不变：`/tmp/prio-write.lock`（只给旧包装探测用）+ `<锁文件>.item`（双方真持有）。
// 整盘读阶段、判断阶段不持锁；只有「一条真写 + 本条回读 + 本条 debounce 合并」这一个短临界区拿 `.item`。
// 旧部署包装若仍 `exec 8>/tmp/prio-write.lock; flock -n 8` 握整拍，探测到 flock / 开着的 fd
// 就立即 `lock-busy`（不再干等），避免仓内按条抢锁却一条都写不进去。
//
// 能做到的：
// - 探测旧包装那把 flock 有没有人在用：/proc/locks 里列了它，或者有进程正开着这个文件（fd 形式也能看出来）。
//   探到忙立即返回 lock-busy，不读不写，不空等。
// - 写入者之间真互斥：整盘每写一条、单条每次写入都抢同一份持有者文件
//   （`<锁文件>.item`，pid + 起始时间，进程死了算陈旧）。只有 `.item` 被另一个写入者占着才按 retryMs 重试。
//
// 单条等待上限仍是 LOCK_WAIT_MAX_MS（10 秒）；整盘按条等待上限是 BOARD_LOCK_WAIT_MAX_MS（30 秒）。
// 抢不到返回 { acquired:false, reason:'lock-busy', detail }，由调用方决定跳过本条还是不确认这条事件。
import fs from 'node:fs';
import path from 'node:path';
import { releaseLock, tryAcquireLock } from '../host/paths.mjs';

/** 现有写入入口共用的写锁文件。 */
export const WRITE_LOCK_FILE = '/tmp/prio-write.lock';
export const LOCK_RETRY_MS = 2000;
export const LOCK_WAIT_MAX_MS = 10000;
/** 整盘按条抢 `.item` 的等待上限：抢不到就跳过这一条、本拍不 abort。 */
export const BOARD_LOCK_WAIT_MAX_MS = 30000;
/** 单条写入者之间互斥用的持有者文件后缀：`<锁文件>.item`。 */
export const MARKER_SUFFIX = '.item';

/** 一条 /proc/locks 行的设备号写法：major:minor 各自 %02x。 */
function deviceKey(stat) {
  const value = BigInt(stat.dev);
  const major = ((value >> 8n) & 0xfffn).toString(16).padStart(2, '0');
  const minor = ((value & 0xffn) | ((value >> 12n) & ~0xffn)).toString(16).padStart(2, '0');
  return `${major}:${minor}:${stat.ino}`;
}

/** /proc/locks 里是否已经列了这一条（file 形式的 flock 会列出来）。 */
function listedInProcLocks(stat, { procLocksFile, fsImpl }) {
  let text;
  try {
    text = fsImpl.readFileSync(procLocksFile, 'utf8');
  } catch {
    return null;
  }
  const key = deviceKey(stat);
  for (const line of String(text).split('\n')) {
    const parts = line.trim().split(/\s+/);
    // 一行形如「12: FLOCK ADVISORY WRITE 3456 fe:10:7307 0 EOF」
    if (parts.length < 6) continue;
    if (parts[5] === key) return true;
  }
  return false;
}

/**
 * 有进程把这个锁文件开着吗：扫 /proc/<pid>/fd 的软链接。
 * 实测：`exec 8>锁文件; flock -n 8` 这种 fd 形式的 flock 不会出现在 /proc/locks 里，
 * 但持锁进程一定开着这个 fd，所以这一路能把旧包装的整拍锁看回来。
 * 代价：把「开着文件但没加锁」也算成忙（宁可少写一次，也不少锁一次）。
 */
function openedBySomeProcess(file, { procDir, fsImpl }) {
  let target;
  try {
    target = fsImpl.realpathSync(file);
  } catch {
    return null;
  }
  let pids;
  try {
    pids = fsImpl.readdirSync(procDir);
  } catch {
    return null;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    const fdDir = path.join(procDir, pid, 'fd');
    let fds;
    try {
      fds = fsImpl.readdirSync(fdDir);
    } catch {
      // 别人的进程读不到 fd 目录，跳过。
      continue;
    }
    for (const fd of fds) {
      let link;
      try {
        link = fsImpl.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      if (link === target) return true;
    }
  }
  return false;
}

/**
 * 写锁探测：锁文件不存在 = 空闲；/proc/locks 列了它 = 被占；有进程开着它 = 被占。
 * 两条都读不到（非 Linux）时返回 known:false，由调用方自己决定怎么说。
 */
export function writeLockHeld({ file = WRITE_LOCK_FILE, procLocksFile = '/proc/locks', procDir = '/proc', fsImpl = fs } = {}) {
  let stat;
  try {
    stat = fsImpl.statSync(file);
  } catch {
    // 锁文件还不存在：没有持有者，也没人开始占。
    return { held: false, known: true, reason: 'missing' };
  }
  const listed = listedInProcLocks(stat, { procLocksFile, fsImpl });
  if (listed === true) return { held: true, known: true, reason: 'proc-locks' };
  const opened = openedBySomeProcess(file, { procDir, fsImpl });
  if (opened === true) return { held: true, known: true, reason: 'open-fd' };
  if (listed === null && opened === null) return { held: false, known: false, reason: 'no-proc' };
  return { held: false, known: true, reason: 'free' };
}

/**
 * 拿着写锁跑 fn：先确认旧包装那把 flock / 开着的 fd 空闲，再拿 <锁文件>.item 这份持有者文件。
 * flock 或开着的 fd 为真 → 立即 lock-busy，不按 retryMs 空等。
 * 只有 `.item` 被另一个写入者占着才按 retryMs 重试，最多等 maxWaitMs。
 * 仍抢不到返回 { acquired:false, reason:'lock-busy', detail }，由调用方决定「本条跳过」还是「不确认这条事件」。
 * 拿到就跑 fn，无论成败都释放持有者文件。
 * probe / tryAcquire / release / sleep / now 都可注入，测试里用假时钟和假锁。
 */
export async function withWriteLock(fn, {
  file = WRITE_LOCK_FILE,
  markerFile = `${file}${MARKER_SUFFIX}`,
  retryMs = LOCK_RETRY_MS,
  maxWaitMs = LOCK_WAIT_MAX_MS,
  probe = () => writeLockHeld({ file }),
  tryAcquire = tryAcquireLock,
  release = releaseLock,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  let detail = '';
  for (;;) {
    const state = probe() || { held: false, reason: '' };
    if (state.held) {
      const wait = Number(now()) - startedAt;
      return {
        acquired: false,
        reason: 'lock-busy',
        detail: String(state.reason || 'held'),
        waitedMs: wait,
      };
    }
    if (tryAcquire(markerFile, { now })) break;
    detail = 'marker';
    const wait = Number(now()) - startedAt;
    if (wait >= maxWaitMs) return { acquired: false, reason: 'lock-busy', detail, waitedMs: wait };
    await sleep(Math.min(retryMs, maxWaitMs - wait));
  }
  try {
    return { acquired: true, value: await fn() };
  } finally {
    release(markerFile);
  }
}
