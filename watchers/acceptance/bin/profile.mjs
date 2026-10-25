#!/usr/bin/env node
// 验收机配置：只从 <home>/config/profile.json 读键；home 才允许来自环境变量。
// 缺必填项直接报错（fail-closed），不回落任何个人路径或令牌环境变量。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    slackBotTokenFile,
    slackChannelId,
    slackMentionUserId,
    profilePath: file,
  });
}
