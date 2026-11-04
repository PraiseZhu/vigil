// 身份白名单（#271 之后）：轮次评论 / issue 只认「本人 ownerLogin + profile.trustedBotLogins 里的 App bot」。
// 这个文件只测判断本身和三处最硬的接线（rounds 轮次解析、collect 任务树、write-gate 轮次评论绑定）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { isBotLogin, isTrustedAuthor } from './bin/trusted-author.mjs';
import { latestRound, parseRounds } from './bin/rounds.mjs';
import { collectTree } from './bin/collect.mjs';
import { createGate } from './host/write-gate.mjs';
import { hostPaths } from './host/paths.mjs';
import { run as procRun } from './host/proc.mjs';
import { createFakeGithub, createWorld, defaultTree } from './session.fixture.mjs';
import { OWNER, REPO, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

// 夹具里的 App bot 登录名用占位符：公开仓不写真实 App 名之外的任何编号。
const BOT = 'example-automation[bot]';
const OTHER_BOT = 'dependabot[bot]';
const STRANGER = 'StrangerUser';
const ROOT_REF = `${REPO}#1`;
const BOT_PROFILE = { ownerLogin: OWNER, trustedBotLogins: [BOT] };

function profileWith(logins) {
  return { ownerLogin: OWNER, trustedBotLogins: logins };
}

function loadHome(extra = {}) {
  const { home } = writeProfile(tmpDir(), { profile: extra });
  return { home, profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }) };
}

function authorOf(login, type) {
  return type ? { login, __typename: type } : { login };
}

test('SC1 本人和配置的 App bot 都可信；trustedBotLogins 缺省 / 空数组时与「只认 ownerLogin」一致', () => {
  assert.equal(isTrustedAuthor(OWNER, { ownerLogin: OWNER }), true);
  assert.equal(isTrustedAuthor(BOT, { ownerLogin: OWNER }), false);
  assert.equal(isTrustedAuthor(BOT, profileWith([])), false);
  assert.equal(isTrustedAuthor(BOT, BOT_PROFILE), true);
  assert.equal(isTrustedAuthor(OWNER, BOT_PROFILE), true);
  // 老签名：第二个参数直接给 ownerLogin 字符串
  assert.equal(isTrustedAuthor(OWNER, OWNER), true);
  assert.equal(isTrustedAuthor(BOT, OWNER), false);
});

test('SC2 冒充一律拒绝：前缀 / 后缀 / 中间插字符 / Unicode 近形 / 全角括号 / 多套一层 [bot]', () => {
  for (const fake of [
    `${BOT}x`,
    `x${BOT}`,
    'example-automationx[bot]',
    'example-automation-[bot]',
    `${BOT}[bot]`,
    'exаmple-automation[bot]', // Cyrillic 'а'（U+0430）不是 ASCII a
    'example-automation［bot］', // 全角方括号
    'example-automation[ bot ]',
    'example-automation',
    '[bot]',
  ]) {
    assert.equal(isTrustedAuthor(fake, BOT_PROFILE), false, fake);
  }
  // 名单外的 bot 也不放行
  assert.equal(isTrustedAuthor(OTHER_BOT, BOT_PROFILE), false);
  assert.equal(isTrustedAuthor('github-actions[bot]', BOT_PROFILE), false);
  // 空 / 非字符串 / 对象里没有 login 一律拒绝
  for (const bad of ['', '   ', null, undefined, 42, {}, { login: null }, { login: 42 }]) {
    assert.equal(isTrustedAuthor(bad, BOT_PROFILE), false, JSON.stringify(bad));
  }
});

test('SC3 大小写不敏感、首尾空白先 trim，中间空白不放过', () => {
  assert.equal(isTrustedAuthor(`  ${OWNER}  `, BOT_PROFILE), true);
  assert.equal(isTrustedAuthor('EXAMPL E-AUTOMATION[bot]'.replace(' ', ''), BOT_PROFILE), true);
  assert.equal(isTrustedAuthor(` ${BOT}\n`, BOT_PROFILE), true);
  assert.equal(isTrustedAuthor(BOT.toUpperCase(), BOT_PROFILE), true);
  assert.equal(isTrustedAuthor('EXAMPLEAUTOMATION[bot]', BOT_PROFILE), false);
  assert.equal(isTrustedAuthor(' example-automation [bot] ', BOT_PROFILE), false);
});

