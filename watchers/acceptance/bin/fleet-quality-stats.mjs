#!/usr/bin/env node
// 舰队质量只读统计（并行组 C，任务子 issue 见关联 PR）。
// 不 spawn、不触网、不读令牌、不读 ACCEPTANCE_WATCHER_HOME、不写 GitHub。
// 只读调用方显式传入的评论 / 事件 / 日志副本。缺数据记 unknown，不填 0。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_TIMEZONE = 'America/Los_Angeles';
export const DEFAULT_WINDOW_DAYS = 7;
export const ALERT_DEDUP_MS = 60 * 60 * 1000;
export const ENV_PROBLEM_PREFIX = '环境问题（不是代码不通过）：';
export const FIRST_LINE = /^\[验收机\] 第 (\d+) 轮：(验收中|通过|要修|中断)/;
export const FINAL_STATUSES = new Set(['通过', '要修']);
export const HEARTBEAT_TICK_DEFAULT_S = 180;
export const HEARTBEAT_TICK_MAX_S = 3600;
export const HEARTBEAT_MARGIN_MS = 60 * 1000;
export const HEARTBEAT_ALERT_KINDS = new Set([
  'heartbeat-delayed',
  'heartbeat-stale',
  'heartbeat-stale-after-freeze',
  'host-frozen',
]);

const ROUND_ITEM_PASS = /^- 通过：(\S+)\s+SC(\d+)(?:\s*·\s*证据：(.*))?$/;
const ROUND_ITEM_MANUAL = /^- 人工手测：(\S+)\s+SC(\d+)(?:（([^）]*)）)?/;
const ROUND_ITEM_FIX = /^- 要修：(\S+)\s+SC(\d+)/;
const ROUND_ITEM_DISPUTE = /^- 有争议：(\S+)\s+SC(\d+)/;
const TEMP_COPY_EXTRA = /临时副本\s*补|在临时副本补|临时副本.{0,24}补.{0,24}(测试|用例)/;
const WRITABLE_COPY = /可写副本/;
const ISSUE_URL = /github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)/;
const ISSUE_API = /repos\/([^/]+\/[^/]+)\/issues\/(\d+)/;
const SHA_FULL = /^[0-9a-f]{40}$/i;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseInstant(value) {
  if (value == null || value === '') return null;
  const original = String(value);
  const utcMs = Date.parse(original);
  if (!Number.isFinite(utcMs)) return null;
  const zone = original.match(/([+-]\d{2}:\d{2}|Z)$/i);
  return { utcMs, original, zoneHint: zone ? zone[1] : null };
}

export function zonedParts(ms, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'shortOffset',
  });
  const map = {};
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    timeZoneName: map.timeZoneName || null,
    localDate: `${map.year}-${map.month}-${map.day}`,
  };
}

export function localDateOf(ms, timeZone) {
  return zonedParts(ms, timeZone).localDate;
}

export function addCalendarDays(localDate, delta) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error(`日期必须是 YYYY-MM-DD：${localDate}`);
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta);
  const d = new Date(utc);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function zonedMidnightUtcMs(localDate, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error(`日期必须是 YYYY-MM-DD：${localDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const wanted = Date.UTC(year, month - 1, day, 0, 0, 0);
  let guess = wanted;
  for (let i = 0; i < 8; i += 1) {
    const parts = zonedParts(guess, timeZone);
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    const delta = wanted - observed;
    if (
      delta === 0 &&
      parts.year === year &&
      parts.month === month &&
      parts.day === day &&
      parts.hour === 0 &&
      parts.minute === 0 &&
      parts.second === 0
    ) {
      return guess;
    }
    guess += delta;
  }
  throw new Error(`算不出 ${timeZone} ${localDate} 的本地午夜`);
}

/**
 * 默认：now 所在时区「今天」之前的 days 个完整本地日。
 * --from/--to 为该时区的闭区间本地日。
 */
export function completeLocalWindow({
  nowMs = Date.now(),
  timeZone = DEFAULT_TIMEZONE,
  days = DEFAULT_WINDOW_DAYS,
  fromDate = null,
  toDate = null,
} = {}) {
  const today = localDateOf(nowMs, timeZone);
  let fromLocalDate;
  let toLocalDate;
  if (fromDate && toDate) {
    fromLocalDate = fromDate;
    toLocalDate = toDate;
  } else if (fromDate || toDate) {
    throw new Error('--from 和 --to 必须成对出现');
  } else {
    toLocalDate = addCalendarDays(today, -1);
    fromLocalDate = addCalendarDays(toLocalDate, -(Number(days) - 1));
  }
  if (fromLocalDate > toLocalDate) throw new Error(`窗口起日 ${fromLocalDate} 晚于止日 ${toLocalDate}`);
  const startUtcMs = zonedMidnightUtcMs(fromLocalDate, timeZone);
  const endUtcMs = zonedMidnightUtcMs(addCalendarDays(toLocalDate, 1), timeZone);
  const completeLocalDays = [];
  for (let date = fromLocalDate; date <= toLocalDate; date = addCalendarDays(date, 1)) {
    completeLocalDays.push(date);
  }
  return {
    timeZone,
    fromLocalDate,
    toLocalDate,
    startUtc: new Date(startUtcMs).toISOString(),
    endUtcExclusive: new Date(endUtcMs).toISOString(),
    startUtcMs,
    endUtcMs,
    completeLocalDays,
    note: `按 ${timeZone} 完整本地日，不是不加说明的 UTC 日`,
  };
}

export function inWindow(ms, window) {
  return Number.isFinite(ms) && ms >= window.startUtcMs && ms < window.endUtcMs;
}

function lineValue(body, label) {
  const match = String(body || '')
    .split('\n')
    .find((line) => line.startsWith(`${label}：`));
  return match ? match.slice(label.length + 1).trim() : null;
}

export function normalizeAuthor(raw) {
  const src = raw?.user || raw?.author || raw || {};
  let login = typeof src.login === 'string' ? src.login.trim() : '';
  const typeRaw = src.type || src.__typename || '';
  if (typeRaw === 'Bot' && login && !login.endsWith('[bot]')) login = `${login}[bot]`;
  const type = typeRaw === 'Bot' || login.endsWith('[bot]') ? 'Bot' : typeRaw || 'unknown';
  return { login, type };
}

export function issueRefFromUrls(...urls) {
  for (const url of urls) {
    const text = String(url || '');
    const html = ISSUE_URL.exec(text);
    if (html) return `${html[1]}#${html[2]}`;
    const api = ISSUE_API.exec(text);
    if (api) return `${api[1]}#${api[2]}`;
  }
  return null;
}

