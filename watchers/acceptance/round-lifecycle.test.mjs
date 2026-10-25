// #47 SC11 宿主轮次生命周期，走真实代码路径：host/round.mjs 用默认 runRound（bin/round.mjs → 写闸 exec
// 子进程）和默认 startGate（真的 write-gate.mjs serve 子进程），pi 在真的 bwrap 里跑；GitHub 是按文件存状态的假 gh。
// bwrap 不可用时整组明确跳过。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { hostPaths, progressFileFor, readAlerts } from './host/paths.mjs';
import { roundDirFor, runHostRound } from './host/round.mjs';
import { probeBwrap } from './host/sandbox.mjs';
import { run as procRun } from './host/proc.mjs';
import { cachePath } from './bin/rounds.mjs';
import { ROOT_REF, createRoundWorld, roundComments, writeMeminfo } from './round-world.fixture.mjs';
import { OTHER_REPO, REPO } from './fake-gh.fixture.mjs';

const bwrapAvailable = await probeBwrap(procRun);
const skip = bwrapAvailable ? false : 'bwrap 不可用（探针起不来），跳过真沙箱测试';

/** pi：读完派发消息，对消息里列出的每个代码目录试读、试写，结果打一行 JSON 到 stdout（进 pi.log），再按 exitCode 退出。 */
function probingPi(exitCode) {
  return `
const fs = require('node:fs');
const path = require('node:path');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const results = [];
  for (const match of input.matchAll(/^- (\\S+)：(\\/[^（\\n]+)/gm)) {
    const dir = match[2].trim();
    const entry = { repo: match[1], dir };
    try { entry.readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8'); } catch (error) { entry.readError = error.code; }
    try { entry.gitConfig = fs.readFileSync(path.join(dir, '.git', 'config'), 'utf8'); } catch (error) { entry.gitConfigError = error.code; }
    try { fs.writeFileSync(path.join(dir, 'planted.txt'), 'x'); entry.writable = true; } catch (error) { entry.writeError = error.code; }
    try { fs.writeFileSync(path.join(dir, '.git', 'hooks-planted'), 'x'); entry.gitWritable = true; } catch (error) { entry.gitWriteError = error.code; }
    results.push(entry);
  }
  process.stdout.write(JSON.stringify({ marker: 'PI-RESULT', firstLine: input.split('\\n')[0], results }) + '\\n');
  process.exit(${Number(exitCode)});
});
`;
}

function piLogOf(world, round = 1) {
  return fs.readFileSync(path.join(roundDirFor(world.paths, ROOT_REF, round), 'pi.log'), 'utf8');
}

function piResult(world) {
  const line = piLogOf(world).split('\n').find((entry) => entry.includes('"PI-RESULT"'));
  assert.ok(line, `pi.log 里没有结果：${piLogOf(world).slice(0, 500)}`);
  return JSON.parse(line);
}

function baseOptions(world, extra = {}) {
  return {
    home: world.home,
    issue: ROOT_REF,
    run: world.run,
    meminfoPath: writeMeminfo(),
    log: () => {},
    killGraceMs: 500,
    ...extra,
  };
}

