// 写闸账本旁路审计（host/gate-audit.mjs）：合规账本不误报、每种违规各报一次、基线 / 增量 / 去重 / ack，
// 以及它和 Slack 文案、常驻循环、doctor 的接法。全部用临时 home，不碰真目录、不碰真 GitHub、不碰真 Slack。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_OPTIONS,
  BOARD_ACCESS_QUERY,
  PROJECT_QUERY,
  REPO_QUERY,
  VIEWER_QUERY,
  runDoctor,
} from './bin/doctor.mjs';
import { READ_RETRY_DELAY_MS } from './bin/github.mjs';
import {
  AUDIT_COMMENT_CONCURRENCY,
  AUDIT_COMMENTS_QUERY,
  AUDIT_RULES_VERSION,
  DEFINITE_RULES,
  RULE_TEXT,
  UNCERTAIN_RULES,
  acknowledgeAudit,
  auditPaths,
  auditEntries,
  checkRoundComments,
  formatSummary,
  readLedgerLines,
  ruleLevel,
  runGateAudit,
  summarizeAudit,
} from './host/gate-audit.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { loadScopes, recordScope, scopeForEntry, scopeOf } from './host/scope-snapshot.mjs';
import { alertBlocks, esc } from './host/slack-blocks.mjs';
import { classify } from './host/slack-notify.mjs';
import { runTick } from './host/tick.mjs';
import { OWNER, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'example-owner/example-repo';
const WATCH_REPO = 'example-org/watch-repo';
const ROOT = `${REPO}#1`;
const CORRECTION = `${REPO}#2`;
const AT = '2026-02-01T00:00:00.000Z';
const NOW = Date.parse('2026-02-10T00:00:00.000Z');

function profile(extra = {}) {
  return {
    ownerLogin: OWNER,
    projectNumber: 7,
    autoRepos: ['example-owner/*'],
    forkRepos: ['ExampleUser/fork-repo'],
    watchRepos: [WATCH_REPO],
    verdictOnlyIssues: [],
    ...extra,
  };
}

function commentUrl(id, { repo = REPO, issue = 1 } = {}) {
  return `https://github.com/${repo}/issues/${issue}#issuecomment-${id}`;
}

function issueUrl(issue, repo = REPO) {
  return `https://github.com/${repo}/issues/${issue}`;
}

function roundStart(id, round, { root = ROOT, repo = REPO, issue = 1, key } = {}) {
  return {
    dedupeKey: key || `round-start:${root}:${round}:2026-02-0${round}T08:00:00.000+08:00`,
    type: 'comment.create',
    result: { commentId: id, url: commentUrl(id, { repo, issue }) },
    at: AT,
  };
}

/** 一份和真实格式一致的合规账本：新旧两种去重键、每类写、watch 档、修正轮认领 + 多次状态更新 + 看板。 */
function compliantEntries() {
  return [
    // 第 1 轮：认领（旧键，没有 startedAt 后缀）、看板「验收中」、收尾（新键）
    roundStart(1001, 1, { key: `round-start:${ROOT}:1` }),
    { dedupeKey: `board-claim:${ROOT}:1:1001`, type: 'project.field.set', result: { itemId: 'PVTI_1' } },
    {
      dedupeKey: `round-finish:${ROOT}:1:1001:通过`,
      type: 'comment.update',
      result: { commentId: 1001, url: commentUrl(1001) },
    },
    // 第 2 轮：裁决（新键）、勾验收项、关单、写看板（带评论 URL）、推分支
    roundStart(1002, 2),
    { dedupeKey: `verdict:${ROOT}:2:1002:通过`, type: 'comment.update', result: { commentId: 1002, url: commentUrl(1002) } },
    {
      dedupeKey: `close-edit:${ROOT}:2`,
      type: 'issue.edit',
      result: { issue: 1, url: issueUrl(1) },
      boundCommentId: 1002,
    },
    {
      dedupeKey: `close:${ROOT}:2`,
      type: 'issue.close',
      result: { issue: 1, url: issueUrl(1) },
      boundCommentId: 1002,
    },
    {
      dedupeKey: `board:${ROOT}:通过:${commentUrl(1002)}:2`,
      type: 'project.field.set',
      result: { itemId: 'PVTI_2' },
      boundCommentId: 1002,
    },
    {
      dedupeKey: `push:${REPO}:acceptance/1-1:abcdef1234567`,
      type: 'branch.push',
      result: {},
      boundCommentId: 1002,
    },
    // 第 3 轮：收尾用旧键（没有评论 id 段）
    roundStart(1003, 3, { key: `round-start:${ROOT}:3` }),
    { dedupeKey: `round-finish:${ROOT}:3:要修`, type: 'comment.update', result: { commentId: 1003, url: commentUrl(1003) } },
    // 第 4 轮：裁决用旧键；开修正子 issue、加子 issue、重开
    roundStart(1004, 4),
    { dedupeKey: `verdict:${ROOT}:4:通过`, type: 'comment.update', result: { commentId: 1004, url: commentUrl(1004) } },
    {
      dedupeKey: `correct:${ROOT}:${CORRECTION}:SC1:4`,
      type: 'issue.create',
      result: { issue: 2, url: issueUrl(2) },
      boundCommentId: 1004,
    },
    {
      dedupeKey: `correct-sub:${ROOT}:${REPO}#3:SC1:4`,
      type: 'subissue.add',
      result: { issue: 1, subIssue: 3, id: 'PVT_sub_1' },
      boundCommentId: 1004,
    },
    {
      dedupeKey: `reopen:${ROOT}:4`,
      type: 'issue.reopen',
      result: { issue: 1, url: issueUrl(1) },
      boundCommentId: 1004,
    },
    // watch 档：只留认领评论
    roundStart(1010, 1, { root: `${WATCH_REPO}#9`, repo: WATCH_REPO, issue: 9 }),
    // 修正轮：认领 + 认领评论更新多次 + 看板 + 推分支
    {
      dedupeKey: `prbot:${CORRECTION}:r1:s1767225600000:claim`,
      type: 'comment.create',
      result: { commentId: 2001, url: commentUrl(2001, { issue: 2 }) },
    },
    {
      dedupeKey: `prbot:${CORRECTION}:r1:c2001:comment:1:aaaaaaaaaaaaaaaa`,
      type: 'comment.update',
      result: { commentId: 2001, url: commentUrl(2001, { issue: 2 }) },
    },
    {
      dedupeKey: `prbot:${CORRECTION}:r1:c2001:comment:2:bbbbbbbbbbbbbbbb`,
      type: 'comment.update',
      result: { commentId: 2001, url: commentUrl(2001, { issue: 2 }) },
    },
    {
      dedupeKey: `prbot:${CORRECTION}:r1:c2001:board:${CORRECTION}`,
      type: 'project.field.set',
      result: { itemId: 'PVTI_3' },
    },
    {
      dedupeKey: `prbot:${CORRECTION}:r1:c2001:push:head:abcdef1:abcdef2`,
      type: 'branch.push',
      result: {},
    },
  ];
}

function toLines(entries) {
  return entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
}

/** 建一个临时 home，把账本原样写进去（字符串行按原文写，用来造坏行）。 */
function homeWithLedger(entries) {
  const home = tmpDir();
  const file = hostPaths(home).ledgerFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = toLines(entries);
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  return home;
}

function appendLedger(home, entries) {
  const file = hostPaths(home).ledgerFile;
  fs.appendFileSync(file, `${toLines(entries).join('\n')}\n`, { mode: 0o600 });
}

/** 纯函数核对：读回账本再跑 auditEntries，返回违规的规则名。 */
function rulesOf(entries, options = {}) {
  const home = homeWithLedger(entries);
  const { entries: parsed } = readLedgerLines(hostPaths(home).ledgerFile);
  return auditEntries(parsed, { profile: profile(), ...options }).violations.map((item) => item.rule);
}

test('合规账本：和真实格式一致的样例一条都不报', () => {
  const entries = compliantEntries();
  assert.deepEqual(rulesOf(entries), []);
  // 只出裁决的总 issue 名单不影响认领 / 收尾 / 裁决 / 看板这类写（只禁关、勾、开修正、推送）。
  assert.deepEqual(rulesOf(entries.slice(0, 5), { profile: profile({ verdictOnlyIssues: [ROOT] }) }), []);
});

test('每种违规各报一条：类型、仓范围、分档、轮次、轮次评论', () => {
  const base = compliantEntries();
  const cases = [
    [
      'pr-merge',
      { dedupeKey: `push:${REPO}:main:abcdef1`, type: 'pr.merge', result: {}, boundCommentId: 1001 },
    ],
    ['comment-delete', { dedupeKey: `board-claim:${ROOT}:1:1001`, type: 'comment.delete', result: {} }],
    ['type-not-allowed', { dedupeKey: `board-claim:${ROOT}:1:1001`, type: 'issue.transfer', result: {} }],
    ['repo-out-of-scope', { dedupeKey: 'push:example-other/other-repo:main:abcdef1', type: 'branch.push', result: {}, boundCommentId: 1001 }],
    ['tier-not-allowed', { dedupeKey: `close:${WATCH_REPO}#9:1`, type: 'issue.close', result: { issue: 9, url: issueUrl(9, WATCH_REPO) } }],
    ['no-round', { dedupeKey: `push:${REPO}:main:abcdef1`, type: 'branch.push', result: {}, boundCommentId: 9999 }],
    ['unverifiable', { dedupeKey: 'someone-elses-key:example-owner/example-repo#1', type: 'comment.create', result: {} }],
    [
      'round-comment-modified',
      {
        dedupeKey: `push:${REPO}:acceptance/1-1:abcdef1`,
        type: 'comment.update',
        result: { commentId: 1001, url: commentUrl(1001) },
        boundCommentId: 1001,
      },
    ],
    [
      'round-comment-modified',
      { dedupeKey: `round-finish:${ROOT}:1:1001:中断`, type: 'comment.update', result: { commentId: 1001, url: commentUrl(1001) } },
    ],
    [
      'round-comment-modified',
      {
        dedupeKey: `prbot:${CORRECTION}:r1:c2001:comment:3:cccccccccccccccc`,
        type: 'comment.update',
        result: { commentId: 1001, url: commentUrl(1001) },
      },
    ],
  ];
  for (const [rule, entry] of cases) {
    assert.deepEqual(rulesOf([...base, entry]), [rule], `${rule}：${JSON.stringify(entry.dedupeKey)}`);
  }
  // 坏行单独一条（读不出 JSON）。
  assert.deepEqual(rulesOf([...base, '{坏行']), ['ledger-corrupt']);
});

test('轮次对不上、只出裁决的总 issue、修正轮改别人的评论：各报一条且不连带别的', () => {
  const entries = [
    roundStart(1001, 1),
    roundStart(1002, 2),
    // 绑定的是第 2 轮的评论，去重键里却是第 1 轮的
    {
      dedupeKey: `round-finish:${ROOT}:1:1001:通过`,
      type: 'comment.update',
      result: { commentId: 1001, url: commentUrl(1001) },
      boundCommentId: 1002,
    },
  ];
  assert.deepEqual(rulesOf(entries), ['round-mismatch']);

  // 轮次评论属于别的总 issue：root 对不上。
  assert.deepEqual(
    rulesOf([
      roundStart(1001, 1),
      roundStart(1002, 2),
      { dedupeKey: `round-finish:${REPO}#7:2:1001:通过`, type: 'comment.update', result: { commentId: 1001, url: commentUrl(1001) } },
    ]),
    ['round-mismatch'],
  );

  // 只出裁决的总 issue：关单不许；裁决评论和看板照常。
  const rootOnly = [
    roundStart(1001, 1),
    { dedupeKey: `verdict:${ROOT}:1:1001:通过`, type: 'comment.update', result: { commentId: 1001, url: commentUrl(1001) } },
    { dedupeKey: `board-claim:${ROOT}:1:1001`, type: 'project.field.set', result: {} },
  ];
  assert.deepEqual(rulesOf(rootOnly, { profile: profile({ verdictOnlyIssues: [ROOT] }) }), []);
  const close = { dedupeKey: `close:${ROOT}:1`, type: 'issue.close', result: { issue: 1, url: issueUrl(1) }, boundCommentId: 1001 };
  assert.deepEqual(rulesOf([...rootOnly, close], { profile: profile({ verdictOnlyIssues: [ROOT] }) }), ['verdict-only-write']);
  // 名单为空时同样的写入不报（和写闸一致）。
  assert.deepEqual(rulesOf([...rootOnly, close]), []);
});

test('轮次评论被删：只读查 GitHub 发现；评论满 100 条且窗口没覆盖那一轮时不下结论', async () => {
  const entries = compliantEntries();
  const { entries: parsed } = (() => {
    const home = homeWithLedger(entries);
    return readLedgerLines(hostPaths(home).ledgerFile);
  })();
  const { rounds } = auditEntries(parsed, { profile: profile() });

  const fake = (nodesFor) => ({
    calls: [],
    async graphql(query, variables) {
      this.calls.push({ query, variables });
      return { repository: { issue: { comments: { nodes: nodesFor(variables) } } } };
    },
  });

  // 评论还在：不报。
  const present = fake(() => [1001, 1002, 1003, 1004, 1010, 2001].map((id) => ({ databaseId: id, createdAt: AT })));
  const ok = await checkRoundComments({ rounds, entries: parsed, github: present });
  assert.deepEqual(ok.violations, []);
  assert.equal(ok.checked, 3);
  for (const call of present.calls) assert.equal(call.query, AUDIT_COMMENTS_QUERY);

  // 少了一条：报 round-comment-missing。
  const missing = fake((variables) =>
    [1001, 1002, 1003, 1004, 1010, 2001]
      .filter((id) => !(variables.number === 1 && id === 1003))
      .map((id) => ({ databaseId: id, createdAt: AT })),
  );
  const found = await checkRoundComments({ rounds, entries: parsed, github: missing });
  assert.deepEqual(found.violations.map((item) => item.rule), ['round-comment-missing']);

  // 满 100 条、窗口最老的评论比那一轮还新（窗口没覆盖）：不下结论。
  const fullNodes = Array.from({ length: 100 }, (_, index) => ({
    databaseId: 9000 + index,
    createdAt: '2026-03-01T00:00:00.000Z',
  }));
  const full = await checkRoundComments({ rounds, entries: parsed, github: fake(() => fullNodes) });
  assert.deepEqual(full.violations, []);
});

test('基线：第一次跑只统计不报；之后新增一条违规报一条、写一条提醒和一行审计日志', async () => {
  const history = [
    ...compliantEntries(),
    { dedupeKey: `board-claim:${ROOT}:1:1001`, type: 'issue.transfer', result: {} },
    { dedupeKey: 'push:example-other/other-repo:main:abcdef1', type: 'branch.push', result: {}, boundCommentId: 1001 },
  ];
  const home = homeWithLedger(history);
  const first = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(first.baselineCreated, true);
  assert.deepEqual(first.newViolations, []);
  assert.equal(first.sinceBaseline, 0);
  assert.equal(first.baseline.lines, history.length);
  assert.equal(first.baseline.violations, 2, 'baseline.violations 只计明确违规（type-not-allowed 也是明确违规）');
  assert.equal(first.baseline.uncertain, 0);
  assert.deepEqual(first.baseline.rules, { 'type-not-allowed': 1, 'repo-out-of-scope': 1 });
  assert.deepEqual(first.baseline.uncertainRules, {});
  assert.equal(first.checkedLines, history.length);
  assert.deepEqual(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation'), []);

  // 之后新增一条违规：报一条，写一条提醒、一行审计日志。
  appendLedger(home, [{ dedupeKey: `close:${ROOT}:2`, type: 'pr.merge', result: {} }]);
  const second = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(second.newViolations.length, 1);
  assert.equal(second.newViolations[0].rule, 'pr-merge');
  assert.equal(second.newViolations[0].line, history.length + 1);
  assert.equal(second.sinceBaseline, 1);
  assert.equal(second.ok, false);
  const alerts = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].count, 1);
  assert.equal(alerts[0].issue, ROOT);
  assert.match(alerts[0].detail, new RegExp(`第 ${history.length + 1} 行 pr\\.merge`), alerts[0].detail);
  const log = fs.readFileSync(path.join(hostPaths(home).hostDir, 'gate-audit.log'), 'utf8').trim().split('\n');
  assert.equal(log.length, 1);
  const logged = JSON.parse(log[0]);
  assert.equal(logged.rule, 'pr-merge');
  assert.equal(logged.line, history.length + 1);

  // 去重：再跑一次不重复报、不重复写提醒。
  const third = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.deepEqual(third.newViolations, []);
  assert.equal(third.sinceBaseline, 1);
  assert.equal(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation').length, 1);
  assert.equal(fs.readFileSync(path.join(hostPaths(home).hostDir, 'gate-audit.log'), 'utf8').trim().split('\n').length, 1);

  // 账本被截短：报一次 ledger-rewritten（明确违规：写提醒、ok=false），旧违规不重复。
  const file = hostPaths(home).ledgerFile;
  const kept = fs.readFileSync(file, 'utf8').trim().split('\n').slice(0, 2);
  fs.writeFileSync(file, `${kept.join('\n')}\n`);
  const rewritten = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.deepEqual(rewritten.newViolations.map((item) => item.rule), ['ledger-rewritten']);
  assert.equal(rewritten.newViolations[0].level, 'violation');
  assert.deepEqual(rewritten.newUncertain, []);
  assert.equal(rewritten.uncertainSinceBaseline, 0);
  assert.equal(rewritten.sinceBaseline, 2);
  assert.equal(rewritten.ok, false);
  assert.equal(rewritten.status, 'violation');
  const rewrittenAlerts = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation');
  assert.equal(rewrittenAlerts.length, 2);
  assert.equal(rewrittenAlerts[1].count, 1);
  assert.equal(rewrittenAlerts[1].rules, 'ledger-rewritten');
  assert.match(rewrittenAlerts[1].detail, /改写或截短/);

  // 改写（不是截短）也报：把第一行的去重键换掉，前缀哈希就变了。
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const firstEntry = JSON.parse(lines[0]);
  lines[0] = JSON.stringify({ ...firstEntry, dedupeKey: `${firstEntry.dedupeKey}-changed` });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const edited = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.deepEqual(edited.newViolations.map((item) => item.rule), ['ledger-rewritten']);
  assert.deepEqual(edited.newUncertain, []);
  assert.equal(edited.ok, false);
  assert.equal(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation').length, 3);
});

test('增量：checkedLines 只算这次新增的行', async () => {
  const history = compliantEntries();
  const home = homeWithLedger(history);
  const first = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(first.checkedLines, history.length);

  appendLedger(home, [
    roundStart(1011, 2, { root: `${WATCH_REPO}#9`, repo: WATCH_REPO, issue: 9 }),
    { dedupeKey: `board-claim:${WATCH_REPO}#9:2:1011`, type: 'project.field.set', result: {} },
  ]);
  const second = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(second.checkedLines, 2);
  assert.deepEqual(second.newViolations, []);
  assert.equal(second.ok, true);
});

test('ack：清零基线后违规数、ok 变 true，旧违规不重报，日志和指纹保留', async () => {
  const home = homeWithLedger(compliantEntries());
  await runGateAudit({ home, profile: profile(), now: () => NOW });
  appendLedger(home, [{ dedupeKey: `close:${WATCH_REPO}#9:1`, type: 'issue.close', result: { issue: 9, url: issueUrl(9, WATCH_REPO) } }]);
  const before = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(before.sinceBaseline, 1);
  assert.equal(before.ok, false);

  const state = acknowledgeAudit({ home, now: () => NOW });
  assert.equal(state.sinceBaseline, 0);
  assert.equal(state.acknowledgedAt, new Date(NOW).toISOString());

  const after = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(after.sinceBaseline, 0);
  assert.equal(after.ok, true);
  assert.deepEqual(after.newViolations, []);
  assert.equal(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation').length, 1);
});

test('审计不写 GitHub：只发固定的只读评论查询，write 被调用就算失败', async () => {
  const home = homeWithLedger(compliantEntries());
  const calls = [];
  const github = {
    async graphql(query, variables) {
      calls.push({ query, variables });
      return {
        repository: {
          issue: { comments: { nodes: [1001, 1002, 1003, 1004, 1010, 2001].map((id) => ({ databaseId: id, createdAt: AT })) } },
        },
      };
    },
    write() {
      throw new Error('审计不许写 GitHub');
    },
  };
  const result = await runGateAudit({ home, profile: profile(), github, now: () => NOW, alert: false });
  assert.deepEqual(result.newViolations, []);
  assert.deepEqual(result.githubErrors, []);
  assert.equal(calls.length, 3, '每个有轮次的 issue 各查一次');
  for (const call of calls) assert.equal(call.query, AUDIT_COMMENTS_QUERY);

  // 第二次跑（基线已建好）也一样只查评论，不写。
  const again = await runGateAudit({ home, profile: profile(), github, now: () => NOW, alert: false });
  assert.equal(again.ok, true);
  for (const call of calls) assert.equal(call.query, AUDIT_COMMENTS_QUERY);
});

test('Slack：gate-audit-violation 立即发、文案四段、明细转义后只进 blocks', () => {
  assert.equal(classify('alerts', { kind: 'gate-audit-violation' }), 'blocked');
  const detail = [
    `第 3 行 pr.merge：账本里有合并 PR（pr.merge）的记录，写闸规则里根本不许合并（${ROOT}）`,
    '第 4 行 issue.close：只观察（watch）的仓上出现了不许的写（example-org/watch-repo）<!channel>',
  ].join('\n');
  const notice = {
    source: 'alerts',
    kind: 'gate-audit-violation',
    type: 'gate-audit-violation',
    issue: ROOT,
    reason: '写闸账本审计发现 2 条违规',
    detail,
    count: 2,
  };
  const payload = alertBlocks(notice, profile());
  assert.ok(payload.text.startsWith('写闸账本审计发现越规写入'), payload.text);
  assert.match(payload.text, /需要你处理/);
  assert.match(payload.text, /2 条，明细见消息/);
  assert.equal(payload.text.includes('原始记录'), false);
  assert.equal(payload.text.includes('<!channel>'), false);
  assert.equal(payload.blocks.length, 3);
  const body = payload.blocks.map((block) => block.text?.text || '').join('\n');
  for (const label of ['发生了什么', '有没有影响', '验收机已自动做了什么', '要不要人处理']) {
    assert.ok(body.includes(label), `缺「${label}」`);
  }
  assert.match(body, /没有关写闸/);
  assert.ok(body.includes('违规明细（共 2 条，最多列 5 条，其余见审计日志）：'), body);
  assert.ok(body.includes(`· ${esc(detail.split('\n')[0])}`), '明细行要转义后逐行列出');
  assert.ok(body.includes('&lt;!channel&gt;'), '明细里的 <!channel> 要转义');
  assert.equal(body.includes('<!channel>'), false);

  // 超过 5 条只列前 5 条，总数照 event.count 报。
  const many = alertBlocks(
    { ...notice, count: 9, detail: Array.from({ length: 9 }, (_, index) => `第 ${index + 1} 行：越规`).join('\n') },
    profile(),
  );
  const manyBody = many.blocks.map((block) => block.text?.text || '').join('\n');
  assert.match(manyBody, /违规明细（共 9 条，最多列 5 条，其余见审计日志）：/);
  assert.equal(manyBody.split('\n').filter((line) => line.startsWith('· ')).length, 5);
  assert.match(many.text, /9 条，明细见消息/);
});

test('常驻循环：审计出错只进心跳（这一拍照常成功、不写 tick-failed）；正常结果写进 lastTick.gateAudit', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } });
  const base = {
    home,
    env: { ...process.env },
    run: async () => ({ code: 0, stdout: '[]', stderr: '' }),
    spawnRound: () => 1,
    runRound: async () => ({ code: 0, stdout: '', stderr: '' }),
    now: () => NOW,
    notify: async () => ({ ok: true, sent: 0 }),
  };

  const broken = await runTick({
    ...base,
    gateAudit: async () => {
      throw new Error('账本读不出');
    },
  });
  assert.equal(broken.lastTick.ok, true);
  assert.equal(broken.lastTick.error, null);
  assert.equal(broken.lastTick.gateAudit, undefined);
  assert.equal(broken.lastTick.gateAuditError, '账本读不出');
  assert.deepEqual(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'tick-failed'), []);

  let seen = null;
  const fine = await runTick({
    ...base,
    gateAudit: async (options) => {
      seen = options;
      return { checkedLines: 3, newViolations: [{ rule: 'pr-merge' }], sinceBaseline: 2 };
    },
  });
  assert.deepEqual(fine.lastTick.gateAudit, { checked: 3, found: 1, sinceBaseline: 2, uncertain: 0 });
  assert.equal(fine.lastTick.gateAuditError, undefined);
  assert.equal(fine.lastTick.ok, true);
  // 审计拿到的 home / profile / 只读 github：这一拍不查 GitHub。
  assert.equal(seen.home, home);
  assert.equal(seen.github, null);
  assert.equal(seen.profile.ownerLogin, OWNER);
  const onDisk = JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
  assert.deepEqual(onDisk.lastTick.gateAudit, { checked: 3, found: 1, sinceBaseline: 2, uncertain: 0 });
});

