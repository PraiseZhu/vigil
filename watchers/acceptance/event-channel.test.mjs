// W4 事件通道：Worker 校验 webhook 签名并入队，本机拉取循环每 2 秒拉一次；
// 60 秒轮询只在 Worker 连续失败到门槛（缺省 3 次）之后才兜底。
// 延迟写到 .prio/latency.jsonl。W4-c 的常驻拉取器（bin/event-run.mjs）也在这份测试里。
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
import {
  DEFAULT_POLL_AFTER_FAILURES,
  LOCK_RETRY_MS,
  LOCK_WAIT_MAX_MS,
  SINGLE_ITEM_MODULE,
  WriteLockBusyError,
  acquireWriteLock,
  appendEventRunLog,
  createEventPipeline,
  createEventRunState,
  eventRunPaths,
  eventTargets,
  loadSingleItemModule,
  main as eventRunMain,
  parseEventRunArgs,
  readEventRunConfig,
  runEventRun,
  writeLockHeld,
} from './bin/event-run.mjs';
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

test('SC3 假时钟下每 2 秒拉一次；Worker 正常时兜底轮询一次都不跑', async () => {
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
  // Worker 一直健康：60 秒兜底轮询一次都不跑（W4-c：以前是无条件每 60 秒跑）。
  assert.deepEqual(pollCalls, []);
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
    // 门槛降到 1 次，用最少的假时钟拍数验证「挂了才会跑兜底轮询」。
    pollAfterFailures: 1,
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
  // 第 1 次失败在 t=4000，所以 t=60000 那一拍才允许跑兜底轮询（t=0 那一拍没有失败，不跑）。
  assert.deepEqual(pollCalls, [60000]);
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

// ── W4-c：常驻拉取器 bin/event-run.mjs ────────────────────────────────────────
// 夹具里的仓库名、用户、路径全是占位符（example/owner-a 这类），不含真实数据。

function eventRunFixture({ tokenMode = 0o600, urlMode = 0o600, token = TOKEN, url = 'https://example.invalid/pull' } = {}) {
  const home = tmpDir();
  const secrets = path.join(home, 'acceptance', 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  const pullTokenFile = path.join(secrets, 'event-pull-token');
  const workerUrlFile = path.join(secrets, 'event-worker-url');
  fs.writeFileSync(pullTokenFile, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(pullTokenFile, tokenMode);
  fs.writeFileSync(workerUrlFile, `${url}\n`, { mode: 0o600 });
  fs.chmodSync(workerUrlFile, urlMode);
  const env = {
    ACCEPTANCE_WATCHER_HOME: path.join(home, 'acceptance', 'home'),
    EVENT_RUN_STATE_DIR: path.join(home, 'acceptance', 'tools', '.prio'),
  };
  const paths = eventRunPaths({ env, homeDir: home });
  fs.mkdirSync(paths.stateDir, { recursive: true });
  // 授权清单默认给两个占位仓；要试白名单的用例自己覆盖这份文件。
  fs.writeFileSync(paths.authorizedReposFile, JSON.stringify({ repos: ['example/owner-a', 'example/owner-b'] }));
  return { home, secrets, env, paths, pullTokenFile, workerUrlFile };
}

function configOf(fixture) {
  return { workerUrl: 'https://example.invalid/pull', pullToken: TOKEN, paths: fixture.paths };
}

/** 假 Worker：/pull 按批次吐事件，/ack 和 /fail 只记账。 */
function fakePullWorker({ batches = [] } = {}) {
  const calls = { pull: 0, ack: [], fail: [] };
  const queue = [...batches];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    if (pathname === '/pull') {
      calls.pull += 1;
      const events = queue.length ? queue.shift() : [];
      return new Response(JSON.stringify({ events }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (pathname === '/ack') {
      calls.ack.push(JSON.parse(init.body || '{}').ids);
      return new Response('', { status: 204 });
    }
    if (pathname === '/fail') {
      calls.fail.push(JSON.parse(init.body || '{}'));
      return new Response(JSON.stringify({ failures: 1, abandoned: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('no', { status: 404 });
  };
  return { fetchImpl, calls };
}

function issueEvent(deliveryId, { repo = 'example/owner-a', issue = 7, createdAt = '2026-11-01T00:00:00.000Z' } = {}) {
  return {
    deliveryId,
    event: 'issues',
    created_at: createdAt,
    payload: { action: 'opened', repository: { full_name: repo }, issue: { number: issue } },
  };
}

function prEvent(deliveryId, {
  repo = 'example/owner-a',
  number = 3,
  body = '任务 issue：example/owner-a#7',
  branch = 'feature/x',
  createdAt = '2026-11-01T00:00:00.000Z',
} = {}) {
  return {
    deliveryId,
    event: 'pull_request',
    created_at: createdAt,
    payload: {
      action: 'opened',
      repository: { full_name: repo },
      pull_request: { number, body, state: 'open', merged: false, head: { ref: branch } },
    },
  };
}

/** 跑一拍（假时钟：until=1，第一拍处理完就退）。返回日志行。 */
async function runOneTick({ config, ...deps }) {
  const logs = [];
  let t = 0;
  await runEventRun({
    config,
    until: 1,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    logger: (line) => logs.push(line),
    ...deps,
  });
  return logs;
}

test('W4c SC1 拉取令牌文件权限不是 600 就拒绝启动：日志写人话，且不回显令牌内容', async () => {
  const fixture = eventRunFixture({ tokenMode: 0o644 });
  const stderr = { text: '', write(chunk) { this.text += chunk; } };
  const result = await eventRunMain(['--once'], {
    env: fixture.env,
    homeDir: fixture.home,
    paths: fixture.paths,
    stderr,
    capture: true,
    now: () => 0,
  });
  assert.equal(result.exitCode, 1);
  assert.match(String(result.error?.message || ''), /权限必须是 600/);
  const logged = fs.readFileSync(fixture.paths.logFile, 'utf8');
  assert.match(logged, /启动失败/);
  assert.match(logged, /600/);
  assert.doesNotMatch(logged, new RegExp(TOKEN), '令牌内容不许进日志');
  assert.doesNotMatch(stderr.text, new RegExp(TOKEN), '令牌内容不许打到 stderr');
  assert.doesNotMatch(stderr.text, /event-pull-token[\s\S]*pull-token-test/);
});

test('W4c SC1 Worker 地址文件权限不是 600 也拒绝；两个文件都 600 时读得出配置，缺省路径在 ~/acceptance/secrets 下', () => {
  const fixture = eventRunFixture({ urlMode: 0o640 });
  assert.throws(
    () => readEventRunConfig({ env: fixture.env, homeDir: fixture.home, paths: fixture.paths }),
    /Worker 地址[\s\S]*600/,
  );
  fs.chmodSync(fixture.workerUrlFile, 0o600);
  const config = readEventRunConfig({ env: fixture.env, homeDir: fixture.home, paths: fixture.paths });
  assert.equal(config.workerUrl, 'https://example.invalid/pull');
  assert.equal(config.pullToken, TOKEN);
  assert.equal(config.paths.secretsDir, path.join(fixture.home, 'acceptance', 'secrets'));
  assert.equal(config.paths.logFile, path.join(fixture.home, 'acceptance', 'home', 'state', 'host', 'event-run.log'));
  assert.equal(config.paths.latencyFile, path.join(fixture.paths.stateDir, 'latency.jsonl'));
  assert.equal(config.paths.disabledFile, path.join(fixture.paths.stateDir, 'event-run.disabled'));
  assert.equal(config.paths.markerFile, path.join(fixture.paths.stateDir, 'mac-mini-stopped'));
  // 认不出来的地址直接拒绝，不当成可用配置。
  fs.writeFileSync(fixture.workerUrlFile, 'not-a-url\n', { mode: 0o600 });
  fs.chmodSync(fixture.workerUrlFile, 0o600);
  assert.throws(
    () => readEventRunConfig({ env: fixture.env, homeDir: fixture.home, paths: fixture.paths }),
    /不是合法 URL/,
  );
});

test('W4c SC2 事件到 issue 的映射：issues / issue_comment 直接定位，PR 事件按任务 issue 行与分支反查', () => {
  const refs = (event) => eventTargets(event).map((target) => target.ref);
  assert.deepEqual(refs(issueEvent('d1', { issue: 7 })), ['example/owner-a#7']);
  assert.deepEqual(
    refs({
      deliveryId: 'd2',
      event: 'issue_comment',
      payload: { repository: { full_name: 'example/owner-a' }, issue: { number: 8 }, comment: { body: '跟进一下' } },
    }),
    ['example/owner-a#8'],
  );
  // 评论挂在 PR 上：payload.issue.number 是 PR 号，要按正文的任务 issue 行反查，不能把 PR 号当 issue 号写。
  assert.deepEqual(
    refs({
      deliveryId: 'd3',
      event: 'issue_comment',
      payload: {
        repository: { full_name: 'example/owner-a' },
        issue: { number: 55, pull_request: { url: 'https://example.invalid/pull/55' }, body: '任务 issue：example/owner-a#9' },
      },
    }),
    ['example/owner-a#9'],
  );
  // PR 事件：正文的任务 issue 行 + 分支 acceptance/<号>-<号>-sc<k>，按 repo、号排序，同一条只算一次。
  assert.deepEqual(
    refs(prEvent('d4', { number: 3, body: '任务 issue：example/owner-a#7', branch: 'acceptance/12-13-sc1' })),
    ['example/owner-a#7', 'example/owner-a#12', 'example/owner-a#13'],
  );
  assert.deepEqual(
    refs(prEvent('d5', { number: 4, body: '', branch: 'acceptance/12-13-sc1' })),
    ['example/owner-a#12', 'example/owner-a#13'],
  );
  // 定位不到、类型不在订阅里、没有仓库，都返回空数组（调用方只确认不写）。
  assert.deepEqual(refs(prEvent('d6', { number: 5, body: '', branch: 'feature/x' })), []);
  assert.deepEqual(
    refs({ deliveryId: 'd7', event: 'workflow_run', payload: { repository: { full_name: 'example/owner-a' } } }),
    [],
  );
  assert.deepEqual(refs({ deliveryId: 'd8', event: 'issues', payload: { issue: { number: 1 } } }), []);
});

test('W4c SC2 事件白名单：非授权仓、非四类事件都不进写路径，只确认', async () => {
  const fixture = eventRunFixture();
  fs.writeFileSync(fixture.paths.authorizedReposFile, JSON.stringify({ repos: ['example/owner-a'] }));
  const written = [];
  const worker = fakePullWorker({
    batches: [[
      issueEvent('allow', { repo: 'example/owner-a', issue: 7 }),
      issueEvent('other-repo', { repo: 'example/owner-b', issue: 7 }),
      {
        deliveryId: 'wrong-type',
        event: 'workflow_run',
        created_at: '2026-11-01T00:00:00.000Z',
        payload: { repository: { full_name: 'example/owner-a' }, workflow_run: { id: 1 } },
      },
    ]],
  });
  const logs = await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    syncOne: async (target) => written.push(target.ref),
    lock: async () => {},
  });
  assert.deepEqual(written, ['example/owner-a#7']);
  assert.deepEqual(worker.calls.ack, [['allow', 'other-repo', 'wrong-type']]);
  assert.ok(logs.some((line) => /不在授权清单/.test(line)));
  assert.ok(logs.some((line) => /workflow_run/.test(line)));
  const rows = readLatencyLog(fixture.paths.latencyFile);
  // 跳过的三条也算「处理完」（都已确认）：延迟行按现有口径照样记，但只有 allow 这一条真的写了看板。
  assert.deepEqual(rows.map((row) => row.deliveryId), ['allow', 'other-repo', 'wrong-type']);
  assert.ok(rows.every((row) => row.source === 'worker'));
});

test('W4c SC3 乱序：同一目标的旧事件晚到不覆盖新状态', async () => {
  const fixture = eventRunFixture();
  const written = [];
  const worker = fakePullWorker({
    batches: [[
      issueEvent('newer', { issue: 7, createdAt: '2026-11-01T00:00:09.000Z' }),
      issueEvent('older', { issue: 7, createdAt: '2026-11-01T00:00:01.000Z' }),
    ]],
  });
  const logs = await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    syncOne: async (target) => written.push(target.ref),
    lock: async () => {},
  });
  assert.deepEqual(written, ['example/owner-a#7'], '旧事件不触发第二次写');
  assert.ok(logs.some((line) => /乱序/.test(line)));
  assert.deepEqual(worker.calls.ack, [['newer', 'older']], '旧事件也确认掉，不堵队列');
});

test('W4c SC3 重放：同一 deliveryId 只处理一次', async () => {
  const fixture = eventRunFixture();
  const written = [];
  const worker = fakePullWorker({ batches: [[issueEvent('dup', { issue: 7 }), issueEvent('dup', { issue: 7 })]] });
  const logs = await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    syncOne: async (target) => written.push(target.ref),
    lock: async () => {},
  });
  assert.deepEqual(written, ['example/owner-a#7']);
  assert.ok(logs.every((line) => !/乱序/.test(line)));
  assert.equal(worker.calls.ack.length, 1);
  assert.ok(worker.calls.ack[0].every((id) => id === 'dup'));
});

test('W4c SC4 抢不到写锁：每 2 秒重试、最多 10 秒，仍抢不到就抛错，事件不确认也不写', async () => {
  let t = 0;
  const sleeps = [];
  await assert.rejects(
    acquireWriteLock({
      probe: () => ({ held: true, known: true }),
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      now: () => t,
    }),
    /写锁一直被占用/,
  );
  assert.deepEqual(sleeps, Array(LOCK_WAIT_MAX_MS / LOCK_RETRY_MS).fill(LOCK_RETRY_MS));
  assert.equal(LOCK_RETRY_MS * sleeps.length, LOCK_WAIT_MAX_MS);

  const fixture = eventRunFixture();
  const worker = fakePullWorker({ batches: [[issueEvent('locked', { issue: 7 })]] });
  const written = [];
  await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    syncOne: async (target) => written.push(target.ref),
    lock: async () => {
      throw new WriteLockBusyError('写锁一直被占用：测试');
    },
  });
  assert.deepEqual(written, []);
  assert.deepEqual(worker.calls.ack, [], '抢不到锁那一拍不确认');
  assert.equal(worker.calls.fail.length, 1, '上报一次失败，事件留在 Worker 队列里');
  assert.match(worker.calls.fail[0].error, /写锁/);
});

test('W4c SC4 写锁探测按 /proc/locks 判定：锁文件残留不算被占用', () => {
  const fixture = eventRunFixture();
  const lockFile = path.join(fixture.home, 'prio-write.lock');
  fs.writeFileSync(lockFile, '');
  const stat = fs.statSync(lockFile);
  const fakeProc = path.join(fixture.home, 'locks.txt');
  fs.writeFileSync(fakeProc, '7: FLOCK ADVISORY WRITE 4242 08:01:1 0 EOF\n');
  assert.equal(writeLockHeld({ file: lockFile, procLocksFile: fakeProc }).held, false);
  const dev = BigInt(stat.dev);
  const major = ((dev >> 8n) & 0xfffn).toString(16).padStart(2, '0');
  const minor = ((dev & 0xffn) | ((dev >> 12n) & ~0xffn)).toString(16).padStart(2, '0');
  fs.writeFileSync(fakeProc, `7: FLOCK ADVISORY WRITE 4242 ${major}:${minor}:${stat.ino} 0 EOF\n`);
  assert.equal(writeLockHeld({ file: lockFile, procLocksFile: fakeProc }).held, true);
  assert.equal(writeLockHeld({ file: path.join(fixture.home, 'missing.lock'), procLocksFile: fakeProc }).held, false);
  // 只有 /proc/locks 读不到、但 /proc 还在：靠 fd 扫描仍然能给出结论。
  assert.deepEqual(writeLockHeld({ file: lockFile, procLocksFile: path.join(fixture.home, 'nope.txt') }), {
    held: false,
    known: true,
    reason: 'free',
  });
  // 两条路都读不到（非 Linux）：明确说「探测不了」。
  assert.deepEqual(
    writeLockHeld({
      file: lockFile,
      procLocksFile: path.join(fixture.home, 'nope.txt'),
      procDir: path.join(fixture.home, 'no-proc'),
    }),
    { held: false, known: false, reason: 'no-proc' },
  );
});

test('W4c SC4 fd 形式的 flock 不进 /proc/locks 时，靠「有人开着锁文件」判定为忙', { skip: !fs.existsSync('/proc/self/fd') }, () => {
  const fixture = eventRunFixture();
  const lockFile = path.join(fixture.home, 'prio-write.lock');
  fs.writeFileSync(lockFile, '');
  const emptyProc = path.join(fixture.home, 'locks-empty.txt');
  fs.writeFileSync(emptyProc, '');
  // 本机实测：run-field.sh 那种 `exec 8>锁文件; flock -n 8` 不出现在 /proc/locks，
  // 只有持锁进程开着那个 fd。所以「有进程开着这个文件」也要算忙（宁可少写一次）。
  assert.equal(writeLockHeld({ file: lockFile, procLocksFile: emptyProc }).held, false);
  const fd = fs.openSync(lockFile, 'r');
  try {
    const seen = writeLockHeld({ file: lockFile, procLocksFile: emptyProc });
    assert.equal(seen.held, true, JSON.stringify(seen));
    assert.equal(seen.reason, 'open-fd');
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(writeLockHeld({ file: lockFile, procLocksFile: emptyProc }).held, false);
});

test('W4c SC4 写的时候如实传 linkAllowed：没有 mac-mini-stopped 是 false，有是 true', async () => {
  const fixture = eventRunFixture();
  const seen = [];
  const first = fakePullWorker({ batches: [[issueEvent('a', { issue: 7 })]] });
  await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: first.fetchImpl,
    syncOne: async (target) => seen.push(target.linkAllowed),
    lock: async () => {},
  });
  fs.writeFileSync(fixture.paths.markerFile, '');
  const second = fakePullWorker({ batches: [[issueEvent('b', { issue: 8 })]] });
  await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: second.fetchImpl,
    syncOne: async (target) => seen.push(target.linkAllowed),
    lock: async () => {},
  });
  assert.deepEqual(seen, [false, true]);
});

