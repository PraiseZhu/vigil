import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGithubClient } from './bin/github.mjs';
import { loadProfile } from './bin/profile.mjs';
import { runSteward } from './bin/steward.mjs';
import { actionsCheck, reviewed } from './fixtures/chores/cases.mjs';
import { pull, REPO, REVIEWER, USER } from './fixtures/pulls.mjs';

const USER_REPO = 'ExampleUser/example-project';
const GH_REPO = 'another-org/example-project';
const ok = (value) => ({ status: 0, stdout: JSON.stringify(value) });

function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-app-routing-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'profile.json');
  const repos = [USER_REPO, REPO, GH_REPO];
  const settings = {
    authors: [USER.login], repos, stateDir: 'state', discoverByAuthor: true,
    policies: Object.fromEntries(repos.map((repo) => [repo, {
      trustedReviewers: [REVIEWER.login],
      severityPatterns: { P3: ['P3'] },
      infraPatterns: ['runner lost'],
      chores: { resolveReverified: true, reverifiedPatterns: ['^Fixed and verified'], rerunInfra: true },
    }])),
  };
  return (github) => {
    fs.writeFileSync(file, JSON.stringify({ ...settings, github }));
    return loadProfile({ file });
  };
}

test('SC1–2: one tick routes reads and App chores by owner; unmatched repos stay read-only', async (t) => {
  const load = setup(t);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const profile = load({ mode: 'by-owner', installations: {
    exampleuser: { appId: 11, installationId: 101, privateKeyFile: 'user.pem' },
    'Example-Org': { appId: 22, installationId: 202, privateKeyFile: 'org.pem' },
  } });
  for (const filename of ['user.pem', 'org.pem']) {
    fs.writeFileSync(path.join(path.dirname(profile.stateDir), filename), pem, { mode: 0o600 });
  }
  const tokens = new Map([[USER_REPO, 'fixture-101'], [REPO, 'fixture-202'], [GH_REPO, 'fixture-local']]);
  const jobs = new Map(profile.repos.map((repo, index) => [repo, index + 10]));
  const exchanges = [];
  const reads = [];
  const writes = [];
  const logs = [];
  const env = { GH_TOKEN: 'fixture-local' };
  const client = createGithubClient(profile.github, {
    env,
    fetchFn: async (url, options) => {
      const id = new URL(url).pathname.split('/')[3];
      const claims = options.headers.Authorization.split('.')[1];
      exchanges.push([id, JSON.parse(Buffer.from(claims, 'base64url')).iss]);
      return { ok: true, json: async () => ({ token: `fixture-${id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() }) };
    },
    run: (binary, [, endpoint], options) => {
      assert.equal(binary, 'gh');
      const token = options.env.GH_TOKEN;
      if (endpoint === 'graphql') {
        const { query, variables } = JSON.parse(options.input);
        if (query.startsWith('mutation')) {
          writes.push([variables.id, token]);
          return ok({ data: { resolveReviewThread: { thread: { isResolved: true } } } });
        }
        const repo = `${variables.owner}/${variables.repo}`;
        reads.push([repo, token]);
        const thread = reviewed('P3 suggestion', 'Fixed and verified');
        thread.id = `example-thread-${jobs.get(repo)}`;
        const check = actionsCheck('test', 'FAILURE', jobs.get(repo), { summary: 'runner lost' });
        check.detailsUrl = `https://github.com/${repo}/actions/runs/10/job/${jobs.get(repo)}`;
        return ok({ data: { repository: { pullRequest: pull(1, { threads: [thread], checks: [check] }) } } });
      }
      if (endpoint.startsWith('search/issues?')) {
        assert.equal(token, env.GH_TOKEN);
        return ok([{ total_count: 0, incomplete_results: false, items: [] }]);
      }
      const [, owner, name, resource] = endpoint.split('/');
      const repo = `${owner}/${name}`;
      assert.equal(token, tokens.get(repo));
      if (resource === 'actions') {
        writes.push([endpoint, token]);
        return { status: 0, stdout: '' };
      }
      return resource.startsWith('pulls?') ? ok([[{ number: 1, state: 'open', draft: false, user: USER }]]) : ok([[]]);
    },
  });

  const result = await runSteward({ command: 'tick', profile, client, log: (line) => logs.push(line) });

  assert.deepEqual(result.discoveryErrors, []);
  assert.equal(result.unknown, 0);
  assert.deepEqual(result.prs.map(({ repo }) => repo).sort(), [...profile.repos].sort());
  assert.equal(reads.length, 7);
  for (const [repo, token] of reads) assert.equal(token, tokens.get(repo));
  assert.deepEqual(exchanges.toSorted(), [['101', 11], ['202', 22]]);
  assert.deepEqual(writes.toSorted(), [
    ['example-thread-10', 'fixture-101'],
    ['example-thread-11', 'fixture-202'],
    [`repos/${USER_REPO}/actions/jobs/10/rerun`, 'fixture-101'],
    [`repos/${REPO}/actions/jobs/11/rerun`, 'fixture-202'],
  ].toSorted());
  assert.deepEqual(logs.filter((line) => line.includes('杂活跳过')), [
    `${GH_REPO}：杂活跳过，未配置适用的 GitHub App 安装`,
  ]);
  assert.equal(env.GH_TOKEN, 'fixture-local');
  await assert.rejects(client.resolveThread('example-thread-12'), /no GitHub App installation/);
  await assert.rejects(client.rerunJob(GH_REPO, 12), /no GitHub App installation/);
});

test('invalid owner settings fail closed, and legacy GitHub profiles still load', (t) => {
  const load = setup(t);
  const legacy = { mode: 'app', appId: 11, installationId: '101', privateKeyFile: 'user.pem' };
  assert.deepEqual(load().github, { mode: 'gh' });
  assert.deepEqual(load({ mode: 'gh' }).github, { mode: 'gh' });
  const profile = load(legacy);
  assert.deepEqual(profile.github, { ...legacy, privateKeyFile: path.join(path.dirname(profile.stateDir), 'user.pem') });
  assert.throws(() => load({ mode: 'by-owner' }), /github\.installations/);
  assert.throws(() => load({ mode: 'by-owner', installations: { [REPO]: legacy } }), /账号或组织登录名/);
  assert.throws(() => load({ mode: 'by-owner', installations: { ExampleUser: {} } }), /ExampleUser\.appId/);
  assert.throws(() => load({ mode: 'by-owner', installations: { ExampleUser: legacy, exampleuser: legacy } }), /重复/);
});

test('a configured App authentication failure never falls back to gh', async () => {
  const client = createGithubClient({ mode: 'by-owner', installations: {
    'example-org': { mode: 'app', appId: 22, installationId: 202, privateKeyFile: '' },
  } }, { run: () => assert.fail('gh must not run after App authentication fails') });
  await assert.rejects(client.getPull(REPO, 1), /installation authentication failed/);
});
