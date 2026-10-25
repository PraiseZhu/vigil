#!/usr/bin/env node
// 宿主调度器的三条命令：start 认领一轮并给出派发消息；status 只读看进度；abort 结束卡住的一轮。
// 本文件不 spawn 子进程、不触网：读写 GitHub 一律走 github.mjs。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './profile.mjs';
import { createGithub, WriteBusyError, WriteRejectedError } from './github.mjs';
import { collectTasks } from './tasks.mjs';
import { shouldTrigger } from './trigger.mjs';
import { createRounds, latestRound, parseRounds, RoundError } from './rounds.mjs';
import { buildDispatchMessage } from './message.mjs';
import { setAcceptanceFields } from './board.mjs';
import { collectTree } from './collect.mjs';
import { appendAlert, hostPaths } from '../host/paths.mjs';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, NOTHING: 3, REJECTED: 4 });

const ISSUE_PATTERN = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;
const DISPUTED_MARK = '有争议';
const PENDING_MARK = '待裁决';
const ITEM_PATTERN = /([\w.-]+\/[\w.-]+#\d+)\s*SC(\d+)/;

export const ISSUE_COMMENTS_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: 100) {
        nodes {
          id
          databaseId
          body
          createdAt
          updatedAt
          url
          author { login }
        }
      }
    }
  }
}`;

const USAGE = `用法：
  node watchers/acceptance/bin/round.mjs start --issue <owner/repo#n>
  node watchers/acceptance/bin/round.mjs status --issue <owner/repo#n> [--json]
  node watchers/acceptance/bin/round.mjs abort --issue <owner/repo#n> --round <n> --reason <原因>
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function writeUsage(stderr) {
  stderr.write(USAGE);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = new Map();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (typeof arg !== 'string' || !arg.startsWith('--')) {
      throw new UsageError(`无法识别的参数：${arg}`);
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    if (!name) throw new UsageError(`无法识别的参数：${arg}`);
    if (eq !== -1) {
      flags.set(name, body.slice(eq + 1));
    } else if (name === 'json') {
      flags.set(name, true);
    } else {
      const value = rest[i + 1];
      if (value === undefined || String(value).startsWith('--')) {
        throw new UsageError(`缺少 --${name} 的值`);
      }
      flags.set(name, value);
      i += 1;
    }
  }
  return { command, flags };
}

function parseIssueRef(ref) {
  const match = String(ref || '').match(ISSUE_PATTERN);
  if (!match) throw new UsageError(`issue 应为 owner/repo#编号，收到：${ref}`);
  return { owner: match[1], name: match[2], number: Number(match[3]), ref: `${match[1]}/${match[2]}#${match[3]}` };
}

function requireIssue(flags) {
  const raw = flags.get('issue');
  if (raw === undefined || raw === true || raw === '') {
    throw new UsageError('缺少 --issue <owner/repo#编号>');
  }
  return parseIssueRef(raw).ref;
}

function sameIssue(a, b) {
  const left = parseIssueRef(a);
  const right = parseIssueRef(b);
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase() &&
    left.number === right.number
  );
}

function errorExit(error) {
  if (error instanceof WriteRejectedError) return EXIT.REJECTED;
  if (error instanceof WriteBusyError) return EXIT.FAIL;
  return EXIT.FAIL;
}

function report(error, stderr) {
  stderr.write(`${error?.message || error}\n`);
  return errorExit(error);
}

function disputedAndPending(body) {
  const lines = String(body || '').split('\n').slice(1);
  const disputed = [];
  const pending = [];
  for (const line of lines) {
    const hasDispute = line.includes(DISPUTED_MARK);
    const hasPending = line.includes(PENDING_MARK);
    if (!hasDispute && !hasPending) continue;
    const match = ITEM_PATTERN.exec(line);
    const entry = {
      text: line.trim(),
      item: match ? `${match[1]} SC${Number(match[2])}` : null,
    };
    if (hasDispute) disputed.push(entry);
    if (hasPending) pending.push(entry);
  }
  return { disputed, pending };
}

/** 认领用的 home：profile.json 在 <home>/config/ 下。拿不到（测试里的纯对象 profile）就是 null。 */
function homeOf(profile) {
  if (typeof profile?.profilePath !== 'string' || !path.isAbsolute(profile.profilePath)) return null;
  return path.dirname(path.dirname(profile.profilePath));
}

