#!/usr/bin/env node
// 部署检查用的进程探针（#47 SC1 / SC10）：doctor.mjs 自己不含 child_process，要跑进程都从这里走。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBwrapArgs, maskList, probeBwrap } from './sandbox.mjs';
import { run as procRun } from './proc.mjs';

/** PATH 里找可执行文件（只扫目录，不起进程）。 */
export function which(cmd, env = process.env) {
  const dirs = String(env?.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, cmd);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // 这个目录里没有，继续。
    }
  }
  return null;
}

/** 沙箱里的读取探针：只回「读到没读到」，绝不打印内容。 */
const READER_SOURCE = `import fs from 'node:fs';
const [, , targetsFile, outFile] = process.argv;
const targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
const readable = [];
const listed = [];
for (const file of targets.files || []) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    if (content.length > 0) readable.push(file);
  } catch {
    // 读不到就是遮住了。
  }
}
for (const dir of targets.dirs || []) {
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) listed.push(dir);
  } catch {
    // 读不到就是遮住了。
  }
}
fs.writeFileSync(outFile, JSON.stringify({ readable, listed }));
`;

function cleanEnv(env) {
  const out = { NO_COLOR: '1', GH_PROMPT_DISABLED: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'TZ']) {
    if (env?.[key] !== undefined) out[key] = env[key];
  }
  return out;
}

function firstLine(text) {
  return String(text || '').trim().split('\n')[0] || '';
}

/**
 * 探针集合：
 * - runWriteCommand(action)：把一条动作交给 writeCommand，看它当场回不回结果。
 * - sandboxMask()：在 bwrap 里跑一个读文件的小脚本，确认遮罩名单上的文件和凭证目录都读不到。
 * - which(cmd)：PATH 里有没有这个命令。
 */
export function createProbes({ profile, env = process.env, run = procRun, hostConfig } = {}) {
  async function runWriteCommand(action) {
    const argv = profile?.writeCommand;
    if (!Array.isArray(argv) || argv.length === 0) {
      return { code: 127, stdout: '', stderr: '没有配 writeCommand' };
    }
    return run(argv[0], argv.slice(1), {
      env: cleanEnv(env),
      input: JSON.stringify(action),
      timeoutMs: 30000,
    });
  }

  async function sandboxMask() {
    if (!(await probeBwrap(run))) return { ok: false, detail: 'bwrap 不可用（命令不在或起不来）' };
    if (!profile?.profilePath) return { ok: false, detail: '读不到 profile，无法算遮罩名单' };
    const roundDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acceptance-doctor-'));
    try {
      let rawProfile = {};
      try {
        rawProfile = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
      } catch {
        rawProfile = {};
      }
      const masks = maskList({ rawProfile, profile, hostConfig, env });
      const reader = path.join(roundDir, 'reader.mjs');
      const targetsFile = path.join(roundDir, 'targets.json');
      const outFile = path.join(roundDir, 'out.json');
      fs.writeFileSync(reader, READER_SOURCE);
      fs.writeFileSync(targetsFile, JSON.stringify({ files: masks.files, dirs: masks.dirs }));
      const sandboxEnvironment = {
        PATH: env?.PATH || '/usr/bin:/bin',
        HOME: path.join(roundDir, 'home'),
        TMPDIR: path.join(roundDir, 'tmp'),
      };
      fs.mkdirSync(sandboxEnvironment.HOME, { recursive: true });
      fs.mkdirSync(sandboxEnvironment.TMPDIR, { recursive: true });
      const args = buildBwrapArgs({
        profile,
        roundDir,
        masks,
        binds: [roundDir],
        env: sandboxEnvironment,
      });
      const result = await run('bwrap', [...args, '--', process.execPath, reader, targetsFile, outFile], {
        timeoutMs: 60000,
      });
      if (!result || result.code !== 0) {
        return { ok: false, detail: `沙箱里的读取探针没跑起来（退出码 ${result?.code ?? '未知'}）：${firstLine(result?.stderr)}` };
      }
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      } catch {
        return { ok: false, detail: '读取探针没有留下结果' };
      }
      const leaks = [...(parsed.readable || []), ...(parsed.listed || [])];
      if (leaks.length > 0) {
        // 只报数量：路径和内容都不回显。
        return { ok: false, detail: `沙箱里还有 ${leaks.length} 处凭证读得到` };
      }
      return {
        ok: true,
        detail: `遮掉 ${masks.files.length} 个文件、${masks.dirs.length} 个目录，沙箱里一个都读不到`,
      };
    } catch (error) {
      return { ok: false, detail: String(error?.message || error) };
    } finally {
      fs.rmSync(roundDir, { recursive: true, force: true });
    }
  }

  return { runWriteCommand, sandboxMask, which: (cmd) => which(cmd, env) };
}
