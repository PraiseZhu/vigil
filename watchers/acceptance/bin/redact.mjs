#!/usr/bin/env node
// 脱敏（#46 SC11）：写进 GitHub 的自由文本一律先过这里。
// 密钥模式和推送前的扫描共用同一份 SECRET_PATTERNS，避免两处漂移。
import path from 'node:path';

export const REDACTED = '（已隐去）';

/** 私钥头用数组拼接：本仓的敏感内容扫描会命中相邻的 BEGIN/结尾字样。 */
const KEY_HEADER_SOURCE = ['-----BEGIN', '[A-Z ]*', 'PRIVATE KEY-----'].join('');
const KEY_FOOTER_SOURCE = ['-----END', '[A-Z ]*', 'PRIVATE KEY-----'].join('');

/** 整段私钥（含正文）：脱敏时整段抹掉。 */
export const PRIVATE_KEY_BLOCK = new RegExp(`${KEY_HEADER_SOURCE}[\\s\\S]*?${KEY_FOOTER_SOURCE}`, 'g');

/** 推送前扫描和脱敏共用：只返回命中与否，绝不返回命中内容。 */
export const SECRET_PATTERNS = Object.freeze([
  { name: 'private-key', re: new RegExp(KEY_HEADER_SOURCE, 'g') },
  { name: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: 'github-pat', re: /github_pat_[A-Za-z0-9_]{22,}/g },
  { name: 'slack-token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'openai-style-key', re: /sk-[A-Za-z0-9]{32,}/g },
]);

/** 本机绝对路径：/home、/Users、/tmp、/var、/root 等，和 Windows 盘符路径。 */
const UNIX_PATH = /[\\/](?:home|Users|root|tmp|var|opt|srv|mnt|media|private)[\\/][^\s"'`<>|，。；：、）)]*/g;
const WINDOWS_PATH = /[A-Za-z]:\\[^\s"'`<>|]*/g;
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g;
const RUN_ID = /run[-_ ]?id[:=]\s*\S+/gi;

function prefixesOf(profile) {
  const found = new Set();
  for (const value of [profile?.stateDir, profile?.worktreeDir, profile?.githubTokenFile]) {
    if (typeof value !== 'string' || !value) continue;
    found.add(value);
    const parent = path.dirname(value);
    found.add(parent);
    found.add(path.dirname(parent));
  }
  return [...found].filter((item) => item && item !== '.' && item !== path.sep).sort((a, b) => b.length - a.length);
}

/** 把一段自由文本里的路径、令牌、运行 id 抹掉；其它内容原样保留。 */
export function redact(text, profile) {
  let out = String(text ?? '');
  if (!out) return out;
  out = out.replace(PRIVATE_KEY_BLOCK, REDACTED);
  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }
  for (const prefix of prefixesOf(profile)) {
    out = out.split(prefix).join(REDACTED);
  }
  out = out.replace(UNIX_PATH, REDACTED);
  out = out.replace(WINDOWS_PATH, REDACTED);
  out = out.replace(BEARER, `Bearer ${REDACTED}`);
  out = out.replace(RUN_ID, REDACTED);
  return out;
}
