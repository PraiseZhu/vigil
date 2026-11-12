import assert from 'node:assert/strict';
import test from 'node:test';
import { checkBodyEdit, check, toWrite } from './host/gate-actions/pr-edit.mjs';
import { correctionPrBody } from './host/prbot.mjs';
import { REPO } from './fake-gh.fixture.mjs';

// #171：写闸动作 pr.edit 只放行「验收对照」的状态 / 证据两列和「未执行的验证」段，其余正文一个字都不许变。

const state = {
  issue: `${REPO}#9`, prRepo: REPO, root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 2,
  correctionFacts: { scText: 'SC1 导出按钮在空列表时禁用。验证：unit', why: '空列表时仍可点击' },
  changedFiles: ['src/export.js'], preflight: { ok: true, commands: ['npm test'] },
};
const marker = { root: `${REPO}#1`, item: `${REPO}#2`, sc: 3, round: 1 };
const OLD = correctionPrBody(state, marker);
const rowIndex = () => OLD.split('\n').findIndex((line) => /^\|\s*SC1\b/.test(line));
const withRow = (status, evidence) => {
  const all = OLD.split('\n');
  const cells = all[rowIndex()].split('|');
  cells[2] = ` ${status} `;
  cells[3] = ` ${evidence} `;
  all[rowIndex()] = cells.join('|');
  return all.join('\n');
};
// 带实体、HTML、转义、不可见字符的写法先被「只许纯文本」拦下（encoded-text），其余由关单词比对拦下。
const REJECTED = new Set(['closing-keyword', 'encoded-text']);
const replaceSection = (body, title, text) => body.replace(new RegExp(`(## ${title}\\n\\n)[\\s\\S]*?(\\n\\n## )`), `$1${text}$2`);

test('#171 SC1 允许：验收对照的状态和证据列、未执行的验证段', () => {
  assert.equal(rowIndex() > 0, true, '夹具里有 SC1 那一行');
  const evidence = withRow('通过', 'CI test 通过：https://github.com/example-owner/example-repo/actions/runs/1');
  assert.deepEqual(checkBodyEdit(OLD, evidence), { ok: true });
  assert.deepEqual(checkBodyEdit(OLD, replaceSection(evidence, '未执行的验证', '- 无，CI 已跑完。')), { ok: true });
  assert.deepEqual(checkBodyEdit(OLD, OLD), { ok: true }, '不改也放行');
});

test('#171 SC1 拒绝：首行、Closes 行、修正标记行、其它段、标题', () => {
  const lines = OLD.split('\n');
  const swap = (index, text) => lines.map((line, at) => (at === index ? text : line)).join('\n');
  assert.equal(checkBodyEdit(OLD, swap(0, `任务 issue：${REPO}#5`)).reason, 'outside-editable', '首行');
  assert.equal(checkBodyEdit(OLD, swap(1, 'Closes #5')).reason, 'outside-editable', 'Closes 行');
  assert.equal(checkBodyEdit(OLD, swap(lines.length - 1, `[验收机] 修正 · 总 ${REPO}#5 · 项 ${REPO}#6 SC1 · 第 1 轮`)).reason, 'outside-editable', '修正标记行');
  assert.equal(checkBodyEdit(OLD, replaceSection(OLD, '改了什么', '换掉')).reason, 'outside-editable', '其它段');
  assert.equal(checkBodyEdit(OLD, OLD.replace('## 风险与回滚', '## 风险')).reason, 'outside-editable', '标题');
  assert.equal(checkBodyEdit(OLD, `${OLD}\n## 新加一段\n\n内容`).reason, 'outside-editable', '新加一段');
});

