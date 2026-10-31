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
} from './pr-link.fixture.mjs';

test('SC1 匹配函数：标题或正文里的 #n、完整 issue 链接、分支名里的 issue 号、Refs owner/repo#n 都命中', () => {
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

test('SC2 同号不同仓：裸 #n 和分支落在 PR 自己的仓，Refs 和完整链接落在写明的仓', () => {
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
    title: '#2',
    body: '',
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
  } finally {
    globalThis.fetch = previous;
  }
  assert.deepEqual(calls, []);
});
