import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_TEMPLATE, checkTemplate } from './bin/crontab-template-check.mjs';

const BIN = fileURLToPath(new URL('./bin/crontab-template-check.mjs', import.meta.url));
const DOCS = fileURLToPath(new URL('../../docs/acceptance-operations.md', import.meta.url));
const TEMPLATE = fs.readFileSync(DEFAULT_TEMPLATE, 'utf8');

/** 模板里的生效行（不含注释与空行）。 */
const entryLines = (text) => text.split('\n').filter((line) => line.trim() && !line.trim().startsWith('#'));

/** 按片段删掉第一条生效行（连同它上方的注释），用来造「缺一条」的夹具。 */
function withoutEntry(text, needle) {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(needle) && !line.trim().startsWith('#'));
  assert.notEqual(index, -1, `夹具前提：模板里应有含 ${needle} 的生效行`);
  const start = lines[index - 1]?.trim().startsWith('#') ? index - 1 : index;
  lines.splice(start, index - start + 1);
  return lines.join('\n');
}

const codes = (verdict) => verdict.problems.map((problem) => problem.code);

test('真实模板：5 条生效条目都在、每条上方有注释 → 通过', () => {
  const verdict = checkTemplate(TEMPLATE);
  assert.deepEqual(verdict.problems, []);
  assert.equal(verdict.ok, true);
  assert.equal(entryLines(TEMPLATE).length, 5);
});

test('缺一条（deploy-ff 被删）→ 不通过，报缺哪条', () => {
  const verdict = checkTemplate(withoutEntry(TEMPLATE, 'deploy-ff.mjs'));
  assert.equal(verdict.ok, false);
  assert.ok(codes(verdict).includes('missing-entry'));
  assert.match(verdict.problems.find((problem) => problem.code === 'missing-entry').message, /deploy-ff/);
});

test('重复（deploy-ff 行贴两遍）→ 不通过', () => {
  const deploy = entryLines(TEMPLATE).find((line) => line.includes('deploy-ff.mjs'));
  const verdict = checkTemplate(`${TEMPLATE}\n${deploy}\n`);
  assert.equal(verdict.ok, false);
  assert.ok(codes(verdict).includes('duplicate-entry'));
  assert.ok(codes(verdict).includes('duplicate-line'));
});

test('含写死的 /home/example 路径 → 不通过，提示改用 $HOME', () => {
  const parsed = checkTemplate(TEMPLATE.replace(/\$HOME/g, '/home/example'));
  assert.equal(parsed.ok, false);
  assert.ok(codes(parsed).includes('absolute-home'));
  assert.match(parsed.problems.find((problem) => problem.code === 'absolute-home').message, /\$HOME/);
});

test('含令牌样例 → 不通过（GitHub token 与 LLM 代理密钥变量各一条）', () => {
  const deployLine = entryLines(TEMPLATE).find((line) => line.includes('deploy-ff.mjs'));
  const withToken = TEMPLATE.replace(deployLine, deployLine.replace('--approval-file', '--approval-file ghp_exampletoken'));
  const tokenVerdict = checkTemplate(withToken);
  assert.equal(tokenVerdict.ok, false);
  assert.ok(codes(tokenVerdict).includes('token'));

  const withEnv = `${TEMPLATE}\n# 夹具：把代理密钥写进 cron 环境\n5 4 * * * LLM_PROXY_API_KEY=example $HOME/bin/x.sh\n`;
  const envVerdict = checkTemplate(withEnv);
  assert.equal(envVerdict.ok, false);
  assert.ok(codes(envVerdict).includes('token'));
});

test('deploy-ff 缺 --approval-file → 不通过', () => {
  const verdict = checkTemplate(TEMPLATE.replace(' --approval-file $HOME/acceptance/home/state/host/deploy-ff-approval', ''));
  assert.equal(verdict.ok, false);
  assert.ok(codes(verdict).includes('deploy-no-approval'));
});

test('条目上方没有注释 → 不通过', () => {
  const lines = TEMPLATE.split('\n');
  const index = lines.findIndex((line) => line.includes('run-field.sh') && !line.trim().startsWith('#'));
  lines[index - 1] = '';
  const verdict = checkTemplate(lines.join('\n'));
  assert.equal(verdict.ok, false);
  assert.ok(codes(verdict).includes('missing-comment'));
});

test('CLI 黑盒：默认模板退出码 0，坏模板退出码 1 且把原因写到 stderr', () => {
  const ok = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /校验通过/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crontab-template-'));
  try {
    const bad = path.join(dir, 'crontab.template');
    fs.writeFileSync(bad, `${TEMPLATE.replace(/\$HOME/g, '/home/example')}`);
    const failed = spawnSync(process.execPath, [BIN, '--template', bad], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /绝对路径/);

    const missing = spawnSync(process.execPath, [BIN, '--template', path.join(dir, 'nope')], { encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /读不到模板/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('运维文档写明模板位置、$HOME 不展开、只在无 crontab 时装、人工步骤', () => {
  const docs = fs.readFileSync(DOCS, 'utf8');
  assert.match(docs, /## 16\. 重启后恢复 crontab/);
  assert.match(docs, /watchers\/acceptance\/crontab\.template/);
  assert.match(docs, /crontab-template-check\.mjs/);
  assert.match(docs, /no crontab for/);
  assert.match(docs, /保持原样.*不要用 `sed` 展开/);
  assert.match(docs, /人工步骤/);
  assert.match(docs, /仓外另管/);
});
