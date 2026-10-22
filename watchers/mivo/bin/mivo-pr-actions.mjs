import { createHash } from 'node:crypto';
import { collectPrOwnership } from './mivo-pr-snapshot.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const UNCONFIRMED_MS = 5 * 60 * 1000;
const REVIEW_UNCONFIRMED_MS = 10 * 60 * 1000;

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

// The watcher no longer dispatches review rechecks (#38). This only settles attempts that older
// versions recorded, so they stop counting as a pending action.
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

