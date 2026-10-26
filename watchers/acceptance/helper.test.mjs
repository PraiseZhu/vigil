import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion, cachePath, readIssueCache } from './bin/rounds.mjs';
import { WriteBusyError, WriteRejectedError } from './bin/github.mjs';
import { runHelper } from './bin/helper.mjs';
import { applyTicks } from './bin/close.mjs';
import { sessionPath } from './bin/push.mjs';
import { HANDOFF_REPO, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import {
  CLOCK,
  CLOCK_BEIJING,
  OTHER_REPO,
  REPO,
  createFakeGithub,
  createWorld,
  defaultTree,
  fullConclusions,
  writeJsonFile,
  ALL_RAN,
  ALL_RAN_CHECKS_FILE,
  PASS_VERDICT_FILE,
} from './session.fixture.mjs';

function loadProfile() {
  const { home } = writeProfile(tmpDir());
  return { profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), home };
}

function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

const now = () => Date.parse(CLOCK);

async function run(world, profile, argv, extra = {}) {
  const out = sink();
  const err = sink();
  const code = await runHelper(argv, {
    github: createFakeGithub(world, { onWrite: extra.onWrite }),
    profile,
    now,
    stdout: out,
    stderr: err,
    git: extra.git,
  });
  return { code, out: out.text, err: err.text };
}

function typesOf(world) {
  return world.writes.map((action) => action.type);
}

test('helper 未知命令 / 缺参数 → 退出码 1 并打印用法', async () => {
  const { profile } = loadProfile();
  const world = defaultTree();
  const unknown = await run(world, profile, ['nope', '--issue', `${REPO}#1`]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /未知命令/);
  assert.match(unknown.err, /用法：/);

  const missingRound = await run(world, profile, ['progress', '--issue', `${REPO}#1`]);
  assert.equal(missingRound.code, 1);
  assert.match(missingRound.err, /--round/);

  const missingIssue = await run(world, profile, ['collect']);
  assert.equal(missingIssue.code, 1);
  assert.match(missingIssue.err, /--issue/);
  assert.equal(world.writes.length, 0);
});

test('SC4 close 勾掉已验证的项、人工手测标行尾、关总 issue、看板全部写通过', async () => {
  const { profile, home } = loadProfile();
  const world = defaultTree();
  const verified = writeJsonFile(home, 'verified.json', { checks: ALL_RAN,
    items: [
      { ref: `${REPO}#2`, sc: 3 },
      { ref: `${OTHER_REPO}#7`, sc: 7 },
    ],
    manual: [{ ref: `${REPO}#2`, sc: 5 }],
  });

  const result = await run(world, profile, ['close', '--issue', `${REPO}#1`, '--round', '1', '--verified', verified, '--verdict', PASS_VERDICT_FILE]);
  assert.equal(result.code, 0, result.err);
  const printed = JSON.parse(result.out);
  assert.equal(printed.closed, `${REPO}#1`);
  assert.equal(printed.edited.length, 2);

  const childBody = world.get(`${REPO}#2`).body;
  assert.ok(childBody.includes('- [x] SC3 把结果写进轮次评论 验证：unit（测试点：假 gh）'), childBody);
  assert.ok(childBody.includes('- [x] SC4 看板写验收 验证：contract'));
  assert.ok(childBody.includes('- [ ] SC5 在真机上点一遍 验证：cindy-mac（测试点：人工看） 人工手测'));
  const otherBody = world.get(`${OTHER_REPO}#7`).body;
  assert.ok(otherBody.includes('- [x] SC7 跨仓也要收'));
  assert.ok(otherBody.includes('- [ ] SC8 真仓里跑一次 验证：github-live'), '没验的项不勾');

  const root = world.get(`${REPO}#1`);
  assert.equal(root.state, 'closed');
  assert.equal(world.writes.find((action) => action.type === 'issue.close').reason, 'completed');
  assert.equal(world.writes.find((action) => action.type === 'issue.close').dedupeKey, `close:${REPO}#1:1`);
  assert.equal(world.writes.find((action) => action.type === 'issue.edit').dedupeKey, `close-edit:${REPO}#2:1`);

  const roundUrl = root.comments[0].url;
  for (const ref of [`${REPO}#1`, `${REPO}#2`, `${OTHER_REPO}#7`]) {
    assert.equal(world.get(ref).project['验收'], '通过', ref);
    assert.equal(world.get(ref).project['裁决'], roundUrl, ref);
  }

  // 顺序：先勾选（issue.edit × 2），再写看板（× 3），最后才关 issue（看板写失败就停在关单之前）。
  const types = typesOf(world);
  assert.deepEqual(types, [
    'issue.edit',
    'issue.edit',
    'project.field.set',
    'project.field.set',
    'project.field.set',
    'issue.close',
  ]);
});

