// Product intent: the repair session sees what the PR body declares and answers feedback that would undo it,
// instead of waiting for a person. A PR that is genuinely stuck is announced on the PR. Pure pieces here;
// the poll flow is in thread-close-flow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { productIntentExcerpt, compactPrSnapshot, dispatchParams, blockedNoticeText, announceBlocked, PR_INTENT_MAX_CHARS } from './bin/mivo-watcher.mjs';
import { blocked, BLOCKED_KINDS } from './bin/mivo-repair.mjs';

const HEAD = 'a'.repeat(40);
const drive = (gen) => {
  let step = gen.next();
  while (!step.done) {
    try { step = gen.next(step.value()); } catch (error) { step = gen.throw(error); }
  }
  return step.value;
};

test('the PR body\'s own intent section is excerpted up to the next heading of the same level', () => {
  const body = '## 改了什么\n加文本节点\n\n## 产品意图（有意这样设计）\n- 点「+」弹出图/文菜单\n### 细节\n悬停才显示删除叉\n## 测试\nnpm test\n<!-- hidden -->';
  const excerpt = productIntentExcerpt(body);
  assert.equal(excerpt.source, 'intent-section');
  assert.match(excerpt.text, /弹出图\/文菜单/);
  assert.match(excerpt.text, /悬停才显示删除叉/, 'sub-headings stay inside the section');
  assert.doesNotMatch(excerpt.text, /npm test|改了什么/);
});

test('without an intent section the body head is used; empty bodies give null; long text is cut', () => {
  assert.deepEqual(productIntentExcerpt('只有说明\r\n第二行'), { source: 'body-head', text: '只有说明\n第二行' });
  assert.equal(productIntentExcerpt(''), null);
  assert.equal(productIntentExcerpt(undefined), null);
  assert.equal(productIntentExcerpt('<!-- template only -->'), null);
  const long = productIntentExcerpt('# Product intent\n' + 'x'.repeat(PR_INTENT_MAX_CHARS * 2));
  assert.ok(long.text.length < PR_INTENT_MAX_CHARS + 40);
  assert.match(long.text, /已截断/);
});

test('task snapshot and dispatch message both carry the intent and the gate rule', () => {
  const snapshot = compactPrSnapshot({ pr: { number: 1, body: '## 产品意图\n保留菜单' } }, 'now');
  assert.equal(snapshot.prIntent.text, '## 产品意图\n保留菜单');
  const message = dispatchParams({ pr: { number: 1, id: 'PR_1', headRefOid: HEAD, title: 't' }, mapping: {}, fresh: [],
    now: '2026-10-15T00:00:00Z', taskPath: '/v/task.json', home: '/v/home', prIntent: snapshot.prIntent }).message;
  assert.match(message, /prIntent=\{"source":"intent-section","text":"## 产品意图\\n保留菜单"\}/);
  assert.match(message, /它不是缺陷：不改代码，记 SC=no-change/);
  assert.match(message, /不要为这类反馈 blocked 或等人拍板/);
  assert.match(message, /全自动推进：目标是把 PR 推到可合并/);
  assert.match(message, /确认不了的按不成立处理/);
  assert.doesNotMatch(message, /product-intent|product-arch-gate|awaiting-discussion|未知严重度一律 blocked/);
  const without = dispatchParams({ pr: { number: 1, id: 'PR_1', headRefOid: HEAD, title: 't' }, mapping: {}, fresh: [], now: '2026-10-15T00:00:00Z' }).message;
  assert.match(without, /prIntent=\{"source":"unavailable"/);
});

test('notice text names the author, the reason and what to do; local paths and mentions are defused', () => {
  const external = blockedNoticeText({ event: { blockedKind: 'external', reason: 'gh auth expired at /home/me/.config, ask @someone' }, author: 'alice' });
  assert.match(external, /@alice 请按上面的原因处理/);
  assert.doesNotMatch(external, /\/home\/me/);
  assert.doesNotMatch(external, /@someone/);
  assert.match(external, /mivo-watcher-receipt task=blocked-notice kind=external/);
  const unknown = blockedNoticeText({ event: { blockedKind: 'weird<kind>' }, author: null });
  assert.match(unknown, /盯梢卡住了（weirdkind）/);
  assert.match(unknown, /PR 作者 请按/);
  assert.match(unknown, /会话没有写原因/);
});

test('announce skips states the watcher clears by itself, posts once, and stops after the attempt cap', () => {
  const calls = [];
  const failing = (args) => { calls.push(args); throw new Error('down'); };
  const base = { activeTask: { status: 'blocked' }, lastException: { fingerprint: 'f1', event: { kind: 'repair-blocked', blockedKind: 'required-ci' } } };
  drive(announceBlocked({ previous: base, pr: { number: 3 }, author: 'a', ghFn: failing, now: 'n' }));
  assert.equal(calls.length, 0, 'red CI is re-dispatched, not announced');
  let previous = { ...base, lastException: { fingerprint: 'f2', event: { kind: 'repair-blocked', blockedKind: 'external', reason: 'r' } } };
  for (let i = 0; i < 5; i++) previous = drive(announceBlocked({ previous, pr: { number: 3 }, author: 'a', ghFn: failing, now: 'n' }));
  assert.equal(calls.length, 3);
  assert.equal(previous.blockedNotices.f2.lastError, 'down');
  const posted = [];
  const ok = (args) => { posted.push(args); return '{}'; };
  let fresh = { ...base, lastException: { fingerprint: 'f3', event: { kind: 'repair-blocked', blockedKind: 'external', reason: 'r' } } };
  fresh = drive(announceBlocked({ previous: fresh, pr: { number: 3 }, author: 'a', ghFn: ok, now: 'n' }));
  drive(announceBlocked({ previous: fresh, pr: { number: 3 }, author: 'a', ghFn: ok, now: 'n2' }));
  assert.equal(posted.length, 1, 'posted once');
  assert.ok(!posted.flat().some((arg) => /labels/.test(String(arg))), 'no hold label');
  const unblocked = { ...fresh, activeTask: { status: 'complete' }, lastException: { fingerprint: 'f4', event: { blockedKind: 'external' } } };
  drive(announceBlocked({ previous: unblocked, pr: { number: 3 }, author: 'a', ghFn: ok, now: 'n' }));
  assert.equal(posted.length, 1, 'a PR that is no longer blocked is not announced');
});

test('the repair helper only blocks on external causes; product questions are not a blocked kind', () => {
  assert.deepEqual([...BLOCKED_KINDS], ['external']);
  assert.throws(() => blocked({ home: '/nonexistent', taskPath: '/nonexistent/t.json', reason: 'r', kind: 'product-intent' }), /blocked --kind must be one of external/);
});
