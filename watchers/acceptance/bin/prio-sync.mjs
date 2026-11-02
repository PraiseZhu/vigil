#!/usr/bin/env node
// 看板优先级写回（#157，规则以 #62 为准）。默认 dry-run：只打印将要改的字段，不调用写闸。
// 真写要显式 --write。目录里有 disabled 文件时，哪种模式都不写。
// 「优先级」和「关联 PR」只在当前值为空，或 changes.jsonl 里该字段最后一条新值等于看板当前值时才写；否则提醒一次。
// 算不出关联（空串）时，不清空看板上已有的「关联 PR」。
// 「关联 PR」真写前必须已有 mac-mini-stopped（人确认 Mac mini 停写后自建，本文件不创建）。
// 检查还在跑（PENDING）时，关联 PR 文本沿用 debounce.json 的 prCi 里该 PR 上一拍的 ✓/✗，最多 CI_CARRY_TICKS 拍。
// 这份标注只在 --write 且内容真变化时改；干跑整段原样保留，所以干跑日志里文本仍会在没有存档时跳。
// 依据只写进 changes.jsonl，不新增看板字段。60 天没动静只提醒「还要不要」，不关 issue。
// repo-class.json 的 exclude 数组命中的仓：不打分、不写优先级和关联 PR、不提醒、不搜 PR、不还原。
// 汇总只在有排除时追加「，排除 N 条」，N 是条数，不写仓名。stderr 不记跳过，只在 exclude 不是数组时警告一次。
// 读看板条目和 PR 走 profile 的 githubTokenFile（验收机读取通道），不用 project 写令牌。
// 写「优先级」「关联 PR」的令牌只从 ~/acceptance/secrets/gh-priority-writer-token 读，
// 不读环境变量，不写进日志和错误信息。缺写令牌只在真写时报错。
// 真写时，报错原文含 Could not resolve to a Repository 且含本条仓名：本拍跳过该仓（同仓后面的条目不再试），
// 汇总和运行日志写明仓名、条数和原因（原因先脱敏）。不写入状态文件，下一拍再试。其它写失败仍整拍中止。--restore 不走这条。
// content 为 null 大于 0 时，汇总在「排除」之后再追加「，读不到内容 N 条」。运行日志另写跳过计数和告警。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithub, isReadOnlyGraphql, PRIO_BOARD_FIELDS } from './github.mjs';
import { redact } from './redact.mjs';
import { checkSecretFile, loadAcceptanceProfile } from './profile.mjs';
import { applyDebounce, PIN_LABEL, RULES, scorePriority } from './prio-score.mjs';
import { linkedPrField, prIssueRefs } from './pr-link.mjs';

const RANK = new Map([
  ['P0', 0],
  ['P1', 1],
  ['P2', 2],
  ['P3', 3],
]);
const EMPTY = '（空）';
/** 最近一次事件早于这个间隔，只提醒「还要不要」，不写看板、不关 issue。 */
export const STALE_REMIND_MS = 60 * 24 * 60 * 60 * 1000;
const LINK_BASIS = 'link 关联 PR 文本与看板不一致';
/** 检查连续 PENDING 时，关联 PR 文本最多沿用上一拍 ✓/✗ 的拍数。调用 runPrioSync 可改。 */
export const CI_CARRY_TICKS = 6;
const RESTORE_BASIS = 'restore 按变更日志改回';
const LINK_HOLD = '不写关联 PR：没有 .prio/mac-mini-stopped，要等确认 Mac mini 已停写\n';
const RESTORE_SKIP = '跳过：当前值不是上次写入的值';

/** 默认分类表是空的。真实仓名放在配置文件里，不写进源码。exclude 命中的仓整仓跳过。 */
export const DEFAULT_REPO_CLASS_TABLE = Object.freeze({
  mivo: Object.freeze([]),
  idle: Object.freeze([]),
  'daily-tool': Object.freeze([]),
  exclude: Object.freeze([]),
});

export const BOARD_ITEMS_QUERY = `query ($login: String!, $projectNumber: Int!, $after: String) {
  user(login: $login) {
    projectV2(number: $projectNumber) {
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isArchived
          updatedAt
          content {
            __typename
            ... on Issue {
              number
              state
              updatedAt
              repository { nameWithOwner }
              labels(first: 50) { nodes { name } }
            }
          }
          fieldValues(first: 30) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}`;

export const PR_SEARCH_QUERY = `query ($query: String!, $after: String) {
  search(query: $query, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        body
        state
        merged
        headRefName
        repository { nameWithOwner }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}`;

export function priorityTokenPath(homeDir = os.homedir()) {
  return path.join(homeDir, 'acceptance', 'secrets', 'gh-priority-writer-token');
}

/** 状态目录。不传 home 时用当前用户主目录，不写死主机名。 */
export function defaultStateDir(homeDir = os.homedir()) {
  return path.join(homeDir, 'acceptance', 'tools', '.prio');
}

/** disabled、变更、提醒、延迟、停写标记都在这个目录里。latency.jsonl 只占位，这里不写。 */
export function stateFiles(dir = defaultStateDir()) {
  return {
    dir,
    disabled: path.join(dir, 'disabled'),
    changes: path.join(dir, 'changes.jsonl'),
    reminded: path.join(dir, 'reminded.jsonl'),
    latency: path.join(dir, 'latency.jsonl'),
    marker: path.join(dir, 'mac-mini-stopped'),
    debounce: path.join(dir, 'debounce.json'),
  };
}