test('#171 SC1 拒绝：验收对照的行数、验收项列、非法状态', () => {
  const lines = OLD.split('\n');
  const extra = [...lines.slice(0, rowIndex() + 1), '| SC2 多出来的一条 | 通过 | x |', ...lines.slice(rowIndex() + 1)].join('\n');
  assert.equal(checkBodyEdit(OLD, extra).reason, 'table-shape');
  const renamed = lines.map((line, at) => (at === rowIndex() ? line.replace('SC1 导出按钮', 'SC1 别的按钮') : line)).join('\n');
  assert.equal(checkBodyEdit(OLD, renamed).reason, 'table-shape');
  assert.equal(checkBodyEdit(OLD, withRow('搞定', 'x')).reason, 'bad-status');
});

test('#171 SC1 拒绝：改动里新写关单词、修正标记、任务 issue 行（GitHub 认正文任意位置）', () => {
  for (const sneaky of ['Closes #1', 'fixes example-owner/example-repo#7', 'Resolves: https://github.com/example-owner/example-repo/issues/3']) {
    assert.equal(checkBodyEdit(OLD, withRow('通过', sneaky)).reason, 'closing-keyword', sneaky);
    assert.equal(checkBodyEdit(OLD, replaceSection(OLD, '未执行的验证', `- ${sneaky}`)).reason, 'closing-keyword', sneaky);
  }
  assert.equal(checkBodyEdit(OLD, replaceSection(OLD, '未执行的验证', `[验收机] 修正 · 总 ${REPO}#5 · 项 ${REPO}#6 SC1 · 第 1 轮`)).reason, 'correction-marker');
  assert.equal(checkBodyEdit(OLD, replaceSection(OLD, '未执行的验证', `任务 issue：${REPO}#5`)).reason, 'task-issue-line');
});

test('#171 SC2 参数：带标题、head、base 等字段一律拒绝；只给 auto / fork 档', () => {
  const ok = { type: 'pr.edit', repo: REPO, pr: 12, body: OLD };
  assert.deepEqual(check(ok, { tier: 'auto' }), { ok: true });
  assert.deepEqual(check(ok, { tier: 'fork' }), { ok: true });
  assert.equal(check(ok, { tier: 'watch' }).reason, 'tier-not-allowed');
  for (const key of ['title', 'head', 'base', 'branch', 'draft', 'state']) {
    assert.equal(check({ ...ok, [key]: 'x' }, { tier: 'auto' }).reason, 'field-not-editable', key);
  }
  assert.equal(check({ ...ok, body: '' }, { tier: 'auto' }).reason, 'bad-action');
  assert.equal(check({ ...ok, pr: 0 }, { tier: 'auto' }).reason, 'bad-action');
  assert.deepEqual(toWrite({ ...ok, dedupeKey: 'k' }), { type: 'pr.edit', repo: REPO, pr: 12, body: OLD });
});

// 审查 P2：按整篇正文比，两次 pr.edit 拼不出一次会被拒的内容；Markdown 包住、链接变体也认得出。
test('#171 两次改拼出跨行关单词：第二次被拒（按整篇最终正文比）', () => {
  const step1 = replaceSection(OLD, '未执行的验证', '- Closes');
  assert.deepEqual(checkBodyEdit(OLD, step1), { ok: true }, '只有关键字、没有引用，本身不关任何 issue');
  const step2 = replaceSection(OLD, '未执行的验证', '- Closes\n#999');
  assert.equal(checkBodyEdit(step1, step2).reason, 'closing-keyword');
  assert.equal(checkBodyEdit(OLD, step2).reason, 'closing-keyword', '一次写也拒');
});

test('#171 关单词的各种写法都拒：Markdown 包住、www、不带 https、尖括号、圆括号、全角冒号', () => {
  const variants = ['**Closes** #19', '`Closes` #19', '_Closes_ #19', 'Closes **#19**', '__Fixes__ example-owner/example-repo#19',
    'Fixes https://www.github.com/example-owner/example-repo/issues/19', 'Fixes github.com/example-owner/example-repo/issues/19',
    'Closes <https://github.com/example-owner/example-repo/issues/19>', 'Closes (https://github.com/example-owner/example-repo/pull/19)',
    'Closes：#19', 'Clo​ses #19'.replace('​', ''), 'resolved #12'];
  // 正文第二行本来就有「Closes #9」（关修正子 issue 自己），所以这里用别的号。
  for (const text of variants) {
    assert.equal(checkBodyEdit(OLD, withRow('通过', text)).reason, 'closing-keyword', text);
  }
  assert.deepEqual(checkBodyEdit(OLD, withRow('通过', 'fixtures 目录的测试通过；修复见 fix/export 分支')), { ok: true }, '没有引用的「fix」不算');
});

