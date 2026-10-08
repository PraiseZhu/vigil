#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { collectPrOwnershipSync } from './mivo-pr-snapshot.mjs';

const same = (a, b) => typeof a === 'string' && a.length > 0 && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const validId = value => (typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value) && value !== '0')
  || (Number.isSafeInteger(value) && value > 0);
const human = user => typeof user?.login === 'string' && user.login.length > 0
  && !/\[bot\]$/i.test(user.login) && user.type !== 'Bot' && user.__typename !== 'Bot' && user.is_bot !== true;
const parse = raw => typeof raw === 'string' ? JSON.parse(raw) : raw;
const requireValue = (ok, reason) => { if (!ok) throw new Error(`handoff: ${reason}`); };

function epochTime(pr) {
  if (typeof pr?.releaseEpoch !== 'string' || typeof pr.id !== 'string' || !pr.id) return NaN;
  if (pr.releaseEpoch === `opened:${pr.id}:${pr.createdAt}`) return Date.parse(pr.createdAt);
  if (!pr.releaseEpoch.startsWith(`ready:${pr.id}:`)) return NaN;
  const tail = pr.releaseEpoch.slice(`ready:${pr.id}:`.length);
  const match = tail.match(/^[^:]+:(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)$/);
  return match ? Date.parse(match[1]) : NaN;
}

function eligible(pr) {
  return pr?.state === 'OPEN' && pr.isDraft === false && pr.sameRepository === true
    && pr.isCrossRepository !== true && human(pr.author) && sha(pr.headRefOid)
    && typeof pr.repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(pr.repo)
    && Number.isSafeInteger(pr.number) && pr.number > 0 && Number.isFinite(epochTime(pr));
}

export function isCurrentHandoff(receipt, pr, { allowHeadChange = false } = {}) {
  return !!(eligible(pr) && receipt?.version === 1 && typeof receipt.id === 'string' && validId(receipt.id)
    && same(receipt.repo, pr.repo) && receipt.number === pr.number && receipt.nodeId === pr.id
    && receipt.releaseEpoch === pr.releaseEpoch && same(receipt.author, pr.author.login)
    && sha(receipt.head) && (allowHeadChange || same(receipt.head, pr.headRefOid)));
}

export function selectHandoff(comments, pr, options = {}) {
  if (!eligible(pr) || !Array.isArray(comments)) return null;
  const candidates = [];
  for (const comment of comments) {
    const author = comment?.author ?? comment?.user;
    const created = Date.parse(comment?.createdAt ?? comment?.created_at);
    if (!human(author) || !same(author.login, pr.author.login) || !validId(comment?.id)
      || !Number.isFinite(created) || created < epochTime(pr) || created < Date.parse(pr.createdAt)
      || typeof comment.body !== 'string') continue;
    const lines = [...comment.body.matchAll(/^<!-- vigil-handoff (\{[^\r\n]*\}) -->$/gm)];
    if (lines.length !== 1) continue;
    let payload;
    try { payload = JSON.parse(lines[0][1]); } catch { continue; }
    const receipt = { version: payload.version, id: String(comment.id), repo: payload.repo,
      number: payload.number, nodeId: payload.nodeId, head: payload.head,
      releaseEpoch: payload.releaseEpoch, author: author.login };
    if (isCurrentHandoff(receipt, pr, options)) candidates.push({ receipt, created });
  }
  candidates.sort((a, b) => a.created - b.created || a.receipt.id.localeCompare(b.receipt.id));
  return candidates[0]?.receipt ?? null;
}

