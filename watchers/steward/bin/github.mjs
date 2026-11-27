import { spawnSync } from 'node:child_process';
import { sign } from 'node:crypto';
import fs from 'node:fs';
import { appForRepo, REPO } from './profile.mjs';

const HOST = 'github.com';
const URL_ROOT = 'https://api.github.com';
const TIMEOUT = 30_000;
const PULL_QUERY = `query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      number state isDraft author { login __typename }
      headRefOid headRefName isCrossRepository baseRefName baseRefOid mergeable mergeStateStatus reviewDecision
      autoMergeRequest { enabledAt } isInMergeQueue
      baseRef { refUpdateRule { requiredStatusCheckContexts requiresConversationResolution } }
      commits(last:1) { nodes { commit { oid statusCheckRollup {
        contexts(first:100) { totalCount pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun {
            databaseId name status conclusion startedAt detailsUrl title summary text isRequired(pullRequestNumber:$number)
            checkSuite { app { databaseId slug } }
            annotations(first:50) { totalCount pageInfo { hasNextPage } nodes { annotationLevel message } }
          }
          ... on StatusContext { context state description targetUrl isRequired(pullRequestNumber:$number) }
        } }
      } } } }
      reviewThreads(first:100) { totalCount pageInfo { hasNextPage } nodes {
        id isResolved isOutdated path line
        comments(first:100) { totalCount pageInfo { hasNextPage } nodes {
          id databaseId body createdAt author { login __typename }
        } }
      } }
    }
  }
}`;

function repoPath(repo) {
  if (typeof repo !== 'string' || !REPO.test(repo)) throw new Error('invalid GitHub repo');
  return `repos/${repo}`;
}

function positive(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('invalid GitHub numeric id');
  return value;
}

function asPages(pages, method) {
  if (!Array.isArray(pages) || pages.length === 0 || !pages.every(Array.isArray)) {
    throw new Error(`${method}: invalid or incomplete pages`);
  }
  return pages.flat();
}

function pullRow(data, repo) {
  return { repo, number: data.number, state: data.state, draft: data.draft, author: data.user };
}

