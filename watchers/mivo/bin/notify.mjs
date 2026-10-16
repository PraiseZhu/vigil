#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

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
// Its pid is in the file; once that process is gone the lock is removed, unless another writer
// replaced it in the meantime. An unreadable lock counts as dead after 30 seconds.
function reclaimDeadNoticeLock(file) {
  let holder, stat;
  try { holder = fs.readFileSync(file, 'utf8'); stat = fs.statSync(file); } catch { return true; }
  const pid = Number(holder);
  let dead = false;
  if (Number.isSafeInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); } catch (error) { dead = error.code === 'ESRCH'; }
  } else dead = Date.now() - stat.mtimeMs > 30_000;
  if (!dead) return false;
  try { if (fs.readFileSync(file, 'utf8') === holder) fs.unlinkSync(file); } catch {}
  return true;
}

function withNoticeLock(home, fn) {
  const file = lockPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const started = Date.now();
  while (true) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      try { return fn(); }
      finally { try { fs.unlinkSync(file); } catch {} }
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
