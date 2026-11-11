#!/usr/bin/env node
// 部署定时自检（#367）：只读核对验收账户 crontab 里那条规范化部署条目，只告警，不写 cron、不修 cron。
// 覆盖六类边界：缺失、被注释、重复、读取失败、节拍不对、参数不对；不认识的形式报「无法核实」，不判缺失。
// 读取失败与「无 crontab」用退出码 + 确定 stderr 文本区分；判断不了就归读取失败，不当缺失、不吞错误。
// 节奏：首次正常静默；同情形只告警一次；情形变化（分类或错法字段不同）立即再告警一次；真从异常回到正常才发一次恢复。
// 输出不含整份 cron、非目标行、本机绝对路径、凭据：文案只讲结论、出错字段名，不打印命令行原文。
import fs from 'node:fs';
import path from 'node:path';
import { appendAlert, hostPaths } from '../host/paths.mjs';

/** 七必填参数（与部署条目的规范化形状一致）。 */
export const REQUIRED_ARGS = Object.freeze([
  '--deploy-dir',
  '--host-state',
  '--self-lock',
  '--prio-lock',
  '--state-file',
  '--alerts',
  '--doctor-script',
]);

const OK = 'ok';
const MISSING = 'missing';
const COMMENTED = 'commented';
const DUPLICATE = 'duplicate';
const UNREADABLE = 'unreadable';
const BAD_SCHEDULE = 'bad-schedule';
const MISMATCH = 'mismatch';
const UNKNOWN_FORM = 'unknown-form';

export const KINDS = Object.freeze([OK, MISSING, COMMENTED, DUPLICATE, UNREADABLE, BAD_SCHEDULE, MISMATCH, UNKNOWN_FORM]);

/** 只认「整段 stderr 恰好是 no crontab for <用户>」：混入别的错误文本就不算确定，按读取失败处理。 */
const NO_CRONTAB_RE = /^no crontab for \S+$/;

function isNoCrontab(stderr) {
  return NO_CRONTAB_RE.test(String(stderr || '').trim());
}

/** 展开 cron 分钟字段。只支持 *、星号带步长、a、a-b、a-b 带步长和逗号列表；其它写法返回 null（=无法核实）。 */
export function expandMinutes(field) {
  if (typeof field !== 'string' || field === '') return null;
  const out = new Set();
  for (const part of field.split(',')) {
    if (part === '') return null;
    const stepSplit = part.split('/');
    if (stepSplit.length > 2) return null;
    const [range, stepRaw] = stepSplit;
    if (stepRaw !== undefined && !/^\d+$/.test(stepRaw)) return null;
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1 || step > 59) return null;
    let lo;
    let hi;
    if (range === '*') {
      lo = 0;
      hi = 59;
      if (stepRaw === undefined) for (let i = lo; i <= hi; i += 1) out.add(i);
    } else if (/^\d+$/.test(range)) {
      lo = Number(range);
      hi = stepRaw === undefined ? lo : 59;
    } else if (/^\d+-\d+$/.test(range)) {
      const [a, b] = range.split('-').map(Number);
      lo = a;
      hi = b;
    } else return null;
    if (lo > hi || hi > 59) return null;
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  if (out.size === 0) return null;
  return [...out].sort((a, b) => a - b);
}

/**
 * 校验节拍：每小时都要覆盖，相邻间隔（含跨小时回绕）不超过 5 分钟。
 * 返回 null 表示合格，否则返回问题码（无法核实的语法单列）。
 */
export function checkSchedule(fields) {
  if (!Array.isArray(fields) || fields.length !== 5) return 'schedule-fields';
  const [minute, hour, day, month, dow] = fields;
  const minutes = expandMinutes(minute);
  if (!minutes) return 'schedule-syntax';
  for (const field of [hour, day, month, dow]) if (field !== '*') return 'schedule-scope';
  const slots = [...minutes, minutes[0] + 60];
  for (let i = 1; i < slots.length; i += 1) if (slots[i] - slots[i - 1] > 5) return 'schedule-gap';
  return null;
}

