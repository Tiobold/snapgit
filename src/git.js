import { spawnSync } from 'node:child_process';

export class GitError extends Error {}

/** Run git, returning { ok, out, err } without throwing on a non-zero exit. */
export function run(args, { cwd = process.cwd(), input } = {}) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  return { ok: r.status === 0, status: r.status, out: r.stdout, err: r.stderr.trim() };
}

/** Run git and return stdout (right-trimmed); throw GitError on failure. */
export function git(args, opts) {
  const r = run(args, opts);
  if (!r.ok) throw new GitError(`git ${args.join(' ')}: ${r.err}`);
  return r.out.trimEnd();
}

export function currentBranch(cwd) {
  const r = run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd });
  return r.ok ? r.out.trim() : null;
}

export function branchExists(name, cwd) {
  return run(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], { cwd }).ok;
}

export function hasRemote(name, cwd) {
  return run(['remote', 'get-url', name], { cwd }).ok;
}

const WELL_KNOWN = ['main', 'master', 'trunk', 'develop'];

/** Branches snapgit will never put a timer on. */
export function protectedBranches(cwd) {
  const set = new Set(WELL_KNOWN);
  const head = run(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { cwd });
  if (head.ok) set.add(head.out.trim().replace(/^origin\//, ''));
  return set;
}

export function defaultBranch(cwd) {
  const head = run(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], { cwd });
  if (head.ok) return head.out.trim().replace(/^origin\//, '');
  for (const b of WELL_KNOWN) if (branchExists(b, cwd)) return b;
  return currentBranch(cwd);
}
