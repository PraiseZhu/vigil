import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {FILES,verify,validatePlan,apply,stateFingerprint} from './deploy.mjs';
function importDeployed(file){
 return spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(pathToFileURL(file).href)})`],{encoding:'utf8',timeout:20000,env:process.env});
}
function outsideNetErrors(home){
 return path.resolve(path.join(home,'bin'),'..','..','acceptance','bin','net-errors.mjs');
}
function failAfterCompanion(){
 const write=fs.writeFileSync;
 fs.writeFileSync=(file,...args)=>{
  if(String(file).endsWith('receipt.json'))throw Error('injected after companion');
  return write(file,...args);
 };
 return ()=>{fs.writeFileSync=write;};
}
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-deploy-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home');
 fs.mkdirSync(path.join(home,'bin'),{recursive:true});fs.mkdirSync(path.join(home,'state'),{recursive:true});
 fs.writeFileSync(path.join(home,'state/state.json'),JSON.stringify({prs:{}}));
 for(const name of FILES)fs.writeFileSync(path.join(home,'bin',name),'old bytes');
 const state=fs.readFileSync(path.join(home,'state/state.json'));
 const plan={version:1,home,database:path.join(home,'metadata.db'),id:'fixture-release',files:verify(home),stateSha:createHash('sha256').update(state).digest('hex'),sessionIds:[]};
 return {home,plan,state};
}
test('full source deploy preserves state and verifies all artifact hashes',t=>{
 const f=fixture(t),r=apply(f.plan);assert.equal(r.status,'installed');assert.equal(r.stateChanged,false);assert.ok(verify(f.home).every(v=>v.source===v.runtime));assert.equal(verify(f.home).filter(v=>FILES.includes(v.name)).length,FILES.length);assert.deepEqual(fs.readFileSync(path.join(f.home,'state/state.json')),f.state);
 assert.ok(FILES.includes('mivo-feedback-policy.mjs'));
 assert.ok(FILES.includes('mivo-state.mjs'));
 assert.ok(FILES.includes('mivo-ownership.mjs'));
 assert.ok(FILES.includes('mivo-app-token.mjs'));
 assert.equal(fs.readFileSync(path.join(f.home,'deployments/fixture-release/before/mivo-watcher.mjs'),'utf8'),'old bytes');
});
test('state drift and source drift refuse before lease',t=>{
 const f=fixture(t);f.plan.files[0].source='a'.repeat(64);assert.throws(()=>apply(f.plan),/source changed/);assert.equal(fs.existsSync(path.join(f.home,'state/lease')),false);
 f.plan.files=verify(f.home);fs.writeFileSync(path.join(f.home,'state/state.json'),'{}');assert.throws(()=>apply(f.plan),/state changed/);
});
test('held lease is never stolen',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.home,'state/lease'),'someone');assert.throws(()=>apply(f.plan),/EEXIST/);assert.equal(fs.readFileSync(path.join(f.home,'state/lease'),'utf8'),'someone');
});
test('artifact injection or missing dependency rejected',t=>{
 const {plan}=fixture(t);assert.throws(()=>validatePlan({...plan,files:plan.files.slice(1)}),/manifest/);assert.throws(()=>validatePlan({...plan,files:[{...plan.files[0],name:'../state.json'},...plan.files.slice(1)]}),/manifest/);
});
test('mid-install failure rolls back installed files and releases own lease',t=>{
 const f=fixture(t),rename=fs.renameSync;let failed=false;
 fs.renameSync=(from,to)=>{if(!failed&&to.endsWith('mivo-pr-policy.mjs')&&from.includes('.install-')){failed=true;throw Error('injected failure');}return rename(from,to);};
 try{assert.throws(()=>apply(f.plan),/injected/);}finally{fs.renameSync=rename;}
 for(const name of FILES)assert.equal(fs.readFileSync(path.join(f.home,'bin',name),'utf8'),'old bytes');
 assert.deepEqual(fs.readFileSync(path.join(f.home,'state/state.json')),f.state);assert.equal(fs.existsSync(path.join(f.home,'state/lease')),false);
});
test('legacy deploy symlink invokes CLI and cannot silently succeed',t=>{
 const f=fixture(t),link=path.join(f.home,'legacy-deploy.mjs');fs.symlinkSync(fileURLToPath(new URL('./deploy.mjs',import.meta.url)),link);
 const result=spawnSync(process.execPath,[link,'verify','--home',f.home],{encoding:'utf8'});
 assert.equal(result.status,1);assert.equal(JSON.parse(result.stdout).match,false);
});
test('new policy artifact is installed and removed again on failed deployment',t=>{
 const f=fixture(t),name='mivo-feedback-policy.mjs';
 fs.unlinkSync(path.join(f.home,'bin',name));f.plan.files=verify(f.home);
 assert.equal(f.plan.files.find(item=>item.name===name).runtime,null);
 const rename=fs.renameSync;let failed=false;
 fs.renameSync=(from,to)=>{if(!failed&&to.endsWith('mivo-pr-policy.mjs')&&from.includes('.install-')){failed=true;throw Error('injected after new module');}return rename(from,to);};
 try{assert.throws(()=>apply(f.plan),/injected after new module/);}finally{fs.renameSync=rename;}
 assert.equal(fs.existsSync(path.join(f.home,'bin',name)),false);
 assert.deepEqual(fs.readFileSync(path.join(f.home,'state/state.json')),f.state);
 assert.equal(fs.existsSync(path.join(f.home,'state/lease')),false);
});
test('state fingerprint includes PR file content hashes',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'watcher-fp-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'state/prs'),{recursive:true});
 fs.writeFileSync(path.join(home,'state/index.json'),'{"version":2}\n');
 fs.writeFileSync(path.join(home,'state/prs/PR_1.json'),'{"sessionId":"a"}\n');
 const first=stateFingerprint(home);
 fs.writeFileSync(path.join(home,'state/prs/PR_1.json'),'{"sessionId":"b"}\n');
 assert.notEqual(stateFingerprint(home),first);
});
test('#238 SC7 中途失败回滚：已有的仓外 net-errors.mjs 恢复成部署前内容', t => {
 const f=fixture(t),outside=outsideNetErrors(f.home);
 fs.mkdirSync(path.dirname(outside),{recursive:true});
 fs.writeFileSync(outside,'previous companion\n');
 f.plan.files=verify(f.home);
 const restore=failAfterCompanion();
 try{assert.throws(()=>apply(f.plan),/injected after companion/);}finally{restore();}
 assert.equal(fs.readFileSync(outside,'utf8'),'previous companion\n');
 assert.equal(fs.existsSync(path.join(f.home,'state/lease')),false);
});
test('#238 SC7 中途失败回滚：原先没有仓外 net-errors.mjs 则删掉', t => {
 const f=fixture(t),outside=outsideNetErrors(f.home);
 assert.equal(fs.existsSync(outside),false);
 const restore=failAfterCompanion();
 try{assert.throws(()=>apply(f.plan),/injected after companion/);}finally{restore();}
 assert.equal(fs.existsSync(outside),false);
 assert.equal(fs.existsSync(path.join(f.home,'state/lease')),false);
});
test('#238 SC7 成功部署后改仓外 net-errors.mjs，verify 报不一致', t => {
 const f=fixture(t);apply(f.plan);
 const extra=verify(f.home).find(v=>String(v.name).includes('net-errors.mjs'));
 assert.ok(extra,'verify 输出含 net-errors.mjs 的哈希');
 assert.equal(extra.source,extra.runtime);
 fs.writeFileSync(outsideNetErrors(f.home),'tampered companion\n');
 const after=verify(f.home).find(v=>String(v.name).includes('net-errors.mjs'));
 assert.notEqual(after.runtime,after.source);
});
test('#238 SC7 deploy 把 net-errors 装到运行时相对路径，mivo 入口能 import', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mivo-deploy-net-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const home=path.join(root,'home');
 fs.mkdirSync(path.join(home,'bin'),{recursive:true});fs.mkdirSync(path.join(home,'state'),{recursive:true});
 fs.writeFileSync(path.join(home,'state/state.json'),JSON.stringify({prs:{}}));
 const state=fs.readFileSync(path.join(home,'state/state.json'));
 apply({version:1,home,database:path.join(home,'metadata.db'),id:'net-errors-release',files:verify(home),stateSha:createHash('sha256').update(state).digest('hex'),sessionIds:[]});
 for(const name of ['mivo-watcher.mjs','mivo-ci-selfheal.mjs']){
  const result=importDeployed(path.join(home,'bin',name));
  assert.doesNotMatch(`${result.stderr}\n${result.stdout}`,/ERR_MODULE_NOT_FOUND/,`${name}: ${result.stderr}`);
  assert.equal(result.status,0,`${name}: ${result.stderr}`);
 }
});
test('#238 SC7 源树没有 net-errors.mjs 时 mivo deploy 拒绝', t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mivo-deploy-no-net-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const watcher=path.join(root,'watchers','mivo');
 fs.cpSync(fileURLToPath(new URL('./',import.meta.url)),watcher,{recursive:true});
 const source=path.join(watcher,'bin');
 const home=path.join(root,'home');
 fs.mkdirSync(path.join(home,'bin'),{recursive:true});
 fs.mkdirSync(path.join(home,'state'),{recursive:true});
 fs.writeFileSync(path.join(home,'state/state.json'),JSON.stringify({prs:{}}));
 assert.throws(()=>verify(home,source),/net-errors/);
 const f=fixture(t);
 assert.throws(()=>validatePlan(f.plan,source),/net-errors/);
 const cli=spawnSync(process.execPath,[path.join(watcher,'deploy.mjs'),'verify','--home',home],{encoding:'utf8',timeout:10000});
 assert.notEqual(cli.status,0);
 assert.match(`${cli.stderr}\n${cli.stdout}`,/net-errors/);
});
test('manifest missing a dependency imported by an entry point is rejected', t => {
 const source = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-manifest-'));
 t.after(() => fs.rmSync(source, { recursive: true, force: true }));
 for (const name of FILES) fs.writeFileSync(path.join(source, name), name.endsWith('.mjs') ? 'export const x = 1;\n' : '# stub\n');
 // mivo-watcher.mjs is an entry point; make it import a module that is not in FILES.
 fs.writeFileSync(path.join(source, 'mivo-watcher.mjs'), "import { x } from './not-in-manifest.mjs';\nexport { x };\n");
 assert.throws(() => verify(source, source), /not-in-manifest\.mjs/);
});
test('validatePlan (used by apply) also enforces manifest completeness, not just verify()', t => {
 const f = fixture(t);
 // Mutate a copy: rewriting the real source races with test files that import it in parallel.
 const source = fs.mkdtempSync(path.join(os.tmpdir(), 'watcher-plan-source-'));
 t.after(() => fs.rmSync(source, { recursive: true, force: true }));
 fs.cpSync(fileURLToPath(new URL('./bin/', import.meta.url)), source, { recursive: true });
 fs.appendFileSync(path.join(source, 'mivo-watcher.mjs'), "\nimport { y } from './not-in-manifest-either.mjs';\n");
 assert.doesNotThrow(() => validatePlan(f.plan));
 assert.throws(() => validatePlan(f.plan, source), /not-in-manifest-either\.mjs/);
});
