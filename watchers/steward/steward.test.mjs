import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { discover } from './bin/discover.mjs';
import { readFacts } from './bin/facts.mjs';
import { loadProfile } from './bin/profile.mjs';
import { readRounds } from './bin/round-log.mjs';
import { main, runSteward } from './bin/steward.mjs';
import { readPr, withPrLock, writePr } from './bin/state.mjs';
import {
  BASE, HEAD, NEXT, REPO, USER, REVIEWER, check, connection, discoveryRows,
  fixtureClient, pull, row, searchRows, thread,
} from './fixtures/pulls.mjs';

const EXAMPLE = 'config/examples/steward.profile.example.json';
const PR = `${REPO}#1`;
const CANDIDATE = { ...row(1), pr: PR, source: 'explicit', ignored: [] };
const profile = loadProfile({ file: EXAMPLE });

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function localConfig(t, changes = {}) {
  const directory = temporary(t);
  const config = { ...JSON.parse(fs.readFileSync(EXAMPLE, 'utf8')), ...changes };
  const file = path.join(directory, 'profile.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return { env: { STEWARD_PROFILE: file }, directory, stateDir: path.join(directory, 'steward-state') };
}

test('SC1: explicit and author discovery dedupe and explain three exclusions', async () => {
  const client = fixtureClient({ listed: [...discoveryRows, row(7, { state: 'closed' })], searched: searchRows });
  const result = await discover(client, profile);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.prs.map((pr) => [pr.number, pr.source, pr.ignored]), [
    [1, 'explicit', []], [2, 'explicit', []], [4, 'explicit', ['author_not_listed']], [5, 'explicit', ['draft']],
    [3, 'search', []], [6, 'search', ['excluded_repo']],
  ]);
  const scanClient = fixtureClient({
    listed: discoveryRows, searched: searchRows,
    get: (repo, number) => pull(number, { author: discoveryRows.find((entry) => entry.number === number)?.author ?? USER }),
  });
  const scan = await runSteward({ command: 'scan', profile, client: scanClient });
  assert.equal(scan.prs.filter((pr) => pr.classification === '不管').length, 3);
  assert.deepEqual(scan.prs.filter((pr) => pr.classification === '不管').map((pr) => pr.reasons[0].code),
    ['author_not_listed', 'draft', 'excluded_repo']);
  assert.equal(scanClient.calls.filter((call) => call === 'getPull').length, 3);
  assert.equal(scanClient.calls.filter((call) => call === 'listBranchRules').length, 2);
});

test('an incomplete discovery source does not conceal successfully enumerated PRs', async () => {
  const client = fixtureClient({ searched: searchRows });
  client.searchOpenPulls = async () => { throw new Error('incomplete search'); };
  const result = await runSteward({ command: 'scan', profile: { ...profile, authors: ['ExampleUser'] }, client });
  assert.equal(result.prs.length, 1);
  assert.deepEqual(result.discoveryErrors, [{ scope: 'ExampleUser', reason: 'incomplete search' }]);
});

async function factsFor(fields, options = {}) {
  return readFacts(fixtureClient({ get: () => pull(1, fields), ...options }), profile, CANDIDATE);
}

test('SC2: skipped required checks are false green only with failed or cancelled checks on this head', async () => {
  for (const conclusion of ['FAILURE', 'CANCELLED']) {
    const facts = await factsFor({ checks: [check('gate', 'SKIPPED'), check('upstream', conclusion, { required: false })] });
    assert.equal(facts.classification, '要修');
    assert.deepEqual(facts.reasons, [{ code: 'false_green', checks: ['gate'] }]);
    assert.equal(facts.falseGreen.failed[0].conclusion, conclusion);
  }
  const facts = await factsFor({ checks: [check('gate', 'SKIPPED'), check('upstream', 'SUCCESS', { required: false })] });
  assert.equal(facts.classification, '没事');
  assert.equal(facts.falseGreen, null);
  assert.equal(facts.requiredChecks[0].result, 'skipped');
});

for (const [label, fields, classification, reason] of [
  ['product check failed', { checks: [check('test', 'FAILURE')] }, '要修', 'required_check_failed'],
  ['infrastructure failed', { checks: [check('test', 'FAILURE', { summary: 'HTTP 503' })] }, '等待中', 'infra'],
  ['trusted P2', { threads: [thread('P2: follow up')] }, '要修', 'review_thread'],
  ['ungraded trusted', { threads: [thread('Please look again')] }, '要修', 'review_thread'],
  ['human outdated', { threads: [thread('fix this', { author: USER })] }, '要修', 'review_thread'],
  ['trusted P3 only', { threads: [thread('P3: optional')] }, '没事'],
  ['conflict', { mergeable: 'CONFLICTING' }, '要修', 'merge_conflict'],
  ['manual approval', { mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }, '等人', 'manual_approval_or_merge'],
]) {
  test(`SC3: ${label}`, async () => {
    const facts = await factsFor(fields);
    assert.equal(facts.classification, classification);
    assert.equal(facts.reasons[0]?.code, reason);
    if (label === 'infrastructure failed') assert.equal(facts.requiredChecks[0].infra, true);
    if (label === 'trusted P3 only') {
      assert.deepEqual(facts.threads.map(({ source, severity, outdated }) => [source, severity, outdated]),
        [['trusted_bot', 'P3', true]]);
    }
  });
}

