// 验收语义与写闸修正：只出裁决名单（verdictOnlyIssues）、关单顺序与覆盖率、账本、看板验收中、
// poll 的 outOfScope / passedButOpen、北京时间、写闸小问题。写闸相关的一律用真 createGate；
// helper → 真写闸的端到端用真 bin/github.mjs（writeCommand 交给写闸 handle，读路由到内存里的假 GitHub）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isVerdictOnly, loadAcceptanceProfile } from './bin/profile.mjs';
import { beijingIso, bodyVersion, createRounds, parseRounds } from './bin/rounds.mjs';
import { createGithub, isReadOnlyGraphql, WriteFailedError, WriteRejectedError } from './bin/github.mjs';
import { ACCEPTANCE_VALUE_QUERY } from './bin/board.mjs';
import { runHelper } from './bin/helper.mjs';
import { runRound } from './bin/round.mjs';
import { poll } from './bin/poll.mjs';
import { readNeedsHuman } from './bin/push.mjs';
import { missingConclusions, VERDICT_ONLY_LINE } from './bin/verdict.mjs';
import { shouldTrigger } from './bin/trigger.mjs';
import { INVENTORY_QUERY } from './bin/tasks.mjs';
import { collectTree } from './bin/collect.mjs';
import { createGate } from './host/write-gate.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { POLL_NOTICE_WINDOW_MS, remindPollNotices, runTick } from './host/tick.mjs';
import { run as procRun } from './host/proc.mjs';
import { HANDOFF_REPO, OWNER, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
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

const ROOT_REF = `${REPO}#1`;
const OUTSIDE_REPO = 'someone-else/not-in-profile';
const now = () => Date.parse(CLOCK);

function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

/** 宿主环境：profile + 写闸总开关开着。`profile` 额外键（比如 verdictOnlyIssues）原样写进 profile.json。 */
function setup({ profile: extra = {}, enabled = true } = {}) {
  // 跨仓子 issue 在 example-owner/other-repo：默认把 example-owner/* 也放进 autoRepos（树里没有名单外的仓）。
  const { home } = writeProfile(tmpDir(), { profile: { autoRepos: [`${OWNER}/*`, 'example-owner/*'], ...extra } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  if (enabled) fs.writeFileSync(paths.enabledFile, '1');
  return { home, profile, paths };
}

/** 写闸自己用的 github：读写都直接落到内存里的假 GitHub（写闸不再经 writeCommand）。 */
function gateGithub(world) {
  return {
    async graphql(query, variables) {
      return world.graphql({ query, variables });
    },
    async write(action) {
      return world.write(action);
    },
  };
}

function bindingFor(world, { round = 1, root = ROOT_REF } = {}) {
  const issue = world.get(root);
  const comment = issue.comments.find((entry) => entry.body.startsWith(`[验收机] 第 ${round} 轮`));
  return { root, round, commentId: comment.databaseId };
}

function openGate({ home, profile, world, binding, log }) {
  return createGate({ home, profile, github: gateGithub(world), run: procRun, binding, which: async () => false, log });
}

/** 盘点查询：从内存里的假 GitHub 拼 user.open / user.closed（只给 bin/round.mjs start 用）。 */
function inventoryFromWorld(world) {
  const nodes = [];
  for (const issue of world.issues.values()) {
    nodes.push({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
      url: issue.url,
      createdAt: issue.createdAt,
      closedAt: issue.closedAt,
      updatedAt: issue.createdAt,
      author: { login: issue.author },
      repository: { nameWithOwner: issue.repo },
      parent: issue.parent
        ? { number: world.get(issue.parent).number, repository: { nameWithOwner: world.get(issue.parent).repo }, author: { login: world.get(issue.parent).author } }
        : null,
      subIssues: {
        nodes: issue.subIssues.map((ref) => {
          const child = world.get(ref);
          return {
            number: child.number,
            title: child.title,
            state: child.state === 'closed' ? 'CLOSED' : 'OPEN',
            url: child.url,
            closedAt: child.closedAt,
            author: { login: child.author },
            repository: { nameWithOwner: child.repo },
          };
        }),
      },
      closedByPullRequestsReferences: { nodes: issue.prs },
      comments: { nodes: issue.comments.map((comment) => ({ ...comment, author: { login: comment.author.login } })) },
    });
  }
  const open = nodes.filter((node) => node.state === 'OPEN');
  const closed = nodes.filter((node) => node.state === 'CLOSED');
  return {
    user: {
      open: { nodes: open, pageInfo: { hasNextPage: false, endCursor: null } },
      closed: { nodes: closed, pageInfo: { hasNextPage: false, endCursor: null } },
    },
  };
}

/**
 * 真 bin/github.mjs：读（gh api graphql）路由到假 GitHub；写配了 writeCommand，动作 JSON 交给真写闸 handle，
 * 退出码和 stdout 照抄写闸——和沙箱里的 gate-client 一样。
 */
function realGithubThroughGate({ profile, world, gate }) {
  const gateCalls = [];
  const run = async (cmd, args, { input } = {}) => {
    if (cmd === 'gh' && args.includes('graphql')) {
      const payload = JSON.parse(input || '{}');
      const data = payload.query === INVENTORY_QUERY ? inventoryFromWorld(world) : world.graphql(payload);
      return { code: 0, stdout: JSON.stringify({ data }), stderr: '' };
    }
    if (cmd === 'gate-client') {
      const action = JSON.parse(input);
      gateCalls.push(action);
      const outcome = await gate.handle(action);
      return { code: outcome.code, stdout: JSON.stringify(outcome.body ?? {}), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${cmd}` };
  };
  const github = createGithub({ profile: { ...profile, writeCommand: ['gate-client'] }, run, sleep: async () => {} });
  github.gateCalls = gateCalls;
  return github;
}

async function helper(github, profile, argv, { clock = now } = {}) {
  const out = sink();
  const err = sink();
  const code = await runHelper(argv, { github, profile, now: clock, stdout: out, stderr: err });
  return { code, out: out.text, err: err.text };
}

function rootComment(world) {
  return world.get(ROOT_REF).comments.find((entry) => entry.body.startsWith('[验收机] 第 1 轮'));
}

// ---------------------------------------------------------------- profile

test('verdictOnlyIssues：格式校验（owner/repo#号，不收通配）、默认空、大小写不敏感', () => {
  const ok = setup({ profile: { verdictOnlyIssues: [`${REPO}#43`] } });
  assert.deepEqual([...ok.profile.verdictOnlyIssues], [`${REPO}#43`]);
  assert.equal(isVerdictOnly(ok.profile, `${REPO.toUpperCase()}#43`), true);
  assert.equal(isVerdictOnly(ok.profile, `${REPO}#4`), false);

  const none = setup();
  assert.deepEqual([...none.profile.verdictOnlyIssues], []);

  for (const bad of [[`${REPO}`], [`${REPO}#0`], ['example-owner/*#1'], [`${REPO}#x`], 'nope', [1]]) {
    const { home } = writeProfile(tmpDir(), { profile: { verdictOnlyIssues: bad } });
    assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /verdictOnlyIssues/, JSON.stringify(bad));
  }
});

test('配置模板里有 verdictOnlyIssues 占位，而且模板本身能过校验的格式', () => {
  const example = JSON.parse(
    fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'config', 'examples', 'acceptance.profile.example.json'), 'utf8'),
  );
  assert.ok(Array.isArray(example.verdictOnlyIssues));
  for (const item of example.verdictOnlyIssues) assert.match(item, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d*$/);
});

// ---------------------------------------------------------------- verdict-only：helper 侧

test('verdict-only：close / correct / push 一律退出码 1、零写入、写清原因；collect 标出 verdictOnly', async () => {
  const { profile, home } = setup({ profile: { verdictOnlyIssues: [ROOT_REF] } });
  const verified = writeJsonFile(home, 'verified.json', { checks: ALL_RAN, items: [{ ref: `${REPO}#2`, sc: 3 }], manual: [] });
  const commands = [
    ['close', '--issue', ROOT_REF, '--round', '1', '--verified', verified, '--verdict', PASS_VERDICT_FILE],
    ['correct', '--issue', ROOT_REF, '--round', '1', '--item', `${REPO}#2 SC3`, '--why', 'x'],
    ['push', '--issue', ROOT_REF, '--round', '1', '--repo', REPO, '--branch', 'acceptance/1-2-sc3', '--worktree', home],
  ];
  for (const argv of commands) {
    const world = defaultTree();
    const result = await helper(createFakeGithub(world), profile, argv);
    assert.equal(result.code, 1, `${argv[0]}：${result.err}`);
    assert.match(result.err, /verdictOnlyIssues/, argv[0]);
    assert.match(result.err, /不关、不勾、不开修正、不推送/, argv[0]);
    assert.equal(world.writes.length, 0, `${argv[0]} 不该写`);
    assert.equal(world.get(ROOT_REF).state, 'open');
    assert.match(rootComment(world).body, /第 1 轮：验收中/, '不标中断');
  }
  const tree = await collectTree({ github: createFakeGithub(defaultTree()), profile, ref: ROOT_REF });
  assert.equal(tree.root.verdictOnly, true);
});

// ---------------------------------------------------------------- verdict-only：写闸侧

test('verdict-only 写闸：绑定到名单里的根，关单 / 勾选 / 开修正 / 挂子 issue / 推送 / 开 PR 一律 4 verdict-only；评论和看板照常', async () => {
  const { home, profile, paths } = setup({ profile: { verdictOnlyIssues: [ROOT_REF] } });
  const world = defaultTree();
  const gate = openGate({ home, profile, world, binding: bindingFor(world) });
  await gate.start();
  const child = world.get(`${REPO}#2`);
  const marker = `[验收机] 修正 · 总 ${ROOT_REF} · 项 ${REPO}#2 SC3 · 第 1 轮`;
  const blocked = [
    { type: 'issue.close', repo: REPO, issue: 1, reason: 'completed' },
    { type: 'issue.edit', repo: REPO, issue: 2, body: child.body.replace('- [ ] SC3', '- [x] SC3') },
    { type: 'issue.create', repo: REPO, title: '修正', body: marker },
    { type: 'issue.reopen', repo: REPO, issue: 1 },
    { type: 'subissue.add', repo: REPO, issue: 1, subRepo: REPO, subIssue: 2 },
    { type: 'branch.push', repo: REPO, branch: 'acceptance/1-2-sc3', bundlePath: path.join(home, 'x.bundle') },
    { type: 'pr.create', repo: REPO, head: 'acceptance/1-2-sc3', base: 'main', draft: true, title: 't', body: marker },
  ];
  for (const action of blocked) {
    const outcome = await gate.handle({ ...action, dedupeKey: `vo-${action.type}` });
    assert.equal(outcome.code, 4, `${action.type}：${JSON.stringify(outcome)}`);
    assert.equal(outcome.body.reason, 'verdict-only', action.type);
  }
  assert.equal(world.writes.length, 0);
  assert.ok(readAlerts(paths).some((alert) => alert.kind === 'gate-rejected' && alert.reason === 'verdict-only'));

  const board = await gate.handle({
    type: 'project.field.set',
    repo: REPO,
    issue: 1,
    ownerLogin: OWNER,
    projectNumber: 7,
    fields: { 验收: '通过' },
    dedupeKey: 'vo-board',
  });
  assert.equal(board.code, 0, JSON.stringify(board));
  const comment = await gate.handle({ type: 'comment.create', repo: REPO, issue: 2, body: '[验收机] 备注', dedupeKey: 'vo-comment' });
  assert.equal(comment.code, 0, JSON.stringify(comment));

  // 别的根不受影响。
  const other = setup();
  const otherWorld = defaultTree();
  const normal = openGate({ home: other.home, profile: other.profile, world: otherWorld, binding: bindingFor(otherWorld) });
  await normal.start();
  const closed = await normal.handle({ type: 'issue.close', repo: REPO, issue: 1, reason: 'completed', dedupeKey: 'normal-close' });
  assert.equal(closed.code, 0, JSON.stringify(closed));
});

test('端到端 verdict-only：helper → 真写闸，裁决照写并带「本 issue 由人工复核后关闭」，issue 不关', async () => {
  const { home, profile } = setup({ profile: { verdictOnlyIssues: [ROOT_REF] } });
  const world = defaultTree();
  const gate = openGate({ home, profile, world, binding: bindingFor(world) });
  await gate.start();
  const github = realGithubThroughGate({ profile, world, gate });
  const verified = writeJsonFile(home, 'verified.json', { checks: ALL_RAN, items: [{ ref: `${REPO}#2`, sc: 3 }], manual: [] });

  const close = await helper(github, profile, ['close', '--issue', ROOT_REF, '--round', '1', '--verified', verified, '--verdict', PASS_VERDICT_FILE]);
  assert.equal(close.code, 1, close.err);
  assert.equal(github.gateCalls.length, 0, 'helper 侧先拒，动作根本没到写闸');

  const board = await helper(github, profile, ['board', '--issue', ROOT_REF, '--round', '1', '--target', 'all', '--acceptance', '通过', '--checks', ALL_RAN_CHECKS_FILE]);
  assert.equal(board.code, 0, board.err);

  const file = writeJsonFile(home, 'verdict.json', { checks: ALL_RAN, items: fullConclusions() });
  const verdict = await helper(github, profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', file]);
  assert.equal(verdict.code, 0, verdict.err);
  const body = rootComment(world).body;
  assert.match(body.split('\n')[0], /^\[验收机\] 第 1 轮：通过$/);
  assert.ok(body.split('\n').includes(VERDICT_ONLY_LINE), body);
  assert.equal(VERDICT_ONLY_LINE, '本 issue 由人工复核后关闭。');
  assert.equal(world.get(ROOT_REF).state, 'open', '只出裁决：不关');
  assert.equal(world.writes.some((action) => ['issue.close', 'issue.edit'].includes(action.type)), false);

  const done = await helper(github, profile, ['done', '--issue', ROOT_REF, '--round', '1']);
  assert.equal(done.code, 0, done.err);
});

test('helper：写闸回 4 verdict-only（绕过 helper 的情形）→ 退出码 4，但不标中断', async () => {
  const { profile } = setup();
  const world = defaultTree();
  const result = await helper(
    createFakeGithub(world, {
      onWrite: (action) => {
        if (action.type === 'project.field.set') throw new WriteRejectedError('外发被拒', { exitCode: 4, reason: 'verdict-only' });
        return undefined;
      },
    }),
    profile,
    ['board', '--issue', ROOT_REF, '--round', '1', '--acceptance', '通过', '--checks', ALL_RAN_CHECKS_FILE],
  );
  assert.equal(result.code, 4);
  assert.match(rootComment(world).body, /第 1 轮：验收中/);
});

// ---------------------------------------------------------------- 关单顺序与覆盖率

test('close 顺序 勾选 → 看板 → 关单：看板写失败就停在关单之前，issue 还开着', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  const verified = writeJsonFile(home, 'verified.json', { checks: ALL_RAN, items: [{ ref: `${REPO}#2`, sc: 3 }], manual: [] });
  const result = await helper(
    createFakeGithub(world, {
      onWrite: (action) => {
        if (action.type === 'project.field.set' && action.issue === 2) throw new Error('看板写失败');
        return undefined;
      },
    }),
    profile,
    ['close', '--issue', ROOT_REF, '--round', '1', '--verified', verified, '--verdict', PASS_VERDICT_FILE],
  );
  assert.equal(result.code, 1, result.err);
  assert.match(result.err, /看板写失败/);
  assert.equal(world.get(ROOT_REF).state, 'open', '看板没写成就不关单');
  assert.equal(world.writes.some((action) => action.type === 'issue.close'), false);
  assert.ok(world.get(`${REPO}#2`).body.includes('- [x] SC3'), '勾选在看板之前');
});

test('端到端 close：helper → 真写闸，勾选（含 CRLF 正文）→ 看板 → 关单都放行', async () => {
  const { home, profile } = setup();
  const childBody = ['# 子任务', '', '- [ ] SC3 把结果写进轮次评论 验证：unit', '- [ ] SC5 真机 验证：cindy-mac', ''].join('\r\n');
  const world = defaultTree({ childBody });
  const gate = openGate({ home, profile, world, binding: bindingFor(world) });
  await gate.start();
  const github = realGithubThroughGate({ profile, world, gate });
  const verified = writeJsonFile(home, 'verified.json', { checks: ALL_RAN,
    items: [{ ref: `${REPO}#2`, sc: 3 }],
    manual: [{ ref: `${REPO}#2`, sc: 5 }],
  });
  const result = await helper(github, profile, ['close', '--issue', ROOT_REF, '--round', '1', '--verified', verified, '--verdict', PASS_VERDICT_FILE]);
  assert.equal(result.code, 0, result.err);
  const types = github.gateCalls.map((action) => action.type);
  assert.deepEqual(types, ['issue.edit', 'project.field.set', 'project.field.set', 'project.field.set', 'issue.close']);
  const body = world.get(`${REPO}#2`).body;
  assert.ok(body.includes('- [x] SC3 把结果写进轮次评论 验证：unit\r\n'), JSON.stringify(body));
  assert.ok(body.includes('SC5 真机 验证：cindy-mac 人工手测'), JSON.stringify(body));
  assert.equal(world.get(ROOT_REF).state, 'closed');
});

test('写闸：CRLF 正文的勾选（行尾 \\r）放行，改了别的字照拒', async () => {
  const { home, profile } = setup();
  const childBody = ['- [ ] SC3 a', '- [ ] SC4 b', ''].join('\r\n');
  const world = defaultTree({ childBody });
  const gate = openGate({ home, profile, world, binding: bindingFor(world) });
  await gate.start();
  const ticked = await gate.handle({
    type: 'issue.edit',
    repo: REPO,
    issue: 2,
    body: childBody.replace('- [ ] SC3', '- [x] SC3'),
    dedupeKey: 'crlf-1',
  });
  assert.equal(ticked.code, 0, JSON.stringify(ticked));
  const sneaky = await gate.handle({
    type: 'issue.edit',
    repo: REPO,
    issue: 2,
    body: world.get(`${REPO}#2`).body.replace('SC4 b', 'SC4 c'),
    dedupeKey: 'crlf-2',
  });
  assert.equal(sneaky.code, 4);
  assert.equal(sneaky.body.reason, 'edit-not-allowed');
});

test('verdict 覆盖率：任务树里有 SC 没结论 → 退出码 1、点名缺哪几条、零写入；items 为空不得判通过', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  const partial = writeJsonFile(home, 'partial.json', {
    items: fullConclusions().filter((item) => !(item.ref === `${OTHER_REPO}#7` || (item.ref === `${REPO}#1` && item.sc === 2))),
  });
  const missing = await helper(createFakeGithub(world), profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', partial]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /裁决缺结论/);
  for (const ref of [`${REPO}#1 SC2`, `${OTHER_REPO}#7 SC7`, `${OTHER_REPO}#7 SC8`]) assert.ok(missing.err.includes(ref), ref);
  assert.equal(missing.err.includes(`${REPO}#2 SC3`), false);
  assert.equal(world.writes.length, 0);
  assert.match(rootComment(world).body, /第 1 轮：验收中/);

  const empty = writeJsonFile(home, 'empty.json', { items: [] });
  // 连没有 SC 的任务（items 本该是提炼出来的标准）也不行：空的不能判通过。
  const bare = defaultTree({ rootBody: '# 没写验收标准', childBody: '', otherBody: '' });
  const none = await helper(createFakeGithub(bare), profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', empty]);
  assert.equal(none.code, 1);
  assert.match(none.err, /items 是空的/);
  assert.equal(bare.writes.length, 0);

  // 提炼出来的标准（extracted: true）覆盖率按任务树算：树里没有 SC，就只要求非空。
  const extracted = writeJsonFile(home, 'extracted.json', {
    extracted: true,
    checks: ALL_RAN,
    items: [{ ref: ROOT_REF, sc: 1, result: '通过', evidence: 'ok' }],
  });
  bare.get(ROOT_REF).state = 'closed';
  const ok = await helper(createFakeGithub(bare), profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', extracted]);
  assert.equal(ok.code, 0, ok.err);
});

test('missingConclusions：大小写不敏感、同一条只报一次', () => {
  const tree = {
    issues: [
      { ref: `${REPO}#2`, items: [{ source: `${REPO}#2`, sc: 3 }, { source: `${REPO}#2`, sc: 3 }, { source: `${REPO}#2`, sc: 4 }] },
    ],
  };
  assert.deepEqual(missingConclusions(tree, [{ ref: `${REPO.toUpperCase()}#2`, sc: 3 }]), [`${REPO}#2 SC4`]);
  assert.deepEqual(missingConclusions(tree, []), [`${REPO}#2 SC3`, `${REPO}#2 SC4`]);
});

test('端到端 verdict：helper → 真写闸，全覆盖的裁决放行；时间写北京时间', async () => {
  const { home, profile } = setup();
  const world = defaultTree();
  const gate = openGate({ home, profile, world, binding: bindingFor(world) });
  await gate.start();
  const github = realGithubThroughGate({ profile, world, gate });
  const file = writeJsonFile(home, 'verdict.json', { checks: ALL_RAN,
    items: fullConclusions({ [`${REPO}#2 SC4`]: { result: '要修', why: '没写' } }),
  });
  const result = await helper(github, profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', file]);
  assert.equal(result.code, 0, result.err);
  const body = rootComment(world).body;
  assert.match(body.split('\n')[0], /第 1 轮：要修/);
  assert.ok(body.includes(`完成：${CLOCK_BEIJING}`), body);
  assert.equal(github.gateCalls.at(-1).dedupeKey, `verdict:${ROOT_REF}:1:${bindingFor(world).commentId}:要修`);
});

// ---------------------------------------------------------------- 账本

test('账本：轮次评论被删后同号再认领，去重键带开始时间，真写闸发新评论，不拿回旧评论 id', async () => {
  const { home, profile } = setup();
  const world = createWorld({ now });
  world.addIssue({ repo: REPO, number: 1, body: '独立任务' });
  const gate = openGate({ home, profile, world, binding: null });
  const github = realGithubThroughGate({ profile, world, gate });
  const task = { ref: ROOT_REF, repo: REPO, number: 1, kind: 'standalone', tier: 'auto', children: [] };

  let clockMs = Date.parse('2026-10-24T02:00:00.000Z');
  const rounds = createRounds({ github, profile, now: () => clockMs });
  const first = await rounds.start(task);
  assert.equal(first.round, 1);
  assert.equal(github.gateCalls[0].dedupeKey, `round-start:${ROOT_REF}:1:2026-10-24T10:00:00+08:00`);
  assert.match(world.get(ROOT_REF).comments[0].body, /^开始：2026-10-24T10:00:00\+08:00$/m);

  // 评论被删（或挤出读取窗口）：GitHub 上看不到第 1 轮了。
  world.get(ROOT_REF).comments.length = 0;
  fs.rmSync(path.join(profile.stateDir, 'locks'), { recursive: true, force: true });
  clockMs += 60 * 1000;
  const second = await rounds.start(task);
  assert.equal(second.round, 1);
  assert.notEqual(second.commentId, first.commentId, '不是拿回旧评论 id 的假轮次');
  assert.equal(world.get(ROOT_REF).comments.length, 1, '真的发了新评论');
  assert.equal(world.get(ROOT_REF).comments[0].databaseId, second.commentId);
});

test('账本：exec 模式先做归属校验再查账本——账本里有同名 key 也照样拒绝不归它的动作', async () => {
  const { home, profile, paths } = setup();
  const world = defaultTree();
  fs.appendFileSync(
    paths.ledgerFile,
    `${JSON.stringify({ dedupeKey: 'stale-abort', type: 'comment.update', result: { commentId: 999 }, at: CLOCK })}\n`,
  );
  const gate = openGate({ home, profile, world, binding: null });
  const outcome = await gate.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 1,
    commentId: 424242,
    dedupeKey: 'stale-abort',
    body: '[验收机] 第 1 轮：中断',
  });
  assert.equal(outcome.code, 4, JSON.stringify(outcome));
  assert.equal(outcome.body.reason, 'needs-round-binding');

  // 归属对了、key 也在账本里：照旧按账本返回（不重复执行）。
  const commentId = bindingFor(world).commentId;
  const abort = {
    type: 'comment.update',
    repo: REPO,
    issue: 1,
    commentId,
    dedupeKey: 'real-abort',
    body: ['[验收机] 第 1 轮：中断', '原因：x'].join('\n'),
  };
  fs.appendFileSync(paths.ledgerFile, `${JSON.stringify({ dedupeKey: 'real-abort', type: 'comment.update', result: { cached: true }, at: CLOCK })}\n`);
  const cached = await gate.handle(abort);
  assert.deepEqual(cached, { code: 0, body: { cached: true } });
  assert.equal(world.writes.length, 0);
});

test('账本：验收轮（serve）的记录只在同一条认领评论下算数，同号的新轮次不会拿到旧结果', async () => {
  const { home, profile, paths } = setup();
  const world = defaultTree();
  const action = { type: 'comment.create', repo: REPO, issue: 2, body: '[验收机] 备注', dedupeKey: 'same-key-across-rounds' };
  const firstGate = openGate({ home, profile, world, binding: bindingFor(world) });
  await firstGate.start();
  assert.equal((await firstGate.handle(action)).code, 0);
  assert.equal((await firstGate.handle(action)).code, 0);
  assert.equal(world.writes.length, 1, '同一轮里同一个 key 只执行一次');

  // 旧的第 1 轮评论被删，宿主重新认领了第 1 轮（新评论 id）。
  const root = world.get(ROOT_REF);
  root.comments.length = 0;
  world.addComment(ROOT_REF, roundComment({ round: 1, status: '验收中', bodyVersion: bodyVersion(root.body), databaseId: 7777 }));
  const secondGate = openGate({ home, profile, world, binding: bindingFor(world) });
  await secondGate.start();
  const again = await secondGate.handle(action);
  assert.equal(again.code, 0, JSON.stringify(again));
  assert.equal(world.writes.length, 2, '新轮次真的执行了');
  const ledger = fs.readFileSync(paths.ledgerFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(ledger.map((entry) => entry.boundCommentId), [1001, 7777]);
});

test('rounds.finish / verdict 的去重键带评论 id', async () => {
  const { profile } = setup();
  const world = defaultTree();
  const rounds = createRounds({ github: createFakeGithub(world), profile, now });
  await rounds.finish(ROOT_REF, 1, '中断', { reason: 'x' });
  const update = world.writes.find((action) => action.type === 'comment.update');
  assert.equal(update.dedupeKey, `round-finish:${ROOT_REF}:1:1001:中断`);
  assert.match(update.body, /^完成：2026-10-24T10:00:00\+08:00$/m);
});

// ---------------------------------------------------------------- 认领时看板写「验收中」

function claimableWorld() {
  const world = createWorld({ now });
  world.addIssue({ repo: REPO, number: 1, title: '总任务', body: '- [ ] SC1 x' });
  world.addIssue({ repo: REPO, number: 2, title: '子任务', body: '- [ ] SC2 y', state: 'closed', closedAt: '2026-10-20T00:00:00.000Z' });
  world.addIssue({ repo: OTHER_REPO, number: 7, title: '跨仓', body: '- [ ] SC3 z', state: 'closed', closedAt: '2026-10-20T00:00:00.000Z' });
  world.addChild(ROOT_REF, `${REPO}#2`);
  world.addChild(ROOT_REF, `${OTHER_REPO}#7`);
  return world;
}

async function claim(github, profile, { alert } = {}) {
  const out = sink();
  const err = sink();
  const code = await runRound(['start', '--issue', ROOT_REF], { github, profile, now, stdout: out, stderr: err, alert });
  return { code, out: out.text, err: err.text };
}

test('认领：bin/round.mjs start 经真写闸 exec 认领后，总 issue 和子 issue 的看板都写「验收中」', async () => {
  const { home, profile } = setup();
  const world = claimableWorld();
  const gate = openGate({ home, profile, world, binding: null });
  const github = realGithubThroughGate({ profile, world, gate });
  const result = await claim(github, profile);
  assert.equal(result.code, 0, result.err);
  assert.equal(result.err, '');
  for (const ref of [ROOT_REF, `${REPO}#2`, `${OTHER_REPO}#7`]) {
    assert.equal(world.get(ref).project['验收'], '验收中', ref);
  }
  const boards = github.gateCalls.filter((action) => action.type === 'project.field.set');
  assert.equal(boards.length, 3);
  const commentId = JSON.parse(result.out.trim().split('\n').at(-1)).commentId;
  for (const action of boards) {
    assert.deepEqual(action.fields, { 验收: '验收中' }, '只写验收，不动裁决');
    assert.equal(action.root, ROOT_REF);
    assert.equal(action.round, 1);
    assert.equal(action.dedupeKey, `board-claim:${action.ref}:1:${commentId}`);
  }
});

test('认领：看板写失败不让认领失败，写一条 board-claim-failed 提醒', async () => {
  const { home, profile, paths } = setup();
  const world = claimableWorld();
  const gate = openGate({ home, profile, world, binding: null });
  const github = realGithubThroughGate({ profile, world, gate });
  const origWrite = github.write;
  github.write = async (action) => {
    if (action.type === 'project.field.set' && action.issue === 2) throw new Error('看板接口挂了');
    return origWrite(action);
  };
  const result = await claim(github, profile);
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /看板「验收中」没写成（认领照常）/);
  assert.match(world.get(ROOT_REF).comments[0].body, /第 1 轮：验收中/);
  const alerts = readAlerts(paths).filter((alert) => alert.kind === 'board-claim-failed');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].issue, ROOT_REF);
  assert.equal(alerts[0].round, 1);
  assert.match(alerts[0].detail, /example-owner\/example-repo#2/);
});

/**
 * 认领后写看板的「外发失败」模拟：写闸照常放行，到真正写 GitHub 那一步按 plan 出错。
 * plan: ref → [{ landed }...]，每次写这个 ref 的看板消耗一条；landed=true 表示 GitHub 其实写成了、只是回包丢了（TLS EOF）。
 */
function openFlakyBoardGate({ home, profile, world, plan, failComment = false }) {
  const github = {
    async graphql(query, variables) {
      return world.graphql({ query, variables });
    },
    async write(action) {
      if (failComment && action.type === 'comment.create') throw new Error('net/http: TLS handshake timeout');
      if (action.type === 'project.field.set') {
        const queue = plan.get(`${action.repo}#${action.issue}`);
        const step = queue?.shift();
        if (step) {
          if (step.landed) world.write(action);
          throw new Error(step.landed ? 'unexpected EOF' : 'net/http: TLS handshake timeout');
        }
      }
      return world.write(action);
    },
  };
  return createGate({ home, profile, github, run: procRun, binding: null, which: async () => false });
}

function boardCallsFor(github, ref) {
  return github.gateCalls.filter((action) => action.type === 'project.field.set' && action.ref === ref);
}

test('认领后看板外发失败：先查看板没写成 → 经写闸重试一次写成，不记 board-claim-failed', async () => {
  const { home, profile, paths } = setup();
  const world = claimableWorld();
  const child = `${REPO}#2`;
  const gate = openFlakyBoardGate({ home, profile, world, plan: new Map([[child, [{ landed: false }]]]) });
  const github = realGithubThroughGate({ profile, world, gate });
  const result = await claim(github, profile);
  assert.equal(result.code, 0, result.err);
  for (const ref of [ROOT_REF, child, `${OTHER_REPO}#7`]) assert.equal(world.get(ref).project['验收'], '验收中', ref);
  const calls = boardCallsFor(github, child);
  assert.equal(calls.length, 2, '只重试一次');
  assert.equal(calls[0].dedupeKey, calls[1].dedupeKey, '重试用同一个去重键');
  assert.equal(boardCallsFor(github, ROOT_REF).length, 1, '没失败的目标不重试');
  assert.equal(readAlerts(paths).filter((alert) => alert.kind === 'board-claim-failed').length, 0);
  // 重试也走写闸：账本里记了这条（写闸只在真写成后记账）。
  const ledger = fs.readFileSync(paths.ledgerFile, 'utf8');
  assert.match(ledger, new RegExp(`board-claim:${child.replace('/', '\\/')}:1:`));
});

test('认领后看板外发失败但 GitHub 其实已写成：查到已是「验收中」就不再写', async () => {
  const { home, profile, paths } = setup();
  const world = claimableWorld();
  const child = `${REPO}#2`;
  const gate = openFlakyBoardGate({ home, profile, world, plan: new Map([[child, [{ landed: true }]]]) });
  const github = realGithubThroughGate({ profile, world, gate });
  const result = await claim(github, profile);
  assert.equal(result.code, 0, result.err);
  assert.equal(world.get(child).project['验收'], '验收中');
  assert.equal(boardCallsFor(github, child).length, 1, '已写成就不重复写');
  assert.equal(world.writes.filter((action) => action.type === 'project.field.set' && action.issue === 2).length, 1);
  assert.equal(readAlerts(paths).filter((alert) => alert.kind === 'board-claim-failed').length, 0);
});

test('认领后看板重试一次仍失败：照原路径记 board-claim-failed，认领照常，不再第三次', async () => {
  const { home, profile, paths } = setup();
  const world = claimableWorld();
  const child = `${REPO}#2`;
  const gate = openFlakyBoardGate({ home, profile, world, plan: new Map([[child, [{ landed: false }, { landed: false }, { landed: false }]]]) });
  const github = realGithubThroughGate({ profile, world, gate });
  const result = await claim(github, profile);
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /看板「验收中」没写成（认领照常）/);
  assert.match(world.get(ROOT_REF).comments[0].body, /第 1 轮：验收中/);
  assert.equal(boardCallsFor(github, child).length, 2);
  assert.equal(world.get(child).project['验收'], undefined);
  const alerts = readAlerts(paths).filter((alert) => alert.kind === 'board-claim-failed');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].detail, /example-owner\/example-repo#2/);
  assert.match(alerts[0].detail, /重试一次仍失败/);
});

