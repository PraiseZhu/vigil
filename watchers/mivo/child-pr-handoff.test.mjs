import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dispatchParams, processPr, readChildPrHandoff, rulesVersion, watcherPaths, REPO } from './bin/mivo-watcher.mjs';
import { childPrDraftPaths, childPrHandoffSpec, parseFrontMatterKind, renderChildPrHandoff } from './bin/mivo-repair.mjs';
import { handoffPr, handoffReceipt } from './handoff.fixture.mjs';

const HEAD = 'a'.repeat(40);
// A P1 from the review bot: the policy lets the session change code for it.
const THREAD = { id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'src/a.ts',
  comments: [{ id: 'c1', author: { login: 'greptile-apps[bot]' }, body: '**P1** still broken', createdAt: '2026-10-28T06:00:00Z' }] };
const TEMPLATES = ['docs/pr/_template/review.md', 'docs/pr/_template/qa.md'];

// Same contract as the watcher's own driver: an effect that throws is thrown back into the generator.
function drive(gen) {
  let step = gen.next();
  while (!step.done) {
    let value;
    try { value = step.value(); } catch (error) { step = gen.throw(error); continue; }
    step = gen.next(value);
  }
  return step.value;
}

// rules: what `rules/branches/<head>` returns; templates: 'both' | 'none' | 'review-only' | 'error' | 'dir'.
function probeGh({ rules = [{ type: 'pull_request' }], templates = 'both' } = {}) {
  const calls = [];
  const ghFn = (args) => {
    calls.push(args);
    const target = String(args[1]);
    if (target.includes('/rules/branches/')) {
      if (rules === 'error') throw new Error('HTTP 502');
      return JSON.stringify([rules]);
    }
    const file = TEMPLATES.find((name) => target.includes(`/contents/${name}?ref=${HEAD}`));
    if (file) {
      if (templates === 'error') throw new Error('HTTP 502');
      if (templates === 'none' || (templates === 'review-only' && file.endsWith('qa.md'))) {
        const error = new Error('gh: Not Found (HTTP 404)');
        error.stderr = 'gh: Not Found (HTTP 404)';
        throw error;
      }
      return JSON.stringify({ type: templates === 'dir' ? 'dir' : 'file', name: path.basename(file) });
    }
    throw new Error(`unexpected gh call: ${JSON.stringify(args)}`);
  };
  return { ghFn, calls };
}

const probe = (options) => {
  const gh = probeGh(options);
  return { ...gh, result: drive(readChildPrHandoff({ headRefName: 'fix/x', headSha: HEAD, ghFn: gh.ghFn })) };
};

test('readChildPrHandoff is on only for a head that takes PRs only and a repo with both templates', () => {
  const on = probe();
  assert.equal(on.result.enabled, true);
  assert.deepEqual(on.calls.map((args) => args[1]), [
    `repos/${REPO}/rules/branches/fix%2Fx?per_page=100`,
    `repos/${REPO}/contents/docs/pr/_template/review.md?ref=${HEAD}`,
    `repos/${REPO}/contents/docs/pr/_template/qa.md?ref=${HEAD}`,
  ]);
});

test('readChildPrHandoff is off, and reads no template, when the head takes direct pushes', () => {
  const direct = probe({ rules: [{ type: 'non_fast_forward' }] });
  assert.equal(direct.result.enabled, false);
  assert.equal(direct.result.reason, 'head-takes-direct-push');
  assert.equal(direct.calls.length, 1);
});

for (const [name, options, reason] of [
  ['the head rules cannot be read', { rules: 'error' }, 'head-rules-unavailable'],
  ['the repo has no handoff templates', { templates: 'none' }, 'no-handoff-template'],
  ['only one template exists', { templates: 'review-only' }, 'no-handoff-template'],
  ['the template path is a directory', { templates: 'dir' }, 'no-handoff-template'],
  ['a template read fails for another reason', { templates: 'error' }, 'handoff-template-unavailable'],
]) {
  test(`readChildPrHandoff is off when ${name}`, () => {
    const result = probe(options).result;
    assert.equal(result.enabled, false);
    assert.equal(result.reason, reason);
  });
}

test('readChildPrHandoff is off without a full head SHA, and reads nothing', () => {
  const gh = probeGh();
  assert.equal(drive(readChildPrHandoff({ headRefName: 'fix/x', headSha: 'abc', ghFn: gh.ghFn })).enabled, false);
  assert.equal(gh.calls.length, 0);
});

