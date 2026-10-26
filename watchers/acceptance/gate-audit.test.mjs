// 写闸账本旁路审计（host/gate-audit.mjs）：合规账本不误报、每种违规各报一次、基线 / 增量 / 去重 / ack，
// 以及它和 Slack 文案、常驻循环、doctor 的接法。全部用临时 home，不碰真目录、不碰真 GitHub、不碰真 Slack。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  ACCEPTANCE_OPTIONS,
  BOARD_ACCESS_QUERY,
  PROJECT_QUERY,
  REPO_QUERY,
  VIEWER_QUERY,
  runDoctor,
} from './bin/doctor.mjs';
import { ISSUE_COMMENTS_QUERY } from './bin/rounds.mjs';
import { acknowledgeAudit, auditEntries, checkRoundComments, readLedgerLines, runGateAudit } from './host/gate-audit.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import { alertBlocks, esc } from './host/slack-blocks.mjs';
import { classify } from './host/slack-notify.mjs';
import { runTick } from './host/tick.mjs';
import { OWNER, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

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
  for (const call of present.calls) assert.equal(call.query, ISSUE_COMMENTS_QUERY);

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
  assert.equal(first.baseline.violations, 2);
  assert.deepEqual(first.baseline.rules, { 'type-not-allowed': 1, 'repo-out-of-scope': 1 });
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

  // 账本被截短：报一次 ledger-rewritten，旧违规不重复。
  const file = hostPaths(home).ledgerFile;
  const kept = fs.readFileSync(file, 'utf8').trim().split('\n').slice(0, 2);
  fs.writeFileSync(file, `${kept.join('\n')}\n`);
  const rewritten = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.deepEqual(rewritten.newViolations.map((item) => item.rule), ['ledger-rewritten']);
  assert.equal(rewritten.sinceBaseline, 2);
  const rewrittenAlert = readAlerts(hostPaths(home)).filter((alert) => alert.kind === 'gate-audit-violation');
  assert.equal(rewrittenAlert.length, 2);
  assert.match(rewrittenAlert[1].reason, /1 条/);

  // 改写（不是截短）也报：把第一行的去重键换掉，前缀哈希就变了。
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const firstEntry = JSON.parse(lines[0]);
  lines[0] = JSON.stringify({ ...firstEntry, dedupeKey: `${firstEntry.dedupeKey}-changed` });
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const edited = await runGateAudit({ home, profile: profile(), now: () => NOW });
  assert.deepEqual(edited.newViolations.map((item) => item.rule), ['ledger-rewritten']);
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
  for (const call of calls) assert.equal(call.query, ISSUE_COMMENTS_QUERY);

  // 第二次跑（基线已建好）也一样只查评论，不写。
  const again = await runGateAudit({ home, profile: profile(), github, now: () => NOW, alert: false });
  assert.equal(again.ok, true);
  for (const call of calls) assert.equal(call.query, ISSUE_COMMENTS_QUERY);
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
  assert.deepEqual(fine.lastTick.gateAudit, { checked: 3, found: 1, sinceBaseline: 2 });
  assert.equal(fine.lastTick.gateAuditError, undefined);
  assert.equal(fine.lastTick.ok, true);
  // 审计拿到的 home / profile / 只读 github：这一拍不查 GitHub。
  assert.equal(seen.home, home);
  assert.equal(seen.github, null);
  assert.equal(seen.profile.ownerLogin, OWNER);
  const onDisk = JSON.parse(fs.readFileSync(hostPaths(home).heartbeatFile, 'utf8'));
  assert.deepEqual(onDisk.lastTick.gateAudit, { checked: 3, found: 1, sinceBaseline: 2 });
});

test('doctor：写闸账本审计 ok / 不 ok 都报出来，明细带基线和新发现', async () => {
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
  const run = (gateAudit) =>
    runDoctor({ profileEnv: { ACCEPTANCE_WATCHER_HOME: home }, probes, github, now: () => NOW, gateAudit });
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
