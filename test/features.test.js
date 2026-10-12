import { test } from 'node:test';

// These tests drive checks and notifiers through a unix shell (cat, test -f, ...). Windows CI skips them.
const UNIX = { skip: process.platform === 'win32' ? 'needs a unix shell' : false };
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegExp, matchesAny } from '../src/glob.js';
import { parsePolicy } from '../src/policy.js';
import { fuseFromFiles } from '../src/fuse.js';
import { parseIdent, matchesReviewer, isReviewer, parseCodeowners } from '../src/authz.js';
import { T0, HOUR, sh, git, snap, repo, commit, branches, mainHas, featureRepo, sendId, openIt, remotes, writePolicy, BIN } from './helpers.js';

const PROP = { SNAPGIT_FUSE_MS: '' };
const FUSE_DONE = T0 + 61_000;

// ---------------------------------------------------------------- pure units

test('glob: gitignore-style matching', () => {
  const yes = (p, f) => assert.ok(matchesAny(f, [p]), `${p} should match ${f}`);
  const no = (p, f) => assert.ok(!matchesAny(f, [p]), `${p} should not match ${f}`);
  yes('package-lock.json', 'package-lock.json');
  yes('package-lock.json', 'web/package-lock.json');
  yes('*.lock', 'yarn.lock');
  yes('*.lock', 'a/b/Cargo.lock');
  yes('migrations/**', 'migrations/001.sql');
  no('migrations/**', 'app/migrations/001.sql'); // a slash anchors the pattern to the root
  yes('dist/', 'dist/x.js');
  yes('dist/', 'app/dist/x.js');
  yes('**/*.generated.*', 'a/b/c.generated.ts');
  yes('docs/**/*.md', 'docs/a/b/c.md');
  no('docs/**/*.md', 'src/docs/a.md');
  yes('auth/**', 'auth/login.js');
  no('auth/**', 'author.js');
  yes('?.txt', 'a.txt');
  no('?.txt', 'ab.txt');
  assert.ok(globToRegExp('x').test('x'));
});

test('policy: parses, defaults, and rejects nonsense loudly', () => {
  const p = parsePolicy('{"checks":[{"run":"x"}],"reviewers":"CODEOWNERS","protectedPaths":["auth/**"],"fuse":{"ignore":["*.lock"]}}');
  assert.equal(p.checks[0].name, 'check 1');
  assert.equal(p.mergeMethod, 'merge');
  assert.equal(p.ttlHours, 24);
  assert.equal(p.reviewers, 'CODEOWNERS');
  for (const [bad, msg] of [
    ['{ nope', /is not valid JSON/], ['[]', /must be a JSON object/],
    ['{"checks":[{}]}', /checks/], ['{"fuse":{"baseSec":-1}}', /fuse.baseSec/],
    ['{"fuse":{"weights":[{"glob":"x"}]}}', /weights/], ['{"reviewers":[1]}', /reviewers/],
    ['{"mergeMethod":"yolo"}', /mergeMethod/], ['{"ttlHours":0}', /ttlHours/], ['{"protectedPaths":"x"}', /protectedPaths/],
  ]) assert.throws(() => parsePolicy(bad, 'main'), msg, bad);
});

test('fuse: proportional, with ignores and weights', () => {
  const files = [{ path: 'src/a.js', lines: 100 }, { path: 'package-lock.json', lines: 5000 }, { path: 'migrations/1.sql', lines: 20 }, { path: 'README.md', lines: 40 }];
  assert.equal(fuseFromFiles([{ path: 'a', lines: 100 }]).fuseMs, 60_000);
  assert.equal(fuseFromFiles([{ path: 'a', lines: 1 }]).fuseMs, 15_000);
  assert.equal(fuseFromFiles([{ path: 'a', lines: 30000 }]).fuseMs, 3_600_000);
  const r = fuseFromFiles(files, { ignore: ['package-lock.json'], weights: [{ glob: 'migrations/**', multiplier: 3 }, { glob: '*.md', multiplier: 0.25 }] });
  assert.equal(r.lines, 100 + 60 + 10);
  assert.equal(r.rawLines, 5160);
  assert.equal(r.ignoredLines, 5000);
  assert.deepEqual(r.ignoredFiles, ['package-lock.json']);
  assert.equal(r.fuseMs, (10 + 170 * 0.5) * 1000);
  assert.equal(fuseFromFiles(files, { maxSec: 20 }, { maxSec: 30 }).fuseMs, 30_000); // overrides win
});

