// #233 prio-run：持续运行一拍。默认 dry-run，--write 只自动写授权仓的空 → P1/P2。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPO, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';
import { DOWNGRADE_MIN_GAP_MS } from './bin/prio-score.mjs';
import { ONLY_FIELD_NAMES, PRIO_HOURLY_MAX, PRIO_HOURLY_WINDOW_MS } from './bin/prio-sync.mjs';
import { ALERT_DEDUPE_HOURS_DEFAULT, alertTextFor, hostFilesFromEnv, main, parseAlertDedupeHours, parseMaxPerTick, parsePrioRunArgs } from './bin/prio-run.mjs';
import { hostPaths, tryAcquireLock } from './host/paths.mjs';

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

/** 锁内对照读返回 old，写后回读再走 onReadback（缺省返回 new）。 */
function phasedReadBack(onReadback) {
  const counts = new Map();
  return async (change) => {
    const key = `${change.item}\0${change.field}`;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n === 1) return change.old;
    return onReadback ? onReadback(change) : change.new;
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
    readBack: extra.readBack || phasedReadBack(),
    lockPath: extra.lockPath || path.join(dir, 'prio-write.lock'),
    lockOptions: extra.lockOptions,
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
    readBack: phasedReadBack((change) => {
      reads += 1;
      return change.issue === 1 ? 'P0' : change.new;
    }),
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

test('#240 SC1 prio-run 在 disabled 存在时跑一拍，debounce.json 跑前跑后 sha256 相同', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'disabled'), '');
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
  const { writes, result, io } = await run(dir, [], { items: fills(1, { labels: ['blocker'] }) });
  const after = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  assert.equal(writes.length, 0);
  assert.equal(result.exitCode, 0);
  assert.match(io.text(), /已停用：/);
  assert.equal(after, before, '跑前跑后 sha256 相同');
  assert.equal(fs.readFileSync(file, 'utf8'), body);
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

// ── #247 SC2：看板每拍只整板读一次，dry-run、写入、仓外读者共用一份快照 ──

const BOARD_ITEMS_MARK = 'projectV2(number: $projectNumber)';
const PR_SEARCH_MARK = 'search(query: $query, type: ISSUE';

function boardNode(number, { repo = REPO, id = `PVTI_${number}` } = {}) {
  return {
    id,
    isArchived: false,
    updatedAt: '2026-10-31T10:00:00.000Z',
    content: {
      __typename: 'Issue',
      number,
      state: 'OPEN',
      updatedAt: '2026-10-31T10:00:00.000Z',
      repository: { nameWithOwner: repo },
      labels: { nodes: [] },
    },
    fieldValues: { nodes: [] },
  };
}

/** 真走 gh 通道的假 run：记下每次整板查询与 PR 搜索，看板条目按注入的节点返回。 */
function boardRun({ nodes = [boardNode(1), boardNode(2)], prNodes = [] } = {}) {
  const calls = [];
  const run = async (cmd, args, { input } = {}) => {
    calls.push({ cmd, args, input });
    const payload = JSON.parse(input || '{}');
    const query = String(payload.query || '');
    if (query.includes(BOARD_ITEMS_MARK)) {
      return {
        code: 0,
        stdout: JSON.stringify({
          data: {
            user: {
              projectV2: {
                items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
              },
            },
          },
        }),
        stderr: '',
      };
    }
    if (query.includes(PR_SEARCH_MARK)) {
      return {
        code: 0,
        stdout: JSON.stringify({ data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: prNodes } } }),
        stderr: '',
      };
    }
    return { code: 1, stdout: '', stderr: `unexpected query: ${query.slice(0, 40)}` };
  };
  run.calls = calls;
  run.boardCalls = () => calls.filter((call) => String(JSON.parse(call.input || '{}').query || '').includes(BOARD_ITEMS_MARK)).length;
  return run;
}

function boardSetup() {
  const { home, profile } = writeProfile(tmpDir());
  const dir = tmpDir();
  return {
    dir,
    profile,
    snapshotFile: path.join(home, 'state', 'host', 'board-snapshot.json'),
    rateFile: path.join(home, 'state', 'host', 'rate-budget.json'),
    budgetFile: path.join(home, 'config', 'rate-budget.json'),
  };
}

function boardDeps(world, ghRun, extra = {}) {
  return {
    capture: true,
    dir: world.dir,
    stdout: capture().stdout,
    stderr: { write() {} },
    now: () => (extra.now == null ? T0 : extra.now),
    loadProfile: () => world.profile,
    snapshotFile: world.snapshotFile,
    rateFile: world.rateFile,
    budgetFile: world.budgetFile,
    budgets: extra.budgets === undefined ? { loop: 500, 'prio-run': 300, 'board-live': 140 } : extra.budgets,
    tickSeconds: 180,
    readBack: extra.readBack || phasedReadBack(),
    lockPath: extra.lockPath || path.join(world.dir, 'prio-write.lock'),
    lockOptions: extra.lockOptions,
    write: extra.write || (async () => {}),
    run: ghRun,
    fetchImpl: async () => {
      throw new Error('network');
    },
  };
}

test('#247 SC2 一拍里整板只读一次：dry-run 与写入共用同一份快照', async () => {
  const world = boardSetup();
  allow(world.dir, [REPO]);
  fs.writeFileSync(path.join(world.dir, 'authorized-repos.json'), `${JSON.stringify({ repos: [REPO] })}\n`);

  const dryRun = boardRun();
  const dry = await main(['--state-dir', world.dir, '--dry-run'], boardDeps(world, dryRun));
  assert.equal(dry.exitCode, 0);
  assert.equal(dryRun.boardCalls(), 1, 'dry-run 整板读一次');
  assert.equal(dry.boardSource, 'fetched');
  const snapshot = JSON.parse(fs.readFileSync(world.snapshotFile, 'utf8'));
  assert.equal(snapshot.items.length, 2);
  assert.equal(snapshot.at, new Date(T0).toISOString());
  assert.deepEqual(Object.keys(snapshot).sort(), ['at', 'excludedCount', 'items', 'nullContent', 'version']);

  // 同一拍里的写入路径：快照还新，不再发整板查询。
  const write = boardRun();
  const written = await main(['--state-dir', world.dir, '--write'], {
    ...boardDeps(world, write),
    readToken: () => 'test-token-not-real',
  });
  assert.equal(written.exitCode, 0);
  assert.equal(write.boardCalls(), 0, '同一拍的第二条路径不再整板读');
  assert.equal(written.boardSource, 'snapshot');
});

