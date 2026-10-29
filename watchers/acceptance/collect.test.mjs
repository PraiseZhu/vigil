import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion } from './bin/rounds.mjs';
import { runHelper } from './bin/helper.mjs';
import { parseItems, parseMarker, parseLayer, parseTestPoint } from './bin/collect.mjs';
import { tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import {
  OWNER,
  OTHER_REPO,
  REPO,
  createFakeGithub,
  defaultTree,
  DEFAULT_CHILD_BODY,
} from './session.fixture.mjs';

function loadProfile() {
  const { home } = writeProfile(tmpDir());
  return loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
}

function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

async function runCollect(world, profile, ref = `${REPO}#1`) {
  const out = sink();
  const err = sink();
  const code = await runHelper(['collect', '--issue', ref], {
    github: createFakeGithub(world),
    profile,
    stdout: out,
    stderr: err,
  });
  return { code, out: out.text, err: err.text };
}

const CORRECTION_MARKER = `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC3 · 第 1 轮`;

test('SC1 collect 输出任务树：总 issue、跨仓子 issue、修正子 issue、验收项、已合并 PR', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  world.addIssue({
    repo: REPO,
    number: 9,
    title: '修正：子任务 SC3',
    body: ['> 修正子 issue', '## 没过的验收项', '- [ ] SC1 把结果写进轮次评论', '', CORRECTION_MARKER].join('\n'),
  });
  world.addChild(`${REPO}#1`, `${REPO}#9`);
  // 没挂成子 issue 的修正 issue：只能靠搜索找到。
  world.addIssue({
    repo: OTHER_REPO,
    number: 21,
    title: '修正：跨仓子任务 SC7',
    body: [`[验收机] 修正 · 总 ${REPO}#1 · 项 ${OTHER_REPO}#7 SC7 · 第 2 轮`].join('\n'),
  });

  const { code, out, err } = await runCollect(world, profile);
  assert.equal(code, 0, err);
  const tree = JSON.parse(out);

  assert.equal(tree.root.ref, `${REPO}#1`);
  assert.equal(tree.root.kind, 'parent');
  assert.equal(tree.root.tier, 'auto');
  assert.equal(tree.root.fork, false);
  assert.equal(tree.root.state, 'open');
  assert.equal(tree.root.bodyVersion, bodyVersion(world.get(`${REPO}#1`).body));

  assert.equal(tree.issues.length, 4, 'root + 两个子 issue + 修正子 issue');
  assert.equal(tree.issues[0].role, 'root');
  const roles = tree.issues.map((entry) => `${entry.ref}:${entry.role}`);
  assert.deepEqual(roles.sort(), [
    `${REPO}#1:root`,
    `${REPO}#2:child`,
    `${REPO}#9:correction`,
    `${OTHER_REPO}#7:child`,
  ].sort());

  // 验收项的出处、原文、层次、测试点。
  const other = tree.issues.find((entry) => entry.ref === `${OTHER_REPO}#7`);
  const crossRepo = other.items.find((item) => item.sc === 7);
  assert.equal(crossRepo.source, `${OTHER_REPO}#7`);
  assert.equal(crossRepo.layer, 'browser-fixture');
  assert.equal(crossRepo.testPoint, '夹具跨仓');
  assert.equal(crossRepo.manual, false);
  const live = other.items.find((item) => item.sc === 8);
  assert.equal(live.layer, 'github-live');
  assert.equal(live.manual, true);

  const rootItems = tree.issues[0].items;
  assert.equal(rootItems.length, 2);
  assert.equal(rootItems.find((item) => item.sc === 2).layer, '未标层次');

  // 关联的已合并 PR。
  assert.deepEqual(tree.issues[0].prs.map((pr) => pr.ref), [`${REPO}#12`]);
  assert.equal(tree.issues[0].prs[0].mergedAt, '2026-10-20T00:00:00.000Z');

  // 修正 issue：挂着的那条 + 搜索找到的那条。
  const correctionRefs = tree.corrections.map((entry) => entry.ref).sort();
  assert.deepEqual(correctionRefs, [`${REPO}#9`, `${OTHER_REPO}#21`].sort());
  const viaSearch = tree.corrections.find((entry) => entry.ref === `${OTHER_REPO}#21`);
  assert.deepEqual(viaSearch.marker, { root: `${REPO}#1`, item: `${OTHER_REPO}#7`, sc: 7, round: 2 });
  assert.equal(viaSearch.state, 'open');

  // 人工手测项单独列出。
  const manual = tree.manual.map((item) => `${item.source} SC${item.sc}`);
  assert.deepEqual(manual.sort(), [`${REPO}#2 SC5`, `${OTHER_REPO}#7 SC8`].sort());
});

