// The GitHub identity this watcher acts as, named explicitly instead of asked from `gh api user`.
// Set VIGIL_GH_LOGIN (and VIGIL_GH_USER_ID for commit emails) to run as another account.
export const DEFAULT_LOGIN = 'PraiseZhu';
export const DEFAULT_USER_ID = 290989140;
export const BOT_LOGIN = 'praise-qa[bot]';

export function configuredLogin(env = process.env) {
  const value = String(env.VIGIL_GH_LOGIN ?? '').trim();
  return value || DEFAULT_LOGIN;
}

export function configuredUserId(env = process.env) {
  const raw = String(env.VIGIL_GH_USER_ID ?? '').trim();
  if (raw) return Number(raw);
  return configuredLogin(env).toLowerCase() === DEFAULT_LOGIN.toLowerCase() ? DEFAULT_USER_ID : null;
}

// Our own logins: the configured human account and the praise-qa GitHub App.
export function isOwnLogin(login, env = process.env) {
  if (typeof login !== 'string' || !login) return false;
  const l = login.toLowerCase();
  return l === configuredLogin(env).toLowerCase() || l === BOT_LOGIN;
}
