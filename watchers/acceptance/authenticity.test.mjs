// 验收真实性（舰队标准 A）：待人工、空证据、收集不完整、标准快照、写闸拒绝非法通过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { AppOnlyError } from './bin/github.mjs';
import { runHelper } from './bin/helper.mjs';
import { SEARCH_QUERY, collectTree, skippedSearchQueries } from './bin/collect.mjs';
import { createRounds } from './bin/rounds.mjs';
import { createGate } from './host/write-gate.mjs';
import { hostPaths } from './host/paths.mjs';
import { run as procRun } from './host/proc.mjs';
import { tmpDir, writeProfile } from './fake-gh.fixture.mjs';
import {
  ALL_RAN,
  ALL_RAN_CHECKS_FILE,
  CLOCK,
  OWNER,
  OTHER_REPO,
  PASS_VERDICT_FILE,
  REPO,
  claimWorld,
  createFakeGithub,
  defaultTree,
  fullConclusions,
  machineConclusions,
  machineOnlyTree,
  writeJsonFile,
} from './session.fixture.mjs';
import {
  ITEM_PENDING,
  OVERALL_PENDING,
  STANDARD_CHANGED_REASON,
  assertNotTempModule,
  attachCodeSha,
  deriveStatus,
  evidenceIsEmpty,
  formatMaterialLine,
  guardOriginalPass,
  illegalPassFromVerdictText,
  materialVersions,
  originalPassBlocked,
  pendingCloseBlocked,
  readClaimSnapshot,
  requireClaimSnapshot,
  snapshotPassBlocked,
  snapshotPath,
  standardShifted,
  writeClaimSnapshot,
} from './bin/authenticity.mjs';

const ROOT = `${REPO}#1`;
const now = () => Date.parse(CLOCK);

function setup() {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const paths = hostPaths(home);
  fs.mkdirSync(paths.gateDir, { recursive: true });
  fs.writeFileSync(paths.enabledFile, '1');
  return { home, profile, paths };
}

