// #233 prio-run：持续运行一拍。默认 dry-run，--write 只自动写授权仓的空 → P1/P2。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPO, tmpDir, writeSecret } from './fake-gh.fixture.mjs';
import { DOWNGRADE_MIN_GAP_MS } from './bin/prio-score.mjs';
import { PRIO_HOURLY_MAX, PRIO_HOURLY_WINDOW_MS } from './bin/prio-sync.mjs';
import { alertTextFor, main, parseMaxPerTick } from './bin/prio-run.mjs';

const T0 = Date.parse('2026-10-31T12:00:00.000Z');
const HOUR = PRIO_HOURLY_WINDOW_MS;
const SECRET = `ghp_${'a'.repeat(36)}`;
const HOST = 'build-host.example';
const COMPANY = 'ExampleCo';
const EXTERNAL = 'example-org/accepted-external';
const OTHER = 'example-org/other-sample';

function capture() {
  let out = '';
  return { stdout: { write(chunk) { out += chunk; } }, text: () => out };
}

function item(number, extra = {}) {
  return {
    repo: extra.repo || REPO,
    number,
    priority: null,
    linkedPr: '',
    labels: [],
    status: 'Todo',
    acceptance: null,
    issueState: 'open',
    issueStateKnown: true,
    lastEventAt: T0,
    lastEventKnown: true,
    repoClass: 'daily-tool',
    repoUnlisted: false,
    ...extra,
  };
}

function allow(dir, repos) {
  fs.writeFileSync(path.join(dir, 'authorized-repos.json'), `${JSON.stringify({ repos })}\n`);
}

