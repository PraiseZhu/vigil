#!/usr/bin/env node
// 单条精确读写（#W4-d）：事件到达时只读这一条 issue 的看板条目和它点名的 PR，不读整盘。
// 整盘读一次是 loadBoardItems + loadPullRequests（实测 72–131 秒），事件路径只允许读这一条，目标 p95 ≤ 10 秒。
// 规则、写闸、changes.jsonl 都复用 prio-sync：本文件不新增加分规则、不改写闸、不改状态文件格式。
// 读只看板那一个条目：按 profile.projectNumber 对应的 project id 在 issue 的 projectItems 里挑，别的不看。
// 「关联 PR」只取这条 issue 在 timeline 里被交叉引用的 PR；调用方已经拿到 PR 时可以直接传 prs。
// 只更新这一条：runPrioSync 传 mergeState，其它条目的防抖与 CI 携带状态原样保留（整份重建会把它们删掉）。
// 只看到一部分 PR 时，「关联 PR」不会把已有的 PR 从文本里删掉（不回退），留给整盘那一拍去收敛。
// 不在看板上、issue 读不到、已归档、被钉住、被去抖挡住、字段没变化：都不写、不抛，原因放在返回值里。
// 查询里带 rateLimit.cost，把这条路径花掉的 GraphQL 点数带回来（没带回来时是 null，不当 0）。
// 默认 dry-run（只打印计划）。--write 才写，令牌仍只从 gh-priority-writer-token 读。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './profile.mjs';
import {
  DEFAULT_REPO_CLASS_TABLE,
  ITEM_FIELD_QUERY,
  ONLY_FIELD_NAMES,
  createPriorityGithub,
  createReadGithub,
  defaultStateDir,
  mapItem,
  mapPr,
  priorityTokenPath,
  readFieldValue,
  readPriorityWriterToken,
  readRepoClassTable,
  runPrioSync,
} from './prio-sync.mjs';

/** 这条路径查的 PR 上限：交叉引用事件的第一页。多出来的由整盘那一拍补。 */
export const ITEM_TIMELINE_FIRST = 50;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_RE = /^[1-9][0-9]*$/;
const KEYED_ARGS = new Set(['--repo', '--issue', '--state-dir', '--only-field']);

/**
 * 一条 issue 的看板条目 + 它被交叉引用到的 PR，一次 GraphQL 读完。
 * 看板条目按 project id 匹配（不是按号），同号的别的看板不会被当成这一条。
 * rateLimit.cost 是这次查询本身花掉的点数（GraphQL 按节点计，最低 1 点）。
 */