function sink() {
  return {
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
}

async function helper(world, profile, argv) {
  const out = sink();
  const err = sink();
  const code = await runHelper(argv, {
    github: createFakeGithub(world),
    profile,
    now,
    stdout: out,
    stderr: err,
  });
  return { code, out: out.text, err: err.text };
}

function passItem(extra = {}) {
  return { ref: `${REPO}#2`, sc: 3, result: '通过', evidence: 'node --test 全绿', ...extra };
}

test('SC1 deriveStatus：人工层 / 待验 → 待人工；要修优先；全机器通过仍通过', () => {
  assert.equal(deriveStatus([{ ...passItem(), result: '要修', why: 'x' }], []), '要修');
  assert.equal(deriveStatus([passItem(), { ...passItem(), sc: 5, result: '人工手测', layer: 'cindy-mac' }]), OVERALL_PENDING);
  assert.equal(deriveStatus([passItem(), { ...passItem(), sc: 8, result: ITEM_PENDING }]), OVERALL_PENDING);
  assert.equal(deriveStatus([passItem()], [], { tree: { manual: [{ sc: 8 }] } }), OVERALL_PENDING);
  assert.equal(deriveStatus([passItem()], [], { skippedQueries: [{ query: 'q', reason: 'appOnly-global-search' }] }), OVERALL_PENDING);
  assert.equal(deriveStatus([passItem()], [], { collectionComplete: false }), OVERALL_PENDING);
  assert.equal(deriveStatus([passItem()], [], { extracted: true }), OVERALL_PENDING);
  assert.equal(deriveStatus([passItem()]), '通过');
  assert.equal(deriveStatus([passItem()], [{ files: ['x'] }]), '要修');
  assert.throws(() => deriveStatus([]), /没有任何逐条结论/);
});

test('SC3 空证据不能原标准通过', () => {
  assert.equal(evidenceIsEmpty(''), true);
  assert.equal(evidenceIsEmpty('—'), true);
  assert.equal(evidenceIsEmpty('无'), true);
  assert.equal(evidenceIsEmpty('node --test 全绿'), false);
  assert.match(originalPassBlocked({ ...passItem(), evidence: '' }), /通过证据为空/);
  assert.match(originalPassBlocked({ ...passItem(), evidence: '—' }), /通过证据为空/);
  assert.equal(originalPassBlocked(passItem()), null);
  assert.throws(
    () => guardOriginalPass([{ ...passItem(), evidence: '无' }], { snapshot: { materials: materialVersions() } }),
    /通过证据为空/,
  );
});

test('SC4 补充证据要结构化可追溯，不靠「临时副本」一刀切', () => {
  const tmp = tmpDir();
  const frozen = path.join(tmp, 'frozen-test.mjs');
  fs.writeFileSync(frozen, 'export default 1;\n');
  const blockedSupplement = originalPassBlocked({
    ...passItem(),
    evidenceKind: 'supplement',
    evidence: '在只读检出里跑了冻结用例',
    testFiles: ['frozen-test.mjs'],
  });
  assert.match(blockedSupplement, /补充证据不能替代冻结标准的通过/);

  const allowed = originalPassBlocked(
    {
      ...passItem(),
      evidence: '在临时副本里跑了 frozen-test.mjs，4/4',
      evidenceKind: 'frozen',
      testFiles: ['frozen-test.mjs'],
    },
    { checkoutDir: tmp },
  );
  assert.equal(allowed, null);

  const missingFiles = originalPassBlocked(
    {
      ...passItem(),
      extraTest: true,
      evidence: '临时副本补了两例',
    },
    { checkoutDir: tmp },
  );
  assert.match(missingFiles, /未提供 testFiles/);

  const extraOk = originalPassBlocked(
    {
      ...passItem(),
      extraTest: true,
      evidence: '临时副本补了两例',
      testFiles: ['frozen-test.mjs'],
    },
    { checkoutDir: tmp },
  );
  assert.equal(extraOk, null);

  assert.match(originalPassBlocked({ ...passItem(), evidenceKind: 'frozen', evidence: 'frozen ok' }), /未提供 testFiles/);
  assert.match(
    originalPassBlocked({
      ...passItem(),
      evidenceKind: 'frozen',
      evidence: 'frozen ok',
      testFiles: ['frozen-test.mjs'],
    }),
    /没有冻结检出根/,
  );
});

test('SC2 标准变化除 SC 行勾选和人工手测后缀外作废；快照可复查', () => {
  const start = ['- [ ] SC1 原文 验证：unit', '- [ ] SC2 另一条 验证：contract'].join('\n');
  const ticked = ['- [x] SC1 原文 验证：unit', '- [ ] SC2 另一条 验证：contract'].join('\n');
  const suffixed = ['- [ ] SC1 原文 验证：unit 人工手测', '- [ ] SC2 另一条 验证：contract'].join('\n');
  const rewritten = ['- [ ] SC1 改过的字 验证：unit', '- [ ] SC2 另一条 验证：contract'].join('\n');
  const nonScTick = ['- [ ] 不是SC 的任务', '- [ ] SC1 原文 验证：unit'].join('\n');
  const nonScTicked = ['- [x] 不是SC 的任务', '- [ ] SC1 原文 验证：unit'].join('\n');
  assert.equal(standardShifted(start, ticked), false);
  assert.equal(standardShifted(start, suffixed), false);
  assert.equal(standardShifted(start, rewritten), true);
  assert.equal(standardShifted(nonScTick, nonScTicked), true);

  const { profile } = setup();
  const snap = writeClaimSnapshot(profile, ROOT, 1, {
    bodyVersion: 'sha256:start',
    bodies: { [ROOT]: start },
  });
  assert.match(snapshotPath(profile, ROOT, 1), /state\/host\/snapshots/);
  assert.equal(fs.existsSync(path.join(profile.stateDir, 'snapshots', 'example-owner__example-repo__1-r1.json')), false);
  assert.equal(readClaimSnapshot(profile, ROOT, 1).bodyVersion, 'sha256:start');
  assert.match(formatMaterialLine(snap.materials), /helper\.mjs=sha256:/);
  const withSha = attachCodeSha(profile, ROOT, 1, 'a'.repeat(40));
  assert.equal(withSha.codeSha, 'a'.repeat(40));
  assert.equal(withSha.bodyVersion, 'sha256:start', '补 SHA 不覆盖起始正文');
  const kept = requireClaimSnapshot(profile, ROOT, 1, { issues: [{ ref: ROOT, body: start }] });
  assert.ok(!kept.inferred);
  assert.throws(
    () => requireClaimSnapshot(profile, `${REPO}#99`, 1, { issues: [{ ref: `${REPO}#99`, body: start }] }),
    /缺少认领快照/,
  );
});

test('SC2 材料版本与运行 SHA 写进快照；临时目录启动拒绝', () => {
  const versions = materialVersions();
  assert.ok(versions['authenticity.mjs'].startsWith('sha256:'));
  assert.doesNotThrow(() => assertNotTempModule(import.meta.url));
  const fake = path.join(os.tmpdir(), 'acceptance-temp-helper.mjs');
  assert.throws(() => assertNotTempModule(`file://${fake}`), /不能从临时目录启动/);
  assert.throws(() => assertNotTempModule('file:///var/tmp/acceptance-temp-helper.mjs'), /不能从临时目录启动/);
  const prev = process.env.TMPDIR;
  process.env.TMPDIR = '/custom-acceptance-tmp';
  try {
    assert.throws(() => assertNotTempModule('file:///custom-acceptance-tmp/helper.mjs'), /不能从临时目录启动/);
  } finally {
    if (prev === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prev;
  }
});

test('SC3 collect：appOnly 丢掉的全局搜索进 skippedQueries，不改过滤逻辑', async () => {
  const profile = {
    ownerLogin: OWNER,
    appOnly: true,
    forkRepos: ['makecindy/cindy'],
    autoRepos: [`${OWNER}/*`],
  };
  const skipped = skippedSearchQueries(ROOT, profile);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, 'appOnly-global-search');
  assert.match(skipped[0].query, /in:body is:issue$/);

  const world = defaultTree();
  const tree = await collectTree({ github: createFakeGithub(world), profile, ref: ROOT });
  assert.equal(tree.collectionComplete, false);
  assert.ok(tree.skippedQueries.some((entry) => entry.reason === 'appOnly-global-search'));
});

test('SC3 collect：必要查询被 AppOnlyError 跳过也记未完成，不绕 query gate', async () => {
  const { profile } = setup();
  const world = defaultTree();
  const github = createFakeGithub(world);
  const orig = github.graphql.bind(github);
  github.graphql = async (query, variables) => {
    if (String(query).includes('search(') && !/(?:^|\s)repo:[^\s]+/.test(String(variables?.q || ''))) {
      throw new AppOnlyError('no-app-route', { reason: 'no-app-route' });
    }
    return orig(query, variables);
  };
  const tree = await collectTree({ github, profile, ref: ROOT });
  assert.equal(tree.collectionComplete, false);
  assert.ok(tree.skippedQueries.some((entry) => entry.reason === 'no-app-route'));
});

test('SC1 close：人工层只勾已验机器项，不关总单、不写看板通过', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  claimWorld(profile, world, ROOT, 1);
  const verified = writeJsonFile(home, 'verified.json', {
    checks: ALL_RAN,
    items: [{ ref: `${REPO}#2`, sc: 3 }],
    manual: [{ ref: `${REPO}#2`, sc: 5 }],
  });
  const result = await helper(world, profile, [
    'close',
    '--issue',
    ROOT,
    '--round',
    '1',
    '--verified',
    verified,
    '--verdict',
    writeJsonFile(home, 'pending-verdict.json', { checks: ALL_RAN, items: fullConclusions() }),
  ]);
  assert.equal(result.code, 0, result.err);
  const printed = JSON.parse(result.out);
  assert.equal(printed.closed, null);
  assert.equal(printed.pendingHuman, true);
  assert.deepEqual(printed.board, []);
  assert.equal(world.get(ROOT).state, 'open');
  assert.equal(
    world.writes.some((action) => action.type === 'issue.close' || action.type === 'project.field.set'),
    false,
  );
  assert.ok(world.get(`${REPO}#2`).body.includes('- [x] SC3'));
  assert.ok(world.get(`${REPO}#2`).body.includes('人工手测'));
});

