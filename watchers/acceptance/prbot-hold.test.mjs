// 修正轮按 issue 挂起（hold.json）：发现阶段不认领、到期 / 合入后自动恢复、坏文件不崩、日志去重、运维 CLI。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RateLimitError } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { correctionBody } from './bin/correct.mjs';
import { runHoldCli } from './bin/prbot-hold.mjs';
import { emptyRateState, recordHeader, writeRateState } from './bin/rate-budget.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { discoverCorrections, runPrbotCorrection } from './host/prbot.mjs';
import { HOLD_MERGE_CHECK_MIN_MS, MERGED_PR_QUERY, holdFilePath, holdLogPath } from './host/prbot-hold.mjs';
import { defaultTree } from './session.fixture.mjs';
import { OWNER, REPO, clock, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const HELD = `${REPO}#9`;
const FREE = `${REPO}#11`;
const HOST_CONFIG = { prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } };
const T0 = '2026-10-24T04:00:00.000Z';

function addCorrection(world, number, sc) {
  const correction = world.addIssue({
    repo: REPO,
    number,
    title: `修正：子任务 SC${sc}`,
    body: correctionBody({ root: `${REPO}#1`, item: `${REPO}#2`, sc, round: 1, text: `SC${sc} 把结果写进轮次评论 验证：unit（测试点：假 gh）`, why: '轮次评论没写结果' }),
  });
  world.addChild(`${REPO}#1`, correction.ref);
  return correction;
}

function inventoryNode(world, ref) {
  const issue = world.requireIssue(ref);
  const child = (childRef) => world.requireIssue(childRef);
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
    url: issue.url,
    createdAt: issue.createdAt,
    closedAt: issue.closedAt,
    updatedAt: issue.createdAt,
    author: { login: issue.author },
    repository: { nameWithOwner: issue.repo },
    parent: null,
    subIssues: {
      nodes: issue.subIssues.map((childRef) => ({
        number: child(childRef).number,
        title: child(childRef).title,
        state: child(childRef).state === 'closed' ? 'CLOSED' : 'OPEN',
        url: child(childRef).url,
        closedAt: child(childRef).closedAt,
        author: { login: OWNER },
        repository: { nameWithOwner: child(childRef).repo },
      })),
    },
    closedByPullRequestsReferences: {
      nodes: (issue.prs || []).map((pr) => ({ number: pr.number, url: pr.url, mergedAt: pr.mergedAt || null, baseRefName: 'main', repository: { nameWithOwner: issue.repo } })),
    },
    comments: {
      nodes: issue.comments.map((comment) => ({
        id: comment.id,
        databaseId: comment.databaseId,
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        url: comment.url,
        author: { login: comment.author.login },
      })),
    },
  };
}

