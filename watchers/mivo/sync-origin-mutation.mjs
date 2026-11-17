// Reproduce the regression evidence from any checkout:
// node watchers/mivo/sync-origin-mutation.mjs
// Mutations run only in a disposable repository copy under _tmp; the source checkout is never edited.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = path.join(repo, '_tmp');
fs.mkdirSync(scratch, { recursive: true });
const copy = fs.mkdtempSync(path.join(scratch, 'sync-origin-mutation-'));
const test = 'watchers/mivo/repair-scope.test.mjs';
const file = 'watchers/mivo/bin/mivo-repair.mjs';
function run(pattern, expectedFailure = null) {
  const result = spawnSync(process.execPath, ['--env-file=watchers/mivo/test.env', '--test', `--test-name-pattern=${pattern}`, test], {
    cwd: copy, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', TMPDIR: path.join(copy, '_tmp') },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  process.stdout.write(output);
  if (result.error || (expectedFailure ? result.status !== 1 || !output.includes(expectedFailure) : result.status !== 0)) {
    throw Error(`Unexpected mutation outcome: exit=${result.status}; expected=${expectedFailure ?? 'pass'}`);
  }
}
try {
  fs.cpSync(path.join(repo, 'watchers'), path.join(copy, 'watchers'), { recursive: true,
    filter: source => !['state', 'deployments', 'node_modules', '_tmp', '__pycache__'].includes(path.basename(source)) });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(copy, 'package.json'));
  fs.mkdirSync(path.join(copy, '_tmp'));
  const target = path.join(copy, file);
  const source = fs.readFileSync(target, 'utf8');
  run('sync main transfer');
  const start = source.indexOf('  const transferred = verifySyncTransfers(');
  const end = source.indexOf('  const localScs =', start);
  if (start < 0 || end < start) throw Error('finalize transfer gate not found');
  fs.writeFileSync(target, source.slice(0, start) + '  const transferred = new Set();\n' + source.slice(end));
  run('sync main transfer finalizes no-change', 'ADJUDICATE_REQUIRED');
  const needle = 'verifySyncTransfers({ currentHead: head, task:';
  if (!source.includes(needle)) throw Error('current-head recheck gate not found');
  fs.writeFileSync(target, source.replace(needle, 'verifySyncTransfers({ task:'));
  run('sync main transfer mixed with another fix', 'main-transfer source is not proven unchanged on main');
  fs.writeFileSync(target, source);
  run('sync main transfer');
  process.stdout.write('PASS: both mutations fail their regressions; restored source passes. Original checkout unchanged.\n');
} finally {
  fs.rmSync(copy, { recursive: true, force: true });
}
