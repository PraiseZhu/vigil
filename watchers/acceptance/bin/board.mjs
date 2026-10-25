#!/usr/bin/env node
// 看板只写「验收」「裁决」两个字段，其它字段一律不碰。

const ACCEPTANCE_VALUES = new Set(['验收中', '要修', '修正中', '通过']);

export async function setAcceptanceFields(github, profile, { repo, issue, acceptance, verdictUrl, round, ref }) {
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
    dedupeKey: `board:${parts.join(':')}`,
    repo,
    issue,
    ownerLogin: profile.ownerLogin,
    projectNumber: profile.projectNumber,
    fields,
    round,
    ref: issueRef,
  });
}
