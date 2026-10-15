import test from 'node:test';
import assert from 'node:assert/strict';
import { collectMivoPolicySync } from './bin/mivo-pr-policy.mjs';

const REPO = 'example-org/example-plugin';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const rules = [[{ type: 'required_status_checks', ruleset_id: 7,
  parameters: { required_status_checks: [{ context: 'verify', integration_id: 15368 }] } }]];

function gh(protection) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_1', number: 5, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main' });
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/branches/main`) return JSON.stringify({ protected: true });
    if (endpoint === `repos/${REPO}/rules/branches/main?per_page=100`) return JSON.stringify(rules);
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify(protection);
    if (endpoint === `repos/${REPO}/contents/docs/sync/required-checks.json?ref=${BASE}`) return JSON.stringify({
      type: 'file', encoding: 'base64', content: Buffer.from(JSON.stringify({ on_main: ['verify'], pr_only: [] })).toString('base64') });
    throw new Error(`unexpected call ${JSON.stringify(args)}`);
  };
}

// 2026-10-14: required checks moved to a ruleset; GitHub then dropped `required_status_checks` from the classic
// protection body, the watcher read every policy as unknown and stopped admitting any newly Ready PR.
test('classic protection without required_status_checks reads as no classic checks', () => {
  const policy = collectMivoPolicySync({ repo: REPO, number: 5, gh: gh({ url: `https://api.github.com/repos/${REPO}/branches/main/protection`, enforce_admins: { enabled: true } }) });
  assert.equal(policy.status, 'verified', policy.reason);
  assert.deepEqual(policy.required.map((rule) => [rule.context, rule.appId]), [['verify', 15368]]);
});

test('explicit null classic checks and real classic checks keep their meaning', () => {
  assert.equal(collectMivoPolicySync({ repo: REPO, number: 5, gh: gh({ url: 'x', required_status_checks: null }) }).status, 'verified');
  const classic = collectMivoPolicySync({ repo: REPO, number: 5, gh: gh({ url: 'x',
    required_status_checks: { contexts: ['lint'], checks: [{ context: 'lint', app_id: 9 }] } }) });
  assert.equal(classic.status, 'verified');
  assert.ok(classic.required.some((rule) => rule.context === 'lint' && rule.appId === 9));
});

test('a body that is not a protection object stays unknown', () => {
  const policy = collectMivoPolicySync({ repo: REPO, number: 5, gh: gh({ message: 'Something went wrong' }) });
  assert.equal(policy.status, 'unknown');
  assert.match(policy.reason, /unknown classic protection/);
});
