#!/usr/bin/env node
// 要修（#46 SC5）：按「总 issue + 验收项」复用或新开修正子 issue。
// 开之前先查：开着的就复用；独立 issue 已关就先重开；fork 档开在总 issue 的仓里、不走 subissue.add。
import { setAcceptanceFields } from './board.mjs';
import { collectTree, fetchIssueBody, parseLayer, parseTestPoint } from './collect.mjs';
import { createRounds, parseRef } from './rounds.mjs';
import { redact } from './redact.mjs';
import { assertNotVerdictOnly } from './profile.mjs';

const ITEM_ARG = /^([\w.-]+\/[\w.-]+#\d+)\s*SC(\d+)$/;

export function parseItemArg(value) {
  const match = ITEM_ARG.exec(String(value || '').trim());
  if (!match) throw new Error(`--item 应为 "<owner/repo#n> SC<k>"，收到：${value}`);
  return { ref: match[1], sc: Number(match[2]) };
}

/** 修正子 issue 的标签（本机子 issue 模板）。写闸 issue.create 原样透传 labels。 */
export const CORRECTION_LABELS = Object.freeze(['子issue']);

/** 修正子 issue 标题：`[子N/M] 一句话`。N = 总 issue 下现有子 issue 数 + 1，M = N（开出时它是最后一个）。 */
export function correctionTitle({ index, title }) {
  const text = String(title || '').trim().replace(/^\[子\d+\/\d+\]\s*/, '');
  return `[子${index}/${index}] ${text}`;
}

/** 原属 issue「## 范围」段里带反引号路径 / glob 的行，照抄成修正子 issue 的范围行。 */
export function scopeLinesOf(body) {
  const lines = String(body ?? '').split('\n');
  const start = lines.findIndex((line) => /^##\s*范围/.test(line));
  if (start === -1) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (/^\s*[-*]\s*`[^`]+`/.test(line)) out.push(line.trim().replace(/^\*/, '-'));
  }
  return out;
}

/** SC1 行：保留原文，补齐「验证：<层>（测试点：…）」。原文已有层和测试点就原样用。 */
export function correctionScLine({ item, sc, text }) {
  const raw = String(text ?? '').trim();
  const layer = parseLayer(raw);
  const testPoint = parseTestPoint(raw);
  if (layer !== '未标层次' && testPoint) return `- [ ] SC1 ${raw}`;
  const at = layer === '未标层次' ? -1 : raw.indexOf(`验证：${layer}`);
  const base = (at === -1 ? raw : raw.slice(0, at)).replace(/[\s。；;，,]+$/, '');
  const point = testPoint || `${item} SC${sc} 的原验收入口`;
  // 原项没标层次：写 static 占位（模板要求有层），验收机仍按原验收项的写法去验。
  return `- [ ] SC1 ${base}。验证：${layer === '未标层次' ? 'static' : layer}（测试点：${point}）`;
}

/**
 * 修正子 issue 的模板（task-issue/v1 子 issue 格式：目标 / 原因 / 范围 / 不做 / 参考 / 依赖 / 待定问题 / 验收标准）；fork 档第一行链回原 issue。
 * 正文里只能有一行 `- [ ] SC1`：collect 的 parseItems 会把任何 SC 行都当成验收项（本机模板的例外，见 docs/acceptance-prbot.md）。
 */
export function correctionBody({ root, rootUrl, item, text, why, sc, round, fork, scopeLines = [], verdictUrl }) {
  const lines = [];
  if (fork) {
    lines.push(`原 issue：${rootUrl}`);
    lines.push('');
  }
  lines.push(`> 修正子 issue · 总 issue ${root} · 原属 ${item} SC${sc} · 对应 1 个修正 PR（prbot 开，指向 main）`);
  lines.push('');
  lines.push('## 目标');
  lines.push('');
  lines.push(`让验收没过的 ${item} SC${sc} 重新验收通过：${text}`);
  lines.push('');
  lines.push('## 原因');
  lines.push('');
  lines.push(why);
  lines.push('');
  lines.push('## 范围（可改）');
  lines.push('');
  if (scopeLines.length) {
    lines.push(...scopeLines);
  } else {
    lines.push(`- \`**\`：修好 ${item} SC${sc} 所需的最小代码改动和复现测试，限原属 issue 的范围内（目标仓禁改路径照旧不碰）`);
  }
  lines.push('');
  lines.push('## 不做');
  lines.push('');
  lines.push(`- 不改 ${item} 的其它验收项，不扩大原属 issue 的范围`);
  lines.push('');
  lines.push('## 参考');
  lines.push('');
  lines.push(`- ${item} SC${sc}：原验收项原文和范围`);
  if (verdictUrl) lines.push(`- 验收裁决：${verdictUrl}`);
  lines.push('');
  lines.push('## 依赖');
  lines.push('');
  lines.push('无，随时可开工。');
  lines.push('');
  lines.push('## 待定问题');
  lines.push('');
  lines.push('无');
  lines.push('');
  lines.push('## 验收标准');
  lines.push('');
  lines.push(correctionScLine({ item, sc, text }));
  lines.push('');
  lines.push(`[验收机] 修正 · 总 ${root} · 项 ${item} SC${sc} · 第 ${round} 轮`);
  return lines.join('\n');
}

