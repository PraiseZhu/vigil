import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {lifelineFeedback} from './bin/mivo-lifeline-source.mjs';
import {feedbackRepairPolicy} from './bin/mivo-feedback-policy.mjs';
import {assertTaskRepairScope} from './bin/mivo-repair.mjs';
import {feedbackItems,newFeedback,processPr,watcherPaths,REPO} from './bin/mivo-watcher.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const save = (file,value) => fs.writeFileSync(file,JSON.stringify(value));
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'vigil-doctor-'))),stateRoot=path.join(root,'state'),evidenceRoot=path.join(root,'evidence');
  fs.mkdirSync(stateRoot);fs.mkdirSync(evidenceRoot);
  const configPath=path.join(root,'config.json'),statePath=path.join(stateRoot,'lifeline-state.json'),evidencePath=path.join(evidenceRoot,'failure.json');
  fs.writeFileSync(evidencePath,'{"independentlyReproduced":true}');
  const key='a'.repeat(24),sha='b'.repeat(40),sourceSha='c'.repeat(40),evidenceSha256=hash(fs.readFileSync(evidencePath)),classifiedAt=Date.now()-1000;
  const config={schemaVersion:1,repo:REPO,stateRoot,evidenceRoot,authorization:{repair:'confirmed P0/P1 only',push:true}};
  const d={key,repo:REPO,caseId:'storage.original',outcomeCode:'ORIGINAL_MISSING',phase:'repair',severity:'P1',ownerSessionId:'original-owner',generation:1,
    pr:{repo:REPO,number:900,headSha:sha},github:{number:900,state:'OPEN',isDraft:false,headSha:sha},
    observations:[{id:'B',repo:REPO,caseId:'storage.original',status:'PRODUCT_FAIL',sourceSha,evidence:{path:evidencePath,sha256:evidenceSha256}}],
    classificationReason:{observationId:'B',sourceSha,evidence:evidenceSha256,at:classifiedAt,reason:'independent fixture failure',trigger:'supported fixture save/read',impact:'original unavailable'}};
  const state={schemaVersion:1,revision:1,defects:{[key]:d}};save(configPath,config);save(statePath,state);
  const previous=process.env.MIVO_WATCHER_LIFELINE_CONFIG;process.env.MIVO_WATCHER_LIFELINE_CONFIG=configPath;
  t.after(()=>{if(previous===undefined)delete process.env.MIVO_WATCHER_LIFELINE_CONFIG;else process.env.MIVO_WATCHER_LIFELINE_CONFIG=previous;fs.rmSync(root,{recursive:true,force:true});});
  const pr={repo:REPO,id:'PR_fixture',number:900,title:'Fixture Ready repair',url:`https://github.com/${REPO}/pull/900`,headRefOid:sha,baseRefOid:'d'.repeat(40),headRefName:'fix/fixture',state:'OPEN',isDraft:false,author:{login:'ExampleUser'},sameRepository:true,releaseEpoch:'fixture'};
  return {root,configPath,statePath,evidencePath,key,d,state,config,pr,write:()=>save(statePath,state)};
}
test('confirmed Doctor failure reaches the existing mini owner with repair permission and no duplicate delivery',t=>{
  const f=fixture(t),entry=lifelineFeedback(f.pr);assert.equal(entry.error,null);assert.equal(entry.items.length,1);
  const item=entry.items[0];assert.equal(item.source,'lifeline-doctor');assert.equal(feedbackRepairPolicy(item,{headSha:f.pr.headRefOid}).canChangeCode,true);
  assert.equal(assertTaskRepairScope({headRefOid:f.pr.headRefOid,feedback:[item]},'e'.repeat(40)).canChangeCode,true);
  const first=newFeedback({},entry.items);assert.equal(first.fresh.length,1);assert.equal(newFeedback(first.cursor,lifelineFeedback(f.pr).items).fresh.length,0);
  const home=path.join(f.root,'shadow'),paths=watcherPaths(home);fs.mkdirSync(path.join(home,'config'),{recursive:true});
  const now=new Date().toISOString(),watchState={version:2,repo:REPO,prs:{[f.pr.id]:{nodeId:f.pr.id,number:900,sessionId:'existing-mini-session',claimedAt:now,headRefOid:f.pr.headRefOid,eligibility:'active',eligibilityInitialized:true,admissionVerified:true,admissionEpoch:'fixture',wasDraft:false,feedbackCursor:{},repairRounds:0,activeTask:{status:'complete',head:f.pr.headRefOid,resultHeadCurrent:true}}}};
  const snapshot={pr:f.pr,checks:[],requiredChecks:[],ci:{status:'green',required:[]},comments:[],reviews:[],threads:[],labels:[],mergeable:'MERGEABLE',admissionVerified:true,requiredChecksGreen:true,mergeReady:true,policy:{status:'verified'}};
  const report=[],events=[],forbidden=()=>{throw Error('external operation must not run in a fixture');};
  const listed={...f.pr};delete listed.state;delete listed.author;
  const run=processPr({pr:listed,state:watchState,paths,now,events,report,viewer:'ExampleUser',dryRun:true,dispatchFn:forbidden,collect:()=>snapshot,ghFn:forbidden,recheckFn:forbidden,ownershipSnapshot:forbidden,maintenanceSessionId:null,remaining:()=>120000,deadline:Date.now()+120000,clock:Date.now,resumeCursor:0,allowCreate:false,forceCreate:false});
  let next=run.next();while(!next.done)next=run.next(next.value());
  assert.equal(report[0].fresh,1);assert.equal(report[0].dispatch.reason,'dry-run');assert.equal(report[0].dispatch.pending.params.target_session_id,'existing-mini-session');
  assert.match(report[0].dispatch.pending.params.message,/OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY/);
  assert.equal(snapshot.mergeReady,false);
});
test('repair helper rejects a cached permission after evidence, owner generation or classification changes',t=>{
  const f=fixture(t),item=lifelineFeedback(f.pr).items[0],task={headRefOid:f.pr.headRefOid,feedback:[item],repairPolicy:{canChangeCode:true}};
  f.d.generation++;f.write();assert.throws(()=>assertTaskRepairScope(task,'e'.repeat(40)),/REPAIR_SCOPE_NO_CODE/);
  f.d.generation--;f.write();fs.writeFileSync(f.evidencePath,'changed bytes');assert.throws(()=>assertTaskRepairScope(task,'e'.repeat(40)),/REPAIR_SCOPE_NO_CODE/);
  fs.writeFileSync(f.evidencePath,'{"independentlyReproduced":true}');f.d.severity='P2';f.write();assert.throws(()=>assertTaskRepairScope(task,'e'.repeat(40)),/REPAIR_SCOPE_NO_CODE/);
});
test('P2, unconfirmed, waiting, wrong PR/head, absent authorization and unconfigured sources cannot grant code changes',t=>{
  const f=fixture(t),original=structuredClone(f.d);
  for(const update of [{severity:'P2'},{severity:'unverified'},{phase:'awaiting-deploy'},{github:{...f.d.github,headSha:'f'.repeat(40)}},{pr:{...f.d.pr,number:901}}]){
    Object.assign(f.d,structuredClone(original),update);f.write();assert.equal(lifelineFeedback(f.pr).items.length,0);
  }
  Object.assign(f.d,original);f.write();f.config.authorization.push=false;save(f.configPath,f.config);assert.equal(lifelineFeedback(f.pr).items.length,0);
  delete process.env.MIVO_WATCHER_LIFELINE_CONFIG;assert.equal(lifelineFeedback(f.pr).items.length,0);
  assert.equal(feedbackRepairPolicy({source:'lifeline-doctor',sha:f.pr.headRefOid,doctor:{severity:'P1',repo:REPO},verified:true},{headSha:f.pr.headRefOid}).canChangeCode,false);
});
test('unfinished confirmed repair remains receivable while another version is investigated; ordinary author P1 comments retain no-code policy',t=>{
  const f=fixture(t);f.d.resumeProgress={phase:'repair',severity:'P1',classificationReason:f.d.classificationReason};f.d.phase='investigation';f.d.severity='unverified';f.write();
  assert.equal(lifelineFeedback(f.pr).items.length,1);
  const items=feedbackItems({pr:f.pr,comments:[{id:1,body:'P1: normal author handoff text',user:{login:'ExampleUser',type:'User'}}]});
  assert.equal(items[0].repairPolicy.canChangeCode,false);
  assert.equal(items[0].repairPolicy.reason,'unverified-review-source');
});
