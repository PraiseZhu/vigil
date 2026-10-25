#!/usr/bin/env node
// 有争议条目的裁决结果（#46 SC8）：只放在宿主状态目录 <home>/state/host/adjudications/ 里。
// 沙箱里整个 <home>/state 被遮掉，模型既读不到也写不了，所以下一轮看到的裁决一定是宿主解析、校验过的。
// 本模块只做路径、读写和「最近一次裁决里有没有争议」的判定，不起进程、不触网，bin/tasks.mjs 也用它。
import fs from 'node:fs';
import path from 'node:path';
import { parseRef } from '../bin/rounds.mjs';

export const RULINGS = Object.freeze(['成立', '不成立']);

/** 裁决里「有争议」那一行：`- 有争议：<owner/repo#n> SC<k> · 验收方：… · 修正方：…`（docs/acceptance-session.md）。 */
const DISPUTE_LINE = /^\s*[-*]\s*有争议：\s*([\w.-]+\/[\w.-]+#\d+)\s*SC(\d+)/;
const REF = /^[\w.-]+\/[\w.-]+#\d+$/;
const WHY_LIMIT = 500;

/** 一轮在宿主上的名字，和 host/round.mjs 的 roundKey 同一形状：<owner>__<repo>__<issue 号>__<轮次>。 */
export function adjudicationKey(issue, round) {
  const { owner, name, number } = parseRef(issue);
  return `${owner}__${name}__${number}__${Number(round)}`;
}

export function adjudicationPaths(home) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('adjudicationPaths 需要绝对路径的 home');
  const dir = path.join(home, 'state', 'host', 'adjudications');
  return {
    dir,
    runsDir: path.join(dir, 'runs'),
    locksDir: path.join(dir, 'locks'),
    notConfiguredFile: path.join(dir, 'not-configured.json'),
    resultFile: (issue, round) => path.join(dir, `${adjudicationKey(issue, round)}.json`),
    runFile: (issue, round) => path.join(dir, 'runs', `${adjudicationKey(issue, round)}.json`),
    lockFile: (issue, round) => path.join(dir, 'locks', `${adjudicationKey(issue, round)}.lock`),
  };
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 理由：一行、去掉控制字符、最多 500 字。 */
export function cleanWhy(value) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= WHY_LIMIT ? text : `${text.slice(0, WHY_LIMIT - 1)}…`;
}

function validItem(item) {
  return (
    item &&
    typeof item === 'object' &&
    typeof item.ref === 'string' &&
    REF.test(item.ref) &&
    Number.isInteger(item.sc) &&
    item.sc > 0 &&
    RULINGS.includes(item.ruling) &&
    typeof item.why === 'string'
  );
}

/** 读一轮的裁决结果；不存在或形状不对都当没有（宁可再等，不按坏结果走）。 */
export function readAdjudication(home, issue, round) {
  let file;
  try {
    file = adjudicationPaths(home).resultFile(issue, round);
  } catch {
    return null;
  }
  const data = readJson(file);
  if (!data || typeof data !== 'object' || !Array.isArray(data.items) || data.items.length === 0) return null;
  if (!data.items.every(validItem)) return null;
  return {
    file,
    issue: String(data.issue || issue),
    round: Number(data.round ?? round),
    at: typeof data.at === 'string' ? data.at : null,
    items: data.items.map((item) => ({ ref: item.ref, sc: item.sc, ruling: item.ruling, why: cleanWhy(item.why) })),
  };
}

export function writeAdjudication(home, issue, round, { items, at }) {
  const file = adjudicationPaths(home).resultFile(issue, round);
  const data = {
    version: 1,
    issue,
    round: Number(round),
    at,
    items: items.map((item) => ({ ref: item.ref, sc: item.sc, ruling: item.ruling, why: cleanWhy(item.why) })),
  };
  if (!data.items.length || !data.items.every(validItem)) throw new Error('裁决结果形状不对');
  writeJsonAtomic(file, data);
  return file;
}

/** 一条评论里的「有争议」条目（只认 docs/acceptance-session.md 的行格式），去重、保持顺序。 */
export function disputedItems(body) {
  const out = [];
  for (const line of String(body || '').split('\n').slice(1)) {
    const match = DISPUTE_LINE.exec(line);
    if (!match) continue;
    const item = `${match[1]} SC${Number(match[2])}`;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

/** profile.json 在 <home>/config/profile.json：home 从这里倒推，拿不到就是 null。 */
function homeOf(profile) {
  const file = profile?.profilePath;
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  return path.dirname(path.dirname(file));
}

/**
 * 最近一次出结论的轮次（通过 / 要修）里有没有「有争议」条目，以及宿主有没有给这一轮出过裁决结果。
 * 返回 `{ round, items: ['owner/repo#n SC<k>', …], adjudication: { round, items } | null }`，没有争议返回 null。
 * 只看我自己发的那条轮次评论（`rounds` 已经按 ownerLogin 过滤过，这里按 commentId 找回正文）。
 */
export function taskDispute({ comments, rounds, profile, ref }) {
  const finals = (rounds || []).filter((round) => round.status === '通过' || round.status === '要修');
  const last = [...finals].sort((a, b) => a.round - b.round).at(-1);
  if (!last) return null;
  const comment = (comments || []).find(
    (item) => (last.commentId != null && item?.databaseId === last.commentId) || (last.nodeId && item?.id === last.nodeId),
  );
  const items = disputedItems(comment?.body);
  if (!items.length) return null;
  const home = homeOf(profile);
  const result = home ? readAdjudication(home, ref, last.round) : null;
  return {
    round: last.round,
    items,
    adjudication: result ? { round: last.round, items: result.items } : null,
  };
}
