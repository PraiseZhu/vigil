import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';

// Script/CLI E2E: real Node entrypoints, Git objects and persisted watcher state.
// Only GitHub transport and Host delivery are fixtures. No production service,
// scheduler or Cindy session is contacted; this does not prove Host interruption.
const bin = fileURLToPath(new URL('./bin/', import.meta.url));
const repo = 'example-org/example-plugin';
const nodeId = 'PR_E2E';
const now = '2026-09-03T00:00:00Z';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-handoff-e2e-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'watcher');
  const plugin = path.join(root, 'plugin');
  fs.mkdirSync(plugin);
  const git = args => execFileSync('git', ['-C', plugin, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['-c', 'user.name=Example User', '-c', 'user.email=example@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const head = git(['rev-parse', 'HEAD']);
  const serviceFile = path.join(root, 'github.json');
  const callsFile = path.join(root, 'gh-calls.jsonl');
  const deliveriesFile = path.join(root, 'deliveries.jsonl');
  const prFile = path.join(home, 'state', 'prs', `${nodeId}.json`);
  const service = {
    pr: { id: nodeId, number: 17, title: 'Example repair', state: 'OPEN', isDraft: false,
      headRefOid: head, headRefName: 'feature', baseRefOid: head, baseRefName: 'main',
      createdAt: '2026-09-01T00:00:00Z', author: { login: 'ExampleUser' },
      isCrossRepository: false, headRepository: { name: 'example-plugin' },
      headRepositoryOwner: { login: 'example-org' }, mergeable: 'MERGEABLE', labels: [] },
    timeline: [{ __typename: 'ReadyForReviewEvent', id: 'READY_1', createdAt: '2026-09-02T00:00:00Z' }],
    comments: [{ id: 601, body: 'P1 **Example core failure**\nA supported operation fails before completion.', user: { login: 'greptile[bot]', type: 'Bot' }, created_at: '2026-09-02T02:00:00Z', updated_at: '2026-09-02T02:00:00Z' }], fail: null,
  };
  fs.writeFileSync(serviceFile, JSON.stringify(service));
  const fakeGh = path.join(root, 'gh.mjs');
  fs.writeFileSync(fakeGh, `#!${process.execPath}\nimport { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);\n${fakeGhMain.toString()}\nfakeGhMain();\n`, { mode: 0o700 });
  const driver = path.join(root, 'scan.mjs');
  fs.writeFileSync(driver, `
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { scanOnce, watcherPaths } from ${JSON.stringify(new URL('./bin/mivo-watcher.mjs', import.meta.url).href)};
const result = scanOnce({ mode: 'discover', enabled: true, allowDispatch: true,
  paths: watcherPaths(process.env.MIVO_WATCHER_HOME), now: ${JSON.stringify(now)},
  budgetMs: Number(process.env.E2E_BUDGET_MS ?? 120000),
  ghFn: args => execFileSync(process.env.GH_BIN, args, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }),
  dispatchFn: params => { fs.appendFileSync(process.env.E2E_DELIVERIES, JSON.stringify(params) + '\\n');
    return { target_session_id: 'example-session' }; },
});
process.stdout.write(JSON.stringify(result));
`);
  // Keep profile, lifeline and all state discovery inside this fixture as well.
  const env = { ...process.env, MIVO_WATCHER_TARGET_REPO: repo, MIVO_WATCHER_HOME: home,
    MIVO_PLUGIN_REPO: plugin, GH_BIN: fakeGh, E2E_GITHUB: serviceFile,
    E2E_CALLS: callsFile, E2E_DELIVERIES: deliveriesFile,
    MIVO_WATCHER_WATCH_HOMES: '[]' };
  delete env.MIVO_PR_LOCK_TOKEN;
  delete env.MIVO_WATCHER_PROFILE;
  delete env.MIVO_WATCHER_LIFELINE_CONFIG;
  const run = (file, args = [], success = true) => {
    const result = spawnSync(process.execPath, [file, ...args], { env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined, String(result.error));
    if (success) assert.equal(result.status, 0, result.stderr || result.stdout);
    else assert.notEqual(result.status, 0, 'operation should fail closed');
    return success ? JSON.parse(result.stdout) : result.stderr;
  };
  const lines = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(x => JSON.parse(x)) : [];
  const read = () => JSON.parse(fs.readFileSync(serviceFile));
  return { root, home, head, prFile,
    read, update: mutate => { const value = read(); mutate(value); fs.writeFileSync(serviceFile, JSON.stringify(value)); },
    entry: () => fs.existsSync(prFile) ? JSON.parse(fs.readFileSync(prFile)) : null,
    seed: value => { fs.mkdirSync(path.dirname(prFile), { recursive: true }); fs.writeFileSync(prFile, JSON.stringify(value)); },
    scan: (budgetMs = 120000) => { env.E2E_BUDGET_MS = String(budgetMs); return run(driver); },
    advanceHead: () => { git(['-c', 'user.name=Example User', '-c', 'user.email=example@example.invalid', 'commit', '--allow-empty', '-m', 'repair']); return git(['rev-parse', 'HEAD']); }, deliveries: () => lines(deliveriesFile), calls: () => lines(callsFile),
    handoff: (success = true) => run(path.join(bin, 'mivo-handoff.mjs'), ['handoff', '--repo', repo, '--pr', '17'], success),
    reclaim: () => run(path.join(bin, 'mivo-handoff.mjs'), ['reclaim', '--repo', repo, '--pr', '17']),
    owner: (task, success = true) => run(path.join(bin, 'mivo-repair.mjs'), ['--home', home, '--task', task, 'assert-owner'], success),
    task: () => path.join(home, 'state', 'tasks', `${JSON.parse(fs.readFileSync(prFile)).activeTask.dispatchId}.json`),
  };
}

function fakeGhMain() {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  const file = process.env.E2E_GITHUB;
  const state = JSON.parse(fs.readFileSync(file));
  fs.appendFileSync(process.env.E2E_CALLS, JSON.stringify(args) + '\n');
  const send = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
  const save = () => fs.writeFileSync(file, JSON.stringify(state));
  const page = nodes => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  if (state.fail === 'view' && args[0] === 'pr' && args[1] === 'view') {
    process.stderr.write('simulated GitHub unavailable'); process.exit(1);
  }
  if (args[0] === 'api' && args[1] === 'user') return send(args.includes('-q') ? 'ExampleUser' : { login: 'ExampleUser', type: 'User' });
  if (args[0] === 'pr' && args[1] === 'view') return send(state.pr);
  if (args[0] === 'pr' && args[1] === 'list') return send([state.pr]);
  if (args[0] === 'pr' && args[1] === 'ready' && args.includes('--undo')) {
    state.pr.isDraft = true;
    state.timeline.push({ __typename: 'ConvertToDraftEvent', id: 'DRAFT_1', createdAt: '2026-09-03T01:00:00Z' });
    save(); return send('');
  }
  if (args[0] === 'pr' && args[1] === 'checks') return send([{ name: 'unit', state: 'SUCCESS', bucket: 'pass' }]);
  if (args[1] === 'graphql') {
    const query = args.find(a => a.startsWith('query='));
    if (query.includes('timelineItems(first:')) return send({ data: { node: { timelineItems: page(state.timeline) } } });
    // Same transport answers both the one-query poll snapshot and full collector.
    return send({ data: { node: { ...state.pr, timelineItems: page(state.timeline), labels: page([]), comments: { ...page(state.comments), totalCount: state.comments.length },
      reviews: { ...page([]), totalCount: 0 }, reviewThreads: page([]), commits: page([]) } } });
  }
  const endpoint = args[1] ?? '';
  if (endpoint.includes('/issues/17/comments')) {
    if (args.includes('POST')) {
      const body = args[args.indexOf('-f') + 1].slice('body='.length);
      const comment = { id: 700 + state.comments.length, body, user: { login: 'ExampleUser', type: 'User' },
        created_at: '2026-09-03T00:00:00Z', updated_at: '2026-09-03T00:00:00Z' };
      state.comments.push(comment); save(); return send(comment);
    }
    if (state.fail === 'comments') { process.stderr.write('simulated comments unavailable'); process.exit(1); }
    return send([state.comments]);
  }
  if (endpoint.includes('/rules/branches/')) return send([[]]);
  if (endpoint.includes('/branches/main')) return send({ protected: false });
  if (endpoint.includes('/contents/docs/sync/required-checks.json')) return send({ type: 'file', encoding: 'base64',
    content: Buffer.from(JSON.stringify({ on_main: ['unit'], pr_only: [] })).toString('base64') });
  if (endpoint.includes('/check-runs?')) return send([{ check_runs: [] }]);
  if (endpoint.includes('/statuses?')) return send([[{ id: 501, context: 'unit', state: 'success', created_at: '2026-09-02T01:00:00Z', creator: { id: 1 } }]]);
  if (endpoint.includes('/actions/workflows/code-review.yml/runs?')) return send([{ workflow_runs: [{ id: 201,
    display_title: 'Code Review [pr:17]', event: 'pull_request_target', head_sha: state.pr.headRefOid }] }]);
  process.stderr.write('unexpected fake gh request: ' + JSON.stringify(args)); process.exit(2);
}

function readyAgain(f) {
  f.update(s => { s.pr.isDraft = false; s.timeline.push({ __typename: 'ReadyForReviewEvent', id: 'READY_2', createdAt: '2026-09-03T02:00:00Z' }); });
}

test('CLI handoff → real watcher dispatch → helper ownership → reclaim revokes task and same-head Ready epoch', t => {
  const f = fixture(t);
  assert.equal(f.scan().prs[0].dispatch.reason, 'author-handoff-required');
  assert.equal(f.deliveries().length, 0);
  const handoff = f.handoff();
  assert.equal(handoff.status, 'handed-off');
  assert.equal(handoff.receipt.head, f.head);
  assert.equal(f.read().comments.length, 2);
  const dispatched = f.scan();
  assert.equal(dispatched.prs[0].dispatch.attempted, true, JSON.stringify(dispatched));
  assert.equal(f.deliveries().length, 1);
  const task = f.task();
  assert.deepEqual(JSON.parse(fs.readFileSync(task)).handoff, handoff.receipt);
  assert.equal(f.owner(task).status, 'owned');
  assert.equal(f.reclaim().status, 'author-owned');
  assert.equal(f.read().pr.isDraft, true);
  assert.match(f.owner(task, false), /handoff|superseded/);
  assert.equal(f.scan().prs[0].dispatch.reason, 'draft-author-owned');
  assert.equal(f.entry().activeTask.blockedKind, 'author-reclaimed');
  assert.equal(f.entry().handoff, null);
  readyAgain(f);
  assert.equal(f.read().pr.headRefOid, f.head);
  assert.match(f.owner(task, false), /superseded|handoff/);
  f.scan();
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.entry().handoff, null);
});

test('Ready legacy admission without author receipt cannot reuse a bound session', t => {
  const f = fixture(t);
  f.seed({ nodeId, number: 17, sessionId: 'example-legacy-session', admissionVerified: true,
    admissionEpoch: `ready:${nodeId}:READY_1:2026-09-02T00:00:00Z`, wasDraft: false,
    activeTask: { status: 'accepted', dispatchId: 'example-legacy-task' },
    heartbeatAt: '2026-09-01T00:00:00Z', headRefOid: f.head, headRefName: 'feature' });
  f.scan();
  assert.equal(f.deliveries().length, 0);
  assert.equal(f.entry().admissionVerified, false);
  assert.equal(f.entry().handoff, null);
});

test('GitHub failures block handoff and helper ownership before local work can continue', t => {
  const f = fixture(t);
  f.update(s => { s.fail = 'comments'; });
  assert.match(f.handoff(false), /comments unavailable/);
  assert.equal(f.read().comments.length, 1);
  f.scan();
  assert.equal(f.deliveries().length, 0);
  f.update(s => { s.fail = null; });
  f.handoff(); f.scan();
  const task = f.task();
  f.update(s => { s.fail = 'view'; });
  assert.match(f.owner(task, false), /GitHub unavailable/);
  f.scan();
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.calls().filter(args => args.includes('POST')).length, 1);
});

test('unobserved Ready → Draft → Ready at the same HEAD cannot reuse an old task', t => {
  const f = fixture(t);
  f.handoff(); f.scan();
  const task = f.task();
  assert.equal(f.owner(task).status, 'owned');
  f.reclaim();
  readyAgain(f); // No watcher tick occurs during Draft.
  assert.equal(f.read().pr.headRefOid, f.head);
  assert.match(f.owner(task, false), /handoff.*release epoch/);
  f.scan();
  assert.equal(f.deliveries().length, 1);
  assert.equal(f.entry().activeTask.blockedKind, 'author-reclaimed');
  assert.equal(f.entry().handoff, null);
});

function pushedResult(f, taskFile, head) {
  const task = JSON.parse(fs.readFileSync(taskFile));
  const file = path.join(f.home, 'state', 'results', `${task.dispatchId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const result = { schemaVersion: 2, kind: 'mivo-repair-result', dispatchId: task.dispatchId,
    nodeId: task.nodeId, number: task.number, repo: task.repo, sessionId: f.entry().sessionId,
    status: 'waiting-ci', head, sourceHead: task.headRefOid, pushed: true,
    verification: { status: 'pass', head }, ci: { head, requiredGreen: false, pending: ['unit'] },
    receiptId: 'example-pushed-receipt', observedAt: now };
  // Simulate the delayed helper result, not an actual preflight/validation receipt.
  fs.writeFileSync(file, JSON.stringify(result));
  return result;
}

function pushWindow(f) {
  const handoff = f.handoff().receipt;
  f.scan();
  const task = f.task();
  const head = f.advanceHead();
  f.update(s => { s.pr.headRefOid = head; });
  const pending = f.scan();
  assert.equal(pending.prs[0].dispatch.reason, 'head-change-unconfirmed', JSON.stringify(pending));
  assert.equal(f.deliveries().length, 1);
  assert.notEqual(f.entry().activeTask.blockedKind, 'author-reclaimed');
  assert.deepEqual(f.entry().handoff, handoff);
  assert.match(f.owner(task, false), /task head is stale/);
  return { handoff, task, head };
}

test('pushed HEAD before helper receipt pauses safely, then consumes the late result without a second writer', t => {
  const f = fixture(t);
  const { handoff, task, head } = pushWindow(f);
  const fingerprint = f.entry().pollFingerprint;
  const result = pushedResult(f, task, head);
  // The scan has enough budget to consume the result, but intentionally defers
  // the separate CI recheck. No fabricated local validation receipt is needed.
  const resumed = f.scan(35000);
  assert.equal(resumed.prs[0].dispatch.reason, 'waiting-ci', JSON.stringify(resumed));
  assert.equal(f.entry().pollFingerprint, fingerprint, 'GitHub poll snapshot did not change');
  assert.equal(f.entry().activeTask.receiptId, result.receiptId, 'late result bypassed the unchanged-fingerprint shortcut');
  assert.equal(f.entry().activeTask.head, head);
  assert.equal(f.entry().activeTask.status, 'waiting-ci');
  assert.equal(f.entry().activeTask.blockedKind, null);
  assert.equal(f.entry().recheckDeferredAt, now);
  assert.equal(f.entry().lastRecheckError, undefined);
  assert.deepEqual(f.entry().handoff, handoff);
  assert.equal(f.deliveries().length, 1);
});

test('a genuine Draft still permanently revokes ownership while a pushed HEAD awaits its receipt', t => {
  const f = fixture(t);
  const { task, head } = pushWindow(f);
  f.reclaim();
  f.scan();
  assert.equal(f.entry().activeTask.blockedKind, 'author-reclaimed');
  assert.equal(f.entry().handoff, null);
  pushedResult(f, task, head);
  readyAgain(f);
  f.scan();
  assert.equal(f.entry().activeTask.blockedKind, 'author-reclaimed');
  assert.equal(f.entry().handoff, null);
  assert.match(f.owner(task, false), /superseded/);
  assert.equal(f.deliveries().length, 1);
});
