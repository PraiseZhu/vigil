// #47 SC9：写闸 contract 测试。经真的 unix socket 发动作，假 gh（内存里的 issue/评论/看板），不触网。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion } from './bin/rounds.mjs';
import { ROOT_QUERY, SEARCH_QUERY } from './bin/collect.mjs';
import { localEnv, spawnRun } from './bin/localgit.mjs';
import { DEFAULT_HEAD_QUERY, PR_READY_QUERY, createGate, startGateServer } from './host/write-gate.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { run as procRun } from './host/proc.mjs';
import { defaultTree } from './session.fixture.mjs';
import { BYPASS_KINDS, BYPASS_LABELS, buildBypassRepo } from './secret-bypass.fixture.mjs';
import { HANDOFF_REPO, REPO, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const ROOT_REF = `${REPO}#1`;
const HERE_HOST = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host');

// 假私钥头按行拼，源码里不会出现完整的私钥头。
const FAKE_KEY = [
  '-----BEGIN RSA ' + 'PRIVATE KEY-----',
  'MIIEnotARealKeyJustForTests',
  '-----END RSA ' + 'PRIVATE KEY-----',
].join('\n');

function setupEnvironment({ enabled = true } = {}) {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  if (enabled) fs.writeFileSync(paths.enabledFile, '1');
  return { home, profile, paths };
}

const PR_MARKER = `[验收机] 修正 · 总 ${ROOT_REF} · 项 ${REPO}#2 SC1 · 第 1 轮`;

function gateGithub(
  world,
  {
    statusRollup = 'SUCCESS',
    isDraft = true,
    headRefOid = 'f'.repeat(40),
    onWrite,
    headRefName = 'acceptance/1-2-sc1',
    prBody = PR_MARKER,
    defaultHead = null,
    crossRepo = false,
  } = {},
) {
  return {
    queries: [],
    async graphql(query, variables) {
      this.queries.push({ query, variables });
      if (query === DEFAULT_HEAD_QUERY) {
        if (defaultHead instanceof Error) throw defaultHead;
        return { repository: { defaultBranchRef: defaultHead ? { name: 'main', target: { oid: defaultHead } } : null } };
      }
      if (query === PR_READY_QUERY) {
        const run =
          statusRollup == null
            ? []
            : [
                {
                  name: 'test',
                  status: statusRollup === 'PENDING' ? 'IN_PROGRESS' : 'COMPLETED',
                  conclusion: statusRollup === 'PENDING' ? null : statusRollup,
                  databaseId: 1,
                  checkSuite: { workflowRun: { databaseId: 9 } },
                },
              ];
        return {
          repository: {
            pullRequest: {
              number: variables.number,
              isDraft,
              headRefName,
              headRefOid,
              ...(crossRepo === null ? {} : { isCrossRepository: crossRepo }),
              body: prBody,
              commits: {
                nodes: [
                  {
                    commit: {
                      checkSuites: { nodes: [{ status: 'COMPLETED', conclusion: statusRollup, checkRuns: { nodes: run } }] },
                      statusCheckRollup: { contexts: { nodes: [] } },
                    },
                  },
                ],
              },
            },
          },
        };
      }
      return world.graphql({ query, variables });
    },
    async write(action) {
      if (onWrite) {
        const override = await onWrite(action, world);
        if (override !== undefined) return override;
      }
      return world.write(action);
    },
  };
}

function bindingFor(world, { round = 1, root = ROOT_REF } = {}) {
  const issue = world.get(root);
  const comment = issue.comments.find((entry) => entry.body.startsWith(`[验收机] 第 ${round} 轮`));
  return { root, round, commentId: comment.databaseId };
}

async function openGate({ home, profile, github, binding, lockWaitMs = 5000, which, run = procRun } = {}) {
  const gate = createGate({ home, profile, github, run, binding, lockWaitMs, which });
  await gate.start();
  const socketPath = path.join(home, 'gate-test', `gate-${process.pid}-${Math.random().toString(16).slice(2)}.sock`);
  const server = await startGateServer({ gate, socketPath });
  return { gate, server, socketPath };
}

function send(socketPath, action) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.on('connect', () => socket.write(`${JSON.stringify(action)}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('end', () => {
      try {
        resolve(JSON.parse(buffer));
      } catch (error) {
        reject(error);
      }
    });
    socket.on('error', reject);
  });
}

function gateComment({ round = 1, version, body }) {
  return [`[验收机] 第 ${round} 轮：要修`, `正文版本：${version}`, `开始：2026-10-24T01:00:00.000Z`, '', body].join('\n');
}

test('SC9 总开关关着：读、写、探测全部 4 gate-disabled', async () => {
  const { home, profile } = setupEnvironment({ enabled: false });
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  for (const action of [
    { type: 'probe' },
    { type: 'read.graphql', query: SEARCH_QUERY, variables: { q: 'x' } },
    { type: 'comment.create', repo: REPO, issue: 1, body: 'x', dedupeKey: 'a' },
  ]) {
    const outcome = await gate.handle(action);
    assert.equal(outcome.code, 4, JSON.stringify(outcome));
    assert.equal(outcome.body.reason, 'gate-disabled');
  }
  assert.equal(world.writes.length, 0);
});

test('SC9 类型不在白名单（含 pr.merge）→ 4 not-allowed；pr.update-branch / ci.rerun 在验收轮绑定下也不认', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const merge = await gate.handle({ type: 'pr.merge', repo: REPO, pr: 12, dedupeKey: 'm' });
  assert.equal(merge.code, 4);
  assert.equal(merge.body.reason, 'not-allowed');
  const unknown = await gate.handle({ type: 'issue.delete', repo: REPO, issue: 1, dedupeKey: 'd' });
  assert.equal(unknown.body.reason, 'not-allowed');
  for (const type of ['pr.update-branch', 'ci.rerun']) {
    const outcome = await gate.handle({ type, repo: REPO, pr: 12, dedupeKey: type });
    assert.equal(outcome.code, 4, type);
    assert.equal(outcome.body.reason, 'not-allowed', type);
  }
  assert.equal(world.writes.length, 0);
});

test('SC9 读或写配置名单外的仓 → 4 repo-not-allowed；自己写的 GraphQL 文本 → 4 query-not-allowed', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const { server, socketPath } = await openGate({ home, profile, github: gateGithub(world), binding: bindingFor(world), which: async () => false });
  try {
    const outsideWrite = await send(socketPath, {
      type: 'comment.create',
      repo: 'someone-else/not-in-profile',
      issue: 1,
      body: 'x',
      dedupeKey: 'outside-1',
    });
    assert.equal(outsideWrite.code, 4);
    assert.equal(outsideWrite.body.reason, 'repo-not-allowed');

    const outsideRead = await send(socketPath, {
      type: 'read.graphql',
      query: SEARCH_QUERY,
      variables: { owner: 'someone-else', name: 'not-in-profile', q: 'x' },
    });
    assert.equal(outsideRead.body.reason, 'repo-not-allowed');

    const rawGraphql = await send(socketPath, {
      type: 'read.graphql',
      query: 'query { viewer { login } }',
      variables: {},
    });
    assert.equal(rawGraphql.code, 4);
    assert.equal(rawGraphql.body.reason, 'query-not-allowed');

    const freeSearch = await send(socketPath, {
      type: 'read.graphql',
      query: SEARCH_QUERY,
      variables: { q: 'is:issue anything I want' },
    });
    assert.equal(freeSearch.code, 4);

    // 按仓定位的登记查询不带 owner/name：不能当成「不用查名单」放过去。
    const unscoped = await send(socketPath, { type: 'read.graphql', query: ROOT_QUERY, variables: { number: 1 } });
    assert.equal(unscoped.code, 4);
    assert.equal(unscoped.body.reason, 'repo-not-allowed');
    assert.equal(freeSearch.body.reason, 'search-not-allowed');

    const allowedSearch = await send(socketPath, {
      type: 'read.graphql',
      query: SEARCH_QUERY,
      variables: { q: `"[验收机] 修正 · 总 ${ROOT_REF}" in:body is:issue repo:makecindy/cindy` },
    });
    assert.equal(allowedSearch.code, 0, JSON.stringify(allowedSearch));

    const allowedRead = await send(socketPath, {
      type: 'read.graphql',
      query: SEARCH_QUERY,
      variables: { q: `"[验收机] 修正 · 总 ${ROOT_REF}" in:body is:issue` },
    });
    assert.equal(allowedRead.code, 0);
  } finally {
    await server.close();
  }
});

test('SC9 只读在 exec 模式（没绑定轮次）→ 4 needs-round-binding', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, which: async () => false });
  const outcome = await gate.handle({
    type: 'read.graphql',
    query: SEARCH_QUERY,
    variables: { q: `"[验收机] 修正 · 总 ${ROOT_REF}" in:body is:issue` },
  });
  assert.equal(outcome.code, 4);
  assert.equal(outcome.body.reason, 'needs-round-binding');
});

test('SC9 watch 档只允许评论和看板 → 其它类型 4 tier-not-allowed', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  world.addIssue({ repo: HANDOFF_REPO, number: 3, title: '交接', body: '- [ ] SC1 看一下 验证：unit' });
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const rejected = await gate.handle({
    type: 'issue.close',
    repo: HANDOFF_REPO,
    issue: 3,
    dedupeKey: 'watch-close',
  });
  assert.equal(rejected.code, 4);
  assert.equal(rejected.body.reason, 'tier-not-allowed');

  const comment = await gate.handle({
    type: 'comment.create',
    repo: HANDOFF_REPO,
    issue: 3,
    body: `[验收机] 裁决贴在 ${ROOT_REF}`,
    dedupeKey: 'watch-comment',
  });
  // watch 档允许 comment.create，但这个 issue 不在本轮任务树里。
  assert.equal(comment.code, 4);
  assert.equal(comment.body.reason, 'not-in-tree');
  assert.equal(world.writes.length, 0);
});

test('SC9 不是本轮 / 已不是「验收中」→ 4 not-current-round', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const wrongRound = createGate({
    home,
    profile,
    github: gateGithub(world),
    run: procRun,
    binding: { ...bindingFor(world), round: 2 },
    which: async () => false,
  });
  const outcome = await wrongRound.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    body: 'x',
    dedupeKey: 'round-2',
  });
  assert.equal(outcome.code, 4);
  assert.equal(outcome.body.reason, 'not-current-round');
  assert.match(outcome.body.detail, /期望第 2 轮（验收中），实际第 1 轮（验收中）/);

  const finished = defaultTree({ roundStatus: '通过' });
  const stale = createGate({
    home,
    profile,
    github: gateGithub(finished),
    run: procRun,
    binding: bindingFor(finished),
    which: async () => false,
  });
  const afterVerdict = await stale.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    body: 'x',
    dedupeKey: 'round-1-after',
  });
  assert.equal(afterVerdict.code, 4);
  assert.equal(afterVerdict.body.reason, 'not-current-round');
  assert.equal(finished.writes.length, 0);
});

test('SC9 目标不在本轮任务树 → 4 not-in-tree', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  world.addIssue({ repo: REPO, number: 9, title: '树外', body: '- [ ] SC1 树外 验证：unit' });
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const outcome = await gate.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 9,
    body: 'x',
    dedupeKey: 'outside-tree',
  });
  assert.equal(outcome.code, 4);
  assert.equal(outcome.body.reason, 'not-in-tree');
  assert.equal(world.writes.length, 0);
});

test('SC9 修正 issue / 挂子 issue / 看板：标记不对、挂错总 issue、看板不是配置那块 → 4；对的放行', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const marker = (root) => `[验收机] 修正 · 总 ${root} · 项 ${REPO}#2 SC1 · 第 1 轮`;

  const noMarker = await gate.handle({ type: 'issue.create', repo: REPO, title: '修', body: '没标记', dedupeKey: 'c-1' });
  assert.equal(noMarker.code, 4);
  assert.equal(noMarker.body.reason, 'not-in-tree');
  const otherRoot = await gate.handle({
    type: 'issue.create',
    repo: REPO,
    title: '修',
    body: marker(`${REPO}#9`),
    dedupeKey: 'c-2',
  });
  assert.equal(otherRoot.code, 4);
  assert.equal(otherRoot.body.reason, 'not-in-tree');
  assert.equal(world.writes.length, 0);

  const created = await gate.handle({ type: 'issue.create', repo: REPO, title: '修', body: marker(ROOT_REF), dedupeKey: 'c-3' });
  assert.equal(created.code, 0);
  const newNumber = created.body.issue;

  const wrongParent = await gate.handle({
    type: 'subissue.add',
    repo: REPO,
    issue: 2,
    subRepo: REPO,
    subIssue: newNumber,
    dedupeKey: 's-1',
  });
  assert.equal(wrongParent.code, 4);
  assert.equal(wrongParent.body.reason, 'not-in-tree');
  const attached = await gate.handle({
    type: 'subissue.add',
    repo: REPO,
    issue: 1,
    subRepo: REPO,
    subIssue: newNumber,
    dedupeKey: 's-2',
  });
  assert.equal(attached.code, 0);

  const otherProject = await gate.handle({
    type: 'project.field.set',
    repo: REPO,
    issue: 2,
    projectNumber: profile.projectNumber + 1,
    fields: { Status: 'Done' },
    dedupeKey: 'p-1',
  });
  assert.equal(otherProject.code, 4);
  assert.equal(otherProject.body.reason, 'project-not-allowed');
  const otherOwner = await gate.handle({
    type: 'project.field.set',
    repo: REPO,
    issue: 2,
    ownerLogin: 'someone-else',
    fields: { Status: 'Done' },
    dedupeKey: 'p-2',
  });
  assert.equal(otherOwner.code, 4);
  assert.equal(otherOwner.body.reason, 'project-not-allowed');
  const ownProject = await gate.handle({
    type: 'project.field.set',
    repo: REPO,
    issue: 2,
    projectNumber: profile.projectNumber,
    fields: { Status: 'Done' },
    dedupeKey: 'p-3',
  });
  assert.equal(ownProject.code, 0);
});

test('SC9 静态：写闸放行的类型里没有 pr.merge', async () => {
  const source = fs.readFileSync(path.join(HERE_HOST, 'write-gate.mjs'), 'utf8');
  assert.doesNotMatch(source, /pr\.merge/);
});

test('SC9 裁决评论的正文版本不对 → 4 body-version-mismatch；版本对 → 放行', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const binding = bindingFor(world);
  const { server, socketPath } = await openGate({ home, profile, github: gateGithub(world), binding, which: async () => false });
  try {
    const wrong = await send(socketPath, {
      type: 'comment.update',
      repo: REPO,
      issue: 1,
      commentId: binding.commentId,
      dedupeKey: 'verdict-wrong',
      body: gateComment({ version: 'sha256:0000000000000000000000000000000000000000000000000000000000000000' }),
    });
    assert.equal(wrong.code, 4);
    assert.equal(wrong.body.reason, 'body-version-mismatch');

    const otherComment = await send(socketPath, {
      type: 'comment.update',
      repo: REPO,
      issue: 1,
      commentId: 987654,
      dedupeKey: 'verdict-other-comment',
      body: gateComment({ version: bodyVersion(world.get(ROOT_REF).body) }),
    });
    assert.equal(otherComment.code, 4);
    assert.equal(otherComment.body.reason, 'not-in-tree');

    const good = await send(socketPath, {
      type: 'comment.update',
      repo: REPO,
      issue: 1,
      commentId: binding.commentId,
      dedupeKey: 'verdict-good',
      body: gateComment({ version: bodyVersion(world.get(ROOT_REF).body) }),
    });
    assert.equal(good.code, 0, JSON.stringify(good));
    assert.equal(good.body.commentId, binding.commentId);
  } finally {
    await server.close();
  }
});

