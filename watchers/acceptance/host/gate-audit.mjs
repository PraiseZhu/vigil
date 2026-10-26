#!/usr/bin/env node
// 写闸账本旁路审计：只读 <home>/state/write-gate/ledger.jsonl，逐条核对每条已执行的写入是否在写闸规则内。
// 不碰写闸本身：不改账本、不开关写闸、不写 GitHub。
//
// 两级分类（见 DEFINITE_RULES / UNCERTAIN_RULES）：
// - 明确违规（level=violation）：明细记进审计日志，再写一条 gate-audit-violation 提醒（由 slack-notify 发四段式通知）；
// - 拿不准（level=uncertain）：只记审计日志，绝不写提醒、绝不让 doctor 变红。同一条只报一次（按指纹去重）。
//
// 用法：
//   node host/gate-audit.mjs [--github] [--no-alert] [--json]   跑一次审计（--github 才做只读的评论核对）
//   node host/gate-audit.mjs --ack                              人处理完后清零「基线后明确违规数」
//   node host/gate-audit.mjs --summary [--hours N] [--json]     只读汇总最近 N 小时（默认 24）的审计日志
//
// 退出码：0 = 没有新的明确违规且基线后已清零；1 = 有明确违规；2 = 只有拿不准 / GitHub 没查成 / 锁被占；
//         3 = 运行出错（stderr 打一行错误）。--ack / --summary 成功即 0。
//
// 边界：GitHub 只做只读查询；本地只写 state/host 下的审计状态、审计日志和提醒队列（alerts.jsonl）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_ACTION_WRITE_TYPES, WRITE_TYPES, createGithub } from '../bin/github.mjs';
import { isVerdictOnly, loadAcceptanceProfile, watcherHome } from '../bin/profile.mjs';
import { ISSUE_COMMENTS_QUERY } from '../bin/rounds.mjs';
import { repoTier } from '../bin/tasks.mjs';
import { acquireLock, appendAlert, hostPaths, releaseLock } from './paths.mjs';
import { loadScopes, scopeForEntry } from './scope-snapshot.mjs';

export const AUDIT_ALERT_KIND = 'gate-audit-violation';
export const AUDIT_STATE_VERSION = 1;
/**
 * 判定规则的版本。规则改了（比如 v2 起仓范围按写入当时的快照判），常驻审计下一拍会按新规则把
 * 基线后的账本重算一遍（recheck），旧规则下的误判从「基线后违规数」里消掉；真违规照样算。
 * 这不是 --ack：不看人、不清零，按账本重新算出来是几条就是几条。
 */
export const AUDIT_RULES_VERSION = 2;
/** 去重指纹最多留这么多条（账本一天一两百条，够用很久）。 */
export const AUDIT_SEEN_LIMIT = 5000;
/** 一条提醒里最多带几条明细（其余在审计日志里）。 */
export const AUDIT_DETAIL_LIMIT = 5;
/** 汇总里每类最多列几条（其余只报总数）。 */
export const SUMMARY_LIMIT = 50;
/** 「拿不准」的近 N 小时条数窗口。 */
export const UNCERTAIN_WINDOW_HOURS = 24;

/** 明确违规：写闸规则写得死死的、不用补充上下文就能判定的那几种；白名单外的写类型、账本被改写或截短也算。 */
export const DEFINITE_RULES = new Set([
  'pr-merge',
  'comment-delete',
  'repo-out-of-scope',
  'tier-not-allowed',
  'verdict-only-write',
  'round-comment-modified',
  'round-comment-missing',
  'type-not-allowed',
  'ledger-rewritten',
]);

/** 拿不准：认不出记录格式、缺轮次上下文、账本有读不出的行，只记日志。 */
export const UNCERTAIN_RULES = new Set([
  'no-round',
  'round-mismatch',
  'unverifiable',
  'ledger-corrupt',
]);

/** 规则 → 'violation' | 'uncertain'。不认识的规则按「拿不准」处理（宁可少报，不误报）。 */
export function ruleLevel(rule) {
  return DEFINITE_RULES.has(String(rule || '')) ? 'violation' : 'uncertain';
}

/** 写闸放行的写类型（和 write-gate.mjs 的 ALLOWED_TYPES 去掉只读、探测后一致）。 */
const ALLOWED_WRITE_TYPES = new Set([...WRITE_TYPES, ...GATE_ACTION_WRITE_TYPES]);
/** watch 档只许这几类（照抄 write-gate.mjs 的 WATCH_ALLOWED_TYPES，去掉只读）。 */
const WATCH_WRITE_TYPES = new Set(['comment.create', 'comment.update', 'project.field.set']);
/** 只出裁决的总 issue 上一律不许的写（照抄 write-gate.mjs 的 VERDICT_ONLY_BLOCKED）。 */
export const VERDICT_ONLY_BLOCKED = Object.freeze([
  'issue.close',
  'issue.edit',
  'issue.create',
  'issue.reopen',
  'subissue.add',
  'branch.push',
  'pr.create',
  'pr.ready',
]);
const VERDICT_ONLY_SET = new Set(VERDICT_ONLY_BLOCKED);

