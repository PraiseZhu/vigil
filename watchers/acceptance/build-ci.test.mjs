// build 项 CI 口径（host/build-ci.mjs）：完整 build 在沙箱里跑不了的仓（要 electron 产物、fakeroot），
// build 项改看「代码打包步骤在沙箱里离线跑通 + 关联 PR 自己 CI 的 build 和测试检查是绿的」。
// CI 结论由宿主在沙箱外只读查 GitHub，作为只读事实写进派发消息；按仓配置，默认关。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BUILD_CI_KEY,
  PR_CHECKS_QUERY,
  appendBuildCiInfo,
  buildCiPolicyFor,
  classifyChecks,
  collectBuildCiFacts,
} from './host/build-ci.mjs';
import { isReadOnlyGraphql } from './bin/github.mjs';
import { OTHER_REPO, REPO } from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ISSUE = `${REPO}#7`;
const PR_REF = `${REPO}#8`;
const POLICY = {
  bundleStep: 'node apps/desktop/scripts/build-remote-bundles.mjs',
  ciChecks: { build: ['verify-checks'], test: ['verify', 'Windows unit tests'] },
};
const HOST = { piCommand: ['pi'], [BUILD_CI_KEY]: { [REPO]: POLICY } };
const MESSAGE = '先读 watchers/acceptance/SESSION.md，照里面的步骤做完这一轮验收。\n代码（宿主只读检出）：\n- x';

function tree(prs = [{ ref: PR_REF, url: `https://github.com/${REPO}/pull/8`, mergedAt: '2026-01-01T00:00:00Z' }]) {
  return { root: { ref: ISSUE }, issues: [{ ref: ISSUE, role: 'root', prs }], corrections: [] };
}

function run(name, conclusion, status = 'COMPLETED') {
  return { __typename: 'CheckRun', name, status, conclusion };
}

function prData(nodes, { head = 'a6ed70fac78c6b89c487fea68765a4ebc2533b53', rollup = true } = {}) {
  return {
    repository: {
      pullRequest: {
        number: 8,
        url: `https://github.com/${REPO}/pull/8`,
        headRefOid: head,
        commits: { nodes: [{ commit: { oid: head, statusCheckRollup: rollup ? { state: 'X', contexts: { nodes } } : null } }] },
      },
    },
  };
}

const ALL_GREEN = [
  run('verify-checks', 'SUCCESS'),
  run('verify', 'SUCCESS'),
  run('Windows unit tests', 'SUCCESS'),
  run('DCO', 'SUCCESS'),
];

function fakeGithub(respond) {
  const calls = [];
  return {
    calls,
    async graphql(query, variables) {
      calls.push({ query, variables });
      return respond(query, variables);
    },
  };
}

async function facts(options = {}) {
  const { respond, prs, issue = ISSUE, collect } = options;
  const hostConfig = 'hostConfig' in options ? options.hostConfig : HOST;
  const github = fakeGithub(respond || (() => prData(ALL_GREEN)));
  const collected = [];
  const result = await collectBuildCiFacts({
    github,
    profile: {},
    hostConfig,
    issue,
    collect:
      collect ||
      (async (options) => {
        collected.push(options.ref);
        return tree(prs);
      }),
  });
  return { result, github, collected };
}

test('配置：按仓开，默认关；仓名不分大小写；别的仓、没配、写成非对象都是关', () => {
  assert.equal(buildCiPolicyFor({ piCommand: ['pi'] }, REPO), null);
  assert.equal(buildCiPolicyFor(undefined, REPO), null);
  assert.equal(buildCiPolicyFor(HOST, OTHER_REPO), null);
  const policy = buildCiPolicyFor(HOST, REPO.toUpperCase());
  assert.equal(policy.repo, REPO);
  assert.equal(policy.bundleStep, POLICY.bundleStep);
  assert.deepEqual(policy.ciChecks, POLICY.ciChecks);
  assert.equal(policy.error, undefined);
});

test('配置写错（没列 CI 检查、打包步骤不是字符串）：口径算开着但结论只能是「取不到」，不会放行', async () => {
  const bad = { [BUILD_CI_KEY]: { [REPO]: { bundleStep: 1, ciChecks: { build: [], test: ['verify'] } } } };
  assert.ok(buildCiPolicyFor(bad, REPO).error);
  const { result, github } = await facts({ hostConfig: bad });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /配置/);
  assert.equal(github.calls.length, 0, '配置写错就不查 GitHub');
});

