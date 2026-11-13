#!/usr/bin/env node
// Source-only deployer. No scheduler or database writes; apply requires a saved preview.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {deploymentDrift,registerLocalPatch,writeDeployManifest,readDeployManifest} from './bin/mivo-deploy-drift.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RUNTIME='/path/to/your/runtime/mivo-watcher';
export const FILES=['mivo-pre-push.mjs','mivo-handoff.mjs','mivo-identity.mjs','mivo-lifeline-source.mjs','mivo-feedback-policy.mjs','mivo-ci.mjs','mivo-ci-triage.mjs','mivo-codeql-infra.mjs','mivo-ci-selfheal.mjs','mivo-deploy-drift.mjs','mivo-pr-policy.mjs','mivo-pr-snapshot.mjs','mivo-pr-actions.mjs','mivo-code-scanning.mjs','mivo-repair.mjs','mivo-validation-runtime.mjs','mivo-validation-evidence.mjs','mivo-validation-baseline.mjs','mivo-review-resolve.mjs','mivo-app-token.mjs','mivo-state.mjs','mivo-ownership.mjs','mivo-watcher.mjs','notify.mjs','public-review.mjs','session-title.mjs','profile.mjs','mivo-watch-script.py','protocol.py','session-title-maintenance.py'];
// Entry points actually spawned/imported directly by the runtime. Any relative import reachable
// from these (transitively) must be listed in FILES, or the runtime will 500 on `import()` with
// a healthy-looking manifest (2026-09-29 incident: mivo-review-resolve.mjs was imported by
// mivo-watcher.mjs but missing from FILES; verify() still reported all-green because it only
// hashes what's in FILES, never what the entry points actually require).
const ENTRY_POINTS=['mivo-watcher.mjs','mivo-repair.mjs','mivo-handoff.mjs','mivo-pre-push.mjs'];
const sha=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const requireValue=(v,m)=>{if(!v)throw Error(m);};
// Which source commit the installed files came from, for the drift manifest. Best effort: a copy outside git has none.
function sourceIdentity(sourceDir=here){
 try{
  const commit=execFileSync('git',['-C',sourceDir,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  const dirty=execFileSync('git',['-C',sourceDir,'status','--porcelain','--','bin'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()!=='';
  return {sourceCommit:/^[a-f0-9]{40}$/.test(commit)?commit:null,sourceDirty:dirty};
 }catch{return {sourceCommit:null,sourceDirty:null};}
}
export function sourceChanges(home, sourceDir=here){
 let previous=null,manifestError=null;
 try{previous=readDeployManifest(home)?.sourceCommit??null;}
 catch{manifestError='deployment manifest unavailable';}
 const current=sourceIdentity(sourceDir).sourceCommit;
 if(manifestError)return {from:null,to:current,commits:[],error:manifestError};
 if(!previous||!current||previous===current)return {from:previous,to:current,commits:[]};
 try{
  const output=execFileSync('git',['-C',sourceDir,'log','--format=%H%x09%s',`${previous}..${current}`],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  const commits=output.trim()?output.trim().split('\n').map(line=>{const [sha,...title]=line.split('\t');return {sha,title:title.join('\t')};}):[];
  return {from:previous,to:current,commits};
 }catch{return {from:previous,to:current,commits:null,error:'source history unavailable'};}
}
function relativeImportSpecs(file){
 if(!fs.existsSync(file))return [];
 const src=fs.readFileSync(file,'utf8');
 return [...src.matchAll(/from\s+['"](\.\.?\/[^'"]+)['"]/g)].map(m=>m[1]);
}
function isOutsideBin(name){
 return name.split(/[/\\]/).includes('..');
}
function importClosure(sourceDir,entry){
 const seen=new Set(),stack=[entry];
 while(stack.length){
  const name=stack.pop();
  if(seen.has(name))continue;
  seen.add(name);
  const file=path.join(sourceDir,name);
  for(const spec of relativeImportSpecs(file))stack.push(path.relative(sourceDir,path.resolve(path.dirname(file),spec)));
 }
 return seen;
}
function outsideModules(sourceDir){
 const out=new Set();
 for(const entry of ENTRY_POINTS){
  if(!FILES.includes(entry))continue;
  for(const name of importClosure(sourceDir,entry))if(isOutsideBin(name))out.add(name);
 }
 return out;
}
// bin/../../acceptance/bin/net-errors.mjs 落在 runtime home 的上一级。同一父目录下的 cindy 与 mivo 共用这一份。
function outsideDest(runtime,rel){
 return path.resolve(path.join(runtime,'bin'),rel);
}
function outsideBackupPath(record,rel){
 return path.join(record,'before','outside',rel.replaceAll('..','__up__'));
}
function backupOutsideModules(runtime,record,sourceDir=path.join(here,'bin')){
 const backups=[];
 for(const rel of outsideModules(sourceDir)){
  const dest=outsideDest(runtime,rel),existed=fs.existsSync(dest);
  if(existed){
   const backup=outsideBackupPath(record,rel);
   fs.mkdirSync(path.dirname(backup),{recursive:true,mode:0o700});
   fs.copyFileSync(dest,backup);
  }
  backups.push({rel,existed});
 }
 return backups;
}
function rollbackOutsideModules(runtime,record,backups){
 for(const {rel,existed} of [...backups].reverse()){
  const dest=outsideDest(runtime,rel);
  if(existed){
   const backup=outsideBackupPath(record,rel),tmp=dest+`.rollback-${process.pid}`;
   fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
   fs.copyFileSync(backup,tmp);fs.chmodSync(tmp,0o755);fs.renameSync(tmp,dest);
  }else if(fs.existsSync(dest))fs.unlinkSync(dest);
 }
}
function installOutsideModules(runtime,sourceDir=path.join(here,'bin')){
 for(const rel of outsideModules(sourceDir)){
  const src=path.resolve(sourceDir,rel),dest=outsideDest(runtime,rel);
  requireValue(fs.existsSync(src),`deploy missing companion module: ${rel}`);
  fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});
  const tmp=dest+`.install-${process.pid}`;
  fs.copyFileSync(src,tmp);fs.chmodSync(tmp,0o755);fs.renameSync(tmp,dest);
 }
}
export function checkManifestCompleteness(sourceDir=path.join(here,'bin')){
 const missing=new Set();
 for(const entry of ENTRY_POINTS){
  if(!FILES.includes(entry))continue;
  for(const name of importClosure(sourceDir,entry)){
   if(isOutsideBin(name)){if(!fs.existsSync(path.join(sourceDir,name)))missing.add(name);}
   else if(!FILES.includes(name))missing.add(name);
  }
 }
 requireValue(missing.size===0,`deploy manifest missing modules imported by entry points: ${[...missing].join(', ')}`);
}
export function verify(runtime,source=path.join(here,'bin')) {
 checkManifestCompleteness(source);
 const binFiles=FILES.map(name=>({name,source:sha(path.join(source,name)),runtime:sha(path.join(runtime,'bin',name))}));
 const extras=[...outsideModules(source)].sort().map(name=>({name,source:sha(path.resolve(source,name)),runtime:sha(outsideDest(runtime,name))}));
 return [...binFiles,...extras];
}
function identitiesFromState(state){
 const ids=Object.values(state.prs||{}).map(v=>v.sessionId).filter(Boolean).sort();
 requireValue(new Set(ids).size===ids.length&&ids.every(v=>/^[a-f0-9-]+$/.test(v)),'invalid session identities');return ids;
}
function identities(home){
 const prsDir=path.join(home,'state/prs');
 if(fs.existsSync(prsDir)){
  const ids=[];
  for(const name of fs.readdirSync(prsDir).filter(n=>n.endsWith('.json')).sort()){
   const entry=JSON.parse(fs.readFileSync(path.join(prsDir,name),'utf8'));
   if(entry?.sessionId)ids.push(entry.sessionId);
  }
  ids.sort();
  requireValue(new Set(ids).size===ids.length&&ids.every(v=>/^[a-f0-9-]+$/.test(v)),'invalid session identities');
  return ids;
 }
 const stateFile=path.join(home,'state/state.json');
 return identitiesFromState(JSON.parse(fs.readFileSync(stateFile)));
}
export function stateFingerprint(home){
 const index=path.join(home,'state/index.json'),prsDir=path.join(home,'state/prs');
 if(fs.existsSync(index)||fs.existsSync(prsDir)){
  const files=fs.existsSync(prsDir)?fs.readdirSync(prsDir).filter(n=>n.endsWith('.json')).sort():[];
  return createHash('sha256').update(JSON.stringify({
   index:sha(index),
   files:files.map(name=>({name,sha:sha(path.join(prsDir,name))})),
  })).digest('hex');
 }
 return sha(path.join(home,'state/state.json'));
}
function idle(database,ids){
 if(!ids.length)return;
 const rows=JSON.parse(execFileSync('sqlite3',['-readonly','-json',database,`select id,active_turn_pid from sessions where id in (${ids.map(v=>`'${v}'`).join(',')})`],{encoding:'utf8'}));
 requireValue(rows.length===ids.length&&rows.every(r=>r.active_turn_pid===null),'Host session active or missing');
}
export function validatePlan(plan,sourceDir=path.join(here,'bin')){
 checkManifestCompleteness(sourceDir);
 requireValue(plan?.version===1&&path.isAbsolute(plan.home)&&path.isAbsolute(plan.database)&&plan.database.endsWith('.db'),'invalid runtime/database');
 requireValue(/^[a-z0-9][a-z0-9-]{1,80}$/.test(plan.id),'invalid release id');
 const allowedOutside=outsideModules(sourceDir);
 const binItems=(plan.files??[]).filter(f=>FILES.includes(f.name));
 const extraItems=(plan.files??[]).filter(f=>!FILES.includes(f.name));
 requireValue(Array.isArray(plan.files)&&binItems.length===FILES.length&&new Set(binItems.map(f=>f.name)).size===FILES.length&&binItems.every(f=>/^[a-f0-9]{64}$/.test(f.source)&&(f.runtime===null||/^[a-f0-9]{64}$/.test(f.runtime))),'invalid artifact manifest');
 requireValue(extraItems.every(f=>allowedOutside.has(f.name)&&/^[a-f0-9]{64}$/.test(f.source)&&(f.runtime===null||/^[a-f0-9]{64}$/.test(f.runtime))),'invalid artifact manifest');
 requireValue(/^[a-f0-9]{64}$/.test(plan.stateSha),'missing state identity');
 requireValue(Array.isArray(plan.sessionIds),'missing session identities');
}
export function apply(plan){
 validatePlan(plan);
 const state=path.join(plan.home,'state/state.json'),lease=path.join(plan.home,'state/lease');
 const record=path.join(plan.home,'deployments',plan.id),owner=`${process.pid} ${plan.id}\n`;
 const check=()=>{
  requireValue(stateFingerprint(plan.home)===plan.stateSha,'state changed since preview; run preview and apply consecutively');
  requireValue(JSON.stringify(identities(plan.home))===JSON.stringify(plan.sessionIds),'session binding changed');
  idle(plan.database,plan.sessionIds);
  for(const item of plan.files){requireValue(sha(path.resolve(path.join(here,'bin'),item.name))===item.source,'source changed since preview');requireValue(sha(path.resolve(path.join(plan.home,'bin'),item.name))===item.runtime,'runtime changed since preview');}
 };
 check();
 // Never steal a live or unknown lease. Let the watcher recover stale leases.
 fs.writeFileSync(lease,owner,{flag:'wx',mode:0o600});
 const installed=[];
 let outsideBackups=[];
 try{
  check();requireValue(!fs.existsSync(record),'release id already exists');
  fs.mkdirSync(path.join(record,'before'),{recursive:true,mode:0o700});
  if(fs.existsSync(state))fs.copyFileSync(state,path.join(record,'before/state.json'));
  fs.writeFileSync(path.join(record,'manifest.json'),JSON.stringify(plan,null,2),{mode:0o600});
  for(const item of plan.files){
   if(isOutsideBin(item.name)||item.runtime===item.source)continue;
   const target=path.join(plan.home,'bin',item.name),tmp=target+`.install-${process.pid}`;
   requireValue(sha(target)===item.runtime&&sha(path.join(here,'bin',item.name))===item.source,'artifact changed during install');
   if(item.runtime)fs.copyFileSync(target,path.join(record,'before',item.name));
   fs.copyFileSync(path.join(here,'bin',item.name),tmp);fs.chmodSync(tmp,0o755);fs.renameSync(tmp,target);installed.push(item);
  }
  outsideBackups=backupOutsideModules(plan.home,record);
  installOutsideModules(plan.home);
  requireValue(stateFingerprint(plan.home)===plan.stateSha,'state changed during install');idle(plan.database,plan.sessionIds);
  requireValue(verify(plan.home).every(v=>v.source===v.runtime),'installed hash mismatch');
  // The watcher compares bin/ with this once a day (mivo-deploy-drift.mjs); a partial copy no longer looks healthy.
  writeDeployManifest({home:plan.home,release:plan.id,...sourceIdentity(),files:plan.files.filter(item=>FILES.includes(item.name)).map(item=>({name:item.name,sha256:item.source}))});
  const receipt={status:'installed',at:new Date().toISOString(),files:plan.files,stateChanged:false,sessionIds:plan.sessionIds,schedulerChanged:false,databaseChanged:false};
  fs.writeFileSync(path.join(record,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});return receipt;
 }catch(error){
  for(const item of installed.reverse()){
   const target=path.join(plan.home,'bin',item.name),tmp=target+`.rollback-${process.pid}`;
   if(item.runtime){fs.copyFileSync(path.join(record,'before',item.name),tmp);fs.chmodSync(tmp,0o755);fs.renameSync(tmp,target);}else fs.unlinkSync(target);
  }
  rollbackOutsideModules(plan.home,record,outsideBackups);throw error;
 }finally{if(fs.existsSync(lease)&&fs.readFileSync(lease,'utf8')===owner)fs.unlinkSync(lease);}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),mode=args[0],get=name=>args[args.indexOf(name)+1];
 if(mode==='verify'){
  const runtime=get('--home');requireValue(args.includes('--home')&&path.isAbsolute(runtime),'--home required');
  const files=verify(runtime);console.log(JSON.stringify({files,match:files.every(v=>v.source&&v.source===v.runtime)}));
  if(!files.every(v=>v.source&&v.source===v.runtime))process.exitCode=1;
 }else if(mode==='preview'){
  const home=get('--home'),database=get('--database'),id=get('--id'),file=get('--plan');
  requireValue(['--home','--database','--id','--plan'].every(k=>args.includes(k))&&path.isAbsolute(file),'explicit home/database/id/absolute plan required');
  const plan={version:1,home,database,id,files:verify(home),stateSha:stateFingerprint(home),sessionIds:identities(home)};
  validatePlan(plan);idle(database,plan.sessionIds);fs.writeFileSync(file,JSON.stringify(plan,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify({mode:'preview',plan:file,files:plan.files.length,source:sourceChanges(home)}));
 }else if(mode==='drift'){
  const home=get('--home');requireValue(args.includes('--home')&&path.isAbsolute(home),'--home required');
  const result=deploymentDrift({home});console.log(JSON.stringify(result));
  if(result.status!=='ok')process.exitCode=1;
 }else if(mode==='register-patch'){
  const home=get('--home'),name=get('--file');requireValue(args.includes('--home')&&path.isAbsolute(home)&&args.includes('--file'),'--home and --file required');
  console.log(JSON.stringify({file:name,...registerLocalPatch({home,name})}));
 }else if(mode==='apply'){
  requireValue(args.includes('--plan'),'--plan required');console.log(JSON.stringify(apply(JSON.parse(fs.readFileSync(get('--plan'))))));
 }else throw Error(`use verify --home, drift --home, register-patch --home --file, preview --home --database --id --plan, or apply --plan (example runtime ${DEFAULT_RUNTIME})`);
}
