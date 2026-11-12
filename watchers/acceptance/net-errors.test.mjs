import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_READ_RETRIES_PER_TICK, createGithub } from './bin/github.mjs';
import { classifyNetError } from './bin/net-errors.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { readAlerts, hostPaths } from './host/paths.mjs';
import { MAX_TICK_READ_RETRIES, pollRetryable, readRetryBudget, runTick, withReadTimeout } from './host/tick.mjs';
import { createFakeRun, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

// #238：网络类瞬时错误只有一张分类表（bin/net-errors.mjs）；只读请求遇到它重试一次，写不重试，一拍里的重试总数有上限。

const CLI = fileURLToPath(new URL('./bin/net-errors.mjs', import.meta.url));
const QUERY = 'query ($owner: String!) { repository(owner: $owner, name: "x") { id } }';
const READ_Q = JSON.stringify({ query: 'query { viewer { login } }' });

const TRANSIENT = [
  ['unexpected EOF', 'eof'],
  ['Post "https://api.github.com/graphql": EOF', 'eof'],
  ['unexpected end of JSON input', 'truncated-json'],
  ['gh: invalid UTF-8 in response', 'invalid-utf8'],
  ['gh: HTTP 502', 'http-5xx'],
  ['gh: HTTP 503', 'http-5xx'],
  ['gh: HTTP 504', 'http-5xx'],
  ['dial tcp: ETIMEDOUT', 'timeout'],
  ['read tcp: i/o timeout', 'timeout'],
  ['request timed out', 'timeout'],
  ['read: ECONNRESET', 'conn-reset'],
  ['write: connection reset by peer', 'conn-reset'],
  ['stream error: stream ID 1; CANCEL', 'conn-reset'],
  ['Could not resolve host: api.github.com', 'dns'],
  ['读 GitHub 超过 60 秒没返回，已掐掉（exit 124）', 'exit-124'],
];

test('#238 SC1 网络类瞬时错误判为 transient，类别对', () => {
  for (const [text, category] of TRANSIENT) {
    assert.deepEqual(classifyNetError({ code: 1, stdout: '', stderr: text }), { transient: true, category }, text);
  }
  assert.deepEqual(classifyNetError({ code: 124, stdout: '', stderr: '' }), { transient: true, category: 'exit-124' });
  assert.deepEqual(classifyNetError(new SyntaxError('Unexpected end of JSON input')), { transient: true, category: 'truncated-json' });
});

test('#238 SC2 业务错误和成功不判为瞬时；正文里碰巧有 502 的 403 也不是', () => {
  const notTransient = [
    { code: 1, stdout: '', stderr: 'gh: HTTP 403: Resource not accessible by integration' },
    { code: 1, stdout: '', stderr: 'gh: HTTP 401: Bad credentials' },
    { code: 4, stdout: '{"reason":"query-not-allowed"}', stderr: '' },
    { code: 1, stdout: '', stderr: 'gh: HTTP 404: Not Found' },
    { code: 1, stdout: '{"errors":[{"type":"NOT_FOUND","message":"Could not resolve to an Issue"}]}', stderr: '' },
    { code: 1, stdout: '{"errors":[{"type":"FORBIDDEN","message":"no"}]}', stderr: 'gh: GraphQL: forbidden' },
    { code: 0, stdout: '{"data":{}}', stderr: '' },
    { code: 1, stdout: '', stderr: 'gh: HTTP 403: cannot comment on #502 (HTTP 502 mentioned in the title)' },
  ];
  for (const input of notTransient) assert.equal(classifyNetError(input).transient, false, JSON.stringify(input));
});

function cli(args, input) {
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', timeout: 5000 });
}

test('#238 SC12 命令行入口：典型文本、空输入、超长输入、非 UTF-8、未知参数', () => {
  for (const [text, category] of [['unexpected end of JSON input', 'truncated-json'], ['invalid UTF-8', 'invalid-utf8'], ['EOF', 'eof'], ['exit 124', 'exit-124']]) {
    const r = cli(['--classify'], text);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { transient: true, category });
  }
  const rejected = cli(['--classify'], 'gate-rejected query-not-allowed');
  assert.deepEqual(JSON.parse(rejected.stdout), { transient: false, category: null });
  const empty = cli(['--classify'], '');
  assert.equal(empty.status, 0);
  assert.deepEqual(JSON.parse(empty.stdout), { transient: false, category: null });
  const started = Date.now();
  const huge = cli(['--classify'], `${'x'.repeat(2 * 1024 * 1024)}\nunexpected EOF`);
  assert.equal(huge.status, 0, huge.stderr);
  assert.ok(Date.now() - started < 5000, '超长输入 5 秒内返回');
  assert.equal(JSON.parse(huge.stdout).category, 'eof');
  const binary = spawnSync(process.execPath, [CLI, '--classify'], { input: Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28]), timeout: 5000 });
  assert.equal(binary.status, 0);
  assert.equal(JSON.parse(binary.stdout.toString()).transient, false);
  const unknown = cli(['--whatever'], 'EOF');
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /用法/);
});

