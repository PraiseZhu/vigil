// #47 SC11：验收轮沙箱。假 bwrap / 假 runRound 测 fail-closed 和参数拼装；
// 最后一条用真的 bwrap（bwrap 不可用时明确跳过）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { hostPaths, readAlerts, tryAcquireLock, releaseLock } from './host/paths.mjs';
import { runHostRound, readMemAvailable, MEMORY_GATE_BYTES, SANDBOX_DOWN_ALERT_MS } from './host/round.mjs';
import {
  ENV_ALLOWLIST,
  INTERNAL_ENV,
  buildBwrapArgs,
  maskList,
  probeBwrap,
  sandboxEnv,
} from './host/sandbox.mjs';
import { run as procRun } from './host/proc.mjs';
import { EGRESS_BRIDGE, EGRESS_BRIDGE_PORT } from './host/egress-proxy.mjs';
import { REPO, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';

import { READONLY_SKIP, fixtureDirWritable } from './real-sandbox.fixture.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const ROOT_REF = `${REPO}#1`;

function writeHostJson(home, extra = {}) {
  const file = path.join(home, 'config', 'host.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = { piCommand: ['pi', '--model', 'example/model', '--thinking', 'max'], ...extra };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

function writeMeminfo({ availableKiB = 8 * 1024 * 1024 } = {}) {
  const file = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(
    file,
    [`MemTotal: ${16 * 1024 * 1024} kB`, `MemAvailable: ${availableKiB} kB`, 'MemFree: 123 kB', ''].join('\n'),
  );
  return file;
}

/** 一轮 round 的夹具：profile 的 stateDir 挪出 <home>/state（沙箱会遮蔽那里）。 */
function roundFixture({ hostJson } = {}) {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const home = base.home;
  if (hostJson !== undefined) writeHostJson(home, hostJson);
  else writeHostJson(home);
  fs.mkdirSync(hostPaths(home).gateDir, { recursive: true });
  fs.writeFileSync(hostPaths(home).enabledFile, '1');
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const calls = { round: [], pi: [], gateStop: 0 };
  const message = '先读 watchers/acceptance/SESSION.md，照里面的步骤做完这一轮验收。';
  const claim = {
    issue: ROOT_REF,
    round: 1,
    commentId: 1001,
    bodyVersion: 'sha256:' + 'a'.repeat(64),
  };

  function runRoundFake(argv) {
    calls.round.push(argv);
    if (argv[0] === 'start') return { code: 0, stdout: `${message}\n${JSON.stringify(claim)}\n`, stderr: '' };
    // pi 退出后宿主回读状态：已是终态才算正常收尾（没写裁决的情况在 host-round / round-lifecycle 测）。
    if (argv[0] === 'status') return { code: 0, stdout: `${JSON.stringify({ round: 1, status: '通过', stalled: false })}\n`, stderr: '' };
    if (argv[0] === 'abort') return { code: 0, stdout: '{}\n', stderr: '' };
    return { code: 1, stdout: '', stderr: `没准备这个命令：${argv.join(' ')}` };
  }

  async function startGateFake({ socketPath }) {
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    fs.writeFileSync(socketPath, '');
    return {
      socketPath,
      async stop() {
        calls.gateStop += 1;
      },
    };
  }

  function spawnPiFake(options) {
    calls.pi.push(options);
    return {
      pid: 424242,
      stdin: { write() {}, end() {} },
      kill() {},
      exit: Promise.resolve({ code: 0 }),
    };
  }

  const prefetchFake = async () => [];

  return { base, home, profile, calls, claim, message, runRoundFake, startGateFake, spawnPiFake, prefetchFake };
}

function neverExitSpawnPi(calls) {
  return (options) => {
    calls.pi.push(options);
    let resolveExit;
    const exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    return {
      pid: 434343,
      stdin: { write() {}, end() {} },
      kill() {
        resolveExit({ code: 143, signal: 'SIGTERM' });
      },
      exit,
    };
  };
}

test('SC11 内存门：MemAvailable 不到 3 GiB 就退出 3，不认领', async () => {
  const fixture = roundFixture();
  const meminfoPath = writeMeminfo({ availableKiB: 1024 });
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: fixture.spawnPiFake,
    meminfoPath,
    log: () => {},
  });
  assert.equal(code, 3);
  assert.equal(fixture.calls.round.length, 0, '内存门在认领之前');
  assert.equal(fixture.calls.pi.length, 0);
});

test('SC11 内存门常量是 3 GiB，读不出 meminfo 也按不够处理', async () => {
  assert.equal(MEMORY_GATE_BYTES, 3 * 1024 ** 3);
  const fixture = roundFixture();
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: fixture.spawnPiFake,
    meminfoPath: path.join(tmpDir(), 'missing-meminfo'),
    log: () => {},
  });
  assert.equal(code, 3);
  assert.equal(fixture.calls.round.length, 0);
  assert.equal(readMemAvailable(path.join(tmpDir(), 'missing-meminfo')), null);
});

