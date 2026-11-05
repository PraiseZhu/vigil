import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveThreadsWithApp, resolveWithAppEnabled, readAppConfig, signAppJwt } from './bin/mivo-app-token.mjs';

// The review App's installation token: what is asked for, where it goes, and that it never leaks. The network is a
// recording fake; the key pair is generated for each run and nothing here is a real App, installation or token.
const REPO = process.env.MIVO_WATCHER_TARGET_REPO;
const TOKEN = 'fake-installation-token-for-test';
const NOW_MS = Date.parse('2026-11-05T12:00:00Z');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const KEY_PATH = '/virtual/app-key';
const EMPTY_HOME = path.join(os.tmpdir(), 'app-token-test-no-such-home');
const ENV = {
  MIVO_WATCHER_HOME: EMPTY_HOME,
  MIVO_WATCHER_PRAISEBUILD_APP_ID: '12345',
  MIVO_WATCHER_PRAISEBUILD_INSTALLATION_ID: '67890',
  MIVO_WATCHER_PRAISEBUILD_PRIVATE_KEY_PATH: KEY_PATH,
};
const readKey = (file) => { assert.equal(file, KEY_PATH); return KEY_PEM; };

const json = (status, body) => ({ status, json: async () => body });
const ok = (id) => json(200, { data: { resolveReviewThread: { thread: { id, isResolved: true } } } });
// Answers each request by its kind; `plan` overrides the default success for one of them.
function network(plan = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body === undefined ? undefined : JSON.parse(init.body), signal: init.signal });
    if (url.endsWith('/access_tokens')) return plan.mint ? plan.mint() : json(201, { token: TOKEN });
    if (url.endsWith('/graphql')) {
      const tid = JSON.parse(init.body).variables.tid;
      return plan.resolve ? plan.resolve(tid) : ok(tid);
    }
    if (url.endsWith('/installation/token')) return plan.revoke ? plan.revoke() : { status: 204 };
    throw new Error(`unexpected request ${init.method} ${url}`);
  };
  return { calls, fetchImpl };
}
const call = (net, extra = {}) => resolveThreadsWithApp({ threadIds: ['PRRT_a', 'PRRT_b'], repo: REPO, env: ENV, fetchImpl: net.fetchImpl,
  readFile: readKey, nowMs: () => NOW_MS, ...extra });

test('mints a token for exactly one repository and two permissions, uses it only to resolve, then revokes it', async () => {
  const net = network();
  const out = await call(net);
  assert.deepEqual(out, { resolved: ['PRRT_a', 'PRRT_b'], failures: [] });
  assert.deepEqual(net.calls.map((c) => [c.method, c.url]), [
    ['POST', 'https://api.github.com/app/installations/67890/access_tokens'],
    ['POST', 'https://api.github.com/graphql'],
    ['POST', 'https://api.github.com/graphql'],
    ['DELETE', 'https://api.github.com/installation/token'],
  ]);
  assert.deepEqual(net.calls[0].body, { repositories: ['example-plugin'], permissions: { contents: 'write', pull_requests: 'write' } });
  assert.deepEqual(net.calls[0].body.repositories, [REPO.split('/')[1]], 'the repository is the configured target, by name');
  assert.deepEqual(Object.keys(net.calls[0].body.permissions).sort(), ['contents', 'pull_requests']);
  assert.notEqual(net.calls[0].auth, `Bearer ${TOKEN}`, 'minting is authorized by the App JWT, not by a token');
  const [resolveA, resolveB] = [net.calls[1], net.calls[2]];
  assert.equal(resolveA.auth, `Bearer ${TOKEN}`);
  assert.equal(resolveB.auth, `Bearer ${TOKEN}`);
  assert.deepEqual([resolveA.body.variables, resolveB.body.variables], [{ tid: 'PRRT_a' }, { tid: 'PRRT_b' }]);
  assert.match(resolveA.body.query, /resolveReviewThread\(input:\{threadId:\$tid\}\)/);
  assert.equal(net.calls[3].auth, `Bearer ${TOKEN}`, 'the revoke call authenticates with the token it revokes');
  assert.ok(net.calls.every((c) => c.signal instanceof AbortSignal), 'every request has a timeout');
});

test('the App JWT is RS256, valid for ten minutes at most, issued by the App, and verifies with the public key', async () => {
  const net = network();
  await call(net);
  const jwt = net.calls[0].auth.replace(/^Bearer /, '');
  const [header, payload, signature] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const nowSec = NOW_MS / 1000;
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { iat: nowSec - 60, exp: nowSec + 540, iss: '12345' });
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, 'base64url')));
  assert.equal(signAppJwt({ appId: '12345', privateKeyPem: KEY_PEM, nowSec }), jwt, 'signing is deterministic for the same inputs');
});

