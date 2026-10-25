#!/usr/bin/env node
// Slack 通知（#61）：把验收线和修正轮的事件发到 profile 里配的频道。
//
// 平时安静。只有三类立即发（ping）：blocked（被卡住要人处理）、ready-to-merge（可以合并）、
// finished（一件事做完了）；其余一律进摘要，攒起来最多每 60 分钟发一条。
//
// 令牌只从 profile.slackBotTokenFile 读（O_NOFOLLOW + fstat 检查通过才用），
// 只出现在 Authorization: Bearer 头里：不进日志、不进心跳、不进账本、不进异常信息。
// 频道 id 从 profile.slackChannelId 读（写死在代码里的仓名/频道名一个都没有）。
// API 地址只能经函数参数 apiBase 改（测试用），不从环境变量或配置读。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadAcceptanceProfile } from '../bin/profile.mjs';
import { alertBlocks, digestBlocks, readyBlocks, stalledBlocks } from './slack-blocks.mjs';

/** 发送失败后的重试间隔（分钟）；第 4 次还失败就放弃。 */
export const RETRY_MINUTES = Object.freeze([1, 5, 15]);

/** 摘要窗口：最多每 60 分钟发一条。 */
export const DIGEST_MINUTES = 60;

/** Slack Web API 的默认地址，只能经 notifySlack 的 apiBase 参数改。 */
export const SLACK_API_BASE = 'https://slack.com/api/';

/** 每条我们发的消息都带这个 metadata，删掉账本后靠它把发过的 id 收回来。 */
export const NOTICE_METADATA_TYPE = 'vigil_acceptance_notice';

const CHANNEL_ID = /^[CG][A-Z0-9]+$/;
const MENTION_ID = /^U[A-Z0-9]+$/;

/** 中断类提醒：同一 issue 6 小时内第 2 次及以上合成一条。 */
export const INTERRUPTION_ALERT_KINDS = Object.freeze([
  'round-failed',
  'gate-unavailable',
  'sandbox-unavailable',
  'round-stalled',
  'round-stale',
]);

/** 立即发（ping）的 alert kind。 */
export const BLOCKED_ALERT_KINDS = Object.freeze(['secret-found', 'sandbox-unavailable']);

const INTERRUPTION_WINDOW_MS = 6 * 60 * 60 * 1000;
const MAX_HISTORY_PAGES = 20;
/** 单次请求最多等这么久：Slack 卡住不能把整拍（以及验收）拖住。 */
export const REQUEST_TIMEOUT_MS = 15000;

/**
 * 一次 notifySlack 总共最多花多久（#70 复审）。每个请求的超时取「15 秒」和「预算还剩多少」里小的那个；
 * 预算用完就停：没发的重试留到下拍、新事件不记成已处理（下拍重新收）、摘要留着，心跳写 notify-budget-exhausted。
 */
export const NOTIFY_BUDGET_MS = 30000;