test('#171 修正标记和任务 issue 行拆成两行、两次写也拒', () => {
  const split = replaceSection(OLD, '未执行的验证', `[验收机]\n修正 · 总 ${REPO}#5 · 项 ${REPO}#6 SC1 · 第 1 轮`);
  assert.equal(checkBodyEdit(OLD, split).reason, 'correction-marker');
  const half = replaceSection(OLD, '未执行的验证', '- 任务');
  assert.deepEqual(checkBodyEdit(OLD, half), { ok: true });
  assert.equal(checkBodyEdit(half, replaceSection(OLD, '未执行的验证', `- 任务\nissue：${REPO}#5`)).reason, 'task-issue-line');
});

// 复审 P1 / P2 与待核实：GH-号、下划线仓名不能被「抹平」成同一个、实体 / 全角 / HTML 标签 / 链接文字 / 不可见字符。
test('#171 GH-号写法也拒（GitHub 认 closes gh-N）', () => {
  for (const text of ['Closes GH-19', 'fixes gh-19', 'Resolves: GH-19']) {
    assert.equal(checkBodyEdit(OLD, withRow('通过', text)).reason, 'closing-keyword', text);
  }
});

test('#171 带下划线的跨仓 Closes 行不会被「去下划线同名仓」冒充', () => {
  const crossOld = OLD.replace('Closes #9', 'Closes Other_Org/other_repo#9');
  assert.notEqual(crossOld, OLD, '夹具换成跨仓 Closes 行');
  const fake = crossOld.split('\n').map((line) => {
    if (!/^\|\s*SC1\b/.test(line)) return line;
    const cells = line.split('|');
    cells[2] = ' 通过 ';
    cells[3] = ' Closes OtherOrg/otherrepo#9 ';
    return cells.join('|');
  }).join('\n');
  assert.equal(checkBodyEdit(crossOld, fake).reason, 'closing-keyword');
  assert.deepEqual(checkBodyEdit(OLD, withRow('通过', '见 my_org/my_repo 的 fix_up 分支，无关单词')), { ok: true }, '仓名里的下划线照常');
});

test('#171 实体、全角、HTML 标签、链接文字、不可见字符包装的关单词都拒', () => {
  const variants = ['Closes &#35;19', 'Closes &#035;19', 'Closes &#x23;19', 'Closes &num;19', 'Closes ＃19', 'Closes #１９',
    '<b>Closes</b> #19', '<strong>Fixes</strong> #19', '[Closes](https://github.com/example-owner/example-repo/issues/19)',
    'Closes⁠#19', 'Closes­ #19', 'Clo​ses #19'];
  for (const text of variants) {
    assert.ok(REJECTED.has(checkBodyEdit(OLD, withRow('通过', text)).reason), JSON.stringify(text));
  }
  assert.deepEqual(checkBodyEdit(OLD, withRow('通过', 'CI 见 <https://github.com/example-owner/example-repo/actions/runs/1>')), { ok: true });
});

