import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { bodyVersion } from './bin/rounds.mjs';
import { runHelper } from './bin/helper.mjs';
import { createLocalGit, localEnv, spawnRun } from './bin/localgit.mjs';
import { readNeedsHuman, scanForSecrets } from './bin/push.mjs';
import { WriteRejectedError } from './bin/github.mjs';
import { HANDOFF_REPO, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import { REPO, createFakeGithub, createWorld, defaultTree } from './session.fixture.mjs';

// 假私钥头按行拼，源码里不会出现完整的私钥头。
const FAKE_KEY = [
  '-----BEGIN RSA ' + 'PRIVATE KEY-----',
  'MIIEnotARealKeyJustForTests',
  '-----END RSA ' + 'PRIVATE KEY-----',
].join('\n');

function loadProfile() {
  const { home } = writeProfile(tmpDir());
  return loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
}

function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

const now = () => Date.parse('2026-10-24T02:00:00.000Z');

async function run(world, profile, argv, { git: gitApi, onWrite } = {}) {
  const out = sink();
  const err = sink();
  const code = await runHelper(argv, {
    github: createFakeGithub(world, { onWrite }),
    profile,
    now,
    stdout: out,
    stderr: err,
    git: gitApi,
  });
  return { code, out: out.text, err: err.text };
}

/** 测试搭仓用 localgit 的原始执行器（同一个进程出口），环境同样剥掉令牌；localgit.git() 只放扫描和打包用的子命令。 */
async function localGit(dir) {
  return async function run(args) {
    const result = await spawnRun('git', args, { cwd: dir, env: localEnv() });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
    return result.stdout;
  };
}

/** 临时仓：main 上一个干净提交，再开 acceptance 分支加一个文件。 */
async function makeRepo({ file = 'notes.txt', content = 'hello\n', branch = 'acceptance/1-2-sc3' } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpDir(), 'acceptance-repo-'));
  const git = await localGit(dir);
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.name', 'ExampleUser']);
  await git(['config', 'user.email', 'example@example.test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  await git(['add', 'README.md']);
  await git(['commit', '-q', '-m', 'base']);
  await git(['checkout', '-q', '-b', branch]);
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  await git(['add', file]);
  await git(['commit', '-q', '-m', 'change']);
  return { dir, branch, head: (await git(['rev-parse', 'HEAD'])).trim() };
}

function localGitWithoutGitleaks() {
  return createLocalGit({
    run: async (cmd, args, opts) => {
      if (cmd === 'gitleaks') return { code: 127, stdout: '', stderr: 'gitleaks 不在本机' };
      return spawnRun(cmd, args, opts);
    },
  });
}

function pushArgs(repoDir, branch, issueRef = `${REPO}#1`) {
  return [
    'push',
    '--issue',
    issueRef,
    '--round',
    '1',
    '--repo',
    REPO,
    '--branch',
    branch,
    '--worktree',
    repoDir,
    '--base',
    'main',
  ];
}

test('SC7 内置规则扫到假私钥头：退出码 5，不推、只列文件名、不打印内容', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo({ file: 'config/leak.txt', content: `${FAKE_KEY}\n` });

  const result = await run(world, profile, pushArgs(repo.dir, repo.branch), { git: localGitWithoutGitleaks() });
  assert.equal(result.code, 5, result.err);
  assert.match(result.out, /扫到疑似密钥，没推：config\/leak\.txt/);
  assert.equal(result.out.includes('PRIVATE'), false, '不回显密钥内容');
  assert.equal(result.out.includes('MIIEnotARealKey'), false);

  assert.equal(world.writes.filter((action) => action.type === 'branch.push').length, 0);
  const needsHuman = readNeedsHuman(profile, `${REPO}#1`, 1);
  assert.deepEqual(needsHuman, [{ reason: 'secret-found', files: ['config/leak.txt'] }]);
});

test('SC7 scanForSecrets 只看新增行：删掉密钥不算，报告里只有文件名', async () => {
  const profile = loadProfile();
  assert.ok(profile);
  const repo = await makeRepo({ file: 'src/app.mjs', content: "export const ok = 1;\n" });
  const gitApi = localGitWithoutGitleaks();
  const scan = await scanForSecrets({ git: gitApi, worktree: repo.dir, base: 'main', commit: repo.head });
  assert.equal(scan.found, false);
  assert.deepEqual(scan.files, []);
  assert.equal(scan.tool, 'builtin');
});

test('SC7 干净提交：打包之后经 branch.push 推，bundlePath 是绝对路径', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo({ file: 'src/app.mjs', content: 'export const ok = 1;\n' });
  let seen = null;

  const result = await run(world, profile, pushArgs(repo.dir, repo.branch), {
    git: localGitWithoutGitleaks(),
    onWrite: (action) => {
      if (action.type === 'branch.push') {
        seen = {
          absolute: path.isAbsolute(action.bundlePath),
          exists: fs.existsSync(action.bundlePath),
          inside: action.bundlePath.startsWith(repo.dir),
        };
      }
      return undefined;
    },
  });
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(seen, { absolute: true, exists: true, inside: false });
  const push = world.writes.find((action) => action.type === 'branch.push');
  assert.equal(push.repo, REPO);
  assert.equal(push.branch, repo.branch);
  assert.equal(push.dedupeKey, `push:${REPO}:${repo.branch}:${repo.head}`);
  assert.equal(fs.existsSync(push.bundlePath), false, '打包文件用完就删');
});

