import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planExcludedHeadCi, superviseExcludedHead, watcherPaths } from './bin/mivo-watcher.mjs';
import { pendingEvents, formatNoticeText, noticeId } from './bin/notify.mjs';
import { readPr } from './bin/mivo-state.mjs';

const HEAD = 'a'.repeat(40);
const NEXT = 'c'.repeat(40);
const failedRule = (context, runId, attempt = 1) => ({ context, status: 'failed', evidence: { runId, attempt } });
const failed = (...rules) => ({ status: 'failed', required: rules });

test('绿或等待中:不重跑也不通知', () => {
  for (const status of ['green', 'pending', 'unknown']) {
    const plan = planExcludedHeadCi({ ci: { status, required: [] }, state: undefined, headRefOid: HEAD });
    assert.deepEqual(plan.rerun, []);
    assert.equal(plan.notify, false);
  }
});

test('首次红:每个失败的 run 重跑一次(同一 run 只记一次,取最大尝试次数)', () => {
  const plan = planExcludedHeadCi({ ci: failed(failedRule('verify', 11), failedRule('Windows unit tests', 11), failedRule('pr-ci-freshness', 22)), state: undefined, headRefOid: HEAD });
  assert.deepEqual(plan.rerun, [{ runId: '11', attempt: 1 }, { runId: '22', attempt: 1 }]);
  assert.equal(plan.notify, false);
});

test('已重跑、新尝试还没出结果(检查仍报旧尝试):不再重跑、不通知', () => {
  const state = { head: HEAD, reruns: [{ runId: '11', attempt: 1 }], notified: false };
  const plan = planExcludedHeadCi({ ci: failed(failedRule('verify', 11, 1)), state, headRefOid: HEAD });
  assert.deepEqual(plan.rerun, []);
  assert.equal(plan.notify, false);
});

test('重跑后的新尝试仍然红:通知一次,之后不再重复', () => {
  const state = { head: HEAD, reruns: [{ runId: '11', attempt: 1 }], notified: false };
  const first = planExcludedHeadCi({ ci: failed(failedRule('verify', 11, 2)), state, headRefOid: HEAD });
  assert.deepEqual(first.rerun, []);
  assert.equal(first.notify, true);
  assert.deepEqual(first.failed, ['verify']);
  const again = planExcludedHeadCi({ ci: failed(failedRule('verify', 11, 2)), state: { ...state, notified: true }, headRefOid: HEAD });
  assert.equal(again.notify, false);
});

test('head 变了(更新日志 PR 被下一天覆盖):重新开始,旧 head 的重跑记录不算', () => {
  const state = { head: HEAD, reruns: [{ runId: '11', attempt: 1 }], notified: true };
  const plan = planExcludedHeadCi({ ci: failed(failedRule('verify', 33)), state, headRefOid: NEXT });
  assert.equal(plan.state.head, NEXT);
  assert.deepEqual(plan.rerun, [{ runId: '33', attempt: 1 }]);
  assert.equal(plan.notify, false);
});

test('失败的必需检查没有 Actions run(如第三方 app):没法重跑,直接通知', () => {
  const plan = planExcludedHeadCi({ ci: failed({ context: 'DCO', status: 'failed', evidence: { runId: null } }), state: undefined, headRefOid: HEAD });
  assert.deepEqual(plan.rerun, []);
  assert.equal(plan.notify, true);
});

// --- superviseExcludedHead:真实读写 PR 状态与通知队列,gh 与 CI 采集用假数据 ---
function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'excluded-head-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}
function drive(gen) {
  let step = gen.next();
  while (!step.done) {
    try { step = gen.next(step.value()); } catch (error) { step = gen.throw(error); }
  }
  return step.value;
}
const pr = { id: 'PR_1278', number: 1278, headRefName: 'chore/changelog-2026-10-25', url: 'https://example.test/pr/1278' };
function run(paths, { ci, head = HEAD, posts = [] }) {
  const ghFn = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: pr.id, number: pr.number, headRefOid: head, baseRefOid: 'b'.repeat(40), state: 'OPEN', isDraft: false, url: pr.url });
    if (args[0] === 'api' && args[1] === '--method' && args[2] === 'POST') { posts.push(args[3]); return ''; }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return drive(superviseExcludedHead({ pr, key: pr.id, paths, now: '2026-10-25T08:00:00Z', ghFn, dryRun: false, collectCi: function* () { return ci; } }));
}

