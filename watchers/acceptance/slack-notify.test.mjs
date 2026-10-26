// #61 Slack 通知：事件表、去重账本（含用频道历史重建）、摘要窗口、重试、令牌与遮罩、tick 接线。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { appendAlert, hostPaths, readAlerts } from './host/paths.mjs';
import { appendPrbotEvent } from './host/prbot-events.mjs';
import { maskList, sandboxEnv } from './host/sandbox.mjs';
import {
  BLOCKED_ALERT_KINDS,
  DEFAULT_DAILY_CAP,
  DIGEST_MINUTES,
  EXPECTED_GATE_REASONS,
  RETRY_MINUTES,
  TICK_FAILURE_KINDS,
  TICK_REPEAT_COUNT,
  TICK_REPEAT_WINDOW_MS,
  checkSlackAccess,
  classify,
  eventId,
  isExpectedRejection,
  notifySlack,
  readDailyCap,
  readSlackToken,
} from './host/slack-notify.mjs';
import { NOTICE_COPY } from './host/slack-blocks.mjs';
import { runTick } from './host/tick.mjs';
import { REPO, START_AT, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHANNEL = 'C0123456789';
const MENTION = 'U0123456789';
const TOKEN = 'fake-slack-bot-value-not-real';

// ---- 假 Slack：127.0.0.1 上起一个 http 服务，记下每个请求，按次给回答 ----

function fakeSlack(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const entry = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
      };
      requests.push(entry);
      let answer;
      try {
        answer = respond ? respond(entry, requests.length - 1) : undefined;
      } catch {
        answer = { status: 500, body: { ok: false, error: 'respond-threw' } };
      }
      const status = answer?.status ?? 200;
      const payload = JSON.stringify(answer?.body ?? { ok: true, ts: `ts-${requests.length}` });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        apiBase: `http://127.0.0.1:${server.address().port}/api/`,
        requests,
        posts: () => requests.filter((entry) => entry.path.endsWith('/chat.postMessage')),
        history: () => requests.filter((entry) => entry.path.endsWith('/conversations.history')),
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function withSlack(respond, fn) {
  const fake = await fakeSlack(respond);
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

function bodies(posts) {
  return posts.map((entry) => JSON.parse(entry.body || '{}'));
}

// ---- 夹具：home + profile + 令牌文件 ----

function setup(extra = {}) {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const home = base.home;
  const tokenFile = writeSecret(path.join(home, 'secrets', 'slack.token'), extra.tokenContent ?? TOKEN);
  const profileFile = path.join(home, 'config', 'profile.json');
  const raw = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  const next = { ...raw, slackBotTokenFile: tokenFile, slackChannelId: CHANNEL, slackMentionUserId: MENTION };
  if (extra.omitChannel) delete next.slackChannelId;
  if (extra.omitToken) delete next.slackBotTokenFile;
  fs.writeFileSync(profileFile, JSON.stringify(next, null, 2));
  return { home, tokenFile, raw, profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }) };
}

function prbotEvent(home, event, ts) {
  appendPrbotEvent(hostPaths(home), { at: new Date(ts).toISOString(), ...event }, { now: () => ts });
}

function alertEvent(home, entry, ts) {
  appendAlert(hostPaths(home), { ...entry, now: () => ts });
}

function readyEvent(overrides = {}) {
  return {
    type: 'ready',
    issue: `${REPO}#2`,
    root: `${REPO}#1`,
    item: `${REPO}#1`,
    sc: [3, 5],
    repo: REPO,
    pr: 12,
    prUrl: `https://github.com/${REPO}/pull/12`,
    headSha: 'abcdef1234567890',
    checks: { green: 3, total: 3, url: `https://github.com/${REPO}/pull/12/checks` },
    diff: { files: 3, additions: 10, deletions: 2 },
    handoff: 'owner',
    ...overrides,
  };
}

function ledgerFile(home) {
  return path.join(home, 'state', 'slack', 'ledger.json');
}

function readLedger(home) {
  return JSON.parse(fs.readFileSync(ledgerFile(home), 'utf8'));
}

// ---- 事件表 ----

test('事件表：每个 type / kind 是立即发、进摘要还是不（含未知 prbot type 忽略、未知 alert kind 进摘要）', () => {
  const cases = [
    ['prbot', { type: 'needs-human' }, 'blocked'],
    ['prbot', { type: 'interrupted-exhausted' }, 'blocked'],
    ['prbot', { type: 'ready-stalled' }, 'blocked'],
    ['prbot', { type: 'ready', handoff: 'owner' }, 'ready-to-merge'],
    ['prbot', { type: 'ready', handoff: 'watcher' }, 'finished'],
    ['prbot', { type: 'claimed' }, 'skip'],
    ['prbot', { type: 'draft-opened' }, 'skip'],
    ['prbot', { type: 'something-new' }, 'skip'],
    ['alerts', { kind: 'secret-found' }, 'blocked'],
    ['alerts', { kind: 'sandbox-unavailable' }, 'blocked'],
    // 写闸账本审计发现越规写入：立即发（审计自己已按违规指纹去重，不走 6 小时窗口）。
    ['alerts', { kind: 'gate-audit-violation' }, 'blocked'],
    // #43：首次卡住、写闸拒绝、调度循环停摆立即发（notifySlack 里再按 6 小时去重）。
    ['alerts', { kind: 'gate-rejected' }, 'blocked'],
    ['alerts', { kind: 'write-rejected' }, 'blocked'],
    ['alerts', { kind: 'round-stalled' }, 'blocked'],
    ['alerts', { kind: 'round-stale' }, 'blocked'],
    ['alerts', { kind: 'loop-restarted' }, 'blocked'],
    ['alerts', { kind: 'adjudicate-needs-human' }, 'blocked'],
    ['alerts', { kind: 'round-timeout' }, 'blocked'],
    ['alerts', { kind: 'sandbox-down' }, 'blocked'],
    ['alerts', { kind: 'prefetch-failed' }, 'blocked'],
    ['alerts', { kind: 'round-failed' }, 'blocked'],
    ['alerts', { kind: 'gate-unavailable' }, 'digest'],
    ['alerts', { kind: 'adjudicate-failed' }, 'digest'],
    ['alerts', { kind: 'slack-history-failed' }, 'digest'],
    // Slack 自己的发送失败不往 Slack 报（免得绕圈）。
    ['alerts', { kind: 'slack-failed' }, 'skip'],
    ['alerts', { kind: 'tick-failed' }, 'digest'],
    ['alerts', { kind: 'prbot-tick-failed' }, 'digest'],
    ['alerts', { kind: '从未见过的新提醒' }, 'digest'],
    ['alerts', { kind: 'egress-denied' }, 'skip'],
    ['alerts', { kind: 'gate-rejected', reason: 'query-not-allowed' }, 'skip'],
    ['alerts', { kind: 'gate-rejected', reason: 'repo-not-allowed' }, 'skip'],
    ['alerts', { kind: 'gate-rejected', reason: 'edit-not-allowed' }, 'skip'],
    ['alerts', { kind: 'gate-rejected', reason: 'needs-round-binding' }, 'blocked'],
    ['alerts', { kind: 'gate-rejected', detail: 'probe write' }, 'skip'],
    ['alerts', { kind: 'gate-rejected', probe: true }, 'skip'],
    ['alerts', { kind: 'round-failed', probe: true }, 'skip'],
  ];
  for (const [source, event, expected] of cases) {
    assert.equal(classify(source, event), expected, `${source} ${JSON.stringify(event)}`);
  }
  assert.deepEqual([...BLOCKED_ALERT_KINDS].sort(), ['gate-audit-violation', 'sandbox-unavailable', 'secret-found']);
  assert.deepEqual([...RETRY_MINUTES], [1, 5, 15]);
  assert.equal(DIGEST_MINUTES, 60);
});

test('事件 id = sha256(来源名 + 换行 + 原始行) 前 16 位；claimed / draft-opened 不发也不进摘要', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  await withSlack(undefined, async (fake) => {
    prbotEvent(home, { type: 'claimed', issue: `${REPO}#2`, root: `${REPO}#1` }, t0);
    prbotEvent(home, { type: 'draft-opened', issue: `${REPO}#2`, root: `${REPO}#1`, pr: 12 }, t0);
    const result = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fake.posts().length, 0, '两条都不发');
    assert.equal(result.digested, 0, '也不进摘要');
    assert.equal(result.pending, 0);

    const line = fs.readFileSync(hostPaths(home).prbotEventsFile, 'utf8').split('\n')[0];
    const expected = eventId('prbot', line);
    assert.match(expected, /^[0-9a-f]{16}$/);
    assert.ok(readLedger(home).ids.includes(expected), '处理过的 id 记在账本里');
    // SC1：目录 700、文件 600。
    const dirMode = fs.statSync(path.join(home, 'state', 'slack')).mode & 0o777;
    const fileMode = fs.statSync(ledgerFile(home)).mode & 0o777;
    assert.equal(dirMode, 0o700);
    assert.equal(fileMode, 0o600);
    assert.deepEqual(
      fs.readdirSync(path.join(home, 'state', 'slack')).filter((name) => name.endsWith('.tmp')),
      [],
      '原子写不留下半截临时文件',
    );
  });
});

// ---- 去重 ----