export function classifyEvidence(evidence) {
  const text = evidence == null ? '' : String(evidence).trim();
  if (!text) return { kind: 'empty', cheat: false, unverified: false };
  if (TEMP_COPY_EXTRA.test(text)) {
    return { kind: 'temp-copy-extra-tests', cheat: false, unverified: true, label: '待核实' };
  }
  if (WRITABLE_COPY.test(text)) return { kind: 'writable-copy', cheat: false, unverified: false };
  return { kind: 'present', cheat: false, unverified: false };
}

export function parseVerdictItems(body) {
  const items = [];
  let inSection = false;
  for (const rawLine of String(body || '').split('\n')) {
    const line = rawLine.trim();
    if (line === '## 逐条结果') {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith('## ')) break;
    if (!inSection && !line.startsWith('- ')) continue;
    let match = ROUND_ITEM_PASS.exec(line);
    if (match) {
      const evidence = match[3] ?? '';
      items.push({
        result: '通过',
        ref: match[1],
        sc: Number(match[2]),
        evidence,
        evidenceClass: classifyEvidence(evidence),
        raw: line,
      });
      continue;
    }
    match = ROUND_ITEM_MANUAL.exec(line);
    if (match) {
      items.push({
        result: '人工手测',
        ref: match[1],
        sc: Number(match[2]),
        layer: match[3] || null,
        evidence: '',
        evidenceClass: { kind: 'manual', cheat: false, unverified: true },
        raw: line,
      });
      continue;
    }
    match = ROUND_ITEM_FIX.exec(line);
    if (match) {
      items.push({ result: '要修', ref: match[1], sc: Number(match[2]), evidence: '', evidenceClass: { kind: 'fail' }, raw: line });
      continue;
    }
    match = ROUND_ITEM_DISPUTE.exec(line);
    if (match) {
      items.push({ result: '有争议', ref: match[1], sc: Number(match[2]), evidence: '', evidenceClass: { kind: 'dispute' }, raw: line });
    }
  }
  return items;
}

function isRoundAuthor(author, allowLogins) {
  if (allowLogins?.size) return allowLogins.has(author.login.toLowerCase());
  return author.type === 'Bot';
}

export function normalizeComment(raw, { allowLogins = null, issueRef = null } = {}) {
  if (!isObject(raw) && typeof raw?.body !== 'string') return null;
  const body = String(raw.body || '');
  const first = body.split('\n')[0] || '';
  const match = FIRST_LINE.exec(first);
  if (!match) return null;
  const author = normalizeAuthor(raw);
  if (!isRoundAuthor(author, allowLogins)) return null;
  const started = parseInstant(lineValue(body, '开始') || raw.created_at || raw.createdAt);
  const finished = parseInstant(lineValue(body, '完成') || (match[2] === '验收中' ? null : raw.updated_at || raw.updatedAt));
  const commentId = raw.databaseId ?? raw.id ?? null;
  const url = raw.html_url || raw.url || null;
  const ref = issueRef || raw.issueRef || issueRefFromUrls(raw.html_url, raw.url, raw.issue_url);
  const items = parseVerdictItems(body);
  const reason = lineValue(body, '原因');
  return {
    issueRef: ref,
    round: Number(match[1]),
    status: match[2],
    bodyVersion: lineValue(body, '正文版本'),
    startedAt: started?.original || null,
    startedAtMs: started?.utcMs ?? null,
    startedZoneHint: started?.zoneHint || null,
    finishedAt: finished?.original || null,
    finishedAtMs: finished?.utcMs ?? null,
    finishedZoneHint: finished?.zoneHint || null,
    createdAt: raw.created_at || raw.createdAt || null,
    updatedAt: raw.updated_at || raw.updatedAt || null,
    reason,
    envWait: typeof reason === 'string' && reason.startsWith(ENV_PROBLEM_PREFIX),
    commentId,
    commentUrl: url,
    author,
    items,
    mainSha: typeof raw.mainSha === 'string' ? raw.mainSha : null,
  };
}

export function normalizeEvent(raw, { issueRef = null } = {}) {
  if (!isObject(raw)) return null;
  const name = raw.event || raw.event_type || null;
  if (name !== 'closed' && name !== 'reopened') return null;
  const at = parseInstant(raw.created_at || raw.createdAt);
  const actor = normalizeAuthor({ user: raw.actor || raw.user || raw.author });
  return {
    event: name,
    eventId: raw.id ?? raw.databaseId ?? null,
    at: at?.original || null,
    atMs: at?.utcMs ?? null,
    zoneHint: at?.zoneHint || null,
    actor,
    issueRef: issueRef || raw.issueRef || issueRefFromUrls(raw.url, raw.html_url, raw.issue_url, raw.commit_url),
  };
}

