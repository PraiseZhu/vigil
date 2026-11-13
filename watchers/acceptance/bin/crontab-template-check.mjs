#!/usr/bin/env node
// 只读校验 watchers/acceptance/crontab.template：模板是重启后恢复验收机 crontab 的唯一来源，写坏了就等于恢复不出来。
// 查五件事：5 条生效条目都在（每条上方有中文注释说明干什么）、deploy-ff 条目带 --approval-file、
// 没有写死的家目录绝对路径（/home/…、/Users/…、/root/…）、没有疑似令牌、没有重复条目。
// 只读模板文件，不读系统 crontab、不写任何文件、不装 cron。退出码 0 = 通过，非 0 = 不通过（逐条打印原因）。
//
// 用法：node watchers/acceptance/bin/crontab-template-check.mjs [--template <路径>]
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const DEFAULT_TEMPLATE = fileURLToPath(new URL('../crontab.template', import.meta.url));

/**
 * 5 条必须都在的条目。schedule 是节拍字段（原样比对），needles 是命令里必须出现的片段。
 * 顺序按模板里的顺序写，报错也按这个顺序。
 */
export const REQUIRED_ENTRIES = Object.freeze([
  {
    id: 'deploy-ff',
    label: 'deploy-ff 部署拍',
    schedule: '2-59/5 * * * *',
    needles: ['watchers/acceptance/deploy-ff.mjs'],
  },
  {
    id: 'prio-run',
    label: 'prio 看板持续写入',
    schedule: '24,54 * * * *',
    needles: ['prio-run-write/run.sh'],
  },
  {
    id: 'prio-run-field',
    label: '关联 PR 持续写入',
    schedule: '9,39 * * * *',
    needles: ['prio-run-write/run-field.sh'],
  },
  {
    id: 'event-run-boot',
    label: 'event-run 开机拉起',
    schedule: '@reboot',
    needles: ['watchers/acceptance/bin/event-run-ensure.sh'],
  },
  {
    id: 'event-run-minute',
    label: 'event-run 每分钟拉起',
    schedule: '* * * * *',
    needles: ['watchers/acceptance/bin/event-run-ensure.sh'],
  },
]);

/** deploy-ff 条目必须带的参数：没有它就没有人工批准这一闸。 */
export const DEPLOY_APPROVAL_FLAG = '--approval-file';

