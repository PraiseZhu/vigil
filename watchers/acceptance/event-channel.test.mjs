// W4 事件通道：Worker 校验 webhook 签名并入队，本机拉取循环每 2 秒拉一次，
// 60 秒轮询兜底；延迟写到 .prio/latency.jsonl。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createEventWorker } from './bin/event-worker.mjs';
import {
  PULL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  latencyPercentiles,
  pullFromWorker,
  readLatencyLog,
  runEventChannel,
} from './bin/event-pull.mjs';
import { tmpDir } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECRET = 'webhook-secret-test';
const TOKEN = 'pull-token-test';

function sign(body, secret) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function webhookRequest(body, { secret = SECRET, delivery, event = 'issues', signature } = {}) {
  return new Request('https://example.invalid/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': signature ?? sign(body, secret),
      'x-github-delivery': delivery,
      'x-github-event': event,
    },
    body,
  });
}

function pullRequest(token) {
  return new Request('https://example.invalid/pull', {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
}

function workerEnv() {
  return { WEBHOOK_SECRET: SECRET, PULL_TOKEN: TOKEN };
}

function ackRequest(ids, token = TOKEN) {
  return new Request('https://example.invalid/ack', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ids }),
  });
}

async function enqueueDelivery(worker, env, delivery) {
  const body = JSON.stringify({ created_at: '2026-10-31T00:00:00.000Z', action: 'opened' });
  const response = await worker.fetch(webhookRequest(body, { delivery }), env);
  assert.equal(response.status, 204);
  return body;
}

// 和 Durable Object storage 一样的最小接口。两个 Worker 实例拿同一份，模拟请求落到不同实例。
function sharedStorage() {
  const map = new Map();
  const storage = {
    async get(key) {
      if (!map.has(key)) return undefined;
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const out = new Map();
      for (const [key, value] of map) {
        if (String(key).startsWith(prefix)) out.set(key, structuredClone(value));
      }
      return out;
    },
    async transaction(fn) {
      return fn(storage);
    },
  };
  return storage;
}

async function pullIds(worker, env) {
  const response = await worker.fetch(pullRequest(TOKEN), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.events.map((event) => event.deliveryId);
}

// 单个值的字节上限。用来模拟 Durable Object 存储拒绝超限写入；上限本身比文档上的 128 KiB 更小。
function limitedStorage(maxBytes) {
  const map = new Map();
  const storage = {
    async get(key) {
      if (!map.has(key)) return undefined;
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes > maxBytes) throw new Error(`value for ${key} exceeds ${maxBytes} bytes (${bytes})`);
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const out = new Map();
      for (const [key, value] of map) {
        if (String(key).startsWith(prefix)) out.set(key, structuredClone(value));
      }
      return out;
    },
    async transaction(fn) {
      return fn(storage);
    },
  };
  return storage;
}

// 数 list 调用。入队路径不该按条数去列 q: / s:。
function countingStorage() {
  const map = new Map();
  const listCalls = [];
  const storage = {
    async get(key) {
      if (!map.has(key)) return undefined;
      return structuredClone(map.get(key));
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async list({ prefix = '' } = {}) {
      listCalls.push(prefix);
      const out = new Map();
      for (const [key, value] of map) {
        if (String(key).startsWith(prefix)) out.set(key, structuredClone(value));
      }
      return out;
    },
    async transaction(fn) {
      return fn(storage);
    },
  };
  return { storage, listCalls };
}

function prefixListCount(listCalls, prefixes) {
  return listCalls.filter((prefix) => prefixes.some((item) => prefix === item || String(prefix).startsWith(item))).length;
}

function alertMentions(alerts, deliveryId) {
  return alerts.some((line) => String(line).endsWith(`拒绝新事件 ${deliveryId}`));
}

const VALUE_LIMIT_BYTES = 32 * 1024;

function smallPayload(extra = {}) {
  return JSON.stringify({
    created_at: '2026-10-31T00:00:00.000Z',
    action: 'opened',
    repository: { full_name: 'example-org/example-repo' },
    issue: { number: 7 },
    ...extra,
  });
}

function largePayload(number) {
  return JSON.stringify({
    created_at: '2026-10-31T00:00:00.000Z',
    action: 'opened',
    repository: { full_name: 'example-org/example-repo' },
    issue: { number },
    padding: `PADDING-186-${'x'.repeat(48 * 1024)}`,
  });
}

async function postWebhook(worker, env, body, delivery, event = 'issues') {
  let response;
  try {
    response = await worker.fetch(webhookRequest(body, { delivery, event }), env);
  } catch (err) {
    assert.fail(`写入 ${delivery} 失败: ${err.message}`);
  }
  assert.equal(response.status, 204, delivery);
}

test('SC1 签名不对返回 401 且不入队；签名对上才入队；拉取令牌不对不把队列取走', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  const body = JSON.stringify({
    action: 'opened',
    issue: {
      number: 7,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-31T00:00:01.000Z',
    },
  });
  const signed = sign(body, SECRET);
  const tampered = body.replace('opened', 'closed');

  const bad = await worker.fetch(
    webhookRequest(tampered, { delivery: 'delivery-bad', signature: signed }),
    env,
  );
  assert.equal(bad.status, 401);

  const missing = await worker.fetch(
    new Request('https://example.invalid/webhook', {
      method: 'POST',
      headers: { 'x-github-delivery': 'delivery-missing', 'x-github-event': 'issues' },
      body,
    }),
    env,
  );
  assert.equal(missing.status, 401);

  const denied = await worker.fetch(pullRequest('wrong-pull-token'), env);
  assert.equal(denied.status, 401);

  const stillEmpty = await worker.fetch(pullRequest(TOKEN), env);
  assert.equal(stillEmpty.status, 200);
  assert.deepEqual((await stillEmpty.json()).events, []);

  const good = await worker.fetch(webhookRequest(body, { delivery: 'delivery-good', signature: signed }), env);
  assert.equal(good.status, 204);

  const blocked = await worker.fetch(pullRequest('wrong-pull-token'), env);
  assert.equal(blocked.status, 401);

  const pulled = await worker.fetch(pullRequest(TOKEN), env);
  assert.equal(pulled.status, 200);
  const events = (await pulled.json()).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].deliveryId, 'delivery-good');
  assert.equal(events[0].event, 'issues');
  assert.equal(events[0].created_at, '2026-10-31T00:00:01.000Z');

  const acked = await worker.fetch(ackRequest(['delivery-good']), env);
  assert.equal(acked.status, 204);
  const drained = await worker.fetch(pullRequest(TOKEN), env);
  assert.deepEqual((await drained.json()).events, []);
});

