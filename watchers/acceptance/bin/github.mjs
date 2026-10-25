#!/usr/bin/env node
// GitHub 读写的唯一出口：本文件才允许 spawn / 触网。
// 读：配了 appConfigPath 走 App 安装令牌，否则走账号令牌。
// 写：一律走账号令牌；配了 writeCommand 则整段交给写闸，绝不回落直接写。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSecretFile, ProfileError } from './profile.mjs';

/** 只在这里读 GitHub 令牌：先过 600 检查，再读文件；从不读环境变量。 */
function readGithubToken(profile) {
  if (!profile?.githubTokenFile) throw new ProfileError('缺少必需配置「githubTokenFile」。');
  checkSecretFile(profile.githubTokenFile, 'githubTokenFile');
  const token = fs.readFileSync(profile.githubTokenFile, 'utf8').trim();
  if (!token) throw new ProfileError('配置无效「githubTokenFile」：文件为空。');
  return token;
}

export const WRITE_TYPES = Object.freeze([
  'comment.create',
  'comment.update',
  'issue.create',
  'issue.close',
  'issue.reopen',
  'issue.edit',
  'subissue.add',
  'project.field.set',
  'branch.push',
  'pr.create',
  'pr.ready',
]);

/** #60 的两个写闸动作：不放进 #44 的 11 类里，但同样经 write() 执行。 */
export const GATE_ACTION_WRITE_TYPES = Object.freeze(['pr.update-branch', 'ci.rerun']);

const WRITE_TYPE_SET = new Set([...WRITE_TYPES, ...GATE_ACTION_WRITE_TYPES]);
const BOARD_FIELDS = new Set(['验收', '裁决']);

export class WriteBusyError extends Error {
  constructor(message = '外发忙') {
    super(message);
    this.name = 'WriteBusyError';
    this.code = 'WRITE_GATE_BUSY';
  }
}

export class WriteRejectedError extends Error {
  constructor(message = '外发被拒', { exitCode, reason } = {}) {
    super(message);
    this.name = 'WriteRejectedError';
    this.code = 'WRITE_GATE_REJECTED';
    this.exitCode = exitCode;
    this.reason = reason;
  }
}

function defaultRun(cmd, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
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

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseEnv() {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1',
  };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (process.env.TZ) env.TZ = process.env.TZ;
  return env;
}

function ghEnv(token) {
  return { ...baseEnv(), GH_TOKEN: token };
}

function gitEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...baseEnv(),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

