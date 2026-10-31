// 关联 PR：给定一批 issue 和一批 PR，算出每个 issue 的文本。
// 纯函数。只看调用方传入的字符串。
//
// 命中：
// - 正文「任务 issue：」行上的 owner/repo#n、issue 链接；这一行没有这两种写法时才取全部裸 #n
//   有完整引用时，仍认顿号或英文逗号并列的裸 #n（「#147、#149」两个都算）
//   括号里的裸 #n 不算（「#147（#148 的补充）」里的 #148 是在说上一个 PR）
// - 行首，或冒号后面，的 Closes / Fixes / Refs（大小写不敏感）之后的 #n、owner/repo#n、issue 链接
// - Resolves、Close、Fixed，以及写在句子中间的关闭字，不算
// - 标题里的 #n 不算；正文其它地方顺手提到的 #n、owner/repo#n、issue 链接不算
// - 分支 acceptance/<号>-<号>-sc<k> 的前两个号（sc 后面的号不算）
// - 分支里的 issue-<号>、issue/<号>、issues/<号>、#<号>
//
// 文本：开着的写成 #n(open,CI✓) 或 #n(open,CI✗)；还没有 CI 结论就写 #n(open)。
// 已合并写成 #n(merged)，已关闭未合并写成 #n(closed)。多个按 PR 号升序，空格隔开。没有命中是空串。

const NAME = '[A-Za-z0-9][A-Za-z0-9_.-]*';
const NUM = '[1-9]\\d*';

const ISSUE_URL = new RegExp(`https?:\\/\\/(?:www\\.)?github\\.com\\/(${NAME})\\/(${NAME})\\/issues\\/(${NUM})\\b`, 'gi');
const EXPLICIT_REF = new RegExp(`(?:^|[^A-Za-z0-9_./])(${NAME})\\/(${NAME})#(${NUM})\\b`, 'g');
const BARE_REF = new RegExp(`(?:^|[^A-Za-z0-9_#/])#(${NUM})\\b`, 'g');
const LIST_BARE = new RegExp(`(?:[、,]\\s*)#(${NUM})\\b`, 'g');
const ACCEPTANCE_BRANCH = new RegExp(`(?:^|\\/)acceptance\\/(${NUM})-(${NUM})-sc${NUM}$`);
const BRANCH_ISSUE = new RegExp(`(?:^|[\\/_.-])issues?[-\\/](${NUM})(?=$|[\\/_.-])`, 'gi');
const BRANCH_HASH = new RegExp(`(?:^|[\\/_.-])#(${NUM})(?=$|[\\/_.-])`, 'g');

function addRef(found, repo, number) {
  const name = String(repo || '').trim();
  const n = Number(number);
  if (!name.includes('/') || !Number.isInteger(n) || n <= 0) return;
  const key = `${name.toLowerCase()}#${n}`;
  if (!found.has(key)) found.set(key, `${name}#${n}`);
}

function splitRef(ref) {
  const hash = ref.lastIndexOf('#');
  return { repo: ref.slice(0, hash), number: Number(ref.slice(hash + 1)) };
}

function compareRef(a, b) {
  const left = splitRef(a);
  const right = splitRef(b);
  return left.repo.localeCompare(right.repo) || left.number - right.number;
}

function comparePr(a, b) {
  return Number(a.number) - Number(b.number) || String(a.repo).localeCompare(String(b.repo));
}

function collectTextRefs(found, text, own, { bare }) {
  const source = String(text || '');
  for (const match of source.matchAll(ISSUE_URL)) addRef(found, `${match[1]}/${match[2]}`, match[3]);
  for (const match of source.matchAll(EXPLICIT_REF)) addRef(found, `${match[1]}/${match[2]}`, match[3]);
  if (bare && own.includes('/')) {
    for (const match of source.matchAll(BARE_REF)) addRef(found, own, match[1]);
  }
}

function isTaskIssueLine(line) {
  return /^\s*任务\s*issue\s*[:：]/i.test(line);
}

/** 行首，或冒号紧后面，才算声明行。返回从关键字开始的那一段。 */
function keywordSpan(line) {
  const atStart = /^\s*(closes|fixes|refs)\b/i.exec(line);
  if (atStart) return line.slice(atStart.index + atStart[0].length - atStart[1].length);
  const afterColon = /[:：]\s*(closes|fixes|refs)\b/i.exec(line);
  if (afterColon) return line.slice(afterColon.index + afterColon[0].length - afterColon[1].length);
  return null;
}

