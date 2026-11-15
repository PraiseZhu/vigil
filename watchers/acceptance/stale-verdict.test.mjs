import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { cachePath } from './bin/rounds.mjs';
import { sessionPath } from './bin/push.mjs';
import { hostPaths } from './host/paths.mjs';
import {
  abortFoundFinalVerdict,
  killedByRestart,
  ledgerVerdict,
  loadLedgerEntries,
  localRoundVerdict,
  parseCloseKey,
  parseFinishKey,
  staleAbortReason,
} from './bin/stale-verdict.mjs';
import { OWNER, REPO, tmpDir, writeProfile } from './fake-gh.fixture.mjs';

const ISSUE = `${REPO}#1`;
const NOW = Date.parse('2026-10-24T02:00:00.000Z');

function appendLedger(home, entries) {
  const file = hostPaths(home).ledgerFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const entry of entries) {
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  }
}

test('parseFinishKey / parseCloseKey 只认完整去重键', () => {
  assert.deepEqual(parseFinishKey(`round-finish:${ISSUE}:2:1002:通过`), {
    issue: ISSUE,
    round: 2,
    commentId: 1002,
    status: '通过',
  });
  assert.deepEqual(parseFinishKey(`round-finish:${ISSUE}:3:1003:待人工`), {
    issue: ISSUE,
    round: 3,
    commentId: 1003,
    status: '待人工',
  });
  assert.deepEqual(parseCloseKey(`close:${ISSUE}:2`), { issue: ISSUE, round: 2 });
  assert.equal(parseFinishKey(`round-start:${ISSUE}:2:2026-10-24T01:00:00.000Z`), null);
  assert.equal(parseCloseKey(`round-finish:${ISSUE}:2:1002:通过`), null);
});

test('ledger：通过结论、关单都算已完成；同号重认领后的旧关单不算', () => {
  const finish = ledgerVerdict(
    [{ dedupeKey: `round-finish:${ISSUE}:1:1001:通过`, type: 'comment.update', at: '2026-10-24T01:50:00.000Z' }],
    ISSUE,
    1,
    { commentId: 1001 },
  );
  assert.equal(finish.source, 'ledger');
  assert.equal(finish.status, '通过');
  assert.equal(finish.closed, false);

  const closed = ledgerVerdict(
    [{ dedupeKey: `close:${ISSUE}:1`, type: 'issue.close', at: '2026-10-24T01:51:00.000Z' }],
    ISSUE,
    1,
  );
  assert.equal(closed.closed, true);
  assert.equal(closed.source, 'ledger');

  const reclaimed = ledgerVerdict(
    [
      { dedupeKey: `close:${ISSUE}:1`, type: 'issue.close', at: '2026-10-24T01:10:00.000Z' },
      { dedupeKey: `round-start:${ISSUE}:1:2026-10-24T01:40:00.000Z`, type: 'comment.create', at: '2026-10-24T01:40:00.000Z' },
    ],
    ISSUE,
    1,
  );
  assert.equal(reclaimed, null);

  const otherComment = ledgerVerdict(
    [{ dedupeKey: `round-finish:${ISSUE}:1:1001:通过`, type: 'comment.update' }],
    ISSUE,
    1,
    { commentId: 2002 },
  );
  assert.equal(otherComment, null);
});

test('localRoundVerdict 读账本 / 缓存 / session / 快照，不需要 GitHub', () => {
  const { home, profile } = writeProfile(tmpDir());
  const paths = hostPaths(home);
  assert.equal(localRoundVerdict(ISSUE, 1, { paths, profile }), null);

  appendLedger(home, [
    { dedupeKey: `round-finish:${ISSUE}:1:1001:通过`, type: 'comment.update', at: '2026-10-24T01:50:00.000Z' },
  ]);
  const fromLedger = localRoundVerdict(ISSUE, 1, { paths, profile, commentId: 1001 });
  assert.equal(fromLedger.source, 'ledger');
  assert.equal(fromLedger.status, '通过');
  assert.equal(loadLedgerEntries(paths).length, 1);

  const otherHome = writeProfile(tmpDir());
  fs.mkdirSync(path.dirname(cachePath(otherHome.profile, ISSUE)), { recursive: true });
  fs.writeFileSync(
    cachePath(otherHome.profile, ISSUE),
    JSON.stringify({ round: { round: 1, commentId: 1001, finishedAt: '2026-10-24T01:50:00.000Z' }, lastVerdict: '要修' }),
  );
  const fromCache = localRoundVerdict(ISSUE, 1, { paths: hostPaths(otherHome.home), profile: otherHome.profile });
  assert.equal(fromCache.source, 'cache');
  assert.equal(fromCache.status, '要修');

  const sessionHome = writeProfile(tmpDir());
  const sessionFile = sessionPath(sessionHome.profile, ISSUE);
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify({ round: 1, doneAt: '2026-10-24T01:52:00.000Z' }));
  const fromSession = localRoundVerdict(ISSUE, 1, { paths: hostPaths(sessionHome.home), profile: sessionHome.profile });
  assert.equal(fromSession.source, 'session');
  // 别的轮次的 done 标记不算。
  assert.equal(localRoundVerdict(ISSUE, 2, { paths: hostPaths(sessionHome.home), profile: sessionHome.profile }), null);

  const fromClosedSnapshot = localRoundVerdict(ISSUE, 1, {
    paths: hostPaths(writeProfile(tmpDir()).home),
    task: { ref: ISSUE, state: 'closed', rounds: [{ round: 1, status: '验收中' }] },
  });
  assert.equal(fromClosedSnapshot.source, 'snapshot');
  assert.equal(fromClosedSnapshot.closed, true);

  const fromOpenVerdict = localRoundVerdict(ISSUE, 1, {
    task: { ref: ISSUE, state: 'open', rounds: [{ round: 1, status: '通过' }] },
  });
  assert.equal(fromOpenVerdict.source, 'snapshot');
  assert.equal(fromOpenVerdict.status, '通过');
  assert.equal(fromOpenVerdict.closed, false);
});

test('killedByRestart：开始时间早于本次开机才算；缺数据不算', () => {
  assert.equal(killedByRestart({ startedAt: '2026-10-24T01:00:00.000Z', nowMs: NOW, uptimeS: 600 }), true);
  assert.equal(killedByRestart({ startedAt: '2026-10-24T01:00:00.000Z', nowMs: NOW, uptimeS: 86400 }), false);
  assert.equal(killedByRestart({ startedAt: '2026-10-24T01:00:00.000Z', nowMs: NOW, uptimeS: NaN }), false);
  assert.equal(killedByRestart({ startedAt: '', nowMs: NOW, uptimeS: 600 }), false);
});

test('staleAbortReason / abortFoundFinalVerdict 区分重启中断和已出结论', () => {
  assert.equal(staleAbortReason({}), '卡死：进程不在');
  assert.equal(staleAbortReason({ processAlive: true }), '卡死：已结束进程');
  assert.equal(staleAbortReason({ restartKill: true }), '重启中断：进程不在');
  assert.equal(staleAbortReason({ processAlive: true, restartKill: true }), '卡死：已结束进程');
  assert.equal(
    abortFoundFinalVerdict('认领检查失败：期望第 1 轮（验收中），实际第 1 轮（通过）。'),
    '通过',
  );
  assert.equal(
    abortFoundFinalVerdict('认领检查失败：期望第 1 轮（验收中），实际第 1 轮（待人工）。'),
    '待人工',
  );
  assert.equal(abortFoundFinalVerdict('认领检查失败：期望第 1 轮（验收中），实际没有轮次'), null);
  void OWNER;
});
