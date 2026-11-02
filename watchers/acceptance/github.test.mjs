import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGithub, defaultRun, isReadOnlyGraphql, WRITE_TYPES, WriteBusyError, WriteRejectedError } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { setAcceptanceFields } from './bin/board.mjs';
import { BOARD_ITEMS_QUERY, PR_SEARCH_QUERY } from './bin/prio-sync.mjs';
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

const WRITER_TOKEN = `writer-${'x'.repeat(12)}`;

function boardProject(extraFields = []) {
  return {
    id: 'PROJ',
    fields: { nodes: [PRIO_FIELD, LINK_FIELD, ...extraFields] },
  };
}

function legacyBoard({ onBoard = true, archived = false, itemId = 'ITEM1' } = {}) {
  return {
    user: { projectV2: boardProject() },
    repository: {
      issue: {
        id: 'ISSUE',
        projectItems: {
          nodes: onBoard ? [{ id: itemId, isArchived: archived, project: { id: 'PROJ' } }] : [],
        },
      },
    },
  };
}

function directBoard({ itemId, archived = false, projectId = 'PROJ', node = 'item' } = {}) {
  const payload = { user: { projectV2: boardProject() } };
  if (node === 'missing') payload.node = null;
  else if (node === 'other') payload.node = {};
  else payload.node = { id: itemId, isArchived: archived, project: { id: projectId } };
  return payload;
}

function mutationData(query, variables) {
  if (query.includes('addProjectV2ItemById')) {
    return { addProjectV2ItemById: { item: { id: 'ITEM_ADDED' } } };
  }
  if (query.includes('unarchiveProjectV2Item')) {
    return { unarchiveProjectV2Item: { item: { id: variables.itemId } } };
  }
  if (query.includes('clearProjectV2ItemFieldValue')) {
    return { clearProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
  }
  return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
}

function priorityWriter(profile, shape) {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const query = String(body.query);
    requests.push({ query, variables: body.variables });
    const data = query.includes('mutation')
      ? mutationData(query, body.variables)
      : (query.includes('repository') ? legacyBoard(shape) : directBoard(shape));
    return { ok: true, status: 200, text: async () => JSON.stringify({ data }) };
  };
  const github = createGithub({
    profile,
    ownerToken: WRITER_TOKEN,
    fetchImpl,
    run: async () => {
      throw new Error('写令牌路径不应调用 gh');
    },
  });
  return { github, requests };
}

function prioAction(extra = {}) {
  return {
    type: 'project.field.set',
    repo: REPO,
    issue: 1,
    ownerLogin: 'ExampleUser',
    projectNumber: 7,
    fields: { 优先级: 'P0' },
    ...extra,
  };
}

function writeMutations(requests) {
  return requests.filter((entry) => entry.query.includes('mutation'));
}

