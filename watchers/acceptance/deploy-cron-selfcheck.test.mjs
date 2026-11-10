import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { expandMinutes, checkSchedule, classifyCrontab, describe, fingerprint, nextNotification, REQUIRED_ARGS } from './bin/deploy-cron-selfcheck.mjs';

const BIN = fileURLToPath(new URL('./bin/deploy-cron-selfcheck.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOCS = fileURLToPath(new URL('../../docs/acceptance-operations.md', import.meta.url));
const SCRIPT = '/opt/example/deploy-ff.mjs';
const ARGS = { '--deploy-dir': '/srv/example/deploy', '--host-state': '/srv/example/state' };
const INTERPRETER = process.execPath; // 用当前 node：CI 与本地都不需要额外的 /usr/bin/node
const FULL = {
  '--deploy-dir': '/srv/example/deploy',
  '--host-state': '/srv/example/state',
  '--self-lock': '/srv/example/deploy.lock',
  '--prio-lock': '/srv/example/prio.lock',
  '--state-file': '/srv/example/state.json',
  '--alerts': '/srv/example/alerts.jsonl',
  '--doctor-script': '/srv/example/doctor.mjs',
};

const entry = (args = FULL, script = SCRIPT, minute = '2-59/5') =>
  `${minute} * * * * env -i PATH=/usr/bin:/bin HOME=/home/example ${INTERPRETER} ${script} ${Object.entries(args).map(([k, v]) => `${k} ${v}`).join(' ')} </dev/null >>/srv/example/deploy.log 2>>/srv/example/deploy.err`;

const expect = { script: SCRIPT, args: FULL };
const alwaysOk = { isExecutable: () => true };

test('#367 有效条目：7 必填参数齐全、节拍每 5 分钟覆盖 → ok', () => {
  const verdict = classifyCrontab({ text: `${entry()}\n`, exitCode: 0, expect, statics: alwaysOk });
  assert.equal(verdict.kind, 'ok');
});

test('#367 小时边界：2-59/5 跨小时回绕间隔仍是 5 分钟', () => {
  assert.deepEqual(expandMinutes('2-59/5').slice(0, 3), [2, 7, 12]);
  assert.deepEqual(expandMinutes('2-59/5').slice(-2), [52, 57]);
  assert.equal(checkSchedule(['2-59/5', '*', '*', '*', '*']), null);
  assert.deepEqual(expandMinutes('*/5').slice(0, 2), [0, 5]);
});

test('#367 缺失：没有任何目标条目 → missing', () => {
  const verdict = classifyCrontab({ text: '24,54 * * * * /srv/example/run.sh\n', exitCode: 0, expect, statics: alwaysOk });
  assert.equal(verdict.kind, 'missing');
  assert.equal(verdict.detail, 'absent');
});

test('#367 被注释：只有注释掉的目标条目 → commented，不误判缺失', () => {
  const verdict = classifyCrontab({ text: `# ${entry()}\n`, exitCode: 0, expect, statics: alwaysOk });
  assert.equal(verdict.kind, 'commented');
});

test('#367 重复：两条有效条目 → duplicate', () => {
  const verdict = classifyCrontab({ text: `${entry()}\n${entry()}\n`, exitCode: 0, expect, statics: alwaysOk });
  assert.equal(verdict.kind, 'duplicate');
});

test('#367 未知语法：变量拼接的写法 → unknown-form，不当缺失', () => {
  const mystery = `2-59/5 * * * * sh -c "node $SCRIPT_HOME/deploy-ff.mjs"`;
  const verdict = classifyCrontab({ text: `${mystery}\n`, exitCode: 0, expect, statics: alwaysOk });
  assert.equal(verdict.kind, 'unknown-form');
});

test('#367 未知语法：节拍写法认不出 → unknown-form', () => {
  const verdict = classifyCrontab({ text: `${entry(FULL, SCRIPT, '*/5/5')}\n`, exitCode: 0, expect, statics: alwaysOk });
  assert.equal(verdict.kind, 'unknown-form');
});

test('#367 节拍不对：一天一次、间隔过大、限制到某小时', () => {
  assert.equal(classifyCrontab({ text: `${entry(FULL, SCRIPT, '0')}\n`, exitCode: 0, expect, statics: alwaysOk }).detail, 'schedule-gap');
  assert.equal(classifyCrontab({ text: `${entry(FULL, SCRIPT, '*/30')}\n`, exitCode: 0, expect, statics: alwaysOk }).detail, 'schedule-gap');
  assert.equal(classifyCrontab({ text: `0-59/5 3 * * * env -i ${INTERPRETER} ${SCRIPT} ${Object.entries(FULL).map(([k, v]) => `${k} ${v}`).join(' ')}\n`, exitCode: 0, expect, statics: alwaysOk }).detail, 'schedule-scope');
});

test('#367 参数不对：七个必填参数逐个缺席都报出对应字段', () => {
  for (const flag of REQUIRED_ARGS) {
    const partial = { ...FULL };
    delete partial[flag];
    const verdict = classifyCrontab({ text: `${entry(partial)}\n`, exitCode: 0, expect, statics: alwaysOk });
    assert.equal(verdict.kind, 'mismatch', flag);
    assert.match(verdict.detail, new RegExp(`${flag}:absent`), flag);
  }
});

test('#367 参数不对：取值与约定不一致、解释器不可执行都报参数不对', () => {
  const wrong = classifyCrontab({ text: `${entry({ ...FULL, '--host-state': '/srv/other/state' })}\n`, exitCode: 0, expect, statics: alwaysOk });
  assert.equal(wrong.kind, 'mismatch');
  assert.match(wrong.detail, /--host-state:value/);
  const noexec = classifyCrontab({ text: `${entry()}\n`, exitCode: 0, expect, statics: { isExecutable: () => false } });
  assert.equal(noexec.kind, 'mismatch');
  assert.equal(noexec.detail, 'interpreter:not-executable');
});

test('#367 读取失败与无 crontab 严格区分', () => {
  const denied = classifyCrontab({ text: '', exitCode: 1, stderr: 'crontab: permission denied\n', expect, statics: alwaysOk });
  assert.equal(denied.kind, 'unreadable');
  const empty = classifyCrontab({ text: '', exitCode: 1, stderr: 'no crontab for example\n', expect, statics: alwaysOk });
  assert.equal(empty.kind, 'missing');
  assert.equal(empty.detail, 'no-crontab');
  const unclear = classifyCrontab({ text: '', exitCode: 1, stderr: 'something odd\n', expect, statics: alwaysOk });
  assert.equal(unclear.kind, 'unreadable');
});

test('#367 缺退出码不默认成 0：判读不出，不判缺失', () => {
  const noCode = classifyCrontab({ text: `${entry()}\n`, exitCode: null, stderr: '', expect, statics: alwaysOk });
  assert.equal(noCode.kind, 'unreadable');
  assert.equal(noCode.detail, 'no-exit-code');
  const badCode = classifyCrontab({ text: '', exitCode: Number.NaN, stderr: '', expect, statics: alwaysOk });
  assert.equal(badCode.kind, 'unreadable');
  assert.equal(badCode.detail, 'bad-exit-code');
});

test('#367 规范路径：符号链接/等价路径算同一条，不同文件不算', () => {
  const real = { '/srv/real/deploy-ff.mjs': '/srv/real/deploy-ff.mjs', '/srv/link/deploy-ff.mjs': '/srv/real/deploy-ff.mjs', '/srv/other/deploy-ff.mjs': '/srv/other/deploy-ff.mjs' };
  const statics = { isExecutable: () => true, realpath: (file) => real[file] ?? null };
  const expectReal = { script: '/srv/real/deploy-ff.mjs', args: FULL };
  const viaLink = classifyCrontab({ text: `${entry(FULL, '/srv/link/deploy-ff.mjs')}\n`, exitCode: 0, expect: expectReal, statics });
  assert.equal(viaLink.kind, 'ok');
  const otherFile = classifyCrontab({ text: `${entry(FULL, '/srv/other/deploy-ff.mjs')}\n`, exitCode: 0, expect: expectReal, statics });
  assert.notEqual(otherFile.kind, 'ok');
  assert.notEqual(otherFile.kind, 'missing');
});

test('#367 无 crontab 只认整段确定文本：混入其它错误一律读取失败', () => {
  const mixed = classifyCrontab({ text: '', exitCode: 1, stderr: 'no crontab for example\ncrontab: cannot open spool\n', expect, statics: alwaysOk });
  assert.equal(mixed.kind, 'unreadable');
  const wrapped = classifyCrontab({ text: '', exitCode: 1, stderr: 'crontab: warning: something\nno crontab for example\n', expect, statics: alwaysOk });
  assert.equal(wrapped.kind, 'unreadable');
  const zeroExit = classifyCrontab({ text: '', exitCode: 0, stderr: 'no crontab for example\n', expect, statics: alwaysOk });
  assert.equal(zeroExit.kind, 'missing');
  assert.equal(zeroExit.detail, 'absent');
});

test('#367 SC2 缺失告警带实际行数与匹配数，指纹仍不看行数', () => {
  const text = '24,54 * * * * /srv/example/run.sh\n17 * * * * /srv/example/other.sh\n';
  const verdict = classifyCrontab({ text, exitCode: 0, expect, statics: alwaysOk });
  assert.equal(verdict.kind, 'missing');
  const message = describe(verdict);
  assert.match(message, /实际行数 2/);
  assert.match(message, /匹配数 0/);
  assert.equal(fingerprint(verdict.kind, verdict.detail), fingerprint('missing', 'absent'));
});

test('#367 SC2 读取输入文件失败不当缺失', () => {
  const home = makeHome();
  const missing = path.join(home, 'no-such-crontab.txt');
  const r = spawnSync(process.execPath, [BIN, ...baseArgs(home), '--crontab-file', missing, '--exit-code', '0', '--stderr-text', ''], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.err);
  assert.equal(stateOf(r).state, 'unreadable');
  assert.equal(stateOf(r).detail, 'read-failed');
  assert.doesNotMatch(alertsOf(home)[0].reason, /找不到部署定时条目/);
});

test('#367 指纹不含行号与计数：无关行变化不改指纹', () => {
  assert.equal(fingerprint('missing', 'absent'), fingerprint('missing', 'absent'));
  assert.notEqual(fingerprint('mismatch', '--alerts:absent'), fingerprint('mismatch', '--host-state:absent'));
});

test('#367 节奏：首次正常静默、同情形一次、真实恢复一次、情形变化可见', () => {
  assert.deepEqual(nextNotification(null, { kind: 'ok', detail: '' }).notify, null);
  const first = nextNotification(null, { kind: 'missing', detail: 'absent' });
  assert.equal(first.notify, 'deploy-cron-missing');
  assert.equal(nextNotification(first.next, { kind: 'missing', detail: 'absent' }).notify, null);
  assert.equal(nextNotification(first.next, { kind: 'duplicate', detail: 'entries:2' }).notify, 'deploy-cron-duplicate');
  assert.equal(nextNotification(first.next, { kind: 'ok', detail: '' }).notify, 'deploy-cron-recovered');
  const healthy = nextNotification(null, { kind: 'ok', detail: '' });
  assert.equal(nextNotification(healthy.next, { kind: 'ok', detail: '' }).notify, null);
});

// ---------- CLI 黑盒：临时 HOME + 假 crontab 命令，绝不碰真实 crontab ----------

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cron367-'));
  fs.mkdirSync(path.join(home, 'state', 'host'), { recursive: true });
  return home;
}

function fakeCrontab(home, { text = '', exitCode = 0, stderr = '' }) {
  const dir = path.join(home, 'fakebin');
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'crontab');
  fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(path.join(home, 'calls.log'))}\ncat <<'EOF'\n${text}\nEOF\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${exitCode}\n`, { mode: 0o755 });
  return script;
}

const baseArgs = (home) => ['--home', home, '--expect-script', SCRIPT, ...Object.entries(FULL).flatMap(([k, v]) => ['--expect-arg', `${k}=${v}`])];

function run(home, extra = []) {
  const result = spawnSync(process.execPath, [BIN, ...baseArgs(home), ...extra], { encoding: 'utf8' });
  return { ...result, out: result.stdout, err: result.stderr };
}

/** 真跑一个假 crontab 命令，把它的 stdout/退出码/stderr 原样交给被测 CLI（本文件仍不起子进程）。 */
function runViaFakeCrontab(home) {
  const read = spawnSync('sh', ['-c', `"${path.join(home, 'fakebin', 'crontab')}" -l`], { encoding: 'utf8' });
  const result = spawnSync(process.execPath, [
    BIN, ...baseArgs(home),
    '--exit-code', String(read.status ?? 1),
    '--stderr-text', read.stderr || '',
  ], { encoding: 'utf8', input: read.stdout || '' });
  return { ...result, out: result.stdout, err: result.stderr, readStatus: read.status };
}

function alertsOf(home) {
  const file = path.join(home, 'state', 'host', 'alerts.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** 按文档接线跑一遍：`crontab -l` 的输出先落文件，退出码与 stderr 显式传进去（不是管道）。 */
function runWired(home) {
  const read = spawnSync('sh', ['-c', `"${path.join(home, 'fakebin', 'crontab')}" -l`], { encoding: 'utf8' });
  const outFile = path.join(home, 'crontab.out');
  fs.writeFileSync(outFile, read.stdout || '');
  const result = spawnSync(process.execPath, [
    BIN, ...baseArgs(home),
    '--crontab-file', outFile,
    '--exit-code', String(read.status ?? 1),
    '--stderr-text', read.stderr || '',
  ], { encoding: 'utf8' });
  return { ...result, out: result.stdout, err: result.stderr };
}

const stateOf = (result) => JSON.parse((result.out ?? result.stdout ?? '').split('\n')[0]);

test('#367 CLI 黑盒：缺 --exit-code 判读不出，不报缺失', () => {
  const home = makeHome();
  fakeCrontab(home, { text: entry() });
  const r = spawnSync(process.execPath, [BIN, ...baseArgs(home), '--stderr-text', ''], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.err);
  assert.equal(stateOf(r).state, 'unreadable');
  assert.equal(stateOf(r).detail, 'no-exit-code');
  const alert = alertsOf(home)[0];
  assert.equal(alert.kind, 'deploy-cron-unreadable');
  assert.doesNotMatch(alert.reason, /找不到部署定时条目/);
  assert.match(alert.reason, /不代表缺失/);
});

test('#367 CLI 黑盒：退出码非 0 且 stderr 为空 → 读取失败，不当无 crontab', () => {
  const home = makeHome();
  fakeCrontab(home, { exitCode: 1, stderr: '' });
  const r = runWired(home);
  assert.equal(r.status, 0, r.err);
  assert.equal(stateOf(r).state, 'unreadable');
  assert.equal(stateOf(r).detail, 'read-failed');
  assert.equal(alertsOf(home)[0].kind, 'deploy-cron-unreadable');
});

test('#367 CLI 黑盒：整段 no crontab → 缺失（no-crontab）', () => {
  const home = makeHome();
  fakeCrontab(home, { exitCode: 1, stderr: 'no crontab for example' });
  const r = runWired(home);
  assert.equal(r.status, 0, r.err);
  assert.equal(stateOf(r).state, 'missing');
  assert.equal(stateOf(r).detail, 'no-crontab');
  assert.equal(alertsOf(home)[0].kind, 'deploy-cron-missing');
});

test('#367 CLI 黑盒：混入其它错误文本的 no crontab 不算确定空 → 读取失败', () => {
  const home = makeHome();
  fakeCrontab(home, { exitCode: 1, stderr: 'no crontab for example\ncrontab: cannot open spool' });
  const r = runWired(home);
  assert.equal(r.status, 0, r.err);
  assert.equal(stateOf(r).state, 'unreadable');
  assert.equal(stateOf(r).detail, 'read-failed');
  assert.doesNotMatch(alertsOf(home)[0].reason, /找不到部署定时条目/);
});

test('#367 CLI 黑盒：--exit-code 不是整数时退出 2，不静默当成 0', () => {
  const home = makeHome();
  const r = spawnSync(process.execPath, [BIN, ...baseArgs(home), '--exit-code', 'abc'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--exit-code 需要整数/);
});

test('#367 CLI --help：用法串给的是从仓根可跑的路径，并点名 --exit-code 必给', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /node watchers\/acceptance\/bin\/deploy-cron-selfcheck\.mjs/);
  assert.match(r.stdout, /--exit-code 必须给/);
});

test('#367 CLI 黑盒：有效条目首次健康 → 静默、无告警、只调 crontab -l', () => {
  const home = makeHome();
  const cmd = fakeCrontab(home, { text: entry() });
  const r = runViaFakeCrontab(home);
  assert.equal(r.status, 0, r.err);
  assert.equal(alertsOf(home).length, 0);
  assert.equal(JSON.parse(r.out.split('\n')[0]).state, 'ok');
  assert.deepEqual(fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n'), ['-l']);
});

test('#367 SC2 CLI 缺失告警带实际行数与匹配数', () => {
  const home = makeHome();
  fakeCrontab(home, { text: '24,54 * * * * /srv/example/run.sh\n17 * * * * /srv/example/other.sh\n' });
  const r = runViaFakeCrontab(home);
  assert.equal(r.status, 0, r.err);
  const alert = alertsOf(home)[0];
  assert.equal(alert.kind, 'deploy-cron-missing');
  assert.match(alert.reason, /实际行数 2/);
  assert.match(alert.reason, /匹配数 0/);
});

test('#367 CLI 黑盒：缺失一次告警，同一情形第二轮不再告警，恢复只一次', () => {
  const home = makeHome();
  const cmd = fakeCrontab(home, { text: '24,54 * * * * /srv/example/run.sh\n' });
  assert.equal(runViaFakeCrontab(home).status, 0);
  assert.equal(runViaFakeCrontab(home).status, 0);
  const first = alertsOf(home);
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, 'deploy-cron-missing');
  assert.match(first[0].reason, /部署/);
  assert.match(first[0].reason, /要人处理/);
  // 恢复：换成有效条目
  fakeCrontab(home, { text: entry() });
  assert.equal(runViaFakeCrontab(home).status, 0);
  assert.equal(runViaFakeCrontab(home).status, 0);
  const after = alertsOf(home);
  assert.equal(after.length, 2);
  assert.equal(after[1].kind, 'deploy-cron-recovered');
  assert.match(after[1].reason, /已恢复正常/);
});

test('#367 CLI 黑盒：同类但错法不同不被永久吞掉', () => {
  const home = makeHome();
  fakeCrontab(home, { text: `${entry({ ...FULL, '--alerts': '/srv/other/alerts.jsonl' })}\n` });
  runViaFakeCrontab(home);
  fakeCrontab(home, { text: `${entry({ ...FULL, '--state-file': '/srv/other/s.json' })}\n` });
  runViaFakeCrontab(home);
  const alerts = alertsOf(home);
  assert.equal(alerts.length, 2);
  assert.match(alerts[0].reason, /参数/);
  assert.match(alerts[1].reason, /参数/);
});

test('#367 CLI 黑盒：读取失败不报缺失、不吞错误', () => {
  const home = makeHome();
  fakeCrontab(home, { exitCode: 1, stderr: 'crontab: permission denied' });
  const r = runViaFakeCrontab(home);
  assert.equal(r.status, 0, r.err);
  assert.equal(alertsOf(home)[0].kind, 'deploy-cron-unreadable');
  assert.doesNotMatch(alertsOf(home)[0].reason, /找不到部署定时条目/);
});

test('#367 CLI 黑盒：解释器不可执行（真路径校验，不用注入）→ 参数不对，不静默', () => {
  const home = makeHome();
  const broken = entry().replace(INTERPRETER, '/nonexistent/node-for-test');
  fakeCrontab(home, { text: `${broken}\n` });
  const r = runViaFakeCrontab(home);
  assert.equal(r.status, 0, r.err);
  const first = alertsOf(home)[0];
  assert.equal(first.kind, 'deploy-cron-mismatch');
  assert.match(first.reason, /参数/);
  assert.equal(JSON.parse(r.out.split('\n')[0]).state, 'mismatch');
});

test('#367 CLI 黑盒：输出与告警安全（不含整份 cron、无关行、绝对路径、凭据）', () => {
  const home = makeHome();
  const secretLine = '17 * * * * /srv/example/other.sh --credential FIXTURE-SECRET-VALUE';
  fakeCrontab(home, { text: `${secretLine}\n` });
  const r = runViaFakeCrontab(home);
  const alert = alertsOf(home)[0];
  const blob = `${r.out}${r.err}${JSON.stringify(alert)}`;
  assert.doesNotMatch(blob, /FIXTURE-SECRET-VALUE/);
  assert.doesNotMatch(blob, /other\.sh/);
  assert.doesNotMatch(blob, /env -i PATH=/);
  assert.equal((blob.match(/2-59\/5 \* \* \* \*/g) || []).length, 0);
  assert.equal(alert.detail, 'absent');
});

test('#367 CLI 黑盒：收到信号/参数缺失时失败可见（不是静默成功）', () => {
  const home = makeHome();
  const r = spawnSync(process.execPath, [BIN, '--home', home], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /缺必填参数/);
});

test('#367 文档里的示例命令从仓根原样执行（路径从文档取，不锁死前缀）', () => {
  const home = makeHome();
  fakeCrontab(home, { text: entry() });
  const block = fillDocBlock(docExampleBlock(), home);
  const script = block.match(/^node\s+(\S+)/m);
  assert.ok(script, '文档示例里找不到 node 命令');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, script[1])), `文档示例的脚本路径从仓根不可达：${script[1]}`);
  const r = spawnSync('sh', ['-c', block], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(home, 'fakebin')}:${process.env.PATH || ''}` },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(stateOf(r).state, 'ok', r.stdout);
  assert.equal(alertsOf(home).length, 0);
  assert.deepEqual(fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n'), ['-l']);
});

