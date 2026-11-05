// W4-d：单条精确读写。只读这一条 issue 的看板条目和它点名的 PR，写入仍走现有写闸与 changes.jsonl。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { isReadOnlyGraphql } from './bin/github.mjs';
import { BOARD_ITEMS_QUERY, ITEM_FIELD_QUERY, createReadGithub, runPrioSync } from './bin/prio-sync.mjs';
import {
  ITEM_QUERY,
  ITEM_TIMELINE_FIRST,
  linkWouldShrink,
  main,
  parseItemArgs,
  prNumbersInText,
  prsFromTimeline,
  syncOneItem,
} from './bin/prio-item.mjs';
import { OWNER, REPO, createFakeRun, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const PROJECT = 7;
const BOARD_ID = 'PVT_board';
const OTHER_BOARD_ID = 'PVT_other_board';
const ITEM = 1;
const REF = `${REPO}#${ITEM}`;

function capture() {
  let out = '';
  return {
    stdout: {
      write(chunk) {
        out += chunk;
      },
    },
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

function fieldValue(kind, name, value) {
  if (kind === 'single') {
    return {
      __typename: 'ProjectV2ItemFieldSingleSelectValue',
      name: value,
      field: { name },
    };
  }
  return { __typename: 'ProjectV2ItemFieldTextValue', text: value, field: { name } };
}

/** 一条看板条目，字段形状和整盘查询的 nodes 一样（mapItem 直接用）。 */
function itemNode({
  repo = REPO,
  number = ITEM,
  priority = null,
  linkedPr = '',
  status = 'Todo',
  labels = [],
  state = 'OPEN',
  updatedAt = '2026-10-31T00:00:00.000Z',
  archived = false,
  projectId = BOARD_ID,
} = {}) {
  const values = [];
  if (priority) values.push(fieldValue('single', '优先级', priority));
  if (linkedPr) values.push(fieldValue('text', '关联 PR', linkedPr));
  if (status) values.push(fieldValue('single', '状态', status));
  return {
    id: `PVTI_${projectId}_${number}`,
    isArchived: archived,
    updatedAt,
    project: { id: projectId, number: PROJECT },
    content: {
      __typename: 'Issue',
      number,
      state,
      updatedAt,
      repository: { nameWithOwner: repo },
      labels: { nodes: labels.map((name) => ({ name })) },
    },
    fieldValues: { nodes: values },
  };
}

/** 交叉引用里的一条 PR（mapPr 只认这些字段）。 */
function prNode({
  repo = REPO,
  number = 12,
  title = 'a pr',
  body = `任务 issue：${REF}`,
  state = 'OPEN',
  merged = false,
  headRefName = 'feature/x',
  rollup = 'SUCCESS',
} = {}) {
  return {
    __typename: 'PullRequest',
    number,
    title,
    body,
    state,
    merged,
    headRefName,
    repository: { nameWithOwner: repo },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: rollup } } }] },
  };
}

function crossRef(pr) {
  return { __typename: 'CrossReferencedEvent', source: pr };
}

/**
 * 假 GitHub：整盘查询直接返回「不认识」，只有 ITEM_QUERY 和 ITEM_FIELD_QUERY 有答案。
 * 这样「只读这一条」不是靠计数断言，而是整盘那条查询一旦被发出去就失败。
 */
function fakeGithub({
  items = [itemNode()],
  prs = [],
  cost = 2,
  boardId = BOARD_ID,
  issueExists = true,
  readback = () => null,
} = {}) {
  const queries = [];
  const run = createFakeRun({
    onGraphql: async (payload) => {
      const query = String(payload?.query || '');
      queries.push({ query, variables: payload?.variables });
      if (query === ITEM_QUERY) {
        return {
          rateLimit: { cost, remaining: 4000, resetAt: '2026-10-31T13:00:00Z' },
          user: { projectV2: boardId ? { id: boardId } : null },
          repository: issueExists
            ? {
              issue: {
                timelineItems: { nodes: prs.map(crossRef) },
                projectItems: { nodes: items },
              },
            }
            : null,
        };
      }
      if (query === ITEM_FIELD_QUERY) return readback(payload?.variables);
      return { code: 1, stdout: '', stderr: '整盘或未知查询不该出现在单条路径里' };
    },
  });
  return { run, queries };
}