function jwt(config) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 30, exp: now + 540, iss: config.appId })}`;
  const signature = sign('RSA-SHA256', Buffer.from(unsigned), fs.readFileSync(config.privateKeyFile));
  return `${unsigned}.${signature.toString('base64url')}`;
}

export function createGithubClient(config, { env = process.env, run = spawnSync, fetchFn = fetch } = {}) {
  const calls = [];
  const tokens = new Map();

  async function appToken(app) {
    const installation = tokens.get(app);
    if (installation && Date.parse(installation.expires_at) > Date.now() + 60_000) return installation.token;
    calls.push('authenticateApp');
    try {
      const response = await fetchFn(`${URL_ROOT}/app/installations/${app.installationId}/access_tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt(app)}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const current = await response.json();
      if (typeof current.token !== 'string' || !current.token
        || !(Date.parse(current.expires_at) > Date.now())) throw new Error('invalid installation response');
      tokens.set(app, current);
      return current.token;
    } catch (error) {
      const status = /^HTTP \d{3}$/.test(error.message) ? ` (${error.message})` : '';
      throw new Error(`authenticateApp: installation authentication failed${status}`);
    }
  }

  async function api(method, endpoint, { repo, paginate = false, body, verb = 'GET', appOnly = false } = {}) {
    calls.push(method);
    const childEnv = { ...env, GH_PROMPT_DISABLED: '1' };
    const app = appForRepo(config, repo);
    if (appOnly && config.mode === 'by-owner' && !app) {
      throw new Error(`${method}: repository has no GitHub App installation`);
    }
    if (app) childEnv.GH_TOKEN = await appToken(app);
    const args = ['api', endpoint, '--hostname', HOST, '--method', verb];
    if (paginate) args.push('--paginate', '--slurp');
    if (body) args.push('--input', '-');
    const result = run('gh', args, {
      env: childEnv,
      input: body && JSON.stringify(body),
      encoding: 'utf8',
      timeout: TIMEOUT,
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const status = /\(HTTP (\d{3})\)/.exec(result.stderr ?? '')?.[1];
      const error = new Error(`${method}: GitHub request failed${status ? ` (HTTP ${status})` : result.error?.code ? ` (${result.error.code})` : ''}`);
      if (status === '422' && /expected head sha/i.test(`${result.stderr ?? ''}\n${result.stdout ?? ''}`)) error.code = 'HEAD_CHANGED';
      throw error;
    }
    if (!result.stdout?.trim() && ['POST', 'PATCH', 'PUT'].includes(verb) && endpoint !== 'graphql') return null;
    let data;
    try { data = JSON.parse(result.stdout); }
    catch { throw new Error(`${method}: invalid GitHub response`); }
    if (endpoint === 'graphql' && (data?.errors?.length || !data?.data)) {
      throw new Error(`${method}: GitHub GraphQL response incomplete`);
    }
    return endpoint === 'graphql' ? data.data : data;
  }

  async function pages(method, repo, endpoint) {
    return asPages(await api(method, endpoint, { repo, paginate: true }), method);
  }

  return {
    calls,
    async viewer() {
      return (await api('viewer', 'graphql', { verb: 'POST', body: { query: 'query { viewer { login } }' } })).viewer;
    },
    async listOpenPulls(repo) {
      const rows = await pages('listOpenPulls', repo, `${repoPath(repo)}/pulls?state=open&per_page=100`);
      return rows.map((row) => pullRow(row, repo));
    },
    async searchOpenPulls(author) {
      const query = encodeURIComponent(`is:pr is:open author:${author}`);
      const pages = await api('searchOpenPulls', `search/issues?q=${query}&per_page=100`, { paginate: true });
      if (!Array.isArray(pages) || !pages.length || pages.some((page) => page?.incomplete_results !== false
        || !Number.isSafeInteger(page.total_count) || page.total_count !== pages[0].total_count || !Array.isArray(page.items))) {
        throw new Error('searchOpenPulls: incomplete search');
      }
      const items = pages.flatMap((page) => page.items);
      if (items.length !== pages[0].total_count || new Set(items.map((item) => item.id)).size !== items.length) {
        throw new Error('searchOpenPulls: incomplete search');
      }
      return items.map((item) => pullRow(item, new URL(item.repository_url).pathname.replace(/^\/repos\//, '')));
    },
    async getPull(repo, number) {
      const [, owner, name] = repoPath(repo).split('/');
      const data = await api('getPull', 'graphql', {
        repo, verb: 'POST', body: { query: PULL_QUERY, variables: { owner, repo: name, number: positive(number) } },
      });
      return data.repository?.pullRequest;
    },
    listBranchRules(repo, branch) {
      return pages('listBranchRules', repo, `${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}?per_page=100`);
    },
    listAlerts(repo, number) {
      return pages('listAlerts', repo, `${repoPath(repo)}/code-scanning/alerts?pr=${positive(number)}&state=open&per_page=100`);
    },
    listAlertInstances(repo, number, alert) {
      return pages('listAlertInstances', repo, `${repoPath(repo)}/code-scanning/alerts/${positive(alert)}/instances?pr=${positive(number)}&per_page=100`);
    },
    async alertCommitParents(repo, sha) {
      if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('invalid alert commit SHA');
      return (await api('alertCommitParents', `${repoPath(repo)}/commits/${sha}`, { repo })).parents;
    },
    replyToThread(repo, number, commentId, body) {
      return api('replyToThread', `${repoPath(repo)}/pulls/${positive(number)}/comments/${positive(commentId)}/replies`,
        { repo, verb: 'POST', body: { body } });
    },
    async resolveThread(threadId, repo) {
      if (repo !== undefined) repoPath(repo);
      const data = await api('resolveThread', 'graphql', { repo, appOnly: true, verb: 'POST', body: {
        query: 'mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }',
        variables: { id: threadId },
      } });
      if (data.resolveReviewThread?.thread?.isResolved !== true) throw new Error('resolveThread: resolution unconfirmed');
      return data.resolveReviewThread.thread;
    },
    async compareBase(repo, base, head) {
      if (![base, head].every((sha) => /^[a-f0-9]{40}$/i.test(sha))) throw new Error('compareBase: invalid commit SHA');
      const data = await api('compareBase', `${repoPath(repo)}/compare/${base}...${head}?per_page=1`, { repo });
      const behindBy = data?.behind_by;
      const mergeBaseAt = data?.merge_base_commit?.commit?.committer?.date;
      if (!Number.isSafeInteger(behindBy) || behindBy < 0 || typeof mergeBaseAt !== 'string'
        || !Number.isFinite(Date.parse(mergeBaseAt))) throw new Error('compareBase: behind count or merge base date unknown');
      return { behindBy, mergeBaseAt };
    },
    updateBranch(repo, number, expectedHeadSha) {
      if (!/^[a-f0-9]{40}$/i.test(expectedHeadSha)) throw new Error('updateBranch: invalid expected head SHA');
      return api('updateBranch', `${repoPath(repo)}/pulls/${positive(number)}/update-branch`,
        { repo, appOnly: true, verb: 'PUT', body: { expected_head_sha: expectedHeadSha } });
    },
    rerunJob(repo, jobId) {
      return api('rerunJob', `${repoPath(repo)}/actions/jobs/${positive(jobId)}/rerun`, { repo, appOnly: true, verb: 'POST' });
    },
  };
}
