import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGithub } from './bin/github.mjs';
import { poll } from './bin/poll.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { cachePath, createRounds } from './bin/rounds.mjs';
import { bodyVersion, collectTasks } from './bin/tasks.mjs';
import {
  OWNER,
  REPO,
  HANDOFF_REPO,
  START_AT,
  childNode,
  clock,
  createFakeRun,
  inventoryData,
  issueNode,
  roundComment,
  tmpDir,
  writeProfile,
  writeSecret,
} from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const POLL_BIN = path.join(HERE, 'bin', 'poll.mjs');

function runChild(cmd, args, { env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

function writeFakeGh(binDir, handlerSource) {
  fs.mkdirSync(binDir, { recursive: true });
  const gh = path.join(binDir, 'gh');
  fs.writeFileSync(
    gh,
    `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
let input = '';
for await (const c of process.stdin) input += c;
${handlerSource}
`,
  );
  fs.chmodSync(gh, 0o700);
  return gh;
}

test('SC11 poll --json 只读：不发写请求，输出该开始的任务', async () => {
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: writeProfile(tmpDir()).home });
  const body = 'ready to accept';
  const parent = issueNode({
    repo: REPO,
    number: 1,
    body,
    author: OWNER,
    subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: '2026-10-20T00:00:00.000Z' })],
  });
  const writes = [];
  const run = createFakeRun({
    onGraphql: () => inventoryData({ open: [parent] }),
    onApi: (args) => {
      writes.push(args);
      return { id: 1 };
    },
  });
  const originalWrite = createGithub({ profile, run }).write;
  const github = createGithub({ profile, run });
  const orig = github.write;
  github.write = async (...a) => {
    writes.push(a);
    return orig(...a);
  };
  const entries = await poll({ github, profile, now: () => Date.parse('2026-10-24T00:00:00.000Z') });
  assert.equal(writes.length, 0);
  assert.equal(github._nope, undefined);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].issue, `${REPO}#1`);
  assert.equal(entries[0].kind, 'parent');
  assert.equal(entries[0].tier, 'auto');
  assert.equal(entries[0].nextRound, 1);
  assert.equal(entries[0].bodyVersion, bodyVersion(body));
  assert.equal(run.calls.every((c) => c.args.includes('graphql') || c.cmd !== 'gh'), true);
  void originalWrite;
});

test('SC11 没有任务时输出空列表', async () => {
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: writeProfile(tmpDir()).home });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [] }) });
  const github = createGithub({ profile, run });
  const entries = await poll({ github, profile, now: () => Date.parse('2026-10-24T00:00:00.000Z') });
  assert.deepEqual(entries, []);
});

test('SC11 CLI poll.mjs --json 不发写请求', async () => {
  const { home } = writeProfile(tmpDir());
  const binDir = path.join(home, 'bin');
  writeFakeGh(
    binDir,
    `if (args.includes('graphql')) {
  const empty = { data: { user: { open: { nodes: [], pageInfo: { hasNextPage: false } }, closed: { nodes: [], pageInfo: { hasNextPage: false } } } } };
  process.stdout.write(JSON.stringify(empty));
  process.exit(0);
}
process.stderr.write('write-not-allowed ' + args.join(' '));
process.exit(2);
`,
  );
  const result = await runChild(process.execPath, [POLL_BIN, '--json'], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      ACCEPTANCE_WATCHER_HOME: home,
      GH_TOKEN: 'should-not-be-used',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).length, 0);
});

test('SC12 开着的 issue 不超过 100 条时一轮盘点不超过 3 个读请求，不走 search', async () => {
  const { home } = writeProfile(tmpDir());
  const appPem = path.join(home, 'secrets', 'app.pem');
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeSecret(appPem, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const appConfig = path.join(home, 'app.json');
  fs.writeFileSync(appConfig, JSON.stringify({ appId: '11', installationId: '22', privateKeyFile: appPem }));
  const profileFile = path.join(home, 'config', 'profile.json');
  const raw = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  raw.appConfigPath = appConfig;
  fs.writeFileSync(profileFile, JSON.stringify(raw, null, 2));
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const body = 'x';
  const parent = issueNode({
    number: 1,
    body,
    subIssues: [childNode({ number: 2, state: 'CLOSED' })],
  });
  const tokenCounts = { owner: 0, app: 0 };
  const run = createFakeRun({
    onGraphql: () => inventoryData({ open: [parent] }),
  });
  const github = createGithub({
    profile,
    run,
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: 'app-install-token' }) }),
  });
  await poll({ github, profile, now: () => Date.parse('2026-10-24T00:00:00.000Z') });
  const graphqlCalls = run.calls.filter((c) => c.args.includes('graphql'));
  assert.ok(graphqlCalls.length <= 3, `reads=${graphqlCalls.length}`);
  for (const call of graphqlCalls) {
    assert.equal(call.ghToken, 'app-install-token');
    tokenCounts.app += 1;
    assert.equal(call.args.includes('search'), false);
    assert.doesNotMatch(JSON.stringify(call.args), /search/);
  }
  assert.equal(run.calls.filter((c) => c.args.includes('POST') || c.args.includes('PATCH')).length, 0);
  void START_AT;
});

test('SC13 CLI 缺必填配置退出码 1 并点名键', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'profile.json'), JSON.stringify({ ownerLogin: OWNER }));
  const result = await runChild(process.execPath, [POLL_BIN, '--json'], {
    env: { ...process.env, ACCEPTANCE_WATCHER_HOME: home, PATH: process.env.PATH },
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /projectNumber|stateDir|githubTokenFile/);
});

