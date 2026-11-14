// 等无轮次空档再快进部署。临时仓不走网络：origin 配成公开地址，再用 insteadOf 指回本地 bare。
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FLOCK_SKIP, syntheticPsDir, tmpDir, withSyntheticPath } from './fake-gh.fixture.mjs';
import {
  BUSY_PROCESS_RE,
  EXIT,
  classifyChecks,
  claimSlot,
  defaultRunGit,
  formatResult,
  isSensitivePath,
  lagState,
  parseAddedLines,
  removeLockIfUnchanged,
  appendLockRestoreAlert,
  DRAIN_HOLDER_CODE,
  LOCK_RESTORE_FAILED_KIND,
  repoFromOrigin,
  runDeploy,
  sensitiveHits,
  SENSITIVE_RULE_VERSION,
  DRAIN_COOLDOWN_MS,
  DRAIN_MAX_MS,
  spawnDrainHolder,
} from './deploy-ff.mjs';
import { readDeployAudit } from './deploy-audit.mjs';
import { makeGrant } from './deploy-grant.fixture.mjs';
import { tryAcquireLock } from './host/paths.mjs';
import { acquireSlot } from './host/round.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SCRIPT = path.join(HERE, 'deploy-ff.mjs');
const DOC = path.join(ROOT, 'docs', 'acceptance-operations.md');
const ORIGIN_URL = 'https://github.com/example-org/demo-repo.git';
const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function git(cwd, args, date) {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  env.GIT_AUTHOR_NAME = 'ExampleUser';
  env.GIT_AUTHOR_EMAIL = 'example-user@example.com';
  env.GIT_COMMITTER_NAME = 'ExampleUser';
  env.GIT_COMMITTER_EMAIL = 'example-user@example.com';
  if (date) {
    env.GIT_AUTHOR_DATE = date;
    env.GIT_COMMITTER_DATE = date;
  }
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} → ${result.status}\n${result.stderr}`);
  }
  return (result.stdout || '').trim();
}

function configureRepo(dir, hooks) {
  git(dir, ['config', 'user.email', 'example-user@example.com']);
  git(dir, ['config', 'user.name', 'ExampleUser']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.hooksPath', hooks]);
}

function makeWorld() {
  const root = tmpDir('deploy-ff-');
  const bare = path.join(root, 'origin.git');
  const worker = path.join(root, 'worker');
  const deploy = path.join(root, 'deploy');
  const host = path.join(root, 'hoststate');
  const hooks = path.join(root, 'hooks');
  fs.mkdirSync(host, { recursive: true });
  fs.mkdirSync(path.join(host, 'rounds'), { recursive: true });
  fs.mkdirSync(path.join(host, 'locks'), { recursive: true });
  fs.mkdirSync(hooks, { recursive: true });
  fs.mkdirSync(path.join(root, 'run'), { recursive: true });
  spawnSync('git', ['init', '--bare', '-b', 'main', bare], { encoding: 'utf8' });
  spawnSync('git', ['init', '-b', 'main', worker], { encoding: 'utf8' });
  configureRepo(worker, hooks);
  git(worker, ['remote', 'add', 'origin', bare]);
  fs.writeFileSync(path.join(worker, 'README.md'), 'base\n');
  git(worker, ['add', 'README.md']);
  git(worker, ['commit', '-m', 'base']);
  git(worker, ['push', 'origin', 'HEAD:main']);
  spawnSync('git', ['clone', bare, deploy], { encoding: 'utf8' });
  configureRepo(deploy, hooks);
  git(deploy, ['remote', 'set-url', 'origin', ORIGIN_URL]);
  git(deploy, ['config', `url.${bare}/.insteadOf`, ORIGIN_URL]);
  git(deploy, ['fetch', 'origin']);
  const doctor = path.join(root, 'doctor-ok.mjs');
  fs.writeFileSync(doctor, 'process.stdout.write("ok\\n");\nprocess.exit(0);\n');
  return {
    root,
    bare,
    worker,
    deploy,
    host,
    doctor,
    selfLock: path.join(root, 'run', 'self.lock'),
    prioLock: path.join(root, 'run', 'prio.lock'),
    stateFile: path.join(root, 'run', 'state.json'),
    alertsFile: path.join(host, 'alerts.jsonl'),
    approvalFile: path.join(root, 'approval.txt'),
  };
}

function commitAndPush(world, entries, message, date) {
  for (const entry of entries) {
    const full = path.join(world.worker, entry.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, entry.content);
    git(world.worker, ['add', '--', entry.path], date);
  }
  git(world.worker, ['commit', '-m', message], date);
  git(world.worker, ['push', 'origin', 'HEAD:main'], date);
  return git(world.worker, ['rev-parse', 'HEAD']);
}

function fastForward(world) {
  git(world.deploy, ['fetch', 'origin']);
  git(world.deploy, ['merge', '--ff-only', 'origin/main']);
}

function readAlerts(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function assertRun(result, status) {
  const parts = result.stdout.split('\n');
  assert.equal(parts.length, 3, result.stdout);
  assert.equal(parts[2], '');
  const json = JSON.parse(parts[0]);
  assert.equal(json.status, status);
  assert.equal(result.code, EXIT[status]);
  for (const key of ['status', 'head', 'target', 'behind', 'lagging', 'reportLag', 'files', 'reason', 'ts']) {
    assert.equal(Object.hasOwn(json, key), true, key);
  }
  assert.equal(parts[0], JSON.stringify(json));
  return json;
}

/** 等不到空档时只允许 `fetch origin`（#425 返工：排空前要拿到新的远端引用），不 merge、不动工作区。 */
function onlyRemoteFetch(calls) {
  return mutations(calls).every((args) => args.length === 2 && args[0] === 'fetch' && args[1] === 'origin');
}

function neverFetch() {
  return async () => {
    throw new Error('不应该去读检查');
  };
}

function green(sha, extra = {}) {
  const runs = extra.runs || [
    { status: 'completed', conclusion: 'success', head_sha: sha },
    { status: 'completed', conclusion: 'neutral', head_sha: sha },
    { status: 'completed', conclusion: 'skipped', head_sha: sha },
  ];
  return async (url, init) => {
    if (extra.bag) {
      extra.bag.url = url;
      extra.bag.init = init;
    }
    if (extra.hang) return new Promise(() => {});
    if (extra.throwError) throw new Error('timeout');
    if (extra.status && extra.status !== 200) {
      return { ok: false, status: extra.status, json: async () => ({}) };
    }
    if (extra.payload) return { ok: true, status: 200, json: async () => extra.payload };
    return { ok: true, status: 200, json: async () => ({ total_count: runs.length, check_runs: runs }) };
  };
}

function red(sha) {
  return green(sha, { runs: [{ status: 'completed', conclusion: 'failure', head_sha: sha }] });
}

async function deploy(world, extra = {}) {
  const calls = [];
  const runGit = extra.runGit || ((cwd, args) => {
    calls.push(args);
    return defaultRunGit(cwd, args);
  });
  const before = git(world.deploy, ['rev-parse', 'HEAD']);
  const result = await runDeploy({
    deployDir: world.deploy,
    hostStateDir: extra.hostStateDir || world.host,
    selfLock: world.selfLock,
    prioLock: world.prioLock,
    stateFile: world.stateFile,
    alertsFile: world.alertsFile,
    approvalFile: extra.approvalFile ?? null,
    approve: extra.approve ?? null,
    grant: extra.grant ?? null,
    grantFile: extra.grantFile ?? null,
    auditLogFile: extra.auditLogFile ?? null,
    appendAudit: extra.appendAudit,
    doctorScript: extra.doctorScript || world.doctor,
    doctorArgs: extra.doctorArgs || [],
    now: extra.now || (() => Date.now()),
    fetchImpl: extra.fetchImpl || neverFetch(),
    listProcesses: extra.listProcesses || (() => []),
    runGit,
    runDoctor: extra.runDoctor,
    runCheck: extra.runCheck,
    timeoutMs: extra.timeoutMs ?? 15_000,
  });
  return { ...result, before, after: git(world.deploy, ['rev-parse', 'HEAD']), calls };
}

function rangeOf(world) {
  git(world.deploy, ['fetch', 'origin']);
  const baseSha = git(world.deploy, ['rev-parse', 'HEAD']);
  const targetSha = git(world.deploy, ['rev-parse', 'origin/main']);
  const commits = git(world.deploy, ['rev-list', '--reverse', `${baseSha}..${targetSha}`]).split('\n').filter(Boolean);
  return { baseSha, targetSha, commits };
}

function grantFor(world, extra = {}) {
  const range = rangeOf(world);
  return makeGrant({
    ...range,
    ruleVersion: extra.ruleVersion ?? SENSITIVE_RULE_VERSION,
    nowMs: extra.nowMs ?? Date.now(),
    overrides: extra.overrides || {},
  });
}

function auditOf(world) {
  return readDeployAudit(path.join(path.dirname(world.stateFile), 'deploy-ff-audit.jsonl'));
}

function mutations(calls) {
  const verbs = new Set(['fetch', 'merge', 'reset', 'checkout', 'clean', 'commit', 'restore', 'switch', 'rebase']);
  return calls.filter((args) => verbs.has(args[0]));
}

function cliArgs(world, extra = []) {
  return [
    SCRIPT,
    '--deploy-dir', world.deploy,
    '--host-state', world.host,
    '--self-lock', world.selfLock,
    '--prio-lock', world.prioLock,
    '--state-file', world.stateFile,
    '--alerts', world.alertsFile,
    '--doctor-script', world.doctor,
    ...extra,
  ];
}

function spawnCli(world, env = process.env, extra = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, cliArgs(world, extra), { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

async function holdLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.closeSync(fs.openSync(file, 'a'));
  const child = spawn('flock', [file, 'sleep', '30'], { stdio: 'ignore', detached: true });
  const started = Date.now();
  let held = false;
  while (Date.now() - started < 3000) {
    const probe = spawnSync('flock', ['-n', file, 'true']);
    if (probe.status !== 0) {
      held = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!held) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    throw new Error('没能占住锁');
  }
  return () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已经退出 */ } }
  };
}

test('#215 仓名只从 github 的 origin 地址推', () => {
  assert.equal(repoFromOrigin(ORIGIN_URL), 'example-org/demo-repo');
  assert.equal(repoFromOrigin('https://github.com/example-org/demo-repo'), 'example-org/demo-repo');
  assert.equal(repoFromOrigin('git@github.com:example-org/demo-repo.git'), 'example-org/demo-repo');
  assert.equal(repoFromOrigin('/tmp/not-a-remote'), null);
  assert.equal(repoFromOrigin('https://example.invalid/example-org/demo-repo'), null);
});

test('#215 新增行解析忽略文件头和删除行', () => {
  const diff = [
    'diff --git a/docs/note.md b/docs/note.md',
    '--- a/docs/note.md',
    '+++ b/docs/note.md',
    '@@ -1,2 +1,2 @@',
    '-process.env',
    '+plain',
    ' context',
  ].join('\n');
  const lines = parseAddedLines(diff);
  assert.deepEqual(lines.map((row) => row.text), ['plain']);
  assert.deepEqual(sensitiveHits([], lines), { files: [], lines: [] });
});

// ---- 内容规则只认真敏感，文件名和普通环境变量不算 ----

test('内容规则不再把文件名、普通环境变量和文档里的词当成敏感改动', () => {
  // ea4e104 的 deploy.mjs:10：token 只是文件名里的一段。
  const filesLine = "export const FILES=['mivo-pre-push.mjs','mivo-app-token.mjs','mivo-ci.mjs'];";
  const quiet = [
    { file: 'watchers/mivo/deploy.mjs', line: 10, text: filesLine },
    // 测试文件和 docs/*.md 仍跳过常规内容扫描：普通 token 字样、按名字读非敏感环境变量。
    { file: 'watchers/mivo/self-review.test.mjs', line: 15, text: 'const before = process.env.MIVO_PREFLIGHT_SELF_REVIEW;' },
    { file: 'watchers/mivo/app-token.test.mjs', line: 26, text: "const TOKEN = 'fake-installation-token-for-test';" },
    { file: 'docs/acceptance-operations.md', line: 40, text: '回退账号令牌重试一次，记 app-token-fallback。' },
    // 对象属性、普通 import 路径、只提到 token 这个词的代码行。
    { file: 'watchers/mivo/bin/mivo-watcher.mjs', line: 782, text: 'if (Object.hasOwn(currentCursor, item.key)) nextCursor[item.key] = currentCursor[item.key];' },
    { file: 'watchers/mivo/bin/mivo-app-token.mjs', line: 98, text: "import { resolveThreadsWithApp } from './mivo-app-token.mjs';" },
    // 测试夹具（只给测试用的数据）和测试文件一样跳过常规扫描。
    { file: 'watchers/acceptance/pr-link.fixture.mjs', line: 701, text: '"body": "新增可选 `appTokenCommand`"' },
  ];
  assert.deepEqual(sensitiveHits([], quiet), { files: [], lines: [] });
});

test('#426 复审 白名单以外的 token 字样和全大写密钥名照样算（分不清就多要一次批准）', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  assert.equal(sensitiveLineReason('watchers/mivo/bin/mivo-app-token.mjs', 'let token = null;'), 'token-word');
  // 2026-11-05 误拦过的原文：不在仓根 docs/ 下的文档、配置注释里写着真实的密钥名，照样要批准。
  assert.equal(sensitiveLineReason('watchers/acceptance/worker/README.md', '- `PULL_TOKEN`：本机拉取端带在 Authorization: Bearer 里的令牌。'), 'env');
  assert.equal(sensitiveLineReason('watchers/acceptance/worker/wrangler.toml', '#   npx wrangler secret put PULL_TOKEN'), 'env');
});

test('内容规则仍然命中敏感环境变量、密钥/令牌文件、App 身份和端口', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const cases = [
    ['const token = process.env.GITHUB_TOKEN;', 'env'],
    ["const key = process.env['X_API_KEY'];", 'env'],
    ['const secret = process.env.DB_PASSWORD;', 'env'],
    ['const app = process.env.MIVO_APP_ID;', 'env'],
    ["const conf = readFileSync(path.join(home, 'secrets/demo.json'));", 'secrets-path'],
    ["const key = readFileSync(path.join(home, 'certs/server.key'));", 'key-file'],
    ["const blob = readFileSync(path.join(home, 'token.json'));", 'token-file'],
    ["const blob = readFileSync(path.join(home, '.token'));", 'token-file'],
    ["const blob = readFileSync(path.join(home, 'vigil/token'));", 'token-file'],
    ['if (profile.appOnly) block();', 'appOnly'],
    ['server.listen(8080);', 'port'],
    ['listen(8080);', 'port'],
    ['const config = { port: 3000 };', 'port'],
  ];
  for (const [text, rule] of cases) {
    assert.equal(sensitiveLineReason('watchers/mivo/bin/app.mjs', text), rule, text);
    const hits = sensitiveHits([], [{ file: 'watchers/mivo/bin/app.mjs', line: 7, text }]);
    assert.deepEqual(hits.lines, [{ file: 'watchers/mivo/bin/app.mjs', line: 7, text }], text);
  }
});

test('带引号的 port 键、listenPort 这类、YAML port 要拦；普通文本不拦', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/app.mjs';
  const hit = [
    '"port": 8080',
    "'port': 8080",
    '`port`: 8080',
    '"port":8080',
    '{ "port": 8080 }',
    "{ 'port': 3000 }",
    '"listenPort": 8080',
    "'listenPort': 3000",
    'listenPort: 8080',
    'listen_port: 8080',
    'httpPort: 3000',
    'http_port: 80',
    'serverPort: 4430',
    'portNumber: 8080',
    'port: 8080',
    "port: '8080'",
    'PORT: 8080',
    'const config = { port: 3000 };',
    'server.listen(8080);',
    'listen(8080);',
  ];
  for (const text of hit) {
    assert.equal(sensitiveLineReason(file, text), 'port', text);
    assert.equal(sensitiveLineReason('docs/acceptance-operations.md', text), 'port', `docs: ${text}`);
  }
  const quiet = [
    'port 字段说明',
    '说明 port 字段的含义',
    'the port field in the payload',
    'export const n = 8080;',
    'passport: 12345',
    'report: 8080',
    'supported: 8080',
    'important: 8080',
    'opportunity: 8080',
    'portable: 8080',
    'the port number is documented here',
    'listen for connections',
    'const listenPort = name;',
    'const port = "field";',
  ];
  for (const text of quiet) {
    assert.equal(sensitiveLineReason(file, text), null, text);
    assert.equal(sensitiveLineReason('docs/acceptance-operations.md', text), null, `docs: ${text}`);
  }
});

test('内容规则收窄后，路径规则仍然照旧', () => {
  // 6b55d8f 命中 trigger.mjs 和 host/prbot.mjs 是路径规则，按设计保留。
  const hits = sensitiveHits(['watchers/acceptance/bin/trigger.mjs', 'watchers/acceptance/host/prbot.mjs', 'package-lock.json'], []);
  assert.deepEqual(hits, {
    files: ['watchers/acceptance/bin/trigger.mjs', 'watchers/acceptance/host/prbot.mjs', 'package-lock.json'],
    lines: [],
  });
  assert.equal(isSensitivePath('watchers/acceptance/host/anything.mjs'), true);
});

// ---- 复审返工：内容规则的漏网写法、误中写法和 docs 跳过范围 ----

test('返工 环境变量读取：解构、可选链、动态下标、整表枚举都命中，普通写法不命中', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/app.mjs';
  const hit = [
    'const { GITHUB_TOKEN } = process.env;',
    'const { HOME, GITHUB_TOKEN: token } = process.env;',
    "const { DB_PASSWORD = '' } = process.env;",
    'const token = process.env?.GITHUB_TOKEN;',
    "const key = process.env?.['X_API_KEY'];",
    'const value = process.env[name];',
    'const value = process.env?.[name];',
    'for (const [k, v] of Object.entries(process.env)) send(k, v);',
    'const names = Object.keys(process.env);',
    'log(JSON.stringify(process.env));',
    // #426 复审：白名单以外的 process.env 一律算（整表解构、整表交给子进程、整表打日志）；全大写密钥名不管从哪读都算。
    'const { HOME, PATH } = process.env;',
    'const child = spawn(cmd, args, { env: { ...process.env, LANG: "C" } });',
    'const { GITHUB_TOKEN } = options;',
  ];
  for (const text of hit) assert.equal(sensitiveLineReason(file, text), 'env', text);
  const quiet = [
    'const debug = process.env?.MIVO_DEBUG;',
    "const home = process.env['HOME'];",
    'const entries = Object.entries(config);',
  ];
  assert.equal(sensitiveLineReason(file, 'export function preflightSelfReviewEnabled(env = process.env) {'), 'env');
  for (const text of quiet) assert.equal(sensitiveLineReason(file, text), null, text);
});

test('返工 令牌文件：path.join 的独立 token 段和模板字符串的 /token 按令牌文件命中；tokens.md、tokenizer.mjs 这类文件名不命中，tokenize 之类的字样按 token-word 命中', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/app.mjs';
  const hit = [
    "const file = path.join(home,'token');",
    'const file = path.join(home, "token");',
    "const file = path.resolve(dir, 'state', 'tokens');",
    'const file = `${dir}/token`;',
    'const file = `${home}/state/token`;',
    "const file = path.join(home, 'token.json');",
    "const file = path.join(os.homedir(), '.config', 'token');",
  ];
  for (const text of hit) assert.equal(sensitiveLineReason(file, text), 'token-file', text);
  // 模块、文档文件名里的一段 token 放过；别处的 token 这个词一律算（分不清词法单元和令牌，宁可多要一次批准）。
  const quiet = [
    "const doc = path.join(root, 'docs', 'tokens.md');",
    'const file = `${dir}/tokenizer.mjs`;',
  ];
  for (const text of quiet) assert.equal(sensitiveLineReason(file, text), null, text);
  for (const text of ['const parts = tokenize(line);', "const doc = path.join(root, 'token-notes.txt');", "if (kind === 'token') count += 1;", "const label = 'token';"]) {
    assert.equal(sensitiveLineReason(file, text), 'token-word', text);
  }
});

test('#426 复审 全大写常量：HAPPY、FORBIDDEN_KEYS、WATCHED_BOT_APP 不算；读环境变量时名字里有可疑的词就算', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/app.mjs';
  for (const name of ['HAPPY', 'HAPPY_HOUR', 'MONKEY_MODE', 'KEYBOARD_LAYOUT', 'WEBAPP_URL', 'FORBIDDEN_KEYS', 'WATCHED_BOT_APP', 'APP_FALLBACK_RULES',
    'CONFLICT_FEEDBACK_KEY', 'SWITCH_KEY', 'QUEUE_COUNT_KEY', 'AUTHOR_LOGIN']) {
    assert.equal(sensitiveLineReason(file, `const ${name} = 1;`), null, name);
  }
  // 按名字读环境变量放过的条件更严：名字里有 TOKEN、SECRET、PASSW、KEY、APP、AUTH、CRED 中的任何一段字都不放过。
  for (const name of ['HAPPY', 'MONKEY_MODE', 'KEYBOARD_LAYOUT', 'WEBAPP_URL', 'TOKENIZER_MODEL', 'SECRETARY_NAME', 'SOME_AUTH', 'GH_CREDS']) {
    assert.equal(sensitiveLineReason(file, `const v = process.env.${name};`), 'env', name);
  }
  // 凭证类名字不管从哪读都算（#426 第 2 轮复审：AUTH / CRED 类别名读取原来漏了）。
  for (const name of ['AUTHORIZATION', 'GH_CREDS', 'GOOGLE_APPLICATION_CREDENTIALS', 'AWS_CREDENTIALS', 'BASIC_AUTH', 'DEPLOY_KEY', 'SIGNING_KEY', 'CLIENT_KEY',
    // 第 3 轮复审：KEY 收窄后漏掉的常见密钥叫法。
    'SESSION_KEY', 'AZURE_STORAGE_ACCOUNT_KEY', 'SERVICE_ACCOUNT_KEY', 'HMAC_KEY', 'AES_KEY', 'RSA_KEY', 'STORAGE_KEY', 'ENCRYPT_KEY', 'SIGN_KEY', 'KEY']) {
    assert.equal(sensitiveLineReason(file, `return env.${name};`), 'env', name);
  }
  for (const name of ['MIVO_APP_ID', 'APP_PRIVATE_KEY', 'X_API_KEY', 'ACCESS_TOKENS', 'GITHUB_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET', 'TOKEN', 'app_key']) {
    assert.equal(sensitiveLineReason(file, `const v = process.env.${name};`), 'env', name);
  }
});

test('返工 只跳过仓根 docs/ 下一层的 .md（issue 写的 docs/*.md），更深或别处的 docs 目录照常扫', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  // 常规内容扫描：普通 token 字样、按名字读非敏感环境变量，在仓根 docs/*.md 和测试文件里仍放过。
  const regular = 'let token = null; const home = process.env.HOME;';
  assert.equal(sensitiveLineReason('docs/acceptance-operations.md', regular), null);
  // GITHUB_TOKEN 即使写在可跳过常规扫描的文件里也要拦。
  const githubToken = 'const token = process.env.GITHUB_TOKEN;';
  assert.equal(sensitiveLineReason('docs/acceptance-operations.md', githubToken), 'env');
  for (const file of ['docs/sub/notes.md', 'watchers/acceptance/docs/notes.md', 'docs/notes.mdx', 'docs.md', 'docs/notes.mjs']) {
    assert.equal(sensitiveLineReason(file, githubToken), 'env', file);
    assert.equal(sensitiveLineReason(file, regular), 'token-word', file);
  }
  // 测试文件任何目录都跳过常规扫描，但 GITHUB_TOKEN 照样拦。
  assert.equal(sensitiveLineReason('watchers/mivo/deep/x.test.mjs', regular), null);
  assert.equal(sensitiveLineReason('watchers/mivo/x.test.py', regular), null);
  assert.equal(sensitiveLineReason('watchers/acceptance/pr-link.fixture.mjs', regular), null, '测试夹具同测试文件');
  assert.equal(sensitiveLineReason('watchers/mivo/deep/x.test.mjs', githubToken), 'env');
  assert.equal(sensitiveLineReason('watchers/mivo/x.test.py', githubToken), 'env');
  assert.equal(sensitiveLineReason('watchers/acceptance/pr-link.fixture.mjs', githubToken), 'env', '测试夹具同测试文件');
  assert.equal(sensitiveLineReason('watchers/acceptance/fixture.mjs', githubToken), 'env', '只认 *.fixture.mjs');
});

// ---- #426 复审：旧规则减去白名单。读法列不完，默认拦、按白名单放 ----

test('#426 复审 P1 别名、间接、多行、计算属性、无下划线连写读敏感环境变量都拦', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/app.mjs';
  for (const text of [
    'const env = process.env;',
    'return env.GITHUB_TOKEN;',
    'const { GITHUB_TOKEN } = env;',
    "const { GITHUB_TOKEN } = process['env'];",
    "const t = process['env'].GITHUB_TOKEN;",
    "const t = globalThis['process'].env.GITHUB_TOKEN;",
    "const t = require('node:process').env.GITHUB_TOKEN;",
    "import { env } from 'node:process';",
    "const t = Reflect.get(process.env, 'GITHUB_TOKEN');",
    '  GITHUB_TOKEN,',
    "const { ['GITHUB_TOKEN']: t } = process.env;",
    'const { [name]: t } = process.env;',
    "const token = optionalConfigStrict('githubToken', { envVar: 'GITHUB_TOKEN', env });",
    'const t = process.env.APIKEY;',
    'const t = process.env.GITHUBTOKEN;',
    'const t = process.env.CLIENTSECRET;',
  ]) {
    assert.notEqual(sensitiveLineReason(file, text), null, text);
  }
});

test('#426 复审 P2 令牌文件的拼接、URL、实际命名，Python / shell 读环境变量，整表打日志或枚举都拦', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const cases = [
    ['watchers/mivo/bin/app.mjs', "const raw = fs.readFileSync(dir + '/token');"],
    ['watchers/mivo/bin/app.mjs', "const url = new URL('token', base);"],
    ['watchers/acceptance/bin/event-run.mjs', "const file = path.join(secretsDir, 'event-pull-token');"],
    ['watchers/mivo/bin/app.mjs', "const file = path.join(home, 'state', 'github.token');"],
    ['watchers/cindy/bin/x.py', "token = os.environ['GITHUB_TOKEN']"],
    ['watchers/cindy/bin/x.py', "token = os.getenv('GITHUB_TOKEN')"],
    ['watchers/cindy/bin/x.py', "home = os.environ.get('HOME')"],
    ['watchers/acceptance/bin/x.sh', 'curl -H "Authorization: Bearer $GITHUB_TOKEN" "$URL"'],
    ['watchers/acceptance/bin/x.sh', 'printenv HOME'],
    ['watchers/acceptance/bin/x.sh', 'echo "$CLIENT_SECRET"'],
    ['watchers/mivo/bin/app.mjs', 'console.log(process.env);'],
    ['watchers/mivo/bin/app.mjs', 'const copy = Object.assign({}, process.env);'],
    ['watchers/mivo/bin/app.mjs', 'for (const k in process.env) send(k);'],
    ['watchers/mivo/bin/app.mjs', 'const all = Object.entries(process.env ?? {});'],
    ['watchers/mivo/bin/app.mjs', 'spawn(cmd, args, { env: process.env });'],
    ['watchers/mivo/bin/app.mjs', 'console.log(process.env.valueOf());'],
    ['watchers/mivo/bin/app.mjs', "log(process.env['toJSON']());"],
  ];
  for (const [file, text] of cases) assert.notEqual(sensitiveLineReason(file, text), null, `${file}: ${text}`);
});

test('#426 复审 新规则放过的每一处 token / process.env 都属于白名单两种写法（按名字读普通环境变量、模块文件名）', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const OLD = /process\.env|secrets\/|token/i;
  const file = 'watchers/mivo/bin/app.mjs';
  const released = [
    "export const FILES=['mivo-pre-push.mjs','mivo-app-token.mjs'];",
    "import { resolveThreadsWithApp } from './mivo-app-token.mjs';",
    'if (process.env.MIVO_PREFLIGHT_SELF_REVIEW === "1") run();',
    'delete process.env.MIVO_PREFLIGHT_SELF_REVIEW;',
    "const home = process.env['HOME'];",
    'const nodeEnv = process.env.NODE_ENV;',
  ];
  for (const text of released) {
    assert.equal(OLD.test(text), true, `旧规则命中：${text}`);
    assert.equal(sensitiveLineReason(file, text), null, `新规则放过：${text}`);
  }
  // 白名单写法旁边再多一处触发，整行仍然算。
  for (const text of [
    "export const FILES=['mivo-app-token.mjs', 'token.json'];",
    'if (process.env.MIVO_X) send(process.env);',
    'export function preflightSelfReviewEnabled(env = process.env) {',
    'export function f(env = process.env) { return env.GITHUB_TOKEN; }',
    "import { x } from './mivo-app-token.mjs'; const t = readToken();",
    // 第 2 轮复审：白名单写法本身的绕法。小写名字（对象方法）拿到的是整张表；模块文件名的范围不能盖住 process.env。
    'const all = (process.env.valueOf)();',
    "const all = (process.env['valueOf'])();",
    'const all = (process.env.valueOf)?.();',
    'const t = process.env.token.mjs;',
    // 第 3 轮复审：读到名字后面还接着取（.、?.、[、调用）也不放过，constructor 链能拿到整张表。
    "const all = process.env.HOME.constructor.constructor('return process')()['env'];",
    "const all = process.env.HOME['constructor']['constructor']('return process')()['env'];",
    'const all = process.env.HOME?.constructor;',
    "const all = process.env['HOME'].constructor;",
    'const repos = process.env.MIVO_REPOS.split(",");',
  ]) {
    assert.notEqual(sensitiveLineReason(file, text), null, text);
  }
  // 读完名字就结束的照常放过（比较、默认值、外面再包一层）。
  for (const text of ['const h = process.env.HOME;', 'const v = process.env.MIVO_X ?? "d";', 'const v = (process.env.MIVO_X || "").split(",");']) {
    assert.equal(sensitiveLineReason(file, text), null, text);
  }
});

test('#426 复审 按每一处触发词判断、不按整行：同一行里没有触发词的读凭证写法不靠这条规则', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const OLD = /process\.env|secrets\/|token/i;
  const file = 'watchers/mivo/bin/app.mjs';
  // 旧规则拦下这一行只是因为碰巧有 process.env；同一句单独成行，旧规则本来就不拦。新规则对两种写法一视同仁。
  const mixed = 'if (process.env.CI) creds = fs.readFileSync(credsPath);';
  const alone = 'creds = fs.readFileSync(credsPath);';
  assert.equal(OLD.test(mixed), true);
  assert.equal(OLD.test(alone), false, '旧规则对单独一行也不拦');
  assert.equal(sensitiveLineReason(file, mixed), null);
  assert.equal(sensitiveLineReason(file, alone), null);
  // 读凭证文件靠令牌文件、密钥文件、secrets/ 和全大写密钥名这几条认：写出文件名或变量名的照样拦。
  assert.notEqual(sensitiveLineReason(file, "if (process.env.CI) creds = fs.readFileSync(path.join(home, 'token.json'));"), null);
  assert.notEqual(sensitiveLineReason(file, "if (process.env.CI) creds = fs.readFileSync('secrets/ci.json');"), null);
  assert.notEqual(sensitiveLineReason(file, 'if (process.env.CI) creds = env.GOOGLE_APPLICATION_CREDENTIALS;'), null);
});

test('SC1 PRAISEZHU_* 无条件敏感：按名字读和裸名都要拦', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/app.mjs';
  for (const text of [
    'const v = process.env.PRAISEZHU_FOO;',
    "const v = process.env['PRAISEZHU_GH'];",
    'const v = process.env?.PRAISEZHU_FOO;',
    'const PRAISEZHU_BOX = 1;',
    'return PRAISEZHU_LOGIN;',
  ]) {
    assert.equal(sensitiveLineReason(file, text), 'env', text);
  }
  // 负面：普通非敏感环境变量读取仍放过。
  for (const text of ['const h = process.env.HOME;', 'const n = process.env.NODE_ENV;']) {
    assert.equal(sensitiveLineReason(file, text), null, text);
  }
});

test('SC2 整表默认参数 (env = process.env) 不再白名单放行', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/profile.mjs';
  for (const text of [
    'export function preflightSelfReviewEnabled(env = process.env) {',
    'function f(env = process.env) {',
    'const f = (env = process.env) => env;',
    'function g(opts, env = process.env) {',
  ]) {
    assert.equal(sensitiveLineReason(file, text), 'env', text);
  }
});

test('SC3 测试和文档仍跳过常规内容扫描，但真敏感写法照样拦', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const skipFiles = [
    'watchers/mivo/app-token.test.mjs',
    'watchers/mivo/x.test.py',
    'watchers/acceptance/pr-link.fixture.mjs',
    'docs/acceptance-operations.md',
  ];
  const hits = [
    ['if (profile.appOnly) block();', 'appOnly'],
    ["const blob = readFileSync(path.join(home, 'token.json'));", 'token-file'],
    ["const conf = readFileSync(path.join(home, 'secrets/demo.json'));", 'secrets-path'],
    ['server.listen(8080);', 'port'],
    ['const config = { port: 3000 };', 'port'],
    ['const token = process.env.GITHUB_TOKEN;', 'env'],
    ['return GITHUB_TOKEN;', 'env'],
  ];
  const quiet = [
    'let token = null;',
    "const TOKEN = 'fake-installation-token-for-test';",
    'const before = process.env.MIVO_PREFLIGHT_SELF_REVIEW;',
    'const home = process.env.HOME;',
    'const nodeEnv = process.env.NODE_ENV;',
    '"body": "新增可选 `appTokenCommand`"',
  ];
  for (const file of skipFiles) {
    for (const [text, rule] of hits) {
      assert.equal(sensitiveLineReason(file, text), rule, `${file}: ${text}`);
    }
    for (const text of quiet) {
      assert.equal(sensitiveLineReason(file, text), null, `${file}: ${text}`);
    }
  }
});

test('SC5 解构或别名读取 process.env 整表要拦', async () => {
  const { sensitiveLineReason } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/app.mjs';
  for (const text of [
    'const { env } = process;',
    'let { env } = process;',
    'var { env } = process;',
    '({ env } = process);',
    'const { env: e } = process;',
    'const p = process; p.env',
    'let p = process; p.env',
    'const p = process; p?.env',
  ]) {
    assert.equal(sensitiveLineReason(file, text), 'env', text);
  }
  // 负面：不是整表、只按名字读非敏感变量。
  for (const text of ['const { HOME } = config;', 'const p = process.argv;', 'const h = process.env.HOME;']) {
    assert.equal(sensitiveLineReason(file, text), null, text);
  }
});

test('多键解构 process 含 env 要拦：夹杂其它键、重命名、默认值、跨行；不含 env 的不解构整表不拦', async () => {
  const { sensitiveLineReason, sensitiveHits } = await import('./deploy-ff.mjs');
  const file = 'watchers/mivo/bin/app.mjs';
  const hit = [
    'const { argv, env } = process;',
    'let { argv, env } = process;',
    'var { argv, env } = process;',
    'const { env, argv } = process;',
    '({ argv, env } = process);',
    'const { argv, env: e } = process;',
    'const { argv, env = {} } = process;',
    'const { argv, env: e = {} } = process;',
    'const { argv, cwd, env } = process;',
    'const { argv, env = defaultEnv } = process;',
    "const { argv, 'env': e } = process;",
    'const {\n  argv,\n  env\n} = process;',
    'let {\n  env: e,\n  argv\n} = process;',
    'var {\n  argv,\n  env = {}\n} = process;',
  ];
  for (const text of hit) {
    assert.equal(sensitiveLineReason(file, text), 'env', text);
  }
  const quiet = [
    'const { argv } = process;',
    'const { argv, cwd } = process;',
    'const { HOME } = config;',
    'const p = process.argv;',
    'const h = process.env.HOME;',
    'const { environment } = process;',
    'const { envName } = process;',
    'const { env } = config;',
    'const { env } = process.argv;',
    'const { argv, env } = other;',
  ];
  for (const text of quiet) {
    assert.equal(sensitiveLineReason(file, text), null, text);
  }

  const hits = sensitiveHits([], [
    { file, line: 10, text: 'const {' },
    { file, line: 11, text: '  argv,' },
    { file, line: 12, text: '  env' },
    { file, line: 13, text: '} = process;' },
  ]);
  assert.equal(hits.lines.length, 1, JSON.stringify(hits));
  assert.equal(hits.lines[0].file, file);
  assert.equal(hits.lines[0].line, 12);
  assert.equal(hits.lines[0].text, '  env');

  const already = sensitiveHits([], [
    { file, line: 3, text: 'const { argv, env } = process;' },
  ]);
  assert.equal(already.lines.length, 1);
  assert.equal(already.lines[0].text, 'const { argv, env } = process;');

  const split = sensitiveHits([], [
    { file, line: 1, text: 'const { env } = config;' },
    { file, line: 20, text: 'const { argv } = process;' },
  ]);
  assert.equal(split.lines.length, 0, JSON.stringify(split));
});

test('SC6 isSensitivePath 认 token.json、.token、secrets/*、*.key', () => {
  assert.equal(isSensitivePath('token.json'), true);
  assert.equal(isSensitivePath('state/token.json'), true);
  assert.equal(isSensitivePath('.token'), true);
  assert.equal(isSensitivePath('home/.token'), true);
  assert.equal(isSensitivePath('secrets/demo.json'), true);
  assert.equal(isSensitivePath('watchers/mivo/secrets/ci.json'), true);
  assert.equal(isSensitivePath('certs/server.key'), true);
  assert.equal(isSensitivePath('server.key'), true);
  // 负面：模块文件名里的 token、普通源码、对象属性式文件名以外的路径。
  assert.equal(isSensitivePath('watchers/mivo/bin/mivo-app-token.mjs'), false);
  assert.equal(isSensitivePath('watchers/mivo/bin/app.mjs'), false);
  assert.equal(isSensitivePath('docs/guide.md'), false);
  assert.equal(isSensitivePath('watchers/mivo/self-review.test.mjs'), false);
});

test('#215 SC4 落后阈值：超过 5 个或超过 2 小时，同一 HEAD 只报一次', () => {
  const head = 'a'.repeat(40);
  const recent = '2026-11-02T11:00:00.000Z';
  assert.equal(lagState({ behind: 5, oldestIso: recent, nowMs: NOW, head, reportedFor: null }).lagging, false);
  assert.equal(lagState({ behind: 6, oldestIso: recent, nowMs: NOW, head, reportedFor: null }).reportLag, true);
  assert.equal(lagState({ behind: 6, oldestIso: recent, nowMs: NOW, head, reportedFor: head }).reportLag, false);
  assert.equal(lagState({ behind: 6, oldestIso: recent, nowMs: NOW, head, reportedFor: head }).lagging, true);
  assert.equal(lagState({ behind: 1, oldestIso: '2026-11-02T09:59:00.000Z', nowMs: NOW, head, reportedFor: null }).lagging, true);
  assert.equal(lagState({ behind: 1, oldestIso: '2026-11-02T10:00:00.000Z', nowMs: NOW, head, reportedFor: null }).lagging, false);
});

test('#215 SC9 每种状态两行，退出码和运维说明一致', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  for (const [status, code] of Object.entries(EXIT)) {
    const text = formatResult({
      status,
      head: 'a'.repeat(40),
      target: 'b'.repeat(40),
      behind: 0,
      lagging: false,
      reportLag: false,
      files: [],
      lines: [],
      reason: '原因',
      ts: '2026-11-02T12:00:00.000Z',
    });
    const parts = text.split('\n');
    assert.equal(parts.length, 3, status);
    const json = JSON.parse(parts[0]);
    assert.equal(json.status, status);
    assert.match(doc, new RegExp(`\\|\\s*\`${status}\`\\s*\\|\\s*${code}\\s*\\|`));
    assert.equal(code, EXIT[status]);
  }
  assert.match(doc, /本 issue 不安装调度，安装需 lead \/ Praise 批准/);
  assert.equal(EXIT.waiting, EXIT['ci-pending']);
});

