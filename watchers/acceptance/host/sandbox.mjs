#!/usr/bin/env node
// 验收轮沙箱（#47 SC11）：只有 bwrap 一条路。没有任何环境变量或配置项能关掉它。
// 遮罩名单从 profile 算出来（所有 …TokenFile / …PrivateKeyFile 键 + App 私钥），不写死文件名。
import fs from 'node:fs';
import path from 'node:path';
import { TOKEN_FILE_KEY } from '../bin/profile.mjs';

/** 传进沙箱的环境变量白名单；别的（含任何令牌）一律不传。 */
export const ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'HOME',
  'LANG',
  'TZ',
  'TERM',
  'TMPDIR',
  'LLM_PROXY_API_KEY',
  'NODE_OPTIONS',
]);

/** 沙箱内部用的两个变量：都指向沙箱内的路径，不是宿主的。 */
export const INTERNAL_ENV = Object.freeze(['ACCEPTANCE_WATCHER_HOME', 'ACCEPTANCE_GATE_SOCKET']);

/** 密钥文件键直接用 bin/profile.mjs 的约定（以 TokenFile / PrivateKeyFile 结尾，或正好是 privateKeyFile），不另写一份。 */
const KEY_PATTERN = TOKEN_FILE_KEY;

const HOME_CRED_DIRS = Object.freeze([
  '.config/gh',
  '.ssh',
  '.gnupg',
  '.aws',
  '.config/gcloud',
  '.docker',
  '.kube',
  '.config/git',
]);

const HOME_CRED_FILES = Object.freeze(['.git-credentials', '.netrc']);

function collectKeyFiles(value, out, depth = 0) {
  if (depth > 12 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectKeyFiles(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && item && KEY_PATTERN.test(key)) out.add(item);
    else if (item && typeof item === 'object') collectKeyFiles(item, out, depth + 1);
  }
}

/**
 * 沙箱要遮掉的东西：
 * - files：profile 里配的每一个令牌 / 私钥文件（从原始 profile JSON 递归算，新增 `…TokenFile` 键自动生效），
 *   App 配置里的 privateKeyFile，以及 HOME 下的 .git-credentials / .netrc（存在才遮）。
 * - dirs：HOME 下的凭证目录（存在才遮）、host.json 的 credentialDirs、宿主状态目录 <home>/state。
 */
/**
 * 把要遮的路径落到真实路径上：bwrap 不能挂到符号链接上（会直接起不来），
 * 而且只遮链接本身、真实文件照样能从原路径读到。所以一律遮 realpath。
 * 不存在的路径没有内容可读，跳过（否则 bwrap 在只读根上建不出挂载点，整轮起不来）。
 */
function realExisting(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

export function maskList({ rawProfile, profile, hostConfig, env = process.env, home } = {}) {
  const wanted = new Set();
  collectKeyFiles(rawProfile || {}, wanted);
  if (profile?.appConfigPath) {
    // App 配置本身也遮（里面可能有安装信息），再加上它指向的私钥。
    wanted.add(profile.appConfigPath);
    try {
      const appConfig = JSON.parse(fs.readFileSync(profile.appConfigPath, 'utf8'));
      if (typeof appConfig?.privateKeyFile === 'string' && appConfig.privateKeyFile) {
        wanted.add(appConfig.privateKeyFile);
      }
    } catch {
      // App 配置读不出是部署检查的事；这里不因此放行任何文件。
    }
  }
  for (const file of [profile?.githubTokenFile, profile?.slackBotTokenFile, profile?.appPrivateKeyFile]) {
    if (typeof file === 'string' && file) wanted.add(file);
  }

  const wantedDirs = new Set();
  const userHome = env?.HOME;
  if (typeof userHome === 'string' && userHome) {
    for (const rel of HOME_CRED_DIRS) wantedDirs.add(path.join(userHome, rel));
    for (const rel of HOME_CRED_FILES) wanted.add(path.join(userHome, rel));
  }
  for (const dir of hostConfig?.credentialDirs || []) {
    if (typeof dir === 'string' && path.isAbsolute(dir)) wantedDirs.add(dir);
  }
  if (typeof home === 'string' && path.isAbsolute(home)) {
    // 宿主状态目录（写闸开关、账本、提醒、轮次登记）对模型完全不可见。
    const stateRoot = path.join(home, 'state');
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    wantedDirs.add(stateRoot);
  }

  const files = new Set();
  const dirs = new Set();
  for (const file of wanted) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) continue;
    const real = realExisting(file);
    if (!real) continue;
    if (fs.statSync(real).isDirectory()) dirs.add(real);
    else files.add(real);
  }
  for (const dir of wantedDirs) {
    const real = realExisting(dir);
    if (!real) continue;
    if (fs.statSync(real).isDirectory()) dirs.add(real);
    else files.add(real);
  }
  return { files: [...files], dirs: [...dirs] };
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 拼 bwrap 参数。顺序：只读根 → 设备/proc/tmp → 可写绑定 → 遮罩（最后挂，遮罩一定赢）→ 干净环境。
 * 宿主状态目录和可写绑定相互包含、或遮罩文件落在可写绑定里，一律抛错（fail-closed）。
 */
