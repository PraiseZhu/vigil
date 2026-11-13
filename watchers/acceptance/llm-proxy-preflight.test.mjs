// #458：只对 provider.apiKey 为字面量 $LLM_PROXY_API_KEY 的模型做预检与分类。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ENV_BACKOFF_MINUTES, ENV_PROBLEM_PREFIX, backoffUntil } from './bin/trigger.mjs';
import { tmpDir } from './fake-gh.fixture.mjs';
import {
  CATEGORY_MISSING_LLM_PROXY_API_KEY,
  CATEGORY_UNKNOWN,
  CATEGORY_PI_FAILED,
  classifyPiFailure,
  formatAuthDiagnostic,
  llmProxyPreflight,
  modelAuthScope,
  inspectLlmProxyReady,
  clearAuthEnvBackoff,
  authEnvBackoffPath,
  loadModelsFromPiCommand,
  markAuthEnvBackoff,
  nextAuthEnvBackoffUntil,
  isAuthEnvBackingOff,
  providerApiKeyRef,
  readAuthEnvBackoff,
  selectModelId,
  UNKNOWN_BACKOFF_MINUTES,
} from './host/llm-proxy-preflight.mjs';

const PROXY_MODEL = 'proxy/flash';
const OTHER_MODEL = 'other/flash';

function modelsFixture(overrides = {}) {
  return {
    providers: {
      proxy: { apiKey: '$LLM_PROXY_API_KEY', baseUrl: 'https://example.invalid' },
      other: { apiKey: '$OTHER_API_KEY', baseUrl: 'https://other.example.invalid' },
      literal: { apiKey: 'not-an-env-ref', baseUrl: 'https://literal.example.invalid' },
      ...overrides.providers,
    },
    models: {
      [PROXY_MODEL]: { provider: 'proxy' },
      [OTHER_MODEL]: { provider: 'other' },
      'literal/model': { provider: 'literal' },
      'no-key/model': { provider: 'none' },
      ...overrides.models,
    },
  };
}

test('#458 SC1 依赖 $LLM_PROXY_API_KEY 且变量为空或未设时预检失败，返回值不含变量值', () => {
  const models = modelsFixture();
  const missing = llmProxyPreflight({ models, modelId: PROXY_MODEL, env: {} });
  assert.equal(missing.ok, false);
  assert.equal(missing.category, CATEGORY_MISSING_LLM_PROXY_API_KEY);
  assert.equal(JSON.stringify(missing).includes('LLM_PROXY_API_KEY='), false);

  const empty = llmProxyPreflight({ models, modelId: PROXY_MODEL, env: { LLM_PROXY_API_KEY: '' } });
  assert.equal(empty.ok, false);
  assert.equal(empty.category, CATEGORY_MISSING_LLM_PROXY_API_KEY);
  assert.doesNotMatch(JSON.stringify(empty), /super-secret|LLM_PROXY_API_KEY=/);
});