export function normalizeIssue(raw) {
  if (!isObject(raw) || raw.pull_request) return null;
  const ref =
    raw.ref ||
    (raw.repository?.nameWithOwner && raw.number ? `${raw.repository.nameWithOwner}#${raw.number}` : null) ||
    issueRefFromUrls(raw.html_url, raw.url);
  if (!ref) return null;
  const closedBy = raw.closed_by ? normalizeAuthor({ user: raw.closed_by }) : null;
  const closedAt = parseInstant(raw.closed_at || raw.closedAt);
  const prs = [];
  const nodes = raw.closedByPullRequestsReferences?.nodes || raw.pullRequests || raw.linkedPullRequests || [];
  for (const pr of nodes) {
    const merged = parseInstant(pr.mergedAt || pr.merged_at);
    const prRef = pr.ref || (pr.repository?.nameWithOwner && pr.number ? `${pr.repository.nameWithOwner}#${pr.number}` : null);
    prs.push({
      ref: prRef,
      url: pr.url || pr.html_url || null,
      mergedAt: merged?.original || null,
      mergedAtMs: merged?.utcMs ?? null,
    });
  }
  const ready = parseInstant(raw.readyAt);
  return {
    ref,
    body: raw.body || '',
    state: raw.state || null,
    closedAt: closedAt?.original || null,
    closedAtMs: closedAt?.utcMs ?? null,
    closedBy,
    pullRequests: prs,
    readyAt: ready?.original || null,
    readyAtMs: ready?.utcMs ?? (prs.length ? Math.max(...prs.map((pr) => pr.mergedAtMs).filter(Number.isFinite)) : null),
    htmlUrl: raw.html_url || raw.url || null,
    labeledSample: Boolean(raw.labeledSample),
  };
}

export function normalizeAlert(raw, line = null) {
  if (!isObject(raw)) return null;
  const at = parseInstant(raw.ts || raw.at || raw.createdAt);
  const kind = typeof raw.kind === 'string' ? raw.kind : null;
  if (!kind) return null;
  const issue = raw.issue ? String(raw.issue) : null;
  const deploySha = raw.deploySha || raw.head || raw.target || null;
  const keepalive = HEARTBEAT_ALERT_KINDS.has(kind) || (kind === 'loop-restarted' && /heartbeat/.test(String(raw.reason || '')));
  return {
    kind,
    issue,
    deploySha,
    ts: at?.original || raw.ts || null,
    tsMs: at?.utcMs ?? null,
    zoneHint: at?.zoneHint || null,
    reason: raw.reason || null,
    line,
    keepalive,
    key: `${kind}|${issue || ''}|${deploySha || ''}`,
  };
}

export function normalizeDeployRecord(raw, line = null) {
  if (!isObject(raw)) return null;
  if ('lagReportedFor' in raw || (Array.isArray(raw.alerted) && !raw.toSha && !raw.fromSha && !raw.authorization)) {
    return { format: 'legacy-state', unknownAuth: true, line, rawKeys: Object.keys(raw) };
  }
  const ts = parseInstant(raw.ts || raw.at);
  const result = raw.result || raw.status || null;
  const toSha = raw.toSha || raw.target || raw.sha || null;
  const fromSha = raw.fromSha || raw.head || raw.from || null;
  const auth = isObject(raw.authorization) ? raw.authorization : null;
  const sensitiveFiles = Array.isArray(raw.sensitiveFiles) ? raw.sensitiveFiles : [];
  const sensitive = raw.sensitive === true || sensitiveFiles.length > 0;
  return {
    format: 'b-log',
    unknownAuth: !auth,
    ts: ts?.original || null,
    tsMs: ts?.utcMs ?? null,
    result,
    fromSha,
    toSha,
    commits: Array.isArray(raw.commits) ? raw.commits : [],
    sensitiveFiles,
    sensitive,
    authorization: auth,
    line,
    sourceId: raw.id || raw.logId || (line != null ? `deploy-log:${line}` : toSha),
  };
}

export function heartbeatFreshness(heartbeat, nowMs) {
  if (!isObject(heartbeat) || heartbeat.at == null) {
    return { unknown: true, reason: 'missing-heartbeat', notInQualityPassRate: true };
  }
  const at = parseInstant(heartbeat.at);
  if (!at) return { unknown: true, reason: 'unparseable-heartbeat-at', notInQualityPassRate: true };
  const raw = heartbeat.tickIntervalS;
  const tickS =
    typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= HEARTBEAT_TICK_MAX_S ? raw : HEARTBEAT_TICK_DEFAULT_S;
  const maxAgeMs = tickS * 1000 + HEARTBEAT_MARGIN_MS;
  const ageMs = nowMs - at.utcMs;
  return {
    unknown: false,
    notInQualityPassRate: true,
    fresh: ageMs <= maxAgeMs,
    ageMs,
    maxAgeMs,
    tickIntervalSUsed: tickS,
    at: at.original,
    atMs: at.utcMs,
    zoneHint: at.zoneHint,
  };
}

function sourceOfRound(round) {
  return {
    issue: round.issueRef,
    round: round.round,
    commentId: round.commentId,
    commentUrl: round.commentUrl,
    originalStartedAt: round.startedAt,
    originalFinishedAt: round.finishedAt,
    startedZoneHint: round.startedZoneHint,
    finishedZoneHint: round.finishedZoneHint,
    bodyVersion: round.bodyVersion,
  };
}

function originalCondition(round) {
  if (round.status !== '通过') return { ok: false, unknown: false, why: `终局是${round.status}` };
  if (!round.items.length) return { ok: false, unknown: true, why: '通过评论没有逐条结果' };
  const manuals = round.items.filter((item) => item.result === '人工手测');
  const empty = round.items.filter((item) => item.result === '通过' && item.evidenceClass.kind === 'empty');
  const temp = round.items.filter((item) => item.evidenceClass.kind === 'temp-copy-extra-tests');
  const bad = round.items.filter((item) => item.result === '要修' || item.result === '有争议');
  if (bad.length) return { ok: false, unknown: false, why: '含要修或有争议', items: bad.map((i) => `${i.ref} SC${i.sc}`) };
  if (manuals.length) return { ok: false, unknown: false, why: '含人工手测', items: manuals.map((i) => `${i.ref} SC${i.sc}`) };
  if (empty.length) return { ok: false, unknown: false, why: '含空证据通过', items: empty.map((i) => `${i.ref} SC${i.sc}`) };
  if (temp.length) {
    return { ok: false, unknown: false, pendingReview: true, why: '含临时副本补测试，待核实', items: temp.map((i) => `${i.ref} SC${i.sc}`) };
  }
  const notPass = round.items.filter((item) => item.result !== '通过');
  if (notPass.length) return { ok: false, unknown: false, why: '存在非通过项' };
  return { ok: true, unknown: false };
}

