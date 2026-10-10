import { git, run, currentBranch, branchExists, protectedBranches } from './git.js';
import { now, parseDuration } from './time.js';

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

/** The timer every new snap gets unless you pick another at creation: git config snapgit.defaultTtl, else 24h. */
export function defaultTtlMs(cwd) {
  const r = run(['config', 'snapgit.defaultTtl'], { cwd });
  return parseDuration(r.ok && r.out.trim() ? r.out.trim() : '24h');
}

export function getExpiry(name, cwd) {
  const r = run(['config', '--get', key(name)], { cwd });
  return r.ok ? Number(r.out.trim()) : null;
}

/** Internal: timers are set at creation (snap, pr send) or pulled forward at settle time. They are never extended. */
export function setExpiry(name, expiresAt, cwd) {
  if (!branchExists(name, cwd)) throw new Error(`no such branch: ${name}`);
  if (protectedBranches(cwd).has(name)) throw new Error(`${name} is protected: some things are not meant to disappear`);
  git(['config', key(name), String(expiresAt)], { cwd });
}

function clearExpiry(name, cwd) {
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
 * `settle` runs first and settles due PRs. Returns { ghosted, skipped, events }.
 */
export function sweep({ cwd, remote = null, dryRun = false, settle = () => ({ events: [], gone: new Set(), held: new Map() }) }) {
  const ghosted = [];
  const skipped = [];
  const here = currentBranch(cwd);
  const safe = protectedBranches(cwd);
  const t = now();
  const settled = dryRun ? { events: [], gone: new Set(), held: new Map() } : settle();
  for (const snap of listSnaps(cwd)) {
    const goneNow = settled.gone.has(snap.name);
    if (snap.expiresAt > t && !goneNow) continue;
    if (safe.has(snap.name)) {
      skipped.push({ name: snap.name, reason: 'protected' });
      continue;
    }
    const sha = git(['rev-parse', '--short', `refs/heads/${snap.name}`], { cwd });
    if (dryRun) {
      ghosted.push({ name: snap.name, sha, remote: false });
      continue;
    }
    if (settled.held.has(snap.name)) {
      skipped.push({ name: snap.name, reason: `PR held: ${settled.held.get(snap.name)}` });
      continue;
    }
    if (snap.name === here) {
      if (goneNow) setExpiry(snap.name, t, cwd); // vanish at the next sweep after you leave
      skipped.push({ name: snap.name, reason: 'checked out; it will vanish once you leave' });
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
    ghosted.push({ name: snap.name, sha, remote: remoteGone });
  }
  return { ghosted, skipped, events: settled.events };
}
