import {
  FLEET_ROUND_DELEGATION,
  GRANT_SCHEMA,
  JASPER_DECISION,
  REQUIRED_VERIFIER,
} from './deploy-approval.mjs';

export function makeGrant({
  targetSha,
  baseSha,
  commits,
  ruleVersion,
  nowMs = Date.now(),
  overrides = {},
} = {}) {
  const decidedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + 12 * 60 * 60 * 1000).toISOString();
  return {
    schema: GRANT_SCHEMA,
    targetSha,
    baseSha,
    commits: [...(commits || [])],
    ruleVersion,
    grantSource: {
      kind: 'user-delegation',
      ids: [...FLEET_ROUND_DELEGATION.ids],
      round: FLEET_ROUND_DELEGATION.round,
      scope: FLEET_ROUND_DELEGATION.scope,
      verifiableBy: FLEET_ROUND_DELEGATION.verifiableBy,
    },
    jasperVerdict: {
      targetSha,
      decision: JASPER_DECISION,
      decidedAt,
    },
    independentVerification: {
      verifier: REQUIRED_VERIFIER,
      fast: false,
      result: 'pass',
      headSha: targetSha,
      evidence: {
        commands: [{ cmd: 'node --test watchers/acceptance/deploy-approval.test.mjs', exitCode: 0 }],
      },
    },
    expiresAt,
    ...overrides,
  };
}