test('同一事件跑两拍只发一次', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  await withSlack(undefined, async (fake) => {
    const first = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(first.sent, 1);
    const second = await notifySlack({ home, profile, now: () => t0 + 60000, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(second.sent, 0);
    assert.equal(fake.posts().length, 1, '第二拍不重发');
  });
});

test('删掉账本后靠 conversations.history 的 metadata 不重发（按 cursor 分页，oldest = startAt 秒数）', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  const line = fs.readFileSync(hostPaths(home).prbotEventsFile, 'utf8').trim();
  const id = eventId('prbot', line);

  await withSlack(undefined, async (fake) => {
    await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(fake.posts().length, 1);
    fs.rmSync(path.join(home, 'state', 'slack'), { recursive: true, force: true });

    const rebuilt = await withSlack(
      (entry) => {
        if (entry.path.endsWith('/conversations.history')) {
          if (entry.query.cursor === 'page-2') {
            return {
              status: 200,
              body: {
                ok: true,
                messages: [{ metadata: { event_type: 'vigil_acceptance_notice', event_payload: { ids: [id] } } }],
                response_metadata: { next_cursor: '' },
              },
            };
          }
          return {
            status: 200,
            body: {
              ok: true,
              messages: [
                { text: '不是我们发的' },
                { metadata: { event_type: 'other_notice', event_payload: { ids: ['ffffffffffffffff'] } } },
              ],
              response_metadata: { next_cursor: 'page-2' },
            },
          };
        }
        return undefined;
      },
      async (second) => {
        const result = await notifySlack({ home, profile, now: () => t0 + 60000, fetch: second.fetch, apiBase: second.apiBase });
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(second.posts().length, 0, '重建之后不重发');
        assert.equal(second.history().length, 2, '按 cursor 翻了两页');
        assert.equal(second.history()[0].query.oldest, String(Math.floor(t0 / 1000)));
        assert.equal(second.history()[0].query.include_all_metadata, 'true');
        assert.equal(second.history()[0].query.channel, CHANNEL);
        assert.equal(second.history()[1].query.cursor, 'page-2');
        return result;
      },
    );
    const ledger = readLedger(home);
    assert.deepEqual(ledger.ids, [id]);
    assert.ok(ledger.rebuiltAt);
    assert.equal(rebuilt.ok, true);
  });
});

test('首次读历史失败：不补发历史、写 slack-history-failed 提醒，账本照常建，从现在起的新事件照发', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  await withSlack(
    (entry) =>
      entry.path.endsWith('/conversations.history') ? { status: 200, body: { ok: false, error: 'missing_scope' } } : undefined,
    async (fake) => {
      const result = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
      assert.equal(result.ok, false);
      assert.equal(result.reason, 'ledger-rebuild-failed');
      assert.equal(fake.posts().length, 0, '历史上的事件不补发');
      const ledger = readLedger(home);
      assert.ok(ledger.historyFailedAt, '账本照常建，记下读历史失败');
      const alert = readAlerts(hostPaths(home)).find((entry) => entry.kind === 'slack-history-failed');
      assert.ok(alert, '写一条 slack-history-failed 提醒');
      assert.match(alert.reason, /channels:history/);
      assert.match(alert.reason, /groups:history/);
      assert.match(alert.reason, /bot 要在频道里/);
      assert.match(alert.detail, /missing_scope/);

      // 下一拍：不再翻历史；新事件照发，那条提醒进摘要。
      prbotEvent(home, { type: 'needs-human', issue: `${REPO}#3`, root: `${REPO}#1`, reason: 'no-change' }, t0 + 60000);
      const next = await notifySlack({ home, profile, now: () => t0 + 60000, fetch: fake.fetch, apiBase: fake.apiBase });
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.equal(fake.history().length, 1, '只在没有账本时翻一次');
      assert.equal(fake.posts().length, 1, '新事件立即发');
      assert.match(fake.posts()[0].body, /#3/);
      assert.ok(readLedger(home).pending.some((item) => item.type === 'slack-history-failed'), '提醒进摘要');
    },
  );
});

// ---- 摘要 ----

test('摘要攒满 60 分钟才发一条，且不 @', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  alertEvent(home, { kind: 'tick-failed', reason: '这一拍出错' }, t0);
  await withSlack(undefined, async (fake) => {
    const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });

    const first = await send(t0);
    assert.equal(first.sent, 0);
    assert.equal(first.digested, 1);
    assert.equal(first.pending, 1);
    assert.equal(fake.posts().length, 0, '刚进来只攒着');

    alertEvent(home, { kind: 'adjudicate-failed', issue: `${REPO}#3`, reason: '裁决出错' }, t0 + 30 * 60000);
    const second = await send(t0 + 30 * 60000);
    assert.equal(second.pending, 2);
    assert.equal(fake.posts().length, 0, '30 分钟还不到点');

    const third = await send(t0 + 59 * 60000);
    assert.equal(third.sent, 0);
    assert.equal(fake.posts().length, 0);

    const fourth = await send(t0 + 61 * 60000);
    assert.equal(fourth.sent, 1, '到点发一条');
    assert.equal(fourth.pending, 0);
    assert.equal(fake.posts().length, 1, '最多每 60 分钟一条');
    const body = fake.posts()[0].body;
    assert.match(body, /验收机摘要（2 条，不紧急）/);
    assert.match(body, /验收机有一拍调度出错/);
    assert.match(body, /裁决运行失败一次，会自动重试/);
    assert.equal(body.includes('tick-failed'), false, '摘要不出现 kind 代码名');
    assert.equal(body.includes('adjudicate-failed'), false, '摘要不出现 kind 代码名');
    assert.equal(body.includes(`<@${MENTION}>`), false, '摘要不 @');
    assert.deepEqual(readLedger(home).pending, []);
    assert.equal(readLedger(home).digestNextAt, null);
  });
});

test('ping 配了 slackMentionUserId 就 @，摘要永不 @', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'ready', ...readyEvent() }, t0);
  alertEvent(home, { kind: 'tick-failed', issue: `${REPO}#9`, reason: '这一拍出错' }, t0);
  await withSlack(undefined, async (fake) => {
    await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    const [ping] = bodies(fake.posts());
    assert.match(ping.text, new RegExp(`^<@${MENTION}> `), 'ping 开头 @');
    assert.match(JSON.stringify(ping.blocks), new RegExp(`<@${MENTION}>`));
    const digest = await notifySlack({ home, profile, now: () => t0 + 61 * 60000, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(digest.sent, 1);
    const summary = bodies(fake.posts())[1];
    assert.match(summary.text, /^验收机摘要/);
    assert.equal(JSON.stringify(summary).includes(`<@${MENTION}>`), false, '摘要永不 @');
  });
});

test('同一 issue 6 小时内的第 2 次中断合成一条「同一任务连续中断」，第 3 次不再发', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  await withSlack(undefined, async (fake) => {
    const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });
    alertEvent(home, { kind: 'round-failed', issue: `${REPO}#3`, round: 1, reason: '第 1 次' }, t0);
    const first = await send(t0);
    assert.equal(first.sent, 1, '第一次 round-failed 立即发');
    assert.equal(fake.posts().length, 1);
    assert.match(fake.posts()[0].body, /验收轮次出错，已自动中止/);
    assert.ok(fake.posts()[0].body.includes(`<@${MENTION}>`));

    alertEvent(home, { kind: 'round-failed', issue: `${REPO}#3`, round: 2, reason: '第 2 次' }, t0 + 2 * 60000);
    const second = await send(t0 + 2 * 60000);
    assert.equal(second.sent, 1, '第二次合成一条立即发');

    alertEvent(home, { kind: 'round-failed', issue: `${REPO}#3`, round: 3, reason: '第 3 次' }, t0 + 4 * 60000);
    const third = await send(t0 + 4 * 60000);
    assert.equal(third.sent, 0, '同一窗口只发一次');
    assert.equal(fake.posts().length, 2);
    const body = fake.posts()[1].body;
    assert.match(body, /同一任务 6 小时内反复中断/);
    assert.match(body, /中断了 2 次/);
    assert.ok(body.includes(`${REPO}#3`));
    assert.equal(body.includes('第 3 次'), false);
  });
});

// ---- Ready 消息（走真发一遍，确认落到 chat.postMessage 上） ----

