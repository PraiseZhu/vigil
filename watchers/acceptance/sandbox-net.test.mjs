// #47 SC11：沙箱网络隔离 + 密钥不进命令行。
// 前半段测出网代理（host/egress-proxy.mjs）本身和参数拼装；后半段用真的 bwrap（bwrap 不可用时明确跳过；CI 上必须可用）：
// - 宿主 127.0.0.1 上的端口、抽象 unix socket 在沙箱里连不到（--unshare-net）；
// - /run 是空 tmpfs；
// - 经出网桥 + 代理 CONNECT 到白名单里的本地假上游能通，白名单外的不通；
// - LLM_PROXY_API_KEY 等白名单变量的值不出现在 bwrap 的参数（/proc/<pid>/cmdline）里，但沙箱里拿得到。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { runHostRound } from './host/round.mjs';
import { ENV_ALLOWLIST, buildBwrapArgs, probeBwrap, sandboxEnv } from './host/sandbox.mjs';
import { run as procRun, spawnProcess } from './host/proc.mjs';
import { runPiInSandbox, runPreflightInSandbox } from './host/prbot-sandbox.mjs';
import {
  EGRESS_BRIDGE_PORT,
  bridgeCommand,
  egressAllowFrom,
  isBlockedAddress,
  parseConnectTarget,
  startEgressProxy,
  startRoundEgress,
  throttledDenied,
  MAX_SOCKET_PATH_BYTES,
  assertSocketPath,
} from './host/egress-proxy.mjs';
import { REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

import { READONLY_SKIP, fixtureDirWritable } from './real-sandbox.fixture.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 白名单变量的哨兵值：任何一个出现在 bwrap 参数里都算泄漏。 */
const SENTINELS = {
  LLM_PROXY_API_KEY: 'sentinel-llm-proxy-key-not-real-7f3a',
  LANG: 'sentinel-lang-value-7f3a',
  TZ: 'sentinel-tz-value-7f3a',
  TERM: 'sentinel-term-value-7f3a',
  NODE_OPTIONS: '--max-old-space-size=3173',
};

/** 真沙箱里用的子集：LANG 换成正常值（怪 locale 会让 sh / git 打警告）。 */
const REAL_SENTINELS = { ...SENTINELS, LANG: 'C.UTF-8' };

function assertNoEnvInArgs(args, label) {
  assert.equal(args.includes('--setenv'), false, `${label}：参数里不该有 --setenv`);
  assert.equal(args.includes('--clearenv'), false, `${label}：参数里不该有 --clearenv`);
  for (const [key, value] of Object.entries(SENTINELS)) {
    assert.equal(
      args.some((arg) => String(arg).includes(value)),
      false,
      `${label}：${key} 的值出现在 bwrap 参数里`,
    );
  }
}

/** 本地 TCP echo 当假上游：收到什么回什么。 */
async function echoServer() {
  const server = net.createServer((socket) => socket.pipe(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => server.close());
  return server.address().port;
}

/** 宿主侧直接对着代理 socket 发一条 CONNECT，返回首行和隧道里的回显。 */
function connectVia(socketPath, request, payload = 'ping-through-tunnel') {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    let sent = false;
    socket.on('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!sent && buffer.startsWith('HTTP/1.1 200') && buffer.includes('\r\n\r\n')) {
        sent = true;
        socket.write(payload);
      }
      if (sent && buffer.includes(payload)) socket.end();
    });
    socket.on('close', () => resolve({ status: buffer.split('\r\n')[0], echoed: buffer.includes(payload) }));
    socket.on('error', () => resolve({ status: 'error', echoed: false }));
  });
}

test('egressAllow：只认小写「host:port」，通配 / URL / 非数组都抛错；没配就是空名单', () => {
  assert.deepEqual(egressAllowFrom({}), []);
  assert.deepEqual(egressAllowFrom({ egressAllow: ['GitHub.com:443', 'github.com:443', 'llm.example.invalid:443'] }), [
    'github.com:443',
    'llm.example.invalid:443',
  ]);
  for (const bad of [['*.example.com:443'], ['https://example.com'], ['example.com'], ['example.com:0'], ['example.com:70000'], [''], [1]]) {
    assert.throws(() => egressAllowFrom({ egressAllow: bad }), /egressAllow/, JSON.stringify(bad));
  }
  assert.throws(() => egressAllowFrom({ egressAllow: 'github.com:443' }), /egressAllow/);
});

