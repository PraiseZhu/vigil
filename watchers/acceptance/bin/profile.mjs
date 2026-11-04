#!/usr/bin/env node
// 验收机配置：只从 <home>/config/profile.json 读键；home 才允许来自环境变量。
// 缺必填项直接报错（fail-closed），不回落任何个人路径或令牌环境变量。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOT_LOGIN_PATTERN } from './trusted-author.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_ENV = 'ACCEPTANCE_WATCHER_HOME';
const REPO_PATTERN = /^[^/]+\/([^/]+|\*)$/;
const ISSUE_REF_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/;

export class ProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileError';
    this.code = 'PROFILE_INVALID';
  }
}

/** watcher 的 home 目录：显式 env > 以 bin/ 的上一级为默认 */
export function watcherHome(env = process.env) {
  const explicit = env[HOME_ENV];
  if (explicit) return explicit;
  return path.resolve(HERE, '..');
}

/**
 * 显式设了的 home（`ACCEPTANCE_WATCHER_HOME`），没设或不是绝对路径就返回 null。
 * 需要 fail-closed 的调用方用它：不回落默认目录，也不按别的参数猜路径（#247 P1-1）。
 */
export function explicitWatcherHome(env = process.env) {
  const explicit = env?.[HOME_ENV];
  return typeof explicit === 'string' && path.isAbsolute(explicit) ? explicit : null;
}

export function profilePath(env = process.env) {
  return path.join(watcherHome(env), 'config', 'profile.json');
}

