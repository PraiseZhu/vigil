import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMivoPolicySync, isBranchNotProtected } from './bin/mivo-pr-policy.mjs';

// 2026-11-05: integration/* is guarded only by a ruleset. GitHub reports the branch protected:true, and its classic
// /protection answers 404 "Branch not protected". gh exits 1 for that, with the 404 only in its output, so every
// integration PR stayed at required-policy-unknown and the watcher never moved it on.
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const REPO = 'example-org/example-plugin';

// The shape execFileSync gives for `gh api .../protection` on such a branch (taken from a real run).
function ghNotProtected() {
  const error = new Error('Command failed: gh api repos/example-org/example-plugin/branches/integration%2Fx/protection');
  error.status = 1;
  error.stdout = JSON.stringify({ message: 'Branch not protected', documentation_url: 'https://docs.github.com/rest/branches/branch-protection#get-branch-protection', status: '404' });
  error.stderr = 'gh: Branch not protected (HTTP 404)\n';
  return error;
}

test('isBranchNotProtected reads the 404 from gh\'s output, and nothing else counts', () => {
  assert.equal(isBranchNotProtected(ghNotProtected()), true);
  const otherNotFound = Object.assign(new Error('x'), { status: 1, stdout: JSON.stringify({ message: 'Not Found', status: '404' }), stderr: 'gh: Not Found (HTTP 404)\n' });
  assert.equal(isBranchNotProtected(otherNotFound), false, 'a missing branch is not "no classic protection"');
  const forbidden = Object.assign(new Error('x'), { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 403)\n' });
  assert.equal(isBranchNotProtected(forbidden), false);
  assert.equal(isBranchNotProtected({ status: 404, apiMessage: 'Branch not protected' }), true, 'the older error shape still works');
});

test('a PR into a ruleset-only branch gets a verified policy from the ruleset', () => {
  const view = { id: 'PR_1', number: 7, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'integration/x' };
  const rules = [[{ type: 'required_status_checks', ruleset_id: 9, parameters: { strict_required_status_checks_policy: true,
    required_status_checks: [{ context: 'verify', integration_id: 15368 }] } }]];
  const file = { type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['verify'], pr_only: [] })).toString('base64') };
  const gh = (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify(view);
    const target = String(args[1]);
    if (target.endsWith('/protection')) throw ghNotProtected();
    if (target.startsWith(`repos/${REPO}/rules/branches/`)) return JSON.stringify(rules);
    if (target === `repos/${REPO}/branches/integration%2Fx`) return JSON.stringify({ protected: true });
    if (target.startsWith(`repos/${REPO}/contents/`)) return JSON.stringify(file);
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const policy = collectMivoPolicySync({ repo: REPO, number: 7, gh });
  assert.equal(policy.status, 'verified', policy.reason);
  assert.deepEqual(policy.required.map((entry) => entry.context), ['verify']);
  assert.equal(policy.strictRequiredStatusChecks, true);
});