/** doctor 的假环境：假 gh、假探针、临时 home。只用于「写闸账本审计」这一项。 */
function doctorHarness() {
  const home = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } }).home;
  const github = {
    async graphql(query) {
      if (query === VIEWER_QUERY) return { viewer: { login: OWNER } };
      if (query === REPO_QUERY) return { repository: { nameWithOwner: REPO, viewerPermission: 'WRITE' } };
      if (query === PROJECT_QUERY) return { user: { projectV2: { id: 'PVT_1', title: '看板' } } };
      throw new Error(`假 gh 不认识的查询：${query.slice(0, 30)}`);
    },
    async ownerGraphql(query) {
      if (query === BOARD_ACCESS_QUERY) {
        return {
          user: {
            projectV2: {
              id: 'PVT_1',
              viewerCanUpdate: true,
              fields: {
                nodes: [
                  {
                    __typename: 'ProjectV2SingleSelectField',
                    name: '验收',
                    dataType: 'SINGLE_SELECT',
                    options: ACCEPTANCE_OPTIONS.map((name) => ({ name })),
                  },
                  { __typename: 'ProjectV2Field', name: '裁决', dataType: 'TEXT' },
                ],
              },
            },
          },
        };
      }
      throw new Error(`假 gh 不认识的账号令牌查询：${query.slice(0, 30)}`);
    },
  };
  const probes = {
    which: (cmd) => (cmd === 'gh' ? '/usr/bin/gh' : cmd === 'git' ? '/usr/bin/git' : null),
    runWriteCommand: async () => ({ code: 4 }),
    sandboxMask: async () => ({ ok: true, detail: '遮住了' }),
  };
  return {
    home,
    run: (gateAudit) =>
      runDoctor({ profileEnv: { ACCEPTANCE_WATCHER_HOME: home }, probes, github, now: () => NOW, gateAudit }),
  };
}

