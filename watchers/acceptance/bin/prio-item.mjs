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
//
// 写策略（复审 P2-1 / P2-2）：单条路径不自己发明规则，但也不照搬整盘的写策略，只放行「只升不降」的那一半：
// - 优先级：只写 classifyPrioChange 的 fill（空 → P1/P2）和 upgrade（已有值升档）；
//   降级、改空、空 → P0/P3（fill-other）、已知值互改（other）一律 skip，留给 30 分钟整盘；
// - 关联 PR：只写不收缩的（linkWouldShrink 为假），且要有 mac-mini-stopped 标记（调用方给的 linkAllowed 说了算）；
// - 授权仓清单（authorized-repos.json）以外的仓一条都不写；
// - 每小时写入上限、每拍上限、GraphQL 额度预算都和整盘 prio-run 共用同一份（组件名 prio-run），不另开后门。
// `partialPrs`：这条路径的 PR 只来自 timeline，默认按「可能少看 PR」处理（true），此时优先级只升不降。
// 只有调用方能证明 PR 集合是完整的才传 false；即使传 false，降级/改空仍然不写（P2-1 一律留给整盘），
// 变的只是返回值里的原因标记，方便事后查是哪一类被挡。
//
// 写锁（复审 P2-4）：apply 必须带 lockPath，CLI 默认 /tmp/prio-write.lock（和整盘同一个文件，见 bin/prio-lock.mjs）。
// 抢不到锁就整条不读、不写，原因写进返回值（skipped: 'lock-busy'）。
//
// 已知限制（复审 P2-3，不改行为）：只靠分支名关联到这条 issue 的 PR 不会出现在 issue 的交叉引用 timeline 里，
// 所以单条路径永远看不到它；这类 PR 的「关联 PR」文本只能由 30 分钟整盘那一拍补齐（整盘会按 PR 搜索结果收敛）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './profile.mjs';
import { WRITE_LOCK_FILE, withWriteLock } from './prio-lock.mjs';
import { GRAPHQL_COST_PER_REQUEST, chargeBudget, decideTick, readBudgetFile, readRateState, writeRateState } from './rate-budget.mjs';
import { hostFilesFromEnv, readAuthorizedRepos, resolveMaxPerTick } from './prio-run.mjs';
import {
  DEFAULT_REPO_CLASS_TABLE,
  ITEM_FIELD_QUERY,
  ONLY_FIELD_NAMES,
  PRIO_HOURLY_MAX,
  PRIO_HOURLY_WINDOW_MS,
  classifyPrioChange,
  countRecentChanges,
  createPriorityGithub,
  createReadGithub,
  defaultStateDir,
  macMiniStopped,
  mapItem,
  mapPr,
  priorityTokenPath,
  readChangeLog,
  readFieldValue,
  readPriorityWriterToken,
  readRepoClassTable,
  runPrioSync,
} from './prio-sync.mjs';

/** 单条查询的点数预留：判定预算时先按 2 点算（实测 cost=2），读回来再按实际 cost 记账。 */
export const ITEM_READ_RESERVE = 2;

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
 * 单条路径的写策略（复审 P2-1 / P2-2）。纯函数，不发请求、不读文件。
 * 返回 { decision: 'write' | 'skip', kind, reason }：
 * - 范围外（白名单以外字段 / 排除档仓）→ 'out-of-scope' / 'repo-excluded'；
 * - 不在授权清单里的仓 → 'repo-not-authorized'；
 * - 优先级只放行 fill / upgrade；降级、改空 → partialPrs 时 'partial-prs-no-lower'，否则 'no-lower-single-path'；
 *   其余（空 → P0/P3、已知值互改）→ 'waits-for-board'；
 * - 关联 PR：没有 mac-mini-stopped → 'link-held'；会变少 → 'link-shrink'；其余放行。
 */
