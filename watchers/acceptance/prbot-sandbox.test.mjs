// #60 SC3 / SC4：修正轮沙箱 fail-closed、预检环境白名单和遮罩；真 bwrap 可用时跑 contract。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { INTERNAL_ENV, probeBwrap } from './host/sandbox.mjs';
import { run as procRun } from './host/proc.mjs';
import { EGRESS_BRIDGE } from './host/egress-proxy.mjs';
import {
  PI_ENV_ALLOWLIST,
  PREFLIGHT_ENV_ALLOWLIST,
  runPiInSandbox,
  runPreflightInSandbox,
} from './host/prbot-sandbox.mjs';
import { REPO, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const bwrapAvailable = await probeBwrap(procRun);

function setup() {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: base.home });
  const worktree = path.join(tmpDir(), 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  const hostConfig = { prbot: { piCommand: ['pi', '--model', 'example/model', '--thinking', 'high'] } };
  return { base, home: base.home, profile, worktree, hostConfig };
}

function recordingRun({ bwrapCode = 0, bwrapThrows = false, stdout = '' } = {}) {
  const calls = [];
  async function run(cmd, args, options = {}) {
    calls.push({ cmd, args, options });
    if (cmd === 'bwrap' && bwrapThrows) {
      const error = new Error('spawn bwrap ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    if (cmd === 'bwrap' && args.length <= 4) return { code: bwrapAvailable ? 0 : 1, stdout: '', stderr: '' };
    return { code: bwrapCode, stdout, stderr: bwrapCode === 0 ? '' : 'failed' };
  }
  run.calls = calls;
  return run;
}

test('SC3 pi 只在 bwrap 里跑；环境是白名单，PI_NO_SANDBOX 关不掉', async () => {
  const { home, profile, worktree, hostConfig } = setup();
  const run = recordingRun();
  const result = await runPiInSandbox({
    home,
    profile,
    hostConfig,
    roundDir: path.join(tmpDir(), 'round'),
    worktree,
    piCommand: ['pi', '--model', 'example/model'],
    prompt: '先写复现测试',
    env: {
      ...process.env,
      PI_NO_SANDBOX: '1',
      ACCEPTANCE_NO_SANDBOX: '1',
      LLM_PROXY_API_KEY: 'example-proxy-key-not-real',
      GITHUB_TOKEN: 'not-real',
      GH_TOKEN: 'not-real',
    },
    run,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const modelCall = run.calls.find((call) => call.cmd === 'bwrap' && call.args.includes('--'));
  assert.ok(modelCall, '一定经 bwrap 起 pi');
  // 沙箱里先起出网桥，再由桥起 piCommand（原样接在桥的 `--` 后面）。
  const inside = modelCall.args.slice(modelCall.args.indexOf('--') + 1);
  assert.equal(inside[1], EGRESS_BRIDGE, '沙箱里第一个起的是出网桥');
  assert.deepEqual(inside.slice(inside.indexOf('--') + 1), ['pi', '--model', 'example/model']);
  for (const key of Object.keys(modelCall.options.env)) {
    assert.ok([...PI_ENV_ALLOWLIST, ...INTERNAL_ENV].includes(key), `pi 环境里混进了 ${key}`);
  }
  assert.equal(modelCall.options.env.LLM_PROXY_API_KEY, 'example-proxy-key-not-real');
  assert.equal('GITHUB_TOKEN' in modelCall.options.env, false);
  assert.equal('PI_NO_SANDBOX' in modelCall.options.env, false);
  assert.equal(modelCall.options.input, '先写复现测试');
  assert.ok(modelCall.args.includes(profile.githubTokenFile), '令牌文件在遮罩名单上');
  const tokenAt = modelCall.args.indexOf(profile.githubTokenFile);
  assert.deepEqual(modelCall.args.slice(tokenAt - 2, tokenAt + 1), ['--ro-bind', '/dev/null', profile.githubTokenFile]);
});

test('SC3 bwrap 起不来就不跑模型（返回 unavailable）', async () => {
  const { home, profile, worktree, hostConfig } = setup();
  const run = recordingRun({ bwrapThrows: true });
  const result = await runPiInSandbox({
    home,
    profile,
    hostConfig,
    roundDir: path.join(tmpDir(), 'round'),
    worktree,
    piCommand: ['pi', '--model', 'example/model'],
    prompt: 'x',
    env: process.env,
    run,
  });
  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true);
  assert.equal(run.calls.some((call) => call.args.includes('--') && call.args.includes('pi')), false, '不跑模型');
});

test('SC4 预检：环境只有 8 个白名单变量（没有 LLM key / 令牌）；bwrap 不可用时一条都不跑', async () => {
  const { home, profile, worktree, hostConfig } = setup();
  const run = recordingRun();
  const result = await runPreflightInSandbox({
    home,
    profile,
    hostConfig,
    roundDir: path.join(tmpDir(), 'round'),
    worktree,
    commands: [['sh', '.githooks/pre-push']],
    env: {
      ...process.env,
      LLM_PROXY_API_KEY: 'example-proxy-key-not-real',
      GH_TOKEN: 'not-real',
      GITHUB_TOKEN: 'not-real',
      MY_SECRET: 'not-real',
    },
    run,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const call = run.calls.find((entry) => entry.args.includes('--') && entry.args.includes('sh'));
  assert.ok(call);
  for (const key of Object.keys(call.options.env)) {
    assert.ok(PREFLIGHT_ENV_ALLOWLIST.includes(key), `预检环境里混进了 ${key}`);
  }
  for (const key of ['LLM_PROXY_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'MY_SECRET']) {
    assert.equal(key in call.options.env, false, key);
  }

  const down = recordingRun({ bwrapThrows: true });
  const skipped = await runPreflightInSandbox({
    home,
    profile,
    hostConfig,
    roundDir: path.join(tmpDir(), 'round2'),
    worktree,
    commands: [['sh', '.githooks/pre-push']],
    env: process.env,
    run: down,
  });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.unavailable, true);
  assert.equal(down.calls.some((entry) => entry.args.includes('sh')), false, '预检一条都不跑');
});

test(
  'SC4 真 bwrap 预检：环境里没有令牌变量，GitHub / Slack 令牌、App 私钥、gh hosts 都读不到（夹具在 /tmp 之外）',
  { skip: bwrapAvailable ? false : 'bwrap 不可用（bwrap --ro-bind / / true 起不来），跳过真沙箱预检 contract' },
  async () => {
    const outside = fs.mkdtempSync(path.join(HERE, '.prbot-sandbox-real-test-'));
    after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const place = (name) => {
      const dir = path.join(outside, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const hostHome = place('host-home');
    fs.mkdirSync(path.join(hostHome, '.config', 'gh'), { recursive: true });
    const ghHosts = path.join(hostHome, '.config', 'gh', 'hosts.yml');
    fs.writeFileSync(ghHosts, 'oauth_token: fake-gh-hosts-token-not-real\n', { mode: 0o600 });

    const home = place('watcher-home');
    const stateDir = place('acc-state');
    const worktreeDir = place('acc-worktree');
    const worktree = place('worktree');
    const secrets = place('secrets');
    const tokenFile = writeSecret(path.join(secrets, 'github.token'), 'fake-github-token-not-real');
    const slackFile = writeSecret(path.join(secrets, 'slack.token'), 'fake-slack-token-not-real');
    const privateKeyFile = writeSecret(path.join(secrets, 'app.pem'), 'fake-app-private-key-not-real');
    const linkedTarget = writeSecret(path.join(place('real-store'), 'linked.token'), 'fake-linked-token-not-real');
    const linkedPath = path.join(secrets, 'linked.token');
    fs.symlinkSync(linkedTarget, linkedPath);
    const appConfigPath = path.join(secrets, 'app.json');
    fs.writeFileSync(appConfigPath, JSON.stringify({ appId: '1', installationId: '2', privateKeyFile }), { mode: 0o600 });
    fs.mkdirSync(path.join(home, 'config'), { recursive: true });
    fs.writeFileSync(
      path.join(home, 'config', 'profile.json'),
      JSON.stringify({
        ownerLogin: 'ExampleUser',
        projectNumber: 7,
        stateDir,
        worktreeDir,
        startAt: '2026-01-01T00:00:00.000Z',
        githubTokenFile: tokenFile,
        slackBotTokenFile: slackFile,
        exampleTokenFile: linkedPath,
        appConfigPath,
        autoRepos: ['ExampleUser/*'],
      }),
    );
    const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
    const hostConfig = { prbot: { piCommand: ['pi'] }, credentialDirs: [place('extra-cred')] };
    const targets = [tokenFile, slackFile, privateKeyFile, linkedPath, linkedTarget, ghHosts, path.join(hostHome, '.config', 'gh')];

    const fixture = path.join(worktree, 'preflight-fixture.mjs');
    fs.writeFileSync(
      fixture,
      [
        "import fs from 'node:fs';",
        'const targets = JSON.parse(process.argv[2]);',
        'const readable = [];',
        'for (const target of targets) {',
        '  try {',
        "    const stat = fs.statSync(target);",
        "    const content = stat.isDirectory() ? fs.readdirSync(target).join(',') : fs.readFileSync(target, 'utf8');",
        '    if (content.length > 0) readable.push(target);',
        '  } catch { /* 读不到就是遮住了 */ }',
        '}',
        "fs.writeFileSync('preflight-wrote.txt', 'ok');",
        'process.stdout.write(JSON.stringify({ env: Object.fromEntries(Object.entries(process.env)), readable }));',
        '',
      ].join('\n'),
    );
    const result = await runPreflightInSandbox({
      home,
      profile,
      hostConfig,
      roundDir: place('round'),
      worktree,
      commands: [[process.execPath, fixture, JSON.stringify(targets)]],
      env: {
        ...process.env,
        HOME: hostHome,
        LLM_PROXY_API_KEY: 'fake-proxy-key-not-real',
        GH_TOKEN: 'fake-gh-token-not-real',
        GITHUB_TOKEN: 'fake-github-token-not-real',
        EXAMPLE_TOKEN: 'fake-example-token-not-real',
      },
      run: procRun,
      timeoutMs: 120000,
    });
    assert.equal(result.ok, true, JSON.stringify(result.runs));
    // stdout 由 runPreflightInSandbox 的内部 run 收走；直接再跑一次夹具读结果更直接。
    const raw = await procRun('bwrap', [...result.args, '--', process.execPath, fixture, JSON.stringify(targets)], {
      env: result.env,
      cwd: worktree,
      timeoutMs: 120000,
    });
    assert.equal(raw.code, 0, raw.stderr);
    const seen = JSON.parse(raw.stdout);
    assert.deepEqual(seen.readable, [], '一个凭证都不该读到');
    // bwrap 自己会把 PWD 设成工作目录（不是令牌变量），契约里单独放行。
    for (const key of Object.keys(seen.env)) {
      assert.ok([...PREFLIGHT_ENV_ALLOWLIST, 'PWD'].includes(key), `预检环境里混进了 ${key}`);
    }
    for (const key of ['LLM_PROXY_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'EXAMPLE_TOKEN']) {
      assert.equal(key in seen.env, false, key);
    }
    for (const secret of [
      'fake-github-token-not-real',
      'fake-slack-token-not-real',
      'fake-app-private-key-not-real',
      'fake-linked-token-not-real',
      'fake-gh-hosts-token-not-real',
    ]) {
      assert.equal(raw.stdout.includes(secret), false, '不回显假凭证内容');
    }
    assert.equal(fs.readFileSync(path.join(worktree, 'preflight-wrote.txt'), 'utf8'), 'ok');
  },
);
