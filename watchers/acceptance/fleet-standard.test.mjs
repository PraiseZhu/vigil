// W5 任务标准：只读 check、YAML 头生成表格、按日期写 evidence、红灯写 alerts。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './fake-gh.fixture.mjs';
import {
  DEFAULT_TIMEOUT_MS,
  ESCALATE_UNCHANGED_MS,
  TIMEOUT_EXIT_CODE,
  parseChecklist,
  renderTable,
  runChecklist,
} from './bin/fleet-standard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EXAMPLE = path.join(ROOT, 'config', 'examples', 'fleet-checklist.example.md');
const DOC = path.join(ROOT, 'docs', 'fleet-standard.md');

function readJsonl(file) {
  const text = fs.readFileSync(file, 'utf8');
  return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

function layout() {
  const dir = tmpDir('fleet-standard-');
  return {
    dir,
    evidenceDir: path.join(dir, 'evidence'),
    alertsFile: path.join(dir, 'alerts.jsonl'),
  };
}

const OK = `---
id: ok-row
owner: example-owner
check: node -e "process.exit(0)"
deadline: 24h
escalate: example-lead
evidence: example-probe
---
`;

const BAD = `---
id: bad-row
owner: example-owner
check: node -e "process.exit(3)"
deadline: 24h
escalate: example-lead
evidence: example-probe
---
`;

const MANUAL = `---
id: human-row
owner: example-owner
check: manual
deadline: 7d
escalate: example-lead
evidence: example-review
sampler: example-sampler
frequency: weekly
---
`;

const SLOW = `---
id: slow-row
owner: example-owner
check: sleep 9999
deadline: 24h
escalate: example-lead
evidence: example-probe
---
`;

test('SC1 非 manual 的 check 会执行并带回退出码，manual 不执行', async () => {
  const { evidenceDir, alertsFile } = layout();
  const commands = [];
  const results = await runChecklist(`${OK}\n${BAD}\n${MANUAL}`, {
    evidenceDir,
    alertsFile,
    now: () => Date.parse('2026-10-31T03:04:05.000Z'),
    spawnImpl(command) {
      commands.push(command);
      const child = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
      return {
        exited: async () => ({ code: child.status ?? 1, signal: child.signal }),
        kill() {},
      };
    },
  });
  assert.deepEqual(commands, ['node -e "process.exit(0)"', 'node -e "process.exit(3)"']);
  const ok = results.find((item) => item.id === 'ok-row');
  const bad = results.find((item) => item.id === 'bad-row');
  const human = results.find((item) => item.id === 'human-row');
  assert.equal(ok.status, 'pass');
  assert.equal(ok.code, 0);
  assert.equal(bad.status, 'red');
  assert.equal(bad.code, 3);
  assert.equal(human.status, 'manual');
  assert.equal(human.code, null);
  const alerts = readJsonl(alertsFile);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'fleet-check-red');
  assert.equal(alerts[0].id, 'bad-row');
});

test('SC1 只有精确的 manual 才跳过执行', async () => {
  const { evidenceDir, alertsFile } = layout();
  const commands = [];
  const results = await runChecklist(`---
id: not-manual
owner: example-owner
check: Manual
deadline: 24h
escalate: example-lead
evidence: example-probe
---
`, {
    evidenceDir,
    alertsFile,
    now: () => Date.parse('2026-10-31T03:04:05.000Z'),
    spawnImpl(command) {
      commands.push(command);
      return { exited: async () => ({ code: 0, signal: null }), kill() {} };
    },
  });
  assert.deepEqual(commands, ['Manual']);
  assert.equal(results[0].status, 'pass');
  assert.equal(results[0].code, 0);
});

test('SC1 清单缺必填字段、或 manual 没写抽检人和频率时拒绝', () => {
  assert.throws(
    () => parseChecklist(`---
id: missing-owner
check: node -e "process.exit(0)"
deadline: 24h
escalate: example-lead
evidence: example-probe
---
`),
    /owner/,
  );
  assert.throws(
    () => parseChecklist(`---
id: human-row
owner: example-owner
check: manual
deadline: 7d
escalate: example-lead
evidence: example-review
sampler: example-sampler
---
`),
    /frequency/,
  );
});

test('SC1 示例清单里每条非 manual 的 check 都能执行并返回退出码', async () => {
  const { evidenceDir, alertsFile } = layout();
  const text = fs.readFileSync(EXAMPLE, 'utf8');
  const items = parseChecklist(text);
  const machine = items.filter((item) => item.check !== 'manual');
  assert.ok(machine.length >= 1);
  const results = await runChecklist(text, {
    evidenceDir,
    alertsFile,
    now: () => Date.parse('2026-10-31T03:04:05.000Z'),
  });
  assert.equal(results.length, items.length);
  for (const item of machine) {
    const result = results.find((row) => row.id === item.id);
    assert.equal(typeof result.code, 'number', item.id);
    assert.equal(result.code, 0, item.id);
    assert.equal(result.status, 'pass', item.id);
  }
  for (const item of items.filter((row) => row.check === 'manual')) {
    const result = results.find((row) => row.id === item.id);
    assert.equal(result.status, 'manual');
    assert.equal(result.code, null);
    assert.ok(item.sampler);
    assert.ok(item.frequency);
  }
});

