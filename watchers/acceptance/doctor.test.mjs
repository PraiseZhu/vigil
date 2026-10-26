// #47 SC1 / SC10：部署检查。假 gh、假 writeCommand、假探针，不触网。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_OPTIONS,
  BOARD_ACCESS_QUERY,
  PROJECT_QUERY,
  REPO_QUERY,
  VIEWER_QUERY,
  checkMaskConfig,
  probeAction,
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

function boardAccess({ project = true, canUpdate = true, fields } = {}) {
  if (!project) return { user: { projectV2: null } };
  const nodes = fields || [
    {
      __typename: 'ProjectV2SingleSelectField',
      name: '验收',
      dataType: 'SINGLE_SELECT',
      options: ACCEPTANCE_OPTIONS.map((name) => ({ name })),
    },
    { __typename: 'ProjectV2Field', name: '裁决', dataType: 'TEXT' },
  ];
  return { user: { projectV2: { id: 'PVT_1', viewerCanUpdate: canUpdate, fields: { nodes } } } };
}

function makeGithub({ viewer = OWNER, project = true, forkPermission = 'WRITE', canUpdate = true, fields, ownerGraphql = true } = {}) {
  const writes = [];
  const ownerQueries = [];
  const github = {
    writes,
    ownerQueries,
    async graphql(query, variables = {}) {
      if (query === VIEWER_QUERY) return { viewer: { login: viewer } };
      if (query === PROJECT_QUERY) return { user: { projectV2: project ? { id: 'PVT_1', title: '看板' } : null } };
      if (query === BOARD_ACCESS_QUERY) {
        if (ownerGraphql) throw new Error('看板写回要用账号令牌查（ownerGraphql），不该走读令牌');
        return boardAccess({ project, canUpdate, fields });
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
  if (ownerGraphql) {
    github.ownerGraphql = async (query, variables = {}) => {
      ownerQueries.push({ query, variables });
      if (query === BOARD_ACCESS_QUERY) return boardAccess({ project, canUpdate, fields });
      throw new Error(`假 gh 不认识的账号令牌查询：${query.slice(0, 40)}`);
    };
  }
  return github;
}

function makeProbes({ gh = '/usr/bin/gh', writeProbe = { code: 0 }, outsideProbe = { code: 4 }, mask = { ok: true, detail: '遮住了' } } = {}) {
  return {
    which: (cmd) => (cmd === 'gh' ? gh : cmd === 'git' ? '/usr/bin/git' : null),
    actions: [],
    async runWriteCommand(action) {
      this.actions.push(action);
      return action.repo ? outsideProbe : writeProbe;
    },
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
  });
  assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
  for (const check of result.checks) assert.equal(check.ok, true, `${check.name}：${check.detail}`);
  const names = result.checks.map((check) => check.name);
  for (const name of ['node 版本', 'gh 在 PATH 上', 'git 在 PATH 上', '令牌账号', '仓可读', '写闸探针', '看板', '看板写回', 'fork 推送', '常驻循环', '写闸账本审计', '令牌文件', 'bwrap 遮罩']) {
    assert.ok(names.includes(name), `少了检查项 ${name}`);
  }
  // doctor 不对 GitHub 做任何真实写入：看板写回只读判断（账号令牌查 viewerCanUpdate 和字段）。
  assert.equal(github.writes.length, 0, 'doctor 不写 GitHub');
  assert.equal(github.ownerQueries.length, 1);
  assert.equal(github.ownerQueries[0].query, BOARD_ACCESS_QUERY);
  assert.deepEqual(github.ownerQueries[0].variables, { login: OWNER, projectNumber: 7 });
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
  });
  assert.equal(checkOf(noProbe, '写闸探针').ok, true);
  assert.match(checkOf(noProbe, '写闸探针').detail, /没有配 writeCommand/);
});