export function singleItemVerdict(change, {
  allowSet = new Set(),
  table = DEFAULT_REPO_CLASS_TABLE,
  partialPrs = true,
  linkAllowed = true,
} = {}) {
  const found = classifyPrioChange(change, { table });
  const repo = String(change?.repo || '').toLowerCase();
  if (found.kind === 'out-of-scope') {
    return { decision: 'skip', kind: found.kind, reason: found.reason === 'exclude' ? 'repo-excluded' : 'out-of-scope' };
  }
  if (!allowSet.has(repo)) return { decision: 'skip', kind: found.kind, reason: 'repo-not-authorized' };
  if (found.kind === 'fill' || found.kind === 'upgrade') return { decision: 'write', kind: found.kind, reason: '' };
  if (found.kind === 'link') {
    if (!linkAllowed) return { decision: 'skip', kind: 'link', reason: 'link-held' };
    if (linkWouldShrink(change.old, change.new)) return { decision: 'skip', kind: 'link', reason: 'link-shrink' };
    return { decision: 'write', kind: 'link', reason: '' };
  }
  if (found.kind === 'downgrade' || found.kind === 'clear') {
    return { decision: 'skip', kind: found.kind, reason: partialPrs ? 'partial-prs-no-lower' : 'no-lower-single-path' };
  }
  return { decision: 'skip', kind: found.kind, reason: 'waits-for-board' };
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
 * apply 不为真时是 dry-run，只打印计划，不写、不改 debounce.json；真写要带 lockPath（与整盘同一把锁）。
 * 返回值里 written / planned / skipped / cost 是给事件路径看的；cost 是这次查询的 GraphQL 点数。
 * 写策略、额度、每小时上限、锁全部在下面收口，调用方不用再自己算。
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
  partialPrs = null,
  allowRepos = null,
  linkAllowed = null,
  lockPath = null,
  lockOptions = null,
  rateFile = null,
  budgetFile = null,
  budgets = null,
  env = undefined,
} = {}) {
  if (!dir) throw new Error('缺少状态目录');
  if (!REPO_RE.test(String(repo || ''))) throw new Error(`repo 期望 owner/repo，实际：${showActual(repo)}`);
  if (!Number.isInteger(Number(issue)) || Number(issue) <= 0) throw new Error(`issue 期望正整数，实际：${showActual(issue)}`);
  if (!profile) throw new Error('syncOneItem 需要 profile');
  const number = Number(issue);
  const out = stdout || { write() {} };
  const now = Number.isFinite(nowMs) ? Number(nowMs) : Date.now();
  const mode = apply ? 'write' : 'dry-run';
  // 没明说就是「PR 集合可能不全」：这条路径的 PR 只来自 timeline。
  const partial = partialPrs !== false;
  const linkWrite = linkAllowed === null || linkAllowed === undefined ? macMiniStopped(dir) : linkAllowed === true;
  // 授权清单缺文件时 readAuthorizedRepos 返回 []（什么都不写），与整盘 --write 同一口径，不猜默认值。
  const authorized = Array.isArray(allowRepos) ? allowRepos : readAuthorizedRepos(path.join(dir, 'authorized-repos.json'));
  const allowSet = new Set(authorized.map((name) => String(name).toLowerCase()));

  if (apply && !lockPath) {
    out.write('没有写锁路径：单条写入必须和整盘共用一把锁，这一条不写\n');
    return {
      repo, issue: number, reason: '', written: 0, planned: 0, mode, skipped: 'no-lock-path', ok: false,
      partialPrs: partial, linkAllowed: linkWrite,
    };
  }

  async function runOne() {
    const base = {
      repo,
      issue: number,
      reason: '',
      cost: null,
      written: 0,
      planned: 0,
      mode,
      partialPrs: partial,
      linkAllowed: linkWrite,
    };

    // 额度闸：与整盘 prio-run 同一个组件名（同一份预算），不另开后门。
    const hostFiles = rateFile || budgetFile ? null : hostFilesFromEnv(env);
    const rateStateFile = rateFile || hostFiles?.rateState || null;
    const budgetCfg = budgetFile || hostFiles?.rateBudgetConfig || null;
    let rate = { allowed: true, enabled: false, reason: '', state: null };
    if (!rateStateFile) {
      out.write('额度闸未启用：没设 ACCEPTANCE_WATCHER_HOME，也没有显式给出额度状态文件\n');
    } else {
      try {
        let conf = budgets;
        if (!conf && budgetCfg) {
          try {
            conf = readBudgetFile(budgetCfg);
          } catch (error) {
            out.write(`额度预算配置无法使用：${error?.message || error}\n`);
          }
        }
        const gate = decideTick({
          component: 'prio-run',
          purpose: 'board',
          state: readRateState(rateStateFile),
          now,
          budgets: conf,
          cost: 0,
          reserve: ITEM_READ_RESERVE,
        });
        writeRateState(rateStateFile, gate.state);
        if (gate.log) out.write(`${gate.log}\n`);
        rate = { allowed: gate.allowed, enabled: true, reason: gate.reason || '', state: gate.state };
      } catch (error) {
        // 与 prio-run 同一口径（#247 复审 P2-a）：判定或写状态自己出错就放行 + 留痕，不算静默 fail-open。
        out.write(
          `${new Date(now).toISOString()} rate-unknown component=prio-run identity=user remaining=unknown reason=rate-gate-error ${error?.message || error} 判定或写状态出错，这一条照常跑\n`,
        );
        rate = { allowed: true, enabled: true, reason: 'rate-gate-error', state: null };
      }
    }
    if (!rate.allowed) {
      out.write('额度不够：这一条不读也不写，留给下一拍\n');
      return { ...base, skipped: 'rate-budget', rateReason: rate.reason };
    }

    // 每小时写入上限与每拍上限：与整盘共用 changes.jsonl 与 run.json，不自己再算一套。
    const maxPerTick = resolveMaxPerTick({ file: path.join(dir, 'run.json') });
    const hourlyUsed = countRecentChanges(readChangeLog(dir), now, PRIO_HOURLY_WINDOW_MS);
    const hourlyRoom = Math.max(0, PRIO_HOURLY_MAX - hourlyUsed);
    const quota = Math.min(maxPerTick, hourlyRoom);

    const loaded = await loadOneItem(reader, { repo, issue: number, profile, table });
    base.reason = loaded.reason;
    base.cost = loaded.cost;
    // 读回来才知道实际点数；没带回来按一次只读请求的估计记，不当 0。
    if (rate.enabled && rate.state) {
      try {
        const spent = Number.isFinite(loaded.cost) ? loaded.cost : GRAPHQL_COST_PER_REQUEST;
        writeRateState(rateStateFile, chargeBudget(rate.state, { component: 'prio-run', cost: spent, now }));
      } catch (error) {
        out.write(`额度记账失败（不影响这一条）：${error?.message || error}\n`);
      }
    }
    if (!loaded.item) return base;

    const skips = [];
    const verdicts = new Map();
    const gate = async (plan) => {
      const rows = Array.isArray(plan) ? plan : [];
      for (const change of rows) {
        const verdict = singleItemVerdict(change, { allowSet, table, partialPrs: partial, linkAllowed: linkWrite });
        verdicts.set(changeKey(change), verdict);
        if (verdict.decision !== 'write') skips.push({ field: change.field, kind: verdict.kind, reason: verdict.reason });
      }
      let userAllowed = null;
      if (typeof onPlan === 'function') {
        const decided = await onPlan(plan);
        if (decided?.abort) return { abort: true, reason: decided.reason || '' };
        if (typeof decided?.allow === 'function') userAllowed = decided.allow;
      }
      return {
        allow(change, context) {
          const found = verdicts.get(changeKey(change));
          if (!found || found.decision !== 'write') return 'skip';
          const used = Number(context?.written) || 0;
          if (used >= quota) {
            skips.push({
              field: change.field,
              kind: found.kind,
              reason: hourlyRoom <= maxPerTick ? 'hourly-limit' : 'per-tick-limit',
            });
            return 'skip';
          }
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
      nowMs: now,
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
    const shrunk = skips.filter((row) => row.reason === 'link-shrink').length;
    if (shrunk > 0) {
      out.write(`关联 PR 不回退：${shrunk} 条只看到部分 PR，本拍不写\n`);
    }
    const hourly = skips.filter((row) => row.reason === 'hourly-limit').length;
    if (hourly > 0) out.write(`每小时写入上限到了（已用 ${hourlyUsed} 条，上限 ${PRIO_HOURLY_MAX}）：${hourly} 条留给下一拍\n`);
    return {
      ...base,
      ...result,
      shrinkSkipped: shrunk,
      skippedByPolicy: skips,
      policySkipped: skips.length,
      hourlyUsed,
      hourlyRoom,
      quota,
    };
  }

  if (!apply) return runOne();
  const got = await withWriteLock(runOne, { file: lockPath, ...(lockOptions || {}) });
  if (!got.acquired) {
    out.write(`写锁被占（${got.detail || got.reason}）：这一条不读也不写，留给下一次事件或 30 分钟整盘\n`);
    return {
      repo,
      issue: number,
      reason: '',
      written: 0,
      planned: 0,
      mode,
      skipped: 'lock-busy',
      lock: got.detail || got.reason,
      ok: false,
      partialPrs: partial,
      linkAllowed: linkWrite,
    };
  }
  return got.value;
}

/**
 * 事件适配层（#318 event-run 调用）：把 `syncOne({repo, issue, ref, event, source, linkAllowed, now})`
 * 补成 syncOneItem 需要的参数。ctx 可选，缺项按部署默认值补：
 * - dir：ctx.dir → defaultStateDir()；profile：ctx.profile → loadAcceptanceProfile()；
 * - apply 固定 true（event-run 只在 --write 时调到这里）；nowMs：payload.now → ctx.now() → Date.now()；
 * - allowRepos：ctx.allowRepos → <stateDir>/authorized-repos.json；
 * - linkAllowed：payload.linkAllowed → 缺省看 <stateDir>/mac-mini-stopped；标记不在时「关联 PR」一律不写；
 * - lockPath：ctx.lockPath → /tmp/prio-write.lock（与整盘同一把）。
 * 返回值：{ ok, repo, issue, ref, written, planned, skipped, reason, cost, mode, partialPrs, linkAllowed }。
 * ok 的约定（调用方据此决定要不要 ack）：
 * - 真的没什么可写（不在看板、字段没变、被写策略整条挡下）→ ok:true，可以 ack；
 * - 应该写但一条也没写成（抢不到写锁、回读不一致、写闸出错）→ ok:false，调用方不要 ack，留到下回；
 * - 停写开关打开（mode==='disabled'）→ ok:true，故意不写，ack 掉不让 Worker 反复重投。
 */
export async function syncEventItem(payload = {}, ctx = {}) {
  const repo = String(payload.repo || '');
  const issue = Number(payload.issue);
  const ref = payload.ref == null || payload.ref === '' ? `${repo}#${issue}` : String(payload.ref);
  if (ref.toLowerCase() !== `${repo}#${issue}`.toLowerCase()) {
    throw new Error(`ref 与 repo#issue 不一致：ref=${showActual(ref)} repo#issue=${repo}#${showActual(issue)}`);
  }
  const dir = ctx.dir || defaultStateDir();
  const profile = ctx.profile || loadAcceptanceProfile();
  const nowMs = Number.isFinite(payload.now) ? Number(payload.now) : (typeof ctx.now === 'function' ? ctx.now() : Date.now());
  const stdout = ctx.stdout || { write() {} };
  const table = ctx.table || readRepoClassTable(path.join(dir, 'repo-class.json'));
  const reader = ctx.reader || createReadGithub({ profile, run: ctx.run, fetchImpl: ctx.fetchImpl });
  const linkAllowed = payload.linkAllowed === undefined || payload.linkAllowed === null
    ? macMiniStopped(dir)
    : payload.linkAllowed === true;
  let write = ctx.write || null;
  if (!write) {
    const token = ctx.readToken ? ctx.readToken() : readPriorityWriterToken(priorityTokenPath());
    const writer = createPriorityGithub({ profile, token, run: ctx.run, fetchImpl: ctx.fetchImpl });
    write = (action) => writer.write(action);
  }
  const result = await syncOneItem({
    repo,
    issue,
    dir,
    apply: true,
    nowMs,
    profile,
    reader,
    write,
    readBack: ctx.readBack,
    stdout,
    table,
    onlyField: ctx.onlyField || null,
    partialPrs: true,
    allowRepos: ctx.allowRepos ?? null,
    linkAllowed,
    lockPath: ctx.lockPath || WRITE_LOCK_FILE,
    lockOptions: ctx.lockOptions || null,
    rateFile: ctx.rateFile || null,
    budgetFile: ctx.budgetFile || null,
    budgets: ctx.budgets || null,
    env: ctx.env,
  });
  const written = Number(result.written) || 0;
  const planned = Number(result.planned) || 0;
  const policySkipped = Number(result.policySkipped) || 0;
  const skippedByPolicy = Array.isArray(result.skippedByPolicy) ? result.skippedByPolicy : [];
  // 真正「该写却没写成」的条数：计划里的条数减掉被写策略挡下的。
  const pending = Math.max(0, planned - policySkipped);
  let ok = true;
  let reason = result.skipped || result.reason || '';
  if (result.skipped === 'lock-busy' || result.skipped === 'no-lock-path') {
    ok = false;
  } else if (result.mode === 'disabled') {
    reason = 'disabled';
  } else if (result.readbackMismatch) {
    ok = false;
    reason = 'readback-mismatch';
  } else if (written === 0 && pending > 0) {
    ok = false;
    reason = reason || 'not-written';
  } else if (reason === '' && skippedByPolicy.length > 0 && written < planned) {
    // 被写策略挡下时把第一条的真实原因带出去（#324 SC1）：整条挡下是 written===0，
    // 部分挡下（额度到顶、只写了前几条）同样要让日志看见为什么剩下的没写。
    // 已有 reason（lock-busy / disabled / readback-mismatch 等）不覆盖，ok 判定不变。
    reason = String(skippedByPolicy[0]?.reason || '');
  }
  return {
    ok,
    repo,
    issue,
    ref,
    written,
    planned,
    skipped: policySkipped,
    skippedByPolicy,
    reason,
    cost: result.cost ?? null,
    mode: result.mode || '',
    partialPrs: true,
    linkAllowed,
  };
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
    partialPrs: deps.partialPrs ?? true,
    allowRepos: deps.allowRepos ?? null,
    linkAllowed: deps.linkAllowed ?? null,
    // 真写默认抢整盘那把锁；路径可注入，测试不和部署抢同一份。
    lockPath: wantWrite ? (deps.lockPath || WRITE_LOCK_FILE) : null,
    lockOptions: deps.lockOptions || null,
    rateFile: deps.rateFile || null,
    budgetFile: deps.budgetFile || null,
    budgets: deps.budgets || null,
    env: deps.env,
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
