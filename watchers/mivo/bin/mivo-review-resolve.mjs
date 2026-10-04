// Autonomous P2/P3 review-thread closure. No human notification, no session dispatch.
// Eligibility is entirely derived from the existing policy layer:
//   category === 'reply-resolve'  (== feedbackRepairPolicy action 'reply-only')
// which already encodes: trusted source, P2/P3-only, current-head-bound, no code authority.
// Thread membership is tracked via the explicit `threadId` field (set only for
// GraphQL review-thread items), never via `item.source === 'thread'` — Greptile-authored
// thread comments carry `source: 'greptile'`, so gating on `source` would silently skip them.

const REPLY_TEXT = '这是一条 P2 级（建议类）反馈，不是阻塞性问题。按项目当前规则，这类建议本轮不安排修复；'
  + '如后续需要可另行处理。讨论到此关闭，不影响本 PR 合并。';

export function autoCloseReplyText() {
  return REPLY_TEXT;
}

export function isAutoCloseEligible(item) {
  return Boolean(item) && item.category === 'reply-resolve'
    && item.repairPolicy?.action === 'reply-only'
    && typeof item.threadId === 'string' && item.threadId.length > 0;
}

// Splits `fresh` into items this watcher will resolve on GitHub directly (never
// dispatched to a session) and the remainder that still flows through normal dispatch.
export function partitionAutoClose(fresh = []) {
  const eligible = [];
  const remaining = [];
  for (const item of fresh) (isAutoCloseEligible(item) ? eligible : remaining).push(item);
  return { eligible, remaining };
}

const replyMutation = 'mutation($tid:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$tid, body:$body}){comment{id}}}';
const resolveMutation = 'mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}';

// Idempotent: `previous.autoClosedThreads[threadId]` is the durable receipt. Re-runs
// (retries, next poll before persistState lands) skip network calls for threads already closed.
export function* autoCloseThreads({ eligible = [], previous = {}, ghFn, now }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  const seen = new Set();
  for (const item of eligible) {
    const threadId = item.threadId;
    if (seen.has(threadId) || closedThreads[threadId]) { seen.add(threadId); continue; }
    seen.add(threadId);
    yield () => ghFn(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${threadId}`, '-f', `body=${autoCloseReplyText()}`]);
    yield () => ghFn(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${threadId}`]);
    closedThreads[threadId] = { at: now, key: item.key ?? null, nativeId: item.nativeId ?? null };
    results.push({ threadId, key: item.key ?? null });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads }, closed: results };
}

// A repair session that verified an authorized P0/P1 thread does not hold records it as
// `no-change` with evidence. Leaving that thread open blocks the merge forever while the
// PR fingerprint stays unchanged (2026-10-04 #851), so the watcher closes it with the
// session's evidence visible in the reply. Only verified complete results qualify, and
// a code-fix item without evidence stays open.
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
    '**发生了什么**：盯梢修复轮核实了这条 P0/P1 意见，结论是它在当前 head 上不成立，不需要改代码。',
    '**对本 PR 意味着什么**：这条意见不再阻塞合并；核实依据如下，若之后的提交让问题重新成立，服务器审查会在新 head 上再次提出。',
    '**要不要改代码**：不改。',
    '',
    '核实证据：',
    ...lines,
    '',
    `<!-- mivo-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
}
// Same durable receipt as the P2/P3 closure: `previous.autoClosedThreads[threadId]`.
export function* closeRefutedThreads({ items = [], dispatchId, previous = {}, ghFn, now }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  for (const item of items) {
    if (closedThreads[item.threadId]) continue;
    yield () => ghFn(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${item.threadId}`, '-f', `body=${refutedReplyText(item.evidence, dispatchId)}`]);
    yield () => ghFn(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${item.threadId}`]);
    closedThreads[item.threadId] = { at: now, key: item.key, reason: 'refuted-p0-p1', dispatchId };
    results.push({ threadId: item.threadId, key: item.key });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads }, closed: results };
}
