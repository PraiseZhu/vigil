import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  loadAcceptanceProfile,
  ProfileError,
  checkSecretFile,
  tokenFiles,
} from './bin/profile.mjs';
import { OWNER, tmpDir, writeSecret } from './fake-gh.fixture.mjs';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function baseProfile(home) {
  const token = writeSecret(path.join(home, 'secrets', 'github.token'));
  return {
    ownerLogin: OWNER,
    projectNumber: 1,
    stateDir: path.join(home, 'state'),
    worktreeDir: path.join(home, 'work'),
    startAt: '2026-01-01T00:00:00.000Z',
    githubTokenFile: token,
  };
}

test('SC13 缺 ownerLogin 直接报错并点名键', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  delete raw.ownerLogin;
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(
    () => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }),
    (err) => {
      assert.equal(err.code, 'PROFILE_INVALID');
      assert.match(err.message, /ownerLogin/);
      assert.match(err.message, new RegExp(path.join(home, 'config', 'profile.json')));
      return true;
    },
  );
});

test('SC13 缺 projectNumber 直接报错', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  delete raw.projectNumber;
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /projectNumber/);
});

test('SC13 缺 stateDir 直接报错', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  delete raw.stateDir;
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /stateDir/);
});

test('SC13 缺 worktreeDir 直接报错', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  delete raw.worktreeDir;
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /worktreeDir/);
});

test('SC13 缺 startAt 直接报错', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  delete raw.startAt;
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /startAt/);
});

test('SC13 缺 githubTokenFile 直接报错', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  delete raw.githubTokenFile;
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /githubTokenFile/);
});

test('SC13 相对路径的 stateDir 报错，不回落默认路径', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  raw.stateDir = 'relative/state';
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /stateDir/);
});

test('profile token-file 权限 644 被拒绝', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  fs.chmodSync(raw.githubTokenFile, 0o644);
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(
    () => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }),
    (err) => {
      assert.equal(err.code, 'PROFILE_INVALID');
      assert.match(err.message, /githubTokenFile/);
      assert.match(err.message, /权限/);
      assert.doesNotMatch(err.message, /test-token-not-real|owner-token/);
      return true;
    },
  );
});

test('profile token-file 权限 600 被接受', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  assert.equal(profile.ownerLogin, OWNER);
  assert.equal(profile.githubTokenFile, raw.githubTokenFile);
  assert.deepEqual(profile.forkRepos, ['makecindy/cindy']);
  assert.deepEqual(profile.autoRepos, [`${OWNER}/*`]);
  assert.equal(profile.stallMinutes, 30);
});

test('profile slackBotTokenFile 存在时一并校验', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  raw.slackBotTokenFile = path.join(home, 'secrets', 'slack.token');
  writeSecret(raw.slackBotTokenFile, 'slack-token');
  fs.chmodSync(raw.slackBotTokenFile, 0o644);
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(
    () => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }),
    /slackBotTokenFile/,
  );
});

test('profile 令牌从不从环境变量读取', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  delete raw.githubTokenFile;
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  const env = {
    ACCEPTANCE_WATCHER_HOME: home,
    GH_TOKEN: 'from-env-should-not-count',
    GITHUB_TOKEN: 'from-env-should-not-count',
  };
  assert.throws(() => loadAcceptanceProfile(env), /githubTokenFile/);
});

test('profile 错误类型的 autoRepos 不静默回退', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  raw.autoRepos = 'ExampleUser/*';
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /autoRepos/);
});

test('checkSecretFile 空文件被拒绝且不带出内容', () => {
  const home = tmpDir();
  const file = path.join(home, 'empty.token');
  writeSecret(file, '');
  assert.throws(
    () => checkSecretFile(file, 'githubTokenFile'),
    (err) => {
      assert.ok(err instanceof ProfileError);
      assert.match(err.message, /githubTokenFile/);
      assert.match(err.message, /空/);
      return true;
    },
  );
});

test('writeCommand 字符串会被收成单元素 argv', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  raw.writeCommand = path.join(home, 'gate.sh');
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  assert.deepEqual(profile.writeCommand, [raw.writeCommand]);
});

test('profile 缺配置文件时报路径，不回落', () => {
  const home = tmpDir();
  assert.throws(
    () => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }),
    (err) => {
      assert.match(err.message, new RegExp(path.join(home, 'config', 'profile.json')));
      return true;
    },
  );
});

test('profile 令牌文件权限必须正好是 600（400 也拒绝）', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  fs.chmodSync(raw.githubTokenFile, 0o400);
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /githubTokenFile.*600/);
});

test('profile 两个令牌文件键一次定好：只存路径、不读令牌内容', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  raw.slackBotTokenFile = writeSecret(path.join(home, 'secrets', 'slack.token'), 'fake-slack-value');
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  const original = fs.readFileSync;
  const read = [];
  fs.readFileSync = (file, ...rest) => {
    read.push(String(file));
    return original.call(fs, file, ...rest);
  };
  let profile;
  try {
    profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  } finally {
    fs.readFileSync = original;
  }
  assert.equal(profile.githubTokenFile, raw.githubTokenFile);
  assert.equal(profile.slackBotTokenFile, raw.slackBotTokenFile);
  assert.ok(!read.includes(raw.githubTokenFile), 'profile.mjs 不应读 GitHub 令牌内容');
  assert.ok(!read.includes(raw.slackBotTokenFile), 'profile.mjs 不应读 Slack 令牌内容');
  assert.ok(!JSON.stringify(profile).includes('fake-slack-value'));
  assert.deepEqual(
    tokenFiles(profile).map((entry) => entry.key).sort(),
    ['githubTokenFile', 'slackBotTokenFile'],
  );
});

test('profile 没配 slackBotTokenFile 时照常加载（#44 不用 Slack）', () => {
  const home = tmpDir();
  writeJson(path.join(home, 'config', 'profile.json'), baseProfile(home));
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  assert.equal(profile.slackBotTokenFile, undefined);
  assert.deepEqual(tokenFiles(profile).map((entry) => entry.key), ['githubTokenFile']);
});

test('profile tokenFiles 也列出 App 私钥文件（宿主沙箱一并遮罩）', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  const pem = writeSecret(path.join(home, 'secrets', 'app.pem'), 'fake-pem-not-real');
  const appConfig = path.join(home, 'app.json');
  writeJson(appConfig, { appId: '1', installationId: '2', privateKeyFile: pem });
  raw.appConfigPath = appConfig;
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  assert.equal(profile.appPrivateKeyFile, pem);
  assert.deepEqual(
    tokenFiles(profile).map((entry) => entry.key).sort(),
    ['appPrivateKeyFile', 'githubTokenFile'],
  );
  assert.ok(!JSON.stringify(profile).includes('fake-pem-not-real'));
});
