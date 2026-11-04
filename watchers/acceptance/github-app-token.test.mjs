// App 安装令牌分流只读轮询（appTokenCommand）：读优先走 App，取不到 / 401 / 403 / 404 回退账号令牌重试一次并记 loop.log；
// App 没装的 owner 直接走账号令牌；写一律账号令牌。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGithub, defaultRun } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { prepareSandboxProfile } from './host/sandbox.mjs';
import { OWNER, createFakeRun, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const APP_TOKEN = 'app-install-token-zzz';
const OWNER_REPO = `${OWNER}/repo-a`;
const OTHER_ORG = 'other-org';
const Q = 'query ($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { issue(number: $number) { id } } }';

function setup(profileExtra = {}) {
  const { home } = writeProfile(tmpDir(), { profile: { appTokenCommand: ['fake-app-token', '--print'], ...profileExtra } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const loopLog = path.join(home, 'state', 'host', 'loop.log');
  return { home, profile, loopLog };
}

function tokenCmd({ code = 0, token = APP_TOKEN } = {}) {
  const calls = [];
  const onOther = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd !== 'fake-app-token') return { code: 1, stdout: '', stderr: 'unexpected' };
    return code === 0 ? { code: 0, stdout: `${token}\n`, stderr: '' } : { code, stdout: '', stderr: `Traceback: boom ${token}` };
  };
  onOther.calls = calls;
  return onOther;
}

const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

test('#163 SC1 取令牌命令超时整组杀掉：命令起的孙进程不能拖着这次读不返回', async () => {
  const dir = tmpDir();
  const pidFile = path.join(dir, 'token-command-child.pid');
  // 命令自己忽略 SIGTERM，并起一个同样忽略 SIGTERM 的孙进程。只杀直接子进程时，孙进程会继续拿着
  // stdout/stderr，close 迟迟不来；整组杀掉才能按 30 秒超时回退账号令牌。
  const script = `trap '' TERM; sh -c 'trap "" TERM; echo $$ > ${pidFile}; sleep 3' & wait`;
  const started = Date.now();
  const result = await defaultRun('sh', ['-c', script], { timeoutMs: 300, killGroup: true });
  assert.equal(result.code, 124, '超时按 124 收尾，交给回退逻辑');
  assert.ok(Date.now() - started < 4000, 'SIGTERM 宽限 + SIGKILL 内收尾');
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, `孙进程 ${pid} 应已随进程组一起被杀`);
});

test('App 成功：App 覆盖的 owner 读走 App 令牌，取令牌命令带超时和进程组', async () => {
  const { profile, loopLog } = setup();
  const onOther = tokenCmd();
  const fake = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }), onOther });
  const seen = [];
  const run = async (cmd, args, opts) => {
    seen.push({ cmd, opts });
    return fake(cmd, args, opts);
  };
  run.calls = fake.calls;
  const github = createGithub({ profile, run });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 2 });
  const reads = run.calls.filter((c) => c.cmd === 'gh');
  assert.equal(reads.length, 2);
  assert.ok(reads.every((c) => c.ghToken === APP_TOKEN));
  assert.equal(onOther.calls.length, 1, '同一实例只取一次令牌');
  const mint = seen.find((c) => c.cmd === 'fake-app-token');
  assert.ok(mint.opts.timeoutMs > 0);
  assert.equal(mint.opts.killGroup, true);
  assert.equal(mint.opts.env.GH_TOKEN, undefined);
  assert.equal(readLog(loopLog), '');
});

test('取令牌命令退出非 0：回退账号令牌、记 loop.log、令牌和 stderr 不进日志', async () => {
  const { profile, loopLog } = setup();
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }), onOther: tokenCmd({ code: 1, token: 'leak-me' }) });
  const github = createGithub({ profile, run });
  const data = await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  assert.equal(data.repository.issue.id, 'I1');
  const reads = run.calls.filter((c) => c.cmd === 'gh');
  assert.deepEqual(reads.map((c) => c.ghToken), ['owner-token']);
  const log = readLog(loopLog);
  assert.match(log, /app-token-fallback kind=token-failed repo=ExampleUser\/repo-a/);
  assert.doesNotMatch(log, /leak-me|owner-token|Traceback/);
  // 再读一次不再重复取令牌（这一实例里记住取不到）
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 2 });
  assert.equal(run.calls.filter((c) => c.cmd === 'fake-app-token').length, 1);
});

for (const [status, kind] of [['401', 'auth-401'], ['403', 'auth-403'], ['404', 'not-found']]) {
  test(`App 读返回 ${status}：回退账号令牌重试一次、记 loop.log、错误里不带令牌`, async () => {
    const { profile, loopLog } = setup();
    const run = createFakeRun({
      onGraphql: (_p, { env }) =>
        env.GH_TOKEN === APP_TOKEN
          ? { code: 1, stdout: '', stderr: `gh: HTTP ${status} (token ${APP_TOKEN})` }
          : { repository: { issue: { id: 'I9' } } },
      onOther: tokenCmd(),
    });
    const github = createGithub({ profile, run });
    const data = await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
    assert.equal(data.repository.issue.id, 'I9');
    assert.deepEqual(run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken), [APP_TOKEN, 'owner-token']);
    const log = readLog(loopLog);
    assert.match(log, new RegExp(`app-token-fallback kind=${kind} repo=ExampleUser/repo-a`));
    assert.doesNotMatch(log, new RegExp(`${APP_TOKEN}|owner-token`));
  });
}

test('GraphQL 业务错误「Resource not accessible by integration」也回退', async () => {
  const { profile, loopLog } = setup();
  const run = createFakeRun({
    onGraphql: (_p, { env }) =>
      env.GH_TOKEN === APP_TOKEN
        ? { code: 0, stdout: JSON.stringify({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }), stderr: '' }
        : { repository: { issue: { id: 'I2' } } },
    onOther: tokenCmd(),
  });
  const github = createGithub({ profile, run });
  const data = await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  assert.equal(data.repository.issue.id, 'I2');
  assert.match(readLog(loopLog), /kind=auth-403/);
});

