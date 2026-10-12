import { run } from './git.js';

/**
 * snapgit.json lives on the BASE branch, so a PR cannot rewrite its own rules.
 * {
 *   "checks":         [{ "name": "tests", "run": "npm test", "timeoutSec": 300 }],
 *   "fuse":           { "baseSec": 10, "secPerLine": 0.5, "minSec": 15, "maxSec": 3600,
 *                       "ignore": ["package-lock.json", "dist/"],
 *                       "weights": [{ "glob": "migrations/**", "multiplier": 3 }] },
 *   "reviewers":      ["@alice", "bob@example.com"]  or  "CODEOWNERS",
 *   "protectedPaths": ["auth/**", "infra/**"],          // these also need an explicit approval
 *   "mergeMethod":    "merge" | "squash" | "rebase",    // GitHub Action only
 *   "ttlHours":       24,                               // GitHub Action only: PR lifetime
 *   "frozen":         false,                            // GitHub Action only: kill switch
 *   "requireChecks":  false                             // GitHub Action only: no checks at all is NOT validation
 * }
 */
export const DEFAULT_POLICY = Object.freeze({
  checks: [], fuse: {}, reviewers: null, protectedPaths: [], mergeMethod: 'merge', ttlHours: 24, frozen: false, requireChecks: false,
});

const bad = (label, msg) => { throw new Error(`snapgit.json on ${label}${/^(is|must) /.test(msg) ? ' ' : ': '}${msg}`); };
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === 'string' && s);

export function parsePolicy(text, label = 'base') {
  let cfg;
  try { cfg = JSON.parse(text); } catch { return bad(label, 'is not valid JSON'); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return bad(label, 'must be a JSON object');
  const p = { ...DEFAULT_POLICY, fuse: {}, checks: [], protectedPaths: [] };

  if (cfg.checks !== undefined) {
    if (!Array.isArray(cfg.checks) || cfg.checks.some((c) => !c || typeof c.run !== 'string' || !c.run)) bad(label, '"checks" must be a list of { name, run }');
    p.checks = cfg.checks.map((c, i) => ({ name: c.name || `check ${i + 1}`, run: c.run, timeoutSec: Number(c.timeoutSec) || 300 }));
  }
  if (cfg.fuse !== undefined) {
    const f = cfg.fuse;
    if (!f || typeof f !== 'object') bad(label, '"fuse" must be an object');
    for (const k of ['baseSec', 'secPerLine', 'minSec', 'maxSec']) {
      if (f[k] !== undefined && !(Number.isFinite(f[k]) && f[k] >= 0)) bad(label, `fuse.${k} must be a number >= 0`);
    }
    if (f.ignore !== undefined && !strings(f.ignore)) bad(label, 'fuse.ignore must be a list of globs');
    if (f.weights !== undefined && !(Array.isArray(f.weights) && f.weights.every((w) => w && typeof w.glob === 'string' && Number.isFinite(w.multiplier) && w.multiplier >= 0))) {
      bad(label, 'fuse.weights must be a list of { glob, multiplier >= 0 }');
    }
    p.fuse = f;
  }
  if (cfg.reviewers !== undefined) {
    if (cfg.reviewers !== 'CODEOWNERS' && !strings(cfg.reviewers)) bad(label, '"reviewers" must be a list of people or "CODEOWNERS"');
    p.reviewers = cfg.reviewers;
  }
  if (cfg.protectedPaths !== undefined) {
    if (!strings(cfg.protectedPaths)) bad(label, '"protectedPaths" must be a list of globs');
    p.protectedPaths = cfg.protectedPaths;
  }
  if (cfg.mergeMethod !== undefined) {
    if (!['merge', 'squash', 'rebase'].includes(cfg.mergeMethod)) bad(label, '"mergeMethod" must be merge, squash or rebase');
    p.mergeMethod = cfg.mergeMethod;
  }
  if (cfg.ttlHours !== undefined) {
    if (!(Number.isFinite(cfg.ttlHours) && cfg.ttlHours > 0)) bad(label, '"ttlHours" must be a positive number');
    p.ttlHours = cfg.ttlHours;
  }
  if (cfg.frozen !== undefined) p.frozen = !!cfg.frozen;
  if (cfg.requireChecks !== undefined) p.requireChecks = !!cfg.requireChecks;
  return p;
}

/** Read the policy from a local branch. No file means defaults; a broken file throws, so callers hold instead of guessing. */
export function loadPolicy(base, cwd) {
  const r = run(['show', `refs/heads/${base}:snapgit.json`], { cwd });
  return r.ok ? parsePolicy(r.out, base) : { ...DEFAULT_POLICY, fuse: {}, checks: [], protectedPaths: [] };
}
