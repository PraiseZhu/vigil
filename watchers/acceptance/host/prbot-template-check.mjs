// 修正 PR 开出前、转 Ready 前的正文检查（#172）：和本机 check-pr-issue.sh、check-pr-body.sh（task-pr/v1，2026-10-26 版）
// 同样的规则，纯 JS 复刻（为什么不调脚本见 docs/acceptance-prbot.md「开 PR / 转 Ready 前的检查」）。
// 只吃文字、吐问题清单：不读环境变量、不碰令牌、不起子进程、不联网；issue 和 PR 正文由调用方用只读通道读来交进来。
// 本机脚本的规则改了要同步改这里，prbot-template-check.test.mjs 里的用例一起改。
// 没复刻的一条：「合并顺序：」行只对本机规则里写死的一个仓生效，本仓公开、不写死仓名，修正 PR 正文也不写这一行。

const REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([0-9]+)$/;
export const ISSUE_HEADINGS = Object.freeze(['## 目标', '## 范围', '## 不做', '## 依赖', '## 验收标准']);
export const PR_SECTIONS = Object.freeze(['改了什么', '范围对照', '验收对照', '定下的决定', '未执行的验证', '风险与回滚']);
export const STATUSES = Object.freeze(['待验证', '通过', '未通过', '人工手测']);
const EMPTY_EVIDENCE = new Set(['', '—', '-', '–', '无']);
const PLACEHOLDERS = Object.freeze([
  '<无 / 等 #PR号',
  '<对应 issue',
  '<文件或模块>',
  '<改了什么>',
  '<issue 原文>',
  '<抄 issue',
  '<无 /',
  '<有具体依据',
  '<issue「待定问题」',
  '<owner/repo>',
]);
// 脚本里的 \b 按 Unicode 算（Python re、GNU grep 的 UTF-8 区域设置）：「SC1导出」里 1 和「导」之间不算词边界。
// JS 的 \b 只认 ASCII，所以用「后面不是字母、数字、下划线」代替。
const WORD_END = '(?![\\p{L}\\p{N}_])';
const ISSUE_SC_LINE = new RegExp(`^\\s*[-*]\\s*(?:\\[[ xX]\\])?\\s*(?:\\*\\*)?SC[0-9]+${WORD_END}`, 'u');
const SC_LINE = new RegExp(`^\\s*[-*]\\s*(?:\\[[ xX]\\])?\\s*(?:\\*\\*)?(SC([0-9]+)${WORD_END}.*)$`, 'u');
const ROW = new RegExp(`^\\|\\s*(?:\\*\\*)?SC([0-9]+)${WORD_END}`, 'u');

// helpers

/** 和 Python str.splitlines() 一样切行：认 \r\n、\r、\n 和其它换行符，结尾的换行不多出一行空行。 */
function splitLines(text) {
  const parts = String(text ?? '').split(/\r\n|[\n\v\f\r\x1c-\x1e\x85\u2028\u2029]/);
  if (parts.length > 1 && parts.at(-1) === '') parts.pop();
  return parts.length === 1 && parts[0] === '' ? [] : parts;
}

const stripComments = (text) => String(text ?? '').replace(/<!--[\s\S]*?-->/g, '');

/** 按标题切段：{标题: 正文}（保持出现顺序，同名标题并进同一段）。只认行首的指定级别标题。 */
function sectionsOf(body, level = '## ') {
  const out = new Map();
  let current = null;
  for (const line of splitLines(body)) {
    if (line.startsWith(level) && !line.startsWith(`${level}#`)) {
      current = line.slice(level.length).trim();
      if (!out.has(current)) out.set(current, []);
    } else if (current !== null) {
      out.get(current).push(line);
    }
  }
  return new Map([...out].map(([title, lines]) => [title, lines.join('\n')]));
}

function sectionByPrefix(sections, prefix) {
  for (const [title, text] of sections) if (title.startsWith(prefix)) return text;
  return null;
}

/** issue「验收标准」（或「整体验收」）里的 SC 编号，按出现顺序。 */
export function selectIssueScs(issueBody) {
  const sections = sectionsOf(stripComments(issueBody));
  const text = sectionByPrefix(sections, '验收标准') || sectionByPrefix(sections, '整体验收') || '';
  const numbers = [];
  for (const line of splitLines(text)) {
    const match = SC_LINE.exec(line);
    if (match) numbers.push(Number(match[2]));
  }
  return numbers;
}

const cellsOf = (line) => line.trim().split(/(?<!\\)\|/).slice(1, -1).map((cell) => cell.trim());

// check-pr-issue.sh

/**
 * 开 PR 前检查关联 issue：格式 owner/repo#号；issue 读得到且开着；正文有子 issue 模板的五个标题；验收标准有 SC<n> 编号项。
 * issue 是只读查询读回来的 { state, body }，读不到传 null。返回问题清单（空数组就是通过）。
 */