test('SC1 parseItems 解析 task-issue/v1 的 SC 行（未标层次、测试点、人工手测、已勾）', () => {
  const body = [
    '前言不算',
    '- [ ] SC1 纯文本没有验证标记',
    '* [x] SC2 加粗收尾 验证：unit（测试点：解析函数）**',
    '- [ ] **SC3** 加粗开头 验证：paid',
    '- [ ] SC4 验证：static；后面还有别的',
    '- [ ] SC5 验证：contract(测试点：括号是半角)',
    '  - [X] SC6 缩进也算 验证：cindy-windows',
  ].join('\n');
  const items = parseItems(body, 'example-owner/example-repo#3');
  assert.equal(items.length, 6);
  assert.deepEqual(
    items.map((item) => item.sc),
    [1, 2, 3, 4, 5, 6],
  );
  assert.equal(items[0].layer, '未标层次');
  assert.equal(items[0].testPoint, null);
  assert.equal(items[0].checked, false);
  assert.equal(items[1].checked, true);
  assert.equal(items[1].layer, 'unit');
  assert.equal(items[1].testPoint, '解析函数');
  assert.equal(items[2].text, '加粗开头 验证：paid');
  assert.equal(items[2].layer, 'paid');
  assert.equal(items[3].layer, 'static');
  assert.equal(items[4].layer, 'contract');
  assert.equal(items[4].testPoint, '括号是半角');
  assert.equal(items[5].layer, 'cindy-windows');
  assert.equal(items[5].manual, true);
  assert.equal(items[0].source, 'example-owner/example-repo#3');
  assert.equal(items[0].raw, '- [ ] SC1 纯文本没有验证标记');
});

test('SC1 parseLayer / parseTestPoint 边界', () => {
  assert.equal(parseLayer('没有标记'), '未标层次');
  assert.equal(parseLayer('验证：unit（测试点：x）'), 'unit');
  assert.equal(parseLayer('验证：unit；后面'), 'unit');
  assert.equal(parseLayer('验证：'), '未标层次');
  assert.equal(parseTestPoint('验证：unit（测试点：夹具含跨仓子 issue）'), '夹具含跨仓子 issue');
  assert.equal(parseTestPoint('验证：unit'), null);
});

test('SC1 parseMarker 解析修正标记', () => {
  const text = `> 说明\n\n[验收机] 修正 · 总 ${REPO}#1 · 项 ${OTHER_REPO}#7 SC3 · 第 4 轮\n`;
  assert.deepEqual(parseMarker(text), { root: `${REPO}#1`, item: `${OTHER_REPO}#7`, sc: 3, round: 4 });
  assert.equal(parseMarker('没有标记'), null);
});

