#!/usr/bin/env node
// 写闸（#47 SC9 / SC13）：所有写动作都在沙箱外再查一遍，以这里为准。
// 正文版本直接用 bin/rounds.mjs 的 bodyVersion（和 tasks、rounds 同一个函数），这里不另写哈希。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile, watcherHome } from '../bin/profile.mjs';
import { createGithub, WRITE_TYPES } from '../bin/github.mjs';
import { bodyVersion, latestRound, parseRef, parseRounds } from '../bin/rounds.mjs';
import {
  ISSUE_BODY_QUERY,
  ROOT_QUERY,
  SEARCH_QUERY,
  collectTree,
  parseMarker,
} from '../bin/collect.mjs';
import { COMMENTS_QUERY } from '../bin/helper.mjs';
import { ISSUE_COMMENTS_QUERY as ROUND_COMMENTS_QUERY } from '../bin/round.mjs';
import { ISSUE_COMMENTS_QUERY as ROUNDS_COMMENTS_QUERY } from '../bin/rounds.mjs';
import { repoTier } from '../bin/tasks.mjs';
import { redact } from '../bin/redact.mjs';
import { scanIntroducedObjects } from '../bin/secretscan.mjs';
import { acquireLock, appendAlert, hostPaths, releaseLock } from './paths.mjs';
import { run as procRun } from './proc.mjs';

/** 执行锁最多等 30 秒；等不到回 75（忙），什么都不执行。 */
export const GATE_LOCK_WAIT_MS = 30000;

const NOT_IMPLEMENTED_TYPES = new Set(['pr.update-branch', 'ci.rerun']);
const ALLOWED_TYPES = new Set([...WRITE_TYPES, 'read.graphql', 'probe']);
const WATCH_ALLOWED_TYPES = new Set(['comment.create', 'comment.update', 'project.field.set', 'read.graphql']);
/** 只认这几个登记过的只读查询，绝不执行调用方自己写的 GraphQL 文本。 */
const READ_QUERIES = new Set([
  ROOT_QUERY,
  SEARCH_QUERY,
  ISSUE_BODY_QUERY,
  COMMENTS_QUERY,
  ROUND_COMMENTS_QUERY,
  ROUNDS_COMMENTS_QUERY,
]);

const ACCEPTANCE_FIRST_LINE = /^\[验收机\] 第 (\d+) 轮：验收中$/;
const VERDICT_FIRST_LINE = /^\[验收机\] 第 (\d+) 轮：(通过|要修)/;
const ABORT_FIRST_LINE = /^\[验收机\] 第 (\d+) 轮：中断/;
const ROUND_FIRST_LINE = /^\s*\[验收机\]\s*第/;
const CHECKBOX_LINE = /^(\s*[-*]\s+\[)[ xX](\].*)$/;
const BRANCH_PATTERN = /^acceptance\/(\d+)-(\d+)-sc(\d+)$/;
const GREEN_CHECKS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** pr.ready 由写闸自己查检查状态：一条固定查询，不是调用方交来的 query。 */
export const STATUS_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      headRefName
      isCrossRepository
      body
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup { state }
          }
        }
      }
    }
  }
}`;

/**
 * branch.push 扫密钥的基准：写闸自己去 GitHub 读目标仓默认分支的头提交，绝不用沙箱交来的 base。
 * 一条固定查询，不是调用方交来的 query。
 */
export const DEFAULT_HEAD_QUERY = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      name
      target { oid }
    }
  }
}`;

const COMMIT_OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const reject = (reason, detail) =>
  detail === undefined ? { code: 4, body: { reason } } : { code: 4, body: { reason, detail } };

const fail = (reason, detail) =>
  detail === undefined ? { code: 1, body: { reason } } : { code: 1, body: { reason, detail } };

function firstLine(text) {
  return String(text ?? '').split('\n')[0] || '';
}

function versionLine(body) {
  const line = String(body ?? '')
    .split('\n')
    .find((entry) => entry.startsWith('正文版本：'));
  return line ? line.slice('正文版本：'.length).trim() : null;
}

