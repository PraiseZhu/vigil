// 验收轮的代码预取（#47 SC11）：认领之后、起 pi 之前，宿主替这一轮把任务树里每个仓的 main 检出好。
// 沙箱里没有凭证（私有 / internal 仓 clone 不下来），所以带令牌的 fetch 只在宿主自己的镜像里跑：
// 复用修正轮（prbot）的镜像目录检查（ensureMirrorDir）和 github.fetchBranch（令牌只在 extraheader 里、
// 钩子/代理/凭据助手全关、只许 https、超时和磁盘上限）。检出的工作树放在本轮的 roundDir/code/ 下，
// 由 host/round.mjs 以只读方式挂进沙箱。
import fs from 'node:fs';
import path from 'node:path';
import { collectTree } from '../bin/collect.mjs';
import { localEnv } from '../bin/localgit.mjs';
import { parseRef } from '../bin/rounds.mjs';
import { repoTier } from '../bin/tasks.mjs';
import { HOST_GIT_HARDENING, ensureMirrorDir } from './prbot.mjs';
import { acquireLock, hostPaths, releaseLock } from './paths.mjs';

/** 一轮最多预取几个仓（任务树再大也不无限取）。 */
export const MAX_PREFETCH_REPOS = 8;
/** 等同一个镜像的另一轮取完最多等多久（取一次的超时是 10 分钟）。 */
export const MIRROR_LOCK_WAIT_MS = 15 * 60 * 1000;

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** 本轮任务树涉及的仓：总 issue、子 issue / 修正 issue、关联 PR 所在的仓；只留分档名单里的仓。 */
export function treeRepos(tree, profile) {
  const out = [];
  const add = (ref) => {
    let repo;
    try {
      repo = parseRef(ref).repo;
    } catch {
      return;
    }
    if (!REPO_PATTERN.test(repo) || repo.startsWith('-')) return;
    if (!repoTier(repo, profile)) return;
    if (!out.some((item) => item.toLowerCase() === repo.toLowerCase())) out.push(repo);
  };
  add(tree?.root?.ref);
  for (const issue of tree?.issues || []) {
    add(issue.ref);
    for (const pr of issue.prs || []) add(pr.ref);
  }
  for (const correction of tree?.corrections || []) add(correction.ref);
  return out;
}

function mirrorName(repo) {
  const [owner, name] = repo.split('/');
  return `acceptance__${owner}__${name}`;
}

function gitEnv(base) {
  // 本地 git：没有令牌（localEnv 剥掉），不读系统 / 全局配置。
  return { ...localEnv(base), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
}

async function git(run, args, env) {
  const result = await run('git', [...HOST_GIT_HARDENING, ...args], { env, timeoutMs: 10 * 60 * 1000 });
  if (!result || result.code !== 0) {
    const detail = String(result?.stderr || result?.stdout || `exit ${result?.code}`).trim().split('\n')[0];
    throw new Error(`git ${args.find((arg) => !arg.startsWith('-')) || ''} 失败：${detail}`);
  }
  return result;
}

/**
 * 从宿主镜像检出 main 到一个全新的目录（宿主自己新建，沙箱还没起来，没有任何东西能预埋进去）。
 * 工作树带 .git（pi 要看 git log），只有 refs/remotes/origin/main 和本地 main 两个引用。
 */
async function checkoutFromMirror({ run, mirror, target, env }) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  await git(run, ['init', '-q', '--template=', target], env);
  await git(
    run,
    [
      '-c',
      'protocol.file.allow=always',
      '-C',
      target,
      'fetch',
      '-q',
      '--no-tags',
      path.join(mirror, '.git'),
      '+refs/remotes/origin/main:refs/remotes/origin/main',
    ],
    env,
  );
  await git(run, ['-C', target, 'checkout', '-q', '-B', 'main', 'refs/remotes/origin/main'], env);
  const head = await git(run, ['-C', target, 'rev-parse', 'HEAD'], env);
  return String(head.stdout || '').trim();
}

/**
 * 预取本轮代码。返回 [{repo, path, head}]，path 是 roundDir/code/<owner>__<repo> 的绝对路径。
 * 任何一个仓取不下来就抛错（调用方 abort 这一轮并写提醒），不留半截的检出。
 * `touch` 每取完一个仓调一次（宿主刷新本轮进度，取大仓不会被误判卡死）。
 */
export async function prefetchCode({
  home,
  profile,
  github,
  run,
  issue,
  roundDir,
  env = process.env,
  now = () => Date.now(),
  touch = () => {},
  lockWaitMs = MIRROR_LOCK_WAIT_MS,
  sleep,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('prefetchCode 需要绝对路径的 home');
  if (typeof roundDir !== 'string' || !path.isAbsolute(roundDir)) throw new Error('prefetchCode 需要绝对路径的 roundDir');
  if (typeof github?.fetchBranch !== 'function') throw new Error('github 没有 fetchBranch');
  const tree = await collectTree({ github, profile, ref: issue });
  const repos = treeRepos(tree, profile).slice(0, MAX_PREFETCH_REPOS);
  const paths = hostPaths(home);
  const codeRoot = path.join(roundDir, 'code');
  const out = [];
  const localGitEnv = gitEnv(env);
  try {
    for (const repo of repos) {
      const name = mirrorName(repo);
      const mirror = ensureMirrorDir({ home, profile, worktree: name });
      const lockFile = path.join(paths.locksDir, `mirror-${name}.lock`);
      const locked = await acquireLock(lockFile, { now, waitMs: lockWaitMs, sleep, pollMs: 1000 });
      if (!locked) throw new Error(`${repo}：镜像被另一轮占着，等不到`);
      try {
        // depth 0：全量历史，验收要能看合并进来的提交；镜像常驻，之后每轮只是增量取。
        await github.fetchBranch({ repo, branch: 'main', dir: mirror, depth: 0 });
        touch();
        const target = path.join(codeRoot, repo.replace('/', '__'));
        const head = await checkoutFromMirror({ run, mirror, target, env: localGitEnv });
        out.push({ repo, path: target, head });
        touch();
      } catch (error) {
        throw new Error(`${repo}：${error?.message || error}`);
      } finally {
        releaseLock(lockFile);
      }
    }
  } catch (error) {
    fs.rmSync(codeRoot, { recursive: true, force: true });
    throw error;
  }
  return out;
}
