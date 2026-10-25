// #47 SC11 宿主轮次的真实路径夹具：一个按文件存状态的假 gh（放在 PATH 最前面），
// 让 host/round.mjs 用默认的 runRound（bin/round.mjs → github.mjs → 写闸 exec 子进程）
// 和默认的 startGate（真的 write-gate.mjs serve 子进程）跑完整一轮；git fetch 换成本地上游仓。
// 夹具数据一律占位符，不触网。
import fs from 'node:fs';
import path from 'node:path';
import { spawnRun } from './bin/localgit.mjs';
import { hostPaths } from './host/paths.mjs';
import { run as procRun } from './host/proc.mjs';
import { OTHER_REPO, OWNER, REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

export const ROOT_REF = `${REPO}#1`;
export const CHILD_REF = `${OTHER_REPO}#2`;

const GH_SOURCE = String.raw`#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const stateFile = fs.readFileSync(path.join(path.dirname(process.argv[1]), 'state-path'), 'utf8').trim();
const lockDir = stateFile + '.lock';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withState(fn) {
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await sleep(2);
    }
  }
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const result = fn(state);
    fs.writeFileSync(stateFile, JSON.stringify(state));
    return result;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
function shallow(state, ref) {
  const issue = state.issues[ref];
  return {
    id: 'I_' + ref,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    url: 'https://example.invalid/' + issue.repo + '/issues/' + issue.number,
    createdAt: '2026-02-01T00:00:00.000Z',
    closedAt: issue.closedAt || null,
    updatedAt: '2026-02-01T00:00:00.000Z',
    author: { login: state.owner },
    repository: { nameWithOwner: issue.repo },
    closedByPullRequestsReferences: { nodes: issue.prs },
    comments: { nodes: issue.comments },
  };
}
function full(state, ref) {
  const issue = state.issues[ref];
  const parent = issue.parent ? state.issues[issue.parent] : null;
  return {
    ...shallow(state, ref),
    parent: parent ? { number: parent.number, repository: { nameWithOwner: parent.repo }, author: { login: state.owner } } : null,
    subIssues: { nodes: (issue.subIssues || []).map((child) => shallow(state, child)) },
  };
}
if (args.includes('graphql')) {
  const payload = JSON.parse(input || '{}');
  const query = String(payload.query || '');
  const v = payload.variables || {};
  const out = await withState((state) => {
    state.graphqlCalls = (state.graphqlCalls || 0) + 1;
    if (query.includes('user(login')) {
      const roots = Object.keys(state.issues).filter((ref) => !state.issues[ref].parent);
      return { data: { user: {
        open: { nodes: roots.map((ref) => full(state, ref)), pageInfo: { hasNextPage: false, endCursor: null } },
        closed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
      } } };
    }
    if (query.includes('search(')) return { data: { search: { nodes: [] } } };
    if (query.includes('repository(owner')) {
      const ref = v.owner + '/' + v.name + '#' + v.number;
      return { data: { repository: { issue: state.issues[ref] ? full(state, ref) : null } } };
    }
    return { data: {} };
  });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
if (args[0] === 'api') {
  const method = args.includes('POST') ? 'POST' : args.includes('PATCH') ? 'PATCH' : 'GET';
  const apiPath = args.find((a) => a.startsWith('repos/')) || '';
  const body = JSON.parse(input || '{}');
  const created = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(apiPath);
  if (method === 'POST' && created) {
    const out = await withState((state) => {
      const issue = state.issues[created[1] + '#' + created[2]];
      const id = state.nextId++;
      const stamp = new Date().toISOString();
      issue.comments.push({ id: 'IC_' + id, databaseId: id, body: body.body, createdAt: stamp, updatedAt: stamp,
        url: 'https://example.invalid/c/' + id, author: { login: state.owner } });
      return { id, html_url: 'https://example.invalid/c/' + id };
    });
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
  const updated = /^repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(apiPath);
  if (method === 'PATCH' && updated) {
    const id = Number(updated[1]);
    const out = await withState((state) => {
      for (const issue of Object.values(state.issues)) {
        const found = issue.comments.find((comment) => comment.databaseId === id);
        if (found) {
          found.body = body.body;
          found.updatedAt = new Date().toISOString();
        }
      }
      return { id, html_url: 'https://example.invalid/c/' + id };
    });
    process.stdout.write(JSON.stringify(out));
    process.exit(0);
  }
}
process.stderr.write('unexpected gh call: ' + args.join(' '));
process.exit(2);
`;

let ghBinDir = null;

/** 假 gh 放进本测试进程的 PATH 最前面（宿主进程、写闸 exec/serve 子进程都用 process.env.PATH 找 gh）。 */
export function installFakeGh() {
  if (ghBinDir) return ghBinDir;
  ghBinDir = path.join(tmpDir('round-world-bin-'), 'bin');
  fs.mkdirSync(ghBinDir, { recursive: true });
  const gh = path.join(ghBinDir, 'gh');
  fs.writeFileSync(gh, GH_SOURCE.replace('#!/usr/bin/env node', `#!${process.execPath}`));
  fs.chmodSync(gh, 0o700);
  process.env.PATH = `${ghBinDir}${path.delimiter}${process.env.PATH}`;
  return ghBinDir;
}

async function git(args, cwd) {
  const result = await spawnRun('git', args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'x', GIT_AUTHOR_EMAIL: 'x@example.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@example.invalid' },
  });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}：${result.stderr}`);
  return result.stdout.trim();
}

/** 本地上游仓（代替 https://github.com/<repo>.git）：main 上一个提交，带一个能读的文件。 */
async function makeUpstream(repo) {
  const dir = tmpDir('round-world-up-');
  await git(['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'README.md'), `code of ${repo}\n`);
  await git(['add', 'README.md'], dir);
  await git(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

/**
 * 一个完整的宿主世界：watcher home（profile、host.json、写闸开关）、假 gh 的状态（总 issue + 跨仓子 issue，
 * 子 issue 已关、关联 PR 已合并，所以该开第 1 轮），两个本地上游仓。
 */
export async function createRoundWorld({ piScript, enabled = true, hostJson = {}, profile = {} } = {}) {
  installFakeGh();
  const base = writeProfile(tmpDir(), {
    profile: {
      stateDir: path.join(tmpDir(), 'acc-state'),
      worktreeDir: path.join(tmpDir(), 'acc-worktree'),
      autoRepos: [`${OWNER}/*`, 'example-owner/*'],
      ...profile,
    },
  });
  const home = base.home;
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  if (enabled) fs.writeFileSync(paths.enabledFile, '1');
  fs.writeFileSync(
    paths.hostConfig,
    JSON.stringify({ piCommand: [process.execPath, '-e', piScript || 'process.exit(0)'], ...hostJson }, null, 2),
  );
  const stateFile = path.join(home, 'gh-state.json');
  const state = {
    owner: OWNER,
    nextId: 5000,
    issues: {
      [ROOT_REF]: { repo: REPO, number: 1, title: '总任务', body: '- [ ] SC1 看一眼 验证：unit', state: 'OPEN', comments: [], subIssues: [CHILD_REF], prs: [], parent: null },
      [CHILD_REF]: {
        repo: OTHER_REPO,
        number: 2,
        title: '子任务',
        body: '- [ ] SC2 跨仓 验证：unit',
        state: 'CLOSED',
        closedAt: '2026-10-20T00:00:00.000Z',
        comments: [],
        subIssues: [],
        prs: [{ number: 3, url: 'https://example.invalid/pr/3', mergedAt: '2026-10-20T00:00:00.000Z', repository: { nameWithOwner: OTHER_REPO } }],
        parent: ROOT_REF,
      },
    },
  };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(path.join(ghBinDir, 'state-path'), stateFile);
  const upstream = { [REPO]: await makeUpstream(REPO), [OTHER_REPO]: await makeUpstream(OTHER_REPO) };

  // 真的 run：只把 https://github.com/<repo>.git 换成本地上游仓（测试才放开 file 协议），别的原样跑。
  const run = async (cmd, args, options = {}) => {
    if (cmd === 'git') {
      const url = args.find((arg) => /^https:\/\/github\.com\/.+\.git$/.test(arg));
      if (url) {
        const repo = url.slice('https://github.com/'.length, -'.git'.length);
        const local = upstream[repo];
        if (!local) return { code: 128, stdout: '', stderr: `fatal: repository not found: ${repo}` };
        const rewritten = args.map((arg) => (arg === url ? local : arg));
        return procRun(cmd, ['-c', 'protocol.file.allow=always', ...rewritten], options);
      }
    }
    return procRun(cmd, args, options);
  };

  return {
    home,
    paths,
    profile: base.profile,
    stateFile,
    upstream,
    run,
    readState: () => JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    /** 改轮次评论首行（模拟 pi 写了裁决）。 */
    setRoundStatus(ref, round, status) {
      const current = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const comment = current.issues[ref].comments.find((entry) => entry.body.startsWith(`[验收机] 第 ${round} 轮`));
      comment.body = comment.body.replace(/^\[验收机\] 第 (\d+) 轮：\S+/, `[验收机] 第 $1 轮：${status}`);
      comment.updatedAt = new Date().toISOString();
      fs.writeFileSync(stateFile, JSON.stringify(current));
    },
  };
}

/** 轮次评论（只看 ownerLogin 发的、首行是轮次的）。 */
export function roundComments(world, ref = ROOT_REF) {
  return world.readState().issues[ref].comments.filter((entry) => entry.body.startsWith('[验收机] 第'));
}

export function writeMeminfo() {
  const file = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(file, 'MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n');
  return file;
}