function setup(onGraphql) {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const run = createFakeRun({ onGraphql });
  const sleeps = [];
  const github = createGithub({ profile, run, sleep: async (ms) => sleeps.push(ms) });
  return { github, run, sleeps };
}

test('#238 SC3 只读 GraphQL：正文截断（退出码 0）重试一次后成功；第二次仍失败按原错误报并注明已重试一次', async () => {
  let n = 0;
  const truncatedOnce = setup(() => (n++ === 0 ? { code: 0, stdout: '{"data":{"repo', stderr: '' } : { ok: true }));
  assert.deepEqual(await truncatedOnce.github.graphql(QUERY, { owner: 'o' }), { ok: true });
  assert.equal(truncatedOnce.run.calls.length, 2);

  const eofTwice = setup(() => ({ code: 1, stdout: '', stderr: 'unexpected EOF' }));
  await assert.rejects(() => eofTwice.github.graphql(QUERY, {}), /unexpected EOF[\s\S]*已重试一次/);
  assert.equal(eofTwice.run.calls.length, 2);

  const forbidden = setup(() => ({ code: 1, stdout: '', stderr: 'gh: HTTP 403: forbidden' }));
  await assert.rejects(() => forbidden.github.graphql(QUERY, {}), /HTTP 403/);
  assert.equal(forbidden.run.calls.length, 1, '非瞬时错误不重试');
});

test('#238 SC3 tick 层：gh api GET 遇 EOF（退出码 1）用新进程重试一次；poll 的瞬时失败和截断输出也重试', async () => {
  const calls = [];
  const wrapped = withReadTimeout(async (cmd, args, opts) => {
    calls.push(opts);
    return calls.length === 1 ? { code: 1, stdout: '', stderr: 'unexpected EOF' } : { code: 0, stdout: '{}', stderr: '' };
  }, 200);
  const result = await wrapped('gh', ['api', 'repos/o/r'], {});
  assert.equal(result.code, 0);
  assert.equal(result.retried, true, '标记已重试，里层不再重试');
  assert.equal(calls.length, 2);
  assert.equal(pollRetryable({ code: 1, stdout: '', stderr: 'unexpected EOF' }), true);
  assert.equal(pollRetryable({ code: 0, stdout: '[{"issue":', stderr: '' }), true);
  assert.equal(pollRetryable({ code: 0, stdout: '[]', stderr: '' }), false);
  assert.equal(pollRetryable({ code: 1, stdout: '', stderr: 'boom' }), false);
  assert.equal(pollRetryable({ code: 75, stdout: '', stderr: 'HTTP 502' }), false, '限流跳过这一拍，不重试');
});

test('#238 SC3 tick 里 poll 退出码 1 + EOF：重试一次后成功，不写 tick-failed', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const polls = [{ code: 1, stdout: '', stderr: 'unexpected EOF' }, { code: 0, stdout: '[]', stderr: '' }];
  let pollCalls = 0;
  const beat = await runTick({
    home, env: { ...process.env },
    run: async (cmd, args) => {
      if (cmd === 'node' && String(args[0]).endsWith('poll.mjs')) { pollCalls += 1; return polls.shift(); }
      return { code: 0, stdout: '[]', stderr: '' };
    },
    spawnRound: () => 1, spawnPrbot: () => 1, runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    gateAudit: async () => ({ checkedLines: 0, newViolations: [], sinceBaseline: null, newUncertain: [] }),
    notify: async () => ({ ok: false, reason: 'not-configured' }),
  });
  assert.equal(pollCalls, 2);
  assert.equal(beat.lastTick.ok, true, beat.lastTick.error);
  assert.equal(readAlerts(hostPaths(home)).filter((a) => a.kind === 'tick-failed').length, 0);
});

