import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { distribution, files, minutesBetween, parseFlags, timeWindow } from './metrics.mjs';

function dispatchTime(dispatchId) {
  if (typeof dispatchId !== 'string') return null;
  const match = /(\d{4}-\d{2}-\d{2}T)(\d{2})[:-](\d{2})[:-](\d{2})(?:[.-](\d{3}))?Z$/.exec(dispatchId);
  if (!match) return null;
  const [, date, hour, minute, second, milliseconds] = match;
  return `${date}${hour}:${minute}:${second}${milliseconds ? `.${milliseconds}` : ''}Z`;
}

export function calculateBaseline(results, { since, until }) {
  const inWindow = timeWindow(since, until);
  const matching = results.filter(({ kind }) => kind === 'mivo-repair-result');
  const selected = matching.filter(({ observedAt }) => inWindow(observedAt));
  const durations = [];
  const statuses = new Map();
  const groups = new Map();
  let pushed = 0;
  let unparsed = 0;
  let unknownPr = 0;
  for (const result of selected) {
    const status = typeof result.status === 'string' ? result.status : 'unknown';
    statuses.set(status, (statuses.get(status) ?? 0) + 1);
    const didPush = result.pushed === true;
    if (didPush) pushed += 1;
    const duration = minutesBetween(dispatchTime(result.dispatchId), result.observedAt);
    if (duration === null) unparsed += 1;
    else durations.push(duration);
    const number = result.number;
    if (!Number.isSafeInteger(number) || number < 1) {
      if (didPush) unknownPr += 1;
      continue;
    }
    const key = JSON.stringify([String(result.repo ?? '').toLowerCase(), number]);
    const items = groups.get(key) ?? [];
    items.push(result);
    groups.set(key, items);
  }
  let followed = 0;
  let maxResultsPerPr = 0;
  for (const group of groups.values()) {
    maxResultsPerPr = Math.max(maxResultsPerPr, group.length);
    const latest = Math.max(...group.map(({ observedAt }) => Date.parse(observedAt)));
    followed += group.filter((result) => result.pushed === true && Date.parse(result.observedAt) < latest).length;
  }
  return {
    results: selected.length,
    pushed,
    statuses: Object.fromEntries(statuses),
    durationMinutes: distribution(durations, [50, 75, 90, 95]),
    unparsed,
    unknownObservedAt: matching.filter(({ observedAt }) => minutesBetween(observedAt, observedAt) === null).length,
    pushedWithLaterResultRatio: pushed && !unknownPr ? Number((followed / pushed).toFixed(3)) : null,
    pushedWithUnknownPr: unknownPr,
    maxResultsPerPr,
  };
}

export function main(args, { output = console.log, log = console.error } = {}) {
  try {
    const flags = parseFlags(args, ['state', 'since', 'until']);
    if (!flags.state) throw new Error('必须提供 --state <老盯梢状态目录>');
    timeWindow(flags.since, flags.until);
    const resultsDir = path.join(flags.state, 'results');
    if (!fs.statSync(resultsDir).isDirectory()) throw new Error('results 不是目录');
    const results = files(resultsDir, /\.json$/).map((file) => JSON.parse(fs.readFileSync(file, 'utf8')));
    output(JSON.stringify(calculateBaseline(results, flags)));
    return 0;
  } catch (error) {
    log(`baseline-legacy: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
