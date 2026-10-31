import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion } from './bin/rounds.mjs';
import { runHelper } from './bin/helper.mjs';
import { HANDOFF_REPO, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import {
  FORK_REPO,
  OTHER_REPO,
  REPO,
  createFakeGithub,
  createWorld,
  defaultTree,
} from './session.fixture.mjs';
import { correctionBody, correctionTitle, scopeLinesOf } from './bin/correct.mjs';
import { parseItems, parseMarker } from './bin/collect.mjs';

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

const now = () => Date.parse('2026-10-24T02:00:00.000Z');

async function run(world, profile, argv) {
  const out = sink();
  const err = sink();
  const code = await runHelper(argv, {
    github: createFakeGithub(world),
    profile,
    now,
    stdout: out,
    stderr: err,
  });
  return { code, out: out.text, err: err.text };
}

function correctArgs(item, why = '夹具没过') {
  return ['correct', '--issue', `${REPO}#1`, '--round', '1', '--item', item, '--why', why];
}

function writesOf(world, type) {
  return world.writes.filter((action) => action.type === type);
}

test('SC5 新开修正子 issue：模板、修正标记、挂到同一个总 issue、看板要修', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const result = await run(
    world,
    profile,
    correctArgs(`${OTHER_REPO}#7 SC7`, `在 ${profile.stateDir}/worktrees 下跑挂了`),
  );
  assert.equal(result.code, 0, result.err);
  const printed = JSON.parse(result.out);
  assert.equal(printed.reused, false);
  assert.match(printed.ref, /^example-owner\/other-repo#\d+$/);

  const created = writesOf(world, 'issue.create');
  assert.equal(created.length, 1);
  assert.equal(created[0].repo, OTHER_REPO, '非 fork 档开在原属子 issue 的仓里');
  assert.equal(created[0].dedupeKey, `correct:${REPO}#1:${OTHER_REPO}#7:SC7:1`);
  assert.match(created[0].title, /^\[子[0-9]+\/[0-9]+\] /, '#169 SC1：标题按本机子 issue 模板');
  assert.equal(created[0].title, `[子3/3] 修正：${OTHER_REPO}#7 SC7`);
  assert.deepEqual(created[0].labels, ['子issue'], '#169 SC1：创建请求带标签「子issue」');

  const body = created[0].body;
  assert.ok(body.includes(`> 修正子 issue · 总 issue ${REPO}#1 · 原属 ${OTHER_REPO}#7`), body);
  for (const heading of ['## 目标', '## 原因', '## 范围（可改）', '## 不做', '## 依赖', '## 验收标准']) {
    assert.ok(body.split('\n').includes(heading), `缺「${heading}」：${body}`);
  }
  assert.ok(body.includes('跨仓也要收 验证：browser-fixture'), body);
  assert.ok(body.includes('- [ ] SC1 跨仓也要收 验证：browser-fixture（测试点：夹具跨仓）'), body);
  assert.ok(body.includes('## 参考') && body.includes('## 待定问题'), body);
  assert.ok(body.includes(`[验收机] 修正 · 总 ${REPO}#1 · 项 ${OTHER_REPO}#7 SC7 · 第 1 轮`));
  assert.equal(body.includes('原 issue：'), false, '非 fork 档不写链回原 issue 那一行');
  assert.equal(body.includes(profile.stateDir), false, '原因要脱敏');

  const attached = writesOf(world, 'subissue.add');
  assert.equal(attached.length, 1);
  assert.equal(attached[0].repo, REPO);
  assert.equal(attached[0].issue, 1);
  assert.equal(attached[0].subRepo, OTHER_REPO);
  assert.equal(world.get(`${REPO}#1`).subIssues.includes(printed.ref), true);

  assert.equal(world.get(`${REPO}#1`).project['验收'], '要修');
  assert.equal(world.get(printed.ref).project['验收'], '要修');
  assert.equal(world.get(printed.ref).project['裁决'], world.get(`${REPO}#1`).comments[0].url);
});

test('#96 修正子 issue 正文按 task-issue/v1 子 issue 模板写：只有一行 SC1，标记不变，过 check-pr-issue 的结构检查', () => {
  const args = { root: `${REPO}#1`, rootUrl: 'https://example.invalid/1', item: `${OTHER_REPO}#7`, text: '跨仓也要收 验证：browser-fixture', why: '没收到', sc: 7, round: 2 };
  for (const fork of [false, true]) {
    const body = correctionBody({ ...args, fork });
    const items = parseItems(body, 'x');
    assert.equal(items.length, 1, '正文里只能有一行 SC：parseItems 会把每个 SC 行都当验收项');
    assert.equal(items[0].sc, 1);
    assert.equal(items[0].layer, 'browser-fixture');
    assert.deepEqual(parseMarker(body), { root: `${REPO}#1`, item: `${OTHER_REPO}#7`, sc: 7, round: 2 });
    // 和本地 check-pr-issue.sh 同一组检查：五个锚点标题 + SC<n> 编号行。
    for (const heading of ['## 目标', '## 范围', '## 不做', '## 依赖', '## 验收标准']) {
      assert.ok(body.split('\n').some((line) => line.startsWith(heading)), heading);
    }
    assert.ok(body.split('\n').some((line) => /^\s*[-*]\s*(\[[ xX]\])?\s*(\*\*)?SC[0-9]+\b/.test(line)));
    assert.equal(body.split('\n')[0].startsWith('原 issue：'), fork);
  }
});

/** 与本机 check-pr-issue.sh 同等的规则，加上 #169 的模板细则（范围反引号、参考 / 待定问题段、SC 验证层和测试点）。 */
function assertChildTemplate(body) {
  const lines = body.split('\n');
  for (const heading of ['## 目标', '## 范围', '## 不做', '## 依赖', '## 验收标准']) {
    assert.ok(lines.some((line) => line.startsWith(heading)), `缺「${heading}」：${body}`);
  }
  assert.ok(lines.some((line) => /^\s*[-*]\s*(\[[ xX]\])?\s*(\*\*)?SC[0-9]+\b/.test(line)), '没有 SC<n> 项');
  for (const heading of ['## 参考', '## 待定问题']) {
    const at = lines.indexOf(heading);
    assert.ok(at !== -1, `缺「${heading}」`);
    const content = lines.slice(at + 1).find((line) => line.trim());
    assert.ok(content && !content.startsWith('## '), `「${heading}」段为空，没内容要写「无」`);
  }
  const scopeAt = lines.findIndex((line) => line.startsWith('## 范围'));
  const scope = [];
  for (const line of lines.slice(scopeAt + 1)) {
    if (line.startsWith('## ')) break;
    if (line.trim()) scope.push(line);
  }
  assert.ok(scope.length > 0, '范围段为空');
  for (const line of scope) assert.match(line, /^- `[^`]+`/, `范围行没有反引号路径：${line}`);
  const sc = lines.filter((line) => /^\s*[-*]\s*(\[[ xX]\])?\s*SC[0-9]+\b/.test(line));
  assert.equal(sc.length, 1, '正文只有一行 SC1（例外，见 docs/acceptance-prbot.md）');
  assert.match(sc[0], /验证：[A-Za-z][\w-]*（测试点：[^）]+）/, `SC 行缺「验证：<层>（测试点：…）」：${sc[0]}`);
}

test('#169 修正子 issue 正文过本机子 issue 模板规则：范围反引号、参考 / 待定问题、SC 验证层和测试点', () => {
  const base = { root: `${REPO}#1`, rootUrl: 'https://example.invalid/1', item: `${OTHER_REPO}#7`, why: '没收到', sc: 7, round: 2 };
  const cases = [
    { text: '跨仓也要收 验证：browser-fixture' },
    { text: '能导出 CSV。验证：unit（测试点：export()）', scopeLines: ['- `src/export.mjs`：导出'] },
    { text: '没写层次的旧项' },
  ];
  for (const fork of [false, true]) {
    for (const extra of cases) {
      const body = correctionBody({ ...base, ...extra, fork, verdictUrl: 'https://example.invalid/c/1' });
      assertChildTemplate(body);
      const items = parseItems(body, 'x');
      assert.equal(items.length, 1);
      assert.deepEqual(parseMarker(body), { root: `${REPO}#1`, item: `${OTHER_REPO}#7`, sc: 7, round: 2 });
    }
  }
  const kept = correctionBody({ ...base, ...cases[1] });
  assert.ok(kept.includes('- [ ] SC1 能导出 CSV。验证：unit（测试点：export()）'), '原文已有层和测试点就原样照抄');
  assert.ok(kept.includes('- `src/export.mjs`：导出'), '范围行照抄原属 issue');
  assert.equal(parseItems(kept, 'x')[0].layer, 'unit');
  const filled = correctionBody({ ...base, text: '跨仓也要收 验证：browser-fixture' });
  assert.ok(filled.includes(`- [ ] SC1 跨仓也要收。验证：browser-fixture（测试点：${OTHER_REPO}#7 SC7 的原验收入口）`), filled);
  assert.ok(correctionBody({ ...base, text: '没写层次的旧项' }).includes('- [ ] SC1 没写层次的旧项。验证：static（测试点：'));
});