test('SC6 close：全机器层且证据非空仍勾选 → 看板通过 → 关总单', async () => {
  const { profile, home } = setup();
  const world = machineOnlyTree();
  claimWorld(profile, world, ROOT, 1);
  const verified = writeJsonFile(home, 'verified.json', {
    checks: ALL_RAN,
    items: [
      { ref: `${REPO}#2`, sc: 3 },
      { ref: `${OTHER_REPO}#7`, sc: 7 },
    ],
    manual: [],
  });
  const result = await helper(world, profile, [
    'close',
    '--issue',
    ROOT,
    '--round',
    '1',
    '--verified',
    verified,
    '--verdict',
    writeJsonFile(home, 'machine-pass.json', { checks: ALL_RAN, items: machineConclusions() }),
  ]);
  assert.equal(result.code, 0, result.err);
  const printed = JSON.parse(result.out);
  assert.equal(printed.closed, ROOT);
  assert.equal(printed.pendingHuman, false);
  assert.equal(world.get(ROOT).state, 'closed');
  assert.deepEqual(
    world.writes.map((action) => action.type),
    ['issue.edit', 'issue.edit', 'project.field.set', 'project.field.set', 'project.field.set', 'issue.close'],
  );
});

test('SC3 close/verdict：空证据零写入；标准已变则中断且不改旧评论', async () => {
  const { profile, home } = setup();
  const emptyWorld = machineOnlyTree();
  claimWorld(profile, emptyWorld, ROOT, 1);
  const emptyVerdict = writeJsonFile(home, 'empty-pass.json', {
    checks: ALL_RAN,
    items: machineConclusions({ [`${REPO}#1 SC1`]: { result: '通过', evidence: '—' } }),
  });
  const verified = writeJsonFile(home, 'verified-empty.json', {
    checks: ALL_RAN,
    items: [{ ref: `${REPO}#1`, sc: 1 }],
    manual: [],
  });
  const closed = await helper(emptyWorld, profile, [
    'close',
    '--issue',
    ROOT,
    '--round',
    '1',
    '--verified',
    verified,
    '--verdict',
    emptyVerdict,
  ]);
  assert.equal(closed.code, 1, closed.err);
  assert.match(closed.err, /通过证据为空/);
  assert.equal(emptyWorld.writes.length, 0);
  assert.equal(emptyWorld.get(ROOT).state, 'open');

  const shifted = machineOnlyTree();
  writeClaimSnapshot(profile, ROOT, 1, {
    bodyVersion: 'sha256:old',
    bodies: { [ROOT]: `${shifted.get(ROOT).body}\n额外一行会让标准变化` },
  });
  const before = shifted.get(ROOT).comments[0].body;
  const file = writeJsonFile(home, 'ok.json', { checks: ALL_RAN, items: machineConclusions() });
  const judged = await helper(shifted, profile, ['verdict', '--issue', ROOT, '--round', '1', '--file', file]);
  assert.equal(judged.code, 1, judged.err);
  assert.match(judged.err, new RegExp(STANDARD_CHANGED_REASON));
  assert.match(shifted.get(ROOT).comments[0].body.split('\n')[0], /第 1 轮：中断/);
  assert.equal(shifted.get(ROOT).comments[0].body.includes('第 1 轮：通过'), false);
  assert.ok(before.startsWith('[验收机] 第 1 轮：验收中'));
});