const REF = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d+)$/;
const COMMENT_URL = /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\/issues\/(\d+)#issuecomment-(\d+)/;
const ISSUE_URL = /https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)\/(?:issues|pull)\/\d+/;
const NUMERIC = /^\d+$/;

/** 违规代码 → 人话（进审计日志和 Slack 明细）。 */
export const RULE_TEXT = Object.freeze({
  'pr-merge': '账本里有合并 PR（pr.merge）的记录，写闸规则里根本不许合并',
  'type-not-allowed': '账本里有写闸白名单之外的写类型',
  'comment-delete': '账本里有删评论的记录，轮次评论不许删',
  'repo-out-of-scope': '写到了配置名单之外的仓',
  'tier-not-allowed': '只观察（watch）的仓上出现了不许的写',
  'verdict-only-write': '只出裁决的总 issue 上出现了不许的写（关、勾、开修正、推送之类）',
  'round-comment-modified': '轮次评论被不该改它的写入改了',
  'round-comment-missing': 'GitHub 上找不到账本里登记过的轮次评论（疑似被删）',
  'round-mismatch': '同一条写入里绑定的轮次和去重键里的轮次对不上',
  'no-round': '这条写入对不上任何登记过的轮次',
  unverifiable: '这条记录的格式认不出来，没法核对它属于哪一轮、写了哪个仓',
  'ledger-corrupt': '账本里有读不出的行',
  'ledger-rewritten': '账本已审计过的部分被改写或截短了（账本应只追加）',
});

function str(value) {
  return value === undefined || value === null ? '' : String(value);
}

function repoOfRef(ref) {
  const match = REF.exec(str(ref));
  return match ? match[1] : null;
}

function idOf(value) {
  const text = str(value);
  return NUMERIC.test(text) ? text : null;
}

/**
 * 把一条账本记录拆成审计要用的字段：碰到的仓、总 issue、轮次号、轮次评论 id、它是否开了一轮。
 * 认不出的格式返回 {known:false}。
 */
export function parseEntry(entry) {
  const key = str(entry?.dedupeKey);
  const type = str(entry?.type);
  const result = entry?.result && typeof entry.result === 'object' ? entry.result : {};
  const parts = key.split(':');
  const prefix = parts[0];
  const out = {
    key,
    type,
    prefix,
    known: true,
    refs: [],
    repos: [],
    root: null,
    round: null,
    keyCommentId: null,
    boundCommentId: idOf(entry?.boundCommentId),
    resultCommentId: idOf(result.commentId),
    opensRound: null,
    terminal: false,
    prbot: false,
    prbotCommentUpdate: false,
  };
  const ref = (value) => {
    if (REF.test(str(value))) out.refs.push(str(value));
    return REF.test(str(value)) ? str(value) : null;
  };
  switch (prefix) {
    case 'round-start':
      out.root = ref(parts[1]);
      out.round = Number(parts[2]);
      if (out.root && out.resultCommentId) {
        out.opensRound = { root: out.root, round: out.round, commentId: out.resultCommentId, kind: 'acceptance' };
      }
      break;
    case 'round-finish':
    case 'verdict':
      out.root = ref(parts[1]);
      out.round = Number(parts[2]);
      out.keyCommentId = parts.length >= 5 ? idOf(parts[3]) : null;
      out.terminal = true;
      break;
    case 'board-claim':
      ref(parts[1]);
      out.round = Number(parts[2]);
      out.keyCommentId = idOf(parts[3]);
      break;
    case 'board': {
      ref(parts[1]);
      const url = COMMENT_URL.exec(key);
      if (url) {
        out.root = ref(`${url[1]}#${url[2]}`);
        out.keyCommentId = url[3];
      }
      out.round = Number(parts.at(-1)) || null;
      break;
    }
    case 'close':
    case 'reopen':
      out.root = ref(parts[1]);
      out.round = Number(parts[2]);
      break;
    case 'close-edit':
      ref(parts[1]);
      out.round = Number(parts[2]);
      break;
    case 'correct':
    case 'correct-sub':
      out.root = ref(parts[1]);
      ref(parts[2]);
      out.round = Number(parts.at(-1));
      break;
    case 'push':
      if (/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(str(parts[1]))) out.repos.push(parts[1]);
      else out.known = false;
      break;
    case 'prbot': {
      out.prbot = true;
      out.root = ref(parts[1]);
      const roundTag = /^r(\d+)$/.exec(str(parts[2]));
      out.round = roundTag ? Number(roundTag[1]) : null;
      const claim = /^s\d+$/.test(str(parts[3])) && parts[4] === 'claim';
      if (claim) {
        if (out.root && out.resultCommentId) {
          out.opensRound = { root: out.root, round: out.round, commentId: out.resultCommentId, kind: 'prbot' };
        }
      } else {
        const tag = /^c(\d+)$/.exec(str(parts[3]));
        out.keyCommentId = tag ? tag[1] : null;
        out.prbotCommentUpdate = parts[4] === 'comment';
      }
      if (!out.root || out.round === null) out.known = false;
      break;
    }
    default:
      out.known = false;
  }
  if (out.known && out.refs.length === 0 && out.repos.length === 0) out.known = false;
  for (const value of [result.url, entry?.result?.html_url]) {
    const url = COMMENT_URL.exec(str(value)) || ISSUE_URL.exec(str(value));
    if (url) out.repos.push(url[1]);
  }
  for (const item of out.refs) out.repos.push(repoOfRef(item));
  out.repos = [...new Set(out.repos.filter(Boolean))];
  return out;
}

