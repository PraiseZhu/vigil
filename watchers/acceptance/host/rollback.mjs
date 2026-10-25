#!/usr/bin/env node
// 回滚（#47 SC4）：停掉循环之后，把还在「验收中」的轮次全部 abort 成「中断」。
// 只看 <roundsDir> 里登记着的运行中轮次；每条都经 bin/round.mjs abort（经写闸 exec）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { createGithub } from '../bin/github.mjs';
import { runRound } from '../bin/round.mjs';
import { hostPaths } from './paths.mjs';
import { run as procRun } from './proc.mjs';
import { readRegistry } from './tick.mjs';

export const ROLLBACK_REASON = '回滚：手动停用';

function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

/** 逐条 abort，返回 [{issue, round, code}]。单条失败不影响其余。 */
export async function rollback({ home, env = process.env, now = () => Date.now(), root } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('rollback 需要绝对路径的 home');
  const repoRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const paths = hostPaths(home);
  const profile = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
  const hostProfile = {
    ...profile,
    writeCommand: [
      process.execPath,
      path.join(repoRoot, 'watchers', 'acceptance', 'host', 'write-gate.mjs'),
      'exec',
      '--home',
      home,
    ],
  };
  const github = createGithub({ profile: hostProfile, run: procRun });
  const out = sink();
  const err = sink();
  const results = [];
  for (const record of readRegistry(paths)) {
    const code = await runRound(
      ['abort', '--issue', record.issue, '--round', String(record.round), '--reason', ROLLBACK_REASON],
      { github, profile: hostProfile, now, stdout: out, stderr: err },
    );
    results.push({ issue: record.issue, round: record.round, code });
  }
  return results;
}

async function main() {
  const home = process.env.ACCEPTANCE_WATCHER_HOME;
  if (!home) {
    process.stderr.write('需要 ACCEPTANCE_WATCHER_HOME\n');
    process.exitCode = 1;
    return;
  }
  const results = await rollback({ home, env: process.env });
  if (results.length === 0) {
    process.stdout.write('没有在跑的轮次\n');
    return;
  }
  let failed = 0;
  for (const entry of results) {
    if (entry.code === 0) {
      process.stdout.write(`${entry.issue} 第 ${entry.round} 轮已标中断\n`);
    } else {
      failed += 1;
      process.stderr.write(`${entry.issue} 第 ${entry.round} 轮中断失败（退出码 ${entry.code}）\n`);
    }
  }
  process.exitCode = failed === 0 ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main();
}