test('SC9 执行锁被占 → 75 busy，什么都没执行', async () => {
  const { home, profile, paths } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({
    home,
    profile,
    github: gateGithub(world),
    run: procRun,
    binding: bindingFor(world),
    lockWaitMs: 80,
    which: async () => false,
  });
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.execLock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const outcome = await gate.handle({ type: 'comment.create', repo: REPO, issue: 1, body: 'x', dedupeKey: 'busy-1' });
  assert.equal(outcome.code, 75);
  assert.equal(outcome.body.reason, 'busy');
  assert.equal(world.writes.length, 0);
  fs.rmSync(paths.execLock, { force: true });
});

test('SC9 账本损坏 → 1 ledger-corrupt', async () => {
  const { home, profile, paths } = setupEnvironment();
  const world = defaultTree();
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.ledgerFile, 'not-json\n');
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const outcome = await gate.handle({ type: 'comment.create', repo: REPO, issue: 1, body: 'x', dedupeKey: 'after-corrupt' });
  assert.equal(outcome.code, 1);
  assert.equal(outcome.body.reason, 'ledger-corrupt');
  assert.equal(world.writes.length, 0);
});

test('SC9 同一 dedupeKey 交两次：只执行一次，结果一样', async () => {
  const { home, profile, paths } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const action = { type: 'comment.create', repo: ROOT_REF.split('#')[0], issue: 1, body: '进度', dedupeKey: 'same-key' };
  const first = await gate.handle(action);
  const second = await gate.handle(action);
  assert.equal(first.code, 0);
  assert.deepEqual(second, first);
  assert.equal(world.writes.filter((entry) => entry.type === 'comment.create').length, 1);
  const ledger = fs
    .readFileSync(paths.ledgerFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].dedupeKey, 'same-key');
});