test('SC11 两个槽都占着 → 退出 3，不认领', async () => {
  const fixture = roundFixture();
  const paths = hostPaths(fixture.home);
  fs.mkdirSync(paths.slotsDir, { recursive: true });
  const locks = [path.join(paths.slotsDir, 'slot-0'), path.join(paths.slotsDir, 'slot-1')];
  for (const file of locks) fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  try {
    const code = await runHostRound({
      home: fixture.home,
      issue: ROOT_REF,
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      runRound: fixture.runRoundFake,
      startGate: fixture.startGateFake,
      prefetch: fixture.prefetchFake,
      spawnPi: fixture.spawnPiFake,
      meminfoPath: writeMeminfo(),
      log: () => {},
    });
    assert.equal(code, 3);
    assert.equal(fixture.calls.round.length, 0);
  } finally {
    for (const file of locks) fs.rmSync(file, { force: true });
  }
});

test('SC11 mivo 的仓要占测试锁：锁被占 → 退出 3，槽也放回去', async () => {
  const fixture = roundFixture();
  const paths = hostPaths(fixture.home);
  fs.mkdirSync(path.dirname(paths.testLock), { recursive: true });
  assert.equal(tryAcquireLock(paths.testLock), true);
  try {
    const code = await runHostRound({
      home: fixture.home,
      issue: 'example-owner/mivo-plugin#5',
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
      runRound: fixture.runRoundFake,
      startGate: fixture.startGateFake,
      prefetch: fixture.prefetchFake,
      spawnPi: fixture.spawnPiFake,
      meminfoPath: writeMeminfo(),
      log: () => {},
    });
    assert.equal(code, 3);
    assert.equal(fixture.calls.round.length, 0);
    assert.equal(fs.existsSync(path.join(paths.slotsDir, 'slot-0')), false, '槽要放回去');
  } finally {
    releaseLock(paths.testLock);
  }
});

test('SC11 bwrap 不在（ENOENT）：不认领、不跑模型、issue 上不留评论，写一条 sandbox-down 提醒，退出非 0', async () => {
  const fixture = roundFixture();
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async () => {
      const error = new Error('spawn bwrap ENOENT');
      error.code = 'ENOENT';
      throw error;
    },
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: fixture.spawnPiFake,
    meminfoPath: writeMeminfo(),
    log: () => {},
  });
  assert.notEqual(code, 0);
  assert.equal(fixture.calls.pi.length, 0, 'bwrap 起不来就不跑模型');
  assert.deepEqual(fixture.calls.round, [], '探针在认领之前：不认领、不 abort');
  const alerts = readAlerts(hostPaths(fixture.home));
  assert.deepEqual(alerts.map((entry) => entry.kind), ['sandbox-down'], JSON.stringify(alerts));
  assert.equal(fs.existsSync(path.join(hostPaths(fixture.home).slotsDir, 'slot-0')), false, '槽放回去');
});

