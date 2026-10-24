import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  canonicalRuntime, runtimeSha256, parseFailureSet, canonicalFailureSet, sameFailureSet, isFailureSubset,
  passCacheKey, publishPass, lookupPass,
} from './bin/mivo-validation-evidence.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const WT = '/work/example-plugin';
const HOOK_FAIL = [
  '[preflight] ▶ test',
  ' RUN  v2.1.0 /work/example-plugin',
  '',
  ' ❯ scripts/ops/example.test.mjs (5 tests | 2 failed) 12ms',
  '   × example > owns the env file 1ms',
  '',
  '⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  scripts/ops/example.test.mjs > example > owns the env file',
  'AssertionError: expected 501 to be +0 // Object.is equality',
  '',
  '- Expected',
  '+ Received',
  '',
  '- 0',
  '+ 501',
  '',
  ' ❯ scripts/ops/example.test.mjs:12:5',
  '',
  ' FAIL  scripts/ops/example.test.mjs > example > reads the mode',
  'AssertionError: expected 420 to be 384',
  ' ❯ scripts/ops/example.test.mjs:20:5',
  '',
  ' Test Files  1 failed | 3 passed (4)',
  '      Tests  2 failed | 10 passed (12)',
  '[preflight] ❌ test 失败',
].join('\n');

test('parseFailureSet：vitest + hook 尾标记解析出 {step,file,test,errorSha}，哈希稳定', () => {
  const a = parseFailureSet(HOOK_FAIL, { worktree: WT });
  assert.equal(a.state, 'parsed');
  assert.equal(a.failureSet.length, 2);
  assert.deepEqual(a.failureSet.map((item) => [item.step, item.file, item.test]), [
    ['test', 'scripts/ops/example.test.mjs', 'example > owns the env file'],
    ['test', 'scripts/ops/example.test.mjs', 'example > reads the mode'],
  ]);
  assert.match(a.failureSet[0].errorSha, /^[0-9a-f]{64}$/);
  const b = parseFailureSet(HOOK_FAIL.replace(/\n/g, '\r\n'), { worktree: WT });
  assert.equal(b.failureSetSha256, a.failureSetSha256, 'CRLF 不改变哈希');
  const ansi = parseFailureSet(HOOK_FAIL.replace('AssertionError', '\u001b[31mAssertionError\u001b[39m'), { worktree: WT });
  assert.equal(ansi.failureSetSha256, a.failureSetSha256, 'ANSI 不改变哈希');
  const moved = parseFailureSet(HOOK_FAIL.replaceAll('/work/example-plugin', '/other/place'), { worktree: '/other/place' });
  assert.equal(moved.failureSetSha256, a.failureSetSha256, 'worktree 路径不进哈希');
});

test('parseFailureSet：报错里临时目录的随机名不进 errorSha（同一失败在 PR 与基线两次运行可对上）', () => {
  const withTmp = (dir) => HOOK_FAIL.replace('AssertionError: expected 501 to be +0 // Object.is equality', `Error: Command failed: bash -lc source "${dir}/update.sh"; main --smoke-only`);
  const a = parseFailureSet(withTmp('/private/tmp/example-update-JMJhor'), { worktree: WT });
  const b = parseFailureSet(withTmp('/private/tmp/example-update-jF4Es5'), { worktree: WT });
  const c = parseFailureSet(withTmp('/var/folders/ab/cd1234ef/T/example-update-Q9zX1a'), { worktree: WT });
  const d = parseFailureSet(withTmp('/tmp/example-update-77aa'), { worktree: WT });
  assert.equal(a.state, 'parsed');
  assert.equal(a.failureSet[0].errorSha, b.failureSet[0].errorSha);
  assert.equal(a.failureSet[0].errorSha, c.failureSet[0].errorSha);
  assert.equal(a.failureSet[0].errorSha, d.failureSet[0].errorSha);
  assert.equal(sameFailureSet(a, b), true);
  const other = parseFailureSet(withTmp('/private/tmp/example-update-JMJhor').replace('main --smoke-only', 'main --full'), { worktree: WT });
  assert.notEqual(a.failureSet[0].errorSha, other.failureSet[0].errorSha, '临时目录以外的差异仍区分');
});

