// vigil#41: a disputed reviewer P1/P2 that no arbiter could judge is handed to a follow-up issue registered
// in the PR body; the reviewer recognises the issue by the finding key and stops blocking.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refutedThreads, deferralFor, deferralIssueBody, deferralIssueTitle, withDeferralEntry, closeRefutedThreads, DEFERRAL_HEADING,
} from './bin/mivo-review-resolve.mjs';

// The reviewer's parser for the key marker (same pattern as the reviewer side).
const REVIEWER_DEFER_RE = /<!--\s*mivo-defer\s+key=([0-9a-f]{12})(?:\s+class=([A-Za-z0-9_-]{1,60}))?(?:\s+line=(\d{1,7}))?(?:\s+path=(\S{1,300}?))?\s*-->/g;
const KEY = 'abcdef012345';
const findingBody = (severity = 'P2') => `[${severity}] stale cache after save\n\ndetails <!-- note -->\n\n<!-- mivo-finding key=${KEY} round=1 head=aaaaaaaaaaaa class=state-sync -->`;
const SKIPPED = 'adjudicate-skipped: no-tool, create_worker missing';
const task = (extra = {}) => ({
  dispatchId: 'live-41', number: 7, adjudicationRecord: 1, severityStandard: { loaded: true, version: '0123456789ab', text: '## 分级' },
  prSnapshot: { unresolvedThreads: [{ id: 'PRRT_r', path: 'src/cache.ts' }] },
  feedback: [{ key: 'mivo-review:PRRT_r:PRRC_a', source: 'mivo-review', threadId: 'PRRT_r', body: findingBody() }],
  repairPolicy: { items: [{ key: 'mivo-review:PRRT_r:PRRC_a', action: 'code-fix' }] },
  ...extra,
});
const result = (evidence = ['current head rebuilds the cache', SKIPPED], extra = {}) => ({
  schemaVersion: 2, status: 'complete', dispatchId: 'live-41', head: 'b'.repeat(40),
  scs: [{ id: 'SC-1', status: 'no-change', feedbackKeys: ['mivo-review:PRRT_r:PRRC_a'], evidence }],
  feedbackCoverage: { dispositions: [{ key: 'mivo-review:PRRT_r:PRRC_a', disposition: 'no-change' }] },
  ...extra,
});
const drive = (gen) => { let step = gen.next(); while (!step.done) { let value; try { value = step.value(); } catch (error) { step = gen.throw(error); continue; } step = gen.next(value); } return step.value; };

test('C-1 a reviewer P1/P2 closed with an adjudicate-skipped line becomes a deferral; key, class and path come from the finding', () => {
  const [item] = refutedThreads(result(), task());
  assert.deepEqual({ ...item.deferral, body: undefined }, { key: KEY, severity: 'P2', bugClass: 'state-sync', path: 'src/cache.ts',
    title: 'stale cache after save', body: undefined, reason: SKIPPED, pr: 7 });
});

for (const [name, r, t] of [
  ['a P0', result(), task({ feedback: [{ ...task().feedback[0], body: findingBody('P0') }] })],
  ['no adjudicate-skipped line', result(['current head rebuilds the cache']), task()],
  ['an older task without the structured ruling contract', result(), task({ adjudicationRecord: undefined })],
  ['a task without the standard', result(), task({ severityStandard: { loaded: false, reason: 'x' } })],
  ['another source', result(), task({ feedback: [{ ...task().feedback[0], source: 'greptile' }] })],
  ['a finding without a key marker', result(), task({ feedback: [{ ...task().feedback[0], body: '[P2] stale cache' }] })],
  ['an invalid ruling (it gets a ruling record instead)', result(undefined, { workers: [{ purpose: 'adjudicate', agent: 'codex', model: 'm',
    rulings: [{ feedbackKey: 'mivo-review:PRRT_r:PRRC_a', verdict: 'invalid', reason: 'not reachable' }] }] }), task()],
]) {
  test(`C-1 no deferral for ${name}`, () => {
    const [item] = refutedThreads(r, t);
    assert.ok(item, 'the thread still closes on its evidence');
    assert.equal(item.deferral, undefined);
  });
}