test('回退后账号令牌也失败：照常报错，错误里不带任何令牌，只回退一次', async () => {
  const { profile } = setup();
  const run = createFakeRun({ onGraphql: (_p, { env }) => ({ code: 1, stdout: '', stderr: `HTTP 403 ${env.GH_TOKEN}` }), onOther: tokenCmd() });
  const github = createGithub({ profile, run });
  await assert.rejects(
    () => github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 }),
    (err) => !err.message.includes(APP_TOKEN) && !err.message.includes('owner-token'),
  );
  assert.equal(run.calls.filter((c) => c.cmd === 'gh').length, 2);
});

test('App 没装的 owner（另一个组织）直接走账号令牌，不取 App 令牌、不白挨 403', async () => {
  const { profile, loopLog } = setup();
  const onOther = tokenCmd();
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'X' } } }), onOther });
  const github = createGithub({ profile, run });
  await github.graphql(Q, { owner: OTHER_ORG, name: 'plugin', number: 1 });
  assert.deepEqual(run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken), ['owner-token']);
  assert.equal(onOther.calls.length, 0);
  assert.equal(readLog(loopLog), '');
});

test('appOwners 可配：列进去的 owner 才走 App', async () => {
  const { profile } = setup({ appOwners: [OTHER_ORG] });
  const run = createFakeRun({ onGraphql: () => ({ ok: 1 }), onOther: tokenCmd() });
  const github = createGithub({ profile, run });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.graphql(Q, { owner: OTHER_ORG, name: 'plugin', number: 1 });
  assert.deepEqual(run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken), ['owner-token', APP_TOKEN]);
});

// ── 多安装：App 装在多个 owner 上，各自的安装令牌只能读自己的仓，必须按 owner 各取各的 ──
const OWNER_B = 'ExampleOwnerB';
const OWNER_C = 'ExampleOwnerC';
const TOKEN_A = 'app-token-owner-a';
const TOKEN_B = 'app-token-owner-b';
const TOKEN_C = 'app-token-owner-c';
const fingerprint = (token) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
const APP_OWNERS = [OWNER, OWNER_B, OWNER_C];

/** 假取令牌命令：按最后一个参数（owner）返回各自的安装令牌，记录每次调用的参数。 */
function perOwnerTokenCmd(tokens, { fail = [] } = {}) {
  const calls = [];
  const onOther = async (cmd, args) => {
    if (cmd !== 'fake-app-token') return { code: 1, stdout: '', stderr: 'unexpected' };
    const owner = args[args.length - 1];
    calls.push({ cmd, args, owner });
    if (fail.includes(owner)) return { code: 1, stdout: '', stderr: `Traceback: no install for ${owner}` };
    const token = tokens[owner];
    return token ? { code: 0, stdout: `${token}\n`, stderr: '' } : { code: 1, stdout: '', stderr: 'no install' };
  };
  onOther.calls = calls;
  return onOther;
}

test('多 owner 各取各的令牌：命令带 owner 参数，读用该安装的令牌，同一 owner 只跑一次命令', async () => {
  const { profile, loopLog } = setup({ appOwners: APP_OWNERS });
  const onOther = perOwnerTokenCmd({ [OWNER]: TOKEN_A, [OWNER_B]: TOKEN_B, [OWNER_C]: TOKEN_C });
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }), onOther });
  const github = createGithub({ profile, run });
  for (const [owner, name] of [[OWNER, 'repo-a'], [OWNER_B, 'repo-b'], [OWNER_C, 'repo-c'], [OWNER, 'repo-a'], [OWNER_B, 'repo-b']]) {
    await github.graphql(Q, { owner, name, number: 1 });
  }
  assert.deepEqual(onOther.calls.map((c) => c.owner), [OWNER, OWNER_B, OWNER_C], '同一个 owner 只跑一次取令牌命令，owner 是命令的最后一个参数');
  const reads = run.calls.filter((c) => c.cmd === 'gh');
  assert.deepEqual(reads.map((c) => c.ghToken), [TOKEN_A, TOKEN_B, TOKEN_C, TOKEN_A, TOKEN_B], '每个 owner 的读用自己那次命令取到的令牌');
  const prints = reads.map((c) => fingerprint(c.ghToken));
  assert.equal(new Set(prints).size, 3, '三个 owner 的令牌指纹互不相同');
  assert.equal(readLog(loopLog), '', '都取到了就不该有回退记录');
});

test('一个 owner 取不到令牌：只回退这个 owner，另一个 owner 照旧走 App', async () => {
  const { profile, loopLog } = setup({ appOwners: [OWNER, OWNER_B] });
  const onOther = perOwnerTokenCmd({ [OWNER]: TOKEN_A, [OWNER_B]: TOKEN_B }, { fail: [OWNER_B] });
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }), onOther });
  const github = createGithub({ profile, run });
  await github.graphql(Q, { owner: OWNER_B, name: 'repo-b', number: 1 });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.graphql(Q, { owner: OTHER_ORG, name: 'plugin', number: 1 });
  assert.deepEqual(run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken), ['owner-token', TOKEN_A, 'owner-token'], '取不到的 owner 用账号令牌，别的 owner 仍用 App');
  assert.deepEqual(onOther.calls.map((c) => c.owner), [OWNER_B, OWNER], '没落进 appOwners 的 owner 不跑取令牌命令');
  const log = readLog(loopLog);
  assert.match(log, /app-token-fallback kind=token-failed repo=ExampleOwnerB\/repo-b/);
  assert.doesNotMatch(log, /ExampleUser\/repo-a/);
  assert.doesNotMatch(log, new RegExp(`${TOKEN_A}|${TOKEN_B}|owner-token`));
});