test('W4c SC5 event-run.disabled 存在就空转：一条事件都不拉，日志写人话', async () => {
  const fixture = eventRunFixture();
  fs.writeFileSync(fixture.paths.disabledFile, '');
  const worker = fakePullWorker({ batches: [[issueEvent('ignored', { issue: 7 })]] });
  const logs = await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    syncOne: async () => {
      throw new Error('停用期间不该写');
    },
    lock: async () => {},
  });
  assert.equal(worker.calls.pull, 0, '停用时不拉事件');
  assert.deepEqual(worker.calls.ack, []);
  assert.ok(logs.some((line) => /事件拉取已停用/.test(line)));
});

test('W4c SC5 .prio/disabled 存在时只确认不写', async () => {
  const fixture = eventRunFixture();
  fs.writeFileSync(fixture.paths.prioDisabledFile, '');
  const worker = fakePullWorker({ batches: [[issueEvent('d1', { issue: 7 })]] });
  let writes = 0;
  const logs = await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    syncOne: async () => {
      writes += 1;
    },
    lock: async () => {},
  });
  assert.equal(writes, 0);
  assert.deepEqual(worker.calls.ack, [['d1']]);
  assert.ok(logs.some((line) => /disabled/.test(line)));
});

test('W4c SC6 兜底轮询只在 Worker 连续失败到门槛后才跑（缺省 3 次），正常时一次都不跑', async () => {
  assert.equal(DEFAULT_POLL_AFTER_FAILURES, 3);
  const runFake = async ({ fail = false, pollAfterFailures = undefined, until }) => {
    let t = 0;
    const pollCalls = [];
    await runEventChannel({
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      until,
      ...(pollAfterFailures === undefined ? {} : { pollAfterFailures }),
      pull: async () => {
        if (fail) throw new Error('worker down');
        return [];
      },
      poll: async () => {
        pollCalls.push(t);
        return [];
      },
      latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
    });
    return pollCalls;
  };
  assert.deepEqual(await runFake({ until: 200000 }), [], 'Worker 正常：兜底轮询一次都不跑');
  // 失败只发生在 60 秒节点上：t=4000 第 1 次、t=60000 第 2 次、t=120000 第 3 次，t=180000 那一拍才允许轮询。
  assert.deepEqual(await runFake({ fail: true, until: 190000 }), [180000]);
  assert.deepEqual(await runFake({ fail: true, until: 70000, pollAfterFailures: 1 }), [60000]);
  assert.deepEqual(await runFake({ until: 130000, pollAfterFailures: 0 }), [0, 60000, 120000], '0 = 退回每拍都跑的旧行为');
});