test('SC10 看板写回是只读判断：没写权限 / 缺字段 / 缺选项 / 裁决是单选 → 失败并点名，零写入', async () => {
  const fixture = makeFixture();
  const cases = [
    [{ canUpdate: false }, /没有写权限/],
    [{ fields: [{ __typename: 'ProjectV2Field', name: '裁决', dataType: 'TEXT' }] }, /没有「验收」字段/],
    [
      {
        fields: [
          { __typename: 'ProjectV2SingleSelectField', name: '验收', dataType: 'SINGLE_SELECT', options: [{ name: '通过' }] },
          { __typename: 'ProjectV2Field', name: '裁决', dataType: 'TEXT' },
        ],
      },
      /缺选项：验收中、要修、修正中/,
    ],
    [
      {
        fields: [
          { __typename: 'ProjectV2SingleSelectField', name: '验收', dataType: 'SINGLE_SELECT', options: ACCEPTANCE_OPTIONS.map((name) => ({ name })) },
          { __typename: 'ProjectV2SingleSelectField', name: '裁决', dataType: 'SINGLE_SELECT', options: [] },
        ],
      },
      /必须是文本/,
    ],
    [{ project: false }, /读不到看板 #7/],
  ];
  for (const [options, pattern] of cases) {
    const github = makeGithub(options);
    const result = await runDoctor({ profileEnv: fixture.profileEnv, probes: makeProbes(), github, now: () => NOW });
    const check = checkOf(result, '看板写回');
    assert.equal(check.ok, false, JSON.stringify(options));
    assert.match(check.detail, pattern);
    assert.equal(github.writes.length, 0);
  }
});

test('SC10 看板写回：注入的 github 没有 ownerGraphql 时退回读令牌查；写闸探针从不交 project.field.set', async () => {
  const fixture = makeFixture();
  const github = makeGithub({ ownerGraphql: false });
  const probes = makeProbes();
  const result = await runDoctor({ profileEnv: fixture.profileEnv, probes, github, now: () => NOW });
  assert.equal(checkOf(result, '看板写回').ok, true, checkOf(result, '看板写回').detail);
  assert.equal(github.writes.length, 0);
  assert.ok(probes.actions.length >= 2);
  for (const action of probes.actions) assert.equal(action.type, 'probe', '经 writeCommand 只交探针');
});

test('#47 探针动作：每次 dedupeKey 都不同（带随机数），带 probe 标记', async () => {
  const fixture = makeFixture();
  const probes = makeProbes();
  await runDoctor({ profileEnv: fixture.profileEnv, probes, github: makeGithub(), now: () => NOW });
  await runDoctor({ profileEnv: fixture.profileEnv, probes, github: makeGithub(), now: () => NOW });
  const keys = probes.actions.map((action) => action.dedupeKey);
  assert.equal(keys.length, 4);
  assert.equal(new Set(keys).size, 4, keys.join(','));
  for (const action of probes.actions) {
    assert.equal(action.probe, true);
    assert.match(action.dedupeKey, /^doctor-probe:[0-9a-f-]{36}$/);
  }
  assert.notEqual(probeAction().dedupeKey, probeAction().dedupeKey);
});

test('#47 bwrap 遮罩：host.json 的 credentialDirs / homeAllowDirs 不存在或与可写绑定重叠 → 失败；正常 → 通过', async () => {
  const fixture = makeFixture();
  const profile = JSON.parse(fs.readFileSync(path.join(fixture.home, 'config', 'profile.json'), 'utf8'));
  const credential = tmpDir('acc-cred-');
  const allow = tmpDir('acc-allow-');

  const good = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes(),
    github: makeGithub(),
    now: () => NOW,
    hostConfig: { credentialDirs: [credential], homeAllowDirs: [allow] },
  });
  assert.equal(checkOf(good, 'bwrap 遮罩').ok, true, checkOf(good, 'bwrap 遮罩').detail);

  const missing = path.join(credential, 'not-there');
  const overlapping = path.join(profile.stateDir, 'creds');
  fs.mkdirSync(overlapping, { recursive: true });
  const bad = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes(),
    github: makeGithub(),
    now: () => NOW,
    hostConfig: { credentialDirs: [missing, overlapping], homeAllowDirs: [profile.worktreeDir] },
  });
  const check = checkOf(bad, 'bwrap 遮罩');
  assert.equal(check.ok, false);
  assert.match(check.detail, /credentialDirs\[0\] 不存在/);
  assert.match(check.detail, /credentialDirs\[1\] 与可写绑定（stateDir）重叠/);
  assert.match(check.detail, /homeAllowDirs\[0\] 与可写绑定（worktreeDir）重叠/);
  assert.equal(check.detail.includes(missing), false, '路径不回显');

  // 不传 hostConfig 时读 <home>/config/host.json。
  fs.writeFileSync(path.join(fixture.home, 'config', 'host.json'), JSON.stringify({ credentialDirs: [missing] }));
  const fromFile = await runDoctor({ profileEnv: fixture.profileEnv, probes: makeProbes(), github: makeGithub(), now: () => NOW });
  assert.equal(checkOf(fromFile, 'bwrap 遮罩').ok, false);
  assert.match(checkOf(fromFile, 'bwrap 遮罩').detail, /credentialDirs\[0\] 不存在/);

  assert.deepEqual(checkMaskConfig({ hostConfig: {}, profile }), []);
  assert.deepEqual(checkMaskConfig({ hostConfig: { credentialDirs: 'x' }, profile }), ['host.json 的 credentialDirs 应为绝对路径数组']);
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
  const result = await runDoctor({ profileEnv: fixture.profileEnv, probes: makeProbes(), github, now: () => NOW });
  const fork = checkOf(result, 'fork 推送');
  assert.equal(fork.ok, true, fork.detail);
  assert.ok(asked.includes(`${OWNER}/cindy-fork`), asked.join(','));
  assert.ok(!asked.includes(`${OWNER}/cindy`), '不该再查同名仓');
});

