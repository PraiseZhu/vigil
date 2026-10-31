// 「关联 PR」纯函数的夹具。
//
// 来源（2026-10-31，只读公开仓 vigil 的 PR 标题、headRefName、正文里的关联行）：
// 仓库里没有看板那 16 条「Linked pull requests」的导出，这里不用那份数据。
// 下面 16 条是公开 PR 关联行的形状：owner 一律写成 ExampleUser（本仓测试夹具不写真实用户名），
// 正文只留关联行，不贴全文——全文里还会提到别的 issue / PR 号，那些不在这 16 条里。
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
    source: '公开仓 vigil PR 151 的标题。正文和分支清空，只留标题里的 #149。',
    pr: vigilPr({
      number: 151,
      title: 'fix(acceptance): 卡住判定加沙箱活动信号，长时间跑测试不再误判卡住（#149）',
      body: '',
      headRefName: 'fix/stall-sandbox-activity',
    }),
    refs: [`${VIGIL}#149`],
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
    source: '构造。抽查的公开 vigil PR 用 owner/repo#n，没有把完整 issue 链接当作唯一信号。按关联规则补这一条，不是真实 PR。',
    pr: {
      repo: OTHER,
      number: 301,
      title: 'link',
      body: `详见 https://github.com/${VIGIL}/issues/89 。\n`,
      headRefName: 'feature/docs',
      state: 'open',
      ci: 'pass',
    },
    refs: [`${VIGIL}#89`],
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

/** 同号不同仓：裸 #n 和 acceptance/ 分支只落在 PR 自己的仓；Refs 和完整链接落在写明的仓。 */
export const crossRepo = {
  source: '构造的同号不同仓样例。裸 #n、acceptance/ 分支只算 PR 自己的仓；Refs 和完整 issue 链接算写明的那个仓。不是看板导出。',
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
      body: `see https://github.com/${VIGIL}/pull/8\nhttps://github.com/${OTHER}/issues/10\n`,
      headRefName: 'feature/y',
      state: 'merged',
      ci: 'pass',
    },
  ],
  expect: {
    [`${VIGIL}#10`]: '#9(merged)',
    // 7：标题裸 #10，分支 acceptance/10-10-sc1（sc 的 1 不是 issue）。8：Refs。9：完整 issue 链接。pull 链接不算。
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
        title: '#1',
        body: '',
        headRefName: 'feature/y',
        state: 'merged',
        ci: 'pass',
      },
      {
        repo: VIGIL,
        number: 123,
        title: '#1',
        body: '',
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
        title: '#1',
        body: '',
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
        title: '#1',
        body: '',
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
        title: '#1',
        body: '',
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