export const ITEM_QUERY = `query ($login: String!, $projectNumber: Int!, $owner: String!, $name: String!, $number: Int!) {
  rateLimit {
    cost
    remaining
    resetAt
  }
  user(login: $login) {
    projectV2(number: $projectNumber) {
      id
    }
  }
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      timelineItems(first: ${ITEM_TIMELINE_FIRST}, itemTypes: [CROSS_REFERENCED_EVENT]) {
        nodes {
          __typename
          ... on CrossReferencedEvent {
            source {
              __typename
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
        }
      }
      projectItems(first: 20, includeArchived: true) {
        nodes {
          id
          isArchived
          updatedAt
          project { id number }
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

function showActual(value) {
  return value == null || value === '' ? '（空）' : String(value);
}

export function parseItemArgs(argv = []) {
  const out = { write: false, dryRun: false, repo: null, issue: null, stateDir: null, onlyField: null };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      out.write = true;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (KEYED_ARGS.has(arg)) {
      if (seen.has(arg)) throw new Error(`重复的参数：${arg}`);
      seen.add(arg);
      const value = argv[i + 1];
      if (typeof value !== 'string' || !value || value.startsWith('--')) throw new Error(`缺少 ${arg} 的取值`);
      if (arg === '--repo') {
        if (!REPO_RE.test(value)) throw new Error(`--repo 期望 owner/repo，实际：${showActual(value)}`);
        out.repo = value;
      } else if (arg === '--issue') {
        if (!ISSUE_RE.test(value)) throw new Error(`--issue 期望正整数，实际：${showActual(value)}`);
        out.issue = Number(value);
      } else if (arg === '--state-dir') {
        out.stateDir = value;
      } else {
        if (!ONLY_FIELD_NAMES.includes(value)) {
          throw new Error(`--only-field 期望「关联 PR」或「优先级」，实际：${showActual(value)}`);
        }
        out.onlyField = value;
      }
      i += 1;
      continue;
    }
    throw new Error(`无法识别的参数：${arg}`);
  }
  if (out.write && out.dryRun) throw new Error('不能同时传 --dry-run 和 --write');
  if (!out.repo) throw new Error('缺少 --repo（期望 owner/repo）');
  if (out.issue == null) throw new Error('缺少 --issue');
  return out;
}

/**
 * 读这一条：看板条目（只挑 project id 对上的那一个）和被交叉引用的 PR。
 * 读不到 issue / 不在看板 / 已归档 / 字段不合法时 item 为 null，reason 写明是哪种，调用方不写、不抛。
 */
export async function loadOneItem(reader, { repo, issue, profile, table = DEFAULT_REPO_CLASS_TABLE } = {}) {
  const [owner, name] = String(repo || '').split('/');
  const data = await reader.ownerGraphql(ITEM_QUERY, {
    login: profile?.ownerLogin,
    projectNumber: Number(profile?.projectNumber),
    owner,
    name,
    number: Number(issue),
  });
  const cost = Number(data?.rateLimit?.cost);
  const loaded = {
    item: null,
    reason: '',
    prs: prsFromTimeline(data?.repository?.issue?.timelineItems?.nodes),
    cost: Number.isFinite(cost) ? cost : null,
  };
  const boardId = data?.user?.projectV2?.id;
  if (!boardId) throw new Error(`找不到看板 #${profile?.projectNumber}`);
  const node = data?.repository?.issue;
  if (!node) return { ...loaded, reason: 'not-found' };
  const found = (node.projectItems?.nodes || []).find((entry) => entry?.project?.id === boardId);
  if (!found) return { ...loaded, reason: 'not-on-board' };
  if (found.isArchived) return { ...loaded, reason: 'archived' };
  const mapped = mapItem(found, table);
  if (!mapped) return { ...loaded, reason: 'invalid' };
  return { ...loaded, item: mapped };
}

