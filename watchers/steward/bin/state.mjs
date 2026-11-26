import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { REPO } from './profile.mjs';

export function prKey(pr) {
  const match = /^(.+)#([1-9]\d*)$/.exec(pr);
  if (!match || !REPO.test(match[1]) || !Number.isSafeInteger(Number(match[2]))) throw new Error('invalid PR identifier');
  return `${match[1].toLowerCase()}#${match[2]}`;
}

export function storageKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export async function withLock(directory, key, callback) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, `${storageKey(key)}.lock`);
  try {
    fs.writeFileSync(lock, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`state locked: ${key}`, { cause: error });
    throw error;
  }
  try {
    return await callback();
  } finally {
    fs.unlinkSync(lock);
  }
}

function stateFile(directory, pr) {
  return path.join(directory, 'prs', `${storageKey(prKey(pr))}.json`);
}

export function readPr(directory, pr) {
  const state = readJson(stateFile(directory, pr));
  if (state === null) return null;
  if (state.pr !== prKey(pr) || typeof state.halted !== 'boolean') throw new Error('invalid PR state');
  return state;
}

export function writePr(directory, pr, state) {
  const halted = state.halted ?? false;
  if (typeof halted !== 'boolean') throw new Error('halted must be boolean');
  atomicJson(stateFile(directory, pr), { ...state, pr: prKey(pr), halted });
}

export function withPrLock(directory, pr, callback) {
  return withLock(path.join(directory, 'locks'), prKey(pr), callback);
}
