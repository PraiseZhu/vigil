import fs from 'node:fs';
import path from 'node:path';
import { REPO } from '../pulls.mjs';

export const PR = `${REPO}#1`;
export const head = (index) => index.toString(16).padStart(40, '0');
export const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
export const required = (name, result, infra = false) => ({ name, result, infra });

export function push(index, before = [], after = []) {
  return {
    id: `push:${index}`, pr: PR, type: 'push', at: at(index), before_head: head(index - 1),
    after_head: head(index), before_classification: '要修', before_required_checks: before, after_required_checks: after,
  };
}

export function fixture(t) {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.steward-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const profile = path.join(directory, 'profile.json');
  const stateDir = path.join(directory, 'state');
  fs.writeFileSync(profile, JSON.stringify({ stateDir, repos: [REPO], authors: ['ExampleUser'] }));
  return { directory, stateDir, env: { STEWARD_PROFILE: profile } };
}
