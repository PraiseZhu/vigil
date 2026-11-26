import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DEPLOY = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/script/fake-gh.sh', import.meta.url));
const REPO = 'example-org/example-repo';

function setup(t, { login, followerLogin = 'ExampleUser', stateIsFile = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-steward-deploy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fakeGh = path.join(directory, 'gh');
  fs.copyFileSync(FIXTURE, fakeGh);
  fs.chmodSync(fakeGh, 0o700);
  const profile = path.join(directory, "example operator's profile.json");
  const state = path.join(directory, 'state');
  if (stateIsFile) fs.writeFileSync(state, '');
  fs.writeFileSync(profile, JSON.stringify({
    authors: ['ExampleUser'], repos: [REPO], stateDir: 'state',
    policies: { [REPO]: { chores: { followerLogin } } },
  }));
  const env = {
    HOME: directory, PATH: [directory, process.env.PATH].join(path.delimiter), STEWARD_PROFILE: profile,
    ...(login ? { FIXTURE_GH_LOGIN: login } : {}),
  };
  return {
    profile, state,
    run: (flag) => spawnSync(process.execPath, [DEPLOY, flag], {
      cwd: directory, env, encoding: 'utf8', timeout: 10000,
    }),
  };
}

test('SC6: gh login unavailable fails with the missing check', (t) => {
  const result = setup(t).run('--check');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /gh 未登录/);
});

test('SC6: different gh account and unwritable state both appear', (t) => {
  const result = setup(t, { login: 'OtherUser', stateIsFile: true }).run('--check');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /chores\.followerLogin 与当前 gh 登录账号不一致/);
  assert.match(result.stderr, /stateDir 不可写/);
});

test('SC6: followerLogin must be a login string', (t) => {
  const result = setup(t, { login: 'ExampleUser', followerLogin: true }).run('--check');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /chores\.followerLogin/);
});

test('SC6: valid account and writable state pass without leaving a probe', (t) => {
  const { run, state } = setup(t, { login: 'exampleuser' });
  const result = run('--check');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(state), []);
});

test('SC7: prints a bound script schedule and no extra capability', (t) => {
  const { run, profile, state } = setup(t);
  const result = run('--print-schedule');
  assert.equal(result.status, 0, result.stderr);
  const schedule = JSON.parse(result.stdout);
  assert.equal(schedule.executionMode, 'script');
  assert.equal(schedule.intervalMs, 180000);
  assert.equal(schedule.targetSessionId, '<PR 总管伙伴主对话 ID>');
  assert.ok(schedule.scriptConfig.timeoutMs > 0 && schedule.scriptConfig.timeoutMs < schedule.intervalMs);
  assert.deepEqual(schedule.scriptConfig.capabilities, ['sessions.dispatch']);
  const command = spawnSync('sh', ['-c', schedule.scriptConfig.command.split(' python3 ')[0] + '; printf "%s" "$STEWARD_PROFILE"'],
    { encoding: 'utf8', timeout: 5000 });
  assert.equal(command.stdout, profile);
  assert.equal(fs.existsSync(state), false);
});