/** 写死的家目录：模板里一律用 $HOME。 */
export const ABSOLUTE_HOME_PATTERNS = Object.freeze([
  { name: '写死的家目录绝对路径', re: /(^|[\s"'=:])\/(?:home|Users|root)\// },
]);

/** 疑似令牌。只认常见前缀与变量名，不猜；命中就读起来像往模板里粘了真凭据。 */
export const TOKEN_PATTERNS = Object.freeze([
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{8,}/ },
  { name: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{8,}/ },
  { name: 'LLM 代理密钥变量', re: /\bLLM_PROXY\w*/ },
  { name: 'OpenAI 风格密钥', re: /\bsk-[A-Za-z0-9]{16,}/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}/ },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: '私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]);

/**
 * 切行：注释行（首字符 #）、空行、生效行分开。生效行的节拍是 5 个字段，或一个 @关键字（@reboot 等）。
 * 写不出节拍或没有命令的行按「认不出的行」报，不猜。
 */
export function parseTemplate(text) {
  const entries = [];
  const problems = [];
  const lines = String(text).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    const no = index + 1;
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    if (tokens[0].startsWith('@')) {
      if (tokens.length < 2) {
        problems.push({ code: 'unparsable', message: `第 ${no} 行只有节拍 ${tokens[0]}，没有命令` });
        continue;
      }
      entries.push({ no, line, schedule: tokens[0], command: tokens.slice(1).join(' ') });
      continue;
    }
    if (tokens.length < 6) {
      problems.push({
        code: 'unparsable',
        message: `第 ${no} 行不像 cron 条目：需要 5 个节拍字段加命令，实际只有 ${tokens.length} 个字段`,
      });
      continue;
    }
    entries.push({ no, line, schedule: tokens.slice(0, 5).join(' '), command: tokens.slice(5).join(' ') });
  }
  return { entries, lines, problems };
}

/** 条目上方紧挨着的非空行必须是注释：模板要让人看得懂每条在干什么。 */
function missingCommentLines(lines, entries) {
  const missing = [];
  for (const entry of entries) {
    let index = entry.no - 2;
    while (index >= 0 && !lines[index].trim()) index -= 1;
    if (index < 0 || !lines[index].trim().startsWith('#')) missing.push(entry);
  }
  return missing;
}

/**
 * 校验模板文本。返回 { ok, problems: [{ code, message }] }，消息里带期望值与实际值。
 */
export function checkTemplate(text) {
  const { entries, lines, problems: parseProblems } = parseTemplate(text);
  const problems = [...parseProblems];

  if (entries.length !== REQUIRED_ENTRIES.length) {
    problems.push({
      code: 'entry-count',
      message: `生效条目应为 ${REQUIRED_ENTRIES.length} 条，实际 ${entries.length} 条`,
    });
  }

  for (const required of REQUIRED_ENTRIES) {
    const matched = entries.filter(
      (entry) => entry.schedule === required.schedule && required.needles.every((needle) => entry.command.includes(needle)),
    );
    if (matched.length === 0) {
      problems.push({
        code: 'missing-entry',
        message: `缺条目「${required.label}」：期望节拍 ${required.schedule}，命令里含 ${required.needles.join(' 和 ')}，实际没有匹配的生效行`,
      });
      continue;
    }
    if (matched.length > 1) {
      problems.push({
        code: 'duplicate-entry',
        message: `条目「${required.label}」匹配到 ${matched.length} 条（第 ${matched.map((entry) => entry.no).join('、')} 行），只应有 1 条`,
      });
    }
  }

  const deploy = entries.filter((entry) => entry.command.includes(REQUIRED_ENTRIES[0].needles[0]));
  for (const entry of deploy) {
    if (!entry.command.includes(DEPLOY_APPROVAL_FLAG)) {
      problems.push({
        code: 'deploy-no-approval',
        message: `第 ${entry.no} 行的 deploy-ff 条目缺 ${DEPLOY_APPROVAL_FLAG}：期望带上人工批准文件参数，实际命令里没有`,
      });
    }
  }

  for (const { name, re } of ABSOLUTE_HOME_PATTERNS) {
    for (const entry of entries) {
      if (re.test(entry.line)) {
        problems.push({
          code: 'absolute-home',
          message: `第 ${entry.no} 行${name}：期望写 $HOME，实际写了写死的路径（不要把本机绝对路径带进模板）`,
        });
      }
    }
  }

  for (const { name, re } of TOKEN_PATTERNS) {
    for (const entry of entries) {
      if (re.test(entry.line)) {
        problems.push({ code: 'token', message: `第 ${entry.no} 行疑似${name}：模板里不许出现凭据，实际命中令牌格式` });
      }
    }
  }

  const seen = new Map();
  for (const entry of entries) {
    const key = entry.line.replace(/\s+/g, ' ');
    if (seen.has(key)) {
      problems.push({
        code: 'duplicate-line',
        message: `第 ${entry.no} 行与第 ${seen.get(key)} 行完全重复：同一条 cron 条目只写一次`,
      });
      continue;
    }
    seen.set(key, entry.no);
  }

  for (const entry of missingCommentLines(lines, entries)) {
    problems.push({
      code: 'missing-comment',
      message: `第 ${entry.no} 行上方没有注释：每条条目前面要有一行中文注释说明它干什么`,
    });
  }

  return { ok: problems.length === 0, problems };
}

/** CLI：读文件、校验、打印。文件读不到也算不通过（模板不存在时恢复流程就没有依据）。 */
export function main(argv = process.argv.slice(2), { stderr = process.stderr, stdout = process.stdout } = {}) {
  let templatePath = DEFAULT_TEMPLATE;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--template') {
      templatePath = argv[i + 1];
      if (!templatePath) {
        stderr.write('❌ --template 后面要给路径\n');
        return 2;
      }
      i += 1;
      continue;
    }
    if (argv[i] === '--help' || argv[i] === '-h') {
      stdout.write('用法：node watchers/acceptance/bin/crontab-template-check.mjs [--template <路径>]\n');
      return 0;
    }
    stderr.write(`❌ 认不出的参数：${argv[i]}（只支持 --template <路径>，查看用法用 --help）\n`);
    return 2;
  }

  let text;
  try {
    text = fs.readFileSync(templatePath, 'utf8');
  } catch (error) {
    stderr.write(`❌ 读不到模板 ${templatePath}（${error.code || error.message}）：期望文件存在且可读\n`);
    return 1;
  }

  const { ok, problems } = checkTemplate(text);
  if (ok) {
    stdout.write(`✅ crontab 模板校验通过：${path.resolve(templatePath)}\n`);
    return 0;
  }
  stderr.write(`❌ crontab 模板校验不通过（${problems.length} 处）：${path.resolve(templatePath)}\n`);
  for (const problem of problems) stderr.write(`  - [${problem.code}] ${problem.message}\n`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