/** 新正文和旧正文逐行比：只有复选框里的空格 / x 可以不同，行数和其它字一个都不能变。 */
function onlyCheckboxToggles(before, after) {
  if (typeof after !== 'string') return false;
  const oldLines = String(before ?? '').split('\n');
  const newLines = after.split('\n');
  if (oldLines.length !== newLines.length) return false;
  for (let i = 0; i < oldLines.length; i += 1) {
    if (oldLines[i] === newLines[i]) continue;
    const a = CHECKBOX_LINE.exec(oldLines[i]);
    const b = CHECKBOX_LINE.exec(newLines[i]);
    if (!a || !b || a[1] !== b[1] || a[2] !== b[2]) return false;
  }
  return true;
}

function refOf(repo, issue) {
  return `${repo}#${Number(issue)}`;
}

function readGitleaksFiles(reportFile) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch {
    return [];
  }
  const files = new Set();
  for (const finding of Array.isArray(raw) ? raw : []) {
    const name = finding?.File || finding?.file;
    if (typeof name === 'string' && name) files.add(name);
  }
  return [...files];
}

/** 扫 bundle 用的 git 环境：不带任何令牌/口令，只保留本地跑 git 需要的几个变量。 */
function scanEnv(base = process.env) {
  const env = { NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'TZ']) {
    if (base?.[key] !== undefined) env[key] = base[key];
  }
  return env;
}

/**
 * 写闸本体。`github` 必须是 createGithub({profile: {...profile, writeCommand: undefined}})：
 * 写闸自己执行，绝不再经 writeCommand（不会递归）。
 * `binding` = {root, round, commentId} 时是 serve 模式；不传是 exec 模式（认领和中断）。
 */
