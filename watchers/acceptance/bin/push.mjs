#!/usr/bin/env node
// 推送（#46 SC7）：先扫密钥，再打包，最后经写操作出口推分支。本地只跑 git / gitleaks。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WriteRejectedError } from './github.mjs';
import { createRounds, parseRef } from './rounds.mjs';
import { repoTier } from './tasks.mjs';
import { SECRET_PATTERNS } from './redact.mjs';
import { createLocalGit } from './localgit.mjs';

export const BRANCH_PATTERN = /^acceptance\/\d+-\d+-sc\d+$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE_PATTERN = /^[A-Za-z0-9._/@{}~^-]+$/;

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 本轮任务的会话文件：<stateDir>/session/<owner>__<repo>__<号>.json（done、需人工处理都写这里）。 */
export function sessionPath(profile, ref) {
  const { owner, name, number } = parseRef(ref);
  return path.join(profile.stateDir, 'session', `${owner}__${name}__${number}.json`);
}

/** 记一条「需人工处理」。按轮次存：别的轮次的记录不算数。 */
export function writeNeedsHuman(profile, ref, round, entry) {
  const file = sessionPath(profile, ref);
  const existing = readJson(file) || {};
  const sameRound = existing.round === round;
  const entries = sameRound ? [...(existing.needsHuman || [])] : [];
  const duplicate = entries.some(
    (item) => item.reason === entry.reason && JSON.stringify(item.files || []) === JSON.stringify(entry.files || []),
  );
  if (!duplicate) entries.push(entry);
  const data = { ...(sameRound ? existing : {}), round, needsHuman: entries };
  atomicWrite(file, JSON.stringify(data, null, 2));
  return file;
}

export function readNeedsHuman(profile, ref, round) {
  const data = readJson(sessionPath(profile, ref));
  if (!data || data.round !== round) return [];
  return Array.isArray(data.needsHuman) ? data.needsHuman : [];
}

/** 扫补丁里的新增行：命中就只回文件名，绝不回内容。 */
function scanDiff(diff) {
  const files = new Set();
  let current = null;
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).trim();
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      continue;
    }
    if (line.startsWith('--- ') || !current) continue;
    if (!line.startsWith('+')) continue;
    const added = line.slice(1);
    for (const { re } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(added)) {
        files.add(current);
        break;
      }
    }
  }
  return [...files];
}

function readGitleaksReport(file) {
  const raw = readJson(file);
  const findings = Array.isArray(raw) ? raw : [];
  const files = new Set();
  for (const finding of findings) {
    const name = finding?.File || finding?.file;
    if (typeof name === 'string' && name) files.add(name);
  }
  return [...files];
}

/**
 * 推送前扫描：有 gitleaks 就用 gitleaks，没有就用内置规则（只看新增行）。
 * 返回 {found, files, tool}，不含任何密钥内容。
 */
export async function scanForSecrets({ git, worktree, base, commit }) {
  if (typeof commit !== 'string' || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw new Error('扫密钥需要要推的分支的提交 sha');
  }
  if (await git.has('gitleaks')) {
    const reportPath = path.join(os.tmpdir(), `acceptance-gitleaks-${process.pid}-${Date.now()}.json`);
    try {
      const result = await git.gitleaks({ range: `${base}..${commit}`, reportPath, cwd: worktree });
      const files = readGitleaksReport(reportPath);
      // gitleaks：0 = 没扫到，1 = 扫到；别的退出码是扫描本身失败，不能当成「干净」放行。
      if (result?.code === 0 && files.length === 0) return { found: false, files, tool: 'gitleaks' };
      if (result?.code === 1 || files.length > 0) {
        return { found: true, files: files.length ? files : ['（gitleaks 没给出文件名）'], tool: 'gitleaks' };
      }
      throw new Error(`gitleaks 扫描失败（退出码 ${result?.code}），没推`);
    } finally {
      fs.rmSync(reportPath, { force: true });
    }
  }
  const diff = await git.diff({ base, commit, cwd: worktree });
  if (diff.code !== 0) {
    throw new Error(`扫密钥前 diff 失败：${String(diff.stderr || diff.stdout || '').trim() || diff.code}`);
  }
  const files = scanDiff(diff.stdout);
  return { found: files.length > 0, files, tool: 'builtin' };
}

