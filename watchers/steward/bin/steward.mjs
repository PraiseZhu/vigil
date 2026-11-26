import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { discover } from './discover.mjs';
import { readFacts, unknown } from './facts.mjs';
import { createGithubClient } from './github.mjs';
import { loadProfile } from './profile.mjs';
import { appendRound } from './round-log.mjs';
import { chores } from './stages/chores.mjs';
import { coverage } from './stages/coverage.mjs';
import { guard } from './stages/guard.mjs';
import { readPr, withPrLock, writePr } from './state.mjs';

function observe(directory, facts, observedAt) {
  if (['未知', '不管'].includes(facts.classification)) return;
  const previous = readPr(directory, facts.pr);
  let pushSequence = previous?.push_sequence ?? 0;
  if (previous?.head && previous.head !== facts.head) {
    pushSequence += 1;
    appendRound(directory, facts.pr, {
      id: `push:${pushSequence}:${previous.head}:${facts.head}`,
      type: 'push', at: observedAt,
      before_head: previous.head, after_head: facts.head,
      before_classification: previous.classification,
      before_required_checks: previous.required_checks, after_required_checks: facts.requiredChecks,
    });
  }
  writePr(directory, facts.pr, {
    ...previous, head: facts.head, classification: facts.classification,
    required_checks: facts.requiredChecks, observed_at: observedAt, push_sequence: pushSequence,
  });
}

export async function runSteward({ command, dryRun = false, profile, client, log = console.error, now = () => new Date() }) {
  if (command === 'tick') log('发现');
  const discovery = await discover(client, profile);
  if (command === 'tick') log('事实');
  const facts = [];
  const branchRules = new Map();
  for (const pr of discovery.prs) {
    const read = () => readFacts(client, profile, pr, branchRules);
    if (command !== 'tick' || dryRun || pr.ignored.length) {
      facts.push(await read());
      continue;
    }
    try {
      facts.push(await withPrLock(profile.stateDir, pr.pr, async () => {
        const current = await read();
        observe(profile.stateDir, current, now().toISOString());
        return current;
      }));
    } catch (error) {
      facts.push(unknown(pr, error));
    }
  }
  if (command === 'tick') {
    const context = { profile, client, facts, dryRun, log, now };
    await chores(context);
    await coverage(context);
    await guard(context);
  }
  return {
    prs: facts,
    unknown: facts.filter((fact) => fact.classification === '未知').length,
    discoveryErrors: discovery.errors,
  };
}

export async function main(args, { env = process.env, client, output = console.log, log = console.error } = {}) {
  try {
    const [command, flag, extra] = args;
    if (extra !== undefined || (command !== 'scan' && command !== 'tick')
      || (flag !== undefined && (command !== 'tick' || flag !== '--dry-run'))) {
      throw new Error('用法：steward.mjs scan | tick [--dry-run]');
    }
    const profile = loadProfile({ env });
    const result = await runSteward({ command, dryRun: flag === '--dry-run', profile, client: client ?? createGithubClient(profile.github, { env }), log });
    output(JSON.stringify(result));
    return 0;
  } catch (error) {
    log(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
