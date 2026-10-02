#!/usr/bin/env node
// 配置解析：环境变量 > <watcher home>/config/profile.json。
// 不提供任何个人默认值；缺失必需项时在使用处直接报错（fail-closed）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_ENV = 'CINDY_WATCHER_HOME';

/** watcher 的 home 目录：显式 env > 以 bin/ 的上一级为默认 */
export function watcherHome(env = process.env) {
  const explicit = env[HOME_ENV];
  if (explicit) return explicit;
  return path.resolve(HERE, '..');
}

export function profilePath(env = process.env) {
  return path.join(watcherHome(env), 'config', 'profile.json');
}

let cache = null;
let cacheKey = null;

function readProfileFile(home) {
  const file = path.join(home, 'config', 'profile.json');
  if (!fs.existsSync(file)) return {};
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`无法读取配置文件 ${file}：${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`配置文件 ${file} 不是合法 JSON：${error.message}`);
  }
}

/** 读取 profile.json（带进程内缓存，key 为 home 路径，便于测试里切换 env 后拿到新值） */
export function loadProfile(env = process.env) {
  const home = watcherHome(env);
  if (cache && cacheKey === home) return cache;
  cache = readProfileFile(home);
  cacheKey = home;
  return cache;
}

/** 仅供测试使用：清空 profile 缓存 */
export function _resetProfileCacheForTests() {
  cache = null;
  cacheKey = null;
}

/**
 * 必需配置项：env var（如提供）优先，其次 profile.json 的同名字段，否则抛出可读错误。
 * @param {string} key profile.json 里的字段名
 * @param {{envVar?: string, env?: object, hint?: string}} opts
 */
export function requireConfig(key, { envVar, env = process.env, hint = '' } = {}) {
  if (envVar && env[envVar]) return env[envVar];
  const profile = loadProfile(env);
  if (profile && profile[key] !== undefined && profile[key] !== '') return profile[key];
  const envPart = envVar ? `环境变量 ${envVar}` : '';
  const filePart = `${profilePath(env)} 的 "${key}" 字段`;
  const where = envPart ? `${envPart} 或 ${filePart}` : filePart;
  throw new Error(`缺少必需配置「${key}」：请设置 ${where}。${hint}`.trim());
}

/** 可选配置项：取不到时返回 fallback（可以是 undefined） */
export function optionalConfig(key, { envVar, env = process.env, fallback } = {}) {
  if (envVar && env[envVar]) return env[envVar];
  const profile = loadProfile(env);
  if (profile && profile[key] !== undefined && profile[key] !== '') return profile[key];
  return fallback;
}
