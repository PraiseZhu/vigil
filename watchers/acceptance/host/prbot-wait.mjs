// 修正轮等待账：记录每个被发现但还没起的修正 issue 的首次等待时间。
// 起了或不再出现就清掉。缺失或损坏的状态文件按空账处理。
import fs from 'node:fs';
import path from 'node:path';

/** 等待超过这个时长（严格大于）才优先拿下一个空槽。刚好 1 小时不优先。 */
export const PRBOT_WAIT_MS = 60 * 60 * 1000;

/** 状态文件格式版本。不认得的版本按空账读。 */
export const PRBOT_WAIT_VERSION = 1;

export function emptyPrbotWait() {
  return { version: PRBOT_WAIT_VERSION, issues: {} };
}

/** 读等待账。没有文件、不是 JSON、版本不认、结构不对都当空账。 */
export function readPrbotWait(file) {
  if (!file) return emptyPrbotWait();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return emptyPrbotWait();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== PRBOT_WAIT_VERSION) {
    return emptyPrbotWait();
  }
  if (!parsed.issues || typeof parsed.issues !== 'object' || Array.isArray(parsed.issues)) {
    return emptyPrbotWait();
  }
  const issues = {};
  for (const [issue, row] of Object.entries(parsed.issues)) {
    if (!issue || !row || typeof row !== 'object' || Array.isArray(row)) continue;
    if (!Number.isFinite(Date.parse(row.firstSeenAt))) continue;
    issues[issue] = { firstSeenAt: String(row.firstSeenAt) };
  }
  return { version: PRBOT_WAIT_VERSION, issues };
}

/** 原子写回等待账。 */
export function writePrbotWait(file, state) {
  if (!file) throw new Error('writePrbotWait 需要文件路径');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const payload = {
    version: PRBOT_WAIT_VERSION,
    issues: state?.issues && typeof state.issues === 'object' && !Array.isArray(state.issues) ? state.issues : {},
  };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

/** 现在是否已经「等待超过 1 小时」。刚好满 1 小时返回 false。 */
export function isStarved(firstSeenAt, now) {
  const start = Date.parse(firstSeenAt);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return false;
  return now - start > PRBOT_WAIT_MS;
}

/**
 * 按这一拍仍待起的发现名单刷新账：新出现的记下当前时间，已有的保留首次时间，名单里没有的清掉。
 */
export function rememberFound(state, foundIssues, now) {
  const previous = state?.issues && typeof state.issues === 'object' ? state.issues : {};
  const issues = {};
  const at = new Date(now).toISOString();
  for (const issue of foundIssues || []) {
    const key = String(issue || '');
    if (!key) continue;
    const prev = previous[key];
    const firstSeenAt = prev && Number.isFinite(Date.parse(prev.firstSeenAt)) ? prev.firstSeenAt : at;
    issues[key] = { firstSeenAt };
  }
  return { version: PRBOT_WAIT_VERSION, issues };
}

/** 已经起了的修正轮从账里清掉。 */
export function clearStarted(state, startedIssues) {
  const issues = { ...(state?.issues && typeof state.issues === 'object' ? state.issues : {}) };
  for (const issue of startedIssues || []) delete issues[String(issue || '')];
  return { version: PRBOT_WAIT_VERSION, issues };
}

/** 发现名单里等待已经超过 1 小时的 issue，保持原顺序。 */
export function starvedIssues(state, foundIssues, now) {
  const issues = state?.issues && typeof state.issues === 'object' ? state.issues : {};
  return (foundIssues || []).filter((issue) => isStarved(issues[issue]?.firstSeenAt, now));
}