function setup(extra = {}) {
  const home = tmpDir();
  const { profile } = writeProfile(home, extra);
  const dir = path.join(home, 'tools', '.prio');
  fs.mkdirSync(dir, { recursive: true });
  return { home, profile, dir };
}

function readJsonl(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readDebounce(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'debounce.json'), 'utf8'));
}

function writeDebounce(dir, body) {
  fs.writeFileSync(path.join(dir, 'debounce.json'), `${JSON.stringify(body)}\n`);
}

function otherState(priority) {
  return {
    priority,
    pending: null,
    pendingHeld: false,
    lastRecalcAt: null,
    consecutive: 0,
    changes: [],
  };
}

async function sync(env, overrides = {}) {
  const io = capture();
  const gate = recorder();
  const result = await syncOneItem({
    repo: REPO,
    issue: ITEM,
    dir: env.dir,
    nowMs: T0,
    profile: env.profile,
    reader: env.reader,
    write: gate.write,
    stdout: io.stdout,
    ...overrides,
  });
  return { result, gate, io };
}

function readerFor(fake, profile) {
  return createReadGithub({ profile, run: fake.run });
}

test('W4-d SC1 只发一次只读查询，读的是这一条而不是整盘，并带回 rateLimit.cost', async () => {
  const env = setup();
  const fake = fakeGithub({ cost: 2 });
  env.reader = readerFor(fake, env.profile);
  const { result } = await sync(env, { apply: false });
  assert.equal(fake.queries.length, 1);
  assert.equal(fake.queries[0].query, ITEM_QUERY);
  assert.equal(isReadOnlyGraphql(ITEM_QUERY), true);
  assert.notEqual(ITEM_QUERY, BOARD_ITEMS_QUERY);
  assert.ok(!/items\(first: 100/.test(ITEM_QUERY), '单条查询里不能出现整盘的分页读');
  assert.deepEqual(fake.queries[0].variables, {
    login: OWNER,
    projectNumber: PROJECT,
    owner: 'example-owner',
    name: 'example-repo',
    number: ITEM,
  });
  assert.equal(ITEM_TIMELINE_FIRST, 50);
  assert.equal(result.cost, 2);
  assert.equal(result.planned, 1);
  assert.equal(result.written, 0);
});

test('W4-d SC1 两种读法的规模差别：整盘查询按 100 条分页，单条查询只有这一条', async () => {
  // 这条只守住「别把整盘读塞进单条路径」：两个查询是两份常量，形状不同。
  assert.match(BOARD_ITEMS_QUERY, /items\(first: 100/);
  assert.match(ITEM_QUERY, /projectItems\(first: 20, includeArchived: true\)/);
  assert.ok(!/search\(/.test(ITEM_QUERY), '单条路径不搜 PR，只认这一条的交叉引用');
});

test('W4-d SC2 apply 时走现有写闸一次，回读一致后追加 changes.jsonl', async () => {
  const env = setup();
  const fake = fakeGithub({ readback: () => ({ node: { fieldValues: { nodes: [fieldValue('single', '优先级', 'P2')] } } }) });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(gate.writes.length, 1);
  const action = gate.writes[0];
  assert.equal(action.type, 'project.field.set');
  assert.deepEqual(action.fields, { 优先级: 'P2' });
  assert.equal(action.ownerLogin, OWNER);
  assert.equal(action.projectNumber, PROJECT);
  assert.equal(action.issue, ITEM);
  assert.equal(action.repo, REPO);
  assert.equal(action.itemId, `PVTI_${BOARD_ID}_${ITEM}`);
  assert.equal(result.written, 1);
  const rows = readJsonl(env.dir, 'changes.jsonl');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].field, '优先级');
  assert.equal(rows[0].new, 'P2');
  assert.deepEqual(result.readbacks, [{ item: REF, field: '优先级', expected: 'P2', actual: 'P2' }]);
});

test('W4-d SC2 回读不一致时不写 changes.jsonl，按回读失败报出来', async () => {
  const env = setup();
  const fake = fakeGithub({ readback: () => ({ node: { fieldValues: { nodes: [fieldValue('single', '优先级', 'P1')] } } }) });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(gate.writes.length, 1);
  assert.equal(result.written, 0);
  assert.equal(result.readbackMismatch.field, '优先级');
  assert.equal(readJsonl(env.dir, 'changes.jsonl').length, 0);
});

test('W4-d SC3 合并写回：只更新这一条，别的条目的防抖与 CI 携带状态一条不丢', async () => {
  const env = setup();
  writeDebounce(env.dir, {
    items: { [REF]: otherState(null), [`${REPO}#2`]: otherState('P0') },
    prCi: { [`${REPO}#99`]: { mark: 'pass', pending: 1 } },
  });
  const fake = fakeGithub({ readback: () => ({ node: { fieldValues: { nodes: [fieldValue('single', '优先级', 'P2')] } } }) });
  env.reader = readerFor(fake, env.profile);
  const { result } = await sync(env, { apply: true });
  assert.equal(result.written, 1);
  const state = readDebounce(env.dir);
  assert.deepEqual(state.items[`${REPO}#2`], otherState('P0'), '别的条目的防抖状态必须原样保留');
  assert.deepEqual(state.prCi, { [`${REPO}#99`]: { mark: 'pass', pending: 1 } }, '别的 PR 的 CI 携带状态必须留着');
  assert.equal(state.items[REF].priority, 'P2', '写成功的这一条要落新值');
});

test('W4-d SC3 反证：不传 mergeState 时整份重建会把别的条目删掉（这就是要合并写回的原因）', async () => {
  const env = setup();
  writeDebounce(env.dir, {
    items: { [REF]: otherState(null), [`${REPO}#2`]: otherState('P0') },
    prCi: { [`${REPO}#99`]: { mark: 'pass', pending: 1 } },
  });
  const gate = recorder();
  await runPrioSync({
    dir: env.dir,
    items: [
      {
        id: `PVTI_${BOARD_ID}_${ITEM}`,
        repo: REPO,
        number: ITEM,
        priority: null,
        linkedPr: '',
        labels: [],
        status: 'Todo',
        acceptance: null,
        issueState: 'open',
        issueStateKnown: true,
        lastEventAt: T0 - 60_000,
        lastEventKnown: true,
        repoClass: 'daily-tool',
        repoUnlisted: false,
      },
    ],
    prs: [],
    nowMs: T0,
    apply: true,
    ownerLogin: OWNER,
    projectNumber: PROJECT,
    write: gate.write,
    stdout: capture().stdout,
  });
  const state = readDebounce(env.dir);
  assert.equal(state.items[`${REPO}#2`], undefined, '整份重建会把没传进来的条目抹掉');
});

test('W4-d 事件对应的 issue 不在看板上：不写、不抛，原因写回', async () => {
  const env = setup();
  writeDebounce(env.dir, { items: { [`${REPO}#2`]: otherState('P0') } });
  const fake = fakeGithub({ items: [] });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(result.reason, 'not-on-board');
  assert.equal(result.written, 0);
  assert.equal(result.planned, 0);
  assert.equal(gate.writes.length, 0);
  assert.equal(fs.existsSync(path.join(env.dir, 'changes.jsonl')), false);
  assert.deepEqual(readDebounce(env.dir).items, { [`${REPO}#2`]: otherState('P0') });
});

test('W4-d 条目属于别的看板（project id 不同）时按不在看板上处理', async () => {
  const env = setup();
  const fake = fakeGithub({ items: [itemNode({ projectId: OTHER_BOARD_ID })] });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(result.reason, 'not-on-board');
  assert.equal(gate.writes.length, 0);
});

test('W4-d issue 读不到（仓库或号不存在）：不写、不抛', async () => {
  const env = setup();
  const fake = fakeGithub({ issueExists: false });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(result.reason, 'not-found');
  assert.equal(result.written, 0);
  assert.equal(gate.writes.length, 0);
});

test('W4-d 已归档条目：不写、不抛', async () => {
  const env = setup();
  const fake = fakeGithub({ items: [itemNode({ archived: true })] });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(result.reason, 'archived');
  assert.equal(gate.writes.length, 0);
});

test('W4-d 字段没有变化：不写、不追加 changes.jsonl', async () => {
  const env = setup();
  const fake = fakeGithub({ items: [itemNode({ priority: 'P2' })] });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(result.reason, '');
  assert.equal(result.planned, 0);
  assert.equal(result.written, 0);
  assert.equal(gate.writes.length, 0);
  assert.equal(fs.existsSync(path.join(env.dir, 'changes.jsonl')), false);
});

test('W4-d 被钉住（prio:pin）：不写', async () => {
  const env = setup();
  const fake = fakeGithub({ items: [itemNode({ labels: ['prio:pin'] })] });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(result.pinned, 1);
  assert.equal(result.written, 0);
  assert.equal(gate.writes.length, 0);
});

test('W4-d 被去抖挡住（降级未满 15 分钟）：不写，只记 pending', async () => {
  const env = setup();
  // 看板上的 P0 是上一拍自己写的（不是人手改的），才轮到防抖判降级。
  fs.writeFileSync(
    path.join(env.dir, 'changes.jsonl'),
    `${JSON.stringify({ at: new Date(T0 - 120_000).toISOString(), item: REF, repo: REPO, issue: ITEM, field: '优先级', old: null, new: 'P0', basis: 'S1' })}\n`,
  );
  const fake = fakeGithub({ items: [itemNode({ priority: 'P0' })] });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(result.written, 0);
  assert.equal(gate.writes.length, 0);
  const state = readDebounce(env.dir);
  assert.equal(state.items[REF].priority, 'P0');
  assert.equal(state.items[REF].pending, 'P2');
  assert.equal(state.items[REF].pendingHeld, true);
});

test('W4-d 关联 PR 只认点名了这一条的 PR，写的是现有文本格式', async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.dir, 'mac-mini-stopped'), 'ok\n');
  const fake = fakeGithub({
    items: [itemNode({ priority: 'P2' })],
    prs: [prNode({ number: 12 }), prNode({ number: 13, body: '没有任务 issue 行' })],
    readback: () => ({ node: { fieldValues: { nodes: [fieldValue('text', '关联 PR', '#12(open,CI✓)')] } } }),
  });
  env.reader = readerFor(fake, env.profile);
  const { result, gate } = await sync(env, { apply: true });
  assert.equal(gate.writes.length, 1);
  assert.deepEqual(gate.writes[0].fields, { '关联 PR': '#12(open,CI✓)' });
  assert.equal(result.written, 1);
  assert.deepEqual(result.readbacks[0].actual, '#12(open,CI✓)');
});