export function checkTaskIssue(ref, issue) {
  if (!REF.test(String(ref ?? ''))) return [`关联 issue 必须是 owner/repo#号（实际：「${ref ?? ''}」）`];
  if (!issue) return [`读不到 issue ${ref}（不存在或无权限）`];
  if (issue.state !== 'OPEN') return [`issue ${ref} 要是打开状态（实际：${issue.state ?? '未知'}）`];
  const lines = String(issue.body ?? '').split('\n');
  const problems = [];
  for (const heading of ISSUE_HEADINGS) {
    if (!lines.some((line) => line.startsWith(heading))) problems.push(`issue ${ref} 缺「${heading}」段（子 issue 模板要求五段：${ISSUE_HEADINGS.join('、')}）`);
  }
  if (!lines.some((line) => ISSUE_SC_LINE.test(line))) problems.push(`issue ${ref} 的验收标准没有 SC<n> 编号项（要有「- [ ] SC1 …」这样的行）`);
  return problems;
}

// check-pr-body.sh

/**
 * PR 正文是否逐段对上任务 issue（task-pr/v1）。stage 是 open（开 PR 前）或 ready（转 Ready 前，再查每条 SC 的状态和证据）。
 * 返回问题清单（空数组就是通过），每条写明期望和实际。
 */
export function checkPrBody(body, { issueRef, issueBody, stage }) {
  if (stage !== 'open' && stage !== 'ready') throw new Error(`stage 只能是 open 或 ready（实际：${stage}）`);
  if (!REF.test(String(issueRef ?? ''))) return [`关联 issue 必须是 owner/repo#号（实际：「${issueRef ?? ''}」）`];
  const issueScs = new Set(selectIssueScs(issueBody));
  if (!issueScs.size) return [`issue ${issueRef} 的验收标准没有 SC<n> 编号项，先补齐 issue`];

  const problems = [];
  const text = stripComments(body);
  const lines = splitLines(text).map((line) => line.trim());
  if (!lines.includes(`任务 issue：${issueRef}`)) problems.push(`缺少一行「任务 issue：${issueRef}」`);

  const h2 = sectionsOf(text);
  const full = h2.has('改了什么');
  let scText;
  let unrun;
  if (full) {
    for (const name of PR_SECTIONS) {
      if (!h2.has(name)) problems.push(`缺「## ${name}」段（task-pr/v1 要求：${PR_SECTIONS.join('、')}）`);
      else if (!h2.get(name).trim()) problems.push(`「## ${name}」段是空的，没有内容写「无」`);
    }
    scText = h2.get('验收对照') ?? '';
    unrun = h2.get('未执行的验证') ?? '';
  } else {
    const h3 = sectionsOf(text, '### ');
    scText = h3.get('验收对照');
    if (scText === undefined) {
      scText = '';
      problems.push('目标仓模板的正文里缺「### 验收对照」小节');
    }
    unrun = sectionByPrefix(h3, '未执行的验证') ?? '';
  }

  const rows = new Map();
  for (const line of splitLines(scText)) {
    const match = ROW.exec(line.trim());
    if (match) rows.set(Number(match[1]), cellsOf(line));
  }
  const missing = [...issueScs].filter((n) => !rows.has(n)).sort((a, b) => a - b);
  const extra = [...rows.keys()].filter((n) => !issueScs.has(n)).sort((a, b) => a - b);
  if (missing.length) problems.push(`验收对照缺 issue 里的 ${missing.map((n) => `SC${n}`).join('、')}`);
  if (extra.length) problems.push(`验收对照多出 issue 里没有的 ${extra.map((n) => `SC${n}`).join('、')}（SC 变了先改 issue）`);

  for (const n of [...rows.keys()].sort((a, b) => a - b)) {
    const cells = rows.get(n);
    const status = cells[1] ?? '';
    const evidence = cells[2] ?? '';
    if (!STATUSES.includes(status)) {
      problems.push(`SC${n} 状态是「${status}」，只能是 ${STATUSES.join(' / ')}`);
      continue;
    }
    if (stage !== 'ready') continue;
    if (status === '待验证' || status === '未通过') problems.push(`SC${n} 还是「${status}」，不能转 Ready（要「通过」或「人工手测」）`);
    if (status === '通过' && EMPTY_EVIDENCE.has(evidence)) problems.push(`SC${n} 写了通过但没有证据（实际：「${evidence}」；要写 命令 → 结果 → 日志或 CI 链接）`);
    if (status === '人工手测' && !new RegExp(`(?<![\\p{L}\\p{N}_])SC${n}${WORD_END}`, 'u').test(unrun)) {
      problems.push(`SC${n} 是人工手测，「未执行的验证」里要写谁验、何时验（实际没提到 SC${n}）`);
    }
  }

  if (stage === 'ready' && full) {
    const left = PLACEHOLDERS.filter((placeholder) => text.includes(placeholder));
    if (left.length) problems.push(`还有没填的模板占位：${left.join('、')}`);
  }
  return problems;
}
