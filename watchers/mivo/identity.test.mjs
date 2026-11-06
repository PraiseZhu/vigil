import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_LOGIN, DEFAULT_USER_ID, configuredLogin, configuredUserId, isOwnLogin } from './bin/mivo-identity.mjs';
import { _resetProfileCacheForTests } from './bin/profile.mjs';
import { ensureCommitIdentity } from './bin/mivo-repair.mjs';
import { runHandoff } from './bin/mivo-handoff.mjs';

function profileHome(t, profile) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-identity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'profile.json'), JSON.stringify(profile));
  return home;
}

// The helper processes (mivo-repair, mivo-handoff) do not inherit the schedule command's environment, so the
// identity has to be readable from profile.json as well.
function withProfileEnv(t, home) {
  // The helper processes run without the schedule command's VIGIL_GH_* variables; the test environment file does
  // set them for other tests, so drop them here to model a helper process and restore them afterwards.
  const saved = { home: process.env.MIVO_WATCHER_HOME, login: process.env.VIGIL_GH_LOGIN, id: process.env.VIGIL_GH_USER_ID };
  process.env.MIVO_WATCHER_HOME = home;
  delete process.env.VIGIL_GH_LOGIN;
  delete process.env.VIGIL_GH_USER_ID;
  _resetProfileCacheForTests();
  t.after(() => {
    for (const [key, value] of [
      ['MIVO_WATCHER_HOME', saved.home], ['VIGIL_GH_LOGIN', saved.login], ['VIGIL_GH_USER_ID', saved.id],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetProfileCacheForTests();
  });
}

test('the watcher identity is named explicitly, defaulting to the built-in account', () => {
  assert.equal(configuredLogin({}), DEFAULT_LOGIN);
  assert.equal(configuredLogin({ VIGIL_GH_LOGIN: '  ' }), DEFAULT_LOGIN);
  assert.equal(configuredLogin({ VIGIL_GH_LOGIN: 'SomeoneElse' }), 'SomeoneElse');
  assert.equal(configuredUserId({}), DEFAULT_USER_ID);
  assert.equal(configuredUserId({ VIGIL_GH_LOGIN: 'SomeoneElse' }), null);
  assert.equal(configuredUserId({ VIGIL_GH_LOGIN: 'SomeoneElse', VIGIL_GH_USER_ID: '7' }), 7);
});

test('profile.json supplies the identity when the environment does not', (t) => {
  const home = profileHome(t, { ghLogin: 'ExampleUser', ghUserId: 123456 });
  const env = { MIVO_WATCHER_HOME: home };
  assert.equal(configuredLogin(env), 'ExampleUser');
  assert.equal(configuredUserId(env), 123456);
  // The environment still wins, and a blank environment value falls through to the profile, not to the default.
  assert.equal(configuredLogin({ ...env, VIGIL_GH_LOGIN: 'OtherUser' }), 'OtherUser');
  assert.equal(configuredUserId({ ...env, VIGIL_GH_LOGIN: 'OtherUser', VIGIL_GH_USER_ID: '7' }), 7);
  assert.equal(configuredLogin({ ...env, VIGIL_GH_LOGIN: '  ' }), 'ExampleUser');
  assert.equal(isOwnLogin('ExampleUser', env), true);
});

test('a profile account without an id has no commit email, and blank or string values are handled', (t) => {
  const login = { MIVO_WATCHER_HOME: profileHome(t, { ghLogin: 'ExampleUser' }) };
  assert.equal(configuredLogin(login), 'ExampleUser');
  assert.equal(configuredUserId(login), null, 'a custom account never inherits the built-in default id');
  const withId = { MIVO_WATCHER_HOME: profileHome(t, { ghLogin: 'ExampleUser', ghUserId: '123456' }) };
  assert.equal(configuredUserId(withId), 123456, 'a numeric string id is accepted');
  assert.equal(configuredUserId({ ...withId, VIGIL_GH_USER_ID: '  ' }), 123456, 'a blank environment id falls through to the profile');
  const blank = { MIVO_WATCHER_HOME: profileHome(t, { ghLogin: '  ' }) };
  assert.equal(configuredLogin(blank), DEFAULT_LOGIN, 'a blank profile login falls back to the default');
  assert.equal(configuredUserId(blank), DEFAULT_USER_ID);
});

test('a malformed profile.json fails loudly instead of falling back to the default account', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-identity-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'profile.json'), '{not json');
  assert.throws(() => configuredLogin({ MIVO_WATCHER_HOME: home }), /不是合法 JSON/);
  assert.throws(() => configuredUserId({ MIVO_WATCHER_HOME: home }), /不是合法 JSON/);
});

test('the repair commit identity uses the profile account by default', (t) => {
  const home = profileHome(t, { ghLogin: 'ExampleUser', ghUserId: 123456 });
  withProfileEnv(t, home);
  const calls = [];
  const gitFn = (_bin, args) => { calls.push(args.join(' ')); return ''; };
  const result = ensureCommitIdentity({ worktree: '/tmp/mivo-identity-wt', gitFn });
  assert.deepEqual(result, { configured: true });
  assert.ok(calls.some((line) => line.includes('user.name ExampleUser')), calls.join('\n'));
  assert.ok(calls.some((line) => line.includes('user.email 123456+ExampleUser@users.noreply.github.com')), calls.join('\n'));
});

test('mivo-handoff uses the profile account as its default login', (t) => {
  const home = profileHome(t, { ghLogin: 'ExampleUser', ghUserId: 123456 });
  withProfileEnv(t, home);
  const repo = 'example-org/example-plugin';
  const readyAt = '2026-09-02T00:00:00Z';
  const basic = {
    id: 'PR_1', number: 1, title: 't', repo, state: 'OPEN', isDraft: false,
    headRefOid: 'a'.repeat(40), headRefName: 'feature', baseRefOid: 'b'.repeat(40), baseRefName: 'main',
    createdAt: '2026-09-01T00:00:00Z', author: { login: 'ExampleUser' }, isCrossRepository: false,
    mergeable: 'MERGEABLE', reviewDecision: null, releaseEpoch: `ready:PR_1:READY_1:${readyAt}`,
  };
  const ghFn = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(basic);
    if (args[1] === 'graphql') return JSON.stringify({ data: { node: { timelineItems: {
      nodes: [{ __typename: 'ReadyForReviewEvent', id: 'READY_1', createdAt: readyAt }],
      pageInfo: { hasNextPage: false, endCursor: null } } } } });
    if (args[1].startsWith('repos/')) return JSON.stringify([[]]);
    throw new Error(`unexpected gh args: ${JSON.stringify(args)}`);
  };
  const result = runHandoff({ command: 'inspect', repo, number: 1, ghFn });
  assert.equal(result.status, 'ready-unclaimed');
  assert.equal(result.authorAuthorized, true, 'the default login must be the profile account, not the built-in default');
});

test('our own logins are the configured account and praise-qa[bot]', () => {
  assert.equal(isOwnLogin(DEFAULT_LOGIN, {}), true);
  assert.equal(isOwnLogin(DEFAULT_LOGIN.toLowerCase(), {}), true);
  assert.equal(isOwnLogin('praise-qa[bot]', {}), true);
  assert.equal(isOwnLogin('OtherUser', {}), false);
  assert.equal(isOwnLogin('', {}), false);
});
