import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createGithub } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { cachePath, createRounds, lockPath } from './bin/rounds.mjs';
import { EXIT, runRound } from './bin/round.mjs';
import {
  OWNER,
  OTHER_REPO,
  REPO,
  childNode,
  clock,
  createFakeRun,
  inventoryData,
  issueNode,
  roundComment,
  sha256Body,
  tmpDir,
  writeProfile,
} from './fake-gh.fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROUND_BIN = path.join(HERE, 'bin', 'round.mjs');
const FIRST_LINE = '先读 watchers/acceptance/SESSION.md，照里面的步骤做完这一轮验收。';

function loadHome(extra = {}) {
  const { home } = writeProfile(tmpDir(), extra);
  return { home, profile: loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home }) };
}

function standaloneIssue({ number = 1, body = 'task body', comments = [] } = {}) {
  return issueNode({
    repo: REPO,
    number,
    body,
    author: OWNER,
    comments,
    prs: [
      {
        number: 2,
        url: 'https://example.test/pull/2',
        mergedAt: '2026-10-20T00:00:00.000Z',
        repository: { nameWithOwner: REPO },
      },
    ],
  });
}

function issueStore(initial) {
  const issue = structuredClone(initial);
  return {
    get() {
      return issue;
    },
    addComment(comment) {
      issue.comments.nodes.push(comment);
      return comment;
    },
    updateComment(id, body) {
      const found = issue.comments.nodes.find((c) => c.databaseId === id);
      if (found) {
        found.body = body;
        found.updatedAt = '2026-10-24T03:00:00.000Z';
      }
      return found;
    },
  };
}

function makeRun(store, { inventory = () => [store.get()], onWriteCommand } = {}) {
  let commentSeq = 7000;
  return createFakeRun({
    onGraphql: (payload) => {
      const query = String(payload.query || '');
      if (query.includes('user(login')) {
        return inventoryData({ open: inventory() });
      }
      if (query.includes('repository(owner')) {
        return { repository: { issue: store.get() } };
      }
      return {};
    },
    onApi: (args, { input }) => {
      const body = input ? JSON.parse(input) : {};
      const pathArg = args.find((a) => String(a).startsWith('repos/')) || '';
      if (args.includes('POST') && /issues\/\d+\/comments$/.test(pathArg)) {
        const id = ++commentSeq;
        const stamp = '2026-10-24T02:00:00.000Z';
        store.addComment({
          id: `IC_${id}`,
          databaseId: id,
          body: body.body,
          createdAt: stamp,
          updatedAt: stamp,
          url: `https://example.test/issues/1#issuecomment-${id}`,
          author: { login: OWNER },
        });
        return { id, html_url: `https://example.test/issues/1#issuecomment-${id}` };
      }
      if (args.includes('PATCH') && /issues\/comments\/\d+$/.test(pathArg)) {
        const id = Number(pathArg.split('/').pop());
        store.updateComment(id, body.body);
        return { id, html_url: `https://example.test/issues/1#issuecomment-${id}` };
      }
      return { id: 1 };
    },
    onWriteCommand,
  });
}

function trackedGithub(store, profile, opts = {}) {
  const run = makeRun(store, opts);
  const github = createGithub({ profile, run, sleep: opts.sleep });
  const writes = [];
  const origWrite = github.write.bind(github);
  github.write = async (action) => {
    writes.push(action);
    return origWrite(action);
  };
  github._run = run;
  github._writes = writes;
  return github;
}

