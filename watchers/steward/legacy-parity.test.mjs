import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planBaseSync } from './bin/chores/base-sync.mjs';
import { readFacts } from './bin/facts.mjs';
import { createGithubClient } from './bin/github.mjs';
import { loadProfile } from './bin/profile.mjs';
import { readRounds } from './bin/round-log.mjs';
import { main, runSteward } from './bin/steward.mjs';
import { HEAD, NEXT, REPO, REVIEWER, USER, check, fixtureClient, pull } from './fixtures/pulls.mjs';
import { actionsCheck, addComment, discussion, githubFixture, PR } from './fixtures/chores/cases.mjs';

const EXAMPLE = 'config/examples/steward.profile.example.json';
const CANDIDATE = { pr: PR, repo: REPO, number: 1, source: 'explicit', ignored: [] };
const NOW = new Date('2026-11-27T12:00:00Z');
const hoursAgo = (hours) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const CODEQL_DOWNLOAD = 'Unable to download and extract CodeQL CLI';
const SYNC = { syncBase: { enabled: true, bases: ['^main$'], minBehind: 10, maxAgeHours: 48 } };
const REVERIFY = { resolveReverified: true, reverifiedPatterns: ['^Fixed and verified'], reverifiedKeyPattern: 'key=([a-z0-9-]+)' };

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-parity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function profileFor(policy = {}, stateDir) {
  return {
    stateDir, github: { mode: 'app' }, authors: [USER.login], repos: [REPO], excludeRepos: [],
    policies: { [REPO]: { trustedReviewers: [REVIEWER.login], severityPatterns: { P1: [/P1/i], P3: [/P3/i] }, ...policy } },
  };
}

function factsFor(policy, fields) {
  return readFacts(fixtureClient({ get: () => pull(1, fields) }), profileFor(policy), CANDIDATE);
}

function tickContext(t, policy, options) {
  const stateDir = path.join(temporary(t), 'state');
  const fixture = githubFixture(options);
  const profile = profileFor(policy, stateDir);
  const logs = [];
  const tick = (client = fixture.app) => runSteward({ command: 'tick', profile, client, log: (line) => logs.push(line), now: () => NOW });
  return { ...fixture, logs, stateDir, tick };
}

function reply(item, body, author = REVIEWER, id = 2) {
  addComment(item, id, body, author);
  return item;
}