test('查 CI 用的是纯只读 GraphQL（走现有读重试），不含 mutation', () => {
  assert.equal(isReadOnlyGraphql(PR_CHECKS_QUERY), true);
  assert.doesNotMatch(PR_CHECKS_QUERY, /mutation/);
});

test('CI 绿：关联 PR 的 build 检查和测试检查都成功 → 绿，派发消息写明证据来源和怎么记', async () => {
  const { result, github, collected } = await facts();
  assert.deepEqual(collected, [ISSUE]);
  assert.equal(result.status, 'green');
  assert.equal(result.prs.length, 1);
  assert.equal(result.prs[0].ref, PR_REF);
  assert.equal(result.prs[0].build.status, 'green');
  assert.equal(result.prs[0].test.status, 'green');
  assert.deepEqual(github.calls[0].variables, { owner: 'example-owner', name: 'example-repo', number: 8 });
  const message = appendBuildCiInfo(MESSAGE, result);
  assert.ok(message.startsWith(MESSAGE), '原消息原样保留在前面');
  assert.match(message, /build 项 CI 口径/);
  assert.match(message, /CI 结论：绿/);
  assert.match(message, /node apps\/desktop\/scripts\/build-remote-bundles\.mjs/);
  assert.match(message, /verify-checks=成功/);
  assert.match(message, /a6ed70f/);
  assert.match(message, /"status":"ran"/);
  assert.match(message, /SESSION\.md/);
});

test('CI 红：任何一个 build / 测试检查失败 → 红，消息要求如实记不通过（要修），不是环境问题', async () => {
  const nodes = [run('verify-checks', 'SUCCESS'), run('verify', 'FAILURE'), run('Windows unit tests', 'SUCCESS')];
  const { result } = await facts({ respond: () => prData(nodes) });
  assert.equal(result.status, 'red');
  assert.equal(result.prs[0].test.status, 'red');
  assert.equal(result.prs[0].build.status, 'green');
  const message = appendBuildCiInfo(MESSAGE, result);
  assert.match(message, /CI 结论：红/);
  assert.match(message, /verify=失败/);
  assert.match(message, /要修/);
  // 超时、启动失败也是红
  for (const conclusion of ['TIMED_OUT', 'STARTUP_FAILURE']) {
    const again = await facts({ respond: () => prData([run('verify-checks', conclusion), ...ALL_GREEN.slice(1)]) });
    assert.equal(again.result.status, 'red', conclusion);
  }
});

test('CI 没跑：检查缺了、还在跑、被取消/跳过、提交上没有任何 CI、没有关联 PR → 没跑（未验证，env-skipped）', async () => {
  const cases = [
    [run('verify-checks', 'SUCCESS'), run('verify', 'SUCCESS')], // 缺 Windows unit tests
    [run('verify-checks', null, 'IN_PROGRESS'), run('verify', 'SUCCESS'), run('Windows unit tests', 'SUCCESS')],
    [run('verify-checks', 'CANCELLED'), run('verify', 'SUCCESS'), run('Windows unit tests', 'SUCCESS')],
    [run('verify-checks', 'SKIPPED'), run('verify', 'SUCCESS'), run('Windows unit tests', 'SUCCESS')],
  ];
  for (const nodes of cases) {
    const { result } = await facts({ respond: () => prData(nodes) });
    assert.equal(result.status, 'not-run', JSON.stringify(nodes));
  }
  const noRollup = await facts({ respond: () => prData([], { rollup: false }) });
  assert.equal(noRollup.result.status, 'not-run');
  const noPr = await facts({ prs: [] });
  assert.equal(noPr.result.status, 'not-run');
  assert.match(noPr.result.reason, /没有关联 PR/);
  assert.equal(noPr.github.calls.length, 0);
  // 只有别的仓的 PR：不算本仓 PR 的 CI
  const otherPr = await facts({ prs: [{ ref: `${OTHER_REPO}#3`, url: 'u', mergedAt: null }] });
  assert.equal(otherPr.result.status, 'not-run');
  const message = appendBuildCiInfo(MESSAGE, noRollup.result);
  assert.match(message, /CI 结论：没跑/);
  assert.match(message, /env-skipped/);
  assert.match(message, /不得写 ran/);
});