/** 造一条审计发现；level 一律由规则算，调用方不用管。 */
function makeFinding(line, rule, details = {}) {
  return {
    line,
    rule,
    type: details.type || '',
    key: details.key || '',
    root: details.root || null,
    text: RULE_TEXT[rule] || rule,
    ...details,
    level: ruleLevel(rule),
  };
}

function violation(line, rule, parsed, extra = {}) {
  return makeFinding(line, rule, {
    type: parsed?.type || '',
    key: parsed?.key || '',
    root: parsed?.root || null,
    ...extra,
  });
}

/**
 * 纯函数：核对整本账（entries 是按行解析好的记录；读不出的行传 null）。
 * 返回 {violations, rounds}：violations 带行号（从 1 起）；rounds 是账本里登记过的轮次（评论 id → 轮次）。
 * `from` = 只核对行号 > from 的记录（上下文仍按整本账算：轮次、改评论顺序都要看前面的）。
 * `scopes` = 写入当时的范围快照（指纹 → 范围，见 scope-snapshot.mjs）：记录带了能核对上的指纹，
 * 仓范围 / 分档 / 只出裁决就按写入当时的范围判；老记录没指纹才按当前 profile 判。
 */
export function auditEntries(entries, { profile, from = 0, scopes = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const parsed = list.map((entry) => (entry && typeof entry === 'object' ? parseEntry(entry) : null));
  /** 评论 id → {root, round, commentId, kind, line} */
  const rounds = new Map();
  parsed.forEach((item, index) => {
    if (item?.opensRound && !rounds.has(item.opensRound.commentId)) {
      rounds.set(item.opensRound.commentId, { ...item.opensRound, line: index + 1 });
    }
  });
  const latestStart = (root, round, beforeLine) => {
    let found = null;
    for (const value of rounds.values()) {
      if (value.kind !== 'acceptance' || value.line > beforeLine) continue;
      if (String(value.root).toLowerCase() === String(root || '').toLowerCase() && value.round === round) found = value;
    }
    return found;
  };

  const violations = [];
  const finished = new Set();
  parsed.forEach((item, index) => {
    const line = index + 1;
    const report = line > from;
    const push = (rule, extra) => {
      if (report) violations.push(violation(line, rule, item, extra));
    };
    if (!item) {
      push('ledger-corrupt');
      return;
    }
    // 1. 类型：pr.merge、删评论、白名单外
    let typeReported = false;
    if (item.type === 'pr.merge') {
      push('pr-merge');
      typeReported = true;
    } else if (item.type === 'comment.delete') {
      push('comment-delete');
      typeReported = true;
    } else if (!ALLOWED_WRITE_TYPES.has(item.type)) {
      push('type-not-allowed');
      typeReported = true;
    }

    // 格式都认不出时不再猜第二条：类型已经报过就到此为止，没报过才补一条 unverifiable。
    if (!item.known) {
      if (!typeReported) push('unverifiable');
      return;
    }

    // 2. 仓范围（以写闸的 repoTier 为准）和分档：按写入当时的范围判（有快照时），不按此刻的配置判
    const scoped = scopeForEntry(list[index], profile, scopes);
    for (const repo of item.repos) {
      const tier = repoTier(repo, scoped.profile);
      if (!tier) push('repo-out-of-scope', { repo, scopeSource: scoped.source });
      else if (tier.tier === 'watch' && !WATCH_WRITE_TYPES.has(item.type)) push('tier-not-allowed', { repo });
    }

    // 5. 轮次：绑定 id / 去重键里的 id / 评论更新的目标 id / 按总 issue + 轮次号找开轮记录
    if (item.boundCommentId && item.keyCommentId && item.boundCommentId !== item.keyCommentId) {
      push('round-mismatch', { detail: `绑定 ${item.boundCommentId}，去重键 ${item.keyCommentId}` });
    }
    let roundId = item.opensRound?.commentId || item.boundCommentId || item.keyCommentId || null;
    if (!roundId && item.terminal && item.resultCommentId) roundId = item.resultCommentId;
    if (!roundId && item.root && Number.isFinite(item.round)) roundId = latestStart(item.root, item.round, line)?.commentId || null;
    const known = roundId ? rounds.get(roundId) : null;
    if (!known) push('no-round', roundId ? { detail: `轮次评论 ${roundId}` } : {});
    else if (item.root && String(known.root).toLowerCase() !== String(item.root).toLowerCase()) {
      push('round-mismatch', { detail: `轮次评论 ${roundId} 属于 ${known.root}` });
    }
    const root = item.root || known?.root || null;
    if (!item.root && root) item.root = root;

    // 3. 只出裁决的总 issue
    if (root && isVerdictOnly(scoped.profile, root) && VERDICT_ONLY_SET.has(item.type)) push('verdict-only-write');

    // 4. 轮次评论被改：目标是登记过的轮次评论的 comment.update 只许是本轮的收尾（裁决 / 中断，各一次）
    //    或修正轮自己的状态更新（prbot …:comment:…）
    if (item.type === 'comment.update') {
      const target = item.resultCommentId || item.keyCommentId;
      const targetRound = target ? rounds.get(target) : null;
      if (targetRound) {
        let ok = false;
        if (targetRound.kind === 'acceptance') {
          ok = (item.prefix === 'verdict' || item.prefix === 'round-finish') && !finished.has(target);
          if (item.keyCommentId && item.keyCommentId !== target) ok = false;
          if (ok) finished.add(target);
        } else {
          ok = item.prbot && item.prbotCommentUpdate && item.keyCommentId === target;
        }
        if (!ok) push('round-comment-modified', { detail: `轮次评论 ${target}` });
      }
    }
  });
  return { violations, rounds };
}

/** 读账本：返回 {lines:[原始行], entries:[解析结果或 null]}。文件不存在算空账本。 */
export function readLedgerLines(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { lines: [], entries: [] };
    throw error;
  }
  const lines = text.split('\n').filter((line) => line.trim());
  const entries = lines.map((line) => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  });
  return { lines, entries };
}