test('#247 SC2 快照过期就重拉一次并覆盖；缺失时也重拉', async () => {
  const world = boardSetup();
  const first = boardRun({ nodes: [boardNode(1)] });
  const one = await main(['--state-dir', world.dir, '--dry-run'], boardDeps(world, first));
  assert.equal(one.exitCode, 0);
  assert.equal(first.boardCalls(), 1);

  // 过了两个拍间隔：快照过期，必须重拉并覆盖。
  const later = T0 + 2 * 180 * 1000;
  const second = boardRun({ nodes: [boardNode(1), boardNode(2)] });
  const refreshed = await main(['--state-dir', world.dir, '--dry-run'], boardDeps(world, second, { now: later }));
  assert.equal(refreshed.exitCode, 0);
  assert.equal(second.boardCalls(), 1, '过期快照不用，重拉一次');
  assert.equal(refreshed.boardSource, 'fetched');
  assert.equal(refreshed.boardSnapshotReason, 'stale');
  const snapshot = JSON.parse(fs.readFileSync(world.snapshotFile, 'utf8'));
  assert.equal(snapshot.items.length, 2, '重拉的条目覆盖了旧快照');
  assert.equal(snapshot.at, new Date(later).toISOString());

  // 快照文件被删：重拉一次，报 missing。
  fs.rmSync(world.snapshotFile);
  const third = boardRun({ nodes: [boardNode(3)] });
  const rebuilt = await main(['--state-dir', world.dir, '--dry-run'], boardDeps(world, third, { now: later + 1000 }));
  assert.equal(third.boardCalls(), 1);
  assert.equal(rebuilt.boardSnapshotReason, 'missing');
});

test('#247 SC6 剩余低于 1500：这一拍跳过看板读，不发起整板查询、不抛错、写一行「因额度跳过」', async () => {
  const world = boardSetup();
  const io = capture();
  const gh = boardRun();
  fs.mkdirSync(path.dirname(world.rateFile), { recursive: true });
  fs.writeFileSync(
    world.rateFile,
    JSON.stringify({
      version: 1,
      identities: {
        user: { identity: 'user', known: true, remaining: 1400, remainingRaw: '1400', reset: new Date(T0 + 600_000).toISOString(), at: new Date(T0).toISOString(), source: 'graphql' },
      },
      components: {},
      recovery: null,
      skips: { count: 0, lastAt: null },
    }),
  );
  const result = await main(['--state-dir', world.dir, '--dry-run'], { ...boardDeps(world, gh), stdout: io.stdout });
  assert.equal(result.exitCode, 0, '跳过不抛错、退出码还是 0');
  assert.equal(result.stop, 'rate-budget');
  assert.equal(result.skipped, 'remaining-below-1500');
  assert.equal(gh.boardCalls(), 0, '跳过了就不发整板查询');
  assert.match(io.text(), /rate-skip component=prio-run identity=user remaining=1400 action=remaining-below-1500 因额度跳过/);
});

test('#247 SC5 预算配置缺失：报可诊断错误、不按默认值猜，只走响应头闸', async () => {
  const world = boardSetup();
  const io = capture();
  const gh = boardRun();
  const result = await main(['--state-dir', world.dir, '--dry-run'], {
    ...boardDeps(world, gh, { budgets: null }),
    stdout: io.stdout,
  });
  assert.match(io.text(), /额度预算配置无法使用：读不到额度预算配置/);
  assert.match(result.budgetError, /读不到额度预算配置/);
});

// ── 复审 #247 第二轮：P1-1 状态目录、P3-6 用快照不按整板读计费 ──

test('#247 P1-1 宿主状态目录问 host/paths.mjs，不按 --state-dir 的布局猜（部署里两者不同级）', async () => {
  // 夹具按部署实况摆（rev-247b P2-A）：`run.sh` 里 home 是 `$HOME/acceptance/home`、
  // `--state-dir` 是 `$HOME/acceptance/tools/.prio`——两者是 <X>/home 与 <X>/tools/.prio，**不同级**。
  // 老推导是「--state-dir 上两级 + state/host」；若把 state-dir 放在 home 内部（<home>/tools/.prio），
  // 上两级正好等于 home，老代码与新代码得到同一组路径，用例就抓不住这个回归了。
  const base = tmpDir();
  const home = path.join(base, 'acceptance', 'home');
  const { profile } = writeProfile(home);
  const stateDir = path.join(base, 'acceptance', 'tools', '.prio');
  const paths = hostPaths(home);
  assert.notEqual(
    path.resolve(stateDir, '..', '..'),
    home,
    '夹具前提：--state-dir 上两级不是 home（部署里就是不同级），否则这条用例验不出回归',
  );
  const env = { ACCEPTANCE_WATCHER_HOME: home };
  const files = hostFilesFromEnv(env);
  assert.equal(files.hostDir, paths.hostDir, '宿主目录要和 paths.mjs 的同一个');
  assert.equal(files.boardSnapshot, paths.boardSnapshot, '快照要和仓外读者读的是同一个文件');
  assert.equal(files.rateState, paths.rateState, '额度状态要和主循环写的是同一个文件');
  assert.equal(files.rateBudgetConfig, paths.rateBudgetConfig, '预算配置要和主循环读的是同一个文件');
  assert.equal(hostFilesFromEnv({}), null, '没设 ACCEPTANCE_WATCHER_HOME 就返回 null：不猜路径');

  // 端到端：只给 env、不显式给文件时，快照与额度状态要落到 paths.boardSnapshot / paths.rateState，
  // 不能落回老推导的 <state-dir>/../state/host（那个目录没人读）。
  fs.mkdirSync(stateDir, { recursive: true });
  const gh = boardRun({ nodes: [boardNode(1), boardNode(2)] });
  const io = capture();
  const result = await main(['--state-dir', stateDir, '--dry-run'], {
    capture: true,
    dir: stateDir,
    env,
    stdout: io.stdout,
    stderr: { write() {} },
    now: () => T0,
    loadProfile: () => profile,
    budgets: { loop: 500, 'prio-run': 300, 'board-live': 140 },
    tickSeconds: 180,
    readBack: phasedReadBack(),
    lockPath: path.join(stateDir, 'prio-write.lock'),
    write: async () => {},
    run: gh,
    fetchImpl: async () => {
      throw new Error('network');
    },
  });
  assert.equal(result.exitCode, 0, io.text());
  assert.equal(fs.existsSync(paths.boardSnapshot), true, '快照要落在 <home>/state/host（仓外看板读者读这份）');
  assert.equal(fs.existsSync(paths.rateState), true, '额度状态要落在 <home>/state/host/rate-budget.json');
  const wrongDir = path.join(base, 'acceptance', 'state', 'host');
  assert.equal(fs.existsSync(path.join(wrongDir, 'board-snapshot.json')), false, '不许落回「上两级 + state/host」的老推导目录');
  assert.equal(fs.existsSync(path.join(wrongDir, 'rate-budget.json')), false, '额度状态也不许落到老推导目录');
});

test('#247 P3-6 用同一拍快照的那一次不按整板读记点数（否则会把自己提前停掉）', async () => {
  const world = boardSetup();
  const first = boardRun({ nodes: [boardNode(1)] });
  const one = await main(['--state-dir', world.dir, '--dry-run'], boardDeps(world, first));
  assert.equal(one.exitCode, 0);
  assert.equal(one.boardSource, 'fetched');
  const afterFetch = JSON.parse(fs.readFileSync(world.rateFile, 'utf8'));
  assert.equal(afterFetch.components['prio-run'].used, 8, '真发了整板读就记 8 点');

  const second = boardRun({ nodes: [boardNode(1)] });
  const two = await main(['--state-dir', world.dir, '--dry-run'], boardDeps(world, second, { now: T0 + 1000 }));
  assert.equal(two.exitCode, 0);
  assert.equal(two.boardSource, 'snapshot', '同一拍用快照');
  assert.equal(second.boardCalls(), 0, '用快照就不发整板查询');
  const afterSnapshot = JSON.parse(fs.readFileSync(world.rateFile, 'utf8'));
  assert.equal(afterSnapshot.components['prio-run'].used, 8, '没发整板读就不该再记 8 点');
});

