// 舰队任务标准（W5）：只读执行清单里的 check，按日期记 evidence，判红写入 alerts。
// 不走写闸，不读令牌，也不改验收机原有的轮次、裁决和调度。路径一律由调用方传入。
// 放在 bin/ 外面：验收机 bin 里除 github.mjs、localgit.mjs 外不能起子进程。命令行入口是 bin/fleet-standard.mjs。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAlert, readAlerts } from './host/paths.mjs';

/** 一条 check 超过这么久没退出就判红。测试注入假时钟，不必真等。 */
export const DEFAULT_TIMEOUT_MS = 60_000;
/** 同一条红灯连续这么久没变成通过，就再写一条催办。 */
export const ESCALATE_UNCHANGED_MS = 2 * 60 * 60 * 1000;
/** 超时没有进程退出码，记成和 timeout(1) 一样的 124，让每条非 manual 行都有数字退出码。 */
export const TIMEOUT_EXIT_CODE = 124;

const FIELDS = Object.freeze(['id', 'owner', 'check', 'deadline', 'escalate', 'evidence', 'sampler', 'frequency']);
const REQUIRED = Object.freeze(['id', 'owner', 'check', 'deadline', 'escalate', 'evidence']);
const COLUMNS = FIELDS;
const POLL_MS = 50;
const ENV_ALLOW = Object.freeze(['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']);

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return trimmed;
}

/**
 * 解析清单。条目之间用单独一行的 `---` 分开。
 * 必填：id、owner、check、deadline、escalate、evidence。
 * `check: manual` 还要有 sampler（抽检人）和 frequency（频率），这种条目不执行。
 */
export function parseChecklist(text) {
  const items = [];
  const seen = new Set();
  for (const chunk of String(text ?? '').split(/^---\s*$/m)) {
    if (!/^id\s*:/m.test(chunk)) continue;
    const fields = {};
    const unknown = [];
    for (const line of chunk.split('\n')) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1];
      if (!FIELDS.includes(key)) {
        unknown.push(key);
        continue;
      }
      fields[key] = unquote(match[2]);
    }
    const label = fields.id || '（没有 id）';
    if (unknown.length) throw new Error(`清单条目 ${label} 有不认识的字段：${unknown.join('、')}`);
    for (const key of REQUIRED) {
      if (!fields[key]) throw new Error(`清单条目 ${label} 缺少 ${key}`);
    }
    if (fields.check === 'manual') {
      if (!fields.sampler) throw new Error(`清单条目 ${fields.id} 的 check 是 manual，缺少 sampler`);
      if (!fields.frequency) throw new Error(`清单条目 ${fields.id} 的 check 是 manual，缺少 frequency`);
    }
    if (seen.has(fields.id)) throw new Error(`清单条目 id 重复：${fields.id}`);
    seen.add(fields.id);
    items.push({
      id: fields.id,
      owner: fields.owner,
      check: fields.check,
      deadline: fields.deadline,
      escalate: fields.escalate,
      evidence: fields.evidence,
      sampler: fields.sampler || '',
      frequency: fields.frequency || '',
    });
  }
  if (!items.length) throw new Error('清单里没有条目');
  return items;
}

function cell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/** 从 YAML 头生成表格。列顺序固定，方便对照。 */
export function renderTable(items) {
  const header = `| ${COLUMNS.join(' | ')} |`;
  const rule = `| ${COLUMNS.map(() => '---').join(' | ')} |`;
  const rows = items.map((item) => `| ${COLUMNS.map((key) => cell(item[key])).join(' | ')} |`);
  return `${[header, rule, ...rows].join('\n')}\n`;
}

/** 子进程环境只留运行所需的几项，令牌类变量不传下去。 */
function checkEnv(base = process.env) {
  const env = {};
  for (const name of ENV_ALLOW) {
    if (typeof base[name] === 'string' && base[name]) env[name] = base[name];
  }
  return env;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 跑一行 shell。detached 是为了超时能杀掉整个进程组（sh 和它拉起的子进程）。 */
function spawnShell(command) {
  const child = spawn('/bin/sh', ['-c', command], {
    env: checkEnv(),
    stdio: 'ignore',
    detached: true,
  });
  return {
    exited() {
      return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => {
          resolve({ code: Number.isInteger(code) ? code : 1, signal: signal ?? null });
        });
      });
    },
    kill() {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
      }
    },
  };
}

async function executeOne(item, { timeoutMs, now, wait, spawnImpl }) {
  if (item.check === 'manual') {
    return { id: item.id, status: 'manual', code: null, reason: 'manual', elapsedMs: 0 };
  }
  const started = now();
  let child;
  try {
    child = spawnImpl(item.check);
  } catch {
    return { id: item.id, status: 'red', code: 1, reason: 'spawn-error', elapsedMs: now() - started };
  }
  let exit = null;
  let failed = null;
  child.exited().then(
    (value) => { exit = value; },
    () => { failed = true; },
  );
  while (exit === null && failed === null) {
    await Promise.resolve();
    if (exit !== null || failed !== null) break;
    if (now() - started >= timeoutMs) {
      try { child.kill(); } catch { /* 进程可能已经没了 */ }
      return {
        id: item.id,
        status: 'red',
        code: TIMEOUT_EXIT_CODE,
        reason: 'timeout',
        elapsedMs: now() - started,
      };
    }
    const remaining = timeoutMs - (now() - started);
    await wait(Math.min(POLL_MS, remaining));
  }
  if (failed) {
    return { id: item.id, status: 'red', code: 1, reason: 'spawn-error', elapsedMs: now() - started };
  }
  const code = Number.isInteger(exit.code) ? exit.code : 1;
  return {
    id: item.id,
    status: code === 0 ? 'pass' : 'red',
    code,
    reason: code === 0 ? 'exit-0' : 'exit-nonzero',
    elapsedMs: now() - started,
  };
}