test('parseFailureSet：报错里每次运行都变的时间戳不进 errorSha', () => {
  const withTs = (ts) => HOOK_FAIL.replace('AssertionError: expected 420 to be 384', `AssertionError: run_id=timer-${ts.compact} at ${ts.iso} expected 420 to be 384`);
  const a = parseFailureSet(withTs({ compact: '20261024T132343Z', iso: '2026-10-24T13:23:43.120Z' }), { worktree: WT });
  const b = parseFailureSet(withTs({ compact: '20261024T133945Z', iso: '2026-10-24T13:39:45Z' }), { worktree: WT });
  assert.equal(a.state, 'parsed');
  assert.equal(a.failureSet[1].errorSha, b.failureSet[1].errorSha);
  const other = parseFailureSet(withTs({ compact: '20261024T132343Z', iso: '2026-10-24T13:23:43.120Z' }).replace('expected 420 to be 384', 'expected 421 to be 384'), { worktree: WT });
  assert.notEqual(a.failureSet[1].errorSha, other.failureSet[1].errorSha, '时间戳以外的差异仍区分');
});

test('parseFailureSet：数字/expected 不同的同名失败是不同元素', () => {
  const other = HOOK_FAIL.replace('expected 501 to be +0', 'expected 502 to be +0').replace('+ 501', '+ 502');
  const a = parseFailureSet(HOOK_FAIL, { worktree: WT });
  const b = parseFailureSet(other, { worktree: WT });
  assert.notEqual(a.failureSet[0].errorSha, b.failureSet[0].errorSha);
  assert.equal(a.failureSet[1].errorSha, b.failureSet[1].errorSha);
  assert.equal(sameFailureSet(a, b), false);
});

test('parseFailureSet：无法完整解析时标记 unparsed，且 unparsed 不与任何集合相等', () => {
  const cases = {
    lint: '[preflight] ▶ lint\nerror: unexpected token\n[preflight] ❌ lint 失败',
    truncated: HOOK_FAIL.split('\n').slice(0, 12).join('\n'),
    noMarker: HOOK_FAIL.replace('[preflight] ❌ test 失败', ''),
    countMismatch: HOOK_FAIL.replace('Tests  2 failed', 'Tests  3 failed'),
    unhandled: `${HOOK_FAIL}\nUnhandled Rejection: boom`,
    empty: '',
  };
  for (const [name, text] of Object.entries(cases)) {
    const parsed = parseFailureSet(text, { worktree: WT });
    assert.equal(parsed.state, 'unparsed', name);
    assert.equal(parsed.failureSetSha256, null, name);
    assert.equal(sameFailureSet(parsed, parsed), false, name);
    assert.equal(isFailureSubset(parsed, parseFailureSet(HOOK_FAIL, { worktree: WT })), false, name);
  }
  const lone = parseFailureSet('', { worktree: WT });
  assert.equal(sameFailureSet(lone, { state: 'parsed', failureSet: [], failureSetSha256: canonicalFailureSet([]).sha256 }), false);
});

// 以下样例由真实 Node/Vitest 运行产出后脱敏（路径、名称改成占位），保持原有行格式。
const NODE_SPEC_FAIL = [
  '[preflight] ▶ ops',
  '✔ passes (0.57ms)',
  '✖ compares values (0.59ms)',
  '▶ group',
  '  ✖ inner fails (0.13ms)',
  '✖ group (0.26ms)',
  'ℹ tests 3',
  'ℹ suites 1',
  'ℹ pass 1',
  'ℹ fail 2',
  'ℹ cancelled 0',
  '',
  '✖ failing tests:',
  '',
  'test at scripts/ops/example-thing.test.mjs:4:1',
  '✖ compares values (0.59ms)',
  '  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:',
  '  ',
  '  1 !== 2',
  '  ',
  '      at TestContext.<anonymous> (file:///work/example-plugin/scripts/ops/example-thing.test.mjs:4:40)',
  '      at Test.run (node:internal/test_runner/test:1201:25)',
  '  {',
  "    code: 'ERR_ASSERTION',",
  '  }',
  '',
  'test at scripts/ops/example-thing.test.mjs:5:32',
  '✖ inner fails (0.13ms)',
  '  Error: boom: inner',
  '      at TestContext.<anonymous> (file:///work/example-plugin/scripts/ops/example-thing.test.mjs:5:66)',
  '[preflight] ❌ ops 失败',
].join('\n');