// ── 复审 rev-258 P2-a：额度闸与快照写自己出错时 fail-open（与 loop.test.mjs 的「额度闸自己出错」对称） ──

test('#247 P2-a 额度闸自己出错（状态文件位置被目录占着）：这一拍照常跑、放行并留痕', async () => {
  const world = boardSetup();
  const io = capture();
  const gh = boardRun();
  // 状态文件位置被一个目录占着：写不进去（rename 到目录上报 EISDIR）→ 判定内部抛错。
  fs.mkdirSync(world.rateFile, { recursive: true });
  const result = await main(['--state-dir', world.dir, '--dry-run'], { ...boardDeps(world, gh), stdout: io.stdout });
  assert.equal(result.exitCode, 0, '额度闸自己出错不把这一拍弄挂');
  assert.match(String(result.gateError || ''), /EISDIR|directory|illegal/i, '返回值要能看见闸自己出错');
  assert.equal(result.stop, '', '不因为闸出错就当成「因额度跳过」');
  assert.equal(gh.boardCalls(), 1, '放行：看板照读');
  assert.match(io.text(), /rate-unknown component=prio-run identity=user remaining=unknown reason=rate-gate-error/, '要留一行可查的痕迹');
  // 痕迹也要落进这一拍的 run 日志（stdout 被 tee 进去），不然只留在终端里。
  const runLog = fs.readdirSync(world.dir).find((name) => /^run-\d{4}-\d{2}-\d{2}\.log$/.test(name));
  assert.ok(runLog, '这一拍的 run 日志要写出来');
  assert.match(fs.readFileSync(path.join(world.dir, runLog), 'utf8'), /reason=rate-gate-error/);
});

test('#247 P2-a 看板快照写不下去：这一拍照常用刚拉到的数据，只留痕', async () => {
  const world = boardSetup();
  const io = capture();
  const gh = boardRun();
  // 快照位置被一个目录占着：读到的是「坏快照」（corrupt），重拉之后写盘失败。
  fs.mkdirSync(world.snapshotFile, { recursive: true });
  const result = await main(['--state-dir', world.dir, '--dry-run'], { ...boardDeps(world, gh), stdout: io.stdout });
  assert.equal(result.exitCode, 0, '快照写不下去不把这一拍弄挂');
  assert.match(String(result.snapshotError || ''), /EISDIR|directory|illegal/i, '返回值要能看见快照写失败');
  assert.equal(gh.boardCalls(), 1, '快照坏了就重拉一次');
  assert.equal(result.boardSource, 'fetched', '这一拍用的是刚拉到的数据');
  assert.match(io.text(), /board-snapshot-error component=prio-run reason=write-failed/, '写失败要留痕');
});

// ── --only-empty-to-p2：只写「空 → P2」这一子集，其它行静默排除、不 abort、不建开关、不告警 ──

/** 按给定计划走一遍 onPlan 闸：只有 gate 说 write 的才调 opts.write。真 prio-sync 的闸语义一致。 */
function planSync(plan) {
  return async (syncOpts) => {
    const gate = await syncOpts.onPlan(plan);
    const done = [];
    if (gate && !gate.abort && typeof gate.allow === 'function') {
      for (const change of plan) {
        if (gate.allow(change) !== 'write') continue;
        await syncOpts.write({
          type: 'project.field.set',
          repo: change.repo,
          issue: change.issue,
          fields: { [change.field]: change.new },
          ref: change.item,
        });
        done.push(change);
      }
    }
    return {
      written: done.length,
      aborted: Boolean(gate?.abort),
      readbacks: [],
      readbackMismatch: null,
      stoppedByDisabled: false,
      outOfScopeHit: null,
      skippedAuto: [],
      plan,
    };
  };
}

/** 混合计划：7 条降级/清空、2 条空 → P1、2 条升级、1 条关联 PR、4 条空 → P2。 */
function mixedPlan(extra = {}) {
  const at = (number, field, oldValue, newValue, repo = REPO) => ({
    item: `${repo}#${number}`,
    repo,
    issue: number,
    field,
    old: oldValue,
    new: newValue,
  });
  return [
    at(1, '优先级', 'P1', 'P2'),
    at(2, '优先级', 'P0', 'P1'),
    at(3, '优先级', 'P2', 'P3'),
    at(4, '优先级', 'P1', 'P3'),
    at(5, '优先级', 'P1', null),
    at(6, '优先级', 'P2', null),
    at(7, '优先级', 'P0', null),
    at(8, '优先级', null, 'P1'),
    at(9, '优先级', null, 'P1'),
    at(10, '优先级', 'P2', 'P1'),
    at(11, '优先级', 'P3', 'P2'),
    at(12, '关联 PR', '', 'PR #9 ✓'),
    ...extra.emptyToP2 ?? [at(13, '优先级', null, 'P2'), at(14, '优先级', null, 'P2'), at(15, '优先级', null, 'P2'), at(16, '优先级', null, 'P2')],
  ];
}

const EXCLUDE_LINE = /按 --only-empty-to-p2 排除 12 条（降级\/清空 7、升 P1 2、空→P1 2、关联 PR 1）/;

test('#285 开关关 + 计划有降级：仍整拍停写并建开关（回归）', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const { writes, result, io } = await run(dir, ['--write'], { sync: planSync(mixedPlan()) });
  assert.equal(writes.length, 0);
  assert.equal(result.stop, 'downgrade');
  assert.equal(disabled(dir), true);
  assert.equal(readAlerts(dir).length, 1);
  assert.equal(readAlerts(dir)[0].kind, 'prio-downgrade');
  assert.equal(EXCLUDE_LINE.test(io.text()), false, '没带开关就不打排除计数');
});

test('#285 开关开 + 混合计划：只写空 → P2，不 abort、不建开关、无告警，日志有排除计数', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const plan = mixedPlan();
  const { writes, result, io } = await run(dir, ['--write', '--only-empty-to-p2', '--max-per-tick', '2'], {
    sync: planSync(plan),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(writes.map((action) => action.issue), [13, 14], '每拍上限 2 条，按仓名/issue 号取前面的');
  for (const action of writes) {
    assert.deepEqual(action.fields, { 优先级: 'P2' });
  }
  assert.equal(result.stop, '');
  assert.equal(disabled(dir), false, '不建停写开关');
  assert.equal(readAlerts(dir).length, 0, '不发 prio-downgrade / prio-nonempty');
  assert.match(io.text(), EXCLUDE_LINE);
  assert.equal(/prio-downgrade|prio-nonempty/.test(io.text()), false);

  // 同一份计划把每拍上限放到 10：4 条空 → P2 全写，其它行一条也不写。
  const wide = tmpDir();
  allow(wide, [REPO]);
  const all = await run(wide, ['--write', '--only-empty-to-p2', '--max-per-tick', '10'], {
    sync: planSync(mixedPlan()),
  });
  assert.deepEqual(all.writes.map((action) => action.issue), [13, 14, 15, 16]);
  assert.equal(disabled(wide), false);
  assert.equal(readAlerts(wide).length, 0);
  assert.match(all.io.text(), EXCLUDE_LINE);
});

test('#285 开关开 + 计划里一条空 → P2 都没有：写 0 条且正常退出', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const plan = mixedPlan({ emptyToP2: [] });
  const { writes, result, io } = await run(dir, ['--write', '--only-empty-to-p2'], { sync: planSync(plan) });
  assert.equal(writes.length, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop, '');
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
  assert.match(io.text(), /按 --only-empty-to-p2 排除 12 条/);
  assert.match(io.text(), /关联 PR 1/);
});

