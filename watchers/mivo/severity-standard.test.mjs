// The repair session and its arbiter grade findings with the reviewer's own severity standard file,
// instead of a hand-written P2/P3 definition that drifted from the reviewer's (vigil#37).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  loadSeverityStandard, taskSeverityStandard, dispatchParams, constrainRetryDispatch, rulesVersion, WORKER_RULE,
  SEVERITY_STANDARD_ENV, _resetSeverityStandardForTests,
} from './bin/mivo-watcher.mjs';

const STANDARD = '## 分级(示例)\n\n| 等级 | 定义 | 处理 |\n|---|---|---|\n| P2 一般缺陷 | 含误导性的测试 | 报 |\n';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-severity-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, 'severity.md');
fs.writeFileSync(file, STANDARD);
const versionOf = (raw) => createHash('sha256').update(raw).digest('hex').slice(0, 12);
const OLD_DEFINITION = /缺测试或规范违反本身不单独构成 P2/;

function withStandard(value, fn) {
  const before = process.env[SEVERITY_STANDARD_ENV];
  if (value === undefined) delete process.env[SEVERITY_STANDARD_ENV];
  else process.env[SEVERITY_STANDARD_ENV] = value;
  _resetSeverityStandardForTests();
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env[SEVERITY_STANDARD_ENV];
    else process.env[SEVERITY_STANDARD_ENV] = before;
    _resetSeverityStandardForTests();
  }
}
const message = () => dispatchParams({
  pr: { number: 1, id: 'PR_1', headRefOid: 'a'.repeat(40), title: 't' }, mapping: { title: 't' }, fresh: [],
  now: '2026-10-22T00:00:00Z', taskPath: '/h/tasks/t.json', home: '/h', version: '-',
}).message;
const retryMessage = () => constrainRetryDispatch({ message: 'old' }, { headRefOid: 'a'.repeat(40), feedback: [] }).message;

test('标准文件读得到:全文与版本号(文件原始内容 sha256 前 12 位,与审查机同一算法)', () => {
  const standard = loadSeverityStandard({ env: { [SEVERITY_STANDARD_ENV]: file } });
  assert.equal(standard.loaded, true);
  assert.equal(standard.text, STANDARD.trim());
  assert.equal(standard.version, versionOf(STANDARD));
  assert.deepEqual(taskSeverityStandard(standard), { loaded: true, version: versionOf(STANDARD), text: STANDARD.trim() });
});

test('没配置或读不到:标为未加载并写明原因', () => {
  const missingConfig = withStandard(undefined, () => loadSeverityStandard());
  assert.equal(missingConfig.loaded, false);
  assert.match(missingConfig.reason, /未配置 severityStandardPath/);
  const unreadable = loadSeverityStandard({ env: { [SEVERITY_STANDARD_ENV]: path.join(dir, 'missing.md') } });
  assert.equal(unreadable.loaded, false);
  assert.match(unreadable.reason, /读不到标准文件（ENOENT）/);
  assert.deepEqual(taskSeverityStandard(unreadable), { loaded: false, reason: unreadable.reason });
  fs.writeFileSync(path.join(dir, 'empty.md'), ' \n');
  assert.match(loadSeverityStandard({ env: { [SEVERITY_STANDARD_ENV]: path.join(dir, 'empty.md') } }).reason, /空/);
});

test('主派单与重试派单都带标准全文和版本号,不再有自写的 P2/P3 定义', () => {
  withStandard(file, () => {
    for (const text of [message(), retryMessage()]) {
      assert.ok(text.includes(STANDARD.trim()), '缺标准全文');
      assert.ok(text.includes(`统一分级（审查机发布的唯一标准，版本 ${versionOf(STANDARD)}`));
      assert.match(text, /与 KEEL J4 或任何其他分级说法冲突时以它为准/);
      assert.match(text, /P0\/P1\/P2\/P3 按「统一分级」一节判/);
      assert.doesNotMatch(text, OLD_DEFINITION);
    }
  });
});

test('读不到标准:提示词要求审查账号的 P0/P1/P2 必须修,不判不成立、不开裁决', () => {
  withStandard(path.join(dir, 'missing.md'), () => {
    for (const text of [message(), retryMessage()]) {
      assert.match(text, /统一分级标准读不到（读不到标准文件（ENOENT））/);
      assert.match(text, /审查账号（source=mivo-review）提的 P0\/P1\/P2 一律按成立处理，必须修，不得判不成立、不得记 no-change，也不开裁决/);
      assert.doesNotMatch(text, OLD_DEFINITION);
    }
  });
});

test('裁决规则:裁决材料由 helper 生成并原样交出,只按其中的统一分级判级;读不到标准不开裁决', () => {
  assert.match(WORKER_RULE, /运行同一 helper adjudication-brief --keys <争议的反馈 key，逗号分隔> --claim <你复现与反驳的证据>，把返回的 brief 原样交给裁决者/);
  assert.match(WORKER_RULE, /不得改写或删减 brief。裁决者只按 brief 里的统一分级判级（KEEL J4 等其他分级说法不算）/);
  assert.match(WORKER_RULE, /统一分级读不到时，审查账号（source=mivo-review）的 P0\/P1\/P2 不开裁决，直接修/);
});

test('标准内容一变,规则版本跟着变:已绑定的修复会话会收到规则刷新', () => {
  const other = path.join(dir, 'other.md');
  fs.writeFileSync(other, `${STANDARD}- 新增一条\n`);
  const first = withStandard(file, () => rulesVersion());
  const second = withStandard(other, () => rulesVersion());
  assert.match(first, /^[0-9a-f]{12}$/);
  assert.notEqual(first, second);
  assert.equal(withStandard(file, () => rulesVersion()), first);
});
