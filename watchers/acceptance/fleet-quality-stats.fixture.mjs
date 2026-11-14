// C 专属夹具。结构按公开轮次评论 / issue events / alerts.jsonl / heartbeat / deploy-ff 建模。
// 仓库名与登录名一律占位符，不能外推舰队整体。
export const REPO = 'example-owner/example-repo';
export const BOT = 'example-bot[bot]';
export const USER = 'ExampleUser';
export const BODY_V1 = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
export const BODY_V2 = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

export function issueUrl(number) {
  return `https://github.com/${REPO}/issues/${number}`;
}

export function commentUrl(number, id) {
  return `${issueUrl(number)}#issuecomment-${id}`;
}

export function restAuthor(login, type) {
  return { login, type };
}

export function restComment({
  id,
  number = 62,
  round,
  status,
  bodyVersion = BODY_V1,
  startedAt,
  finishedAt,
  reason = null,
  items = '',
  login = BOT,
  type = 'Bot',
  created_at,
  updated_at,
}) {
  const lines = [`[验收机] 第 ${round} 轮：${status}`, `正文版本：${bodyVersion}`, `开始：${startedAt}`];
  if (finishedAt) lines.push(`完成：${finishedAt}`);
  if (status === '中断' && reason) lines.push(`原因：${reason}`);
  if (items) {
    lines.push('', '## 逐条结果', items.trim());
  }
  return {
    id,
    html_url: commentUrl(number, id),
    issue_url: `https://api.github.com/repos/${REPO}/issues/${number}`,
    user: restAuthor(login, type),
    created_at: created_at || '2026-11-14T13:43:29Z',
    updated_at: updated_at || finishedAt || created_at || '2026-11-14T13:43:29Z',
    body: lines.join('\n'),
  };
}

export function graphqlComment(rest) {
  const login = rest.user.login.endsWith('[bot]') ? rest.user.login.slice(0, -5) : rest.user.login;
  return {
    id: `IC_${rest.id}`,
    databaseId: rest.id,
    url: rest.html_url,
    body: rest.body,
    createdAt: rest.created_at,
    updatedAt: rest.updated_at,
    author: { login, __typename: rest.user.type },
  };
}

export function restEvent({ id, number = 62, event, created_at, login, type }) {
  return {
    id,
    event,
    created_at,
    actor: restAuthor(login, type),
    url: `${issueUrl(number)}#event-${id}`,
  };
}

export function prefetchReason() {
  return '代码预取失败：只用 App 模式拒绝改用账号令牌（no-app-route / no-owner，graphql）';
}

export function envReason() {
  return '环境问题（不是代码不通过）：必需检查因环境原因没跑：build、typecheck、测试。这一轮未验证，不判「通过」';
}

/** 第 16 轮通过评论的逐条结果：人工手测 + 已入库测试 + 一条临时副本补测试。 */
export const PASS_ITEMS = `
- 人工手测：${REPO}#62 SC1（github-live）
- 人工手测：${REPO}#62 SC2（github-live）
- 人工手测：${REPO}#62 SC3（github-live）
- 通过：${REPO}#443 SC1 · 证据：在可写副本跑 \`node --test watchers/acceptance/queue.test.mjs\`：11/11 通过。
- 通过：${REPO}#444 SC7 · 证据：在临时副本补 2 个 tick 用例；node --test 4/4 通过。
`.trim();

