// #47 SC1 / SC10：部署检查。假 gh、假 writeCommand、假探针，不触网。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BOARD_ITEM_QUERY,
  PROJECT_QUERY,
  REPO_QUERY,
  VIEWER_QUERY,
  runDoctor,
} from './bin/doctor.mjs';
import { hostPaths } from './host/paths.mjs';
import { OWNER, REPO, HANDOFF_REPO, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = Date.parse('2026-10-24T02:00:00.000Z');

function makeFixture({ heartbeat, writeCommand = true } = {}) {
  const slack = writeSecret(path.join(tmpDir(), 'secrets', 'slack.token'), 'fixture-slack-not-real');
  const exampleToken = writeSecret(path.join(tmpDir(), 'secrets', 'example.token'), 'fixture-token-not-real');
  const extraProfile = {
    stateDir: path.join(tmpDir(), 'acc-state'),
    slackBotTokenFile: slack,
    // 令牌文件键的约定：新增的 …TokenFile 键也要过 600 检查。
    exampleTokenFile: exampleToken,
  };
  if (writeCommand) extraProfile.writeCommand = ['node', 'example-write-command.mjs'];
  const base = writeProfile(tmpDir(), { profile: extraProfile });
  const paths = hostPaths(base.home);
  fs.mkdirSync(paths.hostDir, { recursive: true });
  const beat = heartbeat === undefined ? { at: new Date(NOW).toISOString(), pid: process.pid } : heartbeat;
  if (beat) fs.writeFileSync(paths.heartbeatFile, JSON.stringify({ ...beat, lastTick: { ok: true }, running: [] }));
  return { ...base, paths, exampleToken, profileEnv: { ACCEPTANCE_WATCHER_HOME: base.home } };
}

function makeGithub({ viewer = OWNER, project = true, forkPermission = 'WRITE', boardItem = true } = {}) {
  const writes = [];
  return {
    writes,
    async graphql(query, variables = {}) {
      if (query === VIEWER_QUERY) return { viewer: { login: viewer } };
      if (query === PROJECT_QUERY) return { user: { projectV2: project ? { id: 'PVT_1', title: '看板' } : null } };
      if (query === BOARD_ITEM_QUERY) {
        return {
          user: { projectV2: project ? { id: 'PVT_1' } : null },
          repository: {
            issue: {
              id: 'I_1',
              projectItems: {
                nodes: boardItem
                  ? [
                      {
                        id: 'PVTI_1',
                        isArchived: false,
                        project: { id: 'PVT_1' },
                        fieldValueByName: { text: 'https://example.invalid/verdict' },
                      },
                    ]
                  : [],
              },
            },
          },
        };
      }
      if (query === REPO_QUERY) {
        const repo = `${variables.owner}/${variables.name}`;
        if (repo === HANDOFF_REPO && forkPermission === null) return { repository: null };
        return { repository: { nameWithOwner: repo, viewerPermission: forkPermission } };
      }
      throw new Error(`假 gh 不认识的查询：${query.slice(0, 40)}`);
    },
    async write(action) {
      writes.push(action);
      return { itemId: 'PVTI_1' };
    },
  };
}

function makeProbes({ gh = '/usr/bin/gh', writeProbe = { code: 0 }, outsideProbe = { code: 4 }, mask = { ok: true, detail: '遮住了' } } = {}) {
  return {
    which: (cmd) => (cmd === 'gh' ? gh : cmd === 'git' ? '/usr/bin/git' : null),
    runWriteCommand: async (action) => (action.repo ? outsideProbe : writeProbe),
    sandboxMask: async () => mask,
  };
}

function checkOf(result, name) {
  return result.checks.find((check) => check.name === name);
}

test('SC1/SC10 全部就绪：exit 0，逐项都标 ok', async () => {
  const fixture = makeFixture();
  const github = makeGithub();
  const result = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes(),
    github,
    now: () => NOW,
    boardItem: `${REPO}#1`,
  });
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
  for (const check of result.checks) assert.equal(check.ok, true, `${check.name}：${check.detail}`);
  const names = result.checks.map((check) => check.name);
  for (const name of ['node 版本', 'gh 在 PATH 上', 'git 在 PATH 上', '令牌账号', '仓可读', '写闸探针', '看板', '看板写回', 'fork 推送', '常驻循环', '令牌文件', 'bwrap 遮罩']) {
    assert.ok(names.includes(name), `少了检查项 ${name}`);
  }
  assert.equal(github.writes.length, 1, '看板写回只写一次');
  assert.deepEqual(github.writes[0].fields, { 裁决: 'https://example.invalid/verdict' });
});

