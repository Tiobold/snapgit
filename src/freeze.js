import { git, run } from './git.js';
import { now } from './time.js';
import { hasRemote } from './git.js';

// The kill switch. While frozen, nothing merges and nothing disappears. Timers keep counting, so on thaw
// whatever came due is settled. A freeze can be local (git config) and/or shared through a remote ref.
const REF = 'refs/snapgit/freeze';

export function freeze({ cwd, remote, reason = 'frozen' }) {
  git(['config', 'snapgit.frozen', reason], { cwd });
  if (remote) {
    const blob = git(['hash-object', '-w', '--stdin'], { cwd, input: JSON.stringify({ reason, at: now() }) });
    git(['push', '--force', remote, `${blob}:${REF}`], { cwd });
  }
}

export function thaw({ cwd, remote }) {
  run(['config', '--unset', 'snapgit.frozen'], { cwd });
  if (remote && run(['ls-remote', '--exit-code', remote, REF], { cwd }).ok) run(['push', remote, `--delete`, REF], { cwd });
}

/** Returns the reason string when frozen, else null. Checks the local flag and (if given) the remote's. */
export function frozenReason({ cwd, remote }) {
  const local = run(['config', 'snapgit.frozen'], { cwd });
  if (local.ok && local.out.trim()) return local.out.trim();
  if (remote && hasRemote(remote, cwd)) {
    const r = run(['ls-remote', remote, REF], { cwd });
    if (r.ok && r.out.trim()) {
      const sha = r.out.split('\t')[0];
      const fetched = run(['fetch', '--quiet', remote, `+${REF}:refs/snapgit-remote/freeze`], { cwd });
      if (fetched.ok) {
        try { return JSON.parse(git(['cat-file', 'blob', sha], { cwd })).reason ?? 'frozen'; } catch { /* fall through */ }
      }
      return 'frozen';
    }
  }
  return null;
}
