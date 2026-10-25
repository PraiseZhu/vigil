#!/usr/bin/env node
// 修正轮沙箱（#60 SC3 / SC4）：pi 和预检都只有 bwrap 一条路，没有任何开关能绕过。
// 复用 #47 的 sandbox.mjs：遮罩名单（maskList）、参数拼装（buildBwrapArgs）、探测（probeBwrap）。
import fs from 'node:fs';
import path from 'node:path';
import { buildBwrapArgs, maskList, probeBwrap, sandboxEnv } from './sandbox.mjs';

/** 预检子进程的环境白名单：比 pi 少 LLM_PROXY_API_KEY，也不带两个沙箱内部变量。 */
export const PREFLIGHT_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'TERM',
  'TMPDIR',
  'NODE_OPTIONS',
]);

/** pi 的环境白名单沿用 sandbox.mjs（含 LLM_PROXY_API_KEY）。 */
export const PI_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'TERM',
  'TMPDIR',
  'LLM_PROXY_API_KEY',
  'NODE_OPTIONS',
]);

function readRawProfile(profile, injected) {
  if (injected && typeof injected === 'object') return injected;
  try {
    return JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
  } catch {
    return {};
  }
}

function prepareDirs(roundDir) {
  for (const dir of [roundDir, path.join(roundDir, 'home'), path.join(roundDir, 'tmp'), path.join(roundDir, 'home-acc')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/** 拼一次沙箱参数。pi 和预检用同一个函数，区别只在环境和命令。 */
export function buildPrbotSandbox({
  home,
  profile,
  hostConfig,
  roundDir,
  worktree,
  env = process.env,
  rawProfile,
  model = true,
  socketPath,
  sandboxBin,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('修正轮沙箱需要绝对路径的 home');
  if (typeof roundDir !== 'string' || !path.isAbsolute(roundDir)) throw new Error('修正轮沙箱需要绝对路径的 roundDir');
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) throw new Error('修正轮沙箱需要绝对路径的 worktree');
  prepareDirs(roundDir);
  const masks = maskList({
    rawProfile: readRawProfile(profile, rawProfile),
    profile,
    hostConfig,
    env: { ...process.env, HOME: env.HOME || process.env.HOME },
    home,
  });
  const sandboxEnvironment = model
    ? sandboxEnv({ base: env, roundDir, socketPath, sandboxBin })
    : sandboxEnv({
        base: env,
        roundDir,
        sandboxBin,
        allowlist: PREFLIGHT_ENV_ALLOWLIST,
        internal: [],
      });
  const args = buildBwrapArgs({
    home,
    profile,
    roundDir,
    masks,
    binds: [worktree, roundDir],
    env: sandboxEnvironment,
  });
  return { args, env: sandboxEnvironment, masks };
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0] || '';
}

/**
 * 起 pi 的唯一入口（SC3）。bwrap 不在 / 探针失败 → 不跑模型，返回 unavailable。
 * 没有任何环境变量或配置项能走到「不套 bwrap」这条路。
 */
export async function runPiInSandbox({
  home,
  profile,
  hostConfig,
  roundDir,
  worktree,
  piCommand,
  prompt,
  env = process.env,
  run,
  rawProfile,
  timeoutMs = 60 * 60 * 1000,
  sandboxBin,
} = {}) {
  if (typeof run !== 'function') throw new Error('runPiInSandbox 需要 run');
  if (!Array.isArray(piCommand) || piCommand.length === 0) throw new Error('runPiInSandbox 需要 piCommand');
  const ok = await probeBwrap(run);
  if (!ok) return { ok: false, unavailable: true, reason: 'bwrap 不可用（命令不在或起不来）' };
  const sandbox = buildPrbotSandbox({
    home,
    profile,
    hostConfig,
    roundDir,
    worktree,
    env,
    rawProfile,
    model: true,
    sandboxBin,
  });
  const result = await run('bwrap', [...sandbox.args, '--', ...piCommand], {
    env: sandbox.env,
    cwd: worktree,
    input: prompt ?? '',
    timeoutMs,
  });
  if (!result || result.code !== 0) {
    return {
      ok: false,
      unavailable: false,
      code: result?.code ?? 1,
      stdout: result?.stdout || '',
      stderr: firstLine(result?.stderr),
      env: sandbox.env,
      args: sandbox.args,
    };
  }
  return {
    ok: true,
    code: 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    env: sandbox.env,
    args: sandbox.args,
  };
}

/**
 * 跑目标仓自己的推送前检查（SC4）：在新的 bwrap 里，一条失败就停。
 * 返回 {ok, unavailable, code, runs[]}；bwrap 不可用时一条都不跑。
 */
export async function runPreflightInSandbox({
  home,
  profile,
  hostConfig,
  roundDir,
  worktree,
  commands = [],
  env = process.env,
  run,
  rawProfile,
  timeoutMs = 30 * 60 * 1000,
  sandboxBin,
} = {}) {
  if (typeof run !== 'function') throw new Error('runPreflightInSandbox 需要 run');
  if (!Array.isArray(commands) || commands.length === 0) {
    return { ok: true, skipped: true, runs: [] };
  }
  const ok = await probeBwrap(run);
  if (!ok) return { ok: false, unavailable: true, reason: 'bwrap 不可用（命令不在或起不来）', runs: [] };
  const sandbox = buildPrbotSandbox({
    home,
    profile,
    hostConfig,
    roundDir,
    worktree,
    env,
    rawProfile,
    model: false,
    sandboxBin,
  });
  const runs = [];
  for (const command of commands) {
    if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== 'string')) {
      throw new Error('预检命令应为非空字符串数组的数组');
    }
    const result = await run('bwrap', [...sandbox.args, '--', ...command], {
      env: sandbox.env,
      cwd: worktree,
      timeoutMs,
    });
    runs.push({ command, code: result?.code ?? 1, stderr: firstLine(result?.stderr) });
    if (!result || result.code !== 0) {
      return { ok: false, unavailable: false, code: result?.code ?? 1, runs, env: sandbox.env, args: sandbox.args };
    }
  }
  return { ok: true, code: 0, runs, env: sandbox.env, args: sandbox.args };
}