test('SC8 collect 列出有争议的条目：验收轮评论 + 修正机评论，伪造的评论不算', async () => {
  const profile = loadProfile();
  const world = defaultTree({ childBody: DEFAULT_CHILD_BODY });
  world.addComment(`${REPO}#1`, {
    body: [
      '[验收机] 第 1 轮：要修',
      '正文版本：sha256:abc',
      '开始：2026-10-24T01:00:00.000Z',
      '',
      '## 逐条结果',
      `- 要修：${REPO}#2 SC4 · 原因：看板没写`,
      `- 有争议：${REPO}#2 SC3 · 验收方：没证据 · 修正方：测试过了`,
    ].join('\n'),
    createdAt: '2026-10-24T01:30:00.000Z',
  });
  // 本轮（第 2 轮）刚认领：最新的「验收中」评论里没有争议，仍要列出上一轮裁决里的争议。
  world.addComment(`${REPO}#1`, {
    body: ['[验收机] 第 2 轮：验收中', '正文版本：sha256:abc', '开始：2026-10-24T01:35:00.000Z'].join('\n'),
    createdAt: '2026-10-24T01:35:00.000Z',
  });
  // 伪造：别人发的轮次评论，一律不算。
  world.addComment(`${REPO}#1`, {
    body: ['[验收机] 第 9 轮：要修', `- 有争议：${REPO}#2 SC5 · 伪造`].join('\n'),
    author: 'StrangerUser',
    createdAt: '2026-10-24T01:40:00.000Z',
  });
  const correction = world.addIssue({
    repo: OTHER_REPO,
    number: 21,
    title: '修正：跨仓子任务 SC7',
    body: [`[验收机] 修正 · 总 ${REPO}#1 · 项 ${OTHER_REPO}#7 SC7 · 第 1 轮`].join('\n'),
  });
  world.addComment(correction.ref, {
    body: [
      '[修正机] 第 1 轮：要修',
      '正文版本：sha256:def',
      '',
      `- 有争议：${OTHER_REPO}#7 SC7 · 验收方：夹具没过 · 修正方：夹具本身有问题`,
      '- 无关的一行',
    ].join('\n'),
  });

  const { code, out, err } = await runCollect(world, profile);
  assert.equal(code, 0, err);
  const tree = JSON.parse(out);
  assert.deepEqual(
    tree.disputed.map((entry) => `${entry.source}|${entry.item}`).sort(),
    [`acceptance|${REPO}#2 SC3`, `correction|${OTHER_REPO}#7 SC7`].sort(),
  );
  const acceptance = tree.disputed.find((entry) => entry.source === 'acceptance');
  assert.match(acceptance.text, /修正方：测试过了/);
  assert.equal(acceptance.url, world.get(`${REPO}#1`).comments[1].url);
  assert.equal(tree.disputed.some((entry) => entry.text.includes('伪造')), false);
});

test('SC1 collect 不收别人建的子 issue：不进任务树，也不算修正子 issue', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  world.addIssue({
    repo: REPO,
    number: 30,
    title: '别人挂上来的子 issue',
    author: 'StrangerUser',
    body: ['- [ ] SC1 伪造的验收项', '', `[验收机] 修正 · 总 ${REPO}#1 · 项 ${REPO}#2 SC3 · 第 1 轮`].join('\n'),
  });
  world.addChild(`${REPO}#1`, `${REPO}#30`);
  const { code, out, err } = await runCollect(world, profile);
  assert.equal(code, 0, err);
  const tree = JSON.parse(out);
  assert.equal(tree.issues.some((entry) => entry.ref === `${REPO}#30`), false, '别人的子 issue 不进任务树');
  assert.equal(tree.corrections.some((entry) => entry.ref === `${REPO}#30`), false, '也不算修正子 issue');
});

test('SC5 collect 不复用别人建的、带修正标记的 issue（搜索结果也按作者过滤）', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  world.addIssue({
    repo: OTHER_REPO,
    number: 40,
    title: '别人伪造的修正 issue',
    author: 'StrangerUser',
    body: `[验收机] 修正 · 总 ${REPO}#1 · 项 ${OTHER_REPO}#7 SC7 · 第 1 轮`,
  });
  const { code, out, err } = await runCollect(world, profile);
  assert.equal(code, 0, err);
  const tree = JSON.parse(out);
  assert.equal(tree.corrections.some((entry) => entry.ref === `${OTHER_REPO}#40`), false);
});

