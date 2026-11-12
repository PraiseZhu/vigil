import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { correctionBody } from './bin/correct.mjs';
import { correctionPrBody } from './host/prbot.mjs';
import { checkPrBody, checkTaskIssue, selectIssueScs } from './host/prbot-template-check.mjs';
import { REPO } from './fake-gh.fixture.mjs';

// #172：本机 check-pr-issue.sh、check-pr-body.sh（task-pr/v1）的规则纯 JS 复刻。用例按脚本的判定写，脚本改了这里一起改。

const ISSUE_REF = `${REPO}#9`;
const ISSUE_BODY = correctionBody({
  root: `${REPO}#1`,
  item: `${REPO}#2`,
  sc: 3,
  round: 1,
  text: 'SC3 导出按钮在空列表时禁用。验证：unit（测试点：导出按钮）',
  why: '空列表时仍可点击',
});
const OPEN_ISSUE = { state: 'OPEN', body: ISSUE_BODY };
const state = {
  issue: ISSUE_REF, prRepo: REPO, root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 2,
  correctionBody: ISSUE_BODY, changedFiles: ['src/export.js'],
};
const marker = { root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 1 };
const PR_BODY = correctionPrBody(state, marker);
const withSc1 = (body, status, evidence) => body.replace(/^(\| SC1 [^\n]*?\| )[^|\n]+(\| )[^|\n]+(\|)$/m, `$1${status} $2${evidence} $3`);
const replaceSection = (body, title, text) => body.replace(new RegExp(`(## ${title}\\n\\n)[\\s\\S]*?(\\n\\n## )`), `$1${text}$2`);

test('#172 check-pr-issue：修正子 issue 模板（五段 + SC1）通过', () => {
  assert.deepEqual(checkTaskIssue(ISSUE_REF, OPEN_ISSUE), []);
  assert.deepEqual(selectIssueScs(ISSUE_BODY), [1]);
});

