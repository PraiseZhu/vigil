// 验收真实性（舰队标准 A）：人工/未执行不能收成通过；空证据与不可追溯补充不能冒充原验；
// 每轮冻结标准正文与执行材料。纯函数 + 本地快照，不发 GitHub 请求、不起子进程。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANUAL_LAYERS = Object.freeze(['cindy-mac', 'cindy-windows', 'paid', 'github-live']);

export const OVERALL_PENDING = '待人工';
export const ITEM_PENDING = '待验';
export const STANDARD_CHANGED_REASON = '标准已变，本轮作废';
export const MATERIAL_FILES = Object.freeze([
  'helper.mjs',
  'collect.mjs',
  'close.mjs',
  'verdict.mjs',
  'authenticity.mjs',
]);
export const EMPTY_EVIDENCE = Object.freeze(new Set(['', '—', '-', '–', '无']));
export const PENDING_ITEM_RESULTS = Object.freeze(['人工手测', ITEM_PENDING]);
export const FINAL_OVERALL = Object.freeze(['通过', '要修', OVERALL_PENDING, '中断']);
export const VERDICT_OVERALL = Object.freeze(['通过', '要修', OVERALL_PENDING]);

const CHECKBOX_LINE = /^(\s*[-*]\s+\[)[ xX](\][^\n]*)$/;
const SC_ITEM_LINE = /^\s*[-*]\s*(?:\[\s*[xX ]\s*\])?\s*(?:\*\*)?SC\d+\b/;
const MANUAL_SUFFIX = ' 人工手测';
const TEMP_COPY_HINT = /临时副本/;

function sha256Text(text) {
  return `sha256:${crypto.createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')}`;
}

