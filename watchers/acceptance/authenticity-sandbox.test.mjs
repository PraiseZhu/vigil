// 认领快照只读视图：真 bwrap 里 helper 能读同一份宿主快照，但不能改/删/重建；
// 缺逐条证据的关单/看板通过在任何外部副作用之前拒绝。同 profile 的 mock 不够。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { snapshotDir, snapshotPath, readClaimSnapshot } from './bin/authenticity.mjs';
import { createGate, startGateServer } from './host/write-gate.mjs';
import { hostPaths } from './host/paths.mjs';
import {
  buildBwrapArgs,
  claimSnapshotOverlays,
  defaultHomeAllow,
  maskList,
  prepareSandboxProfile,
  probeBwrap,
  sandboxEnv,
} from './host/sandbox.mjs';
import { run as procRun } from './host/proc.mjs';
import { tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';
import { READONLY_SKIP, fixtureDirWritable } from './real-sandbox.fixture.mjs';
import {
  ALL_RAN,
  OWNER,
  REPO,
  claimWorld,
  createFakeGithub,
  machineConclusions,
  machineOnlyTree,
  writeJsonFile,
} from './session.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const ROOT = `${REPO}#1`;
const HELPER = path.join(HERE, 'bin', 'helper.mjs');
const GATE_CLIENT = path.join(HERE, 'host', 'gate-client.mjs');

function endsWithSnapshots(dir) {
  return dir.replace(/\\/g, '/').endsWith('/state/host/snapshots');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeBody(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, body);
  return { file, body, hash: sha256File(file) };
}

function overlayFixture() {
  const home = tmpDir();
  const stateDir = tmpDir();
  const worktreeDir = tmpDir();
  const hostHome = tmpDir();
  const roundDir = tmpDir();
  writeProfile(home, { profile: { stateDir, worktreeDir } });
  const tokenFile = writeSecret(path.join(home, 'secrets', 'github.token'), 'owner-token');
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true, mode: 0o700 });
  const hostSnapshots = snapshotDir(profile);
  fs.mkdirSync(hostSnapshots, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(hostSnapshots, 'marker.json'), '{"ok":true}\n');
  const prepared = prepareSandboxProfile({
    profile,
    roundDir,
    repoRoot: REPO_ROOT,
    socketPath: path.join(roundDir, 'g.sock'),
  });
  const dest = path.join(prepared.sandboxHome, 'state', 'host', 'snapshots');
  const rawProfile = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
  const masks = maskList({ rawProfile, profile, hostConfig: {}, env: { HOME: hostHome }, home });
  return {
    home,
    profile,
    hostHome,
    roundDir,
    stateDir,
    worktreeDir,
    hostSnapshots,
    dest,
    prepared,
    masks,
    tokenFile,
  };
}