test('#285 disabled 存在时即使带开关也不写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'disabled'), '');
  const { writes, result, io } = await run(dir, ['--write', '--only-empty-to-p2'], {
    sync: planSync(mixedPlan()),
  });
  assert.equal(writes.length, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop, 'disabled');
  assert.match(io.text(), /已停写/);
  assert.equal(readAlerts(dir).length, 0);
});

test('#285 不在 authorized-repos 的空 → P2 不写，也不算被开关排除', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const plan = [
    { item: `${REPO}#1`, repo: REPO, issue: 1, field: '优先级', old: null, new: 'P2' },
    { item: `${OTHER}#2`, repo: OTHER, issue: 2, field: '优先级', old: null, new: 'P2' },
    { item: `${OTHER}#3`, repo: OTHER, issue: 3, field: '优先级', old: null, new: 'P1' },
  ];
  const { writes, result, io } = await run(dir, ['--write', '--only-empty-to-p2'], { sync: planSync(plan) });
  assert.deepEqual(writes.map((action) => action.repo), [REPO]);
  assert.equal(disabled(dir), false);
  assert.equal(result.stop, '');
  assert.match(io.text(), /按 --only-empty-to-p2 排除 1 条（降级\/清空 0、升 P1 0、空→P1 1、关联 PR 0）/);
});

test('#285 dry-run + 开关：一条都不写、不建开关、不告警，日志写明会写哪几条和排除分类', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const { writes, result, io } = await run(dir, ['--dry-run', '--only-empty-to-p2', '--max-per-tick', '10'], {
    sync: planSync(mixedPlan()),
  });
  assert.equal(writes.length, 0);
  assert.equal(result.exitCode, 0);
  assert.equal(disabled(dir), false, 'dry-run 遇降级也不建停写开关');
  assert.equal(readAlerts(dir).length, 0);
  assert.match(io.text(), EXCLUDE_LINE);
  assert.match(io.text(), /按 --only-empty-to-p2 会写 4 条：/);
  assert.match(io.text(), /#13 优先级 空 → P2/);
});

test('#285 开关开 + 最近 1 小时已满：仍按每小时上限停写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  for (let i = 0; i < PRIO_HOURLY_MAX; i += 1) {
    seedChange(dir, 1000 + i, 'P2', { at: T0 - 60 * 1000 });
  }
  const { writes, result } = await run(dir, ['--write', '--only-empty-to-p2'], { sync: planSync(mixedPlan()) });
  assert.equal(writes.length, 0);
  assert.equal(result.stop, 'hourly');
  assert.equal(disabled(dir), true);
  assert.equal(readAlerts(dir)[0].kind, 'prio-hourly');
});

test('#285 参数解析：--only-empty-to-p2 缺省关、重复传仍是开、可与既有参数同用', () => {
  const base = parsePrioRunArgs([]);
  assert.equal(base.onlyEmptyToP2, false, '缺省关');
  assert.deepEqual(base, { write: false, dryRun: false, onlyEmptyToP2: false, stateDir: null, maxPerTick: null, alertsFile: null });

  const once = parsePrioRunArgs([
    '--dry-run', '--only-empty-to-p2', '--max-per-tick', '10', '--state-dir', '/tmp/example-state',
  ]);
  assert.equal(once.onlyEmptyToP2, true);
  assert.equal(once.dryRun, true);
  assert.equal(once.maxPerTick, '10');
  assert.equal(once.stateDir, '/tmp/example-state');

  const twice = parsePrioRunArgs(['--write', '--only-empty-to-p2', '--only-empty-to-p2']);
  assert.equal(twice.onlyEmptyToP2, true, '重复传是幂等的');
  assert.equal(twice.write, true);
  assert.throws(() => parsePrioRunArgs(['--only-empty-to-p2=x']), /无法识别的参数/);
});

test('#285 授权仓 16 条空 → P2：每拍只写 10 条，且是排序后的前 10 条', async () => {
  const dir = tmpDir();
  const second = 'example-org/accepted-two';
  allow(dir, [REPO, second]);
  // 输入顺序故意打乱（先大号、两仓交替），证明写的是按仓名/issue 号排完序的前 10 条，不是计划里的前 10 条。
  const inputOrder = [9, 2, 12, 5, 1, 11, 7, 3, 15, 4, 10, 16, 6, 13, 8, 14];
  const plan = inputOrder.map((number) => {
    const repo = number % 2 === 0 ? second : REPO;
    return { item: `${repo}#${number}`, repo, issue: number, field: '优先级', old: null, new: 'P2' };
  });
  const { writes, result, io } = await run(dir, ['--write', '--only-empty-to-p2', '--max-per-tick', '10'], {
    sync: planSync(plan),
  });
  assert.equal(writes.length, 10, '每拍上限 10 条，计划里 16 条也只写 10 条');
  // 名额按仓名（小写）、issue 号排完再取前 10 条：example-org/accepted-two 的 8 条偶数号在前，
  // 再是 example-owner/example-repo 的 #1、#3。写调用本身的顺序跟计划顺序（prio-sync 按计划遍历），
  // 所以这里比集合，不比调用先后。
  assert.deepEqual(writes.map((action) => `${action.repo}#${action.issue}`).sort(), [
    `${second}#2`, `${second}#4`, `${second}#6`, `${second}#8`, `${second}#10`,
    `${second}#12`, `${second}#14`, `${second}#16`, `${REPO}#1`, `${REPO}#3`,
  ].sort());
  const written = new Set(writes.map((action) => `${action.repo}#${action.issue}`));
  assert.deepEqual(
    plan.map((change) => change.item).filter((item) => !written.has(item)).sort(),
    [`${REPO}#5`, `${REPO}#7`, `${REPO}#9`, `${REPO}#11`, `${REPO}#13`, `${REPO}#15`].sort(),
    '剩下的 6 条留给下一拍',
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop, '');
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
  assert.match(io.text(), /按 --only-empty-to-p2 排除 0 条（降级\/清空 0、升 P1 0、空→P1 0、关联 PR 0）/);
});