// 第三轮复审：仓名首尾、连续下划线也不能被抹平；未列出的标签、注释、别的实体、别的不可见字符、非 ASCII 连字符也认得出。
test('#171 仓名首尾和连续下划线的跨仓 Closes 行不会被冒充', () => {
  for (const [real, fake] of [['ExampleOrg/_repo#9', 'ExampleOrg/repo#9'], ['ExampleOrg/repo_#9', 'ExampleOrg/repo#9'], ['ExampleOrg/my__repo#9', 'ExampleOrg/myrepo#9']]) {
    const crossOld = OLD.replace('Closes #9', `Closes ${real}`);
    const forged = crossOld.split('\n').map((line) => {
      if (!/^\|\s*SC1\b/.test(line)) return line;
      const cells = line.split('|');
      cells[2] = ' 通过 ';
      cells[3] = ` Closes ${fake} `;
      return cells.join('|');
    }).join('\n');
    assert.equal(checkBodyEdit(crossOld, forged).reason, 'closing-keyword', `${real} -> ${fake}`);
  }
  assert.equal(checkBodyEdit(OLD, withRow('通过', '__Fixes__ #19')).reason, 'closing-keyword', '强调下划线仍认得出');
  assert.equal(checkBodyEdit(OLD, withRow('通过', '_Closes_ _#19_')).reason, 'closing-keyword');
});

test('#171 任意 HTML 标签、注释、其它实体、更多不可见字符、非 ASCII 连字符包装都拒', () => {
  const variants = ['Closes<div></div>#19', '<font>Closes</font> #19', '<p>Closes</p> #19', '<details>Closes</details> #19',
    'Closes<!--x-->#19', 'Clo<!--x-->ses #19', 'GH&#x2D;19 Closes GH-19', 'Fixes &#71;&#72;-19', '&#67;loses #19', 'Closes &#x2​3;19',
    'Closes️#19', 'Closes‪#19', 'Closes⁦#19', 'Closes͏#19', 'Closes؜#19', 'Closes GH‑19'];
  for (const text of variants) {
    assert.ok(REJECTED.has(checkBodyEdit(OLD, withRow('通过', text)).reason), JSON.stringify(text));
  }
  for (const fine of ['_repo 目录测试通过', '见 my_org/my_repo', '[CI](https://github.com/example-owner/example-repo/actions/runs/1)']) {
    assert.deepEqual(checkBodyEdit(OLD, withRow('通过', fine)), { ok: true }, fine);
  }
});

// 第四轮复审 P1：藏在注释、标签名、属性里的关单词不能因为「去标签」被一起删掉；实体被注释或标签拆开也认得出。
test('#171 注释、标签名、属性里的关单词也拒（原始正文里它还在）', () => {
  const variants = ['<!-- Closes #19 -->', '<!-- Closes #19', '<Closes #19>', '<Fixes #19>', '<Closes https://github.com/ExampleOrg/repo-a/issues/19>',
    '<div Closes #19>', '<img alt="Closes #19">', '<span title="Closes #19">x</span>', '&#60;Closes #19>', '<Closes #19&#62;', '&#60;Closes #19&#62;',
    '<!-- &#67;loses #19 -->', 'Closes &#x2<!--x-->3;19', 'Closes &#x2<b></b>3;19', `Closes\u{E0100}#19`];
  for (const text of variants) {
    assert.ok(REJECTED.has(checkBodyEdit(OLD, withRow('通过', text)).reason), JSON.stringify(text));
  }
});

test('#171 修正标记、任务 issue 行被标签拆开或藏进注释也拒', () => {
  for (const text of ['[验收机]<b></b>修正', '<!-- [验收机]修正 -->', '任务<i></i> issue：x']) {
    assert.equal(checkBodyEdit(OLD, withRow('通过', text)).reason, 'encoded-text', text);
  }
});

// 第五轮复审：按读法逐份比。新正文在某种读法下认出的引用，旧正文在同一读法下必须已有；
// 旧正文里只在某种读法下才有的引用，不能替新写的真关单词打掩护。
const rowIn = (body, status, evidence) => body.split('\n').map((line) => {
  if (!/^\|\s*SC1\b/.test(line)) return line;
  const cells = line.split('|');
  cells[2] = ` ${status} `;
  cells[3] = ` ${evidence} `;
  return cells.join('|');
}).join('\n');

test('#171 实体拆开的号按原文认是另一个 issue：拒', () => {
  const before = rowIn(OLD, '待验证', 'Closes #19');
  assert.equal(checkBodyEdit(before, rowIn(OLD, '通过', 'Closes #1&#57;')).reason, 'encoded-text', '按原文认是 #1');
});

