#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';

const PROTOCOL = 'cindy-script/1';

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function requireAbs(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function noticesDir(home) {
  return path.join(requireAbs(home, 'home'), 'state', 'notices');
}

function pendingPath(home) { return path.join(noticesDir(home), 'pending.json'); }
function sentPath(home) { return path.join(noticesDir(home), 'sent.json'); }
function lockPath(home) { return path.join(noticesDir(home), 'pending.lock'); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

// A writer killed while holding the lock (timeout, SIGKILL, reboot) never reaches its finally.
// The lock holds "<pid> <token>"; once that pid is gone the lock is removed. Checking the
// holder and unlinking it is not atomic, so it runs under a second, short-lived reclaim lock:
// a reclaimer that saw the dead lock earlier cannot delete a newer live lock taken meanwhile.
// An unreadable lock counts as dead after 30 seconds.
function holderDead(content, stat) {
  const pid = Number(String(content).split(' ')[0]);
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }
  return Date.now() - stat.mtimeMs > 30_000;
}
function readHolder(file) {
  try { return { content: fs.readFileSync(file, 'utf8'), stat: fs.statSync(file) }; } catch { return null; }
}
function reclaimDeadNoticeLock(file) {
  const seen = readHolder(file);
  if (!seen) return true;
  if (!holderDead(seen.content, seen.stat)) return false;
  const guard = `${file}.reclaim`;
  try { fs.writeFileSync(guard, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // The reclaim section is a few syscalls; only a reclaimer killed inside it leaves this file.
    const stale = readHolder(guard);
    if (stale && holderDead(stale.content, stale.stat) && Date.now() - stale.stat.mtimeMs > 5_000) {
      try { fs.unlinkSync(guard); } catch {}
    }
    return false;
  }
  try {
    const current = readHolder(file);
    if (!current) return true;
    if (current.content !== seen.content || !holderDead(current.content, current.stat)) return false;
    fs.unlinkSync(file);
    return true;
  } finally { try { fs.unlinkSync(guard); } catch {} }
}

function releaseNoticeLock(file, token) {
  try { if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file); } catch {}
}

function withNoticeLock(home, fn) {
  const file = lockPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const token = `${process.pid} ${randomBytes(8).toString('hex')}`;
  const started = Date.now();
  while (true) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
      try { return fn(); }
      finally { releaseNoticeLock(file, token); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (reclaimDeadNoticeLock(file)) continue;
      if (Date.now() - started > 8000) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

export function noticeId(event = {}) {
  const number = event.number ?? 'unknown';
  if (event.kind === 'merge-ready') return `merge-ready:${number}:${event.head ?? ''}`;
  if (event.kind === 'keel-unavailable') return `keel-unavailable:${number}:${event.day ?? ''}`;
  if (event.kind === 'blocked-escalate') return `escalate:${number}:${event.head ?? ''}:${event.cause ?? event.blockedKind ?? ''}`;
  return `${event.kind}:${number}`;
}

export function pendingEvents(home) {
  const pending = readJson(pendingPath(home), { events: [] });
  const sent = new Set(readJson(sentPath(home), { ids: [] }).ids ?? []);
  return (pending.events ?? []).filter((event) => event && !sent.has(event.id ?? noticeId(event)));
}

export function enqueueNotice(home, event) {
  if (!event || typeof event !== 'object') return null;
  return withNoticeLock(home, () => {
    const id = event.id ?? noticeId(event);
    const sent = new Set(readJson(sentPath(home), { ids: [] }).ids ?? []);
    if (sent.has(id)) return null;
    const file = pendingPath(home);
    const pending = readJson(file, { events: [] });
    const events = Array.isArray(pending.events) ? pending.events : [];
    if (events.some((item) => (item.id ?? noticeId(item)) === id)) return id;
    events.push({ ...event, id, queuedAt: event.queuedAt ?? new Date().toISOString() });
    atomicJson(file, { events });
    return id;
  });
}

export function markNoticesSent(home, ids, at = new Date().toISOString()) {
  return withNoticeLock(home, () => {
    const wanted = new Set(ids);
    const file = pendingPath(home);
    const pending = readJson(file, { events: [] });
    const remaining = (pending.events ?? []).filter((event) => !wanted.has(event.id ?? noticeId(event)));
    atomicJson(file, { events: remaining });
    const sent = readJson(sentPath(home), { ids: [] });
    const next = [...new Set([...(sent.ids ?? []), ...ids])];
    atomicJson(sentPath(home), { ids: next, at });
  });
}

export function formatNoticeText(events = []) {
  return events.map((event) => {
    const number = event.number ?? '?';
    const url = event.url ? ` ${event.url}` : '';
    if (event.kind === 'merge-ready') {
      return `PR #${number}${url} 已经可以合并：必需检查全绿、讨论已处理。请打开链接手动点合并。`;
    }
    if (event.kind === 'keel-unavailable') {
      return `PR #${number}${url} 有待修复的反馈，但 Keel 台账读不到（${event.cause ?? 'ledger unreadable'}），本轮没有派发修复会话、没有扣轮次。请检查 keelLedgerRoot / keelNamespace 配置或 Keel 安装；恢复后盯梢会自动继续。`;
    }
    if (event.kind === 'blocked-escalate') {
      return `PR #${number}${url} 同一原因再次卡住（${event.cause ?? event.blockedKind ?? 'blocked'}），盯梢不再原样重投。请查看原因并处理。`;
    }
    const labels = {
      'needs-human': '需要人接手（无法自动确认修复会话）',
      'missing-result-limit': '修复会话三次补投都没有交回结果',
      'invalid-result': '修复会话交回的结果无效',
      'pending-dispatch-unknown': '派发修复会话后没有确认回执',
    };
    return `PR #${number}${url} ${labels[event.kind] ?? event.kind}。盯梢没有自动出口，请打开链接处理。`;
  }).join('\n\n');
}

export function checkNotices(home) {
  return pendingEvents(home).length > 0;
}

export function emitNotices(home, { at = new Date().toISOString() } = {}) {
  const events = pendingEvents(home);
  const resultText = events.length ? formatNoticeText(events) : '没有待发通知。';
  if (events.length) markNoticesSent(home, events.map((event) => event.id ?? noticeId(event)), at);
  return { protocol: PROTOCOL, type: 'complete', resultText, primarySessionId: null };
}

async function protocolEmit(home) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const first = await new Promise((resolve) => {
    rl.once('line', resolve);
  });
  const start = JSON.parse(first);
  if (!start || start.type !== 'start') fail('expected the host start frame');
  const frame = emitNotices(home);
  process.stdout.write(`${JSON.stringify({ protocol: start.protocol ?? PROTOCOL, ...frame })}\n`);
  rl.close();
}

function cli(argv) {
  const args = [...argv];
  const mode = args.find((item) => item === 'check' || item === 'emit');
  const homeIndex = args.indexOf('--home');
  const home = homeIndex >= 0 ? args[homeIndex + 1] : process.env.MIVO_WATCHER_HOME;
  if (!mode) fail('mode must be check or emit');
  if (!home) fail('--home is required');
  if (mode === 'check') {
    process.stdout.write('CINDY_PRECHECK_OK\n');
    if (!checkNotices(home)) process.exitCode = 2;
    return;
  }
  if (process.env.CINDY_SCRIPT_PROTOCOL === '1' || process.env.XDT_MAKER_SCRIPT_PROTOCOL === '1') {
    return protocolEmit(home);
  }
  const frame = emitNotices(home);
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

if (process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try {
    const result = cli(process.argv.slice(2));
    if (result && typeof result.then === 'function') result.catch((error) => {
      process.stderr.write(`mivo-notify: ${error.message}\n`);
      process.exitCode = Number(error.exitCode) || 1;
    });
  } catch (error) {
    process.stderr.write(`mivo-notify: ${error.message}\n`);
    process.exitCode = Number(error.exitCode) || 1;
  }
}
