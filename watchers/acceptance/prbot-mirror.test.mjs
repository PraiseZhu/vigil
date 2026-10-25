// #68 第四轮复审：宿主镜像（带令牌的 fetch）放在任何沙箱都写不了的地方，并且自己防篡改。
// 复审复现过的攻击：验收轮的模型（沙箱可写整个 worktreeDir）在旧镜像位置 worktreeDir/prbot/.mirror/ 预埋
// reference-transaction 钩子；修正轮带令牌的 fetch 在沙箱外跑了它，钩子拿到了完整的 AUTHORIZATION 头。
// 这里用真 git、本地上游仓、假令牌重放这个攻击和几种变体；全程不联网、不读真令牌。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { FETCH_TIMEOUT_MS, MIRROR_CONFIG, MIRROR_GIT_HARDENING, MIRROR_MAX_BYTES, createGithub } from './bin/github.mjs';
import { spawnRun } from './bin/localgit.mjs';
import { defaultPrepareWorktree, mirrorPathFor, mirrorRootFor } from './host/prbot.mjs';
import { REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const FAKE_TOKEN = 'fake-mirror-token-not-real-0123456789';
const BASIC = Buffer.from(`x-access-token:${FAKE_TOKEN}`).toString('base64');
const STATE = { issue: `${REPO}#2`, root: `${REPO}#1`, round: 1, branch: 'acceptance/1-2-sc3' };
const WORKTREE_NAME = `${REPO.replace('/', '__')}__2-r1`;

function cleanEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: tmpDir(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...extra };
}

