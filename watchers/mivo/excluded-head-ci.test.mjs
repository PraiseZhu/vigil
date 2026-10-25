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
