#!/usr/bin/env node
// 等无轮次空档，把部署目录快进到 origin/main。
// 放在 bin/ 外面：这里要跑 git、查进程和 doctor，而 bin 里除个别文件外不能起子进程。
// 路径全部由调用方传入。不读令牌，请求不带身份头。不 import 宿主目录里的模块；
// 提醒行由本文件按同样的字段自己追加。doctor 只以子进程方式调用。
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 超过这么多个提交算落后（正好等于这个数不算）。 */
export const LAG_BEHIND_OVER = 5;
/** 最早一个未部署提交距今超过这么久算落后（正好等于不算）。 */
export const LAG_AGE_MS = 2 * 60 * 60 * 1000;

export const EXIT = Object.freeze({
  deployed: 0,
  'up-to-date': 0,
  waiting: 30,
  'ci-pending': 30,
  locked: 20,
  'blocked-dirty': 10,
  'blocked-diverged': 11,
  'fetch-failed': 12,
  'ci-red': 13,
  'ci-unknown': 14,
  'needs-approval': 15,
  'pull-failed': 16,
  'doctor-failed': 17,
});

/** 等待类：轮次空档没到，或 CI 还在跑。不算异常，不写提醒。 */
export const WAITING_EXIT = EXIT.waiting;

const ALERT_STATUSES = new Set([
  'blocked-dirty',
  'blocked-diverged',
  'needs-approval',
  'doctor-failed',
  'pull-failed',
  'ci-red',
  'ci-unknown',
]);

const HUMAN = Object.freeze({
  locked: '另一个实例正在跑，这次直接退出。',
  waiting: '还没到轮次空档，先等着。',
  'blocked-dirty': '工作区不干净，不动。',
  'fetch-failed': '拉取远端失败，不动。',
  'up-to-date': '已经在目标提交上，不用拉。',
  'blocked-diverged': '本地和目标分叉或本地超前，只接受快进，不动。',
  'ci-pending': '检查还在跑，不拉。',
  'ci-red': '检查没过，不拉。',
  'ci-unknown': '检查结果读不到或不认得，不拉。',
  'needs-approval': '有敏感改动，需要点名批准目标提交后才拉。',
  'pull-failed': '快进失败，不动。',
  'doctor-failed': '已经快进，但部署后检查没过，不自动回退。',
  deployed: '已快进到目标提交，检查通过。',
});

const LAG_LEAD = '本地落后目标超过限度，请 lead 看一下要不要处理。';

const GREEN = new Set(['success', 'neutral', 'skipped']);
const RED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure', 'error']);
const PENDING = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested']);
const LOCK_BASENAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
const EXACT_FILES = new Set([
  'package.json',
  'run-ensure.sh',
  'watchers/acceptance/deploy-ff.mjs',
  'watchers/acceptance/bin/trigger.mjs',
  'watchers/acceptance/bin/profile.mjs',
  'watchers/acceptance/bin/github.mjs',
  'watchers/acceptance/bin/redact.mjs',
  'watchers/acceptance/bin/secretscan.mjs',
  'watchers/acceptance/bin/prio-sync.mjs',
]);
const HOST_PREFIX = 'watchers/acceptance/host/';
/**
 * 内容规则只看新增行，且跳过测试文件和 docs/*.md：这些地方提到 token 或 process.env
 * 是常事，拦下来只会逼人写完整 sha 批准。
 * 其余文件按「旧规则减去白名单」判（#426 复审，2026-11-12）：新增行里出现 token、process.env（不分大小写），
 * 或者全大写的密钥类名字（GITHUB_TOKEN、X_API_KEY、MIVO_APP_ID……），就算敏感；只有每一处都落在
 * 少数已知无害的写法里才放过。读环境变量、读令牌文件的写法列不完（别名、解构、Python、shell、拼接），
 * 所以默认拦、按白名单放；另外几类真敏感（secrets/、密钥文件、令牌文件、appOnly、端口）照旧单独认。
 */
