import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { consumeResult, reopenInfraBlocked } from './bin/mivo-watcher.mjs';

const BLOCK = {
  validatedHead: 'a'.repeat(40), policySha256: 'p'.repeat(64), runtimeSha256: 'r'.repeat(64),
  failureSetState: 'parsed', failureSetSha256: 'f'.repeat(64), receiptSha256: '1'.repeat(64),
  remoteHead: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
};
const CURRENT = { policySha256: BLOCK.policySha256, runtimeSha256: BLOCK.runtimeSha256, receiptSha256: BLOCK.receiptSha256,
  failureSetState: 'parsed', failureSetSha256: BLOCK.failureSetSha256 };

function setup(t, { block = BLOCK, reason = 'local preflight failed', extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-reopen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = { stateDir: dir };
  fs.mkdirSync(path.join(dir, 'tasks'));
  fs.writeFileSync(path.join(dir, 'tasks', 'd1.json'), JSON.stringify({ nodeId: 'PR_1', feedback: [{ key: 'thread:1' }] }));
  const previous = {
    nodeId: 'PR_1', number: 1, headRefOid: BLOCK.remoteHead, baseRefOid: BLOCK.baseRefOid, admissionEpoch: 'e1',
    feedbackCursor: { 'thread:1': 'stamp' }, repairRounds: 2, eligibility: 'blocked',
    activeTask: { dispatchId: 'd1', status: 'blocked', blockedKind: 'external', reason, head: BLOCK.remoteHead, ...(block ? { validationBlock: block } : {}) },
    ...extra,
  };
  return { paths, previous };
}

test('SC7 全部未变：零派发，previous 原样返回、计数不变，反复调用也不消耗每代次上限', (t) => {
  const { paths, previous } = setup(t);
  const snapshot = structuredClone(previous);
  for (let i = 0; i < 5; i++) {
    const next = reopenInfraBlocked({ previous, paths, now: '2026-10-24T00:00:00Z', observe: () => ({ ...CURRENT }) });
    assert.equal(next, previous);
  }
  assert.deepEqual(previous, snapshot);
  assert.equal(previous.infraReopened, undefined);
});

for (const [name, mutate] of [
  ['远端 head', (ctx) => ({ ...ctx, previousPatch: { headRefOid: 'c'.repeat(40) } })],
  ['base', (ctx) => ({ ...ctx, previousPatch: { baseRefOid: 'd'.repeat(40) } })],
  ['policy sha256', (ctx) => ({ ...ctx, policySha256: 'q'.repeat(64) })],
  ['运行指纹', (ctx) => ({ ...ctx, runtimeSha256: 's'.repeat(64) })],
  ['失败集合', (ctx) => ({ ...ctx, receiptSha256: '2'.repeat(64), failureSetSha256: 'e'.repeat(64) })],
  ['新的 unparsed 失败证据', (ctx) => ({ ...ctx, receiptSha256: '3'.repeat(64), failureSetState: 'unparsed', failureSetSha256: null })],
]) {
  test(`SC7 ${name}变化：照常重开（清游标、退还一轮、记录 infraReopened）`, (t) => {
    const { paths, previous } = setup(t);
    const { previousPatch, ...observed } = mutate({ ...CURRENT });
    const next = reopenInfraBlocked({ previous: { ...previous, ...previousPatch }, paths, now: '2026-10-24T00:00:00Z', observe: () => observed });
    assert.equal(next.eligibility, 'active', name);
    assert.equal(next.infraReopened.length, 1);
    assert.equal(next.repairRounds, 1);
    assert.equal(next.feedbackCursor['thread:1'], undefined);
  });
}

test('SC7 新失败收据但失败集合完全相同：仍视为未变', (t) => {
  const { paths, previous } = setup(t);
  const next = reopenInfraBlocked({ previous, paths, now: '2026-10-24T00:00:00Z', observe: () => ({ ...CURRENT, receiptSha256: '9'.repeat(64) }) });
  assert.equal(next, previous);
});

test('SC7 本机观测不到 policy/运行指纹（unknown）：保持 blocked，不重投', (t) => {
  const { paths, previous } = setup(t);
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null }), previous);
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => ({ ...CURRENT, policySha256: null }) }), previous);
});

test('SC7 旧 blocked 没有 validationBlock：head 没变不重投，head 变了才重开', (t) => {
  const { paths, previous } = setup(t, { block: null });
  assert.equal(reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null }), previous);
  const next = reopenInfraBlocked({ previous: { ...previous, headRefOid: 'c'.repeat(40) }, paths, now: 'n', observe: () => null });
  assert.equal(next.eligibility, 'active');
});

test('SC7 非 validate 类的 infra 阻塞保持原有重开规则', (t) => {
  const { paths, previous } = setup(t, { block: null, reason: 'submodule update failed' });
  const next = reopenInfraBlocked({ previous, paths, now: 'n', observe: () => null });
  assert.equal(next.eligibility, 'active');
  assert.equal(next.infraReopened.length, 1);
});

test('SC7 consumeResult 把验证阻塞上下文连同当时的远端 head/base 带进 activeTask', () => {
  const previous = { nodeId: 'PR_1', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40), activeTask: { dispatchId: 'd1' } };
  const { remoteHead, baseRefOid, ...block } = BLOCK;
  const next = consumeResult(previous, { schemaVersion: 2, status: 'blocked', blockedKind: 'external', reason: 'local preflight failed',
    dispatchId: 'd1', sessionId: 's', head: 'a'.repeat(40), validationBlock: block }, 'now');
  assert.deepEqual(next.activeTask.validationBlock, { ...block, remoteHead: 'a'.repeat(40), baseRefOid: 'b'.repeat(40) });
});