function readProfileFile(file) {
  if (!fs.existsSync(file)) {
    throw new ProfileError(`缺少配置文件 ${file}。`);
  }
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ProfileError(`无法读取配置文件 ${file}：${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new ProfileError(`配置文件 ${file} 不是合法 JSON：${error.message}`);
  }
}

function missing(key, file) {
  return new ProfileError(`缺少必需配置「${key}」：请在 ${file} 中设置。`);
}

function invalid(key, file, reason) {
  return new ProfileError(`配置无效「${key}」：${reason}（文件 ${file}）。`);
}

function requireString(raw, key, file) {
  if (!Object.hasOwn(raw, key) || raw[key] === undefined || raw[key] === '') {
    throw missing(key, file);
  }
  if (typeof raw[key] !== 'string') {
    throw invalid(key, file, '应为非空字符串');
  }
  return raw[key];
}

function requireAbsolute(raw, key, file) {
  const value = requireString(raw, key, file);
  if (!path.isAbsolute(value)) {
    throw invalid(key, file, '应为绝对路径');
  }
  return value;
}

function optionalAbsolute(raw, key, file) {
  if (!Object.hasOwn(raw, key) || raw[key] === undefined || raw[key] === null) {
    return undefined;
  }
  if (typeof raw[key] !== 'string' || raw[key] === '' || !path.isAbsolute(raw[key])) {
    throw invalid(key, file, '应为绝对路径');
  }
  return raw[key];
}

/** 可选字符串键，只做格式校验（#61 的 Slack 频道 / @ 用户 id）；没配返回 undefined。 */
function optionalPattern(raw, key, file, pattern, hint) {
  if (!Object.hasOwn(raw, key) || raw[key] === undefined || raw[key] === null) {
    return undefined;
  }
  if (typeof raw[key] !== 'string' || !pattern.test(raw[key])) {
    throw invalid(key, file, hint);
  }
  return raw[key];
}

function requireRepoList(raw, key, file, fallback) {
  if (!Object.hasOwn(raw, key) || raw[key] === undefined || raw[key] === null) {
    return fallback;
  }
  if (!Array.isArray(raw[key])) {
    throw invalid(key, file, '应为字符串数组');
  }
  for (const item of raw[key]) {
    if (typeof item !== 'string' || !REPO_PATTERN.test(item)) {
      throw invalid(key, file, '每项应为 owner/repo 或 owner/*');
    }
  }
  return [...raw[key]];
}

/** 显式 issue 名单（`owner/repo#号`），不收通配；没配返回 []。 */
function optionalIssueList(raw, key, file) {
  if (!Object.hasOwn(raw, key) || raw[key] === undefined || raw[key] === null) return [];
  if (!Array.isArray(raw[key])) throw invalid(key, file, '应为字符串数组');
  for (const item of raw[key]) {
    if (typeof item !== 'string' || !ISSUE_REF_PATTERN.test(item)) {
      throw invalid(key, file, `每项应为 owner/repo#号（不收通配）：${item}`);
    }
  }
  return [...raw[key]];
}

/**
 * trustedBotLogins（可选）：可以代表本人发言的 App bot 登录名，默认 []（行为与只有 ownerLogin 时完全一致）。
 * 每项必须带 [bot] 后缀：普通用户名配进来等于把别人发的评论当本人，直接报错；重复项（不分大小写）也报错。
 */
function optionalBotLogins(raw, file) {
  if (!Object.hasOwn(raw, 'trustedBotLogins') || raw.trustedBotLogins === undefined || raw.trustedBotLogins === null) return [];
  if (!Array.isArray(raw.trustedBotLogins)) throw invalid('trustedBotLogins', file, '应为字符串数组');
  const seen = new Set();
  const logins = [];
  for (const item of raw.trustedBotLogins) {
    if (typeof item !== 'string' || !item) throw invalid('trustedBotLogins', file, '每项应为非空字符串');
    if (!BOT_LOGIN_PATTERN.test(item)) {
      throw invalid('trustedBotLogins', file, `每项应为带 [bot] 后缀的 App bot 登录名（普通用户名不能当 bot）：${item}`);
    }
    const key = item.toLowerCase();
    if (seen.has(key)) throw invalid('trustedBotLogins', file, `重复条目：${item}`);
    seen.add(key);
    logins.push(item);
  }
  return logins;
}

/**
 * verdictOnlyIssues（可选）：只出裁决的 issue（比如验收机自己的总 issue，#43 决策「结论由人或 opus(high) 复核后才关」）。
 * 照常验收、发轮次评论、写看板和裁决，但不关、不勾、不开修正、不推送；helper 和写闸两边都拒。
 */
export function isVerdictOnly(profile, ref) {
  const key = String(ref || '').toLowerCase();
  if (!key) return false;
  return (profile?.verdictOnlyIssues || []).some((item) => String(item).toLowerCase() === key);
}

/** helper 的 close / correct / push 遇到只出裁决的 issue 一律拒绝（退出码 1），原因写清楚。 */
export function assertNotVerdictOnly(profile, ref, command) {
  if (!isVerdictOnly(profile, ref)) return;
  throw new Error(
    `${ref} 在 verdictOnlyIssues 里（只出裁决）：${command} 不做——不关、不勾、不开修正、不推送，` +
      '最后一步只写 verdict（裁决会写明「本 issue 由人工复核后关闭」）',
  );
}

/**
 * forkTargets（可选）：上游仓 → fork 仓的对照，例如 {"upstream-owner/app": "ExampleUser/app-fork"}。
 * 键必须是 forkRepos 里写明的具体仓；值必须在 ownerLogin 名下（fork 只推到自己名下，写闸规则不放宽）。
 * 没写的上游仓照旧用 ownerLogin 名下同名的仓。
 */
function parseForkTargets(raw, file, { ownerLogin, forkRepos }) {
  if (!Object.hasOwn(raw, 'forkTargets') || raw.forkTargets === undefined || raw.forkTargets === null) return {};
  const value = raw.forkTargets;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('forkTargets', file, '应为「上游仓 → fork 仓」的对象');
  const out = {};
  for (const [upstream, target] of Object.entries(value)) {
    if (!REPO_PATTERN.test(upstream) || upstream.endsWith('/*')) throw invalid('forkTargets', file, `键应为具体的 owner/repo：${upstream}`);
    if (!forkRepos.some((item) => item.toLowerCase() === upstream.toLowerCase())) {
      throw invalid('forkTargets', file, `${upstream} 不在 forkRepos 里`);
    }
    if (typeof target !== 'string' || !REPO_PATTERN.test(target) || target.endsWith('/*')) {
      throw invalid('forkTargets', file, `${upstream} 的 fork 应为具体的 owner/repo`);
    }
    if (target.split('/')[0].toLowerCase() !== ownerLogin.toLowerCase()) {
      throw invalid('forkTargets', file, `${upstream} 的 fork 必须在 ${ownerLogin} 名下`);
    }
    out[upstream.toLowerCase()] = target;
  }
  return out;
}

/** 上游仓对应的 fork 仓：forkTargets 里写了就用它，否则是 ownerLogin 名下同名的仓。 */
export function forkTargetFor(profile, upstreamRepo) {
  const mapped = profile?.forkTargets?.[String(upstreamRepo).toLowerCase()];
  if (mapped) return mapped;
  return `${profile.ownerLogin}/${String(upstreamRepo).split('/')[1]}`;
}

/**
 * 校验密钥文件（只看文件元数据，不读内容）：存在、普通文件、属主是当前用户、权限正好是 600、非空。
 * 错误信息只点名键和原因，绝不带出文件内容。令牌内容只由真正用它的模块读（GitHub 令牌：github.mjs）。
 */
export function checkSecretFile(file, key) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new ProfileError(`配置无效「${key}」：文件不存在。`);
  }
  if (!stat.isFile()) {
    throw new ProfileError(`配置无效「${key}」：不是普通文件。`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new ProfileError(`配置无效「${key}」：文件属主不是当前用户。`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new ProfileError(
      `配置无效「${key}」：文件权限必须是 600（现在是 ${(stat.mode & 0o777).toString(8)}）。`,
    );
  }
  if (stat.size === 0) {
    throw new ProfileError(`配置无效「${key}」：文件为空。`);
  }
}

/**
 * 密钥文件键的约定：令牌文件键名以 TokenFile 结尾；App 私钥文件记在 appPrivateKeyFile（键名以 PrivateKeyFile 结尾）。
 * tokenFiles 返回 profile 里配了的全部密钥文件路径，供宿主沙箱统一遮罩。
 */
export const TOKEN_FILE_KEY = /(TokenFile|PrivateKeyFile|^privateKeyFile)$/;
export function tokenFiles(profile) {
  return Object.entries(profile || {})
    .filter(([key, value]) => TOKEN_FILE_KEY.test(key) && typeof value === 'string' && value)
    .map(([key, file]) => ({ key, file }));
}

function loadAppConfig(appConfigPath, file) {
  let raw;
  try {
    raw = fs.readFileSync(appConfigPath, 'utf8');
  } catch (error) {
    throw invalid('appConfigPath', file, `无法读取（${error.message}）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalid('appConfigPath', file, `不是合法 JSON（${error.message}）`);
  }
  if (!parsed || typeof parsed !== 'object') {
    throw invalid('appConfigPath', file, '应为对象');
  }
  for (const key of ['appId', 'installationId', 'privateKeyFile']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) {
      throw invalid('appConfigPath', file, `缺少 ${key}`);
    }
  }
  if (!path.isAbsolute(parsed.privateKeyFile)) {
    throw invalid('appConfigPath', file, 'privateKeyFile 应为绝对路径');
  }
  checkSecretFile(parsed.privateKeyFile, 'privateKeyFile');
  return parsed;
}

/**
 * 两级 App 配置：`apps: { read: {...}, write: {...} }`。
 * - read：①读 App（只做单仓读）；write：②写 App（评论 / issue / sub-issue / 推分支 / PR / workflow）。
 *   评论与 issue 写出来作者是 `<app>[bot]`，要同时在 `trustedBotLogins` 里写上它，否则轮次认不出来。
 * - 每个 app：`appId`（正的安全整数或纯数字字符串，不收前导零）、`privateKeyFile`（绝对路径）、`owners`（默认 `[ownerLogin]`）。
 * - 安装号不在这里配：运行时用私钥 JWT 调 `GET /app/installations` 查。
 * - 只校格式，不在这里碰私钥文件：私钥缺失 / 不可读 / 权限不对时，用的时候回退账号令牌并记一行日志
 *   （整台验收机不能因为一枚没部署的私钥就停下）。
 */
function parseApps(raw, file, ownerLogin) {
  if (!Object.hasOwn(raw, 'apps') || raw.apps === undefined || raw.apps === null) return undefined;
  const value = raw.apps;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('apps', file, '应为对象，可只配 read / write 里的一个');
  }
  const parseApp = (candidate, key) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw invalid(key, file, '应为对象');
    }
    for (const field of Object.keys(candidate)) {
      if (!['appId', 'privateKeyFile', 'owners'].includes(field)) {
        throw invalid(key, file, `不认识的键「${field}」（只认 appId / privateKeyFile / owners）`);
      }
    }
    const appId = candidate.appId;
    // appId 会原样进 JWT 的 iss（`String(appId)`）：只认正的**安全整数**，且数字串不接受前导零。
    // '00' / '007' 与 '0' / '7' 在 GitHub 侧是不同的字符串，String() 会原样签成 iss；1e21 这种更是
    // String(1e21) === '1e+21'，签出来本身就是非法 iss。与其等第一次取令牌才 401，不如加载时就报错。
    const appIdOk =
      (typeof appId === 'string' && /^[1-9]\d*$/.test(appId) && Number.isSafeInteger(Number(appId))) ||
      (typeof appId === 'number' && Number.isSafeInteger(appId) && appId > 0);
    if (!appIdOk) {
      throw invalid(`${key}.appId`, file, '应为正的安全整数或纯数字字符串（不接受前导零、小数、布尔）');
    }
    const privateKeyFile = candidate.privateKeyFile;
    if (typeof privateKeyFile !== 'string' || !privateKeyFile || !path.isAbsolute(privateKeyFile)) {
      throw invalid(`${key}.privateKeyFile`, file, '应为绝对路径');
    }
    let owners = [ownerLogin];
    if (candidate.owners !== undefined && candidate.owners !== null) {
      if (
        !Array.isArray(candidate.owners) ||
        candidate.owners.length === 0 ||
        candidate.owners.some((entry) => typeof entry !== 'string' || !/^[A-Za-z0-9-]+$/.test(entry))
      ) {
        throw invalid(`${key}.owners`, file, '应为非空 owner 登录名数组');
      }
      owners = [...candidate.owners];
    }
    return Object.freeze({ appId: String(appId), privateKeyFile, owners: Object.freeze(owners) });
  };
  const out = {};
  for (const role of Object.keys(value)) {
    if (role !== 'read' && role !== 'write') {
      throw invalid('apps', file, `不认识的键「${role}」（只认 read / write）`);
    }
    out[role] = parseApp(value[role], `apps.${role}`);
  }
  if (Object.keys(out).length === 0) throw invalid('apps', file, '至少要配 read 或 write 里的一个');
  return Object.freeze(out);
}

/** 读取并校验验收机 profile；失败抛 ProfileError（code=PROFILE_INVALID）。 */
export function loadAcceptanceProfile(env = process.env) {
  const file = profilePath(env);
  const raw = readProfileFile(file);

  const ownerLogin = requireString(raw, 'ownerLogin', file);

  if (!Object.hasOwn(raw, 'projectNumber')) throw missing('projectNumber', file);
  if (!Number.isInteger(raw.projectNumber) || raw.projectNumber <= 0) {
    throw invalid('projectNumber', file, '应为正整数');
  }
  const projectNumber = raw.projectNumber;

  const stateDir = requireAbsolute(raw, 'stateDir', file);
  const worktreeDir = requireAbsolute(raw, 'worktreeDir', file);

  const startAt = requireString(raw, 'startAt', file);
  if (Number.isNaN(Date.parse(startAt))) {
    throw invalid('startAt', file, '应为可被 Date 解析的 ISO-8601 时间');
  }

  const githubTokenFile = requireAbsolute(raw, 'githubTokenFile', file);
  checkSecretFile(githubTokenFile, 'githubTokenFile');

  const autoRepos = requireRepoList(raw, 'autoRepos', file, [`${ownerLogin}/*`]);
  const forkRepos = requireRepoList(raw, 'forkRepos', file, ['makecindy/cindy']);
  const watchRepos = requireRepoList(raw, 'watchRepos', file, []);
  const forkTargets = parseForkTargets(raw, file, { ownerLogin, forkRepos });
  const verdictOnlyIssues = optionalIssueList(raw, 'verdictOnlyIssues', file);

  let stallMinutes = 30;
  if (Object.hasOwn(raw, 'stallMinutes') && raw.stallMinutes !== undefined && raw.stallMinutes !== null) {
    if (typeof raw.stallMinutes !== 'number' || !Number.isFinite(raw.stallMinutes) || raw.stallMinutes <= 0) {
      throw invalid('stallMinutes', file, '应为正数');
    }
    stallMinutes = raw.stallMinutes;
  }

  let writeCommand;
  if (Object.hasOwn(raw, 'writeCommand') && raw.writeCommand !== undefined && raw.writeCommand !== null) {
    if (typeof raw.writeCommand === 'string') {
      if (!raw.writeCommand) throw invalid('writeCommand', file, '不能为空');
      writeCommand = [raw.writeCommand];
    } else if (Array.isArray(raw.writeCommand)) {
      if (raw.writeCommand.length === 0 || raw.writeCommand.some((item) => typeof item !== 'string' || !item)) {
        throw invalid('writeCommand', file, '应为非空字符串数组（或单个字符串）');
      }
      writeCommand = [...raw.writeCommand];
    } else {
      throw invalid('writeCommand', file, '应为非空字符串数组（或单个字符串）');
    }
  }

  const appConfigPath = optionalAbsolute(raw, 'appConfigPath', file);
  const appPrivateKeyFile = appConfigPath ? loadAppConfig(appConfigPath, file).privateKeyFile : undefined;
  // 两级 App 配置（app → owner）：配了 apps 就不再走 appTokenCommand；appConfigPath 在场时也不做按仓分流。
  const apps = parseApps(raw, file, ownerLogin);

  // App 安装令牌分流只读轮询：appTokenCommand 是一条外部命令（argv 数组），标准输出打印安装令牌；
  // 只在宿主上、只给读 GitHub 的那一个 gh 子进程用。appOwners：装了这个 App 的 owner（默认只有 ownerLogin）。
  let appTokenCommand;
  if (Object.hasOwn(raw, 'appTokenCommand') && raw.appTokenCommand !== undefined && raw.appTokenCommand !== null) {
    if (!Array.isArray(raw.appTokenCommand) || raw.appTokenCommand.length === 0 || raw.appTokenCommand.some((item) => typeof item !== 'string' || !item)) {
      throw invalid('appTokenCommand', file, '应为非空字符串数组（命令和参数分开写）');
    }
    appTokenCommand = [...raw.appTokenCommand];
  }
  let appOwners = [ownerLogin];
  if (Object.hasOwn(raw, 'appOwners') && raw.appOwners !== undefined && raw.appOwners !== null) {
    if (!Array.isArray(raw.appOwners) || raw.appOwners.some((item) => typeof item !== 'string' || !/^[A-Za-z0-9-]+$/.test(item))) {
      throw invalid('appOwners', file, '应为 owner 登录名数组');
    }
    appOwners = [...raw.appOwners];
  }

  // 身份白名单只多认配置里的 App bot：没配时是 []，判断逻辑和「只认 ownerLogin」完全一致。
  const trustedBotLogins = optionalBotLogins(raw, file);

  // #61 复审决定：Slack 令牌文件权限不对 / 读不到不能让整台验收机停下，所以这里只校验路径是绝对路径，
  // 不做 checkSecretFile（那会抛错，loadAcceptanceProfile 失败整拍就停）。权限 / 属主 / 符号链接 / 空文件
  // 由 host/slack-notify.mjs 在读之前检查：不满足就不读令牌、跳过通知、原因写进心跳；doctor 照样报出来。
  const slackBotTokenFile = optionalAbsolute(raw, 'slackBotTokenFile', file);

  // #61：Slack 频道 id 和可选的 @ 用户 id，都只做格式校验，代码里不写死任何频道。
  const slackChannelId = optionalPattern(raw, 'slackChannelId', file, /^[CG][A-Z0-9]+$/, '应以 C 或 G 开头，只含大写字母和数字');
  const slackMentionUserId = optionalPattern(raw, 'slackMentionUserId', file, /^U[A-Z0-9]+$/, '应以 U 开头，只含大写字母和数字');

  return Object.freeze({
    ownerLogin,
    projectNumber,
    stateDir,
    worktreeDir,
    startAt,
    githubTokenFile,
    autoRepos: Object.freeze(autoRepos),
    forkRepos: Object.freeze(forkRepos),
    forkTargets: Object.freeze(forkTargets),
    watchRepos: Object.freeze(watchRepos),
    verdictOnlyIssues: Object.freeze(verdictOnlyIssues),
    stallMinutes,
    writeCommand: writeCommand ? Object.freeze(writeCommand) : undefined,
    appConfigPath,
    appPrivateKeyFile,
    apps,
    appTokenCommand: appTokenCommand ? Object.freeze(appTokenCommand) : undefined,
    appOwners: Object.freeze(appOwners),
    trustedBotLogins: Object.freeze(trustedBotLogins),
    slackBotTokenFile,
    slackChannelId,
    slackMentionUserId,
    profilePath: file,
  });
}