for (const [status, kind] of [['401', 'auth-401'], ['403', 'auth-403'], ['404', 'not-found']]) {
  test(`一个 owner 的 App 读返回 ${status}：只这一个 owner 回退并记一行，别的 owner 不受影响`, async () => {
    const { profile, loopLog } = setup({ appOwners: [OWNER, OWNER_B] });
    const onOther = perOwnerTokenCmd({ [OWNER]: TOKEN_A, [OWNER_B]: TOKEN_B });
    const run = createFakeRun({
      onGraphql: (_payload, { env }) =>
        env.GH_TOKEN === TOKEN_B
          ? { code: 1, stdout: '', stderr: `gh: HTTP ${status} (token ${TOKEN_B})` }
          : { repository: { issue: { id: 'I1' } } },
      onOther,
    });
    const github = createGithub({ profile, run });
    await github.graphql(Q, { owner: OWNER_B, name: 'repo-b', number: 1 });
    await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
    assert.deepEqual(run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken), [TOKEN_B, 'owner-token', TOKEN_A]);
    const lines = readLog(loopLog).split('\n').filter(Boolean);
    assert.equal(lines.length, 1, '只记一行，另一个 owner 没回退');
    assert.match(lines[0], new RegExp(`kind=${kind} repo=ExampleOwnerB/repo-b`));
    assert.doesNotMatch(lines[0], new RegExp(`${TOKEN_A}|${TOKEN_B}|owner-token`));
  });
}

test('一个 owner 的 App 返回 401 后：只有它不再用 App，别的 owner 继续用', async () => {
  const { profile, loopLog } = setup({ appOwners: [OWNER, OWNER_B] });
  const onOther = perOwnerTokenCmd({ [OWNER]: TOKEN_A, [OWNER_B]: TOKEN_B });
  const run = createFakeRun({
    onGraphql: (_payload, { env }) =>
      env.GH_TOKEN === TOKEN_B ? { code: 1, stdout: '', stderr: 'gh: HTTP 401 (Bad credentials)' } : { repository: { issue: { id: 'I1' } } },
    onOther,
  });
  const github = createGithub({ profile, run });
  await github.graphql(Q, { owner: OWNER_B, name: 'repo-b', number: 1 });
  await github.graphql(Q, { owner: OWNER_B, name: 'repo-b', number: 2 });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  assert.deepEqual(
    run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken),
    [TOKEN_B, 'owner-token', 'owner-token', TOKEN_A],
    '401 的 owner 之后直接走账号令牌，另一个 owner 仍先试 App',
  );
  assert.deepEqual(onOther.calls.map((c) => c.owner), [OWNER_B, OWNER], '坏令牌的 owner 不重复取，别的 owner 照取');
  assert.match(readLog(loopLog), /kind=auth-401 repo=ExampleOwnerB\/repo-b/);
});

test('令牌不进 loop.log、不进报错：多 owner 全失败时错误里只有状态码', async () => {
  const { profile, loopLog } = setup({ appOwners: [OWNER, OWNER_B] });
  const onOther = perOwnerTokenCmd({ [OWNER]: TOKEN_A, [OWNER_B]: TOKEN_B });
  const run = createFakeRun({
    onGraphql: (_payload, { env }) => ({ code: 1, stdout: '', stderr: `gh: HTTP 403 (token ${env.GH_TOKEN})` }),
    onOther,
  });
  const github = createGithub({ profile, run });
  await assert.rejects(
    () => github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 }),
    (err) => [TOKEN_A, TOKEN_B, TOKEN_C, 'owner-token'].every((token) => !err.message.includes(token)),
  );
  await assert.rejects(() => github.graphql(Q, { owner: OWNER_B, name: 'repo-b', number: 1 }));
  const log = readLog(loopLog);
  assert.match(log, /app-token-fallback kind=auth-403 repo=ExampleUser\/repo-a/);
  assert.match(log, /app-token-fallback kind=auth-403 repo=ExampleOwnerB\/repo-b/);
  assert.doesNotMatch(log, new RegExp(`${TOKEN_A}|${TOKEN_B}|${TOKEN_C}|owner-token`));
});

test('老形式的取令牌命令（不关心 owner 参数）照旧可用：多余参数不影响取到的令牌', async () => {
  const { profile, loopLog } = setup({ appOwners: [OWNER, OWNER_B] });
  const calls = [];
  const onOther = async (cmd, args) => {
    if (cmd !== 'fake-app-token') return { code: 1, stdout: '', stderr: 'unexpected' };
    calls.push(args);
    return { code: 0, stdout: `${APP_TOKEN}\n`, stderr: '' };
  };
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }), onOther });
  const github = createGithub({ profile, run });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.graphql(Q, { owner: OWNER_B, name: 'repo-b', number: 1 });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 2 });
  assert.deepEqual(calls, [['--print', OWNER], ['--print', OWNER_B]], 'owner 追加在命令末尾；同一 owner 只跑一次');
  assert.deepEqual(run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken), [APP_TOKEN, APP_TOKEN, APP_TOKEN], '老脚本照旧给出同一枚令牌，读不换路');
  assert.equal(readLog(loopLog), '', '老脚本能取到令牌就没有回退');
});