/** 从文档 §15 取出那段示例代码块（含反斜杠续行，原样返回）。 */
function docExampleBlock() {
  const doc = fs.readFileSync(DOCS, 'utf8');
  const section = doc.split('## 15. 部署定时自检（#367）')[1] || '';
  assert.ok(section.length > 0, '文档缺 #367 小节');
  const lines = section.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '```sh') continue;
    const end = lines.indexOf('```', i + 1);
    if (end < 0) break;
    const body = lines.slice(i + 1, end);
    if (body.join('\n').includes('deploy-cron-selfcheck.mjs')) return body.join('\n');
    i = end;
  }
  assert.fail('文档 §15 缺自检示例命令代码块');
}

/** 只换掉文档里的占位符，命令其余部分一个字都不改。 */
function fillDocBlock(block, home) {
  const values = {
    '<验收机 home>': home,
    '<部署脚本绝对路径>': SCRIPT,
    '<部署目录>': FULL['--deploy-dir'],
    '<宿主状态目录>': FULL['--host-state'],
    '<自锁文件>': FULL['--self-lock'],
    '<优先级锁文件>': FULL['--prio-lock'],
    '<状态文件>': FULL['--state-file'],
    '<告警文件>': FULL['--alerts'],
    '<体检脚本>': FULL['--doctor-script'],
  };
  let out = block;
  for (const [placeholder, value] of Object.entries(values)) out = out.split(placeholder).join(value);
  assert.doesNotMatch(out, /<[^>\n]*>/, '文档示例里还有没替换的占位符');
  return out;
}
