// Deployment drift. The runtime bin/ is copied from this repository, not checked out, so a partial copy looks healthy
// (2026-11-11: mivo-watcher.mjs was current while mivo-pr-policy.mjs was days behind, and PRs into integration/*
// sat in required-policy-unknown for two days). deploy.mjs writes deployments/current.json after every install:
// the release id, the source commit and the sha256 of every installed file. Once a day the watcher compares it with
// the files actually in bin/ and tells a person once per distinct drift. A file changed on purpose on this machine
// is registered as a local patch (its sha256) and is not reported while it stays that way.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const CURRENT_MANIFEST = path.join('deployments', 'current.json');
const CHECK_STATE = path.join('state', 'deploy-drift.json');
const SHA = /^[a-f0-9]{64}$/;

function fileSha(file) {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function readDeployManifest(home) {
  const file = path.join(home, CURRENT_MANIFEST);
  if (!fs.existsSync(file)) return null;
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  const files = manifest?.files;
  if (manifest?.version !== 1 || !Array.isArray(files) || files.length === 0
    || !files.every((item) => typeof item?.name === 'string' && path.basename(item.name) === item.name && SHA.test(item.sha256))) {
    throw new Error(`deploy manifest ${CURRENT_MANIFEST} is malformed`);
  }
  return manifest;
}

export function writeDeployManifest({ home, release, sourceCommit = null, sourceDirty = null, files, at = new Date().toISOString() }) {
  const manifest = { version: 1, release, sourceCommit, sourceDirty, at,
    files: files.map(({ name, sha256 }) => ({ name, sha256 })), localPatches: {} };
  writeJsonAtomic(path.join(home, CURRENT_MANIFEST), manifest);
  return manifest;
}

// Compares the manifest with bin/. `no-manifest` is a runtime deployed before the manifest existed; `unreadable`
// is a manifest that cannot be trusted, reported like drift.
export function deploymentDrift({ home, binDir = path.join(home, 'bin') }) {
  let manifest;
  try {
    manifest = readDeployManifest(home);
  } catch (error) {
    return { status: 'unreadable', reason: String(error?.message ?? error).slice(0, 200), drifted: [] };
  }
  if (!manifest) return { status: 'no-manifest', drifted: [] };
  const patches = manifest.localPatches && typeof manifest.localPatches === 'object' ? manifest.localPatches : {};
  const drifted = [];
  for (const { name, sha256 } of manifest.files) {
    const actual = fileSha(path.join(binDir, name));
    if (actual === sha256) continue;
    if (actual && patches[name]?.sha256 === actual) continue;
    drifted.push({ name, kind: actual ? 'changed' : 'missing', expected: sha256, actual });
  }
  return { status: drifted.length ? 'drift' : 'ok', release: manifest.release ?? null,
    sourceCommit: manifest.sourceCommit ?? null, drifted };
}

export function driftNoticeId(result) {
  const key = JSON.stringify({ status: result.status, release: result.release ?? null, reason: result.reason ?? null,
    drifted: (result.drifted ?? []).map(({ name, kind, actual }) => [name, kind, actual]) });
  return `deploy-drift:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

// Runs the comparison at most once per UTC day. `notify` receives one event per distinct drift; the notice queue
// drops an id it has already sent, so the same drift is reported once even across days.
export function checkDeploymentDriftDaily({ home, binDir, now, notify }) {
  const day = String(now).slice(0, 10);
  const stateFile = path.join(home, CHECK_STATE);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { last = null; }
  if (last?.day === day) return { status: 'skipped', day };
  const result = deploymentDrift({ home, binDir });
  let noticeId = null;
  if (result.status === 'drift' || result.status === 'unreadable') {
    noticeId = driftNoticeId(result);
    notify({ kind: 'deploy-drift', id: noticeId, release: result.release ?? null, sourceCommit: result.sourceCommit ?? null,
      reason: result.reason ?? null, files: result.drifted.map(({ name, kind }) => ({ name, kind })) });
  }
  writeJsonAtomic(stateFile, { day, at: now, status: result.status, noticeId, drifted: result.drifted.map(({ name, kind }) => ({ name, kind })) });
  return { ...result, day, noticeId };
}

// A file changed on purpose on this machine. The current bytes are recorded; any later change is drift again.
export function registerLocalPatch({ home, name, binDir = path.join(home, 'bin'), at = new Date().toISOString() }) {
  const manifest = readDeployManifest(home);
  if (!manifest) throw new Error(`no ${CURRENT_MANIFEST}: deploy with deploy.mjs first`);
  const entry = manifest.files.find((item) => item.name === name);
  if (!entry) throw new Error(`${name} is not a deployed file`);
  const actual = fileSha(path.join(binDir, name));
  if (!actual) throw new Error(`${name} is missing from bin/: a missing file cannot be a local patch`);
  if (actual === entry.sha256) throw new Error(`${name} matches the deployed file: nothing to register`);
  const next = { ...manifest, localPatches: { ...(manifest.localPatches ?? {}), [name]: { sha256: actual, at } } };
  writeJsonAtomic(path.join(home, CURRENT_MANIFEST), next);
  return next.localPatches[name];
}
