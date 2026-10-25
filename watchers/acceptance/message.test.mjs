import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { appendCodePaths, buildDispatchMessage, SESSION_DOC } from './bin/message.mjs';
import { REPO, sha256Body, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const BODY_VERSION = sha256Body('task body');

function valid(overrides = {}) {
  return {
    issue: `${REPO}#1`,
    kind: 'standalone',
    round: 3,
    commentId: 12345,
    bodyVersion: BODY_VERSION,
    ...overrides,
  };
}

test('SC2 派发消息带齐接口约定字段，第一句要求先读 SESSION.md', () => {
  const message = buildDispatchMessage(valid());
  const lines = message.split('\n');
  assert.equal(lines[0], '先读 watchers/acceptance/SESSION.md，照里面的步骤做完这一轮验收。');
  assert.match(message, new RegExp(`issue：${REPO}#1`));
  assert.match(message, /kind：standalone/);
  assert.match(message, /轮次：第 3 轮/);
  assert.match(message, /轮次评论 id：12345/);
  assert.match(message, new RegExp(`正文版本：${BODY_VERSION}`));
  assert.match(message, new RegExp(`步骤文档：${SESSION_DOC}`));
  assert.match(message, /helper\.mjs/);
  assert.match(message, new RegExp(`--issue ${REPO}#1 --round 3`));
  assert.match(message, /done/);
});

test('SC2 parent 任务和字符串形式的 id 也能生成', () => {
  const message = buildDispatchMessage(valid({ kind: 'parent', commentId: 'IC_kwDOExample' }));
  assert.match(message, /kind：parent/);
  assert.match(message, /轮次评论 id：IC_kwDOExample/);
});

test('SC2 派发消息不含令牌、profile 路径或绝对路径', () => {
  const home = tmpDir();
  const { stateDir, worktreeDir, tokenFile } = writeProfile(home);
  const message = buildDispatchMessage(valid());
  for (const secretPath of [home, stateDir, worktreeDir, tokenFile]) {
    assert.equal(message.includes(secretPath), false, `消息里出现了 profile 路径 ${secretPath}`);
  }
  assert.doesNotMatch(message, /token/i);
  assert.doesNotMatch(message, /\/Users\//);
  assert.doesNotMatch(message, /(^|\s)\/[^\s]/m);
  assert.equal(fs.existsSync(path.join(home, 'config', 'profile.json')), true);
});

test('SC2 字段不合法时抛错', () => {
  const bad = [
    { issue: 'example-owner/example-repo' },
    { issue: 'example-owner/example-repo#x' },
    { issue: 'example-owner/#1' },
    { issue: '/example-repo#1' },
    { issue: 'example-owner/example repo#1' },
    { issue: undefined },
    { kind: 'both' },
    { kind: undefined },
    { round: 0 },
    { round: -1 },
    { round: 1.5 },
    { round: '1' },
    { round: undefined },
    { commentId: undefined },
    { commentId: null },
    { commentId: '' },
    { commentId: 'not an id' },
    { commentId: 1.2 },
    { bodyVersion: 'sha256:abc' },
    { bodyVersion: BODY_VERSION.toUpperCase() },
    { bodyVersion: 'abc' },
    { bodyVersion: undefined },
  ];
  for (const override of bad) {
    assert.throws(
      () => buildDispatchMessage(valid(override)),
      /派发消息字段无效/,
      `应拒绝 ${JSON.stringify(override)}`,
    );
  }
});

test('SC11 宿主预取的代码路径接在派发消息后面：每个仓一行绝对路径，写明只读、要可写副本复制到 TMPDIR', () => {
  const message = buildDispatchMessage(valid());
  const withCode = appendCodePaths(message, [
    { repo: REPO, path: '/srv/acceptance/run/example-owner__example-repo__1__3/code/example-owner__example-repo', head: 'a'.repeat(40) },
    { repo: 'example-owner/other-repo', path: '/srv/acceptance/run/example-owner__example-repo__1__3/code/example-owner__other-repo' },
  ]);
  assert.ok(withCode.startsWith(message), '原消息不动');
  assert.match(withCode, /代码（宿主已检出各仓 main，只读）：/);
  assert.match(withCode, new RegExp(`^- ${REPO}：/srv/acceptance/run/\\S+/code/example-owner__example-repo（main @ ${'a'.repeat(12)}）$`, 'm'));
  assert.match(withCode, /^- example-owner\/other-repo：\/srv\/\S+other-repo$/m);
  assert.match(withCode, /\$TMPDIR/);
  assert.match(withCode, /不要 git clone/);
  assert.equal(appendCodePaths(message, []), message, '没有代码就原样返回');
  assert.throws(() => appendCodePaths(message, [{ repo: REPO, path: 'relative/dir' }]), /绝对路径/);
});
