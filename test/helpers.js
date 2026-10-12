import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const BIN = resolve('bin/snapgit.js');
export const T0 = Date.UTC(2026, 0, 10, 12, 0, 0);
export const HOUR = 36e5;

export const sh = (cwd, cmd, args, env = {}) => spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
export const git = (cwd, ...a) => {
  const r = sh(cwd, 'git', a);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
// SNAPGIT_FUSE_MS pins the fuse so tests count in whole minutes; pass { SNAPGIT_FUSE_MS: '' } for the real formula.
export const snap = (cwd, args, at = T0, env = {}) => sh(cwd, 'node', [BIN, ...args], { SNAPGIT_NOW: String(at), SNAPGIT_FUSE_MS: '60000', ...env });

export function repo(name = 'repo') {
  const dir = mkdtempSync(join(tmpdir(), `snapgit-${name}-`));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'user.email', 'test@example.com');
  commit(dir, 'a.txt', 'hello\n', 'first');
  return dir;
}
export function commit(dir, file, text, msg, date) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', '.');
  const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
  const r = sh(dir, 'git', ['commit', '-q', '-m', msg], env);
  assert.equal(r.status, 0, r.stderr);
}
export const branches = (dir) => git(dir, 'branch', '--format=%(refname:short)').split('\n');
export const mainHas = (dir, file) => sh(dir, 'git', ['cat-file', '-e', `main:${file}`]).status === 0;

/** A repo on main with a feature branch `feat` (one new file) checked out. */
export function featureRepo(files = { 'f.txt': 'new feature\n' }) {
  const dir = repo();
  git(dir, 'switch', '-q', '-c', 'feat');
  for (const [f, t] of Object.entries(files)) {
    const parts = f.split('/');
    if (parts.length > 1) sh(dir, 'mkdir', ['-p', join(dir, ...parts.slice(0, -1))]);
    writeFileSync(join(dir, f), t);
  }
  git(dir, 'add', '.');
  assert.equal(sh(dir, 'git', ['commit', '-q', '-m', 'add feature']).status, 0);
  return dir;
}

export const sendId = (dir, ...extra) => {
  const r = snap(dir, ['pr', 'send', '--ttl', '1h', ...extra]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return r.stdout.match(/id ([0-9a-f]{8})/)[1];
};
export const openIt = (dir, id, at = T0, env = {}) => {
  const r = snap(dir, ['pr', 'open', id, '--screenshot'], at, env);
  assert.equal(r.status, 0, r.stderr);
  return r;
};

/** A bare "origin" plus a sender repo (feat pushed), and a clone() factory for reviewers. */
export function remotes(opts = {}) {
  const bare = mkdtempSync(join(tmpdir(), 'snapgit-bare-'));
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const sender = opts.sender ?? featureRepo();
  if (opts.setup) opts.setup(sender);
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

/** Put a snapgit.json on main (and commit it). */
export function writePolicy(dir, policy, { branch = 'main' } = {}) {
  const was = git(dir, 'branch', '--show-current');
  git(dir, 'switch', '-q', branch);
  writeFileSync(join(dir, 'snapgit.json'), JSON.stringify(policy));
  git(dir, 'add', '.');
  assert.equal(sh(dir, 'git', ['commit', '-q', '-m', 'policy']).status, 0);
  git(dir, 'switch', '-q', was);
}
