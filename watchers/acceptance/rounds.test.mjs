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
  // 去重键带开始时间（北京时间）：同号再认领（旧评论被删后）不会命中旧账本记录。
  assert.equal(writes[0].dedupeKey, `round-start:${REPO}#1:3:2026-10-24T10:00:00+08:00`);
  assert.match(created.body, /^开始：2026-10-24T10:00:00\+08:00$/m);
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
  assert.equal(rounds.lastProgressAt(`${REPO}#1`, 1, parseRounds([existing], OWNER)[0]), '2026-10-24T01:00:00.000Z');
  const stamp = await rounds.progress(`${REPO}#1`, 1);
  assert.equal(stamp, '2026-10-24T09:10:00+08:00');
  assert.equal(rounds.lastProgressAt(`${REPO}#1`, 1, parseRounds([existing], OWNER)[0]), stamp);
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
  const rounds = parseRounds(comments, OWNER);
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

// ---- 伪造轮次评论：公开仓上任何人都能发同样首行的评论，只认 ownerLogin 发的 ----
const STRANGER = 'SomeStranger';

test('安全 parseRounds 不传 ownerLogin 直接抛错，别人发的轮次评论一律忽略', () => {
  const mine = roundComment({ round: 1, status: '要修', finishedAt: '2026-10-24T01:30:00.000Z' });
  const forged = roundComment({ round: 9999, status: '通过', author: STRANGER, databaseId: 77 });
  assert.throws(() => parseRounds([mine]), /ownerLogin/);
  const rounds = parseRounds([mine, forged, { ...forged, author: null, databaseId: 78 }], OWNER);
  assert.deepEqual(rounds.map((r) => [r.round, r.status]), [[1, '要修']]);
  // 大小写不同的同一账号仍然认
  assert.equal(parseRounds([roundComment({ author: OWNER.toUpperCase() })], OWNER).length, 1);
});

test('安全 rounds.start：别人伪造的「验收中」不挡认领，伪造的超大轮次号不影响编号', async () => {
  const { profile } = loadHome();
  const store = issueStore(
    issueNode({
      number: 1,
      comments: [
        roundComment({ round: 1, status: '要修', finishedAt: '2026-10-20T00:00:00.000Z' }),
        roundComment({ round: 999999, status: '验收中', author: STRANGER, databaseId: 4242 }),
      ],
    }),
  );
  const github = githubFor(store, profile);
  const rounds = createRounds({ github, profile, now: () => Date.parse('2026-10-24T02:00:00.000Z') });
  const started = await rounds.start({ ref: `${REPO}#1`, repo: REPO, number: 1, kind: 'standalone', tier: 'auto', children: [] });
  assert.equal(started.round, 2);
});

test('安全 rounds.check / finish：别人伪造的更新轮次评论不顶掉本轮，也不会被就地改写', async () => {
  const { profile } = loadHome();
  const mine = roundComment({ round: 2, status: '验收中', databaseId: 2002, createdAt: '2026-10-24T01:00:00.000Z' });
  const forged = roundComment({
    round: 3,
    status: '通过',
    author: STRANGER,
    databaseId: 3003,
    createdAt: '2026-10-24T01:10:00.000Z',
    finishedAt: '2026-10-24T01:10:00.000Z',
  });
  const store = issueStore(issueNode({ number: 1, comments: [mine, forged] }));
  const github = githubFor(store, profile);
  const patched = [];
  const origWrite = github.write.bind(github);
  github.write = async (action) => {
    if (action.type === 'comment.update') patched.push(action.commentId);
    return origWrite(action);
  };
  const rounds = createRounds({ github, profile, now: () => Date.parse('2026-10-24T01:20:00.000Z') });
  const current = await rounds.check(`${REPO}#1`, 2);
  assert.equal(current.commentId, 2002);
  await assert.rejects(rounds.check(`${REPO}#1`, 3), (err) => err.code === 'NOT_CURRENT');
  await rounds.finish(`${REPO}#1`, 2, '中断', { reason: '测试' });
  assert.deepEqual(patched, [2002]);
  const forgedAfter = store.get().comments.nodes.find((c) => c.databaseId === 3003);
  assert.match(forgedAfter.body, /第 3 轮：通过/);
});

function roundRow(round, status, createdAt, commentId) {
  return { round, status, createdAt, commentId };
}