test('P1/P2 沙箱参数：只叠本轮快照文件并只读重挂视图，拒绝整个 snapshots 目录', () => {
  const fx = overlayFixture();
  assert.ok(endsWithSnapshots(fx.hostSnapshots));
  assert.ok(endsWithSnapshots(fx.dest));
  assert.equal(fx.dest.startsWith(path.join(fx.roundDir, 'home-acc')), true);
  assert.throws(
    () =>
      buildBwrapArgs({
        home: fx.home,
        profile: fx.profile,
        roundDir: fx.roundDir,
        masks: fx.masks,
        binds: [fx.stateDir, fx.worktreeDir],
        hostHome: fx.hostHome,
        readOnlyOverlays: [{ src: fx.hostSnapshots, dest: fx.dest }],
      }),
    /整个 snapshots|本轮快照文件/,
  );

  const srcFile = snapshotPath(fx.profile, ROOT, 1);
  fs.writeFileSync(srcFile, '{"ok":true}\n');
  const overlays = claimSnapshotOverlays({ snapshotView: fx.dest, srcFile });
  const destFile = path.join(fx.dest, path.basename(srcFile));
  assert.equal(fs.existsSync(destFile), false, '不得在派生路径上创建/截断挂载点文件');
  const args = buildBwrapArgs({
    home: fx.home,
    profile: fx.profile,
    roundDir: fx.roundDir,
    masks: fx.masks,
    binds: [fx.stateDir, fx.worktreeDir],
    hostHome: fx.hostHome,
    readOnlyOverlays: overlays,
  });
  const bindRound = args.findIndex((value, i) => value === '--bind' && args[i + 1] === fx.roundDir);
  const tmpfsAt = args.findIndex((value, i) => value === '--tmpfs' && args[i + 1] === path.resolve(fx.dest));
  const overlayAt = args.findIndex(
    (value, i) => value === '--ro-bind' && args[i + 1] === path.resolve(srcFile) && args[i + 2] === path.resolve(destFile),
  );
  const remountAt = args.findIndex((value, i) => value === '--remount-ro' && args[i + 1] === path.resolve(fx.dest));
  assert.ok(bindRound >= 0, 'roundDir 必须可写绑定');
  assert.ok(tmpfsAt >= 0, '快照视图目录必须盖空 tmpfs');
  assert.ok(overlayAt >= 0, '必须把本轮宿主快照文件只读叠到沙箱派生路径');
  assert.ok(remountAt >= 0, '快照视图目录必须 remount-ro');
  assert.ok(tmpfsAt > bindRound, '空 tmpfs 必须在可写 roundDir 之后');
  assert.ok(overlayAt > tmpfsAt, '本轮文件叠挂必须在空 tmpfs 之后');
  assert.ok(remountAt > overlayAt, 'remount-ro 必须在文件叠挂之后');
  const stateReal = fs.realpathSync(path.join(fx.home, 'state'));
  const maskAt = args.findIndex((value, i) => value === '--tmpfs' && args[i + 1] === stateReal);
  if (maskAt >= 0) assert.ok(overlayAt < maskAt, '先叠快照再遮原宿主状态');
  assert.equal(
    args.some((value, i) => value === '--ro-bind' && args[i + 1] === args[i + 2] && path.resolve(args[i + 1]) === path.resolve(fx.dest)),
    false,
    '不能 dest→dest 重挂可写 roundDir 里的派生目录',
  );
  assert.equal(
    args.some((value, i) => value === '--ro-bind' && args[i + 1] === fs.realpathSync(fx.hostSnapshots)),
    false,
    '不能把整个宿主 snapshots 目录叠进沙箱',
  );

  assert.throws(
    () =>
      buildBwrapArgs({
        home: fx.home,
        profile: fx.profile,
        roundDir: fx.roundDir,
        masks: fx.masks,
        binds: [fx.stateDir, fx.worktreeDir],
        hostHome: fx.hostHome,
        readOnlyOverlays: [{ src: path.join(fx.home, 'state'), dest: fx.dest }],
      }),
    /快照|host|状态|dest→dest|派生/,
  );
  assert.throws(
    () =>
      buildBwrapArgs({
        home: fx.home,
        profile: fx.profile,
        roundDir: fx.roundDir,
        masks: fx.masks,
        binds: [fx.stateDir, fx.worktreeDir],
        hostHome: fx.hostHome,
        readOnlyOverlays: [{ src: fx.hostSnapshots, dest: path.join(fx.roundDir, 'leaked-state') }],
      }),
    /快照|派生|整个 snapshots/,
  );
});