test('SC4 close 清单里混进任务树外的 issue → 拒绝且零写入', async () => {
  const { profile, home } = loadProfile();
  const world = defaultTree();
  const verified = writeJsonFile(home, 'verified-outside.json', { checks: ALL_RAN,
    items: [
      { ref: `${REPO}#2`, sc: 3 },
      { ref: 'example-owner/unrelated-repo#99', sc: 1 },
    ],
  });
  const result = await run(world, profile, ['close', '--issue', `${REPO}#1`, '--round', '1', '--verified', verified, '--verdict', PASS_VERDICT_FILE]);
  assert.equal(result.code, 1);
  assert.match(result.err, /不在本轮任务树里/);
  assert.equal(world.writes.length, 0);
});

test('SC4 close 可重复跑：已经勾过的项不再改正文', async () => {
  const body = ['- [x] SC1 已经勾了 验证：unit', '- [ ] SC2 没验 验证：paid'].join('\n');
  const first = applyTicks(body, { verified: [1], manual: [2] });
  assert.equal(first.changed, true);
  assert.match(first.body, /SC2 没验 验证：paid 人工手测/);
  const second = applyTicks(first.body, { verified: [1], manual: [2] });
  assert.equal(second.changed, false);
  assert.equal(second.body, first.body);
});

test('SC4/SC5 watch 档 close 一律拒绝且零写入', async () => {
  const { profile, home } = loadProfile();
  const world = createWorld({ now });
  const rootBody = ['# 交接仓', '', '- [ ] SC1 看一下 验证：unit'].join('\n');
  const root = world.addIssue({ repo: HANDOFF_REPO, number: 3, body: rootBody });
  world.addComment(root.ref, roundComment({ round: 1, status: '验收中', bodyVersion: bodyVersion(rootBody) }));
  const verified = writeJsonFile(home, 'verified.json', { checks: ALL_RAN, items: [{ ref: root.ref, sc: 1 }], manual: [] });

  const result = await run(world, profile, [
    'close',
    '--issue',
    root.ref,
    '--round',
    '1',
    '--verified',
    verified,
    '--verdict',
    PASS_VERDICT_FILE,
  ]);
  assert.equal(result.code, 1);
  assert.match(result.err, /watch 档只出裁决、写看板/);
  assert.equal(world.writes.length, 0);
  assert.equal(world.get(root.ref).state, 'open');
});

