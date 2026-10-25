#!/usr/bin/env node
// npm test 的入口：所有测试的临时目录都放进这一次运行专用的一个目录（TMPDIR），跑完（包括失败、Ctrl+C）整个删掉。
// 测试自己也会清理（acceptance 的 tmpDir 夹具在进程退出时删），这里是兜底：哪个测试漏删了，也不会留在 /tmp 里。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STEPS = [
  ['node', ['--env-file=watchers/mivo/test.env', '--test', 'watchers/mivo/*.test.mjs']],
  ['node', ['--env-file=watchers/cindy/test.env', '--test', 'watchers/cindy/*.test.mjs']],
  ['python3', ['-B', 'watchers/cindy/cindy-watch-script.test.py']],
  ['python3', ['-B', 'watchers/mivo/mivo-watch-script.test.py']],
  ['node', ['--env-file=watchers/acceptance/test.env', '--test', 'watchers/acceptance/*.test.mjs']],
];

const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-test-run-'));
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try {
    // 有的测试会把目录改成只读 / 000：先放开权限再删。
    spawnSync('chmod', ['-R', 'u+rwx', runDir], { stdio: 'ignore' });
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch (error) {
    process.stderr.write(`[run-tests] 临时目录没删掉：${runDir}（${error.code || error.message}）\n`);
  }
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

const env = { ...process.env, TMPDIR: runDir, TMP: runDir, TEMP: runDir };
let code = 0;
for (const [cmd, args] of STEPS) {
  // node --test 自己展开 glob；shell: false，参数原样传。
  const result = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (result.status !== 0) {
    code = result.status ?? 1;
    break;
  }
}
process.exitCode = code;
