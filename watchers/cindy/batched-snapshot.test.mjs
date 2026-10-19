import test from 'node:test';
import assert from 'node:assert/strict';
import {collectPrSnapshotSync,collectPrOwnership} from './bin/cindy-pr-snapshot.mjs';
import {ownershipMatchesViewer} from './bin/cindy-watcher.mjs';
const basic={id:'PR_1',number:1,title:'t',state:'OPEN',isDraft:false,headRefOid:'a'.repeat(40),headRefName:'feature',baseRefOid:'b'.repeat(40),baseRefName:'main',createdAt:'2026-09-09T00:00:00Z',author:{login:'ExampleUser'},isCrossRepository:true};
const FORK={name:'cindy-fork',owner:{login:'ExampleUser'}};
// The head repository comes from REST pulls/<n>; gh pr view no longer asks for it.
function fixture({overflow=false,broken=false,drift=false,head=FORK,nodeId='PR_1'}={}){
 let childCalls=0,views=0,total=0,pulls=0;
 const viewArgs=[];
 const page=(nodes,hasNextPage=false,endCursor=null)=>({nodes,pageInfo:{hasNextPage,endCursor}});
 const ghFn=args=>{
  total++;
  if(args[1]==='view'){viewArgs.push(args);return JSON.stringify({...basic,...(++views>1&&drift?{author:{login:'other'}}:{})});}
  if(args[1]==='checks')return '[]';
  if(args[1]==='repos/makecindy/cindy/pulls/1'){pulls++;return JSON.stringify({number:1,node_id:nodeId,head:{repo:head}});}
  if(args[1].startsWith('repos/'))return '[[]]';
  const q=args.at(-1),field=['timelineItems','reviewThreads','comments','reviews','labels'].find(f=>q.includes(f+'('));
  let value=page([]);
  if(field==='reviewThreads')value=page(Array.from({length:80},(_,i)=>({id:`T${i}`,isResolved:false,isOutdated:false,comments:page([{id:`C${i}`,body:'x'}],overflow&&i===0,broken?null:'next')})));
  if(field==='comments'){childCalls++;assert.match(q,/after:"next"/);value=page([{id:'overflow',body:'y'}]);}
  return JSON.stringify({data:{node:{[field]:value}}});
 };
 return {ghFn,viewArgs,counts:()=>({childCalls,total,pulls})};
}
const drive=(g)=>{let s=g.next();while(!s.done)s=g.next(s.value());return s.value;};
test('80 threads use one embedded page, not 80 child requests',()=>{
 const f=fixture(),s=collectPrSnapshotSync({pr:{number:1},ghFn:f.ghFn});assert.equal(s.threads.length,80);assert.equal(s.threads[79].comments[0].id,'C79');assert.equal(f.counts().childCalls,0);
});
test('embedded overflow resumes only unfinished thread without dropping comments',()=>{
 const f=fixture({overflow:true}),s=collectPrSnapshotSync({pr:{number:1},ghFn:f.ghFn});assert.deepEqual(s.threads[0].comments.map(c=>c.id),['C0','overflow']);assert.equal(f.counts().childCalls,1);
});
test('missing embedded continuation fails closed',()=>assert.throws(()=>collectPrSnapshotSync({pr:{number:1},ghFn:fixture({overflow:true,broken:true}).ghFn}),/cursor/));
test('ownership last-moment reads identity/epoch and the head repository once, no feedback',()=>{
 const f=fixture(),v=drive(collectPrOwnership({pr:{number:1},ghFn:f.ghFn}));assert.equal(v.pr.author.login,'ExampleUser');assert.equal(f.counts().total,5);assert.equal(f.counts().pulls,1);
});
test('ownership lightweight path refuses changed author',()=>{
 const f=fixture({drift:true}),g=collectPrOwnership({pr:{number:1},ghFn:f.ghFn});assert.throws(()=>drive(g),/owner/);
});
test('gh pr view never asks for head repository fields; the fork comes from REST pulls/<n>',()=>{
 const f=fixture(),s=collectPrSnapshotSync({pr:{number:1},ghFn:f.ghFn});
 assert.ok(f.viewArgs.length>=2);
 for(const args of f.viewArgs)assert.doesNotMatch(args.join(' '),/headRepository/);
 assert.equal(f.counts().pulls,1);
 assert.deepEqual(s.pr.headRepositoryOwner,{login:'ExampleUser'});
 assert.deepEqual(s.pr.headRepository,{name:'cindy-fork',owner:{login:'ExampleUser'}});
 assert.equal(s.pr.sameRepository,false);
});
test('another account\'s fork is reported as that owner, not the viewer',()=>{
 const s=collectPrSnapshotSync({pr:{number:1},ghFn:fixture({head:{name:'cindy',owner:{login:'OtherUser'}}}).ghFn});
 assert.equal(s.pr.headRepositoryOwner.login,'OtherUser');
});
test('a deleted fork (head.repo null) fails closed',()=>{
 assert.throws(()=>collectPrSnapshotSync({pr:{number:1},ghFn:fixture({head:null}).ghFn}),/missing head repository/);
 assert.throws(()=>drive(collectPrOwnership({pr:{number:1},ghFn:fixture({head:null}).ghFn})),/missing head repository/);
});
test('REST pull for a different PR node fails closed',()=>{
 assert.throws(()=>collectPrSnapshotSync({pr:{number:1},ghFn:fixture({nodeId:'PR_other'}).ghFn}),/pull identity drift/);
});
test('head repository equal to the base repository contradicts isCrossRepository',()=>{
 assert.throws(()=>collectPrSnapshotSync({pr:{number:1},ghFn:fixture({head:{name:'cindy',owner:{login:'makecindy'}}}).ghFn}),/inconsistent repository identity/);
});
test('fork ownership still follows the REST head owner',()=>{
 const own=collectPrSnapshotSync({pr:{number:1},ghFn:fixture().ghFn});
 assert.equal(ownershipMatchesViewer(own.pr,'ExampleUser'),true);
 const other=collectPrSnapshotSync({pr:{number:1},ghFn:fixture({head:{name:'cindy',owner:{login:'OtherUser'}}}).ghFn});
 assert.equal(ownershipMatchesViewer(other.pr,'ExampleUser'),false);
});
