#!/usr/bin/env node
// 盘点：一次 GraphQL 拉开放/关闭 issue，组成我建的任务树，并按名单分档。
import { parseMarker } from './collect.mjs';
import { bodyVersion, latestRound, parseRounds } from './rounds.mjs';
import { lastFinal, shouldTrigger } from './trigger.mjs';
import { isTrustedAuthor } from './trusted-author.mjs';
import { taskDispute } from '../host/adjudication-store.mjs';

const ISSUE_FIELDS = `id
        number
        title
        body
        state
        url
        createdAt
        closedAt
        updatedAt
        author { login __typename }
        repository { nameWithOwner defaultBranchRef { name } }
        parent { number repository { nameWithOwner } author { login __typename } }
        subIssues(first: 50) {
          nodes {
            number
            title
            state
            url
            closedAt
            author { login __typename }
            repository { nameWithOwner }
          }
        }
        closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
          nodes {
            number
            url
            mergedAt
            baseRefName
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
            author { login __typename }
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

function issueRef(repo, number) {
  return `${repo}#${number}`;
}

/**
 * 仓库的默认分支：盘点里带了 `defaultBranchRef.name` 就用它；取不到（权限挡掉、老查询）才退 `'main'`。
 * 默认分支不一定叫 main（组织仓、`main` 之后的默认分支都能改），判断「PR 合到哪个分支」必须用它。
 */
export function defaultBranchOf(issue) {
  const name = issue?.repository?.defaultBranchRef?.name;
  return typeof name === 'string' && name.trim() ? name.trim() : 'main';
}

/** 关联 PR 的合并目标分支：字段没取到（老查询 / 被挡掉）是 null，调用方按「不知道」处理。 */
function baseOf(pr) {
  const base = pr?.baseRefName;
  return typeof base === 'string' && base.trim() ? base.trim() : null;
}

/** issue 节点上的关联 PR（含合并目标分支）。只做形状转换，不发请求。 */
function linkedPrsOf(issue, repo) {
  return (issue?.closedByPullRequestsReferences?.nodes || []).map((pr) => ({
    ref: issueRef(pr.repository?.nameWithOwner || repo, pr.number),
    mergedAt: pr.mergedAt || null,
    url: pr.url,
    base: baseOf(pr),
  }));
}

/**
 * 父单用：子 issue 已合并 PR 的目标分支，数据来自同一份盘点里这个子单自己的节点（不额外发请求）。
 * 盘点里没有这个子单（关闭时间早于 startAt、作者不是我）时返回 null = 不知道它合到了哪。
 */
function childPrBase(childRef, byKey) {
  const node = byKey?.get(childRef);
  if (!node) return null;
  const repo = node.repository?.nameWithOwner || childRef.slice(0, childRef.lastIndexOf('#'));
  return {
    defaultBranch: defaultBranchOf(node),
    mergedPrs: linkedPrsOf(node, repo)
      .filter((pr) => pr.mergedAt)
      .map((pr) => ({ ref: pr.ref, base: pr.base })),
  };
}

// 批准执行（approve-exec）的交接（#140）：lead 派出 owner 会话时在总 issue 上发「批准执行登记：…」，
// 验收总 issue 通过后发「[批准执行] 交接验收 · 第 n 次」。只认本人（ownerLogin）和配置的 App bot 发的，别人发同样首行的评论不算。
export const APPROVE_EXEC_REGISTRATION = '批准执行登记：';
/** 只看总 issue 最近这么多条评论：和盘点查询的 `comments(last: 50)` 一致，collect 拉了 100 条也只按这 50 条判断（#140「不做」）。 */
export const LEAD_HANDOFF_COMMENT_WINDOW = 50;
export const LEAD_HANDOFF_FIRST_LINE = /^\[批准执行\] 交接验收 · 第 (\d+) 次\s*$/;

function byTime(a, b) {
  const ta = Date.parse(a.createdAt || 0) || 0;
  const tb = Date.parse(b.createdAt || 0) || 0;
  if (ta !== tb) return ta - tb;
  return (a.databaseId || 0) - (b.databaseId || 0);
}

/** 交接评论「## 请重点查」一节下的编号列表（到下一个二级标题为止），每条取原文。 */
export function handoffFocus(body) {
  const focus = [];
  let inSection = false;
  for (const line of String(body ?? '').split('\n')) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s*请重点查\s*$/.test(line.trim());
      continue;
    }
    if (!inSection) continue;
    const match = /^\s*\d+\.\s+(.+?)\s*$/.exec(line);
    if (match) focus.push(match[1]);
  }
  return focus;
}

