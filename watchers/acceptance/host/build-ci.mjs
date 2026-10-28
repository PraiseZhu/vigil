// build 项 CI 口径：有的仓完整 build 在沙箱里跑不了（要 electron 分发产物，安装脚本按设计不跑；打包要 fakeroot，沙箱没有），
// 每轮都会停在「环境问题」。给这类仓在 host.json 里开 buildCiPolicy 后，build 项改看两样：
//   1. 仓里的代码打包步骤在沙箱里离线跑通（模型自己跑）；
//   2. 关联 PR 自己 CI 的 build 检查和测试检查都是绿的（宿主在沙箱外只读查 GitHub，结论作为只读事实写进派发消息）。
// CI 红 → 如实记不通过；没跑 / 取不到 → 仍是未验证（env-skipped），不放行。只管 build 一项，typecheck、test 照旧。
// 没配就整段不跑：不查 GitHub、不读任务树，派发消息一字不差。
// 只读：本文件只发 GraphQL 查询（github.graphql，瞬时故障按现有读重试一次），不发任何写请求。
import { collectTree } from '../bin/collect.mjs';
import { parseRef } from '../bin/rounds.mjs';

export const BUILD_CI_KEY = 'buildCiPolicy';

export const PR_CHECKS_QUERY = `query ($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            oid
            statusCheckRollup {
              state
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const STATUS_LABEL = Object.freeze({ green: '绿', red: '红', 'not-run': '没跑', unavailable: '取不到' });
const RESULT_LABEL = Object.freeze({ success: '成功', failure: '失败', pending: '没跑完', skipped: '没跑', missing: '没有这项' });
// 合并多个结论时谁说了算：红（确定不通过）> 取不到 > 没跑 > 绿。
const RANK = Object.freeze({ red: 3, unavailable: 2, 'not-run': 1, green: 0 });
const RED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);
const RED_STATES = new Set(['FAILURE', 'ERROR']);

function worst(statuses) {
  return statuses.reduce((acc, status) => (RANK[status] > RANK[acc] ? status : acc), 'green');
}

function nameList(value) {
  if (!Array.isArray(value) || !value.length) return null;
  if (!value.every((item) => typeof item === 'string' && item.trim())) return null;
  return value.map((item) => item.trim());
}

/**
 * host.json 里某个仓的 build 项 CI 口径。没配 → null（关）。配了但写错 → 带 error（口径开着，结论只能是「取不到」）。
 *   "buildCiPolicy": { "owner/repo": { "bundleStep": "<沙箱里要跑通的代码打包命令>",
 *                                      "ciChecks": { "build": ["<CI 检查名>"], "test": ["<CI 检查名>"] } } }
 */
export function buildCiPolicyFor(hostConfig, repo) {
  const table = hostConfig?.[BUILD_CI_KEY];
  if (!table || typeof table !== 'object' || Array.isArray(table) || typeof repo !== 'string') return null;
  const key = Object.keys(table).find((name) => name.toLowerCase() === repo.toLowerCase());
  if (!key) return null;
  const raw = table[key];
  const policy = { repo: key, bundleStep: null, ciChecks: { build: [], test: [] } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...policy, error: `${BUILD_CI_KEY}.${key} 配置不是对象` };
  const build = nameList(raw.ciChecks?.build);
  const testChecks = nameList(raw.ciChecks?.test);
  const bundleStep = typeof raw.bundleStep === 'string' && raw.bundleStep.trim() ? raw.bundleStep.trim() : null;
  const problems = [];
  if (!bundleStep) problems.push('bundleStep 要写成命令字符串');
  if (!build) problems.push('ciChecks.build 要列至少一个 CI 检查名');
  if (!testChecks) problems.push('ciChecks.test 要列至少一个 CI 检查名');
  const out = { repo: key, bundleStep, ciChecks: { build: build || [], test: testChecks || [] } };
  if (problems.length) out.error = `${BUILD_CI_KEY}.${key} 配置写错：${problems.join('；')}`;
  return out;
}

function contextResult(node) {
  if (node?.__typename === 'StatusContext' || (node && 'context' in node && !('conclusion' in node))) {
    const state = String(node.state || '').toUpperCase();
    if (state === 'SUCCESS') return 'success';
    if (RED_STATES.has(state)) return 'failure';
    return 'pending';
  }
  if (String(node?.status || '').toUpperCase() !== 'COMPLETED') return 'pending';
  const conclusion = String(node?.conclusion || '').toUpperCase();
  if (conclusion === 'SUCCESS') return 'success';
  if (RED_CONCLUSIONS.has(conclusion)) return 'failure';
  return 'skipped'; // CANCELLED / SKIPPED / STALE / NEUTRAL：都不算跑过、也不算红
}

/** 按检查名（精确匹配）归类一组 CI 结果：有一条失败就红；缺项、没跑完、被取消/跳过算没跑；全部成功才绿。 */
export function classifyChecks(contexts, wanted) {
  const nodes = Array.isArray(contexts) ? contexts : [];
  const checks = [];
  const statuses = [];
  for (const name of wanted) {
    const matched = nodes.filter((node) => (node?.name ?? node?.context) === name).map(contextResult);
    let result;
    if (!matched.length) result = 'missing';
    else if (matched.includes('failure')) result = 'failure';
    else if (matched.includes('pending')) result = 'pending';
    else if (matched.includes('skipped')) result = 'skipped';
    else result = 'success';
    checks.push({ name, result });
    statuses.push(result === 'success' ? 'green' : result === 'failure' ? 'red' : 'not-run');
  }
  return { status: statuses.length ? worst(statuses) : 'not-run', checks };
}

async function prFacts({ github, pr, policy }) {
  const entry = { ref: pr.ref, url: pr.url || null };
  try {
    const { owner, name, number } = parseRef(pr.ref);
    const data = await github.graphql(PR_CHECKS_QUERY, { owner, name, number });
    const node = data?.repository?.pullRequest;
    if (!node) throw new Error(`找不到 ${pr.ref}`);
    const commit = node.commits?.nodes?.[0]?.commit;
    entry.url = node.url || entry.url;
    entry.head = commit?.oid || node.headRefOid || null;
    const contexts = commit?.statusCheckRollup?.contexts?.nodes || [];
    entry.build = classifyChecks(contexts, policy.ciChecks.build);
    entry.test = classifyChecks(contexts, policy.ciChecks.test);
    entry.status = worst([entry.build.status, entry.test.status]);
  } catch (error) {
    entry.status = 'unavailable';
    entry.error = String(error?.message || error).split('\n')[0].slice(0, 200);
  }
  return entry;
}

/**
 * 查本轮 build 项的 CI 事实。只在本轮总 issue 所在的仓开了口径时才做事，否则返回 null（一次 GitHub 都不查）。
 * 任何读失败都落成「取不到」，不抛错、不中止本轮，也绝不当成绿。
 */
export async function collectBuildCiFacts({ github, profile, hostConfig, issue, collect = collectTree } = {}) {
  let repo;
  try {
    repo = parseRef(issue).repo;
  } catch {
    return null;
  }
  const policy = buildCiPolicyFor(hostConfig, repo);
  if (!policy) return null;
  const facts = { repo: policy.repo, bundleStep: policy.bundleStep, ciChecks: policy.ciChecks, prs: [] };
  if (policy.error) return { ...facts, status: 'unavailable', reason: policy.error };
  let tree;
  try {
    tree = await collect({ github, profile, ref: issue });
  } catch (error) {
    return { ...facts, status: 'unavailable', reason: `任务树读不到：${String(error?.message || error).split('\n')[0].slice(0, 200)}` };
  }
  const prs = [];
  for (const item of tree?.issues || []) {
    for (const pr of item.prs || []) {
      let prRepo;
      try {
        prRepo = parseRef(pr.ref).repo;
      } catch {
        continue;
      }
      if (prRepo.toLowerCase() !== policy.repo.toLowerCase()) continue;
      if (!prs.some((seen) => seen.ref.toLowerCase() === pr.ref.toLowerCase())) prs.push(pr);
    }
  }
  if (!prs.length) return { ...facts, status: 'not-run', reason: `任务树里没有关联 PR（${policy.repo}），没有 CI 可引用` };
  for (const pr of prs) facts.prs.push(await prFacts({ github, pr, policy }));
  return { ...facts, status: worst(facts.prs.map((entry) => entry.status)) };
}

function checkLine(group) {
  return group.checks.map((check) => `${check.name}=${RESULT_LABEL[check.result] || check.result}`).join('、');
}

/** 把 CI 事实追加到派发消息末尾。facts 为 null（口径没开）时原样返回，一字不差。 */
export function appendBuildCiInfo(message, facts) {
  if (!facts) return message;
  const lines = [
    '',
    `build 项 CI 口径（只管 build 一项；CI 结论是宿主在沙箱外只读查 GitHub 得到的，以这里为准，规则见 SESSION.md「build 项的 CI 口径」）：`,
    `- ${facts.repo} 的完整 build 在沙箱里跑不了（要 electron 分发产物和 fakeroot）。build 项改看两样：沙箱里离线跑通代码打包步骤${
      facts.bundleStep ? ` \`${facts.bundleStep}\`` : '（配置里没写，按「取不到」处理）'
    }（先 cp -a 到 $TMPDIR 再跑），加上关联 PR 自己 CI 的 build 检查（${facts.ciChecks.build.join('、') || '没配'}）和测试检查（${
      facts.ciChecks.test.join('、') || '没配'
    }）。`,
  ];
  for (const pr of facts.prs || []) {
    const head = pr.head ? `（head ${String(pr.head).slice(0, 7)}）` : '';
    if (pr.status === 'unavailable') {
      lines.push(`- ${pr.url || pr.ref}${head}：取不到（${pr.error || '读失败'}）`);
    } else {
      lines.push(`- ${pr.url || pr.ref}${head}：${STATUS_LABEL[pr.status]}。build 检查：${checkLine(pr.build)}；测试检查：${checkLine(pr.test)}`);
    }
  }
  if (facts.reason) lines.push(`- ${facts.reason}`);
  lines.push(`- CI 结论：${STATUS_LABEL[facts.status] || '取不到'}`);
  lines.push('- 怎么记 checks.build：');
  if (facts.status === 'green') {
    lines.push(
      '  - 代码打包步骤在沙箱里 exit 0：写 {"status":"ran","note":"代码打包步骤 <命令> 沙箱离线通过；<PR 链接> CI <检查名> 绿（宿主只读查询）"}。完整打包没跑这件事只写在这条 note 里，不要写进「通过」条目的证据。',
      '  - 代码打包步骤跑了但没过：是代码问题，判「要修」。因环境原因跑不起来：写 env-skipped。',
    );
  } else if (facts.status === 'red') {
    lines.push('  - CI 红：如实记不通过。checks.build 写 ran，裁决判「要修」，why 写明上面哪个 CI 检查红了（带 PR 链接）。');
  } else {
    lines.push('  - CI 没跑或取不到：build 项未验证。checks.build 写 env-skipped（note 写明「CI 没跑」或「CI 结果取不到」），不得写 ran。');
  }
  return `${String(message).replace(/\n+$/, '')}\n${lines.join('\n')}`;
}