test('前提：可写 roundDir 派生路径 dest→dest 只读重挂后仍能列出已有内容（此前提不成立）', () => {
  const fx = overlayFixture();
  const srcFile = snapshotPath(fx.profile, ROOT, 1);
  const auth = writeBody(srcFile, '{"ok":true}\n');
  writeBody(path.join(fx.dest, 'planted-sibling-r8.json'), 'PLANTED-SIBLING\n');
  const payload = writeBody(path.join(fx.roundDir, 'evil-payload.json'), 'SYMLINK-PAYLOAD\n');
  fs.symlinkSync(payload.file, path.join(fx.dest, 'evil-link-r9.json'));
  const overlays = claimSnapshotOverlays({ snapshotView: fx.dest, srcFile });
  assert.equal(sha256File(auth.file), auth.hash, '准备 overlay 不得改权威快照');
  const args = buildBwrapArgs({
    home: fx.home,
    profile: fx.profile,
    roundDir: fx.roundDir,
    masks: fx.masks,
    binds: [fx.stateDir, fx.worktreeDir],
    hostHome: fx.hostHome,
    readOnlyOverlays: overlays,
  });
  const remountSelf = args.some(
    (value, i) => value === '--ro-bind' && args[i + 1] === args[i + 2] && path.resolve(args[i + 1]) === path.resolve(fx.dest),
  );
  const tmpfsView = args.some((value, i) => value === '--tmpfs' && path.resolve(args[i + 1]) === path.resolve(fx.dest));
  assert.equal(remountSelf, false, '不能把可写 roundDir 里的派生目录 dest→dest 重挂当成可信视图');
  assert.equal(tmpfsView, true, '派生视图目录必须先盖空 tmpfs，不能沿用已有内容');
});

test('P2 准备：destFile 是指向权威快照的符号链接时不得截断', () => {
  const fx = overlayFixture();
  const srcFile = snapshotPath(fx.profile, ROOT, 1);
  const auth = writeBody(srcFile, '{"ok":true,"keep":"AUTH"}\n');
  const destFile = path.join(fx.dest, path.basename(srcFile));
  fs.symlinkSync(auth.file, destFile);
  let thrown = null;
  try {
    claimSnapshotOverlays({ snapshotView: fx.dest, srcFile });
  } catch (error) {
    thrown = error;
  }
  assert.equal(sha256File(auth.file), auth.hash, `权威文件必须保持原字节（${thrown ? thrown.message : '未抛错'}）`);
  assert.equal(fs.readFileSync(auth.file, 'utf8'), auth.body);
  assert.equal(fs.lstatSync(destFile).isSymbolicLink(), true, '不得把链接换成截断后的普通文件');
});

test('P2 准备：snapshots 视图是符号链接时拒绝，且不改目标里的 DIRLINK-PLANTED / 权威快照', () => {
  const fx = overlayFixture();
  const srcFile = snapshotPath(fx.profile, ROOT, 1);
  const auth = writeBody(srcFile, '{"ok":true}\n');
  const other = path.join(fx.roundDir, 'home-acc', 'other', 'state', 'host', 'snapshots');
  const planted = writeBody(path.join(other, 'planted-sibling-r8.json'), 'DIRLINK-PLANTED\n');
  fs.rmSync(fx.dest, { recursive: true, force: true });
  fs.symlinkSync(other, fx.dest);
  assert.throws(() => claimSnapshotOverlays({ snapshotView: fx.dest, srcFile }), /符号链接|不能是链接|只读视图/);
  assert.equal(sha256File(auth.file), auth.hash);
  assert.equal(sha256File(planted.file), planted.hash);
  assert.equal(fs.readFileSync(planted.file, 'utf8'), planted.body);
  assert.equal(fs.lstatSync(fx.dest).isSymbolicLink(), true);
});

test('P2 准备：视图链接到沙箱外目录时拒绝，同名金丝雀与权威快照字节不变', () => {
  const fx = overlayFixture();
  const srcFile = snapshotPath(fx.profile, ROOT, 1);
  const auth = writeBody(srcFile, '{"ok":true}\n');
  const outside = tmpDir();
  const canary = writeBody(path.join(outside, path.basename(srcFile)), 'CANARY-OUTSIDE\n');
  fs.rmSync(fx.dest, { recursive: true, force: true });
  fs.symlinkSync(outside, fx.dest);
  assert.throws(() => claimSnapshotOverlays({ snapshotView: fx.dest, srcFile }), /符号链接|不能是链接|只读视图/);
  assert.equal(sha256File(auth.file), auth.hash);
  assert.equal(sha256File(canary.file), canary.hash);
  assert.equal(fs.readFileSync(canary.file, 'utf8'), canary.body);
});

const bwrapAvailable = await probeBwrap(procRun);
const skipBwrap = !bwrapAvailable
  ? 'bwrap 不可用（探针起不来），跳过真沙箱测试'
  : fixtureDirWritable(HERE)
    ? false
    : READONLY_SKIP;