export function sample62Comments() {
  const comments = [];
  const starts = [
    ['2026-11-14T02:04:44+08:00', '2026-11-14T02:04:52+08:00'],
    ['2026-11-14T02:08:00+08:00', '2026-11-14T02:08:10+08:00'],
    ['2026-11-14T02:14:00+08:00', '2026-11-14T02:14:10+08:00'],
    ['2026-11-14T03:15:00+08:00', '2026-11-14T03:15:10+08:00'],
    ['2026-11-14T04:15:00+08:00', '2026-11-14T04:15:10+08:00'],
    ['2026-11-14T05:18:00+08:00', '2026-11-14T05:18:10+08:00'],
    ['2026-11-14T06:20:00+08:00', '2026-11-14T06:20:10+08:00'],
    ['2026-11-14T07:25:00+08:00', '2026-11-14T07:25:10+08:00'],
    ['2026-11-14T08:25:00+08:00', '2026-11-14T08:25:10+08:00'],
    ['2026-11-14T09:27:00+08:00', '2026-11-14T09:27:10+08:00'],
    ['2026-11-14T10:37:00+08:00', '2026-11-14T10:37:10+08:00'],
    ['2026-11-14T12:11:00+08:00', '2026-11-14T12:11:10+08:00'],
    ['2026-11-14T13:22:00+08:00', '2026-11-14T13:22:10+08:00'],
    ['2026-11-14T14:27:00+08:00', '2026-11-14T14:27:10+08:00'],
  ];
  starts.forEach(([startedAt, finishedAt], i) => {
    comments.push(
      restComment({
        id: 1000 + i + 1,
        round: i + 1,
        status: '中断',
        startedAt,
        finishedAt,
        reason: prefetchReason(),
        created_at: new Date(Date.parse(startedAt)).toISOString(),
        updated_at: new Date(Date.parse(finishedAt)).toISOString(),
      }),
    );
  });
  comments.push(
    restComment({
      id: 1015,
      round: 15,
      status: '中断',
      startedAt: '2026-11-14T15:34:47+08:00',
      finishedAt: '2026-11-14T15:41:51+08:00',
      reason: envReason(),
      created_at: '2026-11-14T07:34:57Z',
      updated_at: '2026-11-14T07:41:53Z',
    }),
  );
  comments.push(
    restComment({
      id: 1016,
      round: 16,
      status: '通过',
      bodyVersion: BODY_V2,
      startedAt: '2026-11-14T21:43:25+08:00',
      finishedAt: '2026-11-14T21:55:14+08:00',
      items: PASS_ITEMS,
      created_at: '2026-11-14T13:43:29Z',
      updated_at: '2026-11-14T13:55:16Z',
    }),
  );
  return comments;
}

export function sample62Issue() {
  return {
    number: 62,
    html_url: issueUrl(62),
    state: 'closed',
    body: ['## 验收标准', `- [ ] SC1 看板 验证：github-live 人工手测`, `- [ ] SC2 手动值 验证：github-live 人工手测`, `- [ ] SC3 提醒 验证：github-live 人工手测`].join('\n'),
    closed_at: '2026-11-14T13:55:07Z',
    closed_by: restAuthor(BOT, 'Bot'),
    labeledSample: true,
    pullRequests: [
      { ref: `${REPO}#443`, url: `https://github.com/${REPO}/pull/443`, mergedAt: '2026-11-13T18:00:49Z' },
      { ref: `${REPO}#444`, url: `https://github.com/${REPO}/pull/444`, mergedAt: '2026-11-13T18:02:01Z' },
    ],
  };
}

export function sample62Events() {
  return [
    restEvent({
      id: 9001,
      event: 'closed',
      created_at: '2026-11-14T13:55:07Z',
      login: BOT,
      type: 'Bot',
    }),
  ];
}

/**
 * 公开 GET /repos/PraiseZhu/vigil/issues/62/events 的 closed 事件原文。
 * url 是 /issues/events/{id}，没有 issue 号。测试里不得改这些字段；
 * 反例只改 event=reopened。
 */
export const REAL_ISSUE_62_CLOSED_EVENT = {
  actor: {
    avatar_url: 'https://avatars.githubusercontent.com/in/5405636?v=4',
    events_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/events{/privacy}',
    followers_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/followers',
    following_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/following{/other_user}',
    gists_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/gists{/gist_id}',
    gravatar_id: '',
    html_url: 'https://github.com/apps/praiseautomation',
    id: 345634207,
    login: 'praiseautomation[bot]',
    node_id: 'BOT_kgDOFJn1nw',
    organizations_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/orgs',
    received_events_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/received_events',
    repos_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/repos',
    site_admin: false,
    starred_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/starred{/owner}{/repo}',
    subscriptions_url: 'https://api.github.com/users/praiseautomation%5Bbot%5D/subscriptions',
    type: 'Bot',
    url: 'https://api.github.com/users/praiseautomation%5Bbot%5D',
    user_view_type: 'public',
  },
  commit_id: null,
  commit_url: null,
  created_at: '2026-11-14T13:55:07Z',
  event: 'closed',
  id: 36126959257,
  intent: null,
  node_id: 'CE_lADOU38phs8AAAABZrUzX88AAAAIaVWmmQ',
  performed_via_github_app: null,
  state_reason: null,
  url: 'https://api.github.com/repos/PraiseZhu/vigil/issues/events/36126959257',
};

