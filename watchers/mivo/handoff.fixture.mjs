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
