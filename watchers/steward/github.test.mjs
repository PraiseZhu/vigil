import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGithubClient } from './bin/github.mjs';
import { runSteward } from './bin/steward.mjs';
import { pull, REPO, USER } from './fixtures/pulls.mjs';

const ok = (value) => ({ status: 0, stdout: JSON.stringify(value) });

test('read contract: GitHub REST and GraphQL responses reach scan without writes', async () => {
  const replies = [
    [[{ number: 1, state: 'open', draft: false, user: USER }]],
    [{ total_count: 1, incomplete_results: false, items: [
      { id: 1, number: 1, state: 'open', draft: false, user: USER, repository_url: `https://api.github.com/repos/${REPO}` },
    ] }],
    { data: { repository: { pullRequest: pull(1) } } },
    [[]],
  ];
  const client = createGithubClient({ mode: 'gh' }, {
    env: {},
    run: (binary, args, options) => {
      assert.equal(binary, 'gh');
      assert.equal(options.env.GH_PROMPT_DISABLED, '1');
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(args[3], 'github.com');
      if (args[1] === 'graphql') {
        const body = JSON.parse(options.input);
        assert.match(body.query, /^query\(/);
        assert.deepEqual(body.variables, { owner: 'example-org', repo: 'example-repo', number: 1 });
      } else {
        assert.equal(args[5], 'GET');
        assert.deepEqual(args.slice(6), ['--paginate', '--slurp']);
      }
      return ok(replies.shift());
    },
  });
  const result = await runSteward({ command: 'scan', client, profile: {
    authors: ['ExampleUser'], repos: [REPO], excludeRepos: [], discoverByAuthor: true, policies: {},
  } });
  assert.deepEqual(result.discoveryErrors, []);
  assert.equal(result.unknown, 0);
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].classification, '没事');
  assert.deepEqual(client.calls, ['listOpenPulls', 'searchOpenPulls', 'getPull', 'listBranchRules']);
  assert.deepEqual(replies, []);
});

test('GitHub errors and truncated search are observable without leaking raw diagnostics', async () => {
  const results = [
    ok([{ total_count: 1001, incomplete_results: false, items: [] }]),
    { status: 1, stderr: 'secret diagnostics (HTTP 429)' },
    ok({ data: { repository: { pullRequest: pull(1) } }, errors: [{ message: 'private details' }] }),
  ];
  const client = createGithubClient({ mode: 'gh' }, { run: () => results.shift(), env: {} });
  await assert.rejects(client.searchOpenPulls('app/example-qa'), { message: 'searchOpenPulls: incomplete search' });
  await assert.rejects(client.getPull(REPO, 1), { message: 'getPull: GitHub request failed (HTTP 429)' });
  await assert.rejects(client.getPull(REPO, 1), { message: 'getPull: GitHub GraphQL response incomplete' });
});

test('installation auth signs a short-lived JWT and reuses its token without changing local login', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-app-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privateKeyFile = path.join(directory, 'app.pem');
  fs.writeFileSync(privateKeyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const env = { GH_TOKEN: 'local-fixture' };
  const client = createGithubClient({ mode: 'app', appId: 1, installationId: 2, privateKeyFile }, {
    env,
    fetchFn: async (url, options) => {
      assert.equal(url, 'https://api.github.com/app/installations/2/access_tokens');
      assert.equal(options.method, 'POST');
      const [header, claims, signature] = options.headers.Authorization.slice(7).split('.');
      assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
      const payload = JSON.parse(Buffer.from(claims, 'base64url'));
      assert.equal(payload.iss, 1);
      assert.ok(payload.exp - payload.iat < 600);
      assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), true);
      return { ok: true, json: async () => ({ token: 'installation-fixture', expires_at: new Date(Date.now() + 3_600_000).toISOString() }) };
    },
    run: (binary, args, options) => {
      assert.equal(options.env.GH_TOKEN, 'installation-fixture');
      return ok([[]]);
    },
  });
  await client.listOpenPulls(REPO);
  await client.listBranchRules(REPO, 'main');
  assert.equal(env.GH_TOKEN, 'local-fixture');
  assert.deepEqual(client.calls, ['listOpenPulls', 'authenticateApp', 'listBranchRules']);
});
