import { spawnSync } from 'node:child_process';
import { sign } from 'node:crypto';
import fs from 'node:fs';
import { REPO } from './profile.mjs';

const HOST = 'github.com';
const URL_ROOT = 'https://api.github.com';
const TIMEOUT = 30_000;
const PULL_QUERY = `query($owner:String!, $repo:String!, $number:Int!) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$number) {
      number state isDraft author { login __typename }
      headRefOid baseRefName baseRefOid mergeable mergeStateStatus reviewDecision
      autoMergeRequest { enabledAt } isInMergeQueue
      baseRef { refUpdateRule { requiredStatusCheckContexts } }
      commits(last:1) { nodes { commit { oid statusCheckRollup {
        contexts(first:100) { totalCount pageInfo { hasNextPage } nodes {
          __typename
          ... on CheckRun {
            databaseId name status conclusion detailsUrl title summary text isRequired(pullRequestNumber:$number)
            checkSuite { app { databaseId slug } }
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
  let installation;

  async function appToken() {
    if (installation && Date.parse(installation.expires_at) > Date.now() + 60_000) return installation.token;
    calls.push('authenticateApp');
    try {
      const response = await fetchFn(`${URL_ROOT}/app/installations/${config.installationId}/access_tokens`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${jwt(config)}`, Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(TIMEOUT),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      installation = await response.json();
      if (typeof installation.token !== 'string' || !installation.token
        || !(Date.parse(installation.expires_at) > Date.now())) throw new Error('invalid installation response');
      return installation.token;
    } catch (error) {
      const status = /^HTTP \d{3}$/.test(error.message) ? ` (${error.message})` : '';
      throw new Error(`authenticateApp: installation authentication failed${status}`);
    }
  }

  async function api(method, endpoint, { paginate = false, body, verb = 'GET' } = {}) {
    calls.push(method);
    const childEnv = { ...env, GH_PROMPT_DISABLED: '1' };
    if (config.mode === 'app') childEnv.GH_TOKEN = await appToken();
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
      throw new Error(`${method}: GitHub request failed${status ? ` (HTTP ${status})` : result.error?.code ? ` (${result.error.code})` : ''}`);
    }
    if (!result.stdout?.trim() && ['POST', 'PATCH'].includes(verb) && endpoint !== 'graphql') return null;
    let data;
    try { data = JSON.parse(result.stdout); }
    catch { throw new Error(`${method}: invalid GitHub response`); }
    if (endpoint === 'graphql' && (data?.errors?.length || !data?.data)) {
      throw new Error(`${method}: GitHub GraphQL response incomplete`);
    }
    return endpoint === 'graphql' ? data.data : data;
  }

  async function pages(method, endpoint) {
    return asPages(await api(method, endpoint, { paginate: true }), method);
  }

  return {
    calls,
    async viewer() {
      return (await api('viewer', 'graphql', { verb: 'POST', body: { query: 'query { viewer { login } }' } })).viewer;
    },
    async listOpenPulls(repo) {
      const rows = await pages('listOpenPulls', `${repoPath(repo)}/pulls?state=open&per_page=100`);
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
        verb: 'POST', body: { query: PULL_QUERY, variables: { owner, repo: name, number: positive(number) } },
      });
      return data.repository?.pullRequest;
    },
    listBranchRules(repo, branch) {
      return pages('listBranchRules', `${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}?per_page=100`);
    },
    listAlerts(repo, number) {
      return pages('listAlerts', `${repoPath(repo)}/code-scanning/alerts?pr=${positive(number)}&state=open&per_page=100`);
    },
    listAlertInstances(repo, number, alert) {
      return pages('listAlertInstances', `${repoPath(repo)}/code-scanning/alerts/${positive(alert)}/instances?pr=${positive(number)}&per_page=100`);
    },
    async alertCommitParents(repo, sha) {
      if (!/^[a-f0-9]{40}$/i.test(sha)) throw new Error('invalid alert commit SHA');
      return (await api('alertCommitParents', `${repoPath(repo)}/commits/${sha}`)).parents;
    },
    replyToThread(repo, number, commentId, body) {
      return api('replyToThread', `${repoPath(repo)}/pulls/${positive(number)}/comments/${positive(commentId)}/replies`,
        { verb: 'POST', body: { body } });
    },
    async resolveThread(threadId) {
      const data = await api('resolveThread', 'graphql', { verb: 'POST', body: {
        query: 'mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }',
        variables: { id: threadId },
      } });
      if (data.resolveReviewThread?.thread?.isResolved !== true) throw new Error('resolveThread: resolution unconfirmed');
      return data.resolveReviewThread.thread;
    },
    rerunJob(repo, jobId) {
      return api('rerunJob', `${repoPath(repo)}/actions/jobs/${positive(jobId)}/rerun`, { verb: 'POST' });
    },
  };
}
