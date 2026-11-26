export const HEAD = 'a'.repeat(40);
export const NEXT = 'b'.repeat(40);
export const BASE = 'c'.repeat(40);
export const REPO = 'example-org/example-repo';
export const OUTSIDE = 'example-org/outside-repo';
export const EXCLUDED = 'example-org/ignored-repo';
export const USER = { login: 'ExampleUser', type: 'User' };
export const APP = { login: 'example-qa[bot]', type: 'Bot' };
export const REVIEWER = { login: 'example-reviewer[bot]', __typename: 'Bot' };
export const connection = (nodes) => ({ nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false } });

export function row(number, { repo = REPO, author = USER, draft = false, state = 'open' } = {}) {
  return { repo, number, author, draft, state };
}

export const discoveryRows = [
  row(1), row(2, { author: APP }), row(4, { author: { login: 'OtherUser', type: 'User' } }), row(5, { draft: true }),
];
export const searchRows = [row(1), row(3, { repo: OUTSIDE }), row(6, { repo: EXCLUDED })];

export function check(name, conclusion, { required = true, summary, status = 'COMPLETED', appId = 1 } = {}) {
  return { __typename: 'CheckRun', name, status, conclusion, summary, isRequired: required, checkSuite: { app: { databaseId: appId } } };
}

export function thread(body, { author = REVIEWER, outdated = true, resolved = false } = {}) {
  return { id: 'example-thread', isResolved: resolved, isOutdated: outdated,
    comments: connection([{ id: 'example-comment', databaseId: 1, body, author }]) };
}

export function pull(number = 1, { head = HEAD, checks = [], threads = [], ...fields } = {}) {
  return {
    number, author: USER, state: 'OPEN', isDraft: false,
    headRefOid: head, baseRefOid: BASE, baseRefName: 'main',
    baseRef: { refUpdateRule: null }, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', reviewDecision: null,
    commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: connection(checks) } } }] },
    reviewThreads: connection(threads),
    ...fields,
  };
}

export function fixtureClient({ listed = [row(1)], searched = [], get = (repo, number) => pull(number), rules = [] } = {}) {
  const calls = [];
  function record(name, operation) {
    return async (...args) => { calls.push(name); return operation(...args); };
  }
  return {
    calls,
    listOpenPulls: record('listOpenPulls', () => listed),
    searchOpenPulls: record('searchOpenPulls', (author) => author.startsWith('app/') ? [] : searched),
    getPull: record('getPull', get),
    listBranchRules: record('listBranchRules', () => rules),
    listAlerts: record('listAlerts', () => []),
    listAlertInstances: record('listAlertInstances', () => []),
    replyToThread: record('replyToThread', () => { throw new Error('unexpected write'); }),
    resolveThread: record('resolveThread', () => { throw new Error('unexpected write'); }),
    rerunJob: record('rerunJob', () => { throw new Error('unexpected write'); }),
  };
}