test('SC9 缺 dedupeKey 的写动作 → 4 missing-dedupe-key', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const outcome = await gate.handle({ type: 'comment.create', repo: REPO, issue: 1, body: 'x' });
  assert.equal(outcome.code, 4);
  assert.equal(outcome.body.reason, 'missing-dedupe-key');
});

test('SC8 pr.ready 检查没绿 / head 变了 / 不是 Draft → 4 ready-precondition；全绿 → 放行', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const headSha = 'f'.repeat(40);
  for (const [state, expected] of [
    ['FAILURE', 4],
    ['PENDING', 4],
    [null, 4],
    ['SUCCESS', 0],
    ['NEUTRAL', 0],
  ]) {
    const gate = createGate({
      home,
      profile,
      github: gateGithub(world, {
        statusRollup: state,
        onWrite: (action) => (action.type === 'pr.ready' ? { pr: action.pr, repo: action.repo } : undefined),
      }),
      run: procRun,
      binding: bindingFor(world),
      which: async () => false,
    });
    const outcome = await gate.handle({
      type: 'pr.ready',
      repo: REPO,
      pr: 12,
      headSha,
      dedupeKey: `ready-${state ?? 'null'}`,
    });
    assert.equal(outcome.code, expected, `${state}: ${JSON.stringify(outcome)}`);
    if (expected === 4) assert.equal(outcome.body.reason, 'ready-precondition');
  }

  const notDraft = createGate({
    home,
    profile,
    github: gateGithub(world, {
      isDraft: false,
      onWrite: (action) => (action.type === 'pr.ready' ? { pr: action.pr, repo: action.repo } : undefined),
    }),
    run: procRun,
    binding: bindingFor(world),
    which: async () => false,
  });
  const notDraftOutcome = await notDraft.handle({ type: 'pr.ready', repo: REPO, pr: 12, headSha, dedupeKey: 'ready-not-draft' });
  assert.equal(notDraftOutcome.body.reason, 'ready-precondition');

  const moved = createGate({
    home,
    profile,
    github: gateGithub(world, {
      headRefOid: 'a'.repeat(40),
      onWrite: (action) => (action.type === 'pr.ready' ? { pr: action.pr, repo: action.repo } : undefined),
    }),
    run: procRun,
    binding: bindingFor(world),
    which: async () => false,
  });
  const movedOutcome = await moved.handle({ type: 'pr.ready', repo: REPO, pr: 12, headSha, dedupeKey: 'ready-moved' });
  assert.equal(movedOutcome.body.reason, 'ready-precondition');
  assert.match(movedOutcome.body.detail, /head 已变化/);
});