// 两个字段互斥：配了 appConfigPath 就不做按仓分流（盘点、搜索、viewer 会一起换成安装令牌而漏单）。
test('配了 appConfigPath 就不按仓分流：单仓读也走 App 配置铸造的令牌，不跑 appTokenCommand', async () => {
  const home = tmpDir();
  const secrets = path.join(home, 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  const pemFile = path.join(secrets, 'app.pem');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(pemFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const appConfigPath = path.join(home, 'app.json');
  fs.writeFileSync(appConfigPath, JSON.stringify({ appId: '1', installationId: '2', privateKeyFile: pemFile }), { mode: 0o600 });
  writeProfile(home, { profile: { appConfigPath, appTokenCommand: ['fake-app-token', '--print'], appOwners: [OWNER] } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const loopLog = path.join(home, 'state', 'host', 'loop.log');
  const onOther = tokenCmd();
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I5' } } }), onOther });
  const minted = [];
  const github = createGithub({
    profile,
    run,
    fetchImpl: async (url) => {
      minted.push(url);
      return { ok: true, status: 200, json: async () => ({ token: 'config-app-install-token' }) };
    },
  });
  const data = await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  assert.equal(data.repository.issue.id, 'I5');
  assert.equal(minted.length, 1, '走 appConfigPath 铸造一次安装令牌');
  assert.deepEqual(run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken), ['config-app-install-token']);
  assert.equal(onOther.calls.length, 0, 'appConfigPath 在场时不跑 appTokenCommand');
  assert.equal(readLog(loopLog), '', '不按仓分流就没有回退记录');
});

// 401 之后再读不再碰 App：否则每条读都要重跑一次取令牌命令、多挨一次 401。
test('App 返回 401 后本实例不再用 App：后续读直接走账号令牌', async () => {
  const { profile, loopLog } = setup();
  const run = createFakeRun({
    onGraphql: (_payload, { env }) =>
      env.GH_TOKEN === APP_TOKEN ? { code: 1, stdout: '', stderr: 'gh: HTTP 401 (Bad credentials)' } : { repository: { issue: { id: 'I7' } } },
    onOther: tokenCmd(),
  });
  const github = createGithub({ profile, run });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 2 });
  assert.deepEqual(
    run.calls.filter((c) => c.cmd === 'gh').map((c) => c.ghToken),
    [APP_TOKEN, 'owner-token', 'owner-token'],
    '第二次读不再试 App 令牌',
  );
  assert.equal(run.calls.filter((c) => c.cmd === 'fake-app-token').length, 1, '坏令牌不重复取');
  assert.match(readLog(loopLog), /kind=auth-401 repo=ExampleUser\/repo-a/);
});

test('不落在单个仓上的查询（跨仓清单、搜索、viewer）照旧走账号令牌：App 看不到别的组织，换了会漏单', async () => {
  const { profile } = setup();
  const onOther = tokenCmd();
  const run = createFakeRun({ onGraphql: () => ({ ok: 1 }), onOther });
  const github = createGithub({ profile, run });
  await github.graphql('query ($owner: String!) { user(login: $owner) { login } }', { owner: OWNER });
  await github.graphql('query ($q: String!) { search(type: ISSUE, first: 1, query: $q) { issueCount } }', { q: 'x' });
  await github.graphql('query { viewer { login } }', {});
  assert.ok(run.calls.filter((c) => c.cmd === 'gh').every((c) => c.ghToken === 'owner-token'));
  assert.equal(onOther.calls.length, 0);
});

test('写操作和 mutation 不走 App、不回退', async () => {
  const { profile } = setup();
  const onOther = tokenCmd();
  const run = createFakeRun({
    onGraphql: () => ({ code: 1, stdout: '', stderr: 'HTTP 403' }),
    onApi: () => ({ id: 5, html_url: 'https://example.test/c/5' }),
    onOther,
  });
  const github = createGithub({ profile, run });
  await github.write({ type: 'comment.create', repo: OWNER_REPO, issue: 1, body: 'w' });
  await github.write({ type: 'issue.close', repo: OWNER_REPO, issue: 1 });
  await assert.rejects(() => github.graphql('mutation ($owner: String!, $name: String!) { x(owner: $owner, name: $name) { id } }', { owner: OWNER, name: 'repo-a' }));
  const gh = run.calls.filter((c) => c.cmd === 'gh');
  assert.ok(gh.every((c) => c.ghToken === 'owner-token'));
  assert.equal(gh.filter((c) => c.args.includes('graphql')).length, 1, 'mutation 只发一次');
  assert.equal(onOther.calls.length, 0);
});

test('profile 校验：appTokenCommand 必须是非空字符串数组；沙箱副本删掉它', () => {
  const bad = writeProfile(tmpDir(), { profile: { appTokenCommand: 'python3 x.py' } });
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: bad.home }), /appTokenCommand/);
  const { profile } = setup();
  assert.deepEqual([...profile.appTokenCommand], ['fake-app-token', '--print']);
  assert.deepEqual([...profile.appOwners], [OWNER]);
  const roundDir = tmpDir();
  const { profileFile } = prepareSandboxProfile({ profile, roundDir, repoRoot: '/repo', socketPath: '/tmp/s.sock' });
  const copy = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  assert.equal(copy.appTokenCommand, undefined);
  assert.equal(copy.appOwners, undefined);
});

// ── 两级配置：`apps: { read: ①读 App, write: ②写 App }`（app → owner 两级；安装号运行时查） ──
const READ_ID = '101';
const WRITE_ID = '202';
const OWNER_D = 'ExampleOwnerD';
const READ_TOKENS = { [OWNER]: 'tok-read-a', [OWNER_B]: 'tok-read-b', [OWNER_C]: 'tok-read-c', [OWNER_D]: 'tok-read-d' };
const WRITE_TOKENS = { [OWNER]: 'tok-write-a', [OWNER_B]: 'tok-write-b' };
const DEFAULT_INSTALLS = {
  [READ_ID]: [OWNER, OWNER_B, OWNER_C, OWNER_D],
  [WRITE_ID]: [OWNER, OWNER_B],
};

