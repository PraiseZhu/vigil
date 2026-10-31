// 「关联 PR」纯函数的夹具。
//
// 来源（2026-10-31，只读公开仓 vigil 的 PR 标题、headRefName、正文里的关联行）：
// 仓库里没有看板那 16 条「Linked pull requests」的导出，这里不用那份数据。
// 下面 16 条是公开 PR 关联行的形状：owner 一律写成 ExampleUser（本仓测试夹具不写真实用户名），
// 正文只留关联行。全文样本在文件末尾的 vigilCorpus（取样时最近 15 个已合并 PR）。
// 完整 issue 链接、Refs 行、同号不同仓，是按关联规则补的代表性样例，source 标成「构造」，不是真实 PR。

const VIGIL = 'ExampleUser/vigil';
const OTHER = 'ExampleOrg/other-repo';

function vigilPr({ number, title, body, headRefName, state = 'merged', ci = 'pass' }) {
  return { repo: VIGIL, number, title, body, headRefName, state, ci };
}

function taskLines(issue) {
  return `任务 issue：${VIGIL}#${issue}\nCloses ${VIGIL}#${issue}\n`;
}

/** 16 条关联。issue 是被关联的 issue 号，pr 是公开 PR 的形状。 */
export const knownLinks = [
  {
    id: 'vigil-pr-151',
    source: '公开仓 vigil PR 151（已合并）的标题、分支和正文前两行。不是看板导出。',
    issue: 149,
    pr: vigilPr({
      number: 151,
      title: 'fix(acceptance): 卡住判定加沙箱活动信号，长时间跑测试不再误判卡住（#149）',
      body: taskLines(149),
      headRefName: 'fix/stall-sandbox-activity',
    }),
  },
  {
    id: 'vigil-pr-148',
    source: '公开仓 vigil PR 148（已合并）的标题、分支和正文前两行。不是看板导出。',
    issue: 147,
    pr: vigilPr({
      number: 148,
      title: 'fix(acceptance): 内存门「这一拍不认领」那行带 UTC 时间和 mem-gate-defer 标记，便于统计推迟次数（#147）',
      body: taskLines(147),
      headRefName: 'fix/mem-gate-timestamp',
    }),
  },
  {
    id: 'vigil-pr-145',
    source: '公开仓 vigil PR 145（已合并）的标题、分支和正文前两行。不是看板导出。',
    issue: 144,
    pr: vigilPr({
      number: 145,
      title: 'fix(acceptance): 读 GitHub 挂住时整组杀掉不留孤儿、只读重试一次，重试成功不告警（#144）',
      body: taskLines(144),
      headRefName: 'fix/read-retry-group-kill',
    }),
  },
  {
    id: 'vigil-pr-143',
    source: '公开仓 vigil PR 143（已合并）的标题、分支和正文前两行。不是看板导出。',
    issue: 142,
    pr: vigilPr({
      number: 143,
      title: 'fix(acceptance): 修正轮读 GitHub 加 120 秒超时，心跳覆盖整拍并记当前阶段，体检按真实阶段报（#142）',
      body: taskLines(142),
      headRefName: 'fix/tick-phase-beat',
    }),
  },
  {
    id: 'vigil-pr-141',
    source: '公开仓 vigil PR 141（已合并）。标题里没有 issue 号，关联在正文前两行。不是看板导出。',
    issue: 140,
    pr: vigilPr({
      number: 141,
      title: '[子4/4] 验收机读批准执行的交接，等交接后再开轮',
      body: taskLines(140),
      headRefName: 'feat/lead-handoff',
    }),
  },
  {
    id: 'vigil-pr-139',
    source: '公开仓 vigil PR 139（已合并）的标题、分支和正文前两行。不是看板导出。',
    issue: 138,
    pr: vigilPr({
      number: 139,
      title: 'fix(acceptance): 拉取期间心跳照常刷新，另记「正在拉取、已多久」，超过 180 秒体检照样报红（#138）',
      body: taskLines(138),
      headRefName: 'fix/poll-heartbeat',
    }),
  },
  {
    id: 'vigil-pr-137',
    source: '公开仓 vigil PR 137（已合并）的标题、分支和正文前两行。不是看板导出。',
    issue: 136,
    pr: vigilPr({
      number: 137,
      title: 'fix(acceptance): 认领后写看板「验收中」外发失败时先查看板、没写成才经写闸重试一次（#136）',
      body: taskLines(136),
      headRefName: 'fix/board-claim-retry',
    }),
  },
  {
    id: 'vigil-pr-135',
    source: '公开仓 vigil PR 135（已合并）。标题里没有 issue 号，关联在正文前两行。不是看板导出。',
    issue: 134,
    pr: vigilPr({
      number: 135,
      title:
        'fix(acceptance): build 项 CI 口径——完整 build 在沙箱里跑不了的仓改看「代码打包步骤沙箱通过 + 关联 PR 自己 CI 的 build 和测试绿」（host.json buildCiPolicy，按仓开、默认关）',
      body: taskLines(134),
      headRefName: 'fix/cindy-build-ci-policy',
    }),
  },
  {
    id: 'vigil-pr-133',
    source: '公开仓 vigil PR 133（已合并）。标题里没有 issue 号，关联在正文前两行。不是看板导出。',
    issue: 132,
    pr: vigilPr({
      number: 133,
      title: 'fix(acceptance): 重仓同一时刻只跑一轮——host.json serialRepos 复用 mivo 同仓锁',
      body: taskLines(132),
      headRefName: 'fix/cindy-serial-lock',
    }),
  },
  {
    id: 'vigil-pr-131',
    source: '公开仓 vigil PR 131（已合并）。标题里没有 issue 号，关联在正文前两行。不是看板导出。',
    issue: 130,
    pr: vigilPr({
      number: 131,
      title: 'fix(acceptance): 宿主预装依赖支持 pnpm-lock.yaml（pnpm install --frozen-lockfile --ignore-scripts）',
      body: taskLines(130),
      headRefName: 'fix/predeps-pnpm',
    }),
  },
  {
    id: 'vigil-pr-129',
    source: '公开仓 vigil PR 129（已合并）。分支名里的长数字是运行编号，不是 issue。关联在正文前两行。不是看板导出。',
    issue: 128,
    pr: vigilPr({
      number: 129,
      title: 'fix(watchers): 工作树残留备份后重置、PR 已结束不派活且可收口、已修掉的意见免裁决',
      body: taskLines(128),
      headRefName: 'keel/keel-run-20261028132721-577d',
    }),
  },
  {
    id: 'vigil-pr-126',
    source: '公开仓 vigil PR 126（已合并）。标题里没有 issue 号，关联在正文前两行。不是看板导出。',
    issue: 125,
    pr: vigilPr({
      number: 126,
      title: 'fix(acceptance): 写闸 serve 启动等待从 20 秒放宽到 60 秒；起不来时写清是等待超时还是子进程已退出',
      body: taskLines(125),
      headRefName: 'fix/gate-start-timeout',
    }),
  },
  {
    id: 'vigil-pr-112-task',
    source: '公开仓 vigil PR 112（已合并）。分支 acceptance/93-93-sc5，标题和正文第一行指向 93。sc 后的 5 不是 issue。不是看板导出。',
    issue: 93,
    pr: vigilPr({
      number: 112,
      title: `修正：${VIGIL}#93 SC5`,
      body: `任务 issue：${VIGIL}#93\nCloses #111\n`,
      headRefName: 'acceptance/93-93-sc5',
    }),
  },
  {
    id: 'vigil-pr-112-closes',
    source: '公开仓 vigil PR 112 的正文第二行是 Closes #111（同仓裸 #n）。不是看板导出。',
    issue: 111,
    pr: vigilPr({
      number: 112,
      title: `修正：${VIGIL}#93 SC5`,
      body: `任务 issue：${VIGIL}#93\nCloses #111\n`,
      headRefName: 'acceptance/93-93-sc5',
    }),
  },
  {
    id: 'vigil-pr-127-task',
    source: '公开仓 vigil PR 127（已关闭、未合并）。分支 acceptance/119-119-sc3，标题和正文第一行指向 119。不是看板导出。',
    issue: 119,
    pr: vigilPr({
      number: 127,
      title: `修正：${VIGIL}#119 SC3`,
      body: `任务 issue：${VIGIL}#119\nCloses #124\n`,
      headRefName: 'acceptance/119-119-sc3',
      state: 'closed',
      ci: 'fail',
    }),
  },
  {
    id: 'vigil-pr-127-closes',
    source: '公开仓 vigil PR 127 的正文第二行是 Closes #124（同仓裸 #n）。不是看板导出。',
    issue: 124,
    pr: vigilPr({
      number: 127,
      title: `修正：${VIGIL}#119 SC3`,
      body: `任务 issue：${VIGIL}#119\nCloses #124\n`,
      headRefName: 'acceptance/119-119-sc3',
      state: 'closed',
      ci: 'fail',
    }),
  },
];

const HITS = {
  [`${VIGIL}#149`]: '#151(merged)',
  [`${VIGIL}#147`]: '#148(merged)',
  [`${VIGIL}#144`]: '#145(merged)',
  [`${VIGIL}#142`]: '#143(merged)',
  [`${VIGIL}#140`]: '#141(merged)',
  [`${VIGIL}#138`]: '#139(merged)',
  [`${VIGIL}#136`]: '#137(merged)',
  [`${VIGIL}#134`]: '#135(merged)',
  [`${VIGIL}#132`]: '#133(merged)',
  [`${VIGIL}#130`]: '#131(merged)',
  [`${VIGIL}#128`]: '#129(merged)',
  [`${VIGIL}#125`]: '#126(merged)',
  [`${VIGIL}#93`]: '#112(merged)',
  [`${VIGIL}#111`]: '#112(merged)',
  [`${VIGIL}#119`]: '#127(closed)',
  [`${VIGIL}#124`]: '#127(closed)',
};

const positiveNumbers = [...new Set(knownLinks.map((link) => link.issue))];
// 3、5 是 acceptance/<总>-<项>-sc<k> 里的 sc，不是 issue。577 和长数字来自分支 keel-run-20261028132721-577d。
const nonIssueNumbers = [3, 5, 577, 20261028132721];

export const knownIssues = [
  ...positiveNumbers.map((number) => ({ repo: VIGIL, number })),
  ...nonIssueNumbers.map((number) => ({ repo: VIGIL, number })),
  ...positiveNumbers.map((number) => ({ repo: OTHER, number })),
  ...nonIssueNumbers.map((number) => ({ repo: OTHER, number })),
];

const seenPr = new Set();
export const knownPrs = [];
for (const link of knownLinks) {
  const key = `${link.pr.repo}#${link.pr.number}`;
  if (seenPr.has(key)) continue;
  seenPr.add(key);
  knownPrs.push(link.pr);
}

export const knownExpect = {};
for (const issue of knownIssues) {
  const ref = `${issue.repo}#${issue.number}`;
  knownExpect[ref] = HITS[ref] ?? '';
}

/**
 * 单条信号。refs 是 prIssueRefs 应返回的 issue（按 repo、再按号排序）。
 * 公开 PR 能分开的信号用公开形状；公开摘录里没有的信号标「构造」。
 */
