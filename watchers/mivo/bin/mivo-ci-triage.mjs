// Required-CI triage for the Mivo plugin repo: what kind of failure each required check is, when a red
// gate only mirrors an upstream that has not settled yet, and which local command reproduces it.
// Source of the table: the repo's .github/workflows (ci.yml, pr-hygiene.yml, pr-ci-freshness.yml,
// pr-handoff.yml, pr-gate-rerun.yml) as of 2026-10-25. Keep it in step with those files.
//
// Why: a gate that waits for other checks (pr-ci-freshness waits for verify, the platform-evidence step of
// pr-format-gate waits for the Windows jobs) turns red when its own 30-minute wait runs out while CI is still
// running, and pr-gate-rerun re-runs it once CI succeeds. Dispatching a repair session for that red only
// costs a round (2026-10-25, #1254). A session that does get a real failure should not have to look up which
// step failed and how to reproduce it.

export const GATE_RERUN_GRACE_MS = 10 * 60 * 1000; // pr-gate-rerun fires on CI completion; give it this long
export const GATE_RERUN_MAX_ATTEMPT = 3; // pr-gate-rerun only re-runs while run_attempt < 3
// A gate keeps waiting while any Actions check on the head still runs, but not forever: a job stuck in the queue
// must not hide a red gate for good.
export const GATE_MAX_HOLD_MS = 3 * 60 * 60 * 1000;

const BAD = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const INFRA_CONCLUSIONS = new Set(['cancelled', 'action_required', 'startup_failure', 'stale']);

const WINDOWS_UPSTREAM = [/^Windows unit shard \(\d+\/\d+\)$/, /^Windows unit tests$/, /^Windows plugin smoke$/];

// Gates whose result depends on other checks. step matches the failed step name of the gate's job.
export const GATES = [
  { context: 'pr-ci-freshness', steps: [
    { step: /stale-green/, kind: 'waits-upstream', upstream: [/^verify$/],
      hint: '只等 verify 在当前 head 成功，不要为它改代码。verify 红就修 verify 的上游；verify 绿后 pr-gate-rerun 会自动重跑它，自动次数用完再 gh run rerun <run-id> --failed 一次。' },
    { step: /sha256/, kind: 'infra',
      hint: '可信 main 上 check-run-freshness.mjs 的 sha256 pin 校验失败，PR 侧改不了；只有本 PR 动了 scripts/ci/sha256.pins 或该脚本才相关，否则 blocked 报告。' },
  ] },
  { context: 'pr-format-gate (title/body template)', steps: [
    { step: /title\/body/i, kind: 'format',
      hint: 'PR 标题或正文不合模板：用 gh pr edit 改，不改代码、不 push。标题须为 <type>(<scope>)?: <描述>；段落与 self-review 勾选率以可信 main 的 agent-use/docs/pr-rules.json 和 .github/pull_request_template.md 为准。改正文会自动重跑该门。' },
    { step: /platform evidence/i, kind: 'waits-upstream', upstream: WINDOWS_UPSTREAM,
      hint: 'Windows 证据步：等当前 head 的 Windows unit shard / Windows unit tests / Windows plugin smoke 成功。上游红就修上游；上游都绿了仍红看 ##[error]：mivo-platform-evidence 块缺失或字段不对改 PR 正文；要求 /approve-windows-control 的需要维护者，blocked 报告；head/attempt 变化类竞态重跑一次。' },
  ] },
];

// Checks that only aggregate other jobs: never the thing to fix.
export const AGGREGATES = [
  { context: /^verify$/, hint: '汇总门，本身不修；修下面列出的失败子 job。' },
  { context: /^Linux unit tests$/, hint: '4 个 Linux 分片的汇总，修失败的分片。' },
  { context: /^Windows unit tests$/, hint: '4 个 Windows 分片的汇总，修失败的分片。' },
];

const SHARD = (prefix) => (name) => {
  const match = new RegExp(`^${prefix} \\((\\d+)\\/(\\d+)\\)$`).exec(name);
  return match ? `${match[1]}/${match[2]}` : null;
};
const linuxShard = SHARD('Linux unit shard');
const windowsShard = SHARD('Windows unit shard');

