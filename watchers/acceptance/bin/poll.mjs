#!/usr/bin/env node
// 只读盘点：列出该开始的任务和卡住的轮次。不写 GitHub、不写本地缓存、不调模型。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isVerdictOnly, loadAcceptanceProfile } from './profile.mjs';
import { createGithub } from './github.mjs';
import { collectTasks } from './tasks.mjs';
import { createRounds, latestRound } from './rounds.mjs';
import { lastFinal, shouldTrigger, stalledRounds } from './trigger.mjs';
import { hostPaths, readRoundProgress } from '../host/paths.mjs';

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

export async function poll({ github, profile, now = () => Date.now(), hostProgress }) {
  // 只读本地缓存里的 lastProgressAt（模型写的，只作参考）和宿主进度文件；不写缓存、不调 write。
  const roundsApi = createRounds({ github, profile, now });
  const hostProgressAt = hostProgress || defaultHostProgress(profile);
  const tasks = await collectTasks(github, profile);
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
    } else if (!stale) {
      const open = passedButOpen(task, profile);
      if (open) out.push(open);
    }
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const asJson = argv.includes('--json');
  try {
    const profile = loadAcceptanceProfile();
    const github = createGithub({ profile });
    const entries = await poll({ github, profile });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(entries)}\n`);
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
        } else {
          process.stdout.write(`${entry.issue} ${entry.kind} 下一轮 ${entry.nextRound} ${entry.bodyVersion}\n`);
        }
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  }
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
const isCli = invoked && here === invoked;
if (isCli) {
  await main();
}