const NODE_TAP_FAIL = [
  'TAP version 13',
  '# Subtest: passes',
  'ok 1 - passes',
  '# Subtest: compares values',
  'not ok 2 - compares values',
  '  ---',
  "  duration_ms: 0.62",
  "  type: 'test'",
  "  location: '/work/example-plugin/scripts/ops/example-thing.test.mjs:4:1'",
  "  failureType: 'testCodeFailure'",
  '  error: |-',
  '    Expected values to be strictly equal:',
  '    ',
  '    1 !== 2',
  '    ',
  "  code: 'ERR_ASSERTION'",
  '  stack: |-',
  '    TestContext.<anonymous> (file:///work/example-plugin/scripts/ops/example-thing.test.mjs:4:40)',
  '  ...',
  '# Subtest: group',
  '    # Subtest: inner fails',
  '    not ok 1 - inner fails',
  '      ---',
  "      location: '/work/example-plugin/scripts/ops/example-thing.test.mjs:5:32'",
  "      failureType: 'testCodeFailure'",
  "      error: 'boom: inner'",
  '      ...',
  '    1..1',
  'not ok 3 - group',
  '  ---',
  "  location: '/work/example-plugin/scripts/ops/example-thing.test.mjs:5:6'",
  "  failureType: 'subtestsFailed'",
  "  error: '1 subtest failed'",
  '  ...',
  '1..3',
  '# tests 3',
  '# pass 1',
  '# fail 2',
  '[preflight] ❌ ops 失败',
].join('\n');

const VITEST_FILE_LEVEL = [
  '⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯',
  '',
  ' FAIL  scripts/ops/example-load.test.mjs [ scripts/ops/example-load.test.mjs ]',
  "Error: Cannot find module './missing.mjs' imported from /work/example-plugin/scripts/ops/example-load.test.mjs",
  ' ❯ scripts/ops/example-load.test.mjs:1:1',
  '',
  ' Test Files  1 failed | 3 passed (4)',
  '      Tests  no tests',
  '[preflight] ❌ test 失败',
].join('\n');

test('parseFailureSet：node:test 的 spec 输出（failing tests 段）解析出失败，嵌套套件不重复计数', () => {
  const parsed = parseFailureSet(NODE_SPEC_FAIL, { worktree: WT });
  assert.equal(parsed.state, 'parsed', parsed.reason);
  assert.deepEqual(parsed.failureSet.map((item) => [item.step, item.file, item.test]), [
    ['ops', 'scripts/ops/example-thing.test.mjs', 'compares values'],
    ['ops', 'scripts/ops/example-thing.test.mjs', 'inner fails'],
  ]);
  assert.equal(parseFailureSet(NODE_SPEC_FAIL.replace('1 !== 2', '1 !== 3'), { worktree: WT }).failureSet.some((item) => item.errorSha === parsed.failureSet[0].errorSha), false);
  assert.equal(parseFailureSet(NODE_SPEC_FAIL.replace('ℹ fail 2', 'ℹ fail 3'), { worktree: WT }).state, 'unparsed', '失败计数对不上');
  assert.equal(parseFailureSet(NODE_SPEC_FAIL.split('\n').filter((line) => !line.startsWith('test at scripts/ops/example-thing.test.mjs:5')).join('\n'), { worktree: WT }).state, 'unparsed', '缺失败块');
});

