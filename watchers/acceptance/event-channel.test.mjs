// W4 事件通道：Worker 校验 webhook 签名并入队，本机拉取循环每 2 秒拉一次；
// 60 秒轮询只在 Worker 连续失败到门槛（缺省 1 次：一次失败就兜底）之后才跑。
// 延迟写到 .prio/latency.jsonl。W4-c 的常驻拉取器（bin/event-run.mjs）也在这份测试里。
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACK_BODY_LIMIT,
  FAIL_BODY_LIMIT,
  WEBHOOK_BODY_LIMIT,
  createEventWorker,
} from './bin/event-worker.mjs';
import {
  PULL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  appendLatencyRow,
  defaultLatencyFile,
  latencyPercentiles,
  pullFromWorker,
  readLatencyLog,
  runEventChannel,
} from './bin/event-pull.mjs';
import {
  DEFAULT_POLL_AFTER_FAILURES,
  DISCOVERY_QUERY,
  SINGLE_ITEM_MODULE,
  appendEventRunLog,
  createEventPipeline,
  createEventRunState,
  createGraphqlListRecent,
  eventRunPaths,
  eventTargets,
  loadSingleItemModule,
  makeEventRunLogger,
  main as eventRunMain,
  parseEventRunArgs,
  readEventRunConfig,
  runEventRun,
} from './bin/event-run.mjs';
import { isReadOnlyGraphql } from './bin/github.mjs';
import { GRAPHQL_COST_PER_REQUEST } from './bin/rate-budget.mjs';
import { writeLockHeld } from './bin/prio-lock.mjs';
import { renderPrioBoardSection } from './bin/prio-board-section.mjs';
import { viewPrio } from './bin/prio-view.mjs';
import { defaultStateDir, stateFiles } from './bin/prio-sync.mjs';
import { tmpDir, writeProfile } from './fake-gh.fixture.mjs';

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

function failRequest(id, { token = TOKEN, error = 'boom-w4a' } = {}) {
  return new Request('https://example.invalid/fail', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id, error }),
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
  });
  assert.deepEqual(written, ['example/owner-a#7']);
  assert.ok(logs.every((line) => !/乱序/.test(line)));
  assert.equal(worker.calls.ack.length, 1);
  assert.ok(worker.calls.ack[0].every((id) => id === 'dup'));
});

test('W4c SC4 单条写入抢不到写锁：不 ack、上报一次失败、不设水位（抢锁已在 syncEventItem 内部 withWriteLock）', async () => {
  const fixture = eventRunFixture();
  const worker = fakePullWorker({ batches: [[issueEvent('locked', { issue: 7 })]] });
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const calls = [];
  await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    state,
    // 真值形状见 bin/prio-item.mjs 的 syncEventItem：抢不到整盘那把锁就是这个返回值。
    syncOne: async (payload) => {
      calls.push(payload.ref);
      return { ok: false, written: 0, planned: 0, skipped: 'lock-busy', reason: 'lock-busy', mode: 'write' };
    },
  });
  assert.deepEqual(calls, ['example/owner-a#7'], '事件还是交给 syncOne 一次，由它内部抢锁');
  assert.deepEqual(worker.calls.ack, [], '抢不到锁那一拍不确认');
  assert.equal(worker.calls.fail.length, 1, '上报一次失败，事件留在 Worker 队列里');
  assert.match(worker.calls.fail[0].error, /lock-busy/);
  assert.equal(state.watermarks.has('example/owner-a#7'), false, '没写成功不推进事件水位');
});

test('W4c SC4 写锁实现只有 bin/prio-lock.mjs 一份：event-run 不再自己留探测/抢锁，事件路径也不抢第二道锁', async () => {
  const mod = await import('./bin/event-run.mjs');
  assert.equal(typeof mod.writeLockHeld, 'undefined', '探测整盘那把锁的 writeLockHeld 只在 prio-lock.mjs');
  assert.equal(typeof mod.acquireWriteLock, 'undefined', '抢锁只在 prio-lock.mjs 的 withWriteLock（由 syncEventItem 调用）');
  assert.equal(typeof mod.WriteLockBusyError, 'undefined', '抢锁失败的错误类型已经跟着实现一起搬走');
  const src = fs.readFileSync(path.join(HERE, 'bin', 'event-run.mjs'), 'utf8');
  assert.match(src, /from '\.\/prio-lock\.mjs'/, '常量从同目录现成模块静态 import');
  assert.doesNotMatch(src, /procLocksFile|proc-locks/, '不再留第二份 /proc/locks 解析');
});

test('W4c SC4 写锁探测改由 bin/prio-lock.mjs 负责：锁文件残留不算被占，/proc/locks 列了算忙、读不到说探测不了', () => {
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

test('W4c SC4 锁探测的 fd 形式（prio-lock.mjs）：flock 不进 /proc/locks 时，靠「有人开着锁文件」判定为忙', { skip: !fs.existsSync('/proc/self/fd') }, () => {
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
  });
  fs.writeFileSync(fixture.paths.markerFile, '');
  const second = fakePullWorker({ batches: [[issueEvent('b', { issue: 8 })]] });
  await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: second.fetchImpl,
    syncOne: async (target) => seen.push(target.linkAllowed),
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
  });
  assert.equal(writes, 0);
  assert.deepEqual(worker.calls.ack, [['d1']]);
  assert.ok(logs.some((line) => /disabled/.test(line)));
});

test('W4c SC6 兜底轮询只在 Worker 连续失败到门槛后才跑（缺省 1 次：一次失败就兜底），正常时一次都不跑', async () => {
  assert.equal(DEFAULT_POLL_AFTER_FAILURES, 1);
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
  // 缺省门槛 1 次：t=0 第一次失败，t=60000 那一拍就允许轮询（之后每 60 秒一次）。
  assert.deepEqual(await runFake({ fail: true, until: 190000 }), [60000, 120000, 180000]);
  assert.deepEqual(await runFake({ fail: true, until: 70000 }), [60000], '一次失败就够，不用攒到第 3 次');
  assert.deepEqual(await runFake({ fail: true, until: 70000, pollAfterFailures: 1 }), [60000]);
  assert.deepEqual(await runFake({ until: 130000, pollAfterFailures: 0 }), [0, 60000, 120000], '0 = 退回每拍都跑的旧行为');
});

test('W4c SC6 兜底轮询只补写事件路径没写成功的那一条，不整盘读', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  let nowMs = t0;
  const written = [];
  let failOnce = true;
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async (target) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('连不上看板');
      }
      written.push(target.ref);
    },
    logger: () => {},
  });
  await assert.rejects(() => pipeline.onEvent(issueEvent('p1', { issue: 7 })), /连不上看板/);
  assert.deepEqual(written, []);
  // 补写通道有退避：失败后第一拍（同一时刻）还没到期，不重试。
  assert.deepEqual(await pipeline.poll(), []);
  assert.deepEqual(written, [], '退避没到期：这一拍不补');
  nowMs = t0 + 60000;
  assert.deepEqual(await pipeline.poll(), []);
  assert.deepEqual(written, ['example/owner-a#7'], '60 秒后兜底轮询把没写成功的那条补上');
  nowMs = t0 + 120000;
  assert.deepEqual(await pipeline.poll(), []);
  assert.deepEqual(written, ['example/owner-a#7'], '补完之后没有待补目标');
});

test('W4c SC6 兜底发现：Worker 失败期间发现授权仓最近更新的 PR/issue，PR 反查任务 issue、反查不到跳过，同一目标一拍只写一次', async () => {
  const fixture = eventRunFixture();
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
  const calls = [];
  const written = [];
  const state = createEventRunState({ allowedRepos: ['example/owner-a', 'example/owner-b'] });
  // 事件路径已经留下一半：#7 也在发现结果里，这一拍只能写一次。
  state.pending.set('example/owner-a#7', { repo: 'example/owner-a', issue: 7, ref: 'example/owner-a#7', via: 'event' });
  const pipeline = createEventPipeline({
    state,
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async (target) => {
      written.push(target.ref);
      return { written: 1 };
    },
    logger: () => {},
    listRecent: async ({ repo, sinceMs }) => {
      calls.push({ repo, sinceMs });
      if (repo === 'example/owner-a') {
        return [
          { repo, number: 7, kind: 'issue', updatedAt: '2026-11-01T11:59:30.000Z' },
          { repo, number: 9, kind: 'pull', updatedAt: '2026-11-01T11:59:40.000Z', body: '任务 issue：example/owner-a#11' },
          { repo, number: 12, kind: 'pull', updatedAt: '2026-11-01T11:59:50.000Z', body: '没有任务 issue 行', headRef: 'feature/y' },
          { repo, number: 13, kind: 'issue', updatedAt: '2026-11-01T10:00:00.000Z' },
        ];
      }
      return [{ repo, number: 5, kind: 'issue', updatedAt: '2026-11-01T11:59:59.000Z' }];
    },
  });
  assert.deepEqual(await pipeline.poll(), []);
  assert.deepEqual(
    calls.map((call) => call.repo),
    ['example/owner-a', 'example/owner-b'],
    '每个授权仓每拍发现一次（每仓 1 次 GraphQL）',
  );
  assert.ok(calls.every((call) => call.sinceMs === nowMs - 10 * 60 * 1000), '进程刚起来：回看 10 分钟');
  assert.deepEqual(
    written,
    ['example/owner-a#7', 'example/owner-a#11', 'example/owner-b#5'],
    '#7 只写一次；PR#9 反查到任务 issue#11；反查不到的 PR#12 与早于 since 的 #13 跳过',
  );
});

test('W4c SC6 兜底发现的时间水位：首次回看 10 分钟，之后按上次成功发现减 2 分钟', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  let nowMs = t0;
  const calls = [];
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async () => ({ written: 0 }),
    logger: () => {},
    listRecent: async ({ repo, sinceMs }) => {
      calls.push([repo, sinceMs]);
      return [];
    },
  });
  await pipeline.poll();
  nowMs = t0 + 60000;
  await pipeline.poll();
  assert.deepEqual(calls, [
    ['example/owner-a', t0 - 600000],
    ['example/owner-a', t0 - 120000],
  ]);
});

test('W4c SC6 .prio/disabled 存在时发现路径只发现不写，日志写明', async () => {
  const fixture = eventRunFixture();
  fs.writeFileSync(fixture.paths.prioDisabledFile, '');
  const logs = [];
  let writes = 0;
  let discovered = 0;
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
    paths: fixture.paths,
    write: true,
    now: () => Date.parse('2026-11-01T12:00:00.000Z'),
    syncOne: async () => {
      writes += 1;
      return { written: 1 };
    },
    logger: (line) => logs.push(line),
    listRecent: async ({ repo }) => {
      discovered += 1;
      return [{ repo, number: 7, kind: 'issue', updatedAt: '2026-11-01T11:59:30.000Z' }];
    },
  });
  assert.deepEqual(await pipeline.poll(), []);
  assert.equal(discovered, 1, '停写开关只管写，发现照跑');
  assert.equal(writes, 0, '停写开关存在时发现路径一个都不写');
  assert.ok(logs.some((line) => /disabled/.test(line) && /不写/.test(line)));
});

