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
import { createLocalGit, spawnRun } from './bin/localgit.mjs';
import { STATUS_QUERY, createGate, startGateServer } from './host/write-gate.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { run as procRun } from './host/proc.mjs';
import { defaultTree } from './session.fixture.mjs';
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

function gateGithub(world, { statusRollup = 'SUCCESS', onWrite } = {}) {
  return {
    async graphql(query, variables) {
      if (query === STATUS_QUERY) {
        return {
          repository: {
            pullRequest: {
              number: variables.number,
              commits: {
                nodes: [{ commit: { statusCheckRollup: statusRollup ? { state: statusRollup } : null } }],
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

test('SC9 类型不在白名单（含 pr.merge）→ 4 not-allowed；pr.update-branch / ci.rerun → 4 not-implemented', async () => {
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
    assert.equal(outcome.body.reason, 'not-implemented', type);
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

test('SC9 pr.ready 检查没绿 → 4 checks-not-green；全绿 → 放行', async () => {
  const { home, profile } = setupEnvironment();
  const world = defaultTree();
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
      dedupeKey: `ready-${state ?? 'null'}`,
    });
    assert.equal(outcome.code, expected, `${state}: ${JSON.stringify(outcome)}`);
    if (expected === 4) assert.equal(outcome.body.reason, 'checks-not-green');
  }
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
  const world = defaultTree();
  const gate = createGate({ home, profile, github: gateGithub(world), run: procRun, which: async () => false });
  const version = bodyVersion(world.get(ROOT_REF).body);

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
  assert.equal(skipped.body.reason, 'needs-round-binding');

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
  const git = createLocalGit();
  const gitRun = async (args, cwd = repoDir) => {
    const result = await git.git(args, { cwd });
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
  const git = createLocalGit();
  const gitRun = async (args, cwd = repoDir) => {
    const result = await git.git(args, { cwd });
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
