// #60 文档与静态检查：运维文档写清 11 阶段、上限、停止条件、事件接口、host.json、交接和待上线验证。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DOC = path.join(ROOT, 'docs', 'acceptance-prbot.md');
const doc = fs.readFileSync(DOC, 'utf8');

test('SC1–SC11 文档：11 个阶段、上限、停止条件、事件 schema、写闸动作', () => {
  for (const word of [
    '1 发现',
    '2 评估',
    '3 修复',
    '4 本地预检',
    '5 提交和建 Draft',
    '6 盯 Draft CI',
    '7 自动再修',
    '8 转 Ready',
    '9 Ready 之后',
    '10 合并',
    '11 清理',
  ]) {
    assert.ok(doc.includes(word), `文档没写阶段「${word}」`);
  }
  for (const word of ['2（第 3 轮', '4', '60 分钟', '3 小时', '1、2、4、8、16 分钟']) {
    assert.ok(doc.includes(word), `文档没写上限「${word}」`);
  }
  assert.match(doc, /stopReason/);
  assert.match(doc, /PAUSED/);
  assert.match(doc, /禁改路径/);
  assert.match(doc, /ready-precondition/);
  assert.match(doc, /pr\.update-branch/);
  assert.match(doc, /ci\.rerun/);
  assert.match(doc, /tier-not-allowed/);
  assert.match(doc, /pr\.merge/);
});

test('SC10/SC11 文档：events.jsonl 六种 type、交接表、host.json prbot 块、待上线验证', () => {
  for (const type of ['claimed', 'draft-opened', 'ready', 'needs-human', 'interrupted-exhausted', 'ready-stalled']) {
    assert.ok(doc.includes(`\`${type}\``), `文档没写事件 ${type}`);
  }
  assert.match(doc, /state\/prbot\/events\.jsonl/);
  assert.match(doc, /handoff/);
  assert.match(doc, /owner/);
  assert.match(doc, /watcher/);
  assert.match(doc, /Mac mini/);
  assert.match(doc, /打开 PR/);
  assert.match(doc, /prbot/);
  assert.match(doc, /piCommand/);
  assert.match(doc, /reviewCheckPattern/);
  assert.match(doc, /forbiddenPaths/);
  assert.match(doc, /handoffNew/);
  assert.match(doc, /待上线验证/);
  assert.match(doc, /Slack/);
  assert.match(doc, /不调 Slack/);
});

test('SC13 文档与示例只用占位符；验收机 README 链到修正轮文档', () => {
  const acceptance = fs.readFileSync(path.join(HERE, 'README.md'), 'utf8');
  assert.ok(acceptance.includes('../../docs/acceptance-prbot.md'));
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'examples', 'acceptance.host.example.json'), 'utf8'));
  assert.ok(example.prbot.piCommand.length > 0);
  assert.ok(example.prbot.repos['example-owner/example-repo']);
  assert.equal(example.prbot.repos['makecindy/cindy'].handoff, 'watcher');

  const banned = [
    ['Praise', 'Zhu'].join(''),
    ['/', 'home', '/'].join(''),
    ['/', 'Users', '/'].join(''),
    ['grok', '-bot-vm'].join(''),
    ['5081', '00218'].join(''),
  ];
  const files = [DOC, path.join(ROOT, 'config', 'examples', 'acceptance.host.example.json')];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const word of banned) {
      assert.equal(text.includes(word), false, `${path.relative(ROOT, file)} 含敏感词 ${word}`);
    }
  }
});