// dispatchParams
const finding = { key: 'review:1', source: 'review', nativeId: '1', revision: '1', sha: HEAD,
  body: '**P1** real problem in src/example.ts', user: { login: 'github-actions[bot]', type: 'Bot' }, category: 'actionable-fix' };
const params = (extra = {}, fresh = [finding]) => dispatchParams({
  pr: { number: 790, id: 'PR_790', headRefOid: HEAD, headRefName: 'fix/x', title: 't' }, mapping: { title: 't' }, fresh,
  now: '2026-11-05T00:00:00Z', taskPath: '/watch/state/tasks/live-790-x.json', home: '/watch', ...extra,
}).message;

test('dispatch message asks for both drafts at the fixed task directory when the handoff is on', () => {
  const message = params({ childPrHandoff: { enabled: true } });
  const { dir, review, qa } = childPrDraftPaths('/watch/state/tasks/live-790-x.json');
  assert.equal(dir, '/watch/state/tasks/live-790-x.child-pr');
  for (const needle of ['子 PR 交接草稿', dir, review, qa, '<PR号>', 'docs/pr/_template/review.md', 'kind 分别是 review、qa', 'finalize', '单独提交', 'pre-push']) {
    assert.ok(message.includes(needle), `message lacks ${needle}`);
  }
});

test('dispatch message has no handoff text when the head takes direct pushes, the probe is off, or nothing may change', () => {
  for (const message of [params(), params({ childPrHandoff: null }), params({ childPrHandoff: { enabled: false, reason: 'head-takes-direct-push' } }),
    params({ childPrHandoff: { enabled: true } }, [{ ...finding, body: '**P3** wording nit', category: 'reply-resolve' }])]) {
    assert.ok(!message.includes('子 PR 交接草稿'));
    assert.ok(!message.includes('<PR号>'));
    assert.ok(!message.includes('.child-pr'));
  }
});

test('the rules version covers the handoff text, so a session is refreshed when it changes', () => {
  assert.match(rulesVersion(), /^[0-9a-f]{12}$/);
});