test('authz: identities, reviewers, CODEOWNERS', () => {
  assert.deepEqual(parseIdent('Ada <ada@x.io>'), { name: 'Ada', email: 'ada@x.io', login: null });
  assert.equal(parseIdent('octo <12345+Octo@users.noreply.github.com>').login, 'octo');
  assert.ok(matchesReviewer('Ada <ada@x.io>', 'ADA@x.io'));
  assert.ok(matchesReviewer('octo <octo@users.noreply.github.com>', '@Octo'));
  assert.ok(!matchesReviewer('Mallory <m@x.io>', 'ada@x.io'));
  assert.ok(isReviewer('anyone <a@b.c>', null));
  assert.ok(!isReviewer('Mallory <m@x.io>', ['ada@x.io']));
  assert.deepEqual(parseCodeowners('# c\n* @alice bob@x.io\n/docs/ @org/team @carol # trailing\n').sort(), ['@alice', '@carol', 'bob@x.io']);
});

// ---------------------------------------------------------------- fuse sizing in the CLI

test('policy fuse ignores lockfiles and weights paths; send reports what it counted', () => {
  const dir = featureRepo({ 'package-lock.json': 'x\n'.repeat(1000), 'src/a.js': 'y\n'.repeat(10) });
  writePolicy(dir, { fuse: { ignore: ['package-lock.json'] } });
  const r = snap(dir, ['pr', 'send', '--ttl', '1h'], T0, PROP);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /10 changed lines \(1000 more in ignored files\) = a 15s fuse/);
});

// ---------------------------------------------------------------- reviewers

function reviewerSetup() {
  return remotes({ setup: (sender) => writePolicy(sender, { reviewers: ['alice@example.com'] }) });
}

test('reviewers: only listed people can open or reject, and nobody reviews their own PR', () => {
  const { sender, clone } = reviewerSetup();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const alice = clone('Alice');
  const bob = clone('Bob');
  assert.match(snap(bob, ['pr', 'open', id, '--screenshot']).stderr, /you are not a reviewer here \(reviewers: alice@example.com\)/);
  assert.match(snap(bob, ['pr', 'reject', id, '-r', 'origin']).stderr, /not a reviewer/);
  assert.match(snap(sender, ['pr', 'open', id, '-r', 'origin', '--screenshot']).stderr, /not a reviewer/);
  assert.equal(snap(alice, ['pr', 'open', id, '--screenshot']).status, 0);
  // The author can always withdraw their own PR by rejecting it.
  assert.equal(snap(sender, ['pr', 'reject', id, '-r', 'origin', '-m', 'changed my mind']).status, 0);
});

test('reviewers: a squatter receipt and a forged rejection are ignored by the sender', UNIX, () => {
  const { bare, sender, clone } = reviewerSetup();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const alice = clone('Alice');
  const mallory = clone('Mallory');
  const forge = (name, obj) => {
    const blob = sh(mallory, 'git', ['hash-object', '-w', '--stdin'], {});
    const r = sh(mallory, 'sh', ['-c', `printf '%s' '${JSON.stringify(obj)}' | git hash-object -w --stdin`]);
    git(mallory, 'push', '-q', 'origin', `${r.stdout.trim()}:refs/snapgit/${name}/${id}`);
    return blob;
  };
  forge('receipt', { id, title: 't', sender: 'x', opener: 'Mallory <mallory@example.com>', openedAt: T0, screenshot: false });
  forge('reject', { id, rejector: 'Mallory <mallory@example.com>', rejectedAt: T0, reason: 'lol' });

  // Mallory's squatting receipt does not lock Alice out: hers replaces it.
  const opened = snap(alice, ['pr', 'open', id, '--screenshot'], T0 + 1000);
  assert.equal(opened.status, 0, opened.stderr);
  // After Alice's fuse the sender merges: Mallory's "rejection" is not a reviewer's, so it does not count.
  const swept = snap(sender, ['sweep', '--remote', 'origin'], T0 + 1000 + 61_000);
  assert.match(swept.stdout, /merged into main/);
  assert.ok(mainHas(sender, 'f.txt'));
  assert.equal(git(bare, 'ls-remote', '.', 'refs/snapgit/pr/*'), '');
});

