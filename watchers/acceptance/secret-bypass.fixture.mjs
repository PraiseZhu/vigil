// 内置密钥扫描的三种绕过（#67 复审）：合并提交带进来的密钥、含 NUL 的「二进制」文件、像补丁头的行。
// 写闸（gate.test）和推送前扫描（push.test）共用同一份仓库夹具。只在临时目录里跑本地 git，不触网。
import fs from 'node:fs';
import path from 'node:path';
import { localEnv, spawnRun } from './bin/localgit.mjs';
import { tmpDir } from './fake-gh.fixture.mjs';

// 假私钥头按段拼，源码里不出现完整的私钥头。
export const BYPASS_KEY = ['-----BEGIN RSA ' + 'PRIVATE KEY-----', 'MIIEnotARealKeyJustForTests', '-----END RSA ' + 'PRIVATE KEY-----'].join('\n');

export const BYPASS_LABELS = Object.freeze({
  merge: '密钥只在合并提交里',
  nul: '含 NUL 的「二进制」文件',
  header: '新增行像「+++ /dev/null」补丁头',
  message: '密钥只在提交说明里（文件全干净）',
  late: '密钥在第 500 个对象之后（不在第一批 cat-file 里）',
});

export const BYPASS_KINDS = Object.freeze({
  merge: 'merged/leak.pem',
  nul: 'assets/blob.bin',
  header: 'notes/patch.txt',
  message: null,
  late: 'zz-last/leak.pem',
});

/** 仓库：main 一个干净提交，acceptance/1-2-sc3 上按 kind 把假私钥藏进去。 */
export async function buildBypassRepo(kind) {
  if (!Object.hasOwn(BYPASS_KINDS, kind)) throw new Error(`未知的绕过方式：${kind}`);
  let file = BYPASS_KINDS[kind];
  const repoDir = fs.mkdtempSync(path.join(tmpDir(), `acceptance-bypass-${kind}-`));
  const git = async (args) => {
    const result = await spawnRun('git', args, { cwd: repoDir, env: localEnv() });
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
    return String(result.stdout);
  };
  const write = (name, data) => {
    fs.mkdirSync(path.dirname(path.join(repoDir, name)), { recursive: true });
    fs.writeFileSync(path.join(repoDir, name), data);
  };
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.name', 'ExampleUser']);
  await git(['config', 'user.email', 'example@example.test']);
  write('main.txt', 'main\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'main']);
  const mainSha = (await git(['rev-parse', 'HEAD'])).trim();
  const branch = 'acceptance/1-2-sc3';
  await git(['checkout', '-q', '-b', branch]);
  write('fix.txt', 'fix\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'fix']);
  if (kind === 'merge') {
    // 「邪恶合并」：两边的提交都干净，密钥只在合并提交自己的改动里。
    await git(['checkout', '-q', '-b', 'side', mainSha]);
    write('side.txt', 'side\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'side']);
    await git(['checkout', '-q', branch]);
    await git(['merge', '-q', '--no-ff', '--no-commit', 'side']);
    write(file, `${BYPASS_KEY}\n`);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'merge side']);
  } else if (kind === 'nul') {
    // 开头一个 NUL：git 把它当二进制，补丁里只有「Binary files differ」。
    write(file, Buffer.concat([Buffer.from([0]), Buffer.from(`${BYPASS_KEY}\n`)]));
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'binary']);
  } else if (kind === 'message') {
    // 文件全干净，假私钥只写在提交说明里。
    write('clean.txt', 'clean\n');
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', `notes\n\n${BYPASS_KEY}`]);
  } else if (kind === 'late') {
    // 600 个内容各不相同的干净文件，密钥文件按路径排在最后：rev-list 里它在第 500 个对象之后。
    for (let i = 0; i < 600; i += 1) write(`bulk/f${String(i).padStart(4, '0')}.txt`, `clean ${i}\n`);
    write(file, `${BYPASS_KEY}\n`);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'bulk']);
  } else {
    // 新增行「++ /dev/null」在补丁里显示成「+++ /dev/null」，像一个新文件头。
    write(file, `++ /dev/null\n${BYPASS_KEY}\n`);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'header']);
  }
  const tip = (await git(['rev-parse', 'HEAD'])).trim();
  if (kind === 'message') file = `（提交说明 ${tip.slice(0, 12)}）`;
  const bundlePath = path.join(repoDir, 'push.bundle');
  await git(['bundle', 'create', bundlePath, branch]);
  return { repoDir, branch, mainSha, tip, file, bundlePath };
}