test('SC1 verdict：人工层总评待人工，issue 仍开着可写裁决；全机器层通过', async () => {
  const { profile, home } = setup();
  const pendingWorld = defaultTree();
  claimWorld(profile, pendingWorld, ROOT, 1);
  const pendingFile = writeJsonFile(home, 'pending.json', { checks: ALL_RAN, items: fullConclusions() });
  const pending = await helper(pendingWorld, profile, ['verdict', '--issue', ROOT, '--round', '1', '--file', pendingFile]);
  assert.equal(pending.code, 0, pending.err);
  assert.equal(JSON.parse(pending.out).status, OVERALL_PENDING);
  assert.match(pendingWorld.get(ROOT).comments[0].body.split('\n')[0], /第 1 轮：待人工/);
  assert.match(pendingWorld.get(ROOT).comments[0].body, /起始正文版本：/);
  assert.match(pendingWorld.get(ROOT).comments[0].body, /代码 SHA：/);
  assert.match(pendingWorld.get(ROOT).comments[0].body, /材料版本：helper\.mjs=sha256:/);
  assert.equal(pendingWorld.get(ROOT).state, 'open');
  assert.equal(pendingWorld.writes.some((action) => action.type === 'issue.close'), false);

  const pass = setup();
  const passWorld = machineOnlyTree();
  claimWorld(pass.profile, passWorld, ROOT, 1);
  passWorld.get(ROOT).state = 'closed';
  const passFile = writeJsonFile(pass.home, 'machine.json', { checks: ALL_RAN, items: machineConclusions() });
  const passed = await helper(passWorld, pass.profile, ['verdict', '--issue', ROOT, '--round', '1', '--file', passFile]);
  assert.equal(passed.code, 0, passed.err);
  assert.equal(JSON.parse(passed.out).status, '通过');
});