test('reviewers: "CODEOWNERS" resolves owners from the base branch', () => {
  const { sender, clone } = remotes({
    setup: (s) => { writeFileSync(join(s, 'CODEOWNERS'), '* @alice carol@example.com\n'); git(s, 'switch', '-q', 'main'); git(s, 'add', '.'); git(s, 'commit', '-qm', 'owners'); writePolicy(s, { reviewers: 'CODEOWNERS' }, { branch: 'main' }); git(s, 'switch', '-q', 'feat'); },
  });
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  assert.match(snap(clone('Bob'), ['pr', 'open', id, '--screenshot']).stderr, /reviewers: @alice, carol@example.com/);
  const carol = clone('Carol');
  assert.equal(snap(carol, ['pr', 'open', id, '--screenshot']).status, 0);
  assert.match(snap(sender, ['policy']).stdout, /"@alice"/);
});

// ---------------------------------------------------------------- protected paths

test('protected paths: silence is not consent; a reviewer must approve', () => {
  const { sender, clone } = remotes({
    sender: featureRepo({ 'auth/login.js': 'secret\n' }),
    setup: (s) => writePolicy(s, { reviewers: ['alice@example.com'], protectedPaths: ['auth/**'] }),
  });
  const sent = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '5h']);
  assert.match(sent.stdout, /touches protected paths \(auth\/login.js\)/);
  const id = sent.stdout.match(/id ([0-9a-f]{8})/)[1];
  const alice = clone('Alice');
  const bob = clone('Bob');
  openIt(alice, id);
  const held = snap(sender, ['sweep', '--remote', 'origin'], FUSE_DONE);
  assert.match(held.stdout, /is held: touches protected paths.*needs snapgit pr approve/);
  assert.ok(!mainHas(sender, 'auth/login.js'));
  assert.ok(branches(sender).includes('feat'));

  assert.match(snap(bob, ['pr', 'approve', id, '-r', 'origin']).stderr, /not a reviewer/);
  assert.equal(snap(alice, ['pr', 'approve', id, '-r', 'origin'], FUSE_DONE).status, 0);
  const merged = snap(sender, ['sweep', '--remote', 'origin'], FUSE_DONE + 1000);
  assert.match(merged.stdout, /merged into main/);
  assert.ok(mainHas(sender, 'auth/login.js'));
});

test('protected paths: unapproved PRs die with their branch; approve is refused for ordinary PRs', () => {
  const dir = featureRepo({ 'auth/x.js': 'x\n' });
  writePolicy(dir, { protectedPaths: ['auth/**'] });
  const id = sendId(dir);
  openIt(dir, id);
  git(dir, 'switch', '-q', 'main');
  assert.match(snap(dir, ['sweep'], FUSE_DONE).stdout, /is held/);
  assert.match(snap(dir, ['pr', 'approve', id]).stderr, /cannot approve your own PR/);
  const later = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(!mainHas(dir, 'auth/x.js'));
  assert.ok(!branches(dir).includes('feat'));
  assert.equal(git(dir, 'for-each-ref', 'refs/snapgit/pr'), '');
  assert.match(later.stdout, /touches protected paths and was never approved/);
  assert.doesNotMatch(later.stdout, /merged into/);

  const plain = featureRepo();
  const pid = sendId(plain);
  assert.match(snap(plain, ['pr', 'approve', pid]).stderr, /does not touch protected paths/);
});

// ---------------------------------------------------------------- notifications

