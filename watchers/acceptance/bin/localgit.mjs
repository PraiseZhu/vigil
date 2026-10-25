#!/usr/bin/env node
// 本机唯一的子进程出口（另一个是 github.mjs）：只跑 git 和 gitleaks，绝不触网。
// 环境里剥掉所有令牌与 askpass，只保留本地需要的变量；不 fetch、不 push、不 clone。
import { spawn } from 'node:child_process';

const ALLOWED = new Set(['git', 'gitleaks']);
// 允许名单：只放推送前扫描和打包真正用到的本地子命令；其余（含 fetch、push、clone、remote 等网络命令）一律拒绝。
const ALLOWED_SUBCOMMANDS = new Set(['diff', 'rev-parse', 'bundle']);
const ALLOWED_BUNDLE_ACTIONS = new Set(['create', 'list-heads']);
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
    if (!ALLOWED_SUBCOMMANDS.has(sub)) throw new Error(`localgit 只允许本地子命令 diff / rev-parse / bundle，收到：${sub}`);
    if (sub === 'bundle' && !ALLOWED_BUNDLE_ACTIONS.has(args[1])) {
      throw new Error(`localgit 只允许 bundle create / list-heads，收到：bundle ${args[1]}`);
    }
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

  /** base...<commit> 的零上下文补丁，只看新增行。commit 是要推的分支解析出的提交，不是 HEAD。 */
  async function diff({ base, commit, cwd }) {
    return git(['diff', '--unified=0', `${safeRange(base)}...${safeRange(commit)}`], { cwd: safePath(cwd, 'worktree') });
  }

  /** 分支解析成提交 sha（只认本地分支 refs/heads/<branch>）。 */
  async function branchSha({ branch, cwd }) {
    return git(['rev-parse', '--verify', '--quiet', `refs/heads/${safeRange(branch)}^{commit}`], {
      cwd: safePath(cwd, 'worktree'),
    });
  }

  async function createBundle({ branch, file, cwd }) {
    return git(['bundle', 'create', safePath(file, 'bundle 路径'), `refs/heads/${safeRange(branch)}`], {
      cwd: safePath(cwd, 'worktree'),
    });
  }

  /** bundle 里各个 ref 指向的提交，用来核对打包的正是扫过的那个提交。 */
  async function bundleHeads({ file, cwd }) {
    return git(['bundle', 'list-heads', safePath(file, 'bundle 路径')], { cwd: safePath(cwd, 'worktree') });
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

  return { git, has, diff, branchSha, createBundle, bundleHeads, gitleaks };
}
