// #60 修正轮绑定的写闸检查：认领 / 改同一条轮次评论 / 推分支 / 开 Draft / 盯 CI / 转 Ready。
// 从 write-gate.mjs 拆出来，写闸核心只接线；这里只读 GitHub，不写任何东西。
import { collectTree, parseMarker } from '../bin/collect.mjs';
import { latestRound, parseRef, parseRounds } from '../bin/rounds.mjs';
import { forkTargetFor } from '../bin/profile.mjs';

export const CORRECTION_CLAIM_LINE = /^\[修正机\] 第 (\d+) 轮：修正中$/;
export const CORRECTION_STATUS_LINE = /^\[修正机\] 第 (\d+) 轮：(修正中|Draft 已开|等 CI|再修 \d+\/2|已 Ready|需人工处理|中断)$/;
export const CORRECTION_TERMINAL = new Set(['已 Ready', '需人工处理', '中断']);

/** 只看 PR 的头：写闸动作（更新分支 / 重跑 / 转 Ready）先核对分支名、head 所在仓和 base。 */
export const PR_HEAD_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      isDraft
      headRefName
      headRefOid
      headRepository { nameWithOwner }
      isCrossRepository
      baseRefName
      mergeStateStatus
      changedFiles
      additions
      deletions
    }
  }
}`;

/** 修正轮盯 CI 用的固定查询：head、Draft、落后状态、检查名 / 结论 / workflow run id。 */
export const PR_STATUS_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      isDraft
      headRefName
      headRefOid
      mergeStateStatus
      changedFiles
      additions
      deletions
      commits(last: 1) {
        nodes {
          commit {
            checkSuites(first: 50) {
              nodes {
                status
                conclusion
                workflowRun { databaseId }
                checkRuns(first: 100) {
                  nodes {
                    name
                    status
                    conclusion
                    databaseId
                    checkSuite { workflowRun { databaseId } }
                  }
                }
              }
            }
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on StatusContext { context state targetUrl }
                  ... on CheckRun { name status conclusion databaseId }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** 按分支 / 标记找已有修正 PR，避免重复开第二个。 */
export const PR_BY_BRANCH_QUERY = `query ($owner: String!, $name: String!, $head: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 10, states: OPEN, headRefName: $head) {
      nodes { number url isDraft headRefName headRefOid isCrossRepository headRepository { nameWithOwner } body }
    }
  }
}`;

/** ready-stalled 用：PR 上的 review、review comment、check run。 */
export const READY_ACTIVITY_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      headRefOid
      reviews(first: 100) { nodes { createdAt author { login } } }
      comments(first: 100) { nodes { createdAt author { login } body } }
      commits(last: 1) {
        nodes {
          commit {
            checkSuites(first: 50) {
              nodes { checkRuns(first: 100) { nodes { name status conclusion completedAt } } }
            }
          }
        }
      }
    }
  }
}`;

/** main 分支上同名检查：用来判断「红不是这次改动引起的」。 */
export const MAIN_CHECKS_QUERY = `query ($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $branch) {
      target {
        ... on Commit {
          oid
          checkSuites(first: 50) {
            nodes { checkRuns(first: 100) { nodes { name status conclusion } } }
          }
          statusCheckRollup {
            contexts(first: 100) {
              nodes { __typename ... on StatusContext { context state targetUrl } }
            }
          }
        }
      }
    }
  }
}`;

function firstLine(text) {
  return String(text ?? '').split('\n')[0] || '';
}

function refOf(repo, issue) {
  return `${repo}#${Number(issue)}`;
}

/**
 * 修正轮绑定的检查。依赖都由写闸传进来（GitHub 读、绑定、档位、pr.ready 复核、动作模块、拒绝格式）。
 * 返回 checkCorrectionWrite(action)（null 放行，否则拒绝结果）和 correctionContext()（serve 启动时 fail-closed）。
 */
