import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SESSION = path.join(HERE, 'SESSION.md');
const DOC = path.resolve(HERE, '..', '..', 'docs', 'acceptance-session.md');
const BIN = path.join(HERE, 'bin');
const ROOT = path.resolve(HERE, '..', '..');

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

const session = read(SESSION);
const doc = read(DOC);

test('SC1/SC4/SC5 SESSION.md 说清 helper 的每条命令', () => {
  for (const command of ['collect', 'progress', 'verdict', 'close', 'correct', 'push', 'board', 'done']) {
    assert.match(session, new RegExp(`helper\\.mjs ${command}\\b`), `SESSION.md 没写 ${command}`);
  }
  assert.match(session, /--issue/);
  assert.match(session, /--round/);
});

test('SC2 SESSION.md 写清验法：检出、清理、逐层跑、证据、人工手测、提炼标准、目标仓规矩', () => {
  assert.match(session, /检出各仓最新 main/);
  assert.match(session, /代码已由宿主检出/);
  assert.match(session, /\*\*只读\*\*/);
  assert.match(session, /复制到 `TMPDIR`/);
  assert.match(session, /不要\*\*自己 `git clone`/);
  assert.match(session, /用完清理/);
  assert.match(session, /static/);
  assert.match(session, /unit/);
  assert.match(session, /contract/);
  assert.match(session, /browser-fixture/);
  assert.match(session, /逐条跑/);
  assert.match(session, /留下证据/);
  assert.match(session, /cindy-mac/);
  assert.match(session, /cindy-windows/);
  assert.match(session, /paid/);
  assert.match(session, /github-live/);
  assert.match(session, /「人工手测」/);
  assert.match(session, /不拦关闭/);
  assert.match(session, /只算声称/);
  assert.match(session, /没写验收标准的/);
  assert.match(session, /提炼标准/);
  assert.match(session, /extracted: true/);
  assert.match(session, /AGENTS\.md/);
  assert.match(session, /PR 模板/);
  assert.match(session, /合并门禁/);
});

test('SC6 SESSION.md 写清修正 PR 的全部规则', () => {
  assert.match(session, /修正轮/);
  assert.match(session, /prbot/);
  assert.match(session, /写操作出口/);
  assert.match(session, /先按修正标记找已有的修正 PR/);
  assert.match(session, /从最新 main 开分支、指向 main/);
  assert.match(session, /acceptance\/<总 issue 号>-<出处 issue 号>-sc<k>/);
  // <root> 是总 issue、<item> 是出处 issue：修正 PR 第一行链总 issue，不写 Closes 总 issue。
  assert.match(session, /「任务 issue：<root>」/);
  assert.doesNotMatch(session, /「Closes <ref>」|「Closes <root>」/);
  assert.doesNotMatch(session, /<ref>/, 'SESSION.md 不再用含糊的 <ref>');
  assert.match(session, /先开 Draft/);
  assert.match(session, /CI 全绿后由 prbot 自己转 Ready/);
  assert.match(session, /Mivo 也一样/);
  assert.match(session, /不设审查机进场门禁/);
  assert.match(session, /转 Ready 就是交接/);
  assert.match(session, /makecindy\/cindy/);
  assert.match(session, /从 fork 提/);
  assert.match(session, /打开 PR/);
  assert.match(session, /修正中/);
  assert.match(session, /转 Ready 后不再推送、不回评论/);
  assert.match(session, /都不合并、不 Approve/);
});

test('SC8 SESSION.md 写清有争议：不自己定案、只读裁决运行、模型和推理档', () => {
  assert.match(session, /有争议/);
  assert.match(session, /不要自己定案/);
  assert.match(session, /只读/);
  assert.match(session, /anthropic\/claude-opus-5-5/);
  assert.match(session, /medium/);
  assert.match(session, /\[修正机\] 第 n 轮/);
  assert.match(session, /结论写进下一轮裁决/);
});

test('SC7/SC10/SC11 SESSION.md 写清扫描、进度、done、脱敏和退出码', () => {
  assert.match(session, /先扫要推的改动/);
  assert.match(session, /gitleaks/);
  assert.match(session, /退出码 `5`/);
  assert.match(session, /reason=secret-found/);
  assert.match(session, /需人工处理/);
  assert.match(session, /绝不写密钥内容/);
  assert.match(session, /每做完一步写一次进度/);
  assert.match(session, /最后一步必须是/);
  assert.match(session, /\[验收机\]/);
  assert.match(session, /不写.*云端路径、令牌、运行 id、密钥内容/s);
  // 顺序：verdict 是最后一个写操作。
  assert.match(session, /必须在 `verdict` 之前做完/);
  assert.match(session, /之后所有写命令都会被认领检查拒绝/);
  // 退出码表 0/1/3/4/5。
  for (const code of ['`0`', '`1`', '`3`', '`4`', '`5`']) {
    assert.ok(session.includes(code), `SESSION.md 少了退出码 ${code}`);
  }
  // watch 档只出裁决、写看板。
  assert.match(session, /watch 档只出裁决、写看板/);
});