test('SC2 同一个 delivery id 只入队一次，拉取和轮询也只处理一次', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  const body = JSON.stringify({ created_at: '2026-10-31T00:00:00.000Z', action: 'opened' });
  const first = await worker.fetch(webhookRequest(body, { delivery: 'delivery-same' }), env);
  const second = await worker.fetch(webhookRequest(body, { delivery: 'delivery-same' }), env);
  assert.equal(first.status, 204);
  assert.equal(second.status, 204);
  const queued = (await (await worker.fetch(pullRequest(TOKEN), env)).json()).events;
  assert.equal(queued.length, 1);
  assert.equal(queued[0].deliveryId, 'delivery-same');
  const acked = await worker.fetch(ackRequest(['delivery-same']), env);
  assert.equal(acked.status, 204);
  assert.deepEqual((await (await worker.fetch(pullRequest(TOKEN), env)).json()).events, []);

  let t = 0;
  const handled = [];
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 1,
    pull: async () => [{ deliveryId: 'dup', created_at: '2026-10-31T00:00:00.000Z' }],
    poll: async () => [{ deliveryId: 'dup', created_at: '2026-10-31T00:00:00.000Z' }],
    onEvent: async (event) => {
      handled.push(event.deliveryId);
    },
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.deepEqual(handled, ['dup']);
});

test('SC3 假时钟下每 2 秒拉一次，兜底轮询每 60 秒一次', async () => {
  assert.equal(PULL_INTERVAL_MS, 2000);
  assert.equal(POLL_INTERVAL_MS, 60000);
  let t = 0;
  const pullCalls = [];
  const pollCalls = [];
  const started = Date.now();
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 120000,
    pull: async () => {
      pullCalls.push(t);
      return [];
    },
    poll: async () => {
      pollCalls.push(t);
      return [];
    },
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.ok(Date.now() - started < 2000, '假时钟不应真的等 120 秒');
  assert.equal(pullCalls.length, 60);
  assert.deepEqual(pullCalls.slice(0, 3), [0, 2000, 4000]);
  assert.equal(pullCalls.at(-1), 118000);
  assert.deepEqual(pollCalls, [0, 60000]);
});

test('SC3 Worker 挂掉时拉取循环不抛，退回 60 秒轮询，漏掉的事件由轮询补回', async () => {
  let t = 0;
  const pullCalls = [];
  const pollCalls = [];
  const handled = [];
  const started = Date.now();
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 66000,
    pull: async () => {
      pullCalls.push(t);
      if (t >= 4000 && t < 60000) throw new Error('worker down');
      if (t >= 60000) return [{ deliveryId: 'e1', created_at: '2026-10-31T00:00:00.000Z' }];
      return [];
    },
    poll: async () => {
      pollCalls.push(t);
      if (t === 60000) {
        return [
          { deliveryId: 'missed', created_at: '2026-10-31T00:00:00.000Z' },
          { deliveryId: 'e1', created_at: '2026-10-31T00:00:00.000Z' },
        ];
      }
      return [];
    },
    onEvent: async (event) => {
      handled.push(event.deliveryId);
    },
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.ok(Date.now() - started < 2000, '假时钟不应真的等');
  assert.deepEqual(
    pullCalls.filter((ts) => ts < 60000),
    [0, 2000, 4000],
  );
  assert.equal(pullCalls.includes(6000), false);
  assert.deepEqual(pollCalls, [0, 60000]);
  assert.ok(pullCalls.includes(60000));
  assert.ok(pullCalls.includes(62000));
  assert.deepEqual(handled, ['e1', 'missed']);
});

