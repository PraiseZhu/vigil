// Resolves review threads as the review GitHub App's bot, with a short-lived installation token that can only
// write contents and pull requests on the one target repository. The token is minted, used for the resolve
// mutations and revoked inside one call; it never reaches `gh`, state files, task files or logs. Nothing here
// falls back to the watcher's own account: a failure is reported and the thread stays open.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { loadProfile, optionalConfig } from './profile.mjs';

const API = 'https://api.github.com';
const SWITCH_KEY = 'resolveFixedThreadsWithApp';
const SWITCH_ENV = 'MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP';
const CONFIG = {
  appId: { key: 'praisebuildAppId', envVar: 'MIVO_WATCHER_PRAISEBUILD_APP_ID' },
  installationId: { key: 'praisebuildInstallationId', envVar: 'MIVO_WATCHER_PRAISEBUILD_INSTALLATION_ID' },
  privateKeyPath: { key: 'praisebuildPrivateKeyPath', envVar: 'MIVO_WATCHER_PRAISEBUILD_PRIVATE_KEY_PATH' },
};
const RESOLVE_MUTATION = 'mutation($tid:ID!){resolveReviewThread(input:{threadId:$tid}){thread{id isResolved}}}';
const REQUEST_TIMEOUT_MS = 15000;

// Off unless asked for: the profile needs the boolean `true`, the environment variable `1` or `true`.
// The environment variable wins when it is set at all. An unreadable profile counts as off.
export function resolveWithAppEnabled(env = process.env) {
  const fromEnv = env[SWITCH_ENV];
  if (fromEnv !== undefined) return fromEnv === '1' || fromEnv === 'true';
  try { return loadProfile(env)?.[SWITCH_KEY] === true; } catch { return false; }
}

// Read when a round has a thread to resolve, never at import. A problem names the setting, not its value.
export function readAppConfig(env = process.env) {
  const raw = Object.fromEntries(Object.entries(CONFIG).map(([name, { key, envVar }]) => [name, optionalConfig(key, { envVar, env })]));
  for (const name of ['appId', 'installationId']) {
    const value = String(raw[name] ?? '').trim();
    if (!value) return { error: { expected: `${CONFIG[name].key} set`, actual: 'missing' } };
    if (!/^\d{1,20}$/.test(value)) return { error: { expected: `${CONFIG[name].key} is digits`, actual: 'invalid' } };
    raw[name] = value;
  }
  const keyPath = typeof raw.privateKeyPath === 'string' ? raw.privateKeyPath.trim() : '';
  if (!keyPath) return { error: { expected: `${CONFIG.privateKeyPath.key} set`, actual: 'missing' } };
  return { appId: raw.appId, installationId: raw.installationId, privateKeyPath: keyPath };
}

const b64url = (value) => Buffer.from(value).toString('base64url');
export function signAppJwt({ appId, privateKeyPem, nowSec }) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKeyPem);
  return `${header}.${payload}.${b64url(signature)}`;
}

const headers = (bearer) => ({
  Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json', 'User-Agent': 'mivo-watcher',
});
const request = (fetchImpl, url, method, bearer, body) => fetchImpl(url, {
  method, headers: headers(bearer), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const nameOf = (error) => String(error?.name ?? 'Error').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || 'Error';

// Never throws. Returns {resolved: [threadId...], failures: [{threadId?, phase, expected, actual}]}. A failure
// carries the phase (config, mint, resolve, revoke), what was expected and the HTTP status or reason that came
// back; no response body, token, JWT or key material is ever copied into it.
export async function resolveThreadsWithApp({
  threadIds = [], repo, env = process.env, fetchImpl = globalThis.fetch, readFile = fs.readFileSync, nowMs = Date.now,
} = {}) {
  const resolved = [];
  const failures = [];
  const ids = [...new Set((threadIds ?? []).filter((id) => typeof id === 'string' && id))];
  if (ids.length === 0) return { resolved, failures };
  const fail = (failure) => failures.push(failure);
  const repoName = /^[A-Za-z0-9_.-]+\/([A-Za-z0-9_.-]+)$/.exec(String(repo ?? ''))?.[1];
  if (!repoName) { fail({ phase: 'config', expected: 'target repo as owner/name', actual: 'invalid' }); return { resolved, failures }; }
  const config = readAppConfig(env);
  if (config.error) { fail({ phase: 'config', ...config.error }); return { resolved, failures }; }
  let jwt;
  try {
    const privateKeyPem = readFile(config.privateKeyPath, 'utf8');
    jwt = signAppJwt({ appId: config.appId, privateKeyPem, nowSec: Math.floor(nowMs() / 1000) });
  } catch (error) {
    fail({ phase: 'config', expected: 'private key readable and usable for RS256', actual: `unusable ${String(error?.code ?? nameOf(error))}`.slice(0, 80) });
    return { resolved, failures };
  }
  let token = null;
  try {
    const response = await request(fetchImpl, `${API}/app/installations/${config.installationId}/access_tokens`, 'POST', jwt,
      { repositories: [repoName], permissions: { contents: 'write', pull_requests: 'write' } });
    if (response.status !== 201) { fail({ phase: 'mint', expected: 'http 201', actual: `http ${response.status}` }); return { resolved, failures }; }
    const payload = await response.json();
    token = typeof payload?.token === 'string' && payload.token ? payload.token : null;
    if (!token) { fail({ phase: 'mint', expected: 'installation token in response', actual: 'none' }); return { resolved, failures }; }
  } catch (error) {
    fail({ phase: 'mint', expected: 'http 201', actual: `request failed ${nameOf(error)}` });
    return { resolved, failures };
  }
  try {
    for (const threadId of ids) {
      try {
        const response = await request(fetchImpl, `${API}/graphql`, 'POST', token, { query: RESOLVE_MUTATION, variables: { tid: threadId } });
        if (response.status !== 200) { fail({ threadId, phase: 'resolve', expected: 'http 200 with isResolved=true', actual: `http ${response.status}` }); continue; }
        const payload = await response.json();
        if (payload?.data?.resolveReviewThread?.thread?.isResolved === true && !payload.errors?.length) { resolved.push(threadId); continue; }
        const type = /^[A-Z_]{1,40}$/.test(payload?.errors?.[0]?.type ?? '') ? ` ${payload.errors[0].type}` : '';
        fail({ threadId, phase: 'resolve', expected: 'http 200 with isResolved=true',
          actual: payload?.errors?.length ? `http 200 graphql error${type}` : 'http 200 isResolved not true' });
      } catch (error) {
        fail({ threadId, phase: 'resolve', expected: 'http 200 with isResolved=true', actual: `request failed ${nameOf(error)}` });
      }
    }
  } finally {
    try {
      const response = await request(fetchImpl, `${API}/installation/token`, 'DELETE', token);
      if (response.status !== 204) fail({ phase: 'revoke', expected: 'http 204', actual: `http ${response.status}` });
    } catch (error) {
      fail({ phase: 'revoke', expected: 'http 204', actual: `request failed ${nameOf(error)}` });
    }
  }
  return { resolved, failures };
}
