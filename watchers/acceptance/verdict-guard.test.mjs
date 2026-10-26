// 裁决防线：必需检查（build / typecheck / 测试）因环境原因没跑，就不能判「通过」。
// 只能是「环境问题 / 未验证」：这一轮标「中断」（原因以环境问题开头 → 按环境退避），helper 退出码 6，
// 不关单、不勾选、不写看板「通过」、不写通过裁决；宿主看到后写 env-unverified 提醒。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { runHelper } from './bin/helper.mjs';
import { parseRounds } from './bin/rounds.mjs';
import { ENV_PROBLEM_PREFIX, shouldTrigger } from './bin/trigger.mjs';
import { evidenceEnvHints, envUnverifiedReason, parseChecks } from './bin/checks.mjs';
import { alertBlocks } from './host/slack-blocks.mjs';
import { INTERRUPTION_ALERT_KINDS } from './host/slack-notify.mjs';
import { tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import {
  ALL_RAN,
  CLOCK,
  OWNER,
  OTHER_REPO,
  REPO,
  createFakeGithub,
  defaultTree,
  fullConclusions,
  writeJsonFile,
} from './session.fixture.mjs';

const ROOT_REF = `${REPO}#1`;

function setup() {
  const { home } = writeProfile(tmpDir());
  return { profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), home };
}

async function helper(world, profile, argv) {
  let out = '';
  let err = '';
  const code = await runHelper(argv, {
    github: createFakeGithub(world),
    profile,
    now: () => Date.parse(CLOCK),
    stdout: { write: (c) => (out += c) },
    stderr: { write: (c) => (err += c) },
  });
  return { code, out, err };
}

const rootComment = (world) => world.get(ROOT_REF).comments[0];
const nonCommentWrites = (world) => world.writes.filter((w) => w.type !== 'comment.update');

function assertEnvInterrupted(world, result) {
  assert.equal(result.code, 6, result.err);
  const body = rootComment(world).body;
  assert.match(body.split('\n')[0], /第 1 轮：中断/);
  assert.ok(body.includes(`原因：${ENV_PROBLEM_PREFIX}`), body);
  assert.match(body, /未验证，不判「通过」/);
  assert.deepEqual(nonCommentWrites(world), [], '不关单、不勾选、不写看板');
  assert.equal(world.get(ROOT_REF).state, 'open');
}

test('parseChecks：三项都得写、只认 ran / not-applicable / env-skipped，也认 {status, note}', () => {
  assert.deepEqual(parseChecks(ALL_RAN), { build: 'ran', typecheck: 'ran', test: 'ran' });
  assert.deepEqual(
    parseChecks({ build: 'not-applicable', typecheck: { status: 'ran' }, test: { status: 'env-skipped', note: '依赖装不上' } }),
    { build: 'not-applicable', typecheck: 'ran', test: 'env-skipped' },
  );
  assert.throws(() => parseChecks(undefined, 'X'), /X 缺少 checks/);
  assert.throws(() => parseChecks({ build: 'ran', typecheck: 'ran' }), /test=（没写）/);
  assert.throws(() => parseChecks({ build: 'ran', typecheck: 'skipped', test: 'ran' }), /typecheck=skipped/);
});

test('evidenceEnvHints：只看「通过」条目，证据里同时有「没跑」和环境原因才算', () => {
  const items = [
    { ref: `${REPO}#2`, sc: 3, result: '通过', evidence: 'vitest 没跑：依赖装不上（npm 连不上 registry）' },
    { ref: `${REPO}#2`, sc: 4, result: '通过', evidence: 'Tests 1091 passed | 4 skipped，tsc 0 错' },
    { ref: `${REPO}#2`, sc: 5, result: '通过', evidence: '本条不涉及 UI，e2e 没跑' },
    { ref: `${REPO}#2`, sc: 6, result: '要修', evidence: '沙箱里 node_modules 没装，测试没跑' },
    { ref: `${REPO}#2`, sc: 7, result: '通过', evidence: 'typecheck could not run: sandbox offline' },
  ];
  assert.deepEqual(evidenceEnvHints(items), [`${REPO}#2 SC3`, `${REPO}#2 SC7`]);
  const reason = envUnverifiedReason({ skipped: ['test'], hints: [`${REPO}#2 SC3`] });
  assert.ok(reason.startsWith(ENV_PROBLEM_PREFIX), reason);
  assert.match(reason, /必需检查因环境原因没跑：测试/);
});

test('verdict 判通过但 checks 里有 env-skipped → 退出码 6、这一轮标中断（环境问题）、不写通过', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  world.get(ROOT_REF).state = 'closed';
  const file = writeJsonFile(home, 'verdict.json', {
    checks: { build: 'ran', typecheck: 'env-skipped', test: 'env-skipped' },
    items: fullConclusions(),
  });
  const result = await helper(world, profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', file]);
  assert.equal(result.code, 6, result.err);
  const body = rootComment(world).body;
  assert.match(body.split('\n')[0], /第 1 轮：中断/);
  assert.match(body, /必需检查因环境原因没跑：typecheck、测试/);
  assert.equal(body.includes('第 1 轮：通过'), false);
  assert.match(result.err, /停手/);
});

test('verdict：checks 都写 ran，但「通过」证据写着因环境没跑 → 同样退出码 6、标中断', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  world.get(ROOT_REF).state = 'closed';
  const items = fullConclusions().map((item, i) =>
    i === 0 ? { ...item, evidence: 'build/typecheck/vitest 都没跑（依赖没装上）' } : item,
  );
  const file = writeJsonFile(home, 'verdict.json', { checks: ALL_RAN, items });
  const result = await helper(world, profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', file]);
  assert.equal(result.code, 6, result.err);
  assert.match(rootComment(world).body, /「通过」条目的证据写着因环境没跑/);
});

