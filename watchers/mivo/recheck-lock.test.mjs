import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { recheckResult, scanOnce, watcherPaths } from './bin/mivo-watcher.mjs';

test('discover passes its actual PR lock into the recheck child', t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'mivo-discover-lock-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const head='a'.repeat(40),nodeId='PR_lockscan',now='2026-10-06T02:00:00.000Z';
  const pr={id:nodeId,number:7,state:'OPEN',isDraft:false,headRefOid:head,baseRefOid:'b'.repeat(40),headRefName:'fix/sample',baseRefName:'main',title:'sample',labels:[],url:'https://example.invalid/pr/7'};
  writePr(home,nodeId,{number:7,nodeId,sessionId:'sample-session',headRefOid:head,headRefName:pr.headRefName,eligibility:'active',eligibilityInitialized:true,lastDispatch:{dispatchId:'sample-task'},activeTask:{dispatchId:'sample-task',head,status:'waiting-ci',evidenceVersion:2}});
  fs.mkdirSync(path.join(home,'state','results'),{recursive:true});
  const result={schemaVersion:2,kind:'mivo-repair-result',dispatchId:'sample-task',nodeId,number:7,repo:'example-org/example-plugin',sessionId:'sample-session',head,status:'waiting-ci',observedAt:now,receiptId:'sample-receipt'};
  fs.writeFileSync(path.join(home,'state','results','sample-task.json'),JSON.stringify(result));
  const discover=acquireLock(home,'discover');t.after(()=>discover.release());
  const old=process.env[PR_LOCK_TOKEN_ENV];process.env[PR_LOCK_TOKEN_ENV]=discover.token;
  t.after(()=>{if(old===undefined)delete process.env[PR_LOCK_TOKEN_ENV];else process.env[PR_LOCK_TOKEN_ENV]=old});
  let rechecks=0;
  const report=scanOnce({mode:'discover',now,enabled:true,allowDispatch:true,paths:watcherPaths(home),dispatchFn:()=>{assert.fail('must reuse existing session without a new delivery')},
    ghFn:a=>{if(a[0]==='pr'&&a[1]==='list')return JSON.stringify([pr]);if(a[1]==='user')return 'ExampleUser';if(a[1]==='graphql')return JSON.stringify({data:{node:{...pr,comments:{totalCount:0,nodes:[]},reviews:{totalCount:0,nodes:[]},reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}},commits:{nodes:[]},labels:{nodes:[],pageInfo:{hasNextPage:false}}}}});throw Error('unexpected fixture API')},
    collect:()=>({pr:{...pr,sameRepository:true,isCrossRepository:true,headRepositoryOwner:{login:'ExampleUser'},headRepository:{name:'cindy-fork'},author:{login:'ExampleUser'},releaseEpoch:'e'},comments:[],reviews:[],threads:[],checks:[],labels:[],mergeable:'MERGEABLE',admissionVerified:true,mergeReady:false,ci:{status:'pending',required:[]}}),
    recheckFn:({prLockToken})=>{rechecks++;assert.ok(prLockToken);assert.notEqual(prLockToken,discover.token);
      const file=path.join(home,'state','locks','pr-'+nodeId+'.lock');assert.equal(fs.readFileSync(file,'utf8').trim().split(/\s+/)[2],prLockToken);return result;},
  });
  assert.equal(rechecks,1,JSON.stringify({report,state:readPr(home,nodeId)}));
});

