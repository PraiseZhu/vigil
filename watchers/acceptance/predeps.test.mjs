// 方案 B：宿主在模型沙箱之外按 lockfile 预装 npm 依赖（host/predeps.mjs），只读挂进沙箱；
// 沙箱的出网名单（host.json 的 egressAllow）不变，沙箱里的 npm 一律离线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { ENV_BACKOFF_MINUTES, ENV_PROBLEM_PREFIX, backoffUntil } from './bin/trigger.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import {
  DEPS_EGRESS_ALLOW,
  DEPS_ENV_ALLOWLIST,
  DepsError,
  LOCKFILES,
  NPM_CI_ARGS,
  NPM_REGISTRY,
  PNPM_INSTALL_ARGS,
  appendDepsInfo,
  depsEnv,
  findLockfile,
  lockfileManager,
  prepareDeps,
  resolvePnpm,
} from './host/predeps.mjs';
import { runHostRound } from './host/round.mjs';
import { QUIET_ENV, buildBwrapArgs, probeBwrap, sandboxEnv } from './host/sandbox.mjs';
import { run as procRun } from './host/proc.mjs';
import { REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import { READONLY_SKIP, fixtureDirWritable } from './real-sandbox.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

const SECRETS = {
  GH_TOKEN: 'gh-token-not-real',
  GITHUB_TOKEN: 'github-token-not-real',
  LLM_PROXY_API_KEY: 'llm-key-not-real',
  SLACK_BOT_TOKEN: 'slack-token-not-real',
  SLACK_WEBHOOK_URL: 'https://hooks.example.invalid/not-real',
  NPM_TOKEN: 'npm-token-not-real',
  NODE_AUTH_TOKEN: 'node-auth-not-real',
  AWS_SECRET_ACCESS_KEY: 'aws-not-real',
};

function fixture() {
  const base = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: base.home });
  const roundDir = path.join(base.home, 'run', 'example-round');
  fs.mkdirSync(roundDir, { recursive: true });
  const codeRoot = path.join(roundDir, 'code');
  return { home: base.home, profile, roundDir, codeRoot };
}

