#!/usr/bin/env node
// 内置密钥扫描（#46 SC7 推送前、#47 SC9 写闸）共用：不解析补丁，直接看对象内容。
// 列出范围新引入的每个对象（rev-list --objects <提交> ^<基准>，合并提交带进来的也在里面），
// 再用 cat-file --batch 按字节取出内容逐个扫：二进制 / 含 NUL 的文件、像补丁头的行都不影响。
// 本模块不起进程：调用方把自己的 git 执行器传进来（宿主用 host/proc.mjs，沙箱用 bin/localgit.mjs）。
import { SECRET_PATTERNS } from './redact.mjs';

export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BATCH_SIZE = 500;

/** 一段内容里有没有命中任何密钥模式（只回真假，不回内容）。 */
export function containsSecret(text) {
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(text)) return true;
  }
  return false;
}

function failed(step, result) {
  const detail = String(result?.stderr || '').split('\n')[0].trim() || `退出码 ${result?.code ?? '未知'}`;
  return new Error(`扫密钥时 ${step} 失败：${detail}`);
}

/** rev-list --objects 的输出：每个对象一行「<id>[ <路径>]」。路径里有换行时，续行不以对象号开头，忽略即可。 */
function parseObjectList(text) {
  const objects = new Map();
  for (const line of String(text || '').split('\n')) {
    const space = line.indexOf(' ');
    const id = space === -1 ? line : line.slice(0, space);
    if (!OBJECT_ID.test(id)) continue;
    if (!objects.has(id)) objects.set(id, space === -1 ? '' : line.slice(space + 1));
  }
  return objects;
}

/** cat-file --batch 的输出按字节切：「<id> <类型> <大小>\n<内容>\n」，缺对象就报错（宁可不推）。 */
function* parseBatch(buffer, expected) {
  let pos = 0;
  for (const id of expected) {
    const newline = buffer.indexOf(10, pos);
    if (newline === -1) throw new Error(`扫密钥时 cat-file 输出不完整（${id}）`);
    const header = buffer.toString('latin1', pos, newline);
    const match = /^([0-9a-f]+) (blob|tree|commit|tag) (\d+)$/.exec(header);
    if (!match || match[1] !== id) throw new Error(`扫密钥时对象读不到：${header.slice(0, 80)}`);
    const size = Number(match[3]);
    const start = newline + 1;
    if (start + size > buffer.length) throw new Error(`扫密钥时对象内容不完整（${id}）`);
    yield { id, type: match[2], content: buffer.subarray(start, start + size) };
    pos = start + size + 1;
  }
}

/**
 * 扫 tip 引入、exclude 里任何一个都够不到的全部对象（提交说明、文件内容都扫）。
 * git(args, {input, raw}) → {code, stdout, stderr}；gitDir 是要加在每条命令前的参数（比如 ['--git-dir', bare]）。
 * 返回命中的文件名（提交说明命中记成「（提交说明 <短号>）」），绝不回内容。
 */
export async function scanIntroducedObjects({ git, gitDir = [], tip, exclude = [] }) {
  for (const id of [tip, ...exclude]) {
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) throw new Error('扫密钥的范围只收完整提交号');
  }
  const listed = await git([...gitDir, 'rev-list', '--objects', tip, ...exclude.map((id) => `^${id}`)], {});
  if (!listed || listed.code !== 0) throw failed('rev-list', listed);
  const objects = parseObjectList(listed.stdout);
  const ids = [...objects.keys()];
  const files = new Set();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const read = await git([...gitDir, 'cat-file', '--batch'], { input: `${batch.join('\n')}\n`, raw: true });
    if (!read || read.code !== 0) throw failed('cat-file', read);
    const buffer = Buffer.isBuffer(read.stdout) ? read.stdout : Buffer.from(String(read.stdout || ''), 'latin1');
    for (const { id, type, content } of parseBatch(buffer, batch)) {
      // latin1 一字节对一字符：NUL、非 UTF-8 字节都原样保留，ASCII 的密钥头照样认得出。
      if (!containsSecret(content.toString('latin1'))) continue;
      if (type === 'commit' || type === 'tag') files.add(`（提交说明 ${id.slice(0, 12)}）`);
      else files.add(objects.get(id) || `（对象 ${id.slice(0, 12)}）`);
    }
  }
  return [...files];
}