test('doctor：写闸账本审计 ok / 不 ok 都报出来，明细带基线和新发现', async () => {
  const { run } = doctorHarness();
  const checkOf = (result, name) => result.checks.find((check) => check.name === name);

  const bad = await run(async () => ({
    ok: false,
    checkedLines: 5,
    sinceBaseline: 2,
    baseline: { at: '2026-02-01T00:00:00.000Z', lines: 40, violations: 1 },
    githubErrors: ['example-owner/example-repo#1：读不到评论'],
    newViolations: [
      { line: 41, type: 'pr.merge', text: '账本里有合并 PR（pr.merge）的记录，写闸规则里根本不许合并', root: ROOT },
      { line: 42, type: 'issue.close', text: '只观察（watch）的仓上出现了不许的写', repo: WATCH_REPO },
    ],
  }));
  const failed = checkOf(bad, '写闸账本审计');
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /核对 5 行/);
  assert.match(failed.detail, /基线 2026-02-01T00:00:00\.000Z（基线前 40 条，疑似违规 1 条）/);
  assert.match(failed.detail, /基线后违规 2 条/);
  assert.match(failed.detail, /GitHub 只读核对没做成：example-owner\/example-repo#1：读不到评论/);
  assert.match(failed.detail, /这次新发现：第 41 行 pr\.merge/);
  assert.equal(bad.ok, false);

  const good = await run(async () => ({
    ok: true,
    checkedLines: 0,
    sinceBaseline: 0,
    baseline: { at: '2026-02-01T00:00:00.000Z', lines: 12, violations: 0 },
    githubErrors: [],
    newViolations: [],
  }));
  const passed = checkOf(good, '写闸账本审计');
  assert.equal(passed.ok, true);
  assert.match(passed.detail, /核对 0 行/);
  assert.match(passed.detail, /基线后违规 0 条/);
  assert.equal(passed.detail.includes('GitHub 只读核对没做成'), false);

  // 审计抛错：只这一项不 ok，detail 是首行错误。
  const broke = await run(async () => {
    throw new Error('runGateAudit 需要绝对路径的 home\n第二行不该出现');
  });
  const broken = checkOf(broke, '写闸账本审计');
  assert.equal(broken.ok, false);
  assert.equal(broken.detail, 'runGateAudit 需要绝对路径的 home');
});