/**
 * 总 issue 的评论 → 最近一条登记的时间、最新一条交接（{url, createdAt, n, focus}）；没有就是 null。
 * 早于最后一条登记的交接不算（之后又派了会话，旧交接已过期）：trigger、collect、verdict 都按「没有交接」处理。
 */
export function leadHandoffOf(comments, profile) {
  const recent = [...(comments || [])].sort(byTime).slice(-LEAD_HANDOFF_COMMENT_WINDOW);
  const own = recent.filter((comment) => isTrustedAuthor(comment?.author, profile));
  const registration = own.filter((comment) => String(comment.body || '').startsWith(APPROVE_EXEC_REGISTRATION)).at(-1);
  const handoffs = own.filter((comment) => LEAD_HANDOFF_FIRST_LINE.test(String(comment.body || '').split('\n')[0]));
  const latest = handoffs.filter((comment) => !registration || byTime(comment, registration) > 0).at(-1);
  return {
    registeredAt: registration?.createdAt || null,
    handoff: latest
      ? {
          url: latest.url || null,
          createdAt: latest.createdAt || null,
          n: Number(LEAD_HANDOFF_FIRST_LINE.exec(String(latest.body).split('\n')[0])[1]),
          focus: handoffFocus(latest.body),
        }
      : null,
  };
}

function asIssueList(connection) {
  return connection?.nodes || [];
}

function isRoot(issue, profile) {
  const parent = issue.parent;
  if (!parent) return true;
  // 父作者不是本人 / 配置的 App bot → 当根；本查询拿不到父作者时按「父缺失」处理。
  if (!parent.author) return true;
  return !isTrustedAuthor(parent.author, profile);
}

/**
 * 父作者是 owner 的子 issue：已关闭、至少一个关联 PR 已合并、正文不是修正标记时，
 * 单独成 kind=child。父的最新轮次和最后结论从同一份清单里的父节点算，不再发请求。
 * 其余子 issue 仍丢弃。父节点不在这份清单里时，父状态留空，不把「没看到」当成验收中或已覆盖。
 */
function toChildTask(issue, profile, ranked, repo, byKey) {
  if (issue.state !== 'CLOSED') return null;
  if (issue.closedAt && Date.parse(issue.closedAt) < Date.parse(profile.startAt)) return null;
  const linkedPrs = linkedPrsOf(issue, repo);
  if (!linkedPrs.some((pr) => pr.mergedAt)) return null;
  if (parseMarker(issue.body) != null) return null;

  const ownerChildren = (issue.subIssues?.nodes || []).filter((child) =>
    isTrustedAuthor(child.author, profile),
  );
  const outOfScope = [
    ...new Set(
      ownerChildren
        .map((child) => child.repository?.nameWithOwner || repo)
        .filter((childRepo) => !repoTier(childRepo, profile)),
    ),
  ];
  const ref = issueRef(repo, issue.number);
  const rounds = parseRounds(issue.comments?.nodes || [], profile);
  const lead = leadHandoffOf(issue.comments?.nodes, profile);
  const parent = issue.parent || {};
  const parentRepo = parent.repository?.nameWithOwner || repo;
  const parentRef = parent.number ? issueRef(parentRepo, parent.number) : null;
  const parentIssue = parentRef && byKey ? byKey.get(parentRef) : null;
  const parentRounds = parentIssue ? parseRounds(parentIssue.comments?.nodes || [], profile) : [];
  const parentLatest = latestRound(parentRounds);
  const parentFinal = lastFinal(parentRounds);
  return {
    ref,
    repo,
    number: issue.number,
    kind: 'child',
    tier: ranked.tier,
    fork: ranked.fork,
    state: 'closed',
    closedAt: issue.closedAt || null,
    url: issue.url,
    nodeId: issue.id,
    body: issue.body || '',
    bodyVersion: bodyVersion(issue.body),
    defaultBranch: defaultBranchOf(issue),
    children: ownerChildren.map((child) => {
      const childRef = issueRef(child.repository?.nameWithOwner || repo, child.number);
      return {
        ref: childRef,
        state: child.state === 'CLOSED' ? 'closed' : 'open',
        closedAt: child.closedAt || null,
        url: child.url,
        prBase: childPrBase(childRef, byKey),
      };
    }),
    linkedPrs,
    rounds,
    outOfScope,
    leadHandoff: { registeredAt: lead.registeredAt, handoffAt: lead.handoff?.createdAt || null },
    dispute: taskDispute({ comments: issue.comments?.nodes, rounds, profile, ref }),
    parentRef,
    parentLatestStatus: parentLatest?.status || null,
    parentFinalFinishedAt: parentFinal?.finishedAt || null,
  };
}

