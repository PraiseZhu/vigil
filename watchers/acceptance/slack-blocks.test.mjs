// #61 SC2 / SC3：Slack 消息体的纯函数测试（Ready、ready-stalled、单条提醒、摘要）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { alertBlocks, capBlocks, ciLink, digestBlocks, GATE_REASON_TEXT, NOTICE_COPY, prLink, readyBlocks, stalledBlocks } from './host/slack-blocks.mjs';
import { REPO } from './fake-gh.fixture.mjs';

const MENTION = 'U0123456789';

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

function textOf(payload) {
  return JSON.stringify(payload);
}

function buttons(payload) {
  const out = [];
  for (const block of payload.blocks || []) {
    for (const element of block.elements || []) {
      if (element.type === 'button') out.push(element);
    }
  }
  return out;
}

test('SC2 owner 档：标题、六个字段、只有一个「打开 PR」按钮，全文没有「合并」字样', () => {
  const payload = readyBlocks({ event: readyEvent() }, {});
  const json = textOf(payload);
  assert.match(payload.text, /^修正 PR 已 Ready：example-owner\/example-repo#12/);
  const header = payload.blocks[0];
  assert.equal(header.type, 'header');
  assert.equal(header.text.text, `修正 PR 已 Ready：${REPO}#12`);
  const fields = payload.blocks.find((block) => block.type === 'fields').fields;
  const byLabel = Object.fromEntries(fields.map((field) => field.text.split('\n')[0].replaceAll('*', '')).map((label, index) => [label, fields[index].text.split('\n')[1]]));
  assert.equal(byLabel['任务 issue'], `${REPO}#1`);
  assert.equal(byLabel['修正子 issue'], `${REPO}#2`);
  assert.equal(byLabel.head, 'abcdef1');
  assert.match(byLabel.CI, /CI 3\/3 绿/);
  assert.ok(byLabel.CI.includes(`https://github.com/${REPO}/pull/12/checks`), '有 checks.url 就带链接');
  assert.equal(byLabel['改动'], '3 个文件 +10 \u22122');
  assert.equal(byLabel['修了'], 'SC3、SC5');

  const list = buttons(payload);
  assert.equal(list.length, 1, 'owner 档只有一个按钮');
  assert.equal(list[0].text.text, '打开 PR');
  assert.equal(list[0].url, `https://github.com/${REPO}/pull/12`);
  assert.equal(json.includes('合并'), false, 'owner 档消息里不能出现「合并」字样');
});

test('SC2 watcher 档：正文写「已交给 Mac mini 盯梢」，没有按钮，PR 链接在正文里', () => {
  const payload = readyBlocks({ event: readyEvent({ handoff: 'watcher' }) }, {});
  assert.equal(buttons(payload).length, 0, 'watcher 档不带按钮');
  assert.equal(payload.blocks.some((block) => block.type === 'actions'), false);
  const body = textOf(payload);
  assert.match(body, /已交给 Mac mini 盯梢/);
  assert.ok(body.includes(`https://github.com/${REPO}/pull/12`), '正文里有 PR 链接文字');
});

test('SC2 伪造的 prUrl 被替换；repo/pr 对不上的链接一律不用', () => {
  const forged = readyBlocks({
    event: readyEvent({ prUrl: 'https://github.com/example-org/other-repo/pull/99' }),
  }, {});
  assert.equal(buttons(forged)[0].url, `https://github.com/${REPO}/pull/12`);
  assert.equal(textOf(forged).includes('other-repo'), false);

  const evil = readyBlocks({ event: readyEvent({ prUrl: 'https://evil.example.com/pull/1' }) }, {});
  assert.equal(buttons(evil)[0].url, `https://github.com/${REPO}/pull/12`);
  assert.equal(textOf(evil).includes('evil.example.com'), false);

  const shapeOnly = prLink({ repo: REPO, pr: 12, prUrl: `https://github.com/${REPO}/pull/12/files` });
  assert.equal(shapeOnly.link, `https://github.com/${REPO}/pull/12`, '形状不对也自己拼');
});

test('SC3 ready-stalled：标题、审查入口提示、PR 链接、readyAt、head 前 7 位', () => {
  const payload = stalledBlocks({
    event: readyEvent({ type: 'ready-stalled', handoff: 'watcher', readyAt: '2026-10-01T08:00:00.000Z', prUrl: '' }),
  }, {});
  assert.match(payload.text, /^修正 PR 转 Ready 24 小时没人接：example-owner\/example-repo#12/);
  const body = textOf(payload);
  assert.match(body, /多半是审查流程不在线，请看 Mac mini 和审查入口/);
  assert.equal(body.includes('review-ingress-missing'), false, '正文不再丢代码名');
  assert.match(body, /有没有影响：这个修正 PR 一直没人审，不会自动合并/);
  assert.match(body, /验收机已自动做了什么：PR 原样留着，没有再动/);
  assert.match(body, /要不要人处理：需要：看一眼 Mac mini 上的审查流程是否在线/);
  assert.ok(body.includes(`https://github.com/${REPO}/pull/12`), '附 PR 链接');
  assert.match(body, /2026-10-01T08:00:00\.000Z/);
  assert.match(body, /abcdef1/);
  assert.equal(payload.blocks.some((block) => block.type === 'actions'), false, '没有按钮');
});

test('SC4 secret-found 消息只取冒号后的文件名列表', () => {
  const payload = alertBlocks(
    {
      source: 'alerts',
      type: 'secret-found',
      event: { kind: 'secret-found', issue: `${REPO}#3`, reason: 'branch.push 扫到疑似密钥，没推：src/a.js, b.txt' },
    },
    {},
  );
  const body = textOf(payload);
  assert.match(body, /src\/a\.js, b\.txt/);
  assert.equal(body.includes('branch.push'), false, '冒号前的话一个字都不带出去');
  assert.equal(body.includes('扫到疑似密钥，没推'), false);
  assert.equal(body.includes('合并'), false);
});

test('SC4 出去的文字全部过 redact：Bearer 形状的密钥和本机路径不会出现在消息里', () => {
  const secretPart = 'abcdefghijklmnopqrstuvwxyz';
  const payload = alertBlocks(
    {
      source: 'alerts',
      type: 'gate-rejected',
      event: { kind: 'gate-rejected', issue: `${REPO}#4`, reason: `带 Bearer ${secretPart} 去请求` },
    },
    { stateDir: '/path/to/acceptance-state' },
  );
  const body = textOf(payload);
  assert.equal(body.includes(secretPart), false);
  assert.match(body, /已隐去/);
});

test('摘要：多条合成一条，永不 @（即使 profile 配了 slackMentionUserId）', () => {
  const payload = digestBlocks(
    [
      { type: 'loop-restarted', reason: '心跳过期' },
      { type: 'round-failed', issue: `${REPO}#5`, reason: '宿主出错' },
    ],
    { slackMentionUserId: MENTION },
  );
  const body = textOf(payload);
  assert.match(payload.text, /^验收机摘要（2 条，不紧急）/);
  assert.match(body, /验收机调度循环被重新拉起/);
  assert.match(body, /验收轮次出错，已自动中止/);
  assert.equal(body.includes('loop-restarted'), false, '摘要不出现 kind 代码名');
  assert.equal(body.includes('round-failed'), false, '摘要不出现 kind 代码名');
  assert.ok(body.includes(`${REPO}#5`));
  assert.equal(body.includes(`<@${MENTION}>`), false, '摘要永不 @');
});

test('secret-found 文件名里带半角冒号也整段保留；CI 链接只认 github.com 且不带 | < >', () => {
  const secret = textOf(
    alertBlocks(
      { source: 'alerts', type: 'secret-found', event: { kind: 'secret-found', reason: 'branch.push 扫到疑似密钥，没推：dir/a:b.txt, c.js' } },
      {},
    ),
  );
  assert.match(secret, /dir\/a:b\.txt, c\.js/);

  for (const url of ['https://evil.example/checks', `https://github.com/${REPO}/checks|打开 PR`, 'javascript:alert(1)']) {
    const body = textOf(readyBlocks(readyEvent({ checks: { green: 3, total: 3, url } }), {}));
    assert.equal(body.includes(url), false, url);
    assert.match(body, /CI 3\/3 绿/);
  }
});

// ---- #70 复审：通知栏文字（text）和 blocks / 摘要里，事件来的文字都不能变成 @ 或链接 ----

const HOSTILE = '<!channel> <!here> <!subteam^S0BAD> <@U0BADBAD1> <https://evil.example/|打开 PR> @channel @here @everyone';
const FILES = '<!channel>.txt, @here.js, <https://evil.example/|打开 PR>.md';

/** 每一处会被 Slack 当 mrkdwn 解析的字符串里都不能出现真的提醒 / 链接，裸 @channel 也要拆开。 */
function assertNoPing(payload, label) {
  const mrkdwn = [payload.text];
  const plain = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (value.type === 'mrkdwn' && typeof value.text === 'string') mrkdwn.push(value.text);
    if (value.type === 'plain_text' && typeof value.text === 'string') plain.push(value.text);
    Object.values(value).forEach(walk);
  };
  walk(payload.blocks);
  for (const text of mrkdwn) {
    assert.equal(/<[!@]/.test(text), false, `${label}：mrkdwn 里有 <! 或 <@：${text}`);
    assert.equal(text.includes('<https://evil'), false, `${label}：伪造链接：${text}`);
    assert.equal(/@(channel|here|everyone)/.test(text), false, `${label}：裸 @ 提醒：${text}`);
  }
  for (const text of plain) {
    assert.equal(/@(channel|here|everyone)/.test(text), false, `${label}：plain_text 里裸 @：${text}`);
    assert.equal(text.includes('evil'), false, `${label}：标题里有事件原文：${text}`);
  }
  // 通知栏文字只用校验过的字段拼：事件原文（原因 / 文件名 / 标题）一个字都不进，连转义后的也没有。
  for (const word of ['evil', 'channel', 'here.js', 'subteam', 'U0BADBAD1', 'everyone', '伪造标题']) {
    assert.equal(payload.text.includes(word), false, `${label}：通知栏文字带了事件原文「${word}」：${payload.text}`);
  }
}

test('#70 复审：secret-found 的文件名（模型能起成 <!channel>）只进转义过的 blocks，不进通知栏文字', () => {
  const payload = alertBlocks({ source: 'alerts', kind: 'secret-found', issue: `${REPO}#2`, reason: `branch.push 扫到疑似密钥，没推：${FILES}` });
  assertNoPing(payload, 'secret-found');
  assert.match(payload.text, /^推送前扫到疑似密钥，已拦下没推：example-owner\/example-repo#2｜3 个文件，文件名见消息｜需要你处理$/);
  assert.match(textOf(payload.blocks), /&lt;!channel&gt;\.txt/, '文件名在 blocks 里还能看到（转义后）');
});

test('#70 复审：提醒的原因 / 细节 / 伪造 issue 名 / 伪造类型都不进通知栏文字，blocks 里转义', () => {
  const cases = {
    reason: { kind: 'gate-rejected', issue: `${REPO}#2`, reason: HOSTILE },
    detail: { type: 'needs-human', source: 'prbot', issue: `${REPO}#2`, reason: 'no-change', detail: HOSTILE },
    issueTitle: { type: 'needs-human', source: 'prbot', issue: `${HOSTILE} 伪造标题`, root: `${HOSTILE} 伪造标题`, reason: HOSTILE },
    badType: { type: '<!channel>', source: 'prbot', issue: `${REPO}#2`, reason: HOSTILE },
    windowKinds: { kind: 'interrupted-repeat', issue: `${REPO}#2`, windowCount: 2, windowKinds: [HOSTILE], reason: HOSTILE },
    forgedPr: { kind: 'round-failed', repo: 'evil>|x/y', pr: 3, prUrl: 'https://evil.example/pull/3', issue: HOSTILE, reason: HOSTILE },
  };
  for (const [label, event] of Object.entries(cases)) {
    const payload = alertBlocks(event);
    assertNoPing(payload, label);
  }
  assert.match(textOf(alertBlocks(cases.issueTitle).blocks), /&lt;!channel&gt; .*伪造标题/, '伪造的 issue 名在 blocks 里转义后给出');
  assert.match(alertBlocks(cases.badType).text, /^验收机报了一条还没归类的提醒/, '不合规的类型当没有');
});

test('#70 复审：Ready / ready-stalled 缺 repo 或 PR 号时，标题退回合规的 ref，不用事件原文', () => {
  const variants = {
    noRepo: { repo: undefined, prUrl: undefined, issue: `${HOSTILE} 伪造标题`, root: `${HOSTILE} 伪造标题` },
    noPr: { pr: undefined, prUrl: undefined, issue: `${HOSTILE} 伪造标题`, root: `${HOSTILE} 伪造标题` },
    neither: { repo: undefined, pr: undefined, prUrl: undefined, issue: HOSTILE, root: HOSTILE, readyAt: HOSTILE },
  };
  for (const [label, overrides] of Object.entries(variants)) {
    for (const handoff of ['owner', 'watcher']) {
      const ready = readyBlocks(readyEvent({ ...overrides, handoff }));
      assertNoPing(ready, `ready ${label} ${handoff}`);
      assert.match(ready.text, /^修正 PR 已 Ready：修正 PR｜/, `ready ${label}`);
    }
    const stalled = stalledBlocks(readyEvent({ type: 'ready-stalled', readyAt: HOSTILE, ...overrides }));
    assertNoPing(stalled, `stalled ${label}`);
    assert.match(stalled.text, /^修正 PR 转 Ready 24 小时没人接：修正 PR｜/, `stalled ${label}`);
  }
  // 缺 PR 号但 issue 是合规的 ref：标题用它。
  const fallback = readyBlocks(readyEvent({ pr: undefined, prUrl: undefined }));
  assert.match(fallback.text, /^修正 PR 已 Ready：example-owner\/example-repo#2｜/);
});

test('#70 复审：摘要的 blocks 转义、通知栏文字只有类型和合规的 ref', () => {
  const payload = digestBlocks([
    { source: 'alerts', kind: 'gate-rejected', issue: `${REPO}#2`, reason: HOSTILE },
    { source: 'prbot', type: '<!here>', issue: `${HOSTILE} 伪造标题`, reason: HOSTILE },
    { source: 'alerts', kind: 'secret-found', issue: `${REPO}#3`, reason: `没推：${FILES}` },
  ]);
  assertNoPing(payload, 'digest');
  assert.match(payload.text, /^验收机摘要（3 条，不紧急）：写闸拦下了一个不合规的写操作 example-owner\/example-repo#2；验收机报了一条还没归类的提醒；推送前扫到疑似密钥，已拦下没推 example-owner\/example-repo#3$/);
  assert.equal(payload.text.includes('gate-rejected'), false);
  assert.equal(payload.text.includes('secret-found'), false);
});

test('#70 复审：打开 PR 的链接要 repo 和 PR 号都对得上，任一不对就自己拼', () => {
  const own = `https://github.com/${REPO}/pull/12`;
  assert.equal(prLink(readyEvent()).link, own, '都对得上用事件里的');
  // 只有仓库不对（PR 号一样）。
  const otherRepo = prLink(readyEvent({ prUrl: 'https://github.com/other-owner/other-repo/pull/12' }));
  assert.equal(otherRepo.link, own, '仓库不对 → 自己拼');
  // 只有 PR 号不对（仓库一样）。
  const otherPr = prLink(readyEvent({ prUrl: `https://github.com/${REPO}/pull/99` }));
  assert.equal(otherPr.link, own, 'PR 号不对 → 自己拼');
  const button = buttons(readyBlocks(readyEvent({ prUrl: `https://github.com/${REPO}/pull/99` })))[0];
  assert.equal(button.url, own);
});

test('#61 CI 链接：checks.url 只是 PR 页（prbot 给的）时改成 /checks；没给就按 PR 链接拼 /checks；真 checks 地址原样', () => {
  const ciOf = (event) => {
    const payload = readyBlocks({ event }, {});
    const fields = payload.blocks.find((block) => block.type === 'fields').fields;
    return fields.find((field) => field.text.startsWith('*CI*')).text;
  };
  const prPage = `https://github.com/${REPO}/pull/12`;
  assert.ok(ciOf(readyEvent({ checks: { green: 2, total: 3, url: prPage } })).includes(`<${prPage}/checks|CI 2/3 绿>`));
  assert.ok(ciOf(readyEvent({ checks: { green: 3, total: 3 } })).includes(`<${prPage}/checks|CI 3/3 绿>`));
  const run = `https://github.com/${REPO}/actions/runs/1`;
  assert.ok(ciOf(readyEvent({ checks: { green: 3, total: 3, url: run } })).includes(`<${run}|CI 3/3 绿>`));
  assert.equal(ciLink('https://example.invalid/x', { link: '' }), '', '不是 github.com 的不放链接');
  assert.equal(ciLink(undefined, { link: prPage }), `${prPage}/checks`);
});

test('#61 每日上限通知：不 @、只有固定文字和条数', () => {
  const payload = capBlocks(30, {});
  assert.match(payload.text, /已达上限（30 条）/);
  assert.equal(payload.text.includes('<@'), false);
  assert.match(JSON.stringify(payload.blocks), /明天的第一条摘要/);
});

function assertFourHeadings(payload, label) {
  const body = textOf(payload.blocks);
  for (const heading of ['发生了什么', '有没有影响', '验收机已自动做了什么', '要不要人处理']) {
    assert.ok(body.includes(heading), `${label} 缺小标题「${heading}」`);
  }
}

test('NOTICE_COPY 每个 kind 渲染成人话：text 不含代码名、含中文 title，blocks 含四个小标题', () => {
  for (const [kind, copy] of Object.entries(NOTICE_COPY)) {
    if (kind === 'expected-gate-rejected') continue;
    const event = {
      source: 'alerts',
      kind,
      type: kind,
      issue: `${REPO}#7`,
      reason: kind === 'loop-restarted' ? 'heartbeat-stale' : 'not-in-tree',
      windowCount: 3,
      windowKinds: kind === 'interrupted-repeat' ? ['round-failed', 'round-stalled'] : kind === 'tick-failed-repeat' ? ['tick-failed'] : undefined,
    };
    const payload = alertBlocks(event);
    assert.ok(payload.text.includes(copy.title) || /心跳过期|调度循环挂了/.test(payload.text), `${kind} text 要含人话 title`);
    assert.equal(payload.text.includes(kind), false, `${kind} 的 text 不能含代码名：${payload.text}`);
    assertFourHeadings(payload, kind);
    if (copy.auto) assert.ok(textOf(payload.blocks).includes(copy.auto), `${kind} blocks 要含 auto 文案`);
  }
  const unknown = alertBlocks({ kind: 'never-seen-kind', type: 'never-seen-kind' });
  assertFourHeadings(unknown, 'unknown');
  assert.match(unknown.text, /验收机报了一条还没归类的提醒/);
  assert.match(textOf(unknown.blocks), /代码名：never-seen-kind/);
  assert.equal(GATE_REASON_TEXT['needs-round-binding'], '这个写操作只允许在验收轮里做，当时不在轮次里');
});

test('gate-rejected 细节行用人话原因；interrupted-repeat / tick-failed-repeat 的 what 列人话 title', () => {
  const gate = alertBlocks({
    kind: 'gate-rejected',
    issue: `${REPO}#2`,
    reason: 'needs-round-binding',
    detail: 'comment.create',
  });
  const gateBody = textOf(gate.blocks);
  assert.match(gateBody, /拦下原因：这个写操作只允许在验收轮里做，当时不在轮次里（代码：needs-round-binding）/);
  assert.match(gateBody, /动作：comment\.create/);
  assert.match(gate.text, /已自动处理，暂不用管/);

  const repeat = alertBlocks({
    kind: 'interrupted-repeat',
    issue: `${REPO}#2`,
    windowCount: 2,
    windowKinds: ['round-failed', 'round-stalled'],
  });
  const repeatBody = textOf(repeat.blocks);
  assert.match(repeatBody, /这个任务 6 小时内中断了 2 次/);
  assert.match(repeatBody, /验收轮次出错，已自动中止/);
  assert.match(repeatBody, /轮次卡住没进度，已自动中止/);
  assert.equal(repeatBody.includes('round-failed'), false);
  assert.match(repeat.text, /需要你处理/);

  const ticks = alertBlocks({
    kind: 'tick-failed-repeat',
    windowCount: 3,
    windowKinds: ['tick-failed'],
  });
  const ticksBody = textOf(ticks.blocks);
  assert.match(ticksBody, /验收调度在 10 分钟内连续出错 3 次/);
  assert.equal(ticksBody.includes('tick-failed'), false);
});