/**
 * 只读查 GitHub：账本里开过的轮次评论还在不在（固定的只读评论查询，绝不写）。
 * 某个 issue 的评论超过查询窗口（100 条）且窗口没覆盖到那一轮的时间，就不下结论。
 */
export async function checkRoundComments({ rounds, entries, github }) {
  const out = [];
  const errors = [];
  if (!github || typeof github.graphql !== 'function') return { violations: out, errors, checked: 0 };
  let checked = 0;
  const byRoot = new Map();
  for (const value of rounds.values()) {
    const list = byRoot.get(value.root) || [];
    list.push(value);
    byRoot.set(value.root, list);
  }
  for (const [root, list] of byRoot) {
    const match = REF.exec(root);
    if (!match) continue;
    const [owner, name] = match[1].split('/');
    let nodes;
    try {
      const data = await github.graphql(ISSUE_COMMENTS_QUERY, { owner, name, number: Number(match[2]) });
      nodes = data?.repository?.issue?.comments?.nodes;
    } catch (error) {
      errors.push(`${root}：${str(error?.message || error).split('\n')[0].slice(0, 120)}`);
      continue;
    }
    if (!Array.isArray(nodes)) {
      errors.push(`${root}：读不到评论`);
      continue;
    }
    checked += 1;
    const ids = new Set(nodes.map((node) => str(node?.databaseId)));
    const oldest = nodes.reduce((acc, node) => {
      const at = Date.parse(node?.createdAt || '');
      return Number.isFinite(at) && at < acc ? at : acc;
    }, Infinity);
    const full = nodes.length >= 100;
    for (const value of list) {
      if (ids.has(value.commentId)) continue;
      const startedAt = Date.parse(entries[value.line - 1]?.at || '');
      if (full && !(Number.isFinite(startedAt) && startedAt >= oldest)) continue;
      out.push(
        makeFinding(value.line, 'round-comment-missing', {
          type: 'comment.create',
          key: str(entries[value.line - 1]?.dedupeKey),
          root,
          detail: `轮次评论 ${value.commentId}（${root} 第 ${value.round} 轮）`,
        }),
      );
    }
  }
  return { violations: out, errors, checked };
}

export function fingerprint(item, rawLine = '') {
  return crypto
    .createHash('sha256')
    .update(`${item.rule}\n${item.line}\n${item.detail || ''}\n${rawLine}`)
    .digest('hex')
    .slice(0, 24);
}

function prefixHash(lines, count) {
  return crypto.createHash('sha256').update(lines.slice(0, count).join('\n')).digest('hex');
}

export function auditPaths(home) {
  const paths = hostPaths(home);
  return {
    ...paths,
    auditStateFile: path.join(paths.hostDir, 'gate-audit.json'),
    auditLogFile: path.join(paths.hostDir, 'gate-audit.log'),
    auditLock: path.join(paths.locksDir, 'gate-audit.lock'),
  };
}

function readState(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && value.version === AUDIT_STATE_VERSION ? value : null;
  } catch {
    return null;
  }
}

function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 一行人话明细：「第 12 行 issue.close：只出裁决的总 issue 上出现了不许的写（example-owner/example-repo#1）」 */
export function describeViolation(item) {
  const where = [item.repo, item.root, item.detail].filter(Boolean).join('，');
  const text = item.text || RULE_TEXT[item.rule] || item.rule || '审计发现';
  return `第 ${item.line} 行${item.type ? ` ${item.type}` : ''}：${text}${where ? `（${where}）` : ''}`;
}

