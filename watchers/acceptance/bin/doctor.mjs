#!/usr/bin/env node
// 部署检查（#47 SC1 / SC10）：缺哪项报哪项，退出码非 0；配置缺失不回落任何默认值。
// 本文件不碰子进程模块、不起进程：要跑进程的探测一律注入（正式用时来自 host/probes.mjs）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSecretFile, forkTargetFor, loadAcceptanceProfile, tokenFiles, watcherHome } from './profile.mjs';
import { createGithub } from './github.mjs';
import { hostPaths, isAlive } from '../host/paths.mjs';
import { createProbes } from '../host/probes.mjs';
import { handoffFor, preflightCommands, repoConfig } from '../host/prbot-config.mjs';
import { checkSlackAccess } from '../host/slack-notify.mjs';
import { describeViolation, runGateAudit } from '../host/gate-audit.mjs';
import { POLL_STALL_S, pollingElapsedS } from '../host/poll-beat.mjs';

/** 令牌账号 == ownerLogin 用这条。 */
export const VIEWER_QUERY = `query {
  viewer { login }
}`;

/** 仓能不能读、有没有写权限都用这条。 */
export const REPO_QUERY = `query ($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner
    viewerPermission
  }
}`;

/** 看板能不能读。 */
export const PROJECT_QUERY = `query ($login: String!, $projectNumber: Int!) {
  user(login: $login) {
    projectV2(number: $projectNumber) {
      id
      title
    }
  }
}`;

/**
 * 看板写回（只读判断）：账号令牌对这块看板有没有写权限（viewerCanUpdate），「验收」「裁决」两个字段在不在、类型对不对。
 * 以前是读一条条目的「裁决」原值再经 writeCommand 写回，但写闸 exec 只放行认领和中断，恒返回 4——doctor 自己错了；
 * 现在一律只读，doctor 不对 GitHub 做任何真实写入。
 */
export const BOARD_ACCESS_QUERY = `query ($login: String!, $projectNumber: Int!) {
  user(login: $login) {
    projectV2(number: $projectNumber) {
      id
      viewerCanUpdate
      fields(first: 50) {
        nodes {
          __typename
          ... on ProjectV2FieldCommon { name dataType }
          ... on ProjectV2SingleSelectField { options { name } }
        }
      }
    }
  }
}`;

/** 「验收」字段必须有的选项（board.mjs 会写的四个值）。 */
export const ACCEPTANCE_OPTIONS = Object.freeze(['验收中', '要修', '修正中', '通过']);

export const MIN_NODE_MAJOR = 22;
export const HEARTBEAT_MAX_AGE_MS = 180000;
const FORK_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

function firstLine(text) {
  return String(text || '').trim().split('\n')[0] || '';
}

function nodeMajor() {
  return Number(String(process.versions.node || '0').split('.')[0]);
}