test('SC11 bwrap 探针失败：同样不认领；sandbox-down 提醒节流（窗口内只写一条）', async () => {
  const fixture = roundFixture();
  let clock = Date.parse('2026-10-24T02:00:00.000Z');
  const once = () =>
    runHostRound({
      home: fixture.home,
      issue: ROOT_REF,
      run: async () => ({ code: 1, stdout: '', stderr: 'bwrap: failed' }),
      runRound: fixture.runRoundFake,
      startGate: fixture.startGateFake,
      prefetch: fixture.prefetchFake,
      spawnPi: fixture.spawnPiFake,
      meminfoPath: writeMeminfo(),
      now: () => clock,
      log: () => {},
    });
  for (let i = 0; i < 5; i += 1) {
    assert.notEqual(await once(), 0);
    clock += 60 * 1000;
  }
  assert.equal(fixture.calls.pi.length, 0);
  assert.deepEqual(fixture.calls.round, [], '一次都没认领');
  assert.equal(readAlerts(hostPaths(fixture.home)).filter((entry) => entry.kind === 'sandbox-down').length, 1, '五分钟里只写一条');
  clock += SANDBOX_DOWN_ALERT_MS;
  await once();
  assert.equal(readAlerts(hostPaths(fixture.home)).filter((entry) => entry.kind === 'sandbox-down').length, 2, '过了窗口再写一条');
});

test('SC11 认领之后沙箱参数拼不出来：不跑模型，abort 成「沙箱起不来」，写 sandbox-unavailable', async () => {
  const fixture = roundFixture({ hostJson: { piCommand: ['pi'], homeAllowDirs: 'not-an-array' } });
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: fixture.spawnPiFake,
    meminfoPath: writeMeminfo(),
    log: () => {},
  });
  assert.notEqual(code, 0);
  assert.equal(fixture.calls.pi.length, 0);
  const abort = fixture.calls.round.find((argv) => argv[0] === 'abort');
  assert.ok(abort);
  assert.match(abort[abort.indexOf('--reason') + 1], /沙箱起不来/);
  assert.ok(readAlerts(hostPaths(fixture.home)).some((entry) => entry.kind === 'sandbox-unavailable'));
});

test('SC11 PI_NO_SANDBOX=1 和 host.json 的 sandbox:false 都关不掉沙箱', async () => {
  const fixture = roundFixture({ hostJson: { piCommand: ['pi', '--model', 'example/model'], sandbox: false, noSandbox: true } });
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    env: { ...process.env, PI_NO_SANDBOX: '1', ACCEPTANCE_NO_SANDBOX: '1' },
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: fixture.spawnPiFake,
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 5,
    log: () => {},
  });
  assert.equal(code, 0, 'pi 正常退出');
  assert.equal(fixture.calls.pi.length, 1);
  assert.equal(fixture.calls.pi[0].cmd, 'bwrap', '一定是 bwrap 起的');
  const args = fixture.calls.pi[0].args;
  // 沙箱里先起出网桥（--unshare-net 之后唯一的出网路），桥再起 piCommand；piCommand 原样接在桥的 `--` 后面。
  const inside = args.slice(args.indexOf('--') + 1);
  assert.equal(inside[1], EGRESS_BRIDGE, '沙箱里第一个起的是出网桥');
  assert.deepEqual(inside.slice(inside.indexOf('--') + 1), ['pi', '--model', 'example/model']);
});

test('SC11 子进程环境只含白名单（+ 两个内部变量），父进程的假令牌不进去', async () => {
  const fixture = roundFixture();
  const secretish = {
    EXAMPLE_GITHUB_TOKEN: 'example-token-value-not-real',
    MY_SECRET: 'not-a-real-secret',
    GITHUB_TOKEN: 'also-not-real',
    GIT_ASKPASS: '/bin/false',
  };
  const code = await runHostRound({
    home: fixture.home,
    issue: ROOT_REF,
    env: { ...process.env, ...secretish },
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: fixture.runRoundFake,
    startGate: fixture.startGateFake,
    prefetch: fixture.prefetchFake,
    spawnPi: fixture.spawnPiFake,
    meminfoPath: writeMeminfo(),
    statusIntervalMs: 5,
    log: () => {},
  });
  assert.equal(code, 0);
  const env = fixture.calls.pi[0].env;
  const allowed = new Set([...ENV_ALLOWLIST, ...INTERNAL_ENV]);
  for (const key of Object.keys(env)) {
    assert.ok(allowed.has(key), `环境里混进了 ${key}`);
  }
  for (const key of Object.keys(secretish)) assert.equal(key in env, false, key);
  assert.ok(env.ACCEPTANCE_WATCHER_HOME.startsWith(fixture.calls.pi[0].cwd));
  assert.ok(env.ACCEPTANCE_GATE_SOCKET.startsWith(fixture.calls.pi[0].cwd));
  assert.equal(env.HOME, path.join(fixture.calls.pi[0].cwd, 'home'));
  // 出网变量是沙箱内部变量：一律指向沙箱 lo 上的出网桥，不是宿主环境里抄来的。
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
    assert.equal(env[key], `http://127.0.0.1:${EGRESS_BRIDGE_PORT}`, key);
  }
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
});