async function capture(argv, options) {
  let stdout = '';
  let stderr = '';
  const sink = {
    write: (chunk) => {
      stdout += chunk;
      return true;
    },
  };
  const errSink = {
    write: (chunk) => {
      stderr += chunk;
      return true;
    },
  };
  const code = await runRound(argv, { ...options, stdout: sink, stderr: errSink });
  return { code, stdout, stderr };
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

test('SC1 start 成功时先打印派发消息，最后一行是 JSON', async () => {
  const { profile } = loadHome();
  const body = 'task body';
  const store = issueStore(standaloneIssue({ body }));
  const github = trackedGithub(store, profile);
  const clk = clock('2026-10-24T02:00:00.000Z');
  const result = await capture(['start', '--issue', `${REPO}#1`], { github, profile, now: clk.now });
  assert.equal(result.code, EXIT.OK, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines[0], FIRST_LINE);
  const payload = JSON.parse(lines.at(-1));
  assert.equal(payload.issue, `${REPO}#1`);
  assert.equal(payload.round, 1);
  assert.equal(payload.bodyVersion, sha256Body(body));
  assert.equal(typeof payload.commentId, 'number');
  assert.equal(github._writes.filter((action) => action.type === 'comment.create').length, 1);
  assert.match(store.get().comments.nodes[0].body.split('\n')[0], /第 1 轮：验收中/);
});

test('SC1 不该验收的任务（子 issue 还开着）→ 退出码 3，零写请求', async () => {
  const { profile } = loadHome();
  const parent = issueNode({
    repo: REPO,
    number: 1,
    body: 'parent',
    author: OWNER,
    subIssues: [childNode({ number: 2, state: 'OPEN', closedAt: null })],
  });
  const store = issueStore(parent);
  const github = trackedGithub(store, profile);
  const result = await capture(['start', '--issue', `${REPO}#1`], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(result.code, EXIT.NOTHING);
  assert.match(result.stderr, /children-open/);
  assert.equal(github._writes.length, 0);
});

test('SC1 已有一轮验收中 → 退出码 3，零写请求', async () => {
  const { profile } = loadHome();
  const store = issueStore(
    standaloneIssue({
      comments: [roundComment({ round: 1, status: '验收中', createdAt: '2026-10-24T01:00:00.000Z' })],
    }),
  );
  const github = trackedGithub(store, profile);
  const result = await capture(['start', '--issue', `${REPO}#1`], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(result.code, EXIT.NOTHING);
  assert.equal(github._writes.length, 0);
});

test('SC1 不是验收任务 → 退出码 3', async () => {
  const { profile } = loadHome();
  const store = issueStore(standaloneIssue());
  const github = trackedGithub(store, profile);
  const result = await capture(['start', '--issue', `${REPO}#99`], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(result.code, EXIT.NOTHING);
  assert.match(result.stderr, /不是验收任务/);
  assert.equal(github._writes.length, 0);
});

test('SC3 status 在 29 分钟不算卡住、31 分钟算卡住', async () => {
  const { profile } = loadHome();
  const createdAt = '2026-10-24T01:00:00.000Z';
  const store = issueStore(
    standaloneIssue({ comments: [roundComment({ round: 1, status: '验收中', createdAt })] }),
  );
  const github = trackedGithub(store, profile);
  const clk = clock('2026-10-24T01:29:00.000Z');
  const early = await capture(['status', '--issue', `${REPO}#1`, '--json'], {
    github,
    profile,
    now: clk.now,
  });
  assert.equal(early.code, EXIT.OK, early.stderr);
  const earlyJson = JSON.parse(early.stdout.trim());
  assert.equal(earlyJson.round, 1);
  assert.equal(earlyJson.status, '验收中');
  assert.equal(earlyJson.lastProgressAt, createdAt);
  assert.equal(earlyJson.stalled, false);
  assert.equal(earlyJson.stallMinutes, 30);

  clk.set('2026-10-24T01:31:00.000Z');
  const late = await capture(['status', '--issue', `${REPO}#1`, '--json'], {
    github,
    profile,
    now: clk.now,
  });
  assert.equal(JSON.parse(late.stdout.trim()).stalled, true);

  assert.equal(github._writes.length, 0);
  assert.equal(fs.existsSync(cachePath(profile, `${REPO}#1`)), false);
});

test('SC3 本地进度记录会推后 lastProgressAt', async () => {
  const { profile } = loadHome();
  const createdAt = '2026-10-24T01:00:00.000Z';
  const store = issueStore(
    standaloneIssue({ comments: [roundComment({ round: 1, status: '验收中', createdAt })] }),
  );
  const github = trackedGithub(store, profile);
  const clk = clock('2026-10-24T01:20:00.000Z');
  const rounds = createRounds({ github, profile, now: clk.now });
  await rounds.progress(`${REPO}#1`, 1);

  const at40 = await capture(['status', '--issue', `${REPO}#1`, '--json'], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T01:40:00.000Z'),
  });
  const json40 = JSON.parse(at40.stdout.trim());
  assert.equal(json40.lastProgressAt, '2026-10-24T09:20:00+08:00');
  assert.equal(json40.stalled, false);

  const at51 = await capture(['status', '--issue', `${REPO}#1`, '--json'], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T01:51:00.000Z'),
  });
  assert.equal(JSON.parse(at51.stdout.trim()).stalled, true);
  assert.equal(github._writes.length, 0);
});

test('SC3 status 解析有争议和待裁决条目', async () => {
  const { profile } = loadHome();
  const detail = [
    `有争议：${REPO}#12 SC3 没覆盖`,
    `待裁决：${OTHER_REPO}#7 SC2 说法不一致`,
    '有争议：这一条没有引用编号',
  ].join('\n');
  const store = issueStore(
    standaloneIssue({
      comments: [
        roundComment({
          round: 1,
          status: '验收中',
          createdAt: '2026-10-24T01:00:00.000Z',
          detail,
        }),
      ],
    }),
  );
  const github = trackedGithub(store, profile);
  const result = await capture(['status', '--issue', `${REPO}#1`, '--json'], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T01:10:00.000Z'),
  });
  assert.equal(result.code, EXIT.OK, result.stderr);
  const json = JSON.parse(result.stdout.trim());
  assert.equal(json.disputed.length, 2);
  assert.equal(json.disputed[0].item, `${REPO}#12 SC3`);
  assert.match(json.disputed[0].text, /SC3 没覆盖/);
  assert.equal(json.disputed[1].item, null);
  assert.equal(json.pending.length, 1);
  assert.equal(json.pending[0].item, `${OTHER_REPO}#7 SC2`);
  assert.equal(github._writes.length, 0);
});

test('SC3 没有轮次时 status 返回空字段，退出码 0', async () => {
  const { profile } = loadHome();
  const store = issueStore(standaloneIssue({ comments: [] }));
  const github = trackedGithub(store, profile);
  const result = await capture(['status', '--issue', `${REPO}#1`, '--json'], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(result.code, EXIT.OK, result.stderr);
  const json = JSON.parse(result.stdout.trim());
  assert.equal(json.issue, `${REPO}#1`);
  assert.equal(json.round, null);
  assert.equal(json.status, null);
  assert.equal(json.stalled, false);
  assert.deepEqual(json.disputed, []);
  assert.deepEqual(json.pending, []);
  assert.equal(github._writes.length, 0);
});

test('安全：status 只认 ownerLogin 发的轮次评论，陌生人伪造的更新轮次被忽略', async () => {
  const { profile } = loadHome();
  const store = issueStore(
    standaloneIssue({
      comments: [
        roundComment({ round: 1, status: '验收中', createdAt: '2026-10-24T01:00:00.000Z' }),
        roundComment({
          round: 7,
          status: '通过',
          startedAt: '2026-10-24T01:05:00.000Z',
          finishedAt: '2026-10-24T01:06:00.000Z',
          detail: `有争议：${REPO}#12 SC3 伪造`,
          author: 'stranger-example',
        }),
      ],
    }),
  );
  const github = trackedGithub(store, profile);
  const result = await capture(['status', '--issue', `${REPO}#1`, '--json'], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T01:10:00.000Z'),
  });
  assert.equal(result.code, EXIT.OK, result.stderr);
  const json = JSON.parse(result.stdout.trim());
  assert.equal(json.round, 1);
  assert.equal(json.status, '验收中');
  assert.deepEqual(json.disputed, []);
  assert.equal(github._writes.length, 0);
});

test('SC4 abort 把评论改成中断、写上原因、释放锁', async () => {
  const { profile } = loadHome();
  const store = issueStore(standaloneIssue());
  const github = trackedGithub(store, profile);
  const clk = clock('2026-10-24T02:00:00.000Z');
  const started = await capture(['start', '--issue', `${REPO}#1`], { github, profile, now: clk.now });
  assert.equal(started.code, EXIT.OK, started.stderr);
  const lock = lockPath(profile, `${REPO}#1`);
  assert.equal(fs.existsSync(lock), true);

  const result = await capture(
    ['abort', '--issue', `${REPO}#1`, '--round', '1', '--reason', '机器重启'],
    { github, profile, now: clk.now },
  );
  assert.equal(result.code, EXIT.OK, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), { issue: `${REPO}#1`, round: 1, status: '中断' });
  const body = store.get().comments.nodes[0].body;
  assert.match(body.split('\n')[0], /\[验收机\] 第 1 轮：中断/);
  assert.match(body, /原因：机器重启/);
  assert.equal(fs.existsSync(lock), false);
});