test('认领后看板：重试前查看板也失败 → 不重试，照原路径记提醒', async () => {
  const { home, profile, paths } = setup();
  const world = claimableWorld();
  const child = `${REPO}#2`;
  const gate = openFlakyBoardGate({ home, profile, world, plan: new Map([[child, [{ landed: false }]]]) });
  const github = realGithubThroughGate({ profile, world, gate });
  github.ownerGraphql = async () => {
    throw new Error('net/http: TLS handshake timeout');
  };
  const result = await claim(github, profile);
  assert.equal(result.code, 0, result.err);
  assert.equal(boardCallsFor(github, child).length, 1, '查不清就不重试');
  const alerts = readAlerts(paths).filter((alert) => alert.kind === 'board-claim-failed');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].detail, /查看板也失败/);
});

test('认领后看板：写闸拒绝（4）不重试，不查看板', async () => {
  const { home, profile, paths } = setup();
  const world = claimableWorld();
  const gate = openGate({ home, profile, world, binding: null });
  const github = realGithubThroughGate({ profile, world, gate });
  let boardReads = 0;
  const origOwner = github.ownerGraphql;
  github.ownerGraphql = async (query, variables) => {
    if (String(query).includes('fieldValueByName(')) boardReads += 1;
    return origOwner(query, variables);
  };
  const origWrite = github.write;
  let attempts = 0;
  github.write = async (action) => {
    if (action.type === 'project.field.set' && action.issue === 2) {
      attempts += 1;
      throw new WriteRejectedError('外发被拒：not-in-tree', { exitCode: 4, reason: 'not-in-tree' });
    }
    return origWrite(action);
  };
  const result = await claim(github, profile);
  assert.equal(result.code, 0, result.err);
  assert.equal(attempts, 1);
  assert.equal(boardReads, 0);
  assert.equal(readAlerts(paths).filter((alert) => alert.kind === 'board-claim-failed').length, 1);
});