test('出网代理的小工具：CONNECT 目标解析、环回 / 链路本地地址拦截、拒绝提醒节流', () => {
  assert.deepEqual(parseConnectTarget('GitHub.com:443'), { host: 'github.com', port: 443, key: 'github.com:443' });
  assert.deepEqual(parseConnectTarget('[::1]:8080'), { host: '::1', port: 8080, key: '[::1]:8080' });
  for (const bad of ['github.com', 'github.com:', ':443', 'a b:443', 'example.com:99999', 'http://example.com/']) {
    assert.equal(parseConnectTarget(bad), null, bad);
  }
  for (const blocked of ['127.0.0.1', '127.8.8.8', '0.0.0.0', '169.254.169.254', '::1', '::', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
    assert.equal(isBlockedAddress(blocked), true, blocked);
  }
  for (const open of ['140.82.112.3', '198.18.0.1', '2606:4700::1']) assert.equal(isBlockedAddress(open), false, open);

  const seen = [];
  const report = throttledDenied((info) => seen.push(info), { maxTotal: 2 });
  report({ target: 'a.example:443', reason: 'not-allowed' });
  report({ target: 'a.example:443', reason: 'not-allowed' });
  report({ target: 'b.example:443', reason: 'not-allowed' });
  report({ target: 'c.example:443', reason: 'not-allowed' });
  assert.deepEqual(seen.map((item) => item.target), ['a.example:443', 'b.example:443'], '同目标只记一次，总数封顶');
  assert.deepEqual(report.stats(), { written: 2, suppressed: 2 });
});

test('出网代理：白名单内 CONNECT 通、白名单外 403、明文 HTTP 405、环回地址默认拦（哪怕写进白名单）、连接数封顶', async () => {
  const upstream = await echoServer();
  const other = await echoServer();
  const dir = tmpDir();
  const denied = [];
  const allow = egressAllowFrom({ egressAllow: [`127.0.0.1:${upstream}`] });

  // 测试里放开环回（假上游只能在本机）；默认值见下一段。
  const open = await startEgressProxy({
    socketPath: path.join(dir, 'open.sock'),
    allow,
    onDenied: (info) => denied.push(info),
    blockedAddress: () => false,
  });
  after(() => open.stop());
  assert.equal(fs.statSync(open.socketPath).mode & 0o777, 0o600, 'socket 权限 600');
  const ok = await connectVia(open.socketPath, `CONNECT 127.0.0.1:${upstream} HTTP/1.1\r\nHost: 127.0.0.1:${upstream}\r\n\r\n`);
  assert.equal(ok.status, 'HTTP/1.1 200 Connection Established');
  assert.equal(ok.echoed, true, '隧道里的字节原样到上游再回来');
  const no = await connectVia(open.socketPath, `CONNECT 127.0.0.1:${other} HTTP/1.1\r\n\r\n`);
  assert.equal(no.status, 'HTTP/1.1 403 Forbidden');
  const plain = await connectVia(open.socketPath, `GET http://127.0.0.1:${upstream}/secret?q=1 HTTP/1.1\r\n\r\n`);
  assert.equal(plain.status, 'HTTP/1.1 405 Method Not Allowed');
  assert.deepEqual(denied, [
    { target: `127.0.0.1:${other}`, reason: 'not-allowed' },
    { target: 'GET', reason: 'not-connect' },
  ]);
  assert.equal(JSON.stringify(denied).includes('secret'), false, '明文请求的 URL 不进提醒');

  // 默认的地址拦截：白名单写了环回也不连（宿主本地的 Docker API、VNC 之类回不去）。
  const strict = await startEgressProxy({ socketPath: path.join(dir, 'strict.sock'), allow, onDenied: (info) => denied.push(info) });
  after(() => strict.stop());
  const loop = await connectVia(strict.socketPath, `CONNECT 127.0.0.1:${upstream} HTTP/1.1\r\n\r\n`);
  assert.equal(loop.status, 'HTTP/1.1 403 Forbidden');
  assert.deepEqual(denied.at(-1), { target: `127.0.0.1:${upstream}`, reason: 'blocked-address' });

  // 连接数上限：第二条直接 503。
  const tight = await startEgressProxy({
    socketPath: path.join(dir, 'tight.sock'),
    allow,
    blockedAddress: () => false,
    limits: { maxConnections: 1, maxConnectionMs: 60000, headerTimeoutMs: 5000, maxHeaderBytes: 8192, connectTimeoutMs: 5000 },
  });
  after(() => tight.stop());
  const holder = net.connect(tight.socketPath);
  await new Promise((resolve) => holder.on('connect', resolve));
  const over = await connectVia(tight.socketPath, `CONNECT 127.0.0.1:${upstream} HTTP/1.1\r\n\r\n`);
  assert.equal(over.status, 'HTTP/1.1 503 Too Many Connections');
  holder.destroy();

  // 单连接时长上限：到点两头都断。
  const short = await startEgressProxy({
    socketPath: path.join(dir, 'short.sock'),
    allow,
    blockedAddress: () => false,
    limits: { maxConnections: 4, maxConnectionMs: 200, headerTimeoutMs: 5000, maxHeaderBytes: 8192, connectTimeoutMs: 5000 },
  });
  after(() => short.stop());
  const started = Date.now();
  const closedAt = await new Promise((resolve) => {
    const socket = net.connect(short.socketPath);
    socket.on('connect', () => socket.write(`CONNECT 127.0.0.1:${upstream} HTTP/1.1\r\n\r\n`));
    socket.on('data', () => {});
    socket.on('close', () => resolve(Date.now()));
    socket.on('error', () => {});
  });
  assert.ok(closedAt - started < 5000, '超过单连接时长就被断开');
});

test('startRoundEgress：拒绝写 egress-denied 提醒（同目标只记一条）；名单来自 host.json 的 egressAllow', async () => {
  const home = tmpDir();
  const roundDir = path.join(tmpDir(), 'round');
  const egress = await startRoundEgress({
    home,
    hostConfig: { egressAllow: ['github.com:443'] },
    roundDir,
    issue: `${REPO}#1`,
    round: 2,
  });
  after(() => egress.stop());
  assert.deepEqual(egress.allow, ['github.com:443']);
  for (let i = 0; i < 3; i += 1) {
    const result = await connectVia(egress.socketPath, 'CONNECT denied.example.invalid:443 HTTP/1.1\r\n\r\n');
    assert.equal(result.status, 'HTTP/1.1 403 Forbidden');
  }
  const alerts = readAlerts(hostPaths(home)).filter((item) => item.kind === 'egress-denied');
  assert.equal(alerts.length, 1, '节流：同一目标一轮只记一条');
  assert.equal(alerts[0].issue, `${REPO}#1`);
  assert.equal(alerts[0].round, 2);
  assert.match(alerts[0].reason, /denied\.example\.invalid:443/);
  await egress.stop();
  assert.equal(fs.existsSync(egress.socketPath), false, '停了就删 socket');
});

test('密钥不进 argv：验收轮、修正轮 pi、预检拼出来的 bwrap 参数里没有任何白名单变量的值', async () => {
  const env = { ...process.env, ...SENTINELS };
  // 验收轮（host/round.mjs）
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  fs.mkdirSync(path.join(base.home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(base.home, 'config', 'host.json'), JSON.stringify({ piCommand: ['pi', '--model', 'example/model'] }));
  // 写闸总开关开着才认领（#47 SC11：关着时宿主不认领）。
  fs.mkdirSync(path.join(base.home, 'state', 'write-gate'), { recursive: true });
  fs.writeFileSync(path.join(base.home, 'state', 'write-gate', 'enabled'), '1');
  const meminfo = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(meminfo, `MemAvailable: ${8 * 1024 * 1024} kB\n`);
  const spawned = [];
  const claim = { issue: `${REPO}#1`, round: 1, commentId: 1001, bodyVersion: `sha256:${'a'.repeat(64)}` };
  const code = await runHostRound({
    home: base.home,
    issue: `${REPO}#1`,
    env,
    run: async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' }),
    runRound: (argv) =>
      argv[0] === 'start'
        ? { code: 0, stdout: `派发消息\n${JSON.stringify(claim)}\n`, stderr: '' }
        : { code: 0, stdout: `${JSON.stringify({ round: 1, status: '通过', stalled: false })}\n`, stderr: '' },
    prefetch: async () => [],
    startGate: async ({ socketPath }) => {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true });
      fs.writeFileSync(socketPath, '');
      return { socketPath, async stop() {} };
    },
    spawnPi: (options) => {
      spawned.push(options);
      return { pid: 1, stdin: { write() {}, end() {} }, kill() {}, exit: Promise.resolve({ code: 0 }) };
    },
    meminfoPath: meminfo,
    statusIntervalMs: 5,
    log: () => {},
  });
  assert.equal(code, 0);
  assert.equal(spawned.length, 1);
  assertNoEnvInArgs(spawned[0].args, '验收轮');
  assert.equal(spawned[0].env.LLM_PROXY_API_KEY, SENTINELS.LLM_PROXY_API_KEY, 'key 走 spawn 的 env');

  // 修正轮 pi 与预检（host/prbot-sandbox.mjs）
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: base.home });
  const worktree = path.join(tmpDir(), 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  const calls = [];
  const run = async (cmd, args, options = {}) => {
    calls.push({ cmd, args, options });
    return { code: 0, stdout: '', stderr: '' };
  };
  const pi = await runPiInSandbox({
    home: base.home,
    profile,
    hostConfig: {},
    roundDir: path.join(tmpDir(), 'prbot-round'),
    worktree,
    piCommand: ['pi', '--model', 'example/model'],
    prompt: 'x',
    env,
    run,
  });
  assert.equal(pi.ok, true, JSON.stringify(pi));
  assertNoEnvInArgs(pi.args, '修正轮 pi');
  const piCall = calls.find((call) => call.args.includes('pi'));
  assertNoEnvInArgs(piCall.args, '修正轮 pi（实际 spawn）');
  assert.equal(piCall.options.env.LLM_PROXY_API_KEY, SENTINELS.LLM_PROXY_API_KEY);
  const pre = await runPreflightInSandbox({
    home: base.home,
    profile,
    hostConfig: {},
    roundDir: path.join(tmpDir(), 'prbot-pre'),
    worktree,
    commands: [['sh', '-c', 'true']],
    env,
    run,
  });
  assert.equal(pre.ok, true);
  assertNoEnvInArgs(calls.at(-1).args, '预检');
  assert.equal('HTTPS_PROXY' in calls.at(-1).options.env, false, '预检不带出网变量');

  assert.throws(
    () => buildBwrapArgs({ roundDir: tmpDir(), hostHome: tmpDir(), env: { LLM_PROXY_API_KEY: 'x' } }),
    /不收 env/,
    '再传 env 进参数拼装直接报错，不悄悄忽略',
  );
});

