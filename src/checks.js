import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git, run } from './git.js';

/**
 * Checks live in snapgit.json on the BASE branch, so a PR cannot switch off its own CI:
 *   { "checks": [{ "name": "tests", "run": "npm test", "timeoutSec": 300 }] }
 * No file means no checks. A malformed file throws, so the merge is held rather than waved through.
 */
export function loadChecks(base, cwd) {
  const r = run(['show', `refs/heads/${base}:snapgit.json`], { cwd });
  if (!r.ok) return [];
  let cfg;
  try { cfg = JSON.parse(r.out); } catch { throw new Error(`snapgit.json on ${base} is not valid JSON`); }
  const checks = cfg.checks ?? [];
  if (!Array.isArray(checks) || checks.some((c) => !c || typeof c.run !== 'string' || !c.run)) {
    throw new Error(`snapgit.json on ${base}: "checks" must be a list of { name, run }`);
  }
  return checks.map((c, i) => ({ name: c.name || `check ${i + 1}`, run: c.run, timeoutSec: Number(c.timeoutSec) || 300 }));
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
      const r = spawnSync('sh', ['-c', c.run], {
        cwd: dir, encoding: 'utf8', timeout: c.timeoutSec * 1000, maxBuffer: 64 << 20,
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