/** 这条 PR 点名的 issue，形如 owner/repo#n，按 repo、再按号排序。同一条只出现一次。 */
export function prIssueRefs(pr) {
  const found = new Map();
  const own = String(pr?.repo || '').trim();
  const body = String(pr?.body || '');
  for (const line of body.split(/\r?\n/)) {
    if (isTaskIssueLine(line)) {
      const explicit = new Map();
      collectTextRefs(explicit, line, own, { bare: false });
      if (explicit.size) {
        for (const [key, value] of explicit) found.set(key, value);
        if (own.includes('/')) {
          for (const match of line.matchAll(LIST_BARE)) addRef(found, own, match[1]);
        }
      } else {
        collectTextRefs(found, line, own, { bare: true });
      }
      continue;
    }
    const span = keywordSpan(line);
    if (span) collectTextRefs(found, span, own, { bare: true });
  }
  if (own.includes('/')) {
    const branch = String(pr?.headRefName || pr?.branch || '').trim();
    const acceptance = ACCEPTANCE_BRANCH.exec(branch);
    if (acceptance) {
      addRef(found, own, acceptance[1]);
      addRef(found, own, acceptance[2]);
    }
    for (const match of branch.matchAll(BRANCH_ISSUE)) addRef(found, own, match[1]);
    for (const match of branch.matchAll(BRANCH_HASH)) addRef(found, own, match[1]);
  }
  return [...found.values()].sort(compareRef);
}

function normalizeState(pr) {
  if (pr?.merged === true) return 'merged';
  const state = String(pr?.state || '').toLowerCase();
  if (state === 'merged') return 'merged';
  if (state === 'closed' || state === 'close') return 'closed';
  if (state === 'open') return 'open';
  return '';
}

function ciMark(ci) {
  const value = String(ci ?? '').trim().toLowerCase();
  if (['pass', 'passed', 'success', 'green', 'ok'].includes(value)) return 'CI✓';
  if (['fail', 'failed', 'failure', 'red', 'error'].includes(value)) return 'CI✗';
  return '';
}

function formatOne(pr) {
  const n = Number(pr.number);
  const state = normalizeState(pr);
  if (state === 'merged') return `#${n}(merged)`;
  if (state === 'closed') return `#${n}(closed)`;
  if (state === 'open') {
    const mark = ciMark(pr.ci);
    return mark ? `#${n}(open,${mark})` : `#${n}(open)`;
  }
  return `#${n}`;
}

function issueKey(issue) {
  const repo = String(issue?.repo || '').trim();
  const number = Number(issue?.number);
  if (!repo.includes('/') || !Number.isInteger(number) || number <= 0) return null;
  const ref = `${repo}#${number}`;
  return { ref, key: ref.toLowerCase() };
}

/**
 * @param {{ issues?: {repo: string, number: number}[], prs?: object[] }} input
 * @returns {Record<string, string>} issue「owner/repo#n」→「关联 PR」文本；没有命中是空串
 */
export function linkedPrField({ issues = [], prs = [] } = {}) {
  const buckets = new Map();
  const order = [];
  for (const issue of issues) {
    const parsed = issueKey(issue);
    if (!parsed || buckets.has(parsed.key)) continue;
    buckets.set(parsed.key, { ref: parsed.ref, prs: [] });
    order.push(parsed.key);
  }

  const seenPr = new Set();
  for (const pr of prs) {
    const number = Number(pr?.number);
    const repo = String(pr?.repo || '').trim();
    if (!repo || !Number.isInteger(number) || number <= 0) continue;
    const prKey = `${repo.toLowerCase()}#${number}`;
    if (seenPr.has(prKey)) continue;
    seenPr.add(prKey);
    for (const ref of prIssueRefs(pr)) {
      const bucket = buckets.get(ref.toLowerCase());
      if (bucket) bucket.prs.push(pr);
    }
  }

  const out = {};
  for (const key of order) {
    const bucket = buckets.get(key);
    out[bucket.ref] = bucket.prs.sort(comparePr).map(formatOne).join(' ');
  }
  return out;
}
