#!/usr/bin/env node
// A per-push hook directory: preserve repository hooks, then fence publication.
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const hookName = name => /^[a-z][a-z0-9-]*$/.test(name);

function pushPolicy(validatedPolicy) {
  if (!validatedPolicy || typeof validatedPolicy !== 'object') return null;
  const { policyFile, policySha256 } = validatedPolicy;
  if (policyFile !== '.githooks/pre-push' || typeof policySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(policySha256)) return null;
  return { policyFile, policySha256 };
}

export function createPushHooks({ worktree, originalHooks, home, taskPath, head, ref, gitBinary = 'git', validatedPolicy = null }) {
  if (![worktree, originalHooks, home, taskPath].every(p => typeof p === 'string' && path.isAbsolute(p))
    || !/^[a-f0-9]{40}$/.test(head) || !ref?.startsWith('refs/heads/')) throw Error('invalid push ownership context');
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'vigil-push-hooks-'));
  fs.chmodSync(dir, 0o700);
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    const context = path.join(dir, 'context.json');
    const policy = pushPolicy(validatedPolicy);
    fs.writeFileSync(context, JSON.stringify({ worktree, originalHooks, home, taskPath, head, ref, gitBinary,
      helper: fileURLToPath(new URL('./mivo-repair.mjs', import.meta.url)),
      ...(policy ? { validatedPolicy: policy } : {}) }), { mode: 0o600 });
    const names = new Set(['pre-push']);
    let entries = [];
    try { entries = fs.readdirSync(originalHooks); }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    for (const name of entries) {
      if (!hookName(name)) continue;
      const stat = fs.statSync(path.join(originalHooks, name));
      if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111))) names.add(name);
    }
    for (const name of names) {
      const launcher = `#!/bin/sh\nexec ${quote(process.execPath.replaceAll('\\', '/'))} ${quote(self.replaceAll('\\', '/'))} ${quote(context.replaceAll('\\', '/'))} ${quote(name)} "$@"\n`;
      fs.writeFileSync(path.join(dir, name), launcher, { mode: 0o700 });
    }
    return { dir, cleanup };
  } catch (error) { cleanup(); throw error; }
}

function run(binary, args, options) {
  const result = spawnSync(binary, args, { ...options, env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`hook command failed (${result.signal ?? result.status})`);
}

function skipOriginalPrePush(context) {
  const policy = context.validatedPolicy;
  if (!policy || policy.policyFile !== '.githooks/pre-push' || !/^[0-9a-f]{64}$/.test(policy.policySha256 ?? '')) return false;
  const actual = path.join(context.originalHooks, 'pre-push');
  const expected = path.join(context.worktree, policy.policyFile);
  try {
    if (fs.realpathSync(actual) !== fs.realpathSync(expected)) return false;
    return createHash('sha256').update(fs.readFileSync(actual, 'utf8').trim()).digest('hex') === policy.policySha256;
  } catch {
    return false;
  }
}

function main([contextPath, name, ...args]) {
  if (!contextPath || !hookName(name ?? '')) throw Error('hook context and name required');
  const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  const input = fs.readFileSync(0);
  const inputPath = path.join(path.dirname(contextPath), `${randomUUID()}.stdin`);
  fs.writeFileSync(inputPath, input, { mode: 0o600, flag: 'wx' });
  try {
    // Git runs the original hook with its own execution/argument semantics unless this
    // pre-push already has a bound PASS receipt for the same actual hook file.
    if (name !== 'pre-push' || !skipOriginalPrePush(context)) {
      run(context.gitBinary, ['-c', `core.hooksPath=${context.originalHooks}`, 'hook', 'run',
        '--ignore-missing', `--to-stdin=${inputPath}`, name, '--', ...args], { cwd: context.worktree, stdio: 'inherit' });
    }
    if (name !== 'pre-push') return;
    const refs = input.toString('utf8').trim().split('\n').filter(Boolean).map(line => line.trim().split(/\s+/));
    if (refs.length !== 1 || refs[0].length !== 4 || refs[0][1] !== context.head || refs[0][2] !== context.ref) {
      throw Error('push refs differ from the validated task');
    }
    // This runs after the possibly long repository hook, before Git transfers refs.
    run(process.execPath, [context.helper, 'assert-owner', '--home', context.home, '--task', context.taskPath],
      { cwd: context.worktree, stdio: ['ignore', 'ignore', 'inherit'] });
  } finally { fs.unlinkSync(inputPath); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`vigil-pre-push: ${error.message}\n`); process.exitCode = 1; }
}