test('SC5 写闸在写副作用前拒绝非法通过 / 关单；机器层正例仍放行', async () => {
  const pending = setup();
  const pendingWorld = defaultTree();
  const pendingGate = createGate({
    home: pending.home,
    profile: pending.profile,
    github: { graphql: (query, variables) => pendingWorld.graphql({ query, variables }), write: (action) => pendingWorld.write(action) },
    run: procRun,
    binding: { root: ROOT, round: 1, commentId: 1001 },
    which: async () => false,
  });
  await pendingGate.start();
  const close = await pendingGate.handle({
    type: 'issue.close',
    repo: REPO,
    issue: 1,
    reason: 'completed',
    dedupeKey: 'illegal-close',
  });
  assert.equal(close.code, 4);
  assert.equal(close.body.reason, 'pending-human');
  assert.equal(pendingWorld.get(ROOT).state, 'open');
  assert.equal(pendingWorld.writes.length, 0);

  const board = await pendingGate.handle({
    type: 'project.field.set',
    repo: REPO,
    issue: 1,
    ownerLogin: OWNER,
    projectNumber: 7,
    fields: { 验收: '通过' },
    dedupeKey: 'illegal-board',
  });
  assert.equal(board.code, 4);
  assert.equal(board.body.reason, 'pending-human');
  assert.equal(pendingWorld.get(ROOT).project['验收'], undefined);

  const version = pendingWorld.get(ROOT).comments[0].body.split('\n').find((line) => line.startsWith('正文版本：')).slice('正文版本：'.length);
  const passComment = await pendingGate.handle({
    type: 'comment.update',
    repo: REPO,
    commentId: 1001,
    body: [`[验收机] 第 1 轮：通过`, `正文版本：${version}`, '- 人工手测：x SC1'].join('\n'),
    dedupeKey: 'illegal-pass',
  });
  assert.equal(passComment.code, 4);
  assert.equal(passComment.body.reason, 'illegal-pass');
  assert.match(pendingWorld.get(ROOT).comments[0].body, /第 1 轮：验收中/);

  const ok = setup();
  const okWorld = machineOnlyTree();
  const okGate = createGate({
    home: ok.home,
    profile: ok.profile,
    github: { graphql: (query, variables) => okWorld.graphql({ query, variables }), write: (action) => okWorld.write(action) },
    run: procRun,
    binding: { root: ROOT, round: 1, commentId: 1001 },
    which: async () => false,
  });
  await okGate.start();
  const okClose = await okGate.handle({
    type: 'issue.close',
    repo: REPO,
    issue: 1,
    reason: 'completed',
    dedupeKey: 'ok-close',
  });
  assert.equal(okClose.code, 4, JSON.stringify(okClose));
  assert.equal(okClose.body.reason, 'illegal-pass');
  assert.equal(okWorld.get(ROOT).state, 'open');
  assert.equal(okWorld.writes.length, 0);
});

test('pendingCloseBlocked / illegalPassFromVerdictText 纯函数', () => {
  assert.match(pendingCloseBlocked({ manual: [{ sc: 1 }] }), /不能关总单/);
  assert.match(pendingCloseBlocked({ skippedQueries: [{ query: 'q' }] }), /收集不完整/);
  assert.equal(pendingCloseBlocked({ manual: [], skippedQueries: [] }), null);
  const reasons = illegalPassFromVerdictText(
    ['[验收机] 第 1 轮：通过', '- 通过：x SC1 · 证据：—', '- 人工手测：x SC2'].join('\n'),
    { manual: [{ sc: 2 }] },
  );
  assert.ok(reasons.some((line) => /人工层未完成/.test(line)));
  assert.ok(reasons.some((line) => /空证据/.test(line)));
});

