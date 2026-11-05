import { createHash } from 'node:crypto';
import { collectPrOwnership, readMergeState, mergeStateIsBatched } from './mivo-pr-snapshot.mjs';

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

// main's ruleset does not require branches to be up to date, so GitHub never reports a main PR as BEHIND and the
// BEHIND-only path below never ran for one (2026-11-04: Ready PRs 15-47 commits behind main, one merge-ready at 36).
// The drift is read from the compare API instead. A PR is brought up to date once it is this far behind, or once its
// merge base is old enough that the pre-review's stale-rebase gate (3 days) is close. Each sync starts CI and a
// re-review again, so a lower bar would keep a PR waiting in the review queue that much longer.
export const BASE_SYNC_MIN_BEHIND = 10;
export const BASE_SYNC_MAX_AGE_MS = 48 * 60 * 60 * 1000;
// At most one sync per watcher in this window, so a burst of merges into main does not restart every PR's CI at once.
export const BASE_SYNC_SPACING_MS = 5 * 60 * 1000;
// A sync GitHub refused is not tried again for the same head and base tip before this.
export const BASE_SYNC_FAILED_COOLDOWN_MS = 60 * 60 * 1000;
const SYNCABLE_BASE = /^(?:main|integration\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)$/;
const SHA = /^[0-9a-f]{40}$/i;

export function isSyncableBase(baseRefName) {
  return typeof baseRefName === 'string' && SYNCABLE_BASE.test(baseRefName) && !baseRefName.includes('..');
}

// How far the PR head is behind the base tip, and when the two last met. Compared against the base tip SHA, not
// the branch name, so the answer belongs to the tip this round collected.
export function* readBaseDrift({ repo, baseTip, head, ghFn }) {
  if (!SHA.test(baseTip ?? '') || !SHA.test(head ?? '')) throw new Error('base-drift: base tip or head is not a full SHA');
  const data = parse(yield () => ghFn(['api', `repos/${repo}/compare/${baseTip}...${head}?per_page=1`,
    '--jq', '{behind_by: .behind_by, merge_base_date: .merge_base_commit.commit.committer.date}']));
  const behindBy = data?.behind_by;
  const mergeBaseAt = data?.merge_base_date;
  if (!Number.isInteger(behindBy) || behindBy < 0) throw new Error(`base-drift: behind_by expected a non-negative integer, got ${typeof behindBy}`);
  if (typeof mergeBaseAt !== 'string' || !Number.isFinite(Date.parse(mergeBaseAt))) throw new Error('base-drift: merge base date missing');
  return { head, baseTip, behindBy, mergeBaseAt };
}

// A head branch whose effective rules include `pull_request` (a stage branch whose stage PR targets main) takes
// changes only through a PR. update-branch pushes a merge commit straight onto the head branch, so it is refused
// there however far behind the PR is, and the PR would be tried again on every scan.
export function headRulesRequirePr(pages) {
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error(`head-rules: expected pages of rules, got ${typeof pages}`);
  return pages.flat().some((rule) => rule?.type === 'pull_request');
}

// Why a due sync is held back for the PR's head branch, or null. A read that fails holds it too: the sync is a write
// to the PR that cannot be taken back, so it waits for a readable answer.
export function* readHeadSyncHold({ repo, headRefName, ghFn }) {
  if (typeof headRefName !== 'string' || !headRefName) return 'head-rules-unavailable';
  try {
    const pages = parse(yield () => ghFn(['api', `repos/${repo}/rules/branches/${encodeURIComponent(headRefName)}?per_page=100`, '--paginate', '--slurp']));
    return headRulesRequirePr(pages) ? 'head-requires-pr' : null;
  } catch {
    return 'head-rules-unavailable';
  }
}

export function baseDriftDue({ drift, now }) {
  if (!drift || !(drift.behindBy > 0)) return false;
  return drift.behindBy >= BASE_SYNC_MIN_BEHIND || Date.parse(now) - Date.parse(drift.mergeBaseAt) >= BASE_SYNC_MAX_AGE_MS;
}