function findOriginalItem(tree, itemRef, sc) {
  for (const issue of tree.issues) {
    for (const item of issue.items) {
      if (item.source === itemRef && item.sc === sc) return item;
    }
  }
  return null;
}

export async function runCorrect({ github, profile, ref, n, flags, now = () => Date.now(), stdout }) {
  const rounds = createRounds({ github, profile, now });
  const current = await rounds.check(ref, n);
  const tree = await collectTree({ github, profile, ref });
  if (tree.root.tier === 'watch') throw new Error('watch 档只出裁决、写看板');
  if (!tree.root.tier) throw new Error(`${tree.root.ref} 不在任何名单里`);
  assertNotVerdictOnly(profile, tree.root.ref, 'correct');

  const parsed = parseItemArg(flags.get('item'));
  const why = String(flags.get('why') || '').trim();
  if (!why) throw new Error('correct 需要 --why <没过的原因>');
  const titleFlag = flags.get('title');
  const original = findOriginalItem(tree, parsed.ref, parsed.sc);
  if (!original) throw new Error(`收集结果里找不到验收项 ${parsed.ref} SC${parsed.sc}`);

  const existing = tree.corrections.find(
    (entry) =>
      entry.marker &&
      entry.marker.root === tree.root.ref &&
      entry.marker.item === parsed.ref &&
      entry.marker.sc === parsed.sc &&
      entry.state === 'open',
  );

  const root = parseRef(tree.root.ref);
  const itemRepo = parseRef(parsed.ref).repo;
  const fork = Boolean(tree.root.fork);
  const verdictUrl = current.url;

  if (existing) {
    // 复用的修正子 issue 可能是搜索找到、还没挂上的（上一轮在 issue.create 之后、subissue.add 之前中断）：
    // 非 fork 档补挂到总 issue 下，否则它一直是孤儿，总 issue 的任务树里看不到它。
    const attached = tree.issues.some((entry) => entry.ref.toLowerCase() === existing.ref.toLowerCase());
    if (!fork && !attached) {
      const sub = parseRef(existing.ref);
      await github.write({
        type: 'subissue.add',
        dedupeKey: `correct-sub:${tree.root.ref}:${parsed.ref}:SC${parsed.sc}:${n}`,
        repo: root.repo,
        issue: root.number,
        subRepo: sub.repo,
        subIssue: sub.number,
      });
    }
    await setAcceptanceFields(github, profile, {
      repo: root.repo,
      issue: root.number,
      acceptance: '要修',
      verdictUrl,
      round: n,
      ref: tree.root.ref,
    });
    stdout.write(`${JSON.stringify({ reused: true, ref: existing.ref, url: existing.url })}\n`);
    return 0;
  }

  const createRepo = fork ? root.repo : itemRepo;
  if (tree.root.kind === 'standalone' && tree.root.state === 'closed') {
    await github.write({
      type: 'issue.reopen',
      dedupeKey: `reopen:${tree.root.ref}:${n}`,
      repo: root.repo,
      issue: root.number,
    });
  }

  // 范围行照抄原属 issue 带反引号路径的行；读不到就用兜底的 glob 行。
  let scopeLines = [];
  try {
    scopeLines = scopeLinesOf((await fetchIssueBody(github, parsed.ref)).body);
  } catch {
    scopeLines = [];
  }
  const body = correctionBody({
    scopeLines,
    verdictUrl,
    root: tree.root.ref,
    rootUrl: tree.root.url,
    item: parsed.ref,
    text: original.text,
    why: redact(why, profile),
    sc: parsed.sc,
    round: n,
    fork,
  });
  const created = await github.write({
    type: 'issue.create',
    dedupeKey: `correct:${tree.root.ref}:${parsed.ref}:SC${parsed.sc}:${n}`,
    repo: createRepo,
    title: correctionTitle({
      index: tree.issues.length,
      title: titleFlag ? redact(titleFlag, profile) : `修正：${parsed.ref} SC${parsed.sc}`,
    }),
    labels: [...CORRECTION_LABELS],
    body,
  });
  const correctionRef = `${createRepo}#${created.issue}`;
  if (!fork) {
    await github.write({
      type: 'subissue.add',
      dedupeKey: `correct-sub:${tree.root.ref}:${parsed.ref}:SC${parsed.sc}:${n}`,
      repo: root.repo,
      issue: root.number,
      subRepo: createRepo,
      subIssue: created.issue,
    });
  }

  await setAcceptanceFields(github, profile, {
    repo: root.repo,
    issue: root.number,
    acceptance: '要修',
    verdictUrl,
    round: n,
    ref: tree.root.ref,
  });
  await setAcceptanceFields(github, profile, {
    repo: createRepo,
    issue: created.issue,
    acceptance: '要修',
    verdictUrl,
    round: n,
    ref: correctionRef,
  });

  stdout.write(`${JSON.stringify({ reused: false, ref: correctionRef, url: created.url })}\n`);
  return 0;
}