export const patternCases = [
  {
    id: 'title-hash',
    source: '公开仓 vigil PR 151 的标题。正文和分支清空，只留标题里的 #149。标题裸 #n 不算。',
    pr: vigilPr({
      number: 151,
      title: 'fix(acceptance): 卡住判定加沙箱活动信号，长时间跑测试不再误判卡住（#149）',
      body: '',
      headRefName: 'fix/stall-sandbox-activity',
    }),
    refs: [],
  },
  {
    id: 'body-hash',
    source: '公开仓 vigil PR 112 正文第二行是 Closes #111。标题和分支改成不含 issue 号，只留这一行。',
    pr: vigilPr({
      number: 112,
      title: '修正',
      body: 'Closes #111\n',
      headRefName: 'fix/no-issue-number',
    }),
    refs: [`${VIGIL}#111`],
  },
  {
    id: 'full-url',
    source: '构造。正文里顺手贴的 issue 链接不算。不是真实 PR。',
    pr: {
      repo: OTHER,
      number: 301,
      title: 'link',
      body: `详见 https://github.com/${VIGIL}/issues/89 。\n`,
      headRefName: 'feature/docs',
      state: 'open',
      ci: 'pass',
    },
    refs: [],
  },
  {
    id: 'branch-acceptance',
    source: '公开仓 vigil PR 112 的分支 acceptance/93-93-sc5（与 correctionBranch 的 acceptance/<总>-<项>-sc<k> 相同）。标题和正文清空。5 不是 issue。',
    pr: vigilPr({
      number: 112,
      title: '',
      body: '',
      headRefName: 'acceptance/93-93-sc5',
    }),
    refs: [`${VIGIL}#93`],
  },
  {
    id: 'branch-issue-segment',
    source: '构造。acceptance/ 以外，分支段 issue-<号> 也算 issue 号。抽查的功能分支大多不带 issue 号。不是真实 PR。',
    pr: vigilPr({
      number: 40,
      title: '',
      body: '',
      headRefName: 'feature/issue-40',
      state: 'open',
      ci: 'pending',
    }),
    refs: [`${VIGIL}#40`],
  },
  {
    id: 'refs-line',
    source: '构造。方案第 3 节写的 Refs owner/repo#n。抽查的公开 PR 正文没有这一行（现有修正 PR 写的是「任务 issue：」和 Closes）。不是真实 PR。',
    pr: {
      repo: OTHER,
      number: 302,
      title: '修正',
      body: `Refs ${VIGIL}#116\n`,
      headRefName: 'feature/refs',
      state: 'open',
      ci: 'fail',
    },
    refs: [`${VIGIL}#116`],
  },
  {
    id: 'multi-signal-once',
    source: '公开仓 vigil PR 112 的标题、正文前两行和分支叠在一起：93 只算一次，另加同仓 #111，不算 sc 的 5。',
    pr: vigilPr({
      number: 112,
      title: `修正：${VIGIL}#93 SC5`,
      body: `任务 issue：${VIGIL}#93\nCloses #111\n`,
      headRefName: 'acceptance/93-93-sc5',
    }),
    refs: [`${VIGIL}#93`, `${VIGIL}#111`],
  },
  {
    id: 'keel-branch-not-an-issue',
    source: '公开仓 vigil PR 129 的分支名。长数字和 577 都不是 issue。',
    pr: vigilPr({
      number: 129,
      title: 'no hash',
      body: 'no hash\n',
      headRefName: 'keel/keel-run-20261028132721-577d',
    }),
    refs: [],
  },
  {
    id: 'pull-url-not-issue',
    source: '构造。pull 链接不是 issue 链接。',
    pr: vigilPr({
      number: 1,
      title: 'x',
      body: `https://github.com/${VIGIL}/pull/151\n`,
      headRefName: 'feature/x',
      state: 'open',
      ci: 'pass',
    }),
    refs: [],
  },
  {
    id: 'heading-hash-not-issue',
    source: '构造。Markdown 标题的 # 后面不是 issue 号。',
    pr: vigilPr({
      number: 1,
      title: 'section',
      body: '## 改了什么\n',
      headRefName: 'feature/x',
      state: 'open',
    }),
    refs: [],
  },
  {
    id: 'single-segment-not-a-repo',
    source: '构造。vigil#43 没有 owner，不能当成跨仓引用，也不算 PR 所在仓的裸 #43。',
    pr: {
      repo: OTHER,
      number: 2,
      title: 'vigil#43',
      body: '',
      headRefName: 'feature/x',
      state: 'open',
      ci: 'pass',
    },
    refs: [],
  },
];

/** 同号不同仓：acceptance/ 分支只落在 PR 自己的仓；Refs 行上的引用落在写明的仓。标题裸 #n 和顺手贴的链接不算。 */
export const crossRepo = {
  source: '构造的同号不同仓样例。acceptance/ 分支只算 PR 自己的仓；Refs 行上的 owner/repo#n 和 issue 链接算写明的那个仓。标题裸 #n、正文里顺手贴的链接不算。不是看板导出。',
  issues: [
    { repo: VIGIL, number: 10 },
    { repo: OTHER, number: 10 },
    { repo: VIGIL, number: 1 },
    { repo: OTHER, number: 1 },
  ],
  prs: [
    {
      repo: OTHER,
      number: 7,
      title: 'fix (#10)',
      body: '',
      headRefName: 'acceptance/10-10-sc1',
      state: 'open',
      ci: 'pass',
    },
    {
      repo: VIGIL,
      number: 8,
      title: 'note',
      body: `Refs ${OTHER}#10\n`,
      headRefName: 'feature/nope',
      state: 'open',
      ci: 'fail',
    },
    {
      repo: VIGIL,
      number: 9,
      title: '#10 in title only',
      body: `see https://github.com/${VIGIL}/pull/8\nhttps://github.com/${OTHER}/issues/10\nRefs https://github.com/${OTHER}/issues/10\n`,
      headRefName: 'feature/y',
      state: 'merged',
      ci: 'pass',
    },
  ],
  expect: {
    [`${VIGIL}#10`]: '',
    // 7：分支 acceptance/10-10-sc1（标题裸 #10 不算，sc 的 1 不是 issue）。8：Refs owner/repo#n。9：Refs 行上的 issue 链接。顺手贴的链接和标题裸 #10 不算。
    [`${OTHER}#10`]: '#7(open,CI✓) #8(open,CI✗) #9(merged)',
    [`${VIGIL}#1`]: '',
    [`${OTHER}#1`]: '',
  },
};

/** 大小写不同的 owner/repo 仍配到调用方给出的 issue 写法。 */
export const caseFold = {
  source: '构造。Refs 里的 owner 小写，应对上 issue 列表里的原写法。',
  issues: [{ repo: VIGIL, number: 149 }],
  prs: [
    {
      repo: OTHER,
      number: 4,
      title: '',
      body: 'Refs exampleuser/vigil#149\n',
      headRefName: 'feature/x',
      state: 'open',
      ci: 'pass',
    },
  ],
  expect: { [`${VIGIL}#149`]: '#4(open,CI✓)' },
};

/**
 * 文本格式。123 / 130 来自方案第 3 节的示例句子，不是这两号 PR 的真实状态。
 * 输入故意把 130 放在 123 前面，输出仍按 PR 号升序。
 */
export const formatCases = [
  {
    id: 'spec-example',
    source: '方案第 3 节的示例文案。不是 PR 123 / 130 的真实状态。',
    issues: [{ repo: VIGIL, number: 1 }],
    prs: [
      {
        repo: VIGIL,
        number: 130,
        title: 'format',
        body: `任务 issue：${VIGIL}#1\n`,
        headRefName: 'feature/y',
        state: 'merged',
        ci: 'pass',
      },
      {
        repo: VIGIL,
        number: 123,
        title: 'format',
        body: `任务 issue：${VIGIL}#1\n`,
        headRefName: 'feature/x',
        state: 'open',
        ci: 'pass',
      },
    ],
    expect: { [`${VIGIL}#1`]: '#123(open,CI✓) #130(merged)' },
  },
  {
    id: 'ci-red',
    source: '构造。开着的 PR，CI 红写成 CI✗。',
    issues: [{ repo: VIGIL, number: 1 }],
    prs: [
      {
        repo: VIGIL,
        number: 123,
        title: 'format',
        body: `任务 issue：${VIGIL}#1\n`,
        headRefName: 'feature/x',
        state: 'open',
        ci: 'fail',
      },
    ],
    expect: { [`${VIGIL}#1`]: '#123(open,CI✗)' },
  },
  {
    id: 'ci-failure-synonym',
    source: '构造。CI 结论用 FAILURE / SUCCESS 这两个词时同样翻成 CI✗ / CI✓。',
    issues: [{ repo: VIGIL, number: 1 }],
    prs: [
      {
        repo: VIGIL,
        number: 50,
        title: 'format',
        body: `任务 issue：${VIGIL}#1\n`,
        headRefName: 'feature/x',
        state: 'OPEN',
        ci: 'FAILURE',
      },
    ],
    expect: { [`${VIGIL}#1`]: '#50(open,CI✗)' },
  },
  {
    id: 'open-without-ci',
    source: '构造。还没有 CI 结论时不补一个勾或叉。',
    issues: [{ repo: VIGIL, number: 1 }],
    prs: [
      {
        repo: VIGIL,
        number: 50,
        title: 'format',
        body: `任务 issue：${VIGIL}#1\n`,
        headRefName: 'feature/x',
        state: 'open',
        ci: 'pending',
      },
    ],
    expect: { [`${VIGIL}#1`]: '#50(open)' },
  },
  {
    id: 'empty',
    source: '构造。没有命中的 issue 写空串。',
    issues: [{ repo: VIGIL, number: 1 }],
    prs: [
      {
        repo: OTHER,
        number: 3,
        title: 'unrelated',
        body: '',
        headRefName: 'feature/x',
        state: 'open',
        ci: 'pass',
      },
    ],
    expect: { [`${VIGIL}#1`]: '' },
  },
];