test('重试前查看板用的是纯只读 GraphQL', () => {
  assert.equal(isReadOnlyGraphql(ACCEPTANCE_VALUE_QUERY), true);
});

test('别的写不重试：认领评论外发失败只发一次', async () => {
  const { home, profile } = setup();
  const world = claimableWorld();
  const gate = openFlakyBoardGate({ home, profile, world, plan: new Map(), failComment: true });
  const github = realGithubThroughGate({ profile, world, gate });
  const result = await claim(github, profile);
  assert.notEqual(result.code, 0);
  assert.equal(github.gateCalls.filter((action) => action.type === 'comment.create').length, 1);
  assert.equal(github.gateCalls.filter((action) => action.type === 'project.field.set').length, 0);
});

test('写闸 exec 看板：只许认领时把「验收」写成「验收中」，字段 / 值 / 轮次 / 树外 / 缺 root 一律拒绝', async () => {
  const { home, profile } = setup();
  const world = defaultTree();
  const gate = openGate({ home, profile, world, binding: null });
  const base = { type: 'project.field.set', repo: REPO, issue: 2, ownerLogin: OWNER, projectNumber: 7, root: ROOT_REF, round: 1 };
  const cases = [
    [{ fields: { 验收: '通过' } }, 'needs-round-binding'],
    [{ fields: { 验收: '验收中', 裁决: 'https://example.invalid' } }, 'needs-round-binding'],
    [{ fields: { 验收: '验收中' }, round: 2 }, 'needs-round-binding'],
    [{ fields: { 验收: '验收中' }, root: undefined }, 'needs-round-binding'],
    [{ fields: { 验收: '验收中' }, root: `${OUTSIDE_REPO}#1` }, 'repo-not-allowed'],
    [{ fields: { 验收: '验收中' }, repo: REPO, issue: 99 }, 'not-in-tree'],
  ];
  let i = 0;
  for (const [patch, reason] of cases) {
    const outcome = await gate.handle({ ...base, ...patch, dedupeKey: `exec-board-${(i += 1)}` });
    assert.equal(outcome.code, 4, `${JSON.stringify(patch)} → ${JSON.stringify(outcome)}`);
    assert.equal(outcome.body.reason, reason, JSON.stringify(patch));
  }
  assert.equal(world.writes.length, 0);
  const ok = await gate.handle({ ...base, fields: { 验收: '验收中' }, dedupeKey: 'exec-board-ok' });
  assert.equal(ok.code, 0, JSON.stringify(ok));
  assert.equal(world.get(`${REPO}#2`).project['验收'], '验收中');

  // 已出裁决（不在验收中）就不能再经 exec 写看板。
  const finished = defaultTree({ roundStatus: '通过' });
  const finishedGate = openGate({ home, profile, world: finished, binding: null });
  const late = await finishedGate.handle({ ...base, fields: { 验收: '验收中' }, dedupeKey: 'exec-board-late' });
  assert.equal(late.code, 4);
  assert.equal(late.body.reason, 'needs-round-binding');
});

