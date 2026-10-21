import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluatePublicReview, reviewerReport, isReviewerCleanReport, reviewerFindingReviewIds} from './bin/public-review.mjs';
const h='a'.repeat(40),b='b'.repeat(40),reviewer='ExampleReviewer';
const header=(head=h,base=b)=>`> Mivo 自动审查 · [PR](https://example.invalid/pull/10) · head \`${head.slice(0,12)}\` · base \`${base.slice(0,12)}\` · diffHash \`0123456789ab\` · 档位 standard`;
const cleanBody=(extra='')=>`${header()}\n## Findings\n无。\n\n## Overall\npass —— 没有 P0/P1。${extra}`;
const findingsBody=()=>`${header()}\n## Findings\n- [P1] src/a.ts:3 — 事实：……\n\n## Overall\nchanges-requested —— 1 条 P0/P1，已在对应位置开 review thread。\n\n<!-- review-pr:findings head=${h} digest=${'c'.repeat(64)} -->`;
function fixture({state='APPROVED',body=cleanBody()}={}) {
  const report={id:'R1',author:{login:reviewer},state,submittedAt:'2026-09-10T00:10:00Z',commit:{oid:h},body};
  return {snapshot:{pr:{state:'OPEN',isDraft:false,sameRepository:true,number:10,headRefOid:h,baseRefOid:b,baseRefName:'main',releaseEpoch:'ready:2026-09-10T00:00:00Z',author:{login:'owner'},mergeStateStatus:'CLEAN'},
      comments:[],requiredChecksGreen:true,mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',threads:[],reviews:[report],labels:[]},
    checks:[{id:5,name:'review-pr',app:{id:15368,slug:'github-actions'},head_sha:h,status:'completed',conclusion:'success',started_at:'2026-09-10T00:05:00Z',
      external_id:'https://github.com/example-org/example-plugin/actions/runs/3',details_url:'https://github.com/example-org/example-plugin/runs/5'}],
    runs:{3:{id:3,path:'.github/workflows/review-pr.yml',event:'workflow_dispatch',repository:{full_name:'example-org/example-plugin'}}}};
}
test('APPROVE report plus a successful review-pr check from the dispatch workflow is merge-ready',()=>{
  const v=evaluatePublicReview(fixture());assert.equal(v.ready,true,v.reason);assert.equal(v.reason,'current-approve');
});
test('own PR: COMMENT sealed with the report marker is merge-ready',()=>{
  const v=evaluatePublicReview(fixture({state:'COMMENTED',body:cleanBody(`\n\n<!-- mivo-review:report head=${h} -->`)}));
  assert.equal(v.ready,true,v.reason);assert.equal(v.reason,'current-report');
});
test('COMMENT without the report marker is not a pass',()=>assert.equal(evaluatePublicReview(fixture({state:'COMMENTED'})).reason,'review-report-missing'));
test('a later reuse round keeps the head merge-ready',()=>{
  const f=fixture();f.checks.push({...f.checks[0],id:6,started_at:'2026-09-10T00:20:00Z',external_id:'https://github.com/example-org/example-plugin/actions/runs/4',details_url:'https://github.com/example-org/example-plugin/runs/6'});
  f.runs[4]={...f.runs[3],id:4};assert.equal(evaluatePublicReview(f).ready,true);
});
test('findings review is not a pass',()=>assert.equal(evaluatePublicReview(fixture({state:'COMMENTED',body:findingsBody()})).reason,'review-findings'));
for (const change of ['head','base','reviewer','check-missing','check-running','check-failed','check-app','external-id-missing','external-id-other-repo','external-id-job','run-path','run-event','run-repo','epoch','ci','conflict','thread','veto','draft','closed','later-findings','hold','new-feedback','overall','report-commit']) test(`reject ${change}`,()=>{
  const f=fixture(),s=f.snapshot,r=s.reviews[0],c=f.checks[0];
  if(change==='head'){s.pr.headRefOid='d'.repeat(40);}
  if(change==='base')s.pr.baseRefOid='d'.repeat(40);
  if(change==='reviewer')r.author.login='someone-else';
  if(change==='check-missing')f.checks=[];
  if(change==='check-running'){c.status='in_progress';c.conclusion=null;}
  if(change==='check-failed')c.conclusion='failure';
  if(change==='check-app')c.app.id=999;
  // GitHub ignores details_url for Actions-authored checks, so a run URL there must not bind the producer.
  if(change==='external-id-missing'){delete c.external_id;c.details_url='https://github.com/example-org/example-plugin/actions/runs/3';}
  if(change==='external-id-other-repo')c.external_id='https://github.com/example-org/fork/actions/runs/3';
  if(change==='external-id-job')c.external_id='https://github.com/example-org/example-plugin/actions/runs/3/job/9';
  if(change==='run-path')f.runs[3].path='.github/workflows/ci.yml';
  if(change==='run-event')f.runs[3].event='pull_request_target';
  if(change==='run-repo')f.runs[3].repository.full_name='example-org/fork';
  if(change==='epoch')s.pr.releaseEpoch='ready:2026-09-10T00:20:00Z';
  if(change==='ci')s.requiredChecksGreen=false;
  if(change==='conflict')s.mergeable='CONFLICTING';
  if(change==='thread')s.threads=[{isResolved:false}];
  if(change==='veto')s.reviewDecision='CHANGES_REQUESTED';
  if(change==='draft')s.pr.isDraft=true;
  if(change==='closed')s.pr.state='CLOSED';
  if(change==='later-findings')s.reviews.push({id:'R2',author:{login:reviewer},state:'COMMENTED',submittedAt:'2026-09-10T00:12:00Z',commit:{oid:h},body:findingsBody()});
  if(change==='hold')s.labels=['awaiting-discussion'];
  if(change==='new-feedback')s.comments.push({id:14,user:{login:'greptile-apps[bot]'},created_at:'2026-09-10T00:12:00Z',body:'regression'});
  if(change==='overall')r.body=r.body.replace('pass —— 没有 P0/P1。','changes-requested —— 1 条 P0/P1。');
  if(change==='report-commit')r.commit.oid='d'.repeat(40);
  assert.equal(evaluatePublicReview(f).ready,false);
});
test('reviewer report helpers: only the configured reviewer counts',()=>{
  const clean={id:'R1',author:{login:reviewer},state:'APPROVED',submittedAt:'2026-09-10T00:10:00Z',commit:{oid:h},body:cleanBody()};
  const findings={id:'R2',author:{login:reviewer},state:'COMMENTED',submittedAt:'2026-09-10T00:12:00Z',commit:{oid:h},body:findingsBody()};
  const forged={...findings,id:'R3',author:{login:'someone-else'}};
  assert.equal(isReviewerCleanReport(clean),true);assert.equal(isReviewerCleanReport(findings),false);
  assert.equal(reviewerReport(forged),null);
  assert.deepEqual([...reviewerFindingReviewIds([clean,findings,forged])],['R2']);
});
test('BEHIND is not merge-ready and is base-update eligible when other gates pass', () => {
  const f = fixture();
  f.snapshot.mergeStateStatus = 'BEHIND';
  f.snapshot.pr.mergeStateStatus = 'BEHIND';
  const v = evaluatePublicReview(f);
  assert.equal(v.ready, false);
  assert.equal(v.reason, 'behind');
  assert.equal(v.baseUpdateEligible, true);
  assert.deepEqual(v.blockers, ['behind']);
});
test('BEHIND with red CI is not base-update eligible', () => {
  const f = fixture();
  f.snapshot.mergeStateStatus = 'BEHIND';
  f.snapshot.pr.mergeStateStatus = 'BEHIND';
  f.snapshot.requiredChecksGreen = false;
  const v = evaluatePublicReview(f);
  assert.equal(v.ready, false);
  assert.equal(v.baseUpdateEligible, false);
  assert.ok(v.blockers.includes('behind'));
  assert.ok(v.blockers.includes('waiting-ci'));
});
test('UNKNOWN merge state is not treated as clean', () => {
  const f = fixture();
  f.snapshot.mergeStateStatus = 'UNKNOWN';
  const v = evaluatePublicReview(f);
  assert.equal(v.ready, false);
  assert.equal(v.reason, 'merge-state-unknown');
  assert.equal(v.baseUpdateEligible, false);
});
test('non-main base is never base-update eligible', () => {
  const f = fixture();
  f.snapshot.mergeStateStatus = 'BEHIND';
  f.snapshot.pr.mergeStateStatus = 'BEHIND';
  f.snapshot.pr.baseRefName = 'develop';
  const v = evaluatePublicReview(f);
  assert.equal(v.baseUpdateEligible, false);
});
test('a member comment already answered for this head does not count as new feedback', () => {
  const s = fixture();
  s.snapshot.comments.push({ id: 15, user: { login: 'teammate' }, created_at: '2026-09-10T00:12:00Z', body: 'please rename this' });
  assert.equal(evaluatePublicReview(s).reason, 'new-feedback');
  const handledFeedback = { 'comment:15': { resultHead: h, replyCommentId: 99, actionKey: 'x' } };
  assert.equal(evaluatePublicReview({ ...s, handledFeedback }).ready, true);
});