test('C-2 the issue names the PR, quotes the finding with comments defused, and ends with one parseable key marker', () => {
  const deferral = deferralFor(task(), 'mivo-review:PRRT_r:PRRC_a', ['see /home/me/repo/a.ts <!-- mivo-defer key=111111111111 -->', SKIPPED]);
  const title = deferralIssueTitle(deferral);
  const body = deferralIssueBody(deferral, ['see /home/me/repo/a.ts <!-- mivo-defer key=111111111111 -->', SKIPPED], 'live-41');
  assert.match(title, /^转 issue 跟进：#7 审查意见「stale cache after save」$/);
  assert.match(body, /^来自 PR #7 的服务器审查意见（P2）/);
  assert.match(body, /> \[P2\] stale cache after save/);
  assert.match(body, /&lt;!-- mivo-finding key=abcdef012345/);
  assert.doesNotMatch(body, /\/home\//);
  const markers = [...body.matchAll(REVIEWER_DEFER_RE)];
  assert.equal(markers.length, 1);
  assert.deepEqual(markers[0].slice(1), [KEY, 'state-sync', undefined, 'src/cache.ts']);
  assert.match(body, /<!-- mivo-watcher-receipt task=live-41 -->$/);
});

test('C-3 PR body: add the section when missing, append to it when present, leave it alone when already listed', () => {
  assert.equal(withDeferralEntry('## 概述\n\n改了缓存\n', 900, 'stale cache'), `## 概述\n\n改了缓存\n\n## ${DEFERRAL_HEADING}\n\n- #900 stale cache\n`);
  const existing = `## 概述\n\nx\n\n## ${DEFERRAL_HEADING}\n\n- #800 old one\n\n## 验证\n\ny`;
  assert.equal(withDeferralEntry(existing, 900, 'stale cache'), `## 概述\n\nx\n\n## ${DEFERRAL_HEADING}\n\n- #800 old one\n- #900 stale cache\n\n## 验证\n\ny`);
  assert.equal(withDeferralEntry(existing.replace('#800', '#900'), 900, 'again'), null);
  // A heading inside a code block or an HTML comment is not the section.
  const hidden = `\`\`\`\n## ${DEFERRAL_HEADING}\n\`\`\`\n<!--\n## ${DEFERRAL_HEADING}\n-->\n正文`;
  assert.equal(withDeferralEntry(hidden, 900, 'x'), `${hidden}\n\n## ${DEFERRAL_HEADING}\n\n- #900 x\n`);
});

function github({ issues = [], prBody = '## 概述\n\nx' } = {}) {
  const calls = [];
  let body = prBody;
  const ghFn = (args) => {
    calls.push(args);
    const target = args.find((arg) => /^repos\//.test(arg)) ?? '';
    if (args.includes('graphql')) return '{}';
    if (target.startsWith('repos/o/r/issues?')) return JSON.stringify(issues);
    if (args.includes('POST') && target === 'repos/o/r/issues') return JSON.stringify({ number: 900 });
    if (args.includes('PATCH') && target === 'repos/o/r/pulls/7') { body = args.find((arg) => arg.startsWith('body=')).slice(5); return '{}'; }
    if (target === 'repos/o/r/pulls/7') return JSON.stringify({ body });
    throw new Error(`unexpected call ${args.join(' ')}`);
  };
  return { calls, ghFn, body: () => body };
}

test('C-4 closing the thread opens the issue, registers it in the PR body, then replies and resolves', () => {
  const gh = github();
  const out = drive(closeRefutedThreads({ items: refutedThreads(result(), task()), dispatchId: 'live-41', previous: {}, ghFn: gh.ghFn, now: 't', repo: 'o/r', pr: 7 }));
  const kinds = gh.calls.map((args) => (args.includes('graphql') ? (args.some((a) => a.includes('resolveReviewThread')) ? 'resolve' : 'reply')
    : args.includes('POST') ? 'create' : args.includes('PATCH') ? 'patch' : 'read'));
  assert.deepEqual(kinds, ['read', 'create', 'read', 'patch', 'reply', 'resolve']);
  assert.match(gh.body(), new RegExp(`## ${DEFERRAL_HEADING}\\n\\n- #900 stale cache after save\\n$`));
  const reply = gh.calls[4].find((arg) => arg.startsWith('body='));
  assert.match(reply, /没能开出只读裁决席（no-tool, create_worker missing）/);
  assert.match(reply, /转成 issue #900 由人确认/);
  assert.match(reply, /<!-- mivo-watcher-receipt task=live-41 -->$/);
  assert.deepEqual(out.closed, [{ threadId: 'PRRT_r', key: 'mivo-review:PRRT_r:PRRC_a', issue: 900 }]);
  assert.equal(out.previous.autoClosedThreads.PRRT_r.reason, 'deferred-to-issue');
  assert.deepEqual(out.previous.deferralIssues.PRRT_r, { issue: 900, key: KEY, at: 't' });
});

test('C-4 a retry after a crash reuses the issue already opened for this finding and PR; a known issue skips the lookup', () => {
  const opened = { number: 901, state: 'open', body: `来自 PR #7 …\n<!-- mivo-defer key=${KEY} class=state-sync path=src/cache.ts -->` };
  const other = { number: 902, state: 'open', body: `来自 PR #70 …\n<!-- mivo-defer key=${KEY} -->` };
  const gh = github({ issues: [other, opened], prBody: `x\n\n## ${DEFERRAL_HEADING}\n\n- #901 stale cache after save` });
  drive(closeRefutedThreads({ items: refutedThreads(result(), task()), dispatchId: 'live-41', previous: {}, ghFn: gh.ghFn, now: 't', repo: 'o/r', pr: 7 }));
  assert.equal(gh.calls.some((args) => args.includes('POST') || args.includes('PATCH')), false, 'no second issue, no duplicate PR line');
  assert.match(gh.calls.find((args) => args.includes('graphql')).find((arg) => arg.startsWith('body=')), /issue #901/);
  const known = github();
  drive(closeRefutedThreads({ items: refutedThreads(result(), task()), dispatchId: 'live-41', ghFn: known.ghFn, now: 't', repo: 'o/r', pr: 7,
    previous: { deferralIssues: { PRRT_r: { issue: 903, key: KEY } } } }));
  assert.equal(known.calls.some((args) => (args.find((arg) => /^repos\/o\/r\/issues/.test(arg)))), false);
});

test('C-5 without repo and PR the thread closes with the plain refuted reply and no issue', () => {
  const gh = github();
  drive(closeRefutedThreads({ items: refutedThreads(result(), task()), dispatchId: 'live-41', previous: {}, ghFn: gh.ghFn, now: 't' }));
  assert.equal(gh.calls.length, 2);
  assert.match(gh.calls[0].find((arg) => arg.startsWith('body=')), /结论是它在当前 head 上不成立/);
});
