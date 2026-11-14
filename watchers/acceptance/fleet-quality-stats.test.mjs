import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './fake-gh.fixture.mjs';
import {
  BODY_V1,
  BOT,
  PASS_ITEMS,
  REPO,
  USER,
  alertLine,
  bDeployRow,
  botAuth,
  cleanPassItems,
  emptyEvidenceItems,
  envReason,
  graphqlComment,
  legacyDeployState,
  restComment,
  restEvent,
  sample62Comments,
  sample62Events,
  sampleSnapshot,
  userAuth,
} from './fleet-quality-stats.fixture.mjs';
import {
  ALERT_DEDUP_MS,
  DEFAULT_TIMEZONE,
  addCalendarDays,
  classifyEvidence,
  completeLocalWindow,
  computeMetrics,
  heartbeatFreshness,
  loadSnapshot,
  localDateOf,
  main,
  normalizeComment,
  normalizeDeployRecord,
  normalizeEvent,
  parseArgs,
  parseInstant,
  parseVerdictItems,
  zonedMidnightUtcMs,
} from './bin/fleet-quality-stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const BIN = path.join(HERE, 'bin', 'fleet-quality-stats.mjs');
const DOC = path.join(ROOT, 'docs', 'fleet-quality-metrics.md');

const NOW_NOV14_PST_MORNING = Date.parse('2026-11-14T18:29:00Z'); // 10:29 LA，今天未完整
const NOW_NOV15_LA = Date.parse('2026-11-15T18:00:00Z'); // 10:00 LA Nov 15，完整日含 Nov 14

function windowFor(nowMs, extra = {}) {
  return completeLocalWindow({ nowMs, timeZone: DEFAULT_TIMEZONE, ...extra });
}

function snapshotFrom(obj) {
  const dir = tmpDir('fleet-quality-');
  const file = path.join(dir, 'snapshot.json');
  fs.writeFileSync(file, JSON.stringify(obj));
  return loadSnapshot({ snapshot: file, labeledSample: obj.labeledSample });
}

function runCli(args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: ROOT });
}

test('SC1 默认窗口是洛杉矶 7 个完整本地日，不是 UTC 日', () => {
  const w = windowFor(NOW_NOV14_PST_MORNING);
  assert.equal(w.timeZone, 'America/Los_Angeles');
  assert.equal(w.fromLocalDate, '2026-11-07');
  assert.equal(w.toLocalDate, '2026-11-13');
  assert.deepEqual(w.completeLocalDays, [
    '2026-11-07',
    '2026-11-08',
    '2026-11-09',
    '2026-11-10',
    '2026-11-11',
    '2026-11-12',
    '2026-11-13',
  ]);
  assert.match(w.note, /不是不加说明的 UTC 日/);
  assert.equal(w.startUtc, '2026-11-07T08:00:00.000Z'); // 2026-11 已是 PST
  assert.equal(w.endUtcExclusive, '2026-11-14T08:00:00.000Z');
  const utcSevenStart = '2026-11-07T00:00:00.000Z';
  assert.notEqual(w.startUtc, utcSevenStart);
});

test('SC1 显式 --from/--to 与 --timezone', () => {
  const tokyo = completeLocalWindow({
    nowMs: NOW_NOV15_LA,
    timeZone: 'Asia/Tokyo',
    fromDate: '2026-11-10',
    toDate: '2026-11-12',
  });
  assert.equal(tokyo.timeZone, 'Asia/Tokyo');
  assert.equal(tokyo.fromLocalDate, '2026-11-10');
  assert.equal(tokyo.toLocalDate, '2026-11-12');
  assert.equal(tokyo.startUtc, '2026-11-09T15:00:00.000Z');
  assert.equal(tokyo.endUtcExclusive, '2026-11-12T15:00:00.000Z');
});

test('SC1/SC4 窗口边界：LA 午夜前 1ms 与午夜整分落在不同本地日', () => {
  const before = Date.parse('2026-11-14T07:59:59.000Z');
  const at = Date.parse('2026-11-14T08:00:00.000Z');
  assert.equal(localDateOf(before, DEFAULT_TIMEZONE), '2026-11-13');
  assert.equal(localDateOf(at, DEFAULT_TIMEZONE), '2026-11-14');
  const w = completeLocalWindow({ nowMs: NOW_NOV15_LA, fromDate: '2026-11-14', toDate: '2026-11-14' });
  assert.equal(w.startUtcMs, at);
  assert.ok(before < w.startUtcMs);
  assert.ok(at >= w.startUtcMs);
});