function defaultAlert(profile, now) {
  return (entry) => {
    const home = homeOf(profile);
    if (!home) return;
    appendAlert(hostPaths(home), { ...entry, now, profile });
  };
}

/**
 * 认领成功后看板写「验收中」：总 issue 和任务树里的子 issue（和 close 写「通过」的范围一致）。
 * 写失败不让认领失败：记一条提醒、stderr 留一行，返回没写成的条目。
 */
async function markClaimed({ github, profile, task, started, now, stderr, alert }) {
  const failed = [];
  let targets = [task.ref];
  try {
    const tree = await collectTree({ github, profile, ref: task.ref });
    targets = [tree.root.ref, ...tree.issues.filter((entry) => entry.role !== 'root').map((entry) => entry.ref)];
  } catch (error) {
    failed.push({ ref: task.ref, error: String(error?.message || error) });
    targets = [];
  }
  for (const target of targets) {
    try {
      const { owner, name, number } = parseIssueRef(target);
      await setAcceptanceFields(github, profile, {
        repo: `${owner}/${name}`,
        issue: number,
        acceptance: '验收中',
        round: started.round,
        ref: target,
        root: task.ref,
        dedupeKey: `board-claim:${target}:${started.round}:${started.commentId}`,
      });
    } catch (error) {
      failed.push({ ref: target, error: String(error?.message || error) });
    }
  }
  if (failed.length) {
    const detail = failed.map((entry) => `${entry.ref}：${entry.error}`).join('；');
    stderr.write(`看板「验收中」没写成（认领照常）：${detail}\n`);
    try {
      alert({
        kind: 'board-claim-failed',
        issue: task.ref,
        round: started.round,
        reason: '认领后看板「验收中」没写成',
        detail,
      });
    } catch {
      // 提醒也写不下去就只留 stderr。
    }
  }
  return failed;
}

async function cmdStart({ flags, github, profile, now, stdout, stderr, alert }) {
  const issue = requireIssue(flags);
  const tasks = await collectTasks(github, profile);
  const task = tasks.find((candidate) => sameIssue(candidate.ref, issue));
  if (!task) {
    stderr.write(`不是验收任务：${issue}\n`);
    return EXIT.NOTHING;
  }
  const decision = shouldTrigger(task, { now, profile });
  if (!decision.trigger) {
    stderr.write(`任务 ${task.ref} 现在不该验收${decision.reason ? `（${decision.reason}）` : ''}\n`);
    return EXIT.NOTHING;
  }
  if (task.outOfScope?.length) {
    stderr.write(`任务 ${task.ref} 的任务树里有不在任何名单里的仓，不认领：${task.outOfScope.join(', ')}\n`);
    return EXIT.NOTHING;
  }
  const rounds = createRounds({ github, profile, now });
  let started;
  try {
    started = await rounds.start(task);
  } catch (error) {
    if (error instanceof RoundError && (error.code === 'LOCKED' || error.code === 'IN_PROGRESS')) {
      stderr.write(`任务 ${task.ref} 已有一轮在进行中\n`);
      return EXIT.NOTHING;
    }
    throw error;
  }
  await markClaimed({ github, profile, task, started, now, stderr, alert: alert || defaultAlert(profile, now) });
  const message = buildDispatchMessage({
    issue: task.ref,
    kind: task.kind,
    round: started.round,
    commentId: started.commentId,
    bodyVersion: started.bodyVersion,
  });
  stdout.write(`${message}\n`);
  stdout.write(
    `${JSON.stringify({
      issue: task.ref,
      round: started.round,
      commentId: started.commentId,
      bodyVersion: started.bodyVersion,
    })}\n`,
  );
  return EXIT.OK;
}

