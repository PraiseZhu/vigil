#!/usr/bin/env node
// 只读盘点：列出该开始的任务和卡住的轮次。不写 GitHub、不写本地缓存、不调模型。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './profile.mjs';
import { createGithub } from './github.mjs';
import { collectTasks } from './tasks.mjs';
import { createRounds, latestRound } from './rounds.mjs';
import { shouldTrigger, stalledRounds } from './trigger.mjs';

function nextRoundNumber(rounds) {
  const max = (rounds || []).reduce((acc, round) => Math.max(acc, round.round), 0);
  return max + 1;
}

export async function poll({ github, profile, now = () => Date.now() }) {
  // 只读本地缓存里的 lastProgressAt；不写缓存、不调 write。
  const roundsApi = createRounds({ github, profile, now });
  const tasks = await collectTasks(github, profile);
  const out = [];
  for (const task of tasks) {
    const latest = latestRound(task.rounds);
    const progressAt = roundsApi.lastProgressAt(task.ref, latest?.round, latest);
    const stale = stalledRounds(task, { now, profile, lastProgressAt: progressAt });
    if (stale) out.push(stale);
    const decision = shouldTrigger(task, { now, profile });
    if (decision.trigger) {
      out.push({
        issue: task.ref,
        kind: task.kind,
        tier: task.tier,
        fork: Boolean(task.fork),
        nextRound: nextRoundNumber(task.rounds),
        bodyVersion: task.bodyVersion,
      });
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
