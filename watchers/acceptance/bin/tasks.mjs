#!/usr/bin/env node
// 盘点：一次 GraphQL 拉开放/关闭 issue，组成我建的任务树，并按名单分档。
import { bodyVersion, parseRounds } from './rounds.mjs';

const ISSUE_FIELDS = `id
        number
        title
        body
        state
        url
        createdAt
        closedAt
        updatedAt
        author { login }
        repository { nameWithOwner }
        parent { number repository { nameWithOwner } author { login } }
        subIssues(first: 50) {
          nodes {
            number
            title
            state
            url
            closedAt
            author { login }
            repository { nameWithOwner }
          }
        }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
          nodes {
            number
            url
            mergedAt
            repository { nameWithOwner }
          }
        }
        comments(last: 50) {
          nodes {
            id
            databaseId
            body
            createdAt
            updatedAt
            url
            author { login }
          }
        }`;

export const INVENTORY_QUERY = `query ($owner: String!, $since: DateTime, $openAfter: String, $closedAfter: String) {
  user(login: $owner) {
    open: issues(first: 100, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}, after: $openAfter) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
    closed: issues(first: 100, states: CLOSED, filterBy: {since: $since}, orderBy: {field: UPDATED_AT, direction: DESC}, after: $closedAfter) {
      nodes { ${ISSUE_FIELDS} }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function matchesPattern(repo, pattern) {
  if (!repo || !pattern) return false;
  const [owner, name] = String(repo).toLowerCase().split('/');
  const [pOwner, pName] = String(pattern).toLowerCase().split('/');
  if (owner !== pOwner) return false;
  return pName === '*' || name === pName;
}

/** 仓分档：autoRepos / forkRepos → auto，watchRepos → watch，都不在 → null。 */
export function repoTier(repo, profile) {
  const autoRepos = profile.autoRepos || [];
  const forkRepos = profile.forkRepos || [];
  const watchRepos = profile.watchRepos || [];
  if (forkRepos.some((pattern) => matchesPattern(repo, pattern))) {
    return { tier: 'auto', fork: true };
  }
  if (autoRepos.some((pattern) => matchesPattern(repo, pattern))) {
    return { tier: 'auto', fork: false };
  }
  if (watchRepos.some((pattern) => matchesPattern(repo, pattern))) {
    return { tier: 'watch', fork: false };
  }
  return null;
}

export { bodyVersion };


function loginOf(author) {
  return String(author?.login || '');
}

function sameLogin(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function issueRef(repo, number) {
  return `${repo}#${number}`;
}

function asIssueList(connection) {
  return connection?.nodes || [];
}

function isRoot(issue, ownerLogin) {
  const parent = issue.parent;
  if (!parent) return true;
  // 父作者不是我 → 当根；本查询拿不到父作者时按「父缺失」处理。
  if (!parent.author) return true;
  return !sameLogin(loginOf(parent.author), ownerLogin);
}

function toTask(issue, profile) {
  const repo = issue.repository?.nameWithOwner;
  const ranked = repoTier(repo, profile);
  if (!ranked) return null;
  if (!sameLogin(loginOf(issue.author), profile.ownerLogin)) return null;
  if (!isRoot(issue, profile.ownerLogin)) return null;
  if (issue.state === 'CLOSED' && issue.closedAt && Date.parse(issue.closedAt) < Date.parse(profile.startAt)) {
    return null;
  }
  const ownerChildren = (issue.subIssues?.nodes || []).filter((child) =>
    sameLogin(loginOf(child.author), profile.ownerLogin),
  );
  const kind = ownerChildren.length >= 1 ? 'parent' : 'standalone';
  return {
    ref: issueRef(repo, issue.number),
    repo,
    number: issue.number,
    kind,
    tier: ranked.tier,
    fork: ranked.fork,
    state: issue.state === 'CLOSED' ? 'closed' : 'open',
    closedAt: issue.closedAt || null,
    url: issue.url,
    nodeId: issue.id,
    body: issue.body || '',
    bodyVersion: bodyVersion(issue.body),
    children: ownerChildren.map((child) => ({
      ref: issueRef(child.repository?.nameWithOwner || repo, child.number),
      state: child.state === 'CLOSED' ? 'closed' : 'open',
      closedAt: child.closedAt || null,
      url: child.url,
    })),
    linkedPrs: (issue.closedByPullRequestsReferences?.nodes || []).map((pr) => ({
      ref: issueRef(pr.repository?.nameWithOwner || repo, pr.number),
      mergedAt: pr.mergedAt || null,
      url: pr.url,
    })),
    rounds: parseRounds(issue.comments?.nodes || [], profile.ownerLogin),
  };
}

async function fetchInventory(github, profile, { openAfter = null, closedAfter = null } = {}) {
  const data = await github.graphql(INVENTORY_QUERY, {
    owner: profile.ownerLogin,
    since: profile.startAt,
    openAfter,
    closedAfter,
  });
  const user = data.user || data;
  return {
    open: user.open || { nodes: [], pageInfo: { hasNextPage: false } },
    closed: user.closed || { nodes: [], pageInfo: { hasNextPage: false } },
  };
}

/** 收集我建的、落在分档名单里的根任务。 */
export async function collectTasks(github, profile) {
  const seen = new Map();
  let openAfter = null;
  let closedAfter = null;
  let openDone = false;
  let closedDone = false;
  while (!openDone || !closedDone) {
    const page = await fetchInventory(github, profile, {
      openAfter: openDone ? openAfter : openAfter,
      closedAfter: closedDone ? closedAfter : closedAfter,
    });
    for (const issue of [...asIssueList(page.open), ...asIssueList(page.closed)]) {
      const key = `${issue.repository?.nameWithOwner}#${issue.number}`;
      if (!seen.has(key)) seen.set(key, issue);
    }
    if (!openDone) {
      if (page.open.pageInfo?.hasNextPage) openAfter = page.open.pageInfo.endCursor;
      else openDone = true;
    }
    if (!closedDone) {
      if (page.closed.pageInfo?.hasNextPage) closedAfter = page.closed.pageInfo.endCursor;
      else closedDone = true;
    }
    if (openDone && closedDone) break;
  }
  const tasks = [];
  for (const issue of seen.values()) {
    const task = toTask(issue, profile);
    if (task) tasks.push(task);
  }
  return tasks;
}