for (const [label, refUpdateRule, rules, reviewThread, expectedThread] of [
  ['ruleset', null, [{ type: 'pull_request', parameters: { required_review_thread_resolution: true } }],
    thread('P3: optional'), ['example-thread', 'trusted_bot', 'P3']],
  ['classic protection', { requiredStatusCheckContexts: [], requiresConversationResolution: true }, [],
    thread('other automation', { author: { login: 'other[bot]', __typename: 'Bot' } }), ['example-thread', 'other_bot', null]],
]) {
  test(`SC3: ${label} BLOCKED by only P3 or other bot threads remains healthy`, async () => {
    const facts = await factsFor({
      mergeStateStatus: 'BLOCKED', baseRef: { refUpdateRule },
      checks: [check('test', 'SUCCESS')],
      threads: [reviewThread],
    }, { rules });
    assert.equal(facts.classification, '没事');
    assert.deepEqual(facts.reasons, []);
    assert.deepEqual(facts.threads.map(({ id, source, severity }) => [id, source, severity]),
      [expectedThread]);
  });
}

test('SC3: BLOCKED with P3 but without required thread resolution remains unknown', async () => {
  const facts = await factsFor({
    mergeStateStatus: 'BLOCKED',
    baseRef: { refUpdateRule: { requiredStatusCheckContexts: [], requiresConversationResolution: false } },
    checks: [check('test', 'SUCCESS')], threads: [thread('P3: optional')],
  }, { rules: [{ type: 'pull_request', parameters: { required_review_thread_resolution: false } }] });
  assert.equal(facts.classification, '未知');
  assert.deepEqual(facts.reasons, [{ code: 'read_failed', detail: 'merge status not explained: BLOCKED' }]);
});

test('required waiting is not masked by a manual review gate or a same-name check from a different app', async () => {
  const facts = await factsFor({
    mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
    checks: [check('gate', 'SUCCESS', { required: false, appId: 2 }),
      { __typename: 'StatusContext', context: 'external', state: 'PENDING', isRequired: true }],
    baseRef: { refUpdateRule: { requiredStatusCheckContexts: ['classic'] } },
  }, { rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'gate', integration_id: 1 }] } }] });
  assert.equal(facts.classification, '等待中');
  assert.deepEqual(facts.requiredChecks.map(({ name, result, appId }) => [name, result, appId]),
    [['external', 'running', null], ['classic', 'running', null], ['gate', 'running', 1]]);
});

test('resolved and other bot discussions do not block; known conflict outranks a running check', async () => {
  const threads = [thread('resolved', { resolved: true }), thread('P1 fake', { author: { login: 'other[bot]', __typename: 'Bot' } })];
  const facts = await factsFor({ threads });
  assert.equal(facts.classification, '没事');
  assert.deepEqual(facts.threads.map(({ source, severity }) => [source, severity]), [['other_bot', null]]);
  const conflict = await factsFor({ checks: [check('build', null, { status: 'IN_PROGRESS' })], mergeable: 'CONFLICTING' });
  assert.equal(conflict.classification, '要修');
});

test('only open code scanning alerts above threshold and bound to current head block', async () => {
  const client = fixtureClient();
  const merge = 'd'.repeat(40);
  const requested = [];
  client.listAlerts = async () => [1, 2, 3, 4, 5].map((number) => ({
    number, state: number === 5 ? 'fixed' : 'open', rule: { security_severity_level: number === 3 ? 'medium' : 'high' },
  }));
  client.listAlertInstances = async (repo, number, alert) => {
    assert.deepEqual([repo, number], [REPO, 1]);
    requested.push(alert);
    return [{ state: 'open', ref: alert === 4 ? 'refs/pull/1/merge' : 'refs/pull/1/head',
      commit_sha: alert === 4 ? merge : alert === 1 ? HEAD : NEXT }];
  };
  client.alertCommitParents = async (repo, sha) => {
    assert.deepEqual([repo, sha], [REPO, merge]);
    return [{ sha: BASE }, { sha: HEAD }];
  };
  await readFacts(client, profile, CANDIDATE);
  assert.deepEqual(requested, []);
  const scanningProfile = { ...profile, policies: { [REPO]: { codeScanning: { enabled: true, threshold: 'high' } } } };
  const facts = await readFacts(client, scanningProfile, CANDIDATE);
  assert.deepEqual(requested, [1, 2, 4]);
  assert.equal(facts.classification, '要修');
  assert.deepEqual(facts.alerts.map((alert) => alert.number), [1, 4]);
});

