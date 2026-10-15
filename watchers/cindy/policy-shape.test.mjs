import test from 'node:test';
import assert from 'node:assert/strict';
import { collectCindyPolicySync } from './bin/cindy-pr-policy.mjs';

const REPO = 'example-org/example-app';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const rules = [[{ type: 'required_status_checks', ruleset_id: 7,
  parameters: { required_status_checks: [{ context: 'verify', integration_id: 15368 }] } }]];

function gh(protection) {
  return (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return JSON.stringify({ id: 'PR_1', number: 5, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main' });
    const endpoint = args[1];
    if (endpoint === `repos/${REPO}/rules/branches/main`) return JSON.stringify(rules);
    if (endpoint === `repos/${REPO}/branches/main/protection`) return JSON.stringify(protection);
    throw new Error(`unexpected call ${JSON.stringify(args)}`);
  };
}

// Same shape that broke the sibling watcher on 2026-10-14: a protected branch whose classic required checks were
// removed comes back without the `required_status_checks` key at all.
test('classic protection without required_status_checks reads as no classic checks', () => {
  const policy = collectCindyPolicySync({ repo: REPO, number: 5, gh: gh({ url: `https://api.github.com/repos/${REPO}/branches/main/protection`, enforce_admins: { enabled: false } }) });
  assert.equal(policy.status, 'verified', policy.reason);
  assert.deepEqual(policy.required.map((rule) => [rule.context, rule.appId]), [['verify', 15368]]);
});

test('a body that is not a protection object stays unknown', () => {
  const policy = collectCindyPolicySync({ repo: REPO, number: 5, gh: gh({ message: 'Something went wrong' }) });
  assert.equal(policy.status, 'unknown');
  assert.match(policy.reason, /unknown classic protection/);
});
