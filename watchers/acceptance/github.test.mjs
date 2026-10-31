import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGithub, defaultRun, WRITE_TYPES, WriteBusyError, WriteRejectedError } from './bin/github.mjs';
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

test('SC15 除 github.mjs 和 localgit.mjs（#46，只跑本地 git/gitleaks）外 bin 下没有 spawn/execFile/child_process', () => {
  const bin = path.join(path.dirname(new URL(import.meta.url).pathname), 'bin');
  for (const name of fs.readdirSync(bin)) {
    if (!name.endsWith('.mjs')) continue;
    if (name === 'github.mjs' || name === 'localgit.mjs') continue;
    const src = fs.readFileSync(path.join(bin, name), 'utf8');
    assert.doesNotMatch(src, /child_process|require\(/, `${name} 引用 child_process 或 require`);
    assert.doesNotMatch(src, /spawn\(/);
    assert.doesNotMatch(src, /execFile/);
  }
});

test('安全 branch.push 的 bundlePath 必须是绝对路径，不会被 git 当成选项', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const run = createFakeRun();
  const github = createGithub({ profile, run });
  for (const bundlePath of ['--upload-pack=touch /tmp/x', 'relative/x.bundle', '', undefined]) {
    await assert.rejects(
      github.write({ type: 'branch.push', dedupeKey: 'k', repo: REPO, branch: 'acceptance/1-2-sc3', bundlePath }),
      /bundlePath/,
    );
  }
  for (const branch of ['-x', 'a..b', 'bad branch']) {
    await assert.rejects(
      github.write({ type: 'branch.push', dedupeKey: 'k', repo: REPO, branch, bundlePath: path.join(home, 'x.bundle') }),
      /分支名/,
    );
  }
  assert.equal(run.calls.length, 0, '参数不合法时不应调 git');
});

function boardLookup(fields) {
  return {
    user: {
      projectV2: {
        id: 'PROJ',
        fields: { nodes: fields },
      },
    },
    repository: {
      issue: {
        id: 'ISSUE',
        projectItems: { nodes: [{ id: 'ITEM1', isArchived: false, project: { id: 'PROJ' } }] },
      },
    },
  };
}

const PRIO_FIELD = {
  id: 'F_PRIO',
  name: '优先级',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'O_P0', name: 'P0' },
    { id: 'O_P1', name: 'P1' },
    { id: 'O_P2', name: 'P2' },
    { id: 'O_P3', name: 'P3' },
  ],
};
const LINK_FIELD = { id: 'F_LINK', name: '关联 PR', dataType: 'TEXT' };