test('notifyCommand hears about the whole life of a PR, including the halfway warning', UNIX, () => {
  const dir = featureRepo();
  const log = join(mkdtempSync(join(tmpdir(), 'snapgit-log-')), 'events.log');
  git(dir, 'config', 'snapgit.notifyCommand', `cat >> "${log}.$SNAPGIT_EVENT"`);
  const id = sendId(dir);
  openIt(dir, id);
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], T0 + 35_000); // past half of the 60s fuse
  snap(dir, ['sweep'], T0 + 36_000); // announced once, not twice
  snap(dir, ['sweep'], FUSE_DONE);
  const read = (e) => readFileSync(`${log}.${e}`, 'utf8');
  assert.match(read('sent'), /"event":"sent".*"title":"add feature"/);
  assert.match(read('opened'), /"event":"opened".*Test <test@example.com>/);
  assert.equal(read('halfway').match(/"event":"halfway"/g).length, 1);
  assert.match(read('merged'), /"event":"merged".*snapgit undo/);

  const dir2 = featureRepo();
  git(dir2, 'config', 'snapgit.notifyCommand', `cat >> "${log}.$SNAPGIT_EVENT"`);
  const id2 = sendId(dir2);
  git(dir2, 'switch', '-q', 'main');
  snap(dir2, ['pr', 'reject', id2, '-m', 'no']);
  snap(dir2, ['sweep'], T0 + 2 * HOUR);
  assert.match(read('rejected'), /rejected by Test/);
  const dir3 = featureRepo();
  git(dir3, 'config', 'snapgit.notifyCommand', `cat >> "${log}.$SNAPGIT_EVENT"`);
  sendId(dir3);
  git(dir3, 'switch', '-q', 'main');
  snap(dir3, ['sweep'], T0 + 2 * HOUR);
  assert.match(read('expired'), /expired unopened/);
});

test('a failing notifyCommand is reported but never breaks snapgit', UNIX, () => {
  const dir = featureRepo();
  git(dir, 'config', 'snapgit.notifyCommand', 'exit 7');
  const r = snap(dir, ['pr', 'send', '--ttl', '1h']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /notifyCommand failed \(exit 7\)/);
});

test('slackWebhook posts a line of text', UNIX, async () => {
  const sink = join(mkdtempSync(join(tmpdir(), 'snapgit-slack-')), 'posts.log');
  // The receiver runs in its own process: the CLI is spawned synchronously and would starve an in-process server.
  const real = spawn(process.execPath, ['-e', `
    const http = require('http'), fs = require('fs');
    const s = http.createServer((q, r) => { let b = ''; q.on('data', (c) => b += c); q.on('end', () => { fs.appendFileSync(${JSON.stringify(sink)}, b + '\\n'); r.end('ok'); }); });
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((res) => real.stdout.once('data', (d) => res(Number(String(d).trim()))));
  try {
    const dir = featureRepo();
    git(dir, 'config', 'snapgit.slackWebhook', `http://127.0.0.1:${port}/hook`);
    const r = snap(dir, ['pr', 'send', '--ttl', '1h']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /slackWebhook failed/);
    const body = JSON.parse(readFileSync(sink, 'utf8').trim().split('\n')[0]);
    assert.match(body.text, /sent PR [0-9a-f]{8} "add feature"/);
  } finally {
    real.kill();
  }
});

// ---------------------------------------------------------------- graveyard

test('ghosted branches go to the graveyard and can be resurrected with a fresh timer', () => {
  const dir = repo();
  snap(dir, ['snap', 'idea', '--ttl', '1h']);
  commit(dir, 'idea.txt', 'precious\n', 'precious work');
  const sha = git(dir, 'rev-parse', '--short', 'HEAD');
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(!branches(dir).includes('idea'));
  git(dir, 'gc', '-q', '--prune=now'); // the commit survives gc: the graveyard ref keeps it reachable
  assert.match(snap(dir, ['graveyard']).stdout, new RegExp(`idea\\s+${sha}`));

  const back = snap(dir, ['resurrect', 'idea'], T0 + 3 * HOUR);
  assert.match(back.stdout, new RegExp(`idea is back at ${sha}, with a fresh timer`));
  assert.equal(git(dir, 'show', 'idea:idea.txt'), 'precious');
  assert.match(snap(dir, ['ls'], T0 + 3 * HOUR).stdout, /idea.*1d left/);
  assert.match(snap(dir, ['graveyard']).stdout, /empty/);
  assert.match(snap(dir, ['resurrect', 'idea']).stderr, /nothing named idea/);
});

test('the graveyard forgets old graves after graveyardDays', () => {
  const dir = repo();
  snap(dir, ['snap', 'old', '--ttl', '1h', '--stay']);
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(snap(dir, ['graveyard'], T0 + 2 * HOUR).stdout, /old/);
  git(dir, 'config', 'snapgit.graveyardDays', '1');
  snap(dir, ['sweep'], T0 + 2 * HOUR + 2 * 864e5);
  assert.match(snap(dir, ['graveyard']).stdout, /empty/);
});

// ---------------------------------------------------------------- undo

test('undo reverts a snapgit merge with a revert commit, and can only happen once', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  openIt(dir, id);
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], FUSE_DONE);
  assert.ok(mainHas(dir, 'f.txt'));
  const history = git(dir, 'rev-list', '--count', 'main');
  assert.match(snap(dir, ['merged']).stdout, new RegExp(`${id}.*add feature`));

  const undone = snap(dir, ['undo', id]);
  assert.equal(undone.status, 0, undone.stderr);
  assert.match(undone.stdout, /main now has revert commit [0-9a-f]{7}.*snapgit resurrect feat/);
  assert.ok(!mainHas(dir, 'f.txt'));
  assert.equal(Number(git(dir, 'rev-list', '--count', 'main')), Number(history) + 1); // history only grows
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.match(snap(dir, ['merged']).stdout, /undone/);
  assert.match(snap(dir, ['undo', id]).stderr, /already undone/);
  // And the branch is recoverable.
  assert.equal(snap(dir, ['resurrect', 'feat']).status, 0);
  assert.equal(git(dir, 'show', 'feat:f.txt'), 'new feature');
});