/** 只读这个文件。错误信息只说原因，不带文件内容。 */
export function readPriorityWriterToken(file) {
  checkSecretFile(file, 'gh-priority-writer-token');
  let token = '';
  try {
    token = fs.readFileSync(file, 'utf8').trim();
  } catch {
    throw new Error('读不到优先级写令牌');
  }
  if (!token) throw new Error('优先级写令牌文件是空的');
  return token;
}

export function assertPrioFields(fields) {
  const names = fields && typeof fields === 'object' && !Array.isArray(fields) ? Object.keys(fields) : [];
  const bad = names.find((name) => !PRIO_BOARD_FIELDS.has(name));
  if (names.length === 0 || bad) {
    throw new Error(`拒绝写入看板字段「${bad || '(空)'}」`);
  }
}

/** 去掉 writeCommand：验收轮写闸用的是另一枚令牌，而且 exec 只放行「验收=验收中」。 */
export function createPriorityGithub({ profile, token, run, fetchImpl }) {
  if (!profile) throw new Error('createPriorityGithub 需要 profile');
  if (typeof token !== 'string' || !token) throw new Error('缺少优先级写令牌');
  const rest = { ...profile };
  delete rest.writeCommand;
  return createGithub({ profile: rest, ownerToken: token, run, fetchImpl });
}

/** 读通道只收恰好一个只读操作。判定与 isReadOnlyGraphql 同一实现。 */
function assertReadChannelQuery(query) {
  if (!isReadOnlyGraphql(query)) throw new Error('读通道只做只读查询');
}

/**
 * 读看板和 PR。不传 ownerToken，createGithub 才走 githubTokenFile。
 * writeCommand 留着，但返回值只有 ownerGraphql，读令牌到不了 write()。
 */
export function createReadGithub({ profile, run, fetchImpl } = {}) {
  if (!profile) throw new Error('createReadGithub 需要 profile');
  const github = createGithub({ profile, run, fetchImpl });
  return {
    async ownerGraphql(query, variables) {
      assertReadChannelQuery(query);
      return github.ownerGraphql(query, variables);
    },
  };
}

export function parsePrioArgs(argv) {
  const out = { write: false, restore: null, stateDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      out.write = true;
      continue;
    }
    if (arg === '--restore') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('缺少 --restore 的时间');
      if (Number.isNaN(Date.parse(value))) throw new Error(`无法识别的时间：${value}`);
      out.restore = value;
      i += 1;
      continue;
    }
    if (arg === '--state-dir') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('缺少 --state-dir 的路径');
      out.stateDir = value;
      i += 1;
      continue;
    }
    throw new Error(`无法识别的参数：${arg}`);
  }
  return out;
}

function rankOf(priority) {
  return priority == null ? RANK.size : RANK.get(priority);
}

function show(value) {
  if (value == null || value === '') return EMPTY;
  return String(value);
}

function sameValue(left, right) {
  const a = left == null || left === '' ? null : left;
  const b = right == null || right === '' ? null : right;
  return a === b;
}

function refOf(item) {
  return `${item.repo}#${item.number}`;
}

function changesFile(dir) {
  return stateFiles(dir).changes;
}

function stateFile(dir) {
  return stateFiles(dir).debounce;
}

function disabledFile(dir) {
  return stateFiles(dir).disabled;
}

function loadDebounceState(dir) {
  const file = stateFile(dir);
  if (!fs.existsSync(file)) return { items: {}, prCiPresent: false, prCi: undefined };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('防抖状态不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('防抖状态不是合法 JSON');
  const items = parsed.items;
  if (items != null && (typeof items !== 'object' || Array.isArray(items))) throw new Error('防抖状态不是合法 JSON');
  const prCiPresent = Object.prototype.hasOwnProperty.call(parsed, 'prCi');
  return { items: items ?? {}, prCiPresent, prCi: prCiPresent ? parsed.prCi : undefined };
}

function saveDebounce(dir, items, prCi) {
  const body = { items };
  if (prCi !== undefined) body.prCi = prCi;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(dir), `${JSON.stringify(body)}\n`);
}

function appendChange(dir, row) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(changesFile(dir), `${JSON.stringify(row)}\n`);
}

