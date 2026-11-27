import { actorKey } from '../discover.mjs';

// keyPattern has exactly one capture group; a P0-P2 thread closes only when every key the reply names is the last
// key of the finding it answers, and the reply names the current head.
function sameFinding(root, last, keyPattern) {
  if (!keyPattern || typeof root.body !== 'string') return false;
  const keys = (text) => [...text.matchAll(new RegExp(keyPattern.source, `${keyPattern.flags.replace('g', '')}g`))]
    .map((match) => match[1]).filter(Boolean);
  const key = keys(root.body).at(-1);
  const claimed = keys(last.body);
  return Boolean(key) && claimed.length > 0 && claimed.every((item) => item === key);
}

export function reverifiedCandidates(fact, state, patterns, { severities = ['P3'], keyPattern = null } = {}) {
  return (fact.threads ?? []).filter((thread) => {
    if (thread.source !== 'trusted_bot' || !severities.includes(thread.severity)
      || thread.comments.length < 2 || Object.hasOwn(state.p3Replies ?? {}, thread.id)
      || Object.hasOwn(state.p3ClosedThreads ?? {}, thread.id)) return false;
    const root = thread.comments[0];
    const last = thread.comments.at(-1);
    const reviewer = actorKey(root.author);
    if (!reviewer?.startsWith('app/') || actorKey(last.author) !== reviewer
      || !last.id || state.reverifiedThreads?.[thread.id] === last.id || typeof last.body !== 'string') return false;
    const heads = last.body.match(/\b[0-9a-f]{40}\b/gi) ?? [];
    if (!heads.every((head) => head.toLowerCase() === fact.head.toLowerCase())
      || !patterns.some((pattern) => pattern.test(last.body))) return false;
    return thread.severity === 'P3' || (heads.length > 0 && sameFinding(root, last, keyPattern));
  });
}

export async function closeReverifiedThread({ fact, thread, state, app, refresh, dryRun, log }) {
  if (dryRun) {
    log(`${fact.pr} ${thread.id}：将关闭已复核${thread.severity === 'P3' ? '' : ` ${thread.severity} `}讨论串`);
    return 'planned';
  }
  const latest = (await refresh(thread))?.at(-1);
  const observed = thread.comments.at(-1);
  if (latest?.id !== observed.id || latest.body !== observed.body || actorKey(latest.author) !== actorKey(observed.author)) {
    log(`${fact.pr} ${thread.id}：最后一条复核回复已变化，不关闭`);
    return 'held';
  }
  await app.resolveThread(thread.id);
  state.reverifiedThreads = { ...state.reverifiedThreads, [thread.id]: latest.id };
  return 'closed';
}