function firstFinal(rounds) {
  const ordered = [...rounds].sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    const ia = Number(a.commentId) || 0;
    const ib = Number(b.commentId) || 0;
    return ia - ib;
  });
  return ordered.find((round) => FINAL_STATUSES.has(round.status)) || null;
}

function measured(numerator, denominator, sources) {
  return { unknown: false, numerator, denominator, sources };
}

function unknownMetric(reason, extra = {}) {
  return { unknown: true, numerator: null, denominator: null, reason, ...extra };
}

function emptyMeasured() {
  return measured(0, 0, []);
}

export function groupRounds(comments) {
  const byIssue = new Map();
  for (const round of comments) {
    if (!round?.issueRef) continue;
    if (!byIssue.has(round.issueRef)) byIssue.set(round.issueRef, []);
    byIssue.get(round.issueRef).push(round);
  }
  return byIssue;
}

function readyMsOf(issue) {
  if (Number.isFinite(issue?.readyAtMs)) return issue.readyAtMs;
  const merged = (issue?.pullRequests || []).map((pr) => pr.mergedAtMs).filter(Number.isFinite);
  if (merged.length) return Math.max(...merged);
  return null;
}

function validUserAuth(record) {
  const auth = record.authorization;
  if (!isObject(auth)) return false;
  const type = String(auth.authorType || auth.type || '');
  const sha = String(auth.sha || auth.targetSha || '');
  const url = auth.commentUrl || auth.url;
  if (type !== 'User') return false;
  if (!url) return false;
  if (!SHA_FULL.test(sha) || !SHA_FULL.test(String(record.toSha || ''))) return false;
  return sha.toLowerCase() === String(record.toSha).toLowerCase();
}

function dailyBucket(window) {
  const out = {};
  for (const date of window.completeLocalDays) {
    out[date] = {
      localDate: date,
      firstFinals: 0,
      envWaits: 0,
      claims: 0,
    };
  }
  return out;
}

/**
 * @param {object} snapshot
 * @param {object} window completeLocalWindow()
 * @param {{ nowMs?: number, labeledSample?: boolean }} [opts]
 */
