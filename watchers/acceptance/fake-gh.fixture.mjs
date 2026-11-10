import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The acceptance host is Linux-only: the loop and deploy-ff hold flock, activity reads /proc. On a machine without
// them (macOS) the tests that need them are skipped with this reason instead of failing; CI asserts both are present.
export const FLOCK_SKIP = spawnSync('flock', ['--version'], { stdio: 'ignore' }).error?.code === 'ENOENT'
  ? 'flock 不可用（验收机宿主只在 Linux 上跑，见 docs/acceptance-operations.md）' : false;
export const PROCFS_SKIP = fs.existsSync('/proc/self/stat') ? false : '/proc 不可用（验收机宿主只在 Linux 上跑）';

export const OWNER = 'ExampleUser';
export const REPO = 'example-owner/example-repo';
export const OTHER_REPO = 'example-owner/other-repo';
export const HANDOFF_REPO = 'example-org/handoff-repo';
export const START_AT = '2026-01-01T00:00:00.000Z';

/**
 * 测试用的临时目录：建在 os.tmpdir() 下，进程退出时统一删掉（#70 复审：以前每跑一次全量测试在 /tmp 留下
 * 七百多个目录，把盒子的 inode 用满了）。node --test 每个文件一个子进程，所以每个文件跑完就清干净。
 * 有的测试会把目录改成 000 / 只读，删之前先把权限放开。
 */
const createdTmpDirs = new Set();
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // 权限被测试改过：放开再删。
  }
  const walk = (target) => {
    let stat;
    try {
      stat = fs.lstatSync(target);
    } catch {
      return;
    }
    if (!stat.isDirectory()) return;
    try {
      fs.chmodSync(target, 0o700);
    } catch {
      // 不是我们的就算了。
    }
    let names = [];
    try {
      names = fs.readdirSync(target);
    } catch {
      return;
    }
    for (const name of names) walk(path.join(target, name));
  };
  walk(dir);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 实在删不掉就留着，不让测试进程因为清理失败而报错。
  }
}
export function cleanupTmpDirs() {
  for (const dir of createdTmpDirs) removeTree(dir);
  createdTmpDirs.clear();
}
process.on('exit', cleanupTmpDirs);

/**
 * 临时目录的父目录：测试会在下面建 unix socket（写闸、出网代理），路径上限 107 字节。TMPDIR 很长时
 * （比如验收轮的 pi 在自己的沙箱里直接 `node --test`，TMPDIR 在轮次目录下）改用 /tmp，免得 socket 路径超长。
 */
export function tmpBase() {
  const base = os.tmpdir();
  if (base.length <= 30) return base;
  try {
    fs.accessSync('/tmp', fs.constants.W_OK);
    return '/tmp';
  } catch {
    return base;
  }
}

export function tmpDir(prefix = 'acceptance-test-') {
  const dir = fs.mkdtempSync(path.join(tmpBase(), prefix));
  createdTmpDirs.add(dir);
  return dir;
}

export function writeSecret(file, content = 'test-token-not-real') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * 测试专用的合成进程表（#370）：写一个只输出给定行、**不转调真实 ps** 的 `ps` 可执行文件，返回它所在目录。
 * 只把它拼进测试子进程的 PATH；调用方进程自己的 PATH 不变，宿主 ps 也不受影响。
 */
