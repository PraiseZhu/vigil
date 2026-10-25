#!/usr/bin/env node
// 沙箱出网口（#47 SC11）：沙箱用 --unshare-net，自己的网络命名空间里只有 lo；
// 唯一的出网路是轮次目录里的这个 unix socket（和写闸 socket 一样挂进沙箱）。
// 它是一个只认 HTTP CONNECT 的代理：目标 host:port 必须在 host.json 的 egressAllow 里，
// 别的一律 403；不转发明文 HTTP；连接数、单连接时长都有上限；拒绝时写提醒（节流）。
// 宿主侧解析域名，解析到环回 / 未指定 / 链路本地地址的一律拒绝（白名单写错也连不回宿主本地服务）。
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendAlert, hostPaths } from './paths.mjs';

/** 上限：常量，不可配。 */
export const EGRESS_LIMITS = Object.freeze({
  /** 同时最多多少条隧道。 */
  maxConnections: 32,
  /** 单条隧道最长活多久（含 pi 的一次长流式回复）。 */
  maxConnectionMs: 30 * 60 * 1000,
  /** 请求头最长等多久、最多多少字节。 */
  headerTimeoutMs: 10000,
  maxHeaderBytes: 8192,
  /** 上游连接最长等多久。 */
  connectTimeoutMs: 15000,
});

/** 沙箱里那座桥监听的端口（沙箱自己的 lo 上，和宿主不是一个网络命名空间）。 */
export const EGRESS_BRIDGE_PORT = 3128;

const HOST_PORT = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*):([0-9]{1,5})$/;

function validPort(text) {
  const port = Number(text);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/**
 * host.json 的 egressAllow：形如 ["github.com:443", "<网关 host>:443"]。
 * 只认「小写主机名:端口」，不认通配、不认 URL、不认空串；写错直接抛错（fail-closed，不悄悄放宽也不悄悄全拒）。
 * 没配就是空名单：沙箱里一个外网都连不上。
 */
export function egressAllowFrom(hostConfig) {
  const raw = hostConfig?.egressAllow;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('host.json 的 egressAllow 必须是 "host:port" 字符串数组');
  const out = [];
  for (const entry of raw) {
    const text = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    const match = HOST_PORT.exec(text);
    if (!match || validPort(match[2]) == null) {
      throw new Error(`host.json 的 egressAllow 写法不对（要 "host:port"，不认通配和 URL）：${JSON.stringify(entry)}`);
    }
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** CONNECT 的目标：host:port（IPv6 写成 [addr]:port）。返回 {host, port, key} 或 null。 */
export function parseConnectTarget(text) {
  const value = String(text || '').trim().toLowerCase();
  let host;
  let portText;
  const v6 = /^\[([0-9a-f:.]+)\]:([0-9]{1,5})$/.exec(value);
  if (v6) {
    host = v6[1];
    portText = v6[2];
  } else {
    const at = value.lastIndexOf(':');
    if (at <= 0) return null;
    host = value.slice(0, at);
    portText = value.slice(at + 1);
    if (!/^[0-9]{1,5}$/.test(portText) || !/^[a-z0-9.-]+$/.test(host)) return null;
  }
  const port = validPort(portText);
  if (port == null) return null;
  return { host, port, key: `${v6 ? `[${host}]` : host}:${port}` };
}

/** 环回、未指定、链路本地（含云元数据 169.254.169.254）：哪怕白名单里写了，也不连。 */
export function isBlockedAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (/^fe[89ab]/.test(lower)) return true;
    const mapped = /^::ffff:([0-9.]+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    return false;
  }
  return true;
}

/**
 * 拒绝提醒的节流：同一个目标一轮只记一次，一轮最多记 maxTotal 条；之后只计数。
 * report 由调用方给（一般是 appendAlert 写 kind=egress-denied）。
 */
export function throttledDenied(report, { maxTotal = 5 } = {}) {
  const seen = new Set();
  let written = 0;
  let suppressed = 0;
  const fn = (info) => {
    const key = `${info.reason}|${info.target}`;
    if (seen.has(key) || written >= maxTotal) {
      suppressed += 1;
      return;
    }
    seen.add(key);
    written += 1;
    try {
      report(info);
    } catch {
      // 提醒写不进去不影响代理本身。
    }
  };
  fn.stats = () => ({ written, suppressed });
  return fn;
}

function reply(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

function defaultLookup(host) {
  return new Promise((resolve, reject) => {
    dns.lookup(host, { all: false }, (error, address) => (error ? reject(error) : resolve(address)));
  });
}

/**
 * 起代理：监听 socketPath（权限 600）。返回 {socketPath, stop(), active()}。
 * - allow：egressAllowFrom 的结果（"host:port" 小写）。
 * - onDenied({target, reason})：每次拒绝都调；调用方自己节流（throttledDenied）。
 * - blockedAddress / lookup / limits：测试注入用；round.mjs 和 prbot-sandbox.mjs 用默认值，host.json 改不了。
 */
export async function startEgressProxy({
  socketPath,
  allow = [],
  onDenied = () => {},
  limits = EGRESS_LIMITS,
  blockedAddress = isBlockedAddress,
  lookup = defaultLookup,
} = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) throw new Error('出网代理需要绝对路径的 socket');
  const allowSet = new Set((allow || []).map((item) => String(item).toLowerCase()));
  const sockets = new Set();
  const clients = new Set();
  let closing = false;

  const deny = (socket, status, text, target, reason) => {
    try {
      onDenied({ target, reason });
    } catch {
      // 提醒失败不影响拒绝。
    }
    reply(socket, status, text);
  };

  function tunnel(client, target, rest) {
    let upstream = null;
    let established = false;
    const lifetime = setTimeout(() => {
      client.destroy();
      upstream?.destroy();
    }, limits.maxConnectionMs);
    lifetime.unref?.();
    const done = () => {
      clearTimeout(lifetime);
      client.destroy();
      upstream?.destroy();
    };
    client.on('close', done);
    client.on('error', done);
    lookup(target.host)
      .then((address) => {
        if (client.destroyed) return;
        if (blockedAddress(address)) {
          clearTimeout(lifetime);
          deny(client, 403, 'Forbidden', target.key, 'blocked-address');
          return;
        }
        upstream = net.connect({ host: address, port: target.port });
        sockets.add(upstream);
        const connectTimer = setTimeout(() => upstream.destroy(new Error('connect timeout')), limits.connectTimeoutMs);
        connectTimer.unref?.();
        upstream.once('connect', () => {
          clearTimeout(connectTimer);
          established = true;
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (rest.length) upstream.write(rest);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => {
          clearTimeout(connectTimer);
          if (!established) reply(client, 502, 'Bad Gateway');
          else client.destroy();
        });
        upstream.on('close', () => {
          sockets.delete(upstream);
          if (established) client.end();
        });
      })
      .catch(() => {
        clearTimeout(lifetime);
        reply(client, 502, 'Bad Gateway');
      });
  }

  const server = net.createServer((client) => {
    sockets.add(client);
    clients.add(client);
    client.on('close', () => {
      sockets.delete(client);
      clients.delete(client);
    });
    client.on('error', () => client.destroy());
    if (closing) {
      client.destroy();
      return;
    }
    if (clients.size > limits.maxConnections) {
      deny(client, 503, 'Too Many Connections', '-', 'too-many-connections');
      return;
    }
    let buffer = Buffer.alloc(0);
    const headerTimer = setTimeout(() => client.destroy(), limits.headerTimeoutMs);
    headerTimer.unref?.();
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (buffer.length > limits.maxHeaderBytes) {
          clearTimeout(headerTimer);
          client.off('data', onData);
          deny(client, 431, 'Request Header Fields Too Large', '-', 'header-too-large');
        }
        return;
      }
      clearTimeout(headerTimer);
      client.off('data', onData);
      const head = buffer.subarray(0, end).toString('latin1');
      const rest = buffer.subarray(end + 4);
      const [method = '', rawTarget = '', version = ''] = head.split('\r\n')[0].split(' ');
      if (method !== 'CONNECT' || !/^HTTP\/1\.[01]$/.test(version)) {
        // 明文 HTTP 转发一律不做：只记方法，不记 URL（URL 里可能带查询参数）。
        deny(client, 405, 'Method Not Allowed', method.slice(0, 16) || '-', 'not-connect');
        return;
      }
      const target = parseConnectTarget(rawTarget);
      if (!target) {
        deny(client, 400, 'Bad Request', rawTarget.slice(0, 128) || '-', 'bad-target');
        return;
      }
      if (!allowSet.has(target.key)) {
        deny(client, 403, 'Forbidden', target.key, 'not-allowed');
        return;
      }
      tunnel(client, target, rest);
    };
    client.on('data', onData);
  });

  fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  fs.rmSync(socketPath, { force: true });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath, 0o600);

  return {
    socketPath,
    active: () => clients.size,
    async stop() {
      closing = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
      fs.rmSync(socketPath, { force: true });
    },
  };
}

