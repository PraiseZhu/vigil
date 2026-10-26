// #46 测试用的假 GitHub：内存里的 issue/评论/看板，注入给 runHelper 用。
// 不起子进程、不触网；写操作和真实现一样只经 github.write(action)。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bodyVersion } from './bin/rounds.mjs';
import { OWNER, OTHER_REPO, REPO, roundComment } from './fake-gh.fixture.mjs';

export { OWNER, OTHER_REPO, REPO };
export const FORK_REPO = 'makecindy/cindy';
export const CLOCK = '2026-10-24T02:00:00.000Z';
/** CLOCK 的北京时间写法（#43 决策：轮次评论、裁决里的时间一律写北京时间，带 +08:00）。 */
export const CLOCK_BEIJING = '2026-10-24T10:00:00+08:00';
export const ACCEPTANCE_OPTIONS = ['验收中', '要修', '修正中', '通过'];

export const DEFAULT_ROOT_BODY = [
  '# 总任务',
  '',
  '- [ ] SC1 收齐任务树 验证：contract（测试点：断言 collect 输出）',
  '- [ ] SC2 写清验法，没写「验证：」的条目也要收',
].join('\n');

export const DEFAULT_CHILD_BODY = [
  '# 子任务',
  '',
  '- [ ] SC3 把结果写进轮次评论 验证：unit（测试点：假 gh）',
  '- [x] SC4 看板写验收 验证：contract',
  '- [ ] SC5 在真机上点一遍 验证：cindy-mac（测试点：人工看）',
].join('\n');

