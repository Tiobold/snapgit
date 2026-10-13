import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGitHub } from './fake-github.js';
import { GitHub, GitHubError } from '../action/github.js';
import { createEngine } from '../action/engine.js';
import { runAction } from '../action/index.js';
import { normalizeOutcome } from '../web/lib/metrics.js';

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
let fake;
before(async () => { fake = await createFakeGitHub(); });
after(async () => { await fake.close(); });

/** A fresh PR on the fake, with an engine whose clock the test controls. */
async function scenario({ policy, pr: prOpts, open = true, ignoreChecks, ciGraceMs = 0 } = {}) {
  const f = await createFakeGitHub();
  const clock = { t: T0 };
  const gh = new GitHub({ token: 't', repo: f.repo, apiUrl: f.url });
  const engine = createEngine({ gh, now: () => clock.t, ignoreChecks, ciGraceMs });
  if (policy) f.setPolicy(policy);
  const pr = f.addPull(prOpts);
  if (open) await engine.onPullRequest(pr, 'opened');
  return { f, gh, engine, clock, pr, n: pr.number, close: () => f.close() };
}
const fuse1m = { fuse: { baseSec: 60, secPerLine: 0, minSec: 60, maxSec: 60 } };

test('a new PR goes on the clock: fuse sized to the change, ignored files uncounted, status comment written', async () => {
  const s = await scenario({
    policy: { fuse: { ignore: ['package-lock.json'] } },
    pr: { files: [{ filename: 'src/a.js', additions: 100, deletions: 0 }, { filename: 'package-lock.json', additions: 4000, deletions: 3 }] },
  });
  const st = s.f.state(s.n);
  assert.equal(st.lines, 100);
  assert.equal(st.ignoredLines, 4003);
  assert.equal(st.fuseMs, 60_000);
  assert.equal(st.expiresAt, T0 + 24 * 3600_000);
  assert.match(s.f.statusLine(s.n), /100 changed lines \(4003 more in ignored files\) = a 1m fuse/);
  assert.match(s.f.statusLine(s.n), /Waiting for CI/);
  await s.close();
});

test('draft PRs, and PRs from before the action, are left alone until labelled "snapgit"', async () => {
  const s = await scenario({ pr: { draft: true }, open: false });
  await s.engine.onPullRequest(s.pr, 'opened');
  assert.equal(s.f.state(s.n), null);
  s.pr.draft = false;
  await s.engine.onPullRequest(s.pr, 'labeled', 'bug');
  assert.equal(s.f.state(s.n), null);
  await s.engine.onPullRequest(s.pr, 'labeled', 'snapgit');
  assert.ok(s.f.state(s.n));
  await s.close();
});

test('opening: only reviewers, never the author, only once; it returns what to wait for', async () => {
  const s = await scenario({ policy: { reviewers: ['@alice'], ...fuse1m } });
  const open = (login) => s.engine.onComment(s.n, s.f.comment(s.n, login, '/snapgit open'));
  await open('bob');
  assert.match(s.f.lastBotText(s.n), /@bob only reviewers can do that \(reviewers: @alice\)/);
  await open('dev'); // the author
  assert.match(s.f.lastBotText(s.n), /you cannot review your own PR/);
  assert.equal(s.f.state(s.n).openedAt, undefined);

  const r = await open('alice');
  assert.deepEqual(r.waitFor, { number: s.n, dueAt: T0 + 60_000 });
  assert.equal(s.f.state(s.n).openedBy, 'alice');
  assert.match(s.f.statusLine(s.n), /Fuse lit by @alice/);
  const again = await open('alice');
  assert.equal(again.waitFor, undefined);
  assert.match(s.f.lastBotText(s.n), /already lit the fuse/);
  await s.close();
});

