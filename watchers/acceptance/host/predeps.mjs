// 宿主预装依赖（方案 B）：认领、预取代码之后，起 pi 之前，宿主在模型沙箱之外按 lockfile 装好 npm 依赖，
// 再只读挂到检出目录的 node_modules 位置。模型沙箱的出网名单（host.json 的 egressAllow）不变，
// 沙箱里的 npm 一律离线（sandbox.mjs 的 QUIET_ENV：npm_config_offline=true）。
//
// 规矩（都写死在代码里，host.json 改不了）：
// - 只在仓根有 npm-shrinkwrap.json / package-lock.json（且有 package.json）时装；没有就不装，只在派发消息里说明。
// - 只跑 `npm ci --ignore-scripts`（任何安装脚本都不跑），registry 固定 https://registry.npmjs.org/，
//   不读项目 / 用户 / 全局 .npmrc。
// - 装在本轮目录 roundDir/deps 下（跟着轮次清理），npm 缓存放 <home>/cache/npm；都不进宿主 HOME 的点目录。
// - npm 本身也在一个隔离环境里跑：bwrap --unshare-net + 出网桥，出网代理只放行 registry.npmjs.org:443；
//   环境变量白名单（PATH / LANG / TZ）+ 固定的 npm_config_*，没有任何令牌；凭证目录照样遮掉。
// - 装不上（npm 退出非 0、超时、出网被拒）一律抛 DepsError：调用方按「环境问题」中止本轮，不出代码结论。
import fs from 'node:fs';
import path from 'node:path';
import { EGRESS_BRIDGE_PORT, bridgeCommand, startEgressProxy, throttledDenied } from './egress-proxy.mjs';
import { buildBwrapArgs, defaultHomeAllow, maskList } from './sandbox.mjs';
import { redact } from '../bin/redact.mjs';

/** 唯一允许的 npm 源。 */
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
/** 预装这一步出网代理的放行名单（写死；和模型沙箱的 egressAllow 是两回事）。 */
export const DEPS_EGRESS_ALLOW = Object.freeze(['registry.npmjs.org:443']);
/** 认的 lockfile，按 npm 自己的优先级（shrinkwrap 优先）。 */
export const LOCKFILES = Object.freeze(['npm-shrinkwrap.json', 'package-lock.json']);
/** npm ci 的参数：--ignore-scripts 必带。 */
export const NPM_CI_ARGS = Object.freeze(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--registry', NPM_REGISTRY]);
/** 从宿主环境里抄进预装环境的变量（别的一律不带，含任何令牌）。 */
export const DEPS_ENV_ALLOWLIST = Object.freeze(['PATH', 'LANG', 'TZ']);
/** 一个仓装依赖最多等多久（小于 stallMinutes 默认 30 分钟）。 */
export const DEPS_TIMEOUT_MS = 15 * 60 * 1000;
/** 装依赖时多久刷新一次本轮宿主进度（不被误判卡住）。 */
export const DEPS_TOUCH_MS = 60 * 1000;
/** 只读 node_modules 里给工具写缓存的位置：挂成沙箱里的空 tmpfs（vite / vitest / babel 等会写）。 */
export const NODE_MODULES_CACHE_DIRS = Object.freeze(['.cache', '.vite', '.vitest']);
/** 找各级 node_modules 时最多往下几层、最多几个（workspaces）。 */
const MAX_WALK_DEPTH = 6;
const MAX_MOUNTS = 64;

export class DepsError extends Error {
  /** message 会进 issue 上「中断」评论的原因（公开）：只放仓名和简短原因；npm 的输出尾巴放 detail（只进本地提醒）。 */
  constructor(message, detail) {
    super(message);
    this.name = 'DepsError';
    if (detail) this.detail = detail;
  }
}

/** 仓根的 lockfile 名字；没有 package.json 或没有 lockfile 返回 null。 */
export function findLockfile(dir) {
  if (!fs.existsSync(path.join(dir, 'package.json'))) return null;
  for (const name of LOCKFILES) {
    let stat;
    try {
      stat = fs.lstatSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (stat.isFile()) return name;
  }
  return null;
}

/**
 * 预装 npm 的环境：只有白名单里的宿主变量，加上固定的 npm 配置。
 * userconfig / globalconfig 指向空文件：宿主和项目里的 .npmrc（可能带令牌、别的源）都不读；
 * 项目级 .npmrc 本来就不拷进工作目录。
 */
export function depsEnv({ base = process.env, depsHome, cacheDir, emptyConfig, emptyGlobalConfig, port = EGRESS_BRIDGE_PORT } = {}) {
  for (const [name, value] of Object.entries({ depsHome, cacheDir, emptyConfig, emptyGlobalConfig })) {
    if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`depsEnv 需要绝对路径的 ${name}`);
  }
  const env = {};
  for (const key of DEPS_ENV_ALLOWLIST) if (base?.[key] !== undefined) env[key] = base[key];
  if (!env.PATH) env.PATH = '/usr/bin:/bin';
  const proxy = `http://127.0.0.1:${port}`;
  Object.assign(env, {
    HOME: depsHome,
    npm_config_cache: cacheDir,
    npm_config_userconfig: emptyConfig,
    // npm 不许同一个文件既当 user 又当 global，所以是两个空文件。
    npm_config_globalconfig: emptyGlobalConfig,
    npm_config_registry: NPM_REGISTRY,
    npm_config_ignore_scripts: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_progress: 'false',
    npm_config_https_proxy: proxy,
    npm_config_proxy: proxy,
    npm_config_noproxy: '',
    HTTPS_PROXY: proxy,
    https_proxy: proxy,
    HTTP_PROXY: proxy,
    http_proxy: proxy,
    NO_UPDATE_NOTIFIER: '1',
  });
  return env;
}

/** 检出目录 → 预装工作目录：整棵树照抄（workspaces、file: 依赖要用），但不抄 .git、node_modules、.npmrc。 */
function copyTree(source, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const name = path.basename(src);
      return name !== '.git' && name !== 'node_modules' && name !== '.npmrc';
    },
  });
}