function readAlerts(dir) {
  const file = path.join(dir, 'alerts.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function disabled(dir) {
  return fs.existsSync(path.join(dir, 'disabled'));
}

function seedChange(dir, number, value, { repo = REPO, at = T0 - 2 * HOUR } = {}) {
  fs.appendFileSync(path.join(dir, 'changes.jsonl'), `${JSON.stringify({
    at: new Date(at).toISOString(),
    item: `${repo}#${number}`,
    repo,
    issue: number,
    field: '优先级',
    old: null,
    new: value,
    basis: 'seed',
  })}\n`);
}

function seedDebounce(dir, number, state, repo = REPO) {
  fs.writeFileSync(path.join(dir, 'debounce.json'), `${JSON.stringify({
    items: { [`${repo}#${number}`]: state },
  })}\n`);
}

function confirmedDowngrade(pending) {
  return {
    priority: 'P1',
    pending,
    pendingHeld: true,
    lastRecalcAt: T0 - DOWNGRADE_MIN_GAP_MS - 60 * 1000,
    consecutive: 1,
    changes: [],
  };
}

async function run(dir, args, extra = {}) {
  const writes = [];
  const seen = { token: 0, load: 0, network: 0 };
  const io = capture();
  let stderrText = '';
  const deps = {
    capture: true,
    dir,
    stdout: io.stdout,
    stderr: { write(chunk) { stderrText += chunk; } },
    now: () => (extra.now == null ? T0 : extra.now),
    loadProfile: extra.loadProfile || (() => {
      seen.load += 1;
      return { ownerLogin: 'ExampleUser', projectNumber: 7 };
    }),
    loadItems: extra.loadItems || (async () => {
      seen.load += 1;
      return extra.items || [];
    }),
    loadPrs: async () => extra.prs || [],
    readBack: extra.readBack || (async (change) => change.new),
    write: extra.write || (async (action) => {
      writes.push(structuredClone(action));
      if (extra.onWrite) await extra.onWrite(action, writes);
    }),
    fetchImpl: async () => {
      seen.network += 1;
      throw new Error('network');
    },
    run: async () => {
      seen.network += 1;
      throw new Error('network');
    },
  };
  if (extra.realToken) deps.tokenPath = extra.tokenPath;
  else {
    deps.readToken = extra.readToken || (() => {
      seen.token += 1;
      return 'test-token-not-real';
    });
  }
  if (extra.sync) deps.sync = extra.sync;
  const result = await main(['--state-dir', dir, ...args], deps);
  return { result, writes, io, stderrText, seen };
}

function fills(count, extra = {}) {
  return Array.from({ length: count }, (_, index) => item(index + 1, extra));
}

test('#233 SC1 disabled 存在时 0 次写入，dry-run 照跑并打印已停写，退出码 0', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'disabled'), '');
  allow(dir, [REPO]);
  const { result, writes, io, seen } = await run(dir, ['--write'], { items: fills(2) });
  assert.equal(result.exitCode, 0);
  assert.equal(writes.length, 0);
  assert.equal(seen.token, 0, '已停写不再读令牌');
  assert.match(io.text(), /已停写/);
  assert.match(io.text(), /优先级 （空） → P2/);
  assert.match(io.text(), /写入 0/);
});

test('#233 SC1 本拍中途出现 disabled，剩下的条目不写，退出码 0', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const { result, writes } = await run(dir, ['--write'], {
    items: fills(3),
    onWrite: async (_action, done) => {
      if (done.length === 1) fs.writeFileSync(path.join(dir, 'disabled'), '人停的\n');
    },
  });
  assert.equal(writes.length, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop, 'disabled');
  assert.equal(readAlerts(dir).length, 0);
});

test('#233 SC2 计划 11 条只写前 10 条，余下的留到下一拍', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const first = await run(dir, ['--write', '--max-per-tick', '10'], { items: fills(11) });
  assert.equal(first.result.exitCode, 0);
  assert.deepEqual(first.writes.map((action) => action.issue), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(disabled(dir), false);
  const secondItems = fills(11).map((entry) => (
    entry.number <= 10 ? { ...entry, priority: 'P2' } : entry
  ));
  const second = await run(dir, ['--write', '--max-per-tick', '10'], { items: secondItems });
  assert.deepEqual(second.writes.map((action) => action.issue), [11]);
});

test('#233 SC2 恰好 10 条全写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const { writes, result } = await run(dir, ['--write'], { items: fills(10) });
  assert.equal(writes.length, 10);
  assert.equal(result.exitCode, 0);
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
});

test('#233 SC2 1 条正常写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const { writes, result } = await run(dir, ['--write'], { items: fills(1) });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].fields, { 优先级: 'P2' });
  assert.equal(result.exitCode, 0);
  assert.equal(disabled(dir), false);
});

test('#233 SC2 上限为 0、负数、非整数或大于 1000 时在读令牌前报错，信息含期望和实际值', async () => {
  assert.equal(parseMaxPerTick('1000'), 1000);
  assert.equal(parseMaxPerTick(10), 10);
  const cases = ['0', '-2', '1.5', '10.5', '1001', 'abc', '+10'];
  for (const raw of cases) {
    const dir = tmpDir();
    const { result, seen, stderrText } = await run(dir, ['--write', '--max-per-tick', raw], {
      items: fills(1),
    });
    assert.equal(result.exitCode, 1, raw);
    assert.match(result.error.message, /期望 1 到 1000 的整数/);
    assert.match(result.error.message, new RegExp(`实际：${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(stderrText, /实际：/);
    assert.equal(seen.token, 0, raw);
    assert.equal(seen.load, 0, raw);
    assert.equal(seen.network, 0, raw);
    assert.equal(disabled(dir), false);
  }
});

test('#233 SC3 已写 50 条时第 51 条不写，并自动停写告警', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  for (let i = 0; i < PRIO_HOURLY_MAX; i += 1) {
    seedChange(dir, 1000 + i, 'P2', { at: T0 - 60 * 1000 });
  }
  const { writes, result } = await run(dir, ['--write'], { items: fills(1) });
  assert.equal(writes.length, 0);
  assert.equal(result.stop, 'hourly');
  assert.equal(disabled(dir), true);
  const [alert] = readAlerts(dir);
  assert.equal(alert.kind, 'prio-hourly');
  assert.match(alert.text, /没有新的写入/);
  assert.match(alert.text, /需要人/);
});

test('#233 SC3 恰好第 50 条允许写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  for (let i = 0; i < PRIO_HOURLY_MAX - 1; i += 1) {
    seedChange(dir, 1000 + i, 'P2', { at: T0 - 60 * 1000 });
  }
  const { writes, result } = await run(dir, ['--write'], { items: fills(1) });
  assert.equal(writes.length, 1);
  assert.equal(result.exitCode, 0);
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
});