function readJsonLines(file, label) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${label}不是合法 JSON`);
    }
  }
  return rows;
}

function readChanges(dir) {
  const file = changesFile(dir);
  if (!fs.existsSync(file)) throw new Error('没有变更日志');
  return readJsonLines(file, '变更日志');
}

function remindedFile(dir) {
  return stateFiles(dir).reminded;
}

function macMiniStopped(dir) {
  // 只由人在确认 Mac mini 停写之后创建。这里只看它在不在，不创建。
  return fs.existsSync(stateFiles(dir).marker);
}

/** 打分结果若自带 basis（W1 修订）就用它，否则用规则编号和规则说明。 */
export function basisFor(scored) {
  if (typeof scored?.basis === 'string' && scored.basis.trim()) return scored.basis.trim();
  const found = RULES.find((rule) => rule.id === scored?.rule);
  if (!found) return scored?.rule ? String(scored.rule) : '';
  return `${found.id} ${found.when}`;
}

function reminderKey(row) {
  if (row.kind === 'stale') return `stale\0${row.item}`;
  return `manual\0${row.item}\0${row.field || '优先级'}\0${row.target ?? ''}`;
}

function loadReminderKeys(dir) {
  const keys = new Set();
  for (const row of readJsonLines(remindedFile(dir), '提醒记录')) keys.add(reminderKey(row));
  return keys;
}

function remindOnce(dir, keys, stdout, now, row) {
  const key = reminderKey(row);
  if (keys.has(key)) return;
  keys.add(key);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(remindedFile(dir), `${JSON.stringify({ at: new Date(now).toISOString(), ...row })}\n`);
  if (row.kind === 'stale') outWrite(stdout, `${row.item} ${row.text}\n`);
  else outWrite(stdout, `${row.item} ${row.field || '优先级'} ${row.text}\n`);
}

function lastPriorityWrite(rows, itemRef) {
  let last = null;
  for (const row of rows) {
    if (row?.item === itemRef && row?.field === '优先级') last = row;
  }
  return last;
}

/** 当前优先级为空，或最后一条「优先级」记录的新值就是看板上的值，才允许改。 */
function priorityWritable(rows, itemRef, boardPriority) {
  if (boardPriority == null || boardPriority === '') return true;
  const last = lastPriorityWrite(rows, itemRef);
  return Boolean(last) && sameValue(last.new, boardPriority);
}

function valuesOf(node) {
  const out = new Map();
  for (const value of node?.fieldValues?.nodes || []) {
    const name = value?.field?.name;
    if (!name) continue;
    if (typeof value.name === 'string') out.set(name, value.name);
    else if (typeof value.text === 'string') out.set(name, value.text);
  }
  return out;
}

function listOf(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function emptyClassTable() {
  return {
    mivo: [...DEFAULT_REPO_CLASS_TABLE.mivo],
    idle: [...DEFAULT_REPO_CLASS_TABLE.idle],
    'daily-tool': [...DEFAULT_REPO_CLASS_TABLE['daily-tool']],
    exclude: [...DEFAULT_REPO_CLASS_TABLE.exclude],
  };
}

/** 只留字符串。不是数组时返回 null，调用方整键忽略并记一条警告。 */
function excludeNames(value) {
  if (!Array.isArray(value)) return null;
  return value.filter((entry) => typeof entry === 'string');
}

export function readRepoClassTable(file) {
  if (!file || !fs.existsSync(file)) return emptyClassTable();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('仓分类表不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('仓分类表不是合法 JSON');
  let exclude = [];
  if (Object.prototype.hasOwnProperty.call(parsed, 'exclude')) {
    const names = excludeNames(parsed.exclude);
    if (names) exclude = names;
    else {
      process.stderr.write('仓分类表的 exclude 不是数组，已忽略\n');
      exclude = [];
    }
  }
  return {
    mivo: listOf(parsed.mivo),
    idle: listOf(parsed.idle),
    'daily-tool': listOf(parsed['daily-tool'] || parsed.dailyTool),
    exclude,
  };
}

/**
 * 先看 exclude（只比较字符串；大小写与下面三档一样，折成小写再比）。
 * 表里点名的用该档；没点名的按 daily-tool（待 Praise 确认），并记「不在分类表里」。
 */
export function classifyRepo(repo, table = DEFAULT_REPO_CLASS_TABLE) {
  const key = String(repo || '').toLowerCase();
  const has = (names) => (names || []).some((entry) => String(entry).toLowerCase() === key);
  const excluded = (table?.exclude || []).some((entry) => typeof entry === 'string' && entry.toLowerCase() === key);
  if (excluded) return { repoClass: 'exclude', unlisted: false };
  if (has(table.mivo)) return { repoClass: 'mivo', unlisted: false };
  if (has(table.idle)) return { repoClass: 'idle', unlisted: false };
  if (has(table['daily-tool'])) return { repoClass: 'daily-tool', unlisted: false };
  return { repoClass: 'daily-tool', unlisted: true };
}

function isExcludedRepo(repo, table) {
  return classifyRepo(repo, table || DEFAULT_REPO_CLASS_TABLE).repoClass === 'exclude';
}

function itemIsExcluded(item, table) {
  if (!item?.repo || !Number.isInteger(item.number) || item.number <= 0) return false;
  return item.repoClass === 'exclude' || isExcludedRepo(item.repo, table);
}

function excludedSuffix(count) {
  return count > 0 ? `，排除 ${count} 条` : '';
}

function nullContentSuffix(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n <= 0) return '';
  return `，读不到内容 ${n} 条`;
}

function repoOfRef(ref) {
  const item = String(ref || '');
  const hash = item.lastIndexOf('#');
  return hash > 0 ? item.slice(0, hash) : '';
}

function repoOfChange(row) {
  if (typeof row?.repo === 'string' && row.repo) return row.repo;
  return repoOfRef(row?.item);
}

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function skipReason(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return 'invalid';
  if (node.isArchived) return 'archived';
  const content = node.content;
  if (content == null) return 'nullContent';
  if (content.__typename !== 'Issue') return 'notIssue';
  const repo = content.repository?.nameWithOwner;
  const number = Number(content.number);
  if (typeof repo !== 'string' || !repo || !Number.isInteger(number) || number <= 0) return 'invalid';
  return null;
}

function mappedItem(node, table) {
  const content = node.content;
  const repo = content.repository.nameWithOwner;
  const number = Number(content.number);
  const fields = valuesOf(node);
  const labels = (content.labels?.nodes || [])
    .map((label) => label?.name)
    .filter((name) => typeof name === 'string' && name);
  const priority = fields.get('优先级');
  const stateRaw = String(content.state || '').toUpperCase();
  const issueState = stateRaw === 'OPEN' ? 'open' : stateRaw === 'CLOSED' ? 'closed' : null;
  const times = [timeMs(node.updatedAt), timeMs(content.updatedAt)].filter((value) => value != null);
  const lastEventAt = times.length ? Math.max(...times) : null;
  const classified = classifyRepo(repo, table);
  return {
    id: node.id,
    repo,
    number,
    labels,
    priority: priority || null,
    linkedPr: fields.get('关联 PR') ?? '',
    status: fields.get('状态') || fields.get('Status') || null,
    acceptance: fields.get('验收') || null,
    situationTier: null,
    situationKnown: false,
    issueState,
    issueStateKnown: issueState != null,
    lastEventAt,
    lastEventKnown: lastEventAt != null,
    repoClass: classified.repoClass,
    repoUnlisted: classified.unlisted,
  };
}

export function mapItem(node, table = DEFAULT_REPO_CLASS_TABLE) {
  if (skipReason(node)) return null;
  return mappedItem(node, table);
}

function rollupState(node) {
  return String(node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state || '').toUpperCase();
}

function ciOf(node) {
  const value = rollupState(node);
  if (value === 'SUCCESS') return 'pass';
  if (value === 'FAILURE' || value === 'ERROR') return 'fail';
  return '';
}

function mapPr(node) {
  const repo = node?.repository?.nameWithOwner;
  const number = Number(node?.number);
  if (!repo || !Number.isInteger(number) || number <= 0) return null;
  const pr = {
    repo,
    number,
    title: node.title || '',
    body: node.body || '',
    state: String(node.state || '').toLowerCase(),
    merged: node.merged === true,
    headRefName: node.headRefName || '',
  };
  const ci = ciOf(node);
  if (ci) pr.ci = ci;
  else if (rollupState(node) === 'PENDING') pr.ciPending = true;
  return pr;
}

function prRefOf(pr) {
  const repo = String(pr?.repo || pr?.repository?.nameWithOwner || '').trim();
  const number = Number(pr?.number);
  if (!repo.includes('/') || !Number.isInteger(number) || number <= 0) return '';
  return `${repo}#${number}`;
}