// ---------------------------------------------------------------- poll / tick

function pollGithub(world, profile) {
  return {
    async graphql(query, variables) {
      if (query === INVENTORY_QUERY) return inventoryFromWorld(world);
      return world.graphql({ query, variables });
    },
    async write() {
      throw new Error('poll 不该写');
    },
    profile,
  };
}

test('poll：任务树里有名单外的仓 → 不派发，报 outOfScope；名单恢复后照常派发', async () => {
  const { profile } = setup();
  const world = claimableWorld();
  world.addIssue({ repo: OUTSIDE_REPO, number: 5, title: '名单外', body: '- [ ] SC9 w', state: 'closed', closedAt: '2026-10-20T00:00:00.000Z' });
  world.addChild(ROOT_REF, `${OUTSIDE_REPO}#5`);
  const entries = await poll({ github: pollGithub(world, profile), profile, now });
  assert.deepEqual(entries, [{ issue: ROOT_REF, outOfScope: [OUTSIDE_REPO] }]);

  const widened = setup({ profile: { autoRepos: [`${OWNER}/*`, 'example-owner/*', OUTSIDE_REPO] } });
  const again = await poll({ github: pollGithub(world, widened.profile), profile: widened.profile, now });
  assert.equal(again.length, 1);
  assert.equal(again[0].issue, ROOT_REF);
  assert.equal(again[0].nextRound, 1);
  assert.equal(again[0].outOfScope, undefined);
});

