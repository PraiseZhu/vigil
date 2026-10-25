// 沙箱默认遮掉整个宿主 HOME（空 tmpfs），只把白名单目录只读挂回来。
// 前半段测参数拼装的 fail-closed；后半段用真的 bwrap（bwrap 不可用时明确跳过）：
// HOME 里不在白名单上的文件（含 .claude.json、.content-workflow.env）一律读不到，pi 照样能起。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBwrapArgs, defaultHomeAllow, probeBwrap } from './host/sandbox.mjs';
import { run as procRun } from './host/proc.mjs';
import { tmpDir } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

function baseArgs(extra = {}) {
  const roundDir = tmpDir();
  return { profile: {}, roundDir, masks: { files: [], dirs: [] }, binds: [], ...extra };
}

test('默认遮 HOME：不给宿主 HOME 就拒绝拼参数，不退回只遮名单', () => {
  assert.throws(() => buildBwrapArgs(baseArgs()), /宿主 HOME/);
  assert.throws(() => buildBwrapArgs(baseArgs({ hostHome: 'relative/home' })), /宿主 HOME/);
  assert.throws(() => buildBwrapArgs(baseArgs({ hostHome: path.join(tmpDir(), 'missing') })), /宿主 HOME 不存在/);
  assert.throws(() => buildBwrapArgs(baseArgs({ hostHome: '/' })), /根目录/);
});

test('默认遮 HOME：白名单是 HOME 本身、落在遮罩目录里，或可写绑定是 HOME，都拒绝', () => {
  const hostHome = tmpDir();
  const cred = path.join(hostHome, '.ssh');
  fs.mkdirSync(path.join(cred, 'inner'), { recursive: true });
  assert.throws(() => buildBwrapArgs(baseArgs({ hostHome, homeAllow: [hostHome] })), /就是 HOME 本身/);
  assert.throws(
    () => buildBwrapArgs(baseArgs({ hostHome, homeAllow: [path.join(cred, 'inner')], masks: { files: [], dirs: [cred] } })),
    /落在遮罩目录/,
  );
  assert.throws(() => buildBwrapArgs(baseArgs({ hostHome, binds: [hostHome] })), /宿主 HOME 本身或它的上级/);
  assert.throws(() => buildBwrapArgs(baseArgs({ hostHome, homeAllow: ['relative'] })), /绝对路径/);
});

test('默认遮 HOME：HOME 的上级不挂（挂了会把 HOME 露出来），不存在的白名单跳过，HOME 之外的不重复挂', () => {
  const hostHome = path.join(tmpDir(), 'home');
  const allowed = path.join(hostHome, 'tools');
  fs.mkdirSync(allowed, { recursive: true });
  const outside = tmpDir();
  const args = buildBwrapArgs(
    baseArgs({ hostHome, homeAllow: [path.dirname(hostHome), path.join(hostHome, 'missing'), outside, allowed] }),
  );
  const roBinds = [];
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--ro-bind') roBinds.push(args[i + 1]);
  assert.deepEqual(roBinds, ['/', fs.realpathSync(allowed)]);
});

test('defaultHomeAllow：代码仓 + node 安装目录 + host.json 的 homeAllowDirs；homeAllowDirs 写错就抛错', () => {
  const list = defaultHomeAllow({
    repoRoot: '/srv/example-repo',
    hostConfig: { homeAllowDirs: ['/srv/example-tools'] },
    execPath: process.execPath,
  });
  assert.equal(list[0], '/srv/example-repo');
  assert.equal(list[1], path.dirname(path.dirname(fs.realpathSync(process.execPath))));
  assert.equal(list.at(-1), '/srv/example-tools');
  assert.throws(() => defaultHomeAllow({ hostConfig: { homeAllowDirs: 'x' } }), /homeAllowDirs/);
  assert.throws(() => defaultHomeAllow({ hostConfig: { homeAllowDirs: ['relative'] } }), /homeAllowDirs/);
});

const bwrapAvailable = await probeBwrap(procRun);

// CI 上一定要真跑：CI 的 workflow 先装好 bwrap 并打印「bwrap ok」，这里再跳过就等于没测。
test('CI 上 bwrap 必须可用（真沙箱 contract 不许被跳过）', { skip: process.env.CI ? false : '本地不是 CI' }, () => {
  assert.equal(bwrapAvailable, true, 'CI 上 bwrap 起不来：真沙箱 contract 会被跳过');
});

