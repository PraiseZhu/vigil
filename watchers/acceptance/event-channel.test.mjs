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
