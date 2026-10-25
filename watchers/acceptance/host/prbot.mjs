#!/usr/bin/env node
// 修正轮（#60）：一个修正子 issue 一个进程。阶段照 Pi 线：
// 1 发现 → 2 评估 → 3 修复 → 4 本地预检 → 5 提交和建 Draft → 6 盯 Draft CI
// → 7 自动再修 → 8 转 Ready → 9 Ready 之后 → 10 合并（永远不做）→ 11 清理。
// 所有写操作都经 host/write-gate.mjs；这里不直接调 gh、不直接 push。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { createGithub } from '../bin/github.mjs';
import { ISSUE_BODY_QUERY, collectTree, parseMarker } from '../bin/collect.mjs';
import { bodyVersion, latestRound, parseRef, parseRounds, ISSUE_COMMENTS_QUERY as ROUND_COMMENTS_QUERY } from '../bin/rounds.mjs';
import { collectTasks, repoTier } from '../bin/tasks.mjs';
import { redact } from '../bin/redact.mjs';
import { appendAlert, hostPaths, releaseLock, tryAcquireLock } from './paths.mjs';
import { appendPrbotEvent } from './prbot-events.mjs';
import { createLocalGit } from '../bin/localgit.mjs';
import { run as procRun } from './proc.mjs';
import { MEMORY_GATE_BYTES, acquireSlot, readHostConfig, readMemAvailable } from './round.mjs';
import {
  createGate,
  MAIN_CHECKS_QUERY,
  PR_BY_BRANCH_QUERY,
  PR_STATUS_QUERY,
  READY_ACTIVITY_QUERY,
} from './write-gate.mjs';
import { runPiInSandbox, runPreflightInSandbox } from './prbot-sandbox.mjs';

export const MAX_CORRECTION_ROUNDS = 2;
export const MAX_PI_ITERATIONS = 4;
export const MAX_REWORK = 2;
export const MAX_REFIX = 2;
export const MAX_CONFLICT = 3;
export const MAX_HEAD_WAIT_MS = 60 * 60 * 1000;
export const READY_STALL_MS = 24 * 60 * 60 * 1000;
export const MAX_ROUND_MS = 3 * 60 * 60 * 1000;
export const WATCH_INTERVAL_MS = 2 * 60 * 1000;

const CORRECTION_STATUS_LINE = /^\[修正机\] 第 (\d+) 轮：(修正中|Draft 已开|等 CI|再修 \d+\/2|已 Ready|需人工处理|中断)$/;
const CORRECTION_TERMINAL = new Set(['已 Ready', '需人工处理', '中断']);
const KNOWN_STATUS = new Set(['修正中', 'Draft 已开', '等 CI', '已 Ready', '需人工处理', '中断']);

function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

function stateKey(issue) {
  const { owner, name, number } = parseRef(issue);
  return `${owner}__${name}__${number}`;
}

export function prbotStatePath(paths, issue) {
  return path.join(paths.prbotRoundsDir, `${stateKey(issue)}.json`);
}

function saveState(paths, state) {
  const file = prbotStatePath(paths, state.issue);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function loadState(paths, issue) {
  try {
    return JSON.parse(fs.readFileSync(prbotStatePath(paths, issue), 'utf8'));
  } catch {
    return null;
  }
}

export function parseCorrectionRounds(comments, ownerLogin) {
  const owner = String(ownerLogin || '').toLowerCase();
  const rounds = [];
  for (const comment of comments || []) {
    if (String(comment?.author?.login || '').toLowerCase() !== owner) continue;
    const first = String(comment.body || '').split('\n')[0] || '';
    const match = CORRECTION_STATUS_LINE.exec(first);
    if (!match) continue;
    rounds.push({
      round: Number(match[1]),
      status: match[2],
      commentId: comment.databaseId,
      createdAt: comment.createdAt,
      url: comment.url,
    });
  }
  rounds.sort((a, b) => {
    const ta = Date.parse(a.createdAt || 0) || 0;
    const tb = Date.parse(b.createdAt || 0) || 0;
    if (ta !== tb) return ta - tb;
    return (a.commentId || 0) - (b.commentId || 0);
  });
  return rounds;
}

export function correctionBranch(marker) {
  const root = parseRef(marker.root).number;
  const item = parseRef(marker.item).number;
  return `acceptance/${root}-${item}-sc${marker.sc}`;
}

function repoOwner(repo) {
  return String(repo || '').split('/')[0];
}

function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function matchesForbidden(file, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file));
}

/** 停止条件（SC12）：纯函数，测试直接喂状态。 */
export function stopReason(state, { now = () => Date.now() } = {}) {
  if (state?.ready) return { stop: true, reason: 'ready', needsHuman: false };
  if (state?.failureReason) return { stop: true, reason: state.failureReason, needsHuman: true };
  if (state?.gateCode === 4) return { stop: true, reason: 'gate-rejected', needsHuman: true };
  if (state?.interruptedExhausted) return { stop: true, reason: 'interrupted-exhausted', needsHuman: false };
  if (state?.correctionRound > MAX_CORRECTION_ROUNDS) return { stop: true, reason: 'limit-correction-rounds', needsHuman: true };
  if (state?.piIterations > MAX_PI_ITERATIONS) return { stop: true, reason: 'limit-pi-iterations', needsHuman: true };
  if (state?.rework > MAX_REWORK) return { stop: true, reason: 'limit-rework', needsHuman: true };
  if (state?.refix > MAX_REFIX) return { stop: true, reason: 'limit-refix', needsHuman: true };
  if (state?.conflict > MAX_CONFLICT) return { stop: true, reason: 'limit-conflict', needsHuman: true };
  if (state?.headWaitExpired) return { stop: true, reason: 'limit-head-wait', needsHuman: true };
  if (state?.mainRed) return { stop: true, reason: 'main-red', needsHuman: true };
  if (state?.forbiddenPaths?.length) return { stop: true, reason: 'forbidden-path', needsHuman: true };
  if (state?.secretFiles?.length) return { stop: true, reason: 'secret-found', needsHuman: true };
  if (state?.issueClosed) return { stop: true, reason: 'issue-closed', needsHuman: true };
  if (state?.verdict && state.verdict !== '要修') return { stop: true, reason: 'verdict-not-fix', needsHuman: true };
  if (state?.paused) return { stop: true, reason: 'paused', needsHuman: true };
  if (state?.startedAt && now() - Date.parse(state.startedAt) > MAX_ROUND_MS) {
    return { stop: true, reason: 'round-too-long', needsHuman: true };
  }
  return { stop: false, reason: null, needsHuman: false };
}

