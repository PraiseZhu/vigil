import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createGithub } from './bin/github.mjs';
import { loadAcceptanceProfile } from './bin/profile.mjs';
import { createRounds, parseRounds, latestRound, RoundError, lockPath, cachePath } from './bin/rounds.mjs';
import { bodyVersion } from './bin/tasks.mjs';
import {
  OWNER,
  REPO,
  createFakeRun,
  issueNode,
  roundComment,
  tmpDir,
  writeProfile,
} from './fake-gh.fixture.mjs';

function loadHome(extra = {}) {
  const { home } = writeProfile(tmpDir(), extra);
  const profile = loadAcceptanceProfile({ ACCEPTANCE_WATCHER_HOME: home });
  return { home, profile };
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

function githubFor(store, profile) {
  let commentSeq = 5000;
  const run = createFakeRun({
    onGraphql: (payload) => {
      if (String(payload.query).includes('repository(owner')) {
        return { repository: { issue: store.get() } };
      }
      return { user: { open: { nodes: [store.get()], pageInfo: { hasNextPage: false } }, closed: { nodes: [], pageInfo: { hasNextPage: false } } } };
    },
    onApi: (args, { input }) => {
      const body = input ? JSON.parse(input) : {};
      const pathArg = args.find((a) => String(a).startsWith('repos/')) || '';
      if (args.includes('POST') && /issues\/\d+\/comments$/.test(pathArg)) {
        const created = {
          id: ++commentSeq,
          html_url: `https://github.com/${REPO}/issues/${store.get().number}#issuecomment-${commentSeq}`,
        };
        store.addComment({
          id: `IC_${created.id}`,
          databaseId: created.id,
          body: body.body,
          createdAt: '2026-10-24T02:00:00.000Z',
          updatedAt: '2026-10-24T02:00:00.000Z',
          url: created.html_url,
          author: { login: OWNER },
        });
        return created;
      }
      if (args.includes('PATCH') && /issues\/comments\/\d+$/.test(pathArg)) {
        const id = Number(pathArg.split('/').pop());
        store.updateComment(id, body.body);
        return { id, html_url: `https://github.com/${REPO}/issues/1#issuecomment-${id}` };
      }
      return { id: 1 };
    },
  });
  const github = createGithub({ profile, run });
  github._run = run;
  return github;
}

test('SC5 rounds.start 发第 n 轮验收中评论并记下正文版本', async () => {
  const { profile } = loadHome();
  const body = 'task body';
  const existing = roundComment({ round: 2, status: '通过', bodyVersion: bodyVersion(body), finishedAt: '2026-10-20T00:00:00.000Z' });
  const store = issueStore(issueNode({ number: 1, body, comments: [existing] }));
  const github = githubFor(store, profile);
  const writes = [];
  const origWrite = github.write.bind(github);
  github.write = async (action) => {
    writes.push(action);
    return origWrite(action);
  };
  const rounds = createRounds({ github, profile, now: () => Date.parse('2026-10-24T02:00:00.000Z') });
  const started = await rounds.start({
    ref: `${REPO}#1`,
    repo: REPO,
    number: 1,
    kind: 'standalone',
    tier: 'auto',
    children: [],
  });
  assert.equal(started.round, 3);
  assert.equal(started.bodyVersion, bodyVersion(body));
  const created = store.get().comments.nodes.at(-1);
  assert.match(created.body.split('\n')[0], /\[验收机\] 第 3 轮：验收中/);
  assert.match(created.body, new RegExp(`正文版本：${bodyVersion(body)}`));
  assert.equal(writes[0].type, 'comment.create');
  assert.equal(writes[0].dedupeKey, `round-start:${REPO}#1:3`);
});

test('SC5 rounds.finish 把评论就地改成通过、要修或中断', async () => {
  const { profile } = loadHome();
  const body = 'task body';
  const existing = roundComment({ round: 1, status: '验收中', bodyVersion: bodyVersion(body), databaseId: 42 });
  const store = issueStore(issueNode({ number: 1, body, comments: [existing] }));
  const github = githubFor(store, profile);
  const rounds = createRounds({ github, profile, now: () => Date.parse('2026-10-24T03:00:00.000Z') });
  await rounds.finish(`${REPO}#1`, 1, '通过', { detail: 'ok' });
  const updated = store.get().comments.nodes[0];
  assert.match(updated.body.split('\n')[0], /\[验收机\] 第 1 轮：通过/);
  assert.match(updated.body, /完成：/);
  assert.match(updated.body, /ok/);
});

test('SC6 rounds.check 不是第 n 轮或已不是验收中就拒绝，消息写清期望和实际', async () => {
  const { profile } = loadHome();
  const existing = roundComment({ round: 2, status: '通过', finishedAt: '2026-10-20T00:00:00.000Z' });
  const store = issueStore(issueNode({ number: 1, comments: [existing] }));
  const github = githubFor(store, profile);
  const rounds = createRounds({ github, profile });
  await assert.rejects(
    () => rounds.check(`${REPO}#1`, 3),
    (err) => {
      assert.equal(err.code, 'NOT_CURRENT');
      assert.match(err.message, /期望第 3 轮（验收中）/);
      assert.match(err.message, /实际第 2 轮（通过）/);
      return true;
    },
  );
});

test('SC6 rounds.check 实际没有轮次', async () => {
  const { profile } = loadHome();
  const store = issueStore(issueNode({ number: 1, comments: [] }));
  const github = githubFor(store, profile);
  const rounds = createRounds({ github, profile });
  await assert.rejects(() => rounds.check(`${REPO}#1`, 1), /实际没有轮次/);
});

test('SC7 progress 与 done 先过认领检查再写本地状态；缺本地记录时用评论创建时间', async () => {
  const { profile } = loadHome();
  const existing = roundComment({
    round: 1,
    status: '验收中',
    createdAt: '2026-10-24T01:00:00.000Z',
    databaseId: 7,
  });
  const store = issueStore(issueNode({ number: 1, comments: [existing] }));
  const github = githubFor(store, profile);
  const rounds = createRounds({ github, profile, now: () => Date.parse('2026-10-24T01:10:00.000Z') });
  assert.equal(rounds.lastProgressAt(`${REPO}#1`, 1, parseRounds([existing])[0]), '2026-10-24T01:00:00.000Z');
  const stamp = await rounds.progress(`${REPO}#1`, 1);
  assert.equal(stamp, '2026-10-24T01:10:00.000Z');
  assert.equal(rounds.lastProgressAt(`${REPO}#1`, 1, parseRounds([existing])[0]), stamp);
  const doneAt = await rounds.done(`${REPO}#1`, 1);
  const cache = JSON.parse(fs.readFileSync(cachePath(profile, `${REPO}#1`), 'utf8'));
  assert.equal(cache.round.finishedAt, doneAt);
  await assert.rejects(() => rounds.progress(`${REPO}#1`, 9), RoundError);
});

test('SC8 删掉 stateDir 后从 GitHub 重建，不重复开轮', async () => {
  const { profile } = loadHome();
  const body = 'same';
  const existing = roundComment({ round: 4, status: '验收中', bodyVersion: bodyVersion(body) });
  const store = issueStore(issueNode({ number: 1, body, comments: [existing] }));
  const github = githubFor(store, profile);
  const rounds = createRounds({ github, profile, now: () => Date.parse('2026-10-24T02:00:00.000Z') });
  await assert.rejects(() => rounds.start({ ref: `${REPO}#1`, repo: REPO, number: 1, kind: 'standalone', tier: 'auto', children: [] }), /进行中|LOCKED|IN_PROGRESS/);
  fs.rmSync(profile.stateDir, { recursive: true, force: true });
  await assert.rejects(
    () => rounds.start({ ref: `${REPO}#1`, repo: REPO, number: 1, kind: 'standalone', tier: 'auto', children: [] }),
    (err) => err.code === 'IN_PROGRESS' || err.code === 'LOCKED',
  );
  const comments = store.get().comments.nodes.filter((c) => String(c.body).startsWith('[验收机]'));
  assert.equal(comments.length, 1);
});

test('SC8 本地缓存和 GitHub 不一致时以 GitHub 为准', async () => {
  const { profile } = loadHome();
  const existing = roundComment({ round: 2, status: '验收中', databaseId: 88 });
  const store = issueStore(issueNode({ number: 1, comments: [existing] }));
  const github = githubFor(store, profile);
  fs.mkdirSync(cachePath(profile, `${REPO}#1`).replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(
    cachePath(profile, `${REPO}#1`),
    JSON.stringify({ round: { round: 1, commentId: 1, lastProgressAt: 'old' } }),
  );
  const rounds = createRounds({ github, profile });
  const current = await rounds.check(`${REPO}#1`, 2);
  assert.equal(current.round, 2);
  const cache = JSON.parse(fs.readFileSync(cachePath(profile, `${REPO}#1`), 'utf8'));
  assert.equal(cache.round.round, 2);
  assert.equal(cache.round.commentId, 88);
});

test('SC9 同一任务并发两次 rounds.start 只有一次成功', async () => {
  const { profile } = loadHome();
  const store = issueStore(issueNode({ number: 1, comments: [] }));
  const github = githubFor(store, profile);
  const rounds = createRounds({ github, profile, now: () => Date.parse('2026-10-24T02:00:00.000Z') });
  const task = { ref: `${REPO}#1`, repo: REPO, number: 1, kind: 'standalone', tier: 'auto', children: [] };
  const results = await Promise.allSettled([rounds.start(task), rounds.start(task)]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'LOCKED');
});

test('parseRounds 忽略非轮次评论并按轮次号排序', () => {
  const comments = [
    { body: 'hello', createdAt: '2026-10-24T00:00:00.000Z', databaseId: 1 },
    roundComment({ round: 2, status: '通过', createdAt: '2026-10-24T02:00:00.000Z' }),
    roundComment({ round: 1, status: '要修', createdAt: '2026-10-24T01:00:00.000Z' }),
  ];
  const rounds = parseRounds(comments);
  assert.deepEqual(rounds.map((r) => r.round), [1, 2]);
  assert.equal(latestRound(rounds).round, 2);
});

test('stale lock 可被替换', async () => {
  const { profile } = loadHome();
  const store = issueStore(issueNode({ number: 1, comments: [] }));
  const github = githubFor(store, profile);
  const file = lockPath(profile, `${REPO}#1`);
  fs.mkdirSync(file.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ round: 1, createdAt: '2026-10-24T00:00:00.000Z', pid: 1 }));
  const rounds = createRounds({ github, profile, now: () => Date.parse('2026-10-24T00:20:00.000Z') });
  const started = await rounds.start({ ref: `${REPO}#1`, repo: REPO, number: 1, kind: 'standalone', tier: 'auto', children: [] });
  assert.equal(started.round, 1);
});

test('SC9 锁文件刚建还没写完（读不出）时算被占用，不当成过期锁', async () => {
  const { profile } = loadHome();
  const store = issueStore(issueNode({ number: 1, comments: [] }));
  const github = githubFor(store, profile);
  const file = lockPath(profile, `${REPO}#1`);
  fs.mkdirSync(file.replace(/\/[^/]+$/, ''), { recursive: true });
  fs.writeFileSync(file, '');
  const rounds = createRounds({ github, profile, now: () => Date.now() });
  const task = { ref: `${REPO}#1`, repo: REPO, number: 1, kind: 'standalone', tier: 'auto', children: [] };
  await assert.rejects(rounds.start(task), (err) => err.code === 'LOCKED');
  // 10 分钟后仍读不出才当过期锁接管
  const later = createRounds({ github, profile, now: () => Date.now() + 11 * 60 * 1000 });
  const started = await later.start(task);
  assert.equal(started.round, 1);
});
