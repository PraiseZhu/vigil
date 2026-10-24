// Required-CI triage for the Cindy client repo (makecindy/cindy): what kind of failure each required check is
// and which local command reproduces it. Source of the table: the repo's .github/workflows (client-ci,
// pr-design-basis) and the main branch ruleset (required: DCO, verify, Windows unit tests) as of 2026-10-25.
// Keep it in step with those files.
//
// Why: verify and Windows unit tests only aggregate other jobs (needs + if: always()), their own log is just
// "exit code 1". A repair session handed only the aggregate name has to dig for the failed job and step first.
// Cindy has no gate that times out waiting for other checks (needs queues them), so nothing is held back here;
// the GATES machinery stays for parity with the Mivo watcher.

export const GATE_RERUN_GRACE_MS = 10 * 60 * 1000;
export const GATE_RERUN_MAX_ATTEMPT = 3;
// A gate keeps waiting while any Actions check on the head still runs, but not forever: a job stuck in the queue
// must not hide a red gate for good.
export const GATE_MAX_HOLD_MS = 3 * 60 * 60 * 1000;

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const INFRA_CONCLUSIONS = new Set(['cancelled', 'action_required', 'startup_failure', 'stale']);

export const GATES = [];

export const AGGREGATES = [
  { context: /^verify$/, hint: '汇总门（needs verify-checks + Linux unit tests 分片），本身不修；修下面列出的失败子 job。' },
  { context: /^Windows unit tests$/, hint: '汇总门（needs 4 个 Windows 分片 + Windows runner and database checks），本身不修；修下面列出的失败子 job。' },
];

const SHARD = (prefix) => (name) => {
  const match = new RegExp(`^${prefix} \\((\\d+)\\/(\\d+)\\)$`).exec(name);
  return match ? `${match[1]}/${match[2]}` : null;
};
const linuxShard = SHARD('Linux unit tests');
const windowsShard = SHARD('Windows unit tests');

export const CODE_CHECKS = [
  { context: /^DCO$/, kind: 'format', command: 'git log --format="%H %(trailers:key=Signed-off-by)" origin/main..HEAD 查缺签的提交',
    note: '只看提交的 Signed-off-by。新提交一律 git commit -s；已推送的旧提交缺签要改写历史，watcher 不允许 force push，blocked 报告。' },
  { context: /^verify-checks$/, steps: [
    [/test hygiene/i, 'pnpm check:test-hygiene'],
    [/runner self-tests/i, 'pnpm test:runner'],
    [/source-contract guards/i, 'pnpm test:guard'],
    [/device link/i, 'pnpm --filter desktop exec tsc --project ../../scripts/device-link/tsconfig.json && pnpm test:device-link'],
    [/design colou?rs/i, 'pnpm check:design-colors --base-ref <base> --head-ref HEAD'],
    [/design inventory/i, 'pnpm check:design-inventory'],
    [/endpoint literals/i, 'pnpm check:endpoints'],
    [/i18n key/i, 'pnpm check:i18n'],
    [/brand terminology/i, 'pnpm check:brand-terminology'],
    [/i18n glossary/i, 'pnpm check:i18n-glossary'],
    [/typecheck desktop/i, 'pnpm --filter desktop typecheck'],
    [/typecheck mobile/i, 'pnpm --filter mobile typecheck'],
    [/sqlite migrations/i, 'XDT_MIGRATION_BASE_REF=<base sha> pnpm --filter desktop db:validate'],
    [/scheduler architecture/i, 'pnpm ci:scheduler-guard'],
    [/mobile scope/i, 'pnpm --filter mobile test:scope'],
  ], command: 'bash ~/.claude/skills/cindy-pr-preflight/preflight.sh',
    note: 'Typecheck 报 Ineffective mark-compacts 是内存不足，记 SC=no-change 收口（helper 对同一 head 只用一次签名空提交重触发），不改代码、不 gh run rerun。' },
  { context: (name) => linuxShard(name) !== null, command: (name) => `XDT_UNIT_TEST_SHARD=${linuxShard(name)} pnpm run test:workspaces --tier unit；单文件用 pnpm --filter desktop exec vitest run <file>`,
    note: 'Install bundled ripgrep 步骤失败是下载问题，记 SC=no-change 收口（helper 对同一 head 只用一次签名空提交重触发），不改代码、不 gh run rerun。' },
  { context: (name) => windowsShard(name) !== null, command: '本机复现不了 Windows 差异（路径分隔符/盘符/大小写），以日志为准；可先跑 node apps/desktop/scripts/check-windows-atomic-rename.mjs' },
  { context: /^Windows runner and database checks$/, command: 'pnpm test:runner && pnpm --filter desktop exec vitest run src/main/localDb/ipc/__tests__/botCanonicalSession.test.ts src/main/localDb/ipc/__tests__/botRemoteResourceProvider.test.ts' },
  { context: /^Desktop Git integration$/, command: 'pnpm test:git-integration' },
  { context: /^check:pr-design-basis$/, kind: 'format', command: 'gh pr edit 补「设计依据」字段（引用 docs/design-rules/ 具体章节，或写「不涉及」并附理由）',
    note: '改正文会自动重跑，不用 push。' },
];