test('SC1 保留原始时区偏移', () => {
  const parsed = parseInstant('2026-11-14T21:43:25+08:00');
  assert.equal(parsed.zoneHint, '+08:00');
  assert.equal(parsed.utcMs, Date.parse('2026-11-14T13:43:25Z'));
  assert.equal(parsed.original, '2026-11-14T21:43:25+08:00');
});

test('SC3 REST 与 GraphQL 轮次评论都能解析，来源 ID 可核验', () => {
  const rest = sample62Comments().at(-1);
  const a = normalizeComment(rest);
  const b = normalizeComment(graphqlComment(rest), { issueRef: `${REPO}#62` });
  assert.equal(a.round, 16);
  assert.equal(a.status, '通过');
  assert.equal(a.commentId, 1016);
  assert.equal(a.commentUrl, rest.html_url);
  assert.equal(a.startedAt, '2026-11-14T21:43:25+08:00');
  assert.equal(a.startedZoneHint, '+08:00');
  assert.equal(a.author.login, BOT);
  assert.equal(a.author.type, 'Bot');
  assert.equal(b.round, 16);
  assert.equal(b.commentId, 1016);
  assert.equal(b.author.login, BOT);
  assert.equal(b.issueRef, `${REPO}#62`);
});

test('SC3 用户伪造的轮次首行默认不计入（与只认 bot 的口径一致）', () => {
  const fake = restComment({
    id: 9,
    round: 1,
    status: '通过',
    startedAt: '2026-11-14T21:00:00+08:00',
    finishedAt: '2026-11-14T21:01:00+08:00',
    login: USER,
    type: 'User',
    items: cleanPassItems(),
  });
  assert.equal(normalizeComment(fake), null);
});

test('SC3 closed/reopened 事件适配 REST', () => {
  const closed = normalizeEvent(sample62Events()[0], { issueRef: `${REPO}#62` });
  assert.equal(closed.event, 'closed');
  assert.equal(closed.eventId, 9001);
  assert.equal(closed.actor.login, BOT);
  assert.equal(closed.actor.type, 'Bot');
  const reopened = normalizeEvent(
    restEvent({ id: 9002, event: 'reopened', created_at: '2026-11-14T16:00:00Z', login: USER, type: 'User' }),
    { issueRef: `${REPO}#62` },
  );
  assert.equal(reopened.event, 'reopened');
  assert.equal(reopened.actor.type, 'User');
});

test('SC2 可写副本不是作弊；临时副本补测试记待核实', () => {
  assert.equal(classifyEvidence('在可写副本跑 node --test queue.test.mjs').kind, 'writable-copy');
  assert.equal(classifyEvidence('在可写副本跑 node --test queue.test.mjs').cheat, false);
  const extra = classifyEvidence('在临时副本补 2 个 tick 用例；4/4 通过');
  assert.equal(extra.kind, 'temp-copy-extra-tests');
  assert.equal(extra.cheat, false);
  assert.equal(extra.unverified, true);
  assert.equal(extra.label, '待核实');
  assert.equal(classifyEvidence('').kind, 'empty');
});

