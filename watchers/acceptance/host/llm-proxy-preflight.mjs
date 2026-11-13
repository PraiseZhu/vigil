// #458：判断所选模型的 provider.apiKey 是否为字面量 $LLM_PROXY_API_KEY，并做认领前/调用前预检。
// 只看调用方传入的模型表和 env 里该变量是否非空；不读 secrets/，返回值不含变量值和 pi 输出原文。
import fs from 'node:fs';
import path from 'node:path';
import { ENV_BACKOFF_MINUTES } from '../bin/trigger.mjs';
import { hasNetworkSignal, isNetworkErrorText } from '../bin/net-errors.mjs';

export const LLM_PROXY_API_KEY_REF = '$LLM_PROXY_API_KEY';
export const CATEGORY_MISSING_LLM_PROXY_API_KEY = 'missing-llm-proxy-api-key';
export const CATEGORY_UNKNOWN = 'unknown';
export const CATEGORY_PI_FAILED = 'pi-failed';
export const AUTH_ENV_BACKOFF_FILE = 'llm-proxy-preflight.json';
/** 网络/未知：独立于环境退避的真实时间窗口，计入修复次数上限，不能用 0 间隔立刻再试。 */
export const UNKNOWN_BACKOFF_MINUTES = [5, 15, 60];

export function selectModelId(piCommand) {
  if (!Array.isArray(piCommand)) return undefined;
  for (let i = 0; i < piCommand.length; i += 1) {
    const arg = String(piCommand[i]);
    if (arg === '--model' || arg === '-m') {
      const value = piCommand[i + 1];
      return value == null ? undefined : String(value);
    }
    if (arg.startsWith('--model=')) return arg.slice('--model='.length);
  }
  return undefined;
}

