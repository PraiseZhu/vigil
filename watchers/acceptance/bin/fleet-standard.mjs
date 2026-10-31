#!/usr/bin/env node
// 舰队任务标准的命令行入口。解析、执行和写文件都在 ../fleet-standard.mjs。
// 验收机 bin 里除 github.mjs、localgit.mjs 外不能起子进程，所以这里只转发。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TIMEOUT_MS,
  ESCALATE_UNCHANGED_MS,
  TIMEOUT_EXIT_CODE,
  main,
  parseChecklist,
  renderTable,
  runChecklist,
} from '../fleet-standard.mjs';

export {
  DEFAULT_TIMEOUT_MS,
  ESCALATE_UNCHANGED_MS,
  TIMEOUT_EXIT_CODE,
  main,
  parseChecklist,
  renderTable,
  runChecklist,
};

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