test('W4-d 关联 PR 不回退：只看到部分 PR 时不把已有的 PR 从文本里删掉', async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.dir, 'mac-mini-stopped'), 'ok\n');
  fs.writeFileSync(
    path.join(env.dir, 'changes.jsonl'),
    `${JSON.stringify({ at: new Date(T0 - 60_000).toISOString(), item: REF, repo: REPO, issue: ITEM, field: '关联 PR', old: '', new: '#11(merged) #12(open)', basis: 'link 关联 PR 文本与看板不一致' })}\n`,
  );
  const fake = fakeGithub({
    items: [itemNode({ priority: 'P2', linkedPr: '#11(merged) #12(open)' })],
    prs: [prNode({ number: 12 })],
  });
  env.reader = readerFor(fake, env.profile);
  const { result, gate, io } = await sync(env, { apply: true });
  assert.equal(result.shrinkSkipped, 1);
  assert.equal(result.written, 0);
  assert.equal(gate.writes.length, 0);
  assert.match(io.text(), /关联 PR 不回退：1 条只看到部分 PR，本拍不写/);
  assert.equal(readJsonl(env.dir, 'changes.jsonl').length, 1);
});

test('W4-d 乱序事件：旧事件晚到不会把看板改回旧状态（每次都按当前状态重算）', async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.dir, 'mac-mini-stopped'), 'ok\n');
  // 当前 GitHub 的真实状态：PR #12 已合并。晚到的「旧事件」说的是「#12 还开着」，但本模块不读事件正文，
  // 只重读这一条，所以两次算出来的是同一个结果，第二次一条都不写。
  const board = itemNode({ priority: 'P2' });
  const prs = [prNode({ number: 12, state: 'MERGED', merged: true })];
  const fake = fakeGithub({
    items: [board],
    prs,
    readback: () => ({ node: { fieldValues: { nodes: [fieldValue('text', '关联 PR', '#12(merged)')] } } }),
  });
  env.reader = readerFor(fake, env.profile);
  const first = await sync(env, { apply: true });
  assert.equal(first.result.written, 1);
  assert.equal(first.gate.writes.length, 1);
  assert.deepEqual(first.gate.writes[0].fields, { '关联 PR': '#12(merged)' });
  // 看板已经是刚写下的值。
  board.fieldValues.nodes.push(fieldValue('text', '关联 PR', '#12(merged)'));
  // 同一份当前状态再跑一遍（相当于晚到的旧事件重新触发一次）。
  const late = await sync(env, { apply: true });
  assert.equal(late.result.planned, 0);
  assert.equal(late.result.written, 0);
  assert.equal(late.gate.writes.length, 0);
  assert.equal(readJsonl(env.dir, 'changes.jsonl').length, 1, '旧事件不该再追加一条变更');
});