// ---- 两级分类：明确违规 vs 拿不准（只记日志） ----

/** 读回审计日志（一行一条 JSON）。 */
function auditLogRows(home) {
  const file = path.join(hostPaths(home).hostDir, 'gate-audit.log');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/** 假 gh：只提供固定的只读评论查询；调写方法直接让测试失败。 */
const ROUND_COMMENTS = [1001, 1002, 1003, 1004, 1010, 2001];
function roundGithub({ missing = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async graphql(query, variables) {
      calls.push({ query, variables });
      const nodes = ROUND_COMMENTS.filter((id) => !(variables.number === 1 && missing.has(id))).map((id) => ({
        databaseId: id,
        createdAt: AT,
      }));
      return { repository: { issue: { comments: { nodes } } } };
    },
    write() {
      throw new Error('审计不许写 GitHub');
    },
  };
}

test('规则两级划分：每条规则恰好在一级里，未知规则算拿不准', () => {
  for (const rule of Object.keys(RULE_TEXT)) {
    assert.equal(DEFINITE_RULES.has(rule) !== UNCERTAIN_RULES.has(rule), true, `${rule} 必须恰好在一级里`);
    assert.equal(ruleLevel(rule), DEFINITE_RULES.has(rule) ? 'violation' : 'uncertain', rule);
  }
  assert.deepEqual([...DEFINITE_RULES], [
    'pr-merge',
    'comment-delete',
    'repo-out-of-scope',
    'tier-not-allowed',
    'verdict-only-write',
    'round-comment-modified',
    'round-comment-missing',
    'type-not-allowed',
    'ledger-rewritten',
  ]);
  assert.deepEqual([...UNCERTAIN_RULES], ['no-round', 'round-mismatch', 'unverifiable', 'ledger-corrupt']);
  assert.equal(ruleLevel('something-new'), 'uncertain');
  assert.equal(ruleLevel(undefined), 'uncertain');
});

test('基线：明确违规和拿不准分开计数，拿不准不发提醒', async () => {
  const history = [
    ...compliantEntries(),
    { dedupeKey: `push:${REPO}:main:abcdef9`, type: 'pr.merge', result: {}, boundCommentId: 1001 },
    { dedupeKey: `push:${REPO}:main:abcdef8`, type: 'branch.push', result: {}, boundCommentId: 9999 },
    { dedupeKey: 'someone-elses-key:x', type: 'comment.create', result: {} },
  ];
  const home = homeWithLedger(history);
  const first = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(first.baselineCreated, true);
  assert.equal(first.baseline.violations, 1, 'baseline.violations 只计明确违规');
  assert.equal(first.baseline.uncertain, 2);
  assert.deepEqual(first.baseline.rules, { 'pr-merge': 1 });
  assert.deepEqual(first.baseline.uncertainRules, { 'no-round': 1, unverifiable: 1 });
  assert.equal(first.baseline.sample.length, 3);
  assert.equal(first.sinceBaseline, 0);
  assert.equal(first.uncertainSinceBaseline, 0);
  assert.deepEqual(first.newViolations, []);
  assert.deepEqual(first.newUncertain, []);
  assert.equal(first.ok, true);
  assert.equal(first.status, 'ok');
  assert.deepEqual(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation'), []);
  const state = JSON.parse(fs.readFileSync(path.join(hostPaths(home).hostDir, 'gate-audit.json'), 'utf8'));
  assert.equal(state.sinceBaseline, 0);
  assert.equal(state.uncertainSinceBaseline, 0);
});

test('拿不准只记日志、不发提醒：no-round / round-mismatch / unverifiable', async () => {
  const cases = [
    {
      rule: 'no-round',
      history: compliantEntries(),
      entry: { dedupeKey: `push:${REPO}:main:abcdef1`, type: 'branch.push', result: {}, boundCommentId: 9999 },
    },
    {
      rule: 'round-mismatch',
      history: [roundStart(1001, 1), roundStart(1002, 2)],
      entry: {
        dedupeKey: `round-finish:${ROOT}:1:1001:通过`,
        type: 'comment.update',
        result: { commentId: 1001, url: commentUrl(1001) },
        boundCommentId: 1002,
      },
    },
    {
      rule: 'unverifiable',
      history: compliantEntries(),
      entry: { dedupeKey: 'someone-elses-key:example-owner/example-repo#1', type: 'comment.create', result: {} },
    },
  ];
  for (const { rule, history, entry } of cases) {
    const home = homeWithLedger(history);
    await runGateAudit({ home, profile: profile(), now: () => NOW });
    appendLedger(home, [entry]);
    const result = await runGateAudit({ home, profile: profile(), now: () => NOW });
    assert.equal(ruleLevel(rule), 'uncertain', rule);
    assert.deepEqual(result.newViolations, [], rule);
    assert.deepEqual(result.newUncertain.map((item) => item.rule), [rule], rule);
    assert.equal(result.newUncertain[0].level, 'uncertain', rule);
    assert.equal(result.ok, true, rule);
    assert.equal(result.status, 'uncertain', rule);
    assert.equal(result.sinceBaseline, 0, rule);
    assert.equal(result.uncertainSinceBaseline, 1, rule);
    assert.equal(result.uncertain24h, 1, rule);
    assert.deepEqual(
      readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation'),
      [],
      `${rule} 不该写提醒`,
    );
    const rows = auditLogRows(home);
    assert.equal(rows.length, 1, rule);
    assert.equal(rows[0].rule, rule);
    assert.equal(rows[0].level, 'uncertain');
  }
});

test('明确违规照旧发提醒：pr.merge / 范围外仓库 / 越权写 / 轮次评论被改 / 白名单外写类型', async () => {
  const cases = [
    [
      'pr-merge',
      profile(),
      compliantEntries(),
      { dedupeKey: `push:${REPO}:main:abcdef1`, type: 'pr.merge', result: {}, boundCommentId: 1001 },
    ],
    [
      'repo-out-of-scope',
      profile(),
      compliantEntries(),
      { dedupeKey: 'push:example-other/other-repo:main:abcdef1', type: 'branch.push', result: {}, boundCommentId: 1001 },
    ],
    [
      'verdict-only-write',
      profile({ verdictOnlyIssues: [ROOT] }),
      compliantEntries().slice(0, 5),
      { dedupeKey: `close:${ROOT}:1`, type: 'issue.close', result: { issue: 1, url: issueUrl(1) }, boundCommentId: 1001 },
    ],
    [
      'round-comment-modified',
      profile(),
      compliantEntries(),
      {
        dedupeKey: `push:${REPO}:acceptance/1-1:abcdef1`,
        type: 'comment.update',
        result: { commentId: 1001, url: commentUrl(1001) },
        boundCommentId: 1001,
      },
    ],
    [
      'type-not-allowed',
      profile(),
      compliantEntries(),
      { dedupeKey: `board-claim:${ROOT}:1:1001`, type: 'issue.transfer', result: {} },
    ],
  ];
  for (const [rule, prof, history, entry] of cases) {
    const home = homeWithLedger(history);
    await runGateAudit({ home, profile: prof, now: () => NOW });
    appendLedger(home, [entry]);
    const result = await runGateAudit({ home, profile: prof, now: () => NOW });
    assert.equal(ruleLevel(rule), 'violation', rule);
    assert.deepEqual(result.newViolations.map((item) => item.rule), [rule], rule);
    assert.equal(result.newViolations[0].level, 'violation', rule);
    assert.deepEqual(result.newUncertain, [], rule);
    assert.equal(result.ok, false, rule);
    assert.equal(result.status, 'violation', rule);
    assert.equal(result.sinceBaseline, 1, rule);
    assert.equal(result.uncertainSinceBaseline, 0, rule);
    const alerts = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation');
    assert.equal(alerts.length, 1, rule);
    assert.equal(alerts[0].count, 1, rule);
    assert.match(alerts[0].detail, new RegExp(`第 ${history.length + 1} 行`), rule);
    assert.equal(auditLogRows(home)[0].level, 'violation', rule);
  }
});

test('GitHub 只读：轮次评论缺失报 definite、写提醒，且只发评论查询', async () => {
  const history = compliantEntries();
  const home = homeWithLedger(history);
  const initial = roundGithub();
  const first = await runGateAudit({ home, profile: profile(), github: initial, now: () => NOW });
  assert.equal(first.baselineCreated, true);
  assert.equal(first.baseline.violations, 0);
  assert.equal(first.baseline.githubChecked, true);
  assert.ok(initial.calls.length > 0);
  for (const call of initial.calls) assert.equal(call.query, AUDIT_COMMENTS_QUERY);

  const missing = roundGithub({ missing: new Set([1003]) });
  const second = await runGateAudit({ home, profile: profile(), github: missing, now: () => NOW });
  assert.deepEqual(second.newViolations.map((item) => item.rule), ['round-comment-missing']);
  assert.equal(second.newViolations[0].level, 'violation');
  assert.deepEqual(second.newUncertain, []);
  assert.equal(second.status, 'violation');
  assert.equal(second.sinceBaseline, 1);
  assert.deepEqual(second.githubErrors, []);
  assert.ok(missing.calls.length > 0);
  for (const call of missing.calls) assert.equal(call.query, AUDIT_COMMENTS_QUERY, '只许发固定的只读评论查询');
  const alerts = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].count, 1);
  assert.match(alerts[0].detail, /第 11 行 round-comment-missing|轮次评论 1003/);
});

