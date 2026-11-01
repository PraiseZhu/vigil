// #199 board-live 只读视图。夹具行格式与 prio-sync.mjs 的 appendChange / saveDebounce /
// remindOnce / main 运行头一致：changes.jsonl 一行一个 JSON，debounce.json 是 { items }，
// reminded.jsonl 以 at 开头，运行头是 `<ISO> dry-run|apply <条数>`。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHANGE_WINDOW_MS, MAX_CHANGES_PER_HOUR } from './bin/prio-score.mjs';
import { DEFAULT_STALE_MS, FREEZE_AT_CHANGES, viewPrio } from './bin/prio-view.mjs';

const REPO = 'example/org-a';
const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const HERE = fileURLToPath(new URL('.', import.meta.url));

function iso(ms) {
  return new Date(ms).toISOString();
}

function changeLine({ at = iso(T0), item, issue, repo = REPO, field = '优先级', old = null, value = 'P2', basis = '情形档 P2' }) {
  return `${JSON.stringify({
    at,
    item,
    repo,
    issue,
    field,
    old,
    new: value,
    basis,
  })}\n`;
}

function debounceText(items) {
  return `${JSON.stringify({ items })}\n`;
}

function hold(priority, extra = {}) {
  return {
    priority,
    pending: null,
    pendingHeld: false,
    lastRecalcAt: null,
    consecutive: 0,
    changes: [],
    ...extra,
  };
}

function remindedLine(row) {
  return `${JSON.stringify({ at: iso(T0), ...row })}\n`;
}

function latencyLine(latencyMs, deliveryId) {
  return `${JSON.stringify({
    deliveryId,
    createdAt: '2026-10-31T00:00:00.000Z',
    processedAt: iso(T0),
    latencyMs,
    source: 'worker',
  })}\n`;
}

function runHeader(ms, mode = 'dry-run', count = 1) {
  return `${iso(ms)} ${mode} ${count}\n`;
}

function fresh(extra = {}) {
  return {
    changes: '',
    debounce: '',
    reminded: '',
    runLog: runHeader(T0),
    latency: '',
    nowMs: T0,
    ...extra,
  };
}

test('#199 SC1 同一 item 三条优先级记录：当前值与依据取最后一条', () => {
  const item = `${REPO}#7`;
  const changes = [
    changeLine({ at: iso(T0), item, issue: 7, old: null, value: 'P2', basis: '第一次依据' }),
    changeLine({ at: iso(T0 + 1), item, issue: 7, old: 'P2', value: 'P1', basis: '第二次依据' }),
    changeLine({ at: iso(T0 + 2), item, issue: 7, old: 'P1', value: 'P0', basis: '第三次依据' }),
    changeLine({
      at: iso(T0 + 3),
      item,
      issue: 7,
      field: '关联 PR',
      old: '',
      value: '#4(open)',
      basis: 'link 关联 PR 文本与看板不一致',
    }),
  ].join('');
  const debounce = debounceText({
    [item]: hold('P3'),
  });
  const view = viewPrio(fresh({ changes, debounce }));
  const row = view.rows.find((entry) => entry.item === item);
  assert.ok(row);
  assert.equal(row.priority, 'P0');
  assert.equal(row.basis, '第三次依据');
  const line = view.lines.find((entry) => entry.startsWith(item));
  assert.match(line, /优先级 P0/);
  assert.match(line, /依据：第三次依据/);
  assert.doesNotMatch(line, /第一次依据|第二次依据|关联 PR 文本/);
});

