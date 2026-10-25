import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(created[0].title, `修正：${OTHER_REPO}#7 SC7`);

  const body = created[0].body;
  assert.ok(body.includes(`> 修正子 issue · 总 issue ${REPO}#1 · 原属 ${OTHER_REPO}#7`), body);
  assert.ok(body.includes('## 没过的验收项'));
  assert.ok(body.includes('跨仓也要收 验证：browser-fixture'), body);
  assert.ok(body.includes('## 没过的原因'));
  assert.ok(body.includes('## 验收标准'));
  assert.ok(body.includes('- [ ] SC1 跨仓也要收 验证：browser-fixture'), body);
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