test('latestRound 按轮次号：createdAt 反序', () => {
  const rounds = [
    roundRow(1, '要修', '2026-11-01T12:00:00.000Z', 11),
    roundRow(2, '通过', '2026-11-01T11:00:00.000Z', 22),
    roundRow(3, '验收中', '2026-11-01T10:00:00.000Z', 33),
  ];
  const latest = latestRound(rounds);
  assert.equal(latest.round, 3);
  assert.equal(latest.status, '验收中');
  assert.equal(latest.commentId, 33);
});

test('latestRound 一小时偏差下第 3 轮仍最新', () => {
  // #191：第 3 轮 createdAt 09:07:54Z，第 2 轮 09:58:00Z。时钟偏差让第 3 轮显得更早。
  const rounds = [
    roundRow(2, '通过', '2026-11-01T09:58:00.000Z', 202),
    roundRow(3, '验收中', '2026-11-01T09:07:54.000Z', 303),
  ];
  const latest = latestRound(rounds);
  assert.equal(latest.round, 3);
  assert.equal(latest.status, '验收中');
  assert.equal(latest.commentId, 303);
});

test('latestRound 输入乱序', () => {
  const rounds = [
    roundRow(2, '通过', '2026-11-01T08:00:00.000Z', 2),
    roundRow(3, '验收中', '2026-11-01T07:00:00.000Z', 3),
    roundRow(1, '要修', '2026-11-01T09:00:00.000Z', 1),
  ];
  const latest = latestRound(rounds);
  assert.equal(latest.round, 3);
  assert.equal(latest.status, '验收中');
});

test('latestRound 同轮重复评论取 databaseId 最大', () => {
  const comments = [
    roundComment({
      round: 2,
      status: '验收中',
      databaseId: 50,
      createdAt: '2026-11-01T10:00:00.000Z',
      id: 'IC_early_id',
    }),
    roundComment({
      round: 2,
      status: '通过',
      databaseId: 80,
      createdAt: '2026-11-01T09:00:00.000Z',
      id: 'IC_late_id',
    }),
  ];
  const latest = latestRound(parseRounds(comments, OWNER));
  assert.equal(latest.commentId, 80);
  assert.equal(latest.status, '通过');
  assert.equal(latest.round, 2);
});

test('latestRound 同轮 commentId 缺失时有 id 的优先，都缺失取输入最后一条', () => {
  const withId = latestRound(parseRounds([
    roundComment({
      round: 2,
      status: '通过',
      databaseId: null,
      createdAt: '2026-11-01T12:00:00.000Z',
      id: 'IC_no_id',
    }),
    roundComment({
      round: 2,
      status: '要修',
      databaseId: 10,
      createdAt: '2026-11-01T08:00:00.000Z',
      id: 'IC_has_id',
    }),
  ], OWNER));
  assert.equal(withId.commentId, 10);
  assert.equal(withId.status, '要修');

  const bothMissing = latestRound([
    roundRow(4, '验收中', '2026-11-01T12:00:00.000Z', null),
    roundRow(4, '通过', '2026-11-01T08:00:00.000Z', undefined),
  ]);
  assert.equal(bothMissing.status, '通过');
  assert.equal(bothMissing.round, 4);
});

test('latestRound 不合法轮次号', () => {
  const valid = roundRow(4, '要修', '2026-11-01T01:00:00.000Z', 4);
  const illegal = [
    { status: '通过', createdAt: '2026-11-01T09:00:00.000Z', commentId: 91 },
    roundRow(undefined, '通过', '2026-11-01T09:00:00.000Z', 92),
    roundRow(null, '通过', '2026-11-01T09:00:00.000Z', 93),
    roundRow(NaN, '通过', '2026-11-01T09:00:00.000Z', 94),
    roundRow(0, '通过', '2026-11-01T09:00:00.000Z', 95),
    roundRow(-3, '通过', '2026-11-01T09:00:00.000Z', 96),
    roundRow(1.5, '通过', '2026-11-01T09:00:00.000Z', 97),
    roundRow(Number.POSITIVE_INFINITY, '通过', '2026-11-01T09:00:00.000Z', 98),
    roundRow('3', '通过', '2026-11-01T09:00:00.000Z', 99),
  ];
  const latest = latestRound([...illegal, valid]);
  assert.equal(latest.round, 4);
  assert.equal(latest.status, '要修');
  assert.equal(latestRound(illegal), null);
  assert.equal(latestRound([]), null);
  assert.equal(latestRound(null), null);
  assert.equal(latestRound(undefined), null);
});
