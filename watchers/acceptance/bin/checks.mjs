// 裁决防线：必需检查（build / typecheck / 测试）只要有一项因为环境原因没跑，就不能判「通过」。
// 这一轮只能是「环境问题 / 未验证」：把轮次评论标「中断」（原因以 ENV_PROBLEM_PREFIX 开头，按环境退避重试），
// 宿主看到后写 env-unverified 提醒（四段式 Slack），不关单、不勾选、不写看板「通过」。
//
// 判「通过」时 verified.json（close）、verdict.json（verdict）和 board --acceptance 通过 的 --checks 文件
// 都要带 checks：
//   "checks": { "build": "ran", "typecheck": "ran", "test": "env-skipped" }
// 每项只能是 ran（跑了）/ not-applicable（这个仓本来就没有这项，比如没有 build 脚本）/ env-skipped（因环境没跑）。
// 也可以写成 { "status": "env-skipped", "note": "依赖装不上" }。缺项、写错一律拒绝（退出码 1），什么都不写。
import fs from 'node:fs';
import { ENV_PROBLEM_PREFIX } from './trigger.mjs';

export const REQUIRED_CHECKS = Object.freeze(['build', 'typecheck', 'test']);
export const CHECK_STATES = Object.freeze(['ran', 'not-applicable', 'env-skipped']);
const LABELS = Object.freeze({ build: 'build', typecheck: 'typecheck', test: '测试' });

/** 必需检查因环境没跑：helper 以退出码 6 结束，这一轮已标「中断」（环境问题），模型停手。 */
export class EnvUnverifiedError extends Error {
  constructor(message, { skipped = [], hints = [] } = {}) {
    super(message);
    this.name = 'EnvUnverifiedError';
    this.skipped = skipped;
    this.hints = hints;
  }
}

/**
 * 校验 checks 对象，返回规范化的 {build, typecheck, test} → 状态。
 * `where` 只用在报错里（「close 的 verified.json」之类）。
 */
export function parseChecks(raw, where = '裁决文件') {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `${where} 缺少 checks：判「通过」要写明必需检查 build / typecheck / test 各自是 ran、not-applicable 还是 env-skipped`,
    );
  }
  const out = {};
  const bad = [];
  for (const key of REQUIRED_CHECKS) {
    const value = raw[key];
    const status = typeof value === 'string' ? value : value && typeof value === 'object' ? value.status : undefined;
    if (!CHECK_STATES.includes(status)) bad.push(`${key}=${status === undefined ? '（没写）' : String(status)}`);
    else out[key] = status;
  }
  if (bad.length) {
    throw new Error(`${where} 的 checks 不完整或写错：${bad.join('、')}（每项只能是 ${CHECK_STATES.join(' / ')}）`);
  }
  return out;
}

export function envSkippedChecks(checks) {
  return REQUIRED_CHECKS.filter((key) => checks?.[key] === 'env-skipped');
}

// 「通过」条目的证据里同时出现「没跑」类说法和环境类原因，也按环境没跑处理（防止 checks 写了 ran、证据却写没跑）。
const NOT_RUN = /(没(有)?跑|没法跑|跑不了|未(能)?(运行|执行|跑)|无法(运行|执行|跑)|not\s+(been\s+)?(run|executed)|could\s*n[o']t\s+(run|execute)|cannot\s+(run|execute)|unable\s+to\s+(run|execute))/i;
const ENV_CAUSE = /(环境|依赖|node_modules|npm|pnpm|yarn|registry|网络|出网|断网|离线|offline|沙箱|sandbox|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|装不上|没装|未安装)/i;

/** 「通过」条目里证据写着「因环境没跑」的：返回 `owner/repo#n SC<k>` 列表。 */
export function evidenceEnvHints(items = []) {
  const out = [];
  for (const item of items) {
    if (item?.result !== '通过') continue;
    const text = String(item.evidence || '');
    if (NOT_RUN.test(text) && ENV_CAUSE.test(text)) out.push(`${item.ref} SC${item.sc}`);
  }
  return out;
}

/** 中断原因（写进轮次评论「原因：」行；以 ENV_PROBLEM_PREFIX 开头，trigger 按环境退避）。 */
export function envUnverifiedReason({ skipped = [], hints = [] } = {}) {
  const parts = [];
  if (skipped.length) parts.push(`必需检查因环境原因没跑：${skipped.map((key) => LABELS[key] || key).join('、')}`);
  if (hints.length) parts.push(`「通过」条目的证据写着因环境没跑：${hints.join('、')}`);
  return `${ENV_PROBLEM_PREFIX}${parts.join('；')}。这一轮未验证，不判「通过」`;
}

/** 读 board 的 --checks 文件（可以直接用 verdict.json：只取里面的 checks，由 guardPass 校验）。 */
export function readChecksRaw(file) {
  if (typeof file !== 'string' || !file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))?.checks;
  } catch (error) {
    throw new Error(`读不到 checks 文件 ${file}：${error.message}`);
  }
}

/**
 * 判「通过」前的统一关口：checks 缺/错 → 抛普通错误（退出码 1，什么都不写）；
 * 有环境没跑 → 先把本轮标「中断」（环境问题），再抛 EnvUnverifiedError（退出码 6）。
 */
export async function guardPass({ rounds, ref, n, checks, items = [], where }) {
  const parsed = parseChecks(checks, where);
  const skipped = envSkippedChecks(parsed);
  const hints = evidenceEnvHints(items);
  if (!skipped.length && !hints.length) return parsed;
  const reason = envUnverifiedReason({ skipped, hints });
  await rounds.finish(ref, n, '中断', { reason });
  throw new EnvUnverifiedError(`${reason}：这一轮已标「中断」，停手，不要再写裁决`, { skipped, hints });
}