test('CI 取不到：GitHub 读失败（重试后仍失败）、PR 找不到、任务树读不到 → 取不到（未验证），失败不吞成通过', async () => {
  const failing = await facts({
    respond: () => {
      throw new Error('HTTP 502 Bad Gateway');
    },
  });
  assert.equal(failing.result.status, 'unavailable');
  assert.equal(failing.result.prs[0].status, 'unavailable');
  assert.match(failing.result.prs[0].error, /502/);
  const missing = await facts({ respond: () => ({ repository: { pullRequest: null } }) });
  assert.equal(missing.result.status, 'unavailable');
  const noTree = await facts({
    collect: async () => {
      throw new Error('找不到 issue');
    },
  });
  assert.equal(noTree.result.status, 'unavailable');
  assert.match(noTree.result.reason, /找不到 issue/);
  const message = appendBuildCiInfo(MESSAGE, failing.result);
  assert.match(message, /CI 结论：取不到/);
  assert.match(message, /env-skipped/);
  // 多个 PR：一个绿一个取不到 → 取不到；一个红一个取不到 → 红
  let n = 0;
  const mixed = await facts({
    prs: [
      { ref: PR_REF, url: 'u1', mergedAt: null },
      { ref: `${REPO}#9`, url: 'u2', mergedAt: null },
    ],
    respond: () => {
      n += 1;
      if (n === 1) return prData(ALL_GREEN);
      throw new Error('boom');
    },
  });
  assert.equal(mixed.result.status, 'unavailable');
  n = 0;
  const redWins = await facts({
    prs: [
      { ref: PR_REF, url: 'u1', mergedAt: null },
      { ref: `${REPO}#9`, url: 'u2', mergedAt: null },
    ],
    respond: () => {
      n += 1;
      if (n === 1) return prData([run('verify-checks', 'FAILURE'), ...ALL_GREEN.slice(1)]);
      throw new Error('boom');
    },
  });
  assert.equal(redWins.result.status, 'red');
});

test('同名检查有多条（重跑）：有一条红就红；只认配置里列的检查名（精确匹配），别的检查红了不算', () => {
  const wanted = ['verify'];
  assert.equal(classifyChecks([run('verify', 'SUCCESS'), run('verify', 'FAILURE')], wanted).status, 'red');
  assert.equal(classifyChecks([run('verify', 'SUCCESS'), run('DCO', 'FAILURE')], wanted).status, 'green');
  assert.equal(classifyChecks([run('verify (1/4)', 'SUCCESS')], wanted).status, 'not-run', '前缀不算');
  assert.equal(
    classifyChecks([{ __typename: 'StatusContext', context: 'verify', state: 'SUCCESS' }], wanted).status,
    'green',
  );
  assert.equal(classifyChecks([{ __typename: 'StatusContext', context: 'verify', state: 'ERROR' }], wanted).status, 'red');
  assert.equal(classifyChecks([{ __typename: 'StatusContext', context: 'verify', state: 'PENDING' }], wanted).status, 'not-run');
});

test('别的仓不受影响：口径只给配了的仓开，别的仓的轮次一次 GitHub 都不多查，消息一字不差', async () => {
  const { result, github, collected } = await facts({ issue: `${OTHER_REPO}#1` });
  assert.equal(result, null);
  assert.equal(github.calls.length, 0);
  assert.deepEqual(collected, []);
  assert.equal(appendBuildCiInfo(MESSAGE, result), MESSAGE);
});

test('口径关闭（host.json 没配）：不查 GitHub、不读任务树，派发消息与现在一字不差', async () => {
  for (const hostConfig of [{ piCommand: ['pi'] }, undefined, { [BUILD_CI_KEY]: {} }, { [BUILD_CI_KEY]: null }]) {
    const { result, github, collected } = await facts({ hostConfig });
    assert.equal(result, null);
    assert.equal(github.calls.length, 0);
    assert.deepEqual(collected, []);
    assert.equal(appendBuildCiInfo(MESSAGE, result), MESSAGE);
  }
});

test('SESSION.md 写了 build 项 CI 口径四种情形，只管 build 一项', () => {
  const session = fs.readFileSync(path.join(HERE, 'SESSION.md'), 'utf8');
  const start = session.indexOf('### build 项的 CI 口径');
  assert.ok(start > 0, 'SESSION.md 要有「build 项的 CI 口径」一节');
  const section = session.slice(start, session.indexOf('\n### ', start + 5));
  for (const word of ['绿', '红', '没跑', '取不到', 'env-skipped', '要修', '只管 build']) {
    assert.ok(section.includes(word), `缺「${word}」`);
  }
});