function redact(text, tokens) {
  let out = String(text ?? '');
  for (const token of tokens) {
    if (token) out = out.split(token).join('***');
  }
  return out;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function withDedupeKey(action) {
  if (action.dedupeKey) return action;
  const { dedupeKey: _ignored, ...rest } = action;
  return { ...action, dedupeKey: sha256hex(stableStringify(rest)) };
}

function signJwt(pem, payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${header}.${body}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(data);
  const sig = signer.sign(pem, 'base64url');
  return `${data}.${sig}`;
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} 返回的不是 JSON：${error.message}`);
  }
}

export function createGithub({ profile, run, fetchImpl, sleep, now } = {}) {
  if (!profile) throw new Error('createGithub 需要 profile');
  const runCmd = run || defaultRun;
  const fetchFn = fetchImpl || globalThis.fetch;
  const sleepFn = sleep || defaultSleep;
  const nowFn = now || (() => Date.now());

  let ownerTokenCache;
  let appTokenCache;

  function getOwnerToken() {
    if (!ownerTokenCache) ownerTokenCache = readGithubToken(profile);
    return ownerTokenCache;
  }

  async function mintAppToken() {
    if (appTokenCache) return appTokenCache;
    const raw = fs.readFileSync(profile.appConfigPath, 'utf8');
    const appConfig = JSON.parse(raw);
    const pem = fs.readFileSync(appConfig.privateKeyFile, 'utf8');
    const nowSec = Math.floor(nowFn() / 1000);
    const jwt = signJwt(pem, {
      iat: nowSec - 60,
      exp: nowSec + 540,
      iss: String(appConfig.appId),
    });
    const url = `https://api.github.com/app/installations/${appConfig.installationId}/access_tokens`;
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
      },
    });
    const data = typeof res.json === 'function' ? await res.json() : res;
    if (res && res.ok === false) {
      throw new Error(`铸造 App 令牌失败：${res.status}`);
    }
    if (!data?.token) throw new Error('铸造 App 令牌失败：响应没有 token');
    appTokenCache = data.token;
    return appTokenCache;
  }

  async function getReadToken() {
    if (profile.appConfigPath) return mintAppToken();
    return getOwnerToken();
  }

  function failFrom(result, token) {
    const detail = redact(result.stderr || result.stdout || `exit ${result.code}`, [token, ownerTokenCache, appTokenCache]);
    throw new Error(detail);
  }

  async function graphql(query, variables) {
    const token = await getReadToken();
    const result = await runCmd('gh', ['api', 'graphql', '--input', '-'], {
      env: ghEnv(token),
      input: JSON.stringify({ query, variables }),
    });
    if (result.code !== 0) failFrom(result, token);
    const parsed = parseJson(result.stdout, 'GraphQL');
    if (parsed.errors?.length) {
      throw new Error(redact(parsed.errors.map((err) => err.message).join('; '), [token]));
    }
    return parsed.data ?? parsed;
  }

  async function ghApi(method, apiPath, body) {
    const token = getOwnerToken();
    const args = ['api', '-X', method, apiPath];
    if (body !== undefined) args.push('--input', '-');
    const result = await runCmd('gh', args, {
      env: ghEnv(token),
      input: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (result.code !== 0) failFrom(result, token);
    if (!String(result.stdout || '').trim()) return {};
    return parseJson(result.stdout, apiPath);
  }

  async function graphqlWrite(query, variables) {
    const token = getOwnerToken();
    const result = await runCmd('gh', ['api', 'graphql', '--input', '-'], {
      env: ghEnv(token),
      input: JSON.stringify({ query, variables }),
    });
    if (result.code !== 0) failFrom(result, token);
    const parsed = parseJson(result.stdout, 'GraphQL 写入');
    if (parsed.errors?.length) {
      throw new Error(redact(parsed.errors.map((err) => err.message).join('; '), [token]));
    }
    return parsed.data ?? parsed;
  }

  async function setProjectFields(action) {
    const { repo, issue, fields = {}, ownerLogin, projectNumber } = action;
    for (const name of Object.keys(fields)) {
      if (!BOARD_FIELDS.has(name)) {
        throw new Error(`拒绝写入看板字段「${name}」`);
      }
    }
    const [owner, name] = String(repo).split('/');
    const login = ownerLogin || profile.ownerLogin;
    const number = projectNumber ?? profile.projectNumber;
    // 写路径上的查找也用账号令牌：App 令牌看不到个人账号下的看板。
    const data = await graphqlWrite(
      `query ($login: String!, $projectNumber: Int!, $owner: String!, $name: String!, $issue: Int!) {
        user(login: $login) {
          projectV2(number: $projectNumber) {
            id
            fields(first: 50) {
              nodes {
                __typename
                ... on ProjectV2FieldCommon { id name dataType }
                ... on ProjectV2SingleSelectField { options { id name } }
              }
            }
          }
        }
        repository(owner: $owner, name: $name) {
          issue(number: $issue) {
            id
            projectItems(first: 20, includeArchived: true) {
              nodes { id isArchived project { id } }
            }
          }
        }
      }`,
      { login, projectNumber: number, owner, name, issue: Number(issue) },
    );
    const project = data.user?.projectV2;
    if (!project?.id) throw new Error(`找不到看板 #${number}`);
    const issueNode = data.repository?.issue;
    if (!issueNode?.id) throw new Error(`找不到 issue ${repo}#${issue}`);
    const fieldByName = new Map();
    for (const node of project.fields?.nodes || []) {
      if (node?.name) fieldByName.set(node.name, node);
    }
    let item = (issueNode.projectItems?.nodes || []).find((node) => node.project?.id === project.id);
    if (!item) {
      const added = await graphqlWrite(
        `mutation ($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
            item { id }
          }
        }`,
        { projectId: project.id, contentId: issueNode.id },
      );
      item = { id: added.addProjectV2ItemById?.item?.id, isArchived: false };
    }
    if (!item?.id) throw new Error('无法把条目加入看板');
    if (item.isArchived) {
      await graphqlWrite(
        `mutation ($projectId: ID!, $itemId: ID!) {
          unarchiveProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
            item { id }
          }
        }`,
        { projectId: project.id, itemId: item.id },
      );
    }
    if (Object.hasOwn(fields, '验收')) {
      const field = fieldByName.get('验收');
      if (!field?.id) throw new Error('看板没有「验收」字段');
      const option = (field.options || []).find((entry) => entry.name === fields['验收']);
      if (!option?.id) throw new Error(`验收字段没有选项「${fields['验收']}」`);
      await graphqlWrite(
        `mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
            value: { singleSelectOptionId: $optionId }
          }) { projectV2Item { id } }
        }`,
        { projectId: project.id, itemId: item.id, fieldId: field.id, optionId: option.id },
      );
    }
    if (Object.hasOwn(fields, '裁决')) {
      const field = fieldByName.get('裁决');
      if (!field?.id) throw new Error('看板没有「裁决」字段');
      if (field.dataType === 'SINGLE_SELECT') {
        throw new Error('「裁决」字段必须是文本，不能是单选');
      }
      await graphqlWrite(
        `mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
            value: { text: $text }
          }) { projectV2Item { id } }
        }`,
        { projectId: project.id, itemId: item.id, fieldId: field.id, text: String(fields['裁决']) },
      );
    }
    return { itemId: item.id, projectId: project.id };
  }

  async function pushBranch(action) {
    const token = getOwnerToken();
    const { repo, branch, bundlePath } = action;
    // 参数会进 git 命令行：bundle 必须是绝对路径（不可能以 - 开头被当成选项），分支和仓名只收安全字符。
    if (typeof bundlePath !== 'string' || !path.isAbsolute(bundlePath)) {
      throw new Error('branch.push 的 bundlePath 必须是绝对路径');
    }
    if (typeof branch !== 'string' || !/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
      throw new Error(`branch.push 的分支名不合法：${branch}`);
    }
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.startsWith('-')) {
      throw new Error(`branch.push 的仓名不合法：${repo}`);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-push-'));
    const env = gitEnv(token);
    try {
      let result = await runCmd('git', ['init', '--bare', tmp], { env });
      if (result.code !== 0) failFrom(result, token);
      result = await runCmd(
        'git',
        ['--git-dir', tmp, 'fetch', bundlePath, `refs/heads/${branch}:refs/heads/${branch}`],
        { env },
      );
      if (result.code !== 0) failFrom(result, token);
      result = await runCmd(
        'git',
        ['--git-dir', tmp, 'push', `https://github.com/${repo}.git`, `refs/heads/${branch}:refs/heads/${branch}`],
        { env },
      );
      if (result.code !== 0) failFrom(result, token);
      return { repo, branch };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function fetchBranch({ repo, branch = 'main', dir, depth = 50 } = {}) {
    const token = getOwnerToken();
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.startsWith('-')) {
      throw new Error(`fetchBranch 的仓名不合法：${repo}`);
    }
    if (typeof branch !== 'string' || !/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
      throw new Error(`fetchBranch 的分支名不合法：${branch}`);
    }
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('fetchBranch 需要绝对路径的 dir');
    const env = gitEnv(token);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    let result = await runCmd('git', ['init', '-q', dir], { env });
    if (result.code !== 0) failFrom(result, token);
    // 令牌只在 GIT_CONFIG_* extraheader 里（gitEnv）；URL / argv / 配置里都不带。
    result = await runCmd(
      'git',
      ['-C', dir, 'fetch', `--depth=${Number(depth)}`, `https://github.com/${repo}.git`, `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { env },
    );
    if (result.code !== 0) failFrom(result, token);
    return { dir, repo, branch };
  }

  async function directWrite(action) {
    switch (action.type) {
      case 'comment.create': {
        const data = await ghApi('POST', `repos/${action.repo}/issues/${action.issue}/comments`, { body: action.body });
        return { commentId: data.id, url: data.html_url };
      }
      case 'comment.update': {
        const data = await ghApi('PATCH', `repos/${action.repo}/issues/comments/${action.commentId}`, { body: action.body });
        return { commentId: data.id ?? action.commentId, url: data.html_url };
      }
      case 'issue.create': {
        const data = await ghApi('POST', `repos/${action.repo}/issues`, {
          title: action.title,
          body: action.body,
          labels: action.labels,
        });
        return { issue: data.number, url: data.html_url, nodeId: data.node_id, id: data.id };
      }
      case 'issue.close': {
        const data = await ghApi('PATCH', `repos/${action.repo}/issues/${action.issue}`, {
          state: 'closed',
          state_reason: action.reason || 'completed',
        });
        return { issue: data.number ?? action.issue, url: data.html_url };
      }
      case 'issue.reopen': {
        const data = await ghApi('PATCH', `repos/${action.repo}/issues/${action.issue}`, { state: 'open' });
        return { issue: data.number ?? action.issue, url: data.html_url };
      }
      case 'issue.edit': {
        const data = await ghApi('PATCH', `repos/${action.repo}/issues/${action.issue}`, { body: action.body });
        return { issue: data.number ?? action.issue, url: data.html_url };
      }
      case 'subissue.add': {
        const sub = await ghApi('GET', `repos/${action.subRepo}/issues/${action.subIssue}`);
        const data = await ghApi('POST', `repos/${action.repo}/issues/${action.issue}/sub_issues`, {
          sub_issue_id: sub.id,
        });
        return { issue: action.issue, subIssue: action.subIssue, id: data.id };
      }
      case 'project.field.set':
        return setProjectFields(action);
      case 'branch.push':
        return pushBranch(action);
      case 'pr.create': {
        const data = await ghApi('POST', `repos/${action.repo}/pulls`, {
          head: action.head,
          base: action.base || 'main',
          title: action.title,
          body: action.body,
          draft: action.draft !== undefined ? action.draft : true,
        });
        return { pr: data.number, url: data.html_url };
      }
      case 'pr.ready': {
        const token = getOwnerToken();
        const result = await runCmd('gh', ['pr', 'ready', String(action.pr), '-R', action.repo], {
          env: ghEnv(token),
        });
        if (result.code !== 0) failFrom(result, token);
        return { pr: action.pr, repo: action.repo };
      }
      case 'pr.update-branch': {
        const data = await ghApi('PUT', `repos/${action.repo}/pulls/${action.pr}/update-branch`, {
          expected_head_sha: action.expectedHeadSha,
        });
        return { pr: action.pr, repo: action.repo, message: data.message, url: data.html_url };
      }
      case 'ci.rerun': {
        await ghApi('POST', `repos/${action.repo}/actions/runs/${action.runId}/rerun-failed-jobs`);
        return { pr: action.pr, repo: action.repo, runId: action.runId };
      }
      default:
        throw new Error(`未知写操作类型：${action.type}`);
    }
  }

  async function writeViaCommand(action) {
    const argv = profile.writeCommand;
    const env = baseEnv();
    let last;
    for (let attempt = 0; attempt < 7; attempt += 1) {
      last = await runCmd(argv[0], argv.slice(1), {
        env,
        input: JSON.stringify(action),
      });
      if (last.code === 0) {
        if (!String(last.stdout || '').trim()) return {};
        return parseJson(last.stdout, 'writeCommand');
      }
      if (last.code === 75) {
        if (attempt === 6) throw new WriteBusyError('外发忙');
        await sleepFn(30000);
        continue;
      }
      let reason;
      try {
        reason = JSON.parse(last.stdout)?.reason;
      } catch {
        reason = undefined;
      }
      throw new WriteRejectedError('外发被拒', { exitCode: last.code, reason });
    }
    throw new WriteBusyError('外发忙');
  }

  async function write(action) {
    if (!action || !WRITE_TYPE_SET.has(action.type)) {
      throw new Error(`未知写操作类型：${action?.type}`);
    }
    const prepared = withDedupeKey(action);
    if (profile.writeCommand) return writeViaCommand(prepared);
    return directWrite(prepared);
  }

  return { graphql, write, fetchBranch, profile };
}
