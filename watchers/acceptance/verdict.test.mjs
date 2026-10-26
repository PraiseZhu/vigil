import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion, lockPath, parseRounds } from './bin/rounds.mjs';
import { shouldTrigger } from './bin/trigger.mjs';
import { redact, REDACTED } from './bin/redact.mjs';
import { runHelper } from './bin/helper.mjs';
import { tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import {
  CLOCK,
  CLOCK_BEIJING,
  OWNER,
  OTHER_REPO,
  REPO,
  createFakeGithub,
  defaultTree,
  fullConclusions,
  writeJsonFile,
  ALL_RAN,
  ALL_RAN_CHECKS_FILE,
} from './session.fixture.mjs';

function loadProfile(extra = {}) {
  const { home, stateDir } = writeProfile(tmpDir(), extra);
  return { profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), home, stateDir };
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
    github: createFakeGithub(world, extra),
    profile,
    now,
    stdout: out,
    stderr: err,
  });
  return { code, out: out.text, err: err.text };
}

function verdictFile(home, data) {
  return writeJsonFile(home, 'verdict.json', { checks: ALL_RAN, ...data });
}

function writesOf(world, type) {
  return world.writes.filter((action) => action.type === type);
}

test('SC3 verdict 就地改轮次评论：逐条结果、正文版本、放锁、只写一次', async () => {
  const { profile, home } = loadProfile();
  const world = defaultTree();
  world.addComment(`${REPO}#1`, {
    body: [`- 有争议：${REPO}#2 SC9 · 验收方：x · 修正方：y`].join('\n'),
  });
  const lock = lockPath(profile, `${REPO}#1`);
  fs.mkdirSync(`${profile.stateDir}/locks`, { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ round: 1 }));

  const file = verdictFile(home, {
    extracted: false,
    items: fullConclusions({
      [`${REPO}#2 SC3`]: { evidence: 'node --test 全绿' },
      [`${REPO}#2 SC4`]: { result: '要修', why: '看板没写', evidence: '假 gh 记录' },
      [`${REPO}#2 SC5`]: { result: '人工手测', layer: 'cindy-mac', evidence: undefined },
    }),
  });
  const result = await run(world, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '1', '--file', file]);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(JSON.parse(result.out), {
    status: '要修',
    url: world.get(`${REPO}#1`).comments[0].url,
  });

  const writes = world.writes.filter((action) => action.type !== 'project.field.set');
  assert.equal(writes.length, 1, '裁决只写一次');
  const write = writes[0];
  assert.equal(write.type, 'comment.update');
  assert.equal(write.commentId, 1001);
  assert.equal(write.dedupeKey, `verdict:${REPO}#1:1:1001:要修`);

  const lines = write.body.split('\n');
  assert.equal(lines[0], '[验收机] 第 1 轮：要修');
  assert.equal(lines[1], `正文版本：${bodyVersion(world.get(`${REPO}#1`).body)}`);
  assert.match(lines[2], /^开始：2026-10-24T01:00:00\.000Z$/);
  // 完成时间写北京时间（#43 决策），带 +08:00，Date.parse 照样认。
  assert.equal(lines[3], `完成：${CLOCK_BEIJING}`);
  assert.equal(Date.parse(lines[3].slice('完成：'.length)), Date.parse(CLOCK));
  assert.ok(write.body.includes(`- 通过：${REPO}#2 SC3 · 证据：node --test 全绿`));
  assert.ok(write.body.includes(`- 要修：${REPO}#2 SC4 · 原因：看板没写 · 证据：假 gh 记录`));
  assert.ok(write.body.includes(`- 人工手测：${REPO}#2 SC5（cindy-mac）`));
  assert.ok(!write.body.includes('有争议'), '文件里没写有争议就别自己加');

  assert.equal(fs.existsSync(lock), false, '裁决后必须放锁');
});

