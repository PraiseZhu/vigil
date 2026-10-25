#!/usr/bin/env node
// 收集（#46 SC1、SC8）：总 issue、子 issue、修正子 issue、验收项、关联 PR、有争议的条目。
// 只读：本文件不发任何写请求。
import { bodyVersion, parseRef } from './rounds.mjs';
import { repoTier } from './tasks.mjs';

export const MANUAL_LAYERS = Object.freeze(['cindy-mac', 'cindy-windows', 'paid', 'github-live']);

const COMMENT_FIELDS = 'id databaseId body url createdAt updatedAt author { login }';
const PR_FIELDS = 'number url mergedAt repository { nameWithOwner }';
const SUB_ISSUE_FIELDS = `number title body state url
        author { login }
        repository { nameWithOwner }
        comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
        closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }`;

export const ROOT_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number
      title
      body
      state
      url
      repository { nameWithOwner }
      comments(last: 100) { nodes { ${COMMENT_FIELDS} } }
      closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
      subIssues(first: 50) { nodes { ${SUB_ISSUE_FIELDS} } }
    }
  }
}`;

export const SEARCH_QUERY = `query ($q: String!) {
  search(type: ISSUE, first: 50, query: $q) {
    nodes {
      __typename
      ... on Issue {
        number
        title
        body
        state
        url
        author { login }
        repository { nameWithOwner }
        comments(last: 50) { nodes { ${COMMENT_FIELDS} } }
        closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
      }
    }
  }
}`;

export const ISSUE_BODY_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { title body state url }
  }
}`;