test('SC4 abort 轮次不对 → 退出码 3，零写请求', async () => {
  const { profile } = loadHome();
  const store = issueStore(
    standaloneIssue({
      comments: [roundComment({ round: 1, status: '验收中', createdAt: '2026-10-24T01:00:00.000Z' })],
    }),
  );
  const github = trackedGithub(store, profile);
  const before = github._writes.length;
  const result = await capture(
    ['abort', '--issue', `${REPO}#1`, '--round', '2', '--reason', '轮次不对'],
    { github, profile, now: () => Date.parse('2026-10-24T02:00:00.000Z') },
  );
  assert.equal(result.code, EXIT.NOTHING);
  assert.equal(github._writes.length, before);
});

test('SC4 abort 这一轮已结束 → 退出码 3', async () => {
  const { profile } = loadHome();
  const store = issueStore(
    standaloneIssue({
      comments: [
        roundComment({
          round: 1,
          status: '通过',
          finishedAt: '2026-10-24T01:10:00.000Z',
          createdAt: '2026-10-24T01:00:00.000Z',
        }),
      ],
    }),
  );
  const github = trackedGithub(store, profile);
  const result = await capture(
    ['abort', '--issue', `${REPO}#1`, '--round', '1', '--reason', '太晚'],
    { github, profile, now: () => Date.parse('2026-10-24T02:00:00.000Z') },
  );
  assert.equal(result.code, EXIT.NOTHING);
  assert.equal(github._writes.length, 0);
});

