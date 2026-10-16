import { TRIAGE_REASONS } from './mivo-feedback-policy.mjs';

// Autonomous P2/P3 review-thread closure. No human notification, no session dispatch.
// Eligibility is entirely derived from the existing policy layer:
//   category === 'reply-resolve'  (== feedbackRepairPolicy action 'reply-only')
// which already encodes: trusted source, P2/P3-only, current-head-bound, no code authority.
// Thread membership is tracked via the explicit `threadId` field (set only for
// GraphQL review-thread items), never via `item.source === 'thread'` — Greptile-authored
// thread comments carry `source: 'greptile'`, so gating on `source` would silently skip them.

// The receipt marker keeps this reply out of the watcher's own feedback if the thread is ever reopened.
const REPLY_TEXT = '这是一条 P2 级（建议类）反馈，不是阻塞性问题。按项目当前规则，这类建议本轮不安排修复；'
  + '如后续需要可另行处理。讨论到此关闭，不影响本 PR 合并。\n\n<!-- mivo-watcher-receipt task=auto-close -->';

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
const THREAD_KEY = /^(?:thread|greptile|mivo-review):(PRRT_[A-Za-z0-9_-]+):/;
function evidenceLines(result, key, status) {
  return (result.scs ?? []).filter((sc) => sc.status === status && sc.feedbackKeys?.includes(key))
    .flatMap((sc) => sc.evidence ?? []).filter((line) => typeof line === 'string' && line.trim());
}
function completeCodeFixThreads(result, task, { disposition, scStatus, kind }) {
  if (result?.schemaVersion !== 2 || !['complete', 'waiting-ci'].includes(result.status) || result.dispatchId !== task?.dispatchId) return [];
  const policy = new Map((task.repairPolicy?.items ?? []).map((item) => [item.key, item]));
  const items = [];
  for (const { key, disposition: itemDisposition } of result.feedbackCoverage?.dispositions ?? []) {
    const threadId = THREAD_KEY.exec(key ?? '')?.[1];
    if (itemDisposition !== disposition || !threadId || policy.get(key)?.action !== 'code-fix') continue;
    const evidence = evidenceLines(result, key, scStatus);
    if (evidence.length) items.push({ key, threadId, evidence, kind, triage: TRIAGE_REASONS.has(policy.get(key)?.reason) });
  }
  return items;
}
export function refutedThreads(result, task) {
  return completeCodeFixThreads(result, task, { disposition: 'no-change', scStatus: 'no-change', kind: 'refuted' });
}
export function fixedThreads(result, task) {
  return completeCodeFixThreads(result, task, { disposition: 'fixed', scStatus: 'pass', kind: 'fixed' });
}
// Same comment key, same wording: a reviewer can edit a comment in place, keeping its id.
// Older task files carry no snapshot; they compare as unchanged, as before.
export function sameFeedbackContent(original, current) {
  if (!original || !current) return true;
  if (original.contentHash && current.contentHash) return original.contentHash === current.contentHash;
  if (typeof original.body === 'string' && typeof current.body === 'string') return original.body === current.body;
  return true;
}
// Resolving closes the whole thread, so every open external comment observed on it now must
// belong to the completed task, unedited since the task saw it. A reply added or a comment
// edited while the repair ran keeps the thread open and goes through normal dispatch instead
// of being resolved on evidence written for different words.
export function coveredThreadItems(items = [], observed = [], task = {}) {
  const taskItems = new Map((task?.feedback ?? []).filter((item) => typeof item?.key === 'string').map((item) => [item.key, item]));
  const closeKeys = new Set(items.map((item) => item?.key).filter(Boolean));
  return items.filter((item) => observed
    .filter((other) => other?.threadId === item.threadId && other.actionable !== false)
    .every((other) => {
      const key = `${other.source}:${other.nativeId}`;
      return taskItems.has(key) && closeKeys.has(key) && sameFeedbackContent(taskItems.get(key), other);
    }));
}
function sanitizeEvidence(evidence) {
  return evidence.slice(0, 5).map((line) => '- ' + line.replace(/\/(?:Users|home)\/[^\s'"`]+/g, '<本机路径>').replace(/\s+/g, ' ').slice(0, 300));
}
export function refutedReplyText(evidence, dispatchId) {
  return [
    '**发生了什么**：盯梢修复轮核实了这条 P0/P1 意见，结论是它在当前 head 上不成立，不需要改代码。',
    '**对本 PR 意味着什么**：这条意见不再阻塞合并；核实依据如下，若之后的提交让问题重新成立，服务器审查会在新 head 上再次提出。',
    '**要不要改代码**：不改。',
    '',
    '核实证据：',
    ...sanitizeEvidence(evidence),
    '',
    `<!-- mivo-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
}
// A member's thread the session graded as not needing code (P2/P3, a question, or not reproducible).
export function triagedReplyText(evidence, dispatchId) {
  return [
    '**发生了什么**：盯梢修复轮按仓库统一分级核实了这条意见，结论是本轮不需要改代码（不成立、或属于 P2/P3 建议）。',
    '**对本 PR 意味着什么**：这条讨论不再阻塞合并；核实依据如下。如果你认为判断有误，请点「Unresolve」重新打开这条讨论（只回复不会被处理），盯梢会重新评估。',
    '**要不要改代码**：本轮不改。',
    '',
    '核实依据：',
    ...sanitizeEvidence(evidence),
    '',
    `<!-- mivo-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
}
export function fixedReplyText(evidence, head, dispatchId) {
  const shortHead = typeof head === 'string' && head.length ? head.slice(0, 12) : '';
  return [
    `**发生了什么**：盯梢修复轮确认此意见成立并已修复，修复提交 \`${shortHead}\`。`,
    '**对本 PR 意味着什么**：这条意见已处理，不再阻塞，服务器审查会在新 head 上复核。',
    '**要不要改代码**：已改。',
    '',
    '修复证据：',
    ...sanitizeEvidence(evidence),
    '',
    `<!-- mivo-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
}
// Same durable receipt as the P2/P3 closure: `previous.autoClosedThreads[threadId]`.
export function* closeRefutedThreads({ items = [], dispatchId, previous = {}, ghFn, now, head }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  for (const item of items) {
    if (closedThreads[item.threadId]) continue;
    const body = item.kind === 'fixed' ? fixedReplyText(item.evidence, head, dispatchId)
      : item.triage ? triagedReplyText(item.evidence, dispatchId) : refutedReplyText(item.evidence, dispatchId);
    const reason = item.kind === 'fixed' ? 'fixed-p0-p1' : item.triage ? 'member-thread-no-change' : 'refuted-p0-p1';
    yield () => ghFn(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${item.threadId}`, '-f', `body=${body}`]);
    yield () => ghFn(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${item.threadId}`]);
    closedThreads[item.threadId] = { at: now, key: item.key, reason, dispatchId };
    results.push({ threadId: item.threadId, key: item.key });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads }, closed: results };
}