export function computeMetrics(snapshot, window, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const issues = new Map();
  for (const issue of snapshot.issues || []) {
    if (issue?.ref) issues.set(issue.ref, issue);
  }
  const roundsByIssue = groupRounds(snapshot.rounds || []);
  for (const ref of roundsByIssue.keys()) {
    if (!issues.has(ref)) issues.set(ref, { ref, pullRequests: [], labeledSample: Boolean(opts.labeledSample) });
  }
  const events = snapshot.events || [];
  const alerts = snapshot.alerts || [];
  const deployments = snapshot.deployments || [];
  const hasComments = snapshot.commentsProvided === true;
  const hasEvents = snapshot.eventsProvided === true;
  const hasAlerts = snapshot.alertsProvided === true;
  const deployCoverage = snapshot.deployCoverage || 'missing';
  const hasHeartbeat = snapshot.heartbeat != null;

  const missing = [];
  if (!hasComments) missing.push('轮次评论副本（GitHub issue comments，REST 或 GraphQL）');
  if (!hasEvents) missing.push('issue events 的 closed/reopened（GET /issues/{n}/events）');
  if (!hasAlerts) missing.push('生产 alerts.jsonl 只读副本（显式 --alerts，无默认路径）');
  if (deployCoverage === 'missing') missing.push('追加式部署日志（B 合入后）；现有 deploy-ff.json 只能证明授权未知');
  if (deployCoverage === 'legacy-state') missing.push('legacy deploy-ff.json 无授权来源，授权指标为 unknown');
  if (!hasHeartbeat) missing.push('生产 heartbeat.json 只读副本（显式 --heartbeat）');
  missing.push('完整舰队 issue 清单：本工具不能证明输入已覆盖窗口内全部任务');

  const firstPassSources = [];
  const firstPassUnknown = [];
  const firstPassDenom = [];
  const reworkSources = [];
  const reworkDenom = [];
  const emptyEvidence = [];
  const humanClose = [];
  const tempCopy = [];
  const falseCloseDenom = [];
  const delivery = [];
  const envWaits = [];
  const repeatClaims = [];
  let claimCount = 0;
  const daily = dailyBucket(window);
  const sampleIssues = [];

  for (const [ref, rounds] of roundsByIssue) {
    const issue = issues.get(ref) || { ref, pullRequests: [] };
    if (issue.labeledSample || opts.labeledSample) sampleIssues.push(ref);
    const windowRounds = rounds.filter((round) => inWindow(round.startedAtMs ?? round.finishedAtMs, window));
    for (const round of windowRounds) {
      claimCount += 1;
      const day = localDateOf(round.startedAtMs ?? round.finishedAtMs, window.timeZone);
      if (daily[day]) daily[day].claims += 1;
      if (round.envWait) {
        envWaits.push({
          ...sourceOfRound(round),
          minutes:
            Number.isFinite(round.finishedAtMs) && Number.isFinite(round.startedAtMs)
              ? (round.finishedAtMs - round.startedAtMs) / 60000
              : null,
        });
        if (daily[day]) daily[day].envWaits += 1;
      }
    }

    const ordered = [...rounds].sort((a, b) => a.round - b.round || Number(a.commentId) - Number(b.commentId));
    let runSig = null;
    let runStart = null;
    for (const round of ordered) {
      const sig = `${ref}|${round.bodyVersion || ''}|${round.mainSha || ''}`;
      const at = round.startedAtMs;
      if (!inWindow(at, window)) {
        runSig = sig;
        runStart = round;
        continue;
      }
      const sameBody = runSig && runStart && runStart.bodyVersion && runStart.bodyVersion === round.bodyVersion;
      if (sameBody) {
        repeatClaims.push({
          ...sourceOfRound(round),
          previousRound: runStart.round,
          previousCommentId: runStart.commentId,
          mainShaKnown: Boolean(round.mainSha),
        });
      }
      runSig = sig;
      runStart = round;
    }

    const final = firstFinal(rounds);
    if (!final || !inWindow(final.finishedAtMs ?? final.startedAtMs, window)) continue;
    const finalAt = final.finishedAtMs ?? final.startedAtMs;
    const day = localDateOf(finalAt, window.timeZone);
    if (daily[day]) daily[day].firstFinals += 1;

    const judged = originalCondition(final);
    if (judged.unknown) firstPassUnknown.push({ ...sourceOfRound(final), why: judged.why });
    else {
      firstPassDenom.push(sourceOfRound(final));
      if (judged.ok) firstPassSources.push(sourceOfRound(final));
    }
    for (const item of final.items.filter((entry) => entry.evidenceClass.kind === 'temp-copy-extra-tests')) {
      tempCopy.push({ ...sourceOfRound(final), sc: `${item.ref} SC${item.sc}`, label: '待核实' });
    }
    for (const item of final.items.filter((entry) => entry.result === '通过' && entry.evidenceClass.kind === 'empty')) {
      emptyEvidence.push({ ...sourceOfRound(final), sc: `${item.ref} SC${item.sc}` });
    }

    reworkDenom.push(sourceOfRound(final));
    const laterFix = ordered.some((round) => round.round > final.round && round.status === '要修');
    const reopened = events.some(
      (event) => event.issueRef === ref && event.event === 'reopened' && event.atMs > (finalAt || 0),
    );
    if (laterFix || reopened) {
      reworkSources.push({ ...sourceOfRound(final), laterFix, reopened });
    }

    const close = events
      .filter((event) => event.issueRef === ref && event.event === 'closed')
      .sort((a, b) => (a.atMs || 0) - (b.atMs || 0))
      .at(-1);
    const closer = close?.actor || issue.closedBy;
    const closeMs = close?.atMs ?? issue.closedAtMs;
    if (final.status === '通过' && closer?.type === 'Bot' && inWindow(closeMs, window)) {
      falseCloseDenom.push({
        ...sourceOfRound(final),
        eventId: close?.eventId ?? null,
        closer: closer.login,
        closedAt: close?.at || issue.closedAt,
      });
      const manuals = final.items.filter((item) => item.result === '人工手测');
      if (manuals.length) {
        humanClose.push({
          ...sourceOfRound(final),
          eventId: close?.eventId ?? null,
          closer: closer.login,
          items: manuals.map((item) => `${item.ref} SC${item.sc}`),
        });
      }
    }

    const readyMs = readyMsOf(issue);
    const envBefore = ordered.filter((round) => round.envWait && (round.finishedAtMs || 0) <= (finalAt || 0));
    const envMinutes = envBefore.reduce((sum, round) => {
      if (!Number.isFinite(round.finishedAtMs) || !Number.isFinite(round.startedAtMs)) return sum;
      return sum + (round.finishedAtMs - round.startedAtMs) / 60000;
    }, 0);
    delivery.push({
      ...sourceOfRound(final),
      readyAtMs: readyMs,
      readyUnknown: !Number.isFinite(readyMs),
      firstFinalAtMs: finalAt,
      deliveryMinutes: Number.isFinite(readyMs) && Number.isFinite(finalAt) ? (finalAt - readyMs) / 60000 : null,
      envWaitMinutes: envMinutes,
      envWaitRounds: envBefore.map((round) => sourceOfRound(round)),
    });
  }

  const qualityAlertRows = alerts.filter((row) => !row.keepalive && Number.isFinite(row.tsMs));
  const keepaliveAlertRows = alerts.filter((row) => row.keepalive && Number.isFinite(row.tsMs));
  let repeatAlerts = hasAlerts ? emptyMeasured() : unknownMetric('alerts.jsonl 未提供');
  if (hasAlerts) {
    const inWin = qualityAlertRows.filter((row) => inWindow(row.tsMs, window));
    const extras = [];
    const lastByKey = new Map();
    const ordered = [...inWin].sort((a, b) => a.tsMs - b.tsMs);
    for (const row of ordered) {
      const prev = lastByKey.get(row.key);
      if (prev && row.tsMs - prev.groupStartMs <= ALERT_DEDUP_MS) {
        extras.push({
          kind: row.kind,
          issue: row.issue,
          deploySha: row.deploySha,
          ts: row.ts,
          line: row.line,
          previousTs: prev.ts,
          previousLine: prev.line,
        });
      } else {
        lastByKey.set(row.key, { ...row, groupStartMs: row.tsMs });
      }
    }
    repeatAlerts = measured(extras.length, inWin.length, extras);
  }

  let deployAuth = unknownMetric('无追加部署日志；legacy 授权未知');
  if (deployCoverage === 'legacy-state') {
    deployAuth = unknownMetric('legacy deploy-ff.json 无授权来源评论', { format: 'legacy-state' });
  } else if (deployCoverage === 'b-log') {
    const deployed = deployments.filter((row) => row.format === 'b-log' && row.result === 'deployed' && inWindow(row.tsMs, window));
    if (deployed.some((row) => row.sensitive && row.unknownAuth)) {
      // 有 deployed 行但授权字段缺失：这些行本身 unknown，不把全体记 0。
    }
    const judged = deployed.filter((row) => row.sensitive);
    const unknownRows = judged.filter((row) => row.unknownAuth);
    const known = judged.filter((row) => !row.unknownAuth);
    const unverifiable = known.filter((row) => !validUserAuth(row));
    const verifiable = known.filter((row) => validUserAuth(row));
    if (!deployed.length && unknownRows.length === 0) {
      deployAuth = measured(0, 0, []);
      deployAuth.format = 'b-log';
    } else if (unknownRows.length && !known.length) {
      deployAuth = unknownMetric('B 日志有部署行但无 authorization 字段', {
        format: 'b-log',
        sources: unknownRows.map((row) => ({ sourceId: row.sourceId, toSha: row.toSha, ts: row.ts })),
      });
    } else {
      deployAuth = measured(unverifiable.length, known.length, unverifiable.map((row) => ({
        sourceId: row.sourceId,
        toSha: row.toSha,
        ts: row.ts,
        authorType: row.authorization?.authorType || row.authorization?.type || null,
        commentUrl: row.authorization?.commentUrl || null,
      })));
      deployAuth.format = 'b-log';
      deployAuth.verifiable = verifiable.map((row) => ({ sourceId: row.sourceId, toSha: row.toSha, commentUrl: row.authorization.commentUrl }));
      if (unknownRows.length) deployAuth.unknownRows = unknownRows.length;
    }
  }

  const fullSigUnknown = (snapshot.rounds || []).every((round) => !round.mainSha);
  const latencyKnown = delivery.filter((row) => row.deliveryMinutes != null);
  const envSeries = delivery.map((row) => ({
    issue: row.issue,
    envWaitMinutes: row.envWaitMinutes,
    rounds: row.envWaitRounds,
  }));

  return {
    window: {
      timeZone: window.timeZone,
      fromLocalDate: window.fromLocalDate,
      toLocalDate: window.toLocalDate,
      startUtc: window.startUtc,
      endUtcExclusive: window.endUtcExclusive,
      completeLocalDays: window.completeLocalDays,
      note: window.note,
    },
    coverage: {
      comments: hasComments,
      events: hasEvents,
      alerts: hasAlerts ? 'present' : 'missing',
      deploy: deployCoverage,
      heartbeat: hasHeartbeat,
      productionSevenDayFleet: false,
      note: '不能声称已算全舰队七天；见 missingProductionData',
    },
    metrics: {
      firstPassOriginal: {
        ...(hasComments
          ? { ...measured(firstPassSources.length, firstPassDenom.length, firstPassSources), unknownIssues: firstPassUnknown }
          : unknownMetric('未提供轮次评论')),
        definition: '分子：第一次终局是通过，且逐条都是带证据的通过（无人工手测/空证据/待核实临时补测试）。分母：窗口内第一次终局可判定的单。去重：一单一条。纯中断不进分母。',
      },
      rework: {
        ...(hasComments
          ? measured(reworkSources.length, reworkDenom.length, reworkSources)
          : unknownMetric('未提供轮次评论')),
        definition: '分子：终局之后又出现要修，或通过之后被重开。分母：有终局的单。去重：一单最多一次。',
      },
      emptyEvidencePass: {
        ...(hasComments
          ? measured(emptyEvidence.length, firstPassDenom.length, emptyEvidence)
          : unknownMetric('未提供轮次评论')),
        definition: '分子：通过终局里存在空证据的通过项。分母：可判定终局单。不是 0 填充。',
      },
      humanUnverifiedClose: hasEvents
        ? {
            ...measured(humanClose.length, falseCloseDenom.length, humanClose),
            definition: '分子：bot 关单且通过评论含人工手测。分母：窗口内 bot 关闭的通过单。去重：一单一条。',
          }
        : unknownMetric('未提供 issue closed 事件，人工未验关单无法核实 closer'),
      tempCopyUnverified: {
        ...(hasComments
          ? measured(tempCopy.length, firstPassDenom.length, tempCopy)
          : unknownMetric('未提供轮次评论')),
        cheat: false,
        label: '待核实',
        definition: '证据含「临时副本补」测试/用例。不自动记作弊。可写副本跑已入库测试不算此项。',
      },
      deployAuth,
      deliveryLatency: {
        unknown: latencyKnown.length === 0,
        numerator: null,
        denominator: latencyKnown.length,
        unit: 'minutes',
        values: latencyKnown.map((row) => ({
          issue: row.issue,
          commentId: row.commentId,
          minutes: row.deliveryMinutes,
          readyAtMs: row.readyAtMs,
          firstFinalAtMs: row.firstFinalAtMs,
        })),
        unknownIssues: delivery.filter((row) => row.readyUnknown).map((row) => sourceOfRound({ ...row, issueRef: row.issue, round: row.round, commentId: row.commentId, commentUrl: row.commentUrl, startedAt: row.originalStartedAt, finishedAt: row.originalFinishedAt, startedZoneHint: row.startedZoneHint, finishedZoneHint: row.finishedZoneHint, bodyVersion: row.bodyVersion })),
        envWaitSeparate: envSeries,
        definition: '交付时延：子 PR 全合入（readyAt）到第一次终局的分钟数。环境等待另列，不从时延里偷偷扣掉。缺 mergedAt 为 unknown。',
      },
      repeatClaimSameBody: {
        ...(hasComments
          ? measured(repeatClaims.length, claimCount, repeatClaims)
          : unknownMetric('未提供轮次评论')),
        definition: '分子：同一 issue+正文版本在窗口内的再次认领。分母：窗口内认领次数。连续同一签名逐次计入。main SHA 多数评论没有，完整签名见下项。',
      },
      repeatWakeFullSignature: !hasComments
        ? unknownMetric('未提供轮次评论')
        : fullSigUnknown
          ? unknownMetric('轮次评论不含 main SHA，完整「issue+正文哈希+main SHA」重复唤醒无法从 GitHub 评论算出')
          : measured(
              repeatClaims.filter((row) => row.mainShaKnown).length,
              claimCount,
              repeatClaims.filter((row) => row.mainShaKnown),
            ),
      repeatAlerts,
    },
    daily: window.completeLocalDays.map((date) => daily[date]),
    keepalive: {
      notInQualityPassRate: true,
      heartbeat: heartbeatFreshness(snapshot.heartbeat, nowMs),
      heartbeatAlerts: hasAlerts
        ? measured(
            keepaliveAlertRows.filter((row) => inWindow(row.tsMs, window)).length,
            keepaliveAlertRows.filter((row) => inWindow(row.tsMs, window)).length,
            keepaliveAlertRows.filter((row) => inWindow(row.tsMs, window)).map((row) => ({ kind: row.kind, ts: row.ts, line: row.line, issue: row.issue })),
          )
        : unknownMetric('alerts.jsonl 未提供'),
    },
    samples: {
      labeled: sampleIssues.length > 0 || Boolean(opts.labeledSample),
      doNotExtrapolate: true,
      issues: [...new Set(sampleIssues)],
      note: '已确认样本不能外推舰队整体。',
    },
    missingProductionData: missing,
    writeSideEffects: false,
  };
}

