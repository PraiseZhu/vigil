// Operator-configured local input. GitHub text never selects this source.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {optionalConfig} from './profile.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const high = severity => ['P0','P1'].includes(severity);
const validSha = value => /^[a-f0-9]{40}$/.test(value ?? '');
function plainFile(file) {
  if (!path.isAbsolute(file ?? '') || fs.realpathSync(file) !== path.resolve(file)
    || !fs.lstatSync(file).isFile()) throw Error('doctor-source-path-invalid');
  return file;
}
function evidenceFile(root,file) {
  if (!path.isAbsolute(root ?? '') || fs.realpathSync(root) !== path.resolve(root)) throw Error('doctor-evidence-root-invalid');
  const rel = path.relative(root,path.resolve(file ?? ''));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw Error('doctor-evidence-outside-root');
  return plainFile(file);
}
function context(repo) {
  const file = optionalConfig('lifelineConfigPath',{envVar:'MIVO_WATCHER_LIFELINE_CONFIG'});
  if (!file) return null;
  const config = JSON.parse(fs.readFileSync(plainFile(file),'utf8'));
  const target = optionalConfig('targetRepo',{envVar:'MIVO_WATCHER_TARGET_REPO'});
  if (config.schemaVersion !== 1 || config.repo !== repo || repo !== target || config.authorization?.push !== true
    || config.authorization.repair !== 'confirmed P0/P1 only') throw Error('doctor-source-not-authorized');
  if (!path.isAbsolute(config.stateRoot ?? '') || fs.realpathSync(config.stateRoot) !== path.resolve(config.stateRoot)) throw Error('doctor-state-root-invalid');
  const state = JSON.parse(fs.readFileSync(plainFile(path.join(config.stateRoot,'lifeline-state.json')),'utf8'));
  if (!Number.isSafeInteger(state.revision) || !state.defects) throw Error('doctor-state-invalid');
  if (state.schemaVersion === 2) {
    if (typeof state.controlEpoch !== 'string' || !state.controlEpoch) throw Error('doctor-state-invalid');
  } else if (state.schemaVersion !== 1) throw Error('doctor-state-invalid');
  return {config,state};
}
function ownershipFields(d,state) {
  if (state.schemaVersion !== 2) return {};
  const controlEpoch = state.controlEpoch;
  if (d.ownershipMode === 'legacy') {
    if (d.workId != null) return null;
    return {controlEpoch,ownershipMode:'legacy',workId:null};
  }
  if (d.ownershipMode !== 'work-item' || typeof d.workId !== 'string' || !d.workId) return null;
  const item = state.workItems?.[d.workId];
  if (!item || item.id !== d.workId || item.defectKey !== d.key || item.controlEpoch !== controlEpoch
    || item.ownerSessionId !== d.ownerSessionId || item.generation !== d.generation
    || typeof item.status !== 'string' || !item.status) return null;
  return {controlEpoch,ownershipMode:'work-item',workId:d.workId};
}
function statement(d,ctx) {
  const {config,state} = ctx;
  const progress = d.phase === 'repair' ? d : d.phase === 'investigation' && d.resumeProgress?.phase === 'repair' ? d.resumeProgress : null;
  const reason = progress?.classificationReason;
  if (!high(progress?.severity) || !reason || !Number.isFinite(reason.at) || reason.at > Date.now()+60000
    || !/^[a-zA-Z0-9-]{1,100}$/.test(d.ownerSessionId ?? '') || !Number.isSafeInteger(d.generation) || d.generation < 1) return null;
  const ownership = ownershipFields(d,state);
  if (!ownership) return null;
  const o = d.observations?.find(o => o.id === reason.observationId && o.sourceSha === reason.sourceSha && o.evidence?.sha256 === reason.evidence);
  if (!o || o.status !== 'PRODUCT_FAIL' || o.repo !== config.repo || !validSha(o.sourceSha)
    || !/^[a-f0-9]{64}$/.test(o.evidence.sha256 ?? '') || o.caseId !== d.caseId) throw Error('doctor-classification-not-bound');
  for (const field of ['reason','trigger','impact']) if (typeof reason[field] !== 'string' || !reason[field].trim() || reason[field].length > 3000) throw Error('doctor-classification-incomplete');
  if (hash(fs.readFileSync(evidenceFile(config.evidenceRoot,o.evidence.path))) !== o.evidence.sha256) throw Error('doctor-evidence-changed');
  return {key:d.key,repo:d.repo,number:d.pr.number,ownerSessionId:d.ownerSessionId,generation:d.generation,
    observationId:o.id,sourceSha:o.sourceSha,evidenceSha256:o.evidence.sha256,classifiedAt:reason.at,severity:progress.severity,
    caseId:d.caseId,outcomeCode:d.outcomeCode,...ownership};
}
export function lifelineFeedback(pr) {
  try {
    const ctx = context(pr.repo);
    if (!ctx || pr.state !== 'OPEN' || pr.isDraft || !validSha(pr.headRefOid)) return {items:[],error:null};
    const items = [];
    for (const [key,d] of Object.entries(ctx.state.defects)) {
      if (!/^[a-f0-9]{24}$/.test(key) || d.key !== key || d.repo !== pr.repo || d.pr?.repo !== pr.repo || d.pr?.number !== pr.number
        || d.github?.number !== pr.number || d.github.state !== 'OPEN' || d.github.isDraft !== false || d.github.headSha !== pr.headRefOid) continue;
      const proof = statement(d,ctx);
      if (!proof) continue;
      const stamp = hash(JSON.stringify(proof)), reason = (d.phase === 'repair' ? d : d.resumeProgress).classificationReason;
      items.push({source:'lifeline-doctor',nativeId:stamp,revision:stamp,contentHash:stamp,sha:pr.headRefOid,
        doctor:proof,body:`${proof.severity}: Confirmed local lifeline failure\nCase: ${proof.caseId}\nTrigger: ${reason.trigger}\nImpact: ${reason.impact}\nEvidence SHA-256: ${proof.evidenceSha256}\nFailed source: ${proof.sourceSha}\nReason: ${reason.reason}`});
    }
    return {items,error:null};
  } catch (error) { return {items:[],error:/^doctor-[a-z-]+$/.test(error.message ?? '') ? error.message : 'doctor-source-unavailable'}; }
}
// Re-read authority and bytes on every task use. Cached verified flags and
// caller-supplied JSON cannot grant this permission.
export function verifiedLifelineFeedback(item,{headSha}={}) {
  try {
    if (item?.source !== 'lifeline-doctor' || item.sha !== headSha || !validSha(headSha)) return false;
    const ctx = context(item.doctor?.repo);
    if (!ctx) return false;
    const d = ctx.state.defects[item.doctor.key];
    if (!d || d.repo !== item.doctor.repo || d.pr?.repo !== d.repo || d.pr?.number !== item.doctor.number) return false;
    const current = statement(d,ctx);
    return Boolean(current && JSON.stringify(current) === JSON.stringify(item.doctor)
      && hash(JSON.stringify(current)) === item.nativeId && item.contentHash === item.nativeId);
  } catch { return false; }
}
