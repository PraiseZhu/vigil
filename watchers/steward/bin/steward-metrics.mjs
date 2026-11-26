import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { calculateMetrics, parseFlags, readMetrics, timeWindow } from './metrics.mjs';
import { loadProfile, REPO } from './profile.mjs';

export function main(args, { env = process.env, output = console.log, log = console.error } = {}) {
  try {
    const flags = parseFlags(args, ['since', 'until', 'repo']);
    timeWindow(flags.since, flags.until);
    if (flags.repo && !REPO.test(flags.repo)) throw new Error('--repo 必须是 owner/repo');
    const { stateDir } = loadProfile({ env });
    output(JSON.stringify(calculateMetrics(readMetrics(stateDir), flags)));
    return 0;
  } catch (error) {
    log(`steward-metrics: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