test('SC7 有 gitleaks 就用 gitleaks 的报告：退出码 5，文件名来自报告', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo({ file: 'src/app.mjs', content: 'export const ok = 1;\n' });
  const gitApi = createLocalGit({
    run: async (cmd, args, opts) => {
      if (cmd === 'gitleaks' && args[0] === 'version') return { code: 0, stdout: 'v8', stderr: '' };
      if (cmd === 'gitleaks') {
        const reportPath = args[args.indexOf('--report-path') + 1];
        fs.writeFileSync(reportPath, JSON.stringify([{ File: 'src/app.mjs', Secret: 'should-not-be-printed' }]));
        return { code: 1, stdout: '', stderr: 'leaks found' };
      }
      return spawnRun(cmd, args, opts);
    },
  });

  const result = await run(world, profile, pushArgs(repo.dir, repo.branch), { git: gitApi });
  assert.equal(result.code, 5, result.err);
  assert.match(result.out, /扫到疑似密钥，没推：src\/app\.mjs/);
  assert.equal(result.out.includes('should-not-be-printed'), false);
  assert.equal(world.writes.length, 0);
});

test('SC7 gitleaks 自己出错（退出码不是 0/1）：不当成干净，不推', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo({ file: 'src/app.mjs', content: 'export const ok = 1;\n' });
  const gitApi = createLocalGit({
    run: async (cmd, args, opts) => {
      if (cmd === 'gitleaks' && args[0] === 'version') return { code: 0, stdout: 'v8', stderr: '' };
      if (cmd === 'gitleaks') return { code: 126, stdout: '', stderr: 'broken' };
      return spawnRun(cmd, args, opts);
    },
  });
  const result = await run(world, profile, pushArgs(repo.dir, repo.branch), { git: gitApi });
  assert.notEqual(result.code, 0);
  assert.match(result.err, /gitleaks 扫描失败/);
  assert.equal(world.writes.filter((action) => action.type === 'branch.push').length, 0);
});

test('SC7 写闸返回 secret-found：退出码 4、不标中断，裁决里写需人工处理', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo({ file: 'src/app.mjs', content: 'export const ok = 1;\n' });

  const rejected = await run(world, profile, pushArgs(repo.dir, repo.branch), {
    git: localGitWithoutGitleaks(),
    onWrite: (action) => {
      if (action.type === 'branch.push') {
        throw new WriteRejectedError('外发被拒', { exitCode: 4, reason: 'secret-found' });
      }
      return undefined;
    },
  });
  assert.equal(rejected.code, 4, rejected.err);
  assert.equal(
    world.writes.filter((action) => action.type === 'comment.update').length,
    0,
    'secret-found 不标中断',
  );
  assert.deepEqual(readNeedsHuman(profile, `${REPO}#1`, 1), [{ reason: 'secret-found', files: [] }]);

  const verdictPath = path.join(dirOf(profile), 'verdict.json');
  fs.writeFileSync(
    verdictPath,
    JSON.stringify({ items: [{ ref: `${REPO}#1`, sc: 1, result: '通过', evidence: '真跑过' }] }),
  );
  const verdict = await run(world, profile, [
    'verdict',
    '--issue',
    `${REPO}#1`,
    '--round',
    '1',
    '--file',
    verdictPath,
  ]);
  assert.equal(verdict.code, 0, verdict.err);
  const body = world.writes.find((action) => action.type === 'comment.update').body;
  assert.match(body.split('\n')[0], /第 1 轮：要修/);
  assert.match(body, /## 需人工处理/);
  assert.match(body, /扫到疑似密钥，没推/);
});

test('SC7 分支名不合规 → 退出码 1；watch 档 push 一律拒绝且零写入', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo();
  const bad = await run(world, profile, pushArgs(repo.dir, 'feature/nope'), { git: localGitWithoutGitleaks() });
  assert.equal(bad.code, 1);
  assert.match(bad.err, /--branch 不合法/);
  assert.equal(world.writes.length, 0);

  const watchWorld = createWorld({ now });
  const rootBody = ['# 交接仓', '', '- [ ] SC1 看一下 验证：unit'].join('\n');
  const root = watchWorld.addIssue({ repo: HANDOFF_REPO, number: 3, body: rootBody });
  watchWorld.addComment(root.ref, roundComment({ round: 1, status: '验收中', bodyVersion: bodyVersion(rootBody) }));
  const watched = await run(watchWorld, profile, pushArgs(repo.dir, repo.branch, `${HANDOFF_REPO}#3`), {
    git: localGitWithoutGitleaks(),
  });
  assert.equal(watched.code, 1);
  assert.match(watched.err, /watch 档只出裁决、写看板/);
  assert.equal(watchWorld.writes.length, 0);
});