test('W4c SC6 兜底轮询只补写事件路径没写成功的那一条，不整盘读', async () => {
  const fixture = eventRunFixture();
  const written = [];
  let failOnce = true;
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
    paths: fixture.paths,
    write: true,
    syncOne: async (target) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('连不上看板');
      }
      written.push(target.ref);
    },
    lock: async () => {},
    logger: () => {},
  });
  await assert.rejects(() => pipeline.onEvent(issueEvent('p1', { issue: 7 })), /连不上看板/);
  assert.deepEqual(written, []);
  assert.deepEqual(await pipeline.poll(), []);
  assert.deepEqual(written, ['example/owner-a#7'], '兜底轮询把没写成功的那条补上');
  assert.deepEqual(await pipeline.poll(), []);
  assert.deepEqual(written, ['example/owner-a#7'], '补完之后没有待补目标');
});

test('W4c SC7 日志超过上限截断保留尾部，权限仍是 600', () => {
  const fixture = eventRunFixture();
  const file = path.join(fixture.home, 'state', 'host', 'event-run.log');
  for (let i = 0; i < 200; i += 1) {
    appendEventRunLog(file, `第 ${i} 行 ${'x'.repeat(40)}`, { maxBytes: 2000 });
  }
  const stat = fs.statSync(file);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(stat.size <= 2000, `截断后大小 ${stat.size}`);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.match(text, /已截断较早内容/);
  assert.match(text, /第 199 行/);
  assert.doesNotMatch(text, /第 0 行/);
});