test('SC2 超时行用假时钟推进 60 秒就写红灯，测试本身不等 60 秒', async () => {
  const started = Date.now();
  let clock = Date.parse('2026-10-31T00:00:00.000Z');
  const { evidenceDir, alertsFile } = layout();
  const results = await runChecklist(SLOW, {
    evidenceDir,
    alertsFile,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    spawnImpl() {
      return { exited: () => new Promise(() => {}), kill() {} };
    },
  });
  assert.equal(DEFAULT_TIMEOUT_MS, 60_000);
  assert.equal(results[0].status, 'red');
  assert.equal(results[0].reason, 'timeout');
  assert.equal(results[0].code, TIMEOUT_EXIT_CODE);
  assert.ok(results[0].elapsedMs >= DEFAULT_TIMEOUT_MS);
  assert.ok(results[0].elapsedMs < DEFAULT_TIMEOUT_MS + 1000);
  const alerts = readJsonl(alertsFile);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'fleet-check-red');
  assert.equal(alerts[0].id, 'slow-row');
  assert.match(alerts[0].reason, /超时/);
  assert.equal(alerts[0].ts, '2026-10-31T00:01:00.000Z');
  assert.ok(Date.now() - started < 2000, `测试用了 ${Date.now() - started}ms`);
});

test('SC2 真进程超时会被杀掉，不必把默认 60 秒跑完', async () => {
  const started = Date.now();
  const { evidenceDir, alertsFile } = layout();
  const results = await runChecklist(SLOW, {
    evidenceDir,
    alertsFile,
    timeoutMs: 200,
    now: () => Date.now(),
  });
  assert.equal(results[0].status, 'red');
  assert.equal(results[0].reason, 'timeout');
  assert.equal(results[0].code, TIMEOUT_EXIT_CODE);
  assert.ok(Date.now() - started < 5000);
  const alerts = readJsonl(alertsFile);
  assert.equal(alerts[0].kind, 'fleet-check-red');
});

test('SC2 红灯连续两小时没变就按 escalate 再写一条，中间转绿则重计', async () => {
  let clock = Date.parse('2026-10-31T00:00:00.000Z');
  const { evidenceDir, alertsFile } = layout();
  const hang = {
    evidenceDir,
    alertsFile,
    timeoutMs: 60_000,
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    spawnImpl() {
      return { exited: () => new Promise(() => {}), kill() {} };
    },
  };
  await runChecklist(SLOW, hang);
  clock = Date.parse('2026-10-31T00:00:00.000Z');
  let alerts = readJsonl(alertsFile);
  assert.equal(alerts.filter((item) => item.kind === 'fleet-check-escalate').length, 0);

  clock = Date.parse('2026-10-31T02:00:00.000Z');
  await runChecklist(SLOW, hang);
  alerts = readJsonl(alertsFile);
  const escalations = alerts.filter((item) => item.kind === 'fleet-check-escalate');
  assert.equal(escalations.length, 1);
  assert.equal(escalations[0].id, 'slow-row');
  assert.equal(escalations[0].escalate, 'example-lead');
  assert.equal(ESCALATE_UNCHANGED_MS, 2 * 60 * 60 * 1000);

  clock = Date.parse('2026-10-31T03:00:00.000Z');
  await runChecklist(SLOW, hang);
  alerts = readJsonl(alertsFile);
  assert.equal(alerts.filter((item) => item.kind === 'fleet-check-escalate').length, 1);

  const passAt = Date.parse('2026-10-31T04:00:00.000Z');
  clock = passAt;
  await runChecklist(OK.replace('id: ok-row', 'id: slow-row'), {
    evidenceDir,
    alertsFile,
    now: () => clock,
    spawnImpl() {
      return { exited: async () => ({ code: 0, signal: null }), kill() {} };
    },
  });
  clock = Date.parse('2026-10-31T04:30:00.000Z');
  await runChecklist(SLOW, hang);
  alerts = readJsonl(alertsFile);
  assert.equal(alerts.filter((item) => item.kind === 'fleet-check-escalate').length, 1);

  clock = Date.parse('2026-10-31T06:30:00.000Z');
  await runChecklist(SLOW, hang);
  alerts = readJsonl(alertsFile);
  assert.equal(alerts.filter((item) => item.kind === 'fleet-check-escalate').length, 2);
});