test('SC2/SC4 样例：16 轮只进一次分母；中断不进一次通过分母；人工未验关单；临时补测试待核实', () => {
  const snap = snapshotFrom(sampleSnapshot());
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA, labeledSample: true });
  const m = report.metrics;
  assert.equal(m.firstPassOriginal.denominator, 1, '同一 issue 不夸分母');
  assert.equal(m.firstPassOriginal.numerator, 0, '含人工手测与待核实，不是原条件一次通过');
  assert.equal(m.firstPassOriginal.sources[0], undefined);
  assert.equal(m.humanUnverifiedClose.unknown, false);
  assert.equal(m.humanUnverifiedClose.numerator, 1);
  assert.equal(m.humanUnverifiedClose.denominator, 1);
  assert.equal(m.humanUnverifiedClose.sources[0].eventId, 9001);
  assert.equal(m.humanUnverifiedClose.sources[0].commentId, 1016);
  assert.equal(m.tempCopyUnverified.numerator, 1);
  assert.equal(m.tempCopyUnverified.cheat, false);
  assert.equal(m.tempCopyUnverified.label, '待核实');
  assert.equal(m.emptyEvidencePass.numerator, 0);
  const env = m.deliveryLatency.envWaitSeparate[0];
  assert.ok(env.envWaitMinutes > 0);
  assert.equal(env.rounds.length, 1);
  assert.equal(env.rounds[0].round, 15);
  assert.equal(report.samples.doNotExtrapolate, true);
  assert.equal(report.coverage.productionSevenDayFleet, false);
  assert.equal(report.writeSideEffects, false);
});

test('SC2 原条件一次通过：全部带证据通过且无人工项', () => {
  const comments = [
    restComment({
      id: 21,
      number: 80,
      round: 1,
      status: '通过',
      startedAt: '2026-11-14T10:00:00+08:00',
      finishedAt: '2026-11-14T10:05:00+08:00',
      items: cleanPassItems(),
      created_at: '2026-11-14T02:00:00Z',
      updated_at: '2026-11-14T02:05:00Z',
    }),
  ];
  const snap = snapshotFrom({
    comments,
    issues: [{ number: 80, html_url: `https://github.com/${REPO}/issues/80`, pullRequests: [{ mergedAt: '2026-11-14T01:00:00Z' }] }],
    events: [restEvent({ id: 1, number: 80, event: 'closed', created_at: '2026-11-14T02:06:00Z', login: BOT, type: 'Bot' })],
  });
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.metrics.firstPassOriginal.numerator, 1);
  assert.equal(report.metrics.firstPassOriginal.denominator, 1);
  assert.equal(report.metrics.humanUnverifiedClose.numerator, 0);
  assert.equal(report.metrics.tempCopyUnverified.numerator, 0);
  assert.equal(report.metrics.deliveryLatency.values[0].minutes > 0, true);
});

test('SC2 空证据通过单独计数，缺数据不是 0', () => {
  const comments = [
    restComment({
      id: 31,
      number: 81,
      round: 1,
      status: '通过',
      startedAt: '2026-11-14T10:00:00+08:00',
      finishedAt: '2026-11-14T10:05:00+08:00',
      items: emptyEvidenceItems(),
    }),
  ];
  const snap = snapshotFrom({ comments, issues: [{ number: 81, html_url: `https://github.com/${REPO}/issues/81` }], events: [] });
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.metrics.emptyEvidencePass.numerator, 1);
  assert.equal(report.metrics.firstPassOriginal.numerator, 0);
  assert.equal(report.metrics.repeatAlerts.unknown, true);
  assert.equal(report.metrics.repeatAlerts.numerator, null);
  assert.equal(report.metrics.deployAuth.unknown, true);
  assert.equal(report.metrics.deployAuth.numerator, null);
  assert.ok(report.missingProductionData.some((line) => /alerts\.jsonl/.test(line)));
});

test('SC2 纯环境中断不进一次通过分母；终局与环境等待分开', () => {
  const comments = [
    restComment({
      id: 41,
      number: 82,
      round: 1,
      status: '中断',
      startedAt: '2026-11-14T16:00:00Z',
      finishedAt: '2026-11-14T16:06:00Z',
      reason: envReason(),
    }),
  ];
  const snap = snapshotFrom({ comments, issues: [{ number: 82, html_url: `https://github.com/${REPO}/issues/82` }], events: [] });
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.metrics.firstPassOriginal.denominator, 0);
  assert.equal(report.metrics.firstPassOriginal.numerator, 0);
  assert.equal(report.daily.find((row) => row.localDate === '2026-11-13' || row.localDate === '2026-11-14').envWaits >= 0, true);
  const nov14 = report.daily.find((row) => row.localDate === '2026-11-14');
  assert.equal(nov14.envWaits, 1);
  assert.equal(nov14.firstFinals, 0);
});