export function buildBwrapArgs({ home, profile, roundDir, masks, binds, env } = {}) {
  if (typeof roundDir !== 'string' || !path.isAbsolute(roundDir)) {
    throw new Error('沙箱需要绝对路径的 roundDir');
  }
  const maskFiles = (masks?.files || []).filter((file) => typeof file === 'string' && path.isAbsolute(file));
  const maskDirs = (masks?.dirs || []).filter((dir) => typeof dir === 'string' && path.isAbsolute(dir));
  const bindList = (binds || []).filter((dir) => typeof dir === 'string' && dir);
  for (const bind of bindList) {
    if (!path.isAbsolute(bind)) throw new Error(`沙箱绑定目录必须是绝对路径：${bind}`);
  }
  if (!bindList.includes(roundDir)) bindList.push(roundDir);

  const stateRoot = typeof home === 'string' && path.isAbsolute(home) ? path.join(home, 'state') : null;
  for (const dir of [profile?.stateDir, profile?.worktreeDir]) {
    if (typeof dir !== 'string' || !dir) continue;
    if (!path.isAbsolute(dir)) throw new Error(`profile 里的目录必须是绝对路径：${dir}`);
    if (stateRoot && (isInside(dir, stateRoot) || isInside(stateRoot, dir))) {
      throw new Error(`沙箱拒绝：${dir} 与宿主状态目录重叠，模型会看到写闸开关`);
    }
  }
  for (const maskDir of maskDirs) {
    for (const bind of bindList) {
      if (isInside(bind, maskDir) || isInside(maskDir, bind)) {
        throw new Error(`沙箱拒绝：遮罩目录 ${maskDir} 与可写绑定 ${bind} 重叠`);
      }
    }
  }
  for (const maskFile of maskFiles) {
    for (const bind of bindList) {
      if (isInside(maskFile, bind)) {
        throw new Error(`沙箱拒绝：遮罩文件 ${maskFile} 落在可写绑定 ${bind} 里`);
      }
    }
  }

  const args = [
    '--die-with-parent',
    '--new-session',
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--share-net',
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
  ];
  for (const bind of bindList) args.push('--bind', bind, bind);
  for (const dir of maskDirs) args.push('--tmpfs', dir);
  for (const file of maskFiles) args.push('--ro-bind', '/dev/null', file);
  args.push('--clearenv');
  for (const [key, value] of Object.entries(env || {})) {
    if (value === undefined || value === null) continue;
    args.push('--setenv', String(key), String(value));
  }
  return args;
}

/** bwrap 在不在、能不能挂命名空间：只跑一条不发散的命令。 */
export async function probeBwrap(run) {
  try {
    const result = await run('bwrap', ['--ro-bind', '/', '/', 'true'], { timeoutMs: 15000 });
    return Boolean(result && result.code === 0);
  } catch {
    return false;
  }
}

/** 沙箱内的 pi 环境：白名单 + 沙箱内的 HOME/TMPDIR/哨兵目录 + 两个内部变量。 */
export function sandboxEnv({
  base = process.env,
  roundDir,
  socketPath,
  sandboxBin,
  allowlist = ENV_ALLOWLIST,
  internal = INTERNAL_ENV,
} = {}) {
  if (typeof roundDir !== 'string' || !path.isAbsolute(roundDir)) {
    throw new Error('sandboxEnv 需要绝对路径的 roundDir');
  }
  const env = {};
  for (const key of allowlist) {
    if (base?.[key] !== undefined) env[key] = base[key];
  }
  env.HOME = path.join(roundDir, 'home');
  env.TMPDIR = path.join(roundDir, 'tmp');
  const pathParts = [];
  if (sandboxBin) pathParts.push(sandboxBin);
  if (env.PATH) pathParts.push(env.PATH);
  env.PATH = pathParts.length ? pathParts.join(path.delimiter) : '/usr/bin:/bin';
  if (internal.includes('ACCEPTANCE_WATCHER_HOME')) env.ACCEPTANCE_WATCHER_HOME = path.join(roundDir, 'home-acc');
  if (internal.includes('ACCEPTANCE_GATE_SOCKET') && socketPath) env.ACCEPTANCE_GATE_SOCKET = socketPath;
  return env;
}

/**
 * 沙箱里的 watcher home：真 profile 的副本，但写操作只经 gate-client 走 socket，
 * 令牌文件换成一个占位文件（内容不是令牌），所有 …TokenFile / App 私钥配置一律删掉。
 */
export function prepareSandboxProfile({ profile, roundDir, repoRoot, socketPath } = {}) {
  if (!profile?.profilePath) throw new Error('prepareSandboxProfile 需要带 profilePath 的 profile');
  const sandboxHome = path.join(roundDir, 'home-acc');
  const configDir = path.join(sandboxHome, 'config');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });

  const raw = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
  const copy = { ...raw };
  for (const key of Object.keys(copy)) {
    if (KEY_PATTERN.test(key) || key === 'appConfigPath') delete copy[key];
  }
  const placeholderToken = path.join(sandboxHome, 'placeholder.token');
  copy.githubTokenFile = placeholderToken;
  copy.writeCommand = [
    'node',
    path.join(repoRoot, 'watchers', 'acceptance', 'host', 'gate-client.mjs'),
    '--socket',
    socketPath,
  ];
  const profileFile = path.join(configDir, 'profile.json');
  fs.writeFileSync(profileFile, JSON.stringify(copy, null, 2), { mode: 0o600 });
  // 占位文件只是为了让沙箱里的 profile 校验（600、非空）能过，内容不是任何令牌。
  fs.writeFileSync(placeholderToken, 'sandbox-placeholder-not-a-token', { mode: 0o600 });
  fs.chmodSync(placeholderToken, 0o600);
  return { sandboxHome, profileFile, placeholderToken };
}

/** 小写别名，和 #47 的接口名对齐。 */
export const envAllowlist = ENV_ALLOWLIST;
export const KEY_FILE_PATTERN = KEY_PATTERN;
export const CREDENTIAL_DIRS = HOME_CRED_DIRS;
export const CREDENTIAL_FILES = HOME_CRED_FILES;