/** 假看板：优先级、关联 PR 都是可变值。写调用会真的改这份数据，好查「被排除的条目一条都没动」。 */
function boardSync(plan, board) {
  const rowOf = (item) => board.find((entry) => `${entry.repo}#${entry.number}` === item);
  return async (syncOpts) => {
    const gate = await syncOpts.onPlan(plan);
    const done = [];
    if (gate && !gate.abort && typeof gate.allow === 'function') {
      for (const change of plan) {
        if (gate.allow(change) !== 'write') continue;
        await syncOpts.write({
          type: 'project.field.set',
          dedupeKey: `prio:${change.item}:${change.field}:${change.old}:${change.new}`,
          itemId: change.itemId,
          repo: change.repo,
          issue: change.issue,
          fields: { [change.field]: change.new },
          ref: change.item,
        });
        const row = rowOf(change.item);
        if (!row) throw new Error(`假看板里没有 ${change.item}`);
        if (change.field === '优先级') row.priority = change.new;
        else row.linkedPr = change.new;
        done.push(change.item);
      }
    }
    return {
      written: done.length,
      aborted: Boolean(gate?.abort),
      readbacks: [],
      readbackMismatch: null,
      stoppedByDisabled: false,
      outOfScopeHit: null,
      skippedAuto: [],
      plan,
    };
  };
}

test('#285 被排除的条目一条都不动：看板上的优先级/关联 PR 写前写后完全相同', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const at = (number, field, oldValue, newValue, { repo = REPO, itemId = `PVTI_${number}`, boardValue = oldValue } = {}) => ({
    change: { item: `${repo}#${number}`, repo, issue: number, field, old: oldValue, new: newValue, itemId },
    board: {
      repo,
      number,
      priority: field === '优先级' ? boardValue : 'P2',
      linkedPr: field === '关联 PR' ? boardValue : '',
    },
  });
  const rows = [
    at(1, '优先级', 'P1', 'P2', { itemId: 'PVTI_1' }), // 降级
    at(2, '优先级', 'P2', null, { itemId: 'PVTI_2' }), // 改空
    at(3, '优先级', 'P2', 'P1', { itemId: 'PVTI_3' }), // 升级
    at(4, '优先级', null, 'P1', { itemId: 'PVTI_4' }), // 空 → P1
    at(5, '关联 PR', '', 'PR #9 ✓', { itemId: 'PVTI_5' }), // 关联 PR
    at(6, '优先级', null, 'P2', { repo: OTHER, itemId: 'PVTI_6' }), // 非授权仓的空 → P2
    at(7, '优先级', null, 'P2', { itemId: 'PVTI_7' }), // 授权仓空 → P2：这一条要真写
  ];
  const plan = rows.map((row) => row.change);
  const board = rows.map((row) => row.board);
  const excluded = plan.slice(0, 6);
  const before = structuredClone(board);

  const { writes, result } = await run(dir, ['--write', '--only-empty-to-p2'], {
    sync: boardSync(plan, board),
  });
  assert.deepEqual(writes.map((action) => action.itemId).sort(), ['PVTI_7'], '只写授权仓的那条空 → P2');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop, '');
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);

  const touched = new Set(writes.flatMap((action) => [action.itemId, action.ref, action.repo && `${action.repo}#${action.issue}`]));
  for (const change of excluded) {
    assert.equal(touched.has(change.itemId), false, `${change.item} 不该出现在写调用里`);
    assert.equal(touched.has(change.item), false, `${change.item} 不该出现在写调用里`);
    assert.equal(
      writes.some((action) => action.repo === change.repo && action.issue === change.issue),
      false,
      `${change.item} 不该出现在写调用里`,
    );
  }
  // 假看板上真写了的那条变了，被排除的 6 条按字段逐条对比：写前写后完全一样。
  assert.equal(board[6].priority, 'P2', '授权仓的空 → P2 真写了（证明这份假看板会跟着写调用变）');
  for (const [index, entry] of board.entries()) {
    const label = `${entry.repo}#${entry.number}`;
    if (index === 6) continue;
    assert.equal(entry.priority, before[index].priority, `${label} 的优先级不该变`);
    assert.equal(entry.linkedPr, before[index].linkedPr, `${label} 的关联 PR 不该变`);
  }
  assert.deepEqual(
    board.filter((_entry, index) => index !== 6),
    before.filter((_entry, index) => index !== 6),
    '被排除的 6 条整条记录写前写后完全相同',
  );
});

// ── #279 --only-field：只写一个字段；只有「关联 PR」时持续模式才放行 link ──

