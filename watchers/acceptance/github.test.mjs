import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGithub, WRITE_TYPES, WriteBusyError, WriteRejectedError } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { setAcceptanceFields } from './bin/board.mjs';
import { REPO, createFakeRun, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';

function loadHome(extra = {}) {
  const { home } = writeProfile(tmpDir(), extra);
  return loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
}

test('SC15 未知写操作类型抛错', async () => {
  const profile = loadHome();
  const github = createGithub({ profile, run: createFakeRun() });
  await assert.rejects(() => github.write({ type: 'secret.leak' }), /未知写操作类型/);
});

test('SC15 WRITE_TYPES 正好 11 种', () => {
  assert.equal(WRITE_TYPES.length, 11);
  assert.ok(WRITE_TYPES.includes('comment.create'));
  assert.ok(WRITE_TYPES.includes('pr.ready'));
});

test('SC15 配了 writeCommand 时动作带 dedupeKey 交给它，退出码 0 读 stdout', async () => {
  const home = tmpDir();
  const gate = path.join(home, 'gate.mjs');
  const log = path.join(home, 'actions.jsonl');
  fs.writeFileSync(
    gate,
    `#!/usr/bin/env node
import fs from 'node:fs';
const input = await new Promise((resolve) => {
  let s = '';
  process.stdin.on('data', (c) => (s += c));
  process.stdin.on('end', () => resolve(s));
});
fs.appendFileSync(${JSON.stringify(log)}, input + '\\n');
process.stdout.write(JSON.stringify({ commentId: 9, url: 'https://example.test/c/9' }));
`,
  );
  fs.chmodSync(gate, 0o700);
  const { home: watcherHome } = writeProfile(home, { profile: { writeCommand: [process.execPath, gate] } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: watcherHome });
  const sleeps = [];
  const github = createGithub({
    profile,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await github.write({ type: 'comment.create', repo: REPO, issue: 1, body: 'hi' });
  assert.equal(result.commentId, 9);
  const recorded = JSON.parse(fs.readFileSync(log, 'utf8').trim());
  assert.equal(recorded.type, 'comment.create');
  assert.ok(recorded.dedupeKey);
  assert.equal(sleeps.length, 0);
});

test('SC15 writeCommand 子进程环境不含令牌', async () => {
  const profile = loadHome({ profile: { writeCommand: [process.execPath, '-e', 'process.stdout.write("{}")'] } });
  const captured = [];
  const run = createFakeRun({
    onOther: (_cmd, _args, { env }) => {
      captured.push(env);
      return { code: 0, stdout: JSON.stringify({ ok: true }), stderr: '' };
    },
  });
  const github = createGithub({ profile, run });
  await github.write({ type: 'issue.close', repo: REPO, issue: 1, dedupeKey: 'c' });
  assert.equal(captured[0].GH_TOKEN, undefined);
  assert.equal(captured[0].GITHUB_TOKEN, undefined);
});

test('SC15 writeCommand 退出码 4 抛外发被拒且不重试', async () => {
  const home = tmpDir();
  const gate = path.join(home, 'gate.mjs');
  const countFile = path.join(home, 'count');
  fs.writeFileSync(
    gate,
    `#!/usr/bin/env node
import fs from 'node:fs';
const n = Number(fs.existsSync(${JSON.stringify(countFile)}) ? fs.readFileSync(${JSON.stringify(countFile)}, 'utf8') : '0') + 1;
fs.writeFileSync(${JSON.stringify(countFile)}, String(n));
process.stdout.write(JSON.stringify({ reason: 'denied' }));
process.exit(4);
`,
  );
  fs.chmodSync(gate, 0o700);
  const { home: watcherHome } = writeProfile(home, { profile: { writeCommand: [process.execPath, gate] } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: watcherHome });
  const sleeps = [];
  const github = createGithub({
    profile,
    sleep: async (ms) => sleeps.push(ms),
  });
  await assert.rejects(
    () => github.write({ type: 'comment.create', repo: REPO, issue: 1, body: 'x', dedupeKey: 'k1' }),
    (err) => {
      assert.equal(err.name, 'WriteRejectedError');
      assert.equal(err.code, 'WRITE_GATE_REJECTED');
      assert.match(err.message, /外发被拒/);
      assert.equal(err.exitCode, 4);
      assert.equal(err.reason, 'denied');
      return true;
    },
  );
  assert.equal(fs.readFileSync(countFile, 'utf8'), '1');
  assert.equal(sleeps.length, 0);
});

test('SC15 writeCommand 退出码 75 每 30 秒重试最多 6 次，dedupeKey 不变', async () => {
  const home = tmpDir();
  const gate = path.join(home, 'gate.mjs');
  const log = path.join(home, 'keys');
  fs.writeFileSync(
    gate,
    `#!/usr/bin/env node
import fs from 'node:fs';
let s = '';
for await (const c of process.stdin) s += c;
const action = JSON.parse(s);
fs.appendFileSync(${JSON.stringify(log)}, action.dedupeKey + '\\n');
process.exit(75);
`,
  );
  fs.chmodSync(gate, 0o700);
  const { home: watcherHome } = writeProfile(home, { profile: { writeCommand: [process.execPath, gate] } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: watcherHome });
  const sleeps = [];
  const github = createGithub({
    profile,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(
    () => github.write({ type: 'issue.edit', repo: REPO, issue: 1, body: 'x', dedupeKey: 'same-key' }),
    (err) => {
      assert.equal(err.name, 'WriteBusyError');
      assert.equal(err.code, 'WRITE_GATE_BUSY');
      assert.match(err.message, /外发忙/);
      return true;
    },
  );
  const keys = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(keys.length, 7);
  assert.ok(keys.every((k) => k === 'same-key'));
  assert.equal(sleeps.length, 6);
  assert.ok(sleeps.every((ms) => ms === 30000));
});

test('SC15 writeCommand 忙过后再成功，中途不改成直接写', async () => {
  const home = tmpDir();
  const gate = path.join(home, 'gate.mjs');
  const seq = path.join(home, 'seq');
  fs.writeFileSync(seq, '0');
  fs.writeFileSync(
    gate,
    `#!/usr/bin/env node
import fs from 'node:fs';
const n = Number(fs.readFileSync(${JSON.stringify(seq)}, 'utf8')) + 1;
fs.writeFileSync(${JSON.stringify(seq)}, String(n));
if (n < 3) process.exit(75);
process.stdout.write(JSON.stringify({ ok: true, n }));
`,
  );
  fs.chmodSync(gate, 0o700);
  const { home: watcherHome } = writeProfile(home, { profile: { writeCommand: [process.execPath, gate] } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: watcherHome });
  const github = createGithub({ profile, sleep: async () => {} });
  const result = await github.write({ type: 'pr.ready', repo: REPO, pr: 3, dedupeKey: 'ready' });
  assert.equal(result.ok, true);
  assert.equal(result.n, 3);
});

test('SC15 没配 writeCommand 时直接走 gh，comment.create 用账号令牌', async () => {
  const profile = loadHome();
  const run = createFakeRun({
    onApi: () => ({ id: 77, html_url: 'https://github.com/example-owner/example-repo/issues/1#issuecomment-77' }),
  });
  const github = createGithub({ profile, run });
  const result = await github.write({ type: 'comment.create', repo: REPO, issue: 1, body: 'hi' });
  assert.equal(result.commentId, 77);
  assert.equal(run.calls[0].ghToken, 'owner-token');
  assert.ok(run.calls[0].args.includes(`repos/${REPO}/issues/1/comments`));
});

test('SC12 配了 appConfigPath 时读走 App 令牌、写走账号令牌', async () => {
  const home = tmpDir();
  const pem = path.join(home, 'secrets', 'app.pem');
  // 仅用于本地单测的一次性 RSA 私钥，不会提交真实密钥。
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeSecret(pem, privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const appConfig = path.join(home, 'app.json');
  fs.writeFileSync(appConfig, JSON.stringify({ appId: '1', installationId: '2', privateKeyFile: pem }));
  const { home: watcherHome } = writeProfile(home, { profile: { appConfigPath: appConfig } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: watcherHome });
  const tokens = [];
  const run = createFakeRun({
    onGraphql: () => ({ ping: true }),
    onApi: () => ({ id: 1, html_url: 'https://example.test/c/1' }),
  });
  const github = createGithub({
    profile,
    run,
    fetchImpl: async () => ({ ok: true, json: async () => ({ token: 'app-install-token' }) }),
  });
  await github.graphql('query { viewer { login } }', {});
  await github.write({ type: 'comment.create', repo: REPO, issue: 1, body: 'w' });
  const readCall = run.calls.find((c) => c.args.includes('graphql'));
  const writeCall = run.calls.find((c) => c.args.includes('POST'));
  assert.equal(readCall.ghToken, 'app-install-token');
  assert.equal(writeCall.ghToken, 'owner-token');
  void tokens;
});

test('SC10 看板写入只动验收和裁决，条目不在就加入、归档就放回', async () => {
  const profile = loadHome();
  const mutations = [];
  const run = createFakeRun({
    onGraphql: (payload) => {
      const q = String(payload.query);
      if (q.includes('addProjectV2ItemById')) {
        mutations.push('add');
        return { addProjectV2ItemById: { item: { id: 'ITEM_NEW' } } };
      }
      if (q.includes('unarchiveProjectV2Item')) {
        mutations.push('unarchive');
        return { unarchiveProjectV2Item: { item: { id: 'ITEM_OLD' } } };
      }
      if (q.includes('updateProjectV2ItemFieldValue')) {
        mutations.push({ field: payload.variables.fieldId, option: payload.variables.optionId, text: payload.variables.text });
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM' } } };
      }
      return {
        user: {
          projectV2: {
            id: 'PROJ',
            fields: {
              nodes: [
                { id: 'F_KIND', name: 'Kind', dataType: 'SINGLE_SELECT', options: [{ id: 'K1', name: 'Task' }] },
                { id: 'F_ACC', name: '验收', dataType: 'SINGLE_SELECT', options: [{ id: 'A1', name: '验收中' }, { id: 'A2', name: '通过' }] },
                { id: 'F_VER', name: '裁决', dataType: 'TEXT' },
              ],
            },
          },
        },
        repository: {
          issue: {
            id: 'ISSUE',
            projectItems: { nodes: [{ id: 'ITEM_OLD', isArchived: true, project: { id: 'PROJ' } }] },
          },
        },
      };
    },
  });
  const github = createGithub({ profile, run });
  await setAcceptanceFields(github, profile, {
    repo: REPO,
    issue: 1,
    acceptance: '验收中',
    verdictUrl: 'https://example.test/c/1',
    round: 1,
    ref: `${REPO}#1`,
  });
  assert.ok(mutations.includes('unarchive'));
  const fieldIds = mutations.filter((m) => m && m.field).map((m) => m.field);
  assert.deepEqual(fieldIds.sort(), ['F_ACC', 'F_VER']);
  assert.ok(!fieldIds.includes('F_KIND'));
  const writeTypes = run.calls.filter((c) => c.args.includes('graphql') && JSON.parse(c.input || '{}').query?.includes('mutation'));
  for (const call of writeTypes) {
    assert.match(call.input, /验收|裁决|unarchiveProjectV2Item|updateProjectV2ItemFieldValue|addProjectV2ItemById/);
    assert.doesNotMatch(call.input, /F_KIND|Kind/);
  }
});

test('SC10 条目不在看板上则 addProjectV2ItemById', async () => {
  const profile = loadHome();
  const mutations = [];
  const run = createFakeRun({
    onGraphql: (payload) => {
      const q = String(payload.query);
      if (q.includes('addProjectV2ItemById')) {
        mutations.push('add');
        return { addProjectV2ItemById: { item: { id: 'ITEM_NEW' } } };
      }
      if (q.includes('updateProjectV2ItemFieldValue')) {
        mutations.push('update');
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM_NEW' } } };
      }
      return {
        user: {
          projectV2: {
            id: 'PROJ',
            fields: { nodes: [{ id: 'F_ACC', name: '验收', dataType: 'SINGLE_SELECT', options: [{ id: 'A1', name: '通过' }] }] },
          },
        },
        repository: { issue: { id: 'ISSUE', projectItems: { nodes: [] } } },
      };
    },
  });
  const github = createGithub({ profile, run });
  await setAcceptanceFields(github, profile, { repo: REPO, issue: 4, acceptance: '通过' });
  assert.ok(mutations.includes('add'));
  assert.ok(mutations.includes('update'));
});

test('SC15 除 github.mjs 外 bin 下没有 spawn/execFile/child_process', () => {
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), 'bin');
  for (const name of fs.readdirSync(bin)) {
    if (!name.endsWith('.mjs')) continue;
    if (name === 'github.mjs') continue;
    const src = fs.readFileSync(path.join(bin, name), 'utf8');
    assert.doesNotMatch(src, /node:child_process/);
    assert.doesNotMatch(src, /spawn\(/);
    assert.doesNotMatch(src, /execFile/);
  }
});