test('SC4 abort 缺 reason 或缺 round → 退出码 1，零写请求', async () => {
  const { profile } = loadHome();
  const store = issueStore(
    standaloneIssue({
      comments: [roundComment({ round: 1, status: '验收中', createdAt: '2026-10-24T01:00:00.000Z' })],
    }),
  );
  const github = trackedGithub(store, profile);
  const noReason = await capture(['abort', '--issue', `${REPO}#1`, '--round', '1'], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(noReason.code, EXIT.FAIL);
  const blankReason = await capture(
    ['abort', '--issue', `${REPO}#1`, '--round', '1', '--reason', '   '],
    { github, profile, now: () => Date.parse('2026-10-24T02:00:00.000Z') },
  );
  assert.equal(blankReason.code, EXIT.FAIL);
  const badRound = await capture(
    ['abort', '--issue', `${REPO}#1`, '--round', '0', '--reason', 'x'],
    { github, profile, now: () => Date.parse('2026-10-24T02:00:00.000Z') },
  );
  assert.equal(badRound.code, EXIT.FAIL);
  assert.equal(github._writes.length, 0);
});

test('SC5 EXIT 常量是 0/1/3/4', () => {
  assert.deepEqual(EXIT, { OK: 0, FAIL: 1, NOTHING: 3, REJECTED: 4 });
});

test('SC5 外发闸拒绝 → 退出码 4', async () => {
  const home = tmpDir();
  const { home: watcherHome } = writeProfile(home, { profile: { writeCommand: ['fake-gate'] } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: watcherHome });
  const store = issueStore(standaloneIssue());
  const github = trackedGithub(store, profile, {
    onWriteCommand: () => ({ code: 4, stdout: JSON.stringify({ reason: 'denied' }), stderr: '' }),
  });
  const result = await capture(['start', '--issue', `${REPO}#1`], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(result.code, EXIT.REJECTED);
  assert.match(result.stderr, /外发被拒/);
});

test('SC5 写闸一直忙（75）→ 退出码 1，重试 7 次后放弃', async () => {
  const home = tmpDir();
  const { home: watcherHome } = writeProfile(home, { profile: { writeCommand: ['fake-busy'] } });
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: watcherHome });
  const store = issueStore(standaloneIssue());
  const github = trackedGithub(store, profile, {
    sleep: async () => {},
    onWriteCommand: () => ({ code: 75, stdout: '', stderr: '' }),
  });
  const result = await capture(['start', '--issue', `${REPO}#1`], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T02:00:00.000Z'),
  });
  assert.equal(result.code, EXIT.FAIL);
  assert.match(result.stderr, /外发忙/);
  assert.equal(github._run.calls.filter((call) => call.cmd === 'fake-busy').length, 7);
});