test('SC3 pullFromWorker 连不上或非 2xx 时抛错，通了才返回事件', async () => {
  await assert.rejects(
    pullFromWorker({
      url: 'https://example.invalid/pull',
      token: TOKEN,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    }),
    /ECONNREFUSED/,
  );
  await assert.rejects(
    pullFromWorker({
      url: 'https://example.invalid/pull',
      token: TOKEN,
      fetchImpl: async () => new Response('no', { status: 503 }),
    }),
    /503/,
  );
  const events = await pullFromWorker({
    url: 'https://example.invalid/pull',
    token: TOKEN,
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://example.invalid/pull');
      assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
      return new Response(JSON.stringify({ events: [{ deliveryId: 'from-worker', created_at: '2026-10-31T00:00:00.000Z' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].deliveryId, 'from-worker');
});

test('SC4 处理过的事件往 latency.jsonl 记一条，并能算出 p50 和 p95', async () => {
  const dir = tmpDir();
  const latencyFile = path.join(dir, '.prio', 'latency.jsonl');
  let t = Date.parse('2026-10-31T00:00:10.000Z');
  const origin = t;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: origin + 1,
    pull: async () => [
      { deliveryId: 'slow', created_at: '2026-10-31T00:00:00.000Z' },
      { deliveryId: 'fast', created_at: '2026-10-31T00:00:04.000Z' },
    ],
    poll: async () => [],
    latencyFile,
  });
  const rows = readLatencyLog(latencyFile);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].deliveryId, 'slow');
  assert.equal(rows[0].createdAt, '2026-10-31T00:00:00.000Z');
  assert.equal(rows[0].processedAt, '2026-10-31T00:00:10.000Z');
  assert.equal(rows[0].latencyMs, 10000);
  assert.equal(rows[0].source, 'worker');
  assert.equal(rows[1].deliveryId, 'fast');
  assert.equal(rows[1].latencyMs, 6000);
  assert.equal(fs.statSync(latencyFile).mode & 0o777, 0o600);

  const fromFile = latencyPercentiles(rows);
  assert.equal(fromFile.n, 2);
  assert.equal(fromFile.p50, 6000);
  assert.equal(fromFile.p95, 10000);

  const series = [];
  for (let i = 1; i <= 20; i += 1) series.push({ latencyMs: i * 1000 });
  const stats = latencyPercentiles(series);
  assert.equal(stats.n, 20);
  assert.equal(stats.p50, 10000);
  assert.equal(stats.p95, 19000);
  assert.deepEqual(latencyPercentiles([]), { p50: null, p95: null, n: 0 });
});

test('SC5 Worker 源码只读 WEBHOOK_SECRET 和 PULL_TOKEN，没有 GitHub 令牌', () => {
  const worker = fs.readFileSync(path.join(HERE, 'bin', 'event-worker.mjs'), 'utf8');
  const pull = fs.readFileSync(path.join(HERE, 'bin', 'event-pull.mjs'), 'utf8');
  for (const source of [worker, pull]) {
    assert.doesNotMatch(source, /gh[pousr]_[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(source, /github_pat_/);
    assert.doesNotMatch(source, /GITHUB_TOKEN/);
    assert.doesNotMatch(source, /GH_TOKEN/);
    assert.doesNotMatch(source, /\/Users\/[A-Za-z0-9._-]+/);
    assert.doesNotMatch(source, /PraiseZhu/);
  }
  assert.match(worker, /WEBHOOK_SECRET/);
  assert.match(worker, /PULL_TOKEN/);
  assert.doesNotMatch(worker, /node:fs/);
  assert.doesNotMatch(worker, /node:child_process/);
  assert.doesNotMatch(worker, /from 'child_process'/);
});

test('SC1 拉取响应丢失时不确认就不清队列，第二次 /pull 仍拿到同一批事件', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'keep');

  const first = await worker.fetch(pullRequest(TOKEN), env);
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).events.map((event) => event.deliveryId), ['keep']);

  const second = await worker.fetch(pullRequest(TOKEN), env);
  assert.equal(second.status, 200);
  assert.deepEqual((await second.json()).events.map((event) => event.deliveryId), ['keep']);

  const sneaky = await worker.fetch(ackRequest(['keep'], 'wrong-pull-token'), env);
  assert.equal(sneaky.status, 401);
  assert.deepEqual(await pullIds(worker, env), ['keep']);

  const acked = await worker.fetch(ackRequest(['keep']), env);
  assert.equal(acked.status, 204);
  assert.deepEqual(await pullIds(worker, env), []);
});

test('SC1 runEventChannel 第一次拉取响应丢失后，下一次拉取仍处理到同一事件并在确认后清队列', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'd-lost');

  let pullGets = 0;
  const fetchImpl = async (url, init = {}) => {
    const response = await worker.fetch(new Request(url, init), env);
    const pathname = new URL(url).pathname;
    if (pathname === '/pull' && (init.method || 'GET') === 'GET') {
      pullGets += 1;
      if (pullGets === 1) {
        const peeked = await response.clone().json();
        assert.deepEqual(peeked.events.map((event) => event.deliveryId), ['d-lost']);
        throw new Error('response lost');
      }
    }
    return response;
  };

  const handled = [];
  let t = 0;
  const started = Date.now();
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 61000,
    pull: () => pullFromWorker({
      url: 'https://example.invalid/pull',
      token: TOKEN,
      fetchImpl,
    }),
    confirm: async (ids) => {
      const { confirmPulledEvents } = await import('./bin/event-pull.mjs');
      assert.equal(typeof confirmPulledEvents, 'function');
      await confirmPulledEvents({
        url: 'https://example.invalid/pull',
        token: TOKEN,
        ids,
        fetchImpl,
      });
    },
    poll: async () => [],
    onEvent: async (event) => {
      handled.push(event.deliveryId);
    },
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.ok(Date.now() - started < 2000, '假时钟不应真的等');
  assert.deepEqual(handled, ['d-lost']);
  assert.ok(pullGets >= 2);
  assert.deepEqual(await pullIds(worker, env), []);
});