const matches = (pattern, name) => typeof pattern === 'function' ? pattern(name) : pattern.test(name);
const resolve = (value, name, pr) => typeof value === 'function' ? value(name, pr) : value;
const isGate = (name) => GATES.some((gate) => gate.context === name);
const timeOf = (check) => Date.parse(check?.started_at ?? check?.created_at ?? '') || 0;

export function latestByName(checks = []) {
  const latest = new Map();
  for (const check of checks) {
    if (!check || typeof check.name !== 'string') continue;
    const key = `${check.name}#${check.app?.id ?? ''}`;
    const prev = latest.get(key);
    if (!prev || timeOf(check) > timeOf(prev) || (timeOf(check) === timeOf(prev) && Number(check.id) > Number(prev.id))) latest.set(key, check);
  }
  return [...latest.values()];
}

const failedStepOf = (job) => (Array.isArray(job?.steps) ? job.steps : [])
  .find((step) => BAD.has(String(step?.conclusion ?? '').toLowerCase()))?.name ?? null;

function codeHint(name, step, pr) {
  const entry = CODE_CHECKS.find((item) => matches(item.context, name));
  if (!entry) return null;
  const stepCommand = step && Array.isArray(entry.steps) ? entry.steps.find(([pattern]) => pattern.test(step))?.[1] : null;
  return { kind: entry.kind ?? 'code', command: stepCommand ?? resolve(entry.command, name, pr) ?? null, note: entry.note ?? null };
}

// Failed github-actions jobs on this head that are not gates and not the aggregate itself.
export function failingJobsOnHead(checks = []) {
  return latestByName(checks).filter((check) => check.app?.slug === 'github-actions' && check.status === 'completed'
    && BAD.has(String(check.conclusion ?? '').toLowerCase()) && !isGate(check.name) && !AGGREGATES.some((agg) => agg.context.test(check.name)));
}

function describeJob(check, jobsById, pr) {
  const step = failedStepOf(jobsById?.get?.(String(check.id)));
  const conclusion = String(check.conclusion ?? '').toLowerCase();
  if (INFRA_CONCLUSIONS.has(conclusion)) return { name: check.name, step, kind: 'infra', conclusion, command: null, note: `结论 ${conclusion}：多为取消或需要批准，记 SC=no-change 收口（helper 对同一 head 只用一次签名空提交重触发），不改代码、不 gh run rerun。` };
  const hint = codeHint(check.name, step, pr);
  return { name: check.name, step, kind: hint?.kind ?? 'code', conclusion, command: hint?.command ?? null, note: hint?.note ?? null };
}