test('#169 scopeLinesOf 只取「## 范围」段里带反引号的行，标题已带 [子N/M] 不重复加', () => {
  const body = ['## 范围（可改）', '', '- `a/**/*.mjs`：改', '- 相关测试', '* `b.md`：文档', '', '## 不做', '- `c`'].join('\n');
  assert.deepEqual(scopeLinesOf(body), ['- `a/**/*.mjs`：改', '- `b.md`：文档']);
  assert.deepEqual(scopeLinesOf('没有范围段'), []);
  assert.equal(correctionTitle({ index: 2, title: '[子1/1] 修 X' }), '[子2/2] 修 X');
});

test('SC5 复用上一轮中断时留下的开着的修正子 issue，不重复开', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const leftover = world.addIssue({
    repo: OTHER_REPO,
    number: 21,
    title: '修正：跨仓子任务 SC7',
    body: [`[验收机] 修正 · 总 ${REPO}#1 · 项 ${OTHER_REPO}#7 SC7 · 第 1 轮`].join('\n'),
  });
  world.addChild(`${REPO}#1`, leftover.ref);

  const result = await run(world, profile, correctArgs(`${OTHER_REPO}#7 SC7`));
  assert.equal(result.code, 0, result.err);
  const printed = JSON.parse(result.out);
  assert.equal(printed.reused, true);
  assert.equal(printed.ref, leftover.ref);
  assert.equal(writesOf(world, 'issue.create').length, 0, '有开着的就复用');
  assert.equal(writesOf(world, 'subissue.add').length, 0);
  assert.equal(world.get(`${REPO}#1`).project['验收'], '要修');
});

