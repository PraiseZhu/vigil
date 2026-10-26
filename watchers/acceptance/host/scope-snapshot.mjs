// 写入当时的仓范围快照：写闸每写一条账本就带上「当时按哪份范围放行的」（scope 指纹），
// 快照本身存在 <home>/state/write-gate/scopes/<指纹>.json（沙箱看不到 state，模型改不了）。
// 审计按写入当时的范围判「仓范围 / 分档 / 只出裁决」，不按审计这一刻的配置判——
// 否则写完之后人改了 profile（比如临时把某个仓移出 autoRepos），已经合规的旧写入会被误判成越权。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 决定「能不能写、按哪档写」的 profile 字段；只存这些，不存别的配置。 */
export const SCOPE_FIELDS = Object.freeze(['autoRepos', 'forkRepos', 'watchRepos', 'verdictOnlyIssues']);
const HASH = /^[0-9a-f]{16}$/;

/** 从 profile 里取范围字段（缺的当空数组），按字段顺序固定，方便算指纹。 */
export function scopeOf(profile = {}) {
  const out = {};
  for (const field of SCOPE_FIELDS) {
    const value = profile?.[field];
    out[field] = Array.isArray(value) ? value.map(String) : [];
  }
  return out;
}

/** 范围指纹：规范化 JSON 的 sha256 前 16 位。 */
export function scopeHash(scope) {
  return crypto.createHash('sha256').update(JSON.stringify(scopeOf(scope))).digest('hex').slice(0, 16);
}

export function scopesDir(gateDir) {
  return path.join(gateDir, 'scopes');
}

/** 把 profile 的范围存成快照（已存在就不动），返回指纹。 */
export function recordScope(gateDir, profile) {
  const scope = scopeOf(profile);
  const hash = scopeHash(scope);
  const dir = scopesDir(gateDir);
  const file = path.join(dir, `${hash}.json`);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(scope)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return hash;
}

/**
 * 读全部快照：指纹 → 范围。文件内容和文件名指纹对不上的（被改过、写坏了）一律不认，
 * 审计遇到这种记录就退回按当前配置判（和没有指纹的老记录一样）。
 */
export function loadScopes(gateDir) {
  const out = new Map();
  let names = [];
  try {
    names = fs.readdirSync(scopesDir(gateDir));
  } catch {
    return out;
  }
  for (const name of names) {
    const match = /^([0-9a-f]{16})\.json$/.exec(name);
    if (!match) continue;
    try {
      const scope = scopeOf(JSON.parse(fs.readFileSync(path.join(scopesDir(gateDir), name), 'utf8')));
      if (scopeHash(scope) === match[1]) out.set(match[1], scope);
    } catch {
      // 读不出的快照不认。
    }
  }
  return out;
}

/** 这条账本记录该按哪份范围判：带了能核对上的指纹就用快照，否则用当前 profile。返回 {profile, source}。 */
export function scopeForEntry(entry, profile, scopes) {
  const hash = typeof entry?.scope === 'string' && HASH.test(entry.scope) ? entry.scope : null;
  const snapshot = hash && scopes ? scopes.get(hash) : null;
  if (snapshot) return { profile: { ...(profile || {}), ...snapshot }, source: 'write-time' };
  return { profile: profile || {}, source: 'current' };
}
