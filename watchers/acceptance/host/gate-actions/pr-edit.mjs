// 写闸动作：改修正 PR 的正文（#171，方案 A）。修正 PR 以 Draft 开，开的时候「验收对照」只能写「待验证」；转 Ready 前要把
// 有证据的状态写回去，才过得了本机 PR 正文检查。这里只放行两处改动：
//   - 「## 验收对照」表里每一行的状态列和证据列（验收项那一列、行数、表头、分隔行都不许动）；
//   - 「## 未执行的验证」这一段的内容。
// 其余一个字都不许变：首行「任务 issue：」、Closes 行、修正标记行、其它各段、段落标题和顺序。
// 改动的文字里也不许新写「Closes/Fixes/Resolves #号」这类关单词（GitHub 认正文任意位置）、修正标记和「任务 issue」行：
// 不然改个证据就能在合并时顺手关掉别的 issue，或者让写闸认错修正标记。
// 不改标题、head、base；只给 auto / fork 档。修正轮绑定、本轮分支、账本、执行锁由写闸外层核对。
export const type = 'pr.edit';
export const tiers = Object.freeze(['auto', 'fork']);

export const EDITABLE_SECTIONS = Object.freeze(['验收对照', '未执行的验证']);
const STATUSES = new Set(['待验证', '通过', '未通过', '人工手测']);
const MAX_BODY = 65536;
const FORBIDDEN_KEYS = ['title', 'head', 'base', 'branch', 'draft', 'state'];
// 关单词 + 引用（#号、owner/repo#号、issue / PR 链接）。宽一点比漏一点安全：分隔可以跨行、可以有冒号（半角全角）、
// 尖括号、圆括号；链接可以不带 https、可以带 www。比对前先去掉 Markdown 的 * _ ` ~，包住关键字也认得出。
const CLOSING = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[\s:：<(\[]*((?:[\w.-]+\/[\w.-]+)?#\d+|(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s)>\]]+\/(?:issues|pull)\/\d+)/gi;
const MARKER = /\[验收机\]\s*修正/g;
const TASK_LINE = /任务\s*issue\s*[:：]/gi;
const plain = (text) => String(text ?? '').replace(/[*_`~]/g, '').replace(/\u200b|\u200c|\u200d|\ufeff/g, '');
const closingRefs = (text) => new Set([...plain(text).matchAll(CLOSING)].map((match) => match[0].toLowerCase().replace(/\s+/g, ' ')));
const countOf = (text, pattern) => [...plain(text).replace(/\s+/g, ' ').matchAll(pattern)].length;

export function check(action, { tier } = {}) {
  if (!tiers.includes(tier)) return { ok: false, reason: 'tier-not-allowed' };
  if (!action || typeof action.repo !== 'string' || !action.repo) return { ok: false, reason: 'bad-action' };
  if (!Number.isInteger(Number(action.pr)) || Number(action.pr) <= 0) return { ok: false, reason: 'bad-action' };
  if (typeof action.body !== 'string' || !action.body || action.body.length > MAX_BODY) return { ok: false, reason: 'bad-action' };
  if (FORBIDDEN_KEYS.some((key) => Object.hasOwn(action, key))) return { ok: false, reason: 'field-not-editable' };
  return { ok: true };
}

export function toWrite(action) {
  return { type, repo: action.repo, pr: Number(action.pr), body: action.body };
}

const lines = (text) => String(text ?? '').split('\n').map((line) => line.replace(/\r$/, ''));

/** 按「## 」切段：prefix 是第一个二级标题之前的部分。 */
function sectionsOf(text) {
  const out = { prefix: [], sections: [] };
  let current = null;
  for (const line of lines(text)) {
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1], body: [] };
      out.sections.push(current);
    } else if (current) current.body.push(line);
    else out.prefix.push(line);
  }
  return out;
}

const cellsOf = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
const isDataRow = (line) => /^\s*\|/.test(line) && !/^\s*\|\s*:?-{2,}/.test(line) && !/^\s*\|\s*验收项\s*\|/.test(line);

// 整篇对比，不只看这一次新增的行（审查 P2：两次 pr.edit 可以把「Closes」和下一行的「#999」拼起来）：
// 新正文里出现了旧正文没有的关单词引用、修正标记或「任务 issue」行，就拒绝。改不了的地方逐字相同，多出来的只能来自可改的两处。
function introducedProblem(oldBody, newBody) {
  const before = closingRefs(oldBody);
  if ([...closingRefs(newBody)].some((ref) => !before.has(ref))) return 'closing-keyword';
  if (countOf(newBody, MARKER) > countOf(oldBody, MARKER)) return 'correction-marker';
  if (countOf(newBody, TASK_LINE) > countOf(oldBody, TASK_LINE)) return 'task-issue-line';
  return null;
}

function sameLines(a, b) {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * 新正文相对旧正文只改了允许的地方：返回 { ok: true } 或 { ok: false, reason, detail }。
 * reason：outside-editable（改了别的段 / 首几行 / 标题）、table-shape（验收对照的行数、表头、验收项列变了）、
 * bad-status（状态不是四个之一）、closing-keyword / correction-marker / task-issue-line（改动里新写了这些）。
 */
export function checkBodyEdit(oldBody, newBody) {
  const before = sectionsOf(oldBody);
  const after = sectionsOf(newBody);
  if (!sameLines(before.prefix, after.prefix)) return { ok: false, reason: 'outside-editable', detail: '标题前的几行（任务 issue、Closes）不能改' };
  if (before.sections.length !== after.sections.length
    || before.sections.some((section, index) => section.title !== after.sections[index].title)) {
    return { ok: false, reason: 'outside-editable', detail: '段落标题和顺序不能改' };
  }
  for (let index = 0; index < before.sections.length; index += 1) {
    const { title, body: was } = before.sections[index];
    const now = after.sections[index].body;
    if (!EDITABLE_SECTIONS.includes(title)) {
      if (!sameLines(was, now)) return { ok: false, reason: 'outside-editable', detail: `「${title}」段不能改` };
      continue;
    }
    if (title === '未执行的验证') continue;
    // 验收对照：行数不变；非数据行（说明、表头、分隔行）原样；数据行只许改第 2、3 列。
    if (was.length !== now.length) return { ok: false, reason: 'table-shape', detail: '「验收对照」的行数不能变' };
    for (let row = 0; row < was.length; row += 1) {
      if (!isDataRow(was[row]) || !isDataRow(now[row])) {
        if (was[row] !== now[row]) return { ok: false, reason: 'table-shape', detail: '「验收对照」里表格行以外的内容不能改' };
        continue;
      }
      const oldCells = cellsOf(was[row]);
      const newCells = cellsOf(now[row]);
      if (oldCells.length !== newCells.length || oldCells.length < 3 || oldCells[0] !== newCells[0]) {
        return { ok: false, reason: 'table-shape', detail: '只能改状态列和证据列，验收项那一列和列数不能变' };
      }
      if (oldCells.slice(3).join('|') !== newCells.slice(3).join('|')) {
        return { ok: false, reason: 'table-shape', detail: '状态、证据以外的列不能改' };
      }
      if (!STATUSES.has(newCells[1])) return { ok: false, reason: 'bad-status', detail: `状态只能是 待验证 / 通过 / 未通过 / 人工手测，实际：${newCells[1]}` };
    }
  }
  const problem = introducedProblem(oldBody, newBody);
  if (problem) return { ok: false, reason: problem, detail: '改动里不能新写关单词引用、修正标记或「任务 issue」行（按整篇正文比）' };
  return { ok: true };
}
