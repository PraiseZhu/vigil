#!/usr/bin/env node
// validate 的证据层：运行指纹、失败集合解析与比较、通过收据复用缓存。
// 与 cindy 侧同名模块各自独立实现，两侧不互相 import。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// 2：errorSha 归一化去掉临时目录随机名与运行时间戳；旧版本的基线缓存按版本号自动失效重算。
export const PARSER_VERSION = 2;
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
const FAIL_FILE = /^\s*FAIL\s+(\S+)\s+\[\s*(\S+)\s*\]\s*$/;
const FAIL_OTHER = /^\s*FAIL\s/;
const TESTS_FAILED = /^\s*Tests\s+(\d+) failed/;
const FILES_FAILED = /^\s*Test Files\s+(\d+) failed/;
const NODE_FAIL_COUNT = /^(?:ℹ fail|# fail) (\d+)\s*$/;
const NODE_SPEC_HEAD = /^✖ failing tests:\s*$/;
const NODE_SPEC_LOC = /^test at (.+?):\d+:\d+\s*$/;
const NODE_SPEC_NAME = /^✖ (.+?) \(\d+(?:\.\d+)?m?s\)\s*$/;
const TAP_NOT_OK = /^(\s*)not ok \d+ - (.+?)\s*$/;
const TAP_END = /^\s*\.\.\.\s*$/;
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

// mkdtemp 一类的临时目录每次运行名字都不同（/tmp、/private/tmp、/var/folders/…/T 下的第一段），不能进 errorSha。
const TEMP_PATH = /(?:\/private)?(?:\/tmp|\/var\/folders\/[^/\s]+\/[^/\s]+\/T)\/[^/\s"'`)]+/g;
// 运行时间戳（20261024T132343Z、ISO 8601）同样每次不同。
const TIMESTAMP = /\b\d{8}T\d{6}Z\b|\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

function normalizeError(lines, worktree) {
  const kept = [...lines];
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  return kept.map((line) => {
    let out = line.replace(/\s+$/, '');
    if (worktree) out = out.split(worktree).join('<WT>');
    out = out.replace(TEMP_PATH, '<TMP>').replace(TIMESTAMP, '<TS>');
    return out.replace(/:\d+:\d+(?=\)?$)/, '');
  }).join('\n');
}

/** tap 的 yaml 块里取 location / failureType / error。 */
function tapFields(blockLines) {
  const scalar = (key) => {
    const hit = blockLines.map((line) => new RegExp(`^\\s*${key}:\\s*(.*)$`).exec(line)).find(Boolean);
    return hit ? hit[1].replace(/^'(.*)'$/, '$1') : null;
  };
  const at = blockLines.findIndex((line) => /^\s*error:/.test(line));
  const errorLines = [];
  if (at >= 0) {
    const rest = /^\s*error:\s*(.*)$/.exec(blockLines[at])[1];
    if (/^\|/.test(rest)) {
      const indent = blockLines[at].match(/^\s*/)[0].length;
      for (const line of blockLines.slice(at + 1)) {
        if (line.trim() !== '' && line.match(/^\s*/)[0].length <= indent) break;
        errorLines.push(line);
      }
    } else if (rest) errorLines.push(rest.replace(/^'(.*)'$/, '$1'));
  }
  return { location: scalar('location'), failureType: scalar('failureType'), errorLines };
}

/**
 * 解析一次「失败的」hook 输出。认得三种失败块：vitest（`FAIL file > test`、文件级 `FAIL file [ file ]`）、
 * node:test 的 spec（`✖ failing tests:` 段）与 TAP（`not ok N - name` 的 yaml 块）。
 * 只有全部失败块都被覆盖、尾标记与各自的失败计数一致时才给 parsed；
 * 其余（lint 报错、截断、未处理错误、计数对不上、缺断言信息）一律 unparsed。
 */
export function parseFailureSet(text, { worktree } = {}) {
  const lines = String(text ?? '').replace(ANSI, '').replace(/\r\n?/g, '\n').split('\n');
  const bound = [];
  let pending = new Map();
  let vitestClaim = null;
  let filesClaim = null;
  let nodeClaim = null;
  let current = null;
  let markers = 0;
  let problem = null;
  let specMode = false;
  let specFile = null;
  let tap = null;
  const relFile = (raw) => {
    let file = raw;
    if (worktree && path.isAbsolute(file)) file = path.relative(worktree, file);
    if (path.isAbsolute(file) || file.startsWith('..')) { problem ??= 'failure file outside the worktree'; return null; }
    return file.split(path.sep).join('/');
  };
  const addEntry = (kind, rawFile, test) => {
    const file = relFile(rawFile);
    if (file === null) return null;
    const key = `${file}\u0000${test}`;
    if (!pending.has(key)) pending.set(key, { kind, file, test, errorLines: [] });
    return pending.get(key);
  };
  const finishTap = (block) => {
    const { location, failureType, errorLines } = tapFields(block.lines);
    if (failureType === 'subtestsFailed' || /#\s*(?:SKIP|TODO)\b/.test(block.name)) return;
    const raw = location?.replace(/:\d+:\d+$/, '');
    if (!raw) { problem ??= 'tap failure without a location'; return; }
    const entry = addEntry('node', raw, block.name);
    if (entry && !entry.errorLines.length) entry.errorLines.push(...errorLines);
  };
  const reset = () => { current = null; specMode = false; specFile = null; tap = null; };
  for (const line of lines) {
    if (tap) {
      if (TAP_END.test(line)) { finishTap(tap); tap = null; } else tap.lines.push(line);
      continue;
    }
    const marker = MARKER.exec(line);
    if (marker) {
      markers++;
      const testEntries = [...pending.values()].filter((entry) => entry.kind === 'vitest').length;
      const nodeEntries = [...pending.values()].filter((entry) => entry.kind === 'node').length;
      const vitestFiles = new Set([...pending.values()].filter((entry) => entry.kind !== 'node').map((entry) => entry.file)).size;
      reset();
      if (pending.size === 0) { problem ??= `step ${marker[1]} failed without test failures`; continue; }
      if (testEntries !== (vitestClaim ?? 0)) problem ??= 'failed test count does not match the summary';
      if (nodeEntries !== (nodeClaim ?? 0)) problem ??= 'failed node:test count does not match the summary';
      if (filesClaim !== null && filesClaim !== vitestFiles) problem ??= 'failed file count does not match the summary';
      for (const entry of pending.values()) {
        if (!entry.errorLines.length) { problem ??= 'failed test has no assertion message'; continue; }
        bound.push({ step: marker[1], file: entry.file, test: entry.test, errorSha: sha(normalizeError(entry.errorLines, worktree)) });
      }
      pending = new Map();
      vitestClaim = null; filesClaim = null; nodeClaim = null;
      continue;
    }
    const failFile = FAIL_FILE.exec(line);
    if (failFile && failFile[1] === failFile[2]) {
      current = addEntry('vitestFile', failFile[1], '<file>');
      if (current) current.collecting = !current.errorLines.length;
      continue;
    }
    const fail = FAIL_TEST.exec(line);
    if (fail) {
      current = addEntry('vitest', fail[1], fail[2]);
      if (current) current.collecting = !current.errorLines.length;
      continue;
    }
    if (FAIL_OTHER.test(line)) { current = null; problem ??= 'failure that is not a single test'; continue; }
    const notOk = TAP_NOT_OK.exec(line);
    if (notOk) { current = null; tap = { name: notOk[2], lines: [] }; continue; }
    const count = TESTS_FAILED.exec(line);
    if (count) { vitestClaim = Number(count[1]); current = null; continue; }
    const files = FILES_FAILED.exec(line);
    if (files) { filesClaim = Number(files[1]); current = null; continue; }
    const nodeCount = NODE_FAIL_COUNT.exec(line);
    if (nodeCount) { nodeClaim = Number(nodeCount[1]); current = null; continue; }
    if (NODE_SPEC_HEAD.test(line)) { specMode = true; current = null; continue; }
    if (specMode) {
      const loc = NODE_SPEC_LOC.exec(line);
      if (loc) { specFile = loc[1]; current = null; continue; }
      const name = specFile ? NODE_SPEC_NAME.exec(line) : null;
      if (name) {
        current = addEntry('node', specFile, name[1]);
        if (current) current.collecting = !current.errorLines.length;
        specFile = null;
        continue;
      }
    }
    if (/Unhandled (?:Rejection|Error)/i.test(line)) { problem ??= 'unhandled error in output'; continue; }
    if (SECTION_END.test(line)) { current = null; continue; }
    if (current?.collecting) {
      if (STACK.test(line)) { current.collecting = false; continue; }
      if (line.trim() === '' && !current.errorLines.length) continue;
      current.errorLines.push(line);
    }
  }
  if (tap) problem ??= 'tap failure block was cut off';
  if (pending.size) problem ??= 'failures not closed by a step marker';
  if (!markers) problem ??= 'no preflight failure marker';
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
    if (receipt.schemaVersion !== 2 || receipt.kind !== 'mivo-repair-validation' || receipt.validationEvidenceVersion !== 1) return null;
    if (receipt.status !== 'pass' || receipt.exitCode !== 0 || !receipt.command || receipt.reusedFrom) return null;
    if (receipt.repo !== identity.repo || receipt.nodeId !== identity.nodeId || receipt.number !== identity.number) return null;
    if (receipt.head !== identity.head || receipt.policy?.sha256 !== identity.policySha256 || receipt.runtimeSha256 !== identity.runtimeSha256) return null;
    if (typeof receipt.logPath !== 'string' || !contained(validations, receipt.logPath)) return null;
    if (sha(fs.readFileSync(receipt.logPath)) !== receipt.logSha256) return null;
    return { receipt, receiptPath: index.receiptPath, receiptSha256: index.receiptSha256 };
  } catch { return null; }
}
