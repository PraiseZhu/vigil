// Cloudflare Worker 入口：收 GitHub webhook，校验 X-Hub-Signature-256，按 delivery id 去重后入队。
// 只读 env.WEBHOOK_SECRET（签名）和 env.PULL_TOKEN（拉取）。不读 GitHub 令牌，也不出站。
// 本文件不部署；默认导出的 fetch 就是以后挂到 Worker 上的处理函数。

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

async function pullAuthorized(request, token) {
  if (typeof token !== 'string' || !token) return false;
  const header = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return false;
  // 先哈希再比，长度不同也不会提前返回。
  const got = await sha256Hex(match[1]);
  const want = await sha256Hex(token);
  return safeEqual(got, want);
}

function unauthorized() {
  return new Response('unauthorized', { status: 401 });
}

export function createEventWorker() {
  const state = { queue: [], seen: new Set() };
  return {
    async fetch(request, env = {}) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/pull') {
        if (!(await pullAuthorized(request, env.PULL_TOKEN))) return unauthorized();
        const events = state.queue.splice(0, state.queue.length);
        return Response.json({ events });
      }
      if (request.method !== 'POST' || url.pathname !== '/webhook') {
        return new Response('not found', { status: 404 });
      }
      const body = await request.text();
      const ok = await signatureOk(body, request.headers.get('x-hub-signature-256'), env.WEBHOOK_SECRET);
      if (!ok) return unauthorized();
      const deliveryId = request.headers.get('x-github-delivery');
      if (!deliveryId) return new Response('missing delivery', { status: 400 });
      if (!state.seen.has(deliveryId)) {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return new Response('bad json', { status: 400 });
        }
        state.seen.add(deliveryId);
        state.queue.push({
          deliveryId,
          event: request.headers.get('x-github-event') || '',
          created_at: eventCreatedAt(payload),
          payload,
        });
      }
      return new Response(null, { status: 204 });
    },
  };
}

export default createEventWorker();
