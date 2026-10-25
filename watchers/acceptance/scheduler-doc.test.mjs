import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OWNER,
  REPO,
  tmpDir,
  writeProfile,
} from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOC = path.resolve(HERE, '..', '..', 'docs', 'acceptance-scheduler.md');
const BIN = path.join(HERE, 'bin');

function readDoc() {
  return fs.readFileSync(DOC, 'utf8');
}

function runChild(cmd, args, env, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      stderr += ` (killed after ${timeoutMs}ms)`;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end();
  });
}

function extractSchedulerExample(doc) {
  const lines = doc.split('\n');
  const start = lines.findIndex((line) => line.trim() === '```sh scheduler-example');
  assert.notEqual(start, -1, '文档里没有 ```sh scheduler-example 代码块');
  const end = lines.findIndex((line, index) => index > start && line.trim() === '```');
  assert.notEqual(end, -1, '示例代码块没有结束');
  return `${lines.slice(start + 1, end).join('\n')}\n`;
}

function writeStatefulGh(binDir, stateFile) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify({ comments: [], nextId: 5000 }));
  const gh = path.join(binDir, 'gh');
  fs.writeFileSync(
    gh,
    String.raw`#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const stateFile = ${JSON.stringify(stateFile)};
const REPO = ${JSON.stringify(REPO)};
const OWNER = ${JSON.stringify(OWNER)};
const NUMBER = 1;
const lockDir = stateFile + '.lock';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function withState(fn) {
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > 10000) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {
        // 锁目录刚消失：下一轮重试即可。
      }
      await sleep(2);
    }
  }
  try {
    const state = fs.existsSync(stateFile)
      ? JSON.parse(fs.readFileSync(stateFile, 'utf8'))
      : { comments: [], nextId: 5000 };
    const result = fn(state);
    fs.writeFileSync(stateFile, JSON.stringify(state));
    return result;
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
function baseIssue(state) {
  return {
    id: 'I_' + NUMBER,
    number: NUMBER,
    title: 'standalone task',
    body: 'task body',
    state: 'OPEN',
    url: 'https://example.test/issues/' + NUMBER,
    createdAt: '2026-02-01T00:00:00.000Z',
    closedAt: null,
    updatedAt: '2026-02-01T00:00:00.000Z',
    author: { login: OWNER },
    repository: { nameWithOwner: REPO },
    parent: null,
    subIssues: { nodes: [] },
    closedByPullRequestsReferences: {
      nodes: [{ number: 2, url: 'https://example.test/pull/2', mergedAt: '2026-10-20T00:00:00.000Z', repository: { nameWithOwner: REPO } }],
    },
    comments: { nodes: state.comments },
  };
}
if (args.includes('graphql')) {
  const payload = JSON.parse(input || '{}');
  const query = String(payload.query || '');
  const out = await withState((state) => {
    if (query.includes('user(login')) {
      return {
        data: {
          user: {
            open: { nodes: [baseIssue(state)], pageInfo: { hasNextPage: false, endCursor: null } },
            closed: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      };
    }
    if (query.includes('repository(owner')) {
      return {
        data: { repository: { issue: { body: 'task body', comments: { nodes: state.comments } } } },
      };
    }
    return { data: {} };
  });
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}
if (args[0] === 'api') {
  const method = args.includes('POST') ? 'POST' : args.includes('PATCH') ? 'PATCH' : 'GET';
  const apiPath = args.find((a) => a.startsWith('repos/')) || '';
  if (method === 'POST' && /\/issues\/\d+\/comments$/.test(apiPath)) {
    const body = JSON.parse(input || '{}');
    const created = await withState((state) => {
      const id = state.nextId;
      state.nextId += 1;
      const stamp = new Date().toISOString();
      state.comments.push({
        id: 'IC_' + id,
        databaseId: id,
        body: body.body,
        createdAt: stamp,
        updatedAt: stamp,
        url: 'https://example.test/issues/' + NUMBER + '#issuecomment-' + id,
        author: { login: ${JSON.stringify(OWNER)} },
      });
      return { id: id, html_url: 'https://example.test/issues/' + NUMBER + '#issuecomment-' + id };
    });
    process.stdout.write(JSON.stringify(created));
    process.exit(0);
  }
  if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(apiPath)) {
    const body = JSON.parse(input || '{}');
    const id = Number(apiPath.split('/').pop());
    const updated = await withState((state) => {
      const found = state.comments.find((comment) => comment.databaseId === id);
      if (found) {
        found.body = body.body;
        found.updatedAt = new Date().toISOString();
      }
      return { id: id, html_url: 'https://example.test/issues/' + NUMBER + '#issuecomment-' + id };
    });
    process.stdout.write(JSON.stringify(updated));
    process.exit(0);
  }
}
process.stderr.write('unexpected gh call: ' + args.join(' '));
process.exit(2);
`,
  );
  fs.chmodSync(gh, 0o700);
  return gh;
}

function writeAgent(file, source) {
  fs.writeFileSync(file, source);
  fs.chmodSync(file, 0o700);
  return file;
}

function schedulerEnv({ home, binDir, agentFile, agentOut, statusInterval, gate = 'true' }) {
  return {
    ...process.env,
    PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    ACCEPTANCE_WATCHER_HOME: home,
    ACCEPTANCE_BIN: BIN,
    AGENT_CMD: `${process.execPath} ${agentFile}`,
    AGENT_OUT: agentOut,
    RESOURCE_GATE: gate,
    STATUS_INTERVAL: statusInterval,
  };
}

