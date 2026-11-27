import fs from 'node:fs';
import path from 'node:path';

export const REPO = /^[a-z\d][a-z\d-]*\/(?!\.{1,2}$)[a-z\d_.-]+$/i;
const AUTHOR = /^(?:app\/)?[a-z\d][a-z\d-]*$/i;
const OWNER = /^[a-z\d][a-z\d-]*$/i;
const SEVERITIES = ['low', 'medium', 'high', 'critical'];

function requireConfig(profile, key) {
  if (profile[key] == null || profile[key] === '') throw new Error(`缺少必需配置「${key}」`);
  return profile[key];
}

function object(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`配置「${key}」必须是对象`);
  return value;
}

function strings(value, key, valid = Boolean) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && valid(item))) {
    throw new Error(`配置「${key}」必须是有效的字符串列表`);
  }
  return [...new Set(value)];
}

function patterns(value, key) {
  return strings(value, key).map((source) => {
    try { return new RegExp(source, 'i'); }
    catch { throw new Error(`配置「${key}」包含无效正则`); }
  });
}

function boolean(value, key) {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`配置「${key}」必须是布尔值`);
  return value ?? false;
}

function captureGroups(source) {
  return new RegExp(`${source}|`).exec('').length - 1;
}

function parseChores(chores, key) {
  const syncBase = chores.syncBase;
  if (syncBase !== undefined) {
    object(syncBase, `${key}.syncBase`);
    const enabled = boolean(syncBase.enabled, `${key}.syncBase.enabled`);
    const bases = patterns(syncBase.bases ?? [], `${key}.syncBase.bases`);
    if (enabled && !bases.length) throw new Error(`配置「${key}.syncBase.bases」启用时不能为空`);
    if (syncBase.minBehind !== undefined && !(Number.isSafeInteger(syncBase.minBehind) && syncBase.minBehind > 0)) {
      throw new Error(`配置「${key}.syncBase.minBehind」必须是正整数`);
    }
    if (syncBase.maxAgeHours !== undefined && !(typeof syncBase.maxAgeHours === 'number'
      && Number.isFinite(syncBase.maxAgeHours) && syncBase.maxAgeHours > 0)) {
      throw new Error(`配置「${key}.syncBase.maxAgeHours」必须是正数`);
    }
  }
  if (chores.reverifiedSeverities !== undefined) {
    strings(chores.reverifiedSeverities, `${key}.reverifiedSeverities`, (level) => ['P0', 'P1', 'P2', 'P3'].includes(level));
  }
  const keyPattern = chores.reverifiedKeyPattern;
  if (keyPattern !== undefined) {
    let groups;
    try { groups = typeof keyPattern === 'string' && keyPattern ? captureGroups(keyPattern) : -1; } catch { groups = -1; }
    if (groups !== 1) throw new Error(`配置「${key}.reverifiedKeyPattern」必须是恰好含一个捕获组的正则`);
  }
}

function parsePolicy(value, key) {
  const policy = object(value, key);
  parseChores(object(policy.chores ?? {}, `${key}.chores`), `${key}.chores`);
  const optionalChecks = object(policy.optionalChecks ?? {}, `${key}.optionalChecks`);
  const login = policy.chores?.followerLogin;
  if (login !== undefined && (typeof login !== 'string' || !/^[a-z\d][a-z\d-]*$/i.test(login))) {
    throw new Error(`无效的配置「${key}.chores.followerLogin」`);
  }
  const trustedReviewers = strings(policy.trustedReviewers ?? [], `${key}.trustedReviewers`,
    (login) => AUTHOR.test(login) || /^[a-z\d-]+\[bot\]$/i.test(login));
  const severityPatterns = object(policy.severityPatterns ?? {}, `${key}.severityPatterns`);
  for (const level of Object.keys(severityPatterns)) {
    if (!['P0', 'P1', 'P2', 'P3'].includes(level)) throw new Error(`无效的审查等级：${key}.severityPatterns`);
  }
  const codeScanning = object(policy.codeScanning ?? {}, `${key}.codeScanning`);
  if (codeScanning.enabled !== undefined && typeof codeScanning.enabled !== 'boolean') {
    throw new Error(`配置「${key}.codeScanning.enabled」必须是布尔值`);
  }
  const threshold = codeScanning.threshold ?? 'high';
  if (!SEVERITIES.includes(threshold)) throw new Error(`无效的配置「${key}.codeScanning.threshold」`);
  return {
    ...policy,
    trustedReviewers,
    severityPatterns: Object.fromEntries(Object.entries(severityPatterns).map(
      ([level, sources]) => [level, patterns(sources, `${key}.severityPatterns.${level}`)],
    )),
    infraPatterns: patterns(policy.infraPatterns ?? [], `${key}.infraPatterns`),
    infraRequiresAllAnnotations: boolean(policy.infraRequiresAllAnnotations, `${key}.infraRequiresAllAnnotations`),
    optionalChecks: {
      block: boolean(optionalChecks.block, `${key}.optionalChecks.block`),
      ignorePatterns: patterns(optionalChecks.ignorePatterns ?? [], `${key}.optionalChecks.ignorePatterns`),
    },
    codeScanning: { enabled: codeScanning.enabled ?? false, threshold },
  };
}