/** 事件 id：`sha256(来源名 + "\n" + 原始行文本)` 前 16 位十六进制。 */
export function eventId(source, line) {
  return crypto.createHash('sha256').update(`${source}\n${line}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 分类：返回 'blocked' | 'ready-to-merge' | 'finished' | 'digest' | 'skip'。
 * - prbot：needs-human / interrupted-exhausted / ready-stalled 是 blocked；
 *   ready 按 handoff 分 ready-to-merge（owner）和 finished（watcher）；
 *   claimed / draft-opened 和未知 type 不发。
 * - alerts：secret-found / sandbox-unavailable 是 blocked；其余（含未知 kind）进摘要，不丢。
 */
export function classify(source, event) {
  if (!event || typeof event !== 'object') return 'skip';
  if (source === 'prbot') {
    switch (event.type) {
      case 'needs-human':
      case 'interrupted-exhausted':
      case 'ready-stalled':
        return 'blocked';
      case 'ready':
        return event.handoff === 'watcher' ? 'finished' : 'ready-to-merge';
      default:
        return 'skip';
    }
  }
  if (source === 'alerts') {
    return BLOCKED_ALERT_KINDS.includes(String(event.kind ?? '')) ? 'blocked' : 'digest';
  }
  return 'skip';
}

function slackPaths(home) {
  const dir = path.join(home, 'state', 'slack');
  return { dir, ledgerFile: path.join(dir, 'ledger.json') };
}

function emptyLedger() {
  return {
    version: 1,
    ids: [],
    pending: [],
    digestNextAt: null,
    windows: {},
    retry: [],
    failed: [],
    rebuiltAt: null,
  };
}

/** 读账本。不存在（或坏了）就当没有：随后用 conversations.history 重建，宁可不发也不重发。 */
function readLedger(home) {
  const { ledgerFile } = slackPaths(home);
  let text;
  try {
    text = fs.readFileSync(ledgerFile, 'utf8');
  } catch (error) {
    return { exists: error?.code !== 'ENOENT' ? true : false, broken: error?.code !== 'ENOENT', data: emptyLedger() };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad ledger');
    const base = emptyLedger();
    return {
      exists: true,
      broken: false,
      data: {
        ...base,
        ...parsed,
        ids: Array.isArray(parsed.ids) ? parsed.ids.filter((id) => typeof id === 'string') : [],
        pending: Array.isArray(parsed.pending) ? parsed.pending : [],
        retry: Array.isArray(parsed.retry) ? parsed.retry : [],
        failed: Array.isArray(parsed.failed) ? parsed.failed : [],
        windows: parsed.windows && typeof parsed.windows === 'object' ? parsed.windows : {},
      },
    };
  } catch {
    return { exists: true, broken: true, data: emptyLedger() };
  }
}

/** 原子写账本：目录 700、文件 600。 */
function writeLedger(home, data) {
  const { dir, ledgerFile } = slackPaths(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // 目录权限设不上不改变账本内容；运维检查会看到。
  }
  const tmp = `${ledgerFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    // 同上。
  }
  fs.renameSync(tmp, ledgerFile);
}

/**
 * 读 Slack 令牌文件（只有本模块读；profile 只存路径）。
 * 用 O_NOFOLLOW 打开（符号链接直接拒绝），再 fstat：普通文件、属主是当前用户、权限正好 600、非空。
 * 任一不满足就不返回令牌，原因里只有一句代码，绝不含令牌内容。
 */
export function readSlackToken(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, reason: 'token-file-unreadable' };
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    // ELOOP（符号链接）、ENOENT、EACCES 都算读不到，不区分具体原因。
    return { ok: false, reason: 'token-file-unreadable' };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { ok: false, reason: 'token-file-not-regular' };
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return { ok: false, reason: 'token-file-owner' };
    }
    if ((stat.mode & 0o777) !== 0o600) return { ok: false, reason: 'token-file-mode' };
    if (stat.size === 0) return { ok: false, reason: 'token-file-empty' };
    const token = fs.readFileSync(fd, 'utf8').trim();
    if (!token) return { ok: false, reason: 'token-file-empty' };
    return { ok: true, token };
  } catch {
    return { ok: false, reason: 'token-file-unreadable' };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // 已经关了。
    }
  }
}

function readLines(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.trim()) out.push(line);
  }
  return out;
}

