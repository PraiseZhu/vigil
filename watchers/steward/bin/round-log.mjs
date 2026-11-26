import fs from 'node:fs';
import path from 'node:path';
import { prKey, storageKey } from './state.mjs';

function logFile(directory, pr) {
  return path.join(directory, 'rounds', `${storageKey(prKey(pr))}.jsonl`);
}

export function readRounds(directory, pr) {
  let contents;
  try {
    contents = fs.readFileSync(logFile(directory, pr), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (contents && !contents.endsWith('\n')) throw new Error('incomplete round log');
  return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function appendRound(directory, pr, event) {
  const file = logFile(directory, pr);
  if (event.id && readRounds(directory, pr).some((previous) => previous.id === event.id)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, `${JSON.stringify({ ...event, pr: prKey(pr) })}\n`, { mode: 0o600, flush: true });
  return true;
}
