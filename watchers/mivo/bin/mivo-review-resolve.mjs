import { createHash } from 'node:crypto';
import { TRIAGE_REASONS, taskRepairPolicy, FEEDBACK_POLICY_VERSION } from './mivo-feedback-policy.mjs';
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Autonomous P3 review-thread closure. No human notification, no session dispatch.
// Eligibility is entirely derived from the existing policy layer:
//   category === 'reply-resolve'  (== feedbackRepairPolicy action 'reply-only')
// which already encodes: trusted source, P3-only, current-head-bound, no code authority.
// Thread membership is tracked via the explicit `threadId` field (set only for
// GraphQL review-thread items), never via `item.source === 'thread'` — Greptile-authored
// thread comments carry `source: 'greptile'`, so gating on `source` would silently skip them.

// The receipt marker keeps this reply out of the watcher's own feedback if the thread is ever reopened.
const REPLY_TEXT = '这是一条 P3 级（建议类）反馈，不是阻塞性问题。按项目当前规则，这类建议本轮不安排修复；'
  + '如后续需要可另行处理。讨论到此关闭，不影响本 PR 合并。\n\n<!-- mivo-watcher-receipt task=auto-close -->';

export function autoCloseReplyText() {
  return REPLY_TEXT;
}

export function isAutoCloseEligible(item) {
  const severities = item?.repairPolicy?.severities ?? [];
  return Boolean(item) && item.category === 'reply-resolve'
    && item.repairPolicy?.action === 'reply-only'
    && severities.includes('P3')
    && !severities.some((s) => s === 'P0' || s === 'P1' || s === 'P2')
    && typeof item.threadId === 'string' && item.threadId.length > 0;
}

