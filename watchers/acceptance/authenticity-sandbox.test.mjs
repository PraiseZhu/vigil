// 认领快照只读视图：真 bwrap 里 helper 能读同一份宿主快照，但不能改/删/重建；
// 缺逐条证据的关单/看板通过在任何外部副作用之前拒绝。同 profile 的 mock 不够。
import assert from 'node:assert/strict';
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

test('P1 沙箱参数：认领快照只读叠到派生路径，拒绝挂整个 host 状态', () => {
  const fx = overlayFixture();
  assert.ok(endsWithSnapshots(fx.hostSnapshots));
  assert.ok(endsWithSnapshots(fx.dest));
  assert.equal(fx.dest.startsWith(path.join(fx.roundDir, 'home-acc')), true);
  const args = buildBwrapArgs({
    home: fx.home,
    profile: fx.profile,
    roundDir: fx.roundDir,
    masks: fx.masks,
    binds: [fx.stateDir, fx.worktreeDir],
    hostHome: fx.hostHome,
    readOnlyOverlays: [{ src: fx.hostSnapshots, dest: fx.dest }],
  });
  const bindRound = args.findIndex((value, i) => value === '--bind' && args[i + 1] === fx.roundDir);
  const overlayAt = args.findIndex(
    (value, i) => value === '--ro-bind' && args[i + 1] === fs.realpathSync(fx.hostSnapshots) && args[i + 2] === fs.realpathSync(fx.dest),
  );
  assert.ok(bindRound >= 0, 'roundDir 必须可写绑定');
  assert.ok(overlayAt >= 0, '必须把宿主快照只读叠到沙箱派生路径');
  assert.ok(overlayAt > bindRound, '只读叠挂必须在可写 roundDir 之后');
  const stateReal = fs.realpathSync(path.join(fx.home, 'state'));
  const maskAt = args.findIndex((value, i) => value === '--tmpfs' && args[i + 1] === stateReal);
  if (maskAt >= 0) assert.ok(overlayAt < maskAt, '先叠快照再遮原宿主状态');

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
    /快照|host|状态/,
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
    /快照|派生/,
  );
});

const bwrapAvailable = await probeBwrap(procRun);
const skipBwrap = !bwrapAvailable
  ? 'bwrap 不可用（探针起不来），跳过真沙箱测试'
  : fixtureDirWritable(HERE)
    ? false
    : READONLY_SKIP;

test(
  'P1 真 bwrap：快照可读不可写删，缺证据关单/看板拒绝，完整证据 helper close 放行',
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

    const socketPath = path.join(roundDir, 'g.sock');
    const prepared = prepareSandboxProfile({ profile, roundDir, repoRoot: REPO_ROOT, socketPath });
    const dest = path.join(prepared.sandboxHome, 'state', 'host', 'snapshots');
    fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
    const rawProfile = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
    const masks = maskList({ rawProfile, profile, hostConfig: {}, env: { HOME: hostHome }, home });
    const sandboxBin = path.join(HERE, 'host', 'sandbox-bin');
    const env = sandboxEnv({ base: { ...process.env, HOME: hostHome }, roundDir, socketPath, sandboxBin });
    const args = buildBwrapArgs({
      home,
      profile,
      roundDir,
      masks,
      binds: [stateDir, worktreeDir],
      hostHome,
      homeAllow: defaultHomeAllow({ repoRoot: REPO_ROOT }),
      readOnlyOverlays: [{ src: hostSnapshots, dest }],
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
        'const profile = loadAcceptanceProfile();',
        'const view = snapshotDir(profile);',
        'const snap = readClaimSnapshot(profile, ROOT, 1);',
        'const out = { view, hasSnap: Boolean(snap && snap.bodyVersion), hostPathReadable: false, hostDirReadable: false, hostStateReadable: false, wrote: false, unlinked: false, mkdir: false, writeClaim: null };',
        'try { fs.readFileSync(hostPath, "utf8"); out.hostPathReadable = true; } catch {}',
        'try { fs.readdirSync(hostDir); out.hostDirReadable = true; } catch {}',
        'try { const names = fs.readdirSync(hostState); out.hostStateReadable = names.length > 0; } catch {}',
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