test('#233 SC3 窗口滑出 1 小时后恢复计数', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  for (let i = 0; i < PRIO_HOURLY_MAX; i += 1) {
    seedChange(dir, 1000 + i, 'P2', { at: T0 - HOUR });
  }
  const { writes, result } = await run(dir, ['--write'], { items: fills(1) });
  assert.equal(writes.length, 1, '恰好满 1 小时的旧行不再计数');
  assert.equal(disabled(dir), false);
  assert.equal(result.stop, '');

  const still = tmpDir();
  allow(still, [REPO]);
  for (let i = 0; i < PRIO_HOURLY_MAX; i += 1) {
    seedChange(still, 1000 + i, 'P2', { at: T0 - HOUR + 1 });
  }
  const blocked = await run(still, ['--write'], { items: fills(1) });
  assert.equal(blocked.writes.length, 0);
  assert.equal(disabled(still), true);
});

test('#233 SC4 计划含降级或改空则本拍 0 写入，自动停写并告警', async () => {
  const dir = tmpDir();
  allow(dir, [EXTERNAL]);
  seedChange(dir, 2, 'P1', { repo: EXTERNAL });
  seedDebounce(dir, 2, confirmedDowngrade('P2'), EXTERNAL);
  const { writes, result } = await run(dir, ['--write'], {
    items: [
      item(1, { repo: EXTERNAL }),
      item(2, { repo: EXTERNAL, priority: 'P1' }),
    ],
  });
  assert.equal(writes.length, 0);
  assert.equal(result.stop, 'downgrade');
  assert.equal(disabled(dir), true);
  const [alert] = readAlerts(dir);
  assert.equal(
    alert.text,
    '看板优先级自动写入已暂停：有 1 条要把 P1 改成 P2（降级），按规则不自动写。看板没有被改动。需要人看一下这条是否该改，确认后删除停写开关即可恢复。',
  );
  assert.equal(alert.text.includes(EXTERNAL), false);
  assert.equal(alert.text.includes(SECRET), false);
  assert.equal(alert.text.includes(HOST), false);
  assert.equal(alert.text.includes(COMPANY), false);

  const clearDir = tmpDir();
  allow(clearDir, [REPO]);
  seedChange(clearDir, 1, 'P1');
  seedDebounce(clearDir, 1, confirmedDowngrade(null));
  const cleared = await run(clearDir, ['--write'], {
    items: [item(1, { priority: 'P1', issueState: 'closed' })],
  });
  assert.equal(cleared.writes.length, 0);
  assert.equal(cleared.result.stop, 'downgrade');
  assert.equal(disabled(clearDir), true);
  assert.match(readAlerts(clearDir)[0].text, /改空/);
  assert.match(readAlerts(clearDir)[0].text, /看板没有被改动/);
  assert.match(readAlerts(clearDir)[0].text, /需要人/);
});

test('#233 SC4 升级不自动写只告警；同一拍空到 P2 照写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  seedChange(dir, 2, 'P2');
  const { writes, result } = await run(dir, ['--write'], {
    items: [
      item(1),
      item(2, { priority: 'P2', labels: ['影响发布'], repoClass: 'mivo' }),
    ],
  });
  assert.deepEqual(writes.map((action) => action.issue), [1]);
  assert.deepEqual(writes[0].fields, { 优先级: 'P2' });
  assert.equal(disabled(dir), false);
  assert.equal(result.stop, 'nonempty');
  const [alert] = readAlerts(dir);
  assert.equal(alert.kind, 'prio-nonempty');
  assert.match(alert.text, /不自动写/);
  assert.match(alert.text, /没有被改动/);
  assert.match(alert.text, /需要人确认/);
  assert.equal(alert.text.includes(REPO), false);
});