test('SC1 board --acceptance 通过在待人工时拒绝，要修仍可写', async () => {
  const { profile } = setup();
  const world = defaultTree();
  const blocked = await helper(world, profile, [
    'board',
    '--issue',
    ROOT,
    '--round',
    '1',
    '--acceptance',
    '通过',
    '--checks',
    ALL_RAN_CHECKS_FILE,
  ]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.err, /不能写看板通过/);
  assert.equal(world.writes.length, 0);

  const fix = defaultTree();
  const ok = await helper(fix, profile, ['board', '--issue', ROOT, '--round', '1', '--acceptance', '要修']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(fix.get(ROOT).project['验收'], '要修');
});

function openGate(home, profile, world) {
  return createGate({
    home,
    profile,
    github: { graphql: (query, variables) => world.graphql({ query, variables }), write: (action) => world.write(action) },
    run: procRun,
    binding: { root: ROOT, round: 1, commentId: 1001 },
    which: async () => false,
  });
}

test('P1-1 写闸：收集完整时无证据关总单 / 写看板通过 / 两行通过评论均拒绝', async () => {
  const { home, profile } = setup();
  const world = machineOnlyTree();
  const gate = openGate(home, profile, world);
  await gate.start();
  const close = await gate.handle({
    type: 'issue.close',
    repo: REPO,
    issue: 1,
    reason: 'completed',
    dedupeKey: 'p1-1-close',
  });
  assert.equal(close.code, 4, JSON.stringify(close));
  assert.equal(close.body.reason, 'illegal-pass');
  assert.match(close.body.detail || '', /缺少认领快照|不能通过/);
  assert.equal(world.get(ROOT).state, 'open');

  const board = await gate.handle({
    type: 'project.field.set',
    repo: REPO,
    issue: 1,
    ownerLogin: OWNER,
    projectNumber: 7,
    fields: { 验收: '通过' },
    dedupeKey: 'p1-1-board',
  });
  assert.equal(board.code, 4, JSON.stringify(board));
  assert.equal(board.body.reason, 'illegal-pass');
  assert.equal(world.get(ROOT).project['验收'], undefined);

  const version = world.get(ROOT).comments[0].body.split('\n').find((line) => line.startsWith('正文版本：')).slice('正文版本：'.length);
  const twoLine = await gate.handle({
    type: 'comment.update',
    repo: REPO,
    commentId: 1001,
    body: [`[验收机] 第 1 轮：通过`, `正文版本：${version}`].join('\n'),
    dedupeKey: 'p1-1-twoline',
  });
  assert.equal(twoLine.code, 4, JSON.stringify(twoLine));
  assert.equal(twoLine.body.reason, 'illegal-pass');
  assert.match(world.get(ROOT).comments[0].body, /第 1 轮：验收中/);
  assert.equal(world.writes.length, 0);
});

test('P1-1/SC6 写闸：完整认领快照后机器层关单仍放行', async () => {
  const { home, profile } = setup();
  const world = machineOnlyTree();
  claimWorld(profile, world, ROOT, 1);
  const gate = openGate(home, profile, world);
  await gate.start();
  const closed = await gate.handle({
    type: 'issue.close',
    repo: REPO,
    issue: 1,
    reason: 'completed',
    dedupeKey: 'p1-1-ok-close',
  });
  assert.equal(closed.code, 0, JSON.stringify(closed));
  assert.equal(world.get(ROOT).state, 'closed');
});

test('P1-2 快照缺失、缺子单或 inferred 时禁止通过/关单/看板通过', async () => {
  const missing = setup();
  const missingWorld = machineOnlyTree();
  assert.match(snapshotPassBlocked(null, { issues: [{ ref: ROOT, body: '' }] }), /缺少认领快照/);

  const inferred = setup();
  writeClaimSnapshot(inferred.profile, ROOT, 1, {
    bodyVersion: 'sha256:x',
    bodies: { [ROOT]: missingWorld.get(ROOT).body },
    inferred: true,
    materials: materialVersions(),
  });
  assert.match(
    snapshotPassBlocked(readClaimSnapshot(inferred.profile, ROOT, 1), {
      issues: [
        { ref: ROOT, body: missingWorld.get(ROOT).body },
        { ref: `${REPO}#2`, body: missingWorld.get(`${REPO}#2`).body },
      ],
    }),
    /推断/,
  );

  const partial = setup();
  const partialWorld = machineOnlyTree();
  writeClaimSnapshot(partial.profile, ROOT, 1, {
    bodyVersion: 'sha256:x',
    bodies: { [ROOT]: partialWorld.get(ROOT).body },
    materials: materialVersions(),
    inferred: false,
  });
  const closed = await helper(partialWorld, partial.profile, [
    'close',
    '--issue',
    ROOT,
    '--round',
    '1',
    '--verified',
    writeJsonFile(partial.home, 'verified.json', {
      checks: ALL_RAN,
      items: [{ ref: `${REPO}#2`, sc: 3 }],
      manual: [],
    }),
    '--verdict',
    writeJsonFile(partial.home, 'machine-pass.json', { checks: ALL_RAN, items: machineConclusions() }),
  ]);
  assert.equal(closed.code, 1, closed.err);
  assert.match(closed.err, new RegExp(STANDARD_CHANGED_REASON));
  assert.equal(partialWorld.get(ROOT).state, 'open');
  assert.equal(partialWorld.writes.some((action) => action.type === 'issue.close'), false);

  const claimed = setup();
  const claimedWorld = machineOnlyTree({ roundStatus: '通过' });
  const started = await createRounds({
    github: createFakeGithub(claimedWorld),
    profile: claimed.profile,
    now,
  }).start({
    ref: ROOT,
    repo: REPO,
    number: 1,
    kind: 'parent',
    tier: 'auto',
    children: [{ ref: `${REPO}#2` }, { ref: `${OTHER_REPO}#7` }],
  });
  const snap = readClaimSnapshot(claimed.profile, ROOT, started.round);
  assert.equal(snap.inferred, false);
  assert.equal(snap.bodies[ROOT], claimedWorld.get(ROOT).body);
  assert.equal(snap.bodies[`${REPO}#2`], claimedWorld.get(`${REPO}#2`).body);
  assert.equal(snap.bodies[`${OTHER_REPO}#7`], claimedWorld.get(`${OTHER_REPO}#7`).body);
  assert.match(snapshotPath(claimed.profile, ROOT, started.round), /state\/host\/snapshots/);
});

test('P1-3 子单不在快照或标准变化先作废，不写成待人工', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  writeClaimSnapshot(profile, ROOT, 1, {
    bodyVersion: 'sha256:start',
    bodies: { [ROOT]: world.get(ROOT).body },
    materials: materialVersions(),
  });
  const file = writeJsonFile(home, 'pending.json', { checks: ALL_RAN, items: fullConclusions() });
  const judged = await helper(world, profile, ['verdict', '--issue', ROOT, '--round', '1', '--file', file]);
  assert.equal(judged.code, 1, judged.err);
  assert.match(judged.err, new RegExp(STANDARD_CHANGED_REASON));
  assert.match(world.get(ROOT).comments[0].body.split('\n')[0], /第 1 轮：中断/);
  assert.equal(world.get(ROOT).comments[0].body.includes('待人工'), false);
});

