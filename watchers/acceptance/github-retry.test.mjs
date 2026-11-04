import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithub, isRateLimitFailure, rateHeadersOf, splitGhHeaders } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { REPO, createFakeRun, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

// GitHub 偶发 502/503/504、连接被断：只读请求当次重试一次（间隔几秒），写一律不重试。

function setup(onGraphql, onApi) {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const run = createFakeRun({ onGraphql, onApi });
  const sleeps = [];
  const github = createGithub({ profile, run, sleep: async (ms) => sleeps.push(ms) });
  return { github, run, sleeps };
}

function failingThen(errors, data = { ok: true }) {
  let n = 0;
  return () => {
    const err = errors[n++];
    if (err) return { code: 1, stdout: '', stderr: err };
    return data;
  };
}

const QUERY = 'query ($owner: String!) { repository(owner: $owner, name: "x") { id } }';

test('读请求第一次 502、第二次成功：最终成功，只多调一次，中间等几秒', async () => {
  const { github, run, sleeps } = setup(failingThen(['gh: HTTP 502\n']));
  const data = await github.graphql(QUERY, { owner: 'o' });
  assert.deepEqual(data, { ok: true });
  assert.equal(run.calls.length, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] >= 3000 && sleeps[0] <= 5000);
});

for (const err of ['gh: HTTP 503\n', 'gh: HTTP 504\n', 'stream error: stream ID 1; CANCEL; received from peer\n', 'read tcp 1.2.3.4:5->6.7.8.9:443: read: connection reset by peer\n', 'net/http: TLS handshake timeout\n']) {
  test(`读请求遇瞬时错误（${err.trim().slice(0, 30)}）重试一次后成功`, async () => {
    const { github, run } = setup(failingThen([err]));
    assert.deepEqual(await github.graphql(QUERY, {}), { ok: true });
    assert.equal(run.calls.length, 2);
  });
}