function makeKeyFile(dir, name) {
  const file = path.join(dir, name);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

/** 两级配置的 profile 夹具：只写 appId / privateKeyFile / owners，安装号一个都不写（运行时查）。 */
function appSetup({ read, write, extra = {} } = {}) {
  const home = tmpDir();
  const secrets = path.join(home, 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  const apps = {};
  if (read) {
    apps.read = {
      appId: READ_ID,
      privateKeyFile: read.privateKeyFile ?? makeKeyFile(secrets, 'read.key'),
      owners: read.owners ?? [OWNER, OWNER_B, OWNER_C, OWNER_D],
    };
  }
  if (write) {
    apps.write = {
      appId: WRITE_ID,
      privateKeyFile: write.privateKeyFile ?? makeKeyFile(secrets, 'write.key'),
      owners: write.owners ?? [OWNER, OWNER_B],
    };
  }
  writeProfile(home, { profile: { apps, ...extra } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  return { home, profile, loopLog: path.join(home, 'state', 'host', 'loop.log') };
}

/** 假 App REST：从 JWT 的 iss 认出是哪个 app；安装号按 owner 在列表里的位置生成（写死的是测试，不是代码）。 */
function appFetch({ installs = DEFAULT_INSTALLS, tokens = { [READ_ID]: READ_TOKENS, [WRITE_ID]: WRITE_TOKENS }, failList = false, failToken = false } = {}) {
  const calls = { list: [], token: [], other: [] };
  const issOf = (opts) => {
    const jwt = String(opts?.headers?.Authorization || '').replace(/^Bearer /, '');
    try {
      return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')).iss;
    } catch {
      return null;
    }
  };
  const fetchImpl = async (url, opts = {}) => {
    const iss = issOf(opts);
    if (url.includes('/app/installations?')) {
      calls.list.push({ iss });
      if (failList) return { ok: false, status: 500, json: async () => ({}) };
      const owners = installs[iss] || [];
      const page = Number(new URL(url).searchParams.get('page') || '1');
      const list = page === 1 ? owners.map((login, index) => ({ id: Number(iss) * 100 + index, account: { login } })) : [];
      return { ok: true, status: 200, json: async () => list };
    }
    const mint = /^https:\/\/api\.github\.com\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (mint) {
      const id = Number(mint[1]);
      if (id < 100) {
        // 旧模式 appConfigPath：安装号写在配置文件里，拿到的是另一枚令牌。
        calls.other.push({ url });
        return { ok: true, status: 200, json: async () => ({ token: 'config-app-token' }) };
      }
      calls.token.push({ iss, id });
      if (failToken) return { ok: false, status: 500, json: async () => ({}) };
      const owner = (installs[iss] || [])[id % 100];
      const token = tokens[iss]?.[owner];
      return token ? { ok: true, status: 200, json: async () => ({ token }) } : { ok: false, status: 404, json: async () => ({}) };
    }
    calls.other.push({ url });
    return { ok: true, status: 200, json: async () => ({ token: 'config-app-token' }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** 这条子进程用的是哪枚令牌：gh 读 GH_TOKEN，git 走 http.extraheader 的 basic。 */
function tokenOf(rec) {
  if (rec.ghToken) return rec.ghToken;
  const header = rec.env?.GIT_CONFIG_VALUE_0;
  if (typeof header === 'string') {
    return Buffer.from(header.replace(/^AUTHORIZATION: basic /, ''), 'base64').toString('utf8').split(':').slice(1).join(':');
  }
  return null;
}

const appTokensUsed = (run) => run.calls.filter((c) => c.cmd === 'gh' || (c.cmd === 'git' && c.env?.GIT_CONFIG_VALUE_0)).map(tokenOf);

test('①读 App：多 owner 各取各的安装令牌；同一 (app, owner) 只取一次，安装列表只查一次', async () => {
  const { profile, loopLog } = appSetup({ read: {} });
  const fetchImpl = appFetch();
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }) });
  const github = createGithub({ profile, run, fetchImpl });
  for (const owner of [OWNER, OWNER_B, OWNER_C, OWNER_D, OWNER]) {
    await github.graphql(Q, { owner, name: 'repo', number: 1 });
  }
  assert.deepEqual(appTokensUsed(run), [READ_TOKENS[OWNER], READ_TOKENS[OWNER_B], READ_TOKENS[OWNER_C], READ_TOKENS[OWNER_D], READ_TOKENS[OWNER]]);
  assert.equal(new Set(Object.values(READ_TOKENS).map(fingerprint)).size, 4, '四枚令牌指纹互不相同');
  assert.equal(fetchImpl.calls.token.length, 4, '每个 owner 只铸造一次');
  assert.ok(fetchImpl.calls.token.every((call) => call.iss === READ_ID), '只用 ①读 App 的私钥');
  assert.equal(fetchImpl.calls.list.length, 1, '安装列表按 app 缓存，只查一次');
  assert.equal(readLog(loopLog), '');
});

test('①读 App：某个 owner 没装（安装列表里没有）只回退这一个，别的 owner 照旧走 App', async () => {
  const { profile, loopLog } = appSetup({ read: {} });
  const fetchImpl = appFetch({ installs: { [READ_ID]: [OWNER, OWNER_B] } });
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }) });
  const github = createGithub({ profile, run, fetchImpl });
  await github.graphql(Q, { owner: OWNER_C, name: 'repo-c', number: 1 });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.graphql(Q, { owner: OWNER_C, name: 'repo-c', number: 2 });
  assert.deepEqual(appTokensUsed(run), ['owner-token', READ_TOKENS[OWNER], 'owner-token']);
  const lines = readLog(loopLog).split('\n').filter(Boolean);
  assert.equal(lines.length, 2, 'C 的两次读各记一行；A 不记');
  assert.match(lines[0], /app-token-fallback kind=token-failed repo=ExampleOwnerC\/repo-c app=read reason=not-installed/);
  assert.doesNotMatch(readLog(loopLog), new RegExp(`${READ_TOKENS[OWNER]}|owner-token`));
  assert.equal(fetchImpl.calls.token.filter((call) => call.iss === READ_ID).length, 1, '没装的 owner 不铸造令牌');
});

for (const [label, mutate, reason] of [
  ['私钥文件不存在', (file) => file, 'key-missing'],
  ['私钥文件权限不对（644）', (file) => { fs.chmodSync(file, 0o644); return file; }, 'key-unreadable'],
]) {
  test(`①读 App：${label} → 回退账号令牌并记一行（reason=${reason}），不打 App 接口`, async () => {
    const home = tmpDir();
    const secrets = path.join(home, 'secrets');
    fs.mkdirSync(secrets, { recursive: true });
    const keyFile = path.join(secrets, 'read.key');
    fs.writeFileSync(keyFile, 'placeholder', { mode: 0o600 });
    const target = reason === 'key-missing' ? path.join(secrets, 'missing.key') : mutate(keyFile);
    const { profile, loopLog } = appSetup({ read: { privateKeyFile: target } });
    const fetchImpl = appFetch();
    const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }) });
    const github = createGithub({ profile, run, fetchImpl });
    await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
    assert.deepEqual(appTokensUsed(run), ['owner-token']);
    assert.match(readLog(loopLog), new RegExp(`app-token-fallback kind=token-failed repo=ExampleUser/repo-a app=read reason=${reason}`));
    assert.equal(fetchImpl.calls.list.length + fetchImpl.calls.token.length, 0, '私钥不可用时不去问 GitHub');
  });
}

