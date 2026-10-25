#!/usr/bin/env node
// 裁决（#46 SC3）：把本轮的轮次评论就地改成「通过」或「要修」。
// 只在最后一步写：写完这一轮就结束了，后面的写命令都会被认领检查拒绝。
import fs from 'node:fs';
import path from 'node:path';
import { bodyVersion, cachePath, createRounds, lockPath, parseRef, readIssueCache } from './rounds.mjs';
import { fetchIssueBody } from './collect.mjs';
import { redact } from './redact.mjs';
import { readNeedsHuman } from './push.mjs';

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
  const human = formatNeedsHuman(needsHuman, profile);
  if (human.length) {
    lines.push('## 需人工处理');
    lines.push(...human);
  }
  return lines.join('\n');
}

export function deriveStatus(items = [], needsHuman = []) {
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
  return parsed;
}

/** 跑 verdict：认领检查 → 拼正文 → 就地改轮次评论 → 放锁 → 更新缓存。 */
export async function runVerdict({ github, profile, ref, n, file, statusFlag, now = () => Date.now(), stdout }) {
  const rounds = createRounds({ github, profile, now });
  const current = await rounds.check(ref, n);
  const payload = readVerdictFile(file);
  const items = payload.items;
  const needsHuman = readNeedsHuman(profile, ref, n);
  const derived = deriveStatus(items, needsHuman);
  if (statusFlag !== undefined && statusFlag !== derived) {
    throw new Error(`--status 与逐条结果不一致：--status 是 ${statusFlag}，逐条结果是 ${derived}`);
  }
  if (statusFlag !== undefined && !['通过', '要修'].includes(statusFlag)) {
    throw new Error(`--status 只能是 通过 或 要修：${statusFlag}`);
  }
  const status = derived;

  // 正文版本按「现在」的正文算：验收机自己改了正文（勾选、关 issue），就用改后的版本。
  const fresh = await fetchIssueBody(github, ref);
  const version = bodyVersion(fresh.body);
  const body = formatVerdictBody({
    round: n,
    status,
    bodyVersion: version,
    startedAt: current.startedAt || new Date(now()).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    items,
    extracted: Boolean(payload.extracted),
    needsHuman,
    profile,
  });

  const { repo } = parseRef(ref);
  const updated = await github.write({
    type: 'comment.update',
    dedupeKey: `verdict:${ref}:${n}:${status}`,
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
          finishedAt: new Date(now()).toISOString(),
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
