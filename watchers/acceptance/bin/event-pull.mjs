// 本机拉取端：每 2 秒向 Worker 拉一次队列。队列要等本机确认后 Worker 才删。
// 拉取抛错视为 Worker 不可用：不抛出循环，改走 60 秒轮询，把漏掉的事件补回来。恢复后回到 2 秒。
// onEvent 抛错不算 Worker 挂了：同批其余事件照常处理，下一拍仍按 2 秒拉。
// 失败次数记在 Worker 上。同一条达到上限后确认移出，并在延迟记录里追加一行「放弃」。
// 事件若只有元数据，调用方用 loadPayload 按需去取正文。这里不读令牌，也不自己发 GitHub 请求。
// 没有 loadPayload 时不算处理成功：记一次失败，不交给 onEvent。满 5 次后确认移出，延迟记录写「正文被省略」。
// loadPayload 抛错同样记一次失败。
// 每处理完一个事件，往状态目录的 latency.jsonl 追加一行，记三段：Worker 收到（receivedAt，
// 由 Worker 写进队列记录）、本机拉到（pulledAt）、本机写完（processedAt，也就是 writtenAt）。
// latencyMs 仍是「事件发生 → 写完」；另记 gatewayMs = 写完 − Worker 收到，这才是 Worker 之后的本机耗时。
// receivedAt 缺失或不是可解析的时间时 gatewayMs 记 null，不抛错，也不影响 latencyMs。
// 目标：Worker 路径 p95 ≤ 10 秒，兜底轮询 ≤ 90 秒（60 秒一轮，留处理余量）。
// 轮询函数由调用方注入（现有 60 秒轮询留在外面，这里不替换它）。不读令牌。
// latencyFile 默认是绝对路径（~ 下的状态目录，和 prio-sync 的 stateFiles().latency 同一个位置）；
// 以前默认是相对 cwd 的 .prio/latency.jsonl，从 cron 拉起时会把文件写到进程自己的 cwd 下。
// 显式传入相对路径直接报错，不当成相对 cwd。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PULL_INTERVAL_MS = 2000;
export const POLL_INTERVAL_MS = 60 * 1000;

/** 延迟文件默认位置。和 prio-sync.mjs 的 stateFiles().latency 是同一个路径，绝对路径，不随 cwd 变。 */
export function defaultLatencyFile(homeDir = os.homedir()) {
  return path.join(homeDir, 'acceptance', 'tools', '.prio', 'latency.jsonl');
}

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

/** 告诉 Worker 这条事件处理失败了一次。返回值里的 failures / abandoned 以 Worker 上的计数为准。 */
export async function reportEventFailure({ url, token, id, error, fetchImpl = fetch } = {}) {
  const fail = new URL(url);
  fail.pathname = '/fail';
  fail.search = '';
  const response = await fetchImpl(fail.href, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ id, error: String(error ?? '').slice(0, 200) }),
  });
  if (!response.ok) throw new Error(`worker status ${response.status}`);
  return response.json();
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

