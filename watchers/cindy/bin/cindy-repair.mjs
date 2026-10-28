#!/usr/bin/env node
// Mini PR repair contract. This helper owns one task file and one PR worktree.
// It deliberately has no session-runtime integration: the watcher is the
// source of the session binding and Cindy is responsible for the session.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectCindyCiSync } from './cindy-ci.mjs';
import { taskRepairPolicy } from './cindy-feedback-policy.mjs';
import { acquireLock, AUTHOR_RECLAIMED, clearOrphanGuard, DEPLOY_LOCK_NAME, helperLockName, inspectLocks, lockStatus, readPr, writePr } from './cindy-state.mjs';
import { optionalConfig, requireConfig } from './profile.mjs';
import { acquireValidationSlot, runStreaming, validationConfig } from './cindy-validation-runtime.mjs';
import {
  PARSER_VERSION, canonicalRuntime, emptyFailureSet, lookupPass, parseFailureSet, publishPass, runtimeSha256,
} from './cindy-validation-evidence.mjs';

// 这是一个真实可公开的仓库，默认值保留；可用 CINDY_WATCHER_TARGET_REPO / profile.json 的
// targetRepo 覆盖成你自己要盯梢的仓库。
export const REPO = process.env.CINDY_WATCHER_TARGET_REPO || 'makecindy/cindy';
const GH = process.env.GH_BIN ?? 'gh';
const GIT = process.env.GIT_BIN ?? 'git';
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const GIT_PUSH_TIMEOUT_MS = 60 * 60 * 1000;
// A fork clone borrows objects from the local Cindy repo, but the first fetch of a
// new fork branch can still exceed the default helper timeout.
const GIT_CLONE_TIMEOUT_MS = 15 * 60 * 1000;

function fail(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  throw error;
}

function requireAbs(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail(`${label} must be an absolute path`);
  return path.resolve(value);
}

function isSha(value) { return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

export function pluginRepoPath(env = process.env) {
  if (env.CINDY_WATCHER_REPO) return env.CINDY_WATCHER_REPO;
  return requireConfig('pluginRepoPath', {
    env,
    hint: '本地插件工作仓的绝对路径，示例："/path/to/your-plugin-checkout"。',
  });
}
export function githubRepoUrl(repo, style = 'https') {
  if (style === 'ssh') return `git@github.com:${repo}.git`;
  return `https://github.com/${repo}.git`;
}
export function normalizeGithubUrl(value) {
  return String(value ?? '')
    .trim()
    .replace(/\/$/, '')
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/\.git$/i, '')
    .toLowerCase();
}
export function isBaseGithubUrl(url) {
  const normalized = normalizeGithubUrl(url);
  return normalized === normalizeGithubUrl(githubRepoUrl(REPO))
    || normalized === normalizeGithubUrl(githubRepoUrl(REPO, 'ssh'));
}
export function sameGithubRepo(url, repo) {
  const normalized = normalizeGithubUrl(url);
  return normalized === normalizeGithubUrl(githubRepoUrl(repo))
    || normalized === normalizeGithubUrl(githubRepoUrl(repo, 'ssh'));
}
function resolveHeadRepo(task) {
  if (typeof task?.headRepo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(task.headRepo)) return task.headRepo;
  fail('task.headRepo is required (PR fork owner/name)');
}
export function watchBranchName(number) { return `watch/pr-${number}`; }
export function watchWorktreePath(pluginRepo, number) {
  return path.join(pluginRepo, '.worktrees', 'watch', `pr-${number}`);
}
export function repairPaths(home) {
  const root = requireAbs(home, 'home');
  return {
    home: root,
    state: path.join(root, 'state', 'state.json'),
    tasks: path.join(root, 'state', 'tasks'),
    results: path.join(root, 'state', 'results'),
    validations: path.join(root, 'state', 'validations'),
    approvals: path.join(root, 'state', 'approvals'),
    worktrees: path.join(root, 'worktrees'),
  };
}
function taskWorktree(task, env = process.env) {
  return watchWorktreePath(pluginRepoPath(env), task.number);
}