test('#199 SC2 pendingHeld 显示待降级，变更次数达到冻结上限显示冻结', () => {
  assert.equal(FREEZE_AT_CHANGES, MAX_CHANGES_PER_HOUR);
  const pendingItem = `${REPO}#1`;
  const frozenItem = `${REPO}#2`;
  const bothItem = `${REPO}#3`;
  const changes = [
    T0 - 4000,
    T0 - 3000,
    T0 - 2000,
    T0 - 1000,
  ];
  assert.equal(changes.length, FREEZE_AT_CHANGES);
  const debounce = debounceText({
    [pendingItem]: hold('P1', { pending: 'P3', pendingHeld: true, lastRecalcAt: T0, consecutive: 1 }),
    [frozenItem]: hold('P0', { changes }),
    [bothItem]: hold('P1', { pending: 'P2', pendingHeld: true, lastRecalcAt: T0, consecutive: 1, changes }),
    [`${REPO}#4`]: hold('P2', { changes: changes.slice(1) }),
  });
  const view = viewPrio(fresh({ debounce }));
  const pending = view.rows.find((entry) => entry.item === pendingItem);
  const frozen = view.rows.find((entry) => entry.item === frozenItem);
  const both = view.rows.find((entry) => entry.item === bothItem);
  const under = view.rows.find((entry) => entry.item === `${REPO}#4`);
  assert.equal(pending.priority, 'P1');
  assert.equal(pending.pendingHeld, true);
  assert.match(view.lines.find((entry) => entry.startsWith(pendingItem)), /待降级到 P3（演练）/);
  assert.doesNotMatch(view.lines.find((entry) => entry.startsWith(pendingItem)), /冻结/);
  assert.equal(frozen.frozen, true);
  assert.match(view.lines.find((entry) => entry.startsWith(frozenItem)), /冻结（1 小时内 4 次，约 12:59 解冻）/);
  assert.doesNotMatch(view.lines.find((entry) => entry.startsWith(frozenItem)), /待降级/);
  assert.match(view.lines.find((entry) => entry.startsWith(bothItem)), /冻结（1 小时内 4 次，约 12:59 解冻）/);
  assert.match(view.lines.find((entry) => entry.startsWith(bothItem)), /待降级到 P2（演练）/);
  assert.equal(under.frozen, false);
  assert.equal(both.pending, 'P2');
});

test('#199 冻结按 1 小时窗口计数，过窗的旧时间戳不算', () => {
  const staleItem = `${REPO}#21`;
  const threeItem = `${REPO}#22`;
  const fourItem = `${REPO}#23`;
  const staleChanges = [
    T0 - CHANGE_WINDOW_MS,
    T0 - CHANGE_WINDOW_MS - 1,
    T0 - CHANGE_WINDOW_MS - 2,
    T0 - CHANGE_WINDOW_MS - 3,
  ];
  const three = [T0 - 3000, T0 - 2000, T0 - 1000];
  const four = [T0 - 50 * 60 * 1000, T0 - 40 * 60 * 1000, T0 - 20 * 60 * 1000, T0 - 5 * 60 * 1000];
  const debounce = debounceText({
    [staleItem]: hold('P1', { changes: staleChanges }),
    [threeItem]: hold('P1', { changes: three }),
    [fourItem]: hold('P0', { changes: four }),
  });
  const view = viewPrio(fresh({ debounce, runLog: runHeader(T0, 'apply', 3) }));
  const staleLine = view.lines.find((entry) => entry.startsWith(staleItem));
  const threeLine = view.lines.find((entry) => entry.startsWith(threeItem));
  const fourLine = view.lines.find((entry) => entry.startsWith(fourItem));
  assert.equal(view.rows.find((entry) => entry.item === staleItem).frozen, false);
  assert.doesNotMatch(staleLine, /冻结/);
  assert.equal(view.rows.find((entry) => entry.item === threeItem).frozen, false);
  assert.doesNotMatch(threeLine, /冻结/);
  assert.equal(view.rows.find((entry) => entry.item === fourItem).frozen, true);
  assert.match(fourLine, /冻结（1 小时内 4 次，约 12:10 解冻）/);
});

test('#199 SC3 changes.jsonl 一行坏 JSON：其余照常输出，并提示坏数据，不抛错', () => {
  const first = `${REPO}#11`;
  const second = `${REPO}#12`;
  const changes = [
    changeLine({ item: first, issue: 11, value: 'P1', basis: '还在' }),
    '{this is not json\n',
    changeLine({ item: second, issue: 12, value: 'P3', basis: '也在' }),
  ].join('');
  const view = viewPrio(fresh({ changes }));
  assert.equal(view.rows.find((entry) => entry.item === first).priority, 'P1');
  assert.equal(view.rows.find((entry) => entry.item === first).basis, '还在');
  assert.equal(view.rows.find((entry) => entry.item === second).priority, 'P3');
  assert.equal(view.rows.find((entry) => entry.item === second).basis, '也在');
  assert.ok(view.lines.includes('变更日志有 1 行坏数据'));
  assert.equal(view.notices.filter((entry) => entry === '变更日志有 1 行坏数据').length, 1);
});

