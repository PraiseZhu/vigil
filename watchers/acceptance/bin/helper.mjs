#!/usr/bin/env node
// 验收会话的 helper（#46）：pi 只调这一条命令，所有写操作都经 github.write。
// 退出码：0 成功；1 其他失败；3 认领检查没过；4 写闸拒绝；5 本地扫到密钥（不推）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './profile.mjs';
import { createGithub, WriteBusyError, WriteRejectedError } from './github.mjs';
import { createRounds, latestRound, parseRef, parseRounds, RoundError } from './rounds.mjs';
import { setAcceptanceFields } from './board.mjs';
import { collectTree } from './collect.mjs';
import { runClose } from './close.mjs';
import { runCorrect } from './correct.mjs';
import { runPush, sessionPath, writeNeedsHuman } from './push.mjs';
import { runVerdict } from './verdict.mjs';

export const EXIT = Object.freeze({ OK: 0, FAIL: 1, CLAIM: 3, REJECTED: 4, SECRET: 5 });

const COMMANDS = ['collect', 'progress', 'verdict', 'close', 'correct', 'push', 'board', 'done'];
const NEEDS_ROUND = new Set(['progress', 'verdict', 'close', 'correct', 'push', 'board', 'done']);
const ISSUE_PATTERN = /^([^/\s]+)\/([^#\s]+)#(\d+)$/;
const ACCEPTANCE_VALUES = new Set(['验收中', '要修', '修正中', '通过']);
export const COMMENTS_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      body
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
  node watchers/acceptance/bin/helper.mjs <collect|progress|verdict|close|correct|push|board|done> --issue <owner/repo#号> [--round <n>] [...]

  collect   --issue <ref>
  progress  --issue <ref> --round <n>
  verdict   --issue <ref> --round <n> --file <verdict.json> [--status 通过|要修]
  close     --issue <ref> --round <n> --verified <verified.json>
  correct   --issue <ref> --round <n> --item "<ref> SC<k>" --why <原因> [--title <标题>]
  push      --issue <ref> --round <n> --repo <owner/repo> --branch acceptance/<总>-<出处>-sc<k> --worktree <目录> [--base origin/main]
  board     --issue <ref> --round <n> --target <all|ref> --acceptance <验收中|要修|修正中|通过> [--verdict-url <url>]
  done      --issue <ref> --round <n>
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
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
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || String(value).startsWith('--')) {
      throw new UsageError(`缺少 --${name} 的值`);
    }
    flags.set(name, value);
    i += 1;
  }
  return { command, flags };
}

function requireIssue(flags) {
  const raw = flags.get('issue');
  if (typeof raw !== 'string' || !ISSUE_PATTERN.test(raw)) {
    throw new UsageError('缺少 --issue <owner/repo#号>');
  }
  const { repo, number } = parseRef(raw);
  return `${repo}#${number}`;
}

function requireRound(flags) {
  const raw = flags.get('round');
  const round = Number(raw);
  if (!Number.isInteger(round) || round <= 0) throw new UsageError('缺少正整数 --round <n>');
  return round;
}

function optionalRound(flags) {
  const raw = flags.get('round');
  if (raw === undefined) return null;
  return requireRound(flags);
}

/** 写闸拒绝/忙的时候尽力把这一轮标成「中断」；失败就算了。 */
async function bestEffortInterrupt({ github, profile, now, ref, n, reason }) {
  if (!ref || !Number.isInteger(n)) return;
  try {
    const rounds = createRounds({ github, profile, now });
    await rounds.finish(ref, n, '中断', { reason });
  } catch {
    // 认领检查本身可能就不过：这时候没有可标的中断。
  }
}

function exitCodeFor(error) {
  if (error instanceof WriteRejectedError) return EXIT.REJECTED;
  if (error instanceof WriteBusyError) return EXIT.FAIL;
  if (error instanceof RoundError && (error.code === 'NOT_CURRENT' || error.code === 'NOT_FOUND')) {
    return EXIT.CLAIM;
  }
  return EXIT.FAIL;
}

async function cmdProgress({ github, profile, ref, n, now, stdout }) {
  const rounds = createRounds({ github, profile, now });
  await rounds.check(ref, n);
  const stamp = await rounds.progress(ref, n);
  stdout.write(`${stamp}\n`);
  return EXIT.OK;
}

