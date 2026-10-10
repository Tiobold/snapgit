import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BIN = resolve('bin/snapgit.js');
const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
const HOUR = 36e5;

const sh = (cwd, cmd, args, env = {}) =>
  spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
const git = (cwd, ...a) => {
  const r = sh(cwd, 'git', a);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const snap = (cwd, args, at = T0) => sh(cwd, 'node', [BIN, ...args], { SNAPGIT_NOW: String(at) });

function repo(name = 'repo') {
  const dir = mkdtempSync(join(tmpdir(), `snapgit-${name}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  commit(dir, 'a.txt', 'hello\n', 'first');
  return dir;
}
function commit(dir, file, text, msg, date) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '.');
  const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  const r = sh(dir, 'git', ['commit', '-q', '-m', msg], env);
  assert.equal(r.status, 0, r.stderr);
}
const branches = (dir) => git(dir, 'branch', '--format=%(refname:short)').split('\n');

test('snap creates a branch with a timer and sweep removes it only after expiry', () => {
  const dir = repo();
  assert.equal(snap(dir, ['snap', 'wip/idea', '--ttl', '2h']).status, 0);
  assert.equal(git(dir, 'branch', '--show-current'), 'wip/idea');
  commit(dir, 'b.txt', 'x\n', 'wip');
  git(dir, 'switch', '-q', 'main');

  assert.match(snap(dir, ['ls']).stdout, /wip\/idea.*1h 59m left|2h left|1h/);
  snap(dir, ['sweep'], T0 + HOUR);
  assert.ok(branches(dir).includes('wip/idea'));

  const swept = snap(dir, ['sweep'], T0 + 3 * HOUR);
  assert.match(swept.stdout, /ghosted wip\/idea/);
  assert.ok(!branches(dir).includes('wip/idea'));
  assert.equal(sh(dir, 'git', ['config', '--get-regexp', 'snapgit']).stdout, '');
});

test('sweep never deletes the checked-out branch', () => {
  const dir = repo();
  snap(dir, ['snap', 'tmp', '--ttl', '1h']);
  const r = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(r.stdout, /checked out/);
  assert.ok(branches(dir).includes('tmp'));
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(!branches(dir).includes('tmp'));
});

test('every snap gets a timer by default, and timers can never be extended or removed', () => {
  const dir = repo();
  assert.match(snap(dir, ['snap', 'a', '--stay']).stdout, /disappear in 1d/);
  git(dir, 'config', 'snapgit.defaultTtl', '3h');
  assert.match(snap(dir, ['snap', 'b', '--stay']).stdout, /disappear in 3h/);
  for (const cmd of ['extend', 'keep']) {
    const r = snap(dir, [cmd, 'a', '5h']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /unknown command/);
  }
  snap(dir, ['sweep'], T0 + 4 * HOUR);
  assert.deepEqual(branches(dir).sort(), ['a', 'main']); // b (3h) is gone, a (24h) is not

  assert.notEqual(snap(dir, ['snap', 'main']).status, 0);
  assert.notEqual(snap(dir, ['snap', 'x', '--ttl', 'soon']).status, 0);
});

test('sweep --remote also removes the pushed branch', () => {
  const dir = repo();
  const bare = mkdtempSync(join(tmpdir(), 'snapgit-bare-'));
  git(bare, 'init', '-q', '--bare');
  git(dir, 'remote', 'add', 'origin', bare);
  snap(dir, ['snap', 'gone', '--ttl', '1h', '--stay']);
  git(dir, 'push', '-q', 'origin', 'gone');
  snap(dir, ['sweep', '--remote', 'origin'], T0 + 2 * HOUR);
  assert.equal(git(dir, 'ls-remote', '--heads', 'origin', 'gone'), '');
});

test('init installs hooks that sweep after a commit', () => {
  const dir = repo();
  snap(dir, ['snap', 'old', '--ttl', '1h', '--stay']);
  assert.match(snap(dir, ['init']).stdout, /hooks installed/);
  assert.match(snap(dir, ['init']).stdout, /already installed/);
  const r = sh(dir, 'git', ['commit', '-q', '--allow-empty', '-m', 'tick'], { SNAPGIT_NOW: String(T0 + 2 * HOUR) });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!branches(dir).includes('old'));
});

function featureRepo() {
  const dir = repo();
  git(dir, 'switch', '-q', '-c', 'feat');
  commit(dir, 'f.txt', 'new feature\n', 'add feature');
  return dir;
}
const sendId = (dir, ...extra) => {
  const r = snap(dir, ['pr', 'send', '--ttl', '1h', ...extra]);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.match(/id ([0-9a-f]{8})/)[1];
};
const mainHas = (dir, file) => sh(dir, 'git', ['cat-file', '-e', `main:${file}`]).status === 0;

test('sending a PR puts the branch on the clock; opening shows the changed code and lights a 60s fuse', () => {
  const dir = featureRepo();
  const sent = snap(dir, ['pr', 'send', '--ttl', '3h', '-m', 'Add feature\nplease look']);
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, /60 seconds after it is first opened/);
  const id = sent.stdout.match(/id ([0-9a-f]{8})/)[1];
  assert.match(snap(dir, ['ls']).stdout, /feat.*3h left/);
  assert.match(snap(dir, ['pr', 'ls']).stdout, /unopened/);

  const first = snap(dir, ['pr', 'open', id, '--screenshot']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Add feature/);
  assert.match(first.stdout, /\+new feature/);
  assert.match(first.stdout, /fuse is lit.*merges into main in 1m unless you run: snapgit pr reject/);
  assert.match(first.stdout, /screenshot detected/);

  // The opener can keep reading the changed code while the fuse burns.
  const again = snap(dir, ['pr', 'open', id, '--screenshot'], T0 + 20_000);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /\+new feature/);
  assert.match(again.stdout, /merges into main in 40s/);
  assert.match(snap(dir, ['pr', 'ls'], T0 + 20_000).stdout, new RegExp(`${id}.*opened by Test.*merges in 40s`));
});

test('a PR merges 60 seconds after it is opened, even though the branch timer has hours left', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  git(dir, 'switch', '-q', 'main');
  assert.equal(snap(dir, ['pr', 'open', id, '--screenshot']).status, 0);
  assert.doesNotMatch(snap(dir, ['sweep'], T0 + 30_000).stdout, /merged/);
  assert.ok(!mainHas(dir, 'f.txt'));

  const swept = snap(dir, ['sweep'], T0 + 61_000);
  assert.match(swept.stdout, new RegExp(`PR ${id}: nobody rejected it, so feat merged into main`));
  assert.ok(mainHas(dir, 'f.txt'));
  assert.ok(!branches(dir).includes('feat')); // merged branches don't wait for their timer
  assert.equal(git(dir, 'for-each-ref', 'refs/snapgit'), '');
});

test('rejecting inside the fuse window stops the merge; the fuse cannot be re-lit afterwards', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['pr', 'open', id, '--screenshot']);
  assert.equal(snap(dir, ['pr', 'reject', id, '-m', 'nope'], T0 + 30_000).status, 0);
  const swept = snap(dir, ['sweep'], T0 + 61_000);
  assert.match(swept.stdout, /rejected by Test <test@example.com>: "nope"/);
  assert.ok(!mainHas(dir, 'f.txt'));
  assert.ok(branches(dir).includes('feat')); // the branch still dies on its own schedule
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(!branches(dir).includes('feat'));
});

test('once the fuse has burned out the PR cannot be opened again', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['pr', 'open', id, '--screenshot']);
  const late = snap(dir, ['pr', 'open', id, '--screenshot'], T0 + 61_000);
  assert.notEqual(late.status, 0);
  assert.match(late.stderr, /fuse burned out/);
});

test('piping a PR without --screenshot refuses and does not burn it', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  const r = snap(dir, ['pr', 'open', id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Nothing was burned/);
  assert.equal(snap(dir, ['pr', 'open', id, '--screenshot']).status, 0);
});

test('an unopened PR nobody rejects merges into main when its branch expires, then the branch vanishes', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  git(dir, 'switch', '-q', 'main');
  assert.ok(!mainHas(dir, 'f.txt'));
  const early = snap(dir, ['sweep'], T0 + HOUR / 2);
  assert.doesNotMatch(early.stdout, /merged/);
  assert.ok(!mainHas(dir, 'f.txt'));

  const swept = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(swept.stdout, new RegExp(`PR ${id}: nobody rejected it, so feat merged into main`));
  assert.ok(mainHas(dir, 'f.txt'));
  assert.ok(!branches(dir).includes('feat'));
  assert.equal(git(dir, 'for-each-ref', 'refs/snapgit/pr'), '');
  assert.match(git(dir, 'log', '-1', '--format=%P'), / /); // a real two-parent merge commit
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('merging works when main is not checked out (no working tree needed)', () => {
  const dir = featureRepo();
  sendId(dir);
  git(dir, 'switch', '-q', '-c', 'elsewhere', 'main');
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(mainHas(dir, 'f.txt'));
  assert.ok(!branches(dir).includes('feat'));
});

test('a rejected PR never merges, and the branch still dies on schedule', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  git(dir, 'switch', '-q', 'main');
  assert.equal(snap(dir, ['pr', 'reject', id, '-m', 'no thanks']).status, 0);
  const swept = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(swept.stdout, /rejected by Test <test@example.com>: "no thanks"/);
  assert.ok(!mainHas(dir, 'f.txt'));
  assert.ok(!branches(dir).includes('feat'));
});

test('a rejection that arrives after the deadline is too late', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  git(dir, 'switch', '-q', 'main');
  sh(dir, 'node', [BIN, 'pr', 'reject', id], { SNAPGIT_NOW: String(T0 + 2 * HOUR) });
  const swept = snap(dir, ['sweep'], T0 + 2 * HOUR + 1000);
  assert.match(swept.stdout, /merged into main \(a rejection arrived too late\)/);
  assert.ok(mainHas(dir, 'f.txt'));
});

test('a conflicting PR is held, not merged and not deleted', () => {
  const dir = featureRepo();
  sendId(dir);
  git(dir, 'switch', '-q', 'main');
  commit(dir, 'f.txt', 'someone else wrote this\n', 'conflicting change');
  const swept = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(swept.stdout, /kept feat: PR held: merge conflict/);
  assert.ok(branches(dir).includes('feat'));
  assert.equal(git(dir, 'show', 'main:f.txt'), 'someone else wrote this');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a dirty working tree on the base branch holds the merge until it is clean', () => {
  const dir = featureRepo();
  sendId(dir);
  git(dir, 'switch', '-q', 'main');
  writeFileSync(join(dir, 'a.txt'), 'dirty\n');
  assert.match(snap(dir, ['sweep'], T0 + 2 * HOUR).stdout, /uncommitted changes/);
  assert.ok(branches(dir).includes('feat'));
  git(dir, 'checkout', '-q', '--', 'a.txt');
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(mainHas(dir, 'f.txt'));
});

test('while checked out, the PR still settles but the branch waits for you to leave', () => {
  const dir = featureRepo();
  sendId(dir);
  const r = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(r.stdout, /feat merged into main/);
  assert.match(r.stdout, /checked out/);
  assert.ok(branches(dir).includes('feat'));
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(!branches(dir).includes('feat'));
});

test('burn withdraws a PR without merging; its branch still dies on its timer', () => {
  const dir = featureRepo();
  const id = sendId(dir);
  assert.equal(snap(dir, ['pr', 'burn', id]).status, 0);
  assert.equal(snap(dir, ['pr', 'burn', id]).status, 1);
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.ok(!mainHas(dir, 'f.txt'));
  assert.ok(!branches(dir).includes('feat'));
  assert.notEqual(snap(dir, ['pr', 'open', '../../x', '--screenshot']).status, 0);
});

test('sending a PR for a branch that already has a timer cannot change that timer', () => {
  const dir = featureRepo();
  snap(dir, ['snap', 'other', '--ttl', '1h', '--stay']);
  git(dir, 'branch', '-q', '-m', 'feat', 'feat2');
  snap(dir, ['snap', 'feat', '--ttl', '1h']);
  commit(dir, 'g.txt', 'g\n', 'more');
  const r = snap(dir, ['pr', 'send', '--ttl', '9h']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /timers can never be changed/);
  assert.equal(snap(dir, ['pr', 'send']).status, 0); // without --ttl it just uses the existing timer
});

function remotes() {
  const bare = mkdtempSync(join(tmpdir(), 'snapgit-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const sender = featureRepo();
  git(sender, 'remote', 'add', 'origin', bare);
  git(sender, 'push', '-q', 'origin', 'main', 'feat');
  git(sender, 'switch', '-q', 'main');
  const clone = (name) => {
    const d = mkdtempSync(join(tmpdir(), `snapgit-${name}-`));
    git(d, 'clone', '-q', bare, '.');
    git(d, 'config', 'user.name', name);
    git(d, 'config', 'user.email', `${name.toLowerCase()}@example.com`);
    return d;
  };
  return { bare, sender, clone };
}

test('over a remote: one reader wins, anyone can reject, the sender honors it', () => {
  const { bare, sender, clone } = remotes();
  const sent = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h', '-m', 'Over the wire']);
  assert.equal(sent.status, 0, sent.stderr);
  const id = sent.stdout.match(/id ([0-9a-f]{8})/)[1];
  const alice = clone('Alice');
  const bob = clone('Bob');
  assert.match(snap(alice, ['pr', 'ls', '-r', 'origin']).stdout, new RegExp(id));

  const a = snap(alice, ['pr', 'open', id, '--screenshot']);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /Over the wire/);
  const b = snap(bob, ['pr', 'open', id, '--screenshot']);
  assert.notEqual(b.status, 0);
  assert.match(b.stderr, /already being reviewed by Alice <alice@example.com>/);
  assert.equal(snap(alice, ['pr', 'open', id, '--screenshot'], T0 + 10_000).status, 0); // Alice may re-read
  assert.equal(git(alice, 'for-each-ref', 'refs/snapgit/pr'), ''); // recipients keep nothing

  // Bob was locked out of reading it, but anyone can still reject it.
  assert.equal(snap(bob, ['pr', 'reject', id, '-r', 'origin', '-m', 'nope']).status, 0);
  assert.notEqual(snap(bob, ['pr', 'reject', id, '-r', 'origin']).status, 0); // already rejected
  const swept = snap(sender, ['sweep', '--remote', 'origin'], T0 + 2 * HOUR);
  assert.match(swept.stdout, /rejected by Bob <bob@example.com>: "nope"/);
  assert.ok(!mainHas(sender, 'f.txt'));
  assert.equal(git(bare, 'ls-remote', '.', 'refs/snapgit/pr/*'), '');
  assert.equal(git(bare, 'ls-remote', '.', 'refs/snapgit/reject/*'), '');
  assert.equal(git(bare, 'ls-remote', '.', 'refs/heads/feat'), '');
});

test('over a remote: unrejected PRs merge, and --remote pushes the result', () => {
  const { bare, sender } = remotes();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const swept = snap(sender, ['sweep', '--remote', 'origin'], T0 + 2 * HOUR);
  assert.match(swept.stdout, new RegExp(`PR ${id}: nobody rejected it.*and was pushed`));
  assert.equal(sh(bare, 'git', ['cat-file', '-e', 'main:f.txt']).status, 0);
  assert.equal(git(bare, 'ls-remote', '.', 'refs/snapgit/pr/*'), '');
  const gone = snap(sender, ['pr', 'open', id, '--screenshot']);
  assert.match(gone.stderr, /gone/);
});

test('if the remote cannot be reached, the merge is held rather than risking a missed rejection', () => {
  const { sender } = remotes();
  snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']);
  git(sender, 'remote', 'set-url', 'origin', '/nonexistent/place');
  const swept = snap(sender, ['sweep'], T0 + 2 * HOUR);
  assert.match(swept.stdout, /cannot reach origin/);
  assert.ok(!mainHas(sender, 'f.txt'));
  assert.ok(branches(sender).includes('feat'));
});

test('over a remote: the sender merges 60s after a recipient opens, and --remote pushes it', () => {
  const { bare, sender, clone } = remotes();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '5h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const alice = clone('Alice');
  assert.equal(snap(alice, ['pr', 'open', id, '-r', 'origin', '--screenshot']).status, 0);
  assert.doesNotMatch(snap(sender, ['sweep', '--remote', 'origin'], T0 + 30_000).stdout, /merged/);
  const swept = snap(sender, ['sweep', '--remote', 'origin'], T0 + 61_000);
  assert.match(swept.stdout, new RegExp(`PR ${id}: nobody rejected it.*and was pushed`));
  assert.equal(sh(bare, 'git', ['cat-file', '-e', 'main:f.txt']).status, 0);
  assert.equal(git(bare, 'ls-remote', '.', 'refs/snapgit/*'), '');
  assert.match(snap(alice, ['pr', 'open', id, '-r', 'origin', '--screenshot']).stderr, /gone/);
});

test('hooks sweep offline: local-only PRs settle, remote ones wait for an online sweep', () => {
  const { sender } = remotes();
  snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']);
  const off = snap(sender, ['sweep', '--offline'], T0 + 2 * HOUR);
  assert.doesNotMatch(off.stdout, /merged/);
  assert.ok(!mainHas(sender, 'f.txt'));
});

test('read receipts tell the sender who opened the PR and whether they screenshotted', () => {
  const { bare, sender, clone } = remotes();
  const id = snap(sender, ['pr', 'send', 'feat', '-r', 'origin', '-m', 'Receipt me']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const alice = clone('Alice');
  assert.equal(snap(alice, ['pr', 'open', id, '--screenshot']).status, 0);

  // Alice must not be able to read receipts addressed to the sender.
  assert.match(snap(alice, ['pr', 'receipts']).stdout, /no new read receipts/);

  const r = snap(sender, ['pr', 'receipts']);
  assert.equal(snap(sender, ['pr', 'receipts']).stdout, r.stdout);
  assert.match(r.stdout, /Alice <alice@example.com> opened "Receipt me"/);
  assert.match(r.stdout, /screenshot/);
  assert.match(snap(sender, ['pr', 'ls']).stdout, /opened by Alice/);
});

// Main gets snapgit.json and a file the branch lacks AFTER the branch point, so only the merge result has both.
function ciRepo({ check, headMsg = 'add feature', send = true, sendAt = T0, mainCheck = check }) {
  const dir = repo();
  git(dir, 'switch', '-q', '-c', 'feat');
  writeFileSync(join(dir, 'f.txt'), 'new feature\n');
  git(dir, 'add', '.');
  assert.equal(sh(dir, 'git', ['commit', '-q', '-m', headMsg]).status, 0);
  git(dir, 'switch', '-q', 'main');
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  writeFileSync(join(dir, 'snapgit.json'), JSON.stringify({ checks: [{ name: 'tests', run: check }] }));
  git(dir, 'add', '.');
  assert.equal(sh(dir, 'git', ['commit', '-q', '-m', 'ci config']).status, 0);
  git(dir, 'switch', '-q', 'feat');
  let id = null;
  if (send) {
    const r = snap(dir, ['pr', 'send', '--ttl', '1h'], sendAt);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    id = r.stdout.match(/id ([0-9a-f]{8})/)[1];
  }
  git(dir, 'switch', '-q', 'main');
  if (mainCheck !== check) { // CI goes red on main after the PR was sent
    writeFileSync(join(dir, 'snapgit.json'), JSON.stringify({ checks: [{ name: 'tests', run: mainCheck }] }));
    git(dir, 'commit', '-qam', 'tighten ci');
  }
  return { dir, id };
}

test('CI checks run against the merge result in a scratch worktree; a pass merges', () => {
  const { dir } = ciRepo({ check: 'test -f f.txt && test -f base.txt' });
  const swept = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(swept.stdout, /feat merged into main \(1 CI check passed\)/);
  assert.ok(mainHas(dir, 'f.txt'));
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'worktree', 'list').split('\n').length, 1, 'scratch worktree cleaned up');
});

test('a PR that fails CI at send time is never sent: authors are shamed and the branch self-destructs', () => {
  const { dir } = ciRepo({ check: 'echo "boom: 1 test failed" >&2; exit 3', send: false });
  git(dir, 'switch', '-q', 'feat');
  const r = snap(dir, ['pr', 'send', '--ttl', '1h']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not sent: feat failed CI.*"tests" exited 3/);
  assert.match(r.stdout, /Shame on: Test/);
  assert.match(r.stdout, /\| boom: 1 test failed/);
  assert.equal(git(dir, 'for-each-ref', 'refs/snapgit/pr'), '');
  assert.ok(branches(dir).includes('feat')); // checked out, so it vanishes once you leave
  git(dir, 'switch', '-q', 'main');
  snap(dir, ['sweep']);
  assert.ok(!branches(dir).includes('feat'));
  assert.ok(!mainHas(dir, 'f.txt'));
  const list = JSON.parse(snap(dir, ['shame', '--json']).stdout);
  assert.equal(list.length, 1);
  assert.equal(list[0].check, 'tests');
  assert.equal(list[0].exitCode, 3);
});

test('CI that goes red between send and merge shames the authors at merge time and destroys the branch at once', () => {
  const { dir, id } = ciRepo({ check: 'exit 0', mainCheck: 'echo nope; exit 1' });
  const swept = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(swept.stdout, new RegExp(`PR ${id} failed CI: "tests" exited 1`));
  assert.match(swept.stdout, /Shame on: Test/);
  assert.match(swept.stdout, /ghosted feat/);
  assert.ok(!mainHas(dir, 'f.txt'));
  assert.ok(!branches(dir).includes('feat'));
  assert.equal(git(dir, 'for-each-ref', 'refs/snapgit/pr'), '');
  assert.match(snap(dir, ['shame']).stdout, /😬.*failed the "tests" check \(exit 1\)/);
  assert.match(snap(dir, ['shame', '--clear']).stdout, /cleared 1/);
  assert.match(snap(dir, ['shame']).stdout, /nobody has been shamed/);
});

test('a failing PR is destroyed as soon as the fuse burns out, not only when the branch timer ends', () => {
  const { dir, id } = ciRepo({ check: 'exit 0', mainCheck: 'exit 1' });
  git(dir, 'switch', '-q', 'main');
  assert.equal(snap(dir, ['pr', 'open', id, '--screenshot']).status, 0);
  const swept = snap(dir, ['sweep'], T0 + 61_000);
  assert.match(swept.stdout, /failed CI/);
  assert.ok(!branches(dir).includes('feat'));
});

test('agents are named and flagged in the shame message, via Co-Authored-By trailers', () => {
  const { dir } = ciRepo({ check: 'exit 0', mainCheck: 'exit 1', headMsg: 'add feature\n\nCo-Authored-By: Claude Sonnet <noreply@anthropic.com>' });
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  const [rec] = JSON.parse(snap(dir, ['shame', '--json']).stdout);
  const byName = Object.fromEntries(rec.authors.map((a) => [a.name, a]));
  assert.equal(byName['Test'].agent, false);
  assert.equal(byName['Claude Sonnet'].agent, true);
  assert.match(rec.message, /Claude Sonnet \(agent\)/);
});

test('a PR cannot switch off its own CI: checks come from the base branch', () => {
  const dir = repo();
  writeFileSync(join(dir, 'required.txt'), 'must exist\n');
  writeFileSync(join(dir, 'snapgit.json'), JSON.stringify({ checks: [{ name: 'guard', run: 'test -f required.txt' }] }));
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'ci');
  git(dir, 'switch', '-q', '-c', 'feat');
  git(dir, 'rm', '-q', 'required.txt');
  writeFileSync(join(dir, 'snapgit.json'), JSON.stringify({ checks: [] })); // the branch's own, check-free config
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'nothing to see, no CI needed');
  const r = snap(dir, ['pr', 'send', '--ttl', '1h']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not sent: feat failed CI.*"guard"/);
});

test('pr checks previews the result without merging or shaming', () => {
  const { dir, id } = ciRepo({ check: 'test -f f.txt && test -f base.txt' });
  const ok = snap(dir, ['pr', 'checks', id]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /✅ tests/);
  writeFileSync(join(dir, 'snapgit.json'), JSON.stringify({ checks: [{ name: 'lint', run: 'echo bad style; exit 2' }] }));
  git(dir, 'commit', '-qam', 'add lint');
  const bad = snap(dir, ['pr', 'checks', id]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /❌ lint \(exit 2\)[\s\S]*bad style/);
  assert.ok(branches(dir).includes('feat'));
  assert.equal(JSON.parse(snap(dir, ['shame', '--json']).stdout).length, 0);
});

test('a broken snapgit.json holds the merge instead of waving the PR through', () => {
  const { dir } = ciRepo({ check: 'exit 0' });
  writeFileSync(join(dir, 'snapgit.json'), '{ not json');
  git(dir, 'commit', '-qam', 'break ci config');
  const swept = snap(dir, ['sweep'], T0 + 2 * HOUR);
  assert.match(swept.stdout, /kept feat: PR held: snapgit.json on main is not valid JSON/);
  assert.ok(branches(dir).includes('feat'));
  assert.ok(!mainHas(dir, 'f.txt'));
});

test('snapgit.shameCommand receives the shame record as JSON on stdin', () => {
  const { dir } = ciRepo({ check: 'exit 0', mainCheck: 'exit 1' });
  const sink = join(mkdtempSync(join(tmpdir(), 'snapgit-sink-')), 'shame.json');
  git(dir, 'config', 'snapgit.shameCommand', `cat > ${sink}`);
  snap(dir, ['sweep'], T0 + 2 * HOUR);
  const got = JSON.parse(readFileSync(sink, 'utf8'));
  assert.equal(got.check, 'tests');
  assert.equal(got.head, 'feat');
  assert.ok(Array.isArray(got.authors));
});

test('over a remote, the shame reaches the other clones too', () => {
  const bare = mkdtempSync(join(tmpdir(), 'snapgit-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const { dir } = ciRepo({ check: 'exit 0', send: false });
  git(dir, 'remote', 'add', 'origin', bare);
  git(dir, 'push', '-q', 'origin', 'main', 'feat');
  const sent = snap(dir, ['pr', 'send', 'feat', '-r', 'origin', '--ttl', '1h']);
  assert.equal(sent.status, 0, sent.stdout);
  writeFileSync(join(dir, 'snapgit.json'), JSON.stringify({ checks: [{ name: 'tests', run: 'exit 1' }] }));
  git(dir, 'commit', '-qam', 'ci goes red');
  assert.match(snap(dir, ['sweep', '--remote', 'origin'], T0 + 2 * HOUR).stdout, /failed CI/);
  assert.ok(!branches(dir).includes('feat'));
  assert.equal(git(dir, 'ls-remote', '.', 'refs/heads/feat'), '');

  const author = mkdtempSync(join(tmpdir(), 'snapgit-author-'));
  git(author, 'clone', '-q', bare, '.');
  git(author, 'config', 'user.name', 'Agent'); git(author, 'config', 'user.email', 'agent@example.com');
  assert.match(snap(author, ['shame']).stdout, /😬.*failed the "tests" check/);
});

test('streak counts consecutive days and survives until tomorrow', () => {
  const dir = repo();
  git(dir, 'update-ref', '-d', 'refs/heads/main');
  git(dir, 'checkout', '-q', '--orphan', 'main');
  for (const [i, day] of ['2026-01-07', '2026-01-08', '2026-01-09', '2026-01-10'].entries()) {
    commit(dir, `d${i}.txt`, `${i}`, `day ${day}`, `${day}T12:00:00Z`);
  }
  assert.match(snap(dir, ['streak'], Date.UTC(2026, 0, 10, 20)).stdout, /4 day streak\./);
  assert.match(snap(dir, ['streak'], Date.UTC(2026, 0, 11, 9)).stdout, /4 day streak \(commit today/);
  assert.match(snap(dir, ['streak'], Date.UTC(2026, 0, 13, 9)).stdout, /no streak.*Longest ever: 4/);
});

test('story summarises the last day and ignores older commits', () => {
  const dir = repo();
  const day = Date.UTC(2026, 0, 10, 12);
  commit(dir, 'old.txt', '1', 'ancient history', '2026-01-01T12:00:00Z');
  commit(dir, 'new.txt', '2', 'fresh work', '2026-01-10T09:00:00Z');
  snap(dir, ['snap', 'spike', '--ttl', '3h', '--stay'], day);
  const out = snap(dir, ['story'], day).stdout;
  assert.match(out, /fresh work/);
  assert.doesNotMatch(out, /ancient history/);
  assert.match(out, /spike vanishes in 3h/);
  assert.match(out, /will not be saved/);
});