test('poll：最新裁决是通过、issue 还开着 → passedButOpen；verdictOnly / watch 档 / 已关 都不报', async () => {
  const build = ({ repo = REPO, state = 'open', passes = 2 } = {}) => {
    const world = createWorld({ now });
    const body = '独立任务';
    world.addIssue({
      repo,
      number: 1,
      body,
      state,
      closedAt: state === 'closed' ? '2026-10-23T00:00:00.000Z' : null,
      prs: [{ number: 3, url: `https://github.com/${repo}/pull/3`, mergedAt: '2026-10-20T00:00:00.000Z' }],
    });
    if (passes >= 2) {
      world.addComment(`${repo}#1`, {
        ...roundComment({ round: 1, status: '通过', bodyVersion: bodyVersion(body), finishedAt: '2026-10-22T00:00:00.000Z' }),
        url: `https://github.com/${repo}/issues/1#issuecomment-1001`,
      });
    }
    world.addComment(`${repo}#1`, {
      ...roundComment({ round: 2, status: '通过', bodyVersion: bodyVersion(body), finishedAt: '2026-10-23T00:00:00.000Z' }),
      url: `https://github.com/${repo}/issues/1#issuecomment-1002`,
    });
    return world;
  };
  const { profile } = setup();
  // 只通过过一次、没关：重跑一轮把收尾做完（trigger: passed-but-open），poll 派发它。
  const once = await poll({ github: pollGithub(build({ passes: 1 }), profile), profile, now });
  assert.equal(once.length, 1);
  assert.equal(once[0].issue, ROOT_REF);
  assert.equal(once[0].passedButOpen, undefined);
  assert.equal(once[0].nextRound, 3);
  // 同一份正文已经重跑过（通过两次）还没关：不再派发，只报 passedButOpen 给人。
  const open = await poll({ github: pollGithub(build(), profile), profile, now });
  assert.deepEqual(open, [
    { issue: ROOT_REF, passedButOpen: true, round: 2, url: `https://github.com/${REPO}/issues/1#issuecomment-1002` },
  ]);

  const verdictOnly = setup({ profile: { verdictOnlyIssues: [ROOT_REF] } });
  assert.deepEqual(await poll({ github: pollGithub(build(), verdictOnly.profile), profile: verdictOnly.profile, now }), []);
  assert.deepEqual(await poll({ github: pollGithub(build({ state: 'closed' }), profile), profile, now }), []);
  assert.deepEqual(await poll({ github: pollGithub(build({ repo: HANDOFF_REPO }), profile), profile, now }), []);
});

