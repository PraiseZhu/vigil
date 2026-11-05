// Valid author handoffs for tests of downstream CI, dispatch and recovery behavior.
export function handoffPr(pr) {
  const value = { repo: process.env.MIVO_WATCHER_TARGET_REPO, state: 'OPEN', isDraft: false,
    sameRepository: true, author: { login: 'owner' }, createdAt: '2026-01-01T00:00:00Z', ...pr };
  const epoch = value.releaseEpoch ?? 'e';
  value.releaseEpoch = /^(ready|draft|opened):/.test(epoch) ? epoch
    : `ready:${value.id}:${epoch}:2026-09-01T00:00:00Z`;
  return value;
}

export function handoffReceipt(pr) {
  const p = handoffPr(pr);
  return { version: 1, id: `handoff-${p.id}`, repo: p.repo, number: p.number,
    nodeId: p.id, head: p.headRefOid, releaseEpoch: p.releaseEpoch, author: p.author.login };
}

export function withAuthorHandoff(collected, listed) {
  const pr = handoffPr({ ...listed, ...collected.pr });
  const receipt = handoffReceipt(pr);
  const epochAt = pr.releaseEpoch.match(/\d{4}-\d\d-\d\dT.*Z$/)?.[0] ?? pr.createdAt;
  const comment = { id: receipt.id, user: { login: pr.author.login, type: 'User' },
    created_at: new Date(Date.parse(epochAt) + 1000).toISOString(),
    body: `<!-- vigil-handoff ${JSON.stringify(receipt)} -->` };
  return { ...collected, pr, comments: [...(collected.comments ?? []), comment] };
}

// The follow beat's read of the repository's open PRs (a `repository{pullRequests}` read, served by the GitHub App).
// Nodes without an author get the test viewer 'owner'; a node of someone else is passed through with its own author.
export const isFollowBatch = (args) => args[0] === 'api' && args[1] === 'graphql'
  && args.some((arg) => String(arg).includes('pullRequests(states:OPEN') && !String(arg).includes('mergeStateStatus'));
export const followBatchBody = (nodes, { hasNextPage = false, endCursor = null } = {}) => JSON.stringify({ data: { repository: { pullRequests: {
  pageInfo: { hasNextPage, endCursor }, nodes: nodes.map((node) => ({ author: { login: 'owner' }, ...node })) } } } });

// The round's one batched merge-state read (a GraphQL search that selects mergeStateStatus). Test doubles that detect
// the follow-beat batch by `search(` must leave this one out, and can answer it with mergeBatchBody.
export const isMergeBatch = (args) => args[0] === 'api' && args[1] === 'graphql'
  && args.some((arg) => String(arg).includes('search(') && String(arg).includes('mergeStateStatus'));
export const mergeBatchBody = (prs, { status = 'CLEAN', tip = 'c'.repeat(40) } = {}) => JSON.stringify({ data: { search: {
  pageInfo: { hasNextPage: false, endCursor: null },
  nodes: prs.map((pr) => ({ id: pr.id, mergeStateStatus: typeof status === 'function' ? status(pr) : status, baseRef: { name: 'main', target: { oid: tip } } })) } } });

// The watcher's read of the open PRs into a head branch (`pulls?state=open&base=<head>`, looking for child PRs).
// Stubs answer it with `[[]]` (one empty page: none open) so a dispatch is not held back by a stub that never heard of it.
export const isChildPrList = (args) => args[0] === 'api' && String(args[1] ?? '').includes('/pulls?state=open&base=');