test('W4c SC6 缺省发现通道用只读 GraphQL：每仓 1 次调用、PR 带出 body/headRefName、只回 updatedAt ≥ since 的行', async () => {
  assert.equal(isReadOnlyGraphql(DISCOVERY_QUERY), true, 'query 必须被只读通道认成单个只读 query');
  const calls = [];
  // 假 reader：按仓名返回两个仓的结果，记下每次调用的 query 与变量。
  const reader = {
    async ownerGraphql(query, variables) {
      calls.push({ query, variables });
      const recent = variables.name === 'owner-a';
      return {
        repository: {
          pullRequests: { nodes: [
            {
              __typename: 'PullRequest',
              number: 9,
              updatedAt: recent ? '2026-11-01T11:59:40Z' : '2026-11-01T11:30:00Z',
              headRefName: 'acceptance/7-9-sc1',
              body: '任务 issue：example/owner-a#11',
            },
          ] },
          issues: { nodes: [
            { __typename: 'Issue', number: 7, updatedAt: recent ? '2026-11-01T11:30:00Z' : '2026-11-01T09:00:00Z' },
            // issues 连接会同时返回 PR：不能当成 issue 号再写一遍。
            { __typename: 'PullRequest', number: 9, updatedAt: '2026-11-01T11:59:40Z' },
          ] },
        },
      };
    },
  };
  const listRecent = createGraphqlListRecent({ reader });
  const sinceMs = Date.parse('2026-11-01T11:00:00Z');
  const a = await listRecent({ repo: 'example/owner-a', sinceMs });
  const b = await listRecent({ repo: 'example/owner-b', sinceMs });

  assert.equal(calls.length, 2, '每仓只调 1 次');
  assert.deepEqual(calls.map((call) => call.variables), [
    { owner: 'example', name: 'owner-a' },
    { owner: 'example', name: 'owner-b' },
  ]);
  assert.ok(calls.every((call) => call.query === DISCOVERY_QUERY));
  assert.ok(calls.every((call) => isReadOnlyGraphql(call.query) === true));

  assert.deepEqual(a.map((row) => `${row.kind}:${row.number}`), ['pull:9', 'issue:7'], 'PR 不会从 issues 再写一遍');
  assert.deepEqual(b.map((row) => `${row.kind}:${row.number}`), ['pull:9'], 'updatedAt 早于 since 的整行丢掉');
  assert.equal(a[0].body, '任务 issue：example/owner-a#11');
  assert.equal(a[0].headRef, 'acceptance/7-9-sc1');
});

test('W4c SC6 缺省发现通道懒创建：第一次 poll 才读 profile 并建 reader，之后复用', async () => {
  let loaded = 0;
  let built = 0;
  const listRecent = createGraphqlListRecent({
    loadProfile: () => {
      loaded += 1;
      return { marker: '占位 profile' };
    },
    createReader: ({ profile }) => {
      built += 1;
      assert.equal(profile.marker, '占位 profile');
      return { ownerGraphql: async () => ({ repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } }) };
    },
  });
  assert.equal(loaded, 0, '创建时不读 profile');
  assert.equal(built, 0, '创建时不建 reader');
  await listRecent({ repo: 'example/owner-a', sinceMs: 0 });
  await listRecent({ repo: 'example/owner-a', sinceMs: 0 });
  assert.equal(loaded, 1);
  assert.equal(built, 1, 'reader 只建一次');
});

test('W4c SC6 runEventRun 把发现的 reader 接进 poll：授权仓每仓一次读取，目标走同一条写入', async () => {
  const fixture = eventRunFixture();
  const calls = [];
  const written = [];
  await runEventRun({
    config: { ...configOf(fixture), write: true },
    write: true,
    syncOne: async (payload) => {
      written.push(payload.ref);
      return { ok: true, written: 1 };
    },
    logger: () => {},
    reader: {
      async ownerGraphql(query, variables) {
        calls.push(variables.name);
        return {
          repository: {
            pullRequests: { nodes: [] },
            issues: { nodes: [
              { __typename: 'Issue', number: variables.name === 'owner-a' ? 7 : 8, updatedAt: new Date().toISOString() },
            ] },
          },
        };
      },
    },
    channel: async (deps) => {
      await deps.poll();
    },
  });
  assert.deepEqual(calls, ['owner-a', 'owner-b'], '每个授权仓读一次');
  assert.deepEqual(written.sort(), ['example/owner-a#7', 'example/owner-b#8']);
});

// ── W4-f：发现通道的额度闸、本次故障期已处理集合、pending 补写与可诊断性（issue #325）────

/** 按宿主布局写一份额度状态文件：used 是 prio-run 这一格的本小时用量，remaining 是账号令牌的响应头剩余。 */
function writeRateStateFile(file, { used = 0, remaining = null, nowMs = 0 } = {}) {
  const state = {
    version: 1,
    identities: remaining == null
      ? {}
      : {
        user: {
          known: true,
          remaining,
          remainingRaw: String(remaining),
          reset: new Date(nowMs + 30 * 60 * 1000).toISOString(),
          resetRaw: '1750000000',
          at: new Date(nowMs).toISOString(),
          source: 'test',
        },
      },
    components: used > 0
      ? { 'prio-run': { hourKey: Math.floor(nowMs / 3600000), used, updatedAt: new Date(nowMs).toISOString() } }
      : {},
    recovery: null,
    skips: { count: 0, lastAt: null, byKey: {} },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

test('W4f SC1 发现前过额度闸：over-budget / paused 这一拍 listRecent 一次都不调、不写，日志写明原因', async () => {
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
  const runOnce = async ({ budgetUsed = null, remaining = null }) => {
    const fixture = eventRunFixture();
    assert.ok(fixture.paths.rateStateFile, '设了 ACCEPTANCE_WATCHER_HOME 就得给出额度状态文件路径');
    assert.ok(fixture.paths.rateBudgetConfigFile, '也要给出预算配置路径');
    if (budgetUsed != null) {
      fs.mkdirSync(path.dirname(fixture.paths.rateBudgetConfigFile), { recursive: true });
      fs.writeFileSync(
        fixture.paths.rateBudgetConfigFile,
        JSON.stringify({ rateBudget: { loop: 500, 'prio-run': 10, 'board-live': 140 } }),
      );
    }
    writeRateStateFile(fixture.paths.rateStateFile, { used: budgetUsed ?? 0, remaining, nowMs });
    const calls = [];
    const written = [];
    const logs = [];
    const pipeline = createEventPipeline({
      state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
      paths: fixture.paths,
      write: true,
      now: () => nowMs,
      syncOne: async (target) => {
        written.push(target.ref);
        return { written: 1 };
      },
      logger: (line) => logs.push(line),
      listRecent: async ({ repo }) => {
        calls.push(repo);
        return [{ repo, number: 7, kind: 'issue', updatedAt: new Date(nowMs).toISOString() }];
      },
    });
    await pipeline.poll();
    return { calls, written, logs };
  };

  // 预算闸：used 8 + cost 6 > 预算 10 → over-budget。
  const overBudget = await runOnce({ budgetUsed: 8 });
  assert.deepEqual(overBudget.calls, [], '额度闸拒绝：这一拍一次发现请求都不发');
  assert.deepEqual(overBudget.written, [], '也不写任何目标');
  assert.ok(overBudget.logs.some((line) => /额度不够/.test(line) && /over-budget/.test(line)), '日志写明原因');

  // 响应头闸：剩余 700 < PAUSE_REMAINING(800) → paused。
  const paused = await runOnce({ remaining: 700 });
  assert.deepEqual(paused.calls, [], '剩余不够：这一拍一次发现请求都不发');
  assert.deepEqual(paused.written, []);
  assert.ok(paused.logs.some((line) => /额度不够/.test(line) && /remaining-below-800/.test(line)), '日志写明原因');
});

test('W4f SC2 每次实际发出的发现请求都记账：ownerGraphql 抛错也记一笔并写回 rate-budget.json', async () => {
  const fixture = eventRunFixture();
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
  // 先放一个基线用量：只断言增量，不断言绝对值。
  writeRateStateFile(fixture.paths.rateStateFile, { used: 10, nowMs });
  let attempts = 0;
  const failing = createGraphqlListRecent({
    reader: {
      async ownerGraphql() {
        attempts += 1;
        throw new Error('HTTP 404：仓库地址不对');
      },
    },
    rateStateFile: fixture.paths.rateStateFile,
    now: () => nowMs,
  });
  await assert.rejects(() => failing({ repo: 'example/owner-a', sinceMs: 0 }), /HTTP 404/);
  assert.equal(attempts, 1, '这一次请求确实发出去了（只是失败）');
  const afterFailure = JSON.parse(fs.readFileSync(fixture.paths.rateStateFile, 'utf8'));
  assert.equal(afterFailure.components['prio-run'].used, 10 + 6, '失败那一拍也记一笔（6 点），且已写回文件');

  // 成功那一次同样记账：增量仍是 6。
  const ok = createGraphqlListRecent({
    reader: {
      async ownerGraphql() {
        attempts += 1;
        return { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } };
      },
    },
    rateStateFile: fixture.paths.rateStateFile,
    now: () => nowMs,
  });
  await ok({ repo: 'example/owner-a', sinceMs: 0 });
  const afterOk = JSON.parse(fs.readFileSync(fixture.paths.rateStateFile, 'utf8'));
  assert.equal(afterOk.components['prio-run'].used, 10 + 6 + 6, '成功那一次也记一笔');
});

test('W4f SC3 本次故障期已处理集合：重叠窗口内同一目标只写一次，pull 成功即清空', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  let nowMs = t0;
  const written = [];
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const pipeline = createEventPipeline({
    state,
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async (target) => {
      written.push(target.ref);
      return { written: 1 };
    },
    logger: () => {},
    // 每拍都返回同一个目标：两次 poll 的 since 窗口都会覆盖到它。
    listRecent: async ({ repo }) => [{ repo, number: 7, kind: 'issue', updatedAt: new Date(t0).toISOString() }],
  });
  await pipeline.poll();
  nowMs = t0 + 60000;
  await pipeline.poll();
  assert.deepEqual(written, ['example/owner-a#7'], '两次 poll 都覆盖到它，只写一次');
  assert.equal(state.handled.size, 1, '处理过的目标记进集合');

  // Worker 恢复（pullFromWorker 成功）即清空。
  const recovered = eventRunFixture();
  const shared = createEventRunState({ allowedRepos: ['example/owner-a'] });
  shared.handled.set('example/owner-a#7', 0);
  const worker = fakePullWorker({ batches: [[]] });
  await runEventRun({
    config: { ...configOf(recovered), write: true },
    write: true,
    syncOne: async () => ({ written: 1 }),
    logger: () => {},
    state: shared,
    fetchImpl: worker.fetchImpl,
    channel: async (deps) => {
      await deps.pull();
    },
  });
  assert.equal(shared.handled.size, 0, 'pull 成功 = Worker 恢复，集合清空');
});

test('W4f SC3 已处理集合不吞后来的更新：updatedAt 更大的同一目标照样重写', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  let nowMs = t0;
  let updatedMs = t0;
  const written = [];
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const pipeline = createEventPipeline({
    state,
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async (target) => {
      written.push(target.ref);
      return { written: 1 };
    },
    logger: () => {},
    listRecent: async ({ repo }) => [{ repo, number: 7, kind: 'issue', updatedAt: new Date(updatedMs).toISOString() }],
  });
  await pipeline.poll();
  nowMs = t0 + 60000;
  await pipeline.poll();
  assert.equal(written.length, 1, '同一个 updatedAt 只写一次');
  updatedMs = t0 + 90000;
  nowMs = t0 + 120000;
  await pipeline.poll();
  assert.equal(written.length, 2, '故障期内目标又有更新，不能被已处理集合吞掉');
});

test('W4f SC4 发现目标写失败留在 pending，下一拍补写成功并移出', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  let nowMs = t0;
  let failOnce = true;
  const written = [];
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const pipeline = createEventPipeline({
    state,
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async (target) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('看板写不进去');
      }
      written.push(target.ref);
      return { written: 1 };
    },
    logger: () => {},
    listRecent: async ({ repo }) => [{ repo, number: 7, kind: 'issue', updatedAt: new Date(t0).toISOString() }],
  });
  await pipeline.poll();
  assert.deepEqual(written, [], '第一次写失败');
  assert.ok(state.pending.has('example/owner-a#7'), '写失败的目标留在 pending 里');
  nowMs = t0 + 60000;
  await pipeline.poll();
  assert.deepEqual(written, ['example/owner-a#7'], '下一拍补写成功');
  assert.equal(state.pending.has('example/owner-a#7'), false, '补完就移出 pending');
});