test('SC1: the latest failed optional Actions check is a repair reason only when the policy blocks', async () => {
  const block = { optionalChecks: { block: true, ignorePatterns: [/^Analyze \(/i] } };
  const red = [check('build', 'SUCCESS'), actionsCheck('handoff', 'FAILURE', 1, { required: false })];
  const blocked = await factsFor(block, { checks: red });
  assert.equal(blocked.classification, '要修');
  assert.deepEqual(blocked.reasons, [{ code: 'optional_check_failed', name: 'handoff' }]);
  for (const conclusion of ['TIMED_OUT', 'STARTUP_FAILURE']) {
    const facts = await factsFor(block, { checks: [actionsCheck('handoff', conclusion, 1, { required: false })] });
    assert.deepEqual(facts.reasons, [{ code: 'optional_check_failed', name: 'handoff' }]);
  }
  const notCounted = [
    // A later successful attempt of the same check replaces the failure, whichever order GitHub lists them in.
    [actionsCheck('handoff', 'SUCCESS', 2, { required: false, startedAt: '2026-11-27T10:00:00Z' }),
      actionsCheck('handoff', 'FAILURE', 1, { required: false, startedAt: '2026-11-27T09:00:00Z' })],
    [actionsCheck('Analyze (python)', 'FAILURE', 3, { required: false })],
    [actionsCheck('handoff', 'CANCELLED', 1, { required: false })],
    [check('external', 'FAILURE', { required: false, appId: 7 })],
  ];
  for (const checks of notCounted) {
    const facts = await factsFor(block, { checks });
    assert.equal(facts.classification, '没事');
    assert.deepEqual(facts.reasons, []);
  }
  const later = await factsFor(block, { checks: [
    actionsCheck('handoff', 'SUCCESS', 2, { required: false, startedAt: '2026-11-27T09:00:00Z' }),
    actionsCheck('handoff', 'FAILURE', 1, { required: false, startedAt: '2026-11-27T10:00:00Z' }),
  ] });
  assert.deepEqual(later.reasons, [{ code: 'optional_check_failed', name: 'handoff' }]);
  const absent = await factsFor({}, { checks: red });
  const off = await factsFor({ optionalChecks: { block: false, ignorePatterns: [] } }, { checks: red });
  assert.deepEqual([absent.classification, absent.reasons], ['没事', []]);
  assert.deepEqual(off, absent);
});

test('SC2: failure annotations mark infra, rerun once per head, and all must match when required', async (t) => {
  const infraPatterns = [/Unable to download and extract CodeQL\b/i, /HTTP status code:? 5\d\d/i];
  const annotated = (annotations) => [actionsCheck('Analyze (python)', 'FAILURE', 50, { required: false, annotations })];
  const allInfra = [['FAILURE', CODEQL_DOWNLOAD], ['FAILURE', 'HTTP status code: 504'], ['WARNING', 'deprecated input']];
  const ctx = tickContext(t, { infraPatterns, chores: { rerunInfra: true } }, { checks: annotated(allInfra) });
  const first = await ctx.tick();
  assert.equal(first.prs[0].checks[0].description, '');
  assert.equal(first.prs[0].checks[0].infra, true);
  assert.deepEqual(ctx.calls, [['app.rerun', REPO, 50]]);
  await ctx.tick();
  assert.deepEqual(ctx.calls, [['app.rerun', REPO, 50]]);

  const mixed = [['FAILURE', CODEQL_DOWNLOAD], ['FAILURE', 'Query compilation failed']];
  const strict = tickContext(t, { infraPatterns, infraRequiresAllAnnotations: true, chores: { rerunInfra: true } },
    { checks: annotated(mixed) });
  assert.equal((await strict.tick()).prs[0].checks[0].infra, false);
  assert.deepEqual(strict.calls, []);
  const loose = await factsFor({ infraPatterns }, { checks: annotated(mixed) });
  assert.equal(loose.checks[0].infra, true);

  const truncated = annotated(allInfra);
  truncated[0].annotations.pageInfo.hasNextPage = true;
  const unknown = await factsFor({ infraPatterns }, { checks: truncated });
  assert.equal(unknown.classification, '未知');
  assert.match(unknown.reasons[0].detail, /check annotations: missing or truncated/);
});

test('SC3: BEHIND is waiting when base sync is on, repair when off, and never unknown', async () => {
  const behind = { mergeStateStatus: 'BEHIND', checks: [check('build', 'SUCCESS')] };
  const on = await factsFor({ chores: SYNC }, behind);
  assert.deepEqual([on.classification, on.reasons], ['等待中', [{ code: 'behind_base' }]]);
  const off = await factsFor({}, behind);
  assert.deepEqual([off.classification, off.reasons], ['要修', [{ code: 'behind_base' }]]);
  const failing = await factsFor({ chores: SYNC }, { mergeStateStatus: 'BEHIND', checks: [check('build', 'FAILURE')] });
  assert.deepEqual([failing.classification, failing.reasons], ['要修', [{ code: 'required_check_failed', name: 'build' }]]);
});

test('SC4: a due ready PR is updated once per head and base tip with the current head', async (t) => {
  for (const drift of [{ behindBy: 10, mergeBaseAt: hoursAgo(1) }, { behindBy: 3, mergeBaseAt: hoursAgo(49) }]) {
    const ctx = tickContext(t, { chores: SYNC }, { drift });
    await ctx.tick();
    await ctx.tick();
    assert.deepEqual(ctx.calls, [['app.updateBranch', REPO, 1, HEAD]]);
  }
  const below = tickContext(t, { chores: SYNC }, { drift: { behindBy: 9, mergeBaseAt: hoursAgo(47) } });
  await below.tick();
  assert.deepEqual(below.calls, []);
  assert.ok(below.logs.includes(`${PR}：不更新分支（below_threshold）`));
});

test('SC4: repair, conflict, draft, unlisted base and PR-only head branches are not updated', async (t) => {
  const drift = { behindBy: 20, mergeBaseAt: hoursAgo(1) };
  for (const [options, reason] of [
    [{ checks: [check('build', 'FAILURE')] }, 'needs_repair'],
    [{ mergeable: 'CONFLICTING' }, 'conflict'],
    [{ baseRefName: 'release' }, 'base_not_listed'],
    [{ branchRules: { 'feature/example': [{ type: 'pull_request' }] } }, 'head_requires_pr'],
  ]) {
    const ctx = tickContext(t, { chores: SYNC }, { drift, ...options });
    await ctx.tick();
    assert.deepEqual(ctx.calls, [], reason);
    assert.ok(ctx.logs.includes(`${PR}：不更新分支（${reason}）`), reason);
  }
  const draft = tickContext(t, { chores: SYNC }, { drift, isDraft: true });
  assert.equal((await draft.tick()).prs[0].classification, '不管');
  assert.deepEqual(draft.calls, []);
  const settings = { bases: [/^main$/i], minBehind: 10, maxAgeHours: 48 };
  const plan = await planBaseSync({ fact: { draft: true }, state: {}, settings, reader: {}, now: NOW });
  assert.deepEqual(plan, { reason: 'draft' });
});

test('SC4: a head that GitHub reports as changed is held and not retried', async (t) => {
  const error = Object.assign(new Error('updateBranch: GitHub request failed (HTTP 422)'), { code: 'HEAD_CHANGED' });
  const ctx = tickContext(t, { chores: SYNC }, { drift: { behindBy: 12, mergeBaseAt: hoursAgo(1) }, updateBranchError: error });
  await ctx.tick();
  await ctx.tick();
  assert.deepEqual(ctx.calls, [['app.updateBranch', REPO, 1, HEAD]]);
  assert.deepEqual(readRounds(ctx.stateDir, PR).map(({ chore_type, result }) => [chore_type, result]), [['base_sync', 'held']]);
  assert.ok(ctx.logs.includes(`${PR}：不更新分支（already_held）`));
  const client = createGithubClient({ mode: 'gh' }, { env: {}, run: (binary, args, options) => {
    assert.deepEqual([args[1], args[5], JSON.parse(options.input)],
      [`repos/${REPO}/pulls/1/update-branch`, 'PUT', { expected_head_sha: HEAD }]);
    return { status: 1, stderr: 'expected head sha didn\'t match current head ref. (HTTP 422)' };
  } });
  await assert.rejects(client.updateBranch(REPO, 1, HEAD), { code: 'HEAD_CHANGED' });
});

test('SC5: configured P1 threads close only when the same reviewer App confirms key and current head', async (t) => {
  const root = (id) => ({ ...discussion('P1 broken input key=f-1'), id });
  const threads = [
    reply(root('PRRT_good'), `Fixed and verified at ${HEAD} key=f-1`),
    reply(root('PRRT_key'), `Fixed and verified at ${HEAD} key=f-2`),
    reply(root('PRRT_stale'), `Fixed and verified at ${NEXT} key=f-1`),
    reply(root('PRRT_other'), `Fixed and verified at ${HEAD} key=f-1`, { login: 'other-reviewer[bot]', __typename: 'Bot' }),
    reply(root('PRRT_nokey'), `Fixed and verified at ${HEAD}`),
  ];
  const ctx = tickContext(t, { chores: { ...REVERIFY, reverifiedSeverities: ['P1', 'P3'] } }, { threads });
  const directory = temporary(t);
  const privateKeyFile = path.join(directory, 'fixture.pem');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const resolved = [];
  const writes = createGithubClient({ mode: 'app', appId: 1, installationId: 2, privateKeyFile }, {
    env: { GH_TOKEN: 'follower-fixture' },
    fetchFn: async () => ({ ok: true, json: async () => ({ token: 'app-fixture', expires_at: '2099-01-01T00:00:00Z' }) }),
    run: (binary, args, options) => {
      assert.equal(options.env.GH_TOKEN, 'app-fixture');
      const { variables } = JSON.parse(options.input);
      resolved.push(variables.id);
      return { status: 0, stdout: JSON.stringify({ data: { resolveReviewThread: { thread: { id: variables.id, isResolved: true } } } }) };
    },
  });
  const client = { ...ctx.app, resolveThread: writes.resolveThread, replyToThread: () => assert.fail('no reply expected') };
  await ctx.tick(client);
  await ctx.tick(client);
  assert.deepEqual(resolved, ['PRRT_good']);
  assert.deepEqual(ctx.calls, []);

  const p1 = reply(root('PRRT_good'), `Fixed and verified at ${HEAD} key=f-1`);
  const p3 = { ...reply(discussion('P3 optional key=f-9'), `Fixed and verified ${HEAD}`), id: 'PRRT_p3' };
  const defaults = tickContext(t, { chores: REVERIFY }, { threads: [p1, p3] });
  await defaults.tick();
  await defaults.tick();
  assert.deepEqual(defaults.calls, [['app.resolve', 'PRRT_p3']]);
});

test('SC6 and SC7: dry-run lists new writes without calling them; a real sync logs one base_sync chore', async (t) => {
  const directory = temporary(t);
  const stateDir = path.join(directory, 'state');
  const p1 = reply({ ...discussion('P1 broken key=f-1'), id: 'PRRT_p1' }, `Fixed and verified at ${HEAD} key=f-1`);
  const fixture = githubFixture({ threads: [p1], drift: { behindBy: 12, mergeBaseAt: hoursAgo(1) } });
  const file = path.join(directory, 'profile.json');
  fs.writeFileSync(file, JSON.stringify({
    stateDir, authors: [USER.login], repos: [REPO],
    github: { mode: 'app', appId: 1, installationId: 2, privateKeyFile: 'unused.pem' },
    policies: { [REPO]: { trustedReviewers: [REVIEWER.login], severityPatterns: { P1: ['P1'] },
      chores: { ...SYNC, ...REVERIFY, reverifiedSeverities: ['P1'] } } },
  }));
  const logs = [];
  const output = [];
  assert.equal(await main(['tick', '--dry-run'], { env: { STEWARD_PROFILE: file }, client: fixture.app,
    output: (line) => output.push(line), log: (line) => logs.push(line) }), 0);
  assert.equal(JSON.parse(output[0]).prs[0].classification, '要修');
  assert.deepEqual(logs.filter((line) => line.includes('：将')), [`${PR} PRRT_p1：将关闭已复核 P1 讨论串`]);
  assert.deepEqual(fixture.calls, []);
  assert.equal(fs.existsSync(stateDir), false);

  const ready = tickContext(t, { chores: SYNC }, { drift: { behindBy: 12, mergeBaseAt: hoursAgo(1) } });
  const dry = await runSteward({ command: 'tick', dryRun: true, profile: profileFor({ chores: SYNC }, ready.stateDir),
    client: ready.app, log: (line) => ready.logs.push(line), now: () => NOW });
  assert.equal(dry.prs[0].classification, '没事');
  assert.ok(ready.logs.includes(`${PR}：将更新分支，同步 main（落后 12 个提交）`));
  assert.deepEqual(ready.calls, []);
  await ready.tick();
  await ready.tick();
  const chores = readRounds(ready.stateDir, PR).filter(({ type }) => type === 'chore');
  assert.deepEqual(chores.map(({ pr, chore_type, object, head, result }) => [pr, chore_type, object, head, result]),
    [[PR, 'base_sync', 'main', HEAD, 'synced']]);
});

test('SC8: invalid new keys name the key; the example profile loads', (t) => {
  const directory = temporary(t);
  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  const base = example.policies['example-org/example-repo'];
  const load = (policy) => {
    const file = path.join(directory, 'profile.json');
    fs.writeFileSync(file, JSON.stringify({ ...example, policies: { 'example-org/example-repo': { ...base, ...policy } } }));
    return loadProfile({ file });
  };
  const chores = (value) => ({ chores: { ...base.chores, ...value } });
  const sync = (value) => chores({ syncBase: { ...base.chores.syncBase, ...value } });
  for (const [policy, key] of [
    [{ optionalChecks: { block: 'yes' } }, 'optionalChecks.block'],
    [{ optionalChecks: { ignorePatterns: ['('] } }, 'optionalChecks.ignorePatterns'],
    [{ optionalChecks: { ignorePatterns: 'Analyze' } }, 'optionalChecks.ignorePatterns'],
    [{ infraRequiresAllAnnotations: 1 }, 'infraRequiresAllAnnotations'],
    [sync({ enabled: 'true' }), 'chores.syncBase.enabled'],
    [sync({ enabled: true, bases: [] }), 'chores.syncBase.bases'],
    [sync({ bases: ['['] }), 'chores.syncBase.bases'],
    [sync({ minBehind: 0 }), 'chores.syncBase.minBehind'],
    [sync({ minBehind: 2.5 }), 'chores.syncBase.minBehind'],
    [sync({ maxAgeHours: -1 }), 'chores.syncBase.maxAgeHours'],
    [chores({ syncBase: [] }), 'chores.syncBase'],
    [chores({ reverifiedSeverities: ['P4'] }), 'chores.reverifiedSeverities'],
    [chores({ reverifiedKeyPattern: 'key=\\w+' }), 'chores.reverifiedKeyPattern'],
    [chores({ reverifiedKeyPattern: '(a)(b)' }), 'chores.reverifiedKeyPattern'],
    [chores({ reverifiedKeyPattern: '(' }), 'chores.reverifiedKeyPattern'],
  ]) {
    assert.throws(() => load(policy), (error) => error.message.includes(`policies.example-org/example-repo.${key}`), key);
  }
  const profile = loadProfile({ file: EXAMPLE });
  const policy = profile.policies['example-org/example-repo'];
  assert.deepEqual([policy.optionalChecks.block, policy.optionalChecks.ignorePatterns.map(String), policy.infraRequiresAllAnnotations],
    [false, ['/^Analyze \\(/i'], false]);
  assert.deepEqual(policy.chores.syncBase, { enabled: false, bases: ['^main$'], minBehind: 10, maxAgeHours: 48 });
});