test('SC2 onEvent 抛错不当成 Worker 挂了，同批其余事件照常处理且下一拍仍按 2 秒拉取', async () => {
  let t = 0;
  const pullCalls = [];
  const confirmed = [];
  const handled = [];
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  const started = Date.now();
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 6000,
    pull: async () => {
      pullCalls.push(t);
      if (t !== 0) return [];
      return [
        { deliveryId: 'ok-1', created_at: '2026-10-31T00:00:00.000Z' },
        { deliveryId: 'bad', created_at: '2026-10-31T00:00:01.000Z' },
        { deliveryId: 'ok-2', created_at: '2026-10-31T00:00:02.000Z' },
      ];
    },
    confirm: async (ids) => {
      confirmed.push(...ids);
    },
    poll: async () => [],
    onEvent: async (event) => {
      handled.push(event.deliveryId);
      if (event.deliveryId === 'bad') throw new Error('handler failed');
    },
    latencyFile,
  });
  assert.ok(Date.now() - started < 2000, '假时钟不应真的等');
  assert.deepEqual(pullCalls, [0, 2000, 4000]);
  assert.deepEqual(handled, ['ok-1', 'bad', 'ok-2']);
  assert.deepEqual(confirmed, ['ok-1', 'ok-2']);
  const rows = readLatencyLog(latencyFile);
  assert.deepEqual(rows.map((row) => row.deliveryId), ['ok-1', 'ok-2']);
  assert.ok(rows.every((row) => row.source === 'worker'));
});

test('SC3 两个 Worker 实例共享存储时，webhook 和 /pull 落在不同实例仍能拉到事件', async () => {
  const storage = sharedStorage();
  const env = workerEnv();
  const webhookWorker = createEventWorker({ storage });
  const pullWorker = createEventWorker({ storage });
  await enqueueDelivery(webhookWorker, env, 'shared-1');
  assert.deepEqual(await pullIds(pullWorker, env), ['shared-1']);
  await enqueueDelivery(pullWorker, env, 'shared-1');
  assert.deepEqual(await pullIds(pullWorker, env), ['shared-1']);
});

test('SC3 EventChannelDurableObject 两个实例共享同一存储时，一边收 webhook 另一边 /pull 仍能拉到', async () => {
  const { EventChannelDurableObject } = await import('./bin/event-worker.mjs');
  assert.equal(typeof EventChannelDurableObject, 'function');
  const storage = sharedStorage();
  const env = workerEnv();
  const receiver = new EventChannelDurableObject({ storage });
  const reader = new EventChannelDurableObject({ storage });
  await enqueueDelivery(receiver, env, 'from-other-instance');
  assert.deepEqual(await pullIds(reader, env), ['from-other-instance']);
});

test('SC3 去重表超过上限后最旧的条目被清掉', async () => {
  const worker = createEventWorker({ now: () => 5_000, seenLimit: 2, seenTtlMs: 60_000 });
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'd1');
  await enqueueDelivery(worker, env, 'd2');
  await enqueueDelivery(worker, env, 'd3');
  await enqueueDelivery(worker, env, 'd1');
  await enqueueDelivery(worker, env, 'd3');
  assert.deepEqual(await pullIds(worker, env), ['d1', 'd2', 'd3', 'd1']);
});

test('SC3 去重表过期后条目被清掉', async () => {
  let now = 10_000;
  const worker = createEventWorker({
    now: () => now,
    seenTtlMs: 1000,
    seenLimit: 10,
  });
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'd-old');
  now = 11_001;
  await enqueueDelivery(worker, env, 'd-fresh');
  await enqueueDelivery(worker, env, 'd-old');
  await enqueueDelivery(worker, env, 'd-fresh');
  assert.deepEqual(await pullIds(worker, env), ['d-old', 'd-fresh', 'd-old']);
});

test('SC4 空令牌配置时 /pull 返回 401 且不清队列', async () => {
  const worker = createEventWorker();
  const seedEnv = workerEnv();
  await enqueueDelivery(worker, seedEnv, 'stay-empty-token');
  const denied = await worker.fetch(pullRequest(TOKEN), { WEBHOOK_SECRET: SECRET, PULL_TOKEN: '' });
  assert.equal(denied.status, 401);
  assert.deepEqual(await pullIds(worker, seedEnv), ['stay-empty-token']);
});

test('SC4 缺 authorization 头时 /pull 返回 401 且不清队列', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'stay-missing-header');
  const denied = await worker.fetch(new Request('https://example.invalid/pull', { method: 'GET' }), env);
  assert.equal(denied.status, 401);
  assert.deepEqual(await pullIds(worker, env), ['stay-missing-header']);
});

