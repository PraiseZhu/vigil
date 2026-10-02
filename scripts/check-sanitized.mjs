#!/usr/bin/env node
// 零依赖脚本:在提交/CI 前检查仓库里有没有残留敏感内容。
//
// 两层检查:
//   1. 内置通用模式(任何环境都生效):本机绝对路径、私钥头、常见 token 格式。
//   2. 私有词清单(可选):从仓库根目录未跟踪的 config/sanitize-denylist.local 读取,
//      每行一个正则表达式。这个文件本身**不会被提交**(已在 .gitignore 里排除),
//      本脚本也绝不会创建或写入它——私有词只应该存在于贡献者自己机器上的本地文件里。
//      CI 环境没有这个文件是预期行为,会打印一行提示并仅跑内置的通用检查。
//
// 用法: node scripts/check-sanitized.mjs
// 退出码: 0 = 未发现问题;非 0 = 发现至少一处命中,并打印 file:line。

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DENYLIST_PATH = path.join(REPO_ROOT, 'config', 'sanitize-denylist.local');

// 内置通用模式:不依赖任何本机/组织特定信息,公开仓库里永远应该生效。
const BUILTIN_PATTERNS = [
  { name: 'absolute-home-path', re: /\/Users\/[A-Za-z0-9._-]+/g },
  { name: 'private-key-header', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'openai-style-key', re: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
];

function loadDenylistPatterns() {
  if (!existsSync(DENYLIST_PATH)) {
    console.log(
      `[check-sanitized] 未找到本地私有词清单 ${path.relative(REPO_ROOT, DENYLIST_PATH)}，` +
        '仅执行内置的通用模式检查（CI 环境下这是预期行为）。',
    );
    return [];
  }
  const lines = readFileSync(DENYLIST_PATH, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return lines.map((line, index) => {
    let re;
    try {
      re = new RegExp(line, 'gi');
    } catch (error) {
      throw new Error(
        `${path.relative(REPO_ROOT, DENYLIST_PATH)}:${index + 1} 不是合法正则: ${error.message}`,
      );
    }
    return { name: `denylist:${line}`, re };
  });
}

function listTrackedFiles() {
  const output = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

function scanFileContents(patterns) {
  const hits = [];
  for (const file of listTrackedFiles()) {
    const abs = path.join(REPO_ROOT, file);
    let content;
    try {
      content = readFileSync(abs, 'utf8');
    } catch {
      continue; // 二进制文件/读取失败,跳过
    }
    // check-sanitized 自身必须声明通用模式字符串,否则会命中自己——这里按行扫描源文件内容,
    // 跳过本脚本自身文件,避免模式定义行被误报。
    if (path.resolve(abs) === path.resolve(fileURLToPath(import.meta.url))) {
      continue;
    }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      for (const { name, re } of patterns) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          hits.push({ file, line: i + 1, pattern: name });
        }
      }
    }
  }
  return hits;
}

function scanCommitMetadata(patterns) {
  const output = execFileSync(
    'git',
    ['log', '--format=%H%x09%an%x09%ae%x09%cn%x09%ce'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  const hits = [];
  for (const rawLine of output.split('\n')) {
    if (!rawLine.trim()) continue;
    const [sha, authorName, authorEmail, committerName, committerEmail] = rawLine.split('\t');
    const fields = { authorName, authorEmail, committerName, committerEmail };
    for (const [fieldName, value] of Object.entries(fields)) {
      if (!value) continue;
      for (const { name, re } of patterns) {
        re.lastIndex = 0;
        if (re.test(value)) {
          hits.push({ file: `git-log:${sha.slice(0, 12)}:${fieldName}`, line: value, pattern: name });
        }
      }
    }
  }
  return hits;
}

function main() {
  const patterns = [...BUILTIN_PATTERNS, ...loadDenylistPatterns()];
  const contentHits = scanFileContents(patterns);
  const metadataHits = scanCommitMetadata(patterns);
  const allHits = [...contentHits, ...metadataHits];

  if (allHits.length === 0) {
    console.log('[check-sanitized] 未发现敏感内容。');
    return;
  }

  console.error(`[check-sanitized] 发现 ${allHits.length} 处可能的敏感内容:`);
  for (const hit of allHits) {
    console.error(`  ${hit.file}:${hit.line}  (${hit.pattern})`);
  }
  process.exitCode = 1;
}

main();