function changeRows(dir) {
  const file = path.join(dir, 'changes.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function closingPr(number, issue) {
  return {
    repo: REPO,
    number,
    title: 'fix',
    body: `Closes #${issue}\n`,
    state: 'open',
    ci: 'pass',
    headRefName: 'fix',
  };
}

test('SC1 --only-field 优先级 时只写优先级，link 记 skip', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  // 计划里有 2 条空 → P2 和 1 条关联 PR：只带 --only-field 优先级 时，link 那条不写、不进 changes.jsonl。
  const { writes, result } = await run(dir, ['--write', '--only-field', '优先级'], {
    items: [item(1), item(2)],
    prs: [closingPr(9, 1)],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(writes.length, 2, '写入条数等于优先级变更数');
  for (const action of writes) assert.deepEqual(action.fields, { 优先级: 'P2' });
  assert.deepEqual(
    [...new Set(changeRows(dir).map((row) => row.field))],
    ['优先级'],
    'changes.jsonl 只出现优先级行',
  );
  assert.equal(result.result.filteredByField, 1, 'link 那条按字段过滤掉，没进写闸');
  const { assessment } = result;
  assert.equal(
    assessment.allow({ item: `${REPO}#1`, repo: REPO, issue: 1, field: '关联 PR', old: '', new: '#9(open,CI✓)' }),
    'skip',
    'link 记 skip',
  );
  assert.equal(
    assessment.allow({ item: `${REPO}#1`, repo: REPO, issue: 1, field: '优先级', old: null, new: 'P2' }),
    'write',
  );
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
});

test('SC2 --only-field 关联 PR 时 link 放行并逐条回读', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const reads = [];
  const { writes, result, io } = await run(dir, ['--write', '--only-field', '关联 PR'], {
    items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2' })],
    prs: [closingPr(9, 1), closingPr(10, 2)],
    readBack: phasedReadBack((change) => {
      reads.push({ item: change.item, field: change.field, itemId: change.itemId });
      return change.new;
    }),
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(writes.map((action) => action.fields), [
    { '关联 PR': '#9(open,CI✓)' },
    { '关联 PR': '#10(open,CI✓)' },
  ]);
  assert.deepEqual(writes.map((action) => action.itemId), ['PVTI_1', 'PVTI_2']);
  assert.equal(reads.length, writes.length, '每条写完都回读一次');
  assert.deepEqual(reads.map((row) => row.field), ['关联 PR', '关联 PR']);
  assert.deepEqual(reads.map((row) => row.itemId), ['PVTI_1', 'PVTI_2'], '按 itemId 回读该字段');
  assert.deepEqual(changeRows(dir).map((row) => row.field), ['关联 PR', '关联 PR']);
  assert.equal(result.stop, '');
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
  assert.equal(/扣住|不写关联 PR/.test(io.text()), false, '放行后不再打扣住那行');
  assert.equal(io.text().includes('排除优先级侧降级'), false, '没有降级时不打排除计数');
});

test('SC3 关联 PR 回读不一致立刻停写并告警', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const reads = [];
  const { writes, result } = await run(dir, ['--write', '--only-field', '关联 PR'], {
    items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2' })],
    prs: [closingPr(9, 1), closingPr(10, 2)],
    readBack: phasedReadBack((change) => {
      reads.push(change.item);
      return change.issue === 1 ? '#9(open)' : change.new;
    }),
  });
  assert.deepEqual(writes.map((action) => action.itemId), ['PVTI_1'], '第一条写完就停，余下的不写');
  assert.deepEqual(reads, [`${REPO}#1`], '只回读了一条，没有重试');
  assert.equal(result.stop, 'readback');
  assert.equal(disabled(dir), true);
  const [alert] = readAlerts(dir);
  assert.equal(alert.kind, 'prio-readback');
  assert.match(alert.text, /读回来的值和要写的不一致/);
  assert.match(alert.text, /没有自动重试/);
  assert.equal(alert.text.includes(REPO), false);

  // 下一拍仍停在 disabled 上：余下的那条不补写。
  const next = await run(dir, ['--write', '--only-field', '关联 PR'], {
    items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2' })],
    prs: [closingPr(9, 1), closingPr(10, 2)],
  });
  assert.equal(next.writes.length, 0);
  assert.equal(next.result.stop, 'disabled');
});

test('SC4 关联 PR 写入仍受每小时 50 条限制', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  for (let i = 0; i < PRIO_HOURLY_MAX - 1; i += 1) {
    seedChange(dir, 1000 + i, 'P2', { at: T0 - 60 * 1000 });
  }
  // 第 1 条只有空 → P2（不在放行字段里），后两条是关联 PR：本拍只剩 1 个名额，写第 1 条 link，下一条不写。
  const { writes, result } = await run(dir, ['--write', '--only-field', '关联 PR'], {
    items: [item(1), item(2, { id: 'PVTI_2' }), item(3, { id: 'PVTI_3' })],
    prs: [closingPr(9, 2), closingPr(10, 3)],
  });
  assert.equal(writes.length, 1, '窗口里已 49 条，这一拍只写 1 条');
  assert.deepEqual(writes[0].fields, { '关联 PR': '#9(open,CI✓)' });
  assert.equal(result.stop, 'hourly');
  assert.equal(disabled(dir), true);
  const [alert] = readAlerts(dir);
  assert.equal(alert.kind, 'prio-hourly');
  assert.match(alert.text, /只写到上限为止/);
  const rows = changeRows(dir);
  assert.equal(rows.length, PRIO_HOURLY_MAX - 1 + 1, 'changes.jsonl 只多了写进去的那 1 条');
  assert.deepEqual(rows.filter((row) => row.field === '关联 PR').map((row) => row.item), [`${REPO}#2`]);
});

test('SC5 未知字段名 fail-closed，在读令牌前退出', async () => {
  assert.deepEqual(ONLY_FIELD_NAMES, ['关联 PR', '优先级']);
  assert.equal(parsePrioRunArgs(['--only-field', '优先级']).onlyField, '优先级');
  assert.equal(parsePrioRunArgs(['--only-field', '关联 PR']).onlyField, '关联 PR');
  assert.equal(parsePrioRunArgs([]).onlyField ?? null, null, '不带时行为不变');

  const allowed = /--only-field 期望「关联 PR」或「优先级」，实际：/;
  const unknown = ['验收', '状态', '', '   ', '优先级 ', ' 优先级', '优先级,关联 PR', 'PRIORITY'];
  for (const value of unknown) {
    const shown = value === '' ? '（空）' : value;
    assert.throws(() => parsePrioRunArgs(['--only-field', value]), allowed, JSON.stringify(value));
    const dir = tmpDir();
    allow(dir, [REPO]);
    const { result, writes, seen, stderrText } = await run(dir, ['--write', '--only-field', value], {
      items: fills(1),
    });
    assert.equal(result.exitCode, 1, JSON.stringify(value));
    assert.equal(writes.length, 0, '0 次写请求');
    assert.equal(seen.token, 0, '读令牌之前退出');
    assert.equal(seen.load, 0, JSON.stringify(value));
    assert.equal(seen.network, 0, JSON.stringify(value));
    assert.equal(fs.existsSync(path.join(dir, 'changes.jsonl')), false, 'changes.jsonl 不追加');
    assert.equal(disabled(dir), false);
    assert.match(result.error.message, allowed);
    assert.equal(result.error.message.includes(`实际：${shown}`), true, `报错要写实际值：${JSON.stringify(value)}`);
    assert.match(stderrText, /--only-field 期望/);
  }

  // 缺值、取值位置是另一个 -- 参数、重复出现：同样非 0 退出，一条都不写。
  const malformed = [
    [['--only-field'], /缺少 --only-field 的取值/],
    [['--only-field', '--write'], /缺少 --only-field 的取值/],
    [['--only-field', '--max-per-tick', '1'], /缺少 --only-field 的取值/],
    [['--only-field', '优先级', '--only-field', '关联 PR'], /重复的参数：--only-field/],
    [['--only-field', '关联 PR', '--only-field', '关联 PR'], /重复的参数：--only-field/],
  ];
  for (const [argv, message] of malformed) {
    assert.throws(() => parsePrioRunArgs(argv), message, argv.join(' '));
    const dir = tmpDir();
    allow(dir, [REPO]);
    const { result, writes, seen } = await run(dir, ['--write', ...argv], { items: fills(1) });
    assert.equal(result.exitCode, 1, argv.join(' '));
    assert.match(result.error.message, message);
    assert.equal(writes.length, 0);
    assert.equal(seen.token, 0);
    assert.equal(fs.existsSync(path.join(dir, 'changes.jsonl')), false);
  }
});

test('SC8 关联 PR 段遇到优先级降级时不整拍停写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  // 同一份计划里有一条已确认的降级（P1 → P2）和一条 link：降级那一行属于优先级侧，本拍不可写字段。
  seedChange(dir, 2, 'P1');
  seedDebounce(dir, 2, confirmedDowngrade('P2'));
  const seated = changeRows(dir).length;
  const { writes, result, io } = await run(dir, ['--write', '--only-field', '关联 PR'], {
    items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2', priority: 'P1' })],
    prs: [closingPr(9, 1)],
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(writes.map((action) => action.fields), [{ '关联 PR': '#9(open,CI✓)' }], 'link 照写');
  assert.equal(result.stop, '', '不整拍停写');
  assert.equal(disabled(dir), false, '不建停写开关');
  const alerts = readAlerts(dir);
  assert.equal(alerts.some((alert) => alert.kind === 'prio-downgrade'), false, '不发 prio-downgrade');
  assert.equal(alerts.length, 0);
  assert.deepEqual(changeRows(dir).slice(seated).map((row) => row.field), ['关联 PR'], '优先级侧的降级本拍不写');
  assert.equal(result.assessment.excludedDowngradeClear, 1, '排除计数等于计划里的降级条数');
  assert.match(io.text(), /按 --only-field "关联 PR" 排除优先级侧降级\/清空 1 条/);
});

test('SC8 不带 --only-field 时降级仍整拍停写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  seedChange(dir, 2, 'P1');
  seedDebounce(dir, 2, confirmedDowngrade('P2'));
  const { writes, result } = await run(dir, ['--write'], {
    items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2', priority: 'P1' })],
    prs: [closingPr(9, 1)],
  });
  assert.equal(writes.length, 0);
  assert.equal(result.stop, 'downgrade');
  assert.equal(disabled(dir), true);
  assert.deepEqual(readAlerts(dir).map((alert) => alert.kind), ['prio-downgrade']);
});

test('SC9 --only-empty-to-p2 与 --only-field 同用时在读令牌前报错', async () => {
  const message = /--only-empty-to-p2 不能和 --only-field 同用/;
  const orders = [
    ['--write', '--only-empty-to-p2', '--only-field', '关联 PR'],
    ['--write', '--only-field', '关联 PR', '--only-empty-to-p2'],
  ];
  for (const argv of orders) {
    assert.throws(() => parsePrioRunArgs(argv), message, argv.join(' '));
    const dir = tmpDir();
    allow(dir, [REPO]);
    const { result, writes, seen, stderrText } = await run(dir, argv, { items: fills(1) });
    assert.equal(result.exitCode, 1, argv.join(' '));
    assert.match(result.error.message, message);
    assert.match(stderrText, message);
    assert.equal(seen.token, 0, '读令牌之前退出');
    assert.equal(seen.load, 0, argv.join(' '));
    assert.equal(seen.network, 0, argv.join(' '));
    assert.equal(writes.length, 0, '0 次写');
    assert.equal(disabled(dir), false);
    assert.equal(fs.existsSync(path.join(dir, 'changes.jsonl')), false, 'changes.jsonl 不存在');
  }
});

test('SC10 --max-per-tick 与 --only-field 关联 PR 同时生效', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const { writes, result } = await run(dir, ['--write', '--only-field', '关联 PR', '--max-per-tick', '1'], {
    items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2' }), item(3, { id: 'PVTI_3' })],
    prs: [closingPr(9, 1), closingPr(10, 2), closingPr(11, 3)],
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(writes.map((action) => action.fields), [{ '关联 PR': '#9(open,CI✓)' }], '每拍只写 1 条');
  assert.equal(result.stop, '');
  assert.equal(disabled(dir), false, '余下的只 defer，不建停写开关');
  assert.equal(readAlerts(dir).length, 0, 'defer 不算告警');
  assert.deepEqual(changeRows(dir).map((row) => row.item), [`${REPO}#1`], '只有写进去的那条留在 changes.jsonl');
});

test('SC11 --dry-run 加 --only-field 不写也不建 disabled', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const { writes, result } = await run(dir, ['--dry-run', '--only-field', '关联 PR'], {
    items: [item(1, { id: 'PVTI_1' }), item(2)],
    prs: [closingPr(9, 1)],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(writes.length, 0, 'dry-run 一条都不写');
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'changes.jsonl')), false);
});

