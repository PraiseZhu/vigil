// Cloudflare Worker 入口：收 GitHub webhook，校验 X-Hub-Signature-256，按 delivery id 去重后入队。
// 只读 env.WEBHOOK_SECRET（签名）和 env.PULL_TOKEN（拉取）。不读 GitHub 令牌，也不出站。
// 队列和去重表只通过 storage（get / put / delete / list / transaction，对齐 Durable Object storage）读写。
// 每条事件一个键 q:<seq>，每条去重记录一个键 s:<deliveryId>，用 list({prefix}) 读。两种后端都能用。
// 单个值默认不超过 128 KiB。再大的 payload 只留元数据（delivery id、事件类型、仓库、编号），
// 存储若直接拒绝写入，也同样改存元数据。拉取端再按需去取正文。
// 队列最多 1000 条。超过就拒绝新事件并记一条告警，不丢掉最旧的。
// 失败次数记在事件上。同一条失败 5 次后，拉取端确认（POST /ack）才移出队列。
// EventChannelDurableObject 用一份持久存储；两个 Worker 实例共用它时，webhook 和 /pull 才不会各看各的内存。
// /pull 只读队列。本文件不部署；默认导出的 fetch 就是以后挂到 Worker 上的处理函数。不要在这里加部署配置。

export const SEEN_LIMIT = 4096;
export const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const QUEUE_LIMIT = 1000;
export const FAILURE_LIMIT = 5;
export const MAX_VALUE_BYTES = 128 * 1024;

const SEQ_KEY = 'seq';
const ERROR_SUMMARY_LIMIT = 200;

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

function queueKey(seq) {
  return `q:${seq}`;
}

function seenKey(id) {
  return `s:${id}`;
}

function alertKey(id) {
  return `a:${id}`;
}

function byteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function repoOf(payload) {
  const repo = payload?.repository;
  if (!repo || typeof repo !== 'object') return null;
  if (typeof repo.full_name === 'string') return repo.full_name;
  if (typeof repo.owner?.login === 'string' && typeof repo.name === 'string') {
    return `${repo.owner.login}/${repo.name}`;
  }
  return null;
}

function numberOf(payload) {
  const candidates = [payload?.issue?.number, payload?.pull_request?.number, payload?.number];
  return candidates.find((value) => Number.isInteger(value)) ?? null;
}

function omitPayload(record) {
  const payload = record.payload;
  const next = { ...record, payloadOmitted: true };
  delete next.payload;
  if (!Object.hasOwn(record, 'repo')) next.repo = repoOf(payload);
  if (!Object.hasOwn(record, 'number')) next.number = numberOf(payload);
  return next;
}

function eventRecord(seq, deliveryId, eventName, payload) {
  return {
    seq,
    deliveryId,
    event: eventName,
    created_at: eventCreatedAt(payload),
    payload,
    failures: 0,
    lastError: null,
  };
}

function toPublicEvent(stored) {
  const event = {
    deliveryId: stored.deliveryId,
    event: stored.event,
    created_at: stored.created_at ?? null,
  };
  if (stored.payloadOmitted) {
    event.repo = stored.repo ?? null;
    event.number = stored.number ?? null;
    event.payloadOmitted = true;
    return event;
  }
  event.payload = stored.payload;
  return event;
}

async function listMap(txn, prefix) {
  const listed = await txn.list({ prefix });
  if (listed instanceof Map) return listed;
  return new Map(Object.entries(listed ?? {}));
}

async function readQueue(txn) {
  const listed = await listMap(txn, 'q:');
  return [...listed.values()].sort((left, right) => left.seq - right.seq);
}

async function readSeen(txn) {
  const seen = {};
  for (const [key, row] of await listMap(txn, 's:')) seen[key.slice(2)] = row;
  return seen;
}

async function readAlerts(txn) {
  const listed = [...(await listMap(txn, 'a:')).entries()];
  listed.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  return listed.map(([, value]) => (typeof value === 'string' ? value : String(value?.line ?? '')));
}

function pruneSeen(seen, nowMs, limit, ttlMs) {
  const cutoff = nowMs - ttlMs;
  const fresh = [];
  for (const [id, row] of Object.entries(seen)) {
    if (row && typeof row.at === 'number' && row.at >= cutoff && typeof row.seq === 'number') fresh.push([id, row]);
  }
  fresh.sort((left, right) => left[1].seq - right[1].seq);
  const keptEntries = fresh.length > limit ? fresh.slice(fresh.length - limit) : fresh;
  const keptIds = new Set(keptEntries.map(([id]) => id));
  const kept = {};
  for (const [id, row] of keptEntries) kept[id] = row;
  const dropped = Object.keys(seen).filter((id) => !keptIds.has(id));
  return { kept, dropped };
}