test('#215 SC1 已跟踪改动输出 blocked-dirty，连续跑不新增提醒', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  fs.appendFileSync(path.join(world.deploy, 'README.md'), 'changed\n');
  const first = await deploy(world);
  const json = assertRun(first, 'blocked-dirty');
  assert.equal(first.after, first.before);
  assert.match(fs.readFileSync(path.join(world.deploy, 'README.md'), 'utf8'), /changed/);
  assert.equal(json.lagging, false);
  assert.equal(mutations(first.calls).length, 0);
  const second = await deploy(world);
  assertRun(second, 'blocked-dirty');
  const third = await deploy(world);
  assertRun(third, 'blocked-dirty');
  const rows = readAlerts(world.alertsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'deploy-blocked-dirty');
  assert.equal(rows[0].head, first.before);
});

test('#215 SC1 未忽略的未跟踪文件输出 blocked-dirty', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.deploy, 'UNTRACKED.txt'), 'x\n');
  const result = await deploy(world);
  assertRun(result, 'blocked-dirty');
  assert.equal(result.after, result.before);
  assert.equal(fs.existsSync(path.join(world.deploy, 'UNTRACKED.txt')), true);
  assert.equal(mutations(result.calls).some((args) => args[0] === 'fetch'), false);
});

test('#215 SC1 被忽略的未跟踪文件不挡快进', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  fs.mkdirSync(path.join(world.deploy, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(world.deploy, '.git', 'info', 'exclude'), 'ignored.txt\n');
  fs.writeFileSync(path.join(world.deploy, 'ignored.txt'), 'nope\n');
  const result = await deploy(world);
  assertRun(result, 'up-to-date');
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC1 分叉输出 blocked-diverged 且不动', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  commitAndPush(world, [{ path: 'docs/remote.md', content: 'remote\n' }], 'remote');
  fs.writeFileSync(path.join(world.deploy, 'local.md'), 'local\n');
  git(world.deploy, ['add', 'local.md']);
  git(world.deploy, ['commit', '-m', 'local']);
  const before = git(world.deploy, ['rev-parse', 'HEAD']);
  const result = await deploy(world);
  assertRun(result, 'blocked-diverged');
  assert.equal(result.after, before);
  assert.equal(fs.readFileSync(path.join(world.deploy, 'local.md'), 'utf8'), 'local\n');
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
  const again = await deploy(world);
  assertRun(again, 'blocked-diverged');
  assert.equal(readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-blocked-diverged').length, 1);
});

test('#215 SC1 本地超前输出 blocked-diverged', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.deploy, 'local.md'), 'ahead\n');
  git(world.deploy, ['add', 'local.md']);
  git(world.deploy, ['commit', '-m', 'ahead']);
  const result = await deploy(world);
  assertRun(result, 'blocked-diverged');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'fetch'), true);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
});