/** 极简词法：按空白切分，去掉成对的外层引号。不实现变量展开、管道、重定向还原（那不是本工具的事）。 */
/** 只看文件名：用来区分「像目标但写法不认」与「根本没有」，不做子串匹配。 */
function plausible(lines, expectScript) {
  const base = path.basename(expectScript);
  if (!base) return false;
  return lines.some((line) => {
    const body = line.trim().replace(/^#+\s*/, '');
    if (!body || body.includes(expectScript)) return false;
    return tokenize(body).some((token) => path.basename(token.replace(/["']/g, '')) === base);
  });
}

function tokenize(line) {
  return line
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((token) => (/^(['"]).*\1$/.test(token) ? token.slice(1, -1) : token));
}

const IGNORED_TOKEN = /^(?:<|>|>>|\d?>>|<&|\d?>&)$/;

/** 从命令段里取「--flag value」对；返回值、未识别 token 列表和解释器 token 下标。 */
function parseArgs(tokens, scriptIndex) {
  const values = new Map();
  const unknown = [];
  let index = scriptIndex + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (/^--[a-z0-9-]+$/.test(token)) {
      const next = tokens[index + 1];
      if (next === undefined || /^--[a-z0-9-]+$/.test(next)) {
        values.set(token, null);
        index += 1;
        continue;
      }
      values.set(token, next);
      index += 2;
      continue;
    }
    if (/^<\/dev\/null$/.test(token) || /^\d?>>?[^ ]+$/.test(token) || IGNORED_TOKEN.test(token)) {
      index += 1;
      continue;
    }
    unknown.push('trailing');
    index += 1;
  }
  return { values, unknown };
}

/**
 * 规范路径：默认用 fs.realpathSync，测试可注入 statics.realpath 覆盖。
 * 解析不出来（文件不存在、权限不够）返回 null：那种情况不能断言「就是这条」，后面按无法核实报。
 */
function resolveReal(statics, file) {
  if (typeof statics?.realpath === 'function') return statics.realpath(file);
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

/** 找目标候选行：脚本路径 token 的 realpath 必须等于期望脚本的 realpath（符号链接、等价路径都算同一条）。 */
function candidatesFrom(lines, expectScript, statics) {
  const expectedReal = resolveReal(statics, expectScript);
  const same = (token) => {
    if (expectedReal === null) return token === expectScript;
    return resolveReal(statics, token) === expectedReal;
  };
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const commented = trimmed.startsWith('#');
    const body = commented ? trimmed.replace(/^#+\s*/, '') : trimmed;
    const tokens = tokenize(body);
    let scriptIndex = -1;
    for (let k = 0; k < tokens.length; k += 1) if (same(tokens[k])) { scriptIndex = k; break; }
    if (scriptIndex < 0) continue;
    found.push({ line: i + 1, commented, tokens, scriptIndex });
  }
  return found;
}

/**
 * 判一条目标条目的结构。返回 { kind, detail }，detail 是稳定的错误键（进指纹），不含路径。
 */
function inspectCandidate(candidate, expect, statics) {
  const { tokens, scriptIndex } = candidate;
  const schedule = tokens.slice(0, 5);
  const scheduleProblem = checkSchedule(schedule);
  if (scheduleProblem === 'schedule-syntax') return { kind: UNKNOWN_FORM, detail: 'schedule-syntax' };
  if (scheduleProblem) return { kind: BAD_SCHEDULE, detail: scheduleProblem };
  const interpreter = tokens[scriptIndex - 1];
  if (!interpreter) return { kind: UNKNOWN_FORM, detail: 'no-interpreter' };
  const { values, unknown } = parseArgs(tokens, scriptIndex);
  if (unknown.length) return { kind: UNKNOWN_FORM, detail: `extra-tokens:${unknown.length}` };
  const bad = [];
  for (const flag of REQUIRED_ARGS) {
    if (!values.has(flag)) bad.push(`${flag}:absent`);
    else if (values.get(flag) === null) bad.push(`${flag}:no-value`);
    else if (expect.args[flag] !== undefined && values.get(flag) !== expect.args[flag]) bad.push(`${flag}:value`);
  }
  if (bad.length) return { kind: MISMATCH, detail: bad.sort().join(',') };
  if (typeof statics?.isExecutable === 'function' && !statics.isExecutable(interpreter)) {
    return { kind: MISMATCH, detail: 'interpreter:not-executable' };
  }
  return { kind: OK, detail: '' };
}

/**
 * 判整体结论。纯函数：crontab 文本、退出码、stderr、期望值、本机事实都从参数来，不读真实系统。
 * 「无 crontab」与「读取失败」严格分开：只有确定文本才算空，其余一律 unreadable（不吞错误）。
 */
export function classifyCrontab({ text = '', exitCode = 0, stderr = '', expect, statics = {} }) {
  const lines = String(text).split('\n');
  const lineCount = lines.filter((line) => line.trim() !== '').length;
  const withStats = (verdict, matched = 0, entryLines = []) => ({ ...verdict, stats: { lines: lineCount, matched, entryLines } });
  // 没给退出码（null）或给的不是整数：判断不了读没读成功，按读取失败处理，不默认成 0。
  if (exitCode === null) return withStats({ kind: UNREADABLE, detail: 'no-exit-code' });
  if (!Number.isInteger(exitCode)) return withStats({ kind: UNREADABLE, detail: 'bad-exit-code' });
  if (exitCode !== 0) {
    if (isNoCrontab(stderr)) return withStats({ kind: MISSING, detail: 'no-crontab' });
    return withStats({ kind: UNREADABLE, detail: 'read-failed' });
  }
  const found = candidatesFrom(lines, expect.script, statics);
  const active = found.filter((item) => !item.commented);
  const commented = found.filter((item) => item.commented);
  if (active.length === 0) {
    if (commented.length) return withStats({ kind: COMMENTED, detail: 'commented' }, found.length);
    // 有行看着像目标（文件名一致）但写法不在规范化结构里：报无法核实，不断言缺失。
    if (plausible(lines, expect.script)) return withStats({ kind: UNKNOWN_FORM, detail: 'noncanonical-script-token' }, found.length);
    return withStats({ kind: MISSING, detail: 'absent' }, found.length);
  }
  // 行号只用于文案，不进指纹：无关行上下移动不该触发重复告警。
  if (active.length > 1) return withStats({ kind: DUPLICATE, detail: `entries:${active.length}` }, found.length, active.map((item) => item.line));
  return withStats(inspectCandidate(active[0], expect, statics), found.length);
}

/** 稳定指纹：只含分类与错法键，不含行号、时间、无关行数（无关 cron 行变化不触发重复告警）。 */
export function fingerprint(kind, detail) {
  return kind === OK ? OK : `${kind}|${detail || ''}`;
}

/**
 * 决定这一轮要不要发通知，以及下一份状态。
 * - 首次正常：静默（没有状态文件 = 之前不是异常）。
 * - 同情形（分类 + 错法键都相同）：不再告警。
 * - 情形变化（含同类但错法字段不同）：再告警一次。
 * - 真从异常回到正常：一次恢复通知。
 */
export function nextNotification(prev, verdict) {
  const kind = verdict.kind;
  const detail = verdict.detail || '';
  const fp = fingerprint(kind, detail);
  if (kind === OK) {
    if (prev && prev.state && prev.state !== OK) return { notify: 'deploy-cron-recovered', next: { state: OK, fp, alertKind: '' } };
    return { notify: null, next: { state: OK, fp, alertKind: '' } };
  }
  if (prev && prev.state === kind && prev.fp === fp) return { notify: null, next: { ...prev, state: kind, fp, alertKind: `deploy-cron-${kind}` } };
  return { notify: `deploy-cron-${kind}`, next: { state: kind, fp, alertKind: `deploy-cron-${kind}` } };
}

const TEXT = {
  [MISSING]: '找不到部署定时条目',
  [COMMENTED]: '部署定时条目被注释掉了',
  [DUPLICATE]: '部署定时条目重复',
  [UNREADABLE]: '读不出 crontab',
  [BAD_SCHEDULE]: '部署定时条目的节拍不对',
  [MISMATCH]: '部署定时条目的参数不对',
  [UNKNOWN_FORM]: '部署定时条目的写法无法核实',
};

const ADVICE = {
  [MISSING]: '合并后的修复不会自动上线，只能人工部署；要人处理：恢复部署定时条目。',
  [COMMENTED]: '这条被注释，自动部署是停的；要人处理：确认是否有意暂停，再决定是否放开。',
  [DUPLICATE]: '同一件事被排了多次，日志和判断都会乱；要人处理：删掉多余那条。',
  [UNREADABLE]: '这次没读到 crontab，无法判断调度在不在（不代表缺失）；要人处理：查读取权限与 crontab 命令。',
  [BAD_SCHEDULE]: '拍间隔过大或没覆盖每个小时，部署会长时间不触发；要人处理：改回每 5 分钟覆盖一小时。',
  [MISMATCH]: '条目指向的参数或解释器与约定不一致，可能部署到错目录或根本跑不起来；要人处理：按约定核对这一条。',
  [UNKNOWN_FORM]: '写法不在本工具认识的规范化结构里，无法核实，不等于缺失；要人处理：人工看一眼这一条。',
};

/** 中文告警正文：发生了什么、影响什么、要不要人处理；不含命令行原文、不含路径。 */
export function describe(verdict) {
  if (verdict.kind === OK) return '部署定时条目正常，最近一次核对通过。不需要人处理。';
  const head = TEXT[verdict.kind] || '部署定时条目异常';
  const parts = [];
  if (verdict.kind === MISSING && verdict.stats) {
    parts.push(`实际行数 ${verdict.stats.lines}`, `匹配数 ${verdict.stats.matched}`);
  }
  const entryLines = verdict.kind === DUPLICATE ? verdict.stats?.entryLines || [] : [];
  if (entryLines.length >= 2) parts.push(`第 ${entryLines.join('、')} 行，共 ${entryLines.length} 条`);
  else if (verdict.detail) parts.push(verdict.detail);
  const detail = parts.length ? `（${parts.join('，')}）` : '';
  return `${head}${detail}。影响：${ADVICE[verdict.kind] || '要人看一下这一条。'}`;
}

export function describeRecovered() {
  return '部署定时条目已恢复正常。之前报过的问题不用再看了，不需要人处理。';
}

/**
 * 读输入：本文件不起子进程：文本、退出码、stderr 都由调用方传进来。
 * 调用方把 `crontab -l` 的输出、退出码、stderr 交进来；--crontab-file 读文件，否则读 stdin。
 */
function readInput(cli) {
  let text = '';
  try {
    text = cli.file ? fs.readFileSync(cli.file, 'utf8') : fs.readFileSync(0, 'utf8');
  } catch {
    // 读输入文件本身失败也是「读不出」，不能拿调用方给的 exit-code 0 当成「条目缺失」。
    return { text: '', exitCode: 1, stderr: 'input-unreadable' };
  }
  // 退出码没传就原样留 null：交给 classifyCrontab 判「读不出」，不在这里补成 0。
  return { text, exitCode: cli.exitCode, stderr: cli.stderrText };
}

export function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      state: typeof data?.state === 'string' ? data.state : '',
      fp: typeof data?.fp === 'string' ? data.fp : '',
      alertKind: typeof data?.alertKind === 'string' ? data.alertKind : '',
    };
  } catch {
    return null;
  }
}

function writeState(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function dirname(file) {
  return path.dirname(file);
}

function usage() {
  return [
    '用法（在仓根执行）：node watchers/acceptance/bin/deploy-cron-selfcheck.mjs',
    '        --home <验收机 home> --expect-script <部署脚本绝对路径> --exit-code <n>',
    '        [--expect-arg <flag>=<value>]...   # 七必填参数逐个给期望值，缺一个就报参数不对',
    '        [--crontab-file <文件>] [--stderr-text <文本>] [--dry-run]',
    'crontab 文本从 --crontab-file 或 stdin 读；退出码与 stderr 由调用方传入（本文件不起子进程）。',
    '--exit-code 必须给：crontab -l 的退出码缺了就判「读不出 crontab」，不默认成 0（否则读失败会被误判成缺失）。',
    '只读：不写 crontab、不改任何条目、不联网。',
  ].join('\n');
}

function parseCli(argv) {
  const out = { home: '', script: '', args: {}, file: '', exitCode: null, stderrText: '', dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const take = () => argv[(i += 1)];
    if (key === '--home') out.home = take();
    else if (key === '--expect-script') out.script = take();
    else if (key === '--expect-arg') {
      const pair = take() || '';
      const at = pair.indexOf('=');
      if (at <= 0) throw new Error('--expect-arg 需要 <flag>=<value>');
      out.args[pair.slice(0, at)] = pair.slice(at + 1);
    } else if (key === '--crontab-file') out.file = take();
    else if (key === '--exit-code') {
      const raw = take();
      if (raw === undefined || !/^-?\d+$/.test(raw.trim())) throw new Error('--exit-code 需要整数（例如 --exit-code 0）');
      out.exitCode = Number(raw.trim());
    } else if (key === '--stderr-text') out.stderrText = take();
    else if (key === '--dry-run') out.dryRun = true;
    else if (key === '--help' || key === '-h') out.help = true;
    else throw new Error(`不认识的参数：${key}`);
  }
  return out;
}

async function main(argv) {
  let cli;
  try {
    cli = parseCli(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (cli.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!cli.home || !cli.script) {
    process.stderr.write(`缺必填参数\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const paths = hostPaths(cli.home);
  const stateFile = path.join(paths.hostDir, 'deploy-cron-selfcheck.json');
  const read = readInput(cli);
  const statics = { isExecutable: (file) => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } } };
  const verdict = classifyCrontab({ ...read, expect: { script: cli.script, args: cli.args }, statics });
  const prev = readState(stateFile);
  const { notify, next } = nextNotification(prev, verdict);
  if (notify) {
    const reason = notify === 'deploy-cron-recovered' ? describeRecovered() : describe(verdict);
    if (!cli.dryRun) appendAlert(paths, { kind: notify, reason, detail: verdict.detail || '' });
    process.stdout.write(`${JSON.stringify({ state: verdict.kind, detail: verdict.detail || '', notified: notify })}\n${reason}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ state: verdict.kind, detail: verdict.detail || '', notified: null })}\n${describe(verdict)}\n`);
  }
  if (!cli.dryRun) writeState(stateFile, { ...next, updatedAt: new Date().toISOString() });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`部署定时自检失败：${error?.message || error}\n`);
    process.exitCode = 3;
  }
}