export function createCorrectionCheck({ github, profile, binding, scopeOf, readIssueState, checkPrReady, gateActions, reject }) {
  function parseCorrectionRounds(comments, ownerLogin) {
    const owner = String(ownerLogin || '').toLowerCase();
    const rounds = [];
    for (const comment of comments || []) {
      if (String(comment?.author?.login || '').toLowerCase() !== owner) continue;
      const first = firstLine(comment.body);
      const match = CORRECTION_STATUS_LINE.exec(first);
      if (!match) continue;
      rounds.push({
        round: Number(match[1]),
        status: match[2],
        commentId: comment.databaseId,
        createdAt: comment.createdAt,
        url: comment.url,
      });
    }
    rounds.sort((a, b) => {
      const ta = Date.parse(a.createdAt || 0) || 0;
      const tb = Date.parse(b.createdAt || 0) || 0;
      if (ta !== tb) return ta - tb;
      return (a.commentId || 0) - (b.commentId || 0);
    });
    return rounds;
  }

  function correctionBranch(marker) {
    const root = parseRef(marker.root).number;
    const item = parseRef(marker.item).number;
    return `acceptance/${root}-${item}-sc${marker.sc}`;
  }

  function allowedCorrectionRepos(marker, tree) {
    const repos = new Set([
      parseRef(binding.issue).repo,
      parseRef(marker.item).repo,
      parseRef(marker.root).repo,
      tree.root.ref.split('#')[0],
    ]);
    const fork = correctionForkRepo(marker, tree);
    if (fork) repos.add(fork);
    return repos;
  }

  /** fork 模式：上游仓在 forkRepos 里，推送 / PR head 在 fork 仓（forkTargets 对照，默认 ownerLogin 名下同名）。 */
  function correctionForkRepo(marker, tree) {
    if (!tree.root.fork) return null;
    return forkTargetFor(profile, parseRef(marker.root).repo);
  }

  async function correctionContext() {
    const issueState = await readIssueState(binding.issue);
    if (!issueState) return null;
    const marker = parseMarker(issueState.issue.body);
    if (!marker) return null;
    const rootState = await readIssueState(marker.root);
    if (!rootState) return null;
    const tree = await collectTree({ github, profile, ref: marker.root });
    const entry = tree.corrections.find(
      (correction) => String(correction.ref).toLowerCase() === String(binding.issue).toLowerCase(),
    );
    if (!entry || entry.state !== 'open') return null;
    const rounds = parseCorrectionRounds(issueState.issue.comments?.nodes || [], profile.ownerLogin);
    const latest = rounds.at(-1) || null;
    const latestRoot = latestRound(parseRounds(rootState.issue.comments?.nodes || [], profile.ownerLogin));
    return { issueState, marker, rootState, tree, entry, rounds, latest, latestRoot };
  }

  /** 修正轮绑定（#60）：认领 / 改同一条轮次评论 / 推分支 / 开 Draft / 盯 CI / 转 Ready。 */
  async function checkCorrectionWrite(action) {
    const context = await correctionContext();
    if (!context) return reject('not-current-round', `找不到打开着的修正子 issue ${binding.issue}`);
    const { marker, tree, rounds, latest, latestRoot } = context;
    if (!latestRoot || latestRoot.status !== '要修') {
      return reject('verdict-not-fix', `总 issue 最新轮次不是「要修」：${latestRoot ? latestRoot.status : '没有轮次'}`);
    }
    if (tree.root.tier !== 'auto') return reject('tier-not-allowed', '修正轮只认 auto / fork 档');
    const correctionRepo = parseRef(binding.issue).repo;
    const correctionScope = scopeOf(correctionRepo);
    if (!correctionScope || correctionScope.tier !== 'auto') {
      return reject('tier-not-allowed', `${correctionRepo} 不是 auto / fork 档`);
    }

    const maxRound = rounds.reduce((acc, round) => Math.max(acc, round.round), 0);
    if (binding.commentId == null) {
      if (action.type !== 'comment.create') return reject('not-current-round', '认领只能新建一条轮次评论');
      if (refOf(action.repo, action.issue) !== binding.issue) {
        return reject('not-current-round', '认领只能发在修正子 issue 上');
      }
      const match = CORRECTION_CLAIM_LINE.exec(firstLine(action.body));
      if (!match) return reject('not-current-round', '认领首行必须是「[修正机] 第 m 轮：修正中」');
      const m = Number(match[1]);
      if (latest && !CORRECTION_TERMINAL.has(latest.status)) {
        return reject('round-in-progress', `第 ${latest.round} 轮还在进行（${latest.status}），不能再认领新一轮`);
      }
      if (latest && !((Date.parse(latestRoot.createdAt || '') || 0) > (Date.parse(latest.createdAt || '') || 0))) {
        return reject('not-current-round', `第 ${latest.round} 修正轮之后总 issue 还没有新的「要修」裁决`);
      }
      if (m !== Number(binding.round) || m !== maxRound + 1 || m > 2) {
        return reject('not-current-round', `期望第 ${Math.min(maxRound + 1, 2)} 轮，收到第 ${m} 轮`);
      }
      return null;
    }

    if (
      !latest ||
      latest.round !== Number(binding.round) ||
      Number(latest.commentId) !== Number(binding.commentId) ||
      CORRECTION_TERMINAL.has(latest.status)
    ) {
      const actual = latest ? `第 ${latest.round} 轮（${latest.status}）` : '还没有修正轮';
      return reject('not-current-round', `期望第 ${binding.round} 轮（进行中），实际${actual}`);
    }

    const branch = correctionBranch(marker);
    const allowedRepos = allowedCorrectionRepos(marker, tree);

    switch (action.type) {
      case 'comment.update': {
        if (Number(action.commentId) !== Number(binding.commentId)) return reject('not-allowed', '只能改本轮那条修正轮评论');
        const match = CORRECTION_STATUS_LINE.exec(firstLine(action.body));
        if (!match || Number(match[1]) !== Number(binding.round)) {
          return reject('not-allowed', '修正轮评论首行必须是已知状态');
        }
        return null;
      }
      case 'branch.push': {
        if (action.branch !== branch) return reject('not-allowed', `只能推 ${branch}`);
        if (!allowedRepos.has(action.repo)) return reject('not-allowed', `${action.repo} 不是这个修正轮的仓`);
        const forkRepo = correctionForkRepo(marker, tree);
        if (forkRepo && action.repo !== forkRepo) return reject('not-allowed', `fork 模式只推到 ${forkRepo}`);
        return null;
      }
      case 'pr.create': {
        const head = String(action.head || '');
        const colon = head.indexOf(':');
        const headOwner = colon >= 0 ? head.slice(0, colon) : null;
        const headBranch = colon >= 0 ? head.slice(colon + 1) : head;
        if (headBranch !== branch) return reject('not-allowed', `PR 的 head 必须是 ${branch}`);
        // head 的仓前缀：非 fork 不带；fork 只能是我自己（ownerLogin），不能拿别人 fork 里的同名分支开 PR。
        if (correctionForkRepo(marker, tree)) {
          if (headOwner === null || headOwner.toLowerCase() !== String(profile.ownerLogin || '').toLowerCase()) {
            return reject('not-allowed', `fork 模式 PR 的 head 必须是 ${profile.ownerLogin}:${branch}`);
          }
        } else if (headOwner !== null) {
          return reject('not-allowed', 'PR 的 head 不能带别的仓的前缀');
        }
        if (action.draft !== true) return reject('not-allowed', '修正 PR 一律先开 Draft');
        const prMarker = parseMarker(action.body);
        if (
          !prMarker ||
          prMarker.root !== marker.root ||
          prMarker.item !== marker.item ||
          prMarker.sc !== marker.sc ||
          prMarker.round !== marker.round
        ) {
          return reject('not-allowed', 'PR 正文缺少同一个修正标记');
        }
        if (!allowedRepos.has(action.repo)) return reject('not-allowed', `${action.repo} 不是这个修正轮的仓`);
        // base 只能是 main（不写就是 main）：不能把修正 PR 开到别的分支上。
        if ((action.base ?? 'main') !== 'main') return reject('not-allowed', 'PR 的 base 只能是 main');
        return null;
      }
      case 'pr.ready':
      case 'pr.update-branch':
      case 'ci.rerun': {
        if (!allowedRepos.has(action.repo)) return reject('not-allowed', `${action.repo} 不是这个修正轮的仓`);
        const [owner, name] = String(action.repo || '').split('/');
        const data = await github.graphql(PR_HEAD_QUERY, { owner, name, number: Number(action.pr) });
        const pr = data?.repository?.pullRequest;
        if (!pr) return reject('not-allowed', '找不到 PR');
        if (pr.headRefName !== branch) {
          return reject('not-allowed', `PR 的 head 分支是 ${pr.headRefName || '(空)'}，不是 ${branch}`);
        }
        if (pr.baseRefName !== 'main') return reject('not-allowed', 'PR 的 base 不是 main');
        if (action.type === 'pr.ready') {
          // 转 Ready 的 head 仓（同仓 / 我自己的 fork）由 checkPrReady 核对（不对就 not-in-tree）。
          const forkRepo = correctionForkRepo(marker, tree);
          return checkPrReady(action, {
            number: parseRef(marker.root).number,
            root: marker.root,
            forkRepos: forkRepo ? [forkRepo] : [],
          });
        }
        // 更新分支 / 重跑：head 所在仓也要对 —— 非 fork 是同一个仓，fork 模式只能是我自己的 fork（别人 fork 里的同名分支不算）。
        const headRepo = String(pr.headRepository?.nameWithOwner || '').toLowerCase();
        const wantHeadRepo = String(correctionForkRepo(marker, tree) || action.repo).toLowerCase();
        if (headRepo !== wantHeadRepo) {
          return reject('not-allowed', `PR 的 head 在 ${pr.headRepository?.nameWithOwner || '(空)'}，不是 ${wantHeadRepo}`);
        }
        const module = gateActions.get(action.type);
        const verdict = module.check(action, { tier: correctionScope.tier });
        if (!verdict.ok) return reject(verdict.reason, `${action.type} 不满足条件`);
        const expected = action.expectedHeadSha || action.headSha;
        if (expected && String(expected) !== String(pr.headRefOid || '')) {
          return reject('head-moved', `动作里的 head ${expected} 和 PR 上的 ${pr.headRefOid || '(空)'} 不一致`);
        }
        if (action.type === 'ci.rerun') {
          // 只重跑这个 PR 当前 head 上的 workflow run：runId 由写闸自己查，不信调用方。
          const status = await github.graphql(PR_STATUS_QUERY, { owner, name, number: Number(action.pr) });
          const commit = (status?.repository?.pullRequest?.commits?.nodes || []).at(-1)?.commit || {};
          const runIds = new Set();
          for (const suite of commit.checkSuites?.nodes || []) {
            if (suite?.workflowRun?.databaseId != null) runIds.add(Number(suite.workflowRun.databaseId));
            for (const run of suite?.checkRuns?.nodes || []) {
              if (run?.checkSuite?.workflowRun?.databaseId != null) runIds.add(Number(run.checkSuite.workflowRun.databaseId));
            }
          }
          if (!runIds.has(Number(action.runId))) {
            return reject('not-allowed', `run ${action.runId} 不在这个 PR 当前 head 的检查里`);
          }
        }
        return null;
      }
      default:
        return reject('not-allowed', `修正轮不认 ${action.type}`);
    }
  }

  return { checkCorrectionWrite, correctionContext };
}