test('#215 SC2 检查失败不拉', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/a.md', content: 'a\n' }], 'a');
  const result = await deploy(world, { fetchImpl: red(sha) });
  const json = assertRun(result, 'ci-red');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
  assert.equal(json.head, result.before);
  assert.equal(readAlerts(world.alertsFile).some((row) => row.kind === 'deploy-ci-red'), true);
});

test('#215 SC2 检查还在跑就等待且不写提醒', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/a.md', content: 'a\n' }], 'a');
  const result = await deploy(world, {
    fetchImpl: green(sha, { runs: [{ status: 'in_progress', conclusion: null, head_sha: sha }] }),
  });
  assertRun(result, 'ci-pending');
  assert.equal(result.code, EXIT.waiting);
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC2 读检查报错、超时、零条、格式不认得都不拉', { skip: FLOCK_SKIP }, async () => {
  const cases = [
    ['throw', { throwError: true }],
    ['hang', { hang: true, timeoutMs: 40 }],
    ['empty', { runs: [] }],
    ['shape', { payload: { nope: true } }],
    ['http', { status: 500 }],
  ];
  for (const [label, extra] of cases) {
    const world = makeWorld();
    const sha = commitAndPush(world, [{ path: 'docs/a.md', content: `${label}\n` }], label);
    const result = await deploy(world, { fetchImpl: green(sha, extra), timeoutMs: extra.timeoutMs });
    assertRun(result, 'ci-unknown');
    assert.equal(result.after, result.before, label);
    assert.equal(result.calls.some((args) => args[0] === 'merge'), false, label);
    assert.equal(readAlerts(world.alertsFile).some((row) => row.kind === 'deploy-ci-unknown'), true, label);
  }
});

test('#215 SC2 success、neutral、skipped 都算绿并部署', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/ok.md', content: 'ok\n' }], 'ok');
  const result = await deploy(world, { fetchImpl: green(sha) });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC3 rounds 不空就等待，只更新远端引用不合并', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.host, 'rounds', 'active.json'), '{}\n');
  const result = await deploy(world);
  assertRun(result, 'waiting');
  assert.equal(result.code, EXIT.waiting);
  assert.equal(result.after, result.before);
  assert.equal(onlyRemoteFetch(result.calls), true);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC3 locks 不空就等待', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.host, 'locks', 'round.lock'), '{}\n');
  const result = await deploy(world);
  assertRun(result, 'waiting');
  assert.equal(onlyRemoteFetch(result.calls), true);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC3 验收进程在跑就等待', { skip: FLOCK_SKIP }, async () => {
  for (const name of ['round', 'prbot', 'adjudicate']) {
    const world = makeWorld();
    const result = await deploy(world, {
      listProcesses: () => [`node /opt/app/host/${name}.mjs --issue example-org/demo-repo#1`],
    });
    assertRun(result, 'waiting');
    assert.equal(BUSY_PROCESS_RE.test(`/host/${name}.mjs`), true);
    assert.equal(onlyRemoteFetch(result.calls), true);
  }
  const world = makeWorld();
  const quiet = await deploy(world, { listProcesses: () => ['node /opt/app/host/doctor.mjs'] });
  assertRun(quiet, 'up-to-date');
});

test('#215 SC3 演练锁被占就等待', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const release = await holdLock(world.prioLock);
  try {
    const result = await deploy(world);
    assertRun(result, 'waiting');
    assert.equal(result.calls.some((args) => args[0] === 'fetch'), false);
    assert.equal(readAlerts(world.alertsFile).length, 0);
  } finally {
    release();
  }
});

test('#215 SC8 本脚本的锁被占时直接 locked 且不跑 git', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const release = await holdLock(world.selfLock);
  try {
    const result = await deploy(world);
    assertRun(result, 'locked');
    assert.equal(result.calls.length, 0);
    assert.equal(result.after, result.before);
    assert.equal(fs.existsSync(world.alertsFile), false);
  } finally {
    release();
  }
});

test('#215 SC4 落后 6 个提交只在第一次 reportLag，部署成功后重新计', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  let sha = '';
  for (let i = 0; i < 6; i += 1) {
    sha = commitAndPush(world, [{ path: `docs/lag-${i}.md`, content: `n${i}\n` }], `lag ${i}`, '2026-11-02T11:00:00Z');
  }
  const first = await deploy(world, { fetchImpl: red(sha), now: () => NOW });
  const json = assertRun(first, 'ci-red');
  assert.equal(json.behind, 6);
  assert.equal(json.lagging, true);
  assert.equal(json.reportLag, true);
  assert.match(first.stdout, /请 lead/);
  const second = await deploy(world, { fetchImpl: red(sha), now: () => NOW });
  const again = assertRun(second, 'ci-red');
  assert.equal(again.lagging, true);
  assert.equal(again.reportLag, false);
  const lagRows = readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-lagging');
  assert.equal(lagRows.length, 1);
  assert.equal(lagRows[0].head, first.before);
  const state = JSON.parse(fs.readFileSync(world.stateFile, 'utf8'));
  assert.equal(state.lagReportedFor, first.before);
  const deployed = await deploy(world, { fetchImpl: green(sha), now: () => NOW });
  assertRun(deployed, 'deployed');
  assert.deepEqual(JSON.parse(fs.readFileSync(world.stateFile, 'utf8')), { lagReportedFor: null, alerted: [] });
  let next = '';
  for (let i = 0; i < 6; i += 1) {
    next = commitAndPush(world, [{ path: `docs/again-${i}.md`, content: `a${i}\n` }], `again ${i}`, '2026-11-02T11:30:00Z');
  }
  const fresh = await deploy(world, { fetchImpl: red(next), now: () => NOW });
  const freshJson = assertRun(fresh, 'ci-red');
  assert.equal(freshJson.reportLag, true);
  assert.equal(freshJson.lagging, true);
});