export function realIssue62ReopenedCounterexample() {
  return { ...REAL_ISSUE_62_CLOSED_EVENT, event: 'reopened' };
}

/** 仓库级 /issues/events 带嵌套 issue；html_url 用占位仓库以对接夹具评论。 */
export function repoLevelClosedEventFor62() {
  return {
    ...REAL_ISSUE_62_CLOSED_EVENT,
    issue: {
      number: 62,
      html_url: issueUrl(62),
      url: `https://api.github.com/repos/${REPO}/issues/62`,
    },
  };
}

/** #62 真实 timeline：closedByPullRequestsReferences 为空，CrossReferencedEvent 有 PR446/447 mergedAt。 */
export function realIssue62TimelineCrossReferencedPrs() {
  return [
    {
      __typename: 'CrossReferencedEvent',
      createdAt: '2026-11-13T01:31:08Z',
      source: {
        __typename: 'PullRequest',
        number: 446,
        url: `https://github.com/${REPO}/pull/446`,
        mergedAt: '2026-11-13T18:00:49Z',
        repository: { nameWithOwner: REPO },
      },
    },
    {
      __typename: 'CrossReferencedEvent',
      createdAt: '2026-11-13T01:31:10Z',
      source: {
        __typename: 'PullRequest',
        number: 447,
        url: `https://github.com/${REPO}/pull/447`,
        mergedAt: '2026-11-13T18:02:01Z',
        repository: { nameWithOwner: REPO },
      },
    },
  ];
}

export const ISSUE62_READY_AT_MS = Date.parse('2026-11-13T18:02:01Z');
export const ISSUE62_FIRST_FINAL_AT_MS = Date.parse('2026-11-14T21:55:14+08:00');
export const ISSUE62_DELIVERY_MINUTES = (ISSUE62_FIRST_FINAL_AT_MS - ISSUE62_READY_AT_MS) / 60000;

export function sampleSnapshot(extra = {}) {
  return {
    labeledSample: true,
    comments: sample62Comments(),
    issues: [sample62Issue()],
    events: sample62Events(),
    ...extra,
  };
}

export function cleanPassItems() {
  return `
- 通过：${REPO}#80 SC1 · 证据：node --test foo.test.mjs 退出码 0。
- 通过：${REPO}#80 SC2 · 证据：在可写副本跑已入库测试 3/3。
`.trim();
}

export function emptyEvidenceItems() {
  return `- 通过：${REPO}#81 SC1`;
}

export function alertLine({ ts, kind, issue = `${REPO}#62`, head = 'abc', reason = 'x' }) {
  return { ts, kind, issue, head, target: head, reason };
}

export function legacyDeployState() {
  return { lagReportedFor: null, alerted: ['deadbeef|cafebabe|deploy-needs-approval'] };
}

export function bDeployRow({
  ts,
  result = 'deployed',
  fromSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  toSha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  sensitiveFiles = ['watchers/acceptance/host/round.mjs'],
  authorization = null,
}) {
  return { ts, result, fromSha, toSha, commits: [toSha], sensitiveFiles, authorization };
}

export function userAuth(toSha) {
  return {
    source: 'comment',
    repo: REPO,
    ref: `${REPO}#1`,
    commentUrl: commentUrl(1, 1),
    authorLogin: USER,
    authorType: 'User',
    commentCreatedAt: '2026-11-13T00:00:00Z',
    sha: toSha,
  };
}

export function botAuth(toSha) {
  return { ...userAuth(toSha), authorLogin: BOT, authorType: 'Bot' };
}
