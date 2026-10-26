#!/usr/bin/env node
// 写闸账本旁路审计：只读 <home>/state/write-gate/ledger.jsonl，逐条核对每条已执行的写入是否在写闸规则内。
// 不碰写闸本身：不改账本、不开关写闸、不写 GitHub。发现违规只做两件事：明细记进审计日志，
// 再写一条 gate-audit-violation 提醒（由 slack-notify 发四段式通知）。同一条违规只报一次。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_ACTION_WRITE_TYPES, WRITE_TYPES, createGithub } from '../bin/github.mjs';
import { isVerdictOnly, loadAcceptanceProfile, watcherHome } from '../bin/profile.mjs';
import { ISSUE_COMMENTS_QUERY } from '../bin/rounds.mjs';
import { repoTier } from '../bin/tasks.mjs';
import { acquireLock, appendAlert, hostPaths, releaseLock } from './paths.mjs';

export const AUDIT_ALERT_KIND = 'gate-audit-violation';
export const AUDIT_STATE_VERSION = 1;
/** 去重指纹最多留这么多条（账本一天一两百条，够用很久）。 */
export const AUDIT_SEEN_LIMIT = 5000;
/** 一条提醒里最多带几条明细（其余在审计日志里）。 */
export const AUDIT_DETAIL_LIMIT = 5;

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

function violation(line, rule, parsed, extra = {}) {
  return {
    line,
    rule,
    type: parsed?.type || '',
    key: parsed?.key || '',
    root: parsed?.root || null,
    text: RULE_TEXT[rule] || rule,
    ...extra,
  };
}

/**
 * 纯函数：核对整本账（entries 是按行解析好的记录；读不出的行传 null）。
 * 返回 {violations, rounds}：violations 带行号（从 1 起）；rounds 是账本里登记过的轮次（评论 id → 轮次）。
 * `from` = 只核对行号 > from 的记录（上下文仍按整本账算：轮次、改评论顺序都要看前面的）。
 */