test('#215 SC4 最早未部署提交超过 2 小时算落后，正好 2 小时或正好 5 个不算', { skip: FLOCK_SKIP }, async () => {
  const oldWorld = makeWorld();
  const oldSha = commitAndPush(
    oldWorld,
    [{ path: 'docs/old.md', content: 'old\n' }],
    'old',
    '2026-11-02T09:59:00Z',
  );
  const old = await deploy(oldWorld, { fetchImpl: red(oldSha), now: () => NOW });
  const oldJson = assertRun(old, 'ci-red');
  assert.equal(oldJson.behind, 1);
  assert.equal(oldJson.lagging, true);
  assert.equal(oldJson.reportLag, true);

  const exactWorld = makeWorld();
  const exactSha = commitAndPush(
    exactWorld,
    [{ path: 'docs/exact.md', content: 'exact\n' }],
    'exact',
    '2026-11-02T10:00:00Z',
  );
  const exact = await deploy(exactWorld, { fetchImpl: red(exactSha), now: () => NOW });
  const exactJson = assertRun(exact, 'ci-red');
  assert.equal(exactJson.lagging, false);
  assert.equal(exactJson.reportLag, false);

  const five = makeWorld();
  let sha = '';
  for (let i = 0; i < 5; i += 1) {
    sha = commitAndPush(five, [{ path: `docs/five-${i}.md`, content: `f${i}\n` }], `five ${i}`, '2026-11-02T11:00:00Z');
  }
  const fiveResult = await deploy(five, { fetchImpl: red(sha), now: () => NOW });
  const fiveJson = assertRun(fiveResult, 'ci-red');
  assert.equal(fiveJson.behind, 5);
  assert.equal(fiveJson.lagging, false);
});

const SENSITIVE_CASES = [
  ['#215 SC5 host 目录下的文件需要批准', 'watchers/acceptance/host/note.mjs', 'export const n = 1;\n'],
  ['#215 SC5 写闸文件需要批准', 'watchers/acceptance/host/write-gate.mjs', 'export const gate = 1;\n'],
  ['#215 SC5 trigger 需要批准', 'watchers/acceptance/bin/trigger.mjs', 'export const t = 1;\n'],
  ['#215 SC5 profile 需要批准', 'watchers/acceptance/bin/profile.mjs', 'export const p = 1;\n'],
  ['#215 SC5 github 需要批准', 'watchers/acceptance/bin/github.mjs', 'export const g = 1;\n'],
  ['#215 SC5 redact 需要批准', 'watchers/acceptance/bin/redact.mjs', 'export const r = 1;\n'],
  ['#215 SC5 secretscan 需要批准', 'watchers/acceptance/bin/secretscan.mjs', 'export const s = 1;\n'],
  ['#215 SC5 脚本自身需要批准', 'watchers/acceptance/deploy-ff.mjs', 'export const self = 1;\n'],
  ['#215 SC5 授予模块需要批准', 'watchers/acceptance/deploy-approval.mjs', 'export const n = 1;\n'],
  ['#215 SC5 审计模块需要批准', 'watchers/acceptance/deploy-audit.mjs', 'export const n = 1;\n'],
  ['#215 SC15 prio-sync 需要批准', 'watchers/acceptance/bin/prio-sync.mjs', 'export const sync = 1;\n'],
  ['#215 SC15 仓根 package.json 需要批准', 'package.json', '{"private":true}\n'],
  ['#215 SC15 子目录 package-lock.json 需要批准', 'deps/package-lock.json', '{"name":"demo"}\n'],
  ['#215 SC15 npm-shrinkwrap.json 需要批准', 'deps/npm-shrinkwrap.json', '{"name":"demo"}\n'],
  ['#215 SC15 yarn.lock 需要批准', 'deps/yarn.lock', 'demo-lock\n'],
  ['#215 SC15 pnpm-lock.yaml 需要批准', 'deps/pnpm-lock.yaml', 'lockfileVersion: 1\n'],
  ['#215 SC15 仓根 run-ensure.sh 需要批准', 'run-ensure.sh', 'echo ok\n'],
];

for (const [name, file, content] of SENSITIVE_CASES) {
  test(name, { skip: FLOCK_SKIP }, async () => {
    const world = makeWorld();
    const sha = commitAndPush(world, [{ path: file, content }], 'sensitive');
    const result = await deploy(world, { fetchImpl: green(sha) });
    const json = assertRun(result, 'needs-approval');
    assert.equal(result.after, result.before);
    assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
    assert.ok(json.files.includes(file), json.files.join(','));
    assert.match(json.reason, new RegExp(sha));
  });
}

test('#215 SC5 只改文档会继续部署', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/guide.md', content: 'hello\n' }], 'docs');
  const seen = {};
  const result = await deploy(world, {
    fetchImpl: green(sha, { bag: seen }),
    doctorArgs: ['--dry-run'],
    runDoctor: (input) => {
      seen.doctorArgs = input.args;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.deepEqual(seen.doctorArgs, ['--dry-run']);
  assert.match(seen.url, /example-org\/demo-repo/);
  assert.match(seen.url, new RegExp(sha));
});

test('#215 SC15 子目录的 package.json 和 run-ensure.sh 不算仓根', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [
    { path: 'sub/package.json', content: '{"name":"sub"}\n' },
    { path: 'sub/run-ensure.sh', content: 'echo sub\n' },
  ], 'nested');
  const result = await deploy(world, { fetchImpl: green(sha) });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
});

test('#215 SC6 完整且相等的 --approve 才放行，用过的批准文件会删', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  fs.writeFileSync(world.approvalFile, `${sha}\n`);
  const result = await deploy(world, {
    fetchImpl: green(sha),
    approvalFile: world.approvalFile,
    grant: grantFor(world),
  });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.equal(fs.existsSync(world.approvalFile), false);
});

test('#215 SC6 sha 不匹配、短 sha、旧批准都不放行', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/bin/trigger.mjs', content: 'export const t = 1;\n' }], 'gate');
  const mismatch = await deploy(world, { fetchImpl: green(sha), approve: 'b'.repeat(40) });
  assertRun(mismatch, 'needs-approval');
  assert.equal(mismatch.after, mismatch.before);
  const short = await deploy(world, { fetchImpl: green(sha), approve: sha.slice(0, 7) });
  assertRun(short, 'needs-approval');
  fs.writeFileSync(world.approvalFile, `${'c'.repeat(40)}\n`);
  const stale = await deploy(world, { fetchImpl: green(sha), approvalFile: world.approvalFile });
  assertRun(stale, 'needs-approval');
  assert.equal(fs.readFileSync(world.approvalFile, 'utf8').trim(), 'c'.repeat(40));
});

test('#215 SC6 仓库里的同名文件和提交说明都不算批准', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [
    { path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' },
    { path: 'approval.txt', content: `${'d'.repeat(40)}\n` },
  ], 'approved');
  const real = git(world.worker, ['rev-parse', 'HEAD']);
  assert.equal(real, sha);
  const result = await deploy(world, { fetchImpl: green(sha) });
  assertRun(result, 'needs-approval');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
});

test('#215 SC6 批准文件指向部署目录内部时忽略，待拉提交里的副本也不算', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [
    { path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' },
    { path: 'approve-me.txt', content: `${'f'.repeat(40)}\n` },
  ], 'approved');
  const result = await deploy(world, {
    fetchImpl: green(sha),
    approvalFile: path.join(world.deploy, 'approve-me.txt'),
  });
  assertRun(result, 'needs-approval');
  assert.equal(result.after, result.before);
});

test('#215 SC6 命令行批准放行时，内容对不上的批准文件留着', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'package.json', content: '{"private":true}\n' }], 'pkg');
  fs.writeFileSync(world.approvalFile, `${'e'.repeat(40)}\n`);
  const result = await deploy(world, {
    fetchImpl: green(sha),
    approve: sha,
    approvalFile: world.approvalFile,
    grant: grantFor(world),
  });
  assertRun(result, 'deployed');
  assert.equal(fs.readFileSync(world.approvalFile, 'utf8').trim(), 'e'.repeat(40));
});

test('#215 SC6 检查没过时不删除已用的批准文件，也不回退', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const before = git(world.deploy, ['rev-parse', 'HEAD']);
  fs.writeFileSync(world.approvalFile, `${sha}\n`);
  const result = await deploy(world, {
    fetchImpl: green(sha),
    approvalFile: world.approvalFile,
    grant: grantFor(world),
    runDoctor: () => ({ code: 1, stdout: '检查没过\n', stderr: '' }),
  });
  const json = assertRun(result, 'doctor-failed');
  assert.equal(result.after, sha);
  assert.equal(fs.existsSync(world.approvalFile), true);
  assert.equal(result.calls.some((args) => args[0] === 'reset'), false);
  assert.match(json.reason, new RegExp(`工作区已从 ${before} 快进到 ${sha}，未自动回滚`));
  const rows = auditOf(world);
  assert.ok(rows.some((row) => row.outcome === 'attempt'));
  const failed = rows.find((row) => row.outcome === 'doctor-failed');
  assert.equal(failed.workspaceChanged, true);
  assert.equal(failed.autoRollback, false);
  assert.equal(failed.previousSha, before);
  assert.equal(failed.targetSha, sha);
  assert.equal(failed.attemptId, rows.find((row) => row.outcome === 'attempt').attemptId);
});

test('#215 SC7 语法检查失败时 doctor-failed 且不回退', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/broken.mjs', content: 'export function (\n' }], 'bad');
  const result = await deploy(world, {
    fetchImpl: green(sha),
    runDoctor: () => ({ code: 0, stdout: 'ok\n', stderr: '' }),
  });
  const json = assertRun(result, 'doctor-failed');
  assert.equal(result.after, sha);
  assert.notEqual(result.after, result.before);
  assert.match(json.reason, /broken\.mjs/);
  assert.equal(result.calls.some((args) => args[0] === 'reset'), false);
  const rows = readAlerts(world.alertsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'deploy-doctor-failed');
  assert.equal(rows[0].head, sha);
  assert.equal(rows[0].target, sha);
  assert.ok(rows[0].ts && rows[0].reason);
});

test('#215 SC7 doctor 非 0 时 doctor-failed 且不回退', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/ok-note.mjs', content: 'export const ok = 1;\n' }], 'ok');
  let checked = [];
  const result = await deploy(world, {
    fetchImpl: green(sha),
    runCheck: async (file) => {
      checked.push(file);
      return { code: 0, stdout: '', stderr: '' };
    },
    runDoctor: () => ({ code: 2, stdout: '✗ 配置\n', stderr: '' }),
  });
  const json = assertRun(result, 'doctor-failed');
  assert.equal(result.after, sha);
  assert.match(json.reason, /doctor 退出 2/);
  assert.ok(checked.some((file) => file.endsWith('ok-note.mjs')));
  assert.equal(result.calls.some((args) => args[0] === 'reset'), false);
});

test('#215 SC7 语法和 doctor 都过才是 deployed', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/ok-note.mjs', content: 'export const ok = 1;\n' }], 'ok');
  let checked = 0;
  let doctored = 0;
  const result = await deploy(world, {
    fetchImpl: green(sha),
    runCheck: async () => {
      checked += 1;
      return { code: 0, stdout: '', stderr: '' };
    },
    runDoctor: () => {
      doctored += 1;
      return { code: 0, stdout: 'ok\n', stderr: '' };
    },
  });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.equal(checked, 1);
  assert.equal(doctored, 1);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 SC13 检查全绿但 sha 不是目标完整 sha 时不拉，请求不带身份头', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const parent = git(world.deploy, ['rev-parse', 'HEAD']);
  const sha = commitAndPush(world, [{ path: 'docs/ci.md', content: 'ci\n' }], 'ci');
  const bag = {};
  const previous = await deploy(world, {
    fetchImpl: green(sha, {
      bag,
      runs: [{ status: 'completed', conclusion: 'success', head_sha: parent }],
    }),
  });
  assertRun(previous, 'ci-unknown');
  assert.equal(previous.after, parent);
  const keys = Object.keys(bag.init.headers).map((key) => key.toLowerCase());
  assert.equal(keys.includes('authorization'), false);
  assert.equal(JSON.stringify(bag.init.headers).toLowerCase().includes('authorization'), false);
  const short = await deploy(world, {
    fetchImpl: green(sha, { runs: [{ status: 'completed', conclusion: 'success', head_sha: sha.slice(0, 12) }] }),
  });
  assertRun(short, 'ci-unknown');
  assert.equal(short.after, parent);
  const ok = await deploy(world, { fetchImpl: green(sha, { bag }) });
  assertRun(ok, 'deployed');
  assert.equal(ok.after, sha);
  assert.match(bag.url, new RegExp(`/repos/example-org/demo-repo/commits/${sha}/check-runs`));
});

test('#215 SC13 合并状态的 sha 对不上就不拉，对得上才部署', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/status.md', content: 's\n' }], 'status');
  const bad = await deploy(world, {
    fetchImpl: green(sha, { payload: { sha: 'a'.repeat(40), state: 'success', statuses: [{ state: 'success' }] } }),
  });
  assertRun(bad, 'ci-unknown');
  assert.equal(bad.after, bad.before);
  const good = await deploy(world, {
    fetchImpl: green(sha, { payload: { sha, state: 'success', statuses: [{ state: 'success', context: 'ci' }] } }),
  });
  assertRun(good, 'deployed');
});

test('#215 SC14 needs-approval 连续 3 次只有 1 行，目标变了再写 1 行', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const firstSha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'one');
  for (let i = 0; i < 3; i += 1) {
    const result = await deploy(world, { fetchImpl: green(firstSha) });
    assertRun(result, 'needs-approval');
  }
  const rows = readAlerts(world.alertsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'deploy-needs-approval');
  assert.equal(rows[0].head, git(world.deploy, ['rev-parse', 'HEAD']));
  assert.equal(rows[0].target, firstSha);
  for (const key of ['ts', 'kind', 'reason', 'head', 'target']) assert.ok(rows[0][key]);
  const secondSha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 2;\n' }], 'two');
  const again = await deploy(world, { fetchImpl: green(secondSha) });
  assertRun(again, 'needs-approval');
  const more = readAlerts(world.alertsFile);
  assert.equal(more.length, 2);
  assert.equal(more[1].target, secondSha);
  assert.equal(more[1].kind, 'deploy-needs-approval');
});

test('#215 SC14 waiting、up-to-date、deployed 不写提醒', { skip: FLOCK_SKIP }, async () => {
  const waiting = makeWorld();
  fs.writeFileSync(path.join(waiting.host, 'rounds', 'x.json'), '{}\n');
  await deploy(waiting);
  assert.equal(readAlerts(waiting.alertsFile).length, 0);
  const same = makeWorld();
  const quiet = await deploy(same);
  assertRun(quiet, 'up-to-date');
  assert.equal(readAlerts(same.alertsFile).length, 0);
  const shipped = makeWorld();
  const sha = commitAndPush(shipped, [{ path: 'docs/ship.md', content: 'ship\n' }], 'ship');
  const done = await deploy(shipped, { fetchImpl: green(sha) });
  assertRun(done, 'deployed');
  assert.equal(readAlerts(shipped.alertsFile).length, 0);
});

test('#215 SC16 新增行读敏感环境变量需要批准并列出行', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/mivo/bin/note.mjs', content: 'const x = process.env.GITHUB_TOKEN\n' }], 'env');
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.files.includes('watchers/mivo/bin/note.mjs'));
  assert.ok(json.lines.some((row) => row.file === 'watchers/mivo/bin/note.mjs' && row.text.includes('GITHUB_TOKEN')));
  assert.equal(result.after, result.before);
});

