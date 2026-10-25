#!/usr/bin/env node
// 沙箱里的写操作出口（#47）：一条动作 JSON 从标准输入进来，经 unix socket 交给写闸，
// 把写闸回的结果 JSON 打到标准输出，退出码照抄写闸的（0 / 4 / 75 / 1）。
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseSocket(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--socket') return argv[i + 1];
    if (typeof argv[i] === 'string' && argv[i].startsWith('--socket=')) return argv[i].slice('--socket='.length);
  }
  return null;
}

function send(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let buffer = '';
    socket.on('connect', () => {
      socket.write(`${payload}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
    });
    socket.on('end', () => resolve(buffer));
    socket.on('error', reject);
  });
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main(argv) {
  const socketPath = parseSocket(argv);
  if (!socketPath) {
    process.stderr.write('用法：gate-client.mjs --socket <写闸 socket>（动作 JSON 从标准输入读）\n');
    process.exitCode = 1;
    return;
  }
  const action = await readStdin();
  let reply;
  try {
    reply = await send(socketPath, action.trim());
  } catch (error) {
    process.stderr.write(`连不上写闸：${error?.message || error}\n`);
    process.exitCode = 1;
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(reply || '{}');
  } catch {
    process.stderr.write('写闸回的不是 JSON\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${JSON.stringify(parsed.body ?? {})}\n`);
  process.exitCode = Number.isInteger(parsed.code) ? parsed.code : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