function under(file, dir) {
  const rel = path.relative(dir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function immutableJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}

function identity(task, sessionId) {
  return { dispatchId: task.dispatchId, nodeId: task.nodeId, number: task.number, repo: task.repo, sessionId };
}

function assertIdentity(value, task, sessionId, label) {
  for (const [key, expected] of Object.entries(identity(task, sessionId))) {
    if (value?.[key] !== expected) fail(`${label} ${key} does not match task binding`);
  }
}

function activityFile(paths, dispatchId) {
  return path.join(paths.home, 'state', 'activity', `${dispatchId}.json`);
}
export function recordActivity(paths, task, op, at = new Date().toISOString()) {
  if (!task?.dispatchId) return;
  atomicJson(activityFile(paths, task.dispatchId), { at, op, dispatchId: task.dispatchId });
}
export function readActivityAt(home, dispatchId) {
  try {
    const at = Date.parse(JSON.parse(fs.readFileSync(path.join(requireAbs(home, 'home'), 'state', 'activity', `${dispatchId}.json`), 'utf8'))?.at ?? '');
    return Number.isFinite(at) ? at : null;
  } catch { return null; }
}
function activityHeartbeatMs() {
  return Math.max(1_000, Number(process.env.VIGIL_ACTIVITY_HEARTBEAT_MS) || 60_000);
}
// The heartbeat outlives a blocked event loop, but not the helper: it follows parentPid and
// exits once that process is gone, so a killed helper cannot keep a dead task looking busy.
export function startActivityHeartbeat(paths, task, op, { parentPid = process.pid } = {}) {
  recordActivity(paths, task, op);
  const file = activityFile(paths, task.dispatchId);
  const child = spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const path = ${JSON.stringify(file)};
    const parentPid = ${JSON.stringify(parentPid)};
    const rec = () => {
      try { process.kill(parentPid, 0); } catch (error) { if (error.code === 'ESRCH') process.exit(0); }
      try {
        const tmp = path + '.tmp-' + process.pid + '-' + Date.now();
        fs.mkdirSync(require('path').dirname(path), { recursive: true, mode: 0o700 });
        fs.writeFileSync(tmp, JSON.stringify({ at: new Date().toISOString(), op: ${JSON.stringify(op)}, dispatchId: ${JSON.stringify(task.dispatchId)} }) + '\\n', { mode: 0o600 });
        fs.renameSync(tmp, path);
      } catch {}
    };
    setInterval(rec, ${activityHeartbeatMs()});
  `], { detached: true, stdio: 'ignore' });
  child.unref();
  return () => { try { process.kill(child.pid, 'SIGTERM'); } catch {} };
}

function saveResult(paths, task, sessionId, payload, { requirePrLock = false } = {}) {
  refuseDeployLock(paths.home);
  recordActivity(paths, task, payload?.status ?? 'result');
  if (!requirePrLock) return saveResultLocked(paths, task, sessionId, payload);
  const lock = acquireLock(paths.home, `pr-${task.nodeId}`);
  if (lock.held) fail('PR 状态锁占用，请稍后重试写结果');
  try { return saveResultLocked(paths, task, sessionId, payload); }
  finally { lock.release(); }
}
function saveResultLocked(paths, task, sessionId, payload) {
  const latest = path.join(paths.results, `${task.dispatchId}.json`);
  const history = path.join(paths.results, 'history', task.dispatchId);
  if (fs.existsSync(latest)) {
    const bytes = fs.readFileSync(latest);
    fs.mkdirSync(history, { recursive: true, mode: 0o700 });
    const old = path.join(history, `prior-${hash(bytes)}.json`);
    try { fs.writeFileSync(old, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const receiptId = randomUUID();
  const result = {
    ...payload, schemaVersion: 2, kind: 'cindy-repair-result', ...identity(task, sessionId),
    scope: 'feedback-task', prReady: false,
    sourceHead: task.headRefOid, repairPolicy: taskRepairPolicy(task), observedAt: new Date().toISOString(), receiptId,
    historyPath: path.join(history, `${receiptId}.json`),
  };
  immutableJson(result.historyPath, result);
  atomicJson(latest, result);
  return result;
}

export function command(binary, args, options = {}, runner = execFileSync) {
  const timeout = options.timeout ?? (binary === GIT && args.includes('push') ? GIT_PUSH_TIMEOUT_MS
    : binary === GIT && args[0] === 'clone' ? GIT_CLONE_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS);
  return runner(binary, args, {
    encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }).trim();
}

function ghJson(args, ghFn = command) {
  let raw;
  try { raw = ghFn(GH, args); }
  catch (error) {
    // gh pr checks uses exit 1/8 for failing or pending checks while still
    // emitting the JSON payload needed for classification.
    if (args[0] === 'pr' && args[1] === 'checks' && error?.status === 1
      && /no (?:required status )?checks reported/i.test(`${error.stdout ?? ''}\n${error.stderr ?? ''}`)) return [];
    if (args[0] === 'pr' && args[1] === 'checks' && [1, 8].includes(error?.status) && error?.stdout) raw = error.stdout;
    else throw error;
  }
  try { return JSON.parse(String(raw)); }
  catch (error) { fail(`gh returned invalid JSON: ${error.message}`); }
}

function gitOutput(args, gitFn = command) { return String(gitFn(GIT, args)); }

function refuseDeployLock(home) {
  if (lockStatus(home, DEPLOY_LOCK_NAME).live) fail('deploy lock held');
}
function peekTaskNumber(taskPath) {
  if (typeof taskPath !== 'string') return undefined;
  try {
    const number = Number(JSON.parse(fs.readFileSync(taskPath, 'utf8'))?.number);
    return Number.isInteger(number) && number >= 1 ? number : undefined;
  } catch {
    return undefined;
  }
}
function withHelperOp(home, pr, fn) {
  const root = requireAbs(home, 'home');
  const lock = acquireLock(root, helperLockName(pr));
  if (lock.held) {
    const why = typeof lock.reason === 'string' && lock.reason.startsWith('reclaim-guard-orphan:')
      ? lock.reason : 'helper 运行锁占用，请稍后重试';
    fail(`busy: ${why}`, 2);
  }
  // fn 可能返回 Promise（validate 是异步的）：锁必须撑到它真正结束，不能在同步 finally 里提前释放。
  let released = false;
  const release = () => { if (!released) { released = true; lock.release(); } };
  try {
    refuseDeployLock(root);
    const result = fn();
    if (result && typeof result.then === 'function') return Promise.resolve(result).finally(release);
    release();
    return result;
  } catch (error) {
    release();
    throw error;
  }
}
function taskFrom(home, taskPath) {
  const paths = repairPaths(home);
  refuseDeployLock(paths.home);
  const file = requireAbs(taskPath, 'task');
  if (!under(file, paths.tasks)) fail('task must be inside home/state/tasks');
  const task = readJson(file, 'task');
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('task must be an object');
  if (typeof task.dispatchId !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(task.dispatchId)) fail('task.dispatchId is invalid');
  if (typeof task.nodeId !== 'string' || !task.nodeId.trim()) fail('task.nodeId is required');
  if (!Number.isInteger(task.number) || task.number < 1) fail('task.number is invalid');
  if (task.repo !== REPO) fail(`task.repo must be ${REPO}`);
  if (!isSha(task.headRefOid)) fail('task.headRefOid must be a 40-character SHA');
  if (typeof task.headRefName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(task.headRefName) || task.headRefName.includes('..')) fail('task.headRefName is invalid');
  resolveHeadRepo(task);
  const headOwner = task.headRepo.split('/')[0];
  if (typeof task.headOwner === 'string' && task.headOwner !== headOwner) fail('task.headOwner does not match headRepo');
  return { paths, file, task };
}

function boundSession(paths, task) {
  let entry = readPr(paths.home, task.nodeId);
  if (!entry) {
    const state = fs.existsSync(paths.state) ? readJson(paths.state, 'scanner state') : { prs: {} };
    entry = state?.prs?.[task.nodeId];
  }
  if (!entry?.sessionId) fail(`scanner state has no bound session for nodeId ${task.nodeId}`);
  if (task.sessionId && task.sessionId !== entry.sessionId) fail('task sessionId does not match scanner binding');
  const dispatches = entry.activeTask?.dispatchId
    ? [entry.activeTask.dispatchId]
    : [entry.lastDispatch?.dispatchId, entry.pendingDispatch?.dispatchId].filter(Boolean);
  if (dispatches.length && !dispatches.includes(task.dispatchId)) fail('task dispatchId is not the active watcher dispatch');
  if (entry.activeTask?.blockedKind === AUTHOR_RECLAIMED && entry.activeTask.dispatchId === task.dispatchId) {
    fail('task superseded: the author reclaimed this PR (Ready -> Draft); wait for the next watcher dispatch');
  }
  return { sessionId: entry.sessionId };
}

function ghPr(task, ghFn, requireHead = true) {
  const pr = ghJson(['pr', 'view', String(task.number), '--repo', task.repo, '--json', 'state,isDraft,headRefOid,headRefName,baseRefOid'], ghFn);
  if (pr.state !== 'OPEN' || pr.isDraft === true) fail('PR must be OPEN and non-draft');
  if (pr.headRefName !== task.headRefName) fail(`PR branch mismatch: expected ${task.headRefName}`);
  if (!isSha(pr.headRefOid)) fail('gh PR headRefOid is invalid');
  if (requireHead && pr.headRefOid !== task.headRefOid) fail(`task head is stale: ${task.headRefOid} != ${pr.headRefOid}`);
  return pr;
}

function remoteUrl(repo) { return githubRepoUrl(repo); }

export function originPushUrls(worktree, gitFn) {
  const raw = gitOutput(['-C', worktree, 'remote', 'get-url', '--push', '--all', 'origin'], gitFn);
  return String(raw).split(/\n/).map((item) => item.trim()).filter(Boolean);
}
export function insteadOfRewritesFork(worktree, forkUrl, gitFn) {
  let listed = '';
  try {
    listed = gitOutput(['-C', worktree, 'config', '--get-regexp', '^url\..*insteadOf$'], gitFn);
  } catch { return null; }
  const fork = normalizeGithubUrl(forkUrl);
  for (const line of String(listed).split(/\n/).map((item) => item.trim()).filter(Boolean)) {
    const match = /^(url\.(.+)\.(pushInsteadOf|insteadOf))\s+(.+)$/i.exec(line);
    if (!match) continue;
    const replacement = match[2];
    const source = match[4];
    if (normalizeGithubUrl(source) !== fork) continue;
    if (normalizeGithubUrl(replacement) !== fork) return match[1];
  }
  return null;
}
export function assertOriginPushTargets(worktree, repo, gitFn, expectedUrl = remoteUrl(repo)) {
  const rewrite = insteadOfRewritesFork(worktree, expectedUrl, gitFn);
  if (rewrite) fail(`refusing ${rewrite} rewriting fork ${expectedUrl}`);
  const urls = originPushUrls(worktree, gitFn);
  if (!urls.length) fail('origin has no push URL');
  for (const url of urls) {
    if (isBaseGithubUrl(url)) fail(`refusing origin pushurl pointing at base repo ${REPO}: ${url}`);
    if (!sameGithubRepo(url, repo) && normalizeGithubUrl(url) !== normalizeGithubUrl(expectedUrl)) {
      fail(`origin pushurl mismatch: ${url}`);
    }
  }
  return urls;
}
export function assertOrigin(worktree, repo, gitFn, expectedUrl = remoteUrl(repo)) {
  const origin = gitOutput(['-C', worktree, 'remote', 'get-url', 'origin'], gitFn);
  if (!sameGithubRepo(origin, repo) && normalizeGithubUrl(origin) !== normalizeGithubUrl(expectedUrl)) {
    fail(`worktree origin mismatch: ${origin}`);
  }
  if (repo !== REPO && isBaseGithubUrl(origin)) fail(`refusing origin pointing at base repo ${REPO}`);
  if (isBaseGithubUrl(expectedUrl) && repo !== REPO) fail(`refusing origin=${REPO}`);
  assertOriginPushTargets(worktree, repo, gitFn, expectedUrl);
}

export function assertUpstreamFetchOnly(worktree, gitFn) {
  let upstream;
  try { upstream = gitOutput(['-C', worktree, 'remote', 'get-url', 'upstream'], gitFn); }
  catch { fail('worktree missing upstream remote (must be makecindy/cindy, fetch-only)'); }
  if (!sameGithubRepo(upstream, REPO) && !isBaseGithubUrl(upstream)) fail(`worktree upstream mismatch: ${upstream}`);
  let pushUrl = '';
  try { pushUrl = gitOutput(['-C', worktree, 'remote', 'get-url', '--push', 'upstream'], gitFn); } catch { pushUrl = ''; }
  if (pushUrl && !/DISABLED|no_push|disabled/i.test(pushUrl) && isBaseGithubUrl(pushUrl)) {
    fail('upstream push URL must be disabled; never push to makecindy/cindy');
  }
}

function assertWorktree(worktree, task, gitFn, expectedUrl = remoteUrl(task.headRepo || task.repo)) {
  if (!fs.existsSync(worktree)) return false;
  if (!fs.statSync(worktree).isDirectory()) fail('worktree path exists but is not a directory');
  const top = gitOutput(['-C', worktree, 'rev-parse', '--show-toplevel'], gitFn);
  if (fs.realpathSync(top) !== fs.realpathSync(worktree)) fail('worktree path is not an independent git checkout');
  const originRepo = task.headRepo || task.repo;
  assertOrigin(worktree, originRepo, gitFn, expectedUrl);
  const originSeen = gitOutput(['-C', worktree, 'remote', 'get-url', 'origin'], gitFn);
  if (normalizeGithubUrl(originSeen).startsWith('https://github.com/') && !isBaseGithubUrl(originSeen)) {
    assertUpstreamFetchOnly(worktree, gitFn);
  }
  const branch = gitOutput(['-C', worktree, 'symbolic-ref', '--quiet', '--short', 'HEAD'], gitFn);
  if (branch !== watchBranchName(task.number)) fail(`worktree branch mismatch: ${branch}`);
  const tracking = gitOutput(['-C', worktree, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], gitFn);
  if (tracking !== `origin/${task.headRefName}`) fail(`worktree upstream mismatch: ${tracking}`);
  const status = gitOutput(['-C', worktree, 'status', '--porcelain'], gitFn);
  if (status) fail('worktree is dirty');
  const head = gitOutput(['-C', worktree, 'rev-parse', 'HEAD'], gitFn);
  if (!isSha(head)) fail('worktree HEAD is invalid');
  return { head };
}

export function cloneWorktree(paths, task, gitFn, cloneUrl, expectedUrl, remoteHead = task.headRefOid, env = process.env) {
  const plugin = pluginRepoPath(env);
  const worktree = watchWorktreePath(plugin, task.number);
  const branch = watchBranchName(task.number);
  const headRepo = resolveHeadRepo(task);
  const originUrl = cloneUrl ?? githubRepoUrl(headRepo);
  const expectUrl = expectedUrl ?? originUrl;
  if (isBaseGithubUrl(originUrl) || headRepo === REPO) fail(`refusing to clone base repo ${REPO} as origin`);
  const existing = assertWorktree(worktree, task, gitFn, expectUrl);
  if (existing) return { worktree, head: existing.head, created: false };
  fs.mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
  if (fs.existsSync(worktree)) fail('worktree path is unknown; refusing to remove it');
  // --reference-if-able reuses the local repo's objects (both remotes are already
  // fetched there), so only the PR's new commits cross the network; --dissociate
  // then copies the borrowed objects in, so a later gc of the local repo cannot
  // break a long-lived watch clone.
  gitOutput(['clone', '--reference-if-able', plugin, '--dissociate', '--origin', 'origin', '--branch', task.headRefName, '--single-branch', originUrl, worktree], gitFn);
  gitOutput(['-C', worktree, 'checkout', '-B', branch], gitFn);
  gitOutput(['-C', worktree, 'branch', '--set-upstream-to', `origin/${task.headRefName}`], gitFn);
  gitOutput(['-C', worktree, 'remote', 'add', 'upstream', githubRepoUrl(REPO)], gitFn);
  gitOutput(['-C', worktree, 'remote', 'set-url', '--push', 'upstream', 'DISABLED'], gitFn);
  const checked = assertWorktree(worktree, task, gitFn, expectUrl);
  if (!checked || checked.head !== remoteHead) fail('cloned worktree HEAD does not match observed remote head');
  return { worktree, head: checked.head, created: true };
}

// Recompute from the trusted task's feedback, including legacy tasks. A cached
// category, an SC assertion, or a successful preflight is not repair authority.
export function isEmptyCiRetrigger(worktree, fromSha, toSha, gitFn) {
  if (!isSha(fromSha) || !isSha(toSha) || fromSha === toSha) return false;
  return gitOutput(['-C', worktree, 'diff', '--name-only', fromSha, toSha], gitFn).trim() === '';
}

export function assertTaskRepairScope(task, head, { emptyRetrigger = false } = {}) {
  if (!isSha(task?.headRefOid) || !isSha(head)) fail('repair scope requires valid source and target HEAD');
  const repairPolicy = taskRepairPolicy(task);
  if (head !== task.headRefOid && !repairPolicy.canChangeCode && !emptyRetrigger) {
    fail('[REPAIR_SCOPE_NO_CODE] This task has no P0/P1/P2, required-CI or conflict repair authority; preserve local changes, do not push. P3 and unknown findings are no-change only.');
  }
  return repairPolicy;
}

const KEEL_RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Keel flow contract of newly dispatched tasks. 1 = a row naming the task; 2 = pstack_start row plus
// flow evidence; 3 = a fixed run id whose ledger is created by the first pstack_decide(op:"decide").
// A task is verified against the version it was dispatched with, so raising this never breaks one in flight.
export const KEEL_FLOW_VERSION = 3;

// The Keel run id of a v3 task. Derived from the dispatch id so the prompt can hand it out and the
// gate can recompute it; shaped like Keel's own ids (run-<14 digits>-<hex>) so name-sorted ledger
// listings stay in order.
export function keelRunIdFor(dispatchId) {
  const id = String(dispatchId);
  const parts = /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(id);
  return `run-${parts ? parts.slice(1, 7).join('') : 'vigil'}-${createHash('sha256').update(id).digest('hex').slice(0, 6)}`;
}

export function keelLedgerRoot(env = process.env) {
  return optionalConfig('keelLedgerRoot', { envVar: 'CINDY_KEEL_LEDGER_ROOT', env }) ?? null;
}

// Namespace the Keel plugin is installed under (e.g. after a reinstall into an organisation namespace).
// Optional: unset means the root install, where the session must leave the namespace argument out.
// An unset value is "root install". A set but illegal value stops here: reading it as unset would tell the
// session to omit the namespace and a namespaced Keel would answer GHOST_NOT_FOUND with no hint why.
export function keelNamespace(env = process.env) {
  const value = optionalConfig('keelNamespace', { envVar: 'CINDY_KEEL_NAMESPACE', env });
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) return value;
  fail('配置项「keelNamespace」的值不合法（环境变量 CINDY_KEEL_NAMESPACE 或 profile.json 的 "keelNamespace" 字段）：只允许字母、数字、下划线和连字符，以字母或数字开头，最长 128 位');
}

// Why the configured ledger root cannot be used, or null when it can (or none is configured).
// The reason carries the errno code only, never the path: it is posted to the PR.
export function keelLedgerProblem(root, { required = false } = {}) {
  if (!root) return required ? 'keelLedgerRoot not configured' : null;
  try {
    if (!fs.statSync(root).isDirectory()) return 'ledger root is not a directory';
    fs.accessSync(root, fs.constants.R_OK | fs.constants.X_OK);
    return null;
  } catch (error) { return `ledger root unreadable (${error?.code ?? 'error'})`; }
}

// Keel keeps each pstack run at runs/<run_id>/decisions.jsonl. The repair session binds its
// run to this task by logging a row containing task=<dispatchId>; without a configured
// ledger root, or for a pre-Keel task, the gate reports why it did not apply.
// A v3 run id is fixed per task. Current Keel only creates the ledger file in pstack_decide(op:"decide"),
// so the first decision necessarily precedes the binding row and no start row exists to check.
export function verifyKeelRun({ task, runId, root = keelLedgerRoot(), validatedHead, verification }) {
  const version = task.keelFlowVersion ?? 1;
  if (!root && version < 2) return { status: 'disabled' };
  if (task.keelFlow !== true) return { status: 'not-required-legacy-task' };
  const reject = message => fail('[KEEL_RUN_REQUIRED] ' + message);
  if (![1, 2, 3].includes(version)) reject('unsupported Keel flow version');
  if (!root) reject('new Keel task requires keelLedgerRoot');
  if (typeof runId !== 'string' || !KEEL_RUN_ID.test(runId)) reject('finalize needs --keel-run <run_id>');
  if (version === 3 && runId !== keelRunIdFor(task.dispatchId)) reject('v3 run_id must be ' + keelRunIdFor(task.dispatchId));
  const file = path.join(requireAbs(root, 'keelLedgerRoot'), 'runs', runId, 'decisions.jsonl');
  let rows;
  try { rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { reject('Keel ledger is unreadable: ' + error.message); }
  const since = Date.parse(task.createdAt ?? '');
  const marker = 'task=' + task.dispatchId;
  const current = row => Number.isFinite(Date.parse(row?.at ?? '')) && Date.parse(row.at) >= since;
  if (version === 1) {
    if (!rows.some(row => typeof row?.summary === 'string' && row.summary.includes(marker)
      && Number.isFinite(Date.parse(row.at)) && !(Date.parse(row.at) < since))) reject('run has no binding for ' + marker + ' written after the task was created');
    return { status: 'verified', runId, rows: rows.length, decisions: rows.filter(row => row?.kind === 'decision').length, contractVersion: 1 };
  }
  if (!Number.isFinite(since) || !isSha(validatedHead)) reject('task time and validated HEAD are required');
  const boundRows = rows.filter(row => row?.run_id === runId && current(row));
  const playbook = taskRepairPolicy(task).canChangeCode ? 'bug-fix' : 'investigation';
  const manualPath = 'pstack/skills/poteto-mode/playbooks/' + playbook + '.md';
  const binding = boundRows.find(row => row.kind === 'step' && row.summary === 'vigil ' + marker);
  if (version === 2) {
    const start = boundRows.find(row => row.kind === 'step' && typeof row.summary === 'string'
      && row.summary.startsWith('start ' + playbook + '（'));
    if (!start || !binding || Date.parse(start.at) > Date.parse(binding.at)) reject('pstack start and exact task binding are required');
  } else if (!binding) reject('exact task binding row is required (pstack_decide op:"log" kind:"step" summary:"vigil ' + marker + '")');
  const flowRow = [...boundRows].reverse().find(row => row.kind === 'evidence'
    && row.evidence?.kind === 'vigil-flow' && row.evidence.taskId === task.dispatchId && row.evidence.head === validatedHead);
  const flow = flowRow?.evidence;
  if (!flow || flow.version !== version || flow.playbook !== playbook || flow.manualPath !== manualPath) reject('current HEAD flow evidence and playbook are required');
  if (Date.parse(flowRow.at) < Date.parse(binding.at)) reject('flow evidence predates task binding');
  const refs = flow.decisionRowIds;
  if (!Array.isArray(refs) || !refs.length || new Set(refs).size !== refs.length) reject('flow must reference actual pstack decisions');
  for (const id of refs) {
    const decision = boundRows.find(row => row.row_id === id && row.kind === 'decision');
    if (!decision || !/^J(?:[3-9]|1[0-2])$/.test(decision.template ?? '')
      || !/^[a-f0-9]{64}$/.test(decision.state_sha256 ?? '') || decision.answer == null || decision.policy == null
      || (version === 2 && Date.parse(decision.at) < Date.parse(binding.at)) || Date.parse(decision.at) > Date.parse(flowRow.at)) reject('referenced task decision is missing or incomplete');
  }
  const steps = flow.steps;
  if (!steps || typeof steps.reproduce !== 'string' || !steps.reproduce.trim()
    || typeof steps.repair !== 'string' || !steps.repair.trim()) reject('reproduction/investigation and disposition evidence are required');
  if (verification?.head !== validatedHead) reject('local verification HEAD does not match');
  if (verification.status === 'not-required-no-change') {
    if (steps.verify?.status !== 'not-run' || typeof steps.verify.reason !== 'string' || !steps.verify.reason.trim()) reject('no-change flow must explain why local tests were not run');
  } else if (!['pass', 'approved-exception'].includes(verification.status)
    || steps.verify?.head !== validatedHead || !/^[a-f0-9]{64}$/.test(verification.receiptSha256 ?? '')
    || steps.verify?.receiptSha256 !== verification.receiptSha256) reject('flow must reference the current local validation receipt');
  return { status: 'verified', runId, rows: rows.length, decisions: refs.length, contractVersion: version };
}

const CI_ERROR_LINES = 20;
export function ciErrorExcerpts(task, ghFn = command) {
  const runIds = [...new Set((task.prSnapshot?.failingChecks ?? []).map((check) => workflowRunId(check?.link ?? '', task.repo)).filter(Boolean))];
  return runIds.map((runId) => {
    try {
      const log = String(ghFn(GH, ['run', 'view', runId, '--repo', task.repo, '--log-failed']));
      return { runId, errors: log.split('\n').filter((line) => line.includes('##[error]')).slice(0, CI_ERROR_LINES).map((line) => line.slice(0, 400)) };
    } catch (error) {
      return { runId, error: String(error?.message ?? error).slice(0, 200) };
    }
  });
}

// An existing watch tree behind the fork is fast-forwarded; one that diverged from it (an earlier round's commits
// that were never pushed, while the author pushed their own) is bundled into _backup and rebuilt from the fork.
// Local commits on top of the fork head are this round's unpushed work and stay. Before this, 2026-10-15 #6077
// blocked twice on "worktree HEAD does not match validated-head" with no way to recover.
export function alignWatchWorktree({ task, checkout, remoteHead, gitFn = command, now = new Date().toISOString(), env = process.env }) {
  if (checkout.created || checkout.head === remoteHead) return { ...checkout, realigned: null };
  const worktree = checkout.worktree;
  gitOutput(['-C', worktree, 'fetch', '--quiet', 'origin', task.headRefName], gitFn);
  const isAncestor = (older, newer) => {
    try { gitOutput(['-C', worktree, 'merge-base', '--is-ancestor', older, newer], gitFn); return true; } catch { return false; }
  };
  if (isAncestor(remoteHead, checkout.head)) return { ...checkout, realigned: null };
  const backup = isAncestor(checkout.head, remoteHead) ? null
    : backupWatchBranch({ plugin: pluginRepoPath(env), number: task.number, branch: watchBranchName(task.number), gitFn, now, worktree });
  gitOutput(['-C', worktree, 'reset', '--hard', remoteHead], gitFn);
  const head = gitOutput(['-C', worktree, 'rev-parse', 'HEAD'], gitFn);
  if (head !== remoteHead) fail('watch tree realign did not reach the fork head');
  return { ...checkout, head, realigned: { from: checkout.head, to: head, backup: backup?.bundlePath ?? null } };
}

export function prepare({ home, taskPath, ghFn = command, gitFn = command, cloneUrl, originUrl, viewer, keelRoot = keelLedgerRoot() } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  const { paths, task } = taskFrom(home, taskPath);
  recordActivity(paths, task, 'prepare');
  const { sessionId } = boundSession(paths, task);
  // A Keel task that cannot finalize is stopped here, before a worktree is built and work is done on it:
  // finalize reads the ledger and rejects a missing or unreadable one only after validate.
  const keelProblem = task.keelFlow === true && Number(task.keelFlowVersion ?? 1) >= 2 ? keelLedgerProblem(keelRoot, { required: true }) : null;
  if (keelProblem) {
    return saveResult(paths, task, sessionId, {
      status: 'blocked', blockedKind: 'external', reason: `keel-unavailable: ${keelProblem}`,
      head: task.headRefOid, worktree: taskWorktree(task),
    });
  }
  const headRepo = resolveHeadRepo(task);
  const headOwner = headRepo.split('/')[0];
  const login = viewer ?? String(ghFn(GH, ['api', 'user', '-q', '.login'])).replace(/^"|"$/g, '').trim();
  if (headOwner !== login) fail(`head owner ${headOwner} is not the current viewer ${login}; blocked`);
  const forkUrl = originUrl ?? cloneUrl ?? githubRepoUrl(headRepo);
  if (isBaseGithubUrl(forkUrl) || headRepo === REPO) fail(`refusing origin=${REPO}; push only to the PR fork`);
  const pr = ghPr(task, ghFn, false);
  const checkout = alignWatchWorktree({ task, checkout: cloneWorktree(paths, task, gitFn, forkUrl, forkUrl, pr.headRefOid), remoteHead: pr.headRefOid, gitFn });
  const repairPolicy = assertTaskRepairScope(task, checkout.head);
  const needsSync = checkout.head !== pr.headRefOid || task.headRefOid !== pr.headRefOid;
  return { ...identity(task, sessionId), repairPolicy, status: needsSync ? 'needs-sync' : 'prepared', needsSync,
    worktree: checkout.worktree, head: checkout.head, remoteHead: pr.headRefOid, sourceHead: task.headRefOid,
    origin: forkUrl, headRepo, created: checkout.created, realigned: checkout.realigned, ciErrors: ciErrorExcerpts(task, ghFn) };
  });
}

// Workers a repair round opened, as reported by the session. Consult workers are capped per head
// and may not use max/ultra; a report breaking either limit is rejected so it is fixed before push.
// adjudicate = the read-only arbiter opened when the session disputes a review finding.
const WORKER_PURPOSES = new Set(['review', 'e2e', 'consult', 'adjudicate']);
export const MAX_CONSULT_WORKERS = 2;
export function validateWorkers(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) fail('SC report workers must be an array');
  const workers = value.map((item, index) => {
    if (!item || typeof item !== 'object') fail(`workers[${index}] must be an object`);
    if (!WORKER_PURPOSES.has(item.purpose)) fail(`workers[${index}].purpose must be review, e2e, consult or adjudicate, got ${String(item.purpose).slice(0, 40)}`);
    for (const field of ['agent', 'model', 'effort']) {
      if (typeof item[field] !== 'string' || !item[field].trim()) fail(`workers[${index}].${field} is required`);
    }
    if (item.purpose === 'consult' && ['max', 'ultra'].includes(item.effort)) fail(`workers[${index}] consult effort ${item.effort} is above the allowed high`);
    const text = (field, limit) => (typeof item[field] === 'string' && item[field].trim() ? { [field]: item[field].trim().slice(0, limit) } : {});
    return { purpose: item.purpose, agent: item.agent.trim(), model: item.model.trim(), effort: item.effort.trim(), ...text('providerId', 80), ...text('workerId', 80), ...text('verdict', 500) };
  });
  const consults = workers.filter((item) => item.purpose === 'consult').length;
  if (consults > MAX_CONSULT_WORKERS) fail(`workers lists ${consults} consult workers; at most ${MAX_CONSULT_WORKERS} per head`);
  return workers;
}

// A review finding the session was allowed to fix but closes as no-change is a dispute with the
// reviewer. It is not the session's call alone: an adjudicate worker must have ruled, or the SC
// must say why none could be opened (missing route, no Orca tool, creation error).
export const ADJUDICATE_SKIPPED = 'adjudicate-skipped:';

// Findings about tests, docs, the PR body or handoff files are fixed, never disputed: changing them is cheap and
// never changes product behaviour. The one way out is a commit made after the review that already fixed it.
export const ALREADY_FIXED = 'already-fixed:';
const TEST_DOC_PATH_RE = /(^|\/)(docs|tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.md$/;
export function threadIdOf(item) {
  if (typeof item?.threadId === 'string' && item.threadId) return item.threadId;
  const head = String(item?.nativeId ?? '').split(':')[0];
  return head.startsWith('PRRT_') ? head : null;
}
export function testDocFeedbackKeys(task) {
  const threadPaths = new Map((task?.prSnapshot?.unresolvedThreads ?? [])
    .filter((thread) => typeof thread?.id === 'string' && typeof thread.path === 'string')
    .map((thread) => [thread.id, thread.path]));
  const keys = new Set();
  for (const item of task?.feedback ?? []) {
    if (!item?.key || ['ci', 'conflict'].includes(item.source)) continue;
    const file = item.path ?? threadPaths.get(threadIdOf(item)) ?? null;
    if (file && TEST_DOC_PATH_RE.test(file)) keys.add(item.key);
  }
  return keys;
}

// The second time a review thread comes back after an earlier task fixed it, the SC that fixes it must show the
// full inventory of the problem class and the chosen approach, not patch the one reported spot again.
export const INVENTORY = 'inventory:';
export const APPROACH = 'approach:';
export function assertRepeatInventory({ scs, task }) {
  const repeat = new Set((task?.repeatFindings ?? []).map((item) => item?.feedbackKey).filter(Boolean));
  if (!repeat.size) return;
  for (const sc of scs) {
    if (sc.status !== 'pass') continue;
    const keys = (sc.feedbackKeys ?? []).filter((key) => repeat.has(key));
    if (!keys.length) continue;
    const has = (prefix) => sc.evidence.some((line) => line.trim().startsWith(prefix) && line.trim().length > prefix.length + 10);
    if (!has(INVENTORY) || !has(APPROACH)) {
      fail(`[REPEAT_INVENTORY_REQUIRED] ${sc.id} fixes a repeated finding (${keys.join(', ')}) without "${INVENTORY}" (every case of this problem class and whether it is handled) and "${APPROACH}" (point fix or root change, and why) evidence lines`);
    }
  }
}

// already-fixed proof: the named commit is in the validated HEAD and not in the head the reviewer saw. A missing or
// unreadable reviewed head, or any git error other than "not an ancestor" (exit 1), proves nothing.
export function alreadyFixedProof({ worktree, validatedHead, gitFn }) {
  const ancestry = (a, b) => {
    try { gitOutput(['-C', worktree, 'merge-base', '--is-ancestor', a, b], gitFn); return 'yes'; }
    catch (error) { return error?.status === 1 ? 'no' : 'unknown'; }
  };
  return (sha, reviewedHead) => typeof reviewedHead === 'string' && /^[0-9a-f]{7,40}$/.test(reviewedHead)
    && ancestry(sha, validatedHead) === 'yes' && ancestry(sha, reviewedHead) === 'no';
}

export function assertDisputesAdjudicated({ scs, workers, task, fixedAfterReview = null }) {
  const permissions = new Map(taskRepairPolicy(task).items.map((item) => [item.key, item]));
  const ruled = (workers ?? []).some((item) => item.purpose === 'adjudicate');
  const testDoc = testDocFeedbackKeys(task);
  const shas = new Map((task?.feedback ?? []).map((item) => [item?.key, item?.sha]));
  for (const sc of scs) {
    if (sc.status !== 'no-change') continue;
    const mustFix = (sc.feedbackKeys ?? []).filter((key) => testDoc.has(key) && permissions.get(key)?.canChangeCode === true);
    if (!mustFix.length) continue;
    const fixedBy = sc.evidence.map((line) => line.trim()).find((line) => line.startsWith(ALREADY_FIXED))
      ?.slice(ALREADY_FIXED.length).trim().split(/\s+/)[0] ?? '';
    for (const key of mustFix) {
      const proven = /^[0-9a-f]{7,40}$/.test(fixedBy) && typeof fixedAfterReview === 'function' && fixedAfterReview(fixedBy, shas.get(key) ?? null);
      if (!proven) fail(`[TEST_DOC_MUST_FIX] ${sc.id} closes ${key} as no-change, but findings about tests, docs, the PR body or handoff files are fixed, not disputed or adjudicated; fix it, or add an evidence line "${ALREADY_FIXED} <commit>" naming the commit after the reviewed head that already fixed it`);
    }
  }
  for (const sc of scs) {
    if (sc.status !== 'no-change') continue;
    const disputed = (sc.feedbackKeys ?? []).filter((key) => {
      const item = permissions.get(key);
      // test/doc findings were settled above (fix, or a proven already-fixed commit); they get no arbiter
      return item?.canChangeCode === true && item.action === 'code-fix' && !testDoc.has(key);
    });
    if (!disputed.length || ruled) continue;
    if (sc.evidence.some((line) => line.trim().startsWith(ADJUDICATE_SKIPPED))) continue;
    fail(`[ADJUDICATE_REQUIRED] ${sc.id} closes P0/P1/P2 review feedback (${disputed.join(', ')}) as no-change without an adjudicate worker; open one from routing.json adjudicate, or add an evidence line starting with "${ADJUDICATE_SKIPPED}" stating why none could be opened`);
  }
}

export function validateScs(report, task) {
  const scs = Array.isArray(report) ? report : report?.scs;
  if (!Array.isArray(scs) || scs.length === 0) fail('SC report must contain a non-empty scs array');
  const feedback = task.feedback ?? [];
  if (!Array.isArray(feedback)) fail('task feedback must be an array');
  const expected = new Set(feedback.map((item) => item?.key));
  if ([...expected].some((key) => typeof key !== 'string' || !key.trim()) || expected.size !== feedback.length) fail('task feedback keys must be non-empty and unique');
  const permissions = new Map(taskRepairPolicy(task).items.map((item) => [item.key, item]));
  const ids = new Set();
  const covered = new Set();
  const checked = scs.map((sc, index) => {
    if (!sc || typeof sc !== 'object' || typeof sc.id !== 'string' || !sc.id.trim()) fail(`SC[${index}] id is required`);
    if (ids.has(sc.id.trim())) fail(`duplicate SC id: ${sc.id.trim()}`);
    ids.add(sc.id.trim());
    if (!['pass', 'no-change'].includes(sc.status)) fail(`SC[${index}] status must be pass or no-change`);
    if (!Array.isArray(sc.evidence) || sc.evidence.length === 0 || sc.evidence.some((item) => typeof item !== 'string' || !item.trim())) fail(`SC[${index}] evidence must be non-empty strings`);
    const keys = sc.feedbackKeys ?? (expected.size ? null : []);
    if (!Array.isArray(keys) || (expected.size && !keys.length) || new Set(keys).size !== keys.length) fail(`SC[${index}] feedbackKeys must name task feedback`);
    if (sc.status === 'pass' && !keys.length) fail(`[REPAIR_SCOPE_NO_CODE] SC[${index}] pass requires an authorized feedback key`);
    for (const key of keys) {
      if (!expected.has(key)) fail(`SC[${index}] contains an external feedback key: ${key}`);
      if (sc.status === 'pass' && permissions.get(key)?.canChangeCode !== true) {
        fail(`[REPAIR_SCOPE_NO_CODE] SC[${index}] cannot mark ${key} fixed; P3, mixed or unconfirmed findings require no-change/triage`);
      }
      covered.add(key);
    }
    return { id: sc.id.trim(), status: sc.status, evidence: sc.evidence, feedbackKeys: keys };
  });
  const missing = [...expected].filter((key) => !covered.has(key));
  if (missing.length) fail(`SC report does not cover task feedback: ${missing.join(', ')}`);
  const dispositions = feedback.map((item) => ({
    key: item.key, disposition: checked.some((sc) => sc.feedbackKeys.includes(item.key) && sc.status === 'pass') ? 'fixed' : 'no-change',
    ...(item.source === 'thread' || item.key.startsWith('thread:') ? { resolved: null, resolutionEvidence: 'not-checked-by-helper' } : {}),
  }));
  return { scs: checked, feedbackCoverage: { mode: expected.size ? 'task-feedback' : 'legacy-empty', requiredKeys: [...expected], coveredKeys: [...covered], dispositions, complete: true }, workers: Array.isArray(report) ? null : validateWorkers(report?.workers) };
}

function loadScs(scReport, task) {
  return validateScs(readJson(requireAbs(scReport, 'sc-report'), 'SC report'), task);
}

function rejectSkip(env = process.env) {
  for (const key of ['PREFLIGHT_SKIP', 'CINDY_PREFLIGHT_SKIP', 'CINDY_PREFLIGHT_FAST']) {
    if (env[key] && env[key] !== '0') fail(`${key} cannot authorize cindy repair validation or push`);
  }
}

export function preflightFile(env = process.env) {
  if (env.CINDY_PREFLIGHT_BIN) return env.CINDY_PREFLIGHT_BIN;
  return requireConfig('preflightFile', {
    env,
    hint: 'preflight 脚本的绝对路径，示例："/path/to/your/preflight.sh"。',
  });
}

function validationPolicy(_worktree, _task, _gitFn, env = process.env) {
  const file = preflightFile(env);
  if (!fs.existsSync(file)) fail(`cindy preflight script missing: ${file}`);
  const actual = fs.readFileSync(file, 'utf8');
  return { file, sourceHead: null, sha256: hash(actual) };
}

export function commitsMissingDco(worktree, fromSha, toSha, gitFn) {
  if (!isSha(fromSha) || !isSha(toSha) || fromSha === toSha) return [];
  const raw = gitOutput(['-C', worktree, 'log', '--no-merges', `${fromSha}..${toSha}`, '--format=%H%n%B%x1e'], gitFn);
  const missing = [];
  for (const entry of raw.split('\x1e')) {
    const text = entry.trim();
    if (!text) continue;
    const nl = text.indexOf('\n');
    const sha = (nl === -1 ? text : text.slice(0, nl)).trim();
    const body = nl === -1 ? '' : text.slice(nl + 1);
    if (!/^Signed-off-by:\s+\S.+/m.test(body)) missing.push(sha);
  }
  return missing;
}

function assertDco(worktree, fromSha, toSha, gitFn) {
  const missing = commitsMissingDco(worktree, fromSha, toSha, gitFn);
  if (missing.length) fail(`commits missing Signed-off-by: ${missing.join(', ')}`);
}

function validationPointer(paths, task, head) {
  return path.join(paths.validations, task.dispatchId, `${head}.json`);
}

function validationException(paths, task, sessionId, head, worktree, gitFn) {
  const binding = task.validationException;
  if (!binding) return null;
  const file = requireAbs(binding.approvalPath, 'validation exception approval');
  if (!under(file, paths.approvals)) fail('validation approval must be inside state/approvals');
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== binding.approvalSha256) fail('validation approval hash mismatch');
  const approval = JSON.parse(bytes);
  assertIdentity(approval, task, sessionId, 'validation approval');
  if (approval.kind !== 'local-preflight-exception' || approval.head !== head || approval.approvedBy !== 'user'
    || typeof approval.approvalRef !== 'string' || !approval.approvalRef.trim()
    || typeof approval.reason !== 'string' || !approval.reason.trim()
    || !Array.isArray(approval.allowedChangedPaths) || !approval.allowedChangedPaths.length) fail('validation approval is incomplete');
  const changed = gitOutput(['-C', worktree, 'diff', '--name-only', task.headRefOid, head], gitFn).trim().split('\n').filter(Boolean);
  if (changed.some((fileName) => !approval.allowedChangedPaths.includes(fileName))) fail('validation exception does not cover changed paths');
  return { approvalPath: file, approvalSha256: binding.approvalSha256, approvalRef: approval.approvalRef, reason: approval.reason };
}

const sha256Of = (value) => createHash('sha256').update(value).digest('hex');

// 默认的命令执行器：独立进程组 + 流式 0600 日志 + 无输出看门狗。返回日志全文；
// 非零退出/看门狗终止时抛出带 status/failureKind 的错误（与 execFileSync 的错误形状兼容）。
async function runLogged(binary, args, options) {
  const result = await runStreaming(binary, args, {
    cwd: options.cwd, env: options.env, logPath: options.logPath,
    stallMs: options.stallMs, timeoutMs: options.timeout, onGroup: options.onGroup, pgidFile: options.pgidFile,
  });
  const text = fs.readFileSync(options.logPath, 'utf8');
  if (result.exitCode === 0 && !result.failureKind) return text;
  throw Object.assign(new Error(`${binary} ${args.join(' ')} exited ${result.exitCode ?? result.signal ?? 'abnormally'}`), {
    status: result.exitCode, signal: result.signal, failureKind: result.failureKind, stdout: '', stderr: '', logPath: options.logPath,
  });
}

// 运行一步并保证日志文件落盘（不可变、0600）。注入的 runFn 若没写日志，就把它的输出写进去。
async function runLoggedStep(runFn, binary, args, base, logPath) {
  let output = '';
  let error = null;
  try { output = String(await runFn(binary, args, { ...base, logPath })); }
  catch (caught) {
    error = caught;
    output = String(caught?.stdout ?? '') + String(caught?.stderr ?? '');
  }
  if (!fs.existsSync(logPath)) {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(logPath, output, { flag: 'wx', mode: 0o600 });
  } else if (error) output = fs.readFileSync(logPath, 'utf8');
  return {
    ok: !error, output, exitCode: error ? (Number.isInteger(error.status) ? error.status : null) : 0,
    failureKind: error?.failureKind ?? null, logPath, logSha256: sha256Of(fs.readFileSync(logPath)),
  };
}

export async function validate({ home, taskPath, validatedHead, gitFn = command, runFn = runLogged, env = process.env, originUrl, slotPollMs = 250 } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), async () => {
  rejectSkip(env);
  const { paths, task } = taskFrom(home, taskPath);
  const stopHeartbeat = startActivityHeartbeat(paths, task, 'validate');
  let slot = null;
  try {
  const { sessionId } = boundSession(paths, task);
  if (!isSha(validatedHead)) fail('validated-head must be a 40-character SHA');
  assertTaskRepairScope(task, validatedHead);
  const worktree = taskWorktree(task);
  const forkUrl = originUrl ?? githubRepoUrl(resolveHeadRepo(task));
  const checkout = assertWorktree(worktree, task, gitFn, forkUrl);
  if (!checkout || checkout.head !== validatedHead) fail('worktree HEAD does not match validated-head');
  assertDco(worktree, task.headRefOid, validatedHead, gitFn);
  const exception = validationException(paths, task, sessionId, validatedHead, worktree, gitFn);
  const policy = exception ? null : validationPolicy(worktree, task, gitFn, env);
  const startedAt = new Date().toISOString();
  let exitCode = null;
  let outputHash = null;
  let status = exception ? 'approved-exception' : 'pass';
  let runtime = null;
  let log = null;
  let failureKind = null;
  let failure = null;
  let reusedFrom = null;
  let reusedTimes = null;
  let identityKey = null;
  if (!exception) {
    const config = validationConfig({ env });
    runtime = canonicalRuntime({ worktree });
    identityKey = { repo: task.repo, nodeId: task.nodeId, number: task.number, head: validatedHead, policySha256: policy.sha256, runtimeSha256: runtimeSha256(runtime) };
    const hit = lookupPass({ validations: paths.validations, identity: identityKey });
    if (hit) {
      reusedFrom = { receiptPath: hit.receiptPath, receiptSha256: hit.receiptSha256 };
      reusedTimes = { startedAt: hit.receipt.startedAt, finishedAt: hit.receipt.finishedAt };
      exitCode = 0;
      outputHash = hit.receipt.outputHash;
      log = { logPath: hit.receipt.logPath, logSha256: hit.receipt.logSha256 };
      failure = emptyFailureSet();
    } else {
      const queuedAt = Date.now();
      slot = await acquireValidationSlot({ home: paths.home, limit: config.concurrency, pollMs: slotPollMs });
      if (Date.now() - queuedAt > 1_000) {
        // 排队期间 worktree 可能已变：拿到槽位后重新核对，再决定是否真的运行。
        boundSession(paths, task);
        const again = assertWorktree(worktree, task, gitFn, forkUrl);
        if (!again || again.head !== validatedHead) fail('worktree HEAD changed while waiting for a validation slot');
      }
      const base = {
        cwd: worktree, env: { ...env, PREFLIGHT_SKIP: '0', TMPDIR: runtime.tmpdir }, timeout: config.timeoutMs,
        stallMs: config.stallMs, maxBuffer: 32 * 1024 * 1024, onGroup: (pgid) => slot.setGroup(pgid), pgidFile: slot.pgidFile,
      };
      const logPath = path.join(paths.validations, 'logs', `${task.dispatchId}-${validatedHead}-${randomUUID()}-preflight.log`);
      const step = await runLoggedStep(runFn, '/bin/bash', [policy.file], base, logPath);
      exitCode = step.exitCode;
      outputHash = step.logSha256;
      log = { logPath: step.logPath, logSha256: step.logSha256 };
      if (step.ok) {
        failure = emptyFailureSet();
        if (/^\[preflight\] skipped(?: |$)/m.test(step.output)) { status = 'fail'; failureKind = 'evidence-invalid'; failure = { state: 'unparsed', failureSet: [], failureSetSha256: null }; }
      } else {
        status = 'fail';
        failureKind = step.failureKind ?? 'test-failure';
        failure = step.failureKind ? { state: 'unparsed', failureSet: [], failureSetSha256: null } : parseFailureSet(step.output, { worktree });
      }
    }
  }
  let reason;
  try {
    const after = assertWorktree(worktree, task, gitFn, originUrl);
    if (!after || after.head !== validatedHead) fail('HEAD changed during local validation');
    if (policy && validationPolicy(worktree, task, gitFn, env).sha256 !== policy.sha256) fail('preflight policy changed during validation');
    if (runtime && runtimeSha256(canonicalRuntime({ worktree })) !== runtimeSha256(runtime)) fail('validation runtime fingerprint changed during validation');
  } catch (error) { status = 'fail'; reason = error.message; failureKind ??= 'evidence-invalid'; }
  const receipt = {
    schemaVersion: 2, kind: 'cindy-repair-validation', ...identity(task, sessionId), head: validatedHead,
    status, policy, exception, command: exception ? null : { binary: '/bin/bash', args: [policy.file] },
    exitCode, outputHash, ...(reason ? { reason } : {}),
    ...(runtime ? {
      validationEvidenceVersion: 1, parserVersion: PARSER_VERSION, runtime, runtimeSha256: runtimeSha256(runtime),
      logPath: log?.logPath ?? null, logSha256: log?.logSha256 ?? null,
      failureSetState: failure?.state ?? 'unparsed', failureSet: failure?.failureSet ?? [], failureSetSha256: failure?.failureSetSha256 ?? null,
      failureKind, reusedFrom, ...(reusedFrom ? { reusedAt: new Date().toISOString() } : {}),
    } : {}),
    startedAt: reusedTimes?.startedAt ?? startedAt, finishedAt: reusedTimes?.finishedAt ?? new Date().toISOString(),
  };
  const receiptPath = path.join(paths.validations, task.dispatchId, `${validatedHead}-${randomUUID()}.json`);
  immutableJson(receiptPath, receipt);
  const verification = { status, head: validatedHead, receiptPath, receiptSha256: hash(fs.readFileSync(receiptPath)) };
  atomicJson(validationPointer(paths, task, validatedHead), verification);
  if (status === 'pass' && !reusedFrom && identityKey) {
    publishPass({ validations: paths.validations, identity: identityKey, receiptPath, receiptSha256: verification.receiptSha256 });
  }
  return verification;
  } finally { slot?.release(); stopHeartbeat(); }
  });
}

function verifiedLocal(paths, task, sessionId, head, worktree, gitFn, receiptPath = null, env = process.env) {
  const pointer = readJson(validationPointer(paths, task, head), 'local validation pointer');
  const file = requireAbs(receiptPath ?? pointer.receiptPath, 'local validation receipt');
  if (!under(file, path.join(paths.validations, task.dispatchId)) || file !== pointer.receiptPath) fail('local validation receipt is not the latest bound receipt');
  const bytes = fs.readFileSync(file);
  if (hash(bytes) !== pointer.receiptSha256) fail('local validation receipt hash mismatch');
  const receipt = JSON.parse(bytes);
  assertIdentity(receipt, task, sessionId, 'local validation');
  if (receipt.schemaVersion !== 2 || receipt.kind !== 'cindy-repair-validation' || receipt.head !== head || pointer.head !== head) fail('local validation HEAD or schema mismatch');
  if (receipt.status === 'approved-exception') {
    const exception = validationException(paths, task, sessionId, head, worktree, gitFn);
    if (!exception || exception.approvalSha256 !== receipt.exception?.approvalSha256) fail('local validation exception is no longer bound');
  } else if (receipt.status !== 'pass' || receipt.exitCode !== 0
    || receipt.policy?.sha256 !== validationPolicy(worktree, task, gitFn, env).sha256) fail('local validation did not pass for this HEAD');
  return { status: receipt.status, head, receiptPath: file, receiptSha256: pointer.receiptSha256 };
}

function pages(value, key) {
  return (Array.isArray(value) ? value : [value]).flatMap((page) => Array.isArray(page?.[key]) ? page[key] : []);
}

function checkBucket(check) {
  if (check.status !== 'completed') return 'pending';
  if (['success', 'skipped', 'neutral'].includes(check.conclusion)) return 'pass';
  if (['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale'].includes(check.conclusion)) return 'fail';
  return 'unknown';
}

function workflowRunId(link, repo) {
  try {
    const url = new URL(link);
    const prefix = `/${repo}/actions/runs/`;
    if (url.hostname !== 'github.com' || !url.pathname.startsWith(prefix)) return null;
    const id = url.pathname.slice(prefix.length).split('/')[0];
    return /^\d+$/.test(id) ? id : null;
  } catch { return null; }
}

function legacyCheckStatus(task, head, ghFn) {
  const ci = { head, requiredGreen: false, requiredChecks: [], optionalFailures: [], pending: [], missing: [] };
  const pr = ghPr(task, ghFn, false);
  if (pr.headRefOid !== head) return { ...ci, missing: ['GitHub PR HEAD has not reached the validated HEAD'] };
  const required = ghJson(['pr', 'checks', String(task.number), '--repo', task.repo, '--required', '--json', 'name,state,bucket,link'], ghFn);
  if (!Array.isArray(required)) fail('gh required PR checks did not return an array');
  if (required.length === 0) return { ...ci, missing: ['required-checks'] };
  const checks = pages(ghJson(['api', `repos/${task.repo}/commits/${head}/check-runs?per_page=100`, '--paginate', '--slurp'], ghFn), 'check_runs')
    .filter((check) => check.head_sha === head);
  const runs = new Map();
  for (const expected of required) {
    const found = checks.find((check) => check.name === expected.name && check.details_url === expected.link);
    if (!found) { ci.missing.push(expected.name); continue; }
    const runId = workflowRunId(found.details_url, task.repo);
    let runHeadSha = null;
    if (runId) {
      if (!runs.has(runId)) runs.set(runId, ghJson(['api', `repos/${task.repo}/actions/runs/${runId}`], ghFn));
      runHeadSha = runs.get(runId)?.head_sha;
      if (runHeadSha !== head) { ci.missing.push(`${expected.name}:workflow-head-mismatch`); continue; }
    }
    const check = {
      id: found.id, name: found.name, headSha: found.head_sha, link: found.details_url,
      state: found.status, conclusion: found.conclusion, bucket: checkBucket(found), runId, runHeadSha,
    };
    ci.requiredChecks.push(check);
    if (check.bucket === 'pending' || check.bucket === 'unknown') ci.pending.push(check.name);
  }
  const requiredLinks = new Set(required.map((check) => check.link));
  ci.optionalFailures = checks.filter((check) => !requiredLinks.has(check.details_url) && checkBucket(check) === 'fail')
    .map((check) => ({ id: check.id, name: check.name, headSha: check.head_sha, link: check.details_url, conclusion: check.conclusion }));
  if (ghPr(task, ghFn, false).headRefOid !== head) ci.missing.push('PR HEAD changed during CI verification');
  ci.requiredGreen = ci.missing.length === 0 && ci.pending.length === 0
    && ci.requiredChecks.length === required.length && ci.requiredChecks.every((check) => check.bucket === 'pass');
  return ci;
}

export function policyCiResult(ci, head) {
  return {head, requiredGreen:ci.status === 'green', policyHash:ci.policyHash,
    requiredChecks:(ci.required??[]).map(r=>({name:r.context,bucket:r.status==='green'?'pass':r.status==='failed'?'fail':'pending',headSha:head,runId:r.evidence?.runId ?? null,evidence:r.evidence})),
    optionalFailures:[],pending:(ci.required??[]).filter(r=>r.status==='pending').map(r=>r.context),
    missing:ci.status==='unknown'?[ci.reason??'required-policy-unknown']:[]};
}
function checkStatus(task, head, ghFn) {
  const pr=ghJson(['pr','view',String(task.number),'--repo',task.repo,'--json','id,number,state,isDraft,headRefOid,baseRefOid,baseRefName'],ghFn);
  if(pr.headRefOid!==head || pr.state!=='OPEN' || pr.isDraft) return policyCiResult({status:'unknown',reason:'PR changed before CI collection'},head);
  return policyCiResult(collectCindyCiSync({pr:{...pr,repo:task.repo},ghFn:args=>ghFn(GH,args)}),head);
}

export function ciResult(ci) {
  const failures = ci.requiredChecks.filter((check) => check.bucket === 'fail');
  if (failures.length) return { status: 'blocked', blockedKind: 'required-ci', reason: `required CI failed: ${failures.map((check) => check.name).join(', ')}` };
  if (!ci.requiredGreen) return { status: 'waiting-ci', reason: `waiting for current HEAD required CI: ${[...ci.missing, ...ci.pending].join(', ')}` };
  return { status: 'complete' };
}

function allNoChange(scs) {
  return Array.isArray(scs) && scs.length > 0 && scs.every((sc) => sc.status === 'no-change');
}

// One CI retrigger per PR head. The quota lives in its own file, keyed by the head it was
// spent on, and is claimed before the push: a lost or overwritten result file, or a later
// task on the same head, cannot hand it out again.
function retriggerLedgerFile(paths, nodeId) {
  return path.join(paths.home, 'state', 'ci-retrigger', `${encodeURIComponent(nodeId)}.json`);
}
function readRetriggerLedger(paths, nodeId) {
  try { return JSON.parse(fs.readFileSync(retriggerLedgerFile(paths, nodeId), 'utf8')) ?? {}; } catch { return {}; }
}
function claimRetrigger(paths, task, record) {
  atomicJson(retriggerLedgerFile(paths, task.nodeId), { ...readRetriggerLedger(paths, task.nodeId), [record.sourceHead]: record });
}
function priorCiRetrigger(paths, task, extra = null) {
  const matches = (record) => record && (record.sourceHead === task.headRefOid || record.head === task.headRefOid);
  const ledger = Object.values(readRetriggerLedger(paths, task.nodeId)).find(matches);
  if (ledger) return ledger;
  if (matches(extra?.ciRetrigger)) return extra.ciRetrigger;
  let names = [];
  try { names = fs.readdirSync(paths.results); } catch { return extra?.ciRetrigger ?? null; }
  for (const name of names.filter((item) => item.endsWith('.json'))) {
    let result;
    try { result = JSON.parse(fs.readFileSync(path.join(paths.results, name), 'utf8')); } catch { continue; }
    if (result?.nodeId !== task.nodeId) continue;
    if (matches(result.ciRetrigger)) return result.ciRetrigger;
  }
  return extra?.ciRetrigger ?? null;
}

export function pushIfNeeded(worktree, task, validatedHead, remoteHead, gitFn, originUrl) {
  const forkUrl = originUrl ?? githubRepoUrl(resolveHeadRepo(task));
  if (isBaseGithubUrl(forkUrl)) fail(`refusing to push to base repo ${REPO}`);
  if (remoteHead === validatedHead) return { pushed: false };
  const checkout = assertWorktree(worktree, task, gitFn, forkUrl);
  if (!checkout || checkout.head !== validatedHead) fail('local HEAD changed before push');
  const latest = gitOutput(['ls-remote', forkUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (latest !== remoteHead) fail('remote branch changed before push');
  const ancestor = (() => {
    try { gitOutput(['-C', worktree, 'merge-base', '--is-ancestor', remoteHead, validatedHead], gitFn); return true; }
    catch { return false; }
  })();
  if (!ancestor) fail('remote branch advanced independently; refusing non-fast-forward push');
  assertOriginPushTargets(worktree, resolveHeadRepo(task), gitFn, forkUrl);
  gitOutput(['-C', worktree, 'push', 'origin', `${validatedHead}:refs/heads/${task.headRefName}`], gitFn);
  const after = gitOutput(['ls-remote', forkUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (after !== validatedHead) fail('remote branch changed after push; pushed commit requires reconciliation');
  return { pushed: true };
}

export function finalize({ home, taskPath, scReport, validatedHead, validationReceipt, keelRun, keelRoot = keelLedgerRoot(), ghFn = command, gitFn = command, env = process.env, originUrl } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  rejectSkip(env);
  const { paths, task } = taskFrom(home, taskPath);
  recordActivity(paths, task, 'finalize');
  const { sessionId } = boundSession(paths, task);
  if (!isSha(validatedHead)) fail('validated-head must be a 40-character SHA');
  const pr = ghPr(task, ghFn, false);
  const worktree = taskWorktree(task);
  originUrl = originUrl ?? githubRepoUrl(resolveHeadRepo(task));
  if (isBaseGithubUrl(originUrl)) fail(`refusing to push to base repo ${REPO}`);
  const checkout = assertWorktree(worktree, { ...task, headRefOid: validatedHead }, gitFn, originUrl);
  if (!checkout || checkout.head !== validatedHead) fail('worktree HEAD does not match validated-head');
  const branchHead = gitOutput(['ls-remote', originUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (!isSha(branchHead)) fail('remote branch head is unavailable');
  if (branchHead !== pr.headRefOid) fail(`remote branch and PR head disagree: ${branchHead} != ${pr.headRefOid}`);
  const { scs, feedbackCoverage, workers } = loadScs(scReport, task);
  assertDisputesAdjudicated({ scs, workers, task, fixedAfterReview: alreadyFixedProof({ worktree, validatedHead, gitFn }) });
  assertRepeatInventory({ scs, task });
  const workersField = workers ? { workers } : {};
  const emptyRetrigger = allNoChange(scs) && isEmptyCiRetrigger(worktree, task.headRefOid, validatedHead, gitFn);
  assertTaskRepairScope(task, validatedHead, { emptyRetrigger });
  assertDco(worktree, task.headRefOid, validatedHead, gitFn);
  if (validatedHead !== task.headRefOid && scs.every((sc) => sc.status === 'no-change') && !emptyRetrigger) {
    fail('[REPAIR_SCOPE_NO_CODE] Changed HEAD requires an SC bound to an authorized fix; no-change cannot cover commits');
  }
  const noChange = validatedHead === task.headRefOid && branchHead === validatedHead && scs.every((sc) => sc.status === 'no-change');
  const verification = (noChange || emptyRetrigger)
    ? { status: 'not-required-no-change', head: validatedHead, localTests: 'not-run', reason: emptyRetrigger
      ? 'signed empty commit retriggered required CI once; local tests were not required'
      : 'all SCs are no-change and task, checkout and remote HEAD match' }
    : verifiedLocal(paths, task, sessionId, validatedHead, worktree, gitFn, validationReceipt, env);
  const keel = verifyKeelRun({ task, runId: keelRun, root: keelRoot, validatedHead, verification });
  const prior = fs.existsSync(path.join(paths.results, `${task.dispatchId}.json`))
    ? readJson(path.join(paths.results, `${task.dispatchId}.json`), 'repair result') : null;
  const recorded = priorCiRetrigger(paths, task, prior);
  // A session-made empty commit spends the same one-per-head quota, and is checked before it is pushed.
  if (emptyRetrigger && recorded && recorded.head !== validatedHead) {
    return saveResult(paths, task, sessionId, {
      status: 'blocked', blockedKind: 'external',
      reason: 'required CI still failed after one no-change empty-commit retrigger; the extra empty commit was not pushed',
      head: task.headRefOid, scs, feedbackCoverage, ...workersField, keel, verification, checks: [], pushed: false, ciRetrigger: recorded,
    });
  }
  const sessionRetrigger = emptyRetrigger && !recorded
    ? { sourceHead: task.headRefOid, method: 'empty-commit', head: validatedHead, at: new Date().toISOString() } : null;
  if (sessionRetrigger) claimRetrigger(paths, task, sessionRetrigger);
  const push = pushIfNeeded(worktree, task, validatedHead, branchHead, gitFn, originUrl);
  let ci;
  try { ci = checkStatus(task, validatedHead, ghFn); }
  catch (error) {
    return saveResult(paths, task, sessionId, { status: 'blocked', blockedKind: 'ci-transport', reason: error.message,
      head: validatedHead, scs, feedbackCoverage, ...workersField, keel, verification, checks: [], pushed: push.pushed,
      ...(sessionRetrigger ?? recorded ? { ciRetrigger: sessionRetrigger ?? recorded } : {}) });
  }
  if (allNoChange(scs) && ciResult(ci).blockedKind === 'required-ci') {
    if (recorded) {
      return saveResult(paths, task, sessionId, {
        status: 'blocked', blockedKind: 'external',
        reason: 'required CI still failed after one no-change empty-commit retrigger',
        head: validatedHead, scs, feedbackCoverage, ...workersField, keel, verification, ci, checks: ci.requiredChecks,
        pushed: push.pushed, ciRetrigger: recorded,
      });
    }
    if (!emptyRetrigger && validatedHead === task.headRefOid) {
      gitOutput(['-C', worktree, '-c', 'commit.gpgsign=false', 'commit', '-s', '--allow-empty', '-m', 'ci: retrigger required checks'], gitFn);
      const retriggerHead = gitOutput(['-C', worktree, 'rev-parse', 'HEAD'], gitFn);
      assertDco(worktree, task.headRefOid, retriggerHead, gitFn);
      const ciRetrigger = { sourceHead: task.headRefOid, method: 'empty-commit', head: retriggerHead, at: new Date().toISOString() };
      // Spent before the push: if the push fails midway, a second attempt would be a second retrigger.
      claimRetrigger(paths, task, ciRetrigger);
      const retriggerPush = pushIfNeeded(worktree, task, retriggerHead, validatedHead, gitFn, originUrl);
      return saveResult(paths, task, sessionId, {
        status: 'waiting-ci', reason: 'retried required CI once with a signed empty commit',
        head: retriggerHead, scs, feedbackCoverage, ...workersField, keel, verification, ci, checks: ci.requiredChecks,
        pushed: retriggerPush.pushed, ciRetrigger,
      });
    }
  }
  const carried = sessionRetrigger ?? recorded;
  return saveResult(paths, task, sessionId, {
    ...ciResult(ci), head: validatedHead, scs, feedbackCoverage, ...workersField, keel, verification, ci, checks: ci.requiredChecks, pushed: push.pushed,
    ...(carried ? { ciRetrigger: carried } : {}),
  });
  });
}

export function recheck({ home, taskPath, validatedHead, ghFn = command, gitFn = command, originUrl, env = process.env } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  const { paths, task } = taskFrom(home, taskPath);
  recordActivity(paths, task, 'recheck');
  originUrl = originUrl ?? githubRepoUrl(resolveHeadRepo(task));
  const { sessionId } = boundSession(paths, task);
  const previous = readJson(path.join(paths.results, `${task.dispatchId}.json`), 'repair result');
  if (previous.schemaVersion !== 2 || previous.kind !== 'cindy-repair-result') fail('legacy result is unverified; a new finalize receipt is required');
  assertIdentity(previous, task, sessionId, 'repair result');
  const head = validatedHead ?? previous.head;
  if (!isSha(head) || previous.head !== head) fail('recheck HEAD does not match the result');
  const { scs, feedbackCoverage } = validateScs(previous.scs, task);
  const worktree = taskWorktree(task);
  const emptyRetrigger = previous.ciRetrigger?.method === 'empty-commit' && isEmptyCiRetrigger(worktree, task.headRefOid, head, gitFn);
  assertTaskRepairScope(task, head, { emptyRetrigger });
  const checkout = assertWorktree(worktree, task, gitFn, originUrl);
  if (!checkout || checkout.head !== head) fail('recheck worktree HEAD changed');
  let verification;
  if (previous.verification?.status === 'not-required-no-change') {
    if ((head !== task.headRefOid && !emptyRetrigger) || !previous.scs.every((sc) => sc.status === 'no-change')) fail('no-change verification cannot cover code changes');
    verification = previous.verification;
  } else {
    verification = verifiedLocal(paths, task, sessionId, head, worktree, gitFn, previous.verification?.receiptPath, env);
    if (verification.receiptSha256 !== previous.verification?.receiptSha256) fail('result validation receipt hash mismatch');
  }
  const remoteHead = gitOutput(['ls-remote', originUrl, `refs/heads/${task.headRefName}`], gitFn).split(/\s+/)[0];
  if (!isSha(remoteHead)) fail('remote branch head is unavailable during recheck');
  const observedPrHead = ghPr(task, ghFn, false).headRefOid;
  const common = { head, scs, feedbackCoverage, ...(previous.workers ? { workers: previous.workers } : {}), keel: previous.keel, verification, pushed: previous.pushed === true, remoteHead, observedPrHead };
  if (remoteHead !== observedPrHead) {
    return saveResult(paths, task, sessionId, { ...common, status: 'waiting-ci', reason: 'GitHub PR and remote branch views differ', checks: [],
      ci: { head, requiredGreen: false, requiredChecks: [], optionalFailures: [], pending: [], missing: ['github-remote-head-mismatch'] } }, { requirePrLock: true });
  }
  if (remoteHead !== head) {
    return saveResult(paths, task, sessionId, { ...common, status: 'blocked', blockedKind: 'head-drift',
      reason: 'remote HEAD advanced independently; preserve local work and reconcile before validation', checks: [],
      drift: { validatedHead: head, remoteHead, githubHead: observedPrHead, sourceHead: task.headRefOid } }, { requirePrLock: true });
  }
  const ci = checkStatus(task, head, ghFn);
  const recorded = priorCiRetrigger(paths, task, previous);
  if (allNoChange(scs) && ciResult(ci).blockedKind === 'required-ci' && recorded) {
    return saveResult(paths, task, sessionId, {
      ...common, status: 'blocked', blockedKind: 'external',
      reason: 'required CI still failed after one no-change empty-commit retrigger',
      ci, checks: ci.requiredChecks, ciRetrigger: recorded,
    }, { requirePrLock: true });
  }
  return saveResult(paths, task, sessionId, { ...common, ...ciResult(ci), ci, checks: ci.requiredChecks, ...(recorded ? { ciRetrigger: recorded } : {}) }, { requirePrLock: true });
  });
}

export function blocked({ home, taskPath, reason, ghFn = command } = {}) {
  return withHelperOp(home, peekTaskNumber(taskPath), () => {
  const { paths, task } = taskFrom(home, taskPath);
  recordActivity(paths, task, 'blocked');
  const { sessionId } = boundSession(paths, task);
  if (typeof reason !== 'string' || !reason.trim()) fail('blocked reason is required');
  const validationBlock = latestFailedValidation(paths, task);
  return saveResult(paths, task, sessionId, {
    status: 'blocked', blockedKind: 'external', reason: reason.trim(),
    head: task.headRefOid, worktree: taskWorktree(task), ...(validationBlock ? { validationBlock } : {}),
  });
  });
}

/**
 * validate 类阻塞用来判断「base 是否真的变了」的依据：被验证 head 与 base 的 merge-base。
 * base 分支 tip 前进而 merge-base 不变，不算环境变化。取不到（对象缺失、唯一性不成立）返回 null。
 */
export function validationMergeBase({ worktree, validatedHead, baseRefOid, baseRefName, gitFn = command } = {}) {
  if (!worktree || !isSha(validatedHead)) return null;
  const candidates = [isSha(baseRefOid) ? baseRefOid : null, baseRefName ? `refs/remotes/upstream/${baseRefName}` : null].filter(Boolean);
  for (const base of candidates) {
    try {
      const found = gitOutput(['-C', worktree, 'merge-base', '--all', validatedHead, base], gitFn).split('\n').map((line) => line.trim()).filter(Boolean);
      if (found.length === 1 && isSha(found[0])) return found[0];
    } catch { /* 对象不在本地：试下一个候选 */ }
  }
  return null;
}

// 阻塞若源于本地 validate 失败，把那份失败收据的指纹带给 watcher，供它判断环境是否真的变了。
function latestFailedValidation(paths, task) {
  try {
    const dir = path.join(paths.validations, task.dispatchId);
    const files = fs.readdirSync(dir).filter((name) => /^[0-9a-f]{40}-[0-9a-f-]{36}\.json$/.test(name))
      .map((name) => ({ file: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.at - a.at);
    if (!files.length) return null;
    const bytes = fs.readFileSync(files[0].file);
    const receipt = JSON.parse(bytes);
    if (receipt.status === 'pass' || receipt.status === 'approved-exception') return null;
    const snapshot = task.prSnapshot?.pr ?? {};
    return {
      validatedHead: receipt.head,
      mergeBase: validationMergeBase({ worktree: taskWorktree(task), validatedHead: receipt.head, baseRefOid: snapshot.baseRefOid, baseRefName: snapshot.baseRefName }),
      policySha256: receipt.policy?.sha256 ?? null, runtimeSha256: receipt.runtimeSha256 ?? null,
      failureSetState: receipt.failureSetState ?? 'legacy', failureSetSha256: receipt.failureSetSha256 ?? null,
      failureKind: receipt.failureKind ?? null, receiptSha256: hash(bytes),
    };
  } catch { return null; }
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

export function scheduleCreatePayload(params) {
  if (!params || typeof params !== 'object') fail('schedule params required');
  const { fallback, fallbackUsed, fallbackReason, ...rest } = params;
  void fallback; void fallbackUsed; void fallbackReason;
  return rest;
}
export function clearOwnerUnknown({ home, pr, nodeId, now = new Date().toISOString() }) {
  return withHelperOp(home, pr, () => {
  const root = requireAbs(home, 'home');
  const lock = acquireLock(root, `pr-${nodeId}`);
  if (lock.held) fail('PR 状态锁占用，请稍后重试');
  try {
    refuseDeployLock(root);
    const previous = readPr(root, nodeId) || {};
    if (previous.needsHuman?.reason !== 'owner-unknown') fail('PR 没有 owner-unknown 标记');
    const abandonedId = previous.needsHuman.abandonedDispatchId ?? previous.pendingDispatch?.dispatchId;
    const abandoned = [...(previous.abandonedDispatches ?? []), abandonedId].filter(Boolean);
    const entry = {
      ...previous, number: Number(pr), nodeId,
      needsHuman: null, pendingDispatch: null, dispatchError: null, clearedOwnerUnknownAt: now,
      abandonedDispatches: [...new Set(abandoned)],
    };
    writePr(root, nodeId, entry);
    return entry;
  } finally { lock.release(); }
  });
}

function isLinkedWorktree(worktree, plugin, gitFn) {
  try {
    const common = gitOutput(['-C', worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir'], gitFn);
    const root = gitOutput(['-C', plugin, 'rev-parse', '--path-format=absolute', '--git-common-dir'], gitFn);
    return fs.realpathSync(common) === fs.realpathSync(root);
  } catch { return false; }
}
function removeWatchCheckout({ plugin, worktree, number, branch, gitFn, force = false }) {
  if (path.resolve(worktree) !== path.resolve(watchWorktreePath(plugin, number))) fail('refusing to remove unexpected path');
  if (isLinkedWorktree(worktree, plugin, gitFn)) {
    gitOutput(['-C', plugin, 'worktree', 'remove', worktree], gitFn);
    try { gitOutput(['-C', plugin, 'branch', force ? '-D' : '-d', branch], gitFn); } catch {}
    return 'worktree';
  }
  fs.rmSync(worktree, { recursive: true, force: false });
  return 'clone';
}
function refExists(worktree, ref, gitFn) {
  try { gitOutput(['-C', worktree, 'rev-parse', '--verify', ref], gitFn); return true; }
  catch { return false; }
}
export function localCommitsNotReachable({ worktree, gitFn, branch, headRefName }) {
  const excludes = [];
  for (const ref of [`origin/${headRefName}`, 'upstream/main', 'origin/main']) {
    if (headRefName && refExists(worktree, ref, gitFn)) excludes.push(ref);
  }
  const args = ['-C', worktree, 'rev-list', branch];
  if (excludes.length) args.push('--not', ...excludes);
  const out = gitOutput(args, gitFn);
  return String(out).split(/\n/).map((item) => item.trim()).filter(Boolean);
}
export function cleanupWatch({ home, pr, ghFn = command, gitFn = command, env = process.env, now = new Date().toISOString() }) {
  return withHelperOp(home, pr, () => {
  const plugin = pluginRepoPath(env);
  const number = Number(pr);
  const view = ghJson(['pr', 'view', String(number), '--repo', REPO, '--json', 'state,headRefName'], ghFn);
  if (!['MERGED', 'CLOSED'].includes(view.state)) fail('cleanup requires MERGED or CLOSED PR');
  const worktree = watchWorktreePath(plugin, number);
  const branch = watchBranchName(number);
  if (!fs.existsSync(worktree)) return { removed: false, reason: 'missing', worktree, branch };
  const status = gitOutput(['-C', worktree, 'status', '--porcelain'], gitFn);
  if (status) fail('worktree is dirty');
  if (view.state === 'CLOSED') return { removed: false, reason: 'closed-unmerged', worktree, branch };
  const unreachable = localCommitsNotReachable({ worktree, gitFn, branch, headRefName: view.headRefName });
  let backup = null;
  if (unreachable.length) {
    backup = backupWatchBranch({ plugin, number, branch, gitFn, now, worktree });
    gitOutput(['bundle', 'verify', backup.bundlePath], gitFn);
  }
  removeWatchCheckout({ plugin, worktree, number, branch, gitFn, force: unreachable.length > 0 });
  return { removed: true, worktree, branch, backup, unreachableCount: unreachable.length };
  });
}

// branchAncestorOfMain 判断 watch 分支的提交是否已全部并入 origin/main（即已被合并、
// 不会因删除分支丢失内容）。用于决定自动清理时是否需要先备份。
export function branchAncestorOfMain(plugin, branch, gitFn = command, worktree = null) {
  const cwd = worktree && fs.existsSync(worktree) ? worktree : plugin;
  for (const ref of ['upstream/main', 'origin/main']) {
    try {
      gitOutput(['-C', cwd, 'merge-base', '--is-ancestor', branch, ref], gitFn);
      return true;
    } catch {}
  }
  return false;
}

// backupWatchBranch 在删除前把 watch 分支打成 git bundle，存进插件仓的
// `_backup/pr<N>-<日期>/` 下，只在分支可能含未合入 main 的提交时调用。
export function backupWatchBranch({ plugin, number, branch, gitFn = command, now = new Date().toISOString(), worktree } = {}) {
  const day = now.slice(0, 10);
  const dir = path.join(plugin, '_backup', `pr${number}-${day}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const bundlePath = path.join(dir, `${String(branch).replace(/\//g, '-')}.bundle`);
  const cwd = worktree && fs.existsSync(worktree) ? worktree : plugin;
  gitOutput(['-C', cwd, 'bundle', 'create', bundlePath, branch], gitFn);
  return { bundlePath };
}

// autoCleanupWatch 是脚本自己（无人工环节）对 watch worktree/分支执行的兜底清理：
// 只在明确已合并、worktree 干净的前提下删除；分支已完全并入 main 直接删，否则先
// bundle 备份再强删；worktree 脏、PR 未合并、或出现任何异常都只记录、不删除。
export function autoCleanupWatch({
  home, pr, plugin, gitFn = command, ghFn = command, env = process.env,
  now = new Date().toISOString(), knownMerged = false,
}) {
  const number = Number(pr);
  const repoPlugin = plugin || pluginRepoPath(env);
  const branch = watchBranchName(number);
  const worktree = watchWorktreePath(repoPlugin, number);
  try {
    if (!knownMerged) {
      const view = ghJson(['pr', 'view', String(number), '--repo', REPO, '--json', 'state'], ghFn);
      if (view.state !== 'MERGED') return { removed: false, reason: 'not-merged', worktree, branch };
    }
    if (!fs.existsSync(worktree)) {
      try { gitOutput(['-C', repoPlugin, 'branch', '-d', branch], gitFn); } catch {}
      return { removed: true, worktree, branch, backup: null, note: 'worktree-missing' };
    }
    const status = gitOutput(['-C', worktree, 'status', '--porcelain'], gitFn);
    if (status) return { removed: false, reason: 'dirty', worktree, branch };
    const ancestor = branchAncestorOfMain(repoPlugin, branch, gitFn, worktree);
    let backup = null;
    if (!ancestor) backup = backupWatchBranch({ plugin: repoPlugin, number, branch, gitFn, now, worktree });
    removeWatchCheckout({ plugin: repoPlugin, worktree, number, branch, gitFn, force: !ancestor });
    return { removed: true, worktree, branch, backup };
  } catch (error) {
    return { removed: false, reason: 'error', error: String(error?.message || error), worktree, branch };
  }
}

export function lockDoctor({ home } = {}) {
  return inspectLocks(requireAbs(home, 'home'));
}
export function lockDoctorClearGuard({ home, lockName, now } = {}) {
  return clearOrphanGuard(requireAbs(home, 'home'), lockName, now);
}

async function cli(argv) {
  const args = [...argv];
  const modes = new Set(['prepare', 'validate', 'finalize', 'recheck', 'blocked', 'cleanup', 'clear-owner-unknown', 'lock-doctor']);
  const modeIndex = args.findIndex((item) => modes.has(item));
  const mode = modeIndex >= 0 ? args.splice(modeIndex, 1)[0] : undefined;
  const value = (name, required = true) => {
    const index = args.indexOf(name);
    if (index < 0) { if (required) fail(`${name} is required`); return undefined; }
    const item = args[index + 1];
    if (!item || item.startsWith('--')) fail(`${name} requires a value`);
    return item;
  };
  const home = value('--home');
  let result;
  if (mode === 'cleanup') result = cleanupWatch({ home, pr: value('--pr') });
  else if (mode === 'clear-owner-unknown') result = clearOwnerUnknown({ home, pr: value('--pr'), nodeId: value('--node-id') });
  else if (mode === 'lock-doctor') {
    const lockName = value('--clear-guard', false);
    result = lockName ? lockDoctorClearGuard({ home, lockName }) : lockDoctor({ home });
  }
  else {
    const task = value('--task');
    if (mode === 'prepare') result = prepare({ home, taskPath: task });
    else if (mode === 'validate') result = await validate({ home, taskPath: task, validatedHead: value('--validated-head') });
    else if (mode === 'finalize') result = finalize({ home, taskPath: task, scReport: value('--sc-report'), validatedHead: value('--validated-head'), validationReceipt: value('--validation-receipt', false), keelRun: value('--keel-run', false) });
    else if (mode === 'recheck') result = recheck({ home, taskPath: task, validatedHead: value('--validated-head', false) });
    else if (mode === 'blocked') result = blocked({ home, taskPath: task, reason: value('--reason') });
    else fail('mode must be prepare, validate, finalize, recheck, blocked, cleanup, clear-owner-unknown, or lock-doctor');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (mode === 'validate' && result.status === 'fail') process.exitCode = 1;
}

if (process.argv[1] && fs.existsSync(process.argv[1])
  && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try { await cli(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`cindy-repair: ${error.message}\n`); process.exitCode = Number(error.exitCode) || 1; }
}