// Splits `fresh` into items this watcher will resolve on GitHub directly (never
// dispatched to a session) and the remainder that still flows through normal dispatch.
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
  if (result?.completionKind === 'pr-terminal-no-change') return [];
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
  return completeCodeFixThreads(result, task, { disposition: 'no-change', scStatus: 'no-change', kind: 'refuted' })
    .map((item) => {
      const ruling = rulingRecordFor(result, task, item.key);
      if (ruling) return { ...item, ruling };
      const deferral = deferralFor(task, item.key, item.evidence);
      return deferral ? { ...item, deferral } : item;
    });
}
// Without an arbiter (no route, no Orca tool, creation failed) a disputed reviewer P1/P2 has no ruling record
// and the reviewer would raise it again. The watcher turns it into a follow-up issue registered in the PR body;
// the reviewer recognises the issue by the finding key and stops blocking, and a person decides on the issue
// (vigil#41). P0 is never deferred. adjudicationRecord 1 is mivo-repair's ADJUDICATION_RECORD_VERSION.
const ADJUDICATE_SKIPPED_PREFIX = 'adjudicate-skipped:';
const FINDING_CLASS_RE = /<!--\s*mivo-finding\b[^>]*?\bclass=([A-Za-z0-9_-]{1,60})/;
export function deferralFor(task, key, evidence = []) {
  if (task?.adjudicationRecord !== 1 || task.severityStandard?.loaded !== true || !Number.isInteger(task.number)) return null;
  const item = (task.feedback ?? []).find((entry) => entry?.key === key);
  if (item?.source !== 'mivo-review') return null;
  const body = String(item.body ?? '');
  const severity = /^\s*\[(P[12])\]/.exec(body)?.[1];
  const findingKey = FINDING_KEY_RE.exec(body)?.[1];
  const skipped = evidence.find((line) => line.trim().startsWith(ADJUDICATE_SKIPPED_PREFIX));
  if (!severity || !findingKey || !skipped) return null;
  const path = (task.prSnapshot?.unresolvedThreads ?? []).find((thread) => thread?.id === item.threadId)?.path;
  return { key: findingKey, severity, bugClass: FINDING_CLASS_RE.exec(body)?.[1] ?? null,
    path: typeof path === 'string' && path && !/\s/.test(path) ? path : null, title: findingTitle(body), body, reason: skipped.trim(), pr: task.number };
}
function findingTitle(body) {
  const first = String(body).split('\n').find((line) => line.trim()) ?? '';
  const text = first.replace(/^\s*\[P[0-3]\]\s*/, '').replace(/[*`]/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
export function deferralMarker(deferral) {
  return `<!-- mivo-defer key=${deferral.key}${deferral.bugClass ? ` class=${deferral.bugClass}` : ''}${deferral.path ? ` path=${deferral.path}` : ''} -->`;
}
export function deferralIssueTitle(deferral) {
  return `转 issue 跟进：#${deferral.pr} 审查意见「${deferral.title || deferral.key}」`.slice(0, 200);
}
export function deferralIssueBody(deferral, evidence, dispatchId) {
  const quoted = String(deferral.body).replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;').slice(0, 4000)
    .split('\n').map((line) => `> ${line}`);
  return [
    `来自 PR #${deferral.pr} 的服务器审查意见（${deferral.severity}）。盯梢修复会话核实后认为不需要改，但没能开出只读裁决席，没有经过独立判定，所以转 issue 由人确认。`,
    '',
    '**审查意见原文**',
    '',
    ...quoted,
    '',
    '**修复会话的说法（未经裁决）**',
    '',
    ...sanitizeEvidence(evidence),
    '',
    `**为什么没有裁决**：${sanitizeLine(deferral.reason)}`,
    '',
    `**需要人确认**：这条意见是否成立。成立就另开 PR 修，修完关闭本 issue；不成立直接关闭并写明理由。服务器审查按问题 key 认本 issue，本 issue 打开期间这条意见不再阻断 #${deferral.pr}。`,
    '',
    deferralMarker(deferral),
    `<!-- mivo-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
}
// The PR body section the reviewer reads (its deferrals.mjs): a "## 转 issue 跟进的审查问题" heading with one list line
// per issue. Returns the new body, or null when the issue is already listed there.
export const DEFERRAL_HEADING = '转 issue 跟进的审查问题';
export function withDeferralEntry(body, issue, text) {
  const lines = String(body ?? '').replace(/\r\n?/g, '\n').split('\n');
  const entry = `- #${issue} ${String(text ?? '').replace(/\s+/g, ' ').trim()}`.trimEnd();
  const ref = new RegExp(`(?<![\\w/#&.:-])#${issue}(?!\\d)`);
  let fence = false;
  let comment = false;
  let start = -1;
  let level = 0;
  let end = lines.length;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[ \t]*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (comment) { if (line.includes('-->')) comment = false; continue; }
    if (fence) continue;
    if (line.includes('<!--') && !line.slice(line.indexOf('<!--')).includes('-->')) { comment = true; continue; }
    const heading = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (start < 0) {
      if (heading && heading[1].length >= 2 && heading[1].length <= 4 && heading[2] === DEFERRAL_HEADING) { start = index; level = heading[1].length; }
    } else if (heading && heading[1].length <= level) { end = index; break; }
  }
  if (start < 0) return `${lines.join('\n').trimEnd()}\n\n## ${DEFERRAL_HEADING}\n\n${entry}\n`;
  if (lines.slice(start + 1, end).some((line) => /^[ \t]*[-*+][ \t]/.test(line) && ref.test(line))) return null;
  let insert = end;
  while (insert > start + 1 && !lines[insert - 1].trim()) insert -= 1;
  const next = [...lines.slice(0, insert), ...(insert === start + 1 ? [''] : []), entry, ...lines.slice(insert)];
  return next.join('\n');
}
const parse = (raw) => (typeof raw === 'string' ? JSON.parse(raw) : raw);
// Reuses an issue already opened for this finding on this PR (a retry after a crash, or an earlier round),
// whatever its state: a person may have closed it with a decision, and a new copy would undo that.
function* ensureDeferralIssue({ deferral, evidence, dispatchId, repo, ghFn }) {
  const marker = `mivo-defer key=${deferral.key}`;
  const recent = parse(yield () => ghFn(['api', `repos/${repo}/issues?state=all&sort=created&direction=desc&per_page=100`]));
  const found = (Array.isArray(recent) ? recent : []).find((issue) => !issue?.pull_request
    && String(issue?.body ?? '').includes(marker) && new RegExp(`#${deferral.pr}(?!\\d)`).test(String(issue?.body ?? '')));
  if (found) return { number: found.number, state: String(found.state ?? '').toLowerCase(), created: false };
  const created = parse(yield () => ghFn(['api', '-X', 'POST', `repos/${repo}/issues`,
    '-f', `title=${deferralIssueTitle(deferral)}`, '-f', `body=${deferralIssueBody(deferral, evidence, dispatchId)}`]));
  if (!Number.isInteger(created?.number)) throw new Error(`creating the follow-up issue returned no number for ${deferral.key}`);
  return { number: created.number, state: 'open', created: true };
}
function* registerDeferral({ repo, pr, issue, text, ghFn }) {
  const view = parse(yield () => ghFn(['api', `repos/${repo}/pulls/${pr}`]));
  const next = withDeferralEntry(view?.body ?? '', issue, text);
  if (next === null) return false;
  yield () => ghFn(['api', '-X', 'PATCH', `repos/${repo}/pulls/${pr}`, '-f', `body=${next}`]);
  return true;
}
// A reviewer finding the arbiter ruled invalid or p3 is answered with a machine-readable ruling
// record, so the reviewer can verify the ruling and stop raising the finding again (vigil#38).
// head is the head the result was finalized at; std is the standard version the task carried.
// The reviewer never releases a P0 on a ruling, so a P0 gets no record and no promise in the reply.
const FINDING_KEY_RE = /<!--\s*mivo-finding\s+key=([0-9a-f]{12})\b/;
export function rulingRecordFor(result, task, key) {
  const item = (task?.feedback ?? []).find((entry) => entry?.key === key);
  if (item?.source !== 'mivo-review' || /^\s*\[P0\]/.test(String(item.body ?? ''))) return null;
  const findingKey = FINDING_KEY_RE.exec(String(item.body ?? ''))?.[1];
  const std = task.severityStandard?.loaded === true ? task.severityStandard.version : null;
  if (!findingKey || !/^[0-9a-f]{12}$/.test(std ?? '') || !/^[0-9a-f]{40}$/.test(result?.head ?? '')) return null;
  if (!/^[A-Za-z0-9._:-]{1,120}$/.test(task.dispatchId ?? '')) return null;
  for (const worker of result.workers ?? []) {
    if (worker?.purpose !== 'adjudicate') continue;
    const ruling = (worker.rulings ?? []).find((entry) => entry?.feedbackKey === key);
    if (!ruling || !['invalid', 'p3'].includes(ruling.verdict)) continue;
    const by = `${worker.agent}/${worker.model}`.replace(/[^A-Za-z0-9._:/@+-]/g, '_').slice(0, 120);
    return { key: findingKey, head: result.head, verdict: ruling.verdict, std, by, task: task.dispatchId, reason: String(ruling.reason ?? '') };
  }
  return null;
}
export function rulingRecordLine(ruling) {
  return `<!-- mivo-ruling v=1 key=${ruling.key} head=${ruling.head} verdict=${ruling.verdict} std=${ruling.std} by=${ruling.by} task=${ruling.task} -->`;
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
// Session text must not carry HTML comments: the receipt and ruling markers in the same reply are
// read by machines, and a forged one inside the evidence would be read too.
function sanitizeLine(line) {
  return line.replace(/\/(?:Users|home)\/[^\s'"`]+/g, '<本机路径>').replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;')
    .replace(/\s+/g, ' ').slice(0, 300);
}
function sanitizeEvidence(evidence) {
  return evidence.slice(0, 5).map((line) => '- ' + sanitizeLine(line));
}
const RULING_VERDICT_TEXT = { invalid: '不成立', p3: '属实但按统一分级只到 P3，不必修' };
export function refutedReplyText(evidence, dispatchId, ruling = null) {
  return [
    ruling
      ? '**发生了什么**：盯梢修复轮核实后对这条意见有异议，交给只读裁决席按统一分级判定，结论是不需要改代码。'
      : '**发生了什么**：盯梢修复轮核实了这条 P0/P1/P2 意见，结论是它在当前 head 上不成立，不需要改代码。',
    ruling
      ? '**对本 PR 意味着什么**：这条意见不再阻塞合并。回帖末尾附有裁决记录，服务器审查会核对后采信，不再重复提出；之后的提交如果改了相关文件，裁决失效，服务器会重新判断。'
      : '**对本 PR 意味着什么**：这条意见不再阻塞合并；核实依据如下，若之后的提交让问题重新成立，服务器审查会在新 head 上再次提出。',
    '**要不要改代码**：不改。',
    ...(ruling ? ['', `**裁决**：${RULING_VERDICT_TEXT[ruling.verdict] ?? ruling.verdict}（裁决席 ${ruling.by}）。理由：${sanitizeLine(ruling.reason)}`] : []),
    '',
    '核实证据：',
    ...sanitizeEvidence(evidence),
    '',
    `<!-- mivo-watcher-receipt task=${dispatchId} -->`,
    ...(ruling ? [rulingRecordLine(ruling)] : []),
  ].join('\n');
}
// A disputed reviewer P1/P2 that no arbiter could judge, handed to a follow-up issue (vigil#41).
export function deferredReplyText(evidence, dispatchId, deferral, issue) {
  const why = sanitizeLine(deferral.reason.slice(ADJUDICATE_SKIPPED_PREFIX.length).trim()) || '原因见下';
  return [
    `**发生了什么**：盯梢修复轮核实后认为这条意见不需要改，但没能开出只读裁决席（${why}），没有经过独立判定，所以转成 issue #${issue} 由人确认，并登记到 PR 说明的「${DEFERRAL_HEADING}」一节。`,
    `**对本 PR 意味着什么**：服务器审查按问题 key 认 #${issue}，它打开期间这条意见不再阻断本 PR；问题本身留在 #${issue} 里跟进，没有被判定为不成立。`,
    `**要不要改代码**：本 PR 不改；#${issue} 确认成立后另开 PR 修。`,
    '',
    '修复会话的说法（未经裁决）：',
    ...sanitizeEvidence(evidence),
    '',
    `<!-- mivo-watcher-receipt task=${dispatchId} -->`,
  ].join('\n');
}
// A member's thread the session graded as not needing code (P3, a question, or not reproducible).
export function triagedReplyText(evidence, dispatchId) {
  return [
    '**发生了什么**：盯梢修复轮按仓库统一分级核实了这条意见，结论是本轮不需要改代码（不成立、或属于 P3 建议）。',
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
// Same durable receipt as the P3 closure: `previous.autoClosedThreads[threadId]`.
export function* closeRefutedThreads({ items = [], dispatchId, previous = {}, ghFn, now, head, repo = null, pr = null }) {
  const closedThreads = { ...(previous.autoClosedThreads ?? {}) };
  const deferralIssues = { ...(previous.deferralIssues ?? {}) };
  const results = [];
  for (const item of items) {
    // The receipt covers one disposition. A thread reopened and handled again by a later task
    // carries that task's dispatchId and is answered again; the same task never posts twice.
    const itemDispatchId = item.dispatchId ?? dispatchId;
    const receipt = closedThreads[item.threadId];
    if (receipt && receipt.dispatchId === itemDispatchId) continue;
    // Without repo/PR the follow-up issue cannot be opened: the thread closes with the plain refuted reply, as before.
    const deferral = item.kind !== 'fixed' && !item.triage && item.deferral && repo && Number.isInteger(pr) ? item.deferral : null;
    let issue = null;
    if (deferral) {
      const known = deferralIssues[item.threadId];
      issue = known?.key === deferral.key ? known.issue
        : (yield* ensureDeferralIssue({ deferral, evidence: item.evidence, dispatchId: itemDispatchId, repo, ghFn })).number;
      deferralIssues[item.threadId] = { issue, key: deferral.key, at: now };
      yield* registerDeferral({ repo, pr, issue, text: deferral.title, ghFn });
    }
    const body = item.kind === 'fixed' ? fixedReplyText(item.evidence, head, itemDispatchId)
      : item.triage ? triagedReplyText(item.evidence, itemDispatchId)
        : deferral ? deferredReplyText(item.evidence, itemDispatchId, deferral, issue)
          : refutedReplyText(item.evidence, itemDispatchId, item.ruling ?? null);
    const reason = item.kind === 'fixed' ? 'fixed-p0-p1' : item.triage ? 'member-thread-no-change' : deferral ? 'deferred-to-issue' : 'refuted-p0-p1';
    yield () => ghFn(['api', 'graphql', '-f', `query=${replyMutation}`, '-f', `tid=${item.threadId}`, '-f', `body=${body}`]);
    yield () => ghFn(['api', 'graphql', '-f', `query=${resolveMutation}`, '-f', `tid=${item.threadId}`]);
    closedThreads[item.threadId] = { at: now, key: item.key, reason, dispatchId: itemDispatchId, ...(issue ? { issue } : {}) };
    results.push({ threadId: item.threadId, key: item.key, ...(issue ? { issue } : {}) });
  }
  return { previous: { ...previous, autoClosedThreads: closedThreads, ...(Object.keys(deferralIssues).length ? { deferralIssues } : {}) }, closed: results };
}
const MEMBER_ITEM_KEY = /^(?:review|comment):/;
export function completedMemberFeedback(result, task) {
  if (result?.schemaVersion !== 2 || result.dispatchId !== task?.dispatchId) return [];
  if (task.repairPolicy?.policyVersion !== FEEDBACK_POLICY_VERSION && Number(task.repairPolicy?.policyVersion ?? 0) < 2) return [];
  const policy = taskRepairPolicy(task);
  const items = [];
  for (const { key, disposition } of result.feedbackCoverage?.dispositions ?? []) {
    if (!MEMBER_ITEM_KEY.test(key ?? '')) continue;
    const row = policy.items.find((item) => item.key === key);
    if (!row || !['code-fix', 'reply-only'].includes(row.action)) continue;
    const scStatus = disposition === 'fixed' ? 'pass' : 'no-change';
    if (disposition !== 'fixed' && disposition !== 'no-change') continue;
    const evidence = (result.scs ?? []).filter((sc) => sc.status === scStatus && sc.feedbackKeys?.includes(key))
      .flatMap((sc) => sc.evidence ?? []).filter((line) => typeof line === 'string' && line.trim());
    if (!evidence.length) continue;
    items.push({ key, disposition, evidence, kind: disposition === 'fixed' ? 'fixed' : 'refuted', triage: TRIAGE_REASONS.has(row.reason) });
  }
  return items;
}
export function coveredFeedbackItems(items = [], observed = [], task = {}, result = null) {
  const taskItems = new Map((task?.feedback ?? []).filter((item) => typeof item?.key === 'string').map((item) => [item.key, item]));
  if (!items.length) return [];
  return items.filter((item) => {
    const current = observed.find((other) => `${other.source}:${other.nativeId}` === item.key || other.key === item.key);
    if (!current || !taskItems.has(item.key)) return false;
    return sameFeedbackContent(taskItems.get(item.key), current);
  });
}
export function memberReplyText(item, { url, head } = {}) {
  const evidence = item.evidence ?? [];
  const body = item.kind === 'fixed' ? fixedReplyText(evidence, head, item.dispatchId) : item.triage ? triagedReplyText(evidence, item.dispatchId) : refutedReplyText(evidence, item.dispatchId);
  const cite = url ? `原始意见：${url}\n\n` : '';
  const actionKey = item.actionKey ?? digest([item.key, item.contentHash, head, item.disposition]);
  return `${cite}${body.replace('<!-- mivo-watcher-receipt', `<!-- mivo-watcher-receipt actionKey=${actionKey} head=${head ?? ''} `)}`;
}
export function* replyToMemberFeedback({ items = [], comments = [], actor, repo, number, ghFn, now, head, previous = {} }) {
  const handled = { ...(previous.handledFeedback ?? {}) };
  const pending = [...(previous.pendingFeedbackReplies ?? [])];
  const posted = [];
  for (const item of items) {
    const actionKey = digest([item.key, item.contentHash ?? item.key, head, item.disposition]);
    const marker = `actionKey=${actionKey}`;
    const existing = comments.find((comment) => (comment.body ?? '').includes(marker) && (!actor || (comment.user?.login ?? comment.author?.login) === actor));
    if (handled[item.key]?.actionKey === actionKey && handled[item.key].replyCommentId) continue;
    if (existing) {
      handled[item.key] = {
        key: item.key, nativeId: item.nativeId ?? null,
        policyVersion: FEEDBACK_POLICY_VERSION, contentHash: item.contentHash ?? null, disposition: item.disposition,
        sourceHead: item.sourceHead ?? null, resultHead: head, dispatchId: item.dispatchId, receiptId: item.receiptId ?? null,
        replyCommentId: existing.id, actionKey, repliedAt: now,
      };
      posted.push({ key: item.key, commentId: existing.id, reused: true });
      continue;
    }
    const body = memberReplyText({ ...item, actionKey }, { url: item.url, head });
    pending.push({ key: item.key, actionKey, status: 'pending', at: now, head });
    try {
      const raw = yield () => ghFn(['api', '-X', 'POST', `repos/${repo}/issues/${number}/comments`, '-f', `body=${body}`]);
      const created = typeof raw === 'string' ? JSON.parse(raw) : raw;
      handled[item.key] = {
        key: item.key, nativeId: item.nativeId ?? null,
        policyVersion: FEEDBACK_POLICY_VERSION, contentHash: item.contentHash ?? null, disposition: item.disposition,
        sourceHead: item.sourceHead ?? null, resultHead: head, dispatchId: item.dispatchId, receiptId: item.receiptId ?? null,
        replyCommentId: created.id, actionKey, repliedAt: now,
      };
      posted.push({ key: item.key, commentId: created.id, reused: false });
    } catch (error) {
      pending[pending.length - 1] = { ...pending[pending.length - 1], status: 'uncertain', error: String(error.message).slice(0, 400) };
    }
  }
  return { previous: { ...previous, handledFeedback: handled, pendingFeedbackReplies: pending.filter((item) => item.status !== 'pending' || !handled[item.key]) }, posted };
}
export function* requestMemberReviewers({ repo, number, reviewers, ghFn, previous = {}, now, resultHead, reviewId }) {
  const pending = [...(previous.pendingMemberRereview ?? [])];
  const requested = [];
  for (const login of [...new Set(reviewers.filter(Boolean))]) {
    const key = `${login}:${reviewId ?? ''}:${resultHead}`;
    if (pending.some((item) => item.key === key && ['pending', 'done'].includes(item.status))) continue;
    pending.push({ key, login, status: 'pending', at: now, resultHead, reviewId });
    try {
      yield () => ghFn(['api', '-X', 'POST', `repos/${repo}/pulls/${number}/requested_reviewers`, '-f', `reviewers[]=${login}`]);
      pending[pending.length - 1] = { ...pending[pending.length - 1], status: 'done' };
      requested.push(login);
    } catch (error) {
      pending[pending.length - 1] = { ...pending[pending.length - 1], status: 'failed', error: String(error.message).slice(0, 400) };
    }
  }
  return { previous: { ...previous, pendingMemberRereview: pending }, requested };
}