test('SC11 遮罩名单从 profile 算：新增 …TokenFile 键和 App 私钥都自动进去', () => {
  const fakeHome = tmpDir();
  const stateDir = path.join(tmpDir(), 'acc-state');
  const worktreeDir = path.join(tmpDir(), 'acc-worktree');
  const tokenFile = writeSecret(path.join(tmpDir(), 'secrets', 'github.token'), 'not-a-real-token');
  const newKeyFile = writeSecret(path.join(tmpDir(), 'secrets', 'example.token'), 'not-a-real-token-2');
  const slackFile = writeSecret(path.join(tmpDir(), 'secrets', 'slack.token'), 'not-a-real-token-3');
  const privateKeyFile = writeSecret(path.join(tmpDir(), 'secrets', 'app.pem'), 'not-a-real-key');
  const appConfigPath = path.join(tmpDir(), 'app.json');
  fs.writeFileSync(appConfigPath, JSON.stringify({ appId: '1', installationId: '2', privateKeyFile }));
  fs.chmodSync(appConfigPath, 0o600);
  const home = tmpDir();
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
      appConfigPath,
      exampleTokenFile: newKeyFile,
      nested: { anotherPrivateKeyFile: privateKeyFile },
    }),
  );
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const rawProfile = JSON.parse(fs.readFileSync(path.join(home, 'config', 'profile.json'), 'utf8'));
  fs.mkdirSync(path.join(fakeHome, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, '.ssh', 'id_example'), 'x');
  fs.writeFileSync(path.join(fakeHome, '.git-credentials'), 'https://example.invalid');
  const masks = maskList({
    rawProfile,
    profile,
    hostConfig: { credentialDirs: [path.join(tmpDir(), 'extra-cred')] },
    env: { HOME: fakeHome },
    home,
  });
  for (const file of [tokenFile, newKeyFile, slackFile, privateKeyFile]) {
    assert.ok(masks.files.includes(file), `遮罩名单少了 ${path.basename(file)}`);
  }
  assert.ok(masks.files.includes(path.join(fakeHome, '.git-credentials')));
  assert.ok(masks.dirs.includes(path.join(fakeHome, '.ssh')));
  assert.ok(masks.dirs.includes(path.join(home, 'state')), '宿主状态目录要遮');
});

test('SC11 maskList 两处来源各自生效：原始 profile 里新增的 …TokenFile 键；加载后 profile 的 App 私钥（appPrivateKeyFile）', () => {
  const base = tmpDir();
  const customToken = writeSecret(path.join(base, 'secrets', 'custom.token'), 'not-a-real-token');
  const appKey = writeSecret(path.join(base, 'secrets', 'app-key.pem'), 'not-a-real-key');
  const appConfigPath = writeSecret(path.join(base, 'secrets', 'app.json'), '{}');
  // 只在原始 JSON 里：加载后的 profile 不认识这个键。
  const fromRaw = maskList({ rawProfile: { nested: { customTokenFile: customToken } }, profile: {}, env: {} });
  assert.ok(fromRaw.files.includes(customToken), '原始 profile 的新键要遮');
  // 只在加载后的 profile 里：App 私钥由 profile.mjs 从 App 配置读出，原始 JSON 里只有 appConfigPath。
  const fromLoaded = maskList({ rawProfile: { appConfigPath }, profile: { appConfigPath, appPrivateKeyFile: appKey }, env: {} });
  assert.ok(fromLoaded.files.includes(appKey), 'App 私钥要遮');
  assert.ok(fromLoaded.files.includes(appConfigPath), 'App 配置文件本身要遮');
});