export function unwrapComments(input, issueRef = null) {
  if (Array.isArray(input)) return input.map((row) => ({ ...row, issueRef: row.issueRef || issueRef }));
  if (isObject(input) && Array.isArray(input.comments)) {
    return input.comments.map((row) => ({ ...row, issueRef: row.issueRef || issueRef }));
  }
  const issue = input?.data?.repository?.issue || input?.repository?.issue;
  if (issue) {
    const ref =
      issueRef ||
      (issue.repository?.nameWithOwner && issue.number ? `${issue.repository.nameWithOwner}#${issue.number}` : null);
    const nodes = issue.comments?.nodes || [];
    return nodes.map((row) => ({ ...row, issueRef: ref }));
  }
  if (isObject(input) && Array.isArray(input.nodes)) {
    return input.nodes.map((row) => ({ ...row, issueRef: row.issueRef || issueRef }));
  }
  return [];
}

export function unwrapList(input, keys = []) {
  if (Array.isArray(input)) return input;
  for (const key of keys) {
    if (Array.isArray(input?.[key])) return input[key];
  }
  if (Array.isArray(input?.nodes)) return input.nodes;
  return [];
}

export function readJsonFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text);
}

export function readJsonlFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const rows = [];
  text.split('\n').forEach((line, index) => {
    if (!line.trim()) return;
    try {
      rows.push({ line: index + 1, value: JSON.parse(line) });
    } catch {
      rows.push({ line: index + 1, value: null, parseError: true });
    }
  });
  return rows;
}

