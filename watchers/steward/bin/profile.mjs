import fs from 'node:fs';
import path from 'node:path';

export const REPO = /^[a-z\d][a-z\d-]*\/(?!\.{1,2}$)[a-z\d_.-]+$/i;
const AUTHOR = /^(?:app\/)?[a-z\d][a-z\d-]*$/i;
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

function parsePolicy(value, key) {
  const policy = object(value, key);
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
    codeScanning: { enabled: codeScanning.enabled ?? false, threshold },
  };
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
  const github = object(profile.github ?? {}, 'github');
  const mode = github.mode ?? 'gh';
  if (!['gh', 'app'].includes(mode)) throw new Error('配置「github.mode」必须是 gh 或 app');
  if (mode === 'app') {
    for (const key of ['appId', 'installationId']) {
      if (!/^[1-9]\d*$/.test(String(github[key]))) throw new Error(`无效或缺少必需配置「github.${key}」`);
    }
    if (typeof github.privateKeyFile !== 'string' || !github.privateKeyFile.trim()) {
      throw new Error('缺少必需配置「github.privateKeyFile」');
    }
  }
  const directory = path.dirname(path.resolve(file));
  const policies = Object.fromEntries(Object.entries(object(profile.policies ?? {}, 'policies')).map(([repo, policy]) => {
    if (!REPO.test(repo)) throw new Error('配置「policies」必须以 owner/repo 为键');
    return [repo.toLowerCase(), parsePolicy(policy, `policies.${repo}`)];
  }));
  return {
    authors, repos, excludeRepos, discoverByAuthor, policies,
    stateDir: path.resolve(directory, stateDir),
    github: mode === 'app' ? { ...github, mode, privateKeyFile: path.resolve(directory, github.privateKeyFile) } : { mode },
  };
}