test('重试后仍 502：照旧失败、报原错误，总共只调两次', async () => {
  const { github, run, sleeps } = setup(failingThen(['gh: HTTP 502\n', 'gh: HTTP 502\n', 'gh: HTTP 502\n']));
  await assert.rejects(() => github.graphql(QUERY, {}), /HTTP 502/);
  assert.equal(run.calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test('非瞬时错误（404、权限）不重试', async () => {
  const { github, run, sleeps } = setup(failingThen(['gh: HTTP 404\n', null]));
  await assert.rejects(() => github.graphql(QUERY, {}), /HTTP 404/);
  assert.equal(run.calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test('graphql 里的 mutation 遇 502 不重试', async () => {
  const { github, run, sleeps } = setup(failingThen(['gh: HTTP 502\n', null]));
  await assert.rejects(() => github.graphql('mutation { addComment(input: {}) { clientMutationId } }', {}), /HTTP 502/);
  assert.equal(run.calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test('前面带注释或空白的 mutation 也不重试', async () => {
  const { github, run } = setup(failingThen(['gh: HTTP 502\n', null]));
  await assert.rejects(() => github.graphql('# c\n  mutation M { x }', {}), /HTTP 502/);
  assert.equal(run.calls.length, 1);
});

test('ownerGraphql 只读查询遇 504 重试一次后成功', async () => {
  const { github, run } = setup(failingThen(['gh: HTTP 504\n']));
  assert.deepEqual(await github.ownerGraphql(QUERY, {}), { ok: true });
  assert.equal(run.calls.length, 2);
});

test('写请求（评论写入）遇 502 不重试', async () => {
  let n = 0;
  const { github, run, sleeps } = setup(undefined, () => {
    n += 1;
    return n === 1 ? { code: 1, stdout: '', stderr: 'gh: HTTP 502\n' } : { id: 1, html_url: 'u' };
  });
  await assert.rejects(() => github.write({ type: 'comment.create', repo: REPO, issue: 1, body: 'hi' }), /HTTP 502/);
  assert.equal(run.calls.length, 1);
  assert.equal(sleeps.length, 0);
});

test('看板写入（含其中的查找 query）遇 502 不重试', async () => {
  const { github, run, sleeps } = setup(failingThen(['gh: HTTP 502\n', null]));
  await assert.rejects(
    () => github.write({ type: 'project.field.set', repo: REPO, issue: 1, fields: { 验收: '通过' }, ownerLogin: 'o', projectNumber: 1 }),
    /HTTP 502/,
  );
  assert.equal(run.calls.length, 1);
  assert.equal(sleeps.length, 0);
});

// ── #247 SC6 / SC7 / SC9：限额响应头交给调用方；限流识别成限流，不当普通失败 ──

function setupWithRates(onGraphql, onApi, profileExtra = {}) {
  const { home } = writeProfile(tmpDir(), { profile: profileExtra });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const run = createFakeRun({ onGraphql, onApi, onOther: async () => ({ code: 1, stdout: '', stderr: 'unexpected' }) });
  const samples = [];
  const sleeps = [];
  const github = createGithub({
    profile,
    run,
    sleep: async (ms) => sleeps.push(ms),
    onRateLimit: (sample) => samples.push(sample),
  });
  return { github, run, samples, sleeps, home, profile };
}

/** 带 HTTP 响应头的 gh 输出（真 gh 加 --include 时的形状）。 */
function withHeaders(body, headers) {
  const head = ['HTTP/2.0 200 OK', ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`)].join('\r\n');
  return `${head}\r\n\r\n${JSON.stringify(body)}`;
}

test('#247 SC6/SC9 只读查询带回限额响应头：交给调用方，并标明是哪一枚令牌', async () => {
  const { github, run, samples } = setupWithRates(() => ({
    code: 0,
    stdout: withHeaders(
      { data: { ok: true } },
      { 'x-ratelimit-remaining': '438', 'x-ratelimit-reset': '1762299600' },
    ),
    stderr: '',
  }));
  assert.deepEqual(await github.graphql(QUERY, {}), { ok: true });
  assert.ok(run.calls[0].args.includes('--include'), `只读查询要带 --include：${run.calls[0].args}`);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].identity, 'user');
  assert.equal(samples[0].remaining, '438');
  assert.equal(samples[0].reset, '1762299600');
  assert.equal(samples[0].source, 'graphql');

  // App 安装令牌那一枚分开记（identity=app），不覆盖 user 的记录。
  const app = setupWithRates(
    () => ({ code: 0, stdout: withHeaders({ data: { ok: true } }, { 'x-ratelimit-remaining': '4990' }), stderr: '' }),
    undefined,
    { appTokenCommand: ['fake-app-cred', '--print'] },
  );
  const onOther = async (cmd) => (cmd === 'fake-app-cred' ? { code: 0, stdout: 'app-install-cred\n', stderr: '' } : { code: 1, stdout: '', stderr: 'unexpected' });
  const appGithub = createGithub({
    profile: app.profile,
    run: createFakeRun({ onGraphql: () => ({ code: 0, stdout: withHeaders({ data: { ok: true } }, { 'x-ratelimit-remaining': '4990' }), stderr: '' }), onOther }),
    onRateLimit: (sample) => app.samples.push(sample),
  });
  const repoQuery = 'query ($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }';
  await appGithub.graphql(repoQuery, { owner: 'ExampleUser', name: 'example-repo' });
  assert.equal(app.samples.length, 1);
  assert.equal(app.samples[0].identity, 'app');
  assert.equal(app.samples[0].remaining, '4990');
});

test('#247 SC7 限流识别：403 带 rate limit 文案、429、RATE_LIMITED 错误码都算限流', () => {
  assert.equal(isRateLimitFailure({ stderr: 'gh: API rate limit already exceeded (HTTP 403)\n' }), true);
  assert.equal(isRateLimitFailure({ stderr: 'gh: HTTP 403: rate limit exceeded\n' }), true);
  assert.equal(isRateLimitFailure({ stderr: 'gh: HTTP 429: too many requests, rate limit\n' }), true);
  assert.equal(isRateLimitFailure({ stdout: '{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}' }), true);
  assert.equal(isRateLimitFailure({ stderr: 'gh: HTTP 404 Not Found\n' }), false);
  assert.equal(isRateLimitFailure({ stderr: 'gh: HTTP 502 Bad Gateway\n' }), false);
  assert.equal(isRateLimitFailure({ stderr: 'gh: HTTP 403 Forbidden\n' }), false, '403 但没有 rate limit 文案不算限流');
});

test('#247 SC7 限流不再当普通失败：抛 RATE_LIMITED，带响应头剩余，不重试', async () => {
  const { github, run, samples, sleeps } = setupWithRates(() => ({
    code: 1,
    stdout: withHeaders({ message: 'API rate limit already exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1762299600' }),
    stderr: 'gh: API rate limit already exceeded (HTTP 403)\n',
  }));
  await assert.rejects(
    () => github.graphql(QUERY, {}),
    (error) => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.remaining, '0');
      assert.equal(error.reset, '1762299600');
      assert.equal(error.identity, 'user');
      return true;
    },
  );
  assert.equal(run.calls.length, 1, '限流不是瞬时故障，不重试');
  assert.equal(sleeps.length, 0);
  assert.equal(samples.length, 1, '失败那次也要把响应头记下来');
});

test('#247 SC7 GraphQL 错误里带 RATE_LIMITED 码：同样按限流处理', async () => {
  const { github } = setupWithRates(() => ({
    code: 0,
    stdout: withHeaders(
      { errors: [{ type: 'RATE_LIMITED', message: 'Something went wrong while executing your query' }], data: null },
      { 'x-ratelimit-remaining': '3' },
    ),
    stderr: '',
  }));
  await assert.rejects(
    () => github.graphql(QUERY, {}),
    (error) => error.code === 'RATE_LIMITED' && error.remaining === '3',
  );
});

test('#247 响应头拆解：没有 HTTP 状态行时原样返回正文（老 gh / 测试替身）', () => {
  assert.deepEqual(splitGhHeaders('{"data":{"a":1}}'), { headers: {}, body: '{"data":{"a":1}}' });
  const parsed = splitGhHeaders('HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: 1499\r\n\r\n{"data":{}}');
  assert.equal(parsed.headers['x-ratelimit-remaining'], '1499');
  assert.equal(parsed.body, '{"data":{}}');
  assert.deepEqual(rateHeadersOf(parsed.headers), { remaining: '1499', reset: null });
});

test('#247 P2-4 读失败但没有响应头块（DNS / 超时 / 老 gh）：不把已知剩余抹成 unknown', async () => {
  const { github, samples } = setupWithRates(() => ({ code: 1, stdout: '', stderr: 'gh: Could not resolve host: api.github.com\n' }));
  await assert.rejects(() => github.graphql(QUERY, {}), /Could not resolve host/);
  assert.deepEqual(samples, [], '没有响应头就什么都别记：空值会把上一次的有效剩余覆盖成 unknown');
});

test('#247 P2-4 真响应头照记；头块里没有 ratelimit 字段（例如 502 页面）也不记', async () => {
  const { github, samples } = setupWithRates(() => ({
    code: 1,
    stdout: withHeaders({ message: 'Bad Gateway' }, { 'content-type': 'text/html' }),
    stderr: 'gh: HTTP 502 Bad Gateway\n',
  }));
  await assert.rejects(() => github.graphql(QUERY, {}), /502/);
  assert.deepEqual(samples, [], '没带 ratelimit 头的失败不覆盖已知剩余');
});