// docs 只跳过仓根 docs/ 下一层的 .md（issue #426 写的 docs/*.md）；测试文件和测试夹具（*.fixture.mjs，只给测试用的数据）任何目录都跳过。
const CONTENT_SKIP_RE = /^(?:docs\/[^/]+\.md|(?:.*\/)?[^/]+\.(?:test\.(?:mjs|py)|fixture\.mjs))$/;
const SECRETS_PATH_RE = /secrets\//i;
// 密钥/证书文件：带目录的路径（keys/server.key）或被引号包住的文件名（'server.key'）。
// 有意不匹配 `item.key` 这种对象属性。
const KEY_FILE_RE = /(?:^|[\s"'`(=:,\/])[~\w.@-]*\/[~\w.@-]*\.(?:key|pem|p12|pfx)(?=$|[\s"'`),;:])|['"`][~\w.@-]+\.(?:key|pem|p12|pfx)['"`]/i;
const TOKEN_EXT = '(?:\\.(?:json|txt|dat|key|pem|env|db))?';
const TOKEN_FILE_RE = new RegExp([
  /(?:^|[\s"'`(=:,\/])\.tokens?\b/.source,
  /(?:^|[\s"'`(=:,\/])tokens?\.(?:json|txt|dat|key|pem|env|db)\b/.source,
  /(?:^|[\s"'`(=:,\/])(?:[~\w.@-]+\/)+tokens?(?=$|[\s"'`),;])/.source,
  // path.join(home, 'token')、path.resolve(dir, "tokens")：单独一段就是令牌文件名。
  `path\\.(?:join|resolve)\\s*\\([^;]*?['"\`]\\.?tokens?${TOKEN_EXT}['"\`]`,
  // 模板字符串 `${dir}/token`、`${home}/state/token.json`。
  `\\$\\{[^}]*\\}\\/(?:[~\\w.@-]+\\/)*\\.?tokens?${TOKEN_EXT}(?=$|[\\s"'\`),;])`,
].join('|'), 'i');
// 旧规则的两个触发词：新增行里出现就算敏感，除非这一处落在下面的白名单写法里。
const TOKEN_WORD_RE = /token/gi;
const PROCESS_ENV_RE = /process\.env/gi;
// 白名单 1：按字面量名字读写一个不敏感的环境变量（process.env.HOME、process.env?.X、process.env['X']，含赋值和 delete）。
// 名字后面紧跟括号的是方法调用（process.env.valueOf() 拿到的是整张表），不算。
const ENV_NAMED_RE = /process\.env\s*(?:\?\.\s*|\.\s*)([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_]|\s*(?:\?\.\s*)?\()|process\.env\s*(?:\?\.)?\s*\[\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2\s*\](?!\s*(?:\?\.\s*)?\()/g;
// 白名单 2：函数默认参数 `(env = process.env)` / `, env = process.env)`（issue #426 SC2 点名的写法）。
const ENV_DEFAULT_PARAM_RE = /[(,]\s*env\s*=\s*process\.env\s*[),]/g;
// 白名单 3：文件名里的一段 token（mivo-app-token.mjs 这种模块、脚本、文档名；token.json 这类数据文件不算）。
const TOKEN_IN_MODULE_NAME_RE = /[\w.-]*token[\w.-]*\.(?:mjs|cjs|js|ts|py|sh|md)(?![\w.])/gi;
// 全大写的名字（GITHUB_TOKEN、API_KEY）：按 _ 分段有密钥类的一段就算敏感，不管怎么读到的。
const UPPER_NAME_RE = /(?<![A-Za-z0-9_])[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*(?![A-Za-z0-9_])/g;
// 全大写名字算不算密钥类：TOKEN、SECRET、PASSW（PASSWORD、PASSWD）、APIKEY / API_KEY、PRIVATE_KEY、ACCESS_KEY
// 出现在哪都算（GITHUBTOKEN 这种连写也算）；KEY 要是最后一段（DEPLOY_KEY），APP 要跟着 ID / INSTALLATION
// （MIVO_APP_ID），免得 FORBIDDEN_KEYS、WATCHED_BOT_APP、APP_FALLBACK_RULES 这类普通常量也算。
const SENSITIVE_ENV_RE = /TOKEN|SECRET|PASSW|(?:API|PRIVATE|ACCESS)_?KEY|(?:^|_)KEY$|APP_?(?:ID|INSTALLATION)/i;
// process.env 按名字读写要放过，名字里就一个可疑的词都不能有（比上面严：KEY、APP、AUTH、CRED 出现在哪都不放过）。
const ENV_NAME_UNSAFE_RE = /TOKEN|SECRET|PASSW|KEY|APP|AUTH|CRED/i;
// 白名单盖不住、也没有字面量名字的读环境变量写法：一律算敏感（process['env']、globalThis…process、
// require('process') / from 'process'、Python 的 os.environ / getenv、shell 的 printenv）。
const ENV_OTHER_READ_RE = /\bprocess\s*(?:\?\.)?\s*\[|\bglobalThis\b.*\bprocess\b|\brequire\s*\(\s*['"`](?:node:)?process['"`]|\bfrom\s+['"](?:node:)?process['"]|\bos\.environ\b|\bgetenv\b|\bprintenv\b/;
const APP_ONLY_RE = /appOnly/i;
const PORT_RE = /\.listen\s*\(|\bport\b\s*[:=]\s*['"]?\d{2,5}\b/i;
const FULL_SHA = /^[0-9a-f]{40}$/;

/** 命令行里出现轮次、修正或裁决脚本就不算空档。相对路径 `node round.mjs` 也算。 */
export const BUSY_PROCESS_RE = /(?:^|[\s/])(round|prbot|adjudicate)\.mjs/;

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export function repoFromOrigin(url) {
  const text = String(url || '').trim();
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(text);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

export function isSensitivePath(file) {
  const norm = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (EXACT_FILES.has(norm)) return true;
  if (norm.startsWith(HOST_PREFIX)) return true;
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return LOCK_BASENAMES.has(base);
}

/**
 * 从 unified diff 里取出新增行。`+++` / `---` 只在 hunk 外面当文件头跳过；
 * hunk 里一行内容自己以 `++ ` 开头时，diff 行是 `+++ ...`，仍然算新增。
 */
export function parseAddedLines(diffText) {
  const lines = [];
  let file = null;
  let newLine = 0;
  let inHunk = false;
  for (const line of String(diffText ?? '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const match = / b\/(.+)$/.exec(line);
      file = match ? match[1] : null;
      newLine = 0;
      inHunk = false;
      continue;
    }
    if (!inHunk && (line.startsWith('+++ ') || line.startsWith('--- '))) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (hunk) {
      inHunk = true;
      newLine = Number(hunk[1]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) {
      if (file) lines.push({ file, line: newLine, text: line.slice(1) });
      newLine += 1;
      continue;
    }
    if (line.startsWith('-') || line.startsWith('\\')) continue;
    if (newLine > 0) newLine += 1;
  }
  return lines;
}

/**
 * 一条新增行按内容规则算不算敏感。返回命中的规则名，不命中返回 null。
 * 测试文件和 docs/*.md 不扫内容（路径规则仍然照查）。
 */
export function sensitiveLineReason(file, text) {
  const norm = String(file || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (CONTENT_SKIP_RE.test(norm)) return null;
  const line = String(text ?? '');
  if (SECRETS_PATH_RE.test(line)) return 'secrets-path';
  if (KEY_FILE_RE.test(line)) return 'key-file';
  if (TOKEN_FILE_RE.test(line)) return 'token-file';
  const unlisted = unlistedTriggerIn(line);
  if (unlisted) return unlisted;
  if (APP_ONLY_RE.test(line)) return 'appOnly';
  if (PORT_RE.test(line)) return 'port';
  return null;
}

/** 一处触发词的范围 [起, 止) 落在某个白名单范围里吗。 */
function coveredBy(ranges, start, end) {
  return ranges.some(([from, to]) => from <= start && end <= to);
}

function rangesOf(line, pattern, accept = () => true) {
  const ranges = [];
  for (const match of line.matchAll(pattern)) {
    if (accept(match)) ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

/**
 * 这一行有没有白名单盖不住的触发，返回规则名（不命中返回 null）：
 * 全大写的密钥类名字、没有字面量名字的读环境变量写法一律算（env）；process.env 每一处都要落在白名单里才放过（env）；
 * token 这个词每一处都要落在白名单里才放过（token-word）。
 */
function unlistedTriggerIn(line) {
  if (ENV_OTHER_READ_RE.test(line)) return 'env';
  for (const match of line.matchAll(UPPER_NAME_RE)) {
    if (SENSITIVE_ENV_RE.test(match[0])) return 'env';
  }
  const allowed = [
    ...rangesOf(line, ENV_NAMED_RE, (match) => !ENV_NAME_UNSAFE_RE.test(match[1] || match[3] || '')),
    ...rangesOf(line, ENV_DEFAULT_PARAM_RE),
    ...rangesOf(line, TOKEN_IN_MODULE_NAME_RE),
  ];
  for (const [pattern, rule] of [[PROCESS_ENV_RE, 'env'], [TOKEN_WORD_RE, 'token-word']]) {
    for (const match of line.matchAll(pattern)) {
      if (!coveredBy(allowed, match.index, match.index + match[0].length)) return rule;
    }
  }
  return null;
}

export function sensitiveHits(files, addedLines) {
  const fileHits = [];
  for (const file of files || []) {
    if (isSensitivePath(file)) fileHits.push(file);
  }
  const lineHits = [];
  for (const row of addedLines || []) {
    if (row && sensitiveLineReason(row.file, row.text)) {
      lineHits.push({ file: row.file, line: row.line, text: String(row.text ?? '') });
    }
  }
  const names = [];
  const seen = new Set();
  for (const file of [...fileHits, ...lineHits.map((row) => row.file)]) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    names.push(file);
  }
  return { files: names, lines: lineHits };
}

/**
 * 把公开接口的检查结果分成 green / ci-pending / ci-red / ci-unknown。
 * 每一条的 sha 都必须等于目标完整 sha，否则当作读不到。
 * 有失败结论时优先算 ci-red；否则有还在跑的算 ci-pending。
 */
export function classifyChecks(payload, targetSha) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'ci-unknown';
  if (!FULL_SHA.test(String(targetSha || ''))) return 'ci-unknown';
  let items = null;
  if (Array.isArray(payload.check_runs)) {
    if (typeof payload.total_count === 'number' && payload.total_count !== payload.check_runs.length) {
      return 'ci-unknown';
    }
    items = payload.check_runs.map((run) => ({
      sha: run?.head_sha,
      pending: PENDING.has(run?.status),
      done: run?.status === 'completed',
      conclusion: run?.conclusion,
    }));
  } else if (Array.isArray(payload.statuses)) {
    items = payload.statuses.map((row) => ({
      sha: payload.sha,
      pending: row?.state === 'pending',
      done: Boolean(row?.state) && row.state !== 'pending',
      conclusion: row?.state === 'pending' ? null : row?.state,
    }));
  } else {
    return 'ci-unknown';
  }
  if (items.length === 0) return 'ci-unknown';
  let pending = false;
  let red = false;
  for (const item of items) {
    if (typeof item.sha !== 'string' || item.sha !== targetSha) return 'ci-unknown';
    if (!item.done && !item.pending) return 'ci-unknown';
    if (item.pending) {
      pending = true;
      continue;
    }
    if (GREEN.has(item.conclusion)) continue;
    if (RED.has(item.conclusion)) {
      red = true;
      continue;
    }
    return 'ci-unknown';
  }
  if (red) return 'ci-red';
  if (pending) return 'ci-pending';
  return 'green';
}

/** 同一次落后以本地 HEAD 为键，只在第一次把 reportLag 设为 true。 */
export function lagState({ behind, oldestIso, nowMs, head, reportedFor }) {
  const count = Number.isInteger(behind) ? behind : 0;
  let old = false;
  if (oldestIso) {
    const at = Date.parse(oldestIso);
    if (Number.isFinite(at) && nowMs - at > LAG_AGE_MS) old = true;
  }
  const lagging = count > LAG_BEHIND_OVER || old;
  const reportLag = Boolean(lagging && head && reportedFor !== head);
  return { lagging, reportLag };
}

/**
 * 已知事实里如果已经有该停的一步，返回这一步；事实还不够就返回 null，调用方继续往后做。
 * 只看已经填上的字段，没填的步骤不提前判定。
 */
export function decide(facts) {
  if (facts.selfLock === false) return pack('locked', facts.reason || '另一个实例正在运行', facts);
  if (facts.prioLock === false) return pack('waiting', facts.reason || '演练锁被占用', facts);
  if (facts.idle === false) return pack('waiting', facts.reason || '不是轮次空档', facts);
  if (facts.dirty === true) return pack('blocked-dirty', facts.reason || '工作区不干净', facts);
  if (facts.fetchOk === false) return pack('fetch-failed', facts.reason || '拉取远端失败', facts);
  if (facts.same === true) return pack('up-to-date', facts.reason || '已经在目标提交上', facts);
  if (facts.ancestor === false) return pack('blocked-diverged', facts.reason || '不能快进', facts);
  if (typeof facts.ci === 'string' && facts.ci !== 'green') {
    return pack(facts.ci, facts.reason || '检查不是绿', facts);
  }
  if (facts.needsApproval === true) return pack('needs-approval', facts.reason || '敏感改动需要批准', facts);
  if (facts.pullOk === false) return pack('pull-failed', facts.reason || '快进失败', facts);
  if (facts.postOk === false) return pack('doctor-failed', facts.reason || '部署后检查没过', facts);
  if (facts.postOk === true) return pack('deployed', facts.reason || '已快进并通过检查', facts);
  return null;
}

function pack(status, reason, facts) {
  return {
    status,
    reason: oneLine(reason),
    files: Array.isArray(facts.files) ? facts.files : [],
    lines: Array.isArray(facts.lines) ? facts.lines : [],
  };
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

export function humanLine(payload) {
  let text = HUMAN[payload.status] || payload.status;
  if (payload.status === 'needs-approval') {
    const files = (payload.files || []).join('、');
    const rows = (payload.lines || []).map((row) => `${row.file}:${row.line}`).join('、');
    if (files) text += ` 命中 ${files}。`;
    if (rows) text += ` 行 ${rows}。`;
    if (payload.target) text += ` 目标 ${payload.target}。`;
  }
  if (payload.reason && payload.status === 'doctor-failed') text += ` ${payload.reason}`;
  if (payload.lagging) text += ` ${LAG_LEAD}`;
  return oneLine(text);
}

export function formatResult(payload) {
  const json = {
    status: payload.status,
    head: payload.head ?? null,
    target: payload.target ?? null,
    behind: payload.behind ?? null,
    lagging: Boolean(payload.lagging),
    reportLag: Boolean(payload.reportLag),
    files: payload.files ?? [],
    lines: payload.lines ?? [],
    reason: payload.reason ?? '',
    ts: payload.ts,
  };
  return `${JSON.stringify(json)}\n${humanLine(json)}\n`;
}

export function defaultRunGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function defaultRunCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function defaultRunDoctor({ script, args, cwd }) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
  return { code: result.status ?? 1, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function defaultListProcesses() {
  const result = spawnSync('ps', ['-eo', 'args='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '').split('\n').filter((line) => line.trim());
}

/** 目录不存在或读不出，不算空档。调用方把路径写错时不能当成没有轮次。 */
function dirEmpty(dir) {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return false;
  }
}

async function idleBlock(opts) {
  const rounds = path.join(opts.hostStateDir, 'rounds');
  const locks = path.join(opts.hostStateDir, 'locks');
  if (!dirEmpty(rounds)) return 'rounds 目录不空';
  if (!dirEmpty(locks)) return 'locks 目录不空';
  let processes;
  try {
    processes = await Promise.resolve(opts.listProcesses());
  } catch {
    return '列不出进程';
  }
  if (!Array.isArray(processes)) return '列不出进程';
  if (processes.some((line) => BUSY_PROCESS_RE.test(String(line)))) return '有验收进程在跑';
  return null;
}

function readState(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      lagReportedFor: typeof data?.lagReportedFor === 'string' ? data.lagReportedFor : null,
      alerted: Array.isArray(data?.alerted) ? data.alerted.filter((item) => typeof item === 'string') : [],
    };
  } catch {
    return { lagReportedFor: null, alerted: [] };
  }
}

function writeState(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function appendAlert(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function readPointers(runGit, cwd) {
  const head = runGit(cwd, ['rev-parse', 'HEAD']);
  const target = runGit(cwd, ['rev-parse', 'origin/main']);
  if (!head.ok) return { head: null, target: null, behind: null, oldest: null };
  const headSha = head.stdout.trim();
  if (!target.ok) return { head: headSha, target: null, behind: null, oldest: null };
  const targetSha = target.stdout.trim();
  const count = runGit(cwd, ['rev-list', '--count', `${headSha}..${targetSha}`]);
  const behind = count.ok ? Number(count.stdout.trim()) : null;
  // rev-list 默认新的在前；--reverse 后第一行才是最早那个未部署提交。
  // 不要用 log -1 --reverse：-n 会先截断，剩下的仍是最新一条。
  const list = runGit(cwd, ['rev-list', '--reverse', `${headSha}..${targetSha}`]);
  const oldestSha = list.ok ? list.stdout.split('\n').map((line) => line.trim()).find(Boolean) : null;
  const oldest = oldestSha ? runGit(cwd, ['log', '-1', '--format=%cI', oldestSha]) : { ok: false, stdout: '' };
  return {
    head: headSha,
    target: targetSha,
    behind: Number.isInteger(behind) ? behind : null,
    oldest: oldest.ok && oldest.stdout.trim() ? oldest.stdout.trim() : null,
  };
}

function isOutside(deployDir, file) {
  const root = fs.realpathSync(deployDir);
  let abs = path.resolve(file);
  try {
    abs = fs.realpathSync(file);
  } catch {
    try {
      abs = path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
    } catch {
      abs = path.resolve(file);
    }
  }
  const rel = path.relative(root, abs);
  if (rel === '') return false;
  return rel.startsWith('..') || path.isAbsolute(rel);
}

function readApproval(file, deployDir) {
  if (!file) return null;
  if (!isOutside(deployDir, file)) return null;
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

function approvalMatches(target, approveFlag, fileSha) {
  if (!FULL_SHA.test(target)) return { ok: false, viaFile: false };
  const flag = typeof approveFlag === 'string' ? approveFlag.trim() : '';
  const flagOk = flag === target;
  const fileOk = fileSha === target;
  return { ok: flagOk || fileOk, viaFile: fileOk };
}

async function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function readCi({ repo, sha, fetchImpl, timeoutMs }) {
  if (!repo || !FULL_SHA.test(sha)) return 'ci-unknown';
  const url = `https://api.github.com/repos/${repo}/commits/${sha}/check-runs?per_page=100`;
  try {
    const response = await withTimeout(Promise.resolve(fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'vigil-deploy-ff',
      },
    })), timeoutMs);
    if (!response || response.ok === false || (typeof response.status === 'number' && response.status !== 200)) {
      return 'ci-unknown';
    }
    const payload = await response.json();
    return classifyChecks(payload, sha);
  } catch {
    return 'ci-unknown';
  }
}

function ciReason(ci) {
  if (ci === 'ci-pending') return '有检查还在跑';
  if (ci === 'ci-red') return '有检查失败';
  return '检查结果读不到或不认得';
}

/**
 * 读检查结果：首读是 ci-unknown（空结果、格式不认得、非 200、超时、抛错）时，
 * 同一次运行里再读一次同一个完整目标 sha。最多两个 GET，只重试「读检查」这一步；
 * ci-red / ci-pending 是读到了的结论，不重读。两次都未知仍是 ci-unknown。
 * 重读读到非 ci-unknown 时返回一行说明，调用方把它追加到标准输出。
 */
async function readCiWithReread({ repo, sha, fetchImpl, timeoutMs }) {
  const first = await readCi({ repo, sha, fetchImpl, timeoutMs });
  if (first !== 'ci-unknown') return { ci: first, note: null };
  const second = await readCi({ repo, sha, fetchImpl, timeoutMs });
  if (second === 'ci-unknown') return { ci: second, note: null };
  return {
    ci: second,
    note: `检查结果首读读不到（ci-unknown），同拍重读一次后读到 ${second}，按 ${second} 判定。`,
  };
}

export async function tryAcquire(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(lockPath, 'a'));
  const child = spawn('flock', ['-n', lockPath, 'sh', '-c', 'echo ok; exec cat'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }
      }
      resolve({
        ok,
        release() {
          return new Promise((done) => {
            const killer = setTimeout(done, 1000);
            child.once('exit', () => {
              clearTimeout(killer);
              done();
            });
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              try { child.kill('SIGKILL'); } catch { /* 已经退出 */ }
            }
          });
        },
      });
    };
    const timer = setTimeout(() => finish(false), 3000);
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('ok')) finish(true);
    });
    child.once('exit', () => finish(false));
    child.once('error', () => finish(false));
    if (child.exitCode !== null) finish(false);
  });
}

async function complete(opts, decision, extra = {}) {
  const ts = new Date(opts.now()).toISOString();
  const pointers = extra.skipGit || decision.status === 'locked'
    ? { head: null, target: null, behind: null, oldest: null }
    : readPointers(opts.runGit, opts.deployDir);
  const state = decision.status === 'locked'
    ? { lagReportedFor: null, alerted: [] }
    : readState(opts.stateFile);
  const lag = decision.status === 'locked' || decision.status === 'deployed'
    ? { lagging: false, reportLag: false }
    : lagState({
      behind: pointers.behind,
      oldestIso: pointers.oldest,
      nowMs: opts.now(),
      head: pointers.head,
      reportedFor: state.lagReportedFor,
    });
  const payload = {
    status: decision.status,
    head: pointers.head,
    target: pointers.target,
    behind: pointers.behind,
    lagging: lag.lagging,
    reportLag: lag.reportLag,
    files: decision.files || [],
    lines: decision.lines || [],
    reason: decision.reason || '',
    ts,
  };
  if (decision.status !== 'locked') {
    const alerted = new Set(state.alerted);
    const kinds = [];
    if (ALERT_STATUSES.has(decision.status)) kinds.push(`deploy-${decision.status}`);
    if (lag.reportLag) kinds.push('deploy-lagging');
    for (const kind of kinds) {
      const key = `${pointers.head}|${pointers.target}|${kind}`;
      if (alerted.has(key)) continue;
      alerted.add(key);
      appendAlert(opts.alertsFile, {
        ts,
        kind,
        reason: kind === 'deploy-lagging' ? LAG_LEAD : payload.reason,
        detail: kind === 'deploy-lagging' ? `behind=${pointers.behind ?? ''}` : payload.reason,
        head: pointers.head,
        target: pointers.target,
      });
    }
    const next = decision.status === 'deployed'
      ? { lagReportedFor: null, alerted: [] }
      : {
        lagReportedFor: lag.reportLag && pointers.head ? pointers.head : state.lagReportedFor,
        alerted: [...alerted],
      };
    const changed = decision.status === 'deployed'
      || kinds.length > 0
      || next.lagReportedFor !== state.lagReportedFor;
    if (changed) writeState(opts.stateFile, next);
  }
  const text = formatResult(payload);
  // 重读读到结果时，在原来两行之后多一行说明；JSON 行和人话行都不动。
  const stdout = extra.note ? `${text}${oneLine(extra.note)}\n` : text;
  return {
    code: EXIT[payload.status] ?? 12,
    stdout,
    json: JSON.parse(stdout.split('\n')[0]),
  };
}

async function runPostDeploy(opts, files) {
  const failed = [];
  for (const file of files) {
    if (!file.endsWith('.mjs')) continue;
    const abs = path.join(opts.deployDir, file);
    if (!fs.existsSync(abs)) continue;
    const checked = await opts.runCheck(abs);
    if (!checked || checked.code !== 0) {
      failed.push(`${file} 语法检查失败：${oneLine(checked?.stderr || checked?.stdout || '无输出')}`);
    }
  }
  const doctor = await opts.runDoctor({
    script: opts.doctorScript,
    args: opts.doctorArgs,
    cwd: opts.deployDir,
  });
  if (!doctor || doctor.code !== 0) {
    failed.push(`doctor 退出 ${doctor?.code ?? '未知'}：${oneLine(doctor?.stdout || doctor?.stderr || '无输出')}`);
  }
  return { ok: failed.length === 0, reason: failed.join('；'), files: [] };
}

export async function runDeploy(options) {
  const opts = {
    doctorArgs: [],
    timeoutMs: 15_000,
    approve: null,
    approvalFile: null,
    locksHeld: false,
    assumePrioBlocked: false,
    ...options,
    now: options.now || (() => Date.now()),
    fetchImpl: options.fetchImpl || globalThis.fetch,
    listProcesses: options.listProcesses || defaultListProcesses,
    runGit: options.runGit || defaultRunGit,
    runDoctor: options.runDoctor || defaultRunDoctor,
    runCheck: options.runCheck || defaultRunCheck,
  };
  // 首读未知、重读读到结果时，这一拍的收尾多带一行说明。
  let ciNote = null;
  const conclude = (decision, extra = {}) => complete(opts, decision, { ...extra, note: ciNote });
  let selfHandle = null;
  let prioHandle = null;
  try {
    if (opts.assumePrioBlocked) {
      return await conclude(decide({ selfLock: true, prioLock: false }));
    }
    if (!opts.locksHeld) {
      selfHandle = await tryAcquire(opts.selfLock);
      if (!selfHandle.ok) return await conclude(decide({ selfLock: false }), { skipGit: true });
      prioHandle = await tryAcquire(opts.prioLock);
      if (!prioHandle.ok) return await conclude(decide({ selfLock: true, prioLock: false }));
    }
    const blocked = await idleBlock(opts);
    if (blocked) return await conclude(decide({ idle: false, reason: blocked }));
    const status = opts.runGit(opts.deployDir, ['status', '--porcelain']);
    if (!status.ok || status.stdout.trim()) {
      return await conclude(decide({
        dirty: true,
        reason: status.ok ? '工作区有未提交的改动' : '读工作区状态失败',
      }));
    }
    const fetched = opts.runGit(opts.deployDir, ['fetch', 'origin']);
    if (!fetched.ok) {
      return await conclude(decide({ fetchOk: false, reason: oneLine(fetched.stderr) || '拉取远端失败' }));
    }
    const afterFetch = readPointers(opts.runGit, opts.deployDir);
    if (!afterFetch.head || !afterFetch.target) {
      return await conclude(decide({ fetchOk: false, reason: '读不到 HEAD 或目标提交' }));
    }
    if (afterFetch.head === afterFetch.target) return await conclude(decide({ same: true }));
    const ancestor = opts.runGit(opts.deployDir, ['merge-base', '--is-ancestor', 'HEAD', afterFetch.target]);
    if (!ancestor.ok) return await conclude(decide({ ancestor: false, reason: 'HEAD 不是目标提交的祖先' }));
    const remote = opts.runGit(opts.deployDir, ['config', '--get', 'remote.origin.url']);
    const repo = remote.ok ? repoFromOrigin(remote.stdout.trim()) : null;
    const read = await readCiWithReread({
      repo,
      sha: afterFetch.target,
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs,
    });
    const ci = read.ci;
    ciNote = read.note;
    if (ci !== 'green') return await conclude(decide({ ci, reason: ciReason(ci) }));
    const diffBase = ['--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', afterFetch.target];
    const names = opts.runGit(opts.deployDir, ['diff', '--name-only', ...diffBase]);
    const diff = opts.runGit(opts.deployDir, ['diff', ...diffBase]);
    if (!names.ok || !diff.ok) {
      return await conclude(decide({
        needsApproval: true,
        reason: '算不出待拉的改动文件，先停下来等人看',
      }));
    }
    const files = names.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    const hits = sensitiveHits(files, parseAddedLines(diff.stdout));
    let usedApprovalFile = false;
    if (hits.files.length) {
      const fileSha = readApproval(opts.approvalFile, opts.deployDir);
      const gate = approvalMatches(afterFetch.target, opts.approve, fileSha);
      if (!gate.ok) {
        const listed = hits.files.join('、');
        const rows = hits.lines.map((row) => `${row.file}:${row.line}`).join('、');
        const reason = `敏感改动需要批准 ${afterFetch.target}：${listed}${rows ? `；行 ${rows}` : ''}`;
        return await conclude(decide({
          needsApproval: true,
          files: hits.files,
          lines: hits.lines,
          reason,
        }));
      }
      usedApprovalFile = gate.viaFile;
    }
    const beforeMerge = await idleBlock(opts);
    if (beforeMerge) return await conclude(decide({ idle: false, reason: beforeMerge }));
    const pulled = opts.runGit(opts.deployDir, ['merge', '--ff-only', afterFetch.target]);
    const headNow = opts.runGit(opts.deployDir, ['rev-parse', 'HEAD']);
    if (!pulled.ok || !headNow.ok || headNow.stdout.trim() !== afterFetch.target) {
      return await conclude(decide({
        pullOk: false,
        reason: oneLine(pulled.stderr) || '快进后的 HEAD 不是刚才核对过的目标提交',
      }));
    }
    const post = await runPostDeploy(opts, files);
    if (!post.ok) return await conclude(decide({ postOk: false, reason: post.reason, files: post.files }));
    if (usedApprovalFile && opts.approvalFile) {
      try { fs.unlinkSync(opts.approvalFile); } catch { /* 文件已经不在 */ }
    }
    return await conclude(decide({ postOk: true }));
  } finally {
    if (prioHandle?.ok) await prioHandle.release();
    if (selfHandle?.ok) await selfHandle.release();
  }
}

function usage() {
  return '用法：node watchers/acceptance/deploy-ff.mjs --deploy-dir <dir> --host-state <dir> --self-lock <file> --prio-lock <file> --state-file <file> --alerts <file> --doctor-script <file> [--doctor-arg <arg>] [--approval-file <file>] [--approve <sha>]';
}

function parseArgs(argv) {
  const out = {
    deployDir: null,
    hostStateDir: null,
    selfLock: null,
    prioLock: null,
    stateFile: null,
    alertsFile: null,
    approvalFile: null,
    approve: null,
    doctorScript: null,
    doctorArgs: [],
    selfHeld: false,
    prioHeld: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少值`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--deploy-dir': out.deployDir = take(); break;
      case '--host-state': out.hostStateDir = take(); break;
      case '--self-lock': out.selfLock = take(); break;
      case '--prio-lock': out.prioLock = take(); break;
      case '--state-file': out.stateFile = take(); break;
      case '--alerts': out.alertsFile = take(); break;
      case '--approval-file': out.approvalFile = take(); break;
      case '--approve': out.approve = take(); break;
      case '--doctor-script': out.doctorScript = take(); break;
      case '--doctor-arg': out.doctorArgs.push(take()); break;
      case '--self-held': out.selfHeld = true; break;
      case '--prio-held': out.prioHeld = true; break;
      default: throw new Error(`不认识的参数：${arg}`);
    }
  }
  return out;
}

function lockMissed(result) {
  return result.status === 1 && !(result.stdout || '').trim();
}

function reexec(lockPath, argv, flag) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(lockPath, 'a'));
  return spawnSync('flock', ['-n', lockPath, process.execPath, SCRIPT_PATH, ...argv, flag], { encoding: 'utf8' });
}

export async function main(argv = []) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  const required = ['deployDir', 'hostStateDir', 'selfLock', 'prioLock', 'stateFile', 'alertsFile', 'doctorScript'];
  if (required.some((key) => !args[key])) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const opts = {
    deployDir: args.deployDir,
    hostStateDir: args.hostStateDir,
    selfLock: args.selfLock,
    prioLock: args.prioLock,
    stateFile: args.stateFile,
    alertsFile: args.alertsFile,
    approvalFile: args.approvalFile,
    approve: args.approve,
    doctorScript: args.doctorScript,
    doctorArgs: args.doctorArgs,
  };
  if (!args.selfHeld) {
    const held = reexec(args.selfLock, argv, '--self-held');
    if (lockMissed(held)) {
      const text = formatResult({
        status: 'locked',
        head: null,
        target: null,
        behind: null,
        lagging: false,
        reportLag: false,
        files: [],
        lines: [],
        reason: '另一个实例正在运行',
        ts: new Date().toISOString(),
      });
      process.stdout.write(text);
      return EXIT.locked;
    }
    if (held.stdout) process.stdout.write(held.stdout);
    if (held.stderr) process.stderr.write(held.stderr);
    return held.status ?? 12;
  }
  if (!args.prioHeld) {
    const held = reexec(args.prioLock, argv, '--prio-held');
    if (lockMissed(held)) {
      const outcome = await runDeploy({ ...opts, locksHeld: true, assumePrioBlocked: true });
      process.stdout.write(outcome.stdout);
      return outcome.code;
    }
    if (held.stdout) process.stdout.write(held.stdout);
    if (held.stderr) process.stderr.write(held.stderr);
    return held.status ?? 12;
  }
  const outcome = await runDeploy({ ...opts, locksHeld: true });
  process.stdout.write(outcome.stdout);
  return outcome.code;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === SCRIPT_PATH) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code ?? 12),
    (error) => {
      process.stderr.write(`${error?.message || error}\n`);
      process.exit(12);
    },
  );
}