test('tick：outOfScope / passedButOpen 不起轮次，写提醒；同一任务 24 小时内只写一次', async () => {
  const { home, paths } = setup();
  const entries = [
    { issue: ROOT_REF, outOfScope: [OUTSIDE_REPO] },
    { issue: `${REPO}#9`, passedButOpen: true, round: 3, url: 'https://example.invalid/c' },
  ];
  let clockMs = now();
  const started = [];
  const tick = () =>
    runTick({
      home,
      env: { ...process.env },
      run: async () => ({ code: 0, stdout: JSON.stringify(entries), stderr: '' }),
      spawnRound: (issue) => {
        started.push(issue);
        return 1;
      },
      runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
      notify: async () => ({ ok: true }),
      now: () => clockMs,
    });
  const first = await tick();
  assert.equal(first.lastTick.ok, true, first.lastTick.error);
  assert.deepEqual(started, [], '不派发');
  let alerts = readAlerts(paths);
  assert.deepEqual(alerts.map((alert) => [alert.kind, alert.issue]), [
    ['task-out-of-scope', ROOT_REF],
    ['passed-but-open', `${REPO}#9`],
  ]);
  assert.match(alerts[0].detail, /someone-else\/not-in-profile/);
  assert.equal(alerts[1].round, 3);

  clockMs += 60 * 60 * 1000;
  await tick();
  assert.equal(readAlerts(paths).length, 2, '一小时后不重复提醒');

  clockMs += POLL_NOTICE_WINDOW_MS;
  await tick();
  alerts = readAlerts(paths);
  assert.equal(alerts.length, 4, '过了一天再提醒一次');
  assert.deepEqual(started, []);
  assert.deepEqual(remindPollNotices(paths, [{ issue: 'x/y#1', stale: true, outOfScope: ['a/b'] }], { now: () => clockMs }), []);
});

