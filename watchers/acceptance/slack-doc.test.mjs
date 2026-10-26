// #61 SC6：Slack 通知文档 + 占位符检查。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DOC = path.join(ROOT, 'docs', 'acceptance-slack.md');
const OPERATIONS = path.join(ROOT, 'docs', 'acceptance-operations.md');
const README = path.join(HERE, 'README.md');
const EXAMPLE = path.join(ROOT, 'config', 'examples', 'acceptance.profile.example.json');

const doc = fs.readFileSync(DOC, 'utf8');

test('SC6 文档：频道与 app（Jasper）、频道 id 从 profile 读、可选的 @ 用户', () => {
  assert.match(doc, /Jasper/);
  assert.match(doc, /slackChannelId/);
  assert.match(doc, /C0123456789/);
  assert.match(doc, /slackMentionUserId/);
  assert.match(doc, /U0123456789/);
  assert.match(doc, /不写死在代码里|代码里没有/);
  assert.match(doc, /摘要永不 @|摘要不 @/);
});

test('SC6 文档：bot 令牌文件、600、只有 slack-notify 读、bwrap 遮住、app-level 令牌以后放单独文件', () => {
  assert.match(doc, /slackBotTokenFile/);
  assert.match(doc, /600/);
  assert.match(doc, /只有 `watchers\/acceptance\/host\/slack-notify\.mjs` 读这个文件/);
  assert.match(doc, /O_NOFOLLOW/);
  assert.match(doc, /不读环境变量/);
  assert.match(doc, /ACCEPTANCE_SLACK_BOT_TOKEN/);
  assert.match(doc, /Authorization: Bearer/);
  assert.match(doc, /bwrap/);
  assert.match(doc, /TokenFile/);
  assert.match(doc, /PrivateKeyFile/);
  assert.match(doc, /\/dev\/null/);
  assert.match(doc, /app-level 令牌/);
  assert.match(doc, /本 issue 不读/);
});

test('SC6 文档：需要的 scope（chat:write，重建要 channels:history / groups:history）', () => {
  assert.match(doc, /chat:write/);
  assert.match(doc, /chat\.postMessage/);
  assert.match(doc, /channels:history/);
  assert.match(doc, /groups:history/);
  assert.match(doc, /conversations\.history/);
  assert.match(doc, /include_all_metadata=true/);
  assert.match(doc, /vigil_acceptance_notice/);
  assert.match(doc, /ledger\.json/);
});

test('SC6 文档：事件表写清每类是 ping / 摘要 / 不发', () => {
  for (const type of ['needs-human', 'interrupted-exhausted', 'ready-stalled']) {
    assert.ok(doc.includes(`\`${type}\``), `事件表缺 ${type}`);
  }
  for (const kind of [
    'secret-found',
    'sandbox-unavailable',
    'round-failed',
    'gate-unavailable',
    'round-stale',
    'gate-rejected',
    'write-rejected',
    'round-stalled',
    'loop-restarted',
    'tick-failed',
    'prbot-tick-failed',
    'claimed',
    'draft-opened',
  ]) {
    assert.ok(doc.includes(`\`${kind}\``), `事件表缺 ${kind}`);
  }
  assert.match(doc, /未知 type/);
  assert.match(doc, /未知 kind/);
  assert.match(doc, /\*\*ping\*\*/);
  assert.match(doc, /\*\*摘要\*\*/);
  assert.match(doc, /同一任务连续中断/);
  assert.match(doc, /6 小时/);
  assert.match(doc, /最多每 60 分钟/);
  assert.match(doc, /验收结论本身/);
  assert.match(doc, /\*\*不发\*\*/);
  assert.match(doc, /egress-denied/);
  assert.match(doc, /query-not-allowed/);
  assert.match(doc, /只记日志/);
  assert.match(doc, /消息怎么写/);
  assert.match(doc, /发生了什么/);
  assert.match(doc, /有没有影响/);
  assert.match(doc, /验收机已自动做了什么/);
  assert.match(doc, /要不要人处理/);
  assert.match(doc, /验收机调度连续出错/);
});

