#!/usr/bin/env node
// 只读盘点：列出该开始的任务和卡住的轮次。不写 GitHub、不写本地缓存、不调模型。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVerdictOnly, loadAcceptanceProfile } from './profile.mjs';
import { RateLimitError, createGithub } from './github.mjs';
import { collectTasks } from './tasks.mjs';
import { createRounds, latestRound } from './rounds.mjs';
import { lastFinal, shouldTrigger, stalledRounds } from './trigger.mjs';
import { hostPaths, readRoundProgress } from '../host/paths.mjs';
import { readRateState, recordHeader, writeRateState } from './rate-budget.mjs';

function nextRoundNumber(rounds) {
  const max = (rounds || []).reduce((acc, round) => Math.max(acc, round.round), 0);
  return max + 1;
}

/**
 * 最新裁决是「通过」、issue 却还开着（而且不是只出裁决的 issue、也不是 watch 档）：
 * 多半是关单那一步没走完（写闸拒了、看板写失败）。trigger 会判「已是最新」不再验，只能提醒人。
 */
export function passedButOpen(task, profile) {
  if (task?.state !== 'open' || task.tier === 'watch') return null;
  if (isVerdictOnly(profile, task.ref)) return null;
  const latest = latestRound(task.rounds);
  if (!latest || latest.status === '验收中') return null;
  const final = lastFinal(task.rounds);
  if (final?.status !== '通过') return null;
  return { issue: task.ref, passedButOpen: true, round: final.round, url: final.url ?? null };
}

/** 宿主进度（#47 SC11）：<home>/state/host/progress 下的宿主活动时间；读不到返回 null。 */
function defaultHostProgress(profile) {
  let paths = null;
  try {
    paths = hostPaths(path.dirname(path.dirname(profile.profilePath)));
  } catch {
    return () => null;
  }
  return (issue, round) => readRoundProgress(paths, issue, round)?.lastActivityAt || null;
}

/** 验收机的 home：profile 文件在 `<home>/config/profile.json`。 */
export function homeOf(profile) {
  return path.dirname(path.dirname(profile.profilePath));
}

/**
 * 把一次响应头的剩余与 reset 记进本地状态（按令牌身份分开，SC9）。
 * 写不下去不影响这次读：判定那边会写成 rate-unknown。
 */
export function rateRecorder(profile) {
  const file = hostPaths(homeOf(profile)).rateState;
  return (sample) => {
    try {
      writeRateState(file, recordHeader(readRateState(file), sample));
    } catch {
      // 记不下就算了，不挡这次读。
    }
  };
}

/**
 * 数这一拍发了几次只读请求（#247 P2-2）：tick 按它记 loop 组件的本小时用量。
 * 只包只读入口（graphql / ownerGraphql），写入不走这里，也不会被算成读。
 */
export function countReads(github, counter = { reads: 0 }) {
  const wrapped = { ...github };
  for (const key of ['graphql', 'ownerGraphql']) {
    if (typeof github?.[key] !== 'function') continue;
    wrapped[key] = (...args) => {
      counter.reads += 1;
      return github[key](...args);
    };
  }
  wrapped.countedReads = counter;
  return wrapped;
}

export async function poll({ github, profile, now = () => Date.now(), hostProgress }) {
  // 只读本地缓存里的 lastProgressAt（模型写的，只作参考）和宿主进度文件；不写缓存、不调 write。
  const { entries } = await pollInventory({ github, profile, now, hostProgress });
  return entries;
}

/**
 * 一拍一次盘点（#247 SC1）：把这一拍拉到的任务清单也交出去，tick 拿它喂给修正轮发现，
 * 不再让 `discoverCorrections` 自己又拉一遍全量盘点。
 * 返回值里的 `reads` 是这一拍真的发了几次只读请求（#247 P2-2）：用量记它，不写字面量。
 */
export async function pollInventory({ github, profile, now = () => Date.now(), hostProgress }) {
  const counted = countReads(github);
  const roundsApi = createRounds({ github: counted, profile, now });
  const hostProgressAt = hostProgress || defaultHostProgress(profile);
  const tasks = await collectTasks(counted, profile);
  const out = [];
  for (const task of tasks) {
    const latest = latestRound(task.rounds);
    const progressAt = roundsApi.lastProgressAt(task.ref, latest?.round, latest);
    const stale = stalledRounds(task, {
      now,
      profile,
      lastProgressAt: progressAt,
      hostProgressAt: latest ? hostProgressAt(task.ref, latest.round) : null,
    });
    if (stale) out.push(stale);
    const decision = shouldTrigger(task, { now, profile });
    if (decision.trigger && task.outOfScope?.length) {
      // 任务树里有名单外的仓：不派发，交给 tick 写提醒。
      out.push({ issue: task.ref, outOfScope: [...task.outOfScope] });
    } else if (decision.trigger) {
      out.push({
        issue: task.ref,
        kind: task.kind,
        tier: task.tier,
        fork: Boolean(task.fork),
        nextRound: nextRoundNumber(task.rounds),
        bodyVersion: task.bodyVersion,
      });
    } else if (decision.reason === 'awaiting-adjudication') {
      // 有争议、还没有裁决结果：宿主起一次只读裁决运行（host/adjudicate.mjs），不开新一轮。
      out.push({ issue: task.ref, adjudicate: true, round: decision.dispute.round, items: decision.dispute.items });
    } else if (!stale) {
      const open = passedButOpen(task, profile);
      if (open) out.push(open);
    }
  }
  return { entries: out, tasks, reads: counted.countedReads.reads };
}

async function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  const withInventory = argv.includes('--with-inventory');
  try {
    const profile = loadAcceptanceProfile();
    const github = createGithub({ profile, onRateLimit: rateRecorder(profile) });
    const { entries, tasks, reads } = await pollInventory({ github, profile });
    if (asJson) {
      const payload = withInventory ? { entries, tasks, reads } : entries;
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    } else if (!entries.length) {
      process.stdout.write('');
    } else {
      for (const entry of entries) {
        if (entry.stale) {
          process.stdout.write(`${entry.issue} 第 ${entry.round} 轮卡住 ${entry.lastProgressAt}\n`);
        } else if (entry.outOfScope) {
          process.stdout.write(`${entry.issue} 任务树里有名单外的仓，不派发：${entry.outOfScope.join(', ')}\n`);
        } else if (entry.passedButOpen) {
          process.stdout.write(`${entry.issue} 第 ${entry.round} 轮已通过但 issue 还开着\n`);
        } else if (entry.adjudicate) {
          process.stdout.write(`${entry.issue} 第 ${entry.round} 轮有争议，等裁决：${entry.items.join('、')}\n`);
        } else {
          process.stdout.write(`${entry.issue} ${entry.kind} 下一轮 ${entry.nextRound} ${entry.bodyVersion}\n`);
        }
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    // 限流（#247 SC6）：退出码 75，让 tick 跳过这一拍，不当成普通失败写 tick-failed。
    process.exitCode = error instanceof RateLimitError ? 75 : 1;
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
const isCli = invoked && here === invoked;
if (isCli) {
  await main();
}
