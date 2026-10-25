import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OWNER = 'ExampleUser';
export const REPO = 'example-owner/example-repo';
export const OTHER_REPO = 'example-owner/other-repo';
export const HANDOFF_REPO = 'example-org/handoff-repo';
export const START_AT = '2026-01-01T00:00:00.000Z';

export function tmpDir(prefix = 'acceptance-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeSecret(file, content = 'test-token-not-real') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
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
    repository: { nameWithOwner: repo },
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
