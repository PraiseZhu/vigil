#!/usr/bin/env node
// 轮次评论是认领的真源。本地缓存只是加速，GitHub 说了算。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const FIRST_LINE = /^\[验收机\] 第 (\d+) 轮：(验收中|通过|要修|中断)/;
const LOCK_STALE_MS = 10 * 60 * 1000;
export const ISSUE_COMMENTS_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      body
      comments(last: 100) {
        nodes {
          id
          databaseId
          body
          createdAt
          updatedAt
          url
          author { login }
        }
      }
    }
  }
}`;

export class RoundError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'RoundError';
    this.code = code;
  }
}

/** 正文版本：每行去掉行尾空白，再去掉末尾空行，再 sha256。tasks.mjs 复用这一份。 */
export function bodyVersion(body) {
  const text = body == null ? '' : String(body);
  const normalized = text
    .split('\n')
    .map((line) => line.replace(/[ \t\r]+$/g, ''))
    .join('\n')
    .replace(/\n+$/g, '');
  return `sha256:${crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
}

export function parseRef(ref) {
  const match = String(ref).match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) throw new Error(`无法解析任务引用：${ref}`);
  return { owner: match[1], name: match[2], repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

function cacheKey(ref) {
  const { owner, name, number } = parseRef(ref);
  return `${owner}__${name}__${number}`;
}

export function lockPath(profile, ref) {
  return path.join(profile.stateDir, 'locks', `${cacheKey(ref)}.lock`);
}

export function cachePath(profile, ref) {
  return path.join(profile.stateDir, 'issues', `${cacheKey(ref)}.json`);
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function lineValue(body, label) {
  const match = String(body || '')
    .split('\n')
    .find((line) => line.startsWith(`${label}：`));
  return match ? match.slice(label.length + 1).trim() : null;
}

/**
 * 解析轮次评论，按轮次号升序。
 * 只认 ownerLogin 发的评论：公开仓上任何人都能发同样首行的评论，别人的一律当普通评论忽略。
 * 不传 ownerLogin 直接抛错（宁可停，不可误认）。
 */
export function parseRounds(comments, ownerLogin) {
  if (typeof ownerLogin !== 'string' || !ownerLogin) {
    throw new Error('parseRounds 需要 ownerLogin：只认我自己发的轮次评论');
  }
  const owner = ownerLogin.toLowerCase();
  const rounds = [];
  for (const comment of comments || []) {
    if (String(comment?.author?.login || '').toLowerCase() !== owner) continue;
    const first = String(comment.body || '').split('\n')[0] || '';
    const match = FIRST_LINE.exec(first);
    if (!match) continue;
    const round = Number(match[1]);
    const status = match[2];
    const finishedAtLine = lineValue(comment.body, '完成');
    let finishedAt = finishedAtLine || null;
    if (!finishedAt && status !== '验收中') finishedAt = comment.updatedAt || null;
    rounds.push({
      round,
      status,
      commentId: comment.databaseId,
      nodeId: comment.id,
      url: comment.url,
      bodyVersion: lineValue(comment.body, '正文版本'),
      startedAt: lineValue(comment.body, '开始'),
      finishedAt,
      createdAt: comment.createdAt,
      reason: lineValue(comment.body, '原因'),
    });
  }
  rounds.sort((a, b) => a.round - b.round);
  return rounds;
}

/** 按创建时间最新的那条轮次评论。 */
export function latestRound(rounds) {
  if (!rounds?.length) return null;
  return [...rounds]
    .sort((a, b) => {
      const ta = Date.parse(a.createdAt || 0);
      const tb = Date.parse(b.createdAt || 0);
      if (ta !== tb) return ta - tb;
      return a.round - b.round;
    })
    .at(-1);
}

function formatStartBody(n, version, startedAt) {
  return [`[验收机] 第 ${n} 轮：验收中`, `正文版本：${version}`, `开始：${startedAt}`].join('\n');
}

function formatFinishBody(existing, n, status, { reason, detail, finishedAt }) {
  const lines = String(existing || '').split('\n');
  const kept = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith('完成：') || line.startsWith('原因：')) continue;
    kept.push(line);
  }
  const bodyVersionLine = kept.find((line) => line.startsWith('正文版本：')) || '';
  const startLine = kept.find((line) => line.startsWith('开始：')) || '';
  const rest = kept.filter((line) => !line.startsWith('正文版本：') && !line.startsWith('开始：'));
  const out = [`[验收机] 第 ${n} 轮：${status}`];
  if (bodyVersionLine) out.push(bodyVersionLine);
  if (startLine) out.push(startLine);
  out.push(`完成：${finishedAt}`);
  if (status === '中断' && reason) out.push(`原因：${reason}`);
  const extra = rest.join('\n').replace(/^\n+/, '').trimEnd();
  const detailText = detail != null && detail !== '' ? String(detail).replace(/^\n+/, '') : extra;
  if (detailText) {
    out.push('');
    out.push(detailText);
  }
  return out.join('\n');
}

