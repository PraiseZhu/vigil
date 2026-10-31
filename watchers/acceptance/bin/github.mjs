#!/usr/bin/env node
// GitHub 读写的唯一出口：本文件才允许 spawn / 触网。
// 读：配了 appConfigPath 走 App 安装令牌，否则走账号令牌。
// 配了 appTokenCommand（外部命令打印 App 安装令牌）：落在 appOwners 名下单个仓上的只读查询优先走 App 令牌，
// 取不到令牌、或 App 读到 401/403/404 时回退账号令牌重试一次，并在宿主 loop.log 记一行（不含令牌）。
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
/** 优先级写回只许这两个字段。不能和「验收」「裁决」写在同一次动作里。 */
export const PRIO_BOARD_FIELDS = new Set(['优先级', '关联 PR']);

export class WriteBusyError extends Error {
  constructor(message = '外发忙') {
    super(message);
    this.name = 'WriteBusyError';
    this.code = 'WRITE_GATE_BUSY';
  }
}

export class WriteRejectedError extends Error {
  constructor(message = '外发被拒', { exitCode, reason, files } = {}) {
    super(message);
    this.name = 'WriteRejectedError';
    this.code = 'WRITE_GATE_REJECTED';
    this.exitCode = exitCode;
    this.reason = reason;
    // 写闸扫到密钥（reason=secret-found）时带回的文件名：只有文件名，没有内容。
    this.files = Array.isArray(files) ? files.filter((file) => typeof file === 'string' && file) : [];
  }
}

/** 写闸 / writeCommand 退出码 1 等「其他失败」（#43 接口：1 其他失败，4 才是拒绝）。 */
export class WriteFailedError extends Error {
  constructor(message = '外发失败', { exitCode, reason, detail } = {}) {
    super(message);
    this.name = 'WriteFailedError';
    this.code = 'WRITE_GATE_FAILED';
    this.exitCode = exitCode;
    this.reason = reason;
    this.detail = detail;
  }
}

