// #205 board-live 只读节。夹具行格式与 prio-sync / prio-view 一致。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PRIO_BOARD_FIELDS } from './bin/github.mjs';
import { renderPrioBoardSection } from './bin/prio-board-section.mjs';
import { CHANGE_WINDOW_MS } from './bin/prio-score.mjs';
import { tmpDir } from './fake-gh.fixture.mjs';

const TITLE = '### 看板优先级（只读）';
const OPEN_REPO = 'example/open-repo';
const CLOSED_REPO = 'example/closed-repo';
const EXCLUDED_REPO = 'example/excluded-repo';
const NOW = Date.parse('2026-11-01T20:13:00.000Z');

function changeLine({ item, issue, repo, value = 'P2', basis = '情形档 P2', field = '优先级' }) {
  return `${JSON.stringify({
    at: '2026-11-01T20:00:00.000Z',
    item,
    repo,
    issue,
    field,
    old: null,
    new: value,
    basis,
  })}\n`;
}

function runHeader(ms, mode = 'dry-run', count = 1) {
  return `${new Date(ms).toISOString()} ${mode} ${count}\n`;
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function writeRun(dir, ms, text) {
  fs.writeFileSync(path.join(dir, `run-${utcDay(ms)}.log`), text);
}

function render(dir, extra = {}) {
  return renderPrioBoardSection({ stateDir: dir, nowMs: NOW, ...extra });
}

function linesOf(text) {
  return text.split('\n');
}

test('#205 SC1 正常数据：标题、数据源、两条 item、延迟行在最后，且没有停更红条', () => {
  const dir = tmpDir();
  const first = `${OPEN_REPO}#1`;
  const second = `${OPEN_REPO}#2`;
  fs.writeFileSync(path.join(dir, 'changes.jsonl'), [
    changeLine({ item: first, issue: 1, repo: OPEN_REPO, value: 'P1', basis: '第一条依据' }),
    changeLine({ item: second, issue: 2, repo: OPEN_REPO, value: 'P3', basis: '第二条依据' }),
  ].join(''));
  fs.writeFileSync(path.join(dir, 'latency.jsonl'), `${JSON.stringify({ latencyMs: 1200 })}\n${JSON.stringify({ latencyMs: 3400 })}\n`);
  writeRun(dir, NOW - 3 * 60 * 1000, runHeader(NOW - 3 * 60 * 1000, 'apply', 2));
  const text = render(dir);
  const lines = linesOf(text);
  assert.equal(lines[0], TITLE);
  assert.match(lines[1], /^数据源：.+｜取数时间：.+/);
  const items = lines.filter((line) => line.includes('优先级') && line.includes('依据'));
  assert.equal(items.length, 2);
  assert.match(items[0], /优先级/);
  assert.match(items[0], /依据/);
  assert.match(text, /第一条依据/);
  assert.match(text, /第二条依据/);
  assert.match(lines.at(-1), /^关联 PR 延迟 p50 .+ p95 .+/);
  assert.equal(text.includes('停更红条'), false);
});

test('#205 SC2 已关闭和排除表里的 item 不出现，并写已隐藏计数', () => {
  const dir = tmpDir();
  const openItem = `${OPEN_REPO}#3`;
  const closedItem = `${CLOSED_REPO}#4`;
  const excludedItem = `${EXCLUDED_REPO}#5`;
  fs.writeFileSync(path.join(dir, 'changes.jsonl'), [
    changeLine({ item: closedItem, issue: 4, repo: CLOSED_REPO, basis: '已关闭依据' }),
    changeLine({ item: excludedItem, issue: 5, repo: EXCLUDED_REPO, basis: '已排除依据' }),
    changeLine({ item: openItem, issue: 3, repo: OPEN_REPO, value: 'P0', basis: '正常依据' }),
  ].join(''));
  fs.writeFileSync(path.join(dir, 'repo-class.json'), `${JSON.stringify({ exclude: [EXCLUDED_REPO] })}\n`);
  writeRun(dir, NOW - 3 * 60 * 1000, runHeader(NOW - 3 * 60 * 1000));
  const text = render(dir, {
    items: [{ repo: CLOSED_REPO, number: 4, issueState: 'closed' }],
  });
  const items = linesOf(text).filter((line) => line.includes('优先级') && line.includes('依据'));
  assert.deepEqual(items.map((line) => line.startsWith(openItem)), [true]);
  assert.equal(text.includes(closedItem), false);
  assert.equal(text.includes(excludedItem), false);
  assert.equal(text.includes('已关闭依据'), false);
  assert.equal(text.includes('已排除依据'), false);
  assert.match(text, /正常依据/);
  assert.ok(linesOf(text).includes('已隐藏：已关闭 1、已排除 1'));
});

test('#205 SC3 跨 UTC 日拼接运行日志；两天都没有运行头时视图第一行是停更红条', () => {
  const now = Date.parse('2026-11-01T00:03:00.000Z');
  const recent = now - 4 * 60 * 1000;
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'changes.jsonl'), changeLine({
    item: `${OPEN_REPO}#1`,
    issue: 1,
    repo: OPEN_REPO,
  }));
  writeRun(dir, recent, runHeader(recent));
  fs.writeFileSync(path.join(dir, `run-${utcDay(now)}.log`), '');
  const fresh = renderPrioBoardSection({ stateDir: dir, nowMs: now });
  assert.equal(fresh.includes('停更红条'), false);
  assert.equal(utcDay(recent) !== utcDay(now), true);

  const empty = tmpDir();
  fs.writeFileSync(path.join(empty, 'changes.jsonl'), '');
  const text = renderPrioBoardSection({ stateDir: empty, nowMs: now });
  const lines = linesOf(text);
  assert.equal(lines[0], TITLE);
  assert.match(lines[1], /^数据源：.+｜取数时间：.+/);
  assert.equal(lines[2], '停更红条：没有运行头');
});