test('#199 SC4 运行头超过停更阈值才出红条，恰好等于阈值不报', () => {
  assert.equal(DEFAULT_STALE_MS, 10 * 60 * 1000);
  const earlier = T0 - 60 * 60 * 1000;
  const runLog = [
    runHeader(earlier, 'dry-run', 2),
    `${REPO}#1 优先级 （空） → P2 依据：低置信记 P2\n`,
    'dry-run：2 条，变更 2，写入 0，钉住 0\n',
    `${iso(T0 + 30 * 60 * 1000)} 这不是运行头\n`,
    runHeader(T0, 'apply', 2),
    '写入：2 条，变更 0，写入 0，钉住 0\n',
  ].join('');
  const at = (delta, extra = {}) => viewPrio(fresh({ runLog, nowMs: T0 + delta, ...extra }));
  const same = at(DEFAULT_STALE_MS);
  assert.equal(same.stale, false);
  assert.equal(same.lastRunAt, iso(T0));
  assert.equal(same.lines.some((entry) => entry.includes('停更')), false);
  const under = at(DEFAULT_STALE_MS - 1);
  assert.equal(under.stale, false);
  assert.equal(under.lines.some((entry) => entry.includes('停更')), false);
  const over = at(DEFAULT_STALE_MS + 1);
  assert.equal(over.stale, true);
  assert.equal(over.lastRunAt, iso(T0));
  assert.match(over.lines[0], /^停更红条：最近运行头 2026-10-31T12:00:00.000Z$/);
  const customSame = at(30_000, { staleAfterMs: 30_000 });
  const customOver = at(30_001, { staleAfterMs: 30_000 });
  assert.equal(customSame.stale, false);
  assert.equal(customOver.stale, true);
  const none = viewPrio(fresh({ runLog: '没有运行头\n', nowMs: T0 }));
  assert.equal(none.stale, true);
  assert.equal(none.lastRunAt, null);
  assert.match(none.lines[0], /^停更红条：没有运行头$/);
});

test('#199 SC5 没有延迟样本时 p50/p95 为无数据；20 个样本与手算一致', () => {
  const empty = viewPrio(fresh({ latency: '' }));
  assert.equal(empty.latency.p50, null);
  assert.equal(empty.latency.p95, null);
  assert.equal(empty.latency.n, 0);
  assert.match(empty.lines.find((entry) => entry.startsWith('关联 PR 延迟')), /p50 无数据/);
  assert.match(empty.lines.find((entry) => entry.startsWith('关联 PR 延迟')), /p95 无数据/);

  const omitted = viewPrio({ nowMs: T0, runLog: runHeader(T0) });
  assert.match(omitted.lines.find((entry) => entry.startsWith('关联 PR 延迟')), /p50 无数据 p95 无数据/);

  // 最近秩：下标 = ceil(p * n) - 1。n = 20，值 1000..20000。
  // p50：ceil(10) - 1 = 9 → 10000。p95：ceil(19) - 1 = 18 → 19000。
  let latency = '';
  for (let i = 1; i <= 20; i += 1) latency += latencyLine(i * 1000, `d${i}`);
  latency += `${JSON.stringify({
    deliveryId: 'give-up',
    event: 'pull_request',
    failures: 5,
    error: '正文被省略',
    outcome: '放弃',
    processedAt: iso(T0),
    source: 'worker',
  })}\n`;
  latency += 'not-json\n';
  latency += latencyLine(null, 'null-ms');
  const view = viewPrio(fresh({ latency }));
  assert.equal(view.latency.n, 20);
  assert.equal(view.latency.p50, 10000);
  assert.equal(view.latency.p95, 19000);
  assert.match(view.lines.find((entry) => entry.startsWith('关联 PR 延迟')), /p50 10000 p95 19000/);

  const onlyNull = viewPrio(fresh({ latency: latencyLine(null, 'only-null') }));
  assert.equal(onlyNull.latency.n, 0);
  assert.equal(onlyNull.latency.p50, null);
  assert.match(onlyNull.lines.find((entry) => entry.startsWith('关联 PR 延迟')), /p50 无数据 p95 无数据/);
});

test('#199 SC6 200 条 item 在 5 秒内返回', () => {
  let changes = '';
  const items = {};
  for (let i = 1; i <= 200; i += 1) {
    const item = `${REPO}#${i}`;
    changes += changeLine({ item, issue: i, value: i % 4 === 0 ? 'P0' : 'P2', basis: `依据 ${i}` });
    items[item] = hold('P2');
  }
  const started = Date.now();
  const view = viewPrio(fresh({ changes, debounce: debounceText(items) }));
  const elapsed = Date.now() - started;
  assert.equal(view.rows.length, 200);
  assert.ok(elapsed < 5000, `elapsed ${elapsed}`);
  assert.equal(view.rows[0].item, `${REPO}#1`);
  assert.equal(view.rows.find((entry) => entry.item === `${REPO}#4`).priority, 'P0');
});

