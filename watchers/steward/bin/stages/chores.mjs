import { randomUUID } from 'node:crypto';
import { closeP3Thread, p3Candidates, replyAllowed } from '../chores/p3-close.mjs';
import { closeReverifiedThread, reverifiedCandidates } from '../chores/reverified-resolve.mjs';
import { rerunCandidates, rerunCheck } from '../chores/ci-rerun.mjs';
import { planBaseSync, syncBase, syncSettings } from '../chores/base-sync.mjs';
import { actorKey } from '../discover.mjs';
import { createGithubClient } from '../github.mjs';
import { appForRepo } from '../profile.mjs';
import { appendRound } from '../round-log.mjs';
import { readPr, withPrLock, writePr } from '../state.mjs';

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function patterns(sources) {
  if (!Array.isArray(sources) || !sources.every((source) => typeof source === 'string' && source.trim())) return [];
  try { return sources.map((source) => new RegExp(source, 'i')); } catch { return []; }
}

function keyPattern(source) {
  if (typeof source !== 'string' || !source) return null;
  try { return new RegExp(source); } catch { return null; }
}

function complete(connection) {
  return Array.isArray(connection?.nodes) && connection.pageInfo?.hasNextPage === false
    && connection.totalCount === connection.nodes.length && connection.nodes.every(Boolean);
}

export async function chores({ profile, client, facts, dryRun, log, now = () => new Date(),
  replyClient = createGithubClient({ mode: 'gh' }) }) {
  const enabled = ['p3Close', 'resolveReverified', 'rerunInfra', 'rerunFalseGreen'];
  const work = (facts ?? []).filter((fact) => fact.head && !['未知', '不管'].includes(fact.classification))
    .map((fact) => [fact, object(profile.policies?.[fact.repo.toLowerCase()]?.chores)])
    .filter(([, settings]) => enabled.some((key) => settings[key] === true) || settings.syncBase?.enabled === true);
  log(work.length ? '杂活' : '杂活：未启用');
  if (!work.length) return;
  let viewer;
  for (const [fact, policy] of work) {
    if (!appForRepo(profile.github, fact.repo)) {
      log(`${fact.repo}：杂活跳过，未配置适用的 GitHub App 安装`);
      continue;
    }
    const execute = async () => {
      const previous = readPr(profile.stateDir, fact.pr);
      if (!dryRun && previous?.head !== fact.head) return;
      const state = { ...object(previous?.chores) };
      async function currentPull() {
        const pull = await client.getPull(fact.repo, fact.number);
        if (pull?.number !== fact.number || pull.state !== 'OPEN' || pull.isDraft !== false
          || pull.headRefOid !== fact.head) return null;
        return pull;
      }
      async function refresh(thread) {
        const pull = await currentPull();
        if (!complete(pull?.reviewThreads)) return null;
        const current = pull.reviewThreads.nodes.find((item) => item.id === thread.id);
        if (current?.isResolved !== false || !complete(current.comments)) return null;
        const [root] = current.comments.nodes;
        const [original] = thread.comments;
        if (root?.id !== original.id || root.body !== original.body || actorKey(root.author) !== actorKey(original.author)) return null;
        return current.comments.nodes;
      }
      const app = {
        resolveThread: (threadId) => client.resolveThread(threadId, fact.repo),
        rerunJob: (repo, jobId) => client.rerunJob(repo, jobId),
        updateBranch: (repo, number, head) => client.updateBranch(repo, number, head),
      };
      const context = { fact, state, app, refresh, dryRun, log };
      const run = async (kind, target, action) => {
        const before = JSON.stringify(state);
        let result;
        try { result = await action(); } catch (error) {
          result = 'failed';
          log(`${fact.pr} ${target}：${kind} 失败：${error.message}`);
        }
        if (dryRun) return;
        if (JSON.stringify(state) !== before) writePr(profile.stateDir, fact.pr, { ...previous, chores: state });
        appendRound(profile.stateDir, fact.pr, {
          id: `chore:${randomUUID()}`, type: 'chore', at: now().toISOString(),
          chore_type: kind, object: target, head: fact.head, result,
        });
      };
      const reverified = policy.resolveReverified === true ? reverifiedCandidates(fact, state, patterns(policy.reverifiedPatterns), {
        severities: Array.isArray(policy.reverifiedSeverities) ? policy.reverifiedSeverities : ['P3'],
        keyPattern: keyPattern(policy.reverifiedKeyPattern),
      }) : [];
      for (const thread of reverified) {
        await run('reverified_close', thread.id, () => closeReverifiedThread({ ...context, thread }));
      }
      if (policy.p3Close === true) {
        const settings = { ...policy, reply: policy.p3Reply };
        if (!replyAllowed(settings)) {
          log(`${fact.pr}：P3 结案跳过，回复账号与 followerLogin 不一致或缺失`);
        } else if (typeof settings.reply !== 'string' || !settings.reply.trim()) {
          log(`${fact.pr}：P3 结案跳过，未配置固定回复文案`);
        } else {
          const candidates = p3Candidates(fact, state, settings).filter((thread) => !reverified.includes(thread)
            && !Object.hasOwn(state.reverifiedThreads ?? {}, thread.id));
          if (candidates.length) {
            viewer ??= Promise.resolve().then(() => replyClient.viewer()).then(actorKey, () => null);
            if (await viewer !== settings.followerLogin.toLowerCase()) {
              log(`${fact.pr}：P3 结案跳过，实际 GitHub 回复账号与 followerLogin 不一致或无法验证`);
            } else {
              for (const thread of candidates) {
                await run('p3_close', thread.id, () => closeP3Thread({ ...context, thread, settings, replyClient }));
              }
            }
          }
        }
      }
      const settings = { rerunInfra: policy.rerunInfra === true, rerunFalseGreen: policy.rerunFalseGreen === true,
        falseGreenNeeds: object(policy.falseGreenNeeds) };
      for (const item of rerunCandidates(fact, state, settings, log)) {
        await run(item.kind, item.job, () => rerunCheck({ ...context, item, currentPull }));
      }
      const sync = syncSettings(policy.syncBase);
      if (sync) {
        const plan = await planBaseSync({ fact, state, settings: sync, reader: client, now: now() });
        if (plan.reason === 'eligible') {
          await run('base_sync', fact.baseBranch, () => syncBase({ ...context, plan, currentPull }));
        } else if (plan.reason !== 'up_to_date') {
          log(`${fact.pr}：不更新分支（${plan.reason}）`);
        }
      }
    };
    try {
      if (dryRun) await execute();
      else await withPrLock(profile.stateDir, fact.pr, execute);
    } catch (error) {
      log(`${fact.pr}：杂活阶段失败：${error.message}`);
    }
  }
}
