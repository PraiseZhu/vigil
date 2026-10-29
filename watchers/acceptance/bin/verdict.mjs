#!/usr/bin/env node
// 裁决（#46 SC3）：把本轮的轮次评论就地改成「通过」或「要修」。
// 只在最后一步写：写完这一轮就结束了，后面的写命令都会被认领检查拒绝。
import fs from 'node:fs';
import path from 'node:path';
import { beijingIso, bodyVersion, cachePath, createRounds, lockPath, parseRef, readIssueCache } from './rounds.mjs';
import { collectTree, fetchIssueBody } from './collect.mjs';
import { isVerdictOnly } from './profile.mjs';
import { redact } from './redact.mjs';
import { readNeedsHuman } from './push.mjs';
import { guardPass } from './checks.mjs';

export const RESULTS = Object.freeze(['通过', '要修', '人工手测', '有争议']);

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function itemRef(item) {
  return `${item.ref} SC${item.sc}`;
}

function formatItem(item, profile) {
  const ref = itemRef(item);
  const evidence = redact(item.evidence || '', profile);
  if (item.result === '通过') {
    return `- 通过：${ref}${evidence ? ` · 证据：${evidence}` : ''}`;
  }
  if (item.result === '要修') {
    const why = redact(item.why || '', profile);
    const parts = [`- 要修：${ref}`];
    if (why) parts.push(`原因：${why}`);
    if (evidence) parts.push(`证据：${evidence}`);
    return parts.join(' · ');
  }
  if (item.result === '人工手测') {
    const layer = item.layer ? `（${redact(item.layer, profile)}）` : '';
    return `- 人工手测：${ref}${layer}`;
  }
  const sides = item.sides || {};
  return [
    `- 有争议：${ref}`,
    `验收方：${redact(sides.acceptance || '', profile)}`,
    `修正方：${redact(sides.correction || '', profile)}`,
  ].join(' · ');
}

/** 需人工处理的条目：只列文件名，不列密钥内容。 */
function formatNeedsHuman(entries, profile) {
  const lines = [];
  for (const entry of entries || []) {
    const files = (entry.files || []).map((file) => redact(file, profile)).filter(Boolean);
    if (files.length) lines.push(`- 扫到疑似密钥，没推：${files.join(', ')}`);
    else lines.push('- 扫到疑似密钥，没推（写闸在沙箱外扫到）');
  }
  return lines;
}

/** 批准执行推进、却没有 lead 交接的任务：等满 24 小时后照常验收，裁决里写明（#140）。 */
export const NO_HANDOFF_LINE = '批准执行没有交接评论，等满 24 小时后照常验收。';

/** lead 交接里「请重点查」的逐条结论（#140）：一条重点项一行，序号对齐交接里的编号。 */
function formatHandoffChecks(handoff, checks, profile) {
  if (!handoff?.focus?.length) return [];
  const byN = new Map((checks || []).map((check) => [Number(check.n), check]));
  const lines = ['## 交接重点核对', `对照 lead 交接第 ${handoff.n} 次：${redact(handoff.url || '', profile)}`];
  handoff.focus.forEach((focus, i) => {
    lines.push(`- ${i + 1}. ${redact(focus, profile)} → ${redact(byN.get(i + 1)?.result || '', profile)}`);
  });
  return lines;
}

/** 有交接重点项时，每一条都要有结论：返回缺结论的序号（从 1 起）。 */
export function missingHandoffChecks(handoff, checks = []) {
  const have = new Set((checks || []).filter((check) => String(check?.result || '').trim()).map((check) => Number(check.n)));
  return (handoff?.focus || []).map((_, i) => i + 1).filter((n) => !have.has(n));
}

