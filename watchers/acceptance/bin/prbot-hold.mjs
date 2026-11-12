#!/usr/bin/env node
// 修正轮挂起名单的运维 CLI：add / remove / list。只改宿主本地的 <home>/state/prbot/hold.json，不碰 GitHub。
//
//   ACCEPTANCE_WATCHER_HOME=<home> node watchers/acceptance/bin/prbot-hold.mjs add ExampleUser/demo#12 \
//     --reason '等集成分支' --until-merged integration/demo [--into main] [--repo ExampleUser/demo]
//   … add ExampleUser/demo#13 --reason '等到明早' --until-time 2026-01-02T09:00:00+08:00
//   … add ExampleUser/demo#14 --reason '等上游改需求' --manual
//   … remove ExampleUser/demo#12
//   … list
//
// 同一个 issue 再 add 会替换旧条目。hold.json 读不出或格式不对时拒绝写（不覆盖），先人工修好。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPaths } from '../host/paths.mjs';
import { HOLD_FILE_VERSION, describeHolds, holdFilePath, isIssueRef, readHolds, toUntil } from '../host/prbot-hold.mjs';

const USAGE = [
  '用法：ACCEPTANCE_WATCHER_HOME=<home> node bin/prbot-hold.mjs <命令>',
  '  add <owner/repo#n> --reason <原因> (--until-time <ISO 时间> | --until-merged <分支> [--into <base>] [--repo <owner/repo>] | --manual)',
  '  remove <owner/repo#n>',
  '  list',
].join('\n');

function optionValue(args, name) {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

function readRawHolds(paths) {
  const file = holdFilePath(paths);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { holds: [] };
    return { error: `hold.json 读不出：${error?.code || error?.message}` };
  }
  if (text.trim() === '') return { holds: [] };
  // 整份读不出才拒绝；单条写坏的照样能 remove / 覆盖。
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.version !== HOLD_FILE_VERSION || !Array.isArray(parsed.holds)) {
    const { problems } = readHolds(paths);
    return { error: `hold.json 有问题，先人工修好再改：${problems.join('；')}` };
  }
  return { holds: parsed.holds };
}

function writeRawHolds(paths, holds) {
  const file = holdFilePath(paths);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: HOLD_FILE_VERSION, holds }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 跑一次 CLI；返回退出码。测试直接调。 */
export function runHoldCli(argv, { home, now = () => Date.now(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const fail = (message) => {
    stderr.write(`${message}\n`);
    return 1;
  };
  if (typeof home !== 'string' || !path.isAbsolute(home)) return fail('需要绝对路径的 ACCEPTANCE_WATCHER_HOME');
  const paths = hostPaths(home);
  const [command, ...args] = argv;
  if (command === 'list') {
    const { rows, problems } = describeHolds(paths, { now });
    for (const problem of problems) stdout.write(`! ${problem}\n`);
    if (rows.length === 0) stdout.write('（没有挂起条目）\n');
    for (const row of rows) stdout.write(`${row.issue}\t${row.status}\t${row.untilText}\t${row.reason}\n`);
    return problems.length > 0 ? 1 : 0;
  }
  if (command !== 'add' && command !== 'remove') return fail(USAGE);
  const issue = args[0];
  if (!isIssueRef(issue)) return fail(`issue 引用应为 owner/repo#n，实际：${String(issue)}`);
  const current = readRawHolds(paths);
  if (current.error) return fail(current.error);
  const others = current.holds.filter((entry) => String(entry?.issue).toLowerCase() !== issue.toLowerCase());
  if (command === 'remove') {
    if (others.length === current.holds.length) return fail(`${issue} 不在挂起名单里`);
    writeRawHolds(paths, others);
    stdout.write(`已移除 ${issue}\n`);
    return 0;
  }
  const reason = optionValue(args, '--reason');
  if (typeof reason !== 'string' || !reason.trim()) return fail('add 需要 --reason <原因>');
  const kinds = ['--until-time', '--until-merged', '--manual'].filter((name) => args.includes(name));
  if (kinds.length !== 1) return fail(`add 需要且只能给一个到期条件（--until-time / --until-merged / --manual），实际给了 ${kinds.length} 个`);
  let raw;
  if (kinds[0] === '--manual') raw = { type: 'manual' };
  else if (kinds[0] === '--until-time') raw = { type: 'time', at: optionValue(args, '--until-time') };
  else {
    raw = { type: 'merged', branch: optionValue(args, '--until-merged') };
    const base = optionValue(args, '--into');
    const repo = optionValue(args, '--repo');
    if (base !== undefined) raw.base = base;
    if (repo !== undefined) raw.repo = repo;
  }
  const checked = toUntil(raw, issue);
  if (checked.error) return fail(checked.error);
  const entry = { issue, reason: reason.trim(), until: checked.until, addedAt: new Date(now()).toISOString() };
  writeRawHolds(paths, [...others, entry]);
  stdout.write(`已挂起 ${issue}\n`);
  return 0;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  process.exitCode = runHoldCli(process.argv.slice(2), { home: process.env.ACCEPTANCE_WATCHER_HOME });
}