test('undo works when main is not checked out, and refuses unknown ids', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  openIt(dir, id);
  git(dir, 'switch', '-q', '-c', 'elsewhere', 'main');
  snap(dir, ['sweep'], FUSE_DONE);
  assert.ok(mainHas(dir, 'f.txt'));
  assert.equal(snap(dir, ['undo', id]).status, 0);
  assert.ok(!mainHas(dir, 'f.txt'));
  assert.match(snap(dir, ['undo', 'deadbeef']).stderr, /no merge on record/);
});

test('undo explains itself when later work makes the revert conflict, and changes nothing', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  openIt(dir, id);
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], FUSE_DONE);
  commit(dir, 'f.txt', 'someone built on top of it\n', 'later change');
  const before = git(dir, 'rev-parse', 'main');
  const r = snap(dir, ['undo', id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /conflicts with later changes/);
  assert.equal(git(dir, 'rev-parse', 'main'), before);
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1);
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('undo --push publishes the revert to the remote', () => {
  const { bare, sender } = remotes();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  openIt(sender, id);
  snap(sender, ['sweep', '--remote', 'origin'], FUSE_DONE);
  assert.equal(sh(bare, 'git', ['cat-file', '-e', 'main:f.txt']).status, 0);
  assert.match(snap(sender, ['undo', id, '--push', '-r', 'origin']).stdout, /\(pushed\)/);
  assert.notEqual(sh(bare, 'git', ['cat-file', '-e', 'main:f.txt']).status, 0);
});

// ---------------------------------------------------------------- freeze

test('freeze stops merges and deletions; thaw lets what came due settle', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  openIt(dir, id);
  snap(dir, ['snap', 'doomed', '--ttl', '1h', '--stay']);
  git(dir, 'switch', '-q', 'main');
  assert.match(snap(dir, ['freeze', 'incident', '4821']).stdout, /frozen/);
  const frozen = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(frozen.stdout, /frozen \(incident 4821\)/);
  assert.ok(!mainHas(dir, 'f.txt'));
  assert.ok(branches(dir).includes('doomed') && branches(dir).includes('feat'));
  assert.match(snap(dir, ['policy']).stdout, /frozen: incident 4821/);

  snap(dir, ['thaw']);
  const thawed = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(thawed.stdout, /merged into main/);
  assert.ok(!branches(dir).includes('doomed'));
});

test('a freeze published to the remote stops other runners too', () => {
  const { sender, clone } = remotes();
  const runner = clone('Runner');
  snap(runner, ['snap', 'tmp', '--ttl', '1h', '--stay']);
  snap(sender, ['freeze', '-r', 'origin', 'release', 'freeze']);
  assert.match(snap(runner, ['sweep', '-r', 'origin'], T0 + 2 * HOUR).stdout, /frozen \(release freeze\)/);
  assert.ok(branches(runner).includes('tmp'));
  snap(sender, ['thaw', '-r', 'origin']);
  assert.match(snap(runner, ['sweep', '-r', 'origin'], T0 + 2 * HOUR).stdout, /ghosted tmp/);
});