/** 工作目录里装出来的各级 node_modules（相对路径；不进 node_modules 里面找，不跟符号链接）。 */
export function listNodeModules(root) {
  const out = [];
  const walk = (rel, depth) => {
    if (out.length >= MAX_MOUNTS || depth > MAX_WALK_DEPTH) return;
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git') continue;
      const child = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.name === 'node_modules') {
        out.push(child);
        continue;
      }
      walk(child, depth + 1);
    }
  };
  walk('', 0);
  return out.sort();
}

/** 检出目录里给只读挂载准备挂载点：已有目录就用；是文件 / 符号链接就不挂（不往检出里乱写）。 */
function ensureMountPoint(dest) {
  let stat = null;
  try {
    stat = fs.lstatSync(dest);
  } catch {
    stat = null;
  }
  if (stat) return stat.isDirectory();
  fs.mkdirSync(dest, { recursive: true, mode: 0o755 });
  return true;
}

/** npm 输出的最后几行：绝对路径换成 <path>，再过一遍密钥脱敏。只进本地提醒。 */
function lastLines(text, count = 5) {
  const joined = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(' | ')
    .replace(/\/(?:home|root|tmp|workspace|cursor|var|opt)\/[^\s'"|]*/g, '<path>');
  return redact(joined).slice(0, 600);
}

/**
 * 给本轮预取的每个仓装依赖。`code` 是 prefetch 的结果 [{repo, path, head}]。
 * 返回 {deps: [{repo, status: 'installed'|'no-lockfile', lockfile?, mounts?}], readOnlyBinds, mounts, tmpfs}：
 * - readOnlyBinds：预装根目录本身（roundDir 是可写绑定，预装目录要再盖成只读）；
 * - mounts：[{src, dest}]，src 是预装出来的 node_modules，dest 是检出目录里同一相对位置；
 * - tmpfs：只读 node_modules 里给工具写缓存的目录（沙箱里的空 tmpfs）。
 * 没有 package.json 的仓不出现在 deps 里。任何一个仓装不上就抛 DepsError（不留半截预装目录）。
 */
export async function prepareDeps({
  home,
  profile,
  hostConfig = {},
  code = [],
  roundDir,
  env = process.env,
  run,
  repoRoot,
  touch = () => {},
  startProxy = startEgressProxy,
  timeoutMs = DEPS_TIMEOUT_MS,
  touchMs = DEPS_TOUCH_MS,
} = {}) {
  const result = { deps: [], readOnlyBinds: [], mounts: [], tmpfs: [] };
  const candidates = [];
  // 只认本轮预取的检出（<roundDir>/code 下面）：别处的目录不拷、不在里面建挂载点。
  const codeRoot = typeof roundDir === 'string' ? path.join(roundDir, 'code') : null;
  for (const entry of code || []) {
    if (typeof entry?.path !== 'string' || !path.isAbsolute(entry.path)) continue;
    if (!codeRoot || path.dirname(path.resolve(entry.path)) !== codeRoot) continue;
    if (!fs.existsSync(path.join(entry.path, 'package.json'))) continue;
    const lockfile = findLockfile(entry.path);
    if (!lockfile) {
      result.deps.push({ repo: entry.repo, path: entry.path, status: 'no-lockfile' });
      continue;
    }
    candidates.push({ ...entry, lockfile });
  }
  if (!candidates.length) return result;
  if (typeof run !== 'function') throw new Error('prepareDeps 需要 run');
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('prepareDeps 需要绝对路径的 home');
  if (typeof roundDir !== 'string' || !path.isAbsolute(roundDir)) throw new Error('prepareDeps 需要绝对路径的 roundDir');

  const depsRoot = path.join(roundDir, 'deps');
  const cacheDir = path.join(home, 'cache', 'npm');
  const depsHome = path.join(depsRoot, '.home');
  const emptyConfig = path.join(depsRoot, '.npmrc-user-empty');
  const emptyGlobalConfig = path.join(depsRoot, '.npmrc-global-empty');
  fs.rmSync(depsRoot, { recursive: true, force: true });
  fs.mkdirSync(depsHome, { recursive: true, mode: 0o700 });
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(emptyConfig, '', { mode: 0o600 });
  fs.writeFileSync(emptyGlobalConfig, '', { mode: 0o600 });

  const hostHome = env.HOME || process.env.HOME;
  const rawProfile = profile?.profilePath ? JSON.parse(fs.readFileSync(profile.profilePath, 'utf8')) : {};
  const masks = maskList({ rawProfile, profile, hostConfig, env: { ...process.env, HOME: hostHome }, home });
  // 只挂回代码仓（出网桥脚本在里面）和 node 的安装目录；pi 之类的 homeAllowDirs 这一步用不着。
  const homeAllow = defaultHomeAllow({ repoRoot, hostConfig: {} });
  const socketPath = path.join(depsRoot, 'egress', 'npm.sock');
  const denied = [];
  const onDenied = throttledDenied((info) => denied.push(info.target), { maxTotal: 5 });

  const timer = setInterval(() => {
    try {
      touch();
    } catch {
      // 刷新进度失败不影响装依赖。
    }
  }, touchMs);
  timer.unref?.();
  let proxy = null;
  try {
    proxy = await startProxy({ socketPath, allow: [...DEPS_EGRESS_ALLOW], onDenied });
    for (const entry of candidates) {
      // 目录名跟检出目录一样（<owner>__<repo>，prefetch 已保证互不相同）。
      const workDir = path.join(depsRoot, path.basename(entry.path));
      copyTree(entry.path, workDir);
      const bwrapArgs = buildBwrapArgs({
        home,
        // profile 里的 stateDir / worktreeDir 是给模型沙箱挂的，这一步一个都不挂（遮罩照样按 profile 算）。
        profile: {},
        roundDir: depsRoot,
        masks,
        binds: [cacheDir],
        readOnlyBinds: [],
        hostHome,
        homeAllow,
      });
      const args = [
        ...bwrapArgs,
        '--chdir',
        workDir,
        '--',
        ...bridgeCommand({ socketPath: proxy.socketPath || socketPath }),
        'npm',
        ...NPM_CI_ARGS,
      ];
      const environment = depsEnv({ base: env, depsHome, cacheDir, emptyConfig, emptyGlobalConfig });
      let outcome;
      try {
        outcome = await run('bwrap', args, { env: environment, cwd: workDir, timeoutMs });
      } catch (error) {
        throw new DepsError(`${entry.repo}：npm ci 起不来`, lastLines(error?.message || error));
      }
      touch();
      if (!outcome || outcome.code !== 0) {
        const why = outcome?.code === 124 || outcome?.signal ? `超时（${Math.round(timeoutMs / 60000)} 分钟）` : `退出码 ${outcome?.code}`;
        const blocked = denied.length ? `；出网被拒：${[...new Set(denied)].join(', ')}` : '';
        throw new DepsError(`${entry.repo}：npm ci 失败（${why}${blocked}）`, lastLines(outcome?.stderr || outcome?.stdout));
      }
      const mounts = [];
      for (const rel of listNodeModules(workDir)) {
        const src = path.join(workDir, rel);
        const dest = path.join(entry.path, rel);
        if (!ensureMountPoint(dest)) continue;
        mounts.push({ src, dest });
      }
      const rootModules = mounts.find((mount) => mount.dest === path.join(entry.path, 'node_modules'));
      if (rootModules) {
        for (const name of NODE_MODULES_CACHE_DIRS) {
          const src = path.join(rootModules.src, name);
          let ok = true;
          try {
            const stat = fs.lstatSync(src);
            ok = stat.isDirectory();
          } catch {
            fs.mkdirSync(src, { mode: 0o755 });
          }
          if (ok) result.tmpfs.push(path.join(rootModules.dest, name));
        }
      }
      result.mounts.push(...mounts);
      result.deps.push({ repo: entry.repo, path: entry.path, status: 'installed', lockfile: entry.lockfile, mounts: mounts.map((m) => m.dest) });
    }
  } catch (error) {
    fs.rmSync(depsRoot, { recursive: true, force: true });
    for (const mount of result.mounts) {
      try {
        fs.rmdirSync(mount.dest);
      } catch {
        // 不是我们建的空目录就留着。
      }
    }
    if (error instanceof DepsError) throw error;
    throw new DepsError('宿主预装出错', lastLines(error?.message || error));
  } finally {
    clearInterval(timer);
    if (proxy) {
      try {
        await proxy.stop();
      } catch {
        // 收尾失败不影响结果。
      }
    }
  }
  fs.rmSync(path.join(depsRoot, 'egress'), { recursive: true, force: true });
  result.readOnlyBinds.push(depsRoot);
  return result;
}

/** 依赖情况接到派发消息后面（沙箱里能直接用的路径；不含令牌）。deps 为空原样返回。 */
export function appendDepsInfo(message, deps = []) {
  const list = (deps || []).filter((item) => item && typeof item.path === 'string');
  if (!list.length) return message;
  const lines = ['', '依赖（宿主在沙箱外预装，沙箱里 npm 不联网）：'];
  for (const item of list) {
    if (item.status === 'installed') {
      lines.push(
        `- ${item.repo}：已按 ${item.lockfile} 预装（npm ci --ignore-scripts，安装脚本一律没跑），只读挂在 ${path.join(item.path, 'node_modules')}。`,
      );
    } else {
      lines.push(
        `- ${item.repo}：仓根没有 package-lock.json / npm-shrinkwrap.json，宿主没有预装依赖，沙箱里也装不了；要依赖才能跑的检查属环境限制，不能据此判不通过，在证据里写明「环境限制：未预装依赖」。`,
      );
    }
  }
  lines.push('- 不要再跑 npm ci / npm install（沙箱里没有 npm 出网）；要构建就直接 npm run build 等脚本，离线跑。');
  lines.push('- 要写 node_modules 的工具请先 cp -a 整个仓到 $TMPDIR 再跑；因为安装脚本没跑而缺的产物属环境限制，不是代码问题。');
  return `${String(message).replace(/\n+$/, '')}\n${lines.join('\n')}`;
}
