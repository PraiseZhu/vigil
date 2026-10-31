// 宿主侧看沙箱里有没有在干活（#149）：pi.log 不长、写闸没请求时，再看两样。
// 1. pi 进程树（宿主看得见 bwrap 和它的全部后代）的累计 CPU 时间；
// 2. 本轮目录下沙箱 home、tmp 等几个目录及其一层子目录的最新 mtime（浅扫，不递归整棵树）。
// 任一变化，调用方就刷新 lastActivityAt。空转吃 CPU 的 pi 抓不到，靠总时长上限兜底。
import fs from 'node:fs';
import path from 'node:path';

/** 读 /proc/<pid>/stat：返回 { ppid, ticks }（utime+stime+cutime+cstime），读不到返回 null。 */
function readStat(procDir, pid) {
  let text;
  try {
    text = fs.readFileSync(path.join(procDir, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  // comm 可能带空格和括号，从最后一个 ')' 往后切。
  const close = text.lastIndexOf(')');
  if (close < 0) return null;
  const fields = text.slice(close + 2).trim().split(/\s+/);
  // fields[0]=state(3) fields[1]=ppid(4) ... utime(14)=fields[11] stime=12 cutime=13 cstime=14
  const ppid = Number(fields[1]);
  const ticks = [11, 12, 13, 14].reduce((sum, i) => sum + (Number(fields[i]) || 0), 0);
  if (!Number.isFinite(ppid)) return null;
  return { ppid, ticks };
}

/** rootPid 及其全部后代的累计 CPU 时钟数；rootPid 不在了返回 null。 */
export function processTreeCpuTicks(rootPid, { procDir = '/proc' } = {}) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const root = readStat(procDir, rootPid);
  if (!root) return null;
  let entries;
  try {
    entries = fs.readdirSync(procDir);
  } catch {
    return root.ticks;
  }
  const children = new Map();
  const stats = new Map([[rootPid, root]]);
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === rootPid) continue;
    const stat = readStat(procDir, pid);
    if (!stat) continue;
    stats.set(pid, stat);
    if (!children.has(stat.ppid)) children.set(stat.ppid, []);
    children.get(stat.ppid).push(pid);
  }
  let total = 0;
  const seen = new Set();
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    total += stats.get(pid)?.ticks || 0;
    for (const child of children.get(pid) || []) queue.push(child);
  }
  return total;
}

/** dirs 里每个目录本身及其直接子项的最新 mtime（毫秒）；都不存在返回 null。 */
export function newestMtimeMs(dirs) {
  let newest = null;
  const consider = (file) => {
    try {
      const ms = fs.statSync(file).mtimeMs;
      if (newest === null || ms > newest) newest = ms;
    } catch {
      // 不存在或刚被删：跳过。
    }
  };
  for (const dir of dirs) {
    consider(dir);
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) consider(path.join(dir, name));
  }
  return newest;
}

/** 本轮要看的沙箱目录（宿主路径）。 */
export function sandboxActivityDirs(roundDir) {
  return [
    path.join(roundDir, 'home', '.npm', '_logs'),
    path.join(roundDir, 'home'),
    path.join(roundDir, 'tmp'),
  ];
}

/** 默认探针：返回 { cpuTicks, filesMtimeMs }，取不到的项为 null。 */
export function probeSandboxActivity({ piPid, roundDir }) {
  return {
    cpuTicks: processTreeCpuTicks(piPid),
    filesMtimeMs: newestMtimeMs(sandboxActivityDirs(roundDir)),
  };
}

/** 和上一拍比：返回变化来源（'cpu' / 'files'），没变返回 null。第一拍只记基线。 */
export function activityChange(previous, current) {
  if (!previous || !current) return null;
  if (current.cpuTicks != null && previous.cpuTicks != null && current.cpuTicks > previous.cpuTicks) return 'cpu';
  if (current.filesMtimeMs != null && current.filesMtimeMs !== previous.filesMtimeMs) return 'files';
  return null;
}
