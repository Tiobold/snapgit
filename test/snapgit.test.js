import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

test('keep and extend change the timer; protected branches are refused', () => {
  const dir = repo();
  snap(dir, ['snap', 'a', '--ttl', '1h', '--stay']);
  snap(dir, ['snap', 'b', '--ttl', '1h', '--stay']);
  assert.equal(snap(dir, ['extend', 'a', '5h']).status, 0);
  assert.equal(snap(dir, ['keep', 'b']).status, 0);
  snap(dir, ['sweep'], T0 + 3 * HOUR);
  assert.deepEqual(branches(dir).sort(), ['a', 'b', 'main']);
  snap(dir, ['sweep'], T0 + 7 * HOUR);
  assert.deepEqual(branches(dir).sort(), ['b', 'main']);

  const r = snap(dir, ['snap', 'main']);
  assert.notEqual(r.status, 0);
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

test('a PR can be opened exactly once, and carries the diff', () => {
  const dir = featureRepo();
  const sent = snap(dir, ['pr', 'send', '-m', 'Add feature\nplease look']);
  assert.equal(sent.status, 0, sent.stderr);
  const id = sent.stdout.match(/id ([0-9a-f]{8})/)[1];

  const first = snap(dir, ['pr', 'open', id, '--screenshot']);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Add feature/);
  assert.match(first.stdout, /\+new feature/);
  assert.match(first.stdout, /screenshot detected/);

  const second = snap(dir, ['pr', 'open', id, '--screenshot']);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /gone/);
  assert.equal(git(dir, 'for-each-ref', 'refs/snapgit'), '');
});

test('piping a PR without --screenshot refuses and does not burn it', () => {
  const dir = featureRepo();
  const id = snap(dir, ['pr', 'send']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const r = snap(dir, ['pr', 'open', id]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Nothing was burned/);
  assert.match(snap(dir, ['pr', 'ls']).stdout, new RegExp(id));
});

test('expired PRs are swept and cannot be opened', () => {
  const dir = featureRepo();
  const id = snap(dir, ['pr', 'send', '--ttl', '1h']).stdout.match(/id ([0-9a-f]{8})/)[1];
  const r = snap(dir, ['pr', 'open', id, '--screenshot'], T0 + 2 * HOUR);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /expired/);
  assert.equal(snap(dir, ['pr', 'open', id, '--screenshot']).status, 1);
});

test('over a remote only one recipient wins, and the sender cannot peek afterwards', () => {
  const bare = mkdtempSync(join(tmpdir(), 'snapgit-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const sender = featureRepo();
  git(sender, 'remote', 'add', 'origin', bare);
  git(sender, 'push', '-q', 'origin', 'main', 'feat');

  const sent = snap(sender, ['pr', 'send', '-r', 'origin', '-m', 'Over the wire']);
  assert.equal(sent.status, 0, sent.stderr);
  const id = sent.stdout.match(/id ([0-9a-f]{8})/)[1];
  assert.match(git(sender, 'ls-remote', 'origin', 'refs/snapgit/pr/*'), new RegExp(id));

  const clone = (n) => {
    const d = mkdtempSync(join(tmpdir(), `snapgit-${n}-`));
    git(d, 'clone', '-q', bare, '.');
    return d;
  };
  const alice = clone('alice');
  const bob = clone('bob');
  assert.match(snap(alice, ['pr', 'ls', '-r', 'origin']).stdout, new RegExp(id));

  const a = snap(alice, ['pr', 'open', id, '--screenshot']);
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /Over the wire/);

  const b = snap(bob, ['pr', 'open', id, '--screenshot']);
  assert.notEqual(b.status, 0);
  const s = snap(sender, ['pr', 'open', id, '--screenshot']);
  assert.notEqual(s.status, 0);
  assert.match(s.stderr, /already burned/);
  assert.equal(git(bare, 'for-each-ref', 'refs/snapgit'), '');
});

test('burn retracts a PR without reading it', () => {
  const dir = featureRepo();
  const id = snap(dir, ['pr', 'send']).stdout.match(/id ([0-9a-f]{8})/)[1];
  assert.equal(snap(dir, ['pr', 'burn', id]).status, 0);
  assert.equal(snap(dir, ['pr', 'burn', id]).status, 1);
  assert.notEqual(snap(dir, ['pr', 'open', '../../x', '--screenshot']).status, 0);
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
