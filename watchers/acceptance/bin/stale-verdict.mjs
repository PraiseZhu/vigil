// 判卡死前先看本地结论：写闸账本、issue 缓存、session 结束标记，以及盘点快照里已有的关单 / 终态。
// 只读本地（或调用方已经拿到的 task 快照），不发 GitHub 请求。
import fs from 'node:fs';
import { sessionPath } from './push.mjs';
import { readIssueCache } from './rounds.mjs';
import { readLedgerLines } from '../host/gate-audit.mjs';

export const FINAL_STATUSES = Object.freeze(['通过', '要修', '中断']);

const ISSUE_REF = '([^/]+/[^#]+#\\d+)';
const FINISH_KEY = new RegExp(`^round-finish:${ISSUE_REF}:(\\d+):(\\d+):(通过|要修|中断)$`);
const CLOSE_KEY = new RegExp(`^close:${ISSUE_REF}:(\\d+)$`);
const START_KEY = new RegExp(`^round-start:${ISSUE_REF}:(\\d+):`);
const ABORT_FINAL = /实际第 \d+ 轮（(通过|要修|中断)）/;

function stampMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : null;
}

function sameIssueRound(issue, round, otherIssue, otherRound) {
  return String(otherIssue || '') === String(issue || '') && Number(otherRound) === Number(round);
}

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从账本去重键里拆出 round-finish 的 issue / 轮次 / 评论 id / 终态。对不上返回 null。 */
export function parseFinishKey(dedupeKey) {
  const match = FINISH_KEY.exec(String(dedupeKey || ''));
  if (!match) return null;
  return { issue: match[1], round: Number(match[2]), commentId: Number(match[3]), status: match[4] };
}

/** 从账本去重键里拆出 issue.close 的 issue / 轮次。对不上返回 null。 */
export function parseCloseKey(dedupeKey) {
  const match = CLOSE_KEY.exec(String(dedupeKey || ''));
  if (!match) return null;
  return { issue: match[1], round: Number(match[2]) };
}

/**
 * 读写闸账本（坏行跳过，文件不存在当空）。读失败返回空数组，不抛，避免卡死检测自己把这一拍打挂。
 */
export function loadLedgerEntries(paths) {
  if (!paths?.ledgerFile) return [];
  try {
    return readLedgerLines(paths.ledgerFile).entries;
  } catch {
    return [];
  }
}

/**
 * 只根据已经读好的账本行，看这一轮是否已经出结论或关单。
 * `commentId` 有的话只认同一条轮次评论的 finish（同号重认领不会被上一轮的结论挡住）。
 * `issue.close` 没有评论 id：若同号在关单之后又有新的 round-start，关单不算数。
 */
export function ledgerVerdict(entries, issue, round, { commentId } = {}) {
  let finish = null;
  let close = null;
  let latestStartMs = null;
  for (const entry of entries || []) {
    if (!entry) continue;
    const key = entry.dedupeKey;
    const at = stampMs(entry.at);
    const finishHit = parseFinishKey(key);
    if (finishHit && sameIssueRound(issue, round, finishHit.issue, finishHit.round)) {
      if (commentId != null && Number(commentId) !== finishHit.commentId) continue;
      if (!entry.type || entry.type === 'comment.update') {
        if (!finish || (at != null && (stampMs(finish.at) == null || at >= stampMs(finish.at)))) {
          finish = { ...finishHit, at: entry.at ?? null };
        }
      }
      continue;
    }
    const closeHit = parseCloseKey(key);
    if (closeHit && sameIssueRound(issue, round, closeHit.issue, closeHit.round)) {
      if (!entry.type || entry.type === 'issue.close') {
        if (!close || (at != null && (stampMs(close.at) == null || at >= stampMs(close.at)))) {
          close = { ...closeHit, at: entry.at ?? null };
        }
      }
      continue;
    }
    const startHit = START_KEY.exec(String(key || ''));
    if (startHit && sameIssueRound(issue, round, startHit[1], startHit[2])) {
      if (at != null && (latestStartMs == null || at >= latestStartMs)) latestStartMs = at;
    }
  }
  if (close && latestStartMs != null) {
    const closeMs = stampMs(close.at);
    if (closeMs == null || latestStartMs > closeMs) close = null;
  }
  if (!finish && !close) return null;
  return {
    source: 'ledger',
    status: finish?.status ?? null,
    closed: Boolean(close),
    commentId: finish?.commentId ?? null,
  };
}

function cacheVerdict(profile, issue, round) {
  if (!profile) return null;
  const cache = readIssueCache(profile, issue);
  if (!cache || Number(cache.round?.round) !== Number(round)) return null;
  if (!FINAL_STATUSES.includes(cache.lastVerdict)) return null;
  return { source: 'cache', status: cache.lastVerdict, closed: false };
}

function sessionVerdict(profile, issue, round) {
  if (!profile) return null;
  let file;
  try {
    file = sessionPath(profile, issue);
  } catch {
    return null;
  }
  const session = readJsonFile(file);
  if (!session || Number(session.round) !== Number(round) || !session.doneAt) return null;
  return { source: 'session', status: null, closed: false, doneAt: session.doneAt };
}

function snapshotVerdict(task, issue, round) {
  if (!task || String(task.ref || task.issue || '') !== String(issue || '')) return null;
  if (task.state === 'closed') {
    return { source: 'snapshot', status: null, closed: true };
  }
  const latest = (task.rounds || []).reduce((acc, item) => {
    if (!item || !Number.isFinite(Number(item.round))) return acc;
    if (!acc || Number(item.round) > Number(acc.round)) return item;
    return acc;
  }, null);
  if (latest && Number(latest.round) === Number(round) && FINAL_STATUSES.includes(latest.status)) {
    return { source: 'snapshot', status: latest.status, closed: false };
  }
  return null;
}

/**
 * 这一轮是否已经在本地（或本拍已有的盘点快照里）出结论 / 关单。
 * 任一来源命中就返回该来源；都不命中返回 null。不访问 GitHub。
 */
export function localRoundVerdict(issue, round, { paths, profile, task, ledgerEntries, commentId } = {}) {
  const entries = ledgerEntries || loadLedgerEntries(paths);
  return (
    ledgerVerdict(entries, issue, round, { commentId })
    || cacheVerdict(profile, issue, round)
    || sessionVerdict(profile, issue, round)
    || snapshotVerdict(task, issue, round)
    || null
  );
}

/**
 * 进程的启动时间早于当前这次开机：它不可能活过这次重启。
 * startedAt / now / uptime 缺一样或解析失败时返回 false，不当成重启中断。
 */
export function killedByRestart({ startedAt, nowMs, uptimeS } = {}) {
  const startedMs = stampMs(startedAt);
  const up = Number(uptimeS);
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs) || !Number.isFinite(up) || up < 0) return false;
  const bootMs = nowMs - up * 1000;
  return startedMs < bootMs;
}

/** abort / 提醒用的原因文案：重启杀掉且无结论时与普通卡死分开。 */
export function staleAbortReason({ processAlive = false, restartKill = false } = {}) {
  if (processAlive) return '卡死：已结束进程';
  if (restartKill) return '重启中断：进程不在';
  return '卡死：进程不在';
}

/**
 * abort 认领检查已经看到终态（通过 / 要修 / 中断）时，从 stderr 取出状态。
 * 这不是新请求：是这次 abort 本身已经打过的那一次。
 */
export function abortFoundFinalVerdict(stderr) {
  const match = ABORT_FINAL.exec(String(stderr || ''));
  return match ? match[1] : null;
}