test('#458 SC1 该变量非空时预检通过，返回对象仍不含变量值', () => {
  const secret = 'super-secret-test-value';
  const ok = llmProxyPreflight({
    models: modelsFixture(),
    modelId: PROXY_MODEL,
    env: { LLM_PROXY_API_KEY: secret },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.category, null);
  assert.equal(JSON.stringify(ok).includes(secret), false);
});

test('#458 SC2 其他认证方式在 LLM_PROXY_API_KEY 未设时不拦', () => {
  const models = modelsFixture();
  const env = {};
  assert.equal(llmProxyPreflight({ models, modelId: OTHER_MODEL, env }).ok, true);
  assert.equal(llmProxyPreflight({ models, modelId: 'literal/model', env }).ok, true);
  assert.equal(llmProxyPreflight({ models, modelId: 'no-key/model', env }).ok, true);
  // 命令行名字像代理模型，但模型表里的 provider 并不依赖该变量：不拦。
  const aliased = modelsFixture({
    models: { 'vendor/deepseek/flash': { provider: 'other' } },
  });
  assert.equal(llmProxyPreflight({ models: aliased, modelId: 'vendor/deepseek/flash', env }).ok, true);
  // 没有模型表、或找不到该模型：不凭命令行名字猜测，不拦。
  assert.equal(llmProxyPreflight({ models: null, modelId: 'vendor/anything', env }).ok, true);
  assert.equal(llmProxyPreflight({ models: modelsFixture(), modelId: 'unknown/model', env }).ok, true);
});

test('#458 解析所选模型的 provider.apiKey，不把命令行名字当成依赖', () => {
  const models = modelsFixture();
  assert.equal(providerApiKeyRef(models, PROXY_MODEL), '$LLM_PROXY_API_KEY');
  assert.equal(providerApiKeyRef(models, OTHER_MODEL), '$OTHER_API_KEY');
  assert.equal(providerApiKeyRef(models, 'vendor/deepseek/flash'), undefined);
  assert.equal(selectModelId(['sh', '-c', 'exec pi "$@"', 'pi', '--model', PROXY_MODEL, '--thinking', 'max']), PROXY_MODEL);
  assert.equal(selectModelId(['pi', '--model=proxy/flash']), PROXY_MODEL);
});

test('#458 从 piCommand 里的绝对路径加载 models.json，不猜模型名', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'models.json');
  fs.writeFileSync(file, JSON.stringify(modelsFixture()));
  const loaded = loadModelsFromPiCommand([
    'sh',
    '-c',
    `cp ${file} "$HOME/.pi/agent/models.json" && exec pi "$@"`,
    'pi',
    '--model',
    PROXY_MODEL,
  ]);
  assert.equal(providerApiKeyRef(loaded, PROXY_MODEL), '$LLM_PROXY_API_KEY');
});


test('#458 生产布局：只有 providers、没有 models 项时，用模型表里与 id 第一段吻合的 provider.apiKey', () => {
  const dir = tmpDir();
  const modelsFile = path.join(dir, 'models.json');
  const settingsFile = path.join(dir, 'settings.json');
  const productionLike = {
    $schema: 'https://example.invalid/models.json',
    providers: { proxy: { apiKey: '$LLM_PROXY_API_KEY', baseUrl: 'https://example.invalid' } },
  };
  fs.writeFileSync(modelsFile, `${JSON.stringify(productionLike)}\n`);
  fs.writeFileSync(settingsFile, '{}\n');
  const modelId = 'proxy/flash:discount';
  const command = [
    'sh',
    '-c',
    `mkdir -p "$HOME/.pi/agent" && cp ${modelsFile} ${settingsFile} "$HOME/.pi/agent/" && exec pi "$@"`,
    'pi',
    '--model',
    modelId,
    '--thinking',
    'max',
    '--no-session',
  ];
  const loaded = loadModelsFromPiCommand(command);
  assert.equal(selectModelId(command), modelId);
  assert.equal(providerApiKeyRef(loaded, modelId), '$LLM_PROXY_API_KEY');
  assert.equal(llmProxyPreflight({ models: loaded, modelId, env: {} }).ok, false);
  assert.equal(llmProxyPreflight({ models: loaded, modelId, env: { LLM_PROXY_API_KEY: 'x' } }).ok, true);
  // 第一段对不上 providers 的键：不拦。
  assert.equal(llmProxyPreflight({ models: loaded, modelId: 'vendor/flash:discount', env: {} }).ok, true);
  // 显式 models.provider 优先于 id 第一段。
  const explicit = {
    providers: {
      proxy: { apiKey: '$LLM_PROXY_API_KEY' },
      other: { apiKey: '$OTHER_API_KEY' },
    },
    models: { 'proxy/flash:discount': { provider: 'other' } },
  };
  assert.equal(providerApiKeyRef(explicit, 'proxy/flash:discount'), '$OTHER_API_KEY');
  assert.equal(llmProxyPreflight({ models: explicit, modelId: 'proxy/flash:discount', env: {} }).ok, true);
});

