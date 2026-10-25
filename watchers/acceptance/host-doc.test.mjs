// #47 SC2–SC5、SC7、SC13（静态部分）：运维文档、三个 watcher 的说明、写闸不自己算哈希、host/ 只从 proc.mjs 起进程。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { bodyVersion as fromRounds } from './bin/rounds.mjs';
import { bodyVersion as fromTasks } from './bin/tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DOC = path.join(ROOT, 'docs', 'acceptance-operations.md');
const HOST = path.join(HERE, 'host');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const doc = read(DOC);

function listHostFiles(dir = HOST) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listHostFiles(full));
    else out.push(full);
  }
  return out;
}

test('SC2 文档写清调度：loop 每分钟按调度文档的顺序、认领前过内存门和测试锁、ensure.sh 每小时巡检', () => {
  assert.match(doc, /每分钟/);
  assert.match(doc, /host\/loop/);
  assert.match(doc, /acceptance-scheduler\.md/);
  assert.match(doc, /认领\*\*之前\*\*过内存门/);
  assert.match(doc, /3 GiB/);
  assert.match(doc, /测试锁/);
  assert.match(doc, /mivo 同时只跑一轮/);
  assert.match(doc, /每小时/);
  assert.match(doc, /ensure\.sh/);
  assert.match(doc, /180 秒/);
});

test('SC2 文档写清模型：验收轮 DeepSeek V4.1 Flash + max，裁决运行 anthropic/claude-opus-5-5 + medium', () => {
  assert.match(doc, /DeepSeek V4\.1 Flash/);
  assert.match(doc, /推理 \*\*max\*\*/);
  assert.match(doc, /anthropic\/claude-opus-5-5/);
  assert.match(doc, /推理 \*\*medium\*\*/);
  assert.match(doc, /有争议/);
  // #46 SC8：裁决运行已实现（host/adjudicate.mjs），文档写清配置。
  assert.match(doc, /已实现/);
  assert.match(doc, /host\/adjudicate\.mjs/);
  assert.match(doc, /adjudicateCommand/);
  assert.match(doc, /adjudicateMaxMinutes/);
  assert.doesNotMatch(doc, /\*\*待实现\*\*/);
});

test('SC2 文档写清写闸：动作类型、分档、总开关、exec 接成 writeCommand', () => {
  for (const type of [
    'comment.create',
    'comment.update',
    'issue.create',
    'issue.close',
    'issue.reopen',
    'issue.edit',
    'subissue.add',
    'project.field.set',
    'branch.push',
    'pr.create',
    'pr.ready',
  ]) {
    assert.ok(doc.includes(`\`${type}\``), `文档没写动作类型 ${type}`);
  }
  assert.match(doc, /read\.graphql/);
  assert.match(doc, /pr\.update-branch/);
  assert.match(doc, /not-implemented/);
  assert.match(doc, /auto/);
  assert.match(doc, /watch/);
  assert.match(doc, /总开关/);
  assert.match(doc, /state\/write-gate\/enabled/);
  assert.match(doc, /gate-disabled/);
  assert.match(doc, /write-gate\.mjs exec/);
  assert.match(doc, /writeCommand/);
  assert.match(doc, /dedupeKey/);
  assert.match(doc, /reason=secret-found/);
});