test('W4f SC5 Worker 正常但 ok:false（写锁被占）：hasPending 让 poll 每 60 秒补写一拍，ok:false 仍不 ack', async () => {
  let t = 0;
  let pending = false;
  const polls = [];
  const confirmed = [];
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 70000,
    pull: async () => (pending ? [] : [issueEvent('lock-busy-1', { issue: 7 })]),
    poll: async (options) => {
      polls.push({ t, ...options });
      pending = false; // 补写成功
      return [];
    },
    confirm: async (ids) => confirmed.push(...ids),
    onEvent: async () => {
      pending = true; // 写锁被占：留在 pending，事件不确认
      throw new Error('单条读写失败：example/owner-a#7（lock-busy）');
    },
    hasPending: () => pending,
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.deepEqual(confirmed, [], 'ok:false 不 ack：事件留在 Worker 队列里');
  assert.deepEqual(polls, [{ t: 60000, workerFailing: false }], 'Worker 正常也每 60 秒补写一拍，并告知 Worker 没失败（不跑发现）');
});

test('W4f SC6 ctx.stdout 接上日志 sink：静默跳过原因按 ref 汇总成一行', async () => {
  const fixture = eventRunFixture();
  const logs = [];
  let writes = 0;
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
    paths: fixture.paths,
    write: true,
    now: () => 0,
    syncOne: async (target, ctx) => {
      writes += 1;
      assert.equal(typeof ctx.stdout?.write, 'function', 'ctx 带 stdout sink');
      ctx.stdout.write('额度不够：这一条不读也不写，留给下一拍\n');
      ctx.stdout.write('\n');
      ctx.stdout.write('写锁被占（lock-busy-item）：这一条不读也不写，留给下一次事件或 30 分钟整盘\n');
      return { ok: true, written: 0, mode: 'write' };
    },
    logger: (line) => logs.push(line),
  });
  await pipeline.onEvent(issueEvent('skip-1', { issue: 7 }));
  assert.equal(writes, 1, '静默跳过的这一条 syncOne 照常调了一次');
  const skipLines = logs.filter((line) => /单条读写跳过/.test(line));
  assert.equal(skipLines.length, 1, '按 ref 汇总成一行，不逐行照抄');
  assert.match(skipLines[0], /example\/owner-a#7/, '行里有 ref');
  assert.match(skipLines[0], /额度不够/);
  assert.match(skipLines[0], /写锁被占/);
  assert.equal(skipLines[0].includes('\n'), false, '就是一行');
});

test('W4f SC7 文案与实现一致：顶部注释写 GraphQL 每仓 1 次，测试里不再写 × 2 次 REST', () => {
  const src = fs.readFileSync(path.join(HERE, 'bin', 'event-run.mjs'), 'utf8');
  const head = src.split('\n').slice(0, 30).join('\n');
  assert.match(head, /GraphQL/, '顶部注释写明发现走 GraphQL');
  assert.match(head, /每仓 1 次/, '写明每仓 1 次请求');
  assert.doesNotMatch(head, /只读 REST/, '不再写「只读 REST」');
  const tests = fs.readFileSync(path.join(HERE, 'event-channel.test.mjs'), 'utf8');
  // 只看发现那条用例的正文：整份文件里一定还有这条断言自己的字面量。
  const start = tests.indexOf("test('W4c SC6 兜底发现：Worker 失败期间");
  assert.ok(start > 0, '找得到发现通道那条用例');
  const end = tests.indexOf('\ntest(', start + 10);
  const block = tests.slice(start, end < 0 ? undefined : end);
  assert.match(block, /每仓 1 次 GraphQL/, '断言文案改成每仓 1 次 GraphQL');
  assert.equal(block.includes(['× 2', '次 REST'].join(' ')), false, '不再出现「× 2 次 REST」');
});

test('W4f SC8 discover 单仓读失败不牵连其它仓：失败仓跳过并记一行，水位只在有仓成功时推进', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  const written = [];
  const since = [];
  const logs = [];
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a', 'example/owner-b'] }),
    paths: fixture.paths,
    write: true,
    now: () => t0,
    syncOne: async (target) => {
      written.push(target.ref);
      return { written: 1 };
    },
    logger: (line) => logs.push(line),
    listRecent: async ({ repo, sinceMs }) => {
      since.push([repo, sinceMs]);
      if (repo === 'example/owner-a') throw new Error('读失败：HTTP 502');
      return [{ repo, number: 5, kind: 'issue', updatedAt: new Date(t0).toISOString() }];
    },
  });
  await pipeline.poll();
  assert.deepEqual(written, ['example/owner-b#5'], '失败仓不牵连：另一仓照常发现与写入');
  assert.ok(logs.some((line) => /example\/owner-a/.test(line) && /读失败/.test(line)), '日志有一行失败说明');
  assert.deepEqual(await pipeline.poll(), []);
  assert.deepEqual(since.at(-1), ['example/owner-b', t0 - 2 * 60 * 1000], '至少一仓成功才推进水位：下一拍回看起点是上次成功减 2 分钟');
});

test('W4f SC9 授权清单里含 * 的条目在发现时跳过并记一行，其它仓照常，事件路径不受影响', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  fs.writeFileSync(
    fixture.paths.authorizedReposFile,
    JSON.stringify({ repos: ['example-org/*', 'example/owner-b'] }),
  );
  const calls = [];
  const written = [];
  const logs = [];
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example-org/*', 'example/owner-b'] }),
    paths: fixture.paths,
    write: true,
    now: () => t0,
    syncOne: async (target) => {
      written.push(target.ref);
      return { written: 1 };
    },
    logger: (line) => logs.push(line),
    listRecent: async ({ repo }) => {
      calls.push(repo);
      return [{ repo, number: 5, kind: 'issue', updatedAt: new Date(t0).toISOString() }];
    },
  });
  await pipeline.poll();
  assert.deepEqual(calls, ['example/owner-b'], '带 * 的条目不为它发请求，其它仓照常');
  assert.deepEqual(written, ['example/owner-b#5']);
  assert.ok(logs.some((line) => /example-org\/\*/.test(line) && /通配/.test(line)), '跳过的条目记一行');
  // readAuthorizedRepos 的校验规则不变：含 * 的条目照样通过解析（发现时才是跳过点）。
  const { readAuthorizedRepos } = await import('./bin/prio-run.mjs');
  assert.deepEqual(
    readAuthorizedRepos(fixture.paths.authorizedReposFile),
    ['example-org/*', 'example/owner-b'],
    '授权清单校验规则不变',
  );
});

// ── W4-g：发现闸不重复记账、written:0 不算完成、补写退避与放弃、日志与预算重读（issue #327）────

test('W4g SC1 发现闸只判定不记账：used 增量 = 实际请求数 × 6，不多出闸那 6 点', async () => {
  const fixture = eventRunFixture();
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
  writeRateStateFile(fixture.paths.rateStateFile, { used: 10, nowMs });
  const calls = [];
  // 真的记账通道：每发一次发现请求就 chargeOnce 记一笔（与生产同一条路径）。
  const listRecent = createGraphqlListRecent({
    reader: {
      async ownerGraphql(_query, { owner, name }) {
        calls.push(`${owner}/${name}`);
        return { repository: { pullRequests: { nodes: [] }, issues: { nodes: [] } } };
      },
    },
    rateStateFile: fixture.paths.rateStateFile,
    now: () => nowMs,
  });
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a', 'example/owner-b'] }),
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async () => ({ written: 1 }),
    logger: () => {},
    listRecent,
  });
  await pipeline.poll();
  assert.equal(calls.length, 2, '两个授权仓各发一次发现请求');
  const after = JSON.parse(fs.readFileSync(fixture.paths.rateStateFile, 'utf8'));
  const used = after.components['prio-run'].used;
  assert.equal(used, 10 + GRAPHQL_COST_PER_REQUEST * calls.length, 'used 只按实际发出的请求记账');
  assert.notEqual(
    used,
    10 + GRAPHQL_COST_PER_REQUEST + GRAPHQL_COST_PER_REQUEST * calls.length,
    '闸自己不再多记那 6 点（判定用 cost:0 + reserve）',
  );
});

test('W4g SC2 reserve 在预算边界上生效：仓数 × 6 预留不够就一次请求都不发，used 不变', async () => {
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
  const runOnce = async ({ repos, budget, used }) => {
    const fixture = eventRunFixture();
    fs.mkdirSync(path.dirname(fixture.paths.rateBudgetConfigFile), { recursive: true });
    fs.writeFileSync(
      fixture.paths.rateBudgetConfigFile,
      JSON.stringify({ rateBudget: { loop: 500, 'prio-run': budget, 'board-live': 140 } }),
    );
    writeRateStateFile(fixture.paths.rateStateFile, { used, nowMs });
    const calls = [];
    const logs = [];
    const pipeline = createEventPipeline({
      state: createEventRunState({ allowedRepos: repos }),
      paths: fixture.paths,
      write: true,
      now: () => nowMs,
      syncOne: async () => ({ written: 1 }),
      logger: (line) => logs.push(line),
      listRecent: async ({ repo }) => {
        calls.push(repo);
        return [];
      },
    });
    await pipeline.poll();
    const state = JSON.parse(fs.readFileSync(fixture.paths.rateStateFile, 'utf8'));
    return { calls, logs, used: state.components['prio-run']?.used ?? 0 };
  };

  // 两仓：used 6 + cost 0 + reserve 12 > 预算 13 → 拒绝，且 used 不变（拒绝不是靠记账堆出来的）。
  const two = await runOnce({ repos: ['example/owner-a', 'example/owner-b'], budget: 13, used: 6 });
  assert.deepEqual(two.calls, [], 'reserve 不够：这一拍一次发现请求都不发');
  assert.equal(two.used, 6, '被拒那一拍不记任何点，used 仍是 6');
  assert.ok(two.logs.some((line) => /额度不够/.test(line) && /over-budget/.test(line)), '日志写明原因');

  // 同一份预算只留一个授权仓：used 6 + 0 + reserve 6 ≤ 13 → 放行，证明 reserve 随仓数变。
  const one = await runOnce({ repos: ['example/owner-a'], budget: 13, used: 6 });
  assert.deepEqual(one.calls, ['example/owner-a'], 'reserve 随仓数降到 6：这一拍放行并发一次请求');
  assert.equal(one.used, 6, '闸不记点：放行不再给 used 加 6');
});

test('W4g SC3 written:0 的静默跳过不算完成：不进 handled、日志写跳过、重叠窗口内下一拍重写', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  let nowMs = t0;
  const writes = [];
  const logs = [];
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const pipeline = createEventPipeline({
    state,
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async (target) => {
      writes.push(target.ref);
      return { ok: true, written: 0, mode: 'write', reason: 'rate-budget' };
    },
    logger: (line) => logs.push(line),
    listRecent: async ({ repo }) => [{ repo, number: 7, kind: 'issue', updatedAt: new Date(t0).toISOString() }],
  });
  await pipeline.poll();
  nowMs = t0 + 60000;
  await pipeline.poll();
  assert.equal(state.handled.size, 0, 'written:0 不进「本次故障期已处理」集合');
  assert.equal(writes.length, 2, '同一目标下一拍（2 分钟重叠窗口内）会再写一次');
  const skipLines = logs.filter((line) => /跳过/.test(line));
  assert.ok(skipLines.length >= 1, '日志里写「跳过」');
  assert.ok(skipLines.some((line) => /rate-budget/.test(line)), '跳过行带原因');
  assert.equal(logs.some((line) => /完成/.test(line)), false, '一条都没写就不许出现「完成」');

  // mode === 'disabled' 仍然算完成：这一条可以 ack。
  const disabledFixture = eventRunFixture();
  const disabledState = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const disabledLogs = [];
  const disabledPipeline = createEventPipeline({
    state: disabledState,
    paths: disabledFixture.paths,
    write: true,
    now: () => t0,
    syncOne: async () => ({ ok: true, written: 0, mode: 'disabled', reason: 'stop-switch' }),
    logger: (line) => disabledLogs.push(line),
    listRecent: async ({ repo }) => [{ repo, number: 7, kind: 'issue', updatedAt: new Date(t0).toISOString() }],
  });
  await disabledPipeline.poll();
  assert.equal(disabledState.handled.size, 1, 'mode=disabled 仍进 handled，事件可以 ack');
  assert.ok(disabledLogs.some((line) => /完成/.test(line)), '停写开关生效这一条仍写「完成」');
});

