#!/usr/bin/env node
// 本机唯一的子进程出口（另一个是 github.mjs）：只跑 git 和 gitleaks，绝不触网。
// 环境里剥掉所有令牌与 askpass，只保留本地需要的变量；不 fetch、不 push、不 clone。
import { spawn } from 'node:child_process';

const ALLOWED = new Set(['git', 'gitleaks']);
const NETWORK_SUBCOMMANDS = new Set([
  'fetch',
  'push',
  'pull',
  'clone',
  'ls-remote',
  'remote',
  'submodule',
  'archive',
  'request-pull',
  'svn',
  'daemon',
  'update-server-info',
  'send-pack',
  'receive-pack',
]);
const ENV_DENY = /(TOKEN|SECRET|PASSWORD|ASKPASS|CREDENTIAL)/i;
const ENV_DENY_EXACT = new Set([
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
]);

/** 干净的本地环境：凡是名字里带令牌/口令/askpass 的一律不传下去。 */
export function localEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base || {})) {
    if (ENV_DENY.test(key) || ENV_DENY_EXACT.has(key)) continue;
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) continue;
    env[key] = value;
  }
  env.GH_PROMPT_DISABLED = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  env.NO_COLOR = '1';
  return env;
}

/** 默认的进程执行器：测试注入自己的 run 就不走这里。 */
export async function spawnRun(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

function safePath(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`${label} 不能为空`);
  if (value.includes('\0')) throw new Error(`${label} 含非法字符`);
  return value;
}

function safeRange(value) {
  if (typeof value !== 'string' || !value) throw new Error('扫描范围不能为空');
  if (!/^[A-Za-z0-9._/@{}~^-]+$/.test(value) || value.includes('\0')) {
    throw new Error(`扫描范围不合法：${value}`);
  }
  return value;
}

export function createLocalGit({ run = spawnRun, env = localEnv() } = {}) {
  async function call(cmd, args, options = {}) {
    if (!ALLOWED.has(cmd)) throw new Error(`localgit 只跑 git 和 gitleaks，收到：${cmd}`);
    return run(cmd, args, { ...options, env: options.env || env });
  }

  async function git(args, options = {}) {
    if (!Array.isArray(args) || !args.length) throw new Error('git 需要参数');
    const sub = args[0];
    if (sub.startsWith('-')) throw new Error(`git 的第一个参数必须是子命令：${sub}`);
    if (NETWORK_SUBCOMMANDS.has(sub)) throw new Error(`localgit 不做网络操作：${sub}`);
    return call('git', args, options);
  }

  /** git 或 gitleaks 在不在本机（不抛错，只回真假）。 */
  async function has(name) {
    if (!ALLOWED.has(name)) return false;
    try {
      const result = await call(name, name === 'git' ? ['--version'] : ['version']);
      return result.code === 0;
    } catch {
      return false;
    }
  }

  /** base...HEAD 的零上下文补丁，只看新增行。 */
  async function diff({ base, cwd }) {
    return git(['diff', '--unified=0', `${safeRange(base)}...HEAD`], { cwd: safePath(cwd, 'worktree') });
  }

  async function headSha({ cwd }) {
    return git(['rev-parse', 'HEAD'], { cwd: safePath(cwd, 'worktree') });
  }

  async function createBundle({ branch, file, cwd }) {
    return git(['bundle', 'create', safePath(file, 'bundle 路径'), safePath(branch, '分支名')], {
      cwd: safePath(cwd, 'worktree'),
    });
  }

  /** gitleaks 本地扫描：报告写到 reportPath，返回进程结果。 */
  async function gitleaks({ range, reportPath, cwd }) {
    return call(
      'gitleaks',
      [
        'git',
        `--log-opts=${safeRange(range)}`,
        '--redact',
        '--report-format',
        'json',
        '--report-path',
        safePath(reportPath, '报告路径'),
      ],
      { cwd: safePath(cwd, 'worktree') },
    );
  }

  return { git, has, diff, headSha, createBundle, gitleaks };
}