test('SC4 authorization 前缀不是 Bearer 时 /pull 返回 401 且不清队列', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'stay-prefix');
  const denied = await worker.fetch(
    new Request('https://example.invalid/pull', {
      method: 'GET',
      headers: { authorization: `Token ${TOKEN}` },
    }),
    env,
  );
  assert.equal(denied.status, 401);
  assert.deepEqual(await pullIds(worker, env), ['stay-prefix']);
});

test('SC4 令牌长度不同时 /pull 返回 401 且不清队列', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'stay-length');
  const denied = await worker.fetch(pullRequest(TOKEN.slice(0, -1)), env);
  assert.equal(denied.status, 401);
  assert.deepEqual(await pullIds(worker, env), ['stay-length']);
});

test('SC4 authorization 多值头时 /pull 返回 401 且不清队列', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'stay-multi');
  const headers = new Headers();
  headers.append('authorization', `Bearer ${TOKEN}`);
  headers.append('authorization', 'Bearer other-token');
  const denied = await worker.fetch(new Request('https://example.invalid/pull', { method: 'GET', headers }), env);
  assert.equal(denied.status, 401);
  assert.deepEqual(await pullIds(worker, env), ['stay-multi']);
});

test('#186 SC1 单值上限下 4096 条去重和大 payload 仍能全部拉取，去重仍生效', async () => {
  assert.ok(VALUE_LIMIT_BYTES < 128 * 1024);
  const storage = limitedStorage(VALUE_LIMIT_BYTES);
  const worker = createEventWorker({ storage, now: () => 1_700_000_000_000 });
  const env = workerEnv();
  const pending = [];
  for (let i = 0; i < 4096; i += 1) {
    const delivery = `seen-${i}`;
    await postWebhook(worker, env, smallPayload(), delivery);
    pending.push(delivery);
    if (pending.length === 200) {
      const acked = await worker.fetch(ackRequest(pending), env);
      assert.equal(acked.status, 204);
      pending.length = 0;
    }
  }
  if (pending.length) {
    const acked = await worker.fetch(ackRequest(pending), env);
    assert.equal(acked.status, 204);
    pending.length = 0;
  }

  await postWebhook(worker, env, smallPayload({ marker: 'small-payload' }), 'small-keep');
  await postWebhook(worker, env, largePayload(186), 'large-1');
  await postWebhook(worker, env, largePayload(187), 'large-2');
  await postWebhook(worker, env, largePayload(188), 'large-3');

  await postWebhook(worker, env, smallPayload(), 'seen-100');
  await postWebhook(worker, env, largePayload(186), 'large-1');
  await postWebhook(worker, env, smallPayload({ marker: 'small-payload' }), 'small-keep');

  const pulled = await worker.fetch(pullRequest(TOKEN), env);
  assert.equal(pulled.status, 200);
  const body = await pulled.json();
  assert.deepEqual(body.events.map((event) => event.deliveryId), ['small-keep', 'large-1', 'large-2', 'large-3']);

  const small = body.events[0];
  assert.equal(small.payload.marker, 'small-payload');
  assert.equal(small.payloadOmitted, undefined);

  for (const event of body.events.slice(1)) {
    assert.equal(event.event, 'issues');
    assert.equal(event.repo, 'example-org/example-repo');
    assert.equal(event.payloadOmitted, true);
    assert.equal(event.payload, undefined);
    assert.equal(JSON.stringify(event).includes('PADDING-186'), false);
  }
  assert.equal(body.events[1].number, 186);
  assert.equal(body.events[2].number, 187);
  assert.equal(body.events[3].number, 188);

  const keys = [...(await storage.list({ prefix: '' })).keys()];
  assert.equal(keys.includes('queue'), false);
  assert.equal(keys.includes('seen'), false);
  assert.equal(keys.filter((key) => key.startsWith('s:')).length, 4096);
  assert.equal(keys.filter((key) => key.startsWith('q:')).length, 4);
  for (const [, value] of await storage.list({ prefix: 'q:' })) {
    assert.equal(JSON.stringify(value).includes('PADDING-186'), false);
  }

  const hydrated = [];
  let fetches = 0;
  let t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 1,
    pull: async () => body.events,
    poll: async () => [],
    loadPayload: async (event) => {
      fetches += 1;
      assert.equal(event.payloadOmitted, true);
      return { marker: 'fetched-from-github', repo: event.repo, number: event.number };
    },
    onEvent: async (event) => {
      hydrated.push(event);
    },
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.equal(fetches, 3);
  assert.deepEqual(hydrated.map((event) => event.deliveryId), ['small-keep', 'large-1', 'large-2', 'large-3']);
  assert.equal(hydrated[0].payload.marker, 'small-payload');
  assert.ok(hydrated.slice(1).every((event) => event.payload.marker === 'fetched-from-github'));
});

