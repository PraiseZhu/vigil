#!/usr/bin/env node
// 看板只写「验收」「裁决」两个字段，其它字段一律不碰。

const ACCEPTANCE_VALUES = new Set(['验收中', '要修', '修正中', '通过']);

/**
 * 写「验收」「裁决」。`root`（总 issue）和 `dedupeKey` 可选：宿主认领时写「验收中」走写闸 exec 模式，
 * 写闸靠 root 找到本轮任务树；去重键带上认领评论 id，同号的轮次不会命中旧记录。
 */
export async function setAcceptanceFields(github, profile, { repo, issue, acceptance, verdictUrl, round, ref, root, dedupeKey }) {
  if (acceptance !== undefined && !ACCEPTANCE_VALUES.has(acceptance)) {
    throw new Error(`非法验收字段值：${acceptance}`);
  }
  const fields = {};
  if (acceptance !== undefined) fields['验收'] = acceptance;
  if (verdictUrl !== undefined) fields['裁决'] = verdictUrl;
  const issueRef = ref || `${repo}#${issue}`;
  const parts = [issueRef, acceptance || '', verdictUrl || '', round ?? ''];
  return github.write({
    type: 'project.field.set',
    dedupeKey: dedupeKey || `board:${parts.join(':')}`,
    ...(root ? { root } : {}),
    repo,
    issue,
    ownerLogin: profile.ownerLogin,
    projectNumber: profile.projectNumber,
    fields,
    round,
    ref: issueRef,
  });
}

/** 只读查看板上某个 issue 的「验收」当前值（纯 query）。 */
export const ACCEPTANCE_VALUE_QUERY = `query ($login: String!, $projectNumber: Int!, $owner: String!, $name: String!, $issue: Int!) {
  user(login: $login) {
    projectV2(number: $projectNumber) { id }
  }
  repository(owner: $owner, name: $name) {
    issue(number: $issue) {
      projectItems(first: 20, includeArchived: true) {
        nodes {
          isArchived
          project { id }
          fieldValueByName(name: "验收") {
            __typename
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}`;

/**
 * 读看板「验收」当前值：条目不在看板、已归档或没填时返回 null。只读，不经写闸。
 * 用账号令牌查（App 令牌看不到个人账号下的看板，同 doctor）；注入的 github 没有 ownerGraphql 时退回读令牌。
 */
export async function readAcceptanceField(github, profile, { repo, issue }) {
  const [owner, name] = String(repo).split('/');
  const query = typeof github.ownerGraphql === 'function' ? github.ownerGraphql.bind(github) : github.graphql.bind(github);
  const data = await query(ACCEPTANCE_VALUE_QUERY, {
    login: profile.ownerLogin,
    projectNumber: Number(profile.projectNumber),
    owner,
    name,
    issue: Number(issue),
  });
  const projectId = data?.user?.projectV2?.id;
  if (!projectId) throw new Error(`找不到看板 #${profile.projectNumber}`);
  const issueNode = data?.repository?.issue;
  if (!issueNode) throw new Error(`找不到 issue ${repo}#${issue}`);
  const item = (issueNode.projectItems?.nodes || []).find((node) => node?.project?.id === projectId);
  if (!item || item.isArchived) return null;
  return typeof item.fieldValueByName?.name === 'string' ? item.fieldValueByName.name : null;
}