test('SC4: tick records one push per observed head transition without clearing halted', async (t) => {
  const { env, stateDir } = localConfig(t);
  writePr(stateDir, PR, { halted: true });
  const tick = async (head, conclusion) => {
    const client = fixtureClient({ get: () => pull(1, { head, checks: [check('test', conclusion)] }) });
    assert.equal(await main(['tick'], { env, client, output: () => {}, log: () => {} }), 0);
  };
  await tick(HEAD, 'FAILURE');
  assert.deepEqual(readRounds(stateDir, PR), []);
  await tick(NEXT, 'SUCCESS');
  await tick(NEXT, 'SUCCESS');
  const rounds = readRounds(stateDir, PR);
  assert.equal(rounds.length, 1);
  const [entry] = rounds;
  assert.deepEqual([entry.type, entry.pr, entry.before_head, entry.after_head, entry.before_classification],
    ['push', PR, HEAD, NEXT, '要修']);
  assert.deepEqual([entry.before_required_checks[0].result, entry.after_required_checks[0].result], ['failed', 'passed']);
  assert.equal(readPr(stateDir, PR).halted, true);
  assert.equal(readPr(stateDir, PR).head, NEXT);
});

test('SC5: read failure or truncation is unknown, exit 0, and leaves stored classification unchanged', async (t) => {
  const { env, stateDir } = localConfig(t);
  writePr(stateDir, PR, { head: HEAD, classification: '要修', required_checks: [] });
  for (const get of [
    () => { throw new Error('GitHub request failed (HTTP 429)'); },
    () => pull(1, { head: NEXT, reviewThreads: { ...connection([]), totalCount: 99 } }),
    () => pull(1, { head: NEXT, commits: { nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }] } }),
  ]) {
    const output = [];
    assert.equal(await main(['tick'], { env, client: fixtureClient({ get }), output: (line) => output.push(line), log: () => {} }), 0);
    const [result] = output.map(JSON.parse);
    assert.equal(result.unknown, 1);
    assert.equal(result.prs[0].classification, '未知');
    assert.equal(readPr(stateDir, PR).classification, '要修');
    assert.equal(readPr(stateDir, PR).head, HEAD);
    assert.deepEqual(readRounds(stateDir, PR), []);
  }
});

test('SC6: example loads; missing authors exits nonzero before calling GitHub', (t) => {
  assert.deepEqual(profile.authors, ['ExampleUser', 'app/example-qa']);
  const { env } = localConfig(t, { authors: undefined });
  const result = spawnSync(process.execPath, ['watchers/steward/bin/steward.mjs', 'scan'], {
    env, encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /authors/);
  assert.equal(result.stdout, '');
});

test('SC7: dry-run CLI contract runs five stages without GitHub writes or local writes', async (t) => {
  const { env, stateDir } = localConfig(t);
  const client = fixtureClient({ get: () => pull(1, { threads: [thread('P3 optional', { author: REVIEWER })] }) });
  const logs = [];
  const output = [];
  assert.equal(await main(['tick', '--dry-run'], { env, client, log: (line) => logs.push(line), output: (line) => output.push(line) }), 0);
  assert.deepEqual(logs, ['发现', '事实', '杂活：未启用', '覆盖：未启用', '守门：未启用']);
  assert.equal(JSON.parse(output[0]).prs[0].classification, '没事');
  assert.deepEqual(client.calls, ['listOpenPulls', 'searchOpenPulls', 'searchOpenPulls', 'getPull', 'listBranchRules']);
  assert.equal(fs.existsSync(stateDir), false);
});

test('PR locks reject a concurrent writer and release after errors', async (t) => {
  const directory = temporary(t);
  const held = withPrLock(directory, PR, async () => {
    await assert.rejects(withPrLock(directory, PR, () => assert.fail('overlapping writer')), /state locked/);
    assert.equal(await withPrLock(directory, `${REPO}#2`, () => 2), 2);
    throw new Error('injected failure');
  });
  await assert.rejects(held, /injected failure/);
  await withPrLock(directory, PR, () => writePr(directory, PR, { classification: '没事' }));
  assert.equal(readPr(directory, PR).halted, false);
});