test('W4c SC7 单条读写模块未部署：不确认事件、日志写人话', async () => {
  assert.equal(SINGLE_ITEM_MODULE, './bin/prio-item.mjs');
  assert.equal(await loadSingleItemModule(), null, '本仓还没有单条读写模块，缺省加载应返回 null 而不是抛错');
  const fixture = eventRunFixture();
  const worker = fakePullWorker({ batches: [[issueEvent('m1', { issue: 7 })]] });
  const logs = await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    loadModule: async () => null,
    lock: async () => {},
  });
  assert.deepEqual(worker.calls.ack, [], '模块不在：这条事件不确认');
  assert.equal(worker.calls.fail.length, 1);
  assert.ok(logs.some((line) => /单条读写模块未部署/.test(line)));
});

test('W4c SC8 默认 dry-run 不写；--write 与 --dry-run 不能同时给', async () => {
  assert.equal(parseEventRunArgs([]).write, false);
  assert.throws(() => parseEventRunArgs(['--write', '--dry-run']), /不能同时/);
  assert.throws(() => parseEventRunArgs(['--poll-after-failures', 'abc']), /0 到 1000 的整数/);
  assert.throws(() => parseEventRunArgs(['--what']), /无法识别的参数/);
  const fixture = eventRunFixture();
  const worker = fakePullWorker({ batches: [[issueEvent('d1', { issue: 7 })]] });
  let writes = 0;
  const logs = await runOneTick({
    config: configOf(fixture),
    fetchImpl: worker.fetchImpl,
    syncOne: async () => {
      writes += 1;
    },
    lock: async () => {},
  });
  assert.equal(writes, 0, '默认 dry-run 一次都不写');
  assert.deepEqual(worker.calls.ack, [['d1']]);
  assert.ok(logs.some((line) => /dry-run/.test(line)));
});