/** 拼裁决正文。测试直接断言这一段。 */
export function formatVerdictBody({
  round,
  status,
  bodyVersion: version,
  startedAt,
  finishedAt,
  items = [],
  extracted = false,
  needsHuman = [],
  verdictOnly = false,
  approveExec = false,
  handoff = null,
  handoffChecks = [],
  profile,
} = {}) {
  const lines = [
    `[验收机] 第 ${round} 轮：${status}`,
    `正文版本：${version}`,
    `开始：${startedAt}`,
    `完成：${finishedAt}`,
    '',
    '## 逐条结果',
  ];
  for (const item of items) lines.push(formatItem(item, profile));
  if (extracted) {
    lines.push('本任务没写验收标准，以上标准由验收机从正文和关联 PR 提炼。');
  }
  if (approveExec && !handoff) lines.push(NO_HANDOFF_LINE);
  lines.push(...formatHandoffChecks(handoff, handoffChecks, profile));
  const human = formatNeedsHuman(needsHuman, profile);
  if (human.length) {
    lines.push('## 需人工处理');
    lines.push(...human);
  }
  if (verdictOnly) {
    lines.push('');
    lines.push(VERDICT_ONLY_LINE);
  }
  return lines.join('\n');
}

/** 只出裁决的 issue（profile 的 verdictOnlyIssues）：验收机不关单，裁决里写明由人复核。 */
export const VERDICT_ONLY_LINE = '本 issue 由人工复核后关闭。';

function conclusionKey(ref, sc) {
  return `${String(ref).toLowerCase()} SC${Number(sc)}`;
}

/**
 * 任务树里每条 SC 都要有一条结论（通过 / 要修 / 人工手测 / 有争议）：返回缺结论的条目（`owner/repo#n SC<k>`）。
 * 树是 collect 收到的那棵（总 issue、子 issue、挂着的修正子 issue）。
 */
export function missingConclusions(tree, items = []) {
  const have = new Set(items.map((item) => conclusionKey(item.ref, item.sc)));
  const missing = [];
  const seen = new Set();
  for (const issue of tree?.issues || []) {
    for (const item of issue.items || []) {
      const key = conclusionKey(item.source || issue.ref, item.sc);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!have.has(key)) missing.push(`${item.source || issue.ref} SC${item.sc}`);
    }
  }
  return missing;
}

export function deriveStatus(items = [], needsHuman = []) {
  // 一条结论都没有就不能判通过（以前空 items 会落到「通过」）。
  if (!items.length) throw new Error('裁决没有任何逐条结论，不能判通过：items 至少要有一条');
  if (needsHuman.length) return '要修';
  if (items.some((item) => item.result === '要修' || item.result === '有争议')) return '要修';
  return '通过';
}