// processPr: the decision is made once per delivery and recorded in the task
function harness(t, { rules = [{ type: 'pull_request' }], templates = 'both', dryRun = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-handoff-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(path.join(paths.stateDir, 'tasks'), { recursive: true });
  const pr = handoffPr({ id: 'PR_790', number: 790, headRefOid: HEAD, headRefName: 'fix/x', releaseEpoch: 'e' });
  const previous = { number: 790, nodeId: 'PR_790', sessionId: 'sess-790', eligibility: 'active', eligibilityInitialized: true,
    admissionVerified: true, admissionEpoch: pr.releaseEpoch, wasDraft: false, headRefOid: HEAD, headRefName: 'fix/x',
    rulesVersion: rulesVersion(), url: 'u', feedbackCursor: {}, handoff: handoffReceipt(pr) };
  const state = { version: 2, repo: REPO, prs: { PR_790: previous } };
  const collected = { pr: { ...pr, state: 'OPEN' }, admissionVerified: true, mergeReady: false,
    comments: [], reviews: [], threads: [THREAD], labels: [], checks: [], requiredChecks: [],
    ci: { status: 'green', required: [] }, policy: { status: 'verified', required: [] }, mergeable: 'MERGEABLE' };
  const sent = [];
  const report = [];
  const probeReads = [];
  const { ghFn: probeFn } = probeGh({ rules, templates });
  const gen = processPr({ pr, state, paths, now: '2026-10-28T07:00:00Z', events: [], report, viewer: 'owner', dryRun,
    dispatchFn: (params) => { sent.push(params); return { target_session_id: 'sess-790' }; },
    collect: () => collected, recheckFn: () => {},
    ghFn: (args) => {
      if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_790', state: 'OPEN' });
      if (args[0] === 'api' && String(args[1]).startsWith(`repos/${REPO}/pulls?state=open&base=`)) return JSON.stringify([[]]);
      if (args[0] === 'api' && /\/(?:rules\/branches|contents)\//.test(String(args[1]))) { probeReads.push(args); return probeFn(args); }
      return '{}';
    },
    ownershipSnapshot: function* () { return { pr: { ...pr, author: { login: 'owner' } } }; },
    remaining: () => 120000, deadline: Date.now() + 120000, clock: Date.now, allowCreate: false, keelRoot: '/tmp' });
  drive(gen);
  const message = sent[0]?.message ?? '';
  const taskPath = message.match(/^task=(.+)$/m)?.[1] ?? null;
  const pending = report[0]?.dispatch?.pending?.params?.message ?? '';
  return { sent, message, pending, report, probeReads, taskPath, task: taskPath && !dryRun ? JSON.parse(fs.readFileSync(taskPath, 'utf8')) : null };
}

test('a delivery for a PR-only head with the templates tells the session and records the handoff in the task', (t) => {
  const h = harness(t);
  assert.equal(h.sent.length, 1);
  assert.ok(h.message.includes('OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY'));
  assert.ok(h.message.includes('子 PR 交接草稿'));
  assert.ok(h.message.includes(childPrDraftPaths(h.taskPath).review));
  assert.deepEqual(h.task.childPrHandoff, childPrHandoffSpec(h.taskPath));
  assert.equal(h.task.childPrHandoff.draftDir, childPrDraftPaths(h.taskPath).dir);
  assert.equal(h.task.childPrHandoff.placeholder, '<PR号>');
  assert.deepEqual(h.task.childPrHandoff.templateFiles, TEMPLATES);
});

for (const [name, options] of [
  ['a head that takes direct pushes', { rules: [] }],
  ['a repo without the templates', { templates: 'none' }],
  ['unreadable head rules', { rules: 'error' }],
]) {
  test(`a delivery for ${name} says nothing about handoff drafts and records none`, (t) => {
    const h = harness(t, options);
    assert.equal(h.sent.length, 1);
    assert.ok(h.message.includes('OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY'), 'the session may change code, so only the handoff decision differs');
    assert.ok(!h.message.includes('子 PR 交接草稿'));
    assert.ok(!h.message.includes('.child-pr'));
    assert.equal(Object.hasOwn(h.task, 'childPrHandoff'), false);
  });
}

test('a dry run reads nothing from GitHub for the handoff and previews no handoff text', (t) => {
  const h = harness(t, { dryRun: true });
  assert.equal(h.sent.length, 0);
  assert.equal(h.report[0].dispatch.reason, 'dry-run');
  assert.equal(h.probeReads.length, 0);
  assert.ok(h.pending.includes('OWNER_STANDING_AUTH: PR_PUSH_AND_REPLY'));
  assert.ok(!h.pending.includes('子 PR 交接草稿'));
});

test('a delivery reads the head rules and both templates once, and a head that takes direct pushes stops after the rules', (t) => {
  assert.equal(harness(t).probeReads.length, 3);
  assert.equal(harness(t, { rules: [] }).probeReads.length, 1);
});

// pure helpers
test('parseFrontMatterKind reads only the leading front matter, and says which part is wrong', () => {
  assert.equal(parseFrontMatterKind('---\nkind: review\npr: <PR号>\n---\nbody\nkind: qa\n', 'review.md'), 'review');
  assert.equal(parseFrontMatterKind('\uFEFF---\r\nkind: "qa"  # reviewer view\r\n---\r\n', 'qa.md'), 'qa');
  assert.equal(parseFrontMatterKind("---\nkind: 'review'\n---\n", 'review.md'), 'review');
  assert.throws(() => parseFrontMatterKind('# no front matter\nkind: review\n', 'review.md'), /review\.md has no front matter/);
  assert.throws(() => parseFrontMatterKind('---\nkind: review\nno end', 'review.md'), /review\.md front matter is not closed/);
  assert.throws(() => parseFrontMatterKind('---\npr: 1\n---\n', 'qa.md'), /qa\.md front matter has no kind field/);
});

test('renderChildPrHandoff replaces only the fixed token and refuses a bad number', () => {
  const out = renderChildPrHandoff({ review: '---\nkind: review\npr: <PR号>\n---\n$& <PR号> \\1 <pr号>\n', qa: 'qa <PR号>', childNumber: 812 });
  assert.equal(out['review.md'], '---\nkind: review\npr: 812\n---\n$& 812 \\1 <pr号>\n');
  assert.equal(out['qa.md'], 'qa 812');
  assert.throws(() => renderChildPrHandoff({ review: 'a', qa: 'b', childNumber: 0 }), /child PR number is invalid/);
  assert.throws(() => renderChildPrHandoff({ review: 'a', qa: 'b', childNumber: '812' }), /child PR number is invalid/);
});

test('childPrDraftPaths needs an absolute task path and stays beside the task file', () => {
  assert.throws(() => childPrDraftPaths('tasks/live-1.json'), /task must be an absolute path/);
  const paths = childPrDraftPaths('/h/state/tasks/live-790-2026.json');
  assert.deepEqual(paths, { dir: '/h/state/tasks/live-790-2026.child-pr', review: '/h/state/tasks/live-790-2026.child-pr/review.md', qa: '/h/state/tasks/live-790-2026.child-pr/qa.md' });
});