// ---------------------------------------------------------------- remote timers

test('push publishes a branch timer so ANY runner can delete the expired branch', () => {
  const { bare, sender, clone } = remotes({ sender: repo(), setup: (s) => git(s, 'switch', '-q', '-c', 'feat') });
  git(sender, 'switch', '-q', 'main');
  snap(sender, ['snap', 'spike', '--ttl', '1h']);
  commit(sender, 'spike.txt', 's\n', 'spike');
  const pushed = snap(sender, ['push']);
  assert.match(pushed.stdout, /Its timer is published/);
  assert.match(git(bare, 'ls-remote', '.', 'refs/snapgit/timer/spike'), /refs\/snapgit\/timer\/spike/);

  const runner = clone('Runner'); // knows nothing about the timer locally
  assert.match(snap(runner, ['sweep', '-r', 'origin'], T0 + 30 * 60_000).stdout, /nothing has expired/);
  assert.match(git(bare, 'ls-remote', '.', 'refs/heads/spike'), /spike/);
  const swept = snap(runner, ['sweep', '-r', 'origin'], T0 + 2 * HOUR);
  assert.match(swept.stdout, /deleted spike on the remote/);
  assert.equal(git(bare, 'ls-remote', '.', 'refs/heads/spike'), '');
  assert.equal(git(bare, 'ls-remote', '.', 'refs/snapgit/timer/*'), '');
  assert.ok(git(bare, 'ls-remote', '.', 'refs/heads/main'));
});

test('a clock-only runner leaves branches with a live PR to the PR, and timers cannot be changed', () => {
  const { bare, sender, clone } = remotes();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  assert.match(git(bare, 'ls-remote', '.', 'refs/snapgit/timer/feat'), /timer\/feat/);
  const runner = clone('Runner');
  const swept = snap(runner, ['sweep', '-r', 'origin'], T0 + 2 * HOUR);
  assert.doesNotMatch(swept.stdout, /deleted feat/);
  assert.match(git(bare, 'ls-remote', '.', 'refs/heads/feat'), /feat/);
  assert.match(id, /^[0-9a-f]{8}$/);

  // Immutable: a different timer for the same branch is refused by the remote.
  const before = git(bare, 'ls-remote', '.', 'refs/snapgit/timer/feat');
  git(sender, 'update-ref', '-d', 'refs/snapgit/timer/feat');
  snap(sender, ['push', 'feat'], T0 + 10 * HOUR); // same local expiry; remote keeps the original
  assert.equal(git(bare, 'ls-remote', '.', 'refs/snapgit/timer/feat'), before);
});

test('snapgit --version and help', () => {
  const dir = repo();
  assert.match(snap(dir, ['--version']).stdout, /^\d+\.\d+\.\d+/);
  const help = snap(dir, ['help']).stdout;
  for (const word of ['undo', 'freeze', 'resurrect', 'approve', 'policy', 'push']) assert.match(help, new RegExp(word));
  assert.doesNotMatch(help, /snapgit (extend|keep) /);
});

// ---------------------------------------------------------------- findings from the adversarial review

const forgeRef = (clone, ref, obj) => {
  const r = sh(clone, 'sh', ['-c', `printf '%s' '${JSON.stringify(obj)}' | git hash-object -w --stdin`]);
  git(clone, 'push', '-q', '--force', 'origin', `${r.stdout.trim()}:${ref}`);
};

test('the merge is of what was reviewed: commits pushed after opening void the opening and refresh the PR', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  openIt(dir, id);
  commit(dir, 'extra.txt', 'sneaked in after review\n', 'one more thing');
  git(dir, 'switch', '-q', 'main');
  const swept = snap(dir, ['sweep'], FUSE_DONE);
  assert.match(swept.stdout, /new commits landed on feat, so the fuse went out/);
  assert.ok(!mainHas(dir, 'f.txt') && !mainHas(dir, 'extra.txt'));
  assert.match(snap(dir, ['pr', 'ls'], FUSE_DONE).stdout, /unopened/);
  const reopened = openIt(dir, id, FUSE_DONE + 1000); // the reviewer now sees the new code
  assert.match(reopened.stdout, /\+sneaked in after review/);
  snap(dir, ['sweep'], FUSE_DONE + 62_000);
  assert.ok(mainHas(dir, 'f.txt') && mainHas(dir, 'extra.txt'));
});