test('SC11 buildBwrapArgs：可写绑定在只读根之后、遮罩在最后；状态目录重叠直接拒绝', () => {
  const home = tmpDir();
  const stateDir = path.join(tmpDir(), 'acc-state');
  const worktreeDir = path.join(tmpDir(), 'acc-worktree');
  const roundDir = path.join(tmpDir(), 'round');
  const tokenFile = writeSecret(path.join(tmpDir(), 'secrets', 'github.token'), 'not-a-real-token');
  const hostHome = tmpDir();
  const profile = { stateDir, worktreeDir, githubTokenFile: tokenFile };
  const args = buildBwrapArgs({
    home,
    profile,
    roundDir,
    masks: { files: [tokenFile], dirs: [path.join(home, 'state')] },
    binds: [stateDir, worktreeDir],
    hostHome,
  });
  // 网络：自己的命名空间（--unshare-net），不再 --share-net。
  assert.ok(args.includes('--unshare-net'));
  assert.equal(args.includes('--share-net'), false);
  // 环境变量不进参数（值会出现在 /proc/<pid>/cmdline）。
  assert.equal(args.includes('--setenv'), false);
  assert.equal(args.includes('--clearenv'), false);
  if (fs.existsSync('/run')) {
    const runAt = args.indexOf(fs.realpathSync('/run'));
    assert.equal(args[runAt - 1], '--tmpfs', '/run 整个盖空 tmpfs');
  }
  assert.deepEqual(args.slice(0, 2), ['--die-with-parent', '--new-session']);
  const roBind = args.indexOf('--ro-bind');
  const firstBind = args.indexOf('--bind');
  const homeMaskAt = args.indexOf(fs.realpathSync(hostHome));
  const maskAt = args.indexOf('--tmpfs', firstBind);
  assert.ok(roBind < firstBind, '可写绑定要在只读根之后');
  assert.equal(args[homeMaskAt - 1], '--tmpfs', '宿主 HOME 整个盖空 tmpfs');
  assert.ok(args.indexOf('/tmp') < homeMaskAt && homeMaskAt < firstBind, 'HOME 先盖住，可写绑定再挂回来');
  assert.ok(firstBind < maskAt, '遮罩要在可写绑定之后（最后挂，遮罩赢）');
  assert.ok(args.includes(roundDir), 'roundDir 一定可写');
  assert.deepEqual(args.slice(args.indexOf('--ro-bind', maskAt), args.indexOf('--ro-bind', maskAt) + 3), [
    '--ro-bind',
    '/dev/null',
    tokenFile,
  ]);

  assert.throws(
    () =>
      buildBwrapArgs({
        home,
        profile: { stateDir: path.join(home, 'state', 'acc-state'), worktreeDir },
        roundDir,
        masks: { files: [], dirs: [path.join(home, 'state')] },
        binds: [path.join(home, 'state', 'acc-state'), worktreeDir],
        hostHome,
      }),
    /与宿主状态目录重叠/,
  );
  assert.throws(
    () =>
      buildBwrapArgs({
        home,
        profile: { stateDir, worktreeDir },
        roundDir,
        masks: { files: [path.join(worktreeDir, 'leak.token')], dirs: [] },
        binds: [worktreeDir],
        hostHome,
      }),
    /落在可写绑定/,
  );
});

// —— 真的 bwrap ——
const bwrapAvailable = await probeBwrap(procRun);