test('W4g SC4 补写退避 60 秒 → 5 分钟 → 15 分钟：未到期不调 syncOne、也不说已经补完', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  let nowMs = t0;
  const calls = [];
  const logs = [];
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const pipeline = createEventPipeline({
    state,
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async (target) => {
      calls.push({ at: nowMs, ref: target.ref });
      throw new Error('看板写不进去');
    },
    logger: (line) => logs.push(line),
  });
  // 事件路径先失败一次：pending 里留下这条，第一次补写排在「失败时刻 + 60 秒」。
  await assert.rejects(() => pipeline.onEvent(issueEvent('retry-backoff-1', { issue: 7 })), /看板写不进去/);
  assert.equal(calls.length, 1, '事件路径写一次就失败');
  const due1 = t0 + 60000;
  const due2 = due1 + 5 * 60000;
  const due3 = due2 + 15 * 60000;
  const pollAt = async (at) => {
    nowMs = at;
    assert.deepEqual(await pipeline.poll({ workerFailing: false }), []);
  };

  // 中途（+30 秒）与差 1 秒到期（+59 秒）：都不重试，也不写「已经补完」。
  await pollAt(t0 + 30000);
  assert.equal(calls.length, 1, '失败后 30 秒：还没到期，不补写');
  await pollAt(due1 - 1000);
  assert.equal(calls.length, 1, '失败后 59 秒：还差 1 秒，不补写');
  assert.equal(logs.some((line) => /已经补完/.test(line)), false, 'pending 非空只是没到期，不许说「已经补完」');

  await pollAt(due1);
  assert.equal(calls.length, 2, '失败后 60 秒：第 1 次补写');
  assert.equal(calls.at(-1).at, due1, '补写就发生在这一拍');

  await pollAt(due1 + 1000);
  assert.equal(calls.length, 2, '第 1 次失败后 1 秒：第 2 档 5 分钟还没到期');
  await pollAt(due2 - 1000);
  assert.equal(calls.length, 2, '第 2 档差 1 秒：不补写');
  await pollAt(due2);
  assert.equal(calls.length, 3, '第 2 次补写在 5 分钟后');
  assert.equal(calls.at(-1).at, due2);

  await pollAt(due2 + 1000);
  assert.equal(calls.length, 3, '第 3 档 15 分钟还没到期');
  await pollAt(due3 - 1000);
  assert.equal(calls.length, 3, '第 3 档差 1 秒：不补写');
  await pollAt(due3);
  assert.equal(calls.length, 4, '第 3 次补写在 15 分钟后（这次失败就到上限）');
  assert.equal(calls.at(-1).at, due3);
});

test('W4g SC5 上限放弃：第 4 次失败后移出 pending、只写一行放弃日志、之后不再重试；ok:false 仍不 ack', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  let nowMs = t0;
  const calls = [];
  const logs = [];
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const pipeline = createEventPipeline({
    state,
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async (target) => {
      calls.push({ at: nowMs, ref: target.ref });
      return { ok: false, written: 0, reason: 'lock-busy' };
    },
    logger: (line) => logs.push(line),
  });
  await assert.rejects(() => pipeline.onEvent(issueEvent('abandon-1', { issue: 7 })), /lock-busy/);
  const key = 'example/owner-a#7';
  assert.equal(state.pending.has(key), true, '写失败先留在 pending');

  // 三档退避各补一次：第 4 次失败（事件路径 1 次 + 补写 3 次）就到上限。
  const due1 = t0 + 60000;
  const due2 = due1 + 5 * 60000;
  const due3 = due2 + 15 * 60000;
  for (const at of [due1, due2, due3]) {
    nowMs = at;
    await pipeline.poll({ workerFailing: false });
  }
  assert.equal(calls.length, 4, '事件路径 1 次 + 补写 3 次');
  assert.equal(state.pending.has(key), false, '到上限就从 pending 移出');
  assert.equal(state.retries.has(key), false, '退避记录也清掉');
  const abandonLines = logs.filter((line) => /放弃补写/.test(line));
  assert.equal(abandonLines.length, 1, '放弃日志只有一行');
  assert.match(abandonLines[0], /example\/owner-a#7/);
  assert.match(abandonLines[0], /lock-busy/, '放弃行带最后一次原因');
  assert.match(abandonLines[0], /不再自动补写/);

  const afterAbandon = calls.length;
  nowMs = due3 + 60000;
  await pipeline.poll({ workerFailing: false });
  nowMs = due3 + 60 * 60000;
  await pipeline.poll({ workerFailing: false });
  assert.equal(calls.length, afterAbandon, '放弃之后 poll 不再重试它');
  assert.equal(logs.filter((line) => /放弃补写/.test(line)).length, 1, '放弃日志仍只有一行');

  // runEventChannel 侧（照 W4f SC5 的写法）：ok:false 不 ack，放弃补写之后这条事件仍留在 Worker 队列里。
  const channelFixture = eventRunFixture();
  const channelState = createEventRunState({ allowedRepos: ['example/owner-a'] });
  let t = 0;
  let pendingPull = true;
  const confirmed = [];
  const channelPipeline = createEventPipeline({
    state: channelState,
    paths: channelFixture.paths,
    write: true,
    now: () => t,
    syncOne: async () => ({ ok: false, written: 0, reason: 'lock-busy' }),
    logger: () => {},
  });
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 3 * 60 * 1000,
    pull: async () => {
      if (!pendingPull) return [];
      pendingPull = false;
      return [issueEvent('abandon-ack-1', { issue: 7 })];
    },
    poll: (options) => channelPipeline.poll(options),
    confirm: async (ids) => confirmed.push(...ids),
    onEvent: (event) => channelPipeline.onEvent(event),
    hasPending: () => channelState.pending.size > 0,
    latencyFile: path.join(tmpDir(), '.prio', 'latency.jsonl'),
  });
  assert.deepEqual(confirmed, [], 'ok:false 不 ack：这条事件没有被 confirm');
});

test('W4g SC6 flushSkips 只在 written === 0 时输出：写成功不留「单条读写跳过」，成功照旧写「完成」', async () => {
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  const runWith = async (syncOne) => {
    const fixture = eventRunFixture();
    const logs = [];
    const pipeline = createEventPipeline({
      state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
      paths: fixture.paths,
      write: true,
      now: () => t0,
      syncOne,
      logger: (line) => logs.push(line),
      listRecent: async ({ repo }) => [{ repo, number: 7, kind: 'issue', updatedAt: new Date(t0).toISOString() }],
    });
    await pipeline.poll();
    return logs;
  };

  // 写成功：syncEventItem 照样会往 stdout 写额度闸自己的日志，那不是跳过。
  const okLogs = await runWith(async (target, ctx) => {
    ctx.stdout.write('rate-recovery component=prio-run remaining=4200\n');
    return { ok: true, written: 1, mode: 'write' };
  });
  assert.equal(okLogs.filter((line) => /单条读写跳过/.test(line)).length, 0, 'written > 0 不汇总成「跳过」');
  assert.ok(okLogs.some((line) => /example\/owner-a#7 完成/.test(line)), '成功那次照旧写「完成」');

  // 一条都没写：仍按 ref 汇总成一行。
  const zeroLogs = await runWith(async (target, ctx) => {
    ctx.stdout.write('额度不够：这一条不读也不写，留给下一拍\n');
    return { ok: true, written: 0, mode: 'write', reason: 'rate-budget' };
  });
  const zeroSkips = zeroLogs.filter((line) => /单条读写跳过/.test(line));
  assert.equal(zeroSkips.length, 1, 'written:0 仍按 ref 汇总成一行');
  assert.match(zeroSkips[0], /example\/owner-a#7/);
  assert.match(zeroSkips[0], /额度不够/);
});

test('W4g SC7 闸出错的 rate-unknown 行只有一个时间戳', async () => {
  const fixture = eventRunFixture();
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
  writeRateStateFile(fixture.paths.rateStateFile, { used: 0, nowMs });
  // 真的日志函数：它自己会在行首加一个时间戳。
  const logger = makeEventRunLogger(fixture.paths.logFile, { now: () => nowMs, stdout: null });
  const calls = [];
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async () => ({ written: 1 }),
    logger,
    // 口径错的预算：decideTick 自己抛错，走闸的 catch 分支（rate-unknown）。
    budgets: { loop: 500, 'prio-run': 0, 'board-live': 140 },
    listRecent: async ({ repo }) => {
      calls.push(repo);
      return [];
    },
  });
  await pipeline.poll();
  assert.deepEqual(calls, ['example/owner-a'], '闸自己出错就放行留痕：这一拍照常发现');
  const text = fs.readFileSync(fixture.paths.logFile, 'utf8');
  const line = text.split('\n').find((row) => row.includes('rate-unknown'));
  assert.ok(line, '闸出错要留一行 rate-unknown');
  const stamps = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) || [];
  assert.equal(stamps.length, 1, `rate-unknown 行只有日志器加的那一个时间戳：${line}`);
});

test('W4g SC8 预算文件读失败不缓存 null：下一拍重读到新预算，越界后不再发现', async () => {
  const fixture = eventRunFixture();
  const nowMs = Date.parse('2026-11-01T12:00:00.000Z');
  fs.mkdirSync(path.dirname(fixture.paths.rateBudgetConfigFile), { recursive: true });
  fs.writeFileSync(fixture.paths.rateBudgetConfigFile, '{ 这不是合法 JSON');
  writeRateStateFile(fixture.paths.rateStateFile, { used: 10, nowMs });
  const calls = [];
  const logs = [];
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a'] }),
    paths: fixture.paths,
    write: true,
    now: () => nowMs,
    syncOne: async () => ({ written: 1 }),
    logger: (line) => logs.push(line),
    listRecent: async ({ repo }) => {
      calls.push(repo);
      return [];
    },
  });
  await pipeline.poll();
  assert.equal(calls.length, 1, '预算文件读失败：闸只按响应头判定，这一拍照常发现');
  assert.ok(logs.some((line) => /额度预算配置无法使用/.test(line)), '读失败要留一行');

  // 换成好预算：used 10 + reserve 6 > 13 → 越界。第二次 poll 必须用上新预算。
  fs.writeFileSync(
    fixture.paths.rateBudgetConfigFile,
    JSON.stringify({ rateBudget: { loop: 500, 'prio-run': 13, 'board-live': 140 } }),
  );
  writeRateStateFile(fixture.paths.rateStateFile, { used: 10, nowMs });
  await pipeline.poll();
  assert.equal(calls.length, 1, '下一拍重读到新预算：listRecent 不再被调');
  assert.ok(logs.some((line) => /额度不够/.test(line) && /over-budget/.test(line)), '日志写明越界');
});