test('#238 SC4 写请求零重试：mutation、gh api -X POST/PATCH/DELETE、带 --input 的 REST，遇 502/EOF 都只调 1 次', async () => {
  const mutation = setup(() => ({ code: 1, stdout: '', stderr: 'unexpected EOF' }));
  await assert.rejects(() => mutation.github.graphql('mutation { addComment(input: {}) { clientMutationId } }', {}), /EOF/);
  assert.equal(mutation.run.calls.length, 1);
  for (const args of [['api', '-X', 'POST', 'repos/o/r/issues'], ['api', '-X', 'PATCH', 'repos/o/r/issues/1'], ['api', '-X', 'DELETE', 'repos/o/r/labels/x'], ['api', 'repos/o/r/issues', '--input', '-']]) {
    let n = 0;
    const wrapped = withReadTimeout(async () => { n += 1; return { code: 1, stdout: '', stderr: 'gh: HTTP 502' }; }, 200);
    const result = await wrapped('gh', args, { input: '{}' });
    assert.equal(result.code, 1);
    assert.equal(n, 1, args.join(' '));
  }
});

test('#238 SC5 单拍重试总数上限 3：github 客户端里 5 个读都瞬时失败，第 1～3 个各重试一次，第 4、5 个不重试', async () => {
  assert.equal(MAX_READ_RETRIES_PER_TICK, 3);
  const { github, run, sleeps } = setup(() => ({ code: 1, stdout: '', stderr: 'gh: HTTP 502' }));
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => github.graphql(QUERY, { owner: `o${i}` }), /HTTP 502/);
  assert.equal(sleeps.length, 3, '总共重试 3 次');
  assert.equal(run.calls.length, 5 + 3);
});

test('#238 SC5 tick 层上限 3：恰好第 3 次仍重试，第 4 次不重试', async () => {
  assert.equal(MAX_TICK_READ_RETRIES, 3);
  const budget = readRetryBudget();
  let n = 0;
  const wrapped = withReadTimeout(async () => { n += 1; return { code: 1, stdout: '', stderr: 'unexpected EOF' }; }, 200, { budget });
  const perRead = [];
  for (let i = 0; i < 5; i += 1) {
    const before = n;
    await wrapped('gh', ['api', `repos/o/r${i}`], {});
    perRead.push(n - before);
  }
  assert.deepEqual(perRead, [2, 2, 2, 1, 1]);
  assert.equal(budget.left, 0);
});

test('#238 SC6 重试前后请求一模一样：cmd、args、input、令牌不变', async () => {
  const { github, run } = setup((() => { let n = 0; return () => (n++ === 0 ? { code: 1, stdout: '', stderr: 'unexpected EOF' } : { ok: true }); })());
  await github.graphql(QUERY, { owner: 'o' });
  assert.equal(run.calls.length, 2);
  const [a, b] = run.calls;
  assert.deepEqual([b.cmd, b.args, b.input, b.ghToken], [a.cmd, a.args, a.input, a.ghToken]);
});

test('#238 外层重试过的读，里层 runRead 不再重试（单个请求最多重试一次）', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  let n = 0;
  const run = withReadTimeout(async () => { n += 1; return { code: 1, stdout: '', stderr: 'unexpected EOF' }; }, 200);
  const github = createGithub({ profile, run, sleep: async () => {} });
  await assert.rejects(() => github.graphql(QUERY, {}), /已重试一次/);
  assert.equal(n, 2, '外层重试一次，里层不再加一次');
});

test('#238 SC7 网络类关键词只定义在 net-errors.mjs', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const r = spawnSync('git', ['grep', '-l', '-E', 'ECONNRESET|unexpected EOF|invalid UTF-8', '--', 'watchers/acceptance', ':!*.test.mjs'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) return; // 没有 .git 的检出（打包副本）跳过静态检查。
  assert.deepEqual(r.stdout.trim().split('\n').filter(Boolean).map((file) => path.basename(file)), ['net-errors.mjs']);
});