test('parseFailureSet：node:test 的 TAP 输出解析出叶子失败，忽略 subtestsFailed 的套件行', () => {
  const parsed = parseFailureSet(NODE_TAP_FAIL, { worktree: WT });
  assert.equal(parsed.state, 'parsed', parsed.reason);
  assert.deepEqual(parsed.failureSet.map((item) => [item.file, item.test]), [
    ['scripts/ops/example-thing.test.mjs', 'compares values'],
    ['scripts/ops/example-thing.test.mjs', 'inner fails'],
  ]);
  const spec = parseFailureSet(NODE_SPEC_FAIL, { worktree: WT });
  assert.notEqual(parsed.failureSetSha256, null);
  assert.equal(spec.state, 'parsed');
  assert.equal(parseFailureSet(NODE_TAP_FAIL.replace('# fail 2', '# fail 5'), { worktree: WT }).state, 'unparsed');
});

test('parseFailureSet：vitest 文件级失败（FAIL file [ file ]、Tests no tests）按 Test Files 计数解析', () => {
  const parsed = parseFailureSet(VITEST_FILE_LEVEL, { worktree: WT });
  assert.equal(parsed.state, 'parsed', parsed.reason);
  assert.equal(parsed.failureSet.length, 1);
  assert.equal(parsed.failureSet[0].file, 'scripts/ops/example-load.test.mjs');
  assert.equal(parsed.failureSet[0].test, '<file>');
  assert.equal(parseFailureSet(VITEST_FILE_LEVEL.replace('1 failed | 3 passed', '2 failed | 2 passed'), { worktree: WT }).state, 'unparsed', 'Test Files 计数对不上');
  const mixed = [HOOK_FAIL.replace('[preflight] ❌ test 失败', ''), VITEST_FILE_LEVEL.split('\n').slice(2, 5).join('\n'), '[preflight] ❌ test 失败'].join('\n');
  assert.equal(parseFailureSet(mixed, { worktree: WT }).state, 'unparsed', 'Test Files 1 failed 但出现两个文件');
});

test('isFailureSubset：非空子集 true；多一个元素、空集合、旧收据（无字段）都为 false', () => {
  const full = parseFailureSet(HOOK_FAIL, { worktree: WT });
  const one = { state: 'parsed', failureSet: [full.failureSet[0]] };
  assert.equal(isFailureSubset(one, full), true);
  assert.equal(isFailureSubset(full, one), false);
  assert.equal(isFailureSubset({ state: 'parsed', failureSet: [] }, full), false);
  assert.equal(isFailureSubset(undefined, full), false);
  assert.equal(isFailureSubset(full, {}), false);
  assert.equal(sameFailureSet(full, parseFailureSet(HOOK_FAIL, { worktree: WT })), true);
});

test('canonicalRuntime：字段齐全，TMPDIR 取 realpath，lockfile 哈希来自原始字节；任一项变化哈希随之变化', (t) => {
  const dir = tmp(t);
  const real = path.join(dir, 'real');
  const link = path.join(dir, 'link');
  fs.mkdirSync(real);
  fs.symlinkSync(real, link);
  const worktree = path.join(dir, 'wt');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"a":1}');
  const runtime = canonicalRuntime({ worktree, tmpdir: link });
  assert.equal(runtime.tmpdir, fs.realpathSync(real));
  assert.equal(runtime.packageLockSha256, sha('{"a":1}'));
  assert.equal(runtime.platform, process.platform);
  assert.equal(runtime.arch, process.arch);
  assert.equal(runtime.node, process.version);
  assert.equal(runtime.uid, process.getuid());
  const base = runtimeSha256(runtime);
  for (const key of Object.keys(runtime)) {
    assert.notEqual(runtimeSha256({ ...runtime, [key]: `${runtime[key]}x` }), base, key);
  }
  fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{"a":2}');
  assert.notEqual(runtimeSha256(canonicalRuntime({ worktree, tmpdir: link })), base);
  fs.rmSync(path.join(worktree, 'package-lock.json'));
  assert.equal(canonicalRuntime({ worktree, tmpdir: link }).packageLockSha256, null);
});

