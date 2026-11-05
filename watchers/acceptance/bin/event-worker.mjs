// Cloudflare Worker 入口：收 GitHub webhook，校验 X-Hub-Signature-256，按 delivery id 去重后入队。
// 只读 env.WEBHOOK_SECRET（签名）和 env.PULL_TOKEN（拉取）。不读 GitHub 令牌，也不出站。
// 队列和去重表只通过 storage（get / put / delete / list / transaction，对齐 Durable Object storage）读写。
// 每条事件一个键 q:<seq>，每条去重记录一个键 s:<deliveryId>。两种后端都能用。
// 去重只读这一个 s: 键。队列长度用 queueCount，入队加一，确认减一。
// 去重条数用 seenCount。只有超过上限时才 list s:，删掉过期的和最旧的。
// /pull、/ack、/fail 仍按前缀 list 队列。
// 每条事件另存 receivedAt（Worker 收到这条 webhook 的时间，ISO 字符串），/pull 时原样带出，
// 本机拿它算 gatewayMs（Worker 收到 → 本机写完）。正文被省略、只留元数据时也照样带。
// 三条读 body 的路由都有字节上限（WEBHOOK_BODY_LIMIT / ACK_BODY_LIMIT / FAIL_BODY_LIMIT）：先看 content-length
// 快速拒绝，没有该头或声明偏小时在读的过程中累计，超限一律 413 且不回显 body；/webhook 的 413 在验签之前返回。
// 单个值默认不超过 128 KiB。再大的 payload 只留元数据（delivery id、事件类型、仓库、编号），
// 存储若直接拒绝写入，也同样改存元数据。拉取端再按需去取正文。
// 队列最多 1000 条。超过就拒绝新事件并记一条告警，不丢掉最旧的。告警键 a:<deliveryId>，只留最近 50 条。
// 失败次数记在事件上。同一条失败 5 次后，拉取端确认（POST /ack）才移出队列。
// EventChannelDurableObject 用一份持久存储；两个 Worker 实例共用它时，webhook 和 /pull 才不会各看各的内存。
// /pull 只读队列。本文件不直接部署：部署入口和 wrangler 配置在 worker/，那边把请求转给唯一一个 DO 实例。
// 默认导出的 fetch 是内存版，只给测试和本地用，别当成线上入口。部署配置也放 worker/，不要加在这里。
// SQLite 版 DO 的 transaction 回调已不给 txn（官方文档说该对象废弃），所以四处事务都走 runInTransaction：
// 回调拿不到 txn 就用 storage 本身，与旧 txn 的语义一样。

export const SEEN_LIMIT = 4096;
export const SEEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const QUEUE_LIMIT = 1000;
export const FAILURE_LIMIT = 5;
export const MAX_VALUE_BYTES = 128 * 1024;
export const ALERT_LIMIT = 50;

// 请求体上限（字节）。三条路由都在读 body 之前先看 content-length，读的过程中再按累计字节数兜底。
// /webhook：Worker 对 payload 只做三件事——验签、按 delivery id 去重、入队，入队时把整条事件写进一个
// 存储值；单值超过 MAX_VALUE_BYTES（128 KiB）就只留 delivery id、事件名、仓库、编号（见 omitPayload）。
// 也就是说这条通道永远存不下超过 128 KiB 的 payload，收更大的 body 只换来一次 JSON.parse。
// 上限取 128 KiB 的 4 倍 = 512 KiB：足够收下任何“能被完整存储”的事件，又远小于 GitHub 给的 25 MB
// 载荷上限，不必为一条注定被截成元数据的事件付读、解析和存储成本。
// 真实 PR 事件是否常超 512 KiB：未测（没有线上流量采样）；即使超了，产物也只是元数据，不会丢事件。
export const WEBHOOK_BODY_LIMIT = 512 * 1024;
// /ack：一次最多确认整个队列（QUEUE_LIMIT = 1000 条），一条 delivery id 是 36 字节的 UUID 形态，
// JSON 数组约 40 KiB，取 64 KiB 留余量。
export const ACK_BODY_LIMIT = 64 * 1024;
// /fail：只有一条 delivery id 和截到 200 字符的错误摘要，8 KiB 足够。
export const FAIL_BODY_LIMIT = 8 * 1024;