export const DEFAULT_OTHER_BODY = [
  '# 跨仓子任务',
  '',
  '- [ ] SC7 跨仓也要收 验证：browser-fixture（测试点：夹具跨仓）',
  '- [ ] SC8 真仓里跑一次 验证：github-live',
].join('\n');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createWorld({ now = () => Date.parse(CLOCK) } = {}) {
  const issues = new Map();
  const sequence = new Map();
  const writes = [];
  const itemToRef = new Map();
  let nextCommentId = 5000;
  let nextItemId = 1;

  const stamp = () => new Date(now()).toISOString();

  function refOf(repo, number) {
    return `${repo}#${number}`;
  }

  function nextNumberFor(repo) {
    const current = sequence.get(repo) || 0;
    const next = current + 1;
    sequence.set(repo, next);
    return next;
  }

  function get(ref) {
    return issues.get(ref);
  }

  function requireIssue(ref) {
    const found = issues.get(ref);
    if (!found) throw new Error(`假 GitHub 里没有 ${ref}`);
    return found;
  }

  function addIssue({
    repo = REPO,
    number,
    title = 'task',
    body = '',
    state = 'open',
    author = OWNER,
    createdAt = '2026-02-01T00:00:00.000Z',
    closedAt = null,
    prs = [],
    parent = null,
  } = {}) {
    const num = number ?? nextNumberFor(repo);
    if (num > (sequence.get(repo) || 0)) sequence.set(repo, num);
    const ref = refOf(repo, num);
    const issue = {
      ref,
      repo,
      number: num,
      title,
      body,
      state,
      author,
      createdAt,
      closedAt,
      url: `https://github.com/${repo}/issues/${num}`,
      id: `I_${repo.replace('/', '_')}_${num}`,
      comments: [],
      subIssues: [],
      prs: prs.map((pr) => ({ repository: { nameWithOwner: repo }, ...pr })),
      parent,
      project: {},
    };
    issues.set(ref, issue);
    return issue;
  }

  function addComment(ref, spec = {}) {
    const issue = requireIssue(ref);
    const databaseId = spec.databaseId ?? (nextCommentId += 1);
    const createdAt = spec.createdAt || stamp();
    const login = typeof spec.author === 'string' ? spec.author : spec.author?.login || OWNER;
    const comment = {
      id: spec.id || `IC_${databaseId}`,
      databaseId,
      body: spec.body || '',
      createdAt,
      updatedAt: spec.updatedAt || createdAt,
      url: spec.url || `https://github.com/${issue.repo}/issues/${issue.number}#issuecomment-${databaseId}`,
      author: { login },
    };
    issue.comments.push(comment);
    return comment;
  }

  function addChild(rootRef, childRef) {
    const root = requireIssue(rootRef);
    const child = requireIssue(childRef);
    root.subIssues.push(child.ref);
    child.parent = root.ref;
    return child;
  }

  function commentNode(comment) {
    return {
      id: comment.id,
      databaseId: comment.databaseId,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      url: comment.url,
      author: { login: comment.author.login },
    };
  }

  function issueNode(issue, { withComments = true, withPrs = true } = {}) {
    const node = {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state === 'closed' ? 'CLOSED' : 'OPEN',
      url: issue.url,
      author: { login: issue.author },
      repository: { nameWithOwner: issue.repo },
    };
    if (withComments) node.comments = { nodes: issue.comments.map(commentNode) };
    if (withPrs) node.closedByPullRequestsReferences = { nodes: clone(issue.prs) };
    return node;
  }

  function subIssueNode(issue) {
    return {
      ...issueNode(issue),
      comments: { nodes: issue.comments.map(commentNode) },
      closedByPullRequestsReferences: { nodes: clone(issue.prs) },
    };
  }

  function rootData(variables) {
    const issue = issues.get(refOf(`${variables.owner}/${variables.name}`, Number(variables.number)));
    if (!issue) return { repository: { issue: null } };
    return {
      repository: {
        issue: {
          ...issueNode(issue),
          subIssues: { nodes: issue.subIssues.map((ref) => subIssueNode(requireIssue(ref))) },
        },
      },
    };
  }

  function searchData(variables) {
    const query = String(variables.q || '');
    const marker = /修正 · 总 ([^\s"·]+#\d+)/.exec(query);
    const repoFilter = /repo:([^\s"]+)/.exec(query);
    if (!marker) return { search: { nodes: [] } };
    const nodes = [];
    for (const issue of issues.values()) {
      if (repoFilter && issue.repo !== repoFilter[1]) continue;
      if (!String(issue.body || '').includes(`[验收机] 修正 · 总 ${marker[1]}`)) continue;
      nodes.push({ __typename: 'Issue', ...subIssueNode(issue) });
    }
    return { search: { nodes } };
  }

  function projectData(variables) {
    const issue = issues.get(refOf(`${variables.owner}/${variables.name}`, Number(variables.issue)));
    return {
      user: {
        projectV2: {
          id: 'PVT_1',
          fields: {
            nodes: [
              {
                __typename: 'ProjectV2SingleSelectField',
                id: 'F_acceptance',
                name: '验收',
                dataType: 'SINGLE_SELECT',
                options: ACCEPTANCE_OPTIONS.map((name) => ({ id: `O_${name}`, name })),
              },
              { __typename: 'ProjectV2Field', id: 'F_verdict', name: '裁决', dataType: 'TEXT' },
            ],
          },
        },
      },
      repository: {
        issue: { id: issue ? issue.id : null, projectItems: { nodes: [] } },
      },
    };
  }

  function addProjectItem(variables) {
    const ref = [...issues.values()].find((issue) => issue.id === variables.contentId)?.ref;
    const itemId = ref ? `PVTI_${nextItemId += 1}_${ref}` : `PVTI_${nextItemId += 1}`;
    if (ref) itemToRef.set(itemId, ref);
    return { addProjectV2ItemById: { item: { id: itemId } } };
  }

  function setProjectField(variables) {
    const ref = itemToRef.get(variables.itemId);
    const issue = ref ? issues.get(ref) : null;
    if (issue) {
      if (variables.optionId) {
        const option = ACCEPTANCE_OPTIONS.find((name) => `O_${name}` === variables.optionId);
        if (option) issue.project['验收'] = option;
      }
      if (variables.text !== undefined && variables.text !== null) issue.project['裁决'] = variables.text;
    }
    return { updateProjectV2ItemFieldValue: { projectV2Item: { id: variables.itemId } } };
  }

  function graphql(payload = {}) {
    const query = String(payload.query || '');
    const variables = payload.variables || {};
    if (query.includes('search(')) return searchData(variables);
    if (query.includes('subIssues(')) return rootData(variables);
    if (query.includes('projectV2(')) return projectData(variables);
    if (query.includes('addProjectV2ItemById')) return addProjectItem(variables);
    if (query.includes('updateProjectV2ItemFieldValue')) return setProjectField(variables);
    const ref = refOf(`${variables.owner}/${variables.name}`, Number(variables.number));
    const issue = issues.get(ref);
    if (!issue) return { repository: { issue: null } };
    if (query.includes('comments(last: 100)')) {
      return { repository: { issue: { ...issueNode(issue), comments: { nodes: issue.comments.map(commentNode) } } } };
    }
    return { repository: { issue: issueNode(issue, { withComments: false, withPrs: false }) } };
  }

  function findComment(commentId) {
    for (const issue of issues.values()) {
      const found = issue.comments.find((comment) => comment.databaseId === commentId);
      if (found) return { issue, comment: found };
    }
    return null;
  }

  function write(action) {
    writes.push(action);
    switch (action.type) {
      case 'comment.create': {
        const issue = requireIssue(refOf(action.repo, Number(action.issue)));
        const comment = addComment(issue.ref, { body: action.body });
        return { commentId: comment.databaseId, url: comment.url };
      }
      case 'comment.update': {
        const found = findComment(action.commentId);
        if (!found) throw new Error(`假 GitHub 里没有评论 ${action.commentId}`);
        found.comment.body = action.body;
        found.comment.updatedAt = stamp();
        return { commentId: found.comment.databaseId, url: found.comment.url };
      }
      case 'issue.create': {
        const issue = addIssue({
          repo: action.repo,
          title: action.title,
          body: action.body,
          createdAt: stamp(),
        });
        return { issue: issue.number, url: issue.url, id: issue.id };
      }
      case 'issue.edit': {
        const issue = requireIssue(refOf(action.repo, Number(action.issue)));
        issue.body = action.body;
        return { issue: issue.number, url: issue.url };
      }
      case 'issue.close': {
        const issue = requireIssue(refOf(action.repo, Number(action.issue)));
        issue.state = 'closed';
        issue.closedAt = stamp();
        return { issue: issue.number, url: issue.url };
      }
      case 'issue.reopen': {
        const issue = requireIssue(refOf(action.repo, Number(action.issue)));
        issue.state = 'open';
        issue.closedAt = null;
        return { issue: issue.number, url: issue.url };
      }
      case 'subissue.add': {
        const child = requireIssue(refOf(action.subRepo, Number(action.subIssue)));
        const root = requireIssue(refOf(action.repo, Number(action.issue)));
        if (!root.subIssues.includes(child.ref)) root.subIssues.push(child.ref);
        child.parent = root.ref;
        return { issue: root.number, subIssue: child.number };
      }
      case 'project.field.set': {
        const issue = requireIssue(refOf(action.repo, Number(action.issue)));
        for (const [name, value] of Object.entries(action.fields || {})) issue.project[name] = value;
        return { itemId: `PVTI_${issue.ref}` };
      }
      case 'branch.push':
        return { repo: action.repo, branch: action.branch };
      default:
        throw new Error(`假 GitHub 不认识的写操作：${action.type}`);
    }
  }

  return {
    issues,
    writes,
    now,
    stamp,
    get,
    requireIssue,
    addIssue,
    addComment,
    addChild,
    graphql,
    write,
    refOf,
  };
}

/** 假 github 对象：直接注入 runHelper，写操作全记在 world.writes 里。 */
export function createFakeGithub(world, { onWrite } = {}) {
  const github = {
    async graphql(query, variables) {
      return world.graphql({ query, variables });
    },
    async write(action) {
      if (onWrite) {
        const override = await onWrite(action, world);
        if (override !== undefined) return override;
      }
      return world.write(action);
    },
  };
  return github;
}

/** 常用的三仓任务树：总 issue（parent）+ 同仓子 issue + 跨仓子 issue，带一条「验收中」轮次评论。 */
export function defaultTree({
  rootBody = DEFAULT_ROOT_BODY,
  childBody = DEFAULT_CHILD_BODY,
  otherBody = DEFAULT_OTHER_BODY,
  roundStatus = '验收中',
  roundNumber = 1,
  rootRepo = REPO,
  roundCommentUrl,
  now,
} = {}) {
  const world = createWorld({ now });
  const root = world.addIssue({
    repo: rootRepo,
    number: 1,
    title: '总任务',
    body: rootBody,
    prs: [{ number: 12, url: `https://github.com/${rootRepo}/pull/12`, mergedAt: '2026-10-20T00:00:00.000Z' }],
  });
  const child = world.addIssue({ repo: rootRepo, number: 2, title: '子任务', body: childBody });
  const other = world.addIssue({ repo: OTHER_REPO, number: 7, title: '跨仓子任务', body: otherBody });
  world.addChild(root.ref, child.ref);
  world.addChild(root.ref, other.ref);
  world.addComment(root.ref, {
    ...roundComment({ round: roundNumber, status: roundStatus, bodyVersion: bodyVersion(rootBody) }),
    url: roundCommentUrl || `https://github.com/${rootRepo}/issues/1#issuecomment-1001`,
  });
  return world;
}

/** 写一份临时 JSON，返回路径（裁决文件、已验证清单都用它）。 */
export function writeJsonFile(dir, name, data) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** defaultTree 里每条 SC（总 issue SC1/SC2、子 issue SC3–SC5、跨仓子 issue SC7/SC8）。 */
export const DEFAULT_SCS = Object.freeze([
  [REPO, 1, 1],
  [REPO, 1, 2],
  [REPO, 2, 3],
  [REPO, 2, 4],
  [REPO, 2, 5],
  [OTHER_REPO, 7, 7],
  [OTHER_REPO, 7, 8],
]);

/**
 * 覆盖 defaultTree 全部 SC 的裁决条目：verdict 要求任务树里每条 SC 都有结论。
 * `overrides` 按 `owner/repo#n SC<k>` 换掉某几条（比如某条要修）；没列的默认「通过」。
 */
export function fullConclusions(overrides = {}, { scs = DEFAULT_SCS, rootRepo = REPO } = {}) {
  return scs.map(([repo, number, sc]) => {
    const actualRepo = repo === REPO ? rootRepo : repo;
    const ref = `${actualRepo}#${number}`;
    const key = `${ref} SC${sc}`;
    return { ref, sc, result: '通过', evidence: 'ok', ...(overrides[key] || {}) };
  });
}

/** 判「通过」要带的必需检查（裁决防线）：三项都真跑了。 */
export const ALL_RAN = Object.freeze({ build: 'ran', typecheck: 'ran', test: 'ran' });
/** board --acceptance 通过 的 --checks 文件（三项都 ran）。 */
export const ALL_RAN_CHECKS_FILE = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-checks-'));
  return writeJsonFile(dir, 'checks.json', { checks: ALL_RAN });
})();
