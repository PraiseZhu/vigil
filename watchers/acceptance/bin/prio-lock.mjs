#!/usr/bin/env node
// 看板写入的共用锁：单条精确写入（bin/prio-item.mjs）与整盘持续写入共用同一个锁文件。
// 整盘那一侧不是 Node：部署里由 shell 包一层 `exec 8>/tmp/prio-write.lock; flock -n 8`，
// 所以「整盘在写」只能从外面看出来（bin/prio-run.mjs 自己不抢锁，#247 的 deploy-ff 也不碰这把锁）。
// 默认锁文件 /tmp/prio-write.lock 与整盘、与 #318 的 event-run 是同一个路径。
//
// 能做到的：
// - 探测整盘那把 flock 有没有人在用：/proc/locks 里列了它，或者有进程正开着这个文件（fd 形式也能看出来）。
//   探到忙就整条不写、不读，留给下一次事件或 30 分钟整盘。
// - 单条写入者之间真互斥：在同一路径上再拿一份持有者文件（`<锁文件>.item`，pid + 起始时间，进程死了算陈旧）。
//
// 做不到的（如实写在这里，不粉饰）：Node 没有 flock 接口，bin/ 下又不许起子进程，所以本文件
// 只能「探测」整盘那把锁，不能「持有」它。探测到空闲到真写之间有很窄的窗口，整盘那一拍可能正好在这时
// flock 成功。这个窗口的代价是两边各写一次同一个白名单字段，不是数据错乱；要真互斥得让整盘那一侧
// 换成读这把持有者文件，不在本次改动范围。
//
// #318（bin/event-run.mjs）里现在有一份同样判定的实现（writeLockHeld / acquireWriteLock）。
// 那两个函数和这里是同一套逻辑：合并时让 event-run 改成从本文件 import，删掉自己那份，不要两边各留一份。
import fs from 'node:fs';
import path from 'node:path';
import { releaseLock, tryAcquireLock } from '../host/paths.mjs';

/** 现有写入入口共用的写锁文件。 */
export const WRITE_LOCK_FILE = '/tmp/prio-write.lock';
export const LOCK_RETRY_MS = 2000;
export const LOCK_WAIT_MAX_MS = 10000;
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
 * 但持锁进程一定开着这个 fd，所以这一路能把整盘写入的锁看回来。
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
 * 拿着写锁跑 fn：先确认整盘那把 flock 空闲，再拿 <锁文件>.item 这份持有者文件（单条写入者之间互斥）。
 * 抢不到（整盘在写、或另一个单条写入者持有）按 retryMs 重试，最多等 maxWaitMs，
 * 仍抢不到返回 { acquired:false, reason:'lock-busy', detail }，由调用方决定「不写」还是「不确认这条事件」。
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
    if (!state.held && tryAcquire(markerFile, { now })) break;
    detail = state.held ? String(state.reason || 'held') : 'marker';
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