test('#186 SC2 同一事件连续失败 5 次后被确认移出，留下放弃记录，同批其他事件照常处理', async () => {
  const worker = createEventWorker({ now: () => 1_700_000_000_000 });
  const env = workerEnv();
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  await postWebhook(worker, env, smallPayload(), 'ok-1');
  await postWebhook(worker, env, smallPayload(), 'bad-186', 'pull_request');
  await postWebhook(worker, env, smallPayload(), 'ok-2');

  const fetchImpl = (url, init = {}) => worker.fetch(new Request(url, init), env);
  async function reportFailure(event, error) {
    const { reportEventFailure } = await import('./bin/event-pull.mjs');
    return reportEventFailure({
      url: 'https://example.invalid/pull',
      token: TOKEN,
      id: event.deliveryId,
      error: error?.message || String(error),
      fetchImpl,
    });
  }

  const handled = [];
  const confirmed = [];
  const pulled = [];
  let t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 4000,
    pull: async () => {
      const events = await pullFromWorker({
        url: 'https://example.invalid/pull',
        token: TOKEN,
        fetchImpl,
      });
      pulled.push(events.map((event) => event.deliveryId));
      return events;
    },
    confirm: async (ids) => {
      confirmed.push(ids);
      const { confirmPulledEvents } = await import('./bin/event-pull.mjs');
      await confirmPulledEvents({
        url: 'https://example.invalid/pull',
        token: TOKEN,
        ids,
        fetchImpl,
      });
    },
    reportFailure,
    poll: async () => [],
    onEvent: async (event) => {
      handled.push(event.deliveryId);
      if (event.deliveryId === 'bad-186') throw new Error('handler failed: boom-186');
    },
    latencyFile,
  });

  assert.deepEqual(pulled, [
    ['ok-1', 'bad-186', 'ok-2'],
    ['bad-186'],
  ]);
  assert.deepEqual(handled, ['ok-1', 'bad-186', 'ok-2', 'bad-186']);
  assert.deepEqual(confirmed, [['ok-1', 'ok-2']]);
  assert.equal(fs.readFileSync(latencyFile, 'utf8').includes('放弃'), false);
  assert.deepEqual(await pullIds(worker, env), ['bad-186']);

  const handledAgain = [];
  const confirmedAgain = [];
  const pulledAgain = [];
  let pulls = 0;
  t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 8000,
    pull: async () => {
      pulls += 1;
      if (pulls === 3) await postWebhook(worker, env, smallPayload(), 'ok-3');
      const events = await pullFromWorker({
        url: 'https://example.invalid/pull',
        token: TOKEN,
        fetchImpl,
      });
      pulledAgain.push(events.map((event) => event.deliveryId));
      return events;
    },
    confirm: async (ids) => {
      confirmedAgain.push(ids);
      const { confirmPulledEvents } = await import('./bin/event-pull.mjs');
      await confirmPulledEvents({
        url: 'https://example.invalid/pull',
        token: TOKEN,
        ids,
        fetchImpl,
      });
    },
    reportFailure,
    poll: async () => [],
    onEvent: async (event) => {
      handledAgain.push(event.deliveryId);
      if (event.deliveryId === 'bad-186') throw new Error('handler failed: boom-186');
    },
    latencyFile,
  });

  assert.deepEqual(pulledAgain, [
    ['bad-186'],
    ['bad-186'],
    ['bad-186', 'ok-3'],
    [],
  ]);
  assert.deepEqual(handledAgain, ['bad-186', 'bad-186', 'bad-186', 'ok-3']);
  assert.deepEqual(confirmedAgain, [['bad-186', 'ok-3']]);
  assert.deepEqual(await pullIds(worker, env), []);

  const text = fs.readFileSync(latencyFile, 'utf8');
  assert.match(text, /放弃/);
  const abandoned = readLatencyLog(latencyFile).filter((row) => row.outcome === '放弃');
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].deliveryId, 'bad-186');
  assert.equal(abandoned[0].event, 'pull_request');
  assert.equal(abandoned[0].failures, 5);
  assert.match(abandoned[0].error, /boom-186/);
});

test('#186 SC3 队列超过 1000 时拒绝新事件，队列不超上限，写入不失败', async () => {
  const worker = createEventWorker({ now: () => 1_700_000_000_000 });
  const env = workerEnv();
  const body = smallPayload();
  for (let i = 0; i < 1000; i += 1) {
    await postWebhook(worker, env, body, `q-${i}`);
  }
  await postWebhook(worker, env, body, 'q-overflow');

  const response = await worker.fetch(pullRequest(TOKEN), env);
  assert.equal(response.status, 200);
  const pulled = await response.json();
  assert.equal(pulled.events.length, 1000);
  assert.equal(pulled.events[0].deliveryId, 'q-0');
  assert.equal(pulled.events[999].deliveryId, 'q-999');
  assert.equal(pulled.events.some((event) => event.deliveryId === 'q-overflow'), false);
  assert.ok(Array.isArray(pulled.alerts));
  const line = pulled.alerts.join('\n');
  assert.match(line, /告警/);
  assert.match(line, /1000/);
  assert.match(line, /q-overflow/);
});

