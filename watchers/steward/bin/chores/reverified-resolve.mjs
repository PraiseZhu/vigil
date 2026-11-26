import { actorKey } from '../discover.mjs';

export function reverifiedCandidates(fact, state, patterns) {
  return (fact.threads ?? []).filter((thread) => {
    if (thread.source !== 'trusted_bot' || ['P0', 'P1', 'P2'].includes(thread.severity)
      || thread.comments.length < 2 || Object.hasOwn(state.p3Replies ?? {}, thread.id)
      || Object.hasOwn(state.p3ClosedThreads ?? {}, thread.id)) return false;
    const root = thread.comments[0];
    const last = thread.comments.at(-1);
    const reviewer = actorKey(root.author);
    if (!reviewer?.startsWith('app/') || actorKey(last.author) !== reviewer
      || !last.id || state.reverifiedThreads?.[thread.id] === last.id || typeof last.body !== 'string') return false;
    const heads = last.body.match(/\b[0-9a-f]{40}\b/gi) ?? [];
    return heads.every((head) => head.toLowerCase() === fact.head.toLowerCase())
      && patterns.some((pattern) => pattern.test(last.body));
  });
}

export async function closeReverifiedThread({ fact, thread, state, app, refresh, dryRun, log }) {
  if (dryRun) {
    log(`${fact.pr} ${thread.id}：将关闭已复核讨论串`);
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