/** 读审计日志（一行一条 JSON）。文件不存在算空；坏行跳过。 */
function readAuditLogRows(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value);
    } catch {
      // 日志坏一行不影响别的行。
    }
  }
  return out;
}

/** 日志行的级别：新日志行自带 level；旧日志行没 level，按 rule 现算。 */
function levelOfLogRow(row) {
  if (row?.level === 'violation' || row?.level === 'uncertain' || row?.level === 'info') return row.level;
  return ruleLevel(row?.rule);
}

function countUncertain24h(file, nowMs, hours = UNCERTAIN_WINDOW_HOURS) {
  const windowMs = hours * 3600 * 1000;
  let count = 0;
  for (const row of readAuditLogRows(file)) {
    if (levelOfLogRow(row) !== 'uncertain') continue;
    const at = Date.parse(row?.ts || '');
    if (!Number.isFinite(at) || at < nowMs - windowMs || at > nowMs) continue;
    count += 1;
  }
  return count;
}

function auditStatus({ ok, newUncertain = [], uncertain24h = 0, githubErrors = [], busy = false }) {
  if (!ok) return 'violation';
  if (busy || newUncertain.length > 0 || uncertain24h > 0 || githubErrors.length > 0) return 'uncertain';
  return 'ok';
}

/**
 * 只读汇总：读审计日志和状态文件，不拿锁、不写任何文件。日志文件不存在算空。
 * 适合随时想看一眼「最近一天到底出了些啥」。
 */
export function summarizeAudit({ home, now = () => Date.now(), hours = UNCERTAIN_WINDOW_HOURS } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('summarizeAudit 需要绝对路径的 home');
  const paths = auditPaths(home);
  const nowMs = now();
  const windowHours = Number.isFinite(Number(hours)) && Number(hours) > 0 ? Number(hours) : UNCERTAIN_WINDOW_HOURS;
  const windowMs = windowHours * 3600 * 1000;
  const since = new Date(nowMs - windowMs).toISOString();
  const uncertain = [];
  const violations = [];
  for (const row of readAuditLogRows(paths.auditLogFile)) {
    const at = Date.parse(row?.ts || '');
    if (!Number.isFinite(at) || at < nowMs - windowMs || at > nowMs) continue;
    const item = { ...row, level: levelOfLogRow(row) };
    if (item.level === 'violation') violations.push(item);
    else if (item.level === 'uncertain') uncertain.push(item);
  }
  const state = readState(paths.auditStateFile);
  return {
    since,
    hours: windowHours,
    uncertain,
    violations,
    uncertainCount: uncertain.length,
    violationCount: violations.length,
    sinceBaseline: Number(state?.sinceBaseline || 0),
    uncertainSinceBaseline: Number(state?.uncertainSinceBaseline || 0),
    lastRunAt: state?.lastRunAt || null,
  };
}

function summaryLines(label, items) {
  const lines = [];
  for (const item of items.slice(0, SUMMARY_LIMIT)) lines.push(`  [${label}] ${describeViolation(item)}`);
  if (items.length > SUMMARY_LIMIT) lines.push(`  ……另有 ${items.length - SUMMARY_LIMIT} 条（${label}）`);
  return lines;
}

/** 把 summarizeAudit 的结果写成多行人话。 */
export function formatSummary(summary) {
  const data = summary && typeof summary === 'object' ? summary : {};
  const uncertain = Array.isArray(data.uncertain) ? data.uncertain : [];
  const violations = Array.isArray(data.violations) ? data.violations : [];
  const hours = data.hours ?? UNCERTAIN_WINDOW_HOURS;
  const since = data.since || '-';
  const lines = [
    `最近 ${hours} 小时（自 ${since}）：拿不准 ${data.uncertainCount ?? uncertain.length} 条，明确违规 ${
      data.violationCount ?? violations.length
    } 条；基线后未清零的明确违规 ${data.sinceBaseline ?? 0} 条`,
  ];
  lines.push(...summaryLines('拿不准', uncertain));
  lines.push(...summaryLines('违规', violations));
  return lines.join('\n');
}

/** auditEntries 自己会报的规则（能按账本重算的）；其余（GitHub 核对、账本被改写）只能沿用审计日志里的记录。 */
const LEDGER_RULES = new Set([
  'ledger-corrupt',
  'pr-merge',
  'comment-delete',
  'type-not-allowed',
  'unverifiable',
  'repo-out-of-scope',
  'tier-not-allowed',
  'no-round',
  'round-mismatch',
  'verdict-only-write',
  'round-comment-modified',
]);

/**
 * 规则升级后重算「基线后明确违规数」（不是 --ack）：
 * - 基线之后、上次审计游标之前的账本行，按现在的规则（含写入当时的范围快照）重新核对；
 * - 账本算不出来的那几类（GitHub 核对、账本被改写）照审计日志里的记录原样计入；
 * - 人 --ack 过的，只算 ack 之后的。
 * 返回 {count, unseen, before}：unseen 是重算出来、以前没报过的明确违规（交给正常流程去报）。
 */