import { acquireLock, PR_LOCK_TOKEN_ENV, readPr, writePr } from './bin/mivo-state.mjs';
import { repairPaths, watchWorktreePath } from './bin/mivo-repair.mjs';
test('real recheck child writes under the PR lock without releasing parent ownership', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mivo-recheck-lock-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home'),plugin=path.join(root,'plugin'),worktree=watchWorktreePath(plugin,7);
 const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull};
 const git=(...a)=>execFileSync('git',a,{env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 fs.mkdirSync(worktree,{recursive:true});git('init','-b','watch/pr-7',worktree);
 fs.writeFileSync(path.join(worktree,'sample.txt'),'fixture\n');git('-C',worktree,'add','.');
 git('-C',worktree,'-c','user.name=Example User','-c','user.email=example@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture');
 const head=git('-C',worktree,'rev-parse','HEAD'),repo='example-org/example-plugin',headRepo='example-org/example-plugin';
 git('-C',worktree,'remote','add','origin','https://github.com/'+headRepo+'.git');
 git('-C',worktree,'update-ref','refs/remotes/origin/fix/sample',head);git('-C',worktree,'branch','--set-upstream-to=origin/fix/sample');
 const paths=repairPaths(home);fs.mkdirSync(paths.tasks,{recursive:true});
 const task={dispatchId:'sample-task',nodeId:'PR_sample',number:7,repo,headRefOid:head,headRefName:'fix/sample',feedback:[],};
 fs.writeFileSync(path.join(paths.tasks,'sample-task.json'),JSON.stringify(task));
 const previous={activeTask:{dispatchId:task.dispatchId,head}};writePr(home,task.nodeId,{...previous,nodeId:task.nodeId,number:7,sessionId:'sample-session'});
 fs.mkdirSync(paths.results,{recursive:true});
 fs.writeFileSync(path.join(paths.results,'sample-task.json'),JSON.stringify({schemaVersion:2,kind:'mivo-repair-result',...task,sessionId:'sample-session',head,status:'waiting-ci',scs:[{id:'scope',status:'no-change',feedbackKeys:[],evidence:['No code repair requested']}],keel:{status:'not-required-legacy-task'},verification:{status:'not-required-no-change',head}}));
 const gh=path.join(root,'fake-gh'),gitBin=path.join(root,'fake-git');
 const ghCode="const a=process.argv.slice(2),h=process.env.FIXTURE_HEAD;if(a[0]==='pr'&&a[1]==='view')console.log(JSON.stringify({id:'PR_sample',number:7,state:'OPEN',isDraft:false,headRefOid:h,headRefName:'fix/sample',baseRefOid:h,baseRefName:'main'}));else{console.error('fixture CI unavailable');process.exit(1)}";
 const gitCode="const a=process.argv.slice(2);if(a[0]==='ls-remote')console.log(process.env.FIXTURE_HEAD+'\\trefs/heads/fix/sample');else{const r=require('node:child_process').spawnSync('git',a,{env:process.env,encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)}";
 fs.writeFileSync(gh,'#!'+process.execPath+'\n'+ghCode,{mode:0o700});fs.writeFileSync(gitBin,'#!'+process.execPath+'\n'+gitCode,{mode:0o700});
 const vars={GH_BIN:gh,GIT_BIN:gitBin,FIXTURE_HEAD:head,MIVO_WATCHER_HOME:home,MIVO_PLUGIN_REPO:plugin,MIVO_PR_LOCK_TOKEN:''};
 const before=Object.fromEntries(Object.keys(vars).map(k=>[k,process.env[k]]));
 for(const [k,v]of Object.entries(vars))process.env[k]=v;
 t.after(()=>{for(const[k,v]of Object.entries(before)){if(v===undefined)delete process.env[k];else process.env[k]=v}});
 const discover=acquireLock(home,'discover'),pr=acquireLock(home,'pr-PR_sample');t.after(()=>{pr.release();discover.release()});
 process.env[PR_LOCK_TOKEN_ENV]=discover.token;const args={paths:{home,stateDir:path.join(home,'state')},previous,timeoutMs:10000};
 assert.throws(()=>recheckResult(args));const result=recheckResult({...args,prLockToken:pr.token});
 assert.equal(result.status,'waiting-ci');assert.equal(result.keel.status,'not-required-legacy-task');assert.equal(readPr(home,task.nodeId).sessionId,'sample-session');
 assert.equal(process.env[PR_LOCK_TOKEN_ENV],discover.token);assert.equal(acquireLock(home,'pr-PR_sample',{}).held,true);
});