test('两类同时出现：提醒的 count/detail/rules 只含 definite，日志两类都记', async () => {
  const history = compliantEntries();
  const home = homeWithLedger(history);
  await runGateAudit({ home, profile: profile(), now: () => NOW });
  appendLedger(home, [
    { dedupeKey: `push:${REPO}:main:abcdef1`, type: 'pr.merge', result: {}, boundCommentId: 1001 },
    { dedupeKey: `push:${REPO}:main:abcdef2`, type: 'branch.push', result: {}, boundCommentId: 9999 },
  ]);
  const result = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.deepEqual(result.newViolations.map((item) => item.rule), ['pr-merge']);
  assert.deepEqual(result.newUncertain.map((item) => item.rule), ['no-round']);
  assert.equal(result.sinceBaseline, 1);
  assert.equal(result.uncertainSinceBaseline, 1);
  assert.equal(result.status, 'violation');
  assert.equal(result.ok, false);
  const alerts = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].count, 1);
  assert.equal(alerts[0].rules, 'pr-merge');
  assert.match(alerts[0].reason, /1 条/);
  assert.match(alerts[0].detail, /pr\.merge/);
  assert.equal(alerts[0].detail.includes('对不上任何登记过的轮次'), false, '提醒里不许带拿不准的明细');
  assert.deepEqual(
    auditLogRows(home).map((row) => row.level),
    ['violation', 'uncertain'],
  );
});

test('pr.merge 又认不出格式：只报一条 pr-merge，不再补 unverifiable', () => {
  const home = homeWithLedger([
    { dedupeKey: 'someone-elses-key:example-owner/example-repo#1', type: 'pr.merge', result: {} },
  ]);
  const { entries } = readLedgerLines(hostPaths(home).ledgerFile);
  const { violations } = auditEntries(entries, { profile: profile() });
  assert.deepEqual(violations.map((item) => item.rule), ['pr-merge']);
  assert.equal(violations[0].level, 'violation');
});

test('锁被占：busy，不写任何东西，status=uncertain', async () => {
  const home = homeWithLedger(compliantEntries());
  const paths = auditPaths(home);
  fs.mkdirSync(path.dirname(paths.auditLock), { recursive: true, mode: 0o700 });
  fs.writeFileSync(paths.auditLock, JSON.stringify({ pid: process.pid, startedAt: new Date(NOW).toISOString() }));
  const result = await runGateAudit({ home, profile: profile(), now: () => NOW, lockWaitMs: 0 });
  assert.equal(result.busy, true);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'uncertain');
  assert.deepEqual(result.newViolations, []);
  assert.deepEqual(result.newUncertain, []);
  assert.equal(result.sinceBaseline, 0);
  assert.equal(result.uncertain24h, 0);
  assert.equal(fs.existsSync(paths.auditStateFile), false, '拿不到锁就不该写状态文件');
  assert.equal(fs.existsSync(paths.auditLogFile), false, '拿不到锁就不该写审计日志');
});