test('#233 SC5 白名单外字段或 exclude 档出现在计划里时本拍 0 写入并自动停写告警', async () => {
  const table = { mivo: [], idle: [], 'daily-tool': [], exclude: ['example-org/excluded-repo'] };
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'repo-class.json'), `${JSON.stringify(table)}\n`);
  allow(dir, [REPO, 'example-org/excluded-repo']);
  const plan = [
    {
      item: 'example-org/excluded-repo#1',
      repo: 'example-org/excluded-repo',
      issue: 1,
      field: '优先级',
      old: null,
      new: 'P2',
    },
    { item: `${REPO}#2`, repo: REPO, issue: 2, field: '优先级', old: null, new: 'P2' },
  ];
  const excluded = await run(dir, ['--write'], {
    sync: async (opts) => {
      const gate = await opts.onPlan(plan);
      if (!gate.abort) await opts.write({ fields: { 优先级: 'P2' } });
      return {
        written: 0,
        aborted: Boolean(gate.abort),
        readbacks: [],
        readbackMismatch: null,
        stoppedByDisabled: false,
        outOfScopeHit: null,
        skippedAuto: [],
        plan,
      };
    },
  });
  assert.equal(excluded.writes.length, 0);
  assert.equal(excluded.result.stop, 'out-of-scope');
  assert.equal(disabled(dir), true);
  const [alert] = readAlerts(dir);
  assert.match(alert.text, /白名单以外|排除档/);
  assert.match(alert.text, /看板没有被改动/);
  assert.match(alert.text, /需要人/);
  assert.equal(alert.text.includes('example-org/excluded-repo'), false);

  const fieldDir = tmpDir();
  allow(fieldDir, [REPO]);
  const fieldPlan = [
    { item: `${REPO}#1`, repo: REPO, issue: 1, field: '状态', old: null, new: 'Done' },
    { item: `${REPO}#2`, repo: REPO, issue: 2, field: '优先级', old: null, new: 'P2' },
  ];
  const field = await run(fieldDir, ['--write'], {
    sync: async (opts) => {
      const gate = await opts.onPlan(fieldPlan);
      if (!gate.abort) await opts.write({ fields: { 优先级: 'P2' } });
      return {
        written: 0,
        aborted: Boolean(gate.abort),
        readbacks: [],
        readbackMismatch: null,
        stoppedByDisabled: false,
        outOfScopeHit: null,
        skippedAuto: [],
        plan: fieldPlan,
      };
    },
  });
  assert.equal(field.writes.length, 0);
  assert.equal(field.result.stop, 'out-of-scope');
  assert.equal(disabled(fieldDir), true);
});

test('#233 SC5 没有 mac-mini-stopped 时关联 PR 只扣住，不算异常也不写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const prs = [{
    repo: REPO,
    number: 9,
    title: 'fix',
    body: 'Closes #1\n',
    state: 'open',
    ci: 'pass',
    headRefName: 'fix',
  }];
  const { writes, io, result } = await run(dir, ['--write'], { items: [item(1)], prs });
  assert.equal(writes.some((action) => Object.keys(action.fields).includes('关联 PR')), false);
  assert.equal(writes.some((action) => action.fields['优先级'] === 'P2'), true);
  assert.match(io.text(), /不写关联 PR/);
  assert.match(io.text(), /扣住/);
  assert.equal(disabled(dir), false);
  assert.equal(result.stop, '');
  assert.equal(readAlerts(dir).length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'mac-mini-stopped')), false);

  const marked = tmpDir();
  allow(marked, [REPO]);
  fs.writeFileSync(path.join(marked, 'mac-mini-stopped'), '');
  const held = await run(marked, ['--write'], { items: [item(1)], prs });
  assert.equal(held.writes.some((action) => Object.hasOwn(action.fields, '关联 PR')), false);
  assert.equal(held.writes.length, 1);
  assert.equal(disabled(marked), false);
  assert.equal(readAlerts(marked).length, 0);
});

test('#233 SC6 回读不一致立刻停止余下写入，自动停写告警，不重试', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  let reads = 0;
  const { writes, result } = await run(dir, ['--write'], {
    items: fills(2),
    readBack: async (change) => {
      reads += 1;
      return change.issue === 1 ? 'P0' : change.new;
    },
  });
  assert.equal(writes.length, 1);
  assert.equal(reads, 1);
  assert.equal(result.stop, 'readback');
  assert.equal(disabled(dir), true);
  const [alert] = readAlerts(dir);
  assert.match(alert.text, /读回来的值和要写的不一致/);
  assert.match(alert.text, /没有自动重试/);
  assert.match(alert.text, /需要人/);
  assert.equal(alert.text.includes(REPO), false);
});

test('#233 SC7 告警只写 alerts.jsonl，文案说清三件事，且不含令牌、主机名、公司名、外部仓全名', () => {
  const text = alertTextFor('downgrade', {
    downgrades: [{ kind: 'downgrade', change: { old: 'P1', new: 'P2', repo: EXTERNAL, basis: `${SECRET} ${HOST} ${COMPANY}` } }],
  });
  assert.match(text, /已暂停/);
  assert.match(text, /看板没有被改动/);
  assert.match(text, /需要人/);
  assert.equal(text.includes(SECRET), false);
  assert.equal(text.includes(HOST), false);
  assert.equal(text.includes(COMPANY), false);
  assert.equal(text.includes(EXTERNAL), false);
  const source = fs.readFileSync(fileURLToPath(new URL('./bin/prio-run.mjs', import.meta.url)), 'utf8');
  assert.equal(/slack/i.test(source), false);
  assert.equal(source.includes('alerts.jsonl'), true);
});