export function defaultRun(cmd, args, { env, input, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    // 超时就杀掉（取镜像这种可能卡很久的命令才传 timeoutMs）。
    const timer = Number(timeoutMs) > 0 ? setTimeout(() => child.kill('SIGKILL'), Number(timeoutMs)) : null;
    child.on('close', () => timer && clearTimeout(timer));
    let stdout = '';
    let stderr = '';
    // 按 UTF-8 流式解码：输出大于一个管道块（约 64 KiB）时，多字节字符可能被切在两块之间，
    // 逐块 `+=` 会把它拼成乱码（比如正文里的「。」变成两个 U+FFFD），正文版本随之变掉，
    // 已验过的总 issue 每拍都被误判「正文变了」。setEncoding 交给 StringDecoder 跨块拼好。
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
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

/** 取镜像的超时（10 分钟）和磁盘上限（2 GiB）。常量，不可配。 */
export const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
export const MIRROR_MAX_BYTES = 2 * 1024 ** 3;

/**
 * 宿主镜像上的 git：不读系统 / 全局配置，钩子、fsmonitor、代理、凭据助手全关，协议只许 https。
 * 仓里的配置由 assertMirrorIntact 逐字节比对固定内容（MIRROR_CONFIG），所以仓级配置也改不了行为。
 */
export const MIRROR_GIT_HARDENING = Object.freeze([
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.sshCommand=false',
  '-c', 'credential.helper=',
  '-c', 'http.proxy=',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
]);
const MIRROR_ENV = Object.freeze({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
export const MIRROR_CONFIG = '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n';

function mirrorBaseEnv() {
  return { ...baseEnv(), ...MIRROR_ENV };
}

/** 宿主自己建的目录：真目录（不是符号链接）、属主是当前用户、组和其他人没有任何权限。 */
export function assertHostOwnedDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(dir, { mode: 0o700 });
    st = fs.lstatSync(dir);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`mirror-tampered：不是宿主自己的目录（符号链接或不是目录）：${path.basename(dir)}`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('mirror-tampered：目录属主不是宿主用户');
  if ((st.mode & 0o077) !== 0) throw new Error('mirror-tampered：目录权限不是 700');
}

/** 镜像仓没被动过：.git 是真目录，配置和固定内容逐字节相同，没有 commondir / alternates，顶层没有符号链接。 */
export function assertMirrorIntact(dir) {
  const gitDir = path.join(dir, '.git');
  const st = fs.lstatSync(gitDir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('mirror-tampered：.git 不是目录');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('mirror-tampered：.git 属主不是宿主用户');
  for (const entry of fs.readdirSync(gitDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`mirror-tampered：.git/${entry.name} 是符号链接`);
  }
  for (const rel of ['commondir', 'gitdir', path.join('objects', 'info', 'alternates'), path.join('objects', 'info', 'http-alternates')]) {
    if (fs.existsSync(path.join(gitDir, rel))) throw new Error(`mirror-tampered：有 ${rel}`);
  }
  const fd = fs.openSync(path.join(gitDir, 'config'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let text;
  try {
    text = fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  if (text !== MIRROR_CONFIG) throw new Error('mirror-tampered：.git/config 被改过');
}

/** 目录占多少字节（不跟符号链接）。 */
function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) total += fs.lstatSync(full).size;
    }
  }
  return total;
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
  // 沙箱里的 gh（host/sandbox-bin/gh）只认这个 socket，读要经写闸；不带过去 helper 在沙箱里一步都读不了。
  // 它只是一个 socket 路径，不是凭证；宿主上的真 gh 不看它。
  if (process.env.ACCEPTANCE_GATE_SOCKET) env.ACCEPTANCE_GATE_SOCKET = process.env.ACCEPTANCE_GATE_SOCKET;
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

/** 读请求遇 GitHub 瞬时故障时，当次重试前等多久（只重试一次）。 */
export const READ_RETRY_DELAY_MS = 4000;

/**
 * gh 失败输出是不是 GitHub / 网络的瞬时故障：502/503/504、HTTP/2 流被对方断开、连接被重置、超时。
 * 404、401、权限、GraphQL 业务错误等都不算，不重试。
 */
export function isTransientGithubFailure(result) {
  const text = `${result?.stderr || ''}\n${result?.stdout || ''}`;
  return (
    /\bHTTP 50[234]\b/.test(text) ||
    /\bstream error\b/i.test(text) ||
    /connection reset|ECONNRESET|ETIMEDOUT|i\/o timeout|TLS handshake timeout|unexpected EOF/i.test(text)
  );
}

/** GraphQL 文本是不是纯查询（不含 mutation / subscription）。拿不准一律当写，不重试。 */
export function isReadOnlyGraphql(query) {
  const text = String(query || '').replace(/#[^\n]*/g, '');
  if (!/^\s*(query\b|\{)/.test(text)) return false;
  return !/\b(mutation|subscription)\b/.test(text);
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label} 返回的不是 JSON：${error.message}`);
  }
}

/** 取 App 令牌的外部命令最多等多久（超时整组杀掉，按取不到处理、回退账号令牌）。 */
export const APP_TOKEN_TIMEOUT_MS = 30000;

/**
 * App 令牌读失败时，要不要回退账号令牌：401 / 凭证坏 → auth-401；403 / 无权限 → auth-403；
 * 404 / 找不到仓（App 没覆盖这个仓）→ not-found。超时、5xx 等不回退（照旧走只读重试规则）。
 */
export function appFallbackKind(result) {
  let text = `${result?.stderr || ''}\n`;
  if (result?.code === 0) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (!parsed?.errors?.length) return null;
      text += parsed.errors.map((err) => `${err?.type || ''} ${err?.message || ''}`).join('\n');
    } catch {
      return null;
    }
  } else {
    text += String(result?.stdout || '');
  }
  if (/\bHTTP 401\b|Bad credentials/i.test(text)) return 'auth-401';
  if (/\bHTTP 403\b|Resource not accessible by integration|\bFORBIDDEN\b/.test(text)) return 'auth-403';
  if (/\bHTTP 404\b|Could not resolve to a (Repository|node)|\bNOT_FOUND\b/.test(text)) return 'not-found';
  return null;
}

const FALLBACK_TEXT = {
  'token-failed': 'App 令牌取不到',
  'auth-401': 'App 令牌被拒（401）',
  'auth-403': 'App 令牌没权限（403）',
  'not-found': 'App 读不到这个仓（404，可能没装 App）',
};

function defaultFallbackLog(profile) {
  return (line) => {
    if (!profile?.profilePath) return;
    try {
      const hostDir = path.join(path.dirname(path.dirname(profile.profilePath)), 'state', 'host');
      fs.mkdirSync(hostDir, { recursive: true });
      fs.appendFileSync(path.join(hostDir, 'loop.log'), `${line}\n`);
    } catch {
      // 日志写不下去不影响读。
    }
  };
}

export function createGithub({ profile, run, fetchImpl, sleep, now, fallbackLog, ownerToken } = {}) {
  if (!profile) throw new Error('createGithub 需要 profile');
  const runCmd = run || defaultRun;
  const fetchFn = fetchImpl || globalThis.fetch;
  const sleepFn = sleep || defaultSleep;
  const nowFn = now || (() => Date.now());

  let ownerTokenCache;
  let appTokenCache;
  let cmdTokenCache;
  let cmdTokenFailed = false;
  const writeFallback = fallbackLog || defaultFallbackLog(profile);

  /** 这条查询落在 App 覆盖的单个仓上吗：是就返回 owner/name，不是（跨仓清单、搜索、viewer、别的组织）返回 null。 */
  function appRepoFor(variables) {
    if (!profile.appTokenCommand || profile.appConfigPath) return null;
    const owner = variables?.owner;
    const name = variables?.name;
    if (typeof owner !== 'string' || typeof name !== 'string' || !owner || !name) return null;
    const owners = profile.appOwners || [profile.ownerLogin];
    if (!owners.some((entry) => String(entry).toLowerCase() === owner.toLowerCase())) return null;
    return `${owner}/${name}`;
  }

  /** 跑外部命令取 App 令牌：只放进这次读的那个 gh 子进程；取不到就记住，这个实例里不再反复试。 */
  async function getCommandAppToken() {
    if (cmdTokenCache) return cmdTokenCache;
    if (cmdTokenFailed) return null;
    const argv = profile.appTokenCommand;
    let result = null;
    try {
      result = await runCmd(argv[0], argv.slice(1), { env: baseEnv(), timeoutMs: APP_TOKEN_TIMEOUT_MS, killGroup: true });
    } catch {
      result = null;
    }
    const token = result?.code === 0 ? String(result.stdout || '').trim() : '';
    if (!token || /\s/.test(token)) {
      cmdTokenFailed = true;
      return null;
    }
    cmdTokenCache = token;
    return token;
  }

  function logFallback(kind, repo) {
    writeFallback(`${new Date(nowFn()).toISOString()} app-token-fallback kind=${kind} repo=${repo} ${FALLBACK_TEXT[kind] || 'App 令牌读失败'}，已改用原令牌重试一次`);
  }

  function getOwnerToken() {
    // 调用方已经从令牌文件读出内容时，只放在内存里，不再读一遍文件。
    if (typeof ownerToken === 'string' && ownerToken) return ownerToken;
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
    const detail = redact(result.stderr || result.stdout || `exit ${result.code}`, [token, ownerTokenCache, appTokenCache, cmdTokenCache]);
    throw new Error(detail);
  }

  /**
   * 跑一条只读的 gh 命令：遇到瞬时故障（见 isTransientGithubFailure）等几秒、当次重试一次，
   * 还失败就把第二次的结果原样交回去，由调用方照旧报错。写请求绝不经过这里。
   */
  async function runRead(args, opts) {
    const first = await runCmd('gh', args, opts);
    if (first.code === 0 || !isTransientGithubFailure(first)) return first;
    await sleepFn(READ_RETRY_DELAY_MS);
    return runCmd('gh', args, opts);
  }

  async function sendGraphql(token, query, variables) {
    const opts = { env: ghEnv(token), input: JSON.stringify({ query, variables }) };
    const args = ['api', 'graphql', '--input', '-'];
    // 只有纯查询才重试；mutation 哪怕走到这里也只发一次。
    return isReadOnlyGraphql(query) ? runRead(args, opts) : runCmd('gh', args, opts);
  }

  function finishGraphql(result, token) {
    if (result.code !== 0) failFrom(result, token);
    const parsed = parseJson(result.stdout, 'GraphQL');
    if (parsed.errors?.length) {
      throw new Error(redact(parsed.errors.map((err) => err.message).join('; '), [token, ownerTokenCache, appTokenCache, cmdTokenCache]));
    }
    return parsed.data ?? parsed;
  }

  async function graphql(query, variables) {
    const appRepo = isReadOnlyGraphql(query) ? appRepoFor(variables) : null;
    if (appRepo) {
      const appToken = await getCommandAppToken();
      if (appToken) {
        const first = await sendGraphql(appToken, query, variables);
        const kind = appFallbackKind(first);
        if (!kind) return finishGraphql(first, appToken);
        // 401：令牌本身坏了，这个实例里不再用它。
        if (kind === 'auth-401') {
          cmdTokenFailed = true;
          cmdTokenCache = undefined;
        }
        logFallback(kind, appRepo);
      } else {
        logFallback('token-failed', appRepo);
      }
      const ownerToken = getOwnerToken();
      return finishGraphql(await sendGraphql(ownerToken, query, variables), ownerToken);
    }
    const token = await getReadToken();
    return finishGraphql(await sendGraphql(token, query, variables), token);
  }

  async function graphqlFetch(token, query, variables) {
    // 优先级写令牌只放在请求头里，不放进进程环境变量。失败信息先抹掉令牌再抛。
    let res;
    try {
      res = await fetchFn('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw new Error('GraphQL 请求失败');
    }
    const raw = typeof res?.text === 'function' ? await res.text() : '';
    if (res && res.ok === false) {
      throw new Error(redact(raw, [token]) || `GraphQL HTTP ${res.status}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('GraphQL 返回的不是 JSON');
    }
    if (parsed.errors?.length) {
      throw new Error(redact(parsed.errors.map((err) => err.message).join('; '), [token]));
    }
    return parsed.data ?? parsed;
  }

  function usesPriorityToken() {
    return typeof ownerToken === 'string' && ownerToken.length > 0;
  }

  /**
   * 用账号令牌的只读查询（doctor 查看板 viewerCanUpdate 用：App 令牌看不到个人账号下的看板，
   * 写看板走的又是账号令牌）。只收 query，mutation 一律拒绝。
   * 优先级写令牌走请求头，不进环境变量。
   */
  async function ownerGraphql(query, variables) {
    if (/^\s*mutation\b/.test(String(query || ''))) throw new Error('ownerGraphql 只做只读查询');
    if (!isReadOnlyGraphql(query)) return graphqlWrite(query, variables);
    if (usesPriorityToken()) return graphqlFetch(ownerToken, query, variables);
    const token = getOwnerToken();
    const result = await runRead(['api', 'graphql', '--input', '-'], {
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
    if (usesPriorityToken()) return graphqlFetch(token, query, variables);
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
    const names = Object.keys(fields);
    for (const name of names) {
      if (!BOARD_FIELDS.has(name) && !PRIO_BOARD_FIELDS.has(name)) {
        throw new Error(`拒绝写入看板字段「${name}」`);
      }
    }
    const usesPrio = names.some((name) => PRIO_BOARD_FIELDS.has(name));
    const usesBoard = names.some((name) => BOARD_FIELDS.has(name));
    if (usesPrio && usesBoard) {
      throw new Error('拒绝写入看板字段：优先级写回不能和验收、裁决一起写');
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
    const clearField = async (fieldId) => {
      await graphqlWrite(
        `mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
          clearProjectV2ItemFieldValue(input: {
            projectId: $projectId, itemId: $itemId, fieldId: $fieldId
          }) { projectV2Item { id } }
        }`,
        { projectId: project.id, itemId: item.id, fieldId },
      );
    };
    if (Object.hasOwn(fields, '优先级')) {
      const field = fieldByName.get('优先级');
      if (!field?.id) throw new Error('看板没有「优先级」字段');
      if (field.dataType !== 'SINGLE_SELECT') throw new Error('「优先级」字段必须是单选');
      const value = fields['优先级'];
      if (value == null || value === '') {
        await clearField(field.id);
      } else {
        const option = (field.options || []).find((entry) => entry.name === value);
        if (!option?.id) throw new Error(`优先级字段没有选项「${value}」`);
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
    }
    if (Object.hasOwn(fields, '关联 PR')) {
      const field = fieldByName.get('关联 PR');
      if (!field?.id) throw new Error('看板没有「关联 PR」字段');
      if (field.dataType === 'SINGLE_SELECT') {
        throw new Error('「关联 PR」字段必须是文本，不能是单选');
      }
      const value = fields['关联 PR'];
      if (value == null || value === '') {
        await clearField(field.id);
      } else {
        await graphqlWrite(
          `mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
            updateProjectV2ItemFieldValue(input: {
              projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
              value: { text: $text }
            }) { projectV2Item { id } }
          }`,
          { projectId: project.id, itemId: item.id, fieldId: field.id, text: String(value) },
        );
      }
    }
    return { itemId: item.id, projectId: project.id };
  }

  async function pushBranch(action) {
    const token = getOwnerToken();
    const { repo, branch, bundlePath, forceWithLease } = action;
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
    // 只有修正分支（acceptance/…）可以带租约强推：租约是上次已知的远端 head（空串 = 远端必须还没有这条分支）。
    // 其它分支、或者租约不是提交 SHA，一律拒绝；不带租约就是普通推送，绝不强推。
    const lease = [];
    if (forceWithLease !== undefined) {
      if (!branch.startsWith('acceptance/')) throw new Error('branch.push 只有 acceptance/ 修正分支能带租约强推');
      if (typeof forceWithLease !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})?$/.test(forceWithLease)) {
        throw new Error('branch.push 的 forceWithLease 必须是提交 SHA 或空串');
      }
      lease.push(`--force-with-lease=refs/heads/${branch}:${forceWithLease}`);
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
        ['--git-dir', tmp, 'push', ...lease, `https://github.com/${repo}.git`, `refs/heads/${branch}:refs/heads/${branch}`],
        { env },
      );
      if (result.code !== 0) failFrom(result, token);
      return { repo, branch };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async function fetchBranch({ repo, branch = 'main', dir, depth = 50 } = {}) {
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) || repo.startsWith('-')) {
      throw new Error(`fetchBranch 的仓名不合法：${repo}`);
    }
    if (typeof branch !== 'string' || !/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(branch) || branch.includes('..')) {
      throw new Error(`fetchBranch 的分支名不合法：${branch}`);
    }
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('fetchBranch 需要绝对路径的 dir');
    // 先查目录再读令牌：目录不是宿主自己的（符号链接、别人的、权限放开、.git 被动过）就不带令牌跑任何 git。
    const gitDir = path.join(dir, '.git');
    assertHostOwnedDir(dir);
    if (!fs.existsSync(gitDir)) {
      const init = await runCmd('git', [...MIRROR_GIT_HARDENING, 'init', '-q', '--bare', gitDir], { env: mirrorBaseEnv() });
      if (init.code !== 0) throw new Error('fetchBranch：建镜像仓失败');
      if (!fs.existsSync(gitDir)) throw new Error('fetchBranch：建镜像仓失败');
      // 配置换成固定内容；以后每次取之前逐字节比对，被改过就拒绝（mirror-tampered）。
      fs.writeFileSync(path.join(gitDir, 'config'), MIRROR_CONFIG, { mode: 0o600 });
    }
    assertMirrorIntact(dir);
    const token = getOwnerToken();
    const env = { ...gitEnv(token), ...MIRROR_ENV };
    // 令牌只在 GIT_CONFIG_* extraheader 里（gitEnv）；URL / argv / 配置里都不带。
    // --git-dir 指定宿主自己的镜像，钩子 / fsmonitor / 代理 / 凭据助手全关，只许 https。
    const result = await runCmd(
      'git',
      [
        ...MIRROR_GIT_HARDENING,
        '--git-dir',
        gitDir,
        'fetch',
        '-q',
        '--no-tags',
        // depth: 0 = 全量历史（修正轮要能打出自带全部对象的 bundle）。
        ...(Number(depth) > 0 ? [`--depth=${Number(depth)}`] : []),
        `https://github.com/${repo}.git`,
        `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      ],
      { env, timeoutMs: FETCH_TIMEOUT_MS },
    );
    if (result.code !== 0) failFrom(result, token);
    // 磁盘上限：镜像超过上限就删掉、报错，不让一个大仓把盘写满。
    if (dirSize(dir) > MIRROR_MAX_BYTES) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new Error('mirror-too-large：镜像超过磁盘上限，已删除');
    }
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
      let reply = null;
      try {
        reply = JSON.parse(last.stdout);
      } catch {
        reply = null;
      }
      const reason = typeof reply?.reason === 'string' ? reply.reason : undefined;
      if (last.code === 4) {
        throw new WriteRejectedError(`外发被拒${reason ? `：${reason}` : ''}`, {
          exitCode: last.code,
          reason,
          files: reply?.files,
        });
      }
      // 1（和别的非 0）是「其他失败」：写闸执行出错、账本坏、连不上写闸……不是拒绝。
      throw new WriteFailedError(`外发失败${reason ? `：${reason}` : `（退出码 ${last.code}）`}`, {
        exitCode: last.code,
        reason,
        detail: typeof reply?.detail === 'string' ? reply.detail : undefined,
      });
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

  return { graphql, ownerGraphql, write, fetchBranch, profile };
}
