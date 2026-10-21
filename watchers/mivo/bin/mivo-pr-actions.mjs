import { createHash, randomBytes } from 'node:crypto';
import { collectPrOwnership } from './mivo-pr-snapshot.mjs';
import { taskRepairPolicy } from './mivo-feedback-policy.mjs';
import { sameFeedbackContent } from './mivo-review-resolve.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const UNCONFIRMED_MS = 5 * 60 * 1000;
const REVIEW_UNCONFIRMED_MS = 10 * 60 * 1000;
const REVIEW_WORKFLOW = 'review-pr.yml';
const REVIEW_WORKFLOW_PATH = '.github/workflows/review-pr.yml';

function parse(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function statusOf(error) {
  return Number(error?.status ?? error?.exitCode ?? error?.code) || 0;
}

export function baseUpdateKey({ nodeId, head, baseTip, releaseEpoch }) {
  return digest({ nodeId, head, baseTip, releaseEpoch });
}

export function planBaseUpdate({ snapshot, entry, fresh = [], now }) {
  const pr = snapshot?.pr ?? {};
  const evidence = snapshot?.reviewEvidence ?? {};
  const mergeState = String(snapshot?.mergeStateStatus ?? pr.mergeStateStatus ?? 'UNKNOWN').toUpperCase();
  const eligibleFromReview = evidence.baseUpdateEligible === true || snapshot?.baseUpdateEligible === true;
  const inFlight = Boolean(entry?.activeTask) && !['complete', 'legacy-complete'].includes(entry.activeTask.status)
    && entry.activeTask.blockedKind !== 'author-reclaimed';
  const pendingDispatch = Boolean(entry?.pendingDispatch);
  const reason = (() => {
    if (pr.state !== 'OPEN' || pr.isDraft) return 'inactive';
    if (pr.baseRefName !== 'main') return 'base-not-main';
    if (snapshot?.mergeable !== 'MERGEABLE') return 'not-mergeable';
    if (mergeState !== 'BEHIND') return `merge-state-${mergeState.toLowerCase()}`;
    if (!eligibleFromReview) return evidence.reason ?? snapshot?.reviewReason ?? 'gates-not-clear';
    if ((fresh ?? []).length) return 'fresh-feedback';
    if (inFlight) return 'repair-in-flight';
    if (pendingDispatch) return 'pending-dispatch';
    if (entry?.needsHuman) return 'needs-human';
    if (entry?.dispatchConflict) return 'dispatch-conflict';
    const current = entry?.baseUpdate;
    if (current && current.key === baseUpdateKey({
      nodeId: pr.id, head: pr.headRefOid, baseTip: snapshot.baseTipOid, releaseEpoch: pr.releaseEpoch,
    }) && ['reserved', 'accepted', 'uncertain', 'updated'].includes(current.status)) {
      return `already-${current.status}`;
    }
    return 'eligible';
  })();
  const key = baseUpdateKey({
    nodeId: pr.id, head: pr.headRefOid, baseTip: snapshot.baseTipOid, releaseEpoch: pr.releaseEpoch,
  });
  return { eligible: reason === 'eligible', reason, key, now };
}

export function assertActionOwner({
  live, snapshot, entry, viewer, expected = {},
}) {
  const pr = live?.pr ?? live;
  const collected = snapshot?.pr ?? {};
  const fail = (reason) => { const error = new Error(reason); error.code = 'ACTION_OWNER'; throw error; };
  if (!pr || pr.state !== 'OPEN' || pr.isDraft === true) fail('inactive');
  if (pr.sameRepository === false) fail('cross-repository');
  if (typeof viewer === 'string' && pr.author?.login !== viewer) fail('author-mismatch');
  if (expected.nodeId && pr.id !== expected.nodeId) fail('node-mismatch');
  if (expected.number != null && Number(pr.number) !== Number(expected.number)) fail('number-mismatch');
  if (expected.head && pr.headRefOid !== expected.head) fail('head-mismatch');
  if (expected.headRefName && pr.headRefName !== expected.headRefName) fail('head-ref-mismatch');
  if (expected.baseRefName && pr.baseRefName !== expected.baseRefName) fail('base-ref-mismatch');
  if (expected.baseRefOid && pr.baseRefOid !== expected.baseRefOid) fail('base-oid-mismatch');
  if (expected.releaseEpoch && pr.releaseEpoch !== expected.releaseEpoch) fail('epoch-mismatch');
  if (collected.id && collected.id !== pr.id) fail('snapshot-drift');
  if (entry?.optOut) fail('opt-out');
  if (entry?.needsHuman) fail('needs-human');
  if (entry?.dispatchConflict) fail('dispatch-conflict');
  if (expected.handoffId && entry?.handoff?.id && entry.handoff.id !== expected.handoffId) fail('handoff-mismatch');
  if (expected.sessionId && entry?.sessionId && entry.sessionId !== expected.sessionId) fail('session-mismatch');
  return true;
}

function* readOwnership({ pr, ghFn }) {
  return yield* collectPrOwnership({ pr, ghFn });
}

export function* updateBaseBranch({
  pr, entry, snapshot, ghFn, ownershipSnapshot, save, now, dryRun = false, viewer, repo,
}) {
  const plan = planBaseUpdate({ snapshot, entry, fresh: [], now });
  if (!plan.eligible) return { entry, action: { attempted: false, reason: plan.reason } };
  const expected = {
    nodeId: pr.id,
    number: pr.number,
    head: pr.headRefOid,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    baseRefOid: pr.baseRefOid,
    releaseEpoch: pr.releaseEpoch,
    handoffId: entry?.handoff?.id,
    sessionId: entry?.sessionId,
  };
  const live = yield* (ownershipSnapshot ?? readOwnership)({ pr: { number: pr.number, repo }, ghFn });
  assertActionOwner({ live, snapshot, entry, viewer, expected });
  if (dryRun) return { entry, action: { attempted: false, reason: 'dry-run', key: plan.key } };
  const reserved = {
    ...entry,
    baseUpdate: {
      key: plan.key,
      head: pr.headRefOid,
      baseTip: snapshot.baseTipOid,
      releaseEpoch: pr.releaseEpoch,
      status: 'reserved',
      requestedAt: now,
      checkedAt: now,
      observedHead: null,
      attempts: 1,
      error: null,
    },
    mergeReady: false,
    reviewEvidence: null,
  };
  save?.(reserved);
  try {
    const raw = yield () => ghFn([
      'api', '-X', 'PUT', `repos/${repo}/pulls/${pr.number}/update-branch`,
      '-f', `expected_head_sha=${pr.headRefOid}`,
    ]);
    parse(raw);
    const accepted = {
      ...reserved,
      baseUpdate: { ...reserved.baseUpdate, status: 'accepted', checkedAt: now },
    };
    save?.(accepted);
    return { entry: accepted, action: { attempted: true, reason: 'accepted', key: plan.key } };
  } catch (error) {
    const code = statusOf(error);
    if (code === 422) {
      const after = yield* (ownershipSnapshot ?? readOwnership)({ pr: { number: pr.number, repo }, ghFn });
      const afterPr = after.pr ?? after;
      if (afterPr.headRefOid !== pr.headRefOid) {
        const superseded = {
          ...reserved,
          baseUpdate: { ...reserved.baseUpdate, status: 'superseded', checkedAt: now, observedHead: afterPr.headRefOid, error: 'head-changed' },
        };
        save?.(superseded);
        return { entry: superseded, action: { attempted: true, reason: 'superseded', key: plan.key } };
      }
    }
    const failedStatus = code === 403 ? 'failed' : 'uncertain';
    const failed = {
      ...reserved,
      baseUpdate: {
        ...reserved.baseUpdate,
        status: failedStatus,
        checkedAt: now,
        error: String(error.message).slice(0, 400),
      },
    };
    save?.(failed);
    return { entry: failed, action: { attempted: true, reason: failedStatus, key: plan.key, error: String(error.message).slice(0, 400) } };
  }
}

export function reconcileBaseUpdate({ snapshot, entry, now }) {
  const current = entry?.baseUpdate;
  if (!current) return entry;
  const head = snapshot?.pr?.headRefOid;
  if (current.status === 'accepted' || current.status === 'uncertain' || current.status === 'reserved') {
    if (head && head !== current.head) {
      return {
        ...entry,
        baseUpdate: { ...current, status: 'updated', checkedAt: now, observedHead: head },
        mergeReady: false,
        reviewEvidence: null,
      };
    }
    if (current.status !== 'updated' && Date.parse(now) - Date.parse(current.requestedAt) > UNCONFIRMED_MS) {
      return {
        ...entry,
        baseUpdate: { ...current, status: 'failed', checkedAt: now, error: 'base-update-unconfirmed' },
      };
    }
  }
  return entry;
}

export function pendingActionDue(entry) {
  const base = entry?.baseUpdate?.status;
  const review = (entry?.reviewRechecks ?? {});
  const reviewPending = Object.values(review).some((item) => (item.attempts ?? []).some((attempt) => ['reserved', 'sent', 'uncertain'].includes(attempt.status)));
  const replies = (entry?.pendingFeedbackReplies ?? []).some((item) => ['pending', 'uncertain'].includes(item.status));
  const rereview = (entry?.pendingMemberRereview ?? []).some((item) => ['pending', 'uncertain'].includes(item.status));
  return ['reserved', 'accepted', 'uncertain'].includes(base) || reviewPending || replies || rereview;
}

function findingDigest(snapshot) {
  const evidence = snapshot?.reviewEvidence ?? {};
  return digest({
    checkRunId: evidence.checkRunId ?? null,
    runId: evidence.runId ?? null,
    reviewId: evidence.reviewId ?? null,
    reason: evidence.reason ?? snapshot?.reviewReason ?? null,
    findings: evidence.findingIds ?? evidence.blockingFindingIds ?? [],
  });
}

export function planReviewRecheck({ snapshot, entry, task, result, observed = [] }) {
  const pr = snapshot?.pr ?? {};
  const evidence = snapshot?.reviewEvidence ?? {};
  const reason = snapshot?.reviewReason ?? evidence.reason;
  if (!result || result.schemaVersion !== 2) return { eligible: false, reason: 'result-not-v2' };
  if (result.dispatchId !== task?.dispatchId) return { eligible: false, reason: 'result-task-mismatch' };
  if (!sha(result.head) || result.head !== task.headRefOid || result.head !== pr.headRefOid) return { eligible: false, reason: 'head-changed' };
  if (!['complete', 'waiting-ci'].includes(result.status)) return { eligible: false, reason: 'result-not-complete' };
  const policy = taskRepairPolicy(task);
  const machineKeys = (task.feedback ?? []).filter((item) => item.source === 'mivo-review' && policy.items.some((row) => row.key === item.key && row.canChangeCode)).map((item) => item.key);
  if (!machineKeys.length) return { eligible: false, reason: 'no-machine-findings' };
  const dispositions = new Map((result.feedbackCoverage?.dispositions ?? []).map((item) => [item.key, item.disposition]));
  const scs = result.scs ?? [];
  for (const key of machineKeys) {
    if (dispositions.get(key) !== 'no-change') return { eligible: false, reason: 'partial-coverage' };
    const evidenceLines = scs.filter((sc) => sc.status === 'no-change' && sc.feedbackKeys?.includes(key)).flatMap((sc) => sc.evidence ?? []);
    if (!evidenceLines.length) return { eligible: false, reason: 'missing-no-change-evidence' };
    const original = (task.feedback ?? []).find((item) => item.key === key);
    const current = observed.find((item) => item.key === key || `${item.source}:${item.nativeId}` === key);
    if (!current || !sameFeedbackContent(original, current)) return { eligible: false, reason: 'feedback-edited' };
  }
  if (reason !== 'review-findings' && reason !== 'review-failure' && !String(reason ?? '').startsWith('review-')) {
    return { eligible: false, reason: 'review-not-blocking' };
  }
  if (String(reason).includes('veto') || reason === 'review-veto') return { eligible: false, reason: 'human-veto' };
  if (evidence.producerUnverified) return { eligible: false, reason: 'producer-unverified' };
  if (!['light', 'standard', 'heavy'].includes(evidence.tier)) return { eligible: false, reason: 'review-tier-unknown' };
  const head = pr.headRefOid;
  const log = entry?.reviewRechecks?.[head] ?? { attempts: [] };
  const digestValue = findingDigest(snapshot);
  if (log.attempts.some((item) => item.resultReceiptId === result.receiptId || (item.findingDigest === digestValue && item.resultReceiptId === (result.receiptId ?? result.dispatchId)))) {
    return { eligible: false, reason: 'same-result' };
  }
  // No per-head cap: each new no-change repair result may ask for one recheck. A repeat needs a result
  // that can be told apart from the one already used.
  if ((log.attempts ?? []).length && !result.receiptId) return { eligible: false, reason: 'second-requires-new-result' };
  return {
    eligible: true,
    reason: 'eligible',
    key: digest({ head, digest: digestValue, receipt: result.receiptId ?? result.dispatchId, epoch: pr.releaseEpoch }),
    tier: evidence.tier,
    sourceRunId: evidence.runId ?? null,
    findingDigest: digestValue,
  };
}

const THREADS_QUERY = 'query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$after){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}';
const THREAD_PAGE_LIMIT = 50;

export function* threadsAllResolved({ repo, number, ghFn }) {
  const [owner, name] = repo.split('/');
  let after = null;
  for (let page = 0; page < THREAD_PAGE_LIMIT; page += 1) {
    const raw = parse(yield () => ghFn(['api', 'graphql', '-f', `query=${THREADS_QUERY}`,
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${Number(number)}`,
      ...(after ? ['-f', `after=${after}`] : [])]));
    const threads = raw?.data?.repository?.pullRequest?.reviewThreads;
    // An unreadable page is not proof that every conversation is closed.
    if (!Array.isArray(threads?.nodes) || typeof threads.pageInfo?.hasNextPage !== 'boolean') return false;
    if (!threads.nodes.every((thread) => thread?.isResolved === true)) return false;
    if (!threads.pageInfo.hasNextPage) return true;
    after = threads.pageInfo.endCursor;
    if (typeof after !== 'string' || !after) return false;
  }
  return false;
}

function randomId(prefix) {
  return `${prefix}-${Date.now()}-${randomBytes(4).toString('hex')}`;
}

export function* requestReviewRecheck({
  pr, snapshot, entry, task, result, observed, ghFn, ownershipSnapshot, save, now, dryRun = false, viewer, repo,
}) {
  const plan = planReviewRecheck({ snapshot, entry, task, result, observed });
  if (!plan.eligible) return { entry, action: { attempted: false, reason: plan.reason } };
  const live = yield* (ownershipSnapshot ?? readOwnership)({ pr: { number: pr.number, repo }, ghFn });
  assertActionOwner({
    live, snapshot, entry, viewer,
    expected: {
      nodeId: pr.id, number: pr.number, head: pr.headRefOid, headRefName: pr.headRefName,
      baseRefName: pr.baseRefName, baseRefOid: pr.baseRefOid, releaseEpoch: pr.releaseEpoch,
      handoffId: entry?.handoff?.id, sessionId: entry?.sessionId,
    },
  });
  if (dryRun) return { entry, action: { attempted: false, reason: 'dry-run', key: plan.key } };
  const workflow = parse(yield () => ghFn(['api', `repos/${repo}/actions/workflows/${REVIEW_WORKFLOW}`]));
  const mode = parse(yield () => ghFn(['api', `repos/${repo}/actions/variables/MIVO_REVIEW_MODE`]));
  if (workflow?.path !== REVIEW_WORKFLOW_PATH || workflow.state !== 'active' || mode?.value !== 'live') {
    return { entry, action: { attempted: false, reason: 'review-recheck-unavailable' } };
  }
  const runs = parse(yield () => ghFn([
    'api', `repos/${repo}/actions/runs?event=workflow_dispatch&status=in_progress&per_page=20`,
  ]));
  const active = (runs.workflow_runs ?? runs ?? []).filter((run) => run.path === REVIEW_WORKFLOW_PATH && ['queued', 'in_progress', 'waiting'].includes(run.status));
  if (active.length) return { entry, action: { attempted: false, reason: 'review-in-progress' } };
  // The reviewer refuses to enter while any conversation is open. Read it live (this scan may just have
  // resolved threads) and wait without spending this result's recheck.
  if (!(yield* threadsAllResolved({ repo, number: pr.number, ghFn }))) {
    return { entry, action: { attempted: false, reason: 'threads-unresolved' } };
  }
  const roundId = randomId('vigil').slice(0, 80);
  const dispatchId = randomBytes(8).toString('hex');
  const attempt = {
    key: plan.key,
    sourceRunId: plan.sourceRunId,
    findingDigest: plan.findingDigest,
    resultReceiptId: result.receiptId ?? result.dispatchId,
    releaseEpoch: pr.releaseEpoch,
    status: 'reserved',
    requestedAt: now,
    roundId,
    dispatchId,
    skillSha: null,
    runId: null,
    error: null,
  };
  const head = pr.headRefOid;
  const next = {
    ...entry,
    mergeReady: false,
    reviewEvidence: null,
    reviewRechecks: {
      ...(entry.reviewRechecks ?? {}),
      [head]: { attempts: [...((entry.reviewRechecks ?? {})[head]?.attempts ?? []), attempt] },
    },
  };
  save?.(next);
  try {
    yield () => ghFn([
      'workflow', 'run', REVIEW_WORKFLOW, '--repo', repo, '--ref', 'main',
      '-f', `target_repo=${repo}`,
      '-f', `pr=${pr.number}`,
      '-f', `head_sha=${pr.headRefOid}`,
      '-f', `base_sha=${pr.baseRefOid}`,
      '-f', `tier=${plan.tier}`,
      '-f', `round_id=${roundId}`,
      '-f', 'mode=live',
      '-f', 'action=review',
      '-f', 'prev_run_id=',
      '-f', 'attempt=1',
      '-f', `dispatch_id=${dispatchId}`,
    ]);
    const sent = {
      ...next,
      reviewRechecks: {
        ...next.reviewRechecks,
        [head]: {
          attempts: next.reviewRechecks[head].attempts.map((item) => item.key === plan.key ? { ...item, status: 'sent' } : item),
        },
      },
    };
    save?.(sent);
    return { entry: sent, action: { attempted: true, reason: 'sent', key: plan.key, dispatchId, roundId } };
  } catch (error) {
    const failed = {
      ...next,
      reviewRechecks: {
        ...next.reviewRechecks,
        [head]: {
          attempts: next.reviewRechecks[head].attempts.map((item) => item.key === plan.key
            ? { ...item, status: 'uncertain', error: String(error.message).slice(0, 400) }
            : item),
        },
      },
    };
    save?.(failed);
    return { entry: failed, action: { attempted: true, reason: 'uncertain', key: plan.key, error: String(error.message).slice(0, 400) } };
  }
}

export function reconcileReviewRecheck({ entry, snapshot, now }) {
  const head = snapshot?.pr?.headRefOid;
  if (!entry?.reviewRechecks || !head) return entry;
  const log = entry.reviewRechecks[head];
  if (!log) return entry;
  const attempts = (log.attempts ?? []).map((item) => {
    if (!['reserved', 'sent', 'uncertain'].includes(item.status)) return item;
    if (Date.parse(now) - Date.parse(item.requestedAt) > REVIEW_UNCONFIRMED_MS) {
      return { ...item, status: 'failed', error: item.error ?? 'review-dispatch-unconfirmed' };
    }
    return item;
  });
  return { ...entry, reviewRechecks: { ...entry.reviewRechecks, [head]: { ...log, attempts } } };
}