test('#233 SC8 令牌缺失、为空或权限过宽时，在网络请求前报错，0 写入，信息不含令牌内容', async () => {
  const missingDir = tmpDir();
  allow(missingDir, [REPO]);
  const missingPath = path.join(missingDir, 'no-such-token');
  const missing = await run(missingDir, ['--write'], {
    realToken: true,
    tokenPath: missingPath,
    items: fills(1),
  });
  assert.equal(missing.result.exitCode, 1);
  assert.equal(missing.writes.length, 0);
  assert.equal(missing.seen.network, 0);
  assert.equal(missing.seen.load, 0);
  assert.match(missing.result.error.message, /不存在/);
  assert.equal(missing.result.error.message.includes(SECRET), false);
  assert.equal(missing.stderrText.includes(SECRET), false);

  const emptyDir = tmpDir();
  allow(emptyDir, [REPO]);
  const emptyPath = path.join(emptyDir, 'empty-token');
  writeSecret(emptyPath, '');
  const empty = await run(emptyDir, ['--write'], {
    realToken: true,
    tokenPath: emptyPath,
    items: fills(1),
  });
  assert.equal(empty.result.exitCode, 1);
  assert.equal(empty.writes.length, 0);
  assert.equal(empty.seen.network, 0);
  assert.match(empty.result.error.message, /为空/);

  const blankDir = tmpDir();
  allow(blankDir, [REPO]);
  const blankPath = path.join(blankDir, 'blank-token');
  writeSecret(blankPath, '   \n');
  const blank = await run(blankDir, ['--write'], {
    realToken: true,
    tokenPath: blankPath,
    items: fills(1),
  });
  assert.equal(blank.result.exitCode, 1);
  assert.match(blank.result.error.message, /空/);
  assert.equal(blank.result.error.message.includes(SECRET), false);
  assert.equal(blank.seen.network, 0);

  const wideDir = tmpDir();
  allow(wideDir, [REPO]);
  const widePath = path.join(wideDir, 'wide-token');
  writeSecret(widePath, `${SECRET}\n`);
  fs.chmodSync(widePath, 0o644);
  const wide = await run(wideDir, ['--write'], {
    realToken: true,
    tokenPath: widePath,
    items: fills(1),
  });
  assert.equal(wide.result.exitCode, 1);
  assert.equal(wide.writes.length, 0);
  assert.equal(wide.seen.network, 0);
  assert.equal(wide.seen.load, 0);
  assert.match(wide.result.error.message, /600/);
  assert.match(wide.result.error.message, /644/);
  assert.equal(wide.result.error.message.includes(SECRET), false);
  assert.equal(wide.stderrText.includes(SECRET), false);
});

test('#233 SC8 GitHub 返回 NOT_FOUND 或 5xx 时本拍不写并记一条告警，不满 3 拍不停写', async () => {
  for (const message of ['NOT_FOUND', 'HTTP 503', 'HTTP 500']) {
    const dir = tmpDir();
    allow(dir, [REPO]);
    const { result, writes } = await run(dir, ['--write'], {
      loadItems: async () => {
        throw new Error(`${message} ${SECRET} ${HOST} ${COMPANY} ${EXTERNAL}`);
      },
    });
    assert.equal(result.exitCode, 1, message);
    assert.equal(writes.length, 0, message);
    assert.equal(disabled(dir), false, message);
    const [alert] = readAlerts(dir);
    assert.equal(alert.kind, 'prio-github');
    assert.match(alert.text, /没有继续写/);
    assert.match(alert.text, /先不用处理/);
    assert.equal(alert.text.includes(SECRET), false, message);
    assert.equal(alert.text.includes(HOST), false, message);
    assert.equal(alert.text.includes(COMPANY), false, message);
    assert.equal(alert.text.includes(EXTERNAL), false, message);
  }
});