test('SC14 poll 在退避窗口内不列出该任务，删掉本地状态结果不变', async () => {
  const { home, profile } = { home: writeProfile(tmpDir()).home, profile: null };
  const loaded = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const body = 'p';
  const rounds = [
    roundComment({ round: 1, status: '中断', finishedAt: '2026-10-24T02:00:00.000Z', createdAt: '2026-10-24T01:50:00.000Z' }),
    roundComment({ round: 2, status: '中断', finishedAt: '2026-10-24T03:00:00.000Z', createdAt: '2026-10-24T02:50:00.000Z' }),
  ];
  const parent = issueNode({
    number: 1,
    body,
    comments: rounds,
    subIssues: [childNode({ number: 2, state: 'CLOSED', closedAt: '2026-10-20T00:00:00.000Z' })],
  });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [parent] }) });
  const github = createGithub({ profile: loaded, run });
  const clk = clock('2026-10-24T03:04:00.000Z');
  const hidden = await poll({ github, profile: loaded, now: clk.now });
  assert.equal(hidden.filter((e) => e.issue === `${REPO}#1` && !e.stale).length, 0);
  fs.rmSync(loaded.stateDir, { recursive: true, force: true });
  const hidden2 = await poll({ github, profile: loaded, now: clk.now });
  assert.equal(hidden2.filter((e) => e.issue === `${REPO}#1` && !e.stale).length, 0);
  clk.set('2026-10-24T03:05:00.000Z');
  const shown = await poll({ github, profile: loaded, now: clk.now });
  assert.equal(shown.some((e) => e.issue === `${REPO}#1` && e.nextRound === 3), true);
  void profile;
});

test('SC17 poll 输出卡住的验收中轮次；本地无记录时用评论创建时间；删 state 不变', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const createdAt = '2026-10-24T01:00:00.000Z';
  const parent = issueNode({
    number: 6,
    body: 'stale one',
    comments: [roundComment({ round: 2, status: '验收中', createdAt, databaseId: 66 })],
    subIssues: [childNode({ number: 7, state: 'CLOSED' })],
  });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [parent] }) });
  const github = createGithub({ profile, run });
  const now = () => Date.parse('2026-10-24T01:40:00.000Z');
  const entries = await poll({ github, profile, now });
  const stale = entries.find((e) => e.stale);
  assert.ok(stale);
  assert.equal(stale.issue, `${REPO}#6`);
  assert.equal(stale.round, 2);
  assert.equal(stale.lastProgressAt, createdAt);
  fs.rmSync(profile.stateDir, { recursive: true, force: true });
  const again = await poll({ github, profile, now });
  assert.equal(again.find((e) => e.stale).lastProgressAt, createdAt);
});

test('SC17 本地有进度记录时按本地 lastProgressAt 算', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const createdAt = '2026-10-24T01:00:00.000Z';
  const parent = issueNode({
    number: 6,
    comments: [roundComment({ round: 2, status: '验收中', createdAt, databaseId: 66 })],
  });
  const run = createFakeRun({
    onGraphql: (payload) => {
      if (String(payload.query).includes('repository(owner')) {
        return { repository: { issue: parent } };
      }
      return inventoryData({ open: [parent] });
    },
  });
  const github = createGithub({ profile, run });
  fs.mkdirSync(path.dirname(cachePath(profile, `${REPO}#6`)), { recursive: true });
  fs.writeFileSync(
    cachePath(profile, `${REPO}#6`),
    JSON.stringify({ round: { round: 2, commentId: 66, lastProgressAt: '2026-10-24T01:20:00.000Z' } }),
  );
  const now = () => Date.parse('2026-10-24T01:40:00.000Z');
  const entries = await poll({ github, profile, now });
  const stale = entries.find((e) => e.stale);
  // 本地 01:20，现在 01:40，未超过 30 分钟，不应标 stale
  assert.equal(stale, undefined);
  const later = await poll({ github, profile, now: () => Date.parse('2026-10-24T01:51:00.000Z') });
  assert.equal(later.find((e) => e.stale)?.lastProgressAt, '2026-10-24T01:20:00.000Z');
});

test('SC4 poll 会列出 watch 档任务', async () => {
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: writeProfile(tmpDir()).home });
  const issue = issueNode({
    repo: HANDOFF_REPO,
    number: 8,
    author: OWNER,
    linkedPrs: undefined,
    prs: [{ number: 9, url: 'https://example.test/p/9', mergedAt: '2026-10-21T00:00:00.000Z', repository: { nameWithOwner: HANDOFF_REPO } }],
  });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [issue] }) });
  const github = createGithub({ profile, run });
  const entries = await poll({ github, profile, now: () => Date.parse('2026-10-24T00:00:00.000Z') });
  assert.equal(entries[0].tier, 'watch');
  assert.equal(entries[0].kind, 'standalone');
});

test('SC16 静态：夹具用占位名，源码不含真实令牌头', () => {
  const root = HERE;
  const files = [];
  function walk(dir) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else files.push(p);
    }
  }
  walk(root);
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /gh[pousr]_[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  }
  const fixture = fs.readFileSync(path.join(HERE, 'fake-gh.fixture.mjs'), 'utf8');
  assert.match(fixture, /ExampleUser/);
  assert.match(fixture, /example-owner\/example-repo/);
});

void collectTasks;
void createRounds;