function passFixture(t) {
  const validations = tmp(t);
  const identity = { repo: 'example-org/example-plugin', nodeId: 'PR_x', number: 7, head: 'a'.repeat(40), policySha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64) };
  const logPath = path.join(validations, 'logs', 'run.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, 'all good\n');
  const receipt = {
    schemaVersion: 2, kind: 'mivo-repair-validation', validationEvidenceVersion: 1,
    repo: identity.repo, nodeId: identity.nodeId, number: identity.number, head: identity.head,
    status: 'pass', exitCode: 0, policy: { sha256: identity.policySha256 }, runtimeSha256: identity.runtimeSha256,
    command: { binary: '/bin/bash', args: ['.githooks/pre-push'] }, logPath, logSha256: sha('all good\n'),
    reusedFrom: null, failureSetState: 'parsed', failureSet: [],
  };
  const receiptPath = path.join(validations, 'd1', `${identity.head}-x.json`);
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  const bytes = `${JSON.stringify(receipt, null, 2)}\n`;
  fs.writeFileSync(receiptPath, bytes);
  const receiptSha256 = sha(bytes);
  publishPass({ validations, identity, receiptPath, receiptSha256 });
  return { validations, identity, receiptPath, receiptSha256, logPath, receipt };
}

test('lookupPass：同条件命中；改 head/policy/runtime/PR 任一项都 miss', (t) => {
  const f = passFixture(t);
  assert.equal(lookupPass({ validations: f.validations, identity: f.identity })?.receiptPath, f.receiptPath);
  for (const key of ['head', 'policySha256', 'runtimeSha256', 'number', 'nodeId', 'repo']) {
    const changed = { ...f.identity, [key]: key === 'number' ? 8 : `${f.identity[key]}z` };
    assert.equal(lookupPass({ validations: f.validations, identity: changed }), null, key);
  }
  assert.notEqual(passCacheKey(f.identity), passCacheKey({ ...f.identity, head: 'd'.repeat(40) }));
});

test('lookupPass：篡改收据、篡改/删除日志、非 pass 收据、索引损坏都 miss（转为重跑）', (t) => {
  const f = passFixture(t);
  fs.appendFileSync(f.logPath, 'tampered');
  assert.equal(lookupPass({ validations: f.validations, identity: f.identity }), null, 'log tampered');
  fs.writeFileSync(f.logPath, 'all good\n');
  assert.ok(lookupPass({ validations: f.validations, identity: f.identity }));
  fs.rmSync(f.logPath);
  assert.equal(lookupPass({ validations: f.validations, identity: f.identity }), null, 'log deleted');
  fs.writeFileSync(f.logPath, 'all good\n');
  fs.appendFileSync(f.receiptPath, ' ');
  assert.equal(lookupPass({ validations: f.validations, identity: f.identity }), null, 'receipt tampered');
  const g = passFixture(t);
  const indexDir = path.join(g.validations, 'pass-cache');
  for (const name of fs.readdirSync(indexDir)) fs.writeFileSync(path.join(indexDir, name), '{not json');
  assert.equal(lookupPass({ validations: g.validations, identity: g.identity }), null, 'index corrupt');
});

test('lookupPass：复用收据（reusedFrom）或旧收据（无增强字段）不进入缓存', (t) => {
  const f = passFixture(t);
  const legacy = { ...f.receipt };
  delete legacy.validationEvidenceVersion;
  const bytes = `${JSON.stringify(legacy)}\n`;
  fs.writeFileSync(f.receiptPath, bytes);
  publishPass({ validations: f.validations, identity: f.identity, receiptPath: f.receiptPath, receiptSha256: sha(bytes) });
  assert.equal(lookupPass({ validations: f.validations, identity: f.identity }), null);
});