test('#458 SC8/SC9 分类器对已知缺密钥原文做精确匹配，只返回 code 与类别，假凭证不泄漏', () => {
  const fake = 'sk-fake-credential-for-test-do-not-store';
  const hit = classifyPiFailure({
    code: 1,
    stderr: `No API key found for proxy.\nAuthorization: Bearer ${fake}`,
    models: modelsFixture(),
    modelId: PROXY_MODEL,
  });
  assert.equal(hit.category, CATEGORY_MISSING_LLM_PROXY_API_KEY);
  assert.equal(hit.code, 1);
  assert.equal(Object.keys(hit).sort().join(','), 'category,code');
  assert.equal(JSON.stringify(hit).includes(fake), false);
  assert.equal(JSON.stringify(hit).includes('No API key found'), false);

  const almost = classifyPiFailure({
    code: 1,
    stderr: 'No API key found for proxy!',
    models: modelsFixture(),
    modelId: PROXY_MODEL,
  });
  assert.equal(almost.category, CATEGORY_PI_FAILED);

  const otherAuth = classifyPiFailure({
    code: 1,
    stderr: 'No API key found for proxy.',
    models: modelsFixture(),
    modelId: OTHER_MODEL,
  });
  assert.equal(otherAuth.category, CATEGORY_PI_FAILED, '不依赖该变量的模型即使文案相同也不判成代理缺密钥');

  const net = classifyPiFailure({
    code: 1,
    stderr: 'ECONNRESET connecting to example.invalid',
    models: modelsFixture(),
    modelId: PROXY_MODEL,
  });
  assert.equal(net.category, CATEGORY_UNKNOWN);

  const diag = formatAuthDiagnostic(hit);
  assert.match(diag, /code=1/);
  assert.match(diag, new RegExp(CATEGORY_MISSING_LLM_PROXY_API_KEY));
  assert.equal(diag.includes(fake), false);
  assert.equal(diag.startsWith(ENV_PROBLEM_PREFIX), false, '格式化函数本身不带环境前缀，由入口决定');
});

test('#458 确认环境失败按 ENV_BACKOFF_MINUTES 做真实时间退避，短间隔重试不算退避到期', () => {
  assert.deepEqual(ENV_BACKOFF_MINUTES, [30, 120, 360]);
  const t0 = Date.parse('2026-11-13T12:00:00.000Z');
  assert.equal(nextAuthEnvBackoffUntil(1, t0), new Date(t0 + 30 * 60 * 1000).toISOString());
  assert.equal(nextAuthEnvBackoffUntil(2, t0), new Date(t0 + 120 * 60 * 1000).toISOString());
  assert.equal(nextAuthEnvBackoffUntil(3, t0), new Date(t0 + 360 * 60 * 1000).toISOString());
  assert.equal(nextAuthEnvBackoffUntil(9, t0), new Date(t0 + 360 * 60 * 1000).toISOString());

  const dir = path.join(tmpDir(), 'host');
  const stamp = markAuthEnvBackoff({
    dir,
    nowMs: t0,
    failures: 1,
    code: 1,
    category: CATEGORY_MISSING_LLM_PROXY_API_KEY,
  });
  assert.equal(stamp.until, new Date(t0 + 30 * 60 * 1000).toISOString());
  const read = readAuthEnvBackoff(dir);
  assert.equal(read.until, stamp.until);
  assert.equal(read.failures, 1);
  assert.equal(read.category, CATEGORY_MISSING_LLM_PROXY_API_KEY);
  assert.equal(read.code, 1);
  assert.equal(JSON.stringify(read).includes('No API key'), false);

  // 1 秒后仍在退避窗内。
  assert.equal(Date.parse(read.until) > t0 + 1000, true);

  const rounds = [
    {
      round: 1,
      status: '中断',
      reason: `${ENV_PROBLEM_PREFIX}${formatAuthDiagnostic({ code: 1, category: CATEGORY_MISSING_LLM_PROXY_API_KEY })}`,
      finishedAt: '2026-11-13T12:00:00.000Z',
      createdAt: '2026-11-13T12:00:00.000Z',
    },
  ];
  assert.equal(Date.parse(backoffUntil(rounds)) - Date.parse(rounds[0].finishedAt), 30 * 60 * 1000);
});

