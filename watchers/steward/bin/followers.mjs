import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, prKey, storageKey, withLock, readJson } from './state.mjs';

function followerFile(directory, pr) {
  return path.join(directory, 'followers', `${storageKey(prKey(pr))}.json`);
}

function validate(follower) {
  if (!follower || typeof follower !== 'object' || typeof follower.pr !== 'string'
    || !['original', 'dedicated'].includes(follower.kind)
    || typeof follower.takeover !== 'boolean') throw new Error('invalid follower');
  if (follower.device !== undefined && follower.device !== null && typeof follower.device !== 'string') {
    throw new Error('invalid follower device');
  }
  if (follower.session !== undefined && follower.session !== null && typeof follower.session !== 'string') {
    throw new Error('invalid follower session');
  }
  return follower;
}

export function readFollower(directory, pr) {
  const follower = readJson(followerFile(directory, pr));
  return follower === null ? null : validate(follower);
}

export function writeFollower(directory, pr, value) {
  const follower = validate({ ...value, pr: prKey(pr) });
  atomicJson(followerFile(directory, pr), follower);
  return follower;
}

export function clearFollower(directory, pr) {
  fs.rmSync(followerFile(directory, pr), { force: true });
}

export async function withFollowerLock(directory, pr, callback) {
  return withLock(path.join(directory, 'followers', 'locks'), prKey(pr), callback);
}

export function updateFollower(directory, pr, updater) {
  const current = readFollower(directory, pr);
  const next = updater(current);
  if (next === null) clearFollower(directory, pr);
  else writeFollower(directory, pr, next);
  return next;
}
