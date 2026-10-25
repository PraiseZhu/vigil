// 修正轮（#60）读 host.json 的 prbot.repos[repo]：交接方式、预检命令。
// 单独一个文件、不依赖任何会起进程的模块：prbot.mjs 和 bin/doctor.mjs 共用同一套判定。

export const HANDOFF_VALUES = Object.freeze(['owner', 'watcher']);

function sameRepo(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

/** prbot.repos 里这个仓的配置（仓名不分大小写）；没有就是 {}。 */
export function repoConfig(hostConfig, repo) {
  const repos = hostConfig?.prbot?.repos;
  if (!repos || typeof repos !== 'object' || Array.isArray(repos)) return {};
  if (repos[repo]) return repos[repo];
  const key = Object.keys(repos).find((entry) => sameRepo(entry, repo));
  return (key && repos[key]) || {};
}

/**
 * 交接方式必须在 host.json 的 prbot.repos[repo].handoff 里显式写（owner / watcher）。
 * 没写就返回 null：不认领、不转 Ready（以前默认 owner，没标 watcher 的 Mivo 仓会收到「可合并 + 打开 PR」）。
 */
export function handoffFor(hostConfig, repo) {
  const value = repoConfig(hostConfig, repo).handoff;
  return HANDOFF_VALUES.includes(value) ? value : null;
}

/**
 * 预检命令：prbot.repos[repo].preflight 是命令列表，每项是一条命令——字符串（只有程序本身，如 ".githooks/pre-push"）
 * 或 argv 数组（如 ["npm", "test"]）。没配返回 []；格式不对返回 null（fail-closed：需人工处理，不是每拍崩）。
 */
export function preflightCommands(config) {
  const raw = config?.preflight;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry) out.push([entry]);
    else if (Array.isArray(entry) && entry.length && entry.every((item) => typeof item === 'string' && item)) out.push([...entry]);
    else return null;
  }
  return out;
}