test('W4-d 关联 PR 的收缩判定只按 PR 号比较', () => {
  assert.equal(linkWouldShrink('#12(open) #13(merged)', '#12(open,CI✓)'), true);
  assert.equal(linkWouldShrink('#12(open)', '#12(merged)'), false);
  assert.equal(linkWouldShrink('', '#12(open)'), false);
  assert.deepEqual([...prNumbersInText('#3(open) #14(merged)')], [3, 14]);
});

test('W4-d timeline 里非 PR 的交叉引用被跳过，重复的 PR 只算一次', () => {
  const prs = prsFromTimeline([
    crossRef(prNode({ number: 12 })),
    crossRef(prNode({ number: 12 })),
    { __typename: 'CrossReferencedEvent', source: { __typename: 'Issue', number: 5 } },
    crossRef(prNode({ number: 15, rollup: 'FAILURE' })),
  ]);
  assert.equal(prs.length, 2);
  assert.deepEqual(prs.map((pr) => `${pr.repo}#${pr.number}`), [`${REPO}#12`, `${REPO}#15`]);
  assert.equal(prs[1].ci, 'fail');
});

test('W4-d 调用方已经拿到 PR 时不从 timeline 取（prs 覆盖）', async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.dir, 'mac-mini-stopped'), 'ok\n');
  const fake = fakeGithub({
    items: [itemNode({ priority: 'P2' })],
    prs: [prNode({ number: 12 })],
    readback: () => ({ node: { fieldValues: { nodes: [fieldValue('text', '关联 PR', '#21(merged)')] } } }),
  });
  env.reader = readerFor(fake, env.profile);
  const { gate } = await sync(env, { apply: true, prs: [{ repo: REPO, number: 21, title: 't', body: `任务 issue：${REF}`, state: 'merged', merged: true, headRefName: 'x' }] });
  assert.equal(gate.writes.length, 1);
  assert.deepEqual(gate.writes[0].fields, { '关联 PR': '#21(merged)' });
});