// vigil 最近 15 个已合并 PR 的正文全文。
// 取样：2026-10-31，按 merged_at 从新到旧，PR 号依次为
// 161、167、159、176、162、160、174、166、164、150、151、148、146、145、141。
// 用户名写成 ExampleUser。PR 161 正文里举例的前缀字面量、PR 141 的 denylist 本地文件名已改写，
// 避免夹具命中前缀和本机域名检查。公开的 github.com、cursor.com 链接保留，
// 用来覆盖「顺手提到的 issue 链接不算」。
// 人工标注只认：正文「任务 issue：」行里的 owner/repo#n 或 issue 链接（该行已有这种写法时，
// 同行括号里的裸 #n 不算）、行首或冒号后的 Closes / Fixes / Refs，以及分支名里的 issue 号。
// mivo 仓：本环境的 GitHub 安装身份只能读本仓，读 mivo 仓返回 404。没有写入编造正文。
export const vigilCorpus = [
  {
    "id": "vigil-pr-161",
    "source": "公开仓 vigil PR 161，2026-10-31T22:19:33Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #156。标题里的 #156 不算。",
    "expect": [
      "ExampleUser/vigil#156"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 161,
      "title": "feat(acceptance): Worker 接 GitHub webhook，本机每 2 秒拉取，60 秒轮询兜底（#156）",
      "body": "<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n任务 issue：ExampleUser/vigil#156\nCloses ExampleUser/vigil#156\n\n## 改了什么\n\nPR / issue 的 GitHub 事件要能秒级到本机。这版只加代码，不部署。\n\n- `watchers/acceptance/bin/event-worker.mjs`：Worker 的 `fetch`。`POST /webhook` 用 `env.WEBHOOK_SECRET` 校验 `X-Hub-Signature-256`（对原始 body 做 HMAC-SHA256）。签名不对返回 401，不入队。签名对了按 `X-GitHub-Delivery` 去重后入队。`GET /pull` 要带 `Authorization: Bearer`，和 `env.PULL_TOKEN` 对上才把队列交出去。不读 GitHub 令牌，不出站。\n- `watchers/acceptance/bin/event-pull.mjs`：本机拉取循环。默认每 2 秒拉一次。拉取抛错就当成 Worker 挂了，循环不退出，改走 60 秒轮询，把漏掉的事件补回来；下一拍轮询时再试一次拉取，通了就回到 2 秒。同一个 delivery id 只处理一次。处理完往 `.prio/latency.jsonl` 追加一行（`created_at` 到处理完成的毫秒数），`latencyPercentiles` 用最近秩算 p50 / p95。\n- `watchers/acceptance/event-channel.test.mjs`：上面这些的单测。`.gitignore` 加上 `.prio/`，延迟记录不入库。\n\n轮询函数由调用方注入，原来的 60 秒轮询没有被换掉，也还没接到宿主循环上。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/bin/event-worker.mjs`、`watchers/acceptance/bin/event-pull.mjs`、`watchers/acceptance/event-channel.test.mjs`、`.gitignore`。\n- 超出 issue 范围：无\n- 明确不包含：不部署 Worker，不在任何仓库注册 webhook，不写看板字段，不读写 GitHub 令牌，不改写闸，不碰 panoptes。\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 Worker 对签名错误的请求返回 401 且不入队；签名正确的请求入队。验证：unit（测试点：Worker 处理函数） | 通过 | `node --env-file=watchers/acceptance/test.env --test watchers/acceptance/event-channel.test.mjs` → 空实现时 7 条全红（签名用例期望 401，实际 500）→ 实现后「SC1 签名不对返回 401…」通过：篡改 body、缺签名头都是 401 且拉出来是空队列；签名正确入队，`created_at` 取 `issue.updated_at`；拉取令牌不对返回 401，队列还在 → https://github.com/ExampleUser/vigil/actions/runs/41242470677 |\n| SC2 重复事件（同一 delivery id）只处理一次。验证：unit | 通过 | 同上，先红后绿。「SC2」：同一个 delivery id 投两次，拉取只有 1 条；拉取和轮询各交来一次 `dup`，`onEvent` 只被调用 1 次 → https://github.com/ExampleUser/vigil/actions/runs/41242470677 |\n| SC3 拉取端每 2 秒拉一次，Worker 不可用时不崩，并退回 60 秒轮询。验证：unit（测试点：拉取循环，假时钟） | 通过 | 同上。「SC3」三条：假时钟跑到 120 秒，拉取时刻是 0、2000、4000…118000（60 次），轮询是 0 和 60000，实耗不到 2 秒；从 4 秒起拉取抛错，不再出现 6000 这次拉取，60000 的轮询把 `missed` 补回来，Worker 恢复后 62000 又按 2 秒拉；`pullFromWorker` 在连接失败和 503 时抛错 → https://github.com/ExampleUser/vigil/actions/runs/41242470677 |\n| SC4 每个处理的事件记录一条延迟到 `.prio/latency.jsonl`，并能算出 p50 和 p95。验证：unit | 通过 | 同上。「SC4」：两条事件写出两行，`latencyMs` 为 10000 和 6000，文件权限 600；最近秩 p50=6000、p95=10000；1 到 20 秒这 20 条的 p50=10000、p95=19000；空数组 p50/p95 为 null → https://github.com/ExampleUser/vigil/actions/runs/41242470677 |\n| SC5 Worker 代码和仓库里没有 GitHub 令牌，只有 webhook secret 的读取方式。验证：static | 通过 | 同上。「SC5」扫 `event-worker.mjs` / `event-pull.mjs`：有 `WEBHOOK_SECRET` 和 `PULL_TOKEN`，没有 `GITHUB_TOKEN`、`GH_TOKEN`、`token-prefix` 这类令牌头；Worker 文件不引用 `node:fs` / `child_process`。`node scripts/check-sanitized.mjs` → 未发现敏感内容 → https://github.com/ExampleUser/vigil/actions/runs/41242470677 |\n| SC6 目标仓测试与 CI 全绿。验证：static | 通过 | 本机 `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm test` → 退出码 0（mivo 837、cindy 668、acceptance 691 通过 / 2 跳过；python 6 和 4 都 OK）。本机 git 全局配置会把 github.com 改写成带令牌的地址，不挡住的话 mivo 的 recheck-lock 会报 origin mismatch；CI 没有这条改写。`node scripts/check-sanitized.mjs` → 未发现敏感内容。CI `test` 通过 → https://github.com/ExampleUser/vigil/actions/runs/41242470677 |\n\n## 定下的决定\n\n- 拉取间隔 2 秒，兜底轮询 60 秒。目标是 Worker 路径 p95 ≤ 10 秒、兜底 ≤ 90 秒；单测锁的是间隔和延迟记录，不是线上实测。\n- p50 / p95 用最近秩，下标 = ceil(p × n) − 1。\n- 事件时间优先用 payload 的 `created_at`，否则按 comment、review、pull_request.updated_at、issue.updated_at 取。\n\n## 未执行的验证\n\n没有部署 Worker，没有在任何仓库注册 webhook。真事件的延迟要等部署和注册之后才能量。\n\n## 风险与回滚\n\n队列在 Worker 进程内存里，拉取是取走。还没拉走就重启的事件，靠 60 秒轮询补回来。回滚：revert 本 PR 的合并提交。\n\n模板核对：2026-10-31 14:46 PDT\n\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n<div><a href=\"https://cursor.com/agents/bc-fed56f07-77df-5a84-8b80-7d4b7ac18b7a?cursor_ref=pr_footer&cursor_cta=open_in_web\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-web-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-web-light.png\"><img alt=\"Open in Web\" width=\"114\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-web-dark.png\"></picture></a>&nbsp;<a href=\"https://cursor.com/background-agent?bcId=bc-fed56f07-77df-5a84-8b80-7d4b7ac18b7a&cursor_ref=pr_footer&cursor_cta=open_in_cursor\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-light.png\"><img alt=\"Open in Cursor\" width=\"131\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"></picture></a>&nbsp;</div>\n\n",
      "headRefName": "cursor/event-channel-webhook-8b7a",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-167",
    "source": "公开仓 vigil PR 167，2026-10-31T22:13:38Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #157。",
    "expect": [
      "ExampleUser/vigil#157"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 167,
      "title": "feat(acceptance): prio-sync 写回优先级与关联 PR（#157）",
      "body": "<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n任务 issue：ExampleUser/vigil#157\nCloses ExampleUser/vigil#157\n\n合并顺序 #162 → #159 → 本 PR；diff 里 prio-score / pr-link 相关文件属于那两个 PR，本 PR 只评审 prio-sync 与写闸白名单部分。\n\n## 改了什么\n\n- `prio-sync` 对每条看板 item 调用已并入的新版 `scorePriority` / `applyDebounce` 和 `linkedPrField`，经 `project.field.set`（带 `dedupeKey`）写回。`prio:pin` 仍然钉住。防抖状态落在状态目录的 `debounce.json`。只有 `issueState === 'closed'` 才清空优先级；Done 或验收通过但 issue 仍开着时保留算出来的档。闲置仓情形档 P0 保持 P0。\n- `mapItem` 填写 `situationTier`（看板「情形档」）、`repoClass`（默认表，可用状态目录 `repo-class.json` 覆盖：点名的 mivo 仓、点名的闲置仓，其余 daily-tool；表里没有的写进依据）、`issueState`（issue 开/关）、`lastEventAt`（看板条目或 issue 的最近更新时间）。取不到的字段在依据里写「缺信息」，走低置信 P2，不用 null 假装有值。\n- 手动值：优先级只有当前值为空，或 `changes.jsonl` 里该 item 最后一条「优先级」记录的新值等于看板当前值时才写。否则不写，输出「手动值与规则不一致，提醒一次」，并记入 `reminded.jsonl`（同一 item、同一目标值只记一次）。`--restore` 同样只在当前值仍等于上次由 prio-sync 写入的值时才改回，否则跳过并列在输出里。\n- 依据只写在 `changes.jsonl`（打分返回的 `basis`），dry-run 输出也带上。不新增看板字段。\n- 60 天无动静：`lastEventAt` 超过 60 天时输出一次「还要不要」，记入 `reminded.jsonl`（同一 item 只一次）。不关 issue，不写看板。看板映射会带上最近更新时间，真看板也能触发。\n- 写闸白名单仍然只有「优先级」「关联 PR」。其它字段名拒绝，也不能和「验收」「裁决」写在同一次动作里。「关联 PR」只接受文本类型（数字、日期等拒绝）；空值仍走清空。优先级没有对应选项时拒绝。这两处在提交 `21f0514`。\n- 验收会话的写闸 serve 模式拒绝「优先级」「关联 PR」（提交 `9dfeebd`）。修正轮只放行「验收=修正中」，exec 只放行「验收=验收中」。这两个字段只由 prio-sync 用自己的令牌写。写「验收」「裁决」仍放行。\n- 「关联 PR」改由 prio-sync 写，Mac mini 不再写。真写之前必须已有停写确认。切换步骤：先让验收机修复 Bot 确认 Mac mini 停写 → 在状态目录创建空文件 `mac-mini-stopped`（只判断存在）→ 之后非 dry-run 才会写「关联 PR」。标记不存在时，关联 PR 只在输出里列出并说明原因，不调用写闸。优先级不受这个标记影响。代码不创建该文件。\n- 状态目录默认是 `$HOME/acceptance/tools/.prio`。验收机上即 `/home/box/acceptance/tools/.prio/`。`disabled`、`changes.jsonl`、`reminded.jsonl`、`latency.jsonl`、`mac-mini-stopped` 都放这里（防抖状态 `debounce.json` 也在同目录）。测试和临时运行用 `--state-dir` 覆盖。验收机修复 Bot 按这个路径创建空文件 `mac-mini-stopped`。\n- 默认 dry-run，0 次写入。真写必须 `--write`。本 PR 不开启真写。状态目录里的 `disabled` 存在时任何模式都不写。\n- 令牌只在 prio-sync 里从 `~/acceptance/secrets/gh-priority-writer-token` 读取，不进环境变量、不进日志、不进仓库、不出现在错误信息里。请求走现有 `project.field.set`，令牌只放在请求头。\n\n## 范围对照\n\n- 本 PR 改了：\n- `.gitignore`（`.prio/`）\n- `watchers/acceptance/bin/github.mjs`\n- `watchers/acceptance/github.test.mjs`\n- `watchers/acceptance/bin/prio-sync.mjs`\n- `watchers/acceptance/prio-sync.test.mjs`\n- `watchers/acceptance/host/write-gate.mjs`\n- `watchers/acceptance/gate.test.mjs`\n\n写闸白名单那次改动单独提交：`d2e8274`（`feat(acceptance): 写闸只放行「优先级」「关联 PR」这两个新字段（#157）`）。关联 PR 只认文本类型是后补提交 `21f0514`。验收会话拒绝这两个字段是后补提交 `9dfeebd`。\n\n不属于本 PR、请到对应 PR 评审：\n\n- #162：`watchers/acceptance/bin/prio-score.mjs`、`watchers/acceptance/prio-score.test.mjs`（本分支已 merge 其最新 head，文件以 #162 为准）\n- #159：`watchers/acceptance/bin/pr-link.mjs`、`watchers/acceptance/pr-link.fixture.mjs`、`watchers/acceptance/pr-link.test.mjs`\n- 超出 issue 范围：无\n- 明确不包含：不写白名单之外的任何字段，不新增看板字段，不碰 panoptes；不在本 PR 开启真写（第一周只 dry-run）；不自动关 issue。\n- 依赖：基于 W1 https://github.com/ExampleUser/vigil/pull/162 和 W3 https://github.com/ExampleUser/vigil/pull/159 ，均未合入 main；合并前要让验收机修复 Bot 评审写闸白名单提交 `d2e8274`，以及文本类型提交 `21f0514`、写闸拒绝提交 `9dfeebd`。\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 dry-run 跑看板 84 条有输出且 0 次写入。验证：unit（测试点：dry-run，假写闸） | 通过 | `node --env-file=watchers/acceptance/test.env --test --test-name-pattern 'SC1 dry-run' watchers/acceptance/prio-sync.test.mjs` → 1 通过、0 失败 → CI https://github.com/ExampleUser/vigil/actions/runs/41246493092 |\n| SC2 写闸白名单只有「优先级」「关联 PR」两个字段，写其它字段被拒。验证：unit | 通过 | `node --env-file=watchers/acceptance/test.env --test --test-name-pattern '#157 SC2' watchers/acceptance/github.test.mjs` → 通过；数字/日期类型与缺选项：`node --env-file=watchers/acceptance/test.env --test --test-name-pattern '关联 PR 只接受文本' watchers/acceptance/github.test.mjs` → 通过；验收会话写这两个字段被拒（提交 `9dfeebd`，真实 `createGate` 判定，被拒时 `github.write` 调用 0 次）：`node --env-file=watchers/acceptance/test.env --test --test-name-pattern '#157 验收会话写「优先级」「关联 PR」被拒，验收和裁决仍放行' watchers/acceptance/gate.test.mjs` → 通过 → CI https://github.com/ExampleUser/vigil/actions/runs/41246493092 |\n| SC3 `.prio/mac-mini-stopped` 不存在时写「关联 PR」被拒、只在 dry-run 输出；存在时放行。验证：unit | 通过 | `node --env-file=watchers/acceptance/test.env --test --test-name-pattern '标记缺失' watchers/acceptance/prio-sync.test.mjs` → 通过 → CI https://github.com/ExampleUser/vigil/actions/runs/41246493092 |\n| SC4 当前值为空或上次由 prio-sync 写时才改；Praise 手动设的值不改，只提醒一次并记入 `.prio/reminded.jsonl`，重跑不重复提醒。验证：unit | 通过 | `node --env-file=watchers/acceptance/test.env --test --test-name-pattern '手动优先级|restore 当前值' watchers/acceptance/prio-sync.test.mjs` → 2 通过、0 失败 → CI https://github.com/ExampleUser/vigil/actions/runs/41246493092 |\n| SC5 60 天没动静的 issue 只提醒一次，不关 issue。验证：unit | 通过 | `node --env-file=watchers/acceptance/test.env --test --test-name-pattern '60 天' watchers/acceptance/prio-sync.test.mjs` → 2 通过、0 失败（含 mapItem 填上 lastEventAt 后触发）→ CI https://github.com/ExampleUser/vigil/actions/runs/41246493092 |\n| SC6 每次变更带一行依据写入 `.prio/changes.jsonl`，`--restore` 能按日志改回。验证：unit | 通过 | `node --env-file=watchers/acceptance/test.env --test --test-name-pattern 'SC3|restore 当前值' watchers/acceptance/prio-sync.test.mjs` → 3 通过、0 失败 → CI https://github.com/ExampleUser/vigil/actions/runs/41246493092 |\n| SC7 `.prio/disabled` 存在时不写任何字段。验证：unit | 通过 | `node --env-file=watchers/acceptance/test.env --test --test-name-pattern 'SC4' watchers/acceptance/prio-sync.test.mjs` → 通过 → CI https://github.com/ExampleUser/vigil/actions/runs/41246493092 |\n| SC8 令牌只从文件读、不进环境变量、日志和仓库。验证：static | 通过 | `node --env-file=watchers/acceptance/test.env --test --test-name-pattern 'SC5' watchers/acceptance/prio-sync.test.mjs` → 通过 → CI https://github.com/ExampleUser/vigil/actions/runs/41246493092 |\n| SC9 目标仓测试与 CI 全绿。验证：static | 通过 | CI `test` 全部步骤通过（含 bubblewrap、mivo、cindy、acceptance、check-sanitized），1 分 16 秒 → https://github.com/ExampleUser/vigil/actions/runs/41246493092 。验收会话拒绝「优先级」「关联 PR」：`node --env-file=watchers/acceptance/test.env --test --test-name-pattern '验收会话写' watchers/acceptance/gate.test.mjs` → 通过 |\n\n## 定下的决定\n\n无（#157 待定问题已在 issue 里写「无」）。\n\n## 未执行的验证\n\n- 不开启真写，不部署，没有定时任务带 `--write`。第一周只 dry-run。\n- W4 事件通道未接入。\n- `latency.jsonl` 的位置定在状态目录里，本 PR 不写延迟记录。\n- 不创建 `mac-mini-stopped`；未用真令牌、真看板跑 dry-run（待验证，等令牌更换后由验收机跑）。\n\n## 风险与回滚\n\n待验证。回滚：删除状态目录下的 `mac-mini-stopped` 或创建 `disabled` 即停写；已写字段用 `--restore <时间>` 按 `changes.jsonl` 改回（当前值若已被手动改过则跳过）；代码层 revert 本 PR。\n\n模板核对：2026-10-31 15:08 PDT\n\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n<div><a href=\"https://cursor.com/agents/bc-ae488afc-b438-552d-907e-a8f9bf437605?cursor_ref=pr_footer&cursor_cta=open_in_web\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-web-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-web-light.png\"><img alt=\"Open in Web\" width=\"114\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-web-dark.png\"></picture></a>&nbsp;<a href=\"https://cursor.com/background-agent?bcId=bc-ae488afc-b438-552d-907e-a8f9bf437605&cursor_ref=pr_footer&cursor_cta=open_in_cursor\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-light.png\"><img alt=\"Open in Cursor\" width=\"131\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"></picture></a>&nbsp;</div>\n\n",
      "headRefName": "cursor/acceptance-prio-sync-7605",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-159",
    "source": "公开仓 vigil PR 159，2026-10-31T22:09:31Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #154。",
    "expect": [
      "ExampleUser/vigil#154"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 159,
      "title": "feat(acceptance): 关联 PR 纯函数，从 PR 文本和分支匹配 issue（#154）",
      "body": "<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n任务 issue：ExampleUser/vigil#154\nCloses ExampleUser/vigil#154\n\n## 改了什么\n\n新增纯函数 `watchers/acceptance/bin/pr-link.mjs`。给定一批 issue 和一批 PR，算出每个 issue 的「关联 PR」文本。\n\n命中规则：标题或正文里的裸 `#n`（只算这条 PR 自己的仓）、`owner/repo#n`（`Refs`、`Closes`、`任务 issue：` 都是这种写法）、`https://github.com/owner/repo/issues/n`（`pull` 链接不算）、分支 `acceptance/<号>-<号>-sc<k>` 的前两个号（`sc` 后面的号不算）、分支段 `issue-<号>` / `#<号>`。\n\n文本：`#123(open,CI✓) #130(merged)`。开着且 CI 红写成 `CI✗`；还没有 CI 结论写成 `#n(open)`；已关闭未合并写成 `#n(closed)`。没有命中是空串。不联网、不读令牌、不读写看板，也没有改写闸。\n\n## 样例来源\n\n仓库里没有看板那 16 条「Linked pull requests」的导出。没有读看板，也没有用令牌。这 16 条是 2026-10-31 用 `gh pr view` 从公开仓 vigil 读到的关联行形状，不是那 16 条的原始记录，也不是 PR 全文（全文里还会提到别的 `#n`）。夹具里的 owner 写成 `ExampleUser`，因为本仓测试文件不能写真实用户名。\n\n| 公开 PR | 关联的 issue | 用到的信号 |\n|---|---|---|\n| 151 | 149 | 标题 `#149`，正文 `owner/repo#n` |\n| 148 | 147 | 同上 |\n| 145 | 144 | 同上 |\n| 143 | 142 | 同上 |\n| 141 | 140 | 标题里没有 issue 号，只在正文 |\n| 139 | 138 | 标题 `#138`，正文 `owner/repo#n` |\n| 137 | 136 | 同上 |\n| 135 | 134 | 标题里没有 issue 号 |\n| 133 | 132 | 标题里没有 issue 号 |\n| 131 | 130 | 标题里没有 issue 号 |\n| 129 | 128 | 正文 `owner/repo#n`。分支 `keel/keel-run-20261028132721-577d` 里的数字不算 issue |\n| 126 | 125 | 标题里没有 issue 号 |\n| 112 | 93、111 | 分支 `acceptance/93-93-sc5`，正文 `Closes #111`。`sc` 的 5 不算 issue |\n| 127 | 119、124 | 已关闭、未合并。分支 `acceptance/119-119-sc3`，正文 `Closes #124`。`sc` 的 3 不算 issue |\n\n另外三条是构造的，夹具 `source` 写了「构造」，不是真实 PR：\n\n- 完整 issue 链接：抽查的公开 PR 用 `owner/repo#n`，没有把 `https://github.com/.../issues/n` 当作唯一信号。\n- `Refs owner/repo#n`：方案第 3 节的写法。现有修正 PR 写的是「任务 issue：」和 `Closes`，抽查的正文里没有字面的 `Refs` 行。\n- 同号不同仓：裸 `#n` 和 `acceptance/` 分支只落在 PR 自己的仓；`Refs` 和完整链接落在写明的仓。\n\n`#123(open,CI✓) #130(merged)` 的数字来自方案第 3 节的示例句子，不是 PR 123 和 130 的真实状态。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/bin/pr-link.mjs`（新增匹配和文本格式化）、`watchers/acceptance/pr-link.fixture.mjs`（夹具）、`watchers/acceptance/pr-link.test.mjs`（测试），都在 issue「范围」内\n- 超出 issue 范围：无\n- 明确不包含：不读写 GitHub 和看板，不读任何令牌，写入属于 W2；事件通道属于 W4；不碰 panoptes\n- 依赖：无\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 匹配规则（标题或正文 `#n`、完整 issue 链接、分支号、`Refs owner/repo#n`） | 通过 | `node --env-file=watchers/acceptance/test.env --test watchers/acceptance/pr-link.test.mjs` → 实现前 5 条失败（匹配函数返回空），实现后 7/7 通过、0 失败 → 本机日志 `# tests 7 / # pass 7 / # fail 0` |\n| SC2 16 条关联全部命中、同号不同仓不配 | 通过 | 同上一条命令里的「SC2 fixtures」→ 通过，16 条非空、别仓同号和分支里的非 issue 数字都是空串 → 本机日志 `# pass 7 / # fail 0` |\n| SC3 文本格式 `#123(open,CI✓) #130(merged)`、CI 红写 `CI✗`、无命中写空串 | 通过 | 同上「SC3 文本格式」→ 通过 → 本机日志 `# pass 7 / # fail 0` |\n| SC4 模块不联网、不读令牌 | 通过 | 同上「SC4」两条（源码扫描 + 跑匹配时 `fetch` 调用次数为 0）→ 通过；`node scripts/check-sanitized.mjs` → 退出码 0，「未发现敏感内容」 → 本机日志 `# pass 7 / # fail 0` |\n| SC5 目标仓测试与 CI 全绿 | 通过 | `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 npm test` → 退出码 0（mivo 837/837、cindy 668/668、两组 python OK、acceptance 691 通过 / 0 失败 / 2 跳过，跳过的两条是「本地不是 CI」）→ CI `test` 通过 https://github.com/ExampleUser/vigil/actions/runs/41242359041 |\n\n（表格由原「验收对照」列表逐条搬入，内容未改；SC1–SC4 的证据是本机测试日志，SC5 有 CI 链接。）\n\n## 定下的决定\n\n无\n\n## 未执行的验证\n\n无\n\n## 风险与回滚\n\n无已知风险（只新增纯函数，不联网、不写看板）。回滚：revert 本 PR。\n\n\n模板核对：2026-10-31 14:46 PDT\n\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n<div><a href=\"https://cursor.com/agents/bc-9d6b2ae9-1a08-54bf-8cf6-ad6c1091058c?cursor_ref=pr_footer&cursor_cta=open_in_web\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-web-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-web-light.png\"><img alt=\"Open in Web\" width=\"114\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-web-dark.png\"></picture></a>&nbsp;<a href=\"https://cursor.com/background-agent?bcId=bc-9d6b2ae9-1a08-54bf-8cf6-ad6c1091058c&cursor_ref=pr_footer&cursor_cta=open_in_cursor\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-light.png\"><img alt=\"Open in Cursor\" width=\"131\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"></picture></a>&nbsp;</div>\n\n",
      "headRefName": "cursor/pr-link-issue-154-058c",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-176",
    "source": "公开仓 vigil PR 176，2026-10-31T22:09:25Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #169。",
    "expect": [
      "ExampleUser/vigil#169"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 176,
      "title": "acceptance: correction child issues follow the local child-issue template (#169)",
      "body": "任务 issue：ExampleUser/vigil#169\nCloses ExampleUser/vigil#169\n\n## 改了什么\n\n验收会话 `correct` 新开的修正子 issue 改按本机子 issue 模板生成（差异 1–4）：\n\n- 标题 `[子N/M] 一句话`（N = 总 issue 下现有子 issue 数 + 1，M = N；`--title` 只换「一句话」部分），`issue.create` 带 `labels: ['子issue']`（写闸原样透传，没改写闸）。\n- 「范围（可改）」照抄原属 issue「范围」段里带反引号路径的行；读不到时写一行 `` `**` ``（限原属 issue 范围内）。\n- 新增「参考」（原验收项、裁决链接）和「待定问题」（「无」）两段。\n- SC1 行补齐「验证：<层>（测试点：…）」：原文已有就照抄；缺测试点补「<原属项> SC<k> 的原验收入口」；原项没标层次时写 `static` 占位。\n- 「正文只有一行 SC1」例外写进 `docs/acceptance-prbot.md`。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/bin/correct.mjs`：修正子 issue 标题、标签、正文组装；`docs/acceptance-prbot.md`：新节「修正子 issue 的格式（#169）」；`watchers/acceptance/correct.test.mjs`、`watchers/acceptance/prbot-gate.test.mjs`：相关测试。\n- 超出 issue 范围：`watchers/acceptance/bin/correct.mjs` 不在 issue 列的 `watchers/acceptance/host/prbot*.mjs` 里。核对 main 后，修正子 issue 由验收会话的 `correct`（`bin/correct.mjs` 的 `correctionBody`）开，prbot 只读它，所以改动落在这里；`prbot.mjs` 没改。`watchers/acceptance/prbot-gate.test.mjs` 在范围 `watchers/acceptance/*.test.mjs` 内，只改了夹具输入（给 SC 原文带上测试点），断言含义不变。\n- 明确不包含：不改修正 PR 正文（子 2/4）、不改写闸（子 3/4）、不接入开 PR 前检查（子 4/4）；不改 collect 的 SC 解析逻辑、不改写闸配置。\n- 依赖：无，随时可开工。\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 生成的修正子 issue 标题匹配 `^\\[子[0-9]+/[0-9]+\\] `，创建请求带标签「子issue」。验证：unit（测试点：prbot 修正子 issue 组装函数 / issue.create 请求参数） | 通过 | `node --test watchers/acceptance/correct.test.mjs`「SC5 新开修正子 issue」断言标题和 `labels` → 通过 → CI acceptance-watcher tests 成功：https://github.com/ExampleUser/vigil/actions/runs/41246480934/job/124670862639 |\n| SC2 生成正文的「范围」每行都有反引号包住的路径或 glob，含「参考」「待定问题」段（无内容写「无」），SC 行含「验证：<层>（测试点：…）」；正文只有一行 SC1 的例外写进 `docs/acceptance-prbot.md`。验证：unit（测试点：正文组装函数 + 文档测试） | 通过 | `node --test watchers/acceptance/correct.test.mjs` 的 #169 三个测试（正文规则、`scopeLinesOf`、文档）→ 通过 → CI acceptance-watcher tests 成功：https://github.com/ExampleUser/vigil/actions/runs/41246480934/job/124670862639 |\n| SC3 测试用与 `check-pr-issue.sh` 同等的规则（五个标题齐、有 SC<n> 项）校验生成正文并通过。验证：unit（测试点：生成正文对同等规则的校验） | 通过 | `node --test watchers/acceptance/correct.test.mjs` 中 `assertChildTemplate` 覆盖 fork / 非 fork × 三种 SC 原文 → 通过 → CI acceptance-watcher tests 成功：https://github.com/ExampleUser/vigil/actions/runs/41246480934/job/124670862639 |\n| SC4 目标仓测试与 CI 全绿（`npm test`、`check-sanitized`）。验证：static | 通过 | CI（head `0dd59e6`）`npm test` 各组（mivo / cindy / cindy python / acceptance）与 `check-sanitized` → 全部成功，test 任务 1 分 28 秒 → https://github.com/ExampleUser/vigil/actions/runs/41246480934/job/124670862639。本机另跑：mivo 836/837（1 败因本机 git 地址被改写，与本补丁无关，CI 通过）；acceptance 本机 3 败（1 个是 #149 CPU 计时波动，单独重跑通过；2 个因本机没有 bwrap，CI 装了并通过） |\n\n## 定下的决定\n\n- 改动落在 `bin/correct.mjs` 而不是 `host/prbot.mjs`：修正子 issue 是 `correct` 开的（见范围对照）。\n- 原项没标验证层次时 SC1 写 `验证：static` 占位：模板要求有层，`parseLayer` 只认 ASCII 层名；验收机仍按原验收项去验。\n- M 取 N：开出时它是总 issue 下最后一个子 issue。\n- 修正标记行、只有一行 SC1、collect 的 `parseItems` / `parseMarker` 都不变（测试断言标记解析结果和只解析出 1 项）。\n\n## 未执行的验证\n\n- CI 已跑（head `0dd59e6`，test 成功：https://github.com/ExampleUser/vigil/actions/runs/41246480934/job/124670862639）。本机全量测试有 4 个与本补丁无关的环境性失败，见 SC4 证据。\n- 没有在真实总 issue 上跑一轮 `correct`（会真开 issue），只用夹具验证。\n\n## 风险与回滚\n\n- 旧的已开修正子 issue 复用时不改写，仍是旧格式。\n- 原属 issue 读不到时范围写 `` `**` ``，比原来的一行文字更宽；禁改路径仍由 prbot 检查。\n- 回滚：revert 本 PR 的合并提交。\n\n模板核对：2026-10-31 15:10 PDT\n",
      "headRefName": "fix/prbot-child-issue-template",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-162",
    "source": "公开仓 vigil PR 162，2026-10-31T22:09:19Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #153。",
    "expect": [
      "ExampleUser/vigil#153"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 162,
      "title": "feat(acceptance): 看板优先级打分纯函数 prio-score（#153）",
      "body": "<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n任务 issue：ExampleUser/vigil#153\nCloses ExampleUser/vigil#153\n\n## 改了什么\n\n打分改成跟 #62 的四档和方案 A/B 一致。仍然是纯函数：不联网、不读令牌、不读写看板。\n\n- 新增输入 `facts.situationTier`（P0–P3，由调用方按方案 A 的四条语义给出）和 `facts.repoClass`（`mivo` / `daily-tool` / `idle`）。\n- 先按仓换算：mivo 用情形档；daily-tool 低半档（P0 不变，P1→P2，P2 和 P3 不变）；idle 的 P0 保持 P0，情形档 P1 及以下才在 daily-tool 的结果上再低一档，最低 P3（P1→P3，P2→P3，P3→P3）。\n- 机器信号 S1–S5 只升不降。最终档是换算结果和信号档里更高的那个。\n- 没给情形档、也没有信号时，返回 P2，`lowConfidence: true`。原来兜底成 P3 的做法去掉了。\n- 只有 `facts.issueState === 'closed'` 才清空。Done 或验收=通过但 issue 仍开着时，保留算出来的档。\n- 返回值增加 `lowConfidence` 和 `basis`（一行依据：情形档、有没有按仓降档、哪条信号升了档）。\n- `prio:pin` 和防抖不变：升级立刻写；降级连续 2 次且间隔不少于 15 分钟；1 小时内第 5 次变更冻结。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/bin/prio-score.mjs`、`watchers/acceptance/prio-score.test.mjs`\n- 超出 issue 范围：无\n- 明确不包含：不读写 GitHub 和看板，不读令牌，不改写闸。手动值保护（除 `prio:pin`）、60 天提醒、dry-run 日志属于后续写回\n- 依赖：无\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 情形档 × repoClass 换算表每格至少一个用例：mivo 原档；每天在用的工具 P0→P0、P1→P2、P2→P2、P3→P3；闲置的 P0 保持 P0，P1 及以下再低一档、最低 P3。验证：unit（测试点：prio-score 函数） | 通过 | `node --env-file=watchers/acceptance/test.env --test watchers/acceptance/prio-score.test.mjs` → 24 通过、0 失败（改实现前 3 条失败：idle×P0 实际是 P1）→ https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n| SC2 机器信号只升不降：信号档高于换算档时取信号档，低于时保持换算档不变。验证：unit | 通过 | 同上，情形档 P0 遇到 CI 失败仍是 P0；idle 的 P0 遇到 blocker 仍是 P0、不算升档；idle 的 P1 遇到 blocker 升到 P0 → https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n| SC3 没有情形档时返回 P2 并标低置信。验证：unit | 通过 | 同上，mivo / daily-tool / idle / 没给仓类别都是 P2，`lowConfidence: true`，依据里有「低置信」→ https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n| SC4 issue 关闭返回清空；验收=通过但 issue 开着保留原优先级。验证：unit | 通过 | 同上，`issueState: 'closed'` 即使有 P0 信号也清空；验收=通过且 issue 开着时保留算出来的档 → https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n| SC5 每次返回都带一行依据，说明命中的情形档、仓换算和信号。验证：unit | 通过 | 同上，idle×P0 的依据写「保持 P0」，不写降成 P1 → https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n| SC6 升级立刻生效；降级需要连续 2 次重算且间隔不少于 15 分钟才生效；每个 item 每小时变化超过 4 次时返回冻结。验证：unit（测试点：防抖状态函数） | 通过 | 同上，升级立刻 `write`；差 1 毫秒不满 15 分钟仍 `skip`，满 15 分钟 `write`；第 5 次变更 `freeze` 且 `alert` → https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n| SC7 带 `prio:pin` 标签的 item 永远返回原值。验证：unit | 通过 | 同上，钉住时即使 issue 已关闭、心跳超时也返回原值，防抖 `skip` → https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n| SC8 模块不含网络调用、不读环境变量里的令牌。验证：static | 通过 | 同上，源码无 import、无 `process.env`、无网络调用；环境里放了占位变量结果不变 → https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n| SC9 目标仓测试与 CI 全绿。验证：static | 通过 | CI `test` job（mivo、cindy、acceptance、两边 python、check-sanitized）→ 通过，1 分 19 秒 → https://github.com/ExampleUser/vigil/actions/runs/41245075292 |\n\n## 定下的决定\n\n- **已确认：idle 的 P0 保持 P0。** 线上坏了、数据或安全问题不因项目闲置降档。只有情形档 P1 及以下才在 daily-tool 的结果上再低一档，最低 P3。\n- 没给情形档时，三种仓都直接记低置信 P2，不再按仓往下降。\n- 没给 `repoClass` 时不降档，和 mivo 一样。\n- 信号档和换算档一样高时不算升档，依据写「没有机器信号升档」。\n\n## 未执行的验证\n\n- 没有接入写回，没有对真看板做 dry-run。\n- 手动设过的值除 `prio:pin` 以外怎么认、60 天没动静只提醒，都不在这个纯函数里。\n\n## 风险与回滚\n\n纯函数，仓库里还没有调用方，合并后现有行为不变。回滚：revert 本 PR 的合并提交。\n\n模板核对：2026-10-31 14:47 PDT\n\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n<div><a href=\"https://cursor.com/agents/bc-278e9009-badb-5e8b-893f-bd47d2345227?cursor_ref=pr_footer&cursor_cta=open_in_web\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-web-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-web-light.png\"><img alt=\"Open in Web\" width=\"114\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-web-dark.png\"></picture></a>&nbsp;<a href=\"https://cursor.com/background-agent?bcId=bc-278e9009-badb-5e8b-893f-bd47d2345227&cursor_ref=pr_footer&cursor_cta=open_in_cursor\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-light.png\"><img alt=\"Open in Cursor\" width=\"131\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"></picture></a>&nbsp;</div>\n\n",
      "headRefName": "cursor/acceptance-prio-score-5227",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-160",
    "source": "公开仓 vigil PR 160，2026-10-31T22:06:56Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #155。分支名没有 issue 号。",
    "expect": [
      "ExampleUser/vigil#155"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 160,
      "title": "feat(acceptance): 舰队任务标准的只读 check、证据和红灯",
      "body": "<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\n任务 issue：ExampleUser/vigil#155\nCloses ExampleUser/vigil#155\n\n## 改了什么\n\n只读 check 执行器：清单用统一 YAML 头（id/owner/check/deadline/escalate/evidence），退出码 0 表示成立，超时判红。evidence 按 UTC 日期写 jsonl，红灯写入 alerts.jsonl。不走写闸，不读令牌，不改验收机原有轮次、裁决和调度。格式说明在 `docs/fleet-standard.md`，示例在 `config/examples/fleet-checklist.example.md`。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/fleet-standard.mjs`、`watchers/acceptance/bin/fleet-standard.mjs`（只读 check 执行器和表格生成）、`watchers/acceptance/fleet-standard.test.mjs`（测试）、`docs/fleet-standard.md`、`config/examples/fleet-checklist.example.md`、`watchers/acceptance/README.md`（说明和示例），都在 issue「范围」内\n- 超出 issue 范围：无\n- 明确不包含：不改验收机的功能和范围，不碰写闸，不读令牌；看板字段写入属于 W2；不碰 panoptes\n- 依赖：无\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 | 通过 | 所有非 manual 行的 check 都能执行并返回退出码。`node --env-file=watchers/acceptance/test.env --test watchers/acceptance/fleet-standard.test.mjs` → 13 pass / 0 fail（含示例清单里非 manual 行退出码 0、manual 不执行）→ 本地测试输出 |\n| SC2 | 通过 | 人为造一条超时行，60 秒内在 alerts.jsonl 出现红灯（假时钟，墙钟不到 2 秒；另有一条 200ms 的真进程超时）。同上命令中的 SC2 用例 → pass，`kind` 为 `fleet-check-red`，原因含「超时」 |\n| SC3 | 通过 | evidence 按 UTC 日期写入 `YYYY-MM-DD.jsonl`，每行有 `at`（时间）、`source`（来源）、`result`（结果）。同上命令中的 SC3 用例 → pass |\n| SC4 | 通过 | YAML 头能生成表格，且 T13、T14 作为已完成证据行保留，没有其它过时条目。前半：`node watchers/acceptance/bin/fleet-standard.mjs table --list config/examples/fleet-checklist.example.md` → 退出码 0，表头含 id/owner/check/deadline/escalate/evidence → 仓库示例与 `docs/fleet-standard.md`。后半：修复 Bot 在验收机上核查 `board.md`：仅 T13、T14 两行已完成证据行，无其它涉及 #131/#119 的条目，无需清理，未删除任何东西；决定依据 https://github.com/ExampleUser/vigil/issues/155#issuecomment-6549751863 |\n| SC5 | 通过 | 目标仓测试。CI `test` 成功（1 分 14 秒，mivo、cindy、python、acceptance、脱敏检查都过）：https://github.com/ExampleUser/vigil/actions/runs/41246187477 ，对应 head `694660197b9e0b517fcb026005039cd9528da549`（check run 的 head_sha 已核对）。已 rebase 到含 https://github.com/ExampleUser/vigil/pull/166 的 main `c50e674`，这次 CI 里 #149 SC1 墙钟竞态没有复现。 |\n\n（表格由原 SC 列表逐条搬入，证据原文未改；SC1–SC3 证据为本地测试输出。）\n\n## 定下的决定\n\n无（issue 里「需要人读改动的条目标 `check: manual`」已在 2026-10-31 定，写在 issue 待定问题里）\n\n## 未执行的验证\n\n无。SC4 后半由验收机修复 Bot 在验收机上只读核查（见上表证据链接），无需清理。\n\n## 风险与回滚\n\n无已知风险（新增只读执行器，不走写闸）。回滚：revert 本 PR。\n\n\n模板核对：2026-10-31 15:05 PDT\n\n<!-- CURSOR_AGENT_PR_BODY_END -->\n\n<div><a href=\"https://cursor.com/agents/bc-4faae08e-58ec-570a-acd5-61edbef43fca?cursor_ref=pr_footer&cursor_cta=open_in_web\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-web-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-web-light.png\"><img alt=\"Open in Web\" width=\"114\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-web-dark.png\"></picture></a>&nbsp;<a href=\"https://cursor.com/background-agent?bcId=bc-4faae08e-58ec-570a-acd5-61edbef43fca&cursor_ref=pr_footer&cursor_cta=open_in_cursor\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"><source media=\"(prefers-color-scheme: light)\" srcset=\"https://cursor.com/assets/images/open-in-cursor-light.png\"><img alt=\"Open in Cursor\" width=\"131\" height=\"28\" src=\"https://cursor.com/assets/images/open-in-cursor-dark.png\"></picture></a>&nbsp;</div>\n\n",
      "headRefName": "cursor/fleet-check-standard-3fca",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-174",
    "source": "公开仓 vigil PR 174，2026-10-31T22:03:00Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 是 #173。分支 acceptance/163-163-sc1 另算 #163，sc 后的 1 不算。",
    "expect": [
      "ExampleUser/vigil#163",
      "ExampleUser/vigil#173"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 174,
      "title": "修正：ExampleUser/vigil#163 SC1",
      "body": "任务 issue：ExampleUser/vigil#173\nCloses ExampleUser/vigil#173\n\n> 修正 PR · 原属 ExampleUser/vigil#163 SC1 · 修正轮第 1 轮\n\n## 改了什么\n\n修正验收没过的 ExampleUser/vigil#163 SC1：App 覆盖的 owner 单仓只读查询走 App 令牌；同一实例只取一次令牌；取令牌命令带超时和 killGroup，环境里没有 GH_TOKEN。验证：unit。没过的原因：取令牌命令没有真正按 killGroup 跑：宿主只读盘点 host/tick.mjs 起 bin/poll.mjs，poll.mjs 里 createGithub({profile}) 没传 run，落到 defaultRun；defaultRun 参数解构只有 {env,input,timeoutMs}，spawn 没有 detached，超时只 SIGKILL 直接子进程，不杀进程组。实测 defaultRun 的子进程 PGID 与 node 相同，host/proc.mjs 的 run 才是独立进程组，因此 token 命令派生的子进程在 30 秒超时后仍可能留下。修法：让 defaultRun 支持 killGroup（detached + 对 -pgid 发信号），或这条路径改用 host/proc.mjs 的 run；并补一条覆盖 defaultRun 实际行为的测试。\n\n- 本 PR 改了：`watchers/acceptance/bin/github.mjs`、`watchers/acceptance/github-app-token.test.mjs`（复现测试和最小修复）\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/bin/github.mjs`、`watchers/acceptance/github-app-token.test.mjs`（复现测试和最小修复）\n- 修正子 issue 的范围（可改）：修好 ExampleUser/vigil#163 SC1 所需的最小代码改动和复现测试，限原属 issue 的范围内（目标仓禁改路径照旧不碰）\n- 超出 issue 范围：无（推之前按禁改路径检查过）\n- 明确不包含：不改修正子 issue 以外的验收项\n- 修正子 issue 不做：不改 ExampleUser/vigil#163 的其它验收项，不扩大原属 issue 的范围\n- 依赖：无，随时可开工。\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 App 覆盖的 owner 单仓只读查询走 App 令牌；同一实例只取一次令牌；取令牌命令带超时和 killGroup，环境里没有 GH_TOKEN。验证：unit | 通过 | CI `test` job（head 28806390，2026-10-31 14:58–15:00 PDT）→ 通过 → https://github.com/ExampleUser/vigil/actions/runs/41246060996/job/124669639645 ；新测试 `watchers/acceptance/github-app-token.test.mjs` 真起 sh 子进程派生忽略 SIGTERM 的孙进程，超时 300ms 后断言返回 124、4 秒内结束、孙进程已不在；该文件 13 条全过；把 github.mjs 换回父提交 c50e674 版本后这条新测试失败（1 !== 124），本分支通过 |\n\n## 定下的决定\n\n无\n\n## 未执行的验证\n\n- SC1 由验收机在本 PR 合并、修正子 issue 关闭后再验。\n- 没有在验收机上部署实测。\n\n## 风险与回滚\n\n只改修正子 issue 对应验收项的代码和测试；回滚：revert 本 PR 的合并提交。\n\n[验收机] 修正 · 总 ExampleUser/vigil#163 · 项 ExampleUser/vigil#163 SC1 · 第 1 轮\n\n模板核对：2026-10-31 15:03 PDT\n",
      "headRefName": "acceptance/163-163-sc1",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-166",
    "source": "公开仓 vigil PR 166，2026-10-31T21:58:27Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 是 #158。分支 acceptance/149-149-sc6 另算 #149，sc 后的 6 不算。",
    "expect": [
      "ExampleUser/vigil#149",
      "ExampleUser/vigil#158"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 166,
      "title": "修正：ExampleUser/vigil#149 SC6",
      "body": "任务 issue：ExampleUser/vigil#158\nCloses ExampleUser/vigil#158\n\n> 修正 PR · 原属 ExampleUser/vigil#149 SC6 · 修正轮第 1 轮\n\n## 改了什么\n\n修正验收没过的 ExampleUser/vigil#149 SC6（`npm test`、`check-sanitized` 全绿，CI 绿）。没过的原因：ExampleUser/vigil#149 SC1 用例（`watchers/acceptance/host-round.test.mjs`）用墙钟断言，有竞态。原来单跑 40 次 9 次失败（累计 58 次 15 次，约 1/4），失败都是「卡住判得太早：776–779ms」。用例要求 abort ≥ 600+180=780ms，但探针只在 Date.now()-startedAt < 600 时加 ticks，最后一次 CPU 变化必然早于 600ms，实际判定落在 776–780ms，能否过线看每拍多出的零点几毫秒；被测行为本身符合 SC1。\n\n本 PR 用假时钟改写这条 SC1 用例，不再依赖墙钟，让 `npm test` 稳定。只改测试，不改被测代码。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/host-round.test.mjs`：用假时钟改写 ExampleUser/vigil#149 SC1 用例（都在 ExampleUser/vigil#158 范围内）\n- 与总 issue 的关系：ExampleUser/vigil#158 是总 issue ExampleUser/vigil#149 SC6 的修正子 issue；本 PR 不关 ExampleUser/vigil#149，由验收机重验\n- 修正子 issue 的范围（可改）：修好 ExampleUser/vigil#149 SC6 所需的最小代码改动和复现测试，限原属 issue 的范围内（目标仓禁改路径照旧不碰）\n- 超出 issue 范围：无（推之前按禁改路径检查过）\n- 明确不包含：不改 ExampleUser/vigil#149 的其它验收项，不扩大原属 issue 的范围；其余环境相关失败（见「未执行的验证」）不在修正范围\n- 依赖：无\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 `npm test`、`check-sanitized` 全绿，CI 绿。验证：static | 通过 | CI：head 7bda1ec 的 test 检查 → success → https://github.com/ExampleUser/vigil/actions/runs/41244612570/job/124665336291 ；复测（只读，分支 acceptance/149-149-sc6 @ 7bda1ec，Node v22.23.4，4 核）：`node --env-file=watchers/acceptance/test.env --test --test-reporter=spec --test-name-pattern '#149 SC1' watchers/acceptance/host-round.test.mjs` → 串行 60 次 60 过 0 失败；4 进程并行 4×15=60 次 60 过 0 失败 → 云端复测日志；整个 `host-round.test.mjs` 串行 5 次 → 每次 tests 25 / pass 25 / fail 0；对照父提交 2c2d286（origin/main）旧用例串行 40 次 → 20 次失败，断言「卡住判得太早：~777ms」在 host-round.test.mjs:803（竞态可复现，改写后不复现）；`node scripts/check-sanitized.mjs` → 退出码 0 |\n\n## 定下的决定\n\n无\n\n## 未执行的验证\n\n- 完整 `npm test` 在云端复测环境里退出码 1。失败项都不在本 PR 改动范围，且父提交上同样失败：mivo recheck-lock、cindy 两条、acceptance prbot-sandbox 两条，原因是环境没有 bwrap、git origin 形式不匹配。那 8 条「SC11 真实路径」用例在该环境因无 bwrap 跳过。本 PR 的完整测试以 GitHub CI test 检查（绿）为准。\n- SC1 由验收机在本 PR 合并、ExampleUser/vigil#158 关闭后再验。\n\n## 风险与回滚\n\n只改一个测试文件，不动被测代码；风险是假时钟用例对真实计时的覆盖比墙钟版窄。回滚：revert 本 PR 的合并提交。\n\n[验收机] 修正 · 总 ExampleUser/vigil#149 · 项 ExampleUser/vigil#149 SC6 · 第 1 轮\n\n模板核对：2026-10-31 14:54 PDT\n",
      "headRefName": "acceptance/149-149-sc6",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-164",
    "source": "公开仓 vigil PR 164，2026-10-31T21:26:23Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：正文只有一行 Closes #163。标题里的 #163 不算。",
    "expect": [
      "ExampleUser/vigil#163"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 164,
      "title": "feat(acceptance): 只读轮询可选走 App 安装令牌，失败回退账号令牌（#163）",
      "body": "Closes #163\n\n## 改了什么\n\n- `bin/profile.mjs`：新增可选 `appTokenCommand`（非空字符串数组）和 `appOwners`（默认 `[ownerLogin]`），类型不对直接报错。\n- `bin/github.mjs` `graphql()`：纯查询且变量带 `owner`+`name`、owner 在 `appOwners` 里时，先跑 `appTokenCommand` 取令牌（30 秒超时、killGroup，环境里不带 GH_TOKEN），令牌只放进这次读的 gh 子进程。取不到，或 App 读到 401/403/404（含 GraphQL FORBIDDEN / Resource not accessible by integration / Could not resolve to a Repository），改用账号令牌重试一次，`<home>/state/host/loop.log` 记 `app-token-fallback kind=… repo=…`。同一实例只取一次令牌；401 后本实例不再用 App。\n- 跨仓清单、搜索、viewer、别的 owner：照旧账号令牌。写操作、mutation、看板写入不动。\n- `host/sandbox.mjs`：沙箱 profile 副本删掉 `appTokenCommand`、`appOwners`。\n- 文档：operations 和 README 各补一段。\n\n超时和 5xx 不回退，照旧由 tick 的只读超时/重试包装处理，所以单次读最坏耗时不变（App 失败回退只发生在 401/403/404 这种立即返回的情况）。\n\n## 验收标准对应\n\n| SC | 证据 |\n|---|---|\n| SC1 | `node --test watchers/acceptance/github-app-token.test.mjs` →「App 成功」用例通过 |\n| SC2 | 同上「取令牌命令退出非 0」用例通过 |\n| SC3 | 同上 401/403/404 三个用例 +「GraphQL 业务错误」用例通过 |\n| SC4 | 同上「App 没装的 owner」「不落在单个仓上的查询」「appOwners 可配」用例通过 |\n| SC5 | 同上「写操作和 mutation 不走 App」用例通过 |\n| SC6 | 同上「profile 校验 / 沙箱副本」用例通过 |\n| SC7 | 本地 `npm test`：acceptance 695 过；`host-round.test.mjs` 里 #149 SC1 计时用例在机器负载高时偶发失败（与本改动无关，单独重跑通过）；`npm run check:sanitized` 无敏感内容；CI 见下方检查 |\n\n另在宿主上用真实只读请求核对过：同一批查询（议题正文、轮次评论、PR 检查等 10 种）App 令牌和账号令牌返回逐字节相同；取令牌命令指向不存在的文件时回退成功并记日志。\n",
      "headRefName": "fix/app-token-reads",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-150",
    "source": "公开仓 vigil PR 150，2026-10-31T20:46:55Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 行是 owner/repo#147。同行括号里的 #148 是在说上一个 PR，不算。",
    "expect": [
      "ExampleUser/vigil#147"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 150,
      "title": "fix(acceptance): 内存门日志行再带上被挡的 issue 和阈值 thresholdMiB=3072（#147 补充）",
      "body": "任务 issue：ExampleUser/vigil#147（#148 的补充）\n\n## 为什么补\n\n#148 合并后，负责人补了一条要求：内存门那行如果写日志的地方已经知道被挡的待开轮 issue，就一并写上；阈值按 3072 MiB（3221225472 字节）的口径写明。\n\n## 改了什么\n\n- `host/round.mjs`：`runHostRound` 的入参本来就有这一拍要认领的 `issue`，直接写进日志行，不改判定、不多发 GitHub 请求：\n  `2026-10-31T20:00:00.000Z mem-gate-defer issue=ExampleUser/vigil#1 availKiB=1024 thresholdMiB=3072 内存门：MemAvailable 1048576 字节 < 3221225472，这一拍不认领`\n  读不到 MemAvailable 时 `availKiB=unknown`，其余一样。`thresholdMiB` 由 `MEMORY_GATE_BYTES` 算出，常量本身没动。\n- `docs/acceptance-operations.md`：格式和阈值口径（3072 MiB = 3221225472 字节）同步。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/host/round.mjs`（两行日志文案）、`watchers/acceptance/mem-gate-log.test.mjs`、`docs/acceptance-operations.md`。\n- 超出 issue 范围：无\n- 明确不包含：内存门阈值和判定、退出码、写闸、prbot / 裁决的内存门、老日志回填。\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 内存不够：行首时间 + `mem-gate-defer issue=… availKiB=… thresholdMiB=3072`，退出 3 不认领。验证：unit | 通过 | `node --test watchers/acceptance/mem-gate-log.test.mjs`：先改用例 2 条全红，改代码后 2 条全绿 |\n| SC2 读不到 MemAvailable：同样一行，`availKiB=unknown`。验证：unit | 通过 | 同上第 2 条 |\n| SC3 `npm test`、`check-sanitized` 全绿，CI 绿。验证：static | 通过 | 本机 `npm test < /dev/null` 退出码 0（837 / 668 / 677，0 失败，2 跳过）；`node scripts/check-sanitized.mjs` 未发现敏感内容；CI 见本 PR checks |\n\n## 风险与回滚\n\n只动日志文案。回滚：revert 合并提交，`git pull --ff-only` 部署，不用重启循环。\n",
      "headRefName": "fix/mem-gate-issue",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-151",
    "source": "公开仓 vigil PR 151，2026-10-31T20:46:01Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #149。",
    "expect": [
      "ExampleUser/vigil#149"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 151,
      "title": "fix(acceptance): 卡住判定加沙箱活动信号，长时间跑测试不再误判卡住（#149）",
      "body": "任务 issue：ExampleUser/vigil#149\nCloses ExampleUser/vigil#149\n\n## 改了什么\n\n卡住判定原来只看 `pi.log` 变长和写闸请求。pi 在沙箱里跑长命令（`npm run test:unit` 之类）时两样都不动，一轮在干活也会在 `stallMinutes`（30 分钟）后被中止。\n\n- 新增 `host/activity.mjs`，每拍多看两个信号，任一变化就刷新 `lastActivityAt`：\n  - pi 进程树 CPU：从 pi 的宿主 pid（bwrap）出发，扫 `/proc/*/stat` 建父子关系，把整棵后代树的 utime+stime+cutime+cstime 加起来，变大就算活动。带上 cutime/cstime，子进程退出后时间并进父进程，总数不会倒退。\n  - 沙箱目录 mtime：本轮目录下 `home/.npm/_logs`、`home`、`tmp` 本身和一层子项的最新 mtime，变了就算活动。只浅扫，不递归 `tmp/repo` 整棵树。\n- `host/round.mjs`：看守循环里调用探针（可注入 `probeActivity`，测试用）；第一拍只记基线；探针抛异常当作没有信号，不影响本轮。\n- 进度文件加 `activitySource`（`start`/`prepare`/`gate`/`pi-log`/`cpu`/`files`），原有字段不变。`poll`、`fixer-health`、看板只读 `lastActivityAt` 等原字段，不受影响。\n- 文档 `docs/acceptance-operations.md` 第 4 节补一段。\n\n在盒子上对一轮正在跑的真实轮次只读试了探针：5 秒内进程树 CPU 255193 → 255308 个时钟，判为 `cpu`；同一时间段 `pi.log` 没变。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/host/activity.mjs`（新增）、`host/round.mjs`、`host/paths.mjs`（注释）、`host-round.test.mjs`、`activity.test.mjs`（新增）、`docs/acceptance-operations.md`。\n- 超出 issue 范围：无\n- 明确不包含：写闸、`stallMinutes` 和 `maxRoundMinutes` 的默认值与配置值、abort 流程、轮次评论。\n- 依赖：无\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 pi.log 不长、写闸无请求、进程树 CPU 在涨：不判卡住，`activitySource=cpu`。验证：unit | 通过 | `node --test watchers/acceptance/host-round.test.mjs`「#149 SC1」：改前红（按时判卡住），改后绿：CPU 停了之后才判卡住 |\n| SC2 沙箱 `home/.npm/_logs` 有新文件：不判卡住，`activitySource=files`。验证：unit | 通过 | 同文件「#149 SC2」（默认探针、真目录）：改前红，改后绿 |\n| SC3 所有信号不变：仍判卡住、停 pi、abort、round-stalled。验证：unit | 通过 | 同文件「#149 SC3」及原有 SC11 卡住用例全绿；探针抛异常用例也照常判卡住 |\n| SC4 CPU 一直涨也挡不住总时长上限：round-timeout。验证：unit | 通过 | 同文件「#149 SC4」：改前红（先判了卡住），改后绿（round-timeout、没有 round-stalled） |\n| SC5 `/proc` 进程树 CPU 求和对真实子进程有效。验证：unit | 通过 | `node --test watchers/acceptance/activity.test.mjs`：根进程 sleep、子进程空转，树的时钟数变大；进程退了返回 null；只数后代，comm 带括号也能解析 |\n| SC6 `npm test`、`check-sanitized` 全绿，CI 绿。验证：static | 通过 | 本机 `npm test < /dev/null` 退出码 0（837 / 668 / 686 条，0 失败，2 跳过）；`node scripts/check-sanitized.mjs`（含本地私有词清单）未发现敏感内容；CI 见本 PR checks |\n\n## 定下的决定\n\n- 两个信号都用，任一变化就算活动。CPU 能覆盖不写文件的长测试，mtime 能覆盖 CPU 低、主要在等 IO 的情况。\n- 取舍：pi 死循环空转吃 CPU 时，CPU 信号会一直变，卡住判定抓不到。这种情况靠总时长上限 `maxRoundMinutes` 兜底（当前部署配置 120 分钟，本 PR 不改）。所以真卡死最晚在 120 分钟被中止，而不是 30 分钟。\n- 进程树从宿主看（bwrap 用了 `--unshare-pid`，沙箱里的 pid 号不同，但宿主 `/proc` 能看到整棵树），不进沙箱取数。\n\n## 未执行的验证\n\n部署后真实轮次的长测试场景没跑过（本 PR 合并后要等无轮次时再部署）。部署后可看进度文件 `activitySource` 是否出现 `cpu`/`files`。\n\n## 风险与回滚\n\n- 每拍（默认 60 秒）多扫一次 `/proc` 和三个目录的一层，开销很小。\n- 回滚：revert 合并提交，无轮次在跑时 `git pull --ff-only` 部署。\n",
      "headRefName": "fix/stall-sandbox-activity",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-148",
    "source": "公开仓 vigil PR 148，2026-10-31T20:38:46Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #147。",
    "expect": [
      "ExampleUser/vigil#147"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 148,
      "title": "fix(acceptance): 内存门「这一拍不认领」那行带 UTC 时间和 mem-gate-defer 标记，便于统计推迟次数（#147）",
      "body": "任务 issue：ExampleUser/vigil#147\nCloses ExampleUser/vigil#147\n\n## 改了什么\n\n`state/host/rounds.log` 里内存门那行没有时间，没法数近 24 小时推迟了几次开轮。\n\n- `host/round.mjs`：内存门不够和读不到 MemAvailable 的两行，前面加 UTC ISO 时间和固定标记，格式跟 `loop.log` 的 `read-retry-ok` 一致：\n  `2026-10-31T20:00:00.000Z mem-gate-defer availKiB=2605152 内存门：MemAvailable 2667675648 字节 < 3221225472，这一拍不认领`\n  读不到时 `availKiB=unknown`。时间用 `runHostRound` 已有的 `now`。\n- `docs/acceptance-operations.md`：资源门一行补上统计方法。\n\n## 范围对照\n\n- 本 PR 改了：`watchers/acceptance/host/round.mjs`（只改两行日志文案）、`watchers/acceptance/mem-gate-log.test.mjs`（新增）、`docs/acceptance-operations.md`。\n- 超出 issue 范围：无\n- 明确不包含：内存门阈值和判定、退出码、写闸、prbot / 裁决的内存门、老日志回填。\n- 依赖：无\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 内存不够：行首 ISO 时间 + `mem-gate-defer availKiB=<KiB>`，原说明保留，退出 3 不认领。验证：unit | 通过 | `node --test watchers/acceptance/mem-gate-log.test.mjs`：改代码前 2 条全红，改完 2 条全绿（假时钟、断言没起写闸/预取/pi） |\n| SC2 读不到 MemAvailable：同样一行，`availKiB=unknown`。验证：unit | 通过 | 同上第 2 条 |\n| SC3 `npm test`、`check-sanitized` 全绿，CI 绿。验证：static | 通过 | 本机 `npm test < /dev/null` 退出码 0（837 / 668 / 677 条，0 失败，2 跳过）；`node scripts/check-sanitized.mjs` 未发现敏感内容；CI 见本 PR checks |\n\n## 定下的决定\n\n- 只写一处（rounds.log 原行加时间和标记），不在 loop.log 重复写。\n- 近 24 小时次数由盒子上的体检脚本按行首时间数，不在本仓加检查项。\n\n## 未执行的验证\n\n无。部署后等真遇到内存不够时看 rounds.log 新行。\n\n## 风险与回滚\n\n- 只动日志文案，无行为变化。回滚：revert 合并提交，`git pull --ff-only` 部署即可，不用重启循环。\n",
      "headRefName": "fix/mem-gate-timestamp",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-146",
    "source": "公开仓 vigil PR 146，2026-10-31T01:20:27Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 行是 owner/repo#144。同行括号里的 #145 是在说上一个 PR，不算。",
    "expect": [
      "ExampleUser/vigil#144"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 146,
      "title": "fix(acceptance): 读取超时重试成功时在 loop.log 留一行（类别、耗时），仍不写告警（#144 补充）",
      "body": "任务 issue：ExampleUser/vigil#144（#145 的补充）\n\n## 为什么补\n\n#145 合并后，负责人补了一条要求：重试成功不写告警，但要留日志，方便之后统计超时次数。\n\n## 改了什么\n\n- `host/tick.mjs`：新增 `logReadRetryOk`；`withReadTimeout` 多一个 `onRetryOk` 回调（只在只读读取第一次超时、重试成功时调）；拉取重试成功也调。\n- 留在 `state/host/loop.log`（和循环自己的输出同一个文件），一行固定格式：\n  `<UTC ISO 时间> read-retry-ok kind=<poll|prbot-read> totalMs=<两次合计毫秒> 读取超时已重试成功`\n  统计用 `grep -c read-retry-ok loop.log`。\n- `docs/acceptance-operations.md` 同步。\n\n## 不变的\n\n- 重试仍只限只读读取（只读 GraphQL、不带 `--input` 的 GET）和只读拉取；写、git 一律不重试，写闸不碰。\n- 杀进程组只针对 `proc.run` 自己 spawn 出来、带 `killGroup` 的那个新进程组（`process.kill(-child.pid)`），不碰别的进程。\n- 重试成功仍不写 `tick-failed` / `prbot-tick-failed`。\n\n## 未查到\n\n出口代理那一侧的日志在盒子上读不到，代理端怎么处理半死连接未查到。\n\n## 测试（先红后绿）\n\n- `read-retry.test.mjs` 新增 1 条：读重试成功调 `onRetryOk` 一次且带耗时；拉取 124 → 重试成功后 loop.log 有一行匹配上述格式，且没有 `tick-failed`。改代码前这一条红，改完 8 条全绿。\n- `npm test`：mivo 837 / cindy 668 / acceptance 673 过，0 失败；`node scripts/check-sanitized.mjs` 未发现敏感内容。\n",
      "headRefName": "fix/read-retry-log",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-145",
    "source": "公开仓 vigil PR 145，2026-10-31T01:15:50Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #144。",
    "expect": [
      "ExampleUser/vigil#144"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 145,
      "title": "fix(acceptance): 读 GitHub 挂住时整组杀掉不留孤儿、只读重试一次，重试成功不告警（#144）",
      "body": "任务 issue：ExampleUser/vigil#144\nCloses ExampleUser/vigil#144\n\n## 事故\n\n2026-10-30 13:24–17:57（太平洋时间）读 GitHub 超时 11 次（6 次修正轮读、5 次拉取），10 次紧挨平台快照恢复。快照恢复后已建立的连接半死：对端不回也不断，gh 没有读超时，只能等宿主超时。现场有一个孤儿 `gh api graphql --input -`：拉取超时只杀了 poll 的 node，它起的 gh 被收养后继续挂着。被掐掉的那次读直接丢了，这一拍白跑。\n\n## 改了什么\n\n- `host/proc.mjs`：`run()` 新增 `killGroup`（默认 false）。打开且设了 `timeoutMs` 时子进程起在新进程组（`detached`），超时对整组 SIGTERM、2 秒后 SIGKILL；组已不在时退回只杀直接子进程。其余调用点（写闸 git、bwrap、prefetch、probes、round 的 pi、后台进程）都不传，行为不变。\n- `host/tick.mjs`\n  - `withReadTimeout`：只读（只读 GraphQL、不带 `--input` 的 GET）每次带 `killGroup: true`；超时（124）后用新进程重试一次，重试前再调 `onRead` 刷新心跳阶段；重试也超时返回 124，stderr 末尾加「（已重试一次）」。\n  - 拉取：`POLL_TIMEOUT_MS = 60000`、`killGroup: true`；退出码 124 时重试一次，其余失败不重试；重试也失败才抛出（照旧写 `tick-failed`），文字注明「已重试一次」。\n  - `TICK_READ_TIMEOUT_MS` 120000 → 45000。\n- `host/poll-beat.mjs`、`docs/acceptance-operations.md`：注释和文档同步。\n\n## 超时怎么定的\n\n- 单次读：正常读不到 1 秒；挂住的是半死连接，等多久都不回，早掐早重试。45 秒仍有几十倍余量。总耗时 (45 + 5 兜底) × 2 = 100 秒 < 180 秒。\n- 拉取：poll 是整盘点，先量了实际耗时：2026-10-31 连跑 3 次共约 21 秒（单次约 7 秒）。没有盲目降到 45，定 60 秒（约 8 倍余量）。总耗时 (60 + 2 SIGKILL 宽限) × 2 = 124 秒 < 180 秒。\n- `github.mjs` 自己的读重试只认 502/503/504、连接重置等字样，124 的文字不含这些，不会再叠一层。\n- 心跳：拉取阶段两次合计最多约 124 秒，没超 180 秒；修正轮每次读（含重试）都重新起算阶段。\n\n## 写不改（重要）\n\n重试的只有读，读是幂等的，重试不会多写任何东西。写（mutation、POST/PATCH/PUT、带 `--input` 的 REST、经写闸的调用、git）不加超时、不重试：#115 的「写不重试」和 #137 认领后看板写的唯一一次重试都不受影响，也不冲突。写闸及其规则不动。\n\n## 告警降噪\n\n重试成功的读不进 `prbotError`、不写 `prbot-tick-failed` / `tick-failed`。只在重试也失败时写，文字带「已重试一次」。退出码 124 字样保留，所以体检脚本按「瞬时类」的判断不用改。\n\n## 测试（先写用例看它失败，再改代码）\n\n- 新增 `read-retry.test.mjs` 7 条：假命令 fork 出忽略 SIGTERM 的孙进程，超时后断言孙进程已死；读挂住→重试成功不算失败；重试仍挂住→124、注明已重试一次、只重试一次；写各只跑一次且不带超时；总耗时算式 < 180 秒；拉取 124→重试成功不写 `tick-failed`；重试仍失败只写一条、非超时失败不重试。改代码前跑是红的（缺 `POLL_TIMEOUT_MS` 导出，整个文件失败），改完 7 条全绿。原 T20 三条照旧通过。\n- `npm test`：mivo 837 / cindy 668 / acceptance 674（672 过、2 跳过）全部 0 失败；`node scripts/check-sanitized.mjs` 未发现敏感内容。\n\n## 不动的\n\n写闸及其规则、判定逻辑、验收范围、心跳上限 180 秒、`ensure.sh`。部署后常驻循环不用重启：每拍重新起 `node tick.mjs`。\n",
      "headRefName": "fix/read-retry-group-kill",
      "state": "merged"
    }
  },
  {
    "id": "vigil-pr-141",
    "source": "公开仓 vigil PR 141，2026-10-30T05:37:06Z 合并。取样时（2026-10-31）按 merged_at 计的最近 15 个已合并 PR 之一。用户名按仓库规则写成 ExampleUser。人工标注：任务 issue 与 Closes 都是 #140。正文其它仓的链接不算。",
    "expect": [
      "ExampleUser/vigil#140"
    ],
    "pr": {
      "repo": "ExampleUser/vigil",
      "number": 141,
      "title": "[子4/4] 验收机读批准执行的交接，等交接后再开轮",
      "body": "任务 issue：ExampleUser/vigil#140\nCloses ExampleUser/vigil#140\n\n## 改了什么\n\n验收机读得到「批准执行」lead 的交接评论，并且在 lead 交接之前不抢先开轮：总 issue 上有我发的「批准执行登记」，就等 lead 发了交接（首行 `[批准执行] 交接验收 · 第 n 次`）再验；子 issue 全关满 24 小时仍没交接，照常验，裁决里写明没有交接。交接里「## 请重点查」的每一条，验收会话都要在 `verdict.json` 的 `handoffChecks` 里给结论，裁决评论多一节「交接重点核对」逐条列出。交接只当线索，每条 SC 照样自己验。\n\n## 范围对照\n\n- 本 PR 改了：\n  - `watchers/acceptance/bin/tasks.mjs`：新增 `leadHandoffOf` / `handoffFocus`，任务记录带 `leadHandoff: {registeredAt, handoffAt}`\n  - `watchers/acceptance/bin/trigger.mjs`：新增 `awaiting-lead-handoff`（总 issue 与独立 issue 都适用）和 `LEAD_HANDOFF_WAIT_HOURS = 24`\n  - `watchers/acceptance/bin/collect.mjs`：输出 `handoff` 与 `root.approveExec`\n  - `watchers/acceptance/bin/verdict.mjs`：`handoffChecks` 覆盖校验（缺了退出码 1、零写入），裁决加「交接重点核对」一节与「没有交接评论」一行\n  - `watchers/acceptance/SESSION.md`、`docs/acceptance-session.md`、`watchers/acceptance/README.md`：交接的用法、裁决格式、盘点规则\n  - `watchers/acceptance/{trigger,tasks,collect,verdict,session-doc}.test.mjs`：新增用例\n  （都在 issue「范围」内）\n- 超出 issue 范围：无\n- 明确不包含：不改 `github-live` / `cindy-mac` 等层「不验、标人工手测」的规则：lead 的观测只作线索写进交接；不改 mivo / cindy 盯梢；不改宿主调度、写闸、看板写法；不读总 issue 50 条以前的评论：登记评论落在最近 50 条之外时按「不是批准执行推进的」处理（和现在一样直接验）。\n- 依赖：与 ExampleUser/approve-exec#79 并行开发，ExampleUser/approve-exec#79 先合（只是上线有先后：批准执行会发交接评论之后，验收机才等交接；反过来先合，批准执行发起的总 issue 会被白等 24 小时）。当前状态：ExampleUser/approve-exec#79 已合进 approve-exec main（PR #82，69fcc74）；本 PR 已同步 vigil main（e708757，和本 PR 改的文件无交集）。\n\n## 验收对照\n\n| 验收项 | 状态 | 证据 |\n|---|---|---|\n| SC1 总 issue 上有 ownerLogin 发的「批准执行登记：」评论、没有晚于最后一条登记的 ownerLogin「[批准执行] 交接验收」评论、子 issue 全部关闭不满 24 小时：`shouldTrigger` 返回 `trigger:false`、`reason:'awaiting-lead-handoff'`；有了交接评论后照常触发（`no-verdict`）。验证：unit（测试点：`shouldTrigger`、`collectTasks`） | 通过 | `node --env-file=watchers/acceptance/test.env --test watchers/acceptance/trigger.test.mjs` → 21/21 pass（「#140 SC1」含早于最后一条登记的交接不算、独立 issue 同样等）；`tasks.test.mjs` → 9/9 pass（「#140 SC1/SC3」盘点算出登记与交接时间）。变异：等待判定恒为 false 时 2 个用例失败 |\n| SC2 子 issue 全部关闭满 24 小时仍没有交接：`shouldTrigger` 照常返回 `trigger:true`；这一轮裁决评论多一行「批准执行没有交接评论，等满 24 小时后照常验收。」。验证：unit（测试点：`shouldTrigger`、`verdict` 渲染） | 通过 | `trigger.test.mjs`「#140 SC2」（满 24 小时 → no-verdict；等满后验过一轮、修正子 issue 再关时不再等）；`verdict.test.mjs` → 11/11 pass（「#140 SC2」有登记没交接时裁决带这一行，没登记时不带；「#140 反例（review-pr141）」交接早于最后一条登记时同样带这一行、不要求旧重点项） |\n| SC3 没有登记评论的总 issue 行为和现在一致；别人发的同样首行的评论不算登记、不算交接。验证：unit（测试点：现有 trigger / tasks / collect 测试全过，加别人发评论的用例） | 通过 | 本机全量 `node --env-file=watchers/acceptance/test.env --test watchers/acceptance/*.test.mjs`（同步 main 后）→ 667 tests，628 pass，22 fail；22 个失败与改动前 main 上的失败名单逐条相同（flock / bwrap / uptime / 沙箱遮罩，本机 macOS 环境限制，CI 在 ubuntu + bwrap 上跑），没有新增。新增用例：`tasks.test.mjs`、`collect.test.mjs`「#140 SC3」别人发的登记 / 交接不算 |\n| SC4 `collect` 输出 `handoff`：ownerLogin 发的最新一条交接评论的 `{url, createdAt, n, focus}`，`focus` 是「## 请重点查」下编号列表的每一条原文；没有交接时 `handoff` 为 `null`；`root.approveExec` 表示有没有登记评论。验证：unit（测试点：`collectTree`） | 通过 | `collect.test.mjs` → 11/11 pass（「#140 SC4」：取最新一条、别人发的第 9 次不算、缩进的补充行与其他小节的编号不进 `focus`；「#140 反例（review-pr141）」早于最后一条登记的交接输出 `null`、登记被挤出最近 50 条时 `approveExec` 为 false，和盘点一致）。变异：去掉过期过滤时 3 个用例失败 |\n| SC5 `handoff.focus` 非空时，`verdict` 要求 `verdict.json` 的 `handoffChecks` 按序号每条重点项一条结论，缺了退出码 1、什么都不写；裁决评论多一节「## 交接重点核对」逐条列出；`SESSION.md` 写明交接只当线索、每条 SC 照样自己验、lead 通过时的 head 之后新增的提交要重点查。验证：unit（测试点：`verdict`、`session-doc` 测试） | 通过 | `verdict.test.mjs`「#140 SC5」（缺第 2 条 → 退出码 1、`comment.update` 0 次；补齐后正文含整节）；`session-doc.test.mjs` → 13/13 pass（「#140 SC5」）。变异：去掉缺结论拒绝时该用例失败 |\n| SC6 目标仓测试与 CI 全绿（含 `check-sanitized`）。验证：static | 通过 | CI `test`（含 check-sanitized 通用规则）pass；本机把主目录未跟踪的 `config/sanitize-denylist-local` 临时链进 worktree 后跑 `node scripts/check-sanitized.mjs` → 未发现敏感内容（跑完删掉链接，私有词清单不进仓库）；e2e（真实 GitHub 只读，`_tmp` 下脚本）12/12 |\n\n## 定下的决定\n\n无（issue 没有待定问题）。\n\n## 未执行的验证\n\n- 真实一轮：验收机在 lead 交接评论之后才开第 1 轮、裁决里有「交接重点核对」，属于总 issue ExampleUser/approve-exec#76 SC2（github-live），下一次真实批准执行时验。\n- 云端验收机部署：本 PR 合入后要在云端验收机上停循环、`git pull --ff-only`、再起循环（`docs/acceptance-operations.md`「更新部署」），由用户操作。\n\n## 风险与回滚\n\n- 等交接最多拖 24 小时：批准执行推进的总 issue，lead 没发交接时验收晚 24 小时开始。这是 #140 定下的取舍。\n- 盘点只看最近 50 条评论：登记落在 50 条以外时按旧行为直接验，不会卡住。\n- 回滚：revert 本 PR 的合并提交，云端验收机重新部署。\n",
      "headRefName": "feat/lead-handoff",
      "state": "merged"
    }
  }
];