test('verdict：判通过却没写 checks → 退出码 1、零写入；判要修不需要 checks', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  world.get(ROOT_REF).state = 'closed';
  const noChecks = writeJsonFile(home, 'no-checks.json', { items: fullConclusions() });
  const refused = await helper(world, profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', noChecks]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /缺少 checks/);
  assert.equal(world.writes.length, 0);
  assert.match(rootComment(world).body, /第 1 轮：验收中/);

  const fixWorld = defaultTree();
  const fix = writeJsonFile(home, 'fix.json', {
    items: fullConclusions({ [`${REPO}#2 SC4`]: { result: '要修', why: '缺测试' } }),
  });
  const ok = await helper(fixWorld, profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', fix]);
  assert.equal(ok.code, 0, ok.err);
  assert.match(rootComment(fixWorld).body.split('\n')[0], /第 1 轮：要修/);
});

test('close：verified.json 里有 env-skipped → 先标中断、退出码 6，不勾选、不写看板、不关单', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  const verified = writeJsonFile(home, 'verified.json', {
    checks: { build: 'not-applicable', typecheck: 'ran', test: 'env-skipped' },
    items: [{ ref: `${REPO}#2`, sc: 3 }, { ref: `${OTHER_REPO}#7`, sc: 7 }],
    manual: [],
  });
  const before = world.get(`${REPO}#2`).body;
  const result = await helper(world, profile, ['close', '--issue', ROOT_REF, '--round', '1', '--verified', verified]);
  assertEnvInterrupted(world, result);
  assert.equal(world.get(`${REPO}#2`).body, before);
});

test('close：verified.json 没写 checks → 退出码 1、零写入', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  const verified = writeJsonFile(home, 'verified.json', { items: [{ ref: `${REPO}#2`, sc: 3 }], manual: [] });
  const result = await helper(world, profile, ['close', '--issue', ROOT_REF, '--round', '1', '--verified', verified]);
  assert.equal(result.code, 1);
  assert.match(result.err, /close 的 verified\.json 缺少 checks/);
  assert.equal(world.writes.length, 0);
});

test('board --acceptance 通过：必须带 --checks；有 env-skipped → 退出码 6；要修不需要', async () => {
  const { profile, home } = setup();
  const missing = defaultTree();
  const noFlag = await helper(missing, profile, ['board', '--issue', ROOT_REF, '--round', '1', '--acceptance', '通过']);
  assert.equal(noFlag.code, 1);
  assert.match(noFlag.err, /缺少 checks/);
  assert.equal(missing.writes.length, 0);

  const world = defaultTree();
  const checks = writeJsonFile(home, 'checks.json', { checks: { build: 'env-skipped', typecheck: 'ran', test: 'ran' } });
  const result = await helper(world, profile, [
    'board', '--issue', ROOT_REF, '--round', '1', '--acceptance', '通过', '--checks', checks,
  ]);
  assertEnvInterrupted(world, result);

  const fixWorld = defaultTree();
  const fix = await helper(fixWorld, profile, ['board', '--issue', ROOT_REF, '--round', '1', '--acceptance', '要修']);
  assert.equal(fix.code, 0, fix.err);
});

test('环境未验证的中断：trigger 按环境退避重试（不是 up-to-date，也不当代码不通过）', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  const verified = writeJsonFile(home, 'verified.json', {
    checks: { build: 'ran', typecheck: 'ran', test: 'env-skipped' },
    items: [{ ref: `${REPO}#2`, sc: 3 }],
    manual: [],
  });
  await helper(world, profile, ['close', '--issue', ROOT_REF, '--round', '1', '--verified', verified]);
  const rounds = parseRounds(world.get(ROOT_REF).comments, OWNER);
  assert.equal(rounds.at(-1).status, '中断');
  assert.ok(rounds.at(-1).reason.startsWith(ENV_PROBLEM_PREFIX));
  const issue = { ref: ROOT_REF, kind: 'standalone', tier: 'auto', closedAt: null, bodyVersion: rounds.at(-1).bodyVersion, rounds, children: [], linkedPrs: [{ number: 12, mergedAt: '2026-10-20T00:00:00.000Z' }] };
  const soon = shouldTrigger(issue, { now: () => Date.parse(CLOCK) + 60_000, profile });
  assert.deepEqual([soon.trigger, soon.reason], [false, 'backoff'], JSON.stringify(soon));
  const later = shouldTrigger(issue, { now: () => Date.parse(CLOCK) + 31 * 60_000, profile });
  assert.equal(later.trigger, true, JSON.stringify(later));
});

test('Slack：env-unverified 是中断类提醒，四段式里写清「这一轮没验证、不是代码不通过」', () => {
  assert.ok(INTERRUPTION_ALERT_KINDS.includes('env-unverified'));
  const payload = alertBlocks(
    {
      source: 'alerts',
      type: 'env-unverified',
      event: {
        kind: 'env-unverified',
        issue: ROOT_REF,
        round: 1,
        reason: `${ENV_PROBLEM_PREFIX}必需检查因环境原因没跑：测试。这一轮未验证，不判「通过」`,
      },
    },
    {},
  );
  const text = JSON.stringify(payload);
  for (const heading of ['发生了什么', '影响', '已自动处理', '要不要人处理']) assert.ok(text.includes(heading), heading);
  assert.match(text, /未验证/);
  assert.match(text, /不是代码不通过|不会被判不通过/);
  assert.equal(text.includes('env-unverified'), false, '不出现 kind 代码名');
});
