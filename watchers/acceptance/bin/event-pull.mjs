// 本机拉取端：每 2 秒向 Worker 拉一次队列。队列要等本机确认后 Worker 才删。
// 拉取抛错视为 Worker 不可用：不抛出循环，改走 60 秒轮询，把漏掉的事件补回来。恢复后回到 2 秒。
// onEvent 抛错不算 Worker 挂了：同批其余事件照常处理，下一拍仍按 2 秒拉。
// 每处理完一个事件，把 created_at 到处理完成的时间差追加到 .prio/latency.jsonl。
// 目标：Worker 路径 p95 ≤ 10 秒，兜底轮询 ≤ 90 秒（60 秒一轮，留处理余量）。
// 轮询函数由调用方注入（现有 60 秒轮询留在外面，这里不替换它）。不读令牌。
import fs from 'node:fs';
import path from 'node:path';

export const PULL_INTERVAL_MS = 2000;
export const POLL_INTERVAL_MS = 60 * 1000;

export async function pullFromWorker({ url, token, fetchImpl = fetch }) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`worker status ${response.status}`);
  const body = await response.json();
  return Array.isArray(body?.events) ? body.events : [];
}

/** 拉取端确认已经拿到这些事件。Worker 收到后才把它们从队列删掉。 */
export async function confirmPulledEvents({ url, token, ids, fetchImpl = fetch } = {}) {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const ack = new URL(url);
  ack.pathname = '/ack';
  ack.search = '';
  const response = await fetchImpl(ack.href, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) throw new Error(`worker status ${response.status}`);
}

export function readLatencyLog(file) {
  if (!file || !fs.existsSync(file)) return [];
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // 坏行跳过，不让一条脏数据挡住百分位。
    }
  }
  return rows;
}

/** 最近秩：下标 = ceil(p * n) - 1。空数组的 p50 / p95 为 null。 */
export function latencyPercentiles(rows) {
  const values = (rows || [])
    .map((row) => Number(row?.latencyMs))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  if (!values.length) return { p50: null, p95: null, n: 0 };
  const at = (p) => values[Math.min(values.length - 1, Math.max(0, Math.ceil(p * values.length) - 1))];
  return { p50: at(0.5), p95: at(0.95), n: values.length };
}

function appendLatency(file, event, processedAtMs, source) {
  const createdAt = event.created_at || event.createdAt || null;
  const delta = typeof createdAt === 'string' ? processedAtMs - Date.parse(createdAt) : null;
  const row = {
    deliveryId: event.deliveryId,
    createdAt,
    processedAt: new Date(processedAtMs).toISOString(),
    latencyMs: Number.isFinite(delta) ? delta : null,
    source,
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
}

/**
 * 拉到 `until`（now() >= until 就停）或 signal abort 为止。
 * sleep / now 可注入：测试里 sleep 只把假时钟往前拨。
 * pull 抛错视为 Worker 不可用：这一拍不再按 2 秒打，下一拍轮询到点时再试一次。
 * onEvent 抛错不算不可用：这条不确认，同批剩下的照常处理，下一拍仍按 2 秒拉。
 * confirm 在处理成功之后调用，Worker 才清掉对应事件。
 */
export async function runEventChannel({
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  until = null,
  signal,
  pull,
  poll,
  confirm,
  onEvent = async () => {},
  latencyFile = path.join('.prio', 'latency.jsonl'),
  pullIntervalMs = PULL_INTERVAL_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  const seen = new Set();
  let workerUp = true;
  let nextPullAt = now();
  let nextPollAt = now();

  async function handle(event, source) {
    const id = event?.deliveryId;
    if (!id) return false;
    if (seen.has(id)) return true;
    await onEvent(event, { source });
    seen.add(id);
    if (latencyFile) appendLatency(latencyFile, event, now(), source);
    return true;
  }

  async function acceptBatch(events, source, { confirmEvents = false } = {}) {
    const confirmed = [];
    for (const event of events || []) {
      try {
        if (await handle(event, source)) confirmed.push(event.deliveryId);
      } catch {
        // 处理出错：这条不确认，同批剩下的照常处理。不要记成 Worker 挂了。
      }
    }
    if (confirmEvents && confirmed.length && typeof confirm === 'function') await confirm(confirmed);
  }

  const running = () => !signal?.aborted && (until == null || now() < until);

  while (running()) {
    const t = now();
    let failedThisTick = false;

    if (workerUp && t >= nextPullAt) {
      try {
        const events = await pull();
        nextPullAt = t + pullIntervalMs;
        await acceptBatch(events, 'worker', { confirmEvents: true });
      } catch {
        workerUp = false;
        failedThisTick = true;
      }
    }

    // 挂掉的那一拍已经试过了。下一拍轮询到点时再拉一次，通了就回到 2 秒。
    if (!workerUp && !failedThisTick && t >= nextPollAt) {
      try {
        const events = await pull();
        workerUp = true;
        nextPullAt = t + pullIntervalMs;
        await acceptBatch(events, 'worker', { confirmEvents: true });
      } catch {
        workerUp = false;
      }
    }

    if (t >= nextPollAt) {
      try {
        const events = await poll();
        await acceptBatch(events, 'poll');
      } catch {
        // 轮询失败也不让循环退出。
      }
      nextPollAt = t + pollIntervalMs;
    }

    if (!running()) break;
    const nextAt = workerUp ? Math.min(nextPullAt, nextPollAt) : nextPollAt;
    if (until != null && nextAt >= until) break;
    const wait = nextAt - now();
    if (wait > 0) await sleep(wait);
    else break;
  }
}
