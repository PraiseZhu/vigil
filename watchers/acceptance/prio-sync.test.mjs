// #157 prio-sync：默认 dry-run，经 project.field.set 写「优先级」「关联 PR」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DOWNGRADE_MIN_GAP_MS } from './bin/prio-score.mjs';
import { isReadOnlyGraphql } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import {
  assertPrioFields,
  createPriorityGithub,
  loadBoardItems,
  loadPullRequests,
  main,
  parsePrioArgs,
  priorityTokenPath,
  readPriorityWriterToken,
  restorePrio,
  runPrioSync,
} from './bin/prio-sync.mjs';
import { REPO, createFakeRun, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const OWNER = 'ExampleUser';
const PROJECT = 7;

function item(number, extra = {}) {
  return {
    repo: REPO,
    number,
    priority: null,
    linkedPr: '',
    labels: [],
    status: 'Todo',
    acceptance: null,
    ...extra,
  };
}

function capture() {
  let out = '';
  return {
    stdout: { write(chunk) { out += chunk; } },
    text: () => out,
  };
}

function recorder() {
  const writes = [];
  return {
    writes,
    write: async (action) => {
      writes.push(structuredClone(action));
      return { ok: true };
    },
  };
}

function readJsonl(dir) {
  const file = path.join(dir, 'changes.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'debounce.json'), 'utf8'));
}

test('#157 SC1 dry-run 跑 84 条有输出且 0 次写入', async () => {
  const dir = tmpDir();
  const io = capture();
  const gate = recorder();
  const items = Array.from({ length: 84 }, (_, index) => item(index + 1));
  await runPrioSync({
    dir,
    items,
    prs: [],
    nowMs: T0,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.match(io.text(), /dry-run：84 条，变更 84，写入 0，钉住 0/);
  assert.equal(io.text().split('\n').filter((line) => line.includes('优先级')).length, 84);
  assert.match(io.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#1 优先级 （空） → P2`));
  assert.match(io.text(), /低置信记 P2/);
  assert.equal(fs.existsSync(path.join(dir, 'changes.jsonl')), false);
});

test('#157 SC1 默认不写；只有 apply 才把 project.field.set 交给写闸', async () => {
  const dir = tmpDir();
  const gate = recorder();
  const base = {
    dir,
    items: [item(1, { labels: ['blocker'] })],
    prs: [],
    nowMs: T0,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  };
  await runPrioSync(base);
  assert.equal(gate.writes.length, 0);
  await runPrioSync({ ...base, apply: true, stdout: capture().stdout });
  assert.equal(gate.writes.length, 1);
  const action = gate.writes[0];
  assert.equal(action.type, 'project.field.set');
  assert.equal(typeof action.dedupeKey, 'string');
  assert.ok(action.dedupeKey.includes(`${REPO}#1`));
  assert.ok(action.dedupeKey.includes('优先级'));
  assert.equal(action.repo, REPO);
  assert.equal(action.issue, 1);
  assert.equal(action.ownerLogin, OWNER);
  assert.equal(action.projectNumber, PROJECT);
  assert.equal(action.ref, `${REPO}#1`);
  assert.deepEqual(action.fields, { 优先级: 'P0' });
  assert.deepEqual(Object.keys(action.fields), ['优先级']);
});

test('#157 SC2 prio-sync 只提交白名单里的两个字段', () => {
  assert.throws(() => assertPrioFields({ 状态: 'Done' }), /拒绝写入看板字段「状态」/);
  assert.throws(() => assertPrioFields({ 验收: '通过' }), /拒绝写入看板字段「验收」/);
  assert.throws(() => assertPrioFields({}), /拒绝写入看板字段/);
  assert.doesNotThrow(() => assertPrioFields({ 优先级: 'P1' }));
  assert.doesNotThrow(() => assertPrioFields({ '关联 PR': '#1(open)' }));
});

test('#157 SC3 每次变更追加 changes.jsonl，restore 按日志把字段改回', async () => {
  const dir = tmpDir();
  const gate = recorder();
  const io = capture();
  await runPrioSync({
    dir,
    items: [item(1, { labels: ['blocker'] })],
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  const logged = readJsonl(dir);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].at, new Date(T0).toISOString());
  assert.equal(logged[0].item, `${REPO}#1`);
  assert.equal(logged[0].repo, REPO);
  assert.equal(logged[0].issue, 1);
  assert.equal(logged[0].field, '优先级');
  assert.equal(logged[0].old, null);
  assert.equal(logged[0].new, 'P0');

  const preview = capture();
  await restorePrio({
    dir,
    since: new Date(T0).toISOString(),
    nowMs: T0 + 1000,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: preview.stdout,
  });
  assert.equal(gate.writes.length, 1, 'restore 默认也是 dry-run');
  assert.match(preview.text(), /dry-run：还原 1 条，写入 0/);
  assert.match(preview.text(), /优先级 P0 → （空）/);
  assert.equal(readJsonl(dir).length, 1);

  const applyOut = capture();
  await restorePrio({
    dir,
    since: new Date(T0).toISOString(),
    nowMs: T0 + 2000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: applyOut.stdout,
  });
  assert.equal(gate.writes.length, 2);
  assert.equal(gate.writes[1].type, 'project.field.set');
  assert.ok(gate.writes[1].dedupeKey);
  assert.deepEqual(gate.writes[1].fields, { 优先级: null });
  assert.match(applyOut.text(), /写入：还原 1 条，写入 1/);
  const after = readJsonl(dir);
  assert.equal(after.length, 2);
  assert.equal(after[1].field, '优先级');
  assert.equal(after[1].old, 'P0');
  assert.equal(after[1].new, null);
  assert.equal(after[1].at, new Date(T0 + 2000).toISOString());
});

test('#157 SC3 日志里同一字段多次变更时，restore 改回该时间之前的旧值', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'changes.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { at: new Date(T0).toISOString(), item: `${REPO}#4`, repo: REPO, issue: 4, field: '优先级', old: null, new: 'P0' },
    { at: new Date(T0 + 60000).toISOString(), item: `${REPO}#4`, repo: REPO, issue: 4, field: '优先级', old: 'P0', new: 'P1' },
    { at: new Date(T0 + 120000).toISOString(), item: `${REPO}#4`, repo: REPO, issue: 4, field: '关联 PR', old: '', new: '#8(merged)' },
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const gate = recorder();
  await restorePrio({
    dir,
    since: new Date(T0 + 60000).toISOString(),
    nowMs: T0 + 180000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  });
  assert.equal(gate.writes.length, 2);
  const priority = gate.writes.find((action) => Object.hasOwn(action.fields, '优先级'));
  const link = gate.writes.find((action) => Object.hasOwn(action.fields, '关联 PR'));
  assert.equal(priority.fields['优先级'], 'P0');
  assert.equal(link.fields['关联 PR'], null);
  assert.equal(priority.issue, 4);
});

test('#157 SC4 .prio/disabled 存在时 apply 也不写', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'disabled'), '');
  const gate = recorder();
  const io = capture();
  await runPrioSync({
    dir,
    items: [item(1, { labels: ['blocker'] })],
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.match(io.text(), /已停用：1 条，变更 1，写入 0，钉住 0/);
  assert.equal(fs.existsSync(path.join(dir, 'changes.jsonl')), false);

  const logged = path.join(dir, 'changes.jsonl');
  fs.writeFileSync(logged, `${JSON.stringify({
    at: new Date(T0).toISOString(),
    item: `${REPO}#1`,
    repo: REPO,
    issue: 1,
    field: '优先级',
    old: null,
    new: 'P0',
  })}\n`);
  await restorePrio({
    dir,
    since: new Date(T0).toISOString(),
    nowMs: T0 + 1000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.equal(readJsonl(dir).length, 1);
});

test('#157 SC5 令牌只从文件读，不进环境变量、日志和错误信息', async () => {
  const source = fs.readFileSync(fileURLToPath(new URL('./bin/prio-sync.mjs', import.meta.url)), 'utf8');
  assert.match(source, /gh-priority-writer-token/);
  assert.equal(source.includes('process.env'), false);
  assert.equal(source.includes('GH_TOKEN'), false);
  assert.equal(source.includes('GITHUB_TOKEN'), false);
  assert.equal(source.includes('panoptes'), false);
  assert.doesNotMatch(source, /\/Users\/|\/home\//);
  const home = path.join(tmpDir(), 'home');
  const expected = path.join(home, 'acceptance', 'secrets', 'gh-priority-writer-token');
  assert.equal(priorityTokenPath(home), expected);
  assert.equal(fs.existsSync(expected), false);

  const token = 'prio-writer-fixture-value';
  const file = writeSecret(path.join(tmpDir(), 'gh-priority-writer-token'), `${token}\n`);
  assert.equal(readPriorityWriterToken(file), token);
  fs.chmodSync(file, 0o644);
  await assert.rejects(async () => readPriorityWriterToken(file), (error) => {
    assert.equal(String(error.message).includes(token), false);
    assert.match(error.message, /600/);
    return true;
  });

  const { home: watcherHome } = writeProfile(tmpDir());
  const loaded = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: watcherHome });
  const profile = { ...loaded, writeCommand: [process.execPath, '-e', 'process.exit(1)'] };
  const run = createFakeRun();
  const fetches = [];
  const fetchImpl = async (_url, init) => {
    fetches.push(init);
    return { ok: false, status: 401, text: async () => `denied ${token}` };
  };
  const before = { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  const github = createPriorityGithub({ profile, token, run, fetchImpl });
  await assert.rejects(
    () => github.write({
      type: 'project.field.set',
      dedupeKey: 'prio-token',
      repo: REPO,
      issue: 1,
      ownerLogin: OWNER,
      projectNumber: PROJECT,
      fields: { 优先级: 'P0' },
    }),
    (error) => {
      assert.equal(String(error.message).includes(token), false);
      assert.match(error.message, /denied/);
      return true;
    },
  );
  assert.equal(run.calls.length, 0, '优先级令牌不交给 gh，所以不会进子进程环境');
  assert.equal(fetches.length > 0, true);
  assert.equal(fetches[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(JSON.stringify(fetches[0].headers).includes('GH_TOKEN'), false);
  assert.equal(process.env.GH_TOKEN, before.GH_TOKEN);
  assert.equal(process.env.GITHUB_TOKEN, before.GITHUB_TOKEN);
  assert.equal(JSON.stringify(readJsonl(tmpDir())).includes(token), false);
});

test('#157 .prio 不入库', () => {
  const gitignore = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.prio\/$/m);
});

test('#157 带 prio:pin 的项不写优先级，也不写关联 PR', async () => {
  const dir = tmpDir();
  const gate = recorder();
  const io = capture();
  await runPrioSync({
    dir,
    items: [item(3, { labels: ['prio:pin'], priority: 'P3', status: 'Done', linkedPr: '' })],
    prs: [{ repo: REPO, number: 9, title: 'fix #3', state: 'open', ci: 'fail', headRefName: 'fix' }],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.match(io.text(), /钉住 1/);
  assert.equal(readState(dir).items[`${REPO}#3`], undefined);
});

test('#157 Done 或验收通过但 issue 开着不清空；关闭后才清空', async () => {
  const open = {
    situationTier: 'P1',
    repoClass: 'mivo',
    issueState: 'open',
  };
  const dir = tmpDir();
  seedOwned(dir, 1, 'P1');
  seedOwned(dir, 2, 'P1');
  const gate = recorder();
  const items = [
    item(1, { priority: 'P1', status: 'Done', acceptance: '通过', ...open }),
    item(2, { priority: 'P1', status: 'In Progress', acceptance: '通过', ...open }),
  ];
  const base = {
    dir,
    items,
    prs: [],
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
  };
  await runPrioSync({ ...base, nowMs: T0, apply: true, stdout: capture().stdout });
  await runPrioSync({ ...base, nowMs: T0 + DOWNGRADE_MIN_GAP_MS, apply: true, stdout: capture().stdout });
  assert.equal(gate.writes.length, 0, 'issue 还开着，Done 和验收通过都不清空');

  seedOwned(dir, 3, 'P1');
  const closed = [item(3, { priority: 'P1', status: 'Done', acceptance: '通过', situationTier: 'P1', repoClass: 'mivo', issueState: 'closed' })];
  await runPrioSync({ ...base, items: closed, nowMs: T0, apply: true, stdout: capture().stdout });
  assert.equal(gate.writes.length, 0, '清空是降级，第一次只记防抖');
  await runPrioSync({
    ...base,
    items: closed,
    nowMs: T0 + DOWNGRADE_MIN_GAP_MS,
    apply: true,
    stdout: capture().stdout,
  });
  assert.equal(gate.writes.length, 1);
  assert.equal(gate.writes[0].issue, 3);
  assert.equal(gate.writes[0].fields['优先级'], null);
});

test('#157 降级先落盘防抖，未满 15 分钟不写；真写之后看板上的新值不再写', async () => {
  const dir = tmpDir();
  seedOwned(dir, 6, 'P0');
  const gate = recorder();
  const slow = item(6, { priority: 'P0', status: 'Todo' });
  const base = {
    dir,
    items: [slow],
    prs: [],
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  };
  await runPrioSync({ ...base, nowMs: T0 });
  assert.equal(gate.writes.length, 0);
  assert.equal(readState(dir).items[`${REPO}#6`].pending, 'P2');
  await runPrioSync({ ...base, nowMs: T0 + DOWNGRADE_MIN_GAP_MS - 1 });
  assert.equal(gate.writes.length, 0);
  await runPrioSync({ ...base, nowMs: T0 + DOWNGRADE_MIN_GAP_MS });
  assert.equal(gate.writes.length, 1);
  assert.deepEqual(gate.writes[0].fields, { 优先级: 'P2' });
  await runPrioSync({
    ...base,
    nowMs: T0 + DOWNGRADE_MIN_GAP_MS + 1000,
    items: [item(6, { priority: 'P2', status: 'Todo' })],
  });
  assert.equal(gate.writes.length, 1);
});

test('#157 dry-run 不把未写入的升级记成已经写上', async () => {
  const dir = tmpDir();
  const gate = recorder();
  const once = async () => {
    const io = capture();
    await runPrioSync({
      dir,
      items: [item(1, { labels: ['blocker'] })],
      prs: [],
      nowMs: T0,
      ownerLogin: OWNER,
      projectNumber: PROJECT,
      write: gate.write,
      stdout: io.stdout,
    });
    return io.text();
  };
  assert.match(await once(), /→ P0/);
  assert.match(await once(), /→ P0/);
  assert.equal(gate.writes.length, 0);
});

test('#157 关联 PR 用 W3 的文本，CI 失败同时升级优先级', async () => {
  const dir = tmpDir();
  seedOwned(dir, 5, 'P3');
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const gate = recorder();
  await runPrioSync({
    dir,
    items: [item(5, { priority: 'P3', linkedPr: '' })],
    prs: [
      { repo: 'example-owner/other-repo', number: 8, title: 'fix #5', state: 'open', ci: 'fail' },
      { repo: REPO, number: 9, title: 'fix #5', state: 'open', ci: 'fail', headRefName: 'fix' },
    ],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  });
  assert.equal(gate.writes.length, 2);
  assert.deepEqual(gate.writes[0].fields, { 优先级: 'P1' });
  assert.deepEqual(gate.writes[1].fields, { '关联 PR': '#9(open,CI✗)' });
  const linkLog = readJsonl(dir).filter((row) => row.field === '关联 PR').at(-1);
  assert.equal(linkLog.old, '');
  assert.equal(linkLog.new, '#9(open,CI✗)');
  assert.match(linkLog.basis, /^link /);
});

test('#157 没传入 PR 列表时不改关联 PR；传入空列表也不清空已有值', async () => {
  const dir = tmpDir();
  const gate = recorder();
  const base = {
    dir,
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  };
  await runPrioSync({ ...base, items: [item(5, { priority: 'P3', linkedPr: '#4(merged)' })] });
  assert.equal(gate.writes.length, 0);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  await runPrioSync({ ...base, items: [item(5, { priority: 'P3', linkedPr: '#4(merged)' })], prs: [] });
  assert.equal(gate.writes.length, 0);
  assert.equal(readJsonl(dir).some((row) => row.field === '关联 PR'), false);
});

test('#157 每小时已经变更 4 次时再升级只冻结、不写', async () => {
  const dir = tmpDir();
  seedOwned(dir, 1, 'P3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'debounce.json'), JSON.stringify({
    items: {
      [`${REPO}#1`]: {
        priority: 'P3',
        pending: null,
        pendingHeld: false,
        lastRecalcAt: null,
        consecutive: 0,
        changes: [T0 - 4000, T0 - 3000, T0 - 2000, T0 - 1000],
      },
    },
  }));
  const gate = recorder();
  const io = capture();
  await runPrioSync({
    dir,
    items: [item(1, { priority: 'P3', labels: ['blocker'] })],
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.match(io.text(), /冻结/);
  assert.equal(readJsonl(dir).some((row) => row.new === 'P0'), false);
});

test('#157 状态目录默认是 HOME/acceptance/tools/.prio，--state-dir 才能改', async () => {
  const { defaultStateDir, stateFiles } = await import('./bin/prio-sync.mjs');
  const home = path.join(tmpDir(), 'home');
  const expected = path.join(home, 'acceptance', 'tools', '.prio');
  assert.equal(defaultStateDir(home), expected);
  assert.equal(fs.existsSync(expected), false, '算默认路径时不能把目录建出来');
  const files = stateFiles(expected);
  assert.equal(files.disabled, path.join(expected, 'disabled'));
  assert.equal(files.changes, path.join(expected, 'changes.jsonl'));
  assert.equal(files.reminded, path.join(expected, 'reminded.jsonl'));
  assert.equal(files.latency, path.join(expected, 'latency.jsonl'));
  assert.equal(files.marker, path.join(expected, 'mac-mini-stopped'));
  const source = fs.readFileSync(fileURLToPath(new URL('./bin/prio-sync.mjs', import.meta.url)), 'utf8');
  assert.equal(source.includes('/home/box'), false);
  assert.equal(parsePrioArgs(['--state-dir', expected]).stateDir, expected);
  assert.throws(() => parsePrioArgs(['--state-dir']), /--state-dir/);

  const custom = path.join(tmpDir(), 'custom-prio');
  const gate = recorder();
  await main(['--state-dir', custom], {
    now: () => T0,
    stdout: capture().stdout,
    loadProfile: () => ({ ownerLogin: OWNER, projectNumber: PROJECT }),
    loadItems: async () => [item(1, { labels: ['blocker'] })],
    loadPrs: async () => [],
    write: gate.write,
    readToken: () => 'unused-token',
  });
  assert.equal(gate.writes.length, 0);
  assert.equal(fs.existsSync(path.join(custom, 'debounce.json')), true);
  assert.equal(fs.existsSync(expected), false);
});

test('#157 命令默认 dry-run，注入看板时不读令牌', async () => {
  assert.equal(parsePrioArgs([]).write, false);
  assert.equal(parsePrioArgs(['--write']).write, true);
  assert.equal(parsePrioArgs(['--restore', new Date(T0).toISOString()]).restore, new Date(T0).toISOString());
  assert.throws(() => parsePrioArgs(['--restore']), /--restore/);

  const dir = tmpDir();
  const gate = recorder();
  let tokenReads = 0;
  const io = capture();
  await main([], {
    dir,
    now: () => T0,
    stdout: io.stdout,
    loadProfile: () => ({ ownerLogin: OWNER, projectNumber: PROJECT }),
    loadItems: async () => [item(1, { labels: ['blocker'] })],
    loadPrs: async () => [],
    write: gate.write,
    readToken: () => {
      tokenReads += 1;
      return 'unused-token';
    },
  });
  assert.equal(tokenReads, 0);
  assert.equal(gate.writes.length, 0);
  assert.match(io.text(), /dry-run：/);
  assert.match(io.text(), /写入 0/);
});

const DAY_MS = 24 * 60 * 60 * 1000;

function seedOwned(dir, number, priority) {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'changes.jsonl'), `${JSON.stringify({
    at: new Date(T0 - DAY_MS).toISOString(),
    item: `${REPO}#${number}`,
    repo: REPO,
    issue: number,
    field: '优先级',
    old: null,
    new: priority,
    basis: 'seed',
  })}\n`);
}

test('#157 手动优先级：空值或上次是自己写的才覆盖，否则提醒一次', async () => {
  const dir = tmpDir();
  const gate = recorder();
  const manual = item(7, { priority: 'P2', labels: ['blocker'] });
  const first = capture();
  await runPrioSync({
    dir,
    items: [manual],
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: first.stdout,
  });
  assert.equal(gate.writes.length, 0, '看板上的 P2 不是 prio-sync 写的，不能覆盖');
  assert.match(first.text(), /手动值与规则不一致，提醒一次/);
  const reminded = path.join(dir, 'reminded.jsonl');
  const rows = fs.readFileSync(reminded, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].item, `${REPO}#7`);
  assert.equal(rows[0].target, 'P0');
  assert.equal(fs.existsSync(path.join(dir, 'changes.jsonl')), false);

  const second = capture();
  await runPrioSync({
    dir,
    items: [manual],
    prs: [],
    nowMs: T0 + 1000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: second.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.doesNotMatch(second.text(), /手动值与规则不一致/);
  assert.equal(fs.readFileSync(reminded, 'utf8').split('\n').filter(Boolean).length, 1);

  seedOwned(dir, 8, 'P2');
  fs.appendFileSync(path.join(dir, 'changes.jsonl'), `${JSON.stringify({
    at: new Date(T0 - 1000).toISOString(),
    item: `${REPO}#8`,
    repo: REPO,
    issue: 8,
    field: '关联 PR',
    old: '',
    new: '#1(open)',
    basis: 'link',
  })}\n`);
  await runPrioSync({
    dir,
    items: [item(8, { priority: 'P2', labels: ['blocker'] })],
    prs: [],
    nowMs: T0 + 2000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  });
  assert.equal(gate.writes.length, 1);
  assert.deepEqual(gate.writes[0].fields, { 优先级: 'P0' });
  assert.equal(gate.writes[0].issue, 8);
});

test('#157 60 天没动静只提醒一次「还要不要」，不写看板、不关 issue', async () => {
  const { STALE_REMIND_MS } = await import('./bin/prio-sync.mjs');
  const dir = tmpDir();
  const gate = recorder();
  const held = { priority: 'P3', status: 'Todo', situationTier: 'P3', repoClass: 'mivo', issueState: 'open' };
  const items = [
    item(1, { ...held, lastEventAt: T0 - STALE_REMIND_MS - 1 }),
    item(2, { ...held, lastEventAt: T0 - STALE_REMIND_MS }),
    item(3, { ...held }),
  ];
  const first = capture();
  await runPrioSync({
    dir,
    items,
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: first.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.equal(gate.writes.some((action) => action.type === 'issue.close'), false);
  assert.match(first.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#1 还要不要`));
  assert.doesNotMatch(first.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#2 还要不要`));
  assert.doesNotMatch(first.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#3 还要不要`));
  const reminded = fs.readFileSync(path.join(dir, 'reminded.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(reminded.length, 1);
  assert.equal(JSON.parse(reminded[0]).kind, 'stale');
  const second = capture();
  await runPrioSync({
    dir,
    items,
    prs: [],
    nowMs: T0 + DAY_MS,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: second.stdout,
  });
  assert.doesNotMatch(second.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#1 还要不要`));
  assert.match(second.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#2 还要不要`));
  assert.equal(fs.readFileSync(path.join(dir, 'reminded.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
});

test('#157 标记缺失时不写关联 PR 且不调用写闸；标记在且非 dry-run 才写；其它字段永远被拒', async () => {
  const dir = tmpDir();
  seedOwned(dir, 5, 'P3');
  const gate = recorder();
  const prs = [{ repo: REPO, number: 9, title: 'fix #5', state: 'open', ci: 'pass', headRefName: 'fix' }];
  const blocked = capture();
  await runPrioSync({
    dir,
    items: [item(5, { priority: 'P3', linkedPr: '', situationTier: 'P3', repoClass: 'mivo', issueState: 'open' })],
    prs,
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: blocked.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.match(blocked.text(), /#9\(open,CI✓\)/);
  assert.match(blocked.text(), /不写关联 PR/);
  assert.match(blocked.text(), /mac-mini-stopped/);
  assert.equal(fs.existsSync(path.join(dir, 'mac-mini-stopped')), false, '代码不能自己创建确认标记');

  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const allowed = capture();
  await runPrioSync({
    dir,
    items: [item(5, { priority: 'P3', linkedPr: '', situationTier: 'P3', repoClass: 'mivo', issueState: 'open' })],
    prs,
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: allowed.stdout,
  });
  assert.equal(gate.writes.length, 1);
  assert.deepEqual(gate.writes[0].fields, { '关联 PR': '#9(open,CI✓)' });
  assert.equal(gate.writes[0].type, 'project.field.set');

  assert.throws(() => assertPrioFields({ 状态: 'Done' }), /拒绝写入看板字段「状态」/);
  assert.throws(() => assertPrioFields({ Kind: 'Task' }), /拒绝写入看板字段「Kind」/);
});

test('#157 依据写进变更日志和 dry-run，并优先用打分结果里的 basis', async () => {
  const { basisFor, factsForScore } = await import('./bin/prio-sync.mjs');
  const { RULES } = await import('./bin/prio-score.mjs');
  const fallback = RULES.find((rule) => rule.id === 'fallback');
  assert.equal(basisFor({ rule: 'fallback' }), `${fallback.id} ${fallback.when}`);
  assert.equal(basisFor({ rule: 'fallback', basis: '低置信，先记 P2' }), '低置信，先记 P2');
  const facts = factsForScore(item(1, { situationTier: 'P1', repoClass: 'daily', lowConfidence: true, lastEventAt: T0 }), []);
  assert.equal(facts.situationTier, 'P1');
  assert.equal(facts.repoClass, 'daily');
  assert.equal(facts.lowConfidence, true);
  assert.equal(facts.lastEventAt, T0);

  const dry = tmpDir();
  const dryOut = capture();
  await runPrioSync({
    dir: dry,
    items: [item(1, { labels: ['blocker'] })],
    prs: [],
    nowMs: T0,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: recorder().write,
    stdout: dryOut.stdout,
  });
  assert.match(dryOut.text(), /依据：没给情形档，机器信号 S1 升到 P0/);
  const live = tmpDir();
  const gate = recorder();
  await runPrioSync({
    dir: live,
    items: [item(1, { labels: ['blocker'] })],
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  });
  assert.equal(readJsonl(live)[0].basis, '没给情形档，机器信号 S1 升到 P0');
  assert.equal(readJsonl(live)[0].field, '优先级');
});

test('#157 闲置仓情形档 P0 保持 P0', async () => {
  const dir = tmpDir();
  const gate = recorder();
  const io = capture();
  await runPrioSync({
    dir,
    items: [item(1, { situationTier: 'P0', repoClass: 'idle', issueState: 'open' })],
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  assert.equal(gate.writes.length, 1);
  assert.deepEqual(gate.writes[0].fields, { 优先级: 'P0' });
  assert.match(io.text(), /保持 P0/);
  assert.match(readJsonl(dir)[0].basis, /idle/);
});

test('#157 mapItem 填最近事件后，超过 60 天会提醒；缺情形档写明缺信息', async () => {
  const { mapItem, classifyRepo, readRepoClassTable, STALE_REMIND_MS } = await import('./bin/prio-sync.mjs');
  const staleAt = new Date(T0 - STALE_REMIND_MS - 1).toISOString();
  const node = {
    id: 'PVTI_9',
    isArchived: false,
    updatedAt: staleAt,
    content: {
      __typename: 'Issue',
      number: 9,
      state: 'OPEN',
      updatedAt: staleAt,
      repository: { nameWithOwner: REPO },
      labels: { nodes: [] },
    },
    fieldValues: {
      nodes: [
        { name: 'P3', field: { name: '优先级' } },
        { name: 'P3', field: { name: '情形档' } },
        { name: 'Todo', field: { name: 'Status' } },
      ],
    },
  };
  const table = { mivo: [REPO], idle: [], 'daily-tool': [] };
  const mapped = mapItem(node, table);
  assert.equal(mapped.issueState, 'open');
  assert.equal(mapped.situationTier, 'P3');
  assert.equal(mapped.repoClass, 'mivo');
  assert.equal(mapped.repoUnlisted, false);
  assert.equal(mapped.lastEventAt, Date.parse(staleAt));

  const dir = tmpDir();
  const gate = recorder();
  const io = capture();
  await runPrioSync({
    dir,
    items: [mapped],
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  assert.match(io.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#9 还要不要`));
  assert.equal(gate.writes.length, 0);

  const bare = mapItem({
    id: 'PVTI_10',
    isArchived: false,
    content: {
      __typename: 'Issue',
      number: 10,
      state: 'OPEN',
      updatedAt: new Date(T0).toISOString(),
      repository: { nameWithOwner: 'example-owner/unlisted' },
      labels: { nodes: [] },
    },
    fieldValues: { nodes: [{ name: 'Todo', field: { name: 'Status' } }] },
  });
  assert.equal(bare.situationKnown, false);
  assert.equal(bare.repoClass, 'daily-tool');
  assert.equal(bare.repoUnlisted, true);
  const missing = capture();
  await runPrioSync({
    dir: tmpDir(),
    items: [bare],
    prs: [],
    nowMs: T0,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: recorder().write,
    stdout: missing.stdout,
  });
  assert.match(missing.text(), /情形档缺信息/);
  assert.match(missing.text(), /低置信记 P2/);
  assert.match(missing.text(), /不在分类表里/);

  const file = path.join(tmpDir(), 'repo-class.json');
  fs.writeFileSync(file, JSON.stringify({ idle: [REPO] }));
  const loaded = readRepoClassTable(file);
  assert.equal(classifyRepo(REPO, loaded).repoClass, 'idle');
  assert.equal(classifyRepo('example-owner/other', loaded).unlisted, true);
});

test('#157 restore 当前值不是上次写入时跳过，不改手动值', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'changes.jsonl'), `${JSON.stringify({
    at: new Date(T0).toISOString(),
    item: `${REPO}#4`,
    repo: REPO,
    issue: 4,
    field: '优先级',
    old: null,
    new: 'P0',
    basis: 'seed',
  })}\n`);
  const gate = recorder();
  const skipped = capture();
  await restorePrio({
    dir,
    since: new Date(T0).toISOString(),
    nowMs: T0 + 1000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: skipped.stdout,
    items: [item(4, { priority: 'P2' })],
  });
  assert.equal(gate.writes.length, 0);
  assert.match(skipped.text(), /跳过：当前值不是上次写入的值/);
  assert.match(skipped.text(), /当前 P2/);

  const kept = capture();
  await restorePrio({
    dir,
    since: new Date(T0).toISOString(),
    nowMs: T0 + 2000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: kept.stdout,
    items: [item(4, { priority: 'P0' })],
  });
  assert.equal(gate.writes.length, 1);
  assert.deepEqual(gate.writes[0].fields, { 优先级: null });
});

test('#157 看板条目和 PR 映射：归档和非 issue 跳过，查询是只读', async () => {
  const queries = [];
  const issue = {
    id: 'PVTI_1',
    isArchived: false,
    content: {
      __typename: 'Issue',
      number: 12,
      repository: { nameWithOwner: REPO },
      labels: { nodes: [{ name: 'blocker' }] },
    },
    fieldValues: {
      nodes: [
        { name: 'P2', field: { name: '优先级' } },
        { text: '#1(open)', field: { name: '关联 PR' } },
        { name: 'In Progress', field: { name: 'Status' } },
        { name: '验收中', field: { name: '验收' } },
      ],
    },
  };
  const github = {
    async ownerGraphql(query, variables) {
      queries.push({ query, variables });
      assert.equal(isReadOnlyGraphql(query), true);
      if (String(query).includes('projectV2')) {
        if (!variables.after) {
          return {
            user: {
              projectV2: {
                items: {
                  pageInfo: { hasNextPage: true, endCursor: 'CURSOR' },
                  nodes: [issue, { id: 'PVTI_SKIP', isArchived: true, content: { __typename: 'Issue', number: 1, repository: { nameWithOwner: REPO } }, fieldValues: { nodes: [] } }],
                },
              },
            },
          };
        }
        return {
          user: {
            projectV2: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ id: 'PVTI_PR', isArchived: false, content: { __typename: 'PullRequest', number: 3 }, fieldValues: { nodes: [] } }],
              },
            },
          },
        };
      }
      return {
        search: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            number: 9,
            title: 'fix #12',
            body: 'body',
            state: 'OPEN',
            merged: false,
            headRefName: 'fix',
            repository: { nameWithOwner: REPO },
            commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
          }],
        },
      };
    },
  };
  const items = await loadBoardItems(github, { ownerLogin: OWNER, projectNumber: PROJECT });
  assert.equal(items.length, 1);
  assert.equal(items[0].priority, 'P2');
  assert.equal(items[0].status, 'In Progress');
  assert.equal(items[0].acceptance, '验收中');
  assert.equal(items[0].situationKnown, false);
  assert.equal(items[0].issueState, null);
  assert.equal(items[0].lastEventKnown, false);
  assert.equal(items[0].repoClass, 'daily-tool');
  assert.equal(items[0].repoUnlisted, true);
  const prs = await loadPullRequests(github, [REPO]);
  assert.deepEqual(prs, [{
    repo: REPO,
    number: 9,
    title: 'fix #12',
    body: 'body',
    state: 'open',
    merged: false,
    ci: 'fail',
    headRefName: 'fix',
  }]);
  assert.ok(queries.length >= 2);
});

function stableItem(number, extra = {}) {
  return item(number, {
    priority: 'P3',
    status: 'Todo',
    situationTier: 'P3',
    repoClass: 'mivo',
    issueState: 'open',
    ...extra,
  });
}

function seedLink(dir, number, value, old = '') {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'changes.jsonl'), `${JSON.stringify({
    at: new Date(T0 - DAY_MS).toISOString(),
    item: `${REPO}#${number}`,
    repo: REPO,
    issue: number,
    field: '关联 PR',
    old,
    new: value,
    basis: 'link 关联 PR 文本与看板不一致',
  })}\n`);
}

function openPr(number, issueNumber) {
  return {
    repo: REPO,
    number,
    title: `fix #${issueNumber}`,
    state: 'open',
    ci: 'pass',
    headRefName: 'fix',
  };
}

test('#179 SC1 人工「关联 PR」算出为空时，dry-run 和 apply 都不产生变更、不调用 write', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const gate = recorder();
  const manual = stableItem(5, { linkedPr: '#4(merged)' });
  const base = {
    dir,
    items: [manual],
    prs: [],
    nowMs: T0,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
  };
  const dry = capture();
  await runPrioSync({ ...base, stdout: dry.stdout });
  assert.equal(gate.writes.length, 0);
  assert.doesNotMatch(dry.text(), /关联 PR .+→/);
  assert.match(dry.text(), /dry-run：1 条，变更 0，写入 0/);
  assert.match(dry.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#5 关联 PR 手动值与规则不一致，提醒一次`));

  const applied = capture();
  await runPrioSync({ ...base, apply: true, nowMs: T0 + 1000, stdout: applied.stdout });
  assert.equal(gate.writes.length, 0);
  assert.doesNotMatch(applied.text(), /关联 PR .+→/);
  assert.doesNotMatch(applied.text(), /手动值与规则不一致/);
  assert.equal(readJsonl(dir).some((row) => row.field === '关联 PR'), false);
});

test('#179 SC2 人工「关联 PR」与算出的非空值不同时不改，只提醒一次', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const gate = recorder();
  const manual = stableItem(5, { linkedPr: '#4(merged)' });
  const prs = [openPr(9, 5)];
  const run = async (nowMs) => {
    const io = capture();
    await runPrioSync({
      dir,
      items: [manual],
      prs,
      nowMs,
      apply: true,
      ownerLogin: OWNER,
      projectNumber: PROJECT,
      write: gate.write,
      stdout: io.stdout,
    });
    return io.text();
  };
  const first = await run(T0);
  assert.equal(gate.writes.length, 0);
  assert.doesNotMatch(first, /关联 PR .+→/);
  assert.match(first, new RegExp(`${REPO.replaceAll('/', '\\/')}#5 关联 PR 手动值与规则不一致，提醒一次`));
  const reminded = fs.readFileSync(path.join(dir, 'reminded.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(reminded.length, 1);
  assert.equal(JSON.parse(reminded[0]).field, '关联 PR');
  assert.equal(JSON.parse(reminded[0]).target, '#9(open,CI✓)');

  const second = await run(T0 + 1000);
  assert.equal(gate.writes.length, 0);
  assert.doesNotMatch(second, /手动值与规则不一致/);
  assert.equal(fs.readFileSync(path.join(dir, 'reminded.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  assert.equal(readJsonl(dir).some((row) => row.field === '关联 PR'), false);
});

test('#179 SC3 空值或上次由 prio-sync 写入才更新；算出为空则保留任何非空值', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const gate = recorder();
  await runPrioSync({
    dir,
    items: [stableItem(21, { linkedPr: '' })],
    prs: [openPr(9, 21)],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  });
  assert.equal(gate.writes.length, 1);
  assert.deepEqual(gate.writes[0].fields, { '关联 PR': '#9(open,CI✓)' });
  assert.equal(gate.writes[0].issue, 21);

  seedLink(dir, 22, '#3(open)');
  const preview = capture();
  await runPrioSync({
    dir,
    items: [stableItem(22, { linkedPr: '#3(open)' })],
    prs: [openPr(9, 22)],
    nowMs: T0 + 1000,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: preview.stdout,
  });
  assert.equal(gate.writes.length, 1, '默认 dry-run，不调用 write');
  assert.match(preview.text(), /dry-run：/);
  assert.match(preview.text(), /#3\(open\) → #9\(open,CI✓\)/);

  const owned = capture();
  await runPrioSync({
    dir,
    items: [stableItem(22, { linkedPr: '#3(open)' })],
    prs: [openPr(9, 22)],
    nowMs: T0 + 2000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: owned.stdout,
  });
  assert.equal(gate.writes.length, 2);
  assert.deepEqual(gate.writes[1].fields, { '关联 PR': '#9(open,CI✓)' });
  assert.equal(gate.writes[1].issue, 22);
  const logged = readJsonl(dir).filter((row) => row.item === `${REPO}#22` && row.field === '关联 PR');
  assert.equal(logged.at(-1).old, '#3(open)');
  assert.equal(logged.at(-1).new, '#9(open,CI✓)');

  seedLink(dir, 23, '#8(open)');
  const kept = capture();
  await runPrioSync({
    dir,
    items: [stableItem(23, { linkedPr: '#8(open)' })],
    prs: [],
    nowMs: T0 + 3000,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: kept.stdout,
  });
  assert.equal(gate.writes.length, 2);
  assert.doesNotMatch(kept.text(), /关联 PR .+→/);
  assert.doesNotMatch(kept.text(), /手动值与规则不一致/);
  assert.match(kept.text(), /变更 0，写入 0/);
  assert.equal(readJsonl(dir).filter((row) => row.item === `${REPO}#23` && row.field === '关联 PR').length, 1);
});

test('#179 上次写入 A、看板被改成 B、算出 C 时不改，只提醒', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  seedLink(dir, 31, '#1(open)');
  const gate = recorder();
  const io = capture();
  await runPrioSync({
    dir,
    items: [stableItem(31, { linkedPr: '#2(merged)' })],
    prs: [openPr(9, 31)],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.doesNotMatch(io.text(), /关联 PR .+→/);
  assert.match(io.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#31 关联 PR 手动值与规则不一致，提醒一次`));
  const reminded = fs.readFileSync(path.join(dir, 'reminded.jsonl'), 'utf8').split('\n').filter(Boolean);
  assert.equal(reminded.length, 1);
  assert.equal(JSON.parse(reminded[0]).target, '#9(open,CI✓)');
  const logged = readJsonl(dir).filter((row) => row.field === '关联 PR');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].new, '#1(open)');
});

test('#179 多条关联 PR 记录只看最后一条，中间一条等于当前值也不可写', async () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const rows = [
    { at: new Date(T0 - 3 * DAY_MS).toISOString(), value: '#1(open)' },
    { at: new Date(T0 - 2 * DAY_MS).toISOString(), value: '#4(merged)' },
    { at: new Date(T0 - DAY_MS).toISOString(), value: '#8(open)' },
  ];
  for (const row of rows) {
    fs.appendFileSync(path.join(dir, 'changes.jsonl'), `${JSON.stringify({
      at: row.at,
      item: `${REPO}#32`,
      repo: REPO,
      issue: 32,
      field: '关联 PR',
      old: '',
      new: row.value,
      basis: 'link 关联 PR 文本与看板不一致',
    })}\n`);
  }
  const gate = recorder();
  const io = capture();
  await runPrioSync({
    dir,
    items: [stableItem(32, { linkedPr: '#4(merged)' })],
    prs: [openPr(9, 32)],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: io.stdout,
  });
  assert.equal(gate.writes.length, 0);
  assert.doesNotMatch(io.text(), /关联 PR .+→/);
  assert.match(io.text(), new RegExp(`${REPO.replaceAll('/', '\\/')}#32 关联 PR 手动值与规则不一致，提醒一次`));
  assert.equal(readJsonl(dir).filter((row) => row.field === '关联 PR').length, 3);
});
