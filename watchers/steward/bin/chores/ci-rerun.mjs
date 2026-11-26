const ACTIONS_APP_ID = 15368;

function actionsJob(check, repo) {
  if (check.appId !== ACTIONS_APP_ID || typeof check.url !== 'string') return null;
  let url;
  try { url = new URL(check.url); } catch { return null; }
  if (url.origin !== 'https://github.com' || url.username || url.password) return null;
  const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)\/job\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!match || match[1].toLowerCase() !== repo.toLowerCase()) return null;
  const job = Number(match[3]);
  return Number.isSafeInteger(job) ? { check, run: match[2], job } : null;
}

function prerequisite(fact, needs) {
  const upstream = new Map();
  for (const check of fact.falseGreen.skipped) {
    const skipped = actionsJob(check, fact.repo);
    const names = Object.hasOwn(needs, check.name) ? needs[check.name] : null;
    if (!skipped || !Array.isArray(names) || !names.length) return null;
    const failures = fact.falseGreen.failed.filter((item) => item.result === 'failed'
      && ['FAILURE', 'CANCELLED'].includes(item.conclusion) && names.includes(item.name))
      .map((item) => actionsJob(item, fact.repo)).filter((item) => item?.run === skipped.run);
    for (const failure of failures) upstream.set(failure.job, failure);
    if (!failures.length) return null;
  }
  return upstream.size === 1 ? upstream.values().next().value : null;
}

export function rerunCandidates(fact, state, settings, log) {
  const receipts = state.reruns?.[fact.head] ?? {};
  const attempted = new Set(Object.values(receipts));
  const keys = new Set(Object.keys(receipts));
  const candidates = [];
  function add(kind, item) {
    const checkKey = JSON.stringify(['check', item.check.name]);
    if (keys.has(checkKey) || attempted.has(item.job)) return;
    keys.add(checkKey);
    attempted.add(item.job);
    candidates.push({ ...item, kind, checkKey });
  }
  if (settings.rerunFalseGreen && fact.falseGreen && !Object.hasOwn(receipts, 'false_green_rerun')) {
    const item = prerequisite(fact, settings.falseGreenNeeds);
    if (item) add('false_green_rerun', item);
    else log(`${fact.pr}：无法唯一确认假绿灯的前置 job，不重跑`);
  }
  if (settings.rerunInfra) {
    for (const check of fact.checks ?? []) {
      if (!check.infra || check.result !== 'failed') continue;
      const item = actionsJob(check, fact.repo);
      if (item) add('infra_rerun', item);
      else log(`${fact.pr} ${check.name}：无法确认 GitHub Actions job，不重跑`);
    }
  }
  return candidates;
}

export async function rerunCheck({ fact, item, app, state, currentPull, dryRun, log }) {
  if (dryRun) {
    log(`${fact.pr} ${item.check.name}：将重跑 ${item.kind} job ${item.job}`);
    return 'planned';
  }
  const checks = (await currentPull())?.commits?.nodes?.[0]?.commit;
  if (checks?.oid !== fact.head || !checks.statusCheckRollup?.contexts?.nodes?.some((check) =>
    check.databaseId === item.check.id && check.detailsUrl === item.check.url && check.status === 'COMPLETED'
      && check.conclusion === item.check.conclusion && check.checkSuite?.app?.databaseId === ACTIONS_APP_ID)) {
    log(`${fact.pr} ${item.check.name}：当前提交或检查已变化，不重跑`);
    return 'held';
  }
  await app.rerunJob(fact.repo, item.job);
  const receipts = state.reruns?.[fact.head] ?? {};
  state.reruns = { ...state.reruns, [fact.head]: {
    ...receipts, [item.checkKey]: item.job, ...(item.kind === 'false_green_rerun' ? { [item.kind]: item.job } : {}),
  } };
  return 'rerun';
}