function prIsClosed(pr) {
  if (pr?.merged === true) return true;
  const state = String(pr?.state || '').toLowerCase();
  return state === 'merged' || state === 'closed' || state === 'close';
}

function observedCi(pr) {
  const rolled = rollupState(pr);
  if (rolled === 'SUCCESS') return { kind: 'terminal', mark: 'pass' };
  if (rolled === 'FAILURE' || rolled === 'ERROR') return { kind: 'terminal', mark: 'fail' };
  if (rolled === 'PENDING' || pr?.ciPending === true) return { kind: 'pending' };
  const ci = String(pr?.ci || '').toLowerCase();
  if (['pass', 'passed', 'success', 'green', 'ok'].includes(ci)) return { kind: 'terminal', mark: 'pass' };
  if (['fail', 'failed', 'failure', 'red', 'error'].includes(ci)) return { kind: 'terminal', mark: 'fail' };
  return { kind: 'none' };
}

function withMark(pr, mark) {
  if (mark === 'pass' || mark === 'fail') return pr.ci === mark ? pr : { ...pr, ci: mark };
  if (pr.ci == null || pr.ci === '') return pr;
  const copy = { ...pr };
  delete copy.ci;
  return copy;
}

function labelEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.mark !== 'pass' && value.mark !== 'fail') return null;
  const pending = Number.isInteger(value.pending) && value.pending > 0 ? value.pending : 0;
  return { mark: value.mark, pending };
}

/**
 * 关联 PR 文本用的 PR 副本，以及这一拍若落盘时的 prCi。
 * 不改调用方传入的 pr / prCi。打分仍看原来的 ci，不把沿用的标注算进优先级。
 * 终态照实记。PENDING 且已有标注、沿用未满 limit 拍时文本仍用上一拍，计数加一。
 * 再下一拍文本退回不带 ✓/✗。合并或关闭的 PR 从 prCi 去掉。
 */
function carryLinkedPrCi(prs, stored, limit) {
  const prev = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const next = { ...prev };
  let changed = false;
  const seen = new Set();
  const adjusted = [];
  for (const pr of prs) {
    const key = prRefOf(pr);
    if (!key) {
      adjusted.push(pr);
      continue;
    }
    const first = !seen.has(key);
    if (first) seen.add(key);
    if (prIsClosed(pr)) {
      if (first && Object.prototype.hasOwnProperty.call(next, key)) {
        delete next[key];
        changed = true;
      }
      adjusted.push(pr);
      continue;
    }
    const observed = observedCi(pr);
    const entry = labelEntry(prev[key]);
    if (observed.kind === 'terminal') {
      if (!(entry && entry.mark === observed.mark && entry.pending === 0)) {
        if (first) {
          next[key] = { mark: observed.mark, pending: 0 };
          changed = true;
        }
      }
      adjusted.push(withMark(pr, observed.mark));
      continue;
    }
    if (observed.kind === 'pending' && entry && entry.pending < limit) {
      adjusted.push(withMark(pr, entry.mark));
      if (first) {
        next[key] = { mark: entry.mark, pending: entry.pending + 1 };
        changed = true;
      }
      continue;
    }
    if (observed.kind === 'pending') {
      adjusted.push(withMark(pr, ''));
      continue;
    }
    adjusted.push(pr);
  }
  return { prs: adjusted, prCi: next, changed };
}