// ---------------------------------------------------------------- 时间格式

test('北京时间：beijingIso 带 +08:00、不带毫秒；trigger 新旧格式都认', () => {
  assert.equal(beijingIso(Date.parse('2026-10-25T11:43:23.456Z')), '2026-10-25T19:43:23+08:00');
  assert.equal(beijingIso(Date.parse('2026-10-24T20:00:00.000Z')), '2026-10-25T04:00:00+08:00');
  assert.equal(Date.parse('2026-10-25T19:43:23+08:00'), Date.parse('2026-10-25T11:43:23.000Z'));

  const body = 'x';
  const task = (finishedAt) => ({
    ref: ROOT_REF,
    kind: 'standalone',
    tier: 'auto',
    bodyVersion: bodyVersion(body),
    children: [],
    linkedPrs: [{ ref: `${REPO}#3`, mergedAt: '2026-10-24T03:00:00Z' }],
    rounds: parseRounds([roundComment({
      round: 1,
      status: '通过',
      bodyVersion: bodyVersion(body),
      finishedAt,
      createdAt: finishedAt,
    })], OWNER),
  });
  const profile = { startAt: '2026-01-01T00:00:00Z' };
  // 北京时间 10:00 = UTC 02:00，PR 03:00 才合并 → 合并在裁决之后，重验。
  assert.equal(shouldTrigger(task('2026-10-24T10:00:00+08:00'), { now, profile }).reason, 'pr-merged-after-verdict');
  // 北京时间 12:00 = UTC 04:00 → 已是最新。旧格式同样。
  assert.equal(shouldTrigger(task('2026-10-24T12:00:00+08:00'), { now, profile }).reason, 'up-to-date');
  assert.equal(shouldTrigger(task('2026-10-24T04:00:00.000Z'), { now, profile }).reason, 'up-to-date');
});

// ---------------------------------------------------------------- 写闸小问题