/** 两个同仓修正子 issue（#9、#11）的世界；merged 记录每次「合入了没有」查询，answer 决定返回。 */
function setup() {
  const { home } = writeProfile(tmpDir());
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const world = defaultTree({ roundStatus: '要修', roundCommentUrl: 'https://example.invalid/c' });
  addCorrection(world, 9, 3);
  addCorrection(world, 11, 4);
  const merged = { calls: [], answer: () => ({ repository: { pullRequests: { nodes: [] } } }) };
  const github = {
    writes: 0,
    async graphql(query, variables) {
      if (query === MERGED_PR_QUERY) {
        merged.calls.push(variables);
        return merged.answer(variables);
      }
      if (query.includes('user(login')) {
        return {
          user: {
            open: { nodes: [inventoryNode(world, `${REPO}#1`)], pageInfo: { hasNextPage: false, endCursor: null } },
            closed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      }
      return world.graphql({ query, variables });
    },
    async write() {
      this.writes += 1;
      return { code: 0, body: {} };
    },
  };
  const paths = hostPaths(home);
  const time = clock(T0);
  const discover = () => discoverCorrections({ github, profile, home, hostConfig: HOST_CONFIG, now: time.now }).then((found) => found.map((entry) => entry.issue));
  return { home, profile, world, github, merged, paths, time, discover };
}

function writeHolds(paths, holds) {
  fs.mkdirSync(paths.prbotDir, { recursive: true });
  fs.writeFileSync(holdFilePath(paths), JSON.stringify({ version: 1, holds }));
}

function holdLog(paths) {
  try {
    return fs.readFileSync(holdLogPath(paths), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function prbotFiles(paths) {
  return fs.existsSync(paths.prbotDir) ? fs.readdirSync(paths.prbotDir).sort() : [];
}

test('SC1 没有 hold.json（或为空）：发现结果和以前一样，不查合入、不多写任何文件', async () => {
  const { paths, merged, discover } = setup();
  const before = prbotFiles(paths);
  assert.deepEqual(await discover(), [HELD, FREE]);
  assert.deepEqual(prbotFiles(paths), before, '没有 hold.json 时 prbot 目录不多出文件');
  fs.mkdirSync(paths.prbotDir, { recursive: true });
  fs.writeFileSync(holdFilePath(paths), '  \n');
  assert.deepEqual(await discover(), [HELD, FREE]);
  assert.deepEqual(prbotFiles(paths), ['hold.json']);
  assert.equal(merged.calls.length, 0);
  assert.deepEqual(readAlerts(paths), []);
});

test('SC2/SC3 挂起的 issue 不认领、写操作 0 次；同仓未挂起的照常认领', async () => {
  const { home, profile, github, paths, time, discover } = setup();
  writeHolds(paths, [{ issue: HELD, reason: '等外部条件', until: { type: 'manual' } }]);
  assert.deepEqual(await discover(), [FREE]);
  const actions = [];
  const code = await runPrbotCorrection({
    home,
    issue: HELD,
    profile,
    hostConfig: HOST_CONFIG,
    github,
    now: time.now,
    makeGate: () => ({
      async handle(action) {
        actions.push(action);
        return { code: 0, body: {} };
      },
    }),
  });
  assert.equal(code, 3);
  assert.deepEqual(actions, [], '写闸一次都没调');
  assert.equal(github.writes, 0);
  assert.equal(fs.existsSync(path.join(paths.prbotRoundsDir, 'example-owner__example-repo__9.json')), false, '不建修正轮状态');
});

test('SC4 按时间到期：到期前 1ms 仍挂着，刚好等于 now 和到期后 1ms 都解除', async () => {
  const { paths, time, discover } = setup();
  const at = '2026-10-24T06:00:00.000Z';
  const atMs = Date.parse(at);
  writeHolds(paths, [{ issue: HELD, reason: '等到点', until: { type: 'time', at } }]);
  // now < at 继续挂着；now >= at（刚好到期、到期后 1ms）解除。
  time.set(atMs - 1);
  assert.deepEqual(await discover(), [FREE], '到期前 1ms 仍挂着');
  time.set(atMs);
  assert.deepEqual(await discover(), [HELD, FREE], '刚好等于 now 时解除');
  time.set(atMs + 1);
  assert.deepEqual(await discover(), [HELD, FREE], '到期后 1ms 仍解除');
  assert.deepEqual(holdLog(paths).map((line) => line.event), ['held', 'released']);
});

test('SC5 分支没合入保持挂起，合入后解除；查询失败照样挂着；同一条件 15 分钟内只查一次', async () => {
  const { paths, time, merged, discover } = setup();
  writeHolds(paths, [{ issue: HELD, reason: '等集成分支', until: { type: 'merged', branch: 'integration/demo', base: 'main' } }]);
  assert.deepEqual(await discover(), [FREE]);
  assert.deepEqual(merged.calls, [{ owner: 'example-owner', name: 'example-repo', head: 'integration/demo', base: 'main' }]);
  // 15 分钟内再来几拍：不再查。
  time.set(Date.parse(T0) + HOLD_MERGE_CHECK_MIN_MS - 1);
  assert.deepEqual(await discover(), [FREE]);
  assert.equal(merged.calls.length, 1);
  // 到点再查，查询失败：不误解除。
  merged.answer = () => {
    throw new Error('HTTP 502');
  };
  time.set(Date.parse(T0) + HOLD_MERGE_CHECK_MIN_MS);
  assert.deepEqual(await discover(), [FREE]);
  assert.equal(merged.calls.length, 2);
  // 返回结构不对也不解除。
  merged.answer = () => ({ repository: null });
  time.set(Date.parse(T0) + 2 * HOLD_MERGE_CHECK_MIN_MS);
  assert.deepEqual(await discover(), [FREE]);
  // 合入了：解除，之后不再查。
  merged.answer = () => ({ repository: { pullRequests: { nodes: [{ number: 5, mergedAt: '2026-10-24T05:00:00Z' }] } } });
  time.set(Date.parse(T0) + 3 * HOLD_MERGE_CHECK_MIN_MS);
  assert.deepEqual(await discover(), [HELD, FREE]);
  const calls = merged.calls.length;
  time.set(Date.parse(T0) + 5 * HOLD_MERGE_CHECK_MIN_MS);
  assert.deepEqual(await discover(), [HELD, FREE]);
  assert.equal(merged.calls.length, calls, '解除后不再查');
});

test('SC6 hold.json 损坏：主循环不崩，按不挂起处理，只报一次提醒；单条条件写坏的保守挂着', async () => {
  const { paths, discover } = setup();
  fs.mkdirSync(paths.prbotDir, { recursive: true });
  fs.writeFileSync(holdFilePath(paths), '{"version": 1, "holds": [');
  assert.deepEqual(await discover(), [HELD, FREE]);
  assert.deepEqual(await discover(), [HELD, FREE]);
  let alerts = readAlerts(paths).filter((alert) => alert.kind === 'prbot-hold-invalid');
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].detail, /不是合法 JSON/);
  // 结构对、单条 until 写坏：这一条按人工解除挂着，另报一次。
  writeHolds(paths, [
    { issue: HELD, reason: '条件写错了', until: { type: 'someday' } },
    { issue: 'not-a-ref', reason: 'x', until: { type: 'manual' } },
  ]);
  assert.deepEqual(await discover(), [FREE]);
  assert.deepEqual(await discover(), [FREE]);
  alerts = readAlerts(paths).filter((alert) => alert.kind === 'prbot-hold-invalid');
  assert.equal(alerts.length, 2);
  assert.match(alerts[1].detail, /until\.type/);
  assert.match(alerts[1].detail, /not-a-ref/);
});

test('SC7 日志去重：同一个挂起连续多拍只记一次（带原因和到期条件）', async () => {
  const { paths, time, discover } = setup();
  writeHolds(paths, [{ issue: HELD, reason: '等上游', until: { type: 'manual' } }]);
  for (let tick = 0; tick < 5; tick += 1) {
    time.set(Date.parse(T0) + tick * 60000);
    assert.deepEqual(await discover(), [FREE]);
  }
  const lines = holdLog(paths);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'held');
  assert.equal(lines[0].issue, HELD);
  assert.equal(lines[0].reason, '等上游');
  assert.match(lines[0].until, /人工移除/);
  assert.deepEqual(readAlerts(paths), [], '挂起不发提醒');
});

test('SC8 CLI：add / remove / list，非法引用和缺条件被拒', async () => {
  const { home, paths, discover } = setup();
  const out = { text: '', write(chunk) { this.text += chunk; } };
  const err = { text: '', write(chunk) { this.text += chunk; } };
  const cli = (...argv) => runHoldCli(argv, { home, now: () => Date.parse(T0), stdout: out, stderr: err });

  assert.equal(cli('add', 'ExampleUser/demo', '--reason', 'x', '--manual'), 1);
  assert.match(err.text, /owner\/repo#n/);
  assert.equal(cli('add', 'ExampleUser/demo#0', '--reason', 'x', '--manual'), 1);
  assert.equal(cli('add', HELD, '--manual'), 1, '缺原因');
  assert.equal(cli('add', HELD, '--reason', 'x'), 1, '缺到期条件');
  assert.equal(cli('add', HELD, '--reason', 'x', '--manual', '--until-time', T0), 1, '两个到期条件');
  assert.equal(cli('add', HELD, '--reason', 'x', '--until-time', 'tomorrow'), 1, '时间不合法');
  assert.equal(cli('add', HELD, '--reason', 'x', '--until-merged', '../evil'), 1, '分支名不合法');
  assert.equal(fs.existsSync(holdFilePath(paths)), false, '被拒的命令不写文件');

  assert.equal(cli('add', HELD, '--reason', '等集成分支', '--until-merged', 'integration/demo', '--into', 'main'), 0);
  assert.equal(cli('add', FREE, '--reason', '等上游', '--manual'), 0);
  const saved = JSON.parse(fs.readFileSync(holdFilePath(paths), 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.holds[0], { issue: HELD, reason: '等集成分支', until: { type: 'merged', repo: REPO, branch: 'integration/demo', base: 'main' }, addedAt: T0 });
  assert.deepEqual(await discover(), []);

  out.text = '';
  assert.equal(cli('list'), 0);
  assert.match(out.text, new RegExp(`${HELD}\\t挂起中\\t.*integration/demo 合进 main`));
  assert.match(out.text, /人工移除前一直挂着\t等上游/);

  assert.equal(cli('remove', FREE), 0);
  assert.equal(cli('remove', FREE), 1, '不在名单里');
  assert.equal(cli('remove', 'bad ref'), 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(holdFilePath(paths), 'utf8')).holds.map((entry) => entry.issue), [HELD]);
  assert.deepEqual(await discover(), [FREE]);

  // 整份坏掉：拒绝写，不覆盖。
  fs.writeFileSync(holdFilePath(paths), 'garbage');
  assert.equal(cli('add', FREE, '--reason', 'x', '--manual'), 1);
  assert.equal(fs.readFileSync(holdFilePath(paths), 'utf8'), 'garbage');
  assert.equal(cli('list'), 1);
});

test('文档：docs/acceptance-prbot.md 有挂起一节', () => {
  const doc = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'acceptance-prbot.md'), 'utf8');
  for (const word of ['hold.json', 'prbot-hold.mjs', 'until-merged', 'prbot-hold-invalid', 'MERGED_PR_QUERY', '不经 PR 直推 main 要人工 remove', 'remaining-below-800']) {
    assert.ok(doc.includes(word), `文档没写「${word}」`);
  }
});

function setRemaining(paths, remaining, nowMs) {
  const reset = String(Math.floor(nowMs / 1000) + 3600);
  writeRateState(paths.rateState, recordHeader(emptyRateState(), {
    identity: 'user',
    remaining,
    reset,
    at: nowMs,
  }));
}

test('SC6 整份是合法 JSON 但不是预期对象：按全部不挂起处理，同一份内容只报一次 prbot-hold-invalid', async () => {
  const cases = [
    ['数组', '[]'],
    ['空对象', '{}'],
    ['数字', '1'],
    ['字符串', '"holds"'],
    ['null', 'null'],
  ];
  for (const [label, body] of cases) {
    const { paths, discover } = setup();
    fs.mkdirSync(paths.prbotDir, { recursive: true });
    fs.writeFileSync(holdFilePath(paths), body);
    assert.deepEqual(await discover(), [HELD, FREE], `${label} 应按不挂起处理`);
    assert.deepEqual(await discover(), [HELD, FREE]);
    assert.deepEqual(await discover(), [HELD, FREE]);
    const alerts = readAlerts(paths).filter((alert) => alert.kind === 'prbot-hold-invalid');
    assert.equal(alerts.length, 1, `${label} 应只报一次，实际 ${alerts.length}`);
    assert.match(alerts[0].detail, /应为 \{ "version": 1, "holds": \[\.\.\.\] \}/);
  }
});

test('空名单：发现结果与没有功能时一样，不发提醒、不查合入、不多写文件', async () => {
  const { paths, merged, discover } = setup();
  writeHolds(paths, []);
  const before = prbotFiles(paths);
  assert.deepEqual(await discover(), [HELD, FREE]);
  assert.deepEqual(prbotFiles(paths), before);
  assert.equal(merged.calls.length, 0);
  assert.deepEqual(readAlerts(paths), []);
});

test('SC6 单条 until 类型未知或缺字段：这一条继续挂着，未坏的条目照常判定', async () => {
  const { paths, discover } = setup();
  writeHolds(paths, [
    { issue: HELD, reason: '类型未知', until: { type: 'someday' } },
    { issue: FREE, reason: '缺 at', until: { type: 'time' } },
  ]);
  assert.deepEqual(await discover(), []);
  writeHolds(paths, [
    { issue: HELD, reason: '缺 branch', until: { type: 'merged', base: 'main' } },
    { issue: FREE, reason: '没写 until' },
  ]);
  assert.deepEqual(await discover(), []);
  const alerts = readAlerts(paths).filter((alert) => alert.kind === 'prbot-hold-invalid');
  assert.equal(alerts.length, 2, '两份不同内容各报一次');
});

test('同一 issue 重复条目：任意一条仍挂着则不认领，全部到期才解除', async () => {
  const { paths, time, discover } = setup();
  const at = '2026-10-24T06:00:00.000Z';
  writeHolds(paths, [
    { issue: HELD, reason: '已到期', until: { type: 'time', at }, addedAt: '2026-10-24T04:00:00.000Z' },
    { issue: HELD, reason: '还要挂', until: { type: 'manual' }, addedAt: '2026-10-24T04:01:00.000Z' },
  ]);
  time.set(Date.parse(at) + 1);
  assert.deepEqual(await discover(), [FREE], '有一条还挂着就不认领');
  writeHolds(paths, [
    { issue: HELD, reason: '到期甲', until: { type: 'time', at }, addedAt: '2026-10-24T04:00:00.000Z' },
    { issue: HELD, reason: '到期乙', until: { type: 'time', at }, addedAt: '2026-10-24T04:01:00.000Z' },
  ]);
  assert.deepEqual(await discover(), [HELD, FREE], '全部到期才解除');
});

test('issue 引用大小写不同视为同一条', async () => {
  const { paths, discover } = setup();
  writeHolds(paths, [{ issue: 'Example-Owner/Example-Repo#9', reason: '大小写', until: { type: 'manual' } }]);
  assert.deepEqual(await discover(), [FREE], 'example-owner/example-repo#9 应被 Example-Owner/Example-Repo#9 挂起');
});

test('SC5 查询抛出 RateLimitError 时保持挂起、不解除', async () => {
  const { paths, time, merged, discover } = setup();
  writeHolds(paths, [{ issue: HELD, reason: '等集成分支', until: { type: 'merged', branch: 'integration/demo', base: 'main' } }]);
  merged.answer = () => {
    throw new RateLimitError('API rate limit already exceeded', { remaining: '0', reset: String(Math.floor(Date.parse(T0) / 1000) + 3600) });
  };
  assert.deepEqual(await discover(), [FREE]);
  assert.equal(merged.calls.length, 1);
  time.set(Date.parse(T0) + HOLD_MERGE_CHECK_MIN_MS - 1);
  assert.deepEqual(await discover(), [FREE], '限流后 15 分钟内不再查，仍挂着');
  assert.equal(merged.calls.length, 1);
});

test('SC5 剩余低于 800 不发 MERGED_PR_QUERY；恰好 800 才查', async () => {
  const { paths, time, merged, discover } = setup();
  writeHolds(paths, [{ issue: HELD, reason: '等集成分支', until: { type: 'merged', branch: 'integration/demo', base: 'main' } }]);
  merged.answer = () => ({ repository: { pullRequests: { nodes: [{ number: 5, mergedAt: '2026-10-24T05:00:00Z' }] } } });
  setRemaining(paths, 799, Date.parse(T0));
  assert.deepEqual(await discover(), [FREE], '剩余 799：不查、不解除');
  assert.equal(merged.calls.length, 0);
  time.set(Date.parse(T0) + 1000);
  setRemaining(paths, 800, time.now());
  assert.deepEqual(await discover(), [HELD, FREE], '剩余恰好 800：放行查询，合入则解除');
  assert.equal(merged.calls.length, 1);
});

test('CLI --help 写明「不经 PR 直推 main 要人工 remove」', () => {
  const out = { text: '', write(chunk) { this.text += chunk; } };
  const err = { text: '', write(chunk) { this.text += chunk; } };
  const code = runHoldCli(['--help'], { stdout: out, stderr: err });
  assert.equal(code, 0);
  assert.equal(err.text, '');
  assert.match(out.text, /不经 PR 直推 main 要人工 remove/);
});
