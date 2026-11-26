import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { at, fixture } from './fixtures/guard/cases.mjs';

test('SC7: baseline CLI reads only top-level legacy results and preserves unparsed totals', (t) => {
  const { directory, env } = fixture(t);
  const results = path.join(directory, 'results');
  fs.mkdirSync(path.join(results, 'history'), { recursive: true });
  fs.writeFileSync(path.join(results, 'history', 'ignored.json'), 'not json');
  fs.writeFileSync(path.join(directory, 'ignored.json'), 'not json');
  const write = (name, result) => fs.writeFileSync(path.join(results, name), JSON.stringify(result));
  const make = (index, number, pushed, dispatched, observedAt = at(index * 10)) => ({
    kind: 'mivo-repair-result', repo: 'example-org/example-repo', number, pushed, observedAt,
    dispatchId: dispatched, status: pushed ? 'waiting-ci' : 'blocked',
  });
  for (const [index, number, pushed] of [[1, 1, true], [2, 1, true], [3, 1, false], [4, 2, false], [5, 3, true]]) {
    const timestamp = index % 2 ? at(0) : at(0).replace(/[:.]/g, '-');
    write(`${index}.json`, make(index, number, pushed, `live-${number}-${timestamp}`));
  }
  write('unparsed.json', make(6, 2, false, 'malformed'));
  write('outside.json', make(7, 3, false, at(0), '2026-01-02T00:00:00.000Z'));
  write('other.json', { ...make(8, 3, false, at(0)), kind: 'other' });
  const before = fs.readdirSync(results).filter((name) => name.endsWith('.json'))
    .map((name) => [name, fs.readFileSync(path.join(results, name), 'utf8')]);
  const result = spawnSync(process.execPath, [
    'watchers/steward/bin/baseline-legacy.mjs', '--state', directory, '--since', '2026-01-01', '--until', '2026-01-01',
  ], { env, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    results: 6, pushed: 3, statuses: { 'waiting-ci': 3, blocked: 3 },
    durationMinutes: { samples: 5, p50: 30, p75: 40, p90: 50, p95: 50 },
    unparsed: 1, unknownObservedAt: 0, pushedWithLaterResultRatio: 0.667, pushedWithUnknownPr: 0, maxResultsPerPr: 3,
  });
  for (const [name, contents] of before) assert.equal(fs.readFileSync(path.join(results, name), 'utf8'), contents);
});