test('SESSION.md 区分总 issue 与出处 issue、写清 verdict.json 结构和覆盖率、验收轮不推送、只出裁决', () => {
  assert.match(session, /`<root>`：\*\*总 issue\*\*/);
  assert.match(session, /`<item>`：某条验收项的\*\*出处 issue\*\*/);
  assert.match(session, /--item "<item> SC<k>"/);
  assert.match(session, /### 裁决文件 verdict\.json/);
  assert.match(session, /"result": "通过"/);
  assert.match(session, /每条 SC 都要有一条结论/);
  assert.match(session, /`items` 为空也拒绝/);
  assert.match(session, /验收轮不改代码、不推送、不开 PR/);
  assert.match(session, /这一轮不要调 `helper\.mjs push`/);
  assert.match(session, /verdictOnly/);
  assert.match(session, /最后一步只写裁决/);
  assert.match(session, /本 issue 由人工复核后关闭/);
  assert.match(session, /勾选 → 看板/);
  assert.match(session, /reason=verdict-only/);
});

test('SC2/SC6 SESSION.md 只依赖命令行，不提非命令行工具', () => {
  assert.match(session, /node/);
  assert.match(session, /gh/);
  assert.match(session, /git/);
  for (const banned of ['Claude Code', 'Cindy 工具', 'Cindy 的', 'mcp__', 'WebFetch', 'TodoWrite', 'Bash 工具', 'Read 工具', 'Edit 工具', 'Grep 工具']) {
    assert.equal(session.includes(banned), false, `SESSION.md 提到了非命令行工具：${banned}`);
  }
});

test('docs/acceptance-session.md 写清裁决格式、有争议行、修正标记、退出码、顺序、脱敏', () => {
  assert.match(doc, /\[验收机\] 第 n 轮：通过\|要修/);
  assert.match(doc, /正文版本：/);
  assert.match(doc, /## 逐条结果/);
  assert.match(doc, /- 通过：owner\/repo#12 SC3 · 证据：/);
  assert.match(doc, /- 要修：owner\/repo#12 SC4 · 原因：/);
  assert.match(doc, /- 人工手测：owner\/repo#12 SC5（cindy-mac）/);
  assert.match(doc, /- 有争议：<owner\/repo#n> SC<k> · 验收方：… · 修正方：…/);
  assert.match(doc, /## 需人工处理/);
  assert.match(doc, /\[验收机\] 修正 · 总 <owner\/repo#n> · 项 <owner\/repo#n> SC<k> · 第 n 轮/);
  assert.match(doc, /有就复用/);
  assert.match(doc, /原 issue：/);
  assert.match(doc, /subissue\.add/);
  assert.match(doc, /先 `issue\.reopen` 重开/);
  assert.match(doc, /acceptance\/<总>-<出处>-sc<k>/);
  assert.match(doc, /localgit\.mjs/);
  assert.match(doc, /redact\(text, profile\)/);
  assert.match(doc, /verdict` \*\*之前\*\*做完/);
  for (const code of ['`0`', '`1`', '`3`', '`4`', '`5`']) {
    assert.ok(doc.includes(code), `docs 少了退出码 ${code}`);
  }
});

test('SC12 静态：新文件不含真实用户名、绝对家目录路径；只有 github.mjs 和 localgit.mjs 用 child_process', () => {
  const bannedUser = ['Praise', 'Zhu'].join('');
  const homePath = ['/', 'home', '/'].join('');
  const usersPath = ['/', 'Users', '/'].join('');
  const childProcess = ['node:', 'child_process'].join('');
  const files = [
    path.join(BIN, 'helper.mjs'),
    path.join(BIN, 'collect.mjs'),
    path.join(BIN, 'verdict.mjs'),
    path.join(BIN, 'correct.mjs'),
    path.join(BIN, 'close.mjs'),
    path.join(BIN, 'push.mjs'),
    path.join(BIN, 'localgit.mjs'),
    path.join(BIN, 'redact.mjs'),
    SESSION,
    DOC,
    path.join(HERE, 'session.fixture.mjs'),
    path.join(HERE, 'helper.test.mjs'),
    path.join(HERE, 'collect.test.mjs'),
    path.join(HERE, 'verdict.test.mjs'),
    path.join(HERE, 'correct.test.mjs'),
    path.join(HERE, 'push.test.mjs'),
    path.join(HERE, 'session-doc.test.mjs'),
  ];
  for (const file of files) {
    const text = read(file);
    assert.equal(text.includes(bannedUser), false, `${path.relative(ROOT, file)} 含真实用户名`);
    assert.equal(text.includes(homePath), false, `${path.relative(ROOT, file)} 含绝对家目录路径`);
    assert.equal(text.includes(usersPath), false, `${path.relative(ROOT, file)} 含绝对家目录路径`);
    if (path.basename(file) !== 'localgit.mjs') {
      assert.equal(text.includes(childProcess), false, `${path.relative(ROOT, file)} 直接 import child_process`);
    }
  }

  // 起子进程的只有 github.mjs（触网）和 localgit.mjs（只跑本地 git/gitleaks），其它文件一律不碰。
  for (const name of fs.readdirSync(BIN).filter((entry) => entry.endsWith('.mjs'))) {
    if (name === 'github.mjs' || name === 'localgit.mjs') continue;
    const text = read(path.join(BIN, name));
    // 不带 node: 前缀的 import、require 也算：任何位置出现 child_process 都拒绝。
    assert.doesNotMatch(text, /child_process/, `${name} 引用 child_process`);
    assert.doesNotMatch(text, /spawn\(|execFile|import\(|require\(/, `${name} 起子进程、动态 import 或 require`);
  }
  // localgit.mjs 是静态 import，不用动态 import 或拼字符串绕开检查。
  const localgit = read(path.join(BIN, 'localgit.mjs'));
  assert.match(localgit, new RegExp(`^import \\{ spawn \\} from '${childProcess}';$`, 'm'));
  assert.doesNotMatch(localgit, /import\(/);
});

test('#46 SC8 SESSION.md 写清有裁决结果时怎么做：成立 = 要修，不成立 = 通过并引用裁决，不再标有争议', () => {
  assert.match(session, /### 有裁决结果时/);
  assert.match(session, /`成立`：验收方对，这一条\*\*要修\*\*/);
  assert.match(session, /`不成立`：修正方对，这一条\*\*通过\*\*/);
  assert.match(session, /证据里引用裁决/);
  assert.match(session, /不要\*\*再写「有争议」行/);
});

test('#46 SC8 docs/acceptance-session.md 写清裁决运行已实现：触发、只读、结果位置、下一轮、配置', () => {
  const doc = fs.readFileSync(path.join(HERE, '..', '..', 'docs', 'acceptance-session.md'), 'utf8');
  assert.match(doc, /### 裁决运行（已实现，`host\/adjudicate\.mjs`）/);
  assert.match(doc, /awaiting-adjudication/);
  assert.match(doc, /state\/host\/adjudications/);
  assert.match(doc, /adjudicateCommand/);
  assert.match(doc, /adjudicateMaxMinutes/);
  assert.match(doc, /adjudicate-needs-human/);
});

test('SESSION.md：close 要带 --verdict（写任何东西之前先查「通过」证据），引用要加引号', () => {
  assert.match(session, /helper\.mjs close +--issue <root> --round <n> --verified <verified\.json> --verdict <verdict\.json>/);
  assert.match(session, /写任何东西之前先查里面「通过」条目的证据/);
  assert.match(session, /引号里的内容不算你自己说的「没跑」/);
  assert.match(doc, /close --verified <verified\.json> --verdict <verdict\.json>/);
});

test('#140 SC5 SESSION.md 写清批准执行的交接：只当线索、每条 SC 照样自己验、重点项逐条写进 handoffChecks、lead 验收 head 之后的提交重点查', () => {
  assert.match(session, /### 批准执行的交接/);
  assert.match(session, /交接\*\*只当线索，不算证据\*\*/);
  assert.match(session, /每条 SC 照样自己验/);
  assert.match(session, /`handoffChecks`/);
  assert.match(session, /lead 验收时的 head 之后新增的提交要重点查/);
  assert.match(session, /等满 24 小时后照常验收/);
  assert.match(doc, /awaiting-lead-handoff/);
  assert.match(doc, /\[批准执行\] 交接验收 · 第 n 次/);
  assert.match(doc, /## 交接重点核对/);
});