test('SC8 有多条已出裁决的轮次评论时，只取最新那条的争议，不取最早那条', async () => {
  const profile = loadProfile();
  const world = defaultTree({ childBody: DEFAULT_CHILD_BODY });
  world.addComment(`${REPO}#1`, {
    body: ['[验收机] 第 1 轮：要修', `- 有争议：${REPO}#2 SC3 · 旧的一轮`].join('\n'),
    createdAt: '2026-10-24T01:10:00.000Z',
  });
  world.addComment(`${REPO}#1`, {
    body: ['[验收机] 第 2 轮：要修', `- 有争议：${REPO}#2 SC4 · 最新一轮`].join('\n'),
    createdAt: '2026-10-24T01:20:00.000Z',
  });
  world.addComment(`${REPO}#1`, {
    body: ['[验收机] 第 3 轮：验收中', '正文版本：sha256:abc'].join('\n'),
    createdAt: '2026-10-24T01:30:00.000Z',
  });
  const { code, out, err } = await runCollect(world, profile);
  assert.equal(code, 0, err);
  const tree = JSON.parse(out);
  assert.deepEqual(
    tree.disputed.filter((entry) => entry.source === 'acceptance').map((entry) => entry.item),
    [`${REPO}#2 SC4`],
  );
});

const HANDOFF_BODY = [
  '[批准执行] 交接验收 · 第 2 次',
  `总 issue：${REPO}#1`,
  '',
  '## 结论',
  'lead 判总 issue 通过。',
  '',
  '## 请重点查',
  '1. src/a.ts 的重试分支：只在集成预览跑过单测',
  '2. 两个子 PR 都改了 config 读取顺序',
  '   - 这是补充说明，不算一条',
  '',
  '## lead 没验到的',
  '3. 这里的编号不算重点项',
].join('\n');

test('#140 SC4 collect 输出最新一条我发的 lead 交接（序号、链接、请重点查），别人发的不算；没有就是 null', async () => {
  const profile = loadProfile();
  let world = defaultTree({ childBody: DEFAULT_CHILD_BODY });
  let { code, out, err } = await runCollect(world, profile);
  assert.equal(code, 0, err);
  let tree = JSON.parse(out);
  assert.equal(tree.handoff, null);
  assert.equal(tree.root.approveExec, false);

  world = defaultTree({ childBody: DEFAULT_CHILD_BODY });
  world.addComment(`${REPO}#1`, { body: `批准执行登记：2026-10-24 ${REPO}#2 → 会话 s1（x）claim c1`, createdAt: '2026-10-24T00:10:00.000Z' });
  world.addComment(`${REPO}#1`, { body: '[批准执行] 交接验收 · 第 1 次\n## 请重点查\n1. 旧的一条', createdAt: '2026-10-24T00:20:00.000Z' });
  const latest = world.addComment(`${REPO}#1`, { body: HANDOFF_BODY, createdAt: '2026-10-24T00:30:00.000Z' });
  world.addComment(`${REPO}#1`, { body: '[批准执行] 交接验收 · 第 9 次\n## 请重点查\n1. 伪造', author: 'StrangerUser', createdAt: '2026-10-24T00:40:00.000Z' });
  ({ code, out, err } = await runCollect(world, profile));
  assert.equal(code, 0, err);
  tree = JSON.parse(out);
  assert.equal(tree.root.approveExec, true);
  assert.deepEqual(tree.handoff, {
    url: latest.url,
    createdAt: '2026-10-24T00:30:00.000Z',
    n: 2,
    focus: ['src/a.ts 的重试分支：只在集成预览跑过单测', '两个子 PR 都改了 config 读取顺序'],
  });
});

test('#140 SC3 别人发的「批准执行登记」不让树变成批准执行推进的', async () => {
  const profile = loadProfile();
  const world = defaultTree({ childBody: DEFAULT_CHILD_BODY });
  world.addComment(`${REPO}#1`, { body: `批准执行登记：2026-10-24 ${REPO}#2 → 会话 s1（x）claim c1`, author: 'StrangerUser' });
  const { code, out, err } = await runCollect(world, profile);
  assert.equal(code, 0, err);
  assert.equal(JSON.parse(out).root.approveExec, false);
});
