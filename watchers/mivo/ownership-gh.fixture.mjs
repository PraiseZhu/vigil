import fs from 'node:fs';
import path from 'node:path';

// External GitHub transport for child-process ownership checks in Git hooks.
export function ownershipGh(root, taskPath, originUrl, draftSignal = path.join(root, 'draft-signal')) {
  const file = path.join(root, 'ownership-gh.mjs');
  fs.writeFileSync(file, `#!${process.execPath}
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const task=JSON.parse(fs.readFileSync(${JSON.stringify(taskPath)},'utf8'));
const args=process.argv.slice(2), draft=fs.existsSync(${JSON.stringify(draftSignal)});
const head=execFileSync('git',['--git-dir',${JSON.stringify(originUrl)},'rev-parse','refs/heads/'+task.headRefName],{encoding:'utf8'}).trim();
const epoch=task.releaseEpoch;
const ready=/^ready:([^:]+):([^:]+):(.+)$/.exec(epoch);
const created=epoch.startsWith('opened:'+task.nodeId+':')?epoch.slice(('opened:'+task.nodeId+':').length):'2026-01-01T00:00:00Z';
const pr={id:task.nodeId,number:task.number,state:'OPEN',isDraft:draft,headRefOid:head,headRefName:task.headRefName,
baseRefOid:task.headRefOid,baseRefName:'main',createdAt:created,author:{login:task.handoff.author},isCrossRepository:false,
headRepositoryOwner:{login:task.repo.split('/')[0]},headRepository:{name:task.repo.split('/')[1]}};
const send=x=>process.stdout.write(JSON.stringify(x));
if(args[0]==='pr'&&args[1]==='view')send(pr);
else if(args[0]==='pr'&&args[1]==='checks')send([{name:'unit',state:'SUCCESS',bucket:'pass'}]);
else if(args[1]==='graphql')send({data:{node:{timelineItems:{nodes:draft?[{__typename:'ConvertToDraftEvent',id:'DRAFT_AFTER_HOOK',createdAt:'2026-10-07T00:00:00Z'}]:ready?[{__typename:'ReadyForReviewEvent',id:ready[2],createdAt:ready[3]}]:[],pageInfo:{hasNextPage:false}}}}});
else if(args[1]?.includes('/rules/branches/'))send([[]]);
else if(args[1]?.endsWith('/branches/main'))send({protected:false});
else if(args[1]?.includes('/contents/docs/sync/required-checks.json'))send({type:'file',encoding:'base64',content:Buffer.from(JSON.stringify({on_main:['unit'],pr_only:[]})).toString('base64')});
else if(args[1]?.includes('/check-runs?'))send([{check_runs:[{id:1,name:'unit',head_sha:head,status:'completed',conclusion:'success',app:{id:1},started_at:'2026-10-01T00:00:00Z'}]}]);
else if(args[1]?.includes('/statuses?'))send([[]]);
else {process.stderr.write('unexpected fixture GitHub request: '+JSON.stringify(args));process.exitCode=2;}
`, { mode: 0o700 });
  return file;
}