export async function discoverCorrections({ github, profile, now = () => Date.now() } = {}) {
  const out = [];
  const tasks = await collectTasks(github, profile);
  for (const task of tasks) {
    if (task.tier !== 'auto') continue;
    const latest = latestRound(task.rounds);
    if (!latest || latest.status !== '要修') continue;
    let tree;
    try {
      tree = await collectTree({ github, profile, ref: task.ref });
    } catch {
      continue;
    }
    for (const correction of tree.corrections) {
      if (correction.state !== 'open') continue;
      const marker = correction.marker;
      if (!marker) continue;
      const correctionRepo = parseRef(correction.ref).repo;
      const scope = repoTier(correctionRepo, profile);
      if (!scope || scope.tier !== 'auto') continue;
      out.push({
        issue: correction.ref,
        root: marker.root,
        item: marker.item,
        sc: marker.sc,
        url: correction.url,
        at: new Date(now()).toISOString(),
      });
    }
  }
  return out;
}

function flattenStatus(status) {
  const commit = (status?.commits?.nodes || []).at(-1)?.commit || status?.commit || {};
  const runs = [];
  for (const suite of commit.checkSuites?.nodes || []) {
    for (const run of suite?.checkRuns?.nodes || []) {
      runs.push({ ...run, runId: run?.checkSuite?.workflowRun?.databaseId ?? suite?.workflowRun?.databaseId ?? null });
    }
  }
  const contexts = (commit.statusCheckRollup?.contexts?.nodes || []).filter(
    (node) => node?.__typename === 'StatusContext' || node?.context,
  );
  const failures = [];
  for (const run of runs) {
    if (String(run.status) !== 'COMPLETED' || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(run.conclusion))) {
      failures.push({
        name: run.name || String(run.databaseId || 'check'),
        conclusion: String(run.conclusion || run.status || '?'),
        runId: run.runId,
      });
    }
  }
  for (const context of contexts) {
    if (String(context.state) !== 'SUCCESS') {
      failures.push({ name: context.context || 'status', conclusion: String(context.state || '?'), runId: null });
    }
  }
  return { runs, contexts, failures, total: runs.length + contexts.length };
}

function failureFingerprint(failures, headSha) {
  return `${failures.map((item) => `${item.name}:${item.conclusion}`).sort().join('|')}@${headSha}`;
}

function mainRedNames(data) {
  const target = data?.repository?.ref?.target || {};
  const names = new Set();
  for (const suite of target.checkSuites?.nodes || []) {
    for (const run of suite?.checkRuns?.nodes || []) {
      if (String(run.status) === 'COMPLETED' && !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(String(run.conclusion))) {
        names.add(run.name);
      }
    }
  }
  for (const node of target.statusCheckRollup?.contexts?.nodes || []) {
    if (node?.context && String(node.state) !== 'SUCCESS') names.add(node.context);
  }
  return { names, sha: target.oid || null };
}

/**
 * 盯一次 Draft CI（SC6 / SC7）。返回：
 * {action:'wait'} | {action:'rerun',runId,fingerprint} | {action:'update-branch'} |
 * {action:'refix'} | {action:'ready',checks} | {action:'needs-human',reason,...}
 */
export async function pollDraft({
  state,
  status,
  mainChecks,
  now = () => Date.now(),
  reviewCheckPattern,
} = {}) {
  const head = status?.headRefOid || state?.pr?.headSha || null;
  if (state.watchHead !== head) {
    state.watchHead = head;
    state.watchStartedAt = new Date(now()).toISOString();
    state.failureSeen = [];
    state.rerunFingerprints = [];
  }
  state.pr = { ...(state.pr || {}), headSha: head, isDraft: status?.isDraft !== false };
  if (status) {
    state.diff = {
      files: Number(status.changedFiles ?? state.diff?.files ?? 0),
      additions: Number(status.additions ?? state.diff?.additions ?? 0),
      deletions: Number(status.deletions ?? state.diff?.deletions ?? 0),
    };
  }
  const started = Date.parse(state.watchStartedAt || '') || now();
  if (now() - started > MAX_HEAD_WAIT_MS) {
    state.headWaitExpired = true;
    return { action: 'needs-human', reason: 'limit-head-wait' };
  }

  const checks = flattenStatus(status);
  const behind = String(status?.mergeStateStatus || '').toUpperCase() === 'BEHIND' || Number(status?.behindBy || 0) > 0;
  if (behind && checks.total === 0) {
    if ((state.conflict || 0) >= MAX_CONFLICT) {
      state.conflict = MAX_CONFLICT + 1;
      return { action: 'needs-human', reason: 'limit-conflict' };
    }
    state.conflict = (state.conflict || 0) + 1;
    return { action: 'update-branch' };
  }

  if (checks.failures.length) {
    state.failureSeen = Array.isArray(state.failureSeen) ? state.failureSeen : [];
    const fresh = checks.failures.filter((failure) => !state.failureSeen.includes(`${failure.name}:${failure.conclusion}`));
    for (const failure of fresh) state.failureSeen.push(`${failure.name}:${failure.conclusion}`);
    const rerunnable = fresh.find((failure) => failure.runId && !state.rerunFingerprints?.includes(`${failure.name}:${failure.conclusion}@${head}`));
    if (rerunnable) {
      state.rerunFingerprints = [...(state.rerunFingerprints || []), `${rerunnable.name}:${rerunnable.conclusion}@${head}`];
      return { action: 'rerun', runId: rerunnable.runId, fingerprint: `${rerunnable.name}:${rerunnable.conclusion}@${head}` };
    }

    const red = mainChecks?.names || new Set();
    const sameOnMain = checks.failures.find((failure) => red.has(failure.name));
    if (sameOnMain) {
      state.mainRed = { check: sameOnMain.name, mainSha: mainChecks?.sha || null, url: status?.url || state.pr?.url || null };
      return { action: 'needs-human', reason: 'main-red', evidence: state.mainRed };
    }

    const fingerprint = failureFingerprint(checks.failures, head);
    if (state.lastFixedHead === head && state.lastFixedFingerprint === fingerprint) {
      return { action: 'needs-human', reason: 'same-head-same-failure' };
    }
    if ((state.refix || 0) >= MAX_REFIX) {
      state.refix = MAX_REFIX + 1;
      return { action: 'needs-human', reason: 'limit-refix' };
    }
    state.refix = (state.refix || 0) + 1;
    state.lastFixedHead = head;
    state.lastFixedFingerprint = fingerprint;
    return { action: 'refix', fingerprint };
  }

  if (checks.total > 0 && checks.failures.length === 0) {
    state.lastChecks = { green: checks.total, total: checks.total, url: status?.url || state.pr?.url || null };
    return { action: 'ready', checks: state.lastChecks };
  }

  return { action: 'wait' };
}

