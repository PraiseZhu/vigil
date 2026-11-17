import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isSyncPr, mapUnchangedRange, codeOrigin, syncFeedbackOrigin, verifySyncTransfers, transferMarker } from './bin/mivo-sync-origin.mjs';
import { dispatchParams } from './bin/mivo-watcher.mjs';
const fixtures = JSON.parse(fs.readFileSync(new URL('./sync-origin.fixture.json', import.meta.url)));
const HEAD = 'a'.repeat(40), MAIN = 'b'.repeat(40), NEW = 'c'.repeat(40);
const taskOf = fixture => ({ repo: 'example-org/plugin', number: fixture.sourcePr, headRefOid: HEAD,
  syncPr: fixture.pr, feedback: [{ key: 'finding', threadId: 'example-thread', path: fixture.file }] });
function world(fixture) {
  const task = taskOf(fixture), calls = [];
  // Private source code is represented by line labels. Historical hunk coordinates and
  // independently measured matching region hashes are kept in the fixture.
  const source = Array.from({ length: fixture.lineCount }, (_, index) => `example line ${index + 1}`).join('\n');
  const git = args => {
    calls.push(args);
    if (args.includes('fetch') || args.includes('--is-ancestor')) return '';
    if (args.includes('rev-parse') || args.includes('merge-base')) return MAIN;
    if (args.includes('--name-only')) return fixture.file;
    if (args.includes('diff')) return fixture.diff;
    if (args.includes('show')) return source;
    throw Error(`unexpected git ${args}`);
  };
  const replacement = { number: 42, url: 'https://github.com/example-org/plugin/pull/42', state: 'OPEN', isDraft: false,
    isCrossRepository: false, baseRefName: 'main', headRefOid: NEW, body: transferMarker(task, 'finding'),
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const thread = { path: fixture.file, line: fixture.end, startLine: fixture.start, diffSide: 'RIGHT', isOutdated: false,
    pullRequest: { number: task.number, headRefOid: HEAD, repository: { nameWithOwner: task.repo } } };
  const gh = args => {
    calls.push(args);
    if (args[0] === 'api') return JSON.stringify({ data: { node: thread } });
    if (args[0] === 'pr') return JSON.stringify(replacement);
    throw Error('unexpected GitHub mutation');
  };
  const scs = [{ id: 'SC1', status: 'no-change', feedbackKeys: ['finding'], evidence: ['will be replaced', `main-transfer: 42 ${NEW}`] }];
  return { task, git, gh, scs, calls, replacement, thread, worktree: '.', allowedKeys: ['finding'] };
}

test('sync detection accepts branch pair and explicit Chinese/English main sync intent', () => {
  for (const fixture of fixtures) assert.equal(isSyncPr(fixture.pr), true);
  assert.equal(isSyncPr({ title: 'chore: merge main into stage' }), true);
  assert.equal(isSyncPr({ body: '把最新 `main` 同步进阶段分支' }), true);
  assert.equal(isSyncPr({ body: '同步 main 到阶段分支' }), true);
  for (const text of ['将 main 同步到阶段分支', '把最新的 main 合并进 integration/example',
    'chore: sync main into integration/example', '同步 main 至阶段分支']) {
    assert.equal(isSyncPr({ title: text }), true, text);
    assert.equal(isSyncPr({ body: text }), true, text);
  }
  for (const text of ['修复 main 上的旧问题', '将分支合并进 main', 'sync feature into main',
    '不要同步 main 进阶段分支', '本 PR 不是同步 main 进阶段分支', 'do not sync main into stage',
    '同步 main 的状态显示', '更新同步 main 按钮文案']) {
    assert.equal(isSyncPr({ title: text, body: text }), false, text);
  }
  assert.equal(isSyncPr({ baseRefName: 'integration/stage', headRefName: 'feat/new-feature' }), false);
  assert.equal(isSyncPr({ baseRefName: 'main', headRefName: 'fix/feature', title: 'fix: video references' }), false);
});
test('negated or uncertain sync intent stays ordinary without GitHub/git reads', () => {
  for (const text of ['不要把 main 同步进阶段分支', '不要将最新 main 合并进 integration/stage',
    '无需把最新的 `main` 同步到阶段分支', '禁止将 main 合并入 integration/stage',
    '本 PR 不会把 main 同步至阶段分支', '请勿再将最新 main 合并进 integration/stage',
    'do not automatically sync main into stage', 'never merge main into stage',
    '是否把 main 同步进阶段分支', '如果要将 main 同步到阶段分支，请另开 PR',
    '把 main 同步进阶段分支？', '本轮暂不同步 main 到阶段分支', '尚未将 main 同步进阶段分支',
    '没有把 main 合并进 integration/stage', 'no need to sync main into stage',
    "we can't sync main into stage", 'don’t automatically sync main into stage']) {
    for (const field of ['title', 'body']) {
      const w = world(fixtures[0]);
      w.task.syncPr = { [field]: text };
      w.scs[0].status = 'pass'; w.scs[0].evidence = ['fixed normal PR'];
      assert.equal(isSyncPr(w.task.syncPr), false, text);
      assert.deepEqual(syncFeedbackOrigin({ ...w, feedback: w.task.feedback[0] }), { route: 'in-place', reason: 'ordinary-pr' });
      assert.equal(verifySyncTransfers(w).size, 0);
      assert.deepEqual(w.calls, [], text);
    }
  }
  assert.equal(isSyncPr({ title: 'sync main into stage', body: '不要把 main 同步进阶段分支' }), false);
});
for (const fixture of fixtures) {
  test(`${fixture.case}: inherited main finding goes to a verified main PR, with human reply`, () => {
    assert.equal(fixture.mainRegionSha256, fixture.headRegionSha256);
    const w = world(fixture);
    assert.equal(syncFeedbackOrigin({ ...w, feedback: w.task.feedback[0] }).route, 'main');
    assert.deepEqual([...verifySyncTransfers(w)], ['finding']);
    assert.match(w.scs[0].evidence[0], /这是 main 上已有的问题，已转 #42 修复/);
    assert.ok(w.calls.some(args => args.includes('--is-ancestor') && args.includes(MAIN) && args.includes(NEW)));
    // The verifier reads GitHub and fetches objects only; reply/resolve stays with the watcher.
    assert.ok(w.calls.every(args => !args.some(arg => ['push', 'commit', 'mutation', 'resolveReviewThread'].includes(arg))));
  });
  test(`${fixture.case}: direct fix of inherited code is rejected before original-PR push`, () => {
    const w = world(fixture);
    w.scs[0].status = 'pass'; w.scs[0].evidence = ['fixed locally'];
    assert.throws(() => verifySyncTransfers(w), /requires one verified main-transfer/);
  });
  test(`${fixture.case}: conflict resolution touching the finding stays in-place`, () => {
    const changed = { ...fixture, diff: `${fixture.diff}\n@@ -${fixture.end} +${fixture.end} @@` };
    const w = world(changed);
    assert.equal(syncFeedbackOrigin({ ...w, feedback: w.task.feedback[0] }).route, 'in-place');
    w.scs[0].status = 'pass'; w.scs[0].evidence = ['fixed conflict-introduced code'];
    assert.equal(verifySyncTransfers(w).size, 0);
  });
}
test('ordinary PR follows existing path without additional GitHub/git calls', () => {
  const w = world(fixtures[0]); delete w.task.syncPr;
  w.scs[0].status = 'pass'; w.scs[0].evidence = ['fixed normal PR'];
  assert.equal(syncFeedbackOrigin({ ...w, feedback: w.task.feedback[0] }).route, 'in-place');
  assert.equal(verifySyncTransfers(w).size, 0);
  assert.equal(w.calls.length, 0);
});
test('refused replacement creation, stale head, wrong base, draft, red CI cannot close the original finding', () => {
  for (const mutate of [w => { w.gh = () => { throw Error('API unavailable'); }; },
    w => { w.replacement.body = ''; }, w => { w.replacement.baseRefName = 'integration/stage'; }, w => { w.replacement.headRefOid = MAIN; },
    w => { w.replacement.isDraft = true; }, w => { w.replacement.state = 'CLOSED'; },
    w => { w.replacement.statusCheckRollup[0].conclusion = 'FAILURE'; }]) {
    const w = world(fixtures[0]); mutate(w);
    assert.throws(() => verifySyncTransfers(w));
    assert.equal(w.scs[0].evidence[0], 'will be replaced');
  }
});
test('outdated/wrong PR/left-side thread and missing range do not establish main origin', () => {
  for (const mutate of [w => { w.thread.isOutdated = true; }, w => { w.thread.diffSide = 'LEFT'; },
    w => { w.thread.pullRequest.number++; }, w => { w.thread.line = null; w.thread.startLine = null; }]) {
    const w = world(fixtures[0]); mutate(w);
    assert.equal(syncFeedbackOrigin({ ...w, feedback: w.task.feedback[0] }).route, 'unknown');
    assert.throws(() => verifySyncTransfers(w));
  }
});
test('line mapping accounts for shifts, deletions and changed context', () => {
  assert.deepEqual(mapUnchangedRange('@@ -10,0 +11,3 @@', 20, 25), { start: 17, end: 22 });
  assert.equal(mapUnchangedRange('@@ -20,2 +19,0 @@', 19, 25), null);
  assert.equal(mapUnchangedRange('@@ -20 +20 @@', 20, 25), null);
  assert.equal(mapUnchangedRange('', null, null), null);
});
test('repair prompt puts sync origin check before fixes and delegates replies to watcher', () => {
  const message = dispatchParams({ pr: { ...fixtures[0].pr, number: 2410, id: 'example-pr', headRefOid: HEAD },
    mapping: {}, fresh: [], now: '2026-11-17T00:00:00Z', home: '/example/watcher', taskPath: '/example/task.json' }).message;
  assert.match(message, /sync-origin --key/);
  assert.match(message, /main-transfer:/);
  assert.match(message, /从 helper 返回的最新 main SHA/);
  assert.match(message, /watcher 才回复上述人话并 resolve/);
});
test('real git: imported main region is routed out, conflict edits are routed in-place', t => {
  const root = path.resolve('_tmp'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'sync-origin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
  const run = args => git(['-C', dir, ...args]);
  run(['init', '-q']); run(['config', 'user.name', 'ExampleUser']); run(['config', 'user.email', 'example@example.invalid']);
  const file = 'example.txt', source = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  fs.writeFileSync(path.join(dir, file), source); run(['add', file]); run(['commit', '-qm', 'base']);
  const base = run(['rev-parse', 'HEAD']); run(['update-ref', 'refs/remotes/origin/main', base]);
  const args = { worktree: dir, head: base, file, start: 20, end: 21, git };
  assert.equal(codeOrigin(args).route, 'main');
  fs.writeFileSync(path.join(dir, file), source.replace('line 19', 'conflict introduced issue'));
  run(['commit', '-qam', 'conflict resolution']);
  assert.equal(codeOrigin({ ...args, head: run(['rev-parse', 'HEAD']) }).route, 'in-place');
});

test('a transfer marker supplied as the only evidence survives verification and watcher formatting', () => {
  const w = world(fixtures[0]);
  w.scs[0].evidence = [`main-transfer: 42 ${NEW}`];
  assert.deepEqual([...verifySyncTransfers(w)], ['finding']);
  assert.equal(w.scs[0].evidence[1], `main-transfer: 42 ${NEW}`);
  assert.deepEqual([...verifySyncTransfers(w)], ['finding']);
});
