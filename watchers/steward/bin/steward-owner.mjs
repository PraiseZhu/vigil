import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadProfile } from './profile.mjs';
import { readOrders, readReceipt } from './outbox.mjs';
import { readFollower } from './followers.mjs';
import { prKey, readPr } from './state.mjs';

const MANAGED = new Set(['要修', '等待中', '等人', '没事']);

export function lookupOwner({ stateDir, pr } = {}) {
  const key = prKey(pr);
  const state = readPr(stateDir, key);
  const classification = state?.classification ?? '不管';
  const follower = readFollower(stateDir, key);
  const orders = readOrders(stateDir).filter((order) => order.pr === key && !readReceipt(stateDir, order.id));
  return {
    managed: state !== null && MANAGED.has(classification),
    state: classification,
    follower: follower ? {
      device: follower.device ?? null, session: follower.session ?? null,
      kind: follower.kind, takeover: follower.takeover === true,
    } : null,
    pending_orders: orders.length,
  };
}

export function parseOwnerArgs(argv) {
  if (argv.length !== 2 || argv[0] !== '--pr') throw new Error('用法：steward-owner --pr <owner/repo#number>');
  return { pr: argv[1] };
}

export function runOwnerCli(argv, { env = process.env, output = console.log, log = console.error } = {}) {
  try {
    const { pr } = parseOwnerArgs(argv);
    const profile = loadProfile({ env });
    output(JSON.stringify(lookupOwner({ stateDir: profile.stateDir, pr })));
    return 0;
  } catch (error) {
    log(`steward-owner: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runOwnerCli(process.argv.slice(2));
}
