import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUDIT_SCHEMA,
  appendDeployAudit,
  defaultAuditLogPath,
  readDeployAudit,
} from './deploy-audit.mjs';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-audit-'));
}

test('追加两行不覆盖旧记录，读回字段完整', () => {
  const dir = tmp();
  const file = path.join(dir, 'deploy-ff-audit.jsonl');
  const first = appendDeployAudit(file, {
    ts: '2026-11-14T12:00:00.000Z',
    attemptId: 'one',
    outcome: 'rejected',
    previousSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    commits: ['b'.repeat(40)],
    sensitiveFiles: ['watchers/acceptance/host/note.mjs'],
    sensitiveRuleVersion: 'deploy-ff-sensitive/v2',
    grantSource: { ids: ['t710u', 't711u'] },
    grantScope: 'deploy-after-independent-verification',
    independentVerification: null,
    workspaceChanged: false,
    autoRollback: false,
  });
  const second = appendDeployAudit(file, {
    ts: '2026-11-14T12:01:00.000Z',
    attemptId: 'two',
    outcome: 'attempt',
    previousSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    commits: ['b'.repeat(40)],
    workspaceChanged: false,
  });
  const rows = readDeployAudit(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].schema, AUDIT_SCHEMA);
  assert.equal(rows[0].attemptId, 'one');
  assert.equal(rows[0].outcome, 'rejected');
  assert.equal(rows[1].attemptId, 'two');
  assert.equal(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 2);
  assert.equal(first.attemptId, 'one');
  assert.equal(second.attemptId, 'two');
});

test('缺路径或写失败抛错，调用方据此失败关闭', () => {
  assert.throws(() => appendDeployAudit(null, { outcome: 'attempt' }), /audit-log-missing/);
  const dir = tmp();
  const asDir = path.join(dir, 'not-a-file');
  fs.mkdirSync(asDir);
  assert.throws(() => appendDeployAudit(asDir, { outcome: 'attempt' }));
});

test('默认审计路径在状态文件旁边，不覆盖状态文件', () => {
  const dir = tmp();
  const state = path.join(dir, 'deploy-ff.json');
  fs.writeFileSync(state, '{"keep":true}\n');
  assert.equal(defaultAuditLogPath(state), path.join(dir, 'deploy-ff-audit.jsonl'));
  appendDeployAudit(defaultAuditLogPath(state), { outcome: 'attempt', attemptId: 'x' });
  assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).keep, true);
  assert.equal(readDeployAudit(defaultAuditLogPath(state)).length, 1);
});