function sameLogin(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function realOrSelf(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * host.json 里遮罩相关的两项（不起进程）：credentialDirs / homeAllowDirs 每一项都要是存在的绝对路径，
 * 而且不能和可写绑定（stateDir、worktreeDir）互相包含——重叠了要么凭证可写、要么白名单把遮罩顶掉。
 * 返回问题列表，空数组表示没问题。路径只报键名和序号，不回显。
 */
export function checkMaskConfig({ hostConfig, profile } = {}) {
  const problems = [];
  const binds = [profile?.stateDir, profile?.worktreeDir].filter((dir) => typeof dir === 'string' && path.isAbsolute(dir));
  for (const key of ['credentialDirs', 'homeAllowDirs']) {
    const list = hostConfig?.[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      problems.push(`host.json 的 ${key} 应为绝对路径数组`);
      continue;
    }
    list.forEach((dir, index) => {
      const label = `${key}[${index}]`;
      if (typeof dir !== 'string' || !path.isAbsolute(dir)) {
        problems.push(`${label} 不是绝对路径`);
        return;
      }
      if (!fs.existsSync(dir)) {
        problems.push(`${label} 不存在`);
        return;
      }
      const real = realOrSelf(dir);
      for (const bind of binds) {
        const bindReal = realOrSelf(bind);
        if (isInside(real, bindReal) || isInside(bindReal, real)) {
          problems.push(`${label} 与可写绑定（${bind === profile.stateDir ? 'stateDir' : 'worktreeDir'}）重叠`);
        }
      }
    });
  }
  return problems;
}

/** 读 <home>/config/host.json：没有就是 {}；坏了抛错（doctor 报出来）。 */
export function readHostJson(home) {
  const file = path.join(home, 'config', 'host.json');
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('host.json 应为对象');
  return parsed;
}

/** 探针动作：dedupeKey 每次随机（成功一次后不会被账本去重成空测），带 probe 标记，写闸只记日志、不写提醒。 */
export function probeAction(extra = {}) {
  return { type: 'probe', probe: true, dedupeKey: `doctor-probe:${crypto.randomUUID()}`, ...extra };
}

/**
 * 跑全部部署检查，返回 {ok, checks:[{name, ok, detail}]}。
 * `probes` = {runWriteCommand(action), sandboxMask(), which(cmd)}；测试注入假的。
 * `github` 可注入（测试用假 gh）；不传就按 profile 建真的（全部只读，不写 GitHub）。
 * `hostConfig` 不传就读 <home>/config/host.json（遮罩名单和 credentialDirs / homeAllowDirs 检查都要它）。
 */
export async function runDoctor({
  profileEnv = process.env,
  probes,
  now = () => Date.now(),
  uptime = () => os.uptime(),
  github,
  hostConfig,
  slackCheck = checkSlackAccess,
  gateAudit = (options) => runGateAudit(options),
} = {}) {
  const checks = [];
  const add = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail });
  };

  let profile;
  try {
    profile = loadAcceptanceProfile(profileEnv);
  } catch (error) {
    // 配置有问题就只报这一条：不猜、不回落。
    add('配置', false, String(error?.message || error));
    return { ok: false, checks };
  }

  const home = watcherHome(profileEnv);
  const paths = hostPaths(home);
  const api = github || createGithub({ profile });
  let hostSettings = hostConfig;
  let hostConfigError = null;
  if (hostSettings === undefined) {
    try {
      hostSettings = readHostJson(home);
    } catch (error) {
      hostSettings = {};
      hostConfigError = `host.json 读不出：${firstLine(error?.message)}`;
    }
  }
  const probeSet = probes || createProbes({ profile, env: profileEnv, hostConfig: hostSettings });

  add(
    'node 版本',
    nodeMajor() >= MIN_NODE_MAJOR,
    `当前 ${process.versions.node}，需要 ≥ ${MIN_NODE_MAJOR}`,
  );

  const ghPath = probeSet.which ? probeSet.which('gh') : null;
  add('gh 在 PATH 上', Boolean(ghPath), ghPath ? '找到 gh' : 'PATH 里没有 gh');
  const gitPath = probeSet.which ? probeSet.which('git') : null;
  add('git 在 PATH 上', Boolean(gitPath), gitPath ? '找到 git' : 'PATH 里没有 git');

  try {
    const data = await api.graphql(VIEWER_QUERY);
    const login = data?.viewer?.login;
    add(
      '令牌账号',
      sameLogin(login, profile.ownerLogin),
      login ? `令牌账号是 ${login}` : '读不到令牌账号',
    );
  } catch (error) {
    add('令牌账号', false, firstLine(error?.message));
  }

  const explicitRepos = [
    ...new Set([...(profile.autoRepos || []), ...(profile.forkRepos || []), ...(profile.watchRepos || [])]),
  ].filter((pattern) => !String(pattern).endsWith('/*'));
  const unreadable = [];
  for (const repo of explicitRepos) {
    const [owner, name] = String(repo).split('/');
    try {
      const data = await api.graphql(REPO_QUERY, { owner, name });
      if (!data?.repository) unreadable.push(repo);
    } catch {
      unreadable.push(repo);
    }
  }
  add(
    '仓可读',
    unreadable.length === 0,
    unreadable.length > 0
      ? `读不到：${unreadable.join(', ')}`
      : explicitRepos.length > 0
        ? `读了 ${explicitRepos.length} 个具体仓`
        : '名单里只有通配，没有具体仓要读',
  );

  if (profile.writeCommand) {
    let probe;
    try {
      probe = await probeSet.runWriteCommand(probeAction());
    } catch (error) {
      probe = { code: -1, stderr: String(error?.message || error) };
    }
    if (probe?.code === 0) add('写闸探针', true, '总开关开着：返回 0，什么也没写');
    else if (probe?.code === 4) add('写闸探针', true, '总开关关着：返回 4（只读运行）');
    else add('写闸探针', false, `意外退出码 ${probe?.code ?? '未知'}：${firstLine(probe?.stderr)}`);

    const outside = `not-${String(profile.ownerLogin).toLowerCase()}/outside-repo`;
    let outsideProbe;
    try {
      outsideProbe = await probeSet.runWriteCommand(probeAction({ repo: outside }));
    } catch (error) {
      outsideProbe = { code: -1, stderr: String(error?.message || error) };
    }
    add(
      '写闸探针（仓外）',
      outsideProbe?.code === 4,
      outsideProbe?.code === 4
        ? '读名单外的仓返回 4'
        : `名单外的仓没被拒（退出码 ${outsideProbe?.code ?? '未知'}）`,
    );
  } else {
    add('写闸探针', true, '没有配 writeCommand（直接写），跳过探针');
  }

  try {
    const data = await api.graphql(PROJECT_QUERY, {
      login: profile.ownerLogin,
      projectNumber: profile.projectNumber,
    });
    add(
      '看板',
      Boolean(data?.user?.projectV2),
      data?.user?.projectV2 ? `看板 #${profile.projectNumber} 读得到` : `读不到看板 #${profile.projectNumber}`,
    );
  } catch (error) {
    add('看板', false, firstLine(error?.message));
  }

  // 看板写回：只读判断，不经写闸、不写 GitHub。写看板用的是账号令牌，所以优先用账号令牌查（App 令牌看不到个人看板）。
  try {
    const query = typeof api.ownerGraphql === 'function' ? api.ownerGraphql.bind(api) : api.graphql.bind(api);
    const data = await query(BOARD_ACCESS_QUERY, { login: profile.ownerLogin, projectNumber: profile.projectNumber });
    const project = data?.user?.projectV2;
    if (!project) throw new Error(`读不到看板 #${profile.projectNumber}`);
    const problems = [];
    if (project.viewerCanUpdate !== true) problems.push('令牌账号对看板没有写权限（viewerCanUpdate=false）');
    const fields = new Map((project.fields?.nodes || []).filter((node) => node?.name).map((node) => [node.name, node]));
    const acceptance = fields.get('验收');
    if (!acceptance) problems.push('看板没有「验收」字段');
    else {
      const options = new Set((acceptance.options || []).map((option) => option?.name));
      const lacking = ACCEPTANCE_OPTIONS.filter((name) => !options.has(name));
      if (lacking.length) problems.push(`「验收」字段缺选项：${lacking.join('、')}`);
    }
    const verdict = fields.get('裁决');
    if (!verdict) problems.push('看板没有「裁决」字段');
    else if (verdict.dataType === 'SINGLE_SELECT') problems.push('「裁决」字段必须是文本，不能是单选');
    add(
      '看板写回',
      problems.length === 0,
      problems.length ? problems.join('；') : '账号令牌能写这块看板，「验收」「裁决」字段齐全（只读检查，没写）',
    );
  } catch (error) {
    add('看板写回', false, firstLine(error?.message));
  }

  const forkProblems = [];
  for (const pattern of profile.forkRepos || []) {
    const name = String(pattern).split('/')[1];
    if (!name || name === '*') continue;
    const target = forkTargetFor(profile, pattern);
    const [owner, targetName] = target.split('/');
    try {
      const data = await api.graphql(REPO_QUERY, { owner, name: targetName });
      const permission = data?.repository?.viewerPermission;
      if (!FORK_PERMISSIONS.has(String(permission))) forkProblems.push(target);
    } catch {
      forkProblems.push(target);
    }
  }
  add(
    'fork 推送',
    forkProblems.length === 0,
    forkProblems.length > 0 ? `推不了：${forkProblems.join(', ')}` : 'fork 有写权限',
  );

  // 修正轮（#60）：host.json 配了 prbot 就查交接方式（必须显式写 owner / watcher，没写的仓修正轮不认领）和预检格式。
  let host = hostConfig;
  let hostProblem = null;
  if (host === undefined) {
    try {
      host = fs.existsSync(paths.hostConfig) ? JSON.parse(fs.readFileSync(paths.hostConfig, 'utf8')) : {};
    } catch (error) {
      host = null;
      hostProblem = `host.json 读不出：${firstLine(error?.message)}`;
    }
  }
  if (hostProblem) {
    add('修正轮交接配置', false, hostProblem);
  } else if (host?.prbot) {
    const repos = host.prbot.repos && typeof host.prbot.repos === 'object' && !Array.isArray(host.prbot.repos) ? host.prbot.repos : {};
    const problems = [];
    for (const repo of Object.keys(repos)) {
      if (!handoffFor(host, repo)) problems.push(`${repo} 的 handoff 没写成 owner / watcher`);
      if (preflightCommands(repoConfig(host, repo)) === null) problems.push(`${repo} 的 preflight 格式不对（每项是字符串或字符串数组）`);
    }
    // 名单里写明的具体仓（通配列不出来）都要有交接方式：没写的仓修正轮不认领、只报一次需人工处理。
    const named = [...new Set([...(profile.autoRepos || []), ...(profile.forkRepos || [])])].filter((repo) => !String(repo).endsWith('/*'));
    for (const repo of named) {
      if (!handoffFor(host, repo) && !problems.some((entry) => entry.startsWith(`${repo} `))) problems.push(`${repo} 没在 prbot.repos 里写 handoff`);
    }
    add(
      '修正轮交接配置',
      problems.length === 0,
      problems.length > 0
        ? problems.join('；')
        : `检查了 ${Object.keys(repos).length} 个仓（通配名单里的仓要在 prbot.repos 里逐个写明 handoff）`,
    );
  }

  try {
    const heartbeat = JSON.parse(fs.readFileSync(paths.heartbeatFile, 'utf8'));
    const age = now() - Date.parse(heartbeat.at || 0);
    const alive = isAlive(Number(heartbeat.pid));
    const ageS = Math.round(age / 1000);
    // T18：心跳带 polling（正在拉取）时另按拉取时长判；超过上限照样报红，不让新鲜心跳藏住真卡死。
    // 超限的说明故意不以「心跳 N 秒前」开头，免得外面的复核把它当成整机冻结/心跳延迟放过。
    const pollS = heartbeat.polling ? pollingElapsedS(heartbeat.polling, { now, uptime }) : null;
    const pollStuck = pollS !== null && pollS > POLL_STALL_S;
    const heartbeatDetail = `心跳 ${ageS} 秒前（上限 ${HEARTBEAT_MAX_AGE_MS / 1000} 秒）`;
    let detail;
    if (!alive) detail = '心跳里的 pid 已经不在（循环没跑）';
    else if (pollStuck) detail = `拉取已 ${pollS} 秒没结束，超过上限 ${POLL_STALL_S} 秒（拉取 120 秒就该被掐掉，可能卡死）；${heartbeatDetail}`;
    else if (pollS !== null) detail = `${heartbeatDetail}，正在拉取（已 ${pollS} 秒，上限 ${POLL_STALL_S} 秒）`;
    else detail = heartbeatDetail;
    add('常驻循环', alive && age <= HEARTBEAT_MAX_AGE_MS && !pollStuck, detail);
  } catch {
    add('常驻循环', false, '没有心跳文件（循环没跑）');
  }

  // 写闸账本审计（只读）：旁路核对写闸账本里已执行的写入，看有没有越规的。只读本地账本 + 只读查轮次评论。
  // 只有明确违规才让这一项变红；「拿不准」只记日志（detail 里报出来），GitHub 没查成也照旧写进 detail 但不改变红绿。
  try {
    const audit = await gateAudit({ home, profile, github: api, now });
    const parts = [];
    if (audit?.busy) {
      parts.push('另一处审计正在跑，这次跳过');
    } else {
      parts.push(`核对 ${Number(audit?.checkedLines) || 0} 行`);
      if (audit?.baseline) {
        parts.push(
          `基线 ${audit.baseline.at}（基线前 ${Number(audit.baseline.lines) || 0} 条，疑似违规 ${Number(audit.baseline.violations) || 0} 条）`,
        );
      }
      parts.push(`基线后违规 ${Number(audit?.sinceBaseline) || 0} 条`);
      const uncertainNew = Array.isArray(audit?.newUncertain) ? audit.newUncertain.length : 0;
      parts.push(`拿不准 新 ${uncertainNew} 条、近 24 小时 ${Number(audit?.uncertain24h) || 0} 条（只记日志）`);
    }
    const githubErrors = Array.isArray(audit?.githubErrors) ? audit.githubErrors : [];
    if (githubErrors.length > 0) parts.push(`GitHub 只读核对没做成：${githubErrors.join('；')}`);
    const fresh = Array.isArray(audit?.newViolations) ? audit.newViolations : [];
    if (fresh.length > 0) parts.push(`这次新发现：${fresh.slice(0, 3).map(describeViolation).join('；')}`);
    add('写闸账本审计', audit?.ok, parts.join('；'));
  } catch (error) {
    add('写闸账本审计', false, firstLine(error?.message));
  }

  // 令牌文件从原始 profile.json 算（loadAcceptanceProfile 只回白名单键，新增的 …TokenFile 键看不到）。
  let rawProfile = {};
  try {
    rawProfile = JSON.parse(fs.readFileSync(profile.profilePath, 'utf8'));
  } catch {
    rawProfile = {};
  }
  const keyFiles = tokenFiles(rawProfile);
  if (profile.appPrivateKeyFile && !keyFiles.some((entry) => entry.file === profile.appPrivateKeyFile)) {
    keyFiles.push({ key: 'appPrivateKeyFile', file: profile.appPrivateKeyFile });
  }
  const badKeyFiles = [];
  for (const entry of keyFiles) {
    try {
      checkSecretFile(entry.file, entry.key);
    } catch (error) {
      badKeyFiles.push(`${entry.key}：${error.message}`);
    }
  }
  add(
    '令牌文件',
    badKeyFiles.length === 0,
    badKeyFiles.length > 0
      ? badKeyFiles.join('；')
      : `检查了 ${keyFiles.length} 个密钥文件（权限 600、属主当前用户）`,
  );

  // Slack（#61）：只读检查令牌能过 auth.test、bot 在目标频道里；没配 Slack 就跳过（算通过）。
  try {
    const slack = await slackCheck({ profile });
    add('Slack 频道', slack?.ok, slack?.detail || '');
  } catch (error) {
    add('Slack 频道', false, firstLine(error?.message));
  }

  // 遮罩：先查 host.json 的 credentialDirs / homeAllowDirs（存在、不与可写绑定重叠），再在 bwrap 里实测读不到。
  const maskProblems = hostConfigError ? [hostConfigError] : checkMaskConfig({ hostConfig: hostSettings, profile });
  try {
    const masked = await probeSet.sandboxMask();
    const ok = Boolean(masked?.ok) && maskProblems.length === 0;
    const detail = [...maskProblems, masked?.detail || ''].filter(Boolean).join('；');
    add('bwrap 遮罩', ok, detail);
  } catch (error) {
    add('bwrap 遮罩', false, [...maskProblems, firstLine(error?.message)].filter(Boolean).join('；'));
  }

  return { ok: checks.every((check) => check.ok), checks };
}

async function main() {
  // --board-item 已不需要（看板写回改成只读判断）；还传的话忽略。
  let probes;
  let hostConfig;
  try {
    const profile = loadAcceptanceProfile();
    try {
      hostConfig = readHostJson(watcherHome(process.env));
    } catch {
      // 读不出交给 runDoctor 报（它会再读一次并写进「bwrap 遮罩」）。
      hostConfig = undefined;
    }
    probes = createProbes({ profile, env: process.env, hostConfig });
  } catch {
    probes = undefined;
  }
  const result = await runDoctor({ profileEnv: process.env, probes, hostConfig });
  for (const check of result.checks) {
    if (check.ok) process.stdout.write(`✓ ${check.name}\n`);
    else process.stdout.write(`✗ ${check.name}：${check.detail}\n`);
  }
  process.exitCode = result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && invoked === fileURLToPath(import.meta.url)) {
  await main();
}
