#!/usr/bin/env node
// 宿主里唯一 import node:child_process 的模块（#47）：跑命令、起后台进程都从这里走。
// 别的 host/ 模块要用进程，就把这里的 run / spawnProcess / spawnDetached 传进去。
import { spawn } from 'node:child_process';

/**
 * 跑一条命令，等它结束：{code, stdout, stderr}。
 * timeoutMs 到了先 SIGTERM，2 秒后还在就 SIGKILL。
 */
export function run(cmd, args, { env, input, cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, Array.isArray(args) ? args : [], {
      env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
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
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      stop();
      if (killed) {
        resolve({ code: 124, stdout, stderr: `${stderr}${error.message}` });
        return;
      }
      reject(error);
    });
    child.on('close', (code, signal) => {
      stop();
      resolve({ code: code ?? (signal ? 124 : 1), stdout, stderr, signal: signal || undefined });
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