test('SC9 分支名不合规（总 issue 号不对）→ 4 not-in-tree', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const outcome = await gate.handle({
    type: 'branch.push',
    repo: REPO,
    branch: 'acceptance/42-2-sc3',
    bundlePath: '/tmp/does-not-matter.bundle',
    dedupeKey: 'bad-branch',
  });
  assert.equal(outcome.code, 4);
  assert.equal(outcome.body.reason, 'not-in-tree');
});

test('SC9 exec 模式：本轮认领可写，乱发的评论一律 4 needs-round-binding', async () => {
  const { home, profile } = setupEnvironment();
  const busyWorld = defaultTree();
  const busyGate = createGate({ home, profile, github: gateGithub(busyWorld), run: procRun, which: async () => false });
  const busy = await busyGate.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    dedupeKey: 'claim-while-busy',
    body: [`[验收机] 第 2 轮：验收中`, `正文版本：${bodyVersion(busyWorld.get(ROOT_REF).body)}`].join('\n'),
  });
  assert.equal(busy.code, 4, '上一轮还在验收中，不能认领新一轮');
  assert.equal(busy.body.reason, 'round-in-progress');
  assert.equal(busyWorld.writes.length, 0);

  const world = defaultTree({ roundStatus: '要修' });
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, which: async () => false });
  const version = bodyVersion(world.get(ROOT_REF).body);

  const skippedEarly = await gate.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    dedupeKey: 'claim-3-early',
    body: [`[验收机] 第 3 轮：验收中`, `正文版本：${version}`].join('\n'),
  });
  assert.equal(skippedEarly.code, 4, '跳号认领');
  assert.equal(skippedEarly.body.reason, 'needs-round-binding');

  const claim = await gate.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    dedupeKey: 'claim-2',
    body: [`[验收机] 第 2 轮：验收中`, `正文版本：${version}`, '开始：2026-10-24T02:00:00.000Z'].join('\n'),
  });
  assert.equal(claim.code, 0, JSON.stringify(claim));
  assert.ok(claim.body.commentId);

  const random = createGate({ home, profile, github: gateGithub(world), run: procRun, which: async () => false });
  const skipped = await random.handle({
    type: 'comment.create',
    repo: REPO,
    issue: 1,
    dedupeKey: 'claim-4',
    body: [`[验收机] 第 4 轮：验收中`, `正文版本：${version}`].join('\n'),
  });
  assert.equal(skipped.code, 4);
  assert.equal(skipped.body.reason, 'round-in-progress');

  const strayUpdate = await random.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 1,
    commentId: 424242,
    dedupeKey: 'stray-update',
    body: '[验收机] 第 1 轮：中断',
  });
  assert.equal(strayUpdate.code, 4);
  assert.equal(strayUpdate.body.reason, 'needs-round-binding');

  const strayCreate = await random.handle({
    type: 'issue.close',
    repo: REPO,
    issue: 1,
    dedupeKey: 'stray-close',
  });
  assert.equal(strayCreate.code, 4);
  assert.equal(strayCreate.body.reason, 'needs-round-binding');
});

test('SC9 exec 模式：最新一轮「验收中」可以标中断', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, which: async () => false });
  const commentId = bindingFor(world).commentId;
  const aborted = await gate.handle({
    type: 'comment.update',
    repo: REPO,
    issue: 1,
    commentId,
    dedupeKey: 'abort-1',
    body: ['[验收机] 第 1 轮：中断', '正文版本：sha256:x', '完成：2026-10-24T03:00:00.000Z', '原因：写闸忙'].join('\n'),
  });
  assert.equal(aborted.code, 0, JSON.stringify(aborted));
  assert.match(world.get(ROOT_REF).comments.at(-1).body, /第 1 轮：中断/);
});

