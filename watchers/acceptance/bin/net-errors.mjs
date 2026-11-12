#!/usr/bin/env node
// 网络类错误文本的唯一分类表（#238）：瞬时故障、限流、App 回退、可重试判定都用这里的规则；
// 验收机代码（bin/github.mjs、host/tick.mjs、bin/checks.mjs、host/slack-notify.mjs 等）和仓外的看守、
// 体检脚本都按它判断，不再各写一套关键词。只做分类：不重试、不 sleep。仓外脚本调用命令行入口：
//   printf '%s' "<错误文本>" | node watchers/acceptance/bin/net-errors.mjs --classify
//   → {"transient":true,"category":"truncated-json"}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 业务拒绝：权限、找不到、写闸没登记的查询。先认它们，正文里碰巧出现的数字（比如 issue #502）不能把它们变成瞬时。
const NOT_NETWORK = /\bHTTP 4\d\d\b|\bquery-not-allowed\b|\bNOT_FOUND\b|Bad credentials|Resource not accessible/i;

// 顺序即优先级：同一段文字命中多类时取第一类。
const RULES = [
  ['http-5xx', /\bHTTP 50[234]\b|\b50[234] (?:Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i],
  ['truncated-json', /unexpected end of JSON input/i],
  ['invalid-utf8', /invalid UTF-8/i],
  ['eof', /unexpected EOF|(?:^|\s)EOF\s*$/],
  ['conn-reset', /ECONNRESET|connection reset|reset by peer|\bstream error\b/i],
  ['timeout', /ETIMEDOUT|i\/o timeout|TLS handshake timeout|timed out|\bAbortError\b|operation was aborted/i],
  ['dns', /EAI_AGAIN|ENOTFOUND|Could not resolve host/i],
  ['exit-124', /退出码 124|\bexit(?: code)? 124\b/i],
];

// 只读 GraphQL 响应被截断时统一用这句话交给分类表；github.mjs 不再自己留一份。
const TRUNCATED_JSON = 'unexpected end of JSON input';
const TRUNCATED_JSON_PATTERN = new RegExp(TRUNCATED_JSON, 'i');

// 判断环境问题时也要认这些网络原因；连接被拒不重试，但确实不是代码失败。
const EXTRA_NETWORK_SIGNAL = /ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|socket hang up/i;

// App 令牌读失败时的回退类别：鉴权 / 权限 / 仓不可见。具体文案只在这里维护。
const APP_FALLBACK_RULES = [
  ['auth-401', /\bHTTP 401\b|Bad credentials|Authentication failed|could not read Username|returned error: 401\b/i],
  ['auth-403', /\bHTTP 403\b|Resource not accessible by integration|\bFORBIDDEN\b|returned error: 403\b|Permission to [^\n]* denied/i],
  ['not-found', /\bHTTP 404\b|Could not resolve to a (Repository|node)|\bNOT_FOUND\b|returned error: 404\b|Repository not found/i],
];

const TIMEOUT_ERROR_NAME = /^(?:TimeoutError|AbortError)$/i;

const MAX_TEXT = 256 * 1024;

function textOf(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return [input.name, input.code, input.message].filter(Boolean).join(' ');
  if (typeof input === 'object') return `${input.stderr ?? ''}\n${input.stdout ?? ''}\n${input.message ?? ''}`;
  return String(input);
}

/** 只看开头和结尾各 256 KB：错误信息都很短，超长输出（整页响应）也要在常数时间里分完。 */
function clip(text) {
  return text.length > 2 * MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n${text.slice(-MAX_TEXT)}` : text;
}

/**
 * 输入：`{code, stdout, stderr}`、Error 或文本。输出：`{transient, category}`。
 * code 0 是成功（不是错误）；退出码 124 是读超时被掐掉。
 */
export function classifyNetError(input) {
  if (input && typeof input === 'object' && !(input instanceof Error) && input.code === 0) return { transient: false, category: null };
  const text = clip(textOf(input));
  if (NOT_NETWORK.test(text)) return { transient: false, category: null };
  if (input && typeof input === 'object' && input.code === 124) return { transient: true, category: 'exit-124' };
  for (const [category, pattern] of RULES) {
    if (pattern.test(text)) return { transient: true, category };
  }
  return { transient: false, category: null };
}

/** 只读响应正文是否在末尾被截断（不同 Node 版本的报错文字不同）。 */
export function isTruncatedJsonError(message, body = '') {
  const text = String(message ?? '');
  const at = Number(/at position (\d+)/.exec(text)?.[1]);
  return TRUNCATED_JSON_PATTERN.test(text) || (Number.isFinite(at) && at >= String(body ?? '').trimEnd().length - 1);
}

/** 截断正文统一写成分类表认得的固定说法。 */
export function truncatedJsonMessage(message) {
  return `${TRUNCATED_JSON}（响应被截断：${message}）`;
}

/** 这段文字是不是网络/连接故障（含不重试的连接被拒），给环境原因判断用。 */
export function hasNetworkSignal(input) {
  const text = clip(textOf(input));
  if (EXTRA_NETWORK_SIGNAL.test(text)) return true;
  return RULES.some(([, pattern]) => pattern.test(text));
}

/** Slack 等 fetch 路径的 AbortSignal.timeout 错误名；只在这里认这两个名字。 */
export function isTimeoutErrorName(name) {
  return TIMEOUT_ERROR_NAME.test(String(name ?? ''));
}

/** GitHub 限流文案 / GraphQL RATE_LIMITED 错误码。 */
export function isRateLimitText(input) {
  const text = clip(textOf(input));
  if (/\bRATE_LIMITED\b/.test(text)) return true;
  if (/\b429\b/.test(text) && /rate limit|too many requests/i.test(text)) return true;
  if (/\b403\b/.test(text) && /rate limit/i.test(text)) return true;
  if (/API rate limit already exceeded|rate limit exceeded|secondary rate limit/i.test(text)) return true;
  return false;
}

/** App 令牌回退类别；返回 auth-401 / auth-403 / not-found 或 null。 */
export function classifyAppFallback(input) {
  const text = clip(textOf(input));
  for (const [kind, pattern] of APP_FALLBACK_RULES) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

/** prio-run 这一类“同一拍可以再试”的 GitHub 文本：业务 NOT_FOUND 或任何 5xx。 */
export function isRetriableGithubErrorText(input) {
  const text = clip(textOf(input));
  return /\bNOT_FOUND\b/.test(text) || /\bHTTP\s+5\d\d\b/.test(text);
}

function usage() {
  return '用法：printf \'%s\' "<错误文本>" | node watchers/acceptance/bin/net-errors.mjs --classify\n'
    + '输出一行 JSON：{"transient":<是否可重试>,"category":<类别或 null>}\n';
}

export function main(argv = process.argv.slice(2), { stdin = 0, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length !== 1 || argv[0] !== '--classify') {
    stderr.write(usage());
    return 2;
  }
  let text = '';
  try {
    text = fs.readFileSync(stdin).toString('utf8');
  } catch {
    text = '';
  }
  stdout.write(`${JSON.stringify(classifyNetError(text))}\n`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) process.exitCode = main();