/** 事件候选：两个文件里的每一行，`at`/`ts` 不早于 profile.startAt 才算。 */
function collectCandidates({ home, startAtMs }) {
  const sources = [
    { source: 'prbot', file: path.join(home, 'state', 'prbot', 'events.jsonl'), timeKeys: ['at', 'ts'] },
    { source: 'alerts', file: path.join(home, 'state', 'host', 'alerts.jsonl'), timeKeys: ['ts', 'at'] },
  ];
  const out = [];
  for (const { source, file, timeKeys } of sources) {
    for (const line of readLines(file)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
      let at = NaN;
      for (const key of timeKeys) {
        const parsed = Date.parse(event[key] ?? '');
        if (Number.isFinite(parsed)) {
          at = parsed;
          break;
        }
      }
      if (!Number.isFinite(at) || at < startAtMs) continue;
      out.push({
        id: eventId(source, line),
        source,
        type: source === 'prbot' ? String(event.type ?? '') : String(event.kind ?? ''),
        at: new Date(at).toISOString(),
        atMs: at,
        issue: typeof event.issue === 'string' ? event.issue : undefined,
        event,
      });
    }
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

/** 存进账本的条目：只留渲染摘要要用的字段（不带整条事件，账本别膨胀）。 */
function project(notice, kind) {
  const event = notice.event || {};
  const out = {
    id: notice.id,
    source: notice.source,
    type: notice.type,
    kind,
    at: notice.at,
    issue: event.issue,
    root: event.root,
    repo: event.repo,
    pr: event.pr,
    prUrl: event.prUrl,
    headSha: event.headSha,
    reason: event.reason,
    detail: event.detail,
    windowCount: notice.windowCount,
    windowKinds: notice.windowKinds,
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

function mentionOf(profile) {
  const value = typeof profile?.slackMentionUserId === 'string' ? profile.slackMentionUserId.trim() : '';
  return MENTION_ID.test(value) ? value : '';
}

/** ping 才 @：摘要永不 @。 */
function withMention(payload, mention) {
  if (!mention) return payload;
  return {
    text: `<@${mention}> ${payload.text}`,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `<@${mention}>` } }, ...(payload.blocks || [])],
  };
}

function buildPing(notice, profile) {
  const mention = mentionOf(profile);
  if (notice.source === 'prbot' && notice.type === 'ready') return withMention(readyBlocks(notice, profile), mention);
  if (notice.source === 'prbot' && notice.type === 'ready-stalled') return withMention(stalledBlocks(notice, profile), mention);
  return withMention(alertBlocks(notice, profile), mention);
}

function apiUrl(base, method) {
  const root = String(base || SLACK_API_BASE);
  return `${root.endsWith('/') ? root : `${root}/`}${method}`;
}

/** 发一次请求。失败原因只用固定短语，绝不带出令牌或响应正文里的可疑内容。 */
async function requestJson({ base, token, fetch, method, httpMethod = 'POST', query, body, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const url = query ? `${apiUrl(base, method)}?${new URLSearchParams(query).toString()}` : apiUrl(base, method);
  const init = {
    method: httpMethod,
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(body);
  }
  let response;
  let parsed = null;
  let status = 0;
  try {
    response = await fetch(url, init);
    status = Number(response?.status ?? 0);
    try {
      parsed = await response.json();
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
      parsed = null;
    }
  } catch (error) {
    return { ok: false, error: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'network-error' };
  }
  if (status === 429) return { ok: false, error: 'rate-limited' };
  if (!(status >= 200 && status < 300)) return { ok: false, error: `http-${status || 'unknown'}` };
  if (!parsed || parsed.ok !== true) {
    const reason = typeof parsed?.error === 'string' && /^[a-z0-9_]+$/i.test(parsed.error) ? parsed.error : 'unknown';
    return { ok: false, error: `slack-${reason}` };
  }
  return { ok: true, response: parsed };
}

function postMessage(ctx, payload) {
  return requestJson({
    ...ctx,
    method: 'chat.postMessage',
    body: {
      channel: ctx.channel,
      text: payload.text,
      blocks: payload.blocks,
      metadata: { event_type: NOTICE_METADATA_TYPE, event_payload: { ids: payload.ids || [] } },
    },
  });
}

/** 从频道历史里把「我们发过的消息」带的 id 收回来（删掉账本后不重发就靠它）。 */
async function rebuildFromHistory(ctx, startAtMs) {
  const ids = new Set();
  let cursor = '';
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    if (ctx.remaining && ctx.remaining() <= 0) return { ok: false };
    const query = {
      channel: ctx.channel,
      oldest: String(Math.floor(startAtMs / 1000)),
      include_all_metadata: 'true',
      limit: '200',
    };
    if (cursor) query.cursor = cursor;
    const result = await requestJson({ ...ctx, method: 'conversations.history', httpMethod: 'GET', query });
    if (!result.ok) return { ok: false };
    const response = result.response || {};
    for (const message of response.messages || []) {
      const metadata = message?.metadata;
      if (!metadata || metadata.event_type !== NOTICE_METADATA_TYPE) continue;
      for (const id of metadata.event_payload?.ids || []) {
        if (typeof id === 'string' && id) ids.add(id);
      }
    }
    const next = typeof response.response_metadata?.next_cursor === 'string' ? response.response_metadata.next_cursor : '';
    if (!next) return { ok: true, ids: [...ids] };
    cursor = next;
  }
  // 20 页还没走完就停在这里：收到多少算多少，宁可少收（可能多发一条）也不再翻。
  return { ok: true, ids: [...ids] };
}

/**
 * 失败后怎么走：已经试过 `attempts` 次的话，次数 +1；到第 4 次就放弃，否则记下下次重试时间。
 * 不 sleep：时间记在账本里，后面的拍再看。
 */
function retryOrGiveUp(entry, nowMs) {
  const made = Number(entry.attempts) || 0;
  const attempts = made + 1;
  if (attempts > RETRY_MINUTES.length) return { giveUp: true };
  return {
    giveUp: false,
    entry: {
      ...entry,
      attempts,
      nextAttemptAt: new Date(nowMs + RETRY_MINUTES[attempts - 1] * 60000).toISOString(),
    },
  };
}

/** 同一 issue 的 6 小时中断窗口。 */
function touchWindow(windows, notice, nowMs) {
  const key = notice.issue || '(未知)';
  const prev = windows[key];
  const startedAt = Date.parse(prev?.startedAt ?? '');
  const fresh = !Number.isFinite(startedAt) || nowMs - startedAt >= INTERRUPTION_WINDOW_MS;
  const win = fresh
    ? { startedAt: new Date(nowMs).toISOString(), count: 0, collapsedAt: null, kinds: [] }
    : prev;
  win.count = (Number(win.count) || 0) + 1;
  if (!Array.isArray(win.kinds)) win.kinds = [];
  if (!win.kinds.includes(notice.type)) win.kinds.push(notice.type);
  windows[key] = win;
  return win;
}

/**
 * 跑一次通知：先把上次没发出去的重试一遍，再把新事件按 ping / 摘要分好，最后该发摘要就发。
 * 返回 `{ ok, reason?, sent, digested, pending, failed: [{ id, kind, error }] }`，写进 heartbeat.slack。
 * 永不抛错：没配令牌 / 频道、账本重建失败都只返回原因。
 */
export async function notifySlack({
  home,
  profile,
  env = {},
  now = () => Date.now(),
  fetch: fetchImpl = globalThis.fetch,
  apiBase = SLACK_API_BASE,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  budgetMs = NOTIFY_BUDGET_MS,
  clock = () => performance.now(),
} = {}) {
  const summary = { ok: true, sent: 0, digested: 0, pending: 0, deferred: 0, failed: [] };
  const deadline = clock() + budgetMs;
  const remaining = () => deadline - clock();
  const fail = (reason, extra = {}) => ({ ...summary, ok: false, reason, ...extra });

  if (typeof home !== 'string' || !path.isAbsolute(home)) return fail('bad-home');

  let prof = profile;
  if (!prof) {
    try {
      prof = loadAcceptanceProfile({ ...env, ACCEPTANCE_WATCHER_HOME: home });
    } catch {
      return fail('profile-error');
    }
  }

  const channel = typeof prof?.slackChannelId === 'string' ? prof.slackChannelId.trim() : '';
  if (!CHANNEL_ID.test(channel)) return fail('not-configured');
  const tokenFile = typeof prof?.slackBotTokenFile === 'string' ? prof.slackBotTokenFile : '';
  if (!tokenFile) return fail('not-configured');
  const token = readSlackToken(tokenFile);
  if (!token.ok) return fail(token.reason);
  if (typeof fetchImpl !== 'function') return fail('no-fetch');

  const nowMs = now();
  const startAtMs = Date.parse(prof.startAt ?? '');
  if (!Number.isFinite(startAtMs)) return fail('profile-error');

  const ctx = {
    base: apiBase,
    token: token.token,
    channel,
    fetch: fetchImpl,
    // 每个请求的超时随预算缩短；预算没了 remaining() 是 0，下面不会再发。
    get timeoutMs() {
      return Math.max(1, Math.ceil(Math.min(requestTimeoutMs, remaining())));
    },
    remaining,
  };

  let ledger = readLedger(home);
  if (!ledger.exists || ledger.broken) {
    const rebuilt = await rebuildFromHistory(ctx, startAtMs);
    if (!rebuilt.ok) return fail('ledger-rebuild-failed');
    const fresh = emptyLedger();
    fresh.ids = rebuilt.ids;
    fresh.rebuiltAt = new Date(nowMs).toISOString();
    ledger = { exists: true, broken: false, data: fresh };
  }

  const data = ledger.data;
  const sentIds = new Set(data.ids);
  const pending = [...data.pending];
  const windows = { ...data.windows };
  const retryQueue = [];
  const newFailures = [];
  let anyFailure = false;
  let reason;

  const giveUp = (entry, error) => {
    const failure = { id: entry.id, kind: entry.kind, error, at: new Date(nowMs).toISOString() };
    newFailures.push(failure);
    summary.failed.push({ id: failure.id, kind: failure.kind, error });
  };

  // 1. 上次没发出去的重试（1、5、15 分钟；第 4 次失败放弃）。
  for (const entry of data.retry) {
    const dueAt = Date.parse(entry.nextAttemptAt ?? '');
    if (Number.isFinite(dueAt) && dueAt > nowMs) {
      retryQueue.push(entry);
      continue;
    }
    if (remaining() <= 0) {
      // 预算用完：原样留到下拍，不算一次失败。
      retryQueue.push(entry);
      summary.deferred += 1;
      continue;
    }
    const result = await postMessage(ctx, entry.payload || {});
    if (result.ok) {
      summary.sent += 1;
      for (const id of entry.payload?.ids || []) sentIds.add(id);
      continue;
    }
    anyFailure = true;
    const next = retryOrGiveUp(entry, nowMs);
    if (next.giveUp) giveUp(entry, result.error);
    else retryQueue.push(next.entry);
  }

  // 2. 新事件。
  for (const notice of collectCandidates({ home, startAtMs })) {
    if (sentIds.has(notice.id)) continue;
    if (remaining() <= 0) {
      // 预算用完：不记成已处理、不动中断窗口，下拍重新收。
      summary.deferred += 1;
      continue;
    }
    let kind = classify(notice.source, notice.event);
    if (kind === 'skip') {
      sentIds.add(notice.id);
      continue;
    }
    if (notice.source === 'alerts' && INTERRUPTION_ALERT_KINDS.includes(notice.type)) {
      // 按事件自己的时间算窗口：循环停摆后一次补发积压时，不能把隔了很久的中断算成「连续」。
      const win = touchWindow(windows, notice, notice.atMs);
      if (win.count >= 2) {
        if (win.collapsedAt) {
          // 这个 6 小时窗口已经发过合成的那条了。
          sentIds.add(notice.id);
          continue;
        }
        win.collapsedAt = new Date(nowMs).toISOString();
        kind = 'blocked';
        notice.kind = 'blocked';
        notice.type = 'interrupted-repeat';
        notice.windowCount = win.count;
        notice.windowKinds = [...win.kinds];
      }
    }

    if (kind === 'digest') {
      pending.push(project(notice, kind));
      summary.digested += 1;
      sentIds.add(notice.id);
      continue;
    }

    const payload = buildPing(notice, prof);
    payload.ids = [notice.id];
    const result = await postMessage(ctx, payload);
    sentIds.add(notice.id);
    if (result.ok) {
      summary.sent += 1;
      continue;
    }
    anyFailure = true;
    const next = retryOrGiveUp({ id: notice.id, kind, payload, attempts: 0 }, nowMs);
    retryQueue.push(next.entry);
  }

  // 3. 摘要：攒着，到点（最多每 60 分钟）发一条。
  let digestNextAt = typeof data.digestNextAt === 'string' ? data.digestNextAt : null;
  if (!pending.length) {
    digestNextAt = null;
  } else if (!digestNextAt) {
    digestNextAt = new Date(nowMs + DIGEST_MINUTES * 60000).toISOString();
  } else {
    const dueAt = Date.parse(digestNextAt);
    const due = Number.isFinite(dueAt) ? dueAt : nowMs;
    if (nowMs >= due && remaining() <= 0) {
      summary.deferred += 1;
    } else if (nowMs >= due) {
      const payload = digestBlocks(pending, prof);
      payload.ids = pending.map((item) => item.id);
      const result = await postMessage(ctx, payload);
      for (const id of payload.ids) sentIds.add(id);
      pending.length = 0;
      digestNextAt = null;
      if (result.ok) {
        summary.sent += 1;
      } else {
        anyFailure = true;
        retryQueue.push({ id: payload.ids[0], kind: 'digest', payload, attempts: 1, nextAttemptAt: new Date(nowMs + RETRY_MINUTES[0] * 60000).toISOString() });
      }
    }
  }

  // 4. 落账本。写不进去也不抛：下拍会再试，宁可多发也不卡住验收拍。
  //    6 小时窗口是「同一任务连续中断」的判据，超过 24 小时的旧窗口没用了，顺手清掉。
  for (const [key, win] of Object.entries(windows)) {
    const startedAt = Date.parse(win?.startedAt ?? '');
    if (!Number.isFinite(startedAt) || nowMs - startedAt >= 24 * 60 * 60 * 1000) delete windows[key];
  }
  const nextLedger = {
    version: 1,
    ids: [...sentIds],
    pending,
    digestNextAt,
    windows,
    retry: retryQueue,
    // 最终失败只留最近 50 条（只是给人看的，不去重：去重靠 ids）。
    failed: [...data.failed, ...newFailures].slice(-50),
    rebuiltAt: data.rebuiltAt ?? null,
  };
  try {
    writeLedger(home, nextLedger);
  } catch {
    anyFailure = true;
    reason = 'ledger-write-failed';
  }

  summary.pending = pending.length;
  if (anyFailure) {
    summary.ok = false;
    summary.reason = reason || 'send-failed';
  } else if (summary.deferred > 0) {
    summary.ok = false;
    summary.reason = 'notify-budget-exhausted';
  }
  return summary;
}