export function auditEntries(entries, { profile, from = 0 } = {}) {
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
    if (item.type === 'pr.merge') push('pr-merge');
    else if (item.type === 'comment.delete') push('comment-delete');
    else if (!ALLOWED_WRITE_TYPES.has(item.type)) push('type-not-allowed');

    if (!item.known) {
      push('unverifiable');
      return;
    }

    // 2. 仓范围（以写闸的 repoTier 为准）和分档
    for (const repo of item.repos) {
      const tier = repoTier(repo, profile || {});
      if (!tier) push('repo-out-of-scope', { repo });
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
    if (root && isVerdictOnly(profile || {}, root) && VERDICT_ONLY_SET.has(item.type)) push('verdict-only-write');

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
      out.push({
        line: value.line,
        rule: 'round-comment-missing',
        type: 'comment.create',
        key: str(entries[value.line - 1]?.dedupeKey),
        root,
        text: RULE_TEXT['round-comment-missing'],
        detail: `轮次评论 ${value.commentId}（${root} 第 ${value.round} 轮）`,
      });
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
  return `第 ${item.line} 行${item.type ? ` ${item.type}` : ''}：${item.text}${where ? `（${where}）` : ''}`;
}

/**
 * 跑一次审计（可单独跑、可增量）：
 * - 第一次跑（没有状态文件）：以当时账本末尾为基线，基线前的记录只统计、不报；
 * - 之后只核对基线 / 上次之后新增的行；已报过的违规（指纹）不再报；
 * - 账本已审计部分被改写或截短：报一次 ledger-rewritten，并从头重新核对（已报过的不重复）。
 * `github` 给了才做只读的轮次评论核对（doctor / 命令行用；常驻循环每拍不查 GitHub）。
 * 返回 {ok, checkedLines, newViolations, sinceBaseline, baseline}。
 */
export async function runGateAudit({ home, profile, github = null, now = () => Date.now(), alert = true, lockWaitMs = 5000 } = {}) {
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('runGateAudit 需要绝对路径的 home');
  const paths = auditPaths(home);
  fs.mkdirSync(paths.locksDir, { recursive: true, mode: 0o700 });
  const got = await acquireLock(paths.auditLock, { now, waitMs: lockWaitMs });
  if (!got) return { ok: true, busy: true, checkedLines: 0, newViolations: [], sinceBaseline: 0, baseline: null };
  try {
    const { lines, entries } = readLedgerLines(paths.ledgerFile);
    let state = readState(paths.auditStateFile);
    const seen = new Set(state?.seen || []);
    const stamp = new Date(now()).toISOString();

    if (!state) {
      // 基线：此刻之前的记录只统计，不报。
      const { violations, rounds } = auditEntries(entries, { profile });
      let githubFound = [];
      let githubErrors = [];
      if (github) ({ violations: githubFound, errors: githubErrors } = await checkRoundComments({ rounds, entries, github }));
      const all = [...violations, ...githubFound];
      for (const item of all) seen.add(fingerprint(item, lines[item.line - 1]));
      state = {
        version: AUDIT_STATE_VERSION,
        baseline: {
          at: stamp,
          lines: lines.length,
          violations: all.length,
          githubChecked: Boolean(github) && githubErrors.length === 0,
          rules: countRules(all),
          sample: all.slice(0, AUDIT_DETAIL_LIMIT).map(describeViolation),
        },
        cursor: lines.length,
        prefixHash: prefixHash(lines, lines.length),
        sinceBaseline: 0,
        lastRunAt: stamp,
        seen: [...seen].slice(-AUDIT_SEEN_LIMIT),
      };
      writeState(paths.auditStateFile, state);
      return {
        ok: githubErrors.length === 0,
        baselineCreated: true,
        checkedLines: lines.length,
        newViolations: [],
        sinceBaseline: 0,
        baseline: state.baseline,
        githubErrors,
      };
    }

    const found = [];
    let from = Math.min(Number(state.cursor) || 0, lines.length);
    if (lines.length < Number(state.cursor) || prefixHash(lines, Number(state.cursor)) !== state.prefixHash) {
      found.push({
        line: Math.min(Number(state.cursor) || 0, lines.length),
        rule: 'ledger-rewritten',
        type: '',
        key: '',
        root: null,
        text: RULE_TEXT['ledger-rewritten'],
        detail: `上次审计到第 ${state.cursor} 行，现在账本 ${lines.length} 行`,
      });
      from = 0;
    }
    const { violations, rounds } = auditEntries(entries, { profile, from });
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
        for (const item of githubFound) seen.add(fingerprint(item, lines[item.line - 1]));
        state.baseline = {
          ...(state.baseline || {}),
          githubChecked: true,
          violations: Number(state.baseline?.violations || 0) + githubFound.length,
          rules: { ...(state.baseline?.rules || {}), ...addRules(state.baseline?.rules, githubFound) },
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

    if (fresh.length > 0) {
      // 先把明细写进审计日志，再写一条提醒（由 Slack 通知发出去）。
      fs.mkdirSync(path.dirname(paths.auditLogFile), { recursive: true, mode: 0o700 });
      const text = fresh
        .map((item) => JSON.stringify({ ts: stamp, rule: item.rule, line: item.line, type: item.type, key: item.key, root: item.root, repo: item.repo, detail: item.detail, text: item.text }))
        .join('\n');
      fs.appendFileSync(paths.auditLogFile, `${text}\n`, { mode: 0o600 });
      if (alert) {
        const roots = [...new Set(fresh.map((item) => item.root).filter(Boolean))];
        appendAlert(paths, {
          kind: AUDIT_ALERT_KIND,
          issue: roots.length === 1 ? roots[0] : undefined,
          reason: `写闸账本审计发现 ${fresh.length} 条违规`,
          detail: fresh.slice(0, AUDIT_DETAIL_LIMIT).map(describeViolation).join('\n'),
          count: fresh.length,
          rules: [...new Set(fresh.map((item) => item.rule))].join(','),
          now,
          profile,
        });
      }
    }

    state.cursor = lines.length;
    state.prefixHash = prefixHash(lines, lines.length);
    state.sinceBaseline = Number(state.sinceBaseline || 0) + fresh.length;
    state.lastRunAt = stamp;
    state.seen = [...seen].slice(-AUDIT_SEEN_LIMIT);
    writeState(paths.auditStateFile, state);
    return {
      ok: fresh.length === 0 && state.sinceBaseline === 0 && githubErrors.length === 0,
      checkedLines: lines.length - from,
      githubErrors,
      newViolations: fresh,
      sinceBaseline: state.sinceBaseline,
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

async function main(argv) {
  const home = watcherHome(process.env);
  if (argv.includes('--ack')) {
    const state = acknowledgeAudit({ home });
    process.stdout.write(state ? '已清零基线后违规数（日志和指纹保留）\n' : '还没有审计状态\n');
    return;
  }
  const profile = loadAcceptanceProfile(process.env);
  let github = null;
  if (argv.includes('--github')) {
    github = createGithub({ profile });
  }
  const result = await runGateAudit({ home, profile, github, alert: !argv.includes('--no-alert') });
  const lines = [];
  if (result.baselineCreated) lines.push(`建了基线：基线前 ${result.baseline.lines} 条记录，其中疑似违规 ${result.baseline.violations} 条`);
  lines.push(`这次核对 ${result.checkedLines} 行，新发现违规 ${result.newViolations.length} 条，基线后累计 ${result.sinceBaseline} 条`);
  for (const item of result.newViolations) lines.push(`  ${describeViolation(item)}`);
  for (const error of result.githubErrors || []) lines.push(`  GitHub 只读核对没做成：${error}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