test('#215 SC16 新增行含 secrets/ 需要批准', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/mivo/bin/note.mjs', content: 'see secrets/demo\n' }], 'path');
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.lines.some((row) => row.text.includes('secrets/')));
  assert.equal(result.after, result.before);
});

test('#215 SC16 新增行读令牌文件需要批准', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/mivo/bin/note.mjs', content: "const blob = readFileSync(path.join(home, 'token.json'))\n" }], 'word');
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.lines.some((row) => row.text.includes('token.json')));
  assert.equal(result.after, result.before);
});

test('#215 SC16 这些词只出现在删除行时照常部署', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  commitAndPush(world, [{ path: 'watchers/mivo/bin/note.mjs', content: 'process.env.GITHUB_TOKEN\nsecrets/\n' }], 'add words');
  fastForward(world);
  const sha = commitAndPush(world, [{ path: 'watchers/mivo/bin/note.mjs', content: 'plain\n' }], 'drop words');
  const result = await deploy(world, { fetchImpl: green(sha) });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
});

test('#215 SC17 把写闸改名挪走仍然需要批准', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  commitAndPush(world, [{ path: 'watchers/acceptance/host/write-gate.mjs', content: 'export const gate = 1;\n' }], 'seed');
  fastForward(world);
  fs.mkdirSync(path.join(world.worker, 'docs'), { recursive: true });
  git(world.worker, ['mv', 'watchers/acceptance/host/write-gate.mjs', 'docs/moved-gate.mjs']);
  git(world.worker, ['commit', '-m', 'move gate']);
  git(world.worker, ['push', 'origin', 'HEAD:main']);
  const sha = git(world.worker, ['rev-parse', 'HEAD']);
  const before = git(world.deploy, ['rev-parse', 'HEAD']);
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.files.includes('watchers/acceptance/host/write-gate.mjs'));
  assert.equal(result.after, before);
});

test('#215 SC17 把 trigger 改名挪走仍然需要批准', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  commitAndPush(world, [{ path: 'watchers/acceptance/bin/trigger.mjs', content: 'export const t = 1;\n' }], 'seed');
  fastForward(world);
  fs.mkdirSync(path.join(world.worker, 'docs'), { recursive: true });
  git(world.worker, ['mv', 'watchers/acceptance/bin/trigger.mjs', 'docs/moved-trigger.mjs']);
  git(world.worker, ['commit', '-m', 'move trigger']);
  git(world.worker, ['push', 'origin', 'HEAD:main']);
  const sha = git(world.worker, ['rev-parse', 'HEAD']);
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.ok(json.files.includes('watchers/acceptance/bin/trigger.mjs'));
  assert.equal(result.after, result.before);
});

test('#215 拉取远端失败不写提醒也不改 HEAD', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const result = await deploy(world, {
    runGit: (cwd, args) => {
      if (args[0] === 'fetch') return { ok: false, status: 1, stdout: '', stderr: 'could not fetch' };
      return defaultRunGit(cwd, args);
    },
  });
  assertRun(result, 'fetch-failed');
  assert.equal(result.after, result.before);
  assert.equal(readAlerts(world.alertsFile).length, 0);
});

test('#215 快进失败写提醒且不动 HEAD', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/ff.md', content: 'ff\n' }], 'ff');
  const result = await deploy(world, {
    fetchImpl: green(sha),
    runGit: (cwd, args) => {
      if (args[0] === 'merge') return { ok: false, status: 1, stdout: '', stderr: 'not ff' };
      return defaultRunGit(cwd, args);
    },
  });
  assertRun(result, 'pull-failed');
  assert.equal(result.after, result.before);
  assert.equal(readAlerts(world.alertsFile)[0].kind, 'deploy-pull-failed');
});

test('#215 SC8 两个进程抢同一把锁，只有一个进入检查', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  fs.writeFileSync(path.join(world.deploy, 'UNTRACKED.txt'), 'dirty\n');
  const log = path.join(world.root, 'git.log');
  const bin = path.join(world.root, 'fakebin');
  fs.mkdirSync(bin);
  const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh
printf '%s\\n' "$*" >> "$GIT_LOG"
for arg in "$@"; do
  if [ "$arg" = "status" ] && [ ! -f "$GIT_LOG.slept" ]; then
    touch "$GIT_LOG.slept"
    sleep 3
  fi
done
exec "$REAL_GIT" "$@"
`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  // #370：进程表用合成数据，避免被宿主上真在跑的验收进程影响「轮次空档」判定。
  const psDir = syntheticPsDir();
  const env = { ...process.env, PATH: `${psDir}${path.delimiter}${bin}${path.delimiter}${process.env.PATH}`, GIT_LOG: log, REAL_GIT: realGit };
  const [left, right] = await Promise.all([spawnCli(world, env), spawnCli(world, env)]);
  const statuses = [left, right].map((item) => JSON.parse(item.stdout.split('\n')[0]).status).sort();
  assert.deepEqual(statuses, ['blocked-dirty', 'locked'], `${left.stderr}\n${right.stderr}\n${left.stdout}\n${right.stdout}`);
  const text = fs.readFileSync(log, 'utf8');
  assert.equal(text.includes('fetch'), false, text);
  assert.match(text, /status/);
});

test('#215 SC9 命令行入口标准输出恰好两行', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  // #370：空档判定用合成进程表（空表），不依赖宿主真实进程。
  const result = await spawnCli(world, withSyntheticPath(syntheticPsDir()));
  assert.equal(result.code, EXIT['up-to-date']);
  const parts = result.stdout.split('\n');
  assert.equal(parts.length, 3, `${result.stdout}\n${result.stderr}`);
  const json = JSON.parse(parts[0]);
  assert.equal(json.status, 'up-to-date');
  assert.equal(parts[2], '');
});

// #370：三条忙碌分支各跑一次真实 CLI，进程表完全来自合成数据；生产判断仍生效（waiting + 退出码 30）。
for (const busy of ['round.mjs', 'prbot.mjs', 'adjudicate.mjs']) {
  test(`#370 SC3 合成进程表命中 ${busy} 时真实 CLI 返回 waiting 且退出码 30`, { skip: FLOCK_SKIP }, async () => {
    const world = makeWorld();
    const psDir = syntheticPsDir({ lines: [`node /tmp/synthetic/${busy}`] });
    const result = await spawnCli(world, withSyntheticPath(psDir));
    const json = assertRun(result, 'waiting');
    assert.equal(json.reason, '有验收进程在跑');
    assert.equal(result.code, 30);
  });
}

test('#215 SC10 SC14 SC17 源码静态约束', () => {
  const hostImport = spawnSync('grep', ['-nE', String.raw`from '\./host/|from '\.\./host/|host/[a-z-]+\.mjs`, SCRIPT], { encoding: 'utf8' });
  assert.equal(hostImport.status, 1, hostImport.stdout);
  const banned = spawnSync('grep', ['-niE', 'crontab|systemctl|--write|authorization|slack', SCRIPT], { encoding: 'utf8' });
  assert.equal(banned.status, 1, banned.stdout);
  const renames = spawnSync('grep', ['-n', '--', '--no-renames', SCRIPT], { encoding: 'utf8' });
  assert.equal(renames.status, 0, renames.stderr);
  assert.match(renames.stdout, /--no-renames/);
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /renameSync/);
  // 改了判定实现就必须同一个提交带上文档和测试。只比这条规则，不比整份提交列表：
  // 一次提交里可以同时改别的文件（比如随同的测试夹具），那不是这次要比的东西。
  const COMPANIONS = ['docs/acceptance-operations.md', 'watchers/acceptance/deploy-ff.test.mjs'];
  const DOC_ALTS = ['docs/acceptance-operations.md', 'docs/fleet-deploy-authorization.md'];
  const missingCompanions = (files) => {
    if (!files.includes('watchers/acceptance/deploy-ff.mjs')) return [];
    const missing = [];
    if (!DOC_ALTS.some((file) => files.includes(file))) missing.push('docs/acceptance-operations.md');
    if (!files.includes('watchers/acceptance/deploy-ff.test.mjs')) missing.push('watchers/acceptance/deploy-ff.test.mjs');
    return missing;
  };
  // 规则本身先自检：浅克隆下拿不到父提交、走不到下面的真实比对，这里保证规则没被改松。
  assert.deepEqual(missingCompanions(['watchers/acceptance/deploy-ff.mjs']), COMPANIONS);
  assert.deepEqual(missingCompanions(['watchers/acceptance/deploy-ff.mjs', 'docs/acceptance-operations.md']),
    ['watchers/acceptance/deploy-ff.test.mjs']);
  assert.deepEqual(missingCompanions(['watchers/acceptance/deploy-ff.mjs', ...COMPANIONS,
    'watchers/acceptance/host/sandbox.mjs']), []);
  assert.deepEqual(missingCompanions(['watchers/acceptance/deploy-ff.mjs',
    'docs/fleet-deploy-authorization.md', 'watchers/acceptance/deploy-ff.test.mjs']), []);
  assert.deepEqual(missingCompanions(['watchers/acceptance/loop.test.mjs']), []);
  // 不读 origin/main：CI 的 checkout 往往只有一个提交，没有远端引用。
  // 父提交在本地时，用 HEAD 和它的父提交比；浅克隆没有父提交时，只能查这三份文件都在这次提交里。
  const parent = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD^'], { cwd: ROOT, encoding: 'utf8' });
  const untracked = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(untracked.status, 0);
  assert.equal(untracked.stdout.trim(), '');
  if (parent.status === 0) {
    const diff = spawnSync('git', ['diff', '--name-only', 'HEAD^', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(diff.status, 0, diff.stderr);
    const files = diff.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(missingCompanions(files), [], `这次提交只动了 ${files.join(', ')}`);
  } else {
    for (const file of ['watchers/acceptance/deploy-ff.mjs', 'watchers/acceptance/deploy-ff.test.mjs']) {
      assert.equal(fs.existsSync(path.join(ROOT, file)), true, file);
      const tracked = spawnSync('git', ['cat-file', '-e', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8' });
      assert.equal(tracked.status, 0, `${file} 不在这次提交里`);
    }
    const hasDoc = DOC_ALTS.some((file) => spawnSync('git', ['cat-file', '-e', `HEAD:${file}`], { cwd: ROOT, encoding: 'utf8' }).status === 0);
    assert.equal(hasDoc, true, 'deploy-ff 改动需要同伴文档');
  }
});

test('#215 M1 检查期间远端又前进时只合并第一次的目标提交', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/m1.md', content: 'first\n' }], 'first');
  const result = await deploy(world, {
    fetchImpl: async (url, init) => {
      commitAndPush(world, [{ path: 'docs/m1-later.md', content: 'later\n' }], 'later');
      git(world.deploy, ['fetch', 'origin']);
      return green(sha)(url, init);
    },
  });
  assertRun(result, 'deployed');
  assert.equal(result.after, sha);
  assert.notEqual(git(world.worker, ['rev-parse', 'HEAD']), sha);
});

test('#215 M2 合并前 rounds 出现文件就等待且 HEAD 不动', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/m2.md', content: 'm2\n' }], 'm2');
  const result = await deploy(world, {
    fetchImpl: async (url, init) => {
      fs.writeFileSync(path.join(world.host, 'rounds', 'appeared.json'), '{}\n');
      return green(sha)(url, init);
    },
  });
  assertRun(result, 'waiting');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'merge'), false);
});

test('#215 L1 宿主状态目录不存在就等待', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const result = await deploy(world, { hostStateDir: path.join(world.root, 'no-such-host') });
  assertRun(result, 'waiting');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'fetch'), false);
});

test('#215 L2 相对路径启动的轮次进程也算非空档', { skip: FLOCK_SKIP }, async () => {
  for (const name of ['round', 'prbot', 'adjudicate']) {
    const world = makeWorld();
    const result = await deploy(world, { listProcesses: () => [`node ${name}.mjs`] });
    assertRun(result, 'waiting');
    assert.equal(result.after, result.before);
  }
  const world = makeWorld();
  const self = await deploy(world, {
    listProcesses: () => [
      'node watchers/acceptance/deploy-ff.mjs --deploy-dir /tmp/deploy',
      'node watchers/acceptance/deploy-ff.test.mjs',
    ],
  });
  assertRun(self, 'up-to-date');
});

test('#215 L2 列不出进程就等待', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const result = await deploy(world, { listProcesses: () => null });
  assertRun(result, 'waiting');
  assert.equal(result.after, result.before);
  assert.equal(result.calls.some((args) => args[0] === 'fetch'), false);
});

test('#215 L3 新增行内容以两个加号开头仍要批准', { skip: FLOCK_SKIP }, async () => {
  const diff = [
    'diff --git a/watchers/mivo/plus.mjs b/watchers/mivo/plus.mjs',
    '--- /dev/null',
    '+++ b/watchers/mivo/plus.mjs',
    '@@ -0,0 +1 @@',
    '+++ process.env.GITHUB_TOKEN',
  ].join('\n');
  const parsed = parseAddedLines(diff);
  assert.ok(parsed.some((row) => row.text === '++ process.env.GITHUB_TOKEN'), JSON.stringify(parsed));
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/mivo/plus.mjs', content: '++ process.env.GITHUB_TOKEN\n' }], 'plus');
  const result = await deploy(world, { fetchImpl: green(sha) });
  const json = assertRun(result, 'needs-approval');
  assert.equal(result.after, result.before);
  assert.ok(json.lines.some((row) => row.file === 'watchers/mivo/plus.mjs' && row.text.includes('process.env')));
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /--no-ext-diff/);
  assert.match(src, /--no-textconv/);
});

test('#215 SC11 新增文件没有本机绝对路径和邮箱', () => {
  for (const file of [SCRIPT, path.join(HERE, 'deploy-ff.test.mjs'), DOC]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(/\/Users\/[A-Za-z0-9._-]+/.test(text), false, file);
    assert.equal(/@users\.noreply\.github\.com/.test(text), false, file);
  }
  assert.equal(classifyChecks(null, 'a'.repeat(40)), 'ci-unknown');
  assert.equal(classifyChecks({ total_count: 0, check_runs: [] }, 'a'.repeat(40)), 'ci-unknown');
});

// ---- #347：首读拿不到检查结果时同拍再读一次（只重读读检查这一步） ----

// 按调用顺序返回预设响应，并记下每次的 URL；响应用完后重复最后一个。
function scripted(impls) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const impl = impls[Math.min(calls.length - 1, impls.length - 1)];
    return impl(url, init);
  };
  fn.calls = calls;
  return fn;
}

// 重读读到结果的那一拍：原来两行之后多一行说明。
function assertRunNote(result, status) {
  const parts = result.stdout.split('\n');
  assert.equal(parts.length, 4, result.stdout);
  assert.equal(parts[3], '');
  assert.match(parts[2], /重读/);
  const json = JSON.parse(parts[0]);
  assert.equal(json.status, status);
  assert.equal(result.code, EXIT[status]);
  return json;
}

function stateFields(file) {
  return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))).sort();
}

test('#347 SC1 首读空、同拍重读到绿就部署，多一行说明且不写 ci-unknown', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/sc1-reread.md', content: 'reread\n' }], 'reread');
  const fetchImpl = scripted([green(sha, { runs: [] }), green(sha)]);
  const result = await deploy(world, { fetchImpl });
  const parts = result.stdout.split('\n');
  assert.equal(parts.length, 4, result.stdout);
  const json = JSON.parse(parts[0]);
  assert.equal(json.status, 'deployed');
  assert.equal(result.code, EXIT.deployed);
  assert.equal(result.after, sha);
  assert.equal(fetchImpl.calls.length, 2);
  for (const call of fetchImpl.calls) assert.ok(call.url.includes(sha), call.url);
  assert.match(parts[2], /重读/);
  assert.equal(readAlerts(world.alertsFile).some((row) => row.kind === 'deploy-ci-unknown'), false);
});