test('a protected path added after opening is caught at settle time, not trusted from the record', () => {
  const dir = featureRepo();
  writePolicy(dir, { protectedPaths: ['auth/**'] });
  const id = sendId(dir);
  openIt(dir, id);
  sh(dir, 'mkdir', ['-p', join(dir, 'auth')]);
  commit(dir, 'auth/backdoor.js', 'evil\n', 'add backdoor');
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], FUSE_DONE); // refresh: the record is recomputed and now protected
  openIt(dir, id, FUSE_DONE + 1000);
  const held = snap(dir, ['sweep'], FUSE_DONE + 62_000);
  assert.match(held.stdout, /is held: touches protected paths \(auth\/backdoor.js\)/);
  assert.ok(!mainHas(dir, 'auth/backdoor.js'));
});

test('only the sender can withdraw a PR, and a PR deleted from the remote is never merged', () => {
  const { bare, sender, clone } = remotes({ setup: (s) => writePolicy(s, { reviewers: ['alice@example.com'] }) });
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const alice = clone('Alice');
  const eve = clone('Eve');
  openIt(alice, id);
  snap(sender, ['sweep', '-r', 'origin'], T0 + 5000); // the sender's watcher sees the opening
  assert.equal(snap(alice, ['pr', 'reject', id, '-r', 'origin']).status, 0);

  const burn = snap(eve, ['pr', 'burn', id, '-r', 'origin']);
  assert.notEqual(burn.status, 0);
  assert.match(burn.stderr, /only the sender .* can withdraw/);
  assert.match(git(bare, 'ls-remote', '.', 'refs/snapgit/pr/*'), new RegExp(id));
  assert.match(snap(sender, ['sweep', '-r', 'origin'], FUSE_DONE).stdout, /rejected by Alice/);
  assert.ok(!mainHas(sender, 'f.txt'));

  // And if the PR is deleted from the remote behind the sender's back, nothing merges.
  const second = featureRepo();
  const r2 = remotes({ sender: second });
  const id2 = snap(r2.sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  openIt(r2.sender, id2);
  git(r2.bare, 'update-ref', '-d', `refs/snapgit/pr/${id2}`);
  const gone = snap(r2.sender, ['sweep', '-r', 'origin'], FUSE_DONE);
  assert.match(gone.stdout, /is gone from its remote \(withdrawn or deleted\), so nothing will merge/);
  assert.ok(!mainHas(r2.sender, 'f.txt'));
});

test('a non-reviewer cannot squat the reject ref: their veto is refused, a forged one is replaced by the real one', () => {
  const { sender, clone } = remotes({ setup: (s) => writePolicy(s, { reviewers: ['alice@example.com'] }) });
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const alice = clone('Alice');
  const eve = clone('Eve');
  openIt(alice, id);
  assert.match(snap(eve, ['pr', 'reject', id, '-r', 'origin']).stderr, /not a reviewer/); // even from a clone without the PR
  forgeRef(eve, `refs/snapgit/reject/${id}`, { id, rejector: 'Eve <eve@example.com>', rejectedAt: T0, reason: 'squat' });
  assert.equal(snap(alice, ['pr', 'reject', id, '-r', 'origin', '-m', 'real veto']).status, 0);
  assert.match(snap(sender, ['sweep', '-r', 'origin'], FUSE_DONE).stdout, /rejected by Alice <alice@example.com>: "real veto"/);
  assert.ok(!mainHas(sender, 'f.txt'));
});

test('the sender withdrawing their own PR (reject) counts even when reviewers are restricted', () => {
  const { sender, clone } = remotes({ setup: (s) => writePolicy(s, { reviewers: ['alice@example.com'] }) });
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  openIt(clone('Alice'), id);
  assert.equal(snap(sender, ['pr', 'reject', id, '-r', 'origin', '-m', 'changed my mind']).status, 0);
  assert.match(snap(sender, ['sweep', '-r', 'origin'], FUSE_DONE).stdout, /rejected by Test/);
  assert.ok(!mainHas(sender, 'f.txt'));
});

test('an offline sweep (the git hooks) never deletes the branch of a PR that lives on a remote', () => {
  const { sender, clone } = remotes();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  openIt(clone('Alice'), id);
  snap(sender, ['sweep', '--offline'], T0 + 2 * HOUR);
  assert.ok(branches(sender).includes('feat'));
  assert.match(snap(sender, ['sweep', '-r', 'origin'], T0 + 2 * HOUR).stdout, /merged into main/);
  assert.ok(mainHas(sender, 'f.txt'));
});

test('a freeze published to a PR\'s remote stops the sender even when they sweep without -r', () => {
  const { sender, clone } = remotes();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  openIt(clone('Alice'), id);
  snap(clone('Ops'), ['freeze', '-r', 'origin', 'incident']);
  const held = snap(sender, ['sweep'], FUSE_DONE);
  assert.doesNotMatch(held.stdout, /merged into/);
  assert.ok(!mainHas(sender, 'f.txt'));
  const ops = clone('Ops2');
  snap(ops, ['thaw', '-r', 'origin']);
  assert.match(snap(sender, ['sweep'], FUSE_DONE + 1000).stdout, /merged into main/);
});

test('deleting a branch on the remote keeps its remote tip in the graveyard (teammates\' unpulled commits)', () => {
  const { bare, sender, clone } = remotes();
  snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']);
  const mate = clone('Mate');
  git(mate, 'switch', '-q', 'feat');
  commit(mate, 'mate.txt', 'teammate work\n', 'mate pushes to feat');
  git(mate, 'push', '-q', 'origin', 'feat');
  const mateSha = git(mate, 'rev-parse', 'HEAD');
  snap(sender, ['sweep', '-r', 'origin'], T0 + 2 * HOUR);
  assert.equal(git(bare, 'ls-remote', '.', 'refs/heads/feat'), '');
  assert.match(git(sender, 'for-each-ref', 'refs/snapgit/graveyard'), new RegExp(mateSha));
});

test('opening too close to the deadline is refused: a fuse cut short by the timer would be a rubber stamp', () => {
  const dir = featureRepo();
  const id = sendId(dir); // 1h of life, 1m fuse
  const late = snap(dir, ['pr', 'open', id, '--screenshot'], T0 + 3600_000 - 30_000);
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /30s of life left but needs a 1m fuse/);
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(!mainHas(dir, 'f.txt'));
});