test('P1-4 close 与 verdict 同一套完整性：只含 SC1 的 PASS_VERDICT_FILE 不能先关单', async () => {
  const { profile, home } = setup();
  const world = machineOnlyTree();
  claimWorld(profile, world, ROOT, 1);
  const verified = writeJsonFile(home, 'verified.json', {
    checks: ALL_RAN,
    items: [{ ref: `${REPO}#2`, sc: 3 }],
    manual: [],
  });
  const closed = await helper(world, profile, [
    'close',
    '--issue',
    ROOT,
    '--round',
    '1',
    '--verified',
    verified,
    '--verdict',
    PASS_VERDICT_FILE,
  ]);
  assert.equal(closed.code, 1, closed.err);
  assert.match(closed.err, /裁决缺结论/);
  assert.equal(world.get(ROOT).state, 'open');
  assert.equal(world.writes.length, 0);
});

test('P1-5 补充证据必须命中认领时冻结检出；frozen 不单独放行；materials 为空拒绝', () => {
  const tmp = tmpDir();
  fs.writeFileSync(path.join(tmp, 'frozen-test.mjs'), 'export default 1;\n');
  assert.match(
    originalPassBlocked({
      ...passItem(),
      evidenceKind: 'frozen',
      evidence: '只写 frozen',
    }),
    /未提供 testFiles/,
  );
  assert.match(
    originalPassBlocked(
      {
        ...passItem(),
        evidence: '临时副本跑了 frozen-test.mjs',
        testFiles: ['frozen-test.mjs'],
      },
    ),
    /没有冻结检出根/,
  );
  assert.equal(
    originalPassBlocked(
      {
        ...passItem(),
        evidence: '临时副本跑了 frozen-test.mjs',
        testFiles: ['frozen-test.mjs'],
      },
      { checkoutDir: tmp },
    ),
    null,
  );
  assert.throws(
    () => guardOriginalPass([passItem()], { snapshot: { materials: {} } }),
    /材料版本为空/,
  );
});