function dirOf(profile) {
  return path.dirname(path.dirname(profile.stateDir));
}

test('SC7 localgit 只跑本地 git/gitleaks：拒绝网络子命令和别的程序，环境里不带令牌', async () => {
  const calls = [];
  const git = createLocalGit({
    run: async (cmd, args, options) => {
      calls.push({ cmd, args, env: options.env });
      return { code: 0, stdout: '', stderr: '' };
    },
    env: localEnv({ PATH: '/usr/bin', GH_TOKEN: 'x', GITHUB_TOKEN: 'y', MY_SECRET: 'z', GIT_ASKPASS: 'a', HOME: 'h' }),
  });
  // 允许名单：不在名单里的子命令（网络命令、改仓库状态的命令）一律拒绝，连进程都不起。
  for (const sub of ['push', 'fetch', 'clone', 'pull', 'ls-remote', 'remote', 'config', 'checkout', 'status', 'gc']) {
    await assert.rejects(() => git.git([sub, 'origin']), /只允许本地子命令/);
  }
  await assert.rejects(() => git.git(['bundle', 'unbundle', 'x']), /只允许 bundle create/);
  await assert.rejects(() => git.git(['-c', 'x=y', 'push']), /子命令/);
  await git.git(['rev-parse', 'HEAD']);
  assert.equal(calls.length, 1);
  const env = calls[0].env;
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'MY_SECRET', 'GIT_ASKPASS']) assert.equal(key in env, false, key);
  assert.equal(env.PATH, '/usr/bin');
});

test('SC7 回归：--branch 指向带令牌的提交、检出停在干净分支 → 扫的是要推的分支，退出码 5，不打包不推', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  // 令牌按段拼，源码里不出现完整的令牌格式。
  const fakeToken = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
  const repo = await makeRepo({ file: 'config/creds.txt', content: `token=${fakeToken}\n`, branch: 'acceptance/1-2-sc3' });
  const git = await localGit(repo.dir);
  // 检出切到 main 上开的另一条干净分支：HEAD 相对 main 没有任何新增行。
  await git(['checkout', '-q', 'main']);
  await git(['checkout', '-q', '-b', 'acceptance/1-2-sc4']);

  const result = await run(world, profile, pushArgs(repo.dir, 'acceptance/1-2-sc3'), { git: localGitWithoutGitleaks() });
  assert.equal(result.code, 5, result.err);
  assert.match(result.out, /扫到疑似密钥，没推：config\/creds\.txt/);
  assert.equal(result.out.includes(fakeToken), false, '不回显令牌');
  assert.equal(world.writes.filter((action) => action.type === 'branch.push').length, 0);
});

test('SC7 回归：去重键用 --branch 的提交，不用检出的 HEAD', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo({ file: 'src/app.mjs', content: 'export const ok = 1;\n', branch: 'acceptance/1-2-sc3' });
  const git = await localGit(repo.dir);
  await git(['checkout', '-q', 'main']);
  const mainHead = (await git(['rev-parse', 'HEAD'])).trim();
  assert.notEqual(mainHead, repo.head);

  const result = await run(world, profile, pushArgs(repo.dir, 'acceptance/1-2-sc3'), { git: localGitWithoutGitleaks() });
  assert.equal(result.code, 0, result.err);
  const push = world.writes.find((action) => action.type === 'branch.push');
  assert.equal(push.dedupeKey, `push:${REPO}:acceptance/1-2-sc3:${repo.head}`);
});

test('SC7 有 gitleaks 时扫描范围也是 base..<分支提交>，不是 HEAD', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo({ file: 'src/app.mjs', content: 'export const ok = 1;\n', branch: 'acceptance/1-2-sc3' });
  const git = await localGit(repo.dir);
  await git(['checkout', '-q', 'main']);
  let logOpts = null;
  const gitApi = createLocalGit({
    run: async (cmd, args, opts) => {
      if (cmd === 'gitleaks' && args[0] === 'version') return { code: 0, stdout: 'v8', stderr: '' };
      if (cmd === 'gitleaks') {
        logOpts = args.find((arg) => arg.startsWith('--log-opts='));
        return { code: 0, stdout: '', stderr: '' };
      }
      return spawnRun(cmd, args, opts);
    },
  });
  const result = await run(world, profile, pushArgs(repo.dir, 'acceptance/1-2-sc3'), { git: gitApi });
  assert.equal(result.code, 0, result.err);
  assert.equal(logOpts, `--log-opts=main..${repo.head}`);
});

test('SC7 本地没有 --branch 这条分支 → 不扫不推，退出码 1', async () => {
  const profile = loadProfile();
  const world = defaultTree();
  const repo = await makeRepo();
  const result = await run(world, profile, pushArgs(repo.dir, 'acceptance/1-9-sc9'), { git: localGitWithoutGitleaks() });
  assert.equal(result.code, 1);
  assert.match(result.err, /本地没有分支/);
  assert.equal(world.writes.length, 0);
});