function cacheKey(ref) {
  return String(ref || '').replace('#', '__').replace(/\//g, '__');
}

function conclusionKey(ref, sc) {
  return `${String(ref).toLowerCase()} SC${Number(sc)}`;
}

export function evidenceIsEmpty(text) {
  return EMPTY_EVIDENCE.has(String(text ?? '').trim());
}

export function materialDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

export function materialVersions(dir = materialDir()) {
  const out = {};
  for (const name of MATERIAL_FILES) {
    const file = path.join(dir, name);
    out[name] = sha256Text(fs.readFileSync(file, 'utf8'));
  }
  return out;
}

/** 认领快照相对 watcher home 的路径。沙箱只通过空 tmpfs 视图看到本轮权威快照文件，看不到其他轮次/已有内容/符号链接，也看不到整个 host 状态。 */
export const CLAIM_SNAPSHOT_REL = path.join('state', 'host', 'snapshots');

function watcherHomeFromProfile(profile) {
  if (typeof profile?.profilePath === 'string' && profile.profilePath) {
    return path.dirname(path.dirname(profile.profilePath));
  }
  throw new Error('认领快照需要 profile.profilePath，才能写到沙箱不可写的宿主目录');
}

/** 认领快照目录：`<watcher home>/state/host/snapshots`。沙箱经只读视图读同一份，不能改。 */
export function snapshotDir(profile) {
  return path.join(watcherHomeFromProfile(profile), CLAIM_SNAPSHOT_REL);
}

export function isClaimSnapshotDir(dir) {
  if (typeof dir !== 'string' || !dir) return false;
  const resolved = path.resolve(dir);
  return (
    path.basename(resolved) === 'snapshots' &&
    path.basename(path.dirname(resolved)) === 'host' &&
    path.basename(path.dirname(path.dirname(resolved))) === 'state'
  );
}

export function isClaimSnapshotFile(file) {
  if (typeof file !== 'string' || !file) return false;
  const resolved = path.resolve(file);
  return isClaimSnapshotDir(path.dirname(resolved)) && /^.+-r\d+\.json$/.test(path.basename(resolved));
}

export function snapshotPath(profile, ref, n) {
  return path.join(snapshotDir(profile), `${cacheKey(ref)}-r${n}.json`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function readClaimSnapshot(profile, ref, n) {
  return readJson(snapshotPath(profile, ref, n));
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function writeClaimSnapshot(profile, ref, n, patch) {
  if (process.env.ACCEPTANCE_GATE_SOCKET) {
    throw new Error('沙箱不能改认领快照');
  }
  const file = snapshotPath(profile, ref, n);
  const prev = readJson(file) || {};
  const next = {
    ...prev,
    ...patch,
    ref,
    round: n,
    bodies: { ...(prev.bodies || {}), ...(patch.bodies || {}) },
    materials: patch.materials || prev.materials || materialVersions(),
  };
  atomicWrite(file, next);
  return next;
}

export function attachCodeSha(profile, ref, n, codeSha) {
  if (typeof codeSha !== 'string' || !/^[0-9a-f]{40}$/i.test(codeSha.trim())) return readClaimSnapshot(profile, ref, n);
  return writeClaimSnapshot(profile, ref, n, { codeSha: codeSha.trim() });
}

export function snapshotFromTree(tree) {
  const bodies = {};
  for (const issue of tree?.issues || []) bodies[issue.ref] = issue.body ?? '';
  if (tree?.root?.ref && !Object.prototype.hasOwnProperty.call(bodies, tree.root.ref)) {
    bodies[tree.root.ref] = tree.root.body ?? '';
  }
  return {
    bodyVersion: tree?.root?.bodyVersion || null,
    bodies,
  };
}

/** 缺文件、推断、缺子单时抛错：禁止事后按当前正文重建。 */
export function requireClaimSnapshot(profile, ref, n, tree) {
  const existing = readClaimSnapshot(profile, ref, n);
  const blocked = snapshotPassBlocked(existing, tree);
  if (blocked) throw new Error(blocked);
  return existing;
}

function sameExceptCheckbox(before, after) {
  if (before === after) return true;
  const a = CHECKBOX_LINE.exec(before);
  const b = CHECKBOX_LINE.exec(after);
  return Boolean(a && b && a[1] === b[1] && a[2] === b[2]);
}

export function allowedStandardLine(before, after) {
  if (before === after) return true;
  if (!SC_ITEM_LINE.test(before) || !SC_ITEM_LINE.test(after)) return false;
  if (sameExceptCheckbox(before, after)) return true;
  if (!after.endsWith(MANUAL_SUFFIX)) return false;
  const trimmed = before.trimEnd();
  if (trimmed.endsWith(MANUAL_SUFFIX.trim())) return false;
  return sameExceptCheckbox(trimmed, after.slice(0, -MANUAL_SUFFIX.length));
}

/** 除 SC 行已验勾选和行尾「 人工手测」外，标准正文有任何其它字的变化。 */
export function standardShifted(startBody, currentBody) {
  const oldLines = String(startBody ?? '').split('\n');
  const newLines = String(currentBody ?? '').split('\n');
  if (oldLines.length !== newLines.length) return true;
  for (let i = 0; i < oldLines.length; i += 1) {
    if (!allowedStandardLine(oldLines[i], newLines[i])) return true;
  }
  return false;
}

export function shiftedIssues(snapshot, tree) {
  const out = [];
  const bodies = snapshot?.bodies || {};
  for (const issue of tree?.issues || []) {
    if (!Object.prototype.hasOwnProperty.call(bodies, issue.ref)) {
      out.push(issue.ref);
      continue;
    }
    const current = issue.body != null ? issue.body : '';
    if (standardShifted(bodies[issue.ref], current)) out.push(issue.ref);
  }
  return out;
}

export function snapshotUnusableReason(snapshot, tree) {
  if (!snapshot) return '缺少认领快照，本轮作废';
  if (snapshot.inferred) return '认领快照是推断的，本轮作废';
  if (!snapshot.bodyVersion) return '缺少起始正文版本，本轮作废';
  const shifted = shiftedIssues(snapshot, tree);
  if (shifted.length) return `${STANDARD_CHANGED_REASON}：${shifted.join('、')}`;
  return null;
}

export function snapshotPassBlocked(snapshot, tree) {
  const unusable = snapshotUnusableReason(snapshot, tree);
  if (unusable) return unusable.replace(/，本轮作废$/, '，不能通过/关单/写看板通过');
  if (!snapshot.materials || typeof snapshot.materials !== 'object' || !Object.keys(snapshot.materials).length) {
    return '认领快照材料版本为空，不能通过/关单/写看板通过';
  }
  const now = materialVersions();
  const changed = Object.keys(snapshot.materials).filter((name) => now[name] && now[name] !== snapshot.materials[name]);
  if (changed.length) return `执行材料已变：${changed.join('、')}`;
  return null;
}

export function treeItemOf(tree, ref, sc) {
  for (const issue of tree?.issues || []) {
    for (const item of issue.items || []) {
      if (conclusionKey(item.source || issue.ref, item.sc) === conclusionKey(ref, sc)) return item;
    }
  }
  return null;
}

function relativeInCheckout(rel) {
  return typeof rel === 'string' && rel && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
}

export function originalPassBlocked(item, { checkoutDir, snapshot } = {}) {
  if (item?.result !== '通过') return null;
  const ref = `${item.ref} SC${item.sc}`;
  if (item.evidenceKind === 'supplement') {
    return `${ref} 的补充证据不能替代冻结标准的通过`;
  }
  if (evidenceIsEmpty(item.evidence)) {
    return `${ref} 的通过证据为空`;
  }
  const files = Array.isArray(item.testFiles) ? item.testFiles : [];
  const root = checkoutDir || snapshot?.checkoutDir || null;
  const tempOrExtra = TEMP_COPY_HINT.test(String(item.evidence || '')) || item.extraTest === true;
  const needsCheckout = tempOrExtra || item.evidenceKind === 'frozen' || files.length > 0;
  if (needsCheckout) {
    if (!files.length) return `${ref} 的通过证据不可追溯到冻结检出（未提供 testFiles）`;
    if (!root) return `${ref} 的 testFiles 没有冻结检出根`;
    for (const rel of files) {
      if (!relativeInCheckout(rel)) return `${ref} 的 testFiles 不是检出内相对路径`;
      if (!fs.existsSync(path.join(root, rel))) {
        return `${ref} 的 testFiles 不在冻结检出里：${rel}`;
      }
    }
  }
  if (item.codeSha && snapshot?.codeSha && item.codeSha !== snapshot.codeSha) {
    return `${ref} 的 codeSha 与本轮冻结 SHA 不一致`;
  }
  return null;
}

export function guardOriginalPass(items = [], extras = {}) {
  if (extras.moduleUrl) assertNotTempModule(extras.moduleUrl);
  const snapshot = extras.snapshot;
  if (items.some((item) => item.result === '通过')) {
    if (!snapshot?.materials || !Object.keys(snapshot.materials).length) {
      throw new Error('认领快照材料版本为空，不能按原标准判通过');
    }
    if (extras.compareMaterials !== false) {
      const now = extras.materials || materialVersions(extras.materialDir || materialDir());
      const changed = Object.keys(snapshot.materials).filter((name) => now[name] && now[name] !== snapshot.materials[name]);
      if (changed.length) throw new Error(`执行材料已变，不能按原标准判通过：${changed.join('、')}`);
    }
  }
  for (const item of items) {
    if (item.result !== '通过') continue;
    const blocked = originalPassBlocked(item, extras);
    if (blocked) throw new Error(blocked);
  }
}

// 手测结论标记（与 Review-PR 同一格式）：评论里一行
// `<!-- manual-test-result:v1 issue=<N> pr=<M> head=<完整提交号> result=pass|fail -->`，
// 正文逐行写 `- SC<k> pass|fail|未测`。只认授权人工验收者（默认 ownerLogin，bot 一律不认），
// head 必须等于本轮被测提交的完整 SHA。
export const MANUAL_TEST_MARKER = /<!--\s*manual-test-result:v1\s+issue=(\d+)\s+pr=(\d+)\s+head=([0-9a-f]{40})\s+result=(pass|fail)\s*-->/;
const MANUAL_SC_LINE = /^\s*(?:[-*]\s+)?(?:\[[ xX]\]\s*)?(?:\*\*)?SC(\d+)(?:\*\*)?\s*[:：\-—]?\s*(不通过|未测|失败|通过|pass|fail)(?=$|[^A-Za-z0-9])/i;
const FULL_SHA = /^[0-9a-f]{40}$/;

function toManualItemResult(word) {
  const lower = word.toLowerCase();
  if (lower === 'pass' || word === '通过') return 'pass';
  if (lower === 'fail' || word === '不通过' || word === '失败') return 'fail';
  return 'untested';
}

/** 解析一条评论正文里的 manual-test-result:v1 标记和逐条 SC 结论；没有标记返回 null。同一 SC 写了多次，有 fail 就按 fail。 */
export function parseManualTestResult(body) {
  const text = String(body ?? '');
  const marker = MANUAL_TEST_MARKER.exec(text);
  if (!marker) return null;
  const bySc = new Map();
  for (const line of text.split('\n')) {
    const match = MANUAL_SC_LINE.exec(line);
    if (!match) continue;
    const sc = Number(match[1]);
    const result = toManualItemResult(match[2]);
    const prev = bySc.get(sc);
    if (prev === 'fail') continue;
    if (prev === 'pass' && result === 'untested') continue;
    bySc.set(sc, result);
  }
  return {
    issue: Number(marker[1]),
    pr: Number(marker[2]),
    head: marker[3],
    result: marker[4],
    items: [...bySc].map(([sc, result]) => ({ sc, result })),
  };
}

function manualAcceptorsOf({ profile, acceptors } = {}) {
  const list = Array.isArray(acceptors) ? acceptors : [profile?.ownerLogin];
  return list.filter((login) => typeof login === 'string' && login.trim()).map((login) => login.trim().toLowerCase());
}

/** 手测结论的作者是不是授权人工验收者：bot（类型是 Bot 或登录名带 [bot]）一律不是。 */
export function manualTestAuthorized(author, options = {}) {
  const login = typeof author === 'string' ? author : author?.login;
  const type = typeof author === 'object' && author ? author.__typename ?? author.type : undefined;
  if (typeof login !== 'string' || !login.trim()) return false;
  if (type === 'Bot' || /\[bot\]$/i.test(login.trim())) return false;
  return manualAcceptorsOf(options).includes(login.trim().toLowerCase());
}

/**
 * 核验一条手测结论候选（tasks.mjs 采集的 `{ commentId, updatedAt, author, body, repo }`）。
 * 通过返回 `{ ok: true, ref, ... }`，否则 `{ ok: false, reason }`。headSha 缺失或不是完整 SHA 时一律拒收。
 */
export function verifyManualTestResult(record, { profile, acceptors, headSha, repo } = {}) {
  const parsed = parseManualTestResult(record?.body);
  if (!parsed) return { ok: false, reason: 'not-manual-test-result' };
  if (!manualTestAuthorized(record?.author, { profile, acceptors })) {
    return { ok: false, reason: 'unauthorized-author' };
  }
  const current = typeof headSha === 'string' ? headSha.trim().toLowerCase() : '';
  if (!FULL_SHA.test(current)) return { ok: false, reason: 'no-head-sha' };
  if (parsed.head !== current) return { ok: false, reason: 'head-mismatch', expected: current, actual: parsed.head };
  const issueRepo = record?.repo || repo;
  if (typeof issueRepo !== 'string' || !issueRepo) return { ok: false, reason: 'no-repo' };
  return {
    ok: true,
    ref: `${issueRepo}#${parsed.issue}`,
    commentId: record.commentId ?? null,
    updatedAt: record.updatedAt ?? null,
    ...parsed,
  };
}

/**
 * 一组候选手测结论 → 已核验的覆盖情况：`passed` 是获 pass 的 `ref SC<k>` 集合；任一已核验记录整体 fail
 * 或任一 SC 标 fail，`failed` 为 true。只认 `refs`（任务树里的 issue）里的 issue；没给 refs 不限。
 */
export function manualTestCoverage(records = [], options = {}) {
  const refs = options.refs ? new Set([...options.refs].map((ref) => String(ref).toLowerCase())) : null;
  const passed = new Set();
  const accepted = [];
  const rejected = [];
  let failed = false;
  for (const record of Array.isArray(records) ? records : []) {
    const verified = verifyManualTestResult(record, options);
    if (verified.ok && refs && !refs.has(verified.ref.toLowerCase())) {
      rejected.push({ commentId: record?.commentId ?? null, reason: 'issue-not-in-tree' });
      continue;
    }
    if (!verified.ok) {
      rejected.push({ commentId: record?.commentId ?? null, reason: verified.reason });
      continue;
    }
    accepted.push(verified);
    if (verified.result === 'fail') failed = true;
    for (const item of verified.items) {
      if (item.result === 'fail') failed = true;
      if (item.result === 'pass') passed.add(conclusionKey(verified.ref, item.sc));
    }
  }
  return { passed, failed, accepted, rejected };
}

function treeRefsOf(tree, items) {
  const refs = new Set();
  for (const issue of tree?.issues || []) {
    if (issue.ref) refs.add(issue.ref);
    for (const item of issue.items || []) if (item.source) refs.add(item.source);
  }
  for (const item of items) if (item.ref) refs.add(item.ref);
  return refs;
}

/**
 * 总评。`extras.manualTestRecords` 给了手测结论候选时，按 `extras.headSha`（本轮被测提交完整 SHA）和
 * 授权验收者（`extras.acceptors`，默认 `extras.profile.ownerLogin`）现场核验：任一 fail → 要修；
 * 人工项获 pass 的只消除对应 SC 的等待，全部人工项都获 pass 且机器项全过才是通过。
 */
export function deriveStatus(items = [], needsHuman = [], extras = {}) {
  if (!items.length) throw new Error('裁决没有任何逐条结论，不能判通过：items 至少要有一条');
  if (needsHuman.length) return '要修';
  if (items.some((item) => item.result === '要修' || item.result === '有争议')) return '要修';
  const tree = extras.tree;
  const manualTest = extras.manualTestRecords
    ? manualTestCoverage(extras.manualTestRecords, {
        profile: extras.profile,
        acceptors: extras.acceptors,
        headSha: extras.headSha,
        refs: treeRefsOf(tree, items),
      })
    : null;
  if (manualTest?.failed) return '要修';
  if (extras.extracted) return OVERALL_PENDING;
  if ((extras.skippedQueries || []).length || extras.collectionComplete === false) return OVERALL_PENDING;
  const covered = (ref, sc) => Boolean(manualTest?.passed.has(conclusionKey(ref, sc)));
  for (const item of items) {
    if (!PENDING_ITEM_RESULTS.includes(item.result)) continue;
    const manual = item.result === '人工手测' || treeItemOf(tree, item.ref, item.sc)?.manual || MANUAL_LAYERS.includes(item.layer);
    if (!manual || !covered(item.ref, item.sc)) return OVERALL_PENDING;
  }
  if ((tree?.manual || []).some((item) => !covered(item.source, item.sc))) return OVERALL_PENDING;
  for (const item of items) {
    if (item.result !== '通过') continue;
    const sc = treeItemOf(tree, item.ref, item.sc);
    if ((sc?.manual || MANUAL_LAYERS.includes(item.layer)) && !covered(item.ref, item.sc)) return OVERALL_PENDING;
  }
  return '通过';
}

export function formatMaterialLine(materials = {}) {
  return MATERIAL_FILES.map((name) => `${name}=${materials[name] || '未知'}`).join(' ');
}

export function firstLine(text) {
  return String(text ?? '').split('\n')[0] || '';
}

export function lineValue(body, label) {
  const match = String(body || '')
    .split('\n')
    .find((line) => line.startsWith(`${label}：`));
  return match ? match.slice(label.length + 1).trim() : null;
}

function passEvidenceLines(body) {
  const have = new Map();
  for (const line of String(body || '').split('\n')) {
    const trimmed = line.trim();
    const match = /^- 通过：(\S+)\s+SC(\d+)(?:\s|·|$)/.exec(trimmed);
    if (!match) continue;
    const ev = /证据：(.*)$/.exec(trimmed);
    have.set(conclusionKey(match[1], match[2]), ev ? ev[1] : '');
  }
  return have;
}

export function illegalPassFromVerdictText(body, tree, snapshot) {
  const match = /^\[验收机\] 第 \d+ 轮：(通过|要修|待人工|中断)/.exec(firstLine(body));
  if (!match || match[1] !== '通过') return [];
  const reasons = [];
  const snapBlock = snapshotPassBlocked(snapshot, tree);
  if (snapBlock) reasons.push(snapBlock);
  if (tree?.manual?.length) reasons.push('人工层未完成，不能总评通过');
  if (tree?.collectionComplete === false || (tree?.skippedQueries || []).length) {
    reasons.push('收集不完整，不能按原标准通过');
  }
  if (/未执行的查询|未收集全/.test(body)) reasons.push('裁决写明未收集全');
  const have = passEvidenceLines(body);
  for (const line of String(body || '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- 人工手测：') || trimmed.startsWith('- 待验：')) {
      reasons.push('有待验项，不能总评通过');
    }
    if (trimmed.startsWith('- 通过：')) {
      const ev = /证据：(.*)$/.exec(trimmed);
      if (!ev || evidenceIsEmpty(ev[1])) reasons.push('通过项空证据');
    }
  }
  for (const issue of tree?.issues || []) {
    for (const item of issue.items || []) {
      const key = conclusionKey(item.source || issue.ref, item.sc);
      const evidence = have.get(key);
      if (evidence === undefined) {
        reasons.push(`通过评论缺 ${item.source || issue.ref} SC${item.sc} 的证据`);
      } else if (evidenceIsEmpty(evidence)) {
        reasons.push(`${item.source || issue.ref} SC${item.sc} 通过项空证据`);
      }
    }
  }
  return [...new Set(reasons)];
}

export function pendingCloseBlocked(tree) {
  if (tree?.manual?.length) return '人工/未执行项未完成，不能关总单、不能写看板通过';
  if (tree?.collectionComplete === false || (tree?.skippedQueries || []).length) {
    return '收集不完整，不能关总单、不能写看板通过';
  }
  return null;
}

/** 任务树里每条 SC 都要有一条结论。 */
export function missingConclusions(tree, items = []) {
  const have = new Set((Array.isArray(items) ? items : []).map((item) => conclusionKey(item.ref, item.sc)));
  const missing = [];
  const seen = new Set();
  for (const issue of tree?.issues || []) {
    for (const item of issue.items || []) {
      const key = conclusionKey(item.source || issue.ref, item.sc);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!have.has(key)) missing.push(`${item.source || issue.ref} SC${item.sc}`);
    }
  }
  return missing;
}

/**
 * 通过类副作用（关总单/关子单、看板验收=通过）共用的宿主门禁。
 * 不信快照齐全、调用方声称已验、打勾或 frozen 标签：必须有覆盖整棵树的非空逐条证据。
 */
export function passSideEffectBlocked(tree, snapshot, items, extra = {}) {
  const pending = pendingCloseBlocked(tree);
  if (pending) return pending;
  const snapBlock = snapshotPassBlocked(snapshot, tree);
  if (snapBlock) return snapBlock;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return '通过类副作用需要完整逐条非空证据';
  const missing = missingConclusions(tree, list);
  if (missing.length) return `通过类副作用缺逐条结论：${missing.join('、')}`;
  try {
    guardOriginalPass(list, {
      snapshot,
      checkoutDir: extra.checkoutDir || snapshot?.checkoutDir,
      moduleUrl: extra.moduleUrl,
      materials: extra.materials,
      materialDir: extra.materialDir,
      compareMaterials: extra.compareMaterials,
    });
  } catch (error) {
    return String(error.message || error);
  }
  let status;
  try {
    status = deriveStatus(list, extra.needsHuman || extra.corrections || [], {
      tree,
      skippedQueries: extra.skippedQueries ?? tree?.skippedQueries,
      collectionComplete: extra.collectionComplete ?? tree?.collectionComplete,
      extracted: extra.extracted,
      manualTestRecords: extra.manualTestRecords,
      headSha: extra.headSha,
      profile: extra.profile,
      acceptors: extra.acceptors,
    });
  } catch (error) {
    return String(error.message || error);
  }
  if (status !== '通过') return `通过类副作用要求总评通过，当前是${status}`;
  return null;
}

export function tempRoots() {
  const out = [];
  for (const dir of [os.tmpdir(), '/tmp', '/var/tmp', process.env.TMPDIR, process.env.TMP, process.env.TEMP]) {
    if (typeof dir !== 'string' || !dir.trim()) continue;
    const resolved = path.resolve(dir);
    if (resolved === path.parse(resolved).root) continue;
    if (!out.includes(resolved)) out.push(resolved);
  }
  return out;
}

/** 从临时目录启动的副本不能冒充只读检出上的原验入口。 */
export function assertNotTempModule(moduleUrl) {
  const file = path.resolve(fileURLToPath(moduleUrl));
  for (const tmp of tempRoots()) {
    if (file === tmp || file.startsWith(`${tmp}${path.sep}`)) {
      throw new Error('只能跑只读检出上的 helper/collect/close/verdict，不能从临时目录启动');
    }
  }
}