function checkout(codeRoot, name, files) {
  const dir = path.join(codeRoot, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

/** 假的 npm ci：记下参数和环境，在 --chdir 的目录里造出 node_modules（含一个 workspace 包的）。 */
function fakeNpm({ code = 0, stderr = '' } = {}) {
  const calls = [];
  const run = async (cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (code === 0) {
      const workDir = args[args.indexOf('--chdir') + 1];
      fs.mkdirSync(path.join(workDir, 'node_modules', 'left-pad'), { recursive: true });
      fs.writeFileSync(path.join(workDir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
      if (fs.existsSync(path.join(workDir, 'packages', 'web'))) {
        fs.mkdirSync(path.join(workDir, 'packages', 'web', 'node_modules', 'vite'), { recursive: true });
      }
    }
    return { code, stdout: '', stderr };
  };
  return { calls, run };
}

function fakeProxy() {
  const seen = [];
  const startProxy = async (options) => {
    seen.push(options);
    return { socketPath: options.socketPath, async stop() { seen.stopped = true; } };
  };
  return { seen, startProxy };
}

const hostConfig = () => ({ egressAllow: ['model-gateway.example.invalid:443'] });

test('有 lockfile：宿主跑 npm ci --ignore-scripts（固定官方源），装好的 node_modules 只读挂到检出目录同一位置', async () => {
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__app', {
    'package.json': '{"name":"app","workspaces":["packages/*"]}',
    'package-lock.json': '{}',
    '.npmrc': 'registry=https://registry.example.invalid/\n',
    'packages/web/package.json': '{"name":"web"}',
  });
  const npm = fakeNpm();
  const proxy = fakeProxy();
  const deps = await prepareDeps({
    home: fx.home,
    profile: fx.profile,
    hostConfig: hostConfig(),
    code: [{ repo: 'example/app', path: dir }],
    roundDir: fx.roundDir,
    env: { ...process.env, ...SECRETS },
    run: npm.run,
    repoRoot: REPO_ROOT,
    startProxy: proxy.startProxy,
  });
  assert.equal(npm.calls.length, 1);
  const { cmd, args, options } = npm.calls[0];
  assert.equal(cmd, 'bwrap');
  assert.ok(args.includes('--unshare-net'), 'npm 本身也在隔离网络里，只能走出网桥');
  const tail = args.slice(args.indexOf('npm'));
  assert.deepEqual(tail, ['npm', ...NPM_CI_ARGS]);
  assert.deepEqual(NPM_CI_ARGS.slice(0, 2), ['ci', '--ignore-scripts']);
  assert.equal(NPM_CI_ARGS[NPM_CI_ARGS.indexOf('--registry') + 1], 'https://registry.npmjs.org/');
  const workDir = args[args.indexOf('--chdir') + 1];
  assert.ok(workDir.startsWith(path.join(fx.roundDir, 'deps')), '装在本轮目录里，不进宿主 HOME');
  assert.equal(fs.existsSync(path.join(workDir, '.git')), false, '不抄 .git');
  assert.equal(fs.existsSync(path.join(workDir, '.npmrc')), false, '不抄项目 .npmrc（不许换源）');
  assert.equal(options.env.npm_config_ignore_scripts, 'true');
  assert.equal(options.env.npm_config_registry, NPM_REGISTRY);
  assert.ok(options.timeoutMs > 0);

  assert.deepEqual(
    deps.mounts.map((mount) => path.relative(dir, mount.dest)).sort(),
    ['node_modules', path.join('packages', 'web', 'node_modules')],
  );
  for (const mount of deps.mounts) {
    assert.ok(fs.statSync(mount.dest).isDirectory(), '挂载点已在检出目录里建好');
    assert.ok(mount.src.startsWith(path.join(fx.roundDir, 'deps')));
  }
  assert.deepEqual(deps.readOnlyBinds, [path.join(fx.roundDir, 'deps')]);
  assert.equal(deps.deps[0].status, 'installed');
  assert.equal(deps.deps[0].lockfile, 'package-lock.json');
  assert.ok(proxy.seen.stopped, '出网代理用完就关');

  // 拼进模型沙箱：检出目录只读、node_modules 只读挂在后面、给工具写缓存的 tmpfs 再后面；遮罩最后。
  const sandboxArgs = buildBwrapArgs({
    home: fx.home,
    profile: {},
    roundDir: fx.roundDir,
    masks: { files: [], dirs: [] },
    binds: [],
    hostHome: process.env.HOME,
    homeAllow: [],
    readOnlyBinds: [dir, ...deps.readOnlyBinds],
    readOnlyMounts: deps.mounts,
    tmpfsDirs: deps.tmpfs,
  });
  const at = (a, b, c) => sandboxArgs.findIndex((v, i) => v === a && sandboxArgs[i + 1] === b && sandboxArgs[i + 2] === c);
  const codeBind = at('--ro-bind', fs.realpathSync(dir), fs.realpathSync(dir));
  const rootMount = deps.mounts.find((mount) => mount.dest === path.join(dir, 'node_modules'));
  const nmBind = at('--ro-bind', fs.realpathSync(rootMount.src), fs.realpathSync(rootMount.dest));
  assert.ok(codeBind > 0 && nmBind > codeBind, 'node_modules 只读挂在检出目录之后');
  assert.ok(deps.tmpfs.includes(path.join(dir, 'node_modules', '.cache')));
  assert.ok(sandboxArgs.indexOf('--tmpfs', nmBind) > nmBind);
});

test('npm-shrinkwrap.json 也认（优先于 package-lock.json）；没有 package.json 不算 npm 项目', () => {
  const root = tmpDir();
  assert.equal(findLockfile(root), null);
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  assert.equal(findLockfile(root), null, '没有 package.json');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.equal(findLockfile(root), 'package-lock.json');
  fs.writeFileSync(path.join(root, 'npm-shrinkwrap.json'), '{}');
  assert.equal(findLockfile(root), 'npm-shrinkwrap.json');
});

test('没有 lockfile：不装、不起出网代理，派发消息里写明是环境限制、不能据此判不通过', async () => {
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__nolock', { 'package.json': '{"name":"nolock"}' });
  const plain = checkout(fx.codeRoot, 'example__docs', { 'README.md': '# docs' });
  const npm = fakeNpm();
  const proxy = fakeProxy();
  const deps = await prepareDeps({
    home: fx.home,
    profile: fx.profile,
    hostConfig: hostConfig(),
    code: [{ repo: 'example/nolock', path: dir }, { repo: 'example/docs', path: plain }],
    roundDir: fx.roundDir,
    run: npm.run,
    repoRoot: REPO_ROOT,
    startProxy: proxy.startProxy,
  });
  assert.equal(npm.calls.length, 0);
  assert.equal(proxy.seen.length, 0);
  assert.deepEqual(deps.mounts, []);
  assert.deepEqual(deps.readOnlyBinds, []);
  assert.deepEqual(deps.deps.map((item) => [item.repo, item.status]), [['example/nolock', 'no-lockfile']]);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
  const message = appendDepsInfo('派发消息', deps.deps);
  assert.match(message, /example\/nolock.*没有 package-lock\.json/);
  assert.match(message, /环境限制/);
  assert.match(message, /不能据此判不通过/);
  assert.match(message, /不要再跑 npm ci/);
  assert.equal(appendDepsInfo('原样', []), '原样');
});

test('预装环境：只有 PATH / LANG / TZ 和固定的 npm 配置，任何令牌（GH / LLM / Slack / npm）都不带', async () => {
  const base = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', HOME: '/home/someone', ...SECRETS, NPM_CONFIG_REGISTRY: 'https://registry.example.invalid/' };
  const env = depsEnv({ base, depsHome: '/x/home', cacheDir: '/x/cache', emptyConfig: '/x/empty', emptyGlobalConfig: '/x/empty-global' });
  for (const [key, value] of Object.entries(SECRETS)) {
    assert.equal(env[key], undefined, `${key} 不该进预装环境`);
    assert.ok(!Object.values(env).includes(value), `${key} 的值不该出现在预装环境里`);
  }
  const allowed = new Set([...DEPS_ENV_ALLOWLIST, 'HOME', 'NO_UPDATE_NOTIFIER', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']);
  for (const key of Object.keys(env)) {
    assert.ok(allowed.has(key) || key.startsWith('npm_config_'), `预装环境里多了 ${key}`);
  }
  assert.equal(env.HOME, '/x/home');
  assert.equal(env.npm_config_registry, NPM_REGISTRY);
  assert.equal(env.npm_config_ignore_scripts, 'true');
  assert.equal(env.npm_config_userconfig, '/x/empty', '不读宿主 ~/.npmrc');
  assert.equal(env.npm_config_globalconfig, '/x/empty-global');
  assert.equal(env.NPM_CONFIG_REGISTRY, undefined);

  // 实际调用时也一样（拿真 prepareDeps 的环境再查一遍）。
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__app', { 'package.json': '{}', 'package-lock.json': '{}' });
  const npm = fakeNpm();
  await prepareDeps({
    home: fx.home,
    profile: fx.profile,
    code: [{ repo: 'example/app', path: dir }],
    roundDir: fx.roundDir,
    env: { ...process.env, ...SECRETS },
    run: npm.run,
    repoRoot: REPO_ROOT,
    startProxy: fakeProxy().startProxy,
  });
  const used = npm.calls[0].options.env;
  for (const value of Object.values(SECRETS)) {
    assert.ok(!Object.values(used).includes(value));
    assert.ok(!npm.calls[0].args.includes(value), '令牌也不进 bwrap 参数');
  }
});

test('出网：预装那一步的代理只放行 registry.npmjs.org:443；host.json 的 egressAllow 原样不动', async () => {
  assert.deepEqual([...DEPS_EGRESS_ALLOW], ['registry.npmjs.org:443']);
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__app', { 'package.json': '{}', 'package-lock.json': '{}' });
  const config = hostConfig();
  const before = JSON.stringify(config);
  const proxy = fakeProxy();
  await prepareDeps({
    home: fx.home,
    profile: fx.profile,
    hostConfig: config,
    code: [{ repo: 'example/app', path: dir }],
    roundDir: fx.roundDir,
    run: fakeNpm().run,
    repoRoot: REPO_ROOT,
    startProxy: proxy.startProxy,
  });
  assert.equal(proxy.seen.length, 1);
  assert.deepEqual(proxy.seen[0].allow, ['registry.npmjs.org:443']);
  assert.equal(JSON.stringify(config), before, 'host.json 的配置对象没被改');
  // 仓里的示例配置：模型沙箱的出网名单仍只有模型网关一项，没有 npm 源。
  for (const file of ['host.example.json', 'host.json.example']) {
    const full = path.join(HERE, 'config', file);
    if (!fs.existsSync(full)) continue;
    const allow = JSON.parse(fs.readFileSync(full, 'utf8')).egressAllow || [];
    assert.ok(!allow.some((entry) => /npmjs/.test(entry)), `${file} 的 egressAllow 不该放行 npm 源`);
  }
});

test('沙箱里的 npm 离线：QUIET_ENV / sandboxEnv 带 npm_config_offline=true', () => {
  assert.equal(QUIET_ENV.npm_config_offline, 'true');
  const env = sandboxEnv({ base: { PATH: '/usr/bin', HOME: '/home/x' }, roundDir: tmpDir(), socketPath: '/tmp/x.sock', sandboxBin: '/tmp/bin', egressPort: 3128 });
  assert.equal(env.npm_config_offline, 'true');
});

test('npm ci 失败：抛 DepsError（简短原因进评论，npm 输出尾巴脱敏后只进 detail），不留半截预装目录和挂载点', async () => {
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__app', { 'package.json': '{}', 'package-lock.json': '{}' });
  const npm = fakeNpm({ code: 1, stderr: `npm ERR! network ETIMEDOUT\nnpm ERR! log at /home/someone/.npm/_logs/x.log\ntoken ${'ghp_' + 'a'.repeat(36)}\n` });
  await assert.rejects(
    prepareDeps({
      home: fx.home,
      profile: fx.profile,
      code: [{ repo: 'example/app', path: dir }],
      roundDir: fx.roundDir,
      run: npm.run,
      repoRoot: REPO_ROOT,
      startProxy: fakeProxy().startProxy,
    }),
    (error) => {
      assert.ok(error instanceof DepsError);
      assert.match(error.message, /example\/app：npm ci 失败（退出码 1）/);
      assert.doesNotMatch(error.message, /ETIMEDOUT|\/home\//, '评论里只放简短原因');
      assert.match(error.detail, /ETIMEDOUT/);
      assert.doesNotMatch(error.detail, /\/home\/someone/);
      assert.doesNotMatch(error.detail, /ghp_a{36}/);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(fx.roundDir, 'deps')), false);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
});

function roundFixture() {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  fs.writeFileSync(path.join(base.home, 'config', 'host.json'), JSON.stringify({ piCommand: ['pi'] }));
  fs.mkdirSync(hostPaths(base.home).gateDir, { recursive: true });
  fs.writeFileSync(hostPaths(base.home).enabledFile, '1');
  const meminfo = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(meminfo, 'MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n');
  return { home: base.home, meminfo };
}

test('依赖预装失败 = 环境问题：中止本轮（原因带环境问题前缀），写 deps-failed 提醒，不起 pi、不出任何结论', async () => {
  const fx = roundFixture();
  const claim = { issue: `${REPO}#1`, round: 1, commentId: 1001, bodyVersion: `sha256:${'b'.repeat(64)}` };
  const roundCalls = [];
  const piCalls = [];
  let gateStarted = 0;
  const code = await runHostRound({
    home: fx.home,
    issue: `${REPO}#1`,
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: async (argv) => {
      roundCalls.push(argv);
      if (argv[0] === 'start') return { code: 0, stdout: `派发消息\n${JSON.stringify(claim)}\n`, stderr: '' };
      return { code: 0, stdout: '{}\n', stderr: '' };
    },
    startGate: async () => {
      gateStarted += 1;
      return { async stop() {} };
    },
    prefetch: async () => [{ repo: REPO, path: '/nonexistent' }],
    predeps: async () => {
      throw new DepsError(`${REPO}：npm ci 失败（退出码 1）`, 'npm ERR! network');
    },
    spawnPi: (options) => {
      piCalls.push(options);
      throw new Error('不该起 pi');
    },
    meminfoPath: fx.meminfo,
    log: () => {},
  });
  assert.notEqual(code, 0);
  assert.equal(piCalls.length, 0, '不起 pi');
  assert.equal(gateStarted, 0, '写闸 serve 都不起');
  const abort = roundCalls.find((argv) => argv[0] === 'abort');
  assert.ok(abort, '中止本轮');
  const reason = abort[abort.indexOf('--reason') + 1];
  assert.ok(reason.startsWith(ENV_PROBLEM_PREFIX), '原因写明是环境问题');
  assert.match(reason, /依赖预装失败/);
  assert.equal(roundCalls.some((argv) => argv[0] === 'finish' || argv[0] === 'verdict'), false, '不出任何结论');
  const alerts = readAlerts(hostPaths(fx.home)).filter((entry) => entry.kind === 'deps-failed');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].detail, 'npm ERR! network');
});

test('环境问题中断的退避更长（30 分钟 → 2 小时 → 6 小时封顶），普通中断不变', () => {
  const env = (round, at) => ({ round, status: '中断', reason: `${ENV_PROBLEM_PREFIX}依赖预装失败：x`, finishedAt: at, createdAt: at });
  const one = [env(1, '2026-10-24T01:00:00.000Z')];
  assert.equal(Date.parse(backoffUntil(one)) - Date.parse('2026-10-24T01:00:00.000Z'), ENV_BACKOFF_MINUTES[0] * 60000);
  assert.equal(ENV_BACKOFF_MINUTES[0], 30);
  const two = [...one, env(2, '2026-10-24T02:00:00.000Z')];
  assert.equal(Date.parse(backoffUntil(two)) - Date.parse('2026-10-24T02:00:00.000Z'), 120 * 60000);
  const five = [...two, env(3, '2026-10-24T03:00:00.000Z'), env(4, '2026-10-24T04:00:00.000Z'), env(5, '2026-10-24T05:00:00.000Z')];
  assert.equal(Date.parse(backoffUntil(five)) - Date.parse('2026-10-24T05:00:00.000Z'), 360 * 60000);
  const plain = [{ round: 1, status: '中断', reason: '卡住', finishedAt: '2026-10-24T01:00:00.000Z' }];
  assert.equal(backoffUntil(plain), '2026-10-24T01:00:00.000Z', '普通中断第一次照旧立即重试');
});

const bwrapAvailable = await probeBwrap(procRun);

test(
  '真 bwrap：预装的 node_modules 在检出目录里读得到、写不进；tmpfs 缓存目录可写',
  { skip: !bwrapAvailable ? 'bwrap 不可用（探针起不来），跳过真沙箱测试' : fixtureDirWritable(HERE) ? false : READONLY_SKIP },
  async () => {
    const outside = fs.mkdtempSync(path.join(HERE, '.predeps-real-test-'));
    try {
      const code = path.join(outside, 'code');
      const nmDest = path.join(code, 'node_modules');
      const nmSrc = path.join(outside, 'deps', 'node_modules');
      fs.mkdirSync(nmDest, { recursive: true });
      fs.mkdirSync(path.join(nmSrc, 'left-pad'), { recursive: true });
      fs.mkdirSync(path.join(nmSrc, '.cache'));
      fs.writeFileSync(path.join(nmSrc, 'left-pad', 'index.js'), 'ok');
      const roundDir = path.join(outside, 'round');
      fs.mkdirSync(roundDir);
      const args = buildBwrapArgs({
        profile: {},
        roundDir,
        masks: { files: [], dirs: [] },
        binds: [],
        hostHome: process.env.HOME,
        homeAllow: [],
        readOnlyBinds: [code, path.join(outside, 'deps')],
        readOnlyMounts: [{ src: nmSrc, dest: nmDest }],
        tmpfsDirs: [path.join(nmDest, '.cache')],
      });
      const script = `cat ${nmDest}/left-pad/index.js; touch ${nmDest}/x 2>/dev/null && echo WROTE || echo RO; touch ${nmDest}/.cache/y && echo CACHE`;
      const result = await procRun('bwrap', [...args, '/bin/sh', '-c', script], { timeoutMs: 20000 });
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /^ok/);
      assert.match(result.stdout, /RO/);
      assert.match(result.stdout, /CACHE/);
      assert.equal(fs.existsSync(path.join(nmSrc, 'x')), false);
      assert.equal(fs.existsSync(path.join(nmSrc, '.cache', 'y')), false, '缓存写在 tmpfs 里，不落到预装目录');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  },
);

test('只读挂载的目标不在只读挂载里、或 tmpfs 不在挂载目标里：拒绝拼参数', () => {
  const root = tmpDir();
  const code = path.join(root, 'code');
  const src = path.join(root, 'src');
  fs.mkdirSync(path.join(code, 'node_modules', '.cache'), { recursive: true });
  fs.mkdirSync(src);
  const base = { profile: {}, roundDir: path.join(root, 'r'), masks: { files: [], dirs: [] }, binds: [], hostHome: process.env.HOME, homeAllow: [] };
  fs.mkdirSync(base.roundDir);
  assert.throws(
    () => buildBwrapArgs({ ...base, readOnlyBinds: [], readOnlyMounts: [{ src, dest: path.join(code, 'node_modules') }] }),
    /不在任何只读挂载里/,
  );
  assert.throws(
    () => buildBwrapArgs({ ...base, readOnlyBinds: [code], readOnlyMounts: [{ src, dest: path.join(code, 'missing') }] }),
    /目标不存在/,
  );
  assert.throws(() => buildBwrapArgs({ ...base, readOnlyBinds: [code], tmpfsDirs: [path.join(code, 'node_modules', '.cache')] }), /不在只读挂载的目标里/);
});

test('只认本轮 <roundDir>/code 下的检出：别处的目录即使有 lockfile 也不拷、不装、不建挂载点', async () => {
  const fx = fixture();
  const elsewhere = tmpDir();
  fs.writeFileSync(path.join(elsewhere, 'package.json'), '{}');
  fs.writeFileSync(path.join(elsewhere, 'package-lock.json'), '{}');
  const npm = fakeNpm();
  const deps = await prepareDeps({
    home: fx.home,
    profile: fx.profile,
    code: [{ repo: 'example/elsewhere', path: elsewhere }],
    roundDir: fx.roundDir,
    run: npm.run,
    repoRoot: REPO_ROOT,
    startProxy: fakeProxy().startProxy,
  });
  assert.equal(npm.calls.length, 0);
  assert.deepEqual(deps.deps, []);
  assert.equal(fs.existsSync(path.join(elsewhere, 'node_modules')), false);
});

// ---- pnpm（#pnpm 预装）：仓根只有 pnpm-lock.yaml 的仓（比如 pnpm workspace）也由宿主预装 ----

/** 假的 pnpm：宿主上「找到了」一个 pnpm 入口（不碰真文件系统里的 pnpm）。 */
const FAKE_PNPM = Object.freeze({ command: '/fake/node22/bin/node', args: ['/fake/corepack/v1/pnpm/10.0.0/bin/pnpm.cjs'], entry: '/fake/corepack/v1/pnpm/10.0.0/bin/pnpm.cjs', version: '10.0.0' });

test('pnpm-lock.yaml 也认；仓根同时有 npm 和 pnpm 的 lockfile 时按 npm（npm 仓行为不变）', () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  assert.equal(findLockfile(root), null, '没有 package.json');
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  assert.equal(findLockfile(root), 'pnpm-lock.yaml');
  assert.equal(lockfileManager('pnpm-lock.yaml'), 'pnpm');
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  assert.equal(findLockfile(root), 'package-lock.json', 'npm 的 lockfile 优先');
  assert.equal(lockfileManager('package-lock.json'), 'npm');
  fs.writeFileSync(path.join(root, 'npm-shrinkwrap.json'), '{}');
  assert.equal(findLockfile(root), 'npm-shrinkwrap.json');
  assert.deepEqual([...LOCKFILES], ['npm-shrinkwrap.json', 'package-lock.json'], 'npm 的 lockfile 名单原样');
  const dirLock = tmpDir();
  fs.writeFileSync(path.join(dirLock, 'package.json'), '{}');
  fs.mkdirSync(path.join(dirLock, 'pnpm-lock.yaml'));
  assert.equal(findLockfile(dirLock), null, '同名目录不算 lockfile');
});

test('pnpm 仓：宿主跑 pnpm install --frozen-lockfile --ignore-scripts（固定官方源、store 在 <home>/cache/pnpm-store），挂载和 npm 一样只读', async () => {
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__mono', {
    'package.json': '{"name":"mono","packageManager":"pnpm@10.0.0"}',
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
    '.npmrc': 'registry=https://registry.example.invalid/\n//registry.example.invalid/:_authToken=npm-token-not-real\nnode-linker=hoisted\nshamefully-hoist=maybe\n',
    'packages/web/package.json': '{"name":"web"}',
  });
  const npm = fakeNpm();
  const proxy = fakeProxy();
  const deps = await prepareDeps({
    home: fx.home,
    profile: fx.profile,
    hostConfig: hostConfig(),
    code: [{ repo: 'example/mono', path: dir }],
    roundDir: fx.roundDir,
    env: { ...process.env, ...SECRETS },
    run: npm.run,
    repoRoot: REPO_ROOT,
    startProxy: proxy.startProxy,
    findPnpm: () => FAKE_PNPM,
  });
  assert.equal(npm.calls.length, 1);
  const { cmd, args, options } = npm.calls[0];
  assert.equal(cmd, 'bwrap');
  assert.ok(args.includes('--unshare-net'), 'pnpm 也在隔离网络里，只能走出网桥');
  const tail = args.slice(args.indexOf(FAKE_PNPM.command));
  assert.deepEqual(tail, [FAKE_PNPM.command, ...FAKE_PNPM.args, ...PNPM_INSTALL_ARGS], '用解析出的绝对路径跑，不靠 PATH 里的 pnpm（corepack 会去下载别的版本）');
  assert.ok(!args.includes('npm'), '不跑 npm ci');
  assert.deepEqual(PNPM_INSTALL_ARGS.slice(0, 3), ['install', '--frozen-lockfile', '--ignore-scripts']);
  assert.equal(PNPM_INSTALL_ARGS[PNPM_INSTALL_ARGS.indexOf('--registry') + 1], 'https://registry.npmjs.org/');
  const workDir = args[args.indexOf('--chdir') + 1];
  assert.ok(workDir.startsWith(path.join(fx.roundDir, 'deps')));
  assert.equal(fs.existsSync(path.join(workDir, '.npmrc')), false, '不抄项目 .npmrc（不许换源、不带令牌）');
  assert.ok(fs.existsSync(path.join(workDir, 'pnpm-workspace.yaml')), 'workspace 配置照抄');

  const env = options.env;
  const store = path.join(fx.home, 'cache', 'pnpm-store');
  assert.equal(env.npm_config_store_dir, store);
  assert.equal(fs.statSync(store).mode & 0o777, 0o700, 'store 目录 700');
  assert.equal(fs.statSync(path.join(fx.home, 'cache', 'pnpm-cache')).mode & 0o777, 0o700);
  assert.ok(!store.startsWith(fx.roundDir), 'store 不在本轮目录（沙箱可写区）里');
  assert.ok(args.some((v, i) => v === '--bind' && args[i + 1] === store), 'store 只在预装这一步可写');
  assert.equal(env.npm_config_registry, NPM_REGISTRY);
  assert.equal(env.npm_config_ignore_scripts, 'true');
  assert.equal(env.npm_config_frozen_lockfile, 'true');
  assert.equal(env.npm_config_manage_package_manager_versions, 'false', '不按 packageManager 字段自己去下别的 pnpm');
  assert.equal(env.COREPACK_ENABLE_STRICT, '0');
  assert.equal(env.npm_config_node_linker, 'hoisted', '项目 .npmrc 里的 node-linker 照仓的设计用');
  assert.equal(env.npm_config_shamefully_hoist, undefined, '不认的值不带');
  const allowed = new Set([...DEPS_ENV_ALLOWLIST, 'HOME', 'NO_UPDATE_NOTIFIER', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'COREPACK_ENABLE_STRICT', 'COREPACK_ENABLE_NETWORK', 'CI']);
  for (const key of Object.keys(env)) {
    assert.ok(allowed.has(key) || key.startsWith('npm_config_'), `预装环境里多了 ${key}`);
  }
  for (const value of Object.values(SECRETS)) {
    assert.ok(!Object.values(env).includes(value), '令牌不进 pnpm 的环境');
    assert.ok(!args.includes(value), '令牌不进 bwrap 参数');
  }
  assert.ok(!Object.values(env).some((value) => /registry\.example\.invalid/.test(value)), '项目 .npmrc 的源不带');

  assert.deepEqual(
    deps.mounts.map((mount) => path.relative(dir, mount.dest)).sort(),
    ['node_modules', path.join('packages', 'web', 'node_modules')],
  );
  assert.deepEqual(deps.readOnlyBinds, [path.join(fx.roundDir, 'deps')]);
  assert.ok(deps.tmpfs.includes(path.join(dir, 'node_modules', '.cache')));
  assert.equal(deps.deps[0].status, 'installed');
  assert.equal(deps.deps[0].lockfile, 'pnpm-lock.yaml');
  assert.equal(deps.deps[0].manager, 'pnpm');
  assert.deepEqual(proxy.seen[0].allow, ['registry.npmjs.org:443'], '出网名单和 npm 一样只有官方源');
  assert.ok(proxy.seen.stopped);

  const message = appendDepsInfo('派发消息', deps.deps);
  assert.match(message, /example\/mono：已按 pnpm-lock\.yaml 预装（pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(message, /不要再跑 pnpm install/);
  assert.match(message, new RegExp(`node ${FAKE_PNPM.entry.replace(/[.]/g, '\\.')}`), '告诉评审沙箱里怎么离线跑 pnpm 脚本');
  assert.doesNotMatch(message, /npm-token-not-real/);
});

test('npm 和 pnpm 的 lockfile 并存：照旧跑 npm ci，不找 pnpm', async () => {
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__both', { 'package.json': '{}', 'package-lock.json': '{}', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
  const npm = fakeNpm();
  let looked = 0;
  const deps = await prepareDeps({
    home: fx.home,
    profile: fx.profile,
    code: [{ repo: 'example/both', path: dir }],
    roundDir: fx.roundDir,
    run: npm.run,
    repoRoot: REPO_ROOT,
    startProxy: fakeProxy().startProxy,
    findPnpm: () => {
      looked += 1;
      return FAKE_PNPM;
    },
  });
  assert.equal(looked, 0);
  const { args, options } = npm.calls[0];
  assert.deepEqual(args.slice(args.indexOf('npm')), ['npm', ...NPM_CI_ARGS]);
  assert.equal(options.env.npm_config_store_dir, undefined, 'npm 的环境不加 pnpm 的配置');
  assert.equal(options.env.COREPACK_ENABLE_STRICT, undefined);
  assert.equal(deps.deps[0].lockfile, 'package-lock.json');
  assert.equal(deps.deps[0].manager, 'npm');
  const message = appendDepsInfo('派发消息', deps.deps);
  assert.match(message, /已按 package-lock\.json 预装（npm ci --ignore-scripts/);
  assert.doesNotMatch(message, /pnpm/);
});

test('宿主上找不到 pnpm：抛 DepsError（人话：哪个仓、缺什么、怎么办，不带路径和令牌），不留半截预装目录和挂载点，不起 pnpm', async () => {
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__mono', { 'package.json': '{}', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
  const npm = fakeNpm();
  await assert.rejects(
    prepareDeps({
      home: fx.home,
      profile: fx.profile,
      code: [{ repo: 'example/mono', path: dir }],
      roundDir: fx.roundDir,
      env: { ...process.env, ...SECRETS, PATH: `/home/x/${SECRETS.GH_TOKEN}/bin:/usr/bin` },
      run: npm.run,
      repoRoot: REPO_ROOT,
      startProxy: fakeProxy().startProxy,
      findPnpm: () => null,
    }),
    (error) => {
      assert.ok(error instanceof DepsError);
      assert.match(error.message, /example\/mono/);
      assert.match(error.message, /pnpm-lock\.yaml/);
      assert.match(error.message, /宿主上找不到 pnpm/);
      assert.match(error.message, /装好 pnpm/);
      assert.doesNotMatch(`${error.message} ${error.detail || ''}`, /\/home\/|not-real/);
      return true;
    },
  );
  assert.equal(npm.calls.length, 0);
  assert.equal(fs.existsSync(path.join(fx.roundDir, 'deps')), false);
  assert.equal(fs.existsSync(path.join(dir, 'node_modules')), false);
});

test('pnpm install 失败：DepsError 写「pnpm install 失败」，输出尾巴脱敏只进 detail', async () => {
  const fx = fixture();
  const dir = checkout(fx.codeRoot, 'example__mono', { 'package.json': '{}', 'pnpm-lock.yaml': "lockfileVersion: '9.0'\n" });
  const npm = fakeNpm({ code: 1, stderr: `ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile"\nat /home/someone/x\ntoken ${'ghp_' + 'b'.repeat(36)}\n` });
  await assert.rejects(
    prepareDeps({
      home: fx.home,
      profile: fx.profile,
      code: [{ repo: 'example/mono', path: dir }],
      roundDir: fx.roundDir,
      run: npm.run,
      repoRoot: REPO_ROOT,
      startProxy: fakeProxy().startProxy,
      findPnpm: () => FAKE_PNPM,
    }),
    (error) => {
      assert.ok(error instanceof DepsError);
      assert.match(error.message, /example\/mono：pnpm install 失败（退出码 1）/);
      assert.match(error.detail, /OUTDATED_LOCKFILE/);
      assert.doesNotMatch(error.detail, /\/home\/someone|ghp_b{36}/);
      return true;
    },
  );
  assert.equal(fs.existsSync(path.join(fx.roundDir, 'deps')), false);
});

test('resolvePnpm：PATH 里的独立 pnpm 直接用；corepack 垫片改用 corepack 缓存里的 pnpm.cjs（不经 corepack、不下载）；都没有返回 null', () => {
  const root = tmpDir();
  const execPath = '/fake/node';
  // 1) 独立的 pnpm 可执行文件。
  const binA = path.join(root, 'a', 'bin');
  fs.mkdirSync(binA, { recursive: true });
  fs.writeFileSync(path.join(binA, 'pnpm'), '#!/bin/sh\n', { mode: 0o755 });
  const a = resolvePnpm({ env: { PATH: binA }, execPath, corepackHomes: [] });
  assert.equal(a.command, path.join(binA, 'pnpm'));
  assert.deepEqual(a.args, []);
  // 2) npm 全局装的 pnpm（bin 是 .cjs 的符号链接）：用 node 跑。
  const binB = path.join(root, 'b', 'bin');
  const pkgB = path.join(root, 'b', 'lib', 'node_modules', 'pnpm', 'bin');
  fs.mkdirSync(binB, { recursive: true });
  fs.mkdirSync(pkgB, { recursive: true });
  fs.writeFileSync(path.join(pkgB, 'pnpm.cjs'), '');
  fs.symlinkSync(path.join(pkgB, 'pnpm.cjs'), path.join(binB, 'pnpm'));
  const b = resolvePnpm({ env: { PATH: binB }, execPath, corepackHomes: [] });
  assert.equal(b.command, execPath);
  assert.deepEqual(b.args, [fs.realpathSync(path.join(pkgB, 'pnpm.cjs'))]);
  // 3) corepack 垫片：取 lastKnownGood 指的那个缓存版本。
  const binC = path.join(root, 'c', 'bin');
  const shim = path.join(root, 'c', 'lib', 'node_modules', 'corepack', 'dist');
  fs.mkdirSync(binC, { recursive: true });
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'pnpm.js'), '');
  fs.symlinkSync(path.join(shim, 'pnpm.js'), path.join(binC, 'pnpm'));
  const corepackHome = path.join(root, 'corepack');
  for (const version of ['9.15.0', '10.34.6', '10.4.0']) {
    fs.mkdirSync(path.join(corepackHome, 'v1', 'pnpm', version, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(corepackHome, 'v1', 'pnpm', version, 'bin', 'pnpm.cjs'), '');
  }
  fs.writeFileSync(path.join(corepackHome, 'lastKnownGood.json'), '{"pnpm":"10.4.0"}');
  const c = resolvePnpm({ env: { PATH: binC }, execPath, corepackHomes: [corepackHome] });
  assert.equal(c.command, execPath);
  assert.deepEqual(c.args, [path.join(corepackHome, 'v1', 'pnpm', '10.4.0', 'bin', 'pnpm.cjs')]);
  assert.equal(c.version, '10.4.0');
  fs.rmSync(path.join(corepackHome, 'lastKnownGood.json'));
  assert.equal(resolvePnpm({ env: { PATH: binC }, execPath, corepackHomes: [corepackHome] }).version, '10.34.6', '没有 lastKnownGood 取最高版本');
  // corepack 垫片但缓存里没有 pnpm：不算找到（垫片会去下载）。
  assert.equal(resolvePnpm({ env: { PATH: binC }, execPath, corepackHomes: [path.join(root, 'none')], fallbackDirs: [] }), null);
  // 4) 都没有。
  assert.equal(resolvePnpm({ env: { PATH: path.join(root, 'empty') }, execPath, corepackHomes: [], fallbackDirs: [] }), null);
});