test('①读 App：安装号查询失败 → 回退账号令牌并记一行（reason=install-lookup-http-500）', async () => {
  const { profile, loopLog } = appSetup({ read: {} });
  const fetchImpl = appFetch({ failList: true });
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }) });
  const github = createGithub({ profile, run, fetchImpl });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  assert.deepEqual(appTokensUsed(run), ['owner-token']);
  assert.match(readLog(loopLog), /app-token-fallback kind=token-failed repo=ExampleUser\/repo-a app=read reason=install-lookup-http-500/);
});

test('①读 App：换令牌接口 500（不是 401/403/404）也回退并记一行，不抛', async () => {
  const { profile, loopLog } = appSetup({ read: {} });
  const fetchImpl = appFetch({ failToken: true });
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }) });
  const github = createGithub({ profile, run, fetchImpl });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  assert.deepEqual(appTokensUsed(run), ['owner-token']);
  assert.match(readLog(loopLog), /app=read reason=token-request-http-500/);
});

for (const [status, kind] of [['401', 'auth-401'], ['403', 'auth-403'], ['404', 'not-found']]) {
  test(`①读 App 被拒 ${status}：回退账号令牌、记一行（带 app 名与原因、无令牌）`, async () => {
    const { profile, loopLog } = appSetup({ read: {} });
    const fetchImpl = appFetch();
    const run = createFakeRun({
      onGraphql: (_payload, { env }) =>
        env.GH_TOKEN === READ_TOKENS[OWNER]
          ? { code: 1, stdout: '', stderr: `gh: HTTP ${status} (token ${READ_TOKENS[OWNER]})` }
          : { repository: { issue: { id: 'I1' } } },
    });
    const github = createGithub({ profile, run, fetchImpl });
    const data = await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
    assert.equal(data.repository.issue.id, 'I1');
    assert.deepEqual(appTokensUsed(run), [READ_TOKENS[OWNER], 'owner-token']);
    const log = readLog(loopLog);
    assert.match(log, new RegExp(`kind=${kind} repo=ExampleUser/repo-a app=read reason=app-${status === '404' ? '404' : status}`));
    assert.doesNotMatch(log, new RegExp(`${READ_TOKENS[OWNER]}|owner-token`));
  });
}

test('低风险写走 ①：评论、关单、开 sub-issue 用读 App 的安装令牌', async () => {
  const { profile, loopLog } = appSetup({ read: {}, write: {} });
  const fetchImpl = appFetch();
  const run = createFakeRun({ onApi: (args) => ({ id: 7, number: 9, html_url: 'https://example.test/x', state: 'closed' }) });
  const github = createGithub({ profile, run, fetchImpl });
  await github.write({ type: 'comment.create', repo: `${OWNER}/repo-a`, issue: 1, body: 'w' });
  await github.write({ type: 'issue.close', repo: `${OWNER}/repo-a`, issue: 1 });
  await github.write({ type: 'subissue.add', repo: `${OWNER}/repo-a`, issue: 1, subRepo: `${OWNER}/repo-a`, subIssue: 2 });
  // subissue.add 先 GET 子 issue 再 POST，所以三次写一共四次 gh 调用。
  assert.deepEqual(appTokensUsed(run), Array(4).fill(READ_TOKENS[OWNER]));
  assert.ok(fetchImpl.calls.token.every((call) => call.iss === READ_ID), '低风险写不用 ②的私钥');
  assert.equal(readLog(loopLog), '');
});

test('高风险写走 ②：推分支、开 PR、转 ready、workflow 用写 App 的安装令牌；看板写仍走账号令牌', async () => {
  const { profile, loopLog } = appSetup({ read: {}, write: {} });
  const fetchImpl = appFetch();
  const run = createFakeRun({
    onApi: () => ({ number: 5, html_url: 'https://example.test/pr/5' }),
    onGraphql: () => ({ user: { projectV2: { id: 'P', fields: { nodes: [] } } } }),
  });
  const github = createGithub({ profile, run, fetchImpl });
  await github.write({ type: 'branch.push', repo: `${OWNER}/repo-a`, branch: 'acceptance/1-x-sc1', bundlePath: path.join(tmpDir(), 'b.bundle') });
  await github.write({ type: 'pr.create', repo: `${OWNER}/repo-a`, head: 'acceptance/1-x-sc1', title: 't', body: 'b' });
  await github.write({ type: 'pr.ready', repo: `${OWNER}/repo-a`, pr: 5 });
  await github.write({ type: 'ci.rerun', repo: `${OWNER}/repo-a`, pr: 5, runId: 9 });
  // branch.push 自己跑三条 git（init / fetch / push），其余三次写各一次 gh 调用。
  const highRisk = appTokensUsed(run);
  assert.equal(highRisk.length, 6);
  assert.ok(highRisk.every((token) => token === WRITE_TOKENS[OWNER]), '高风险写全用 ②的令牌');
  assert.equal(readLog(loopLog), '');
});

test('看板写仍走账号令牌、不碰 App：App 看不到个人账号下的 Projects v2', async () => {
  const { profile, loopLog } = appSetup({ read: {}, write: {} });
  const fetchImpl = appFetch();
  const run = createFakeRun({ onGraphql: () => ({ user: { projectV2: { id: 'P', fields: { nodes: [] } } } }) });
  const github = createGithub({ profile, run, fetchImpl });
  await github.write({ type: 'project.field.set', repo: `${OWNER}/repo-a`, issue: 1, fields: { 验收: '验收中' } }).catch(() => {});
  assert.ok(appTokensUsed(run).length > 0 && appTokensUsed(run).every((token) => token === 'owner-token'), '看板写用账号令牌');
  assert.equal(fetchImpl.calls.list.length + fetchImpl.calls.token.length, 0, '看板写不铸 App 令牌');
  assert.equal(readLog(loopLog), '');
});