export async function loadBoardItems(github, profile, table = DEFAULT_REPO_CLASS_TABLE) {
  const items = [];
  const skipped = { archived: 0, notIssue: 0, nullContent: 0, invalid: 0 };
  let excludedCount = 0;
  let after = null;
  do {
    const data = await github.ownerGraphql(BOARD_ITEMS_QUERY, {
      login: profile.ownerLogin,
      projectNumber: Number(profile.projectNumber),
      after,
    });
    const conn = data?.user?.projectV2?.items;
    if (!conn) throw new Error(`找不到看板 #${profile.projectNumber}`);
    for (const node of conn.nodes || []) {
      const reason = skipReason(node);
      if (reason) {
        skipped[reason] += 1;
        continue;
      }
      const mapped = mapItem(node, table);
      if (itemIsExcluded(mapped, table)) {
        excludedCount += 1;
        continue;
      }
      items.push(mapped);
    }
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return { items, skipped, excludedCount };
}

export async function loadPullRequests(github, repos, table = DEFAULT_REPO_CLASS_TABLE) {
  const prs = [];
  const seen = new Set();
  for (const repo of repos || []) {
    const name = String(repo || '');
    if (!name.includes('/') || seen.has(name)) continue;
    if (isExcludedRepo(name, table)) continue;
    seen.add(name);
    let after = null;
    do {
      const data = await github.ownerGraphql(PR_SEARCH_QUERY, {
        query: `is:pr repo:${name}`,
        after,
      });
      const conn = data?.search;
      if (!conn) break;
      for (const node of conn.nodes || []) {
        const mapped = mapPr(node);
        if (mapped) prs.push(mapped);
      }
      after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
    } while (after);
  }
  return prs;
}

function prsFor(item, prs) {
  const key = refOf(item).toLowerCase();
  return prs.filter((pr) => prIssueRefs(pr).some((hit) => String(hit).toLowerCase() === key));
}

function isCiRed(pr) {
  if (pr?.merged === true) return false;
  const state = String(pr?.state || '').toLowerCase();
  if (state === 'closed' || state === 'merged') return false;
  const ci = String(pr?.ci || '').toLowerCase();
  return ['fail', 'failed', 'failure', 'red', 'error'].includes(ci);
}

/** 交给 W1。缺字段不填成「故意的空」，由 annotateScore 在依据里写「缺信息」。 */
export function factsForScore(item, related = []) {
  return {
    labels: Array.isArray(item.labels) ? item.labels : [],
    priority: item.priority ?? null,
    status: item.status ?? null,
    acceptance: item.acceptance ?? null,
    heartbeatTimeout: item.heartbeatTimeout === true,
    hostFrozen: item.hostFrozen === true,
    writeGateError: item.writeGateError === true,
    progressUpdatedAt: item.progressUpdatedAt ?? null,
    roundOverLimit: item.roundOverLimit === true,
    prCiRed: item.prCiRed === true || related.some(isCiRed),
    prChangesRequested: item.prChangesRequested === true,
    hasPr: item.hasPr === true || related.length > 0,
    fixRequestedAt: item.fixRequestedAt ?? null,
    lastEventAt: item.lastEventKnown === false ? null : item.lastEventAt ?? null,
    situationTier: item.situationKnown === false ? null : item.situationTier ?? null,
    repoClass: item.repoClass ?? null,
    issueState: item.issueState ?? null,
    lowConfidence: item.lowConfidence === true,
  };
}

function annotateScore(item, scored) {
  const notes = [];
  if (item.situationKnown === false) notes.push('情形档缺信息');
  if (item.issueStateKnown === false) notes.push('issue 开关缺信息');
  if (item.lastEventKnown === false) notes.push('最近事件缺信息');
  if (item.repoUnlisted) notes.push(`仓 ${item.repo} 不在分类表里，按 daily-tool`);
  if (!notes.length) return scored;
  const extra = notes.join('；');
  if (scored?.pinned === true || scored?.rule === 'clear' || scored?.rule === 'pin') {
    return { ...scored, basis: `${scored.basis}；${extra}` };
  }
  if (item.situationKnown === false && scored?.rule === 'fallback') {
    return {
      ...scored,
      priority: 'P2',
      lowConfidence: true,
      basis: `${extra}，低置信记 P2`,
    };
  }
  return { ...scored, basis: `${scored.basis}；${extra}` };
}

function inputState(saved, boardPriority) {
  return {
    priority: boardPriority ?? null,
    pending: saved?.pending ?? null,
    pendingHeld: saved?.pendingHeld === true,
    lastRecalcAt: Number.isFinite(saved?.lastRecalcAt) ? saved.lastRecalcAt : null,
    consecutive: Number.isInteger(saved?.consecutive) ? saved.consecutive : 0,
    changes: Array.isArray(saved?.changes) ? saved.changes : [],
  };
}

function holdUnwritten(input, decision, nowMs) {
  const changes = Array.isArray(input.changes) ? input.changes : [];
  const upgrading = rankOf(decision.priority) < rankOf(input.priority ?? null);
  if (upgrading) {
    return {
      priority: input.priority ?? null,
      pending: null,
      pendingHeld: false,
      lastRecalcAt: null,
      consecutive: 0,
      changes,
    };
  }
  return {
    priority: input.priority ?? null,
    pending: decision.priority,
    pendingHeld: true,
    lastRecalcAt: Number.isFinite(input.lastRecalcAt) ? input.lastRecalcAt : nowMs,
    consecutive: Number.isInteger(input.consecutive) && input.consecutive > 0 ? input.consecutive : 1,
    changes,
  };
}

function modeOf(dir, apply) {
  if (fs.existsSync(disabledFile(dir))) return 'disabled';
  return apply ? 'write' : 'dry-run';
}

function headOf(mode) {
  if (mode === 'dry-run') return 'dry-run：';
  if (mode === 'disabled') return '已停用：';
  return '写入：';
}

function errorText(error) {
  if (error instanceof Error) return String(error.message || error);
  return String(error ?? '');
}

/** 只认原文里的 Could not resolve to a Repository，且仓名就是本条要写的仓。对不上返回 null，调用方原样再抛。 */
function unresolvableRepoReason(error, repo) {
  const text = errorText(error);
  if (!text.includes('Could not resolve to a Repository')) return null;
  if (typeof repo !== 'string' || repo.length === 0) return null;
  const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`(?:^|[^A-Za-z0-9._/-])${escaped}(?=$|[^A-Za-z0-9._/-])`).test(text)) return null;
  return text;
}

