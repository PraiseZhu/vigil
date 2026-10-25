#!/usr/bin/env node
// 验收机配置：只从 <home>/config/profile.json 读键；home 才允许来自环境变量。
// 缺必填项直接报错（fail-closed），不回落任何个人路径或令牌环境变量。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_ENV = 'ACCEPTANCE_WATCHER_HOME';
const REPO_PATTERN = /^[^/]+\/([^/]+|\*)$/;

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

  const slackBotTokenFile = optionalAbsolute(raw, 'slackBotTokenFile', file);
  if (slackBotTokenFile) checkSecretFile(slackBotTokenFile, 'slackBotTokenFile');

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
    watchRepos: Object.freeze(watchRepos),
    stallMinutes,
    writeCommand: writeCommand ? Object.freeze(writeCommand) : undefined,
    appConfigPath,
    appPrivateKeyFile,
    slackBotTokenFile,
    slackChannelId,
    slackMentionUserId,
    profilePath: file,
  });
}