/** 沙箱里那座桥（宿主上的绝对路径；代码仓在沙箱里只读挂着，同一路径）。 */
export const EGRESS_BRIDGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox-bin', 'egress-bridge.mjs');

/** 出网代理的 socket 放在轮次目录里（和写闸 socket 一样，跟着 roundDir 挂进沙箱）。 */
export function egressSocketPath(roundDir) {
  if (typeof roundDir !== 'string' || !path.isAbsolute(roundDir)) throw new Error('egressSocketPath 需要绝对路径的 roundDir');
  return path.join(roundDir, 'egress', 'egress.sock');
}

/** 沙箱里命令的前缀：先起桥，桥听上端口后再起真正的命令（piCommand 原样接在后面）。 */
export function bridgeCommand({ socketPath, port = EGRESS_BRIDGE_PORT, execPath = process.execPath } = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath)) throw new Error('bridgeCommand 需要绝对路径的 socket');
  return [execPath, EGRESS_BRIDGE, '--socket', socketPath, '--port', String(port), '--'];
}

/**
 * 一轮的出网代理：名单来自 host.json 的 egressAllow，拒绝时写 kind=egress-denied 的提醒（节流：同目标一轮一条，最多 5 条）。
 * 验收轮（host/round.mjs）和修正轮的 pi（host/prbot-sandbox.mjs）都从这里起；预检不起（预检沙箱不出网）。
 */
export async function startRoundEgress({ home, hostConfig, roundDir, issue, round, profile, now = () => Date.now() } = {}) {
  const paths = hostPaths(home);
  const allow = egressAllowFrom(hostConfig);
  const onDenied = throttledDenied((info) =>
    appendAlert(paths, {
      kind: 'egress-denied',
      issue,
      round,
      reason: `沙箱出网被拒：${info.target}`,
      detail: info.reason,
      now,
      profile,
    }),
  );
  const proxy = await startEgressProxy({ socketPath: egressSocketPath(roundDir), allow, onDenied });
  return { ...proxy, allow, deniedStats: onDenied.stats };
}