test('summarizeAudit：24 小时窗口过滤、老日志行按 rule 分级、只读不写文件', async () => {
  const home = homeWithLedger(compliantEntries());
  await runGateAudit({ home, profile: profile(), now: () => NOW });
  const logFile = path.join(hostPaths(home).hostDir, 'gate-audit.log');
  const rows = [
    // 老日志行（没有 level）：按 rule 判成拿不准。
    {
      ts: new Date(NOW - 3600 * 1000).toISOString(),
      rule: 'no-round',
      line: 20,
      type: 'branch.push',
      key: 'k1',
      root: ROOT,
      detail: '轮次评论 9999',
      text: RULE_TEXT['no-round'],
    },
    // 老日志行（没有 level）：按 rule 判成明确违规。
    {
      ts: new Date(NOW - 2 * 3600 * 1000).toISOString(),
      rule: 'pr-merge',
      line: 21,
      type: 'pr.merge',
      key: 'k2',
      text: RULE_TEXT['pr-merge'],
    },
    // 25 小时前：窗口外。
    {
      ts: new Date(NOW - 25 * 3600 * 1000).toISOString(),
      rule: 'repo-out-of-scope',
      line: 22,
      type: 'branch.push',
      key: 'k3',
      repo: 'example-other/other-repo',
      text: RULE_TEXT['repo-out-of-scope'],
    },
    // 新日志行：自带 level。
    {
      ts: new Date(NOW - 3 * 3600 * 1000).toISOString(),
      level: 'uncertain',
      rule: 'unverifiable',
      line: 23,
      type: 'comment.create',
      key: 'k4',
      text: RULE_TEXT.unverifiable,
    },
  ];
  fs.writeFileSync(logFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n{坏行\n`, { mode: 0o600 });

  const snapshot = () => {
    const out = new Map();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const stat = fs.statSync(full);
          out.set(path.relative(home, full), `${stat.size}:${stat.mtimeMs}:${fs.readFileSync(full, 'utf8').length}`);
        }
      }
    };
    walk(home);
    return out;
  };
  const before = snapshot();
  const summary = summarizeAudit({ home, now: () => NOW });
  assert.deepEqual(snapshot(), before, 'summarizeAudit 不许写任何文件');

  assert.equal(summary.hours, 24);
  assert.equal(summary.since, new Date(NOW - 24 * 3600 * 1000).toISOString());
  assert.equal(summary.uncertainCount, 2);
  assert.equal(summary.violationCount, 1);
  assert.deepEqual(summary.uncertain.map((item) => item.line), [20, 23]);
  assert.deepEqual(summary.violations.map((item) => item.line), [21]);
  assert.equal(summary.uncertain[0].level, 'uncertain', '老日志行没有 level，按 rule 判');
  assert.equal(summary.uncertain[1].level, 'uncertain');
  assert.equal(summary.violations[0].level, 'violation', '老日志行没有 level，按 rule 判');
  assert.equal(summary.sinceBaseline, 0);
  assert.equal(summary.uncertainSinceBaseline, 0);
  assert.equal(summary.lastRunAt, new Date(NOW).toISOString());
  assert.equal([...summary.uncertain, ...summary.violations].some((item) => item.line === 22), false, '25 小时前的不算');

  const text = formatSummary(summary);
  assert.match(
    text,
    /最近 24 小时（自 2026-02-09T00:00:00\.000Z）：拿不准 2 条，明确违规 1 条；基线后未清零的明确违规 0 条/,
  );
  assert.match(text, /\[拿不准\] 第 20 行 branch\.push/);
  assert.match(text, /\[违规\] 第 21 行 pr\.merge/);

  // 自定义窗口：48 小时内也看得到，原来窗口外的那条回来了。
  const wide = summarizeAudit({ home, now: () => NOW, hours: 48 });
  assert.equal(wide.hours, 48);
  assert.equal(wide.violationCount, 2);

  // 日志和状态都不存在算空。
  const empty = summarizeAudit({ home: tmpDir(), now: () => NOW });
  assert.equal(empty.uncertainCount, 0);
  assert.equal(empty.violationCount, 0);
  assert.equal(empty.sinceBaseline, 0);
  assert.equal(empty.lastRunAt, null);
});

test('formatSummary：每类最多列 50 条，超出写「……另有 K 条」', () => {
  const uncertain = Array.from({ length: 51 }, (_, index) => ({
    line: index + 1,
    rule: 'no-round',
    type: 'branch.push',
    level: 'uncertain',
    text: RULE_TEXT['no-round'],
  }));
  const text = formatSummary({
    hours: 24,
    since: '2026-02-09T00:00:00.000Z',
    uncertain,
    uncertainCount: 51,
    violations: [],
    violationCount: 0,
    sinceBaseline: 0,
  });
  assert.equal(text.split('\n').filter((line) => line.startsWith('  [拿不准] ')).length, 50);
  assert.match(text, /……另有 1 条（拿不准）/);
});

// ---- 命令行 ----

function cliHome(entries) {
  const { home } = writeProfile(tmpDir(), { profile: { watchRepos: [WATCH_REPO] } });
  const file = hostPaths(home).ledgerFile;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lines = toLines(entries);
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
  return { home, ledger: file };
}

function runGateAuditCli(home, args) {
  const result = spawnSync(process.execPath, [path.join(HERE, 'host', 'gate-audit.mjs'), ...args], {
    env: { ...process.env, ACCEPTANCE_WATCHER_HOME: home },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

test('CLI：--json 退出码 0/1/2，--summary 只读退出 0，崩溃退出 3', () => {
  const history = compliantEntries();
  const { home, ledger } = cliHome(history);

  // 基线：退出码 0。
  const baseline = runGateAuditCli(home, ['--json']);
  assert.equal(baseline.code, 0, baseline.stderr);
  const first = JSON.parse(baseline.stdout.trim());
  assert.equal(first.status, 'ok');
  assert.equal(first.exitCode, 0);
  assert.equal(first.baselineCreated, true);
  assert.equal(first.checkedLines, history.length);
  assert.deepEqual(first.newViolations, []);
  assert.deepEqual(first.newUncertain, []);
  assert.equal(first.githubChecked, false, '不带 --github 就不查 GitHub');
  assert.deepEqual(first.githubErrors, []);
  assert.equal(first.busy, false);
  assert.equal(first.uncertain24h, 0);

  // 拿不准：只记日志、不写提醒，退出码 2。
  fs.appendFileSync(
    ledger,
    `${toLines([
      { dedupeKey: `push:${REPO}:main:abcdef1`, type: 'branch.push', result: {}, boundCommentId: 9999 },
    ]).join('\n')}\n`,
  );
  const uncertain = runGateAuditCli(home, ['--json']);
  assert.equal(uncertain.code, 2, uncertain.stderr);
  const second = JSON.parse(uncertain.stdout.trim());
  assert.equal(second.status, 'uncertain');
  assert.equal(second.exitCode, 2);
  assert.equal(second.newUncertain.length, 1);
  assert.match(second.newUncertain[0], /^第 \d+ 行 branch\.push/);
  assert.deepEqual(second.newViolations, []);
  assert.equal(second.sinceBaseline, 0);
  assert.equal(second.uncertainSinceBaseline, 1);
  assert.equal(second.uncertain24h, 1);
  assert.equal(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation').length, 0);

  // 明确违规：退出码 1。
  fs.appendFileSync(
    ledger,
    `${JSON.stringify({ dedupeKey: `push:${REPO}:main:abcdef2`, type: 'pr.merge', result: {}, boundCommentId: 1001 })}\n`,
  );
  const violation = runGateAuditCli(home, ['--json']);
  assert.equal(violation.code, 1, violation.stderr);
  const third = JSON.parse(violation.stdout.trim());
  assert.equal(third.status, 'violation');
  assert.equal(third.exitCode, 1);
  assert.equal(third.newViolations.length, 1);
  assert.match(third.newViolations[0], /pr\.merge/);
  assert.equal(third.sinceBaseline, 1);

  // --summary：只读汇总、退出码 0；人话里两级计数都有。
  const text = runGateAuditCli(home, ['--summary']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /最近 24 小时/);
  assert.match(text.stdout, /拿不准 1 条，明确违规 1 条/);
  assert.match(text.stdout, /\[拿不准\]/);
  assert.match(text.stdout, /\[违规\]/);
  const json = runGateAuditCli(home, ['--summary', '--json']);
  assert.equal(json.code, 0, json.stderr);
  const summary = JSON.parse(json.stdout.trim());
  assert.equal(summary.uncertainCount, 1);
  assert.equal(summary.violationCount, 1);
  assert.equal(summary.sinceBaseline, 1);
  assert.equal(summary.uncertainSinceBaseline, 1);
  assert.equal(summary.hours, 24);
  assert.notEqual(summary.lastRunAt, null);

  // 没有配置：崩溃退出码 3，stderr 一行，stdout 不输出。
  const broken = runGateAuditCli(tmpDir(), ['--json']);
  assert.equal(broken.code, 3, broken.stderr);
  assert.match(broken.stderr, /^写闸账本审计失败：/);
  assert.equal(broken.stderr.trim().split('\n').length, 1);
  assert.equal(broken.stdout, '');
});

// ---- doctor 的两级红绿 ----

test('doctor：拿不准是 ✓ 且 detail 带「拿不准」；GitHub 没查成也不变红', async () => {
  const { run } = doctorHarness();
  const checkOf = (result, name) => result.checks.find((check) => check.name === name);

  const uncertain = await run(async () => ({
    ok: true,
    status: 'uncertain',
    checkedLines: 0,
    sinceBaseline: 0,
    baseline: { at: '2026-02-01T00:00:00.000Z', lines: 12, violations: 0, uncertain: 4 },
    githubErrors: [],
    newViolations: [],
    newUncertain: [{ line: 13, type: 'branch.push', text: RULE_TEXT['no-round'], level: 'uncertain' }],
    uncertain24h: 3,
  }));
  const passed = checkOf(uncertain, '写闸账本审计');
  assert.equal(passed.ok, true, '拿不准不能算红');
  assert.match(passed.detail, /拿不准 新 1 条、近 24 小时 3 条（只记日志）/);

  const github = await run(async () => ({
    ok: true,
    status: 'uncertain',
    checkedLines: 2,
    sinceBaseline: 0,
    baseline: { at: '2026-02-01T00:00:00.000Z', lines: 12, violations: 0 },
    githubErrors: ['example-owner/example-repo#1：读不到评论'],
    newViolations: [],
    newUncertain: [],
    uncertain24h: 0,
  }));
  const green = checkOf(github, '写闸账本审计');
  assert.equal(green.ok, true, 'GitHub 没查成不算红');
  assert.match(green.detail, /GitHub 只读核对没做成：example-owner\/example-repo#1：读不到评论/);

  const definite = await run(async () => ({
    ok: false,
    status: 'violation',
    checkedLines: 3,
    sinceBaseline: 1,
    baseline: { at: '2026-02-01T00:00:00.000Z', lines: 12, violations: 0 },
    githubErrors: [],
    newViolations: [{ line: 13, type: 'pr.merge', text: RULE_TEXT['pr-merge'], root: ROOT }],
    newUncertain: [],
    uncertain24h: 0,
  }));
  const failed = checkOf(definite, '写闸账本审计');
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /这次新发现：第 13 行 pr\.merge/);
});

// ---- 仓范围按写入当时判（project-keel#59「宿主标中断」被误判越权的根因）----

const KEEL = 'example-owner/keel-repo';
const KEEL_ROOT = `${KEEL}#59`;

/** 暂停时换上的 profile：通配换成显式名单，keel-repo 不在里面。 */
function pausedProfile() {
  return profile({ autoRepos: [REPO] });
}

/** 一轮 keel 的认领 + 宿主标中断（和真实账本同形：round-finish:<root>:<n>:<评论 id>:中断）。 */
function keelRound({ scope } = {}) {
  const stamp = scope ? { scope } : {};
  return [
    {
      ...roundStart(3001, 1, { root: KEEL_ROOT, repo: KEEL, issue: 59 }),
      ...stamp,
    },
    {
      dedupeKey: `round-finish:${KEEL_ROOT}:1:3001:中断`,
      type: 'comment.update',
      result: { commentId: 3001, url: commentUrl(3001, { repo: KEEL, issue: 59 }) },
      at: AT,
      ...stamp,
    },
  ];
}

test('范围按写入当时判：带快照指纹的记录，事后把仓移出 autoRepos 也不算越权', () => {
  const home = homeWithLedger([]);
  const gateDir = hostPaths(home).gateDir;
  const hash = recordScope(gateDir, profile());
  const scopes = loadScopes(gateDir);
  const entries = [...compliantEntries(), ...keelRound({ scope: hash })];
  const audited = auditEntries(entries, { profile: pausedProfile(), scopes });
  assert.deepEqual(audited.violations.map((item) => item.rule), []);
  // 同样的记录不带指纹（老账本）：只能按当前配置判，照旧报越权（这正是 #59 那条误报的形状）。
  const legacy = auditEntries([...compliantEntries(), ...keelRound()], { profile: pausedProfile(), scopes });
  assert.deepEqual([...new Set(legacy.violations.map((item) => item.rule))], ['repo-out-of-scope']);
  assert.equal(legacy.violations[0].scopeSource, 'current');
});

test('范围按写入当时判：写入当时就不在范围内的，现在加进名单也照报', () => {
  const home = homeWithLedger([]);
  const gateDir = hostPaths(home).gateDir;
  const hash = recordScope(gateDir, pausedProfile());
  const scopes = loadScopes(gateDir);
  const audited = auditEntries([...compliantEntries(), ...keelRound({ scope: hash })], { profile: profile(), scopes });
  const out = audited.violations.filter((item) => item.rule === 'repo-out-of-scope');
  assert.ok(out.length >= 1);
  assert.equal(out[0].scopeSource, 'write-time');
  assert.equal(out[0].repo, KEEL);
});

test('范围快照被改过（内容和指纹对不上）就不认，退回按当前配置判', () => {
  const home = homeWithLedger([]);
  const gateDir = hostPaths(home).gateDir;
  const hash = recordScope(gateDir, pausedProfile());
  // 有人把快照改宽了：指纹核对不上，不认。
  fs.writeFileSync(path.join(gateDir, 'scopes', `${hash}.json`), JSON.stringify(scopeOf(profile())));
  const scopes = loadScopes(gateDir);
  assert.equal(scopes.has(hash), false);
  const audited = auditEntries([...compliantEntries(), ...keelRound({ scope: hash })], { profile: pausedProfile(), scopes });
  assert.equal(audited.violations.find((item) => item.rule === 'repo-out-of-scope')?.scopeSource, 'current');
  // 指纹格式不对的也不认。
  assert.equal(scopeForEntry({ scope: '../../etc' }, pausedProfile(), scopes).source, 'current');
});

test('复现 + 修复：写入后才暂停，带指纹的新记录审计不报、不发提醒', async () => {
  const home = homeWithLedger(compliantEntries());
  await runGateAudit({ home, profile: profile(), now: () => NOW });
  // 写闸按全量范围放行并记账（带指纹），之后人把 keel 暂停。
  const hash = recordScope(hostPaths(home).gateDir, profile());
  appendLedger(home, keelRound({ scope: hash }));
  const result = await runGateAudit({ home, profile: pausedProfile(), now: () => NOW });
  assert.deepEqual(result.newViolations, []);
  assert.equal(result.sinceBaseline, 0);
  assert.equal(result.ok, true);
  assert.deepEqual(readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation'), []);
});

test('规则升级重算：v1 下按暂停配置误判的老记录，范围恢复后自动重算清掉；真违规和 GitHub 发现照算', async () => {
  const home = homeWithLedger(compliantEntries());
  await runGateAudit({ home, profile: profile(), now: () => NOW });
  // 老记录（没指纹）+ 一条真违规（pr.merge）
  appendLedger(home, [...keelRound(), { dedupeKey: `close:${ROOT}:2`, type: 'pr.merge', result: {}, at: AT }]);
  const paused = await runGateAudit({ home, profile: pausedProfile(), now: () => NOW });
  assert.deepEqual(paused.newViolations.map((item) => item.rule).sort(), ['pr-merge', 'repo-out-of-scope', 'repo-out-of-scope']);
  assert.equal(paused.sinceBaseline, 3);
  // GitHub 核对发现的（账本算不出来，只能沿用日志）
  const paths = auditPaths(home);
  fs.appendFileSync(
    paths.auditLogFile,
    `${JSON.stringify({ ts: new Date(NOW).toISOString(), level: 'violation', rule: 'round-comment-missing', line: 1 })}\n`,
  );
  // 模拟这批状态是 v1 规则写的
  const state = JSON.parse(fs.readFileSync(paths.auditStateFile, 'utf8'));
  delete state.rulesVersion;
  state.sinceBaseline = 4;
  fs.writeFileSync(paths.auditStateFile, JSON.stringify(state));
  const alertsBefore = readAlerts(hostPaths(home)).length;

  // 范围恢复（"example-owner/*"）后的下一次审计：自动重算，误报消掉，pr.merge + GitHub 那条还在。
  const restored = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.deepEqual(restored.recheck, { before: 4, after: 2 });
  assert.equal(restored.sinceBaseline, 2);
  assert.equal(restored.ok, false);
  assert.equal(readAlerts(hostPaths(home)).length, alertsBefore, '重算不发提醒');
  const log = fs.readFileSync(paths.auditLogFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const info = log.filter((row) => row.level === 'info');
  assert.equal(info.length, 1);
  assert.match(info[0].detail, /v1→v2.*4 → 2/);
  // info 行不算拿不准、也不算违规
  const summary = summarizeAudit({ home, now: () => NOW });
  assert.equal(summary.uncertainCount, 0);
  assert.equal(summary.violationCount, 4);
  // 只重算一次
  const again = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(again.recheck, undefined);
  assert.equal(again.sinceBaseline, 2);
});

test('规则升级重算：只有误报时清零，ok 变 true，不靠 ack', async () => {
  const home = homeWithLedger(compliantEntries());
  await runGateAudit({ home, profile: profile(), now: () => NOW });
  appendLedger(home, keelRound());
  const paused = await runGateAudit({ home, profile: pausedProfile(), now: () => NOW });
  assert.equal(paused.ok, false);
  const paths = auditPaths(home);
  const state = JSON.parse(fs.readFileSync(paths.auditStateFile, 'utf8'));
  delete state.rulesVersion;
  fs.writeFileSync(paths.auditStateFile, JSON.stringify(state));
  const restored = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.equal(restored.sinceBaseline, 0);
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'ok');
  const after = JSON.parse(fs.readFileSync(paths.auditStateFile, 'utf8'));
  assert.equal(after.acknowledgedAt, undefined, '没有走 ack');
  assert.equal(after.rulesVersion, AUDIT_RULES_VERSION);
});

// ---- 轮次评论读取：有限并发，结论和逐条串行一致（#191） ----

const AUDIT_ROOT_REF = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d+)$/;
const COMMENT_AT = '2026-02-01T00:00:00.000Z';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 改前 checkRoundComments 的逐条参考：判定、错误文案、合并顺序都照原循环。 */
async function serialCheckRoundComments({ rounds, entries, github }) {
  const violations = [];
  const errors = [];
  if (!github || typeof github.graphql !== 'function') return { violations, errors, checked: 0 };
  let checked = 0;
  const byRoot = new Map();
  for (const value of rounds.values()) {
    const list = byRoot.get(value.root) || [];
    list.push(value);
    byRoot.set(value.root, list);
  }
  for (const [root, list] of byRoot) {
    const match = AUDIT_ROOT_REF.exec(root);
    if (!match) continue;
    const [owner, name] = match[1].split('/');
    let nodes;
    try {
      const data = await github.graphql('serial-reference', { owner, name, number: Number(match[2]) });
      nodes = data?.repository?.issue?.comments?.nodes;
    } catch (error) {
      const message = error?.message || error;
      const text = message === undefined || message === null ? '' : String(message);
      errors.push(`${root}：${text.split('\n')[0].slice(0, 120)}`);
      continue;
    }
    if (!Array.isArray(nodes)) {
      errors.push(`${root}：读不到评论`);
      continue;
    }
    checked += 1;
    const ids = new Set(nodes.map((node) => (node?.databaseId === undefined || node?.databaseId === null ? '' : String(node.databaseId))));
    const oldest = nodes.reduce((acc, node) => {
      const at = Date.parse(node?.createdAt || '');
      return Number.isFinite(at) && at < acc ? at : acc;
    }, Infinity);
    const full = nodes.length >= 100;
    for (const value of list) {
      if (ids.has(value.commentId)) continue;
      const startedAt = Date.parse(entries[value.line - 1]?.at || '');
      if (full && !(Number.isFinite(startedAt) && startedAt >= oldest)) continue;
      const key = entries[value.line - 1]?.dedupeKey;
      violations.push({
        line: value.line,
        rule: 'round-comment-missing',
        type: 'comment.create',
        key: key === undefined || key === null ? '' : String(key),
        root,
        text: RULE_TEXT['round-comment-missing'],
        detail: `轮次评论 ${value.commentId}（${root} 第 ${value.round} 轮）`,
        level: ruleLevel('round-comment-missing'),
      });
    }
  }
  return { violations, errors, checked };
}

/** 每个根两条轮次评论。偶数号缺第二条。另放一个对不上 issue 引用的根（两边都应跳过）。 */
function manyRoundComments(count) {
  const rounds = new Map();
  const entries = [];
  for (let number = 1; number <= count; number += 1) {
    const root = `example-org/audit-repo#${number}`;
    for (let round = 1; round <= 2; round += 1) {
      entries.push({ at: COMMENT_AT, dedupeKey: `round-start:${root}:${round}` });
      const commentId = String(100000 + number * 10 + round);
      rounds.set(`${number}:${round}`, { root, commentId, line: entries.length, round });
    }
  }
  entries.push({ at: COMMENT_AT, dedupeKey: 'not-a-round' });
  rounds.set('bad', { root: 'not-a-ref', commentId: '1', line: entries.length, round: 1 });
  return { rounds, entries };
}

function nodesForMany(variables) {
  const number = variables.number;
  const ids = [100000 + number * 10 + 1];
  if (number % 2 === 1) ids.push(100000 + number * 10 + 2);
  return ids.map((id) => ({ databaseId: id, createdAt: COMMENT_AT }));
}

function trackingGithub({ nodesFor, delayMs = 0, delayFor, failFor }) {
  let inFlight = 0;
  let peak = 0;
  const calls = [];
  return {
    calls,
    get peak() {
      return peak;
    },
    async graphql(query, variables) {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      calls.push({ query, variables });
      try {
        const wait = delayFor ? delayFor(variables) : delayMs;
        if (wait > 0) await sleep(wait);
        if (failFor) {
          const failed = failFor(variables);
          if (failed) throw failed;
        }
        const nodes = nodesFor(variables);
        if (nodes === undefined) return { repository: { issue: null } };
        return { repository: { issue: { comments: { nodes } } } };
      } finally {
        inFlight -= 1;
      }
    },
  };
}

test('轮次评论并发读取：≥70 个根，在飞峰值 >1 且 ≤4，查询不含正文和作者', async () => {
  const count = 70;
  const { rounds, entries } = manyRoundComments(count);
  const github = trackingGithub({ nodesFor: nodesForMany, delayMs: 40 });
  const result = await checkRoundComments({ rounds, entries, github });
  const serial = await serialCheckRoundComments({
    rounds,
    entries,
    github: trackingGithub({ nodesFor: nodesForMany }),
  });
  assert.deepEqual(result, serial);
  assert.equal(github.calls.length, count, '每个对得上的根各查一次');
  assert.ok(AUDIT_COMMENT_CONCURRENCY > 1 && AUDIT_COMMENT_CONCURRENCY <= 4);
  assert.ok(github.peak > 1, `在飞峰值应大于 1，实际 ${github.peak}`);
  assert.ok(github.peak <= AUDIT_COMMENT_CONCURRENCY, `在飞峰值应 ≤${AUDIT_COMMENT_CONCURRENCY}，实际 ${github.peak}`);
  console.log(`checkRoundComments in-flight peak=${github.peak} roots=${count}`);
  for (const call of github.calls) {
    assert.equal(call.query.includes('body'), false, call.query);
    assert.equal(call.query.includes('author'), false, call.query);
    assert.match(call.query, /databaseId/);
    assert.match(call.query, /createdAt/);
    assert.match(call.query, /last:\s*100/);
    assert.match(call.query, /^\s*query\b/);
    assert.doesNotMatch(call.query, /\bmutation\b/);
    assert.equal(call.variables.owner, 'example-org');
    assert.equal(call.variables.name, 'audit-repo');
  }
  const asked = github.calls.map((call) => call.variables.number).sort((a, b) => a - b);
  assert.deepEqual(asked, Array.from({ length: count }, (_, index) => index + 1));
});

test('轮次评论乱序返回：违规、错误和 checked 的顺序仍和串行版一致', async () => {
  const count = 72;
  const { rounds, entries } = manyRoundComments(count);
  const github = trackingGithub({
    nodesFor: nodesForMany,
    delayFor: (variables) => count - variables.number,
  });
  const result = await checkRoundComments({ rounds, entries, github });
  const serial = await serialCheckRoundComments({
    rounds,
    entries,
    github: trackingGithub({ nodesFor: nodesForMany }),
  });
  assert.deepEqual(result.violations, serial.violations);
  assert.deepEqual(result.errors, serial.errors);
  assert.equal(result.checked, serial.checked);
  assert.equal(result.checked, count);
  assert.ok(result.violations.length >= 36);
  assert.deepEqual(
    result.violations.map((item) => item.root),
    serial.violations.map((item) => item.root),
  );
});

test('轮次评论读失败：只记对应的根，格式不变，其余照判；读重试间隔仍是 4000', async () => {
  assert.equal(READ_RETRY_DELAY_MS, 4000);
  const rounds = new Map();
  const entries = [];
  for (let number = 1; number <= 5; number += 1) {
    const root = `example-org/audit-repo#${number}`;
    entries.push({ at: COMMENT_AT, dedupeKey: `round-start:${root}:1` });
    rounds.set(String(number), { root, commentId: String(3000 + number), line: entries.length, round: 1 });
  }
  const longLine = '错'.repeat(130);
  const github = trackingGithub({
    nodesFor: (variables) => {
      if (variables.number === 5) return undefined;
      if (variables.number === 2 || variables.number === 4) return [{ databaseId: 1, createdAt: COMMENT_AT }];
      return [{ databaseId: 3000 + variables.number, createdAt: COMMENT_AT }];
    },
    failFor: (variables) => (variables.number === 3 ? new Error(`${longLine}\n第二行不该进错误`) : null),
  });
  const result = await checkRoundComments({ rounds, entries, github });
  const serial = await serialCheckRoundComments({
    rounds,
    entries,
    github: trackingGithub({
      nodesFor: (variables) => {
        if (variables.number === 5) return undefined;
        if (variables.number === 2 || variables.number === 4) return [{ databaseId: 1, createdAt: COMMENT_AT }];
        return [{ databaseId: 3000 + variables.number, createdAt: COMMENT_AT }];
      },
      failFor: (variables) => (variables.number === 3 ? new Error(`${longLine}\n第二行不该进错误`) : null),
    }),
  });
  assert.deepEqual(result, serial);
  assert.deepEqual(result.errors, [
    `example-org/audit-repo#3：${'错'.repeat(120)}`,
    'example-org/audit-repo#5：读不到评论',
  ]);
  assert.deepEqual(
    result.violations.map((item) => item.root),
    ['example-org/audit-repo#2', 'example-org/audit-repo#4'],
  );
  assert.equal(result.checked, 3);
});

test('评论满 100 条：开轮早于最老一条不下结论，晚于最老一条照报', async () => {
  const oldest = '2026-06-01T00:00:00.000Z';
  const newer = '2026-08-01T00:00:00.000Z';
  const rounds = new Map();
  const entries = [];
  const cases = [
    { number: 1, at: '2026-01-01T00:00:00.000Z', length: 100, expect: false },
    { number: 2, at: '2026-07-01T00:00:00.000Z', length: 100, expect: true },
    { number: 3, at: '2026-01-01T00:00:00.000Z', length: 99, expect: true },
    { number: 4, at: '', length: 100, expect: false },
  ];
  for (const item of cases) {
    const root = `example-org/audit-repo#${item.number}`;
    entries.push({ at: item.at, dedupeKey: `round-start:${root}:1` });
    rounds.set(String(item.number), { root, commentId: '9999', line: entries.length, round: 1 });
  }
  const nodesFor = (variables) => {
    const item = cases.find((entry) => entry.number === variables.number);
    return Array.from({ length: item.length }, (_, index) => ({
      databaseId: 8000 + index,
      createdAt: index === 0 ? newer : oldest,
    }));
  };
  const result = await checkRoundComments({
    rounds,
    entries,
    github: trackingGithub({ nodesFor }),
  });
  const serial = await serialCheckRoundComments({
    rounds,
    entries,
    github: trackingGithub({ nodesFor }),
  });
  assert.deepEqual(result, serial);
  assert.deepEqual(
    result.violations.map((item) => item.root),
    ['example-org/audit-repo#2', 'example-org/audit-repo#3'],
  );
});

test('旧状态文件：version 1、没有新字段，再跑审计不报错，cursor、seen、baseline 不变', async () => {
  const home = homeWithLedger(compliantEntries());
  await runGateAudit({ home, profile: profile(), now: () => NOW });
  const paths = auditPaths(home);
  const planted = JSON.parse(fs.readFileSync(paths.auditStateFile, 'utf8'));
  const oldKeys = ['version', 'baseline', 'cursor', 'prefixHash', 'rulesVersion', 'sinceBaseline', 'uncertainSinceBaseline', 'lastRunAt', 'seen'];
  const oldState = {};
  for (const key of oldKeys) oldState[key] = planted[key];
  assert.equal(oldState.version, 1);
  assert.equal(Object.hasOwn(oldState, 'commentCache'), false);
  fs.writeFileSync(paths.auditStateFile, `${JSON.stringify(oldState, null, 2)}\n`);
  const result = await runGateAudit({ home, profile: profile(), now: () => NOW + 1000 });
  assert.equal(result.ok, true);
  const after = JSON.parse(fs.readFileSync(paths.auditStateFile, 'utf8'));
  assert.equal(after.cursor, oldState.cursor);
  assert.deepEqual(after.seen, oldState.seen);
  assert.deepEqual(after.baseline, oldState.baseline);
});

test('假 GitHub 每请求 200ms、70 个根：并发耗时低于串行的 50%', { timeout: 180000 }, async () => {
  const count = 70;
  const delayMs = 200;
  const { rounds, entries } = manyRoundComments(count);
  const serialGithub = trackingGithub({ nodesFor: nodesForMany, delayMs });
  const serialStarted = performance.now();
  await serialCheckRoundComments({ rounds, entries, github: serialGithub });
  const serialMs = performance.now() - serialStarted;
  const concurrentGithub = trackingGithub({ nodesFor: nodesForMany, delayMs });
  const concurrentStarted = performance.now();
  const result = await checkRoundComments({ rounds, entries, github: concurrentGithub });
  const concurrentMs = performance.now() - concurrentStarted;
  console.log(
    `checkRoundComments timing: serial=${serialMs.toFixed(0)}ms concurrent=${concurrentMs.toFixed(0)}ms roots=${count} delay=${delayMs}ms`,
  );
  assert.equal(result.checked, count);
  assert.ok(concurrentGithub.peak > 1 && concurrentGithub.peak <= 4, `peak=${concurrentGithub.peak}`);
  assert.ok(concurrentMs < serialMs * 0.5, `concurrent ${concurrentMs.toFixed(0)}ms serial ${serialMs.toFixed(0)}ms`);
});
