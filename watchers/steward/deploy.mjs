import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProfile } from './bin/profile.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LOGIN = /^[a-z\d][a-z\d-]*$/i;

function probe(command, args) {
  return spawnSync(command, args, {
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
}

function checkProfile(errors) {
  let profile;
  try {
    profile = loadProfile();
  } catch (error) {
    errors.push(error.code ? `STEWARD_PROFILE 无法读取：${error.code}` : error.message);
    return null;
  }
  try {
    fs.mkdirSync(profile.stateDir, { recursive: true, mode: 0o700 });
    const directory = fs.mkdtempSync(path.join(profile.stateDir, '.steward-check-'));
    fs.rmdirSync(directory);
  } catch (error) {
    errors.push(`stateDir 不可写：${error.code ?? error.message}`);
  }
  if (profile.github.mode === 'app') {
    try {
      if (!fs.statSync(profile.github.privateKeyFile).isFile()) throw new Error('not a file');
      fs.accessSync(profile.github.privateKeyFile, fs.constants.R_OK);
    } catch {
      errors.push('github.privateKeyFile 不可读或不是文件');
    }
  }
  return profile;
}

function check() {
  const errors = [];
  const node = probe('node', ['--version']);
  if (node.status !== 0 || Number(/^v(\d+)/.exec(node.stdout)?.[1]) < 24
    || !/^v\d+\./.test(node.stdout)) errors.push('需要 Node.js 24 或更新版本');
  const python = probe('python3', ['-c', 'import sys; sys.exit(sys.version_info < (3, 9))']);
  if (python.status !== 0) errors.push('需要 Python 3.9 或更新版本');
  const github = probe('gh', ['api', '--hostname', 'github.com', 'user', '--jq', '.login']);
  const login = github.stdout?.trim();
  if (github.status !== 0 || !LOGIN.test(login ?? '')) errors.push('gh 未登录 github.com 或无法确认登录账号');
  const profile = checkProfile(errors);
  if (profile) {
    const excluded = new Set(profile.excludeRepos.map((repo) => repo.toLowerCase()));
    const repos = new Set([...profile.repos.map((repo) => repo.toLowerCase()), ...Object.keys(profile.policies)]
      .filter((repo) => !excluded.has(repo)));
    if (!repos.size) errors.push('至少为一个巡检仓配置 policies.<repo>.chores.followerLogin');
    for (const repo of repos) {
      const configured = profile.policies[repo]?.chores?.followerLogin;
      const setting = `policies.${repo}.chores.followerLogin`;
      if (typeof configured !== 'string' || !LOGIN.test(configured)) {
        errors.push(`${setting} 缺失或无效，应为 GitHub 登录名字符串`);
      } else if (github.status === 0 && login && login.toLowerCase() !== configured.toLowerCase()) {
        errors.push(`${setting} 与当前 gh 登录账号不一致`);
      }
    }
  }
  if (errors.length) {
    for (const error of errors) console.error(`体检未通过：${error}`);
    return 1;
  }
  console.log('体检通过：node、python3、gh 登录、配置、跟进账号和状态目录。');
  return 0;
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function printSchedule() {
  const profile = process.env.STEWARD_PROFILE
    ? path.resolve(process.env.STEWARD_PROFILE) : '<本机配置绝对路径>';
  console.log(JSON.stringify({
    name: 'PR 总管巡检',
    kind: 'cron',
    executionMode: 'script',
    cronExpr: '*/3 * * * *',
    intervalMs: 180000,
    timezone: 'Asia/Shanghai',
    recurring: true,
    agentKind: 'codex',
    workingDir: path.resolve(ROOT),
    targetSessionId: '<PR 总管伙伴主对话 ID>',
    useWorktree: false,
    scriptConfig: {
      command: `STEWARD_PROFILE=${shellQuote(profile)} python3 -B watchers/steward/bin/steward-script.py`,
      timeoutMs: 165000,
      capabilities: ['sessions.dispatch'],
    },
    notify: { desktop: false, feishu: false },
  }, null, 2));
}

if (process.argv.length === 3 && process.argv[2] === '--check') {
  process.exitCode = check();
} else if (process.argv.length === 3 && process.argv[2] === '--print-schedule') {
  printSchedule();
} else {
  console.error('用法：node watchers/steward/deploy.mjs --check | --print-schedule');
  process.exitCode = 2;
}