/** timeline 里被交叉引用到的 PR，按现有 mapPr 映射（跟整盘读同一套字段）。非 PR 的来源跳过。 */
export function prsFromTimeline(nodes = []) {
  const out = [];
  const seen = new Set();
  for (const entry of nodes || []) {
    const source = entry?.source;
    if (source?.__typename !== 'PullRequest') continue;
    const pr = mapPr(source);
    if (!pr) continue;
    const key = `${pr.repo.toLowerCase()}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pr);
  }
  return out;
}

/** 关联 PR 文本里出现的 PR 号。`#12(open,CI✓)` → 12。 */
export function prNumbersInText(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(/#([1-9]\d*)/g)) found.add(Number(match[1]));
  return found;
}

/** 新文本比旧文本少了 PR 号：单条只看到一部分 PR 时不能这么写，否则会把已有的 PR 从看板上删掉。 */
export function linkWouldShrink(oldText, newText) {
  const before = prNumbersInText(oldText);
  if (before.size === 0) return false;
  const after = prNumbersInText(newText);
  for (const number of before) if (!after.has(number)) return true;
  return false;
}

function changeKey(change) {
  return `${change?.item || ''}\0${change?.field || ''}\0${change?.old ?? ''}\0${change?.new ?? ''}`;
}

/**
 * 写后回读这一条该字段（沿用 prio-run 的 readBack：按 itemId 单条读，只用只读通道）。
 * 没有 itemId 时返回 null，由 runPrioSync 按「读不到」处理。
 */
export function itemReadBack(reader) {
  return async (change) => {
    if (typeof change?.itemId !== 'string' || !change.itemId) return null;
    const data = await reader.ownerGraphql(ITEM_FIELD_QUERY, { id: change.itemId });
    return readFieldValue(data?.node, change.field);
  };
}

/**
 * 单条同步：只读这一条，按现有规则算，写入仍走传入的 write（写闸）与 changes.jsonl。
 * apply 不为真时是 dry-run，只打印计划，不写、不改 debounce.json。
 * 返回值里 written / planned / skipped / cost 是给事件路径看的；cost 是这次查询的 GraphQL 点数。
 */
export async function syncOneItem({
  repo,
  issue,
  dir,
  apply = false,
  nowMs,
  profile,
  reader,
  write,
  readBack,
  stdout,
  table = DEFAULT_REPO_CLASS_TABLE,
  onlyField = null,
  onPlan = null,
  prs = null,
  sync = runPrioSync,
} = {}) {
  if (!dir) throw new Error('缺少状态目录');
  if (!REPO_RE.test(String(repo || ''))) throw new Error(`repo 期望 owner/repo，实际：${showActual(repo)}`);
  if (!Number.isInteger(Number(issue)) || Number(issue) <= 0) throw new Error(`issue 期望正整数，实际：${showActual(issue)}`);
  if (!profile) throw new Error('syncOneItem 需要 profile');
  const number = Number(issue);
  const loaded = await loadOneItem(reader, { repo, issue: number, profile, table });
  const base = {
    repo,
    issue: number,
    reason: loaded.reason,
    cost: loaded.cost,
    written: 0,
    planned: 0,
  };
  if (!loaded.item) return base;

  // 只有一部分 PR 时的「不回退」：只看关联 PR，且只挡住会把已有 PR 删掉的那几条。
  const blocked = new Set();
  let shrunk = 0;
  const gate = async (plan) => {
    for (const change of plan || []) {
      if (change?.field !== '关联 PR') continue;
      if (!linkWouldShrink(change.old, change.new)) continue;
      blocked.add(changeKey(change));
      shrunk += 1;
    }
    let userAllowed = null;
    if (typeof onPlan === 'function') {
      const decided = await onPlan(plan);
      if (decided?.abort) return { abort: true, reason: decided.reason || '' };
      if (typeof decided?.allow === 'function') userAllowed = decided.allow;
    }
    if (blocked.size === 0 && !userAllowed) return null;
    return {
      allow(change, context) {
        if (blocked.has(changeKey(change))) return 'skip';
        return userAllowed ? userAllowed(change, context) : 'write';
      },
    };
  };

  const back = readBack === undefined || readBack === null
    ? (apply ? itemReadBack(reader) : null)
    : readBack;
  const result = await sync({
    dir,
    items: [loaded.item],
    prs: Array.isArray(prs) ? prs : loaded.prs,
    nowMs,
    apply,
    ownerLogin: profile.ownerLogin,
    projectNumber: profile.projectNumber,
    write,
    stdout,
    table,
    onlyField,
    onPlan: gate,
    readBack: back,
    mergeState: true,
  });
  if (shrunk > 0) {
    (stdout || { write() {} }).write(`关联 PR 不回退：${shrunk} 条只看到部分 PR，本拍不写\n`);
  }
  return { ...base, ...result, shrinkSkipped: shrunk };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = parseItemArgs(argv);
  const dir = args.stateDir || deps.dir || defaultStateDir();
  const stdout = deps.stdout || process.stdout;
  const nowMs = deps.now ? deps.now() : Date.now();
  const profile = deps.loadProfile ? deps.loadProfile() : loadAcceptanceProfile();
  const table = deps.table || readRepoClassTable(path.join(dir, 'repo-class.json'));
  const reader = deps.reader || createReadGithub({ profile, run: deps.run, fetchImpl: deps.fetchImpl });
  const disabled = fs.existsSync(path.join(dir, 'disabled'));
  const wantWrite = args.write === true && !disabled;
  if (args.write && disabled) stdout.write('已停写\n');
  let write = deps.write || null;
  if (wantWrite && !write) {
    // 令牌只在真写之前读，且只从文件读；dry-run 一步都不碰。
    const token = deps.readToken ? deps.readToken() : readPriorityWriterToken(priorityTokenPath());
    const writer = createPriorityGithub({ profile, token, run: deps.run, fetchImpl: deps.fetchImpl });
    write = (action) => writer.write(action);
  }
  return syncOneItem({
    repo: args.repo,
    issue: args.issue,
    dir,
    apply: wantWrite,
    nowMs,
    profile,
    reader,
    write,
    readBack: deps.readBack,
    stdout,
    table,
    onlyField: args.onlyField,
    onPlan: deps.onPlan || null,
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
