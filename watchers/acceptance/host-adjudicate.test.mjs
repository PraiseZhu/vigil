// #46 SC8 / #43：有争议条目的只读裁决运行（host/adjudicate.mjs）。
// 假 pi（不起 bwrap）、假 gh、假 GitHub；只读靠「没有写闸 socket」：沙箱里的 gh 直接拒绝。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGithub } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { ROOT_QUERY, SEARCH_QUERY } from './bin/collect.mjs';
import { buildDispatchMessage } from './bin/message.mjs';
import { poll } from './bin/poll.mjs';
import { EXIT, runRound } from './bin/round.mjs';
import { collectTasks } from './bin/tasks.mjs';
import { shouldTrigger } from './bin/trigger.mjs';
import {
  DEFAULT_MAX_MINUTES,
  MAX_ATTEMPTS,
  adjudicateCommandOf,
  adjudicationRunDir,
  maxMinutesOf,
  parseRulings,
  runAdjudication,
  scheduleAdjudications,
} from './host/adjudicate.mjs';
import { adjudicationPaths, disputedItems, readAdjudication, writeAdjudication } from './host/adjudication-store.mjs';
import { hostPaths, readAlerts, tryAcquireLock } from './host/paths.mjs';
import { runTick } from './host/tick.mjs';
import { OWNER, REPO, createFakeRun, inventoryData, issueNode, roundComment, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = `${REPO}#1`;
const ITEM = `${REPO}#1 SC3`;
const ITEM2 = `${REPO}#1 SC4`;
const ADJ_COMMAND = ['pi', '--model', 'anthropic/claude-opus-5-5', '--thinking', 'medium'];
const DISPUTE_DETAIL = [
  '## 逐条结果',
  '- 通过：example-owner/example-repo#1 SC1 · 证据：npm test',
  `- 有争议：${ITEM} · 验收方：缺少超时测试 · 修正方：超时由上游库保证`,
  `- 有争议：${ITEM2} · 验收方：文档没写 · 修正方：README 第 3 节写了`,
].join('\n');
const ISSUE_BODY = ['- [x] SC1 跑通 验证：unit', '- [ ] SC3 请求超时要有测试 验证：unit', '- [ ] SC4 文档写清配置 验证：static'].join('\n');

function writeMeminfo(kb = 8388608) {
  const file = path.join(tmpDir(), 'meminfo');
  fs.writeFileSync(file, `MemTotal: 16777216 kB\nMemAvailable: ${kb} kB\n`);
  return file;
}

function fixture(hostExtra = {}) {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const hostConfig = { piCommand: ['pi', '--model', 'example/model', '--thinking', 'max'], adjudicateCommand: ADJ_COMMAND, ...hostExtra };
  fs.writeFileSync(path.join(base.home, 'config', 'host.json'), JSON.stringify(hostConfig, null, 2));
  return { ...base, hostConfig };
}

/** 有争议的那条轮次评论（第 2 轮要修）。 */
function disputedRound() {
  return roundComment({
    round: 2,
    status: '要修',
    startedAt: '2026-10-24T01:00:00.000Z',
    finishedAt: '2026-10-24T01:30:00.000Z',
    detail: DISPUTE_DETAIL,
  });
}

/** collectTree 用的假 GitHub：只答两条只读查询；write 被调就记下来（应该一次都没有）。 */
function fakeGithub() {
  const writes = [];
  const root = issueNode({
    repo: REPO,
    number: 1,
    body: ISSUE_BODY,
    comments: [disputedRound()],
    prs: [{ number: 9, url: `https://github.com/${REPO}/pull/9`, mergedAt: '2026-10-20T00:00:00.000Z', repository: { nameWithOwner: REPO } }],
  });
  return {
    writes,
    async graphql(query) {
      if (query === ROOT_QUERY) return { repository: { issue: root } };
      if (query === SEARCH_QUERY) return { search: { nodes: [] } };
      throw new Error(`假 GitHub 不认识的查询：${String(query).slice(0, 40)}`);
    },
    async write(action) {
      writes.push(action);
      throw new Error('裁决运行不许写');
    },
  };
}

const RULING_JSON = JSON.stringify({
  items: [
    { ref: `${REPO}#1`, sc: 3, ruling: '成立', why: '确实没有超时测试' },
    { ref: `${REPO}#1`, sc: 4, ruling: '不成立', why: 'README 写了' },
  ],
});

/**
 * 假 pi：不进 bwrap，只记下参数和环境；按 env 试一次沙箱里的 gh（没有写闸 socket 应该被拒），
 * 再把 output 写到 stdoutFile。hang=true 时一直不退，直到被 kill。
 */
function fakePi({ output = `思考中……\n${RULING_JSON}\n`, code = 0, hang = false } = {}) {
  const calls = [];
  const spawnPi = (options) => {
    let message = '';
    const shim = spawnSync(process.execPath, [path.join(HERE, 'host', 'sandbox-bin', 'gh'), 'api', 'graphql', '--input', '-'], {
      env: options.env,
      input: JSON.stringify({ query: 'mutation { addComment }' }),
      encoding: 'utf8',
    });
    const record = { ...options, message: '', shim, killed: [] };
    calls.push(record);
    let resolveExit;
    const exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    if (!hang) {
      fs.writeFileSync(options.stdoutFile, output);
      setImmediate(() => resolveExit({ code }));
    }
    return {
      pid: 777001,
      stdin: {
        write(chunk) {
          message += chunk;
          record.message = message;
        },
        end() {},
      },
      kill(signal) {
        record.killed.push(signal);
        resolveExit({ code: 143, signal });
      },
      exit,
    };
  };
  return { spawnPi, calls };
}

const BWRAP_OK = async (cmd) => (cmd === 'bwrap' ? { code: 0, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'no' });

/** 假预取：在裁决目录里建一个空检出目录，和 host/prefetch.mjs 返回同样的形状。 */
async function fakePrefetch({ roundDir }) {
  const target = path.join(roundDir, 'code', REPO.replace('/', '__'));
  fs.mkdirSync(target, { recursive: true });
  return [{ repo: REPO, path: target, head: 'a'.repeat(40) }];
}

function runOnce(fx, overrides = {}) {
  return runAdjudication({
    prefetch: fakePrefetch,
    home: fx.home,
    issue: ROOT,
    round: 2,
    items: [ITEM, ITEM2],
    env: { ...process.env, HOME: process.env.HOME },
    run: BWRAP_OK,
    github: overrides.github || fakeGithub(),
    meminfoPath: writeMeminfo(),
    killGraceMs: 20,
    log: () => {},
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
    ...overrides,
  });
}

// ---- 触发 ----

test('SC8 tick 触发：等裁决的条目起一次裁决进程；正在跑 / 已有结果 / 没有空槽都不再起', () => {
  const fx = fixture();
  const spawned = [];
  const entries = [{ issue: ROOT, adjudicate: true, round: 2, items: [ITEM, ITEM2] }];
  const spawn = (job) => {
    spawned.push(job);
    return process.pid; // 活着的 pid：模拟进程还在跑。
  };
  const first = scheduleAdjudications({ home: fx.home, entries, hostConfig: fx.hostConfig, spawn, free: 1 });
  assert.deepEqual(first.started.map((entry) => entry.issue), [ROOT]);
  assert.deepEqual(spawned, [{ issue: ROOT, round: 2, items: [ITEM, ITEM2] }]);
  assert.equal(first.free, 0, '占一个槽');

  const again = scheduleAdjudications({ home: fx.home, entries, hostConfig: fx.hostConfig, spawn, free: 2 });
  assert.equal(spawned.length, 1, '同一任务同一轮只起一次');
  assert.equal(again.skipped[0].reason, 'running');

  writeAdjudication(fx.home, ROOT, 2, { items: [{ ref: `${REPO}#1`, sc: 3, ruling: '成立', why: 'x' }], at: '2026-10-24T02:00:00.000Z' });
  const done = scheduleAdjudications({ home: fx.home, entries, hostConfig: fx.hostConfig, spawn, free: 2 });
  assert.equal(done.skipped[0].reason, 'done');

  const other = fixture();
  const noSlot = scheduleAdjudications({ home: other.home, entries, hostConfig: other.hostConfig, spawn, free: 0 });
  assert.equal(noSlot.skipped[0].reason, 'no-slot');
  assert.equal(spawned.length, 1);
});

test('SC8 没配 adjudicateCommand：不起裁决，写 adjudicate-not-configured 提醒，一天一次', () => {
  const fx = fixture({ adjudicateCommand: undefined });
  const entries = [{ issue: ROOT, adjudicate: true, round: 2, items: [ITEM] }];
  const spawn = () => {
    throw new Error('没配就不该起');
  };
  let now = Date.parse('2026-10-24T02:00:00.000Z');
  scheduleAdjudications({ home: fx.home, entries, hostConfig: fx.hostConfig, spawn, now: () => now });
  now += 3600000;
  scheduleAdjudications({ home: fx.home, entries, hostConfig: fx.hostConfig, spawn, now: () => now });
  let alerts = readAlerts(hostPaths(fx.home)).filter((entry) => entry.kind === 'adjudicate-not-configured');
  assert.equal(alerts.length, 1, '一天只提醒一次');
  assert.match(alerts[0].reason, /adjudicateCommand/);
  now += 24 * 3600000;
  scheduleAdjudications({ home: fx.home, entries, hostConfig: fx.hostConfig, spawn, now: () => now });
  alerts = readAlerts(hostPaths(fx.home)).filter((entry) => entry.kind === 'adjudicate-not-configured');
  assert.equal(alerts.length, 2, '过了一天再提醒');
  assert.equal(adjudicateCommandOf({}), null);
  assert.equal(adjudicateCommandOf({ adjudicateCommand: [] }), null);
  assert.equal(maxMinutesOf({}), DEFAULT_MAX_MINUTES);
  assert.equal(DEFAULT_MAX_MINUTES, 30);
});

test('SC8 tick 接线：poll 报 adjudicate 条目只起裁决、不当成新一轮；裁决占剩下的空槽', async () => {
  const fx = fixture();
  // 总开关开着（关着时 tick 一个都不起，裁决运行也等着）。
  fs.mkdirSync(path.dirname(hostPaths(fx.home).enabledFile), { recursive: true });
  fs.writeFileSync(hostPaths(fx.home).enabledFile, '1');
  const rounds = [];
  const adjudications = [];
  const poll = JSON.stringify([
    { issue: `${REPO}#7`, kind: 'standalone', nextRound: 1 },
    { issue: ROOT, adjudicate: true, round: 2, items: [ITEM] },
  ]);
  const heartbeat = await runTick({
    home: fx.home,
    env: { ...process.env },
    run: async () => ({ code: 0, stdout: poll, stderr: '' }),
    spawnRound: (issue) => {
      rounds.push(issue);
      return 1;
    },
    spawnAdjudicate: (job) => {
      adjudications.push(job);
      return null;
    },
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    notify: async () => ({ ok: true, sent: 0, failed: [] }),
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.deepEqual(rounds, [`${REPO}#7`], 'adjudicate 条目不起验收轮');
  assert.deepEqual(adjudications, [{ issue: ROOT, round: 2, items: [ITEM] }]);
  assert.deepEqual(heartbeat.lastTick.adjudicate.started.map((entry) => entry.issue), [ROOT]);
});

// ---- 运行：只读、结果写进宿主状态目录 ----

test('SC8 跑通：pi 在 bwrap 里跑裁决命令；没有写闸 socket（沙箱里的 gh 拒绝）、不写 GitHub；结果写进 state/host/adjudications', async () => {
  const fx = fixture();
  const pi = fakePi();
  const github = fakeGithub();
  const code = await runOnce(fx, { spawnPi: pi.spawnPi, github });
  assert.equal(code, 0);
  assert.equal(pi.calls.length, 1);
  const call = pi.calls[0];
  assert.equal(call.cmd, 'bwrap');
  assert.deepEqual(call.args.slice(-ADJ_COMMAND.length), ADJ_COMMAND, '最后跑的是 adjudicateCommand');
  assert.ok(call.args.some((arg) => String(arg).endsWith('egress-bridge.mjs')), '和验收轮一样先起出网桥');
  assert.ok(call.args.includes('--unshare-net'), '自己的网络命名空间');
  assert.equal(call.env.ACCEPTANCE_GATE_SOCKET, undefined, '不给写闸 socket');
  assert.equal(call.env.HTTPS_PROXY, 'http://127.0.0.1:3128', '出网只经出网桥');
  assert.equal(call.args.some((arg) => String(arg).includes('gate.sock')), false);
  assert.equal(call.args.includes('--setenv'), false, '环境不进 bwrap 参数');
  assert.equal(call.shim.status, 1, '沙箱里的 gh 没有 socket 就拒绝');
  assert.match(call.shim.stderr, /沙箱里只允许经写闸读/);
  assert.deepEqual(github.writes, [], 'GitHub 一个字都没写');
  // 宿主状态目录在沙箱里被遮成空 tmpfs。
  const stateRoot = fs.realpathSync(path.join(fx.home, 'state'));
  const tmpfs = call.args.flatMap((arg, index) => (arg === '--tmpfs' ? [call.args[index + 1]] : []));
  assert.ok(tmpfs.includes(stateRoot), '宿主状态目录被遮');

  // 输入：SC 原文、双方理由、相关 PR。
  assert.match(call.message, /只读裁决运行/);
  assert.match(call.message, /请求超时要有测试/);
  assert.match(call.message, /缺少超时测试/);
  assert.match(call.message, /超时由上游库保证/);
  assert.match(call.message, /pull\/9/);
  // 代码：宿主预取的检出只读挂进去，消息里给出路径。
  const codeDir = path.join(adjudicationRunDir(fx.home, ROOT, 2), 'code', REPO.replace('/', '__'));
  assert.ok(call.message.includes(codeDir), '消息里给出代码路径');
  const roBinds = call.args.flatMap((arg, index) => (arg === '--ro-bind' ? [call.args[index + 1]] : []));
  const realCodeDir = path.join(fs.realpathSync(fx.home), path.relative(fx.home, codeDir));
  assert.ok(roBinds.includes(realCodeDir), '代码目录只读挂进沙箱');
  assert.match(call.message, /"ruling":"成立"/);

  const result = readAdjudication(fx.home, ROOT, 2);
  assert.ok(result, '结果写进去了');
  assert.equal(result.file, path.join(fx.home, 'state', 'host', 'adjudications', `${REPO.replace('/', '__')}__1__2.json`));
  assert.deepEqual(
    result.items.map((item) => [item.sc, item.ruling]),
    [
      [3, '成立'],
      [4, '不成立'],
    ],
  );
  assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
  // 槽和锁都放回去了；工作目录只留日志。
  assert.deepEqual(fs.readdirSync(hostPaths(fx.home).slotsDir), []);
  assert.deepEqual(fs.readdirSync(adjudicationPaths(fx.home).locksDir), []);
  assert.deepEqual(fs.readdirSync(adjudicationRunDir(fx.home, ROOT, 2)).sort(), ['out.log']);
  // 出过结果就不再跑。
  assert.equal(await runOnce(fx, { spawnPi: fakePi().spawnPi }), 3);
});

test('SC8 资源门：内存不够 / 槽满 / 这一轮已在跑都退出 3，不算一次尝试', async () => {
  const fx = fixture();
  const pi = fakePi();
  assert.equal(await runOnce(fx, { spawnPi: pi.spawnPi, meminfoPath: writeMeminfo(1024) }), 3);
  const paths = hostPaths(fx.home);
  tryAcquireLock(path.join(paths.slotsDir, 'slot-0'));
  tryAcquireLock(path.join(paths.slotsDir, 'slot-1'));
  assert.equal(await runOnce(fx, { spawnPi: pi.spawnPi }), 3);
  fs.rmSync(paths.slotsDir, { recursive: true, force: true });
  tryAcquireLock(adjudicationPaths(fx.home).lockFile(ROOT, 2));
  assert.equal(await runOnce(fx, { spawnPi: pi.spawnPi }), 3);
  assert.equal(pi.calls.length, 0);
  assert.equal(fs.existsSync(adjudicationPaths(fx.home).runFile(ROOT, 2)), false, '没算尝试');
});

test('SC8 输出解析：取最后一个 items JSON；缺条目、结论不是成立/不成立都不算；理由脱敏、压成一行', () => {
  const ok = parseRulings(`前面的话\n{"items":[]}\n${RULING_JSON}`, [ITEM, ITEM2]);
  assert.equal(ok.ok, true);
  const missing = parseRulings(JSON.stringify({ items: [{ ref: `${REPO}#1`, sc: 3, ruling: '成立', why: 'x' }] }), [ITEM, ITEM2]);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /SC4/);
  const bad = parseRulings(JSON.stringify({ items: [{ ref: `${REPO}#1`, sc: 3, ruling: '要修', why: 'x' }] }), [ITEM]);
  assert.equal(bad.ok, false);
  const fenced = parseRulings('```json\n{"items":[{"ref":"example-owner/example-repo#1","sc":3,"ruling":"不成立","why":"看了 /home/someone/secret\\n第二行"}]}\n```', [ITEM]);
  assert.equal(fenced.ok, true, fenced.error);
  assert.equal(fenced.items[0].why.includes('/home/someone'), false, '本机路径脱敏');
  assert.equal(fenced.items[0].why.includes('\n'), false);
  assert.equal(parseRulings('什么都没有', [ITEM]).ok, false);
});

// ---- 卡死防护：超时与重试 ----

test('SC8 超时：超过 adjudicateMaxMinutes 先结束 pi，写 adjudicate-timeout 提醒；重试 2 次后写 adjudicate-needs-human', async () => {
  const fx = fixture({ adjudicateMaxMinutes: 0.001 });
  let now = Date.parse('2026-10-24T02:00:00.000Z');
  const entries = [{ issue: ROOT, adjudicate: true, round: 2, items: [ITEM, ITEM2] }];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const pi = fakePi({ hang: true });
    const code = await runOnce(fx, { spawnPi: pi.spawnPi, now: () => now });
    assert.equal(code, 1);
    assert.deepEqual(pi.calls[0].killed, ['SIGTERM'], '超时先结束进程');
    const run = JSON.parse(fs.readFileSync(adjudicationPaths(fx.home).runFile(ROOT, 2), 'utf8'));
    assert.equal(run.attempts, attempt);
    // 重试有间隔：没到点 tick 不起。
    const early = scheduleAdjudications({ home: fx.home, entries, hostConfig: fx.hostConfig, spawn: () => null, now: () => now, free: 1 });
    assert.equal(early.started.length, 0);
    now += 6 * 60000;
  }
  const alerts = readAlerts(hostPaths(fx.home));
  assert.equal(alerts.filter((entry) => entry.kind === 'adjudicate-timeout').length, MAX_ATTEMPTS);
  const human = alerts.filter((entry) => entry.kind === 'adjudicate-needs-human');
  assert.equal(human.length, 1, '3 次用完写一条要人工裁决');
  assert.match(human[0].reason, /需要人工裁决/);
  assert.equal(readAdjudication(fx.home, ROOT, 2), null);
  // 用完就不再起。
  const after = scheduleAdjudications({ home: fx.home, entries, hostConfig: fx.hostConfig, spawn: () => null, now: () => now, free: 1 });
  assert.equal(after.skipped[0].reason, 'given-up');
  assert.equal(await runOnce(fx, { spawnPi: fakePi().spawnPi, now: () => now }), 3);
});

test('SC8 失败后重试：第一次输出不合格（算一次、写 adjudicate-failed），第二次出结果', async () => {
  const fx = fixture();
  let now = Date.parse('2026-10-24T02:00:00.000Z');
  assert.equal(await runOnce(fx, { spawnPi: fakePi({ output: '我觉得都成立\n' }).spawnPi, now: () => now }), 1);
  assert.ok(readAlerts(hostPaths(fx.home)).some((entry) => entry.kind === 'adjudicate-failed' && /没有裁决 JSON/.test(entry.reason)));
  assert.equal(await runOnce(fx, { spawnPi: fakePi({ code: 2 }).spawnPi, now: () => now }), 1, 'pi 退出码非 0 也算失败');
  now += 6 * 60000;
  const spawned = [];
  scheduleAdjudications({
    home: fx.home,
    entries: [{ issue: ROOT, adjudicate: true, round: 2, items: [ITEM, ITEM2] }],
    hostConfig: fx.hostConfig,
    spawn: (job) => {
      spawned.push(job);
      return null;
    },
    now: () => now,
    free: 1,
  });
  assert.equal(spawned.length, 1, '到点重试');
  assert.equal(await runOnce(fx, { spawnPi: fakePi().spawnPi, now: () => now }), 0);
  assert.ok(readAdjudication(fx.home, ROOT, 2));
  assert.equal(readAlerts(hostPaths(fx.home)).some((entry) => entry.kind === 'adjudicate-needs-human'), false);
});

// ---- trigger / poll / 下一轮的派发消息 ----

function standaloneWithDispute(extraComments = []) {
  return issueNode({
    repo: REPO,
    number: 1,
    body: ISSUE_BODY,
    comments: [disputedRound(), ...extraComments],
    prs: [{ number: 9, url: `https://github.com/${REPO}/pull/9`, mergedAt: '2026-10-20T00:00:00.000Z', repository: { nameWithOwner: REPO } }],
  });
}

test('SC8 有争议的「要修」不再静默：没有裁决结果时 trigger 等裁决、poll 报 adjudicate；有了结果触发下一轮', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const run = createFakeRun({ onGraphql: () => inventoryData({ open: [standaloneWithDispute()] }) });
  const github = createGithub({ profile, run });
  const now = () => Date.parse('2026-10-24T03:00:00.000Z');

  const [task] = await collectTasks(github, profile);
  assert.deepEqual(task.dispute.items, [ITEM, ITEM2]);
  assert.equal(task.dispute.round, 2);
  assert.equal(task.dispute.adjudication, null);
  assert.equal(shouldTrigger(task, { now, profile }).reason, 'awaiting-adjudication');
  assert.deepEqual(await poll({ github, profile, now }), [{ issue: ROOT, adjudicate: true, round: 2, items: [ITEM, ITEM2] }]);

  writeAdjudication(home, ROOT, 2, {
    items: [
      { ref: `${REPO}#1`, sc: 3, ruling: '成立', why: '没有超时测试' },
      { ref: `${REPO}#1`, sc: 4, ruling: '不成立', why: 'README 写了' },
    ],
    at: '2026-10-24T02:30:00.000Z',
  });
  const [after] = await collectTasks(github, profile);
  assert.equal(after.dispute.adjudication.items.length, 2);
  assert.deepEqual(shouldTrigger(after, { now, profile }), { trigger: true, reason: 'adjudicated' });
  const entries = await poll({ github, profile, now });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].adjudicate, undefined, '裁决出来后就是普通的下一轮');
});

