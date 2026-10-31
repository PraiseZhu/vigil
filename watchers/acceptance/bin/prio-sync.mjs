#!/usr/bin/env node
// 看板优先级写回（#157，规则以 #62 为准）。默认 dry-run：只打印将要改的字段，不调用写闸。
// 真写要显式 --write。目录里有 disabled 文件时，哪种模式都不写。
// 「优先级」只在当前值为空，或 changes.jsonl 里该字段最后一条新值等于看板当前值时才写；否则提醒一次。
// 「关联 PR」也由这里写，但真写前必须已有 mac-mini-stopped（人确认 Mac mini 停写后自建，本文件不创建）。
// 依据只写进 changes.jsonl，不新增看板字段。60 天没动静只提醒「还要不要」，不关 issue。
// 令牌只从 ~/acceptance/secrets/gh-priority-writer-token 读，不读环境变量，不写进日志和错误信息。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithub, PRIO_BOARD_FIELDS } from './github.mjs';
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
const RESTORE_BASIS = 'restore 按变更日志改回';
const LINK_HOLD = '不写关联 PR：没有 .prio/mac-mini-stopped，要等确认 Mac mini 已停写\n';
const RESTORE_SKIP = '跳过：当前值不是上次写入的值';

/** 默认分类表是空的。真实仓名放在配置文件里，不写进源码。 */
export const DEFAULT_REPO_CLASS_TABLE = Object.freeze({
  mivo: Object.freeze([]),
  idle: Object.freeze([]),
  'daily-tool': Object.freeze([]),
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

function loadDebounce(dir) {
  const file = stateFile(dir);
  if (!fs.existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('防抖状态不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('防抖状态不是合法 JSON');
  const items = parsed.items;
  if (items == null) return {};
  if (typeof items !== 'object' || Array.isArray(items)) throw new Error('防抖状态不是合法 JSON');
  return items;
}

function saveDebounce(dir, items) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(dir), `${JSON.stringify({ items })}\n`);
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
  else outWrite(stdout, `${row.item} 优先级 ${row.text}\n`);
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

export function readRepoClassTable(file) {
  if (!file || !fs.existsSync(file)) {
    return {
      mivo: [...DEFAULT_REPO_CLASS_TABLE.mivo],
      idle: [...DEFAULT_REPO_CLASS_TABLE.idle],
      'daily-tool': [...DEFAULT_REPO_CLASS_TABLE['daily-tool']],
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error('仓分类表不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('仓分类表不是合法 JSON');
  return {
    mivo: listOf(parsed.mivo),
    idle: listOf(parsed.idle),
    'daily-tool': listOf(parsed['daily-tool'] || parsed.dailyTool),
  };
}

/** 表里点名的用该档；没点名的按 daily-tool，并记「不在分类表里」。 */
export function classifyRepo(repo, table = DEFAULT_REPO_CLASS_TABLE) {
  const key = String(repo || '').toLowerCase();
  const has = (names) => (names || []).some((entry) => String(entry).toLowerCase() === key);
  if (has(table.mivo)) return { repoClass: 'mivo', unlisted: false };
  if (has(table.idle)) return { repoClass: 'idle', unlisted: false };
  if (has(table['daily-tool'])) return { repoClass: 'daily-tool', unlisted: false };
  return { repoClass: 'daily-tool', unlisted: true };
}

function timeMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function mapItem(node, table = DEFAULT_REPO_CLASS_TABLE) {
  if (!node || node.isArchived) return null;
  const content = node.content;
  if (!content || content.__typename !== 'Issue') return null;
  const repo = content.repository?.nameWithOwner;
  const number = Number(content.number);
  if (!repo || !Number.isInteger(number) || number <= 0) return null;
  const fields = valuesOf(node);
  const labels = (content.labels?.nodes || [])
    .map((label) => label?.name)
    .filter((name) => typeof name === 'string' && name);
  const priority = fields.get('优先级');
  const situationRaw = fields.get('情形档');
  const situationKnown = situationRaw === 'P0' || situationRaw === 'P1' || situationRaw === 'P2' || situationRaw === 'P3';
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
    situationTier: situationKnown ? situationRaw : null,
    situationKnown,
    issueState,
    issueStateKnown: issueState != null,
    lastEventAt,
    lastEventKnown: lastEventAt != null,
    repoClass: classified.repoClass,
    repoUnlisted: classified.unlisted,
  };
}

function ciOf(node) {
  const state = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  const value = String(state || '').toUpperCase();
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
  return pr;
}

export async function loadBoardItems(github, profile, table = DEFAULT_REPO_CLASS_TABLE) {
  const items = [];
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
      const mapped = mapItem(node, table);
      if (mapped) items.push(mapped);
    }
    after = conn.pageInfo?.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return items;
}

export async function loadPullRequests(github, repos) {
  const prs = [];
  const seen = new Set();
  for (const repo of repos || []) {
    const name = String(repo || '');
    if (!name.includes('/') || seen.has(name)) continue;
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
} = {}) {
  if (!dir) throw new Error('缺少状态目录');
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const mode = modeOf(dir, apply);
  const saved = loadDebounce(dir);
  const history = readJsonLines(changesFile(dir), '变更日志');
  const reminded = loadReminderKeys(dir);
  const nextItems = {};
  const changes = [];
  let pinned = 0;
  const knownPrs = Array.isArray(prs) ? prs : null;
  const linkAllowed = macMiniStopped(dir);

  for (const item of items) {
    if (!item?.repo || !Number.isInteger(item.number) || item.number <= 0) continue;
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
        });
        nextItems[ref] = mode === 'write' ? decision.next : holdUnwritten(input, decision, now);
      } else {
        nextItems[ref] = decision.next;
      }
    }
    if (knownPrs) {
      const next = linkedPrField({ issues: [{ repo: item.repo, number: item.number }], prs: knownPrs })[ref] ?? '';
      const current = item.linkedPr ?? '';
      if (!sameValue(current, next)) {
        changes.push({
          item: ref,
          repo: item.repo,
          issue: item.number,
          field: '关联 PR',
          old: current,
          new: next === '' ? null : next,
          basis: LINK_BASIS,
        });
      }
    }
  }

  let written = 0;
  for (const change of changes) {
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
      dedupeKey: `prio:${change.item}:${change.field}:${show(change.old)}:${show(change.new)}:${now}`,
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
      basis: change.basis || '',
    });
    written += 1;
  }
  saveDebounce(dir, nextItems);
  outWrite(stdout, `${headOf(mode)}${items.length} 条，变更 ${changes.length}，写入 ${written}，钉住 ${pinned}\n`);
  return { written, planned: changes.length, pinned, mode };
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
  for (const row of earliest.values()) {
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
  outWrite(stdout, `${headOf(mode)}还原 ${planned.length} 条，写入 ${written}\n`);
  return { written, planned: planned.length, mode };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parsePrioArgs(argv);
  const dir = args.stateDir || deps.dir || defaultStateDir();
  const stdout = deps.stdout || process.stdout;
  const nowMs = deps.now ? deps.now() : Date.now();
  const profile = deps.loadProfile ? deps.loadProfile() : loadAcceptanceProfile();
  let write = deps.write || null;
  let items = deps.loadItems ? await deps.loadItems() : null;
  let prs = deps.loadPrs ? await deps.loadPrs() : null;
  const needGithub = !write || (!args.restore && (items == null || prs == null));
  if (needGithub) {
    const token = deps.readToken ? deps.readToken() : readPriorityWriterToken(priorityTokenPath());
    const github = createPriorityGithub({ profile, token, run: deps.run });
    if (!write) write = (action) => github.write(action);
    if (items == null) {
      items = await loadBoardItems(github, profile, readRepoClassTable(path.join(dir, 'repo-class.json')));
    }
    if (!args.restore && prs == null) {
      prs = await loadPullRequests(github, [...new Set((items || []).map((entry) => entry.repo))]);
    }
  }
  if (args.restore) {
    return restorePrio({
      dir,
      since: args.restore,
      nowMs,
      apply: args.write === true,
      ownerLogin: profile.ownerLogin,
      projectNumber: profile.projectNumber,
      write,
      stdout,
      items: items || [],
    });
  }
  return runPrioSync({
    dir,
    items: items || [],
    prs,
    nowMs,
    apply: args.write === true,
    ownerLogin: profile.ownerLogin,
    projectNumber: profile.projectNumber,
    write,
    stdout,
  });
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const here = fileURLToPath(import.meta.url);
if (invoked && here === invoked) {
  main().catch((error) => {
    process.stderr.write(`${error.message || error}\n`);
    process.exitCode = 1;
  });
}
