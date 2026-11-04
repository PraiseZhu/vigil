// 2026-11-04: the repository pre-push went from one lock to up to PREFLIGHT_MAX_CONCURRENCY slots
// (pre-push.flock, pre-push.flock.1 …). validate waits on this probe before rerunning a hook that found every slot
// busy, so the probe must check the slots the worktree's own hook would use: all of them for the new hook, only
// pre-push.flock for a branch that still carries the old single-lock hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const { probePrePushLock } = await import(new URL(['.', 'bin', 'mivo-repair.mjs'].join('/'), import.meta.url));

const NEW_HOOK = '#!/usr/bin/env bash\n_max_raw="${PREFLIGHT_MAX_CONCURRENCY-5}"\n';
const OLD_HOOK = '#!/usr/bin/env bash\n_lock_file="${_git_common_dir}/pre-push.flock"\n';
const SLOTS = ['pre-push.flock', 'pre-push.flock.1', 'pre-push.flock.2', 'pre-push.flock.3', 'pre-push.flock.4'];

function repo(t, hook) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', dir]);
  fs.mkdirSync(path.join(dir, '.githooks'));
  fs.writeFileSync(path.join(dir, '.githooks', 'pre-push'), hook);
  return dir;
}

// Hold a real flock on <git dir>/<name> until the test ends.
async function hold(t, dir, names) {
  for (const name of names) {
    const child = spawn('perl', ['-MFcntl=:flock', '-e', 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print "held\\n"; sleep 600',
      path.join(dir, '.git', name)], { stdio: ['ignore', 'pipe', 'inherit'] });
    t.after(() => child.kill());
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', reject); });
  }
}

test('new multi-slot hook: busy only when all five default slots are held', async (t) => {
  const dir = repo(t, NEW_HOOK);
  await hold(t, dir, SLOTS.slice(0, 4));
  assert.equal(probePrePushLock({ worktree: dir, env: {} }), true, 'slot 4 is still free');
  await hold(t, dir, SLOTS.slice(4));
  assert.equal(probePrePushLock({ worktree: dir, env: {} }), false);
});

test('new multi-slot hook: PREFLIGHT_MAX_CONCURRENCY limits the slots that count, invalid values fall back to 5', async (t) => {
  const dir = repo(t, NEW_HOOK);
  await hold(t, dir, SLOTS.slice(0, 2));
  assert.equal(probePrePushLock({ worktree: dir, env: { PREFLIGHT_MAX_CONCURRENCY: '2' } }), false, 'slots 2-4 are outside the limit');
  for (const bad of ['abc', '', '0', '65', '00002x']) {
    assert.equal(probePrePushLock({ worktree: dir, env: { PREFLIGHT_MAX_CONCURRENCY: bad } }), true, `${JSON.stringify(bad)} falls back to 5 slots`);
  }
});

test('old single-lock hook: only pre-push.flock counts', async (t) => {
  const dir = repo(t, OLD_HOOK);
  assert.equal(probePrePushLock({ worktree: dir, env: {} }), true);
  await hold(t, dir, SLOTS.slice(0, 1));
  assert.equal(probePrePushLock({ worktree: dir, env: {} }), false, 'free slots 1-4 do not help a hook that never takes them');
});