const ITEM_LINE = /^\s*[-*]\s*(?:\[\s*([xX ])\s*\])?\s*(?:\*\*)?SC(\d+)\b(?:\*\*)?\s*(.*)$/;
const LAYER_TOKEN = /^[^\s（(；;，,、]+/;
const TEST_POINT = /测试点：([^）)]+)/;
const MARKER = /\[验收机\]\s*修正\s*·\s*总\s+([^\s·]+#\d+)\s*·\s*项\s+([^\s·]+#\d+)\s*SC(\d+)\s*·\s*第\s*(\d+)\s*轮/;
const DISPUTE_ITEM = /([\w.-]+\/[\w.-]+#\d+)\s*SC(\d+)/;
// 验收轮只看最近一条已出裁决（通过 / 要修）的：本轮刚认领的「验收中」评论里还没有争议条目。
const ACCEPTANCE_FIRST_LINE = /^\[验收机\] 第 \d+ 轮：(通过|要修)/;
const CORRECTION_FIRST_LINE = /^\[修正机\] 第/;
const DISPUTE_MARK = '有争议';

function sameLogin(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function openState(state) {
  return String(state || '').toUpperCase() === 'CLOSED' ? 'closed' : 'open';
}

/** 验证层次：「验证：」后面那个像层次名的词（ASCII）；没有就往后找，都不像就是「未标层次」。 */
export function parseLayer(text) {
  const raw = String(text ?? '');
  const at = raw.indexOf('验证：');
  if (at === -1) return '未标层次';
  let from = at;
  while (from !== -1) {
    const rest = raw.slice(from + '验证：'.length).trim();
    const match = LAYER_TOKEN.exec(rest);
    // 正文里引用的「验证：」后面往往不是层次名，跳过继续找。
    if (match && /^[A-Za-z][A-Za-z0-9-]*$/.test(match[0])) return match[0];
    from = raw.indexOf('验证：', from + 1);
  }
  return '未标层次';
}

/** 测试点：「测试点：…」到右括号为止；没有就是 null。 */
export function parseTestPoint(text) {
  const match = TEST_POINT.exec(String(text ?? ''));
  return match ? match[1].trim() : null;
}

/** 解析 task-issue/v1 的 SC 行（`- [ ] SC3 文字`，也吃 `*`、加粗、已勾）。 */
export function parseItems(body, sourceRef) {
  const items = [];
  for (const rawLine of String(body ?? '').split('\n')) {
    const line = rawLine.trim();
    const match = ITEM_LINE.exec(line);
    if (!match) continue;
    const text = (match[3] || '').trim();
    const layer = parseLayer(text);
    items.push({
      source: sourceRef,
      sc: Number(match[2]),
      text,
      raw: line,
      checked: /[xX]/.test(match[1] || ''),
      layer,
      testPoint: parseTestPoint(text),
      manual: MANUAL_LAYERS.includes(layer),
    });
  }
  return items;
}

/** 修正标记：`[验收机] 修正 · 总 <root> · 项 <item> SC<k> · 第 n 轮`。 */
export function parseMarker(text) {
  const match = MARKER.exec(String(text ?? ''));
  if (!match) return null;
  return { root: match[1], item: match[2], sc: Number(match[3]), round: Number(match[4]) };
}

/** 只认我自己发的最新一条轮次评论。 */
function latestOwnRoundComment(comments, ownerLogin, firstLineRe) {
  const own = (comments || []).filter((comment) => {
    if (!sameLogin(comment?.author?.login, ownerLogin)) return false;
    const first = String(comment.body || '').split('\n')[0] || '';
    return firstLineRe.test(first);
  });
  own.sort((a, b) => {
    const ta = Date.parse(a.createdAt || 0) || 0;
    const tb = Date.parse(b.createdAt || 0) || 0;
    if (ta !== tb) return ta - tb;
    return (a.databaseId || 0) - (b.databaseId || 0);
  });
  return own.at(-1) || null;
}

function disputedLines(comment, source) {
  const out = [];
  for (const line of String(comment.body || '').split('\n').slice(1)) {
    if (!line.includes(DISPUTE_MARK)) continue;
    const match = DISPUTE_ITEM.exec(line);
    out.push({
      item: match ? `${match[1]} SC${Number(match[2])}` : null,
      text: line.trim(),
      source,
      url: comment.url,
    });
  }
  return out;
}

function prsOf(issue, fallbackRepo) {
  return (issue.closedByPullRequestsReferences?.nodes || []).map((pr) => ({
    ref: `${pr.repository?.nameWithOwner || fallbackRepo}#${pr.number}`,
    url: pr.url,
    mergedAt: pr.mergedAt || null,
  }));
}

export async function fetchIssueBody(github, ref) {
  const { owner, name, number } = parseRef(ref);
  const data = await github.graphql(ISSUE_BODY_QUERY, { owner, name, number });
  const issue = data?.repository?.issue;
  if (!issue) throw new Error(`找不到 ${ref}`);
  return { title: issue.title, body: issue.body || '', state: openState(issue.state), url: issue.url };
}

function searchQueries(rootRef, profile) {
  const phrase = `"[验收机] 修正 · 总 ${rootRef}" in:body is:issue`;
  const queries = [phrase];
  for (const forkRepo of profile.forkRepos || []) queries.push(`${phrase} repo:${forkRepo}`);
  return queries;
}

/**
 * 收集整棵任务树。`--issue` 永远是总 issue（独立 issue 就是它自己）。
 * 输出见 docs/acceptance-session.md。
 */
export async function collectTree({ github, profile, ref }) {
  const { owner, name, number } = parseRef(ref);
  const data = await github.graphql(ROOT_QUERY, { owner, name, number });
  const issue = data?.repository?.issue;
  if (!issue) throw new Error(`找不到 ${ref}`);

  const rootRepo = issue.repository?.nameWithOwner || `${owner}/${name}`;
  const rootRef = `${rootRepo}#${issue.number}`;
  const ownerLogin = profile.ownerLogin;
  const ranked = repoTier(rootRepo, profile) || { tier: null, fork: false };

  const subNodes = (issue.subIssues?.nodes || []).filter((node) => sameLogin(node?.author?.login, ownerLogin));
  const kind = subNodes.length >= 1 ? 'parent' : 'standalone';

  // 修正子 issue：挂着的子 issue + 没挂上但正文带标记的（跨仓、watch 档交接仓都靠搜索找）。
  const correctionsByRef = new Map();
  for (const node of subNodes) {
    const nodeRef = `${node.repository?.nameWithOwner || rootRepo}#${node.number}`;
    const marker = parseMarker(node.body);
    if (marker && marker.root === rootRef) correctionsByRef.set(nodeRef, { node, marker });
  }
  for (const query of searchQueries(rootRef, profile)) {
    const found = await github.graphql(SEARCH_QUERY, { q: query });
    for (const node of found?.search?.nodes || []) {
      if (node?.__typename && node.__typename !== 'Issue') continue;
      if (!sameLogin(node?.author?.login, ownerLogin)) continue;
      const marker = parseMarker(node.body);
      if (!marker || marker.root !== rootRef) continue;
      const nodeRef = `${node.repository?.nameWithOwner || rootRepo}#${node.number}`;
      if (!correctionsByRef.has(nodeRef)) correctionsByRef.set(nodeRef, { node, marker });
    }
  }

  const issues = [
    {
      ref: rootRef,
      role: 'root',
      title: issue.title,
      url: issue.url,
      state: openState(issue.state),
      items: parseItems(issue.body, rootRef),
      prs: prsOf(issue, rootRepo),
    },
  ];
  const seen = new Set([rootRef]);
  for (const node of subNodes) {
    const nodeRef = `${node.repository?.nameWithOwner || rootRepo}#${node.number}`;
    if (seen.has(nodeRef)) continue;
    seen.add(nodeRef);
    issues.push({
      ref: nodeRef,
      role: correctionsByRef.has(nodeRef) ? 'correction' : 'child',
      title: node.title,
      url: node.url,
      state: openState(node.state),
      items: parseItems(node.body, nodeRef),
      prs: prsOf(node, node.repository?.nameWithOwner || rootRepo),
    });
  }

  const corrections = [];
  for (const [nodeRef, entry] of correctionsByRef) {
    corrections.push({
      ref: nodeRef,
      url: entry.node.url,
      state: openState(entry.node.state),
      marker: entry.marker,
    });
  }

  const disputed = [];
  const rootRound = latestOwnRoundComment(issue.comments?.nodes, ownerLogin, ACCEPTANCE_FIRST_LINE);
  if (rootRound) disputed.push(...disputedLines(rootRound, 'acceptance'));
  for (const [, entry] of correctionsByRef) {
    const round = latestOwnRoundComment(entry.node.comments?.nodes, ownerLogin, CORRECTION_FIRST_LINE);
    if (round) disputed.push(...disputedLines(round, 'correction'));
  }

  const manual = issues.flatMap((entry) => entry.items.filter((item) => item.manual));

  return {
    root: {
      ref: rootRef,
      kind,
      title: issue.title,
      url: issue.url,
      state: openState(issue.state),
      bodyVersion: bodyVersion(issue.body),
      tier: ranked.tier,
      fork: Boolean(ranked.fork),
    },
    issues,
    corrections,
    disputed,
    manual,
  };
}