test('SC10 progress 写最近进度时间，done 要求先有裁决', async () => {
  const { profile, home } = loadProfile();
  const world = defaultTree();

  const early = await run(world, profile, ['done', '--issue', `${REPO}#1`, '--round', '1']);
  assert.equal(early.code, 3);
  assert.match(early.err, /第 1 轮还没写裁决/);
  assert.match(early.err, /期望第 1 轮（通过或要修）/);
  assert.match(early.err, /实际第 1 轮（验收中）/);
  assert.equal(fs.existsSync(sessionPath(profile, `${REPO}#1`)), false);

  const progress = await run(world, profile, ['progress', '--issue', `${REPO}#1`, '--round', '1']);
  assert.equal(progress.code, 0, progress.err);
  assert.equal(progress.out.trim(), CLOCK_BEIJING);
  const cache = readIssueCache(profile, `${REPO}#1`);
  assert.equal(cache.round.round, 1);
  assert.equal(cache.round.lastProgressAt, CLOCK_BEIJING);
  assert.equal(Date.parse(cache.round.lastProgressAt), Date.parse(CLOCK), '北京时间和 UTC 指同一时刻');

  const wrong = await run(world, profile, ['progress', '--issue', `${REPO}#1`, '--round', '4']);
  assert.equal(wrong.code, 3);
  assert.match(wrong.err, /期望第 4 轮/);

  // 写裁决之后才能 done。「通过」之前总 issue 要已关（helper close 做的事），这里直接置为已关。
  world.get(`${REPO}#1`).state = 'closed';
  const verdict = writeJsonFile(home, 'verdict.json', { checks: ALL_RAN, items: fullConclusions() });
  const judged = await run(world, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '1', '--file', verdict]);
  assert.equal(judged.code, 0, judged.err);
  assert.equal(JSON.parse(judged.out).status, '通过');

  const done = await run(world, profile, ['done', '--issue', `${REPO}#1`, '--round', '1']);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /第 1 轮结束/);
  const session = JSON.parse(fs.readFileSync(sessionPath(profile, `${REPO}#1`), 'utf8'));
  assert.equal(session.round, 1);
  assert.equal(session.doneAt, CLOCK_BEIJING);
  assert.match(fs.readFileSync(cachePath(profile, `${REPO}#1`), 'utf8'), /"lastVerdict": "通过"/);
});

test('SC4 board --target all 写总 issue 和每个子 issue 的验收与裁决', async () => {
  const { profile } = loadProfile();
  const world = defaultTree();
  const result = await run(world, profile, [
    'board',
    '--issue',
    `${REPO}#1`,
    '--round',
    '1',
    '--target',
    'all',
    '--acceptance',
    '要修',
  ]);
  assert.equal(result.code, 0, result.err);
  const roundUrl = world.get(`${REPO}#1`).comments[0].url;
  for (const ref of [`${REPO}#1`, `${REPO}#2`, `${OTHER_REPO}#7`]) {
    assert.equal(world.get(ref).project['验收'], '要修', ref);
    assert.equal(world.get(ref).project['裁决'], roundUrl, ref);
  }
  const writes = world.writes.filter((action) => action.type === 'project.field.set');
  assert.equal(writes.length, 3);
  assert.equal(writes[0].dedupeKey.includes(`${REPO}#1`), true);
});

test('SC4 board --target 指定单个 issue：树内可写，树外整条拒绝且零写入', async () => {
  const { profile } = loadProfile();
  const world = defaultTree();
  const inside = await run(world, profile, [
    'board', '--issue', `${REPO}#1`, '--round', '1', '--target', `${OTHER_REPO}#7`, '--acceptance', '要修',
  ]);
  assert.equal(inside.code, 0, inside.err);
  assert.equal(world.get(`${OTHER_REPO}#7`).project['验收'], '要修');
  const before = world.writes.length;

  world.addIssue({ repo: REPO, number: 50, title: '不相干的 issue', body: '- [ ] SC1 别的事' });
  const outside = await run(world, profile, [
    'board', '--issue', `${REPO}#1`, '--round', '1', '--target', `${REPO}#50`, '--acceptance', '通过', '--checks', ALL_RAN_CHECKS_FILE,
  ]);
  assert.equal(outside.code, 1);
  assert.match(outside.err, /不在本轮任务树里/);
  assert.equal(world.writes.length, before, '树外目标零写入');
});