test('SC8 有争议只认最近一次出结论的轮次，且只认「- 有争议：<ref> SC<k>」行格式（证据里提到「有争议」不算）', () => {
  assert.deepEqual(disputedItems(`[验收机] 第 2 轮：要修\n${DISPUTE_DETAIL}`), [ITEM, ITEM2]);
  assert.deepEqual(disputedItems(`[验收机] 第 3 轮：通过\n- 通过：${ITEM} · 证据：按裁决（原有争议）不成立`), []);
  const profile = { startAt: '2026-01-01T00:00:00.000Z' };
  const rounds = [
    { round: 2, status: '要修', finishedAt: '2026-10-24T01:30:00.000Z', bodyVersion: 'sha256:abc', createdAt: '2026-10-24T01:00:00.000Z' },
    { round: 3, status: '通过', finishedAt: '2026-10-24T05:00:00.000Z', bodyVersion: 'sha256:abc', createdAt: '2026-10-24T04:00:00.000Z' },
  ];
  const task = {
    tier: 'auto',
    kind: 'standalone',
    rounds,
    linkedPrs: [{ mergedAt: '2026-10-20T00:00:00.000Z' }],
    bodyVersion: 'sha256:abc',
    dispute: { round: 2, items: [ITEM], adjudication: null },
  };
  assert.equal(shouldTrigger(task, { now: () => Date.parse('2026-10-24T06:00:00.000Z'), profile }).reason, 'up-to-date', '旧轮次的争议不拦');
});

