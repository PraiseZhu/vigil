import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planSession } from './bin/mivo-watcher.mjs';
import { newSessionTitle, planSessionTitle, repairSessionTitle, sessionTitlePrefix, shortTaskName, SESSION_TITLE_PREFIX_ENV } from './bin/session-title.mjs';

// The title marker is opt-in (MIVO_SESSION_TITLE_PREFIX / profile `sessionTitlePrefix`). Turning it on must only
// change titles written from now on: existing sessions keep their title (prefixed or not) and their binding.
const pr = { id: 'PR_558', number: 558, title: '终态回执修复' };
const date = '2026-09-28';
const prefixEnv = (value) => ({ [SESSION_TITLE_PREFIX_ENV]: value });
// planSession reads the real process env (it takes no prefix argument), so tests that go through it set and restore it.
function withEnvPrefix(t, value) {
  const previous = process.env[SESSION_TITLE_PREFIX_ENV];
  process.env[SESSION_TITLE_PREFIX_ENV] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[SESSION_TITLE_PREFIX_ENV];
    else process.env[SESSION_TITLE_PREFIX_ENV] = previous;
  });
}

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

test('a Chinese prefix is accepted and leaves the task name alone', () => {
  assert.equal(sessionTitlePrefix(prefixEnv('修PR')), '修PR');
  const legacy = repairSessionTitle({ task: '终态回执修复', prNumber: 558, createdAt: date });
  const chinese = repairSessionTitle({ task: '终态回执修复', prNumber: 558, createdAt: date, prefix: '修PR' });
  assert.equal(chinese, '修PR#558-终态回执修复丨0928');
  assert.equal(chinese, `修PR${legacy}`, 'the prefix must only prepend; the task name is unchanged');
  assert.equal(shortTaskName({ task: 'feat: 终态回执修复' }), '终态回执修复');
  assert.equal(planSessionTitle({ pr, existing: { title: chinese, titleDate: date }, createdAt: date, prefix: '修PR' }).title, chinese);
});

test('an invalid prefix fails closed instead of producing a broken title', () => {
  for (const bad of ['修 PR', '修#PR', '修丨PR', '修:PR', 'x'.repeat(17)]) {
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

test('a bound session is reused, so turning the prefix on opens no second session', (t) => {
  withEnvPrefix(t, '修PR');
  const existing = {
    nodeId: 'PR_558', sessionId: 'sess-558', title: '#558-终态回执修复丨0928', titleDate: date,
  };
  const planned = planSession({ pr, existing, date });
  assert.equal(planned.action, 'reuse');
  assert.equal(planned.sessionId, 'sess-558');
  assert.equal(planned.title, '#558-终态回执修复丨0928');
});

test('a new session takes the current prefix instead of the stored title', () => {
  const existing = { title: '#558-终态回执修复丨0928', titleDate: date };
  const created = newSessionTitle({ pr, existing, createdAt: '2026-09-30', prefix: '修PR' });
  assert.equal(created.title, '修PR#558-终态回执修复丨0928', 'the stored title text belongs to the session that ended');
  assert.equal(created.titleDate, date, 'the suffix keeps marking when the PR repair started');
  // A PR with no stored date is titled with the new session's own date.
  assert.equal(newSessionTitle({ pr, createdAt: '2026-09-30', prefix: 'PR' }).title, 'PR#558-终态回执修复丨0930');
  // A stored title fed back as the task source must not duplicate the 丨 separator.
  assert.equal(shortTaskName({ task: '#558-终态回执修复丨0928' }), '终态回执修复');
});

test('planning a create rebuilds the title with the configured prefix while keeping the stored date', (t) => {
  withEnvPrefix(t, '修PR');
  const existing = { nodeId: 'PR_558', sessionId: null, title: '#558-旧任务丨0928', titleDate: date };
  const planned = planSession({ pr, existing, date: '2026-09-30' });
  assert.equal(planned.action, 'create-intent');
  assert.equal(planned.sessionId, null);
  assert.equal(planned.title, '修PR#558-终态回执修复丨0928', 'the PR title and current prefix, not the stored title text');
  assert.equal(planned.titleDate, date);
});

test('the maintenance script accepts both the prefixed and the legacy form', () => {
  // Run the pattern through Python itself: the script is the only consumer of it.
  const script = fileURLToPath(new URL('./bin/session-title-maintenance.py', import.meta.url));
  const probe = [
    'import json, re, sys',
    'src = open(sys.argv[1], encoding="utf-8").read()',
    'pattern = re.search(r\'re\\.fullmatch\\(r"([^"]+)",\\s*change\\.get\\("title"\', src).group(1)',
    'print(json.dumps([bool(re.fullmatch(pattern, title)) for title in json.loads(sys.argv[2])]))',
  ].join('\n');
  const titles = [
    '#558-终态回执修复丨0928',
    '修PR#558-终态回执修复丨0928',
    'MivoPlugin-#558-终态回执修复丨 0928',
    '修 PR#558-终态回执修复丨0928',
    `${'x'.repeat(17)}#558-终态回执修复丨0928`,
  ];
  const out = execFileSync('python3', ['-I', '-B', '-c', probe, script, JSON.stringify(titles)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), [true, true, false, false, false]);
});
