// Autonomous P3 review-thread closure. Permission errors degrade; they must not fail the poll.
const REPLY_TEXT = '这是一条 P3 级（建议类）反馈，不是阻塞性问题。按 Cindy 仓当前规则，这类建议本轮不安排修复；'
  + '如后续需要可另行处理。讨论到此关闭，不影响本 PR 等待维护者审批。';

export function autoCloseReplyText() {
  return REPLY_TEXT;
}

export function isPermissionError(error) {
  const status = error?.status ?? error?.exitCode ?? error?.code;
  const text = String(error?.message ?? error?.stderr ?? error ?? '');
  return status === 403 || status === '403'
    || /(?:^|\D)403(?:\D|$)|FORBIDDEN|Resource not accessible by integration|insufficient permission|permission denied|not allowed to/i.test(text);
}

export function isAutoCloseEligible(item) {
  const severities = item?.repairPolicy?.severities ?? [];
  return Boolean(item) && item.category === 'reply-resolve'
    && item.repairPolicy?.action === 'reply-only'
    && severities.includes('P3')
    && !severities.some((s) => s === 'P0' || s === 'P1' || s === 'P2')
    && typeof item.threadId === 'string' && item.threadId.length > 0;
}

function commentsHasNextPage(thread) {
  return thread?.commentsHasNextPage === true || thread?.comments?.pageInfo?.hasNextPage === true;
}

export function isThreadAutoCloseEligible(items = [], { commentsHasNextPage: incomplete = false } = {}) {
  if (incomplete) return false;
  if (!Array.isArray(items) || items.length === 0) return false;
  return items.every((item) => isAutoCloseEligible(item));
}

export function partitionAutoClose(fresh = [], { allItems = fresh, threads = [] } = {}) {
  const byThread = new Map();
  for (const item of allItems) {
    if (!item?.threadId) continue;
    const list = byThread.get(item.threadId) ?? [];
    list.push(item);
    byThread.set(item.threadId, list);
  }
  const incomplete = new Set((threads ?? []).filter(commentsHasNextPage).map((thread) => thread.id));
  const closable = new Set();
  for (const [threadId, items] of byThread) {
    if (isThreadAutoCloseEligible(items, { commentsHasNextPage: incomplete.has(threadId) })) {
      closable.add(threadId);
    }
  }
  const eligible = [];
  const remaining = [];
  const seen = new Set();
  for (const item of fresh) {
    if (item.threadId && closable.has(item.threadId)) {
      if (!seen.has(item.threadId)) {
        eligible.push(item);
        seen.add(item.threadId);
      }
    } else remaining.push(item);
  }
  return { eligible, remaining };
}

const replyMutation = 'mutation($tid:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){comment{id}}}';
const resolveMutation = 'mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}';

export function* autoCloseThreads({ eligible = [], previous = {}, ghFn, now }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  const seen = new Set();
  for (const item of eligible) {
    const threadId = item.threadId;
    if (seen.has(threadId) || closedThreads[threadId]) { seen.add(threadId); continue; }
    seen.add(threadId);
    const reply = yield () => {
      try { return ghFn(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${threadId}`, '-f', `body=${autoCloseReplyText()}`]); }
      catch (error) { if (isPermissionError(error)) return { __degraded: true, error }; throw error; }
    };
    if (reply?.__degraded) {
      results.push({ threadId, key: item.key ?? null, degraded: true, reason: 'permission-denied',
        report: 'GitHub 拒绝回复或 resolve（权限不足）。仅在本会话报告，不视为本轮 poll 失败。' });
      continue;
    }
    const resolved = yield () => {
      try { return ghFn(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${threadId}`]); }
      catch (error) { if (isPermissionError(error)) return { __degraded: true, error }; throw error; }
    };
    if (resolved?.__degraded) {
      results.push({ threadId, key: item.key ?? null, degraded: true, reason: 'permission-denied',
        report: 'GitHub 拒绝回复或 resolve（权限不足）。仅在本会话报告，不视为本轮 poll 失败。' });
      continue;
    }
    closedThreads[threadId] = { at: now, key: item.key ?? null, nativeId: item.nativeId ?? null };
    results.push({ threadId, key: item.key ?? null });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads }, closed: results };
}

// A repair session that verified an authorized finding does not hold records it as
// `no-change` with evidence. Leaving that thread open blocks the merge forever while the
// PR fingerprint stays unchanged (Mivo #851, 2026-10-04), so the watcher closes it with
// the session's evidence visible in the reply. Only verified complete results qualify,
// and a code-fix item without evidence stays open.
const THREAD_KEY = /^(?:thread|greptile):(PRRT_[A-Za-z0-9_-]+):/;
export function refutedThreads(result, task) {
  if (result?.schemaVersion !== 2 || result.status !== 'complete' || result.dispatchId !== task?.dispatchId) return [];
  const policy = new Map((task.repairPolicy?.items ?? []).map((item) => [item.key, item]));
  const items = [];
  for (const { key, disposition } of result.feedbackCoverage?.dispositions ?? []) {
    const threadId = THREAD_KEY.exec(key ?? '')?.[1];
    if (disposition !== 'no-change' || !threadId || policy.get(key)?.action !== 'code-fix') continue;
    const evidence = (result.scs ?? []).filter((sc) => sc.status === 'no-change' && sc.feedbackKeys?.includes(key))
      .flatMap((sc) => sc.evidence ?? []).filter((line) => typeof line === 'string' && line.trim());
    if (evidence.length) items.push({ key, threadId, evidence });
  }
  return items;
}
export function refutedReplyText(evidence, dispatchId) {
  const lines = evidence.slice(0, 5).map((line) => '- ' + line.replace(/\/(?:Users|home)\/[^\s'"`]+/g, '<本机路径>').replace(/\s+/g, ' ').slice(0, 300));
  return [
    '**发生了什么**：盯梢修复轮核实了这条必修意见，结论是它在当前 head 上不成立，不需要改代码。',
    '**对本 PR 意味着什么**：这条意见不再阻塞合并；核实依据如下，若之后的提交让问题重新成立，审查会在新 head 上再次提出。',
    '**要不要改代码**：不改。',
    '',
    '核实证据：',
    ...lines,
    '',
    `<!-- cindy-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
}
// Same durable receipt as the P3 closure: `previous.autoClosedThreads[threadId]`. A reply
// that landed before resolve was denied is still recorded so it is never posted twice.
export function* closeRefutedThreads({ items = [], dispatchId, previous = {}, ghFn, now }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  const attempt = (args) => () => {
    try { return ghFn(args); }
    catch (error) { if (isPermissionError(error)) return { __degraded: true }; throw error; }
  };
  for (const item of items) {
    if (closedThreads[item.threadId]) continue;
    const reply = yield attempt(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${item.threadId}`, '-f', `body=${refutedReplyText(item.evidence, dispatchId)}`]);
    if (reply?.__degraded) {
      results.push({ threadId: item.threadId, key: item.key, degraded: true, reason: 'permission-denied' });
      continue;
    }
    const resolved = yield attempt(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${item.threadId}`]);
    closedThreads[item.threadId] = { at: now, key: item.key, reason: 'refuted-authorized-finding', dispatchId,
      ...(resolved?.__degraded ? { resolveDegraded: true } : {}) };
    results.push({ threadId: item.threadId, key: item.key, ...(resolved?.__degraded ? { degraded: true, reason: 'permission-denied' } : {}) });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads }, closed: results };
}