test('W4-d --dry-run 是默认：不写、不建 changes.jsonl、不读令牌', async () => {
  const env = setup();
  const fake = fakeGithub();
  const io = capture();
  const gate = recorder();
  const result = await main(['--repo', REPO, '--issue', String(ITEM), '--state-dir', env.dir], {
    run: fake.run,
    loadProfile: () => env.profile,
    now: () => T0,
    stdout: io.stdout,
    write: gate.write,
    readToken: () => {
      throw new Error('dry-run 不该读令牌');
    },
  });
  assert.equal(result.written, 0);
  assert.equal(result.planned, 1);
  assert.equal(gate.writes.length, 0);
  assert.equal(fake.queries.length, 1);
  assert.equal(fs.existsSync(path.join(env.dir, 'changes.jsonl')), false);
  assert.match(io.text(), /dry-run：1 条，变更 1，写入 0/);
});

test('W4-d --write 才写；有停写开关时不写、也不读令牌', async () => {
  const env = setup();
  const fake = fakeGithub({ readback: () => ({ node: { fieldValues: { nodes: [fieldValue('single', '优先级', 'P2')] } } }) });
  const gate = recorder();
  const io = capture();
  const written = await main(['--repo', REPO, '--issue', String(ITEM), '--write', '--state-dir', env.dir], {
    run: fake.run,
    loadProfile: () => env.profile,
    now: () => T0,
    stdout: io.stdout,
    write: gate.write,
    readToken: () => {
      throw new Error('注入了写函数就不该读令牌');
    },
  });
  assert.equal(written.written, 1);
  assert.equal(gate.writes.length, 1);

  fs.writeFileSync(path.join(env.dir, 'disabled'), '停写\n');
  const second = capture();
  const secondGate = recorder();
  const fake2 = fakeGithub();
  const stopped = await main(['--repo', REPO, '--issue', String(ITEM), '--write', '--state-dir', env.dir], {
    run: fake2.run,
    loadProfile: () => env.profile,
    now: () => T0,
    stdout: second.stdout,
    write: secondGate.write,
    readToken: () => {
      throw new Error('停写时不该读令牌');
    },
  });
  assert.equal(stopped.written, 0);
  assert.equal(secondGate.writes.length, 0);
  assert.match(second.text(), /已停写/);
});