export function syntheticPsDir({ lines = [], prefix = 'synthetic-ps-' } = {}) {
  const dir = tmpDir(prefix);
  const quote = (line) => `'${String(line).replace(/'/g, `'\\''`)}'`;
  const body = [
    '#!/bin/sh',
    '# 合成进程表（#370）：只输出固定内容，不调用真实 ps。',
    ...lines.map((line) => `printf '%s\\n' ${quote(line)}`),
  ].join('\n');
  const bin = path.join(dir, 'ps');
  fs.writeFileSync(bin, `${body}\n`, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return dir;
}

/** 把合成进程表目录拼到 env 的 PATH 最前面（只给测试子进程用，不外溢）。 */
export function withSyntheticPath(dir, env = process.env) {
  return { ...env, PATH: `${dir}${path.delimiter}${env.PATH ?? ''}` };
}

export function writeProfile(home, extra = {}) {
  const stateDir = path.join(home, 'state');
  const worktreeDir = path.join(home, 'worktrees');
  const tokenFile = path.join(home, 'secrets', 'github.token');
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(worktreeDir, { recursive: true });
  writeSecret(tokenFile, extra.tokenContent ?? 'owner-token');
  const profile = {
    ownerLogin: OWNER,
    projectNumber: 7,
    stateDir,
    worktreeDir,
    startAt: START_AT,
    githubTokenFile: tokenFile,
    autoRepos: [`${OWNER}/*`, REPO],
    forkRepos: ['makecindy/cindy'],
    watchRepos: [HANDOFF_REPO],
    stallMinutes: 30,
    ...extra.profile,
  };
  if (extra.skipToken) delete profile.githubTokenFile;
  fs.writeFileSync(path.join(home, 'config', 'profile.json'), JSON.stringify(profile, null, 2));
  return { home, stateDir, worktreeDir, tokenFile, profile };
}

export function roundComment({
  round = 1,
  status = '验收中',
  bodyVersion = 'sha256:abc',
  startedAt = '2026-10-24T01:00:00.000Z',
  finishedAt,
  reason,
  detail,
  createdAt = startedAt,
  updatedAt = finishedAt || startedAt,
  databaseId = 1000 + round,
  id = `IC_R${round}`,
  url = `https://github.com/${REPO}/issues/1#issuecomment-${1000 + round}`,
  author = OWNER,
} = {}) {
  const lines = [`[验收机] 第 ${round} 轮：${status}`, `正文版本：${bodyVersion}`, `开始：${startedAt}`];
  if (finishedAt) lines.push(`完成：${finishedAt}`);
  if (status === '中断' && reason) lines.push(`原因：${reason}`);
  if (detail) {
    lines.push('');
    lines.push(detail);
  }
  return {
    id,
    databaseId,
    body: lines.join('\n'),
    createdAt,
    updatedAt,
    url,
    author: { login: author },
  };
}

export function issueNode({
  repo = REPO,
  number = 1,
  title = 'parent task',
  body = 'hello',
  state = 'OPEN',
  author = OWNER,
  createdAt = '2026-02-01T00:00:00.000Z',
  closedAt = null,
  updatedAt = createdAt,
  parent = null,
  subIssues = [],
  prs = [],
  comments = [],
  defaultBranch = 'main',
  id,
} = {}) {
  return {
    id: id || `I_${repo.replace('/', '_')}_${number}`,
    number,
    title,
    body,
    state,
    url: `https://github.com/${repo}/issues/${number}`,
    createdAt,
    closedAt,
    updatedAt,
    author: { login: author },
    repository: { nameWithOwner: repo, defaultBranchRef: defaultBranch ? { name: defaultBranch } : null },
    parent,
    subIssues: { nodes: subIssues },
    closedByPullRequestsReferences: { nodes: prs },
    comments: { nodes: comments },
  };
}

export function childNode({
  repo = REPO,
  number = 2,
  title = 'child',
  state = 'CLOSED',
  author = OWNER,
  closedAt = '2026-10-20T00:00:00.000Z',
  url,
} = {}) {
  return {
    number,
    title,
    state,
    url: url || `https://github.com/${repo}/issues/${number}`,
    closedAt,
    author: { login: author },
    repository: { nameWithOwner: repo },
  };
}

export function pageInfo(hasNextPage = false, endCursor = null) {
  return { hasNextPage, endCursor };
}

export function inventoryData({ open = [], closed = [], openPage, closedPage } = {}) {
  return {
    user: {
      open: { nodes: open, pageInfo: openPage || pageInfo() },
      closed: { nodes: closed, pageInfo: closedPage || pageInfo() },
    },
  };
}

export function parseGraphqlInput(input) {
  try {
    return JSON.parse(input || '{}');
  } catch {
    return {};
  }
}

export function isGraphql(cmd, args) {
  return cmd === 'gh' && args.includes('graphql');
}

export function isApi(cmd, args) {
  return cmd === 'gh' && args[0] === 'api' && !args.includes('graphql');
}

export function createFakeRun({ onGraphql, onApi, onGit, onWriteCommand, onOther } = {}) {
  const calls = [];
  async function run(cmd, args, { env = {}, input } = {}) {
    const rec = { cmd, args, env, input, ghToken: env.GH_TOKEN };
    calls.push(rec);
    if (onWriteCommand && cmd !== 'gh' && cmd !== 'git') {
      return onWriteCommand(cmd, args, { env, input, rec });
    }
    if (isGraphql(cmd, args)) {
      const payload = parseGraphqlInput(input);
      if (!onGraphql) return { code: 1, stdout: '', stderr: 'no graphql handler' };
      const result = await onGraphql(payload, { env, rec });
      if (result && Object.hasOwn(result, 'code')) return result;
      return { code: 0, stdout: JSON.stringify({ data: result }), stderr: '' };
    }
    if (isApi(cmd, args) || (cmd === 'gh' && args[0] === 'pr')) {
      if (!onApi) return { code: 1, stdout: '', stderr: 'no api handler' };
      const result = await onApi(args, { env, input, rec });
      if (result && Object.hasOwn(result, 'code')) return result;
      return { code: 0, stdout: JSON.stringify(result ?? {}), stderr: '' };
    }
    if (cmd === 'git') {
      if (!onGit) return { code: 0, stdout: '', stderr: '' };
      const result = await onGit(args, { env, rec });
      if (result && Object.hasOwn(result, 'code')) return result;
      return { code: 0, stdout: JSON.stringify(result ?? {}), stderr: '' };
    }
    if (onOther) return onOther(cmd, args, { env, input, rec });
    return { code: 1, stdout: '', stderr: `unexpected ${cmd} ${args.join(' ')}` };
  }
  run.calls = calls;
  return run;
}

export function sha256Body(body) {
  const text = body == null ? '' : String(body);
  const normalized = text
    .split('\n')
    .map((line) => line.replace(/[ \t\r]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
  return `sha256:${crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export function clock(iso) {
  let current = Date.parse(iso);
  return {
    now: () => current,
    set: (next) => {
      current = typeof next === 'number' ? next : Date.parse(next);
    },
    advance: (ms) => {
      current += ms;
    },
  };
}
