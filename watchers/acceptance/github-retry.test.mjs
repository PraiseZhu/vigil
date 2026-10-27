import assert from 'node:assert/strict';
import test from 'node:test';
import { createGithub } from './bin/github.mjs';
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