function modelsJsonPathsFromCommand(piCommand) {
  const out = [];
  if (!Array.isArray(piCommand)) return out;
  for (const part of piCommand) {
    const text = String(part);
    if (text.startsWith('/') && /(^|\/)models\.json$/.test(text)) out.push(text);
    for (const match of text.matchAll(/(?:^|[\s'"=])(\/\S+\/models\.json)/g)) {
      out.push(match[1]);
    }
  }
  return [...new Set(out)];
}

export function loadModelsFromPiCommand(piCommand, { readFileSync = fs.readFileSync } = {}) {
  for (const file of modelsJsonPathsFromCommand(piCommand)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // 这条路径读不到就试下一条；都没有就当成无法判定依赖。
    }
  }
  return null;
}

function findModelEntry(modelsField, modelId) {
  if (!modelsField || !modelId) return undefined;
  if (Array.isArray(modelsField)) {
    return modelsField.find((entry) => entry && (entry.id === modelId || entry.name === modelId));
  }
  if (typeof modelsField === 'object') return modelsField[modelId];
  return undefined;
}

/**
 * 先用模型表里该模型自己的 provider；没有 models 项时，仅当 id 的第一段
 * 正好是 providers 的键才采用（对照模型表，不凭空把命令行名字当成依赖）。
 */
export function selectProviderName(models, modelId) {
  if (!models || !modelId) return undefined;
  const entry = findModelEntry(models.models, modelId);
  if (typeof entry?.provider === 'string' && entry.provider) return entry.provider;
  const providers = models.providers;
  if (!providers || typeof providers !== 'object') return undefined;
  const slash = String(modelId).indexOf('/');
  if (slash <= 0) return undefined;
  const head = String(modelId).slice(0, slash);
  const provider = providers[head];
  if (!provider || typeof provider !== 'object' || !Object.prototype.hasOwnProperty.call(providers, head)) return undefined;
  return head;
}

export function providerApiKeyRef(models, modelId) {
  const providerName = selectProviderName(models, modelId);
  if (!providerName) return undefined;
  const provider = models.providers?.[providerName];
  if (!provider || typeof provider !== 'object') return undefined;
  return typeof provider.apiKey === 'string' ? provider.apiKey : undefined;
}

export function llmProxyPreflight({ models, modelId, piCommand, env = {} } = {}) {
  const id = modelId || selectModelId(piCommand);
  const apiKey = providerApiKeyRef(models, id);
  if (apiKey !== LLM_PROXY_API_KEY_REF) return { ok: true, category: null };
  const value = env?.LLM_PROXY_API_KEY;
  if (typeof value === 'string' && value.length > 0) return { ok: true, category: null };
  return { ok: false, category: CATEGORY_MISSING_LLM_PROXY_API_KEY };
}

function outputText(stdout, stderr) {
  return `${stderr ?? ''}\n${stdout ?? ''}`;
}

function outputHasExactMessage(text, message) {
  const lines = String(text).split(/\r?\n/);
  return lines.some((line) => line.trim() === message);
}

export function classifyPiFailure({ code = null, stdout = '', stderr = '', models, modelId } = {}) {
  const exitCode = Number.isInteger(code) ? code : code == null ? null : Number.isFinite(Number(code)) ? Number(code) : null;
  const text = outputText(stdout, stderr);
  const depends = providerApiKeyRef(models, modelId) === LLM_PROXY_API_KEY_REF;
  const providerName = selectProviderName(models, modelId);
  const expected = providerName ? `No API key found for ${providerName}.` : '';
  if (depends && expected && outputHasExactMessage(text, expected)) {
    return { code: exitCode, category: CATEGORY_MISSING_LLM_PROXY_API_KEY };
  }
  if (isNetworkErrorText(text) || hasNetworkSignal(text)) {
    return { code: exitCode, category: CATEGORY_UNKNOWN };
  }
  return { code: exitCode, category: CATEGORY_PI_FAILED };
}

export function formatAuthDiagnostic({ code, category } = {}) {
  const parts = [];
  if (Number.isInteger(code) || (typeof code === 'number' && Number.isFinite(code))) parts.push(`code=${code}`);
  if (category) parts.push(`category=${category}`);
  return parts.join('，') || 'category=unknown';
}

export function nextAuthEnvBackoffUntil(failureCount, nowMs, { minutes = ENV_BACKOFF_MINUTES } = {}) {
  const k = Math.min(Math.max(1, Number(failureCount) || 1), minutes.length);
  return new Date(nowMs + minutes[k - 1] * 60 * 1000).toISOString();
}

export function authEnvBackoffPath(dir) {
  return path.join(dir, AUTH_ENV_BACKOFF_FILE);
}

export function readAuthEnvBackoff(dir, { readFileSync = fs.readFileSync } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(authEnvBackoffPath(dir), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      until: typeof parsed.until === 'string' ? parsed.until : null,
      failures: Number.isInteger(parsed.failures) ? parsed.failures : 0,
      code: Number.isInteger(parsed.code) ? parsed.code : parsed.code === null ? null : null,
      category: typeof parsed.category === 'string' ? parsed.category : null,
    };
  } catch {
    return null;
  }
}

export function markAuthEnvBackoff({
  dir,
  nowMs,
  failures,
  code = null,
  category = CATEGORY_MISSING_LLM_PROXY_API_KEY,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
  renameSync = fs.renameSync,
} = {}) {
  const count = Math.max(1, Number(failures) || 1);
  const stamp = {
    until: nextAuthEnvBackoffUntil(count, nowMs, {
      minutes: category === CATEGORY_UNKNOWN ? UNKNOWN_BACKOFF_MINUTES : ENV_BACKOFF_MINUTES,
    }),
    failures: count,
    code: Number.isInteger(code) ? code : null,
    category,
  };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = authEnvBackoffPath(dir);
  const tmp = `${file}.${process.pid}.${nowMs}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stamp)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  return stamp;
}

export function clearAuthEnvBackoff(dir, { unlinkSync = fs.unlinkSync } = {}) {
  try {
    unlinkSync(authEnvBackoffPath(dir));
  } catch {
    // 没有戳文件就算清掉了。
  }
}

export function isAuthEnvBackingOff(stamp, nowMs) {
  if (!stamp?.until) return false;
  const until = Date.parse(stamp.until);
  return Number.isFinite(until) && nowMs < until;
}

/**
 * 只对确实依赖 $LLM_PROXY_API_KEY 的模型看退避戳。
 * 预检通过就清掉戳；失败且还在窗内则本拍停手，不把短间隔重试当成退避到期。
 */
export function inspectLlmProxyReady({ models, modelId, piCommand, env, dir, nowMs }) {
  const preflight = llmProxyPreflight({ models, modelId, piCommand, env });
  if (preflight.ok) {
    const stamp = readAuthEnvBackoff(dir);
    if (isAuthEnvBackingOff(stamp, nowMs)) {
      return { ready: false, backingOff: true, preflight, stamp };
    }
    if (providerApiKeyRef(models, modelId || selectModelId(piCommand)) === LLM_PROXY_API_KEY_REF) {
      clearAuthEnvBackoff(dir);
    }
    return { ready: true, preflight };
  }
  const stamp = readAuthEnvBackoff(dir);
  if (isAuthEnvBackingOff(stamp, nowMs)) {
    return { ready: false, backingOff: true, preflight, stamp };
  }
  const failures = (stamp?.failures || 0) + 1;
  const next = markAuthEnvBackoff({
    dir,
    nowMs,
    failures,
    code: null,
    category: preflight.category,
  });
  return { ready: false, backingOff: false, preflight, stamp: next };
}