test('②未装的 owner：高风险写回退账号令牌并记一行（reason=not-installed），①的读不受影响', async () => {
  // owner C 在 ②的 owners 声明里（说明「以为装了」），但安装列表里没有 → 运行时查到没装。
  const { profile, loopLog } = appSetup({ read: {}, write: { owners: [OWNER, OWNER_B, OWNER_C] } });
  const fetchImpl = appFetch();
  const run = createFakeRun({
    onApi: () => ({ number: 5, html_url: 'https://example.test/pr/5' }),
    onGraphql: () => ({ repository: { issue: { id: 'I1' } } }),
  });
  const github = createGithub({ profile, run, fetchImpl });
  await github.write({ type: 'branch.push', repo: `${OWNER_C}/repo-c`, branch: 'acceptance/1-x-sc1', bundlePath: path.join(tmpDir(), 'b.bundle') });
  await github.graphql(Q, { owner: OWNER_C, name: 'repo-c', number: 1 });
  const used = appTokensUsed(run);
  assert.deepEqual(used.slice(0, 3), ['owner-token', 'owner-token', 'owner-token'], '②没装：写回退账号令牌');
  assert.equal(used.at(-1), READ_TOKENS[OWNER_C], '①装了：读走 App');
  const log = readLog(loopLog);
  assert.match(log, /app-token-fallback kind=token-failed repo=ExampleOwnerC\/repo-c app=write reason=not-installed/);
  assert.doesNotMatch(log, /repo=ExampleOwnerC\/repo-c app=read/);
  assert.equal(fetchImpl.calls.token.filter((call) => call.iss === WRITE_ID).length, 0, '没装就不铸造 ②令牌');
});

test('②名单里没有的 owner：高风险写也回退并记一行（reason=owner-not-in-app-owners）', async () => {
  const { profile, loopLog } = appSetup({ read: {}, write: { owners: [OWNER] } });
  const fetchImpl = appFetch();
  const run = createFakeRun({ onApi: () => ({ html_url: 'x' }) });
  const github = createGithub({ profile, run, fetchImpl });
  await github.write({ type: 'pr.create', repo: `${OWNER_B}/repo-b`, head: 'acceptance/1-x-sc1', title: 't', body: 'b' });
  assert.deepEqual(appTokensUsed(run), ['owner-token']);
  assert.match(readLog(loopLog), /app-token-fallback kind=token-failed repo=ExampleOwnerB\/repo-b app=write reason=owner-not-in-app-owners/);
});

test('两级配置缺省：只有 read 时读走 ①、写全走账号令牌且不记回退（没有 ② 可退）', async () => {
  const { profile, loopLog } = appSetup({ read: {} });
  const fetchImpl = appFetch();
  const run = createFakeRun({
    onApi: () => ({ number: 5, html_url: 'https://example.test/pr/5' }),
    onGraphql: () => ({ repository: { issue: { id: 'I1' } } }),
  });
  const github = createGithub({ profile, run, fetchImpl });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.write({ type: 'branch.push', repo: `${OWNER}/repo-a`, branch: 'acceptance/1-x-sc1', bundlePath: path.join(tmpDir(), 'b.bundle') });
  assert.deepEqual(appTokensUsed(run), [READ_TOKENS[OWNER], 'owner-token', 'owner-token', 'owner-token']);
  assert.equal(readLog(loopLog), '');
});

test('两级配置缺省：只有 write 时读与低风险写走账号令牌、高风险写走 ②，无回退日志', async () => {
  const { profile, loopLog } = appSetup({ write: {} });
  const fetchImpl = appFetch();
  const run = createFakeRun({
    onApi: () => ({ number: 5, html_url: 'https://example.test/pr/5', id: 1 }),
    onGraphql: () => ({ repository: { issue: { id: 'I1' } } }),
  });
  const github = createGithub({ profile, run, fetchImpl });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.write({ type: 'comment.create', repo: `${OWNER}/repo-a`, issue: 1, body: 'w' });
  await github.write({ type: 'pr.create', repo: `${OWNER}/repo-a`, head: 'acceptance/1-x-sc1', title: 't', body: 'b' });
  assert.deepEqual(appTokensUsed(run), ['owner-token', 'owner-token', WRITE_TOKENS[OWNER]]);
  assert.equal(readLog(loopLog), '');
});

test('没配 apps：与现状完全一致——不碰 App 接口，读和写都走账号令牌', async () => {
  const { home } = writeProfile(tmpDir(), {});
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const loopLog = path.join(home, 'state', 'host', 'loop.log');
  const fetchImpl = appFetch();
  const run = createFakeRun({
    onApi: () => ({ number: 5, html_url: 'x', id: 1 }),
    onGraphql: () => ({ repository: { issue: { id: 'I1' } } }),
  });
  const github = createGithub({ profile, run, fetchImpl });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.write({ type: 'pr.create', repo: `${OWNER}/repo-a`, head: 'x', title: 't', body: 'b' });
  assert.deepEqual(appTokensUsed(run), ['owner-token', 'owner-token']);
  assert.equal(fetchImpl.calls.list.length + fetchImpl.calls.token.length, 0);
  assert.equal(readLog(loopLog), '');
});

test('两个 app 不串用：同一 owner 的 ①/② 令牌各存一份，读用 ①、推分支用 ②', async () => {
  const { profile } = appSetup({ read: {}, write: {} });
  const fetchImpl = appFetch();
  const run = createFakeRun({
    onGraphql: () => ({ repository: { issue: { id: 'I1' } } }),
  });
  const github = createGithub({ profile, run, fetchImpl });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  await github.write({ type: 'branch.push', repo: `${OWNER}/repo-a`, branch: 'acceptance/1-x-sc1', bundlePath: path.join(tmpDir(), 'b.bundle') });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 2 });
  assert.deepEqual(appTokensUsed(run), [READ_TOKENS[OWNER], WRITE_TOKENS[OWNER], WRITE_TOKENS[OWNER], WRITE_TOKENS[OWNER], READ_TOKENS[OWNER]]);
  assert.deepEqual(fetchImpl.calls.token.map((call) => call.iss), [READ_ID, WRITE_ID], '两个 app 各铸造一次，不串用');
  assert.deepEqual(fetchImpl.calls.list.map((call) => call.iss), [READ_ID, WRITE_ID], '安装列表按 app 各查一次，不串用');
});