test('#347 SC2 两次都读不到仍 ci-unknown、不快进、只写一条提醒', { skip: FLOCK_SKIP }, async () => {
  const cases = [
    ['空列表', { runs: [] }, 15_000],
    ['坏格式', { payload: { nope: true } }, 15_000],
    ['500', { status: 500 }, 15_000],
    ['抛错', { throwError: true }, 15_000],
    ['超时', { hang: true }, 40],
  ];
  for (const [label, extra, timeoutMs] of cases) {
    const world = makeWorld();
    const sha = commitAndPush(world, [{ path: 'docs/sc2-reread.md', content: `${label}\n` }], label);
    const fetchImpl = scripted([green(sha, extra), green(sha, extra)]);
    const result = await deploy(world, { fetchImpl, timeoutMs });
    assertRun(result, 'ci-unknown');
    assert.equal(fetchImpl.calls.length, 2, label);
    assert.equal(result.after, result.before, label);
    assert.equal(result.calls.some((args) => args[0] === 'merge'), false, label);
    const rows = readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-ci-unknown');
    assert.equal(rows.length, 1, label);
  }
});

test('#347 SC3 明确红不当成功也不重读；首读绿也只读一次', { skip: FLOCK_SKIP }, async () => {
  const redWorld = makeWorld();
  const redSha = commitAndPush(redWorld, [{ path: 'docs/sc3-red.md', content: 'red\n' }], 'red');
  const redFetch = scripted([red(redSha)]);
  const failed = await deploy(redWorld, { fetchImpl: redFetch });
  assertRun(failed, 'ci-red');
  assert.equal(redFetch.calls.length, 1);
  assert.equal(failed.after, failed.before);
  assert.equal(failed.calls.some((args) => args[0] === 'merge'), false);

  const greenWorld = makeWorld();
  const greenSha = commitAndPush(greenWorld, [{ path: 'docs/sc3-green.md', content: 'green\n' }], 'green');
  const greenFetch = scripted([green(greenSha)]);
  const deployed = await deploy(greenWorld, { fetchImpl: greenFetch });
  assertRun(deployed, 'deployed');
  assert.equal(greenFetch.calls.length, 1);
  assert.equal(deployed.after, greenSha);
});

test('#347 SC4 最多重读一次：两次未知恰好两个请求，ci-pending 只读一次', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/sc4-reread.md', content: 'sc4\n' }], 'sc4');
  const unknown = scripted([green(sha, { runs: [] })]);
  assertRun(await deploy(world, { fetchImpl: unknown }), 'ci-unknown');
  assert.equal(unknown.calls.length, 2);

  const pendingWorld = makeWorld();
  const pendingSha = commitAndPush(pendingWorld, [{ path: 'docs/sc4-pending.md', content: 'p\n' }], 'pending');
  const pending = scripted([
    green(pendingSha, { runs: [{ status: 'in_progress', conclusion: null, head_sha: pendingSha }] }),
  ]);
  assertRun(await deploy(pendingWorld, { fetchImpl: pending }), 'ci-pending');
  assert.equal(pending.calls.length, 1);
});

test('#347 SC5 重读只读同一个目标完整 sha，远端再前进也不改目标', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/sc5-reread.md', content: 'sc5\n' }], 'sc5');
  const fetchImpl = scripted([
    green(sha, { runs: [] }),
    (url, init) => {
      commitAndPush(world, [{ path: 'docs/sc5-later.md', content: 'later\n' }], 'later');
      git(world.deploy, ['fetch', 'origin']);
      return green(sha)(url, init);
    },
  ]);
  const result = await deploy(world, { fetchImpl });
  assertRunNote(result, 'deployed');
  assert.equal(fetchImpl.calls.length, 2);
  for (const call of fetchImpl.calls) assert.ok(call.url.includes(sha), call.url);
  const merges = result.calls.filter((args) => args[0] === 'merge');
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0], ['merge', '--ff-only', sha]);
  assert.equal(result.after, sha);
});

test('#347 SC6 重读成功也不绕敏感批准和轮次空档复检', { skip: FLOCK_SKIP }, async () => {
  const sensitiveWorld = makeWorld();
  const sensitiveSha = commitAndPush(sensitiveWorld,
    [{ path: 'watchers/acceptance/deploy-ff.mjs', content: 'export const self = 1;\n' }], 'sensitive');
  const sensitiveFetch = scripted([green(sensitiveSha, { runs: [] }), green(sensitiveSha)]);
  const blocked = await deploy(sensitiveWorld, { fetchImpl: sensitiveFetch });
  const blockedJson = assertRunNote(blocked, 'needs-approval');
  assert.equal(blockedJson.head, blocked.before);
  assert.equal(blocked.after, blocked.before);
  assert.equal(blocked.calls.some((args) => args[0] === 'merge'), false);

  const busyWorld = makeWorld();
  const busySha = commitAndPush(busyWorld, [{ path: 'docs/sc6-reread.md', content: 'sc6\n' }], 'sc6');
  const busyFetch = scripted([
    green(busySha, { runs: [] }),
    (url, init) => {
      fs.writeFileSync(path.join(busyWorld.host, 'rounds', 'appeared.json'), '{}\n');
      return green(busySha)(url, init);
    },
  ]);
  const waiting = await deploy(busyWorld, { fetchImpl: busyFetch });
  assertRunNote(waiting, 'waiting');
  assert.equal(waiting.after, waiting.before);
  assert.equal(waiting.calls.some((args) => args[0] === 'merge'), false);
});

test('#347 SC7 重读成功多一行说明，提醒与状态文件字段不变', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'docs/sc7-reread.md', content: 'sc7\n' }], 'sc7');
  const result = await deploy(world, { fetchImpl: scripted([green(sha, { runs: [] }), green(sha)]) });
  const parts = result.stdout.split('\n');
  assert.equal(parts.length, 4, result.stdout);
  assert.equal(parts[3], '');
  assert.ok(parts[2].trim().length > 0);
  assert.equal(readAlerts(world.alertsFile).length, 0);
  assert.deepEqual(stateFields(world.stateFile), ['alerted', 'lagReportedFor']);

  const controlWorld = makeWorld();
  const controlSha = commitAndPush(controlWorld, [{ path: 'docs/sc7-control.md', content: 'ctl\n' }], 'ctl');
  const control = await deploy(controlWorld, { fetchImpl: green(controlSha) });
  assertRun(control, 'deployed');
  assert.deepEqual(stateFields(controlWorld.stateFile), ['alerted', 'lagReportedFor']);
});

test('#347 SC8 文档写清重读条件、次数、不重试的状态和说明行', () => {
  const doc = fs.readFileSync(DOC, 'utf8');
  assert.match(doc, /同一次运行里再读一次/);
  assert.match(doc, /首读[\s\S]{0,80}ci-unknown/);
  assert.match(doc, /ci-red[\s\S]{0,40}不重读/);
  assert.match(doc, /最多.{0,10}两个 GET|两个 GET/);
  assert.match(doc, /多一行/);
});

// ---- #425 部署排空：落后超限时占住空出来的轮次槽，不再起新轮，等在跑的轮次结束后部署 ----
function lagBehind(world, count, { date = '2026-11-02T11:30:00Z', prefix = 'drain', entries } = {}) {
  let sha = '';
  for (let i = 0; i < count; i += 1) {
    const files = entries && i === 0 ? entries : [{ path: `docs/${prefix}-${i}.md`, content: `${prefix}${i}\n` }];
    sha = commitAndPush(world, files, `${prefix} ${i}`, date);
  }
  // 先 fetch 一次，HEAD 不动；排空那一步自己也会 fetch（见「#425 返工 排空前先 fetch」）。
  git(world.deploy, ['fetch', 'origin']);
  return sha;
}

const slotsOf = (world) => path.join(world.host, 'slots');
const slotFile = (world, name) => path.join(slotsOf(world), name);
const slotPayload = (world, name) => {
  try { return JSON.parse(fs.readFileSync(slotFile(world, name), 'utf8')); } catch { return null; }
};
const stateOf = (world) => (fs.existsSync(world.stateFile) ? JSON.parse(fs.readFileSync(world.stateFile, 'utf8')) : {});
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};
const busyRounds = (world) => fs.writeFileSync(path.join(world.host, 'rounds', 'active.json'), '{}\n');
const freeRounds = (world) => fs.rmSync(path.join(world.host, 'rounds', 'active.json'), { force: true });

async function waitDead(pid, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !alive(pid);
}

/** 测试结束时把真实的持有进程收掉（正常路径里部署脚本自己会收）。 */
function cleanupHolder(world) {
  const pid = stateOf(world).drain?.holderPid;
  if (Number.isInteger(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已经退出 */ }
  }
}

/** 一个真实存在、活着的「在跑轮次」进程，用来占槽。 */
function fakeRoundProcess() {
  const child = spawn('sleep', ['300'], { stdio: 'ignore', detached: true });
  return { pid: child.pid, stop: () => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已经退出 */ } } };
}

test('#425 落后超限、轮次在跑、两个槽都空：进入 draining，两个槽都被活着的持有进程占住，主循环拿不到槽', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    const sha = lagBehind(world, 6);
    busyRounds(world);
    const result = await deploy(world, { now: () => NOW });
    const json = assertRun(result, 'draining');
    assert.equal(result.code, 30);
    assert.equal(json.lagging, true);
    assert.equal(result.after, result.before, '排空不动部署目录');
    assert.deepEqual(mutations(result.calls), [['fetch', 'origin']], '排空这一拍只 fetch 远端引用，不 merge');
    assert.match(result.stdout.split('\n')[1], /排空/);
    const state = stateOf(world);
    assert.equal(state.drain.status, 'draining');
    assert.equal(state.drain.target, sha);
    assert.deepEqual(state.drain.slots, ['slot-0', 'slot-1']);
    assert.equal(state.drain.deadline, new Date(NOW + DRAIN_MAX_MS).toISOString());
    const holder = state.drain.holderPid;
    assert.equal(alive(holder), true);
    for (const name of ['slot-0', 'slot-1']) assert.equal(slotPayload(world, name).pid, holder);
    // 主循环和 round 用的就是这一套锁：槽被活着的 pid 占着，拿不到。
    assert.equal(acquireSlot({ slotsDir: slotsOf(world) }), null);
    assert.equal(tryAcquireLock(slotFile(world, 'slot-0')), false);
    const drains = readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-draining');
    assert.equal(drains.length, 1);
    assert.match(drains[0].reason, /排空/);
    assert.equal(fs.readdirSync(path.join(world.host, 'rounds')).length, 1, '不碰 rounds/');
  } finally {
    cleanupHolder(world);
  }
});

test('#425 不落后或落后未超限：不占槽，轮次照常拿槽', { skip: FLOCK_SKIP }, async () => {
  for (const count of [0, 5]) {
    const world = makeWorld();
    if (count) lagBehind(world, count);
    busyRounds(world);
    const json = assertRun(await deploy(world, { now: () => NOW }), 'waiting');
    assert.equal(json.lagging, false);
    assert.equal(fs.existsSync(slotsOf(world)) ? fs.readdirSync(slotsOf(world)).length : 0, 0);
    assert.equal(stateOf(world).drain ?? null, null);
    const slot = acquireSlot({ slotsDir: slotsOf(world) });
    assert.equal(slot?.name, 'slot-0', '主循环照常拿槽');
    assert.equal(readAlerts(world.alertsFile).some((row) => row.kind === 'deploy-draining'), false);
  }
});

test('#425 已有轮次占着槽：只占空出来的那个、不抢；轮次放槽后下一拍接着占，同一个持有进程，重复跑结果不变', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const round = fakeRoundProcess();
  try {
    lagBehind(world, 6);
    busyRounds(world);
    fs.mkdirSync(slotsOf(world), { recursive: true });
    const roundLock = JSON.stringify({ pid: round.pid, startedAt: '2026-11-02T11:00:00.000Z' });
    fs.writeFileSync(slotFile(world, 'slot-0'), roundLock);
    assertRun(await deploy(world, { now: () => NOW }), 'draining');
    const first = stateOf(world).drain;
    assert.deepEqual(first.slots, ['slot-1']);
    assert.equal(fs.readFileSync(slotFile(world, 'slot-0'), 'utf8'), roundLock, '在跑轮次的槽原样不动');
    assert.equal(alive(round.pid), true, '不杀轮次');
    assert.equal(slotPayload(world, 'slot-1').pid, first.holderPid);
    // 轮次结束：放掉自己的槽（rounds/ 里还有别的轮次）。
    round.stop();
    await waitDead(round.pid);
    fs.rmSync(slotFile(world, 'slot-0'));
    assertRun(await deploy(world, { now: () => NOW + 5 * 60_000 }), 'draining');
    const second = stateOf(world).drain;
    assert.equal(second.holderPid, first.holderPid, '下一拍接着用同一个持有进程');
    assert.equal(second.startedAt, first.startedAt);
    assert.equal(second.deadline, first.deadline, '不续期');
    assert.deepEqual(second.slots, ['slot-0', 'slot-1']);
    assert.equal(slotPayload(world, 'slot-0').pid, first.holderPid);
    assertRun(await deploy(world, { now: () => NOW + 10 * 60_000 }), 'draining');
    assert.deepEqual(stateOf(world).drain, second, '幂等：再跑一拍状态不变');
    assert.equal(readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-draining').length, 1, '排空提醒只写一次');
  } finally {
    round.stop();
    cleanupHolder(world);
  }
});

test('#425 轮次全部排空后照原流程部署，部署成功后放槽、收掉持有进程', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    const sha = lagBehind(world, 6);
    busyRounds(world);
    assertRun(await deploy(world, { now: () => NOW }), 'draining');
    const holder = stateOf(world).drain.holderPid;
    freeRounds(world);
    const done = await deploy(world, { now: () => NOW + 60_000, fetchImpl: green(sha) });
    assertRun(done, 'deployed');
    assert.equal(done.after, sha);
    assert.equal(fs.existsSync(slotFile(world, 'slot-0')), false);
    assert.equal(fs.existsSync(slotFile(world, 'slot-1')), false);
    assert.equal(await waitDead(holder), true);
    assert.equal(stateOf(world).drain ?? null, null);
    assert.equal(acquireSlot({ slotsDir: slotsOf(world) })?.name, 'slot-0', '主循环恢复拿槽');
  } finally {
    cleanupHolder(world);
  }
});

test('#425 排空中部署结果是需要批准或 doctor 失败：同样放槽', { skip: FLOCK_SKIP }, async () => {
  const approval = makeWorld();
  try {
    lagBehind(approval, 6);
    busyRounds(approval);
    assertRun(await deploy(approval, { now: () => NOW }), 'draining');
    const holder = stateOf(approval).drain.holderPid;
    // 排空期间 main 上又合进一个敏感改动，轮次结束后部署时才发现要批准。
    const sensitive = commitAndPush(approval, [{ path: 'watchers/acceptance/host/tick.mjs', content: 'x\n' }], 'host', '2026-11-02T11:40:00Z');
    freeRounds(approval);
    assertRun(await deploy(approval, { now: () => NOW + 60_000, fetchImpl: green(sensitive) }), 'needs-approval');
    assert.equal(fs.existsSync(slotFile(approval, 'slot-0')), false);
    assert.equal(fs.existsSync(slotFile(approval, 'slot-1')), false);
    assert.equal(await waitDead(holder), true);
    assert.equal(stateOf(approval).drain ?? null, null);
  } finally {
    cleanupHolder(approval);
  }
  const doctor = makeWorld();
  try {
    const sha = lagBehind(doctor, 6);
    busyRounds(doctor);
    assertRun(await deploy(doctor, { now: () => NOW }), 'draining');
    freeRounds(doctor);
    const failed = await deploy(doctor, {
      now: () => NOW + 60_000,
      fetchImpl: green(sha),
      runDoctor: () => ({ code: 1, stdout: 'bad', stderr: '' }),
    });
    assertRun(failed, 'doctor-failed');
    assert.equal(fs.existsSync(slotFile(doctor, 'slot-0')), false);
    assert.equal(stateOf(doctor).drain ?? null, null);
  } finally {
    cleanupHolder(doctor);
  }
});