test('#171 旧正文只在某种读法下才有的引用，不替新写的真关单词打掩护', () => {
  for (const hidden of ['<!-- Closes #19 -->', '<Closes #19>', '<div title="Closes #19">x</div>', 'Closes &#35;19', 'Closes #1&#57;']) {
    const before = rowIn(OLD, '待验证', hidden);
    // 证据格原样留着旧的隐藏写法，新的真关单词写在「未执行的验证」段：纯文本层放行，靠逐份比拦下。
    assert.equal(checkBodyEdit(before, replaceSection(before, '未执行的验证', '- Closes #19')).reason, 'closing-keyword', JSON.stringify(hidden));
  }
});

test('#171 旧正文原样留着的隐藏引用不误拒：只改状态和证据仍放行', () => {
  const before = replaceSection(OLD, '未执行的验证', '<!-- Closes #19 --> Closes &#35;19 Closes #1&#57; 无');
  assert.deepEqual(checkBodyEdit(before, rowIn(before, '通过', 'CI test 通过')), { ok: true });
  const hiddenInRow = rowIn(OLD, '待验证', '<Closes #19>');
  assert.deepEqual(checkBodyEdit(hiddenInRow, rowIn(OLD, '通过', '<Closes #19>')), { ok: true }, '只改状态、证据格原样');
});

// 第六轮复审 P1：命名实体（&Tab; &nbsp; &sol; …）、不带分号的实体、双重实体、反斜杠转义，换一种读法就会变成关单词；
// 读法补不完，所以改动的证据格和「未执行的验证」段只许写纯文本。
test('#171 改动的证据格和「未执行的验证」段只许纯文本：实体、HTML、转义、不可见字符一律拒', () => {
  const encoded = ['Closes&Tab;#19', 'Closes&NewLine;#19', 'Closes&nbsp;#19', 'Closes&nbsp#19', 'Closes&colon;#19', 'Closes&lpar;#19',
    'Closes ExampleOrg&sol;repo-a&num;19', 'Closes &amp;#35;19', 'Closes \\#19', 'Closes\\:#19', '<font>CI 通过</font>', '<b>加粗</b>',
    'Closes\u200b#19', '见 https://example.com/x?a=1&b=2'];
  for (const text of encoded) {
    assert.equal(checkBodyEdit(OLD, withRow('通过', text)).reason, 'encoded-text', JSON.stringify(text));
    assert.equal(checkBodyEdit(OLD, replaceSection(OLD, '未执行的验证', `- ${text}`)).reason, 'encoded-text', JSON.stringify(text));
  }
  for (const fine of ['CI 见 <https://github.com/example-owner/example-repo/actions/runs/1>', '`npm ci && npm test 2>&1` 通过', 'A & B 都过了',
    '`a \\| b` 通过', 'x < 3 且 y > 1', '[CI](https://github.com/example-owner/example-repo/actions/runs/1)']) {
    assert.deepEqual(checkBodyEdit(OLD, withRow('通过', fine)), { ok: true }, fine);
  }
});

test('#171 只许纯文本只看改动的地方：旧正文原样留着的写法不拦', () => {
  const before = replaceSection(OLD, '未执行的验证', '- 旧说明 <!-- x --> &nbsp;');
  assert.deepEqual(checkBodyEdit(before, rowIn(before, '通过', 'CI 通过')), { ok: true }, '段没改');
  const oddCell = rowIn(OLD, '待验证', 'a&nbsp;b');
  assert.deepEqual(checkBodyEdit(oddCell, rowIn(OLD, '通过', 'a&nbsp;b')), { ok: true }, '证据格没改、只改状态');
  assert.equal(checkBodyEdit(oddCell, rowIn(OLD, '通过', 'a&nbsp;b CI 通过')).reason, 'encoded-text', '证据格改了就整格检查');
});
