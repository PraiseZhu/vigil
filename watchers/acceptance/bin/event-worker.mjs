// Cloudflare Worker 入口：收 GitHub webhook，校验 X-Hub-Signature-256，按 delivery id 去重后入队。
// 只读 env.WEBHOOK_SECRET（签名）和 env.PULL_TOKEN（拉取）。不读 GitHub 令牌，也不出站。
// 队列和去重表只通过 storage（get / put / transaction，对齐 Durable Object storage）读写。
// EventChannelDurableObject 用一份持久存储；两个 Worker 实例共用它时，webhook 和 /pull 才不会各看各的内存。
// /pull 只读队列。拉取端确认（POST /ack）之后才删掉对应事件。
// 本文件不部署；默认导出的 fetch 就是以后挂到 Worker 上的处理函数。不要在这里加部署配置。

export const SEEN_LIMIT = 4096;
export const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const QUEUE_KEY = 'queue';
const SEEN_KEY = 'seen';
const SEQ_KEY = 'seq';

function bytesToHex(buffer) {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return bytesToHex(mac);
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bytesToHex(digest);
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

/** 事件发生时间：优先 payload 自己的 created_at，否则取评论 / review / PR / issue 上最接近这次动作的时间。 */
function eventCreatedAt(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.created_at === 'string') return payload.created_at;
  const candidates = [
    payload.comment?.created_at,
    payload.review?.submitted_at,
    payload.pull_request?.updated_at,
    payload.issue?.updated_at,
    payload.pull_request?.created_at,
    payload.issue?.created_at,
  ];
  return candidates.find((value) => typeof value === 'string') || null;
}

async function signatureOk(body, header, secret) {
  if (typeof secret !== 'string' || !secret) return false;
  if (typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length).toLowerCase();
  const actual = await hmacSha256Hex(secret, body);
  return safeEqual(actual, provided);
}

function presentedPullToken(request) {
  const header = request.headers.get('authorization');
  if (typeof header !== 'string' || !header) return null;
  // Fetch 会把重复的 authorization 拼成一条，中间有逗号。这种多值头不能当成一个令牌。
  if (header.includes(',')) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

async function pullAuthorized(request, token) {
  if (typeof token !== 'string' || !token) return false;
  const presented = presentedPullToken(request);
  if (presented == null) return false;
  // 先哈希再比，长度不同也不会提前返回。
  const got = await sha256Hex(presented);
  const want = await sha256Hex(token);
  return safeEqual(got, want);
}

function unauthorized() {
  return new Response('unauthorized', { status: 401 });
}

export function createMemoryStorage() {
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
    async transaction(fn) {
      return fn(storage);
    },
  };
  return storage;
}

function pruneSeen(seen, nowMs, limit, ttlMs) {
  const cutoff = nowMs - ttlMs;
  const entries = Object.entries(seen).filter(([, row]) => {
    return row && typeof row.at === 'number' && row.at >= cutoff && typeof row.seq === 'number';
  });
  entries.sort((left, right) => left[1].seq - right[1].seq);
  const kept = entries.length > limit ? entries.slice(entries.length - limit) : entries;
  const next = {};
  for (const [id, row] of kept) next[id] = row;
  return next;
}

async function readState(txn) {
  return {
    queue: (await txn.get(QUEUE_KEY)) ?? [],
    seen: (await txn.get(SEEN_KEY)) ?? {},
    seq: (await txn.get(SEQ_KEY)) ?? 0,
  };
}

async function writeState(txn, state) {
  await txn.put(QUEUE_KEY, state.queue);
  await txn.put(SEEN_KEY, state.seen);
  await txn.put(SEQ_KEY, state.seq);
}

async function handleRequest(request, env, durable) {
  const url = new URL(request.url);
  const storage = durable.storage;
  if (request.method === 'GET' && url.pathname === '/pull') {
    if (!(await pullAuthorized(request, env.PULL_TOKEN))) return unauthorized();
    let events = [];
    await storage.transaction(async (txn) => {
      events = (await readState(txn)).queue;
    });
    return Response.json({ events });
  }
  if (request.method === 'POST' && url.pathname === '/ack') {
    if (!(await pullAuthorized(request, env.PULL_TOKEN))) return unauthorized();
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('bad json', { status: 400 });
    }
    if (!body || !Array.isArray(body.ids)) return new Response('bad ack', { status: 400 });
    const drop = new Set(body.ids.filter((id) => typeof id === 'string'));
    await storage.transaction(async (txn) => {
      const state = await readState(txn);
      await writeState(txn, {
        queue: state.queue.filter((event) => !drop.has(event.deliveryId)),
        seen: state.seen,
        seq: state.seq,
      });
    });
    return new Response(null, { status: 204 });
  }
  if (request.method !== 'POST' || url.pathname !== '/webhook') {
    return new Response('not found', { status: 404 });
  }
  const body = await request.text();
  const ok = await signatureOk(body, request.headers.get('x-hub-signature-256'), env.WEBHOOK_SECRET);
  if (!ok) return unauthorized();
  const deliveryId = request.headers.get('x-github-delivery');
  if (!deliveryId) return new Response('missing delivery', { status: 400 });
  const eventName = request.headers.get('x-github-event') || '';
  const nowMs = durable.now();
  const limit = durable.seenLimit;
  const ttlMs = durable.seenTtlMs;
  let badJson = false;
  await storage.transaction(async (txn) => {
    const state = await readState(txn);
    let seen = pruneSeen(state.seen, nowMs, limit, ttlMs);
    if (Object.hasOwn(seen, deliveryId)) {
      await writeState(txn, { queue: state.queue, seen, seq: state.seq });
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      badJson = true;
      return;
    }
    const seq = state.seq + 1;
    seen = pruneSeen({ ...seen, [deliveryId]: { seq, at: nowMs } }, nowMs, limit, ttlMs);
    await writeState(txn, {
      queue: state.queue.concat([{
        deliveryId,
        event: eventName,
        created_at: eventCreatedAt(payload),
        payload,
      }]),
      seen,
      seq,
    });
  });
  if (badJson) return new Response('bad json', { status: 400 });
  return new Response(null, { status: 204 });
}

export class EventChannelDurableObject {
  constructor(ctx, env = {}) {
    if (!ctx || !ctx.storage) throw new Error('EventChannelDurableObject requires storage');
    this.storage = ctx.storage;
    this.env = env;
    this.now = typeof ctx.now === 'function' ? ctx.now : () => Date.now();
    this.seenLimit = ctx.seenLimit ?? SEEN_LIMIT;
    this.seenTtlMs = ctx.seenTtlMs ?? SEEN_TTL_MS;
  }

  async fetch(request, env = this.env) {
    return handleRequest(request, env ?? {}, this);
  }
}

export function createEventWorker(options = {}) {
  const durable = new EventChannelDurableObject({
    storage: options.storage ?? createMemoryStorage(),
    now: options.now,
    seenLimit: options.seenLimit,
    seenTtlMs: options.seenTtlMs,
  });
  return {
    async fetch(request, env) {
      return durable.fetch(request, env);
    },
  };
}

export default createEventWorker();