function recheckSinceBaseline({ state, entries, lines, profile, scopes, seen, auditLogFile }) {
  const baselineLines = Number(state.baseline?.lines || 0);
  const cursor = Math.min(Number(state.cursor) || 0, entries.length);
  const ackMs = Date.parse(state.acknowledgedAt || '');
  const afterAck = (iso) => !Number.isFinite(ackMs) || Date.parse(iso || '') > ackMs;
  const { violations } = auditEntries(entries.slice(0, cursor), { profile, scopes, from: baselineLines });
  const definite = violations.filter((item) => item.level === 'violation' && afterAck(entries[item.line - 1]?.at));
  let count = 0;
  const unseen = [];
  for (const item of definite) {
    if (seen.has(fingerprint(item, lines[item.line - 1] || ''))) count += 1;
    else unseen.push(item);
  }
  const baselineMs = Date.parse(state.baseline?.at || '');
  for (const row of readAuditLogRows(auditLogFile)) {
    if (levelOfLogRow(row) !== 'violation' || LEDGER_RULES.has(row.rule)) continue;
    const at = Date.parse(row.ts || '');
    if (Number.isFinite(baselineMs) && !(at >= baselineMs)) continue;
    if (!afterAck(row.ts)) continue;
    count += 1;
  }
  return { count, unseen, before: Number(state.sinceBaseline || 0) };
}

/**
 * 跑一次审计（可单独跑、可增量）：
 * - 第一次跑（没有状态文件）：以当时账本末尾为基线，基线前的记录只统计、不报；
 * - 之后只核对基线 / 上次之后新增的行；已报过的发现（指纹）不再报；
 * - 账本已审计部分被改写或截短：报一次 ledger-rewritten（明确违规），并从头重新核对（报过的不重复）。
 * `github` 给了才做只读的轮次评论核对（doctor / 命令行用；常驻循环每拍不查 GitHub）。
 * 明确违规才写提醒；拿不准只记日志。
 * 返回 {ok, status, checkedLines, newViolations, newUncertain, sinceBaseline, uncertainSinceBaseline, uncertain24h, baseline}。
 */
