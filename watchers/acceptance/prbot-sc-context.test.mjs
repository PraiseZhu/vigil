// 修正轮沙箱上下文：宿主把修正子 issue 正文写进轮次目录，提示里写明路径；正文缺失就报错，不跑模型。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { hostPaths, readAlerts } from './host/paths.mjs';
import {
  buildPrompt,
  isBlankIssueBody,
  runPrbotCorrection,
  sandboxIssueContextPath,
  writeSandboxIssueContext,
} from './host/prbot.mjs';
import { createFakeGithub, createWorld } from './session.fixture.mjs';
import { OWNER, REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

function makeRoundDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'prbot-sc-context-'));
}

test('正文在：写入沙箱可读文件，内容和路径一致', () => {
  const roundDir = makeRoundDir();
  const body = '## 验收标准\n- [ ] SC1 把结果写进轮次评论。验证：unit\n';
  const file = writeSandboxIssueContext(roundDir, body);
  assert.equal(file, sandboxIssueContextPath(roundDir));
  assert.equal(file, path.join(roundDir, 'context', 'issue.md'));
  assert.equal(fs.readFileSync(file, 'utf8'), body);
  assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test('提示里写明上下文路径，并禁止直接调用 gh 或 curl', () => {
  const roundDir = makeRoundDir();
  const file = writeSandboxIssueContext(roundDir, '## 验收标准\n- [ ] SC1 示例\n');
  const prompt = buildPrompt(
    {
      issue: `${REPO}#9`,
      root: `${REPO}#1`,
      item: `${REPO}#2`,
      sc: 3,
      mustFix: [{ ref: `${REPO}#2`, sc: 3 }],
    },
    { issueContextPath: file },
  );
  assert.ok(prompt.includes(`修正子 issue 的正文（含验收项原文）在沙箱可读文件：${file}`));
  assert.match(prompt, /不要直接调用 gh 或 curl/);
});

test('验收项含特殊字符和长正文时按原文写入，提示仍指向该文件', () => {
  const roundDir = makeRoundDir();
  const special = [
    '## 验收标准',
    '- [ ] SC1 特殊字符：<>&"\'`${}$()、换行与\t制表、中文和 emoji 🎯。验证：unit（测试点：a.test.mjs）',
    '',
    '## 原因',
    '原因里也有反斜杠 \\ 和引用 `"quoted"`。',
    'A'.repeat(50_000),
  ].join('\n');
  const file = writeSandboxIssueContext(roundDir, special);
  assert.equal(fs.readFileSync(file, 'utf8'), special);
  assert.equal(fs.statSync(file).size, Buffer.byteLength(special));
  const prompt = buildPrompt(
    { issue: `${REPO}#9`, root: `${REPO}#1`, item: `${REPO}#2`, sc: 1, mustFix: [{ ref: `${REPO}#2`, sc: 1 }] },
    { issueContextPath: file },
  );
  assert.ok(prompt.includes(file));
});

test('正文缺失或只有空白：抛错且不写文件', () => {
  for (const body of [undefined, null, '', '   ', '\n\t  \n']) {
    const roundDir = makeRoundDir();
    assert.equal(isBlankIssueBody(body), true);
    assert.throws(
      () => writeSandboxIssueContext(roundDir, body),
      (error) => error?.code === 'missing-issue-body' && /正文缺失/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(roundDir, 'context')), false);
    assert.equal(fs.existsSync(sandboxIssueContextPath(roundDir)), false);
  }
});

test('修正子 issue 正文缺失：宿主告警，不认领、不跑模型', async () => {
  const home = writeProfile(tmpDir(), { profile: { stateDir: path.join(tmpDir(), 'acc-state') } }).home;
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  const world = createWorld();
  world.addIssue({
    repo: REPO,
    number: 9,
    title: '修正：空正文',
    body: '',
    author: OWNER,
  });
  let piRan = false;
  const code = await runPrbotCorrection({
    home,
    issue: `${REPO}#9`,
    profile,
    hostConfig: { prbot: { piCommand: ['pi'], repos: { [REPO]: { handoff: 'owner' } } } },
    github: createFakeGithub(world),
    piRunner: async () => {
      piRan = true;
      return { ok: true, stdout: '', code: 0 };
    },
  });
  assert.equal(code, 1);
  assert.equal(piRan, false);
  assert.equal(world.requireIssue(`${REPO}#9`).comments.length, 0);
  const paths = hostPaths(home);
  const alerts = readAlerts(paths);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'prbot-missing-issue-body');
  assert.match(alerts[0].reason, /正文缺失/);
  const events = fs.existsSync(paths.prbotEventsFile)
    ? fs.readFileSync(paths.prbotEventsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'needs-human');
  assert.equal(events[0].reason, 'missing-issue-body');
  assert.equal(fs.existsSync(paths.prbotRoundsDir) ? fs.readdirSync(paths.prbotRoundsDir).length : 0, 0);
});