const SEQ_KEY = 'seq';
const QUEUE_COUNT_KEY = 'queueCount';
const SEEN_COUNT_KEY = 'seenCount';
const ALERT_SEQ_KEY = 'alertSeq';
const ALERT_COUNT_KEY = 'alertCount';
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

// 413 只带上限数字：不回显 body、不提签名或密钥，避免把请求内容变成回读通道。
function payloadTooLarge(limit) {
  return new Response(`payload too large (limit ${limit} bytes)`, { status: 413 });
}

/** content-length 头里可信的声明长度；缺失或不是纯数字（含负数、科学计数法）时返回 null。 */
function declaredLength(request) {
  const raw = request.headers.get('content-length');
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
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

function eventRecord(seq, deliveryId, eventName, payload, nowMs) {
  return {
    seq,
    deliveryId,
    event: eventName,
    created_at: eventCreatedAt(payload),
    receivedAt: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
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
    receivedAt: stored.receivedAt ?? null,
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

/**
 * 事务。SQLite 版 Durable Object 的 storage.transaction 回调不再给 txn 参数（该对象废弃），
 * 拿不到 txn 时直接用 storage —— 在 SQLite 后端，事务里的 ctx.storage 就是那个入口。
 */
export async function runInTransaction(storage, fn) {
  return storage.transaction(async (txn) => fn(txn ?? storage));
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

function alertSeq(value) {
  return value && typeof value === 'object' && Number.isFinite(value.seq) ? value.seq : 0;
}

function alertLine(value) {
  return typeof value === 'string' ? value : String(value?.line ?? '');
}

async function readAlerts(txn) {
  const listed = [...(await listMap(txn, 'a:')).entries()];
  listed.sort((left, right) => alertSeq(left[1]) - alertSeq(right[1]) || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  const capped = listed.length > ALERT_LIMIT ? listed.slice(listed.length - ALERT_LIMIT) : listed;
  return capped.map(([, value]) => alertLine(value));
}

async function putAlert(txn, deliveryId, line) {
  const key = alertKey(deliveryId);
  const prev = await txn.get(key);
  const seq = ((await txn.get(ALERT_SEQ_KEY)) ?? 0) + 1;
  await txn.put(ALERT_SEQ_KEY, seq);
  await txn.put(key, { seq, line });
  let count = ((await txn.get(ALERT_COUNT_KEY)) ?? 0) + (prev == null ? 1 : 0);
  if (count > ALERT_LIMIT) {
    const listed = [...(await listMap(txn, 'a:')).entries()];
    listed.sort((left, right) => alertSeq(left[1]) - alertSeq(right[1]) || (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    while (listed.length > ALERT_LIMIT) {
      const [oldKey] = listed.shift();
      await txn.delete(oldKey);
    }
    count = listed.length;
  }
  await txn.put(ALERT_COUNT_KEY, count);
}

function seenFresh(row, nowMs, ttlMs) {
  if (!row || typeof row.at !== 'number' || typeof row.seq !== 'number') return false;
  return row.at >= nowMs - ttlMs;
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

/**
 * 读请求体，累计字节数超过 limit 就立刻停：不把整段读完再判断，也不信任 content-length 声明。
 * 有 content-length 且已超限时连流都不打开（快速拒绝）。没有 content-length（chunked）时靠读的过程中累计。
 * 返回 { tooLarge: true } 或 { tooLarge: false, text }；解码方式与 request.text() 一致（UTF-8，去 BOM）。
 */
async function readBodyLimited(request, limit) {
  const declared = declaredLength(request);
  if (declared != null && declared > limit) return { tooLarge: true };
  if (!request.body) return { tooLarge: false, text: '' };
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { tooLarge: true };
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 已经 cancel 或流已关闭时 releaseLock 可能抛，这里不影响判定结果。
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, text: new TextDecoder().decode(merged) };
}

async function handleRequest(request, env, durable) {
  const url = new URL(request.url);
  const storage = durable.storage;
  if (request.method === 'GET' && url.pathname === '/pull') {
    if (!(await pullAuthorized(request, env.PULL_TOKEN))) return unauthorized();
    let events = [];
    let alerts = [];
    await runInTransaction(storage, async (txn) => {
      events = (await readQueue(txn)).map(toPublicEvent);
      alerts = await readAlerts(txn);
    });
    return Response.json({ events, alerts });
  }
  if (request.method === 'POST' && url.pathname === '/ack') {
    // 授权只看头，不读 body：令牌不对就 401，不因为 body 大小改变判定顺序。
    if (!(await pullAuthorized(request, env.PULL_TOKEN))) return unauthorized();
    const read = await readBodyLimited(request, ACK_BODY_LIMIT);
    if (read.tooLarge) return payloadTooLarge(ACK_BODY_LIMIT);
    let body;
    try {
      body = JSON.parse(read.text);
    } catch {
      return new Response('bad json', { status: 400 });
    }
    if (!body || !Array.isArray(body.ids)) return new Response('bad ack', { status: 400 });
    const drop = new Set(body.ids.filter((id) => typeof id === 'string'));
    await runInTransaction(storage, async (txn) => {
      let removed = 0;
      for (const event of await readQueue(txn)) {
        if (!drop.has(event.deliveryId)) continue;
        await txn.delete(queueKey(event.seq));
        removed += 1;
      }
      if (removed > 0) {
        const queueCount = (await txn.get(QUEUE_COUNT_KEY)) ?? 0;
        await txn.put(QUEUE_COUNT_KEY, Math.max(0, queueCount - removed));
      }
    });
    return new Response(null, { status: 204 });
  }
  if (request.method === 'POST' && url.pathname === '/fail') {
    if (!(await pullAuthorized(request, env.PULL_TOKEN))) return unauthorized();
    const read = await readBodyLimited(request, FAIL_BODY_LIMIT);
    if (read.tooLarge) return payloadTooLarge(FAIL_BODY_LIMIT);
    let body;
    try {
      body = JSON.parse(read.text);
    } catch {
      return new Response('bad json', { status: 400 });
    }
    if (!body || typeof body.id !== 'string' || !body.id) return new Response('bad fail', { status: 400 });
    const error = String(body.error ?? '').slice(0, ERROR_SUMMARY_LIMIT);
    const failureLimit = durable.failureLimit;
    let result = null;
    await runInTransaction(storage, async (txn) => {
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
  // 413 在验签之前返回：超限的请求根本不进 HMAC，也就不存在拿超大 body 换签名计算量的路径。
  const read = await readBodyLimited(request, WEBHOOK_BODY_LIMIT);
  if (read.tooLarge) return payloadTooLarge(WEBHOOK_BODY_LIMIT);
  const body = read.text;
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
  await runInTransaction(storage, async (txn) => {
    const prior = await txn.get(seenKey(deliveryId));
    if (seenFresh(prior, nowMs, ttlMs)) return;
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      badJson = true;
      return;
    }
    const seq = ((await txn.get(SEQ_KEY)) ?? 0) + 1;
    await txn.put(SEQ_KEY, seq);
    await txn.put(seenKey(deliveryId), { seq, at: nowMs });
    let seenCount = ((await txn.get(SEEN_COUNT_KEY)) ?? 0) + (prior == null ? 1 : 0);
    if (seenCount > limit) {
      const pruned = pruneSeen(await readSeen(txn), nowMs, limit, ttlMs);
      await dropSeen(txn, pruned.dropped);
      seenCount = Object.keys(pruned.kept).length;
    }
    await txn.put(SEEN_COUNT_KEY, seenCount);
    if (!(await txn.get(seenKey(deliveryId)))) return;
    const queueCount = (await txn.get(QUEUE_COUNT_KEY)) ?? 0;
    if (queueCount >= queueLimit) {
      await putAlert(txn, deliveryId, `告警 队列已满 ${queueLimit}，拒绝新事件 ${deliveryId}`);
      return;
    }
    await putQueueEvent(txn, eventRecord(seq, deliveryId, eventName, payload, nowMs), maxValueBytes);
    await txn.put(QUEUE_COUNT_KEY, queueCount + 1);
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