test('W4g SC9 logQuiet 按类别去重：两仓同拍都读失败各出一行，不同类别互不吞掉', async () => {
  const fixture = eventRunFixture();
  const t0 = Date.parse('2026-11-01T12:00:00.000Z');
  const logs = [];
  const pipeline = createEventPipeline({
    state: createEventRunState({ allowedRepos: ['example/owner-a', 'example/owner-b'] }),
    paths: fixture.paths,
    write: true,
    now: () => t0,
    syncOne: async () => ({ written: 1 }),
    logger: (line) => logs.push(line),
    listRecent: async ({ repo }) => {
      throw new Error(`读失败：${repo}`);
    },
  });
  await pipeline.poll();
  const failLines = logs.filter((line) => /读失败/.test(line));
  assert.equal(failLines.length, 2, '两个仓各一行，不被 60 秒去重吞掉');
  assert.equal(failLines.filter((line) => line.includes('example/owner-a')).length, 1, 'owner-a 一行');
  assert.equal(failLines.filter((line) => line.includes('example/owner-b')).length, 1, 'owner-b 一行');
  assert.ok(
    logs.some((line) => /没有待补的单条目标/.test(line)),
    '同一拍里「单仓读失败」与「这一拍没有待补目标」两类都留下',
  );
});

test('W4c SC10 延迟行带 written 标记：真写入为 true，无变化/dry-run/非授权仓为 false，老行不写这个键', async () => {
  // 真写入与无变化：syncOne 自己报 written。
  const writtenFixture = eventRunFixture();
  const worker = fakePullWorker({ batches: [[issueEvent('w1', { issue: 7 }), issueEvent('w2', { issue: 8 })]] });
  await runOneTick({
    config: { ...configOf(writtenFixture), write: true },
    fetchImpl: worker.fetchImpl,
    syncOne: async (target) => ({ written: target.issue === 7 ? 1 : 0 }),
  });
  const rows = readLatencyLog(writtenFixture.paths.latencyFile);
  assert.equal(rows.find((row) => row.deliveryId === 'w1')?.written, true, '写到看板并读回成功 = true');
  assert.equal(rows.find((row) => row.deliveryId === 'w2')?.written, false, '无变化（written 0）= false');

  // dry-run 与非授权仓：都不写，标记为 false。
  const dryFixture = eventRunFixture();
  const dryWorker = fakePullWorker({
    batches: [[issueEvent('d1', { issue: 7 }), issueEvent('x1', { repo: 'example/owner-z', issue: 9 })]],
  });
  await runOneTick({
    config: configOf(dryFixture),
    fetchImpl: dryWorker.fetchImpl,
    syncOne: async () => ({ written: 1 }),
  });
  const dryRows = readLatencyLog(dryFixture.paths.latencyFile);
  assert.equal(dryRows.find((row) => row.deliveryId === 'd1')?.written, false, 'dry-run = false');
  assert.equal(dryRows.find((row) => row.deliveryId === 'x1')?.written, false, '非授权仓 = false');

  // onEvent 不返回结果（老调用方）：行里不写 written 键，看板按原口径收。
  const bareFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  let t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 1,
    pull: async () => [{ deliveryId: 'legacy', created_at: '2026-10-31T00:00:00.000Z' }],
    poll: async () => [],
    onEvent: async () => {},
    latencyFile: bareFile,
  });
  assert.equal('written' in readLatencyLog(bareFile)[0], false);
});

test('W4c SC6 窄写入函数：payload 形状固定、ctx 只有状态目录；ok:false 抛错带 reason 且不设水位，mode=disabled 不设水位但可 ack', async () => {
  const fixture = eventRunFixture();
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const calls = [];
  const pipeline = createEventPipeline({
    state,
    paths: fixture.paths,
    write: true,
    syncOne: async (payload, ctx) => {
      calls.push({ payload, ctx });
      if (payload.issue === 7) return { ok: false, reason: '看板字段不接受这个值' };
      if (payload.issue === 8) return { ok: true, mode: 'disabled', written: 0 };
      return { ok: true, written: 1 };
    },
    logger: () => {},
  });
  await assert.rejects(() => pipeline.onEvent(issueEvent('f1', { issue: 7 })), /看板字段不接受这个值/);
  assert.equal(state.watermarks.has('example/owner-a#7'), false, 'ok:false 不推进水位');
  assert.deepEqual(
    Object.keys(calls[0].payload).sort(),
    ['event', 'issue', 'linkAllowed', 'now', 'ref', 'repo', 'source'],
    'payload 形状固定',
  );
  assert.deepEqual(Object.keys(calls[0].ctx).sort(), ['dir', 'stdout'], 'ctx 只有状态目录与日志 sink 两个键');
  assert.equal(calls[0].ctx.dir, fixture.paths.stateDir, 'ctx.dir 就是状态目录');
  assert.equal(typeof calls[0].ctx.stdout?.write, 'function', 'ctx.stdout 是日志 sink（W4f SC6）');

  // mode=disabled 且 ok：停写开关生效，这条不写、不设水位，但不抛错，所以可以 ack。
  assert.deepEqual(await pipeline.onEvent(issueEvent('d1', { issue: 8 })), { written: false });
  assert.equal(state.watermarks.has('example/owner-a#8'), false);
  assert.deepEqual(await pipeline.onEvent(issueEvent('w1', { issue: 9 })), { written: true });
  assert.equal(state.watermarks.has('example/owner-a#9'), true);
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

test('W4c SC7 单条读写模块未部署：不确认事件、日志写人话（注入「未部署」，不看真实文件在不在）', async () => {
  assert.equal(SINGLE_ITEM_MODULE, './bin/prio-item.mjs');
  // 模块在不在由注入的 importer 决定，测试不依赖 bin/prio-item.mjs 是否已经部署（#319 合并后也不会变红）。
  const missing = Object.assign(new Error('Cannot find module'), { code: 'ERR_MODULE_NOT_FOUND' });
  assert.equal(
    await loadSingleItemModule({ importer: async () => { throw missing; } }),
    null,
    '模块不在：加载器返回 null，不抛错',
  );
  assert.equal(
    await loadSingleItemModule({ importer: async () => ({ syncOneItem: async () => ({ ok: true }) }) }),
    null,
    '模块在但只导出旧的 syncOneItem、没有 syncEventItem（#319 之前的导出名）：同样算未部署',
  );
  const fakeSync = async () => ({ ok: true });
  assert.equal(
    await loadSingleItemModule({ importer: async () => ({ syncEventItem: fakeSync }) }),
    fakeSync,
    '取的是 #319 的适配层导出 syncEventItem',
  );
  await assert.rejects(
    () => loadSingleItemModule({ importer: async () => { throw new Error('读模块时磁盘出错'); } }),
    /磁盘出错/,
    '其它加载错误照原样抛出去',
  );
  const fixture = eventRunFixture();
  const worker = fakePullWorker({ batches: [[issueEvent('m1', { issue: 7 })]] });
  const logs = await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    loadModule: async () => null,
  });
  assert.deepEqual(worker.calls.ack, [], '模块不在：这条事件不确认');
  assert.equal(worker.calls.fail.length, 1);
  assert.ok(logs.some((line) => /单条读写模块未部署/.test(line)));
});

// 端到端夹具：真的 bin/prio-item.mjs（经 prio-item-loader 加载）+ 假 GitHub、假写函数、假回读。
// ITEM_QUERY 的返回形状按 bin/prio-item.mjs 里的查询造：一条看板条目、没有交叉引用 PR。
function e2ePrioFixture() {
  const fixture = eventRunFixture();
  const { profile } = writeProfile(fixture.home);
  const boardId = 'PVT_e2e_board';
  const queries = [];
  const reader = {
    async ownerGraphql(query, variables) {
      queries.push({ query, variables });
      if (query !== e2eItemQuery) throw new Error('端到端事件路径只该发 ITEM_QUERY');
      return {
        rateLimit: { cost: 2, remaining: 4000, resetAt: '2026-11-01T13:00:00Z' },
        user: { projectV2: { id: boardId } },
        repository: {
          issue: {
            timelineItems: { nodes: [] },
            projectItems: {
              nodes: [
                {
                  id: 'PVTI_e2e_7',
                  isArchived: false,
                  updatedAt: '2026-11-01T00:00:00.000Z',
                  project: { id: boardId, number: 7 },
                  content: {
                    __typename: 'Issue',
                    number: 7,
                    state: 'OPEN',
                    updatedAt: '2026-11-01T00:00:00.000Z',
                    repository: { nameWithOwner: 'example/owner-a' },
                    labels: { nodes: [] },
                  },
                  fieldValues: {
                    nodes: [
                      { __typename: 'ProjectV2ItemFieldSingleSelectValue', name: 'Todo', field: { name: '状态' } },
                    ],
                  },
                },
              ],
            },
          },
        },
      };
    },
  };
  const writes = [];
  const write = async (action) => {
    writes.push(structuredClone(action));
    return { ok: true };
  };
  const lockFile = path.join(fixture.paths.stateDir, 'prio-write.lock');
  // 注入的 ctx 只有这一层：profile / reader / write / readBack / 锁路径都是测试给的，其余用真实现。
  const syncOne = (payload, ctx) => e2eSyncEventItem(payload, {
    ...ctx,
    profile,
    reader,
    write,
    readBack: async (change) => change.new,
    lockPath: lockFile,
    // 抢锁与额度都别用真时钟/真状态文件：锁最多等几毫秒，额度闸按「未启用」走。
    lockOptions: { retryMs: 2, maxWaitMs: 6 },
    env: {},
  });
  return { fixture, profile, reader, writes, lockFile, queries, syncOne };
}

let e2eItemQuery = null;
let e2eSyncEventItem = null;