function gh(args) {
  return execFileSync(process.env.GH_BIN ?? 'gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
}

function sameOwnership(before, after) {
  return eligible(after) && before.id === after.id && same(before.repo, after.repo)
    && before.number === after.number && same(before.author.login, after.author.login)
    && before.headRefOid === after.headRefOid && before.releaseEpoch === after.releaseEpoch;
}

export function runHandoff({ command, repo, number, expectedHead, ghFn = gh }) {
  requireValue(['inspect', 'handoff', 'reclaim'].includes(command), 'command must be inspect, handoff or reclaim');
  requireValue(typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    && Number.isSafeInteger(number) && number > 0, 'valid --repo and --pr are required');
  const account = parse(ghFn(['api', 'user']));
  const read = () => collectPrOwnershipSync({ pr: { repo, number }, ghFn });
  const before = read();
  const authorAuthorized = human(account) && same(account.login, before.author.login);
  if (expectedHead !== undefined) {
    requireValue(sha(expectedHead), 'expected head must be a full SHA');
    requireValue(same(expectedHead, before.headRefOid), 'PR head changed since the caller checked its gate');
  }
  const comments = () => {
    const pages = parse(ghFn(['api', `repos/${repo}/issues/${number}/comments?per_page=100`, '--paginate', '--slurp']));
    requireValue(Array.isArray(pages) && pages.every(Array.isArray), 'incomplete comments response');
    return pages.flat();
  };
  if (command === 'inspect') {
    const receipt = eligible(before) ? selectHandoff(comments(), before, { allowHeadChange: true }) : null;
    const after = read();
    requireValue(before.id === after.id && before.state === after.state && before.isDraft === after.isDraft
      && before.headRefOid === after.headRefOid && before.releaseEpoch === after.releaseEpoch
      && same(before.author.login, after.author.login), 'PR ownership changed while inspecting handoff');
    const status = before.state !== 'OPEN' || !before.sameRepository ? 'inactive'
      : before.isDraft ? 'author-owned' : receipt ? 'handed-off' : 'ready-unclaimed';
    return { status, pr: after, receipt, authorAuthorized };
  }
  requireValue(authorAuthorized, 'authenticated account must be the PR author');
  requireValue(before.state === 'OPEN' && before.sameRepository, 'PR must be OPEN and from the same repository');
  if (command === 'reclaim') {
    if (!before.isDraft) ghFn(['pr', 'ready', String(number), '--repo', repo, '--undo']);
    const after = read();
    requireValue(after.id === before.id && after.state === 'OPEN' && after.isDraft === true
      && after.sameRepository === true && same(after.author.login, account.login), 'reclaim was not confirmed as Draft');
    return { status: 'author-owned', repo, number, head: after.headRefOid, releaseEpoch: after.releaseEpoch };
  }
  requireValue(eligible(before), 'PR must be OPEN, non-Draft and from the same repository');
  const existing = selectHandoff(comments(), before, { allowHeadChange: true });
  if (existing) {
    requireValue(sameOwnership(before, read()), 'PR ownership changed while reading handoff');
    return { status: 'already-handed-off', receipt: existing };
  }
  const payload = { version: 1, repo: before.repo, number, nodeId: before.id,
    head: before.headRefOid, releaseEpoch: before.releaseEpoch };
  const body = `作者已完成本轮工作并交接给 watcher，作者会话停止写入本 PR。继续修改前，先运行 reclaim 取回处理权。\n\n<!-- vigil-handoff ${JSON.stringify(payload)} -->`;
  // An unknown POST outcome is surfaced to the caller. Never automatically repeat the write.
  const posted = parse(ghFn(['api', `repos/${repo}/issues/${number}/comments`, '--method', 'POST', '-f', `body=${body}`]));
  const receipt = selectHandoff([posted], before);
  requireValue(receipt, 'posted handoff receipt is invalid; inspect the comment before retrying');
  requireValue(sameOwnership(before, read()), 'PR ownership changed after handoff; receipt is not current');
  return { status: 'handed-off', receipt };
}

function cli(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let i = 0; i < rest.length; i += 2) {
    requireValue(['--repo', '--pr', '--expected-head'].includes(rest[i]) && rest[i + 1] && !rest[i + 1].startsWith('--'), 'usage: inspect|handoff|reclaim --repo owner/repo --pr NUMBER [--expected-head SHA]');
    const key = rest[i] === '--pr' ? 'number' : rest[i] === '--expected-head' ? 'expectedHead' : 'repo';
    requireValue(options[key] === undefined, `duplicate ${rest[i]}`);
    options[key] = key === 'number' ? Number(rest[i + 1]) : rest[i + 1];
  }
  return runHandoff(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(cli(process.argv.slice(2)), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
