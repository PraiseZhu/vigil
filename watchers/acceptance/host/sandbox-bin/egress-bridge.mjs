#!/usr/bin/env node
// 沙箱里的出网桥（#47 SC11）：沙箱是 --unshare-net，只有自己的 lo。
// 这座桥在沙箱的 127.0.0.1:<端口> 上听，把每条 TCP 流原样转进挂进来的 unix socket（宿主的出网代理），
// 自己不解析、不改写任何字节；放行与否全由宿主那边按 egressAllow 决定。
// 用法：egress-bridge.mjs --socket <unix socket> --port <端口> -- <命令…>
// 桥先听上端口，再起命令（stdio 原样继承），命令退出码照抄；收到 SIGTERM / SIGINT / SIGHUP 转给命令。
import net from 'node:net';
// 起子进程照宿主的规矩只走 proc.mjs（代码仓在沙箱里只读挂着，同一路径）。
import { spawnProcess } from '../proc.mjs';

function fail(message) {
  process.stderr.write(`egress-bridge：${message}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const split = argv.indexOf('--');
  const own = split === -1 ? argv : argv.slice(0, split);
  const command = split === -1 ? [] : argv.slice(split + 1);
  let socketPath = null;
  let port = null;
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === '--socket') socketPath = own[++i];
    else if (own[i] === '--port') port = Number(own[++i]);
    else fail(`不认识的参数 ${own[i]}`);
  }
  if (!socketPath) fail('缺 --socket');
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('缺 --port 或端口不对');
  if (command.length === 0) fail('缺要跑的命令（-- 之后）');
  return { socketPath, port, command };
}

const { socketPath, port, command } = parseArgs(process.argv.slice(2));

const server = net.createServer((client) => {
  const upstream = net.connect(socketPath);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', close);
  upstream.on('error', close);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.once('error', (error) => fail(`127.0.0.1:${port} 听不上：${error?.message || error}`));
server.listen({ host: '127.0.0.1', port }, () => {
  server.unref();
  const child = spawnProcess(command[0], command.slice(1), { stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // 已经退了。
      }
    });
  }
  child.on('error', (error) => fail(`命令起不来：${error?.message || error}`));
  child.on('exit', (code, signal) => {
    server.close();
    process.exit(code ?? (signal ? 128 + (signalNumber(signal) || 1) : 1));
  });
});

function signalNumber(signal) {
  return { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[signal];
}