function toTask(issue, profile, byKey) {
  const repo = issue.repository?.nameWithOwner;
  const ranked = repoTier(repo, profile);
  if (!ranked) return null;
  if (!isTrustedAuthor(issue.author, profile)) return null;
  if (!isRoot(issue, profile)) {
    const childTask = toChildTask(issue, profile, ranked, repo, byKey);
    if (childTask) return childTask;
    // #363：open 子 issue 里只有「验收机走过一轮、最后结论要修、此后修正子已关或正文已改」这一类放回根任务路径。
    // 其余 open 子 issue 和以前一样丢弃。
    if (issue.state !== 'OPEN') return null;
    const reaccept = toRootTask(issue, profile, ranked, repo);
    return openChildReaccepts(reaccept, profile) ? reaccept : null;
  }
  if (issue.state === 'CLOSED' && issue.closedAt && Date.parse(issue.closedAt) < Date.parse(profile.startAt)) {
    return null;
  }
  return toRootTask(issue, profile, ranked, repo);
}

/**
 * #363：open 子 issue 的重验资格。只放行「最后结论是要修」并且「既有触发规则判为 body-changed 或
 * children-closed-after-verdict」这一类。比较规则不在这里重写：直接问 shouldTrigger，只接受这两个 reason，
 * 免得和 trigger 里那套时间/正文比较各写一份、以后漂移。
 */
const OPEN_CHILD_REACCEPT_REASONS = Object.freeze(['body-changed', 'children-closed-after-verdict']);

function openChildReaccepts(task, profile) {
  if (lastFinal(task.rounds)?.status !== '要修') return false;
  const decision = shouldTrigger(task, { now: () => Date.now(), profile });
  return decision.trigger === true && OPEN_CHILD_REACCEPT_REASONS.includes(decision.reason);
}

/** 根任务形状（standalone / parent）：收哪些字段、怎么算轮次都在这里，open 子 issue 放行后复用同一份。 */
function toRootTask(issue, profile, ranked, repo) {
  const ownerChildren = (issue.subIssues?.nodes || []).filter((child) =>
    isTrustedAuthor(child.author, profile),
  );
  const kind = ownerChildren.length >= 1 ? 'parent' : 'standalone';
  // 任务树里有不在任何名单里的仓：写闸按仓拒绝读写它，验收走不完（裁决出了、issue 却关不上），所以不派发、只提醒。
  const outOfScope = [
    ...new Set(
      ownerChildren
        .map((child) => child.repository?.nameWithOwner || repo)
        .filter((childRepo) => !repoTier(childRepo, profile)),
    ),
  ];
  const ref = issueRef(repo, issue.number);
  const rounds = parseRounds(issue.comments?.nodes || [], profile);
  const lead = leadHandoffOf(issue.comments?.nodes, profile);
  return {
    ref,
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
    defaultBranch: defaultBranchOf(issue),
    children: ownerChildren.map((child) => {
      const childRef = issueRef(child.repository?.nameWithOwner || repo, child.number);
      return {
        ref: childRef,
        state: child.state === 'CLOSED' ? 'closed' : 'open',
        closedAt: child.closedAt || null,
        url: child.url,
        prBase: childPrBase(childRef, byKey),
      };
    }),
    linkedPrs: linkedPrsOf(issue, repo),
    rounds,
    outOfScope,
    // 批准执行推进的任务：最近一条登记、最新一条 lead 交接（#140）。trigger 据此在 lead 交接前不开轮。
    leadHandoff: { registeredAt: lead.registeredAt, handoffAt: lead.handoff?.createdAt || null },
    // 最近一次裁决里的「有争议」条目和宿主的裁决结果（#46 SC8）：trigger 据此等裁决、裁决出来后触发下一轮。
    dispute: taskDispute({ comments: issue.comments?.nodes, rounds, profile, ref }),
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
    const task = toTask(issue, profile, seen);
    if (task) tasks.push(task);
  }
  return tasks;
}