// Code checks: per job, an optional per-step command and a job-level fallback.
export const CODE_CHECKS = [
  { context: /^lint \+ tsc \+ unit \+ logging$/, steps: [
    [/tsc/i, 'npx tsc -b'],
    [/eslint|^lint/i, 'npm run lint'],
    [/logging/i, 'npm run verify:logging'],
    [/i18n/i, 'npm run verify:i18n'],
    [/cycle/i, 'node scripts/ci/cycle-guard.mjs'],
    [/internal infra literals/i, 'node scripts/ci/check-internal-literals.mjs'],
    [/endpoint literals/i, 'node scripts/ci/check-endpoint-literals.mjs'],
    [/review-machine guard/i, 'for f in .github/scripts/tests/test_*.py; do python3 "$f"; done && node --test .github/scripts/tests/*.node-test.mjs'],
  ], command: 'npx tsc -b && npm run lint && npm run verify:logging && npm run verify:i18n' },
  { context: (name) => linuxShard(name) !== null, command: (name) => `npm run test:unit -- --shard=${linuxShard(name)}`,
    note: '停在 15 分钟上限的是超时，先看是否 runner 抖动再改代码。' },
  { context: /^structure guard/, command: 'node scripts/ci/structure-guard.mjs（需要 origin/main 或 MIVO_GUARD_BASE_SHA）' },
  { context: /^design verification/, command: 'MIVO_LITERAL_RATCHET_ENFORCE=1 npm run verify:design' },
  { context: /^lifeline spec/, command: 'node scripts/loops/lifeline/spec/run-tlc.mjs && node scripts/loops/lifeline/spec/run-tlc.mjs --mutants（需要 Java 21）' },
  { context: /^cindyplugin build$/, steps: [
    [/manifest/i, '校验 cindyplugin/ghost.json 的 id / version(x.y.z) / entry / name'],
    [/build plugin bundle/i, 'MIVO_DEBUG_INGEST_TOKEN=__INJECTION_CANARY__ MIVO_PLUGIN_BUILD_CONTEXT=ci bash cindyplugin/build.sh'],
    [/language reads/i, 'node cindyplugin/check-host-locale.mjs cindyplugin/dist'],
    [/vendor/i, 'node cindyplugin/check-vendor-split.mjs cindyplugin/dist'],
  ], command: 'MIVO_PLUGIN_BUILD_CONTEXT=ci bash cindyplugin/build.sh' },
  { context: /^secret scan/, command: 'gitleaks detect --config .gitleaks.toml --log-opts "<base>..<head>" --redact=100',
    note: '命中泄漏先清掉内容；需要改写历史的不要 force push，blocked 报告。' },
  { context: (name) => windowsShard(name) !== null, command: (name) => `npm run test:unit -- --testTimeout=20000 --retry=1 --shard=${windowsShard(name)}（本机多半复现不了 Windows 差异，以日志为准）`,
    note: '停在 30 分钟上限的是超时，先看是否 runner 抖动再改代码。' },
  { context: /^Windows plugin smoke$/, command: 'bash cindyplugin/build.sh；浏览器 fixture 需要 Windows + Chrome，以日志为准',
    note: 'Locate Chrome 步骤失败（Chrome missing on Windows runner）是 runner 问题，重跑一次。' },
  { context: /^Windows evidence policy probe$/, command: 'node scripts/ci/windows-evidence-policy-probe.mjs' },
  { context: /^pr-handoff-gate$/, kind: 'format', command: (name, pr) => `node scripts/pr-handoff/check.mjs ${pr ?? '<PR号>'}`,
    note: '交接文件在 docs/pr/<PR号>/review.md 与 qa.md。' },
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
  if (INFRA_CONCLUSIONS.has(conclusion)) return { name: check.name, step, kind: 'infra', conclusion, command: null, note: `结论 ${conclusion}：多为取消或需要批准，重跑一次，不改代码。` };
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
    return { triage: { kind: 'infra', check: name, step, hint: `结论 ${conclusion}：多为并发取消、runner 回收或需要维护者批准，gh run rerun <run-id> --failed 一次，仍失败再当真实失败处理；不改代码。` }, defer: null };
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
  infra: 'infra（取消/环境/外部，重跑或 blocked，不改代码）',
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