async function cmdStatus({ flags, github, profile, now, stdout }) {
  const issue = requireIssue(flags);
  const asJson = Boolean(flags.get('json'));
  const { owner, name, number } = parseIssueRef(issue);
  const data = await github.graphql(ISSUE_COMMENTS_QUERY, { owner, name, number });
  const comments = data?.repository?.issue?.comments?.nodes || [];
  const parsed = parseRounds(comments, profile.ownerLogin);
  const latest = latestRound(parsed);
  const stallMinutes = profile.stallMinutes;
  const rounds = createRounds({ github, profile, now });

  if (!latest) {
    const empty = {
      issue,
      round: null,
      status: null,
      commentId: null,
      startedAt: null,
      finishedAt: null,
      lastProgressAt: null,
      stalled: false,
      stallMinutes,
      disputed: [],
      pending: [],
    };
    if (asJson) stdout.write(`${JSON.stringify(empty)}\n`);
    else stdout.write(`${issue} 还没有验收轮次\n`);
    return EXIT.OK;
  }

  const progressAt = rounds.lastProgressAt(issue, latest.round, latest);
  const stalled =
    latest.status === '验收中' &&
    Boolean(progressAt) &&
    now() - Date.parse(progressAt) > stallMinutes * 60 * 1000;
  const comment =
    comments.find((item) => item.databaseId === latest.commentId) ||
    comments.find((item) => item.id && item.id === latest.nodeId);
  const { disputed, pending } = disputedAndPending(comment?.body);

  const result = {
    issue,
    round: latest.round,
    status: latest.status,
    commentId: latest.commentId,
    startedAt: latest.startedAt ?? null,
    finishedAt: latest.finishedAt ?? null,
    lastProgressAt: progressAt ?? null,
    stalled,
    stallMinutes,
    disputed,
    pending,
  };

  if (asJson) {
    stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const parts = [`${issue} 第 ${result.round} 轮：${result.status}`];
    if (result.lastProgressAt) parts.push(`最近进度 ${result.lastProgressAt}`);
    if (result.stalled) parts.push(`卡住（超过 ${stallMinutes} 分钟没有进度）`);
    stdout.write(`${parts.join('，')}\n`);
  }
  return EXIT.OK;
}

async function cmdAbort({ flags, github, profile, now, stdout, stderr }) {
  const issue = requireIssue(flags);
  const rawRound = flags.get('round');
  const round = Number(rawRound);
  if (rawRound === undefined || rawRound === true || rawRound === '' || !Number.isInteger(round) || round <= 0) {
    stderr.write('abort 需要正整数 --round\n');
    return EXIT.FAIL;
  }
  const reason = flags.get('reason');
  if (typeof reason !== 'string' || !reason.trim()) {
    stderr.write('abort 需要非空的 --reason\n');
    return EXIT.FAIL;
  }
  const rounds = createRounds({ github, profile, now });
  try {
    await rounds.finish(issue, round, '中断', { reason: reason.trim() });
  } catch (error) {
    if (error instanceof RoundError) {
      if (error.code === 'NOT_CURRENT') {
        stderr.write(`${error.message}\n`);
        return EXIT.NOTHING;
      }
      stderr.write(`${error.message}\n`);
      return EXIT.FAIL;
    }
    throw error;
  }
  stdout.write(`${JSON.stringify({ issue, round, status: '中断' })}\n`);
  return EXIT.OK;
}

/**
 * 跑一条 round 命令，返回退出码。测试注入 github/profile/now 和假的 stdout/stderr。
 */
export async function runRound(argv, options = {}) {
  const {
    github,
    profile,
    now = () => Date.now(),
    stdout = process.stdout,
    stderr = process.stderr,
    alert,
  } = options;

  let parsed;
  try {
    parsed = parseArgs(argv || []);
  } catch (error) {
    writeUsage(stderr);
    stderr.write(`${error.message}\n`);
    return EXIT.FAIL;
  }

  if (!['start', 'status', 'abort'].includes(parsed.command)) {
    writeUsage(stderr);
    return EXIT.FAIL;
  }

  const context = { flags: parsed.flags, github, profile, now, stdout, stderr, alert };
  try {
    if (parsed.command === 'start') return await cmdStart(context);
    if (parsed.command === 'status') return await cmdStatus(context);
    return await cmdAbort(context);
  } catch (error) {
    if (error instanceof UsageError) {
      writeUsage(stderr);
      stderr.write(`${error.message}\n`);
      return EXIT.FAIL;
    }
    return report(error, stderr);
  }
}

async function main() {
  let code = EXIT.FAIL;
  try {
    const profile = loadAcceptanceProfile();
    const github = createGithub({ profile });
    code = await runRound(process.argv.slice(2), { github, profile });
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    code = errorExit(error);
  }
  process.exitCode = code;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
const isCli = invoked && here === invoked;
if (isCli) {
  await main();
}
