// Slack 通报关闭：profile 不配 slackChannelId 就一条都不发，告警只写 alerts.jsonl；心跳 slack=not-configured 算正常。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendAlert, hostPaths, readAlerts } from './host/paths.mjs';
import { appendPrbotEvent } from './host/prbot-events.mjs';
import { checkSlackAccess, notifySlack } from './host/slack-notify.mjs';
import { runTick } from './host/tick.mjs';
import { REPO, START_AT, tmpDir, writeProfile, writeSecret } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

/** 配了 bot 令牌文件、但没配 slackChannelId 的 home（生产关掉 Slack 后的样子）。 */
function slackOffHome() {
  const base = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const tokenFile = writeSecret(path.join(base.home, 'secrets', 'slack.token'), 'fake-slack-bot-value-not-real');
  const profileFile = path.join(base.home, 'config', 'profile.json');
  const raw = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  fs.writeFileSync(profileFile, JSON.stringify({ ...raw, slackBotTokenFile: tokenFile, slackMentionUserId: 'U0123456789' }, null, 2));
  return base.home;
}

function spyFetch() {
  const calls = [];
  const fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error('Slack 关闭后不该有任何请求');
  };
  return { calls, fetch };
}

const POLL_OK = async () => ({ code: 0, stdout: '[]', stderr: '' });

function tick(home, fetch, ts, extra = {}) {
  return runTick({
    home,
    env: { ...process.env },
    run: POLL_OK,
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    notify: (options) => notifySlack({ ...options, fetch }),
    now: () => ts,
    ...extra,
  });
}

test('没配 slackChannelId：原本会立即发的告警（loop-restarted、PR Ready）只进 alerts.jsonl / 事件流，Slack 零请求', async () => {
  const home = slackOffHome();
  const t0 = Date.parse(START_AT) + 60_000;
  const paths = hostPaths(home);
  appendAlert(paths, { kind: 'loop-restarted', reason: 'heartbeat-stale', now: () => t0 });
  appendAlert(paths, { kind: 'round-failed', issue: `${REPO}#3`, reason: '宿主出错', now: () => t0 });
  appendPrbotEvent(paths, { at: new Date(t0).toISOString(), type: 'ready', issue: `${REPO}#2`, root: `${REPO}#1`, prUrl: `https://github.com/${REPO}/pull/9` }, { now: () => t0 });
  const spy = spyFetch();
  for (const ts of [t0, t0 + 61 * 60_000, t0 + 3 * 60 * 60_000]) {
    const heartbeat = await tick(home, spy.fetch, ts);
    assert.equal(heartbeat.slack.ok, true, '关掉 Slack 是正常状态，不算失败');
    assert.equal(heartbeat.slack.reason, 'not-configured');
    assert.equal(heartbeat.slack.sent, 0);
    assert.equal(heartbeat.lastTick.ok, true);
  }
  assert.deepEqual(spy.calls, [], 'Slack 发送路径零调用');
  const kinds = readAlerts(paths).map((alert) => alert.kind);
  assert.ok(kinds.includes('loop-restarted'), '告警照常写 alerts.jsonl');
  assert.ok(kinds.includes('round-failed'));
  assert.equal(fs.existsSync(path.join(home, 'state', 'slack', 'ledger.json')), false, '不建账本、不堆 pending / 重试');
});

test('关掉 Slack 后：账本里旧的 pending / 重试原样冻住不再发，心跳里上一拍的 slackFailing 清掉（ensure 不再报 slack-failed）', async () => {
  const home = slackOffHome();
  const t0 = Date.parse(START_AT) + 60_000;
  const paths = hostPaths(home);
  const failing = { since: '2026-10-24T01:00:00.000Z', lastAt: '2026-10-24T01:30:00.000Z', kind: 'blocked', error: 'http-500', count: 1 };
  fs.mkdirSync(path.dirname(paths.heartbeatFile), { recursive: true });
  fs.writeFileSync(paths.heartbeatFile, JSON.stringify({ at: new Date(t0 - 60_000).toISOString(), slackFailing: failing }));
  const ledgerFile = path.join(home, 'state', 'slack', 'ledger.json');
  fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const ledger = {
    version: 1,
    ids: [],
    pending: [{ id: 'p1', kind: 'digest', type: 'round-failed', at: new Date(t0).toISOString() }],
    retry: [{ id: 'r1', kind: 'blocked', payload: { text: 'x' }, attempts: 1, nextAttemptAt: new Date(t0).toISOString() }],
  };
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger), { mode: 0o600 });
  const spy = spyFetch();
  const heartbeat = await tick(home, spy.fetch, t0 + 30 * 60_000);
  assert.deepEqual(spy.calls, []);
  assert.equal(heartbeat.slack.ok, true);
  assert.equal(heartbeat.slackFailing, undefined, '关掉了就没有「发送失败」');
  assert.equal(JSON.parse(fs.readFileSync(paths.heartbeatFile, 'utf8')).slackFailing, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerFile, 'utf8')), ledger, '账本不动、重试不累加');
});

test('真的配错（令牌文件坏了）仍算失败：只有 not-configured 被当成正常', async () => {
  const home = slackOffHome();
  const profileFile = path.join(home, 'config', 'profile.json');
  const raw = JSON.parse(fs.readFileSync(profileFile, 'utf8'));
  fs.chmodSync(raw.slackBotTokenFile, 0o644);
  fs.writeFileSync(profileFile, JSON.stringify({ ...raw, slackChannelId: 'C0123456789' }, null, 2));
  const spy = spyFetch();
  const heartbeat = await tick(home, spy.fetch, Date.parse(START_AT) + 60_000);
  assert.equal(heartbeat.slack.ok, false);
  assert.equal(heartbeat.slack.reason, 'token-file-mode');
  assert.deepEqual(spy.calls, []);
});

test('doctor 的 Slack 项：没配频道算通过，并说明通报已关闭、告警只写 alerts.jsonl', async () => {
  const spy = spyFetch();
  const result = await checkSlackAccess({ profile: { slackBotTokenFile: '/nonexistent/slack.token' }, fetch: spy.fetch });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.match(result.detail, /跳过/);
  assert.match(result.detail, /已关闭/);
  assert.match(result.detail, /alerts\.jsonl/);
  assert.deepEqual(spy.calls, []);
});

test('文档：Slack 通报已关闭，告警只写 alerts.jsonl；not-configured 是正常状态', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'acceptance-slack.md'), 'utf8');
  const head = doc.split('\n').slice(0, 20).join('\n');
  assert.match(head, /已关闭/);
  assert.match(head, /alerts\.jsonl/);
  assert.match(head, /not-configured/);
  assert.match(head, /slackChannelId/);
});
