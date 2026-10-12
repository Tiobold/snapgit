import { git, run, protectedBranches } from './git.js';
import { ident } from './authz.js';
import { now } from './time.js';

// Branch timers normally live in your git config, which only your machine can see. Publishing a timer as
// refs/snapgit/timer/<branch> lets ANY runner (a CI job, a teammate) delete the branch when it expires.
// Timers are immutable on the remote: a push that would change an existing one is refused.
const REF = 'refs/snapgit/timer/';
const SCRATCH = 'refs/snapgit-remote/timer/';

export function publishTimer(branch, expiresAt, via, cwd) {
  const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: JSON.stringify({ branch, expiresAt, owner: ident(cwd), at: now() }) });
  git(['update-ref', REF + branch, blob], { cwd });
  return run(['push', via, `${REF + branch}:${REF + branch}`], { cwd }).ok;
}

/** [{ branch, expiresAt, owner }] published on the remote. */
export function remoteTimers(remote, cwd) {
  const r = run(['fetch', '--quiet', remote, `+${REF}*:${SCRATCH}*`], { cwd });
  if (!r.ok) return [];
  const out = run(['for-each-ref', '--format=%(refname) %(objectname)', SCRATCH], { cwd }).out.split('\n').filter(Boolean);
  const timers = out.map((line) => {
    const [ref, sha] = line.split(' ');
    try { return JSON.parse(git(['cat-file', 'blob', sha], { cwd })); } catch { return null; } finally { run(['update-ref', '-d', ref], { cwd }); }
  });
  return timers.filter((t) => t && t.branch && Number.isFinite(t.expiresAt));
}

/**
 * Delete expired branches on a remote using only the published timers. `liveHeads` are branches that still
 * have a live PR: their PR settles them, not the clock. Returns [{ branch }].
 */
export function sweepRemoteTimers({ cwd, remote, liveHeads = new Set(), dryRun = false }) {
  const safe = protectedBranches(cwd);
  const gone = [];
  for (const t of remoteTimers(remote, cwd)) {
    if (t.expiresAt > now() || safe.has(t.branch) || liveHeads.has(t.branch)) continue;
    const exists = run(['ls-remote', '--exit-code', '--heads', remote, t.branch], { cwd }).ok;
    if (!dryRun) {
      if (exists) run(['push', remote, '--delete', t.branch], { cwd });
      run(['push', remote, '--delete', REF + t.branch], { cwd });
      run(['update-ref', '-d', REF + t.branch], { cwd });
    }
    gone.push({ branch: t.branch, existed: exists });
  }
  return gone;
}