function requireFlag(flags, name, label) {
  const value = flags.get(name);
  if (typeof value !== 'string' || !value) throw new Error(`push 需要 --${name} <${label}>`);
  return value;
}

export async function runPush({ github, profile, ref, n, flags, now = () => Date.now(), stdout, git: injected }) {
  const rounds = createRounds({ github, profile, now });
  await rounds.check(ref, n);
  const rootRepo = parseRef(ref).repo;
  const ranked = repoTier(rootRepo, profile);
  if (ranked?.tier === 'watch') throw new Error('watch 档只出裁决、写看板');
  if (!ranked) throw new Error(`${rootRepo} 不在任何名单里`);
  const git = injected || createLocalGit();
  const repo = requireFlag(flags, 'repo', 'owner/repo');
  if (!REPO_PATTERN.test(repo)) throw new Error(`--repo 不合法：${repo}`);
  const branch = requireFlag(flags, 'branch', 'acceptance/<总>-<出处>-sc<k>');
  if (!BRANCH_PATTERN.test(branch)) throw new Error(`--branch 不合法：${branch}`);
  const worktree = requireFlag(flags, 'worktree', '检出目录');
  const base = flags.get('base') || 'origin/main';
  if (typeof base !== 'string' || !BASE_PATTERN.test(base)) throw new Error(`--base 不合法：${base}`);

  // 扫的、打包的、去重键用的，都是同一个提交：--branch 解析出的 sha，不是当前检出的 HEAD。
  const resolved = await git.branchSha({ branch, cwd: worktree });
  const branchSha = String(resolved?.stdout || '').trim();
  if (resolved?.code !== 0 || !/^[0-9a-f]{40,64}$/.test(branchSha)) {
    throw new Error(`本地没有分支 ${branch}，没推`);
  }

  const scan = await scanForSecrets({ git, worktree, base, commit: branchSha });
  if (scan.found) {
    writeNeedsHuman(profile, ref, n, { reason: 'secret-found', files: scan.files });
    stdout.write(`扫到疑似密钥，没推：${scan.files.join(', ')}\n`);
    return 5;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-bundle-'));
  const bundlePath = path.join(tmp, 'push.bundle');
  try {
    const bundled = await git.createBundle({ branch, file: bundlePath, cwd: worktree });
    if (bundled.code !== 0 || !fs.existsSync(bundlePath)) {
      throw new Error(`打包失败：${String(bundled.stderr || '').trim() || bundled.code}`);
    }
    // 扫描和打包之间分支可能被挪：打包的提交必须就是扫过的那个，否则不推。
    const heads = await git.bundleHeads({ file: bundlePath, cwd: worktree });
    const packed = String(heads?.stdout || '')
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .find(([, refName]) => refName === `refs/heads/${branch}`)?.[0];
    if (heads?.code !== 0 || packed !== branchSha) {
      throw new Error(`打包的提交和扫过的提交不一致（分支 ${branch} 被改动），没推`);
    }
    try {
      await github.write({
        type: 'branch.push',
        repo,
        branch,
        bundlePath,
        dedupeKey: `push:${repo}:${branch}:${branchSha}`,
      });
    } catch (error) {
      if (error instanceof WriteRejectedError && error.reason === 'secret-found') {
        // 写闸在沙箱外又扫了一遍：按 SC7 记「需人工处理」，这一轮不标中断。
        writeNeedsHuman(profile, ref, n, { reason: 'secret-found', files: [] });
      }
      throw error;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  stdout.write(`${JSON.stringify({ repo, branch, bundle: '已交给写闸', head: branchSha })}\n`);
  return 0;
}