// Classifies one failed required rule. Returns the triage and, for a gate that only mirrors an unsettled
// upstream, the reason to hold the dispatch.
export function triageRule(rule, { checks = [], jobsById = new Map(), required = [], now = Date.now(), pr = null } = {}) {
  const name = rule.context;
  const check = latestByName(checks).find((item) => String(item.id) === String(rule.evidence?.id)) ?? { name, id: rule.evidence?.id, conclusion: 'failure' };
  const conclusion = String(check.conclusion ?? '').toLowerCase();
  const step = failedStepOf(jobsById.get(String(rule.evidence?.id)));
  const gate = GATES.find((item) => item.context === name);
  if (gate) {
    const stepRule = step ? gate.steps.find((item) => item.step.test(step)) : null;
    if (!stepRule) return { triage: { kind: 'unknown', check: name, step, hint: '没读到失败步骤，先看 prepare 返回的 ciErrors 再分类。' }, defer: null };
    const triage = { kind: stepRule.kind, check: name, step, hint: stepRule.hint };
    if (stepRule.kind !== 'waits-upstream') return { triage, defer: null };
    const upstream = latestByName(checks).filter((item) => stepRule.upstream.some((pattern) => pattern.test(item.name)));
    const pendingUp = upstream.filter((item) => item.status !== 'completed').map((item) => item.name);
    const failedUp = upstream.filter((item) => item.status === 'completed' && BAD.has(String(item.conclusion ?? '').toLowerCase())).map((item) => item.name);
    const actionsPending = latestByName(checks).some((item) => item.app?.slug === 'github-actions' && item.status !== 'completed' && !isGate(item.name));
    triage.upstream = { pending: pendingUp, failed: failedUp, seen: upstream.length };
    // Any running Actions check counts, not only the named upstream: a CI re-run recomputes verify later, and a job
    // of another workflow can share the upstream's name (2026-10-25, #1254: org-market preflight's skipped `verify`
    // shadowed CI's verify while CI shards were re-running).
    const gateAge = now - (Date.parse(check.completed_at ?? '') || now);
    if (pendingUp.length || (actionsPending && gateAge < GATE_MAX_HOLD_MS)) return { triage, defer: 'gate-waiting-upstream' };
    const otherRequiredFailed = required.some((item) => item !== rule && item.status === 'failed' && !isGate(item.context));
    if (failedUp.length && otherRequiredFailed) return { triage, defer: 'gate-upstream-failed' };
    const doneAt = Math.max(0, ...upstream.map((item) => Date.parse(item.completed_at ?? '') || 0));
    const attempt = Number(rule.evidence?.attempt ?? 1);
    if (!failedUp.length && doneAt && now - doneAt < GATE_RERUN_GRACE_MS && attempt < GATE_RERUN_MAX_ATTEMPT) return { triage, defer: 'gate-rerun-expected' };
    return { triage, defer: null };
  }
  if (INFRA_CONCLUSIONS.has(conclusion)) {
    return { triage: { kind: 'infra', check: name, step, hint: `结论 ${conclusion}：多为并发取消、runner 回收或需要维护者批准，记 SC=no-change 收口（helper 对同一 head 只用一次签名空提交重触发），不改代码、不 gh run rerun。` }, defer: null };
  }
  const aggregate = AGGREGATES.find((item) => item.context.test(name));
  if (aggregate) {
    const children = failingJobsOnHead(checks).map((item) => describeJob(item, jobsById, pr));
    return { triage: { kind: 'aggregate', check: name, step, hint: aggregate.hint, children }, defer: null };
  }
  const hint = codeHint(name, step, pr);
  return { triage: { kind: hint?.kind ?? 'code', check: name, step, command: hint?.command ?? null, hint: hint?.note ?? null }, defer: null };
}

const precedence = (required) => required.some((item) => item.status === 'failed') ? 'failed'
  : required.some((item) => item.status === 'unknown') ? 'unknown'
    : required.some((item) => item.status === 'pending') ? 'pending' : 'green';

// Adds triage to every failed required rule and turns a gate that only mirrors an unsettled upstream into
// pending, so the watcher waits instead of dispatching. Other statuses are untouched.
export function applyCiTriage(result, options = {}) {
  if (!result || !Array.isArray(result.required) || result.status === 'unknown') return result;
  const required = result.required.map((rule) => {
    if (rule.status !== 'failed') return rule;
    const { triage, defer } = triageRule(rule, { ...options, required: result.required });
    return defer ? { ...rule, status: 'pending', reason: defer, deferredFrom: 'failed', triage } : { ...rule, triage };
  });
  return { ...result, required, status: precedence(required) };
}

const KIND_LABEL = {
  format: 'format（改 PR 元数据，不改代码）',
  code: 'code（改代码，先本地复现）',
  'waits-upstream': 'waits-upstream（等上游，修上游或重跑，不为它改代码）',
  aggregate: 'aggregate（汇总门，修下面的子 job）',
  infra: 'infra（取消/环境/外部，SC=no-change 或 blocked，不改代码）',
  unknown: 'unknown（未能分类）',
};

export function triageText(triage) {
  if (!triage) return '';
  const lines = [`分类：${KIND_LABEL[triage.kind] ?? triage.kind}`];
  if (triage.step) lines.push(`失败步骤：${triage.step}`);
  if (triage.command) lines.push(`本地复现：${triage.command}`);
  if (triage.upstream) lines.push(`上游：待完成 ${triage.upstream.pending.length ? triage.upstream.pending.join('、') : '无'}；失败 ${triage.upstream.failed.length ? triage.upstream.failed.join('、') : '无'}`);
  if (Array.isArray(triage.children)) {
    if (!triage.children.length) lines.push('子 job：没找到失败的子 job，看 ciErrors。');
    for (const child of triage.children) {
      lines.push(`- ${child.name}${child.step ? ` · 步骤 ${child.step}` : ''} · ${child.kind}${child.command ? ` → ${child.command}` : ''}${child.note ? `（${child.note}）` : ''}`);
    }
  }
  if (triage.hint) lines.push(`处理：${triage.hint}`);
  return lines.join('\n');
}
