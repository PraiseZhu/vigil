// App 安装令牌分流只读轮询（appTokenCommand）：读优先走 App，取不到 / 401 / 403 / 404 回退账号令牌重试一次并记 loop.log；
// App 没装的 owner 直接走账号令牌；写一律账号令牌。
import assert from 'node:assert/strict';
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