test('#157 SC2 写闸白名单只有「优先级」「关联 PR」，写其它字段被拒', async () => {
  const { PRIO_BOARD_FIELDS } = await import('./bin/github.mjs');
  assert.ok(PRIO_BOARD_FIELDS, '缺少优先级写回白名单');
  assert.equal(PRIO_BOARD_FIELDS.size, 2);
  assert.equal(PRIO_BOARD_FIELDS.has('优先级'), true);
  assert.equal(PRIO_BOARD_FIELDS.has('关联 PR'), true);

  const profile = loadHome();
  const rejected = createFakeRun({
    onGraphql: () => {
      throw new Error('白名单应在发请求前拒绝');
    },
  });
  const blocked = createGithub({ profile, run: rejected });
  await assert.rejects(
    () =>
      blocked.write({
        type: 'project.field.set',
        dedupeKey: 'reject-status',
        repo: REPO,
        issue: 1,
        ownerLogin: 'ExampleUser',
        projectNumber: 7,
        fields: { 状态: 'Done' },
      }),
    /拒绝写入看板字段「状态」/,
  );
  await assert.rejects(
    () =>
      blocked.write({
        type: 'project.field.set',
        dedupeKey: 'reject-mixed',
        repo: REPO,
        issue: 1,
        ownerLogin: 'ExampleUser',
        projectNumber: 7,
        fields: { 验收: '通过', 优先级: 'P0' },
      }),
    /拒绝写入看板字段/,
  );
  assert.equal(rejected.calls.length, 0, '被拒的字段不能发到 GitHub');

  const mutations = [];
  const run = createFakeRun({
    onGraphql: (payload) => {
      const query = String(payload.query);
      if (query.includes('mutation')) {
        mutations.push({ query, variables: payload.variables });
        if (query.includes('clearProjectV2ItemFieldValue')) {
          return { clearProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM1' } } };
        }
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM1' } } };
      }
      return boardLookup([PRIO_FIELD, LINK_FIELD]);
    },
  });
  const github = createGithub({ profile, run });
  await github.write({
    type: 'project.field.set',
    dedupeKey: 'set-prio',
    repo: REPO,
    issue: 1,
    ownerLogin: 'ExampleUser',
    projectNumber: 7,
    fields: { 优先级: 'P0' },
  });
  await github.write({
    type: 'project.field.set',
    dedupeKey: 'set-link',
    repo: REPO,
    issue: 1,
    ownerLogin: 'ExampleUser',
    projectNumber: 7,
    fields: { '关联 PR': '#3(open,CI✓)' },
  });
  await github.write({
    type: 'project.field.set',
    dedupeKey: 'clear-prio',
    repo: REPO,
    issue: 1,
    ownerLogin: 'ExampleUser',
    projectNumber: 7,
    fields: { 优先级: null },
  });

  const update = mutations.find((entry) => entry.variables?.optionId === 'O_P0');
  assert.ok(update, '优先级要写成单选 P0');
  assert.equal(update.variables.fieldId, 'F_PRIO');
  const link = mutations.find((entry) => entry.variables?.text === '#3(open,CI✓)');
  assert.ok(link, '关联 PR 要写成文本');
  assert.equal(link.variables.fieldId, 'F_LINK');
  const cleared = mutations.find((entry) => entry.query.includes('clearProjectV2ItemFieldValue'));
  assert.ok(cleared, '清空优先级走 clear，不写一个空选项');
  assert.equal(cleared.variables.fieldId, 'F_PRIO');
  assert.equal(mutations.some((entry) => entry.variables?.fieldId === 'F_KIND'), false);
});

test('#157 关联 PR 只接受文本，数字和日期拒绝；优先级没有对应选项也拒绝', async () => {
  const profile = loadHome();
  const writes = [];
  const run = createFakeRun({
    onGraphql: (payload) => {
      const query = String(payload.query);
      if (query.includes('mutation')) {
        writes.push(query);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM1' } } };
      }
      const asked = payload.variables?.text !== undefined ? 'TEXT' : null;
      return boardLookup([
        PRIO_FIELD,
        { id: 'F_NUM', name: '关联 PR', dataType: 'NUMBER' },
        { id: 'F_DATE', name: '关联 PR', dataType: 'DATE' },
      ].filter((field) => asked !== 'split'));
    },
  });
  const github = createGithub({ profile, run });
  const base = {
    type: 'project.field.set',
    repo: REPO,
    issue: 1,
    ownerLogin: 'ExampleUser',
    projectNumber: 7,
  };
  await assert.rejects(
    () => github.write({ ...base, dedupeKey: 'link-number', fields: { '关联 PR': '#1(open)' } }),
    /「关联 PR」字段必须是文本/,
  );
  const dateRun = createFakeRun({
    onGraphql: (payload) => {
      if (String(payload.query).includes('mutation')) {
        writes.push(payload.query);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM1' } } };
      }
      return boardLookup([{ id: 'F_DATE', name: '关联 PR', dataType: 'DATE' }]);
    },
  });
  await assert.rejects(
    () => createGithub({ profile, run: dateRun }).write({
      ...base,
      dedupeKey: 'link-date',
      fields: { '关联 PR': '#2(merged)' },
    }),
    /「关联 PR」字段必须是文本/,
  );
  const missing = createFakeRun({
    onGraphql: (payload) => {
      if (String(payload.query).includes('mutation')) {
        writes.push(payload.query);
        return { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'ITEM1' } } };
      }
      return boardLookup([PRIO_FIELD]);
    },
  });
  await assert.rejects(
    () => createGithub({ profile, run: missing }).write({
      ...base,
      dedupeKey: 'prio-missing',
      fields: { 优先级: 'P9' },
    }),
    /优先级字段没有选项「P9」/,
  );
  assert.equal(writes.length, 0, '类型不对或选项不存在时不能发写入');
});

test('默认执行器按 UTF-8 流式解码：大输出里跨块的多字节字符不变乱码（#43 正文版本每拍误判「变了」）', async () => {
  // 20 万个「。」（每个 3 字节，约 600 KiB）必然跨过管道块边界；逐块 `+=` 会在边界处拼出 U+FFFD。
  const script = "process.stdout.write('。'.repeat(200000))";
  const result = await defaultRun(process.execPath, ['-e', script], { env: process.env });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes('\uFFFD'), false);
  assert.equal(result.stdout, '。'.repeat(200000));
});