test('github.mjs：写闸退出码 4 带回 reason 和 files；退出码 1 是「其他失败」（WriteFailedError），不是拒绝', async () => {
  const { profile } = setup();
  let reply = { code: 4, body: { reason: 'secret-found', files: ['src/a.mjs', 'config/b.txt'] } };
  const run = async () => ({ code: reply.code, stdout: JSON.stringify(reply.body), stderr: '' });
  const github = createGithub({ profile: { ...profile, writeCommand: ['gate-client'] }, run, sleep: async () => {} });
  await assert.rejects(
    () => github.write({ type: 'branch.push', repo: REPO, branch: 'acceptance/1-2-sc3', bundlePath: '/x', dedupeKey: 'k' }),
    (error) => {
      assert.ok(error instanceof WriteRejectedError);
      assert.equal(error.reason, 'secret-found');
      assert.deepEqual(error.files, ['src/a.mjs', 'config/b.txt']);
      return true;
    },
  );
  reply = { code: 1, body: { reason: 'write-failed', detail: 'boom' } };
  await assert.rejects(
    () => github.write({ type: 'comment.create', repo: REPO, issue: 1, body: 'x', dedupeKey: 'k2' }),
    (error) => {
      assert.ok(error instanceof WriteFailedError);
      assert.equal(error instanceof WriteRejectedError, false);
      assert.equal(error.exitCode, 1);
      assert.equal(error.reason, 'write-failed');
      return true;
    },
  );
});

test('helper：写闸退出码 1 → helper 退出码 1（不是 4），这一轮尽力标中断写明原因', async () => {
  const { profile } = setup();
  const world = defaultTree();
  const result = await helper(
    createFakeGithub(world, {
      onWrite: (action) => {
        if (action.type === 'project.field.set') throw new WriteFailedError('外发失败', { exitCode: 1, reason: 'write-failed' });
        return undefined;
      },
    }),
    profile,
    ['board', '--issue', ROOT_REF, '--round', '1', '--acceptance', '通过', '--checks', ALL_RAN_CHECKS_FILE],
  );
  assert.equal(result.code, 1);
  const body = rootComment(world).body;
  assert.match(body.split('\n')[0], /第 1 轮：中断/);
  assert.match(body, /原因：写操作失败：write-failed/);
});

test('helper push：写闸扫到密钥时回的文件名记进「需人工处理」，裁决里列出文件名（#46 SC7）', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  const files = ['config/leak.txt'];
  const fakeGit = {
    async branchSha() {
      return { code: 0, stdout: `${'a'.repeat(40)}\n` };
    },
    async git(args) {
      if (args[0] === 'rev-parse') return { code: 0, stdout: `${'b'.repeat(40)}\n` };
      if (args[0] === 'rev-list') return { code: 0, stdout: '' };
      return { code: 0, stdout: '' };
    },
    async has() {
      return false;
    },
    async createBundle({ file }) {
      fs.writeFileSync(file, 'bundle');
      return { code: 0 };
    },
    async bundleHeads() {
      return { code: 0, stdout: `${'a'.repeat(40)} refs/heads/acceptance/1-2-sc3\n` };
    },
  };
  const out = sink();
  const err = sink();
  const code = await runHelper(
    ['push', '--issue', ROOT_REF, '--round', '1', '--repo', REPO, '--branch', 'acceptance/1-2-sc3', '--worktree', home],
    {
      github: createFakeGithub(world, {
        onWrite: (action) => {
          if (action.type === 'branch.push') throw new WriteRejectedError('外发被拒', { exitCode: 4, reason: 'secret-found', files });
          return undefined;
        },
      }),
      profile,
      now,
      stdout: out,
      stderr: err,
      git: fakeGit,
    },
  );
  assert.equal(code, 4, err.text);
  assert.deepEqual(readNeedsHuman(profile, ROOT_REF, 1), [{ reason: 'secret-found', files }]);
  const file = writeJsonFile(home, 'verdict.json', { checks: ALL_RAN, items: fullConclusions() });
  const verdict = await helper(createFakeGithub(world), profile, ['verdict', '--issue', ROOT_REF, '--round', '1', '--file', file]);
  assert.equal(verdict.code, 0, verdict.err);
  const body = rootComment(world).body;
  assert.match(body, /## 需人工处理/);
  assert.match(body, /扫到疑似密钥，没推：config\/leak\.txt/);
});

test('correct 复用搜索找到、还没挂上的修正子 issue：补 subissue.add（经真写闸放行）', async () => {
  const { home, profile } = setup();
  const world = defaultTree();
  const marker = `[验收机] 修正 · 总 ${ROOT_REF} · 项 ${REPO}#2 SC3 · 第 1 轮`;
  world.addIssue({ repo: REPO, number: 30, title: '修正：孤儿', body: ['> 修正子 issue', '', marker].join('\n') });
  const gate = openGate({ home, profile, world, binding: bindingFor(world) });
  await gate.start();
  const github = realGithubThroughGate({ profile, world, gate });
  const result = await helper(github, profile, ['correct', '--issue', ROOT_REF, '--round', '1', '--item', `${REPO}#2 SC3`, '--why', '没过']);
  assert.equal(result.code, 0, result.err);
  assert.equal(JSON.parse(result.out).reused, true);
  const sub = github.gateCalls.find((action) => action.type === 'subissue.add');
  assert.ok(sub, JSON.stringify(github.gateCalls.map((action) => action.type)));
  assert.equal(sub.subIssue, 30);
  assert.ok(world.get(ROOT_REF).subIssues.includes(`${REPO}#30`), '挂上了');
  assert.equal(github.gateCalls.some((action) => action.type === 'issue.create'), false, '不重复开');

  // 已经挂着的就不再补挂。
  const again = await helper(github, profile, ['correct', '--issue', ROOT_REF, '--round', '1', '--item', `${REPO}#2 SC3`, '--why', '没过']);
  assert.equal(again.code, 0, again.err);
  assert.equal(github.gateCalls.filter((action) => action.type === 'subissue.add').length, 1);
});

test('写闸探针：仓外探针回 4 但不写 gate-rejected 提醒（不进 Slack 摘要），只记日志', async () => {
  const { home, profile, paths } = setup();
  const world = defaultTree();
  const lines = [];
  const gate = openGate({ home, profile, world, binding: null, log: (line) => lines.push(line) });
  const outside = await gate.handle({ type: 'probe', probe: true, repo: OUTSIDE_REPO, dedupeKey: 'doctor-probe:1' });
  assert.equal(outside.code, 4);
  assert.equal(outside.body.reason, 'repo-not-allowed');
  const inside = await gate.handle({ type: 'probe', probe: true, dedupeKey: 'doctor-probe:2' });
  assert.equal(inside.code, 0);
  assert.equal(readAlerts(paths).length, 0, JSON.stringify(readAlerts(paths)));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /写闸探针：退出码 4（repo-not-allowed）/);
  assert.equal(fs.existsSync(paths.ledgerFile), false, '探针不记账');

  // 普通动作被拒照旧写提醒。
  const rejected = await gate.handle({ type: 'comment.create', repo: OUTSIDE_REPO, issue: 1, body: 'x', dedupeKey: 'real' });
  assert.equal(rejected.code, 4);
  assert.ok(readAlerts(paths).some((alert) => alert.kind === 'gate-rejected'));
});