test('SC12 --only-field 关联 PR 没有 mac-mini-stopped 时仍只扣住', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const { writes, result, io } = await run(dir, ['--write', '--only-field', '关联 PR'], {
    items: [item(1, { id: 'PVTI_1' })],
    prs: [closingPr(9, 1)],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(writes.length, 0, 'link 不写');
  assert.match(io.text(), /扣住/);
  assert.equal(readAlerts(dir).length, 0, '不算告警');
  assert.equal(disabled(dir), false);
  assert.equal(fs.existsSync(path.join(dir, 'mac-mini-stopped')), false, '本入口不建那个标记');
});

test('SC13 --only-field 关联 PR 时不发 prio-nonempty', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  // 计划里有一条升级（P2 → P1，已有优先级改成别的值）：不带 --only-field 时它会进 nonAuto 发 prio-nonempty。
  seedChange(dir, 2, 'P2');
  const { writes, result } = await run(dir, ['--write', '--only-field', '关联 PR'], {
    items: [item(1, { id: 'PVTI_1' }), item(2, { priority: 'P2', labels: ['影响发布'], repoClass: 'mivo' })],
    prs: [closingPr(9, 1)],
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(writes.map((action) => action.fields), [{ '关联 PR': '#9(open,CI✓)' }], 'link 照写');
  const alerts = readAlerts(dir);
  assert.equal(alerts.some((alert) => alert.kind === 'prio-nonempty'), false, '不发 prio-nonempty');
  assert.equal(alerts.length, 0);
  assert.equal(disabled(dir), false);
  assert.equal(result.stop, '');
});

test('SC1-边界7 整盘计划空→P2 而锁内已是 P1，跳过、不停写、本拍继续', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const counts = new Map();
  const { writes, result } = await run(dir, ['--write'], {
    items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2' })],
    readBack: async (change) => {
      const key = `${change.item}\0${change.field}`;
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      if (change.issue === 1) return 'P1';
      if (n === 1) return change.old;
      return change.new;
    },
  });
  assert.equal(writes.length, 1, '陈旧那条不写，后面的继续');
  assert.equal(writes[0].issue, 2);
  assert.equal(result.stop, '');
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
  assert.equal(result.result.skippedStale.length, 1);
  assert.equal(result.result.skippedStale[0].item, `${REPO}#1`);
  assert.equal(result.result.written, 1);
});

test('SC1-边界8 锁内对照仍是 old、回读成无关值仍停写', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const counts = new Map();
  const { writes, result } = await run(dir, ['--write'], {
    items: fills(2),
    readBack: async (change) => {
      const key = `${change.item}\0${change.field}`;
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      if (n === 1) return change.old;
      return change.issue === 1 ? 'P0' : change.new;
    },
  });
  assert.equal(writes.length, 1, '对照读返回 old 才写，回读错值立刻停');
  assert.equal(counts.get(`${REPO}#1\0优先级`), 2, '夹具：对照读 old、回读再返回错值');
  assert.equal(result.stop, 'readback');
  assert.equal(disabled(dir), true);
  const [alert] = readAlerts(dir);
  assert.match(alert.text, /读回来的值和要写的不一致/);
  assert.equal(result.result.readbackMismatch.actual, 'P0');
});

test('SC1-边界10 整盘抢不到，该条本拍跳过，不 abort、不 disabled', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  const lockFile = path.join(dir, 'prio-write.lock');
  let now = 0;
  let acquires = 0;
  const { writes, result } = await run(dir, ['--write'], {
    items: fills(2),
    lockPath: lockFile,
    lockOptions: {
      retryMs: 5,
      maxWaitMs: 5,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      tryAcquire: (file, opts) => {
        acquires += 1;
        if (acquires <= 2) return false;
        return tryAcquireLock(file, opts);
      },
    },
  });
  assert.equal(writes.length, 1, '第一条抢不到跳过，第二条继续');
  assert.equal(writes[0].issue, 2);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stop, '');
  assert.equal(disabled(dir), false);
  assert.equal(readAlerts(dir).length, 0);
  assert.equal(result.result.skippedLockBusy.length, 1);
  assert.equal(result.result.skippedLockBusy[0].item, `${REPO}#1`);
  assert.equal(result.result.aborted, false);
});

