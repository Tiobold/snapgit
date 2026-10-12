import { git, run, branchExists } from './git.js';
import { now } from './time.js';
import { setExpiry, defaultTtlMs } from './snaps.js';

// refs/snapgit/graveyard/<ms>-<branch> points straight at the branch tip, so the commits stay reachable
// (and safe from git gc) until the entry is pruned. That is what makes ghosting undoable.
const PREFIX = 'refs/snapgit/graveyard/';
const retentionMs = (cwd) => {
  const r = run(['config', 'snapgit.graveyardDays'], { cwd });
  const days = r.ok && r.out.trim() ? Number(r.out.trim()) : 30;
  return (Number.isFinite(days) && days >= 0 ? days : 30) * 864e5;
};

export function bury(name, cwd) {
  const sha = git(['rev-parse', `refs/heads/${name}`], { cwd });
  const ref = `${PREFIX}${now()}-${name}`;
  git(['update-ref', ref, sha], { cwd });
  return ref;
}

/**
 * Before deleting a branch on a remote, keep its remote tip too (it can hold commits nobody pulled yet).
 * Returns true if a grave was dug.
 */
export function buryRemoteTip(remote, name, cwd) {
  const r = run(['ls-remote', '--heads', remote, name], { cwd });
  const sha = r.ok ? r.out.split('\t')[0].trim() : '';
  if (!sha) return false;
  if (!run(['cat-file', '-e', `${sha}^{commit}`], { cwd }).ok && !run(['fetch', '--quiet', remote, name], { cwd }).ok) return false;
  if (!run(['cat-file', '-e', `${sha}^{commit}`], { cwd }).ok) return false;
  if (graves(cwd).some((g) => g.sha === sha)) return true;
  git(['update-ref', `${PREFIX}${now()}-${name}`, sha], { cwd });
  return true;
}

/** [{ ref, name, sha, buriedAt }], newest first. */
export function graves(cwd) {
  const out = run(['for-each-ref', '--format=%(refname) %(objectname)', PREFIX], { cwd }).out;
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, sha] = line.split(' ');
    const m = ref.slice(PREFIX.length).match(/^(\d+)-(.+)$/);
    return m ? { ref, name: m[2], sha, buriedAt: Number(m[1]) } : null;
  }).filter(Boolean).sort((a, b) => b.buriedAt - a.buriedAt);
}

/** Bring a branch back from the graveyard. It gets a fresh default timer: nothing escapes the clock. */
export function resurrect(name, cwd) {
  const grave = graves(cwd).find((g) => g.name === name);
  if (!grave) throw new Error(`nothing named ${name} in the graveyard (snapgit graveyard lists what can be resurrected)`);
  if (branchExists(name, cwd)) throw new Error(`${name} already exists`);
  git(['branch', name, grave.sha], { cwd });
  const expiresAt = now() + defaultTtlMs(cwd);
  setExpiry(name, expiresAt, cwd);
  run(['update-ref', '-d', grave.ref], { cwd });
  return { sha: grave.sha.slice(0, 7), expiresAt };
}

/** Forget graves older than the retention window (git config snapgit.graveyardDays, default 30). */
export function pruneGraveyard(cwd) {
  const cutoff = now() - retentionMs(cwd);
  let n = 0;
  for (const g of graves(cwd)) if (g.buriedAt < cutoff) { run(['update-ref', '-d', g.ref], { cwd }); n++; }
  return n;
}