function existingFile(file) {
  return typeof file === 'string' && file.length && fs.existsSync(file);
}

export function loadSnapshot({
  snapshot,
  comments,
  issues,
  events,
  alerts,
  deployLog,
  deployState,
  heartbeat,
  issueRef,
  allowLogins,
  labeledSample,
} = {}) {
  let bundle = {};
  let baseDir = null;
  if (snapshot) {
    const stat = fs.statSync(snapshot);
    if (stat.isDirectory()) {
      baseDir = snapshot;
      bundle = {};
    } else {
      bundle = readJsonFile(snapshot);
    }
  }

  const fileFrom = (explicit, name) => explicit || (baseDir ? path.join(baseDir, name) : null);

  const commentsFile = fileFrom(comments, 'comments.json');
  const issuesFile = fileFrom(issues, 'issues.json');
  const eventsFile = fileFrom(events, 'events.json');
  const alertsFile = fileFrom(alerts, 'alerts.jsonl');
  const deployLogFile = fileFrom(deployLog, 'deploy-log.jsonl');
  const deployStateFile = fileFrom(deployState, 'deploy-ff.json');
  const heartbeatFile = fileFrom(heartbeat, 'heartbeat.json');

  let commentRaw = null;
  let commentsProvided = false;
  if (existingFile(commentsFile)) {
    commentRaw = readJsonFile(commentsFile);
    commentsProvided = true;
  } else if (bundle.comments != null) {
    commentRaw = bundle.comments;
    commentsProvided = true;
  } else if (bundle.data?.repository?.issue) {
    commentRaw = bundle;
    commentsProvided = true;
  } else if (Array.isArray(bundle)) {
    commentRaw = bundle;
    commentsProvided = true;
  }
  const issueRaw = existingFile(issuesFile) ? readJsonFile(issuesFile) : bundle.issues;
  const eventRaw = existingFile(eventsFile) ? readJsonFile(eventsFile) : bundle.events;
  let alertRows = [];
  let alertsProvided = false;
  if (existingFile(alertsFile)) {
    alertsProvided = true;
    alertRows = readJsonlFile(alertsFile);
  } else if (Array.isArray(bundle.alerts)) {
    alertsProvided = true;
    alertRows = bundle.alerts.map((value, i) => ({ line: i + 1, value }));
  }

  let deployRows = [];
  let deployCoverage = 'missing';
  if (existingFile(deployLogFile)) {
    deployCoverage = 'b-log';
    deployRows = readJsonlFile(deployLogFile);
  } else if (Array.isArray(bundle.deployments) || Array.isArray(bundle.deployLog)) {
    deployCoverage = 'b-log';
    deployRows = (bundle.deployments || bundle.deployLog).map((value, i) => ({ line: i + 1, value }));
  } else if (existingFile(deployStateFile)) {
    deployCoverage = 'legacy-state';
    deployRows = [{ line: 1, value: readJsonFile(deployStateFile) }];
  } else if (bundle.deployState) {
    deployCoverage = 'legacy-state';
    deployRows = [{ line: 1, value: bundle.deployState }];
  }

  const heartbeatObj = existingFile(heartbeatFile)
    ? readJsonFile(heartbeatFile)
    : bundle.heartbeat || null;

  const allow = allowLogins?.length ? new Set(allowLogins.map((n) => String(n).toLowerCase())) : null;
  const rawComments = commentRaw ? unwrapComments(commentRaw, issueRef) : [];
  const rounds = [];
  for (const raw of rawComments) {
    const round = normalizeComment(raw, { allowLogins: allow, issueRef: raw.issueRef || issueRef });
    if (round) rounds.push(round);
  }

  const normalizedIssues = unwrapList(issueRaw, ['issues']).map(normalizeIssue).filter(Boolean);
  if (labeledSample) {
    for (const issue of normalizedIssues) issue.labeledSample = true;
  }

  const eventList = [];
  const rawEvents = eventRaw ? unwrapList(eventRaw, ['events']) : [];
  for (const raw of rawEvents) {
    const event = normalizeEvent(raw, { issueRef: raw.issueRef || issueRef });
    if (event) eventList.push(event);
  }
  if (!eventList.length && normalizedIssues.some((issue) => issue.closedAt)) {
    for (const issue of normalizedIssues) {
      if (!issue.closedAt) continue;
      eventList.push({
        event: 'closed',
        eventId: null,
        at: issue.closedAt,
        atMs: issue.closedAtMs,
        actor: issue.closedBy || { login: '', type: 'unknown' },
        issueRef: issue.ref,
        inferredFromIssue: true,
      });
    }
  }

  const normalizedAlerts = alertRows
    .filter((row) => !row.parseError)
    .map((row) => normalizeAlert(row.value, row.line))
    .filter(Boolean);

  const deployments = [];
  for (const row of deployRows) {
    const rec = normalizeDeployRecord(row.value, row.line);
    if (rec) deployments.push(rec);
  }
  if (deployCoverage === 'b-log' && deployments.every((row) => row.format === 'legacy-state')) {
    deployCoverage = 'legacy-state';
  }

  return {
    rounds,
    rawCommentCount: rawComments.length,
    commentsProvided,
    issues: normalizedIssues,
    events: eventList,
    eventsProvided: eventRaw != null || eventList.some((event) => event.eventId != null),
    alerts: normalizedAlerts,
    alertsProvided,
    deployments,
    deployCoverage,
    heartbeat: heartbeatObj,
    labeledSample: Boolean(labeledSample || bundle.labeledSample || bundle.meta?.sample),
  };
}