export async function runGateAudit({ home, profile, github = null, now = () => Date.now(), alert = true, lockWaitMs = 5000 } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('runGateAudit 需要绝对路径的 home');
  const paths = auditPaths(home);
  fs.mkdirSync(paths.locksDir, { recursive: true, mode: 0o700 });
  const got = await acquireLock(paths.auditLock, { now, waitMs: lockWaitMs });
  if (!got) {
    return {
      ok: true,
      busy: true,
      status: 'uncertain',
      checkedLines: 0,
      newViolations: [],
      newUncertain: [],
      sinceBaseline: 0,
      uncertainSinceBaseline: 0,
      uncertain24h: 0,
      githubErrors: [],
      baseline: null,
    };
  }
  try {
    const { lines, entries } = readLedgerLines(paths.ledgerFile);
    const scopes = loadScopes(paths.gateDir);
    let state = readState(paths.auditStateFile);
    const seen = new Set(state?.seen || []);
    const nowMs = now();
    const stamp = new Date(nowMs).toISOString();

    if (!state) {
      // 基线：此刻之前的记录只统计，不报。明确违规和拿不准分开数。
      const { violations, rounds } = auditEntries(entries, { profile, scopes });
      let githubFound = [];
      let githubErrors = [];
      if (github) ({ violations: githubFound, errors: githubErrors } = await checkRoundComments({ rounds, entries, github }));
      const all = [...violations, ...githubFound];
      const definite = all.filter((item) => item.level === 'violation');
      const uncertain = all.filter((item) => item.level === 'uncertain');
      for (const item of all) seen.add(fingerprint(item, lines[item.line - 1]));
      state = {
        version: AUDIT_STATE_VERSION,
        baseline: {
          at: stamp,
          lines: lines.length,
          violations: definite.length,
          uncertain: uncertain.length,
          githubChecked: Boolean(github) && githubErrors.length === 0,
          rules: countRules(definite),
          uncertainRules: countRules(uncertain),
          sample: [...definite, ...uncertain].slice(0, AUDIT_DETAIL_LIMIT).map(describeViolation),
        },
        cursor: lines.length,
        prefixHash: prefixHash(lines, lines.length),
        rulesVersion: AUDIT_RULES_VERSION,
        sinceBaseline: 0,
        uncertainSinceBaseline: 0,
        lastRunAt: stamp,
        seen: [...seen].slice(-AUDIT_SEEN_LIMIT),
      };
      writeState(paths.auditStateFile, state);
      const uncertain24h = countUncertain24h(paths.auditLogFile, nowMs);
      return {
        ok: true,
        status: auditStatus({ ok: true, newUncertain: [], uncertain24h, githubErrors }),
        baselineCreated: true,
        checkedLines: lines.length,
        newViolations: [],
        newUncertain: [],
        sinceBaseline: 0,
        uncertainSinceBaseline: 0,
        uncertain24h,
        baseline: state.baseline,
        githubErrors,
      };
    }

    const found = [];
    let recheck = null;
    if (Number(state.rulesVersion || 1) < AUDIT_RULES_VERSION && prefixHash(lines, Number(state.cursor) || 0) === state.prefixHash) {
      // 规则升级：按新规则重算基线后的旧账（见 AUDIT_RULES_VERSION），记一条 info 日志，不发提醒。
      recheck = recheckSinceBaseline({ state, entries, lines, profile, scopes, seen, auditLogFile: paths.auditLogFile });
      found.push(...recheck.unseen);
      fs.mkdirSync(path.dirname(paths.auditLogFile), { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        paths.auditLogFile,
        `${JSON.stringify({
          ts: stamp,
          level: 'info',
          rule: 'rules-recheck',
          detail: `判定规则 v${Number(state.rulesVersion || 1)}→v${AUDIT_RULES_VERSION}，重算基线后账本：明确违规 ${recheck.before} → ${recheck.count} 条`,
          text: '规则升级后重算',
        })}\n`,
        { mode: 0o600 },
      );
      state.sinceBaseline = recheck.count;
      state.rulesVersion = AUDIT_RULES_VERSION;
      state.recheckedAt = stamp;
    }
    let from = Math.min(Number(state.cursor) || 0, lines.length);
    if (lines.length < Number(state.cursor) || prefixHash(lines, Number(state.cursor)) !== state.prefixHash) {
      found.push(
        makeFinding(Math.min(Number(state.cursor) || 0, lines.length), 'ledger-rewritten', {
          detail: `上次审计到第 ${state.cursor} 行，现在账本 ${lines.length} 行`,
        }),
      );
      from = 0;
    }
    const { violations, rounds } = auditEntries(entries, { profile, from, scopes });
    found.push(...violations);
    let githubErrors = [];
    if (github) {
      const checkedComments = await checkRoundComments({ rounds, entries, github });
      const githubFound = checkedComments.violations;
      githubErrors = checkedComments.errors;
      if (!state.baseline?.githubChecked && githubErrors.length > 0) {
        // 基线还没查过 GitHub、这次又没查全：先不下结论，下次再查。
      } else if (!state.baseline?.githubChecked) {
        // 基线建时没查过 GitHub：这次查出来的算基线前的老问题，只记不报。
        const oldDefinite = githubFound.filter((item) => item.level === 'violation');
        const oldUncertain = githubFound.filter((item) => item.level === 'uncertain');
        for (const item of githubFound) seen.add(fingerprint(item, lines[item.line - 1]));
        state.baseline = {
          ...(state.baseline || {}),
          githubChecked: true,
          violations: Number(state.baseline?.violations || 0) + oldDefinite.length,
          uncertain: Number(state.baseline?.uncertain || 0) + oldUncertain.length,
          rules: addRules(state.baseline?.rules, oldDefinite),
          uncertainRules: addRules(state.baseline?.uncertainRules, oldUncertain),
        };
      } else {
        found.push(...githubFound);
      }
    }
    const fresh = [];
    for (const item of found) {
      const print = fingerprint(item, lines[item.line - 1] || '');
      if (seen.has(print)) continue;
      seen.add(print);
      fresh.push(item);
    }
    const freshViolations = fresh.filter((item) => item.level === 'violation');
    const freshUncertain = fresh.filter((item) => item.level === 'uncertain');

    if (fresh.length > 0) {
      // 两种发现都写进审计日志；只有明确违规才再写一条提醒（由 Slack 通知发出去）。
      fs.mkdirSync(path.dirname(paths.auditLogFile), { recursive: true, mode: 0o700 });
      const text = fresh
        .map((item) =>
          JSON.stringify({
            ts: stamp,
            level: item.level,
            rule: item.rule,
            line: item.line,
            type: item.type,
            key: item.key,
            root: item.root,
            repo: item.repo,
            detail: item.detail,
            text: item.text,
          }),
        )
        .join('\n');
      fs.appendFileSync(paths.auditLogFile, `${text}\n`, { mode: 0o600 });
      if (alert && freshViolations.length > 0) {
        const roots = [...new Set(freshViolations.map((item) => item.root).filter(Boolean))];
        appendAlert(paths, {
          kind: AUDIT_ALERT_KIND,
          issue: roots.length === 1 ? roots[0] : undefined,
          reason: `写闸账本审计发现 ${freshViolations.length} 条违规`,
          detail: freshViolations.slice(0, AUDIT_DETAIL_LIMIT).map(describeViolation).join('\n'),
          count: freshViolations.length,
          rules: [...new Set(freshViolations.map((item) => item.rule))].join(','),
          now,
          profile,
        });
      }
    }

    state.cursor = lines.length;
    state.prefixHash = prefixHash(lines, lines.length);
    state.sinceBaseline = Number(state.sinceBaseline || 0) + freshViolations.length;
    state.uncertainSinceBaseline = Number(state.uncertainSinceBaseline || 0) + freshUncertain.length;
    state.lastRunAt = stamp;
    state.seen = [...seen].slice(-AUDIT_SEEN_LIMIT);
    writeState(paths.auditStateFile, state);
    const uncertain24h = countUncertain24h(paths.auditLogFile, nowMs);
    const ok = freshViolations.length === 0 && state.sinceBaseline === 0;
    return {
      ok,
      ...(recheck ? { recheck: { before: recheck.before, after: recheck.count } } : {}),
      status: auditStatus({ ok, newUncertain: freshUncertain, uncertain24h, githubErrors }),
      checkedLines: lines.length - from,
      githubErrors,
      newViolations: freshViolations,
      newUncertain: freshUncertain,
      sinceBaseline: state.sinceBaseline,
      uncertainSinceBaseline: state.uncertainSinceBaseline,
      uncertain24h,
      baseline: state.baseline,
    };
  } finally {
    releaseLock(paths.auditLock);
  }
}

function countRules(list) {
  const out = {};
  for (const item of list) out[item.rule] = (out[item.rule] || 0) + 1;
  return out;
}

function addRules(base = {}, list = []) {
  const out = { ...(base || {}) };
  for (const item of list) out[item.rule] = (out[item.rule] || 0) + 1;
  return out;
}

/** 人看过、处理完之后清零「基线后违规数」（不删日志、不删指纹，旧违规不会再报）。 */
export function acknowledgeAudit({ home, now = () => Date.now() } = {}) {
  const paths = auditPaths(home);
  const state = readState(paths.auditStateFile);
  if (!state) return null;
  state.sinceBaseline = 0;
  state.acknowledgedAt = new Date(now()).toISOString();
  writeState(paths.auditStateFile, state);
  return state;
}

function hoursArg(argv) {
  const index = argv.indexOf('--hours');
  if (index < 0) return UNCERTAIN_WINDOW_HOURS;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error('--hours 需要一个正数');
  return value;
}

function jsonLine(payload) {
  return `${JSON.stringify(payload)}\n`;
}

async function main(argv) {
  const json = argv.includes('--json');

  // --summary：只读汇总，不跑审计、不写文件、不拿锁。
  if (argv.includes('--summary')) {
    const summary = summarizeAudit({ home: watcherHome(process.env), hours: hoursArg(argv) });
    process.stdout.write(json ? jsonLine(summary) : `${formatSummary(summary)}\n`);
    process.exitCode = 0;
    return;
  }

  const home = watcherHome(process.env);
  if (argv.includes('--ack')) {
    const state = acknowledgeAudit({ home });
    process.stdout.write(state ? '已清零基线后违规数（日志和指纹保留）\n' : '还没有审计状态\n');
    process.exitCode = 0;
    return;
  }

  const profile = loadAcceptanceProfile(process.env);
  const github = argv.includes('--github') ? createGithub({ profile }) : null;
  const result = await runGateAudit({
    home,
    profile,
    github,
    alert: !argv.includes('--no-alert'),
    lockWaitMs: 30000,
  });
  const status = result.status || (result.ok ? 'ok' : 'violation');
  const exitCode = status === 'violation' ? 1 : status === 'uncertain' ? 2 : 0;
  const newViolations = (result.newViolations || []).map(describeViolation);
  const newUncertain = (result.newUncertain || []).map(describeViolation);
  const githubErrors = result.githubErrors || [];

  if (json) {
    process.stdout.write(
      jsonLine({
        status,
        exitCode,
        checkedLines: Number(result.checkedLines) || 0,
        newViolations,
        newUncertain,
        sinceBaseline: Number(result.sinceBaseline) || 0,
        uncertainSinceBaseline: Number(result.uncertainSinceBaseline) || 0,
        uncertain24h: Number(result.uncertain24h) || 0,
        githubChecked: Boolean(github) && githubErrors.length === 0,
        githubErrors,
        busy: Boolean(result.busy),
        baselineCreated: Boolean(result.baselineCreated),
      }),
    );
  } else {
    const lines = [];
    if (result.busy) lines.push('另一处审计正在跑，这次跳过');
    if (result.baselineCreated) {
      lines.push(
        `建了基线：基线前 ${result.baseline.lines} 条记录，其中明确违规 ${result.baseline.violations} 条、拿不准 ${Number(
          result.baseline.uncertain,
        ) || 0} 条`,
      );
    }
    lines.push(
      `这次核对 ${result.checkedLines} 行，新发现违规 ${newViolations.length} 条，基线后累计 ${Number(result.sinceBaseline) || 0} 条`,
    );
    lines.push(
      `拿不准 新 ${newUncertain.length} 条（只记日志，不发提醒），最近 24 小时 ${Number(result.uncertain24h) || 0} 条`,
    );
    for (const line of newViolations) lines.push(`  ${line}`);
    for (const line of newUncertain) lines.push(`  [拿不准] ${line}`);
    for (const error of githubErrors) lines.push(`  GitHub 只读核对没做成：${error}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  process.exitCode = exitCode;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // 只打一行错误；环境变量和整段没必要的上下文都不往外抄。
    const line = String(error?.message || error)
      .split('\n')[0]
      .slice(0, 300);
    process.stderr.write(`写闸账本审计失败：${line}\n`);
    process.exitCode = 3;
  }
}