test(
  'P2 真 bwrap：已有内容与符号链接不能穿透，rename 不能换视图，缺证据零写入，合法 close 放行',
  { skip: skipBwrap, timeout: 120000 },
  async () => {
    const outside = fs.mkdtempSync(path.join(HERE, '.sandbox-auth-test-'));
    after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const place = (name) => {
      const dir = path.join(outside, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const hostHome = place('host-home');
    const home = place('watcher-home');
    const stateDir = place('acc-state');
    const worktreeDir = place('acc-worktree');
    const roundDir = place('round');
    fs.mkdirSync(path.join(roundDir, 'home'), { recursive: true });
    fs.mkdirSync(path.join(roundDir, 'tmp'), { recursive: true });
    writeProfile(home, {
      profile: { stateDir, worktreeDir, ownerLogin: OWNER, projectNumber: 7, autoRepos: [`${OWNER}/*`, 'example-owner/*'] },
    });
    const paths = hostPaths(home);
    fs.mkdirSync(paths.gateDir, { recursive: true });
    fs.writeFileSync(paths.enabledFile, '1');
    const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
    const world = machineOnlyTree();
    claimWorld(profile, world, ROOT, 1);
    const hostSnapshots = snapshotDir(profile);
    const srcFile = snapshotPath(profile, ROOT, 1);
    const auth = { file: srcFile, body: fs.readFileSync(srcFile), hash: sha256File(srcFile) };
    const otherHost = writeBody(path.join(hostSnapshots, 'example-owner__other-repo__9-r4.json'), `${JSON.stringify({ body: 'OTHER-ROUND' }, null, 2)}\n`);

    const socketPath = path.join(roundDir, 'g.sock');
    const prepared = prepareSandboxProfile({ profile, roundDir, repoRoot: REPO_ROOT, socketPath });
    const dest = path.join(prepared.sandboxHome, 'state', 'host', 'snapshots');
    writeBody(path.join(dest, 'planted-sibling-r8.json'), 'PLANTED-SIBLING\n');
    const evilPayload = writeBody(path.join(roundDir, 'evil-payload.json'), 'SYMLINK-PAYLOAD\n');
    fs.symlinkSync(evilPayload.file, path.join(dest, 'evil-link-r9.json'));
    const destFile = path.join(dest, path.basename(srcFile));
    if (fs.existsSync(destFile)) fs.unlinkSync(destFile);
    fs.symlinkSync(auth.file, destFile);

    const rawProfile = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
    const masks = maskList({ rawProfile, profile, hostConfig: {}, env: { HOME: hostHome }, home });
    const sandboxBin = path.join(HERE, 'host', 'sandbox-bin');
    const env = sandboxEnv({ base: { ...process.env, HOME: hostHome }, roundDir, socketPath, sandboxBin });
    const overlays = claimSnapshotOverlays({ snapshotView: dest, srcFile });
    assert.equal(sha256File(auth.file), auth.hash, 'claimSnapshotOverlays 不得截断权威快照');
    assert.equal(Buffer.compare(fs.readFileSync(auth.file), auth.body), 0);
    const args = buildBwrapArgs({
      home,
      profile,
      roundDir,
      masks,
      binds: [stateDir, worktreeDir],
      hostHome,
      homeAllow: defaultHomeAllow({ repoRoot: REPO_ROOT }),
      readOnlyOverlays: overlays,
    });

    const verified = writeJsonFile(roundDir, 'verified.json', {
      checks: ALL_RAN,
      items: [{ ref: `${REPO}#2`, sc: 3 }],
      manual: [],
    });
    const verdict = writeJsonFile(roundDir, 'machine-pass.json', { checks: ALL_RAN, items: machineConclusions() });
    const emptyChecks = writeJsonFile(roundDir, 'checks-only.json', { checks: ALL_RAN });

    const gate = createGate({
      home,
      profile,
      github: createFakeGithub(world),
      run: procRun,
      binding: { root: ROOT, round: 1, commentId: 1001 },
      which: async () => false,
    });
    await gate.start();
    const server = await startGateServer({ gate, socketPath });
    after(async () => {
      await server.close();
    });

    const probe = path.join(roundDir, 'probe-planted.mjs');
    fs.writeFileSync(
      probe,
      [
        "import fs from 'node:fs';",
        `import { loadAcceptanceProfile } from ${JSON.stringify(path.join(HERE, 'bin', 'profile.mjs'))};`,
        `import { readClaimSnapshot, snapshotDir, snapshotPath, writeClaimSnapshot } from ${JSON.stringify(path.join(HERE, 'bin', 'authenticity.mjs'))};`,
        `const ROOT = ${JSON.stringify(ROOT)};`,
        `const dest = ${JSON.stringify(dest)};`,
        `const destFile = ${JSON.stringify(destFile)};`,
        'const profile = loadAcceptanceProfile();',
        'const view = snapshotDir(profile);',
        'const snap = readClaimSnapshot(profile, ROOT, 1);',
        'const out = { view, listed: [], plantedListed: false, plantedBody: null, linkListed: false, linkBody: null, renamed: false, replaced: false, forged: false, snapOk: Boolean(snap && snap.bodyVersion), wrote: false, unlinked: false };',
        'try { out.listed = fs.readdirSync(view); } catch {}',
        'out.plantedListed = out.listed.includes("planted-sibling-r8.json");',
        'out.linkListed = out.listed.includes("evil-link-r9.json");',
        'try { out.plantedBody = fs.readFileSync(path.join(view, "planted-sibling-r8.json"), "utf8"); } catch {}',
        'try { out.linkBody = fs.readFileSync(path.join(view, "evil-link-r9.json"), "utf8"); } catch {}',
        'try { fs.renameSync(view, `${view}.bak`); out.renamed = true; } catch {}',
        'try { fs.rmSync(view, { recursive: true, force: true }); fs.mkdirSync(view); fs.writeFileSync(path.join(view, path.basename(destFile)), JSON.stringify({ body: "SYMLINK-FORGED" })); out.replaced = true; } catch {}',
        'try { fs.writeFileSync(destFile, JSON.stringify({ body: "SYMLINK-FORGED" })); out.forged = true; } catch {}',
        'try { fs.writeFileSync(path.join(view, "forged.json"), "{}"); out.wrote = true; } catch {}',
        'try { fs.unlinkSync(destFile); out.unlinked = true; } catch {}',
        'out.snapAfter = readClaimSnapshot(profile, ROOT, 1);',
        'process.stdout.write(JSON.stringify(out));',
        '',
      ].join('\n'),
    );

    const probed = await procRun('bwrap', [...args, '--', process.execPath, probe], {
      env,
      cwd: roundDir,
      timeoutMs: 30000,
    });
    assert.equal(probed.code, 0, probed.stderr);
    const view = JSON.parse(probed.stdout);
    assert.equal(view.snapOk, true, `本轮快照必须可读：${probed.stdout}`);
    assert.equal(view.plantedListed, false, `不能列出预放文件：${JSON.stringify(view.listed)}`);
    assert.equal(view.linkListed, false, `不能列出符号链接：${JSON.stringify(view.listed)}`);
    assert.equal(view.plantedBody, null, '不能读 PLANTED-SIBLING');
    assert.equal(view.linkBody, null, '不能读 SYMLINK-PAYLOAD');
    assert.equal(view.renamed, false, '不能 rename 掉只读视图挂载点');
    assert.equal(view.replaced, false, '不能替换视图目录再写入 SYMLINK-FORGED');
    assert.equal(view.forged, false);
    assert.equal(view.wrote, false);
    assert.equal(view.unlinked, false);
    assert.ok(view.snapAfter && view.snapAfter.bodyVersion, 'rename/替换失败后仍读本轮权威快照');
    assert.equal(String(view.snapAfter.body || '').includes('SYMLINK-FORGED'), false);
    assert.equal(sha256File(auth.file), auth.hash);
    assert.equal(sha256File(otherHost.file), otherHost.hash);
    assert.equal(fs.readFileSync(evilPayload.file, 'utf8'), evilPayload.body);

    const closeNoItems = await procRun(
      'bwrap',
      [...args, '--', process.execPath, GATE_CLIENT, '--socket', socketPath],
      {
        env,
        cwd: roundDir,
        timeoutMs: 30000,
        input: JSON.stringify({
          type: 'issue.close',
          repo: REPO,
          issue: 1,
          reason: 'completed',
          dedupeKey: 'bwrap-planted-no-ev-close',
        }),
      },
    );
    assert.equal(closeNoItems.code, 4, closeNoItems.stderr + closeNoItems.stdout);
    assert.match(closeNoItems.stdout, /illegal-pass/);
    assert.equal(world.get(ROOT).state, 'open');
    assert.equal(world.writes.length, 0);

    const boardNoItems = await procRun(
      'bwrap',
      [
        ...args,
        '--',
        process.execPath,
        HELPER,
        'board',
        '--issue',
        ROOT,
        '--round',
        '1',
        '--acceptance',
        '通过',
        '--checks',
        emptyChecks,
      ],
      { env, cwd: roundDir, timeoutMs: 60000 },
    );
    assert.notEqual(boardNoItems.code, 0, boardNoItems.stdout);
    assert.match(`${boardNoItems.stderr}${boardNoItems.stdout}`, /逐条|证据|裁决|illegal-pass/);
    assert.equal(world.get(ROOT).project['验收'], undefined);
    assert.equal(world.writes.length, 0);

    const closed = await procRun(
      'bwrap',
      [
        ...args,
        '--',
        process.execPath,
        HELPER,
        'close',
        '--issue',
        ROOT,
        '--round',
        '1',
        '--verified',
        verified,
        '--verdict',
        verdict,
      ],
      { env, cwd: roundDir, timeoutMs: 60000 },
    );
    assert.equal(closed.code, 0, `${closed.stderr}\n${closed.stdout}`);
    assert.equal(world.get(ROOT).state, 'closed');
    assert.equal(world.get(ROOT).project['验收'], '通过');
    assert.equal(sha256File(auth.file), auth.hash);
  },
);

test(
  'P1/P2 真 bwrap：本轮快照可读、其他轮不可读不可列出，不可写删，缺证据关单/看板拒绝，完整证据 helper close 放行',
  { skip: skipBwrap, timeout: 120000 },
  async () => {
    const outside = fs.mkdtempSync(path.join(HERE, '.sandbox-auth-test-'));
    after(() => fs.rmSync(outside, { recursive: true, force: true }));
    const place = (name) => {
      const dir = path.join(outside, name);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    };
    const hostHome = place('host-home');
    const home = place('watcher-home');
    const stateDir = place('acc-state');
    const worktreeDir = place('acc-worktree');
    const roundDir = place('round');
    fs.mkdirSync(path.join(roundDir, 'home'), { recursive: true });
    fs.mkdirSync(path.join(roundDir, 'tmp'), { recursive: true });
    writeProfile(home, {
      profile: { stateDir, worktreeDir, ownerLogin: OWNER, projectNumber: 7, autoRepos: [`${OWNER}/*`, 'example-owner/*'] },
    });
    const paths = hostPaths(home);
    fs.mkdirSync(paths.gateDir, { recursive: true });
    fs.writeFileSync(paths.enabledFile, '1');
    const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
    const world = machineOnlyTree();
    claimWorld(profile, world, ROOT, 1);
    const hostSnapshots = snapshotDir(profile);
    assert.ok(readClaimSnapshot(profile, ROOT, 1));
    assert.equal(fs.existsSync(snapshotPath(profile, ROOT, 1)), true);
    const otherName = 'example-owner__other-repo__9-r4.json';
    const otherHost = path.join(hostSnapshots, otherName);
    fs.writeFileSync(otherHost, `${JSON.stringify({ body: 'OTHER-ROUND', ref: 'example-owner/other-repo#9', round: 4 }, null, 2)}\n`);

    const socketPath = path.join(roundDir, 'g.sock');
    const prepared = prepareSandboxProfile({ profile, roundDir, repoRoot: REPO_ROOT, socketPath });
    const dest = path.join(prepared.sandboxHome, 'state', 'host', 'snapshots');
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const rawProfile = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
    const masks = maskList({ rawProfile, profile, hostConfig: {}, env: { HOME: hostHome }, home });
    const sandboxBin = path.join(HERE, 'host', 'sandbox-bin');
    const env = sandboxEnv({ base: { ...process.env, HOME: hostHome }, roundDir, socketPath, sandboxBin });
    const srcFile = snapshotPath(profile, ROOT, 1);
    const overlays = claimSnapshotOverlays({ snapshotView: dest, srcFile });
    assert.equal(fs.existsSync(path.join(dest, path.basename(srcFile))), false);
    const args = buildBwrapArgs({
      home,
      profile,
      roundDir,
      masks,
      binds: [stateDir, worktreeDir],
      hostHome,
      homeAllow: defaultHomeAllow({ repoRoot: REPO_ROOT }),
      readOnlyOverlays: overlays,
    });

    const verified = writeJsonFile(roundDir, 'verified.json', {
      checks: ALL_RAN,
      items: [{ ref: `${REPO}#2`, sc: 3 }],
      manual: [],
    });
    const verdict = writeJsonFile(roundDir, 'machine-pass.json', { checks: ALL_RAN, items: machineConclusions() });
    const emptyChecks = writeJsonFile(roundDir, 'checks-only.json', { checks: ALL_RAN });

    const gate = createGate({
      home,
      profile,
      github: createFakeGithub(world),
      run: procRun,
      binding: { root: ROOT, round: 1, commentId: 1001 },
      which: async () => false,
    });
    await gate.start();
    const server = await startGateServer({ gate, socketPath });
    after(async () => {
      await server.close();
    });

    const probe = path.join(roundDir, 'probe-snapshot.mjs');
    fs.writeFileSync(
      probe,
      [
        "import fs from 'node:fs';",
        `import { loadAcceptanceProfile } from ${JSON.stringify(path.join(HERE, 'bin', 'profile.mjs'))};`,
        `import { readClaimSnapshot, snapshotDir, snapshotPath, writeClaimSnapshot } from ${JSON.stringify(path.join(HERE, 'bin', 'authenticity.mjs'))};`,
        `const ROOT = ${JSON.stringify(ROOT)};`,
        `const hostPath = ${JSON.stringify(snapshotPath(profile, ROOT, 1))};`,
        `const hostDir = ${JSON.stringify(hostSnapshots)};`,
        `const hostState = ${JSON.stringify(path.join(home, 'state'))};`,
        `const otherName = ${JSON.stringify(otherName)};`,
        'const profile = loadAcceptanceProfile();',
        'const view = snapshotDir(profile);',
        'const snap = readClaimSnapshot(profile, ROOT, 1);',
        'const out = { view, hasSnap: Boolean(snap && snap.bodyVersion), hostPathReadable: false, hostDirReadable: false, hostStateReadable: false, wrote: false, unlinked: false, mkdir: false, writeClaim: null, otherListed: false, otherReadable: false, listed: [] };',
        'try { fs.readFileSync(hostPath, "utf8"); out.hostPathReadable = true; } catch {}',
        'try { fs.readdirSync(hostDir); out.hostDirReadable = true; } catch {}',
        'try { const names = fs.readdirSync(hostState); out.hostStateReadable = names.length > 0; } catch {}',
        'try { out.listed = fs.readdirSync(view); out.otherListed = out.listed.includes(otherName); } catch {}',
        'try { const text = fs.readFileSync(path.join(view, otherName), "utf8"); out.otherReadable = text.includes("OTHER-ROUND"); } catch {}',
        'try { fs.writeFileSync(path.join(view, "forged.json"), "{}"); out.wrote = true; } catch {}',
        'try { fs.unlinkSync(path.join(view, path.basename(hostPath))); out.unlinked = true; } catch {}',
        'try { fs.mkdirSync(path.join(view, "rebuilt")); out.mkdir = true; } catch {}',
        'try { writeClaimSnapshot(profile, ROOT, 1, { inferred: true }); out.writeClaim = "ok"; } catch (error) { out.writeClaim = String(error.message || error); }',
        'process.stdout.write(JSON.stringify(out));',
        '',
      ].join('\n'),
    );

    const probed = await procRun('bwrap', [...args, '--', process.execPath, probe], {
      env,
      cwd: roundDir,
      timeoutMs: 30000,
    });
    assert.equal(probed.code, 0, probed.stderr);
    const view = JSON.parse(probed.stdout);
    assert.equal(view.hasSnap, true, `沙箱应读到宿主认领快照：${probed.stdout}`);
    assert.deepEqual(view.listed, [path.basename(snapshotPath(profile, ROOT, 1))], `快照视图只能看到本轮文件：${JSON.stringify(view.listed)}`);
    assert.equal(view.otherListed, false, `不能列出其他轮次快照：${JSON.stringify(view.listed)}`);
    assert.equal(view.otherReadable, false, `不能读其他轮次快照：${probed.stdout}`);
    assert.equal(view.view, dest);
    assert.equal(view.hostPathReadable, false, '原宿主快照路径必须被遮住');
    assert.equal(view.hostDirReadable, false, '原宿主 snapshots 目录必须被遮住');
    assert.equal(view.hostStateReadable, false, '不能把整个 host/state 暴露给沙箱');
    assert.equal(view.wrote, false, '沙箱不能写快照视图');
    assert.equal(view.unlinked, false, '沙箱不能删权威快照');
    assert.equal(view.mkdir, false, '沙箱不能在快照视图里建目录');
    assert.match(String(view.writeClaim), /不能改认领快照|沙箱不能|EROFS|read-only|only|只读/i);
    assert.equal(fs.existsSync(snapshotPath(profile, ROOT, 1)), true);
    assert.equal(fs.existsSync(path.join(hostSnapshots, 'forged.json')), false);
    assert.notEqual(readClaimSnapshot(profile, ROOT, 1).inferred, true);

    const closeNoItems = await procRun(
      'bwrap',
      [
        ...args,
        '--',
        process.execPath,
        GATE_CLIENT,
        '--socket',
        socketPath,
      ],
      {
        env,
        cwd: roundDir,
        timeoutMs: 30000,
        input: JSON.stringify({
          type: 'issue.close',
          repo: REPO,
          issue: 1,
          reason: 'completed',
          dedupeKey: 'bwrap-no-ev-close',
        }),
      },
    );
    assert.equal(closeNoItems.code, 4, closeNoItems.stderr + closeNoItems.stdout);
    assert.match(closeNoItems.stdout, /illegal-pass/);
    assert.equal(world.get(ROOT).state, 'open');
    assert.equal(world.writes.length, 0);

    const boardNoItems = await procRun(
      'bwrap',
      [
        ...args,
        '--',
        process.execPath,
        HELPER,
        'board',
        '--issue',
        ROOT,
        '--round',
        '1',
        '--acceptance',
        '通过',
        '--checks',
        emptyChecks,
      ],
      { env, cwd: roundDir, timeoutMs: 60000 },
    );
    assert.notEqual(boardNoItems.code, 0, boardNoItems.stdout);
    assert.match(`${boardNoItems.stderr}${boardNoItems.stdout}`, /逐条|证据|裁决|illegal-pass/);
    assert.equal(world.get(ROOT).project['验收'], undefined);
    assert.equal(world.writes.length, 0);

    const closed = await procRun(
      'bwrap',
      [
        ...args,
        '--',
        process.execPath,
        HELPER,
        'close',
        '--issue',
        ROOT,
        '--round',
        '1',
        '--verified',
        verified,
        '--verdict',
        verdict,
      ],
      { env, cwd: roundDir, timeoutMs: 60000 },
    );
    assert.equal(closed.code, 0, `${closed.stderr}\n${closed.stdout}`);
    assert.equal(world.get(ROOT).state, 'closed');
    assert.equal(world.get(ROOT).project['验收'], '通过');
  },
);
