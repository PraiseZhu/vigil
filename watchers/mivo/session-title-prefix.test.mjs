import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSession } from './bin/mivo-watcher.mjs';
import { planSessionTitle, repairSessionTitle, sessionTitlePrefix, SESSION_TITLE_PREFIX_ENV } from './bin/session-title.mjs';

// The title marker is opt-in (MIVO_SESSION_TITLE_PREFIX / profile `sessionTitlePrefix`). Turning it on must only
// change titles written from now on: existing sessions keep their title (prefixed or not) and their binding.
const pr = { id: 'PR_558', number: 558, title: '终态回执修复' };
const date = '2026-09-28';
const prefixEnv = (value) => ({ [SESSION_TITLE_PREFIX_ENV]: value });

test('without a prefix the title format is unchanged', () => {
  assert.equal(sessionTitlePrefix({}), '');
  assert.equal(repairSessionTitle({ task: '终态回执修复', prNumber: 558, createdAt: date }), '#558-终态回执修复丨0928');
});

test('a configured prefix is put in front of the PR number', () => {
  assert.equal(sessionTitlePrefix(prefixEnv('PR')), 'PR');
  assert.equal(repairSessionTitle({ task: '终态回执修复', prNumber: 558, createdAt: date, prefix: 'PR' }), 'PR#558-终态回执修复丨0928');
  assert.equal(planSessionTitle({ pr, createdAt: date, prefix: 'PR' }).title, 'PR#558-终态回执修复丨0928');
});

test('profile.json can carry the prefix when the environment does not', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'title-prefix-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'config', 'profile.json'), JSON.stringify({ sessionTitlePrefix: 'PR' }));
  assert.equal(sessionTitlePrefix({ MIVO_WATCHER_HOME: home }), 'PR');
  // The environment wins over the file, as everywhere else in profile.mjs.
  assert.equal(sessionTitlePrefix({ MIVO_WATCHER_HOME: home, [SESSION_TITLE_PREFIX_ENV]: 'GH' }), 'GH');
});

test('an invalid prefix fails closed instead of producing a broken title', () => {
  for (const bad of ['1PR', 'P R', 'PR#', 'x'.repeat(17), 'pre丨fix']) {
    assert.throws(() => sessionTitlePrefix(prefixEnv(bad)), /会话标题前缀无效/);
  }
});

test('an existing title is kept whichever prefix it carries', () => {
  const existing = { title: '#558-终态回执修复丨0928', titleDate: date };
  assert.equal(planSessionTitle({ pr, existing, createdAt: date, prefix: 'PR' }).title, existing.title,
    'a legacy title is not rewritten when the prefix is turned on');
  const prefixed = { title: 'PR#558-终态回执修复丨0928', titleDate: date };
  assert.equal(planSessionTitle({ pr, existing: prefixed, createdAt: date, prefix: '' }).title, prefixed.title,
    'a prefixed title is not rewritten when the prefix is turned off');
  assert.equal(planSessionTitle({ pr, existing: prefixed, createdAt: date, prefix: 'GH' }).title, prefixed.title,
    'a different prefix in the config does not rewrite the session');
});

test('a broken title is still regenerated with the configured prefix', () => {
  const rewritten = planSessionTitle({
    pr, existing: { title: 'MivoPlugin-#558-终态回执修复丨 0928', titleDate: date }, createdAt: date, prefix: 'PR',
  });
  assert.equal(rewritten.title, 'PR#558-终态回执修复丨0928');
});

test('a bound session is reused, so turning the prefix on opens no second session', () => {
  const existing = {
    nodeId: 'PR_558', sessionId: 'sess-558', title: '#558-终态回执修复丨0928', titleDate: date,
  };
  const planned = planSession({ pr, existing, date, prefix: 'PR' });
  assert.equal(planned.action, 'reuse');
  assert.equal(planned.sessionId, 'sess-558');
  assert.equal(planned.title, '#558-终态回执修复丨0928');
});

test('the maintenance script accepts both the prefixed and the legacy form', () => {
  const src = fs.readFileSync(new URL('./bin/session-title-maintenance.py', import.meta.url), 'utf8');
  const match = src.match(/if not re\.fullmatch\(r"([^"]+)",\s*change\.get\("title"/);
  assert.ok(match);
  const re = new RegExp(`^${match[1]}$`, 'u');
  assert.equal(re.test('#558-终态回执修复丨0928'), true, 'legacy titles stay valid for a migration');
  assert.equal(re.test('PR#558-终态回执修复丨0928'), true, 'a configured prefix is valid');
  assert.equal(re.test('MivoPlugin-#558-终态回执修复丨 0928'), false);
});
