// #61 SC2 / SC3：Slack 消息体的纯函数测试（Ready、ready-stalled、单条提醒、摘要）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { alertBlocks, digestBlocks, prLink, readyBlocks, stalledBlocks } from './host/slack-blocks.mjs';
import { REPO } from './fake-gh.fixture.mjs';

const MENTION = 'U0123456789';

function readyEvent(overrides = {}) {
  return {
    type: 'ready',
    issue: `${REPO}#2`,
    root: `${REPO}#1`,
    item: `${REPO}#1`,
    sc: [3, 5],
    repo: REPO,
    pr: 12,
    prUrl: `https://github.com/${REPO}/pull/12`,
    headSha: 'abcdef1234567890',
    checks: { green: 3, total: 3, url: `https://github.com/${REPO}/pull/12/checks` },
    diff: { files: 3, additions: 10, deletions: 2 },
    handoff: 'owner',
    ...overrides,
  };
}

function textOf(payload) {
  return JSON.stringify(payload);
}

function buttons(payload) {
  const out = [];
  for (const block of payload.blocks || []) {
    for (const element of block.elements || []) {
      if (element.type === 'button') out.push(element);
    }
  }
  return out;
}

test('SC2 owner 档：标题、六个字段、只有一个「打开 PR」按钮，全文没有「合并」字样', () => {
  const payload = readyBlocks({ event: readyEvent() }, {});
  const json = textOf(payload);
  assert.match(payload.text, /^修正 PR 已 Ready：example-owner\/example-repo#12/);
  const header = payload.blocks[0];
  assert.equal(header.type, 'header');
  assert.equal(header.text.text, `修正 PR 已 Ready：${REPO}#12`);
  const fields = payload.blocks.find((block) => block.type === 'fields').fields;
  const byLabel = Object.fromEntries(fields.map((field) => field.text.split('\n')[0].replaceAll('*', '')).map((label, index) => [label, fields[index].text.split('\n')[1]]));
  assert.equal(byLabel['任务 issue'], `${REPO}#1`);
  assert.equal(byLabel['修正子 issue'], `${REPO}#2`);
  assert.equal(byLabel.head, 'abcdef1');
  assert.match(byLabel.CI, /CI 3\/3 绿/);
  assert.ok(byLabel.CI.includes(`https://github.com/${REPO}/pull/12/checks`), '有 checks.url 就带链接');
  assert.equal(byLabel['改动'], '3 个文件 +10 \u22122');
  assert.equal(byLabel['修了'], 'SC3、SC5');

  const list = buttons(payload);
  assert.equal(list.length, 1, 'owner 档只有一个按钮');
  assert.equal(list[0].text.text, '打开 PR');
  assert.equal(list[0].url, `https://github.com/${REPO}/pull/12`);
  assert.equal(json.includes('合并'), false, 'owner 档消息里不能出现「合并」字样');
});

test('SC2 watcher 档：正文写「已交给 Mac mini 盯梢」，没有按钮，PR 链接在正文里', () => {
  const payload = readyBlocks({ event: readyEvent({ handoff: 'watcher' }) }, {});
  assert.equal(buttons(payload).length, 0, 'watcher 档不带按钮');
  assert.equal(payload.blocks.some((block) => block.type === 'actions'), false);
  const body = textOf(payload);
  assert.match(body, /已交给 Mac mini 盯梢/);
  assert.ok(body.includes(`https://github.com/${REPO}/pull/12`), '正文里有 PR 链接文字');
});

test('SC2 伪造的 prUrl 被替换；repo/pr 对不上的链接一律不用', () => {
  const forged = readyBlocks({
    event: readyEvent({ prUrl: 'https://github.com/example-org/other-repo/pull/99' }),
  }, {});
  assert.equal(buttons(forged)[0].url, `https://github.com/${REPO}/pull/12`);
  assert.equal(textOf(forged).includes('other-repo'), false);

  const evil = readyBlocks({ event: readyEvent({ prUrl: 'https://evil.example.com/pull/1' }) }, {});
  assert.equal(buttons(evil)[0].url, `https://github.com/${REPO}/pull/12`);
  assert.equal(textOf(evil).includes('evil.example.com'), false);

  const shapeOnly = prLink({ repo: REPO, pr: 12, prUrl: `https://github.com/${REPO}/pull/12/files` });
  assert.equal(shapeOnly.link, `https://github.com/${REPO}/pull/12`, '形状不对也自己拼');
});

test('SC3 ready-stalled：标题、审查入口提示、PR 链接、readyAt、head 前 7 位', () => {
  const payload = stalledBlocks({
    event: readyEvent({ type: 'ready-stalled', handoff: 'watcher', readyAt: '2026-10-01T08:00:00.000Z', prUrl: '' }),
  }, {});
  assert.match(payload.text, /^修正 PR 转 Ready 24 小时没人接：example-owner\/example-repo#12/);
  const body = textOf(payload);
  assert.match(body, /review-ingress-missing/);
  assert.match(body, /Mac mini/);
  assert.ok(body.includes(`https://github.com/${REPO}/pull/12`), '附 PR 链接');
  assert.match(body, /2026-10-01T08:00:00\.000Z/);
  assert.match(body, /abcdef1/);
  assert.equal(body.includes('合并'), false);
});

test('SC4 secret-found 消息只取冒号后的文件名列表', () => {
  const payload = alertBlocks(
    {
      source: 'alerts',
      type: 'secret-found',
      event: { kind: 'secret-found', issue: `${REPO}#3`, reason: 'branch.push 扫到疑似密钥，没推：src/a.js, b.txt' },
    },
    {},
  );
  const body = textOf(payload);
  assert.match(body, /src\/a\.js, b\.txt/);
  assert.equal(body.includes('branch.push'), false, '冒号前的话一个字都不带出去');
  assert.equal(body.includes('扫到疑似密钥，没推'), false);
  assert.equal(body.includes('合并'), false);
});

test('SC4 出去的文字全部过 redact：Bearer 形状的密钥和本机路径不会出现在消息里', () => {
  const secretPart = 'abcdefghijklmnopqrstuvwxyz';
  const payload = alertBlocks(
    {
      source: 'alerts',
      type: 'gate-rejected',
      event: { kind: 'gate-rejected', issue: `${REPO}#4`, reason: `带 Bearer ${secretPart} 去请求` },
    },
    { stateDir: '/path/to/acceptance-state' },
  );
  const body = textOf(payload);
  assert.equal(body.includes(secretPart), false);
  assert.match(body, /已隐去/);
});

test('摘要：多条合成一条，永不 @（即使 profile 配了 slackMentionUserId）', () => {
  const payload = digestBlocks(
    [
      { type: 'loop-restarted', reason: '心跳过期' },
      { type: 'round-failed', issue: `${REPO}#5`, reason: '宿主出错' },
    ],
    { slackMentionUserId: MENTION },
  );
  const body = textOf(payload);
  assert.match(payload.text, /^验收机摘要（2 条）/);
  assert.match(body, /loop-restarted/);
  assert.match(body, /round-failed/);
  assert.ok(body.includes(`${REPO}#5`));
  assert.equal(body.includes(`<@${MENTION}>`), false, '摘要永不 @');
});
