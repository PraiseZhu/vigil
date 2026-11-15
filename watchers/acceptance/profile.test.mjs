import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  loadAcceptanceProfile,
  ProfileError,
  checkSecretFile,
  forkTargetFor,
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

test('profile slackBotTokenFile 权限不对 / 读不到 / 不存在都不让 profile 加载失败（只记路径，不读不查）', () => {
  // #61 复审：Slack 令牌文件坏了只跳过通知（slack-notify 在心跳里写原因），不能让整台验收机停。
  const cases = {
    mode644: (file) => fs.chmodSync(file, 0o644),
    mode000: (file) => fs.chmodSync(file, 0o000),
    missing: (file) => fs.rmSync(file),
    directory: (file) => {
      fs.rmSync(file);
      fs.mkdirSync(file);
    },
  };
  for (const [name, spoil] of Object.entries(cases)) {
    const home = tmpDir();
    const raw = baseProfile(home);
    raw.slackBotTokenFile = path.join(home, 'secrets', 'slack.token');
    writeSecret(raw.slackBotTokenFile, 'slack-token');
    spoil(raw.slackBotTokenFile);
    writeJson(path.join(home, 'config', 'profile.json'), raw);
    const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
    assert.equal(profile.slackBotTokenFile, raw.slackBotTokenFile, name);
  }
  // 路径本身仍然要是绝对路径。
  const home = tmpDir();
  const raw = baseProfile(home);
  raw.slackBotTokenFile = 'secrets/slack.token';
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), /slackBotTokenFile/);
  // GitHub 令牌文件照旧：644 直接拒绝（#47 的逻辑不变）。
  const gh = tmpDir();
  const ghRaw = baseProfile(gh);
  fs.chmodSync(ghRaw.githubTokenFile, 0o644);
  writeJson(path.join(gh, 'config', 'profile.json'), ghRaw);
  assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: gh }), /githubTokenFile/);
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

test('#61 profile 可选 slackChannelId / slackMentionUserId：合法值原样带出，没配就是 undefined', () => {
  const home = tmpDir();
  const raw = baseProfile(home);
  raw.slackChannelId = 'C0123456789';
  raw.slackMentionUserId = 'U0123456789';
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  assert.equal(profile.slackChannelId, 'C0123456789');
  assert.equal(profile.slackMentionUserId, 'U0123456789');

  const plain = tmpDir();
  writeJson(path.join(plain, 'config', 'profile.json'), baseProfile(plain));
  const empty = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: plain });
  assert.equal(empty.slackChannelId, undefined);
  assert.equal(empty.slackMentionUserId, undefined);
});

test('#61 profile 的 Slack id 只做格式校验：形状不对就报错并点名键', () => {
  for (const [key, value] of [
    ['slackChannelId', 'not-a-channel'],
    ['slackChannelId', 'general'],
    ['slackMentionUserId', 'u0123456789'],
    ['slackMentionUserId', '@example'],
  ]) {
    const home = tmpDir();
    const raw = baseProfile(home);
    raw[key] = value;
    writeJson(path.join(home, 'config', 'profile.json'), raw);
    assert.throws(
      () => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }),
      (error) => {
        assert.equal(error.code, 'PROFILE_INVALID');
        assert.match(error.message, new RegExp(key));
        return true;
      },
      `${key}=${value}`,
    );
  }
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

test('forkTargets：上游仓对应自己名下的 fork（名字可以不同），没写的照旧用同名仓', () => {
  const home = tmpDir();
  const raw = {
    ...baseProfile(home),
    forkRepos: ['makecindy/cindy', 'example-org/other'],
    forkTargets: { 'makecindy/cindy': `${OWNER}/cindy-fork` },
  };
  writeJson(path.join(home, 'config', 'profile.json'), raw);
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  assert.equal(forkTargetFor(profile, 'makecindy/cindy'), `${OWNER}/cindy-fork`);
  assert.equal(forkTargetFor(profile, 'MakeCindy/Cindy'), `${OWNER}/cindy-fork`, '仓名不分大小写');
  assert.equal(forkTargetFor(profile, 'example-org/other'), `${OWNER}/other`);

  const plain = { ...baseProfile(tmpDir()) };
  const plainHome = path.dirname(path.dirname(plain.githubTokenFile));
  writeJson(path.join(plainHome, 'config', 'profile.json'), plain);
  const loaded = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: plainHome });
  assert.deepEqual({ ...loaded.forkTargets }, {});
  assert.equal(forkTargetFor(loaded, 'makecindy/cindy'), `${OWNER}/cindy`);
});

test('forkTargets：键不在 forkRepos、fork 不在 ownerLogin 名下、写通配符、不是对象，都直接报错', () => {
  const cases = [
    [{ 'example-org/not-listed': `${OWNER}/x` }, /不在 forkRepos 里/],
    [{ 'makecindy/cindy': 'StrangerUser/cindy-fork' }, /必须在 ExampleUser 名下/],
    [{ 'makecindy/*': `${OWNER}/x` }, /具体的 owner\/repo/],
    [{ 'makecindy/cindy': `${OWNER}/*` }, /具体的 owner\/repo/],
    [['makecindy/cindy'], /对象/],
  ];
  for (const [forkTargets, pattern] of cases) {
    const home = tmpDir();
    writeJson(path.join(home, 'config', 'profile.json'), { ...baseProfile(home), forkRepos: ['makecindy/cindy'], forkTargets });
    assert.throws(() => loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }), (err) => {
      assert.ok(err instanceof ProfileError);
      assert.match(err.message, /forkTargets/);
      assert.match(err.message, pattern);
      return true;
    }, JSON.stringify(forkTargets));
  }
});