export function planBaseUpdate({ snapshot, entry, fresh = [], now, drift = null, lastSyncAt = null }) {
  const pr = snapshot?.pr ?? {};
  const evidence = snapshot?.reviewEvidence ?? {};
  const blockers = evidence.blockers ?? [];
  const mergeState = String(snapshot?.mergeStateStatus ?? pr.mergeStateStatus ?? 'UNKNOWN').toUpperCase();
  const eligibleFromReview = evidence.baseUpdateEligible === true || snapshot?.baseUpdateEligible === true;
  // A drift reading only counts for the head and base tip it was taken on.
  const currentDrift = drift && drift.head === pr.headRefOid && drift.baseTip === snapshot?.baseTipOid ? drift : null;
  const strictBehind = mergeState === 'BEHIND' && eligibleFromReview;
  const driftDue = baseDriftDue({ drift: currentDrift, now });
  const inFlight = Boolean(entry?.activeTask) && !['complete', 'legacy-complete'].includes(entry.activeTask.status)
    && entry.activeTask.blockedKind !== 'author-reclaimed';
  const pendingDispatch = Boolean(entry?.pendingDispatch);
  const key = baseUpdateKey({
    nodeId: pr.id, head: pr.headRefOid, baseTip: snapshot?.baseTipOid, releaseEpoch: pr.releaseEpoch,
  });
  const reason = (() => {
    if (pr.state !== 'OPEN' || pr.isDraft) return 'inactive';
    if (!isSyncableBase(pr.baseRefName)) return 'base-not-syncable';
    if (snapshot?.mergeable !== 'MERGEABLE') return 'not-mergeable';
    if (!strictBehind && !driftDue) {
      if (mergeState === 'BEHIND') return evidence.reason ?? snapshot?.reviewReason ?? 'gates-not-clear';
      if (!currentDrift) return 'drift-unknown';
      return currentDrift.behindBy === 0 ? 'up-to-date' : 'behind-below-threshold';
    }
    // A new head while the reviewer is reading the old one would throw its verdict away.
    if (blockers.includes('review-in-progress')) return 'review-in-progress';
    // Held for a maintainer: it is brought up to date when the discussion ends.
    if (blockers.includes('discussion-hold')) return 'discussion-hold';
    if ((fresh ?? []).length) return 'fresh-feedback';
    if (inFlight) return 'repair-in-flight';
    if (pendingDispatch) return 'pending-dispatch';
    if (entry?.needsHuman) return 'needs-human';
    if (entry?.dispatchConflict) return 'dispatch-conflict';
    const current = entry?.baseUpdate;
    if (current && current.key === key && ['reserved', 'accepted', 'uncertain', 'updated'].includes(current.status)) {
      return `already-${current.status}`;
    }
    // Held per head, not per base tip: a refusal that repeats (a token without the workflow scope while main changes
    // workflow files) would otherwise be retried on every merge into main.
    if (current && current.head === pr.headRefOid && current.status === 'failed'
      && Date.parse(now) - Date.parse(current.checkedAt ?? current.requestedAt) < BASE_SYNC_FAILED_COOLDOWN_MS) {
      return 'failed-cooldown';
    }
    // A last sync later than now (a clock set back) does not hold syncs off until the clock catches up.
    const sinceLastSync = Date.parse(now) - Date.parse(lastSyncAt ?? '');
    if (sinceLastSync >= 0 && sinceLastSync < BASE_SYNC_SPACING_MS) return 'spacing';
    return 'eligible';
  })();
  // Due but held back only by the spacing or a recent refusal: the PR has to be collected again at this time even
  // though nothing on GitHub changed, or it would wait for the next merge into main.
  const retryAt = reason === 'spacing' ? new Date(Date.parse(lastSyncAt) + BASE_SYNC_SPACING_MS).toISOString()
    : reason === 'failed-cooldown'
      ? new Date(Date.parse(entry.baseUpdate.checkedAt ?? entry.baseUpdate.requestedAt) + BASE_SYNC_FAILED_COOLDOWN_MS).toISOString()
      : null;
  return { eligible: reason === 'eligible', reason, key, now, strictBehind, driftDue, retryAt };
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
  pr, entry, snapshot, ghFn, ownershipSnapshot, save, now, dryRun = false, viewer, repo, drift = null, lastSyncAt = null,
}) {
  const plan = planBaseUpdate({ snapshot, entry, fresh: [], now, drift, lastSyncAt });
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
  // A snapshot taken from the round's batch read can be minutes old; update-branch writes to the PR, so its merge
  // state and base tip are read again for this one PR first.
  // A sync for drift does not need BEHIND (main never reports it); it only stops if the PR now conflicts, which
  // update-branch cannot merge and the repair session handles instead.
  if (mergeStateIsBatched(snapshot)) {
    const live = yield* readMergeState({ id: pr.id, ghFn });
    const liveState = String(live.mergeStateStatus ?? 'UNKNOWN').toUpperCase();
    const moved = plan.strictBehind && !plan.driftDue
      ? liveState !== 'BEHIND' || live.baseTipOid !== snapshot.baseTipOid
      : ['DIRTY', 'DRAFT'].includes(liveState);
    if (moved) return { entry, action: { attempted: false, reason: 'merge-state-changed', key: plan.key } };
  }
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