test('SC1 缺哪项报哪项：gh / 令牌账号 / 仓可读 / 看板 / fork 推送 / 常驻循环 / 令牌文件 / bwrap 遮罩', async () => {
  const fixture = makeFixture({ heartbeat: { at: new Date(NOW).toISOString(), pid: 999999 } });
  fs.chmodSync(fixture.exampleToken, 0o644);
  const result = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes({
      gh: null,
      writeProbe: { code: 1, stderr: '炸了' },
      outsideProbe: { code: 0 },
      mask: { ok: false, detail: '沙箱里还有 1 处凭证读得到' },
    }),
    github: makeGithub({ viewer: 'ExampleOther', project: false, forkPermission: 'READ' }),
    now: () => NOW,
    boardItem: `${REPO}#1`,
  });
  assert.equal(result.ok, false);
  const failed = result.checks.filter((check) => !check.ok).map((check) => check.name);
  for (const name of ['gh 在 PATH 上', '令牌账号', '看板', 'fork 推送', '常驻循环', '令牌文件', 'bwrap 遮罩', '写闸探针', '写闸探针（仓外）']) {
    assert.ok(failed.includes(name), `没报 ${name}：${failed.join(', ')}`);
  }
  assert.match(checkOf(result, '令牌账号').detail, /ExampleOther/);
});

test('SC1 仓读不到 → 「仓可读」报出来并点名', async () => {
  const fixture = makeFixture();
  const github = makeGithub({ forkPermission: null });
  const result = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes(),
    github,
    now: () => NOW,
    boardItem: `${REPO}#1`,
  });
  const readable = checkOf(result, '仓可读');
  assert.equal(readable.ok, false);
  assert.match(readable.detail, /example-org\/handoff-repo/);
});

test('SC1 写闸总开关关着（探针 4）算通过并写明状态；没配 writeCommand 就跳过', async () => {
  const fixture = makeFixture();
  const result = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes({ writeProbe: { code: 4 }, outsideProbe: { code: 4 } }),
    github: makeGithub(),
    now: () => NOW,
    boardItem: `${REPO}#1`,
  });
  assert.equal(checkOf(result, '写闸探针').ok, true);
  assert.match(checkOf(result, '写闸探针').detail, /关着/);
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));

  const noCommand = makeFixture({ writeCommand: false });
  const noProbe = await runDoctor({
    profileEnv: noCommand.profileEnv,
    probes: makeProbes(),
    github: makeGithub(),
    now: () => NOW,
    boardItem: `${REPO}#1`,
  });
  assert.equal(checkOf(noProbe, '写闸探针').ok, true);
  assert.match(checkOf(noProbe, '写闸探针').detail, /没有配 writeCommand/);
});

test('SC10 没有 --board-item → 「看板写回」失败并说明需要它', async () => {
  const fixture = makeFixture();
  const result = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes(),
    github: makeGithub(),
    now: () => NOW,
  });
  const check = checkOf(result, '看板写回');
  assert.equal(check.ok, false);
  assert.match(check.detail, /--board-item/);
  assert.equal(result.ok, false);
});

test('SC10 看板条目不在看板上 → 「看板写回」失败，不写', async () => {
  const fixture = makeFixture();
  const github = makeGithub({ boardItem: false });
  const result = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes(),
    github,
    now: () => NOW,
    boardItem: `${REPO}#1`,
  });
  assert.equal(checkOf(result, '看板写回').ok, false);
  assert.match(checkOf(result, '看板写回').detail, /不在看板上/);
  assert.equal(github.writes.length, 0);
});

test('SC1 配置缺失：只报一条「配置」，不回落任何默认配置', async () => {
  const empty = tmpDir();
  const result = await runDoctor({
    profileEnv: { ACCEPTANCE_WATCHER_HOME: empty },
    probes: makeProbes(),
    github: makeGithub(),
    now: () => NOW,
  });
  assert.equal(result.ok, false);
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0].name, '配置');
  assert.equal(result.checks[0].ok, false);
});

test('SC1 CLI：配置缺失时打印一行 ✗ 并以 1 退出（假的 home，不触网）', async () => {
  const empty = tmpDir();
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, 'bin', 'doctor.mjs')], {
      env: { ...process.env, ACCEPTANCE_WATCHER_HOME: empty },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1, result.stderr);
  const lines = result.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^✗ 配置：/);
});

test('SC1 fork 推送按 forkTargets 查对照的 fork 仓（名字和上游不同）', async () => {
  const fixture = makeFixture();
  const file = path.join(fixture.home, 'config', 'profile.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.forkRepos = ['makecindy/cindy'];
  raw.forkTargets = { 'makecindy/cindy': `${OWNER}/cindy-fork` };
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  const asked = [];
  const github = makeGithub({ forkPermission: 'READ' });
  const inner = github.graphql.bind(github);
  github.graphql = async (query, variables = {}) => {
    if (query === REPO_QUERY && variables.owner === OWNER) {
      asked.push(`${variables.owner}/${variables.name}`);
      const writable = variables.name === 'cindy-fork';
      return { repository: { nameWithOwner: `${variables.owner}/${variables.name}`, viewerPermission: writable ? 'WRITE' : 'READ' } };
    }
    return inner(query, variables);
  };
  const result = await runDoctor({ profileEnv: fixture.profileEnv, probes: makeProbes(), github, now: () => NOW, boardItem: `${REPO}#1` });
  const fork = checkOf(result, 'fork 推送');
  assert.equal(fork.ok, true, fork.detail);
  assert.ok(asked.includes(`${OWNER}/cindy-fork`), asked.join(','));
  assert.ok(!asked.includes(`${OWNER}/cindy`), '不该再查同名仓');
});