test('SC2 Ready owner：一个「打开 PR」按钮、没有「合并」；watcher：已交给 Mac mini 盯梢、无按钮', async () => {
  const owner = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(owner.home, { type: 'ready', ...readyEvent() }, t0);
  await withSlack(undefined, async (fake) => {
    await notifySlack({ home: owner.home, profile: owner.profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    const [body] = bodies(fake.posts());
    assert.equal(body.channel, CHANNEL);
    assert.match(body.text, /修正 PR 已 Ready/);
    const elements = (body.blocks || []).flatMap((block) => block.elements || []).filter((element) => element.type === 'button');
    assert.equal(elements.length, 1);
    assert.equal(elements[0].text.text, '打开 PR');
    assert.equal(elements[0].url, `https://github.com/${REPO}/pull/12`);
    assert.equal(fake.posts()[0].body.includes('合并'), false);
    assert.deepEqual(body.metadata.event_payload.ids, [readLedger(owner.home).ids[0]], '消息带 id metadata');
    assert.equal(body.metadata.event_type, 'vigil_acceptance_notice');
  });

  const watcher = setup();
  prbotEvent(watcher.home, { type: 'ready', ...readyEvent({ handoff: 'watcher' }) }, t0);
  await withSlack(undefined, async (fake) => {
    await notifySlack({ home: watcher.home, profile: watcher.profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    const [body] = bodies(fake.posts());
    assert.match(body.text, /已交给 Mac mini 盯梢/);
    assert.equal(JSON.stringify(body.blocks).includes('"type":"button"'), false, 'watcher 档没有按钮');
    assert.equal(body.text.includes(`https://github.com/${REPO}/pull/12`), true);
    assert.equal(body.text.includes('合并'), false);
  });
});

test('伪造 prUrl 在真发出去的消息里被替换；ready-stalled 文案用人话写审查流程不在线', async () => {
  const forged = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(forged.home, { type: 'ready', ...readyEvent({ prUrl: 'https://github.com/example-org/other-repo/pull/99' }) }, t0);
  await withSlack(undefined, async (fake) => {
    await notifySlack({ home: forged.home, profile: forged.profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    const body = fake.posts()[0].body;
    assert.equal(body.includes('other-repo'), false);
    assert.ok(body.includes(`https://github.com/${REPO}/pull/12`));
  });

  const stalled = setup();
  prbotEvent(
    stalled.home,
    { type: 'ready-stalled', ...readyEvent({ type: 'ready-stalled', handoff: 'watcher', readyAt: '2026-01-05T00:00:00.000Z' }) },
    t0,
  );
  await withSlack(undefined, async (fake) => {
    await notifySlack({ home: stalled.home, profile: stalled.profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    const [body] = bodies(fake.posts());
    const whole = JSON.stringify(body);
    assert.match(body.text, /修正 PR 转 Ready 24 小时没人接/);
    assert.match(whole, /多半是审查流程不在线，请看 Mac mini 和审查入口/);
    assert.equal(whole.includes('review-ingress-missing'), false);
    assert.match(whole, /2026-01-05T00:00:00\.000Z/, '附转 Ready 时间');
    assert.ok(whole.includes(`https://github.com/${REPO}/pull/12`), '附 PR 链接');
    assert.match(whole, /abcdef1/, 'head 前 7 位');
  });
});

test('secret-found 只发文件名', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  alertEvent(home, { kind: 'secret-found', issue: `${REPO}#3`, reason: 'branch.push 扫到疑似密钥，没推：src/a.js, b.txt' }, t0);
  await withSlack(undefined, async (fake) => {
    await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    const body = fake.posts()[0].body;
    assert.match(body, /src\/a\.js, b\.txt/);
    assert.equal(body.includes('branch.push'), false);
  });
});

// ---- 令牌 ----

test('令牌只出现在 Authorization 头：不进请求 body、账本、返回值、stdout / stderr', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  alertEvent(home, { kind: 'round-failed', issue: `${REPO}#3`, reason: '宿主出错' }, t0);

  const chunks = [];
  const restore = [process.stdout, process.stderr].map((stream) => {
    const original = stream.write.bind(stream);
    stream.write = (chunk, ...rest) => {
      chunks.push(String(chunk));
      return original(chunk, ...rest);
    };
    return () => {
      stream.write = original;
    };
  });

  let result;
  try {
    await withSlack(undefined, async (fake) => {
      result = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
      for (const entry of fake.requests) {
        assert.equal(entry.headers.authorization, `Bearer ${TOKEN}`, '令牌只在 Authorization 头');
        assert.equal(entry.body.includes(TOKEN), false, 'body 里没有令牌');
        assert.equal(JSON.stringify(entry.query).includes(TOKEN), false, 'query 里没有令牌');
      }
    });
  } finally {
    for (const undo of restore) undo();
  }

  assert.equal(JSON.stringify(result).includes(TOKEN), false, '返回值里没有令牌');
  assert.equal(JSON.stringify(readLedger(home)).includes(TOKEN), false, '账本里没有令牌');
  assert.equal(chunks.join('').includes(TOKEN), false, 'stdout / stderr 里没有令牌');
});

test('设了 ACCEPTANCE_SLACK_BOT_TOKEN 也不用：用的一直是文件里的值', async () => {
  const { home } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  await withSlack(undefined, async (fake) => {
    const result = await notifySlack({
      home,
      env: { ACCEPTANCE_WATCHER_HOME: home, ACCEPTANCE_SLACK_BOT_TOKEN: 'another-value-not-real', SLACK_BOT_TOKEN: 'another-value-not-real' },
      now: () => t0,
      fetch: fake.fetch,
      apiBase: fake.apiBase,
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fake.posts().length, 1);
    assert.equal(fake.posts()[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(fake.posts()[0].body.includes('another-value-not-real'), false);
  });
});

test('令牌文件 644 / 符号链接 / 空文件时不发，只报原因（原因里不带令牌）', async () => {
  const t0 = Date.parse(START_AT);

  // 644
  const loose = setup();
  fs.chmodSync(loose.tokenFile, 0o644);
  // 符号链接
  const linked = setup();
  const target = writeSecret(path.join(linked.home, 'secrets', 'real.token'), 'fake-slack-bot-value-real-target');
  fs.rmSync(linked.tokenFile);
  fs.symlinkSync(target, linked.tokenFile);
  // 空文件
  const empty = setup();
  fs.writeFileSync(empty.tokenFile, '');
  fs.chmodSync(empty.tokenFile, 0o600);

  const cases = [
    ['mode', loose, { ...loose.profile, slackBotTokenFile: loose.tokenFile }],
    ['symlink', linked, { ...linked.profile, slackBotTokenFile: linked.tokenFile }],
    ['empty', empty, { ...empty.profile, slackBotTokenFile: empty.tokenFile }],
  ];
  for (const [name, fixture, profile] of cases) {
    prbotEvent(fixture.home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
    await withSlack(undefined, async (fake) => {
      const result = await notifySlack({ home: fixture.home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
      assert.equal(result.ok, false, name);
      assert.match(String(result.reason), /^token-file-/, `${name}：${result.reason}`);
      assert.equal(fake.requests.length, 0, `${name} 一条请求都不发`);
      assert.equal(JSON.stringify(result).includes('fake-slack-bot-value'), false);
    });
  }

  assert.deepEqual(readSlackToken(path.join(HERE, 'no-such-token')), { ok: false, reason: 'token-file-unreadable' });
  assert.equal(readSlackToken(empty.tokenFile).ok, false, '空文件读不出令牌');
  assert.equal(readSlackToken(loose.tokenFile).reason, 'token-file-mode');
});

test('没配令牌或频道就不发、不抛；profile 加载失败返回 profile-error', async () => {
  const t0 = Date.parse(START_AT);

  const noChannel = setup({ omitChannel: true });
  prbotEvent(noChannel.home, { type: 'needs-human', issue: `${REPO}#2`, reason: 'x' }, t0);
  await withSlack(undefined, async (fake) => {
    const result = await notifySlack({ home: noChannel.home, profile: noChannel.profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'not-configured');
    assert.equal(fake.requests.length, 0);
  });

  const noToken = setup({ omitToken: true });
  await withSlack(undefined, async (fake) => {
    const result = await notifySlack({ home: noToken.home, profile: noToken.profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(result.reason, 'not-configured');
    assert.equal(fake.requests.length, 0);
  });

  // 频道 id 格式不对也算没配（profile 里手改坏了也不会乱发）。
  const badChannel = setup();
  await withSlack(undefined, async (fake) => {
    const result = await notifySlack({
      home: badChannel.home,
      profile: { ...badChannel.profile, slackChannelId: 'not-a-channel' },
      now: () => t0,
      fetch: fake.fetch,
      apiBase: fake.apiBase,
    });
    assert.equal(result.reason, 'not-configured');
    assert.equal(fake.requests.length, 0);
  });

  // home 里根本没有 profile.json。
  const bare = tmpDir();
  await withSlack(undefined, async (fake) => {
    const result = await notifySlack({ home: bare, env: {}, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'profile-error');
    assert.equal(fake.requests.length, 0);
  });
});

// ---- 重试 ----

test('发送失败按 1、5、15 分钟重试，第 4 次失败放弃并记进心跳的 failed', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  await withSlack(
    (entry) => (entry.path.endsWith('/chat.postMessage') ? { status: 500, body: { ok: false, error: 'boom' } } : undefined),
    async (fake) => {
      const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });

      const first = await send(t0);
      assert.equal(first.ok, false);
      assert.equal(first.reason, 'send-failed');
      assert.equal(fake.posts().length, 1);
      assert.equal(fake.posts().length, 1);
      let retry = readLedger(home).retry;
      assert.equal(retry.length, 1);
      assert.equal(retry[0].attempts, 1);
      assert.equal(Date.parse(retry[0].nextAttemptAt), t0 + RETRY_MINUTES[0] * 60000);

      // 不到 1 分钟不重试。
      const tooEarly = await send(t0 + 30000);
      assert.equal(tooEarly.sent, 0);
      assert.equal(fake.posts().length, 1, '还没到点');

      const second = await send(t0 + RETRY_MINUTES[0] * 60000);
      assert.equal(second.ok, false);
      assert.equal(fake.posts().length, 2);
      retry = readLedger(home).retry;
      assert.equal(retry[0].attempts, 2);
      assert.equal(Date.parse(retry[0].nextAttemptAt), t0 + 60000 + RETRY_MINUTES[1] * 60000);

      const third = await send(t0 + 60000 + RETRY_MINUTES[1] * 60000);
      assert.equal(fake.posts().length, 3);
      retry = readLedger(home).retry;
      assert.equal(retry[0].attempts, 3);
      assert.equal(Date.parse(retry[0].nextAttemptAt), t0 + 60000 + 300000 + RETRY_MINUTES[2] * 60000);

      const fourth = await send(t0 + 60000 + 300000 + RETRY_MINUTES[2] * 60000);
      assert.equal(fake.posts().length, 4, '一共 4 次尝试');
      assert.equal(fourth.ok, false);
      assert.equal(fourth.failed.length, 1);
      assert.equal(fourth.failed[0].kind, 'blocked');
      assert.equal(typeof fourth.failed[0].id, 'string');
      assert.equal(typeof fourth.failed[0].error, 'string');
      assert.deepEqual(readLedger(home).retry, [], '放弃了就不再排重试');
      assert.equal(readLedger(home).failed.length, 1);

      // 放弃之后不再发。
      const later = await send(t0 + 3600000);
      assert.equal(later.sent, 0);
      assert.equal(fake.posts().length, 4);
    },
  );
});

test('一次 429 之后按时重试成功：总共只发一条，id 记进账本', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  let postCount = 0;
  await withSlack(
    (entry) => {
      if (!entry.path.endsWith('/chat.postMessage')) return undefined;
      postCount += 1;
      return postCount === 1 ? { status: 429, body: { ok: false, error: 'ratelimited' } } : undefined;
    },
    async (fake) => {
      const first = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
      assert.equal(first.ok, false);
      assert.equal(first.sent, 0);
      assert.equal(fake.posts().length, 1);
      assert.equal(readLedger(home).retry.length, 1);

      const second = await notifySlack({
        home,
        profile,
        now: () => t0 + RETRY_MINUTES[0] * 60000,
        fetch: fake.fetch,
        apiBase: fake.apiBase,
      });
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(second.sent, 1);
      assert.equal(fake.posts().length, 2);
      assert.deepEqual(readLedger(home).retry, []);
      assert.equal(readLedger(home).ids.length, 1);
    },
  );
});

test('ok:false（HTTP 200）也算失败：不进账本的成功列表，按 1 分钟排重试', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  await withSlack(
    (entry) => (entry.path.endsWith('/chat.postMessage') ? { status: 200, body: { ok: false, error: 'channel_not_found' } } : undefined),
    async (fake) => {
      const result = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
      assert.equal(result.ok, false);
      assert.equal(result.sent, 0);
      const ledger = readLedger(home);
      assert.equal(ledger.retry.length, 1);
      assert.equal(ledger.retry[0].attempts, 1);
      assert.equal(ledger.retry[0].payload.ids.length, 1, '重试条目带消息和 id');
      assert.equal(JSON.stringify(ledger.ids).includes(ledger.retry[0].id), true, '已交给重试，不再当新事件');
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
    },
  );
});

// ---- tick 接线 ----

async function tickHome() {
  const { home, profile, tokenFile } = setup();
  return { home, profile, tokenFile };
}

const POLL_OK = async () => ({ code: 0, stdout: '[]', stderr: '' });

test('runTick 在验收调度之后调 notify，结果写进 heartbeat.slack（文件里也有）', async () => {
  const { home } = await tickHome();
  const calls = [];
  const order = [];
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: async (...args) => {
      order.push('poll');
      return POLL_OK(...args);
    },
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    notify: async (options) => {
      calls.push(options);
      order.push('notify');
      return { ok: true, sent: 2, digested: 1, pending: 3, failed: [{ id: 'abc', kind: 'blocked', error: 'http-500' }] };
    },
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].home, home, 'notify 拿到 home');
  assert.deepEqual(order, ['poll', 'notify'], '验收调度先跑，Slack 后发');
  assert.deepEqual(heartbeat.slack, {
    ok: true,
    sent: 2,
    digested: 1,
    pending: 3,
    deferred: 0,
    failed: [{ id: 'abc', kind: 'blocked', error: 'http-500' }],
  });
  const onDisk = JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
  assert.deepEqual(onDisk.slack, heartbeat.slack);
});

test('notify 抛错只进心跳，这一拍照常跑完', async () => {
  const { home } = await tickHome();
  const heartbeat = await runTick({
    home,
    env: { ...process.env },
    run: POLL_OK,
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    notify: async () => {
      throw new Error('notify 炸了');
    },
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(heartbeat.slack.ok, false);
  assert.equal(heartbeat.slack.reason, 'notify-error');
  assert.equal(heartbeat.lastTick.ok, true, '这一拍本身没受影响');
  assert.deepEqual(heartbeat.lastTick.error, null);
});

test('runTick 用真 notify：心跳里的 slack 就是这一拍的发送结果，没配也不抛', async () => {
  const { home } = await tickHome();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  await withSlack(undefined, async (fake) => {
    const heartbeat = await runTick({
      home,
      env: { ...process.env },
      run: POLL_OK,
      spawnRound: () => 1,
      runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
      now: () => t0,
      notifyOptions: { fetch: fake.fetch, apiBase: fake.apiBase },
    });
    assert.equal(heartbeat.slack.ok, true, JSON.stringify(heartbeat.slack));
    assert.equal(heartbeat.slack.sent, 1);
    assert.equal(fake.posts().length, 1);
    const stored = JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
    assert.equal(stored.slack.sent, 1);
    assert.equal(JSON.stringify(stored).includes(TOKEN), false, '心跳里没有令牌');
  });

  // 没配 Slack 的 profile：不发、不抛，心跳里说明原因；没配 = 通报已关闭，算正常（ok=true）。
  const plain = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const heartbeat = await runTick({
    home: plain.home,
    env: { ...process.env },
    run: POLL_OK,
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => t0,
  });
  assert.equal(heartbeat.slack.ok, true);
  assert.equal(heartbeat.slack.reason, 'not-configured');
  assert.equal(heartbeat.lastTick.ok, true);
});

test('令牌文件权限不对 / 读不到：整台机照常跑这一拍，跳过通知，心跳记原因，令牌一个字节都不读', async () => {
  const t0 = Date.parse(START_AT);
  const cases = {
    mode644: { spoil: (file) => fs.chmodSync(file, 0o644), reasons: ['token-file-mode'] },
    mode640: { spoil: (file) => fs.chmodSync(file, 0o640), reasons: ['token-file-mode'] },
    // root 下 000 也打得开，这时靠权限检查拦住；普通用户下 open 就失败。两种都不读内容。
    mode000: { spoil: (file) => fs.chmodSync(file, 0o000), reasons: ['token-file-mode', 'token-file-unreadable'] },
    missing: { spoil: (file) => fs.rmSync(file), reasons: ['token-file-unreadable'] },
  };
  for (const [name, { spoil, reasons }] of Object.entries(cases)) {
    const { home, tokenFile } = await tickHome();
    spoil(tokenFile);
    prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
    // 记下打开令牌文件得到的 fd，确认之后既没有 readFileSync 也没有 readSync 碰过它。
    const tokenFds = new Set();
    const reads = [];
    const realOpen = fs.openSync;
    const realReadFile = fs.readFileSync;
    const realRead = fs.readSync;
    fs.openSync = function (file, ...rest) {
      const fd = realOpen.call(this, file, ...rest);
      if (String(file) === tokenFile) tokenFds.add(fd);
      return fd;
    };
    fs.readFileSync = function (file, ...rest) {
      if (String(file) === tokenFile || tokenFds.has(file)) reads.push(['readFileSync', file]);
      return realReadFile.call(this, file, ...rest);
    };
    fs.readSync = function (fd, ...rest) {
      if (tokenFds.has(fd)) reads.push(['readSync', fd]);
      return realRead.call(this, fd, ...rest);
    };
    try {
      await withSlack(undefined, async (fake) => {
        let spawned = 0;
        const heartbeat = await runTick({
          home,
          env: { ...process.env },
          run: POLL_OK,
          spawnRound: () => {
            spawned += 1;
            return 1;
          },
          runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
          now: () => t0,
          notifyOptions: { fetch: fake.fetch, apiBase: fake.apiBase },
        });
        assert.equal(heartbeat.lastTick.ok, true, `${name}：这一拍照常跑完 ${JSON.stringify(heartbeat.lastTick)}`);
        assert.equal(heartbeat.slack.ok, false, name);
        assert.ok(reasons.includes(heartbeat.slack.reason), `${name}：${heartbeat.slack.reason}`);
        assert.equal(fake.requests.length, 0, `${name}：一条 Slack 请求都不发`);
        const stored = JSON.parse(realReadFile(hostPaths(home).heartbeatFile, 'utf8'));
        assert.equal(stored.slack.reason, heartbeat.slack.reason, `${name}：原因写进心跳文件`);
        assert.equal(JSON.stringify(stored).includes(TOKEN), false);
        assert.equal(spawned, 0, 'POLL_OK 没有待验收的条目');
      });
    } finally {
      fs.openSync = realOpen;
      fs.readFileSync = realReadFile;
      fs.readSync = realRead;
      try {
        fs.chmodSync(tokenFile, 0o600);
      } catch {
        // 已经删了。
      }
    }
    assert.deepEqual(reads, [], `${name}：令牌文件没被读`);
  }
});

test('#70 复审：Slack 卡死时这一拍按上限返回（notify-timeout），上一拍的还没完就不再起（notify-busy）', async () => {
  const { home } = await tickHome();
  let release;
  const hung = new Promise((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const notify = () => {
    calls += 1;
    return hung;
  };
  const tick = () =>
    runTick({
      home,
      env: { ...process.env },
      run: POLL_OK,
      spawnRound: () => 1,
      runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
      notify,
      notifyWaitMs: 100,
      now: () => Date.parse('2026-10-24T02:00:00.000Z'),
    });
  try {
    const startedAt = Date.now();
    const first = await tick();
    assert.ok(Date.now() - startedAt < 3000, '不等卡死的 Slack');
    assert.equal(first.slack.reason, 'notify-timeout');
    assert.equal(first.lastTick.ok, true);
    const onDisk = JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
    assert.equal(onDisk.slack.reason, 'notify-timeout', '心跳文件照常写');
    const second = await tick();
    assert.equal(second.slack.reason, 'notify-busy');
    assert.equal(calls, 1, '上一拍的通知没结束，不再起第二份');
  } finally {
    release({ ok: true, sent: 0, digested: 0, pending: 0, failed: [] });
  }
  await hung;
  await new Promise((resolve) => setImmediate(resolve));
  const third = await tick();
  assert.equal(calls, 2, '上一份结束后照常发');
  assert.equal(third.slack.ok, true);
});

test('#70 复审：notifySlack 有总预算：用完就停，没发的新事件下拍再发、不算已处理', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  for (const n of [2, 3, 4]) prbotEvent(home, { type: 'needs-human', issue: `${REPO}#${n}`, root: `${REPO}#1`, reason: 'no-change' }, t0 + n);
  // 假时钟：每个请求花 20 秒；预算 30 秒 → 发两条，第三条留到下拍。
  let fakeNow = 0;
  const posted = [];
  const slowFetch = async (url, init) => {
    posted.push(JSON.parse(init.body).text);
    fakeNow += 20000;
    return { status: 200, json: async () => ({ ok: true, ts: String(posted.length) }) };
  };
  const first = await notifySlack({ home, profile, now: () => t0, fetch: slowFetch, clock: () => fakeNow, budgetMs: 30000 });
  assert.equal(first.sent, 2);
  assert.equal(first.deferred, 1);
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'notify-budget-exhausted');
  assert.equal(readLedger(home).ids.length, 2, '留到下拍的那条不记成已处理');
  fakeNow = 0;
  const second = await notifySlack({ home, profile, now: () => t0, fetch: slowFetch, clock: () => fakeNow, budgetMs: 30000 });
  assert.equal(second.sent, 1);
  assert.equal(second.deferred, 0);
  assert.equal(second.ok, true);
  assert.equal(posted.length, 3, '三条各发一次');
  assert.equal(new Set(posted).size, 3);
});

test('#70 复审：每个请求的超时随预算缩短：Slack 不回话时按预算返回，而不是等满 15 秒', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  for (const n of [2, 3]) prbotEvent(home, { type: 'needs-human', issue: `${REPO}#${n}`, root: `${REPO}#1`, reason: 'x' }, t0 + n);
  const sockets = new Set();
  const server = http.createServer(() => {
    // 故意一直不回。
  });
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const startedAt = Date.now();
    const result = await notifySlack({
      home,
      profile,
      now: () => t0,
      apiBase: `http://127.0.0.1:${server.address().port}/api/`,
      requestTimeoutMs: 15000,
      budgetMs: 300,
    });
    const took = Date.now() - startedAt;
    assert.ok(took < 3000, `按预算返回（用了 ${took} ms）`);
    assert.equal(result.ok, false);
    assert.equal(result.deferred, 1, '第二条没时间发，留到下拍');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('#70 复审：预算一开始就没了：到期的重试、到点的摘要都原样留着，账本坏了也不去翻频道历史', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  const past = new Date(t0 - 60000).toISOString();
  const retryEntry = {
    id: 'retry-1',
    kind: 'blocked',
    payload: { text: '旧提醒', blocks: [], ids: ['retry-1'] },
    attempts: 1,
    nextAttemptAt: past,
  };
  const pendingItem = { id: 'digest-1', source: 'alerts', type: 'interrupted', kind: 'digest', issue: `${REPO}#2` };
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    ledgerFile(home),
    JSON.stringify({ version: 1, ids: [], pending: [pendingItem], digestNextAt: past, retry: [retryEntry] }),
    { mode: 0o600 },
  );
  let calls = 0;
  const countingFetch = async () => {
    calls += 1;
    return { status: 200, json: async () => ({ ok: true, ts: '1', messages: [] }) };
  };
  const result = await notifySlack({ home, profile, now: () => t0, fetch: countingFetch, clock: () => 0, budgetMs: 0 });
  assert.equal(calls, 0, '一条都不发');
  assert.equal(result.deferred, 2, '重试一条 + 摘要一条');
  assert.equal(result.reason, 'notify-budget-exhausted');
  const ledger = readLedger(home);
  assert.deepEqual(ledger.retry, [retryEntry], '重试原样留着，次数不加');
  assert.deepEqual(ledger.pending, [pendingItem], '摘要原样留着');
  assert.equal(ledger.digestNextAt, past);

  // 账本没了要翻频道历史重建：预算没了就不翻（也不发），下拍再说。
  fs.rmSync(ledgerFile(home));
  const rebuilt = await notifySlack({ home, profile, now: () => t0, fetch: countingFetch, clock: () => 0, budgetMs: 0 });
  assert.equal(calls, 0, '不翻历史');
  assert.equal(rebuilt.reason, 'ledger-rebuild-failed');
  assert.equal(fs.existsSync(ledgerFile(home)), false);
});

test('#70 复审：令牌文件属主不是当前用户就不读、不发（token-file-owner）', async () => {
  const { home, profile, tokenFile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'x' }, t0);
  const realGetuid = process.getuid;
  // 测试里没法 chown（不是 root），改成让「当前用户」变成另一个 uid：文件属主就对不上了。
  process.getuid = () => fs.statSync(tokenFile).uid + 1;
  try {
    assert.deepEqual(readSlackToken(tokenFile), { ok: false, reason: 'token-file-owner' });
    await withSlack(undefined, async (fake) => {
      const result = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
      assert.equal(result.reason, 'token-file-owner');
      assert.equal(fake.requests.length, 0);
    });
  } finally {
    process.getuid = realGetuid;
  }
  assert.equal(readSlackToken(tokenFile).ok, true, '属主对上就能读');
});

// ---- 沙箱遮罩契约 ----

test('bwrap 遮罩：maskList 把 slackBotTokenFile 列进 files；sandboxEnv 不带任何 Slack 令牌环境变量', () => {
  const { home, tokenFile, raw, profile } = setup();
  const ownHome = tmpDir();
  const masks = maskList({
    rawProfile: { ...raw, slackBotTokenFile: tokenFile },
    profile,
    env: { HOME: ownHome },
    home,
  });
  assert.ok(masks.files.includes(fs.realpathSync(tokenFile)), `遮罩名单里要有 Slack 令牌文件：${JSON.stringify(masks.files)}`);

  const env = sandboxEnv({
    base: {
      PATH: '/usr/bin:/bin',
      ACCEPTANCE_SLACK_BOT_TOKEN: 'fake-slack-bot-value-not-real',
      SLACK_BOT_TOKEN: 'fake-slack-bot-value-not-real',
      LLM_PROXY_API_KEY: 'example-proxy-key-not-real',
    },
    roundDir: path.join(tmpDir(), 'round'),
  });
  assert.equal('ACCEPTANCE_SLACK_BOT_TOKEN' in env, false);
  assert.equal('SLACK_BOT_TOKEN' in env, false);
  assert.equal(env.LLM_PROXY_API_KEY, 'example-proxy-key-not-real');
});

// ---- 静态检查 ----

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

test('静态：只有 host/slack-notify.mjs 拿 slackBotTokenFile 去读文件；两个新模块不碰 pr.merge / process.env / child_process', () => {
  const files = [...listFiles(path.join(HERE, 'host')), ...listFiles(path.join(HERE, 'bin'))];
  const rel = (file) => path.relative(HERE, file);

  // 源码（不含测试）里点名 slackBotTokenFile 的只有 profile.mjs（键名校验、只存不读）和 slack-notify.mjs（真正读令牌）。
  const named = files.filter((file) => fs.readFileSync(file, 'utf8').includes('slackBotTokenFile')).map(rel).sort();
  assert.deepEqual(named, ['bin/profile.mjs', 'host/slack-notify.mjs'], `点名 slackBotTokenFile 的文件：${named.join(', ')}`);

  // profile.mjs 只拿它做路径校验，绝不读内容。
  for (const line of fs.readFileSync(path.join(HERE, 'bin', 'profile.mjs'), 'utf8').split('\n')) {
    if (!line.includes('slackBotTokenFile')) continue;
    assert.equal(/readFileSync|openSync|createReadStream/.test(line), false, `profile.mjs 读了令牌：${line.trim()}`);
  }

  const notify = fs.readFileSync(path.join(HERE, 'host', 'slack-notify.mjs'), 'utf8');
  assert.match(notify, /export function readSlackToken/);
  assert.match(notify, /O_NOFOLLOW/);
  assert.match(notify, /fstatSync/);

  for (const name of ['slack-notify.mjs', 'slack-blocks.mjs']) {
    const source = fs.readFileSync(path.join(HERE, 'host', name), 'utf8');
    assert.equal(source.includes('pr.merge'), false, `${name} 里不能有 pr.merge`);
    assert.equal(source.includes('合并按钮'), false, `${name} 里不能实现合并按钮`);
    assert.equal(/text: '合并'/.test(source), false, `${name} 里不能有「合并」按钮文字`);
    assert.equal(source.includes('process.env'), false, `${name} 里不能从环境变量读东西`);
    assert.equal(source.includes('child_process'), false, `${name} 里不能起子进程`);
    assert.equal(source.includes('import('), false, `${name} 里不能有动态 import`);
    assert.equal(source.includes('xox'), false, `${name} 里不能有令牌形状的字面量`);
  }
});


// ---- 审阅后补的测试（Pi 初稿之后）----

test('事件里的文字进 mrkdwn 前转义：@channel、伪造链接、伪造 repo 都不生效', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(
    home,
    {
      type: 'needs-human',
      issue: `${REPO}#2`,
      root: `${REPO}#1`,
      repo: 'evil>|x/y',
      pr: 9,
      reason: '<!channel> 快看 <https://evil.example/|打开 PR> & <@U0BADBAD1>',
      detail: '<https://evil.example/merge|合并>',
    },
    t0,
  );
  await withSlack(undefined, async (fake) => {
    await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    const [body] = bodies(fake.posts());
    const blocksText = JSON.stringify(body.blocks);
    assert.equal(blocksText.includes('<!channel>'), false);
    assert.equal(blocksText.includes('<https://evil'), false);
    assert.equal(blocksText.includes('<@U0BADBAD1>'), false);
    assert.match(blocksText, /&lt;!channel&gt;/);
    assert.match(blocksText, /&amp;/);
    assert.equal(blocksText.includes('evil>'), false, '不合规的 repo 名不拿来拼链接');
    assert.equal(blocksText.includes('github.com/evil'), false);
  });
});

test('Slack 不回话时单次请求超时返回、排重试，不把这一拍拖住', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  prbotEvent(home, { type: 'ready', ...readyEvent() }, t0);
  const sockets = new Set();
  const server = http.createServer(() => {
    // 故意一直不回。
  });
  server.on('connection', (socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const apiBase = `http://127.0.0.1:${server.address().port}/api/`;
    // 没账本时先查频道历史：查不动也要按时返回，这一拍不发。
    const rebuild = await notifySlack({ home, profile, now: () => t0, apiBase, requestTimeoutMs: 200 });
    assert.equal(rebuild.reason, 'ledger-rebuild-failed');
    fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, 'state', 'slack', 'ledger.json'), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
    const startedAt = Date.now();
    const result = await notifySlack({
      home,
      profile,
      now: () => t0,
      apiBase,
      requestTimeoutMs: 200,
    });
    assert.ok(Date.now() - startedAt < 5000, '超时之后就返回');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'send-failed');
    const ledger = readLedger(home);
    assert.equal(ledger.retry.length, 1);
    assert.equal(ledger.retry[0].attempts, 1);
    assert.equal(ledger.retry[0].nextAttemptAt, new Date(t0 + 60000).toISOString());
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('round-stalled 也算中断；连续中断按事件时间算：隔 7 小时的两次在同一拍补发也不合成', async () => {
  const t0 = Date.parse(START_AT);
  const stalled = setup();
  await withSlack(undefined, async (fake) => {
    alertEvent(stalled.home, { kind: 'round-stalled', issue: `${REPO}#4`, round: 1, reason: '卡住 1' }, t0);
    alertEvent(stalled.home, { kind: 'round-stalled', issue: `${REPO}#4`, round: 2, reason: '卡住 2' }, t0 + 60000);
    const result = await notifySlack({ home: stalled.home, profile: stalled.profile, now: () => t0 + 120000, fetch: fake.fetch, apiBase: fake.apiBase });
    // 第 1 次卡住立即发（#43），第 2 次合成「同一任务连续中断」。
    assert.equal(result.sent, 2);
    assert.match(fake.posts()[0].body, /轮次卡住没进度，已自动中止/);
    assert.match(fake.posts()[1].body, /同一任务 6 小时内反复中断/);
  });

  const apart = setup();
  await withSlack(undefined, async (fake) => {
    alertEvent(apart.home, { kind: 'round-failed', issue: `${REPO}#5`, round: 1, reason: '早' }, t0);
    alertEvent(apart.home, { kind: 'round-failed', issue: `${REPO}#5`, round: 2, reason: '晚' }, t0 + 7 * 3600000);
    const result = await notifySlack({ home: apart.home, profile: apart.profile, now: () => t0 + 8 * 3600000, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(result.sent, 2, '两次隔了 7 小时，不算连续，各自立即发');
    assert.equal(result.digested, 0);
    assert.equal(fake.posts().length, 2);
    assert.match(fake.posts()[0].body, /验收轮次出错，已自动中止/);
    assert.match(fake.posts()[1].body, /验收轮次出错，已自动中止/);
  });
});

// ---- #43 / #61 修正：即时提醒、失败可见、读历史失败不阻塞、每日上限、doctor 检查 ----

test('首次卡住 / 写闸拒绝 / 循环停摆立即发（带 @）；同一任务同一原因 6 小时内只发一次，再来进摘要', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  await withSlack(undefined, async (fake) => {
    const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });
    alertEvent(home, { kind: 'round-stalled', issue: `${REPO}#3`, round: 1, reason: '卡住：超过 stallMinutes 没有进度' }, t0);
    alertEvent(home, { kind: 'gate-rejected', issue: `${REPO}#3`, round: 1, reason: 'not-in-tree' }, t0);
    alertEvent(home, { kind: 'write-rejected', issue: `${REPO}#4`, reason: '认领被写闸拒绝' }, t0);
    alertEvent(home, { kind: 'loop-restarted', reason: 'heartbeat-stale' }, t0);
    const first = await send(t0);
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.sent, 4, '四条都立即发');
    assert.equal(first.digested, 0);
    const posted = bodies(fake.posts());
    assert.ok(posted.every((body) => body.text.startsWith(`<@${MENTION}>`)), '立即发的都 @');
    assert.ok(posted.some((body) => body.text.includes('轮次卡住没进度，已自动中止')));
    assert.ok(posted.some((body) => body.text.includes('写闸拦下了一个不合规的写操作')));
    assert.ok(posted.some((body) => body.text.includes('验收机心跳过期，已自动重新拉起')));

    // 1 小时后同一任务同一原因再来：进摘要，不再 @。别的任务照样立即发。
    alertEvent(home, { kind: 'gate-rejected', issue: `${REPO}#3`, round: 2, reason: 'not-in-tree' }, t0 + 3600000);
    alertEvent(home, { kind: 'loop-restarted', reason: 'loop-not-running' }, t0 + 3600000);
    alertEvent(home, { kind: 'gate-rejected', issue: `${REPO}#5`, round: 1, reason: 'not-in-tree' }, t0 + 3600000);
    const second = await send(t0 + 3600000);
    assert.equal(second.sent, 1, '只有 #5 的立即发');
    assert.equal(second.digested, 2);
    assert.match(fake.posts()[4].body, /#5/);

    // 7 小时后：窗口过了，又能立即发一次。
    alertEvent(home, { kind: 'gate-rejected', issue: `${REPO}#3`, round: 3, reason: 'not-in-tree' }, t0 + 7 * 3600000);
    const third = await send(t0 + 7 * 3600000);
    assert.ok(third.sent >= 1);
    assert.ok(bodies(fake.posts()).some((body, index) => index >= 5 && body.text.includes('写闸拦下了一个不合规的写操作')));
  });
});

test('裁决运行重试用完（adjudicate-needs-human）立即发；超时 / 失败进摘要', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  alertEvent(home, { kind: 'adjudicate-timeout', issue: `${REPO}#1`, round: 2, reason: '超时' }, t0);
  alertEvent(home, { kind: 'adjudicate-needs-human', issue: `${REPO}#1`, round: 2, reason: '需要人工裁决' }, t0);
  await withSlack(undefined, async (fake) => {
    const result = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(result.sent, 1);
    assert.equal(result.digested, 1);
    assert.match(fake.posts()[0].body, /有争议的条目裁决不出来，需要你裁决/);
  });
});

test('发送重试用完：写 slack-failed 提醒、账本和返回值带 failing（下一次发成功才清）；slack-failed 自己不往 Slack 发', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  prbotEvent(home, { type: 'needs-human', issue: `${REPO}#2`, root: `${REPO}#1`, reason: 'no-change' }, t0);
  let broken = true;
  await withSlack(
    (entry) => (broken && entry.path.endsWith('/chat.postMessage') ? { status: 500, body: { ok: false, error: 'boom' } } : undefined),
    async (fake) => {
      const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });
      let at = t0;
      let result = await send(at);
      assert.equal(result.failing, null, '还在重试，不算放弃');
      for (const minutes of RETRY_MINUTES) {
        at += minutes * 60000;
        result = await send(at);
      }
      assert.equal(result.failed.length, 1, '第 4 次放弃');
      assert.ok(result.failing, '返回值带 failing');
      assert.equal(result.failing.kind, 'blocked');
      assert.equal(result.failing.error, 'http-500');
      assert.equal(result.failing.count, 1);
      assert.equal(readLedger(home).failing.since, new Date(at).toISOString());
      const alerts = readAlerts(hostPaths(home)).filter((entry) => entry.kind === 'slack-failed');
      assert.equal(alerts.length, 1, '写一条 slack-failed');
      assert.equal(JSON.stringify(alerts).includes(TOKEN), false);

      // 下一拍还是坏的：failing 留着；slack-failed 提醒不进 Slack（不发也不进摘要）。
      const posts = fake.posts().length;
      result = await send(at + 60000);
      assert.ok(result.failing, '没发成功之前一直留着');
      assert.equal(fake.posts().length, posts, 'slack-failed 不往 Slack 发');
      assert.equal(result.digested, 0);

      // 修好之后一发成功就清掉。
      broken = false;
      prbotEvent(home, { type: 'needs-human', issue: `${REPO}#6`, root: `${REPO}#1`, reason: 'no-change' }, at + 120000);
      result = await send(at + 120000);
      assert.equal(result.sent, 1);
      assert.equal(result.failing, null);
      assert.equal(readLedger(home).failing, null);
    },
  );
});

test('tick：心跳的 slackFailing 持久，notify 没读到账本时沿用上一拍，发成功（failing=null）才清', async () => {
  const { home } = await tickHome();
  const failing = { since: '2026-10-24T01:00:00.000Z', lastAt: '2026-10-24T01:30:00.000Z', kind: 'blocked', error: 'http-500', count: 1 };
  const tick = (result) =>
    runTick({
      home,
      env: { ...process.env },
      run: POLL_OK,
      spawnRound: () => 1,
      runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
      notify: async () => result,
      now: () => Date.parse('2026-10-24T02:00:00.000Z'),
    });
  let heartbeat = await tick({ ok: false, reason: 'send-failed', sent: 0, failed: [], failing });
  assert.deepEqual(heartbeat.slackFailing, failing);
  heartbeat = await tick({ ok: false, reason: 'token-file-mode', sent: 0, failed: [] });
  assert.deepEqual(heartbeat.slackFailing, failing, '没读到账本：沿用上一拍');
  assert.deepEqual(JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8')).slackFailing, failing);
  heartbeat = await tick({ ok: true, sent: 1, failed: [], failing: null });
  assert.equal(heartbeat.slackFailing, undefined, '发成功就清');
  assert.equal(JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8')).slackFailing, undefined);
});

test('每日上限（host.json slackDailyCap）：到了只攒进摘要、当天发一条「已达上限」，第二天摘要照发', async () => {
  const { home, profile } = setup();
  // 上限按本机日期算：从本机时间中午开始，免得测试里的「两小时后」跨了零点（和时区无关）。
  const noon = new Date(Date.parse(START_AT) + 36 * 3600000);
  noon.setHours(12, 0, 0, 0);
  const t0 = noon.getTime();
  fs.writeFileSync(path.join(home, 'config', 'host.json'), JSON.stringify({ slackDailyCap: 2 }));
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  for (let i = 0; i < 4; i += 1) {
    prbotEvent(home, { type: 'needs-human', issue: `${REPO}#${10 + i}`, root: `${REPO}#1`, reason: 'no-change' }, t0 + i);
  }
  await withSlack(undefined, async (fake) => {
    const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });
    const first = await send(t0 + 1000);
    assert.equal(first.sent, 2, '只发到上限');
    assert.equal(first.capped, 2);
    assert.equal(first.pending, 2, '超出的攒进摘要');
    const posted = bodies(fake.posts());
    assert.equal(posted.length, 3, '两条 + 一条「已达上限」');
    assert.match(posted[2].text, /已达上限（2 条）/);
    assert.equal(posted[2].text.includes(`<@${MENTION}>`), false, '上限通知不 @');
    assert.ok(readLedger(home).daily.capNoticeAt);

    // 当天再来事件：还在上限，不发、也不再发「已达上限」；到点的摘要也留到明天。
    prbotEvent(home, { type: 'needs-human', issue: `${REPO}#20`, root: `${REPO}#1`, reason: 'no-change' }, t0 + 2 * 3600000);
    const later = await send(t0 + 2 * 3600000);
    assert.equal(later.sent, 0);
    assert.equal(later.pending, 3);
    assert.equal(fake.posts().length, 3, '同一天只发一条「已达上限」');

    // 第二天：计数清零，摘要（算 1 条）发出去。
    const nextDay = await send(t0 + 26 * 3600000);
    assert.equal(nextDay.sent, 1);
    assert.equal(nextDay.pending, 0);
    assert.match(fake.posts()[3].body, /验收机摘要（3 条，不紧急）/);
    assert.equal(readLedger(home).daily.sent, 1);
  });
});

test('每日上限默认 30：host.json 没配或不是正整数都按 30', () => {
  const { home } = setup();
  assert.equal(DEFAULT_DAILY_CAP, 30);
  assert.equal(readDailyCap(home), 30);
  fs.writeFileSync(path.join(home, 'config', 'host.json'), JSON.stringify({ slackDailyCap: 'many' }));
  assert.equal(readDailyCap(home), 30);
  fs.writeFileSync(path.join(home, 'config', 'host.json'), JSON.stringify({ slackDailyCap: 5 }));
  assert.equal(readDailyCap(home), 5);
});

test('doctor 的 Slack 检查（只读）：auth.test + bot 在频道里；没 channels:read 退到 conversations.history；没配就跳过', async () => {
  const { profile } = setup();
  const answer = (map) => (entry) => {
    for (const [suffix, body] of Object.entries(map)) if (entry.path.endsWith(suffix)) return { status: 200, body };
    return undefined;
  };
  await withSlack(answer({ '/auth.test': { ok: true }, '/conversations.info': { ok: true, channel: { is_member: true } } }), async (fake) => {
    const result = await checkSlackAccess({ profile, apiBase: fake.apiBase });
    assert.equal(result.ok, true, result.detail);
    assert.equal(fake.posts().length, 0, '不发消息');
    assert.equal(fake.requests[1].query.channel, CHANNEL);
    assert.equal(fake.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  });
  await withSlack(answer({ '/auth.test': { ok: true }, '/conversations.info': { ok: true, channel: { is_member: false } } }), async (fake) => {
    const result = await checkSlackAccess({ profile, apiBase: fake.apiBase });
    assert.equal(result.ok, false);
    assert.match(result.detail, /bot 不在目标频道里/);
  });
  await withSlack(
    answer({
      '/auth.test': { ok: true },
      '/conversations.info': { ok: false, error: 'missing_scope' },
      '/conversations.history': { ok: false, error: 'not_in_channel' },
    }),
    async (fake) => {
      const result = await checkSlackAccess({ profile, apiBase: fake.apiBase });
      assert.equal(result.ok, false);
      assert.match(result.detail, /bot 不在目标频道里/);
      assert.equal(fake.history()[0].query.limit, '1');
    },
  );
  await withSlack(
    answer({
      '/auth.test': { ok: true },
      '/conversations.info': { ok: false, error: 'missing_scope' },
      '/conversations.history': { ok: false, error: 'missing_scope' },
    }),
    async (fake) => {
      const result = await checkSlackAccess({ profile, apiBase: fake.apiBase });
      assert.equal(result.ok, false);
      assert.match(result.detail, /channels:history/);
    },
  );
  await withSlack(answer({ '/auth.test': { ok: false, error: 'invalid_auth' } }), async (fake) => {
    const result = await checkSlackAccess({ profile, apiBase: fake.apiBase });
    assert.equal(result.ok, false);
    assert.match(result.detail, /auth\.test 失败：slack-invalid_auth/);
    assert.equal(fake.requests.length, 1);
  });
  const skipped = await checkSlackAccess({ profile: { ...profile, slackChannelId: undefined } });
  assert.equal(skipped.ok, true);
  assert.equal(skipped.skipped, true);
});

function assertHumanPing(body, kind, label) {
  const copy = NOTICE_COPY[kind];
  const whole = typeof body === 'string' ? body : JSON.stringify(body);
  const text = typeof body === 'string' ? body : body.text;
  assert.ok(text.includes(copy.title), `${label} text 缺 title：${text}`);
  for (const heading of ['发生了什么', '有没有影响', '验收机已自动做了什么', '要不要人处理']) {
    assert.ok(whole.includes(heading), `${label} 缺「${heading}」`);
  }
  assert.ok(whole.includes(copy.auto), `${label} 缺 auto 文案`);
}

test('预期拒绝不发 Slack、不进 pending、不 @：query/repo/edit-not-allowed、egress-denied、probe', async () => {
  const cases = [
    { kind: 'gate-rejected', reason: 'query-not-allowed' },
    { kind: 'gate-rejected', reason: 'repo-not-allowed' },
    { kind: 'gate-rejected', reason: 'edit-not-allowed' },
    { kind: 'egress-denied', reason: 'not-allowlisted' },
    { kind: 'gate-rejected', reason: 'needs-round-binding', detail: 'probe write' },
    { kind: 'gate-rejected', reason: 'not-in-tree', probe: true },
    { kind: 'round-failed', probe: true, issue: `${REPO}#8` },
  ];
  for (const event of cases) {
    assert.equal(isExpectedRejection(event), true, JSON.stringify(event));
    assert.equal(classify('alerts', event), 'skip', JSON.stringify(event));
  }
  assert.deepEqual([...EXPECTED_GATE_REASONS], ['query-not-allowed', 'repo-not-allowed', 'edit-not-allowed']);

  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  for (const event of cases) alertEvent(home, { ...event, issue: event.issue || `${REPO}#3` }, t0);
  await withSlack(undefined, async (fake) => {
    const result = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(fake.posts().length, 0, '预期拒绝不发 Slack');
    assert.equal(result.pending, 0, '不进 pending');
    assert.equal(result.digested, 0);
    assert.equal(result.sent, 0);
    const ledger = readLedger(home);
    assert.equal(ledger.pending.length, 0);
    assert.equal(JSON.stringify(fake.posts()).includes(`<@${MENTION}>`), false);
  });
});

test('账本 pending 里旧的预期拒绝到点发摘要时被滤掉，只留 tick-failed 人话', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    ledgerFile(home),
    JSON.stringify({
      version: 1,
      ids: [],
      pending: [
        { id: 'old-gate', source: 'alerts', type: 'gate-rejected', kind: 'digest', issue: `${REPO}#3`, reason: 'query-not-allowed' },
        { id: 'old-tick', source: 'alerts', type: 'tick-failed', kind: 'digest', issue: `${REPO}#4`, reason: '这一拍出错' },
      ],
      digestNextAt: new Date(t0).toISOString(),
    }),
    { mode: 0o600 },
  );
  await withSlack(undefined, async (fake) => {
    const result = await notifySlack({ home, profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(result.sent, 1);
    assert.equal(fake.posts().length, 1);
    const body = fake.posts()[0].body;
    assert.match(body, /验收机摘要（1 条，不紧急）/);
    assert.match(body, /验收机有一拍调度出错/);
    assert.equal(body.includes('query-not-allowed'), false);
    assert.equal(body.includes('写闸拦下'), false);
    assert.equal(body.includes(`<@${MENTION}>`), false);
    assert.deepEqual(readLedger(home).pending, []);
  });
});

test('真故障立即发且文案含人话与自动处置：round-failed、loop-restarted、secret-found、gate-rejected、tick 连错 3 次', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  await withSlack(undefined, async (fake) => {
    const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });
    alertEvent(home, { kind: 'round-failed', issue: `${REPO}#3`, reason: '宿主出错' }, t0);
    alertEvent(home, { kind: 'loop-restarted', reason: 'heartbeat-stale' }, t0);
    alertEvent(home, { kind: 'secret-found', issue: `${REPO}#4`, reason: 'branch.push 扫到疑似密钥，没推：a.js' }, t0);
    alertEvent(home, { kind: 'gate-rejected', issue: `${REPO}#5`, reason: 'needs-round-binding', detail: 'comment.create' }, t0);
    const first = await send(t0);
    assert.equal(first.sent, 4);
    const posted = bodies(fake.posts());
    assert.ok(posted.every((body) => body.text.startsWith(`<@${MENTION}>`)), '立即发都 @');
    assertHumanPing(posted.find((body) => body.text.includes('验收轮次出错')), 'round-failed', 'round-failed');
    const heartbeat = posted.find((body) => body.text.includes('心跳过期'));
    assert.ok(heartbeat);
    assert.ok(JSON.stringify(heartbeat).includes('发生了什么'));
    assert.ok(JSON.stringify(heartbeat).includes('保活脚本已把调度循环重新拉起'));
    assertHumanPing(posted.find((body) => body.text.includes('疑似密钥')), 'secret-found', 'secret-found');
    const gate = posted.find((body) => body.text.includes('写闸拦下了一个不合规的写操作'));
    assertHumanPing(gate, 'gate-rejected', 'gate-rejected');
    assert.match(JSON.stringify(gate.blocks), /拦下原因：这个写操作只允许在验收轮里做，当时不在轮次里/);

  });

  const loopHome = setup();
  fs.mkdirSync(path.join(loopHome.home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(loopHome.home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  alertEvent(loopHome.home, { kind: 'loop-restarted', reason: 'loop-not-running' }, t0);
  await withSlack(undefined, async (fake) => {
    const loopResult = await notifySlack({ home: loopHome.home, profile: loopHome.profile, now: () => t0, fetch: fake.fetch, apiBase: fake.apiBase });
    assert.equal(loopResult.sent, 1);
    assert.match(fake.posts()[0].body, /验收机调度循环挂了，已自动重新拉起/);
    const whole = fake.posts()[0].body;
    assert.ok(whole.includes('发生了什么'));
    assert.ok(whole.includes('调度循环进程不在了'));
  });
});

test('tick-failed 10 分钟内 3 次合成一条立即发；2 次只进摘要；6 小时内第 4、5 次不再立即发', async () => {
  assert.deepEqual([...TICK_FAILURE_KINDS], ['tick-failed', 'prbot-tick-failed']);
  assert.equal(TICK_REPEAT_COUNT, 3);
  assert.equal(TICK_REPEAT_WINDOW_MS, 10 * 60 * 1000);
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  await withSlack(undefined, async (fake) => {
    const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });
    alertEvent(home, { kind: 'tick-failed', reason: '第 1 次' }, t0);
    const first = await send(t0);
    assert.equal(first.sent, 0);
    assert.equal(first.digested, 1);
    alertEvent(home, { kind: 'tick-failed', reason: '第 2 次' }, t0 + 60000);
    const second = await send(t0 + 60000);
    assert.equal(second.sent, 0, '2 次只进摘要');
    assert.equal(second.digested, 1);
    assert.equal(fake.posts().length, 0);

    alertEvent(home, { kind: 'tick-failed', reason: '第 3 次' }, t0 + 2 * 60000);
    const third = await send(t0 + 2 * 60000);
    assert.equal(third.sent, 1, '第 3 次合成立即发');
    const ping = bodies(fake.posts())[0];
    assert.match(ping.text, /验收机调度连续出错/);
    assert.ok(ping.text.startsWith(`<@${MENTION}>`));
    assertHumanPing(ping, 'tick-failed-repeat', 'tick-failed-repeat');
    assert.match(JSON.stringify(ping.blocks), /验收调度在 10 分钟内连续出错 3 次/);
    assert.equal(JSON.stringify(ping.blocks).includes('tick-failed'), false);

    alertEvent(home, { kind: 'tick-failed', reason: '第 4 次' }, t0 + 3 * 60000);
    const fourth = await send(t0 + 3 * 60000);
    assert.equal(fourth.sent, 0, '6 小时内第 4 次不再立即发');
    assert.equal(fourth.digested, 1);
    alertEvent(home, { kind: 'tick-failed', reason: '第 5 次' }, t0 + 4 * 60000);
    const fifth = await send(t0 + 4 * 60000);
    assert.equal(fifth.sent, 0, '6 小时内第 5 次不再立即发');
    assert.equal(fake.posts().length, 1);
  });
});

test('round-failed 同一 issue：第 1 次立即发、第 2 次合成反复中断、第 3 次不发', async () => {
  const { home, profile } = setup();
  const t0 = Date.parse(START_AT);
  fs.mkdirSync(path.join(home, 'state', 'slack'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(ledgerFile(home), JSON.stringify({ version: 1, ids: [] }), { mode: 0o600 });
  await withSlack(undefined, async (fake) => {
    const send = (ts) => notifySlack({ home, profile, now: () => ts, fetch: fake.fetch, apiBase: fake.apiBase });
    alertEvent(home, { kind: 'round-failed', issue: `${REPO}#11`, round: 1, reason: '第 1 次' }, t0);
    const first = await send(t0);
    assert.equal(first.sent, 1);
    assert.match(fake.posts()[0].body, /验收轮次出错，已自动中止/);
    assert.ok(fake.posts()[0].body.includes(`<@${MENTION}>`));

    alertEvent(home, { kind: 'round-failed', issue: `${REPO}#11`, round: 2, reason: '第 2 次' }, t0 + 2 * 60000);
    const second = await send(t0 + 2 * 60000);
    assert.equal(second.sent, 1);
    const body = fake.posts()[1].body;
    assert.match(body, /同一任务 6 小时内反复中断/);
    assert.match(body, /中断了 2 次/);
    assert.ok(body.includes(`<@${MENTION}>`));

    alertEvent(home, { kind: 'round-failed', issue: `${REPO}#11`, round: 3, reason: '第 3 次' }, t0 + 4 * 60000);
    const third = await send(t0 + 4 * 60000);
    assert.equal(third.sent, 0);
    assert.equal(fake.posts().length, 2);
  });
});

test('心跳延迟和部署重启只进摘要，不立即 ping', () => {
  assert.equal(classify('alerts', { kind: 'heartbeat-delayed', reason: 'delay-600s' }), 'digest');
  assert.equal(classify('alerts', { kind: 'loop-deploy-restarted', reason: 'planned-stop' }), 'digest');
  assert.equal(classify('alerts', { kind: 'loop-restarted', reason: 'heartbeat-stale' }), 'blocked');
});
