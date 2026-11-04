import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredLogin, configuredUserId, isOwnLogin } from './bin/mivo-identity.mjs';

test('the watcher identity is named explicitly, defaulting to PraiseZhu', () => {
  assert.equal(configuredLogin({}), 'PraiseZhu');
  assert.equal(configuredLogin({ VIGIL_GH_LOGIN: '  ' }), 'PraiseZhu');
  assert.equal(configuredLogin({ VIGIL_GH_LOGIN: 'SomeoneElse' }), 'SomeoneElse');
  assert.equal(configuredUserId({}), 290989140);
  assert.equal(configuredUserId({ VIGIL_GH_LOGIN: 'SomeoneElse' }), null);
  assert.equal(configuredUserId({ VIGIL_GH_LOGIN: 'SomeoneElse', VIGIL_GH_USER_ID: '7' }), 7);
});

test('our own logins are the configured account and praise-qa[bot]', () => {
  assert.equal(isOwnLogin('PraiseZhu', {}), true);
  assert.equal(isOwnLogin('praisezhu', {}), true);
  assert.equal(isOwnLogin('praise-qa[bot]', {}), true);
  assert.equal(isOwnLogin('OtherUser', {}), false);
  assert.equal(isOwnLogin('', {}), false);
});