export function parseArgs(argv) {
  const out = {
    snapshot: null,
    comments: null,
    issues: null,
    events: null,
    alerts: null,
    deployLog: null,
    deployState: null,
    heartbeat: null,
    timeZone: DEFAULT_TIMEZONE,
    from: null,
    to: null,
    windowDays: DEFAULT_WINDOW_DAYS,
    now: null,
    issueRef: null,
    roundAuthors: [],
    labeledSample: false,
    help: false,
  };
  const args = [...argv];
  while (args.length) {
    const arg = args.shift();
    const take = () => {
      if (!args.length) throw new Error(`${arg} 需要一个值`);
      return args.shift();
    };
    switch (arg) {
      case '--help':
      case '-h':
        out.help = true;
        break;
      case '--snapshot':
        out.snapshot = take();
        break;
      case '--comments':
        out.comments = take();
        break;
      case '--issues':
        out.issues = take();
        break;
      case '--events':
        out.events = take();
        break;
      case '--alerts':
        out.alerts = take();
        break;
      case '--deploy-log':
        out.deployLog = take();
        break;
      case '--deploy-state':
        out.deployState = take();
        break;
      case '--heartbeat':
        out.heartbeat = take();
        break;
      case '--timezone':
        out.timeZone = take();
        break;
      case '--from':
        out.from = take();
        break;
      case '--to':
        out.to = take();
        break;
      case '--window-days':
        out.windowDays = Number(take());
        break;
      case '--now':
        out.now = take();
        break;
      case '--issue-ref':
        out.issueRef = take();
        break;
      case '--round-authors':
        out.roundAuthors = take()
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean);
        break;
      case '--labeled-sample':
        out.labeledSample = true;
        break;
      default:
        throw new Error(`不认识的参数：${arg}`);
    }
  }
  return out;
}

export const USAGE = `用法：node watchers/acceptance/bin/fleet-quality-stats.mjs --snapshot <file.json|dir> [选项]
只读。不读令牌，不读 ACCEPTANCE_WATCHER_HOME，不写 GitHub。路径必须显式传入。

选项：
  --comments --issues --events --alerts --deploy-log --deploy-state --heartbeat
  --timezone America/Los_Angeles   默认
  --from YYYY-MM-DD --to YYYY-MM-DD
  --window-days 7
  --now <ISO>
  --issue-ref owner/repo#n
  --round-authors login[bot],...
  --labeled-sample
`;

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    stderr.write(`${error.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    stdout.write(USAGE);
    return 0;
  }
  if (!args.snapshot && !args.comments) {
    stderr.write(`需要 --snapshot 或 --comments\n${USAGE}`);
    return 2;
  }
  const nowMs = args.now ? Date.parse(args.now) : Date.now();
  if (!Number.isFinite(nowMs)) {
    stderr.write(`--now 不是合法时间：${args.now}\n`);
    return 2;
  }
  let window;
  try {
    window = completeLocalWindow({
      nowMs,
      timeZone: args.timeZone,
      days: args.windowDays,
      fromDate: args.from,
      toDate: args.to,
    });
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 2;
  }
  let snapshot;
  try {
    snapshot = loadSnapshot(args);
  } catch (error) {
    stderr.write(`读输入失败：${error.message}\n`);
    return 1;
  }
  const report = computeMetrics(snapshot, window, { nowMs, labeledSample: snapshot.labeledSample || args.labeledSample });
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