function readVerdictFile(file) {
  if (typeof file !== 'string' || !file) throw new Error('verdict 需要 --file <verdict.json>');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`读不到裁决文件 ${file}：${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`裁决文件不是合法 JSON：${error.message}`);
  }
  if (!Array.isArray(parsed?.items)) throw new Error('裁决文件缺少 items 数组');
  for (const item of parsed.items) {
    if (typeof item?.ref !== 'string' || !/^[\w.-]+\/[\w.-]+#\d+$/.test(item.ref)) {
      throw new Error(`裁决项 ref 不合法：${item?.ref}`);
    }
    if (!Number.isInteger(item.sc) || item.sc <= 0) throw new Error(`裁决项 sc 不合法：${item?.sc}`);
    if (!RESULTS.includes(item.result)) throw new Error(`裁决项结果只能是 ${RESULTS.join(' / ')}：${item?.result}`);
  }
  if (parsed.handoffChecks !== undefined) {
    if (!Array.isArray(parsed.handoffChecks)) throw new Error('裁决文件的 handoffChecks 必须是数组 [{"n":1,"result":"…"}]');
    for (const check of parsed.handoffChecks) {
      if (!Number.isInteger(check?.n) || check.n <= 0) throw new Error(`handoffChecks 的 n 不合法：${check?.n}`);
    }
  }
  return parsed;
}

/** 跑 verdict：认领检查 → 拼正文 → 就地改轮次评论 → 放锁 → 更新缓存。 */
export async function runVerdict({ github, profile, ref, n, file, statusFlag, now = () => Date.now(), stdout }) {
  const rounds = createRounds({ github, profile, now });
  const current = await rounds.check(ref, n);
  const payload = readVerdictFile(file);
  const items = payload.items;
  if (!items.length) throw new Error('裁决文件的 items 是空的：任务树里每条 SC 都要有一条结论，空的不能判通过');
  // 写之前核对：collect 收到的任务树里每条 SC 都有结论，缺了就整条拒绝（退出码 1），什么都不写。
  const tree = await collectTree({ github, profile, ref });
  const missing = missingConclusions(tree, items);
  if (missing.length) {
    throw new Error(`裁决缺结论（通过 / 要修 / 人工手测 / 有争议），没写：${missing.join('、')}`);
  }
  // 批准执行 lead 交接里的「请重点查」每条都要有结论（#140），缺了同样整条拒绝、什么都不写。
  const missingFocus = missingHandoffChecks(tree.handoff, payload.handoffChecks);
  if (missingFocus.length) {
    throw new Error(`交接重点核对缺结论：lead 交接第 ${tree.handoff.n} 次「请重点查」第 ${missingFocus.join('、')} 条没写（verdict.json 的 handoffChecks）`);
  }
  const needsHuman = readNeedsHuman(profile, ref, n);
  const derived = deriveStatus(items, needsHuman);
  if (statusFlag !== undefined && statusFlag !== derived) {
    throw new Error(`--status 与逐条结果不一致：--status 是 ${statusFlag}，逐条结果是 ${derived}`);
  }
  if (statusFlag !== undefined && !['通过', '要修'].includes(statusFlag)) {
    throw new Error(`--status 只能是 通过 或 要修：${statusFlag}`);
  }
  const status = derived;
  // 裁决防线：判「通过」要写明必需检查；有一项因环境没跑（或「通过」条目的证据写着因环境没跑）就不判通过，
  // 本轮标「中断」（环境问题 / 未验证），退出码 6。「要修」不受影响：真的没过就是没过。
  if (status === '通过') {
    await guardPass({ rounds, ref, n, checks: payload.checks, items, where: 'verdict.json' });
  }

  // 正文版本按「现在」的正文算：验收机自己改了正文（勾选、关 issue），就用改后的版本。
  const fresh = await fetchIssueBody(github, ref);
  const verdictOnly = Boolean(tree.root.verdictOnly) || isVerdictOnly(profile, ref);
  // 「通过」必须先 close（SESSION.md §4）：总 issue 还开着就不写裁决（退出码 1），免得留下「通过但没关」、以后也不再验。
  if (status === '通过' && !verdictOnly && tree.root.tier !== 'watch' && fresh.state === 'open') {
    throw new Error(`判「通过」之前要先 close：${ref} 还开着，裁决不写（先跑 helper close，再写 verdict）`);
  }
  const version = bodyVersion(fresh.body);
  const body = formatVerdictBody({
    round: n,
    status,
    bodyVersion: version,
    startedAt: current.startedAt || beijingIso(now()),
    finishedAt: beijingIso(now()),
    items,
    extracted: Boolean(payload.extracted),
    needsHuman,
    verdictOnly,
    approveExec: Boolean(tree.root.approveExec),
    handoff: tree.handoff || null,
    handoffChecks: payload.handoffChecks || [],
    profile,
  });

  const { repo } = parseRef(ref);
  const updated = await github.write({
    type: 'comment.update',
    // 带评论 id：同号的轮次（旧评论被删后重新认领）不会命中上一条评论的账本记录。
    dedupeKey: `verdict:${ref}:${n}:${current.commentId}:${status}`,
    repo,
    commentId: current.commentId,
    body,
  });

  try {
    fs.unlinkSync(lockPath(profile, ref));
  } catch {
    // 锁不在了就算释放。
  }
  const cache = readIssueCache(profile, ref) || {};
  atomicWrite(
    cachePath(profile, ref),
    JSON.stringify(
      {
        ...cache,
        round: {
          ...(cache.round || {}),
          round: n,
          commentId: current.commentId,
          finishedAt: beijingIso(now()),
        },
        lastVerdict: status,
      },
      null,
      2,
    ),
  );

  if (stdout) stdout.write(`${JSON.stringify({ status, url: updated?.url ?? current.url })}\n`);
  return status;
}
