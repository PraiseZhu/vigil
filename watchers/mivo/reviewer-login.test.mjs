import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePublicReview, isReviewerAuthor, isReviewerCleanReport, reviewerFindingReviewIds, reviewerReport, toAuthorLogin } from './bin/public-review.mjs';
import { feedbackItems } from './bin/mivo-watcher.mjs';
import { REVIEWER_BOT_LOGIN } from './bin/mivo-identity.mjs';

// The review flow may submit as the configured account or as the review App's bot account. REST names the bot
// `<app>[bot]`; GraphQL's Bot.login has no suffix and only __typename tells it is a bot.
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const PERSON = { login: 'ExampleReviewer', __typename: 'User' };          // test.env MIVO_WATCHER_REVIEWER_LOGIN
const BOT_GRAPHQL = { login: REVIEWER_BOT_LOGIN.replace(/\[bot\]$/, ''), __typename: 'Bot' };
const BOT_REST = { login: REVIEWER_BOT_LOGIN, type: 'Bot' };
const header = `> Mivo 自动审查 · [PR](https://example.invalid/pull/10) · head \`${HEAD.slice(0, 12)}\` · base \`${BASE.slice(0, 12)}\` · diffHash \`0123456789ab\` · 档位 standard`;
const cleanBody = `${header}\n## Findings\n无。\n\n## Overall\npass —— 没有 P0/P1。`;
const findingsBody = `${header}\n## Findings\n- [P1] src/a.ts:3 — 事实：……\n\n## Overall\nchanges-requested —— 1 条 P0/P1。\n\n<!-- review-pr:findings head=${HEAD} digest=${'c'.repeat(64)} -->`;
const review = (author, extra = {}) => ({ id: 'R1', author, state: 'APPROVED', submittedAt: '2026-09-10T00:10:00Z', commit: { oid: HEAD }, body: cleanBody, ...extra });

const accepted = [['the configured account', PERSON], ['the bot as GraphQL names it (Bot, no suffix)', BOT_GRAPHQL],
  ['the bot as REST names it (suffix, type Bot)', BOT_REST], ['the bot login with the suffix and no type', { login: REVIEWER_BOT_LOGIN }],
  ['the configured account in other letter case', { login: 'examplereviewer' }], ['a bare login string', 'ExampleReviewer']];
const refused = [['another user', { login: 'someone-else', __typename: 'User' }],
  ['another bot, GraphQL form', { login: 'dependabot', __typename: 'Bot' }], ['another bot, REST form', { login: 'dependabot[bot]', type: 'Bot' }],
  ['a person who is called like the App (User, not Bot)', { login: BOT_GRAPHQL.login, __typename: 'User' }],
  ['the App name without the suffix and no type', { login: BOT_GRAPHQL.login }], ['an empty login', { login: '' }], ['no author', null], ['no author at all', undefined]];

for (const [name, author] of accepted) test(`reviewer author: ${name} is accepted`, () => assert.equal(isReviewerAuthor(author), true));
for (const [name, author] of refused) test(`reviewer author: ${name} is refused`, () => assert.equal(isReviewerAuthor(author), false));

test('toAuthorLogin adds [bot] only to a Bot', () => {
  assert.equal(toAuthorLogin(BOT_GRAPHQL), REVIEWER_BOT_LOGIN);
  assert.equal(toAuthorLogin(BOT_REST), REVIEWER_BOT_LOGIN);
  assert.equal(toAuthorLogin({ login: 'x', __typename: 'User' }), 'x');
  assert.equal(toAuthorLogin({ login: 'x[bot]', __typename: 'Bot' }), 'x[bot]');
  assert.equal(toAuthorLogin(null), '');
});

test('a review from either identity is parsed as the reviewer report; anyone else is not', () => {
  for (const [, author] of accepted.slice(0, 3)) {
    const report = reviewerReport(review(author));
    assert.equal(report?.overall, 'pass');
    assert.equal(isReviewerCleanReport(review(author)), true);
  }
  for (const [, author] of refused) {
    assert.equal(reviewerReport(review(author)), null);
    assert.equal(isReviewerCleanReport(review(author)), false);
  }
});

test('findings reviews of either identity are found; a lookalike person\'s are not', () => {
  const ids = reviewerFindingReviewIds([review(PERSON, { id: 'R_p', state: 'COMMENTED', body: findingsBody }),
    review(BOT_GRAPHQL, { id: 'R_b', state: 'COMMENTED', body: findingsBody }),
    review({ login: BOT_GRAPHQL.login, __typename: 'User' }, { id: 'R_fake', state: 'COMMENTED', body: findingsBody })]);
  assert.deepEqual([...ids].sort(), ['R_b', 'R_p']);
});

function readyFixture(author) {
  return { snapshot: { pr: { state: 'OPEN', isDraft: false, sameRepository: true, number: 10, headRefOid: HEAD, baseRefOid: BASE, baseRefName: 'main',
      releaseEpoch: 'ready:2026-09-10T00:00:00Z', author: { login: 'owner' }, mergeStateStatus: 'CLEAN' },
    comments: [], requiredChecksGreen: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', threads: [], reviews: [review(author)], labels: [] },
  checks: [{ id: 5, name: 'review-pr', app: { id: 15368, slug: 'github-actions' }, head_sha: HEAD, status: 'completed', conclusion: 'success',
    started_at: '2026-09-10T00:05:00Z', external_id: 'https://github.com/example-org/example-plugin/actions/runs/3',
    details_url: 'https://github.com/example-org/example-plugin/runs/5' }],
  runs: { 3: { id: 3, path: '.github/workflows/review-pr.yml', event: 'workflow_dispatch', repository: { full_name: 'example-org/example-plugin' } } } };
}

test('merge-ready accepts the clean report of either identity and not that of another account', () => {
  for (const author of [PERSON, BOT_GRAPHQL, BOT_REST]) assert.equal(evaluatePublicReview(readyFixture(author)).ready, true, JSON.stringify(author));
  for (const author of [{ login: 'someone-else', __typename: 'User' }, { login: BOT_GRAPHQL.login, __typename: 'User' }]) {
    const verdict = evaluatePublicReview(readyFixture(author));
    assert.equal(verdict.ready, false);
    assert.equal(verdict.reason, 'review-report-missing');
  }
});

test('feedback: findings threads of either identity carry code authority, other authors\' threads are plain threads', () => {
  const pr = { id: 'PR_1', number: 10, state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefOid: BASE, author: { login: 'owner' } };
  const finding = (author) => review(author, { id: 'R_find', state: 'COMMENTED', body: findingsBody });
  const thread = (id, author) => ({ id, isResolved: false, isOutdated: false, path: 'src/a.ts',
    comments: [{ id: `C_${id}`, body: '[P1] 事实：空指针', author, createdAt: '2026-09-10T00:01:00Z', pullRequestReview: { id: 'R_find' } }] });
  for (const author of [PERSON, BOT_GRAPHQL]) {
    const items = feedbackItems({ pr, reviews: [finding(author)], threads: [thread('T1', author), thread('T2', { login: 'someone-else', __typename: 'User' }),
      thread('T3', { login: BOT_GRAPHQL.login, __typename: 'User' })] });
    const byId = (id) => items.find((item) => item.threadId === id);
    assert.equal(byId('T1').source, 'mivo-review', JSON.stringify(author));
    assert.equal(byId('T1').repairPolicy.canChangeCode, true);
    assert.equal(byId('T2').source, 'thread');
    assert.equal(byId('T3').source, 'thread', 'a User with the App\'s name is not the App');
  }
});