test('执行:首次红发出 rerun-failed-jobs,状态记下重跑的 run 与尝试次数', (t) => {
  const paths = homeOf(t);
  const posts = [];
  const out = run(paths, { ci: failed(failedRule('verify', 11)), posts });
  assert.deepEqual(posts, ['repos/' + process.env.MIVO_WATCHER_TARGET_REPO + '/actions/runs/11/rerun-failed-jobs']);
  assert.deepEqual(out.reran, ['11']);
  assert.equal(out.notified, undefined);
  assert.deepEqual(readPr(paths.home, pr.id).excludedHead.reruns.map(({ runId, attempt }) => ({ runId, attempt })), [{ runId: '11', attempt: 1 }]);
  assert.deepEqual(pendingEvents(paths.home), []);
});

test('执行:重跑后仍红只通知一次,文案说明不会派修复会话;不再发重跑', (t) => {
  const paths = homeOf(t);
  run(paths, { ci: failed(failedRule('verify', 11, 1)) });
  const posts = [];
  const out = run(paths, { ci: failed(failedRule('verify', 11, 2)), posts });
  assert.deepEqual(posts, []);
  assert.equal(out.notified, true);
  const events = pendingEvents(paths.home);
  assert.equal(events.length, 1);
  assert.equal(noticeId(events[0]), `excluded-head-ci-red:1278:${HEAD}`);
  assert.match(formatNoticeText(events), /自动重跑一次失败的 job 后仍然是红的/);
  assert.match(formatNoticeText(events), /不会为这类 PR 派修复会话/);
  run(paths, { ci: failed(failedRule('verify', 11, 2)) });
  assert.equal(pendingEvents(paths.home).length, 1);
});

test('执行:head 变了重新来一轮;CI 转绿后什么都不做', (t) => {
  const paths = homeOf(t);
  run(paths, { ci: failed(failedRule('verify', 11, 1)) });
  run(paths, { ci: failed(failedRule('verify', 11, 2)) });
  const posts = [];
  run(paths, { ci: failed(failedRule('verify', 33)), head: NEXT, posts });
  assert.equal(posts.length, 1);
  assert.equal(readPr(paths.home, pr.id).excludedHead.head, NEXT);
  const quiet = [];
  const out = run(paths, { ci: { status: 'green', required: [] }, head: NEXT, posts: quiet });
  assert.deepEqual(quiet, []);
  assert.equal(out.ciStatus, 'green');
});

// --- 更新日志 PR 上的审查意见:派一个只许改 public/changelog.json 的会话,讨论清掉后交给扫地僧归档 ---
function runThreads(paths, { threads, pages = null, now = '2026-10-25T08:00:00Z', head = HEAD, sent = [], dispatchError = null, queries = [] }) {
  const ghFn = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: pr.id, number: pr.number, headRefOid: head, baseRefOid: 'b'.repeat(40), state: 'OPEN', isDraft: false, url: pr.url });
    if (args[0] === 'api' && args[1] === 'graphql') {
      queries.push(args.at(-1));
      const reviewThreads = pages ? pages[queries.length - 1] : { nodes: threads };
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads } } } });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const dispatchFn = (params) => {
    sent.push(params);
    if (dispatchError) throw new Error(dispatchError);
    return { target_session_id: params.target_session_id ?? `cl-${sent.length}` };
  };
  return drive(superviseExcludedHead({ pr, key: pr.id, paths, now, ghFn, dryRun: false, dispatchFn,
    collectCi: function* () { return { status: 'green', required: [] }; } }));
}
const greptile = { id: 'PRRT_cl', isResolved: false, isOutdated: false, path: 'public/changelog.json',
  comments: { nodes: [{ author: { login: 'greptile-apps' }, url: 'https://example.test/t', body: 'P2 失败提示描述不准确' }] } };

