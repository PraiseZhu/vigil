import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { linkedPrField, prIssueRefs } from './bin/pr-link.mjs';
import {
  caseFold,
  crossRepo,
  formatCases,
  knownExpect,
  knownIssues,
  knownLinks,
  knownPrs,
  patternCases,
  vigilCorpus,
} from './pr-link.fixture.mjs';

const VIGIL = 'ExampleUser/vigil';
const OTHER = 'ExampleOrg/other-repo';

function samplePr(partial) {
  return {
    repo: VIGIL,
    number: 1,
    title: '',
    body: '',
    headRefName: 'feature/plain',
    state: 'open',
    ...partial,
  };
}

test('构造样例：每条 refs 与 prIssueRefs 一致', () => {
  assert.ok(patternCases.length >= 6);
  for (const item of patternCases) {
    assert.deepEqual(prIssueRefs(item.pr), item.refs, item.id);
  }
});

test('SC2 fixtures：16 条关联全部命中，同号不同仓不配，分支里的非 issue 数字不配', () => {
  assert.equal(knownLinks.length, 16);
  for (const link of knownLinks) {
    assert.match(link.source, /公开仓 vigil PR/);
    assert.match(link.source, /不是看板导出/);
  }
  const result = linkedPrField({ issues: knownIssues, prs: knownPrs });
  assert.deepEqual(result, knownExpect);
  assert.equal(Object.values(result).filter(Boolean).length, 16);
});

test('同号不同仓：分支落在 PR 自己的仓，Refs 行落在写明的仓；标题裸 #n 和顺手贴的链接不算', () => {
  assert.match(crossRepo.source, /构造/);
  assert.deepEqual(linkedPrField({ issues: crossRepo.issues, prs: crossRepo.prs }), crossRepo.expect);
  assert.deepEqual(linkedPrField({ issues: caseFold.issues, prs: caseFold.prs }), caseFold.expect);
});

test('SC3 文本格式：#123(open,CI✓) #130(merged)，CI 红写 CI✗，没有命中写空串', () => {
  for (const item of formatCases) {
    assert.deepEqual(linkedPrField({ issues: item.issues, prs: item.prs }), item.expect, item.id);
  }
});

test('同一个 PR 传两次只出现一次', () => {
  const pr = {
    repo: 'ExampleUser/vigil',
    number: 5,
    title: 'same pr twice',
    body: 'Closes #2\n',
    headRefName: 'feature/x',
    state: 'open',
    ci: 'pass',
  };
  const text = linkedPrField({ issues: [{ repo: 'ExampleUser/vigil', number: 2 }], prs: [pr, { ...pr }] });
  assert.equal(text['ExampleUser/vigil#2'], '#5(open,CI✓)');
});

