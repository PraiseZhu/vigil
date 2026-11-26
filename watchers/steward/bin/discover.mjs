import { REPO } from './profile.mjs';

export function actorKey(actor) {
  if (typeof actor?.login !== 'string' || !actor.login) return null;
  const login = actor.login.toLowerCase();
  if (actor.type === 'Bot' || actor.__typename === 'Bot' || login.endsWith('[bot]')) {
    return `app/${login.replace(/\[bot\]$/, '')}`;
  }
  return login;
}

export function scopeReasons(pr, profile) {
  return [
    ...(pr.state !== 'open' ? ['closed'] : []),
    ...(pr.draft ? ['draft'] : []),
    ...(!profile.authors.some((author) => author.toLowerCase() === actorKey(pr.author)) ? ['author_not_listed'] : []),
    ...(profile.excludeRepos.some((repo) => repo.toLowerCase() === pr.repo.toLowerCase()) ? ['excluded_repo'] : []),
  ];
}

export async function discover(client, profile) {
  const candidates = new Map();
  const errors = [];
  const explicit = new Set(profile.repos.map((repo) => repo.toLowerCase()));
  async function collect(scope, read) {
    try {
      const rows = await read();
      if (!Array.isArray(rows) || rows.some((row) => typeof row?.repo !== 'string' || !REPO.test(row.repo)
        || !Number.isSafeInteger(row.number) || row.number <= 0
        || !['open', 'closed'].includes(row.state) || typeof row.draft !== 'boolean')) {
        throw new Error('invalid discovery response');
      }
      for (const row of rows) {
        if (row.state === 'closed') continue;
        const pr = `${row.repo.toLowerCase()}#${row.number}`;
        if (!candidates.has(pr)) {
          candidates.set(pr, { ...row, pr, source: explicit.has(row.repo.toLowerCase()) ? 'explicit' : 'search' });
        }
      }
    } catch (error) {
      errors.push({ scope, reason: error.message });
    }
  }
  for (const repo of profile.repos) await collect(repo, () => client.listOpenPulls(repo));
  if (profile.discoverByAuthor) {
    for (const author of profile.authors) await collect(author, () => client.searchOpenPulls(author));
  }
  return {
    prs: [...candidates.values()].map((pr) => ({ ...pr, ignored: scopeReasons(pr, profile) })),
    errors,
  };
}