test('更新日志 PR:有没处理的审查意见就派一次只许改 changelog.json 的会话,同一批一小时内不重复派', (t) => {
  const paths = homeOf(t);
  const sent = [];
  const out = runThreads(paths, { threads: [greptile], sent });
  assert.equal(out.threads.dispatched, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].target_session_id, undefined);
  assert.match(sent[0].message, /只允许改 public\/changelog\.json/);
  assert.match(sent[0].message, /PRRT_cl/);
  assert.match(sent[0].message, /禁止 --no-verify 和 force push/);
  assert.equal(readPr(paths.home, pr.id).excludedThreads.sessionId, 'cl-1');
  const again = runThreads(paths, { threads: [greptile], sent, now: '2026-10-25T08:30:00Z' });
  assert.equal(again.threads.reason, 'in-flight');
  assert.equal(sent.length, 1);
});

test('更新日志 PR:讨论都关掉后,处理它的会话进待归档名单;没有讨论就不派', (t) => {
  const paths = homeOf(t);
  const sent = [];
  runThreads(paths, { threads: [greptile], sent });
  const out = runThreads(paths, { threads: [{ ...greptile, isResolved: true }], sent, now: '2026-10-25T08:10:00Z' });
  assert.equal(out.threads.open, 0);
  assert.equal(sent.length, 1);
  const retired = JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'retired-sessions.json'), 'utf8')).sessions;
  assert.deepEqual(retired.map((item) => [item.sessionId, item.number]), [['cl-1', 1278]]);
  runThreads(paths, { threads: [], sent, now: '2026-10-25T08:20:00Z' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'retired-sessions.json'), 'utf8')).sessions.length, 1);
});

test('更新日志 PR:同一批意见最多派三次,隔一小时补派也发回原会话,不另开会话', (t) => {
  const paths = homeOf(t);
  const sent = [];
  for (const now of ['2026-10-25T08:00:00Z', '2026-10-25T09:01:00Z', '2026-10-25T10:02:00Z', '2026-10-25T11:03:00Z']) runThreads(paths, { threads: [greptile], sent, now });
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((item) => item.target_session_id), [undefined, 'cl-1', 'cl-1']);
  assert.equal(fs.existsSync(path.join(paths.stateDir, 'retired-sessions.json')), false);
  assert.equal(readPr(paths.home, pr.id).excludedThreads.attempts, 3);
});

test('更新日志 PR:首次派发没收到回执时不再自动另开会话,通知一次,一天后才重派', (t) => {
  const paths = homeOf(t);
  const sent = [];
  const out = runThreads(paths, { threads: [greptile], sent, dispatchError: 'Cindy dispatch receipt timed out; pending dispatch retained' });
  assert.equal(out.threads.dispatched, false);
  assert.equal(out.threads.reason, 'receipt-unknown');
  const saved = readPr(paths.home, pr.id).excludedThreads;
  assert.equal(saved.receiptUnknown, true);
  assert.equal(saved.sessionId, null);
  const notices = pendingEvents(paths.home).filter((event) => event.kind === 'changelog-dispatch-unknown');
  assert.equal(notices.length, 1);
  assert.match(formatNoticeText([notices[0]]), /24 小时内不再派/);
  for (const now of ['2026-10-25T08:05:00Z', '2026-10-25T09:01:00Z', '2026-10-26T07:59:00Z']) {
    assert.equal(runThreads(paths, { threads: [greptile], sent, now }).threads.reason, 'receipt-unknown');
  }
  assert.equal(sent.length, 1);
  runThreads(paths, { threads: [greptile], sent, now: '2026-10-26T08:01:00Z' });
  assert.equal(sent.length, 2);
  // the unaddressable session from the first dispatch is listed by title before the new one is opened
  const retired = JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'retired-sessions.json'), 'utf8')).sessions;
  assert.deepEqual(retired.map((item) => [item.sessionId, item.title, item.createdFrom]), [[null, '更新日志 PR #1278 处理审查意见', '2026-10-25T08:00:00Z']]);
  assert.equal(sent[1].title, '更新日志 PR #1278 处理审查意见');
});