async function waitFor(predicate, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

for (const exitCode of [0, 1]) {
  test(`SC11 真实路径：pi 以 ${exitCode} 退出、没写裁决 → 立即 abort（不等查进度的间隔）+ round-failed 提醒；预取的代码沙箱里可读、不可写`, { skip, timeout: 60000 }, async () => {
    const world = await createRoundWorld({ piScript: probingPi(exitCode) });
    const startedAt = Date.now();
    // 间隔给 60 秒：pi 一退就该收尾，不能等满一个间隔。
    const code = await runHostRound(baseOptions(world, { statusIntervalMs: 60000 }));
    assert.ok(Date.now() - startedAt < 30000, 'pi 退出后立即收尾');
    assert.equal(code, 1);

    const [comment] = roundComments(world);
    assert.match(comment.body.split('\n')[0], /^\[验收机\] 第 1 轮：中断/);
    assert.match(comment.body, new RegExp(`原因：pi 退出（code=${exitCode}）但没写裁决`));
    const alerts = readAlerts(world.paths);
    assert.ok(alerts.some((entry) => entry.kind === 'round-failed' && entry.round === 1 && /但没写裁决/.test(entry.reason)), JSON.stringify(alerts));

    // 派发消息里写了两个仓的代码路径；沙箱里读得到、写不进（工作树和 .git 都只读），.git/config 里没有令牌。
    const result = piResult(world);
    assert.match(result.firstLine, /^先读 watchers\/acceptance\/SESSION\.md/);
    assert.deepEqual(result.results.map((entry) => entry.repo).sort(), [OTHER_REPO, REPO].sort());
    for (const entry of result.results) {
      assert.ok(path.isAbsolute(entry.dir));
      assert.ok(entry.dir.startsWith(roundDirFor(world.paths, ROOT_REF, 1)), '代码在本轮目录下');
      assert.equal(entry.readme, `code of ${entry.repo}\n`, JSON.stringify(entry));
      assert.equal(entry.writable, undefined, `${entry.repo} 工作树不该可写`);
      assert.equal(entry.gitWritable, undefined, `${entry.repo} 的 .git 不该可写`);
      assert.equal(entry.writeError, 'EROFS', JSON.stringify(entry));
      assert.doesNotMatch(entry.gitConfig, /extraheader|owner-token|AUTHORIZATION/i);
    }
    assert.equal(piLogOf(world).includes('owner-token'), false, '令牌不进沙箱');

    // 收尾：登记、宿主进度、检出的代码都清掉，pi.log 留着；宿主镜像在 <home>/state 下（沙箱看不见）。
    assert.deepEqual(fs.readdirSync(world.paths.roundsDir), []);
    assert.equal(fs.existsSync(progressFileFor(world.paths, ROOT_REF, 1)), false);
    assert.equal(fs.existsSync(path.join(roundDirFor(world.paths, ROOT_REF, 1), 'code')), false);
    assert.ok(fs.existsSync(path.join(world.home, 'state', 'prbot', 'mirrors', `acceptance__${REPO.replace('/', '__')}`, '.git')));
    assert.equal(fs.existsSync(path.join(world.upstream[REPO], 'planted.txt')), false);
  });
}

test('SC11 真实路径：裁决写完 pi 还不退 → 宽限到点先 SIGTERM，收尾不 abort', { skip, timeout: 60000 }, async () => {
  const world = await createRoundWorld({
    piScript: "process.stdout.write('PI-READY\\n'); setInterval(() => {}, 1000);",
  });
  const pending = runHostRound(baseOptions(world, { statusIntervalMs: 50, verdictGraceMs: 400 }));
  const piLog = path.join(roundDirFor(world.paths, ROOT_REF, 1), 'pi.log');
  assert.ok(await waitFor(() => fs.existsSync(piLog) && fs.readFileSync(piLog, 'utf8').includes('PI-READY')), 'pi 起来了');
  const verdictAt = Date.now();
  world.setRoundStatus(ROOT_REF, 1, '通过');
  const code = await pending;
  assert.equal(code, 0);
  assert.ok(Date.now() - verdictAt >= 400, '至少宽限 verdictGraceMs');
  const [comment] = roundComments(world);
  assert.match(comment.body.split('\n')[0], /第 1 轮：通过/, '不会被改成中断');
  assert.deepEqual(readAlerts(world.paths).filter((entry) => /^round-/.test(entry.kind)), []);
  assert.deepEqual(fs.readdirSync(world.paths.roundsDir), []);
});

test('SC11 真实路径：一直有输出也逃不过总时长上限（host.json maxRoundMinutes）→ 停 pi、abort、round-timeout', { skip, timeout: 60000 }, async () => {
  const world = await createRoundWorld({
    piScript: "setInterval(() => process.stdout.write('tick\\n'), 30);",
    hostJson: { maxRoundMinutes: 0.03 },
  });
  const startedAt = Date.now();
  const code = await runHostRound(baseOptions(world, { statusIntervalMs: 50 }));
  assert.equal(code, 1);
  assert.ok(Date.now() - startedAt >= 1800, '到点才停');
  const [comment] = roundComments(world);
  assert.match(comment.body.split('\n')[0], /第 1 轮：中断/);
  assert.match(comment.body, /原因：超过总时长上限（0\.03 分钟）/);
  const kinds = readAlerts(world.paths).map((entry) => entry.kind);
  assert.ok(kinds.includes('round-timeout'), kinds.join(','));
  assert.equal(kinds.includes('round-stalled'), false, '一直有输出，不算卡住');
});

test('SC11 真实路径：模型在 stateDir 里把 lastProgressAt 伪造到 2099 也照样按宿主时间判卡住', { skip, timeout: 60000 }, async () => {
  const world = await createRoundWorld({
    profile: { stallMinutes: 0.02 },
    piScript: `
const fs = require('node:fs');
const path = require('node:path');
const profile = JSON.parse(fs.readFileSync(path.join(process.env.ACCEPTANCE_WATCHER_HOME, 'config', 'profile.json'), 'utf8'));
const file = path.join(profile.stateDir, 'issues', '${REPO.replace('/', '__')}__1.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
const cache = JSON.parse(fs.readFileSync(file, 'utf8'));
cache.round.lastProgressAt = '2099-01-01T00:00:00.000Z';
fs.writeFileSync(file, JSON.stringify(cache));
process.stdout.write('FORGED\\n');
setInterval(() => {}, 1000);
`,
  });
  const code = await runHostRound(baseOptions(world, { statusIntervalMs: 50 }));
  assert.equal(code, 1);
  const forged = JSON.parse(fs.readFileSync(cachePath(world.profile, ROOT_REF), 'utf8'));
  assert.equal(forged.round.lastProgressAt, '2099-01-01T00:00:00.000Z', '模型确实伪造了缓存');
  assert.match(piLogOf(world), /FORGED/);
  const [comment] = roundComments(world);
  assert.match(comment.body, /原因：卡住：超过 stallMinutes 没有进度/);
  assert.ok(readAlerts(world.paths).some((entry) => entry.kind === 'round-stalled'));
});

test('SC11 真实路径：沙箱里经写闸 socket 发请求会刷新宿主侧进度；停了才判卡住', { skip, timeout: 60000 }, async () => {
  const world = await createRoundWorld({
    profile: { stallMinutes: 0.015 },
    piScript: `
const net = require('node:net');
let sent = 0;
const timer = setInterval(() => {
  const socket = net.connect(process.env.ACCEPTANCE_GATE_SOCKET);
  socket.on('connect', () => socket.write(JSON.stringify({ type: 'probe' }) + '\\n'));
  socket.on('data', () => {});
  socket.on('error', () => {});
  sent += 1;
  if (sent >= 8) clearInterval(timer);
}, 300);
setInterval(() => {}, 1000);
`,
  });
  const progress = progressFileFor(world.paths, ROOT_REF, 1);
  let maxRequests = 0;
  let lastActivity = null;
  const watcher = setInterval(() => {
    try {
      const entry = JSON.parse(fs.readFileSync(progress, 'utf8'));
      maxRequests = Math.max(maxRequests, entry.gateRequests);
      lastActivity = entry.lastActivityAt;
    } catch {
      // 还没写或已经删了。
    }
  }, 20);
  const startedAt = Date.now();
  const code = await runHostRound(baseOptions(world, { statusIntervalMs: 50 }));
  clearInterval(watcher);
  assert.equal(code, 1);
  // 8 次请求、间隔 300 毫秒，卡住阈值 0.9 秒：请求一直在发的那 2.4 秒里不会被判卡住。
  assert.ok(Date.now() - startedAt >= 2400 + 900, `卡住判得太早：${Date.now() - startedAt}ms`);
  assert.ok(maxRequests >= 6, `宿主记到的写闸请求太少：${maxRequests}`);
  assert.ok(Date.parse(lastActivity) - startedAt >= 2000, '最近活动时间跟着请求往后走');
  const [comment] = roundComments(world);
  assert.match(comment.body, /原因：卡住：超过 stallMinutes 没有进度/);
  assert.equal(fs.existsSync(progress), false, '收尾删掉宿主进度');
});

test('SC11 真实路径：代码取不下来 → abort（代码预取失败）+ prefetch-failed，不起 pi', { skip, timeout: 60000 }, async () => {
  const world = await createRoundWorld({ piScript: "process.stdout.write('PI-RAN\\n');" });
  delete world.upstream[OTHER_REPO];
  const code = await runHostRound(baseOptions(world, { statusIntervalMs: 50 }));
  assert.equal(code, 1);
  const [comment] = roundComments(world);
  assert.match(comment.body, new RegExp(`原因：代码预取失败：${OTHER_REPO.replace('/', '\\/')}`));
  assert.ok(readAlerts(world.paths).some((entry) => entry.kind === 'prefetch-failed'));
  const piLog = path.join(roundDirFor(world.paths, ROOT_REF, 1), 'pi.log');
  assert.equal(fs.existsSync(piLog) && fs.readFileSync(piLog, 'utf8').includes('PI-RAN'), false, '没起 pi');
});

test('SC11 真实路径：写闸总开关关着 → 不认领、不写任何提醒、一条 GitHub 请求都不发', { skip, timeout: 60000 }, async () => {
  const world = await createRoundWorld({ enabled: false });
  const code = await runHostRound(baseOptions(world));
  assert.equal(code, 3);
  assert.equal(world.readState().graphqlCalls, undefined, '没发任何请求');
  assert.deepEqual(roundComments(world), []);
  assert.deepEqual(readAlerts(world.paths), []);
  const roundsDir = hostPaths(world.home).roundsDir;
  assert.deepEqual(fs.existsSync(roundsDir) ? fs.readdirSync(roundsDir) : [], []);
});