test('W4-d 参数不合法时在读令牌和发请求之前退出', async () => {
  const env = setup();
  const fake = fakeGithub();
  const deps = {
    run: fake.run,
    loadProfile: () => env.profile,
    now: () => T0,
    stdout: capture().stdout,
    readToken: () => {
      throw new Error('不该读令牌');
    },
  };
  await assert.rejects(() => main(['--repo', 'not-a-repo', '--issue', '1'], deps), /--repo 期望 owner\/repo/);
  await assert.rejects(() => main(['--repo', REPO, '--issue', '0'], deps), /--issue 期望正整数/);
  await assert.rejects(() => main(['--repo', REPO, '--issue', '1', '--write', '--dry-run'], deps), /不能同时传/);
  await assert.rejects(() => main(['--repo', REPO], deps), /缺少 --issue/);
  await assert.rejects(() => main(['--repo', REPO, '--issue', '1', '--only-field', '验收'], deps), /--only-field 期望/);
  assert.equal(fake.queries.length, 0);
});

test('W4-d 两个参数解析都只认白名单字段与合法仓名', () => {
  assert.deepEqual(parseItemArgs(['--repo', REPO, '--issue', '9']), {
    write: false,
    dryRun: false,
    repo: REPO,
    issue: 9,
    stateDir: null,
    onlyField: null,
  });
  assert.deepEqual(parseItemArgs(['--repo', REPO, '--issue', '9', '--write', '--only-field', '关联 PR', '--state-dir', 'state-x']), {
    write: true,
    dryRun: false,
    repo: REPO,
    issue: 9,
    stateDir: 'state-x',
    onlyField: '关联 PR',
  });
});
