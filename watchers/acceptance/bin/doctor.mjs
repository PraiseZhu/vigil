#!/usr/bin/env node
// 部署检查（#47 SC1 / SC10）：缺哪项报哪项，退出码非 0；配置缺失不回落任何默认值。
// 本文件不碰子进程模块、不起进程：要跑进程的探测一律注入（正式用时来自 host/probes.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSecretFile, forkTargetFor, loadAcceptanceProfile, tokenFiles, watcherHome } from './profile.mjs';
import { createGithub } from './github.mjs';
import { parseRef } from './rounds.mjs';
import { hostPaths, isAlive } from '../host/paths.mjs';
import { createProbes } from '../host/probes.mjs';

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

/** 看板写回：读这条 issue 的「裁决」原值。 */
export const BOARD_ITEM_QUERY = `query ($login: String!, $projectNumber: Int!, $owner: String!, $name: String!, $issue: Int!) {
  user(login: $login) {
    projectV2(number: $projectNumber) { id }
  }
  repository(owner: $owner, name: $name) {
    issue(number: $issue) {
      id
      projectItems(first: 20, includeArchived: true) {
        nodes {
          id
          isArchived
          project { id }
          fieldValueByName(name: "裁决") {
            ... on ProjectV2ItemFieldTextValue { text }
          }
        }
      }
    }
  }
}`;

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

/**
 * 跑全部部署检查，返回 {ok, checks:[{name, ok, detail}]}。
 * `probes` = {runWriteCommand(action), sandboxMask(), which(cmd)}；测试注入假的。
 * `github` 可注入（测试用假 gh）；不传就按 profile 建真的（只读 + 一条写回）。
 */
export async function runDoctor({
  profileEnv = process.env,
  probes,
  now = () => Date.now(),
  github,
  boardItem,
  hostConfig,
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
  const probeSet = probes || createProbes({ profile, env: profileEnv, hostConfig });

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
      probe = await probeSet.runWriteCommand({ type: 'probe' });
    } catch (error) {
      probe = { code: -1, stderr: String(error?.message || error) };
    }
    if (probe?.code === 0) add('写闸探针', true, '总开关开着：返回 0，什么也没写');
    else if (probe?.code === 4) add('写闸探针', true, '总开关关着：返回 4（只读运行）');
    else add('写闸探针', false, `意外退出码 ${probe?.code ?? '未知'}：${firstLine(probe?.stderr)}`);

    const outside = `not-${String(profile.ownerLogin).toLowerCase()}/outside-repo`;
    let outsideProbe;
    try {
      outsideProbe = await probeSet.runWriteCommand({ type: 'probe', repo: outside });
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

  if (!boardItem) {
    add('看板写回', false, '需要 --board-item <owner/repo#n> 才能验证写回');
  } else {
    try {
      const { repo, number } = parseRef(boardItem);
      const [owner, name] = repo.split('/');
      const data = await api.graphql(BOARD_ITEM_QUERY, {
        login: profile.ownerLogin,
        projectNumber: profile.projectNumber,
        owner,
        name,
        issue: number,
      });
      const projectId = data?.user?.projectV2?.id;
      const items = data?.repository?.issue?.projectItems?.nodes || [];
      const item = items.find((node) => node?.project?.id === projectId);
      if (!item) throw new Error('这条 issue 不在看板上');
      const current = item.fieldValueByName?.text ?? '';
      await api.write({
        type: 'project.field.set',
        dedupeKey: `doctor:${boardItem}:${current}`,
        repo,
        issue: number,
        ownerLogin: profile.ownerLogin,
        projectNumber: profile.projectNumber,
        fields: { 裁决: current },
      });
      add('看板写回', true, '「裁决」原值写回成功');
    } catch (error) {
      add('看板写回', false, firstLine(error?.message));
    }
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

  try {
    const heartbeat = JSON.parse(fs.readFileSync(paths.heartbeatFile, 'utf8'));
    const age = now() - Date.parse(heartbeat.at || 0);
    const alive = isAlive(Number(heartbeat.pid));
    add(
      '常驻循环',
      alive && age <= HEARTBEAT_MAX_AGE_MS,
      alive
        ? `心跳 ${Math.round(age / 1000)} 秒前（上限 ${HEARTBEAT_MAX_AGE_MS / 1000} 秒）`
        : '心跳里的 pid 已经不在（循环没跑）',
    );
  } catch {
    add('常驻循环', false, '没有心跳文件（循环没跑）');
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

  try {
    const masked = await probeSet.sandboxMask();
    add('bwrap 遮罩', masked?.ok, masked?.detail || '');
  } catch (error) {
    add('bwrap 遮罩', false, firstLine(error?.message));
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function flagValue(argv, name) {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  return argv[at + 1];
}

async function main() {
  const boardItem = flagValue(process.argv.slice(2), '--board-item');
  let probes;
  try {
    const profile = loadAcceptanceProfile();
    probes = createProbes({ profile, env: process.env });
  } catch {
    probes = undefined;
  }
  const result = await runDoctor({ profileEnv: process.env, probes, boardItem });
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
