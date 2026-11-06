// The GitHub identity this watcher acts as, named explicitly instead of asked from `gh api user`.
// Precedence: VIGIL_GH_LOGIN / VIGIL_GH_USER_ID > profile.json `ghLogin` / `ghUserId` > these defaults.
// The profile file matters for the helper processes the watcher spawns (mivo-repair / mivo-handoff): they do not
// inherit the schedule command's environment, so an identity that only lives in the command would fall back here.
import { optionalConfigStrict } from './profile.mjs';

export const DEFAULT_LOGIN = 'PraiseZhu';
export const DEFAULT_USER_ID = 290989140;
export const BOT_LOGIN = 'praise-qa[bot]';
// The GitHub App whose bot account may submit the review flow's reviews next to the configured reviewer login.
export const REVIEWER_BOT_LOGIN = 'praisebuild[bot]';

export function configuredLogin(env = process.env) {
  const value = String(env.VIGIL_GH_LOGIN ?? '').trim();
  if (value) return value;
  const fromProfile = optionalConfigStrict('ghLogin', { env, fallback: null });
  const login = typeof fromProfile === 'string' ? fromProfile.trim() : '';
  return login || DEFAULT_LOGIN;
}

export function configuredUserId(env = process.env) {
  const raw = String(env.VIGIL_GH_USER_ID ?? '').trim();
  if (raw) return Number(raw);
  const fromProfile = optionalConfigStrict('ghUserId', { env, fallback: null });
  if (fromProfile !== null && fromProfile !== undefined && String(fromProfile).trim() !== '') return Number(fromProfile);
  return configuredLogin(env).toLowerCase() === DEFAULT_LOGIN.toLowerCase() ? DEFAULT_USER_ID : null;
}

// Our own logins: the configured human account and the praise-qa GitHub App.
export function isOwnLogin(login, env = process.env) {
  if (typeof login !== 'string' || !login) return false;
  const l = login.toLowerCase();
  return l === configuredLogin(env).toLowerCase() || l === BOT_LOGIN;
}
