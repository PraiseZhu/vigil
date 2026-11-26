import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProfile } from './profile.mjs';
import { appendRound, readRounds } from './round-log.mjs';
import { prKey, readPr, withPrLock, writePr } from './state.mjs';

export async function main(args, { env = process.env, output = console.log, log = console.error } = {}) {
  try {
    if (args.length !== 2 || args[0] !== '--pr') throw new Error('用法：steward-resume.mjs --pr <owner/repo#号>');
    const pr = prKey(args[1]);
    const { stateDir } = loadProfile({ env });
    const resumed = await withPrLock(stateDir, pr, () => {
      const state = readPr(stateDir, pr);
      if (!state) throw new Error('没有找到 PR 状态');
      if (!state.halted) return false;
      const rounds = readRounds(stateDir, pr);
      appendRound(stateDir, pr, { id: `resume:${state.push_sequence ?? 0}:${rounds.length}`, type: 'resume',
        at: new Date().toISOString() });
      writePr(stateDir, pr, { ...state, halted: false });
      return true;
    });
    output(JSON.stringify({ pr, halted: false, resumed }));
    return 0;
  } catch (error) {
    log(`steward-resume: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