test('SC2 文档写清卡住与提醒：先结束进程再 abort；提醒只写 alerts.jsonl，Slack 归 #61，验收结论不发通知', () => {
  assert.match(doc, /先结束进程，再 `round\.mjs abort`/);
  assert.match(doc, /alerts\.jsonl/);
  assert.match(doc, /不调 Slack/);
  assert.match(doc, /#61/);
  // 频道名不进仓库（AGENTS.md 脱敏）：只写「profile 的 slackChannelId 指的频道」。
  assert.match(doc, /slackChannelId/);
  assert.match(doc, /Jasper/);
  assert.match(doc, /验收结论不发通知/);
});

test('SC3 文档写清令牌：我的账号、600、只有写闸和只读盘点读、不进仓/日志/bwrap、两种方案与换法', () => {
  assert.match(doc, /我的账号/);
  assert.match(doc, /600/);
  assert.match(doc, /只有两处读 GitHub 令牌/);
  assert.match(doc, /write-gate\.mjs/);
  assert.match(doc, /poll\.mjs/);
  assert.match(doc, /不进仓、不进日志、不进 bwrap/);
  assert.match(doc, /细粒度令牌/);
  assert.match(doc, /classic/);
  assert.match(doc, /换法/);
  assert.match(doc, /githubTokenFile/);
});

test('SC4 文档写清上线顺序、停用和回滚', () => {
  assert.match(doc, /## 6\. 上线顺序/);
  assert.match(doc, /doctor\.mjs/);
  assert.match(doc, /只读运行 24 小时/);
  assert.match(doc, /poll\.mjs --json/);
  assert.match(doc, /手动跑一轮/);
  assert.match(doc, /host\/round\.mjs --issue/);
  assert.match(doc, /常驻循环每分钟/);
  assert.match(doc, /stop\.sh/);
  assert.match(doc, /rollback\.mjs/);
  assert.match(doc, /回滚：手动停用/);
  assert.match(doc, /中断/);
});

test('SC5 文档写清组织仓开关：确认前不加 autoRepos，加进去第一轮我在场', () => {
  assert.match(doc, /组织仓/);
  assert.match(doc, /autoRepos/);
  assert.match(doc, /第一轮/);
  assert.match(doc, /我在场/);
});

test('SC11/SC13 文档写清沙箱 fail-closed、遮罩名单从 profile 算、只传白名单环境变量', () => {
  assert.match(doc, /bwrap/);
  assert.match(doc, /fail-closed/);
  assert.match(doc, /PI_NO_SANDBOX/);
  assert.match(doc, /没有任何环境变量或配置项能关掉沙箱/);
  assert.match(doc, /从 profile 算/);
  assert.match(doc, /TokenFile/);
  assert.match(doc, /privateKeyFile/);
  assert.match(doc, /白名单环境变量/);
  assert.match(doc, /LLM_PROXY_API_KEY/);
  assert.match(doc, /sandbox-bin\/gh/);
});

test('SC7 三个 watcher：验收机 README、根 README、package.json 都写到三个，链接齐全', () => {
  const acceptance = read(path.join(HERE, 'README.md'));
  assert.match(acceptance, /三个 watcher/);
  assert.ok(acceptance.includes('../mivo/README.md'));
  assert.ok(acceptance.includes('../cindy/README.md'));
  assert.ok(acceptance.includes('SESSION.md'));
  assert.ok(acceptance.includes('../../docs/acceptance-scheduler.md'));
  assert.ok(acceptance.includes('../../docs/acceptance-session.md'));
  assert.ok(acceptance.includes('../../docs/acceptance-operations.md'));
  assert.match(acceptance, /host\/write-gate\.mjs/);

  const root = read(path.join(ROOT, 'README.md'));
  assert.match(root, /三个独立的/);
  assert.ok(root.includes('watchers/mivo/README.md'));
  assert.ok(root.includes('watchers/cindy/README.md'));
  assert.ok(root.includes('watchers/acceptance/README.md'));
  assert.ok(root.includes('docs/acceptance-operations.md'));

  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  assert.match(pkg.description, /三个独立的/);
  assert.match(pkg.description, /acceptance-watcher/);
});

test('SC13 正文版本只有一个实现：tasks 与 rounds 导出同一个函数，写闸从 rounds 导入且没有自己的哈希', () => {
  assert.equal(fromTasks, fromRounds, 'tasks 和 rounds 必须用同一个 bodyVersion');
  const gate = read(path.join(HOST, 'write-gate.mjs'));
  assert.match(gate, /import \{[^}]*bodyVersion[^}]*\} from '\.\.\/bin\/rounds\.mjs'/);
  assert.doesNotMatch(gate, /createHash/);
  assert.doesNotMatch(gate, /sha256/i);
  // 写闸里不能出现「不收 pr.merge」以外的合并动作白名单：它只能落在白名单外被拒。
  assert.equal(gate.includes('pr.merge'), false);
});

test('SC11/SC13 静态：host/ 里只有 proc.mjs 碰 child_process，没有动态 import 或拼字符串绕检查', () => {
  const files = listHostFiles();
  assert.ok(files.some((file) => path.basename(file) === 'proc.mjs'));
  for (const file of files) {
    const source = read(file);
    const name = path.relative(HOST, file);
    assert.doesNotMatch(source, /\bimport\(\s*[^'"]/, `${name} 里有拼字符串的动态 import`);
    assert.doesNotMatch(source, /\bimport\(/, `${name} 里有动态 import`);
    if (name === 'proc.mjs') {
      assert.match(source, /node:child_process/);
      continue;
    }
    assert.doesNotMatch(source, /node:child_process/, `${name} 直接 import child_process`);
    assert.doesNotMatch(source, /from 'child_process'/, `${name} 直接 import child_process`);
  }
});

test('SC8 静态：新增文件不含真实用户名、绝对家目录路径、主机名', () => {
  const banned = [
    ['Praise', 'Zhu'].join(''),
    ['/', 'home', '/'].join(''),
    ['/', 'Users', '/'].join(''),
    ['grok', '-bot-vm'].join(''),
    ['5081', '00218'].join(''),
  ];
  const files = [
    DOC,
    path.join(HERE, 'README.md'),
    path.join(HERE, 'bin', 'doctor.mjs'),
    path.join(HERE, 'gate.test.mjs'),
    path.join(HERE, 'sandbox.test.mjs'),
    path.join(HERE, 'loop.test.mjs'),
    path.join(HERE, 'host-round.test.mjs'),
    path.join(HERE, 'doctor.test.mjs'),
    path.join(HERE, 'host-doc.test.mjs'),
    ...listHostFiles(),
  ];
  for (const file of files) {
    const text = read(file);
    for (const word of banned) {
      assert.equal(text.includes(word), false, `${path.relative(ROOT, file)} 含敏感词 ${word}`);
    }
  }
});
