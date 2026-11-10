// #62 老根单每日汇总：7 天判断、每日一次、只进摘要（不实时）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import {
  STALE_ROOT_MS,
  STALE_ROOT_STATE_FILE,
  digestDay,
  isRootTask,
  readStaleRootState,
  selectDueStaleRoots,
  staleRootDigest,
  staleRootOf,
  staleRootReasonText,
  writeStaleRootState,
} from './bin/stale-root.mjs';
import { appendAlert, hostPaths, readAlerts } from './host/paths.mjs';
import { classify, notifySlack } from './host/slack-notify.mjs';
import { digestBlocks } from './host/slack-blocks.mjs';
import { runTick } from './host/tick.mjs';
import { REPO, START_AT, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const CREATED = '2026-10-01T00:00:00.000Z';
const CREATED_MS = Date.parse(CREATED);
const PROFILE = { ownerLogin: 'ExampleUser', startAt: START_AT, autoRepos: ['example-owner/*'], watchRepos: [] };

function ref(number = 7) {
  return `${REPO}#${number}`;
}

function rootTask(overrides = {}) {
  return {
    ref: ref(),
    repo: REPO,
    number: 7,
    kind: 'standalone',
    tier: 'auto',
    state: 'open',
    createdAt: CREATED,
    url: `https://github.com/${REPO}/issues/7`,
    rounds: [],
    linkedPrs: [],
    children: [],
    body: 'body',
    bodyVersion: 'sha256:abc',
    ...overrides,
  };
}

function at(offsetMs) {
  return CREATED_MS + offsetMs;
}

test('#62 SC4 7 天判断的临界值：正好 7 天不报，少 1 秒不报，多 1 秒就报', () => {
  const task = rootTask();
  assert.equal(staleRootOf(task, { nowMs: at(STALE_ROOT_MS - 1000), profile: PROFILE }), null, '7 天差 1 秒：不报');
  assert.equal(staleRootOf(task, { nowMs: at(STALE_ROOT_MS), profile: PROFILE }), null, '正好 7 天：不算超过，不报');
  const hit = staleRootOf(task, { nowMs: at(STALE_ROOT_MS + 1000), profile: PROFILE });
  assert.ok(hit, '7 天多 1 秒：报');
  assert.equal(hit.ageDays, 7);
  assert.equal(hit.reason, 'no-merged-pr');
  assert.equal(hit.text, '没有已合并的 PR，验收机不会自动开始验收');
});

test('#62 SC4 进过验收的、有父的子单、已关闭的、这一拍就会触发的，都不报', () => {
  const nowMs = at(20 * DAY_MS);
  const rounds = [{ round: 1, status: '通过', bodyVersion: 'sha256:abc', createdAt: '2026-10-03T00:00:00.000Z' }];
  assert.equal(staleRootOf(rootTask({ rounds }), { nowMs, profile: PROFILE }), null, '有轮次记录：进过验收，不报');
  assert.equal(staleRootOf(rootTask({ kind: 'child' }), { nowMs, profile: PROFILE }), null, '子 issue：有父，不报');
  assert.equal(
    staleRootOf(rootTask({ kind: 'child', parentRef: ref(1) }), { nowMs, profile: PROFILE }),
    null,
    '子 issue 带 parentRef 也不报',
  );
  assert.equal(staleRootOf(rootTask({ state: 'closed', closedAt: '2026-10-05T00:00:00.000Z' }), { nowMs, profile: PROFILE }), null, '已关闭：不报');
  const merged = {
    linkedPrs: [{ ref: `${REPO}#9`, mergedAt: '2026-10-02T00:00:00.000Z', url: 'https://github.com/example-owner/example-repo/pull/9' }],
  };
  assert.equal(staleRootOf(rootTask(merged), { nowMs, profile: PROFILE }), null, '这一拍会触发（马上被认领）：不算漏单');
  // createdAt 读不出来：不猜年龄，不报。
  assert.equal(staleRootOf(rootTask({ createdAt: null }), { nowMs, profile: PROFILE }), null);
});

test('#62 SC4 总 issue（kind=parent，子 issue 还开着）也会报，原因是子单没关完', () => {
  const task = rootTask({
    kind: 'parent',
    children: [{ ref: ref(8), state: 'open', closedAt: null, url: `https://github.com/${REPO}/issues/8` }],
  });
  const hit = staleRootOf(task, { nowMs: at(10 * DAY_MS), profile: PROFILE });
  assert.ok(hit);
  assert.equal(hit.reason, 'children-open');
  assert.equal(hit.text, '子 issue 还没全部关闭，验收机要等子 issue 都关了才验总 issue');
});

test('#62 SC4 根单判定只认 parent / standalone；原因都翻成人话', () => {
  assert.equal(isRootTask({ kind: 'parent' }), true);
  assert.equal(isRootTask({ kind: 'standalone' }), true);
  assert.equal(isRootTask({ kind: 'child' }), false);
  assert.equal(isRootTask(null), false);
  assert.match(staleRootReasonText('no-merged-pr'), /没有已合并的 PR/);
  assert.match(staleRootReasonText('something-new'), /原因代码：something-new/);
  assert.equal(staleRootReasonText(undefined), '验收机这一拍没开始验收（原因代码：未知）');
});

test('#62 SC4 汇总顺序：建得最久的在前，同龄按 ref 升序', () => {
  const tasks = [
    rootTask({ ref: ref(2), number: 2, createdAt: '2026-10-03T00:00:00.000Z' }),
    rootTask({ ref: ref(1), number: 1, createdAt: '2026-10-01T00:00:00.000Z' }),
    rootTask({ ref: ref(3), number: 3, createdAt: '2026-10-03T00:00:00.000Z' }),
  ];
  const rows = staleRootDigest(tasks, { nowMs: at(20 * DAY_MS), profile: PROFILE });
  assert.deepEqual(rows.map((row) => row.ref), [ref(1), ref(2), ref(3)]);
});

test('#62 SC7 每日一次：同一天只报一次，不再符合条件就清掉，跨天再报', () => {
  const rows = [{ ref: ref(7) }, { ref: ref(8) }];
  const first = selectDueStaleRoots(rows, { days: {} }, '2026-10-24');
  assert.deepEqual(first.due.map((row) => row.ref), [ref(7), ref(8)]);
  assert.deepEqual(first.next, { [ref(7)]: '2026-10-24', [ref(8)]: '2026-10-24' });

  const sameDay = selectDueStaleRoots(rows, { days: first.next }, '2026-10-24');
  assert.deepEqual(sameDay.due, [], '同一天不重复报');

  const nextDay = selectDueStaleRoots([{ ref: ref(7) }], { days: first.next }, '2026-10-25');
  assert.deepEqual(nextDay.due.map((row) => row.ref), [ref(7)], '第二天再报一次');
  assert.deepEqual(nextDay.next, { [ref(7)]: '2026-10-25' }, '不再符合条件的 ref 从状态里清掉');

  // 同一天先报了、后来又变成符合条件（状态被清掉之后）：当天可以再报一次，不算刷屏源。
  const again = selectDueStaleRoots([{ ref: ref(8) }], { days: { [ref(7)]: '2026-10-24' } }, '2026-10-24');
  assert.deepEqual(again.due.map((row) => row.ref), [ref(8)]);
});

test('#62 SC7 状态文件：丢了 / 坏了都当没报过；写下去的内容能原样读回来', () => {
  const dir = tmpDir();
  const file = path.join(dir, STALE_ROOT_STATE_FILE);
  assert.deepEqual(readStaleRootState(file), { version: 1, days: {} }, '文件不在：当没报过');
  fs.writeFileSync(file, '{不是 json');
  assert.deepEqual(readStaleRootState(file), { version: 1, days: {} }, '坏文件：当没报过，不抛');
  writeStaleRootState(file, { days: { [ref(7)]: '2026-10-24' } });
  assert.deepEqual(readStaleRootState(file), { version: 1, days: { [ref(7)]: '2026-10-24' } });
  assert.equal(digestDay(Date.parse('2026-10-24T13:00:00.000Z')).length, 10);
  assert.equal(digestDay('nope'), null);
});

test('#62 SC5 老根单只进摘要：classify 归 digest（不实时），摘要一行带单号、完整链接和人话原因', () => {
  assert.equal(classify('alerts', { kind: 'stale-root', issue: ref(7) }), 'digest');
  const blocks = digestBlocks([
    { source: 'alerts', type: 'stale-root', kind: 'digest', issue: ref(7), reason: staleRootReasonText('no-merged-pr'), url: `https://github.com/${REPO}/issues/7` },
  ]);
  const text = JSON.stringify(blocks);
  assert.match(text, new RegExp(ref(7))), '带单号';
  assert.match(text, new RegExp(`https://github.com/${REPO}/issues/7`), '带完整 GitHub 链接');
  assert.match(text, /没有已合并的 PR/), '带人话原因';
  assert.doesNotMatch(text, /stale-root/, '不把内部 kind 名发出去');
});

test('#62 SC5 事件给的链接和 issue 对不上（伪造 / 指向别的仓）时按 issue 自己拼', () => {
  const forged = digestBlocks([
    { source: 'alerts', type: 'stale-root', kind: 'digest', issue: ref(7), reason: '没有已合并的 PR', url: 'https://github.com/someone-else/other/issues/7' },
  ]);
  const text = JSON.stringify(forged);
  assert.doesNotMatch(text, /someone-else/, '不把对不上的链接发出去');
  assert.match(text, new RegExp(`https://github.com/${REPO}/issues/7`));
});

// ---- 真 notify：先攒着，不到点不发；到点发一条摘要 ----

function fakeSlack() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({ path: new URL(req.url, 'http://127.0.0.1').pathname, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: `ts-${requests.length}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        apiBase: `http://127.0.0.1:${server.address().port}/api/`,
        requests,
        posts: () => requests.filter((entry) => entry.path.endsWith('/chat.postMessage')),
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function slackHome() {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const home = base.home;
  const tokenFile = writeSecret(path.join(home, 'secrets', 'slack.token'), 'fake-slack-bot-value-not-real');
  const profileFile = path.join(home, 'config', 'profile.json');
  const raw = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  fs.writeFileSync(
    profileFile,
    JSON.stringify({ ...raw, slackBotTokenFile: tokenFile, slackChannelId: 'C0123456789' }, null, 2),
  );
  return { home, profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }) };
}

test('#62 SC5 真 notify：老根单不立即发，攒到摘要窗口才发一条，内容带链接', async () => {
  const { home, profile } = slackHome();
  const t0 = Date.parse('2026-10-24T02:00:00.000Z');
  appendAlert(hostPaths(home), {
    kind: 'stale-root',
    issue: ref(7),
    reason: staleRootReasonText('no-merged-pr'),
    url: `https://github.com/${REPO}/issues/7`,
    ageDays: 23,
    now: () => t0,
  });
  const fake = await fakeSlack();
  try {
    const first = await notifySlack({ home, profile, now: () => t0, fetch: globalThis.fetch, apiBase: fake.apiBase });
    assert.equal(first.ok, true);
    assert.equal(fake.posts().length, 0, '不立即发（老化根单不进实时通知）');
    assert.equal(first.digested, 1, '攒进摘要');
    const later = t0 + 61 * 60 * 1000;
    const second = await notifySlack({ home, profile, now: () => later, fetch: globalThis.fetch, apiBase: fake.apiBase });
    assert.equal(second.sent, 1, '到点发一条摘要');
    const posts = fake.posts();
    assert.equal(posts.length, 1);
    const payload = JSON.parse(posts[0].body || '{}');
    assert.equal(payload.channel, 'C0123456789');
    assert.match(posts[0].body, new RegExp(`https://github.com/${REPO}/issues/7`), '摘要里带完整链接');
    assert.match(posts[0].body, /没有已合并的 PR/);
    assert.equal(/\*<@U/.test(String(payload.text)), false, '摘要不 @ 人');
  } finally {
    await fake.close();
  }
});

// ---- tick 接线：写一条 alerts，同一天不重复写 ----

function pollOutput(tasks) {
  return async () => ({ code: 0, stdout: JSON.stringify({ entries: [], tasks, reads: 1 }), stderr: '' });
}

async function tickAt(home, tasks, nowMs) {
  return runTick({
    home,
    env: { ...process.env },
    run: pollOutput(tasks),
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    notify: async () => ({ ok: true, sent: 0, digested: 0, pending: 0, deferred: 0, capped: 0, failed: [] }),
    now: () => nowMs,
  });
}

test('#62 SC5 tick 每拍把老根单写进 alerts.jsonl，同一天只写一次；第二天再写一次', async () => {
  const { home } = writeProfile(tmpDir());
  const tasks = [rootTask()];
  const day1 = at(20 * DAY_MS);
  const heartbeat = await tickAt(home, tasks, day1);
  assert.equal(heartbeat.lastTick.ok, true);
  assert.deepEqual(heartbeat.lastTick.staleRoots, { candidates: 1, reported: 1 });
  let alerts = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'stale-root');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].issue, ref(7));
  assert.equal(alerts[0].reason, '没有已合并的 PR，验收机不会自动开始验收');
  assert.equal(alerts[0].url, `https://github.com/${REPO}/issues/7`);
  assert.equal(alerts[0].ageDays, 20);
  assert.equal(fs.existsSync(path.join(hostPaths(home).hostDir, STALE_ROOT_STATE_FILE)), true);

  const sameDay = await tickAt(home, tasks, day1 + 3 * 60 * 60 * 1000);
  assert.deepEqual(sameDay.lastTick.staleRoots, { candidates: 1, reported: 0 }, '同一天不重复报');
  alerts = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'stale-root');
  assert.equal(alerts.length, 1, 'alerts.jsonl 里还是一行');

  const nextDay = await tickAt(home, tasks, day1 + DAY_MS);
  assert.deepEqual(nextDay.lastTick.staleRoots, { candidates: 1, reported: 1 }, '第二天再报一次');
  alerts = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'stale-root');
  assert.equal(alerts.length, 2);
});

test('#62 SC4 tick 里没有符合条件的单子就不写 alerts（不因为凑数乱报）', async () => {
  const { home } = writeProfile(tmpDir());
  const fresh = rootTask({ createdAt: '2026-10-20T00:00:00.000Z' });
  const heartbeat = await tickAt(home, [fresh], at(20 * DAY_MS));
  assert.deepEqual(heartbeat.lastTick.staleRoots, { candidates: 0, reported: 0 });
  assert.deepEqual(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'stale-root'), []);
});
