import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { readFacts } from './bin/facts.mjs';
import { createGithubClient } from './bin/github.mjs';
import { readRounds } from './bin/round-log.mjs';
import { readPr, writePr } from './bin/state.mjs';
import { main, runSteward } from './bin/steward.mjs';
import { chores } from './bin/stages/chores.mjs';
import { HEAD, NEXT, REPO, REVIEWER, USER } from './fixtures/pulls.mjs';
import { actionsCheck, addComment, discussion, githubFixture, PR, REPLY, reviewed } from './fixtures/chores/cases.mjs';

const p3 = { p3Close: true, p3Reply: REPLY, followerLogin: USER.login };
const review = { resolveReverified: true, reverifiedPatterns: ['^Fixed and verified'] };
const infra = { rerunInfra: true };
const falseGreen = { rerunFalseGreen: true, falseGreenNeeds: { verify: ['compile'] } };
const greenChecks = [
  actionsCheck('verify', 'SKIPPED', 22),
  actionsCheck('unrelated', 'FAILURE', 23, { required: false }),
  actionsCheck('compile', 'CANCELLED', 21, { required: false }),
];

function setup(t, settings, options, mode = 'app') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-chores-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = githubFixture(options);
  const stateDir = path.join(root, 'state');
  const profile = {
    stateDir, github: { mode }, authors: [USER.login], repos: [REPO], excludeRepos: [],
    policies: settings ? { [REPO]: { chores: settings, trustedReviewers: [REVIEWER.login],
      severityPatterns: { P1: [/P1/i], P3: [/P3/i] }, infraPatterns: [/runner lost/i] } } : {},
  };
  const logs = [];
  const log = (line) => logs.push(line);
  const run = (client = fixture.app) => runSteward({ command: 'tick', profile, client, log });
  const tickChores = async (dryRun = false) => {
    const facts = [await readFacts(fixture.app, profile, { pr: PR, repo: REPO, number: 1, ignored: [] })];
    if (!dryRun) writePr(stateDir, PR, { ...readPr(stateDir, PR), head: facts[0].head });
    await chores({ profile, client: fixture.app, facts, replyClient: fixture.follower, dryRun, log });
  };
  return { ...fixture, log, logs, run, root, stateDir, profile, tickChores };
}

test('SC1: P3 replies with the follower and App closes only once', async (t) => {
  const ctx = setup(t, p3, { threads: [discussion('P3 suggestion')] });
  await ctx.tickChores();
  await ctx.tickChores();
  assert.deepEqual(ctx.calls, [['follower.reply', REPO, 1, 1, REPLY], ['app.resolve', 'PRRT_example']]);
  assert.deepEqual(readPr(ctx.stateDir, PR).chores.p3ClosedThreads, { PRRT_example: true });
});

test('SC2: a comment during the reply blocks resolve now and next tick', async (t) => {
  const item = discussion('P3 suggestion');
  const ctx = setup(t, p3, { threads: [item] });
  const post = ctx.follower.replyToThread;
  ctx.follower.replyToThread = async (...args) => {
    const result = await post(...args);
    addComment(item, 6, 'Please keep this open', { login: 'AnotherUser', type: 'User' });
    return result;
  };
  await ctx.tickChores();
  await ctx.tickChores();
  assert.deepEqual(ctx.calls, [['follower.reply', REPO, 1, 1, REPLY]]);
  assert.match(ctx.logs.join('\n'), /最后一句，不关闭/);
  assert.equal(readPr(ctx.stateDir, PR).chores.p3Replies.PRRT_example, 5);
});

test('SC3: configured mismatch and actual viewer mismatch both prevent writes', async (t) => {
  const configured = setup(t, { ...p3, replyLogin: 'AnotherUser' }, { threads: [discussion('P3 suggestion')] });
  const actual = setup(t, p3, { threads: [discussion('P3 suggestion')] });
  actual.follower.viewer = async () => ({ login: 'AnotherUser', type: 'User' });
  for (const ctx of [configured, actual]) {
    await ctx.tickChores();
    assert.deepEqual(ctx.calls, []);
    assert.match(ctx.logs.join('\n'), /followerLogin 不一致/);
  }
});