test('SC4 类型可得时 bot 项必须是 Bot；类型拿不到的老数据只按 login 命中放行', () => {
  assert.equal(isTrustedAuthor(authorOf(BOT, 'Bot'), BOT_PROFILE), true);
  assert.equal(isTrustedAuthor(authorOf(BOT, 'User'), BOT_PROFILE), false);
  assert.equal(isTrustedAuthor(authorOf(BOT, 'Organization'), BOT_PROFILE), false);
  assert.equal(isTrustedAuthor(authorOf(BOT), BOT_PROFILE), true);
  // 本人是账号（User），带 Bot 类型反而不放行
  assert.equal(isTrustedAuthor(authorOf(OWNER, 'User'), BOT_PROFILE), true);
  assert.equal(isTrustedAuthor(authorOf(OWNER, 'Bot'), BOT_PROFILE), false);
  // 显式多传一个第三参数：已被忽略，类型只认作者自带的 __typename（见 SC9）
  assert.equal(isTrustedAuthor(authorOf(BOT, 'Bot'), BOT_PROFILE, { type: 'User' }), true);
  assert.equal(isTrustedAuthor(authorOf(BOT, 'User'), BOT_PROFILE, { type: 'Bot' }), false);
  // 冒充者带 Bot 类型也不放行
  assert.equal(isTrustedAuthor(authorOf(`${BOT}x`, 'Bot'), BOT_PROFILE), false);
});

test('SC5 手工拼的名单：不带 [bot] 的条目不生效，isBotLogin 只认 <名字>[bot]', () => {
  const handmade = { ownerLogin: OWNER, trustedBotLogins: ['StrangerUser', 'Stranger[bot]x', BOT] };
  assert.equal(isTrustedAuthor('StrangerUser', handmade), false);
  assert.equal(isTrustedAuthor('Stranger[bot]x', handmade), false);
  assert.equal(isTrustedAuthor(BOT, handmade), true);
  assert.equal(isBotLogin(BOT), true);
  assert.equal(isBotLogin(`  ${BOT} `), true);
  for (const bad of ['StrangerUser', 'Stranger[bot]x', '[bot]', '', null, 42]) {
    assert.equal(isBotLogin(bad), false, JSON.stringify(bad));
  }
});

test('SC9 第三参数不再能覆盖作者自带的类型：传 {type} 洗不白 User，也贬不了真 bot', () => {
  // 生产代码全是两参调用；这里故意多传第三参数，证明它被忽略。
  // 作者自带 User（登录名撞上名单项），第三参数传 Bot 也不能变成可信。
  assert.equal(isTrustedAuthor(authorOf(BOT, 'User'), BOT_PROFILE, { type: 'Bot' }), false);
  assert.equal(isTrustedAuthor(authorOf(STRANGER, 'User'), BOT_PROFILE, { type: 'Bot' }), false);
  // 反过来，第三参数传 User 也不影响作者自带 Bot 的判定。
  assert.equal(isTrustedAuthor(authorOf(BOT, 'Bot'), BOT_PROFILE, { type: 'User' }), true);
  // 作者对象没有类型时，第三参数同样不会被当成类型来源：只按 login 命中。
  assert.equal(isTrustedAuthor(authorOf(BOT), BOT_PROFILE, { type: 'User' }), true);
});

test('SC6 profile 校验：非数组 / 不带 [bot] / 空串 / 重复 / 非字符串都报错并点名键', () => {
  const invalid = [
    'example-automation[bot]',
    ['ExampleUser'],
    [' StrangerUser '],
    [''],
    [123],
    ['example-automation[bots]'],
    ['example-automation'],
    ['Example-Automation[bot]', 'example-automation[bot]'],
  ];
  for (const value of invalid) {
    const { home } = writeProfile(tmpDir(), { profile: { trustedBotLogins: value } });
    assert.throws(
      () => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }),
      (error) => {
        assert.equal(error.code, 'PROFILE_INVALID', JSON.stringify(value));
        assert.match(error.message, /trustedBotLogins/);
        return true;
      },
      JSON.stringify(value),
    );
  }
});

test('SC6 profile：没配 trustedBotLogins 是空数组，配了原样带出（去重按大小写不敏感）', () => {
  const { profile: plain } = loadHome();
  assert.deepEqual([...plain.trustedBotLogins], []);
  assert.equal(Object.isFrozen(plain.trustedBotLogins), true);

  const { profile } = loadHome({ trustedBotLogins: [BOT, 'Second-App[bot]'] });
  assert.deepEqual([...profile.trustedBotLogins], [BOT, 'Second-App[bot]']);
  assert.equal(Object.isFrozen(profile.trustedBotLogins), true);
  // 和 #271 的 apps 解析互不影响
  assert.deepEqual([...profile.appOwners], [OWNER]);
});