test('#458 未知失败按独立真实时间退避，不套用环境 30/120/360 分钟表', () => {
  const t0 = Date.parse('2026-11-13T12:00:00.000Z');
  assert.equal(
    Date.parse(nextAuthEnvBackoffUntil(1, t0, { minutes: UNKNOWN_BACKOFF_MINUTES })) - t0,
    UNKNOWN_BACKOFF_MINUTES[0] * 60 * 1000,
  );
  assert.equal(
    Date.parse(nextAuthEnvBackoffUntil(2, t0, { minutes: UNKNOWN_BACKOFF_MINUTES })) - t0,
    UNKNOWN_BACKOFF_MINUTES[1] * 60 * 1000,
  );
  assert.equal(
    Date.parse(nextAuthEnvBackoffUntil(3, t0, { minutes: UNKNOWN_BACKOFF_MINUTES })) - t0,
    UNKNOWN_BACKOFF_MINUTES[2] * 60 * 1000,
  );
  assert.notEqual(UNKNOWN_BACKOFF_MINUTES[0], ENV_BACKOFF_MINUTES[0]);
  const dir = tmpDir();
  const stamp = markAuthEnvBackoff({ dir, nowMs: t0, failures: 1, code: 1, category: CATEGORY_UNKNOWN });
  assert.equal(Date.parse(stamp.until) - t0, UNKNOWN_BACKOFF_MINUTES[0] * 60 * 1000);
  assert.equal(isAuthEnvBackingOff(stamp, t0 + 1000), true);
  assert.equal(isAuthEnvBackingOff(stamp, t0 + UNKNOWN_BACKOFF_MINUTES[0] * 60 * 1000), false);
});


test('#458 修复回归：作用域和失败类别历史互不覆盖，成功清除不影响其他模型', () => {
  const models = modelsFixture();
  const scope = modelAuthScope(models, PROXY_MODEL);
  const other = modelAuthScope(models, OTHER_MODEL);
  const dir = tmpDir();
  const nowMs = Date.parse('2026-11-13T12:00:00.000Z');
  markAuthEnvBackoff({ dir, scope, nowMs, failures: 2, category: CATEGORY_UNKNOWN });
  markAuthEnvBackoff({ dir, scope, nowMs, failures: 1, category: CATEGORY_MISSING_LLM_PROXY_API_KEY });
  markAuthEnvBackoff({ dir, scope: other, nowMs, failures: 3, category: CATEGORY_UNKNOWN });
  assert.equal(readAuthEnvBackoff(dir, { scope, category: CATEGORY_UNKNOWN }).failures, 2);
  assert.equal(readAuthEnvBackoff(dir, { scope }).failures, 1);
  clearAuthEnvBackoff(dir, { scope });
  assert.equal(readAuthEnvBackoff(dir, { scope }), null);
  assert.equal(readAuthEnvBackoff(dir, { scope, category: CATEGORY_UNKNOWN }), null);
  assert.equal(readAuthEnvBackoff(dir, { scope: other, category: CATEGORY_UNKNOWN }).failures, 3);
  const encoded = fs.readFileSync(authEnvBackoffPath(dir, { scope: other, category: CATEGORY_UNKNOWN }), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(encoded)).sort(), ['category', 'code', 'failures', 'until']);
  assert.throws(() => authEnvBackoffPath(dir, { scope: '../outside' }));
});

test('#458 修复回归：预检到期保留历史；旧无作用域戳不阻塞其他认证', () => {
  const dir = tmpDir();
  const models = modelsFixture();
  const scope = modelAuthScope(models, PROXY_MODEL);
  const t0 = Date.parse('2026-11-13T12:00:00.000Z');
  const stamp = markAuthEnvBackoff({ dir, scope, nowMs: t0, failures: 2, category: CATEGORY_UNKNOWN });
  const nowMs = Date.parse(stamp.until);
  assert.equal(inspectLlmProxyReady({ models, modelId: PROXY_MODEL, dir, nowMs, env: { LLM_PROXY_API_KEY: 'fake-value' } }).ready, true);
  assert.equal(readAuthEnvBackoff(dir, { scope, category: CATEGORY_UNKNOWN }).failures, 2);
  markAuthEnvBackoff({ dir, nowMs, failures: 1 });
  assert.equal(inspectLlmProxyReady({ models, modelId: OTHER_MODEL, dir, nowMs, env: {} }).ready, true);
  assert.equal(readAuthEnvBackoff(dir).failures, 1, '不改写旧格式历史戳');
});
