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
import { collectTree, skippedSearchQueries } from './bin/collect.mjs';
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
  ensureClaimSnapshot,
  formatMaterialLine,
  guardOriginalPass,
  illegalPassFromVerdictText,
  materialVersions,
  originalPassBlocked,
  pendingCloseBlocked,
  readClaimSnapshot,
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
  assert.throws(() => guardOriginalPass([{ ...passItem(), evidence: '无' }]), /通过证据为空/);
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
  assert.match(missingFiles, /没有结构化冻结追溯/);
});

test('SC2 标准变化除勾选和人工手测后缀外作废；快照可复查', () => {
  const start = ['- [ ] SC1 原文 验证：unit', '- [ ] SC2 另一条 验证：contract'].join('\n');
  const ticked = ['- [x] SC1 原文 验证：unit', '- [ ] SC2 另一条 验证：contract'].join('\n');
  const suffixed = ['- [ ] SC1 原文 验证：unit 人工手测', '- [ ] SC2 另一条 验证：contract'].join('\n');
  const rewritten = ['- [ ] SC1 改过的字 验证：unit', '- [ ] SC2 另一条 验证：contract'].join('\n');
  assert.equal(standardShifted(start, ticked), false);
  assert.equal(standardShifted(start, suffixed), false);
  assert.equal(standardShifted(start, rewritten), true);

  const { profile } = setup();
  const snap = writeClaimSnapshot(profile, ROOT, 1, {
    bodyVersion: 'sha256:start',
    bodies: { [ROOT]: start },
  });
  assert.equal(readClaimSnapshot(profile, ROOT, 1).bodyVersion, 'sha256:start');
  assert.match(formatMaterialLine(snap.materials), /helper\.mjs=sha256:/);
  const withSha = attachCodeSha(profile, ROOT, 1, 'a'.repeat(40));
  assert.equal(withSha.codeSha, 'a'.repeat(40));
  assert.equal(withSha.bodyVersion, 'sha256:start', '补 SHA 不覆盖起始正文');
  const inferred = ensureClaimSnapshot(profile, ROOT, 1, { root: { ref: ROOT, bodyVersion: 'sha256:start' }, issues: [] });
  assert.equal(inferred.inferred, undefined);
});

test('SC2 材料版本与运行 SHA 写进快照；临时目录启动拒绝', () => {
  const versions = materialVersions();
  assert.ok(versions['authenticity.mjs'].startsWith('sha256:'));
  assert.doesNotThrow(() => assertNotTempModule(import.meta.url));
  const fake = path.join(os.tmpdir(), 'acceptance-temp-helper.mjs');
  assert.throws(() => assertNotTempModule(`file://${fake}`), /不能从临时目录启动/);
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
    PASS_VERDICT_FILE,
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
    PASS_VERDICT_FILE,
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
  const emptyVerdict = writeJsonFile(home, 'empty-pass.json', {
    checks: ALL_RAN,
    items: [{ ref: `${REPO}#1`, sc: 1, result: '通过', evidence: '—' }],
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
  assert.equal(okClose.code, 0, JSON.stringify(okClose));
  assert.equal(okWorld.get(ROOT).state, 'closed');
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