test('#205 SC4 目录缺失、空变更日志、坏行都不抛错', () => {
  const missing = renderPrioBoardSection({
    stateDir: path.join(tmpDir(), 'missing-prio'),
    nowMs: NOW,
  });
  assert.equal(missing, `${TITLE}\nprio 状态目录读不到，其余部分照常`);

  const emptyDir = tmpDir();
  fs.writeFileSync(path.join(emptyDir, 'changes.jsonl'), '');
  writeRun(emptyDir, NOW - 60 * 1000, runHeader(NOW - 60 * 1000));
  const empty = render(emptyDir);
  assert.equal(linesOf(empty).filter((line) => line.includes('优先级') && line.includes('依据')).length, 0);
  assert.match(empty, /关联 PR 延迟/);

  const badDir = tmpDir();
  const kept = `${OPEN_REPO}#8`;
  fs.writeFileSync(path.join(badDir, 'changes.jsonl'), [
    changeLine({ item: kept, issue: 8, repo: OPEN_REPO, value: 'P1', basis: '还在' }),
    '{this is not json\n',
  ].join(''));
  writeRun(badDir, NOW - 60 * 1000, runHeader(NOW - 60 * 1000));
  const bad = render(badDir);
  assert.match(bad, /变更日志有 1 行坏数据/);
  assert.match(bad, new RegExp(kept.replaceAll('/', '\\/')));
  assert.match(bad, /还在/);
  assert.match(bad, /关联 PR 延迟/);
});

test('#205 SC5 50MB 变更日志只读末尾 2MB，渲染时间与内存在限额内', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'changes.jsonl');
  const fd = fs.openSync(file, 'w');
  const head = Buffer.from(`${JSON.stringify({
    item: 'example/head#1',
    field: '优先级',
    new: 'P0',
    basis: 'HEADMARKER',
  })}\n`);
  fs.writeSync(fd, head);
  const line = `${JSON.stringify({
    item: 'example/pad#1',
    field: '优先级',
    new: 'P3',
    basis: 'pad',
  })}\n`;
  const batch = Buffer.from(line.repeat(2000));
  const target = 50 * 1024 * 1024;
  let written = head.length;
  while (written < target) {
    fs.writeSync(fd, batch);
    written += batch.length;
  }
  const tail = Buffer.from(`${JSON.stringify({
    item: 'example/tail#2',
    field: '优先级',
    new: 'P1',
    basis: 'TAILMARKER',
  })}\n`);
  fs.writeSync(fd, tail);
  fs.closeSync(fd);
  assert.ok(fs.statSync(file).size >= target);
  writeRun(dir, NOW - 60 * 1000, runHeader(NOW - 60 * 1000));

  const before = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  const text = render(dir);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const delta = process.memoryUsage().heapUsed - before;
  assert.ok(elapsedMs < 1000, `elapsed ${elapsedMs}`);
  assert.ok(delta < 64 * 1024 * 1024, `delta ${delta}`);
  assert.match(text, /变更日志过大，只读最近 2MB/);
  assert.equal(text.includes('HEADMARKER'), false);
  assert.match(text, /TAILMARKER/);
});