test('SC3 逐条结果里有「要修」或「有争议」→ 要修；人工手测不拦通过', async () => {
  const { profile, home } = loadProfile();
  const world = defaultTree();

  const disputed = verdictFile(home, {
    items: fullConclusions({
      [`${REPO}#2 SC4`]: { result: '有争议', sides: { acceptance: '没证据', correction: '测过了' } },
    }),
  });
  const first = await run(world, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '1', '--file', disputed]);
  assert.equal(first.code, 0, first.err);
  const body = writesOf(world, 'comment.update')[0].body;
  assert.match(body.split('\n')[0], /第 1 轮：要修/);
  assert.ok(body.includes(`- 有争议：${REPO}#2 SC4 · 验收方：没证据 · 修正方：测过了`));

  // 换一轮，全部通过（人工手测不拦）。
  const world2 = defaultTree({ roundNumber: 2, roundStatus: '验收中' });
  const passFile = verdictFile(home, {
    items: fullConclusions({ [`${REPO}#2 SC5`]: { result: '人工手测', layer: 'paid' } }),
  });
  world2.get(`${REPO}#1`).state = 'closed';
  const second = await run(world2, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '2', '--file', passFile]);
  assert.equal(second.code, 0, second.err);
  assert.equal(JSON.parse(second.out).status, '通过');
});

test('SC3 --status 与逐条结果不一致 → 退出码 1，不写', async () => {
  const { profile, home } = loadProfile();
  const world = defaultTree();
  const file = verdictFile(home, { items: fullConclusions({ [`${REPO}#2 SC3`]: { result: '要修', why: 'x' } }) });
  const result = await run(world, profile, [
    'verdict',
    '--issue',
    `${REPO}#1`,
    '--round',
    '1',
    '--file',
    file,
    '--status',
    '通过',
  ]);
  assert.equal(result.code, 1);
  assert.match(result.err, /--status 与逐条结果不一致/);
  assert.equal(world.writes.length, 0);
});

test('SC9 不是本轮 → 退出码 3，消息写清期望和实际，零写入', async () => {
  const { profile, home } = loadProfile();
  const world = defaultTree();
  const file = verdictFile(home, { items: [{ ref: `${REPO}#2`, sc: 3, result: '通过', evidence: 'x' }] });
  const result = await run(world, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '2', '--file', file]);
  assert.equal(result.code, 3);
  assert.match(result.err, /期望第 2 轮/);
  assert.match(result.err, /实际第 1 轮（验收中）/);
  assert.equal(world.writes.length, 0);
});

test('SC3 关闭勾选后按改后的正文记版本，trigger 不会因此重验', async () => {
  const { profile, home } = loadProfile();
  const rootBody = ['# 独立任务', '', '- [ ] SC1 跑一遍测试 验证：unit（测试点：真跑）'].join('\n');
  const world = defaultTree({ rootBody, childBody: '', otherBody: '', rootRepo: REPO });
  // 独立任务：没有子 issue。
  const root = world.get(`${REPO}#1`);
  root.subIssues = [];
  root.prs = [{ number: 12, url: `https://github.com/${REPO}/pull/12`, mergedAt: '2026-10-20T00:00:00.000Z' }];
  const before = bodyVersion(root.body);

  const verified = writeJsonFile(home, 'verified.json', { checks: ALL_RAN,
    items: [{ ref: `${REPO}#1`, sc: 1 }],
    manual: [{ ref: `${REPO}#1`, sc: 1 }],
  });
  const closed = await run(world, profile, ['close', '--issue', `${REPO}#1`, '--round', '1', '--verified', verified]);
  assert.equal(closed.code, 0, closed.err);
  const edited = root.body;
  assert.ok(edited.includes('- [x] SC1 跑一遍测试'), edited);
  assert.ok(edited.includes('人工手测'), edited);

  const file = verdictFile(home, { items: [{ ref: `${REPO}#1`, sc: 1, result: '通过', evidence: '真跑过' }] });
  const result = await run(world, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '1', '--file', file]);
  assert.equal(result.code, 0, result.err);
  const body = writesOf(world, 'comment.update').at(-1).body;
  const versionLine = body.split('\n').find((line) => line.startsWith('正文版本：'));
  assert.equal(versionLine, `正文版本：${bodyVersion(edited)}`);
  assert.notEqual(versionLine, `正文版本：${before}`);

  const rounds = parseRounds(root.comments, OWNER);
  const decision = shouldTrigger(
    {
      ref: `${REPO}#1`,
      kind: 'standalone',
      tier: 'auto',
      closedAt: root.closedAt,
      bodyVersion: bodyVersion(edited),
      rounds,
      children: [],
      linkedPrs: root.prs,
    },
    { now: () => Date.parse('2026-10-25T00:00:00.000Z'), profile },
  );
  assert.equal(decision.trigger, false, JSON.stringify(decision));
  assert.equal(decision.reason, 'up-to-date');
});