test('W4c SC7 真 syncEventItem + 假 GitHub 端到端', async () => {
  // 真加载器 + 真适配层：加载器取到的必须是 #319 的 syncEventItem，不是旧的 syncOneItem。
  e2eSyncEventItem = await loadSingleItemModule();
  assert.equal(typeof e2eSyncEventItem, 'function', '加载器要从 bin/prio-item.mjs 取到 syncEventItem');
  e2eItemQuery = (await import('./bin/prio-item.mjs')).ITEM_QUERY;

  const { fixture, writes, queries, syncOne } = e2ePrioFixture();
  const state = createEventRunState({ allowedRepos: ['example/owner-a'] });
  const worker = fakePullWorker({ batches: [[issueEvent('e2e-1', { issue: 7 })]] });
  await runOneTick({
    config: { ...configOf(fixture), write: true },
    fetchImpl: worker.fetchImpl,
    state,
    syncOne,
  });

  assert.equal(queries.length, 1, '一条事件只发一次单条查询');
  assert.equal(writes.length, 1, '假 write 被调用一次');
  assert.equal(writes[0].repo, 'example/owner-a');
  assert.equal(writes[0].issue, 7);
  assert.equal(writes[0].itemId, 'PVTI_e2e_7', '写的是这一条看板条目');
  assert.deepEqual(Object.keys(writes[0].fields), ['优先级'], '空值只补优先级');
  assert.equal(writes[0].fields['优先级'], 'P2');
  assert.deepEqual(worker.calls.ack, [['e2e-1']], '写成功才确认这条事件');
  assert.deepEqual(worker.calls.fail, [], '写成功不上报失败');
  assert.equal(state.watermarks.has('example/owner-a#7'), true);
  const rows = readLatencyLog(fixture.paths.latencyFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deliveryId, 'e2e-1');
  assert.equal(rows[0].written, true, '真写进看板且读回一致 = written:true');

  // 同一套真实现，锁被另一个活的持有者占着：syncEventItem 自己返回 ok:false, skipped:'lock-busy'。
  const locked = e2ePrioFixture();
  const lockMarker = `${locked.lockFile}.item`;
  fs.writeFileSync(lockMarker, `${JSON.stringify({ pid: process.pid, startedAt: '2026-11-01T00:00:00.000Z' })}\n`);
  try {
    const lockedState = createEventRunState({ allowedRepos: ['example/owner-a'] });
    const lockedWorker = fakePullWorker({ batches: [[issueEvent('e2e-locked', { issue: 7 })]] });
    await runOneTick({
      config: { ...configOf(locked.fixture), write: true },
      fetchImpl: lockedWorker.fetchImpl,
      state: lockedState,
      syncOne: locked.syncOne,
    });
    assert.equal(locked.writes.length, 0, '锁被占时一条都不写');
    assert.deepEqual(lockedWorker.calls.ack, [], '锁被占不 ack，留到下次');
    assert.equal(lockedWorker.calls.fail.length, 1, '上报一次失败');
    assert.match(lockedWorker.calls.fail[0].error, /lock-busy/);
    assert.equal(lockedState.watermarks.has('example/owner-a#7'), false, '没写成功不推进水位');
    assert.deepEqual(readLatencyLog(locked.fixture.paths.latencyFile), [], '没确认的事件不进延迟行');
  } finally {
    fs.rmSync(lockMarker, { force: true });
  }
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
  // 状态目录显式传给拉取器；pgrep -fx 的精确匹配必须跟着包含这个参数，RUN_ARGS 为空时也一样稳。
  assert.match(src, /--state-dir "\$STATE_DIR"/);
  assert.match(src, /CMD_ARGS="\$STATE_ARGS\$\{RUN_ARGS:\+ \$RUN_ARGS\}"/);
  assert.match(src, /pgrep -fx "\$NODE_BIN \$SCRIPT \$CMD_ARGS"/);
  assert.match(src, /"\$NODE_BIN" "\$SCRIPT" \$CMD_ARGS/);
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

// W4-a：部署入口（worker/index.mjs）、SQLite 版 DO 不给 txn 的适配、事件乱序到达。
// 只模拟 Durable Object 的接口，没有连真实 Cloudflare 账号；真实 DO 上的冒烟未做（见 worker/README.md）。

// SQLite 版 DO 的 transaction 回调按文档已不给 txn（该对象废弃），这里模拟只调一次、不传参数。
function noTxnStorage() {
  const map = new Map();
  const stats = { transactions: 0 };
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
      stats.transactions += 1;
      return fn();
    },
  };
  return { storage, stats };
}

// Durable Object 命名空间的最小替身：记下 idFromName / get 的入参，返回给定的实例。
function fakeChannelBinding(durable) {
  const calls = [];
  const namespace = {
    calls,
    idFromName(name) {
      calls.push(`id:${name}`);
      return { name };
    },
    get(id) {
      calls.push(`get:${id.name}`);
      return durable;
    },
  };
  return namespace;
}

test('W4-a SC2 事务适配：回调不给 txn 时用 storage 本身，给了 txn 就用 txn', async () => {
  const { runInTransaction } = await import('./bin/event-worker.mjs');
  const { storage, stats } = noTxnStorage();
  let seen = null;
  await runInTransaction(storage, async (db) => {
    seen = db;
  });
  assert.equal(stats.transactions, 1);
  assert.equal(seen, storage);

  const txn = { marker: 'txn' };
  const withTxn = {
    ...storage,
    async transaction(fn) {
      return fn(txn);
    },
  };
  let used = null;
  await runInTransaction(withTxn, async (db) => {
    used = db;
  });
  assert.equal(used, txn);
});

test('W4-a SC2 不传 txn 的存储上 /webhook 入队、重复 delivery 只入队一次、/fail 记失败、/ack 清队列', async () => {
  const { storage, stats } = noTxnStorage();
  const worker = createEventWorker({ storage, now: () => 1_700_000_000_000 });
  const env = workerEnv();

  await enqueueDelivery(worker, env, 'solo-txn');
  await enqueueDelivery(worker, env, 'solo-txn');
  assert.deepEqual(await pullIds(worker, env), ['solo-txn']);

  const failed = await worker.fetch(failRequest('solo-txn'), env);
  assert.equal(failed.status, 200);
  const failBody = await failed.json();
  assert.equal(failBody.failures, 1);
  assert.equal(failBody.abandoned, false);

  const acked = await worker.fetch(ackRequest(['solo-txn']), env);
  assert.equal(acked.status, 204);
  assert.deepEqual(await pullIds(worker, env), []);

  assert.ok(stats.transactions >= 4, `四条路由都要走事务，实际 ${stats.transactions}`);
});

test('W4-a SC1 Worker 入口把四条路由都转发到 idFromName(main) 的同一个 DO 实例', async () => {
  const entry = (await import('./worker/index.mjs')).default;
  const { EventChannelDurableObject } = await import('./bin/event-worker.mjs');
  const env = workerEnv();
  const durable = new EventChannelDurableObject(
    { storage: sharedStorage(), now: () => 1_700_000_000_000 },
    env,
  );
  const namespace = fakeChannelBinding(durable);
  const bound = { ...env, EVENT_CHANNEL: namespace };

  const posted = await entry.fetch(webhookRequest(smallPayload(), { delivery: 'entry-1' }), bound);
  assert.equal(posted.status, 204);

  const pulled = await entry.fetch(pullRequest(TOKEN), bound);
  const queued = await pulled.json();
  assert.deepEqual(queued.events.map((event) => event.deliveryId), ['entry-1']);

  const failed = await entry.fetch(failRequest('entry-1'), bound);
  assert.equal(failed.status, 200);
  assert.equal((await failed.json()).failures, 1);

  const acked = await entry.fetch(ackRequest(['entry-1']), bound);
  assert.equal(acked.status, 204);
  assert.deepEqual((await (await entry.fetch(pullRequest(TOKEN), bound)).json()).events, []);

  // 路由不在 Worker 层拦，未知路径也照转，由 DO 回 404。
  const unknown = await entry.fetch(new Request('https://example.invalid/nope', { method: 'GET' }), bound);
  assert.equal(unknown.status, 404);

  const ids = namespace.calls.filter((call) => call.startsWith('id:'));
  assert.deepEqual(ids, ['id:main', 'id:main', 'id:main', 'id:main', 'id:main', 'id:main']);
  assert.deepEqual(
    namespace.calls.filter((call) => call.startsWith('get:')),
    ['get:main', 'get:main', 'get:main', 'get:main', 'get:main', 'get:main'],
  );
});

test('W4-a SC1 入口没拿到 EVENT_CHANNEL 绑定时返回 500，不装作成功', async () => {
  const entry = (await import('./worker/index.mjs')).default;
  const response = await entry.fetch(webhookRequest(smallPayload(), { delivery: 'no-binding' }), workerEnv());
  assert.equal(response.status, 500);
  const half = await entry.fetch(
    webhookRequest(smallPayload(), { delivery: 'half-binding' }),
    { ...workerEnv(), EVENT_CHANNEL: {} },
  );
  assert.equal(half.status, 500);
});

test('W4-a SC4 旧事件晚到时不被丢弃、不顶掉已入队的新事件，/pull 按到达顺序交付', async () => {
  const worker = createEventWorker({ now: () => 1_700_000_000_000 });
  const env = workerEnv();
  const newer = JSON.stringify({
    created_at: '2026-10-31T00:00:30.000Z',
    action: 'synchronize',
    pull_request: { number: 12 },
  });
  const older = JSON.stringify({
    created_at: '2026-10-31T00:00:00.000Z',
    action: 'opened',
    pull_request: { number: 12 },
  });
  await postWebhook(worker, env, newer, 'late-new', 'pull_request');
  await postWebhook(worker, env, older, 'late-old', 'pull_request');

  const response = await worker.fetch(pullRequest(TOKEN), env);
  const events = (await response.json()).events;
  assert.deepEqual(events.map((event) => event.deliveryId), ['late-new', 'late-old']);
  assert.deepEqual(events.map((event) => event.created_at), [
    '2026-10-31T00:00:30.000Z',
    '2026-10-31T00:00:00.000Z',
  ]);
});

test('W4-a SC3 部署文件只有 SQLite 版 DO 绑定，没有密钥、令牌、本机路径', () => {
  const dir = path.join(HERE, 'worker');
  const toml = fs.readFileSync(path.join(dir, 'wrangler.toml'), 'utf8');
  const entry = fs.readFileSync(path.join(dir, 'index.mjs'), 'utf8');
  const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');

  assert.match(toml, /^name = "acceptance-event-channel"$/m);
  assert.match(toml, /^main = "index\.mjs"$/m);
  assert.match(toml, /^name = "EVENT_CHANNEL"$/m);
  assert.match(toml, /^class_name = "EventChannelDurableObject"$/m);
  assert.match(toml, /^new_sqlite_classes = \["EventChannelDurableObject"\]$/m);
  assert.doesNotMatch(toml, /^new_classes\s*=/m, '免费档只能用 SQLite 后端，迁移必须是 new_sqlite_classes');

  for (const source of [toml, entry, readme]) {
    assert.doesNotMatch(source, /gh[pousr]_[A-Za-z0-9]{20,}/);
    assert.doesNotMatch(source, /github_pat_/);
    assert.doesNotMatch(source, /\/Users\/[A-Za-z0-9._-]+/);
    assert.doesNotMatch(source, /WEBHOOK_SECRET\s*=/);
    assert.doesNotMatch(source, /PULL_TOKEN\s*=/);
    assert.doesNotMatch(source, /PraiseZhu/);
  }
  // 入口只转发，不自己读写存储，也不读 GitHub 令牌。
  assert.match(entry, /idFromName\('main'\)/);
  assert.doesNotMatch(entry, /node:fs/);
  assert.doesNotMatch(entry, /node:child_process/);
});

// W4-b：一条延迟行拆成三段（Worker 收到 / 本机拉到 / 写完）。
// receivedAt 由 Worker 写进队列记录，pulledAt 由拉取端在 acceptBatch 里记，gatewayMs = 写完 − Worker 收到。
// latencyMs 语义不变（事件发生 → 写完），现有断言照旧。

test('W4-b SC1 Worker 存 receivedAt：/pull 带出 Worker 收到时间，正文被省略时也带', async () => {
  const received = Date.parse('2026-10-31T00:00:05.000Z');
  const worker = createEventWorker({ now: () => received });
  const env = workerEnv();
  await enqueueDelivery(worker, env, 'stamped');
  const events = (await (await worker.fetch(pullRequest(TOKEN), env)).json()).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].receivedAt, '2026-10-31T00:00:05.000Z');
  assert.equal(events[0].created_at, '2026-10-31T00:00:00.000Z');

  // 正文超上限、只留元数据时，receivedAt 不能跟着 payload 一起丢。
  const tiny = createEventWorker({ now: () => received, maxValueBytes: 64 });
  const tinyEnv = workerEnv();
  const big = JSON.stringify({
    created_at: '2026-10-31T00:00:00.000Z',
    action: 'opened',
    body: 'x'.repeat(4000),
  });
  const response = await tiny.fetch(webhookRequest(big, { delivery: 'stamped-omitted' }), tinyEnv);
  assert.equal(response.status, 204);
  const omitted = (await (await tiny.fetch(pullRequest(TOKEN), tinyEnv)).json()).events[0];
  assert.equal(omitted.payloadOmitted, true);
  assert.equal(omitted.receivedAt, '2026-10-31T00:00:05.000Z');
});