test('#233 SC8 连续 3 拍失败后自动停写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const fail = () => run(dir, ['--write'], {
    loadItems: async () => {
      throw new Error(`HTTP 502 ${SECRET}`);
    },
  });
  const first = await fail();
  const second = await fail();
  assert.equal(disabled(dir), false);
  assert.equal(first.result.streak, 1);
  assert.equal(second.result.streak, 2);
  const third = await fail();
  assert.equal(third.result.streak, 3);
  assert.equal(third.result.stop, 'github-paused');
  assert.equal(disabled(dir), true);
  const rows = readAlerts(dir);
  assert.equal(rows.length, 3);
  assert.match(rows[2].text, /连续 3 拍/);
  assert.match(rows[2].text, /需要人/);
  assert.equal(rows.some((row) => row.text.includes(SECRET)), false);
});

test('#233 SC9 不在授权清单的仓只 dry-run，清单内的空到 P2 会写', async () => {
  const dir = tmpDir();
  allow(dir, ['example-org/sample-repo']);
  const { writes, result } = await run(dir, ['--write'], {
    items: [
      item(1, { repo: 'example-org/sample-repo' }),
      item(2, { repo: OTHER }),
    ],
  });
  assert.deepEqual(writes.map((action) => action.repo), ['example-org/sample-repo']);
  assert.equal(disabled(dir), false);
  assert.equal(result.stop, '');
  assert.equal(writes.some((action) => action.repo === OTHER), false);

  const empty = tmpDir();
  const none = await run(empty, ['--write'], { items: fills(1) });
  assert.equal(none.writes.length, 0);
  assert.equal(disabled(empty), false);
});

test('#233 SC9 文档包含两段上线、回滚和授权清单写法', () => {
  const doc = fs.readFileSync(new URL('../../docs/acceptance-operations.md', import.meta.url), 'utf8');
  assert.match(doc, /## 13\. prio 持续运行/);
  assert.match(doc, /--dry-run/);
  assert.match(doc, /24 小时/);
  assert.match(doc, /未接入、不适用/);
  assert.match(doc, /touch <state-dir>\/disabled/);
  assert.match(doc, /--restore/);
  assert.match(doc, /authorized-repos\.json/);
  assert.match(doc, /example-org\/sample-repo/);
  assert.match(doc, /不安装/);
  assert.match(doc, /alerts\.jsonl/);
  const run = fs.readFileSync(fileURLToPath(new URL('./bin/prio-run.mjs', import.meta.url)), 'utf8');
  assert.equal(/crontab|\/etc\/cron/.test(run), false);
});

test('#233 SC10 prio-run 与 doctor 不写 crontab', () => {
  const files = [
    new URL('./bin/prio-run.mjs', import.meta.url),
    new URL('./bin/doctor.mjs', import.meta.url),
    new URL('./deploy-ff.mjs', import.meta.url),
  ];
  for (const file of files) {
    const source = fs.readFileSync(fileURLToPath(file), 'utf8');
    assert.equal(/crontab|\/etc\/cron|systemctl/.test(source), false, file.pathname);
  }
});

test('#233 默认 dry-run 不读令牌也不写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const { writes, seen, result, io } = await run(dir, [], { items: fills(1) });
  assert.equal(writes.length, 0);
  assert.equal(seen.token, 0);
  assert.equal(result.exitCode, 0);
  assert.match(io.text(), /dry-run：/);
  assert.equal(disabled(dir), false);
});

test('#240 SC7 prio-run 默认 dry-run 不改 debounce.json，跑前跑后 sha256 相同', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const file = path.join(dir, 'debounce.json');
  const absent = 'example-owner/other-repo#99';
  const body = `${JSON.stringify({
    items: {
      [absent]: {
        priority: 'P1',
        pending: 'P2',
        pendingHeld: true,
        lastRecalcAt: T0,
        consecutive: 1,
        changes: [],
      },
      [`${REPO}#1`]: {
        priority: null,
        pending: null,
        pendingHeld: false,
        lastRecalcAt: null,
        consecutive: 0,
        changes: [],
      },
    },
  })}\n`;
  fs.writeFileSync(file, body);
  const before = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const { writes, result } = await run(dir, [], { items: fills(1, { labels: ['blocker'] }) });
  const after = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(writes.length, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(after, before, '跑前跑后 sha256 相同');
  assert.equal(fs.readFileSync(file, 'utf8'), body);

  const empty = tmpDir();
  allow(empty, [REPO]);
  const missing = path.join(empty, 'debounce.json');
  await run(empty, [], { items: fills(1) });
  assert.equal(fs.existsSync(missing), false);
});