test('SC4: infra reruns only the failed Actions job once per head and check', async (t) => {
  const options = { checks: [actionsCheck('test', 'FAILURE', 20, { summary: 'runner lost' }),
    actionsCheck('lint', 'FAILURE', 30), actionsCheck('passed', 'SUCCESS', 40, { summary: 'runner lost' })] };
  const ctx = setup(t, infra, options);
  await ctx.run();
  options.checks[0] = actionsCheck('test', 'FAILURE', 25, { summary: 'runner lost' });
  await ctx.run();
  options.head = NEXT;
  await ctx.run();
  assert.deepEqual(ctx.calls, [['app.rerun', REPO, 20], ['app.rerun', REPO, 25]]);
});

test('SC5: false green reruns the configured cancelled prerequisite and stays repairable', async (t) => {
  const ctx = setup(t, falseGreen, { checks: greenChecks });
  for (let tick = 0; tick < 2; tick++) {
    const result = await ctx.run();
    assert.equal(result.prs[0].classification, '要修');
    assert.ok(result.prs[0].reasons.some(({ code }) => code === 'false_green'));
  }
  assert.deepEqual(ctx.calls, [['app.rerun', REPO, 21]]);
});

test('SC6: only the latest trusted reverified reply closes using App transport, without posting', async (t) => {
  const item = reviewed('Optional follow-up', `Fixed and verified ${HEAD}`);
  const stale = { ...reviewed('Optional follow-up', `Fixed and verified ${NEXT}`), id: 'PRRT_stale' };
  const human = { ...reviewed('Optional follow-up', 'Fixed and verified', USER), id: 'PRRT_human' };
  const urgent = { ...reviewed('P1 fix', 'Fixed and verified'), id: 'PRRT_urgent' };
  const ctx = setup(t, review, { threads: [item, stale, human, urgent] });
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyFile = path.join(ctx.root, 'fixture.pem');
  fs.writeFileSync(privateKeyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const writes = createGithubClient({ mode: 'app', appId: 1, installationId: 2, privateKeyFile }, {
    env: { GH_TOKEN: 'follower-fixture' },
    fetchFn: async () => ({ ok: true, json: async () => ({
      token: 'app-fixture', expires_at: '2099-01-01T00:00:00Z',
    }) }),
    run: (command, args, options) => {
      const payload = JSON.parse(options.input);
      assert.equal(command, 'gh');
      assert.equal(args[1], 'graphql');
      assert.equal(options.env.GH_TOKEN, 'app-fixture');
      assert.match(payload.query, /resolveReviewThread/);
      assert.deepEqual(payload.variables, { id: 'PRRT_example' });
      return { status: 0, stdout: JSON.stringify({ data: { resolveReviewThread: {
        thread: { id: 'PRRT_example', isResolved: true },
      } } }) };
    },
  });
  await ctx.run({ ...ctx.app, resolveThread: writes.resolveThread });
  await ctx.run({ ...ctx.app, resolveThread: writes.resolveThread });
  assert.deepEqual(writes.calls, ['resolveThread', 'authenticateApp']);
  assert.deepEqual(ctx.calls, []);
});

test('SC7: disabled flags, absent policy, and non-App mode make no writes', async (t) => {
  const options = { threads: [discussion('P3 suggestion')], checks: greenChecks };
  for (const [settings, mode] of [[{}, 'app'], [null, 'app'], [p3, 'gh']]) {
    const ctx = setup(t, settings, options, mode);
    await ctx.tickChores();
    assert.deepEqual(ctx.calls, []);
    assert.deepEqual(readRounds(ctx.stateDir, PR), []);
  }
});

test('SC8: CLI tick --dry-run lists each planned action and writes nothing', async (t) => {
  const checks = [...greenChecks, actionsCheck('publish', 'FAILURE', 41, { run: 11, summary: 'runner lost' })];
  const ctx = setup(t, { ...review, ...infra, ...falseGreen }, { checks, threads: [reviewed('Optional', 'Fixed and verified')] });
  const profileFile = path.join(ctx.root, 'profile.json');
  const policy = { ...ctx.profile.policies[REPO], infraPatterns: ['runner lost'], severityPatterns: {} };
  fs.writeFileSync(profileFile, JSON.stringify({ ...ctx.profile, policies: { [REPO]: policy },
    github: { mode: 'app', appId: 1, installationId: 2, privateKeyFile: 'unused.pem' } }));
  const output = [];
  assert.equal(await main(['tick', '--dry-run'], {
    env: { STEWARD_PROFILE: profileFile }, client: ctx.app, output: (line) => output.push(line), log: ctx.log,
  }), 0);
  assert.equal(JSON.parse(output[0]).prs[0].classification, '要修');
  assert.deepEqual(ctx.logs.filter((line) => line.includes('：将')), [
    `${PR} PRRT_example：将关闭已复核讨论串`,
    `${PR} compile：将重跑 false_green_rerun job 21`,
    `${PR} publish：将重跑 infra_rerun job 41`,
  ]);
  assert.deepEqual(ctx.calls, []);
  assert.equal(fs.existsSync(ctx.stateDir), false);
  const p3Ctx = setup(t, p3, { threads: [discussion('P3 suggestion')] });
  await p3Ctx.tickChores(true);
  assert.ok(p3Ctx.logs.includes(`${PR} PRRT_example：将回复并关闭 P3 讨论串`));
  assert.deepEqual(p3Ctx.calls, []);
  assert.equal(fs.existsSync(p3Ctx.stateDir), false);
});

test('SC9: each attempted chore records one outcome; failures retry only next tick', async (t) => {
  const ctx = setup(t, { ...p3, ...infra }, { threads: [discussion('P3 suggestion')],
    checks: [actionsCheck('test', 'FAILURE', 20, { summary: 'runner lost' })] });
  const resolve = ctx.app.resolveThread;
  ctx.app.resolveThread = async () => { ctx.calls.push(['app.resolve.failed']); throw new Error('HTTP 503'); };
  await ctx.tickChores();
  ctx.app.resolveThread = resolve;
  await ctx.tickChores();
  assert.deepEqual(ctx.calls, [['follower.reply', REPO, 1, 1, REPLY], ['app.resolve.failed'],
    ['app.rerun', REPO, 20], ['app.resolve', 'PRRT_example']]);
  assert.deepEqual(readRounds(ctx.stateDir, PR).map(({ type, pr, chore_type, object, result }) =>
    [type, pr, chore_type, object, result]), [
    ['chore', PR, 'p3_close', 'PRRT_example', 'failed'],
    ['chore', PR, 'infra_rerun', 20, 'rerun'],
    ['chore', PR, 'p3_close', 'PRRT_example', 'closed'],
  ]);
  assert.match(ctx.logs.join('\n'), /HTTP 503/);
});

test('ambiguous prerequisites and untrusted job URLs are not rerun', async (t) => {
  const spoof = actionsCheck('infra', 'FAILURE', 28, { summary: 'runner lost' });
  spoof.detailsUrl = 'https://example.org/example-org/example-repo/actions/runs/10/job/28';
  const ctx = setup(t, { ...infra, ...falseGreen, falseGreenNeeds: { verify: ['compile', 'unrelated'] } },
    { checks: [...greenChecks, spoof] });
  await ctx.run();
  assert.deepEqual(ctx.calls, []);
  assert.match(ctx.logs.join('\n'), /无法唯一确认假绿灯/);
  assert.match(ctx.logs.join('\n'), /无法确认 GitHub Actions job/);
});

test('infra and false green cannot rerun the same check twice', async (t) => {
  const options = { checks: [actionsCheck('compile', 'FAILURE', 21, { required: false, summary: 'runner lost' })] };
  const ctx = setup(t, { ...infra, ...falseGreen }, options);
  await ctx.run();
  options.checks = [actionsCheck('verify', 'SKIPPED', 22), actionsCheck('compile', 'FAILURE', 25, { required: false })];
  assert.equal((await ctx.run()).prs[0].classification, '要修');
  assert.deepEqual(ctx.calls, [['app.rerun', REPO, 21]]);
});

test('head changes between observation and mutation leave the old job untouched', async (t) => {
  const options = { checks: [actionsCheck('test', 'FAILURE', 20, { summary: 'runner lost' })] };
  const ctx = setup(t, infra, options);
  const get = ctx.app.getPull;
  ctx.app.getPull = async (...args) => {
    const snapshot = await get(...args);
    options.head = NEXT;
    return snapshot;
  };
  await ctx.run();
  assert.deepEqual(ctx.calls, []);
  assert.match(ctx.logs.join('\n'), /当前提交或检查已变化/);
});
