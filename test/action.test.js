import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGitHub } from './fake-github.js';
import { GitHub, GitHubError } from '../action/github.js';
import { createEngine } from '../action/engine.js';
import { runAction } from '../action/index.js';

const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
let fake;
before(async () => { fake = await createFakeGitHub(); });
after(async () => { await fake.close(); });

/** A fresh PR on the fake, with an engine whose clock the test controls. */
async function scenario({ policy, pr: prOpts, open = true, ignoreChecks } = {}) {
  const f = await createFakeGitHub();
  const clock = { t: T0 };
  const gh = new GitHub({ token: 't', repo: f.repo, apiUrl: f.url });
  const engine = createEngine({ gh, now: () => clock.t, ignoreChecks });
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
  assert.match(s.f.statusLine(s.n), /\/snapgit open/);
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
  await r.engine.onReview(r.n, { user: { login: 'carol', type: 'User' }, state: 'COMMENTED', body: '' });
  assert.equal(r.f.state(r.n).openedBy, 'carol'); // any review from a reviewer opens it
  await r.engine.onReview(r.n, { user: { login: 'carol', type: 'User' }, state: 'CHANGES_REQUESTED', body: 'nope' });
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

test('failing CI shames the authors (agents flagged), closes the PR and deletes the branch', async () => {
  const s = await scenario({
    policy: fuse1m,
    pr: {
      head: 'ai-login', sha: 'a'.repeat(40),
      commits: [{ author: { login: 'dev' }, commit: { message: 'ai: rewrite login\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>', author: { name: 'Dev', email: 'dev@example.com' } } }],
    },
  });
  s.f.setChecks('a'.repeat(40), { runs: [{ name: 'tests', status: 'completed', conclusion: 'failure', output: { summary: 'login() returned undefined' } }] });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
  s.clock.t = T0 + 60_000;
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
  await s.close();
});

test('CI still running holds the merge (once) and merging resumes when it passes; snapgit ignores its own jobs', async () => {
  const sha = 'b'.repeat(40);
  const s = await scenario({ policy: fuse1m, pr: { sha } });
  s.f.setChecks(sha, { runs: [{ name: 'build', status: 'in_progress' }, { name: 'snapgit-wait', status: 'in_progress' }] });
  await s.engine.onComment(s.n, s.f.comment(s.n, 'alice', '/snapgit open'));
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
  s.clock.t = T0 + 30_000;
  s.pr.head.sha = 'c'.repeat(40);
  await s.engine.onPullRequest(s.pr, 'synchronize');
  const st = s.f.state(s.n);
  assert.equal(st.openedAt, undefined);
  assert.equal(st.headSha, 'c'.repeat(40));
  assert.match(s.f.lastBotText(s.n), /New commits arrived/);
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
  return { env: { GITHUB_REPOSITORY: f.repo, GITHUB_API_URL: f.url, GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: outputPath, INPUT_TOKEN: 't', ...extra }, outputPath };
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

test('action: scheduled runs settle everything and sweep expired timers; reviews and non-PR comments are routed', async () => {
  const f = await createFakeGitHub();
  f.setPolicy({ fuse: { baseSec: 1, secPerLine: 0, minSec: 1, maxSec: 1 }, ttlHours: 1 });
  const pr = f.addPull({ head: 'sched' });
  const quiet = { out: () => {} };
  await runAction(runEnv(f, 'pull_request', { action: 'opened', pull_request: pr }).env, quiet);
  f.addTimer('stale', Date.now() - 1000);

  const review = runEnv(f, 'pull_request_review', { action: 'submitted', pull_request: pr, review: { user: { login: 'carol', type: 'User' }, state: 'approved', body: '' } });
  const res = await runAction(review.env, quiet);
  assert.equal(res.waitFor.number, pr.number);

  const lines = [];
  await runAction(runEnv(f, 'schedule', {}, { SNAPGIT_NOW: String(Date.now() + 5000) }).env, { out: (l) => lines.push(l) });
  assert.equal(f.db.merges.length, 1);
  assert.ok(!f.db.branches.has('stale'));
  assert.match(lines.join('\n'), /settled 1 PR\(s\); deleted 1 expired branch/);

  // A comment on a plain issue (not a PR) is ignored.
  const issueEvent = runEnv(f, 'issue_comment', { action: 'created', issue: { number: 99 }, comment: { body: '/snapgit open', user: { login: 'alice', type: 'User' } } });
  assert.equal((await runAction(issueEvent.env, quiet)).waitFor, null);
  await f.close();
});
