import { git, run, currentBranch, branchExists, protectedBranches } from './git.js';
import { now } from './time.js';

const key = (name) => `branch.${name}.snapgit-expires`;

/** All branches carrying a timer: [{ name, expiresAt, tip }]. Orphaned timers are cleaned up. */
export function listSnaps(cwd) {
  const r = run(['config', '--get-regexp', '^branch\\..*\\.snapgit-expires$'], { cwd });
  if (!r.ok) return [];
  const snaps = [];
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [k, value] = line.split(' ');
    const name = k.slice('branch.'.length, -'.snapgit-expires'.length);
    if (!branchExists(name, cwd)) {
      run(['config', '--unset', key(name)], { cwd });
      continue;
    }
    snaps.push({ name, expiresAt: Number(value), tip: git(['rev-parse', '--short', `refs/heads/${name}`], { cwd }) });
  }
  return snaps.sort((a, b) => a.expiresAt - b.expiresAt);
}

export function getExpiry(name, cwd) {
  const r = run(['config', '--get', key(name)], { cwd });
  return r.ok ? Number(r.out.trim()) : null;
}

export function setExpiry(name, expiresAt, cwd) {
  if (!branchExists(name, cwd)) throw new Error(`no such branch: ${name}`);
  if (protectedBranches(cwd).has(name)) throw new Error(`${name} is protected: some things are not meant to disappear`);
  git(['config', key(name), String(expiresAt)], { cwd });
}

export function clearExpiry(name, cwd) {
  return run(['config', '--unset', key(name)], { cwd }).ok;
}

/** Create a branch that will self-destruct after ttlMs. */
export function createSnap(name, { ttlMs, from, stay = false, cwd }) {
  git(['check-ref-format', '--branch', name], { cwd });
  if (branchExists(name, cwd)) throw new Error(`branch ${name} already exists`);
  if (protectedBranches(cwd).has(name)) throw new Error(`${name} is protected`);
  git(stay ? ['branch', name, ...(from ? [from] : [])] : ['switch', '-c', name, ...(from ? [from] : [])], { cwd });
  const expiresAt = now() + ttlMs;
  setExpiry(name, expiresAt, cwd);
  return expiresAt;
}

/**
 * Delete every expired snap branch. Never touches a branch that is checked out.
 * Returns { ghosted: [{ name, sha, remote }], skipped: [{ name, reason }] }.
 */
export function sweep({ cwd, remote = null, dryRun = false, resolve = () => ({ action: 'none' }) }) {
  const ghosted = [];
  const skipped = [];
  const here = currentBranch(cwd);
  const safe = protectedBranches(cwd);
  const t = now();
  for (const snap of listSnaps(cwd)) {
    if (snap.expiresAt > t) continue;
    if (safe.has(snap.name)) {
      skipped.push({ name: snap.name, reason: 'protected' });
      continue;
    }
    const sha = git(['rev-parse', '--short', `refs/heads/${snap.name}`], { cwd });
    if (dryRun) {
      ghosted.push({ name: snap.name, sha, remote: false });
      continue;
    }
    const pr = resolve(snap.name);
    if (snap.name === here && pr.action !== 'hold') {
      // The branch you're standing on survives until you leave, but its PR is settled now.
      if (pr.action !== 'none') ghosted.push({ name: snap.name, sha, pr, stayed: true });
      else skipped.push({ name: snap.name, reason: 'checked out; it will vanish once you leave' });
      continue;
    }
    if (pr.action === 'hold') {
      skipped.push({ name: snap.name, reason: `PR ${pr.id} held: ${pr.reason}` });
      continue;
    }
    const del = run(['branch', '-D', snap.name], { cwd });
    if (!del.ok) {
      skipped.push({ name: snap.name, reason: del.err.split('\n')[0] });
      continue;
    }
    clearExpiry(snap.name, cwd);
    let remoteGone = false;
    if (remote && run(['ls-remote', '--exit-code', '--heads', remote, snap.name], { cwd }).ok) {
      remoteGone = run(['push', remote, '--delete', snap.name], { cwd }).ok;
    }
    ghosted.push({ name: snap.name, sha, remote: remoteGone, pr });
  }
  return { ghosted, skipped };
}
