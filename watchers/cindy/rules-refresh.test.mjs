import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyDispatchReceipt, dispatchParams, normalizePollSnapshot, pollFingerprint, rulesHeader, rulesVersion, rulesVersionOf, scanOnce, watcherPaths } from './bin/cindy-watcher.mjs';
import { readPr, writePr } from './bin/cindy-state.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const nodeId = 'PR_790';
const listed = { number: 790, id: nodeId, headRefOid: HEAD, headRefName: 'fix/x', title: 'fix', isDraft: false, labels: [],
  isCrossRepository: true, headRepositoryOwner: { login: 'owner' }, headRepository: { name: 'cindy-fork' } };
const graphqlNode = () => ({
  state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, mergeable: 'MERGEABLE',
  labels: { nodes: [] }, comments: { totalCount: 0, nodes: [] }, reviews: { totalCount: 0, nodes: [] },
  reviewThreads: { nodes: [] }, commits: { nodes: [] },
});
const SNAP_FINGERPRINT = pollFingerprint(normalizePollSnapshot({ data: { node: graphqlNode() } }));

function homeOf(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-refresh-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = watcherPaths(home);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

// A bound PR whose snapshot has not changed since the last round: the poll itself does nothing.
function seedBound(paths, extra = {}) {
  writePr(paths.home, nodeId, {
    number: 790, nodeId, sessionId: 'sess-790', claimedAt: '2026-10-15T00:00:00Z',
    eligibilityInitialized: true, eligibility: 'active', admissionVerified: true, admissionEpoch: 'e',
    activeTask: { status: 'complete' }, headRefName: 'fix/x', title: '#790-fix丨1015', pollFingerprint: SNAP_FINGERPRINT, ...extra,
  });
}

function discover(t, paths, dispatchFn) {
  const plugin = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-refresh-plugin-'));
  t.after(() => fs.rmSync(plugin, { recursive: true, force: true }));
  return scanOnce({
    mode: 'discover', enabled: true, allowDispatch: true, paths, now: '2026-10-16T00:00:00Z',
    gitFn: () => '', env: { CINDY_WATCHER_REPO: plugin },
    ghFn: (args) => {
      if (args[0] === 'api' && args[1] === 'user') return 'owner';
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify([listed]);
      if (args[0] === 'api' && args[1] === 'graphql') return JSON.stringify({ data: { node: graphqlNode() } });
      return '[]';
    },
    collect: () => { throw new Error('an unchanged bound PR is not collected'); },
    dispatchFn,
  });
}

test('every delivery opens with the rules version and says it overrides earlier rules', () => {
  const version = rulesVersion();
  assert.match(version, /^[0-9a-f]{12}$/);
  const { message } = dispatchParams({ pr: { number: 7, id: 'PR_7', headRefOid: HEAD, title: 't' }, mapping: {}, fresh: [],
    now: '2026-10-16T00:00:00Z', taskPath: '/h/state/tasks/x.json', home: '/h' });
  assert.equal(rulesVersionOf(message), version);
  assert.match(message, /覆盖本会话此前收到的任何规则/);
  assert.equal(rulesVersionOf(rulesHeader('0123456789ab')), '0123456789ab');
  assert.equal(rulesVersionOf('no header'), null);
});

test('a successor delivery still opens with the current version, not one quoted from an older task', () => {
  const stale = rulesHeader('0123456789ab');
  const { message } = dispatchParams({ pr: { number: 7, id: 'PR_7', headRefOid: HEAD, title: 't' }, mapping: { title: 't' }, fresh: [],
    now: '2026-10-16T00:00:00Z', taskPath: '/h/state/tasks/x.json', home: '/h', messagePrefix: `接班说明，前任摘要：${stale}\nold task` });
  assert.ok(message.startsWith(rulesHeader(rulesVersion())), message.split('\n')[0]);
  assert.equal(rulesVersionOf(message), rulesVersion());
  assert.equal(rulesVersionOf(`接班说明\n${stale}`), null);
});

test('a receipt records the rules version of the message that was actually delivered', (t) => {
  const paths = homeOf(t);
  const pr = { id: nodeId, number: 790, headRefOid: HEAD, headRefName: 'fix/x', url: 'u' };
  for (const [message, expected] of [[`${rulesHeader('0123456789ab')}\nold task`, '0123456789ab'], [dispatchParams({ pr, mapping: { title: 't' }, fresh: [],
    now: '2026-10-16T00:00:00Z', taskPath: '/t.json', home: '/h' }).message, rulesVersion()]]) {
    writePr(paths.home, nodeId, { number: 790, nodeId, pendingDispatch: { dispatchId: 'd1', params: { message } } });
    const state = { version: 2, prs: { [nodeId]: readPr(paths.home, nodeId) } };
    applyDispatchReceipt({ state, pr, mapping: { title: 't' }, receipt: { target_session_id: 'sess-790', dispatch_id: 'd1' }, now: '2026-10-16T00:00:00Z', paths });
    assert.equal(state.prs[nodeId].rulesVersion, expected);
  }
});

test('an idle bound session with older rules gets the current rules once', (t) => {
  const paths = homeOf(t);
  seedBound(paths, { rulesVersion: '0123456789ab' });
  const calls = [];
  const dispatchFn = (params) => { calls.push(params); return { target_session_id: 'sess-790' }; };
  const first = discover(t, paths, dispatchFn);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].target_session_id, 'sess-790');
  assert.match(calls[0].message, /这不是新任务/);
  assert.equal(rulesVersionOf(calls[0].message), rulesVersion());
  assert.equal(first.prs[0].rulesRefresh, 'rules-refreshed');
  const entry = readPr(paths.home, nodeId);
  assert.equal(entry.rulesVersion, rulesVersion());
  assert.equal(entry.repairRounds, undefined, 'a rules refresh is not a repair round');
  assert.equal(entry.activeTask.status, 'complete');
  discover(t, paths, dispatchFn);
  assert.equal(calls.length, 1, 'the same version is not sent twice');
});

test('a session with a task running, pending feedback or a merge-ready PR is not refreshed', (t) => {
  for (const extra of [{ activeTask: { status: 'accepted' } }, { activeTask: { status: 'running' } }, { pendingFeedback: 1 },
    { mergeReady: true }, { pendingDispatch: { dispatchId: 'd', status: 'retryable' } }]) {
    const paths = homeOf(t);
    seedBound(paths, extra);
    const calls = [];
    discover(t, paths, (params) => { calls.push(params); return { target_session_id: 'sess-790' }; });
    assert.equal(calls.length, 0, JSON.stringify(extra));
    assert.equal(readPr(paths.home, nodeId).rulesVersion, undefined);
  }
});

test('a refresh that fails is retried at most three times per rules version', (t) => {
  const paths = homeOf(t);
  seedBound(paths);
  let calls = 0;
  const dispatchFn = () => { calls += 1; throw new Error('INTERNAL: host busy'); };
  for (let round = 0; round < 5; round += 1) discover(t, paths, dispatchFn);
  assert.equal(calls, 3);
  const entry = readPr(paths.home, nodeId);
  assert.equal(entry.rulesVersion, undefined);
  assert.deepEqual([entry.rulesRefresh.version, entry.rulesRefresh.attempts], [rulesVersion(), 3]);
  assert.match(entry.rulesRefresh.error, /host busy/);
});