test('SC8 下一轮的派发消息带上裁决结果（bin/round.mjs start → message.mjs），没有结果时 start 不认领', async () => {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const issue = structuredClone(standaloneWithDispute());
  let seq = 8000;
  const run = createFakeRun({
    onGraphql: (payload) => {
      const query = String(payload.query || '');
      if (query.includes('user(login')) return inventoryData({ open: [issue] });
      if (query.includes('repository(owner')) return { repository: { issue } };
      return {};
    },
    onApi: (args, { input }) => {
      const body = input ? JSON.parse(input) : {};
      const id = ++seq;
      const stamp = '2026-10-24T03:00:00.000Z';
      issue.comments.nodes.push({ id: `IC_${id}`, databaseId: id, body: body.body, createdAt: stamp, updatedAt: stamp, url: `https://github.com/${REPO}/issues/1#issuecomment-${id}`, author: { login: OWNER } });
      return { id, html_url: `https://github.com/${REPO}/issues/1#issuecomment-${id}` };
    },
  });
  const github = createGithub({ profile, run });
  const now = () => Date.parse('2026-10-24T03:00:00.000Z');
  const capture = async () => {
    let stdout = '';
    let stderr = '';
    const code = await runRound(['start', '--issue', ROOT], {
      github,
      profile,
      now,
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: (chunk) => (stderr += chunk) },
    });
    return { code, stdout, stderr };
  };

  const waiting = await capture();
  assert.equal(waiting.code, EXIT.NOTHING);
  assert.match(waiting.stderr, /awaiting-adjudication/);

  writeAdjudication(home, ROOT, 2, {
    items: [
      { ref: `${REPO}#1`, sc: 3, ruling: '成立', why: '没有超时测试' },
      { ref: `${REPO}#1`, sc: 4, ruling: '不成立', why: 'README 第 3 节写了' },
    ],
    at: '2026-10-24T02:30:00.000Z',
  });
  const started = await capture();
  assert.equal(started.code, EXIT.OK, started.stderr);
  assert.match(started.stdout, /裁决结果（第 2 轮的有争议条目/);
  assert.match(started.stdout, /- example-owner\/example-repo#1 SC3：成立 · 理由：没有超时测试/);
  assert.match(started.stdout, /- example-owner\/example-repo#1 SC4：不成立 · 理由：README 第 3 节写了/);
  assert.match(started.stdout, /不要再标「有争议」/);
  assert.equal(JSON.parse(started.stdout.trim().split('\n').at(-1)).round, 3);
});

test('SC8 派发消息：裁决结果字段不合法直接抛错；理由压成一行', () => {
  const base = { issue: ROOT, kind: 'standalone', round: 3, commentId: 1, bodyVersion: `sha256:${'a'.repeat(64)}` };
  const text = buildDispatchMessage({
    ...base,
    adjudication: { round: 2, items: [{ ref: `${REPO}#1`, sc: 3, ruling: '成立', why: '第一行\n第二行' }] },
  });
  assert.match(text, /SC3：成立 · 理由：第一行 第二行/);
  assert.equal(buildDispatchMessage(base).includes('裁决结果'), false, '没有裁决就不带');
  assert.throws(() => buildDispatchMessage({ ...base, adjudication: { round: 2, items: [{ ref: `${REPO}#1`, sc: 3, ruling: '要修' }] } }), /成立/);
  assert.throws(() => buildDispatchMessage({ ...base, adjudication: { round: 2, items: [] } }), /至少/);
});

test('SC8 裁决结果文件形状不对就当没有（宁可再等，不按坏结果走）', () => {
  const fx = fixture();
  const file = adjudicationPaths(fx.home).resultFile(ROOT, 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ items: [{ ref: `${REPO}#1`, sc: 3, ruling: '随便', why: '' }] }));
  assert.equal(readAdjudication(fx.home, ROOT, 2), null);
  fs.writeFileSync(file, '{坏了');
  assert.equal(readAdjudication(fx.home, ROOT, 2), null);
});