test('#425 排空超过 120 分钟：放槽、收持有进程、写一次超时提醒；冷却 30 分钟内不再排空，之后再排空', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    lagBehind(world, 6);
    busyRounds(world);
    assertRun(await deploy(world, { now: () => NOW }), 'draining');
    const holder = stateOf(world).drain.holderPid;
    const timedOut = await deploy(world, { now: () => NOW + DRAIN_MAX_MS });
    const json = assertRun(timedOut, 'waiting');
    assert.match(json.reason, /120 分钟/);
    assert.equal(fs.existsSync(slotFile(world, 'slot-0')), false);
    assert.equal(fs.existsSync(slotFile(world, 'slot-1')), false);
    assert.equal(await waitDead(holder), true);
    assert.equal(stateOf(world).drain ?? null, null);
    assert.equal(readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-drain-timeout').length, 1);
    assert.equal(acquireSlot({ slotsDir: slotsOf(world) })?.name, 'slot-0', '超时后主循环恢复拿槽');
    fs.rmSync(slotFile(world, 'slot-0'));
    assertRun(await deploy(world, { now: () => NOW + DRAIN_MAX_MS + DRAIN_COOLDOWN_MS - 1 }), 'waiting');
    assert.equal(fs.existsSync(slotFile(world, 'slot-0')), false, '冷却期内不排空');
    assertRun(await deploy(world, { now: () => NOW + DRAIN_MAX_MS + DRAIN_COOLDOWN_MS }), 'draining');
  } finally {
    cleanupHolder(world);
  }
});

test('#425 需要批准（敏感改动未批准）时不排空；批准了目标完整 sha 才排空', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    const sha = lagBehind(world, 6, { entries: [{ path: 'watchers/acceptance/host/tick.mjs', content: 'y\n' }] });
    busyRounds(world);
    const json = assertRun(await deploy(world, { now: () => NOW }), 'waiting');
    assert.equal(json.lagging, true);
    assert.equal(fs.existsSync(slotsOf(world)) ? fs.readdirSync(slotsOf(world)).length : 0, 0);
    assert.equal(stateOf(world).drain ?? null, null);
    const content = assertRun(await deploy(world, { now: () => NOW, approve: 'f'.repeat(40) }), 'waiting');
    assert.equal(content.status, 'waiting', '批准的不是目标 sha 也不排空');
    fs.writeFileSync(world.approvalFile, `${sha}\n`);
    assertRun(await deploy(world, { now: () => NOW, approvalFile: world.approvalFile }), 'waiting');
    assert.equal(stateOf(world).drain ?? null, null, '只有 SHA 文件仍不排空');
    assertRun(await deploy(world, {
      now: () => NOW,
      approvalFile: world.approvalFile,
      grant: grantFor(world, { nowMs: NOW }),
    }), 'draining');
    assert.equal(fs.existsSync(world.approvalFile), true, '排空不消费批准文件');
  } finally {
    cleanupHolder(world);
  }
});

test('#425 持有进程意外没了：下一拍重新起一个接着占槽，不重复提醒', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    lagBehind(world, 6);
    busyRounds(world);
    assertRun(await deploy(world, { now: () => NOW }), 'draining');
    const first = stateOf(world).drain;
    process.kill(first.holderPid, 'SIGKILL');
    await waitDead(first.holderPid);
    assertRun(await deploy(world, { now: () => NOW + 5 * 60_000 }), 'draining');
    const second = stateOf(world).drain;
    assert.notEqual(second.holderPid, first.holderPid);
    assert.equal(alive(second.holderPid), true);
    assert.equal(second.deadline, first.deadline, '截止时间不变');
    for (const name of ['slot-0', 'slot-1']) assert.equal(slotPayload(world, name).pid, second.holderPid);
    assert.equal(readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-draining').length, 1);
  } finally {
    cleanupHolder(world);
  }
});

test('#425 持有进程到时自己放槽退出，只删写着自己 pid 的槽', { skip: FLOCK_SKIP }, async () => {
  const dir = tmpDir('drain-holder-');
  const mine = path.join(dir, 'slot-0');
  const other = path.join(dir, 'slot-1');
  const pid = spawnDrainHolder({ ttlMs: 300, files: [mine, other] });
  assert.equal(Number.isInteger(pid), true);
  fs.writeFileSync(mine, JSON.stringify({ pid, startedAt: new Date().toISOString() }));
  fs.writeFileSync(other, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.equal(await waitDead(pid, 5000), true);
  assert.equal(fs.existsSync(mine), false);
  assert.equal(fs.existsSync(other), true, '别人的槽不动');
});

// #425 复审 P2：主循环每 3 分钟起轮次、部署脚本 5 分钟一拍，只靠部署脚本补占，空出来的槽会被主循环先拿走。
// 持有进程自己每秒补占：在跑的轮次一结束（留下死 pid 的槽，或正常收尾删掉槽文件），主循环下一拍就拿不到槽。
const slotPid = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).pid;
  } catch {
    return null;
  }
};
async function waitUntil(check, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

test('#425 复审 持有进程每秒自己补占空出来的槽：在跑的轮次一结束，主循环就拿不到槽', async () => {
  const dir = tmpDir('drain-holder-poll-');
  const slots = ['slot-0', 'slot-1'].map((name) => path.join(dir, name));
  const round = fakeRoundProcess();
  let holder = null;
  try {
    fs.writeFileSync(slots[0], JSON.stringify({ pid: round.pid, startedAt: new Date().toISOString() }));
    holder = spawnDrainHolder({ ttlMs: 30_000, files: slots });
    assert.equal(Number.isInteger(holder), true);
    assert.equal(await waitUntil(() => slotPid(slots[1]) === holder), true, '空槽自己占上');
    assert.equal(slotPid(slots[0]), round.pid, '在跑的轮次的槽不抢');
    assert.equal(acquireSlot({ slotsDir: dir }), null, '两个槽都占着');

    // 轮次被打断：槽文件还在，写着已经死掉的 pid。
    round.stop();
    assert.equal(await waitDead(round.pid, 5000), true);
    assert.equal(await waitUntil(() => slotPid(slots[0]) === holder), true, '死 pid 的槽自己补占');
    assert.equal(acquireSlot({ slotsDir: dir }), null, '主循环下一拍拿不到槽');

    // 正常收尾：轮次删掉自己的槽文件。
    fs.unlinkSync(slots[0]);
    assert.equal(await waitUntil(() => slotPid(slots[0]) === holder), true, '删掉的槽自己补占');
    assert.equal(acquireSlot({ slotsDir: dir }), null);
  } finally {
    round.stop();
    if (holder) {
      try { process.kill(holder, 'SIGTERM'); } catch { /* 已经退出 */ }
      await waitDead(holder, 5000);
    }
  }
  assert.equal(fs.existsSync(slots[0]) || fs.existsSync(slots[1]), false, '收到 SIGTERM 删掉自己占的槽');
});

test('SC4 判死后、删前被新轮次写入的活锁必须保留', () => {
  const dir = tmpDir('lock-race-');
  const file = path.join(dir, 'slot-0');
  const dead = deadPid();
  const stale = JSON.stringify({ pid: dead, startedAt: '2026-11-12T12:00:00.000Z' });
  const live = JSON.stringify({ pid: process.pid, startedAt: '2026-11-13T01:00:00.000Z' });

  // 直接调用：路径上已经是活锁，但删除时拿的是先前观察到的死锁内容。
  fs.writeFileSync(file, live);
  assert.equal(removeLockIfUnchanged(file, stale, { fs, path, crypto }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), live, '内容对不上时活锁保留');

  // 同一份死锁才删。
  fs.writeFileSync(file, stale);
  assert.equal(removeLockIfUnchanged(file, stale, { fs, path, crypto }), true);
  assert.equal(fs.existsSync(file), false, '确认是同一份陈旧锁才删');

  // claimSlot：判死后、删前插入新轮次写入的活锁，不得占槽、不得删活锁。
  fs.writeFileSync(file, stale);
  const claimed = claimSlot(file, 9_999_999, Date.now(), {
    afterDeadPid() {
      fs.unlinkSync(file);
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, live); } finally { fs.closeSync(fd); }
    },
  });
  assert.equal(claimed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), live, '新轮次活锁必须保留');

  // 负面：真正的死锁可以被占掉；活着的锁不抢。
  fs.writeFileSync(file, stale);
  assert.equal(claimSlot(file, 8_888_888, Date.now()), true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 8_888_888);
  fs.writeFileSync(file, live);
  assert.equal(claimSlot(file, 7_777_777, Date.now()), false);
  assert.equal(fs.readFileSync(file, 'utf8'), live);

  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /removeLockIfUnchanged/);
  assert.match(src, /linkSync/);
});

const staleTemps = (dir, base) => fs.readdirSync(dir)
  .filter((name) => name.startsWith(`.${base}.stale-`))
  .map((name) => path.join(dir, name));

const writeLock = (file, payload) => {
  try { fs.unlinkSync(file); } catch { /* 还没有 */ }
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, typeof payload === 'string' ? payload : JSON.stringify(payload)); }
  finally { fs.closeSync(fd); }
};