test('the fuse burns out and the PR merges with the policy merge method; branch, label and state follow', async () => {
  const s = await scenario({ policy: { mergeMethod: 'squash', ...fuse1m }, pr: { head: 'feat-x' } });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 59_000;
  assert.equal(await s.engine.settleOne(s.n), 'pending');
  assert.equal(s.f.db.merges.length, 0);
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'done');
  assert.equal(s.f.db.merges.length, 1);
  assert.equal(s.f.db.merges[0].merge_method, 'squash');
  assert.ok(s.f.db.labels.get(s.n).has('snapgit:merged'));
  assert.ok(!s.f.db.branches.has('feat-x'));
  assert.ok(s.f.state(s.n).merged.sha);
  assert.match(s.f.statusLine(s.n), /Merged as `merge1/);
  assert.equal(await s.engine.settleOne(s.n), 'none'); // closed now
  assert.equal(s.f.db.merges.length, 1);
  await s.close();
});

test('a halfway warning is posted once', async () => {
  const s = await scenario({ policy: fuse1m });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 31_000;
  await s.engine.settleOne(s.n);
  await s.engine.settleOne(s.n);
  assert.equal(s.f.botComments(s.n).filter((c) => !c.body.startsWith('<!--') && /Half the fuse/.test(c.body)).length, 1);
  await s.close();
});

test('reject: a reviewer comment or a "changes requested" review closes the PR; too late is too late', async () => {
  const s = await scenario({ policy: { reviewers: ['@alice', '@carol'], ...fuse1m } });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  await s.engine.onComment(s.n, s.f.comment(s.n, 'mallory', '/snapgit reject lol'));
  assert.match(s.f.lastBotText(s.n), /only reviewers/);
  assert.equal(s.f.db.pulls.get(s.n).state, 'open');
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit reject needs tests\nmore detail'));
  assert.equal(s.f.db.pulls.get(s.n).state, 'closed');
  assert.ok(s.f.db.labels.get(s.n).has('snapgit:rejected'));
  assert.deepEqual({ ...s.f.state(s.n).rejected, at: 0 }, { by: 'alice', at: 0, reason: 'needs tests' });
  await s.close();

  const r = await scenario({ policy: { reviewers: ['@alice', '@carol'], ...fuse1m } });
  await r.engine.onReview(r.n, { user: { login: 'carol', type: 'User' }, author_association: 'MEMBER', state: 'COMMENTED', body: '' });
  assert.equal(r.f.state(r.n).openedBy, 'carol'); // any review from a reviewer opens it
  await r.engine.onReview(r.n, { user: { login: 'carol', type: 'User' }, author_association: 'MEMBER', state: 'CHANGES_REQUESTED', body: 'nope' });
  assert.equal(r.f.db.pulls.get(r.n).state, 'closed');
  await r.close();

  const late = await scenario({ policy: fuse1m });
  await late.engine.onComment(late.n, late.f.comment(late.n, 'alice', '/snapgit open'));
  late.clock.t = T0 + 61_000;
  await late.engine.onComment(late.n, late.f.comment(late.n, 'alice', '/snapgit reject'));
  assert.match(late.f.lastBotText(late.n), /too late/);
  assert.equal(await late.engine.settleOne(late.n), 'done');
  assert.equal(late.f.db.merges.length, 1);
  await late.close();
});

test('the author can always withdraw their own PR, even when reviewers are restricted', async () => {
  const s = await scenario({ policy: { reviewers: ['@alice'], ...fuse1m } });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'dev', '/snapgit reject changed my mind'));
  assert.equal(s.f.db.pulls.get(s.n).state, 'closed');
  assert.equal(s.f.state(s.n).rejected.by, 'dev');
  await s.close();
});

test('a PR nobody opens is closed and its branch deleted when its lifetime ends', async () => {
  const s = await scenario({ policy: { ttlHours: 2, ...fuse1m }, pr: { head: 'lonely' } });
  s.clock.t = T0 + 3600_000;
  assert.equal(await s.engine.settleOne(s.n), 'pending');
  s.clock.t = T0 + 2 * 3600_000;
  assert.equal(await s.engine.settleOne(s.n), 'done');
  assert.equal(s.f.db.pulls.get(s.n).state, 'closed');
  assert.ok(s.f.db.labels.get(s.n).has('snapgit:expired'));
  assert.ok(!s.f.db.branches.has('lonely'));
  assert.equal(s.f.db.merges.length, 0);
  assert.match(s.f.lastBotText(s.n), /Nobody ever opened this PR/);
  await s.close();
});

test('failing CI shames the authors (agents flagged) straight away, before anyone has to look', async () => {
  const sha = 'a'.repeat(40);
  const s = await scenario({
    policy: fuse1m,
    pr: {
      head: 'ai-login', sha,
      commits: [{ author: { login: 'dev' }, commit: { message: 'ai: rewrite login\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>', author: { name: 'Dev', email: 'dev@example.com' } } }],
    },
  });
  s.f.setChecks(sha, { runs: [{ name: 'tests', status: 'completed', conclusion: 'failure', output: { summary: 'login() returned undefined' } }] });
  // Nobody opened it and no fuse was lit: validation alone condemns it.
  assert.equal(await s.engine.settleOne(s.n), 'done');
  const shame = s.f.botComments(s.n).find((c) => c.body.startsWith('😬')).body;
  assert.match(shame, /Shame on: Dev, Claude Sonnet \(agent\)/);
  assert.match(shame, /"tests" failed/);
  assert.match(shame, /@dev/);
  assert.match(shame, /login\(\) returned undefined/);
  assert.equal(s.f.db.pulls.get(s.n).state, 'closed');
  assert.ok(s.f.db.labels.get(s.n).has('snapgit:shamed'));
  assert.ok(!s.f.db.branches.has('ai-login'));
  assert.equal(s.f.db.merges.length, 0);
  assert.equal(s.f.state(s.n).openedAt, undefined);
  await s.close();
});

test('CI that goes red after the fuse was lit still shames at burn-out, and never merges', async () => {
  const sha = 'd'.repeat(40);
  const s = await scenario({ policy: fuse1m, pr: { sha, head: 'late-red' } });
  s.f.setChecks(sha, { runs: [{ name: 'tests', status: 'completed', conclusion: 'success' }] });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  assert.ok(s.f.state(s.n).openedAt);
  s.f.setChecks(sha, { runs: [{ name: 'tests', status: 'completed', conclusion: 'failure', output: { summary: 'flaky no more' } }] });
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'done');
  assert.equal(s.f.db.merges.length, 0);
  assert.ok(!s.f.db.branches.has('late-red'));
  await s.close();
});

test('review is locked until CI has run: no fuse while it is pending, and the bot says when it is ready', async () => {
  const sha = 'b'.repeat(40);
  const s = await scenario({ policy: { reviewers: ['@alice'], ...fuse1m }, pr: { sha } });
  s.f.setChecks(sha, { runs: [{ name: 'build', status: 'in_progress' }, { name: 'snapgit-wait', status: 'in_progress' }] });
  assert.match(s.f.statusLine(s.n), /Waiting for CI.*locked until validation passes/);

  const early = await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  assert.equal(early.waitFor, undefined);
  assert.equal(s.f.state(s.n).openedAt, undefined);
  assert.match(s.f.lastBotText(s.n), /not yet: CI is still running.*no fuse yet/);
  await s.engine.onReview(s.n, { user: { login: 'alice', type: 'User' }, author_association: 'MEMBER', state: 'COMMENTED', body: '' });
  assert.equal(s.f.state(s.n).openedAt, undefined); // a review cannot sneak past the lock either

  // CI finishes (snapgit's own running job is ignored): the check_suite event unlocks it, once.
  s.f.setChecks(sha, { runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'snapgit-wait', status: 'in_progress' }] });
  await s.engine.onChecks(sha);
  await s.engine.onChecks(sha);
  assert.ok(s.f.state(s.n).ciPassedAt);
  assert.equal(s.f.botComments(s.n).filter((c) => !c.body.startsWith('<!--') && /CI passed. This PR is ready for review/.test(c.body)).length, 1);
  assert.match(s.f.statusLine(s.n), /CI passed.*Waiting for a reviewer/);

  const r = await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  assert.ok(r.waitFor); // the fuse is lit only now
  assert.equal(s.f.state(s.n).openedAt, T0);
  await s.close();
});

test('rejecting is never locked: a reviewer can say no before CI has finished', async () => {
  const sha = 'e'.repeat(40);
  const s = await scenario({ policy: fuse1m, pr: { sha } });
  s.f.setChecks(sha, { runs: [{ name: 'build', status: 'in_progress' }] });
  await s.engine.onReview(s.n, { user: { login: 'alice', type: 'User' }, author_association: 'MEMBER', state: 'CHANGES_REQUESTED', body: 'wrong approach' });
  assert.equal(s.f.db.pulls.get(s.n).state, 'closed');
  await s.close();
});

test('right after a push "no checks yet" means CI has not started, not that there is none', async () => {
  const s = await scenario({ policy: fuse1m, ciGraceMs: 30_000 });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  assert.match(s.f.lastBotText(s.n), /CI has not started yet/);
  s.clock.t = T0 + 31_000;
  const r = await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  assert.ok(r.waitFor); // a repo with no CI at all is reviewable once the grace window passes
  await s.close();
});

test('while CI re-runs after the fuse was lit, the merge is held (said once) and lands when it passes', async () => {
  const sha = 'f'.repeat(40);
  const s = await scenario({ policy: fuse1m, pr: { sha } });
  s.f.setChecks(sha, { runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.f.setChecks(sha, { runs: [{ name: 'build', status: 'in_progress' }, { name: 'snapgit-wait', status: 'in_progress' }] });
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'held');
  assert.equal(await s.engine.settleOne(s.n), 'held');
  assert.equal(s.f.botComments(s.n).filter((c) => !c.body.startsWith('<!--') && /CI is still running/.test(c.body)).length, 1);
  s.f.setChecks(sha, { runs: [{ name: 'build', status: 'completed', conclusion: 'success' }, { name: 'snapgit-wait', status: 'in_progress' }] });
  assert.equal(await s.engine.settleOne(s.n), 'done');
  assert.equal(s.f.db.merges.length, 1);
  await s.close();
});

test('protected paths: held until a reviewer approves; unapproved at expiry they are deleted', async () => {
  const policy = { reviewers: ['@alice'], protectedPaths: ['auth/**'], ttlHours: 1, ...fuse1m };
  const files = [{ filename: 'auth/login.js', additions: 5, deletions: 1 }];
  const s = await scenario({ policy, pr: { files } });
  assert.equal(s.f.state(s.n).protected, true);
  assert.match(s.f.statusLine(s.n), /protected paths \(auth\/login.js\)/);
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'held');
  assert.match(s.f.lastBotText(s.n), /needs a reviewer to say `\/snapgit approve`/);
  await s.engine.onComment(s.n, s.f.comment(s.n, 'mallory', '/snapgit approve'));
  assert.equal(s.f.state(s.n).approvedBy, undefined);
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit approve'));
  assert.equal(await s.engine.settleOne(s.n), 'done');
  assert.equal(s.f.db.merges.length, 1);
  await s.close();

  const u = await scenario({ policy, pr: { files, head: 'sneaky' } });
  await u.engine.onComment(u.n, u.f.comment(u.n, 'alice', '/snapgit open'));
  u.clock.t = T0 + 3600_000;
  assert.equal(await u.engine.settleOne(u.n), 'done');
  assert.equal(u.f.db.merges.length, 0);
  assert.ok(!u.f.db.branches.has('sneaky'));
  assert.match(u.f.lastBotText(u.n), /no reviewer approved it, so it was deleted/);
  await u.close();

  const plain = await scenario({ policy: fuse1m });
  await plain.engine.onComment(plain.n, plain.f.comment(plain.n, 'alice', '/snapgit approve'));
  assert.match(plain.f.lastBotText(plain.n), /does not touch protected paths/);
  await plain.close();
});

test('new commits put the fuse out: a reviewer has to look again', async () => {
  const s = await scenario({ policy: fuse1m });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  assert.ok(s.f.state(s.n).ciPassedAt);
  s.clock.t = T0 + 30_000;
  s.pr.head.sha = 'c'.repeat(40);
  await s.engine.onPullRequest(s.pr, 'synchronize');
  const st = s.f.state(s.n);
  assert.equal(st.openedAt, undefined);
  assert.equal(st.ciPassedAt, undefined); // validated again before anyone can look
  assert.equal(st.headSha, 'c'.repeat(40));
  assert.match(s.f.lastBotText(s.n), /New commits arrived.*CI has to pass again/);
  s.clock.t = T0 + 90_000;
  assert.equal(await s.engine.settleOne(s.n), 'pending'); // not due: nobody re-opened it
  await s.close();
});

test('a refused merge (conflict or branch protection) is held with the reason, then lands when fixed', async () => {
  const s = await scenario({ policy: fuse1m });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
  s.f.db.mergeBehavior = { status: 405, message: 'Required status check "lint" is expected' };
  assert.equal(await s.engine.settleOne(s.n), 'held');
  assert.match(s.f.lastBotText(s.n), /GitHub refused the merge \(GitHub 405: Required status check "lint" is expected\)|Required status check/);
  s.f.db.mergeBehavior = null;
  assert.equal(await s.engine.settleOne(s.n), 'done');
  await s.close();
});

test('frozen: true in snapgit.json halts everything until it is removed', async () => {
  const s = await scenario({ policy: { frozen: true, ...fuse1m } });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'held');
  assert.match(s.f.lastBotText(s.n), /frozen/);
  assert.equal(s.f.db.merges.length, 0);
  s.f.setPolicy({ frozen: false, ...fuse1m });
  assert.equal(await s.engine.settleOne(s.n), 'done');
  await s.close();
});

test('a broken snapgit.json holds instead of guessing', async () => {
  const s = await scenario({ policy: fuse1m });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.f.setPolicy('{ nope');
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'held');
  assert.match(s.f.lastBotText(s.n), /snapgit.json on main is not valid JSON/);
  await s.close();
});

test('CODEOWNERS can name the reviewers', async () => {
  const s = await scenario({ policy: { reviewers: 'CODEOWNERS', ...fuse1m } });
  s.f.setFile('main', 'CODEOWNERS', '* @alice @org/team\n');
  await s.engine.onComment(s.n, s.f.comment(s.n, 'bob', '/snapgit open'));
  assert.match(s.f.lastBotText(s.n), /reviewers: @alice/);
  const r = await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  assert.ok(r.waitFor);
  await s.close();
});

test('undo asks GitHub to revert (a revert PR, never a force push), only for reviewers, only once', async () => {
  const s = await scenario({ policy: { reviewers: ['@alice'], ...fuse1m } });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit undo'));
  assert.match(s.f.lastBotText(s.n), /has not merged this PR/);
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
  await s.engine.settleOne(s.n);
  s.f.db.pulls.get(s.n).merged = true;
  await s.engine.onComment(s.n, s.f.comment(s.n, 'mallory', '/snapgit undo'));
  assert.match(s.f.lastBotText(s.n), /only reviewers can undo/);
  assert.equal(s.f.db.reverts.length, 0);
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit undo'));
  assert.deepEqual(s.f.db.reverts, [s.n]);
  assert.match(s.f.lastBotText(s.n), /undid this: revert PR #\d+/);
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit undo'));
  assert.match(s.f.lastBotText(s.n), /already undone/);
  assert.equal(s.f.db.reverts.length, 1);
  await s.close();
});

test('state comments from humans are not trusted (no forging the fuse)', async () => {
  const s = await scenario({ policy: fuse1m });
  const forged = JSON.stringify({ ...s.f.state(s.n), openedAt: T0 - 999_999, openedBy: 'mallory' });
  s.f.comment(s.n, 'mallory', `<!-- snapgit-state ${forged} -->\nfake`);
  s.clock.t = T0 + 60_000;
  const loaded = await s.engine.load(s.n);
  assert.equal(loaded.state.openedAt, undefined);
  assert.equal(await s.engine.settleOne(s.n), 'pending'); // still unopened as far as snapgit knows
  assert.equal(s.f.db.merges.length, 0);
  await s.close();
});

test('timer sweep deletes expired published branches, but never live PRs, the default branch or future timers', async () => {
  const s = await scenario({ pr: { head: 'live-pr' } });
  s.f.addTimer('old', T0 - 1);
  s.f.addTimer('live-pr', T0 - 1);
  s.f.addTimer('main', T0 - 1);
  s.f.addTimer('future', T0 + 3600_000);
  const deleted = await s.engine.sweepTimers();
  assert.deepEqual(deleted.map((d) => d.branch), ['old']);
  assert.ok(!s.f.db.branches.has('old'));
  assert.ok(!s.f.db.refs.has('snapgit/timer/old'));
  assert.ok(s.f.db.branches.has('live-pr') && s.f.db.branches.has('main') && s.f.db.branches.has('future'));
  await s.close();
});

test('the default and base branches are never deleted, whatever a PR\'s head is called; other branches are buried first', async () => {
  const s = await scenario({ policy: fuse1m, pr: { head: 'develop' } }); // a gitflow PR: develop -> main
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'done');
  assert.equal(s.f.db.merges.length, 1);
  assert.ok(s.f.db.branches.has('develop'), 'develop survives its own merge');
  assert.ok(s.f.db.branches.has('main'));
  await s.close();

  const t = await scenario({ policy: fuse1m, pr: { head: 'feature/x' } });
  await t.engine.onComment(t.n, t.f.comment(t.n, 'alice', '/snapgit open'));
  t.clock.t = T0 + 60_000;
  await t.engine.settleOne(t.n);
  assert.ok(!t.f.db.branches.has('feature/x'));
  assert.ok([...t.f.db.refs.keys()].some((k) => k.startsWith(`snapgit/graveyard/${T0 + 60_000}-feature/x`)), 'the tip was kept');
  await t.close();
});

test('the merge is bound to the reviewed commit: a branch that moved without an event resets the fuse', async () => {
  const s = await scenario({ policy: fuse1m });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.pr.head.sha = '9'.repeat(40); // a push whose event we never saw
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'pending');
  assert.equal(s.f.db.merges.length, 0);
  assert.equal(s.f.state(s.n).openedAt, undefined);
  assert.equal(s.f.state(s.n).headSha, '9'.repeat(40));
  assert.match(s.f.lastBotText(s.n), /branch moved after review/);
  await s.close();

  const ok = await scenario({ policy: fuse1m });
  await ok.engine.onComment(ok.n, ok.f.comment(ok.n, 'alice', '/snapgit open'));
  ok.clock.t = T0 + 60_000;
  await ok.engine.settleOne(ok.n);
  assert.equal(ok.f.db.merges[0].sha, ok.pr.head.sha); // and GitHub itself is told to refuse if it moves mid-merge
  await ok.close();
});

test('with no reviewers configured only repository members can act: a sock-puppet account cannot play reviewer', async () => {
  const s = await scenario({ policy: fuse1m });
  const r1 = await s.engine.onComment(s.n, s.f.comment(s.n, 'sockpuppet', '/snapgit open', 'NONE'));
  assert.equal(r1.waitFor, undefined);
  assert.match(s.f.lastBotText(s.n), /only repository members can do that/);
  await s.engine.onComment(s.n, s.f.comment(s.n, 'drive-by', '/snapgit reject', 'FIRST_TIME_CONTRIBUTOR'));
  assert.equal(s.f.db.pulls.get(s.n).state, 'open');
  const r2 = await s.engine.onComment(s.n, s.f.comment(s.n, 'colleague', '/snapgit open', 'COLLABORATOR'));
  assert.ok(r2.waitFor);
  await s.close();
});

test('an approval does not survive new commits, and requireChecks refuses "no checks" as validation', async () => {
  const policy = { protectedPaths: ['auth/**'], reviewers: ['@alice'], ...fuse1m };
  const s = await scenario({ policy, pr: { files: [{ filename: 'auth/x.js', additions: 3, deletions: 0 }] } });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit approve')); // approved before opening
  assert.equal(s.f.state(s.n).approvedBy, 'alice');
  s.pr.head.sha = '7'.repeat(40);
  await s.engine.onPullRequest(s.pr, 'synchronize');
  assert.equal(s.f.state(s.n).approvedBy, undefined);
  await s.close();

  const r = await scenario({ policy: { requireChecks: true, ...fuse1m } });
  const out = await r.engine.onComment(r.n, r.f.comment(r.n, 'alice', '/snapgit open'));
  assert.equal(out.waitFor, undefined);
  assert.match(r.f.lastBotText(r.n), /requires CI checks and none have run/);
  r.f.setChecks(r.pr.head.sha, { runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
  assert.ok((await r.engine.onComment(r.n, r.f.comment(r.n, 'alice', '/snapgit open'))).waitFor);
  await r.close();
});

test('too close to the deadline there is no review: the fuse would be cut short', async () => {
  const s = await scenario({ policy: { ttlHours: 1, ...fuse1m } });
  s.clock.t = T0 + 3600_000 - 30_000;
  const r = await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  assert.equal(r.waitFor, undefined);
  assert.match(s.f.lastBotText(s.n), /too late to review: 30s of lifetime left, but the fuse needs 1m/);
  await s.close();
});

test('a frozen repository deletes no expired branches either', async () => {
  const s = await scenario({ policy: { frozen: true } });
  s.f.addTimer('old', T0 - 1);
  assert.deepEqual(await s.engine.sweepTimers(), []);
  assert.ok(s.f.db.branches.has('old'));
  s.f.setPolicy({ frozen: false });
  assert.deepEqual((await s.engine.sweepTimers()).map((d) => d.branch), ['old']);
  assert.ok([...s.f.db.refs.keys()].some((k) => k.startsWith('snapgit/graveyard/')));
  await s.close();
});

test('settleAll settles every snapgit PR and ignores the rest', async () => {
  const s = await scenario({ policy: fuse1m });
  const plain = s.f.addPull({ head: 'untracked' }); // opened before the action existed: no state comment
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
  const r = await s.engine.settleAll();
  assert.deepEqual(r, { [s.n]: 'done' });
  assert.equal(s.f.db.pulls.get(plain.number).state, 'open');
  await s.close();
});

// ---------------------------------------------------------------- the REST client

test('client: pagination, 404s, errors with status, branch names with slashes, check aggregation', async () => {
  const f = await createFakeGitHub();
  const gh = new GitHub({ token: 't', repo: f.repo, apiUrl: f.url });
  const files = Array.from({ length: 250 }, (_, i) => ({ filename: `f${i}.js`, additions: 1, deletions: 0 }));
  const pr = f.addPull({ files, head: 'feature/deep/branch' });
  assert.equal((await gh.listFiles(pr.number)).length, 250);
  assert.equal(await gh.getFile('snapgit.json', 'main'), null);
  f.setFile('feature/x', 'dir/with space/a b.json', '{"ok":1}');
  assert.equal(await gh.getFile('dir/with space/a b.json', 'feature/x'), '{"ok":1}');
  await assert.rejects(gh.getPull(999), (e) => e instanceof GitHubError && e.status === 404);
  assert.equal(await gh.deleteRef('heads/feature/deep/branch'), true);
  assert.equal(await gh.deleteRef('heads/feature/deep/branch'), false);

  f.setChecks('s1', { runs: [{ name: 'a', status: 'completed', conclusion: 'success' }], statuses: [{ context: 'ci/x', state: 'success' }] });
  assert.equal((await gh.checkStatus('s1')).state, 'success');
  f.setChecks('s2', { runs: [{ name: 'a', status: 'completed', conclusion: 'timed_out' }], statuses: [{ context: 'ci/x', state: 'pending' }] });
  const bad = await gh.checkStatus('s2');
  assert.equal(bad.state, 'failure');
  assert.equal(bad.failing[0].name, 'a');
  // more than one page of check runs: a failure on page two is still found
  const many = Array.from({ length: 150 }, (_, i) => ({ name: `job${i}`, status: 'completed', conclusion: i === 149 ? 'failure' : 'success' }));
  f.setChecks('big', { runs: many });
  assert.equal((await gh.checkStatus('big')).failing[0].name, 'job149');
  f.setChecks('s3', { statuses: [{ context: 'ci/x', state: 'pending' }] });
  assert.equal((await gh.checkStatus('s3')).state, 'pending');
  assert.equal((await gh.checkStatus('nothing')).state, 'none');
  assert.equal((await gh.checkStatus('s3', ['ci/'])).state, 'none'); // ignored by prefix
  await f.close();
});

// ---------------------------------------------------------------- the Action entry point

function runEnv(f, event, payload, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'snapgit-action-'));
  const eventPath = join(dir, 'event.json');
  const outputPath = join(dir, 'output.txt');
  writeFileSync(eventPath, JSON.stringify(payload));
  writeFileSync(outputPath, '');
  return { env: { GITHUB_REPOSITORY: f.repo, GITHUB_API_URL: f.url, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, INPUT_TOKEN: 't', 'INPUT_CI-GRACE-SECONDS': '0', 'INPUT_MAX-WAIT': '30', ...extra }, outputPath };
}

test('action: events drive the engine, a fuse is handed to the wait job, and the wait job merges when it burns out', async () => {
  const f = await createFakeGitHub();
  f.setPolicy({ reviewers: ['@alice'], fuse: { baseSec: 1, secPerLine: 0, minSec: 1, maxSec: 1 } });
  const pr = f.addPull({ head: 'wait-me' });
  const quiet = { out: () => {} };

  let r = runEnv(f, 'pull_request_target', { action: 'opened', pull_request: pr });
  await runAction(r.env, quiet);
  assert.ok(f.state(pr.number));
  assert.match(readFileSync(r.outputPath, 'utf8'), /wait-pr=\n/);

  const c = f.comment(pr.number, 'alice', '/snapgit open');
  r = runEnv(f, 'issue_comment', { action: 'created', issue: { number: pr.number, pull_request: {} }, comment: c });
  const { waitFor } = await runAction(r.env, quiet);
  assert.equal(waitFor.number, pr.number);
  assert.match(readFileSync(r.outputPath, 'utf8'), new RegExp(`wait-pr=${pr.number}\\nwait-until=\\d+`));

  r = runEnv(f, 'issue_comment', {}, { INPUT_MODE: 'wait', INPUT_PR: String(pr.number), 'INPUT_POLL-SECONDS': '1', INPUT_POLL_SECONDS: '1' });
  const t0 = Date.now();
  await runAction(r.env, quiet);
  assert.ok(Date.now() - t0 >= 900, 'it actually waited for the fuse');
  assert.equal(f.db.merges.length, 1);
  assert.ok(!f.db.branches.has('wait-me'));
  await f.close();
});

test('action: a finished CI run (check_suite) shames or unlocks its PR immediately', async () => {
  const f = await createFakeGitHub();
  const quiet = { out: () => {} };
  const sha = '1'.repeat(40);
  const pr = f.addPull({ head: 'ci-red', sha });
  const env = { INPUT_CI_GRACE_SECONDS: '0', 'INPUT_CI-GRACE-SECONDS': '0' };
  await runAction({ ...runEnv(f, 'pull_request', { action: 'opened', pull_request: pr }).env, ...env }, quiet);
  f.setChecks(sha, { runs: [{ name: 'tests', status: 'completed', conclusion: 'failure', output: { summary: 'boom' } }] });
  await runAction({ ...runEnv(f, 'check_suite', { action: 'completed', check_suite: { head_sha: sha } }).env, ...env }, quiet);
  assert.equal(f.db.pulls.get(pr.number).state, 'closed');
  assert.ok(!f.db.branches.has('ci-red'));
  assert.ok(f.db.labels.get(pr.number).has('snapgit:shamed'));
  await f.close();
});

test('action: scheduled runs settle everything and sweep expired timers; reviews and non-PR comments are routed', async () => {
  const f = await createFakeGitHub();
  f.setPolicy({ fuse: { baseSec: 1, secPerLine: 0, minSec: 1, maxSec: 1 }, ttlHours: 1 });
  const pr = f.addPull({ head: 'sched' });
  const quiet = { out: () => {} };
  await runAction(runEnv(f, 'pull_request', { action: 'opened', pull_request: pr }).env, quiet);
  f.addTimer('stale', Date.now() - 1000);

  const review = runEnv(f, 'pull_request_review', { action: 'submitted', pull_request: pr, review: { user: { login: 'carol', type: 'User' }, author_association: 'MEMBER', state: 'approved', body: '' } });
  const res = await runAction(review.env, quiet);
  assert.equal(res.waitFor.number, pr.number);

  const lines = [];
  await runAction(runEnv(f, 'schedule', {}, { SNAPGIT_NOW: String(Date.now() + 5000) }).env, { out: (l) => lines.push(l) });
  assert.equal(f.db.merges.length, 1);
  assert.ok(!f.db.branches.has('stale'));
  assert.match(lines.join('\n'), /settled 1 PR\(s\); deleted 1 expired branch/);

  // A comment on a plain issue (not a PR) is ignored.
  const issueEvent = runEnv(f, 'issue_comment', { action: 'created', issue: { number: 99 }, comment: { body: '/snapgit open', user: { login: 'alice', type: 'User' }, author_association: 'MEMBER' } });
  assert.equal((await runAction(issueEvent.env, quiet)).waitFor, null);
  await f.close();
});

// ---------------------------------------------------------------- metrics outcomes

const outcomesOf = (f, branch = 'snapgit-metrics') => JSON.parse(f.db.contents.get(`${branch}:outcomes.json`) ?? '[]');

test('metrics: every ending is written to snapgit-metrics, with timings, size, team and agent flag but no person', async () => {
  const s = await scenario({
    policy: { teams: { platform: ['@dev'] }, ...fuse1m },
    pr: { head: 'feat-m', title: 'Secret project title', commits: [{ author: { login: 'dev' }, commit: { message: 'ai\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>', author: { name: 'Dev', email: 'dev@example.com' } } }] },
  });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
  await s.engine.settleOne(s.n);
  const [o] = outcomesOf(s.f);
  assert.equal(o.id, `gh-${s.n}`);
  assert.deepEqual([o.kind, o.src, o.team, o.agent, o.undone], ['merged', 'gh', 'platform', true, false]);
  assert.deepEqual([o.createdAt, o.openedAt, o.settledAt, o.fuseMs, o.lines], [T0, T0, T0 + 60_000, 60_000, 10]);
  assert.doesNotMatch(JSON.stringify(o), /dev|alice|Secret|feat-m/);
  assert.ok(normalizeOutcome(o), 'the dashboard can read what the Action writes');
  await s.close();
});

test('metrics: rejected, withdrawn, expired and shamed PRs each leave the right outcome; undo flips the flag', async () => {
  const f = await createFakeGitHub();
  const clock = { t: T0 };
  const engine = createEngine({ gh: new GitHub({ token: 't', repo: f.repo, apiUrl: f.url }), now: () => clock.t, ciGraceMs: 0 });
  f.setPolicy({ ttlHours: 1, reviewers: ['@alice'], ...fuse1m });
  const mk = async (opts) => { const pr = f.addPull(opts); await engine.onPullRequest(pr, 'opened'); return pr; };

  const rejected = await mk({ head: 'r' });
  await engine.onComment(rejected.number, f.comment(rejected.number, 'alice', '/snapgit reject nope'));
  const withdrawn = await mk({ head: 'w' });
  await engine.onComment(withdrawn.number, f.comment(withdrawn.number, 'dev', '/snapgit reject never mind'));
  const expired = await mk({ head: 'e' });
  const shamedSha = 's'.repeat(40);
  const shamed = await mk({ head: 'sh', sha: shamedSha });
  f.setChecks(shamedSha, { runs: [{ name: 'tests', status: 'completed', conclusion: 'failure' }] });
  await engine.settleOne(shamed.number);
  clock.t = T0 + 3600_000;
  await engine.settleOne(expired.number);

  const kinds = Object.fromEntries(outcomesOf(f).map((o) => [o.id, o.kind]));
  assert.deepEqual(kinds, { [`gh-${rejected.number}`]: 'rejected', [`gh-${withdrawn.number}`]: 'withdrawn', [`gh-${shamed.number}`]: 'shamed', [`gh-${expired.number}`]: 'expired' });

  const merged = await mk({ head: 'm' });
  await engine.onComment(merged.number, f.comment(merged.number, 'alice', '/snapgit open'));
  clock.t += 60_000;
  await engine.settleOne(merged.number);
  await engine.onComment(merged.number, f.comment(merged.number, 'alice', '/snapgit undo'));
  assert.equal(outcomesOf(f).find((o) => o.id === `gh-${merged.number}`).undone, true);
  await f.close();
});

test('metrics: two jobs finishing at once do not lose an outcome (optimistic concurrency retries)', async () => {
  const s = await scenario({ policy: fuse1m });
  const second = s.f.addPull({ head: 'second' });
  await s.engine.onPullRequest(second, 'opened');
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  await s.engine.onComment(second.number, s.f.comment(second.number, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
  await s.engine.settleOne(s.n);
  s.f.db.failNextPut = true; // the next write loses a race
  await s.engine.settleOne(second.number);
  assert.deepEqual(outcomesOf(s.f).map((o) => o.id).sort(), [`gh-${s.n}`, `gh-${second.number}`].sort());
  await s.close();
});

test('metrics are a bystander: a broken metrics store never blocks a merge, and "none" turns them off', async () => {
  const s = await scenario({ policy: fuse1m });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.f.db.branches.add('snapgit-metrics');
  s.f.db.failAllPuts = true;
  s.clock.t = T0 + 60_000;
  assert.equal(await s.engine.settleOne(s.n), 'done');
  assert.equal(s.f.db.merges.length, 1);
  await s.close();

  const f = await createFakeGitHub();
  const clock = { t: T0 };
  const off = createEngine({ gh: new GitHub({ token: 't', repo: f.repo, apiUrl: f.url }), now: () => clock.t, ciGraceMs: 0, metricsBranch: '' });
  f.setPolicy(fuse1m);
  const pr = f.addPull();
  await off.onPullRequest(pr, 'opened');
  await off.onComment(pr.number, f.comment(pr.number, 'alice', '/snapgit open'));
  clock.t += 60_000;
  await off.settleOne(pr.number);
  assert.ok(!f.db.branches.has('snapgit-metrics'));
  await f.close();
});

test('metrics: the metrics-branch input names the branch, and "none" disables it', async () => {
  const f = await createFakeGitHub();
  f.setPolicy({ fuse: { baseSec: 1, secPerLine: 0, minSec: 1, maxSec: 1 } });
  const pr = f.addPull({ head: 'x' });
  const quiet = { out: () => {} };
  const base = { 'INPUT_CI-GRACE-SECONDS': '0' };
  await runAction({ ...runEnv(f, 'pull_request', { action: 'opened', pull_request: pr }).env, ...base }, quiet);
  const c = f.comment(pr.number, 'alice', '/snapgit open');
  await runAction({ ...runEnv(f, 'issue_comment', { action: 'created', issue: { number: pr.number, pull_request: {} }, comment: c }).env, ...base }, quiet);
  await runAction({ ...runEnv(f, 'schedule', {}, { SNAPGIT_NOW: String(Date.now() + 5000), 'INPUT_METRICS-BRANCH': 'team-metrics' }).env, ...base }, quiet);
  assert.equal(outcomesOf(f, 'team-metrics').length, 1);
  assert.ok(!f.db.branches.has('snapgit-metrics'));
  await f.close();
});