function restoreUnwrittenDebounce(nextItems, saved, ref) {
  if (Object.prototype.hasOwnProperty.call(saved, ref)) nextItems[ref] = saved[ref];
  else delete nextItems[ref];
}

function skipReport(skippedRepos) {
  if (skippedRepos.size === 0) return { lines: [], suffix: '' };
  const lines = [];
  const parts = [];
  for (const [repo, info] of skippedRepos) {
    const reason = redact(info.reason);
    lines.push(`跳过 ${repo} ${info.count} 条：${reason}\n`);
    parts.push(`${repo} ${info.count} 条：${reason}`);
  }
  return {
    lines,
    suffix: `，跳过 ${skippedRepos.size} 个仓（${parts.join('；')}）`,
  };
}

function outWrite(stdout, text) {
  (stdout || { write() {} }).write(text);
}

/**
 * 对每条 item 打分、防抖、算关联 PR。apply 不为真时不调用 write。
 * 防抖状态写进 dir/debounce.json；只有真写成功才追加 dir/changes.jsonl。
 */
export async function runPrioSync({
  dir,
  items = [],
  prs,
  nowMs,
  apply = false,
  ownerLogin,
  projectNumber,
  write,
  stdout,
  table = DEFAULT_REPO_CLASS_TABLE,
  excludedCount: presetExcluded = 0,
  nullContent = 0,
  carryTicks = CI_CARRY_TICKS,
} = {}) {
  if (!dir) throw new Error('缺少状态目录');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const mode = modeOf(dir, apply);
  const loaded = loadDebounceState(dir);
  const saved = loaded.items;
  const carryLimit = Number.isInteger(carryTicks) && carryTicks > 0 ? carryTicks : CI_CARRY_TICKS;
  const history = readJsonLines(changesFile(dir), '变更日志');
  const reminded = loadReminderKeys(dir);
  const nextItems = {};
  const changes = [];
  let pinned = 0;
  let skippedHere = 0;
  const knownPrs = Array.isArray(prs) ? prs.filter((pr) => !isExcludedRepo(pr?.repo, table)) : null;
  const carried = knownPrs ? carryLinkedPrCi(knownPrs, loaded.prCi, carryLimit) : null;
  const linkPrs = carried ? carried.prs : null;
  const linkAllowed = macMiniStopped(dir);

  for (const item of items) {
    if (!item?.repo || !Number.isInteger(item.number) || item.number <= 0) continue;
    if (itemIsExcluded(item, table)) {
      skippedHere += 1;
      const kept = refOf(item);
      if (Object.prototype.hasOwnProperty.call(saved, kept)) nextItems[kept] = saved[kept];
      continue;
    }
    const ref = refOf(item);
    const labels = Array.isArray(item.labels) ? item.labels : [];
    if (Number.isFinite(item.lastEventAt) && now - item.lastEventAt > STALE_REMIND_MS) {
      remindOnce(dir, reminded, stdout, now, { item: ref, kind: 'stale', text: '还要不要' });
    }
    if (labels.includes(PIN_LABEL)) {
      pinned += 1;
      continue;
    }
    const related = knownPrs ? prsFor(item, knownPrs) : [];
    const boardPriority = item.priority ?? null;
    const scored = annotateScore(item, scorePriority(factsForScore(item, related), now));
    if (!priorityWritable(history, ref, boardPriority) && !sameValue(boardPriority, scored.priority)) {
      remindOnce(dir, reminded, stdout, now, {
        item: ref,
        kind: 'manual',
        field: '优先级',
        target: scored.priority,
        text: '手动值与规则不一致，提醒一次',
      });
      nextItems[ref] = {
        priority: boardPriority,
        pending: null,
        pendingHeld: false,
        lastRecalcAt: null,
        consecutive: 0,
        changes: Array.isArray(saved[ref]?.changes) ? saved[ref].changes : [],
      };
    } else {
      const input = inputState(saved[ref], boardPriority);
      const decision = applyDebounce(input, scored, now);
      if (decision.action === 'freeze') {
        outWrite(stdout, `${ref} 优先级 冻结（每小时最多 4 次）\n`);
        nextItems[ref] = decision.next;
      } else if (decision.action === 'write' && !sameValue(boardPriority, decision.priority)) {
        changes.push({
          item: ref,
          repo: item.repo,
          issue: item.number,
          field: '优先级',
          old: boardPriority,
          new: decision.priority,
          basis: basisFor(scored),
          ...(typeof item.id === 'string' && item.id ? { itemId: item.id } : {}),
        });
        nextItems[ref] = mode === 'write' ? decision.next : holdUnwritten(input, decision, now);
      } else {
        nextItems[ref] = decision.next;
      }
    }
    if (linkPrs) {
      const next = linkedPrField({ issues: [{ repo: item.repo, number: item.number }], prs: linkPrs })[ref] ?? '';
      const current = item.linkedPr ?? '';
      let lastLink = null;
      for (const row of history) {
        if (row?.item === ref && row?.field === '关联 PR') lastLink = row;
      }
      // 与 priorityWritable 同一条：空值，或上次写入的新值就是看板当前值，才允许改。
      const linkWritable = current === '' || (Boolean(lastLink) && sameValue(lastLink.new, current));
      if (!linkWritable && !sameValue(current, next)) {
        remindOnce(dir, reminded, stdout, now, {
          item: ref,
          kind: 'manual',
          field: '关联 PR',
          target: next,
          text: '手动值与规则不一致，提醒一次',
        });
      } else if (!sameValue(current, next) && next !== '') {
        changes.push({
          item: ref,
          repo: item.repo,
          issue: item.number,
          field: '关联 PR',
          old: current,
          new: next,
          basis: LINK_BASIS,
          ...(typeof item.id === 'string' && item.id ? { itemId: item.id } : {}),
        });
      }
    }
  }

  for (const [ref, state] of Object.entries(saved)) {
    if (Object.prototype.hasOwnProperty.call(nextItems, ref)) continue;
    if (isExcludedRepo(repoOfRef(ref), table)) nextItems[ref] = state;
  }

  let written = 0;
  const skippedRepos = new Map();
  for (const change of changes) {
    const basis = change.basis ? ` 依据：${change.basis}` : '';
    outWrite(stdout, `${change.item} ${change.field} ${show(change.old)} → ${show(change.new)}${basis}\n`);
    if (mode !== 'write') continue;
    if (change.field === '关联 PR' && !linkAllowed) {
      outWrite(stdout, LINK_HOLD);
      continue;
    }
    const prior = skippedRepos.get(change.repo);
    if (prior) {
      prior.count += 1;
      restoreUnwrittenDebounce(nextItems, saved, change.item);
      continue;
    }
    if (typeof write !== 'function') throw new Error('真写需要写闸');
    const action = {
      type: 'project.field.set',
      dedupeKey: `prio:${change.item}:${change.field}:${show(change.old)}:${show(change.new)}:${now}`,
      repo: change.repo,
      issue: change.issue,
      ownerLogin,
      projectNumber,
      fields: { [change.field]: change.new },
      ref: change.item,
    };
    if (typeof change.itemId === 'string' && change.itemId) action.itemId = change.itemId;
    assertPrioFields(action.fields);
    try {
      await write(action);
    } catch (error) {
      const reason = unresolvableRepoReason(error, change.repo);
      if (reason == null) throw error;
      skippedRepos.set(change.repo, { count: 1, reason });
      restoreUnwrittenDebounce(nextItems, saved, change.item);
      continue;
    }
    appendChange(dir, {
      at: new Date(now).toISOString(),
      item: change.item,
      repo: change.repo,
      issue: change.issue,
      field: change.field,
      old: change.old,
      new: change.new,
      basis: change.basis || '',
    });
    written += 1;
  }
  let prCiOut;
  if (mode === 'write' && carried?.changed) {
    prCiOut = Object.keys(carried.prCi).length > 0 ? carried.prCi : undefined;
  } else if (loaded.prCiPresent) {
    prCiOut = loaded.prCi;
  }
  saveDebounce(dir, nextItems, prCiOut);
  const report = skipReport(skippedRepos);
  for (const line of report.lines) outWrite(stdout, line);
  const excludedTotal = (Number.isInteger(presetExcluded) && presetExcluded > 0 ? presetExcluded : 0) + skippedHere;
  outWrite(stdout, `${headOf(mode)}${items.length - skippedHere} 条，变更 ${changes.length}，写入 ${written}，钉住 ${pinned}${report.suffix}${excludedSuffix(excludedTotal)}${nullContentSuffix(nullContent)}\n`);
  return { written, planned: changes.length, pinned, mode, excluded: excludedTotal };
}