test('one token serves every thread of the call, and a call with no thread asks for nothing', async () => {
  const net = network();
  await call(net, { threadIds: ['PRRT_a', 'PRRT_a', 'PRRT_c'] });
  assert.equal(net.calls.filter((c) => c.url.endsWith('/access_tokens')).length, 1);
  assert.deepEqual(net.calls.filter((c) => c.url.endsWith('/graphql')).map((c) => c.body.variables.tid), ['PRRT_a', 'PRRT_c']);
  const idle = network();
  assert.deepEqual(await call(idle, { threadIds: [] }), { resolved: [], failures: [] });
  assert.equal(idle.calls.length, 0);
});

test('mint refused (422): nothing is resolved, no token is used or revoked, the failure says expected and actual', async () => {
  const net = network({ mint: () => json(422, { message: `Validation Failed ${TOKEN}` }) });
  const out = await call(net);
  assert.deepEqual(out, { resolved: [], failures: [{ phase: 'mint', expected: 'http 201', actual: 'http 422' }] });
  assert.deepEqual(net.calls.map((c) => c.url), ['https://api.github.com/app/installations/67890/access_tokens']);
});

test('mint answers without a token, or the request fails: nothing is resolved', async () => {
  const noToken = await call(network({ mint: () => json(201, {}) }));
  assert.deepEqual(noToken, { resolved: [], failures: [{ phase: 'mint', expected: 'installation token in response', actual: 'none' }] });
  const refused = await call(network(), { fetchImpl: () => { throw new TypeError(`connect failed ${TOKEN}`); } });
  assert.deepEqual(refused, { resolved: [], failures: [{ phase: 'mint', expected: 'http 201', actual: 'request failed TypeError' }] });
});

test('a thread that does not resolve is reported with its own failure; the others still resolve and the token is still revoked', async () => {
  const net = network({ resolve: (tid) => tid === 'PRRT_a'
    ? json(200, { errors: [{ type: 'FORBIDDEN', message: `Resource not accessible ${TOKEN}` }] }) : ok(tid) });
  const out = await call(net);
  assert.deepEqual(out.resolved, ['PRRT_b']);
  assert.deepEqual(out.failures, [{ threadId: 'PRRT_a', phase: 'resolve', expected: 'http 200 with isResolved=true', actual: 'http 200 graphql error FORBIDDEN' }]);
  assert.equal(net.calls.at(-1).method, 'DELETE');
});

test('resolve failures by status, by isResolved=false and by thrown request: each a failure, none a success, token revoked', async () => {
  for (const [answer, actual] of [
    [() => json(403, { message: TOKEN }), 'http 403'],
    [() => json(200, { data: { resolveReviewThread: { thread: { id: 'x', isResolved: false } } } }), 'http 200 isResolved not true'],
    [() => json(200, { data: null }), 'http 200 isResolved not true'],
    [() => { throw new Error(`socket closed ${TOKEN}`); }, 'request failed Error'],
  ]) {
    const net = network({ resolve: answer });
    const out = await call(net, { threadIds: ['PRRT_a'] });
    assert.deepEqual(out, { resolved: [], failures: [{ threadId: 'PRRT_a', phase: 'resolve', expected: 'http 200 with isResolved=true', actual }] });
    assert.equal(net.calls.at(-1).method, 'DELETE', 'revoked after the failure');
  }
});

test('a token that cannot be revoked is reported as its own failure and does not undo the resolves', async () => {
  const out = await call(network({ revoke: () => ({ status: 500 }) }));
  assert.deepEqual(out.resolved, ['PRRT_a', 'PRRT_b']);
  assert.deepEqual(out.failures, [{ phase: 'revoke', expected: 'http 204', actual: 'http 500' }]);
  const thrown = await call(network({ revoke: () => { throw new Error(TOKEN); } }));
  assert.deepEqual(thrown.failures, [{ phase: 'revoke', expected: 'http 204', actual: 'request failed Error' }]);
});

test('no failure, success or anything else the call returns ever contains the token, the JWT, the key or a response body', async () => {
  const leaks = [TOKEN, 'Validation Failed', 'Resource not accessible', 'socket closed', 'PRIVATE KEY'];
  for (const plan of [{ mint: () => json(422, { message: `Validation Failed ${TOKEN}` }), }, {
    resolve: () => json(200, { errors: [{ type: 'FORBIDDEN', message: `Resource not accessible ${TOKEN}` }] }),
    revoke: () => { throw new Error(`socket closed ${TOKEN}`); },
  }, {}]) {
    const net = network(plan);
    const out = JSON.stringify(await call(net));
    for (const secret of leaks) assert.ok(!out.includes(secret), `${secret} leaked into ${out}`);
    const jwt = net.calls[0].auth.replace(/^Bearer /, '');
    assert.ok(!out.includes(jwt));
  }
});