test('SC5 独立 issue 已关：先重开再挂修正子 issue', async () => {
  const profile = loadProfile();
  const world = createWorld({ now });
  const rootBody = ['# 独立任务', '', '- [ ] SC1 跑一遍测试 验证：unit（测试点：真跑）'].join('\n');
  const root = world.addIssue({ repo: REPO, number: 1, title: '独立任务', body: rootBody, state: 'closed', closedAt: '2026-10-23T00:00:00.000Z' });
  world.addComment(root.ref, roundComment({ round: 1, status: '验收中', bodyVersion: bodyVersion(rootBody) }));

  const result = await run(world, profile, correctArgs(`${REPO}#1 SC1`));
  assert.equal(result.code, 0, result.err);
  const order = world.writes.map((action) => action.type);
  assert.deepEqual(order.slice(0, 3), ['issue.reopen', 'issue.create', 'subissue.add']);
  assert.equal(world.writes[0].dedupeKey, `reopen:${REPO}#1:1`);
  assert.equal(world.get(`${REPO}#1`).state, 'open');
});

test('SC5 makecindy/cindy 从 fork 开普通 issue：首行链回原 issue，不走 subissue.add', async () => {
  const profile = loadProfile();
  const world = createWorld({ now });
  const rootBody = ['# fork 任务', '', '- [ ] SC2 修一下 验证：unit'].join('\n');
  const root = world.addIssue({ repo: FORK_REPO, number: 5, title: 'fork 任务', body: rootBody });
  world.addComment(root.ref, roundComment({ round: 1, status: '验收中', bodyVersion: bodyVersion(rootBody) }));

  const result = await run(world, profile, [
    'correct',
    '--issue',
    FORK_REPO + '#5',
    '--round',
    '1',
    '--item',
    `${FORK_REPO}#5 SC2`,
    '--why',
    '修一下',
  ]);
  assert.equal(result.code, 0, result.err);
  const created = writesOf(world, 'issue.create');
  assert.equal(created.length, 1);
  assert.equal(created[0].repo, FORK_REPO, 'fork 档开在总 issue 的仓里');
  assert.equal(created[0].body.split('\n')[0], `原 issue：${root.url}`);
  assert.equal(writesOf(world, 'subissue.add').length, 0, 'fork 档不走 subissue.add');
});

test('SC5 watch 档只出裁决、写看板：correct 一律拒绝且零写入', async () => {
  const profile = loadProfile();
  const world = createWorld({ now });
  const rootBody = ['# 交接仓任务', '', '- [ ] SC1 看一下 验证：unit'].join('\n');
  const root = world.addIssue({ repo: HANDOFF_REPO, number: 3, title: '交接仓', body: rootBody });
  world.addComment(root.ref, roundComment({ round: 1, status: '验收中', bodyVersion: bodyVersion(rootBody) }));

  const result = await run(world, profile, [
    'correct',
    '--issue',
    `${HANDOFF_REPO}#3`,
    '--round',
    '1',
    '--item',
    `${HANDOFF_REPO}#3 SC1`,
    '--why',
    '要修',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.err, /watch 档只出裁决、写看板/);
  assert.equal(world.writes.length, 0);
});

test('SC9 correct 不是本轮 → 退出码 3，零写入', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const result = await run(world, profile, [
    'correct',
    '--issue',
    `${REPO}#1`,
    '--round',
    '7',
    '--item',
    `${OTHER_REPO}#7 SC7`,
    '--why',
    'x',
  ]);
  assert.equal(result.code, 3);
  assert.match(result.err, /期望第 7 轮/);
  assert.match(result.err, /实际第 1 轮（验收中）/);
  assert.equal(world.writes.length, 0);
});

test('#169 文档写明修正子 issue 的模板格式和「正文只有一行 SC1」例外', () => {
  const doc = readFileSync(new URL('../../docs/acceptance-prbot.md', import.meta.url), 'utf8');
  assert.match(doc, /## 修正子 issue 的格式（#169）/);
  for (const phrase of ['[子N/M]', '`子issue`', '「参考」', '「待定问题」', '验证：<层>（测试点：…）', '正文只有一行 SC1']) {
    assert.ok(doc.includes(phrase), `docs/acceptance-prbot.md 缺「${phrase}」`);
  }
});
