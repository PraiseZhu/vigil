#!/usr/bin/env node
// validate 的证据层：运行指纹、失败集合解析与比较、通过收据复用缓存。
// 与 cindy 侧同名模块各自独立实现，两侧不互相 import。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PARSER_VERSION = 1;
const sha = (value) => createHash('sha256').update(value).digest('hex');

/** 同条件复用与基线比较共用的运行指纹。lockfile 缺失记 null，读取权限类错误直接抛出。 */
export function canonicalRuntime({ worktree, tmpdir = os.tmpdir() } = {}) {
  let packageLockSha256 = null;
  try { packageLockSha256 = sha(fs.readFileSync(path.join(worktree, 'package-lock.json'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return {
    platform: process.platform, arch: process.arch, node: process.version,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    tmpdir: fs.realpathSync(tmpdir), packageLockSha256,
  };
}

export function runtimeSha256(runtime) {
  const { platform, arch, node, uid, tmpdir, packageLockSha256 } = runtime;
  return sha(JSON.stringify({ platform, arch, node, uid, tmpdir, packageLockSha256 }));
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const MARKER = /^\[preflight\] ❌ (.+?) 失败\s*$/;
const FAIL_TEST = /^\s*FAIL\s+(\S+)\s+>\s+(.+?)\s*$/;
const FAIL_OTHER = /^\s*FAIL\s/;
const TESTS_FAILED = /^\s*Tests\s+(\d+) failed/;
const STACK = /^\s*(?:❯|at\s)/;
const SECTION_END = /^\s*(?:⎯{3,}|Test Files\b|Tests\s)/;

const unparsed = (reason) => ({ state: 'unparsed', failureSet: [], failureSetSha256: null, reason });

export function canonicalFailureSet(items) {
  const keyOf = (item) => JSON.stringify([item.step, item.file, item.test, item.errorSha]);
  const unique = new Map();
  for (const item of items) unique.set(keyOf(item), { step: item.step, file: item.file, test: item.test, errorSha: item.errorSha });
  const failureSet = [...unique.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, item]) => item);
  return { failureSet, sha256: sha(JSON.stringify(failureSet.map((item) => [item.step, item.file, item.test, item.errorSha]))) };
}

export function emptyFailureSet() {
  const { failureSet, sha256 } = canonicalFailureSet([]);
  return { state: 'parsed', failureSet, failureSetSha256: sha256 };
}

function normalizeError(lines, worktree) {
  return lines.map((line) => {
    let out = line.replace(/\s+$/, '');
    if (worktree) out = out.split(worktree).join('<WT>');
    return out.replace(/:\d+:\d+(?=\)?$)/, '');
  }).join('\n');
}

/**
 * 解析一次「失败的」hook/vitest 输出。只有全部失败块都被覆盖、尾标记与失败计数一致时才给 parsed；
 * 其余（lint 报错、截断、未处理错误、计数对不上、缺断言信息）一律 unparsed。
 */
export function parseFailureSet(text, { worktree } = {}) {
  const lines = String(text ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  const bound = [];
  let pending = new Map();
  let claimed = null;
  let current = null;
  let markers = 0;
  let problem = null;
  const closeCurrent = () => { current = null; };
  for (const line of lines) {
    const marker = MARKER.exec(line);
    if (marker) {
      closeCurrent();
      markers++;
      if (pending.size === 0) { problem ??= `step ${marker[1]} failed without test failures`; continue; }
      if (claimed === null || claimed !== pending.size) { problem ??= 'failed test count does not match the summary'; }
      for (const entry of pending.values()) {
        if (!entry.errorLines.length) { problem ??= 'failed test has no assertion message'; continue; }
        bound.push({ step: marker[1], file: entry.file, test: entry.test, errorSha: sha(normalizeError(entry.errorLines, worktree)) });
      }
      pending = new Map();
      claimed = null;
      continue;
    }
    const fail = FAIL_TEST.exec(line);
    if (fail) {
      let file = fail[1];
      if (worktree && path.isAbsolute(file)) file = path.relative(worktree, file);
      if (path.isAbsolute(file) || file.startsWith('..')) { problem ??= 'failure file outside the worktree'; continue; }
      const key = `${file}\u0000${fail[2]}`;
      if (!pending.has(key)) pending.set(key, { file: file.split(path.sep).join('/'), test: fail[2], errorLines: [] });
      current = pending.get(key);
      current.collecting = !current.errorLines.length;
      continue;
    }
    if (FAIL_OTHER.test(line)) { closeCurrent(); problem ??= 'failure that is not a single test'; continue; }
    const count = TESTS_FAILED.exec(line);
    if (count) { claimed = Number(count[1]); closeCurrent(); continue; }
    if (/Unhandled (?:Rejection|Error)/i.test(line)) { problem ??= 'unhandled error in output'; continue; }
    if (SECTION_END.test(line)) { closeCurrent(); continue; }
    if (current?.collecting) {
      if (STACK.test(line)) { current.collecting = false; continue; }
      if (line.trim() === '' && !current.errorLines.length) continue;
      current.errorLines.push(line);
    }
  }
  for (const entry of pending.values()) { if (entry) { problem ??= 'failures not closed by a step marker'; break; } }
  if (!markers) problem ??= 'no preflight failure marker';
  for (const item of bound) { delete item.collecting; }
  if (problem) return unparsed(problem);
  if (!bound.length) return unparsed('no failures recognized');
  const { failureSet, sha256 } = canonicalFailureSet(bound);
  return { state: 'parsed', failureSet, failureSetSha256: sha256 };
}

const stateOf = (value) => value?.state ?? value?.failureSetState;
const tuple = (item) => JSON.stringify([item.step, item.file, item.test, item.errorSha]);

export function sameFailureSet(a, b) {
  if (stateOf(a) !== 'parsed' || stateOf(b) !== 'parsed') return false;
  if (!Array.isArray(a.failureSet) || !Array.isArray(b.failureSet)) return false;
  return canonicalFailureSet(a.failureSet).sha256 === canonicalFailureSet(b.failureSet).sha256;
}

/** PR 失败集合非空且每个元素（含 errorSha）都在基线集合里。任一方 unparsed/缺失都为 false。 */
export function isFailureSubset(pr, base) {
  if (stateOf(pr) !== 'parsed' || stateOf(base) !== 'parsed') return false;
  if (!Array.isArray(pr.failureSet) || !Array.isArray(base.failureSet) || pr.failureSet.length === 0) return false;
  const baseline = new Set(base.failureSet.map(tuple));
  return pr.failureSet.every((item) => baseline.has(tuple(item)));
}

// ---- 通过收据复用缓存 ----

export function passCacheKey(identity) {
  const { repo, nodeId, number, head, policySha256, runtimeSha256: runtime } = identity;
  return sha(JSON.stringify({ repo, nodeId, number, head, policySha256, runtimeSha256: runtime }));
}

function cacheFile(validations, identity) { return path.join(validations, 'pass-cache', `${passCacheKey(identity)}.json`); }

function contained(root, file) {
  try {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

/** 索引不可信：写入只是登记，复用时 lookupPass 会重新校验一切。临时文件名随机，不会被同进程并发覆盖。 */
export function publishPass({ validations, identity, receiptPath, receiptSha256 }) {
  const file = cacheFile(validations, identity);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${randomUUID()}`;
  fs.writeFileSync(temp, `${JSON.stringify({ key: passCacheKey(identity), identity, receiptPath, receiptSha256 })}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

/** 命中返回 { receipt, receiptPath, receiptSha256 }；任何不一致（损坏、缺失、不同条件）都返回 null。 */
export function lookupPass({ validations, identity }) {
  try {
    const index = JSON.parse(fs.readFileSync(cacheFile(validations, identity), 'utf8'));
    if (index.key !== passCacheKey(identity) || !path.isAbsolute(index.receiptPath)) return null;
    if (!contained(validations, index.receiptPath)) return null;
    const bytes = fs.readFileSync(index.receiptPath);
    if (sha(bytes) !== index.receiptSha256) return null;
    const receipt = JSON.parse(bytes);
    if (receipt.schemaVersion !== 2 || receipt.kind !== 'cindy-repair-validation' || receipt.validationEvidenceVersion !== 1) return null;
    if (receipt.status !== 'pass' || receipt.exitCode !== 0 || !receipt.command || receipt.reusedFrom) return null;
    if (receipt.repo !== identity.repo || receipt.nodeId !== identity.nodeId || receipt.number !== identity.number) return null;
    if (receipt.head !== identity.head || receipt.policy?.sha256 !== identity.policySha256 || receipt.runtimeSha256 !== identity.runtimeSha256) return null;
    if (typeof receipt.logPath !== 'string' || !contained(validations, receipt.logPath)) return null;
    if (sha(fs.readFileSync(receipt.logPath)) !== receipt.logSha256) return null;
    return { receipt, receiptPath: index.receiptPath, receiptSha256: index.receiptSha256 };
  } catch { return null; }
}