async function dropSeen(txn, ids) {
  for (const id of ids) await txn.delete(seenKey(id));
}

async function putQueueEvent(txn, record, maxValueBytes) {
  let stored = record.payload !== undefined && byteLength(record) > maxValueBytes ? omitPayload(record) : record;
  try {
    await txn.put(queueKey(stored.seq), stored);
  } catch (err) {
    if (stored.payload === undefined) throw err;
    await txn.put(queueKey(stored.seq), omitPayload(stored));
  }
}

async function handleRequest(request, env, durable) {
  const url = new URL(request.url);
  const storage = durable.storage;
  if (request.method === 'GET' && url.pathname === '/pull') {
    if (!(await pullAuthorized(request, env.PULL_TOKEN))) return unauthorized();
    let events = [];
    let alerts = [];
    await storage.transaction(async (txn) => {
      events = (await readQueue(txn)).map(toPublicEvent);
      alerts = await readAlerts(txn);
    });
    return Response.json({ events, alerts });
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
      for (const event of await readQueue(txn)) {
        if (drop.has(event.deliveryId)) await txn.delete(queueKey(event.seq));
      }
    });
    return new Response(null, { status: 204 });
  }
  if (request.method === 'POST' && url.pathname === '/fail') {
    if (!(await pullAuthorized(request, env.PULL_TOKEN))) return unauthorized();
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('bad json', { status: 400 });
    }
    if (!body || typeof body.id !== 'string' || !body.id) return new Response('bad fail', { status: 400 });
    const error = String(body.error ?? '').slice(0, ERROR_SUMMARY_LIMIT);
    const failureLimit = durable.failureLimit;
    let result = null;
    await storage.transaction(async (txn) => {
      const event = (await readQueue(txn)).find((item) => item.deliveryId === body.id);
      if (!event) return;
      const next = { ...event, failures: (event.failures || 0) + 1, lastError: error };
      await putQueueEvent(txn, next, durable.maxValueBytes);
      result = { failures: next.failures, abandoned: next.failures >= failureLimit, error };
    });
    if (!result) return new Response('not queued', { status: 404 });
    return Response.json(result);
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
  const maxValueBytes = durable.maxValueBytes;
  const queueLimit = durable.queueLimit;
  let badJson = false;
  await storage.transaction(async (txn) => {
    const pruned = pruneSeen(await readSeen(txn), nowMs, limit, ttlMs);
    if (Object.hasOwn(pruned.kept, deliveryId)) {
      await dropSeen(txn, pruned.dropped);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      badJson = true;
      return;
    }
    const seq = ((await txn.get(SEQ_KEY)) ?? 0) + 1;
    const again = pruneSeen({ ...pruned.kept, [deliveryId]: { seq, at: nowMs } }, nowMs, limit, ttlMs);
    await dropSeen(txn, pruned.dropped);
    await dropSeen(txn, again.dropped);
    if (Object.hasOwn(again.kept, deliveryId)) await txn.put(seenKey(deliveryId), again.kept[deliveryId]);
    await txn.put(SEQ_KEY, seq);
    if (!Object.hasOwn(again.kept, deliveryId)) return;
    if ((await readQueue(txn)).length >= queueLimit) {
      await txn.put(alertKey(deliveryId), `告警 队列已满 ${queueLimit}，拒绝新事件 ${deliveryId}`);
      return;
    }
    await putQueueEvent(txn, eventRecord(seq, deliveryId, eventName, payload), maxValueBytes);
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
    this.maxValueBytes = ctx.maxValueBytes ?? MAX_VALUE_BYTES;
    this.queueLimit = ctx.queueLimit ?? QUEUE_LIMIT;
    this.failureLimit = ctx.failureLimit ?? FAILURE_LIMIT;
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
    maxValueBytes: options.maxValueBytes,
    queueLimit: options.queueLimit,
    failureLimit: options.failureLimit,
  });
  return {
    async fetch(request, env) {
      return durable.fetch(request, env);
    },
  };
}

export default createEventWorker();