test('P2-1 裁决为要修时标准变化仍作废', async () => {
  const { profile, home } = setup();
  const world = defaultTree();
  writeClaimSnapshot(profile, ROOT, 1, {
    bodyVersion: 'sha256:start',
    bodies: {
      [ROOT]: world.get(ROOT).body,
      [`${REPO}#2`]: `${world.get(`${REPO}#2`).body}\n额外一行`,
      [`${OTHER_REPO}#7`]: world.get(`${OTHER_REPO}#7`).body,
    },
    materials: materialVersions(),
  });
  const file = writeJsonFile(home, 'fix.json', {
    checks: ALL_RAN,
    items: fullConclusions({ [`${REPO}#2 SC3`]: { result: '要修', why: '缺测试' } }),
  });
  const judged = await helper(world, profile, ['verdict', '--issue', ROOT, '--round', '1', '--file', file]);
  assert.equal(judged.code, 1, judged.err);
  assert.match(judged.err, new RegExp(STANDARD_CHANGED_REASON));
  assert.match(world.get(ROOT).comments[0].body.split('\n')[0], /第 1 轮：中断/);
  assert.equal(world.get(ROOT).comments[0].body.includes('第 1 轮：要修'), false);
});

test('P2-2 人工层未完成时子单 issue.close 也被拒绝', async () => {
  const { home, profile } = setup();
  const world = defaultTree();
  const gate = openGate(home, profile, world);
  await gate.start();
  const childClose = await gate.handle({
    type: 'issue.close',
    repo: REPO,
    issue: 2,
    reason: 'completed',
    dedupeKey: 'p2-2-child',
  });
  assert.equal(childClose.code, 4, JSON.stringify(childClose));
  assert.equal(childClose.body.reason, 'pending-human');
  assert.equal(world.get(`${REPO}#2`).state, 'open');
  assert.equal(world.writes.length, 0);
});

test('P2-5 写闸把 AppOnly/no-owner 搜索以未执行查询返回，collectTree 记 collectionComplete:false', async () => {
  const { home, profile } = setup();
  const world = defaultTree();
  const phrase = `"[验收机] 修正 · 总 ${ROOT}" in:body is:issue`;
  const gate = createGate({
    home,
    profile,
    github: {
      async graphql(query, variables) {
        if (query === SEARCH_QUERY && !/(?:^|\s)repo:[^\s]+/.test(String(variables?.q || ''))) {
          throw new AppOnlyError('no-owner', { reason: 'no-owner' });
        }
        return world.graphql({ query, variables });
      },
      write: (action) => world.write(action),
    },
    run: procRun,
    binding: { root: ROOT, round: 1, commentId: 1001 },
    which: async () => false,
  });
  await gate.start();
  const read = await gate.handle({
    type: 'read.graphql',
    query: SEARCH_QUERY,
    variables: { q: phrase },
  });
  assert.equal(read.code, 0, JSON.stringify(read));
  assert.equal(read.body.data.skippedQueries[0].reason, 'no-owner');
  assert.equal(read.body.data.search.nodes.length, 0);

  const github = {
    async graphql(query, variables) {
      if (query === SEARCH_QUERY && !/(?:^|\s)repo:[^\s]+/.test(String(variables?.q || ''))) {
        return {
          search: { nodes: [] },
          skippedQueries: [{ query: variables.q, reason: 'no-owner' }],
        };
      }
      return world.graphql({ query, variables });
    },
  };
  const tree = await collectTree({ github, profile, ref: ROOT });
  assert.equal(tree.collectionComplete, false);
  assert.ok(tree.skippedQueries.some((entry) => entry.reason === 'no-owner'));
});