test('#199 SC7 模块不 import 网络或文件模块、不读 process.env，输出不含令牌样式', () => {
  const source = fs.readFileSync(new URL('./bin/prio-view.mjs', import.meta.url), 'utf8');
  const imports = source.match(/^import\s.+$/gm) || [];
  assert.deepEqual(imports, ["import { CHANGE_WINDOW_MS, MAX_CHANGES_PER_HOUR } from './prio-score.mjs';"]);
  assert.doesNotMatch(source, /\brequire\s*\(/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /node:https|node:http|node:net|node:dns|node:fs|node:child_process/);
  assert.doesNotMatch(source, /from ['"]fs['"]|from ['"]https['"]|from ['"]http['"]|from ['"]net['"]/);
  assert.doesNotMatch(source, /gh[pousr]_[A-Za-z0-9]{20,}/);
  assert.doesNotMatch(source, /github_pat_/);
  assert.doesNotMatch(source, /GITHUB_TOKEN/);
  assert.doesNotMatch(source, /GH_TOKEN/);
  assert.doesNotMatch(source, /\/Users\/[A-Za-z0-9._-]+/);
  assert.equal(source.includes(['Praise', 'Zhu'].join('')), false);
  assert.equal(source.includes(HERE), false);

  const token = ['ghp', 'b'.repeat(24)].join('_');
  const pat = ['github', 'pat', 'c'.repeat(22)].join('_');
  const view = viewPrio(fresh({
    changes: changeLine({ item: `${REPO}#9`, issue: 9, value: 'P1', basis: `夹了 ${token}` }),
    reminded: remindedLine({ item: `${REPO}#9`, kind: 'manual', field: '优先级', target: 'P0', text: pat }),
  }));
  const blob = JSON.stringify(view);
  assert.equal(blob.includes(token), false);
  assert.equal(blob.includes(pat), false);
  assert.match(view.rows[0].basis, /\[redacted\]/);
  assert.deepEqual(view.rows[0].reminders, ['优先级（目标 P0）：[redacted]']);
});

test('#199 提醒按 reminded.jsonl 的 text 挂到对应 item，坏行不抛错', () => {
  const item = `${REPO}#8`;
  const reminded = [
    remindedLine({ item, kind: 'stale', text: '还要不要' }),
    '{bad\n',
    remindedLine({
      item,
      kind: 'manual',
      field: '优先级',
      target: 'P0',
      text: '手动值与规则不一致，提醒一次',
    }),
  ].join('');
  const view = viewPrio(fresh({
    reminded,
    debounce: '{',
  }));
  const line = view.lines.find((entry) => entry.startsWith(item));
  assert.match(line, /依据：（无）/);
  assert.match(line, /提醒：还要不要；优先级（目标 P0）：手动值与规则不一致，提醒一次/);
  assert.ok(view.lines.includes('提醒记录有 1 行坏数据'));
  assert.ok(view.lines.includes('防抖状态不是合法 JSON'));
  assert.equal(view.rows[0].priority, null);
});

test('#199 apply 的待降级不标演练；没有依据写（无）；按仓库和 issue 数字排序', () => {
  const other = 'example/org-b';
  const changes = [
    changeLine({ item: `${REPO}#10`, issue: 10, basis: '' }),
    changeLine({ item: `${REPO}#2`, issue: 2, basis: '有依据' }),
    changeLine({ item: `${REPO}#9`, issue: 9 }),
    changeLine({ item: `${other}#1`, issue: 1, repo: other }),
  ].join('');
  const reminded = remindedLine({
    item: `${REPO}#9`,
    kind: 'manual',
    field: '关联 PR',
    target: '#4(open)',
    text: '手动值与规则不一致，提醒一次',
  });
  const debounce = debounceText({
    [`${REPO}#2`]: hold('P1', { pending: 'P3', pendingHeld: true, lastRecalcAt: T0, consecutive: 1 }),
  });
  const view = viewPrio(fresh({
    changes,
    reminded,
    debounce,
    runLog: runHeader(T0, 'apply', 4),
  }));
  assert.deepEqual(view.rows.map((entry) => entry.item), [
    `${REPO}#2`,
    `${REPO}#9`,
    `${REPO}#10`,
    `${other}#1`,
  ]);
  const pending = view.lines.find((entry) => entry.startsWith(`${REPO}#2`));
  assert.match(pending, /待降级到 P3/);
  assert.doesNotMatch(pending, /演练/);
  assert.match(pending, /依据：有依据/);
  const emptyBasis = view.lines.find((entry) => entry.startsWith(`${REPO}#10`));
  assert.match(emptyBasis, /依据：（无）/);
  const linkReminder = view.lines.find((entry) => entry.startsWith(`${REPO}#9`));
  assert.match(linkReminder, /关联 PR（目标 #4\(open\)）：手动值与规则不一致，提醒一次/);
});