/**
 * 北京时间的 ISO-8601（#43 决策：时间一律写北京时间），带 +08:00 偏移，例如 2026-10-25T19:43:23+08:00。
 * Date.parse 认这个格式，旧的 UTC「…Z」格式照样能解析，所以 trigger / poll 新旧混着读都没问题。
 */
export function beijingIso(ms) {
  const shifted = new Date(Number(ms) + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

function nowIso(now) {
  return beijingIso(now());
}

function acquireLock(file, round, now) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const payload = JSON.stringify({ round, createdAt: nowIso(now), pid: process.pid });
  try {
    const fd = fs.openSync(file, 'wx');
    try {
      fs.writeFileSync(fd, payload);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

function releaseLock(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // 锁不在了就算释放。
  }
}

function lockStale(lock, rounds, now, file) {
  if (!lock) {
    // 锁文件在但读不出（可能另一个进程刚建、还没写完）：10 分钟内算被占用。
    try {
      return now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  const matching = rounds.find((round) => round.round === lock.round);
  const latest = latestRound(rounds);
  if (latest && latest.round >= lock.round && latest.status !== '验收中') return true;
  const age = now() - Date.parse(lock.createdAt || 0);
  if (age > LOCK_STALE_MS && !matching) return true;
  return false;
}

function writeCache(profile, ref, data) {
  atomicWrite(cachePath(profile, ref), JSON.stringify(data, null, 2));
}

export function readIssueCache(profile, ref) {
  return readJson(cachePath(profile, ref));
}

function cacheFromGithub(cache, latest) {
  const same = cache?.round?.round === latest.round;
  return {
    ...(cache || {}),
    round: {
      round: latest.round,
      commentId: latest.commentId,
      model: same ? cache?.round?.model ?? null : null,
      startedAt: latest.startedAt,
      lastProgressAt: same ? cache?.round?.lastProgressAt ?? null : null,
      finishedAt: latest.finishedAt,
    },
    lastVerdict: latest.status === '通过' || latest.status === '要修' ? latest.status : cache?.lastVerdict ?? null,
  };
}

async function readIssue(github, ref) {
  const { owner, name, number } = parseRef(ref);
  const data = await github.graphql(ISSUE_COMMENTS_QUERY, { owner, name, number });
  const issue = data.repository?.issue;
  if (!issue) throw new RoundError(`找不到 ${ref}`, 'NOT_FOUND');
  return issue;
}

function commentsOf(issue) {
  return issue.comments?.nodes || [];
}

function maxRound(rounds) {
  return (rounds || []).reduce((acc, round) => Math.max(acc, round.round), 0);
}

export function createRounds({ github, profile, now = () => Date.now() }) {
  async function loadIssueState(ref, { write = true } = {}) {
    const issue = await readIssue(github, ref);
    const rounds = parseRounds(commentsOf(issue), profile.ownerLogin);
    const latest = latestRound(rounds);
    const cache = readIssueCache(profile, ref);
    if (write && latest) {
      const rebuilt = cacheFromGithub(cache, latest);
      const disagree =
        !cache ||
        cache.round?.round !== latest.round ||
        cache.round?.commentId !== latest.commentId ||
        cache.round?.finishedAt !== latest.finishedAt;
      if (disagree) writeCache(profile, ref, rebuilt);
    }
    return { issue, rounds, latest, cache };
  }

  async function start(task) {
    const ref = task.ref;
    const file = lockPath(profile, ref);
    const existing = await readIssue(github, ref);
    const existingRounds = parseRounds(commentsOf(existing), profile.ownerLogin);
    if (fs.existsSync(file)) {
      if (!lockStale(readJson(file), existingRounds, now, file)) {
        throw new RoundError(`任务 ${ref} 已锁定`, 'LOCKED');
      }
      releaseLock(file);
    }
    const guessed = maxRound(existingRounds) + 1;
    if (!acquireLock(file, guessed, now)) {
      throw new RoundError(`任务 ${ref} 已锁定`, 'LOCKED');
    }
    try {
      const fresh = await readIssue(github, ref);
      const rounds = parseRounds(commentsOf(fresh), profile.ownerLogin);
      const latest = latestRound(rounds);
      if (latest?.status === '验收中') {
        releaseLock(file);
        throw new RoundError(`任务 ${ref} 已有进行中的轮次`, 'IN_PROGRESS');
      }
      const n = maxRound(rounds) + 1;
      const version = bodyVersion(fresh.body);
      const startedAt = nowIso(now);
      const created = await github.write({
        type: 'comment.create',
        // 去重键带开始时间：轮次评论被删或挤出读取窗口后同号再认领，账本不会把旧评论当成这一次的结果。
        dedupeKey: `round-start:${ref}:${n}:${startedAt}`,
        repo: task.repo,
        issue: task.number,
        body: formatStartBody(n, version, startedAt),
      });
      writeCache(profile, ref, {
        kind: task.kind,
        mode: task.tier,
        tree: (task.children || []).map((child) => child.ref),
        round: {
          round: n,
          commentId: created.commentId,
          model: null,
          startedAt,
          lastProgressAt: null,
          finishedAt: null,
        },
        lastVerdict: null,
      });
      return {
        issue: ref,
        round: n,
        commentId: created.commentId,
        bodyVersion: version,
        url: created.url,
      };
    } catch (error) {
      if (error instanceof RoundError && (error.code === 'LOCKED' || error.code === 'IN_PROGRESS')) {
        throw error;
      }
      releaseLock(file);
      throw error;
    }
  }

  async function check(ref, n) {
    const { rounds } = await loadIssueState(ref);
    const latest = latestRound(rounds);
    if (!latest) {
      throw new RoundError(`认领检查失败：期望第 ${n} 轮（验收中），实际没有轮次`, 'NOT_CURRENT');
    }
    if (latest.round !== n || latest.status !== '验收中') {
      throw new RoundError(
        `认领检查失败：期望第 ${n} 轮（验收中），实际第 ${latest.round} 轮（${latest.status}）`,
        'NOT_CURRENT',
      );
    }
    return latest;
  }

  async function finish(ref, n, status, { reason, detail } = {}) {
    if (!['通过', '要修', '中断'].includes(status)) {
      throw new RoundError(`非法结束状态：${status}`, 'BAD_STATUS');
    }
    const current = await check(ref, n);
    const { repo, number } = parseRef(ref);
    const issue = await readIssue(github, ref);
    const comment = commentsOf(issue).find((item) => item.databaseId === current.commentId);
    const finishedAt = nowIso(now);
    const body = formatFinishBody(comment?.body || '', n, status, { reason, detail, finishedAt });
    const updated = await github.write({
      type: 'comment.update',
      // 带上评论 id：同号的轮次（旧评论被删后重新认领）结束时不会命中上一条评论的账本记录。
      dedupeKey: `round-finish:${ref}:${n}:${current.commentId}:${status}`,
      repo,
      // 宿主侧 abort 走写闸 exec 模式：没有本轮绑定，写闸靠 repo + issue 找到轮次，缺了就拒。
      issue: number,
      commentId: current.commentId,
      body,
    });
    releaseLock(lockPath(profile, ref));
    const cache = readIssueCache(profile, ref) || {};
    writeCache(profile, ref, {
      ...cache,
      round: {
        ...(cache.round || {}),
        round: n,
        commentId: current.commentId,
        finishedAt,
      },
      lastVerdict: status,
    });
    return { ...updated, round: n, status };
  }

  async function progress(ref, n) {
    await check(ref, n);
    const cache = readIssueCache(profile, ref) || {};
    const stamp = nowIso(now);
    writeCache(profile, ref, {
      ...cache,
      round: { ...(cache.round || {}), round: n, lastProgressAt: stamp },
    });
    return stamp;
  }

  async function done(ref, n) {
    await check(ref, n);
    const cache = readIssueCache(profile, ref) || {};
    const stamp = nowIso(now);
    writeCache(profile, ref, {
      ...cache,
      round: { ...(cache.round || {}), round: n, finishedAt: stamp },
    });
    return stamp;
  }

  function lastProgressAt(ref, n, roundInfo) {
    const cache = readIssueCache(profile, ref);
    if (n != null && cache?.round?.round === n && cache.round.lastProgressAt) {
      return cache.round.lastProgressAt;
    }
    return roundInfo?.createdAt || null;
  }

  return { start, check, finish, progress, done, lastProgressAt };
}