test('#189 SC1 告警只保留最近 50 条，/pull 和存储里的 a: 键都不超过上限，最新的还在', async () => {
  const ALERT_CAP = 50;
  const storage = sharedStorage();
  const worker = createEventWorker({ storage, queueLimit: 1, now: () => 1_700_000_000_000 });
  const env = workerEnv();
  await postWebhook(worker, env, smallPayload(), 'held-189');
  const overflow = ALERT_CAP + 10;
  for (let i = 1; i <= overflow; i += 1) {
    await postWebhook(worker, env, smallPayload(), `z-${i}`);
  }

  const response = await worker.fetch(pullRequest(TOKEN), env);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.events.map((event) => event.deliveryId), ['held-189']);
  assert.ok(body.alerts.length <= ALERT_CAP, `alerts ${body.alerts.length} 超过上限 ${ALERT_CAP}`);
  assert.equal(body.alerts.length, ALERT_CAP);
  assert.equal(alertMentions(body.alerts, `z-${overflow}`), true);
  assert.equal(alertMentions(body.alerts, 'z-2'), false);
  assert.equal(alertMentions(body.alerts, 'z-11'), true);

  const stored = await storage.list({ prefix: 'a:' });
  assert.ok(stored.size <= ALERT_CAP, `a: 键 ${stored.size} 超过上限 ${ALERT_CAP}`);
  assert.equal(stored.size, ALERT_CAP);
  const lines = [...stored.values()].map((value) => (typeof value === 'string' ? value : value?.line));
  assert.equal(alertMentions(lines, `z-${overflow}`), true);
  assert.equal(alertMentions(lines, 'z-2'), false);
  assert.equal(alertMentions(lines, 'z-11'), true);
});

test('#189 SC2 入队和去重不按条数 list q: 与 s:，去重仍生效，满 1000 仍拒绝并记告警', async () => {
  const ENQUEUE_PREFIX_LIST_CAP = 0;
  const { storage, listCalls } = countingStorage();
  const worker = createEventWorker({ storage, now: () => 1_700_000_000_000 });
  const env = workerEnv();
  const body = smallPayload();
  const qAndS = () => prefixListCount(listCalls, ['q:', 's:']);

  for (let i = 0; i < 100; i += 1) {
    await postWebhook(worker, env, body, `n-${i}`);
  }
  await postWebhook(worker, env, body, 'n-0');
  assert.ok(
    qAndS() <= ENQUEUE_PREFIX_LIST_CAP,
    `入队 100 条后 q:/s: list 调用 ${qAndS()}，上限 ${ENQUEUE_PREFIX_LIST_CAP}`,
  );

  const afterHundred = await worker.fetch(pullRequest(TOKEN), env);
  const hundred = await afterHundred.json();
  assert.equal(hundred.events.length, 100);
  assert.equal(hundred.events.filter((event) => event.deliveryId === 'n-0').length, 1);

  const listsBeforeFill = qAndS();
  for (let i = 100; i < 1000; i += 1) {
    await postWebhook(worker, env, body, `n-${i}`);
  }
  await postWebhook(worker, env, body, 'n-full');
  const added = qAndS() - listsBeforeFill;
  assert.ok(
    added <= ENQUEUE_PREFIX_LIST_CAP,
    `再入队到 1000 后 q:/s: list 新增 ${added}，上限 ${ENQUEUE_PREFIX_LIST_CAP}`,
  );

  const response = await worker.fetch(pullRequest(TOKEN), env);
  const pulled = await response.json();
  assert.equal(pulled.events.length, 1000);
  assert.equal(pulled.events[0].deliveryId, 'n-0');
  assert.equal(pulled.events[999].deliveryId, 'n-999');
  assert.equal(pulled.events.some((event) => event.deliveryId === 'n-full'), false);
  const line = pulled.alerts.join('\n');
  assert.match(line, /告警/);
  assert.match(line, /1000/);
  assert.match(line, /n-full/);
});