test('#210 SC1 带条目 id 时没有任何请求文本含 repository', async () => {
  const profile = loadHome();
  const { github, requests } = priorityWriter(profile, { itemId: 'PVTI_ok' });
  await github.write(prioAction({ itemId: 'PVTI_ok' }));
  assert.ok(requests.length >= 2);
  for (const entry of requests) {
    assert.equal(entry.query.includes('repository'), false);
  }
  const mutations = writeMutations(requests);
  assert.equal(mutations.length, 1);
  assert.match(mutations[0].query, /updateProjectV2ItemFieldValue/);
  assert.equal(mutations[0].variables.itemId, 'PVTI_ok');
  assert.equal(mutations[0].variables.projectId, 'PROJ');
  assert.equal(mutations[0].variables.fieldId, 'F_PRIO');
  assert.equal(mutations[0].variables.optionId, 'O_P0');
  assert.equal(requests.some((entry) => entry.query.includes('addProjectV2ItemById')), false);
  assert.equal(requests.some((entry) => entry.query.includes('unarchiveProjectV2Item')), false);
  const lookup = requests.find((entry) => !entry.query.includes('mutation'));
  assert.match(lookup.query, /projectV2/);
  assert.match(lookup.query, /node\(id:/);

  const link = priorityWriter(profile, { itemId: 'PVTI_link' });
  await link.github.write(prioAction({ itemId: 'PVTI_link', fields: { '关联 PR': '#3(open)' } }));
  for (const entry of link.requests) {
    assert.equal(entry.query.includes('repository'), false);
  }
  const linkWrite = writeMutations(link.requests);
  assert.equal(linkWrite.length, 1);
  assert.equal(linkWrite[0].variables.text, '#3(open)');
  assert.equal(linkWrite[0].variables.itemId, 'PVTI_link');
});

test('#210 SC2 没带条目 id 时请求序列与现有路径一致', async () => {
  const profile = loadHome();
  const baseVars = {
    login: 'ExampleUser',
    projectNumber: 7,
    owner: 'example-owner',
    name: 'example-repo',
    issue: 1,
  };

  const onBoard = priorityWriter(profile, { onBoard: true, archived: false, itemId: 'ITEM1' });
  await onBoard.github.write(prioAction());
  assert.equal(onBoard.requests.length, 2);
  assert.match(onBoard.requests[0].query, /repository\(owner: \$owner, name: \$name\)/);
  assert.match(onBoard.requests[0].query, /projectItems\(first: 20, includeArchived: true\)/);
  assert.deepEqual(onBoard.requests[0].variables, baseVars);
  assert.match(onBoard.requests[1].query, /updateProjectV2ItemFieldValue/);
  assert.deepEqual(onBoard.requests[1].variables, {
    projectId: 'PROJ',
    itemId: 'ITEM1',
    fieldId: 'F_PRIO',
    optionId: 'O_P0',
  });
  assert.equal(onBoard.requests.some((entry) => entry.query.includes('addProjectV2ItemById')), false);
  assert.equal(onBoard.requests.some((entry) => entry.query.includes('unarchiveProjectV2Item')), false);

  const missing = priorityWriter(profile, { onBoard: false });
  await missing.github.write(prioAction());
  assert.equal(missing.requests.length, 3);
  assert.match(missing.requests[0].query, /repository\(owner: \$owner, name: \$name\)/);
  assert.deepEqual(missing.requests[0].variables, baseVars);
  assert.match(missing.requests[1].query, /addProjectV2ItemById/);
  assert.deepEqual(missing.requests[1].variables, { projectId: 'PROJ', contentId: 'ISSUE' });
  assert.match(missing.requests[2].query, /updateProjectV2ItemFieldValue/);
  assert.equal(missing.requests[2].variables.itemId, 'ITEM_ADDED');
  assert.equal(missing.requests.some((entry) => entry.query.includes('unarchiveProjectV2Item')), false);

  const archived = priorityWriter(profile, { onBoard: true, archived: true, itemId: 'ITEM1' });
  await archived.github.write(prioAction());
  assert.equal(archived.requests.length, 3);
  assert.match(archived.requests[0].query, /repository\(owner: \$owner, name: \$name\)/);
  assert.deepEqual(archived.requests[0].variables, baseVars);
  assert.match(archived.requests[1].query, /unarchiveProjectV2Item/);
  assert.deepEqual(archived.requests[1].variables, { projectId: 'PROJ', itemId: 'ITEM1' });
  assert.match(archived.requests[2].query, /updateProjectV2ItemFieldValue/);
  assert.equal(archived.requests[2].variables.itemId, 'ITEM1');
  assert.equal(archived.requests.some((entry) => entry.query.includes('addProjectV2ItemById')), false);
});

test('#210 SC3 条目 id 为空、类型不对或不属于本看板时拒绝且不发写请求', async () => {
  const profile = loadHome();
  const cases = [
    { itemId: '', message: /条目 id 为空/ },
    { itemId: 41, message: /条目 id 类型不对/ },
    { itemId: { id: 'PVTI_obj' }, message: /条目 id 类型不对/ },
  ];
  for (const entry of cases) {
    const { github, requests } = priorityWriter(profile, { itemId: 'PVTI_ok' });
    await assert.rejects(() => github.write(prioAction({ itemId: entry.itemId })), entry.message);
    assert.equal(requests.length, 0, `itemId=${JSON.stringify(entry.itemId)} 不应发请求`);
    assert.equal(writeMutations(requests).length, 0);
  }

  const wrongBoard = priorityWriter(profile, { itemId: 'PVTI_other', projectId: 'OTHER_PROJ' });
  await assert.rejects(
    () => wrongBoard.github.write(prioAction({ itemId: 'PVTI_other' })),
    /条目不属于本看板/,
  );
  assert.equal(writeMutations(wrongBoard.requests).length, 0);
  assert.equal(wrongBoard.requests.some((entry) => entry.query.includes('repository')), false);

  const missing = priorityWriter(profile, { node: 'missing' });
  await assert.rejects(
    () => missing.github.write(prioAction({ itemId: 'PVTI_gone' })),
    /条目不属于本看板/,
  );
  assert.equal(writeMutations(missing.requests).length, 0);

  const otherType = priorityWriter(profile, { node: 'other' });
  await assert.rejects(
    () => otherType.github.write(prioAction({ itemId: 'PVTI_user' })),
    /条目不属于本看板/,
  );
  assert.equal(writeMutations(otherType.requests).length, 0);
});

test('#210 SC4 带条目 id 时仍只允许优先级和关联 PR', async () => {
  const profile = loadHome();
  const fields = [
    { 验收: '通过' },
    { 裁决: '记下' },
  ];
  for (const entry of fields) {
    const { github, requests } = priorityWriter(profile, { itemId: 'PVTI_ok' });
    const name = Object.keys(entry)[0];
    await assert.rejects(
      () => github.write(prioAction({ itemId: 'PVTI_ok', fields: entry })),
      new RegExp(`拒绝写入看板字段「${name}」`),
    );
    assert.equal(requests.length, 0);
    assert.equal(writeMutations(requests).length, 0);
  }
  const mixed = priorityWriter(profile, { itemId: 'PVTI_ok' });
  await assert.rejects(
    () => mixed.github.write(prioAction({ itemId: 'PVTI_ok', fields: { 优先级: 'P0', 验收: '通过' } })),
    /拒绝写入看板字段/,
  );
  assert.equal(mixed.requests.length, 0);
});

test('#210 SC5 已归档条目退回现有路径，不新增取消归档', async () => {
  const profile = loadHome();
  const plain = priorityWriter(profile, { onBoard: true, archived: true, itemId: 'ITEM1' });
  await plain.github.write(prioAction({ fields: { 优先级: 'P1' } }));
  assert.deepEqual(
    plain.requests.map((entry) => entry.query.includes('repository') ? 'lookup' : entry.query.includes('unarchive') ? 'unarchive' : 'update'),
    ['lookup', 'unarchive', 'update'],
  );

  const withId = priorityWriter(profile, {
    onBoard: true,
    archived: true,
    itemId: 'ITEM1',
    directArchived: true,
  });
  await withId.github.write(prioAction({ itemId: 'PVTI_arch', fields: { 优先级: 'P1' } }));
  assert.equal(withId.requests[0].query.includes('repository'), false);
  assert.match(withId.requests[0].query, /node\(id:/);
  assert.deepEqual(withId.requests.slice(1), plain.requests);
  const unarchives = withId.requests.filter((entry) => entry.query.includes('unarchiveProjectV2Item'));
  assert.equal(unarchives.length, 1);
  assert.equal(
    unarchives[0].query,
    plain.requests.find((entry) => entry.query.includes('unarchiveProjectV2Item')).query,
  );
});

test('默认执行器按 UTF-8 流式解码：大输出里跨块的多字节字符不变乱码（#43 正文版本每拍误判「变了」）', async () => {
  // 20 万个「。」（每个 3 字节，约 600 KiB）必然跨过管道块边界；逐块 `+=` 会在边界处拼出 U+FFFD。
  const script = "process.stdout.write('。'.repeat(200000))";
  const result = await defaultRun(process.execPath, ['-e', script], { env: process.env });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.includes('\uFFFD'), false);
  assert.equal(result.stdout, '。'.repeat(200000));
});

test('#204 SC1 两种绕过不是只读查询', () => {
  const bypasses = [
    'query { a(s:"#") } mutation { y }',
    'query{x} # c\rmutation{y}',
  ];
  for (const query of bypasses) {
    assert.equal(isReadOnlyGraphql(query), false, query);
  }
});

test('#204 SC2 四种误拦写法是只读查询', () => {
  const allowed = [
    'query { search(query:"mutation label:bug") { issueCount } }',
    'query { x { mutationCount } }',
    'query($subscriptionId: ID!) { node(id:$subscriptionId) { id } }',
    'fragment F on Issue { id } query { node(id:"1") { ...F } }',
  ];
  for (const query of allowed) {
    assert.equal(isReadOnlyGraphql(query), true, query);
  }
});

test('#204 SC3 其它非只读边界被拒', () => {
  const rejected = [
    'mutation{y}',
    'subscription{y}',
    'query{a} query{b}',
    '{a} mutation{b}',
    'query{a} #c\r\nmutation{b}',
    'query { a(s:"unterminated) }',
    'query { a { b }',
  ];
  for (const query of rejected) {
    assert.equal(isReadOnlyGraphql(query), false, query);
  }
});

test('#204 SC4 BOARD_ITEMS_QUERY 与 PR_SEARCH_QUERY 是只读查询', () => {
  assert.equal(isReadOnlyGraphql(BOARD_ITEMS_QUERY), true);
  assert.equal(isReadOnlyGraphql(PR_SEARCH_QUERY), true);
});

test('#204 块字符串里的 mutation、右花括号和井号不算关键字或注释', () => {
  assert.equal(isReadOnlyGraphql('query { f(s: """\nmutation }\n""") { id } }'), true);
  assert.equal(isReadOnlyGraphql('query { f(s: """#""") { id } }'), true);
  assert.equal(isReadOnlyGraphql('query { f(s: """#""") { id } } mutation { y }'), false);
});