test(
  'SC11 真 bwrap：令牌文件、App 私钥、凭证目录都读不到，roundDir 还能写',
  { skip: !bwrapAvailable ? 'bwrap 不可用（探针起不来），跳过真沙箱测试' : fixtureDirWritable(HERE) ? false : READONLY_SKIP },
  async () => {
    // 假凭证一律放在 /tmp 之外：沙箱自带 --tmpfs /tmp，放在 /tmp 里的文件不靠遮罩也读不到，测不出遮罩。
    const outside = fs.mkdtempSync(path.join(HERE, '.sandbox-real-test-'));
    after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const place = (name) => {
      const dir = path.join(outside, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const hostHome = place('host-home');
    fs.mkdirSync(path.join(hostHome, '.ssh'), { recursive: true });
    const sshSecret = path.join(hostHome, '.ssh', 'id_example');
    fs.writeFileSync(sshSecret, 'fake-ssh-key-content-not-real');

    const home = place('watcher-home');
    const stateDir = place('acc-state');
    const worktreeDir = place('acc-worktree');
    const tokenContent = 'fake-github-token-content-not-real';
    const slackContent = 'fake-slack-token-content-not-real';
    const keyContent = 'fake-app-private-key-content-not-real';
    const linkedContent = 'fake-linked-token-content-not-real';
    const secrets = place('secrets');
    const tokenFile = writeSecret(path.join(secrets, 'github.token'), tokenContent);
    const slackFile = writeSecret(path.join(secrets, 'slack.token'), slackContent);
    const privateKeyFile = writeSecret(path.join(secrets, 'app.pem'), keyContent);
    // profile 里配的是符号链接：遮罩要落到真实文件上，从两条路径都读不到。
    const linkedReal = writeSecret(path.join(place('real-store'), 'example.token'), linkedContent);
    const linkedPath = path.join(secrets, 'example-link.token');
    fs.symlinkSync(linkedReal, linkedPath);
    const appConfigPath = path.join(secrets, 'app.json');
    fs.writeFileSync(appConfigPath, JSON.stringify({ appId: '1', installationId: '2', privateKeyFile }));
    fs.chmodSync(appConfigPath, 0o600);
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
    fs.mkdirSync(path.join(home, 'state', 'write-gate'), { recursive: true });
    fs.writeFileSync(path.join(home, 'state', 'write-gate', 'enabled'), '1');

    const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
    const rawProfile = JSON.parse(fs.readFileSync(path.join(home, 'config', 'profile.json'), 'utf8'));
    const roundDir = place('round');
    fs.mkdirSync(path.join(roundDir, 'home'), { recursive: true });
    fs.mkdirSync(path.join(roundDir, 'tmp'), { recursive: true });
    const socketPath = path.join(roundDir, 'gate.sock');
    const masks = maskList({ rawProfile, profile, hostConfig: {}, env: { HOME: hostHome }, home });
    const sandboxBin = path.resolve('watchers', 'acceptance', 'host', 'sandbox-bin');
    const env = sandboxEnv({ base: { ...process.env, HOME: hostHome }, roundDir, socketPath, sandboxBin });
    const args = buildBwrapArgs({ home, profile, roundDir, masks, binds: [stateDir, worktreeDir], hostHome });

    const targets = [
      tokenFile,
      slackFile,
      privateKeyFile,
      linkedPath,
      linkedReal,
      appConfigPath,
      sshSecret,
      path.join(hostHome, '.ssh'),
      path.join(home, 'state', 'write-gate', 'enabled'),
      path.join(home, 'state'),
    ];
    const reader = path.join(roundDir, 'reader.mjs');
    fs.writeFileSync(
      reader,
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
        "fs.writeFileSync('written-inside-round-dir.txt', 'ok');",
        'process.stdout.write(JSON.stringify({ readable }));',
        '',
      ].join('\n'),
    );
    const result = await procRun(
      'bwrap',
      [...args, '--', process.execPath, reader, JSON.stringify(targets)],
      { env, cwd: roundDir, timeoutMs: 120000 },
    );
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.deepEqual(parsed.readable, [], '沙箱里一个凭证都不该读到');
    for (const content of [tokenContent, slackContent, keyContent, linkedContent, 'fake-ssh-key-content-not-real']) {
      assert.equal(result.stdout.includes(content), false, '不回显假凭证内容');
    }
    assert.equal(fs.readFileSync(path.join(roundDir, 'written-inside-round-dir.txt'), 'utf8'), 'ok');
    assert.equal(fs.readFileSync(path.join(home, 'state', 'write-gate', 'enabled'), 'utf8'), '1');
  },
);

test('SC11 真 bwrap 不可用时 probeBwrap 返回 false（不抛错）', async () => {
  const missing = await probeBwrap(async () => {
    const error = new Error('spawn bwrap ENOENT');
    error.code = 'ENOENT';
    throw error;
  });
  assert.equal(missing, false);
});

test('sandboxEnv 固定关掉 npm 更新检查（不然每轮都去连 registry、被出网代理拒、刷 egress-denied）', () => {
  const env = sandboxEnv({ base: { PATH: '/usr/bin' }, roundDir: path.join(tmpDir(), 'round') });
  assert.equal(env.NPM_CONFIG_UPDATE_NOTIFIER, 'false');
  assert.equal(env.NO_UPDATE_NOTIFIER, '1');
});