test('SC7 轮次解析：配置的 App bot 发的轮次评论算本轮，冒充的、名单外的都不算', () => {
  const bot = roundComment({ round: 2, status: '验收中', author: BOT, databaseId: 9001 });
  const fake = roundComment({ round: 3, status: '验收中', author: `${BOT}x`, databaseId: 9002 });
  const other = roundComment({ round: 4, status: '验收中', author: OTHER_BOT, databaseId: 9003 });
  const own = roundComment({ round: 1, status: '要修', author: OWNER, databaseId: 9004 });

  const rounds = parseRounds([own, bot, fake, other], loadHome({ trustedBotLogins: [BOT] }).profile);
  assert.deepEqual(rounds.map((entry) => `${entry.round}:${entry.commentId}`), ['1:9004', '2:9001']);
  assert.equal(latestRound(rounds).commentId, 9001);

  // 缺省 / 空名单：bot 评论和现在一样不算（行为不变）
  for (const profile of [OWNER, { ownerLogin: OWNER }, profileWith([])]) {
    assert.deepEqual(parseRounds([own, bot, fake], profile).map((entry) => entry.round), [1]);
  }
  assert.throws(() => parseRounds([own], {}), /ownerLogin/);
});

test('SC7 任务树收集：配置的 App bot 建的子 issue 收进树，冒充作者的不算（缺省时行为不变）', async () => {
  const world = createWorld();
  const body = '- [ ] SC1 子任务 验证：unit';
  const root = world.addIssue({ repo: REPO, number: 1, title: '总任务', body: '- [ ] SC1 总任务 验证：unit' });
  world.addIssue({ repo: REPO, number: 2, title: 'bot 子任务', body, author: BOT });
  world.addIssue({ repo: REPO, number: 3, title: '冒充子任务', body, author: `${BOT}x` });
  world.addChild(root.ref, `${REPO}#2`);
  world.addChild(root.ref, `${REPO}#3`);
  const github = createFakeGithub(world);
  const profile = { ...loadHome({ trustedBotLogins: [BOT] }).profile };

  const tree = await collectTree({ github, profile, ref: ROOT_REF });
  assert.deepEqual(tree.issues.map((entry) => entry.ref), [ROOT_REF, `${REPO}#2`]);
  assert.equal(tree.root.kind, 'parent');

  const plain = await collectTree({ github, profile: { ...profile, trustedBotLogins: Object.freeze([]) }, ref: ROOT_REF });
  assert.deepEqual(plain.issues.map((entry) => entry.ref), [ROOT_REF]);
  assert.equal(plain.root.kind, 'standalone');
});

function setupGate(extra = {}) {
  const { home, profile } = loadHome(extra);
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.enabledFile, '1');
  return { home, profile };
}

async function gateWith(home, profile, world, commentId) {
  return createGate({
    home,
    profile,
    github: createFakeGithub(world),
    run: procRun,
    binding: { root: ROOT_REF, round: 1, commentId },
    which: async () => false,
  });
}

test('SC8 写闸轮次绑定：bot 发的本轮评论让写入放行，冒充的 / 缺省名单一律 not-current-round', async () => {
  const botWorld = defaultTree();
  const botComment = botWorld.get(ROOT_REF).comments[0];
  botComment.author = { login: BOT };
  const bot = setupGate({ trustedBotLogins: [BOT] });
  const allowed = await (await gateWith(bot.home, bot.profile, botWorld, botComment.databaseId)).handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    body: '本轮验收进度',
    dedupeKey: 'bot-round-ok',
  });
  assert.equal(allowed.code, 0, JSON.stringify(allowed));
  assert.equal(botWorld.writes.length, 1);

  // 冒充者（同一个名字加后缀）不算本轮：绑定轮次找不到 → not-current-round
  const fakeWorld = defaultTree();
  const fakeComment = fakeWorld.get(ROOT_REF).comments[0];
  fakeComment.author = { login: `${BOT}x` };
  const fake = await (await gateWith(bot.home, bot.profile, fakeWorld, fakeComment.databaseId)).handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    body: '本轮验收进度',
    dedupeKey: 'fake-bot-round',
  });
  assert.equal(fake.code, 4, JSON.stringify(fake));
  assert.equal(fake.body.reason, 'not-current-round');
  assert.equal(fakeWorld.writes.length, 0);

  // 没配名单（行为与改动前一致）：同一条 bot 评论也不算本轮
  const plain = setupGate();
  const oldWorld = defaultTree();
  const oldComment = oldWorld.get(ROOT_REF).comments[0];
  oldComment.author = { login: BOT };
  const unchanged = await (await gateWith(plain.home, plain.profile, oldWorld, oldComment.databaseId)).handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    body: '本轮验收进度',
    dedupeKey: 'bot-round-without-list',
  });
  assert.equal(unchanged.code, 4, JSON.stringify(unchanged));
  assert.equal(unchanged.body.reason, 'not-current-round');
  assert.equal(oldWorld.writes.length, 0);

  // 本人发的照旧放行
  const ownWorld = defaultTree();
  const ownComment = ownWorld.get(ROOT_REF).comments[0];
  const plainOwn = await (await gateWith(plain.home, plain.profile, ownWorld, ownComment.databaseId)).handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    body: '本轮验收进度',
    dedupeKey: 'owner-round',
  });
  assert.equal(plainOwn.code, 0, JSON.stringify(plainOwn));
});
