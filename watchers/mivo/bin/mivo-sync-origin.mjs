// Sync routing is independent of the feedback's severity. Bodies never grant authority.
const SHA = /^[a-f0-9]{40}$/i;
export function isSyncPr(pr = {}) {
  if (/^integration\//.test(pr.baseRefName ?? '') && /^sync\//.test(pr.headRefName ?? '')) return true;
  const text = `${pr.title ?? ''}\n${pr.body ?? ''}`;
  // Text is weaker evidence than the branch pair. Reject negation or uncertainty
  // anywhere in it, including words between a negation and the sync verb.
  if (/(?:[不没未]|无[需须]|禁止|避免|[勿别]|是否|能否|可能|如果|假如|[?？]|\b(?:no|not|cannot|[a-z]+n['’]t|never|without|avoid|if|unless|whether|maybe)\b)/i.test(text)) return false;
  return /(?:同步\s*`?main`?\s*(?:进|到|至|入)|(?:把|将)\s*(?:最新(?:的)?\s*)?`?main`?\s*(?:同步|合并)(?:进|到|至|入)|(?:merge|sync)\s+`?main`?\s+(?:into|to)\s+\S+)/i.test(text);
}

// Map an unchanged HEAD interval back to main. Changed lines and deletions inside the
// interval are deliberately not evidence of inherited code. Line shifts elsewhere are OK.
export function mapUnchangedRange(diff, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  let offset = 0;
  for (const match of String(diff).matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(match[1]), oldCount = Number(match[2] ?? 1);
    const newStart = Number(match[3]), newCount = Number(match[4] ?? 1);
    if (newCount === 0 ? newStart >= start - 1 && newStart < end : newStart <= end && newStart + newCount > start) return null;
    if (newStart + newCount <= start) offset = oldStart + Math.max(1, oldCount) - newStart - Math.max(1, newCount);
  }
  return { start: start + offset, end: end + offset };
}
function validPath(file) {
  return typeof file === 'string' && file.length > 0 && !file.startsWith('/')
    && !file.includes('\\') && !file.split('/').some(part => part === '..' || part === '.');
}
function lines(text, range) {
  const all = text.split('\n');
  if (range.end > all.length) return null;
  return all.slice(range.start - 1, range.end).join('\n');
}
export function codeOrigin({ worktree, head, file, start, end = start, git }) {
  const unknown = reason => ({ route: 'unknown', reason });
  if (!SHA.test(head ?? '') || !validPath(file)) return unknown('invalid-location');
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return unknown('missing-range');
  const run = args => String(git(['-C', worktree, ...args])).trimEnd();
  try {
    const main = run(['rev-parse', 'refs/remotes/origin/main']);
    const mergeBase = run(['merge-base', head, main]);
    if (!SHA.test(main) || !SHA.test(mergeBase)) return unknown('missing-main');
    const headText = run(['show', `${head}:${file}`]);
    // Include nearby control flow, not just an isolated matching token.
    const range = { start: Math.max(1, start - 3), end: Math.min(headText.split('\n').length, end + 3) };
    for (const ref of new Set([mergeBase, main])) {
      const diff = run(['diff', '--no-ext-diff', '--no-textconv', '--unified=0', ref, head, '--', file]);
      const mapped = mapUnchangedRange(diff, range.start, range.end);
      if (!mapped) return { route: 'in-place', reason: 'changed-region', main, mergeBase, file, range };
      const other = lines(run(['show', `${ref}:${file}`]), mapped);
      const original = lines(headText, range);
      if (!original?.trim() || other !== original) return unknown('range-not-identical');
    }
    return { route: 'main', reason: 'unchanged-on-imported-and-latest-main', head, main, mergeBase, file, range };
  } catch { return unknown('git-evidence-unavailable'); }
}

export function syncFeedbackOrigin({ task, feedback, worktree, git, gh, refresh = true, currentHead = task.headRefOid }) {
  if (!isSyncPr(task.syncPr ?? {})) return { route: 'in-place', reason: 'ordinary-pr' };
  if (!feedback?.threadId || !feedback.path) return { route: 'unknown', reason: 'missing-inline-location' };
  try {
    const query = 'query($id:ID!){node(id:$id){... on PullRequestReviewThread{path line startLine diffSide isOutdated pullRequest{number headRefOid repository{nameWithOwner}}}}}';
    const thread = JSON.parse(gh(['api', 'graphql', '-f', `query=${query}`, '-F', `id=${feedback.threadId}`])).data?.node;
    if (!thread || thread.path !== feedback.path || thread.isOutdated || thread.diffSide !== 'RIGHT'
      || thread.pullRequest?.number !== task.number || thread.pullRequest?.headRefOid !== currentHead
      || thread.pullRequest?.repository?.nameWithOwner !== task.repo) return { route: 'unknown', reason: 'stale-or-unbound-location' };
    if (refresh) git(['-C', worktree, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
    const origin = codeOrigin({ worktree, head: currentHead, file: thread.path, start: thread.startLine ?? thread.line, end: thread.line, git });
    return { ...origin, ...(origin.route === 'main' ? { transferMarker: transferMarker(task, feedback.key) } : {}) };
  } catch { return { route: 'unknown', reason: 'origin-evidence-unavailable' }; }
}

export const SYNC_PR_RULE = [
  '同步 PR 分流优先于同类联动、测试文档必修和裁决规则：先读 prepare.syncPr。目标 integration/* 且来源 sync/*，或标题/正文明确同步 main 进分支时，按同步 PR 处理。',
  '同步 PR 的每条确认成立 P0/P1/P2，在任何改文件前先运行同一 helper sync-origin --key <反馈key>。route=main 表示反馈附近代码在 merge-base 和最新 main 上原样存在：禁止在同步 PR 修它。先按任务 issue 范式建独立 issue，在额外独立工作树从 helper 返回的最新 main SHA 开修复分支、修复并验证，开指向 main 的 PR（使用仓库模板，跑 pre-push、CI 全绿并转 Ready）。原同步工作树保持这条反馈的代码不动，不 cherry-pick 回同步分支。新 PR 是独立任务，按该仓正常 git/gh 提交流程；原同步 PR 仍只能走原 helper finalize，不得裸 push。先查同源转修 PR，已有就续用，不重复开；新 PR 正文必须追加 helper sync-origin 返回的 transferMarker，绑定原 PR、反馈 key 和派发 HEAD。',
  '只有新修复 PR 已实际创建、验证并转 Ready 后，原反馈记 SC=no-change：evidence 第一条写「这是 main 上已有的问题，已转 #<新PR号> 修复」，再加一条「main-transfer: <新PR号> <新PR完整head SHA>」。finalize 会重新核对来源与新 PR 的仓库、main 目标、HEAD、Ready 和 main 祖先关系；核对成功后 watcher 才回复上述人话并 resolve。转修是承认问题成立，不走不成立/P3 裁决。创建、验证或查询失败不能 resolve，也不能把问题记已转修。',
  'route=in-place 表示普通 PR 或同步时解冲突等分支改动影响该段，仍按原流程在同步 PR 修；route=unknown 表示证据不足，先补充当前 head 的准确代码位置与调用上下文，不把它猜成 main 旧问题，不自动关闭讨论；缺权限/服务故障按外部阻塞收口。代码原样相同还须自己确认错误调用条件也来自 main；若由集成分支调用方/解冲突触发，原地修并在 evidence 写明，不能凭一行相同代码转修。',
].join('\n');

export function transferMarker(task, key) {
  return `<!-- vigil-main-transfer origin=${task.number} key=${encodeURIComponent(key)} head=${task.headRefOid} -->`;
}

// Both helper and watcher use this target gate. Yielded reads support synchronous
// finalize and the watcher's async transport without dropping any checks.
export function* verifyMainTransferTarget({ task, key, marker, gh, main = null }) {
  if (!marker || Number(marker[1]) === task.number) throw Error('invalid main-transfer PR');
  const replacement = JSON.parse(yield () => gh(['pr', 'view', marker[1], '--repo', task.repo, '--json', 'number,url,body,state,isDraft,isCrossRepository,baseRefName,headRefOid,statusCheckRollup']));
  if (replacement.number !== Number(marker[1]) || replacement.state !== 'OPEN' || replacement.isDraft !== false
    || replacement.isCrossRepository !== false || replacement.baseRefName !== 'main' || replacement.headRefOid !== marker[2]
    || replacement.url !== `https://github.com/${task.repo}/pull/${marker[1]}`) throw Error('main-transfer PR identity, target, Ready status or head changed');
  if (!String(replacement.body ?? '').split('\n').includes(transferMarker(task, key))) throw Error('main-transfer PR is not bound to this finding');
  const checks = replacement.statusCheckRollup;
  if (!Array.isArray(checks) || !checks.length || checks.some(check => check.__typename === 'StatusContext'
    ? check.state !== 'SUCCESS' : check.status !== 'COMPLETED' || !['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion))) throw Error('main-transfer PR CI is not green');
  // finalize checks ancestry and diff using its freshly fetched local main. The
  // closure path has no product worktree dependency and checks the same facts via API.
  if (main === null) {
    main = String(yield () => gh(['api', `repos/${task.repo}/commits/main`, '--jq', '.sha'])).trim();
    if (!SHA.test(main)) throw Error('main-transfer latest main is unavailable');
    const comparison = JSON.parse(yield () => gh(['api', `repos/${task.repo}/compare/${main}...${marker[2]}?per_page=1`]));
    if (comparison.merge_base_commit?.sha !== main || comparison.behind_by !== 0) throw Error('main-transfer PR does not include latest main');
    if (!Array.isArray(comparison.files) || !comparison.files.length) throw Error('main-transfer PR has no changes against main');
  }
  return replacement;
}
function driveSync(iterator) {
  let step = iterator.next();
  while (!step.done) step = iterator.next(step.value());
  return step.value;
}

// Verification runs before the ordinary no-change/adjudication checks. A valid transfer
// acknowledges a defect, so it must not be mistaken for a disputed finding.
export function verifySyncTransfers({ task, scs, worktree, git, gh, allowedKeys, currentHead = task.headRefOid }) {
  const transferred = new Set();
  if (!isSyncPr(task.syncPr ?? {})) {
    if (scs.some(sc => sc.evidence.some(line => line.startsWith('main-transfer:')))) throw Error('main-transfer requires a sync PR');
    return transferred;
  }
  let refreshed = false;
  for (const feedback of task.feedback ?? []) {
    if (!allowedKeys.includes(feedback.key)) continue;
    const bound = scs.filter(sc => sc.feedbackKeys.includes(feedback.key));
    const markers = bound.flatMap(sc => sc.evidence.filter(line => line.startsWith('main-transfer:')));
    if (!feedback.threadId || !feedback.path) {
      if (markers.length) throw Error('main-transfer requires an inline location');
      continue;
    }
    const origin = syncFeedbackOrigin({ task, feedback, worktree, git, gh, currentHead, refresh: !refreshed });
    refreshed = true;
    if (origin.route !== 'main' && !markers.length) {
      if (origin.route === 'unknown' && bound.some(sc => sc.status === 'pass')) throw Error('sync origin is unknown; obtain current code evidence before fixing');
      continue;
    }
    if (origin.route === 'main' && !markers.length && bound.every(sc => sc.status === 'no-change')) continue;
    if (origin.route !== 'main') throw Error('main-transfer source is not proven unchanged on main');
    if (markers.length !== 1 || bound.some(sc => sc.status !== 'no-change')) throw Error('main inherited feedback requires one verified main-transfer and no-change');
    const marker = /^main-transfer: ([1-9]\d*) ([a-f0-9]{40})$/.exec(markers[0]);
    if (!marker || Number(marker[1]) === task.number) throw Error('invalid main-transfer PR');
    const replacement = driveSync(verifyMainTransferTarget({ task, key: feedback.key, marker, gh, main: origin.main }));
    git(['-C', worktree, 'fetch', 'origin', marker[2]]);
    git(['-C', worktree, 'merge-base', '--is-ancestor', origin.main, marker[2]]);
    if (!String(git(['-C', worktree, 'diff', '--name-only', origin.main, marker[2]])).trim()) throw Error('main-transfer PR has no changes against main');
    for (const sc of bound) {
      sc.evidence[0] = `这是 main 上已有的问题，已转 #${marker[1]} 修复（${replacement.url}）。`;
      if (!sc.evidence.includes(markers[0])) sc.evidence.push(markers[0]);
    }
    transferred.add(feedback.key);
  }
  return transferred;
}