test('SC4 放回因 EEXIST 失败时保留临时文件和新锁并告警', () => {
  const dir = tmpDir('lock-eexist-');
  const file = path.join(dir, 'slot-0');
  const alertsFile = path.join(dir, 'alerts.jsonl');
  const dead = deadPid();
  const stale = JSON.stringify({ pid: dead, startedAt: '2026-11-12T12:00:00.000Z' });
  const moved = JSON.stringify({ pid: 424242, startedAt: '2026-11-13T01:00:00.000Z' });
  const newer = JSON.stringify({ pid: process.pid, startedAt: '2026-11-13T01:01:00.000Z' });
  fs.writeFileSync(file, moved);
  assert.equal(removeLockIfUnchanged(file, stale, {
    fs,
    path,
    crypto,
    hooks: { afterRename() { writeLock(file, newer); } },
    onRestoreFailed: ({ tmp, moved, current }) => appendLockRestoreAlert(alertsFile, { tmp, moved, current }),
  }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), newer, '新锁保留');
  const temps = staleTemps(dir, 'slot-0');
  assert.equal(temps.length, 1, '临时文件保留');
  assert.equal(fs.readFileSync(temps[0], 'utf8'), moved);
  const rows = readAlerts(alertsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, LOCK_RESTORE_FAILED_KIND);
  assert.match(rows[0].reason, new RegExp(temps[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rows[0].reason, /424242/);
  assert.match(rows[0].reason, new RegExp(String(process.pid)));
  assert.match(rows[0].reason, /没有删除/);
  assert.match(rows[0].reason, /请人核对/);
  assert.match(rows[0].detail, new RegExp(temps[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rows[0].detail, /movedPid=424242/);
  assert.match(rows[0].detail, new RegExp(`currentPid=${process.pid}`));
});

test('SC4 持有进程与宿主共用同一份 removeLockIfUnchanged 源码', () => {
  const shared = removeLockIfUnchanged.toString();
  assert.equal(DRAIN_HOLDER_CODE.includes(shared), true, '持有进程注入的是同一函数源码');
  assert.equal(DRAIN_HOLDER_CODE.includes('applyTestHook'), false);
  assert.equal(DRAIN_HOLDER_CODE.includes('DEPLOY_FF_TEST_LOCK_HOOK'), false);
  assert.match(DRAIN_HOLDER_CODE, /onRestoreFailed/);
  assert.match(DRAIN_HOLDER_CODE, /alertsFile/);

  // 同一实现、持有进程那种告警回调：rename 后、link 前出现新锁时，新锁和临时文件都保留并写出提醒。
  const dir = tmpDir('lock-shared-');
  const file = path.join(dir, 'slot-0');
  const alertsFile = path.join(dir, 'alerts.jsonl');
  const stale = JSON.stringify({ pid: deadPid(), startedAt: '2026-11-12T12:00:00.000Z' });
  const moved = JSON.stringify({ pid: 424242, startedAt: '2026-11-13T01:00:00.000Z' });
  const newer = JSON.stringify({ pid: process.pid, startedAt: '2026-11-13T01:01:00.000Z' });
  fs.writeFileSync(file, moved);
  const onRestoreFailed = ({ tmp, moved: movedBuf, current }) => appendLockRestoreAlert(alertsFile, { tmp, moved: movedBuf, current });
  assert.equal(removeLockIfUnchanged(file, stale, {
    fs,
    path,
    crypto,
    onRestoreFailed,
    hooks: { afterRename() { writeLock(file, newer); } },
  }), false);
  assert.equal(fs.readFileSync(file, 'utf8'), newer, '新锁保留');
  const temps = staleTemps(dir, 'slot-0');
  assert.equal(temps.length, 1, '临时文件保留');
  assert.equal(fs.readFileSync(temps[0], 'utf8'), moved);
  const rows = readAlerts(alertsFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, LOCK_RESTORE_FAILED_KIND);
  assert.match(rows[0].reason, new RegExp(temps[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rows[0].reason, /424242/);
  assert.match(rows[0].reason, new RegExp(String(process.pid)));
  assert.match(rows[0].reason, /没有删除/);
  assert.match(rows[0].reason, /请人核对/);
  assert.match(rows[0].detail, new RegExp(temps[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(rows[0].detail, /movedPid=424242/);
  assert.match(rows[0].detail, new RegExp(`currentPid=${process.pid}`));
});

test('#425 部署脚本不碰写闸、不杀轮次', () => {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(src, /write-gate|enabledFile/);
  // 只对自己起的持有进程发信号（命令行带标记才认）。
  const kills = src.split('\n').filter((line) => /process\.kill\(/.test(line));
  for (const line of kills) assert.match(line, /holder|pid, 0|-child\.pid|child\.pid/, line);
});

// ---- #425 返工：排空前先 fetch；只认活着的登记；截止边界；拉取失败、检查在跑时放槽 ----
/** 一个确定已经退出的 pid（模拟被 SIGKILL / OOM 打断的轮次留下的登记）。 */
function deadPid() {
  const pid = spawnSync('true').pid;
  assert.equal(alive(pid), false);
  return pid;
}

function recordingGit(calls, override) {
  return (cwd, args) => {
    calls.push(args);
    const forced = override ? override(args) : null;
    return forced || defaultRunGit(cwd, args);
  };
}

const failFetch = (args) => (args[0] === 'fetch' ? { ok: false, status: 1, stdout: '', stderr: 'could not fetch' } : null);
const writeEntry = (world, rel, content) => fs.writeFileSync(path.join(world.host, rel), content);
const staleAlerts = (world) => readAlerts(world.alertsFile).filter((row) => row.kind === 'deploy-drain-stale-locks');

test('#425 返工 排空前先 fetch：本地 origin/main 是旧的也能算出落后并排空，工作区和 HEAD 不动', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    let sha = '';
    for (let i = 0; i < 6; i += 1) sha = commitAndPush(world, [{ path: `docs/nofetch-${i}.md`, content: `${i}\n` }], `n ${i}`, '2026-11-02T11:30:00Z');
    // 部署目录没 fetch 过：本地 origin/main 还是旧的，只靠本地引用算不出落后。
    assert.notEqual(git(world.deploy, ['rev-parse', 'origin/main']), sha);
    busyRounds(world);
    const result = await deploy(world, { now: () => NOW });
    const json = assertRun(result, 'draining');
    assert.equal(json.target, sha);
    assert.equal(json.behind, 6);
    assert.deepEqual(mutations(result.calls), [['fetch', 'origin']], '只 fetch 远端引用，不 merge');
    assert.equal(result.after, result.before, 'HEAD 不动');
    assert.equal(git(world.deploy, ['status', '--porcelain']), '', '工作区不动');
  } finally {
    cleanupHolder(world);
  }
});

test('#425 返工 排空这一步 fetch 失败：fetch-failed，放槽、收持有进程，不写提醒', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    lagBehind(world, 6);
    busyRounds(world);
    assertRun(await deploy(world, { now: () => NOW }), 'draining');
    const holder = stateOf(world).drain.holderPid;
    const calls = [];
    const failed = await deploy(world, { now: () => NOW + 5 * 60_000, runGit: recordingGit(calls, failFetch) });
    assertRun(failed, 'fetch-failed');
    assert.equal(calls.some((args) => args[0] === 'merge'), false);
    assert.equal(fs.existsSync(slotFile(world, 'slot-0')), false);
    assert.equal(fs.existsSync(slotFile(world, 'slot-1')), false);
    assert.equal(await waitDead(holder), true);
    assert.equal(stateOf(world).drain ?? null, null);
    assert.equal(readAlerts(world.alertsFile).some((row) => row.kind === 'deploy-fetch-failed'), false);
  } finally {
    cleanupHolder(world);
  }
});

test('#425 返工 rounds/、locks/ 全是残留（pid 已死）：不排空、不占槽，写一条残留提醒，重复跑不重复写；已在排空的放槽', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    lagBehind(world, 6);
    busyRounds(world);
    assertRun(await deploy(world, { now: () => NOW }), 'draining');
    const holder = stateOf(world).drain.holderPid;
    // 轮次被 SIGKILL：登记和 mivo 测试锁留下来，写的 pid 已经不在。
    freeRounds(world);
    const pid = deadPid();
    writeEntry(world, 'rounds/example-org__demo-repo__7__1.json', JSON.stringify({ issue: 'example-org/demo-repo#7', round: 1, pid, piPid: null, startedAt: '2026-11-02T10:00:00.000Z' }));
    writeEntry(world, 'locks/mivo-test.lock', JSON.stringify({ pid, startedAt: '2026-11-02T10:00:00.000Z' }));
    const first = await deploy(world, { now: () => NOW + 5 * 60_000 });
    const json = assertRun(first, 'waiting');
    assert.equal(json.lagging, true);
    assert.equal(await waitDead(holder), true, '已在排空的持有进程收掉');
    assert.equal(fs.existsSync(slotFile(world, 'slot-0')), false);
    assert.equal(fs.existsSync(slotFile(world, 'slot-1')), false);
    assert.equal(stateOf(world).drain ?? null, null);
    assert.equal(acquireSlot({ slotsDir: slotsOf(world) })?.name, 'slot-0', '主循环照常拿槽');
    fs.rmSync(slotFile(world, 'slot-0'));
    let rows = staleAlerts(world);
    assert.equal(rows.length, 1);
    assert.match(rows[0].reason, /rounds\/example-org__demo-repo__7__1\.json/);
    assert.match(rows[0].reason, /locks\/mivo-test\.lock/);
    assert.match(rows[0].reason, /不排空/);
    assert.match(rows[0].reason, /人/);
    assertRun(await deploy(world, { now: () => NOW + 10 * 60_000 }), 'waiting');
    rows = staleAlerts(world);
    assert.equal(rows.length, 1, '同一个 HEAD 和目标只写一次');
    assert.equal(fs.existsSync(slotFile(world, 'slot-0')), false);
    assert.equal(fs.existsSync(path.join(world.host, 'locks', 'mivo-test.lock')), true, '不删残留文件，留给人看');
  } finally {
    cleanupHolder(world);
  }
});

test('#425 返工 活的加残留混在一起：不排空（在跑的结束后残留仍挡部署），提醒只列残留那个', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const round = fakeRoundProcess();
  try {
    lagBehind(world, 6);
    writeEntry(world, 'rounds/example-org__demo-repo__8__1.json', JSON.stringify({ issue: 'example-org/demo-repo#8', round: 1, pid: round.pid, startedAt: '2026-11-02T11:00:00.000Z' }));
    writeEntry(world, 'locks/mirror-demo.lock', JSON.stringify({ pid: deadPid(), startedAt: '2026-11-02T10:00:00.000Z' }));
    assertRun(await deploy(world, { now: () => NOW }), 'waiting');
    assert.equal(fs.existsSync(slotsOf(world)) ? fs.readdirSync(slotsOf(world)).length : 0, 0, '不占槽');
    assert.equal(stateOf(world).drain ?? null, null);
    assert.equal(alive(round.pid), true, '不杀轮次');
    const rows = staleAlerts(world);
    assert.equal(rows.length, 1);
    assert.match(rows[0].reason, /locks\/mirror-demo\.lock/);
    assert.doesNotMatch(rows[0].reason, /demo-repo__8__1/);
  } finally {
    round.stop();
    cleanupHolder(world);
  }
});

test('#425 返工 读不出 pid 的登记：10 分钟内的按在跑算会排空，更老的按残留算不排空；写着活 pid 的不看时间', { skip: FLOCK_SKIP }, async () => {
  const fresh = makeWorld();
  try {
    lagBehind(fresh, 6);
    writeEntry(fresh, 'locks/half.lock', 'not json');
    const file = path.join(fresh.host, 'locks', 'half.lock');
    fs.utimesSync(file, new Date(NOW - 10 * 60_000), new Date(NOW - 10 * 60_000));
    assertRun(await deploy(fresh, { now: () => NOW }), 'draining');
  } finally {
    cleanupHolder(fresh);
  }
  const old = makeWorld();
  try {
    lagBehind(old, 6);
    writeEntry(old, 'rounds/broken.json', '{}');
    const file = path.join(old.host, 'rounds', 'broken.json');
    fs.utimesSync(file, new Date(NOW - 10 * 60_000 - 1), new Date(NOW - 10 * 60_000 - 1));
    assertRun(await deploy(old, { now: () => NOW }), 'waiting');
    assert.equal(stateOf(old).drain ?? null, null);
    assert.match(staleAlerts(old)[0]?.reason || '', /rounds\/broken\.json/);
  } finally {
    cleanupHolder(old);
  }
  const live = makeWorld();
  try {
    lagBehind(live, 6);
    writeEntry(live, 'rounds/live.json', JSON.stringify({ issue: 'example-org/demo-repo#9', round: 1, pid: process.pid }));
    const file = path.join(live.host, 'rounds', 'live.json');
    fs.utimesSync(file, new Date(NOW - 24 * 60 * 60_000), new Date(NOW - 24 * 60 * 60_000));
    assertRun(await deploy(live, { now: () => NOW }), 'draining');
    assert.equal(staleAlerts(live).length, 0);
  } finally {
    cleanupHolder(live);
  }
});

test('#425 返工 截止边界：截止前 1 毫秒仍在排空不放槽，截止时刻放槽', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    lagBehind(world, 6);
    busyRounds(world);
    assertRun(await deploy(world, { now: () => NOW }), 'draining');
    const first = stateOf(world).drain;
    assertRun(await deploy(world, { now: () => NOW + DRAIN_MAX_MS - 1 }), 'draining');
    const before = stateOf(world).drain;
    assert.equal(before.holderPid, first.holderPid);
    assert.equal(alive(first.holderPid), true);
    for (const name of ['slot-0', 'slot-1']) assert.equal(slotPayload(world, name).pid, first.holderPid);
    assertRun(await deploy(world, { now: () => NOW + DRAIN_MAX_MS }), 'waiting');
    assert.equal(await waitDead(first.holderPid), true);
    assert.equal(fs.existsSync(slotFile(world, 'slot-0')), false);
    assert.equal(fs.existsSync(slotFile(world, 'slot-1')), false);
  } finally {
    cleanupHolder(world);
  }
});

test('#425 返工 排空中轮次结束后检查还在跑（ci-pending）或拉取失败（fetch-failed）：放槽', { skip: FLOCK_SKIP }, async () => {
  const pending = makeWorld();
  try {
    const sha = lagBehind(pending, 6);
    busyRounds(pending);
    assertRun(await deploy(pending, { now: () => NOW }), 'draining');
    const holder = stateOf(pending).drain.holderPid;
    freeRounds(pending);
    const result = await deploy(pending, {
      now: () => NOW + 60_000,
      fetchImpl: green(sha, { runs: [{ status: 'in_progress', conclusion: null, head_sha: sha }] }),
    });
    assertRun(result, 'ci-pending');
    assert.equal(result.after, result.before);
    assert.equal(await waitDead(holder), true);
    assert.equal(fs.existsSync(slotFile(pending, 'slot-0')), false);
    assert.equal(stateOf(pending).drain ?? null, null);
  } finally {
    cleanupHolder(pending);
  }
  const fetchFail = makeWorld();
  try {
    lagBehind(fetchFail, 6);
    busyRounds(fetchFail);
    assertRun(await deploy(fetchFail, { now: () => NOW }), 'draining');
    const holder = stateOf(fetchFail).drain.holderPid;
    freeRounds(fetchFail);
    assertRun(await deploy(fetchFail, { now: () => NOW + 60_000, runGit: recordingGit([], failFetch) }), 'fetch-failed');
    assert.equal(await waitDead(holder), true);
    assert.equal(fs.existsSync(slotFile(fetchFail, 'slot-1')), false);
    assert.equal(stateOf(fetchFail).drain ?? null, null);
  } finally {
    cleanupHolder(fetchFail);
  }
});

test('#425 返工 locked（另一个实例拿着本脚本的锁）不碰那个实例的排空', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    lagBehind(world, 6);
    busyRounds(world);
    assertRun(await deploy(world, { now: () => NOW }), 'draining');
    const drain = stateOf(world).drain;
    const release = await holdLock(world.selfLock);
    try {
      assertRun(await deploy(world, { now: () => NOW + 60_000 }), 'locked');
    } finally {
      release();
    }
    assert.deepEqual(stateOf(world).drain, drain);
    assert.equal(alive(drain.holderPid), true);
    for (const name of ['slot-0', 'slot-1']) assert.equal(slotPayload(world, name).pid, drain.holderPid);
  } finally {
    cleanupHolder(world);
  }
});

test('B SC3 仅 SHA 文件或仅 --approve 不能放行敏感快进', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  fs.writeFileSync(world.approvalFile, `${sha}\n`);
  const byFile = await deploy(world, { fetchImpl: green(sha), approvalFile: world.approvalFile });
  assertRun(byFile, 'needs-approval');
  assert.equal(byFile.after, byFile.before);
  assert.equal(fs.existsSync(world.approvalFile), true);
  const byFlag = await deploy(world, { fetchImpl: green(sha), approve: sha });
  assertRun(byFlag, 'needs-approval');
  assert.equal(byFlag.after, byFlag.before);
});

test('B SC3 完整授予记录是明确执行路径；bot 评论和 approved 文本不行', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const grant = grantFor(world);
  const ok = await deploy(world, { fetchImpl: green(sha), grant });
  assertRun(ok, 'deployed');
  assert.equal(ok.after, sha);
  const bot = makeWorld();
  const botSha = commitAndPush(bot, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const botRun = await deploy(bot, {
    fetchImpl: green(botSha),
    grant: { kind: 'bot-comment', authorType: 'Bot', body: `${botSha}\napproved` },
  });
  assertRun(botRun, 'needs-approval');
  assert.equal(botRun.after, botRun.before);
  assert.match(botRun.json.reason, /bot 评论/);
  const text = makeWorld();
  const textSha = commitAndPush(text, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const textRun = await deploy(text, { fetchImpl: green(textSha), grant: 'approved' });
  assertRun(textRun, 'needs-approval');
  assert.equal(textRun.after, textRun.before);
  const user = makeWorld();
  const userSha = commitAndPush(user, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const userRun = await deploy(user, {
    fetchImpl: green(userSha),
    grant: { login: 'ExampleUser', type: 'User', body: userSha },
  });
  assertRun(userRun, 'needs-approval');
  assert.match(userRun.json.reason, /不能单独证明/);
});

test('B SC2 旧 SHA、短 SHA、区间不符、过期不改工作区也不排空', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  try {
    lagBehind(world, 6, { entries: [{ path: 'watchers/acceptance/host/tick.mjs', content: 'y\n' }] });
    busyRounds(world);
    const stale = grantFor(world, { nowMs: NOW, overrides: { targetSha: 'd'.repeat(40) } });
    assertRun(await deploy(world, { now: () => NOW, grant: stale }), 'waiting');
    assert.equal(stateOf(world).drain ?? null, null);
    assert.equal(fs.existsSync(slotsOf(world)) ? fs.readdirSync(slotsOf(world)).length : 0, 0);
  } finally {
    cleanupHolder(world);
  }
  const idle = makeWorld();
  const idleSha = commitAndPush(idle, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const expired = grantFor(idle, { nowMs: NOW, overrides: { expiresAt: new Date(NOW - 1).toISOString() } });
  const expiredRun = await deploy(idle, { fetchImpl: green(idleSha), grant: expired, now: () => NOW });
  assertRun(expiredRun, 'needs-approval');
  assert.equal(expiredRun.after, expiredRun.before);
  const short = await deploy(idle, {
    fetchImpl: green(idleSha),
    grant: grantFor(idle, { nowMs: NOW }),
    approve: idleSha.slice(0, 7),
    now: () => NOW,
  });
  assertRun(short, 'needs-approval');
  assert.equal(short.after, short.before);
});

test('B SC1 敏感部署追加审计且写失败则快进前失败关闭', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const before = git(world.deploy, ['rev-parse', 'HEAD']);
  const range = rangeOf(world);
  const result = await deploy(world, { fetchImpl: green(sha), grant: grantFor(world) });
  assertRun(result, 'deployed');
  const rows = auditOf(world);
  assert.ok(rows.length >= 2);
  assert.equal(rows[0].outcome, 'attempt');
  assert.equal(rows[1].outcome, 'deployed');
  assert.equal(rows[0].previousSha, before);
  assert.equal(rows[1].targetSha, sha);
  assert.deepEqual(rows[1].commits, range.commits);
  assert.equal(rows[1].sensitiveRuleVersion, SENSITIVE_RULE_VERSION);
  assert.deepEqual(rows[1].grantSource.ids, ['t710u', 't711u']);
  assert.equal(rows[0].attemptId, rows[1].attemptId);
  const first = fs.readFileSync(path.join(path.dirname(world.stateFile), 'deploy-ff-audit.jsonl'), 'utf8');
  const again = await deploy(world, { fetchImpl: green(sha), grant: grantFor(world) });
  assertRun(again, 'up-to-date');
  assert.equal(again.after, sha);
  assert.equal(fs.readFileSync(path.join(path.dirname(world.stateFile), 'deploy-ff-audit.jsonl'), 'utf8'), first);

  const blocked = makeWorld();
  const blockedSha = commitAndPush(blocked, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const fail = await deploy(blocked, {
    fetchImpl: green(blockedSha),
    grant: grantFor(blocked),
    appendAudit: () => { throw new Error('disk full'); },
  });
  assertRun(fail, 'needs-approval');
  assert.equal(fail.after, fail.before);
  assert.equal(fail.calls.some((args) => args[0] === 'merge'), false);
  assert.match(fail.json.reason, /审计日志写失败，未执行/);
});

test('B SC5 拒绝可重复执行且旧审计行不覆盖', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  const first = await deploy(world, { fetchImpl: green(sha) });
  assertRun(first, 'needs-approval');
  const second = await deploy(world, { fetchImpl: green(sha) });
  assertRun(second, 'needs-approval');
  const rows = auditOf(world).filter((row) => row.outcome === 'rejected');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].targetSha, sha);
  assert.equal(rows[1].targetSha, sha);
  assert.notEqual(rows[0].attemptId, rows[1].attemptId);
});

test('B SC6 新机制不能自证旧 SHA 文件；本轮不提交生产授予文件', { skip: FLOCK_SKIP }, async () => {
  const world = makeWorld();
  const sha = commitAndPush(world, [{ path: 'watchers/acceptance/host/note.mjs', content: 'export const n = 1;\n' }], 'gate');
  fs.writeFileSync(world.approvalFile, `${sha}\n`);
  const result = await deploy(world, {
    fetchImpl: green(sha),
    approvalFile: world.approvalFile,
    grant: { schema: 'vigil-deploy-grant/v1', kind: 'legacy-sha-file', provesLegacy: true, targetSha: sha },
  });
  assertRun(result, 'needs-approval');
  assert.match(result.json.reason, /不能自行证明旧门禁/);
  const tracked = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n');
  assert.equal(tracked.some((file) => /deploy-ff-grant|production-grant|grant\.json$/.test(file)), false);
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'fleet-deploy-authorization.md'), 'utf8');
  assert.match(doc, /自举/);
  assert.match(doc, /回滚/);
  assert.match(doc, /威胁模型/);
  assert.match(doc, /不声称密码学保证|不是密码学保证/);
});