export function createGate({
  home,
  profile,
  github,
  run,
  now = () => Date.now(),
  lockWaitMs = GATE_LOCK_WAIT_MS,
  binding = null,
  which,
  sleep,
  repoRoot,
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('createGate 需要绝对路径的 home');
  if (!profile) throw new Error('createGate 需要 profile');
  if (!github) throw new Error('createGate 需要 github');
  if (typeof run !== 'function') throw new Error('createGate 需要 run（扫密钥要用本地 git）');

  const paths = hostPaths(home);
  const root = repoRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  let tree = null;
  const createdThisRound = new Set();

  async function whichCmd(cmd) {
    if (typeof which === 'function') return Boolean(await which(cmd));
    try {
      const result = await run(cmd, ['version'], { env: scanEnv() });
      return Boolean(result && result.code === 0);
    } catch {
      return false;
    }
  }

  function rootNumber() {
    return parseRef(binding.root).number;
  }

  async function loadTree() {
    if (!tree) tree = await collectTree({ github, profile, ref: binding.root });
    return tree;
  }

  async function refreshTree() {
    try {
      tree = await collectTree({ github, profile, ref: binding.root });
    } catch {
      // 刷新失败不影响这次成功的结果；下一次写操作会再算。
    }
  }

  /** 读一轮 issue 的正文和轮次评论（固定查询，不经调用方）。 */
  async function readIssueState(ref) {
    const { owner, name, number } = parseRef(ref);
    const data = await github.graphql(ROUNDS_COMMENTS_QUERY, { owner, name, number });
    const issue = data?.repository?.issue;
    if (!issue) return null;
    const rounds = parseRounds(issue.comments?.nodes || [], profile.ownerLogin);
    return { issue, rounds, latest: latestRound(rounds) };
  }

  function readLedger() {
    if (!fs.existsSync(paths.ledgerFile)) return [];
    let text;
    try {
      text = fs.readFileSync(paths.ledgerFile, 'utf8');
    } catch {
      return null;
    }
    const entries = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return null;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      entries.push(parsed);
    }
    return entries;
  }

  function appendLedger(entry) {
    fs.mkdirSync(path.dirname(paths.ledgerFile), { recursive: true, mode: 0o700 });
    fs.appendFileSync(paths.ledgerFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  function scopeOf(repo) {
    if (typeof repo !== 'string' || !repo) return null;
    return repoTier(repo, profile);
  }

  function searchAllowed(q) {
    if (!binding) return false;
    const phrase = `"[验收机] 修正 · 总 ${binding.root}" in:body is:issue`;
    if (typeof q !== 'string') return false;
    if (q === phrase) return true;
    if (!q.startsWith(phrase)) return false;
    const suffix = q.slice(phrase.length);
    if (!suffix.startsWith(' repo:')) return false;
    const repo = suffix.slice(' repo:'.length);
    return (profile.forkRepos || []).includes(repo);
  }

  async function handleRead(action) {
    const { query } = action;
    if (typeof query !== 'string' || !READ_QUERIES.has(query)) {
      return reject('query-not-allowed', '只接受登记过的只读查询，自己写的 GraphQL 一律不执行');
    }
    const variables = action.variables && typeof action.variables === 'object' ? action.variables : {};
    if (query !== SEARCH_QUERY || variables.owner != null || variables.name != null) {
      // 除了修正搜索，每条登记查询都按 owner/name 定位仓：缺了或不在名单里一律拒绝。
      if (typeof variables.owner !== 'string' || typeof variables.name !== 'string' || !scopeOf(`${variables.owner}/${variables.name}`)) {
        return reject('repo-not-allowed', `${variables.owner}/${variables.name} 不在配置的名单里`);
      }
    }
    if (!binding) return reject('needs-round-binding', '只读也要先绑定本轮（serve 模式）');
    if (query === SEARCH_QUERY && !searchAllowed(variables.q)) {
      return reject('search-not-allowed', '只放行本轮总 issue 的修正搜索');
    }
    const data = await github.graphql(query, variables);
    return { code: 0, body: { data: data ?? {} } };
  }

  async function checkPrChecks(action, { number, root }) {
    const [owner, name] = String(action.repo || '').split('/');
    const data = await github.graphql(STATUS_QUERY, {
      owner,
      name,
      number: Number(action.pr),
    });
    const pr = data?.repository?.pullRequest;
    if (!pr) return reject('not-in-tree', `找不到 PR ${action.repo}#${action.pr}`);
    // 从 fork 来的 PR 一律不认：分支名、正文谁都能照抄，只有本仓里的分支才是验收机推的。
    if (pr.isCrossRepository !== false) return reject('not-in-tree', 'PR 来自 fork（跨仓），不是验收机推的分支');
    // 只认本轮任务树里的修正 PR：head 分支是 acceptance/<总 issue 号>-…，正文带本轮总 issue 的修正标记。
    const head = String(pr.headRefName || '');
    const match = BRANCH_PATTERN.exec(head.includes(':') ? head.slice(head.indexOf(':') + 1) : head);
    if (!match || Number(match[1]) !== number) {
      return reject('not-in-tree', `PR 的 head 分支必须是 acceptance/${number}-<出处>-sc<k>`);
    }
    const marker = parseMarker(pr.body);
    if (!marker || marker.root !== root) {
      return reject('not-in-tree', 'PR 正文缺少本轮总 issue 的修正标记');
    }
    const nodes = pr.commits?.nodes || [];
    const state = nodes.at(-1)?.commit?.statusCheckRollup?.state;
    if (!GREEN_CHECKS.has(String(state))) {
      return reject('checks-not-green', `PR 检查状态：${state || '未知'}`);
    }
    return null;
  }

  /** serve 模式：只认本轮、只认本轮任务树。返回 null 表示放行。 */
  async function checkBoundWrite(action) {
    const state = await readIssueState(binding.root);
    if (!state) return reject('not-current-round', `找不到绑定的总 issue ${binding.root}`);
    const { latest } = state;
    const actual = latest ? `第 ${latest.round} 轮（${latest.status}）` : '还没有轮次';
    if (!latest || latest.round !== binding.round || latest.status !== '验收中') {
      return reject('not-current-round', `期望第 ${binding.round} 轮（验收中），实际${actual}`);
    }
    const number = rootNumber();
    const currentTree = await loadTree();
    const treeRefs = new Set([
      ...currentTree.issues.map((entry) => entry.ref),
      ...currentTree.corrections.map((entry) => entry.ref),
      ...createdThisRound,
    ]);

    switch (action.type) {
      case 'comment.update': {
        if (Number(action.commentId) !== Number(binding.commentId)) {
          return reject('not-in-tree', '只能改本轮认领的那条评论');
        }
        const first = firstLine(action.body);
        if (VERDICT_FIRST_LINE.test(first)) {
          if (versionLine(action.body) !== bodyVersion(state.issue.body)) {
            return reject('body-version-mismatch', '裁决里的正文版本和当前总 issue 正文不一致');
          }
        }
        return null;
      }
      case 'comment.create':
        if (ROUND_FIRST_LINE.test(firstLine(action.body))) {
          return reject('round-comment-forbidden', '轮次评论只能由宿主认领和改本轮那一条，不能另发');
        }
      // falls through
      case 'issue.edit':
      case 'issue.close':
      case 'issue.reopen':
      case 'project.field.set': {
        const target = refOf(action.repo, action.issue);
        if (!treeRefs.has(target)) {
          return reject('not-in-tree', `${target} 不在本轮任务树`);
        }
        if (action.type === 'issue.edit') {
          // 只许勾选或取消验收项（- [ ] ↔ - [x]），不许改正文的任何其它字。
          const current = target === binding.root ? state : await readIssueState(target);
          if (!current) return reject('not-in-tree', `找不到 ${target}`);
          if (!onlyCheckboxToggles(current.issue.body, action.body)) {
            return reject('edit-not-allowed', 'issue.edit 只能勾选或取消验收项，不能改正文其它内容');
          }
        }
        return null;
      }
      case 'issue.create': {
        const marker = parseMarker(action.body);
        if (!marker || marker.root !== binding.root) {
          return reject('not-in-tree', '正文缺少本轮总 issue 的修正标记');
        }
        if (!currentTree.issues.some((entry) => entry.ref === marker.item)) {
          return reject('not-in-tree', `修正项 ${marker.item} 不在本轮任务树`);
        }
        return null;
      }
      case 'subissue.add': {
        if (refOf(action.repo, action.issue) !== binding.root) {
          return reject('not-in-tree', '修正子 issue 只能挂到本轮总 issue');
        }
        const subRef = refOf(action.subRepo, action.subIssue);
        const allowed = new Set([...createdThisRound, ...currentTree.corrections.map((entry) => entry.ref)]);
        if (!allowed.has(subRef)) {
          return reject('not-in-tree', `${subRef} 不是本轮新建或已有的修正子 issue`);
        }
        return null;
      }
      case 'branch.push': {
        const match = BRANCH_PATTERN.exec(String(action.branch || ''));
        if (!match || Number(match[1]) !== number) {
          return reject('not-in-tree', `分支名必须是 acceptance/${number}-<出处>-sc<k>`);
        }
        return null;
      }
      case 'pr.create': {
        // 修正 PR 一律先开 Draft：转 Ready 只能走 pr.ready 的 CI 全绿复核。
        if (action.draft !== true) return reject('not-allowed', 'pr.create 必须带 draft: true');
        const head = String(action.head || '');
        const colon = head.indexOf(':');
        const headOwner = colon >= 0 ? head.slice(0, colon) : null;
        const branch = colon >= 0 ? head.slice(colon + 1) : head;
        // head 的属主：非 fork 档不许带前缀（分支就在目标仓）；fork 档必须正好是 ownerLogin 的 fork。
        if (scopeOf(action.repo)?.fork) {
          if (headOwner === null || headOwner.toLowerCase() !== String(profile.ownerLogin || '').toLowerCase()) {
            return reject('not-in-tree', `fork 档 PR 的 head 必须是 ${profile.ownerLogin}:<分支>`);
          }
        } else if (headOwner !== null) {
          return reject('not-in-tree', 'PR 的 head 不能带别的仓的前缀');
        }
        const match = BRANCH_PATTERN.exec(branch);
        if (!match || Number(match[1]) !== number) {
          return reject('not-in-tree', `PR 的 head 分支必须是 acceptance/${number}-<出处>-sc<k>`);
        }
        const marker = parseMarker(action.body);
        if (!marker || marker.root !== binding.root) {
          return reject('not-in-tree', 'PR 正文缺少本轮总 issue 的修正标记');
        }
        return null;
      }
      case 'pr.ready':
        return checkPrChecks(action, { number, root: binding.root });
      default:
        return reject('not-allowed', `serve 模式不认 ${action.type}`);
    }
  }

  /** exec 模式（宿主 start / abort）：只认认领和中断两条动作。返回 null 表示放行。 */
  async function checkExecWrite(action) {
    if (action.type !== 'comment.create' && action.type !== 'comment.update') {
      return reject('needs-round-binding', `${action.type} 需要本轮绑定`);
    }
    if (!action.repo || action.issue == null) {
      return reject('needs-round-binding', '执行模式的动作要带 repo 和 issue');
    }
    const ref = refOf(action.repo, action.issue);
    const state = await readIssueState(ref);
    if (!state) return reject('needs-round-binding', `找不到 ${ref}`);

    if (action.type === 'comment.create') {
      const match = ACCEPTANCE_FIRST_LINE.exec(firstLine(action.body));
      if (!match) {
        return reject('needs-round-binding', '执行模式只认「[验收机] 第 n 轮：验收中」的认领评论');
      }
      if (state.latest && state.latest.status === '验收中') {
        return reject('round-in-progress', `第 ${state.latest.round} 轮还在验收中，不能再认领新一轮`);
      }
      const maxRound = state.rounds.reduce((acc, entry) => Math.max(acc, entry.round), 0);
      const n = Number(match[1]);
      if (n !== maxRound + 1) {
        return reject('needs-round-binding', `期望第 ${maxRound + 1} 轮，收到第 ${n} 轮`);
      }
      if (versionLine(action.body) !== bodyVersion(state.issue.body)) {
        return reject('body-version-mismatch', '认领评论里的正文版本和当前正文不一致');
      }
      return null;
    }

    const { latest } = state;
    if (!latest || latest.status !== '验收中') {
      return reject('needs-round-binding', '没有进行中的轮次，不能改轮次评论');
    }
    if (Number(action.commentId) !== Number(latest.commentId)) {
      return reject('needs-round-binding', '只能改最新一轮的认领评论');
    }
    const match = ABORT_FIRST_LINE.exec(firstLine(action.body));
    if (!match) {
      return reject('needs-round-binding', '执行模式只认「[验收机] 第 n 轮：中断」的结束评论');
    }
    if (Number(match[1]) !== latest.round) {
      return reject('needs-round-binding', `期望第 ${latest.round} 轮，收到第 ${match[1]} 轮`);
    }
    return null;
  }

  /**
   * branch.push 执行前在写闸里再扫一遍密钥：扫到就 4，绝不推送。
   * 规则和 bin/push.mjs（#65 修复后）一致：扫的、推的是同一个提交 —— bundle 里 refs/heads/<branch> 指向的那个。
   * bundle 先复制进写闸自己的临时目录（沙箱看不到宿主 /tmp），扫这份副本、也推这份副本：
   * 沙箱在「扫完」和「推送」之间换掉原文件也没用。
   * 返回 {problem} 表示拒绝；{bundleCopy, cleanup} 表示放行，推送要用 bundleCopy。
   */
  async function defaultHeadInBundle(repo, bare, git) {
    const [owner, name] = String(repo || '').split('/');
    if (!owner || !name) return null;
    let oid;
    try {
      const data = await github.graphql(DEFAULT_HEAD_QUERY, { owner, name });
      oid = data?.repository?.defaultBranchRef?.target?.oid;
    } catch {
      return null;
    }
    if (typeof oid !== 'string' || !COMMIT_OID.test(oid)) return null;
    const result = await git(['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `${oid}^{commit}`]);
    if (!result || result.code !== 0 || String(result.stdout || '').trim() !== oid) return null;
    return oid;
  }

  async function scanBundle(action) {
    const { bundlePath, branch } = action;
    if (typeof bundlePath !== 'string' || !path.isAbsolute(bundlePath)) {
      return { problem: reject('bad-bundle', 'branch.push 的 bundlePath 必须是存在的绝对路径') };
    }
    if (typeof branch !== 'string' || !BRANCH_PATTERN.test(branch)) {
      return { problem: reject('bad-bundle', 'branch.push 缺少合法的分支名') };
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-gate-scan-'));
    const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    const bundleCopy = path.join(tmp, 'push.bundle');
    const bare = path.join(tmp, 'repo.git');
    let keep = false;
    try {
      try {
        const stat = fs.lstatSync(bundlePath);
        if (!stat.isFile()) throw new Error('不是普通文件');
        fs.copyFileSync(bundlePath, bundleCopy);
      } catch {
        return { problem: reject('bad-bundle', 'branch.push 的 bundlePath 必须是存在的普通文件') };
      }
      const env = scanEnv();
      const git = (args) => run('git', args, { env, timeoutMs: 120000 });
      let result = await git(['init', '-q', '--bare', bare]);
      if (!result || result.code !== 0) {
        return { problem: fail('scan-failed', `扫密钥前建临时仓失败：${firstLine(result?.stderr)}`) };
      }
      result = await git(['--git-dir', bare, 'fetch', '-q', bundleCopy, `refs/heads/${branch}:refs/heads/${branch}`]);
      if (!result || result.code !== 0) {
        return { problem: reject('bad-bundle', `bundle 里没有分支 ${branch}`) };
      }
      result = await git(['--git-dir', bare, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
      const commit = String(result?.stdout || '').trim();
      if (!result || result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
        return { problem: fail('scan-failed', `解析分支提交失败：${firstLine(result?.stderr)}`) };
      }
      // 基准由写闸自己定：目标仓默认分支的头提交在 bundle 里，就只扫它之后的新提交；
      // 读不到或不在 bundle 里，就扫这条分支的全部历史（更严，宁可多拦）。沙箱交来的 base 一律不看。
      const base = await defaultHeadInBundle(action.repo, bare, git);
      const range = base ? `${base}..${commit}` : commit;
      // 内置扫描每次都跑（有没有 gitleaks 都跑）：看的是范围新引入的每个对象的内容，不解析补丁，
      // 合并提交带进来的文件、含 NUL 的「二进制」文件、像补丁头的行都逃不掉。
      let found;
      try {
        found = await scanIntroducedObjects({
          git: (args, options) => run('git', args, { env, timeoutMs: 300000, ...options }),
          gitDir: ['--git-dir', bare],
          tip: commit,
          exclude: base ? [base] : [],
        });
      } catch (error) {
        return { problem: fail('scan-failed', firstLine(error?.message)) };
      }
      if (found.length) {
        return { problem: { code: 4, body: { reason: 'secret-found', files: found }, alert: 'secret-found' } };
      }
      if (await whichCmd('gitleaks')) {
        const reportFile = path.join(tmp, 'gitleaks-report.json');
        const scan = await run(
          'gitleaks',
          ['git', `--log-opts=${range}`, '--redact', '--report-format', 'json', '--report-path', reportFile, bare],
          { env, timeoutMs: 300000 },
        );
        if (!scan || (scan.code !== 0 && scan.code !== 1)) {
          return { problem: fail('scan-failed', `gitleaks 退出码 ${scan?.code ?? '未知'}`) };
        }
        if (scan.code === 1) {
          const files = readGitleaksFiles(reportFile);
          return {
            problem: {
              code: 4,
              body: { reason: 'secret-found', files: files.length ? files : ['（gitleaks 没给出文件名）'] },
              alert: 'secret-found',
            },
          };
        }
      }
      keep = true;
      return { bundleCopy, cleanup };
    } finally {
      if (!keep) cleanup();
    }
  }

  async function evaluate(action) {
    // 1. 动作本身
    if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string' || !action.type) {
      return reject('bad-action');
    }
    // 2. 类型白名单
    if (NOT_IMPLEMENTED_TYPES.has(action.type)) return reject('not-implemented');
    if (!ALLOWED_TYPES.has(action.type)) return reject('not-allowed');
    // 3. 总开关：关着时读、写、探测全部拒绝
    if (!fs.existsSync(paths.enabledFile)) return reject('gate-disabled');
    // 探测：不改任何东西，只回一句「闸在」
    if (action.type === 'probe') {
      if (action.repo && !scopeOf(action.repo)) return reject('repo-not-allowed', `${action.repo} 不在名单里`);
      return { code: 0, body: { ok: true, probe: true } };
    }
    // 7. 只读：不记账本、不拿执行锁
    if (action.type === 'read.graphql') return handleRead(action);

    // 4. 账本
    const ledger = readLedger();
    if (!ledger) return fail('ledger-corrupt', '账本里有读不出的行，先修账本');
    if (typeof action.dedupeKey !== 'string' || !action.dedupeKey) return reject('missing-dedupe-key');
    // 5. 仓范围
    const scope = scopeOf(action.repo);
    if (!scope) return reject('repo-not-allowed', `${action.repo ?? '(空)'} 不在配置的名单里`);
    if (action.type === 'subissue.add' && !scopeOf(action.subRepo)) {
      return reject('repo-not-allowed', `${action.subRepo ?? '(空)'} 不在配置的名单里`);
    }
    if (action.type === 'project.field.set') {
      if (action.ownerLogin != null && String(action.ownerLogin).toLowerCase() !== String(profile.ownerLogin).toLowerCase()) {
        return reject('project-not-allowed', `只能写自己账号下的看板`);
      }
      if (action.projectNumber != null && Number(action.projectNumber) !== Number(profile.projectNumber)) {
        return reject('project-not-allowed', `只能写配置里的看板 #${profile.projectNumber}`);
      }
    }

    // 6. 分档
    if (scope.tier === 'watch' && !WATCH_ALLOWED_TYPES.has(action.type)) {
      return reject('tier-not-allowed', `watch 档不写 ${action.type}`);
    }

    // 账本查重放在仓范围、分档之后：名单外的仓、档位不许的动作，哪怕账本里有同名 key 也照样拒绝。
    const seen = ledger.find((entry) => entry.dedupeKey === action.dedupeKey);
    if (seen) return { code: 0, body: seen.result ?? {} };

    // 8. 执行锁：同一时间只执行一条写动作；30 秒拿不到就回 75，什么都不执行
    const gotLock = await acquireLock(paths.execLock, { now, waitMs: lockWaitMs, sleep });
    if (!gotLock) return { code: 75, body: { reason: 'busy' } };
    try {
      // 9. 绑定本轮
      const bindingProblem = binding ? await checkBoundWrite(action) : await checkExecWrite(action);
      if (bindingProblem) return bindingProblem;
      // 10. 推送前在写闸里扫密钥；推的是扫过的那份副本
      let toWrite = action;
      let cleanupBundle = null;
      if (action.type === 'branch.push') {
        const scan = await scanBundle(action);
        if (scan.problem) return scan.problem;
        cleanupBundle = scan.cleanup;
        toWrite = { ...action, bundlePath: scan.bundleCopy };
      }
      // 11. 执行
      let result;
      try {
        result = await github.write(toWrite);
      } catch (error) {
        return fail('write-failed', redact(error?.message || String(error), profile));
      } finally {
        if (cleanupBundle) cleanupBundle();
      }
      appendLedger({
        dedupeKey: action.dedupeKey,
        type: action.type,
        result: result ?? {},
        at: new Date(now()).toISOString(),
      });
      if (binding && action.type === 'issue.create' && result?.issue) {
        createdThisRound.add(refOf(action.repo, result.issue));
        await refreshTree();
      }
      return { code: 0, body: result ?? {} };
    } finally {
      releaseLock(paths.execLock);
    }
  }

  async function handle(action) {
    let outcome;
    try {
      outcome = await evaluate(action);
    } catch (error) {
      outcome = fail('gate-error', redact(error?.message || String(error), profile));
    }
    if (outcome.alert === 'secret-found') {
      appendAlert(paths, {
        kind: 'secret-found',
        issue: action?.repo && action?.issue != null ? refOf(action.repo, action.issue) : undefined,
        round: binding?.round,
        reason: `branch.push 扫到疑似密钥，没推：${(outcome.body?.files || []).join(', ')}`,
        now,
        profile,
      });
    }
    if (outcome.code === 4 && outcome.body?.reason && outcome.body.reason !== 'gate-disabled') {
      appendAlert(paths, {
        kind: 'gate-rejected',
        issue: action?.repo && action?.issue != null ? refOf(action.repo, action.issue) : undefined,
        round: binding?.round,
        reason: outcome.body.reason,
        detail: `${action?.type ?? 'unknown'} ${action?.repo ?? ''}`.trim(),
        now,
        profile,
      });
    }
    return { code: outcome.code, body: outcome.body };
  }

  /** serve 模式启动时先算一次任务树（算不出就起不来，fail-closed）。 */
  async function start() {
    if (binding) await loadTree();
    return { paths };
  }

  return { handle, start, paths, binding, home, repoRoot: root };
}

/**
 * 起 unix socket（权限 600，父目录 700）；一条连接一个 JSON 请求，回一行 {code, body}。
 * 请求串行处理，避免两个写动作交错。
 */
export async function startGateServer({ gate, socketPath } = {}) {
  if (!gate) throw new Error('startGateServer 需要 gate');
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) {
    throw new Error('startGateServer 需要绝对路径的 socketPath');
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.rmSync(socketPath, { force: true });

  let chain = Promise.resolve();

  function readRequest(socket) {
    return new Promise((resolve) => {
      let buffer = '';
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        socket.off('data', onData);
        socket.off('end', onEnd);
        socket.off('error', onEnd);
        resolve(value);
      };
      const onData = (chunk) => {
        buffer += chunk;
        const at = buffer.indexOf('\n');
        if (at !== -1) finish(buffer.slice(0, at));
      };
      const onEnd = () => finish(buffer);
      socket.on('data', onData);
      socket.on('end', onEnd);
      socket.on('error', onEnd);
    });
  }

  async function respond(socket) {
    try {
      const raw = await readRequest(socket);
      let action;
      try {
        action = JSON.parse(raw || '{}');
      } catch {
        socket.end(`${JSON.stringify({ code: 1, body: { reason: 'bad-request' } })}\n`);
        return;
      }
      const outcome = await gate.handle(action);
      socket.end(`${JSON.stringify(outcome)}\n`);
    } catch (error) {
      socket.end(`${JSON.stringify({ code: 1, body: { reason: 'gate-error', detail: redact(error?.message) } })}\n`);
    }
  }

  const server = net.createServer((socket) => {
    chain = chain.then(() => respond(socket)).catch(() => {});
  });
  await new Promise((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);

  return {
    socketPath,
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(socketPath, { force: true });
    },
  };
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

function parseFlags(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string' || !arg.startsWith('--')) continue;
    flags.set(arg.slice(2), argv[i + 1]);
    i += 1;
  }
  return flags;
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flags = parseFlags(rest);
  const home = flags.get('home') || process.env.ACCEPTANCE_WATCHER_HOME || watcherHome();
  const run = procRun;

  if (command === 'serve') {
    const socketPath = flags.get('socket');
    const issue = flags.get('issue');
    const round = Number(flags.get('round'));
    const commentId = flags.get('comment-id');
    if (!socketPath || !issue || !Number.isInteger(round) || commentId == null) {
      process.stderr.write('serve 需要 --socket <路径> --issue <owner/repo#n> --round <n> --comment-id <id>\n');
      process.exitCode = 1;
      return;
    }
    const profile = loadAcceptanceProfile({ ...process.env, ACCEPTANCE_WATCHER_HOME: home });
    const gate = createGate({
      home,
      profile,
      github: createGithub({ profile: { ...profile, writeCommand: undefined }, run }),
      run,
      binding: { root: issue, round, commentId },
    });
    await gate.start();
    const server = await startGateServer({ gate, socketPath });
    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return;
  }

  if (command === 'exec' || command === 'probe') {
    const profile = loadAcceptanceProfile({ ...process.env, ACCEPTANCE_WATCHER_HOME: home });
    const gate = createGate({
      home,
      profile,
      github: createGithub({ profile: { ...profile, writeCommand: undefined }, run }),
      run,
    });
    let action;
    if (command === 'probe') {
      const repo = flags.get('repo');
      action = repo ? { type: 'probe', repo } : { type: 'probe' };
    } else {
      const raw = await readStdin();
      try {
        action = JSON.parse(raw || '{}');
      } catch {
        process.stdout.write(`${JSON.stringify({ reason: 'bad-request' })}\n`);
        process.exitCode = 1;
        return;
      }
    }
    const outcome = await gate.handle(action);
    process.stdout.write(`${JSON.stringify(outcome.body)}\n`);
    process.exitCode = outcome.code;
    return;
  }

  process.stderr.write(
    '用法：\n' +
      '  node host/write-gate.mjs exec                     # 一条动作 JSON 从 stdin 进来\n' +
      '  node host/write-gate.mjs serve --socket <p> --issue <owner/repo#n> --round <n> --comment-id <id>\n' +
      '  node host/write-gate.mjs probe [--repo <owner/repo>]\n',
  );
  process.exitCode = 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}

