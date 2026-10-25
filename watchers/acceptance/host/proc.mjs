#!/usr/bin/env node
// 宿主里唯一 import node:child_process 的模块（#47）：跑命令、起后台进程都从这里走。
// 别的 host/ 模块要用进程，就把这里的 run / spawnProcess / spawnDetached 传进去。
import { spawn } from 'node:child_process';

/**
 * 跑一条命令，等它结束：{code, stdout, stderr}。
 * timeoutMs 到了先 SIGTERM，2 秒后还在就 SIGKILL。
 */
export function run(cmd, args, { env, input, raw = false, cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, Array.isArray(args) ? args : [], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // raw：stdout 按字节原样收（cat-file --batch 要按字节数切），不按 UTF-8 拼成字符串。
    const outChunks = [];
    let stderr = '';
    let timer;
    let killed = false;
    const stop = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timer = setTimeout(() => {
        killed = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      }, timeoutMs);
      timer.unref?.();
    }
    child.stdout.on('data', (chunk) => {
      outChunks.push(Buffer.from(chunk));
    });
    const collected = () => (raw ? Buffer.concat(outChunks) : Buffer.concat(outChunks).toString('utf8'));
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stop();
      if (killed) {
        resolve({ code: 124, stdout: collected(), stderr: `${stderr}${error.message}` });
        return;
      }
      reject(error);
    });
    child.on('close', (code, signal) => {
      stop();
      resolve({ code: code ?? (signal ? 124 : 1), stdout: collected(), stderr, signal: signal || undefined });
    });
    if (input != null) child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * 起一个子进程并把句柄交回去（host/round.mjs 的 pi：stdin 要喂派发消息，还要能 kill）。
 * stdio 默认全是管道；日志文件用 fd 传 ['pipe', fd, fd] 即可。
 */
export function spawnProcess(cmd, args, { env, cwd, stdio = ['pipe', 'pipe', 'pipe'] } = {}) {
  return spawn(cmd, Array.isArray(args) ? args : [], { env, cwd, stdio, detached: false });
}

/** 起一个和本进程断开的后台进程（写闸 serve、下一轮 round、常驻循环都用它）。 */
export function spawnDetached(cmd, args, { env, cwd, stdio = ['ignore', 'ignore', 'ignore'] } = {}) {
  return spawn(cmd, Array.isArray(args) ? args : [], {
    env,
    cwd,
    stdio,
    detached: true,
  });
}

/**
 * 起一个后台进程并放手：detached + unref。只 detached 不 unref 时，父进程的事件循环仍然挂着这个子进程，
 * 要等它退出才能退——tick 起一轮验收（最长 2 小时）就会被卡住，整个常驻循环停拍、心跳不更新。
 */
export function spawnBackground(cmd, args, options = {}) {
  const child = spawnDetached(cmd, args, options);
  child.unref();
  return child;
}