test('SC9 bundle 里有假私钥头 → 4 secret-found，只列文件名，假 git 没收到推送', async () => {
  const { home, profile, paths } = setupEnvironment();
  const world = defaultTree();

  const repoDir = fs.mkdtempSync(path.join(tmpDir(), 'acceptance-gate-repo-'));
  const gitRun = async (args, cwd = repoDir) => {
    const result = await spawnRun('git', args, { cwd, env: localEnv() });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
    return result.stdout;
  };
  await gitRun(['init', '-q', '-b', 'main']);
  await gitRun(['config', 'user.name', 'ExampleUser']);
  await gitRun(['config', 'user.email', 'example@example.test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'base\n');
  await gitRun(['add', 'README.md']);
  await gitRun(['commit', '-q', '-m', 'base']);
  const branch = 'acceptance/1-2-sc3';
  await gitRun(['checkout', '-q', '-b', branch]);
  fs.mkdirSync(path.join(repoDir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'config', 'leak.txt'), `${FAKE_KEY}\n`);
  await gitRun(['add', 'config/leak.txt']);
  await gitRun(['commit', '-q', '-m', 'leak']);
  const bundlePath = path.join(repoDir, 'push.bundle');
  await gitRun(['bundle', 'create', bundlePath, branch]);

  const scripts = [];
  const recordingRun = (cmd, args, options) => {
    scripts.push({ cmd, args });
    return procRun(cmd, args, options);
  };
  const gate = createGate({
    home,
    profile,
    github: gateGithub(world),
    run: recordingRun,
    binding: bindingFor(world),
    which: async () => false,
  });
  const outcome = await gate.handle({
    type: 'branch.push',
    repo: REPO,
    branch,
    bundlePath,
    dedupeKey: `push:${branch}`,
  });
  assert.equal(outcome.code, 4, JSON.stringify(outcome));
  assert.equal(outcome.body.reason, 'secret-found');
  assert.deepEqual(outcome.body.files, ['config/leak.txt']);
  assert.equal(JSON.stringify(outcome.body).includes('PRIVATE'), false, '不回显密钥内容');
  assert.equal(JSON.stringify(outcome.body).includes('MIIEnotARealKey'), false);

  assert.equal(world.writes.length, 0, '写闸没执行 branch.push');
  assert.equal(
    scripts.some((call) => call.cmd === 'git' && call.args.includes('push')),
    false,
    '假 git 没收到推送',
  );
  const alerts = readAlerts(paths);
  assert.ok(alerts.some((entry) => entry.kind === 'secret-found'), JSON.stringify(alerts));
});

test('SC9 干净 bundle → branch.push 交给 github.write 执行并记账', async () => {
  const { home, profile, paths } = setupEnvironment();
  const world = defaultTree();
  const repoDir = fs.mkdtempSync(path.join(tmpDir(), 'acceptance-gate-clean-'));
  const gitRun = async (args, cwd = repoDir) => {
    const result = await spawnRun('git', args, { cwd, env: localEnv() });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
    return result.stdout;
  };
  await gitRun(['init', '-q', '-b', 'main']);
  await gitRun(['config', 'user.name', 'ExampleUser']);
  await gitRun(['config', 'user.email', 'example@example.test']);
  fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'export const ok = 1;\n');
  await gitRun(['add', 'app.mjs']);
  await gitRun(['commit', '-q', '-m', 'ok']);
  const branch = 'acceptance/1-2-sc3';
  await gitRun(['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repoDir, 'more.mjs'), 'export const ok = 2;\n');
  await gitRun(['add', 'more.mjs']);
  await gitRun(['commit', '-q', '-m', 'more']);
  const bundlePath = path.join(repoDir, 'push.bundle');
  await gitRun(['bundle', 'create', bundlePath, branch]);

  const gate = createGate({
    home,
    profile,
    github: gateGithub(world),
    run: (cmd, args, options) => procRun(cmd, args, options),
    binding: bindingFor(world),
    which: async () => false,
  });
  const outcome = await gate.handle({ type: 'branch.push', repo: REPO, branch, bundlePath, dedupeKey: 'push-clean' });
  assert.equal(outcome.code, 0, JSON.stringify(outcome));
  assert.equal(world.writes.filter((entry) => entry.type === 'branch.push').length, 1);
  assert.ok(fs.readFileSync(paths.ledgerFile, 'utf8').includes('push-clean'));
});

test('SC9 serve 用真的 unix socket 且权限 600；请求串行（两条动作不会交错）', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const { server, socketPath } = await openGate({ home, profile, github: gateGithub(world), binding: bindingFor(world), which: async () => false });
  try {
    const stat = fs.statSync(socketPath);
    assert.equal(stat.mode & 0o777, 0o600);
    const [a, b] = await Promise.all([
      send(socketPath, { type: 'comment.create', repo: REPO, issue: 1, body: '甲', dedupeKey: 'serial-a' }),
      send(socketPath, { type: 'comment.create', repo: REPO, issue: 1, body: '乙', dedupeKey: 'serial-b' }),
    ]);
    assert.equal(a.code, 0, JSON.stringify(a));
    assert.equal(b.code, 0, JSON.stringify(b));
    const bodies = world.get(ROOT_REF).comments.map((entry) => entry.body);
    assert.ok(bodies.includes('甲'));
    assert.ok(bodies.includes('乙'));
  } finally {
    await server.close();
  }
});

function runNode(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('SC11 沙箱的 writeCommand（gate-client）：动作 JSON 进、结果 JSON 出，退出码照抄写闸', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const { server, socketPath } = await openGate({ home, profile, github: gateGithub(world), binding: bindingFor(world), which: async () => false });
  const client = path.join(HERE_HOST, 'gate-client.mjs');
  try {
    const ok = await runNode([client, '--socket', socketPath], {
      input: JSON.stringify({ type: 'comment.create', repo: REPO, issue: 1, body: '经 gate-client', dedupeKey: 'client-1' }),
    });
    assert.equal(ok.code, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout);
    assert.ok(parsed.commentId, JSON.stringify(parsed));

    const rejected = await runNode([client, '--socket', socketPath], {
      input: JSON.stringify({ type: 'pr.merge', repo: REPO, pr: 12, dedupeKey: 'client-2' }),
    });
    assert.equal(rejected.code, 4, rejected.stderr);
    assert.equal(JSON.parse(rejected.stdout).reason, 'not-allowed');

    const noSocket = await runNode([client], { input: '{}' });
    assert.equal(noSocket.code, 1);
    assert.match(noSocket.stderr, /--socket/);
  } finally {
    await server.close();
  }
});

test('SC11 沙箱的 gh：只放行 gh api graphql --input -，其余一律拒绝', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const { server, socketPath } = await openGate({ home, profile, github: gateGithub(world), binding: bindingFor(world), which: async () => false });
  const gh = path.join(HERE_HOST, 'sandbox-bin', 'gh');
  try {
    const read = await runNode([gh, 'api', 'graphql', '--input', '-'], {
      env: { ACCEPTANCE_GATE_SOCKET: socketPath, GH_TOKEN: 'sandbox-should-not-use-this' },
      input: JSON.stringify({ query: ROOT_QUERY, variables: { owner: REPO.split('/')[0], name: REPO.split('/')[1], number: 1 } }),
    });
    assert.equal(read.code, 0, read.stderr);
    const parsed = JSON.parse(read.stdout);
    assert.ok(parsed.data?.repository?.issue, JSON.stringify(parsed).slice(0, 200));

    for (const args of [['pr', 'list'], ['api', 'repos/' + REPO], ['issue', 'create']]) {
      const refused = await runNode([gh, ...args], { env: { ACCEPTANCE_GATE_SOCKET: socketPath } });
      assert.equal(refused.code, 1, args.join(' '));
      assert.match(refused.stderr, /沙箱里只允许经写闸读/);
    }

    const noSocket = await runNode([gh, 'api', 'graphql', '--input', '-'], { input: '{}' });
    assert.equal(noSocket.code, 1);
    assert.match(noSocket.stderr, /沙箱里只允许经写闸读/);
  } finally {
    await server.close();
  }
});

test('SC9 branch.push 推的是写闸扫过的那份副本：扫完后原 bundle 被换掉也推不出去', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const repoDir = fs.mkdtempSync(path.join(tmpDir(), 'acceptance-gate-swap-'));
  const gitRun = async (args) => {
    const result = await spawnRun('git', args, { cwd: repoDir, env: localEnv() });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
    return result.stdout;
  };
  await gitRun(['init', '-q', '-b', 'main']);
  await gitRun(['config', 'user.name', 'ExampleUser']);
  await gitRun(['config', 'user.email', 'example@example.test']);
  const branch = 'acceptance/1-2-sc3';
  await gitRun(['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'export const ok = 1;\n');
  await gitRun(['add', 'app.mjs']);
  await gitRun(['commit', '-q', '-m', 'ok']);
  const bundlePath = path.join(repoDir, 'push.bundle');
  await gitRun(['bundle', 'create', bundlePath, branch]);
  const scanned = fs.readFileSync(bundlePath);

  // 模拟沙箱：写闸扫完补丁之后、推送之前，把原 bundle 换成别的内容。
  const swappingRun = async (cmd, args, options) => {
    const result = await procRun(cmd, args, options);
    if (cmd === 'git' && args.includes('cat-file')) fs.writeFileSync(bundlePath, 'swapped-after-scan');
    return result;
  };
  let pushedBytes = null;
  let pushedPath = null;
  const github = gateGithub(world, {
    onWrite: async (action) => {
      if (action.type !== 'branch.push') return undefined;
      pushedPath = action.bundlePath;
      pushedBytes = fs.readFileSync(action.bundlePath);
      return { pushed: true };
    },
  });
  const gate = createGate({ home, profile, github, run: swappingRun, binding: bindingFor(world), which: async () => false });
  const outcome = await gate.handle({ type: 'branch.push', repo: REPO, branch, bundlePath, dedupeKey: 'push-swap' });
  assert.equal(outcome.code, 0, JSON.stringify(outcome));
  assert.notEqual(pushedPath, bundlePath, '推送用写闸自己的副本，不用沙箱给的路径');
  assert.ok(pushedBytes && pushedBytes.equals(scanned), '推出去的就是扫过的那份');
  assert.equal(fs.existsSync(pushedPath), false, '副本用完就删');
});

test('SC9 branch.push 有 gitleaks 时只扫 bundle 里该分支的提交（--log-opts=<提交>）', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const repoDir = fs.mkdtempSync(path.join(tmpDir(), 'acceptance-gate-leaks-'));
  const gitRun = async (args) => {
    const result = await spawnRun('git', args, { cwd: repoDir, env: localEnv() });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
    return result.stdout;
  };
  await gitRun(['init', '-q', '-b', 'main']);
  await gitRun(['config', 'user.name', 'ExampleUser']);
  await gitRun(['config', 'user.email', 'example@example.test']);
  const branch = 'acceptance/1-2-sc3';
  await gitRun(['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repoDir, 'app.mjs'), 'export const ok = 1;\n');
  await gitRun(['add', 'app.mjs']);
  await gitRun(['commit', '-q', '-m', 'ok']);
  const head = (await gitRun(['rev-parse', 'HEAD'])).trim();
  const bundlePath = path.join(repoDir, 'push.bundle');
  await gitRun(['bundle', 'create', bundlePath, branch]);
  let leaksArgs = null;
  const run = async (cmd, args, options) => {
    if (cmd === 'gitleaks') {
      leaksArgs = args;
      return { code: 1, stdout: '', stderr: '' };
    }
    return procRun(cmd, args, options);
  };
  const gate = createGate({ home, profile, github: gateGithub(world), run, binding: bindingFor(world), which: async () => true });
  const outcome = await gate.handle({ type: 'branch.push', repo: REPO, branch, bundlePath, dedupeKey: 'push-leaks' });
  assert.equal(outcome.code, 4);
  assert.equal(outcome.body.reason, 'secret-found');
  assert.ok(leaksArgs.includes(`--log-opts=${head}`), JSON.stringify(leaksArgs));
  assert.equal(world.writes.filter((entry) => entry.type === 'branch.push').length, 0);
});

/** 建一个仓：main 上一个提交（可选带假私钥），分支上再一个提交（可选带假私钥），打成 bundle。 */
async function buildBundleRepo({ leakOnMain = false, leakOnBranch = false } = {}) {
  const repoDir = fs.mkdtempSync(path.join(tmpDir(), 'acceptance-gate-base-'));
  const gitRun = async (args) => {
    const result = await spawnRun('git', args, { cwd: repoDir, env: localEnv() });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
    return result.stdout;
  };
  await gitRun(['init', '-q', '-b', 'main']);
  await gitRun(['config', 'user.name', 'ExampleUser']);
  await gitRun(['config', 'user.email', 'example@example.test']);
  fs.writeFileSync(path.join(repoDir, 'main.txt'), leakOnMain ? `${FAKE_KEY}\n` : 'main\n');
  await gitRun(['add', 'main.txt']);
  await gitRun(['commit', '-q', '-m', 'main']);
  const mainSha = (await gitRun(['rev-parse', 'HEAD'])).trim();
  const branch = 'acceptance/1-2-sc3';
  await gitRun(['checkout', '-q', '-b', branch]);
  fs.writeFileSync(path.join(repoDir, 'branch.txt'), leakOnBranch ? `${FAKE_KEY}\n` : 'fix\n');
  await gitRun(['add', 'branch.txt']);
  await gitRun(['commit', '-q', '-m', 'fix']);
  const tip = (await gitRun(['rev-parse', 'HEAD'])).trim();
  const bundlePath = path.join(repoDir, 'push.bundle');
  await gitRun(['bundle', 'create', bundlePath, branch]);
  return { repoDir, branch, bundlePath, mainSha, tip };
}

test('SC9 branch.push 不信沙箱交来的 base：base=分支头、base=--output=…、base 不是祖先，都照样扫出密钥', async () => {
  const { home, profile } = setupEnvironment();
  const { repoDir, branch, bundlePath, tip } = await buildBundleRepo({ leakOnBranch: true });
  const outputProbe = path.join(repoDir, 'gate-output-probe.txt');
  for (const [label, base] of [
    ['分支头', tip],
    ['选项注入', `--output=${outputProbe}`],
    ['不是祖先', 'f'.repeat(40)],
  ]) {
    for (const hasGitleaks of [false, true]) {
      const world = defaultTree();
      const calls = [];
      const run = async (cmd, args, options) => {
        calls.push({ cmd, args });
        if (cmd === 'gitleaks') {
          // 假 gitleaks：只要扫的范围里有分支提交就报密钥。
          const range = args.find((arg) => arg.startsWith('--log-opts=')).slice('--log-opts='.length);
          return { code: range.endsWith(tip) && !range.startsWith(`${tip}..`) ? 1 : 0, stdout: '', stderr: '' };
        }
        return procRun(cmd, args, options);
      };
      const gate = createGate({
        home,
        profile,
        github: gateGithub(world),
        run,
        binding: bindingFor(world),
        which: async () => hasGitleaks,
      });
      const outcome = await gate.handle({
        type: 'branch.push',
        repo: REPO,
        branch,
        base,
        bundlePath,
        dedupeKey: `push-base-${label}-${hasGitleaks}`,
      });
      assert.equal(outcome.code, 4, `${label}/${hasGitleaks}: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.body.reason, 'secret-found', `${label}/${hasGitleaks}`);
      assert.equal(world.writes.length, 0, `${label}/${hasGitleaks}：没推送`);
      assert.equal(fs.existsSync(outputProbe), false, `${label}/${hasGitleaks}：base 不能当成 git 选项`);
      assert.equal(
        base !== tip && calls.some((call) => call.args.some((arg) => String(arg).includes(String(base)))),
        false,
        `${label}/${hasGitleaks}：沙箱交来的 base 不进任何命令`,
      );
    }
  }
});

test('SC9 branch.push 的基准由写闸自己读默认分支头：在 bundle 里就只扫新提交，读不到或不在 bundle 里就扫全部历史', async () => {
  const { home, profile } = setupEnvironment();
  // main 历史里有假私钥、分支新提交干净：默认分支头在 bundle 里 → 只扫新提交 → 放行。
  const old = await buildBundleRepo({ leakOnMain: true });
  const gitArgs = [];
  const recordingRun = (cmd, args, options) => {
    gitArgs.push(...args.map(String));
    return procRun(cmd, args, options);
  };
  const pushOf = (repo, world, defaultHead, key) => {
    const gate = createGate({
      home,
      profile,
      github: gateGithub(world, { defaultHead }),
      run: recordingRun,
      binding: bindingFor(world),
      which: async () => false,
    });
    return gate.handle({ type: 'branch.push', repo: REPO, branch: repo.branch, bundlePath: repo.bundlePath, dedupeKey: key });
  };
  let world = defaultTree();
  const clean = await pushOf(old, world, old.mainSha, 'push-head-in-bundle');
  assert.equal(clean.code, 0, JSON.stringify(clean));
  assert.equal(world.writes.filter((entry) => entry.type === 'branch.push').length, 1);

  for (const [label, head] of [
    ['读不到', null],
    ['查询出错', new Error('网络不通')],
    ['不在 bundle 里', 'e'.repeat(40)],
    ['不是提交号', `--output=${path.join(old.repoDir, 'x')}`],
  ]) {
    world = defaultTree();
    const outcome = await pushOf(old, world, head, `push-head-${label}`);
    assert.equal(outcome.code, 4, `${label}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.body.reason, 'secret-found', label);
    assert.deepEqual(outcome.body.files, ['main.txt'], label);
    assert.equal(world.writes.length, 0, label);
  }
  assert.equal(gitArgs.some((arg) => arg.includes('--output')), false, '读回来的默认分支头不是提交号，就不进任何 git 命令');

  // 新提交里有假私钥：默认分支头在 bundle 里也照样扫出来。
  const fresh = await buildBundleRepo({ leakOnBranch: true });
  world = defaultTree();
  const leak = await pushOf(fresh, world, fresh.mainSha, 'push-head-new-leak');
  assert.equal(leak.code, 4);
  assert.deepEqual(leak.body.files, ['branch.txt']);
});

test('SC9 pr.ready 只认本轮任务树里的修正 PR：head 分支和修正标记都要对上', async () => {
  const { home, profile } = setupEnvironment();
  for (const [label, options] of [
    ['无关分支', { headRefName: 'feature/unrelated' }],
    ['别的总 issue 的分支', { headRefName: 'acceptance/999-2-sc1' }],
    ['正文没标记', { prBody: '随便一个 PR' }],
    ['标记是别的总 issue', { prBody: `[验收机] 修正 · 总 ${REPO}#999 · 项 ${REPO}#2 SC1 · 第 1 轮` }],
  ]) {
    const world = defaultTree();
    const gate = createGate({
      home,
      profile,
      github: gateGithub(world, options),
      run: procRun,
      binding: bindingFor(world),
      which: async () => false,
    });
    const outcome = await gate.handle({ type: 'pr.ready', repo: REPO, pr: 999, dedupeKey: `ready-tree-${label}` });
    assert.equal(outcome.code, 4, `${label}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.body.reason, 'not-in-tree', label);
    assert.equal(world.writes.length, 0, label);
  }
});

test('SC9 serve 模式不许另发轮次评论；issue.edit 只能勾选验收项', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  for (const body of ['[验收机] 第 1 轮：通过', '[验收机] 第 9 轮：验收中', '  [验收机]  第 2 轮：要修']) {
    const outcome = await gate.handle({ type: 'comment.create', repo: REPO, issue: 2, body, dedupeKey: `fake-round-${body}` });
    assert.equal(outcome.code, 4, body);
    assert.equal(outcome.body.reason, 'round-comment-forbidden', body);
  }
  const plain = await gate.handle({ type: 'comment.create', repo: REPO, issue: 2, body: '进度：在跑测试', dedupeKey: 'plain-comment' });
  assert.equal(plain.code, 0, JSON.stringify(plain));

  const childBody = world.get(`${REPO}#2`).body;
  const toggled = childBody.replace('- [ ]', '- [x]');
  assert.notEqual(toggled, childBody, '夹具要有可勾的验收项');
  for (const [label, body] of [
    ['整段重写', '- [x] SC1 全部通过'],
    ['勾选同时改字', toggled.replace(/(- \[x\][^\n]*)/, '$1 改过')],
    ['加一行', `${toggled}\n- [x] SC9 新加的`],
    ['不是字符串', undefined],
  ]) {
    const outcome = await gate.handle({ type: 'issue.edit', repo: REPO, issue: 2, body, dedupeKey: `edit-${label}` });
    assert.equal(outcome.code, 4, label);
    assert.equal(outcome.body.reason, 'edit-not-allowed', label);
  }
  assert.equal(world.get(`${REPO}#2`).body, childBody, '被拒的编辑没写进去');
  const ok = await gate.handle({ type: 'issue.edit', repo: REPO, issue: 2, body: toggled, dedupeKey: 'edit-toggle' });
  assert.equal(ok.code, 0, JSON.stringify(ok));
  assert.equal(world.get(`${REPO}#2`).body, toggled);
});

test('SC9 账本查重在仓范围之后：名单外的仓拿账本里已有的 key 也照样 4', async () => {
  const { home, profile, paths } = setupEnvironment();
  const world = defaultTree();
  fs.mkdirSync(path.dirname(paths.ledgerFile), { recursive: true });
  fs.writeFileSync(
    paths.ledgerFile,
    `${JSON.stringify({ dedupeKey: 'shared-key', type: 'comment.create', result: { commentId: 1 } })}\n`,
  );
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const outside = await gate.handle({ type: 'comment.create', repo: 'stranger/elsewhere', issue: 1, body: 'x', dedupeKey: 'shared-key' });
  assert.equal(outside.code, 4);
  assert.equal(outside.body.reason, 'repo-not-allowed');
});

test('SC9 写闸只认 ownerLogin 发的轮次评论：别人伪造的「第 2 轮：验收中」不算当前轮次', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
  world.addComment(ROOT_REF, {
    body: [`[验收机] 第 2 轮：验收中`, `正文版本：${bodyVersion(world.get(ROOT_REF).body)}`].join('\n'),
    author: { login: 'someone-else' },
  });
  // 绑定第 1 轮：伪造的第 2 轮不算，写操作照常放行。
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, binding: bindingFor(world), which: async () => false });
  const ok = await gate.handle({ type: 'comment.create', repo: REPO, issue: 2, body: '进度', dedupeKey: 'owner-only-ok' });
  assert.equal(ok.code, 0, JSON.stringify(ok));
  // 冒充第 2 轮绑定：不是我发的，4 not-current-round。
  const forged = world.get(ROOT_REF).comments.at(-1);
  const forgedGate = createGate({
    home,
    profile,
    github: gateGithub(world),
    run: procRun,
    binding: { root: ROOT_REF, round: 2, commentId: forged.databaseId },
    which: async () => false,
  });
  const denied = await forgedGate.handle({ type: 'comment.create', repo: REPO, issue: 2, body: '进度', dedupeKey: 'owner-only-denied' });
  assert.equal(denied.code, 4);
  assert.equal(denied.body.reason, 'not-current-round');
});

for (const kind of Object.keys(BYPASS_KINDS)) {
  test(`SC9 branch.push 内置扫描绕过拦得住：${BYPASS_LABELS[kind]}`, async () => {
    const { home, profile } = setupEnvironment();
    const repo = await buildBypassRepo(kind);
    // 默认分支头在 bundle 里（只扫新提交）和读不到（扫全部历史）两种都要拦住。
    for (const defaultHead of [repo.mainSha, null]) {
      const world = defaultTree();
      let pushed = false;
      const github = gateGithub(world, {
        defaultHead,
        onWrite: async (action) => {
          if (action.type === 'branch.push') pushed = true;
          return { pushed: true };
        },
      });
      const gate = createGate({ home, profile, github, run: procRun, binding: bindingFor(world), which: async () => false });
      const label = `${kind} / 默认头 ${defaultHead ? '在' : '不在'}`;
      const outcome = await gate.handle({
        type: 'branch.push',
        repo: REPO,
        branch: repo.branch,
        bundlePath: repo.bundlePath,
        dedupeKey: `bypass-${kind}-${defaultHead ? 'base' : 'full'}`,
      });
      assert.equal(outcome.code, 4, `${label}: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.body.reason, 'secret-found', label);
      assert.deepEqual(outcome.body.files, [repo.file], label);
      assert.equal(JSON.stringify(outcome).includes('MIIEnotARealKey'), false, `${label}：不回显内容`);
      assert.equal(pushed, false, `${label}：没推`);
    }
  });
}

test('SC9 pr.ready 不认从 fork 来的 PR（isCrossRepository）：分支名和标记照抄也不行', async () => {
  const { home, profile } = setupEnvironment();
  for (const [label, crossRepo] of [
    ['fork', true],
    ['字段缺失', null],
  ]) {
    const world = defaultTree();
    const github = gateGithub(world, { crossRepo });
    const gate = createGate({ home, profile, github, run: procRun, binding: bindingFor(world), which: async () => false });
    const outcome = await gate.handle({ type: 'pr.ready', repo: REPO, pr: 7, dedupeKey: `ready-fork-${label}` });
    assert.equal(outcome.code, 4, `${label}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.body.reason, 'not-in-tree', label);
    assert.equal(world.writes.length, 0, label);
  }
  assert.match(PR_READY_QUERY, /isCrossRepository/);
});

test('SC9 pr.create：必须 draft: true；非 fork 档 head 不许带前缀；fork 档 head 必须是 ownerLogin:分支', async () => {
  const { home, profile } = setupEnvironment();
  const prBody = `任务 issue：${ROOT_REF}\n\n${PR_MARKER}`;
  const cases = [
    ['draft 缺省', { repo: REPO, head: 'acceptance/1-2-sc1' }, 'not-allowed'],
    ['draft:false', { repo: REPO, head: 'acceptance/1-2-sc1', draft: false }, 'not-allowed'],
    ['draft:"true"', { repo: REPO, head: 'acceptance/1-2-sc1', draft: 'true' }, 'not-allowed'],
    ['非 fork 带别人前缀', { repo: REPO, head: 'stranger:acceptance/1-2-sc1', draft: true }, 'not-in-tree'],
    ['非 fork 带自己前缀', { repo: REPO, head: `${profile.ownerLogin}:acceptance/1-2-sc1`, draft: true }, 'not-in-tree'],
    ['fork 没前缀', { repo: 'makecindy/cindy', head: 'acceptance/1-2-sc1', draft: true }, 'not-in-tree'],
    ['fork 别人前缀', { repo: 'makecindy/cindy', head: 'stranger:acceptance/1-2-sc1', draft: true }, 'not-in-tree'],
    ['fork 空前缀', { repo: 'makecindy/cindy', head: ':acceptance/1-2-sc1', draft: true }, 'not-in-tree'],
    ['非 fork 对的', { repo: REPO, head: 'acceptance/1-2-sc1', draft: true }, null],
    ['fork 对的', { repo: 'makecindy/cindy', head: `${profile.ownerLogin}:acceptance/1-2-sc1`, draft: true }, null],
  ];
  for (const [label, fields, reason] of cases) {
    const world = defaultTree();
    const writes = [];
    const github = gateGithub(world, {
      onWrite: (action) => {
        writes.push(action);
        return action.type === 'pr.create' ? { pr: 12, url: 'https://example.invalid/pull/12' } : undefined;
      },
    });
    const gate = createGate({ home, profile, github, run: procRun, binding: bindingFor(world), which: async () => false });
    const outcome = await gate.handle({ type: 'pr.create', base: 'main', title: 't', body: prBody, dedupeKey: `create-${label}`, ...fields });
    if (reason) {
      assert.equal(outcome.code, 4, `${label}: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.body.reason, reason, label);
      assert.equal(writes.length, 0, `${label}：拒了就什么都没执行`);
    } else {
      assert.equal(outcome.code, 0, `${label}: ${JSON.stringify(outcome)}`);
      assert.equal(writes.length, 1, label);
      assert.equal(writes[0].draft, true, label);
    }
  }
});

test('SC9 branch.push 扫描本身出错（rev-list / cat-file 失败）：fail closed，scan-failed，不推', async () => {
  const { home, profile } = setupEnvironment();
  const repo = await buildBypassRepo('header');
  for (const broken of ['rev-list', 'cat-file']) {
    const world = defaultTree();
    let pushed = false;
    const github = gateGithub(world, {
      defaultHead: repo.mainSha,
      onWrite: async (action) => {
        if (action.type === 'branch.push') pushed = true;
        return { pushed: true };
      },
    });
    const run = (cmd, args, options) =>
      cmd === 'git' && args.includes(broken)
        ? Promise.resolve({ code: 128, stdout: '', stderr: `fatal: ${broken} broke` })
        : procRun(cmd, args, options);
    const gate = createGate({ home, profile, github, run, binding: bindingFor(world), which: async () => false });
    const outcome = await gate.handle({
      type: 'branch.push',
      repo: REPO,
      branch: repo.branch,
      bundlePath: repo.bundlePath,
      dedupeKey: `scan-broken-${broken}`,
    });
    assert.notEqual(outcome.code, 0, `${broken}: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.body.reason, 'scan-failed', broken);
    assert.equal(pushed, false, `${broken}：扫描出错不推`);
  }
});