test('W4-b SC2 延迟行同时记 receivedAt / pulledAt / gatewayMs，latencyMs 仍按事件发生时间算', async () => {
  const dir = tmpDir();
  const latencyFile = path.join(dir, '.prio', 'latency.jsonl');
  let t = Date.parse('2026-10-31T00:00:10.000Z');
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: Date.parse('2026-10-31T00:00:10.000Z') + 1,
    pull: async () => [
      {
        deliveryId: 'three-segments',
        event: 'pull_request',
        created_at: '2026-10-31T00:00:00.000Z',
        receivedAt: '2026-10-31T00:00:04.000Z',
        payload: {
          action: 'opened',
          repository: { full_name: 'example-org/owner-a' },
          pull_request: { number: 42 },
        },
      },
    ],
    poll: async () => [],
    onEvent: async () => {
      // 处理本身耗 1 秒：pulledAt 与 processedAt 就不会撞在同一毫秒上。
      t += 1000;
    },
    latencyFile,
  });
  const rows = readLatencyLog(latencyFile);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.deliveryId, 'three-segments');
  assert.equal(row.createdAt, '2026-10-31T00:00:00.000Z');
  assert.equal(row.receivedAt, '2026-10-31T00:00:04.000Z');
  assert.equal(row.pulledAt, '2026-10-31T00:00:10.000Z');
  assert.equal(row.processedAt, '2026-10-31T00:00:11.000Z');
  assert.equal(row.latencyMs, 11000);
  assert.equal(row.gatewayMs, 7000);
  assert.equal(row.source, 'worker');
  assert.equal(row.repo, 'example-org/owner-a');
  assert.equal(row.number, 42);
  assert.equal(row.action, 'opened');
  assert.equal(fs.statSync(latencyFile).mode & 0o777, 0o600);
});

test('W4-b SC3 receivedAt 缺失、非法或不是字符串时 gatewayMs 记 null，latencyMs 照旧且不抛错', async () => {
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  let t = Date.parse('2026-10-31T00:00:10.000Z');
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: Date.parse('2026-10-31T00:00:10.000Z') + 1,
    pull: async () => [
      { deliveryId: 'no-received', created_at: '2026-10-31T00:00:00.000Z' },
      { deliveryId: 'bad-received', created_at: '2026-10-31T00:00:02.000Z', receivedAt: 'not-a-date' },
      { deliveryId: 'not-string', created_at: '2026-10-31T00:00:05.000Z', receivedAt: 1761955200000 },
      { deliveryId: 'object-received', created_at: '2026-10-31T00:00:06.000Z', receivedAt: { at: '2026-10-31T00:00:04.000Z' } },
    ],
    poll: async () => [],
    latencyFile,
  });
  const rows = readLatencyLog(latencyFile);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.gatewayMs, null);
    assert.equal(row.receivedAt, null);
    assert.equal(typeof row.pulledAt, 'string');
  }
  assert.deepEqual(
    rows.map((row) => [row.deliveryId, row.gatewayMsReject]),
    [
      ['no-received', 'received-at-missing'],
      ['bad-received', 'received-at-invalid'],
      ['not-string', 'received-at-not-string'],
      ['object-received', 'received-at-not-string'],
    ],
  );
  assert.deepEqual(
    rows.map((row) => [row.deliveryId, row.latencyMs]),
    [
      ['no-received', 10000],
      ['bad-received', 8000],
      ['not-string', 5000],
      ['object-received', 4000],
    ],
  );
});

test('W4-b SC3 gatewayMs 只收 0—600000ms：receivedAt 在将来或差超过 10 分钟时记 null 并留 gatewayMsReject', async () => {
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  const at = Date.parse('2026-10-31T00:00:10.000Z');
  const created = '2026-10-31T00:00:00.000Z';
  let t = at;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: at + 1,
    pull: async () => [
      // receivedAt 比写完还晚：差值为负，不当成样本。
      { deliveryId: 'future-received', created_at: created, receivedAt: '2026-10-31T00:00:30.000Z' },
      // 差 10 分钟 11 秒，超过上限。
      { deliveryId: 'too-old', created_at: created, receivedAt: '2026-10-30T23:49:59.000Z' },
      // 正好 600000ms：收。
      { deliveryId: 'exactly-max', created_at: created, receivedAt: '2026-10-30T23:50:10.000Z' },
      // 正好 0：收。
      { deliveryId: 'zero', created_at: created, receivedAt: '2026-10-31T00:00:10.000Z' },
    ],
    poll: async () => [],
    latencyFile,
  });
  const rows = readLatencyLog(latencyFile);
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((row) => [row.deliveryId, row.gatewayMs, row.gatewayMsReject ?? null]),
    [
      ['future-received', null, 'negative'],
      ['too-old', null, 'too-large'],
      ['exactly-max', 600000, null],
      ['zero', 0, null],
    ],
  );
  // 范围校验不影响 latencyMs（事件发生 → 写完）。
  assert.deepEqual(
    rows.map((row) => row.latencyMs),
    [10000, 10000, 10000, 10000],
  );
});

test('W4-b SC4 短写时按 offset 继续写完剩下的字节，不留下半行', () => {
  const file = path.join(tmpDir(), '.prio', 'latency.jsonl');
  const realWriteSync = fs.writeSync;
  let calls = 0;
  // 每次只写 7 个字节，强制走短写分支。fs 是单例，event-pull.mjs 用的是同一个对象。
  fs.writeSync = (fd, buffer, offset, length) => {
    calls += 1;
    return realWriteSync(fd, buffer, offset, Math.min(7, length));
  };
  try {
    appendLatencyRow(file, { deliveryId: 'short-write', padding: 'x'.repeat(100) });
  } finally {
    fs.writeSync = realWriteSync;
  }
  assert.ok(calls > 1, `应该发生多次写：${calls}`);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.deliveryId, 'short-write');
  assert.equal(row.padding.length, 100);
});

test('W4-b SC4 pulledAtMs 不是有限数时 pulledAt 记 null，事件不算失败', async () => {
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  const at = Date.parse('2026-10-31T00:00:10.000Z');
  const controller = new AbortController();
  const reports = [];
  let nan = false;
  await runEventChannel({
    // 只在取这一批的 pulledAtMs 时给 NaN，写完的时刻恢复正常。
    now: () => (nan ? Number.NaN : at),
    sleep: async () => {},
    signal: controller.signal,
    pull: async () => {
      nan = true;
      return [
        {
          deliveryId: 'nan-pulled',
          created_at: '2026-10-31T00:00:00.000Z',
          receivedAt: '2026-10-31T00:00:09.000Z',
        },
      ];
    },
    poll: async () => [],
    reportFailure: async (event) => {
      reports.push(event.deliveryId);
      return { failures: 1 };
    },
    onEvent: async () => {
      nan = false;
      controller.abort();
    },
    latencyFile,
  });
  const rows = readLatencyLog(latencyFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deliveryId, 'nan-pulled');
  assert.equal(rows[0].pulledAt, null);
  assert.equal(rows[0].processedAt, '2026-10-31T00:00:10.000Z');
  assert.equal(rows[0].latencyMs, 10000);
  assert.equal(rows[0].gatewayMs, 1000);
  assert.deepEqual(reports, []);
});

test('W4-b #317 now() 整段不是有限数时 processedAt 记 null，不抛 RangeError，主流程仍确认', async () => {
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  const at = Date.parse('2026-10-31T00:00:10.000Z');
  const controller = new AbortController();
  const confirmed = [];
  let nan = false;
  await runEventChannel({
    // 拉到这一批之后整段 now() 都是 NaN：pulledAt 和 processedAt 都算不出来。
    now: () => (nan ? Number.NaN : at),
    sleep: async () => {},
    signal: controller.signal,
    pull: async () => {
      nan = true;
      return [
        {
          deliveryId: 'nan-all',
          created_at: '2026-10-31T00:00:00.000Z',
          receivedAt: '2026-10-31T00:00:04.000Z',
        },
      ];
    },
    poll: async () => [],
    confirm: async (ids) => {
      confirmed.push(...ids);
      controller.abort();
    },
    latencyFile,
  });
  const rows = readLatencyLog(latencyFile);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deliveryId, 'nan-all');
  assert.equal(rows[0].pulledAt, null);
  assert.equal(rows[0].processedAt, null);
  assert.equal(rows[0].latencyMs, null);
  assert.equal(rows[0].gatewayMs, null);
  assert.equal(rows[0].gatewayMsReject, 'processed-at-invalid');
  // 写日志失败不变事件失败：这条照常确认，Worker 才清掉。
  assert.deepEqual(confirmed, ['nan-all']);
});

test('W4-b SC4 首次追加时自动建目录，新文件权限 0600', async () => {
  const dir = tmpDir();
  const latencyFile = path.join(dir, 'deep', 'nested', '.prio', 'latency.jsonl');
  assert.equal(fs.existsSync(path.dirname(latencyFile)), false);
  let t = 0;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: 1,
    pull: async () => [{ deliveryId: 'first-row', created_at: '2026-10-31T00:00:00.000Z' }],
    poll: async () => [],
    latencyFile,
  });
  assert.equal(readLatencyLog(latencyFile).length, 1);
  assert.equal(fs.statSync(latencyFile).mode & 0o777, 0o600);
});

test('W4-b SC4 两个进程同时往同一个 latency.jsonl 追加：行数对得上，没有半行', async () => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  const moduleUrl = pathToFileURL(path.join(HERE, 'bin', 'event-pull.mjs')).href;
  const script = path.join(tmpDir(), 'append-rows.mjs');
  fs.writeFileSync(
    script,
    [
      `import { appendLatencyRow } from ${JSON.stringify(moduleUrl)};`,
      'const [file, tag, count] = process.argv.slice(2);',
      'for (let i = 0; i < Number(count); i += 1) {',
      "  appendLatencyRow(file, { deliveryId: `${tag}-${i}`, padding: 'x'.repeat(200) });",
      '}',
    ].join('\n'),
  );
  const write = (tag) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, latencyFile, tag, '100'], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${tag} 退出码 ${code}`))));
    });
  await Promise.all([write('a'), write('b')]);
  const lines = fs
    .readFileSync(latencyFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim());
  assert.equal(lines.length, 200);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line), `出现半行：${line.slice(0, 80)}`);
  }
  assert.equal(new Set(lines.map((line) => JSON.parse(line).deliveryId)).size, 200);
  assert.equal(fs.statSync(latencyFile).mode & 0o777, 0o600);
});

test('W4-b SC5 延迟文件默认位置由 prio-sync 的状态目录拼出：event-pull 写的和看板读的是同一个文件', async () => {
  const fakeHome = path.join(tmpDir(), 'home-example');
  const stateDir = defaultStateDir(fakeHome);
  const latencyFile = stateFiles(stateDir).latency;
  // 期望路径从 prio-sync 的状态目录定义拼出来，不把 event-pull 里的实现表达式抄一遍。
  assert.equal(defaultLatencyFile(fakeHome), latencyFile);
  assert.equal(path.isAbsolute(defaultLatencyFile()), true);
  assert.equal(defaultLatencyFile().endsWith(path.join('acceptance', 'tools', '.prio', 'latency.jsonl')), true);

  // 写：event-pull 按默认位置追加一行。
  const at = Date.parse('2026-10-31T00:00:10.000Z');
  let t = at;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: at + 1,
    pull: async () => [
      {
        deliveryId: 'same-file',
        created_at: '2026-10-31T00:00:00.000Z',
        receivedAt: '2026-10-31T00:00:09.000Z',
      },
    ],
    poll: async () => [],
    latencyFile: defaultLatencyFile(fakeHome),
  });
  assert.equal(readLatencyLog(latencyFile).length, 1);

  // 读：看板那一节按同一个状态目录读 latency.jsonl，能看到刚写的样本。
  const section = renderPrioBoardSection({ stateDir, nowMs: at + 1000 });
  assert.match(
    section,
    /关联 PR 延迟 事件→写完 p50 10000 p95 10000 \(n=1\)｜gateway p50 1000 p95 1000 \(n=1\)/,
  );

  await assert.rejects(
    runEventChannel({
      now: () => 0,
      sleep: async () => {},
      until: 1,
      pull: async () => [],
      poll: async () => [],
      latencyFile: path.join('.prio', 'latency.jsonl'),
    }),
    /latencyFile 必须是绝对路径/,
  );
});

test('W4-b SC1 同一拍的 worker 行和 poll 行各进各的组：事件→写完两条，gateway 只数带 receivedAt 的', async () => {
  const latencyFile = path.join(tmpDir(), '.prio', 'latency.jsonl');
  const at = Date.parse('2026-10-31T00:00:10.000Z');
  let t = at;
  await runEventChannel({
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    until: at + 1,
    pull: async () => [
      {
        deliveryId: 'from-worker',
        created_at: '2026-10-31T00:00:00.000Z',
        receivedAt: '2026-10-31T00:00:09.000Z',
      },
    ],
    poll: async () => [{ deliveryId: 'from-poll', created_at: '2026-10-31T00:00:02.000Z' }],
    // 这条测的是两种来源的统计分组，不测兜底门槛：门槛设 0 让 poll 每拍都跑。
    pollAfterFailures: 0,
    latencyFile,
  });
  const rows = readLatencyLog(latencyFile);
  assert.deepEqual(
    rows.map((row) => [row.deliveryId, row.source, row.latencyMs, row.gatewayMs]),
    [
      ['from-worker', 'worker', 10000, 1000],
      ['from-poll', 'poll', 8000, null],
    ],
  );
  const view = viewPrio({ latency: fs.readFileSync(latencyFile, 'utf8'), nowMs: at + 1000 });
  // 事件→写完两条都在；gateway 只有 worker 那一条。
  assert.equal(view.latency.n, 2);
  assert.equal(view.latency.p50, 8000);
  assert.equal(view.latency.p95, 10000);
  assert.equal(view.gatewayLatency.n, 1);
  assert.equal(view.gatewayLatency.p50, 1000);
  assert.match(
    view.lines.find((entry) => entry.startsWith('关联 PR 延迟')),
    /^关联 PR 延迟 事件→写完 p50 8000 p95 10000 \(n=2\)｜gateway p50 1000 p95 1000 \(n=1\)$/,
  );
});

// W4-e：请求体大小上限。三条读 body 的路由（/webhook、/ack、/fail）都先看 content-length 快速拒绝，
// 没有该头或声明偏小时按读到的累计字节数兜底，超限一律 413；/webhook 的 413 在验签之前返回。
// 413 只回上限数字，不回显 body、不提 secret。

// 可数读取次数的流：用来证明「超限就不再读」而不是「读完再判」。
function countingStream(chunks, counter) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      counter.reads += 1;
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
  });
}

function streamRequest(pathname, chunks, { headers = {}, counter = { reads: 0 } } = {}) {
  const request = new Request(`https://example.invalid${pathname}`, {
    method: 'POST',
    headers,
    body: countingStream(chunks, counter),
    duplex: 'half',
  });
  return { request, counter };
}