test('写被拒 401 后：只这个 (app, owner) 不再用 App，别的写照旧；记录里没有令牌', async () => {
  const { profile, loopLog } = appSetup({ read: {}, write: {} });
  const fetchImpl = appFetch();
  let rejectWriteToken = true;
  const run = createFakeRun({
    onApi: (args, { env }) => {
      if (rejectWriteToken && env.GH_TOKEN === WRITE_TOKENS[OWNER]) {
        rejectWriteToken = false;
        return { code: 1, stdout: '', stderr: `HTTP 401 Bad credentials ${WRITE_TOKENS[OWNER]}` };
      }
      return { html_url: 'x', number: 1, id: 1 };
    },
  });
  const github = createGithub({ profile, run, fetchImpl });
  await github.write({ type: 'pr.create', repo: `${OWNER}/repo-a`, head: 'x', title: 't', body: 'b' });
  await github.write({ type: 'pr.create', repo: `${OWNER}/repo-a`, head: 'x', title: 't2', body: 'b2' });
  assert.deepEqual(appTokensUsed(run), [WRITE_TOKENS[OWNER], 'owner-token', 'owner-token'], '第二次不再试坏令牌');
  const log = readLog(loopLog);
  assert.match(log, /kind=auth-401 repo=ExampleUser\/repo-a app=write reason=app-401/);
  assert.doesNotMatch(log, new RegExp(`${WRITE_TOKENS[OWNER]}|owner-token|tok-read`));
  assert.equal(fetchImpl.calls.token.filter((call) => call.iss === WRITE_ID).length, 1, '坏令牌不重复铸造');
});

test('令牌不进日志与报错：App 与账号令牌都失败时，错误里只有状态码', async () => {
  const { profile, loopLog } = appSetup({ read: {} });
  const fetchImpl = appFetch();
  const run = createFakeRun({
    onGraphql: (_payload, { env }) => ({ code: 1, stdout: '', stderr: `gh: HTTP 403 (token ${env.GH_TOKEN})` }),
  });
  const github = createGithub({ profile, run, fetchImpl });
  await assert.rejects(
    () => github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 }),
    (err) => !/[A-Za-z0-9_-]*tok-(read|write)-[a-z]/.test(err.message) && !err.message.includes('owner-token'),
  );
  const log = readLog(loopLog);
  assert.match(log, /kind=auth-403 repo=ExampleUser\/repo-a app=read/);
  assert.doesNotMatch(log, /tok-read|tok-write|owner-token/);
});

test('配了 appConfigPath 就不按仓分流：apps 不生效、不查安装列表、不跑 ①的私钥', async () => {
  const home = tmpDir();
  const secrets = path.join(home, 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  const configKey = makeKeyFile(secrets, 'config.key');
  const appConfigPath = path.join(home, 'app.json');
  fs.writeFileSync(appConfigPath, JSON.stringify({ appId: '1', installationId: '2', privateKeyFile: configKey }), { mode: 0o600 });
  const { profile, loopLog } = appSetup({ read: {}, write: {}, extra: { appConfigPath } });
  const fetchImpl = appFetch();
  const run = createFakeRun({ onGraphql: () => ({ repository: { issue: { id: 'I1' } } }) });
  const github = createGithub({ profile, run, fetchImpl });
  await github.graphql(Q, { owner: OWNER, name: 'repo-a', number: 1 });
  assert.deepEqual(appTokensUsed(run), ['config-app-token']);
  assert.equal(fetchImpl.calls.list.length + fetchImpl.calls.token.length, 0, 'appConfigPath 在场时 apps 不生效');
  assert.equal(readLog(loopLog), '');
});

test('apps 的 profile 校验：格式错的直接报错；私钥文件不在也不拦启动（用的时候回退）', () => {
  const bad = (apps, pattern) => {
    const home = tmpDir();
    writeProfile(home, { profile: { apps } });
    assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), pattern);
  };
  bad({ other: { appId: '1', privateKeyFile: '/k', owners: [OWNER] } }, /apps/);
  bad({ read: 'x' }, /apps\.read/);
  bad({ read: { appId: 'x', privateKeyFile: '/k' } }, /appId/);
  bad({ read: { appId: '1', privateKeyFile: 'rel/key' } }, /privateKeyFile/);
  bad({ read: { appId: '1', privateKeyFile: '/k', owners: [] } }, /owners/);
  bad({ read: { appId: '1', privateKeyFile: '/k', install: '2' } }, /install/);
  const home = tmpDir();
  writeProfile(home, { profile: { apps: { read: { appId: 123, privateKeyFile: '/nonexistent/app.key' } } } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  assert.equal(profile.apps.read.appId, '123');
  assert.deepEqual([...profile.apps.read.owners], [OWNER], 'owners 缺省是 [ownerLogin]');
});

test('沙箱遮罩覆盖 apps 里的私钥：嵌套的 privateKeyFile 也进遮罩名单', async () => {
  const { profile } = appSetup({ read: {}, write: {} });
  const { maskList } = await import('./host/sandbox.mjs');
  const masked = maskList({ rawProfile: { apps: { read: { privateKeyFile: profile.apps.read.privateKeyFile } } }, profile, env: {} });
  assert.ok(masked.files.includes(fs.realpathSync(profile.apps.read.privateKeyFile)), '①的私钥被遮');
  assert.ok(masked.files.includes(fs.realpathSync(profile.apps.write.privateKeyFile)), '②的私钥被遮');
});