test('SC2 返工：通过之后又要修，一单只计一次', () => {
  const comments = [
    restComment({
      id: 51,
      number: 83,
      round: 1,
      status: '通过',
      startedAt: '2026-11-13T10:00:00+08:00',
      finishedAt: '2026-11-13T10:05:00+08:00',
      items: cleanPassItems(),
    }),
    restComment({
      id: 52,
      number: 83,
      round: 2,
      status: '要修',
      startedAt: '2026-11-14T10:00:00+08:00',
      finishedAt: '2026-11-14T10:05:00+08:00',
      items: `- 要修：${REPO}#80 SC1`,
    }),
  ];
  const snap = snapshotFrom({ comments, issues: [{ number: 83, html_url: `https://github.com/${REPO}/issues/83` }], events: [] });
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.metrics.rework.numerator, 1);
  assert.equal(report.metrics.rework.denominator, 1);
});

test('SC2 返工也可由 reopen 事件触发', () => {
  const comments = [
    restComment({
      id: 61,
      number: 84,
      round: 1,
      status: '通过',
      startedAt: '2026-11-14T10:00:00+08:00',
      finishedAt: '2026-11-14T10:05:00+08:00',
      items: cleanPassItems(),
    }),
  ];
  const snap = snapshotFrom({
    comments,
    issues: [{ number: 84, html_url: `https://github.com/${REPO}/issues/84` }],
    events: [
      restEvent({ id: 11, number: 84, event: 'closed', created_at: '2026-11-14T02:06:00Z', login: BOT, type: 'Bot' }),
      restEvent({ id: 12, number: 84, event: 'reopened', created_at: '2026-11-14T03:00:00Z', login: USER, type: 'User' }),
    ],
  });
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.metrics.rework.numerator, 1);
  assert.equal(report.metrics.rework.sources[0].reopened, true);
});

test('SC2 缺 mergedAt 时交付时延 unknown 不是 0', () => {
  const comments = [
    restComment({
      id: 71,
      number: 85,
      round: 1,
      status: '要修',
      startedAt: '2026-11-14T10:00:00+08:00',
      finishedAt: '2026-11-14T10:05:00+08:00',
      items: `- 要修：${REPO}#85 SC1`,
    }),
  ];
  const snap = snapshotFrom({ comments, issues: [{ number: 85, html_url: `https://github.com/${REPO}/issues/85` }], events: [] });
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.metrics.deliveryLatency.unknown, true);
  assert.equal(report.metrics.deliveryLatency.values.length, 0);
  assert.equal(report.metrics.deliveryLatency.unknownIssues.length, 1);
});

test('SC2 重复认领：同一正文版本再次认领计入；完整签名缺 main SHA 为 unknown', () => {
  const report = computeMetrics(snapshotFrom(sampleSnapshot()), windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.ok(report.metrics.repeatClaimSameBody.numerator >= 14);
  assert.equal(report.metrics.repeatClaimSameBody.sources[0].bodyVersion, BODY_V1);
  assert.equal(report.metrics.repeatWakeFullSignature.unknown, true);
  assert.equal(report.metrics.repeatWakeFullSignature.numerator, null);
});

test('SC2 重复告警：同一 kind+issue+sha 60 分钟内第二条计入；缺文件 unknown', () => {
  const ts0 = '2026-11-14T02:00:00.000Z';
  const ts1 = new Date(Date.parse(ts0) + ALERT_DEDUP_MS / 2).toISOString();
  const ts2 = new Date(Date.parse(ts0) + ALERT_DEDUP_MS + 1000).toISOString();
  const snap = snapshotFrom({
    comments: [],
    issues: [],
    events: [],
    alerts: [
      alertLine({ ts: ts0, kind: 'prefetch-failed', issue: `${REPO}#62`, head: 'deadbeef' }),
      alertLine({ ts: ts1, kind: 'prefetch-failed', issue: `${REPO}#62`, head: 'deadbeef' }),
      alertLine({ ts: ts2, kind: 'prefetch-failed', issue: `${REPO}#62`, head: 'deadbeef' }),
      alertLine({ ts: ts0, kind: 'heartbeat-delayed' }),
    ],
  });
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.metrics.repeatAlerts.unknown, false);
  assert.equal(report.metrics.repeatAlerts.numerator, 1);
  assert.equal(report.metrics.repeatAlerts.denominator, 3);
  assert.equal(report.keepalive.notInQualityPassRate, true);
  assert.equal(report.keepalive.heartbeatAlerts.numerator, 1);
});