/** 把 since 这个时间点之后的变更改回当时的旧值。默认仍是 dry-run。 */
function liveValue(items, row) {
  if (!Array.isArray(items)) return undefined;
  const item = items.find((entry) => `${entry?.repo}#${entry?.number}` === row.item);
  if (!item) return undefined;
  if (row.field === '优先级') return item.priority ?? null;
  if (row.field === '关联 PR') return item.linkedPr ?? '';
  return undefined;
}

export async function restorePrio({
  dir,
  since,
  nowMs,
  apply = false,
  ownerLogin,
  projectNumber,
  write,
  stdout,
  items,
  table = DEFAULT_REPO_CLASS_TABLE,
  excluded = null,
  nullContent = 0,
} = {}) {
  if (!dir) throw new Error('缺少状态目录');
  const at = Date.parse(since);
  if (Number.isNaN(at)) throw new Error(`无法识别的时间：${since}`);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const mode = modeOf(dir, apply);
  const rows = readChanges(dir);
  const earliest = new Map();
  for (const row of rows) {
    if (Date.parse(row.at) < at) continue;
    const key = `${row.item}\0${row.field}`;
    const prev = earliest.get(key);
    if (!prev || Date.parse(row.at) < Date.parse(prev.at)) earliest.set(key, row);
  }
  const planned = [];
  const skipped = [];
  let excludedRows = 0;
  for (const row of earliest.values()) {
    const repo = repoOfChange(row);
    if (isExcludedRepo(repo, table)) {
      excludedRows += 1;
      continue;
    }
    const history = rows.filter((entry) => entry.item === row.item && entry.field === row.field);
    const latest = history[history.length - 1];
    const lastWritten = latest ? latest.new : row.new;
    const live = liveValue(items, row);
    const current = Array.isArray(items) ? live : lastWritten;
    if (Array.isArray(items) && !sameValue(live, lastWritten)) {
      skipped.push({ item: row.item, field: row.field, current: live, last: lastWritten });
      continue;
    }
    const target = row.old == null || row.old === '' ? null : row.old;
    if (sameValue(current, target)) continue;
    planned.push({
      item: row.item,
      repo: row.repo,
      issue: row.issue,
      field: row.field,
      old: current,
      new: target,
      basis: RESTORE_BASIS,
    });
  }
  for (const skip of skipped) {
    outWrite(
      stdout,
      `${skip.item} ${skip.field} ${RESTORE_SKIP}（当前 ${show(skip.current)}，上次写入 ${show(skip.last)}）\n`,
    );
  }
  const linkAllowed = macMiniStopped(dir);
  let written = 0;
  for (const change of planned) {
    const basis = change.basis ? ` 依据：${change.basis}` : '';
    outWrite(stdout, `${change.item} ${change.field} ${show(change.old)} → ${show(change.new)}${basis}\n`);
    if (mode !== 'write') continue;
    if (change.field === '关联 PR' && !linkAllowed) {
      outWrite(stdout, LINK_HOLD);
      continue;
    }
    if (typeof write !== 'function') throw new Error('真写需要写闸');
    const action = {
      type: 'project.field.set',
      dedupeKey: `prio-restore:${change.item}:${change.field}:${since}:${now}`,
      repo: change.repo,
      issue: change.issue,
      ownerLogin,
      projectNumber,
      fields: { [change.field]: change.new },
      ref: change.item,
    };
    assertPrioFields(action.fields);
    await write(action);
    appendChange(dir, {
      at: new Date(now).toISOString(),
      item: change.item,
      repo: change.repo,
      issue: change.issue,
      field: change.field,
      old: change.old,
      new: change.new,
      basis: change.basis || RESTORE_BASIS,
    });
    written += 1;
  }
  const excludedShown = excluded == null
    ? excludedRows
    : (Number.isInteger(excluded) && excluded > 0 ? excluded : 0);
  outWrite(stdout, `${headOf(mode)}还原 ${planned.length} 条，写入 ${written}${excludedSuffix(excludedShown)}${nullContentSuffix(nullContent)}\n`);
  return { written, planned: planned.length, mode, excluded: excludedShown };
}

