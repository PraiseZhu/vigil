// 真 bwrap 测试的公共判断：夹具要建在代码目录下（沙箱把 /tmp 盖成空 tmpfs，夹具放 /tmp 里沙箱看不见）。
// 代码目录只读时（例如验收轮的 pi 在自己的沙箱里跑本仓测试）建不了夹具，这些测试跳过而不是报错。
import fs from 'node:fs';
import path from 'node:path';

export const READONLY_SKIP = '代码目录只读（例如在验收轮沙箱里跑测试），真沙箱测试要在代码目录下建夹具，跳过';

export function fixtureDirWritable(dir) {
  try {
    const probe = fs.mkdtempSync(path.join(dir, '.writable-probe-'));
    fs.rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