test('SC2/SC5 心跳不进入质量通过率；缺心跳 unknown', () => {
  const fresh = heartbeatFreshness({ at: '2026-11-14T18:26:00Z', tickIntervalS: 180 }, NOW_NOV14_PST_MORNING);
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.notInQualityPassRate, true);
  const stale = heartbeatFreshness({ at: '2026-11-14T18:00:00Z', tickIntervalS: 180 }, NOW_NOV14_PST_MORNING);
  assert.equal(stale.fresh, false);
  const missing = heartbeatFreshness(null, NOW_NOV14_PST_MORNING);
  assert.equal(missing.unknown, true);
  const report = computeMetrics(snapshotFrom(sampleSnapshot()), windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.keepalive.notInQualityPassRate, true);
  assert.equal(report.metrics.firstPassOriginal.definition.includes('心跳'), false);
});

test('SC3 legacy 部署状态授权 unknown；B 格式 User 评论可核实、Bot 不可核实', () => {
  const legacy = normalizeDeployRecord(legacyDeployState());
  assert.equal(legacy.format, 'legacy-state');
  assert.equal(legacy.unknownAuth, true);
  const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const ok = normalizeDeployRecord(bDeployRow({ ts: '2026-11-14T01:00:00Z', toSha: sha, authorization: userAuth(sha) }));
  const bot = normalizeDeployRecord(bDeployRow({ ts: '2026-11-14T01:10:00Z', toSha: sha, authorization: botAuth(sha) }));
  const snap = snapshotFrom({
    comments: [],
    issues: [],
    events: [],
    deployments: [ok, bot],
  });
  const report = computeMetrics(snap, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.coverage.deploy, 'b-log');
  assert.equal(report.metrics.deployAuth.unknown, false);
  assert.equal(report.metrics.deployAuth.numerator, 1);
  assert.equal(report.metrics.deployAuth.denominator, 2);
  assert.equal(report.metrics.deployAuth.verifiable.length, 1);

  const onlyLegacy = snapshotFrom({ comments: [], issues: [], events: [], deployState: legacyDeployState() });
  const unknown = computeMetrics(onlyLegacy, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(unknown.coverage.deploy, 'legacy-state');
  assert.equal(unknown.metrics.deployAuth.unknown, true);
  assert.equal(unknown.metrics.deployAuth.numerator, null);
});

test('SC4 跨日：终局落在窗口外的完整日不计入该日', () => {
  const comments = [
    restComment({
      id: 91,
      number: 90,
      round: 1,
      status: '通过',
      startedAt: '2026-11-14T07:50:00Z',
      finishedAt: '2026-11-14T07:59:59Z',
      items: cleanPassItems(),
    }),
  ];
  comments[0].created_at = '2026-11-14T07:50:00Z';
  const snap = snapshotFrom({ comments, issues: [{ number: 90, html_url: `https://github.com/${REPO}/issues/90` }], events: [] });
  const only14 = completeLocalWindow({ nowMs: NOW_NOV15_LA, fromDate: '2026-11-14', toDate: '2026-11-14' });
  const only13 = completeLocalWindow({ nowMs: NOW_NOV15_LA, fromDate: '2026-11-13', toDate: '2026-11-13' });
  assert.equal(computeMetrics(snap, only14, { nowMs: NOW_NOV15_LA }).metrics.firstPassOriginal.denominator, 0);
  assert.equal(computeMetrics(snap, only13, { nowMs: NOW_NOV15_LA }).metrics.firstPassOriginal.denominator, 1);
});

test('SC1 CLI JSON 写明时区并保留 commentId；默认不含今天', async () => {
  const dir = tmpDir('fleet-quality-cli-');
  const file = path.join(dir, 'snap.json');
  fs.writeFileSync(file, JSON.stringify(sampleSnapshot()));
  const stdout = [];
  const stderr = [];
  const code = await main(['--snapshot', file, '--now', '2026-11-14T18:29:00Z', '--labeled-sample'], {
    stdout: { write: (chunk) => stdout.push(chunk) },
    stderr: { write: (chunk) => stderr.push(chunk) },
  });
  assert.equal(code, 0, stderr.join(''));
  const report = JSON.parse(stdout.join(''));
  assert.equal(report.window.timeZone, 'America/Los_Angeles');
  assert.equal(report.window.toLocalDate, '2026-11-13');
  assert.equal(report.window.fromLocalDate, '2026-11-07');
  assert.equal(report.metrics.firstPassOriginal.denominator, 0, '11-14 的终局不在默认完整日 7-13');
});

test('SC3 CLI 可直接跑，不必改 package 脚本', () => {
  const dir = tmpDir('fleet-quality-spawn-');
  const file = path.join(dir, 'snap.json');
  fs.writeFileSync(file, JSON.stringify(sampleSnapshot()));
  const result = runCli(['--snapshot', file, '--now', '2026-11-15T18:00:00Z', '--labeled-sample']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.metrics.humanUnverifiedClose.sources[0].commentId, 1016);
});

test('SC3 工具源码不 spawn、不读 home、不 import github/profile', () => {
  const src = fs.readFileSync(BIN, 'utf8');
  assert.equal(src.includes('child_process'), false);
  assert.equal(src.includes('spawn('), false);
  assert.equal(/loadAcceptanceProfile|githubTokenFile/.test(src), false);
  assert.equal(/from '\.\/github\.mjs'|from '\.\/profile\.mjs'/.test(src), false);
  assert.match(src, /不读令牌/);
});

test('parseArgs 拒绝未知参数；缺输入退出 2', async () => {
  assert.throws(() => parseArgs(['--nope']), /不认识的参数/);
  const code = await main([], { stdout: { write() {} }, stderr: { write() {} } });
  assert.equal(code, 2);
});

test('SC5 文档不承诺收益，心跳不进通过率，样例不可外推', () => {
  const text = fs.readFileSync(DOC, 'utf8');
  assert.match(text, /America\/Los_Angeles/);
  assert.match(text, /不能外推/);
  assert.equal(/提升\d+%|减少重复|因此达标|预计少/.test(text), false);
  assert.match(text, /心跳.*不进入质量通过率|保活不进入质量通过率/);
  assert.match(text, /unknown/);
  assert.match(text, /可写副本/);
  assert.match(text, /待核实/);
});

test('SC4 缺 alerts 文件时重复告警 unknown；空文件是已知 0', () => {
  const dir = tmpDir('fleet-quality-alerts-');
  fs.writeFileSync(path.join(dir, 'comments.json'), JSON.stringify([]));
  const missing = loadSnapshot({ snapshot: dir });
  const report = computeMetrics(missing, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(report.metrics.repeatAlerts.unknown, true);

  fs.writeFileSync(path.join(dir, 'alerts.jsonl'), '');
  const empty = loadSnapshot({ snapshot: dir });
  const known = computeMetrics(empty, windowFor(NOW_NOV15_LA), { nowMs: NOW_NOV15_LA });
  assert.equal(known.metrics.repeatAlerts.unknown, false);
  assert.equal(known.metrics.repeatAlerts.numerator, 0);
  assert.equal(known.metrics.repeatAlerts.denominator, 0);
});

test('zonedMidnightUtcMs 与 addCalendarDays 稳定', () => {
  assert.equal(addCalendarDays('2026-11-13', 1), '2026-11-14');
  assert.equal(zonedMidnightUtcMs('2026-11-14', DEFAULT_TIMEZONE), Date.parse('2026-11-14T08:00:00Z'));
});

test('parseVerdictItems 读真实逐条行形', () => {
  const items = parseVerdictItems(`## 逐条结果\n${PASS_ITEMS}`);
  assert.equal(items.filter((item) => item.result === '人工手测').length, 3);
  assert.equal(items.filter((item) => item.evidenceClass.kind === 'writable-copy').length, 1);
  assert.equal(items.filter((item) => item.evidenceClass.kind === 'temp-copy-extra-tests').length, 1);
});