test('更新日志 PR:回执未知的会话把讨论都关掉后,按标题和派发时间进待归档名单,只记一次', (t) => {
  const paths = homeOf(t);
  const sent = [];
  runThreads(paths, { threads: [greptile], sent, dispatchError: 'Cindy dispatch receipt timed out; pending dispatch retained' });
  runThreads(paths, { threads: [{ ...greptile, isResolved: true }], sent, now: '2026-10-25T08:30:00Z' });
  runThreads(paths, { threads: [], sent, now: '2026-10-25T08:40:00Z' });
  const retired = JSON.parse(fs.readFileSync(path.join(paths.stateDir, 'retired-sessions.json'), 'utf8')).sessions;
  assert.deepEqual(retired.map((item) => [item.sessionId, item.title, item.createdFrom, item.number]), [[null, '更新日志 PR #1278 处理审查意见', '2026-10-25T08:00:00Z', 1278]]);
  assert.equal(sent.length, 1);
});

test('更新日志 PR:没送到的错误(HOST_NOT_READY)或已知会话的补派失败,一小时后照常重试', (t) => {
  const paths = homeOf(t);
  const sent = [];
  const out = runThreads(paths, { threads: [greptile], sent, dispatchError: 'HOST_NOT_READY: host is starting' });
  assert.equal(out.threads.reason, 'dispatch-error');
  assert.equal(readPr(paths.home, pr.id).excludedThreads.attempts, 1);
  assert.equal(runThreads(paths, { threads: [greptile], sent, now: '2026-10-25T08:05:00Z' }).threads.reason, 'in-flight');
  runThreads(paths, { threads: [greptile], sent, now: '2026-10-25T09:01:00Z' });
  assert.equal(sent.length, 2);
  assert.equal(readPr(paths.home, pr.id).excludedThreads.sessionId, 'cl-2');
  const failed = runThreads(paths, { threads: [greptile], sent, now: '2026-10-25T10:02:00Z', dispatchError: 'Cindy dispatch receipt timed out; pending dispatch retained' });
  assert.equal(failed.threads.reason, 'dispatch-error');
  assert.equal(sent.at(-1).target_session_id, 'cl-2');
  assert.equal(readPr(paths.home, pr.id).excludedThreads.sessionId, 'cl-2');
  assert.equal(pendingEvents(paths.home).filter((event) => event.kind === 'changelog-dispatch-unknown').length, 0);
});

test('更新日志 PR:一条讨论评论超过一页时,派活消息标出并要求会话自己读全', (t) => {
  const paths = homeOf(t);
  const sent = [];
  const long = { ...greptile, comments: { pageInfo: { hasNextPage: true }, nodes: greptile.comments.nodes } };
  runThreads(paths, { threads: [long], sent });
  assert.match(sent[0].message, /"moreComments":true/);
  assert.match(sent[0].message, /分页读全这条讨论的评论/);
});

test('更新日志 PR:讨论超过一页时翻页读全,后一页的讨论也会派出', (t) => {
  const paths = homeOf(t);
  const sent = [];
  const queries = [];
  const resolved = { ...greptile, id: 'PRRT_done', isResolved: true };
  const pages = [
    { pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' }, nodes: [resolved] },
    { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ ...greptile, id: 'PRRT_late' }] },
  ];
  const out = runThreads(paths, { pages, sent, queries });
  assert.equal(queries.length, 2);
  assert.match(queries[1], /after:"CURSOR_1"/);
  assert.equal(out.threads.open, 1);
  assert.match(sent[0].message, /PRRT_late/);
});