function repeatChunk(byte, size) {
  return new Uint8Array(size).fill(byte);
}

// 构造字节数正好为 size 的合法 webhook JSON：padding 全是 ASCII，字符数等于字节数。
function exactSizeWebhookBody(size) {
  const skeleton = {
    created_at: '2026-10-31T00:00:00.000Z',
    action: 'opened',
    repository: { full_name: 'example-org/example-repo' },
    issue: { number: 7 },
    padding: '',
  };
  const base = JSON.stringify(skeleton).length;
  return JSON.stringify({ ...skeleton, padding: 'x'.repeat(size - base) });
}

test('W4-e SC1 /webhook content-length 超限时直接 413：不打开 body 流、不入队', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  // 「一读就报错」的流：只要代码去读 body，worker.fetch 就会抛，不可能回 413。
  const unreadable = new Request('https://example.invalid/webhook', {
    method: 'POST',
    headers: {
      'content-length': String(WEBHOOK_BODY_LIMIT + 1),
      'x-github-delivery': 'too-large-cl',
      'x-github-event': 'issues',
    },
    body: new ReadableStream({
      pull(controller) {
        controller.error(new Error('body must not be read'));
      },
    }),
    duplex: 'half',
  });
  const response = await worker.fetch(unreadable, env);
  assert.equal(response.status, 413);
  assert.deepEqual(await pullIds(worker, env), []);
  // 413 只给上限，不回显 body 内容。
  const text = await response.text();
  assert.match(text, new RegExp(String(WEBHOOK_BODY_LIMIT)));
  assert.doesNotMatch(text, /action|opened/);
});

test('W4-e SC1 没有 content-length（chunked）时累计超限即 413，不把整段读完', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  const chunks = Array.from({ length: 8 }, () => repeatChunk(0x78, 256 * 1024));
  const { request, counter } = streamRequest('/webhook', chunks, {
    headers: { 'x-github-delivery': 'too-large-stream', 'x-github-event': 'issues' },
  });
  assert.equal(request.headers.get('content-length'), null);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 413);
  assert.ok(counter.reads < chunks.length, `超限后应停止读取，实际读了 ${counter.reads}/${chunks.length} 块`);
  assert.deepEqual(await pullIds(worker, env), []);
});

test('W4-e SC1 恶意 content-length 小于实际 body 时，按实际累计字节判 413', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  const chunks = Array.from({ length: 4 }, () => repeatChunk(0x78, 256 * 1024));
  const { request } = streamRequest('/webhook', chunks, {
    headers: {
      'content-length': '16',
      'x-github-delivery': 'lying-content-length',
      'x-github-event': 'issues',
    },
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 413);
  assert.deepEqual(await pullIds(worker, env), []);
});

test('W4-e SC1 body 字节数正好等于上限时通过：/webhook 204、/ack 204', async () => {
  const worker = createEventWorker();
  const env = workerEnv();

  const body = exactSizeWebhookBody(WEBHOOK_BODY_LIMIT);
  assert.equal(Buffer.byteLength(body), WEBHOOK_BODY_LIMIT);
  const accepted = await worker.fetch(
    new Request('https://example.invalid/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(WEBHOOK_BODY_LIMIT),
        'x-hub-signature-256': sign(body, SECRET),
        'x-github-delivery': 'at-limit',
        'x-github-event': 'issues',
      },
      body,
    }),
    env,
  );
  assert.equal(accepted.status, 204);
  const pulled = await worker.fetch(pullRequest(TOKEN), env);
  const events = (await pulled.json()).events;
  assert.deepEqual(events.map((event) => event.deliveryId), ['at-limit']);
  // 整条事件超过单值上限（128 KiB），存成元数据但事件本身不丢。
  assert.equal(events[0].payloadOmitted, true);
  assert.equal(events[0].number, 7);

  // 刚好等于 /ack 上限的合法确认体：JSON 骨架 12 字节，其余用 id 补满。
  const ackBody = `{"ids":["${'a'.repeat(ACK_BODY_LIMIT - 12)}"]}`;
  assert.equal(Buffer.byteLength(ackBody), ACK_BODY_LIMIT);
  const acked = await worker.fetch(
    new Request('https://example.invalid/ack', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': String(ACK_BODY_LIMIT),
      },
      body: ackBody,
    }),
    env,
  );
  assert.equal(acked.status, 204);

  // /fail 同一条边界：正好等于上限的合法失败体照常记一次失败。
  const failSkeleton = JSON.stringify({ id: 'at-limit', error: '' }).length;
  const failBody = JSON.stringify({ id: 'at-limit', error: 'x'.repeat(FAIL_BODY_LIMIT - failSkeleton) });
  assert.equal(Buffer.byteLength(failBody), FAIL_BODY_LIMIT);
  const failed = await worker.fetch(
    new Request('https://example.invalid/fail', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': String(FAIL_BODY_LIMIT),
      },
      body: failBody,
    }),
    env,
  );
  assert.equal(failed.status, 200);
  assert.equal((await failed.json()).failures, 1);

  // 只多一个字节就走 413：边界是「不超过上限」，不是「小于上限再加余量」。
  const overBody = exactSizeWebhookBody(WEBHOOK_BODY_LIMIT + 1);
  assert.equal(Buffer.byteLength(overBody), WEBHOOK_BODY_LIMIT + 1);
  const rejected = await worker.fetch(webhookRequest(overBody, { delivery: 'over-limit' }), env);
  assert.equal(rejected.status, 413);
});

test('W4-e SC1 限内的错签名 / 缺签名头 / 缺 secret 仍是 401，不受 413 逻辑影响', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  const body = JSON.stringify({ created_at: '2026-10-31T00:00:00.000Z', action: 'opened' });

  const wrong = await worker.fetch(
    webhookRequest(body, { delivery: 'wrong-sig', signature: sign(body, 'not-the-secret') }),
    env,
  );
  assert.equal(wrong.status, 401);

  const missing = await worker.fetch(
    new Request('https://example.invalid/webhook', {
      method: 'POST',
      headers: { 'content-length': String(body.length), 'x-github-delivery': 'missing-sig' },
      body,
    }),
    env,
  );
  assert.equal(missing.status, 401);

  const noSecret = await worker.fetch(webhookRequest(body, { delivery: 'no-secret' }), { PULL_TOKEN: TOKEN });
  assert.equal(noSecret.status, 401);

  // 超限时 413 先于验签：签名是错的也回 413，且响应里没有请求内容和 secret。
  const big = `${body}${'x'.repeat(WEBHOOK_BODY_LIMIT)}`;
  const oversized = await worker.fetch(
    webhookRequest(big, { delivery: 'too-large-bad-sig', signature: 'sha256=deadbeef' }),
    env,
  );
  assert.equal(oversized.status, 413);
  const text = await oversized.text();
  assert.doesNotMatch(text, new RegExp(SECRET));
  assert.doesNotMatch(text, /sha256=deadbeef/);

  assert.deepEqual(await pullIds(worker, env), []);
});

test('W4-e SC1 /ack、/fail 超限 413 且不动队列；令牌不对时仍是 401', async () => {
  const worker = createEventWorker();
  const env = workerEnv();
  await postWebhook(worker, env, smallPayload(), 'keep-me');

  const bigJson = JSON.stringify({ ids: ['a'.repeat(ACK_BODY_LIMIT)] });
  const ackTooLarge = await worker.fetch(
    new Request('https://example.invalid/ack', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(bigJson)),
      },
      body: bigJson,
    }),
    env,
  );
  assert.equal(ackTooLarge.status, 413);

  // 没有 content-length 的 chunked 超限体同样 413。
  const { request: chunkedAck } = streamRequest('/ack', [repeatChunk(0x7b, ACK_BODY_LIMIT + 1024)], {
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  });
  const chunked = await worker.fetch(chunkedAck, env);
  assert.equal(chunked.status, 413);

  const failTooLarge = await worker.fetch(
    new Request('https://example.invalid/fail', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
        'content-length': String(FAIL_BODY_LIMIT + 1),
      },
      body: JSON.stringify({ id: 'keep-me', error: 'x'.repeat(FAIL_BODY_LIMIT) }),
    }),
    env,
  );
  assert.equal(failTooLarge.status, 413);

  // 413 没把队列清掉，也没记失败。
  assert.deepEqual(await pullIds(worker, env), ['keep-me']);

  // 授权在读 body 之前：令牌不对时即便 body 巨大也还是 401。
  const badToken = await worker.fetch(
    new Request('https://example.invalid/ack', {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-pull-token',
        'content-type': 'application/json',
        'content-length': String(ACK_BODY_LIMIT + 1),
      },
      body: '{"ids":[]}',
    }),
    env,
  );
  assert.equal(badToken.status, 401);

  const noToken = await worker.fetch(
    new Request('https://example.invalid/fail', { method: 'POST', body: '{"id":"keep-me"}' }),
    env,
  );
  assert.equal(noToken.status, 401);
});
