#!/usr/bin/env node
// 要修（#46 SC5）：按「总 issue + 验收项」复用或新开修正子 issue。
// 开之前先查：开着的就复用；独立 issue 已关就先重开；fork 档开在总 issue 的仓里、不走 subissue.add。
import { setAcceptanceFields } from './board.mjs';
import { collectTree } from './collect.mjs';
import { createRounds, parseRef } from './rounds.mjs';
import { redact } from './redact.mjs';

const ITEM_ARG = /^([\w.-]+\/[\w.-]+#\d+)\s*SC(\d+)$/;

export function parseItemArg(value) {
  const match = ITEM_ARG.exec(String(value || '').trim());
  if (!match) throw new Error(`--item 应为 "<owner/repo#n> SC<k>"，收到：${value}`);
  return { ref: match[1], sc: Number(match[2]) };
}

/** 修正子 issue 的模板；fork 档第一行链回原 issue。 */
export function correctionBody({ root, rootUrl, item, text, why, sc, round, fork }) {
  const lines = [];
  if (fork) {
    lines.push(`原 issue：${rootUrl}`);
    lines.push('');
  }
  lines.push(`> 修正子 issue · 总 issue ${root} · 原属 ${item}`);
  lines.push('## 没过的验收项');
  lines.push(text);
  lines.push('## 没过的原因');
  lines.push(why);
  lines.push('## 验收标准');
  lines.push(`- [ ] SC1 ${text}`);
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

  const body = correctionBody({
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
    title: titleFlag ? redact(titleFlag, profile) : `修正：${parsed.ref} SC${parsed.sc}`,
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
