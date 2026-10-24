#!/usr/bin/env node
// 「仅基线失败」的机器判定：PR 的 validate 以 exit 1 失败时，在 merge-base 的干净 detached worktree 里
// 用同 policy、同命令、同运行指纹再跑一次，只有 PR 失败集合 ⊆ 基线失败集合才可受控通过。
// 与 cindy 侧无关（cindy 没有受控 pre-push，见其 README），不共享模块。
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { acquireValidationSlot } from './mivo-validation-runtime.mjs';
import { PARSER_VERSION, canonicalRuntime, isFailureSubset, parseFailureSet, runtimeSha256 } from './mivo-validation-evidence.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// 同键互斥：持有者进程已死的锁文件可回收；等待者只轮询，不占 validate 槽位。
async function withKeyLock(dir, key, fn, pollMs) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${key}.lock`);
  for (;;) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder = null;
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
      if (holder && !pidAlive(holder.pid)) { try { fs.rmSync(file, { force: true }); } catch {} continue; }
      await sleep(pollMs);
    }
  }
  try { return await fn(); }
  finally { fs.rmSync(file, { force: true }); }
}

function contained(root, file) {
  try {
    const rel = path.relative(fs.realpathSync(root), fs.realpathSync(file));
    return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch { return false; }
}

/** 读取并校验一份基线收据（哈希、键、日志完整性）；失败返回 null。 */
export function readBaselineReceipt({ validations, receiptPath, receiptSha256, key }) {
  try {
    if (!contained(validations, receiptPath)) return null;
    const bytes = fs.readFileSync(receiptPath);
    if (sha(bytes) !== receiptSha256) return null;
    const receipt = JSON.parse(bytes);
    if (receipt.kind !== 'mivo-baseline-validation' || receipt.parserVersion !== PARSER_VERSION) return null;
    if (key && receipt.key !== key) return null;
    if (!contained(validations, receipt.logPath) || sha(fs.readFileSync(receipt.logPath)) !== receipt.logSha256) return null;
    return receipt;
  } catch { return null; }
}

function acceptable(pr, baseline, expected) {
  if (!baseline) return 'baseline-receipt-invalid';
  if (baseline.exitCode !== 1 || baseline.failureKind !== 'test-failure') return 'baseline-not-a-test-failure';
  if (baseline.policy?.sha256 !== expected.policySha256) return 'baseline-policy-mismatch';
  if (baseline.runtimeSha256 !== expected.runtimeSha256) return 'baseline-runtime-mismatch';
  if (!isFailureSubset(pr, { state: baseline.failureSetState, failureSet: baseline.failureSet })) return 'failure-not-subset-of-baseline';
  return null;
}

/**
 * 返回 { accepted, reason, baseline }。任何环节拿不准都 accepted=false；调用方据此保持 fail。
 * 调用方提供 git/runStep/needsInstall，避免本模块依赖 repair 的内部实现。
 */
export async function compareBaseline({
  paths, repo, worktree, validatedHead, baseRefName, prFailure, policySha256, runtime, config,
  git, runStep, needsInstall, env, slotPollMs = 250,
}) {
  const fail = (reason) => ({ accepted: false, reason });
  if (typeof baseRefName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(baseRefName) || baseRefName.includes('..')) return fail('base-ref-invalid');
  const wanted = { policySha256, runtimeSha256: runtimeSha256(runtime) };
  git(['-C', worktree, 'fetch', 'origin', `+refs/heads/${baseRefName}:refs/remotes/origin/${baseRefName}`]);
  const mergeBases = git(['-C', worktree, 'merge-base', '--all', validatedHead, `refs/remotes/origin/${baseRefName}`]).split('\n').map((line) => line.trim()).filter(Boolean);
  if (mergeBases.length !== 1 || !isSha(mergeBases[0])) return fail('merge-base-ambiguous');
  const [mergeBase] = mergeBases;
  const basePolicy = git(['-C', worktree, 'show', `${mergeBase}:.githooks/pre-push`]).trim();
  if (!basePolicy || sha(basePolicy) !== policySha256) return fail('baseline-policy-mismatch');
  const blob = (rev) => { try { return git(['-C', worktree, 'rev-parse', '--verify', '--quiet', `${rev}:package-lock.json`]).trim() || null; } catch { return null; } };
  if (blob(mergeBase) !== blob(validatedHead)) return fail('baseline-lockfile-mismatch');
  const key = sha(JSON.stringify({ repo, mergeBase, policySha256, packageLockBlob: blob(mergeBase), runtimeSha256: wanted.runtimeSha256 }));
  const cacheDir = path.join(paths.validations, 'baseline-cache');
  const cacheFile = path.join(cacheDir, `${key}.json`);

  const cached = () => {
    try {
      const index = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const receipt = readBaselineReceipt({ validations: paths.validations, receiptPath: index.receiptPath, receiptSha256: index.receiptSha256, key });
      return receipt ? { receipt, receiptPath: index.receiptPath, receiptSha256: index.receiptSha256 } : null;
    } catch { return null; }
  };

  const entry = await withKeyLock(path.join(paths.validations, 'baseline-locks'), key, async () => {
    const hit = cached();
    if (hit) return hit;
    const slot = await acquireValidationSlot({ home: paths.home, limit: config.concurrency, pollMs: slotPollMs });
    const treeRoot = path.join(paths.validations, 'baseline-worktrees');
    const dir = path.join(treeRoot, randomUUID());
    let created = false;
    try {
      fs.mkdirSync(treeRoot, { recursive: true, mode: 0o700 });
      git(['-C', worktree, 'worktree', 'add', '--detach', dir, mergeBase]);
      created = true;
      if (git(['-C', dir, 'rev-parse', 'HEAD']).trim() !== mergeBase || git(['-C', dir, 'status', '--porcelain']).trim()) return null;
      const startedAt = new Date().toISOString();
      const logBase = path.join(paths.validations, 'logs', `baseline-${key}-${randomUUID()}`);
      const stepEnv = { ...env, PREFLIGHT_SKIP: '0', TMPDIR: runtime.tmpdir };
      const base = { cwd: dir, env: stepEnv, timeout: config.timeoutMs, stallMs: config.stallMs, maxBuffer: 32 * 1024 * 1024, onGroup: (pgid) => slot.setGroup(pgid), pgidFile: slot.pgidFile };
      if (needsInstall(dir)) {
        const install = await runStep('npm', ['ci'], base, `${logBase}-npm-ci.log`);
        if (!install.ok) return null;
      }
      const run = await runStep('/bin/bash', ['.githooks/pre-push'], base, `${logBase}-preflight.log`);
      const baseRuntime = canonicalRuntime({ worktree: dir });
      const usable = fs.readFileSync(path.join(dir, '.githooks/pre-push'), 'utf8').trim() === basePolicy
        && runtimeSha256(baseRuntime) === wanted.runtimeSha256;
      if (!usable) return null;
      const failure = run.ok ? { state: 'parsed', failureSet: [], failureSetSha256: null }
        : (run.failureKind ? { state: 'unparsed', failureSet: [], failureSetSha256: null } : parseFailureSet(run.output, { worktree: dir }));
      const receipt = {
        schemaVersion: 2, kind: 'mivo-baseline-validation', validationEvidenceVersion: 1, parserVersion: PARSER_VERSION,
        key, repo, mergeBase, policy: { file: '.githooks/pre-push', sha256: policySha256 },
        runtime: baseRuntime, runtimeSha256: wanted.runtimeSha256,
        command: { binary: '/bin/bash', args: ['.githooks/pre-push'] },
        exitCode: run.exitCode, failureKind: run.ok ? null : (run.failureKind ?? 'test-failure'),
        logPath: run.logPath, logSha256: run.logSha256,
        failureSetState: failure.state, failureSet: failure.failureSet, failureSetSha256: failure.failureSetSha256,
        startedAt, finishedAt: new Date().toISOString(),
      };
      const receiptPath = path.join(paths.validations, 'baseline', `${key}-${randomUUID()}.json`);
      fs.mkdirSync(path.dirname(receiptPath), { recursive: true, mode: 0o700 });
      const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
      fs.writeFileSync(receiptPath, bytes, { flag: 'wx', mode: 0o600 });
      const receiptSha256 = sha(bytes);
      fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      const temp = `${cacheFile}.tmp-${randomUUID()}`;
      fs.writeFileSync(temp, `${JSON.stringify({ key, receiptPath, receiptSha256 })}\n`, { mode: 0o600 });
      fs.renameSync(temp, cacheFile);
      return { receipt, receiptPath, receiptSha256 };
    } finally {
      let cleaned = !created;
      if (created) {
        try { git(['-C', worktree, 'worktree', 'remove', '--force', dir]); cleaned = true; } catch {}
      }
      slot.release();
      if (!cleaned) throw new Error('baseline-cleanup-failed');
    }
  }, slotPollMs);

  if (!entry) return fail('baseline-unusable');
  const reason = acceptable(prFailure, entry.receipt, { ...wanted });
  if (reason) return fail(reason);
  return {
    accepted: true,
    baseline: { key, mergeBase, receiptPath: entry.receiptPath, receiptSha256: entry.receiptSha256, policySha256, runtimeSha256: wanted.runtimeSha256 },
  };
}

/** finalize/recheck 复核：重新读取 PR 与基线两份原始收据，复验子集与指纹，不能只信 status 字符串。 */
export function verifyBaselineBinding({ validations, receipt }) {
  const binding = receipt?.baseline;
  if (!binding) return 'baseline-binding-missing';
  const baseline = readBaselineReceipt({ validations, receiptPath: binding.receiptPath, receiptSha256: binding.receiptSha256, key: binding.key });
  if (receipt.exitCode !== 1 || receipt.failureKind !== 'test-failure') return 'pr-not-a-test-failure';
  if (binding.mergeBase !== baseline?.mergeBase) return 'baseline-merge-base-mismatch';
  return acceptable({ state: receipt.failureSetState, failureSet: receipt.failureSet }, baseline,
    { policySha256: receipt.policy?.sha256, runtimeSha256: receipt.runtimeSha256 });
}
