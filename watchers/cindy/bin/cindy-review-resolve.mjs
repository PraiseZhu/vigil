// Autonomous P3 review-thread closure. Permission errors degrade; they must not fail the poll.
const REPLY_TEXT = '这是一条 P2/P3 级（建议类）反馈，不是阻塞性问题。按 Cindy 仓当前规则，这类建议本轮不安排修复；'
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
    && severities.some((s) => s === 'P2' || s === 'P3')
    && !severities.some((s) => s === 'P0' || s === 'P1')
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

// A denied reply or resolve degrades to a report instead of failing the poll. gh may answer synchronously
// (tests, legacy driver) or with a promise (async driver), so both kinds of failure are mapped.
const permissionGuarded = (ghFn, args) => () => {
  const degrade = (error) => { if (isPermissionError(error)) return { __degraded: true, error }; throw error; };
  try {
    const value = ghFn(args);
    return typeof value?.then === 'function' ? value.catch(degrade) : value;
  } catch (error) { return degrade(error); }
};

export function* autoCloseThreads({ eligible = [], previous = {}, ghFn, now }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  const seen = new Set();
  for (const item of eligible) {
    const threadId = item.threadId;
    if (seen.has(threadId) || closedThreads[threadId]) { seen.add(threadId); continue; }
    seen.add(threadId);
    const reply = yield permissionGuarded(ghFn, ['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${threadId}`, '-f', `body=${autoCloseReplyText()}`]);
    if (reply?.__degraded) {
      results.push({ threadId, key: item.key ?? null, degraded: true, reason: 'permission-denied',
        report: 'GitHub 拒绝回复或 resolve（权限不足）。仅在本会话报告，不视为本轮 poll 失败。' });
      continue;
    }
    const resolved = yield permissionGuarded(ghFn, ['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${threadId}`]);
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
    if (evidence.length) items.push({ key, threadId, evidence, kind, triage: policy.get(key)?.reason === 'review-thread-triage' });
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
// Every open external comment on the thread must belong to the task, unedited since the task
// saw it; otherwise evidence written for other words would resolve it.
// Comments the task held as reply-only (P2/P3) need an answer, not a fix: a result that gave them
// a no-change disposition with evidence covers them, so a thread mixing a fixed P1 and an
// answered P2 can close. Without that result only fixed or refuted items count.
function answeredReplyOnlyKeys(result, task) {
  if (!result || result.dispatchId !== task?.dispatchId) return new Set();
  const policy = new Map((task.repairPolicy?.items ?? []).map((item) => [item.key, item]));
  const keys = new Set();
  for (const { key, disposition } of result.feedbackCoverage?.dispositions ?? []) {
    if (!key || disposition !== 'no-change' || !policy.has(key) || policy.get(key)?.action === 'code-fix') continue;
    if (evidenceLines(result, key, 'no-change').length) keys.add(key);
  }
  return keys;
}
export function coveredThreadItems(items = [], observed = [], task = {}, result = null) {
  const taskItems = new Map((task?.feedback ?? []).filter((item) => typeof item?.key === 'string').map((item) => [item.key, item]));
  const closeKeys = new Set(items.map((item) => item?.key).filter(Boolean));
  const answered = answeredReplyOnlyKeys(result, task);
  return items.filter((item) => observed
    .filter((other) => other?.threadId === item.threadId && other.actionable !== false)
    .every((other) => {
      const key = `${other.source}:${other.nativeId}`;
      return taskItems.has(key) && (closeKeys.has(key) || answered.has(key)) && sameFeedbackContent(taskItems.get(key), other);
    }));
}
// A thread from a maintainer, the author or a review app that the session graded as not needing code.
export function triagedReplyText(evidence, dispatchId) {
  const lines = evidence.slice(0, 5).map((line) => '- ' + line.replace(/\/(?:Users|home)\/[^\s'"`]+/g, '<本机路径>').replace(/\s+/g, ' ').slice(0, 300));
  return [
    '**发生了什么**：盯梢修复轮按仓库统一分级核实了这条意见，结论是本轮不需要改代码（不成立、或属于建议）。',
    '**对本 PR 意味着什么**：这条讨论不再阻塞合并；核实依据如下。如果你认为判断有误，请点「Unresolve」重新打开这条讨论（只回复不会被处理）；盯梢会重新评估，之后不再自动关闭它。',
    '**要不要改代码**：本轮不改。',
    '',
    '核实依据：',
    ...lines,
    '',
    `<!-- cindy-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
}
export function fixedReplyText(evidence, head, dispatchId) {
  const shortHead = typeof head === 'string' && head.length ? head.slice(0, 12) : '';
  const lines = evidence.slice(0, 5).map((line) => '- ' + line.replace(/\/(?:Users|home)\/[^\s'"`]+/g, '<本机路径>').replace(/\s+/g, ' ').slice(0, 300));
  return [
    `**发生了什么**：盯梢修复轮确认此意见成立并已修复，修复提交 \`${shortHead}\`。`,
    '**对本 PR 意味着什么**：这条意见已处理，不再阻塞。',
    '**要不要改代码**：已改。',
    '',
    '修复证据：',
    ...lines,
    '',
    `<!-- cindy-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
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
export function* closeRefutedThreads({ items = [], dispatchId, previous = {}, ghFn, now, head }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const results = [];
  const attempt = (args) => permissionGuarded(ghFn, args);
  for (const item of items) {
    // The receipt covers one disposition. A thread reopened and handled again by a later task
    // carries that task's dispatchId and is answered again; the same task never posts twice.
    const itemDispatchId = item.dispatchId ?? dispatchId;
    const receipt = closedThreads[item.threadId];
    if (receipt && (!receipt.dispatchId || receipt.dispatchId === itemDispatchId)) continue;
    const body = item.kind === 'fixed' ? fixedReplyText(item.evidence, head, itemDispatchId)
      : item.triage ? triagedReplyText(item.evidence, itemDispatchId) : refutedReplyText(item.evidence, itemDispatchId);
    const reply = yield attempt(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${item.threadId}`, '-f', `body=${body}`]);
    if (reply?.__degraded) {
      results.push({ threadId: item.threadId, key: item.key, degraded: true, reason: 'permission-denied' });
      continue;
    }
    const resolved = yield attempt(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${item.threadId}`]);
    closedThreads[item.threadId] = { at: now, key: item.key, reason: item.kind === 'fixed' ? 'fixed-authorized-finding' : item.triage ? 'review-thread-no-change' : 'refuted-authorized-finding', dispatchId: itemDispatchId,
      ...(resolved?.__degraded ? { resolveDegraded: true } : {}) };
    results.push({ threadId: item.threadId, key: item.key, ...(resolved?.__degraded ? { degraded: true, reason: 'permission-denied' } : {}) });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads }, closed: results };
}