test('#205 SC6 目录型文件与读时 EACCES 都降级，不抛错，页面其他节还在', () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, 'changes.jsonl'));
  writeRun(dir, NOW - 60 * 1000, runHeader(NOW - 60 * 1000));
  const page = ['### 本机', '本机内容'];
  let section = '';
  assert.doesNotThrow(() => {
    section = render(dir);
  });
  page.push(section, '### 其他');
  const text = page.join('\n');
  assert.match(text, /本机内容/);
  assert.match(text, /### 其他/);
  assert.match(section, /读不到 changes\.jsonl/);
  assert.equal(section.includes(dir), false);

  const denied = tmpDir();
  const calls = [];
  const mock = {
    statSync(file) {
      calls.push('statSync');
      if (file === denied) return { isDirectory: () => true, size: 0 };
      return { isDirectory: () => false, size: 4 };
    },
    readFileSync() {
      calls.push('readFileSync');
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
    openSync() {
      calls.push('openSync');
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
    readSync() {
      calls.push('readSync');
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
  };
  const deniedText = renderPrioBoardSection({ stateDir: denied, nowMs: NOW, fs: mock });
  assert.match(deniedText, /读不到 changes\.jsonl/);
  assert.match(deniedText, /读不到 reminded\.jsonl/);
  assert.equal(deniedText.includes(denied), false);
  assert.ok(calls.includes('readFileSync'));
});

test('#205 SC7 注入的 fs 只有读调用，目录内容不被改写', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'changes.jsonl'), changeLine({
    item: `${OPEN_REPO}#1`,
    issue: 1,
    repo: OPEN_REPO,
  }));
  writeRun(dir, NOW - 60 * 1000, runHeader(NOW - 60 * 1000));
  const before = snapshot(dir);
  const calls = [];
  const allowed = new Set(['statSync', 'readFileSync', 'readdirSync', 'openSync', 'readSync', 'closeSync']);
  const recording = {};
  for (const name of allowed) {
    recording[name] = (...args) => {
      calls.push(name);
      return fs[name](...args);
    };
  }
  const text = renderPrioBoardSection({ stateDir: dir, nowMs: NOW, fs: recording });
  assert.match(text, /优先级/);
  assert.ok(calls.length > 0);
  assert.ok(calls.includes('readFileSync') || calls.includes('readSync'));
  for (const name of calls) assert.equal(allowed.has(name), true, name);
  assert.deepEqual(snapshot(dir), before);

  const source = fs.readFileSync(new URL('./bin/prio-board-section.mjs', import.meta.url), 'utf8');
  assert.deepEqual(source.match(/^import\s.+$/gm), [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { formatPrioClock, viewPrio } from './prio-view.mjs';",
  ]);
  assert.doesNotMatch(source, /writeFile|appendFile|createWriteStream|\bunlink\b|rename\(|rmSync|\bmkdir\b|copyFile|truncateSync|truncate\(|\bchmod\b|chown|utimes|symlink|linkSync|spawn|execFile|exec\(|fork\(/);
  assert.equal(source.includes('node:fs/promises'), false);
  assert.equal(source.includes('.promises'), false);
});

test('#205 SC8 令牌样式变成 [redacted]，模块不读环境变量、不联网、不碰写闸', () => {
  const source = fs.readFileSync(new URL('./bin/prio-board-section.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|node:(?:http|https|net)|fetch\(|createPriorityGithub|write-gate/);
  assert.equal(PRIO_BOARD_FIELDS.size, 2);
  assert.equal(PRIO_BOARD_FIELDS.has('优先级'), true);
  assert.equal(PRIO_BOARD_FIELDS.has('关联 PR'), true);

  const token = 'ghp' + '_' + 'a'.repeat(36);
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'changes.jsonl'), changeLine({
    item: `${OPEN_REPO}#9`,
    issue: 9,
    repo: OPEN_REPO,
    basis: `依据里夹了 ${token}`,
  }));
  writeRun(dir, NOW - 60 * 1000, runHeader(NOW - 60 * 1000));
  const text = render(dir);
  assert.equal(text.includes(token), false);
  assert.match(text, /\[redacted\]/);
});

test('#205 SC9 解冻时刻和运行头按太平洋时间显示，PST/PDT 不写死', () => {
  const instant = Date.parse('2026-11-01T20:10:00.000Z');
  const winter = tmpDir();
  writeRun(winter, instant, runHeader(instant, 'apply', 1));
  fs.writeFileSync(path.join(winter, 'changes.jsonl'), changeLine({
    item: `${OPEN_REPO}#1`,
    issue: 1,
    repo: OPEN_REPO,
    basis: '冬季依据',
  }));
  const winterText = renderPrioBoardSection({ stateDir: winter, nowMs: instant + 3 * 60 * 1000 });
  assert.match(winterText, /最近运行：12:10 PST/);
  assert.equal(winterText.includes('2026-11-01T20:10:00.000Z'), false);
  assert.equal(winterText.includes('停更红条'), false);

  const oldest = instant - CHANGE_WINDOW_MS;
  const freezeDir = tmpDir();
  const freezeItem = `${OPEN_REPO}#6`;
  const changes = [0, 10, 20, 40].map((minutes) => oldest + minutes * 60 * 1000);
  fs.writeFileSync(path.join(freezeDir, 'debounce.json'), `${JSON.stringify({
    items: {
      [freezeItem]: {
        priority: 'P0',
        pending: null,
        pendingHeld: false,
        lastRecalcAt: null,
        consecutive: 0,
        changes,
      },
    },
  })}\n`);
  writeRun(freezeDir, oldest, runHeader(oldest));
  const freezeText = renderPrioBoardSection({ stateDir: freezeDir, nowMs: instant - 60 * 1000 });
  assert.match(freezeText, /约 12:10 PST 解冻/);

  const summerAt = Date.parse('2026-07-01T19:10:00.000Z');
  const summer = tmpDir();
  writeRun(summer, summerAt, runHeader(summerAt));
  fs.writeFileSync(path.join(summer, 'changes.jsonl'), '');
  const summerText = renderPrioBoardSection({ stateDir: summer, nowMs: summerAt + 3 * 60 * 1000 });
  assert.match(summerText, /最近运行：12:10 PDT/);
  assert.equal(summerText.includes('12:10 PST'), false);
});

test('#205 停更阈值默认 10 分钟，传入 staleAfterMs 可以改', () => {
  const dir = tmpDir();
  const headerAt = NOW - 11 * 60 * 1000;
  writeRun(dir, headerAt, runHeader(headerAt));
  fs.writeFileSync(path.join(dir, 'changes.jsonl'), '');
  assert.match(render(dir), /停更红条/);
  const widened = render(dir, { staleAfterMs: 20 * 60 * 1000 });
  assert.equal(widened.includes('停更红条'), false);
});

test('#205 冻结、待降级和提醒出现在对应 item 行', () => {
  const dir = tmpDir();
  const pendingItem = `${OPEN_REPO}#1`;
  const remindItem = `${OPEN_REPO}#2`;
  fs.writeFileSync(path.join(dir, 'changes.jsonl'), [
    changeLine({ item: pendingItem, issue: 1, repo: OPEN_REPO, value: 'P1', basis: '待降依据' }),
    changeLine({ item: remindItem, issue: 2, repo: OPEN_REPO, value: 'P2', basis: '提醒依据' }),
  ].join(''));
  fs.writeFileSync(path.join(dir, 'debounce.json'), `${JSON.stringify({
    items: {
      [pendingItem]: {
        priority: 'P1',
        pending: 'P3',
        pendingHeld: true,
        lastRecalcAt: NOW,
        consecutive: 1,
        changes: [],
      },
    },
  })}\n`);
  fs.writeFileSync(path.join(dir, 'reminded.jsonl'), `${JSON.stringify({
    at: '2026-11-01T20:00:00.000Z',
    item: remindItem,
    kind: 'stale',
    text: '还要不要',
  })}\n`);
  writeRun(dir, NOW - 60 * 1000, runHeader(NOW - 60 * 1000, 'dry-run', 2));
  const text = render(dir);
  assert.match(text, /待降级到 P3（演练）/);
  assert.match(text, /提醒：还要不要/);
});

function snapshot(dir) {
  const out = {};
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    out[name] = stat.isDirectory() ? 'dir' : fs.readFileSync(file).toString('utf8');
  }
  return out;
}