async function cmdBoard({ github, profile, ref, n, flags, now, stdout }) {
  const rounds = createRounds({ github, profile, now });
  const current = await rounds.check(ref, n);
  const acceptance = flags.get('acceptance');
  if (typeof acceptance !== 'string' || !ACCEPTANCE_VALUES.has(acceptance)) {
    throw new UsageError('board 需要 --acceptance <验收中|要修|修正中|通过>');
  }
  const verdictUrl = flags.get('verdict-url') || current.url;
  const target = flags.get('target');
  let targets;
  if (target === undefined || target === 'root') {
    targets = [ref];
  } else if (target === 'all') {
    const tree = await collectTree({ github, profile, ref });
    targets = [tree.root.ref, ...tree.issues.filter((entry) => entry.role !== 'root').map((entry) => entry.ref)];
  } else {
    const { repo, number } = parseRef(target);
    targets = [`${repo}#${number}`];
  }

  for (const one of targets) {
    const { repo, number } = parseRef(one);
    await setAcceptanceFields(github, profile, {
      repo,
      issue: number,
      acceptance,
      verdictUrl,
      round: n,
      ref: one,
    });
  }
  stdout.write(`${JSON.stringify({ target: target || 'root', acceptance, verdictUrl, issues: targets })}\n`);
  return EXIT.OK;
}

async function cmdDone({ github, profile, ref, n, now, stdout, stderr }) {
  const { owner, name, number } = parseRef(ref);
  const data = await github.graphql(COMMENTS_QUERY, { owner, name, number });
  const comments = data?.repository?.issue?.comments?.nodes || [];
  const rounds = parseRounds(comments, profile.ownerLogin);
  const latest = latestRound(rounds);
  if (!latest || latest.round !== n || !['通过', '要修'].includes(latest.status)) {
    const actual = latest ? `第 ${latest.round} 轮（${latest.status}）` : '还没有轮次';
    const prefix = latest && latest.round === n ? `第 ${n} 轮还没写裁决` : '认领检查失败';
    stderr.write(`${prefix}：期望第 ${n} 轮（通过或要修），实际${actual}\n`);
    return EXIT.CLAIM;
  }
  const file = sessionPath(profile, ref);
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    existing = {};
  }
  const merged = { ...existing, round: n, doneAt: new Date(now()).toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2));
  fs.renameSync(tmp, file);
  stdout.write(`第 ${n} 轮结束\n`);
  return EXIT.OK;
}

/**
 * 跑一条 helper 命令，返回退出码。测试注入 github/profile/now/stdout/stderr/git。
 */
export async function runHelper(argv, options = {}) {
  const {
    github,
    profile,
    now = () => Date.now(),
    stdout = process.stdout,
    stderr = process.stderr,
    git,
  } = options;

  let command;
  let flags;
  let ref = null;
  let n = null;

  try {
    const parsed = parseArgs(argv || []);
    command = parsed.command;
    flags = parsed.flags;
    if (!COMMANDS.includes(command)) {
      stderr.write(USAGE);
      throw new UsageError(`未知命令：${command ?? '(空)'}`);
    }
    ref = requireIssue(flags);
    n = command === 'collect' ? optionalRound(flags) : requireRound(flags);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n`);
      return EXIT.FAIL;
    }
    throw error;
  }

  const context = { github, profile, ref, n, flags, now, stdout, stderr, git };
  try {
    switch (command) {
      case 'collect': {
        const tree = await collectTree({ github, profile, ref });
        stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
        return EXIT.OK;
      }
      case 'progress':
        return await cmdProgress(context);
      case 'verdict':
        await runVerdict({ github, profile, ref, n, file: flags.get('file'), statusFlag: flags.get('status'), now, stdout });
        return EXIT.OK;
      case 'close':
        return await runClose(context);
      case 'correct':
        return await runCorrect(context);
      case 'push':
        return await runPush({ github, profile, ref, n, flags, now, stdout, git });
      case 'board':
        return await cmdBoard(context);
      default:
        return await cmdDone(context);
    }
  } catch (error) {
    const code = exitCodeFor(error);
    stderr.write(`${error?.message || error}\n`);
    if (error instanceof WriteRejectedError) {
      if (error.reason === 'secret-found') {
        // 写闸在沙箱外扫到密钥：按 SC7 记「需人工处理」，不标中断（push 自己也会记，这里去重）。
        try {
          writeNeedsHuman(profile, ref, n, { reason: 'secret-found', files: [] });
        } catch {
          // 记不下来也要停手：退出码 4 本身就是停手信号。
        }
      } else {
        await bestEffortInterrupt({
          github,
          profile,
          now,
          ref,
          n,
          reason: `写闸拒绝：${error.reason ?? error.exitCode ?? '未给原因'}`,
        });
      }
      return EXIT.REJECTED;
    }
    if (error instanceof WriteBusyError) {
      await bestEffortInterrupt({ github, profile, now, ref, n, reason: '写闸忙' });
      return code;
    }
    return code;
  }
}

async function main() {
  let code = EXIT.FAIL;
  try {
    const profile = loadAcceptanceProfile();
    const github = createGithub({ profile });
    code = await runHelper(process.argv.slice(2), { github, profile });
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    code = exitCodeFor(error);
  }
  process.exitCode = code;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
const isCli = invoked && here === invoked;
if (isCli) {
  await main();
}