test('W4c SC9 拉起脚本草稿：flock -n + pgrep -fx + setsid nohup，不装 crontab、不写死本机路径', () => {
  const src = fs.readFileSync(path.join(HERE, 'bin', 'event-run-ensure.sh'), 'utf8');
  assert.match(src, /flock -n 9/);
  assert.match(src, /pgrep -fx/);
  assert.match(src, /setsid nohup/);
  assert.doesNotMatch(src, /^\s*[^#\n]*crontab/m, '草稿不装 crontab，只在注释里提到它');
  assert.doesNotMatch(src, /\/home\/[A-Za-z0-9._-]+/, '不写死本机绝对路径');
  assert.doesNotMatch(src, /\/Users\/[A-Za-z0-9._-]+/);
  assert.match(src, /\$\{HOME/);
});

test('W4c SC8 --once 走 CLI 入口跑一拍：读 600 配置、处理一条事件、写完日志退出', async () => {
  const fixture = eventRunFixture();
  const worker = fakePullWorker({ batches: [[issueEvent('cli-1', { issue: 7 })]] });
  const written = [];
  const result = await eventRunMain(['--once', '--write'], {
    env: fixture.env,
    homeDir: fixture.home,
    paths: fixture.paths,
    fetchImpl: worker.fetchImpl,
    syncOne: async (target) => written.push(target.ref),
    lock: async () => {},
    capture: true,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(written, ['example/owner-a#7']);
  assert.deepEqual(worker.calls.ack, [['cli-1']]);
  const logged = fs.readFileSync(fixture.paths.logFile, 'utf8');
  assert.match(logged, /事件拉取器启动/);
  assert.match(logged, /--write 真写/);
  assert.match(logged, /事件拉取器已退出/);
  assert.doesNotMatch(logged, new RegExp(TOKEN));
});

test('W4c SC8 事件路径不整盘读看板：event-run 只借用授权清单解析，不碰整板查询', () => {
  const src = fs.readFileSync(path.join(HERE, 'bin', 'event-run.mjs'), 'utf8');
  assert.match(src, /readAuthorizedRepos/);
  assert.doesNotMatch(src, /loadBoardItems|loadPullRequests|runPrioSync|BOARD_ITEMS_QUERY|PR_SEARCH_QUERY/);
});