// #236：写成之后回读抛错，和回读不一致一样立刻停写、告警；已写的这一条不回滚、不重试。
const READBACK_FAILURES = {
  '5xx（status 502）': () => Object.assign(new Error('HTTP 502: Bad Gateway'), { status: 502 }),
  '网络错误': () => new TypeError('fetch failed'),
  '超时': () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
  '不是 JSON': () => new SyntaxError('Unexpected token < in JSON at position 0'),
  '无 status 的普通错误': () => new Error('something broke'),
};

for (const [label, makeError] of Object.entries(READBACK_FAILURES)) {
  test(`#236 回读抛错（${label}）：写停写开关、告警，第一条之后不再写`, async () => {
    const dir = tmpDir();
    allow(dir, [REPO]);
    fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
    const reads = [];
    const { writes, result } = await run(dir, ['--write', '--only-field', '关联 PR'], {
      items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2' }), item(3, { id: 'PVTI_3' })],
      prs: [closingPr(9, 1), closingPr(10, 2), closingPr(11, 3)],
      readBack: phasedReadBack((change) => {
        reads.push(change.item);
        throw makeError();
      }),
    });
    assert.equal(writes.length, 1, '写闸只调了一次，后面两条没写');
    assert.deepEqual(reads, [`${REPO}#1`], '回读只做了一次，没有重试');
    assert.equal(result.stop, 'readback-error');
    assert.equal(result.written, 1);
    assert.equal(disabled(dir), true);
    assert.deepEqual(changeRows(dir).map((row) => row.issue), [1], 'changes.jsonl 记了已写的这一条');
    const alerts = readAlerts(dir);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].kind, 'prio-readback-error');
    assert.match(alerts[0].text, /#1 的「关联 PR」已经写进看板/);
    assert.match(alerts[0].text, /后面还有 2 条没有写/);
    assert.match(alerts[0].text, /只有这一条被改了，其余没改/);
    assert.match(alerts[0].text, /核对这一条.*删除停写开关/);
    assert.equal(alerts[0].text.includes(REPO), false, '不写仓全名');
  });
}

test('#236 停写之后下一拍不补写，也不回滚已写的那条', async () => {
  const dir = tmpDir();
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  const options = {
    items: [item(1, { id: 'PVTI_1' }), item(2, { id: 'PVTI_2' })],
    prs: [closingPr(9, 1), closingPr(10, 2)],
  };
  const first = await run(dir, ['--write', '--only-field', '关联 PR'], {
    ...options, readBack: phasedReadBack(() => { throw new TypeError('fetch failed'); }),
  });
  assert.equal(first.result.stop, 'readback-error');
  const next = await run(dir, ['--write', '--only-field', '关联 PR'], options);
  assert.equal(next.writes.length, 0, '停写开关在，下一拍一条都不写（也没有回滚写入）');
  assert.equal(disabled(dir), true);
});

// #235：告警去重只看最近一个窗口（默认 24 小时，左开右闭），不再被几天前的同一条告警吞掉。
const READBACK_TEXT = alertTextFor('readback');
function seedAlert(dir, row) {
  fs.appendFileSync(path.join(dir, 'alerts.jsonl'), `${typeof row === 'string' ? row : JSON.stringify(row)}\n`);
}
async function readbackMismatchTick(dir, args = []) {
  allow(dir, [REPO]);
  fs.writeFileSync(path.join(dir, 'mac-mini-stopped'), '');
  try { fs.unlinkSync(path.join(dir, 'disabled')); } catch { /* 第一次没有 */ }
  return run(dir, ['--write', '--only-field', '关联 PR', ...args], {
    items: [item(1, { id: 'PVTI_1' })],
    prs: [closingPr(9, 1)],
    readBack: phasedReadBack(() => '#9(open)'),
  });
}
const iso = (ms) => new Date(ms).toISOString();

test('#235 SC1 窗口内（1 小时前）已有同一条：不追加', async () => {
  const dir = tmpDir();
  seedAlert(dir, { ts: iso(T0 - HOUR), kind: 'prio-readback', text: READBACK_TEXT });
  const { result } = await readbackMismatchTick(dir);
  assert.equal(result.stop, 'readback');
  assert.equal(readAlerts(dir).length, 1);
});

test('#235 SC2 窗口外（25 小时前）的同一条：追加一行', async () => {
  const dir = tmpDir();
  seedAlert(dir, { ts: iso(T0 - 25 * HOUR), kind: 'prio-readback', text: READBACK_TEXT });
  await readbackMismatchTick(dir);
  const rows = readAlerts(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].ts, iso(T0));
});

test('#235 SC3 旧行恰好在窗口左边界（now − 24h）上：算窗口外，追加', async () => {
  const dir = tmpDir();
  seedAlert(dir, { ts: iso(T0 - 24 * HOUR), kind: 'prio-readback', text: READBACK_TEXT });
  await readbackMismatchTick(dir);
  assert.equal(readAlerts(dir).length, 2);
});

test('#235 SC4 文件不存在、空文件、坏行、缺 ts、ts 不合法：都不抛错，后三种按窗口外处理', async () => {
  const missing = tmpDir();
  assert.equal((await readbackMismatchTick(missing)).result.stop, 'readback');
  assert.equal(readAlerts(missing).length, 1);
  const empty = tmpDir();
  fs.writeFileSync(path.join(empty, 'alerts.jsonl'), '');
  await readbackMismatchTick(empty);
  assert.equal(readAlerts(empty).length, 1);
  for (const bad of ['{不是 JSON', { kind: 'prio-readback', text: READBACK_TEXT }, { ts: 'yesterday', kind: 'prio-readback', text: READBACK_TEXT }]) {
    const dir = tmpDir();
    seedAlert(dir, bad);
    const { result } = await readbackMismatchTick(dir);
    assert.equal(result.stop, 'readback');
    const written = fs.readFileSync(path.join(dir, 'alerts.jsonl'), 'utf8').split('\n')
      .filter((line) => line.includes(`"ts":"${iso(T0)}"`));
    assert.equal(written.length, 1, JSON.stringify(bad));
  }
});

test('#235 SC5 窗口参数：不传用 24；0、负数、小数、非数字在读令牌之前报错，带期望与实际值', async () => {
  assert.equal(ALERT_DEDUPE_HOURS_DEFAULT, 24);
  assert.equal(parseAlertDedupeHours('48'), 48);
  for (const raw of ['0', '-3', '1.5', 'abc']) {
    const dir = tmpDir();
    const { result, seen } = await run(dir, ['--write', '--alert-dedupe-hours', raw], { items: fills(1) });
    assert.equal(result.exitCode, 1, raw);
    assert.match(result.error.message, /期望正整数小时/);
    assert.match(result.error.message, new RegExp(`实际：${raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.equal(seen.token, 0, raw);
    assert.equal(seen.network, 0, raw);
  }
  const dir = tmpDir();
  seedAlert(dir, { ts: iso(T0 - 3 * HOUR), kind: 'prio-readback', text: READBACK_TEXT });
  await readbackMismatchTick(dir, ['--alert-dedupe-hours', '2']);
  assert.equal(readAlerts(dir).length, 2, '窗口改成 2 小时后，3 小时前那条在窗口外');
});
