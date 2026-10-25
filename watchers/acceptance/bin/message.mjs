#!/usr/bin/env node
// 派发消息：把这一轮验收需要的接口约定写给人（agent）看。
// 只接收任务字段，不接收 profile，因此不包含令牌文件、状态目录、检出目录或任何绝对路径。
const ISSUE_PATTERN = /^[^/\s]+\/[^#\s]+#\d+$/;
const BODY_VERSION_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COMMENT_ID_PATTERN = /^[0-9A-Za-z_-]+$/;
const KINDS = new Set(['parent', 'standalone']);

export const SESSION_DOC = 'watchers/acceptance/SESSION.md';

const FIRST_SENTENCE = `先读 ${SESSION_DOC}，照里面的步骤做完这一轮验收。`;

function fail(message) {
  throw new Error(`派发消息字段无效：${message}`);
}

function checkCommentId(commentId) {
  if (commentId === undefined || commentId === null || commentId === '') {
    fail('缺少轮次评论 id');
  }
  if (typeof commentId === 'number') {
    if (!Number.isInteger(commentId) || commentId <= 0) fail('轮次评论 id 应为正整数');
    return String(commentId);
  }
  if (typeof commentId !== 'string' || !COMMENT_ID_PATTERN.test(commentId)) {
    fail('轮次评论 id 应为正整数或非空 id 字符串');
  }
  return commentId;
}

const ITEM_REF_PATTERN = /^[\w.-]+\/[\w.-]+#\d+$/;
const RULINGS = new Set(['成立', '不成立']);

/**
 * 宿主只读裁决运行的结果（#46 SC8），可选：`{ round, items: [{ ref, sc, ruling, why }] }`。
 * 结果文件在宿主状态目录里（沙箱里看不到），所以把内容直接写进消息；理由压成一行、最多 500 字。
 */
function adjudicationLines(adjudication) {
  if (adjudication === undefined || adjudication === null) return [];
  const { round, items } = adjudication;
  if (!Number.isInteger(round) || round <= 0) fail('裁决结果的轮次应为正整数');
  if (!Array.isArray(items) || items.length === 0) fail('裁决结果应至少有一条');
  const lines = ['', `裁决结果（第 ${round} 轮的有争议条目，宿主只读裁决运行给出）：`];
  for (const item of items) {
    if (!item || typeof item.ref !== 'string' || !ITEM_REF_PATTERN.test(item.ref)) fail('裁决结果的 ref 应为 owner/repo#编号');
    if (!Number.isInteger(item.sc) || item.sc <= 0) fail('裁决结果的 SC 应为正整数');
    if (!RULINGS.has(item.ruling)) fail('裁决结果只能是「成立」或「不成立」');
    const why = String(item.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    lines.push(`- ${item.ref} SC${item.sc}：${item.ruling}${why ? ` · 理由：${why}` : ''}`);
  }
  lines.push(`按裁决定这些条目（${SESSION_DOC} 第 3 节）：成立 = 要修，不成立 = 通过并在证据里引用裁决；不要再标「有争议」。`);
  return lines;
}

/** 生成一轮验收的派发消息（中文）。字段不合法直接抛错。 */
export function buildDispatchMessage({ issue, kind, round, commentId, bodyVersion, adjudication } = {}) {
  if (typeof issue !== 'string' || !ISSUE_PATTERN.test(issue)) {
    fail('issue 应为 owner/repo#编号');
  }
  if (!KINDS.has(kind)) fail('kind 只能是 parent 或 standalone');
  if (!Number.isInteger(round) || round <= 0) fail('轮次应为正整数');
  const comment = checkCommentId(commentId);
  if (typeof bodyVersion !== 'string' || !BODY_VERSION_PATTERN.test(bodyVersion)) {
    fail('正文版本应为 sha256:<64 位小写十六进制>');
  }

  return [
    FIRST_SENTENCE,
    '',
    '接口约定：',
    `issue：${issue}`,
    `kind：${kind}`,
    `轮次：第 ${round} 轮`,
    `轮次评论 id：${comment}`,
    `正文版本：${bodyVersion}`,
    `步骤文档：${SESSION_DOC}`,
    ...adjudicationLines(adjudication),
    '',
    '规则：',
    `- 每一条写操作都走 node watchers/acceptance/bin/helper.mjs <cmd> --issue ${issue} --round ${round}，不要直接调 gh 或改本地文件。`,
    '- 每做完一步就把进度写回去，最后一步写 done。',
    '- 只按步骤文档做这一轮，不要顺手做别的事。',
  ].join('\n');
}

/**
 * 宿主预取的代码（#47 SC11）：host/round.mjs 认领之后把每个仓的 main 检出到本轮目录、只读挂进沙箱，
 * 再用这个函数把路径接到派发消息后面。路径是沙箱里能直接用的绝对路径（本轮目录），不含令牌、状态目录。
 * `code` 为 [{repo, path, head}]；空数组原样返回消息。
 */
export function appendCodePaths(message, code = []) {
  if (!Array.isArray(code) || code.length === 0) return message;
  const lines = ['', '代码（宿主已检出各仓 main，只读）：'];
  for (const entry of code) {
    if (typeof entry?.repo !== 'string' || typeof entry?.path !== 'string' || !entry.path.startsWith('/')) {
      fail('代码路径应为 {repo, path(绝对路径)}');
    }
    const head = typeof entry.head === 'string' && /^[0-9a-f]{7,64}$/.test(entry.head) ? `（main @ ${entry.head.slice(0, 12)}）` : '';
    lines.push(`- ${entry.repo}：${entry.path}${head}`);
  }
  lines.push('- 需要可写副本（装依赖、跑会写文件的测试）时复制到 $TMPDIR 再用；沙箱里没有凭证，不要 git clone。');
  return `${String(message).replace(/\n+$/, '')}\n${lines.join('\n')}`;
}