// —— 真的 bwrap ——
const bwrapAvailable = await probeBwrap(procRun);
const SKIP = !bwrapAvailable ? 'bwrap 不可用（探针起不来），跳过真沙箱网络测试' : fixtureDirWritable(HERE) ? false : READONLY_SKIP;

test('CI 上 bwrap 必须可用（真沙箱网络 contract 不许被跳过）', { skip: process.env.CI ? false : '本地不是 CI' }, () => {
  assert.equal(bwrapAvailable, true);
});

/** 真沙箱夹具：放在 /tmp 之外（沙箱自带 --tmpfs /tmp）。 */
function realFixture() {
  const outside = fs.mkdtempSync(path.join(HERE, '.sandbox-net-test-'));
  after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const hostHome = path.join(outside, 'host-home');
  const roundDir = path.join(outside, 'round');
  for (const dir of [hostHome, path.join(roundDir, 'home'), path.join(roundDir, 'tmp')]) fs.mkdirSync(dir, { recursive: true });
  const env = sandboxEnv({
    base: { ...process.env, ...REAL_SENTINELS, HOME: hostHome, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` },
    roundDir,
    egressPort: EGRESS_BRIDGE_PORT,
  });
  const args = buildBwrapArgs({
    profile: {},
    roundDir,
    masks: { files: [], dirs: [] },
    binds: [],
    hostHome,
    homeAllow: [path.resolve(HERE, '..', '..'), path.dirname(path.dirname(fs.realpathSync(process.execPath)))],
  });
  return { outside, hostHome, roundDir, env, args };
}

test('真 bwrap：宿主 127.0.0.1 上的端口、抽象 unix socket 都连不到；/run 是空 tmpfs', { skip: SKIP }, async () => {
  const { roundDir, env, args } = realFixture();
  // 宿主上起一个 TCP 端口和一个抽象 unix socket（\0 开头，不落文件系统，靠网络命名空间隔开）。
  const tcp = net.createServer((socket) => socket.end('host-tcp-reached'));
  await new Promise((resolve) => tcp.listen(0, '127.0.0.1', resolve));
  after(() => tcp.close());
  const abstractName = `\0vigil-sandbox-net-test-${process.pid}-${Date.now()}`;
  const abstract = net.createServer((socket) => socket.end('host-abstract-reached'));
  await new Promise((resolve) => abstract.listen(abstractName, resolve));
  after(() => abstract.close());
  // 先确认宿主侧自己连得上（否则「沙箱里连不上」测不出东西）。
  const hostSide = await new Promise((resolve) => {
    const socket = net.connect(abstractName);
    socket.on('data', (chunk) => resolve(String(chunk)));
    socket.on('error', () => resolve('error'));
  });
  assert.equal(hostSide, 'host-abstract-reached');

  const probe = path.join(roundDir, 'net-probe.mjs');
  fs.writeFileSync(
    probe,
    [
      "import fs from 'node:fs';",
      "import net from 'node:net';",
      'const [port, name] = JSON.parse(process.argv[2]);',
      'const tryConnect = (target) => new Promise((resolve) => {',
      '  const socket = net.connect(target);',
      "  socket.setTimeout(3000, () => { socket.destroy(); resolve('timeout'); });",
      "  socket.on('data', (chunk) => { socket.destroy(); resolve('reached:' + chunk); });",
      "  socket.on('error', (error) => resolve('error:' + error.code));",
      '});',
      'const tcp = await tryConnect({ host: "127.0.0.1", port });',
      'const abstract = await tryConnect(name);',
      "const run = fs.readdirSync('/run');",
      "const runType = fs.statfsSync('/run').type;",
      "const ifaces = fs.readFileSync('/proc/net/dev', 'utf8').split('\\n').slice(2).map((line) => line.split(':')[0].trim()).filter(Boolean);",
      'process.stdout.write(JSON.stringify({ tcp, abstract, run, runType, ifaces }));',
      '',
    ].join('\n'),
  );
  const result = await procRun(
    'bwrap',
    [...args, '--', process.execPath, probe, JSON.stringify([tcp.address().port, abstractName])],
    { env, cwd: roundDir, timeoutMs: 60000 },
  );
  assert.equal(result.code, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.match(seen.tcp, /^error:/, `沙箱里连到了宿主 127.0.0.1 上的端口：${seen.tcp}`);
  assert.match(seen.abstract, /^error:/, `沙箱里连到了宿主的抽象 unix socket：${seen.abstract}`);
  assert.deepEqual(seen.ifaces, ['lo'], '新网络命名空间里只有 lo');
  if (fs.existsSync('/run')) {
    assert.deepEqual(seen.run, [], '/run 在沙箱里是空的');
    assert.equal(seen.runType, 0x01021994, '/run 是 tmpfs');
  }
});

test('真 bwrap：经出网桥 + 代理，白名单里的本地假上游能通，白名单外的 403；git / node 不需要 DNS', { skip: SKIP }, async () => {
  const { roundDir, env, args } = realFixture();
  const upstream = await echoServer();
  const other = await echoServer();
  const denied = [];
  const proxy = await startEgressProxy({
    socketPath: path.join(roundDir, 'egress', 'egress.sock'),
    allow: egressAllowFrom({ egressAllow: [`127.0.0.1:${upstream}`] }),
    onDenied: (info) => denied.push(info),
    // 假上游只能起在宿主的环回上；默认的环回拦截单独测过。
    blockedAddress: () => false,
  });
  after(() => proxy.stop());
  const client = path.join(roundDir, 'egress-client.mjs');
  fs.writeFileSync(
    client,
    [
      "import net from 'node:net';",
      'const [port, allowed, blocked] = JSON.parse(process.argv[2]);',
      'const proxy = new URL(process.env.HTTPS_PROXY);',
      'const viaProxy = (target) => new Promise((resolve) => {',
      '  const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });',
      "  let buffer = '';",
      '  let sent = false;',
      "  socket.on('connect', () => socket.write(`CONNECT ${target} HTTP/1.1\\r\\n\\r\\n`));",
      "  socket.on('data', (chunk) => {",
      '    buffer += chunk;',
      "    if (!sent && buffer.startsWith('HTTP/1.1 200') && buffer.includes('\\r\\n\\r\\n')) { sent = true; socket.write('hello-upstream'); }",
      "    if (sent && buffer.includes('hello-upstream')) socket.end();",
      '  });',
      "  socket.on('close', () => resolve({ status: buffer.split('\\r\\n')[0], echoed: buffer.includes('hello-upstream') }));",
      "  socket.on('error', (error) => resolve({ status: 'error:' + error.code, echoed: false }));",
      '});',
      'const ok = await viaProxy(`127.0.0.1:${allowed}`);',
      'const no = await viaProxy(`127.0.0.1:${blocked}`);',
      'process.stdout.write(JSON.stringify({ ok, no, key: process.env.LLM_PROXY_API_KEY, port: proxy.port }));',
      '',
    ].join('\n'),
  );
  const command = [
    ...bridgeCommand({ socketPath: proxy.socketPath }),
    process.execPath,
    client,
    JSON.stringify([EGRESS_BRIDGE_PORT, upstream, other]),
  ];
  const result = await procRun('bwrap', [...args, '--', ...command], { env, cwd: roundDir, timeoutMs: 60000 });
  assert.equal(result.code, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.ok.status, 'HTTP/1.1 200 Connection Established');
  assert.equal(seen.ok.echoed, true, '隧道打通，字节原样往返');
  assert.equal(seen.no.status, 'HTTP/1.1 403 Forbidden');
  assert.equal(seen.port, String(EGRESS_BRIDGE_PORT));
  assert.equal(seen.key, SENTINELS.LLM_PROXY_API_KEY, '沙箱里经继承的环境拿得到 key');
  assert.deepEqual(denied, [{ target: `127.0.0.1:${other}`, reason: 'not-allowed' }]);

  // 桥对命令透明：标准输入原样给命令（round.mjs 从这里喂派发消息），退出码照抄。
  const piped = await procRun(
    'bwrap',
    [...args, '--', ...bridgeCommand({ socketPath: proxy.socketPath }), 'sh', '-c', 'read -r line; echo "stdin:$line"; exit 7'],
    { env, cwd: roundDir, input: 'dispatch-message\n', timeoutMs: 60000 },
  );
  assert.equal(piped.code, 7, piped.stderr);
  assert.equal(piped.stdout.trim(), 'stdin:dispatch-message');

  // git 没有 DNS 也经代理走：目标不在白名单 → 代理 403，git 报的是代理拒绝而不是解析失败。
  const git = await procRun(
    'bwrap',
    [...args, '--', ...bridgeCommand({ socketPath: proxy.socketPath }), 'git', 'ls-remote', 'https://denied.example.invalid/example-org/example-repo'],
    { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, cwd: roundDir, timeoutMs: 60000 },
  );
  assert.notEqual(git.code, 0);
  assert.match(git.stderr, /403|CONNECT/i, git.stderr);
  assert.doesNotMatch(git.stderr, /resolve host/i, 'git 没去解析域名（交给代理）');
  assert.deepEqual(denied.at(-1), { target: 'denied.example.invalid:443', reason: 'not-allowed' });
});

test('真 bwrap：白名单变量的值不在 bwrap 进程的 /proc/<pid>/cmdline 里，沙箱里照样拿得到', { skip: SKIP }, async () => {
  const { roundDir, env, args } = realFixture();
  const child = spawnProcess(
    'bwrap',
    [...args, '--', 'sh', '-c', 'printf "%s" "$LLM_PROXY_API_KEY"; sleep 2'],
    { env, cwd: roundDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  const exited = new Promise((resolve) => child.on('close', resolve));
  // 进程起来、还在 sleep 时读它的 cmdline（ps 看到的就是这个）。
  await new Promise((resolve) => setTimeout(resolve, 500));
  const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`, 'utf8');
  assert.ok(cmdline.includes('--unshare-net'), '读到的是 bwrap 的 cmdline');
  for (const [key, value] of Object.entries(REAL_SENTINELS)) {
    assert.equal(cmdline.includes(value), false, `${key} 的值出现在 bwrap 的 cmdline 里`);
  }
  const code = await exited;
  assert.equal(code, 0);
  assert.equal(stdout, SENTINELS.LLM_PROXY_API_KEY);
});

test('unix socket 路径超过 107 字节：出网代理直接抛错，不在截断后的路径上挂着（不再卡死整轮）', async () => {
  const deep = path.join(tmpDir(), 'x'.repeat(60), 'y'.repeat(60));
  const socketPath = path.join(deep, 'egress.sock');
  assert.ok(Buffer.byteLength(socketPath) > MAX_SOCKET_PATH_BYTES);
  assert.throws(() => assertSocketPath(socketPath), /路径太长/);
  await assert.rejects(startEgressProxy({ socketPath, allow: [] }), /路径太长/);
  assertSocketPath(path.join(tmpDir(), 'ok.sock'));
});