test('SC11 裁决正文脱敏：不写状态目录、令牌、运行 id；首行是 [验收机]', async () => {
  const { profile, home } = loadProfile();
  // 子 issue 没有验收项：任务树里只有总 issue 的 SC1 / SC2 要结论，裁决里不会提到跨仓子 issue。
  const world = defaultTree({ childBody: '', otherBody: '' });
  const fakeHome = ['', 'home', 'someone', 'project'].join('/');
  const token = `ghp_${'x'.repeat(36)}`;
  const file = verdictFile(home, {
    items: [
      {
        ref: `${REPO}#1`,
        sc: 1,
        result: '通过',
        evidence: `在 ${profile.stateDir}/worktrees 下跑过 ${token} ${fakeHome} run-id: 12345`,
      },
      { ref: `${REPO}#1`, sc: 2, result: '通过', evidence: 'ok' },
    ],
  });
  world.get(`${REPO}#1`).state = 'closed';
  const result = await run(world, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '1', '--file', file]);
  assert.equal(result.code, 0, result.err);
  const body = writesOf(world, 'comment.update')[0].body;
  assert.match(body.split('\n')[0], /^\[验收机\] 第 1 轮：通过/);
  assert.equal(body.includes(profile.stateDir), false);
  assert.equal(body.includes(token), false);
  assert.equal(body.includes('12345'), false);
  assert.equal(body.includes(fakeHome), false);
  assert.equal(body.includes(OTHER_REPO), false, '没提到就别写');
});

test('SC11 redact 单元：绝对路径、令牌、私钥、Bearer、运行 id 都抹掉', () => {
  const { profile } = loadProfile();
  const fakeHome = ['', 'home', 'someone', 'proj'].join('/');
  const fakeUsers = ['', 'Users', 'someone', 'proj'].join('/');
  const token = `ghp_${'y'.repeat(36)}`;
  const pat = `github_pat_${'z'.repeat(22)}`;
  const slack = `xoxb-${'1'.repeat(12)}`;
  const aws = ['AKIA', 'A'.repeat(16)].join('');
  const openai = `sk-${'q'.repeat(32)}`;
  const key = ['-----BEGIN OPENSSH ' + 'PRIVATE KEY-----', 'body', '-----END OPENSSH ' + 'PRIVATE KEY-----'].join('\n');

  const text = [
    `状态目录 ${profile.stateDir} 检出目录 ${profile.worktreeDir}`,
    `家目录 ${fakeHome} 和 ${fakeUsers}`,
    `临时 /tmp/acceptance-x 和 /var/tmp/y 和 /root/z`,
    `windows C:\\Users\\someone\\x`,
    `令牌 ${token} ${pat} ${slack} ${aws} ${openai}`,
    `头 Authorization: Bearer abcdefghijkl`,
    'run-id: 12345-67890',
    key,
    '保留这句',
  ].join('\n');

  const out = redact(text, profile);
  for (const secret of [profile.stateDir, profile.worktreeDir, fakeHome, fakeUsers, token, pat, slack, aws, openai, 'abcdefghijkl', '12345-67890']) {
    assert.equal(out.includes(secret), false, `没抹掉：${secret}`);
  }
  assert.equal(out.includes('/tmp/acceptance-x'), false);
  assert.equal(out.includes('/var/tmp/y'), false);
  assert.equal(out.includes('/root/z'), false);
  assert.equal(out.includes('C:\\Users'), false);
  assert.equal(out.includes('PRIVATE KEY'), false);
  assert.ok(out.includes('保留这句'));
  assert.ok(out.includes(REDACTED));
  assert.equal(redact('', profile), '');
  assert.equal(redact(null, profile), '');
});

test('「通过」之前总 issue 必须已关：还开着 → 退出码 1、不写裁决（免得留下通过但没关、以后也不再验）', async () => {
  const { profile, home } = loadProfile();
  const world = defaultTree();
  const file = verdictFile(home, { items: fullConclusions() });
  const open = await run(world, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '1', '--file', file]);
  assert.equal(open.code, 1);
  assert.match(open.err, /判「通过」之前要先 close/);
  assert.equal(writesOf(world, 'comment.update').length, 0);

  // 「要修」不受影响：总 issue 本来就不关。
  const fix = verdictFile(home, { items: fullConclusions({ [`${REPO}#2 SC4`]: { result: '要修', why: '缺测试' } }) });
  const needsFix = await run(world, profile, ['verdict', '--issue', `${REPO}#1`, '--round', '1', '--file', fix]);
  assert.equal(needsFix.code, 0, needsFix.err);
  assert.match(writesOf(world, 'comment.update')[0].body.split('\n')[0], /第 1 轮：要修/);
});