/** 运行日志：<stateDir>/run-YYYY-MM-DD.log。日期取注入时钟的 UTC 日历日。不轮转、不清理、不设大小上限。 */
function runLogFile(dir, nowMs) {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return path.join(dir, `run-${day}.log`);
}

function appendRunLog(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function teeRunLog(stdout, file) {
  return {
    write(text) {
      outWrite(stdout, text);
      appendRunLog(file, text);
    },
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parsePrioArgs(argv);
  const dir = args.stateDir || deps.dir || defaultStateDir();
  const stdout = deps.stdout || process.stdout;
  const nowMs = deps.now ? deps.now() : Date.now();
  const profile = deps.loadProfile ? deps.loadProfile() : loadAcceptanceProfile();
  const table = readRepoClassTable(path.join(dir, 'repo-class.json'));
  let write = deps.write || null;
  let items = deps.loadItems ? await deps.loadItems() : null;
  let prs = deps.loadPrs ? await deps.loadPrs() : null;
  let skipped = null;
  let boardExcluded = 0;
  const needBoard = items == null;
  const needPrs = !args.restore && prs == null;
  if (needBoard || needPrs) {
    const reader = createReadGithub({ profile, run: deps.run, fetchImpl: deps.fetchImpl });
    if (needBoard) {
      const board = await loadBoardItems(reader, profile, table);
      items = board.items;
      skipped = board.skipped;
      boardExcluded = board.excludedCount;
    }
    if (needPrs) {
      prs = await loadPullRequests(reader, [...new Set((items || []).map((entry) => entry.repo))], table);
    }
  }
  if (args.write === true && !write && !fs.existsSync(disabledFile(dir))) {
    const token = deps.readToken ? deps.readToken() : readPriorityWriterToken(priorityTokenPath());
    const writer = createPriorityGithub({ profile, token, run: deps.run, fetchImpl: deps.fetchImpl });
    write = (action) => writer.write(action);
  }
  const split = withoutExcludedItems(items || [], table);
  const loaded = split.items;
  const excluded = boardExcluded + split.excluded;
  const logFile = runLogFile(dir, nowMs);
  const modeLabel = args.write === true ? 'apply' : 'dry-run';
  appendRunLog(logFile, `${new Date(nowMs).toISOString()} ${modeLabel} ${loaded.length}\n`);
  if (skipped) {
    appendRunLog(
      logFile,
      `跳过：已归档=${skipped.archived}，非 Issue=${skipped.notIssue}，content 为 null=${skipped.nullContent}，字段不合法=${skipped.invalid}\n`,
    );
    if (skipped.nullContent > 0) {
      appendRunLog(logFile, `告警：content 为 null 的看板条目有 ${skipped.nullContent} 条，读通道没有拿到内容\n`);
    }
  }
  const loggedStdout = teeRunLog(stdout, logFile);
  const nullContent = skipped ? skipped.nullContent : 0;
  if (args.restore) {
    return restorePrio({
      dir,
      since: args.restore,
      nowMs,
      apply: args.write === true,
      ownerLogin: profile.ownerLogin,
      projectNumber: profile.projectNumber,
      write,
      stdout: loggedStdout,
      items: loaded,
      table,
      excluded,
      nullContent,
    });
  }
  return runPrioSync({
    dir,
    items: loaded,
    prs,
    nowMs,
    apply: args.write === true,
    ownerLogin: profile.ownerLogin,
    projectNumber: profile.projectNumber,
    write,
    stdout: loggedStdout,
    table,
    excludedCount: excluded,
    nullContent,
  });
}

function withoutExcludedItems(list, table) {
  const kept = [];
  let excluded = 0;
  for (const item of list || []) {
    if (itemIsExcluded(item, table)) {
      excluded += 1;
      continue;
    }
    kept.push(item);
  }
  return { items: kept, excluded };
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (invoked && here === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}