/** 追加一行延迟记录。单次 write 写到 O_APPEND 描述符上；导出给测试用：两个进程同时追加不能出现半行。 */
export function appendLatencyRow(file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(row)}\n`;
  // 以 O_APPEND 打开后一次性写完这一行。两个进程同时追加时，追加位置由内核定，行不会被切开。
  // mode 只在新建文件时生效：第一次创建就是 0600。
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, line);
  } finally {
    fs.closeSync(fd);
  }
}

/** 事件所属仓、编号、动作。只写进本机延迟文件（方便按 PR 对号），取不到记 null。 */
function eventRepo(event) {
  if (typeof event?.repo === 'string' && event.repo) return event.repo;
  const fullName = event?.payload?.repository?.full_name;
  return typeof fullName === 'string' ? fullName : null;
}

function eventNumber(event) {
  if (Number.isInteger(event?.number)) return event.number;
  const payload = event?.payload;
  const candidates = [payload?.pull_request?.number, payload?.issue?.number, payload?.number];
  return candidates.find((value) => Number.isInteger(value)) ?? null;
}

function eventAction(event) {
  const action = event?.payload?.action;
  return typeof action === 'string' ? action : null;
}

function appendLatency(file, event, { processedAtMs, pulledAtMs, source }) {
  const createdAt = event.created_at || event.createdAt || null;
  const delta = typeof createdAt === 'string' ? processedAtMs - Date.parse(createdAt) : null;
  // receivedAt 由 Worker 写。缺失、不是字符串、或解析不出时间时，gatewayMs 记 null，不抛错。
  const receivedAt = typeof event.receivedAt === 'string' ? event.receivedAt : null;
  const receivedMs = receivedAt == null ? Number.NaN : Date.parse(receivedAt);
  const receivedOk = Number.isFinite(receivedMs);
  appendLatencyRow(file, {
    deliveryId: event.deliveryId,
    createdAt,
    receivedAt: receivedOk ? receivedAt : null,
    pulledAt: new Date(pulledAtMs).toISOString(),
    processedAt: new Date(processedAtMs).toISOString(),
    latencyMs: Number.isFinite(delta) ? delta : null,
    gatewayMs: receivedOk ? processedAtMs - receivedMs : null,
    source,
    repo: eventRepo(event),
    number: eventNumber(event),
    action: eventAction(event),
  });
}

function errorSummary(err) {
  const text = err instanceof Error ? err.message : String(err ?? '');
  return text.slice(0, 200);
}

/**
 * 拉到 `until`（now() >= until 就停）或 signal abort 为止。
 * sleep / now 可注入：测试里 sleep 只把假时钟往前拨。
 * pull 抛错视为 Worker 不可用：这一拍不再按 2 秒打，下一拍轮询到点时再试一次。
 * onEvent 抛错不算不可用：这条不确认，同批剩下的照常处理，下一拍仍按 2 秒拉。
 * 传了 reportFailure 时，把这次失败记到 Worker。返回 abandoned 后改成确认移出，
 * 并在延迟记录里追加一行 outcome 为「放弃」。没传时，失败仍不确认。
 * payloadOmitted 的事件先交给 loadPayload，由调用方按需取回正文，再交给 onEvent。
 * 没有 loadPayload 时抛出「正文被省略」，走失败计数，不交给 onEvent。loadPayload 抛错同样算失败。
 * confirm 在处理成功（或放弃）之后调用，Worker 才清掉对应事件。
 * 每处理完一个事件追加一行延迟记录：receivedAt（Worker 收到）、pulledAt（本批拉到的时刻）、
 * processedAt（写完的时刻）、latencyMs、gatewayMs。
 */
export async function runEventChannel({
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  until = null,
  signal,
  pull,
  poll,
  confirm,
  reportFailure,
  loadPayload,
  onEvent = async () => {},
  latencyFile = defaultLatencyFile(),
  pullIntervalMs = PULL_INTERVAL_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
} = {}) {
  if (latencyFile && !path.isAbsolute(latencyFile)) {
    throw new Error(`latencyFile 必须是绝对路径：${latencyFile}`);
  }
  const seen = new Set();
  let workerUp = true;
  let nextPullAt = now();
  let nextPollAt = now();

  function appendAbandon(file, event, result, err, source) {
    appendLatencyRow(file, {
      deliveryId: event?.deliveryId ?? null,
      event: event?.event ?? null,
      failures: result?.failures ?? null,
      error: result?.error || errorSummary(err),
      outcome: '放弃',
      processedAt: new Date(now()).toISOString(),
      source,
    });
  }

  async function handle(event, source, pulledAtMs) {
    const id = event?.deliveryId;
    if (!id) return false;
    if (seen.has(id)) return true;
    let current = event;
    if (current.payloadOmitted) {
      if (typeof loadPayload !== 'function') throw new Error('正文被省略');
      const payload = await loadPayload(current);
      current = { ...current, payload };
    }
    await onEvent(current, { source });
    seen.add(id);
    if (latencyFile) appendLatency(latencyFile, current, { processedAtMs: now(), pulledAtMs, source });
    return true;
  }

  async function acceptBatch(events, source, { confirmEvents = false } = {}) {
    // 这一批拿到的时间。同一拍里多条事件共用它，处理耗时只进 processedAt。
    const pulledAtMs = now();
    const confirmed = [];
    for (const event of events || []) {
      try {
        if (await handle(event, source, pulledAtMs)) confirmed.push(event.deliveryId);
      } catch (err) {
        // 处理出错：这条先不确认，同批剩下的照常处理。不要记成 Worker 挂了。
        if (typeof reportFailure !== 'function') continue;
        try {
          const result = await reportFailure(event, err);
          if (result?.abandoned) {
            confirmed.push(event.deliveryId);
            if (latencyFile) appendAbandon(latencyFile, event, result, err, source);
          }
        } catch {
          // 上报失败也留在队列里，下一拍再试。
        }
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