test('SC6 文档：去重（事件 id、metadata、删账本重建、重建失败不发）与失败重试、心跳', () => {
  assert.match(doc, /sha256/);
  assert.match(doc, /前 16 位|16 位十六进制/);
  assert.match(doc, /ledger-rebuild-failed/);
  assert.match(doc, /1、5、15 分钟/);
  assert.match(doc, /第 4 次/);
  assert.match(doc, /heartbeat\.json/);
  assert.match(doc, /slack\.reason|`slack`/);
});

test('#70 复审文档：text 只用校验过的字段、@ 拆开、通知总时长有上限、放在验收调度之后', () => {
  assert.match(doc, /只用校验过的字段拼/);
  assert.match(doc, /零宽字符/);
  assert.match(doc, /<!subteam/);
  assert.match(doc, /NOTIFY_BUDGET_MS/);
  assert.match(doc, /notify-budget-exhausted/);
  assert.match(doc, /notify-timeout/);
  assert.match(doc, /notify-busy/);
  assert.match(doc, /验收调度\*\*之后\*\*/);
});

test('SC6 文档：第一步只有「打开 PR」；以后合并按钮的条件与伪造风险都写明', () => {
  assert.match(doc, /打开 PR/);
  assert.match(doc, /Mac mini/);
  assert.match(doc, /review-ingress-missing/);
  assert.match(doc, /pr\.merge/);
  assert.match(doc, /Socket Mode/);
  assert.match(doc, /写闸 exec|写闸的 `exec`/);
  for (const word of [
    '点击人',
    'auto 档',
    '修正标记',
    '不是 Draft',
    'head 等于',
    '全绿',
    '24 小时',
    'nonce',
    'PAUSED',
    '每日合并上限',
    '--match-head-commit',
    '--admin',
  ]) {
    assert.ok(doc.includes(word), `合并按钮条件里缺「${word}」`);
  }
  assert.match(doc, /伪造风险/);
  assert.match(doc, /非沙箱进程/);
  assert.match(doc, /伪造\*\*一次\*\*点击/);
});

test('SC6 文档与示例：只用占位符，运维文档和验收机 README 都链过去', () => {
  const banned = [
    ['Praise', 'Zhu'].join(''),
    ['/', 'home', '/'].join(''),
    ['/', 'Users', '/'].join(''),
    'xox',
  ];
  for (const file of [DOC, README, EXAMPLE]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const word of banned) {
      assert.equal(text.includes(word), false, `${path.relative(ROOT, file)} 含敏感词 ${word}`);
    }
  }
  // 频道 id 只作为占位符出现。
  const ids = doc.match(/\b[CG][A-Z0-9]{6,}\b/g) || [];
  for (const id of new Set(ids)) assert.equal(id, 'C0123456789', `文档里出现了别的频道 id：${id}`);

  assert.ok(fs.readFileSync(OPERATIONS, 'utf8').includes('acceptance-slack.md'), '运维文档要加一行链接');
  assert.ok(fs.readFileSync(README, 'utf8').includes('../../docs/acceptance-slack.md'), '验收机 README 要链过去');

  const example = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
  assert.equal(example.slackChannelId, 'C0123456789');
  assert.equal(example.slackMentionUserId, 'U0123456789');
});

test('#43/#61 文档：即时提醒与 6 小时去重、失败可见（slack-failed / slackFailing / ensure.sh）、读历史失败不阻塞、每日上限、doctor 检查', () => {
  assert.match(doc, /同一原因 6 小时内只立即发一次/);
  for (const kind of ['round-timeout', 'sandbox-down', 'prefetch-failed', 'adjudicate-needs-human', 'slack-failed', 'slack-history-failed']) {
    assert.ok(doc.includes(`\`${kind}\``), `文档缺 ${kind}`);
  }
  assert.match(doc, /slackFailing/);
  assert.match(doc, /直到下一次有消息发成功才清掉/);
  assert.match(doc, /ensure\.sh/);
  assert.match(doc, /slack-failed: since=/);
  assert.match(doc, /缺了不再卡住发送/);
  assert.match(doc, /bot 必须\*\*在目标频道里\*\*/);
  assert.match(doc, /slackDailyCap/);
  assert.match(doc, /默认 \*\*30\*\*/);
  assert.match(doc, /摘要算 1 条/);
  assert.match(doc, /已达上限/);
  assert.match(doc, /conversations\.info/);
  assert.match(doc, /\/checks/);
});