test(
  '真 bwrap 默认遮 HOME：.claude.json、.content-workflow.env 和不在白名单上的文件都读不到，白名单只读，pi 照样能起',
  { skip: bwrapAvailable ? false : 'bwrap 不可用（bwrap --ro-bind / / true 起不来），跳过真沙箱测试' },
  async () => {
    // 夹具放在 /tmp 之外：沙箱自带 --tmpfs /tmp，放在 /tmp 里测不出 HOME 遮罩。
    const outside = fs.mkdtempSync(path.join(HERE, '.sandbox-home-real-test-'));
    after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const hostHome = path.join(outside, 'host-home');
    const put = (rel, content, mode = 0o600) => {
      const file = path.join(hostHome, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, { mode });
      return file;
    };
    // 不在任何遮罩名单里的 HOME 文件：老的「只遮名单」做法会漏掉它们。
    const hidden = [
      put('.claude.json', '{"example":"fake-claude-config-not-real"}'),
      put('.content-workflow.env', 'EXAMPLE_KEY=fake-workflow-env-not-real\n'),
      put('notes.txt', 'fake-private-notes-not-real'),
      put('random-dir/inner.txt', 'fake-random-dir-content-not-real'),
    ];
    const hiddenDir = path.join(hostHome, 'random-dir');
    // 白名单：pi 的安装目录、pi 配置来源目录（都在 HOME 里，和真实部署一样）。
    const toolsBin = path.join(hostHome, 'tools', 'bin');
    put(
      'tools/bin/pi',
      [
        '#!/bin/sh',
        'read -r message',
        'test -s "$HOME/.pi/agent/models.json" || { echo "no-models"; exit 3; }',
        'echo "PI_OK args=$* message=$message models=$(cat "$HOME/.pi/agent/models.json")"',
        '',
      ].join('\n'),
      0o700,
    );
    const piAgent = path.join(hostHome, 'pi-config');
    put('pi-config/models.json', '{"providers":{"example":{"apiKey":"EXAMPLE_PROXY_KEY"}}}');
    put('pi-config/settings.json', '{}');
    // 可写绑定也在 HOME 里（真实部署就是这样）。
    const roundDir = path.join(hostHome, 'watcher', 'run', 'example-owner__example-repo__1');
    const stateDir = path.join(hostHome, 'work', 'state');
    const worktreeDir = path.join(hostHome, 'work', 'worktrees');
    for (const dir of [path.join(roundDir, 'home'), path.join(roundDir, 'tmp'), stateDir, worktreeDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const env = {
      PATH: `${toolsBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: path.join(roundDir, 'home'),
      TMPDIR: path.join(roundDir, 'tmp'),
    };
    const args = buildBwrapArgs({
      profile: { stateDir, worktreeDir },
      roundDir,
      masks: { files: [], dirs: [] },
      binds: [stateDir, worktreeDir],
      hostHome,
      homeAllow: defaultHomeAllow({ repoRoot: REPO_ROOT, hostConfig: { homeAllowDirs: [path.join(hostHome, 'tools'), piAgent] } }),
    });

    // 1. 读探针：不在白名单上的一个都读不到；HOME 列出来只剩白名单和绑定的挂载点。
    const reader = path.join(roundDir, 'reader.mjs');
    fs.writeFileSync(
      reader,
      [
        "import fs from 'node:fs';",
        'const [targets, home, allowedFile] = JSON.parse(process.argv[2]);',
        'const readable = [];',
        'for (const target of targets) {',
        '  try {',
        '    const stat = fs.statSync(target);',
        "    const content = stat.isDirectory() ? fs.readdirSync(target).join(',') : fs.readFileSync(target, 'utf8');",
        '    if (content.length > 0) readable.push(target);',
        '  } catch { /* 读不到就是遮住了 */ }',
        '}',
        'let allowedWritable = true;',
        "try { fs.writeFileSync(allowedFile, 'x'); } catch { allowedWritable = false; }",
        "fs.writeFileSync('written-inside-round-dir.txt', 'ok');",
        'process.stdout.write(JSON.stringify({ readable, homeListing: fs.readdirSync(home).sort(), allowedWritable,',
        "  allowedReadable: fs.readFileSync(allowedFile.replace(/[^/]+$/, 'settings.json'), 'utf8') }));",
        '',
      ].join('\n'),
    );
    const probe = await procRun(
      'bwrap',
      [...args, '--', process.execPath, reader, JSON.stringify([[...hidden, hiddenDir], hostHome, path.join(piAgent, 'new.json')])],
      { env, cwd: roundDir, timeoutMs: 120000 },
    );
    assert.equal(probe.code, 0, probe.stderr);
    const seen = JSON.parse(probe.stdout);
    assert.deepEqual(seen.readable, [], 'HOME 里不在白名单上的文件一个都不该读到');
    assert.deepEqual(seen.homeListing, ['pi-config', 'tools', 'watcher', 'work'], 'HOME 里只剩白名单和可写绑定');
    assert.equal(seen.allowedWritable, false, '白名单是只读挂回的');
    assert.equal(seen.allowedReadable, '{}');
    for (const marker of ['fake-claude-config', 'fake-workflow-env', 'fake-private-notes', 'fake-random-dir']) {
      assert.equal(probe.stdout.includes(marker), false, '不回显 HOME 里的内容');
    }
    assert.equal(fs.readFileSync(path.join(roundDir, 'written-inside-round-dir.txt'), 'utf8'), 'ok');
    assert.equal(fs.existsSync(path.join(piAgent, 'new.json')), false);

    // 2. pi 照样能起：和部署的 piCommand 同一个形状（把配置拷进沙箱 HOME 再 exec pi）。
    const piCommand = [
      'sh',
      '-c',
      `mkdir -p "$HOME/.pi/agent" && cp ${path.join(piAgent, 'models.json')} ${path.join(piAgent, 'settings.json')} "$HOME/.pi/agent/" && exec pi "$@"`,
      'pi',
      '--model',
      'example/model',
    ];
    const piRun = await procRun('bwrap', [...args, '--', ...piCommand], {
      env,
      cwd: roundDir,
      input: 'dispatch-message\n',
      timeoutMs: 120000,
    });
    assert.equal(piRun.code, 0, piRun.stderr || piRun.stdout);
    assert.match(piRun.stdout, /^PI_OK args=--model example\/model message=dispatch-message models=.*EXAMPLE_PROXY_KEY/);
  },
);