function parsePresence(value) {
  const presence = object(value ?? {}, 'presence');
  const commands = object(presence.commands ?? presence, 'presence.commands');
  for (const [device, command] of Object.entries(commands)) {
    if (!device.trim() || typeof command !== 'string' || !command.trim()) {
      throw new Error('配置「presence.commands」必须是设备到非空命令的映射');
    }
  }
  return { commands };
}

function parseInstallation(value, key, directory) {
  const installation = object(value, key);
  for (const field of ['appId', 'installationId']) {
    if (!/^[1-9]\d*$/.test(String(installation[field]))) {
      throw new Error(`无效或缺少必需配置「${key}.${field}」`);
    }
  }
  if (typeof installation.privateKeyFile !== 'string' || !installation.privateKeyFile.trim()) {
    throw new Error(`缺少必需配置「${key}.privateKeyFile」`);
  }
  return { ...installation, mode: 'app', privateKeyFile: path.resolve(directory, installation.privateKeyFile) };
}

function parseGithub(value, directory) {
  const github = object(value ?? {}, 'github');
  const mode = github.mode ?? 'gh';
  if (mode === 'gh') return { mode };
  if (mode === 'app') return parseInstallation(github, 'github', directory);
  if (mode !== 'by-owner') throw new Error('配置「github.mode」必须是 gh、app 或 by-owner');
  const entries = object(github.installations, 'github.installations');
  const installations = new Map();
  for (const [owner, installation] of Object.entries(entries)) {
    const key = `github.installations.${owner}`;
    if (!OWNER.test(owner)) throw new Error(`配置「${key}」必须以 GitHub 账号或组织登录名为键`);
    const normalized = owner.toLowerCase();
    if (installations.has(normalized)) throw new Error(`配置「${key}」重复（不区分大小写）`);
    installations.set(normalized, parseInstallation(installation, key, directory));
  }
  return { mode, installations: Object.fromEntries(installations) };
}

export function appForRepo(github, repo) {
  if (github?.mode === 'app') return github;
  if (github?.mode !== 'by-owner' || !repo) return undefined;
  const owner = repo.split('/')[0].toLowerCase();
  return Object.hasOwn(github.installations, owner) ? github.installations[owner] : undefined;
}

export function loadProfile({ env = process.env, file = env.STEWARD_PROFILE } = {}) {
  if (!file) throw new Error('缺少必需配置「STEWARD_PROFILE」：请指定本机配置文件');
  const profile = object(JSON.parse(fs.readFileSync(file, 'utf8')), 'profile');
  const authors = strings(requireConfig(profile, 'authors'), 'authors', (author) => AUTHOR.test(author));
  if (!authors.length) throw new Error('配置「authors」不能为空');
  const repos = strings(profile.repos ?? [], 'repos', (repo) => REPO.test(repo));
  const excludeRepos = strings(profile.excludeRepos ?? [], 'excludeRepos', (repo) => REPO.test(repo));
  const discoverByAuthor = profile.discoverByAuthor ?? false;
  if (typeof discoverByAuthor !== 'boolean') throw new Error('配置「discoverByAuthor」必须是布尔值');
  if (!repos.length && !discoverByAuthor) throw new Error('配置「repos」不能为空，除非启用 discoverByAuthor');
  const stateDir = requireConfig(profile, 'stateDir');
  if (typeof stateDir !== 'string' || !stateDir.trim()) throw new Error('配置「stateDir」必须是路径');
  const directory = path.dirname(path.resolve(file));
  const github = parseGithub(profile.github, directory);
  const policies = Object.fromEntries(Object.entries(object(profile.policies ?? {}, 'policies')).map(([repo, policy]) => {
    if (!REPO.test(repo)) throw new Error('配置「policies」必须以 owner/repo 为键');
    return [repo.toLowerCase(), parsePolicy(policy, `policies.${repo}`)];
  }));
  return {
    authors, repos, excludeRepos, discoverByAuthor, policies,
    presence: parsePresence(profile.presence),
    stateDir: path.resolve(directory, stateDir),
    github,
  };
}
