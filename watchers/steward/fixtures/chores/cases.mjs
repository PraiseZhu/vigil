import { check, connection, pull, REPO, REVIEWER, row, thread, USER } from '../pulls.mjs';

export const PR = `${REPO}#1`;
export const REPLY = 'P3: deferred';

export function discussion(body, id = 'PRRT_example') {
  return { ...thread(body), id };
}

export function addComment(thread, id, body, author = USER) {
  thread.comments = connection([...thread.comments.nodes, { id: `comment-${id}`, databaseId: id, body, author }]);
}

export function actionsCheck(name, conclusion, id, { run = 10, required = true, summary } = {}) {
  return { ...check(name, conclusion, { required, summary, appId: 15368 }), databaseId: id + 10_000,
    detailsUrl: `https://github.com/${REPO}/actions/runs/${run}/job/${id}` };
}

export function githubFixture(options = {}) {
  const calls = [];
  const threads = options.threads ?? [];
  let nextId = 5;
  const app = {
    listOpenPulls: async () => [row(1)],
    listBranchRules: async () => [],
    getPull: async () => structuredClone(pull(1, { ...options, threads })),
    resolveThread: async (id) => { calls.push(['app.resolve', id]); },
    rerunJob: async (repo, id) => { calls.push(['app.rerun', repo, id]); },
  };
  const follower = {
    viewer: async () => USER,
    replyToThread: async (repo, number, rootId, body) => {
      calls.push(['follower.reply', repo, number, rootId, body]);
      const id = nextId++;
      addComment(threads[0], id, body);
      return { id };
    },
  };
  return { app, calls, follower };
}

export function reviewed(body, reply, author = REVIEWER) {
  const item = discussion(body);
  addComment(item, 2, reply, author);
  return item;
}
