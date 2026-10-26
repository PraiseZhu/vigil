#!/usr/bin/env node
// 通过（#46 SC4）：在子 issue 里勾掉验证过的验收项、黑盒项标「人工手测」，
// 再把看板「验收」写「通过」、「裁决」写本轮评论链接，最后才关总 issue。
// 顺序是 勾选 → 看板 → 关单：看板写失败就停在关单之前，issue 还开着、下一轮能接着验，不会「关了但看板没写」。
import fs from 'node:fs';
import { setAcceptanceFields } from './board.mjs';
import { collectTree, fetchIssueBody } from './collect.mjs';
import { createRounds, parseRef } from './rounds.mjs';
import { guardPass } from './checks.mjs';
import { assertNotVerdictOnly } from './profile.mjs';

const SC_LINE = /^\s*[-*]\s*(?:\[\s*([xX ])\s*\])?\s*(?:\*\*)?SC(\d+)\b/;
const MANUAL_SUFFIX = '人工手测';

/** 勾选：`- [ ] SCk` → `- [x] SCk`；人工手测项行尾补「 人工手测」。 */
export function applyTicks(body, { verified = [], manual = [] } = {}) {
  const tick = new Set(verified.map(Number));
  const mark = new Set(manual.map(Number));
  let changed = false;
  const lines = String(body ?? '')
    .split('\n')
    .map((line) => {
      const match = SC_LINE.exec(line);
      if (!match) return line;
      const sc = Number(match[2]);
      let out = line;
      if (tick.has(sc) && match[1] === ' ') {
        out = out.replace(/\[\s*\]/, '[x]');
        changed = true;
      }
      if (mark.has(sc) && !out.trimEnd().endsWith(MANUAL_SUFFIX)) {
        out = `${out.trimEnd()} ${MANUAL_SUFFIX}`;
        changed = true;
      }
      return out;
    });
  return { body: lines.join('\n'), changed };
}

function readVerified(file) {
  if (typeof file !== 'string' || !file) throw new Error('close 需要 --verified <file.json>');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`读不到已验证清单 ${file}：${error.message}`);
  }
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const manual = Array.isArray(parsed?.manual) ? parsed.manual : [];
  for (const entry of [...items, ...manual]) {
    if (typeof entry?.ref !== 'string' || !/^[\w.-]+\/[\w.-]+#\d+$/.test(entry.ref)) {
      throw new Error(`已验证清单里的 ref 不合法：${entry?.ref}`);
    }
    if (!Number.isInteger(entry.sc) || entry.sc <= 0) {
      throw new Error(`已验证清单里的 sc 不合法：${entry?.sc}`);
    }
  }
  return { items, manual, checks: parsed?.checks };
}

export async function runClose({ github, profile, ref, n, flags, now = () => Date.now(), stdout }) {
  const rounds = createRounds({ github, profile, now });
  const current = await rounds.check(ref, n);
  const tree = await collectTree({ github, profile, ref });
  if (tree.root.tier === 'watch') throw new Error('watch 档只出裁决、写看板');
  if (!tree.root.tier) throw new Error(`${tree.root.ref} 不在任何名单里`);
  assertNotVerdictOnly(profile, tree.root.ref, 'close');

  const verified = readVerified(flags.get('verified'));
  const grouped = new Map();
  for (const entry of verified.items) {
    if (!grouped.has(entry.ref)) grouped.set(entry.ref, { verified: [], manual: [] });
    grouped.get(entry.ref).verified.push(entry.sc);
  }
  for (const entry of verified.manual) {
    if (!grouped.has(entry.ref)) grouped.set(entry.ref, { verified: [], manual: [] });
    grouped.get(entry.ref).manual.push(entry.sc);
  }

  // 只动本轮任务树里的 issue：清单里混进树外的 issue 就整条拒绝，什么都不写。
  const inTree = new Set(tree.issues.map((entry) => entry.ref.toLowerCase()));
  for (const issueRef of grouped.keys()) {
    if (!inTree.has(issueRef.toLowerCase())) throw new Error(`${issueRef} 不在本轮任务树里，不能勾选`);
  }

  // 裁决防线：必需检查（build / typecheck / 测试）有一项因环境没跑，就不勾、不写看板、不关单，本轮标「中断」（环境问题）。
  await guardPass({ rounds, ref, n, checks: verified.checks, where: 'close 的 verified.json' });

  const edited = [];
  for (const [issueRef, changes] of grouped) {
    const fresh = await fetchIssueBody(github, issueRef);
    const ticked = applyTicks(fresh.body, changes);
    if (!ticked.changed) continue;
    const { repo, number } = parseRef(issueRef);
    await github.write({
      type: 'issue.edit',
      dedupeKey: `close-edit:${issueRef}:${n}`,
      repo,
      issue: number,
      body: ticked.body,
    });
    edited.push(issueRef);
  }

  const targets = [tree.root.ref, ...tree.issues.filter((entry) => entry.role !== 'root').map((entry) => entry.ref)];
  for (const target of targets) {
    const { repo, number } = parseRef(target);
    await setAcceptanceFields(github, profile, {
      repo,
      issue: number,
      acceptance: '通过',
      verdictUrl: current.url,
      round: n,
      ref: target,
    });
  }

  const root = parseRef(tree.root.ref);
  await github.write({
    type: 'issue.close',
    dedupeKey: `close:${tree.root.ref}:${n}`,
    repo: root.repo,
    issue: root.number,
    reason: 'completed',
  });

  stdout.write(`${JSON.stringify({ ref: tree.root.ref, round: n, closed: tree.root.ref, edited, board: targets })}\n`);
  return 0;
}