test('identity: a self-asserted user.name proves nothing; the GitHub login is how the CLI matches @logins', () => {
  const { sender, clone } = remotes({ setup: (s) => writePolicy(s, { reviewers: ['@alice'] }) });
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const fake = clone('alice'); // user.name is "alice" but the email is not alice's
  assert.match(snap(fake, ['pr', 'open', id, '--screenshot']).stderr, /not a reviewer/);
  git(fake, 'config', 'snapgit.githubLogin', 'alice');
  assert.equal(snap(fake, ['pr', 'open', id, '--screenshot']).status, 0);
  // Changing user.name does not let the sender review their own PR.
  git(sender, 'config', 'user.name', 'Somebody Else');
  assert.match(snap(sender, ['pr', 'open', id, '-r', 'origin', '--screenshot']).stderr, /not a reviewer|cannot review your own/);
});

test('a PR that was only ever local can be opened even though origin has never heard of it', () => {
  const dir = featureRepo();
  const bare = mkdtempSync(join(tmpdir(), 'snapgit-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(dir, 'remote', 'add', 'origin', bare);
  const id = sendId(dir); // no -r: local only
  const r = openIt(dir, id);
  assert.match(r.stdout, /validated before review/);
  assert.equal(git(dir, 'for-each-ref', 'refs/snapgit/pr').length > 0, true);
});

test('a garbled snapgit ref cannot abort a sweep', () => {
  const dir = featureRepo();
  sendId(dir);
  const junk = sh(dir, 'sh', ['-c', "printf 'not json' | git hash-object -w --stdin"]).stdout.trim();
  git(dir, 'update-ref', 'refs/snapgit/pr/deadbeef', junk);
  git(dir, 'switch', '-q', 'main');
  const r = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nobody ever opened it/);
});