test('SC7 文档写清调用顺序、退出码处理、资源门、卡死与并发规则', () => {
  const doc = readDoc();
  assert.match(doc, /资源门放在认领之前/);
  assert.match(doc, /先结束进程再 abort/);
  assert.match(doc, /退避/);
  assert.match(doc, /poll` 不列出就不开/);
  assert.match(doc, /最多 2 轮/);
  assert.match(doc, /mivo 最多 1 轮/);
  assert.match(doc, /stale: true/);
  assert.match(doc, /卡死：进程不在/);
  assert.match(doc, /poll\.mjs --json/);
  assert.match(doc, /round\.mjs start/);
  assert.match(doc, /round\.mjs status/);
  assert.match(doc, /round\.mjs abort/);
  assert.match(doc, /```sh scheduler-example/);
});

test('SC7 示例脚本真跑：gate → start → agent 读消息，不 abort', async () => {
  const { home } = writeProfile(tmpDir());
  const binDir = path.join(home, 'bin');
  const stateFile = path.join(home, 'gh-state.json');
  writeStatefulGh(binDir, stateFile);
  const agentFile = path.join(home, 'agent-ok.mjs');
  const agentOut = path.join(home, 'agent-input.txt');
  writeAgent(
    agentFile,
    `#!/usr/bin/env node
import fs from 'node:fs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
fs.writeFileSync(process.env.AGENT_OUT, input);
const first = input.split('\\n')[0] || '';
if (!first.startsWith('先读 watchers/acceptance/SESSION.md')) {
  process.stderr.write('bad first line: ' + first + '\\n');
  process.exit(9);
}
process.exit(0);
`,
  );
  const script = path.join(home, 'scheduler.sh');
  fs.writeFileSync(script, extractSchedulerExample(readDoc()));
  const result = await runChild(
    'sh',
    [script],
    schedulerEnv({ home, binDir, agentFile, agentOut, statusInterval: '1' }),
  );
  assert.equal(result.code, 0, result.stderr);
  const agentInput = fs.readFileSync(agentOut, 'utf8');
  assert.match(agentInput.split('\n')[0], /^先读 watchers\/acceptance\/SESSION\.md/);
  assert.match(agentInput, /轮次：第 1 轮/);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body.split('\n')[0], /第 1 轮：验收中/);
});

test('SC7 示例脚本真跑：卡住时先杀 agent 再 abort，轮次变中断', async () => {
  const { home } = writeProfile(tmpDir(), { profile: { stallMinutes: 0.001 } });
  const binDir = path.join(home, 'bin');
  const stateFile = path.join(home, 'gh-state.json');
  writeStatefulGh(binDir, stateFile);
  const agentFile = path.join(home, 'agent-hang.mjs');
  const agentOut = path.join(home, 'agent-input.txt');
  writeAgent(
    agentFile,
    `#!/usr/bin/env node
let input = '';
for await (const chunk of process.stdin) input += chunk;
const fs = await import('node:fs');
fs.writeFileSync(process.env.AGENT_OUT, input);
setInterval(() => {}, 1000);
`,
  );
  const script = path.join(home, 'scheduler.sh');
  fs.writeFileSync(script, extractSchedulerExample(readDoc()));
  const result = await runChild(
    'sh',
    [script],
    schedulerEnv({ home, binDir, agentFile, agentOut, statusInterval: '1' }),
  );
  assert.equal(result.code, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const last = state.comments.at(-1);
  assert.match(last.body.split('\n')[0], /\[验收机\] 第 1 轮：中断/);
  assert.match(last.body, /原因：卡住：超过 stallMinutes 没有进度/);
});

test('SC8 静态：新文件不含真实用户名、绝对家目录路径，只有 github.mjs 用 child_process', () => {
  const bannedUser = ['Praise', 'Zhu'].join('');
  const newFiles = [
    path.join(BIN, 'message.mjs'),
    path.join(BIN, 'round.mjs'),
    DOC,
    path.join(HERE, 'round.test.mjs'),
    path.join(HERE, 'message.test.mjs'),
    path.join(HERE, 'scheduler-doc.test.mjs'),
  ];
  for (const file of newFiles) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(bannedUser), false, `${path.basename(file)} 含真实用户名`);
    assert.doesNotMatch(text, /\/Users\/[A-Za-z0-9._-]+/);
  }
  const message = fs.readFileSync(path.join(BIN, 'message.mjs'), 'utf8');
  const round = fs.readFileSync(path.join(BIN, 'round.mjs'), 'utf8');
  assert.doesNotMatch(message, /node:child_process|spawn\(|execFile/);
  assert.doesNotMatch(round, /node:child_process|spawn\(|execFile/);
  for (const name of fs.readdirSync(BIN)) {
    if (!name.endsWith('.mjs') || name === 'github.mjs' || name === 'localgit.mjs') continue;
    const source = fs.readFileSync(path.join(BIN, name), 'utf8');
    assert.doesNotMatch(source, /node:child_process/);
    assert.doesNotMatch(source, /spawn\(/);
    assert.doesNotMatch(source, /execFile/);
  }
});
