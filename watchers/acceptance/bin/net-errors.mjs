#!/usr/bin/env node
// 网络类瞬时错误的唯一分类表（#238）。验收机代码（bin/github.mjs、host/tick.mjs）和仓外的看守、体检脚本都按它判断，
// 不再各写一套关键词。只做分类：不重试、不 sleep。仓外脚本调用命令行入口，不 import 部署目录里的文件：
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
