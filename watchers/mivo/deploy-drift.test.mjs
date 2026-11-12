import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FILES, verify, apply } from './deploy.mjs';
import { CURRENT_MANIFEST, checkDeploymentDriftDaily, deploymentDrift, registerLocalPatch } from './bin/mivo-deploy-drift.mjs';
import { deployDriftCheck } from './bin/mivo-watcher.mjs';
import { markNoticesSent, pendingEvents, formatNoticeText } from './bin/notify.mjs';

// #385: the runtime bin/ is a copy. deploy.mjs records what it installed; the watcher compares once a day and tells a
// person once per distinct drift; a registered local patch is not drift.
const DEPLOY = fileURLToPath(new URL('./deploy.mjs', import.meta.url));
const DAY1 = '2026-11-12T01:00:00.000Z';
const DAY1_LATER = '2026-11-12T09:00:00.000Z';
const DAY2 = '2026-11-13T01:00:00.000Z';

function deployed(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-deploy-drift-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(home, 'state'), { recursive: true });
  fs.writeFileSync(path.join(home, 'state/state.json'), JSON.stringify({ prs: {} }));
  for (const name of FILES) fs.writeFileSync(path.join(home, 'bin', name), 'old bytes');
  const state = fs.readFileSync(path.join(home, 'state/state.json'));
  apply({ version: 1, home, database: path.join(home, 'metadata.db'), id: 'drift-release', files: verify(home),
    stateSha: createHash('sha256').update(state).digest('hex'), sessionIds: [] });
  const bin = (name) => path.join(home, 'bin', name);
  const check = (now) => {
    const events = [];
    const summary = deployDriftCheck({ home, now, events, binDir: path.join(home, 'bin') });
    return { summary, events, pending: pendingEvents(home).filter((event) => event.kind === 'deploy-drift') };
  };
  return { home, bin, check };
}

test('#385 deploy writes the manifest: every installed file with its sha256, and the copy matches it', (t) => {
  const f = deployed(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.home, CURRENT_MANIFEST), 'utf8'));
  assert.equal(manifest.release, 'drift-release');
  assert.deepEqual(manifest.files.map((item) => item.name), FILES);
  assert.ok(manifest.files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256)));
  assert.ok(FILES.includes('mivo-deploy-drift.mjs'), 'the drift module itself is deployed');
  assert.deepEqual(deploymentDrift({ home: f.home }), { status: 'ok', release: 'drift-release', sourceCommit: manifest.sourceCommit, drifted: [] });
  const { summary, events, pending } = f.check(DAY1);
  assert.deepEqual(summary, { status: 'ok', drifted: 0 });
  assert.deepEqual(events, []);
  assert.deepEqual(pending, [], 'files that match the manifest are not reported');
});

test('#385 one file overwritten by an older copy is reported once: not again the same day, not again the next day', (t) => {
  const f = deployed(t);
  fs.writeFileSync(f.bin('mivo-pr-policy.mjs'), '// an older copy\n');
  const first = f.check(DAY1);
  assert.deepEqual(first.summary, { status: 'drift', drifted: 1 });
  assert.equal(first.pending.length, 1);
  assert.deepEqual(first.pending[0].files, [{ name: 'mivo-pr-policy.mjs', kind: 'changed' }]);
  assert.match(formatNoticeText(first.pending), /mivo-pr-policy\.mjs（内容和部署时不一样）/);
  markNoticesSent(f.home, first.pending.map((event) => event.id));

  const sameDay = f.check(DAY1_LATER);
  assert.equal(sameDay.summary.status, 'skipped', 'compared once a day');
  const nextDay = f.check(DAY2);
  assert.equal(nextDay.summary.status, 'drift', 'still compared the next day');
  assert.deepEqual(nextDay.pending, [], 'the same drift is not reported a second time');

  fs.unlinkSync(f.bin('mivo-ci.mjs'));
  const worse = f.check('2026-11-14T01:00:00.000Z');
  assert.equal(worse.pending.length, 1, 'a different drift is a new notice');
  assert.deepEqual(worse.pending[0].files, [{ name: 'mivo-ci.mjs', kind: 'missing' }, { name: 'mivo-pr-policy.mjs', kind: 'changed' }]
    .sort((a, b) => FILES.indexOf(a.name) - FILES.indexOf(b.name)));
});

test('#385 a registered local patch is not reported; changing the patched file again is drift', (t) => {
  const f = deployed(t);
  fs.writeFileSync(f.bin('notify.mjs'), '// kept on purpose on this machine\n');
  const registered = registerLocalPatch({ home: f.home, name: 'notify.mjs', at: DAY1 });
  assert.match(registered.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.check(DAY1).pending, []);
  assert.equal(deploymentDrift({ home: f.home }).status, 'ok');

  fs.writeFileSync(f.bin('notify.mjs'), '// changed again\n');
  const after = f.check(DAY2);
  assert.deepEqual(after.pending.map((event) => event.files), [[{ name: 'notify.mjs', kind: 'changed' }]]);
});

test('#385 registering refuses what is not a patch: unknown file, missing file, unchanged file', (t) => {
  const f = deployed(t);
  assert.throws(() => registerLocalPatch({ home: f.home, name: 'not-deployed.mjs' }), /not a deployed file/);
  assert.throws(() => registerLocalPatch({ home: f.home, name: 'notify.mjs' }), /matches the deployed file/);
  fs.unlinkSync(f.bin('notify.mjs'));
  assert.throws(() => registerLocalPatch({ home: f.home, name: 'notify.mjs' }), /missing/);
});

test('#385 a runtime deployed before the manifest existed is not reported; an unreadable manifest is', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mivo-deploy-drift-legacy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const notified = [];
  assert.equal(checkDeploymentDriftDaily({ home, binDir: path.join(home, 'bin'), now: DAY1, notify: (event) => notified.push(event) }).status, 'no-manifest');
  assert.deepEqual(notified, []);
  fs.mkdirSync(path.join(home, 'deployments'));
  fs.writeFileSync(path.join(home, CURRENT_MANIFEST), '{"version":1,"files":[]}');
  const broken = checkDeploymentDriftDaily({ home, binDir: path.join(home, 'bin'), now: DAY2, notify: (event) => notified.push(event) });
  assert.equal(broken.status, 'unreadable');
  assert.equal(notified.length, 1);
  assert.match(formatNoticeText(notified), /部署清单读不出来/);
});

test('#385 deploy.mjs drift prints the comparison and exits 1 when bin/ differs', (t) => {
  const f = deployed(t);
  const ok = spawnSync(process.execPath, [DEPLOY, 'drift', '--home', f.home], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).status, 'ok');
  fs.writeFileSync(f.bin('mivo-pr-policy.mjs'), '// older\n');
  const drift = spawnSync(process.execPath, [DEPLOY, 'drift', '--home', f.home], { encoding: 'utf8' });
  assert.equal(drift.status, 1);
  assert.deepEqual(JSON.parse(drift.stdout).drifted.map((item) => item.name), ['mivo-pr-policy.mjs']);
});