test('#60 修正轮交接配置：host.json 配了 prbot 就要求每个具体仓显式写 handoff（owner / watcher），预检格式也查', async () => {
  const run = (hostConfig) =>
    runDoctor({ profileEnv: makeFixture().profileEnv, probes: makeProbes(), github: makeGithub(), now: () => NOW, boardItem: `${REPO}#1`, hostConfig });
  // 没配 prbot：不查这一项。
  assert.equal(checkOf(await run({}), '修正轮交接配置'), undefined);

  const missing = checkOf(await run({ prbot: { piCommand: ['pi'], repos: { [REPO]: { preflight: '.githooks/pre-push' } } } }), '修正轮交接配置');
  assert.equal(missing.ok, false);
  assert.match(missing.detail, new RegExp(`${REPO} 的 handoff 没写成 owner / watcher`));
  assert.match(missing.detail, /preflight 格式不对/);
  assert.match(missing.detail, /makecindy\/cindy 没在 prbot\.repos 里写 handoff/, 'forkRepos 里的具体仓也要写');

  const good = checkOf(
    await run({
      prbot: {
        piCommand: ['pi'],
        repos: { [REPO]: { handoff: 'owner', preflight: ['.githooks/pre-push', ['npm', 'test']] }, 'makecindy/cindy': { handoff: 'watcher' } },
      },
    }),
    '修正轮交接配置',
  );
  assert.equal(good.ok, true, good.detail);

  // 不传 hostConfig：从 <home>/config/host.json 读。
  const fixture = makeFixture();
  fs.writeFileSync(path.join(fixture.home, 'config', 'host.json'), JSON.stringify({ prbot: { piCommand: ['pi'] } }));
  const fromFile = await runDoctor({ profileEnv: fixture.profileEnv, probes: makeProbes(), github: makeGithub(), now: () => NOW, boardItem: `${REPO}#1` });
  assert.equal(checkOf(fromFile, '修正轮交接配置').ok, false);
  assert.equal(fromFile.ok, false);
});

test('#61 doctor 加一项只读的 Slack 检查：结果原样报出；没配频道就跳过（算通过）', async () => {
  const fixture = makeFixture();
  const seen = [];
  const failing = await runDoctor({
    profileEnv: fixture.profileEnv,
    probes: makeProbes(),
    github: makeGithub(),
    now: () => NOW,
    boardItem: `${REPO}#1`,
    slackCheck: async ({ profile }) => {
      seen.push(profile.ownerLogin);
      return { ok: false, detail: 'bot 不在目标频道里：在频道里 /invite 它' };
    },
  });
  assert.equal(failing.ok, false);
  assert.deepEqual(checkOf(failing, 'Slack 频道'), { name: 'Slack 频道', ok: false, detail: 'bot 不在目标频道里：在频道里 /invite 它' });
  assert.deepEqual(seen, [OWNER], '检查拿到的是加载后的 profile');

  // 默认实现：夹具没配 slackChannelId，跳过、不触网。
  const skipped = await runDoctor({ profileEnv: fixture.profileEnv, probes: makeProbes(), github: makeGithub(), now: () => NOW, boardItem: `${REPO}#1` });
  assert.equal(checkOf(skipped, 'Slack 频道').ok, true);
  assert.match(checkOf(skipped, 'Slack 频道').detail, /跳过/);
});
