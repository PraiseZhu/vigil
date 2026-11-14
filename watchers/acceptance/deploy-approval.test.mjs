import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLEET_ROUND_DELEGATION,
  GRANT_SCHEMA,
  JASPER_DECISION,
  evaluateGrant,
} from './deploy-approval.mjs';
import { makeGrant } from './deploy-grant.fixture.mjs';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const BASE = 'a'.repeat(40);
const MID = 'b'.repeat(40);
const TARGET = 'c'.repeat(40);
const RULE = 'deploy-ff-sensitive/v2';
const CTX = {
  targetSha: TARGET,
  baseSha: BASE,
  commits: [MID, TARGET],
  ruleVersion: RULE,
  nowMs: NOW,
};

function grant(overrides = {}) {
  return makeGrant({
    targetSha: TARGET,
    baseSha: BASE,
    commits: [MID, TARGET],
    ruleVersion: RULE,
    nowMs: NOW,
    overrides,
  });
}

function codeOf(record, ctx = CTX) {
  return evaluateGrant(record, ctx).code;
}

test('正例：本轮 t710u+t711u 授予、区间与独验绑定后放行', () => {
  const judged = evaluateGrant(grant(), CTX);
  assert.equal(judged.ok, true);
  assert.equal(judged.code, 'ok');
  assert.equal(judged.snapshot.grantSource.ids.join(','), 't710u,t711u');
  assert.equal(judged.snapshot.jasperVerdict.decision, JASPER_DECISION);
  assert.equal(judged.snapshot.independentVerification.fast, false);
});

test('反例：缺记录、SHA 文本、approved 文本、bot 评论、User 登录名单独', () => {
  assert.equal(codeOf(null), 'missing-record');
  assert.equal(codeOf(TARGET), 'sha-only');
  assert.equal(codeOf('approved'), 'self-approved-text');
  assert.equal(codeOf('APPROVED'), 'self-approved-text');
  assert.equal(codeOf({ approved: true, sha: TARGET }), 'self-approved-text');
  assert.equal(codeOf({ kind: 'bot-comment', body: `${TARGET}\napproved`, authorType: 'Bot' }), 'bot-comment');
  assert.equal(codeOf({
    login: 'ExampleUser',
    type: 'User',
    body: TARGET,
    kind: 'github-comment',
  }), 'github-user-login-only');
  assert.equal(codeOf({
    login: 'ExampleUser',
    type: 'User',
    body: 'deploy this',
  }), 'github-user-login-only');
});

test('反例：旧 SHA、短 SHA、目标或 base 或区间不符', () => {
  assert.equal(codeOf(grant({ targetSha: 'd'.repeat(40) })), 'target-mismatch');
  assert.equal(codeOf(grant({ baseSha: 'd'.repeat(40) })), 'base-mismatch');
  assert.equal(codeOf(grant({ commits: [TARGET] })), 'commits-mismatch');
  assert.equal(codeOf(grant({ targetSha: TARGET.slice(0, 7), jasperVerdict: { targetSha: TARGET.slice(0, 7), decision: JASPER_DECISION, decidedAt: new Date(NOW).toISOString() } })), 'short-sha');
  assert.equal(codeOf(grant(), { ...CTX, commits: [] }), 'commits-mismatch');
});

test('反例：过期、TTL 过长、缺独验、Fast 未关、证据为空、范围扩大', () => {
  assert.equal(codeOf(grant({ expiresAt: new Date(NOW - 1).toISOString() })), 'expired');
  assert.equal(codeOf(grant(), { ...CTX, nowMs: NOW + 12 * 60 * 60 * 1000 }), 'expired');
  assert.equal(codeOf(grant({
    expiresAt: new Date(NOW + FLEET_ROUND_DELEGATION.maxTtlMs + 1).toISOString(),
  })), 'ttl-exceeded');
  assert.equal(codeOf(grant({ independentVerification: null })), 'missing-independent-verification');
  const fastOn = grant();
  fastOn.independentVerification = { ...fastOn.independentVerification, fast: true };
  assert.equal(codeOf(fastOn), 'verification-fast');
  const notPass = grant();
  notPass.independentVerification = { ...notPass.independentVerification, result: 'fail' };
  assert.equal(codeOf(notPass), 'verification-not-pass');
  const empty = grant();
  empty.independentVerification = { ...empty.independentVerification, evidence: { commands: [] } };
  assert.equal(codeOf(empty), 'empty-evidence');
  const noteOnly = grant();
  noteOnly.independentVerification = { ...noteOnly.independentVerification, evidence: { note: 'passed' } };
  assert.equal(codeOf(noteOnly), 'empty-evidence');
  assert.equal(codeOf(grant({
    grantSource: { ...grant().grantSource, ids: ['t710u', 't711u', 't712u'] },
  })), 'scope-exceeded');
  assert.equal(codeOf(grant({ allowsFuture: true })), 'scope-exceeded');
  assert.equal(codeOf(grant({
    grantSource: { ...grant().grantSource, scope: 'all-sensitive-deploys' },
  })), 'scope-exceeded');
});

test('反例：bootstrap 用新机制自证旧 SHA 文件、来源缺一半、规则版本不对、Jasper 未点名本 SHA', () => {
  assert.equal(codeOf({ schema: GRANT_SCHEMA, kind: 'legacy-sha-file', targetSha: TARGET }), 'bootstrap-self-proof');
  assert.equal(codeOf(grant({ provesLegacy: true })), 'bootstrap-self-proof');
  assert.equal(codeOf(grant({
    grantSource: { ...grant().grantSource, ids: ['t710u'] },
  })), 'untrusted-source');
  assert.equal(codeOf(grant({ ruleVersion: 'deploy-ff-sensitive/v1' })), 'rule-version-mismatch');
  assert.equal(codeOf(grant({
    jasperVerdict: { targetSha: 'd'.repeat(40), decision: JASPER_DECISION, decidedAt: new Date(NOW).toISOString() },
  })), 'jasper-mismatch');
  assert.equal(codeOf(grant({
    jasperVerdict: { targetSha: TARGET, decision: 'approved', decidedAt: new Date(NOW).toISOString() },
  })), 'jasper-mismatch');
});