test('#189 SC3 被省略的事件没有 loadPayload 时按失败放弃并写明正文被省略，有则取回后确认，抛错也算失败', async () => {
  const env = workerEnv();

  async function omittedWorker(delivery) {
    const worker = createEventWorker({ now: () => 1_700_000_000_000, maxValueBytes: 1 });
    await postWebhook(worker, env, smallPayload(), delivery, 'issues');
    const fetched = await worker.fetch(pullRequest(TOKEN), env);
    const queued = await fetched.json();
    assert.equal(queued.events[0].payloadOmitted, true);
    assert.equal(queued.events[0].deliveryId, delivery);
    return worker;
  }

  function bind(worker) {
    const fetchImpl = (url, init = {}) => worker.fetch(new Request(url, init), env);
    return {
      pull: () => pullFromWorker({ url: 'https://example.invalid/pull', token: TOKEN, fetchImpl }),
      confirm: async (ids) => {
        const { confirmPulledEvents } = await import('./bin/event-pull.mjs');
        await confirmPulledEvents({
          url: 'https://example.invalid/pull',
          token: TOKEN,
          ids,
          fetchImpl,
        });
      },
      reportFailure: async (event, error) => {
        const { reportEventFailure } = await import('./bin/event-pull.mjs');
        return reportEventFailure({
          url: 'https://example.invalid/pull',
          token: TOKEN,
          id: event.deliveryId,
          error: error?.message || String(error),
          fetchImpl,
        });
      },
    };
  }

  const bare = await omittedWorker('omit-bare');
  const bareApi = bind(bare);
  const handledBare = [];
  const reportsBare = [];
  const bareLog = path.join(tmpDir(), '.prio', 'latency.jsonl');
  let t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 10000,
    pull: bareApi.pull,
    confirm: bareApi.confirm,
    reportFailure: async (event, error) => {
      const result = await bareApi.reportFailure(event, error);
      reportsBare.push(result);
      return result;
    },
    poll: async () => [],
    onEvent: async (event) => {
      handledBare.push(event);
    },
    latencyFile: bareLog,
  });
  assert.deepEqual(handledBare, []);
  assert.equal(reportsBare.length, 5);
  assert.equal(reportsBare[4].failures, 5);
  assert.equal(reportsBare[4].abandoned, true);
  assert.deepEqual(await pullIds(bare, env), []);
  const abandonedBare = readLatencyLog(bareLog).filter((row) => row.outcome === '放弃');
  assert.equal(abandonedBare.length, 1);
  assert.equal(abandonedBare[0].deliveryId, 'omit-bare');
  assert.equal(abandonedBare[0].failures, 5);
  assert.match(JSON.stringify(abandonedBare[0]), /正文被省略/);

  const loaded = await omittedWorker('omit-load');
  const loadApi = bind(loaded);
  const handledLoad = [];
  const confirmedLoad = [];
  let fetches = 0;
  t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 1,
    pull: loadApi.pull,
    confirm: async (ids) => {
      confirmedLoad.push(...ids);
      await loadApi.confirm(ids);
    },
    reportFailure: loadApi.reportFailure,
    loadPayload: async (event) => {
      fetches += 1;
      assert.equal(event.payloadOmitted, true);
      assert.equal(event.deliveryId, 'omit-load');
      return { marker: 'body-189' };
    },
    poll: async () => [],
    onEvent: async (event) => {
      handledLoad.push(event);
    },
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.equal(fetches, 1);
  assert.equal(handledLoad.length, 1);
  assert.equal(handledLoad[0].payload.marker, 'body-189');
  assert.deepEqual(confirmedLoad, ['omit-load']);
  assert.deepEqual(await pullIds(loaded, env), []);

  const thrown = await omittedWorker('omit-throw');
  const throwApi = bind(thrown);
  const handledThrow = [];
  const confirmedThrow = [];
  const reportsThrow = [];
  t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 1,
    pull: throwApi.pull,
    confirm: async (ids) => {
      confirmedThrow.push(...ids);
      await throwApi.confirm(ids);
    },
    reportFailure: async (event, error) => {
      const result = await throwApi.reportFailure(event, error);
      reportsThrow.push(result);
      return result;
    },
    loadPayload: async () => {
      throw new Error('fetch-failed-189');
    },
    poll: async () => [],
    onEvent: async (event) => {
      handledThrow.push(event.deliveryId);
    },
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.deepEqual(handledThrow, []);
  assert.deepEqual(confirmedThrow, []);
  assert.equal(reportsThrow.length, 1);
  assert.equal(reportsThrow[0].failures, 1);
  assert.equal(reportsThrow[0].abandoned, false);
  assert.match(reportsThrow[0].error, /fetch-failed-189/);
  assert.deepEqual(await pullIds(thrown, env), ['omit-throw']);
});

test('#189 SC4 同一份存储重建 Worker 后失败次数接着数，第 5 次仍放弃', async () => {
  const storage = sharedStorage();
  let worker = createEventWorker({ storage, now: () => 1_700_000_000_000 });
  const env = workerEnv();
  await postWebhook(worker, env, smallPayload(), 'retry-189', 'pull_request');
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  const fetchImpl = (url, init = {}) => worker.fetch(new Request(url, init), env);

  async function reportFailure(event, error) {
    const { reportEventFailure } = await import('./bin/event-pull.mjs');
    return reportEventFailure({
      url: 'https://example.invalid/pull',
      token: TOKEN,
      id: event.deliveryId,
      error: error?.message || String(error),
      fetchImpl,
    });
  }
  async function confirm(ids) {
    const { confirmPulledEvents } = await import('./bin/event-pull.mjs');
    await confirmPulledEvents({
      url: 'https://example.invalid/pull',
      token: TOKEN,
      ids,
      fetchImpl,
    });
  }
  const pull = () => pullFromWorker({ url: 'https://example.invalid/pull', token: TOKEN, fetchImpl });

  const pulled = [];
  let t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 4000,
    pull: async () => {
      const events = await pull();
      pulled.push(events.map((event) => event.deliveryId));
      return events;
    },
    confirm,
    reportFailure,
    poll: async () => [],
    onEvent: async () => {
      throw new Error('boom-189');
    },
    latencyFile,
  });
  assert.deepEqual(pulled, [['retry-189'], ['retry-189']]);
  assert.deepEqual(await pullIds(worker, env), ['retry-189']);
  assert.equal(readLatencyLog(latencyFile).some((row) => row.outcome === '放弃'), false);

  worker = createEventWorker({ storage, now: () => 1_700_000_000_000 });
  assert.deepEqual(await pullIds(worker, env), ['retry-189']);

  const pulledAgain = [];
  t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 8000,
    pull: async () => {
      const events = await pull();
      pulledAgain.push(events.map((event) => event.deliveryId));
      return events;
    },
    confirm,
    reportFailure,
    poll: async () => [],
    onEvent: async () => {
      throw new Error('boom-189');
    },
    latencyFile,
  });
  assert.deepEqual(pulledAgain, [['retry-189'], ['retry-189'], ['retry-189'], []]);
  assert.deepEqual(await pullIds(worker, env), []);
  const abandoned = readLatencyLog(latencyFile).filter((row) => row.outcome === '放弃');
  assert.equal(abandoned.length, 1);
  assert.equal(abandoned[0].deliveryId, 'retry-189');
  assert.equal(abandoned[0].failures, 5);
  assert.match(abandoned[0].error, /boom-189/);
});