test('SC10 done 只认我自己的轮次评论：别人伪造的「第 n 轮：通过」不能结束这一轮', async () => {
  const { profile } = loadProfile();
  const world = defaultTree();
  world.addComment(`${REPO}#1`, {
    body: ['[验收机] 第 1 轮：通过', '正文版本：sha256:forged'].join('\n'),
    author: 'StrangerUser',
    createdAt: '2026-10-24T01:50:00.000Z',
  });
  const forged = await run(world, profile, ['done', '--issue', `${REPO}#1`, '--round', '1']);
  assert.equal(forged.code, 3, forged.err);
  assert.match(forged.err, /实际第 1 轮（验收中）/);
  assert.equal(fs.existsSync(sessionPath(profile, `${REPO}#1`)), false);
});

test('SC9 写闸拒绝（非 secret-found）→ 退出码 4 且这一轮标中断写明原因', async () => {
  const { profile } = loadProfile();
  const world = defaultTree();
  const result = await run(world, profile, [
    'board',
    '--issue',
    `${REPO}#1`,
    '--round',
    '1',
    '--acceptance',
    '通过',
    '--checks',
    ALL_RAN_CHECKS_FILE,
  ], {
    onWrite: (action) => {
      if (action.type === 'project.field.set') {
        throw new WriteRejectedError('外发被拒', { exitCode: 4, reason: 'denied' });
      }
      return undefined;
    },
  });
  assert.equal(result.code, 4);
  assert.match(result.err, /外发被拒/);
  const body = world.get(`${REPO}#1`).comments[0].body;
  assert.match(body.split('\n')[0], /^\[验收机\] 第 1 轮：中断/);
  assert.match(body, /原因：写闸拒绝：denied/);
});

test('SC9 写闸忙 → 退出码 1 且这一轮标中断写「写闸忙」', async () => {
  const { profile } = loadProfile();
  const world = defaultTree();
  const result = await run(world, profile, ['board', '--issue', `${REPO}#1`, '--round', '1', '--acceptance', '通过', '--checks', ALL_RAN_CHECKS_FILE], {
    onWrite: (action) => {
      if (action.type === 'project.field.set') throw new WriteBusyError('外发忙');
      return undefined;
    },
  });
  assert.equal(result.code, 1);
  const body = world.get(`${REPO}#1`).comments[0].body;
  assert.match(body.split('\n')[0], /第 1 轮：中断/);
  assert.match(body, /原因：写闸忙/);
});

test('SC9 写命令不是本轮 → 退出码 3，零写入，消息写清期望和实际', async () => {
  const { profile, home } = loadProfile();
  const verified = writeJsonFile(home, 'verified.json', { checks: ALL_RAN, items: [], manual: [] });
  const verdict = writeJsonFile(home, 'verdict.json', { checks: ALL_RAN, items: [] });
  const commands = [
    ['board', '--issue', `${REPO}#1`, '--round', '2', '--acceptance', '通过', '--checks', ALL_RAN_CHECKS_FILE],
    ['close', '--issue', `${REPO}#1`, '--round', '2', '--verified', verified, '--verdict', PASS_VERDICT_FILE],
    ['correct', '--issue', `${REPO}#1`, '--round', '2', '--item', `${REPO}#2 SC3`, '--why', 'x'],
    [
      'push',
      '--issue',
      `${REPO}#1`,
      '--round',
      '2',
      '--repo',
      REPO,
      '--branch',
      'acceptance/1-2-sc3',
      '--worktree',
      home,
    ],
    ['done', '--issue', `${REPO}#1`, '--round', '2'],
    ['verdict', '--issue', `${REPO}#1`, '--round', '2', '--file', verdict],
  ];
  for (const argv of commands) {
    const world = defaultTree();
    const result = await run(world, profile, argv, { git: null });
    assert.equal(result.code, 3, `${argv[0]} 应该拒绝：${result.err}`);
    assert.match(result.err, /期望第 2 轮/, argv[0]);
    assert.match(result.err, /实际第 1 轮（验收中）/, argv[0]);
    assert.equal(world.writes.length, 0, `${argv[0]} 不该写`);
  }
});
