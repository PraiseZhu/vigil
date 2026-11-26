import { actorKey } from '../discover.mjs';

export function replyAllowed(settings) {
  return typeof settings.followerLogin === 'string' && /^[a-z0-9][a-z0-9-]*$/i.test(settings.followerLogin)
    && (settings.replyLogin === undefined || (typeof settings.replyLogin === 'string'
      && settings.replyLogin.toLowerCase() === settings.followerLogin.toLowerCase()));
}

export function p3Candidates(fact, state, settings) {
  return (fact.threads ?? []).filter((thread) => thread.source === 'trusted_bot' && thread.severity === 'P3'
    && !Object.hasOwn(state.p3ClosedThreads ?? {}, thread.id)
    && (thread.comments.length === 1 || Object.hasOwn(state.p3Replies ?? {}, thread.id)
      || thread.comments.some((comment) => actorKey(comment.author) === settings.followerLogin.toLowerCase()
        && comment.body === settings.reply)));
}

export async function closeP3Thread({ fact, thread, state, settings, replyClient, app, refresh, dryRun, log }) {
  const root = thread.comments[0];
  const follower = settings.followerLogin.toLowerCase();
  const recorded = state.p3Replies?.[thread.id];
  const ownReply = (comment) => actorKey(comment.author) === follower && comment.body === settings.reply;
  let reply = recorded ?? thread.comments.slice(1).find(ownReply)?.databaseId;
  const canClose = (comments) => comments.at(-1)?.databaseId === reply && ownReply(comments.at(-1));
  function held() {
    log(`${fact.pr} ${thread.id}：总管回复不再是已确认的最后一句，不关闭`);
    return 'held';
  }
  const hasId = (id) => Number.isSafeInteger(id) && id > 0;
  if (!hasId(root.databaseId) || (reply !== undefined && !hasId(reply))) return 'held';
  if (reply !== undefined && !canClose(thread.comments)) return held();
  if (dryRun) {
    log(`${fact.pr} ${thread.id}：将${reply === undefined ? '回复并' : ''}关闭 P3 讨论串`);
    return 'planned';
  }
  let comments = await refresh(thread);
  if (!comments) return held();
  if (reply === undefined) {
    const existing = comments.slice(1).find(ownReply);
    if (existing) {
      reply = existing.databaseId;
      if (!hasId(reply)) return held();
    } else {
      if (comments.length !== 1) return held();
      const posted = await replyClient.replyToThread(fact.repo, fact.number, root.databaseId, settings.reply);
      if (!hasId(posted?.id)) throw new Error('P3 回复未返回评论 ID');
      reply = posted.id;
      state.p3Replies = { ...state.p3Replies, [thread.id]: reply };
      comments = await refresh(thread);
    }
  }
  if (!comments || !canClose(comments)) return held();
  await app.resolveThread(thread.id);
  state.p3ClosedThreads = { ...state.p3ClosedThreads, [thread.id]: true };
  if (state.p3Replies && Object.hasOwn(state.p3Replies, thread.id)) delete state.p3Replies[thread.id];
  return 'closed';
}