test('SC4 模块不联网、不读令牌：源码没有网络、文件系统、子进程或令牌读取', () => {
  const source = fs.readFileSync(new URL('./bin/pr-link.mjs', import.meta.url), 'utf8');
  const banned = [
    /\bfetch\s*\(/,
    /\bXMLHttpRequest\b/,
    /\bchild_process\b/,
    /\bprocess\.env\b/,
    /\breadFile(?:Sync)?\b/,
    /\bwriteFile(?:Sync)?\b/,
    /node:(?:https?|net|fs|child_process|tls)\b/,
    /\brequire\s*\(/,
    /^\s*import\s/m,
    /\b(?:token|secret|password|authorization)\b/i,
    /令牌/,
  ];
  for (const pattern of banned) assert.doesNotMatch(source, pattern);
});

test('SC4 跑匹配时不调用 fetch', () => {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (...args) => {
    calls.push(args);
    throw new Error('fetch');
  };
  try {
    linkedPrField({ issues: knownIssues, prs: knownPrs });
    linkedPrField({ issues: crossRepo.issues, prs: crossRepo.prs });
    for (const item of patternCases) prIssueRefs(item.pr);
    for (const item of formatCases) linkedPrField({ issues: item.issues, prs: item.prs });
    for (const item of vigilCorpus) prIssueRefs(item.pr);
  } finally {
    globalThis.fetch = previous;
  }
  assert.deepEqual(calls, []);
});

test('#178 SC1 顺手提到的 #n、owner/repo#n、issue 链接不算，只留「任务 issue：」行', () => {
  const pr = samplePr({
    title: '顺手 #8',
    body: [
      `任务 issue：${VIGIL}#2`,
      '正文里提到 #3。',
      `见 ${OTHER}#4。`,
      `详见 https://github.com/${VIGIL}/issues/5 。`,
      'Resolves #6',
      'Close #7',
      'Fixed #9',
      '顺便 Closes #11 一下',
    ].join('\n'),
  });
  assert.deepEqual(prIssueRefs(pr), [`${VIGIL}#2`]);
});

test('#178 SC2 任务 issue：owner/repo#n', () => {
  assert.deepEqual(prIssueRefs(samplePr({ body: `任务 issue：${OTHER}#12\n` })), [`${OTHER}#12`]);
});

test('#178 SC2 Closes 后的裸 #n', () => {
  assert.deepEqual(prIssueRefs(samplePr({ body: 'Closes #11\n' })), [`${VIGIL}#11`]);
});

test('#178 SC2 Fixes 后的 owner/repo#n', () => {
  assert.deepEqual(prIssueRefs(samplePr({ body: `Fixes ${OTHER}#13\n` })), [`${OTHER}#13`]);
});

test('#178 SC2 Refs 后的 issue 链接', () => {
  assert.deepEqual(
    prIssueRefs(samplePr({ body: `Refs https://github.com/${OTHER}/issues/14\n` })),
    [`${OTHER}#14`],
  );
});

test('#178 SC2 Closes/Fixes/Refs 大小写不敏感，冒号后也认', () => {
  assert.deepEqual(prIssueRefs(samplePr({ body: 'cLoSeS #15\n' })), [`${VIGIL}#15`]);
  assert.deepEqual(prIssueRefs(samplePr({ body: `FIXES ${OTHER}#16\n` })), [`${OTHER}#16`]);
  assert.deepEqual(prIssueRefs(samplePr({ body: 'refs #17\n' })), [`${VIGIL}#17`]);
  assert.deepEqual(prIssueRefs(samplePr({ body: '备注：Fixes #18\n' })), [`${VIGIL}#18`]);
});

test('#178 SC2 分支 acceptance/<号>-<号>-sc<k>', () => {
  assert.deepEqual(prIssueRefs(samplePr({ headRefName: 'acceptance/93-93-sc5' })), [`${VIGIL}#93`]);
});

test('#178 SC2 分支 issue-<号>', () => {
  assert.deepEqual(prIssueRefs(samplePr({ headRefName: 'feature/issue-40' })), [`${VIGIL}#40`]);
});

test('#178 SC2 分支 issue/<号>', () => {
  assert.deepEqual(prIssueRefs(samplePr({ headRefName: 'feature/issue/41' })), [`${VIGIL}#41`]);
});

test('#178 SC2 分支 #<号>', () => {
  assert.deepEqual(prIssueRefs(samplePr({ headRefName: 'bugfix/#42' })), [`${VIGIL}#42`]);
});

test('#178 SC2 「任务 issue：」行已有 owner/repo#n 时，同行括号里的裸 #n 不算', () => {
  assert.deepEqual(
    prIssueRefs(samplePr({ body: `任务 issue：${VIGIL}#147（#148 的补充）\n` })),
    [`${VIGIL}#147`],
  );
});

test('#178 SC3 vigil 最近 15 个已合并 PR 全文，误配 0、漏配 0', () => {
  assert.equal(vigilCorpus.length, 15);
  assert.deepEqual(
    vigilCorpus.map((item) => item.pr.number),
    [161, 167, 159, 176, 162, 160, 174, 166, 164, 150, 151, 148, 146, 145, 141],
  );
  const lines = [];
  let extraRefs = 0;
  let missingRefs = 0;
  let extraPrs = 0;
  for (const item of vigilCorpus) {
    const got = prIssueRefs(item.pr);
    const extra = got.filter((ref) => !item.expect.includes(ref));
    const missing = item.expect.filter((ref) => !got.includes(ref));
    extraRefs += extra.length;
    missingRefs += missing.length;
    if (extra.length) extraPrs += 1;
    if (extra.length || missing.length) {
      lines.push(`${item.id} 多配 ${extra.join(' ') || '无'}；漏配 ${missing.join(' ') || '无'}`);
    }
  }
  assert.equal(lines.length, 0, `误配引用 ${extraRefs}（${extraPrs} 条 PR）漏配引用 ${missingRefs}\n${lines.join('\n')}`);
});