async function readIssueState(github, ref, ownerLogin) {
  const { owner, name, number } = parseRef(ref);
  const data = await github.graphql(ROUND_COMMENTS_QUERY, { owner, name, number });
  const issue = data?.repository?.issue;
  if (!issue) return null;
  return { issue, rounds: parseRounds(issue.comments?.nodes || [], ownerLogin) };
}

async function readComments(github, ref) {
  const { owner, name, number } = parseRef(ref);
  const data = await github.graphql(ROUND_COMMENTS_QUERY, { owner, name, number });
  return data?.repository?.issue || null;
}

function parseVerdictItems(body) {
  const items = [];
  const re = /^\s*-\s*要修：([\w.-]+\/[\w.-]+#\d+)\s+SC(\d+)(.*)$/;
  for (const line of String(body || '').split('\n')) {
    const match = re.exec(line);
    if (match) items.push({ ref: match[1], sc: Number(match[2]), text: line.trim() });
  }
  return items;
}

function formatRoundComment(state, status, extra = {}) {
  const lines = [
    `[修正机] 第 ${state.round} 轮：${status}`,
    `开始：${state.startedAt}`,
    `总 issue：${state.root}`,
    `验收项：${state.item} SC${state.sc}`,
    '',
    '## 步骤',
  ];
  for (const step of state.steps || []) lines.push(`- ${step}`);
  if (state.mustFix?.length) {
    lines.push('## 必修');
    for (const item of state.mustFix) lines.push(`- ${item.ref} SC${item.sc}`);
  }
  if (state.disputes?.length) {
    lines.push('## 有争议');
    for (const item of state.disputes) lines.push(`- ${item.ref} SC${item.sc}：${redact(item.reason || '')}`);
  }
  if (state.manual?.length) {
    lines.push('## 人工手测（不修）');
    for (const item of state.manual) lines.push(`- ${item.ref} SC${item.sc}`);
  }
  if (state.secretFiles?.length) lines.push(`扫到疑似密钥，没推：${state.secretFiles.join(', ')}`);
  if (state.pr?.url) lines.push(`PR：${state.pr.url}`);
  if (extra.note) {
    lines.push('');
    lines.push(extra.note);
  }
  return lines.join('\n');
}

async function updateComment({ gate, state, status, note, sleep, now }) {
  if (!gate || !state.claimCommentId) return null;
  if (!KNOWN_STATUS.has(status) && !/^再修 \d+\/2$/.test(status)) {
    throw new Error(`未知的修正轮状态：${status}`);
  }
  state.commentSeq = (state.commentSeq || 0) + 1;
  const body = formatRoundComment(state, status, { note });
  const action = {
    type: 'comment.update',
    dedupeKey: `prbot:${state.issue}:r${state.round}:comment:${state.commentSeq}`,
    repo: parseRef(state.issue).repo,
    issue: parseRef(state.issue).number,
    commentId: state.claimCommentId,
    body,
  };
  return gateWrite(gate, action, { state, sleep, now });
}

async function gateWrite(gate, action, { state, sleep, now = () => Date.now() } = {}) {
  let busy = 0;
  let failures = 0;
  let delay = 60 * 1000;
  for (;;) {
    const outcome = await gate.handle(action);
    if (outcome.code === 0) return outcome;
    if (outcome.code === 75) {
      busy += 1;
      if (busy > 6) {
        state.gateBusyExhausted = true;
        return outcome;
      }
      await sleep(30 * 1000);
      continue;
    }
    if (outcome.code === 1 && failures < 5) {
      failures += 1;
      await sleep(delay);
      delay *= 2;
      continue;
    }
    if (outcome.code === 1) state.interruptedExhausted = true;
    if (outcome.code === 4) state.gateCode = 4;
    return outcome;
  }
}

async function gateRead(gate, query, variables) {
  const outcome = await gate.handle({ type: 'read.graphql', query, variables });
  if (outcome.code !== 0) throw new Error(`写闸拒绝读：${outcome.body?.reason || outcome.code}`);
  return outcome.body?.data || {};
}

function readNotes(roundDir, stdout) {
  const notes = { disputes: [], ci: [] };
  try {
    const file = path.join(roundDir, 'prbot-notes.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed?.disputes)) notes.disputes = parsed.disputes;
  } catch {
    // 没有笔记文件就只看 stdout。
  }
  for (const line of String(stdout || '').split('\n')) {
    const match = /有争议[:：]\s*([\w.-]+\/[\w.-]+#\d+)\s+SC(\d+)\s*[:：]\s*(.+)$/.exec(line.trim());
    if (match) notes.disputes.push({ ref: match[1], sc: Number(match[2]), reason: match[3].trim() });
  }
  return notes;
}

function buildPrompt(state) {
  const must = (state.mustFix || []).map((item) => `- ${item.ref} SC${item.sc}`).join('\n') || '-（没有列出的条目）';
  return [
    '你是修正机，在目标仓的工作树里修一个验收没过的条目。',
    `修正子 issue：${state.issue}`,
    `总 issue：${state.root}`,
    `验收项：${state.item} SC${state.sc}`,
    '必修：',
    must,
    '',
    '要求：',
    '1. 先写一个会变红的复现测试，再写最小修复。',
    '2. 只改与这个修正项有关的文件；不要改 CI 配置或禁改路径。',
    '3. 先在工作树里用 git commit -s 提交。',
    '4. 如果某条验收项不成立，不要改代码，写一行：有争议：<owner/repo#n> SC<k>：<理由>',
    '不要把令牌、私钥或本机路径写进代码、提交信息或输出。',
  ].join('\n');
}

async function defaultPrepareWorktree({ github, state, profile, run }) {
  const { owner, name, number } = parseRef(state.issue);
  const root = path.join(profile.worktreeDir, 'prbot');
  const worktree = path.join(root, `${owner}__${name}__${number}-r${state.round}`);
  const marker = path.join(worktree, '.acc-owned.json');
  fs.mkdirSync(root, { recursive: true });
  if (fs.existsSync(worktree)) {
    if (!fs.existsSync(marker)) throw new Error('工作树已存在但没有 .acc-owned.json，拒绝覆盖');
    return { worktree, reused: true };
  }
  if (typeof github.fetchBranch !== 'function') throw new Error('github 没有 fetchBranch');
  await github.fetchBranch({ repo: state.pushRepo || state.repo || parseRef(state.issue).repo, branch: 'main', dir: worktree });
  const env = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
  await run('git', ['-C', worktree, 'checkout', '-q', '-B', state.branch, 'origin/main'], { env });
  fs.writeFileSync(
    marker,
    JSON.stringify({ kind: 'prbot', issue: state.issue, round: state.round, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  return { worktree, reused: false };
}

function prepareBundle({ state, worktree, localgit }) {
  const git = localgit || createLocalGit();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prbot-bundle-'));
  const bundlePath = path.join(tmp, 'push.bundle');
  return Promise.resolve(
    git.branchSha({ branch: state.branch, cwd: worktree }).then(async (resolved) => {
      const headSha = String(resolved?.stdout || '').trim();
      if (resolved?.code !== 0 || !/^[0-9a-f]{40,64}$/.test(headSha)) {
        throw new Error(`本地没有分支 ${state.branch}`);
      }
      const bundled = await git.createBundle({ branch: state.branch, file: bundlePath, cwd: worktree });
      if (bundled?.code !== 0 || !fs.existsSync(bundlePath)) throw new Error('打包失败');
      return {
        bundlePath,
        headSha,
        cleanup() {
          fs.rmSync(tmp, { recursive: true, force: true });
        },
      };
    }),
  );
}

async function diffFiles({ worktree, state, run }) {
  const result = await run('git', ['-C', worktree, 'diff', '--name-only', `origin/main...${state.branch}`], {
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
  });
  if (!result || result.code !== 0) return [];
  return String(result.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function repoConfig(hostConfig, repo) {
  return hostConfig?.prbot?.repos?.[repo] || {};
}

function handoffFor(hostConfig, repo) {
  return repoConfig(hostConfig, repo).handoff === 'watcher' ? 'watcher' : 'owner';
}

function piCommandFor(hostConfig) {
  const command = hostConfig?.prbot?.piCommand || hostConfig?.piCommand;
  if (!Array.isArray(command) || command.length === 0) throw new Error('host.json 缺少 prbot.piCommand（或 piCommand）');
  return [...command];
}

function readyStatePath(paths, state) {
  return path.join(paths.prbotReadyDir, `${stateKey(state.issue)}.json`);
}

function writeReadyState(paths, state) {
  const file = readyStatePath(paths, state);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        issue: state.issue,
        root: state.root,
        repo: state.prRepo,
        pr: state.pr?.number,
        prUrl: state.pr?.url,
        headSha: state.pr?.headSha,
        readyAt: state.readyAt,
        handoff: state.handoff,
        stalledAt: null,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

function compileReviewPattern(patternSource) {
  if (patternSource instanceof RegExp) return patternSource;
  const text = String(patternSource || 'review');
  const match = /^\/(.*)\/([a-z]*)$/i.exec(text);
  if (match) {
    try {
      return new RegExp(match[1], match[2]);
    } catch {
      return /review/i;
    }
  }
  return new RegExp(text, 'i');
}

/** 24 小时没人接（SC10）：只对 handoff=watcher 的 PR 追加一次 ready-stalled。 */
export async function checkReadyStalled({ home, profile, github, now = () => Date.now(), reviewCheckPattern } = {}) {
  const paths = hostPaths(home);
  let names = [];
  try {
    names = fs.readdirSync(paths.prbotReadyDir);
  } catch {
    return [];
  }
  const patternSource = reviewCheckPattern || 'review';
  const pattern = compileReviewPattern(patternSource);
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(paths.prbotReadyDir, name);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (entry.handoff !== 'watcher' || entry.stalledAt) continue;
    const readyAt = Date.parse(entry.readyAt || 0);
    if (!Number.isFinite(readyAt) || now() - readyAt < READY_STALL_MS) continue;
    const { owner, name: repoName } = parseRef(`${entry.repo}#${entry.pr}`);
    const data = await github.graphql(READY_ACTIVITY_QUERY, {
      owner,
      name: repoName,
      number: Number(entry.pr),
    });
    const pr = data?.repository?.pullRequest;
    if (!pr) continue;
    const reviews = pr.reviews?.nodes || [];
    const comments = pr.comments?.nodes || [];
    const checks = [];
    for (const suite of pr.commits?.nodes?.at(-1)?.commit?.checkSuites?.nodes || []) {
      for (const run of suite?.checkRuns?.nodes || []) {
        if (pattern.test(String(run.name || ''))) checks.push(run);
      }
    }
    const activity = reviews.length > 0 || comments.length > 0 || checks.length > 0;
    if (activity) continue;
    appendPrbotEvent(
      paths,
      {
        type: 'ready-stalled',
        issue: entry.issue,
        root: entry.root,
        repo: entry.repo,
        pr: entry.pr,
        prUrl: entry.prUrl,
        headSha: entry.headSha,
        readyAt: entry.readyAt,
        handoff: 'watcher',
      },
      { now, profile },
    );
    entry.stalledAt = new Date(now()).toISOString();
    fs.writeFileSync(file, JSON.stringify(entry, null, 2), { mode: 0o600 });
    out.push(entry);
  }
  return out;
}

/** 清理（SC11）：只回收带 prbot 的 .acc-owned.json 的工作树，别的一概不动。 */
export function cleanupWorktrees({ home, profile, fsImpl = fs } = {}) {
  const paths = hostPaths(home);
  const root = path.join(profile.worktreeDir, 'prbot');
  let names = [];
  try {
    names = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed = [];
  for (const entry of names) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const marker = path.join(dir, '.acc-owned.json');
    let parsed;
    try {
      parsed = JSON.parse(fsImpl.readFileSync(marker, 'utf8'));
    } catch {
      continue;
    }
    if (parsed?.kind !== 'prbot') continue;
    try {
      fsImpl.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // 删不掉就留着，下一次再清理。
    }
  }
  return removed;
}

function makeState({ issue, marker, rootTree }) {
  const nowIso = new Date().toISOString();
  const correctionRepo = parseRef(issue).repo;
  const rootRepo = parseRef(marker.root).repo;
  const pushRepo = rootTree?.root?.fork
    ? (rootTree?.profileForkRepo || correctionRepo)
    : correctionRepo;
  return {
    issue,
    root: marker.root,
    item: marker.item,
    sc: marker.sc,
    repo: correctionRepo,
    rootRepo,
    pushRepo,
    prRepo: rootRepo,
    round: null,
    claimCommentId: null,
    stage: 'assess',
    status: '修正中',
    steps: ['发现：修正子 issue、标记、总 issue 裁决对得上'],
    startedAt: nowIso,
    updatedAt: nowIso,
    piIterations: 0,
    rework: 0,
    refix: 0,
    conflict: 0,
    commentSeq: 0,
    mustFix: [],
    fixed: [],
    disputes: [],
    manual: [],
    failureSeen: [],
    rerunFingerprints: [],
    handoff: 'owner',
  };
}

/**
 * 跑一个修正子 issue。返回 0 到 Ready、1 需人工处理 / 中断、3 这一拍不跑、4 写闸拒绝。
 */
export async function runPrbotCorrection({
  home,
  issue,
  env = process.env,
  profile,
  hostConfig,
  github,
  run = procRun,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = () => {},
  prepareWorktree = defaultPrepareWorktree,
  piRunner,
  preflightRunner,
  bundleFactory = prepareBundle,
  makeGate,
  statusProvider,
  mainChecksProvider,
  localgit,
  meminfoPath = '/proc/meminfo',
} = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('runPrbotCorrection 需要绝对路径的 home');
  if (typeof issue !== 'string' || !/^[^/\s]+\/[^#\s]+#\d+$/.test(issue)) throw new Error('issue 应为 owner/repo#n');
  const paths = hostPaths(home);
  const settings = hostConfig || readHostConfig(paths.hostConfig);
  const acceptanceProfile = profile || loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
  const gateGithub = github || createGithub({ profile: { ...acceptanceProfile, writeCommand: undefined }, run });

  // 和验收轮共用的内存门与 2 个槽（SC1）。
  const available = readMemAvailable(meminfoPath);
  if (available == null || available < MEMORY_GATE_BYTES) return 3;
  const lockFile = path.join(paths.prbotLocksDir, `${stateKey(issue)}.lock`);
  if (!tryAcquireLock(lockFile, { now })) return 3;
  const slot = acquireSlot(paths, now);
  if (!slot) {
    releaseLock(lockFile);
    return 3;
  }

  const context = { paths, settings, profile: acceptanceProfile, github: gateGithub, run, now, sleep, log };
  const pi = piRunner || runPiInSandbox;
  const preflight = preflightRunner || runPreflightInSandbox;
  const gateFor = (binding) =>
    makeGate ? makeGate({ binding, ...context }) : createGate({ home, profile: acceptanceProfile, github: gateGithub, run, binding });

  try {
    const correction = await readComments(gateGithub, issue);
    if (!correction) return 1;
    const marker = parseMarker(correction.body);
    if (!marker || marker.root == null) return 1;
    const correctionRounds = parseCorrectionRounds(correction.comments?.nodes || [], acceptanceProfile.ownerLogin);
    const latestCorrection = correctionRounds.at(-1) || null;
    if (latestCorrection && CORRECTION_TERMINAL.has(latestCorrection.status)) return 0;

    let tree;
    try {
      tree = await collectTree({ github: gateGithub, profile: acceptanceProfile, ref: marker.root });
    } catch {
      return 1;
    }
    let state = loadState(paths, issue);
    if (!state || !state.startedAt) {
      state = makeState({ issue, marker, rootTree: tree });
      if (tree.root.fork) {
        const forkRepo = (acceptanceProfile.forkRepos || []).find((repo) => !repo.includes('*'));
        if (forkRepo) {
          state.pushRepo = forkRepo;
          state.prRepo = parseRef(marker.root).repo;
        }
      }
    } else if (!state.startedAt) {
      state.startedAt = new Date(now()).toISOString();
    }
    state.repo = parseRef(issue).repo;
    state.rootRepo = parseRef(marker.root).repo;
    state.prRepo = state.prRepo || state.rootRepo;
    state.branch = correctionBranch(marker);
    state.handoff = handoffFor(settings, state.repo);
    state.verdict = null;
    const pausedFile = path.join(paths.prbotDir, 'PAUSED');
    if (fs.existsSync(pausedFile)) {
      state.paused = true;
      return 1;
    }

    // 1. 认领 / 加载已有修正轮。
    if (latestCorrection && latestCorrection.status !== '修正中' && !state.claimCommentId) {
      state.claimCommentId = latestCorrection.commentId;
      state.round = latestCorrection.round;
    }
    if (!state.claimCommentId) {
      const next = correctionRounds.reduce((acc, round) => Math.max(acc, round.round), 0) + 1;
      if (next > MAX_CORRECTION_ROUNDS) {
        state.correctionRound = next;
        state.stage = 'stop';
      } else {
        state.round = next;
        const claimGate = gateFor({ kind: 'correction', issue, round: next, commentId: null });
        const claim = await gateWrite(
          claimGate,
          {
            type: 'comment.create',
            dedupeKey: `prbot:${issue}:r${next}:claim`,
            repo: state.repo,
            issue: parseRef(issue).number,
            body: formatRoundComment(state, '修正中'),
          },
          { state, sleep, now },
        );
        if (claim.code !== 0) {
          state.gateCode = claim.code;
          state.stage = 'stop';
        } else {
          state.claimCommentId = claim.body?.commentId;
          state.steps.push('认领：发出「[修正机] 第 m 轮：修正中」');
          appendPrbotEvent(paths, { type: 'claimed', issue, root: state.root, item: state.item, sc: [state.sc], repo: state.repo }, { now, profile });
          state.stage = 'assess';
          saveState(paths, state);
        }
      }
    }

    let gate = state.claimCommentId
      ? gateFor({ kind: 'correction', issue, round: state.round, commentId: state.claimCommentId })
      : null;

    // 2–9. 状态机。
    for (let tick = 0; tick < 500; tick += 1) {
      if (fs.existsSync(pausedFile)) state.paused = true;
      state.updatedAt = new Date(now()).toISOString();
      saveState(paths, state);
      const stop = stopReason(state, { now });
      if (stop.stop) {
        if (state.paused === true && !stop.needsHuman) {
          return 1;
        }
        if (stop.reason === 'interrupted-exhausted') {
          state.status = '中断';
          if (gate) {
            try {
              await updateComment({ gate, state, status: '中断', note: 'GitHub 连续失败 5 次，退避用完', sleep, now });
            } catch {
              // 评论写不下去也要停手。
            }
          }
          appendPrbotEvent(
            paths,
            { type: 'interrupted-exhausted', issue, root: state.root, item: state.item, sc: [state.sc], repo: state.repo, reason: 'write-failed', pr: state.pr?.number, prUrl: state.pr?.url },
            { now, profile },
          );
          return 1;
        }
        if (stop.needsHuman) {
          state.status = '需人工处理';
          if (gate) {
            try {
              await updateComment({ gate, state, status: '需人工处理', note: `停止原因：${stop.reason}`, sleep, now });
            } catch {
              // 评论写不下去也要停手。
            }
          }
          appendPrbotEvent(
            paths,
            {
              type: 'needs-human',
              issue,
              root: state.root,
              item: state.item,
              sc: [state.sc],
              repo: state.repo,
              reason: stop.reason,
              detail: state.mainRed ? JSON.stringify(state.mainRed) : state.stopNote,
              pr: state.pr?.number,
              prUrl: state.pr?.url,
            },
            { now, profile },
          );
          return 1;
        }
        return 0;
      }

      if (state.stage === 'stop') {
        state.status = '需人工处理';
        if (gate) await updateComment({ gate, state, status: '需人工处理', note: '修正轮次已用完', sleep, now });
        appendPrbotEvent(paths, { type: 'needs-human', issue, root: state.root, item: state.item, sc: [state.sc], repo: state.repo, reason: 'correction-rounds' }, { now, profile });
        return 1;
      }

      if (state.stage === 'assess') {
        const root = await readIssueState(gateGithub, state.root, acceptanceProfile.ownerLogin);
        const latest = latestRound(root?.rounds || []);
        state.verdict = latest?.status || null;
        if (!latest || latest.status !== '要修') {
          state.stage = 'stop';
          continue;
        }
        let items = parseVerdictItems(latest.body);
        if (!items.length) items = [{ ref: state.item, sc: state.sc }];
        const sameItem = items.filter((item) => item.ref === state.item);
        const must = (sameItem.length ? sameItem : items).filter((item) => item.sc === state.sc || !sameItem.length);
        const treeItems = tree.issues.flatMap((entry) => entry.items);
        state.mustFix = [];
        state.manual = [];
        for (const item of must) {
          const found = treeItems.find((entry) => entry.source === item.ref && entry.sc === item.sc);
          if (found?.manual) state.manual.push({ ref: item.ref, sc: item.sc });
          else state.mustFix.push({ ref: item.ref, sc: item.sc });
        }
        if (!state.mustFix.length) state.mustFix = [{ ref: state.item, sc: state.sc }];
        state.steps.push('评估：从最新裁决取出必修项；人工手测不修');
        state.stage = 'fix';
        continue;
      }

      if (state.stage === 'fix') {
        if ((state.piIterations || 0) >= MAX_PI_ITERATIONS) {
          state.piIterations = MAX_PI_ITERATIONS + 1;
          state.stage = 'stop';
          continue;
        }
        let work = null;
        try {
          work = prepareWorktree({ github: gateGithub, state, profile: acceptanceProfile, run });
          if (work && typeof work.then === 'function') work = await work;
        } catch (error) {
          state.worktreeError = String(error?.message || error);
          state.failureReason = 'worktree-failed';
          state.stage = 'stop';
          continue;
        }
        state.worktree = work.worktree;
        const roundDir = path.join(paths.roundRunDir, 'prbot', `${stateKey(issue)}-r${state.round}`);
        state.piIterations = (state.piIterations || 0) + 1;
        const result = await pi({
          home,
          profile: acceptanceProfile,
          hostConfig: settings,
          roundDir,
          worktree: state.worktree,
          piCommand: piCommandFor(settings),
          prompt: buildPrompt(state),
          env,
          run,
        });
        if (result?.unavailable) {
          appendAlert(paths, {
            kind: 'sandbox-unavailable',
            issue,
            round: state.round,
            reason: '沙箱起不来：bwrap 不可用',
            now,
            profile: acceptanceProfile,
          });
          state.status = '中断';
          if (gate) await updateComment({ gate, state, status: '中断', note: '沙箱起不来，不跑模型', sleep, now });
          return 1;
        }
        if (!result?.ok) {
          state.steps.push(`修复：第 ${state.piIterations} 次 pi 没有正常结束`);
          if ((state.piIterations || 0) >= MAX_PI_ITERATIONS) state.stage = 'stop';
          continue;
        }
        const notes = readNotes(roundDir, result.stdout);
        if (notes.disputes.length) {
          state.disputes.push(...notes.disputes);
          const disputed = new Set(notes.disputes.map((item) => `${item.ref} SC${item.sc}`));
          state.mustFix = state.mustFix.filter((item) => !disputed.has(`${item.ref} SC${item.sc}`));
          state.steps.push('评估：有争议的条目不修，写进轮次评论');
        }
        state.fixed = state.mustFix.map((item) => item.sc);
        const files = await diffFiles({ worktree: state.worktree, state, run });
        const forbidden = repoConfig(settings, state.repo).forbiddenPaths || [];
        const hits = files.filter((file) => matchesForbidden(file, forbidden));
        if (hits.length) {
          state.forbiddenPaths = hits;
          state.stage = 'stop';
          continue;
        }
        state.steps.push('修复：pi 在工作树里写了复现测试和最小修复');
        state.stage = 'preflight';
        continue;
      }

      if (state.stage === 'preflight') {
        const config = repoConfig(settings, state.repo);
        const commands = config.preflight || [];
        if (!commands.length) {
          state.preflightNote = '没有配置预检，跳过';
          state.stage = 'draft';
          continue;
        }
        const roundDir = path.join(paths.roundRunDir, 'prbot', `${stateKey(issue)}-r${state.round}-preflight`);
        const testLock = config.testLock ? path.join(paths.hostDir, 'locks', 'mivo-test.lock') : null;
        if (testLock && !tryAcquireLock(testLock, { now })) {
          state.stage = 'preflight';
          await sleep(30 * 1000);
          continue;
        }
        let result;
        try {
          result = await preflight({
            home,
            profile: acceptanceProfile,
            hostConfig: settings,
            roundDir,
            worktree: state.worktree,
            commands,
            env,
            run,
          });
        } finally {
          if (testLock) releaseLock(testLock);
        }
        if (result?.unavailable) {
          appendAlert(paths, {
            kind: 'sandbox-unavailable',
            issue,
            round: state.round,
            reason: '沙箱起不来：预检不跑',
            now,
            profile: acceptanceProfile,
          });
          state.status = '中断';
          if (gate) await updateComment({ gate, state, status: '中断', note: '沙箱起不来，不跑预检', sleep, now });
          return 1;
        }
        if (!result?.ok) {
          state.rework = (state.rework || 0) + 1;
          state.steps.push(`预检：第 ${state.rework} 次没通过，返工`);
          if (state.rework > MAX_REWORK) state.stage = 'stop';
          else state.stage = 'fix';
          continue;
        }
        state.steps.push('预检：目标仓自己的推送前检查通过');
        state.stage = 'draft';
        continue;
      }

      if (state.stage === 'draft') {
        const bundle = await bundleFactory({ state, worktree: state.worktree, localgit });
        try {
          const pushed = await gateWrite(
            gate,
            {
              type: 'branch.push',
              dedupeKey: `prbot:${issue}:r${state.round}:push:${bundle.headSha}`,
              repo: state.pushRepo,
              branch: state.branch,
              bundlePath: bundle.bundlePath,
            },
            { state, sleep, now },
          );
          if (pushed.code === 4 && pushed.body?.reason === 'secret-found') {
            state.secretFiles = pushed.body.files || [];
            state.stage = 'stop';
            continue;
          }
          if (pushed.code !== 0) {
            state.gateCode = pushed.code;
            if (pushed.code === 1) state.interruptedExhausted = true;
            state.stage = 'stop';
            continue;
          }
          const [owner, name] = state.prRepo.split('/');
          const existing = await gateRead(gate, PR_BY_BRANCH_QUERY, { owner, name, head: state.branch });
          let pr = existing?.repository?.pullRequests?.nodes?.[0];
          if (!pr) {
            const head = state.pushRepo === state.prRepo ? state.branch : `${repoOwner(state.pushRepo)}:${state.branch}`;
            const created = await gateWrite(
              gate,
              {
                type: 'pr.create',
                dedupeKey: `prbot:${issue}:r${state.round}:pr:${bundle.headSha}`,
                repo: state.prRepo,
                head,
                base: 'main',
                draft: true,
                title: `修正：${state.item} SC${state.sc}`,
                body: [
                  `> 修正 PR · 总 issue ${state.root} · 原属 ${state.item}`,
                  '',
                  `任务 issue：${state.root}`,
                  `[验收机] 修正 · 总 ${state.root} · 项 ${state.item} SC${state.sc} · 第 ${state.round} 轮`,
                ].join('\n'),
              },
              { state, sleep, now },
            );
            if (created.code !== 0) {
              state.gateCode = created.code;
              if (created.code === 1) state.interruptedExhausted = true;
              state.stage = 'stop';
              continue;
            }
            pr = { number: created.body.pr, url: created.body.url, headRefOid: bundle.headSha, isDraft: true };
          }
          state.pr = { number: pr.number, url: pr.url, headSha: bundle.headSha, isDraft: true, draftOpenedAt: new Date(now()).toISOString() };

          const handoffNew = repoConfig(settings, state.repo).handoffNew;
          if (Array.isArray(handoffNew) && handoffNew.length) {
            const command = handoffNew.map((item) => String(item).replace(/\{pr\}/g, String(state.pr.number)));
            const generated = await preflight({
              home,
              profile: acceptanceProfile,
              hostConfig: settings,
              roundDir: path.join(paths.roundRunDir, 'prbot', `${stateKey(issue)}-r${state.round}-handoff`),
              worktree: state.worktree,
              commands: [command],
              env,
              run,
            });
            if (generated?.unavailable) {
              appendAlert(paths, {
                kind: 'sandbox-unavailable',
                issue,
                round: state.round,
                reason: '沙箱起不来：handoffNew 不跑',
                now,
                profile: acceptanceProfile,
              });
              state.status = '中断';
              await updateComment({ gate, state, status: '中断', note: '沙箱起不来，不跑 handoffNew', sleep, now });
              return 1;
            }
            if (!generated?.ok) {
              state.failureReason = 'handoff-new-failed';
              state.stage = 'stop';
              continue;
            }
            const gitEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
            const dirty = await run('git', ['-C', state.worktree, 'status', '--porcelain'], { env: gitEnv });
            if (dirty?.code === 0 && String(dirty.stdout || '').trim()) {
              const added = await run('git', ['-C', state.worktree, 'add', '-A'], { env: gitEnv });
              const committed = await run(
                'git',
                ['-C', state.worktree, 'commit', '-q', '-s', '-m', 'chore: handoff files'],
                { env: gitEnv },
              );
              if (added?.code !== 0 || committed?.code !== 0) {
                state.failureReason = 'handoff-commit-failed';
                state.stage = 'stop';
                continue;
              }
              const next = await bundleFactory({ state, worktree: state.worktree, localgit });
              try {
                const pushedAgain = await gateWrite(
                  gate,
                  {
                    type: 'branch.push',
                    dedupeKey: `prbot:${issue}:r${state.round}:handoff:${next.headSha}`,
                    repo: state.pushRepo,
                    branch: state.branch,
                    bundlePath: next.bundlePath,
                  },
                  { state, sleep, now },
                );
                if (pushedAgain.code !== 0) {
                  state.gateCode = pushedAgain.code;
                  state.stage = 'stop';
                  continue;
                }
                state.pr.headSha = next.headSha;
                state.steps.push('Draft：补交接文件后重新打包推送');
              } finally {
                next.cleanup?.();
              }
            }
          }

          state.steps.push('Draft：经写闸推分支、开 Draft PR');
          state.status = 'Draft 已开';
          await updateComment({ gate, state, status: 'Draft 已开', sleep, now });
          appendPrbotEvent(
            paths,
            {
              type: 'draft-opened',
              issue,
              root: state.root,
              item: state.item,
              sc: state.fixed,
              repo: state.prRepo,
              pr: state.pr.number,
              prUrl: state.pr.url,
              headSha: state.pr.headSha,
            },
            { now, profile },
          );
          state.status = '等 CI';
          await updateComment({ gate, state, status: '等 CI', sleep, now });
          state.watchStartedAt = new Date(now()).toISOString();
          state.watchHead = bundle.headSha;
          state.stage = 'watch';
          continue;
        } finally {
          bundle.cleanup?.();
        }
      }

      if (state.stage === 'watch') {
        state.status = '等 CI';
        try {
          const issueData = await gateRead(gate, ISSUE_BODY_QUERY, {
            owner: state.repo.split('/')[0],
            name: state.repo.split('/')[1],
            number: parseRef(state.issue).number,
          });
          if (issueData?.repository?.issue?.state === 'CLOSED') state.issueClosed = true;
        } catch {
          // 读不到就下一拍再试；不因此放行任何写。
        }
        try {
          const rootState = await readIssueState(gateGithub, state.root, acceptanceProfile.ownerLogin);
          const latest = latestRound(rootState?.rounds || []);
          state.verdict = latest?.status || null;
        } catch {
          // 读不到裁决就沿用上一次的。
        }
        let status;
        if (typeof statusProvider === 'function') status = await statusProvider({ state, gate, now });
        else status = (await gateRead(gate, PR_STATUS_QUERY, { owner: state.prRepo.split('/')[0], name: state.prRepo.split('/')[1], number: state.pr.number })).repository?.pullRequest;
        if (!status) {
          state.stage = 'stop';
          continue;
        }
        if (status.headRefOid && status.headRefOid !== state.pr?.headSha) {
          state.pr = { ...state.pr, headSha: status.headRefOid };
          state.watchStartedAt = new Date(now()).toISOString();
        }
        let mainChecks = null;
        if (typeof mainChecksProvider === 'function') {
          mainChecks = await mainChecksProvider({ state, status, gate, now });
        } else {
          const [owner, name] = state.prRepo.split('/');
          const mainData = await gateRead(gate, MAIN_CHECKS_QUERY, { owner, name, branch: 'refs/heads/main' });
          mainChecks = mainRedNames(mainData);
        }
        const decision = await pollDraft({ state, status, mainChecks, now });
        if (decision.action === 'wait') {
          await sleep(WATCH_INTERVAL_MS);
          continue;
        }
        if (decision.action === 'rerun') {
          const rerun = await gateWrite(
            gate,
            {
              type: 'ci.rerun',
              dedupeKey: `prbot:${issue}:r${state.round}:rerun:${decision.fingerprint}`,
              repo: state.prRepo,
              pr: state.pr.number,
              runId: decision.runId,
              headSha: state.pr.headSha,
            },
            { state, sleep, now },
          );
          if (rerun.code !== 0) {
            state.gateCode = rerun.code;
            state.stage = 'stop';
          } else {
            state.steps.push('盯 CI：第一次失败先重跑一次失败 job');
            await updateComment({ gate, state, status: '等 CI', note: '重跑了失败的 job', sleep, now });
            await sleep(WATCH_INTERVAL_MS);
          }
          continue;
        }
        if (decision.action === 'update-branch') {
          const updated = await gateWrite(
            gate,
            {
              type: 'pr.update-branch',
              dedupeKey: `prbot:${issue}:r${state.round}:update:${state.pr.headSha}:${state.conflict}`,
              repo: state.prRepo,
              pr: state.pr.number,
              expectedHeadSha: state.pr.headSha,
              headSha: state.pr.headSha,
            },
            { state, sleep, now },
          );
          if (updated.code !== 0) {
            state.gateCode = updated.code;
            state.stage = 'stop';
          } else {
            state.steps.push(`盯 CI：落后 main，更新分支（第 ${state.conflict} 次）`);
          }
          continue;
        }
        if (decision.action === 'refix') {
          state.status = `再修 ${state.refix}/2`;
          state.steps.push(`再修：第 ${state.refix}/2 轮`);
          await updateComment({ gate, state, status: state.status, sleep, now });
          state.stage = 'fix';
          continue;
        }
        if (decision.action === 'needs-human') {
          state.stage = 'stop';
          state.stopNote = decision.reason;
          if (decision.evidence) {
            state.mainRed = decision.evidence;
            state.steps.push(
              `盯 CI：main 上 ${decision.evidence.check} 也红（${decision.evidence.mainSha || '未知 SHA'}）${decision.evidence.url || ''}`,
            );
          }
          if (state.pr?.url) state.steps.push(`盯 CI：${decision.reason}`);
          continue;
        }
        if (decision.action === 'ready') {
          state.stage = 'ready';
          continue;
        }
      }

      if (state.stage === 'ready') {
        const ready = await gateWrite(
          gate,
          {
            type: 'pr.ready',
            dedupeKey: `prbot:${issue}:r${state.round}:ready:${state.pr.headSha}`,
            repo: state.prRepo,
            pr: state.pr.number,
            headSha: state.pr.headSha,
          },
          { state, sleep, now },
        );
        if (ready.code === 4 && ready.body?.reason === 'ready-precondition') {
          state.stage = 'watch';
          await updateComment({ gate, state, status: '等 CI', note: `还差一点：${ready.body.detail || '检查没全绿'}`, sleep, now });
          continue;
        }
        if (ready.code !== 0) {
          state.gateCode = ready.code;
          state.stage = 'stop';
          continue;
        }
        state.ready = true;
        state.readyAt = new Date(now()).toISOString();
        state.handoff = handoffFor(settings, state.repo);
        state.steps.push('Ready：检查全绿，转 Ready');
        state.status = '已 Ready';
        await updateComment({ gate, state, status: '已 Ready', sleep, now });
        appendPrbotEvent(
          paths,
          {
            type: 'ready',
            issue,
            root: state.root,
            item: state.item,
            sc: state.fixed,
            repo: state.prRepo,
            pr: state.pr.number,
            prUrl: state.pr.url,
            headSha: state.pr.headSha,
            checks: state.lastChecks,
            diff: state.diff || { files: 0, additions: 0, deletions: 0 },
            handoff: state.handoff,
          },
          { now, profile },
        );
        if (state.handoff === 'watcher') writeReadyState(paths, state);
        saveState(paths, state);
        return 0;
      }
    }
    return 1;
  } finally {
    releaseLock(slot.file);
    releaseLock(lockFile);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'run') {
    process.stderr.write('用法：ACCEPTANCE_WATCHER_HOME=<home> node host/prbot.mjs run --issue <owner/repo#n>\n');
    process.exitCode = 1;
    return;
  }
  const at = rest.indexOf('--issue');
  const issue = at === -1 ? undefined : rest[at + 1];
  const home = process.env.ACCEPTANCE_WATCHER_HOME;
  if (!issue || !home) {
    process.stderr.write('需要 ACCEPTANCE_WATCHER_HOME 和 --issue <owner/repo#n>\n');
    process.exitCode = 1;
    return;
  }
  process.exitCode = await runPrbotCorrection({ home, issue, env: process.env });
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