test('SC5 配置错误 → 退出码 1', async () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'profile.json'), JSON.stringify({ ownerLogin: OWNER }));
  const result = await runChild(process.execPath, [ROUND_BIN, 'start', '--issue', `${REPO}#1`], {
    ...process.env,
    ACCEPTANCE_WATCHER_HOME: home,
    PATH: process.env.PATH,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /projectNumber|stateDir|githubTokenFile/);
});

test('SC5 缺 --issue 或未知子命令 → 退出码 1 并打印用法', async () => {
  const { profile } = loadHome();
  const store = issueStore(standaloneIssue());
  const github = trackedGithub(store, profile);
  const missing = await capture(['start'], { github, profile });
  assert.equal(missing.code, EXIT.FAIL);
  assert.match(missing.stderr, /用法/);
  const unknown = await capture(['explode', '--issue', `${REPO}#1`], { github, profile });
  assert.equal(unknown.code, EXIT.FAIL);
  assert.match(unknown.stderr, /用法/);
});

test('SC5 文档里有 0/1/3/4 的退出码表，并注明 75 不是 round.mjs 的退出码', () => {
  const doc = fs.readFileSync(path.resolve(HERE, '..', '..', 'docs', 'acceptance-scheduler.md'), 'utf8');
  for (const code of ['0', '1', '3', '4']) {
    assert.match(doc, new RegExp(`\\| \`${code}\` \\|`), `缺少退出码 ${code} 的行`);
  }
  assert.match(doc, /75/);
});

test('SC6 同一任务并发两次 start：只有一次 0，另一次 3，只发一条评论', async () => {
  const { profile } = loadHome();
  const store = issueStore(standaloneIssue());
  const github = trackedGithub(store, profile);
  const clk = clock('2026-10-24T02:00:00.000Z');
  const [first, second] = await Promise.all([
    capture(['start', '--issue', `${REPO}#1`], { github, profile, now: clk.now }),
    capture(['start', '--issue', `${REPO}#1`], { github, profile, now: clk.now }),
  ]);
  assert.deepEqual([first.code, second.code].sort((a, b) => a - b), [EXIT.OK, EXIT.NOTHING]);
  assert.equal(github._writes.filter((action) => action.type === 'comment.create').length, 1);
});

test('SC6 真进程并发 start：退出码只可能是 0 和 3，评论只有一条', async () => {
  const { home } = writeProfile(tmpDir());
  const binDir = path.join(home, 'bin');
  const stateFile = path.join(home, 'gh-state.json');
  writeStatefulGh(binDir, stateFile);
  const env = {
    ...process.env,
    PATH: `${binDir}:${path.dirname(process.execPath)}:${process.env.PATH}`,
    ACCEPTANCE_WATCHER_HOME: home,
  };
  const args = [ROUND_BIN, 'start', '--issue', `${REPO}#1`];
  const [first, second] = await Promise.all([
    runChild(process.execPath, args, env),
    runChild(process.execPath, args, env),
  ]);
  assert.deepEqual(
    [first.code, second.code].sort((a, b) => a - b),
    [EXIT.OK, EXIT.NOTHING],
    `first=${first.code} ${first.stderr}\nsecond=${second.code} ${second.stderr}`,
  );
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(
    state.comments.filter((comment) => String(comment.body).startsWith('[验收机]')).length,
    1,
  );
});

test('status --json 带上最近一轮的中断原因（宿主据此认出「环境问题 / 未验证」）', async () => {
  const { profile } = loadHome();
  const reason = '环境问题（不是代码不通过）：必需检查因环境原因没跑：测试。这一轮未验证，不判「通过」';
  const store = issueStore(
    standaloneIssue({
      comments: [roundComment({ round: 1, status: '中断', finishedAt: '2026-10-24T01:05:00.000Z', reason })],
    }),
  );
  const github = trackedGithub(store, profile);
  const result = await capture(['status', '--issue', `${REPO}#1`, '--json'], {
    github,
    profile,
    now: () => Date.parse('2026-10-24T01:10:00.000Z'),
  });
  assert.equal(result.code, EXIT.OK, result.stderr);
  const json = JSON.parse(result.stdout.trim());
  assert.equal(json.status, '中断');
  assert.equal(json.reason, reason);
});
