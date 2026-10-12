import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, run } from './git.js';
import { loadPolicy } from './policy.js';

/** The checks on the base branch's policy (see policy.js). A malformed snapgit.json throws, so the merge is held. */
export function loadChecks(base, cwd) {
  return loadPolicy(base, cwd).checks;
}

const tail = (text, lines = 30, chars = 3000) => text.trimEnd().split('\n').slice(-lines).join('\n').slice(-chars);

/**
 * Run every check against `commit` in a throwaway detached worktree, so your own working tree is never
 * touched. Stops at the first failure. Returns { ok, results: [{ name, code, timedOut, output }] }.
 * Note the checks execute the PR's code on this machine, exactly like any CI runner would.
 */
export function runChecks(commit, checks, { cwd, env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'snapgit-ci-'));
  git(['worktree', 'add', '--quiet', '--detach', dir, commit], { cwd });
  const results = [];
  try {
    for (const c of checks) {
      const r = spawnSync(c.run, {
        shell: true, cwd: dir, encoding: 'utf8', timeout: c.timeoutSec * 1000, maxBuffer: 64 << 20,
        env: { ...process.env, CI: 'true', ...env },
      });
      const timedOut = r.error?.code === 'ETIMEDOUT';
      const code = timedOut ? null : (r.status ?? 1);
      results.push({ name: c.name, code, timedOut, output: tail(`${r.stdout ?? ''}${r.stderr ?? ''}${timedOut ? `\n(timed out after ${c.timeoutSec}s)` : ''}`) });
      if (timedOut || code !== 0) return { ok: false, results };
    }
    return { ok: true, results };
  } finally {
    run(['worktree', 'remove', '--force', dir], { cwd });
  }
}