function dayOf(at) {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(at);
  if (!match) throw new Error(`evidence 的时间不是 UTC 的 ISO 时间：${at}`);
  return match[1];
}

/** 追加一行 evidence。文件名是 UTC 日期 `YYYY-MM-DD.jsonl`。 */
function appendEvidence(dir, record) {
  for (const key of ['at', 'source', 'result']) {
    if (typeof record?.[key] !== 'string' || !record[key]) {
      throw new Error('evidence 每行都要有时间（at）、来源（source）和结果（result）');
    }
  }
  const file = path.join(dir, `${dayOf(record.at)}.jsonl`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return file;
}

function readEvidence(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
    let text = '';
    try {
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // 坏行不影响别的行。
      }
    }
  }
  return out;
}

/** 当前这条连续红灯是从什么时候开始的。中间有过通过或人工记录就算断了。 */
function redStreakStart(records, id) {
  const mine = records
    .filter((row) => row.id === id && typeof row.at === 'string')
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (!mine.length || mine[mine.length - 1].result !== 'red') return null;
  let start = Date.parse(mine[mine.length - 1].at);
  for (let i = mine.length - 1; i >= 0; i -= 1) {
    if (mine[i].result !== 'red') break;
    const at = Date.parse(mine[i].at);
    if (Number.isFinite(at)) start = at;
  }
  return start;
}

function maybeEscalate({ paths, evidenceDir, item, now }) {
  const start = redStreakStart(readEvidence(evidenceDir), item.id);
  if (start === null || now() - start < ESCALATE_UNCHANGED_MS) return;
  const already = readAlerts(paths).some((alert) => (
    alert.kind === 'fleet-check-escalate'
    && alert.id === item.id
    && Date.parse(alert.ts || '') >= start
  ));
  if (already) return;
  appendAlert(paths, {
    kind: 'fleet-check-escalate',
    reason: '红灯超过 2 小时没有变化',
    detail: item.escalate,
    id: item.id,
    owner: item.owner,
    escalate: item.escalate,
    now,
  });
}

/**
 * 跑一整份清单。evidenceDir 和 alertsFile 必填，不接受个人路径当默认值。
 * `now` / `wait` / `spawnImpl` 给测试注入假时钟，避免真等 60 秒。
 */
export async function runChecklist(text, options = {}) {
  const items = parseChecklist(text);
  if (typeof options.evidenceDir !== 'string' || !options.evidenceDir) {
    throw new Error('需要 evidence 目录（--evidence-dir）：按日期写入 jsonl，没有默认路径');
  }
  if (typeof options.alertsFile !== 'string' || !options.alertsFile) {
    throw new Error('需要 alerts 文件（--alerts-file）：红灯写在这里，没有默认路径');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => Date.now());
  const wait = options.wait ?? delay;
  const spawnImpl = options.spawnImpl ?? spawnShell;
  const paths = { alertsFile: options.alertsFile };
  const results = [];
  for (const item of items) {
    const result = await executeOne(item, { timeoutMs, now, wait, spawnImpl });
    const atMs = now();
    const at = new Date(atMs).toISOString();
    appendEvidence(options.evidenceDir, {
      at,
      source: item.evidence,
      result: result.status,
      id: item.id,
      code: result.code,
    });
    if (result.status === 'red') {
      const frozen = () => atMs;
      const reason = result.reason === 'timeout'
        ? '检查超时，判红'
        : `检查退出码 ${result.code}，判红`;
      appendAlert(paths, {
        kind: 'fleet-check-red',
        reason,
        detail: item.id,
        id: item.id,
        owner: item.owner,
        now: frozen,
      });
      maybeEscalate({ paths, evidenceDir: options.evidenceDir, item, now: frozen });
    }
    results.push(result);
  }
  return results;
}

function parseArgs(argv) {
  const out = { _: [], list: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`缺少 --${key} 的值`);
    i += 1;
    if (key === 'list') out.list.push(value);
    else out[key] = value;
  }
  return out;
}

function readLists(files) {
  if (!files.length) throw new Error('需要 --list <清单文件>');
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n---\n');
}

/** `table` 只生成表格；`check` 执行非 manual 行并写 evidence / alerts。 */
export async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const command = args._[0];
  try {
    if (command === 'table') {
      process.stdout.write(renderTable(parseChecklist(readLists(args.list))));
      return 0;
    }
    if (command === 'check') {
      if (!args['evidence-dir']) {
        process.stderr.write('需要 --evidence-dir：按日期写入 evidence jsonl，没有默认路径\n');
        return 1;
      }
      if (!args['alerts-file']) {
        process.stderr.write('需要 --alerts-file：红灯写入 alerts.jsonl，没有默认路径\n');
        return 1;
      }
      const timeoutMs = args['timeout-ms'] === undefined ? undefined : Number(args['timeout-ms']);
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
        process.stderr.write('--timeout-ms 必须是非负数字\n');
        return 1;
      }
      const results = await runChecklist(readLists(args.list), {
        evidenceDir: args['evidence-dir'],
        alertsFile: args['alerts-file'],
        timeoutMs,
      });
      process.stdout.write(`${JSON.stringify(results)}\n`);
      return results.some((item) => item.status === 'red') ? 1 : 0;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  process.stderr.write(
    '用法：fleet-standard.mjs table --list <文件> | check --list <文件> --evidence-dir <目录> --alerts-file <文件>\n',
  );
  return 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