test('missing or malformed App settings fail in the config phase, name the setting not its value, and send nothing', async () => {
  for (const [name, value, actual] of [
    ['MIVO_WATCHER_PRAISEBUILD_APP_ID', undefined, 'missing'],
    ['MIVO_WATCHER_PRAISEBUILD_INSTALLATION_ID', undefined, 'missing'],
    ['MIVO_WATCHER_PRAISEBUILD_PRIVATE_KEY_PATH', undefined, 'missing'],
    ['MIVO_WATCHER_PRAISEBUILD_APP_ID', 'not-a-number', 'invalid'],
    ['MIVO_WATCHER_PRAISEBUILD_INSTALLATION_ID', '12 34', 'invalid'],
  ]) {
    const net = network();
    const env = { ...ENV, [name]: value };
    if (value === undefined) delete env[name];
    const out = await call(net, { env });
    assert.equal(out.resolved.length, 0);
    assert.equal(out.failures.length, 1);
    assert.equal(out.failures[0].phase, 'config');
    assert.equal(out.failures[0].actual, actual);
    assert.match(out.failures[0].expected, /^praisebuild(AppId|InstallationId|PrivateKeyPath) /);
    assert.ok(!JSON.stringify(out).includes('not-a-number') && !JSON.stringify(out).includes('12 34'));
    assert.equal(net.calls.length, 0, 'no request without complete settings');
  }
});

test('a key file that cannot be read or is not a usable key fails in the config phase, before any request', async () => {
  const unreadable = network();
  const missing = await call(unreadable, { readFile: () => { throw Object.assign(new Error(`ENOENT ${KEY_PATH}`), { code: 'ENOENT' }); } });
  assert.deepEqual(missing, { resolved: [], failures: [{ phase: 'config', expected: 'private key readable and usable for RS256', actual: 'unusable ENOENT' }] });
  const bad = network();
  const out = await call(bad, { readFile: () => 'not a key' });
  assert.equal(out.failures[0].phase, 'config');
  assert.ok(!JSON.stringify(out).includes('not a key'));
  assert.equal(unreadable.calls.length + bad.calls.length, 0);
});

test('a target repository that is not owner/name fails in the config phase', async () => {
  for (const repo of [undefined, '', 'no-slash', 'a/b/c']) {
    const net = network();
    const out = await call(net, { repo });
    assert.deepEqual(out, { resolved: [], failures: [{ phase: 'config', expected: 'target repo as owner/name', actual: 'invalid' }] });
    assert.equal(net.calls.length, 0);
  }
});

test('the switch is off unless the profile holds the boolean true or the environment says 1 or true', () => {
  const on = (env) => resolveWithAppEnabled({ MIVO_WATCHER_HOME: EMPTY_HOME, ...env });
  assert.equal(on({}), false, 'nothing set');
  for (const value of ['1', 'true']) assert.equal(on({ MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP: value }), true, value);
  for (const value of ['0', 'false', '', 'yes', 'TRUE', ' 1']) assert.equal(on({ MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP: value }), false, JSON.stringify(value));
});

test('the switch and the App settings can come from the profile; the environment wins when it is set', t => {
  // The profile is cached per home, so every case gets a home of its own.
  const write = (profile, raw = JSON.stringify(profile)) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-token-profile-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, 'config'));
    fs.writeFileSync(path.join(dir, 'config', 'profile.json'), raw);
    return dir;
  };
  assert.equal(resolveWithAppEnabled({ MIVO_WATCHER_HOME: write({ resolveFixedThreadsWithApp: true }) }), true);
  for (const value of ['true', 1, 'yes', null, false]) {
    assert.equal(resolveWithAppEnabled({ MIVO_WATCHER_HOME: write({ resolveFixedThreadsWithApp: value }) }), false, JSON.stringify(value));
  }
  assert.equal(resolveWithAppEnabled({ MIVO_WATCHER_HOME: write({ resolveFixedThreadsWithApp: true }), MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP: '0' }), false);
  assert.equal(resolveWithAppEnabled({ MIVO_WATCHER_HOME: write({ resolveFixedThreadsWithApp: false }), MIVO_WATCHER_RESOLVE_FIXED_THREADS_WITH_APP: '1' }), true);
  assert.equal(resolveWithAppEnabled({ MIVO_WATCHER_HOME: write(null, '{ not json') }), false, 'an unreadable profile leaves the switch off');
  const settings = readAppConfig({ MIVO_WATCHER_HOME: write({ praisebuildAppId: 111, praisebuildInstallationId: '222', praisebuildPrivateKeyPath: '/virtual/k' }) });
  assert.deepEqual(settings, { appId: '111', installationId: '222', privateKeyPath: '/virtual/k' });
});