test('SC3 evidence 按 UTC 日期写入 jsonl，每行有时间、来源、结果', async () => {
  const { evidenceDir, alertsFile } = layout();
  const first = Date.parse('2026-10-31T23:00:00.000Z');
  await runChecklist(`${OK}\n${MANUAL}`, {
    evidenceDir,
    alertsFile,
    now: () => first,
    spawnImpl() {
      return { exited: async () => ({ code: 0, signal: null }), kill() {} };
    },
  });
  const dayFile = path.join(evidenceDir, '2026-10-31.jsonl');
  assert.equal(fs.existsSync(dayFile), true);
  const lines = readJsonl(dayFile);
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(typeof line.at, 'string');
    assert.equal(Number.isNaN(Date.parse(line.at)), false);
    assert.equal(typeof line.source, 'string');
    assert.ok(line.source.length > 0);
    assert.equal(typeof line.result, 'string');
  }
  assert.equal(lines[0].at, '2026-10-31T23:00:00.000Z');
  assert.equal(lines[0].source, 'example-probe');
  assert.equal(lines[0].result, 'pass');
  assert.equal(lines[0].id, 'ok-row');
  assert.equal(lines[1].source, 'example-review');
  assert.equal(lines[1].result, 'manual');
  assert.equal(lines[1].id, 'human-row');

  const second = Date.parse('2026-11-01T00:30:00.000Z');
  await runChecklist(BAD, {
    evidenceDir,
    alertsFile,
    now: () => second,
    spawnImpl() {
      return { exited: async () => ({ code: 3, signal: null }), kill() {} };
    },
  });
  assert.equal(readJsonl(dayFile).length, 2, '另一天不写进前一天的文件');
  const nextFile = path.join(evidenceDir, '2026-11-01.jsonl');
  const nextLines = readJsonl(nextFile);
  assert.equal(nextLines.length, 1);
  assert.equal(nextLines[0].at, '2026-11-01T00:30:00.000Z');
  assert.equal(nextLines[0].source, 'example-probe');
  assert.equal(nextLines[0].result, 'red');
  assert.equal(nextLines[0].id, 'bad-row');
});

test('SC3 没给 evidence 目录或 alerts 文件就拒绝，不写默认路径', async () => {
  await assert.rejects(() => runChecklist(OK, { alertsFile: path.join(tmpDir(), 'alerts.jsonl') }), /evidence/);
  await assert.rejects(() => runChecklist(OK, { evidenceDir: tmpDir() }), /alerts/);
});

test('SC4 YAML 头能生成表格', () => {
  const items = parseChecklist(`${OK}\n${MANUAL}`);
  const table = renderTable(items);
  const [header, rule, okRow, humanRow] = table.trim().split('\n');
  assert.equal(header, '| id | owner | check | deadline | escalate | evidence | sampler | frequency |');
  assert.equal(rule, '| --- | --- | --- | --- | --- | --- | --- | --- |');
  assert.match(okRow, /\| ok-row \|/);
  assert.match(okRow, /\| example-owner \|/);
  assert.match(okRow, /\| 24h \|/);
  assert.match(okRow, /\| example-lead \|/);
  assert.match(okRow, /\| example-probe \|/);
  assert.match(humanRow, /\| human-row \|/);
  assert.match(humanRow, /\| manual \|/);
  assert.match(humanRow, /\| example-sampler \|/);
  assert.match(humanRow, /\| weekly \|/);
});

test('SC4 示例清单能生成表格，且格式说明写明箱上过时条目不在本仓库', () => {
  const text = fs.readFileSync(EXAMPLE, 'utf8');
  const doc = fs.readFileSync(DOC, 'utf8');
  const table = renderTable(parseChecklist(text));
  assert.match(table, /\| id \| owner \| check \| deadline \| escalate \| evidence \|/);
  assert.match(table, /example-exit-ok/);
  assert.match(table, /manual/);
  assert.match(doc, /id/);
  assert.match(doc, /owner/);
  assert.match(doc, /check/);
  assert.match(doc, /deadline/);
  assert.match(doc, /escalate/);
  assert.match(doc, /evidence/);
  assert.match(doc, /YYYY-MM-DD\.jsonl/);
  assert.match(doc, /60/);
  assert.match(doc, /manual/);
  assert.match(doc, /#131/);
  assert.match(doc, /#119/);
  assert.match(doc, /不在本仓库|不在仓库/);
  assert.doesNotMatch(text, /#131/);
  assert.doesNotMatch(text, /#119/);
});

test('检查子进程看不到令牌环境变量', async () => {
  const { evidenceDir, alertsFile } = layout();
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'test-token-not-real';
  try {
    const results = await runChecklist(`---
id: env-row
owner: example-owner
check: node -e "process.exit(process.env.GITHUB_TOKEN ? 7 : 0)"
deadline: 24h
escalate: example-lead
evidence: example-probe
---
`, {
      evidenceDir,
      alertsFile,
      now: () => Date.parse('2026-10-31T03:04:05.000Z'),
    });
    assert.equal(results[0].code, 0);
    assert.equal(results[0].status, 'pass');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

test('table 子命令把示例清单打成表格，check 子命令缺参数就失败', () => {
  const table = spawnSync(process.execPath, [
    path.join(HERE, 'bin', 'fleet-standard.mjs'),
    'table',
    '--list',
    EXAMPLE,
  ], { encoding: 'utf8', cwd: ROOT });
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /\| id \| owner \| check \| deadline \| escalate \| evidence \|/);
  assert.match(table.stdout, /example-exit-ok/);

  const missing = spawnSync(process.execPath, [
    path.join(HERE, 'bin', 'fleet-standard.mjs'),
    'check',
    '--list',
    EXAMPLE,
  ], { encoding: 'utf8', cwd: ROOT });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /evidence/);
});