async function git(args, options = {}) {
  const result = await spawnRun('git', args, { env: cleanEnv(), ...options });
  assert.equal(result.code, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return String(result.stdout).trim();
}

async function world() {
  const up = path.join(tmpDir(), 'upstream');
  await git(['init', '-q', '-b', 'main', up]);
  fs.writeFileSync(path.join(up, 'app.mjs'), 'export const x = 1;\n');
  await git(['-C', up, 'add', '-A']);
  await git(['-C', up, '-c', 'user.name=u', '-c', 'user.email=u@example.invalid', 'commit', '-q', '-m', 'init']);
  const upstreamMain = await git(['-C', up, 'rev-parse', 'HEAD']);
  const { home } = writeProfile(tmpDir(), { tokenContent: FAKE_TOKEN, profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const marks = path.join(tmpDir(), 'marks');
  fs.mkdirSync(marks);
  // 植入的程序：只要在宿主上（没有 IN_SANDBOX）被跑，就把整个环境写下来（里面可能有 AUTHORIZATION 头）。
  const evil = path.join(tmpDir(), 'evil.sh');
  fs.writeFileSync(evil, `#!/bin/sh\n[ -n "$IN_SANDBOX" ] || env > "${marks}/hit.$$"\nexit 0\n`, { mode: 0o755 });
  const gitCalls = [];
  // 真的 createGithub().fetchBranch：只把 https://github.com/<repo>.git 换成本地上游仓（测试才放开 file 协议）。
  const run = async (cmd, args, options = {}) => {
    const rewritten = args.map((arg) => (arg === `https://github.com/${REPO}.git` ? up : arg));
    const local = rewritten !== args && args.some((arg) => arg.startsWith('https://github.com/'));
    gitCalls.push({ cmd, args, env: options.env || {}, timeoutMs: options.timeoutMs });
    return spawnRun(cmd, local ? ['-c', 'protocol.file.allow=always', ...rewritten] : rewritten, { env: options.env, cwd: options.cwd });
  };
  const github = createGithub({ profile, run });
  const sandboxed = [];
  const preflight = async ({ commands, worktree }) => {
    for (const command of commands) {
      sandboxed.push(command);
      const result = await spawnRun(command[0], command.slice(1), { cwd: worktree, env: cleanEnv({ IN_SANDBOX: '1' }) });
      if (result.code !== 0) return { ok: false, code: result.code };
    }
    return { ok: true, code: 0 };
  };
  const prepare = (extra = {}) =>
    defaultPrepareWorktree({ github, state: STATE, profile, run, home, preflight, hostConfig: {}, ...extra });
  return { up, upstreamMain, home, profile, marks, evil, gitCalls, sandboxed, prepare };
}

/** 一个预埋了钩子的 git 仓（模型在沙箱里能做的事）。 */
async function plantHookedRepo(dir, evil, { bare = false, config = '' } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  await git(['init', '-q', ...(bare ? ['--bare'] : []), bare ? path.join(dir, '.git') : dir]);
  const hooks = path.join(dir, '.git', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  for (const name of ['reference-transaction', 'post-checkout', 'post-merge', 'pre-auto-gc', 'post-index-change']) {
    fs.copyFileSync(evil, path.join(hooks, name));
    fs.chmodSync(path.join(hooks, name), 0o755);
  }
  if (config) fs.appendFileSync(path.join(dir, '.git', 'config'), config);
  return hooks;
}

function assertNoLeak({ marks, gitCalls, home, profile }) {
  const hits = fs.readdirSync(marks);
  const captured = hits.map((name) => fs.readFileSync(path.join(marks, name), 'utf8')).join('\n');
  assert.equal(captured.includes(BASIC) || captured.includes(FAKE_TOKEN), false, '植入的程序没拿到令牌');
  assert.deepEqual(hits, [], '植入的钩子 / 配置命令一个都没在宿主上跑');
  // 带令牌的 git 只有一种：在宿主镜像里、带全套加固的 fetch。
  for (const call of gitCalls) {
    const tokenBearing = Object.values(call.env).some((value) => String(value).includes(BASIC));
    if (!tokenBearing) continue;
    assert.deepEqual(call.args.slice(0, MIRROR_GIT_HARDENING.length), MIRROR_GIT_HARDENING);
    assert.ok(call.args.includes('core.hooksPath=/dev/null'));
    assert.equal(call.env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(call.env.GIT_CONFIG_GLOBAL, '/dev/null');
    assert.equal(call.timeoutMs, FETCH_TIMEOUT_MS, '带令牌的 fetch 有超时');
    const gitDir = call.args[call.args.indexOf('--git-dir') + 1];
    assert.ok(gitDir.startsWith(mirrorRootFor(home) + path.sep), `带令牌的 git 在镜像根外：${gitDir}`);
    assert.equal(gitDir.startsWith(profile.worktreeDir + path.sep), false, '带令牌的 git 不在 worktreeDir 里');
  }
}

test('SC5 复审复现：模型在旧镜像位置（worktreeDir/prbot/.mirror）预埋钩子 —— 镜像已搬走，钩子不跑、令牌不外泄', async () => {
  const w = await world();
  const oldMirror = path.join(w.profile.worktreeDir, 'prbot', '.mirror', WORKTREE_NAME);
  await plantHookedRepo(oldMirror, w.evil, { config: `[core]\n\thooksPath = ${path.join(oldMirror, '.git', 'hooks')}\n` });
  const result = await w.prepare();
  assert.equal(result.reused, false);
  assertNoLeak(w);
  // 镜像在 <home>/state/prbot/mirrors 下：所有沙箱都遮住了 <home>/state，验收轮沙箱可写的 worktreeDir 不包含它。
  assert.equal(result.mirror, mirrorPathFor(w.home, result.worktree));
  assert.equal(result.mirror, path.join(w.home, 'state', 'prbot', 'mirrors', WORKTREE_NAME));
  assert.equal(result.mirror.startsWith(w.profile.worktreeDir + path.sep), false);
  assert.equal((fs.statSync(result.mirror).mode & 0o777), 0o700);
  assert.equal(fs.readFileSync(path.join(result.mirror, '.git', 'config'), 'utf8'), MIRROR_CONFIG);
  // 工作树由沙箱建好：分支指向上游 main，归属标记进了 exclude。
  assert.equal(await git(['-C', result.worktree, 'rev-parse', STATE.branch]), w.upstreamMain);
  assert.match(fs.readFileSync(path.join(result.worktree, '.git', 'info', 'exclude'), 'utf8'), /^\/\.acc-owned\.json$/m);
  assert.deepEqual(w.sandboxed[0], ['git', 'init', '-q']);
  assert.ok(w.sandboxed.some((command) => command[1] === 'fetch' && /main\.bundle$/.test(command[3])));
  // 宿主上的 git 一条都没碰工作树。
  for (const call of w.gitCalls) {
    assert.equal(call.args.some((arg) => typeof arg === 'string' && arg.startsWith(result.worktree)), false, call.args.join(' '));
  }
  // 对照：旧代码那样在旧位置 init + 带令牌 fetch，预埋的钩子真的会拿到令牌（说明上面的「没留痕」不是假象）。
  const env = { ...cleanEnv(), GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${BASIC}` };
  await spawnRun('git', ['init', '-q', oldMirror], { env });
  await spawnRun('git', ['-C', oldMirror, 'fetch', '-q', w.up, '+refs/heads/main:refs/remotes/origin/main'], { env });
  const hits = fs.readdirSync(w.marks).map((name) => fs.readFileSync(path.join(w.marks, name), 'utf8')).join('\n');
  assert.ok(hits.includes(BASIC), '对照组：旧位置的钩子能拿到 AUTHORIZATION 头');
});

test('SC5 新镜像位置被换成符号链接（指向预埋钩子的仓）：拒绝，不带令牌跑任何 git', async () => {
  const w = await world();
  const hostile = path.join(tmpDir(), 'hostile');
  await plantHookedRepo(hostile, w.evil);
  fs.chmodSync(hostile, 0o700);
  fs.mkdirSync(mirrorRootFor(w.home), { recursive: true, mode: 0o700 });
  fs.symlinkSync(hostile, path.join(mirrorRootFor(w.home), WORKTREE_NAME));
  await assert.rejects(w.prepare(), /mirror-tampered/);
  assertNoLeak(w);
  assert.equal(w.gitCalls.length, 0);
});

test('SC5 镜像位置上是个普通文件（600）而不是目录：mirror-tampered，不带令牌跑 git', async () => {
  const w = await world();
  fs.mkdirSync(mirrorRootFor(w.home), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(mirrorRootFor(w.home), WORKTREE_NAME), 'x', { mode: 0o600 });
  await assert.rejects(w.prepare(), /mirror-tampered/);
  assertNoLeak(w);
  assert.equal(w.gitCalls.length, 0);
});

test('SC5 镜像根 mirrors/ 本身是符号链接、或权限放开：拒绝', async () => {
  const w = await world();
  const elsewhere = tmpDir();
  fs.mkdirSync(path.join(w.home, 'state', 'prbot'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(elsewhere, mirrorRootFor(w.home));
  await assert.rejects(w.prepare(), /mirror-tampered/);
  fs.unlinkSync(mirrorRootFor(w.home));
  fs.mkdirSync(mirrorRootFor(w.home), { mode: 0o755 });
  fs.chmodSync(mirrorRootFor(w.home), 0o755);
  await assert.rejects(w.prepare(), /mirror-tampered/);
  assertNoLeak(w);
  assert.equal(w.gitCalls.length, 0);
});

test('SC5 新镜像里预埋钩子（配置是固定内容）：带令牌的 fetch 关了钩子，不跑', async () => {
  const w = await world();
  const mirror = path.join(mirrorRootFor(w.home), WORKTREE_NAME);
  fs.mkdirSync(mirrorRootFor(w.home), { recursive: true, mode: 0o700 });
  fs.mkdirSync(mirror, { mode: 0o700 });
  await plantHookedRepo(mirror, w.evil, { bare: true });
  fs.writeFileSync(path.join(mirror, '.git', 'config'), MIRROR_CONFIG);
  await w.prepare();
  assertNoLeak(w);
  assert.ok(w.gitCalls.some((call) => call.args.includes('fetch')), '确实跑了带令牌的 fetch');
});

test('SC5 新镜像的 .git/config 被改过 / 有 alternates / 权限放开：mirror-tampered，不带令牌跑 git', async () => {
  for (const tamper of ['config', 'alternates', 'mode', 'gitlink']) {
    const w = await world();
    const mirror = path.join(mirrorRootFor(w.home), WORKTREE_NAME);
    fs.mkdirSync(mirrorRootFor(w.home), { recursive: true, mode: 0o700 });
    fs.mkdirSync(mirror, { mode: 0o700 });
    const hooks = await plantHookedRepo(mirror, w.evil, { bare: true });
    fs.writeFileSync(path.join(mirror, '.git', 'config'), MIRROR_CONFIG);
    if (tamper === 'config') fs.appendFileSync(path.join(mirror, '.git', 'config'), `[core]\n\thooksPath = ${hooks}\n`);
    if (tamper === 'alternates') {
      fs.mkdirSync(path.join(mirror, '.git', 'objects', 'info'), { recursive: true });
      fs.writeFileSync(path.join(mirror, '.git', 'objects', 'info', 'alternates'), `${tmpDir()}\n`);
    }
    if (tamper === 'mode') fs.chmodSync(mirror, 0o755);
    if (tamper === 'gitlink') {
      fs.rmSync(path.join(mirror, '.git', 'config'));
      fs.symlinkSync(path.join(tmpDir(), 'config'), path.join(mirror, '.git', 'config'));
    }
    await assert.rejects(w.prepare(), /mirror-tampered/, tamper);
    assertNoLeak(w);
    assert.equal(w.gitCalls.some((call) => Object.values(call.env).some((value) => String(value).includes(BASIC))), false, tamper);
  }
});

test('SC5 模型预先建好工作树（伪造 .acc-owned.json + 恶意 .git/config）：宿主没记过，拒绝复用，不在里面跑 git', async () => {
  const w = await world();
  const worktree = path.join(w.profile.worktreeDir, 'prbot', WORKTREE_NAME);
  await plantHookedRepo(worktree, w.evil, {
    config: `[protocol "ext"]\n\tallow = always\n[url "ext::${w.evil} %S"]\n\tinsteadOf = ${w.up}\n[core]\n\tfsmonitor = ${w.evil}\n`,
  });
  fs.writeFileSync(path.join(worktree, '.acc-owned.json'), JSON.stringify({ kind: 'prbot', issue: STATE.issue, round: 1 }));
  await assert.rejects(w.prepare(), /不是宿主建的/);
  await assert.rejects(w.prepare({ refresh: true }), /不是宿主建的/);
  assertNoLeak(w);
  for (const call of w.gitCalls) assert.equal(call.args.some((arg) => String(arg).startsWith(worktree)), false);
  // 工作树是符号链接也拒绝（不然沙箱会把链接指向的宿主目录可写挂进去）。
  fs.rmSync(worktree, { recursive: true, force: true });
  fs.symlinkSync(tmpDir(), worktree);
  await assert.rejects(w.prepare(), /符号链接/);
});

test('SC5 宿主自己建的工作树：复用不重取，解决冲突前重取；fork 模式取 PR 所在上游仓', async () => {
  const w = await world();
  const first = await w.prepare();
  const fetches = () => w.gitCalls.filter((call) => call.args.includes('fetch')).length;
  assert.equal(fetches(), 1);
  const again = await w.prepare();
  assert.equal(again.reused, true);
  assert.equal(again.mirror, first.mirror);
  assert.equal(fetches(), 1, '复用不重取');
  await w.prepare({ refresh: true });
  assert.equal(fetches(), 2, '解决冲突前重取 main');
  assertNoLeak(w);
  const forkCalls = [];
  const github = { fetchBranch: async (options) => forkCalls.push(options) };
  const fork = { ...STATE, issue: `${REPO}#3`, prRepo: 'example-owner/example-repo' };
  await assert.rejects(defaultPrepareWorktree({ github, state: fork, profile: w.profile, run: async () => ({ code: 1 }), home: w.home, preflight: async () => ({ ok: true }) }));
  assert.equal(forkCalls[0].repo, 'example-owner/example-repo');
  assert.equal(forkCalls[0].depth, 0);
});

test('SC5 镜像根落进沙箱可写目录（worktreeDir / stateDir 配到了 <home>/state/prbot 下面）：拒绝', async () => {
  const w = await world();
  for (const key of ['worktreeDir', 'stateDir']) {
    const inside = path.join(w.home, 'state', 'prbot', 'mirrors', 'inner');
    fs.mkdirSync(inside, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(w.home, 'state', 'prbot'), 0o700);
    fs.chmodSync(path.join(w.home, 'state', 'prbot', 'mirrors'), 0o700);
    const profile = { ...w.profile, [key]: inside };
    await assert.rejects(
      defaultPrepareWorktree({ github: { fetchBranch: async () => assert.fail('不该取') }, state: STATE, profile, run: async () => ({ code: 0 }), home: w.home, preflight: async () => ({ ok: true }) }),
      /mirror-tampered/,
      key,
    );
  }
  assertNoLeak(w);
});

test('SC5 镜像超过磁盘上限：取完就删、mirror-too-large', async () => {
  const w = await world();
  const mirror = path.join(mirrorRootFor(w.home), WORKTREE_NAME);
  fs.mkdirSync(mirrorRootFor(w.home), { recursive: true, mode: 0o700 });
  fs.mkdirSync(mirror, { mode: 0o700 });
  await git(['init', '-q', '--bare', path.join(mirror, '.git')]);
  fs.writeFileSync(path.join(mirror, '.git', 'config'), MIRROR_CONFIG);
  // 稀疏文件：不真占盘，按大小算超过上限。
  const junk = path.join(mirror, '.git', 'objects', 'junk');
  fs.writeFileSync(junk, '');
  fs.truncateSync(junk, MIRROR_MAX_BYTES + 1);
  await assert.rejects(w.prepare(), /mirror-too-large/);
  assert.equal(fs.existsSync(mirror), false, '超限的镜像删掉了');
  assertNoLeak(w);
});

/** 在本地上游仓里给修正分支加一个提交（模拟远端已有的修正分支）。parent 默认是 main。 */
async function commitOnBranch(up, branch, { from = 'main', file = 'fix.mjs', text = 'export const y = 1;\n' } = {}) {
  await git(['-C', up, 'checkout', '-q', '-B', branch, from]);
  fs.writeFileSync(path.join(up, file), text);
  await git(['-C', up, 'add', '-A']);
  await git(['-C', up, '-c', 'user.name=u', '-c', 'user.email=u@example.invalid', 'commit', '-q', '-m', `on ${branch}`]);
  const head = await git(['-C', up, 'rev-parse', 'HEAD']);
  await git(['-C', up, 'checkout', '-q', 'main']);
  return head;
}

test('#60 修正 4：远端修正分支还有开着的 PR -> 工作树接着它的 head 建；PR 已合并 / 已关 -> 从 main 重建，租约是远端旧 head', async () => {
  const resumeWorld = await world();
  const remoteHead = await commitOnBranch(resumeWorld.up, STATE.branch);
  const resumed = await resumeWorld.prepare({ remoteBranch: async () => ({ head: remoteHead, openPr: true }) });
  assert.equal(resumed.reused, false);
  assert.equal(resumed.remoteHead, remoteHead, '租约 = 远端已知 head');
  assert.equal(await git(['-C', resumed.worktree, 'rev-parse', STATE.branch]), remoteHead, '接着远端分支的 head');
  assert.ok(resumeWorld.sandboxed.some((command) => command[1] === 'fetch' && command[4] === `+refs/remotes/origin/${STATE.branch}:refs/remotes/origin/${STATE.branch}`));
  assertNoLeak(resumeWorld);

  const freshWorld = await world();
  const stale = await commitOnBranch(freshWorld.up, STATE.branch);
  const fresh = await freshWorld.prepare({ remoteBranch: async () => ({ head: stale, openPr: false }) });
  assert.equal(fresh.remoteHead, stale, '推送时用租约覆盖旧 head（不会撞 non-fast-forward）');
  assert.equal(await git(['-C', fresh.worktree, 'rev-parse', STATE.branch]), freshWorld.upstreamMain, '从最新 main 重建');
  assertNoLeak(freshWorld);

  // 远端还没有这条分支：租约是空串（远端必须还没有）。
  const noneWorld = await world();
  const none = await noneWorld.prepare({ remoteBranch: async () => ({ head: null, openPr: false }) });
  assert.equal(none.remoteHead, '');
});

test('#60 修正 4：再修前远端分支被挪过（pr.update-branch 合了 main）-> 沙箱里快进到远端 head；分叉了就停，不覆盖', async () => {
  const w = await world();
  const first = await w.prepare({ remoteBranch: async () => ({ head: null, openPr: false }) });
  assert.equal(first.remoteHead, '');
  // 远端：在 main 之上多了一个提交（update-branch 的合并提交之类），工作树分支是它的祖先。
  const moved = await commitOnBranch(w.up, STATE.branch, { file: 'merged.mjs' });
  const synced = await w.prepare({ state: { ...STATE, remoteHead: '' }, remoteBranch: async () => ({ head: moved, openPr: true }) });
  assert.equal(synced.reused, true);
  assert.equal(synced.remoteHead, moved);
  assert.equal(await git(['-C', synced.worktree, 'rev-parse', STATE.branch]), moved, '快进到远端 head');
  // 远端和本地 head 一样：不再取。
  const fetches = w.gitCalls.filter((call) => call.args.includes('fetch')).length;
  const same = await w.prepare({ state: { ...STATE, remoteHead: moved }, remoteBranch: async () => ({ head: moved, openPr: true }) });
  assert.equal(same.remoteHead, moved);
  assert.equal(w.gitCalls.filter((call) => call.args.includes('fetch')).length, fetches);

  // 分叉：工作树里有本地提交，远端又被别人换成了另一条线。
  fs.writeFileSync(path.join(synced.worktree, 'local.mjs'), 'export const z = 1;\n');
  await git(['-C', synced.worktree, 'add', 'local.mjs']);
  await git(['-C', synced.worktree, '-c', 'user.name=u', '-c', 'user.email=u@example.invalid', 'commit', '-q', '-m', 'local']);
  const other = await commitOnBranch(w.up, STATE.branch, { file: 'other.mjs' });
  await assert.rejects(
    w.prepare({ state: { ...STATE, remoteHead: moved }, remoteBranch: async () => ({ head: other, openPr: true }) }),
    /branch-diverged/,
  );
  assertNoLeak(w);
});