test('#172 check-pr-issue：引用格式、读不到、没开着、缺段、没有 SC 项都拒，写明期望和实际', () => {
  assert.match(checkTaskIssue('example-repo#9', OPEN_ISSUE)[0], /owner\/repo#号（实际：「example-repo#9」）/);
  assert.match(checkTaskIssue(ISSUE_REF, null)[0], /读不到 issue/);
  assert.match(checkTaskIssue(ISSUE_REF, { state: 'CLOSED', body: ISSUE_BODY })[0], /要是打开状态（实际：CLOSED）/);
  for (const heading of ['## 目标', '## 范围', '## 不做', '## 依赖', '## 验收标准']) {
    const body = ISSUE_BODY.split('\n').filter((line) => !line.startsWith(heading)).join('\n');
    assert.ok(checkTaskIssue(ISSUE_REF, { state: 'OPEN', body }).some((problem) => problem.includes(`缺「${heading}」段`)), heading);
  }
  const noSc = ISSUE_BODY.replace(/^- \[ \] SC1 .*$/m, '- 重新验收通过');
  assert.ok(checkTaskIssue(ISSUE_REF, { state: 'OPEN', body: noSc }).some((problem) => problem.includes('没有 SC<n> 编号项')));
});

test('#172 词边界按 Unicode 算（和脚本的 Python re / GNU grep 一样）：「SC1导出」不算 SC 项', () => {
  const glued = ISSUE_BODY.replace(/^- \[ \] SC1 /m, '- [ ] SC1');
  assert.notEqual(glued, ISSUE_BODY);
  assert.ok(checkTaskIssue(ISSUE_REF, { state: 'OPEN', body: glued }).some((problem) => problem.includes('没有 SC<n> 编号项')));
  assert.deepEqual(selectIssueScs(glued), []);
  assert.deepEqual(selectIssueScs(ISSUE_BODY.replace(/^- \[ \] SC1 /m, '- [ ] **SC1**：')), [1], '加粗、冒号照认');
});

test('#172 check-pr-body open：修正 PR 正文（prbot 组装）对上修正子 issue', () => {
  assert.deepEqual(checkPrBody(PR_BODY, { issueRef: ISSUE_REF, issueBody: ISSUE_BODY, stage: 'open' }), []);
});

test('#172 check-pr-body open：任务 issue 行、缺段、空段、SC 缺 / 多、非法状态都拒', () => {
  const check = (body) => checkPrBody(body, { issueRef: ISSUE_REF, issueBody: ISSUE_BODY, stage: 'open' });
  assert.ok(check(PR_BODY.replace(`任务 issue：${ISSUE_REF}`, '任务 issue：别的')).some((p) => p.includes(`缺少一行「任务 issue：${ISSUE_REF}」`)));
  assert.ok(check(PR_BODY.replace('## 风险与回滚', '## 风险')).some((p) => p.includes('缺「## 风险与回滚」段')));
  assert.ok(check(replaceSection(PR_BODY, '定下的决定', '')).some((p) => p.includes('「## 定下的决定」段是空的')));
  assert.ok(check(PR_BODY.replace(/^\| SC1 /m, '| SC2 ')).some((p) => p.includes('验收对照缺 issue 里的 SC1')));
  assert.ok(check(PR_BODY.replace(/^\| SC1 /m, '| SC2 ')).some((p) => p.includes('多出 issue 里没有的 SC2')));
  assert.ok(check(withSc1(PR_BODY, '搞定', 'x')).some((p) => p.includes('SC1 状态是「搞定」')));
  assert.deepEqual(check(`<!-- 注释 -->\n${PR_BODY}`), [], '注释去掉再看');
  assert.match(checkPrBody(PR_BODY, { issueRef: ISSUE_REF, issueBody: '没有验收标准', stage: 'open' })[0], /没有 SC<n> 编号项/);
});

test('#172 check-pr-body ready：待验证 / 未通过、通过没证据、人工手测没在未执行的验证里写、模板占位都拒', () => {
  const check = (body) => checkPrBody(body, { issueRef: ISSUE_REF, issueBody: ISSUE_BODY, stage: 'ready' });
  assert.ok(check(withSc1(PR_BODY, '待验证', '—')).some((p) => p.includes('SC1 还是「待验证」，不能转 Ready')));
  assert.ok(check(withSc1(PR_BODY, '未通过', 'x')).some((p) => p.includes('SC1 还是「未通过」')));
  assert.ok(check(withSc1(PR_BODY, '通过', '—')).some((p) => p.includes('SC1 写了通过但没有证据（实际：「—」')));
  assert.deepEqual(check(withSc1(PR_BODY, '通过', 'CI 全绿 → https://example.invalid/checks')), []);
  // 修正 PR 的「未执行的验证」本来就写了「SC1 由验收机在本 PR 合并…再验」：人工手测照过。
  assert.deepEqual(check(withSc1(PR_BODY, '人工手测', '见未执行的验证')), []);
  const noMention = replaceSection(withSc1(PR_BODY, '人工手测', '见下'), '未执行的验证', '- 无');
  assert.ok(check(noMention).some((p) => p.includes('SC1 是人工手测，「未执行的验证」里要写谁验、何时验')));
  const placeholder = replaceSection(withSc1(PR_BODY, '通过', 'CI 全绿'), '定下的决定', '<无 / 等 #PR号 合入后>');
  assert.ok(check(placeholder).some((p) => p.includes('还有没填的模板占位')));
});

test('#172 SC4 检查模块只处理文字：不导入任何模块、不读环境变量、不起子进程、不联网、不碰令牌', () => {
  const source = fs.readFileSync(new URL('./host/prbot-template-check.mjs', import.meta.url), 'utf8');
  assert.equal(/^\s*import\s/m.test(source), false, '不导入任何模块');
  for (const banned of ['process.', 'child_process', 'fetch(', 'require(', 'import(', 'readFileSync', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    assert.equal(source.includes(banned), false, banned);
  }
});
